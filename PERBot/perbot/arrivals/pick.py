"""When a package carries text evidence (item hints like "cooling tube", slip descriptions) but no
part number matched, ask the model which of the candidate open orders it belongs to. The model sees
short handles (O3, R12) — never Notion ids — and its answer is validated against them, so it can only
point at rows we offered. A human still confirms every write.
"""
from __future__ import annotations

import dataclasses
import json
import re
from dataclasses import dataclass
from typing import Any, Literal

from openai import OpenAI

from ..config import config, has_openai
from ..utils.text import js_number
from .models import ArrivalRow, Extraction, OpenOrder


@dataclass(eq=False)
class Pick:
    order: OpenOrder
    # The rows the evidence points at (all of the order's rows when it can't tell).
    rows: list[ArrivalRow]
    confidence: Literal['high', 'medium']
    evidence: str


MAX_ORDERS = 30
MAX_PICKS = 3
MAX_ITEMS = 15


@dataclass
class PickPrompt:
    prompt: str
    orders: dict[str, OpenOrder]
    # Row handle → (order handle, row).
    rows: dict[str, tuple[str, ArrivalRow]]


def _item_name(row: ArrivalRow) -> str:
    return re.sub(r'\s+', ' ', row.name or row.part_number)[:70]


def build_pick_prompt(pkg: Extraction, orders: list[OpenOrder], message_text: str) -> PickPrompt:
    order_map: dict[str, OpenOrder] = {}
    row_map: dict[str, tuple[str, ArrivalRow]] = {}
    r = 0
    blocks = []
    for i, o in enumerate(orders[:MAX_ORDERS]):
        handle = f'O{i + 1}'
        order_map[handle] = o
        items = []
        for row in o.rows[:MAX_ITEMS]:
            r += 1
            rh = f'R{r}'
            row_map[rh] = (handle, row)
            items.append(f'    {rh}: {_item_name(row)} [{row.part_number[:40]}] ×{js_number(row.quantity)}')
        more = f'\n    …and {len(o.rows) - MAX_ITEMS} more items' if len(o.rows) > MAX_ITEMS else ''
        date = o.date[:10] if o.date else 'no date'
        blocks.append(
            f"{handle}: {o.vendor or 'unknown vendor'} · requested by {', '.join(o.requesters) or 'unknown'} · {date} · "
            f"{len(o.rows)} items\n" + '\n'.join(items) + more
        )

    slip_lines = '; '.join(
        ' / '.join(x for x in (l.vendor_part_number, l.manufacturer_part_number, l.description) if x) for l in pkg.lines
    )
    evidence = '\n'.join([
        f"This package's item hints: {'; '.join(pkg.item_hints) or 'none'}",
        f"Vendor: {pkg.vendor or 'unknown'}",
        f"Addressee on label: {pkg.addressee or 'none'}",
        f"Ship date: {pkg.ship_date or 'unknown'}",
        f'Slip lines: {slip_lines or "none"}',
        f"Slack message (context; it may also describe OTHER packages in the photo): {json.dumps(message_text[:400] or '(none)', ensure_ascii=False)}",
    ])

    joined_blocks = '\n\n'.join(blocks)
    prompt = f"""A package arrived at Penn Electric Racing. Decide which open purchase order(s) its contents belong to.

What we know about the package:
{evidence}

Open orders (only these exist):
{joined_blocks}

Rules:
- Pick an order only if the evidence specifically points to it: an item hint or slip line that clearly names one of its items,
  a matching part/model number, or the addressee being its requester together with a plausible item.
  Same vendor alone is NOT evidence, and neither are generic words (box, parts, PCBs, components).
- Judge THIS package by its own item hints and slip lines; use the message only to understand them.
- The package may hold items from more than one order (e.g. the message lists "cooling tube" and "bracket stock"): return one
  pick per order, at most {MAX_PICKS}. Return an empty list when nothing specific matches.
- "rows": the item handles (R…) the evidence names; empty if it points at the order but not specific items.
- confidence "high" when an item clearly matches; "medium" when it's a strong but indirect fit.
- evidence: one short phrase quoting what matched, e.g. "message says cooling tube; O2 has 'Clear PVC tubing'".

Reply with JSON only."""
    return PickPrompt(prompt, order_map, row_map)


PICK_SCHEMA = {
    'type': 'object',
    'additionalProperties': False,
    'required': ['order', 'rows', 'confidence', 'evidence'],
    'properties': {
        'order': {'type': 'string'},
        'rows': {'type': 'array', 'items': {'type': 'string'}},
        'confidence': {'type': 'string', 'enum': ['high', 'medium']},
        'evidence': {'type': 'string'},
    },
}

SCHEMA = {
    'type': 'object',
    'additionalProperties': False,
    'required': ['picks'],
    'properties': {'picks': {'type': 'array', 'items': PICK_SCHEMA}},
}


def parse_picks(raw: Any, built: PickPrompt) -> list[Pick]:
    """Validate the model's answer against the handles we offered: known orders only, rows only from
    their order, each order once."""
    picks: list[Pick] = []
    items = raw.get('picks') if isinstance(raw, dict) else None
    for p in items if isinstance(items, list) else []:
        if not isinstance(p, dict) or p.get('confidence') not in ('high', 'medium'):
            continue
        handle = str(p.get('order') if p.get('order') is not None else '').strip()
        order = built.orders.get(handle)
        if not order or any(x.order is order for x in picks):
            continue
        rows: list[ArrivalRow] = []
        for h in p.get('rows') if isinstance(p.get('rows'), list) else []:
            hit = built.rows.get(str(h).strip())
            if hit and hit[0] == handle and not any(r is hit[1] for r in rows):
                rows.append(hit[1])
        evidence = re.sub(r'\s+', ' ', str(p.get('evidence') if p.get('evidence') is not None else '')).strip()[:160]
        picks.append(Pick(order=order, rows=rows or order.rows, confidence=p['confidence'], evidence=evidence))
        if len(picks) >= MAX_PICKS:
            break
    return picks


def stem(word: str) -> str:
    """Crude stem: lowercase letters only, strip -ing/-ed/-es/-s/-er/-e until stable, never below 3
    letters ("soldering"/"solder" → "sold", "tubing"/"tube" → "tub", "wiring"/"wire" → "wir")."""
    w = re.sub(r'[^a-z]', '', word.lower())
    while True:
        nxt = re.sub(r'(ings?|ed|es|s|er|e)$', '', w, count=1)
        if nxt == w or len(nxt) < 3:
            return w
        w = nxt


VENDOR_WORDS = 'digikey digi key mcmaster carr jlcpcb jlc jlccnc amazon mouser xometry sendcutsend eurotech'

# Words too common to tie a package to an item on their own (stored stemmed).
STOP = {
    stem(w)
    for w in [
        'the', 'and', 'for', 'with', 'from', 'here', 'this', 'that', 'our', 'new', 'some', 'stock', 'part', 'kit', 'set', 'pack',
        'piece', 'item', 'order', 'box', 'small', 'large', 'black', 'red', 'blue', 'white', 'meter', 'feet', 'inch', 'tool',
        # generic for a whole vendor: "PCM, Dash, BMS" boards must not ground a row called "JLCPCB Boards" (10/19)
        'board', 'pcb', 'pcbs', 'component', 'electronic', 'parts', 'supplies',
        # filler from how people actually type ("cooling fittings or something")
        'something', 'stuff', 'thing', 'things', 'maybe', 'probably', 'idk', 'misc', 'other', 'etc', 'arrived', 'came', 'here',
    ]
}


def terms(*texts: str | None) -> dict[str, None]:
    """Stemmed content words, as an insertion-ordered set."""
    out: dict[str, None] = {}
    for t in texts:
        for word in re.split(r'[^A-Za-z]+', t or ''):
            s = stem(word)
            if len(s) >= 3 and s not in STOP:
                out[s] = None
    return out


def is_generic(row: ArrivalRow) -> bool:
    """A row that says nothing beyond its vendor and generic words ("JLCPCB Boards", "Mouser order"):
    it can't tell one of that vendor's orders from another, so a card never pre-ticks it on a guess."""
    vendor = terms(row.vendor, VENDOR_WORDS)
    return all(t in vendor for t in terms(row.name, row.part_number))


def ground_picks(picks: list[Pick], pkg: Extraction) -> list[Pick]:
    """The deterministic check on the model. A pick survives only if one of its rows shares a word
    stem with the package's own evidence — from an item hint, its head noun; from a slip line, any
    word. "cooling tube" ↔ "PVC Tubing for Cooling" passes; "cooling fittings" ↔ "PVC Tubing for
    Cooling" (only the adjective) and "buds" ↔ "Cotton Swabs" don't. Within a pick that passed, any
    shared word keeps a row: "primary bracket stock" brings along "primary flange" from the order
    "welded inserts stock" already matched (10/02)."""
    # A vendor's name is not evidence about an item: "PCBs (JLCPCB)" must not ground a row called "JLCPCB Order 1".
    vendor_terms = terms(pkg.vendor, *[r.vendor for p in picks for r in p.order.rows], VENDOR_WORDS)

    def drop(s: dict[str, None]) -> dict[str, None]:
        return {t: None for t in s if t not in vendor_terms}

    slip = drop(terms(*[x for l in pkg.lines for x in (l.description, l.vendor_part_number, l.manufacturer_part_number)]))
    heads: dict[str, None] = {}
    for h in pkg.item_hints:
        kept = list(drop(terms(h)))
        if kept:
            heads[kept[-1]] = None
    heads.update(slip)
    any_terms = {**drop(terms(*pkg.item_hints)), **slip}
    codes = {c.upper() for l in pkg.lines for c in (l.vendor_part_number, l.manufacturer_part_number) if c}

    def row_terms(r: ArrivalRow) -> dict[str, None]:
        return terms(r.name, r.part_number, r.sanitized_description)

    def shares(row: ArrivalRow, evidence: dict[str, None]) -> bool:
        if row.part_number.strip().upper() in codes:
            return True
        return any(t in evidence for t in row_terms(row))

    out: list[Pick] = []
    for p in picks:
        if not any(shares(r, heads) for r in p.order.rows):
            continue
        base = p.rows if any(shares(r, any_terms) for r in p.rows) else p.order.rows
        kept = [r for r in base if shares(r, any_terms)]
        # Hint words the kept rows don't account for can still name siblings ("primary" → "primary
        # flange"); ones they do can't drag more in ("cooling" is already the T-fitting's, so
        # "cooling fans" stays out).
        explained = {t for r in kept for t in row_terms(r)}
        rest = {t: None for t in any_terms if t not in explained}
        siblings = [r for r in p.order.rows if not any(r is k for k in kept) and shares(r, rest)]
        grounded = dataclasses.replace(p, rows=[*kept, *siblings])
        if grounded.rows:
            out.append(grounded)
    return out


_client: OpenAI | None = None


def pick_orders(pkg: Extraction, orders: list[OpenOrder], message_text: str) -> list[Pick]:
    global _client
    if not has_openai() or not orders:
        return []
    if _client is None:
        _client = OpenAI(api_key=config.openai.api_key)
    built = build_pick_prompt(pkg, orders, message_text)
    response = _client.responses.create(
        model=config.openai.response_model,
        reasoning={'effort': 'low'},
        input=built.prompt,
        text={'format': {'type': 'json_schema', 'name': 'order_pick', 'strict': True, 'schema': SCHEMA}},
    )
    return ground_picks(parse_picks(json.loads(response.output_text or '{}'), built), pkg)

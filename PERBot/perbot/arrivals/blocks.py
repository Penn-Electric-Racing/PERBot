"""Block Kit for the thread reply under a delivery photo, plus the button value codec. Pure. Replies
name requesters, vendors, and items only — never prices (the scan doesn't read them, and Notion's
cost columns are never rendered).

One card per package the photo resolved — a single order, never a wall of candidates:
  headline   "Probably @Mike's Mouser order from Oct 5" (requesters @-mentioned, so the people who
             know what's in the box see it) or, vendor-only, "Best guess: Mike's order from Oct 5"
             (names written out, nobody pinged — it's only a guess)
  items      the order's rows as checkboxes, the ones this box shows already ticked (≤ 10 rows;
             bigger orders fall back to a linked list + [These N arrived] [All M arrived]). A
             vendor-only guess among several orders ticks nothing: the tapper says what's there.
  links      one line per row: Notion · product page (Slack doesn't make links inside a checkbox
             option clickable — a tap there toggles the box), plus the row's description when its
             name is generic ("JLCPCB Boards")
  why        what the guess rests on, and why anyone is tagged
  actions    [Mark arrived] [Wrong order] [Other <vendor> orders… ▾]
Picking another order swaps the card in place; Wrong order swaps it to the next candidate (never one
already rejected); marking turns it into a receipt with [Undo]. Rows left unticked stay
`Arrived? = No` — that IS the partial-shipment record.

When to say nothing (from #packages history, where most photos are banter, pickup proof, or piles
of boxes): not a delivery; a thread reply without a specific match; anything unresolved except a
top-level label/slip, which gets one nudge to post the packing slip.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, TypedDict
from zoneinfo import ZoneInfo

from ..utils.clock import parse_iso
from ..utils.text import js_number
from .match import vendor_display, vendor_key, vendors_compatible
from .models import ArrivalRow, Extraction, OpenOrder, Resolution, Scan, SlipMatch
from .pick import is_generic

ARRIVAL_ACTION_IDS = {
    'these': 'arrival_these',
    'all': 'arrival_all',
    # Legacy pick-list buttons (`arrival_order:<i>`) on replies posted before cards.
    'order': 'arrival_order',
    'wrong': 'arrival_wrong',
    # Marks the ticked checkboxes of the card.
    'mark': 'arrival_mark',
    # The checkboxes themselves — toggling one only needs an ack.
    'items': 'arrival_items',
    # "Other <vendor> orders…" select — swaps the card to that order.
    'other': 'arrival_other',
    'undo': 'arrival_undo',
}
# Buttons in one block need distinct action ids, so legacy pick-list buttons carry a `:n` suffix.
ARRIVAL_ACTION_RE = re.compile(r'^arrival_(these|all|order|wrong|mark|items|other|undo)(?::\d+)?$')
# Every block of a card carries `arrival_<part>:<package index>`.
CARD_BLOCK_RE = re.compile(r'^arrival_(head|items|links|list|note|why|actions|done|choice|reminded):(\d+)')
ACTIONS_BLOCK_PREFIX = 'arrival_actions:'
# One section per candidate order in a pick-list: `arrival_choice:<package>:<order>`.
CHOICE_BLOCK_PREFIX = 'arrival_choice:'

# Slack caps a button value at 2000 chars.
MAX_VALUE_CHARS = 2000
MAX_LISTED = 15
MAX_PACKAGES = 4
# Slack's limit on checkbox options.
MAX_OPTIONS = 10
MAX_ALTERNATIVES = 10
# Items listed on a card too big for checkboxes.
CARD_LISTED = 8

ET = ZoneInfo('America/New_York')

Block = dict[str, Any]


class ArrivalButtonValue(TypedDict, total=False):
    # Slack user who posted the photo (→ Received by).
    u: str
    # ts of the photo message (→ Arrived at, photo permalink).
    ts: str
    # Run ID whose rows are included, minus `x`.
    g: str
    x: list[str]
    # Row ids included explicitly.
    r: list[str]
    # `OpenOrder.key` of the card's order (to rebuild it after Undo, and for reminders).
    k: str
    # Undo only: when the rows were marked (epoch s), and which were `Ready for Pickup` before.
    t: float
    p: list[str]
    # Wrong order: `OpenOrder.key`s already rejected on this card, never offered again.
    n: list[str]


# Notion person name → Slack user id (see people.py).
People = dict[str, str]


def compact(id_: str) -> str:
    return id_.replace('-', '')


def encode_value(v: ArrivalButtonValue) -> str:
    return json.dumps(v, separators=(',', ':'), ensure_ascii=False)


def decode_value(raw: str | None) -> ArrivalButtonValue | None:
    try:
        v = json.loads(raw or '')
    except (ValueError, TypeError):
        return None
    if not isinstance(v, dict) or not isinstance(v.get('u'), str) or not isinstance(v.get('ts'), str):
        return None

    def ids(a: Any) -> list[str] | None:
        return [s for s in a if isinstance(s, str)] if isinstance(a, list) else None

    out: ArrivalButtonValue = {'u': v['u'], 'ts': v['ts']}
    if isinstance(v.get('g'), str):
        out['g'] = v['g']
    for k in ('x', 'r'):
        got = ids(v.get(k))
        if got is not None:
            out[k] = got  # type: ignore[literal-required]
    if isinstance(v.get('k'), str):
        out['k'] = v['k']
    if isinstance(v.get('t'), (int, float)) and not isinstance(v.get('t'), bool):
        out['t'] = v['t']
    for k in ('p', 'n'):
        got = ids(v.get(k))
        if got is not None:
            out[k] = got  # type: ignore[literal-required]
    return out


def target_ids(v: ArrivalButtonValue, run_row_ids: list[str]) -> list[str]:
    """The row ids a click covers, given the current rows of `g` (fetched at click time)."""
    excluded = {compact(i) for i in v.get('x') or []}
    ids = {compact(i): None for i in run_row_ids if compact(i) not in excluded}
    for i in v.get('r') or []:
        ids[compact(i)] = None
    return list(ids)


def _base(base: dict[str, str]) -> ArrivalButtonValue:
    return {'u': base['u'], 'ts': base['ts']}


def these_value(match: SlipMatch, base: dict[str, str]) -> ArrivalButtonValue:
    """"These N arrived" as the shorter of two encodings: the explicit matched ids, or the order minus
    the rows the slip didn't show (a 90-of-93 slip would otherwise overflow 2000 chars)."""
    matched = list(dict.fromkeys(r.id for r in match.matched_rows))
    explicit: ArrivalButtonValue = {**_base(base), 'r': [compact(i) for i in matched]}
    if not match.run_id:
        return explicit
    matched_set = set(matched)
    extras = [compact(r.id) for r in match.matched_rows if r.run_id != match.run_id]
    missing = [compact(r.id) for r in match.order_rows if r.id not in matched_set]
    complement: ArrivalButtonValue = {**_base(base), 'g': match.run_id, 'x': missing}
    if extras:
        complement['r'] = extras
    return complement if len(encode_value(complement)) < len(encode_value(explicit)) else explicit


def order_value(
    rows: list[ArrivalRow], run_id: str | None, base: dict[str, str], extras: list[ArrivalRow] | None = None
) -> ArrivalButtonValue:
    """A whole order: by Run ID when it has one (rows re-read at click time), else its row ids."""
    extra_ids = [compact(r.id) for r in extras or []]
    if run_id:
        v: ArrivalButtonValue = {**_base(base), 'g': run_id}
        if extra_ids:
            v['r'] = extra_ids
        return v
    return {**_base(base), 'r': list(dict.fromkeys([*(compact(r.id) for r in rows), *extra_ids]))}


def _first_name(full: str) -> str:
    parts = full.strip().split()
    return parts[0] if parts else ''


def _names(requesters: list[str], max_n: int = 2) -> str:
    first = list(dict.fromkeys(n for n in (_first_name(r) for r in requesters) if n))
    if not first:
        return ''
    return f"{', '.join(first[:max_n])} +{len(first) - max_n}" if len(first) > max_n else ' and '.join(first)


def who(requesters: list[str], people: People | None = None, max_n: int = 4) -> str:
    """"<@U1> and <@U2>" / "<@U1>, *Ana* and *Joe*" / "*Mike*" — requesters as Slack mentions where we
    know them, so the reply pings the people who can tell what's in the box; without `people`, plain
    names (nobody pinged). Everyone is named — "+2" left people asking who else (10/13) — up to
    `max_n`, then "and N others"."""
    unique = list(dict.fromkeys(r for r in requesters if r))
    if not unique:
        return ''
    shown = [f'<@{people[n]}>' if people and people.get(n) else f'*{_first_name(n)}*' for n in unique[:max_n]]
    if len(unique) > max_n:
        extra = len(unique) - max_n
        shown.append(f"{extra} other{'' if extra == 1 else 's'}")
    return shown[0] if len(shown) == 1 else f"{', '.join(shown[:-1])} and {shown[-1]}"


def _order_phrase(rows: list[ArrivalRow], vendor: str, date: str | None, people: People | None) -> str:
    """"<@Mike>'s *DigiKey* order from *Oct 5*" / "the *DigiKey* order from *Oct 5*"."""
    whom = who([n for r in rows for n in r.point_of_contact], people)
    owner = f"{whom}'s" if whom else 'the'
    return f"{owner} *{vendor}* order{f' from *{date}*' if date else ''}"


def _parse_when(iso: str) -> datetime | None:
    try:
        return parse_iso(f'{iso}T12:00:00Z' if len(iso) == 10 else iso)
    except ValueError:
        return None


def short_date(iso: str | None) -> str | None:
    if not iso:
        return None
    d = _parse_when(iso)
    if not d:
        return None
    local = d.astimezone(ET)
    return f"{local.strftime('%b')} {local.day}"


def _earliest(values: list[str | None]) -> str | None:
    present = sorted(v for v in values if v)
    return present[0] if present else None


def _clean(s: str, max_len: int) -> str:
    full = re.sub(r'\s+', ' ', re.sub(r'[<>|*_~`]', '', s)).strip()
    return full if len(full) <= max_len else re.sub(r'[\s,;(]+\S*$', '', full[:max_len]) + '…'


def _shown_code(row: ArrivalRow) -> str | None:
    """A catalog number worth showing next to the name — what's printed on the bag ("SN74LVC245APWR"), not free text."""
    pn = row.part_number.strip()
    if not pn or len(pn) > 30 or re.search(r'\s', pn) or not re.search(r'\d', pn):
        return None
    return None if row.name and pn.upper() in row.name.upper() else _clean(pn, 30)


def _product_url(row: ArrivalRow) -> str | None:
    """The row's product page, safe inside `<url|text>`; None when missing, not http(s), or absurdly long."""
    url = (row.link or '').strip()
    if not re.fullmatch(r'https?://\S+', url, re.I) or len(url) > 500:
        return None
    if re.match(r'^https?://([^/]+\.)?notion\.(so|site|com)/', url, re.I):
        return None  # a Notion page pasted in as the product
    return url.replace('|', '%7C').replace('>', '%3E').replace('<', '%3C')


def _product_label(row: ArrivalRow) -> str:
    """"Mouser ↗" — the vendor's name for the product link (the link's host when the vendor is blank)."""
    m = re.match(r'^https?://(?:www\.)?([^/:]+)', row.link or '', re.I)
    parts = (m.group(1) if m else '').split('.')
    host = parts[-2] if len(parts) >= 2 else ''
    return f"{_clean(vendor_display(row.vendor) or vendor_display(host) or 'Product page', 24)} ↗"


def _product_link(row: ArrivalRow) -> str:
    """"<product|Mouser ↗>", or "" without a product link."""
    url = _product_url(row)
    return f'<{url}|{_product_label(row)}>' if url else ''


def _qty(row: ArrivalRow) -> str:
    return f' ×{js_number(row.quantity)}' if row.quantity > 0 else ''


def item_line(row: ArrivalRow, max_len: int = 60) -> str:
    """"• <notion|Bus Transceivers Single 8-bit…> `SN74LVC245APWR` ×2 · <product|Mouser ↗>" — the name
    links to the Purchasing row."""
    name = _clean(row.name or row.part_number, max_len) or 'item'
    code = _shown_code(row)
    product = _product_link(row)
    return (
        f"• {f'<{row.url}|{name}>' if row.url else name}{f' `{code}`' if code else ''}{_qty(row)}"
        f"{f' · {product}' if product else ''}"
    )


def _button(text: str, action_id: str, value: ArrivalButtonValue, style: str | None = None) -> Block | None:
    encoded = encode_value(value)
    if len(encoded) > MAX_VALUE_CHARS:
        return None
    b: Block = {'type': 'button', 'text': {'type': 'plain_text', 'text': text[:75], 'emoji': True}, 'action_id': action_id, 'value': encoded}
    if style:
        b['style'] = style
    return b


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _option(row: ArrivalRow) -> Block:
    """A checkbox: "Bus Transceivers Single… `74LVC1T45GW` ×3" (Slack caps it at 75). No links — they don't click there."""
    qty = _qty(row)
    code = _shown_code(row)
    tail = f"{f' `{code}`' if code else ''}{qty}"
    name = _clean(row.name or row.part_number, max(20, 72 - len(tail))) or 'item'
    text = f'{name}{tail}' if len(f'{name}{tail}') <= 75 else f'{name}{qty}'
    return {'text': {'type': 'mrkdwn', 'text': text}, 'value': compact(row.id)}


def row_detail(row: ArrivalRow) -> str | None:
    """What a generic row ("JLCPCB Boards") actually holds: its sanitized description (the text that
    goes to the vendor, so nothing internal), never anything that looks like a price. None when
    there's nothing beyond the name."""
    text = _clean(re.sub(r'\$\s?\d[\d,.]*', '', row.sanitized_description), 90)
    if not text or text.lower() == _clean(row.name, 90).lower():
        return None
    return text


def _link_line(row: ArrivalRow) -> str | None:
    """"`74LVC1T45GW,125`  <notion|Notion> · <product|Mouser ↗>" — one line per checkbox, in the same order."""
    code = _shown_code(row)
    what = f'`{code}`' if code else (_clean(row.name or row.part_number, 32) or 'item')
    if row.url and len(row.url) <= 60:
        notion = row.url
    elif row.id:
        notion = f'https://notion.so/{compact(row.id)}'
    else:
        notion = row.url
    links = [x for x in (f'<{notion}|Notion>' if notion else '', _product_link(row)) if x]
    detail = row_detail(row) if is_generic(row) else None
    line = f"{what}  {' · '.join(links)}" if links else (what if detail else None)
    return f'{line} — _{detail}_' if line and detail else line


def _order_option_label(o: OpenOrder) -> str:
    """"Theodor +7 · Sep 29 · Secondary and Inverter HVDC…" — plain text for a select option."""
    first = _clean(o.rows[0].name or o.rows[0].part_number, 30) if o.rows else ''
    parts = [_names(o.requesters, 1) or 'No contact', short_date(o.date) or 'no date', _plural(len(o.rows), 'item'), first]
    return ' · '.join(p for p in parts if p)


def _other_orders(alternatives: list[OpenOrder], vendor: str) -> Block | None:
    options = [
        {'text': {'type': 'plain_text', 'text': _order_option_label(o)[:75]}, 'value': o.key}
        for o in [a for a in alternatives if len(a.key) <= 150][:MAX_ALTERNATIVES]
    ]
    if not options:
        return None
    return {
        'type': 'static_select',
        'action_id': ARRIVAL_ACTION_IDS['other'],
        'placeholder': {'type': 'plain_text', 'text': f'Other {vendor} orders ({len(options)})…'[:150]},
        'options': options,
    }


@dataclass
class CardInput:
    headline: str
    # The order's open rows — what "all arrived" means.
    rows: list[ArrivalRow]
    # Pre-ticked: the rows this box shows.
    checked: list[ArrivalRow]
    key: str | None
    run_id: str | None
    vendor: str
    # Matched rows from outside the order (ticked too).
    extras: list[ArrivalRow] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    # What the guess rests on and why people are tagged — its own line under the items.
    why: list[str] = field(default_factory=list)
    alternatives: list[OpenOrder] = field(default_factory=list)
    # Order keys already rejected on this card (carried by Wrong order, so the next swap skips them).
    rejected: list[str] = field(default_factory=list)


def order_card(index: int, card: CardInput, base: dict[str, str]) -> list[Block]:
    """One package's card. Block ids carry the package index so a tap settles only its own card."""

    def bid(part: str) -> str:
        return f'arrival_{part}:{index}'

    extras = card.extras
    by_id: dict[str, ArrivalRow] = {}
    for r in [*card.checked, *extras]:
        by_id[r.id] = r
    ticked = list(by_id.values())
    ticked_ids = set(by_id)
    all_rows = [*ticked, *[r for r in card.rows if r.id not in ticked_ids]]
    value: ArrivalButtonValue = _base(base)
    if card.key:
        value['k'] = card.key
    rejected = list(dict.fromkeys(card.rejected))[-12:]
    notes = list(card.notes)
    blocks: list[Block] = [{'type': 'section', 'block_id': bid('head'), 'text': {'type': 'mrkdwn', 'text': card.headline}}]
    elements: list[Block | None] = []

    if len(all_rows) <= MAX_OPTIONS:
        shown: list[ArrivalRow] | None = all_rows
    elif ticked and len(ticked) <= MAX_OPTIONS:
        shown = ticked
    else:
        shown = None
    if shown is not None:
        options = [_option(r) for r in shown]
        initial = [o for o, r in zip(options, shown) if r.id in ticked_ids]
        checkboxes: Block = {'type': 'checkboxes', 'action_id': ARRIVAL_ACTION_IDS['items'], 'options': options}
        if initial:
            checkboxes['initial_options'] = initial
        blocks.append({'type': 'actions', 'block_id': bid('items'), 'elements': [checkboxes]})
        # Context text caps at 3000 chars per element (long Amazon URLs): split across elements if needed.
        link_texts: list[Block] = []
        for line in (l for l in (_link_line(r) for r in shown) if l):
            last = link_texts[-1] if link_texts else None
            if last and len(last['text']) + len(line) + 1 <= 3000:
                last['text'] += f'\n{line}'
            elif len(line) <= 3000:
                link_texts.append({'type': 'mrkdwn', 'text': line})
        if link_texts:
            blocks.append({'type': 'context', 'block_id': bid('links'), 'elements': link_texts[:10]})
        elements.append(_button('Mark arrived', ARRIVAL_ACTION_IDS['mark'], value, 'primary'))
        if len(shown) < len(all_rows):
            notes.append(f"{_plural(len(all_rows) - len(shown), 'more item')} on this order not listed")
            all_value: ArrivalButtonValue = order_value(card.rows, card.run_id, base, extras)
            if card.key:
                all_value['k'] = card.key
            elements.append(_button(f'All {len(card.rows)} arrived', ARRIVAL_ACTION_IDS['all'], all_value))
    else:
        # Too many rows to tick one by one: list them and offer the two whole-set buttons.
        source = ticked or all_rows
        listed = [item_line(r) for r in source[:CARD_LISTED]]
        more = len(source) - len(listed)
        if more > 0:
            listed.append(f'• …and {more} more')
        blocks.append({'type': 'section', 'block_id': bid('list'), 'text': {'type': 'mrkdwn', 'text': '\n'.join(listed)}})
        these = (
            _button(f'These {len(ticked)} arrived', ARRIVAL_ACTION_IDS['these'], {**_base(base), 'r': [compact(r.id) for r in ticked]}, 'primary')
            if ticked and len(ticked) < len(all_rows)
            else None
        )
        elements.append(these)
        elements.append(
            _button(
                f'All {len(card.rows)} arrived',
                ARRIVAL_ACTION_IDS['all'],
                order_value(card.rows, card.run_id, base, extras),
                None if these else 'primary',
            )
        )

    wrong_value: ArrivalButtonValue = dict(value)  # type: ignore[assignment]
    if rejected:
        wrong_value['n'] = rejected
    elements.append(_button('Wrong order', ARRIVAL_ACTION_IDS['wrong'], wrong_value))
    elements.append(_other_orders([o for o in card.alternatives if o.key not in rejected], card.vendor))
    if notes:
        blocks.append({'type': 'context', 'block_id': bid('note'), 'elements': [{'type': 'mrkdwn', 'text': ' · '.join(notes)}]})
    if card.why:
        blocks.append({'type': 'context', 'block_id': bid('why'), 'elements': [{'type': 'mrkdwn', 'text': '\n'.join(card.why)}]})
    present = [e for e in elements if e]
    if not any(e['type'] == 'button' and e['action_id'] != ARRIVAL_ACTION_IDS['wrong'] for e in present):
        blocks.append(
            {
                'type': 'context',
                'block_id': bid('note'),
                'elements': [{'type': 'mrkdwn', 'text': 'Too many items to confirm from Slack — mark them in Notion.'}],
            }
        )
    blocks.append({'type': 'actions', 'block_id': bid('actions'), 'elements': present})
    return blocks


def _vendor_name(rows: list[ArrivalRow], hint: str | None) -> str:
    # The label's spelling when it agrees with Notion ("Eurotech Distributors" over "eurotech direct");
    # Notion's when the label names someone else (a UPS Store re-ship, a fulfiller).
    row_vendor = next((r.vendor for r in rows if r.vendor), '')
    agree = bool(hint) and (not row_vendor or vendors_compatible(vendor_key(hint), vendor_key(row_vendor)))
    titled = row_vendor if re.search(r'[A-Z]', row_vendor) else re.sub(r'(^|\s)[a-z]', lambda m: m.group(0).upper(), row_vendor)
    return _clean(vendor_display(hint if agree else titled) or 'vendor', 40)


def _tagged(rows: list[ArrivalRow], people: People | None) -> bool:
    """Someone on these rows gets an @-mention."""
    return bool(people) and any(n in people for r in rows for n in r.point_of_contact)  # type: ignore[operator]


def match_card(
    index: int,
    res: Resolution,
    vendor_hint: str | None,
    base: dict[str, str],
    people: People | None = None,
    rejected: list[str] | None = None,
) -> list[Block]:
    """A package matched to an order — by part numbers, a requisition number, or the model's grounded pick."""
    match = res.match
    assert match is not None
    evidence = res.evidence
    context_rows = match.order_rows or match.matched_rows
    date = short_date(_earliest([r.ordered_at or r.submitted_at for r in context_rows]))
    vendor = _vendor_name([*match.matched_rows, *context_rows], vendor_hint)
    order = _order_phrase(context_rows, vendor, date, people)
    n = len(match.matched_rows)
    total = len(match.order_rows)
    matched = {r.id for r in match.matched_rows}
    whole_order = all(r.id in matched for r in match.order_rows)
    order_ids = {o.id for o in match.order_rows}
    extras = [r for r in match.matched_rows if r.id not in order_ids]

    if match.confidence == 'exact':
        headline = f':package: This is {order} — the requisition number is on the slip. *{n} of {total}* items matched by part number.'
    elif evidence:
        headline = f':package: Probably {order}: *{n} of {n if whole_order else total}* items.'
    elif match.confidence == 'weak':
        headline = f':package: Best guess: {order}, but only *{n} of {len(match.lines)}* slip lines matched an open row. Check before confirming.'
    else:
        headline = f':package: Looks like {order}: *{n} of {n if whole_order else total}* items on this slip.'

    unmatched_pns = [
        s
        for s in (l.line.vendor_part_number or l.line.manufacturer_part_number or l.line.customer_reference for l in match.lines if not l.row)
        if s
    ]
    notes: list[str] = []
    if unmatched_pns:
        notes.append(f"not found in Purchasing: {', '.join(unmatched_pns[:6])}{'…' if len(unmatched_pns) > 6 else ''}")
    if match.confidence == 'exact' or (not evidence and match.confidence == 'strong'):
        why = [':mag: Why: part numbers on the slip match this order']
    elif evidence:
        why = [f':mag: Why: {_clean(evidence, 160)}']
    else:
        why = [':mag: Why: only some slip lines match — check the items before confirming']
    if _tagged(context_rows, people):
        why.append(':bust_in_silhouette: Tagged: they requested this order')

    return order_card(
        index,
        CardInput(
            headline=headline,
            rows=match.order_rows or match.matched_rows,
            checked=[r for r in match.matched_rows if not any(r is e for e in extras)] if n else match.order_rows,
            extras=extras,
            key=res.key,
            run_id=match.run_id,
            vendor=vendor,
            notes=notes,
            why=why,
            alternatives=res.alternatives,
            rejected=rejected or [],
        ),
        base,
    )


ASK_AGAIN = 'Not sure? Reply `@PERBot <what’s in the box>` (or who it’s for) and I’ll look again.'


def guess_card(
    index: int,
    order: OpenOrder,
    alternatives: list[OpenOrder],
    vendor: str,
    base: dict[str, str],
    lead: str = '',
    rejected: list[str] | None = None,
) -> list[Block]:
    """Vendor known, order not: the most plausible order as a card, the rest in the "Other … orders"
    select. Only a guess, so requesters are named, not pinged; with several open orders nothing is
    pre-ticked — the person holding the box ticks what's in it. `lead` (an undo or a rejection) is its
    own line above the headline."""
    rejected = rejected or []
    v = _clean(vendor_display(vendor) or vendor, 40)
    whom = who([n for r in order.rows for n in r.point_of_contact])
    when = short_date(order.date)
    open_orders = [o for o in alternatives if o.key not in rejected]
    when_part = f' from *{when}*' if when else ''
    if open_orders:
        head = f":package: A *{v}* package. Best guess: {f'{whom}’s' if whom else 'the'} order{when_part} — tick what’s actually in the box."
    else:
        head = f":package: A *{v}* package. There’s one open {v} order{f' ({whom}’s)' if whom else ''}{when_part}. Is it this one?"
    generic = any(is_generic(r) for r in order.rows)
    why = [
        f":grey_question: Why: only the vendor matched{f' — {len(open_orders) + 1} open {v} orders, this is the closest by date' if open_orders else ''}"
    ]
    if generic:
        why.append(':warning: These items don’t say what’s inside — open the Notion link to check before marking.')
    why.append(ASK_AGAIN)
    return order_card(
        index,
        CardInput(
            headline=f'{lead.strip()}\n{head}' if lead.strip() else head,
            rows=order.rows,
            checked=[] if open_orders or generic else order.rows,
            key=order.key,
            run_id=order.run_id,
            vendor=v,
            why=why,
            alternatives=open_orders,
            rejected=rejected,
        ),
        base,
    )


@dataclass
class Reply:
    text: str
    blocks: list[Block]


@dataclass
class ReplyContext:
    u: str
    ts: str
    # The photo was posted as a thread reply.
    in_thread: bool
    # The message posted with the photo.
    text: str | None = None
    # Requesters → Slack ids, for @-mentions.
    people: People | None = None
    # Someone asked PERBot to look again (`@PERBot <what's in it>`): a vendor guess is welcome even in a thread.
    correction: bool = False
    # Order keys rejected in this thread: carried on the cards so Wrong order never comes back to them.
    rejected: list[str] = field(default_factory=list)


def text_names_vendor(text: str | None, vendor: str) -> bool:
    """"Jlc picked up" names JLCPCB: the poster is talking about this vendor's delivery."""
    key = vendor_key(vendor)
    return bool(key) and any(len(w) >= 3 and vendor_key(w) == key for w in re.split(r'[^A-Za-z0-9-]+', text or ''))


SLIP_PLEASE = (
    'If it’s ours, reply here with a photo of the *packing slip* or a *bag label* (anything with part numbers), '
    'reply `@PERBot <what’s in it>`, or mark it in Notion.'
)


def build_reply(scan: Scan, resolutions: list[Resolution], ctx: ReplyContext) -> Reply | None:
    """The thread reply for one delivery photo, or None to stay silent."""
    if scan.scene == 'not_a_delivery':
        return None
    base = {'u': ctx.u, 'ts': ctx.ts}

    # Pick-lists only at top level, and for a photo of a pile only when the message names the vendor
    # ("Jlc picked up"): otherwise a vendor alone isn't worth a prompt (pickup proof, "here's the
    # haul"). One pick-list per vendor — two JLCPCB boxes don't need two identical questions.
    chosen: set[str] = set()
    sections: list[list[Block]] = []
    for res in resolutions:
        if len(sections) >= MAX_PACKAGES:
            break
        pkg = scan.packages[res.pkg] if 0 <= res.pkg < len(scan.packages) else None
        if res.kind == 'match':
            sections.append(match_card(len(sections), res, pkg.vendor if pkg else None, base, ctx.people, ctx.rejected))
        if res.kind != 'choose' or (ctx.in_thread and not ctx.correction) or vendor_key(res.vendor) in chosen:
            continue
        if scan.scene == 'several_packages' and not ctx.correction and not text_names_vendor(ctx.text, res.vendor):
            continue
        chosen.add(vendor_key(res.vendor))
        sections.append(guess_card(len(sections), res.orders[0], res.orders[1:], res.vendor, base, '', ctx.rejected))

    if not sections:
        hints = list(dict.fromkeys(h for p in scan.packages for h in p.item_hints))[:3]
        looked = f" with {' / '.join(f'“{_clean(h, 40)}”' for h in hints)} in it" if hints else ''
        if ctx.correction:
            text = f':package: I couldn’t find an open order{looked}. It may not be in Purchasing — mark it in Notion if it’s ours.'
            return Reply('No open order matches', [{'type': 'section', 'text': {'type': 'mrkdwn', 'text': text}}])
        paperwork = scan.scene in ('packing_slip', 'shipping_label')
        if ctx.in_thread or not paperwork:
            return None
        if scan.legible:
            lead = f":package: I couldn’t find an open order{looked}{' — it may not be in Purchasing yet' if hints else ''}."
        else:
            lead = ':camera: I couldn’t read the label.'
        return Reply('Which order is this package?', [{'type': 'section', 'text': {'type': 'mrkdwn', 'text': f'{lead} {SLIP_PLEASE}'}}])

    blocks: list[Block] = []
    if len(sections) > 1:
        blocks.append({'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': f':package: {len(sections)} orders in this photo'}]})
    for i, s in enumerate(sections):
        if i > 0:
            blocks.append({'type': 'divider'})
        blocks.extend(s)
    text = f'{len(sections)} orders arrived — confirm them' if len(sections) > 1 else 'Package arrived — confirm the order'
    return Reply(text, blocks)


def _days_between(from_iso: str, to_iso: str) -> int:
    start = _parse_when(from_iso)
    try:
        end = parse_iso(to_iso)
    except ValueError:
        return 0
    if not start:
        return 0
    return max(0, math.floor((end - start).total_seconds() / 86_400 + 0.5))


def lead_time_line(rows: list[ArrivalRow], arrived_at_iso: str) -> str | None:
    """"Ordered Sep 28 → here Oct 10 (12 days) · requested Sep 20 (20 days end to end)"."""
    ordered = _earliest([r.ordered_at for r in rows])
    requested = _earliest([r.submitted_at for r in rows])
    parts: list[str] = []
    if ordered:
        parts.append(
            f'ordered {short_date(ordered)} → here {short_date(arrived_at_iso)} (*{_days_between(ordered, arrived_at_iso)} days*)'
        )
    if requested:
        parts.append(f'requested {short_date(requested)} (*{_days_between(requested, arrived_at_iso)} days* end to end)')
    if not parts:
        return None
    line = ' · '.join(parts)
    return line[0].upper() + line[1:]


def settle_blocks(blocks: list[Block], block_id: str, outcome: str, chosen: int | None = None) -> list[Block]:
    """Settle one package after a tap: its buttons become a one-line outcome. In a pick-list the
    chosen order stays (without its button) and the other candidates go; `chosen` is the tapped
    order's index (`arrival_order:<i>`), absent for Wrong order / None of these. Other packages are
    untouched."""
    m = re.match(r'^arrival_(?:actions|choice):(\d+)', block_id or '')
    if not m:
        return blocks
    actions_id = f'{ACTIONS_BLOCK_PREFIX}{m.group(1)}'
    choice_prefix = f'{CHOICE_BLOCK_PREFIX}{m.group(1)}:'
    out: list[Block] = []
    for b in blocks:
        bid = (b or {}).get('block_id') or ''
        if bid == actions_id:
            out.append({'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': outcome}]})
        elif bid.startswith(choice_prefix):
            try:
                idx = int(bid[len(choice_prefix):])
            except ValueError:
                idx = None
            if idx != chosen:
                continue
            out.append({k: v for k, v in b.items() if k != 'accessory'})
        else:
            out.append(b)
    return out


def package_key(pkg: Extraction) -> str | None:
    """Two photos of the same box share vendor + tracking number."""
    tracking = sorted(re.sub(r'\s+', '', t).upper() for t in pkg.tracking_numbers)
    return f'{vendor_key(pkg.vendor)}:{tracking[0]}' if tracking else None


def card_index(block_id: str | None) -> int | None:
    """The package index a card block belongs to (`arrival_items:2` → 2), or None for other blocks."""
    m = CARD_BLOCK_RE.match(block_id or '')
    return int(m.group(2)) if m else None


def is_card(blocks: list[Block], index: int) -> bool:
    """True when the message's card `index` is a new-style card (has a head block)."""
    return any((b or {}).get('block_id') == f'arrival_head:{index}' for b in blocks)


def replace_card(blocks: list[Block], index: int, replacement: list[Block]) -> list[Block]:
    """Swap card `index` for `replacement` in place (another order picked, or rebuilt after Undo)."""
    out: list[Block] = []
    inserted = False
    for b in blocks:
        if card_index((b or {}).get('block_id')) != index:
            out.append(b)
            continue
        if not inserted:
            out.extend(replacement)
        inserted = True
    return out if inserted else [*out, *replacement]


def settle_card(
    blocks: list[Block],
    index: int,
    outcome: str,
    marked: list[ArrivalRow] | None = None,
    undo: ArrivalButtonValue | None = None,
) -> list[Block]:
    """Settle card `index` after a tap. The headline stays; the checkboxes become a linked list of
    what was marked; the buttons become the outcome line, plus [Undo] when there is something to undo."""
    marked = marked or []

    def bid(part: str) -> str:
        return f'arrival_{part}:{index}'

    out: list[Block] = []
    listed = False
    for b in blocks:
        block_id = (b or {}).get('block_id')
        part = block_id.split(':')[0].replace('arrival_', '', 1) if card_index(block_id) == index else None
        if not part or part == 'head':
            out.append(b)
        elif part in ('items', 'list') and not listed and marked:
            lines = [item_line(r) for r in marked[:MAX_LISTED]]
            if len(marked) > MAX_LISTED:
                lines.append(f'• …and {len(marked) - MAX_LISTED} more')
            out.append({'type': 'section', 'block_id': bid('list'), 'text': {'type': 'mrkdwn', 'text': '\n'.join(lines)}})
            listed = True
        elif part == 'actions':
            out.append({'type': 'context', 'block_id': bid('note'), 'elements': [{'type': 'mrkdwn', 'text': outcome}]})
            undo_button = _button('Undo', ARRIVAL_ACTION_IDS['undo'], undo) if undo else None
            if undo_button:
                out.append({'type': 'actions', 'block_id': bid('done'), 'elements': [undo_button]})
        # items/list (nothing marked), links, note, done, choice, reminded: dropped.
    return out


def arrival_dm(rows: list[ArrivalRow], clicker: str, poster: str, permalink: str | None, arrived_at_iso: str) -> str:
    """The DM a requester gets once their order is confirmed."""
    vendor = _vendor_name(rows, None)
    lines = [item_line(r, 50) for r in rows[:8]]
    if len(rows) > 8:
        lines.append(f'• …and {len(rows) - 8} more')
    by = f'<@{poster}>' if clicker == poster else f'<@{poster}> (confirmed by <@{clicker}>)'
    lead = lead_time_line(rows, arrived_at_iso)
    return '\n'.join([
        f":package: Your *{vendor}* order is here — {_plural(len(rows), 'item')} received by {by}:",
        *lines,
        *([lead] if lead else []),
        *([f'<{permalink}|See the photo in #packages>'] if permalink else []),
    ])


def reminder_dm(order: OpenOrder, reply_link: str | None) -> str:
    """The one reminder a likely requester gets when a card sat untapped."""
    vendor = _vendor_name(order.rows, None)
    items = ', '.join(_clean(r.name or r.part_number, 40) for r in order.rows[:3])
    more = f' +{len(order.rows) - 3}' if len(order.rows) > 3 else ''
    look = f'<{reply_link}|take a look>' if reply_link else 'take a look'
    return (
        f':package: A *{vendor}* package in #packages might be yours ({items}{more}). '
        f'Nobody has confirmed it yet — {look} and tap *Mark arrived* or *Wrong order*.'
    )

"""Packing slip → open Purchasing rows. Pure (no Notion, no Slack, no LLM).

Match keys, strongest first:
 1. An order number on the slip equal to a BenBuys requisition (`Run ID = BENBUYS-<req#>`).
    Exact, but rarely printed — DigiKey slips usually carry Penn's PO, which Notion doesn't hold.
 2. Part numbers: each slip line's vendor or manufacturer number against `Cat. or model no.`
    (normalized the way `/benbuys prep` normalizes). This is the workhorse — every row has one.
 3. The line's customer reference against the row's sanitized description, since `/benbuys prep`
    writes that description (truncated) into DigiKey's reference column.
 4. A shared model code (`part_codes`) between the slip line and a free-text row — many non-DigiKey
    rows hold a description, not a catalog number, in `Cat. or model no.`.
Rows from a different vendor are never candidates. Among several rows for one part, the one in the
slip's dominant order wins, then an equal quantity, then the oldest order (first in, first out).
"""
from __future__ import annotations

import re
from urllib.parse import urlparse

from benbuys.prep import normalize_part_number
from arrivals.models import ArrivalRow, Extraction, LineMatch, MatchConfidence, SlipLine, SlipMatch

VENDOR_ALIASES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r'^digi-?key'), 'digikey'),
    (re.compile(r'^mcmaster'), 'mcmaster'),
    (re.compile(r'^mouser'), 'mouser'),
    (re.compile(r'^amazon|^amzn'), 'amazon'),
    (re.compile(r'^jlc'), 'jlcpcb'),
    (re.compile(r'^xometry'), 'xometry'),
    (re.compile(r'^send-?cut-?send'), 'sendcutsend'),
]

VENDOR_NAMES = {
    'digikey': 'DigiKey',
    'mcmaster': 'McMaster-Carr',
    'mouser': 'Mouser',
    'amazon': 'Amazon',
    'jlcpcb': 'JLCPCB',
    'xometry': 'Xometry',
    'sendcutsend': 'SendCutSend',
}


def vendor_display(raw: str | None) -> str:
    """How to write a vendor in a reply: canonical for the common ones, else as given minus "Inc."/"LLC"."""
    known = VENDOR_NAMES.get(vendor_key(raw))
    if known:
        return known
    return re.sub(r',?\s*(inc\.?|llc|ltd\.?|co\.)$', '', raw or '', flags=re.I).strip()


def vendor_key(raw: str | None) -> str:
    """"McMaster-Carr Supply Co." / "mcmaster carr" / "www.mcmaster.com" → "mcmaster". Vendors without
    an alias key on their first word, so "Eurotech Distributors, Inc." and "eurotech direct" agree.
    "" = unknown."""
    lower = re.sub(r'^www\.', '', re.sub(r'^https?://', '', (raw or '').lower())).strip()
    joined = re.sub(r'[^a-z0-9-]+', '', lower)
    if not joined:
        return ''
    for rx, key in VENDOR_ALIASES:
        if rx.search(joined):
            return key
    return next((w for w in re.split(r'[^a-z0-9]+', lower) if w and w != 'the'), '')


def row_vendor_key(row: ArrivalRow | None) -> str:
    """The row's vendor from its Vendor text, else its product link's domain."""
    if row is None:
        return ''
    from_text = vendor_key(row.vendor)
    if from_text:
        return from_text
    try:
        return vendor_key(urlparse(row.link).hostname or '')
    except ValueError:
        return ''


def vendors_compatible(a: str, b: str) -> bool:
    return not a or not b or a == b or a.startswith(b) or b.startswith(a)


def _requisition_digits(value: str) -> str | None:
    """Digits of a requisition-looking order number, or None. BenBuys requisitions are 6–8 digits."""
    digits = re.sub(r'\D', '', value)
    return digits if re.fullmatch(r'\d{6,8}', digits) else None


def _normalize_ref(s: str | None) -> str:
    return re.sub(r'[^A-Z0-9]+', '', (s or '').upper())


def part_codes(*texts: str | None) -> dict[str, None]:
    """Model-number-like tokens: 6+ letters/digits with at least one of each ("FHLR2GCB2G",
    "LM358DR"). Pure numbers, plain words, and short sizes ("3x2.5mm") are too common to identify a
    part. Returned as an insertion-ordered set."""
    codes: dict[str, None] = {}
    for t in texts:
        for tok in re.split(r'[^A-Z0-9]+', (t or '').upper()):
            if len(tok) >= 6 and re.search(r'[A-Z]', tok) and re.search(r'\d', tok):
                codes[tok] = None
    return codes


def _line_matches_row(line: SlipLine, row: ArrivalRow) -> bool:
    row_pn = normalize_part_number(row.part_number)
    if row_pn:
        for pn in (line.vendor_part_number, line.manufacturer_part_number):
            if pn and normalize_part_number(pn) == row_pn:
                return True
    # A truncated reference must still carry real signal — 8+ characters, like reference.py's floor.
    ref = _normalize_ref(line.customer_reference)
    if len(ref) >= 8 and _normalize_ref(row.sanitized_description).startswith(ref):
        return True
    # Free-text rows ("5 meters of FHLR2GCB2G (3x2.5mm²)") share a model code with the slip's description.
    row_codes = part_codes(row.part_number, row.name)
    return any(code in row_codes for code in part_codes(line.vendor_part_number, line.manufacturer_part_number, line.description))


def _order_time(row: ArrivalRow) -> str:
    return row.ordered_at or row.submitted_at or '9999'


def _shipped_here(line: SlipLine) -> bool:
    """A slip line that lists 0 shipped (backordered) is not in the box."""
    return line.quantity_shipped is None or line.quantity_shipped > 0


def match_slip(extraction: Extraction, open_rows: list[ArrivalRow]) -> SlipMatch:
    slip_vendor = vendor_key(extraction.vendor)
    pool = [r for r in open_rows if vendors_compatible(slip_vendor, row_vendor_key(r))]
    lines = [l for l in extraction.lines if _shipped_here(l)]

    # 1. Exact: an order number on the slip names a BenBuys requisition we recorded.
    run_ids = {r.run_id for r in pool if r.run_id}
    exact_run_id: str | None = None
    for n in extraction.order_numbers:
        digits = _requisition_digits(n.value)
        if digits and f'BENBUYS-{digits}' in run_ids:
            exact_run_id = f'BENBUYS-{digits}'
            break

    # 2. Candidates per line, then the dominant order = the Run ID covering the most lines. A tie
    #    names no order up front; quantity and age pick the rows, and the order follows from them.
    candidates = [[r for r in pool if _line_matches_row(line, r)] for line in lines]
    run_id = exact_run_id or _unique_top([list(dict.fromkeys(r.run_id for r in rows if r.run_id)) for rows in candidates])

    # 3. One row per line, never the same row twice.
    used: set[str] = set()
    matches: list[LineMatch] = []
    for i, line in enumerate(lines):
        options = sorted(
            (r for r in candidates[i] if r.id not in used),
            key=lambda r: (
                -int(bool(run_id) and r.run_id == run_id),
                -int(r.quantity == line.quantity_shipped),
                _order_time(r),
            ),
        )
        row = options[0] if options else None
        if row:
            used.add(row.id)
        matches.append(LineMatch(line, row))

    matched_rows = [m.row for m in matches if m.row]
    order = (
        run_id
        or _unique_top([[r.run_id] if r.run_id else [] for r in matched_rows])
        or next((r.run_id for r in matched_rows if r.run_id), None)
    )
    # PEFS export runs (PERPO-…) batch several vendors; the box is one vendor's slice of the run.
    # Name the run in button values only when the slice IS the whole run (click time re-reads the run).
    run = [r for r in open_rows if r.run_id == order] if order else []
    slice_row = next((r for r in matched_rows if r.run_id == order), None) or (run[0] if run else None)
    slice_vendor = row_vendor_key(slice_row)
    order_rows = [r for r in run if vendors_compatible(slice_vendor, row_vendor_key(r))]

    confidence: MatchConfidence = 'none'
    if exact_run_id:
        confidence = 'exact'
    elif matched_rows:
        confidence = 'strong' if len(matched_rows) * 2 >= len(lines) else 'weak'

    return SlipMatch(
        confidence=confidence,
        run_id=order if len(order_rows) == len(run) else None,
        order_rows=order_rows,
        matched_rows=matched_rows,
        lines=matches,
    )


def _unique_top(groups: list[list[str]]) -> str | None:
    """The value appearing in the most groups, or None when nothing appears or the top is tied."""
    counts: dict[str, int] = {}
    for group in groups:
        for v in group:
            counts[v] = counts.get(v, 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
    if not ranked or (len(ranked) > 1 and ranked[1][1] == ranked[0][1]):
        return None
    return ranked[0][0]

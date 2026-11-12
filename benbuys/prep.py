"""`/benbuys prep` — pure logic (no Slack, no Notion). `build_prep` turns the selected rows into
cart lines; `format_prep` renders the three code blocks. Blocking validation is the `PEFS Ready?`
formula's job in Notion; everything here is a warning at most."""
from __future__ import annotations

import re
from dataclasses import dataclass

from utils.text import js_number, round2
from benbuys.models import CartLine, PrepResult, PrepWarning, PurchasingRow, VendorAdapter


def normalize_part_number(raw: str) -> str:
    """Trim, collapse internal whitespace/newlines, uppercase — how the punchout keys parts."""
    return re.sub(r'\s+', '', raw).upper()


def aggregate_rows(rows: list[PurchasingRow], adapter: VendorAdapter) -> list[CartLine]:
    """Sum quantities across rows with the same normalized part number; keep the source rows."""
    by_part: dict[str, list[PurchasingRow]] = {}
    for row in rows:
        pn = normalize_part_number(row.part_number)
        if pn:
            by_part.setdefault(pn, []).append(row)
    return [
        CartLine(
            part_number=pn,
            quantity=sum(r.quantity for r in group),
            reference=adapter.reference_field(pn, group),
            line_total=round2(sum(r.quantity * r.unit_cost for r in group)),
            rows=group,
        )
        for pn, group in by_part.items()
    ]


HIGH_VALUE_LINE_USD = 100


def warnings_for(lines: list[CartLine], adapter: VendorAdapter) -> list[PrepWarning]:
    """§6 warning checks — never exclude a row."""
    out: list[PrepWarning] = []
    for line in lines:
        vendor_note = adapter.part_number_warning(line.part_number)
        if vendor_note:
            out.append(PrepWarning(line.part_number, vendor_note))

        def looks_like_part(r: PurchasingRow) -> bool:
            cat = r.part_number.strip().lower()
            return bool(cat) and (cat == r.name.strip().lower() or cat == r.sanitized_description.strip().lower())

        if any(looks_like_part(r) for r in line.rows):
            out.append(PrepWarning(line.part_number, 'description looks like a part number'))

        batches = list(dict.fromkeys(r.order_batch.strip() for r in line.rows))
        if len(line.rows) > 1 and len(batches) > 1:
            out.append(
                PrepWarning(line.part_number, f"aggregated across batches ({', '.join(b or 'blank' for b in batches)})")
            )

        if line.line_total > HIGH_VALUE_LINE_USD:
            out.append(PrepWarning(line.part_number, f'high-value line (${money(line.line_total)}) — double-check quantity'))
    return out


def build_prep(adapter: VendorAdapter, ready: list[PurchasingRow], not_ready: list[PurchasingRow]) -> PrepResult:
    """Select → aggregate → warn → total. `ready` rows are the Notion query result with the `PEFS
    Ready?` clause; `not_ready` are the same query without it, minus `ready`. If any ready row has
    `Include in next order` ticked, only those rows are used."""
    cherry = [r for r in ready if r.include_in_next_order]
    rows = cherry or ready
    lines = aggregate_rows(rows, adapter)
    return PrepResult(
        vendor_key=adapter.key,
        lines=lines,
        rows=rows,
        not_ready=not_ready,
        warnings=warnings_for(lines, adapter),
        estimated_total=round2(sum(r.quantity * r.unit_cost for r in rows)),
        cherry_picked=bool(cherry),
    )


def money(n: float) -> str:
    return f'{n:,.2f}'


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


@dataclass
class PrepBlocks:
    # Block 1 — paste into the punchout. Empty string when there are no lines.
    cart: str
    # Block 2 — BEN Financials fields.
    ben: str
    # Block 3 — summary.
    summary: str


def format_prep(adapter: VendorAdapter, prep: PrepResult, approval_threshold: float) -> PrepBlocks:
    """The three code blocks of the prep reply, as plain text (caller wraps in ``` fences)."""
    cart = adapter.format_cart_lines(prep.lines) if prep.lines else ''

    ben = '\n'.join([
        f'Description:   {adapter.ben_description}',
        f'Justification: {adapter.ben_justification}',
        'Receipt Required: leave unchecked',
        'Services location: leave blank',
    ])

    t = js_number(approval_threshold)
    approval = (
        f'likely APPROVAL REQUIRED (>${t}; BEN total decides)'
        if prep.estimated_total > approval_threshold
        else f'likely no approval needed (≤${t}; BEN total decides)'
    )

    summary: list[str] = []
    if not prep.lines:
        summary.append(f'No ready {adapter.label} rows to order.')
    else:
        summary.append(
            f"{_plural(len(prep.lines), 'line')} · {_plural(len(prep.rows), 'row')} · est. ${money(prep.estimated_total)} → {approval}"
        )
        if prep.cherry_picked:
            summary.append('Cherry-picked: only rows with "Include in next order" ticked.')
    if prep.not_ready:
        links = ', '.join(f"<{r.url}|{_slack_escape(r.name or r.part_number or 'untitled')}>" for r in prep.not_ready)
        summary.append(f"Not ready (fix in Notion): {_plural(len(prep.not_ready), 'row')} — {links}")
    else:
        summary.append('Not ready (fix in Notion): none')
    if prep.warnings:
        summary.append(f'Warnings: {len(prep.warnings)}\n' + '\n'.join(f'  • {w.part_number}: {w.message}' for w in prep.warnings))
    else:
        summary.append('Warnings: none')
    if prep.lines:
        summary.append('Next: /benbuys done <requisition#> <BEN total>')

    return PrepBlocks(cart, ben, '\n'.join(summary))


def _slack_escape(s: str) -> str:
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('|', '/')

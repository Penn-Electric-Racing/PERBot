"""DigiKey (electrical) — Phase 1. Operator: Katherine Shen.

Cart paste format is the punchout's Bulk Add box: `qty, partnumber, reference` per line, so the
reference must never contain a comma (we use the `Sanitized Description (CSV)` formula, which
already strips them, and re-strip defensively).

`match_formula` is the existing Notion formula (`Link to product webpage` contains digikey.com /
digi-key.com). Don't reimplement it here — if the team adds a domain variant they fix it in
Notion and the bot follows.
"""
from __future__ import annotations

from ...config import config
from ...utils.text import js_number
from ..models import CartLine, PurchasingRow, VendorAdapter
from ..reference import truncate_reference


def _format_cart_lines(lines: list[CartLine]) -> str:
    return '\n'.join(f'{js_number(l.quantity)}, {l.part_number}, {l.reference}' for l in lines)


def _reference_field(part_number: str, rows: list[PurchasingRow]) -> str:
    return truncate_reference(part_number, rows, config.benbuys.reference_max_chars)


def _part_number_warning(part_number: str) -> str | None:
    return None if part_number.endswith('-ND') else 'may be a manufacturer part number — DigiKey may pick different packaging'


digikey_adapter = VendorAdapter(
    key='digikey',
    label='DigiKey',
    match_formula='Electrical BENBuys',
    subteam='electrical',
    ben_description=config.benbuys.digikey.description,
    ben_justification=config.benbuys.digikey.justification,
    operator_slack_ids=config.benbuys.digikey.operators,
    signature_name=config.benbuys.digikey.signature_name,
    email_to=config.benbuys.digikey.to,
    format_cart_lines=_format_cart_lines,
    reference_field=_reference_field,
    part_number_warning=_part_number_warning,
)

"""McMaster-Carr (mechanical) — Phase 1.5 STUB. Operator: Sofia.

Same code path as DigiKey; only this object changes. Blocked on:
  1. `format_cart_lines`: McMaster's punchout bulk-entry box takes part-per-line with a quantity,
     NOT comma-delimited — confirm the exact format from a screenshot first.
  2. Sofia's Slack id → `BENBUYS_MCMASTER_OPERATORS`.
  3. Mechanical Description / Justification wording.
  4. Whether mechanical rows use `Order Batch` at all (the schema says it's an electrical label;
     mechanical rows in the DB have it blank), so `reference_field` must fall through gracefully
     and the "aggregated across batches" warning may never fire.
`match_formula` = `Mechanical BENBuys` exists in Notion today:
  contains(lower(format(prop("Link to product webpage"))), "mcmaster.com")
"""
from __future__ import annotations

from typing import Any

from benbuys.models import VendorAdapter


def _not_built(*_args: Any) -> str:
    raise NotImplementedError('McMaster adapter is not built yet — see benbuys/adapters/mcmaster.py')


mcmaster_adapter = VendorAdapter(
    key='mcmaster',
    label='McMaster-Carr',
    match_formula='Mechanical BENBuys',
    subteam='mechanical',
    ben_description='PER mechanical purchase',
    ben_justification="This is a purchase for PER's mechanical subteam.",
    format_cart_lines=_not_built,
    reference_field=_not_built,
    part_number_warning=lambda _pn: None,
)

"""BenBuys ordering helper — shared types.

Two Slack commands wrap the three clicks that must stay human (PennKey login, Submit Order on the
vendor punchout, Submit on BEN):
  /benbuys prep [vendor]          → cart paste block + BEN text + est. total + approval flag
  /benbuys done <req#> <total>    → requisition email sent, Notion rows marked ordered
Everything vendor-specific lives in a VendorAdapter (adapters/); prep/done are vendor-agnostic.
"""
from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass(eq=False)
class PurchasingRow:
    """One row of the Purchasing (PEFS) Notion database, already narrowed to what prep/done need.
    Compared by identity (eq=False), like the JS objects it replaces."""

    id: str
    url: str
    name: str
    # `Cat. or model no.` exactly as typed (normalized separately).
    part_number: str
    quantity: float
    unit_cost: float
    subsystems: list[str]
    point_of_contact: list[str]
    order_batch: str
    link: str
    # `Sanitized Description (CSV)` — vendor notes with newlines and commas stripped.
    sanitized_description: str
    notes: str
    # `PEFS Ready?` formula text — `✅ Ready` or `❌ Missing fields`.
    readiness: str
    include_in_next_order: bool

    def replace(self, **changes: Any) -> 'PurchasingRow':
        return dataclasses.replace(self, **changes)


@dataclass
class CartLine:
    """One punchout cart line: several rows with the same normalized part number collapse into one."""

    part_number: str
    quantity: float
    reference: str
    # Σ quantity × unit cost over the source rows.
    line_total: float
    rows: list[PurchasingRow]


@dataclass
class PrepWarning:
    part_number: str
    message: str


@dataclass
class PrepResult:
    vendor_key: str
    lines: list[CartLine]
    # Rows that fed `lines` (what `done` will write back to).
    rows: list[PurchasingRow]
    # `❌ Missing fields` rows that were excluded — fix in Notion.
    not_ready: list[PurchasingRow]
    warnings: list[PrepWarning]
    estimated_total: float
    # True when `Include in next order` narrowed the row set.
    cherry_picked: bool


@dataclass
class VendorAdapter:
    key: str
    label: str
    # Notion boolean formula that selects this vendor's rows (e.g. `Electrical BENBuys`).
    match_formula: str
    # Used in the requisition email body ("for electrical").
    subteam: str
    ben_description: str
    ben_justification: str
    # The punchout's bulk-add paste format.
    format_cart_lines: Callable[[list[CartLine]], str]
    # What goes in the per-line reference column, already length-capped: (part_number, rows) → text.
    reference_field: Callable[[str, list[PurchasingRow]], str]
    # Vendor-specific soft check on a normalized part number (None = fine).
    part_number_warning: Callable[[str], str | None]
    # Slack user ids allowed to run `done` for this vendor.
    operator_slack_ids: list[str] = field(default_factory=list)
    signature_name: str = ''
    # To: line only — CC comes from the shared config.
    email_to: list[str] = field(default_factory=list)

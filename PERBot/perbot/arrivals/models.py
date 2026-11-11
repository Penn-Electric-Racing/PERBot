"""Package arrivals — shared types.

A photo posted in the arrivals channel → a vision model reads the scene into a `Scan` (one
`Extraction` per visible package) → each package is resolved against open Purchasing (PEFS)
orders → PERBot replies in the thread with buttons, or stays silent. Nothing is written to Notion
until a human taps a button.

Shaped by #packages history (2026-07 → 10): of 19 photos, 1 showed a packing slip; 7 were a
shipping label, 4 the contents, 4 several packages at once, 2 not a delivery at all. So the vendor
(label, box branding, message text), the addressee, and item hints carry most of the signal.

Rows, orders and picks compare by identity (eq=False), like the JS objects they replace.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from ..benbuys.models import PurchasingRow

OrderNumberKind = Literal['purchase_order', 'sales_order', 'invoice', 'customer_reference', 'other']

Scene = Literal['packing_slip', 'shipping_label', 'contents', 'several_packages', 'not_a_delivery']


@dataclass
class SlipLine:
    # The vendor's own catalog number (DigiKey `…-ND`, a McMaster number).
    vendor_part_number: str | None = None
    manufacturer_part_number: str | None = None
    description: str | None = None
    # Quantity shipped in THIS box (backordered lines read 0). None when unreadable.
    quantity_shipped: float | None = None
    # Per-line customer reference — `/benbuys prep` fills it with the row's sanitized description.
    customer_reference: str | None = None


@dataclass
class OrderNumber:
    kind: OrderNumberKind
    value: str


@dataclass
class Extraction:
    """What the vision model read about ONE package. Prices are deliberately never extracted."""

    # The shipper: label FROM line, box branding, or the message text ("Jlc picked up").
    vendor: str | None = None
    # The person named on the label (SHIP TO / ATTN / consignee), not the university.
    addressee: str | None = None
    # ISO date printed on the label/slip, if any.
    ship_date: str | None = None
    order_numbers: list[OrderNumber] = field(default_factory=list)
    tracking_numbers: list[str] = field(default_factory=list)
    # Item lines from a packing slip or a contents label.
    lines: list[SlipLine] = field(default_factory=list)
    # Short names of what's inside, from the message text or visible contents ("cooling tube").
    item_hints: list[str] = field(default_factory=list)


@dataclass
class Scan:
    scene: Scene
    # False when labels/slips are present but too blurry, cropped, or far away to read.
    legible: bool
    packages: list[Extraction]


@dataclass(eq=False)
class ArrivalRow(PurchasingRow):
    """A Purchasing row plus the fields arrivals needs on top of what BenBuys reads."""

    vendor: str = ''
    run_id: str = ''
    # `Arrived?` status name: No / Ready for Pickup / Yes.
    arrived: str = ''
    # `Exported?` — the row went out on an order.
    exported: bool = False
    # `Submitted at` — when the request was filed (internal lead-time start).
    submitted_at: str | None = None
    # `Last Email Update` — when the order went out (vendor lead-time start).
    ordered_at: str | None = None


MatchConfidence = Literal['exact', 'strong', 'weak', 'none']


@dataclass
class LineMatch:
    line: SlipLine
    row: ArrivalRow | None


@dataclass(eq=False)
class SlipMatch:
    confidence: MatchConfidence
    # The order most of the slip belongs to (`Run ID`), or None when the matched rows have none.
    run_id: str | None
    # Every open row of that order — what "all arrived" would mark.
    order_rows: list[ArrivalRow]
    # Rows the slip actually shows (inside or outside the main order).
    matched_rows: list[ArrivalRow]
    lines: list[LineMatch]


@dataclass(eq=False)
class OpenOrder:
    """Open rows grouped into the order they went out on (`Run ID`, else vendor + submit day)."""

    key: str
    run_id: str | None
    rows: list[ArrivalRow]
    vendor: str
    requesters: list[str]
    # When it was ordered (or requested, if no order date), ISO.
    date: str | None


@dataclass
class Resolution:
    """How a package was resolved; `pkg` indexes `Scan.packages` (a message naming three items can
    yield three matches).

    kind 'match':  match, evidence, key (`OpenOrder.key` of the matched order, when it is one open
                   order), alternatives (the vendor's other open orders, offered as "Other <vendor>
                   orders…" in case the match is wrong)
    kind 'choose': orders, vendor
    kind 'none':   nothing else
    """

    kind: Literal['match', 'choose', 'none']
    pkg: int = -1
    match: SlipMatch | None = None
    evidence: str | None = None
    key: str | None = None
    alternatives: list[OpenOrder] = field(default_factory=list)
    orders: list[OpenOrder] = field(default_factory=list)
    vendor: str = ''

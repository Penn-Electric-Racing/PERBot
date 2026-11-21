"""The Purchasing (PEFS) Notion database, for every feature (BenBuys, arrivals, the price check):
its columns, one row type, and the reads. `Purchasing.shared()`.

Schema (confirmed 2026-09-15): Name (title) · Cat. or model no. (text) · Quant. (number) · Unit cost
(number) · Season (select) · Payment Method (select: PEFS/PCard/BenBuys) · PEFS Ready? (formula →
"✅ Ready" | "❌ Missing fields") · Exported? (checkbox) · Include in next order (checkbox) ·
Electrical BENBuys / Mechanical BENBuys (boolean formulas on the product link's domain) · Sanitized
Description (CSV) (formula) · Order Batch (text) · Run ID (text) · Procurement Status (select) ·
Last Email Update (date) · Point of contact (people) · Notes (internal) (text) · Link to product
webpage (url) · Vendor (text) · Arrived? (status) · Submitted at (date).
"""
from __future__ import annotations

import dataclasses
import re
import threading
from dataclasses import dataclass, field
from typing import Any, ClassVar

from core.abc import NotionModel
from core.database import Database, Properties
from core.notion import Notion, NotionUser, same_id

__all__ = ['Col', 'PACK_NOTE_RE', 'PurchasingRow', 'normalize_part_number', 'Purchasing']


class Col:
    """Purchasing column names."""

    NAME = 'Name'
    PART = 'Cat. or model no.'
    QTY = 'Quant.'
    UNIT_COST = 'Unit cost'
    LINK = 'Link to product webpage'
    CONTACT = 'Point of contact'
    NOTES = 'Notes (internal)'
    SEASON = 'Season'
    EXPORTED = 'Exported?'
    SUBSYSTEM = 'Subsystem'
    ORDER_BATCH = 'Order Batch'
    SANITIZED = 'Sanitized Description (CSV)'
    READY = 'PEFS Ready?'
    INCLUDE_NEXT = 'Include in next order'
    PAYMENT = 'Payment Method'
    RUN_ID = 'Run ID'
    PROCUREMENT = 'Procurement Status'
    LAST_EMAIL = 'Last Email Update'
    VENDOR = 'Vendor'
    ARRIVED = 'Arrived?'
    SUBMITTED_AT = 'Submitted at'


# Pack listings are written as Quant. = packs and Unit cost = price per pack, with "Sold in packs
# of N" in the notes.
PACK_NOTE_RE = re.compile(r'Sold in packs of (\d+)')


@dataclass(eq=False)
class PurchasingRow(NotionModel):
    """One Purchasing row. Compared by identity (eq=False), like the JS objects it replaces."""

    id: str
    url: str
    name: str
    # `Cat. or model no.` exactly as typed.
    part_number: str
    quantity: float
    unit_cost: float
    subsystems: list[str]
    # Point of contact names (see `contacts` for the people).
    point_of_contact: list[str]
    order_batch: str
    link: str
    # `Sanitized Description (CSV)`: vendor notes with newlines and commas stripped.
    sanitized_description: str
    notes: str
    # `PEFS Ready?` formula text: `✅ Ready` or `❌ Missing fields`.
    readiness: str
    include_in_next_order: bool
    contacts: list[NotionUser] = field(default_factory=list)
    season: str = ''
    # `Exported?`: the row went out on an order.
    exported: bool = False
    vendor: str = ''
    run_id: str = ''
    # `Arrived?` status name: No / Ready for Pickup / Yes.
    arrived: str = ''
    # `Submitted at`: when the request was filed (internal lead-time start).
    submitted_at: str | None = None
    # `Last Email Update`: when the order went out (vendor lead-time start).
    ordered_at: str | None = None
    # The data source the page lives in ('' when unknown).
    parent_ds: str = ''

    def replace(self, **changes: Any) -> 'PurchasingRow':
        return dataclasses.replace(self, **changes)

    @property
    def pack_size(self) -> int:
        m = PACK_NOTE_RE.search(self.notes)
        return int(m.group(1)) if m else 1

    @property
    def units(self) -> int | float:
        """Quant. in single units (packs × pack size)."""
        u = self.quantity * self.pack_size
        return int(u) if float(u).is_integer() else u

    @property
    def unit_price(self) -> float:
        """Unit cost per single unit."""
        return self.unit_cost / self.pack_size

    @classmethod
    def _parse(cls, page: Any) -> 'PurchasingRow':
        p = Properties(page)
        sanitized = p.formula(Col.SANITIZED)
        readiness = p.formula(Col.READY)
        people = (p.raw(Col.CONTACT) or {}).get('people') or []
        return cls(
            id=page['id'],
            url=page.get('url') or '',
            name=p.title(),
            part_number=p.text(Col.PART),
            quantity=p.number(Col.QTY) or 0,
            unit_cost=p.number(Col.UNIT_COST) or 0,
            subsystems=p.multi_select(Col.SUBSYSTEM),
            point_of_contact=[u.get('name') for u in people if u.get('name')],
            order_batch=p.text(Col.ORDER_BATCH),
            link=p.url(Col.LINK),
            sanitized_description=str(sanitized if sanitized is not None else '').strip(),
            notes=p.text(Col.NOTES),
            readiness=str(readiness if readiness is not None else ''),
            include_in_next_order=p.checkbox(Col.INCLUDE_NEXT),
            contacts=[NotionUser(u.get('id') or '', u.get('name') or '', (u.get('person') or {}).get('email')) for u in people],
            season=p.select(Col.SEASON),
            exported=p.checkbox(Col.EXPORTED),
            vendor=p.text(Col.VENDOR),
            run_id=p.text(Col.RUN_ID),
            arrived=p.status(Col.ARRIVED),
            submitted_at=p.date(Col.SUBMITTED_AT),
            ordered_at=p.date(Col.LAST_EMAIL),
            parent_ds=((page or {}).get('parent') or {}).get('data_source_id') or '',
        )


def normalize_part_number(raw: str) -> str:
    """Trim, collapse internal whitespace/newlines, uppercase: how the punchout keys parts."""
    return re.sub(r'\s+', '', raw).upper()


class Purchasing(Database[PurchasingRow]):
    """The Purchasing data source. `rows()` / `row()` return bound `PurchasingRow`s."""

    model = PurchasingRow
    _shared: ClassVar['Purchasing | None'] = None
    _lock: ClassVar[threading.Lock] = threading.Lock()

    @classmethod
    def shared(cls) -> 'Purchasing':
        with cls._lock:
            if cls._shared is None:
                from core.config import config

                cls._shared = cls(Notion.shared(), config.benbuys.purchasing_data_source_id, config.benbuys.season)
            return cls._shared

    def __init__(self, notion: Notion, data_source_id: str, season: str):
        super().__init__(notion, data_source_id)
        self.season = season

    @property
    def notion(self) -> Notion:
        return self.client

    def rows(self, filter: Any = None, sorts: list[Any] | None = None, limit: int | None = None) -> list[PurchasingRow]:
        return self.query(filter, sorts, limit)

    def row(self, page_id: str) -> PurchasingRow:
        return self.get(page_id)

    def season_filter(self) -> dict[str, Any]:
        return {'property': Col.SEASON, 'select': {'equals': self.season}}

    def is_purchasing(self, row: PurchasingRow) -> bool:
        """False only when the page is known to live in another data source."""
        return not row.parent_ds or same_id(row.parent_ds, self.data_source_id)

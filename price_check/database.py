"""The Notion data the price check reads and writes.

  PurchasingPrices  the Purchasing (PEFS) database, as the price check sees it: which rows are
                    open to check, and the Unit cost writes a click makes
  CheckQueue        the queue of rows to check, in the ⚙️ Job Log
  SavingsLedger     💸 Price Check Savings: one row per alert, updated by every click

The queue: a queued row is a Job Log entry "price-check-queue <page id>" with Job =
price-check-queue. Once checked, Job becomes price-check-done and the entry stays as the "already
seen" record, so a row is queued once, ever, however often it's edited.

The ledger: the checker writes a Pending row when it DMs an alert; a tap on Use / Keep / Undo
updates it, and a sweep marks a Used row Realized once the Purchasing row is ordered (Exported?)
at that price. A click on an alert that wasn't logged creates the row then.
  Saved $      (Old − Used unit cost) × Quant. on a Used row, else 0. Negative = a price
               increase accepted, i.e. a budget correction, reported apart from savings.
  Potential $  (Old − Offered unit cost) × Quant. at alert time: what the alert could save.
Prices are in the row's own units (per pack on pack rows) and Quant. counts those units, so both
totals are plain dollars. A ledger row is matched by Row ID + Old unit cost + Quant.: the same
fields the checker's one-alert-per-(row, price, quantity) Job Log key uses.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable

from core import utils
from core.config import PriceCheckConfig, config
from core.database import (
    Database,
    Properties,
    date_value,
    rich_text_value,
    select_value,
    title_value,
)
from core.job_log import JobLog
from core.notion import Notion, dashed_id
from core.purchasing import Col, Purchasing, PurchasingRow
from price_check.enums import Direction, Outcome
from price_check.models import (
    Finding,
    LedgerEvent,
    LedgerRow,
    PriceRow,
    RowPatch,
    SwapValue,
)
from price_check.views import HTTP_URL_RE, PriceAlert

logger = logging.getLogger(__name__)

__all__ = ['PurchasingPrices', 'CheckQueue', 'SavingsLedger', 'alert_row_props', 'click_row_props']


class PurchasingPrices(Purchasing):
    """The Purchasing database, narrowed to the price check's rows and writes."""

    def __init__(self, notion: Notion, cfg: PriceCheckConfig):
        super().__init__(notion, cfg.purchasing_data_source_id, cfg.season)
        self.cfg = cfg

    def open_filter(self) -> list[dict[str, Any]]:
        """This season's not-yet-ordered rows with enough filled in to price-check."""
        return [
            {'property': Col.SEASON, 'select': {'equals': self.season}},
            {'property': Col.EXPORTED, 'checkbox': {'equals': False}},
            {'property': Col.PART, 'rich_text': {'is_not_empty': True}},
            {'property': Col.QTY, 'number': {'greater_than': 0}},
            {'property': Col.UNIT_COST, 'number': {'greater_than': 0}},
        ]

    def open_rows(self, limit: int | None = None) -> list[PurchasingRow]:
        """Every open row (oldest first), for a manual sweep."""
        return self.query({'and': self.open_filter()}, [{'timestamp': 'created_time', 'direction': 'ascending'}], limit)

    def edited_since(self, since: datetime) -> list[Any]:
        """Open rows' pages edited since `since`, oldest edit first."""
        return self.pages(
            {'and': self.open_filter() + [{'timestamp': 'last_edited_time', 'last_edited_time': {'on_or_after': utils.to_iso(since)}}]},
            [{'timestamp': 'last_edited_time', 'direction': 'ascending'}],
        )

    def skip_reason(self, row: PurchasingRow) -> str | None:
        """Why this row isn't price-checked (not Purchasing, ordered, other season, incomplete), or
        None if it should be."""
        if not self.is_purchasing(row):
            return 'not a Purchasing row'
        if row.exported:
            return 'already ordered (Exported?)'
        if row.season != self.season:
            return f"season {row.season or 'empty'}, not {self.season}"
        if not (row.part_number and row.quantity > 0 and row.unit_cost > 0):
            return 'part number, Quant. or Unit cost missing'
        return None

    def price_row(self, page_id: str) -> PriceRow:
        """The row as a click sees it."""
        return PriceRow.from_page(self.client.pages.retrieve(page_id), db=self)

    def write_price(self, page_id: str, patch: RowPatch) -> None:
        props = patch.props()
        self.client.pages.update(page_id, properties=props)
        logger.info(f"Price check: row {page_id} → Unit cost {patch.unit_cost}{', link updated' if Col.LINK in props else ''}.")


class CheckQueue:
    """Rows waiting to be checked, oldest first."""

    JOB = 'price-check-queue'
    DONE_JOB = 'price-check-done'

    def __init__(self, notion: Notion, cfg: PriceCheckConfig):
        self.notion, self.cfg = notion, cfg
        self.log = JobLog(notion, cfg.job_log_data_source_id)
        self.purchasing = PurchasingPrices(notion, cfg)

    @classmethod
    def key(cls, page_id: str) -> str:
        return f'{cls.JOB} {page_id}'

    def enqueue(self, page_id: str, dry_run: bool = False) -> bool:
        """Queue a row (no-op if it was ever queued). True if newly queued (dry run: would be)."""
        return self.log.claim_once(self.key(page_id), self.JOB, dry_run=dry_run)

    def mark_done(self, entry_id: str) -> None:
        """Mark a queue entry checked; it stays in the Job Log so the row isn't queued again."""
        self.log.set_job(entry_id, self.DONE_JOB)

    def entries(self, limit: int | None = None) -> list[tuple[str, str]]:
        """Queued rows, oldest first: [(Job Log entry id, Purchasing page id)]."""
        out = []
        for e in self.log.entries(self.JOB, limit):
            key = Properties(e).text('Run key')
            if key.startswith(self.JOB + ' '):
                out.append((e['id'], key[len(self.JOB) + 1 :].strip()))
        return out

    def queue_new_rows(self, since: datetime, settled_before: datetime | None = None, dry_run: bool = False) -> list[str]:
        """Queue this season's open, complete rows edited since `since` that were never queued,
        skipping rows edited after `settled_before` (still being typed in). Returns the page ids
        newly queued (dry run: the ones that would be)."""
        return [
            pg['id']
            for pg in self.purchasing.edited_since(since)
            if (settled_before is None or utils.parse_iso(pg.get('last_edited_time') or '') <= settled_before)
            and self.enqueue(pg['id'], dry_run)
        ]


# --- 💸 Price Check Savings ----------------------------------------------------------------------


def alert_row_props(f: Finding, now: datetime | None = None) -> dict[str, Any]:
    """Properties of the Pending ledger row for an alert that was just sent."""
    row = f.row
    n, supplier, listing = PriceAlert(f).offered()
    props: dict[str, Any] = {
        'Name': title_value(f'{row.name or row.part_number} ×{row.quantity}'),
        'Outcome': Outcome.PENDING.prop(),
        'Direction': (Direction.DROP if n < row.unit_cost else Direction.RISE).prop(),
        'Old unit cost': {'number': row.unit_cost},
        'Offered unit cost': {'number': n},
        'Quant.': {'number': row.quantity},
        'Potential $': {'number': utils.round2((row.unit_cost - n) * row.quantity)},
        'Supplier': rich_text_value(supplier),
        'Part': rich_text_value(row.part_number),
        'Row ID': rich_text_value(row.id),
        'Alert sent': date_value(now or datetime.now(timezone.utc)),
    }
    if row.url:
        props['Purchasing row'] = {'url': row.url}
    if listing and HTTP_URL_RE.match(listing):
        props['Listing'] = {'url': listing}
    if row.season:
        props['Season'] = select_value(row.season)
    return props

def click_row_props(v: SwapValue, row: PriceRow) -> dict[str, Any]:
    """Properties for a ledger row a click has to create (the alert wasn't logged when sent)."""
    label = row.name or row.part or 'Purchasing row'
    props: dict[str, Any] = {
        'Name': title_value(f'{label} ×{utils.js_number(v.qty)}'),
        'Outcome': Outcome.PENDING.prop(),
        'Old unit cost': {'number': v.old},
        'Quant.': {'number': v.qty},
        'Row ID': rich_text_value(dashed_id(v.row_id)),
        'Part': rich_text_value(row.part or ''),
        'Supplier': rich_text_value(v.supplier),
    }
    if row.url:
        props['Purchasing row'] = {'url': row.url}
    if row.season:
        props['Season'] = select_value(row.season)
    if v.new is not None:
        props['Offered unit cost'] = {'number': v.new}
        props['Potential $'] = {'number': v.saved}
        props['Direction'] = (Direction.DROP if v.new < v.old else Direction.RISE).prop()
    if v.link:
        props['Listing'] = {'url': v.link}
    return props


class SavingsLedger(Database[LedgerRow]):
    model = LedgerRow

    def __init__(self, client: Notion | None = None, data_source_id: str | None = None):
        super().__init__(
            client or Notion.shared(),
            config.price_check.ledger_data_source_id if data_source_id is None else data_source_id,
        )

    # --- reads and writes ------------------------------------------------------------------------

    def log_alert(self, f: Finding, now: datetime | None = None) -> bool:
        """Log a sent alert as Pending. Never raises: a missed row only costs a statistic (the
        first click on the alert creates it anyway)."""
        if not self.enabled:
            return False
        try:
            self.create(alert_row_props(f, now))
            return True
        except Exception as err:
            logger.warning(f"Price check ledger: couldn't log the alert for {f.row.id}", exc_info=err)
            return False

    def find(self, v: SwapValue) -> Any | None:
        """The alert's ledger page (newest if a row somehow has two), or None."""
        pages = self.pages(
            {
                'and': [
                    {'property': 'Row ID', 'rich_text': {'equals': dashed_id(v.row_id)}},
                    {'property': 'Old unit cost', 'number': {'equals': v.old}},
                    {'property': 'Quant.', 'number': {'equals': v.qty}},
                ]
            },
            limit=5,
            page_size=5,
        )
        pages.sort(key=lambda p: utils.parse_iso(p.get('created_time') or '1970-01-01'), reverse=True)
        return pages[0] if pages else None

    def record(self, e: LedgerEvent, who: str, fetch_row: Callable[[str], PriceRow]) -> str:
        """Write a click: update the alert's row, creating it first when the alert wasn't logged.
        Test alerts (`x`) are skipped. Returns what happened, for the log."""
        if not self.enabled:
            return 'ledger off'
        if e.value.test:
            return 'test alert, not logged'
        page = self.find(e.value)
        current = LedgerRow.from_page(page).outcome if page else None
        props = e.props(who, current)
        if not props:
            return f'kept {current}'
        if not page:
            page = self.create(click_row_props(e.value, fetch_row(e.value.row_id)))
        self.update(page['id'], props)
        return f"{current or 'new'} → {e.kind}"

    def rows(self) -> list[LedgerRow]:
        return self.query()

    def sweep_realized(self, fetch_row: Callable[[str], PriceRow], now: datetime | None = None) -> int:
        """Mark Used rows Realized once their Purchasing row is ordered (Exported?) with Unit cost
        still at the price that was used. Returns how many were marked."""
        if not self.enabled:
            return 0
        when = now or datetime.now(timezone.utc)
        open_rows = self.pages(
            {'and': [{'property': 'Outcome', 'select': {'equals': Outcome.USED}}, {'property': 'Realized', 'checkbox': {'equals': False}}]}
        )
        marked = 0
        for page in open_rows:
            p = Properties(page)
            row_id = p.text('Row ID')
            used = p.number('Used unit cost')
            if not row_id or used is None:
                continue
            try:
                row = fetch_row(row_id)
                if row.deleted or not row.exported or row.unit_cost is None or abs(row.unit_cost - used) > 1e-6:
                    continue
                self.update(page['id'], {'Realized': {'checkbox': True}, 'Ordered at': date_value(when)})
                marked += 1
            except Exception as err:
                logger.warning(f"Price check ledger: couldn't check row {row_id} for Realized", exc_info=err)
        return marked

"""Notion access for the Purchasing (PEFS) database — the source of truth for BenBuys orders. Reads
select the vendor's ready, un-exported rows for `prep`; the writer marks the rows from the last
`prep` as ordered after `done`.

Relevant schema (confirmed 2026-09-15): Name (title) · Cat. or model no. (text) · Quant. (number) ·
Unit cost (number) · Season (select) · Payment Method (select: PEFS/PCard/BenBuys) · PEFS Ready?
(formula → "✅ Ready" | "❌ Missing fields") · Exported? (checkbox) · Include in next order
(checkbox) · Electrical BENBuys / Mechanical BENBuys (boolean formulas on the product link's
domain) · Sanitized Description (CSV) (formula) · Order Batch (text) · Run ID (text) · Procurement
Status (select: Submitted) · Last Email Update (date).
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from benbuys.models import VendorAdapter
from core import utils
from core.config import config
from core.notion import Notion
from core.purchasing import PurchasingRow

logger = logging.getLogger(__name__)

__all__ = ['READY_VALUE', 'RowSelection', 'WriteBackResult', 'PurchasingNotion']

READY_VALUE = '✅ Ready'


@dataclass
class RowSelection:
    ready: list[PurchasingRow]
    not_ready: list[PurchasingRow]


@dataclass
class WriteBackResult:
    updated: list[str] = field(default_factory=list)
    failed: list[tuple[str, str]] = field(default_factory=list)  # (id, error)


def _base_filter(adapter: VendorAdapter) -> list[dict[str, Any]]:
    return [
        {'property': 'Season', 'select': {'equals': config.benbuys.season}},
        {'property': 'Payment Method', 'select': {'equals': 'BenBuys'}},
        {'property': 'Exported?', 'checkbox': {'equals': False}},
        {'property': adapter.match_formula, 'formula': {'checkbox': {'equals': True}}},
    ]


class PurchasingNotion:
    def __init__(self, token: str | None = None, data_source_id: str | None = None):
        self.client = Notion(token, config.notion.api_version) if token else Notion.shared()
        self.data_source_id = data_source_id or config.benbuys.purchasing_data_source_id

    def _query_all(self, filter: Any) -> list[PurchasingRow]:
        rows: list[PurchasingRow] = []
        cursor: str | None = None
        while True:
            response = self.client.data_sources.query(
                data_source_id=self.data_source_id,
                filter=filter,
                sorts=[
                    {'property': 'Order Batch', 'direction': 'ascending'},
                    {'property': 'Subsystem', 'direction': 'ascending'},
                ],
                page_size=100,
                start_cursor=cursor,
            )
            rows.extend(PurchasingRow.from_page(page) for page in response.get('results') or [])
            cursor = response.get('next_cursor') if response.get('has_more') else None
            if not cursor:
                return rows

    def select_rows(self, adapter: VendorAdapter) -> RowSelection:
        """The vendor's un-exported BenBuys rows for the season, split by `PEFS Ready?`. Two queries
        (with / without the readiness clause) diffed by id, so the "fix in Notion" list comes from
        the same formula the PEFS - Ready Export view uses."""
        base = _base_filter(adapter)
        with ThreadPoolExecutor(max_workers=2) as pool:
            ready_f = pool.submit(
                self._query_all,
                {'and': [*base, {'property': 'PEFS Ready?', 'formula': {'string': {'equals': READY_VALUE}}}]},
            )
            all_f = pool.submit(self._query_all, {'and': base})
            ready, every = ready_f.result(), all_f.result()
        ready_ids = {r.id for r in ready}
        not_ready = [r for r in every if r.id not in ready_ids]
        logger.info(f'BenBuys {adapter.key}: {len(ready)} ready, {len(not_ready)} not ready.')
        return RowSelection(ready, not_ready)

    def run_id_exists(self, run_id: str) -> bool:
        """True when any row already carries this Run ID (guards a double `done`)."""
        response = self.client.data_sources.query(
            data_source_id=self.data_source_id,
            filter={'property': 'Run ID', 'rich_text': {'equals': run_id}},
            page_size=1,
        )
        return bool(response.get('results'))

    def mark_ordered(self, page_ids: list[str], run_id: str, now: datetime | None = None) -> WriteBackResult:
        """Mark the cached rows ordered. Sequential so one failure never hides the others. Also
        clears `Include in next order` — the tick is consumed by the order it selected, so a stale
        tick can never pull an already-ordered row into a later prep."""
        when = utils.to_iso(now or datetime.now(timezone.utc))
        result = WriteBackResult()
        for id_ in page_ids:
            try:
                self.client.pages.update(
                    id_,
                    properties={
                        'Exported?': {'checkbox': True},
                        'Include in next order': {'checkbox': False},
                        'Run ID': {'rich_text': [{'text': {'content': run_id}}]},
                        'Procurement Status': {'select': {'name': 'Submitted'}},
                        'Last Email Update': {'date': {'start': when}},
                    },
                )
                result.updated.append(id_)
            except Exception as err:
                logger.error(f'BenBuys write-back failed for {id_}', exc_info=err)
                result.failed.append((id_, str(err)))
        logger.info(f'BenBuys {run_id}: {len(result.updated)} rows marked ordered, {len(result.failed)} failed.')
        return result

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

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from ..config import config
from ..notion_api import NotionClient
from ..utils.clock import to_iso
from ..utils.logger import logger
from .models import PurchasingRow, VendorAdapter

READY_VALUE = '✅ Ready'


def _text(prop: Any) -> str:
    prop = prop or {}
    items = prop.get('rich_text') if prop.get('rich_text') is not None else prop.get('title') or []
    return ''.join((t or {}).get('plain_text') or '' for t in items).strip()


def _formula_value(prop: Any) -> Any:
    f = (prop or {}).get('formula')
    return f.get(f.get('type')) if f else None


def parse_purchasing_row(page: Any) -> PurchasingRow:
    p = (page or {}).get('properties') or {}
    sanitized = _formula_value(p.get('Sanitized Description (CSV)'))
    readiness = _formula_value(p.get('PEFS Ready?'))
    return PurchasingRow(
        id=page['id'],
        url=page.get('url') or '',
        name=_text(p.get('Name')),
        part_number=_text(p.get('Cat. or model no.')),
        quantity=(p.get('Quant.') or {}).get('number') or 0,
        unit_cost=(p.get('Unit cost') or {}).get('number') or 0,
        subsystems=[s.get('name') for s in (p.get('Subsystem') or {}).get('multi_select') or [] if s.get('name')],
        point_of_contact=[u.get('name') for u in (p.get('Point of contact') or {}).get('people') or [] if u.get('name')],
        order_batch=_text(p.get('Order Batch')),
        link=(p.get('Link to product webpage') or {}).get('url') or '',
        sanitized_description=str(sanitized if sanitized is not None else '').strip(),
        notes=_text(p.get('Notes (internal)')),
        readiness=str(readiness if readiness is not None else ''),
        include_in_next_order=bool((p.get('Include in next order') or {}).get('checkbox')),
    )


@dataclass
class RowSelection:
    ready: list[PurchasingRow]
    not_ready: list[PurchasingRow]


@dataclass
class WriteBackResult:
    updated: list[str] = field(default_factory=list)
    failed: list[tuple[str, str]] = field(default_factory=list)  # (id, error)


class PurchasingNotion:
    def __init__(self, token: str | None = None, data_source_id: str | None = None):
        self.client = NotionClient(auth=token or config.notion.token, notion_version=config.notion.api_version)
        self.data_source_id = data_source_id or config.benbuys.purchasing_data_source_id

    @staticmethod
    def _base_filter(adapter: VendorAdapter) -> list[dict[str, Any]]:
        return [
            {'property': 'Season', 'select': {'equals': config.benbuys.season}},
            {'property': 'Payment Method', 'select': {'equals': 'BenBuys'}},
            {'property': 'Exported?', 'checkbox': {'equals': False}},
            {'property': adapter.match_formula, 'formula': {'checkbox': {'equals': True}}},
        ]

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
            rows.extend(parse_purchasing_row(page) for page in response.get('results') or [])
            cursor = response.get('next_cursor') if response.get('has_more') else None
            if not cursor:
                return rows

    def select_rows(self, adapter: VendorAdapter) -> RowSelection:
        """The vendor's un-exported BenBuys rows for the season, split by `PEFS Ready?`. Two queries
        (with / without the readiness clause) diffed by id, so the "fix in Notion" list comes from
        the same formula the PEFS - Ready Export view uses."""
        base = self._base_filter(adapter)
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
        when = to_iso(now or datetime.now(timezone.utc))
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
                logger.error(f'BenBuys write-back failed for {id_}', err)
                result.failed.append((id_, str(err)))
        logger.info(f'BenBuys {run_id}: {len(result.updated)} rows marked ordered, {len(result.failed)} failed.')
        return result

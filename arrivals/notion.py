"""Purchasing (PEFS) access for package arrivals. Reads open rows (`Arrived?` ≠ Yes) for the season;
the only writes are `mark_arrived` (and its `unmark_arrived` undo), touching ONLY the arrival columns:

  Arrived? (status: No / Ready for Pickup / Yes) — exists today; 256 of 257 REV12 rows read "No"
  Arrived at (date) · Received by (person or text) · Arrival photo (url) — Week-0 columns

The three Week-0 columns are optional: the schema is read once and a column that doesn't exist yet
is skipped (with a warning), so arrivals work before anyone adds them. `Received by` as a Text
column gets the receiver's name instead of a person — a person property pings them in Notion on
every package they bring in (10/19), which buries the @s that matter.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Any

from core.config import config
from core.notion import Notion, NotionUser
from core.purchasing import PurchasingRow

logger = logging.getLogger(__name__)

__all__ = ['ARRIVED_YES', 'OPTIONAL_COLUMNS', 'ArrivalWrite', 'ArrivalsNotion']

ARRIVED_YES = 'Yes'
OPTIONAL_COLUMNS = ('Arrived at', 'Received by', 'Arrival photo')




@dataclass
class ArrivalWrite:
    # When the photo was posted (ISO).
    arrived_at: str
    received_by_notion_id: str | None
    # Written instead of the person when `Received by` is a Text column.
    received_by_name: str | None
    photo_url: str | None


class ArrivalsNotion:
    def __init__(self, token: str | None = None, data_source_id: str | None = None):
        self.client = Notion(token, config.notion.api_version) if token else Notion.shared()
        self.data_source_id = data_source_id or config.benbuys.purchasing_data_source_id
        # Column name → Notion property type.
        self._columns: dict[str, str] | None = None
        self._columns_lock = threading.Lock()

    def _query_all(self, filter: Any) -> list[PurchasingRow]:
        rows: list[PurchasingRow] = []
        cursor: str | None = None
        while True:
            response = self.client.data_sources.query(
                data_source_id=self.data_source_id, filter=filter, page_size=100, start_cursor=cursor
            )
            rows.extend(PurchasingRow.from_page(page) for page in response.get('results') or [])
            cursor = response.get('next_cursor') if response.get('has_more') else None
            if not cursor:
                return rows

    def open_rows(self) -> list[PurchasingRow]:
        """This season's rows that haven't arrived — the candidates a slip can match."""
        return self._query_all(
            {
                'and': [
                    {'property': 'Season', 'select': {'equals': config.benbuys.season}},
                    {'property': 'Arrived?', 'status': {'does_not_equal': ARRIVED_YES}},
                ]
            }
        )

    def rows_for_run(self, run_id: str) -> list[PurchasingRow]:
        """Every row of one order (any arrival state), for "all arrived" at click time."""
        return self._query_all({'property': 'Run ID', 'rich_text': {'equals': run_id}})

    def fetch_row(self, page_id: str) -> PurchasingRow:
        return PurchasingRow.from_page(self.client.pages.retrieve(page_id))

    def _existing_columns(self) -> dict[str, str]:
        with self._columns_lock:
            if self._columns is None:
                # A failure raises and leaves the cache empty, so the next write retries.
                ds = self.client.data_sources.retrieve(self.data_source_id)
                names = {k: str((v or {}).get('type') or '') for k, v in (ds.get('properties') or {}).items()}
                missing = [c for c in OPTIONAL_COLUMNS if c not in names]
                if missing:
                    logger.warning(f"Arrivals: Purchasing DB has no {' / '.join(missing)} column yet; writing Arrived? only for those.")
                self._columns = names
            return self._columns

    def mark_arrived(self, page_id: str, write: ArrivalWrite) -> None:
        columns = self._existing_columns()
        properties: dict[str, Any] = {'Arrived?': {'status': {'name': ARRIVED_YES}}}
        if 'Arrived at' in columns:
            properties['Arrived at'] = {'date': {'start': write.arrived_at}}
        if columns.get('Received by') == 'rich_text' and write.received_by_name:
            properties['Received by'] = {'rich_text': [{'type': 'text', 'text': {'content': write.received_by_name[:100]}}]}
        elif columns.get('Received by') == 'people' and write.received_by_notion_id:
            properties['Received by'] = {'people': [{'id': write.received_by_notion_id}]}
        if 'Arrival photo' in columns and write.photo_url:
            properties['Arrival photo'] = {'url': write.photo_url}
        self.client.pages.update(page_id, properties=properties)

    def unmark_arrived(self, page_id: str, previous_status: str) -> None:
        """Undo `mark_arrived`: the status goes back to what it was and the arrival columns are cleared."""
        columns = self._existing_columns()
        properties: dict[str, Any] = {'Arrived?': {'status': {'name': previous_status or 'No'}}}
        if 'Arrived at' in columns:
            properties['Arrived at'] = {'date': None}
        if columns.get('Received by') == 'rich_text':
            properties['Received by'] = {'rich_text': []}
        elif columns.get('Received by') == 'people':
            properties['Received by'] = {'people': []}
        if 'Arrival photo' in columns:
            properties['Arrival photo'] = {'url': None}
        self.client.pages.update(page_id, properties=properties)

    def list_users(self) -> list[NotionUser]:
        """Workspace people (for Slack poster → Notion `Received by`)."""
        return Notion.list_users(self.client)

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

import dataclasses
import threading
from dataclasses import dataclass
from typing import Any

from benbuys.notion import parse_purchasing_row
from config import config
from notion_api import NotionClient
from sponsorship.models import NotionUser
from utils.logger import logger
from arrivals.models import ArrivalRow

ARRIVED_YES = 'Yes'
OPTIONAL_COLUMNS = ('Arrived at', 'Received by', 'Arrival photo')


def _text(prop: Any) -> str:
    prop = prop or {}
    items = prop.get('rich_text') if prop.get('rich_text') is not None else prop.get('title') or []
    return ''.join((t or {}).get('plain_text') or '' for t in items).strip()


def parse_arrival_row(page: Any) -> ArrivalRow:
    p = (page or {}).get('properties') or {}
    base = parse_purchasing_row(page)
    return ArrivalRow(
        **{f.name: getattr(base, f.name) for f in dataclasses.fields(base)},
        vendor=_text(p.get('Vendor')),
        run_id=_text(p.get('Run ID')),
        arrived=((p.get('Arrived?') or {}).get('status') or {}).get('name') or '',
        exported=bool((p.get('Exported?') or {}).get('checkbox')),
        submitted_at=((p.get('Submitted at') or {}).get('date') or {}).get('start'),
        ordered_at=((p.get('Last Email Update') or {}).get('date') or {}).get('start'),
    )


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
        self.client = NotionClient(auth=token or config.notion.token, notion_version=config.notion.api_version)
        self.data_source_id = data_source_id or config.benbuys.purchasing_data_source_id
        # Column name → Notion property type.
        self._columns: dict[str, str] | None = None
        self._columns_lock = threading.Lock()

    def _query_all(self, filter: Any) -> list[ArrivalRow]:
        rows: list[ArrivalRow] = []
        cursor: str | None = None
        while True:
            response = self.client.data_sources.query(
                data_source_id=self.data_source_id, filter=filter, page_size=100, start_cursor=cursor
            )
            rows.extend(parse_arrival_row(page) for page in response.get('results') or [])
            cursor = response.get('next_cursor') if response.get('has_more') else None
            if not cursor:
                return rows

    def open_rows(self) -> list[ArrivalRow]:
        """This season's rows that haven't arrived — the candidates a slip can match."""
        return self._query_all(
            {
                'and': [
                    {'property': 'Season', 'select': {'equals': config.benbuys.season}},
                    {'property': 'Arrived?', 'status': {'does_not_equal': ARRIVED_YES}},
                ]
            }
        )

    def rows_for_run(self, run_id: str) -> list[ArrivalRow]:
        """Every row of one order (any arrival state), for "all arrived" at click time."""
        return self._query_all({'property': 'Run ID', 'rich_text': {'equals': run_id}})

    def fetch_row(self, page_id: str) -> ArrivalRow:
        return parse_arrival_row(self.client.pages.retrieve(page_id))

    def _existing_columns(self) -> dict[str, str]:
        with self._columns_lock:
            if self._columns is None:
                # A failure raises and leaves the cache empty, so the next write retries.
                ds = self.client.data_sources.retrieve(self.data_source_id)
                names = {k: str((v or {}).get('type') or '') for k, v in (ds.get('properties') or {}).items()}
                missing = [c for c in OPTIONAL_COLUMNS if c not in names]
                if missing:
                    logger.warn(f"Arrivals: Purchasing DB has no {' / '.join(missing)} column yet; writing Arrived? only for those.")
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
        users: list[NotionUser] = []
        cursor: str | None = None
        while True:
            response = self.client.users.list(start_cursor=cursor, page_size=100)
            for user in response.get('results') or []:
                if user.get('type') == 'bot' or not user.get('id'):
                    continue
                users.append(NotionUser(user['id'], user.get('name') or '', (user.get('person') or {}).get('email')))
            cursor = response.get('next_cursor') if response.get('has_more') else None
            if not cursor:
                return users

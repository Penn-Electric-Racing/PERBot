"""Notion access for the Ops Tasks database (child of "REV12 Operations"). Reads feed the Sunday
digest; the small writers below back the digest's Slack buttons (Done / In progress / Push a
week) so members can update from Slack instead of opening Notion. One row = one action item a
member typed under their own name on a Saturday meeting page. Schema: Task (title) · Owner
(person) · Status (Not started / In progress / Done) · Due (date, convention = next Saturday) ·
Meeting (relation → Ops Meetings row; the meeting page's "This week" table is `Meeting contains
this page`, its "Carried over" table is `Status ≠ Done AND Meeting does not contain this page`)
· Week (legacy date) · Created. Only Status matters for "open": anything not Done is open. A
task with NO Meeting never appears in any "This week" table and looks carried on every page, so
the Slack writers link it (see `meeting_for_date`) and the digest relinks stragglers.
"""
from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Any, Literal

from ..config import config
from ..notion_api import NotionClient
from ..sponsorship.models import NotionUser
from ..utils.logger import logger
from .meetings import OpsMeeting, pick_meeting

OpsTaskOwner = NotionUser


@dataclass
class OpsTask:
    id: str
    url: str
    title: str
    status: str
    # YYYY-MM-DD or None when the member left Due blank.
    due: str | None
    # YYYY-MM-DD the task was assigned at. Prefers the "Meeting date" rollup (from the Meeting
    # relation set automatically inside a meeting page), then the legacy hand-set Week date, then
    # the row's Created time — so carried-week counts never go blank.
    week: str | None
    owners: list[OpsTaskOwner] = field(default_factory=list)
    # Ops Meetings row ids in the Meeting relation (empty = not linked to any meeting page).
    meeting_ids: list[str] = field(default_factory=list)

    def replace(self, **changes: Any) -> 'OpsTask':
        return dataclasses.replace(self, **changes)


def _read_title(prop: Any) -> str:
    return ''.join((t or {}).get('plain_text') or '' for t in (prop or {}).get('title') or []).strip()


def _read_date(prop: Any) -> str | None:
    start = ((prop or {}).get('date') or {}).get('start')
    return start[:10] if isinstance(start, str) else None


def _read_rollup_date(prop: Any) -> str | None:
    """A date rollup ("show original") arrives as rollup.date or rollup.array[0].date."""
    r = (prop or {}).get('rollup')
    if not r:
        return None
    if r.get('type') == 'date':
        return _read_date(r)
    if r.get('type') == 'array':
        for item in r.get('array') or []:
            d = _read_date(item)
            if d:
                return d
    return None


def _read_created(page: Any) -> str | None:
    t = (page or {}).get('created_time')
    return t[:10] if isinstance(t, str) else None


def _read_relation_ids(prop: Any) -> list[str]:
    return [r['id'] for r in (prop or {}).get('relation') or [] if isinstance((r or {}).get('id'), str)]


def _read_owners(prop: Any) -> list[OpsTaskOwner]:
    owners = []
    for p in (prop or {}).get('people') or []:
        if not isinstance((p or {}).get('id'), str):
            continue
        email = ((p.get('person') or {}).get('email'))
        owners.append(
            NotionUser(
                id=p['id'],
                name=p['name'] if isinstance(p.get('name'), str) else '',
                # Present when the integration has the "read user emails" capability (it does).
                email=email if isinstance(email, str) else None,
            )
        )
    return owners


def parse_ops_task(page: Any) -> OpsTask:
    p = page.get('properties') or {}
    return OpsTask(
        id=page['id'],
        url=page.get('url') or '',
        title=_read_title(p.get('Task')),
        status=(((p.get('Status') or {}).get('status')) or {}).get('name') or '',
        due=_read_date(p.get('Due')),
        week=_read_rollup_date(p.get('Meeting date')) or _read_date(p.get('Week')) or _read_created(page),
        owners=_read_owners(p.get('Owner')),
        meeting_ids=_read_relation_ids(p.get('Meeting')),
    )


def _parse_meeting(page: Any) -> OpsMeeting | None:
    d = _read_date(((page or {}).get('properties') or {}).get('Date'))
    return OpsMeeting(id=page['id'], date=d) if d else None


class OpsTasksNotion:
    def __init__(self, token: str | None = None):
        self.client = NotionClient(auth=token or config.notion.token, notion_version=config.notion.api_version)

    def query_open_tasks(self) -> list[OpsTask]:
        """Every row whose Status is not Done (paginated)."""
        tasks: list[OpsTask] = []
        cursor: str | None = None
        while True:
            response = self.client.data_sources.query(
                data_source_id=config.ops_tasks.data_source_id,
                filter={'property': 'Status', 'status': {'does_not_equal': 'Done'}},
                page_size=100,
                start_cursor=cursor,
            )
            tasks.extend(parse_ops_task(page) for page in response.get('results') or [])
            cursor = response.get('next_cursor') if response.get('has_more') else None
            if not cursor:
                return tasks

    def list_meetings(self) -> list[OpsMeeting]:
        """Every Ops Meetings row with a Date, oldest first (a handful of rows — no need to filter server-side)."""
        meetings: list[OpsMeeting] = []
        cursor: str | None = None
        while True:
            response = self.client.data_sources.query(
                data_source_id=config.ops_tasks.meetings_data_source_id,
                filter={'property': 'Date', 'date': {'is_not_empty': True}},
                sorts=[{'property': 'Date', 'direction': 'ascending'}],
                page_size=100,
                start_cursor=cursor,
            )
            for page in response.get('results') or []:
                m = _parse_meeting(page)
                if m:
                    meetings.append(m)
            cursor = response.get('next_cursor') if response.get('has_more') else None
            if not cursor:
                return meetings

    def meeting_for_date(self, anchor_iso: str) -> OpsMeeting | None:
        """The meeting page a task dated `anchor_iso` belongs to (see meetings.py), or None if that page doesn't exist yet."""
        return pick_meeting(self.list_meetings(), anchor_iso)

    def create_task(
        self, title: str, owner_ids: list[str], due_iso: str | None, meeting_id: str | None = None
    ) -> OpsTask:
        """Create a task (powers `/assign`): Status = Not started, Owner(s), optional Due, and the
        Meeting relation when the caller found the week's page (so it shows in that page's "This
        week" table instead of looking carried over)."""
        properties: dict[str, Any] = {
            'Task': {'title': [{'text': {'content': title[:200]}}]},
            'Owner': {'people': [{'id': i} for i in owner_ids]},
            'Status': {'status': {'name': 'Not started'}},
        }
        if due_iso:
            properties['Due'] = {'date': {'start': due_iso}}
        if meeting_id:
            properties['Meeting'] = {'relation': [{'id': meeting_id}]}
        page = self.client.pages.create(
            parent={'type': 'data_source_id', 'data_source_id': config.ops_tasks.data_source_id},
            properties=properties,
        )
        logger.info(
            f'Ops task created: "{title}" → {len(owner_ids)} owner(s), due {due_iso or "none"}, meeting {meeting_id or "none"}.'
        )
        return parse_ops_task(page)

    def fetch_task(self, page_id: str) -> OpsTask:
        """Re-read one task (button handlers do this before writing, so a stale DM can't clobber a newer edit)."""
        return parse_ops_task(self.client.pages.retrieve(page_id))

    def set_status(self, page_id: str, status: Literal['Not started', 'In progress', 'Done']) -> None:
        """Set Status (a Notion status property — options: Not started / In progress / Done)."""
        self.client.pages.update(page_id, properties={'Status': {'status': {'name': status}}})
        logger.info(f'Ops task {page_id} → Status {status}.')

    def link_meeting(self, task: OpsTask, meeting_id: str) -> None:
        """Add a meeting page to the task's Meeting relation (keeps existing links; no-op if already linked)."""
        if meeting_id in task.meeting_ids:
            return
        relation = [{'id': i} for i in [*task.meeting_ids, meeting_id]]
        self.client.pages.update(task.id, properties={'Meeting': {'relation': relation}})
        logger.info(f'Ops task {task.id} → linked to meeting {meeting_id}.')

    def set_due(self, page_id: str, due_iso: str) -> None:
        """Set the Due date (YYYY-MM-DD)."""
        self.client.pages.update(page_id, properties={'Due': {'date': {'start': due_iso}}})
        logger.info(f'Ops task {page_id} → Due {due_iso}.')

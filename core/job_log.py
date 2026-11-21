"""The ⚙️ PERBot Job Log in Notion: once-only records, for every feature. `JobLog.shared()`.

WHY: GitHub's cron on this repo fires LATE, routinely 2–4 hours (2026-09-12: the 14:00/15:00 UTC
quota-audit triggers ran at 16:43 and 17:43 UTC). Jobs therefore gate on `utils.is_slot_open`
(right weekday, slot hour has begun), which lets both DST triggers and stray extra fires through,
so each real run is claimed here and a second claim of the same key is refused. DM jobs can't read
their own DM history for a marker (no im:history), so this is their dedup.

`claim_once` is the same record keyed to a one-shot event instead of a day (a deal's win post, a
price alert, a queued row). Channel-history markers can't do that: a post that scrolls out of the
history page we read looks un-sent. A Notion record doesn't scroll.

Records are written BEFORE the caller sends, so a crash mid-send counts as sent rather than
"send it again": the safer failure for anything that posts to a channel or DMs people.
"""
from __future__ import annotations

import logging
import threading
from typing import Any, ClassVar

from core import utils
from core.notion import Notion

logger = logging.getLogger(__name__)

__all__ = ['JobLog']


class JobLog:
    _shared: ClassVar['JobLog | None'] = None
    _lock: ClassVar[threading.Lock] = threading.Lock()

    @classmethod
    def shared(cls) -> 'JobLog':
        with cls._lock:
            if cls._shared is None:
                from core.config import config

                cls._shared = cls(Notion.shared(), config.notion.job_log_data_source_id)
            return cls._shared

    def __init__(self, notion: Notion, data_source_id: str):
        self.notion, self.data_source_id = notion, data_source_id

    def find(self, key: str) -> Any | None:
        """The record for `key`, or None."""
        res = self.notion.data_sources.query(
            data_source_id=self.data_source_id, filter={'property': 'Run key', 'title': {'equals': key}}, page_size=1
        )
        return (res.get('results') or [None])[0]

    def claim_once(self, key: str, job: str, dry_run: bool = False) -> bool:
        """Claim `key` once and for all. True if this process is the first to claim it (go ahead),
        False if a record already exists (skip). `dry_run` checks without writing. Without a Job
        Log data source, returns True with a warning (no dedup)."""
        if not self.data_source_id:
            logger.warning(f'Job log: NOTION_JOB_LOG_DS_ID not set — cannot dedupe "{key}".')
            return True
        if self.find(key):
            logger.info(f'Job log: "{key}" already claimed — skipping.')
            return False
        if dry_run:
            return True
        self.notion.pages.create(
            parent={'type': 'data_source_id', 'data_source_id': self.data_source_id},
            properties={
                'Run key': {'title': [{'text': {'content': key}}]},
                'Job': {'rich_text': [{'text': {'content': job}}]},
                'Ran at': {'date': {'start': utils.iso_now()}},
            },
        )
        logger.info(f'Job log: claimed "{key}".')
        return True

    def claim_run(self, job: str, date_iso: str | None = None) -> bool:
        """Claim this job's run for today (ET). True if this process is the first (send); False
        if another cron fire already did the work (skip)."""
        return self.claim_once(f'{job} {date_iso or utils.now_et().date_iso}', job)

    def entries(self, job: str, limit: int | None = None) -> list[Any]:
        """Records whose Job is `job`, oldest first."""
        return Notion.query_all(
            self.notion,
            self.data_source_id,
            limit=limit,
            filter={'property': 'Job', 'rich_text': {'equals': job}},
            sorts=[{'property': 'Ran at', 'direction': 'ascending'}],
            page_size=min(limit or 100, 100),
        )

    def set_job(self, record_id: str, job: str) -> None:
        """Re-label a record (e.g. a queue entry once it's done); the record stays."""
        self.notion.pages.update(record_id, properties={'Job': {'rich_text': [{'text': {'content': job}}]}})

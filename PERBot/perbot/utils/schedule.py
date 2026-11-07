"""Scheduling helpers for the GitHub-Actions cron jobs.

WHY: GitHub's cron on this repo fires LATE — routinely 2–4 hours (2026-09-12: the
14:00/15:00 UTC quota-audit triggers ran at 16:43 and 17:43 UTC; the 13:00/14:00 digest
triggers ran at 15:55/16:37; the Wednesday stale DM at 17:04/17:22). Every job used an
exact-hour gate (`hour == 10`), so the late runs logged "skipping" and exited green —
nothing was sent for weeks. So:

 1. `is_slot_open_et` is late-tolerant: right weekday (ET) and the slot hour has BEGUN —
    a fire any time later that day still runs.
 2. Because that lets both DST cron triggers (and any stray extra fire) through,
    `claim_job_run` records each real run in the ⚙️ PERBot Job Log data source in Notion
    and refuses a second claim for the same key (job + ET date). DM jobs can't read
    their own DM history for a marker (no im:history), so this is their dedup.

`claim_once` is the same record, keyed to a one-shot event instead of a day — for things
announced exactly once ever (a deal's win post). Channel-history markers can't do that
job: they only look back as far as the history page we read, so a post that scrolls out
of that window looks un-sent and gets sent again. A Notion record doesn't scroll.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal
from zoneinfo import ZoneInfo

from ..config import config
from ..notion_api import NotionClient
from .clock import iso_now
from .logger import logger

ET = ZoneInfo('America/New_York')

WeekdayET = Literal['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']


@dataclass
class NowET:
    weekday: WeekdayET
    hour: int
    date_iso: str


def now_et(now: datetime | None = None) -> NowET:
    """Today's ET weekday + hour."""
    local = (now or datetime.now(timezone.utc)).astimezone(ET)
    return NowET(weekday=local.strftime('%A'), hour=local.hour, date_iso=local.strftime('%Y-%m-%d'))  # type: ignore[arg-type]


def is_slot_open_et(weekday: WeekdayET, hour: int, now: datetime | None = None) -> bool:
    """True when it's `weekday` in ET and the clock has reached `hour` (any later time that day counts)."""
    et = now_et(now)
    return et.weekday == weekday and et.hour >= hour


def claim_job_run(job: str, date_iso: str | None = None) -> bool:
    """Claim this job's run for today (ET). Returns True if this process is the first to do so
    (go ahead and send); False if a record already exists (another cron fire already did the
    work — skip)."""
    return claim_once(f'{job} {date_iso or now_et().date_iso}', job)


def claim_once(key: str, job: str) -> bool:
    """Claim `key` in the Job Log once and for all (no date in the key) — for events announced
    exactly once ever, like a deal's win post. Returns True if this process is the first to
    claim it, False if a record already exists (someone already did it — skip).

    Writes the record BEFORE the caller sends, so a crash mid-send is "sent" rather than
    "send it again" — the safer failure for anything that posts to a channel or DMs people.
    If the Job Log data source isn't configured, returns True with a warning (no dedup)."""
    ds_id = config.notion.job_log_data_source_id
    if not ds_id:
        logger.warn(f'Job log: NOTION_JOB_LOG_DS_ID not set — cannot dedupe "{key}".')
        return True
    client = NotionClient(auth=config.notion.token, notion_version=config.notion.api_version)
    existing = client.data_sources.query(
        data_source_id=ds_id,
        filter={'property': 'Run key', 'title': {'equals': key}},
        page_size=1,
    )
    if existing.get('results'):
        logger.info(f'Job log: "{key}" already claimed — skipping.')
        return False
    client.pages.create(
        parent={'type': 'data_source_id', 'data_source_id': ds_id},
        properties={
            'Run key': {'title': [{'text': {'content': key}}]},
            'Job': {'rich_text': [{'text': {'content': job}}]},
            'Ran at': {'date': {'start': iso_now()}},
        },
    )
    logger.info(f'Job log: claimed "{key}".')
    return True

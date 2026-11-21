"""The price check's background thread in the bot (started from app.py when PRICE_CHECK_ENABLED=true).

  1. Poll: every PRICE_CHECK_POLL_SECONDS, queue this season's open, complete Purchasing rows edited
     since the last look (CheckQueue.queue_new_rows). A row edited in the last
     PRICE_CHECK_SETTLE_SECONDS is left for the next poll, so a row typed in field by field is
     checked once it's done; Notion rounds last_edited_time down to the minute, hence a minute of
     slack on the settle check and the window. The first poll looks back PRICE_CHECK_LOOKBACK_HOURS,
     for rows added while the bot was down.
  2. Check: one row at a time, at most PRICE_CHECK_MAX_PER_HOUR an hour, with the LLM paced per
     minute on top (Checker.drain). If search or the LLM is failing, the row stays queued and the
     worker backs off 10 min, 20 min, ... up to 6 h.

The queue lives in the Job Log, so a restart loses nothing. No webhooks: the bot has no public URL
(Slack Socket Mode), and a row is only ever queued once, so polling sees every row they would.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from collections.abc import Awaitable
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from core.config import PriceCheckConfig, config
from core.notion import Notion
from core.slack import Slack
from price_check.checker import Checker, PriceFinder
from price_check.database import CheckQueue
from price_check.enums import CheckStatus
from price_check.scrapers import llm_reader

logger = logging.getLogger(__name__)

__all__ = ['HourlyLimit', 'Poller', 'Worker']

NOTION_MINUTE = 60  # last_edited_time granularity
WINDOW_SLACK = 180  # extra look-back per poll, so nothing falls between two polls
QUEUE_POLL_SECONDS = 300  # look at an empty queue at least this often
RETRY_BASE_SECONDS = 600  # back off 10 min, doubling...
RETRY_MAX_SECONDS = 6 * 3600  # ...up to 6 h


class HourlyLimit:
    """At most `per_hour` starts in any rolling hour."""

    def __init__(self, per_hour: int, clock: Callable[[], float] = time.time):
        self.per_hour, self.clock, self.starts = per_hour, clock, deque()

    def wait(self) -> float:
        """Seconds until another start is allowed (0 = now)."""
        now = self.clock()
        while self.starts and self.starts[0] <= now - 3600:
            self.starts.popleft()
        return 0 if len(self.starts) < self.per_hour else self.starts[0] + 3600 - now

    def record(self) -> None:
        self.starts.append(self.clock())


class Poller:
    """poll() queues settled, open, complete rows edited since the last poll; returns the page ids
    newly queued (dry run: the ones that would be, each once)."""

    def __init__(self, notion: Notion, cfg: PriceCheckConfig, clock: Callable[[], float] = time.time, dry_run: bool = False):
        self.notion, self.cfg, self.clock, self.dry_run = notion, cfg, clock, dry_run
        self.next_at = 0.0
        self.first = True
        self.seen: set[str] = set()

    def due(self) -> bool:
        return self.clock() >= self.next_at

    async def poll(self) -> list[str]:
        now = self.clock()
        cfg = self.cfg
        window = cfg.lookback_hours * 3600 if self.first else cfg.poll_seconds + cfg.settle_seconds + WINDOW_SLACK
        self.next_at = now + cfg.poll_seconds  # also after a failure: try again next interval
        found = await CheckQueue(self.notion, cfg).queue_new_rows(
            since=datetime.fromtimestamp(now, timezone.utc) - timedelta(seconds=window),
            settled_before=datetime.fromtimestamp(now - cfg.settle_seconds - NOTION_MINUTE, timezone.utc),
            dry_run=self.dry_run,
        )
        self.first = False
        new = [pid for pid in found if pid not in self.seen]
        if self.dry_run:
            self.seen.update(new)
        return new


class Worker:
    """Polls for new rows, then drains the Job Log queue one row at a time."""

    def __init__(
        self,
        cfg: PriceCheckConfig,
        notion: Notion,
        checker: Any,
        limit: HourlyLimit,
        poller: Poller | None = None,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        dry_run: bool = False,
    ):
        self.cfg, self.notion, self.checker, self.limit, self.poller = cfg, notion, checker, limit, poller
        self.clock, self.sleep, self.dry_run = clock, sleep, dry_run
        self.stopped = asyncio.Event()
        self.next_queue_look = 0.0
        self.backoff_until = 0.0
        self.failures = 0
        self.preview: list[str] = []  # dry run: rows that would have been queued...
        self.seen: set[str] = set()  # ...and rows already checked (nothing is marked done)

    async def poll(self) -> int:
        """Queue new rows the poller finds, when it's due. Returns how many were new."""
        if not (self.poller and self.poller.due()):
            return 0
        try:
            found = await self.poller.poll()
        except Exception as e:
            logger.warning(f'Price check: polling Purchasing failed ({e}); trying again next interval')
            return 0
        for pid in found:
            logger.info(f"Price check: {pid} {'would be ' if self.dry_run else ''}queued")
        if self.dry_run:
            self.preview += found
        if found:
            self.next_queue_look = 0.0
        return len(found)

    async def check_next(self) -> CheckStatus | None:
        """Check the oldest queued row if the hourly limit and any backoff allow. Returns its
        status, or None if nothing was done."""
        now = self.clock()
        if now < self.backoff_until or now < self.next_queue_look or self.limit.wait() > 0:
            return None
        entries: list[tuple[str | None, str]] = [
            e for e in await CheckQueue(self.notion, self.cfg).entries(len(self.seen) + 1) if e[1] not in self.seen
        ][:1]
        if not entries and self.preview:
            entries = [(None, self.preview.pop(0))]
        if entries and self.dry_run:
            self.seen.add(entries[0][1])
        if not entries:
            self.next_queue_look = now + QUEUE_POLL_SECONDS
            return None
        status = next(iter(await self.checker.drain(entries)))
        if status == CheckStatus.RETRY:
            self.failures += 1
            delay = min(RETRY_BASE_SECONDS * 2 ** (self.failures - 1), RETRY_MAX_SECONDS)
            self.backoff_until = now + delay
            logger.warning(f'Price check: check failed; trying again in {delay / 60:g} min')
        else:
            self.failures = 0
            if status not in (CheckStatus.SKIPPED, CheckStatus.GONE):
                self.limit.record()  # only real searches count against the limit
        return status

    async def step(self) -> CheckStatus | None:
        await self.poll()
        return await self.check_next()

    async def run(self) -> None:
        while not self.stopped.is_set():
            try:
                status = await self.step()
            except Exception as e:  # e.g. Notion down while reading the queue: keep the task
                logger.warning(f'Price check: worker step failed ({e}); trying again in 60 s')
                await self.sleep(60)
                continue
            if status is None:
                await self.sleep(2)

    @classmethod
    def from_config(cls, dry_run: bool = False, verbose: bool = False) -> 'Worker | None':
        """The bot's worker, or None if it can't run (logged); a misconfigured price check never
        stops the bot."""
        cfg = config.price_check
        try:
            finder = PriceFinder.from_config(cfg, verbose)
        except llm_reader.LLMError as e:
            logger.warning(f'Price check: not started: {e}')
            return None
        notion = Notion.shared()
        slack = None if dry_run else Slack.shared()
        checker = Checker(cfg, notion, slack, finder, dry_run, verbose)
        llm = finder.llm
        logger.info(
            f'Price check: polling Purchasing every {cfg.poll_seconds:g}s - settle {cfg.settle_seconds:g}s, '
            f"max {cfg.max_per_hour}/hour, LLM {llm.provider}/{llm.model}{' (dry run)' if dry_run else ''}"
        )
        return cls(cfg, notion, checker, HourlyLimit(cfg.max_per_hour), Poller(notion, cfg, dry_run=dry_run), dry_run=dry_run)

"""The price check itself: PriceFinder searches for a part, Checker checks a row (or the queue) and
sends the alert. check.py is the CLI that runs it (`python -m price_check.check`); its docstring
describes the check.
"""
from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Any

from slack_sdk.web.async_client import AsyncWebClient

from core import utils
from core.config import PriceCheckConfig
from core.job_log import JobLog
from core.notion import Notion, NotionAPIError, NotionUser
from core.purchasing import PurchasingRow
from core.slack import Indexed, Slack
from price_check.database import CheckQueue, PurchasingPrices, SavingsLedger
from price_check.enums import CheckStatus
from price_check.models import Finding
from price_check.scrapers import llm_reader
from price_check.types import ListingPayload
from price_check.views import PriceAlert

logger = logging.getLogger(__name__)

__all__ = ['make_llm', 'row_label', 'is_outage', 'PriceFinder', 'Checker']


logger = logging.getLogger(__name__)

def make_llm(cfg: PriceCheckConfig, provider: str | None = None, model: str | None = None, rpm: float = 15, verbose: bool = False) -> Any:
    """The LLM that reads product pages: OpenAI (PRICE_CHECK_MODEL) on the bot's OPENAI_API_KEY,
    never another provider the bot has keys for. `provider` overrides it for a manual run.
    Raises llm_reader.LLMError (e.g. "OPENAI_API_KEY not set")."""
    provider = provider or 'openai'
    return llm_reader.LLM(provider, model or (cfg.model if provider == 'openai' else None), rpm, verbose)

def row_label(row: PurchasingRow, i: int | None = None, n: int | None = None) -> str:
    prefix = f'[{i}/{n}] ' if i is not None else ''
    return f'{prefix}{row.part_number} x{row.units} @ ${utils.price(row.unit_price)}'

def is_outage(results: list[ListingPayload]) -> bool:
    """True when nothing got a price and the LLM failed on the pages: a quota / outage, not a
    part nobody sells, so the row should be tried again later."""
    return not any(r.get('subtotal') is not None for r in results) and any('llm:' in (r.get('fetch_error') or '') for r in results)

class PriceFinder:
    """`finder(row)` searches the part at the row's quantity, always reading its link. The link is
    read first: Cat. or model no. is often a description ("M3 screws"), so the manufacturer part
    number on the linked page is searched instead when it shows one."""

    def __init__(self, llm: Any, cfg: PriceCheckConfig, verbose: bool = False):
        self.llm, self.cfg, self.verbose = llm, cfg, verbose

    @classmethod
    def from_config(cls, cfg: PriceCheckConfig, verbose: bool = False, **llm_kw: Any) -> 'PriceFinder':
        return cls(make_llm(cfg, verbose=verbose, **llm_kw), cfg, verbose)

    async def __call__(self, row: PurchasingRow) -> list[ListingPayload]:
        term, read = row.part_number, []
        if row.link:
            link = await llm_reader.part_info(
                {'title': row.name or row.part_number, 'url': row.link, 'snippet': '', 'search_rank': 0}, self.llm, row.part_number
            )
            term, read = llm_reader.search_term(link) or row.part_number, [link]
            if self.verbose and term != row.part_number:
                logger.info(f'  link shows {term!r}; searching that, not {row.part_number!r}')
        return (await llm_reader.find(term, row.units, self.llm, pool=self.cfg.pool, read=read, verbose=self.verbose))[2]

class Checker:
    """check(row) returns a CheckStatus. `find(row)` returns scored listings (PriceFinder);
    `slack` is None in a dry run."""

    # A sweep stops after this many rows in a row got no price because search / the LLM was
    # failing (quota, outage), instead of running through every row for nothing.
    MAX_OUTAGE_ROWS = 3

    def __init__(
        self,
        cfg: PriceCheckConfig,
        notion: Notion,
        slack: AsyncWebClient | Slack | None,
        find: Any,
        dry_run: bool = False,
        verbose: bool = False,
        ledger: SavingsLedger | None = None,
    ):
        self.cfg, self.notion, self.slack, self.find = cfg, notion, slack, find
        self.dry_run, self.verbose = dry_run, verbose
        self.purchasing = PurchasingPrices(notion, cfg)
        self.queue = CheckQueue(notion, cfg)
        self.ledger = ledger or SavingsLedger(notion, cfg.ledger_data_source_id)
        self._emails: dict[str, str | None] | None = None
        self._directory: list[Indexed] | None = None

    def _debug(self, msg: str) -> None:
        if self.verbose:
            logger.info(msg)

    async def _notion_email(self, user_id: str) -> str | None:
        """People properties may omit emails; the workspace user list (fetched once) has them."""
        if self._emails is None:
            try:
                self._emails = {u.id: u.email for u in await Notion.list_users(self.notion)}
            except Exception as err:
                logger.warning(f'Price check: Notion users unavailable ({err}); matching by name.')
                self._emails = {}
        return self._emails.get(user_id)

    async def targets(self, row: PurchasingRow) -> list[str]:
        """Slack ids to DM: the row's contacts, else PRICE_CHECK_CHANNEL."""
        out: list[str] = []
        if self.slack is not None and row.contacts:
            slack = Slack.wrap(self.slack)
            if self._directory is None:
                self._directory = await slack.fetch_directory()
            for c in row.contacts:
                person = c if c.email else NotionUser(c.id, c.name, await self._notion_email(c.id))
                uid = await slack.notion_user_to_slack_id(person, self._directory)
                if uid:
                    out.append(uid)
        if not out and self.cfg.channel:
            out = [self.cfg.channel]
        return out

    async def check(self, row: PurchasingRow, label: str | None = None) -> CheckStatus:
        label = label or row_label(row)
        reason = self.purchasing.skip_reason(row)
        if reason:
            self._debug(f'{label}: skipped, {reason}')
            return CheckStatus.SKIPPED
        try:
            results = await self.find(row)
            failed = 'LLM failed on every page' if is_outage(results) else None
        except Exception as e:  # one bad row must not stop the rest
            failed = f'search failed: {e}'
        if failed:
            logger.warning(f'{label}: {failed}')
            return CheckStatus.RETRY
        f = Finding.compare(row, results, self.cfg)
        if f is None:
            self._debug(f'{label}: ok')
            return CheckStatus.OK
        return CheckStatus.ALERTED if await self._alert(f, label) else CheckStatus.OK

    async def _count(self, statuses: AsyncIterator[CheckStatus]) -> dict[str, int]:
        """Tally statuses, stopping after MAX_OUTAGE_ROWS retries in a row."""
        counts: dict[str, int] = {}
        outages = 0
        async for status in statuses:
            counts[status] = counts.get(status, 0) + 1
            outages = outages + 1 if status == CheckStatus.RETRY else 0
            if outages >= self.MAX_OUTAGE_ROWS:
                logger.warning(f'Price check: stopping, {outages} rows in a row failed (LLM quota or search outage?).')
                break
        return counts

    async def drain(self, entries: list[tuple[str | None, str]]) -> dict[str, int]:
        """Check queued rows [(Job Log entry id, page id)] in order. Entries are marked done once
        their row is checked, skipped or gone; failures stay queued. An entry id of None (a dry-run
        preview) is checked but not marked. Returns {status: count}."""

        async def statuses() -> AsyncIterator[CheckStatus]:
            for i, (entry, pid) in enumerate(entries, 1):
                try:
                    row = await self.purchasing.get(pid)
                except Exception as e:
                    gone = isinstance(e, NotionAPIError) and e.status == 404
                    logger.warning(f"[{i}/{len(entries)}] {pid}: {'row deleted' if gone else e}")
                    status = CheckStatus.GONE if gone else CheckStatus.RETRY
                else:
                    status = await self.check(row, row_label(row, i, len(entries)))
                if status != CheckStatus.RETRY and entry and not self.dry_run:
                    try:
                        await self.queue.mark_done(entry)
                    except Exception as e:
                        logger.warning(f"Price check: couldn't mark queue entry {entry} done: {e}")
                yield status

        return await self._count(statuses())

    async def check_all(self, rows: list[PurchasingRow]) -> dict[str, int]:
        """Sweep `rows` in order. Returns {status: count}."""

        async def statuses() -> AsyncIterator[CheckStatus]:
            for i, row in enumerate(rows, 1):
                yield await self.check(row, row_label(row, i, len(rows)))

        return await self._count(statuses())

    async def _alert(self, f: Finding, label: str) -> bool:
        """Claim the alert in the Job Log, then DM the row's contacts (or print it). False if it
        was already sent."""
        row, alert = f.row, PriceAlert(f)
        text = alert.text()
        key = f'price-alert {row.id} {row.unit_cost:g} x{row.quantity}'
        if not await JobLog(self.notion, self.cfg.job_log_data_source_id).claim_once(key, 'price-check', dry_run=self.dry_run):
            self._debug(f'{label}: {f.delta_pct:+.0f}%, already alerted')
            return False
        targets = await self.targets(row)
        logger.info(f"{label}: {f.delta_pct:+.0f}% -> {', '.join(targets) or 'nobody to DM'}")
        blocks = alert.blocks(text)
        if self.dry_run:
            buttons = [e for b in blocks[1:] for e in b['elements']]
            print(text + ('\n[' + ' | '.join(b['text']['text'] for b in buttons) + ']' if buttons else '') + '\n')
            return True
        if not targets:
            logger.warning(f'Price check: no Slack match for {[c.name for c in row.contacts]} and no PRICE_CHECK_CHANNEL - alert not sent:\n{text}')
        sent = False
        for t in targets:
            try:
                await self.slack.chat_postMessage(channel=t, text=text, blocks=blocks, unfurl_links=False)  # type: ignore[union-attr]
                sent = True
            except Exception as e:
                logger.warning(f'Price check: Slack post to {t} failed: {e}')
        if sent:
            await self.ledger.log_alert(f)
        return True

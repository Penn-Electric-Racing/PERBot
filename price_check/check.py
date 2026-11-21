"""Re-price open Purchasing (PEFS) rows and DM the orderer when a price moved.

Which rows: this season's rows that aren't ordered (Exported? unchecked) and have a part number,
quantity and unit cost (PurchasingPrices.skip_reason). The bot finds new ones by polling
(worker.py) and queues them in the Job Log (CheckQueue); Checker.drain checks the queue one row
at a time.

The check: the row's own product link is read first, and the manufacturer part number shown there
(else Cat. or model no.) is searched (PriceFinder: web search + Mouser/DigiKey APIs + OpenAI
reading the pages), and the unit price found at that quantity is compared with Unit cost:
  found price = the price at the row's own link if it could be read, else the best option
  alert when  |found - Unit cost| / Unit cost >= PRICE_CHECK_THRESHOLD_PCT
         and  |found - Unit cost| x Quant. >= PRICE_CHECK_MIN_DELTA_USD

The alert is a DM to the row's Point of contact (email, then an unambiguous name), else
PRICE_CHECK_CHANNEL. Each alert is claimed once in the Job Log as
"price-alert <row id> <unit cost> x<quant>", so a row alerts again only after its Unit cost or
Quant. changes. The DM's buttons are handled by views.PriceAlertView; the alert is logged in the
savings ledger.

Usage (settings: config.price_check):
    python -m price_check.check --queue -v              # one pass: queue new rows + check the queue
    python -m price_check.check --enqueue <notion url>  # queue a row by hand
    python -m price_check.check --row <notion url/id>   # check one row now
    python -m price_check.check --all --dry-run -v      # sweep every open row, print alerts only
"""
from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime, timedelta, timezone

from core.config import config
from core.log import setup_logging
from core.notion import Notion, page_id_from
from core.slack import Slack
from price_check.checker import Checker, PriceFinder

logger = logging.getLogger(__name__)
from price_check.database import CheckQueue
from price_check.scrapers import llm_reader


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog='python -m price_check.check', description='Price-check Purchasing rows and DM the orderer when the price moved.'
    )
    which = p.add_mutually_exclusive_group(required=True)
    which.add_argument('--queue', action='store_true', help='queue new rows, then check up to PRICE_CHECK_BATCH queued rows')
    which.add_argument('--enqueue', metavar='ROW', help='queue a Purchasing page (Notion URL or id)')
    which.add_argument('--row', help='check this Purchasing page now (Notion URL or id)')
    which.add_argument('--all', action='store_true', help='sweep every open row, oldest first')
    p.add_argument('--limit', type=int, help='at most N rows (--queue: default PRICE_CHECK_BATCH)')
    p.add_argument('--dry-run', action='store_true', help='print alerts instead of DMing; nothing written to Notion')
    p.add_argument('--provider', choices=list(llm_reader.PROVIDERS), help='LLM provider (default: openai)')
    p.add_argument('--model', help='LLM model id')
    p.add_argument('--rpm', type=float, default=15, help='max LLM requests per minute')
    p.add_argument('-v', '--verbose', action='store_true')
    return p


def _row_id(s: str) -> str:
    pid = page_id_from(s)
    if not pid:
        sys.exit(f'Not a Notion page URL or id: {s}')
    return pid


def main(argv: list[str] | None = None) -> None:
    a = parser().parse_args(argv)
    cfg = config.price_check
    notion = Notion.shared()
    queue = CheckQueue(notion, cfg)
    if a.enqueue:
        pid = _row_id(a.enqueue)
        logger.info(f"{pid}: {'queued' if queue.enqueue(pid) else 'already queued'}")
        return

    entries: list[tuple[str | None, str]] = []
    if a.queue:
        since = datetime.now(timezone.utc) - timedelta(hours=cfg.lookback_hours)
        found = queue.queue_new_rows(since, dry_run=a.dry_run) if cfg.lookback_hours > 0 else []
        if found:
            logger.info(f"Price check: {len(found)} new row(s) {'would be ' if a.dry_run else ''}queued.")
        limit = a.limit or cfg.batch
        entries = list(queue.entries(limit))
        if a.dry_run:  # nothing was written: preview the new rows too
            entries = (entries + [(None, pid) for pid in found])[:limit]
        if not entries:  # nothing to do: don't touch the LLM
            logger.info('Price check: queue is empty.')
            return

    try:
        finder = PriceFinder.from_config(cfg, a.verbose, provider=a.provider, model=a.model, rpm=a.rpm)
    except llm_reader.LLMError as e:
        sys.exit(str(e))
    checker = Checker(cfg, notion, None if a.dry_run else Slack.shared(), finder, a.dry_run, a.verbose)
    thresholds = (
        f'alert at ±{cfg.threshold_pct:g}%'
        f"{f' and ${cfg.min_delta_usd:g}' if cfg.min_delta_usd else ''}"
        f"{' (dry run)' if a.dry_run else ''}"
    )
    if a.queue:
        logger.info(f'Price check: {len(entries)} queued row(s), {thresholds}')
        counts = checker.drain(entries)
    else:
        rows = [checker.purchasing.get(_row_id(a.row))] if a.row else checker.purchasing.open_rows(a.limit)
        logger.info(f'Price check: {len(rows)} row(s), {thresholds}')
        counts = checker.check_all(rows)
    logger.info('Price check: ' + ', '.join(f'{n} {k}' for k, n in sorted(counts.items())))


if __name__ == '__main__':
    setup_logging()
    main()

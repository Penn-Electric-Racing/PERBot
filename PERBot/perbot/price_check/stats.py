"""`/pricecheck` — what the price check has saved, from the 💸 Price Check Savings ledger.
  /pricecheck            this season, just for you
  /pricecheck week|all   the last 7 days / all time
  /pricecheck share      post it in this channel
Also runs the sweep that marks Used rows Realized once they're ordered at the new price.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from slack_bolt import App

from ..config import config
from ..utils.logger import logger
from .ledger import Period, PriceLedger, in_period, stats_text, summarize
from .notion import PriceCheckNotion


@dataclass
class ParsedStats:
    kind: Literal['stats', 'help']
    period: Period
    share: bool


def parse_stats(text: str) -> ParsedStats:
    words = text.strip().lower().split()
    if any(w in ('help', '?') for w in words):
        return ParsedStats('help', 'season', False)
    if 'week' in words:
        period: Period = 'week'
    elif any(w in ('all', 'alltime', 'all-time') for w in words):
        period = 'all'
    else:
        period = 'season'
    return ParsedStats('stats', period, 'share' in words or 'post' in words)


USAGE = '\n'.join([
    '*Price check savings*',
    '• `/pricecheck`: this season, just for you',
    '• `/pricecheck week` or `/pricecheck all`: the last 7 days, or all time',
    '• `/pricecheck share`: post it in this channel',
])

SWEEP_EVERY_S = 6 * 3600


def register_price_check_stats(app: App, ledger: PriceLedger | None = None, notion: PriceCheckNotion | None = None) -> None:
    ledger = ledger or PriceLedger()
    notion = notion or PriceCheckNotion()

    @app.command('/pricecheck')
    def _pricecheck(ack, command, respond):
        ack()
        parsed = parse_stats(command.get('text') or '')
        if parsed.kind == 'help':
            respond(response_type='ephemeral', text=USAGE)
            return
        if not ledger.enabled:
            respond(response_type='ephemeral', text='The savings ledger is off (PRICE_CHECK_LEDGER_DS_ID is empty).')
            return
        try:
            season = config.benbuys.season
            now = datetime.now(timezone.utc)
            rows = [r for r in ledger.rows() if in_period(r, parsed.period, season, now)]
            text = stats_text(summarize(rows), parsed.period, season, config.price_check.ledger_url)
            respond(response_type='in_channel' if parsed.share else 'ephemeral', text=text, unfurl_links=False)
        except Exception as err:
            logger.error('/pricecheck failed', err)
            respond(response_type='ephemeral', text='✗ Could not read the savings ledger. Try again in a minute.')

    if not ledger.enabled:
        return

    def sweep() -> None:
        try:
            n = ledger.sweep_realized(notion.fetch_row)
            if n:
                logger.info(f'Price check ledger: {n} row(s) now Realized.')
        except Exception as err:
            logger.warn('Price check ledger: Realized sweep failed', err)

    def loop() -> None:
        time.sleep(90)
        while True:
            sweep()
            time.sleep(SWEEP_EVERY_S)

    threading.Thread(target=loop, name='price-check-sweep', daemon=True).start()

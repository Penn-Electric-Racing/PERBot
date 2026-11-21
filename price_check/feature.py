"""The price check, as the bot runs it (app.py adds it when PRICE_CHECK_ENABLED is on):

  /pricecheck            what the price check saved this season, just for you
  /pricecheck week|all   the last 7 days / all time
  /pricecheck share      post it in this channel
  alert buttons          views.PriceAlertView (Use / Keep / Undo, View listing)
  worker task            polls Purchasing and checks new rows (worker.py)
  sweep task             every 6 h, marks Used ledger rows Realized once ordered at the new price
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

from core.config import config
from core.feature import Feature, command, task
from core.notion import Notion
from price_check.database import PurchasingPrices, SavingsLedger
from price_check.models import LedgerRow, StatsQuery, Summary
from price_check.views import PriceAlertView
from price_check.worker import Worker

logger = logging.getLogger(__name__)

__all__ = ['PriceCheck']


class PriceCheck(Feature):
    name = 'price-check'

    USAGE = '\n'.join([
        '*Price check savings*',
        '• `/pricecheck`: this season, just for you',
        '• `/pricecheck week` or `/pricecheck all`: the last 7 days, or all time',
        '• `/pricecheck share`: post it in this channel',
    ])
    SWEEP_DELAY_S = 90
    SWEEP_EVERY_S = 6 * 3600

    def __init__(self, ledger: SavingsLedger | None = None, purchasing: PurchasingPrices | None = None, run_worker: bool | None = None):
        cfg = config.price_check
        self.ledger = ledger or SavingsLedger()
        self.purchasing = purchasing or PurchasingPrices(Notion.shared(), cfg)
        self.run_worker = cfg.enabled if run_worker is None else run_worker
        self.views = [PriceAlertView(self.purchasing, self.ledger)]

    @command('/pricecheck')
    def stats(self, ack, command, respond) -> None:
        ack()
        q = StatsQuery.parse(command.get('text') or '')
        if q.help:
            respond(response_type='ephemeral', text=self.USAGE)
            return
        if not self.ledger.enabled:
            respond(response_type='ephemeral', text='The savings ledger is off (PRICE_CHECK_LEDGER_DS_ID is empty).')
            return
        try:
            season = config.benbuys.season
            now = datetime.now(timezone.utc)
            rows: list[LedgerRow] = [r for r in self.ledger.rows() if r.in_period(q.period, season, now)]
            text = Summary.of(rows).text(q.period, season, config.price_check.ledger_url)
            respond(response_type='in_channel' if q.share else 'ephemeral', text=text, unfurl_links=False)
        except Exception as err:
            logger.error('/pricecheck failed', exc_info=err)
            respond(response_type='ephemeral', text='✗ Could not read the savings ledger. Try again in a minute.')

    def sweep_once(self) -> int:
        try:
            n = self.ledger.sweep_realized(self.purchasing.price_row)
            if n:
                logger.info(f'Price check ledger: {n} row(s) now Realized.')
            return n
        except Exception as err:
            logger.warning('Price check ledger: Realized sweep failed', exc_info=err)
            return 0

    @task
    def sweep(self) -> None:
        if not self.ledger.enabled:
            return
        time.sleep(self.SWEEP_DELAY_S)
        while True:
            self.sweep_once()
            time.sleep(self.SWEEP_EVERY_S)

    @task
    def worker(self) -> None:
        if not self.run_worker:
            return
        w = Worker.from_config()
        if w:
            w.run()

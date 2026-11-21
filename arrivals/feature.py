"""Deliveries: a photo posted in ARRIVALS_CHANNEL is matched to its Purchasing order and answered
with a package card (views.PackageCardView); the sweep nudges requesters about cards nobody
tapped. Off when ARRIVALS_CHANNEL is empty.
"""
from __future__ import annotations

import asyncio
import logging

from slack_bolt.async_app import AsyncApp

from arrivals.slack import SWEEP_EVERY_S, handle_message, sweep_once
from arrivals.views import PackageCardView
from core.config import config
from core.feature import Feature, event, task

logger = logging.getLogger(__name__)

__all__ = ['Arrivals']


class Arrivals(Feature):
    name = 'arrivals'

    SWEEP_DELAY_S = 30
    SWEEP_EVERY_S = SWEEP_EVERY_S

    def __init__(self) -> None:
        self.views = [PackageCardView()]

    @property
    def enabled(self) -> bool:
        return bool(config.arrivals.channel)

    def register(self, app: AsyncApp) -> None:
        if not self.enabled:
            logger.info('Arrivals: ARRIVALS_CHANNEL unset; delivery-photo listener disabled.')
            return
        logger.info(f'Arrivals: listening for delivery photos in "{config.arrivals.channel}".')
        super().register(app)

    @event('message')
    async def message(self, event, client) -> None:
        await handle_message(client, event)

    @task
    async def sweep(self) -> None:
        if not self.enabled or self.client is None:
            return
        await asyncio.sleep(self.SWEEP_DELAY_S)
        while True:
            await sweep_once(self.client)
            await asyncio.sleep(self.SWEEP_EVERY_S)

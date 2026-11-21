"""Sponsorship in Slack: `/sponsor` (add, claim, email, log, won, stage, find, scout, quota, ...)
and the deal cards' buttons and modals (views.DealView). The weekly jobs (stale DMs, quota audit,
digest, win posts) run from GitHub Actions: `python -m sponsorship.jobs.<job>`.
"""
from __future__ import annotations

from core.feature import Feature, command
from sponsorship.slack import handle_command
from sponsorship.views import DealView

__all__ = ['Sponsorship']


class Sponsorship(Feature):
    name = 'sponsorship'

    def __init__(self) -> None:
        self.views = [DealView()]

    @command('/sponsor')
    async def sponsor(self, ack, command, respond, client) -> None:
        await handle_command(ack, command, respond, client)

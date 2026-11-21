"""/race: the time-trial leaderboard."""
from __future__ import annotations

import logging
from collections.abc import Awaitable
from typing import Callable

from core.config import config
from core.feature import Feature, command
from core.ui import Interaction, View, button
from race.board import BoardRow, Period, fetch_board, race_configured
from race.slack import USAGE, board_message, parse_race

logger = logging.getLogger(__name__)

__all__ = ['Race']


class RaceBoardView(View):
    @button('race_open')
    async def open_site(self, interaction: Interaction) -> None:
        """A plain link button; Slack still reports the click, which the View acks."""


class Race(Feature):
    name = 'race'

    def __init__(self, load: Callable[[Period], Awaitable[list[BoardRow]]] = fetch_board):
        self.load = load
        self.views = [RaceBoardView()]

    @command('/race')
    async def race(self, ack, command, respond) -> None:
        await ack()
        parsed = parse_race(command.get('text') or '')
        if parsed.kind == 'help':
            await respond(response_type='ephemeral', text=USAGE)
            return
        if not race_configured():
            await respond(
                response_type='ephemeral',
                text=f'The time trial leaderboard isn’t connected yet (RACE_SUPABASE_URL / RACE_SUPABASE_SERVICE_KEY). You can still race at {config.race.site_url}',
            )
            return
        try:
            rows = await self.load(parsed.period)
            await respond(**board_message(rows, parsed.period, share=parsed.share, viewer=command.get('user_id')))
        except Exception as err:
            logger.error('/race failed', exc_info=err)
            await respond(response_type='ephemeral', text=f'✗ Couldn’t load the leaderboard: {err}')

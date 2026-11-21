"""PERBot's Slack entrypoint (Socket Mode): the bot adds each feature (core.feature.Feature), and
routes @PERBot mentions, which span features.

Run: `python -m app`
"""
from __future__ import annotations

import asyncio
import logging
import re
import sys
from typing import Any

from slack_bolt.adapter.socket_mode.async_handler import AsyncSocketModeHandler
from slack_bolt.async_app import AsyncApp
from slack_sdk.web.async_client import AsyncWebClient

from anon.feature import Anon
from arrivals.feature import Arrivals
from arrivals.slack import handle_arrivals_mention
from benbuys.feature import BenBuys
from core import http
from core.bolt import listener
from core.config import config
from core.feature import Feature
from core.log import setup_logging
from ops_tasks.assign import assign_from_mention
from ops_tasks.feature import OpsTasks
from price_check.feature import PriceCheck
from race.feature import Race
from search.feature import Search
from sponsorship.feature import Sponsorship

logger = logging.getLogger(__name__)


def clean_mention(text: str) -> str:
    """A mention's text without the mentions and a leading "PERBot,"."""
    text = re.sub(r'<@[^>]+>', ' ', text)
    return re.sub(r'^\s*PERBot[:,\-]?\s*', '', text, flags=re.I).strip()


class PERBot:
    """The Slack app and its features. Each Feature registers its own commands, buttons, modals and tasks; the bot itself only routes
    @PERBot mentions, which span features."""

    def __init__(self) -> None:
        self.app = AsyncApp(token=config.slack.bot_token)
        self.features: list[Feature] = []
        self.search = Search()
        for feature in (
            self.search,
            Anon(),
            PriceCheck(),
            Race(),
            OpsTasks(),
            BenBuys(),
            Arrivals(),
            Sponsorship(),
        ):
            self.add_feature(feature)
        self.app.event('app_mention')(listener(self.on_mention))

    def add_feature(self, feature: Feature) -> None:
        feature.register(self.app)
        self.features.append(feature)

    async def on_mention(self, event: dict[str, Any], client: AsyncWebClient, context: Any) -> None:
        """@PERBot mentions: assign → arrivals → docs (thread summary / chat / docs question)."""
        raw_text = event.get('text') or ''
        thread_ts = event.get('thread_ts') or event.get('ts')
        bot_user_id = context.bot_user_id

        # "@PERBot assign @person <task> [by <date>]": the in-thread way to assign (slash commands
        # can't run in threads). Strip only the bot's own mention so assignee mentions survive.
        without_bot = (re.sub(rf'<@{bot_user_id}(?:\|[^>]*)?>', ' ', raw_text) if bot_user_id else raw_text).strip()
        if re.match(r'^assign\b', without_bot, re.I):
            await assign_from_mention(client, without_bot, event.get('user'), event['channel'], thread_ts)
            return

        # In a #packages thread, "@PERBot <what's in the box>" corrects the package match.
        try:
            if await handle_arrivals_mention(client, event, bot_user_id):
                return
        except Exception as error:
            logger.error('Arrivals mention failed.', exc_info=error)
            return

        async def reply(text: str, blocks: list[dict[str, Any]] | None = None) -> None:
            kwargs: dict[str, Any] = {'blocks': blocks} if blocks else {}
            await client.chat_postMessage(channel=event['channel'], thread_ts=thread_ts, text=text, unfurl_links=False, unfurl_media=False, **kwargs)

        query = clean_mention(raw_text)
        if not query:
            await reply('Ask me a PER docs question after mentioning me. Example: `@PERBot what changed in REV11 chassis?`')
            return
        await self.search.docs.answer_mention(client, event, query, bot_user_id, reply)

    async def run(self) -> None:
        if not config.slack.app_token:
            raise RuntimeError('Missing required environment variable: SLACK_APP_TOKEN (needed for Socket Mode).')
        logger.info('[PERBot] Starting Slack Socket Mode...')
        # The aiohttp Socket Mode client: events arrive over its websocket and each listener runs
        # as a task on this loop.
        handler = AsyncSocketModeHandler(self.app, config.slack.app_token)
        await handler.connect_async()
        logger.info('⚡️ PERBot is running in Slack Socket Mode.')
        logger.info(f'Index path: {config.app.index_path}')
        tasks = [t for feature in self.features for t in feature.start()]
        try:
            await asyncio.Event().wait()  # until cancelled (Ctrl-C / SIGTERM ends asyncio.run)
        finally:
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await handler.close_async()


async def main() -> None:
    await PERBot().run()


if __name__ == '__main__':
    setup_logging()
    try:
        http.run(main())
    except KeyboardInterrupt:
        pass
    except Exception as error:
        logger.error('Failed to start PERBot.', exc_info=error)
        sys.exit(1)

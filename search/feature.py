"""PER docs search in Slack: `/dt <question>`, `/reindex`, `/indexstatus`, and the index's
load / hourly refresh (a task). @PERBot mentions are routed here by app.py (`docs.answer_mention`).
"""
from __future__ import annotations

from typing import Any

from slack_bolt.async_app import AsyncApp
from slack_sdk.web.async_client import AsyncWebClient

from core.feature import Feature, command, task
from search.bot import DocSearch

__all__ = ['Search']


class Search(Feature):
    name = 'search'

    def __init__(self, docs: DocSearch | None = None):
        self.docs = docs or DocSearch()

    def register(self, app: AsyncApp) -> None:
        index = self.docs.index
        if index.post is None:

            async def post(ch: str, ts: str | None, text: str) -> None:
                await app.client.chat_postMessage(channel=ch, thread_ts=ts, text=text)

            index.post = post
        super().register(app)

    @command('/dt')
    async def dt(self, ack: Any, command: dict[str, Any], client: AsyncWebClient) -> None:
        await self.docs.dt(ack, command, client)

    @command('/reindex')
    async def reindex(self, ack: Any, command: dict[str, Any], client: AsyncWebClient) -> None:
        await self.docs.reindex(ack, command, client)

    @command('/indexstatus')
    async def index_status(self, ack: Any, command: dict[str, Any], client: AsyncWebClient) -> None:
        await self.docs.index_status(ack, command, client)

    @task
    async def index(self) -> None:
        """Load (or bootstrap) the index, then keep it fresh."""
        await self.docs.index.start()

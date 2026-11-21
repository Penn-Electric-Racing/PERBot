"""PER docs search in Slack: `/dt <question>`, `/reindex`, `/indexstatus`, and the index's
load / hourly refresh (a task). @PERBot mentions are routed here by app.py (`docs.answer_mention`).
"""
from __future__ import annotations

from typing import Any

from slack_bolt import App
from slack_sdk import WebClient

from core.feature import Feature, command, task
from search.bot import DocSearch

__all__ = ['Search']


class Search(Feature):
    name = 'search'

    def __init__(self, docs: DocSearch | None = None):
        self.docs = docs or DocSearch()

    def register(self, app: App) -> None:
        index = self.docs.index
        if index.post is None:
            index.post = lambda ch, ts, text: app.client.chat_postMessage(channel=ch, thread_ts=ts, text=text)
        super().register(app)

    @command('/dt')
    def dt(self, ack: Any, command: dict[str, Any], client: WebClient) -> None:
        self.docs.dt(ack, command, client)

    @command('/reindex')
    def reindex(self, ack: Any, command: dict[str, Any], client: WebClient) -> None:
        self.docs.reindex(ack, command, client)

    @command('/indexstatus')
    def index_status(self, ack: Any, command: dict[str, Any], client: WebClient) -> None:
        self.docs.index_status(ack, command, client)

    @task
    def index(self) -> None:
        """Load (or bootstrap) the index, then keep it fresh."""
        self.docs.index.start()

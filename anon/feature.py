"""`/anon <message>`: post a message to an allowed channel without saying who sent it."""
from __future__ import annotations

import logging
from typing import Any

from slack_sdk.web.async_client import AsyncWebClient

from core.config import config
from core.feature import Feature, command

logger = logging.getLogger(__name__)

__all__ = ['Anon']


class Anon(Feature):
    name = 'anon'

    @command('/anon')
    async def anon(self, ack: Any, command: dict[str, Any], client: AsyncWebClient, respond: Any) -> None:
        allowed_channels = config.slack.anon_allowed_channels
        if command.get('channel_name') not in allowed_channels:
            await ack(response_type='ephemeral', text=f"`/anon` can only be used in: {', '.join(f'#{name}' for name in allowed_channels)}")
            return
        text = (command.get('text') or '').strip()
        if not text:
            await ack(
                response_type='ephemeral',
                text='Usage: `/anon your message`\nPERBot will post your message in this channel without revealing who sent it.',
            )
            return
        await ack()
        try:
            await client.chat_postMessage(
                channel=command['channel_id'],
                text=f':bust_in_silhouette: Anonymous: {text}',
                blocks=[
                    {'type': 'section', 'text': {'type': 'mrkdwn', 'text': text}},
                    {'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': ':bust_in_silhouette: Sent anonymously via `/anon`'}]},
                ],
                unfurl_links=False,
                unfurl_media=False,
            )
            await respond(response_type='ephemeral', text=':white_check_mark: Your anonymous message was posted.')
        except Exception as error:
            # Log only the error itself, never the sender or message text, so anonymity holds even
            # in server logs.
            logger.error('Anonymous message post failed.', exc_info=error)
            await respond(
                response_type='ephemeral',
                text=':x: PERBot could not post your anonymous message. If this is a private channel, invite @PERBot to it first and try again.',
            )

"""Requesters (Purchasing `Point of contact`, a Notion person) → Slack user ids, so a reply can
@-mention the people who actually know what's in the box, and so they can be DMed when it's
confirmed. Email first, then the conservative name match from sponsorship/identity — anyone
ambiguous stays a plain name. Rebuilt every 6 hours; a failure leaves names unmentioned.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING

from slack_sdk.web.async_client import AsyncWebClient

from core import aio
from core.slack import Slack

logger = logging.getLogger(__name__)

__all__ = ['People', 'TTL_S', 'people_map']

if TYPE_CHECKING:
    from arrivals.notion import ArrivalsNotion

# Notion person name (as rows carry it) → Slack user id.
People = dict[str, str]

TTL_S = 6 * 3600
_cached: tuple[float, People] | None = None
_lock = asyncio.Lock()


async def _build(client: AsyncWebClient, notion: 'ArrivalsNotion') -> People:
    users_f = aio.spawn(notion.list_users)
    dir_f = aio.spawn(Slack.wrap(client).fetch_directory)
    users, slack_dir = await users_f, await dir_f
    people: People = {}
    for user in users:
        if not user.name or user.name in people:
            continue
        try:
            slack_id = await Slack.wrap(client).notion_user_to_slack_id(user, slack_dir)
        except Exception:
            slack_id = None
        if slack_id:
            people[user.name] = slack_id
    logger.info(f'Arrivals: {len(people)} of {len(users)} Notion people resolved to Slack.')
    return people


async def people_map(client: AsyncWebClient, notion: 'ArrivalsNotion') -> People:
    global _cached
    async with _lock:
        if _cached and time.time() - _cached[0] <= TTL_S:
            return _cached[1]
        try:
            people = await _build(client, notion)
        except Exception as err:
            logger.warning('Arrivals: could not map requesters to Slack; replies will use plain names', exc_info=err)
            _cached = None
            return {}
        _cached = (time.time(), people)
        return people

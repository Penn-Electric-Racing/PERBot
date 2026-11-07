"""Requesters (Purchasing `Point of contact`, a Notion person) → Slack user ids, so a reply can
@-mention the people who actually know what's in the box, and so they can be DMed when it's
confirmed. Email first, then the conservative name match from sponsorship/identity — anyone
ambiguous stays a plain name. Rebuilt every 6 hours; a failure leaves names unmentioned.
"""
from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING

from slack_sdk import WebClient

from ..sponsorship.identity import fetch_slack_directory, notion_user_to_slack_id
from ..utils.logger import logger

if TYPE_CHECKING:
    from .notion import ArrivalsNotion

# Notion person name (as rows carry it) → Slack user id.
People = dict[str, str]

TTL_S = 6 * 3600
_cached: tuple[float, People] | None = None
_lock = threading.Lock()


def _build(client: WebClient, notion: 'ArrivalsNotion') -> People:
    with ThreadPoolExecutor(max_workers=2) as pool:
        users_f = pool.submit(notion.list_users)
        dir_f = pool.submit(fetch_slack_directory, client)
        users, slack_dir = users_f.result(), dir_f.result()
    people: People = {}
    for user in users:
        if not user.name or user.name in people:
            continue
        try:
            slack_id = notion_user_to_slack_id(client, user, slack_dir)
        except Exception:
            slack_id = None
        if slack_id:
            people[user.name] = slack_id
    logger.info(f'Arrivals: {len(people)} of {len(users)} Notion people resolved to Slack.')
    return people


def people_map(client: WebClient, notion: 'ArrivalsNotion') -> People:
    global _cached
    with _lock:
        if _cached and time.time() - _cached[0] <= TTL_S:
            return _cached[1]
        try:
            people = _build(client, notion)
        except Exception as err:
            logger.warn('Arrivals: could not map requesters to Slack; replies will use plain names', err)
            _cached = None
            return {}
        _cached = (time.time(), people)
        return people

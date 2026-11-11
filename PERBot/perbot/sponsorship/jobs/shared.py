"""Shared helpers for the scheduled sponsorship jobs (GitHub Actions cron). Jobs are standalone
entrypoints, so each builds its own Slack WebClient from the bot token.

Idempotency (mandatory — cron can fire late or double): jobs stamp each post/DM with an
invisible Slack message-metadata marker and check history for it before sending again
(falling back to a legacy in-text marker for older posts).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from slack_sdk import WebClient

from ...config import config


@dataclass
class WinMeta:
    """Invisible marker carried in a message's Slack metadata (not shown to users)."""

    event_type: str
    # Payload key/value pair that uniquely identifies the post (e.g. deal id, date).
    key: str
    value: str


def make_slack_client() -> WebClient:
    return WebClient(token=config.slack.bot_token)


CHANNEL_ID_RE = re.compile(r'^[CG][A-Z0-9]{6,}$')


def resolve_channel_id(client: WebClient, name_or_id: str) -> str | None:
    """Resolve a channel name ("operations") or ID ("C0123ABC") to a channel ID."""
    clean = name_or_id[1:] if name_or_id.startswith('#') else name_or_id
    if CHANNEL_ID_RE.match(clean):
        return clean
    cursor: str | None = None
    while True:
        res: Any = client.conversations_list(
            types='public_channel,private_channel', limit=200, cursor=cursor, exclude_archived=True
        )
        for ch in res.get('channels') or []:
            if ch.get('name') == clean:
                return ch['id']
        cursor = (res.get('response_metadata') or {}).get('next_cursor') or None
        if not cursor:
            return None


def already_posted(client: WebClient, channel_id: str, meta: WinMeta, legacy_text: str) -> bool:
    """True if a recent message in the channel/DM already carries this marker — either in
    invisible Slack metadata (new posts) or as a legacy in-text marker (older posts, kept for
    backward compatibility so we don't re-announce something posted the old way)."""
    res: Any = client.conversations_history(channel=channel_id, limit=200, include_all_metadata=True)
    for m in res.get('messages') or []:
        md = m.get('metadata') or {}
        if md.get('event_type') == meta.event_type and str((md.get('event_payload') or {}).get(meta.key)) == meta.value:
            return True
        if isinstance(m.get('text'), str) and legacy_text in m['text']:
            return True
    return False


def metadata_for(meta: WinMeta) -> dict[str, Any]:
    """The metadata object to attach to a chat.postMessage call for `meta`."""
    return {'event_type': meta.event_type, 'event_payload': {meta.key: meta.value}}

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any

from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

from meeting_notes.config import KICKOFF_SIGNATURE, SLACK_WORKSPACE_SUBDOMAIN


@lru_cache(maxsize=1)
def _slack() -> WebClient:
    return WebClient(token=os.environ.get('SLACK_BOT_TOKEN'))


# Cache channel IDs across calls within a single job run
_channel_id_cache: dict[str, str] = {}


def _log_slack_error(prefix: str, err: Exception) -> None:
    if isinstance(err, SlackApiError):
        print(f'{prefix}', json.dumps(err.response.data, indent=2))


def get_channel_id(channel_name: str) -> str:
    if channel_name in _channel_id_cache:
        return _channel_id_cache[channel_name]
    # Paginate through channels (Slack returns up to 1000 at a time)
    cursor: str | None = None
    while True:
        try:
            result: Any = _slack().conversations_list(types='public_channel,private_channel', limit=1000, cursor=cursor)
        except Exception as err:
            _log_slack_error('Slack error in conversations.list:', err)
            raise
        match = next((c for c in result.get('channels') or [] if c.get('name') == channel_name), None)
        if match and match.get('id'):
            _channel_id_cache[channel_name] = match['id']
            return match['id']
        cursor = (result.get('response_metadata') or {}).get('next_cursor') or None
        if not cursor:
            break
    raise RuntimeError(f'Slack channel #{channel_name} not found (is the bot invited?)')


def post_kickoff_message(channel_name: str, text: str) -> str:
    channel_id = get_channel_id(channel_name)
    try:
        result: Any = _slack().chat_postMessage(channel=channel_id, text=text, mrkdwn=True)
    except Exception as err:
        _log_slack_error(f'Slack error details for #{channel_name}:', err)
        raise
    if not result.get('ts'):
        raise RuntimeError(f'No timestamp returned from chat.postMessage in #{channel_name}')
    return result['ts']


def find_most_recent_bot_thread(channel_name: str, since_unix_seconds: int) -> str | None:
    """Find the most recent kickoff message posted by THIS bot in the given channel since the
    supplied unix timestamp. Returns the message ts (thread root) or None."""
    channel_id = get_channel_id(channel_name)
    bot_user_id = _slack().auth_test().get('user_id')
    since = datetime.fromtimestamp(since_unix_seconds, tz=timezone.utc).isoformat()
    print(f'[{channel_name}] Bot user ID: {bot_user_id}, searching since {since}')

    try:
        result: Any = _slack().conversations_history(channel=channel_id, oldest=str(since_unix_seconds), limit=100)
    except Exception as err:
        _log_slack_error(f'[{channel_name}] Slack error in conversations.history:', err)
        raise

    messages = result.get('messages') or []
    print(f'[{channel_name}] Got {len(messages)} messages from history')
    bot_messages = [m for m in messages if m.get('user') == bot_user_id and KICKOFF_SIGNATURE in (m.get('text') or '')]
    print(f'[{channel_name}] Of those, {len(bot_messages)} match the kickoff signature')

    # Also log if any messages were from the bot but didn't match signature
    bot_messages_all = [m for m in messages if m.get('user') == bot_user_id]
    if bot_messages_all and not bot_messages:
        print(
            f'[{channel_name}] Found {len(bot_messages_all)} bot messages but none matched signature. '
            f"First bot message text: {(bot_messages_all[0].get('text') or '')[:100]}"
        )

    # conversations.history returns newest-first, so [0] is most recent
    return bot_messages[0].get('ts') if bot_messages else None


def get_thread_replies(channel_name: str, thread_ts: str) -> list[dict[str, Any]]:
    channel_id = get_channel_id(channel_name)
    try:
        result: Any = _slack().conversations_replies(channel=channel_id, ts=thread_ts, limit=200)
    except Exception as err:
        _log_slack_error(f'[{channel_name}] Slack error in conversations.replies:', err)
        raise
    # First message in `messages` is the thread root (kickoff). Skip it.
    return (result.get('messages') or [])[1:]


def get_message_permalink(channel_id: str, ts: str) -> str:
    """Build a clickable Slack permalink for a message.
    Format: https://<workspace>.slack.com/archives/<channelId>/p<ts-without-dot>"""
    return f"https://{SLACK_WORKSPACE_SUBDOMAIN}.slack.com/archives/{channel_id}/p{ts.replace('.', '', 1)}"


_user_name_cache: dict[str, str] = {}


def get_user_display_name(user_id: str) -> str:
    """Resolve user IDs to display names so the LLM sees "[Alan] busbar replaced" instead of
    "[U07A9C3D2] busbar replaced". Cached per run."""
    if user_id in _user_name_cache:
        return _user_name_cache[user_id]
    try:
        user = _slack().users_info(user=user_id).get('user') or {}
        profile = user.get('profile') or {}
        name = profile.get('display_name') or profile.get('real_name') or user.get('name') or user_id
        _user_name_cache[user_id] = name
        return name
    except Exception:
        return user_id

"""Bridges a Pipeline DRI (a native Notion person) to a Slack user, and vice-versa.

Primary key is EMAIL — because DRI is a real person property (not a freeform name field),
email is a strong unique join. When email is unavailable (the Notion integration lacks the
"read user emails" capability, or a member's Slack/Notion emails differ) we fall back to a
CONSERVATIVE name match against the Slack directory: exact normalized name, unique
token-subset, or unique surname+first-initial. Anything ambiguous is left unresolved, never
guessed.

Scopes: `users:read` (directory) and `users:read.email` (email match).
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any

from slack_sdk import WebClient

from utils.logger import logger
from sponsorship.models import NotionUser


@dataclass
class Indexed:
    id: str
    exact: set[str] = field(default_factory=set)  # normalized full names
    tokens: set[str] = field(default_factory=set)  # individual name tokens
    email: str | None = None  # lowercased


def _normalize(s: str) -> str:
    stripped = ''.join(c for c in unicodedata.normalize('NFD', s) if not unicodedata.combining(c))
    return re.sub(r'[^a-z0-9]+', ' ', stripped.lower()).strip()


def _tokens_of(s: str) -> list[str]:
    return [t for t in _normalize(s).split(' ') if t]


def index_entry(id_: str, names: list[str], email: str | None) -> Indexed:
    entry = Indexed(id=id_, email=email.lower() if email else None)
    for n in names:
        norm = _normalize(n)
        if norm:
            entry.exact.add(norm)
        entry.tokens.update(_tokens_of(n))
    return entry


def match_by_name(name: str, candidates: list[Indexed]) -> Indexed | None:
    """Conservative name match — returns the single confident candidate, or None."""
    norm = _normalize(name)
    if not norm:
        return None

    exact = [c for c in candidates if norm in c.exact]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        return None  # ambiguous — don't guess

    q_tokens = _tokens_of(name)
    if not q_tokens:
        return None

    subset = [c for c in candidates if all(t in c.tokens for t in q_tokens)]
    if len(subset) == 1:
        return subset[0]
    if len(subset) > 1:
        return None

    # Nickname fallback: exact surname + matching first initial, uniquely.
    if len(q_tokens) >= 2:
        surname = q_tokens[-1]
        first_initial = q_tokens[0][0]
        nick = [
            c for c in candidates if surname in c.tokens and any(t != surname and t[0] == first_initial for t in c.tokens)
        ]
        if len(nick) == 1:
            return nick[0]
    return None


def fetch_slack_directory(client: WebClient) -> list[Indexed]:
    """Fetch the Slack member directory as a name/email index (paginated)."""
    directory: list[Indexed] = []
    cursor: str | None = None
    while True:
        res: Any = client.users_list(limit=200, cursor=cursor)
        for m in res.get('members') or []:
            if m.get('deleted') or m.get('is_bot') or m.get('id') == 'USLACKBOT':
                continue
            profile = m.get('profile') or {}
            real = profile.get('real_name') or m.get('real_name') or ''
            display = profile.get('display_name') or ''
            handle = m.get('name') or ''
            if not (real or display or handle):
                continue
            directory.append(index_entry(m['id'], [real, display, handle], profile.get('email')))
        cursor = (res.get('response_metadata') or {}).get('next_cursor') or None
        if not cursor:
            return directory


def index_notion_users(users: list[NotionUser]) -> list[Indexed]:
    return [index_entry(u.id, [u.name], u.email) for u in users]


def resolve_slack_handles(client: WebClient, handles: list[str]) -> tuple[list[str], list[str]]:
    """Resolve typed @handles / names to Slack user IDs via the directory. Needed because Slack
    slash commands send @mentions as plain text ("@arjunsh") unless the command has
    link-escaping enabled. Usernames are unique, so a handle match is safe; ambiguous
    display-name matches are left unresolved (never guessed). Returns (ids, unresolved)."""
    ids: list[str] = []
    unresolved: list[str] = []
    if not handles:
        return ids, unresolved
    directory = fetch_slack_directory(client)
    for handle in handles:
        match = match_by_name(handle, directory)
        if match:
            ids.append(match.id)
        else:
            unresolved.append(handle)
    return ids, unresolved


def notion_user_to_slack_id(client: WebClient, notion_user: NotionUser, slack_dir: list[Indexed]) -> str | None:
    """Notion DRI person → Slack user ID (email first, then conservative name match)."""
    if notion_user.email:
        email = notion_user.email.lower()
        by_email = next((m for m in slack_dir if m.email == email), None)
        if by_email:
            return by_email.id
        try:
            lookup: Any = client.users_lookupByEmail(email=email)
            uid = (lookup.get('user') or {}).get('id')
            if uid:
                return uid
        except Exception:
            pass  # fall through to name matching
    by_name = match_by_name(notion_user.name, slack_dir)
    if not by_name:
        logger.warn(f'Identity: could not resolve Notion user "{notion_user.name}" to Slack.')
    return by_name.id if by_name else None


def slack_user_to_notion_id(client: WebClient, slack_user_id: str, notion_index: list[Indexed]) -> str | None:
    """Slack caller → their Notion user ID (email first, then conservative name match)."""
    info: Any = client.users_info(user=slack_user_id)
    user = info.get('user') or {}
    profile = user.get('profile') or {}
    email = profile.get('email')
    if email:
        target = email.lower()
        by_email = next((u for u in notion_index if u.email == target), None)
        if by_email:
            return by_email.id
    name = profile.get('real_name') or user.get('real_name') or user.get('name') or ''
    by_name = match_by_name(name, notion_index)
    return by_name.id if by_name else None

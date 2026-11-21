"""Slack, for every feature: `Slack.shared()` is the bot's client (SLACK_BOT_TOKEN).

  Slack          the Web API client (any WebClient method works on it), the member directory,
                 Notion person <-> Slack user matching, channel lookup, and once-only posting
  Identity       the conservative name matching behind that (never guesses)
  MessageMarker  an invisible metadata marker that makes a cron post idempotent
  SlackText      parsing mentions, @handles and auto-links out of command text

Matching is EMAIL first (Notion people are real accounts, so email is a strong join), then a
CONSERVATIVE name match: exact normalized name, unique token subset, or unique surname + first
initial. Anything ambiguous stays unresolved. Scopes: `users:read`, `users:read.email`.
"""
from __future__ import annotations

import logging
import re
import threading
import time
import unicodedata
from dataclasses import dataclass, field
from typing import Any, ClassVar, NamedTuple

from slack_sdk import WebClient

from core.notion import NotionUser

logger = logging.getLogger(__name__)

__all__ = [
    'Indexed', 'normalize_name', 'name_tokens', 'index_entry', 'index_notion_users',
    'match_by_name', 'MessageMarker', 'ResolvedPeople', 'MENTION_RE', 'EMAIL_RE',
    'PLAIN_HANDLE_RE', 'CHANNEL_ID_RE', 'unwrap_links', 'extract_plain_handles', 'Slack',
]


@dataclass
class Indexed:
    """A person (Slack member or Notion user) indexed for matching."""

    id: str
    exact: set[str] = field(default_factory=set)  # normalized full names
    tokens: set[str] = field(default_factory=set)  # individual name tokens
    email: str | None = None  # lowercased


def normalize_name(s: str) -> str:
    stripped = ''.join(c for c in unicodedata.normalize('NFD', s) if not unicodedata.combining(c))
    return re.sub(r'[^a-z0-9]+', ' ', stripped.lower()).strip()


def name_tokens(s: str) -> list[str]:
    return [t for t in normalize_name(s).split(' ') if t]


def index_entry(id_: str, names: list[str], email: str | None) -> Indexed:
    entry = Indexed(id=id_, email=email.lower() if email else None)
    for n in names:
        norm = normalize_name(n)
        if norm:
            entry.exact.add(norm)
        entry.tokens.update(name_tokens(n))
    return entry


def index_notion_users(users: list[NotionUser]) -> list[Indexed]:
    return [index_entry(u.id, [u.name], u.email) for u in users]


def match_by_name(name: str, candidates: list[Indexed]) -> Indexed | None:
    """Conservative name match: the single confident candidate, or None."""
    norm = normalize_name(name)
    if not norm:
        return None
    exact = [c for c in candidates if norm in c.exact]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        return None  # ambiguous: don't guess
    q_tokens = name_tokens(name)
    if not q_tokens:
        return None
    subset = [c for c in candidates if all(t in c.tokens for t in q_tokens)]
    if len(subset) == 1:
        return subset[0]
    if len(subset) > 1:
        return None
    # Nickname fallback: exact surname + matching first initial, uniquely.
    if len(q_tokens) >= 2:
        surname, first_initial = q_tokens[-1], q_tokens[0][0]
        nick = [c for c in candidates if surname in c.tokens and any(t != surname and t[0] == first_initial for t in c.tokens)]
        if len(nick) == 1:
            return nick[0]
    return None


@dataclass
class MessageMarker:
    """Invisible marker carried in a message's Slack metadata (not shown to users)."""

    event_type: str
    # Payload key/value pair that uniquely identifies the post (e.g. deal id, date).
    key: str
    value: str

    def metadata(self) -> dict[str, Any]:
        """The `metadata` argument for chat.postMessage."""
        return {'event_type': self.event_type, 'event_payload': {self.key: self.value}}


class ResolvedPeople(NamedTuple):
    notion_ids: list[str]
    labels: list[str]  # <@U…> for each resolved person
    unresolved: list[str]


# Slack encodes mentions in command text as `<@U012ABC>` or `<@U012ABC|handle>`.
MENTION_RE = re.compile(r'<@([A-Z0-9]+)(?:\|[^>]+)?>')
EMAIL_RE = re.compile(r'[^\s<>]+@[^\s<>]+\.[^\s<>]+')
# A plain-text "@handle" (NOT a real mention), anchored to whitespace/start so it never matches
# the "@" inside an email.
PLAIN_HANDLE_RE = re.compile(r'(^|\s)@([a-z0-9._-]+)', re.I)
CHANNEL_ID_RE = re.compile(r'^[CG][A-Z0-9]{6,}$')


def unwrap_links(text: str) -> str:
    """Slack auto-links URLs/emails in slash-command text: strip the `<…|…>` wrappers."""
    text = re.sub(r'<mailto:([^|>]+)(?:\|[^>]*)?>', r'\1', text, flags=re.I)
    return re.sub(r'<(https?://[^|>]+)(?:\|[^>]*)?>', r'\1', text, flags=re.I)


def extract_plain_handles(text: str) -> tuple[list[str], str]:
    """Pull out plain-text @handles (typed, not picked from the menu) and remove them →
    (handles, cleaned)."""
    handles = [m.group(2) for m in PLAIN_HANDLE_RE.finditer(text)]
    cleaned = re.sub(r'\s+', ' ', PLAIN_HANDLE_RE.sub(r'\1', text)).strip()
    return handles, cleaned


class Slack:
    """The bot's Slack Web API client. Unknown attributes go to the WebClient, so
    `slack.chat_postMessage(...)` works; `slack.client` is the WebClient itself."""

    DIRECTORY_TTL_S = 6 * 3600
    _shared: ClassVar['Slack | None'] = None
    _lock: ClassVar[threading.Lock] = threading.Lock()

    @classmethod
    def shared(cls) -> 'Slack':
        with cls._lock:
            if cls._shared is None:
                from core.config import config

                cls._shared = cls(WebClient(token=config.slack.bot_token))
            return cls._shared

    @classmethod
    def wrap(cls, client: 'WebClient | Slack') -> 'Slack':
        """A Slack around a handler's `client` (Bolt passes a WebClient)."""
        return client if isinstance(client, Slack) else cls(client)

    def __init__(self, client: WebClient):
        self.client = client
        self._directory: tuple[float, list[Indexed]] | None = None
        self._dir_lock = threading.Lock()

    def __getattr__(self, name: str) -> Any:
        return getattr(self.client, name)

    # --- people -----------------------------------------------------------------------------------

    def fetch_directory(self) -> list[Indexed]:
        """The member directory as a name/email index (paginated, fetched now)."""
        directory: list[Indexed] = []
        cursor: str | None = None
        while True:
            res: Any = self.client.users_list(limit=200, cursor=cursor)
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

    def directory(self) -> list[Indexed]:
        """The member directory, cached for DIRECTORY_TTL_S."""
        with self._dir_lock:
            if self._directory and time.time() - self._directory[0] <= self.DIRECTORY_TTL_S:
                return self._directory[1]
            members = self.fetch_directory()
            self._directory = (time.time(), members)
            return members

    def notion_user_to_slack_id(self, user: NotionUser, directory: list[Indexed] | None = None) -> str | None:
        """Notion person → Slack user ID (email first, then conservative name match)."""
        members = self.directory() if directory is None else directory
        if user.email:
            email = user.email.lower()
            by_email = next((m for m in members if m.email == email), None)
            if by_email:
                return by_email.id
            try:
                uid = ((self.client.users_lookupByEmail(email=email) or {}).get('user') or {}).get('id')
                if uid:
                    return uid
            except Exception:
                pass  # fall through to name matching
        by_name = match_by_name(user.name, members)
        if not by_name:
            logger.warning(f'Identity: could not resolve Notion user "{user.name}" to Slack.')
        return by_name.id if by_name else None

    def slack_user_to_notion_id(self, slack_user_id: str, notion_index: list[Indexed]) -> str | None:
        """Slack user → their Notion user ID (email first, then conservative name match)."""
        info: Any = self.client.users_info(user=slack_user_id)
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

    def resolve_handles(self, handles: list[str]) -> tuple[list[str], list[str]]:
        """Typed @handles / names → Slack user IDs via the directory (slash commands send
        @mentions as plain text unless link-escaping is on). Returns (ids, unresolved)."""
        ids: list[str] = []
        unresolved: list[str] = []
        if not handles:
            return ids, unresolved
        directory = self.fetch_directory()
        for handle in handles:
            match = match_by_name(handle, directory)
            if match:
                ids.append(match.id)
            else:
                unresolved.append(handle)
        return ids, unresolved

    def resolve_people(self, slack_ids: list[str], plain_handles: list[str] | None, notion_users: Any) -> ResolvedPeople:
        """Slack mentions + typed @handles → Notion user IDs. `notion_users` is a callable that
        lists Notion people (only called when there's someone to resolve)."""
        handle_ids, handle_unresolved = self.resolve_handles(plain_handles or [])
        all_slack_ids = list(dict.fromkeys([*slack_ids, *handle_ids]))
        notion_ids: list[str] = []
        labels: list[str] = []
        unresolved = [f'@{h}' for h in handle_unresolved]
        if not all_slack_ids:
            return ResolvedPeople(notion_ids, labels, unresolved)
        index = index_notion_users(notion_users())
        for slack_id in all_slack_ids:
            notion_id = self.slack_user_to_notion_id(slack_id, index)
            if notion_id:
                notion_ids.append(notion_id)
                labels.append(f'<@{slack_id}>')
            else:
                unresolved.append(f'<@{slack_id}>')
        return ResolvedPeople(notion_ids, labels, unresolved)

    # --- channels and posts ----------------------------------------------------------------------

    def resolve_channel_id(self, name_or_id: str) -> str | None:
        """A channel name ("operations", "#operations") or ID ("C0123ABC") → its ID."""
        clean = name_or_id[1:] if name_or_id.startswith('#') else name_or_id
        if CHANNEL_ID_RE.match(clean):
            return clean
        cursor: str | None = None
        while True:
            res: Any = self.client.conversations_list(
                types='public_channel,private_channel', limit=200, cursor=cursor, exclude_archived=True
            )
            for ch in res.get('channels') or []:
                if ch.get('name') == clean:
                    return ch['id']
            cursor = (res.get('response_metadata') or {}).get('next_cursor') or None
            if not cursor:
                return None

    def already_posted(self, channel_id: str, marker: MessageMarker, legacy_text: str) -> bool:
        """True if a recent message in the channel/DM already carries this marker, in its Slack
        metadata (new posts) or as a legacy in-text marker (older posts)."""
        res: Any = self.client.conversations_history(channel=channel_id, limit=200, include_all_metadata=True)
        for m in res.get('messages') or []:
            md = m.get('metadata') or {}
            if md.get('event_type') == marker.event_type and str((md.get('event_payload') or {}).get(marker.key)) == marker.value:
                return True
            if isinstance(m.get('text'), str) and legacy_text in m['text']:
                return True
        return False

"""Notion, for every feature: `Notion.shared()` is the bot's client (NOTION_TOKEN).

A thin REST client with the call surface of `@notionhq/client` (`notion.data_sources.query(...)`,
`notion.pages.update(...)`, `notion.blocks.children.list(...)`), plus the helpers every feature
needs: `query_all` (pagination), `list_users`, `plain_text` (a title/rich_text value) and
`page_id_from` (an id or notion.so URL).

Written against the HTTP API directly so the data-source endpoints (API 2025-09-03+) and the
`/pages/{id}/markdown` export work regardless of SDK release cadence. Rate limits (429) and
transient 5xx are retried with backoff, as the JS SDK did.
"""
from __future__ import annotations

import random
import re
import threading
import time
from dataclasses import dataclass
from typing import Any, ClassVar

import httpx

from core.errors import NotionError

__all__ = [
    'API', 'DEFAULT_VERSION', 'MAX_RETRIES', 'NotionAPIError', 'NotionUser', 'collect',
    'plain_text', 'page_id_from', 'dashed_id', 'same_id', 'Notion',
]

API = 'https://api.notion.com/v1'
DEFAULT_VERSION = '2026-03-11'
MAX_RETRIES = 3


class NotionAPIError(NotionError):
    """An HTTP failure from the Notion API (`status` is the HTTP status, `code` Notion's error code)."""

    def __init__(self, status: int, code: str, message: str, body: Any = None):
        super().__init__(f'{code}: {message}' if code else message)
        self.status = status
        self.code = code
        self.body = body


def _clean(body: dict[str, Any]) -> dict[str, Any]:
    # The JS SDK dropped `undefined` params; mirror that for None.
    return {k: v for k, v in body.items() if v is not None}


@dataclass
class NotionUser:
    """A Notion workspace person. Email is None when the integration can't read user emails."""

    id: str
    name: str
    email: str | None = None


_PAGE_ID_RE = re.compile(r'([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$', re.I)


def collect(fn: Any, limit: int | None = None, **kwargs: Any) -> list[Any]:
    """All results of a cursor-paginated list/query call (the first `limit` when given)."""
    out: list[Any] = []
    cursor: str | None = None
    while True:
        res = fn(**kwargs, start_cursor=cursor)
        out.extend(res.get('results') or [])
        if limit is not None and len(out) >= limit:
            return out[:limit]
        if not res.get('has_more') or not res.get('next_cursor'):
            return out
        cursor = res['next_cursor']


def plain_text(prop: Any) -> str:
    """The text of a title or rich_text property value, trimmed."""
    prop = prop or {}
    items = prop.get('title') if prop.get('title') is not None else prop.get('rich_text') or []
    return ''.join((t or {}).get('plain_text') or '' for t in items).strip()


def page_id_from(s: str) -> str | None:
    """A page id from an id or a notion.so URL (".../Title-<32 hex>?pvs=4"), or None."""
    tail = re.split(r'[?#]', (s or '').strip(), maxsplit=1)[0].rstrip('/').rsplit('/', 1)[-1]
    m = _PAGE_ID_RE.search(tail)
    return m.group(1) if m else None


def dashed_id(id_: str) -> str:
    """A page id in its dashed form, whichever form it came in."""
    h = id_.replace('-', '').lower()
    return f'{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}' if len(h) == 32 else id_


def same_id(a: str, b: str) -> bool:
    """Page/data-source ids compare equal with or without dashes."""
    return a.replace('-', '').lower() == b.replace('-', '').lower()


class Notion:
    _shared: ClassVar['Notion | None'] = None
    _lock: ClassVar[threading.Lock] = threading.Lock()

    @classmethod
    def shared(cls) -> 'Notion':
        """The bot's client, built once (NOTION_TOKEN / NOTION_API_VERSION)."""
        with cls._lock:
            if cls._shared is None:
                from core.config import config

                cls._shared = cls(config.notion.token, config.notion.api_version)
            return cls._shared

    def __init__(self, auth: str, notion_version: str | None = None, timeout: float = 60.0):
        self._http = httpx.Client(
            base_url=API,
            timeout=timeout,
            headers={
                'Authorization': f'Bearer {auth}',
                'Notion-Version': notion_version or DEFAULT_VERSION,
                'Content-Type': 'application/json',
            },
        )
        self.data_sources = _DataSources(self)
        self.databases = _Databases(self)
        self.pages = _Pages(self)
        self.blocks = _Blocks(self)
        self.users = _Users(self)
        self.comments = _Comments(self)

    def request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
    ) -> Any:
        params = {k: v for k, v in (query or {}).items() if v is not None}
        for attempt in range(MAX_RETRIES + 1):
            try:
                res = self._http.request(method, path, json=body if body is not None else None, params=params or None)
            except httpx.TransportError:
                if attempt >= MAX_RETRIES:
                    raise
                time.sleep(min(8.0, 0.5 * 2**attempt) + random.random() * 0.25)
                continue
            if res.status_code in (429, 500, 502, 503, 504) and attempt < MAX_RETRIES:
                retry_after = res.headers.get('retry-after')
                try:
                    delay = float(retry_after) if retry_after else min(8.0, 0.5 * 2**attempt)
                except ValueError:
                    delay = min(8.0, 0.5 * 2**attempt)
                time.sleep(delay + random.random() * 0.25)
                continue
            if res.is_success:
                return res.json() if res.content else {}
            try:
                data = res.json()
            except ValueError:
                data = {}
            raise NotionAPIError(res.status_code, data.get('code', ''), data.get('message', res.text[:300]), data)
        raise RuntimeError('unreachable')

    def search(self, **body: Any) -> Any:
        return self.request('POST', '/search', _clean(body))

    def query_all(self, data_source_id: str, limit: int | None = None, **body: Any) -> list[Any]:
        """Every page of a data source query (the first `limit` when given)."""
        return collect(self.data_sources.query, limit=limit, data_source_id=data_source_id, **body)

    def list_users(self) -> list[NotionUser]:
        """Workspace people (bots left out). Needs only `users.list`, so `Notion.list_users(c)`
        works on any client shaped like this one."""
        users: list[NotionUser] = []
        for user in collect(self.users.list, page_size=100):
            if user.get('type') == 'bot' or not user.get('id'):
                continue
            name = user.get('name')
            email = (user.get('person') or {}).get('email')
            users.append(NotionUser(user['id'], name if isinstance(name, str) else '', email if isinstance(email, str) else None))
        return users

    def close(self) -> None:
        self._http.close()


class _DataSources:
    def __init__(self, c: Notion):
        self._c = c

    def query(self, data_source_id: str, **body: Any) -> Any:
        return self._c.request('POST', f'/data_sources/{data_source_id}/query', _clean(body))

    def retrieve(self, data_source_id: str) -> Any:
        return self._c.request('GET', f'/data_sources/{data_source_id}')

    def update(self, data_source_id: str, **body: Any) -> Any:
        return self._c.request('PATCH', f'/data_sources/{data_source_id}', _clean(body))


class _Databases:
    def __init__(self, c: Notion):
        self._c = c

    def retrieve(self, database_id: str) -> Any:
        return self._c.request('GET', f'/databases/{database_id}')


class _Pages:
    def __init__(self, c: Notion):
        self._c = c

    def create(self, **body: Any) -> Any:
        return self._c.request('POST', '/pages', _clean(body))

    def retrieve(self, page_id: str) -> Any:
        return self._c.request('GET', f'/pages/{page_id}')

    def update(self, page_id: str, **body: Any) -> Any:
        return self._c.request('PATCH', f'/pages/{page_id}', _clean(body))

    def markdown(self, page_id: str) -> Any:
        return self._c.request('GET', f'/pages/{page_id}/markdown')


class _Children:
    def __init__(self, c: Notion):
        self._c = c

    def list(self, block_id: str, start_cursor: str | None = None, page_size: int | None = None) -> Any:
        return self._c.request(
            'GET', f'/blocks/{block_id}/children', query={'start_cursor': start_cursor, 'page_size': page_size}
        )

    def append(self, block_id: str, **body: Any) -> Any:
        return self._c.request('PATCH', f'/blocks/{block_id}/children', _clean(body))


class _Blocks:
    def __init__(self, c: Notion):
        self._c = c
        self.children = _Children(c)

    def retrieve(self, block_id: str) -> Any:
        return self._c.request('GET', f'/blocks/{block_id}')

    def update(self, block_id: str, **body: Any) -> Any:
        return self._c.request('PATCH', f'/blocks/{block_id}', _clean(body))

    def delete(self, block_id: str) -> Any:
        return self._c.request('DELETE', f'/blocks/{block_id}')


class _Users:
    def __init__(self, c: Notion):
        self._c = c

    def list(self, start_cursor: str | None = None, page_size: int | None = None) -> Any:
        return self._c.request('GET', '/users', query={'start_cursor': start_cursor, 'page_size': page_size})


class _Comments:
    def __init__(self, c: Notion):
        self._c = c

    def create(self, **body: Any) -> Any:
        return self._c.request('POST', '/comments', _clean(body))

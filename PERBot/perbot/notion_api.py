"""A thin Notion REST client with the same call surface the bot used from `@notionhq/client`
(`client.data_sources.query(...)`, `client.pages.update(...)`, `client.blocks.children.list(...)`).

Written against the HTTP API directly so the data-source endpoints (API 2025-09-03+) and the
`/pages/{id}/markdown` export work regardless of SDK release cadence. Rate limits (429) and
transient 5xx are retried with backoff, as the JS SDK did.
"""
from __future__ import annotations

import random
import time
from typing import Any

import httpx

API = 'https://api.notion.com/v1'
DEFAULT_VERSION = '2026-03-11'
MAX_RETRIES = 3


class NotionAPIError(Exception):
    def __init__(self, status: int, code: str, message: str, body: Any = None):
        super().__init__(f'{code}: {message}' if code else message)
        self.status = status
        self.code = code
        self.body = body


def _clean(body: dict[str, Any]) -> dict[str, Any]:
    # The JS SDK dropped `undefined` params; mirror that for None.
    return {k: v for k, v in body.items() if v is not None}


class NotionClient:
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

    def close(self) -> None:
        self._http.close()


class _DataSources:
    def __init__(self, c: NotionClient):
        self._c = c

    def query(self, data_source_id: str, **body: Any) -> Any:
        return self._c.request('POST', f'/data_sources/{data_source_id}/query', _clean(body))

    def retrieve(self, data_source_id: str) -> Any:
        return self._c.request('GET', f'/data_sources/{data_source_id}')

    def update(self, data_source_id: str, **body: Any) -> Any:
        return self._c.request('PATCH', f'/data_sources/{data_source_id}', _clean(body))


class _Databases:
    def __init__(self, c: NotionClient):
        self._c = c

    def retrieve(self, database_id: str) -> Any:
        return self._c.request('GET', f'/databases/{database_id}')


class _Pages:
    def __init__(self, c: NotionClient):
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
    def __init__(self, c: NotionClient):
        self._c = c

    def list(self, block_id: str, start_cursor: str | None = None, page_size: int | None = None) -> Any:
        return self._c.request(
            'GET', f'/blocks/{block_id}/children', query={'start_cursor': start_cursor, 'page_size': page_size}
        )

    def append(self, block_id: str, **body: Any) -> Any:
        return self._c.request('PATCH', f'/blocks/{block_id}/children', _clean(body))


class _Blocks:
    def __init__(self, c: NotionClient):
        self._c = c
        self.children = _Children(c)

    def retrieve(self, block_id: str) -> Any:
        return self._c.request('GET', f'/blocks/{block_id}')

    def update(self, block_id: str, **body: Any) -> Any:
        return self._c.request('PATCH', f'/blocks/{block_id}', _clean(body))

    def delete(self, block_id: str) -> Any:
        return self._c.request('DELETE', f'/blocks/{block_id}')


class _Users:
    def __init__(self, c: NotionClient):
        self._c = c

    def list(self, start_cursor: str | None = None, page_size: int | None = None) -> Any:
        return self._c.request('GET', '/users', query={'start_cursor': start_cursor, 'page_size': page_size})


class _Comments:
    def __init__(self, c: NotionClient):
        self._c = c

    def create(self, **body: Any) -> Any:
        return self._c.request('POST', '/comments', _clean(body))


def collect_paginated(fn: Any, **kwargs: Any) -> list[Any]:
    """All results of a cursor-paginated list/query call."""
    out: list[Any] = []
    cursor: str | None = None
    while True:
        res = fn(**kwargs, start_cursor=cursor)
        out.extend(res.get('results') or [])
        if not res.get('has_more') or not res.get('next_cursor'):
            return out
        cursor = res['next_cursor']

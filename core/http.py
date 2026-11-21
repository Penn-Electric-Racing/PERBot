"""HTTP for every feature, on aiohttp.

    from core import http

    res = await http.get(url, params={'q': part}, headers=..., timeout=15)
    res.raise_for_status()
    data = res.json()

`Response` keeps the names `requests` used (`status_code`, `ok`, `text`, `content`, `json()`,
`raise_for_status()`), so a converted call reads like the old one with `await` in front. The body
is read before the call returns, so nothing has to be closed.

One `aiohttp.ClientSession` is kept per event loop (`session()`): the bot runs one loop for its
whole life, while each job, CLI and test runs its own (`asyncio.run`), and a session can't be
shared across loops. Entrypoints call `http.run(main())`, which closes the loop's sessions when
`main` returns.
"""
from __future__ import annotations

import asyncio
import json as _json
import weakref
from collections.abc import Coroutine, Mapping
from dataclasses import dataclass, field
from typing import Any, TypeVar

import aiohttp
from multidict import CIMultiDict

from core.errors import PERBotError

__all__ = [
    'RequestError', 'HTTPError', 'Timeout', 'ConnectError', 'Response', 'session', 'close',
    'request', 'get', 'post', 'download', 'run',
]

T = TypeVar('T')

DEFAULT_TIMEOUT_S = 30.0
USER_AGENT = 'PERBot (+https://github.com/Penn-Electric-Racing)'


class RequestError(PERBotError):
    """A request that didn't get an HTTP response (or, as HTTPError, got an error status)."""


class Timeout(RequestError):
    """The request took longer than its timeout."""


class ConnectError(RequestError):
    """DNS, connection or TLS failure."""


class HTTPError(RequestError):
    """`raise_for_status()` on a 4xx/5xx response; `.response` is the Response."""

    def __init__(self, message: str, response: 'Response'):
        super().__init__(message)
        self.response = response


@dataclass
class Response:
    status_code: int
    url: str
    headers: Mapping[str, str] = field(default_factory=dict)
    content: bytes = b''
    encoding: str = 'utf-8'

    @property
    def ok(self) -> bool:
        return self.status_code < 400

    @property
    def text(self) -> str:
        return self.content.decode(self.encoding or 'utf-8', errors='replace')

    def json(self) -> Any:
        return _json.loads(self.content)

    def raise_for_status(self) -> None:
        if not self.ok:
            raise HTTPError(f'HTTP {self.status_code} for {self.url}', self)


# event loop -> its session
_sessions: 'weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, aiohttp.ClientSession]' = weakref.WeakKeyDictionary()


def session() -> aiohttp.ClientSession:
    """The running loop's shared session (made on first use)."""
    loop = asyncio.get_running_loop()
    s = _sessions.get(loop)
    if s is None or s.closed:
        s = aiohttp.ClientSession(headers={'User-Agent': USER_AGENT})
        _sessions[loop] = s
    return s


async def close() -> None:
    """Close the running loop's session (entrypoints do this through `run`)."""
    s = _sessions.pop(asyncio.get_running_loop(), None)
    if s is not None and not s.closed:
        await s.close()


async def request(
    method: str,
    url: str,
    *,
    params: Mapping[str, Any] | None = None,
    json: Any = None,
    data: Any = None,
    headers: Mapping[str, str] | None = None,
    timeout: float | None = DEFAULT_TIMEOUT_S,
    allow_redirects: bool = True,
    max_bytes: int | None = None,
) -> Response:
    """One request; the whole body is read (or its first `max_bytes`). Raises Timeout / ConnectError (never aiohttp's own
    exceptions), not HTTPError: check `res.ok` or call `res.raise_for_status()`."""
    if params:
        params = {k: (str(v).lower() if isinstance(v, bool) else v) for k, v in params.items() if v is not None}
    try:
        async with session().request(
            method,
            url,
            params=params or None,
            json=json,
            data=data,
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=timeout),
            allow_redirects=allow_redirects,
        ) as res:
            if max_bytes is None:
                body = await res.read()
            else:
                buf = bytearray()
                async for chunk in res.content.iter_chunked(64 * 1024):
                    buf += chunk
                    if len(buf) >= max_bytes:
                        break
                body = bytes(buf[:max_bytes])
            try:
                encoding = res.get_encoding() if body else 'utf-8'
            except (LookupError, RuntimeError):
                encoding = 'utf-8'
            return Response(res.status, str(res.url), CIMultiDict(res.headers), body, encoding)
    except asyncio.TimeoutError as err:
        raise Timeout(f'{method} {url} timed out after {timeout}s') from err
    except aiohttp.ClientConnectionError as err:
        raise ConnectError(f'{method} {url}: {err}') from err
    except aiohttp.ClientError as err:
        raise RequestError(f'{method} {url}: {err}') from err


async def get(url: str, **kwargs: Any) -> Response:
    return await request('GET', url, **kwargs)


async def post(url: str, **kwargs: Any) -> Response:
    return await request('POST', url, **kwargs)


async def download(
    url: str,
    dest: str,
    *,
    headers: Mapping[str, str] | None = None,
    timeout: float | None = 600,
    connect_timeout: float | None = 30,
    chunk_size: int = 1 << 20,
) -> Response:
    """Stream a GET's body to the file `dest` (only on a 2xx; the returned Response then has no
    content). Same errors as `request`."""
    try:
        async with session().get(
            url, headers=headers, timeout=aiohttp.ClientTimeout(total=timeout, connect=connect_timeout)
        ) as res:
            if res.status >= 400:
                return Response(res.status, str(res.url), CIMultiDict(res.headers), await res.read())
            with open(dest, 'wb') as f:
                async for chunk in res.content.iter_chunked(chunk_size):
                    f.write(chunk)
            return Response(res.status, str(res.url), CIMultiDict(res.headers))
    except asyncio.TimeoutError as err:
        raise Timeout(f'GET {url} timed out after {timeout}s') from err
    except aiohttp.ClientConnectionError as err:
        raise ConnectError(f'GET {url}: {err}') from err
    except aiohttp.ClientError as err:
        raise RequestError(f'GET {url}: {err}') from err


def run(main: Coroutine[Any, Any, T]) -> T:
    """`asyncio.run(main)`, closing the loop's HTTP session (and the LLM clients) when it ends."""

    async def wrapper() -> T:
        try:
            return await main
        finally:
            from core.llm import LLM

            await LLM.shared().close()
            await close()

    return asyncio.run(wrapper())

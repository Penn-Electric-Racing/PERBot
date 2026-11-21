"""Async stand-ins for monkeypatching coroutine functions in tests.

    monkeypatch.setattr(distributors, 'lookup', returning(([], [])))
    monkeypatch.setattr(mod, 'fetch', awaitable(lambda url: PAGES[url]))
    mailer = WebhookMailer(url, request=FakeHTTP(lambda call: response(202)))
"""
from __future__ import annotations

import inspect
import json as _json
from dataclasses import dataclass
from typing import Any, Callable

from core import http


def awaitable(fn: Callable[..., Any]) -> Callable[..., Any]:
    """`fn` as a coroutine function (same arguments, same result)."""

    async def call(*args: Any, **kwargs: Any) -> Any:
        return fn(*args, **kwargs)

    return call


def returning(value: Any = None) -> Callable[..., Any]:
    """A coroutine function that ignores its arguments and returns `value`."""
    return awaitable(lambda *a, **k: value)


def as_coroutine(fn: Callable[..., Any]) -> Callable[..., Any]:
    """`fn` if it's already a coroutine function, else `awaitable(fn)`."""
    return fn if inspect.iscoroutinefunction(fn) else awaitable(fn)


@dataclass
class Call:
    """One request a FakeHTTP received."""

    method: str
    url: str
    kwargs: dict[str, Any]

    @property
    def json(self) -> Any:
        return self.kwargs.get('json')

    @property
    def data(self) -> Any:
        return self.kwargs.get('data')

    @property
    def headers(self) -> dict[str, str]:
        return dict(self.kwargs.get('headers') or {})


class FakeHTTP:
    """Stands in for `core.http.request` (the `request=` code takes for its HTTP): records each call
    and answers with `handler(call)`."""

    def __init__(self, handler: Callable[[Call], http.Response]):
        self.handler, self.calls = handler, []

    async def __call__(self, method: str, url: str, **kwargs: Any) -> http.Response:
        call = Call(method, url, kwargs)
        self.calls.append(call)
        return self.handler(call)


def response(status: int = 200, json: Any = None, text: str = '', headers: dict[str, str] | None = None) -> http.Response:
    body = _json.dumps(json).encode() if json is not None else text.encode()
    return http.Response(status, 'http://fake', headers or {}, body)

"""asyncio helpers for running work side by side.

    task = aio.spawn(notion.open_rows)                  # start now, await later: rows = await task
    pages = await aio.map(read_page, results, limit=10)  # like a thread pool's map, in order
    aio.background(record, event)                      # fire and forget (errors are logged)

`fn` may be a coroutine function or a plain one; a plain function just runs (on the loop, so it
should be quick: parsing, not network).
"""
from __future__ import annotations

import asyncio
import inspect
import logging
from collections.abc import Awaitable, Callable, Iterable
from typing import Any, TypeVar, overload

logger = logging.getLogger(__name__)

__all__ = ['call', 'spawn', 'background', 'map']

T = TypeVar('T')
R = TypeVar('R')

# Tasks started with background(); asyncio keeps only weak references to tasks, so one nobody
# holds could otherwise be collected mid-run.
_running: set[asyncio.Task[Any]] = set()


async def call(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """`fn(*args, **kwargs)`, awaited if it returned an awaitable."""
    result = fn(*args, **kwargs)
    if inspect.isawaitable(result):
        return await result
    return result


def _log_failure(task: asyncio.Task[Any]) -> None:
    _running.discard(task)
    if not task.cancelled() and task.exception() is not None:
        logger.error(f'Background task {task.get_name()} failed', exc_info=task.exception())


@overload
def spawn(fn: Callable[..., Awaitable[T]], *args: Any, **kwargs: Any) -> 'asyncio.Task[T]': ...
@overload
def spawn(fn: Callable[..., T], *args: Any, **kwargs: Any) -> 'asyncio.Task[T]': ...
def spawn(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> 'asyncio.Task[Any]':
    """Start `fn(*args, **kwargs)` now; await the task for its result (or its error)."""
    return asyncio.ensure_future(call(fn, *args, **kwargs))


def background(fn: Callable[..., Awaitable[Any] | Any], *args: Any, name: str | None = None, **kwargs: Any) -> 'asyncio.Task[Any]':
    """Start `fn(*args, **kwargs)` and don't wait for it. Nobody awaits it, so its error is
    logged instead of lost."""
    task = spawn(fn, *args, **kwargs)
    if name:
        task.set_name(name)
    _running.add(task)
    task.add_done_callback(_log_failure)
    return task


@overload
async def map(fn: Callable[[T], Awaitable[R]], items: Iterable[T], limit: int = 10) -> list[R]: ...
@overload
async def map(fn: Callable[[T], R], items: Iterable[T], limit: int = 10) -> list[R]: ...
async def map(fn: Callable[[T], Any], items: Iterable[T], limit: int = 10) -> list[Any]:
    """`[await fn(x) for x in items]`, at most `limit` at a time, results in input order."""
    sem = asyncio.Semaphore(max(1, limit))

    async def one(x: T) -> Any:
        async with sem:
            return await call(fn, x)

    return list(await asyncio.gather(*(one(x) for x in items)))

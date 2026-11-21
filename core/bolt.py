"""Calling methods from Bolt.

Bolt passes a listener its arguments by parameter name (it reads them with
inspect.getfullargspec) and passes None for a name it doesn't know. A bound method's spec
includes `self`, so it can't be registered as is; `listener(method)` wraps it.
"""
from __future__ import annotations

import inspect
from typing import Any, Callable

__all__ = ['listener', 'BOLT_ARGS']

# Every argument Bolt can inject (always available, so the wrapper can ask for all of them).
BOLT_ARGS = ('ack', 'body', 'payload', 'command', 'event', 'action', 'view', 'shortcut', 'message', 'respond', 'say', 'client', 'context', 'logger')


def listener(method: Callable[..., Any]) -> Callable[..., Any]:
    """An async function Bolt's AsyncApp can call that forwards the arguments `method` asks for
    by name. `method` must be a coroutine function (AsyncApp only runs those)."""
    if not inspect.iscoroutinefunction(method):
        raise TypeError(f'{method.__qualname__}: Slack listeners must be `async def`')
    args = inspect.getfullargspec(method).args
    wanted = args[1:] if inspect.ismethod(method) else args  # drop self / cls
    unknown = [a for a in wanted if a not in BOLT_ARGS]
    if unknown:
        raise TypeError(f'{method.__qualname__}: Bolt cannot inject {unknown}')

    async def bolt_listener(ack, body, payload, command, event, action, view, shortcut, message, respond, say, client, context, logger):  # noqa: ANN001
        given = locals()
        return await method(**{a: given[a] for a in wanted})

    bolt_listener.__qualname__ = f'listener({method.__qualname__})'
    return bolt_listener

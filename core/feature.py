"""Features as classes: a `Feature` subclass declares its
Slack listeners with decorators, owns its Views and background tasks, and app.py only adds it.

    class PriceCheck(Feature):
        name = 'price-check'

        def __init__(self):
            self.views = [PriceAlertView()]

        @command('/pricecheck')
        async def stats(self, ack, command, respond): ...

        @task
        async def sweep(self): ...    # runs as an asyncio task once the bot is connected

    bot.add_feature(PriceCheck())

Command and event methods take Bolt's listener arguments by name (`ack`, `command`, `respond`,
`client`, `event`, `body`, `context`, ...), exactly like a function passed to `app.command`.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, ClassVar

from slack_bolt.async_app import AsyncApp

from core.bolt import listener
from core.ui import View

logger = logging.getLogger(__name__)

__all__ = ['Feature', 'command', 'event', 'shortcut', 'task']

_LISTENER_ATTR = '__perbot_listener__'
_TASK_ATTR = '__perbot_task__'


def command(name: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Mark a Feature method as the handler of a slash command."""

    def deco(fn: Callable[..., Any]) -> Callable[..., Any]:
        setattr(fn, _LISTENER_ATTR, ('command', name))
        return fn

    return deco


def event(name: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Mark a Feature method as the handler of a Slack event."""

    def deco(fn: Callable[..., Any]) -> Callable[..., Any]:
        setattr(fn, _LISTENER_ATTR, ('event', name))
        return fn

    return deco


def shortcut(matcher: str | dict[str, str]) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Mark a Feature method as the handler of a global or message shortcut (callback_id, or a
    Bolt constraint dict like {'callback_id': ..., 'type': 'message_action'})."""

    def deco(fn: Callable[..., Any]) -> Callable[..., Any]:
        setattr(fn, _LISTENER_ATTR, ('shortcut', matcher))
        return fn

    return deco


def task(fn: Callable[..., Any]) -> Callable[..., Any]:
    """Mark a Feature method (`async def`) to run as an asyncio task when the bot starts. A task
    that has nothing to do (its feature is switched off) just returns."""
    setattr(fn, _TASK_ATTR, True)
    return fn


class Feature:
    """One feature of the bot: its Slack listeners, Views and background tasks."""

    name: ClassVar[str] = 'feature'
    __listeners__: ClassVar[list[tuple[str, Any, str]]] = []
    __tasks__: ClassVar[list[str]] = []
    views: list[View]
    client: Any = None  # the app's AsyncWebClient, set by register()

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        listeners: dict[str, tuple[str, Any]] = {}
        tasks: dict[str, bool] = {}
        for klass in reversed(cls.__mro__):
            for attr, value in vars(klass).items():
                if hasattr(value, _LISTENER_ATTR):
                    listeners[attr] = getattr(value, _LISTENER_ATTR)
                if getattr(value, _TASK_ATTR, False):
                    tasks[attr] = True
        cls.__listeners__ = [(kind, name, attr) for attr, (kind, name) in listeners.items()]
        cls.__tasks__ = list(tasks)

    def register(self, app: AsyncApp) -> None:
        """Attach this feature's listeners and views to the app."""
        self.client = app.client  # for tasks, which run outside any request
        for kind, name, attr in self.__listeners__:
            getattr(app, kind)(name)(listener(getattr(self, attr)))
        for view in getattr(self, 'views', []):
            view.register(app)

    def start(self) -> list['asyncio.Task[None]']:
        """Start this feature's background tasks (once the bot is connected). Call from the
        running loop and keep the returned tasks: asyncio holds tasks only weakly."""
        return [asyncio.create_task(self._run_task(attr), name=f'{self.name}-{attr}') for attr in self.__tasks__]

    async def _run_task(self, attr: str) -> None:
        try:
            await getattr(self, attr)()
        except asyncio.CancelledError:
            raise
        except Exception as err:  # a crashed task must never take the bot down
            logger.error(f'{self.name}: task {attr} stopped', exc_info=err)

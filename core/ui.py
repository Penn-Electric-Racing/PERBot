"""Interactive messages: a `View` subclass declares the buttons
it answers with `@button(action_id_pattern)`, and each callback gets an `Interaction`.

    class PriceAlertView(View):
        @button(r'^price_swap_keep$')
        def keep(self, interaction: Interaction) -> None:
            interaction.replace(blocks, 'Kept')

    PriceAlertView().register(app)

A Slack button is routed by action_id, not by the message it sits on, so one View
instance serves every message that carries its buttons (they survive restarts).
"""
from __future__ import annotations

import re
from typing import Any, Callable

from slack_bolt import App

from core.bolt import listener
from core.types.slack import ActionPayload, Block, InteractionBody

__all__ = ['Interaction', 'View', 'button', 'modal']

_ACTION_ATTR = '__perbot_action__'
_LISTENER_ATTR = '__perbot_listener__'


class Interaction:
    """One click on a button: who clicked what, and how to answer."""

    def __init__(self, body: InteractionBody, action: ActionPayload, respond: Any, client: Any):
        self.body, self.action, self.respond, self.client = body, action, respond, client

    @property
    def user_id(self) -> str | None:
        return (self.body.get('user') or {}).get('id')

    @property
    def action_id(self) -> str:
        return self.action.get('action_id', '')

    @property
    def value(self) -> str | None:
        return self.action.get('value')

    @property
    def message_blocks(self) -> list[Block] | None:
        """The clicked message's blocks (absent on some containers)."""
        return (self.body.get('message') or {}).get('blocks')

    def whisper(self, text: str) -> None:
        """Tell only the clicker, leaving the message as is."""
        self.respond(response_type='ephemeral', replace_original=False, text=text)

    def replace(self, blocks: list[Block], text: str) -> None:
        """Rewrite the clicked message."""
        self.respond(replace_original=True, blocks=blocks, text=text)

    def display_name(self, user_id: str | None = None) -> str | None:
        """A Slack user's real name (the clicker by default), or None."""
        try:
            u = self.client.users_info(user=user_id or self.user_id).get('user') or {}
        except Exception:
            return None
        return (u.get('profile') or {}).get('real_name') or u.get('real_name') or u.get('name') or None


def button(action_id: 'str | re.Pattern[str]') -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Mark a View method as the callback for buttons with this action_id: a string matches exactly,
    a compiled pattern matches by regex."""
    pattern = action_id

    def deco(fn: Callable[..., Any]) -> Callable[..., Any]:
        setattr(fn, _ACTION_ATTR, pattern)
        return fn

    return deco


def _listener(callback: Callable[[Interaction], Any]) -> Callable[..., None]:
    # Bolt passes listener arguments by parameter name (an unknown name gets None), so the
    # callback is closed over rather than passed as a default.
    def listener(ack: Any, body: Any, action: Any, respond: Any, client: Any) -> None:
        ack()
        callback(Interaction(body, action, respond, client))

    return listener


def modal(callback_id: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Mark a View or Feature method as the handler of a modal's submission (Bolt's `app.view`).
    It takes Bolt's arguments by name (`ack`, `body`, `view`, `client`, ...) and acks itself, so
    it can answer `ack(response_action='errors', errors=...)`."""

    def deco(fn: Callable[..., Any]) -> Callable[..., Any]:
        setattr(fn, _LISTENER_ATTR, ('view', callback_id))
        return fn

    return deco


class View:
    """The buttons of one kind of message. Subclasses mark callbacks with `@button`."""

    __buttons__: list[tuple['str | re.Pattern[str]', str]] = []
    __modals__: list[tuple[str, str]] = []

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        found: dict[str, str | re.Pattern[str]] = {}
        modals: dict[str, str] = {}
        for klass in reversed(cls.__mro__):
            for name, attr in vars(klass).items():
                pattern = getattr(attr, _ACTION_ATTR, None)
                if pattern is not None:
                    found[name] = pattern
                spec = getattr(attr, _LISTENER_ATTR, None)
                if spec and spec[0] == 'view':
                    modals[name] = spec[1]
        cls.__buttons__ = [(p, n) for n, p in found.items()]
        cls.__modals__ = [(c, n) for n, c in modals.items()]

    def register(self, app: App) -> None:
        for pattern, name in self.__buttons__:
            app.action(pattern)(_listener(getattr(self, name)))
        for callback_id, name in self.__modals__:
            app.view(callback_id)(listener(getattr(self, name)))

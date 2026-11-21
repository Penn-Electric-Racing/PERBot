"""Raw Slack payloads: Block Kit dicts and the parts of an interaction body PERBot reads.
`core.blocks` builds the blocks; `core.ui.Interaction` wraps the body."""
from __future__ import annotations

from typing import Any, NotRequired, TypedDict

__all__ = ['Block', 'ActionPayload', 'InteractionUser', 'InteractionMessage', 'InteractionBody']

# One Block Kit block or element, as sent to / received from Slack.
Block = dict[str, Any]


class ActionPayload(TypedDict):
    action_id: str
    block_id: NotRequired[str]
    value: NotRequired[str]
    type: NotRequired[str]


class InteractionUser(TypedDict, total=False):
    id: str
    name: str


class InteractionMessage(TypedDict, total=False):
    ts: str
    text: str
    blocks: list[Block]


class InteractionBody(TypedDict, total=False):
    user: InteractionUser
    message: InteractionMessage
    channel: dict[str, Any]
    actions: list[ActionPayload]

"""Slack Block Kit builders: build a message from objects
instead of nested dicts, then `.to_dict()` (or `render(...)`) for the API.

    render(
        Section('*Price dropped*', block_id='alert'),
        Actions([Button('Keep', 'price_swap_keep', value=v)], block_id='price_swap_actions'),
    )

Slack's own limits are applied here (button labels ≤ 75 chars, confirm text ≤ 300), so callers
don't each truncate.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from core.types.slack import Block

__all__ = ['PlainText', 'Markdown', 'Confirm', 'Button', 'Section', 'Actions', 'Context', 'render']


@dataclass
class PlainText:
    text: str
    emoji: bool | None = None
    max_len: int | None = None

    def to_dict(self) -> Block:
        out: Block = {'type': 'plain_text', 'text': self.text[: self.max_len] if self.max_len else self.text}
        if self.emoji is not None:
            out['emoji'] = self.emoji
        return out


@dataclass
class Markdown:
    text: str

    def to_dict(self) -> Block:
        return {'type': 'mrkdwn', 'text': self.text}


@dataclass
class Confirm:
    """The "are you sure?" dialog Slack shows before a button's click is sent."""

    TEXT_MAX = 300

    title: str
    text: str
    confirm: str
    deny: str

    def to_dict(self) -> Block:
        return {
            'title': PlainText(self.title).to_dict(),
            'text': PlainText(self.text, max_len=self.TEXT_MAX).to_dict(),
            'confirm': PlainText(self.confirm).to_dict(),
            'deny': PlainText(self.deny).to_dict(),
        }


@dataclass
class Button:
    """An action button (`value`) or a link button (`url`)."""

    TEXT_MAX = 75

    text: str
    action_id: str
    value: str | None = None
    url: str | None = None
    style: Literal['primary', 'danger'] | None = None
    confirm: Confirm | None = None
    emoji: bool | None = None

    def to_dict(self) -> Block:
        out: Block = {'type': 'button', 'action_id': self.action_id}
        if self.url is not None:
            out['url'] = self.url
        if self.value is not None:
            out['value'] = self.value
        out['text'] = PlainText(self.text, self.emoji, self.TEXT_MAX).to_dict()
        if self.style:
            out['style'] = self.style
        if self.confirm:
            out['confirm'] = self.confirm.to_dict()
        return out


@dataclass
class Section:
    text: str
    block_id: str | None = None

    def to_dict(self) -> Block:
        out: Block = {'type': 'section'}
        if self.block_id:
            out['block_id'] = self.block_id
        out['text'] = Markdown(self.text).to_dict()
        return out


@dataclass
class Actions:
    elements: list[Button] = field(default_factory=list)
    block_id: str | None = None

    def to_dict(self) -> Block:
        out: Block = {'type': 'actions'}
        if self.block_id:
            out['block_id'] = self.block_id
        out['elements'] = [e.to_dict() for e in self.elements]
        return out


@dataclass
class Context:
    texts: list[str] = field(default_factory=list)

    def to_dict(self) -> Block:
        return {'type': 'context', 'elements': [Markdown(t).to_dict() for t in self.texts]}


def render(*blocks: 'Section | Actions | Context | None') -> list[Block]:
    """The blocks as API dicts, skipping Nones (optional blocks)."""
    return [b.to_dict() for b in blocks if b is not None]

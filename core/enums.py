"""Base classes for PERBot's enums.

Notion select / status options and other fixed value sets are `StrEnum`s: each member IS its
string (`Outcome.USED == 'Used'`), so values read from Notion or Slack compare and hash like the
plain strings they replace, and the members are the single list of allowed values.

Feature-specific enums live in each feature's `enums.py` and subclass these.
"""
from __future__ import annotations

from enum import StrEnum
from typing import Any

__all__ = ['Choice', 'SelectOption']


class Choice(StrEnum):
    """A fixed set of string values."""

    @classmethod
    def values(cls) -> tuple[str, ...]:
        return tuple(m.value for m in cls)

    @classmethod
    def get(cls, value: Any, default: Any = None) -> Any:
        """The member for `value`, or `default` when it isn't one (no ValueError)."""
        try:
            return cls(value)
        except ValueError:
            return default


class SelectOption(Choice):
    """An option of a Notion select property."""

    def prop(self) -> dict[str, Any]:
        """The property value that sets this option."""
        return {'select': {'name': self.value}}

    @classmethod
    def from_prop(cls, prop: Any, default: Any = None) -> Any:
        """The member a select property value holds, or `default`."""
        return cls.get(((prop or {}).get('select') or {}).get('name'), default)

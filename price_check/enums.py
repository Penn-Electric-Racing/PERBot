"""The price check's fixed value sets."""
from __future__ import annotations

import re

from core.enums import Choice, SelectOption

# The alert's Use / Keep / Undo action_ids (views.py has the full button contract).
ACTION_RE = re.compile(r'^price_swap_(use|keep|undo)(?::\d+)?$')

__all__ = ['CheckStatus', 'ClickKind', 'ClickOutcome', 'SwapPlanKind', 'Outcome', 'Direction', 'Period']


class CheckStatus(Choice):
    """What checking one row did."""

    ALERTED = 'alerted'  # the price moved and the alert went out
    OK = 'ok'  # priced, within the thresholds, or already alerted
    SKIPPED = 'skipped'  # not a row to check (see PurchasingPrices.skip_reason)
    RETRY = 'retry'  # search or the LLM failed: try again later
    GONE = 'gone'  # the row was deleted


class ClickKind(Choice):
    """Which alert button was clicked."""

    USE = 'use'
    KEEP = 'keep'
    UNDO = 'undo'

    @classmethod
    def from_action_id(cls, action_id: str | None) -> 'ClickKind | None':
        """`price_swap_use:0` → USE, `price_swap_keep` → KEEP, `price_swap_undo` → UNDO; None for
        anything else."""
        m = ACTION_RE.match(action_id or '')
        return cls(m.group(1)) if m else None


class ClickOutcome(Choice):
    """What a click did, as the savings ledger records it."""

    USED = 'used'
    KEPT = 'kept'
    UNDONE = 'undone'
    REFUSED = 'refused'


class SwapPlanKind(Choice):
    WRITE = 'write'  # write the new Unit cost (and link)
    ALREADY = 'already'  # Notion already reads the target
    REFUSE = 'refuse'  # the row changed since the alert: write nothing


class Outcome(SelectOption):
    """💸 Price Check Savings `Outcome`."""

    PENDING = 'Pending'
    USED = 'Used'
    KEPT = 'Kept'
    UNDONE = 'Undone'
    REFUSED = 'Refused'


class Direction(SelectOption):
    """💸 Price Check Savings `Direction`."""

    DROP = 'Drop'
    RISE = 'Rise'


class Period(Choice):
    """The span `/pricecheck` reports on."""

    WEEK = 'week'
    SEASON = 'season'
    ALL = 'all'

    def title(self, season: str) -> str:
        return {'week': 'last 7 days', 'season': f'{season} season', 'all': 'all time'}[self.value]

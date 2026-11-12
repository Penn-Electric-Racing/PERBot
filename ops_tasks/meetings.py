"""Which Saturday meeting page a task belongs to. Pure helpers (no Notion) so they're testable;
`OpsTasksNotion` supplies the meeting list.

Rule: a task dated D (created / assigned on D) belongs to the first meeting on or after D, up to
and including the Saturday of that week. So something assigned from Slack on Monday lands in the
coming Saturday's "This week" table instead of looking carried, and something typed on the
Saturday itself belongs to that day's meeting.
"""
from __future__ import annotations

from dataclasses import dataclass

from sponsorship.dates import iso_add_days, weekday_utc


@dataclass
class OpsMeeting:
    id: str
    # YYYY-MM-DD from the meeting row's Date property.
    date: str


def saturday_on_or_after(iso: str) -> str:
    """The Saturday on or after `iso` (YYYY-MM-DD); `iso` itself when it is a Saturday."""
    day = iso[:10]
    return iso_add_days(day, (6 - weekday_utc(day) + 7) % 7)


def pick_meeting(meetings: list[OpsMeeting], anchor_iso: str) -> OpsMeeting | None:
    """The meeting a task anchored at `anchor_iso` belongs to: the meeting page whose Date falls
    in the same Sunday–Saturday week as the anchor (earliest such page if several). Matching by
    week, not exact date, tolerates the repeating template stamping Date with the page's creation
    moment (Sunday morning) before the lead sets it to the Saturday. None when no page for that
    week exists yet."""
    week = saturday_on_or_after(anchor_iso)
    candidates = sorted((m for m in meetings if saturday_on_or_after(m.date) == week), key=lambda m: m.date)
    return candidates[0] if candidates else None

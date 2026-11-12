"""The Next actions PERBot writes itself, and what replaces them as a deal moves.

WHY (2026-10-22): claiming set "Send first outreach" (due claim + 7 days) and nothing ever cleared
it, so 185 deals already at Contacted / In talks kept showing up in the Wednesday DM as "overdue:
send first outreach". Now a stage move swaps PERBot's own action for the right next one. Anything a
person typed is left alone.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sponsorship.dates import iso_add_days
from sponsorship.models import PipelineRow, Stage

FIRST_OUTREACH_ACTION = 'Send first outreach'
FOLLOW_UP_ACTION = 'Follow up if no reply'
CHECK_REPLY_ACTION = 'Check for a reply (no reply after 30 days)'

# Days after a contact (or a logged follow-up) before the follow-up comes due.
FOLLOW_UP_DAYS = 7

# Contacted this long ago with no reply → the Wednesday "gone cold" check owns the deal instead.
COLD_AFTER_DAYS = 30

_AUTO_PREFIXES = [FIRST_OUTREACH_ACTION, FOLLOW_UP_ACTION, CHECK_REPLY_ACTION]


def is_auto_next_action(action: str | None) -> bool:
    """True for a blank Next action or one PERBot wrote, so it's safe to replace."""
    a = (action or '').strip()
    return a == '' or any(a.startswith(p) for p in _AUTO_PREFIXES)


def _ask_suffix(action: str | None) -> str:
    """"Send first outreach — reduced-cost PCB fab" → " — reduced-cost PCB fab", so the ask survives the swap."""
    a = (action or '').strip()
    for p in _AUTO_PREFIXES:
        if a.startswith(p):
            return a[len(p) :]
    return ''


@dataclass
class NextActionChange:
    # '' clears the property.
    action: str
    # None clears the date.
    date_iso: str | None


def next_action_for_stage(row: PipelineRow, stage: Stage, today_iso: str) -> NextActionChange | None:
    """What a move to `stage` on `today_iso` should do to the deal's Next action, or None to leave it
    alone (a person's own action, or a stage with nothing to say).
    - Contacted: follow up in 7 days if there's no reply.
    - In talks / Won / Lost: clear it. The conversation, or the deal, has moved on."""
    if not is_auto_next_action(row.next_action):
        return None
    if stage == 'Contacted':
        return NextActionChange(f'{FOLLOW_UP_ACTION}{_ask_suffix(row.next_action)}', iso_add_days(today_iso, FOLLOW_UP_DAYS))
    if stage == 'Prospect':
        return None
    if not row.next_action and not row.next_action_date:
        return None
    return NextActionChange('', None)


def next_action_after_touch(row: PipelineRow, today_iso: str) -> NextActionChange | None:
    """A follow-up was logged on a Contacted deal: the next one comes due a week later."""
    if row.stage != 'Contacted' or not is_auto_next_action(row.next_action):
        return None
    return NextActionChange(f'{FOLLOW_UP_ACTION}{_ask_suffix(row.next_action)}', iso_add_days(today_iso, FOLLOW_UP_DAYS))


def backfill_next_action(row: PipelineRow, today_iso: str) -> NextActionChange | None:
    """One-time cleanup of deals the old bug left behind: past Prospect but still carrying "Send first
    outreach". A Contacted deal under 30 days old gets the follow-up it should have had, due 7 days
    after its last touch. That can be in the past, because it really is overdue. Older Contacted
    deals and everything past Contacted get cleared."""
    if not (row.next_action or '').startswith(FIRST_OUTREACH_ACTION):
        return None
    if not row.stage or row.stage == 'Prospect':
        return None
    if row.stage == 'Contacted':
        contacted_day = (row.contacted_at or '')[:10] or (row.last_contact or '')[:10] or None
        if contacted_day and contacted_day > iso_add_days(today_iso, -COLD_AFTER_DAYS):
            lc = (row.last_contact or '')[:10]
            last = lc if lc and lc > contacted_day else contacted_day
            return NextActionChange(f'{FOLLOW_UP_ACTION}{_ask_suffix(row.next_action)}', iso_add_days(last, FOLLOW_UP_DAYS))
    return NextActionChange('', None)


def next_action_properties(change: NextActionChange) -> dict[str, Any]:
    """Notion property payload for a change."""
    return {
        'Next action': {'rich_text': [{'text': {'content': change.action}}] if change.action else []},
        'Next action date': {'date': {'start': change.date_iso} if change.date_iso else None},
    }

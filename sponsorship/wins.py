"""Win posts: announce a Won deal once in #operations with the running total toward the semester
goal. `announce_won_now` is the instant post from `/sponsor won` and the Won button; the hourly
job is `python -m sponsorship.jobs.win_post`, whose docstring explains the dedup.
"""
from __future__ import annotations

import dataclasses
import logging
import re

from slack_sdk import WebClient

from core import utils
from core.config import config
from core.job_log import JobLog
from core.notion import NotionUser
from core.slack import Indexed, MessageMarker, Slack
from sponsorship.models import PipelineRow, WonKind
from sponsorship.notion import SponsorNotion

logger = logging.getLogger(__name__)

__all__ = [
    'win_marker', 'win_claim_key', 'fmt_usd', 'total_raised', 'resolve_dri_mentions',
    'latest_won_note', 'announce_win_if_new', 'announce_won_now',
]


def win_marker(deal: PipelineRow) -> str:
    """Legacy in-text marker (still checked so old posts aren't re-announced)."""
    return f'sponsor-won:{deal.id}'

def win_claim_key(deal: PipelineRow) -> str:
    """Permanent Job Log key for "this deal's win has been announced"."""
    return f'sponsor-win {deal.id}'

def _win_meta(deal: PipelineRow) -> MessageMarker:
    return MessageMarker(event_type='sponsor_win', key='deal_id', value=deal.id)

def fmt_usd(n: float) -> str:
    return f'${utils.js_round(n):,}'

def total_raised(won: list[PipelineRow]) -> float:
    """Running total = money actually in `Received ($)` across Won deals, each deal counted once.
    Deliberately NO Deal-value fallback: a Won deal whose money hasn't landed yet contributes
    nothing to the raised counter (Arjun's rule, 2026-07-08)."""
    return sum(d.received or 0 for d in won)

def resolve_dri_mentions(
    client: WebClient, dri_user_ids: list[str], notion_users_by_id: dict[str, NotionUser], slack_dir: list[Indexed]
) -> list[str]:
    """A deal's DRI(s) as Slack @mentions for the shoutout. Falls back to the Notion display name if
    there's no Slack match, and drops DRIs we can't identify at all. The caller fetches the
    directories once and passes them in (avoids per-deal refetch)."""
    mentions: list[str] = []
    for notion_id in dri_user_ids:
        user = notion_users_by_id.get(notion_id)
        if not user:
            continue
        slack_id = Slack.wrap(client).notion_user_to_slack_id(user, slack_dir)
        if slack_id:
            mentions.append(f'<@{slack_id}>')
        elif user.name:
            mentions.append(user.name)
    return mentions

_WON_NOTE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}: WON — (.+)$', re.M)

def latest_won_note(deal: PipelineRow) -> str:
    """The deal's WON note from Notion, for cron-detected wins (the `/sponsor won` path passes the
    freshly typed note directly). mark_won prepends `<date>: WON — <note>`, so the first match is
    the latest."""
    m = _WON_NOTE_RE.search(deal.notes or '')
    return m.group(1).strip() if m else ''

def announce_win_if_new(
    client: WebClient,
    channel_id: str,
    deal: PipelineRow,
    total_usd: float,
    dri_mentions: list[str] | None = None,
    context_note: str = '',
) -> bool:
    """Announce one Won deal if it hasn't been posted to the channel yet. Returns True if posted.
    `context_note` adds an italic context line under the headline — for wins that don't fit the
    kind tags cleanly (e.g. "Pre-existing FSAE discount")."""
    dri_mentions = dri_mentions or []
    meta = _win_meta(deal)
    # Durable dedupe first — the one that holds once the post leaves the channel's recent history.
    # Claimed before posting, so a failed post is a missed win, never a re-post.
    if not JobLog.shared().claim_once(win_claim_key(deal), 'sponsor-win'):
        return False
    # Secondary guard for wins announced before the Job Log claim existed and still in recent
    # history. We've claimed above either way, so this costs at most one skipped post.
    if Slack.wrap(client).already_posted(channel_id, meta, win_marker(deal)):
        return False

    goal = config.sponsorship.semester_goal_usd
    pct = utils.js_round(total_usd / goal * 100) if goal > 0 else 0
    closing = f"Huge shoutout to {', '.join(dri_mentions)} for landing this one! 🙌" if dri_mentions else 'Nice work!'
    # Headline carries the deal's own value and kind; unrecorded fields just drop out.
    amount = deal.received if deal.received is not None else (deal.deal_value or 0)
    kind = f' ({deal.won_kind.lower()})' if deal.won_kind else ''
    amount_text = f' — {fmt_usd(amount)}' if amount > 0 else ''
    headline = f":tada: *New sponsor won: {deal.company or 'a new sponsor'}{amount_text}{kind}!*"
    context = re.sub(r'\s+', ' ', context_note.strip())[:200]
    context_line = f'_{context[0].upper()}{context[1:]}_\n' if context else ''
    text = (
        f'{headline}\n'
        f'{context_line}'
        f"We're now at *{fmt_usd(total_usd)} / {fmt_usd(goal)}* ({pct}%) toward the semester goal. {closing}"
    )

    client.chat_postMessage(channel=channel_id, text=text, unfurl_links=False, metadata=meta.metadata())
    logger.info(f'Win post: announced {deal.company} ({deal.id}).')
    return True

def announce_won_now(
    client: WebClient, notion: SponsorNotion, deal: PipelineRow, amount_usd: float, kind: WonKind | None, note: str
) -> bool:
    """Instant win post for a deal just marked Won from Slack (`/sponsor won` or the Won button):
    running total with a read-after-write guard, DRI shoutout, and the shared per-deal claim so the
    hourly job won't double-post. Returns True if it posted."""
    channel_id = Slack.wrap(client).resolve_channel_id(config.sponsorship.win_post_channel)
    if not channel_id:
        return False
    won = notion.query_won_deals()
    total = total_raised(won)
    if not any(d.id == deal.id for d in won):
        total += amount_usd
    notion_users_by_id = {u.id: u for u in notion.list_notion_users()}
    dri = resolve_dri_mentions(client, deal.dri_user_ids, notion_users_by_id, Slack.wrap(client).fetch_directory())
    announced = dataclasses.replace(deal, received=amount_usd, won_kind=kind or deal.won_kind)
    return announce_win_if_new(client, channel_id, announced, total, dri, note)

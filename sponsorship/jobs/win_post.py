"""Win post: when a Pipeline deal reaches Stage = Won, post ONCE to #operations with the running
total toward the semester goal. Gated to Won only (no prospect/stage/touch posts — that would be
spam). Announced once per deal, ever.

Two callers: the hourly cron (`run_win_post`) and the `/sponsor won` command (which calls
`announce_won_now` for an instant post). Both claim the same Job Log key, so whichever runs first
wins and the other skips — no duplicate.

DEDUP — why it's a Notion record and not a channel marker (bug, fixed 2026-09-15): this job
re-posts every Won deal it can't find a marker for, and `already_posted` only reads the most recent
200 messages of #operations. Once a win post scrolled past that window, the deal looked
un-announced and got announced again — and the fresh post scrolled out too, so old wins kept
resurfacing at random. The Job Log claim (`sponsor-win <deal id>`, permanent) can't scroll away;
the channel marker is kept only as a secondary guard for wins posted before this existed.

Wins announced before the claim existed are seeded by a one-time `WIN_POST_BACKFILL=true` run —
see `run_win_post`.

Run: `python -m sponsorship.jobs.win_post`
"""
from __future__ import annotations

import dataclasses
import os
import re
import sys

from slack_sdk import WebClient

from config import config
from utils.logger import logger
from utils.schedule import claim_once
from utils.text import js_round
from sponsorship.identity import Indexed, fetch_slack_directory, notion_user_to_slack_id
from sponsorship.models import NotionUser, PipelineRow, WonKind
from sponsorship.notion import SponsorNotion
from sponsorship.jobs.shared import WinMeta, already_posted, make_slack_client, metadata_for, resolve_channel_id


def win_marker(deal: PipelineRow) -> str:
    """Legacy in-text marker (still checked so old posts aren't re-announced)."""
    return f'sponsor-won:{deal.id}'


def win_claim_key(deal: PipelineRow) -> str:
    """Permanent Job Log key for "this deal's win has been announced"."""
    return f'sponsor-win {deal.id}'


def _win_meta(deal: PipelineRow) -> WinMeta:
    return WinMeta(event_type='sponsor_win', key='deal_id', value=deal.id)


def fmt_usd(n: float) -> str:
    return f'${js_round(n):,}'


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
        slack_id = notion_user_to_slack_id(client, user, slack_dir)
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
    if not claim_once(win_claim_key(deal), 'sponsor-win'):
        return False
    # Secondary guard for wins announced before the Job Log claim existed and still in recent
    # history. We've claimed above either way, so this costs at most one skipped post.
    if already_posted(client, channel_id, meta, win_marker(deal)):
        return False

    goal = config.sponsorship.semester_goal_usd
    pct = js_round(total_usd / goal * 100) if goal > 0 else 0
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

    client.chat_postMessage(channel=channel_id, text=text, unfurl_links=False, metadata=metadata_for(meta))
    logger.info(f'Win post: announced {deal.company} ({deal.id}).')
    return True


def run_win_post(backfill: bool | None = None) -> None:
    """WIN_POST_BACKFILL=true (one-time, at rollout): claim every currently-Won deal in the Job Log
    WITHOUT posting. Wins announced before the claim existed have no record, and the ones that
    already scrolled out of #operations' recent history would otherwise be re-announced on the next
    run — this seeds them as done. Run it once before the first normal run."""
    if backfill is None:
        backfill = (os.environ.get('WIN_POST_BACKFILL') or '').lower() == 'true'
    client = make_slack_client()
    notion = SponsorNotion()

    channel_id = resolve_channel_id(client, config.sponsorship.win_post_channel)
    if not channel_id:
        logger.error(f'Win post: could not resolve channel "{config.sponsorship.win_post_channel}".')
        return

    won = notion.query_won_deals()
    if not won:
        logger.info('Win post: no Won deals.')
        return

    if backfill:
        claimed = sum(1 for deal in won if claim_once(win_claim_key(deal), 'sponsor-win'))
        logger.info(f'Win post: backfill marked {claimed}/{len(won)} Won deals as announced — nothing posted.')
        return

    # Directories for DRI shoutouts — fetched once, reused across all deals.
    notion_users_by_id = {u.id: u for u in notion.list_notion_users()}
    slack_dir = fetch_slack_directory(client)

    total = total_raised(won)
    for deal in won:
        dri = resolve_dri_mentions(client, deal.dri_user_ids, notion_users_by_id, slack_dir)
        announce_win_if_new(client, channel_id, deal, total, dri, latest_won_note(deal))


def announce_won_now(
    client: WebClient, notion: SponsorNotion, deal: PipelineRow, amount_usd: float, kind: WonKind | None, note: str
) -> bool:
    """Instant win post for a deal just marked Won from Slack (`/sponsor won` or the Won button):
    running total with a read-after-write guard, DRI shoutout, and the shared per-deal claim so the
    hourly job won't double-post. Returns True if it posted."""
    channel_id = resolve_channel_id(client, config.sponsorship.win_post_channel)
    if not channel_id:
        return False
    won = notion.query_won_deals()
    total = total_raised(won)
    if not any(d.id == deal.id for d in won):
        total += amount_usd
    notion_users_by_id = {u.id: u for u in notion.list_notion_users()}
    dri = resolve_dri_mentions(client, deal.dri_user_ids, notion_users_by_id, fetch_slack_directory(client))
    announced = dataclasses.replace(deal, received=amount_usd, won_kind=kind or deal.won_kind)
    return announce_win_if_new(client, channel_id, announced, total, dri, note)


if __name__ == '__main__':
    try:
        run_win_post()
    except Exception as err:
        logger.error('Win post job failed.', err)
        sys.exit(1)

"""Wednesday 9 AM personalized stale DM: reads the Pipeline and DMs each member ONLY their own deals
whose Next action date is overdue, plus deals "gone cold" (at Contacted 30+ days, no reply) and
claims never contacted (Prospect 14+ days), each asked about once with one-tap buttons
(actions.py). A claim still at Prospect a week after that ask is released back to the Bank. No DM
if a member has none of these (silence is valid).

DMs post straight to the user ID (needs only `chat:write`, not `im:write`). Idempotency: the gate
is "Wednesday, 9am ET or later" (GitHub cron fires hours late — utils/schedule.py) and the ⚙️ Job
Log claim makes the second DST trigger a no-op.

Run: `python -m sponsorship.jobs.stale_dm`
"""
from __future__ import annotations

import math
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from utils.clock import parse_iso, to_iso
from utils.logger import logger
from utils.schedule import claim_job_run, is_slot_open_et
from sponsorship.dates import days_until, iso_add_days, today_iso_et
from sponsorship.deal_blocks import cold_deal_blocks, deal_list_blocks, stale_claim_blocks
from sponsorship.identity import fetch_slack_directory, notion_user_to_slack_id
from sponsorship.models import PipelineRow
from sponsorship.next_actions import COLD_AFTER_DAYS
from sponsorship.notion import COLD_ASKED_PROP, SponsorNotion
from sponsorship.jobs.quota_audit import fmt_date
from sponsorship.jobs.shared import make_slack_client


def _overdue_line(row: PipelineRow) -> str:
    overdue = abs(days_until(row.next_action_date)) if row.next_action_date else 0
    days = '1 day' if overdue == 1 else f'{overdue} days'
    nxt = f'Next: {row.next_action} — ' if row.next_action else ''
    return f"• <{row.url}|{row.company or 'Untitled'}> — {nxt}overdue by *{days}* (due {row.next_action_date})."


# A claim still at Prospect this many days after it was made gets asked "sent it, or release it?".
STALE_CLAIM_DAYS = 14
# Days after that ask before a claim still at Prospect is released back to the Bank.
RELEASE_AFTER_ASK_DAYS = 7

# Slack allows 50 blocks per message. Each deal takes 2 (line + buttons), plus up to 5 more (three
# headers, the released note, the footer): 2 × (10 + 6 + 6) + 5 = 49. Cold deals and claims past
# the cap wait for next Wednesday, because their "asked" date is stamped only on the ones shown.
MAX_OVERDUE_SHOWN = 10
MAX_COLD_SHOWN = 6
MAX_STALE_CLAIMS_SHOWN = 6


def _days_since(iso: str, now: datetime) -> int:
    return math.floor((now - parse_iso(iso)).total_seconds() / 86_400)


def _cold_line(row: PipelineRow, now: datetime) -> str:
    days = _days_since(row.contacted_at, now) if row.contacted_at else COLD_AFTER_DAYS
    on = fmt_date(row.contacted_at[:10]) if row.contacted_at else ''
    return f"<{row.url}|{row.company or 'Untitled'}> — contacted {on} ({days} days ago), no reply yet."


def _stale_claim_line(row: PipelineRow, now: datetime) -> str:
    on = fmt_date(row.created_time[:10]) if row.created_time else ''
    days = _days_since(row.created_time, now) if row.created_time else STALE_CLAIM_DAYS
    return f"<{row.url}|{row.company or 'Untitled'}> — claimed {on} ({days} days ago), not contacted yet."


def split_stale_claims(claims: list[PipelineRow], today_iso: str) -> tuple[list[PipelineRow], list[PipelineRow]]:
    """Which stale claims to release now and which to ask about → (release, ask). A claim asked
    about RELEASE_AFTER_ASK_DAYS+ ago and still at Prospect is released. So is one with no DRI
    that's a week past the ask threshold, since there's nobody to ask. The rest that were never
    asked get asked."""
    release_by = iso_add_days(today_iso, -RELEASE_AFTER_ASK_DAYS)
    ownerless_by = iso_add_days(today_iso, -(STALE_CLAIM_DAYS + RELEASE_AFTER_ASK_DAYS))
    release: list[PipelineRow] = []
    ask: list[PipelineRow] = []
    for d in claims:
        if d.stage != 'Prospect':
            continue
        if not d.dri_user_ids:
            if d.created_time and d.created_time[:10] <= ownerless_by:
                release.append(d)
        elif d.release_asked_at:
            if d.release_asked_at[:10] <= release_by:
                release.append(d)
        else:
            ask.append(d)
    return release, ask


@dataclass
class StaleDmInput:
    overdue: list[PipelineRow] = field(default_factory=list)
    cold: list[PipelineRow] = field(default_factory=list)
    # Claims to ask "sent it, or release it?" about.
    claims: list[PipelineRow] = field(default_factory=list)
    # Claims PERBot released this run, for the owner's heads-up.
    released: list[PipelineRow] = field(default_factory=list)


@dataclass
class StaleDm:
    text: str
    blocks: list[dict[str, Any]]
    cold_shown: list[PipelineRow]
    claims_shown: list[PipelineRow]


def _by_oldest(key: Callable[[PipelineRow], str | None]) -> Callable[[PipelineRow], str]:
    return lambda d: key(d) or ''


def build_stale_dm(data: StaleDmInput, slack_user_id: str, now: datetime | None = None) -> StaleDm:
    """One member's Wednesday DM: overdue next actions, deals gone cold, claims never contacted, and
    a note on any claims released. A deal shows once, in its most specific section (Slack rejects
    duplicate block ids)."""
    now = now or datetime.now(timezone.utc)
    overdue, cold, claims, released = data.overdue, data.cold, data.claims, data.released
    claims_shown = sorted(claims, key=_by_oldest(lambda d: d.created_time))[:MAX_STALE_CLAIMS_SHOWN]
    cold_shown = sorted(cold, key=_by_oldest(lambda d: d.contacted_at))[:MAX_COLD_SHOWN]
    elsewhere = {d.id for d in [*cold, *claims, *released]}
    overdue_all = [d for d in overdue if d.id not in elsewhere]
    overdue_shown = sorted(overdue_all, key=_by_oldest(lambda d: d.next_action_date))[:MAX_OVERDUE_SHOWN]

    def shown_note(shown: int, total: int) -> str:
        return f' _(oldest {shown} shown)_' if shown < total else ''

    blocks: list[dict[str, Any]] = []
    text: list[str] = []
    if overdue_shown:
        header = (
            f':wave: You have *{len(overdue_all)}* sponsorship deal(s) with an overdue next action:'
            f'{shown_note(len(overdue_shown), len(overdue_all))}'
        )
        blocks.extend(
            deal_list_blocks(header, overdue_shown, slack_user_id, line_for=lambda d: _overdue_line(d).removeprefix('• '))
        )
        text.extend([header, *(_overdue_line(d) for d in overdue_shown)])
    if cold_shown:
        header = (
            f':snowflake: *{len(cold)}* deal(s) contacted {COLD_AFTER_DAYS}+ days ago with no reply.'
            f'{shown_note(len(cold_shown), len(cold))} '
            'One tap each: still waiting, or close it out. Asked once per deal; the rest come next Wednesday.'
        )
        blocks.append({'type': 'section', 'text': {'type': 'mrkdwn', 'text': header}})
        for d in cold_shown:
            blocks.extend(cold_deal_blocks(d, slack_user_id, _cold_line(d, now)))
        text.extend([header, *(f'• {_cold_line(d, now)}' for d in cold_shown)])
    if claims_shown:
        header = (
            f':hourglass: *{len(claims)}* claim(s) {STALE_CLAIM_DAYS}+ days old, never contacted.'
            f'{shown_note(len(claims_shown), len(claims))} '
            'Sent it, or release it so someone else can. _Anything still at Prospect next Wednesday goes back to the Bank._'
        )
        blocks.append({'type': 'section', 'text': {'type': 'mrkdwn', 'text': header}})
        for d in claims_shown:
            blocks.extend(stale_claim_blocks(d, slack_user_id, _stale_claim_line(d, now)))
        text.extend([header, *(f'• {_stale_claim_line(d, now)}' for d in claims_shown)])
    if released:
        names = ', '.join(d.company or 'Untitled' for d in released)
        line = (
            f':unlock: Released back to the Bank (still at Prospect a week after asking): {names}. '
            'Want one back? `/sponsor claim <company>`.'
        )
        blocks.append({'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': line}]})
        text.append(line)
    footer = '_Use the buttons, or update in Notion / `/sponsor log` / `/sponsor stage`._'
    if blocks:
        blocks.append({'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': footer}]})
        text.extend(['', footer])
    return StaleDm(text='\n'.join(text), blocks=blocks, cold_shown=cold_shown, claims_shown=claims_shown)


def run_stale_dm(force: bool | None = None) -> None:
    if force is None:
        force = (os.environ.get('FORCE_STALE_DM') or '').lower() == 'true'
    if not force and not is_slot_open_et('Wednesday', 9):
        logger.info('Stale DM: not Wednesday ≥9:00 ET and not forced — skipping.')
        return
    # STALE_DRY_RUN=true logs each DM and makes no writes: no Slack, no Notion stamps or releases, no schema change.
    dry_run = (os.environ.get('STALE_DRY_RUN') or '').lower() == 'true'
    # Late-tolerant gate + two DST crons ⇒ dedupe via the Job Log (DM jobs can't read DM history).
    if not force and not dry_run and not claim_job_run('sponsor-stale-dm'):
        return

    client = make_slack_client()
    notion = SponsorNotion()
    today = today_iso_et()

    missing = notion.ensure_loss_columns(not dry_run)

    def days_ago(n: int) -> str:
        return to_iso(datetime.now(timezone.utc) - timedelta(days=n))

    with ThreadPoolExecutor(max_workers=3) as pool:
        f_stale = pool.submit(notion.query_stale_deals, today)
        f_cold = pool.submit(
            notion.query_cold_deals, days_ago(COLD_AFTER_DAYS), COLD_ASKED_PROP not in missing or not dry_run
        )
        f_claims = pool.submit(notion.query_stale_claims, days_ago(STALE_CLAIM_DAYS))
        stale, cold, stale_claims = f_stale.result(), f_cold.result(), f_claims.result()
    release, ask = split_stale_claims(stale_claims, today)
    release_names = f" ({', '.join(d.company or 'Untitled' for d in release)})" if release else ''
    logger.info(
        f'Stale DM: {len(stale)} overdue, {len(cold)} gone cold, {len(ask)} claim(s) to ask about, '
        f'{len(release)} to release{release_names}.'
    )

    # Release before DMing, so the heads-up only lists what actually went back.
    released: list[PipelineRow] = []
    for d in release:
        if dry_run:
            released.append(d)
            continue
        try:
            notion.release_claim(d)
            released.append(d)
        except Exception as err:
            logger.error(f'Stale DM: could not release {d.company or d.id}', err)

    # Group deals by their DRI(s).
    by_user: dict[str, StaleDmInput] = {}

    def bucket(notion_id: str) -> StaleDmInput:
        return by_user.setdefault(notion_id, StaleDmInput())

    for deal in stale:
        for i in deal.dri_user_ids:
            bucket(i).overdue.append(deal)
    for deal in cold:
        for i in deal.dri_user_ids:
            bucket(i).cold.append(deal)
    for deal in ask:
        for i in deal.dri_user_ids:
            bucket(i).claims.append(deal)
    for deal in released:
        for i in deal.dri_user_ids:
            bucket(i).released.append(deal)
    if not by_user:
        logger.info('Stale DM: nothing to send.')
        return

    # Build both directories once for identity resolution (email first, name fallback).
    notion_user_by_id = {u.id: u for u in notion.list_notion_users()}
    slack_dir = fetch_slack_directory(client)

    for notion_id, deals in by_user.items():
        notion_user = notion_user_by_id.get(notion_id)
        if not notion_user:
            logger.warn(f'Stale DM: DRI {notion_id} not in Notion directory — skipping.')
            continue

        slack_user_id = notion_user_to_slack_id(client, notion_user, slack_dir)
        if not slack_user_id:
            logger.warn(f'Stale DM: no Slack match for {notion_user.name or notion_id} — skipping.')
            continue

        dm = build_stale_dm(deals, slack_user_id)
        if not dm.blocks:
            continue
        if dry_run:
            logger.info(f'Stale DM (dry run) — would DM {notion_user.name or slack_user_id}:\n{dm.text}')
            continue

        # Post straight to the user ID — Slack opens the DM (needs only chat:write).
        client.chat_postMessage(channel=slack_user_id, text=dm.text, blocks=dm.blocks, unfurl_links=False)
        # Stamp after sending: a crash before this re-asks next week, which beats never asking.
        for d in dm.cold_shown:
            notion.stamp_cold_asked(d.id, today)
        for d in dm.claims_shown:
            notion.stamp_release_asked(d.id, today)
        logger.info(
            f'Stale DM: sent {notion_user.name or slack_user_id} {len(deals.overdue)} overdue + {len(dm.cold_shown)} cold + '
            f'{len(dm.claims_shown)} claim(s) asked + {len(deals.released)} released.'
        )


if __name__ == '__main__':
    try:
        run_stale_dm()
    except Exception as err:
        logger.error('Stale DM job failed.', err)
        sys.exit(1)

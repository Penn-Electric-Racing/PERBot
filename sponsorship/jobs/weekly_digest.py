"""Saturday 9 AM weekly digest — DMs only, never a channel post (Arjun's call, 2026-07-08): each
member with any live involvement (a non-Lost deal) gets the team progress line, the week's wins,
their own numbers, and their upcoming next actions. Members with no deals get nothing (silence is
valid, same as the stale DM).

Idempotency (same as the stale DM): the gate is "Saturday, 9am ET or later" because GitHub cron
fires hours late here (utils/schedule.py), and the ⚙️ Job Log claim makes the second DST trigger
(or any stray fire) a no-op. DMs post straight to the user ID.

Run: `python -m sponsorship.jobs.weekly_digest`
"""
from __future__ import annotations

import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from config import config
from utils.logger import logger
from utils.schedule import claim_job_run, is_slot_open_et
from utils.text import js_round
from sponsorship.dates import days_until
from sponsorship.deal_blocks import deal_list_blocks
from sponsorship.identity import fetch_slack_directory, notion_user_to_slack_id
from sponsorship.models import PipelineRow
from sponsorship.notion import SponsorNotion
from sponsorship.jobs.shared import make_slack_client
from sponsorship.jobs.win_post import fmt_usd, total_raised

_WON_DATE_RE = re.compile(r'^(\d{4}-\d{2}-\d{2}): WON\b', re.M)


def won_date_iso(deal: PipelineRow) -> str | None:
    """When a deal was won: the date of the newest `<date>: WON — …` line mark_won writes into
    Notes, falling back to Last contact (mark_won stamps that too)."""
    m = _WON_DATE_RE.search(deal.notes or '')
    return m.group(1) if m else deal.last_contact


def won_within_days(deals: list[PipelineRow], days: int) -> list[PipelineRow]:
    """Won deals whose win landed within the last `days` days."""
    out: list[PipelineRow] = []
    for d in deals:
        if d.stage != 'Won':
            continue
        iso = won_date_iso(d)
        if not iso:
            continue
        age = -days_until(iso)  # past dates → positive age
        if 0 <= age <= days:
            out.append(d)
    return out


def _win_line(deal: PipelineRow) -> str:
    amount = deal.received or 0
    kind = f' ({deal.won_kind.lower()})' if deal.won_kind else ''
    return f"{deal.company}{f' — {fmt_usd(amount)}' if amount > 0 else ''}{kind}"


NEXT_ACTIONS_SHOWN = 3


def _next_action_line(deal: PipelineRow) -> str:
    action = deal.next_action or 'no next action set'
    if not deal.next_action_date:
        return f"• <{deal.url}|{deal.company or 'Untitled'}> — {action}"
    overdue = ' ⚠️ overdue' if days_until(deal.next_action_date) < 0 else ''
    return f"• <{deal.url}|{deal.company or 'Untitled'}> — {action} (due {deal.next_action_date}{overdue})"


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def run_weekly_digest(force: bool | None = None) -> None:
    if force is None:
        force = (os.environ.get('FORCE_DIGEST') or '').lower() == 'true'
    if not force and not is_slot_open_et('Saturday', 9):
        logger.info('Weekly digest: not Saturday ≥9:00 ET and not forced — skipping.')
        return
    # Late-tolerant gate + two DST crons ⇒ dedupe via the Job Log (DM jobs can't read DM history).
    dry_run = (os.environ.get('DIGEST_DRY_RUN') or '').lower() == 'true'
    if not force and not dry_run and not claim_job_run('sponsor-weekly-digest'):
        return

    client = make_slack_client()
    notion = SponsorNotion()

    with ThreadPoolExecutor(max_workers=3) as pool:
        f_deals = pool.submit(notion.query_all_deals)
        f_users = pool.submit(notion.list_notion_users)
        f_prospects = pool.submit(notion.query_rankable_prospects)
        deals, notion_users, prospects = f_deals.result(), f_users.result(), f_prospects.result()

    won = [d for d in deals if d.stage == 'Won']
    total = total_raised(won)
    goal = config.sponsorship.semester_goal_usd
    pct = js_round(total / goal * 100) if goal > 0 else 0
    week_wins = won_within_days(deals, 7)
    available = sum(1 for p in prospects if p.status == 'Available')

    # Group every member's non-Lost deals (full co-credit, like the leaderboard).
    by_user: dict[str, list[PipelineRow]] = {}
    for deal in deals:
        if deal.stage == 'Lost':
            continue
        for dri_id in deal.dri_user_ids:
            by_user.setdefault(dri_id, []).append(deal)
    if not by_user:
        logger.info('Weekly digest: nobody has live deals — nothing to send.')
        return

    team_lines = [
        ':newspaper: *Weekly sponsorship digest*',
        f'*Team:* {fmt_usd(total)} / {fmt_usd(goal)} raised ({pct}%)',
    ]
    if week_wins:
        team_lines.append(f":tada: Won this week: {' · '.join(_win_line(d) for d in week_wins)}")

    notion_user_by_id = {u.id: u for u in notion_users}
    slack_dir = fetch_slack_directory(client)

    for notion_id, user_deals in by_user.items():
        notion_user = notion_user_by_id.get(notion_id)
        if not notion_user:
            logger.warn(f'Weekly digest: DRI {notion_id} not in Notion directory — skipping.')
            continue
        slack_user_id = notion_user_to_slack_id(client, notion_user, slack_dir)
        if not slack_user_id:
            logger.warn(f'Weekly digest: no Slack match for {notion_user.name or notion_id} — skipping.')
            continue

        my_won = [d for d in user_deals if d.stage == 'Won']
        my_won_usd = sum(d.received or 0 for d in my_won)
        my_active = [d for d in user_deals if d.stage != 'Won']
        won_text = f'{fmt_usd(my_won_usd)} won ({_plural(len(my_won), "win")})' if my_won_usd > 0 else 'no wins yet'
        you_line = f"*You:* {won_text} · {_plural(len(my_active), 'active deal')}"

        upcoming = sorted(my_active, key=lambda d: d.next_action_date or '9999')[:NEXT_ACTIONS_SHOWN]
        action_lines = ['*Your next actions:*', *(_next_action_line(d) for d in upcoming)] if upcoming else []

        footer = (
            f"_{available} researched lead{'' if available == 1 else 's'} available in the Bank — "
            '`/sponsor claim` one. `/sponsor leaderboard` for standings._'
        )

        text = '\n'.join([*team_lines, you_line, *action_lines, footer])
        # Blocks: the same content, with stage/touch buttons under each next-action deal.
        summary: dict[str, Any] = {'type': 'section', 'text': {'type': 'mrkdwn', 'text': '\n'.join([*team_lines, you_line])}}
        if upcoming:
            blocks = [
                summary,
                *deal_list_blocks(
                    '*Your next actions:*',
                    upcoming,
                    slack_user_id,
                    footer=footer,
                    line_for=lambda d: _next_action_line(d).removeprefix('• '),
                ),
            ]
        else:
            blocks = [summary, {'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': footer}]}]
        # DIGEST_DRY_RUN=true prints instead of DMing — for safe local verification.
        if dry_run:
            logger.info(f'Weekly digest (dry run) → {notion_user.name or slack_user_id}:\n{text}')
            continue
        client.chat_postMessage(channel=slack_user_id, text=text, blocks=blocks, unfurl_links=False)
        logger.info(f'Weekly digest: sent to {notion_user.name or slack_user_id}.')


if __name__ == '__main__':
    try:
        run_weekly_digest()
    except Exception as err:
        logger.error('Weekly digest job failed.', err)
        sys.exit(1)

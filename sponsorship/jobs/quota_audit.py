"""Saturday 10 AM ET weekly quota audit: every active member of the 👥 Ops Quota Roster (a Notion DB
ops leads maintain — no deploy to change who's on the hook) must have moved
`config.sponsorship.weekly_quota` of their Pipeline deals out of Prospect in the past week — i.e.
sent outreach. "Contacted this week" = the deal's `Contacted at` stamp falls inside
[last Sat 10:00 ET, this Sat 10:00 ET), credited to the deal's current DRI(s) — co-owned deals
credit each in full.

ONLY A DELIBERATE ACT IN SLACK STAMPS `Contacted at` (Arjun's rule, 2026-09-16):
`/sponsor stage <company> Contacted`, the stage buttons on a digest/stale DM, or `/sponsor won`.
Claiming a Bank lead doesn't count — it creates a Prospect deal and stamps nothing. Dragging a card
in Notion doesn't count either: "the row says Contacted" is not evidence anyone sent an email, and
dating such a move `now` credited weeks-old outreach to the current week (it read 11/3 for one
member on 2026-09-16 — see git log). Someone who moved the card in Notion first still earns credit
by running the command afterwards: `/sponsor stage` always writes, even when the stage already
matches.

Output: (1) one row per member per week upserted into 📋 Weekly Quota Audit — the durable record
of who met quota and who didn't; (2) ONE channel post (#perbot_spam) listing who met and
@-mentioning only those who didn't. Idempotent: the gate is "Saturday, 10am ET or later" (GitHub
cron fires hours late — core.utils.is_slot_open), and the per-week Slack metadata marker blocks a
duplicate post from any extra fire.

Env: FORCE_QUOTA_AUDIT=true runs off-schedule; QUOTA_DRY_RUN=true prints the post and skips every
write (Notion + Slack); QUOTA_WEEK_END=YYYY-MM-DD audits the week ending that (Saturday) date
instead of today — to backfill or re-check a past week.

Run: `python -m sponsorship.jobs.quota_audit`
"""
from __future__ import annotations

import logging
import os
import re
import sys

from core import aio, http, utils
from core.config import config
from core.log import setup_logging
from core.slack import Slack
from sponsorship.notion import SponsorNotion
from sponsorship.quota import (
    AUDIT_HOUR_ET,
    _quota_meta,
    _slack_mention_resolver,
    audit_window,
    build_follow_up_gap_line,
    build_quota_post,
    compute_quota_results,
    follow_up_gap_deals,
)

logger = logging.getLogger(__name__)


async def run_quota_audit(force: bool | None = None) -> int:
    """Returns the process exit code (1 when the audit was recorded but couldn't be posted)."""
    if force is None:
        force = (os.environ.get('FORCE_QUOTA_AUDIT') or '').lower() == 'true'
    # Late-tolerant gate (GitHub cron fires hours late here — see core.utils.is_slot_open); the per-week
    # Slack marker below keeps a second Saturday fire from reposting.
    if not force and not utils.is_slot_open('Saturday', AUDIT_HOUR_ET):
        logger.info(f'Quota audit: not Saturday ≥{AUDIT_HOUR_ET}:00 ET and not forced — skipping.')
        return 0
    dry_run = (os.environ.get('QUOTA_DRY_RUN') or '').lower() == 'true'
    quota = config.sponsorship.weekly_quota
    week_end_override = (os.environ.get('QUOTA_WEEK_END') or '').strip()
    if week_end_override and not re.match(r'^\d{4}-\d{2}-\d{2}$', week_end_override):
        raise ValueError(f'QUOTA_WEEK_END must be YYYY-MM-DD, got "{week_end_override}".')
    window = audit_window(week_end_override or None)
    logger.info(
        f'Quota audit: window {utils.to_iso(window.start)} → {utils.to_iso(window.end)} '
        f'(week ending {window.week_end_iso}), quota {quota}.'
    )

    client = Slack.shared()
    notion = SponsorNotion()

    f_members = aio.spawn(notion.query_quota_roster)
    f_deals = aio.spawn(notion.query_deals_edited_since, utils.to_iso(window.start))
    f_users = aio.spawn(notion.list_notion_users)
    f_contacted = aio.spawn(notion.query_contacted_deals)
    members, deals, notion_users, contacted_deals = (
        await f_members,
        await f_deals,
        await f_users,
        await f_contacted,
    )
    if not members:
        logger.warning('Quota audit: the Ops Quota Roster has no active members — nothing to audit.')
        return 0

    results = compute_quota_results(members, deals, window, quota)
    for r in results:
        companies = f" ({', '.join(d.company for d in r.deals)})" if r.deals else ''
        logger.info(f"Quota audit: {r.member.name} — {len(r.deals)}/{quota} {'MET' if r.met else 'missed'}{companies}")

    # Slack side: resolve mentions for the misses only (the met list uses plain names).
    slack_dir = await Slack.wrap(client).fetch_directory()
    resolve = _slack_mention_resolver(client, notion_users, slack_dir)
    mentions: dict[str, str | None] = {}
    for r in results:
        if r.met:
            continue
        mention = await resolve(r.member)
        if not mention:
            logger.warning(f'Quota audit: no Slack match for {r.member.name} — will use their name.')
        mentions[r.member.notion_user_id] = mention
    gap = follow_up_gap_deals(contacted_deals, window)
    gap_companies = f" ({', '.join(d.company for d in gap)})" if gap else ''
    logger.info(f'Quota audit: follow-up gap {len(gap)} deal(s){gap_companies}.')
    user_names = {u.id: u.name for u in notion_users}
    gap_line = build_follow_up_gap_line(gap, window, lambda i: user_names.get(i) or 'unknown')
    text = build_quota_post(results, window, quota, lambda m: mentions.get(m.notion_user_id), gap_line)

    if dry_run:
        logger.info(
            f'Quota audit (dry run) — would write {len(results)} audit rows and post to '
            f'#{config.sponsorship.quota_channel}:\n{text}'
        )
        return 0

    # Durable record first: one row per member per week (upsert — re-runs refresh in place).
    for r in results:
        ref = await notion.upsert_quota_audit_row(r)
        logger.info(f'Quota audit: recorded {r.member.name} (week ending {r.week_end_iso}) → {ref.url}')

    channel_id = await Slack.wrap(client).resolve_channel_id(config.sponsorship.quota_channel)
    if not channel_id:
        logger.error(
            f'Quota audit: channel "{config.sponsorship.quota_channel}" not found — audit recorded in Notion but not posted.'
        )
        return 1
    meta = _quota_meta(window.week_end_iso)
    if await Slack.wrap(client).already_posted(channel_id, meta, f'sponsor-quota-audit:{window.week_end_iso}'):
        logger.info(
            f'Quota audit: week ending {window.week_end_iso} already posted in #{config.sponsorship.quota_channel} '
            '— audit rows refreshed, no repost.'
        )
        return 0
    await client.chat_postMessage(channel=channel_id, text=text, metadata=meta.metadata(), unfurl_links=False)
    logger.info(
        f'Quota audit: posted to #{config.sponsorship.quota_channel} ({sum(1 for r in results if not r.met)} below quota).'
    )
    return 0


if __name__ == '__main__':
    setup_logging()
    try:
        sys.exit(http.run(run_quota_audit()))
    except Exception as err:
        logger.error('Quota audit job failed.', exc_info=err)
        sys.exit(1)

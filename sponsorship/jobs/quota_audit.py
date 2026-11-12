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
cron fires hours late — utils/schedule.py), and the per-week Slack metadata marker blocks a
duplicate post from any extra fire.

Env: FORCE_QUOTA_AUDIT=true runs off-schedule; QUOTA_DRY_RUN=true prints the post and skips every
write (Notion + Slack); QUOTA_WEEK_END=YYYY-MM-DD audits the week ending that (Saturday) date
instead of today — to backfill or re-check a past week.

Run: `python -m sponsorship.jobs.quota_audit`
"""
from __future__ import annotations

import os
import re
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Callable

from slack_sdk import WebClient

from config import config
from utils.clock import parse_iso, to_iso
from utils.logger import logger
from utils.schedule import is_slot_open_et
from sponsorship.dates import ET, et_wall_time_to_utc, iso_add_days, today_iso_et
from sponsorship.identity import Indexed, fetch_slack_directory, notion_user_to_slack_id
from sponsorship.models import NotionUser, PipelineRow, QuotaAuditResult, QuotaRosterMember
from sponsorship.notion import SponsorNotion
from sponsorship.jobs.shared import WinMeta, already_posted, make_slack_client, metadata_for, resolve_channel_id

AUDIT_HOUR_ET = 10

# Deals sharing ONE exact `Contacted at` instant, this many or more, with nothing else on the row
# to show outreach happened, are a single bulk write — a sync sweep or a Notion multi-row edit —
# not that many separate emails sent in the same minute. They're dropped from quota credit rather
# than counted.
#
# WHY: the stage sync's first run (2026-09-12) stamped 8 long-since-contacted deals with one
# timestamp and they all counted toward that week, showing a member at 11/3. A human bulk-editing
# Stage in Notion can still produce the same shape, so the audit refuses to read one write as N
# contacts.
#
# "Nothing else on the row" is what keeps this off real work: `/sponsor stage` stamps Last contact
# as it moves a deal, so three of those fired inside one minute each carry their own record of the
# contact and still count. A sweep leaves that column untouched.
BULK_STAMP_MIN = 3


@dataclass
class AuditWindow:
    # YYYY-MM-DD (ET) the window opens — Sat 10:00 ET.
    week_start_iso: str
    # YYYY-MM-DD (ET) the window closes — Sat 10:00 ET; the audit key.
    week_end_iso: str
    start: datetime
    end: datetime


def _has_own_contact_record(deal: PipelineRow, window: AuditWindow) -> bool:
    """True if the row itself records a contact inside the window — evidence independent of the stamp."""
    return bool(deal.last_contact) and deal.last_contact[:10] >= window.week_start_iso


def bulk_stamp_instants(deals: list[PipelineRow], window: AuditWindow) -> set[str]:
    """The `Contacted at` instants that look like one bulk write rather than real outreach: shared
    by BULK_STAMP_MIN+ deals that carry no contact record of their own."""
    counts = Counter(d.contacted_at for d in deals if d.contacted_at and not _has_own_contact_record(d, window))
    return {iso for iso, n in counts.items() if n >= BULK_STAMP_MIN}


def audit_window(week_end_iso: str | None = None) -> AuditWindow:
    """The audit window that ends at 10:00 ET on `week_end_iso` (defaults to today, ET) and opens
    exactly 7 days earlier. Defined in ET wall-clock so it doesn't drift across DST."""
    week_end_iso = week_end_iso or today_iso_et()
    week_start_iso = iso_add_days(week_end_iso, -7)
    return AuditWindow(
        week_start_iso=week_start_iso,
        week_end_iso=week_end_iso,
        start=et_wall_time_to_utc(week_start_iso, AUDIT_HOUR_ET),
        end=et_wall_time_to_utc(week_end_iso, AUDIT_HOUR_ET),
    )


def current_audit_window(now: datetime | None = None) -> AuditWindow:
    """The window currently in progress — ends at 10:00 ET on the next Saturday (today, if it's
    Saturday before 10am; next week's if the 10am audit has already run). Powers the
    `/sponsor quota` mid-week self-check so people see the same window Saturday will judge."""
    local = (now or datetime.now(timezone.utc)).astimezone(ET)
    # Python: Monday=0 … Saturday=5, Sunday=6.
    days_to_saturday = (5 - local.weekday()) % 7
    if days_to_saturday == 0 and local.hour >= AUDIT_HOUR_ET:
        days_to_saturday = 7
    return audit_window(iso_add_days(local.strftime('%Y-%m-%d'), days_to_saturday))


def compute_quota_results(
    members: list[QuotaRosterMember], deals: list[PipelineRow], window: AuditWindow, quota: float
) -> list[QuotaAuditResult]:
    """Pure audit: for each roster member, their deals (current DRI) whose `Contacted at` falls
    inside the window, and whether that count reaches the quota. `deals` may include rows outside
    the window (the Notion query is only lower-bounded)."""

    def in_window(iso: str) -> bool:
        t = parse_iso(iso)
        return window.start <= t < window.end

    inside = [d for d in deals if d.contacted_at and in_window(d.contacted_at)]
    # One bulk write is one event, however many rows it touched — never N contacts.
    bulk = bulk_stamp_instants(inside, window)
    contacted = [d for d in inside if d.contacted_at not in bulk or _has_own_contact_record(d, window)]
    if len(contacted) < len(inside):
        logger.warn(
            f'Quota audit: ignored {len(inside) - len(contacted)} deal(s) sharing a bulk "Contacted at" stamp '
            f"({', '.join(sorted(bulk))}) — one write, not outreach."
        )
    results: list[QuotaAuditResult] = []
    for member in members:
        mine = sorted(
            (d for d in contacted if member.notion_user_id in d.dri_user_ids), key=lambda d: d.contacted_at or ''
        )
        results.append(
            QuotaAuditResult(
                member=member,
                week_start_iso=window.week_start_iso,
                week_end_iso=window.week_end_iso,
                deals=mine,
                quota=quota,
                met=len(mine) >= quota,
            )
        )
    return results


# --- Follow-up gap ---------------------------------------------------------------

# Last season's heatmap (PER_sponsor_heatmap.html, 2026-10): of the 180 companies that never
# replied, 145 never got a single follow-up. Quoted in the post as the reason the line exists.
# Update it when the heatmap is regenerated.
NO_REPLY_NO_FOLLOWUP_PCT = 81

# Deals contacted more than this many days before the audit drop out of the gap. Past a month a
# nudge is rarely worth it, and an unbounded backlog (128 deals on the first dry run, 2026-10-22) is
# a number people stop reading.
FOLLOW_UP_MAX_AGE_DAYS = 30


def follow_up_gap_deals(deals: list[PipelineRow], window: AuditWindow) -> list[PipelineRow]:
    """Deals contacted 7–30 days before the audit (before this window opened, but not more than
    FOLLOW_UP_MAX_AGE_DAYS ago) that are still at Contacted, so no reply has moved them to In
    talks. Members rarely run `/sponsor log`. They only move stages, so the post words this as "no
    reply yet", not "no follow-up". A Last contact after the contact day (ET) still takes a deal
    out, so a touch that was logged counts. Deals with no `Contacted at` stamp are left out: there's
    no evidence of when, or whether, outreach went out."""
    oldest = window.end - timedelta(days=FOLLOW_UP_MAX_AGE_DAYS)
    out: list[PipelineRow] = []
    for d in deals:
        if d.stage != 'Contacted' or not d.contacted_at:
            continue
        contacted = parse_iso(d.contacted_at)
        if contacted >= window.start or contacted < oldest:
            continue
        contacted_day_et = contacted.astimezone(ET).strftime('%Y-%m-%d')
        if not d.last_contact or d.last_contact[:10] <= contacted_day_et:
            out.append(d)
    return out


def build_follow_up_gap_line(
    gap: list[PipelineRow], window: AuditWindow, name_for: Callable[[str], str]
) -> str | None:
    """One line for the quota post: how many deals are waiting on a follow-up, split by DRI. Plain
    names, no @-mentions. The post already pings the people below quota, and this line shouldn't
    add more pings. None when there's no gap, so the post stays short."""
    if not gap:
        return None
    per_owner: dict[str, int] = {}
    for d in gap:
        owners = [name_for(i) for i in d.dri_user_ids] if d.dri_user_ids else ['unassigned']
        for name in owners:
            per_owner[name] = per_owner.get(name, 0) + 1
    owners_text = ' · '.join(f'{name} {n}' for name, n in sorted(per_owner.items(), key=lambda kv: (-kv[1], kv[0])))
    noun = 'deal' if len(gap) == 1 else 'deals'
    return (
        f':mag: *Follow-up gap:* {len(gap)} {noun} contacted 7–{FOLLOW_UP_MAX_AGE_DAYS} days ago, no reply yet: '
        f'{owners_text}. _Last season, {NO_REPLY_NO_FOLLOWUP_PCT}% of sponsors who never replied never got a follow-up. '
        "Send one, or mark it `/sponsor stage <company> Lost` if it's dead._"
    )


def fmt_date(iso: str) -> str:
    """"2026-09-12" → "Sep 12"."""
    d = date.fromisoformat(iso[:10])
    return f"{d.strftime('%b')} {d.day}"


def _by_count_then_name(r: QuotaAuditResult) -> tuple[int, str]:
    # Most assignments first within each group, then by name — stable regardless of roster order.
    return (-len(r.deals), r.member.name)


def build_quota_post(
    results: list[QuotaAuditResult],
    window: AuditWindow,
    quota: float,
    mention_for: Callable[[QuotaRosterMember], str | None],
    follow_up_gap_line: str | None = None,
) -> str:
    """The channel post. `mention_for` returns `<@U…>` for a member, or None to fall back to their name."""
    met = sorted((r for r in results if r.met), key=_by_count_then_name)
    missed = sorted((r for r in results if not r.met), key=_by_count_then_name)
    total = len(results)
    plural = '' if quota == 1 else 's'

    lines = [
        f':clipboard: *Weekly sponsorship quota audit* — {fmt_date(window.week_start_iso)} → {fmt_date(window.week_end_iso)}',
        f'_Quota: {quota} sponsor{plural} contacted per ops member, logged with `/sponsor stage <company> Contacted`._',
    ]
    if met:
        lines.append(
            f":white_check_mark: *Met ({len(met)}/{total}):* {' · '.join(f'{r.member.name} ({len(r.deals)})' for r in met)}"
        )
    if missed:
        names = [f'{mention_for(r.member) or r.member.name} {len(r.deals)}/{quota}' for r in missed]
        lines.append(f":x: *Below quota ({len(missed)}/{total}):* {' · '.join(names)}")
    elif total > 0:
        lines.append(':tada: Everyone hit quota this week.')
    if follow_up_gap_line:
        lines.append(follow_up_gap_line)
    lines.append(
        f'_Record: <{config.sponsorship.quota_audit_url}|📋 Weekly Quota Audit>. Only the Slack command counts — '
        "claiming a lead or moving a card in Notion doesn't._"
    )
    return '\n'.join(lines)


def format_quota_standing(
    results: list[QuotaAuditResult], window: AuditWindow, quota: float, caller_notion_id: str | None
) -> str:
    """Ephemeral `/sponsor quota` text: the caller's own standing first (if they're on the roster),
    then the whole team's, so anyone can see where things stand before Saturday."""
    header = (
        f'*Sponsor quota — week of {fmt_date(window.week_start_iso)} → {fmt_date(window.week_end_iso)}* '
        f'(audited Sat 10am ET, posted to #{config.sponsorship.quota_channel})'
    )
    lines = [header]

    mine = next((r for r in results if r.member.notion_user_id == caller_notion_id), None) if caller_notion_id else None
    if mine:
        deals = (
            ' — ' + ', '.join(f"<{d.url}|{d.company or 'Untitled'}>" for d in mine.deals) if mine.deals else ''
        )
        remaining = quota - len(mine.deals)
        lines.append(
            f':white_check_mark: *You: {len(mine.deals)}/{quota}* — quota met{deals}'
            if mine.met
            else f':hourglass_flowing_sand: *You: {len(mine.deals)}/{quota}*{deals}. {remaining} more to contact by Saturday 10am.'
        )
    else:
        lines.append("_You're not on the Ops Quota Roster (ops leads can add you in Notion)._")

    ordered = sorted(results, key=_by_count_then_name)
    if ordered:
        met = sum(1 for r in ordered if r.met)
        team = ' · '.join(f"{'✅ ' if r.met else ''}{r.member.name} {len(r.deals)}/{quota}" for r in ordered)
        lines.append(f'*Team ({met}/{len(ordered)} met):* {team}')
    lines.append(
        '_Send outreach, then log it with `/sponsor stage <company> Contacted` — that command (or a stage button) '
        "is what counts. Claiming a lead or moving a card in Notion doesn't._"
    )
    return '\n'.join(lines)


def _quota_meta(week_end_iso: str) -> WinMeta:
    return WinMeta(event_type='sponsor_quota_audit', key='week_end', value=week_end_iso)


def _slack_mention_resolver(
    client: WebClient, notion_users: list[NotionUser], slack_dir: list[Indexed]
) -> Callable[[QuotaRosterMember], str | None]:
    """Roster member → Slack mention, via the Notion directory (email first, then name)."""
    by_id = {u.id: u for u in notion_users}

    def resolve(m: QuotaRosterMember) -> str | None:
        user = by_id.get(m.notion_user_id)
        if not user:
            return None
        slack_id = notion_user_to_slack_id(client, user, slack_dir)
        return f'<@{slack_id}>' if slack_id else None

    return resolve


def run_quota_audit(force: bool | None = None) -> int:
    """Returns the process exit code (1 when the audit was recorded but couldn't be posted)."""
    if force is None:
        force = (os.environ.get('FORCE_QUOTA_AUDIT') or '').lower() == 'true'
    # Late-tolerant gate (GitHub cron fires hours late here — see utils/schedule.py); the per-week
    # Slack marker below keeps a second Saturday fire from reposting.
    if not force and not is_slot_open_et('Saturday', AUDIT_HOUR_ET):
        logger.info(f'Quota audit: not Saturday ≥{AUDIT_HOUR_ET}:00 ET and not forced — skipping.')
        return 0
    dry_run = (os.environ.get('QUOTA_DRY_RUN') or '').lower() == 'true'
    quota = config.sponsorship.weekly_quota
    week_end_override = (os.environ.get('QUOTA_WEEK_END') or '').strip()
    if week_end_override and not re.match(r'^\d{4}-\d{2}-\d{2}$', week_end_override):
        raise ValueError(f'QUOTA_WEEK_END must be YYYY-MM-DD, got "{week_end_override}".')
    window = audit_window(week_end_override or None)
    logger.info(
        f'Quota audit: window {to_iso(window.start)} → {to_iso(window.end)} '
        f'(week ending {window.week_end_iso}), quota {quota}.'
    )

    client = make_slack_client()
    notion = SponsorNotion()

    with ThreadPoolExecutor(max_workers=4) as pool:
        f_members = pool.submit(notion.query_quota_roster)
        f_deals = pool.submit(notion.query_deals_edited_since, to_iso(window.start))
        f_users = pool.submit(notion.list_notion_users)
        f_contacted = pool.submit(notion.query_contacted_deals)
        members, deals, notion_users, contacted_deals = (
            f_members.result(),
            f_deals.result(),
            f_users.result(),
            f_contacted.result(),
        )
    if not members:
        logger.warn('Quota audit: the Ops Quota Roster has no active members — nothing to audit.')
        return 0

    results = compute_quota_results(members, deals, window, quota)
    for r in results:
        companies = f" ({', '.join(d.company for d in r.deals)})" if r.deals else ''
        logger.info(f"Quota audit: {r.member.name} — {len(r.deals)}/{quota} {'MET' if r.met else 'missed'}{companies}")

    # Slack side: resolve mentions for the misses only (the met list uses plain names).
    slack_dir = fetch_slack_directory(client)
    resolve = _slack_mention_resolver(client, notion_users, slack_dir)
    mentions: dict[str, str | None] = {}
    for r in results:
        if r.met:
            continue
        mention = resolve(r.member)
        if not mention:
            logger.warn(f'Quota audit: no Slack match for {r.member.name} — will use their name.')
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
        ref = notion.upsert_quota_audit_row(r)
        logger.info(f'Quota audit: recorded {r.member.name} (week ending {r.week_end_iso}) → {ref.url}')

    channel_id = resolve_channel_id(client, config.sponsorship.quota_channel)
    if not channel_id:
        logger.error(
            f'Quota audit: channel "{config.sponsorship.quota_channel}" not found — audit recorded in Notion but not posted.'
        )
        return 1
    meta = _quota_meta(window.week_end_iso)
    if already_posted(client, channel_id, meta, f'sponsor-quota-audit:{window.week_end_iso}'):
        logger.info(
            f'Quota audit: week ending {window.week_end_iso} already posted in #{config.sponsorship.quota_channel} '
            '— audit rows refreshed, no repost.'
        )
        return 0
    client.chat_postMessage(channel=channel_id, text=text, metadata=metadata_for(meta), unfurl_links=False)
    logger.info(
        f'Quota audit: posted to #{config.sponsorship.quota_channel} ({sum(1 for r in results if not r.met)} below quota).'
    )
    return 0


if __name__ == '__main__':
    try:
        sys.exit(run_quota_audit())
    except Exception as err:
        logger.error('Quota audit job failed.', err)
        sys.exit(1)

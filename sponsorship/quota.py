"""The weekly sponsorship quota: the audit window (Saturday 10 AM ET to Saturday), who contacted how
many deals in it, and the posts and standings built from that. The Saturday job that posts the
audit is `python -m sponsorship.jobs.quota_audit`; its docstring has the rules.
"""
from __future__ import annotations

import logging
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Callable

from slack_sdk import WebClient

from core import utils
from core.config import config
from core.notion import NotionUser
from core.slack import Indexed, MessageMarker, Slack
from sponsorship.models import PipelineRow, QuotaAuditResult, QuotaRosterMember

logger = logging.getLogger(__name__)

__all__ = [
    'AUDIT_HOUR_ET', 'BULK_STAMP_MIN', 'AuditWindow', 'bulk_stamp_instants', 'audit_window',
    'current_audit_window', 'compute_quota_results', 'NO_REPLY_NO_FOLLOWUP_PCT',
    'FOLLOW_UP_MAX_AGE_DAYS', 'follow_up_gap_deals', 'build_follow_up_gap_line', 'fmt_date',
    'build_quota_post', 'format_quota_standing',
]


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
    week_end_iso = week_end_iso or utils.today_iso()
    week_start_iso = utils.iso_add_days(week_end_iso, -7)
    return AuditWindow(
        week_start_iso=week_start_iso,
        week_end_iso=week_end_iso,
        start=utils.wall_time_to_utc(week_start_iso, AUDIT_HOUR_ET),
        end=utils.wall_time_to_utc(week_end_iso, AUDIT_HOUR_ET),
    )

def current_audit_window(now: datetime | None = None) -> AuditWindow:
    """The window currently in progress — ends at 10:00 ET on the next Saturday (today, if it's
    Saturday before 10am; next week's if the 10am audit has already run). Powers the
    `/sponsor quota` mid-week self-check so people see the same window Saturday will judge."""
    local = (now or datetime.now(timezone.utc)).astimezone(utils.EASTERN)
    # Python: Monday=0 … Saturday=5, Sunday=6.
    days_to_saturday = (5 - local.weekday()) % 7
    if days_to_saturday == 0 and local.hour >= AUDIT_HOUR_ET:
        days_to_saturday = 7
    return audit_window(utils.iso_add_days(local.strftime('%Y-%m-%d'), days_to_saturday))

def compute_quota_results(
    members: list[QuotaRosterMember], deals: list[PipelineRow], window: AuditWindow, quota: float
) -> list[QuotaAuditResult]:
    """Pure audit: for each roster member, their deals (current DRI) whose `Contacted at` falls
    inside the window, and whether that count reaches the quota. `deals` may include rows outside
    the window (the Notion query is only lower-bounded)."""

    def in_window(iso: str) -> bool:
        t = utils.parse_iso(iso)
        return window.start <= t < window.end

    inside = [d for d in deals if d.contacted_at and in_window(d.contacted_at)]
    # One bulk write is one event, however many rows it touched — never N contacts.
    bulk = bulk_stamp_instants(inside, window)
    contacted = [d for d in inside if d.contacted_at not in bulk or _has_own_contact_record(d, window)]
    if len(contacted) < len(inside):
        logger.warning(
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
        contacted = utils.parse_iso(d.contacted_at)
        if contacted >= window.start or contacted < oldest:
            continue
        contacted_day_et = contacted.astimezone(utils.EASTERN).strftime('%Y-%m-%d')
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

def _quota_meta(week_end_iso: str) -> MessageMarker:
    return MessageMarker(event_type='sponsor_quota_audit', key='week_end', value=week_end_iso)

def _slack_mention_resolver(
    client: WebClient, notion_users: list[NotionUser], slack_dir: list[Indexed]
) -> Callable[[QuotaRosterMember], str | None]:
    """Roster member → Slack mention, via the Notion directory (email first, then name)."""
    by_id = {u.id: u for u in notion_users}

    def resolve(m: QuotaRosterMember) -> str | None:
        user = by_id.get(m.notion_user_id)
        if not user:
            return None
        slack_id = Slack.wrap(client).notion_user_to_slack_id(user, slack_dir)
        return f'<@{slack_id}>' if slack_id else None

    return resolve

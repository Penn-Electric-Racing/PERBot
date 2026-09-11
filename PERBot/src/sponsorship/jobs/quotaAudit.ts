import type { WebClient } from '@slack/web-api';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { etWallTimeToUtc, isoAddDays, todayIsoET } from '../dates.js';
import { fetchSlackDirectory, Indexed, notionUserToSlackId } from '../identity.js';
import { SponsorNotion } from '../notion.js';
import { NotionUser, PipelineRow, QuotaAuditResult, QuotaRosterMember } from '../types.js';
import { syncDriLedger } from './driSync.js';
import { alreadyPosted, makeSlackClient, metadataFor, resolveChannelId, WinMeta } from './shared.js';

/**
 * Saturday 10 AM ET weekly quota audit: every active member of the 👥 Ops Quota Roster
 * (a Notion DB ops leads maintain — no deploy to change who's on the hook) must have
 * been assigned as DRI on `config.sponsorship.weeklyQuota` Pipeline deals in the past
 * week. "Assigned this week" = the member's DRI stamp on the deal (PERBot's `DRI assigned`
 * ledger, kept by jobs/driSync.ts; falls back to the deal's creation time) falls inside the
 * window [last Sat 10:00 ET, this Sat 10:00 ET). So new deals AND re-assignments onto
 * older deals count; co-owned deals credit each DRI in full (same rule as the leaderboard).
 *
 * Output: (1) one row per member per week upserted into 📋 Weekly Quota Audit — the
 * durable record of who met quota and who didn't; (2) ONE channel post (#perbot_spam)
 * listing who met and @-mentioning only those who didn't. Idempotent two ways: the
 * 10am-ET time gate makes the two DST cron triggers safe, and a per-week Slack
 * metadata marker blocks a duplicate post if the job is re-run by hand.
 *
 * Env: FORCE_QUOTA_AUDIT=true runs off-schedule; QUOTA_DRY_RUN=true prints the post and
 * skips every write (Notion + Slack); QUOTA_WEEK_END=YYYY-MM-DD audits the week ending
 * that (Saturday) date instead of today — to backfill or re-check a past week.
 */

const AUDIT_HOUR_ET = 10;

function isSaturday10amET(): boolean {
  const now = new Date();
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });
  const hour = Number(now.toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'America/New_York' }));
  return weekday === 'Saturday' && hour === AUDIT_HOUR_ET;
}

export interface AuditWindow {
  /** YYYY-MM-DD (ET) the window opens — Sat 10:00 ET. */
  weekStartIso: string;
  /** YYYY-MM-DD (ET) the window closes — Sat 10:00 ET; the audit key. */
  weekEndIso: string;
  start: Date;
  end: Date;
}

/**
 * The audit window that ends at 10:00 ET on `weekEndIso` (defaults to today, ET) and
 * opens exactly 7 days earlier. Defined in ET wall-clock so it doesn't drift across DST.
 */
export function auditWindow(weekEndIso: string = todayIsoET()): AuditWindow {
  const weekStartIso = isoAddDays(weekEndIso, -7);
  return {
    weekStartIso,
    weekEndIso,
    start: etWallTimeToUtc(weekStartIso, AUDIT_HOUR_ET),
    end: etWallTimeToUtc(weekEndIso, AUDIT_HOUR_ET),
  };
}

/**
 * The window currently in progress — ends at 10:00 ET on the next Saturday (today, if it's
 * Saturday before 10am; next week's if the 10am audit has already run). Powers the
 * `/sponsor quota` mid-week self-check so people see the same window Saturday will judge.
 */
export function currentAuditWindow(now: Date = new Date()): AuditWindow {
  const todayIso = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const weekday = now.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' });
  const hour = Number(now.toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'America/New_York' }));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  let daysToSaturday = (6 - dow + 7) % 7;
  if (daysToSaturday === 0 && hour >= AUDIT_HOUR_ET) daysToSaturday = 7;
  return auditWindow(isoAddDays(todayIso, daysToSaturday));
}

/** When `userId` was assigned to `deal`: the ledger stamp, else the deal's creation time. */
export function assignedAtIso(deal: PipelineRow, userId: string): string {
  return deal.driAssignedAt[userId.toLowerCase()] ?? deal.createdTime;
}

/**
 * Pure audit: for each roster member, the deals they were assigned to inside the window
 * (current DRI + assignment stamp in range), and whether that count reaches the quota.
 * `deals` may include rows outside the window (the Notion query is only lower-bounded).
 */
export function computeQuotaResults(
  members: QuotaRosterMember[],
  deals: PipelineRow[],
  window: AuditWindow,
  quota: number
): QuotaAuditResult[] {
  const inWindow = (iso: string) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return t >= window.start.getTime() && t < window.end.getTime();
  };
  return members.map((member) => {
    const mine = deals
      .filter((d) => d.driUserIds.includes(member.notionUserId) && inWindow(assignedAtIso(d, member.notionUserId)))
      .sort((a, b) => assignedAtIso(a, member.notionUserId).localeCompare(assignedAtIso(b, member.notionUserId)));
    return {
      member,
      weekStartIso: window.weekStartIso,
      weekEndIso: window.weekEndIso,
      deals: mine,
      quota,
      met: mine.length >= quota,
    };
  });
}

export function fmtDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Build the channel post. `mentionFor` returns `<@U…>` for a member, or null to fall back to their name. */
export function buildQuotaPost(
  results: QuotaAuditResult[],
  window: AuditWindow,
  quota: number,
  mentionFor: (m: QuotaRosterMember) => string | null
): string {
  // Most assignments first within each group, then by name — stable regardless of roster order.
  const byCountThenName = (a: QuotaAuditResult, b: QuotaAuditResult) =>
    b.deals.length - a.deals.length || a.member.name.localeCompare(b.member.name);
  const met = results.filter((r) => r.met).sort(byCountThenName);
  const missed = results.filter((r) => !r.met).sort(byCountThenName);
  const total = results.length;
  const plural = quota === 1 ? '' : 's';

  const lines = [
    `:clipboard: *Weekly sponsorship quota audit* — ${fmtDate(window.weekStartIso)} → ${fmtDate(window.weekEndIso)}`,
    `_Quota: ${quota} new sponsor assignment${plural} per ops member (Pipeline deals you were made DRI on this week — new or re-assigned)._`,
  ];
  if (met.length > 0) {
    lines.push(`:white_check_mark: *Met (${met.length}/${total}):* ${met.map((r) => `${r.member.name} (${r.deals.length})`).join(' · ')}`);
  }
  if (missed.length > 0) {
    const names = missed.map((r) => `${mentionFor(r.member) ?? r.member.name} ${r.deals.length}/${quota}`);
    lines.push(`:x: *Below quota (${missed.length}/${total}):* ${names.join(' · ')}`);
  } else if (total > 0) {
    lines.push(':tada: Everyone hit quota this week.');
  }
  lines.push(
    `_Record: <${config.sponsorship.quotaAuditUrl}|📋 Weekly Quota Audit>. Get assigned with \`/sponsor claim <company>\` or \`/sponsor add <company> @you\`._`
  );
  return lines.join('\n');
}

/**
 * Ephemeral `/sponsor quota` text: the caller's own standing first (if they're on the
 * roster), then the whole team's, so anyone can see where things stand before Saturday.
 */
export function formatQuotaStanding(
  results: QuotaAuditResult[],
  window: AuditWindow,
  quota: number,
  callerNotionId: string | null
): string {
  const header = `*Sponsor quota — week of ${fmtDate(window.weekStartIso)} → ${fmtDate(window.weekEndIso)}* (audited Sat 10am ET, posted to #${config.sponsorship.quotaChannel})`;
  const lines = [header];

  const mine = callerNotionId ? results.find((r) => r.member.notionUserId === callerNotionId) : undefined;
  if (mine) {
    const deals = mine.deals.length ? ` — ${mine.deals.map((d) => `<${d.url}|${d.company || 'Untitled'}>`).join(', ')}` : '';
    const remaining = quota - mine.deals.length;
    lines.push(
      mine.met
        ? `:white_check_mark: *You: ${mine.deals.length}/${quota}* — quota met${deals}`
        : `:hourglass_flowing_sand: *You: ${mine.deals.length}/${quota}*${deals}. ${remaining} more assignment${remaining === 1 ? '' : 's'} by Saturday 10am.`
    );
  } else {
    lines.push("_You're not on the Ops Quota Roster (ops leads can add you in Notion)._");
  }

  const sorted = [...results].sort(
    (a, b) => b.deals.length - a.deals.length || a.member.name.localeCompare(b.member.name)
  );
  if (sorted.length > 0) {
    const met = sorted.filter((r) => r.met).length;
    lines.push(
      `*Team (${met}/${sorted.length} met):* ${sorted.map((r) => `${r.met ? '✅ ' : ''}${r.member.name} ${r.deals.length}/${quota}`).join(' · ')}`
    );
  }
  lines.push('_Counts Pipeline deals you were made DRI on this week (new or re-assigned). `/sponsor claim <company>` or `/sponsor add <company> @you` to add one._');
  return lines.join('\n');
}

function quotaMeta(weekEndIso: string): WinMeta {
  return { eventType: 'sponsor_quota_audit', key: 'week_end', value: weekEndIso };
}

/** Roster member → Slack mention, via the Notion directory (email first, then name). */
async function slackMentionResolver(
  client: WebClient,
  notionUsers: NotionUser[],
  slackDir: Indexed[]
): Promise<(m: QuotaRosterMember) => Promise<string | null>> {
  const byId = new Map(notionUsers.map((u) => [u.id, u]));
  return async (m) => {
    const user = byId.get(m.notionUserId);
    if (!user) return null;
    const slackId = await notionUserToSlackId(client, user, slackDir);
    return slackId ? `<@${slackId}>` : null;
  };
}

export async function runQuotaAudit(
  force = process.env.FORCE_QUOTA_AUDIT?.toLowerCase() === 'true'
): Promise<void> {
  if (!force && !isSaturday10amET()) {
    logger.info('Quota audit: not Saturday 10am (ET) and not forced — skipping.');
    return;
  }
  const dryRun = process.env.QUOTA_DRY_RUN?.toLowerCase() === 'true';
  const quota = config.sponsorship.weeklyQuota;
  const weekEndOverride = process.env.QUOTA_WEEK_END?.trim();
  if (weekEndOverride && !/^\d{4}-\d{2}-\d{2}$/.test(weekEndOverride)) {
    throw new Error(`QUOTA_WEEK_END must be YYYY-MM-DD, got "${weekEndOverride}".`);
  }
  const window = auditWindow(weekEndOverride || undefined);
  logger.info(`Quota audit: window ${window.start.toISOString()} → ${window.end.toISOString()} (week ending ${window.weekEndIso}), quota ${quota}.`);

  const client = makeSlackClient();
  const notion = new SponsorNotion();

  // Bring the DRI ledger up to date first so re-assignments since the last hourly sync
  // are dated (skipped in dry runs — no writes — so counts may lag by up to an hour).
  if (!dryRun) await syncDriLedger(notion);

  const [members, deals, notionUsers] = await Promise.all([
    notion.queryQuotaRoster(),
    notion.queryDealsEditedSince(window.start.toISOString()),
    notion.listNotionUsers(),
  ]);
  if (members.length === 0) {
    logger.warn('Quota audit: the Ops Quota Roster has no active members — nothing to audit.');
    return;
  }

  const results = computeQuotaResults(members, deals, window, quota);
  for (const r of results) {
    logger.info(`Quota audit: ${r.member.name} — ${r.deals.length}/${quota} ${r.met ? 'MET' : 'missed'}${r.deals.length ? ` (${r.deals.map((d) => d.company).join(', ')})` : ''}`);
  }

  // Slack side: resolve mentions for the misses only (the met list uses plain names).
  const slackDir = await fetchSlackDirectory(client);
  const resolve = await slackMentionResolver(client, notionUsers, slackDir);
  const mentions = new Map<string, string | null>();
  for (const r of results) {
    if (r.met) continue;
    const mention = await resolve(r.member);
    if (!mention) logger.warn(`Quota audit: no Slack match for ${r.member.name} — will use their name.`);
    mentions.set(r.member.notionUserId, mention);
  }
  const text = buildQuotaPost(results, window, quota, (m) => mentions.get(m.notionUserId) ?? null);

  if (dryRun) {
    logger.info(`Quota audit (dry run) — would write ${results.length} audit rows and post to #${config.sponsorship.quotaChannel}:\n${text}`);
    return;
  }

  // Durable record first: one row per member per week (upsert — re-runs refresh in place).
  for (const r of results) {
    const ref = await notion.upsertQuotaAuditRow(r);
    logger.info(`Quota audit: recorded ${r.member.name} (week ending ${r.weekEndIso}) → ${ref.url}`);
  }

  const channelId = await resolveChannelId(client, config.sponsorship.quotaChannel);
  if (!channelId) {
    logger.error(`Quota audit: channel "${config.sponsorship.quotaChannel}" not found — audit recorded in Notion but not posted.`);
    process.exitCode = 1;
    return;
  }
  const meta = quotaMeta(window.weekEndIso);
  if (await alreadyPosted(client, channelId, meta, `sponsor-quota-audit:${window.weekEndIso}`)) {
    logger.info(`Quota audit: week ending ${window.weekEndIso} already posted in #${config.sponsorship.quotaChannel} — audit rows refreshed, no repost.`);
    return;
  }
  await client.chat.postMessage({ channel: channelId, text, metadata: metadataFor(meta), unfurl_links: false });
  logger.info(`Quota audit: posted to #${config.sponsorship.quotaChannel} (${results.filter((r) => !r.met).length} below quota).`);
}

// Entrypoint when run directly (GitHub Actions).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runQuotaAudit().catch((err) => {
    logger.error('Quota audit job failed.', err);
    process.exitCode = 1;
  });
}

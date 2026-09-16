import type { WebClient } from '@slack/web-api';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { isSlotOpenET } from '../../utils/schedule.js';
import { etWallTimeToUtc, isoAddDays, todayIsoET } from '../dates.js';
import { fetchSlackDirectory, Indexed, notionUserToSlackId } from '../identity.js';
import { SponsorNotion } from '../notion.js';
import { NotionUser, PipelineRow, QuotaAuditResult, QuotaRosterMember } from '../types.js';
import { syncContactedStamps } from './stageSync.js';
import { alreadyPosted, makeSlackClient, metadataFor, resolveChannelId, WinMeta } from './shared.js';

/**
 * Saturday 10 AM ET weekly quota audit: every active member of the 👥 Ops Quota Roster
 * (a Notion DB ops leads maintain — no deploy to change who's on the hook) must have
 * moved `config.sponsorship.weeklyQuota` of their Pipeline deals out of Prospect in the
 * past week — i.e. sent outreach. "Contacted this week" = the deal's `Contacted at` stamp
 * (first move Prospect → Contacted / In talks / Won; set by `/sponsor stage`/`won` or the
 * hourly stage sync for Notion edits) falls inside [last Sat 10:00 ET, this Sat 10:00 ET),
 * credited to the deal's current DRI(s) — co-owned deals credit each in full.
 *
 * Output: (1) one row per member per week upserted into 📋 Weekly Quota Audit — the
 * durable record of who met quota and who didn't; (2) ONE channel post (#perbot_spam)
 * listing who met and @-mentioning only those who didn't. Idempotent: the gate is
 * "Saturday, 10am ET or later" (GitHub cron fires hours late — utils/schedule.ts), and
 * the per-week Slack metadata marker blocks a duplicate post from any extra fire.
 *
 * Env: FORCE_QUOTA_AUDIT=true runs off-schedule; QUOTA_DRY_RUN=true prints the post and
 * skips every write (Notion + Slack); QUOTA_WEEK_END=YYYY-MM-DD audits the week ending
 * that (Saturday) date instead of today — to backfill or re-check a past week.
 */

const AUDIT_HOUR_ET = 10;

/**
 * Deals sharing ONE exact `Contacted at` instant, this many or more, with nothing else on
 * the row to show outreach happened, are a single bulk write — a sync sweep or a Notion
 * multi-row edit — not that many separate emails sent in the same minute. They're dropped
 * from quota credit rather than counted.
 *
 * WHY: the stage sync's first run (2026-09-12) stamped 8 long-since-contacted deals with
 * one timestamp and they all counted toward that week, showing a member at 11/3. The sync
 * no longer dates old deals `now` (stageSync.ts), but a human bulk-editing Stage in Notion
 * can still produce the same shape, so the audit refuses to read one write as N contacts.
 *
 * "Nothing else on the row" is what keeps this off real work: `/sponsor stage` stamps Last
 * contact as it moves a deal, so three of those fired inside one minute each carry their own
 * record of the contact and still count. A sweep leaves that column untouched.
 */
const BULK_STAMP_MIN = 3;

/** True if the row itself records a contact inside the window — evidence independent of the stamp. */
function hasOwnContactRecord(deal: PipelineRow, window: AuditWindow): boolean {
  return !!deal.lastContact && deal.lastContact.slice(0, 10) >= window.weekStartIso;
}

/**
 * The `Contacted at` instants that look like one bulk write rather than real outreach:
 * shared by BULK_STAMP_MIN+ deals that carry no contact record of their own.
 */
export function bulkStampInstants(deals: PipelineRow[], window: AuditWindow): Set<string> {
  const counts = new Map<string, number>();
  for (const d of deals) {
    if (!d.contactedAt || hasOwnContactRecord(d, window)) continue;
    counts.set(d.contactedAt, (counts.get(d.contactedAt) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n >= BULK_STAMP_MIN).map(([iso]) => iso));
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

/**
 * Pure audit: for each roster member, their deals (current DRI) whose `Contacted at` falls
 * inside the window, and whether that count reaches the quota. `deals` may include rows
 * outside the window (the Notion query is only lower-bounded).
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
  const inside = deals.filter((d) => d.contactedAt && inWindow(d.contactedAt));
  // One bulk write is one event, however many rows it touched — never N contacts.
  const bulk = bulkStampInstants(inside, window);
  const contacted = inside.filter((d) => !bulk.has(d.contactedAt!) || hasOwnContactRecord(d, window));
  if (contacted.length < inside.length) {
    logger.warn(
      `Quota audit: ignored ${inside.length - contacted.length} deal(s) sharing a bulk "Contacted at" stamp ` +
        `(${[...bulk].join(', ')}) — one write, not outreach.`
    );
  }
  return members.map((member) => {
    const mine = contacted
      .filter((d) => d.driUserIds.includes(member.notionUserId))
      .sort((a, b) => a.contactedAt!.localeCompare(b.contactedAt!));
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
    `_Quota: ${quota} sponsor${plural} contacted per ops member (your Pipeline deals moved Prospect → Contacted this week)._`,
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
    `_Record: <${config.sponsorship.quotaAuditUrl}|📋 Weekly Quota Audit>. Send outreach, then \`/sponsor stage <company> Contacted\`._`
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
        : `:hourglass_flowing_sand: *You: ${mine.deals.length}/${quota}*${deals}. ${remaining} more to contact by Saturday 10am.`
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
  lines.push('_Counts your Pipeline deals moved Prospect → Contacted this week. Send outreach, then `/sponsor stage <company> Contacted`._');
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
  // Late-tolerant gate (GitHub cron fires hours late here — see utils/schedule.ts); the
  // per-week Slack marker below keeps a second Saturday fire from reposting.
  if (!force && !isSlotOpenET('Saturday', AUDIT_HOUR_ET)) {
    logger.info(`Quota audit: not Saturday ≥${AUDIT_HOUR_ET}:00 ET and not forced — skipping.`);
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

  // Stamp any Notion-side stage moves since the last hourly sync first (skipped in dry
  // runs — no writes — so counts may lag by up to an hour).
  if (!dryRun) await syncContactedStamps(notion, false);

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

import { logger } from '../../utils/logger.js';
import { claimJobRun, isSlotOpenET } from '../../utils/schedule.js';
import { daysUntil, isoAddDays, todayIsoET } from '../dates.js';
import { fetchSlackDirectory, notionUserToSlackId } from '../identity.js';
import { COLD_ASKED_PROP, SponsorNotion } from '../notion.js';
import { NotionUser, PipelineRow } from '../types.js';
import { coldDealBlocks, dealListBlocks, staleClaimBlocks } from '../dealBlocks.js';
import { COLD_AFTER_DAYS } from '../nextActions.js';
import { fmtDate } from './quotaAudit.js';
import { makeSlackClient } from './shared.js';

/**
 * Wednesday 9 AM personalized stale DM: reads the Pipeline and DMs each member ONLY
 * their own deals whose Next action date is overdue, plus deals "gone cold" (at Contacted
 * 30+ days, no reply) and claims never contacted (Prospect 14+ days), each asked about
 * once with one-tap buttons (actions.ts). A claim still at Prospect a week after that ask
 * is released back to the Bank. No DM if a member has none of these (silence is valid).
 *
 * DMs post straight to the user ID (needs only `chat:write`, not `im:write`). Idempotency:
 * the gate is "Wednesday, 9am ET or later" (GitHub cron fires hours late — utils/
 * schedule.ts) and the ⚙️ Job Log claim makes the second DST trigger a no-op.
 */


function overdueLine(row: PipelineRow): string {
  const overdue = row.nextActionDate ? Math.abs(daysUntil(row.nextActionDate)) : 0;
  const days = overdue === 1 ? '1 day' : `${overdue} days`;
  const next = row.nextAction ? `Next: ${row.nextAction} — ` : '';
  return `• <${row.url}|${row.company || 'Untitled'}> — ${next}overdue by *${days}* (due ${row.nextActionDate}).`;
}

/** A claim still at Prospect this many days after it was made gets asked "sent it, or release it?". */
export const STALE_CLAIM_DAYS = 14;
/** Days after that ask before a claim still at Prospect is released back to the Bank. */
export const RELEASE_AFTER_ASK_DAYS = 7;

/**
 * Slack allows 50 blocks per message. Each deal takes 2 (line + buttons), plus up to 5
 * more (three headers, the released note, the footer): 2 × (10 + 6 + 6) + 5 = 49.
 * Cold deals and claims past the cap wait for next Wednesday, because their "asked" date
 * is stamped only on the ones actually shown.
 */
const MAX_OVERDUE_SHOWN = 10;
const MAX_COLD_SHOWN = 6;
const MAX_STALE_CLAIMS_SHOWN = 6;

const daysSince = (iso: string, now: Date) => Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);

function coldLine(row: PipelineRow, now: Date = new Date()): string {
  const days = row.contactedAt ? daysSince(row.contactedAt, now) : COLD_AFTER_DAYS;
  const on = row.contactedAt ? fmtDate(row.contactedAt.slice(0, 10)) : '';
  return `<${row.url}|${row.company || 'Untitled'}> — contacted ${on} (${days} days ago), no reply yet.`;
}

function staleClaimLine(row: PipelineRow, now: Date = new Date()): string {
  const on = row.createdTime ? fmtDate(row.createdTime.slice(0, 10)) : '';
  const days = row.createdTime ? daysSince(row.createdTime, now) : STALE_CLAIM_DAYS;
  return `<${row.url}|${row.company || 'Untitled'}> — claimed ${on} (${days} days ago), not contacted yet.`;
}

/**
 * Which stale claims to release now and which to ask about. A claim asked about
 * RELEASE_AFTER_ASK_DAYS+ ago and still at Prospect is released. So is one with no DRI
 * that's a week past the ask threshold, since there's nobody to ask. The rest that were
 * never asked get asked. Exported for tests.
 */
export function splitStaleClaims(claims: PipelineRow[], todayIso: string): { release: PipelineRow[]; ask: PipelineRow[] } {
  const releaseBy = isoAddDays(todayIso, -RELEASE_AFTER_ASK_DAYS);
  const ownerlessBy = isoAddDays(todayIso, -(STALE_CLAIM_DAYS + RELEASE_AFTER_ASK_DAYS));
  const release: PipelineRow[] = [];
  const ask: PipelineRow[] = [];
  for (const d of claims) {
    if (d.stage !== 'Prospect') continue;
    if (d.driUserIds.length === 0) {
      if (d.createdTime && d.createdTime.slice(0, 10) <= ownerlessBy) release.push(d);
    } else if (d.releaseAskedAt) {
      if (d.releaseAskedAt.slice(0, 10) <= releaseBy) release.push(d);
    } else {
      ask.push(d);
    }
  }
  return { release, ask };
}

export interface StaleDmInput {
  overdue: PipelineRow[];
  cold: PipelineRow[];
  /** Claims to ask "sent it, or release it?" about. */
  claims?: PipelineRow[];
  /** Claims PERBot released this run, for the owner's heads-up. */
  released?: PipelineRow[];
}

/**
 * One member's Wednesday DM: overdue next actions, deals gone cold, claims never
 * contacted, and a note on any claims released. A deal shows once, in its most
 * specific section (Slack rejects duplicate block ids). Exported for tests.
 */
export function buildStaleDm(
  input: StaleDmInput,
  slackUserId: string,
  now: Date = new Date()
): { text: string; blocks: any[]; coldShown: PipelineRow[]; claimsShown: PipelineRow[] } {
  const { overdue, cold, claims = [], released = [] } = input;
  const byOldest = (key: (d: PipelineRow) => string | null) => (a: PipelineRow, b: PipelineRow) => (key(a) ?? '').localeCompare(key(b) ?? '');
  const claimsShown = [...claims].sort(byOldest((d) => d.createdTime)).slice(0, MAX_STALE_CLAIMS_SHOWN);
  const coldShown = [...cold].sort(byOldest((d) => d.contactedAt)).slice(0, MAX_COLD_SHOWN);
  const elsewhere = new Set([...cold, ...claims, ...released].map((d) => d.id));
  const overdueAll = overdue.filter((d) => !elsewhere.has(d.id));
  const overdueShown = [...overdueAll].sort(byOldest((d) => d.nextActionDate)).slice(0, MAX_OVERDUE_SHOWN);
  const shownNote = (shown: number, total: number) => (shown < total ? ` _(oldest ${shown} shown)_` : '');

  const blocks: any[] = [];
  const text: string[] = [];
  if (overdueShown.length > 0) {
    const header = `:wave: You have *${overdueAll.length}* sponsorship deal(s) with an overdue next action:${shownNote(overdueShown.length, overdueAll.length)}`;
    blocks.push(...dealListBlocks(header, overdueShown, slackUserId, { lineFor: (d) => overdueLine(d).replace(/^• /, '') }));
    text.push(header, ...overdueShown.map(overdueLine));
  }
  if (coldShown.length > 0) {
    const header =
      `:snowflake: *${cold.length}* deal(s) contacted ${COLD_AFTER_DAYS}+ days ago with no reply.${shownNote(coldShown.length, cold.length)} ` +
      'One tap each: still waiting, or close it out. Asked once per deal; the rest come next Wednesday.';
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: header } });
    for (const d of coldShown) blocks.push(...coldDealBlocks(d, slackUserId, coldLine(d, now)));
    text.push(header, ...coldShown.map((d) => `• ${coldLine(d, now)}`));
  }
  if (claimsShown.length > 0) {
    const header =
      `:hourglass: *${claims.length}* claim(s) ${STALE_CLAIM_DAYS}+ days old, never contacted.${shownNote(claimsShown.length, claims.length)} ` +
      `Sent it, or release it so someone else can. _Anything still at Prospect next Wednesday goes back to the Bank._`;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: header } });
    for (const d of claimsShown) blocks.push(...staleClaimBlocks(d, slackUserId, staleClaimLine(d, now)));
    text.push(header, ...claimsShown.map((d) => `• ${staleClaimLine(d, now)}`));
  }
  if (released.length > 0) {
    const names = released.map((d) => d.company || 'Untitled').join(', ');
    const line = `:unlock: Released back to the Bank (still at Prospect a week after asking): ${names}. Want one back? \`/sponsor claim <company>\`.`;
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: line }] });
    text.push(line);
  }
  const footer = '_Use the buttons, or update in Notion / `/sponsor log` / `/sponsor stage`._';
  if (blocks.length > 0) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: footer }] });
    text.push('', footer);
  }
  return { text: text.join('\n'), blocks, coldShown, claimsShown };
}

interface Bucket {
  overdue: PipelineRow[];
  cold: PipelineRow[];
  claims: PipelineRow[];
  released: PipelineRow[];
}

export async function runStaleDm(force = process.env.FORCE_STALE_DM?.toLowerCase() === 'true'): Promise<void> {
  if (!force && !isSlotOpenET('Wednesday', 9)) {
    logger.info('Stale DM: not Wednesday ≥9:00 ET and not forced — skipping.');
    return;
  }
  // STALE_DRY_RUN=true logs each DM and makes no writes: no Slack, no Notion stamps or releases, no schema change.
  const dryRun = process.env.STALE_DRY_RUN?.toLowerCase() === 'true';
  // Late-tolerant gate + two DST crons ⇒ dedupe via the Job Log (DM jobs can't read DM history).
  if (!force && !dryRun && !(await claimJobRun('sponsor-stale-dm'))) return;

  const client = makeSlackClient();
  const notion = new SponsorNotion();
  const today = todayIsoET();

  const missing = await notion.ensureLossColumns(!dryRun);
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const [stale, cold, staleClaims] = await Promise.all([
    notion.queryStaleDeals(today),
    notion.queryColdDeals(daysAgo(COLD_AFTER_DAYS), !missing.includes(COLD_ASKED_PROP) || !dryRun),
    notion.queryStaleClaims(daysAgo(STALE_CLAIM_DAYS)),
  ]);
  const { release, ask } = splitStaleClaims(staleClaims, today);
  logger.info(
    `Stale DM: ${stale.length} overdue, ${cold.length} gone cold, ${ask.length} claim(s) to ask about, ${release.length} to release` +
      `${release.length ? ` (${release.map((d) => d.company || 'Untitled').join(', ')})` : ''}.`
  );

  // Release before DMing, so the heads-up only lists what actually went back.
  const released: PipelineRow[] = [];
  for (const d of release) {
    if (dryRun) {
      released.push(d);
      continue;
    }
    try {
      await notion.releaseClaim(d);
      released.push(d);
    } catch (err) {
      logger.error(`Stale DM: could not release ${d.company || d.id}`, err);
    }
  }

  // Group deals by their DRI(s).
  const byUser = new Map<string, Bucket>();
  const bucket = (id: string) => byUser.get(id) ?? byUser.set(id, { overdue: [], cold: [], claims: [], released: [] }).get(id)!;
  for (const deal of stale) for (const id of deal.driUserIds) bucket(id).overdue.push(deal);
  for (const deal of cold) for (const id of deal.driUserIds) bucket(id).cold.push(deal);
  for (const deal of ask) for (const id of deal.driUserIds) bucket(id).claims.push(deal);
  for (const deal of released) for (const id of deal.driUserIds) bucket(id).released.push(deal);
  if (byUser.size === 0) {
    logger.info('Stale DM: nothing to send.');
    return;
  }

  // Build both directories once for identity resolution (email first, name fallback).
  const notionUsers = await notion.listNotionUsers();
  const notionUserById = new Map<string, NotionUser>(notionUsers.map((u) => [u.id, u]));
  const slackDir = await fetchSlackDirectory(client);

  for (const [notionId, deals] of byUser) {
    const notionUser = notionUserById.get(notionId);
    if (!notionUser) {
      logger.warn(`Stale DM: DRI ${notionId} not in Notion directory — skipping.`);
      continue;
    }

    const slackUserId = await notionUserToSlackId(client, notionUser, slackDir);
    if (!slackUserId) {
      logger.warn(`Stale DM: no Slack match for ${notionUser.name || notionId} — skipping.`);
      continue;
    }

    const { text, blocks, coldShown, claimsShown } = buildStaleDm(deals, slackUserId);
    if (blocks.length === 0) continue;
    if (dryRun) {
      logger.info(`Stale DM (dry run) — would DM ${notionUser.name || slackUserId}:\n${text}`);
      continue;
    }

    // Post straight to the user ID — Slack opens the DM (needs only chat:write).
    await client.chat.postMessage({ channel: slackUserId, text, blocks, unfurl_links: false });
    // Stamp after sending: a crash before this re-asks next week, which beats never asking.
    for (const d of coldShown) await notion.stampColdAsked(d.id, today);
    for (const d of claimsShown) await notion.stampReleaseAsked(d.id, today);
    logger.info(
      `Stale DM: sent ${notionUser.name || slackUserId} ${deals.overdue.length} overdue + ${coldShown.length} cold + ` +
        `${claimsShown.length} claim(s) asked + ${deals.released.length} released.`
    );
  }
}

// Entrypoint when run directly (GitHub Actions).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runStaleDm().catch((err) => {
    logger.error('Stale DM job failed.', err);
    process.exitCode = 1;
  });
}

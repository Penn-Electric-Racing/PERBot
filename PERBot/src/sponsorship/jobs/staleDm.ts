import { logger } from '../../utils/logger.js';
import { claimJobRun, isSlotOpenET } from '../../utils/schedule.js';
import { daysUntil, todayIsoET } from '../dates.js';
import { fetchSlackDirectory, notionUserToSlackId } from '../identity.js';
import { COLD_ASKED_PROP, SponsorNotion } from '../notion.js';
import { NotionUser, PipelineRow } from '../types.js';
import { coldDealBlocks, dealListBlocks } from '../dealBlocks.js';
import { fmtDate } from './quotaAudit.js';
import { makeSlackClient } from './shared.js';

/**
 * Wednesday 9 AM personalized stale DM: reads the Pipeline and DMs each member ONLY
 * their own deals whose Next action date is overdue, plus deals "gone cold" (at Contacted
 * 30+ days, no reply), each asked about once with one-tap buttons (actions.ts). No DM if
 * a member has neither (silence is valid). Timed for weekly check-ins.
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

/** Contacted this many days ago with no reply → "gone cold": asked about once, in this DM. */
export const COLD_AFTER_DAYS = 30;

/**
 * Slack allows 50 blocks per message. Each deal takes 2 (line + buttons), and there are
 * up to 3 more (two headers + footer). Cold deals past the cap wait for next Wednesday,
 * because `Cold asked` is stamped only on the ones actually shown.
 */
const MAX_OVERDUE_SHOWN = 14;
const MAX_COLD_SHOWN = 8;

function coldLine(row: PipelineRow, now: Date = new Date()): string {
  const days = row.contactedAt ? Math.floor((now.getTime() - new Date(row.contactedAt).getTime()) / 86_400_000) : COLD_AFTER_DAYS;
  const on = row.contactedAt ? fmtDate(row.contactedAt.slice(0, 10)) : '';
  return `<${row.url}|${row.company || 'Untitled'}> — contacted ${on} (${days} days ago), no reply yet.`;
}

/**
 * One member's Wednesday DM: overdue next actions, then deals gone cold. A deal in both
 * lists shows once, under cold (Slack rejects duplicate block ids, and the cold buttons
 * are the decision that matters). Exported for tests.
 */
export function buildStaleDm(
  overdue: PipelineRow[],
  cold: PipelineRow[],
  slackUserId: string,
  now: Date = new Date()
): { text: string; blocks: any[]; coldShown: PipelineRow[] } {
  const coldShown = [...cold].sort((a, b) => (a.contactedAt ?? '').localeCompare(b.contactedAt ?? '')).slice(0, MAX_COLD_SHOWN);
  const coldIds = new Set(cold.map((d) => d.id));
  const overdueAll = overdue.filter((d) => !coldIds.has(d.id));
  const overdueShown = [...overdueAll]
    .sort((a, b) => (a.nextActionDate ?? '').localeCompare(b.nextActionDate ?? ''))
    .slice(0, MAX_OVERDUE_SHOWN);
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
  const footer = '_Use the buttons, or update in Notion / `/sponsor log` / `/sponsor stage`._';
  if (blocks.length > 0) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: footer }] });
    text.push('', footer);
  }
  return { text: text.join('\n'), blocks, coldShown };
}

export async function runStaleDm(force = process.env.FORCE_STALE_DM?.toLowerCase() === 'true'): Promise<void> {
  if (!force && !isSlotOpenET('Wednesday', 9)) {
    logger.info('Stale DM: not Wednesday ≥9:00 ET and not forced — skipping.');
    return;
  }
  // STALE_DRY_RUN=true logs each DM and makes no writes: no Slack, no Notion stamps, no schema change.
  const dryRun = process.env.STALE_DRY_RUN?.toLowerCase() === 'true';
  // Late-tolerant gate + two DST crons ⇒ dedupe via the Job Log (DM jobs can't read DM history).
  if (!force && !dryRun && !(await claimJobRun('sponsor-stale-dm'))) return;

  const client = makeSlackClient();
  const notion = new SponsorNotion();

  const missing = await notion.ensureLossColumns(!dryRun);
  const coldBefore = new Date(Date.now() - COLD_AFTER_DAYS * 86_400_000).toISOString();
  const [stale, cold] = await Promise.all([
    notion.queryStaleDeals(todayIsoET()),
    notion.queryColdDeals(coldBefore, !missing.includes(COLD_ASKED_PROP) || !dryRun),
  ]);
  if (stale.length === 0 && cold.length === 0) {
    logger.info('Stale DM: nothing overdue, nothing gone cold.');
    return;
  }
  logger.info(`Stale DM: ${stale.length} overdue, ${cold.length} gone cold.`);

  // Group deals by their DRI(s).
  const byUser = new Map<string, { overdue: PipelineRow[]; cold: PipelineRow[] }>();
  const bucket = (id: string) => byUser.get(id) ?? byUser.set(id, { overdue: [], cold: [] }).get(id)!;
  for (const deal of stale) for (const id of deal.driUserIds) bucket(id).overdue.push(deal);
  for (const deal of cold) for (const id of deal.driUserIds) bucket(id).cold.push(deal);

  // Build both directories once for identity resolution (email first, name fallback).
  const notionUsers = await notion.listNotionUsers();
  const notionUserById = new Map<string, NotionUser>(notionUsers.map((u) => [u.id, u]));
  const slackDir = await fetchSlackDirectory(client);

  const today = todayIsoET();
  for (const [notionId, deals] of byUser) {
    const notionUser = notionUserById.get(notionId);
    if (!notionUser) {
      logger.warn(`Stale DM: DRI ${notionId} not in Notion directory — skipping (${deals.overdue.length + deals.cold.length} deals).`);
      continue;
    }

    const slackUserId = await notionUserToSlackId(client, notionUser, slackDir);
    if (!slackUserId) {
      logger.warn(`Stale DM: no Slack match for ${notionUser.name || notionId} — skipping.`);
      continue;
    }

    const { text, blocks, coldShown } = buildStaleDm(deals.overdue, deals.cold, slackUserId);
    if (dryRun) {
      logger.info(`Stale DM (dry run) — would DM ${notionUser.name || slackUserId}:\n${text}`);
      continue;
    }

    // Post straight to the user ID — Slack opens the DM (needs only chat:write).
    await client.chat.postMessage({ channel: slackUserId, text, blocks, unfurl_links: false });
    // Stamp after sending: a crash before this re-asks next week, which beats never asking.
    for (const d of coldShown) await notion.stampColdAsked(d.id, today);
    logger.info(`Stale DM: sent ${notionUser.name || slackUserId} ${deals.overdue.length} overdue + ${coldShown.length} gone cold.`);
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

import { logger } from '../../utils/logger.js';
import { claimJobRun, isSlotOpenET } from '../../utils/schedule.js';
import { daysUntil, todayIsoET } from '../dates.js';
import { fetchSlackDirectory, notionUserToSlackId } from '../identity.js';
import { SponsorNotion } from '../notion.js';
import { NotionUser, PipelineRow } from '../types.js';
import { dealListBlocks } from '../dealBlocks.js';
import { makeSlackClient } from './shared.js';

/**
 * Wednesday 9 AM personalized stale DM: reads the Pipeline and DMs each member ONLY
 * their own deals whose Next action date is overdue. No DM if a member has nothing
 * overdue (silence is valid). Timed for weekly check-ins.
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

export async function runStaleDm(force = process.env.FORCE_STALE_DM?.toLowerCase() === 'true'): Promise<void> {
  if (!force && !isSlotOpenET('Wednesday', 9)) {
    logger.info('Stale DM: not Wednesday ≥9:00 ET and not forced — skipping.');
    return;
  }
  // Late-tolerant gate + two DST crons ⇒ dedupe via the Job Log (DM jobs can't read DM history).
  if (!force && !(await claimJobRun('sponsor-stale-dm'))) return;

  const client = makeSlackClient();
  const notion = new SponsorNotion();

  const stale = await notion.queryStaleDeals(todayIsoET());
  if (stale.length === 0) {
    logger.info('Stale DM: nothing overdue.');
    return;
  }

  // Group overdue deals by their DRI(s).
  const byUser = new Map<string, PipelineRow[]>();
  for (const deal of stale) {
    for (const driId of deal.driUserIds) {
      const list = byUser.get(driId) ?? [];
      list.push(deal);
      byUser.set(driId, list);
    }
  }

  // Build both directories once for identity resolution (email first, name fallback).
  const notionUsers = await notion.listNotionUsers();
  const notionUserById = new Map<string, NotionUser>(notionUsers.map((u) => [u.id, u]));
  const slackDir = await fetchSlackDirectory(client);

  for (const [notionId, deals] of byUser) {
    const notionUser = notionUserById.get(notionId);
    if (!notionUser) {
      logger.warn(`Stale DM: DRI ${notionId} not in Notion directory — skipping (${deals.length} deals).`);
      continue;
    }

    const slackUserId = await notionUserToSlackId(client, notionUser, slackDir);
    if (!slackUserId) {
      logger.warn(`Stale DM: no Slack match for ${notionUser.name || notionId} — skipping.`);
      continue;
    }

    const lines = deals
      .sort((a, b) => (a.nextActionDate ?? '').localeCompare(b.nextActionDate ?? ''))
      .map(overdueLine);
    const header = `:wave: You have *${deals.length}* sponsorship deal(s) with an overdue next action:`;
    const footer = '_Use the buttons, or update in Notion / `/sponsor log` / `/sponsor stage`._';
    const text = `${header}\n${lines.join('\n')}\n\n${footer}`;
    const sorted = deals.sort((a, b) => (a.nextActionDate ?? '').localeCompare(b.nextActionDate ?? ''));
    const blocks = dealListBlocks(header, sorted.slice(0, 20), slackUserId, {
      footer,
      lineFor: (d) => overdueLine(d).replace(/^• /, ''),
    });

    // Post straight to the user ID — Slack opens the DM (needs only chat:write).
    await client.chat.postMessage({ channel: slackUserId, text, blocks, unfurl_links: false });
    logger.info(`Stale DM: sent ${deals.length} overdue deal(s) to ${notionUser.name || slackUserId}.`);
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

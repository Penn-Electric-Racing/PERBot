import { logger } from '../../utils/logger.js';
import { daysUntil, todayIsoET } from '../dates.js';
import { fetchSlackDirectory, notionUserToSlackId } from '../identity.js';
import { SponsorNotion } from '../notion.js';
import { NotionUser, PipelineRow } from '../types.js';
import { makeSlackClient } from './shared.js';

/**
 * Wednesday 9 AM personalized stale DM: reads the Pipeline and DMs each member ONLY
 * their own deals whose Next action date is overdue. No DM if a member has nothing
 * overdue (silence is valid). Timed for weekly check-ins.
 *
 * DMs post straight to the user ID (needs only `chat:write`, not `im:write`). Idempotency
 * is a time gate: only the 9am-ET hour runs the work, so the two DST cron triggers (9am
 * EDT / 9am EST) don't both fire — only the one that lands on 9am ET does.
 */

function isWednesday9amET(): boolean {
  const now = new Date();
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });
  const hour = Number(now.toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'America/New_York' }));
  return weekday === 'Wednesday' && hour === 9;
}

function overdueLine(row: PipelineRow): string {
  const overdue = row.nextActionDate ? Math.abs(daysUntil(row.nextActionDate)) : 0;
  const days = overdue === 1 ? '1 day' : `${overdue} days`;
  const next = row.nextAction ? `Next: ${row.nextAction} — ` : '';
  return `• <${row.url}|${row.company || 'Untitled'}> — ${next}overdue by *${days}* (due ${row.nextActionDate}).`;
}

export async function runStaleDm(force = process.env.FORCE_STALE_DM?.toLowerCase() === 'true'): Promise<void> {
  if (!force && !isWednesday9amET()) {
    logger.info('Stale DM: not Wednesday 9am (ET) and not forced — skipping.');
    return;
  }

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
    const text =
      `:wave: You have *${deals.length}* sponsorship deal(s) with an overdue next action:\n` +
      `${lines.join('\n')}\n\n_Update them in Notion or log a touch with_ \`/sponsor log\`.`;

    // Post straight to the user ID — Slack opens the DM (needs only chat:write).
    await client.chat.postMessage({ channel: slackUserId, text, unfurl_links: false });
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

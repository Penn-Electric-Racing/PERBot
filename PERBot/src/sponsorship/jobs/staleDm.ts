import { logger } from '../../utils/logger.js';
import { daysUntil, todayIsoET } from '../dates.js';
import { SponsorNotion } from '../notion.js';
import { PipelineRow } from '../types.js';
import { channelHasMarker, makeSlackClient } from './shared.js';

/**
 * Wednesday 9 AM personalized stale DM: reads the Pipeline and DMs each member ONLY
 * their own deals whose Next action date is overdue. No DM if a member has nothing
 * overdue (silence is valid). Timed for weekly check-ins.
 *
 * Idempotency: time-check (Wednesday ET unless FORCE_STALE_DM) + per-user marker in
 * the DM so a double-fire doesn't re-DM.
 */

function isWednesdayET(): boolean {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' }) === 'Wednesday';
}

function overdueLine(row: PipelineRow): string {
  const overdue = row.nextActionDate ? Math.abs(daysUntil(row.nextActionDate)) : 0;
  const days = overdue === 1 ? '1 day' : `${overdue} days`;
  const next = row.nextAction ? `Next: ${row.nextAction} — ` : '';
  return `• <${row.url}|${row.company || 'Untitled'}> — ${next}overdue by *${days}* (due ${row.nextActionDate}).`;
}

export async function runStaleDm(force = process.env.FORCE_STALE_DM?.toLowerCase() === 'true'): Promise<void> {
  if (!force && !isWednesdayET()) {
    logger.info('Stale DM: not Wednesday (ET) and not forced — skipping.');
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

  const emailMap = await notion.listUserEmailMap(); // notionId -> email
  const marker = `sponsor-stale:${todayIsoET()}`;

  for (const [notionId, deals] of byUser) {
    const email = emailMap.get(notionId);
    if (!email) {
      logger.warn(`Stale DM: no email for Notion user ${notionId} — cannot DM (${deals.length} deals).`);
      continue;
    }

    let slackUserId: string;
    try {
      const lookup: any = await client.users.lookupByEmail({ email });
      slackUserId = lookup.user?.id;
      if (!slackUserId) throw new Error('no user id');
    } catch {
      logger.warn(`Stale DM: no Slack user for ${email} — skipping.`);
      continue;
    }

    const dm: any = await client.conversations.open({ users: slackUserId });
    const dmChannel: string = dm.channel?.id;
    if (!dmChannel) continue;

    if (await channelHasMarker(client, dmChannel, marker)) {
      logger.info(`Stale DM: already sent to ${email} today — skipping.`);
      continue;
    }

    const lines = deals
      .sort((a, b) => (a.nextActionDate ?? '').localeCompare(b.nextActionDate ?? ''))
      .map(overdueLine);
    const text =
      `:wave: You have *${deals.length}* sponsorship deal(s) with an overdue next action:\n` +
      `${lines.join('\n')}\n\n_Update them in Notion or log a touch with_ \`/sponsor log\`. ${marker}`;

    await client.chat.postMessage({ channel: dmChannel, text, unfurl_links: false });
    logger.info(`Stale DM: sent ${deals.length} overdue deal(s) to ${email}.`);
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

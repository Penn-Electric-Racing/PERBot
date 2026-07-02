import type { WebClient } from '@slack/web-api';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { SponsorNotion } from '../notion.js';
import { PipelineRow } from '../types.js';
import { alreadyPosted, makeSlackClient, metadataFor, resolveChannelId, WinMeta } from './shared.js';

/**
 * Win post: when a Pipeline deal reaches Stage = Won, post ONCE to #operations with
 * the running total toward the season goal. Gated to Won only (no prospect/stage/touch
 * posts — that would be spam). Idempotent via a per-deal marker in the channel.
 *
 * Two callers: the hourly cron (`runWinPost`) and the `/sponsor won` command (which
 * calls `announceWinIfNew` directly for an instant post). Both use the same marker, so
 * whichever runs first wins and the other skips — no duplicate.
 */

/** Legacy in-text marker (still checked so old posts aren't re-announced). */
export function winMarker(deal: PipelineRow): string {
  return `sponsor-won:${deal.id}`;
}

function winMeta(deal: PipelineRow): WinMeta {
  return { eventType: 'sponsor_win', key: 'deal_id', value: deal.id };
}

function fmtUsd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** Running total from Received ($) across Won deals (falls back to Deal value). */
export function totalRaised(won: PipelineRow[]): number {
  return won.reduce((sum, d) => sum + (d.received ?? d.dealValue ?? 0), 0);
}

/** Announce one Won deal if it hasn't been posted to the channel yet. Returns true if posted. */
export async function announceWinIfNew(
  client: WebClient,
  channelId: string,
  deal: PipelineRow,
  totalUsd: number
): Promise<boolean> {
  const meta = winMeta(deal);
  if (await alreadyPosted(client, channelId, meta, winMarker(deal))) return false; // already announced

  const goal = config.sponsorship.seasonGoalUsd;
  const pct = goal > 0 ? Math.round((totalUsd / goal) * 100) : 0;
  const text =
    `:tada: *New sponsor won: ${deal.company || 'a new sponsor'}!*\n` +
    `We're now at *${fmtUsd(totalUsd)} / ${fmtUsd(goal)}* (${pct}%) toward the season goal. Nice work!`;

  await client.chat.postMessage({ channel: channelId, text, unfurl_links: false, metadata: metadataFor(meta) });
  logger.info(`Win post: announced ${deal.company} (${deal.id}).`);
  return true;
}

export async function runWinPost(): Promise<void> {
  const client = makeSlackClient();
  const notion = new SponsorNotion();

  const channelId = await resolveChannelId(client, config.sponsorship.winPostChannel);
  if (!channelId) {
    logger.error(`Win post: could not resolve channel "${config.sponsorship.winPostChannel}".`);
    return;
  }

  const won = await notion.queryWonDeals();
  if (won.length === 0) {
    logger.info('Win post: no Won deals.');
    return;
  }

  const total = totalRaised(won);
  for (const deal of won) {
    await announceWinIfNew(client, channelId, deal, total);
  }
}

// Entrypoint when run directly (GitHub Actions).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runWinPost().catch((err) => {
    logger.error('Win post job failed.', err);
    process.exitCode = 1;
  });
}

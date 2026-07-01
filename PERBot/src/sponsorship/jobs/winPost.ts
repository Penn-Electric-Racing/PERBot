import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { SponsorNotion } from '../notion.js';
import { PipelineRow } from '../types.js';
import { channelHasMarker, makeSlackClient, resolveChannelId } from './shared.js';

/**
 * Win post: when a Pipeline deal reaches Stage = Won, post ONCE to #operations with
 * the running total toward the season goal. Gated to Won only (no prospect/stage/touch
 * posts — that would be spam). Idempotent via a per-deal marker in the channel.
 *
 * Run on a short cron (e.g. every 15 min). Each run announces only Won deals not yet
 * announced, so re-runs and double-fires are safe.
 */

function markerFor(deal: PipelineRow): string {
  return `sponsor-won:${deal.id}`;
}

function fmtUsd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
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

  // Running total uses Received ($) — the live counter — falling back to Deal value.
  const goal = config.sponsorship.seasonGoalUsd;
  const total = won.reduce((sum, d) => sum + (d.received ?? d.dealValue ?? 0), 0);
  const pct = goal > 0 ? Math.round((total / goal) * 100) : 0;

  for (const deal of won) {
    const marker = markerFor(deal);
    if (await channelHasMarker(client, channelId, marker)) continue; // already announced

    const text =
      `:tada: *New sponsor won: ${deal.company || 'a new sponsor'}!*\n` +
      `We're now at *${fmtUsd(total)} / ${fmtUsd(goal)}* (${pct}%) toward the season goal. ` +
      `Nice work! ${marker}`;

    await client.chat.postMessage({ channel: channelId, text, unfurl_links: false });
    logger.info(`Win post: announced ${deal.company} (${deal.id}).`);
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

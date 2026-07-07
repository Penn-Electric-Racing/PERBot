import type { WebClient } from '@slack/web-api';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { fetchSlackDirectory, Indexed, notionUserToSlackId } from '../identity.js';
import { SponsorNotion } from '../notion.js';
import { NotionUser, PipelineRow } from '../types.js';
import { alreadyPosted, makeSlackClient, metadataFor, resolveChannelId, WinMeta } from './shared.js';

/**
 * Win post: when a Pipeline deal reaches Stage = Won, post ONCE to #operations with
 * the running total toward the semester goal. Gated to Won only (no prospect/stage/touch
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

/**
 * Resolve a deal's DRI(s) to Slack @mentions for the shoutout. Falls back to the Notion
 * display name if there's no Slack match, and drops DRIs we can't identify at all. The
 * caller fetches the directories once and passes them in (avoids per-deal refetch).
 */
export async function resolveDriMentions(
  client: WebClient,
  driUserIds: string[],
  notionUsersById: Map<string, NotionUser>,
  slackDir: Indexed[]
): Promise<string[]> {
  const mentions: string[] = [];
  for (const notionId of driUserIds) {
    const user = notionUsersById.get(notionId);
    if (!user) continue;
    const slackId = await notionUserToSlackId(client, user, slackDir);
    if (slackId) mentions.push(`<@${slackId}>`);
    else if (user.name) mentions.push(user.name);
  }
  return mentions;
}

/**
 * The deal's WON note from Notion, for cron-detected wins (the `/sponsor won` path
 * passes the freshly typed note directly). markWon prepends `<date>: WON — <note>`,
 * so the first match is the latest.
 */
export function latestWonNote(deal: PipelineRow): string {
  return deal.notes.match(/^\d{4}-\d{2}-\d{2}: WON — (.+)$/m)?.[1]?.trim() ?? '';
}

/** Announce one Won deal if it hasn't been posted to the channel yet. Returns true if posted.
 *  `contextNote` adds an italic context line under the headline — for wins that don't fit
 *  the kind tags cleanly (e.g. "Pre-existing FSAE discount"). */
export async function announceWinIfNew(
  client: WebClient,
  channelId: string,
  deal: PipelineRow,
  totalUsd: number,
  driMentions: string[] = [],
  contextNote = ''
): Promise<boolean> {
  const meta = winMeta(deal);
  if (await alreadyPosted(client, channelId, meta, winMarker(deal))) return false; // already announced

  const goal = config.sponsorship.semesterGoalUsd;
  const pct = goal > 0 ? Math.round((totalUsd / goal) * 100) : 0;
  const closing = driMentions.length
    ? `Huge shoutout to ${driMentions.join(', ')} for landing this one! 🙌`
    : 'Nice work!';
  // Headline carries the deal's own value and kind; unrecorded fields just drop out.
  const amount = deal.received ?? deal.dealValue ?? 0;
  const kind = deal.wonKind ? ` (${deal.wonKind.toLowerCase()})` : '';
  const headline = `:tada: *New sponsor won: ${deal.company || 'a new sponsor'}${amount > 0 ? ` — ${fmtUsd(amount)}` : ''}${kind}!*`;
  const context = contextNote.trim().replace(/\s+/g, ' ').slice(0, 200);
  const contextLine = context ? `_${context.charAt(0).toUpperCase()}${context.slice(1)}_\n` : '';
  const text =
    `${headline}\n` +
    contextLine +
    `We're now at *${fmtUsd(totalUsd)} / ${fmtUsd(goal)}* (${pct}%) toward the semester goal. ${closing}`;

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

  // Directories for DRI shoutouts — fetched once, reused across all deals.
  const notionUsersById = new Map((await notion.listNotionUsers()).map((u) => [u.id, u]));
  const slackDir = await fetchSlackDirectory(client);

  const total = totalRaised(won);
  for (const deal of won) {
    const dri = await resolveDriMentions(client, deal.driUserIds, notionUsersById, slackDir);
    await announceWinIfNew(client, channelId, deal, total, dri, latestWonNote(deal));
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

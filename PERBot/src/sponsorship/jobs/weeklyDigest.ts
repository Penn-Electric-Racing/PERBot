import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import { daysUntil, todayIsoET } from '../dates.js';
import { fetchSlackDirectory, notionUserToSlackId } from '../identity.js';
import { SponsorNotion } from '../notion.js';
import { NotionUser, PipelineRow } from '../types.js';
import { makeSlackClient } from './shared.js';
import { totalRaised } from './winPost.js';

/**
 * Saturday 9 AM weekly digest — DMs only, never a channel post (Arjun's call,
 * 2026-07-08): each member with any live involvement (a non-Lost deal) gets the team
 * progress line, the week's wins, their own numbers, and their upcoming next actions.
 * Members with no deals get nothing (silence is valid, same as the stale DM).
 *
 * Same idempotency as the stale DM: two DST cron triggers, and only the one landing
 * on 9am ET runs the work. DMs post straight to the user ID (chat:write only).
 */

function isSaturday9amET(): boolean {
  const now = new Date();
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });
  const hour = Number(now.toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'America/New_York' }));
  return weekday === 'Saturday' && hour === 9;
}

function fmtUsd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/**
 * When a deal was won: the date of the newest `<date>: WON — …` line markWon writes
 * into Notes, falling back to Last contact (markWon stamps that too).
 */
export function wonDateIso(deal: PipelineRow): string | null {
  return deal.notes.match(/^(\d{4}-\d{2}-\d{2}): WON\b/m)?.[1] ?? deal.lastContact;
}

/** Won deals whose win landed within the last `days` days. */
export function wonWithinDays(deals: PipelineRow[], days: number): PipelineRow[] {
  return deals.filter((d) => {
    if (d.stage !== 'Won') return false;
    const iso = wonDateIso(d);
    if (!iso) return false;
    const age = -daysUntil(iso); // past dates → positive age
    return age >= 0 && age <= days;
  });
}

function winLine(deal: PipelineRow): string {
  const amount = deal.received ?? 0;
  const kind = deal.wonKind ? ` (${deal.wonKind.toLowerCase()})` : '';
  return `${deal.company}${amount > 0 ? ` — ${fmtUsd(amount)}` : ''}${kind}`;
}

const NEXT_ACTIONS_SHOWN = 3;

function nextActionLine(deal: PipelineRow): string {
  const action = deal.nextAction || 'no next action set';
  if (!deal.nextActionDate) return `• <${deal.url}|${deal.company || 'Untitled'}> — ${action}`;
  const overdue = daysUntil(deal.nextActionDate) < 0 ? ' ⚠️ overdue' : '';
  return `• <${deal.url}|${deal.company || 'Untitled'}> — ${action} (due ${deal.nextActionDate}${overdue})`;
}

export async function runWeeklyDigest(force = process.env.FORCE_DIGEST?.toLowerCase() === 'true'): Promise<void> {
  if (!force && !isSaturday9amET()) {
    logger.info('Weekly digest: not Saturday 9am (ET) and not forced — skipping.');
    return;
  }

  const client = makeSlackClient();
  const notion = new SponsorNotion();

  const [deals, notionUsers, prospects] = await Promise.all([
    notion.queryAllDeals(),
    notion.listNotionUsers(),
    notion.queryRankableProspects(),
  ]);

  const won = deals.filter((d) => d.stage === 'Won');
  const total = totalRaised(won);
  const goal = config.sponsorship.semesterGoalUsd;
  const pct = goal > 0 ? Math.round((total / goal) * 100) : 0;
  const weekWins = wonWithinDays(deals, 7);
  const available = prospects.filter((p) => p.status === 'Available').length;

  // Group every member's non-Lost deals (full co-credit, like the leaderboard).
  const byUser = new Map<string, PipelineRow[]>();
  for (const deal of deals) {
    if (deal.stage === 'Lost') continue;
    for (const driId of deal.driUserIds) {
      const list = byUser.get(driId) ?? [];
      list.push(deal);
      byUser.set(driId, list);
    }
  }
  if (byUser.size === 0) {
    logger.info('Weekly digest: nobody has live deals — nothing to send.');
    return;
  }

  const teamLines = [
    ':newspaper: *Weekly sponsorship digest*',
    `*Team:* ${fmtUsd(total)} / ${fmtUsd(goal)} raised (${pct}%)`,
  ];
  if (weekWins.length > 0) {
    teamLines.push(`:tada: Won this week: ${weekWins.map(winLine).join(' · ')}`);
  }

  const notionUserById = new Map<string, NotionUser>(notionUsers.map((u) => [u.id, u]));
  const slackDir = await fetchSlackDirectory(client);

  for (const [notionId, userDeals] of byUser) {
    const notionUser = notionUserById.get(notionId);
    if (!notionUser) {
      logger.warn(`Weekly digest: DRI ${notionId} not in Notion directory — skipping.`);
      continue;
    }
    const slackUserId = await notionUserToSlackId(client, notionUser, slackDir);
    if (!slackUserId) {
      logger.warn(`Weekly digest: no Slack match for ${notionUser.name || notionId} — skipping.`);
      continue;
    }

    const myWon = userDeals.filter((d) => d.stage === 'Won');
    const myWonUsd = myWon.reduce((sum, d) => sum + (d.received ?? 0), 0);
    const myActive = userDeals.filter((d) => d.stage !== 'Won');
    const youLine = `*You:* ${myWonUsd > 0 ? `${fmtUsd(myWonUsd)} won (${myWon.length} win${myWon.length === 1 ? '' : 's'})` : 'no wins yet'} · ${myActive.length} active deal${myActive.length === 1 ? '' : 's'}`;

    const upcoming = myActive
      .sort((a, b) => (a.nextActionDate ?? '9999').localeCompare(b.nextActionDate ?? '9999'))
      .slice(0, NEXT_ACTIONS_SHOWN);
    const actionLines = upcoming.length > 0 ? ['*Your next actions:*', ...upcoming.map(nextActionLine)] : [];

    const footer = `_${available} researched lead${available === 1 ? '' : 's'} available in the Bank — \`/sponsor claim\` one. \`/sponsor leaderboard\` for standings._`;

    const text = [...teamLines, youLine, ...actionLines, footer].join('\n');
    // DIGEST_DRY_RUN=true prints instead of DMing — for safe local verification.
    if (process.env.DIGEST_DRY_RUN?.toLowerCase() === 'true') {
      logger.info(`Weekly digest (dry run) → ${notionUser.name || slackUserId}:\n${text}`);
      continue;
    }
    await client.chat.postMessage({ channel: slackUserId, text, unfurl_links: false });
    logger.info(`Weekly digest: sent to ${notionUser.name || slackUserId}.`);
  }
}

// Entrypoint when run directly (GitHub Actions).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runWeeklyDigest().catch((err) => {
    logger.error('Weekly digest job failed.', err);
    process.exitCode = 1;
  });
}

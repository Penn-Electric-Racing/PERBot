import type { App, RespondFn } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { logger } from '../utils/logger.js';
import { todayIsoET } from './dates.js';
import { DomainResolutionError, enrichCompany } from './enrichCompany.js';
import { indexNotionUsers, slackUserToNotionId } from './identity.js';
import { SponsorNotion } from './notion.js';
import { EnrichResult, PipelineRow } from './types.js';

const notion = new SponsorNotion();

/**
 * Slack surface for the sponsorship module: the `/sponsor` command with three
 * subcommands (add / log / me). Registered from app.ts via registerSponsorCommands.
 * No drafting command exists (guardrail: no AI-written outreach).
 */

const USAGE = [
  '*`/sponsor` commands:*',
  '• `/sponsor add <company or url>` — research a company into the Prospect Bank',
  '• `/sponsor add <company> for <your ask> @person` — research + assign a deal to someone',
  '• `/sponsor log <company> - <note>` — log a manual touch on a deal',
  '• `/sponsor me` — show your active deals + next actions',
].join('\n');

/** Slack encodes mentions in command text as `<@U012ABC>` or `<@U012ABC|handle>`. */
const MENTION_RE = /<@([A-Z0-9]+)(?:\|[^>]+)?>/g;

/**
 * Parse a `/sponsor add` argument into company, known ask, and assignee Slack IDs.
 * Mentions may appear anywhere; the ask follows a natural " for " separator.
 *   "jlcpcb.com for board manufacturing, reduced cost @arjun"
 *     → { company: "jlcpcb.com", knownAsk: "board manufacturing, reduced cost", ids: [arjun] }
 */
function parseAdd(arg: string): { company: string; knownAsk: string; assigneeSlackIds: string[] } {
  const assigneeSlackIds: string[] = [];
  const withoutMentions = arg.replace(MENTION_RE, (_m, id: string) => {
    assigneeSlackIds.push(id);
    return ' ';
  });
  const text = withoutMentions.replace(/\s+/g, ' ').trim();

  const forMatch = text.match(/^(.*?)\s+for\s+(.+)$/i);
  const company = (forMatch ? forMatch[1] : text).trim();
  const knownAsk = forMatch ? forMatch[2]!.trim() : '';
  return { company, knownAsk, assigneeSlackIds: [...new Set(assigneeSlackIds)] };
}

function formatAddResult(result: EnrichResult): string {
  if (result.deduped) {
    const base = `↩︎ *${result.company}* is already in the Bank — skipped. <${result.bankPageUrl}|Open row>`;
    return result.assignment?.assignees.length || result.assignment?.unresolved.length
      ? `${base}\n• ⚠️ Assignment skipped (already a lead). Claim/assign it in Notion, or \`/sponsor log\` once it's a deal.`
      : base;
  }

  const c = result.classification;
  const contactLine = result.contact
    ? `${result.contact.name || '(no name)'} <${result.contact.email}> — ${result.contact.verificationStatus}, confidence ${result.contact.confidence}`
    : '_none found_';

  const lines = [
    `✅ Added *${result.company}* to the Prospect Bank. <${result.bankPageUrl}|Open row>`,
    `• *Tier:* ${c.tier}   *Type:* ${c.type}   *Channel:* ${c.channel}`,
    `• *Category:* ${c.categories.join(', ')}`,
    `• *Fit:* ${c.fitReason}`,
  ];
  if (c.suggestedAngle) lines.push(`• *Angle:* ${c.suggestedAngle}`);
  lines.push(`• *Contact:* ${contactLine}`);
  if (result.needsReview) lines.push(`• ⚠️ *Needs review:* ${result.reviewReason}`);
  if (result.assignment?.dealUrl) {
    lines.push(`• *Assigned:* ${result.assignment.assignees.join(', ')} → <${result.assignment.dealUrl}|Pipeline deal> (Prospect)`);
  }
  if (result.assignment?.unresolved.length) {
    lines.push(`• ⚠️ Couldn't match ${result.assignment.unresolved.join(', ')} to a Notion user — assign the DRI in Notion.`);
  }
  return lines.join('\n');
}

/** Resolve assignee Slack IDs → Notion user IDs (email-first, name fallback). */
async function resolveAssignees(
  client: WebClient,
  slackIds: string[]
): Promise<{ notionIds: string[]; labels: string[]; unresolved: string[] }> {
  const notionIds: string[] = [];
  const labels: string[] = [];
  const unresolved: string[] = [];
  if (slackIds.length === 0) return { notionIds, labels, unresolved };

  const index = indexNotionUsers(await notion.listNotionUsers());
  for (const slackId of slackIds) {
    const notionId = await slackUserToNotionId(client, slackId, index);
    if (notionId) {
      notionIds.push(notionId);
      labels.push(`<@${slackId}>`);
    } else {
      unresolved.push(`<@${slackId}>`);
    }
  }
  return { notionIds, labels, unresolved };
}

async function handleAdd(client: WebClient, respond: RespondFn, arg: string): Promise<void> {
  const { company, knownAsk, assigneeSlackIds } = parseAdd(arg);
  if (!company) {
    await respond({
      response_type: 'ephemeral',
      text: 'Usage: `/sponsor add <company or url> [for <your ask>] [@person]`\nExample: `/sponsor add jlcpcb.com for reduced-cost PCB fab @you`',
    });
    return;
  }

  try {
    const { notionIds, labels, unresolved } = await resolveAssignees(client, assigneeSlackIds);
    const result = await enrichCompany(company, {
      notion,
      knownAsk: knownAsk || undefined,
      assigneeNotionIds: notionIds,
      assigneeLabels: labels,
      unresolvedAssignees: unresolved,
    });
    await respond({ response_type: 'ephemeral', text: formatAddResult(result) });
  } catch (err) {
    if (err instanceof DomainResolutionError) {
      await respond({ response_type: 'ephemeral', text: `✗ ${err.message}` });
      return;
    }
    logger.error('/sponsor add failed', err);
    await respond({
      response_type: 'ephemeral',
      text: '✗ Enrichment failed. Check the PERBot logs and try again.',
    });
  }
}

// --- /sponsor me -------------------------------------------------------------

function formatDealLine(row: PipelineRow): string {
  const stage = row.stage ?? 'Prospect';
  const next = row.nextAction ? ` — Next: ${row.nextAction}` : '';
  const due = row.nextActionDate ? ` (due ${row.nextActionDate})` : '';
  return `• <${row.url}|${row.company || 'Untitled'}> — *${stage}*${next}${due}`;
}

async function handleMe(client: WebClient, respond: RespondFn, slackUserId: string): Promise<void> {
  const notionUsers = await notion.listNotionUsers();
  const notionId = await slackUserToNotionId(client, slackUserId, indexNotionUsers(notionUsers));
  if (!notionId) {
    await respond({
      response_type: 'ephemeral',
      text: "I couldn't match your Slack account to a Notion user (by email or name). Ask an admin to check your Notion access.",
    });
    return;
  }

  const deals = await notion.queryActiveDealsForUser(notionId);
  if (deals.length === 0) {
    await respond({ response_type: 'ephemeral', text: 'You have no active sponsorship deals. 🎉' });
    return;
  }

  const text = [`*Your active deals (${deals.length}):*`, ...deals.map(formatDealLine)].join('\n');
  await respond({ response_type: 'ephemeral', text });
}

// --- /sponsor log ------------------------------------------------------------

/** Parse "Acme Corp - called, they're interested" → { company, note }. */
function parseLog(arg: string): { company: string; note: string } | null {
  const match = arg.match(/^(.*?)\s+[-–—:]\s+(.+)$/);
  if (!match) return null;
  const company = match[1]!.trim();
  const note = match[2]!.trim();
  return company && note ? { company, note } : null;
}

async function handleLog(respond: RespondFn, arg: string): Promise<void> {
  const parsed = parseLog(arg);
  if (!parsed) {
    await respond({
      response_type: 'ephemeral',
      text: 'Usage: `/sponsor log <company> - <note>`\nExample: `/sponsor log Altium - called, sending deck Monday`',
    });
    return;
  }

  const matches = await notion.findDealsByCompany(parsed.company);
  if (matches.length === 0) {
    await respond({
      response_type: 'ephemeral',
      text: `No Pipeline deal matches *${parsed.company}*. Check the name, or it may still be in the Bank (not yet a deal).`,
    });
    return;
  }
  if (matches.length > 1) {
    const list = matches.map((m) => `• <${m.url}|${m.company}>`).join('\n');
    await respond({
      response_type: 'ephemeral',
      text: `Multiple deals match *${parsed.company}* — be more specific:\n${list}`,
    });
    return;
  }

  const deal = matches[0]!;
  await notion.logTouch(deal, parsed.note, todayIsoET());
  await respond({
    response_type: 'ephemeral',
    text: `✅ Logged a touch on <${deal.url}|${deal.company}> and stamped *Last contact* = today.`,
  });
}

export function registerSponsorCommands(app: App): void {
  app.command('/sponsor', async ({ ack, command, respond, client }) => {
    const trimmed = command.text.trim();
    const [sub, ...rest] = trimmed.split(/\s+/);
    const subcommand = (sub ?? '').toLowerCase();
    const arg = rest.join(' ');

    try {
      switch (subcommand) {
        case 'add':
          // Enrichment is slow (fetch + LLM + Hunter); ack fast, then post via response_url.
          await ack({ response_type: 'ephemeral', text: `:hourglass_flowing_sand: Researching *${arg || '…'}*` });
          await handleAdd(client, respond, arg);
          break;

        case 'log':
          await ack();
          await handleLog(respond, arg);
          break;

        case 'me':
          await ack();
          await handleMe(client, respond, command.user_id);
          break;

        default:
          await ack({ response_type: 'ephemeral', text: USAGE });
      }
    } catch (err) {
      logger.error(`/sponsor ${subcommand} failed`, err);
      await respond({ response_type: 'ephemeral', text: '✗ Something went wrong. Check the PERBot logs.' });
    }
  });
}

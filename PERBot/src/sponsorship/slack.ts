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
  '• `/sponsor log <company> <note>` — log a manual touch on a deal',
  '• `/sponsor me` — show your active deals + next actions',
].join('\n');

function formatAddResult(result: EnrichResult): string {
  if (result.deduped) {
    return `↩︎ *${result.company}* is already in the Bank — skipped. <${result.bankPageUrl}|Open row>`;
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
  return lines.join('\n');
}

async function handleAdd(respond: RespondFn, arg: string): Promise<void> {
  if (!arg.trim()) {
    await respond({
      response_type: 'ephemeral',
      text: 'Usage: `/sponsor add <company or url>`\nExample: `/sponsor add https://www.altium.com`',
    });
    return;
  }

  try {
    const result = await enrichCompany(arg);
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
          await handleAdd(respond, arg);
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

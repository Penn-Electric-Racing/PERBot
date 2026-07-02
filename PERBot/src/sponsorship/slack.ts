import type { App, RespondFn } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { todayIsoET } from './dates.js';
import { DomainResolutionError, enrichCompany } from './enrichCompany.js';
import { indexNotionUsers, slackUserToNotionId } from './identity.js';
import { resolveChannelId } from './jobs/shared.js';
import { announceWinIfNew, totalRaised } from './jobs/winPost.js';
import { SponsorNotion } from './notion.js';
import { EnrichResult, PipelineRow, STAGES, Stage } from './types.js';

const notion = new SponsorNotion();

/**
 * Slack surface for the sponsorship module: the `/sponsor` command with three
 * subcommands (add / log / me). Registered from app.ts via registerSponsorCommands.
 * No drafting command exists (guardrail: no AI-written outreach).
 */

const USAGE = [
  '*`/sponsor` commands:*',
  '• `/sponsor add <company or url>` — research a company into the Prospect Bank',
  '• `/sponsor add <company> for <ask> contact: <name> <email> @person` — research + set a known contact + assign a deal',
  '• `/sponsor log <company> - <note>` — log a manual touch on a deal',
  '• `/sponsor won <company> <amount> [note]` — mark a deal Won + post it to #operations',
  '• `/sponsor stage <company> <stage>` — move a deal (Prospect / Contacted / In talks / Won / Lost)',
  '• `/sponsor me` — show your active deals + next actions',
].join('\n');

function fmtMoney(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** Slack encodes mentions in command text as `<@U012ABC>` or `<@U012ABC|handle>`. */
const MENTION_RE = /<@([A-Z0-9]+)(?:\|[^>]+)?>/g;
const EMAIL_RE = /[^\s<>]+@[^\s<>]+\.[^\s<>]+/;

/** Slack auto-links URLs/emails in slash-command text — strip the `<…|…>` wrappers. */
function unwrapSlackLinks(text: string): string {
  return text
    .replace(/<mailto:([^|>]+)(?:\|[^>]*)?>/gi, '$1')
    .replace(/<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/gi, '$1');
}

export interface ParsedAdd {
  company: string;
  knownAsk: string;
  assigneeSlackIds: string[];
  contactName: string;
  contactEmail: string;
}

/**
 * Parse a `/sponsor add` argument into company, known ask, assignees, and an optional
 * human-provided contact. Mentions may appear anywhere; the ask follows " for "; a typed
 * contact follows "contact:". Order is flexible:
 *   "jlcpcb.com for reduced-cost fab contact: Chloe Wang chloe@jlcpcb.com @arjun"
 *     → company "jlcpcb.com", ask "reduced-cost fab", contact {Chloe Wang, chloe@jlcpcb.com}, [arjun]
 */
export function parseAdd(arg: string): ParsedAdd {
  const assigneeSlackIds: string[] = [];
  let text = unwrapSlackLinks(arg).replace(MENTION_RE, (_m, id: string) => {
    assigneeSlackIds.push(id);
    return ' ';
  });
  text = text.replace(/\s+/g, ' ').trim();

  let knownAsk = '';
  let contactName = '';
  let contactEmail = '';

  // Pull out the "contact:" clause (runs to end of string / until a trailing " for …").
  const contactSplit = text.split(/\bcontact:\s*/i);
  if (contactSplit.length > 1) {
    text = contactSplit[0]!.trim();
    let contactRaw = contactSplit.slice(1).join(' ').trim();
    // Handle "contact: … for <ask>" ordering by peeling a trailing ask off the contact.
    const forInContact = contactRaw.match(/^(.*?)\s+for\s+(.+)$/i);
    if (forInContact) {
      contactRaw = forInContact[1]!.trim();
      knownAsk = forInContact[2]!.trim();
    }
    const email = contactRaw.match(EMAIL_RE);
    if (email) {
      contactEmail = email[0];
      contactRaw = contactRaw.replace(email[0], '').trim();
    }
    contactName = contactRaw.replace(/[<>,]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Split the remaining text (before any contact clause) on the first " for ".
  const forMatch = text.match(/^(.*?)\s+for\s+(.+)$/i);
  const company = (forMatch ? forMatch[1] : text).trim();
  if (forMatch && !knownAsk) knownAsk = forMatch[2]!.trim();

  return { company, knownAsk, assigneeSlackIds: [...new Set(assigneeSlackIds)], contactName, contactEmail };
}

function formatAddResult(result: EnrichResult): string {
  if (result.deduped) {
    const base = `↩︎ *${result.company}* is already in the Bank — skipped. <${result.bankPageUrl}|Open row>`;
    return result.assignment?.assignees.length || result.assignment?.unresolved.length
      ? `${base}\n• ⚠️ Assignment skipped (already a lead). Claim/assign it in Notion, or \`/sponsor log\` once it's a deal.`
      : base;
  }

  const c = result.classification;
  let contactLine = '_none found_';
  if (result.contact) {
    const ct = result.contact;
    const meta =
      ct.verificationStatus === 'provided'
        ? 'provided by you'
        : `${ct.verificationStatus}, confidence ${ct.confidence}`;
    contactLine = `${ct.name || '(no name)'} <${ct.email || 'no email'}> — ${meta}`;
  }

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
  const { company, knownAsk, assigneeSlackIds, contactName, contactEmail } = parseAdd(arg);
  if (!company) {
    await respond({
      response_type: 'ephemeral',
      text: 'Usage: `/sponsor add <company or url> [for <your ask>] [contact: <name> <email>] [@person]`\nExample: `/sponsor add Jane Street for cash sponsorship contact: Stephanie Grassulo sgrassulo@janestreet.com @you`',
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
      manualContact: contactName || contactEmail ? { name: contactName, email: contactEmail } : undefined,
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

/**
 * Find the single Pipeline deal matching `company`. Responds and returns null on zero
 * or multiple matches (shared by log / won / stage). Callers proceed only on one hit.
 */
async function resolveSingleDeal(respond: RespondFn, company: string): Promise<PipelineRow | null> {
  const matches = await notion.findDealsByCompany(company);
  if (matches.length === 0) {
    await respond({
      response_type: 'ephemeral',
      text: `No Pipeline deal matches *${company}*. Check the name, or it may still be in the Bank (not yet a deal).`,
    });
    return null;
  }
  if (matches.length > 1) {
    const list = matches.map((m) => `• <${m.url}|${m.company}>`).join('\n');
    await respond({
      response_type: 'ephemeral',
      text: `Multiple deals match *${company}* — be more specific:\n${list}`,
    });
    return null;
  }
  return matches[0]!;
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

  const deal = await resolveSingleDeal(respond, parsed.company);
  if (!deal) return;

  await notion.logTouch(deal, parsed.note, todayIsoET());
  await respond({
    response_type: 'ephemeral',
    text: `✅ Logged a touch on <${deal.url}|${deal.company}> and stamped *Last contact* = today.`,
  });
}

// --- /sponsor won -------------------------------------------------------------

/** Parse "Jane Street $5,000 cash donation" → { company, amountUsd, note }. Supports "5k". */
function parseWon(arg: string): { company: string; amountUsd: number; note: string } | null {
  const m = arg.trim().match(/^(.+?)\s+\$?([\d,]+(?:\.\d+)?)(k)?\b\s*(?:[-–—:]\s*)?(.*)$/i);
  if (!m) return null;
  const company = m[1]!.trim();
  let amount = parseFloat(m[2]!.replace(/,/g, ''));
  if (m[3]) amount *= 1000;
  const note = (m[4] ?? '').trim();
  if (!company || !Number.isFinite(amount) || amount <= 0) return null;
  return { company, amountUsd: amount, note };
}

async function handleWon(client: WebClient, respond: RespondFn, arg: string): Promise<void> {
  const parsed = parseWon(arg);
  if (!parsed) {
    await respond({
      response_type: 'ephemeral',
      text: 'Usage: `/sponsor won <company> <amount> [note]`\nExample: `/sponsor won Jane Street $5000 cash donation`',
    });
    return;
  }

  const deal = await resolveSingleDeal(respond, parsed.company);
  if (!deal) return;

  await notion.markWon(deal, parsed.amountUsd, parsed.note, todayIsoET());

  // Post to #operations immediately. Same marker as the hourly job → no double-post.
  let announcedSuffix = '';
  try {
    const channelId = await resolveChannelId(client, config.sponsorship.winPostChannel);
    if (channelId) {
      const won = await notion.queryWonDeals();
      // Read-after-write guard: make sure this deal's amount is in the running total.
      let total = totalRaised(won);
      if (!won.some((d) => d.id === deal.id)) total += parsed.amountUsd;
      const posted = await announceWinIfNew(client, channelId, { ...deal, received: parsed.amountUsd }, total);
      if (posted) announcedSuffix = ` and posted it to #${config.sponsorship.winPostChannel}`;
    }
  } catch (err) {
    logger.error('/sponsor won: announcement failed (deal still marked Won)', err);
  }

  await respond({
    response_type: 'ephemeral',
    text: `🎉 Marked <${deal.url}|${deal.company}> *Won* at ${fmtMoney(parsed.amountUsd)}${announcedSuffix}.`,
  });
}

// --- /sponsor stage -----------------------------------------------------------

/** Parse "Jane Street in talks" → { company, stage }. Stage is a trailing keyword. */
function parseStage(arg: string): { company: string; stage: Stage } | null {
  const lower = arg.trim().toLowerCase();
  for (const stage of STAGES) {
    const suffix = stage.toLowerCase();
    if (lower.endsWith(` ${suffix}`)) {
      const company = arg.trim().slice(0, arg.trim().length - stage.length).trim().replace(/[-–—:]$/, '').trim();
      if (company) return { company, stage };
    }
  }
  return null;
}

async function handleStage(respond: RespondFn, arg: string): Promise<void> {
  const parsed = parseStage(arg);
  if (!parsed) {
    await respond({
      response_type: 'ephemeral',
      text: `Usage: \`/sponsor stage <company> <stage>\`\nStages: ${STAGES.join(' / ')}\nExample: \`/sponsor stage Jane Street In talks\``,
    });
    return;
  }

  const deal = await resolveSingleDeal(respond, parsed.company);
  if (!deal) return;

  await notion.setStage(deal, parsed.stage, todayIsoET());
  const tip = parsed.stage === 'Won' ? ' _(tip: use `/sponsor won <company> <amount>` to record the $ and post the win)_' : '';
  await respond({
    response_type: 'ephemeral',
    text: `✅ Moved <${deal.url}|${deal.company}> to *${parsed.stage}*.${tip}`,
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

        case 'won':
          await ack();
          await handleWon(client, respond, arg);
          break;

        case 'stage':
          await ack();
          await handleStage(respond, arg);
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

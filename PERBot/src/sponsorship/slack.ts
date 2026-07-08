import type { App, RespondFn } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { isoDaysFromNowET, todayIsoET } from './dates.js';
import { draftOutreachEmail } from './emailDraft.js';
import { DomainResolutionError, enrichCompany } from './enrichCompany.js';
import { fetchSlackDirectory, indexNotionUsers, resolveSlackHandles, slackUserToNotionId } from './identity.js';
import { resolveChannelId } from './jobs/shared.js';
import { announceWinIfNew, resolveDriMentions, totalRaised } from './jobs/winPost.js';
import { SponsorNotion } from './notion.js';
import { fitScore, impactScore, priorityScore, quadrant, SponsorScores } from './scoring.js';
import { BankLeadRow, CATEGORIES, Category, EnrichResult, PipelineRow, STAGES, Stage, WonKind } from './types.js';

const notion = new SponsorNotion();

/**
 * Slack surface for the sponsorship module: the `/sponsor` command
 * (add / claim / ask / email / log / won / stage / score / rank / leaderboard / me).
 * Registered from app.ts via registerSponsorCommands.
 * Drafting guardrail: `/sponsor email` fills the team's own template; the LLM writes
 * only the fit paragraph, the draft is never auto-sent, and a human reviews it first.
 */

const USAGE = [
  '*`/sponsor` commands:*',
  '• `/sponsor add <company or url>` — research a company into the Prospect Bank',
  '• `/sponsor add <company> for <ask> contact: <name> <email> @person` — research + set a known contact + assign a deal',
  '• `/sponsor claim <company> [@person]` — take an existing Bank lead as a deal you own',
  '• `/sponsor email <company> [for <ask>]` — draft outreach from the team template + an AI fit paragraph (review before sending)',
  '• `/sponsor ask <company> - <what we want>` — set the 🎯 specific ask a draft includes verbatim (paste detailed specs under the toggle in Notion)',
  '• `/sponsor log <company> - <note>` — log a manual touch on a deal',
  '• `/sponsor won <company> <amount> [cash|in-kind|discount] [note]` — mark a deal Won + post it to #operations',
  '• `/sponsor stage <company> <stage>` — move a deal (Prospect / Contacted / In talks / Won / Lost)',
  '• `/sponsor score <company> contact:<0-3> teams:<0-3>` — set a prospect’s human scores (also `market:`/`value:`/`need:`)',
  '• `/sponsor rank [category]` — top prospects by Priority (Fit × Impact), with their quadrant',
  '• `/sponsor leaderboard [post]` — who’s raised what: $ won + active deals per person (`post` shares it in-channel)',
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

// A plain-text "@handle" (NOT a real Slack mention) — anchored to whitespace/start so it
// never matches the "@" inside an email. Real mentions are `<@U…>` (see MENTION_RE).
const PLAIN_HANDLE_RE = /(^|\s)@([a-z0-9._-]+)/gi;

/** Pull out plain-text @handles (typed, not picked from the menu) and remove them. */
function extractPlainHandles(text: string): { handles: string[]; cleaned: string } {
  const handles = [...text.matchAll(PLAIN_HANDLE_RE)].map((m) => m[2]!);
  const cleaned = text.replace(PLAIN_HANDLE_RE, '$1').replace(/\s+/g, ' ').trim();
  return { handles, cleaned };
}

export interface ParsedAdd {
  company: string;
  knownAsk: string;
  assigneeSlackIds: string[];
  /** Plain-text @handles that weren't real mentions — reported so the user can fix them. */
  plainHandles: string[];
  contactName: string;
  contactEmail: string;
}

// Words that mark the end of the company name and the start of metadata. Lets people
// write naturally ("Jane Street, DRI is @X contact is Y") instead of a rigid grammar.
const FIELD_BOUNDARY = /,|\bfor\b|\bcontact\b|\bdri\b|\bowner\b|\bassign(?:ed)?\b/i;

/** The leading company name = text up to the first metadata boundary (comma/keyword). */
function leadingCompany(text: string): string {
  const b = text.match(FIELD_BOUNDARY);
  return (b ? text.slice(0, b.index) : text)
    .replace(/[,\s]+$/g, '') // trailing space/comma first…
    .replace(/^["']+|["']+$/g, '') // …then surrounding quotes
    .trim();
}

/**
 * Forgiving parser for `/sponsor add`. Handles both the structured form
 * (`jlcpcb.com for reduced-cost fab contact: Chloe Wang chloe@jlcpcb.com @arjun`) and
 * natural phrasing (`Jane Street, DRI is @Arjun contact is Stephanie, s@jane.com`).
 * Mentions, emails, the `for <ask>`, and `contact <is|:> <name>` may appear anywhere;
 * the company is whatever leads before the first metadata boundary.
 */
export function parseAdd(arg: string): ParsedAdd {
  // 1. Real Slack mentions anywhere → assignees (DRI).
  const assigneeSlackIds: string[] = [];
  let work = unwrapSlackLinks(arg).replace(MENTION_RE, (_m, id: string) => {
    assigneeSlackIds.push(id);
    return ' ';
  });

  // 2. Plain-text @handles (typed, not real mentions) → reported + removed.
  const { handles: plainHandles, cleaned } = extractPlainHandles(work);
  work = cleaned;

  // 3. Email anywhere → the contact email.
  const emailMatch = work.match(EMAIL_RE);
  const contactEmail = emailMatch ? emailMatch[0] : '';
  if (emailMatch) work = work.replace(emailMatch[0], ' ');
  work = work.replace(/\s+/g, ' ').trim();

  // 4. Known ask: text after "for", up to the next metadata word.
  let knownAsk = '';
  const forMatch = work.match(/\bfor\s+(.+?)(?=,?\s*\b(?:contact|dri|owner|assign)\b|$)/i);
  if (forMatch) knownAsk = forMatch[1]!.replace(/[,\s]+$/g, '').trim();

  // 5. Contact name: after "contact is / contact: / contact =", up to the next word.
  let contactName = '';
  const contactMatch = work.match(/\bcontact(?:\s+is|\s*[:=])\s*(.+?)(?=,?\s*\b(?:for|dri|owner|assign)\b|$)/i);
  if (contactMatch) contactName = contactMatch[1]!.replace(/[<>]/g, '').replace(/[,\s]+$/g, '').trim();

  // 6. Company = the leading chunk before any metadata boundary.
  const company = leadingCompany(work);

  return { company, knownAsk, assigneeSlackIds: [...new Set(assigneeSlackIds)], plainHandles, contactName, contactEmail };
}

function formatAddResult(result: EnrichResult): string {
  if (result.deduped) {
    if (result.assignment?.dealUrl) {
      // Was already in the Bank, but we graduated it to a deal for the assignee.
      return `✅ *${result.company}* was already in the Bank — claimed it for ${result.assignment.assignees.join(', ')} → <${result.assignment.dealUrl}|Pipeline deal> (Prospect).`;
    }
    const base = `↩︎ *${result.company}* is already in the Bank. <${result.bankPageUrl}|Open row>`;
    return result.assignment?.assignees.length || result.assignment?.unresolved.length
      ? `${base}\n• It's already an active deal — use \`/sponsor me\`, or \`/sponsor stage\` / \`/sponsor won\` to update it.`
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

  // AI seeds three sub-scores; the two human sub-scores are still blank, so this
  // Priority is provisional (Fit counts Market fit only until someone scores contact).
  const seeded = { contactStrength: null, sponsorsOtherTeams: null, marketFit: c.marketFit, valueBand: c.valueBand, categoryNeed: c.categoryNeed };
  const lines = [
    `✅ Added *${result.company}* to the Prospect Bank. <${result.bankPageUrl}|Open row>`,
    `• *Type:* ${c.type}   *Channel:* ${c.channel}   *Category:* ${c.categories.join(', ')}`,
    `• *Scores (AI):* market ${c.marketFit}/3 · value ${c.valueBand}/3 · need ${c.categoryNeed}/3  →  *Priority so far:* ${priorityScore(seeded)}`,
    `• _Set *Contact strength* + *Sponsors other teams* (0–3) in Notion to finish the score._`,
    `• *Why:* ${c.fitReason}`,
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

/**
 * Resolve assignees → Notion user IDs. Takes real-mention Slack IDs AND plain-text
 * @handles (Slack sends blue-chip mentions as plain text unless the command escapes
 * links); handles are looked up in the Slack directory first. Email-first, name fallback.
 */
async function resolveAssignees(
  client: WebClient,
  slackIds: string[],
  plainHandles: string[] = []
): Promise<{ notionIds: string[]; labels: string[]; unresolved: string[] }> {
  const { ids: handleIds, unresolved: handleUnresolved } = await resolveSlackHandles(client, plainHandles);
  const allSlackIds = [...new Set([...slackIds, ...handleIds])];

  const notionIds: string[] = [];
  const labels: string[] = [];
  const unresolved: string[] = handleUnresolved.map((h) => `@${h}`);
  if (allSlackIds.length === 0) return { notionIds, labels, unresolved };

  const index = indexNotionUsers(await notion.listNotionUsers());
  for (const slackId of allSlackIds) {
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
  const { company, knownAsk, assigneeSlackIds, plainHandles, contactName, contactEmail } = parseAdd(arg);
  if (!company) {
    await respond({
      response_type: 'ephemeral',
      text: 'Usage: `/sponsor add <company or url> [for <your ask>] [contact: <name> <email>] [@person]`\nExample: `/sponsor add Jane Street for cash sponsorship contact: Stephanie Grassulo sgrassulo@janestreet.com @you`',
    });
    return;
  }

  try {
    const { notionIds, labels, unresolved } = await resolveAssignees(client, assigneeSlackIds, plainHandles);
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

// --- /sponsor email ------------------------------------------------------------

/**
 * Find the single Bank prospect matching `company` (exact title wins when several
 * match). Responds itself and returns null on zero or ambiguous matches.
 */
async function resolveSingleBankRow(respond: RespondFn, company: string): Promise<BankLeadRow | null> {
  const rows = await notion.findBankRowsByCompany(company);
  if (rows.length === 0) {
    await respond({
      response_type: 'ephemeral',
      text: `No Bank prospect matches *${company}*. Add it with \`/sponsor add ${company}\` first.`,
    });
    return null;
  }
  if (rows.length > 1) {
    const exact = rows.find((r) => r.company.toLowerCase() === company.toLowerCase());
    if (exact) return exact;
    const list = rows.slice(0, 8).map((r) => `• <${r.url}|${r.company}>`).join('\n');
    await respond({ response_type: 'ephemeral', text: `*${company}* matches several prospects — be more specific:\n${list}` });
    return null;
  }
  return rows[0]!;
}

// Slack rejects messages much past 4000 chars; leave headroom for the header lines.
const EMAIL_SLACK_PREVIEW_CHARS = 3400;

/** Parse "Edgerton Gear for machining our planetary gears" → company + inline ask. */
export function parseEmailArg(arg: string): { company: string; ask: string } {
  const text = unwrapSlackLinks(arg).trim();
  const m = /\s+for\s+/i.exec(text);
  if (!m) return { company: leadingCompany(text), ask: '' };
  return {
    company: leadingCompany(text.slice(0, m.index)),
    ask: text.slice(m.index + m[0].length).trim(),
  };
}

async function handleEmail(
  client: WebClient,
  respond: RespondFn,
  callerSlackId: string,
  arg: string
): Promise<void> {
  const { company, ask } = parseEmailArg(arg);
  if (!company) {
    await respond({
      response_type: 'ephemeral',
      text: 'Usage: `/sponsor email <company> [for <ask>]`\nDrafts outreach from the team template with a company-specific fit paragraph, saves it on the prospect’s Bank page, and gives you the text to copy. A 🎯 specific ask (set via `/sponsor ask` or the toggle in Notion) is included verbatim. Review before sending.',
    });
    return;
  }

  const row = await resolveSingleBankRow(respond, company);
  if (!row) return;

  // The sender is the caller: their real name fills [NAME] and the signature.
  let senderName = '';
  try {
    const info = await client.users.info({ user: callerSlackId });
    senderName = info.user?.profile?.real_name || info.user?.real_name || '';
  } catch (err) {
    logger.warn('/sponsor email: users.info failed; leaving the [NAME] placeholder', err);
  }

  const result = await draftOutreachEmail({ notion, row, senderName, ask });

  const preview =
    result.emailText.length > EMAIL_SLACK_PREVIEW_CHARS
      ? `${result.emailText.slice(0, EMAIL_SLACK_PREVIEW_CHARS)}\n… (truncated — full draft is in Notion)`
      : result.emailText;
  const lines = [
    `📧 Drafted outreach for *${result.company}* → <${result.draftUrl}|Open draft in Notion>`,
    result.grounded
      ? ''
      : "⚠️ Couldn't fetch their homepage — the fit paragraph leans on stored research only, so read it extra carefully.",
    result.hasAsk ? '🎯 Includes the specific ask (specs copied verbatim — double-check them).' : '',
    '_AI-assisted draft: the fit paragraph is generated. Review it (and make it yours) before sending._',
    '```' + preview + '```',
  ].filter(Boolean);
  await respond({ response_type: 'ephemeral', text: lines.join('\n') });
}

// --- /sponsor ask --------------------------------------------------------------

async function handleAsk(respond: RespondFn, arg: string): Promise<void> {
  const parsed = parseLog(unwrapSlackLinks(arg));
  if (!parsed) {
    await respond({
      response_type: 'ephemeral',
      text:
        'Usage: `/sponsor ask <company> - <what we want from them>`\n' +
        'Example: `/sponsor ask Edgerton Gear - manufacture our planetary gearset (spur gears, 1mm module)`\n' +
        'This creates a *🎯 Specific ask* toggle on the prospect’s Bank page — paste detailed multi-line specs under it in Notion; `/sponsor email` includes them *verbatim* in the draft.',
    });
    return;
  }

  const row = await resolveSingleBankRow(respond, parsed.company);
  if (!row) return;

  await notion.writeAskSection(row.id, parsed.note);
  await respond({
    response_type: 'ephemeral',
    text:
      `🎯 Set the specific ask on *${row.company}*. <${row.url}|Open row>\n` +
      '_For detailed specs (dimensions, materials, tolerances), edit the 🎯 toggle on the page — every line under it goes into the draft verbatim. Then run `/sponsor email ' + row.company + '`._',
  });
}

// --- /sponsor score ----------------------------------------------------------

/** Short keys people type → the sub-score they set. */
const SCORE_ALIASES: Record<string, keyof SponsorScores> = {
  contact: 'contactStrength',
  teams: 'sponsorsOtherTeams',
  sponsors: 'sponsorsOtherTeams',
  market: 'marketFit',
  value: 'valueBand',
  need: 'categoryNeed',
};

// `key[: ]value` where value is a single digit 0–3, e.g. "contact:2" or "teams 3".
const SCORE_PAIR_RE = /\b(contact|teams|sponsors|market|value|need)\b\s*[:=]?\s*([0-3])\b/gi;

export interface ParsedScore {
  company: string;
  updates: Partial<SponsorScores>;
}

/** Parse "JLCPCB contact:2 teams:3" → { company, updates }. Company = text before the first score pair. */
export function parseScore(arg: string): ParsedScore {
  const updates: Partial<SponsorScores> = {};
  let firstIdx = arg.length;
  for (const m of arg.matchAll(SCORE_PAIR_RE)) {
    updates[SCORE_ALIASES[m[1]!.toLowerCase()]!] = Number(m[2]);
    if (m.index != null && m.index < firstIdx) firstIdx = m.index;
  }
  const company = arg
    .slice(0, firstIdx)
    .replace(/[,\s]+$/g, '')
    .replace(/^["']+|["']+$/g, '')
    .trim();
  return { company, updates };
}

/** Human-friendly label for a sub-score key, for the confirmation message. */
const SCORE_LABELS: Record<keyof SponsorScores, string> = {
  contactStrength: 'contact',
  marketFit: 'market',
  sponsorsOtherTeams: 'teams',
  valueBand: 'value',
  categoryNeed: 'need',
};

async function handleScore(respond: RespondFn, arg: string): Promise<void> {
  const { company, updates } = parseScore(arg);
  const keys = Object.keys(updates) as (keyof SponsorScores)[];
  if (!company || keys.length === 0) {
    await respond({
      response_type: 'ephemeral',
      text:
        'Usage: `/sponsor score <company> contact:<0-3> teams:<0-3>` (also `market:` `value:` `need:`)\n' +
        'Example: `/sponsor score JLCPCB contact:2 teams:3` — sets the two human scores and recomputes Priority.',
    });
    return;
  }

  const rows = await notion.findBankRowsByCompany(company);
  if (rows.length === 0) {
    await respond({ response_type: 'ephemeral', text: `No Bank prospect matches *${company}*. Add it with \`/sponsor add\` first.` });
    return;
  }

  // Disambiguate multiple matches: prefer an exact (case-insensitive) title match.
  let row = rows[0]!;
  if (rows.length > 1) {
    const exact = rows.find((r) => r.company.toLowerCase() === company.toLowerCase());
    if (exact) {
      row = exact;
    } else {
      const list = rows.slice(0, 8).map((r) => `• <${r.url}|${r.company}>`).join('\n');
      await respond({ response_type: 'ephemeral', text: `*${company}* matches several prospects — be more specific:\n${list}` });
      return;
    }
  }

  await notion.updateBankScores(row.id, updates);
  const merged = { ...row.scores, ...updates };
  const setStr = keys.map((k) => `${SCORE_LABELS[k]} ${updates[k]}/3`).join(' · ');
  await respond({
    response_type: 'ephemeral',
    text:
      `✅ Scored *${row.company}* — set ${setStr}.\n` +
      `• *Fit:* ${fitScore(merged)}/9 · *Impact:* ${impactScore(merged)}/6  →  *Priority:* ${priorityScore(merged)} ${quadrant(merged)}  <${row.url}|Open row>`,
  });
}

// --- /sponsor rank -----------------------------------------------------------

/** Match a free-text arg to a Category (exact, then substring). */
function resolveCategory(arg: string): { category?: Category; unmatched?: string } {
  const q = arg.trim().toLowerCase();
  if (!q) return {};
  const hit =
    CATEGORIES.find((c) => c.toLowerCase() === q) ?? CATEGORIES.find((c) => c.toLowerCase().includes(q));
  return hit ? { category: hit } : { unmatched: arg.trim() };
}

const RANK_LIMIT = 10;

async function handleRank(respond: RespondFn, arg: string): Promise<void> {
  const { category, unmatched } = resolveCategory(arg);
  const rows = await notion.queryRankableProspects(category);

  if (rows.length === 0) {
    const scope = category ? ` in *${category}*` : '';
    await respond({ response_type: 'ephemeral', text: `No live prospects${scope} to rank yet. Add some with \`/sponsor add\`.` });
    return;
  }

  // Highest Priority first; tie-break on Fit so a warmer lead edges out a colder one.
  const ranked = rows
    .map((r) => ({ r, priority: priorityScore(r.scores), fit: fitScore(r.scores), impact: impactScore(r.scores) }))
    .sort((a, b) => b.priority - a.priority || b.fit - a.fit)
    .slice(0, RANK_LIMIT);

  const header = category ? `*Top prospects — ${category}* (by Priority = Fit × Impact)` : '*Top prospects* (by Priority = Fit × Impact)';
  const lines = ranked.map(({ r, priority, fit, impact }, i) => {
    const provisional = r.scores.contactStrength == null || r.scores.sponsorsOtherTeams == null ? ' _(unscored)_' : '';
    return `${i + 1}. <${r.url}|${r.company || 'Untitled'}> — *${priority}* ${quadrant(r.scores)}  ·  fit ${fit}/9 · impact ${impact}/6${provisional}`;
  });
  if (unmatched) lines.unshift(`_(couldn't match category "${unmatched}" — ranking all categories)_`);
  const hint = ranked.some((x) => x.priority === 0)
    ? '\n_Rows show low/zero Priority until their Contact strength + Sponsors other teams are scored in Notion._'
    : '';

  await respond({ response_type: 'ephemeral', text: [header, ...lines].join('\n') + hint });
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

/** Turn a "5,000" / "9k" style token into a number. */
function dollars(raw: string, kSuffix?: string): number {
  const n = parseFloat(raw.replace(/,/g, ''));
  return kSuffix ? n * 1000 : n;
}

/**
 * Optional win-kind keyword at the start of the note — "cash [donation]",
 * "in-kind [donation]", "[valued] discount" — mapped to the Pipeline's `Won kind`
 * select. Word-bounded so notes like "cashed the check" aren't misread.
 */
const WON_KIND_RE = /^(cash|in-?\s?kind|valued\s+discount|discount)\b(?:\s+donation)?[,:–—-]?\s*/i;

function extractWonKind(note: string): { kind?: WonKind; note: string } {
  const m = note.match(WON_KIND_RE);
  if (!m) return { note };
  const token = m[1]!.toLowerCase().replace(/[\s-]/g, '');
  const kind: WonKind =
    token === 'cash' ? 'Cash donation' : token === 'inkind' ? 'In-kind donation' : 'Valued discount';
  return { kind, note: note.slice(m[0].length).trim() };
}

/**
 * Parse the amount for `/sponsor won`. Two forms:
 *   • plain amount — "$5,000", "5000", "5k"
 *   • computed discount — "38% of $9k", "38% off 9000", "38% discount on $9,000"
 *     → the value saved (0.38 × 9000 = $3,420), returned with how it was derived.
 * A kind keyword after the amount ("cash" / "in-kind" / "discount") becomes `kind`;
 * a computed discount defaults to 'Valued discount' when no kind is typed.
 * Returns the company, the resolved USD amount, an optional note, `kind`, and `computed`.
 */
export function parseWon(
  arg: string
): { company: string; amountUsd: number; note: string; kind?: WonKind; computed?: string } | null {
  const t = arg.trim();

  // Percentage/discount form. `[^%$\d]*?` lets filler words sit between the % and the base
  // ("38% discount on cells worth $9000").
  const pct = t.match(
    /^(.+?)\s+(\d+(?:\.\d+)?)\s*%[^%$\d]*?\$?\s?([\d,]+(?:\.\d+)?)(k)?\b\s*(?:[-–—:]\s*)?(.*)$/i
  );
  if (pct) {
    const company = leadingCompany(pct[1]!);
    const percent = parseFloat(pct[2]!);
    const base = dollars(pct[3]!, pct[4]);
    const amountUsd = Math.round((percent / 100) * base * 100) / 100;
    if (company && amountUsd > 0) {
      const { kind, note } = extractWonKind((pct[5] ?? '').trim());
      // A computed discount is, by definition, a valued discount unless told otherwise.
      return { company, amountUsd, note, kind: kind ?? 'Valued discount', computed: `${percent}% of ${fmtMoney(base)}` };
    }
  }

  // Plain amount form.
  const m = t.match(/^(.+?)\s+\$?([\d,]+(?:\.\d+)?)(k)?\b\s*(?:[-–—:]\s*)?(.*)$/i);
  if (!m) return null;
  const company = leadingCompany(m[1]!);
  const amount = dollars(m[2]!, m[3]);
  if (!company || !Number.isFinite(amount) || amount <= 0) return null;
  const { kind, note } = extractWonKind((m[4] ?? '').trim());
  return { company, amountUsd: amount, note, kind };
}

async function handleWon(client: WebClient, respond: RespondFn, arg: string): Promise<void> {
  const parsed = parseWon(arg);
  if (!parsed) {
    await respond({
      response_type: 'ephemeral',
      text: 'Usage: `/sponsor won <company> <amount> [cash|in-kind|discount] [note]`\nAmount can be a number (`$5,000`, `5k`) or a discount (`38% of $9k` → $3,420, auto-tagged Valued discount).\nExamples: `/sponsor won Jane Street $5000 cash` · `/sponsor won Altium 20k in-kind licenses` · `/sponsor won Melasta 38% of $9000 cell discount`',
    });
    return;
  }

  const deal = await resolveSingleDeal(respond, parsed.company);
  if (!deal) return;

  await notion.markWon(deal, parsed.amountUsd, parsed.note, todayIsoET(), parsed.kind);

  // Post to #operations immediately. Same marker as the hourly job → no double-post.
  let announcedSuffix = '';
  try {
    const channelId = await resolveChannelId(client, config.sponsorship.winPostChannel);
    if (channelId) {
      const won = await notion.queryWonDeals();
      // Read-after-write guard: make sure this deal's amount is in the running total.
      let total = totalRaised(won);
      if (!won.some((d) => d.id === deal.id)) total += parsed.amountUsd;
      const notionUsersById = new Map((await notion.listNotionUsers()).map((u) => [u.id, u]));
      const dri = await resolveDriMentions(client, deal.driUserIds, notionUsersById, await fetchSlackDirectory(client));
      const posted = await announceWinIfNew(
        client,
        channelId,
        { ...deal, received: parsed.amountUsd, wonKind: parsed.kind ?? deal.wonKind },
        total,
        dri,
        parsed.note
      );
      if (posted) announcedSuffix = ` and posted it to #${config.sponsorship.winPostChannel}`;
    }
  } catch (err) {
    logger.error('/sponsor won: announcement failed (deal still marked Won)', err);
  }

  const computedNote = parsed.computed ? ` _(${parsed.computed})_` : '';
  const kindNote = parsed.kind ? ` — ${parsed.kind.toLowerCase()}` : '';
  await respond({
    response_type: 'ephemeral',
    text: `🎉 Marked <${deal.url}|${deal.company}> *Won* at ${fmtMoney(parsed.amountUsd)}${computedNote}${kindNote}${announcedSuffix}.`,
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

// --- /sponsor leaderboard -------------------------------------------------------

export interface LeaderboardRow {
  notionId: string;
  name: string;
  wonUsd: number;
  wonCount: number;
  activeCount: number;
}

/**
 * Aggregate deals per DRI. A co-owned deal credits each DRI in full (a shared win is
 * everyone's win) — the header's raised total comes from totalRaised, so co-credit
 * never inflates the real number. Lost deals count toward nothing.
 */
export function computeLeaderboard(deals: PipelineRow[], nameById: Map<string, string>): LeaderboardRow[] {
  const rows = new Map<string, LeaderboardRow>();
  for (const deal of deals) {
    for (const id of deal.driUserIds) {
      let row = rows.get(id);
      if (!row) {
        row = { notionId: id, name: nameById.get(id) || 'Unknown', wonUsd: 0, wonCount: 0, activeCount: 0 };
        rows.set(id, row);
      }
      if (deal.stage === 'Won') {
        row.wonUsd += deal.received ?? deal.dealValue ?? 0;
        row.wonCount += 1;
      } else if (deal.stage !== 'Lost') {
        row.activeCount += 1;
      }
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      b.wonUsd - a.wonUsd || b.wonCount - a.wonCount || b.activeCount - a.activeCount || a.name.localeCompare(b.name)
  );
}

const MEDALS = ['🥇', '🥈', '🥉'] as const;
const LEADERBOARD_LIMIT = 15;

async function handleLeaderboard(respond: RespondFn, arg: string): Promise<void> {
  // `/sponsor leaderboard post` shares it with the channel; default is only-you.
  const inChannel = /\b(post|share|public)\b/i.test(arg);

  const [deals, notionUsers, prospects] = await Promise.all([
    notion.queryAllDeals(),
    notion.listNotionUsers(),
    notion.queryRankableProspects(),
  ]);

  const nameById = new Map(notionUsers.map((u) => [u.id, u.name]));
  const rows = computeLeaderboard(deals, nameById);
  const available = prospects.filter((p) => p.status === 'Available').length;
  const claimHint = available > 0 ? `\n_${available} researched lead${available === 1 ? '' : 's'} waiting in the Bank — \`/sponsor claim\` one!_` : '';

  if (rows.length === 0) {
    await respond({
      response_type: 'ephemeral',
      text: `No deals on the board yet.${claimHint || ' Add prospects with `/sponsor add`.'}`,
    });
    return;
  }

  const total = totalRaised(deals.filter((d) => d.stage === 'Won'));
  const goal = config.sponsorship.semesterGoalUsd;
  const pct = goal > 0 ? Math.round((total / goal) * 100) : 0;
  const header = `🏆 *Sponsorship leaderboard* — *${fmtMoney(total)} / ${fmtMoney(goal)}* raised (${pct}%)`;

  const lines = rows.slice(0, LEADERBOARD_LIMIT).map((r, i) => {
    const badge = r.wonUsd > 0 && i < MEDALS.length ? MEDALS[i] : '•';
    const won = r.wonUsd > 0 ? `*${fmtMoney(r.wonUsd)}* won (${r.wonCount} win${r.wonCount === 1 ? '' : 's'})` : 'no wins yet';
    return `${badge} *${r.name}* — ${won} · ${r.activeCount} active deal${r.activeCount === 1 ? '' : 's'}`;
  });
  if (rows.length > LEADERBOARD_LIMIT) lines.push(`_…and ${rows.length - LEADERBOARD_LIMIT} more_`);

  await respond({
    response_type: inChannel ? 'in_channel' : 'ephemeral',
    text: [header, ...lines].join('\n') + claimHint,
  });
}

// --- /sponsor claim -----------------------------------------------------------

function parseClaim(arg: string): { company: string; assigneeSlackIds: string[]; plainHandles: string[] } {
  const assigneeSlackIds: string[] = [];
  const withoutMentions = unwrapSlackLinks(arg).replace(MENTION_RE, (_m, id: string) => {
    assigneeSlackIds.push(id);
    return ' ';
  });
  const { handles: plainHandles, cleaned } = extractPlainHandles(withoutMentions);
  return { company: leadingCompany(cleaned), assigneeSlackIds: [...new Set(assigneeSlackIds)], plainHandles };
}

/**
 * Claim an existing Bank lead → graduate it to a Pipeline deal. No mention needed: it
 * defaults to the caller (using their own Slack identity), so it's the clean "own it
 * myself" button. An explicit @mention assigns someone else instead.
 */
async function handleClaim(
  client: WebClient,
  respond: RespondFn,
  callerSlackId: string,
  arg: string
): Promise<void> {
  const { company, assigneeSlackIds, plainHandles } = parseClaim(arg);
  if (!company) {
    await respond({
      response_type: 'ephemeral',
      text: 'Usage: `/sponsor claim <company> [@person]`\nExample: `/sponsor claim Jane Street` (claims it for you) or `/sponsor claim Jane Street @teammate`',
    });
    return;
  }

  const rows = await notion.findBankRowsByCompany(company);
  if (rows.length === 0) {
    await respond({
      response_type: 'ephemeral',
      text: `No Bank lead matches *${company}*. Add it first with \`/sponsor add ${company}\`.`,
    });
    return;
  }
  if (rows.length > 1) {
    const list = rows.map((r) => `• <${r.url}|${r.company}>`).join('\n');
    await respond({ response_type: 'ephemeral', text: `Multiple Bank leads match *${company}* — be more specific:\n${list}` });
    return;
  }
  const bank = rows[0]!;

  if (bank.hasPipelineDeal || bank.status === 'Graduated') {
    const deals = await notion.findDealsByCompany(bank.company);
    const link = deals[0] ? ` <${deals[0].url}|Open deal>` : '';
    await respond({ response_type: 'ephemeral', text: `↩︎ *${bank.company}* is already an active deal.${link}` });
    return;
  }

  // Default owner = the caller; an explicit @mention or @handle assigns someone else.
  const hasExplicit = assigneeSlackIds.length > 0 || plainHandles.length > 0;
  const { notionIds, labels, unresolved } = hasExplicit
    ? await resolveAssignees(client, assigneeSlackIds, plainHandles)
    : await resolveAssignees(client, [callerSlackId]);
  if (notionIds.length === 0) {
    await respond({
      response_type: 'ephemeral',
      text: `✗ Couldn't match ${[...labels, ...unresolved].join(', ') || 'you'} to a Notion user (by email or name). Ask an admin to check Notion access.`,
    });
    return;
  }

  const deal = await notion.createPipelineDeal({
    bankPageId: bank.id,
    company: bank.company,
    driNotionIds: notionIds,
    type: bank.type,
    categories: bank.categories,
    contact: bank.contact,
    nextAction: 'Send first outreach',
    nextActionDateIso: isoDaysFromNowET(7),
  });
  await notion.markBankClaimed(bank.id, notionIds, 'Graduated');

  const unresolvedNote = unresolved.length ? ` (couldn't match ${unresolved.join(', ')})` : '';
  await respond({
    response_type: 'ephemeral',
    text: `✅ Claimed *${bank.company}* → <${deal.url}|Pipeline deal> (Prospect), owned by ${labels.join(', ')}.${unresolvedNote}`,
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

        case 'claim':
          await ack();
          await handleClaim(client, respond, command.user_id, arg);
          break;

        case 'ask':
          await ack();
          await handleAsk(respond, arg);
          break;

        case 'email':
        case 'draft':
          // Drafting is slow (template + homepage fetch + LLM + Notion writes) —
          // ack fast, then deliver via response_url (same pattern as add).
          await ack({ response_type: 'ephemeral', text: `:hourglass_flowing_sand: Drafting outreach for *${arg || '…'}*` });
          await handleEmail(client, respond, command.user_id, arg);
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

        case 'score':
          await ack();
          await handleScore(respond, arg);
          break;

        case 'rank':
          await ack();
          await handleRank(respond, arg);
          break;

        case 'leaderboard':
        case 'board':
        case 'top':
          await ack();
          await handleLeaderboard(respond, arg);
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

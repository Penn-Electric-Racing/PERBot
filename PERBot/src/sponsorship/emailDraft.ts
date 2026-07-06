import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { todayIsoET } from './dates.js';
import { getSponsorGroqClient } from './groqClient.js';
import { fetchCompanyText } from './homepage.js';
import { DRAFT_EMAIL_MARKER, SponsorNotion } from './notion.js';
import { BankLeadRow } from './types.js';

/**
 * Draft-outreach generator for `/sponsor email`. The email is the team's own Notion
 * template ("Sponsorship Email Template"), fetched live and filled mechanically —
 * the LLM writes ONLY the company-specific fit paragraph (the `[PERSONALIZED]` line),
 * grounded in the prospect's homepage text plus the enrichment's stored fit reason /
 * suggested angle. Guardrails preserved: no auto-send (the draft lands on the Bank
 * page for a human to review and copy), and the LLM still never touches contact data.
 */

/** Where the generated paragraph goes. If the template loses the marker, we fall
 *  back to inserting after the first (intro) paragraph rather than failing. */
const PERSONALIZED_MARKER = '[PERSONALIZED]';

const MAX_PARAGRAPH_CHARS = 600;

export interface DraftEmailResult {
  company: string;
  /** The full assembled email, paragraphs separated by blank lines. */
  emailText: string;
  /** Deep link to the draft toggle on the Bank page. */
  draftUrl: string;
  bankUrl: string;
  /** The generated fit paragraph on its own, for a quick sanity check. */
  personalized: string;
  /** False when the homepage couldn't be fetched — the paragraph then leans only on
   *  the stored fit reason/angle, so it deserves a closer read. */
  grounded: boolean;
  /** True when a specific ask (🎯 toggle or inline `for …`) was included in the draft. */
  hasAsk: boolean;
}

const PARAGRAPH_SYSTEM_PROMPT = `You write ONE short paragraph (2–3 sentences, max 450 characters) for a sponsorship outreach email from Penn Electric Racing (PER), the University of Pennsylvania's Formula SAE Electric student team, to a prospective sponsor.

The paragraph makes the case for why THIS company specifically fits as a partner for REV12, PER's first four-wheel-drive electric race car in eight years: reference what the company actually makes or does and connect it concretely to what a student FSAE EV team builds and needs.

Context: your paragraph is inserted immediately after this template sentence — "We believe [COMPANY] would be a strong partner for REV12, our first four-wheel-drive electric race car in eight years." So do NOT re-introduce PER, REV12, or repeat that it is a four-wheel-drive EV; go straight into the company-specific reasoning.

Rules:
- Return ONLY a JSON object: {"paragraph": "..."}.
- Ground every claim about the company in the provided website text and fit notes. Do NOT invent products, numbers, awards, partnerships, or history.
- Never mention or invent any person's name, email, or job title.
- No greeting, no sign-off, no bullet points — one flowing paragraph, first-person plural ("we", "our team").
- Plain, specific, student-engineer voice. No buzzwords ("synergy", "leverage", "passionate"), no empty flattery.`;

/** LLM step: the fit paragraph. Falls back to a mechanical sentence built from the
 *  stored enrichment reasoning if the model returns nothing usable. */
async function writeFitParagraph(row: BankLeadRow, companyText: string, ask: string): Promise<string> {
  const groq = getSponsorGroqClient();

  const knowns = [
    row.fitReason ? `Fit reason (from our research): ${row.fitReason}` : '',
    row.suggestedAngle ? `Outreach angle (from our research): ${row.suggestedAngle}` : '',
    `Engineering categories they relate to: ${row.categories.join(', ')}`,
    // The ask steers the paragraph toward the concrete request, but the paragraph must
    // NOT enumerate the specs — those are appended verbatim right after it (guardrail:
    // the LLM never rewrites engineering specs — materials, tolerances, callouts).
    ask
      ? `Our specific ask of this company (set this request up naturally in the paragraph, e.g. what we'd like them to make or provide for us — but do NOT list the detailed specifications; they appear verbatim immediately after your paragraph):\n${ask}`
      : '',
  ].filter(Boolean).join('\n');

  const response = await groq.chat.completions.create({
    model: config.groq.model,
    temperature: 0.4,
    reasoning_effort: 'low',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: PARAGRAPH_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Company: ${row.company}\n${knowns}\n\nCompany website text:\n${companyText || '(homepage unavailable — use only the fit notes above, and stay general about their products)'}`,
      },
    ],
  });

  let paragraph = '';
  try {
    const raw = JSON.parse(response.choices[0]?.message?.content ?? '{}');
    if (typeof raw.paragraph === 'string') paragraph = raw.paragraph.replace(/\s+/g, ' ').trim();
  } catch {
    // fall through to the mechanical fallback
  }

  if (!paragraph) {
    logger.warn(`Fit-paragraph generation returned nothing for ${row.company}; using stored reasoning.`);
    paragraph = [row.fitReason, row.suggestedAngle && `Specifically: ${row.suggestedAngle}`]
      .filter(Boolean)
      .join(' ');
  }
  return paragraph.slice(0, MAX_PARAGRAPH_CHARS);
}

/** Mechanical placeholder fill. Longer placeholders first ([COMPANY NAME] contains
 *  [NAME]); [Name] (contact) and [NAME] (sender) are distinguished case-sensitively,
 *  matching the template's own convention. Unknown placeholders are left for a human. */
function fillPlaceholders(paragraph: string, row: BankLeadRow, senderName: string): string {
  let out = paragraph
    .replaceAll('[COMPANY NAME]', row.company)
    .replaceAll('[COMPANY]', row.company)
    .replaceAll('[NAME]', senderName || '[NAME]');
  const contactFirstName = row.contact?.name?.trim().split(/\s+/)[0] ?? '';
  if (contactFirstName) out = out.replaceAll('[Name]', contactFirstName);
  return out;
}

/** Cap for the verbatim ask block (Notion paragraph limit is ~2000 chars/rich text). */
const MAX_ASK_CHARS = 1800;

/**
 * Assemble + persist a draft outreach email for one Bank prospect.
 * Template (live from Notion) → homepage re-fetch → LLM fit paragraph → mechanical
 * fill → written to the Bank page as a `📧 Draft email` toggle (replacing any
 * previous draft). Throws if the template page is empty/unreachable.
 *
 * Specific ask: an inline ask (from `/sponsor email <co> for …`) or the Bank page's
 * `🎯 Specific ask` toggle steers the fit paragraph AND is appended VERBATIM as its
 * own block right after it — the LLM never rewrites the specs themselves. When both
 * exist, the inline ask steers the paragraph and the toggle supplies the verbatim
 * block (so a quick `for gears` doesn't clobber a detailed spec).
 */
export async function draftOutreachEmail(opts: {
  notion: SponsorNotion;
  row: BankLeadRow;
  /** Real name of the person the email is from (fills [NAME] + the signature). */
  senderName: string;
  /** Optional inline ask, e.g. from `/sponsor email <company> for <ask>`. */
  ask?: string;
}): Promise<DraftEmailResult> {
  const { notion, row, senderName } = opts;

  const template = await notion.fetchPageParagraphs(config.sponsorship.emailTemplatePageId);
  if (template.length === 0) {
    throw new Error('The email template page is empty or unreachable — check SPONSOR_EMAIL_TEMPLATE_PAGE_ID and the integration’s access to it.');
  }

  const inlineAsk = opts.ask?.trim() ?? '';
  const storedAsk = (await notion.fetchAskSection(row.id)).slice(0, MAX_ASK_CHARS);
  const steeringAsk = inlineAsk || storedAsk;
  // The verbatim block prefers the stored spec; a lone inline ask becomes a one-liner.
  const askBlock = storedAsk || (inlineAsk ? `- ${inlineAsk}` : '');

  const hostname = row.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const companyText = hostname ? await fetchCompanyText(hostname) : '';
  const personalized = await writeFitParagraph(row, companyText, steeringAsk);

  // Splice the generated paragraph in: replace the [PERSONALIZED] marker paragraph,
  // or insert after the intro paragraph if the marker was removed from the template.
  // The verbatim ask block (lead-in + spec lines) follows it immediately.
  const generated = [personalized];
  if (askBlock) {
    generated.push(`To be specific, here’s what we’re hoping ${row.company} could help us with:`);
    generated.push(askBlock);
  }

  const paragraphs: string[] = [];
  let spliced = false;
  for (const para of template) {
    if (!spliced && para.includes(PERSONALIZED_MARKER)) {
      paragraphs.push(...generated);
      spliced = true;
    } else {
      paragraphs.push(para);
    }
  }
  if (!spliced) paragraphs.splice(Math.min(1, paragraphs.length), 0, ...generated);

  const filled = paragraphs.map((p) => fillPlaceholders(p, row, senderName));

  const title = `${DRAFT_EMAIL_MARKER} — generated ${todayIsoET()} · AI-assisted, review before sending`;
  const { blockId } = await notion.writeDraftEmail(row.id, title, filled);
  const draftUrl = blockId ? `${row.url}#${blockId.replace(/-/g, '')}` : row.url;

  return {
    company: row.company,
    emailText: filled.join('\n\n'),
    draftUrl,
    bankUrl: row.url,
    personalized,
    grounded: companyText.length > 0,
    hasAsk: askBlock.length > 0,
  };
}

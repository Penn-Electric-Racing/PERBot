import { lookup } from 'node:dns/promises';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { extractHostname } from './domain.js';
import { getSponsorGroqClient } from './groqClient.js';
import { fetchCompanyText } from './homepage.js';
import type { BankLeadRow } from './types.js';

/**
 * Sponsor discovery: `/sponsor find` (match a free-text team need against the
 * UNCLAIMED Bank) and `/sponsor scout` (suggest NEW companies not yet in the Bank).
 *
 * Guardrails, same as enrichment:
 * - The LLM never outputs contact data. Scout suggests only company + domain + why;
 *   contacts still come exclusively from Hunter when someone runs `/sponsor add`.
 * - Scout WRITES NOTHING to Notion and spends no Hunter credits — it's a read-only
 *   shortlist. A human picks which candidates become Bank rows.
 * - Hallucination filter: every scouted domain is grounded by fetching its homepage
 *   (deterministic, homepage.ts) and a second LLM pass verifies the page actually
 *   matches the claim. A candidate whose homepage contradicts the claim is dropped;
 *   an unreachable homepage is surfaced as unverified, never silently trusted.
 */

/** Everything both features share per Groq call. */
const GROQ_OPTS = { temperature: 0, reasoning_effort: 'low', response_format: { type: 'json_object' } } as const;

function parseJson(content: string | null | undefined): Record<string, unknown> {
  try {
    return JSON.parse(content ?? '{}');
  } catch {
    return {};
  }
}

/**
 * The team's Groq org is on the FREE tier: 8,000 tokens/minute for gpt-oss-120b.
 * Every prompt here is sized to stay well under that (that's why /sponsor find is
 * two small passes, not one big roster call), and a 413/429 on the minute window
 * (e.g. two teammates running commands at once) is waited out and retried.
 */
const RATE_LIMIT_RETRIES = 2;
const DEFAULT_WAIT_MS = 20_000;

/** Groq's error message says "Please try again in 7.66s" — honor it, capped at 60s. */
function suggestedWaitMs(err: unknown): number | null {
  const msg = (err as any)?.error?.message ?? (err as any)?.message ?? '';
  const m = /try again in ([\d.]+)\s*s/i.exec(String(msg));
  return m ? Math.min(60_000, Math.ceil(parseFloat(m[1]!) * 1000) + 1000) : null;
}

/** One forced-JSON Groq chat call, retrying rate limits on the free-tier TPM window. */
async function chatJson(system: string, user: string): Promise<Record<string, unknown>> {
  const groq = getSponsorGroqClient();
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await groq.chat.completions.create({
        model: config.groq.model,
        ...GROQ_OPTS,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });
      return parseJson(response.choices[0]?.message?.content);
    } catch (err) {
      const status = (err as any)?.status;
      if ((status === 429 || status === 413) && attempt < RATE_LIMIT_RETRIES) {
        const wait = suggestedWaitMs(err) ?? DEFAULT_WAIT_MS;
        logger.warn(`Groq rate-limited (${status}); retrying in ${Math.round(wait / 1000)}s`);
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      throw err;
    }
  }
}

function cleanText(value: unknown, maxLen: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

/** Run `fn` over `items` with at most `limit` in flight (homepage fetches are slow). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

// --- /sponsor find: match a need against the unclaimed Bank ---------------------

export interface ProspectMatch {
  row: BankLeadRow;
  why: string;
}

const FIND_LIMIT = 10;
const SHORTLIST_LIMIT = 25;
// Fit reasons are ≤200 chars; trim in the ranking pass so the shortlist stays cheap.
const FIND_REASON_CHARS = 140;
// Free-tier TPM headroom: if the name-only roster would still be huge, drop categories.
const SHORTLIST_BUDGET_CHARS = 22_000;

const SHORTLIST_SYSTEM_PROMPT = `You shortlist sponsorship prospects for Penn Electric Racing (PER, a Formula SAE Electric student team). Given a stated team need and a numbered roster of company names (with rough engineering categories), pick every company that could PLAUSIBLY supply or fund that need — favor recall over precision; a later pass filters properly.

Return ONLY a JSON object: {"shortlist": [{"n": <roster number>}, ...]} with at most ${SHORTLIST_LIMIT} entries. An empty array is a valid answer. Output nothing else.
(Each entry MUST be an object with the single key "n" — never a bare number: gpt-oss at low reasoning has emitted bare-number arrays without commas, which parse as one giant number.)`;

const RANK_SYSTEM_PROMPT = `You match a stated need of Penn Electric Racing (PER, a Formula SAE Electric student team) against a numbered roster of already-researched sponsorship prospects.

Return ONLY a JSON object: {"matches": [{"n": <roster number>, "why": "<one clause, max 120 chars, why this company fits the need>"}]}.
- Best match first, at most ${FIND_LIMIT} entries.
- Include ONLY companies that could genuinely supply or fund the stated need — no padding. An empty "matches" array is a valid answer.
- "why" must be grounded in the roster line (their product/category/fit reason), not invented capabilities.
- Do NOT output contact names, emails, or anything besides the JSON object.`;

/** Read a validated, deduped list of roster numbers out of an LLM JSON array. */
function readRosterNumbers(value: unknown, max: number, rosterSize: number): number[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  for (const v of value) {
    const n = Number(typeof v === 'object' && v !== null ? (v as any).n : v);
    if (Number.isInteger(n) && n >= 1 && n <= rosterSize) seen.add(n);
    if (seen.size >= max) break;
  }
  return [...seen];
}

/**
 * Match a free-text need against the unclaimed Bank, in TWO small Groq passes to fit
 * the free tier's 8k TPM: (1) a cheap name+category shortlist over all rows (recall),
 * then (2) rank the shortlist with full fit reasons (precision), best-first with a
 * one-line why each.
 */
export async function findMatchingProspects(need: string, rows: BankLeadRow[]): Promise<ProspectMatch[]> {
  if (rows.length === 0) return [];

  // Pass 1 — shortlist. Name+category lines; drop categories if the Bank has grown
  // past the token budget (name-only still shortlists decently).
  let roster = rows.map((r, i) => `${i + 1}. ${r.company} [${r.categories.join('/')}]`).join('\n');
  if (roster.length > SHORTLIST_BUDGET_CHARS) {
    logger.warn(`Shortlist roster over budget (${roster.length} chars) — falling back to name-only lines.`);
    roster = rows.map((r, i) => `${i + 1}. ${r.company}`).join('\n');
  }
  const shortlistRaw = await chatJson(SHORTLIST_SYSTEM_PROMPT, `Team need: ${need}\n\nRoster:\n${roster}`);
  const shortlist = readRosterNumbers(shortlistRaw.shortlist, SHORTLIST_LIMIT, rows.length);
  if (shortlist.length === 0) return [];

  // Pass 2 — rank the shortlist with fit reasons (renumbered 1..k).
  const picked = shortlist.map((n) => rows[n - 1]!);
  const detail = picked
    .map((r, i) => {
      const fit = r.fitReason.slice(0, FIND_REASON_CHARS);
      return `${i + 1}. ${r.company} — categories: ${r.categories.join('/')}${fit ? `; fit: ${fit}` : ''}`;
    })
    .join('\n');
  const rankedRaw = await chatJson(RANK_SYSTEM_PROMPT, `Team need: ${need}\n\nProspect roster:\n${detail}`);

  const items = Array.isArray(rankedRaw.matches) ? rankedRaw.matches : [];
  const seen = new Set<number>();
  const matches: ProspectMatch[] = [];
  for (const item of items) {
    const n = Number((item as any)?.n);
    if (!Number.isInteger(n) || n < 1 || n > picked.length || seen.has(n)) continue;
    seen.add(n);
    matches.push({ row: picked[n - 1]!, why: cleanText((item as any)?.why, 140) || 'possible fit' });
    if (matches.length >= FIND_LIMIT) break;
  }
  return matches;
}

// --- /sponsor scout: suggest new companies, then verify them --------------------

export type ScoutVerdict = 'confirmed' | 'unverified' | 'rejected';

export interface ScoutCandidate {
  company: string;
  /** Bare lowercase hostname (e.g. "edgertongear.com"). */
  hostname: string;
  /** The generator's one-line pitch for why they'd fit the need. */
  why: string;
  verdict: ScoutVerdict;
  /** The verifier's note (what the homepage showed, or why it was rejected). */
  note: string;
}

export interface ScoutResult {
  candidates: ScoutCandidate[];
  /** Rejected count, so the surface can say what was dropped instead of hiding it. */
  rejectedCount: number;
}

const SCOUT_ASK_LIMIT = 12;
const FETCH_CONCURRENCY = 5;
// Snippet + skip-list sizes keep both scout calls a few k tokens each (free-tier TPM).
const SNIPPET_CHARS = 700;
const KNOWN_DOMAINS_IN_PROMPT = 250;

const SCOUT_SYSTEM_PROMPT = `You suggest companies Penn Electric Racing (PER) could approach for sponsorship. PER is a Formula SAE Electric student team at the University of Pennsylvania in Philadelphia that designs, builds, and races an electric race car — interpret "local" in a need as the greater Philadelphia region.

Return ONLY a JSON object: {"candidates": [{"company": "<name>", "domain": "<their primary web domain>", "why": "<one clause, max 120 chars, why they fit the need>"}]}.
- Up to ${SCOUT_ASK_LIMIT} candidates, best fit first.
- ONLY real companies you are confident actually exist, with their real primary domain. Never guess a domain from the company name; omit a company you can't pin a domain on. Every suggestion will be checked against the live website, so a made-up entry is worse than a short list.
- Prefer established, findable companies whose domain you are CERTAIN of over obscure job shops you only half-remember — e.g. for overseas manufacturing needs, the well-known export-friendly platforms and manufacturers, not tiny local firms.
- Favor companies plausibly open to sponsoring/discounting for a student engineering team (suppliers, job shops, tool makers, firms that recruit engineers) over consumer brands.
- Skip every company in the provided already-known list.
- Do NOT output contact names, emails, phone numbers, or people.`;

const VERIFY_SYSTEM_PROMPT = `You verify scouted sponsorship candidates for Penn Electric Racing. For each numbered candidate you get the claimed company, domain, the claimed fit, and text fetched from that domain's live homepage (or "(homepage unreachable)").

Return ONLY a JSON object: {"verdicts": [{"n": <number>, "verdict": "confirmed" | "unverified" | "rejected", "note": "<max 100 chars>"}]}.
- "confirmed": the homepage text is consistent with the claimed company AND with the stated need.
- "rejected": the homepage clearly belongs to a different business, is a parked/for-sale domain, or is plainly irrelevant to the need.
- "unverified": the homepage was unreachable — you cannot check either way.
- Judge ONLY from the provided homepage text; do not use outside knowledge to rescue a candidate.`;

interface GeneratedCandidate {
  company: string;
  hostname: string;
  why: string;
}

/** Stage 1: ask the LLM for candidate companies, keeping only parseable, unknown domains. */
async function generateCandidates(need: string, knownHostnames: Set<string>): Promise<GeneratedCandidate[]> {
  // The prompt's skip-list is best-effort (capped for the token budget); the REAL
  // dedupe is the code check against the full set below, so a cap costs nothing
  // but a wasted suggestion slot.
  const known = [...knownHostnames].sort().slice(0, KNOWN_DOMAINS_IN_PROMPT).join(', ') || '(none yet)';

  const raw = await chatJson(SCOUT_SYSTEM_PROMPT, `Team need: ${need}\n\nAlready-known domains (skip these):\n${known}`);
  const items = Array.isArray(raw.candidates) ? raw.candidates : [];
  const seen = new Set<string>();
  const candidates: GeneratedCandidate[] = [];
  for (const item of items) {
    const company = cleanText((item as any)?.company, 100);
    const hostname = extractHostname(cleanText((item as any)?.domain, 200));
    if (!company || !hostname || seen.has(hostname) || knownHostnames.has(hostname)) continue;
    seen.add(hostname);
    candidates.push({ company, hostname, why: cleanText((item as any)?.why, 140) || 'suggested fit' });
    if (candidates.length >= SCOUT_ASK_LIMIT) break;
  }
  return candidates;
}

/** Stage 3: one Groq call judging every candidate against its fetched homepage text. */
async function verifyCandidates(
  need: string,
  candidates: GeneratedCandidate[],
  snippets: string[]
): Promise<Map<number, { verdict: ScoutVerdict; note: string }>> {
  const listing = candidates
    .map((c, i) => {
      const page = snippets[i] ? `homepage: ${snippets[i]}` : '(homepage unreachable)';
      return `${i + 1}. ${c.company} (${c.hostname}) — claimed fit: ${c.why}\n   ${page}`;
    })
    .join('\n');

  const raw = await chatJson(VERIFY_SYSTEM_PROMPT, `Team need: ${need}\n\nCandidates:\n${listing}`);
  const items = Array.isArray(raw.verdicts) ? raw.verdicts : [];
  const verdicts = new Map<number, { verdict: ScoutVerdict; note: string }>();
  for (const item of items) {
    const n = Number((item as any)?.n);
    const v = (item as any)?.verdict;
    if (!Number.isInteger(n) || n < 1 || n > candidates.length) continue;
    if (v !== 'confirmed' && v !== 'unverified' && v !== 'rejected') continue;
    verdicts.set(n - 1, { verdict: v, note: cleanText((item as any)?.note, 120) });
  }
  return verdicts;
}

/**
 * Full scout pipeline: generate candidates → fetch each homepage (the hallucination
 * filter) → verify page-vs-claim → return confirmed first, then unverified; rejected
 * candidates are dropped but counted. Read-only: no Notion writes, no Hunter credits.
 */
export async function scoutCompanies(need: string, knownHostnames: Set<string>): Promise<ScoutResult> {
  const generated = await generateCandidates(need, knownHostnames);
  if (generated.length === 0) return { candidates: [], rejectedCount: 0 };

  // An empty homepage can mean bot-blocked (real company) OR nonexistent (invented
  // company) — a failed DNS lookup distinguishes them: no A record ⇒ hallucinated.
  const grounded = await mapLimit(generated, FETCH_CONCURRENCY, async (c) => {
    const text = await fetchCompanyText(c.hostname);
    if (text) return { snippet: text.slice(0, SNIPPET_CHARS), resolves: true };
    const resolves = await lookup(c.hostname).then(() => true, () => false);
    return { snippet: '', resolves };
  });
  const snippets = grounded.map((g) => g.snippet);

  const verdicts = await verifyCandidates(need, generated, snippets);

  const candidates: ScoutCandidate[] = generated.map((c, i) => {
    if (!grounded[i]!.resolves) {
      return { ...c, verdict: 'rejected' as ScoutVerdict, note: 'domain does not resolve — likely invented' };
    }
    // No verdict returned for this row → the safe reading of "couldn't check".
    const v = verdicts.get(i) ?? { verdict: 'unverified' as ScoutVerdict, note: '' };
    // A reachable homepage the verifier called "unverified" stays unverified; an
    // unreachable one can never be "confirmed" regardless of what the LLM said.
    const verdict: ScoutVerdict = !snippets[i] && v.verdict === 'confirmed' ? 'unverified' : v.verdict;
    return { ...c, verdict, note: v.note };
  });

  const rejectedCount = candidates.filter((c) => c.verdict === 'rejected').length;
  const order: Record<ScoutVerdict, number> = { confirmed: 0, unverified: 1, rejected: 2 };
  const kept = candidates
    .filter((c) => c.verdict !== 'rejected')
    .sort((a, b) => order[a.verdict] - order[b.verdict]);

  logger.info(
    `Scout "${need}": ${generated.length} generated → ${kept.length} kept (${rejectedCount} rejected by homepage check).`
  );
  return { candidates: kept, rejectedCount };
}

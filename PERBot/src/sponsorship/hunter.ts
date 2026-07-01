import { config, hasHunter } from '../config.js';
import { logger } from '../utils/logger.js';
import { HunterContact } from './types.js';

/**
 * Hunter.io client — the ONLY source of contact data (hard guardrail: the LLM never
 * invents contacts). Every contact carries a verification status + confidence, both
 * stored on the Bank row. Best-effort throughout: a Hunter failure yields a null
 * contact (→ the row is flagged Needs Review), never a fabricated one.
 *
 * Credit note: domain-search is 1 credit; we verify only the single chosen email
 * (1 more), so ~2 credits per enrichment. Dedupe (before this runs) prevents re-spend.
 */

const HUNTER_BASE = 'https://api.hunter.io/v2';
const HUNTER_TIMEOUT_MS = 12_000;

interface HunterEmail {
  value: string;
  first_name: string | null;
  last_name: string | null;
  position: string | null;
  confidence: number | null;
  verification?: { status: string | null } | null;
}

interface DomainSearchResult {
  domain: string | null;
  organization: string | null;
  emails: HunterEmail[];
}

// Role buckets, best → worst, for sponsorship outreach. Lower index = better contact.
const ROLE_PRIORITY: RegExp[] = [
  /partnership|sponsor|philanthrop|community|outreach|alliance/i,
  /marketing|brand|communicat|\bpr\b|public relations/i,
  /recruit|talent|university|campus|early career/i,
  /founder|ceo|chief|president|owner|principal|director/i,
  /engineer|technical|product/i,
];

function roleRank(position: string | null): number {
  if (!position) return ROLE_PRIORITY.length;
  const idx = ROLE_PRIORITY.findIndex((re) => re.test(position));
  return idx === -1 ? ROLE_PRIORITY.length : idx;
}

async function hunterGet(path: string, params: Record<string, string>): Promise<any | null> {
  const url = new URL(`${HUNTER_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('api_key', config.hunter.apiKey);

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(HUNTER_TIMEOUT_MS) });
    if (!res.ok) {
      logger.warn(`Hunter ${path} returned ${res.status}: ${await res.text()}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    logger.warn(`Hunter ${path} request failed`, err);
    return null;
  }
}

async function domainSearch(params: { domain?: string; company?: string }): Promise<DomainSearchResult> {
  const query: Record<string, string> = { limit: '10' };
  if (params.domain) query.domain = params.domain;
  if (params.company) query.company = params.company;

  const json = await hunterGet('domain-search', query);
  const data = json?.data ?? {};
  return {
    domain: typeof data.domain === 'string' ? data.domain : null,
    organization: typeof data.organization === 'string' ? data.organization : null,
    emails: Array.isArray(data.emails) ? (data.emails as HunterEmail[]) : [],
  };
}

function pickBestEmail(emails: HunterEmail[]): HunterEmail | null {
  const withEmail = emails.filter((e) => e && typeof e.value === 'string' && e.value.includes('@'));
  if (withEmail.length === 0) return null;

  return withEmail.sort((a, b) => {
    const rank = roleRank(a.position) - roleRank(b.position);
    if (rank !== 0) return rank;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  })[0];
}

/** Best-effort deliverability verification of the chosen email. Null on any failure. */
async function verifyEmail(email: string): Promise<{ status: string; score: number } | null> {
  const json = await hunterGet('email-verifier', { email });
  const data = json?.data;
  if (!data) return null;
  return {
    status: typeof data.status === 'string' ? data.status : 'unknown',
    score: typeof data.score === 'number' ? data.score : 0,
  };
}

async function buildContact(best: HunterEmail | null): Promise<HunterContact | null> {
  if (!best) return null;

  const verification = await verifyEmail(best.value);
  const name = [best.first_name, best.last_name].filter(Boolean).join(' ').trim();

  return {
    name,
    email: best.value,
    verificationStatus: verification?.status ?? best.verification?.status ?? 'unverified',
    confidence: verification?.score ?? best.confidence ?? 0,
  };
}

/** Find the best contact for a known domain. */
export async function findContactByDomain(hostname: string): Promise<HunterContact | null> {
  if (!hasHunter()) {
    logger.warn('HUNTER_API_KEY not set — skipping contact enrichment.');
    return null;
  }
  const result = await domainSearch({ domain: hostname });
  return buildContact(pickBestEmail(result.emails));
}

/**
 * Resolve a bare company name → domain via Hunter, and return the best contact from
 * the same call. Used when `/sponsor add` is given a name rather than a URL.
 */
export async function resolveByCompany(
  name: string
): Promise<{ domain: string | null; organization: string | null; contact: HunterContact | null }> {
  if (!hasHunter()) {
    logger.warn('HUNTER_API_KEY not set — cannot resolve a company name to a domain.');
    return { domain: null, organization: null, contact: null };
  }
  const result = await domainSearch({ company: name });
  const contact = await buildContact(pickBestEmail(result.emails));
  return { domain: result.domain, organization: result.organization, contact };
}

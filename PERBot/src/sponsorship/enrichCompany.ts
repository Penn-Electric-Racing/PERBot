import { logger } from '../utils/logger.js';
import { classifyCompanyFit } from './classify.js';
import { extractHostname, looksLikeDomain, toCanonicalUrl } from './domain.js';
import { fetchCompanyText } from './homepage.js';
import { findContactByDomain, resolveByCompany } from './hunter.js';
import { SponsorNotion } from './notion.js';
import { EnrichResult, HunterContact } from './types.js';

/**
 * The enrichCompany pipeline (see CLAUDE.md "Sponsorship module — architecture"):
 *   1. Resolve the input → domain (deterministic for URLs; Hunter for bare names).
 *   2. Dedupe against the Bank by domain — BEFORE any Hunter spend on re-runs.
 *   3. Fetch homepage/about text (deterministic).
 *   4. Groq → structured JSON classification (forced schema, validated).
 *   5. Hunter → contact + verified email + confidence (only source of contact data).
 *   6. Create the Bank row: Status=Available, Relationship=New; flag Needs Review
 *      (in Notes) when the contact is missing/low-confidence/unverified.
 */

export class DomainResolutionError extends Error {}

/** Deliverability statuses we treat as good enough to not flag for review. */
const OK_STATUSES = new Set(['valid', 'accept_all', 'webmail']);
const MIN_CONFIDENCE = 70;

function computeReview(contact: HunterContact | null): { needsReview: boolean; reason?: string } {
  if (!contact) return { needsReview: true, reason: 'no contact found via Hunter' };
  if (contact.confidence < MIN_CONFIDENCE) {
    return { needsReview: true, reason: `low Hunter confidence (${contact.confidence})` };
  }
  if (!OK_STATUSES.has(contact.verificationStatus)) {
    return { needsReview: true, reason: `email not verified (status: ${contact.verificationStatus})` };
  }
  return { needsReview: false };
}

/** Clean a raw `/sponsor add` argument into a human-friendly company display name. */
function displayNameFromInput(input: string, hostname: string): string {
  if (looksLikeDomain(input)) {
    // acme-robotics.com → "Acme Robotics"
    const label = hostname.split('.')[0] ?? hostname;
    return label
      .split(/[-_]/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
  return input.trim();
}

export async function enrichCompany(
  input: string,
  deps: { notion?: SponsorNotion } = {}
): Promise<EnrichResult> {
  const notion = deps.notion ?? new SponsorNotion();
  const raw = input.trim();
  if (!raw) throw new DomainResolutionError('No company or URL provided.');

  // Step 1 — resolve domain. For URLs/domains this is deterministic; for a bare
  // company name we ask Hunter (which also hands back a contact, reused in step 5).
  let hostname: string | null = extractHostname(raw);
  let company = raw;
  let preResolvedContact: HunterContact | null = null;

  if (!hostname) {
    const resolved = await resolveByCompany(raw);
    if (!resolved.domain) {
      throw new DomainResolutionError(
        `Couldn't resolve "${raw}" to a company domain. Try \`/sponsor add <website url>\` instead.`
      );
    }
    hostname = extractHostname(resolved.domain) ?? resolved.domain;
    company = resolved.organization ?? raw;
    preResolvedContact = resolved.contact;
  } else {
    company = displayNameFromInput(raw, hostname);
  }

  const canonical = toCanonicalUrl(hostname);

  // Step 2 — dedupe by domain (guards both duplicate rows and re-spending credits).
  const existing = await notion.findBankRowByDomain(canonical);
  if (existing) {
    logger.info(`Skipping enrichment for ${canonical} — already in Bank (${existing.url}).`);
    return { deduped: true, company, domain: canonical, bankPageUrl: existing.url };
  }

  // Step 3 — homepage/about text (deterministic grounding for the classifier).
  const companyText = await fetchCompanyText(hostname);

  // Step 4 — structured classification (Groq, forced schema, validated).
  const classification = await classifyCompanyFit(company, canonical, companyText);

  // Step 5 — contact from Hunter (reuse the name-resolution call if we made one).
  const contact = preResolvedContact ?? (await findContactByDomain(hostname));
  const { needsReview, reason } = computeReview(contact);

  // Step 6 — write the Bank row (Available / New).
  const page = await notion.createBankRow({
    company,
    domain: canonical,
    classification,
    contact,
    needsReview,
    reviewReason: reason,
  });

  return {
    deduped: false,
    company,
    domain: canonical,
    bankPageUrl: page.url,
    classification,
    contact,
    needsReview,
    reviewReason: reason,
  };
}

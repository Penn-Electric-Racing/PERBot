import { logger } from '../utils/logger.js';
import { classifyCompanyFit } from './classify.js';
import { extractHostname, looksLikeDomain, toCanonicalUrl } from './domain.js';
import { fetchCompanyText } from './homepage.js';
import { isoDaysFromNowET } from './dates.js';
import { findContactByDomain, resolveByCompany } from './hunter.js';
import { SponsorNotion } from './notion.js';
import { AssignmentInfo, EnrichResult, HunterContact } from './types.js';

/** Days out to seed a newly-assigned deal's first next-action (feeds the stale DM). */
const FIRST_OUTREACH_DAYS = 7;

/**
 * Options for a "directed add": the caller already knows the ask and/or who should own
 * it. Slack-side code resolves @mentions to Notion user IDs before calling us.
 */
export interface EnrichOptions {
  notion?: SponsorNotion;
  /** The team's known ask — becomes the Suggested angle verbatim + a classifier hint. */
  knownAsk?: string;
  /** Notion user IDs to own the deal. Non-empty → open a Pipeline deal + graduate the row. */
  assigneeNotionIds?: string[];
  /** Display labels for the assignees, for the confirmation message. */
  assigneeLabels?: string[];
  /** Mentions that couldn't be resolved to a Notion user (reported, not assigned). */
  unresolvedAssignees?: string[];
  /**
   * A human-provided contact (name and/or email). Used INSTEAD of Hunter when present —
   * a contact the requester types is not LLM-invented, so it doesn't violate the
   * no-fabricated-contacts guardrail. Stored with verificationStatus 'provided'.
   */
  manualContact?: { name?: string; email?: string };
}

/**
 * The enrichCompany pipeline (see CLAUDE.md "Sponsorship module — architecture"):
 *   1. Resolve the input → domain (deterministic for URLs; Hunter for bare names).
 *   2. Dedupe against the Bank by domain — BEFORE any Hunter spend on re-runs.
 *   3. Fetch homepage/about text (deterministic).
 *   4. Groq → structured JSON classification (forced schema, validated).
 *   5. Hunter → contact + verified email + confidence (only source of contact data).
 *   6. Create the Bank row: Status=Available, Relationship=New; flag Needs Review
 *      when the contact is missing/low-confidence/unverified.
 *   7. Directed add only — if an assignee was given, open a Pipeline deal (Prospect,
 *      DRI=assignee) and mark the Bank row Graduated/Claimed.
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
  opts: EnrichOptions = {}
): Promise<EnrichResult> {
  const notion = opts.notion ?? new SponsorNotion();
  const assigneeNotionIds = opts.assigneeNotionIds ?? [];
  const assigned = assigneeNotionIds.length > 0;
  const assignmentBase: AssignmentInfo | undefined =
    assigned || opts.unresolvedAssignees?.length
      ? { assignees: opts.assigneeLabels ?? [], unresolved: opts.unresolvedAssignees ?? [] }
      : undefined;

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
    // Directed add against an existing lead: don't silently double-graduate. Report it
    // and let the caller assign/claim in Notion (or via the existing deal).
    return { deduped: true, company, domain: canonical, bankPageUrl: existing.url, assignment: assignmentBase };
  }

  // Step 3 — homepage/about text (deterministic grounding for the classifier).
  const companyText = await fetchCompanyText(hostname);

  // Step 4 — structured classification (Groq, forced schema, validated). A known ask
  // steers tier/type/category and is written verbatim as the angle (the team's words).
  const classification = await classifyCompanyFit(company, canonical, companyText, opts.knownAsk);
  if (opts.knownAsk) classification.suggestedAngle = opts.knownAsk;

  // Step 5 — contact. A requester-provided contact is authoritative (not LLM-invented),
  // so it replaces the Hunter lookup; otherwise fall back to Hunter.
  let contact: HunterContact | null;
  let review: { needsReview: boolean; reason?: string };
  const manual = opts.manualContact;
  if (manual && (manual.name || manual.email)) {
    contact = {
      name: manual.name ?? '',
      email: manual.email ?? '',
      verificationStatus: 'provided',
      confidence: 100,
    };
    review = manual.email
      ? { needsReview: false }
      : { needsReview: true, reason: 'contact name provided but no email yet' };
  } else {
    contact = preResolvedContact ?? (await findContactByDomain(hostname));
    review = computeReview(contact);
  }
  const { needsReview, reason } = review;

  // Step 6 — write the Bank row. A directed add with an assignee is Graduated + Claimed;
  // a plain add is Available / New.
  const page = await notion.createBankRow({
    company,
    domain: canonical,
    classification,
    contact,
    needsReview,
    reviewReason: reason,
    status: assigned ? 'Graduated' : 'Available',
    claimedByNotionIds: assigned ? assigneeNotionIds : undefined,
  });

  // Step 7 — directed add: open the Pipeline deal (Prospect) owned by the DRI(s).
  let assignment = assignmentBase;
  if (assigned) {
    const deal = await notion.createPipelineDeal({
      bankPageId: page.id,
      company,
      driNotionIds: assigneeNotionIds,
      type: classification.type,
      categories: classification.categories,
      contact,
      nextAction: `Send first outreach${opts.knownAsk ? ` — ${opts.knownAsk}` : ''}`,
      nextActionDateIso: isoDaysFromNowET(FIRST_OUTREACH_DAYS),
    });
    assignment = { ...assignmentBase!, dealUrl: deal.url };
  }

  return {
    deduped: false,
    company,
    domain: canonical,
    bankPageUrl: page.url,
    classification,
    contact,
    needsReview,
    reviewReason: reason,
    assignment,
  };
}

"""The enrich_company pipeline:
  1. Resolve the input → domain (deterministic for URLs; Hunter for bare names).
  2. Dedupe against the Bank by domain — BEFORE any Hunter spend on re-runs.
  3. Fetch homepage/about text (deterministic).
  4. Groq → structured JSON classification (forced schema, validated).
  4b. FSAE-ties scan: leadership/team pages → anyone with Formula SAE / Formula Student history
     (fsae_ties.py). Best-effort — a failure leaves the row unscanned for the `fsae_scan_cli` backfill
     to pick up; it never blocks the add.
  5. Hunter → contact + verified email + confidence (only source of contact data).
  6. Create the Bank row: Status=Available, Relationship=New; flag Needs Review when the contact is
     missing/low-confidence/unverified.
  7. Directed add only — if an assignee was given, open a Pipeline deal (Prospect, DRI=assignee) and
     mark the Bank row Graduated/Claimed.
"""
from __future__ import annotations

import dataclasses
import re
from dataclasses import dataclass, field

from utils.logger import logger
from sponsorship.classify import classify_company_fit
from sponsorship.dates import iso_days_from_now_et
from sponsorship.domain import extract_hostname, looks_like_domain, to_canonical_url
from sponsorship.fsae_ties import FsaeScan, scan_fsae_ties
from sponsorship.homepage import fetch_company_text
from sponsorship.hunter import find_contact_by_domain, resolve_by_company
from sponsorship.models import AssignmentInfo, BankRowInput, EnrichResult, HunterContact, PipelineDealInput
from sponsorship.notion import SponsorNotion

# Days out to seed a newly-assigned deal's first next-action (feeds the stale DM).
FIRST_OUTREACH_DAYS = 7


@dataclass
class EnrichOptions:
    """Options for a "directed add": the caller already knows the ask and/or who should own it.
    Slack-side code resolves @mentions to Notion user IDs before calling us."""

    notion: SponsorNotion | None = None
    # The team's known ask — becomes the Suggested angle verbatim + a classifier hint.
    known_ask: str | None = None
    # Notion user IDs to own the deal. Non-empty → open a Pipeline deal + graduate the row.
    assignee_notion_ids: list[str] = field(default_factory=list)
    # Display labels for the assignees, for the confirmation message.
    assignee_labels: list[str] = field(default_factory=list)
    # Mentions that couldn't be resolved to a Notion user (reported, not assigned).
    unresolved_assignees: list[str] = field(default_factory=list)
    # A human-provided contact (name, email). Used INSTEAD of Hunter when present — a contact the
    # requester types is not LLM-invented, so it doesn't violate the no-fabricated-contacts
    # guardrail. Stored with verification_status 'provided'.
    manual_contact: tuple[str, str] | None = None


class DomainResolutionError(Exception):
    pass


# Deliverability statuses we treat as good enough to not flag for review.
OK_STATUSES = {'valid', 'accept_all', 'webmail'}
MIN_CONFIDENCE = 70


def _compute_review(contact: HunterContact | None) -> tuple[bool, str | None]:
    if not contact:
        return True, 'no contact found via Hunter'
    if contact.confidence < MIN_CONFIDENCE:
        c = int(contact.confidence) if float(contact.confidence).is_integer() else contact.confidence
        return True, f'low Hunter confidence ({c})'
    if contact.verification_status not in OK_STATUSES:
        return True, f'email not verified (status: {contact.verification_status})'
    return False, None


def _display_name_from_input(text: str, hostname: str) -> str:
    """Clean a raw `/sponsor add` argument into a human-friendly company display name."""
    if looks_like_domain(text):
        # acme-robotics.com → "Acme Robotics"
        label = hostname.split('.')[0] or hostname
        return ' '.join(w[:1].upper() + w[1:] for w in re.split(r'[-_]', label) if w)
    return text.strip()


def _first_outreach(ask: str | None) -> str:
    return f"Send first outreach{f' — {ask}' if ask else ''}"


def enrich_company(text: str, opts: EnrichOptions | None = None) -> EnrichResult:
    opts = opts or EnrichOptions()
    notion = opts.notion or SponsorNotion()
    assignee_ids = opts.assignee_notion_ids
    assigned = bool(assignee_ids)
    assignment_base = (
        AssignmentInfo(assignees=list(opts.assignee_labels), unresolved=list(opts.unresolved_assignees))
        if assigned or opts.unresolved_assignees
        else None
    )

    raw = text.strip()
    if not raw:
        raise DomainResolutionError('No company or URL provided.')

    # Step 1 — resolve domain. For URLs/domains this is deterministic; for a bare company name we
    # ask Hunter (which also hands back a contact, reused in step 5).
    hostname = extract_hostname(raw)
    company = raw
    pre_resolved_contact: HunterContact | None = None
    if not hostname:
        resolved = resolve_by_company(raw)
        if not resolved.domain:
            raise DomainResolutionError(
                f'Couldn\'t resolve "{raw}" to a company domain. Try `/sponsor add <website url>` instead.'
            )
        hostname = extract_hostname(resolved.domain) or resolved.domain
        company = resolved.organization or raw
        pre_resolved_contact = resolved.contact
    else:
        company = _display_name_from_input(raw, hostname)

    canonical = to_canonical_url(hostname)

    # Step 2 — dedupe by domain (guards both duplicate rows and re-spending credits).
    existing = notion.find_bank_row_by_domain(canonical)
    if existing:
        logger.info(f'Skipping enrichment for {canonical} — already in Bank ({existing.url}).')
        display_company = existing.company or company

        # Directed add against an existing lead: graduate it to a deal now (unless it's already a
        # deal). This is the same graduation `/sponsor claim` does.
        if assigned and not existing.has_pipeline_deal and existing.status != 'Graduated':
            deal = notion.create_pipeline_deal(
                PipelineDealInput(
                    bank_page_id=existing.id,
                    company=display_company,
                    dri_notion_ids=assignee_ids,
                    type=existing.type,
                    categories=existing.categories,
                    contact=existing.contact,
                    next_action=_first_outreach(opts.known_ask),
                    next_action_date_iso=iso_days_from_now_et(FIRST_OUTREACH_DAYS),
                )
            )
            notion.mark_bank_claimed(existing.id, assignee_ids, 'Graduated')
            assert assignment_base is not None
            return EnrichResult(
                deduped=True,
                company=display_company,
                domain=canonical,
                bank_page_url=existing.url,
                already_deal=False,
                assignment=dataclasses.replace(assignment_base, deal_url=deal.url),
            )

        already_deal = existing.has_pipeline_deal or existing.status == 'Graduated'
        return EnrichResult(
            deduped=True, company=display_company, domain=canonical, bank_page_url=existing.url,
            already_deal=already_deal, assignment=assignment_base,
        )

    # Step 3 — homepage/about text (deterministic grounding for the classifier).
    company_text = fetch_company_text(hostname)

    # Step 4 — structured classification (Groq, forced schema, validated). A known ask steers
    # type/category + the value/need scores and is written verbatim as the angle.
    classification = classify_company_fit(company, canonical, company_text, opts.known_ask)
    if opts.known_ask:
        classification.suggested_angle = opts.known_ask

    # Step 4b — FSAE ties: a few more page fetches, plus one Groq call only if a page mentions FSAE.
    fsae: FsaeScan | None = None
    try:
        fsae = scan_fsae_ties(company, hostname)
    except Exception as err:
        logger.warn(f'FSAE-ties scan failed for {canonical}; leaving row unscanned.', err)

    # Step 5 — contact. A requester-provided contact is authoritative (not LLM-invented), so it
    # replaces the Hunter lookup; otherwise fall back to Hunter.
    manual = opts.manual_contact
    if manual and (manual[0] or manual[1]):
        contact: HunterContact | None = HunterContact(manual[0], manual[1], 'provided', 100)
        needs_review, reason = (False, None) if manual[1] else (True, 'contact name provided but no email yet')
    else:
        contact = pre_resolved_contact or find_contact_by_domain(hostname)
        needs_review, reason = _compute_review(contact)

    # Step 6 — write the Bank row. A directed add with an assignee is Graduated + Claimed; a plain
    # add is Available / New.
    page = notion.create_bank_row(
        BankRowInput(
            company=company,
            domain=canonical,
            classification=classification,
            contact=contact,
            needs_review=needs_review,
            review_reason=reason,
            status='Graduated' if assigned else 'Available',
            claimed_by_notion_ids=assignee_ids if assigned else None,
            fsae=fsae,
        )
    )

    # Step 7 — directed add: open the Pipeline deal (Prospect) owned by the DRI(s).
    assignment = assignment_base
    if assigned:
        deal = notion.create_pipeline_deal(
            PipelineDealInput(
                bank_page_id=page.id,
                company=company,
                dri_notion_ids=assignee_ids,
                type=classification.type,
                categories=classification.categories,
                contact=contact,
                next_action=_first_outreach(opts.known_ask),
                next_action_date_iso=iso_days_from_now_et(FIRST_OUTREACH_DAYS),
            )
        )
        assert assignment_base is not None
        assignment = dataclasses.replace(assignment_base, deal_url=deal.url)

    return EnrichResult(
        deduped=False,
        company=company,
        domain=canonical,
        bank_page_url=page.url,
        classification=classification,
        contact=contact,
        fsae=fsae,
        needs_review=needs_review,
        review_reason=reason,
        assignment=assignment,
    )

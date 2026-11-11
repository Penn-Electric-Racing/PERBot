"""Draft-outreach generator for `/sponsor email`. The email is the team's own Notion template
("Sponsorship Email Template"), fetched live and filled mechanically — the LLM writes ONLY the
company-specific fit paragraph (the `[PERSONALIZED]` line), grounded in the prospect's homepage text
plus the enrichment's stored fit reason / suggested angle. Guardrails preserved: no auto-send (the
draft lands on the Bank page for a human to review and copy), and the LLM still never touches
contact data.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

from ..config import config
from ..utils.logger import logger
from .dates import today_iso_et
from .groq_client import groq_json
from .homepage import fetch_company_text
from .models import BankLeadRow
from .notion import DRAFT_EMAIL_MARKER, SponsorNotion

# Where the generated paragraph goes. If the template loses the marker, we fall back to inserting
# after the first (intro) paragraph rather than failing.
PERSONALIZED_MARKER = '[PERSONALIZED]'

MAX_PARAGRAPH_CHARS = 600


@dataclass
class DraftEmailResult:
    company: str
    # The full assembled email, paragraphs separated by blank lines.
    email_text: str
    # Deep link to the draft toggle on the Bank page.
    draft_url: str
    bank_url: str
    # The generated fit paragraph on its own, for a quick sanity check.
    personalized: str
    # False when the homepage couldn't be fetched — the paragraph then leans only on the stored fit
    # reason/angle, so it deserves a closer read.
    grounded: bool
    # True when a specific ask (🎯 toggle or inline `for …`) was included in the draft.
    has_ask: bool


PARAGRAPH_SYSTEM_PROMPT = """You write ONE short paragraph (2–3 sentences, max 450 characters) for a sponsorship outreach email from Penn Electric Racing (PER), the University of Pennsylvania's Formula SAE Electric student team, to a prospective sponsor.

The paragraph makes the case for why THIS company specifically fits as a partner for REV12, PER's first four-wheel-drive electric race car in eight years: reference what the company actually makes or does and connect it concretely to what a student FSAE EV team builds and needs.

Context: your paragraph is inserted immediately after this template sentence — "We believe [COMPANY] would be a strong partner for REV12, our first four-wheel-drive electric race car in eight years." So do NOT re-introduce PER, REV12, or repeat that it is a four-wheel-drive EV; go straight into the company-specific reasoning.

Rules:
- Return ONLY a JSON object: {"paragraph": "..."}.
- Ground every claim about the company in the provided website text and fit notes. Do NOT invent products, numbers, awards, partnerships, or history.
- Never mention or invent any person's name, email, or job title.
- No greeting, no sign-off, no bullet points — one flowing paragraph, first-person plural ("we", "our team").
- Plain, specific, student-engineer voice. No buzzwords ("synergy", "leverage", "passionate"), no empty flattery."""


def _write_fit_paragraph(row: BankLeadRow, company_text: str, ask: str) -> str:
    """LLM step: the fit paragraph. Falls back to a mechanical sentence built from the stored
    enrichment reasoning if the model returns nothing usable."""
    knowns = '\n'.join(
        x
        for x in [
            f'Fit reason (from our research): {row.fit_reason}' if row.fit_reason else '',
            f'Outreach angle (from our research): {row.suggested_angle}' if row.suggested_angle else '',
            f"Engineering categories they relate to: {', '.join(row.categories)}",
            # The ask steers the paragraph toward the concrete request, but the paragraph must NOT
            # enumerate the specs — those are appended verbatim right after it (guardrail: the LLM
            # never rewrites engineering specs — materials, tolerances, callouts).
            (
                "Our specific ask of this company (set this request up naturally in the paragraph, e.g. what we'd like them "
                'to make or provide for us — but do NOT list the detailed specifications; they appear verbatim immediately '
                f'after your paragraph):\n{ask}'
            )
            if ask
            else '',
        ]
        if x
    )
    page = company_text or '(homepage unavailable — use only the fit notes above, and stay general about their products)'
    content = groq_json(PARAGRAPH_SYSTEM_PROMPT, f'Company: {row.company}\n{knowns}\n\nCompany website text:\n{page}', temperature=0.4)

    paragraph = ''
    try:
        raw = json.loads(content)
        if isinstance(raw, dict) and isinstance(raw.get('paragraph'), str):
            paragraph = re.sub(r'\s+', ' ', raw['paragraph']).strip()
    except ValueError:
        pass  # fall through to the mechanical fallback

    if not paragraph:
        logger.warn(f'Fit-paragraph generation returned nothing for {row.company}; using stored reasoning.')
        paragraph = ' '.join(x for x in [row.fit_reason, f'Specifically: {row.suggested_angle}' if row.suggested_angle else ''] if x)
    return paragraph[:MAX_PARAGRAPH_CHARS]


def _fill_placeholders(paragraph: str, row: BankLeadRow, sender_name: str) -> str:
    """Mechanical placeholder fill. Longer placeholders first ([COMPANY NAME] contains [NAME]);
    [Name] (contact) and [NAME] (sender) are distinguished case-sensitively, matching the template's
    own convention. Unknown placeholders are left for a human."""
    out = (
        paragraph.replace('[COMPANY NAME]', row.company)
        .replace('[COMPANY]', row.company)
        .replace('[NAME]', sender_name or '[NAME]')
    )
    parts = (row.contact.name if row.contact else '').strip().split()
    if parts:
        out = out.replace('[Name]', parts[0])
    return out


# Cap for the verbatim ask block (Notion paragraph limit is ~2000 chars/rich text).
MAX_ASK_CHARS = 1800


def draft_outreach_email(notion: SponsorNotion, row: BankLeadRow, sender_name: str, ask: str | None = None) -> DraftEmailResult:
    """Assemble + persist a draft outreach email for one Bank prospect. Template (live from Notion) →
    homepage re-fetch → LLM fit paragraph → mechanical fill → written to the Bank page as a
    `📧 Draft email` toggle (replacing any previous draft). Raises if the template page is
    empty/unreachable.

    Specific ask: an inline ask (from `/sponsor email <co> for …`) or the Bank page's `🎯 Specific
    ask` toggle steers the fit paragraph AND is appended VERBATIM as its own block right after it —
    the LLM never rewrites the specs themselves. When both exist, the inline ask steers the paragraph
    and the toggle supplies the verbatim block (so a quick `for gears` doesn't clobber a detailed spec).

    `sender_name` is the real name of the person the email is from (fills [NAME] + the signature)."""
    template = notion.fetch_page_paragraphs(config.sponsorship.email_template_page_id)
    if not template:
        raise RuntimeError(
            'The email template page is empty or unreachable — check SPONSOR_EMAIL_TEMPLATE_PAGE_ID and the integration’s access to it.'
        )

    inline_ask = (ask or '').strip()
    stored_ask = notion.fetch_ask_section(row.id)[:MAX_ASK_CHARS]
    steering_ask = inline_ask or stored_ask
    # The verbatim block prefers the stored spec; a lone inline ask becomes a one-liner.
    ask_block = stored_ask or (f'- {inline_ask}' if inline_ask else '')

    hostname = re.sub(r'/.*$', '', re.sub(r'^https?://', '', row.domain))
    company_text = fetch_company_text(hostname) if hostname else ''
    personalized = _write_fit_paragraph(row, company_text, steering_ask)

    # Splice the generated paragraph in: replace the [PERSONALIZED] marker paragraph, or insert after
    # the intro paragraph if the marker was removed from the template. The verbatim ask block
    # (lead-in + spec lines) follows it immediately.
    generated = [personalized]
    if ask_block:
        generated.append(f'To be specific, here’s what we’re hoping {row.company} could help us with:')
        generated.append(ask_block)

    paragraphs: list[str] = []
    spliced = False
    for para in template:
        if not spliced and PERSONALIZED_MARKER in para:
            paragraphs.extend(generated)
            spliced = True
        else:
            paragraphs.append(para)
    if not spliced:
        at = min(1, len(paragraphs))
        paragraphs[at:at] = generated

    filled = [_fill_placeholders(p, row, sender_name) for p in paragraphs]

    title = f'{DRAFT_EMAIL_MARKER} — generated {today_iso_et()} · AI-assisted, review before sending'
    block_id = notion.write_draft_email(row.id, title, filled)
    draft_url = f"{row.url}#{block_id.replace('-', '')}" if block_id else row.url

    return DraftEmailResult(
        company=row.company,
        email_text='\n\n'.join(filled),
        draft_url=draft_url,
        bank_url=row.url,
        personalized=personalized,
        grounded=bool(company_text),
        has_ask=bool(ask_block),
    )

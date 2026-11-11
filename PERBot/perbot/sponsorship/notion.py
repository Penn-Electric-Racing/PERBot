"""Notion access layer for the Sponsorship CRM (Prospect Bank + Pipeline).

Uses the data-source API (Notion API version 2026-03-11): pages are created with
`parent: {type: 'data_source_id', data_source_id}` and rows are read via `data_sources.query`.
Notion payloads are typed loosely; values are validated before they reach here.
"""
from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from typing import Any

from ..config import config
from ..notion_api import NotionClient
from ..utils.clock import iso_now
from ..utils.logger import logger
from .dates import today_iso_et
from .domain import extract_hostname
from .fsae_ties import FsaeScan, format_fsae_evidence
from .models import (
    LOSS_REASONS,
    BankLeadRow,
    BankRowInput,
    BankStatus,
    Category,
    HunterContact,
    LossReason,
    NotionUser,
    PipelineDealInput,
    PipelineRow,
    QuotaAuditResult,
    QuotaRosterMember,
    Stage,
    WonKind,
)
from .next_actions import NextActionChange, next_action_after_touch, next_action_for_stage, next_action_properties
from .scoring import SponsorScores


@dataclass
class BankPageRef:
    id: str
    url: str


# Prefix identifying a generated-draft toggle on a Bank page (regeneration replaces it).
DRAFT_EMAIL_MARKER = '📧 Draft email'

# Prefix identifying the specific-ask toggle on a Bank page. Set via `/sponsor ask` (or by hand);
# its contents are included VERBATIM in drafted outreach — specs are never paraphrased by the LLM.
SPECIFIC_ASK_MARKER = '🎯 Specific ask'


def _build_notes(row: BankRowInput) -> str:
    """The Notes text, surfacing the Needs-Review flag (no dedicated Notion column exists)."""
    lines = ['Auto-enriched by /sponsor.']
    if row.contact:
        c = row.contact
        source = 'provided by requester' if c.verification_status == 'provided' else f'Hunter: {c.verification_status}, confidence {_n(c.confidence)}'
        lines.append(f"Contact ({source}): {c.name or '(no name)'} <{c.email or 'no email'}>.")
    else:
        lines.append('No contact found via Hunter.')
    if row.needs_review:
        lines.append(f"⚠️ NEEDS REVIEW: {row.review_reason or 'verify contact before outreach'}.")
    return '\n'.join(lines)


def _n(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else str(v)


# --- Notion property readers (query results are loosely typed) -----------------


def _plain(items: Any) -> str:
    return ''.join((t or {}).get('plain_text') or '' for t in items or []).strip()


def read_title(prop: Any) -> str:
    return _plain((prop or {}).get('title'))


def read_rich_text(prop: Any) -> str:
    return _plain((prop or {}).get('rich_text'))


def read_select(prop: Any) -> str | None:
    return ((prop or {}).get('select') or {}).get('name')


def read_number(prop: Any) -> float | None:
    n = (prop or {}).get('number')
    return n if isinstance(n, (int, float)) and not isinstance(n, bool) else None


def read_date(prop: Any) -> str | None:
    return ((prop or {}).get('date') or {}).get('start')


def read_people_ids(prop: Any) -> list[str]:
    return [p['id'] for p in (prop or {}).get('people') or [] if isinstance((p or {}).get('id'), str)]


def _read_multi_select(prop: Any) -> list[str]:
    return [o['name'] for o in (prop or {}).get('multi_select') or [] if isinstance((o or {}).get('name'), str)]


def _read_email(prop: Any) -> str:
    e = (prop or {}).get('email')
    return e if isinstance(e, str) else ''


def _read_url(prop: Any) -> str:
    u = (prop or {}).get('url')
    return u if isinstance(u, str) else ''


def _read_checkbox(prop: Any) -> bool:
    return (prop or {}).get('checkbox') is True


def _read_relation_count(prop: Any) -> int:
    return len((prop or {}).get('relation') or [])


# Bank columns written by the FSAE-ties scan (created on demand by ensure_fsae_columns).
FSAE_TIES_PROP = 'FSAE ties'
FSAE_EVIDENCE_PROP = 'FSAE evidence'
FSAE_SCANNED_PROP = 'FSAE scanned'


def _fsae_properties(scan: FsaeScan, date_iso: str) -> dict[str, Any]:
    return {
        FSAE_TIES_PROP: {'checkbox': scan.ties},
        FSAE_EVIDENCE_PROP: {'rich_text': [{'text': {'content': format_fsae_evidence(scan)}}]},
        FSAE_SCANNED_PROP: {'date': {'start': date_iso}},
    }


# Pipeline date property PERBot stamps the first time a deal leaves Prospect.
CONTACTED_AT_PROP = 'Contacted at'

# Pipeline columns for loss reasons and the "gone cold" check; Bank column for a sponsor's form (ensure_loss_columns).
LOSS_REASON_PROP = 'Loss reason'
COLD_ASKED_PROP = 'Cold asked'
APPLY_VIA_PROP = 'Apply via'
# Pipeline date: when the Wednesday DM asked "sent it, or release it?" about a claim never contacted.
RELEASE_ASKED_PROP = 'Release asked'

# Stages that mean outreach has gone out — reaching any of them from Prospect stamps `Contacted at`.
CONTACTED_STAGES: frozenset[str] = frozenset({'Contacted', 'In talks', 'Won'})


def parse_bank_row(page: Any) -> BankLeadRow:
    p = (page or {}).get('properties') or {}
    contact_name = read_rich_text(p.get('Contact name'))
    contact_email = _read_email(p.get('Contact email'))
    categories = _read_multi_select(p.get('Category'))
    return BankLeadRow(
        id=page['id'],
        url=page.get('url') or '',
        company=read_title(p.get('Company')),
        status=read_select(p.get('Status')),
        type=read_select(p.get('Type')) or 'Cash',  # type: ignore[arg-type]
        categories=categories or ['General'],
        domain=_read_url(p.get('Domain')),
        fit_reason=read_rich_text(p.get('Fit reason')),
        suggested_angle=read_rich_text(p.get('Suggested angle')),
        contact=HunterContact(contact_name, contact_email, 'from bank', 0) if contact_name or contact_email else None,
        has_pipeline_deal=_read_relation_count(p.get('Pipeline deal')) > 0,
        scores=SponsorScores(
            contact_strength=read_number(p.get('Contact strength')),
            market_fit=read_number(p.get('Market fit')),
            sponsors_other_teams=read_number(p.get('Sponsors other teams')),
            value_band=read_number(p.get('Value band')),
            category_need=read_number(p.get('Category need')),
        ),
        fsae_ties=_read_checkbox(p.get(FSAE_TIES_PROP)),
        fsae_scanned_at=read_date(p.get(FSAE_SCANNED_PROP)),
    )


def parse_pipeline_row(page: Any) -> PipelineRow:
    p = (page or {}).get('properties') or {}
    bank_relation = (p.get('Bank source') or {}).get('relation') or []
    return PipelineRow(
        id=page['id'],
        url=page.get('url') or '',
        company=read_title(p.get('Company')),
        stage=read_select(p.get('Stage')),  # type: ignore[arg-type]
        won_kind=read_select(p.get('Won kind')),  # type: ignore[arg-type]
        dri_user_ids=read_people_ids(p.get('DRI')),
        deal_value=read_number(p.get('Deal value ($)')),
        received=read_number(p.get('Received ($)')),
        last_contact=read_date(p.get('Last contact')),
        next_action=read_rich_text(p.get('Next action')),
        next_action_date=read_date(p.get('Next action date')),
        notes=read_rich_text(p.get('Notes')),
        created_time=page.get('created_time') if isinstance(page.get('created_time'), str) else '',
        contacted_at=read_date(p.get(CONTACTED_AT_PROP)),
        loss_reason=read_select(p.get(LOSS_REASON_PROP)),
        bank_source_id=bank_relation[0].get('id') if bank_relation else None,
        cold_asked_at=read_date(p.get(COLD_ASKED_PROP)),
        release_asked_at=read_date(p.get(RELEASE_ASKED_PROP)),
    )


# Stage filter that excludes the two terminal stages — i.e. live/active deals.
ACTIVE_STAGE_FILTER = {
    'and': [
        {'property': 'Stage', 'select': {'does_not_equal': 'Won'}},
        {'property': 'Stage', 'select': {'does_not_equal': 'Lost'}},
    ]
}


def _rt(content: str) -> dict[str, Any]:
    return {'rich_text': [{'text': {'content': content}}]}


def _date(start: str) -> dict[str, Any]:
    return {'date': {'start': start}}


class SponsorNotion:
    def __init__(self, token: str | None = None, client: Any = None):
        self.client = client or NotionClient(auth=token or config.notion.token, notion_version=config.notion.api_version)
        self._loss_columns_ready: list[str] | None = None
        self._loss_columns_lock = threading.Lock()

    def _query_all(self, data_source_id: str, filter: Any = None) -> list[Any]:
        pages: list[Any] = []
        cursor: str | None = None
        while True:
            kwargs: dict[str, Any] = {'data_source_id': data_source_id, 'start_cursor': cursor, 'page_size': 100}
            if filter:
                kwargs['filter'] = filter
            response = self.client.data_sources.query(**kwargs)
            pages.extend(response.get('results') or [])
            cursor = response.get('next_cursor') if response.get('has_more') else None
            if not cursor:
                return pages

    def find_bank_row_by_domain(self, canonical_domain: str) -> BankLeadRow | None:
        """Dedupe key: look up an existing Bank row by its canonical Domain URL. Returns the parsed
        lead (so a directed add can graduate it) if one exists, else None. The caller passes an
        already-normalized `https://<domain>` string so this is an exact match."""
        response = self.client.data_sources.query(
            data_source_id=config.sponsorship.bank_data_source_id,
            filter={'property': 'Domain', 'url': {'equals': canonical_domain}},
            page_size=1,
        )
        hits = response.get('results') or []
        return parse_bank_row(hits[0]) if hits else None

    def create_bank_row(self, row: BankRowInput) -> BankPageRef:
        """Create a Prospect Bank row from an enrichment result. Enrichment ALWAYS writes
        Status = Available and Relationship = New (guardrail: Relationship is never LLM-guessed).
        Contact fields are written only when Hunter returned a contact."""
        c = row.classification
        properties: dict[str, Any] = {
            'Company': {'title': [{'text': {'content': row.company[:200]}}]},
            'Domain': {'url': row.domain},
            'Status': {'select': {'name': row.status or 'Available'}},
            'Relationship': {'select': {'name': 'New'}},
            # Tier is no longer written — it's a Notion formula derived from Priority. We seed the
            # three AI sub-scores; Contact strength + Sponsors other teams are left blank for a
            # human to fill (guardrail: the LLM never guesses those).
            'Market fit': {'number': c.market_fit},
            'Value band': {'number': c.value_band},
            'Category need': {'number': c.category_need},
            'Type': {'select': {'name': c.type}},
            'Channel': {'select': {'name': c.channel}},
            'Category': {'multi_select': [{'name': name} for name in c.categories]},
            'Fit reason': _rt(c.fit_reason),
            'Needs Review': {'checkbox': row.needs_review},
            'Notes': _rt(_build_notes(row)),
        }
        if c.suggested_angle:
            properties['Suggested angle'] = _rt(c.suggested_angle)
        if row.contact:
            if row.contact.name:
                properties['Contact name'] = _rt(row.contact.name)
            properties['Contact email'] = {'email': row.contact.email}
        if row.claimed_by_notion_ids:
            properties['Claimed by'] = {'people': [{'id': i} for i in row.claimed_by_notion_ids]}
        if row.fsae:
            properties.update(_fsae_properties(row.fsae, today_iso_et()))

        result = self.client.pages.create(
            parent={'type': 'data_source_id', 'data_source_id': config.sponsorship.bank_data_source_id},
            properties=properties,
        )
        logger.info(f"Created Bank row for {row.company} ({row.domain}): {result.get('url')}")
        return BankPageRef(result['id'], result.get('url') or '')

    def find_bank_rows_by_hostname(self, hostname: str) -> list[BankLeadRow]:
        """Bank leads on `hostname` however the Domain was typed (http://, www., trailing path) —
        the forgiving lookup behind `/sponsor claim keye.co`. Enrichment's dedupe keeps the exact
        `find_bank_row_by_domain`."""
        response = self.client.data_sources.query(
            data_source_id=config.sponsorship.bank_data_source_id,
            filter={'property': 'Domain', 'url': {'contains': hostname}},
            page_size=25,
        )
        rows = [parse_bank_row(p) for p in response.get('results') or []]
        return [r for r in rows if extract_hostname(r.domain) == hostname]

    def find_bank_rows_by_company(self, name: str) -> list[BankLeadRow]:
        """Find Bank leads whose Company title contains `name` (for `/sponsor claim`)."""
        response = self.client.data_sources.query(
            data_source_id=config.sponsorship.bank_data_source_id,
            filter={'property': 'Company', 'title': {'contains': name}},
            page_size=25,
        )
        return [parse_bank_row(p) for p in response.get('results') or []]

    def query_rankable_prospects(self, category: Category | None = None) -> list[BankLeadRow]:
        """Rankable prospects for `/sponsor rank`: every live Bank lead (excludes Dead and
        already-Graduated rows), optionally filtered to one Category. Returns them parsed with
        their sub-scores; the caller computes Priority + sorts (the Priority formula isn't
        queryable/sortable via the API — see scoring.py). Follows pagination."""
        conditions: list[Any] = [
            {'property': 'Status', 'select': {'does_not_equal': 'Dead'}},
            {'property': 'Status', 'select': {'does_not_equal': 'Graduated'}},
        ]
        if category:
            conditions.append({'property': 'Category', 'multi_select': {'contains': category}})
        return [parse_bank_row(p) for p in self._query_all(config.sponsorship.bank_data_source_id, {'and': conditions})]

    def query_all_bank_domains(self) -> set[str]:
        """Every hostname already in the Bank (ALL statuses, including Dead/Graduated) — the
        skip-list for `/sponsor scout`, so it never re-suggests a company the team already
        researched, claimed, or wrote off. Bare lowercase hostnames."""
        hostnames: set[str] = set()
        for page in self._query_all(config.sponsorship.bank_data_source_id):
            domain = _read_url(((page or {}).get('properties') or {}).get('Domain'))
            host = extract_hostname(domain) if domain else None
            if host:
                hostnames.add(host)
        return hostnames

    def write_fsae_scan(self, page_id: str, scan: FsaeScan, date_iso: str) -> None:
        """Write an FSAE-ties scan result onto an existing Bank row."""
        self.client.pages.update(page_id, properties=_fsae_properties(scan, date_iso))

    def ensure_fsae_columns(self) -> list[str]:
        """Add the three FSAE columns to the Bank if they're missing. Idempotent; existing columns
        (and anything a human renamed around them) are left alone."""
        ds = self.client.data_sources.retrieve(config.sponsorship.bank_data_source_id)
        have = set((ds.get('properties') or {}).keys())
        wanted = {FSAE_TIES_PROP: {'checkbox': {}}, FSAE_EVIDENCE_PROP: {'rich_text': {}}, FSAE_SCANNED_PROP: {'date': {}}}
        missing = [k for k in wanted if k not in have]
        if missing:
            self.client.data_sources.update(
                config.sponsorship.bank_data_source_id, properties={k: wanted[k] for k in missing}
            )
        return missing

    def update_bank_scores(self, page_id: str, scores: dict[str, float]) -> None:
        """Set one or more priority sub-scores on a Bank row (powers `/sponsor score`). Only the
        provided sub-scores (SponsorScores field names) are written; the rest are left untouched.
        The Fit/Impact/Priority/Quadrant/Tier formulas recompute automatically in Notion."""
        col_by_key = {
            'contact_strength': 'Contact strength',
            'market_fit': 'Market fit',
            'sponsors_other_teams': 'Sponsors other teams',
            'value_band': 'Value band',
            'category_need': 'Category need',
        }
        properties = {
            col: {'number': scores[key]}
            for key, col in col_by_key.items()
            if isinstance(scores.get(key), (int, float)) and not isinstance(scores.get(key), bool)
        }
        if not properties:
            return
        self.client.pages.update(page_id, properties=properties)
        logger.info(f"Updated scores on Bank row {page_id}: {', '.join(properties)}.")

    def mark_bank_claimed(self, page_id: str, notion_ids: list[str], status: BankStatus) -> None:
        """Mark a Bank lead claimed/graduated and set its owner(s)."""
        self.client.pages.update(
            page_id,
            properties={'Status': {'select': {'name': status}}, 'Claimed by': {'people': [{'id': i} for i in notion_ids]}},
        )
        logger.info(f"Bank lead {page_id} → {status}, claimed by {', '.join(notion_ids)}.")

    # --- Pipeline ---------------------------------------------------------------

    def create_pipeline_deal(self, deal: PipelineDealInput) -> BankPageRef:
        """Open a Pipeline deal at Stage = Prospect, owned by the given DRI(s), linked to its Bank row
        via the (dual) Bank source relation. Carries Type/Category/contact across from enrichment.
        Source defaults to Cold; a next action + due date seed the nudge."""
        properties: dict[str, Any] = {
            'Company': {'title': [{'text': {'content': deal.company[:200]}}]},
            'Stage': {'select': {'name': 'Prospect'}},
            'Relationship': {'select': {'name': 'New'}},
            'Source': {'select': {'name': 'Cold'}},
            'Type': {'select': {'name': deal.type}},
            'Category': {'multi_select': [{'name': name} for name in deal.categories]},
            'DRI': {'people': [{'id': i} for i in deal.dri_notion_ids]},
            'Bank source': {'relation': [{'id': deal.bank_page_id}]},
            'Next action': _rt(deal.next_action[:200]),
            'Next action date': _date(deal.next_action_date_iso),
        }
        if deal.contact:
            if deal.contact.name:
                properties['Contact name'] = _rt(deal.contact.name)
            properties['Contact email'] = {'email': deal.contact.email}
        result = self.client.pages.create(
            parent={'type': 'data_source_id', 'data_source_id': config.sponsorship.pipeline_data_source_id},
            properties=properties,
        )
        logger.info(f"Opened Pipeline deal for {deal.company} (DRI {', '.join(deal.dri_notion_ids)}): {result.get('url')}")
        return BankPageRef(result['id'], result.get('url') or '')

    def _query_pipeline(self, filter: Any = None) -> list[PipelineRow]:
        """Query the Pipeline data source with an optional filter, following pagination."""
        return [parse_pipeline_row(p) for p in self._query_all(config.sponsorship.pipeline_data_source_id, filter)]

    def fetch_deal(self, page_id: str) -> PipelineRow:
        """Re-read one deal by page id (button handlers do this first — the DM may be days old)."""
        return parse_pipeline_row(self.client.pages.retrieve(page_id))

    def query_won_deals(self) -> list[PipelineRow]:
        """All Won deals — feeds the win post + running total."""
        return self._query_pipeline({'property': 'Stage', 'select': {'equals': 'Won'}})

    def query_all_deals(self) -> list[PipelineRow]:
        """Every Pipeline deal, all stages — feeds the leaderboard."""
        return self._query_pipeline()

    def query_active_deals_for_user(self, notion_user_id: str) -> list[PipelineRow]:
        """Active deals owned by a given Notion user — powers `/sponsor me`."""
        return self._query_pipeline({'and': [ACTIVE_STAGE_FILTER, {'property': 'DRI', 'people': {'contains': notion_user_id}}]})

    def query_stale_deals(self, today_iso: str) -> list[PipelineRow]:
        """Active deals whose Next action date is before `today_iso` — the Wednesday DM."""
        return self._query_pipeline({'and': [ACTIVE_STAGE_FILTER, {'property': 'Next action date', 'date': {'before': today_iso}}]})

    def find_deals_by_company(self, name: str) -> list[PipelineRow]:
        """Find Pipeline deals whose Company title contains `name` (for `/sponsor log`)."""
        return self._query_pipeline({'property': 'Company', 'title': {'contains': name}})

    def find_deals_for_bank_row(self, bank_page_id: str) -> list[PipelineRow]:
        """Deals graduated from one Bank lead (via the Bank source relation) — title-independent."""
        return self._query_pipeline({'property': 'Bank source', 'relation': {'contains': bank_page_id}})

    def query_deals_edited_since(self, since_iso: str) -> list[PipelineRow]:
        """Deals edited (which includes created, and re-assigned — the DRI sync stamps the page)
        at/after `since_iso` — a superset of every deal that can carry an assignment inside the quota
        window, so the audit doesn't have to scan the whole Pipeline."""
        return self._query_pipeline({'timestamp': 'last_edited_time', 'last_edited_time': {'on_or_after': since_iso}})

    def query_contacted_deals(self) -> list[PipelineRow]:
        """Every deal still at Contacted (no reply yet) — feeds the quota post's follow-up gap."""
        return self._query_pipeline({'property': 'Stage', 'select': {'equals': 'Contacted'}})

    # --- Loss reasons + "gone cold" check ------------------------------------------

    def ensure_loss_columns(self, create: bool = True) -> list[str]:
        """Add `Loss reason` (select), `Cold asked` and `Release asked` (dates) to the Pipeline and
        `Apply via` (url) to the Bank if they're missing. Idempotent, and memoized per process so
        every write below can call it without a schema round-trip each time (a failure isn't
        memoized, so the next write retries). With `create=False` it only reports what's missing
        (dry runs make no writes, schema included)."""
        with self._loss_columns_lock:
            if create and self._loss_columns_ready is not None:
                return self._loss_columns_ready
            missing: list[str] = []
            targets: list[tuple[str, dict[str, Any]]] = [
                (
                    config.sponsorship.pipeline_data_source_id,
                    {
                        LOSS_REASON_PROP: {'select': {'options': [{'name': name} for name in LOSS_REASONS]}},
                        COLD_ASKED_PROP: {'date': {}},
                        RELEASE_ASKED_PROP: {'date': {}},
                    },
                ),
                (config.sponsorship.bank_data_source_id, {APPLY_VIA_PROP: {'url': {}}}),
            ]
            for ds_id, wanted in targets:
                ds = self.client.data_sources.retrieve(ds_id)
                have = set((ds.get('properties') or {}).keys())
                absent = [k for k in wanted if k not in have]
                missing.extend(absent)
                if create and absent:
                    self.client.data_sources.update(ds_id, properties={k: wanted[k] for k in absent})
                    logger.info(f"Added {', '.join(absent)} to data source {ds_id}.")
            if create:
                self._loss_columns_ready = missing
            return missing

    def query_cold_deals(self, before_iso: str, cold_asked_column: bool = True) -> list[PipelineRow]:
        """Deals still at Contacted whose `Contacted at` is before `before_iso` and that the
        Wednesday DM hasn't asked about yet. `cold_asked_column=False` (a dry run before the column
        exists) drops that condition instead of failing the query."""
        conditions: list[Any] = [
            {'property': 'Stage', 'select': {'equals': 'Contacted'}},
            {'property': CONTACTED_AT_PROP, 'date': {'before': before_iso}},
        ]
        if cold_asked_column:
            conditions.append({'property': COLD_ASKED_PROP, 'date': {'is_empty': True}})
        return self._query_pipeline({'and': conditions})

    def apply_next_action(self, page_id: str, change: NextActionChange) -> None:
        """Set (or clear) Next action + date in one write. Used by the one-time cleanup."""
        self.client.pages.update(page_id, properties=next_action_properties(change))

    def query_stale_claims(self, before_iso: str) -> list[PipelineRow]:
        """Deals still at Prospect (claimed, never contacted) created before `before_iso`."""
        return self._query_pipeline(
            {
                'and': [
                    {'property': 'Stage', 'select': {'equals': 'Prospect'}},
                    {'timestamp': 'created_time', 'created_time': {'before': before_iso}},
                ]
            }
        )

    def stamp_release_asked(self, page_id: str, date_iso: str) -> None:
        """Record that the Wednesday DM asked "sent it, or release it?" about this claim."""
        self.ensure_loss_columns()
        self.client.pages.update(page_id, properties={RELEASE_ASKED_PROP: _date(date_iso)})

    def release_claim(self, row: PipelineRow) -> None:
        """Give a claim back: the Bank lead returns to Available with no claimer, so anyone can
        `/sponsor claim` it, and the Prospect deal goes to Notion's trash (restorable for 30 days).
        It isn't marked Lost, because nobody ever asked the company, so it shouldn't count as a loss."""
        if row.bank_source_id:
            self.client.pages.update(
                row.bank_source_id,
                # Unlink the deal too: `/sponsor claim` refuses a lead whose Pipeline deal relation is
                # non-empty, and a trashed page can linger there. (Restoring the deal from trash won't relink it.)
                properties={
                    'Status': {'select': {'name': 'Available'}},
                    'Claimed by': {'people': []},
                    'Pipeline deal': {'relation': []},
                },
            )
        self.client.pages.update(row.id, in_trash=True)
        logger.info(
            f"Released claim on {row.company or 'Untitled'} ({row.id}){', Bank lead → Available' if row.bank_source_id else ''}."
        )

    def stamp_cold_asked(self, page_id: str, date_iso: str) -> None:
        """Record that the Wednesday DM asked about this deal, so it's asked once, not weekly."""
        self.ensure_loss_columns()
        self.client.pages.update(page_id, properties={COLD_ASKED_PROP: _date(date_iso)})

    def write_loss_reason(self, row: PipelineRow, reason: LossReason, date_iso: str) -> None:
        """Set `Loss reason` and prepend a dated note. Doesn't touch Stage or Last contact."""
        self.ensure_loss_columns()
        dated = f'{date_iso}: Loss reason: {reason} (via Slack)'
        notes = f'{dated}\n{row.notes}' if row.notes else dated
        self.client.pages.update(
            row.id, properties={LOSS_REASON_PROP: {'select': {'name': reason}}, 'Notes': _rt(notes[:1900])}
        )
        logger.info(f'Loss reason on {row.company} ({row.id}): {reason}.')

    def set_next_action(self, page_id: str, action: str, date_iso: str) -> None:
        """Set Next action + its date without logging a touch ("Still waiting" on a cold deal)."""
        self.client.pages.update(page_id, properties={'Next action': _rt(action), 'Next action date': _date(date_iso)})

    def mark_bank_dead(self, page_id: str) -> None:
        """Mark a Bank lead Dead, so ranking and claiming skip it next season."""
        self.client.pages.update(page_id, properties={'Status': {'select': {'name': 'Dead'}}})
        logger.info(f'Bank lead {page_id} → Dead.')

    def write_bank_apply_via(self, page_id: str, url: str) -> None:
        """Save the form / application a company routes sponsorship through on its Bank row."""
        self.ensure_loss_columns()
        self.client.pages.update(page_id, properties={APPLY_VIA_PROP: {'url': url}})

    def write_contacted_at(self, page_id: str, iso: str) -> None:
        """Stamp `Contacted at` (first move out of Prospect) — quota credit; see jobs/quota_audit.py."""
        self.client.pages.update(page_id, properties={CONTACTED_AT_PROP: _date(iso)})

    def query_reply_pending(self) -> list[PipelineRow]:
        """Deals flagged Reply pending by the Phase-3 flow — awaiting a DRI DM."""
        return self._query_pipeline({'property': 'Reply pending', 'checkbox': {'equals': True}})

    def clear_reply_pending(self, page_id: str) -> None:
        """Clear the Reply pending flag once the DRI has been DM'd."""
        self.client.pages.update(page_id, properties={'Reply pending': {'checkbox': False}})

    def log_touch(self, row: PipelineRow, note: str, date_iso: str) -> None:
        """Log a manual touch: stamp Last contact = `date_iso` and prepend a dated note. Notes is
        capped so it can't grow unbounded across many touches."""
        dated = f'{date_iso}: {note}'
        merged = f'{dated}\n{row.notes}' if row.notes else dated
        follow_up = next_action_after_touch(row, date_iso)
        properties: dict[str, Any] = {'Last contact': _date(date_iso), 'Notes': _rt(merged[:1900])}
        if follow_up:
            properties.update(next_action_properties(follow_up))
        self.client.pages.update(row.id, properties=properties)
        logger.info(f'Logged touch on {row.company} ({row.id}).')

    def mark_won(self, row: PipelineRow, amount_usd: float, note: str, date_iso: str, kind: WonKind | None = None) -> None:
        """Mark a deal Won: Stage=Won, Received ($)=amount (the live counter), and Deal value if it
        was blank. Stamps Last contact and prepends a dated WON note. The #operations win post is
        triggered separately (by the command or the hourly job)."""
        properties: dict[str, Any] = {
            'Stage': {'select': {'name': 'Won'}},
            'Received ($)': {'number': amount_usd},
            'Last contact': _date(date_iso),
        }
        if kind:
            properties['Won kind'] = {'select': {'name': kind}}
        nxt = next_action_for_stage(row, 'Won', date_iso)
        if nxt:
            properties.update(next_action_properties(nxt))
        if row.deal_value is None:
            properties['Deal value ($)'] = {'number': amount_usd}
        # Won straight from Prospect still means outreach happened — date it for the quota audit.
        if not row.contacted_at:
            properties[CONTACTED_AT_PROP] = _date(iso_now())
        if note:
            merged = f'{date_iso}: WON — {note}' + (f'\n{row.notes}' if row.notes else '')
            properties['Notes'] = _rt(merged[:1900])
        self.client.pages.update(row.id, properties=properties)
        logger.info(f'Marked WON: {row.company} (${_n(amount_usd)}).')

    def set_stage(self, row: PipelineRow, stage: Stage, date_iso: str, note: str | None = None, loss_reason: LossReason | None = None) -> None:
        """Move a deal to any Stage and stamp Last contact. The first move out of Prospect into
        Contacted / In talks / Won also stamps `Contacted at` (the quota audit's signal) — once per
        deal, so bouncing a deal back and forth never earns a second credit."""
        properties: dict[str, Any] = {'Stage': {'select': {'name': stage}}, 'Last contact': _date(date_iso)}
        if loss_reason:
            # Same write as the stage move, so Notes isn't rewritten twice from a stale copy.
            self.ensure_loss_columns()
            properties[LOSS_REASON_PROP] = {'select': {'name': loss_reason}}
        if stage in CONTACTED_STAGES and not row.contacted_at:
            properties[CONTACTED_AT_PROP] = _date(iso_now())
        # Swap PERBot's own Next action ("Send first outreach") for the one this stage needs.
        nxt = next_action_for_stage(row, stage, date_iso)
        if nxt:
            properties.update(next_action_properties(nxt))
        if note:
            # Same dated-line convention as log_touch, so Slack-driven moves show in the audit trail.
            merged = f'{date_iso}: {note}' + (f'\n{row.notes}' if row.notes else '')
            properties['Notes'] = _rt(merged[:1900])
        self.client.pages.update(row.id, properties=properties)
        logger.info(f'Set stage {stage}: {row.company} ({row.id}).')

    # --- Weekly quota audit -------------------------------------------------------

    def query_quota_roster(self) -> list[QuotaRosterMember]:
        """Active members of the 👥 Ops Quota Roster. Rows without a Member person are skipped with a
        warning (nothing to match a DRI against). Ops leads edit this list in Notion."""
        members: list[QuotaRosterMember] = []
        for page in self._query_all(
            config.sponsorship.quota_roster_data_source_id, {'property': 'Active', 'checkbox': {'equals': True}}
        ):
            p = (page or {}).get('properties') or {}
            name = read_title(p.get('Name'))
            ids = read_people_ids(p.get('Member'))
            if not ids:
                logger.warn(f"Quota roster: \"{name or page['id']}\" has no Member person — skipping.")
                continue
            members.append(QuotaRosterMember(name=name or ids[0], notion_user_id=ids[0]))
        return members

    def upsert_quota_audit_row(self, result: QuotaAuditResult) -> BankPageRef:
        """Write one member's weekly result to 📋 Weekly Quota Audit — creating the row for (member,
        week end) or updating it if a previous run already wrote one (re-runs and forced runs are
        safe; the row always reflects the latest check)."""
        member = result.member
        existing = self.client.data_sources.query(
            data_source_id=config.sponsorship.quota_audit_data_source_id,
            filter={
                'and': [
                    {'property': 'Week end', 'date': {'equals': result.week_end_iso}},
                    {'property': 'Member', 'people': {'contains': member.notion_user_id}},
                ]
            },
            page_size=1,
        )
        properties = {
            'Name': {'title': [{'text': {'content': f'{member.name} — week ending {result.week_end_iso}'[:200]}}]},
            'Member': {'people': [{'id': member.notion_user_id}]},
            'Week start': _date(result.week_start_iso),
            'Week end': _date(result.week_end_iso),
            'Contacted': {'number': len(result.deals)},
            'Quota': {'number': result.quota},
            'Met': {'checkbox': result.met},
            'Deals': {'relation': [{'id': d.id} for d in result.deals]},
            'Checked at': _date(iso_now()),
        }
        hits = existing.get('results') or []
        if hits:
            updated = self.client.pages.update(hits[0]['id'], properties=properties)
            return BankPageRef(updated['id'], updated.get('url') or '')
        created = self.client.pages.create(
            parent={'type': 'data_source_id', 'data_source_id': config.sponsorship.quota_audit_data_source_id},
            properties=properties,
        )
        return BankPageRef(created['id'], created.get('url') or '')

    # --- Page content (email template + drafts) ----------------------------------

    def _children(self, block_id: str) -> list[Any]:
        blocks: list[Any] = []
        cursor: str | None = None
        while True:
            response = self.client.blocks.children.list(block_id, start_cursor=cursor, page_size=100)
            blocks.extend(response.get('results') or [])
            cursor = response.get('next_cursor') if response.get('has_more') else None
            if not cursor:
                return blocks

    @staticmethod
    def _block_text(block: Any) -> str | None:
        rich = ((block or {}).get(block.get('type')) or {}).get('rich_text') if block else None
        return ''.join((t or {}).get('plain_text') or '' for t in rich) if isinstance(rich, list) else None

    def fetch_page_paragraphs(self, page_id: str) -> list[str]:
        """Plain-text paragraphs of a page's body — used to read the team's outreach email template
        live, so ops can edit the template in Notion without a redeploy. Every block with rich text
        (paragraph, heading, quote…) becomes one paragraph string; formatting is intentionally
        dropped (the draft is a plain-text email)."""
        out: list[str] = []
        for block in self._children(page_id):
            text = self._block_text(block)
            if text and text.strip():
                out.append(text.strip())
        return out

    def _read_block_lines(self, block_id: str, depth: int) -> list[str]:
        """Recursively read a block's children as indented plain-text bullet lines (depth-capped).
        Notion returns only one level per children.list call, so nested bullets — sub-specs like a
        gear's bore diameter — require recursion or they'd be silently dropped."""
        if depth > 3:
            return []
        lines: list[str] = []
        for block in self._children(block_id):
            text = self._block_text(block)
            if text is not None and text.strip():
                lines.append(f"{'  ' * depth}- {text.strip()}")
            if block.get('has_children'):
                lines.extend(self._read_block_lines(block['id'], depth + 1))
        return lines

    def fetch_ask_section(self, page_id: str) -> str:
        """Read the `🎯 Specific ask` toggle from a Bank row's page, if present, as verbatim
        bullet-line text ('' when there is no ask). Humans paste detailed multi-line specs under the
        toggle in Notion; `/sponsor ask` creates/replaces it from Slack."""
        for block in self._children(page_id):
            text = self._block_text(block)
            if text is not None and text.startswith(SPECIFIC_ASK_MARKER) and block.get('has_children'):
                return '\n'.join(self._read_block_lines(block['id'], 0))
        return ''

    def _delete_toggles(self, page_id: str, marker: str) -> None:
        stale = []
        for block in self._children(page_id):
            rich = ((block or {}).get('toggle') or {}).get('rich_text')
            if isinstance(rich, list) and ''.join((t or {}).get('plain_text') or '' for t in rich).startswith(marker):
                stale.append(block['id'])
        for id_ in stale:
            self.client.blocks.delete(id_)

    def write_ask_section(self, page_id: str, ask: str) -> str:
        """Create/replace the `🎯 Specific ask` toggle on a Bank row (powers `/sponsor ask`). Each
        input line becomes one bullet under the toggle; people then refine the details in Notion.
        Same replace-the-marker-toggle pattern as write_draft_email. Returns the toggle's block id."""
        import re

        self._delete_toggles(page_id, SPECIFIC_ASK_MARKER)
        lines = [l for l in (re.sub(r'^\s*[-•]\s*', '', x).strip() for x in ask.split('\n')) if l]
        result = self.client.blocks.children.append(
            page_id,
            children=[
                {
                    'type': 'toggle',
                    'toggle': {
                        'rich_text': [{'type': 'text', 'text': {'content': f'{SPECIFIC_ASK_MARKER} — included verbatim in drafted outreach'}}],
                        'children': [
                            {'type': 'bulleted_list_item', 'bulleted_list_item': {'rich_text': [{'type': 'text', 'text': {'content': l[:1900]}}]}}
                            for l in lines
                        ],
                    },
                }
            ],
        )
        block_id = ((result.get('results') or [{}])[0]).get('id') or ''
        logger.info(f'Wrote specific-ask toggle on {page_id} ({len(lines)} lines).')
        return block_id

    def write_draft_email(self, page_id: str, title: str, paragraphs: list[str]) -> str:
        """Write the draft email onto a Bank row's page body as a single toggle block
        (`📧 Draft email — …`) holding one paragraph block per email paragraph. Regenerating replaces
        the previous draft: any existing toggle starting with the marker is deleted first (a toggle
        groups the draft atomically, so deletion can't take out unrelated notes someone added to the
        page). Returns the toggle's block id so callers can deep-link to it (page URL +
        `#<id without dashes>`)."""
        self._delete_toggles(page_id, DRAFT_EMAIL_MARKER)
        result = self.client.blocks.children.append(
            page_id,
            children=[
                {
                    'type': 'toggle',
                    'toggle': {
                        'rich_text': [{'type': 'text', 'text': {'content': title[:200]}}],
                        'children': [
                            {'type': 'paragraph', 'paragraph': {'rich_text': [{'type': 'text', 'text': {'content': p[:1900]}}]}}
                            for p in paragraphs
                        ],
                    },
                }
            ],
        )
        block_id = ((result.get('results') or [{}])[0]).get('id') or ''
        logger.info(f'Wrote draft email toggle on {page_id} ({len(paragraphs)} paragraphs).')
        return block_id

    def list_notion_users(self) -> list[NotionUser]:
        """Workspace users (id + display name + email) for bridging Notion DRI persons to Slack
        identities. Email may be None if the integration lacks the "read user emails" capability —
        the identity resolver falls back to name matching then."""
        users: list[NotionUser] = []
        cursor: str | None = None
        while True:
            response = self.client.users.list(start_cursor=cursor, page_size=100)
            for user in response.get('results') or []:
                if user.get('type') == 'bot' or not user.get('id'):
                    continue
                email = (user.get('person') or {}).get('email')
                users.append(
                    NotionUser(user['id'], user['name'] if isinstance(user.get('name'), str) else '', email if isinstance(email, str) else None)
                )
            cursor = response.get('next_cursor') if response.get('has_more') else None
            if not cursor:
                return users

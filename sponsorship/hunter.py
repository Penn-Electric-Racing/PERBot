"""Hunter.io client — the ONLY source of contact data (hard guardrail: the LLM never invents
contacts). Every contact carries a verification status + confidence, both stored on the Bank row.
Best-effort throughout: a Hunter failure yields a None contact (→ the row is flagged Needs Review),
never a fabricated one.

Credit note: domain-search is 1 credit; we verify only the single chosen email (1 more), so ~2
credits per enrichment. Dedupe (before this runs) prevents re-spend.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any

from core import http
from core.config import config
from sponsorship.models import HunterContact

logger = logging.getLogger(__name__)

__all__ = [
    'HUNTER_BASE', 'HUNTER_TIMEOUT_S', 'ROLE_PRIORITY', 'find_contact_by_domain',
    'CompanyLookup', 'resolve_by_company',
]

HUNTER_BASE = 'https://api.hunter.io/v2'
HUNTER_TIMEOUT_S = 12

# Role buckets, best → worst, for sponsorship outreach. Lower index = better contact.
ROLE_PRIORITY = [
    re.compile(r'partnership|sponsor|philanthrop|community|outreach|alliance', re.I),
    re.compile(r'marketing|brand|communicat|\bpr\b|public relations', re.I),
    re.compile(r'recruit|talent|university|campus|early career', re.I),
    re.compile(r'founder|ceo|chief|president|owner|principal|director', re.I),
    re.compile(r'engineer|technical|product', re.I),
]


def _role_rank(position: str | None) -> int:
    if not position:
        return len(ROLE_PRIORITY)
    return next((i for i, rx in enumerate(ROLE_PRIORITY) if rx.search(position)), len(ROLE_PRIORITY))


async def _hunter_get(path: str, params: dict[str, str]) -> Any | None:
    try:
        res = await http.get(f'{HUNTER_BASE}/{path}', params={**params, 'api_key': config.hunter.api_key}, timeout=HUNTER_TIMEOUT_S)
        if not res.ok:
            logger.warning(f'Hunter {path} returned {res.status_code}: {res.text}')
            return None
        return res.json()
    except Exception as err:
        logger.warning(f'Hunter {path} request failed', exc_info=err)
        return None


@dataclass
class _DomainSearch:
    domain: str | None
    organization: str | None
    emails: list[dict[str, Any]]


async def _domain_search(domain: str | None = None, company: str | None = None) -> _DomainSearch:
    query = {'limit': '10'}
    if domain:
        query['domain'] = domain
    if company:
        query['company'] = company
    data = ((await _hunter_get('domain-search', query) or {}).get('data')) or {}
    return _DomainSearch(
        domain=data['domain'] if isinstance(data.get('domain'), str) else None,
        organization=data['organization'] if isinstance(data.get('organization'), str) else None,
        emails=data['emails'] if isinstance(data.get('emails'), list) else [],
    )


def _pick_best_email(emails: list[dict[str, Any]]) -> dict[str, Any] | None:
    with_email = [e for e in emails if e and isinstance(e.get('value'), str) and '@' in e['value']]
    if not with_email:
        return None
    return sorted(with_email, key=lambda e: (_role_rank(e.get('position')), -(e.get('confidence') or 0)))[0]


async def _verify_email(email: str) -> tuple[str, float] | None:
    """Best-effort deliverability verification of the chosen email. None on any failure."""
    data = (await _hunter_get('email-verifier', {'email': email}) or {}).get('data')
    if not data:
        return None
    return (
        data['status'] if isinstance(data.get('status'), str) else 'unknown',
        data['score'] if isinstance(data.get('score'), (int, float)) else 0,
    )


async def _build_contact(best: dict[str, Any] | None) -> HunterContact | None:
    if not best:
        return None
    verification = await _verify_email(best['value'])
    name = ' '.join(x for x in (best.get('first_name'), best.get('last_name')) if x).strip()
    fallback_status = ((best.get('verification') or {}).get('status')) or 'unverified'
    return HunterContact(
        name=name,
        email=best['value'],
        verification_status=verification[0] if verification else fallback_status,
        confidence=verification[1] if verification else (best.get('confidence') or 0),
    )


async def find_contact_by_domain(hostname: str) -> HunterContact | None:
    """Find the best contact for a known domain."""
    if not config.has_hunter:
        logger.warning('HUNTER_API_KEY not set — skipping contact enrichment.')
        return None
    return await _build_contact(_pick_best_email((await _domain_search(domain=hostname)).emails))


@dataclass
class CompanyLookup:
    domain: str | None
    organization: str | None
    contact: HunterContact | None


async def resolve_by_company(name: str) -> CompanyLookup:
    """Resolve a bare company name → domain via Hunter, and return the best contact from the same
    call. Used when `/sponsor add` is given a name rather than a URL."""
    if not config.has_hunter:
        logger.warning('HUNTER_API_KEY not set — cannot resolve a company name to a domain.')
        return CompanyLookup(None, None, None)
    result = await _domain_search(company=name)
    return CompanyLookup(result.domain, result.organization, await _build_contact(_pick_best_email(result.emails)))

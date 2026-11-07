"""Deterministic domain handling for enrichment (no LLM involved — guardrail: domain resolution is
mechanical). A `/sponsor add` argument is either a URL/domain ("https://acme.com", "acme.com") or a
bare company name ("Acme Robotics"). We can only resolve the former deterministically; bare names
are resolved downstream via Hunter's company→domain lookup.
"""
from __future__ import annotations

import re
from urllib.parse import urlsplit


def extract_hostname(text: str) -> str | None:
    """Strip protocol, path, port, and a leading www. → bare lowercase hostname, or None."""
    trimmed = text.strip()
    if not trimmed:
        return None
    # A URL parser needs a scheme; add one if the user omitted it.
    with_scheme = trimmed if re.match(r'^[a-z][a-z0-9+.-]*://', trimmed, re.I) else f'https://{trimmed}'
    try:
        candidate = urlsplit(with_scheme).hostname or ''
    except ValueError:
        return None
    host = re.sub(r'^www\.', '', candidate.lower())
    # Must look like a real domain: at least one dot and a plausible TLD.
    return host if re.fullmatch(r'[a-z0-9-]+(\.[a-z0-9-]+)+', host) else None


def looks_like_domain(text: str) -> bool:
    """True when the input looks like a URL/domain rather than a company name."""
    trimmed = text.strip()
    # A bare name usually has spaces; a domain does not and contains a dot.
    if re.search(r'\s', trimmed) and not re.match(r'^[a-z]+://', trimmed, re.I):
        return False
    return extract_hostname(trimmed) is not None


def to_canonical_url(hostname: str) -> str:
    """The canonical form we store in Notion's Domain (url) column and dedupe on."""
    host = re.sub(r'^www\.', '', hostname.lower())
    return f'https://{host}'

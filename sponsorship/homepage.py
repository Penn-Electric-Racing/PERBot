"""Deterministically fetch a company's homepage (and /about if the homepage is thin) and reduce it
to plain text for the classifier. This is NOT the LLM — it's the grounding evidence the LLM
classifies. Best-effort: on any failure we return whatever text we have (possibly empty), and the
classifier still runs on the company name + domain.
"""
from __future__ import annotations

import re

import httpx

from utils.logger import logger

MAX_TEXT_CHARS = 6000
FETCH_TIMEOUT_S = 12


def strip_html(html: str) -> str:
    s = re.sub(r'<script[\s\S]*?</script>', ' ', html, flags=re.I)
    s = re.sub(r'<style[\s\S]*?</style>', ' ', s, flags=re.I)
    s = re.sub(r'<noscript[\s\S]*?</noscript>', ' ', s, flags=re.I)
    s = re.sub(r'<!--[\s\S]*?-->', ' ', s)
    s = re.sub(r'<[^>]+>', ' ', s)
    s = s.replace('&nbsp;', ' ').replace('&amp;', '&').replace('&quot;', '"')
    s = re.sub(r'&#39;|&apos;', "'", s)
    s = s.replace('&lt;', '<').replace('&gt;', '>')
    return re.sub(r'\s+', ' ', s).strip()


def fetch_html(url: str) -> str:
    """Raw HTML (or plain text) of `url`, '' on any failure or non-text response."""
    try:
        res = httpx.get(
            url,
            follow_redirects=True,
            headers={'User-Agent': 'PERBot-Sponsorship/1.0 (+https://github.com/Penn-Electric-Racing/PERBot)'},
            timeout=FETCH_TIMEOUT_S,
        )
        if not res.is_success:
            return ''
        content_type = res.headers.get('content-type') or ''
        if 'text/html' not in content_type and 'text/plain' not in content_type:
            return ''
        return res.text
    except Exception as err:
        logger.warn(f'Homepage fetch failed for {url}', err)
        return ''


def _fetch_text(url: str) -> str:
    return strip_html(fetch_html(url))


def fetch_company_text(hostname: str) -> str:
    """Cleaned homepage text for `hostname`, augmented with /about text when the homepage alone is
    thin. Capped at MAX_TEXT_CHARS."""
    base = f'https://{hostname}'
    text = _fetch_text(base)
    if len(text) < 600:
        about = _fetch_text(f'{base}/about')
        if about:
            text = f'{text} {about}'.strip()
    return text[:MAX_TEXT_CHARS]

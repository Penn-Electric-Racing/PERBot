"""FSAE-ties detector: does anyone at this company have Formula SAE / Formula Student history? A
former FSAE member in leadership is the warmest cold lead we get, so `/sponsor rank` puts these
rows above everything else.

Two stages, same split as enrichment:
  1. Deterministic — crawl the homepage plus its leadership/team/about pages (same host, capped)
     and regex for FSAE terms. No match → no ties, no LLM call.
  2. Groq — label each matched snippet: a named PERSON with FSAE history, the COMPANY itself
     backing/recruiting from FSAE, or neither. Every label is checked against the page text: the
     quote must be verbatim and the person's name must appear in it, so the evidence written to
     Notion is never LLM-invented.

Coverage caveat: sites that render bios client-side (React/Webflow CMS) return little text to a
plain fetch, so "no ties" means "none found on the public HTML", not "none".
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urljoin, urlsplit

from sponsorship.discovery import chat_json
from sponsorship.domain import extract_hostname
from sponsorship.homepage import fetch_html, strip_html

# FSAE terms. Excludes "Formula E"/"Formula 1" (pro series, not student history).
FSAE_PATTERN = re.compile(r'\b(?:formula[\s-]*sae|fsae|formula[\s-]+student|formula[\s-]+hybrid|sae[\s-]+formula)\b', re.I)

# Path or link-text words that mark a page likely to hold people's bios.
TEAM_PAGE_HINT = re.compile(
    r'\b(?:about|team|leadership|people|management|founders?|our[\s-]?story|who[\s-]?we[\s-]?are|executives?|board|company|careers)\b',
    re.I,
)

# Tried when the homepage links to nothing that looks like a team page.
FALLBACK_PATHS = ['/about', '/about-us', '/team', '/our-team', '/leadership', '/company']

MAX_LINKED_PAGES = 6
SNIPPET_RADIUS = 280
MAX_SNIPPETS = 8


@dataclass
class FsaePerson:
    name: str
    quote: str
    url: str


@dataclass
class FsaeCompanyMention:
    quote: str
    url: str
    # Named internal champion (e.g. whoever runs their FSAE donation program), when the page names one.
    champion: str | None = None


@dataclass
class FsaeScan:
    # True when at least one named person has verified FSAE/Formula Student history.
    ties: bool
    people: list[FsaePerson] = field(default_factory=list)
    # The company itself sponsoring / recruiting from FSAE — a lead for "Sponsors other teams".
    company_mentions: list[FsaeCompanyMention] = field(default_factory=list)
    pages_scanned: list[str] = field(default_factory=list)


@dataclass
class Snippet:
    url: str
    text: str


def _same_site(a: str, b: str) -> bool:
    return re.sub(r'^www\.', '', a) == re.sub(r'^www\.', '', b)


def find_team_page_links(html: str, base_url: str, limit: int = MAX_LINKED_PAGES) -> list[str]:
    """Same-site links from `html` that look like leadership/team/about pages, best first. A link
    counts when its path or its anchor text carries a team-page word."""
    base_host = extract_hostname(base_url) or ''
    scored: dict[str, int] = {}
    for m in re.finditer(r'<a\b[^>]*?href\s*=\s*["\']([^"\'#]+)["\'][^>]*>([\s\S]*?)</a>', html, re.I):
        try:
            url = urlsplit(urljoin(base_url, m.group(1)))
            host = url.hostname or ''
        except ValueError:
            continue
        path = url.path or '/'
        if url.scheme not in ('http', 'https') or not _same_site(host, base_host):
            continue
        if re.search(r'\.(?:pdf|jpe?g|png|gif|svg|zip|mp4)$', path, re.I) or path == '/':
            continue
        text = strip_html(m.group(2) or '')
        in_path = TEAM_PAGE_HINT.search(re.sub(r'[-_/]', ' ', path)) is not None
        in_text = TEAM_PAGE_HINT.search(text) is not None
        if not in_path and not in_text:
            continue
        # Leadership/team pages beat a generic "About"; careers pages rank last.
        score = (2 if in_path else 0) + (1 if in_text else 0)
        if re.search(r'leadership|team|people|founder|executive|management|board', f'{path} {text}', re.I):
            score += 3
        if re.search('careers', path, re.I):
            score -= 2
        origin = f"{url.scheme}://{host}{f':{url.port}' if url.port else ''}"
        key = f"{origin}{re.sub(r'/$', '', path)}"
        scored[key] = max(scored.get(key, -(10**9)), score)
    ranked = sorted(scored.items(), key=lambda kv: kv[1], reverse=True)
    return [u for u, _ in ranked[:limit]]


def extract_snippets(text: str, url: str, radius: int = SNIPPET_RADIUS) -> list[Snippet]:
    """Windows of text around each FSAE match, overlapping windows merged, capped. Wide enough to
    take in the name at the top of a typical bio paragraph."""
    spans: list[list[int]] = []
    for m in FSAE_PATTERN.finditer(text):
        start = max(0, m.start() - radius)
        end = min(len(text), m.end() + radius)
        if spans and start <= spans[-1][1]:
            spans[-1][1] = end
        else:
            spans.append([start, end])
    return [Snippet(url, text[s:e].strip()) for s, e in spans]


def _normalize(s: str) -> str:
    s = re.sub(r'[‘’]', "'", s)
    s = re.sub(r'[“”]', '"', s)
    return re.sub(r'\s+', ' ', s).strip().lower()


def verify_labels(snippets: list[Snippet], labels: list[dict[str, Any]]) -> tuple[list[FsaePerson], list[FsaeCompanyMention]]:
    """Keep only labels the page text backs up: the quote must appear verbatim in its snippet and
    must itself contain an FSAE term; a PERSON label also needs the name to appear in the snippet.
    Anything else is dropped rather than trusted. Returns (people, company mentions)."""
    people: list[FsaePerson] = []
    company_mentions: list[FsaeCompanyMention] = []
    for l in labels:
        if not isinstance(l, dict):
            continue
        raw_idx = l.get('snippet')
        try:
            idx = int(raw_idx) if not isinstance(raw_idx, bool) and float(raw_idx).is_integer() else -1  # type: ignore[arg-type]
        except (TypeError, ValueError):
            idx = -1
        snip = snippets[idx] if 0 <= idx < len(snippets) else None
        quote = l['quote'].strip() if isinstance(l.get('quote'), str) else ''
        if not snip or not quote:
            continue
        hay = _normalize(snip.text)
        if _normalize(quote) not in hay:
            continue
        if not FSAE_PATTERN.search(quote):
            continue

        name = l['person'].strip() if isinstance(l.get('person'), str) else ''
        name_ok = name != '' and _normalize(name) in hay
        if l.get('kind') == 'person':
            if not name_ok or any(_normalize(p.name) == _normalize(name) for p in people):
                continue
            people.append(FsaePerson(name, quote[:300], snip.url))
        elif l.get('kind') == 'company':
            dup = any(_normalize(c.quote) == _normalize(quote) for c in company_mentions)
            if not dup and len(company_mentions) < 2:
                company_mentions.append(FsaeCompanyMention(quote[:300], snip.url, name if name_ok else None))
    return people, company_mentions


LABEL_PROMPT = """You read short excerpts from a company's website. Each excerpt mentions Formula SAE (FSAE) or Formula Student, the university race-car design competitions.

For EACH excerpt, return one label:
- "person": a specific, named person who WORKS AT THIS COMPANY was themselves a member, lead, driver, or faculty advisor of a Formula SAE / Formula Student team (e.g. a staff bio: "While at university she was technical lead on her Formula SAE team").
- "company": the company, or someone at it acting for it, sponsors, donates to, supplies, works with, or recruits from Formula SAE / Formula Student teams, or a job listing asks for FSAE experience. An employee who RUNS a sponsorship/donation program is "company" (put their name in "person"), not "person" — running a program is not having been on a team.
- "none": anything else (news links, event listings, unrelated mentions).

A testimonial or quote from a student team or from someone at ANOTHER organization (a customer, a partner) is never "person"; label it "company" if it shows the company working with FSAE teams, else "none".

Return ONLY JSON: {"labels":[{"snippet":<excerpt number>,"kind":"person"|"company"|"none","person":"<full name exactly as written, or empty>","quote":"<the shortest verbatim span, max 200 chars, that contains the FSAE / Formula Student mention and shows the label>"}]}
Copy "quote" and "person" character-for-character from the excerpt. Never guess a name that isn't written in the excerpt."""


def _label_snippets(company: str, snippets: list[Snippet]) -> list[dict[str, Any]]:
    body = '\n\n'.join(f'[{i}] {s.text}' for i, s in enumerate(snippets))
    parsed = chat_json(LABEL_PROMPT, f'Company: {company}\n\nExcerpts:\n{body}')
    labels = parsed.get('labels')
    return labels if isinstance(labels, list) else []


def scan_fsae_ties(company: str, hostname: str) -> FsaeScan:
    """Scan `hostname`'s homepage + team pages for FSAE history. Raises only if the Groq labelling
    call fails (so a batch run can retry that company); fetch failures just mean fewer pages scanned."""
    base = f'https://{hostname}'
    home_html = fetch_html(base)
    # Dead DNS / bot wall on the homepage almost always means the same on every subpage.
    if not home_html:
        return FsaeScan(ties=False)
    linked = find_team_page_links(home_html, base)
    candidates = linked or [f'{base}{p}' for p in FALLBACK_PATHS]

    pages: list[tuple[str, str]] = [(base, strip_html(home_html))]
    for url in candidates:
        html = fetch_html(url)
        if html:
            pages.append((url, strip_html(html)))

    snippets = [s for url, text in pages for s in extract_snippets(text, url)][:MAX_SNIPPETS]
    pages_scanned = [url for url, _ in pages]
    if not snippets:
        return FsaeScan(ties=False, pages_scanned=pages_scanned)

    people, company_mentions = verify_labels(snippets, _label_snippets(company, snippets))
    return FsaeScan(ties=bool(people), people=people, company_mentions=company_mentions, pages_scanned=pages_scanned)


def format_fsae_evidence(scan: FsaeScan) -> str:
    """One Notion rich_text value (≤2000 chars) summarizing the scan for humans."""
    lines = [f'🏁 {p.name}: "{p.quote}" ({p.url})' for p in scan.people]
    for c in scan.company_mentions:
        lines.append(f"Company{f' (champion: {c.champion})' if c.champion else ''}: \"{c.quote}\" ({c.url})")
    if not lines:
        lines.append(f'No FSAE mentions on {len(scan.pages_scanned)} page(s) scanned.')
    return '\n'.join(lines)[:1990]

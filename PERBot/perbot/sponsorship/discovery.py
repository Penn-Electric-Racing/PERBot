"""Sponsor discovery: `/sponsor find` (match a free-text team need against the UNCLAIMED Bank) and
`/sponsor scout` (suggest NEW companies not yet in the Bank).

Guardrails, same as enrichment:
- The LLM never outputs contact data. Scout suggests only company + domain + why; contacts still
  come exclusively from Hunter when someone runs `/sponsor add`.
- Scout WRITES NOTHING to Notion and spends no Hunter credits — it's a read-only shortlist. A human
  picks which candidates become Bank rows.
- Hallucination filter: every scouted domain is grounded by fetching its homepage (deterministic,
  homepage.py) and a second LLM pass verifies the page actually matches the claim. A candidate whose
  homepage contradicts the claim is dropped; an unreachable homepage is surfaced as unverified, never
  silently trusted.
"""
from __future__ import annotations

import dataclasses
import json
import math
import re
import socket
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Literal

from ..config import config
from ..utils.logger import logger
from .domain import extract_hostname
from .groq_client import get_sponsor_groq_client
from .homepage import fetch_company_text
from .models import BankLeadRow


def _parse_json(content: str | None) -> dict[str, Any]:
    try:
        parsed = json.loads(content or '{}')
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


# The team's Groq org is on the FREE tier: 8,000 tokens/minute for gpt-oss-120b. Every prompt here
# is sized to stay well under that (that's why /sponsor find is two small passes, not one big
# roster call), and a 413/429 on the minute window (e.g. two teammates running commands at once) is
# waited out and retried.
RATE_LIMIT_RETRIES = 2
DEFAULT_WAIT_S = 20


def _suggested_wait_s(err: Exception) -> float | None:
    """Groq's error message says "Please try again in 7.66s" — honor it, capped at 60s."""
    m = re.search(r'try again in ([\d.]+)\s*s', str(err), re.I)
    return min(60.0, math.ceil(float(m.group(1)) * 1000 + 1000) / 1000) if m else None


def chat_json(system: str, user: str) -> dict[str, Any]:
    """One forced-JSON Groq chat call, retrying rate limits on the free-tier TPM window."""
    groq = get_sponsor_groq_client()
    attempt = 0
    while True:
        try:
            response = groq.chat.completions.create(
                model=config.groq.model,
                temperature=0,
                reasoning_effort='low',
                response_format={'type': 'json_object'},
                messages=[{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
            )
            return _parse_json(response.choices[0].message.content if response.choices else None)
        except Exception as err:
            status = getattr(err, 'status_code', None)
            if status in (429, 413) and attempt < RATE_LIMIT_RETRIES:
                wait = _suggested_wait_s(err) or DEFAULT_WAIT_S
                logger.warn(f'Groq rate-limited ({status}); retrying in {round(wait)}s')
                time.sleep(wait)
                attempt += 1
                continue
            raise


def _clean_text(value: Any, max_len: int) -> str:
    return value.strip()[:max_len] if isinstance(value, str) else ''


# --- /sponsor find: match a need against the unclaimed Bank ---------------------


@dataclass
class ProspectMatch:
    row: BankLeadRow
    why: str


FIND_LIMIT = 10
SHORTLIST_LIMIT = 25
# Fit reasons are ≤200 chars; trim in the ranking pass so the shortlist stays cheap.
FIND_REASON_CHARS = 140
# Free-tier TPM headroom: if the name-only roster would still be huge, drop categories.
SHORTLIST_BUDGET_CHARS = 22_000

SHORTLIST_SYSTEM_PROMPT = f"""You shortlist sponsorship prospects for Penn Electric Racing (PER, a Formula SAE Electric student team). Given a stated team need and a numbered roster of company names (with rough engineering categories), pick every company that could PLAUSIBLY supply or fund that need — favor recall over precision; a later pass filters properly.

Return ONLY a JSON object: {{"shortlist": [{{"n": <roster number>}}, ...]}} with at most {SHORTLIST_LIMIT} entries. An empty array is a valid answer. Output nothing else.
(Each entry MUST be an object with the single key "n" — never a bare number: gpt-oss at low reasoning has emitted bare-number arrays without commas, which parse as one giant number.)"""

RANK_SYSTEM_PROMPT = f"""You match a stated need of Penn Electric Racing (PER, a Formula SAE Electric student team) against a numbered roster of already-researched sponsorship prospects.

Return ONLY a JSON object: {{"matches": [{{"n": <roster number>, "why": "<one clause, max 120 chars, why this company fits the need>"}}]}}.
- Best match first, at most {FIND_LIMIT} entries.
- Include ONLY companies that could genuinely supply or fund the stated need — no padding. An empty "matches" array is a valid answer.
- "why" must be grounded in the roster line (their product/category/fit reason), not invented capabilities.
- Do NOT output contact names, emails, or anything besides the JSON object."""


def _as_int(v: Any) -> int | None:
    """`Number(v)` when it is an integer, else None."""
    if isinstance(v, bool):
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return int(n) if math.isfinite(n) and n.is_integer() else None


def read_roster_numbers(value: Any, max_n: int, roster_size: int) -> list[int]:
    """A validated, deduped list of roster numbers out of an LLM JSON array."""
    if not isinstance(value, list):
        return []
    seen: dict[int, None] = {}
    for v in value:
        n = _as_int(v.get('n') if isinstance(v, dict) else v)
        if n is not None and 1 <= n <= roster_size:
            seen[n] = None
        if len(seen) >= max_n:
            break
    return list(seen)


def find_matching_prospects(need: str, rows: list[BankLeadRow]) -> list[ProspectMatch]:
    """Match a free-text need against the unclaimed Bank, in TWO small Groq passes to fit the free
    tier's 8k TPM: (1) a cheap name+category shortlist over all rows (recall), then (2) rank the
    shortlist with full fit reasons (precision), best-first with a one-line why each."""
    if not rows:
        return []

    # Pass 1 — shortlist. Name+category lines; drop categories if the Bank has grown past the token
    # budget (name-only still shortlists decently).
    roster = '\n'.join(f"{i + 1}. {r.company} [{'/'.join(r.categories)}]" for i, r in enumerate(rows))
    if len(roster) > SHORTLIST_BUDGET_CHARS:
        logger.warn(f'Shortlist roster over budget ({len(roster)} chars) — falling back to name-only lines.')
        roster = '\n'.join(f'{i + 1}. {r.company}' for i, r in enumerate(rows))
    shortlist_raw = chat_json(SHORTLIST_SYSTEM_PROMPT, f'Team need: {need}\n\nRoster:\n{roster}')
    shortlist = read_roster_numbers(shortlist_raw.get('shortlist'), SHORTLIST_LIMIT, len(rows))
    if not shortlist:
        return []

    # Pass 2 — rank the shortlist with fit reasons (renumbered 1..k).
    picked = [rows[n - 1] for n in shortlist]
    detail = '\n'.join(
        f"{i + 1}. {r.company} — categories: {'/'.join(r.categories)}"
        + (f'; fit: {r.fit_reason[:FIND_REASON_CHARS]}' if r.fit_reason[:FIND_REASON_CHARS] else '')
        for i, r in enumerate(picked)
    )
    ranked_raw = chat_json(RANK_SYSTEM_PROMPT, f'Team need: {need}\n\nProspect roster:\n{detail}')

    items = ranked_raw.get('matches') if isinstance(ranked_raw.get('matches'), list) else []
    seen: set[int] = set()
    matches: list[ProspectMatch] = []
    for item in items:
        n = _as_int(item.get('n') if isinstance(item, dict) else None)
        if n is None or n < 1 or n > len(picked) or n in seen:
            continue
        seen.add(n)
        matches.append(ProspectMatch(picked[n - 1], _clean_text(item.get('why'), 140) or 'possible fit'))
        if len(matches) >= FIND_LIMIT:
            break
    return matches


# --- /sponsor scout: suggest new companies, then verify them --------------------

ScoutVerdict = Literal['confirmed', 'unverified', 'rejected']


@dataclass
class ScoutCandidate:
    company: str
    # Bare lowercase hostname (e.g. "edgertongear.com").
    hostname: str
    # The generator's one-line pitch for why they'd fit the need.
    why: str
    verdict: ScoutVerdict = 'unverified'
    # The verifier's note (what the homepage showed, or why it was rejected).
    note: str = ''


@dataclass
class ScoutResult:
    candidates: list[ScoutCandidate]
    # Rejected count, so the surface can say what was dropped instead of hiding it.
    rejected_count: int


SCOUT_ASK_LIMIT = 12
FETCH_CONCURRENCY = 5
# Snippet + skip-list sizes keep both scout calls a few k tokens each (free-tier TPM).
SNIPPET_CHARS = 700
KNOWN_DOMAINS_IN_PROMPT = 250

SCOUT_SYSTEM_PROMPT = f"""You suggest companies Penn Electric Racing (PER) could approach for sponsorship. PER is a Formula SAE Electric student team at the University of Pennsylvania in Philadelphia that designs, builds, and races an electric race car — interpret "local" in a need as the greater Philadelphia region.

Return ONLY a JSON object: {{"candidates": [{{"company": "<name>", "domain": "<their primary web domain>", "why": "<one clause, max 120 chars, why they fit the need>"}}]}}.
- Up to {SCOUT_ASK_LIMIT} candidates, best fit first.
- ONLY real companies you are confident actually exist, with their real primary domain. Never guess a domain from the company name; omit a company you can't pin a domain on. Every suggestion will be checked against the live website, so a made-up entry is worse than a short list.
- Prefer established, findable companies whose domain you are CERTAIN of over obscure job shops you only half-remember — e.g. for overseas manufacturing needs, the well-known export-friendly platforms and manufacturers, not tiny local firms.
- Favor companies plausibly open to sponsoring/discounting for a student engineering team (suppliers, job shops, tool makers, firms that recruit engineers) over consumer brands.
- Skip every company in the provided already-known list.
- Do NOT output contact names, emails, phone numbers, or people."""

VERIFY_SYSTEM_PROMPT = """You verify scouted sponsorship candidates for Penn Electric Racing. For each numbered candidate you get the claimed company, domain, the claimed fit, and text fetched from that domain's live homepage (or "(homepage unreachable)").

Return ONLY a JSON object: {"verdicts": [{"n": <number>, "verdict": "confirmed" | "unverified" | "rejected", "note": "<max 100 chars>"}]}.
- "confirmed": the homepage text is consistent with the claimed company AND with the stated need.
- "rejected": the homepage clearly belongs to a different business, is a parked/for-sale domain, or is plainly irrelevant to the need.
- "unverified": the homepage was unreachable — you cannot check either way.
- Judge ONLY from the provided homepage text; do not use outside knowledge to rescue a candidate."""


def _generate_candidates(need: str, known_hostnames: set[str]) -> list[ScoutCandidate]:
    """Stage 1: ask the LLM for candidate companies, keeping only parseable, unknown domains."""
    # The prompt's skip-list is best-effort (capped for the token budget); the REAL dedupe is the
    # code check against the full set below, so a cap costs nothing but a wasted suggestion slot.
    known = ', '.join(sorted(known_hostnames)[:KNOWN_DOMAINS_IN_PROMPT]) or '(none yet)'
    raw = chat_json(SCOUT_SYSTEM_PROMPT, f'Team need: {need}\n\nAlready-known domains (skip these):\n{known}')
    items = raw.get('candidates') if isinstance(raw.get('candidates'), list) else []
    seen: set[str] = set()
    out: list[ScoutCandidate] = []
    for item in items:
        item = item if isinstance(item, dict) else {}
        company = _clean_text(item.get('company'), 100)
        hostname = extract_hostname(_clean_text(item.get('domain'), 200))
        if not company or not hostname or hostname in seen or hostname in known_hostnames:
            continue
        seen.add(hostname)
        out.append(ScoutCandidate(company, hostname, _clean_text(item.get('why'), 140) or 'suggested fit'))
        if len(out) >= SCOUT_ASK_LIMIT:
            break
    return out


def _verify_candidates(need: str, candidates: list[ScoutCandidate], snippets: list[str]) -> dict[int, tuple[ScoutVerdict, str]]:
    """Stage 3: one Groq call judging every candidate against its fetched homepage text."""
    listing = '\n'.join(
        f"{i + 1}. {c.company} ({c.hostname}) — claimed fit: {c.why}\n   "
        + (f'homepage: {snippets[i]}' if snippets[i] else '(homepage unreachable)')
        for i, c in enumerate(candidates)
    )
    raw = chat_json(VERIFY_SYSTEM_PROMPT, f'Team need: {need}\n\nCandidates:\n{listing}')
    items = raw.get('verdicts') if isinstance(raw.get('verdicts'), list) else []
    verdicts: dict[int, tuple[ScoutVerdict, str]] = {}
    for item in items:
        item = item if isinstance(item, dict) else {}
        n = _as_int(item.get('n'))
        v = item.get('verdict')
        if n is None or n < 1 or n > len(candidates) or v not in ('confirmed', 'unverified', 'rejected'):
            continue
        verdicts[n - 1] = (v, _clean_text(item.get('note'), 120))
    return verdicts


def _resolves(hostname: str) -> bool:
    try:
        socket.getaddrinfo(hostname, None)
        return True
    except OSError:
        return False


def scout_companies(need: str, known_hostnames: set[str]) -> ScoutResult:
    """Full scout pipeline: generate candidates → fetch each homepage (the hallucination filter) →
    verify page-vs-claim → return confirmed first, then unverified; rejected candidates are dropped
    but counted. Read-only: no Notion writes, no Hunter credits."""
    generated = _generate_candidates(need, known_hostnames)
    if not generated:
        return ScoutResult([], 0)

    # An empty homepage can mean bot-blocked (real company) OR nonexistent (invented company) — a
    # failed DNS lookup distinguishes them: no A record ⇒ hallucinated.
    def ground(c: ScoutCandidate) -> tuple[str, bool]:
        text = fetch_company_text(c.hostname)
        if text:
            return text[:SNIPPET_CHARS], True
        return '', _resolves(c.hostname)

    with ThreadPoolExecutor(max_workers=FETCH_CONCURRENCY) as pool:
        grounded = list(pool.map(ground, generated))
    snippets = [g[0] for g in grounded]

    verdicts = _verify_candidates(need, generated, snippets)

    candidates: list[ScoutCandidate] = []
    for i, c in enumerate(generated):
        if not grounded[i][1]:
            candidates.append(dataclasses.replace(c, verdict='rejected', note='domain does not resolve — likely invented'))
            continue
        # No verdict returned for this row → the safe reading of "couldn't check".
        verdict, note = verdicts.get(i, ('unverified', ''))
        # A reachable homepage the verifier called "unverified" stays unverified; an unreachable one
        # can never be "confirmed" regardless of what the LLM said.
        if not snippets[i] and verdict == 'confirmed':
            verdict = 'unverified'
        candidates.append(dataclasses.replace(c, verdict=verdict, note=note))

    rejected_count = sum(1 for c in candidates if c.verdict == 'rejected')
    order = {'confirmed': 0, 'unverified': 1, 'rejected': 2}
    kept = sorted((c for c in candidates if c.verdict != 'rejected'), key=lambda c: order[c.verdict])
    logger.info(f'Scout "{need}": {len(generated)} generated → {len(kept)} kept ({rejected_count} rejected by homepage check).')
    return ScoutResult(kept, rejected_count)

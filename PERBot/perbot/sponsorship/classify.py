"""LLM classification of a company's sponsorship fit. Structured assertions only: Groq is forced to
return a fixed JSON object, which we then validate/clamp against the closed Notion vocabularies. We
never parse prose, and the LLM is explicitly told NOT to produce contact data (that comes only from
Hunter — see guardrails).
"""
from __future__ import annotations

import json
import math
from typing import Any

from .groq_client import groq_json
from .models import CATEGORIES, CHANNELS, SPONSOR_TYPES, Category, CompanyClassification


def _clamp_enum(value: Any, allowed: tuple[str, ...], fallback: str) -> str:
    return value if isinstance(value, str) and value in allowed else fallback


def _clamp_categories(value: Any) -> list[Category]:
    if not isinstance(value, list):
        return ['General']
    # De-dupe, and never write an empty multi-select — default to General.
    unique = list(dict.fromkeys(v for v in value if isinstance(v, str) and v in CATEGORIES))
    return unique or ['General']


def _clean_text(value: Any, max_len: int) -> str:
    return value.strip()[:max_len] if isinstance(value, str) else ''


def _clamp_score(value: Any) -> int:
    """Coerce an LLM score to an integer in [0, 3]; anything unparseable → 0."""
    try:
        n = float(value) if not isinstance(value, bool) else float('nan')
    except (TypeError, ValueError):
        return 0
    if not math.isfinite(n):
        return 0
    return min(3, max(0, math.floor(n + 0.5)))


SYSTEM_PROMPT = f"""You classify whether a company is a good sponsorship prospect for Penn Electric Racing (PER), a Formula SAE Electric student team that designs, builds, and races an electric race car.

Return ONLY a JSON object with exactly these fields:
- "fit_reason": one sentence (max 200 chars) — why this company would plausibly say yes to sponsoring PER.
- "suggested_angle": one sentence (max 200 chars) — the specific outreach hook (a product they make, a recruiting interest, a values/brand tie). NOT a drafted email.
- "category": a JSON array (one or more) of {json.dumps(list(CATEGORIES))} — the engineering areas this company relates to. Use ["General"] if unclear.
- "type": one of {json.dumps(list(SPONSOR_TYPES))} — "In-Kind" if they'd most naturally give product/materials/services, "Cash" otherwise.
- "channel": one of {json.dumps(list(CHANNELS))} — how PER would reach them. Use "Category/TAM" for a cold company that fits the market, "Vendor" if they sell parts/tools a team like PER buys, "Other" if unsure.
- "market_fit": integer 0–3 — could they plausibly be a market player for FSAE/EV racing (recruiting pipeline, relevant product, brand tie)? 0 = no connection, 1 = weak/tangential, 2 = clearly adjacent, 3 = directly in the motorsport/EV/battery/automotive space.
- "value_band": integer 0–3 — expected sponsorship value ceiling. 0 = unlikely to give anything meaningful, 1 = small, 2 = mid, 3 = large cash or high-value in-kind.
- "category_need": integer 0–3 — how critically a PER subteam needs what this company supplies. 0 = not needed, 1 = nice-to-have, 2 = useful, 3 = critical/expensive need (e.g. cells, PCBs, CNC, carbon).

Do NOT invent contact names, emails, phone numbers, or people — output none of those.
Do NOT output "contact_strength" or "sponsors_other_teams" — those are human judgments, not yours.
Base your answer only on the provided company text. Be conservative; when unsure prefer "General"/"Other" and the LOWER score."""


def classify_company_fit(company: str, domain: str, company_text: str, known_ask: str | None = None) -> CompanyClassification:
    # When the caller already knows the ask (directed add), steer tier/type/category to reflect it.
    # The ask itself is written verbatim as the angle by the caller, not here.
    ask_hint = (
        f'\n\nThe team already knows its specific ask for this company: "{known_ask}". Make "type", "category", '
        '"value_band", and "category_need" consistent with pursuing that ask (e.g. a discount/free product ask → '
        '"In-Kind"; a large ask → higher "value_band").'
        if known_ask
        else ''
    )
    content = groq_json(SYSTEM_PROMPT, f'Company: {company}\nDomain: {domain}\n\nCompany website text:\n{company_text}{ask_hint}')
    try:
        raw = json.loads(content)
    except ValueError:
        raw = {}
    if not isinstance(raw, dict):
        raw = {}

    return CompanyClassification(
        fit_reason=_clean_text(raw.get('fit_reason'), 200) or f'Potential fit for PER ({company}).',
        suggested_angle=_clean_text(raw.get('suggested_angle'), 200),
        categories=_clamp_categories(raw.get('category')),
        type=_clamp_enum(raw.get('type'), SPONSOR_TYPES, 'Cash'),  # type: ignore[arg-type]
        channel=_clamp_enum(raw.get('channel'), CHANNELS, 'Other'),
        market_fit=_clamp_score(raw.get('market_fit')),
        value_band=_clamp_score(raw.get('value_band')),
        category_need=_clamp_score(raw.get('category_need')),
    )

"""The sponsorship priority model. This is a mirror of the Notion formula properties on the
Prospect Bank (`Fit score`, `Impact score`, `Priority`, `Quadrant`, and the derived `Tier`) — Notion
owns the numbers people see in the board view; this owns the numbers the Slack `/sponsor rank`
command computes.

KEEP IN SYNC with the Notion formulas. If you change a weight or threshold here, change the
matching formula in Notion (and vice-versa), or the board view and the Slack ranking will silently
disagree.

Each sub-score is 0–3. Two axes:
  Fit    = Contact strength + Market fit + Sponsors other teams   (0–9)
  Impact = Value band + Category need                             (0–6)
  Priority = Fit × Impact                                         (0–54)
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass
class SponsorScores:
    # 0–3, human: cold/none → warm path → direct line → know a decision-maker.
    contact_strength: float | None = None
    # 0–3, AI: plausible market player for FSAE/EV racing (recruiting, product, brand).
    market_fit: float | None = None
    # 0–3, human research: 0 none · 1 backs a direct rival (conflict) · 2 backs orgs generally · 3 backs FSAE broadly.
    sponsors_other_teams: float | None = None
    # 0–3, AI: expected sponsorship value band (0 unlikely → 3 large cash/in-kind).
    value_band: float | None = None
    # 0–3, AI: how critically a subteam needs what they supply.
    category_need: float | None = None


# Thresholds — MUST match the Notion `Quadrant` and `Tier` formulas.
HIGH_FIT = 5  # Fit axis is 0–9; ≥5 is "strong fit"
HIGH_IMPACT = 3  # Impact axis is 0–6; ≥3 is "high impact"
TIER1_PRIORITY = 20
TIER2_PRIORITY = 9


def _num(value: float | None) -> float:
    """Treat an unscored (None) sub-score as 0, matching Notion's `if(empty(...),0,...)`."""
    return value if isinstance(value, (int, float)) else 0


def fit_score(s: SponsorScores) -> float:
    return _num(s.contact_strength) + _num(s.market_fit) + _num(s.sponsors_other_teams)


def impact_score(s: SponsorScores) -> float:
    return _num(s.value_band) + _num(s.category_need)


def priority_score(s: SponsorScores) -> float:
    return fit_score(s) * impact_score(s)


def quadrant(s: SponsorScores) -> str:
    """The 2×2 quadrant label (with the same emoji prefixes as the Notion formula)."""
    fit = fit_score(s)
    impact = impact_score(s)
    if fit >= HIGH_FIT and impact >= HIGH_IMPACT:
        return '🟢 Go after now'
    if impact >= HIGH_IMPACT:
        return '🟡 Worth warming'
    if fit >= HIGH_FIT:
        return '🔵 Quick win'
    return '⚪ Backlog'


def tier(s: SponsorScores) -> str:
    """The derived tier bucket (Tier 1/2/3) from Priority."""
    p = priority_score(s)
    if p >= TIER1_PRIORITY:
        return 'Tier 1'
    if p >= TIER2_PRIORITY:
        return 'Tier 2'
    return 'Tier 3'


class _Rankable(Protocol):
    fsae_ties: bool
    scores: SponsorScores


def rank_key(row: _Rankable) -> tuple[int, float, float]:
    """`/sponsor rank` order (sort ascending on this key): rows with FSAE ties first (someone there
    raced FSAE — the warmest cold lead), then Priority, then Fit. Flagging is a tier, not a score
    bump, so the Priority formula in Notion stays the same."""
    return (-int(row.fsae_ties), -priority_score(row.scores), -fit_score(row.scores))

/**
 * The sponsorship priority model, in TypeScript. This is a mirror of the Notion
 * formula properties on the Prospect Bank (`Fit score`, `Impact score`, `Priority`,
 * `Quadrant`, and the derived `Tier`) — Notion owns the numbers people see in the
 * board view; this owns the numbers the Slack `/sponsor rank` command computes.
 *
 * KEEP IN SYNC with the Notion formulas. If you change a weight or threshold here,
 * change the matching formula via the Notion MCP (and vice-versa), or the board view
 * and the Slack ranking will silently disagree.
 *
 * Each sub-score is 0–3. Two axes:
 *   Fit    = Contact strength + Market fit + Sponsors other teams   (0–9)
 *   Impact = Value band + Category need                             (0–6)
 *   Priority = Fit × Impact                                         (0–54)
 */

export interface SponsorScores {
  /** 0–3, human: cold/none → warm path → direct line → know a decision-maker. */
  contactStrength: number | null;
  /** 0–3, AI: plausible market player for FSAE/EV racing (recruiting, product, brand). */
  marketFit: number | null;
  /** 0–3, human research: 0 none · 1 backs a direct rival (conflict) · 2 backs orgs generally · 3 backs FSAE broadly. */
  sponsorsOtherTeams: number | null;
  /** 0–3, AI: expected sponsorship value band (0 unlikely → 3 large cash/in-kind). */
  valueBand: number | null;
  /** 0–3, AI: how critically a subteam needs what they supply. */
  categoryNeed: number | null;
}

/** Thresholds — MUST match the Notion `Quadrant` and `Tier` formulas. */
const HIGH_FIT = 5; // Fit axis is 0–9; ≥5 is "strong fit"
const HIGH_IMPACT = 3; // Impact axis is 0–6; ≥3 is "high impact"
const TIER1_PRIORITY = 20;
const TIER2_PRIORITY = 9;

/** Treat an unscored (null) sub-score as 0, matching Notion's `if(empty(...),0,...)`. */
function num(value: number | null): number {
  return typeof value === 'number' ? value : 0;
}

export function fitScore(s: SponsorScores): number {
  return num(s.contactStrength) + num(s.marketFit) + num(s.sponsorsOtherTeams);
}

export function impactScore(s: SponsorScores): number {
  return num(s.valueBand) + num(s.categoryNeed);
}

export function priorityScore(s: SponsorScores): number {
  return fitScore(s) * impactScore(s);
}

/** The 2×2 quadrant label (with the same emoji prefixes as the Notion formula). */
export function quadrant(s: SponsorScores): string {
  const fit = fitScore(s);
  const impact = impactScore(s);
  if (fit >= HIGH_FIT && impact >= HIGH_IMPACT) return '🟢 Go after now';
  if (impact >= HIGH_IMPACT) return '🟡 Worth warming';
  if (fit >= HIGH_FIT) return '🔵 Quick win';
  return '⚪ Backlog';
}

/** The derived tier bucket (Tier 1/2/3) from Priority. */
export function tier(s: SponsorScores): string {
  const p = priorityScore(s);
  if (p >= TIER1_PRIORITY) return 'Tier 1';
  if (p >= TIER2_PRIORITY) return 'Tier 2';
  return 'Tier 3';
}

import { config } from '../config.js';
import { getSponsorGroqClient } from './groqClient.js';
import {
  CATEGORIES,
  CHANNELS,
  Category,
  Channel,
  CompanyClassification,
  SPONSOR_TYPES,
  SponsorType,
} from './types.js';

/**
 * LLM classification of a company's sponsorship fit. Structured assertions only:
 * Groq is forced to return a fixed JSON object, which we then validate/clamp against
 * the closed Notion vocabularies. We never parse prose, and the LLM is explicitly
 * told NOT to produce contact data (that comes only from Hunter — see guardrails).
 */

function clampEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function clampCategories(value: unknown): Category[] {
  if (!Array.isArray(value)) return ['General'];
  const valid = value.filter(
    (v): v is Category => typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v)
  );
  // De-dupe, and never write an empty multi-select — default to General.
  const unique = [...new Set(valid)];
  return unique.length > 0 ? unique : ['General'];
}

function cleanText(value: unknown, maxLen: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

/** Coerce an LLM score to an integer in [0, 3]; anything unparseable → 0. */
function clampScore(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(3, Math.max(0, Math.round(n)));
}

const SYSTEM_PROMPT = `You classify whether a company is a good sponsorship prospect for Penn Electric Racing (PER), a Formula SAE Electric student team that designs, builds, and races an electric race car.

Return ONLY a JSON object with exactly these fields:
- "fit_reason": one sentence (max 200 chars) — why this company would plausibly say yes to sponsoring PER.
- "suggested_angle": one sentence (max 200 chars) — the specific outreach hook (a product they make, a recruiting interest, a values/brand tie). NOT a drafted email.
- "category": a JSON array (one or more) of ${JSON.stringify(CATEGORIES)} — the engineering areas this company relates to. Use ["General"] if unclear.
- "type": one of ${JSON.stringify(SPONSOR_TYPES)} — "In-Kind" if they'd most naturally give product/materials/services, "Cash" otherwise.
- "channel": one of ${JSON.stringify(CHANNELS)} — how PER would reach them. Use "Category/TAM" for a cold company that fits the market, "Vendor" if they sell parts/tools a team like PER buys, "Other" if unsure.
- "market_fit": integer 0–3 — could they plausibly be a market player for FSAE/EV racing (recruiting pipeline, relevant product, brand tie)? 0 = no connection, 1 = weak/tangential, 2 = clearly adjacent, 3 = directly in the motorsport/EV/battery/automotive space.
- "value_band": integer 0–3 — expected sponsorship value ceiling. 0 = unlikely to give anything meaningful, 1 = small, 2 = mid, 3 = large cash or high-value in-kind.
- "category_need": integer 0–3 — how critically a PER subteam needs what this company supplies. 0 = not needed, 1 = nice-to-have, 2 = useful, 3 = critical/expensive need (e.g. cells, PCBs, CNC, carbon).

Do NOT invent contact names, emails, phone numbers, or people — output none of those.
Do NOT output "contact_strength" or "sponsors_other_teams" — those are human judgments, not yours.
Base your answer only on the provided company text. Be conservative; when unsure prefer "General"/"Other" and the LOWER score.`;

export async function classifyCompanyFit(
  company: string,
  domain: string,
  companyText: string,
  knownAsk?: string
): Promise<CompanyClassification> {
  const groq = getSponsorGroqClient();

  // When the caller already knows the ask (directed add), steer tier/type/category to
  // reflect it. The ask itself is written verbatim as the angle by the caller, not here.
  const askHint = knownAsk
    ? `\n\nThe team already knows its specific ask for this company: "${knownAsk}". Make "type", "category", "value_band", and "category_need" consistent with pursuing that ask (e.g. a discount/free product ask → "In-Kind"; a large ask → higher "value_band").`
    : '';

  const response = await groq.chat.completions.create({
    model: config.groq.model,
    temperature: 0,
    // gpt-oss-120b is a reasoning model; keep reasoning minimal for this bounded task.
    reasoning_effort: 'low',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Company: ${company}\nDomain: ${domain}\n\nCompany website text:\n${companyText}${askHint}`,
      },
    ],
  });

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(response.choices[0]?.message?.content ?? '{}');
  } catch {
    // fall through to defaults
  }

  const type: SponsorType = clampEnum(raw.type, SPONSOR_TYPES, 'Cash');
  const channel: Channel = clampEnum(raw.channel, CHANNELS, 'Other');

  return {
    fitReason: cleanText(raw.fit_reason, 200) || `Potential fit for PER (${company}).`,
    suggestedAngle: cleanText(raw.suggested_angle, 200),
    categories: clampCategories(raw.category),
    type,
    channel,
    marketFit: clampScore(raw.market_fit),
    valueBand: clampScore(raw.value_band),
    categoryNeed: clampScore(raw.category_need),
  };
}

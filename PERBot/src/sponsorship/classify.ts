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
  TIERS,
  Tier,
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

const SYSTEM_PROMPT = `You classify whether a company is a good sponsorship prospect for Penn Electric Racing (PER), a Formula SAE Electric student team that designs, builds, and races an electric race car.

Return ONLY a JSON object with exactly these fields:
- "fit_reason": one sentence (max 200 chars) — why this company would plausibly say yes to sponsoring PER.
- "suggested_angle": one sentence (max 200 chars) — the specific outreach hook (a product they make, a recruiting interest, a values/brand tie). NOT a drafted email.
- "tier": one of ${JSON.stringify(TIERS)}. Tier 1 = strong, well-aligned target; Tier 3 = weak/long-shot.
- "category": a JSON array (one or more) of ${JSON.stringify(CATEGORIES)} — the engineering areas this company relates to. Use ["General"] if unclear.
- "type": one of ${JSON.stringify(SPONSOR_TYPES)} — "In-Kind" if they'd most naturally give product/materials/services, "Cash" otherwise.
- "channel": one of ${JSON.stringify(CHANNELS)} — how PER would reach them. Use "Category/TAM" for a cold company that fits the market, "Vendor" if they sell parts/tools a team like PER buys, "Other" if unsure.

Do NOT invent contact names, emails, phone numbers, or people — output none of those.
Base your answer only on the provided company text. Be conservative; prefer "General"/"Other"/"Tier 3" over guessing.`;

export async function classifyCompanyFit(
  company: string,
  domain: string,
  companyText: string
): Promise<CompanyClassification> {
  const groq = getSponsorGroqClient();

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
        content: `Company: ${company}\nDomain: ${domain}\n\nCompany website text:\n${companyText}`,
      },
    ],
  });

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(response.choices[0]?.message?.content ?? '{}');
  } catch {
    // fall through to defaults
  }

  const tier: Tier = clampEnum(raw.tier, TIERS, 'Tier 3');
  const type: SponsorType = clampEnum(raw.type, SPONSOR_TYPES, 'Cash');
  const channel: Channel = clampEnum(raw.channel, CHANNELS, 'Other');

  return {
    fitReason: cleanText(raw.fit_reason, 200) || `Potential fit for PER (${company}).`,
    suggestedAngle: cleanText(raw.suggested_angle, 200),
    tier,
    categories: clampCategories(raw.category),
    type,
    channel,
  };
}

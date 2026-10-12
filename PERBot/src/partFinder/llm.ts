import OpenAI from 'openai';
import { config } from '../config.js';

/**
 * The LLM that reads listings. Every provider speaks the OpenAI chat API, so this is the
 * OpenAI SDK with a different baseURL (same pattern as sponsorship/groqClient.ts).
 *
 *   gemini      GEMINI_API_KEY   free tier, ~250k tokens/min — the best fit for this job
 *   groq        GROQ_API_KEY     already on the deploy; free tier is ~8k tokens/min on
 *                                gpt-oss-120b, so a 15-page search takes a few minutes
 *   openrouter  OPENROUTER_API_KEY   ":free" models
 *
 * PARTS_LLM_PROVIDER picks one; otherwise the first with a key, in the order above.
 * PARTS_LLM_MODEL / PARTS_LLM_RPM override the model and the requests-per-minute pacing.
 */

export interface JsonLlm {
  /** "provider/model", shown in Slack. */
  label: string;
  /** One chat request whose reply is parsed as a JSON object. */
  json(system: string, user: string): Promise<any>;
}

export class LlmError extends Error {}

interface Provider {
  baseURL: string;
  apiKey: () => string;
  model: () => string;
  rpm: number;
}

export const PROVIDERS: Record<string, Provider> = {
  gemini: {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKey: () => config.parts.geminiApiKey,
    model: () => 'gemini-3.1-flash-lite',
    rpm: 15,
  },
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: () => config.groq.apiKey,
    model: () => config.groq.model,
    rpm: 30,
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: () => config.parts.openrouterApiKey,
    model: () => 'meta-llama/llama-3.3-70b-instruct:free',
    rpm: 20,
  },
};

/** The first JSON object in a reply (tolerates ```json fences and stray prose). */
export function parseJsonReply(text: string): any {
  const m = /\{[\s\S]*\}/.exec(text);
  return JSON.parse(m ? m[0] : text);
}

/** Spaces request starts `60/rpm` seconds apart across all concurrent callers. */
export class Pacer {
  private nextAt = 0;
  constructor(private gapMs: number, private now: () => number = Date.now, private sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {}

  async wait(): Promise<void> {
    const now = this.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.gapMs;
    if (at > now) await this.sleep(at - now);
  }
}

export class OpenAiCompatLlm implements JsonLlm {
  readonly label: string;
  private pacer: Pacer;

  constructor(private client: Pick<OpenAI, 'chat'>, private model: string, provider: string, rpm: number, private attempts = 2) {
    this.label = `${provider}/${model}`;
    this.pacer = new Pacer(60_000 / rpm);
  }

  async json(system: string, user: string): Promise<any> {
    let last = '';
    for (let i = 0; i < this.attempts; i++) {
      await this.pacer.wait();
      // 429 / 5xx retries (honouring Retry-After) happen inside the SDK (maxRetries).
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        // gpt-oss is a reasoning model; low effort is plenty for reading one page.
        ...(this.model.includes('gpt-oss') ? { reasoning_effort: 'low' as const } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });
      const text = response.choices[0]?.message?.content ?? '';
      try {
        return parseJsonReply(text);
      } catch {
        last = 'reply was not JSON';
      }
    }
    throw new LlmError(last || 'no reply');
  }
}

/** The configured LLM, or null when no provider has a key. */
export function createPartsLlm(): JsonLlm | null {
  const name = config.parts.llmProvider || Object.keys(PROVIDERS).find((p) => PROVIDERS[p]!.apiKey());
  if (!name) return null;
  const provider = PROVIDERS[name];
  if (!provider) throw new LlmError(`Unknown PARTS_LLM_PROVIDER "${name}" (use ${Object.keys(PROVIDERS).join(', ')}).`);
  const apiKey = provider.apiKey();
  if (!apiKey) return null;
  const client = new OpenAI({ apiKey, baseURL: provider.baseURL, maxRetries: 4, timeout: 90_000 });
  return new OpenAiCompatLlm(client, config.parts.llmModel || provider.model(), name, config.parts.llmRpm || provider.rpm);
}

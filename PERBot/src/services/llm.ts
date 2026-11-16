import OpenAI from 'openai';
import { config, hasGroq, hasOpenAI } from '../config.js';
import { logger } from '../utils/logger.js';

/** Embedding requests carry up to this many inputs (OpenAI allows 2048; chunks are ≤ ~400 tokens). */
const EMBEDDING_BATCH_SIZE = 100;
const MAX_EMBED_RETRIES = 8;

let openaiClient: OpenAI | null = null;
let groqClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!hasOpenAI()) {
    throw new Error('OPENAI_API_KEY is not configured. Embeddings are required for search to function.');
  }
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: config.openai.apiKey });
  return openaiClient;
}

/** The "Groq client" is the OpenAI SDK pointed at Groq's OpenAI-compatible endpoint. */
function getGroqClient(): OpenAI {
  if (!hasGroq()) throw new Error('GROQ_API_KEY is not configured.');
  if (!groqClient) {
    groqClient = new OpenAI({ apiKey: config.groq.apiKey, baseURL: 'https://api.groq.com/openai/v1' });
  }
  return groqClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeInPlace(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i]! * vec[i]!;
  const mag = Math.sqrt(sum);
  if (mag > 0) for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / mag;
  return vec;
}

async function createEmbeddingWithRetry(openai: OpenAI, texts: string[]) {
  let attempt = 0;
  while (true) {
    try {
      return await openai.embeddings.create({
        model: config.openai.embeddingModel,
        input: texts,
        encoding_format: 'float',
        dimensions: config.openai.embeddingDims,
      });
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      const message = String((err as { message?: string })?.message || '');
      const cause = (err as { cause?: { code?: string } })?.cause;
      const isRetryable =
        status === 429 ||
        (status !== undefined && status >= 500) ||
        message.includes('Rate limit') ||
        cause?.code === 'ECONNRESET' ||
        cause?.code === 'ENOTFOUND' ||
        cause?.code === 'ETIMEDOUT';

      if (!isRetryable || attempt >= MAX_EMBED_RETRIES) throw err;

      const delay = Math.min(90_000, 2_000 * 2 ** attempt);
      logger.warn(`Embedding request failed (${status ?? cause?.code ?? 'network'}). Retry ${attempt + 1}/${MAX_EMBED_RETRIES} in ${delay}ms`);
      await sleep(delay);
      attempt += 1;
    }
  }
}

/** Unit-normalized embeddings, in input order. */
export async function embedTexts(
  texts: string[],
  onBatch?: (done: number, total: number) => void
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const openai = getOpenAIClient();
  const out: Float32Array[] = [];
  const totalBatches = Math.ceil(texts.length / EMBEDDING_BATCH_SIZE);

  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const response = await createEmbeddingWithRetry(openai, batch);
    for (const item of response.data) out.push(normalizeInPlace(Float32Array.from(item.embedding)));
    onBatch?.(Math.floor(i / EMBEDDING_BATCH_SIZE) + 1, totalBatches);
  }
  return out;
}

export async function embedQuery(text: string): Promise<Float32Array> {
  const vectors = await embedTexts([text]);
  if (!vectors[0]) throw new Error('Embedding returned empty result for query.');
  return vectors[0];
}

// ---------------------------------------------------------------------------------------------
// Reranker (Groq)
// ---------------------------------------------------------------------------------------------

export interface RerankCandidate {
  pageId: string;
  title: string;
  pathText: string;
  text: string;
}

/** Parses `[{"i":2},{"i":0}]` (preferred) or a bare `[2,0]` into an index list. */
function parseIndexList(raw: string, n: number): number[] | null {
  const cleaned = raw.replace(/```[a-z]*\n?/g, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: number[] = [];
  for (const item of parsed) {
    const v = typeof item === 'number' ? item : typeof item === 'object' && item ? (item as { i?: unknown }).i : undefined;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < n && !out.includes(v)) out.push(v);
  }
  return out.length ? out : null;
}

/**
 * Orders candidates by relevance. Falls back to the incoming order (already RRF-fused) when
 * Groq is unavailable or returns something unparsable. Candidates carry the full best chunk
 * (capped by the caller) — the old version only showed the model a 280-char excerpt.
 */
export async function rerankResults(query: string, candidates: RerankCandidate[]): Promise<string[]> {
  const fallback = candidates.map((c) => c.pageId);
  if (candidates.length < 2 || !hasGroq()) return fallback;

  const list = candidates
    .map((c, i) => `[${i}] ${c.title}  (${c.pathText})\n${c.text}`)
    .join('\n\n');

  // gpt-oss-120b at low reasoning has emitted bare-number arrays without commas; single-key
  // objects force separators (see CLAUDE.md "Groq quirks").
  const prompt = `You rank documentation pages from Penn Electric Racing's Notion for a teammate's question.
Order ALL candidates from most to least useful for answering the question. Prefer pages that directly
document the thing asked about over meeting notes that merely mention it; prefer current-season
material over older REVs unless the question asks about history.

Question: ${query}

Candidates:
${list}

Reply with ONLY a JSON array of objects like [{"i": 2}, {"i": 0}, ...] covering every index once.`;

  try {
    const response = await getGroqClient().chat.completions.create({
      model: config.groq.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      reasoning_effort: 'low',
      max_tokens: 1024,
    });
    const raw = response.choices[0]?.message?.content ?? '';
    const order = parseIndexList(raw, candidates.length);
    if (!order) {
      logger.warn('Reranker returned an unparsable list; keeping fused order.');
      return fallback;
    }
    const seen = new Set(order);
    const rest = candidates.map((_, i) => i).filter((i) => !seen.has(i));
    return [...order, ...rest].map((i) => candidates[i]!.pageId);
  } catch (err) {
    logger.warn('Reranker failed; keeping fused order.', err);
    return fallback;
  }
}

// ---------------------------------------------------------------------------------------------
// Answer synthesis (OpenAI)
// ---------------------------------------------------------------------------------------------

export interface AnswerSource {
  n: number;
  title: string;
  pathText: string;
  url: string;
  isHistorical: boolean;
  revNumber: number | null;
  text: string;
}

const NO_OPENAI_NOTE =
  'Here are the most relevant PER Notion pages. (Set `OPENAI_API_KEY` for PERBot to write an answer from them.)';

export async function answerFromSources(query: string, sources: AnswerSource[], weak: boolean): Promise<string> {
  if (!hasOpenAI()) return NO_OPENAI_NOTE;
  if (sources.length === 0) return 'I could not find anything relevant in the indexed PER docs.';

  const sourceText = sources
    .map((s) => {
      const tags = [s.revNumber ? `REV${s.revNumber}` : null, s.isHistorical ? 'HISTORICAL (older season)' : null]
        .filter(Boolean)
        .join(', ');
      return `[${s.n}] ${s.title}${tags ? ` — ${tags}` : ''}\nLocation: ${s.pathText}\n${s.text}`;
    })
    .join('\n\n---\n\n');

  const confidence = weak
    ? 'Retrieval confidence is LOW: the sources may not cover this question. If they do not, say so in one sentence and name the closest page instead of guessing.'
    : 'If the sources only partly answer the question, say what is covered and what is not.';

  const prompt = `You are PERBot, the documentation assistant for Penn Electric Racing (Penn's Formula SAE Electric team).
Answer the teammate's question using ONLY the sources below.

Rules:
- Cite sources inline like [1] or [2][3]. Every factual sentence needs a citation.
- ${confidence}
- Say when something comes from a historical (older REV) page.
- Do not invent facts, names, numbers, or part choices.
- If the question is clearly a joke or a dig at a teammate, you may add one short, good-natured line of humor about the question, but never make claims about a real person (events, relationships, grades, looks, rankings) that the sources don't directly state.
- 3–6 sentences in Slack mrkdwn: *bold* for key terms, no headers, no markdown links.

Question: ${query}

Sources:
${sourceText}`;

  const response = await getOpenAIClient().responses.create({
    model: config.openai.answerModel,
    input: prompt,
    reasoning: { effort: 'low' },
  });
  return response.output_text?.trim() || 'I found relevant pages but could not write a summary.';
}

// ---------------------------------------------------------------------------------------------
// Mention routing
// ---------------------------------------------------------------------------------------------

export type MentionIntent = 'docs' | 'thread' | 'chat';

const THREAD_HINT = /\b(summari[sz]e|tl;?dr|recap|catch me up|what did (?:we|they|\w+) (?:say|decide|conclude)|this thread|the thread|above)\b/i;

function heuristicIntent(text: string, inThread: boolean): MentionIntent {
  const t = text.trim();
  if (inThread && THREAD_HINT.test(t)) return 'thread';
  const words = t.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (/\?$/.test(t) || words.length >= 3) return 'docs';
  return 'chat';
}

/**
 * Decides what a `@PERBot …` mention is asking for. Heuristics catch the obvious cases; Groq
 * settles the rest ("let her re-send it" is chatter, "how is the PCM box wired" is docs).
 */
export async function classifyMention(text: string, inThread: boolean): Promise<MentionIntent> {
  const guess = heuristicIntent(text, inThread);
  if (!hasGroq()) return guess;
  if (guess === 'thread') return guess;

  const prompt = `Classify a Slack message addressed to PERBot, a bot that answers questions from Penn Electric Racing's engineering documentation.
Intents:
- "docs": a question or request for information about the team, the car, its subsystems, processes, tools, parts, or history — anything a documentation search could answer.
- "thread": asks PERBot to summarize, recap, or answer from the current conversation thread (only possible when in_thread is true).
- "chat": banter, reactions, jokes, instructions to people, insults, thanks, or anything that is not an information request.

in_thread: ${inThread}
message: ${JSON.stringify(text.slice(0, 500))}

Reply with ONLY JSON: {"intent": "docs" | "thread" | "chat"}`;

  try {
    const response = await getGroqClient().chat.completions.create({
      model: config.groq.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      reasoning_effort: 'low',
      max_tokens: 200,
      response_format: { type: 'json_object' },
    });
    const raw = response.choices[0]?.message?.content ?? '';
    const parsed = JSON.parse(raw) as { intent?: string };
    if (parsed.intent === 'thread' && !inThread) return 'docs';
    if (parsed.intent === 'docs' || parsed.intent === 'thread' || parsed.intent === 'chat') return parsed.intent;
  } catch (err) {
    logger.warn('Mention classifier failed; using heuristic.', err);
  }
  return guess;
}

const CHAT_FALLBACKS = [
  "I'm a docs bot — ask me something about the car or the team and I'll dig through Notion. Try `@PERBot how does the PCM talk to the motor controllers?`",
  "Nothing to look up there. Ask me a docs question (`@PERBot what changed in the REV11 accumulator?`) or `@PERBot summarize this thread` inside a thread.",
];

export function chatFallback(): string {
  return CHAT_FALLBACKS[Math.floor(Math.random() * CHAT_FALLBACKS.length)]!;
}

/**
 * Banter replies for mentions that aren't information requests ("doordash me asads", "why are
 * you ignoring me"). Funny but safe: the team pokes at real people, so the bot jokes about itself,
 * the car and the request — never invents facts, rumors or rankings about a real person.
 */
/** One comedic angle per reply, picked at random so banter doesn't repeat the same bit. */
const CHAT_ANGLES = [
  'the request itself — take it absurdly literally, deadpan',
  'life at FSAE comp: tech inspection, the rules book, waiting in line, things that break the night before',
  'the shop at 2am: zip ties, solder fumes, a CAN bus that works only when nobody is looking',
  'sponsorship: cold emails, follow-ups nobody sends, begging companies for free connectors',
  'yourself as an underappreciated team member who wants a seat on the car or a spot on the roster',
  'Notion: pages titled "Untitled", docs last edited three REVs ago, meeting notes that just say "TBD"',
  'the car: the accumulator, precharge, the shutdown circuit, the IMD tripping for no reason',
  'the budget: purchase requests, shipping costs, someone ordering the wrong part again',
];

export async function chatReply(text: string, askerName?: string): Promise<string> {
  if (!hasOpenAI()) return chatFallback();
  const angle = CHAT_ANGLES[Math.floor(Math.random() * CHAT_ANGLES.length)]!;
  const prompt = `You are PERBot, the Slack bot for Penn Electric Racing (Penn's Formula SAE Electric team). Someone just @-mentioned you with banter, not a real documentation question.

Facts about you, if relevant: you're a TypeScript app on Node.js, you search the team's Notion and Google Drive, run sponsorship tracking (/sponsor), log package arrivals in #packages, and summarize threads. You can't browse the web, order food, send money, or do anything outside Slack.

Reply with ONE short, genuinely funny line (two at most) in the voice of a dry, slightly overworked race-team bot. Suggested angle for this one: ${angle}. Use it only if it fits; otherwise go with whatever is funniest about the message. Avoid stock filler about how many pages you've read or what server you run on. Playful roasting of the request is fine; a nudge toward something you can actually do is optional.

Hard rules:
- Never state or imply facts, rumors, events, relationships, grades, health, money, or crimes about a real person, even as a joke. If the message is about a specific person, joke about the question or about yourself instead.
- Never rank, rate, or compare real people (attractiveness, coolness, who's best, marry/kill, etc.). Decline with humor.
- No sexual content, slurs, or punching down.
- Slack mrkdwn, no headers, under 40 words. Don't start with "Ah" or "Oh".
${askerName ? `\nThe person talking to you is ${askerName}.` : ''}
Message: ${JSON.stringify(text.slice(0, 500))}`;

  try {
    const response = await getOpenAIClient().responses.create({
      model: config.openai.answerModel,
      input: prompt,
      reasoning: { effort: 'low' },
    });
    return response.output_text?.trim() || chatFallback();
  } catch (err) {
    logger.warn('Chat reply failed; using canned reply.', err);
    return chatFallback();
  }
}

export interface ThreadMessage {
  name: string;
  text: string;
}

/** Answers a request about the thread ("summarize this", "what did we decide on X") from its messages. */
export async function summarizeThread(request: string, messages: ThreadMessage[]): Promise<string> {
  if (!hasOpenAI()) return 'I need `OPENAI_API_KEY` configured to summarize threads.';
  const MAX_CHARS = 60_000;
  let transcript = messages.map((m) => `${m.name}: ${m.text}`).join('\n\n');
  if (transcript.length > MAX_CHARS) {
    transcript = `${transcript.slice(0, MAX_CHARS)}\n\n[… thread truncated …]`;
  }
  const prompt = `You are PERBot, a helpful assistant in Penn Electric Racing's Slack. A teammate asked, inside a thread: ${JSON.stringify(request)}.
Answer from the thread transcript only. For a summary: lead with the decisions or conclusions, then the open questions, then who is doing what — as short Slack mrkdwn bullets (use "•" and *bold*, no headers). Attribute positions to people by name. Keep it under ~180 words. Do not invent anything not in the transcript.

Thread transcript:
${transcript}`;

  const response = await getOpenAIClient().responses.create({
    model: config.openai.answerModel,
    input: prompt,
    reasoning: { effort: 'low' },
  });
  return response.output_text?.trim() || 'I could not summarize that thread.';
}

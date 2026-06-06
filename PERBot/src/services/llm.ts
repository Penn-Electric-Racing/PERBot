import OpenAI from 'openai';
import { config, hasGroq, hasOpenAI } from '../config.js';
import type { SearchResult } from '../types.js';

const EMBEDDING_BATCH_SIZE = 5;
const EMBEDDING_BATCH_DELAY_MS = 3000;
const MAX_EMBED_RETRIES = 8;

let openaiClient: OpenAI | null = null;
let groqClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!hasOpenAI()) {
    throw new Error(
      'OPENAI_API_KEY is not configured. Embeddings are required for search to function.'
    );
  }
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return openaiClient;
}

function getGroqClient(): OpenAI {
  if (!hasGroq()) {
    throw new Error('GROQ_API_KEY is not configured. It is required for the reranker.');
  }
  if (!groqClient) {
    groqClient = new OpenAI({
      apiKey: config.groq.apiKey,
      baseURL: 'https://api.groq.com/openai/v1',
    });
  }
  return groqClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createEmbeddingWithRetry(openai: OpenAI, texts: string[]) {
  let attempt = 0;

  while (true) {
    try {
      return await openai.embeddings.create({
        model: config.openai.embeddingModel,
        input: texts,
        encoding_format: 'float',
      });
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      const message = String((err as { message?: string })?.message || '');
      const isRateLimit = status === 429 || message.includes('Rate limit');

      if (!isRateLimit || attempt >= MAX_EMBED_RETRIES) {
        throw err;
      }

      const delay = Math.min(90000, EMBEDDING_BATCH_DELAY_MS * 2 ** attempt);
      console.warn(
        `[PERBot] Embedding rate-limited. Retry ${attempt + 1}/${MAX_EMBED_RETRIES} in ${delay}ms`
      );

      await sleep(delay);
      attempt += 1;
    }
  }
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const openai = getOpenAIClient();
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);

    const response = await createEmbeddingWithRetry(openai, batch);
    allEmbeddings.push(...response.data.map((item) => item.embedding));

    const batchNumber = Math.floor(i / EMBEDDING_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(texts.length / EMBEDDING_BATCH_SIZE);
    console.log(`[PERBot] Embedded batch ${batchNumber} / ${totalBatches}`);

    if (i + EMBEDDING_BATCH_SIZE < texts.length) {
      await sleep(EMBEDDING_BATCH_DELAY_MS);
    }
  }

  return allEmbeddings;
}

export async function embedQuery(text: string): Promise<number[]> {
  const vectors = await embedTexts([text]);
  if (!vectors[0]) throw new Error('Embedding returned empty result for query.');
  return vectors[0];
}

export interface RerankCandidate {
  pageId: string;
  title: string;
  excerpt: string;
}

export async function rerankResults(
  query: string,
  candidates: RerankCandidate[]
): Promise<string[]> {
  if (candidates.length === 0) return [];

  const groq = getGroqClient();

  const candidateList = candidates
    .map((c, i) => `[${i}] Title: ${c.title}\nExcerpt: ${c.excerpt}`)
    .join('\n\n');

  const prompt = `You are a relevance ranker. Given a user query and a list of document candidates, return a JSON array of candidate indices ordered from most to least relevant to the query. Include all indices. Output ONLY a JSON array, e.g. [2, 0, 1].

Query: ${query}

Candidates:
${candidateList}`;

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 256,
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? '';
    const cleaned = raw.replace(/```[a-z]*\n?/g, '').replace(/```/g, '').trim();
    const parsed: unknown = JSON.parse(cleaned);

    if (
      !Array.isArray(parsed) ||
      !parsed.every((x) => typeof x === 'number' && x >= 0 && x < candidates.length)
    ) {
      console.warn('[PERBot] Reranker returned invalid indices, falling back to RRF order.');
      return candidates.map((c) => c.pageId);
    }

    const seen = new Set<number>();
    const reranked: string[] = [];
    for (const idx of parsed as number[]) {
      if (!seen.has(idx)) {
        seen.add(idx);
        reranked.push(candidates[idx]!.pageId);
      }
    }

    for (let i = 0; i < candidates.length; i++) {
      if (!seen.has(i)) reranked.push(candidates[i]!.pageId);
    }

    return reranked;
  } catch (err) {
    console.warn('[PERBot] Reranker failed, falling back to RRF order.', err);
    return candidates.map((c) => c.pageId);
  }
}

export async function summarizeSearchResults(query: string, results: SearchResult[]): Promise<string> {
  if (!hasOpenAI()) {
    return 'I found the most relevant PER Notion pages below. Add an `OPENAI_API_KEY` in your `.env` if you want PERBot to produce a synthesized answer as well.';
  }

  if (results.length === 0) {
    return 'I could not find a strong answer in the indexed PER Notion pages.';
  }

  const openai = getOpenAIClient();
  const sourceText = results
    .map((result, index) => {
      const historical = result.page.isHistorical ? 'YES' : 'NO';
      return [
        `Source ${index + 1}`,
        `Title: ${result.page.title}`,
        `Historical: ${historical}`,
        `Last edited: ${result.page.lastEditedTime}`,
        `URL: ${result.page.url}`,
        `Excerpt: ${result.excerpt}`,
      ].join('\n');
    })
    .join('\n\n');

  const prompt = `You are PERBot, a documentation assistant for Penn Electric Racing.
Answer the user's question using ONLY the provided sources.
Rules:
- Be concise and helpful.
- If the answer is uncertain, say so.
- If any cited evidence is historical, explicitly mention that.
- Do not invent facts.
- Keep the answer to 3-5 sentences.

User question: ${query}

Sources:
${sourceText}`;

  const response = await openai.responses.create({
    model: config.openai.responseModel,
    input: prompt,
  });

  return response.output_text?.trim() || 'I found relevant sources, but I could not synthesize a summary.';
}

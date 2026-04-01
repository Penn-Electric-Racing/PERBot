import OpenAI from 'openai';
import { config, hasOpenAI } from '../config.js';
import type { SearchResult } from '../types.js';

const EMBEDDING_BATCH_SIZE = 10;
const EMBEDDING_BATCH_DELAY_MS = 2000;
const MAX_EMBED_RETRIES = 6;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!hasOpenAI()) {
    throw new Error('OPENAI_API_KEY is not configured.');
  }
  if (!client) {
    client = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return client;
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
    } catch (err: any) {
      const status = err?.status;
      const message = String(err?.message || '');
      const isRateLimit = status === 429 || message.includes('Rate limit');

      if (!isRateLimit || attempt >= MAX_EMBED_RETRIES) {
        throw err;
      }

      const delay = Math.min(60000, EMBEDDING_BATCH_DELAY_MS * 2 ** attempt);
      console.warn(
        `[PERBot] Embedding rate-limited. Retry ${attempt + 1}/${MAX_EMBED_RETRIES} in ${delay}ms`
      );

      await sleep(delay);
      attempt += 1;
    }
  }
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!hasOpenAI() || texts.length === 0) return [];

  const openai = getClient();
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

export async function embedQuery(text: string): Promise<number[] | null> {
  if (!hasOpenAI()) return null;
  const vectors = await embedTexts([text]);
  return vectors[0] ?? null;
}

export async function summarizeSearchResults(query: string, results: SearchResult[]): Promise<string> {
  if (!hasOpenAI()) {
    return 'I found the most relevant PER Notion pages below. Add an `OPENAI_API_KEY` in your `.env` if you want PERBot to produce a synthesized answer as well.';
  }

  if (results.length === 0) {
    return 'I could not find a strong answer in the indexed PER Notion pages.';
  }

  const openai = getClient();
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

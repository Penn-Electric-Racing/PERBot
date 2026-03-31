import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number.`);
  }
  return parsed;
}

function optionalString(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function optionalList(name: string): string[] {
  const value = process.env[name]?.trim();
  if (!value) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export const config = {
  slack: {
    botToken: required('SLACK_BOT_TOKEN'),
    appToken: required('SLACK_APP_TOKEN'),
    botUserId: process.env.SLACK_BOT_USER_ID?.trim() || '',
  },
  notion: {
    token: required('NOTION_TOKEN'),
    apiVersion: optionalString('NOTION_API_VERSION', '2026-03-11'),
    allowedPageIds: optionalList('NOTION_ALLOWED_PAGE_IDS'),
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY?.trim() || '',
    responseModel: optionalString('OPENAI_RESPONSE_MODEL', 'gpt-5'),
    embeddingModel: optionalString('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small'),
  },
  app: {
    currentRev: optionalString('CURRENT_REV', 'REV11'),
    topKResults: optionalNumber('TOP_K_RESULTS', 3),
    indexPath: path.resolve(optionalString('INDEX_PATH', './data/notion-index.json')),
    maxChunkChars: optionalNumber('MAX_CHUNK_CHARS', 1200),
    chunkOverlapChars: optionalNumber('CHUNK_OVERLAP_CHARS', 200),
    maxResultsToSummarize: optionalNumber('MAX_RESULTS_TO_SUMMARIZE', 3),
    indexRateLimitMs: optionalNumber('INDEX_RATE_LIMIT_MS', 375),
  },
};

export function hasOpenAI(): boolean {
  return Boolean(config.openai.apiKey);
}

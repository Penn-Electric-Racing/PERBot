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

/** Require at least one of several env var names (accepts either naming convention). */
function requireAny(names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`Missing required environment variable: one of ${names.join(' / ')}`);
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

function optionalList(name: string, fallback: string[] = []): string[] {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export const config = {
  slack: {
    botToken: required('SLACK_BOT_TOKEN'),
    // Only Socket Mode (the main app) needs the app token; scheduled jobs that import
    // config don't. app.start() will surface a clear error if it's missing at runtime.
    appToken: process.env.SLACK_APP_TOKEN?.trim() || '',
    botUserId: process.env.SLACK_BOT_USER_ID?.trim() || '',
    reindexAllowedUserIds: optionalList('SLACK_REINDEX_ALLOWED_USER_IDS'),
    anonAllowedChannels: optionalList('ANON_ALLOWED_CHANNELS', [
      'mech_questions',
      'ele_questions',
      'operations',
      'sof_questions',
    ]),
  },
  notion: {
    // Accept either name — the main app used NOTION_TOKEN; PER's other jobs use NOTION_API_KEY.
    token: requireAny(['NOTION_TOKEN', 'NOTION_API_KEY']),
    apiVersion: optionalString('NOTION_API_VERSION', '2026-03-11'),
    allowedPageIds: optionalList('NOTION_ALLOWED_PAGE_IDS'),
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY?.trim() || '',
    responseModel: optionalString('OPENAI_RESPONSE_MODEL', 'gpt-5'),
    embeddingModel: optionalString('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small'),
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY?.trim() || '',
    // llama-3.3-70b-versatile is decommissioned by Groq Aug 16 2026 → openai/gpt-oss-120b
    // (a reasoning model; call sites run it at reasoning_effort: 'low' for these bounded tasks).
    model: optionalString('GROQ_MODEL', 'openai/gpt-oss-120b'),
  },
  hunter: {
    // Contact/email enrichment + verification. Free tier = 50 credits/mo.
    apiKey: process.env.HUNTER_API_KEY?.trim() || '',
  },
  sponsorship: {
    // Notion data-source IDs for the Sponsorship CRM (see CLAUDE.md "Notion IDs").
    bankDataSourceId: optionalString('SPONSOR_BANK_DS_ID', 'fd42b16b-2833-42c3-b72d-f6322145ed4e'),
    pipelineDataSourceId: optionalString('SPONSOR_PIPELINE_DS_ID', '64bb332e-543c-4286-9e67-c3bda963cfdd'),
    // Won-deal win posts land here; also the semester goal for the running % line.
    winPostChannel: optionalString('SPONSOR_WIN_CHANNEL', 'operations'),
    semesterGoalUsd: optionalNumber('SPONSOR_SEMESTER_GOAL_USD', 100000),
    // The team's outreach template page ("Sponsorship Email Template" under REV12
    // Operations) — fetched live by /sponsor email so ops can edit it without a deploy.
    emailTemplatePageId: optionalString('SPONSOR_EMAIL_TEMPLATE_PAGE_ID', '393560bc-c039-8097-be19-fdc8876bef9b'),
  },
  github: {
    token: process.env.GITHUB_TOKEN?.trim() || '',
    repo: optionalString('GITHUB_REPO', 'Penn-Electric-Racing/PERBot'),
    indexReleaseTag: optionalString('GITHUB_INDEX_RELEASE_TAG', 'notion-index-latest'),
  },
  app: {
    currentRev: optionalString('CURRENT_REV', 'REV11'),
    topKResults: optionalNumber('TOP_K_RESULTS', 3),
    indexPath: path.resolve(optionalString('INDEX_PATH', './data/notion-index.json')),
    statusPath: path.resolve(optionalString('INDEX_STATUS_PATH', './data/index-status.json')),
    maxChunkChars: optionalNumber('MAX_CHUNK_CHARS', 1200),
    chunkOverlapChars: optionalNumber('CHUNK_OVERLAP_CHARS', 200),
    maxResultsToSummarize: optionalNumber('MAX_RESULTS_TO_SUMMARIZE', 3),
    indexRateLimitMs: optionalNumber('INDEX_RATE_LIMIT_MS', 375),
    indexerHeapMb: optionalNumber('INDEXER_HEAP_MB', 1536),
    autoBootstrapOnMissingIndex: optionalString('AUTO_BOOTSTRAP_ON_MISSING_INDEX', 'true') === 'true',
    saveCheckpointEveryBatches: optionalNumber('SAVE_CHECKPOINT_EVERY_BATCHES', 10),
  },
};

export function hasOpenAI(): boolean {
  return Boolean(config.openai.apiKey);
}

export function hasGroq(): boolean {
  return Boolean(config.groq.apiKey);
}

export function hasHunter(): boolean {
  return Boolean(config.hunter.apiKey);
}

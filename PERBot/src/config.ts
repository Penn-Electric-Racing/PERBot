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
    // ⚙️ PERBot Job Log — per-day run records so late/duplicate cron fires never re-send
    // (see utils/schedule.ts). Empty disables dedup (with a warning).
    jobLogDataSourceId: optionalString('NOTION_JOB_LOG_DS_ID', 'db0c6a0d-e10b-4edf-97fb-6f381d15a465'),
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
    // Weekly quota audit (Saturday 10am ET): who's on the hook (👥 Ops Quota Roster), the
    // per-week record (📋 Weekly Quota Audit), where the call-out lands, and the bar.
    quotaRosterDataSourceId: optionalString('SPONSOR_QUOTA_ROSTER_DS_ID', '62729c68-535c-4dd0-a633-2feaf6e2b853'),
    quotaAuditDataSourceId: optionalString('SPONSOR_QUOTA_AUDIT_DS_ID', '784770f3-8276-4347-89e0-d677c53576a2'),
    quotaAuditUrl: optionalString('SPONSOR_QUOTA_AUDIT_URL', 'https://www.notion.so/acc29c47cfd44d02b5e5835d5ed6a090'),
    quotaChannel: optionalString('SPONSOR_QUOTA_CHANNEL', 'perbot_spam'),
    weeklyQuota: optionalNumber('SPONSOR_WEEKLY_QUOTA', 3),
  },
  opsTasks: {
    // Ops Tasks database under REV12 Operations (see CLAUDE.md "Notion IDs"): one row per
    // action item a member types under their name on the Saturday meeting page.
    dataSourceId: optionalString('OPS_TASKS_DS_ID', 'a8afc6ec-29d6-4308-b779-ad4235b35e80'),
    // Ops Meetings database (one row per Saturday meeting page, Date property). Tasks link to a
    // row via the `Meeting` relation; each page's "This week" table filters on that relation.
    meetingsDataSourceId: optionalString('OPS_MEETINGS_DS_ID', 'f0e637cd-db29-4a8d-883f-c8c5603db02f'),
    // The database's "My open" view (Owner = me, Status != Done) — linked from the digest DM.
    myOpenViewUrl: optionalString(
      'OPS_TASKS_MY_OPEN_URL',
      'https://www.notion.so/20cbf9381bcb45f99125e1468de321a3?v=3d8560bcc0398150b213000c6479f533'
    ),
  },
  benbuys: {
    // BenBuys ordering helper (/benbuys prep|done). Source of truth = Purchasing (PEFS) DB.
    purchasingDataSourceId: optionalString('BENBUYS_PURCHASING_DS_ID', '39e560bc-c039-83db-9f16-076cb18f7d7b'),
    season: optionalString('BENBUYS_SEASON', 'REV12'),
    // Shared across vendors: the sending mailbox, the constant CC pair, and the BEN approval bar.
    from: optionalString('BENBUYS_FROM', 'electric@engineering.upenn.edu'),
    cc: optionalList('BENBUYS_CC', ['oat@engineering.upenn.edu', 'arjunsh@sas.upenn.edu']),
    approvalThreshold: optionalNumber('BENBUYS_APPROVAL_THRESHOLD', 500),
    // DigiKey's customer-reference field is length-capped (spec assumes 35; confirm on the first real run).
    referenceMaxChars: optionalNumber('BENBUYS_REFERENCE_MAX_CHARS', 35),
    mail: {
      // gmail (OAuth2 refresh token on the electric@ mailbox) | webhook (POST JSON to a URL)
      transport: optionalString('BENBUYS_MAIL_TRANSPORT', 'gmail'),
      gmailClientId: process.env.BENBUYS_GMAIL_CLIENT_ID?.trim() || '',
      gmailClientSecret: process.env.BENBUYS_GMAIL_CLIENT_SECRET?.trim() || '',
      gmailRefreshToken: process.env.BENBUYS_GMAIL_REFRESH_TOKEN?.trim() || '',
      webhookUrl: process.env.BENBUYS_MAIL_WEBHOOK_URL?.trim() || '',
    },
    digikey: {
      to: optionalList('BENBUYS_DIGIKEY_TO', ['purchasing@engineering.upenn.edu']),
      description: optionalString('BENBUYS_DIGIKEY_DESCRIPTION', 'PER electrical purchase'),
      justification: optionalString('BENBUYS_DIGIKEY_JUSTIFICATION', "This is a purchase for PER's electrical subteam."),
      // Slack user ids allowed to run `done` (Katherine Shen).
      operators: optionalList('BENBUYS_DIGIKEY_OPERATORS', ['U09GD5JKSBW']),
      signatureName: optionalString('BENBUYS_DIGIKEY_SIGNATURE', 'Katherine Shen'),
    },
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

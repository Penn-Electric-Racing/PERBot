export type InferredBranch =
  | 'mechanical'
  | 'electrical'
  | 'operations'
  | 'software'
  | 'general'
  | 'unknown';

export type InferredSubsystem =
  | 'accumulator'
  | 'aero'
  | 'chassis'
  | 'drivetrain'
  | 'suspension'
  | 'vehicle dynamics'
  | 'cooling'
  | 'driver interface'
  | 'daqdash'
  | 'pcm'
  | 'hv'
  | 'lv'
  | 'electrical'
  | 'software'
  | 'operations'
  | 'general'
  | 'unknown';

export type InferredDocType =
  | 'home'
  | 'overview'
  | 'design'
  | 'spec'
  | 'meeting_notes'
  | 'bom'
  | 'testing_logs'
  | 'qa'
  | 'general'
  | 'unknown';

/** Where a document came from. Drive lands in Phase 5; the index format already carries it. */
export type SourceKind = 'notion' | 'drive';

/** `doc` = a written page. `record` = a database row indexed as title + property values. */
export type DocKind = 'doc' | 'record';

export interface ParsedQuery {
  raw: string;
  cleaned: string;
  filters: {
    season?: string;
    subsystem?: string;
    historical?: boolean;
  };
}

/**
 * One indexed document. `path` is the full breadcrumb ending in the page's own title
 * (e.g. ["Electrical", "PCM", "REV11 PCM Documentation"]); `pathText` joins it with " › ".
 * The raw markdown is NOT stored here (it lives in the indexer's build cache) — chunks hold
 * the cleaned text.
 */
export interface PageRecord {
  id: string;
  source: SourceKind;
  kind: DocKind;
  title: string;
  url: string;
  path: string[];
  pathText: string;
  createdTime: string;
  lastEditedTime: string;
  /** REVnn parsed from title / path / first lines, when present. */
  revNumber: number | null;
  /** ISO date parsed from the title (meeting notes, weekly updates), when present. */
  docDate: string | null;
  isHistorical: boolean;
  /** Characters of cleaned text on the page. */
  textLength: number;
  inferredBranch: InferredBranch;
  inferredSubsystem: InferredSubsystem;
  inferredDocType: InferredDocType;
}

export interface ChunkRecord {
  id: string;
  pageId: string;
  chunkIndex: number;
  /** Nearest heading path inside the page ("Introduction › What is the PCM?"), if any. */
  heading: string | null;
  /** Cleaned display text. */
  text: string;
  /** sha1 of the exact string that was embedded; lets the nightly build reuse vectors. */
  hash: string;
}

/** The JSON half of the index. Embeddings live beside it as one raw Float32Array file. */
export interface SearchIndex {
  version: 2;
  generatedAt: string;
  currentRev: string;
  embeddingModel: string;
  embeddingDims: number;
  pages: PageRecord[];
  chunks: ChunkRecord[];
}

/** Raw page markdown by page id, so unchanged pages are not re-fetched from Notion nightly. */
export interface BuildCache {
  version: 1;
  /** Notion: raw markdown per page id. */
  pages: Record<string, { lastEditedTime: string; markdown: string }>;
  /** Google Drive: extracted text per file id. */
  drive?: Record<string, { modifiedTime: string; text: string }>;
}

export interface IndexStatus {
  state: 'idle' | 'indexing' | 'ready' | 'error';
  phase?:
    | 'building_pages'
    | 'discovering'
    | 'chunking'
    | 'embedding'
    | 'saving'
    | 'complete'
    | 'error';

  startedAt?: string;
  completedAt?: string;
  generatedAt?: string;
  failedAt?: string;

  indexedPages?: number;
  indexedChunks?: number;

  totalPages?: number;
  totalChunks?: number;
  totalChunkBatches?: number;
  embeddedChunkBatches?: number;
  reusedEmbeddings?: number;

  lastError?: string;
  message?: string;
}

export interface SearchResult {
  page: PageRecord;
  chunk: ChunkRecord;
  /** Fused + boosted score used for ordering before the reranker. */
  score: number;
  lexicalScore: number;
  semanticScore: number;
  /** Short cleaned excerpt for the Slack card. */
  excerpt: string;
}

export interface SearchResponse {
  results: SearchResult[];
  /** True when even the best hit is a weak match; the answer step says so instead of guessing. */
  weak: boolean;
}

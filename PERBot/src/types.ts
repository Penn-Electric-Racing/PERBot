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

export interface ParsedQuery {
  raw: string;
  cleaned: string;
  filters: {
    season?: string;
    subsystem?: string;
    historical?: boolean;
  };
}

export interface NotionPageRecord {
  id: string;
  title: string;
  url: string;
  path: string[];
  createdTime: string;
  lastEditedTime: string;
  markdown: string;
  isHistorical: boolean;
  snippet?: string;

  pathText?: string;
  inferredBranch?: InferredBranch;
  inferredSubsystem?: InferredSubsystem;
  inferredDocType?: InferredDocType;
}

export interface NotionChunkRecord {
  id: string;
  pageId: string;
  chunkIndex: number;
  text: string;
  embedding?: number[];
}

export interface NotionIndex {
  generatedAt: string;
  currentRev: string;
  pages: NotionPageRecord[];
  chunks: NotionChunkRecord[];
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

  lastError?: string;
  message?: string;
}

export interface SearchResult {
  page: NotionPageRecord;
  chunk: NotionChunkRecord;
  score: number;
  lexicalScore: number;
  semanticScore: number;
  excerpt: string;
}

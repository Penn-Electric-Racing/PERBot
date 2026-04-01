export type NotionPageRecord = {
  id: string;
  title: string;
  url: string;
  path: string[];
  lastEditedTime: string;
  createdTime?: string;
  isHistorical: boolean;
  markdown: string;
  snippet: string;
};

export type NotionChunkRecord = {
  id: string;
  pageId: string;
  chunkIndex: number;
  text: string;
  embedding?: number[];
};

export type NotionIndex = {
  generatedAt: string;
  currentRev: string;
  pages: NotionPageRecord[];
  chunks: NotionChunkRecord[];
};

export type ParsedQuery = {
  raw: string;
  cleaned: string;
  filters: {
    season?: string;
    subsystem?: string;
    historical?: boolean;
  };
};

export type SearchResult = {
  page: NotionPageRecord;
  chunk: NotionChunkRecord;
  score: number;
  lexicalScore: number;
  semanticScore: number;
  excerpt: string;
};

export type IndexStatus = {
  phase: 'idle' | 'building_pages' | 'embedding' | 'complete' | 'failed';
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  failedAt?: string;
  lastError?: string;
  message?: string;
  totalPages?: number;
  totalChunks?: number;
  embeddedChunkBatches?: number;
  totalChunkBatches?: number;
  generatedAt?: string;
  pid?: number;
};

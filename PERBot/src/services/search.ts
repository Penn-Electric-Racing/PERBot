import { config } from '../config.js';
import type {
  InferredBranch,
  InferredSubsystem,
  NotionChunkRecord,
  NotionIndex,
  NotionPageRecord,
  ParsedQuery,
  SearchResult,
} from '../types.js';
import { buildBM25Corpus, bm25Score } from '../utils/bm25.js';
import { reciprocalRankFusion } from '../utils/rrf.js';
import { excerptAroundMatch, tokenize } from '../utils/text.js';
import { embedQuery, rerankResults } from './llm.js';

const SUBSYSTEM_QUERY_MAP: Array<{
  subsystem: InferredSubsystem;
  terms: string[];
  preferredBranch?: InferredBranch;
}> = [
  {
    subsystem: 'accumulator',
    preferredBranch: 'mechanical',
    terms: [
      'accumulator',
      'tractive system accumulator',
      'tsa',
      'battery pack',
      'pack',
      'accumulator container',
      'substack',
      'cell stack',
      'hv pack',
    ],
  },
  {
    subsystem: 'chassis',
    preferredBranch: 'mechanical',
    terms: ['chassis', 'frame', 'monocoque', 'tub'],
  },
  {
    subsystem: 'aero',
    preferredBranch: 'mechanical',
    terms: ['aero', 'composites', 'aero/composites'],
  },
  {
    subsystem: 'drivetrain',
    preferredBranch: 'mechanical',
    terms: ['drivetrain'],
  },
  {
    subsystem: 'suspension',
    preferredBranch: 'mechanical',
    terms: ['suspension'],
  },
  {
    subsystem: 'vehicle dynamics',
    preferredBranch: 'mechanical',
    terms: ['vehicle dynamics', 'vd'],
  },
  {
    subsystem: 'cooling',
    preferredBranch: 'mechanical',
    terms: ['cooling', 'thermal', 'radiator'],
  },
  {
    subsystem: 'driver interface',
    preferredBranch: 'mechanical',
    terms: ['driver interface', 'cockpit', 'pedals', 'steering'],
  },
  {
    subsystem: 'daqdash',
    preferredBranch: 'electrical',
    terms: ['daqdash'],
  },
  {
    subsystem: 'pcm',
    preferredBranch: 'electrical',
    terms: ['pcm'],
  },
  {
    subsystem: 'hv',
    preferredBranch: 'electrical',
    terms: ['hv', 'high voltage'],
  },
  {
    subsystem: 'lv',
    preferredBranch: 'electrical',
    terms: ['lv', 'low voltage'],
  },
];

const HIGH_LEVEL_HINTS = [
  'high level',
  'overview',
  'intro',
  'introduction',
  'summary',
  'main doc',
  'main docs',
  'where should i start',
  'start reading',
  'new member',
  'guide',
  'wiki',
  'learn',
];

const NOTES_HINTS = [
  'latest notes',
  'recent notes',
  'meeting notes',
  'meeting',
  'notes',
  'minutes',
  'agenda',
  'recent',
  'latest',
];

const VECTOR_CANDIDATE_N = 50;
const BM25_CANDIDATE_N = 50;
const RERANK_TOP_N = 20;

function normalize(text: string): string {
  return text.toLowerCase();
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

export function parseQuery(input: string): ParsedQuery {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  const filters: ParsedQuery['filters'] = {};
  const remaining: string[] = [];

  for (const token of tokens) {
    const [rawKey, ...rest] = token.split(':');
    const value = rest.join(':').trim();
    const key = (rawKey ?? '').toLowerCase();

    if (!value) {
      remaining.push(token);
      continue;
    }

    if (key === 'season') {
      filters.season = value.toUpperCase();
      continue;
    }
    if (key === 'subsystem') {
      filters.subsystem = value.toLowerCase();
      continue;
    }
    if (key === 'historical') {
      filters.historical = /^(true|yes|1)$/i.test(value);
      continue;
    }

    remaining.push(token);
  }

  const cleaned = remaining.join(' ').trim();
  return { raw: input, cleaned, filters };
}

function passesFilters(parsed: ParsedQuery, page: NotionPageRecord): boolean {
  const corpus = normalize(`${page.title} ${page.path.join(' ')} ${page.markdown}`);

  if (parsed.filters.historical !== undefined && page.isHistorical !== parsed.filters.historical) {
    return false;
  }
  if (parsed.filters.season && !corpus.includes(parsed.filters.season.toLowerCase())) {
    return false;
  }
  if (parsed.filters.subsystem && !corpus.includes(parsed.filters.subsystem.toLowerCase())) {
    return false;
  }

  return true;
}

function queryWantsHighLevel(query: string): boolean {
  const q = normalize(query);
  return HIGH_LEVEL_HINTS.some((hint) => q.includes(hint));
}

function queryWantsNotes(query: string): boolean {
  const q = normalize(query);
  return NOTES_HINTS.some((hint) => q.includes(hint));
}

function queryWantsHistorical(query: string): boolean {
  const q = normalize(query);
  return q.includes('historical') || q.includes('old') || q.includes('older') || q.includes('previous');
}

function metadataNudge(page: NotionPageRecord, queryText: string): number {
  const wantsHighLevel = queryWantsHighLevel(queryText);
  const wantsNotes = queryWantsNotes(queryText);
  const wantsHistorical = queryWantsHistorical(queryText);
  const docType = page.inferredDocType ?? 'unknown';

  let score = 0;

  if (wantsHighLevel) {
    if (docType === 'home') score += 0.15;
    else if (docType === 'overview') score += 0.12;
    else if (docType === 'meeting_notes') score -= 0.08;
  }

  if (wantsNotes) {
    if (docType === 'meeting_notes') score += 0.12;
    else if (docType === 'home' || docType === 'overview') score -= 0.05;
  } else {
    if (docType === 'meeting_notes') score -= 0.04;
  }

  if (page.isHistorical && !wantsHistorical) score -= 0.08;
  else if (page.isHistorical && wantsHistorical) score += 0.05;

  return score;
}

function chooseBestChunk(
  chunks: NotionChunkRecord[],
  queryEmbedding: number[],
  queryText: string
): NotionChunkRecord {
  const q = normalize(queryText);
  let best = chunks[0]!;
  let bestScore = -Infinity;

  for (const chunk of chunks) {
    let score = 0;

    if (chunk.embedding) {
      score += cosine(queryEmbedding, chunk.embedding) * 2;
    }

    const text = normalize(chunk.text);
    if (text.includes(q)) score += 1;
    for (const token of tokenize(q)) {
      if (text.includes(token)) score += 0.2;
    }

    if (score > bestScore) {
      bestScore = score;
      best = chunk;
    }
  }

  return best;
}

export async function searchIndex(index: NotionIndex, rawQuery: string): Promise<SearchResult[]> {
  const parsed = parseQuery(rawQuery);
  const queryText = parsed.cleaned || parsed.raw;

  const queryEmbedding = await embedQuery(queryText);

  const queryTerms = tokenize(queryText);

  const candidatePages = index.pages.filter((page) => passesFilters(parsed, page));

  const chunksByPageId = new Map<string, NotionChunkRecord[]>();
  for (const chunk of index.chunks) {
    const arr = chunksByPageId.get(chunk.pageId) ?? [];
    arr.push(chunk);
    chunksByPageId.set(chunk.pageId, arr);
  }

  const eligiblePages = candidatePages.filter((p) => (chunksByPageId.get(p.id)?.length ?? 0) > 0);

  const corpus = buildBM25Corpus(
    eligiblePages.map((p) => {
      const chunks = chunksByPageId.get(p.id) ?? [];
      return chunks.map((c) => c.text).join(' ');
    })
  );

  const vectorScores = new Map<string, number>();
  const bm25Scores = new Map<string, number>();

  for (let pi = 0; pi < eligiblePages.length; pi++) {
    const page = eligiblePages[pi]!;
    const chunks = chunksByPageId.get(page.id) ?? [];

    let bestCosine = 0;
    for (const chunk of chunks) {
      if (!chunk.embedding) continue;
      const sim = cosine(queryEmbedding, chunk.embedding);
      if (sim > bestCosine) bestCosine = sim;
    }
    vectorScores.set(page.id, bestCosine);

    const docText = chunks.map((c) => c.text).join(' ');
    bm25Scores.set(page.id, bm25Score(queryTerms, docText, corpus));
  }

  const vectorRanking = eligiblePages
    .slice()
    .sort((a, b) => (vectorScores.get(b.id) ?? 0) - (vectorScores.get(a.id) ?? 0))
    .slice(0, VECTOR_CANDIDATE_N)
    .map((p) => p.id);

  const bm25Ranking = eligiblePages
    .slice()
    .sort((a, b) => (bm25Scores.get(b.id) ?? 0) - (bm25Scores.get(a.id) ?? 0))
    .slice(0, BM25_CANDIDATE_N)
    .map((p) => p.id);

  const rrfScores = reciprocalRankFusion([vectorRanking, bm25Ranking]);

  const pageMap = new Map<string, NotionPageRecord>(eligiblePages.map((p) => [p.id, p]));

  const fusedRanking = [...rrfScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, RERANK_TOP_N);

  const rerankedIds = await rerankResults(
    queryText,
    fusedRanking.map(([id]) => {
      const page = pageMap.get(id)!;
      const chunks = chunksByPageId.get(id) ?? [];
      const bestChunk = chooseBestChunk(chunks, queryEmbedding, queryText);
      return { pageId: id, title: page.title, excerpt: excerptAroundMatch(bestChunk.text, queryText) };
    })
  );

  const topIds = rerankedIds.slice(0, config.app.topKResults);

  return topIds.map((id) => {
    const page = pageMap.get(id)!;
    const chunks = chunksByPageId.get(id) ?? [];
    const chunk = chooseBestChunk(chunks, queryEmbedding, queryText);
    const rrfScore = rrfScores.get(id) ?? 0;
    const nudge = metadataNudge(page, queryText);

    return {
      page,
      chunk,
      score: rrfScore + nudge,
      lexicalScore: bm25Scores.get(id) ?? 0,
      semanticScore: vectorScores.get(id) ?? 0,
      excerpt: excerptAroundMatch(chunk.text, queryText),
    };
  });
}

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
import { embedQuery } from './llm.js';
import { excerptAroundMatch, tokenize } from '../utils/text.js';

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

function normalize(text: string): string {
  return text.toLowerCase();
}

function dot(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let total = 0;
  for (let i = 0; i < len; i += 1) total += a[i]! * b[i]!;
  return total;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

export function parseQuery(input: string): ParsedQuery {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  const filters: ParsedQuery['filters'] = {};
  const remaining: string[] = [];

  for (const token of tokens) {
    const [rawKey, ...rest] = token.split(':');
    const value = rest.join(':').trim();
    const key = rawKey.toLowerCase();

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

function detectSubsystemIntent(
  query: string,
  explicitSubsystem?: string
): {
  subsystem: InferredSubsystem | null;
  terms: string[];
  preferredBranch: InferredBranch | null;
} {
  const q = normalize(`${query} ${explicitSubsystem ?? ''}`);

  for (const candidate of SUBSYSTEM_QUERY_MAP) {
    if (candidate.terms.some((term) => q.includes(term))) {
      return {
        subsystem: candidate.subsystem,
        terms: candidate.terms,
        preferredBranch: candidate.preferredBranch ?? null,
      };
    }
  }

  return { subsystem: null, terms: [], preferredBranch: null };
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

function pageHasSubsystemEvidence(
  page: NotionPageRecord,
  subsystemTerms: string[],
  targetSubsystem: InferredSubsystem | null
): boolean {
  if (!targetSubsystem || subsystemTerms.length === 0) return true;

  const titlePath = normalize(`${page.title} ${page.path.join(' ')}`);
  const body = normalize(page.markdown.slice(0, 4000));

  if (page.inferredSubsystem === targetSubsystem) return true;
  if (subsystemTerms.some((term) => titlePath.includes(term))) return true;

  let bodyHits = 0;
  for (const term of subsystemTerms) {
    if (body.includes(term)) bodyHits += 1;
  }

  return bodyHits >= 2;
}

function docTypeBoost(page: NotionPageRecord, query: string): number {
  const wantsHighLevel = queryWantsHighLevel(query);
  const wantsNotes = queryWantsNotes(query);

  let score = 0;
  const docType = page.inferredDocType ?? 'unknown';

  if (wantsHighLevel) {
    if (docType === 'home') score += 9;
    if (docType === 'overview') score += 8;
    if (docType === 'design') score += 5;
    if (docType === 'spec') score += 5;
    if (docType === 'meeting_notes') score -= 4;
    if (docType === 'qa') score -= 6;
  }

  if (wantsNotes) {
    if (docType === 'meeting_notes') score += 8;
    if (docType === 'overview') score -= 2;
    if (docType === 'home') score -= 2;
  } else {
    if (docType === 'meeting_notes') score -= 2;
  }

  if (!wantsHighLevel && !wantsNotes && docType === 'qa') {
    score -= 5;
  }

  return score;
}

function historicalAdjustment(page: NotionPageRecord, query: string): number {
  const wantsHistorical = queryWantsHistorical(query);
  if (page.isHistorical && !wantsHistorical) return -5;
  if (page.isHistorical && wantsHistorical) return 2;
  return 0;
}

function branchBoost(page: NotionPageRecord, preferredBranch: InferredBranch | null): number {
  if (!preferredBranch) return 0;
  if (page.inferredBranch === preferredBranch) return 8;
  return -2;
}

function subsystemBoost(
  page: NotionPageRecord,
  targetSubsystem: InferredSubsystem | null,
  subsystemTerms: string[]
): number {
  if (!targetSubsystem) return 0;

  const titlePath = normalize(`${page.title} ${page.path.join(' ')}`);
  const body = normalize(page.markdown.slice(0, 4000));

  let score = 0;

  if (page.inferredSubsystem === targetSubsystem) score += 20;
  if (subsystemTerms.some((term) => titlePath.includes(term))) score += 16;
  if (subsystemTerms.some((term) => body.includes(term))) score += 4;

  return score;
}

function lexicalScore(page: NotionPageRecord, query: string): number {
  const q = normalize(query.trim());
  if (!q) return 0;

  const queryTokens = tokenize(q);
  const titleLower = normalize(page.title);
  const pathLower = normalize(page.path.join(' '));
  const bodyLower = normalize(page.markdown.slice(0, 5000));

  let score = 0;

  if (titleLower.includes(q)) score += 18;
  if (pathLower.includes(q)) score += 14;
  if (bodyLower.includes(q)) score += 4;

  for (const token of queryTokens) {
    score += countOccurrences(titleLower, token) * 5.5;
    score += countOccurrences(pathLower, token) * 4.5;
    score += countOccurrences(bodyLower, token) * 0.8;
  }

  return score;
}

function pageSemanticScore(queryEmbedding: number[] | null, chunks: NotionChunkRecord[]): number {
  if (!queryEmbedding) return 0;

  let best = 0;
  let total = 0;
  let count = 0;

  for (const chunk of chunks) {
    if (!chunk.embedding) continue;
    const score = dot(queryEmbedding, chunk.embedding);
    if (score > best) best = score;
    total += score;
    count += 1;
  }

  if (count === 0) return 0;

  const avg = total / count;
  return best * 0.7 + avg * 0.3;
}

function supportScore(page: NotionPageRecord, chunks: NotionChunkRecord[], query: string): number {
  const qTokens = tokenize(normalize(query));
  if (qTokens.length === 0) return 0;

  let supportingChunks = 0;
  for (const chunk of chunks) {
    const text = normalize(chunk.text);
    const hits = qTokens.reduce((acc, token) => acc + (text.includes(token) ? 1 : 0), 0);
    if (hits >= Math.min(2, qTokens.length)) {
      supportingChunks += 1;
    }
  }

  let score = Math.min(6, supportingChunks * 1.2);

  if (page.inferredDocType === 'home') score += 1.5;
  if (page.inferredDocType === 'overview') score += 1.2;

  return score;
}

function chooseBestChunkForPage(
  page: NotionPageRecord,
  chunks: NotionChunkRecord[],
  query: string
): NotionChunkRecord {
  const q = normalize(query);
  let bestChunk = chunks[0];
  let bestScore = -Infinity;

  for (const chunk of chunks) {
    const text = normalize(chunk.text);
    let score = 0;

    if (text.includes(q)) score += 10;

    for (const token of tokenize(q)) {
      if (text.includes(token)) score += 1.5;
    }

    if (page.inferredDocType === 'home' || page.inferredDocType === 'overview') {
      score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      bestChunk = chunk;
    }
  }

  return bestChunk;
}

export async function searchIndex(index: NotionIndex, rawQuery: string): Promise<SearchResult[]> {
  const parsed = parseQuery(rawQuery);
  const queryText = parsed.cleaned || parsed.raw;
  const queryEmbedding = await embedQuery(queryText);

  const subsystemIntent = detectSubsystemIntent(queryText, parsed.filters.subsystem);
  const chunksByPageId = new Map<string, NotionChunkRecord[]>();

  for (const chunk of index.chunks) {
    const arr = chunksByPageId.get(chunk.pageId) || [];
    arr.push(chunk);
    chunksByPageId.set(chunk.pageId, arr);
  }

  let candidatePages = index.pages.filter((page) => passesFilters(parsed, page));

  if (subsystemIntent.subsystem) {
    const gated = candidatePages.filter((page) =>
      pageHasSubsystemEvidence(page, subsystemIntent.terms, subsystemIntent.subsystem)
    );

    if (gated.length > 0) {
      candidatePages = gated;
    }
  }

  const scoredPages: Array<{
    page: NotionPageRecord;
    score: number;
    lexical: number;
    semantic: number;
    chosenChunk: NotionChunkRecord;
  }> = [];

  for (const page of candidatePages) {
    const pageChunks = chunksByPageId.get(page.id) || [];
    if (pageChunks.length === 0) continue;

    const lexical = lexicalScore(page, queryText);
    const semantic = pageSemanticScore(queryEmbedding, pageChunks);

    const finalScore =
      lexical * 0.85 +
      semantic * 2.0 +
      subsystemBoost(page, subsystemIntent.subsystem, subsystemIntent.terms) +
      branchBoost(page, subsystemIntent.preferredBranch) +
      docTypeBoost(page, queryText) +
      historicalAdjustment(page, queryText) +
      supportScore(page, pageChunks, queryText);

    if (finalScore <= 0) continue;

    scoredPages.push({
      page,
      score: finalScore,
      lexical,
      semantic,
      chosenChunk: chooseBestChunkForPage(page, pageChunks, queryText),
    });
  }

  return scoredPages
    .sort((a, b) => b.score - a.score)
    .slice(0, config.app.topKResults)
    .map((entry) => ({
      page: entry.page,
      chunk: entry.chosenChunk,
      score: entry.score,
      lexicalScore: entry.lexical,
      semanticScore: entry.semantic,
      excerpt: excerptAroundMatch(entry.chosenChunk.text, queryText),
    }));
}

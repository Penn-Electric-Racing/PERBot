import { config } from '../config.js';
import type { NotionChunkRecord, NotionIndex, ParsedQuery, SearchResult } from '../types.js';
import { embedQuery } from './llm.js';
import { excerptAroundMatch, tokenize } from '../utils/text.js';

const KNOWN_SUBSYSTEMS = [
  'chassis',
  'accumulator',
  'cooling',
  'aero',
  'suspension',
  'drivetrain',
  'vehicle dynamics',
  'driver interface',
  'daqdash',
  'pcm',
  'hv',
  'lv',
  'brakes',
  'brake',
  'electrical',
  'software',
];

const SUBSYSTEM_ALIASES: Record<string, string[]> = {
  accumulator: ['battery pack', 'pack', 'tractive system accumulator', 'tsa', 'accumulator container'],
  chassis: ['frame', 'monocoque', 'tub'],
  cooling: ['radiator', 'thermal'],
  'driver interface': ['cockpit', 'pedals', 'steering'],
  brakes: ['brake system', 'braking'],
};

const HIGH_LEVEL_HINTS = [
  'high level',
  'overview',
  'intro',
  'introduction',
  'summary',
  'main doc',
  'main docs',
  'design doc',
  'spec',
  'specification',
  'wiki',
  'guide',
  'where should i start',
  'start reading',
  'new member',
  'learn',
];

const NOTE_HINTS = [
  'latest notes',
  'recent notes',
  'meeting notes',
  'notes',
  'meeting',
  'minutes',
  'agenda',
  'updates',
];

const OVERVIEW_DOC_HINTS = [
  'overview',
  'intro',
  'introduction',
  'summary',
  'wiki',
  'guide',
  'readme',
  'architecture',
  'high level',
  'main',
  'design',
  'spec',
  'specification',
  'subsystem',
];

const MEETING_DOC_HINTS = [
  'meeting',
  'notes',
  'minutes',
  'agenda',
  'sync',
  'update',
  'standup',
];

const QA_DOC_HINTS = ['q&a', 'qa', 'questions', 'brainstorm'];

type PageRecord = NotionIndex['pages'][number];

function dot(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let total = 0;
  for (let i = 0; i < len; i += 1) total += a[i]! * b[i]!;
  return total;
}

function normalize(text: string): string {
  return text.toLowerCase();
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

function textForFiltering(page: { title: string; markdown: string; path: string[] }): string {
  return `${page.title} ${page.path.join(' ')} ${page.markdown}`.toLowerCase();
}

function passesFilters(
  parsed: ParsedQuery,
  page: { title: string; markdown: string; path: string[]; isHistorical: boolean }
): boolean {
  const corpus = textForFiltering(page);

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

function detectSubsystems(query: string): string[] {
  const q = normalize(query);
  return KNOWN_SUBSYSTEMS.filter((name) => q.includes(name));
}

function expandSubsystemTerms(detectedSubsystems: string[]): string[] {
  const expanded = new Set<string>();

  for (const subsystem of detectedSubsystems) {
    expanded.add(subsystem);
    for (const alias of SUBSYSTEM_ALIASES[subsystem] || []) {
      expanded.add(alias);
    }
  }

  return [...expanded];
}

function queryWantsHighLevel(query: string): boolean {
  const q = normalize(query);
  return HIGH_LEVEL_HINTS.some((hint) => q.includes(hint));
}

function queryWantsNotes(query: string): boolean {
  const q = normalize(query);
  return NOTE_HINTS.some((hint) => q.includes(hint));
}

function titleAndPathText(page: { title: string; path: string[] }): string {
  return normalize(`${page.title} ${page.path.join(' ')}`);
}

function pageLooksLikeOverview(page: { title: string; path: string[]; markdown: string }): boolean {
  const haystack = normalize(`${page.title} ${page.path.join(' ')} ${page.markdown.slice(0, 1500)}`);
  return OVERVIEW_DOC_HINTS.some((hint) => haystack.includes(hint));
}

function pageLooksLikeMeetingNotes(page: { title: string; path: string[]; markdown: string }): boolean {
  const haystack = normalize(`${page.title} ${page.path.join(' ')} ${page.markdown.slice(0, 1000)}`);
  return MEETING_DOC_HINTS.some((hint) => haystack.includes(hint));
}

function pageLooksLikeQA(page: { title: string; path: string[]; markdown: string }): boolean {
  const haystack = normalize(`${page.title} ${page.path.join(' ')} ${page.markdown.slice(0, 800)}`);
  return QA_DOC_HINTS.some((hint) => haystack.includes(hint));
}

function historicalAdjustment(query: string, page: { isHistorical: boolean }): number {
  const q = normalize(query);
  const wantsHistorical =
    q.includes('historical') || q.includes('old') || q.includes('older') || q.includes('previous');

  if (page.isHistorical && !wantsHistorical) return -5;
  if (page.isHistorical && wantsHistorical) return 1.5;
  return 0;
}

function subsystemScoreBoost(
  subsystemTerms: string[],
  page: { title: string; path: string[]; markdown: string }
): number {
  if (subsystemTerms.length === 0) return 0;

  const titlePath = titleAndPathText(page);
  const body = normalize(page.markdown.slice(0, 3000));

  let score = 0;
  let matched = false;

  for (const term of subsystemTerms) {
    if (titlePath.includes(term)) {
      score += 8;
      matched = true;
    } else if (body.includes(term)) {
      score += 2.5;
      matched = true;
    }
  }

  if (!matched) score -= 6;
  return score;
}

function unrelatedSubsystemPenalty(
  detectedSubsystems: string[],
  page: { title: string; path: string[] }
): number {
  if (detectedSubsystems.length === 0) return 0;

  const titlePath = titleAndPathText(page);
  const matchingSubsystems = KNOWN_SUBSYSTEMS.filter((s) => titlePath.includes(s));

  if (matchingSubsystems.length === 0) return 0;

  const overlaps = matchingSubsystems.some((s) => detectedSubsystems.includes(s));
  if (overlaps) return 0;

  return -5;
}

function requiredSubsystemEvidencePenalty(
  subsystemTerms: string[],
  page: { title: string; path: string[]; markdown: string }
): number {
  if (subsystemTerms.length === 0) return 0;

  const titlePath = titleAndPathText(page);
  const body = normalize(page.markdown.slice(0, 3000));

  let strongMatches = 0;

  for (const term of subsystemTerms) {
    if (titlePath.includes(term)) strongMatches += 2;
    else if (body.includes(term)) strongMatches += 1;
  }

  if (strongMatches >= 2) return 0;
  if (strongMatches === 1) return -3;
  return -8;
}

function pageLexicalScore(query: string, page: { title: string; path: string[]; markdown: string; isHistorical: boolean }): number {
  const q = normalize(query.trim());
  if (!q) return 0;

  const queryTokens = tokenize(q);
  const titleLower = normalize(page.title);
  const pathLower = normalize(page.path.join(' '));
  const bodyLower = normalize(page.markdown.slice(0, 6000));

  let score = 0;

  if (titleLower.includes(q)) score += 18;
  if (pathLower.includes(q)) score += 12;
  if (bodyLower.includes(q)) score += 4;

  for (const token of queryTokens) {
    const titleHits = countOccurrences(titleLower, token);
    const pathHits = countOccurrences(pathLower, token);
    const bodyHits = countOccurrences(bodyLower, token);

    score += titleHits * 5.5;
    score += pathHits * 3.5;
    score += bodyHits * 0.8;
  }

  if (!page.isHistorical) score += 0.4;
  return score;
}

function intentBoost(query: string, page: { title: string; path: string[]; markdown: string }): number {
  const wantsHighLevel = queryWantsHighLevel(query);
  const wantsNotes = queryWantsNotes(query);

  let score = 0;
  const titlePath = titleAndPathText(page);
  const looksOverview = pageLooksLikeOverview(page);
  const looksNotes = pageLooksLikeMeetingNotes(page);
  const looksQA = pageLooksLikeQA(page);

  if (wantsHighLevel) {
    if (looksOverview) score += 8;
    if (titlePath.includes('overview')) score += 3;
    if (titlePath.includes('wiki')) score += 3;
    if (titlePath.includes('guide')) score += 2;
    if (titlePath.includes('intro')) score += 2;
    if (titlePath.includes('summary')) score += 2;
    if (titlePath.includes('design')) score += 2;
    if (titlePath.includes('spec')) score += 2;
    if (titlePath.includes('architecture')) score += 2;
    if (looksNotes) score -= 4;
    if (looksQA) score -= 5;
  }

  if (wantsNotes) {
    if (looksNotes) score += 8;
    if (looksOverview) score -= 2;
  } else {
    if (looksNotes) score -= 2.5;
  }

  if (!wantsHighLevel && !wantsNotes && looksQA) {
    score -= 4;
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

function supportingEvidenceScore(query: string, page: { title: string; path: string[]; markdown: string }, chunks: NotionChunkRecord[]): number {
  const terms = tokenize(normalize(query));
  if (terms.length === 0) return 0;

  let supportingChunks = 0;
  const titlePath = titleAndPathText(page);

  for (const chunk of chunks) {
    const text = normalize(chunk.text);
    const hitCount = terms.reduce((acc, term) => acc + (text.includes(term) ? 1 : 0), 0);
    if (hitCount >= Math.min(2, terms.length)) {
      supportingChunks += 1;
    }
  }

  let score = Math.min(6, supportingChunks * 1.2);

  for (const term of terms) {
    if (titlePath.includes(term)) score += 0.8;
  }

  return score;
}

function chooseBestChunkForPage(query: string, page: PageRecord, chunks: NotionChunkRecord[]): NotionChunkRecord {
  const q = normalize(query);

  let bestChunk = chunks[0];
  let bestScore = -Infinity;

  for (const chunk of chunks) {
    const text = normalize(chunk.text);
    let score = 0;

    if (text.includes(q)) score += 10;

    for (const token of tokenize(q)) {
      if (text.includes(token)) score += 1.2;
    }

    if (pageLooksLikeOverview(page) && queryWantsHighLevel(query)) {
      score += 1.5;
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

  const detectedSubsystems = [
    ...detectSubsystems(queryText),
    ...(parsed.filters.subsystem ? [parsed.filters.subsystem] : []),
  ];
  const subsystemTerms = expandSubsystemTerms(detectedSubsystems);

  const chunksByPageId = new Map<string, NotionChunkRecord[]>();
  for (const chunk of index.chunks) {
    const arr = chunksByPageId.get(chunk.pageId) || [];
    arr.push(chunk);
    chunksByPageId.set(chunk.pageId, arr);
  }

  const pageCandidates: Array<{
    page: PageRecord;
    score: number;
    lexical: number;
    semantic: number;
    chosenChunk: NotionChunkRecord;
  }> = [];

  for (const page of index.pages) {
    if (!passesFilters(parsed, page)) continue;

    const pageChunks = chunksByPageId.get(page.id) || [];
    if (pageChunks.length === 0) continue;

    const lexical = pageLexicalScore(queryText, page);
    const semantic = pageSemanticScore(queryEmbedding, pageChunks);
    const subsystemBoost = subsystemScoreBoost(subsystemTerms, page);
    const unrelatedPenalty = unrelatedSubsystemPenalty(detectedSubsystems, page);
    const subsystemEvidencePenalty = requiredSubsystemEvidencePenalty(subsystemTerms, page);
    const intent = intentBoost(queryText, page);
    const historyAdj = historicalAdjustment(queryText, page);
    const support = supportingEvidenceScore(queryText, page, pageChunks);

    const finalScore =
      lexical * 0.75 +
      semantic * 2.5 +
      subsystemBoost +
      unrelatedPenalty +
      subsystemEvidencePenalty +
      intent +
      historyAdj +
      support;

    if (finalScore <= 0) continue;

    const chosenChunk = chooseBestChunkForPage(queryText, page, pageChunks);

    pageCandidates.push({
      page,
      score: finalScore,
      lexical,
      semantic,
      chosenChunk,
    });
  }

  return pageCandidates
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(config.app.topKResults, 8))
    .slice(0, config.app.topKResults)
    .map((candidate) => ({
      page: candidate.page,
      chunk: candidate.chosenChunk,
      score: candidate.score,
      lexicalScore: candidate.lexical,
      semanticScore: candidate.semantic,
      excerpt: excerptAroundMatch(candidate.chosenChunk.text, queryText),
    }));
}

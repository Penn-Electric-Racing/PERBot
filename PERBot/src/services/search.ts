import { config } from '../config.js';
import type { NotionIndex, ParsedQuery, SearchResult } from '../types.js';
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

function dot(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let total = 0;
  for (let i = 0; i < len; i += 1) total += a[i]! * b[i]!;
  return total;
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

function normalize(text: string): string {
  return text.toLowerCase();
}

function textForFiltering(result: { title: string; markdown: string; path: string[] }): string {
  return `${result.title} ${result.path.join(' ')} ${result.markdown}`.toLowerCase();
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

function pageLooksLikeOverview(page: { title: string; path: string[]; markdown: string }): boolean {
  const haystack = normalize(`${page.title} ${page.path.join(' ')} ${page.markdown.slice(0, 1500)}`);
  return OVERVIEW_DOC_HINTS.some((hint) => haystack.includes(hint));
}

function titleAndPathText(page: { title: string; path: string[] }): string {
  return normalize(`${page.title} ${page.path.join(' ')}`);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

function subsystemScoreBoost(
  subsystemTerms: string[],
  page: { title: string; path: string[]; markdown: string }
): number {
  if (subsystemTerms.length === 0) return 0;

  const titlePath = titleAndPathText(page);
  const pageText = normalize(page.markdown.slice(0, 4000));

  let score = 0;

  for (const term of subsystemTerms) {
    const inTitlePath = titlePath.includes(term);
    const inText = pageText.includes(term);

    if (inTitlePath) score += 8;
    if (inText) score += 2.5;
  }

  const matchedAny = subsystemTerms.some(
    (term) => titlePath.includes(term) || pageText.includes(term)
  );

  if (!matchedAny) {
    score -= 6;
  }

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

function lexicalScore(
  query: string,
  page: { title: string; path: string[]; markdown: string; isHistorical: boolean }
): number {
  const q = normalize(query.trim());
  if (!q) return 0;

  const queryTokens = tokenize(q);
  const titleLower = normalize(page.title);
  const pathLower = normalize(page.path.join(' '));
  const textLower = normalize(page.markdown);

  let score = 0;

  if (titleLower.includes(q)) score += 18;
  if (pathLower.includes(q)) score += 12;
  if (textLower.includes(q)) score += 3.5;

  for (const token of queryTokens) {
    const titleHits = countOccurrences(titleLower, token);
    const pathHits = countOccurrences(pathLower, token);
    const textHits = countOccurrences(textLower, token);

    score += titleHits * 5.5;
    score += pathHits * 3.5;
    score += textHits * 0.8;
  }

  if (!page.isHistorical) score += 0.4;
  return score;
}

function highLevelIntentBoost(
  query: string,
  page: { title: string; path: string[]; markdown: string }
): number {
  if (!queryWantsHighLevel(query)) return 0;

  let score = 0;
  const titlePath = titleAndPathText(page);

  if (pageLooksLikeOverview(page)) score += 6;
  if (titlePath.includes('overview')) score += 3;
  if (titlePath.includes('wiki')) score += 3;
  if (titlePath.includes('guide')) score += 2;
  if (titlePath.includes('intro')) score += 2;
  if (titlePath.includes('summary')) score += 2;
  if (titlePath.includes('design')) score += 2;
  if (titlePath.includes('spec')) score += 2;
  if (titlePath.includes('architecture')) score += 2;

  return score;
}

function historicalAdjustment(
  query: string,
  page: { isHistorical: boolean }
): number {
  const q = normalize(query);
  const wantsHistorical =
    q.includes('historical') || q.includes('old') || q.includes('older') || q.includes('previous');

  if (page.isHistorical && !wantsHistorical) return -5;
  if (page.isHistorical && wantsHistorical) return 1.5;
  return 0;
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

  const pageById = new Map(index.pages.map((page) => [page.id, page]));

  const bestChunkPerPage = new Map<
    string,
    {
      chunk: NotionIndex['chunks'][number];
      bestChunkScore: number;
      bestLexical: number;
      bestSemantic: number;
      excerpt: string;
      supportingChunkHits: number;
      aggregatedChunkScore: number;
    }
  >();

  for (const chunk of index.chunks) {
    const page = pageById.get(chunk.pageId);
    if (!page) continue;
    if (!passesFilters(parsed, page)) continue;

    const lexical = lexicalScore(queryText, page);
    const semantic = queryEmbedding && chunk.embedding ? dot(queryEmbedding, chunk.embedding) : 0;

    const chunkTextLower = normalize(chunk.text);
    const tokenHits = tokenize(normalize(queryText)).reduce((acc, token) => {
      return acc + (chunkTextLower.includes(token) ? 1 : 0);
    }, 0);

    const chunkLocalScore =
      lexical * 0.55 +
      (queryEmbedding && chunk.embedding ? semantic * 4.0 : 0) +
      tokenHits * 0.6;

    if (chunkLocalScore <= 0) continue;

    const existing = bestChunkPerPage.get(page.id);
    const excerpt = excerptAroundMatch(chunk.text, queryText);

    if (!existing) {
      bestChunkPerPage.set(page.id, {
        chunk,
        bestChunkScore: chunkLocalScore,
        bestLexical: lexical,
        bestSemantic: semantic,
        excerpt,
        supportingChunkHits: tokenHits > 0 ? 1 : 0,
        aggregatedChunkScore: chunkLocalScore,
      });
    } else {
      existing.aggregatedChunkScore += chunkLocalScore * 0.35;
      if (tokenHits > 0) existing.supportingChunkHits += 1;

      if (chunkLocalScore > existing.bestChunkScore) {
        existing.chunk = chunk;
        existing.bestChunkScore = chunkLocalScore;
        existing.bestLexical = lexical;
        existing.bestSemantic = semantic;
        existing.excerpt = excerpt;
      }
    }
  }

  const results: SearchResult[] = [];

  for (const [pageId, pageChunkInfo] of bestChunkPerPage.entries()) {
    const page = pageById.get(pageId);
    if (!page) continue;

    const titlePathBoost = lexicalScore(queryText, {
      title: page.title,
      path: page.path,
      markdown: '',
      isHistorical: page.isHistorical,
    });

    const subsystemBoost = subsystemScoreBoost(subsystemTerms, page);
    const unrelatedPenalty = unrelatedSubsystemPenalty(detectedSubsystems, page);
    const subsystemEvidencePenalty = requiredSubsystemEvidencePenalty(subsystemTerms, page);
    const overviewBoost = highLevelIntentBoost(queryText, page);
    const historyAdj = historicalAdjustment(queryText, page);
    const supportBoost = Math.min(6, pageChunkInfo.supportingChunkHits * 1.2);

    const finalScore =
      pageChunkInfo.bestChunkScore * 0.45 +
      pageChunkInfo.aggregatedChunkScore * 0.20 +
      titlePathBoost * 0.55 +
      subsystemBoost +
      unrelatedPenalty +
      subsystemEvidencePenalty +
      overviewBoost +
      historyAdj +
      supportBoost;

    if (finalScore <= 0) continue;

    results.push({
      page,
      chunk: pageChunkInfo.chunk,
      score: finalScore,
      lexicalScore: pageChunkInfo.bestLexical,
      semanticScore: pageChunkInfo.bestSemantic,
      excerpt: pageChunkInfo.excerpt,
    });
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, config.app.topKResults);
}

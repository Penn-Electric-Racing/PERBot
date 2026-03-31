import { config } from '../config.js';
import type { NotionIndex, ParsedQuery, SearchResult } from '../types.js';
import { embedQuery } from './llm.js';
import { excerptAroundMatch, tokenize } from '../utils/text.js';

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

function textForFiltering(result: { title: string; markdown: string; path: string[] }): string {
  return `${result.title} ${result.path.join(' ')} ${result.markdown}`.toLowerCase();
}

function passesFilters(parsed: ParsedQuery, page: { title: string; markdown: string; path: string[]; isHistorical: boolean }): boolean {
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

function lexicalScore(query: string, title: string, chunkText: string, isHistorical: boolean): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;

  const queryTokens = tokenize(q);
  const titleLower = title.toLowerCase();
  const textLower = chunkText.toLowerCase();

  let score = 0;
  if (titleLower.includes(q)) score += 6;
  if (textLower.includes(q)) score += 3;

  for (const token of queryTokens) {
    const titleHits = titleLower.split(token).length - 1;
    const textHits = textLower.split(token).length - 1;
    score += titleHits * 2.5;
    score += textHits * 1.0;
  }

  if (!isHistorical) score += 0.35;
  return score;
}

export async function searchIndex(index: NotionIndex, rawQuery: string): Promise<SearchResult[]> {
  const parsed = parseQuery(rawQuery);
  const queryText = parsed.cleaned || parsed.raw;
  const queryEmbedding = await embedQuery(queryText);

  const scored: SearchResult[] = [];

  for (const chunk of index.chunks) {
    const page = index.pages.find((candidate) => candidate.id === chunk.pageId);
    if (!page) continue;
    if (!passesFilters(parsed, page)) continue;

    const lexical = lexicalScore(queryText, page.title, chunk.text, page.isHistorical);
    const semantic = queryEmbedding && chunk.embedding ? dot(queryEmbedding, chunk.embedding) : 0;

    const combined = queryEmbedding && chunk.embedding
      ? lexical * 0.55 + semantic * 8.0
      : lexical;

    if (combined <= 0) continue;

    scored.push({
      page,
      chunk,
      score: combined,
      lexicalScore: lexical,
      semanticScore: semantic,
      excerpt: excerptAroundMatch(chunk.text, queryText),
    });
  }

  const bestPerPage = new Map<string, SearchResult>();
  for (const result of scored.sort((a, b) => b.score - a.score)) {
    const existing = bestPerPage.get(result.page.id);
    if (!existing || result.score > existing.score) {
      bestPerPage.set(result.page.id, result);
    }
  }

  return [...bestPerPage.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, config.app.topKResults);
}

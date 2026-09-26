import { config } from '../config.js';
import type { ChunkRecord, PageRecord, ParsedQuery, SearchResponse, SearchResult } from '../types.js';
import { bm25Query } from '../utils/bm25.js';
import { reciprocalRankFusion } from '../utils/rrf.js';
import { contentTerms, excerptAroundMatch, tokenize } from '../utils/text.js';
import type { LoadedIndex } from './index-store.js';
import { embedQuery, rerankResults } from './llm.js';

/**
 * Hybrid retrieval over chunks:
 *   query → (vector top-N, BM25 top-N) → reciprocal rank fusion → best chunk per page →
 *   title/path/recency boosts → Groq rerank of the top pages → top-K.
 *
 * `retrieve()` is the deterministic half (no LLM beyond the query embedding) so the eval
 * harness can score it on its own; `searchIndex()` adds the reranker and excerpts.
 */

const VECTOR_CANDIDATES = 80;
const BM25_CANDIDATES = 80;
const RERANK_CANDIDATES = 15;
/** Below this cosine, even the best chunk is probably not about the question. */
const WEAK_COSINE = 0.34;

/** PER acronyms → words, added to the lexical query at reduced weight (and the reverse). */
const GLOSSARY: Record<string, string[]> = {
  pcm: ['powertrain', 'control', 'module'],
  daq: ['data', 'acquisition'],
  daqdash: ['daq', 'dash', 'dashboard'],
  dash: ['dashboard', 'daqdash'],
  tsa: ['tractive', 'system', 'accumulator'],
  ts: ['tractive', 'system'],
  air: ['accumulator', 'isolation', 'relay'],
  airs: ['accumulator', 'isolation', 'relay'],
  bspd: ['brake', 'system', 'plausibility', 'device'],
  imd: ['insulation', 'monitoring', 'device'],
  ams: ['accumulator', 'management', 'system', 'bms'],
  bms: ['battery', 'management', 'system', 'ams'],
  lvbms: ['low', 'voltage', 'bms'],
  pdu: ['power', 'distribution', 'unit'],
  lv: ['low', 'voltage'],
  hv: ['high', 'voltage'],
  vd: ['vehicle', 'dynamics'],
  di: ['driver', 'interface'],
  moc: ['motor', 'controller'],
  mocs: ['motor', 'controllers'],
  rtds: ['ready', 'to', 'drive', 'sound'],
  sdc: ['shutdown', 'circuit'],
  ebs: ['emergency', 'brake', 'system'],
  hil: ['hardware', 'in', 'the', 'loop'],
  cfd: ['computational', 'fluid', 'dynamics'],
  fea: ['finite', 'element', 'analysis'],
  bom: ['bill', 'of', 'materials'],
  pefs: ['purchasing', 'procurement'],
  cdr: ['critical', 'design', 'review'],
  pdr: ['preliminary', 'design', 'review'],
  ses: ['structural', 'equivalency', 'spreadsheet'],
  fsae: ['formula', 'sae'],
  lec: ['lincoln', 'electric', 'competition'],
  '4wd': ['four', 'wheel', 'drive', 'awd'],
  awd: ['all', 'wheel', 'drive', '4wd'],
  tc: ['traction', 'control'],
  tv: ['torque', 'vectoring'],
  can: ['canbus'],
  canbus: ['can', 'bus'],
  dti: ['drivetrain', 'innovation', 'inverter'],
};

/** Glossary keys that are also ordinary words; only expanded when typed in capitals ("AIR", "CAN"). */
const UPPERCASE_ONLY = new Set(['can', 'air', 'airs', 'di', 'ts', 'tc', 'tv', 'dash', 'ses']);

const HIGH_LEVEL_HINTS = ['high level', 'overview', 'intro', 'introduction', 'summary', 'where should i start', 'new member', 'guide', 'wiki', 'learn', 'onboarding'];
const NOTES_HINTS = ['latest notes', 'recent notes', 'meeting notes', 'meeting', 'notes', 'minutes', 'agenda', 'recent', 'latest', 'update', 'updates', 'this week', 'last week'];

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
    if (key === 'season' || key === 'rev') {
      filters.season = value.toUpperCase().replace(/^(\d+)$/, 'REV$1');
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

  return { raw: input, cleaned: remaining.join(' ').trim(), filters };
}

function passesFilters(parsed: ParsedQuery, page: PageRecord): boolean {
  const f = parsed.filters;
  if (f.historical !== undefined && page.isHistorical !== f.historical) return false;
  if (f.season) {
    const n = Number(f.season.replace(/\D/g, ''));
    const hay = page.pathText.toLowerCase();
    if (!(page.revNumber === n || hay.includes(f.season.toLowerCase()))) return false;
  }
  if (f.subsystem) {
    const hay = `${page.inferredSubsystem} ${page.pathText}`.toLowerCase();
    if (!hay.includes(f.subsystem)) return false;
  }
  return true;
}

function expandTerms(query: string): Array<{ term: string; weight: number }> {
  const typed = tokenize(query);
  const out = new Map<string, number>();
  for (const t of typed) out.set(t, 1);
  const content = new Set(contentTerms(query));
  const joined = typed.join(' ');
  for (const [acronym, words] of Object.entries(GLOSSARY)) {
    const typedIt =
      content.has(acronym) &&
      (!UPPERCASE_ONLY.has(acronym) || new RegExp(`\\b${acronym.toUpperCase()}\\b`).test(query));
    if (typedIt) {
      for (const w of words) if (!out.has(w)) out.set(w, 0.4);
    } else if (words.length > 1 && joined.includes(words.join(' ')) && !out.has(acronym)) {
      out.set(acronym, 0.8);
    }
  }
  return [...out.entries()].map(([term, weight]) => ({ term, weight }));
}

function vectorTop(loaded: LoadedIndex, q: Float32Array, allowed: Uint8Array, topN: number) {
  const { embeddings, dims, index } = loaded;
  const scored: Array<{ idx: number; score: number }> = [];
  for (let c = 0; c < index.chunks.length; c++) {
    if (!allowed[c]) continue;
    const base = c * dims;
    let dot = 0;
    for (let d = 0; d < dims; d++) dot += q[d]! * embeddings[base + d]!;
    if (dot > 0.15) scored.push({ idx: c, score: dot });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

export interface RankedPage {
  page: PageRecord;
  chunk: ChunkRecord;
  chunkIdx: number;
  score: number;
  semanticScore: number;
  lexicalScore: number;
  titleMatch: number;
}

/** Deterministic ranking (query embedding aside): fused chunk scores → boosted page list. */
export function rankPages(loaded: LoadedIndex, parsed: ParsedQuery, queryEmbedding: Float32Array): RankedPage[] {
  const queryText = parsed.cleaned || parsed.raw;
  const { index } = loaded;

  const allowed = new Uint8Array(index.chunks.length);
  const pageAllowed = new Map<string, boolean>();
  for (let c = 0; c < index.chunks.length; c++) {
    const pid = index.chunks[c]!.pageId;
    let ok = pageAllowed.get(pid);
    if (ok === undefined) {
      const page = loaded.pageById.get(pid);
      ok = page ? passesFilters(parsed, page) : false;
      pageAllowed.set(pid, ok);
    }
    allowed[c] = ok ? 1 : 0;
  }

  const vec = vectorTop(loaded, queryEmbedding, allowed, VECTOR_CANDIDATES);
  const lex = bm25Query(loaded.bm25, expandTerms(queryText), BM25_CANDIDATES * 2)
    .filter((r) => allowed[r.idx])
    .slice(0, BM25_CANDIDATES);

  const vecScore = new Map(vec.map((v) => [v.idx, v.score]));
  const lexScore = new Map(lex.map((l) => [l.idx, l.score]));
  const fused = reciprocalRankFusion([vec.map((v) => String(v.idx)), lex.map((l) => String(l.idx))]);

  // Best chunk per page, with a little credit for a second matching chunk.
  const byPage = new Map<string, { best: number; bestScore: number; second: number }>();
  for (const [key, score] of fused) {
    const idx = Number(key);
    const pid = index.chunks[idx]!.pageId;
    const cur = byPage.get(pid);
    if (!cur) byPage.set(pid, { best: idx, bestScore: score, second: 0 });
    else if (score > cur.bestScore) byPage.set(pid, { best: idx, bestScore: score, second: cur.bestScore });
    else if (score > cur.second) cur.second = score;
  }

  const terms = contentTerms(queryText);
  const q = queryText.toLowerCase();
  const wantsHighLevel = HIGH_LEVEL_HINTS.some((h) => q.includes(h));
  const wantsNotes = NOTES_HINTS.some((h) => q.includes(h));
  const wantsHistorical = /\b(historical|old|older|previous|past|rev\s?\d{1,2}|history)\b/.test(q);

  const ranked: RankedPage[] = [];
  for (const [pid, agg] of byPage) {
    const page = loaded.pageById.get(pid)!;
    const chunk = index.chunks[agg.best]!;
    let score = agg.bestScore + 0.3 * agg.second;

    const titleTokens = new Set(tokenize(page.title));
    const ancestorTokens = new Set(tokenize(page.path.slice(0, -1).join(' ')));
    let titleHits = 0;
    let pathHits = 0;
    for (const t of terms) {
      if (titleTokens.has(t)) titleHits++;
      else if (ancestorTokens.has(t)) pathHits++;
    }
    const titleMatch = terms.length ? titleHits / terms.length : 0;
    const pathMatch = terms.length ? pathHits / terms.length : 0;
    score *= 1 + 0.6 * titleMatch + 0.15 * pathMatch;
    if (terms.length >= 2 && page.title.toLowerCase().includes(terms.join(' '))) score *= 1.25;

    if (page.kind === 'record') score *= 0.75;
    // Older-season pages are usually the wrong answer unless the person asked for history;
    // a page from the current or previous season gets a nudge (last season's docs are often
    // the most complete write-up of a subsystem that carried over).
    if (page.isHistorical) score *= wantsHistorical ? 1.05 : config.app.historicalPenalty;

    const docType = page.inferredDocType;
    if (docType === 'meeting_notes') score *= wantsNotes ? 1.1 : 0.9;
    if (wantsHighLevel && (docType === 'home' || docType === 'overview')) score *= 1.15;

    ranked.push({
      page,
      chunk,
      chunkIdx: agg.best,
      score,
      semanticScore: vecScore.get(agg.best) ?? 0,
      lexicalScore: lexScore.get(agg.best) ?? 0,
      titleMatch,
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

export interface SearchOptions {
  rerank?: boolean;
  topK?: number;
}

export async function searchIndex(loaded: LoadedIndex, rawQuery: string, opts: SearchOptions = {}): Promise<SearchResponse> {
  const parsed = parseQuery(rawQuery);
  const queryText = parsed.cleaned || parsed.raw;
  const topK = opts.topK ?? config.app.topKResults;

  const queryEmbedding = await embedQuery(queryText);
  const ranked = rankPages(loaded, parsed, queryEmbedding);
  if (ranked.length === 0) return { results: [], weak: true };

  let ordered = ranked.slice(0, RERANK_CANDIDATES);
  if (opts.rerank !== false && ordered.length > 1) {
    const order = await rerankResults(
      queryText,
      ordered.map((r) => ({
        pageId: r.page.id,
        title: r.page.title,
        pathText: r.page.path.slice(0, -1).join(' › ') || r.page.source,
        text: r.chunk.text.slice(0, 500),
      }))
    );
    const pos = new Map(order.map((id, i) => [id, i]));
    ordered = ordered.slice().sort((a, b) => (pos.get(a.page.id) ?? 99) - (pos.get(b.page.id) ?? 99));
  }

  const top = ordered.slice(0, topK);
  const best = top[0]!;
  const weak = best.semanticScore < WEAK_COSINE && best.titleMatch < 0.5;

  return {
    weak,
    results: top.map((r) => ({
      page: r.page,
      chunk: r.chunk,
      score: r.score,
      lexicalScore: r.lexicalScore,
      semanticScore: r.semanticScore,
      excerpt: excerptAroundMatch(r.chunk.text, queryText),
    })),
  };
}

/** The best chunk plus its neighbour on the same page, for the answer model. */
export function contextForResult(loaded: LoadedIndex, result: SearchResult, maxChars: number): string {
  // Chunks are stored in page order, so a page's k-th chunk is idxs[k].
  const idxs = loaded.chunkIdxByPage.get(result.page.id) ?? [];
  const parts = [result.chunk.text];
  const next = idxs[result.chunk.chunkIndex + 1];
  if (next !== undefined) parts.push(loaded.index.chunks[next]!.text);
  const joined = parts.join('\n\n');
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined;
}

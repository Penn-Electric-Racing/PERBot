import { readListing } from './extract.js';
import { fetchHtml as defaultFetchHtml } from './fetch.js';
import type { JsonLlm } from './llm.js';
import { applyQty, Scorer } from './rank.js';
import { search as defaultSearch } from './search.js';
import type { Candidate, RankMode, SearchResult } from './types.js';

/** Search → read each listing with the LLM → quantity maths → score → top N. */

export interface FindOptions {
  qty: number;
  top: number;
  /** Search results to read. */
  pool: number;
  mode?: RankMode;
  perSupplier?: number;
  /** Search the text as typed (default adds "price" and "buy …" / "… in stock" top-ups). */
  exact?: boolean;
  llm: JsonLlm;
  scorer?: Scorer;
  /** Pages read at once (the LLM pacer is the real limit). */
  concurrency?: number;
  search?: (query: string, n: number, variants: string[]) => Promise<{ source: string; results: SearchResult[] }>;
  fetchHtml?: (url: string) => Promise<string>;
}

export interface FindResult {
  part: string;
  query: string;
  qty: number;
  source: string;
  llm: string;
  top: Candidate[];
  all: Candidate[];
  stats: { candidates: number; fetched: number; priced: number };
}

/** Like Promise.all(items.map(fn)) with at most `limit` in flight; keeps order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function findParts(part: string, opts: FindOptions): Promise<FindResult> {
  const base = part.trim();
  const query = opts.exact || /\bprice\b/i.test(base) ? base : `${base} price`;
  const variants = opts.exact ? [] : [`buy ${base}`, `${base} in stock`];
  const { source, results } = await (opts.search ?? defaultSearch)(query, opts.pool, variants);

  const fetchHtml = opts.fetchHtml ?? ((url: string) => defaultFetchHtml(url));
  const listings = await mapLimit(results, opts.concurrency ?? 6, (r) => readListing(r, opts.llm, base, fetchHtml));
  const scorer = opts.scorer ?? new Scorer();
  const all = scorer.scoreAll(listings.map((l) => applyQty(l, opts.qty)), base, opts.qty);
  return {
    part: base,
    query,
    qty: opts.qty,
    source,
    llm: opts.llm.label,
    top: scorer.pickTop(all, opts.top, opts.mode ?? 'best', opts.perSupplier ?? 2),
    all,
    stats: {
      candidates: all.length,
      fetched: all.filter((c) => !c.error?.match(/^(HTTP|not a web page|fetch failed)/)).length,
      priced: all.filter((c) => c.subtotal !== null).length,
    },
  };
}

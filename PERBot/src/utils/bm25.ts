import { tokenize } from './text.js';

/**
 * BM25 over an inverted index built once at load time. The previous version re-tokenized
 * every document on every query; with ~15k chunks that was the slow part of `/dt`.
 */
export interface BM25Index {
  docCount: number;
  avgDocLen: number;
  docLen: Float32Array;
  postings: Map<string, { docs: number[]; tfs: number[] }>;
}

const K1 = 1.2;
const B = 0.75;

export function buildBM25Index(docs: string[]): BM25Index {
  const docLen = new Float32Array(docs.length);
  const postings = new Map<string, { docs: number[]; tfs: number[] }>();
  let total = 0;

  for (let i = 0; i < docs.length; i++) {
    const tokens = tokenize(docs[i]!);
    docLen[i] = tokens.length;
    total += tokens.length;
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [term, count] of tf) {
      let p = postings.get(term);
      if (!p) {
        p = { docs: [], tfs: [] };
        postings.set(term, p);
      }
      p.docs.push(i);
      p.tfs.push(count);
    }
  }

  return { docCount: docs.length, avgDocLen: docs.length ? total / docs.length : 0, docLen, postings };
}

export function idf(index: BM25Index, term: string): number {
  const p = index.postings.get(term);
  const df = p ? p.docs.length : 0;
  return Math.log((index.docCount - df + 0.5) / (df + 0.5) + 1);
}

/**
 * Scores every document that contains at least one query term. `weights` lets glossary
 * expansions count for less than the words the person actually typed.
 */
export function bm25Query(
  index: BM25Index,
  terms: Array<{ term: string; weight: number }>,
  topN: number
): Array<{ idx: number; score: number }> {
  const scores = new Map<number, number>();
  for (const { term, weight } of terms) {
    const p = index.postings.get(term);
    if (!p) continue;
    const termIdf = idf(index, term);
    for (let k = 0; k < p.docs.length; k++) {
      const d = p.docs[k]!;
      const tf = p.tfs[k]!;
      const denom = tf + K1 * (1 - B + (B * index.docLen[d]!) / index.avgDocLen);
      const s = termIdf * ((tf * (K1 + 1)) / denom) * weight;
      scores.set(d, (scores.get(d) ?? 0) + s);
    }
  }
  return [...scores.entries()]
    .map(([idx, score]) => ({ idx, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

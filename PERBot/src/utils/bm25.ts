import { tokenize } from './text.js';

export interface BM25Corpus {
  idf: Map<string, number>;
  avgDocLen: number;
}

const K1 = 1.5;
const B = 0.75;

export function buildBM25Corpus(docs: string[]): BM25Corpus {
  const N = docs.length;
  if (N === 0) return { idf: new Map(), avgDocLen: 0 };

  const df = new Map<string, number>();
  let totalLen = 0;

  for (const doc of docs) {
    const tokens = tokenize(doc);
    totalLen += tokens.length;
    for (const term of new Set(tokens)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [term, freq] of df) {
    idf.set(term, Math.log((N - freq + 0.5) / (freq + 0.5) + 1));
  }

  return { idf, avgDocLen: totalLen / N };
}

export function bm25Score(
  queryTerms: string[],
  doc: string,
  corpus: BM25Corpus
): number {
  const tokens = tokenize(doc);
  const docLen = tokens.length;

  const termFreq = new Map<string, number>();
  for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);

  let score = 0;
  for (const term of queryTerms) {
    const tf = termFreq.get(term) ?? 0;
    if (tf === 0) continue;
    const idf = corpus.idf.get(term) ?? 0;
    const numerator = tf * (K1 + 1);
    const denominator = tf + K1 * (1 - B + B * (docLen / corpus.avgDocLen));
    score += idf * (numerator / denominator);
  }

  return score;
}

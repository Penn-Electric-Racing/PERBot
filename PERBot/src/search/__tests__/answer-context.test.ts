import test from 'node:test';
import assert from 'node:assert/strict';
import { contextForResult, interleave, type RankedPage } from '../../services/search.js';
import { assembleIndex } from '../../services/index-store.js';
import type { PageRecord, SearchIndex, SearchResult } from '../../types.js';

function page(id: string): PageRecord {
  return {
    id, source: 'notion', kind: 'doc', title: id, url: `https://notion.so/${id}`, path: [id], pathText: id,
    createdTime: '2025-01-01T00:00:00.000Z', lastEditedTime: '2025-01-01T00:00:00.000Z', revNumber: null,
    docDate: null, isHistorical: false, textLength: 100, inferredBranch: 'unknown', inferredSubsystem: 'unknown',
    inferredDocType: 'unknown',
  };
}

const ranked = (id: string) => ({ page: page(id) }) as unknown as RankedPage;

test('interleave keeps search #1 first, then alternates reranker and search picks without duplicates', () => {
  const fused = ['a', 'b', 'c', 'd'].map(ranked);
  const reranked = ['d', 'a', 'c', 'b'].map((id) => fused.find((r) => r.page.id === id)!);
  assert.deepEqual(interleave(fused, reranked).map((r) => r.page.id), ['a', 'd', 'b', 'c']);
});

/** One page with ten 100-char chunks: chunk k's text is the digit k repeated. */
function tenChunkIndex() {
  const index: SearchIndex = {
    version: 3, generatedAt: '2026-01-01T00:00:00.000Z', currentRev: 'REV12', embeddingModel: 'test', embeddingDims: 4,
    pages: [page('p')],
    chunks: Array.from({ length: 10 }, (_, k) => ({
      id: `p:${k}`, pageId: 'p', chunkIndex: k, heading: null, text: String(k).repeat(100), hash: String(k), scale: 1 / 127,
    })),
  };
  return assembleIndex(index, new Int8Array(10 * 4));
}

function result(loaded: ReturnType<typeof tenChunkIndex>, k: number, second?: number): SearchResult {
  return { page: loaded.index.pages[0]!, chunk: loaded.index.chunks[k]!, secondChunkIndex: second, score: 1, lexicalScore: 0, semanticScore: 0, excerpt: '' };
}

test('contextForResult grows outward from the best chunk, in page order, within the budget', () => {
  const loaded = tenChunkIndex();
  const text = contextForResult(loaded, result(loaded, 5), 350);
  // best (5), then next (6), previous (4) → three chunks fit in 350 chars.
  assert.deepEqual(text.split('\n\n').map((t) => t[0]), ['4', '5', '6']);
});

test('contextForResult includes a distant second-best chunk, marking the gap', () => {
  const loaded = tenChunkIndex();
  const parts = contextForResult(loaded, result(loaded, 1, 8), 350).split('\n\n');
  assert.deepEqual(parts.map((t) => t[0]), ['1', '2', '[', '8']);
});

test('wellFormed drops a surrogate half left by cutting text mid-emoji', async () => {
  const { wellFormed } = await import('../../services/llm.js');
  const cut = 'ok 🔋'.slice(0, 4); // keeps only the high surrogate of the emoji
  assert.equal(wellFormed(cut), 'ok ');
  assert.equal(wellFormed('ok 🔋'), 'ok 🔋');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(wellFormed(cut))));
});

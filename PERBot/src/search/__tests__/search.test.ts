import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, rankPages } from '../../services/search.js';
import { assembleIndex } from '../../services/index-store.js';
import type { PageRecord, SearchIndex } from '../../types.js';

function page(id: string, title: string, path: string[], extra: Partial<PageRecord> = {}): PageRecord {
  return {
    id,
    source: 'notion',
    kind: 'doc',
    title,
    url: `https://notion.so/${id}`,
    path: [...path, title],
    pathText: [...path, title].join(' › '),
    createdTime: '2025-01-01T00:00:00.000Z',
    lastEditedTime: '2025-01-01T00:00:00.000Z',
    revNumber: null,
    docDate: null,
    isHistorical: false,
    textLength: 100,
    inferredBranch: 'unknown',
    inferredSubsystem: 'unknown',
    inferredDocType: 'unknown',
    ...extra,
  };
}

/** Three tiny 4-d "embeddings" so vector and lexical signals can be controlled independently. */
function fixture(): SearchIndex {
  return {
    version: 3,
    generatedAt: '2026-01-01T00:00:00.000Z',
    currentRev: 'REV12',
    embeddingModel: 'test',
    embeddingDims: 4,
    pages: [
      page('pcm11', 'REV11 PCM Documentation', ['Electrical', 'PCM'], { revNumber: 11 }),
      page('pcm8', 'PCM REV8', ['Electrical', 'Archive'], { revNumber: 8, isHistorical: true }),
      page('meet', '11/5 Mechanical Meeting', ['Mechanical'], { inferredDocType: 'meeting_notes' }),
    ],
    chunks: [
      { id: 'pcm11:0', pageId: 'pcm11', chunkIndex: 0, heading: null, text: 'The PCM translates pedal inputs into torque requests.', hash: 'a', scale: 1 / 127 },
      { id: 'pcm8:0', pageId: 'pcm8', chunkIndex: 0, heading: null, text: 'The PCM senses brake angle and requests negative torque.', hash: 'b', scale: 1 / 127 },
      { id: 'meet:0', pageId: 'meet', chunkIndex: 0, heading: null, text: 'PCM box wiring was discussed; epoxy ordered.', hash: 'c', scale: 1 / 127 },
    ],
  };
}

const EMB = Int8Array.from([127, 0, 0, 0, 114, 13, 0, 0, 102, 25, 0, 0]);

test('parseQuery pulls out filters', () => {
  const p = parseQuery('rev:11 subsystem:PCM historical:false torque requests');
  assert.deepEqual(p.filters, { season: 'REV11', subsystem: 'pcm', historical: false });
  assert.equal(p.cleaned, 'torque requests');
  assert.equal(parseQuery('season:12 x').filters.season, 'REV12');
});

test('current doc outranks historical and meeting notes for the same topic', () => {
  const loaded = assembleIndex(fixture(), EMB);
  const q = new Float32Array([1, 0, 0, 0]);
  const ranked = rankPages(loaded, parseQuery('tell me about PCM'), q);
  assert.equal(ranked[0]!.page.id, 'pcm11');
  assert.ok(ranked.find((r) => r.page.id === 'pcm8')!.score < ranked[0]!.score);
});

test('filters restrict candidates', () => {
  const loaded = assembleIndex(fixture(), EMB);
  const q = new Float32Array([1, 0, 0, 0]);
  const ranked = rankPages(loaded, parseQuery('historical:true PCM'), q);
  assert.deepEqual(ranked.map((r) => r.page.id), ['pcm8']);
  const rev = rankPages(loaded, parseQuery('rev:11 PCM'), q);
  assert.deepEqual(rev.map((r) => r.page.id), ['pcm11']);
});

test('a title hit beats a body-only hit', () => {
  const loaded = assembleIndex(fixture(), EMB);
  // Same vector similarity for everyone; only the lexical/title signals differ.
  const q = new Float32Array([0.7, 0.7, 0, 0]);
  const ranked = rankPages(loaded, parseQuery('mechanical meeting'), q);
  assert.equal(ranked[0]!.page.id, 'meet');
});

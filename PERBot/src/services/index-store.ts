import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { buildBM25Index, type BM25Index } from '../utils/bm25.js';
import { buildEmbedText } from '../utils/chunk.js';
import type { BuildCache, IndexStatus, PageRecord, SearchIndex } from '../types.js';

/**
 * On-disk layout (both gzipped when uploaded to the GitHub release):
 *   data/index.json      pages + chunks (text, no vectors)
 *   data/embeddings.f32  one little-endian Float32Array, chunk i at [i*dims, (i+1)*dims)
 *   data/build-cache.json raw Notion markdown per page (indexer only)
 *
 * Splitting vectors out keeps the JSON small enough to parse (the old combined file passed
 * Node's max string length) and lets the bot hold everything in memory: ~15k chunks × 1536
 * floats ≈ 90 MB.
 */
export interface LoadedIndex {
  index: SearchIndex;
  embeddings: Float32Array;
  dims: number;
  pageById: Map<string, PageRecord>;
  /** Chunk positions (into index.chunks / embeddings) for each page, in page order. */
  chunkIdxByPage: Map<string, number[]>;
  bm25: BM25Index;
  loadedAt: string;
}

let cached: LoadedIndex | null = null;

export function getLoadedIndex(): LoadedIndex | null {
  return cached;
}

export function setLoadedIndex(loaded: LoadedIndex | null): void {
  cached = loaded;
}

let tempCounter = 0;

/** Unique temp name per call so concurrent writers (status updates) never race on one file. */
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${++tempCounter}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value), 'utf8');
  await fs.rename(tempPath, filePath);
}

export async function saveIndex(index: SearchIndex, embeddings: Float32Array): Promise<void> {
  if (embeddings.length !== index.chunks.length * index.embeddingDims) {
    throw new Error(
      `Embedding buffer has ${embeddings.length} floats; expected ${index.chunks.length} × ${index.embeddingDims}.`
    );
  }
  await writeJsonAtomic(config.app.indexPath, index);
  await fs.mkdir(path.dirname(config.app.embeddingsPath), { recursive: true });
  const tempPath = `${config.app.embeddingsPath}.tmp`;
  await fs.writeFile(tempPath, Buffer.from(embeddings.buffer, embeddings.byteOffset, embeddings.byteLength));
  await fs.rename(tempPath, config.app.embeddingsPath);
}

export async function readIndexFiles(
  indexPath = config.app.indexPath,
  embeddingsPath = config.app.embeddingsPath
): Promise<{ index: SearchIndex; embeddings: Float32Array }> {
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8')) as SearchIndex;
  if (index.version !== 2) {
    throw new Error(`Unsupported index version ${String((index as { version?: unknown }).version)}; expected 2.`);
  }
  const raw = await fs.readFile(embeddingsPath);
  // Copy into a fresh, aligned Float32Array (a Buffer's byteOffset is not guaranteed to be 4-aligned).
  const embeddings = new Float32Array(raw.byteLength / 4);
  Buffer.from(embeddings.buffer).set(raw);
  const expected = index.chunks.length * index.embeddingDims;
  if (embeddings.length !== expected) {
    throw new Error(`Embeddings file has ${embeddings.length} floats; index expects ${expected}.`);
  }
  return { index, embeddings };
}

export function assembleIndex(index: SearchIndex, embeddings: Float32Array): LoadedIndex {
  const pageById = new Map(index.pages.map((p) => [p.id, p]));
  const chunkIdxByPage = new Map<string, number[]>();
  const lexicalDocs: string[] = new Array(index.chunks.length);

  for (let i = 0; i < index.chunks.length; i++) {
    const chunk = index.chunks[i]!;
    const arr = chunkIdxByPage.get(chunk.pageId);
    if (arr) arr.push(i);
    else chunkIdxByPage.set(chunk.pageId, [i]);
    const page = pageById.get(chunk.pageId);
    lexicalDocs[i] = page
      ? buildEmbedText(page.title, page.path.slice(0, -1), chunk.heading, chunk.text)
      : chunk.text;
  }

  return {
    index,
    embeddings,
    dims: index.embeddingDims,
    pageById,
    chunkIdxByPage,
    bm25: buildBM25Index(lexicalDocs),
    loadedAt: new Date().toISOString(),
  };
}

/** Reads the index files, builds the in-memory structures, and caches the result. */
export async function loadIndex(): Promise<LoadedIndex> {
  const { index, embeddings } = await readIndexFiles();
  const loaded = assembleIndex(index, embeddings);
  cached = loaded;
  return loaded;
}

export async function indexExists(): Promise<boolean> {
  try {
    await fs.access(config.app.indexPath);
    await fs.access(config.app.embeddingsPath);
    return true;
  } catch {
    return false;
  }
}

export async function loadBuildCache(): Promise<BuildCache> {
  try {
    const raw = await fs.readFile(config.app.buildCachePath, 'utf8');
    const parsed = JSON.parse(raw) as BuildCache;
    if (parsed.version === 1 && parsed.pages) return parsed;
  } catch {
    // no cache yet
  }
  return { version: 1, pages: {} };
}

export async function saveBuildCache(cache: BuildCache): Promise<void> {
  await writeJsonAtomic(config.app.buildCachePath, cache);
}

export async function loadStatus(): Promise<IndexStatus | null> {
  try {
    const raw = await fs.readFile(config.app.statusPath, 'utf8');
    return JSON.parse(raw) as IndexStatus;
  } catch {
    return null;
  }
}

export async function saveStatus(status: IndexStatus): Promise<void> {
  await writeJsonAtomic(config.app.statusPath, status);
}

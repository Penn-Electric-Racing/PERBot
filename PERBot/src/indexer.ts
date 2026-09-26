import { createHash } from 'node:crypto';
import { config } from './config.js';
import { NotionService, type IndexableDocument } from './services/notion.js';
import { downloadBuildInputsFromRelease } from './services/index-downloader.js';
import {
  indexExists,
  loadBuildCache,
  readIndexFiles,
  saveBuildCache,
  saveIndex,
  saveStatus,
} from './services/index-store.js';
import { buildEmbedText, chunkMarkdown } from './utils/chunk.js';
import { extractDocDate, extractRevNumber } from './utils/notionText.js';
import { logger } from './utils/logger.js';
import { embedTexts } from './services/llm.js';
import type {
  ChunkRecord,
  InferredBranch,
  InferredDocType,
  InferredSubsystem,
  PageRecord,
  SearchIndex,
} from './types.js';

/**
 * Nightly index build. Incremental by default: the previous release's raw-markdown cache skips
 * the Notion fetch for unchanged pages, and its embeddings are reused for any chunk whose
 * embedded text is byte-identical (matched by sha1). A first run from nothing embeds everything.
 */

function normalize(text: string): string {
  return text.toLowerCase();
}

function inferBranch(pathText: string): InferredBranch {
  const joined = normalize(pathText);
  if (joined.includes('mechanical')) return 'mechanical';
  if (joined.includes('electrical')) return 'electrical';
  if (joined.includes('operations') || joined.includes('sponsorship') || joined.includes('business')) return 'operations';
  if (joined.includes('software') || joined.includes('firmware')) return 'software';
  if (joined.includes('general')) return 'general';
  return 'unknown';
}

function inferSubsystem(pathText: string, head: string): InferredSubsystem {
  const joined = normalize(`${pathText} ${head}`);
  const padded = ` ${joined} `;

  if (joined.includes('accumulator') || joined.includes('tractive system accumulator') || padded.includes(' tsa ')) return 'accumulator';
  if (joined.includes('aero') || joined.includes('composites')) return 'aero';
  if (joined.includes('chassis')) return 'chassis';
  if (joined.includes('drivetrain')) return 'drivetrain';
  if (joined.includes('suspension')) return 'suspension';
  if (joined.includes('vehicle dynamics')) return 'vehicle dynamics';
  if (joined.includes('cooling') || joined.includes('thermal') || joined.includes('radiator')) return 'cooling';
  if (joined.includes('driver interface') || joined.includes('cockpit') || joined.includes('pedal') || joined.includes('steering')) return 'driver interface';
  if (joined.includes('daqdash') || joined.includes('daq-dash') || padded.includes(' daq ')) return 'daqdash';
  if (padded.includes(' pcm ')) return 'pcm';
  if (joined.includes('high voltage') || padded.includes(' hv ')) return 'hv';
  if (joined.includes('low voltage') || padded.includes(' lv ')) return 'lv';

  const branch = inferBranch(pathText);
  if (branch === 'mechanical') return 'general';
  if (branch === 'electrical') return 'electrical';
  if (branch === 'operations') return 'operations';
  if (branch === 'software') return 'software';
  return 'unknown';
}

function inferDocType(title: string, pathText: string, head: string): InferredDocType {
  const t = normalize(title);
  const joined = normalize(`${pathText} ${head}`);

  if (/\b(meeting|minutes|agenda|weekly update|updates?)\b/.test(t) || /\b\d{1,2}\/\d{1,2}\b/.test(t)) return 'meeting_notes';
  if (t === 'home' || t.endsWith(' home') || t.startsWith('home ')) return 'home';
  if (/\b(overview|intro|introduction|wiki|guide|readme|summary|how[- ]to|tutorial)\b/.test(t)) return 'overview';
  if (/\b(bom|bill of materials)\b/.test(t)) return 'bom';
  if (/\b(testing log|test log|testing logs)\b/.test(t)) return 'testing_logs';
  if (/\b(q&a|qa|questions|faq)\b/.test(t)) return 'qa';
  if (/\b(spec|specification|requirements)\b/.test(t)) return 'spec';
  if (/\b(design|architecture|packaging|cad|documentation|schematic)\b/.test(joined)) return 'design';
  if (joined.includes('general')) return 'general';
  return 'unknown';
}

/**
 * "Historical" = older than last season. The current REV is in progress for most of the year, so
 * last season's docs are usually the most complete write-up of anything that carried over and
 * must not be penalized; REV(n-2) and older are.
 */
function isHistorical(pathText: string, revNumber: number | null, currentRev: number | null): boolean {
  if (currentRev !== null && revNumber !== null && revNumber < currentRev - 1) return true;
  return /\b(archive|archived|historical|legacy|old season|deprecated|old)\b/i.test(pathText);
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

function toPageRecord(doc: IndexableDocument, currentRev: number | null): PageRecord {
  const path = [...doc.ancestors, doc.page.title];
  const pathText = path.join(' › ');
  const head = doc.cleanText.slice(0, 500);
  const revNumber = extractRevNumber(doc.page.title, pathText, head);
  return {
    id: doc.page.id,
    source: 'notion',
    kind: doc.kind,
    title: doc.page.title,
    url: doc.page.url,
    path,
    pathText,
    createdTime: doc.page.createdTime,
    lastEditedTime: doc.page.lastEditedTime,
    revNumber,
    docDate: extractDocDate(doc.page.title),
    isHistorical: isHistorical(pathText, revNumber, currentRev),
    textLength: doc.cleanText.length,
    inferredBranch: inferBranch(pathText),
    inferredSubsystem: inferSubsystem(pathText, head),
    inferredDocType: inferDocType(doc.page.title, pathText, head),
  };
}

async function loadPreviousEmbeddings(): Promise<Map<string, Float32Array>> {
  const reuse = new Map<string, Float32Array>();
  if (!config.app.indexIncremental) return reuse;
  if (!(await indexExists())) await downloadBuildInputsFromRelease();
  if (!(await indexExists())) return reuse;
  try {
    const { index, embeddings } = await readIndexFiles();
    if (index.embeddingModel !== config.openai.embeddingModel) {
      logger.info(`Previous index used ${index.embeddingModel}; re-embedding everything with ${config.openai.embeddingModel}.`);
      return reuse;
    }
    const dims = index.embeddingDims;
    for (let i = 0; i < index.chunks.length; i++) {
      reuse.set(index.chunks[i]!.hash, embeddings.subarray(i * dims, (i + 1) * dims));
    }
    logger.info(`Loaded ${reuse.size} previous embeddings for reuse.`);
  } catch (err) {
    logger.warn('Previous index unreadable; re-embedding everything.', err);
  }
  return reuse;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  logger.info('Starting PERBot Notion indexing job...');
  await saveStatus({ state: 'indexing', phase: 'discovering', startedAt });

  const previous = await loadPreviousEmbeddings();
  const cache = config.app.indexIncremental ? await loadBuildCache() : { version: 1 as const, pages: {} };

  const notion = new NotionService();
  await saveStatus({ state: 'indexing', phase: 'building_pages', startedAt });
  const { docs, cache: nextCache } = await notion.buildIndexableDocuments(cache);
  await saveBuildCache(nextCache);

  await saveStatus({ state: 'indexing', phase: 'chunking', startedAt, totalPages: docs.length });
  const currentRevNumber = Number(config.app.currentRev.replace(/\D/g, '')) || null;
  const pages: PageRecord[] = [];
  const chunks: ChunkRecord[] = [];
  const embedInputs: string[] = [];

  for (const doc of docs) {
    const page = toPageRecord(doc, currentRevNumber);
    const pieces = chunkMarkdown(doc.cleanText, {
      target: config.app.chunkTargetChars,
      max: config.app.chunkMaxChars,
      min: config.app.chunkMinChars,
    });
    if (pieces.length === 0) continue;
    pages.push(page);
    pieces.forEach((piece, chunkIndex) => {
      const embedText = buildEmbedText(page.title, doc.ancestors, piece.heading, piece.text);
      chunks.push({
        id: `${page.id}:${chunkIndex}`,
        pageId: page.id,
        chunkIndex,
        heading: piece.heading,
        text: piece.text,
        hash: sha1(embedText),
      });
      embedInputs.push(embedText);
    });
  }
  logger.info(`Prepared ${chunks.length} chunks from ${pages.length} pages.`);

  // Reuse what we can, embed the rest.
  const dims = previous.size ? previous.values().next().value!.length : 0;
  const toEmbed: number[] = [];
  const vectors: Array<Float32Array | null> = chunks.map((c) => previous.get(c.hash) ?? null);
  vectors.forEach((v, i) => {
    if (!v) toEmbed.push(i);
  });
  const reused = chunks.length - toEmbed.length;
  logger.info(`Reusing ${reused} embeddings; embedding ${toEmbed.length} new chunks.`);
  await saveStatus({
    state: 'indexing',
    phase: 'embedding',
    startedAt,
    totalPages: pages.length,
    totalChunks: chunks.length,
    reusedEmbeddings: reused,
    totalChunkBatches: Math.ceil(toEmbed.length / 100),
    embeddedChunkBatches: 0,
  });

  const fresh = await embedTexts(
    toEmbed.map((i) => embedInputs[i]!),
    (done, total) => {
      logger.info(`Embedded batch ${done} / ${total}`);
      if (done % 10 !== 0 && done !== total) return;
      saveStatus({
        state: 'indexing',
        phase: 'embedding',
        startedAt,
        totalPages: pages.length,
        totalChunks: chunks.length,
        reusedEmbeddings: reused,
        totalChunkBatches: total,
        embeddedChunkBatches: done,
      }).catch((err) => logger.warn('Could not write index status.', err));
    }
  );
  toEmbed.forEach((chunkIdx, k) => {
    vectors[chunkIdx] = fresh[k]!;
  });

  const finalDims = dims || (vectors.find(Boolean)?.length ?? 0);
  if (!finalDims) throw new Error('No embeddings produced.');
  const embeddings = new Float32Array(chunks.length * finalDims);
  vectors.forEach((v, i) => {
    if (!v || v.length !== finalDims) throw new Error(`Chunk ${i} has no embedding of the expected size.`);
    embeddings.set(v, i * finalDims);
  });

  await saveStatus({ state: 'indexing', phase: 'saving', startedAt, totalPages: pages.length, totalChunks: chunks.length });
  const index: SearchIndex = {
    version: 2,
    generatedAt: new Date().toISOString(),
    currentRev: config.app.currentRev,
    embeddingModel: config.openai.embeddingModel,
    embeddingDims: finalDims,
    pages,
    chunks,
  };
  await saveIndex(index, embeddings);
  await saveStatus({
    state: 'ready',
    phase: 'complete',
    startedAt,
    completedAt: new Date().toISOString(),
    generatedAt: index.generatedAt,
    indexedPages: pages.length,
    indexedChunks: chunks.length,
    reusedEmbeddings: reused,
  });
  logger.info(`Saved PERBot index (${pages.length} pages, ${chunks.length} chunks) to ${config.app.indexPath}`);
}

main().catch(async (error) => {
  logger.error('Indexing failed.', error);
  await saveStatus({ state: 'error', phase: 'error', failedAt: new Date().toISOString(), lastError: String((error as Error)?.stack ?? error) });
  process.exitCode = 1;
});

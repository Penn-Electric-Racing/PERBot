import { config, hasOpenAI } from './config.js';
import { NotionService } from './services/notion.js';
import { loadIndex, saveIndex, saveStatus } from './services/index-store.js';
import { chunkText, sleep } from './utils/chunk.js';
import { logger } from './utils/logger.js';
import { embedTexts } from './services/llm.js';
import type { IndexStatus, NotionChunkRecord, NotionIndex } from './types.js';

const INDEXER_EMBED_BATCH_SIZE = 10;
const INDEXER_EMBED_BATCH_DELAY_MS = 2000;

function statusBase(phase: IndexStatus['phase'], message: string): IndexStatus {
  return {
    phase,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pid: process.pid,
    message,
  };
}

async function updateStatus(patch: Partial<IndexStatus>): Promise<void> {
  const now = new Date().toISOString();
  const current: IndexStatus = {
    ...(statusBase('building_pages', 'Starting indexing job...')),
    ...patch,
    updatedAt: now,
  };
  await saveStatus(current);
}

async function buildEmbeddings(index: NotionIndex): Promise<void> {
  const chunks = index.chunks;
  if (!hasOpenAI() || chunks.length === 0) {
    logger.warn(
      'OPENAI_API_KEY not found, so index chunks will be stored without embeddings. Search will still work lexically.'
    );
    return;
  }

  const unembeddedIndices: number[] = [];
  chunks.forEach((chunk, idx) => {
    if (!chunk.embedding) unembeddedIndices.push(idx);
  });

  const totalBatches = Math.ceil(unembeddedIndices.length / INDEXER_EMBED_BATCH_SIZE);
  let completedBatches = 0;

  await updateStatus({
    ...statusBase('embedding', 'Embedding PERBot chunk vectors...'),
    totalPages: index.pages.length,
    totalChunks: chunks.length,
    embeddedChunkBatches: completedBatches,
    totalChunkBatches: totalBatches,
    generatedAt: index.generatedAt,
  });

  for (let i = 0; i < unembeddedIndices.length; i += INDEXER_EMBED_BATCH_SIZE) {
    const batchIndices = unembeddedIndices.slice(i, i + INDEXER_EMBED_BATCH_SIZE);
    const texts = batchIndices.map((chunkIndex) => chunks[chunkIndex].text);
    const vectors = await embedTexts(texts);

    batchIndices.forEach((chunkIndex, indexInBatch) => {
      chunks[chunkIndex].embedding = vectors[indexInBatch];
    });

    completedBatches += 1;
    logger.info(`Embedded chunk batch ${completedBatches} / ${totalBatches}`);

    if (
      completedBatches % config.app.saveCheckpointEveryBatches === 0 ||
      completedBatches === totalBatches
    ) {
      index.generatedAt = new Date().toISOString();
      await saveIndex(index);
      await updateStatus({
        ...statusBase('embedding', 'Embedding PERBot chunk vectors...'),
        totalPages: index.pages.length,
        totalChunks: chunks.length,
        embeddedChunkBatches: completedBatches,
        totalChunkBatches: totalBatches,
        generatedAt: index.generatedAt,
      });
      logger.info(`Checkpoint saved at batch ${completedBatches} / ${totalBatches}`);
    }

    if (i + INDEXER_EMBED_BATCH_SIZE < unembeddedIndices.length) {
      await sleep(INDEXER_EMBED_BATCH_DELAY_MS);
    }
  }
}

async function main(): Promise<void> {
  logger.info('Starting PERBot Notion indexing job...');
  await updateStatus(statusBase('building_pages', 'Fetching pages from Notion...'));

  const notion = new NotionService();
  const pages = await notion.buildIndexablePages();

  const chunks: NotionChunkRecord[] = [];
  for (const page of pages) {
    const pageChunks = chunkText(
      page.markdown,
      config.app.maxChunkChars,
      config.app.chunkOverlapChars
    );
    pageChunks.forEach((text, chunkIndex) => {
      chunks.push({
        id: `${page.id}:${chunkIndex}`,
        pageId: page.id,
        chunkIndex,
        text,
      });
    });
  }

  logger.info(`Prepared ${chunks.length} chunks from ${pages.length} pages.`);

  const freshIndex: NotionIndex = {
    generatedAt: new Date().toISOString(),
    currentRev: config.app.currentRev,
    pages,
    chunks,
  };

  await saveIndex(freshIndex);
  logger.info(`Saved lexical PERBot index checkpoint to ${config.app.indexPath}`);

  await updateStatus({
    ...statusBase('embedding', 'Lexical index ready. Building embeddings...'),
    totalPages: pages.length,
    totalChunks: chunks.length,
    embeddedChunkBatches: 0,
    totalChunkBatches: Math.ceil(chunks.length / INDEXER_EMBED_BATCH_SIZE),
    generatedAt: freshIndex.generatedAt,
  });

  const index = await loadIndex();
  await buildEmbeddings(index);

  index.generatedAt = new Date().toISOString();
  await saveIndex(index);
  await saveStatus({
    phase: 'complete',
    startedAt: undefined,
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    totalPages: index.pages.length,
    totalChunks: index.chunks.length,
    embeddedChunkBatches: Math.ceil(index.chunks.length / INDEXER_EMBED_BATCH_SIZE),
    totalChunkBatches: Math.ceil(index.chunks.length / INDEXER_EMBED_BATCH_SIZE),
    generatedAt: index.generatedAt,
    message: 'Index complete and saved.',
    pid: process.pid,
  });
  logger.info(`Saved PERBot index to ${config.app.indexPath}`);
}

main().catch(async (error) => {
  logger.error('Indexing failed.', error);
  await saveStatus({
    phase: 'failed',
    updatedAt: new Date().toISOString(),
    failedAt: new Date().toISOString(),
    lastError: error instanceof Error ? error.stack || error.message : String(error),
    message: 'Indexing failed.',
    pid: process.pid,
  });
  process.exitCode = 1;
});

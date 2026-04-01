import { config, hasOpenAI } from './config.js';
import { NotionService } from './services/notion.js';
import { saveIndex } from './services/index-store.js';
import { chunkText } from './utils/chunk.js';
import { logger } from './utils/logger.js';
import { embedTexts } from './services/llm.js';
import type { NotionChunkRecord, NotionIndex } from './types.js';

const INDEXER_EMBED_BATCH_SIZE = 20;
const INDEXER_EMBED_BATCH_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildEmbeddings(chunks: NotionChunkRecord[]): Promise<void> {
  if (!hasOpenAI() || chunks.length === 0) {
    logger.warn(
      'OPENAI_API_KEY not found, so index chunks will be stored without embeddings. Search will still work lexically.'
    );
    return;
  }

  for (let i = 0; i < chunks.length; i += INDEXER_EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + INDEXER_EMBED_BATCH_SIZE);
    const vectors = await embedTexts(batch.map((item) => item.text));

    batch.forEach((chunk, index) => {
      chunk.embedding = vectors[index];
    });

    const batchNumber = Math.floor(i / INDEXER_EMBED_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(chunks.length / INDEXER_EMBED_BATCH_SIZE);
    logger.info(`Embedded chunk batch ${batchNumber} / ${totalBatches}`);

    if (i + INDEXER_EMBED_BATCH_SIZE < chunks.length) {
      await sleep(INDEXER_EMBED_BATCH_DELAY_MS);
    }
  }
}

async function main(): Promise<void> {
  logger.info('Starting PERBot Notion indexing job...');
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
  await buildEmbeddings(chunks);

  const index: NotionIndex = {
    generatedAt: new Date().toISOString(),
    currentRev: config.app.currentRev,
    pages,
    chunks,
  };

  await saveIndex(index);
  logger.info(`Saved PERBot index to ${config.app.indexPath}`);
}

main().catch((error) => {
  logger.error('Indexing failed.', error);
  process.exitCode = 1;
});

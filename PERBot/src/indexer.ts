import { config } from './config.js';
import { NotionService } from './services/notion.js';
import { saveIndex } from './services/index-store.js';
import { chunkText } from './utils/chunk.js';
import { logger } from './utils/logger.js';
import { embedTexts } from './services/llm.js';
import type {
  InferredBranch,
  InferredDocType,
  InferredSubsystem,
  NotionChunkRecord,
  NotionIndex,
  NotionPageRecord,
} from './types.js';

const INDEXER_EMBED_BATCH_SIZE = 20;
const INDEXER_EMBED_BATCH_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(text: string): string {
  return text.toLowerCase();
}

function joinPath(path: string[]): string {
  return path.join(' > ');
}

function inferBranch(page: { title: string; path: string[] }): InferredBranch {
  const joined = normalize(`${page.title} ${page.path.join(' ')}`);

  if (joined.includes('mechanical')) return 'mechanical';
  if (joined.includes('electrical')) return 'electrical';
  if (joined.includes('operations')) return 'operations';
  if (joined.includes('software')) return 'software';
  if (joined.includes('general')) return 'general';

  return 'unknown';
}

function inferSubsystem(page: { title: string; path: string[]; markdown: string }): InferredSubsystem {
  const joined = normalize(`${page.title} ${page.path.join(' ')} ${page.markdown.slice(0, 2000)}`);

  if (joined.includes('accumulator') || joined.includes('tractive system accumulator') || joined.includes('tsa')) {
    return 'accumulator';
  }
  if (joined.includes('aero/composites') || joined.includes('aero') || joined.includes('composites')) {
    return 'aero';
  }
  if (joined.includes('chassis')) {
    return 'chassis';
  }
  if (joined.includes('drivetrain')) {
    return 'drivetrain';
  }
  if (joined.includes('suspension')) {
    return 'suspension';
  }
  if (joined.includes('vehicle dynamics')) {
    return 'vehicle dynamics';
  }
  if (joined.includes('cooling') || joined.includes('thermal') || joined.includes('radiator')) {
    return 'cooling';
  }
  if (joined.includes('driver interface') || joined.includes('cockpit') || joined.includes('pedal') || joined.includes('steering')) {
    return 'driver interface';
  }
  if (joined.includes('daqdash')) {
    return 'daqdash';
  }
  if (joined.includes('pcm')) {
    return 'pcm';
  }
  if (joined.includes('high voltage') || joined.includes(' hv ') || joined.startsWith('hv ') || joined.includes(' hv/')) {
    return 'hv';
  }
  if (joined.includes('low voltage') || joined.includes(' lv ') || joined.startsWith('lv ')) {
    return 'lv';
  }

  const branch = inferBranch(page);
  if (branch === 'mechanical') return 'general';
  if (branch === 'electrical') return 'electrical';
  if (branch === 'operations') return 'operations';
  if (branch === 'software') return 'software';

  return 'unknown';
}

function inferDocType(page: { title: string; path: string[]; markdown: string }): InferredDocType {
  const joined = normalize(`${page.title} ${page.path.join(' ')} ${page.markdown.slice(0, 1200)}`);

  if (joined.includes('home')) return 'home';
  if (
    joined.includes('overview') ||
    joined.includes('intro') ||
    joined.includes('introduction') ||
    joined.includes('wiki') ||
    joined.includes('guide') ||
    joined.includes('readme')
  ) {
    return 'overview';
  }
  if (
    joined.includes('design') ||
    joined.includes('architecture') ||
    joined.includes('packaging') ||
    joined.includes('cad')
  ) {
    return 'design';
  }
  if (
    joined.includes('spec') ||
    joined.includes('specification') ||
    joined.includes('requirements')
  ) {
    return 'spec';
  }
  if (
    joined.includes('meeting') ||
    joined.includes('notes') ||
    joined.includes('minutes') ||
    joined.includes('agenda') ||
    joined.includes('sync') ||
    joined.includes('update')
  ) {
    return 'meeting_notes';
  }
  if (joined.includes('bom')) return 'bom';
  if (joined.includes('testing logs') || joined.includes('test log')) return 'testing_logs';
  if (joined.includes('q&a') || joined.includes('qa') || joined.includes('questions')) return 'qa';

  if (joined.includes('general')) return 'general';
  return 'unknown';
}

function enrichPageMetadata(page: {
  id: string;
  title: string;
  url: string;
  path: string[];
  createdTime: string;
  lastEditedTime: string;
  markdown: string;
  isHistorical: boolean;
  snippet?: string;
}): NotionPageRecord {
  return {
    ...page,
    pathText: joinPath(page.path),
    inferredBranch: inferBranch(page),
    inferredSubsystem: inferSubsystem(page),
    inferredDocType: inferDocType(page),
  };
}

function normalizeEmbedding(vec: number[]): number[] {
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vec;
  return vec.map((v) => v / magnitude);
}

async function buildEmbeddings(chunks: NotionChunkRecord[]): Promise<void> {
  if (chunks.length === 0) return;

  for (let i = 0; i < chunks.length; i += INDEXER_EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + INDEXER_EMBED_BATCH_SIZE);
    const vectors = await embedTexts(batch.map((item) => item.text));

    batch.forEach((chunk, index) => {
      const raw = vectors[index];
      chunk.embedding = raw ? normalizeEmbedding(raw) : undefined;
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

  const rawPages = await notion.buildIndexablePages();
  const pages: NotionPageRecord[] = rawPages.map(enrichPageMetadata);

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

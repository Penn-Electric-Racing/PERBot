import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type { IndexStatus, NotionIndex } from '../types.js';

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value), 'utf8');
  await fs.rename(tempPath, filePath);
}

export async function loadIndex(): Promise<NotionIndex> {
  const raw = await fs.readFile(config.app.indexPath, 'utf8');
  return JSON.parse(raw) as NotionIndex;
}

// Streams chunks one at a time to avoid JSON.stringify's string length limit.
// Pretty-printing a 19k-chunk index with 1536-dim embeddings produces a string
// large enough to exceed V8's kMaxLength (~1GB).
export async function saveIndex(index: NotionIndex): Promise<void> {
  await fs.mkdir(path.dirname(config.app.indexPath), { recursive: true });
  const tempPath = `${config.app.indexPath}.tmp`;

  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(tempPath);
    ws.on('finish', resolve);
    ws.on('error', reject);

    ws.write(`{"generatedAt":${JSON.stringify(index.generatedAt)}`);
    ws.write(`,"currentRev":${JSON.stringify(index.currentRev)}`);
    ws.write(`,"pages":${JSON.stringify(index.pages)}`);
    ws.write(`,"chunks":[`);
    for (let i = 0; i < index.chunks.length; i++) {
      if (i > 0) ws.write(',');
      ws.write(JSON.stringify(index.chunks[i]));
    }
    ws.write(']}');
    ws.end();
  });

  await fs.rename(tempPath, config.app.indexPath);
}

export async function indexExists(): Promise<boolean> {
  try {
    await fs.access(config.app.indexPath);
    return true;
  } catch {
    return false;
  }
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

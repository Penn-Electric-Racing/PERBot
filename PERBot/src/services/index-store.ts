import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { IndexStatus, NotionIndex } from '../types.js';

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tempPath, filePath);
}

export async function loadIndex(): Promise<NotionIndex> {
  const raw = await fs.readFile(config.app.indexPath, 'utf8');
  return JSON.parse(raw) as NotionIndex;
}

export async function saveIndex(index: NotionIndex): Promise<void> {
  await writeJsonAtomic(config.app.indexPath, index);
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

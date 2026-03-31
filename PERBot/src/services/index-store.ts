import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { NotionIndex } from '../types.js';

export async function loadIndex(): Promise<NotionIndex> {
  const raw = await fs.readFile(config.app.indexPath, 'utf8');
  return JSON.parse(raw) as NotionIndex;
}

export async function saveIndex(index: NotionIndex): Promise<void> {
  await fs.mkdir(path.dirname(config.app.indexPath), { recursive: true });
  await fs.writeFile(config.app.indexPath, JSON.stringify(index, null, 2), 'utf8');
}

export async function indexExists(): Promise<boolean> {
  try {
    await fs.access(config.app.indexPath);
    return true;
  } catch {
    return false;
  }
}

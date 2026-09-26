import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const GITHUB_API = 'https://api.github.com';

export const RELEASE_ASSETS = {
  index: 'index.json.gz',
  embeddings: 'embeddings.f32.gz',
  buildCache: 'build-cache.json.gz',
} as const;

interface ReleaseAsset {
  id: number;
  name: string;
  updated_at: string;
}

interface Release {
  assets: ReleaseAsset[];
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': 'PERBot',
    'X-GitHub-Api-Version': '2022-11-28',
    Accept: 'application/vnd.github+json',
  };
  // The repo is public, so the token is optional; it only raises the rate limit.
  if (config.github.token) h.Authorization = `Bearer ${config.github.token}`;
  return h;
}

async function getRelease(): Promise<Release | null> {
  const { repo, indexReleaseTag } = config.github;
  const res = await fetch(`${GITHUB_API}/repos/${repo}/releases/tags/${indexReleaseTag}`, {
    headers: headers(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    logger.warn(`Release ${indexReleaseTag} not available (${res.status}).`);
    return null;
  }
  return (await res.json()) as Release;
}

/** `updated_at` of the index asset — the running bot polls this to pick up nightly rebuilds. */
export async function fetchIndexStamp(): Promise<string | null> {
  try {
    const release = await getRelease();
    return release?.assets.find((a) => a.name === RELEASE_ASSETS.index)?.updated_at ?? null;
  } catch (err) {
    logger.warn('Could not read release stamp.', err);
    return null;
  }
}

async function downloadAsset(release: Release, name: string, destPath: string): Promise<boolean> {
  const asset = release.assets.find((a) => a.name === name);
  if (!asset) {
    logger.warn(`Asset ${name} missing from release.`);
    return false;
  }
  const res = await fetch(`${GITHUB_API}/repos/${config.github.repo}/releases/assets/${asset.id}`, {
    headers: { ...headers(), Accept: 'application/octet-stream' },
  });
  if (!res.ok || !res.body) {
    logger.warn(`Download of ${name} failed (${res.status}).`);
    return false;
  }
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const tempPath = `${destPath}.download.tmp`;
  try {
    const nodeStream = Readable.fromWeb(res.body as import('stream/web').ReadableStream);
    await pipeline(nodeStream, createGunzip(), createWriteStream(tempPath));
    await fs.rename(tempPath, destPath);
    return true;
  } catch (err) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw err;
  }
}

/**
 * Fetches the pre-built index (JSON + embeddings) for the bot. Writes to `destDir` when given
 * (used for hot-swapping a fresh nightly index without touching the live files first).
 */
export async function downloadIndexFromRelease(
  dest: { indexPath: string; embeddingsPath: string } = {
    indexPath: config.app.indexPath,
    embeddingsPath: config.app.embeddingsPath,
  }
): Promise<{ stamp: string | null } | null> {
  try {
    logger.info(`Fetching pre-built index from release ${config.github.indexReleaseTag}...`);
    const release = await getRelease();
    if (!release) return null;
    const okIndex = await downloadAsset(release, RELEASE_ASSETS.index, dest.indexPath);
    const okEmb = okIndex && (await downloadAsset(release, RELEASE_ASSETS.embeddings, dest.embeddingsPath));
    if (!okIndex || !okEmb) return null;
    const stamp = release.assets.find((a) => a.name === RELEASE_ASSETS.index)?.updated_at ?? null;
    logger.info('Pre-built index downloaded and ready.');
    return { stamp };
  } catch (err) {
    logger.error('Index download failed.', err);
    return null;
  }
}

/** For the indexer: previous index + embeddings + raw-markdown cache so unchanged pages are reused. */
export async function downloadBuildInputsFromRelease(): Promise<void> {
  try {
    const release = await getRelease();
    if (!release) return;
    await downloadAsset(release, RELEASE_ASSETS.index, config.app.indexPath).catch((e) => logger.warn('index', e));
    await downloadAsset(release, RELEASE_ASSETS.embeddings, config.app.embeddingsPath).catch((e) =>
      logger.warn('embeddings', e)
    );
    await downloadAsset(release, RELEASE_ASSETS.buildCache, config.app.buildCachePath).catch((e) =>
      logger.warn('build cache', e)
    );
  } catch (err) {
    logger.warn('Could not fetch previous build inputs; building from scratch.', err);
  }
}

import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const GITHUB_API = 'https://api.github.com';
const ASSET_NAME = 'notion-index.json.gz';

interface ReleaseAsset {
  id: number;
  name: string;
}

interface Release {
  assets: ReleaseAsset[];
}

export async function downloadIndexFromRelease(): Promise<boolean> {
  const { token, repo, indexReleaseTag } = config.github;

  if (!token) {
    logger.info('GITHUB_TOKEN not configured — skipping pre-built index download.');
    return false;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'PERBot',
    'X-GitHub-Api-Version': '2022-11-28',
    Accept: 'application/vnd.github+json',
  };

  try {
    logger.info(`Fetching pre-built index from release ${indexReleaseTag}...`);

    const releaseRes = await fetch(`${GITHUB_API}/repos/${repo}/releases/tags/${indexReleaseTag}`, { headers });
    if (!releaseRes.ok) {
      logger.warn(`Release ${indexReleaseTag} not found (${releaseRes.status}) — will build from scratch.`);
      return false;
    }

    const release = (await releaseRes.json()) as Release;
    const asset = release.assets.find((a) => a.name === ASSET_NAME);
    if (!asset) {
      logger.warn(`Asset ${ASSET_NAME} missing from release — will build from scratch.`);
      return false;
    }

    const assetRes = await fetch(`${GITHUB_API}/repos/${repo}/releases/assets/${asset.id}`, {
      headers: { ...headers, Accept: 'application/octet-stream' },
    });
    if (!assetRes.ok || !assetRes.body) {
      logger.warn(`Asset download failed (${assetRes.status}) — will build from scratch.`);
      return false;
    }

    await fs.mkdir(path.dirname(config.app.indexPath), { recursive: true });
    const tempPath = `${config.app.indexPath}.download.tmp`;

    const nodeStream = Readable.fromWeb(assetRes.body as import('stream/web').ReadableStream);
    await pipeline(nodeStream, createGunzip(), createWriteStream(tempPath));
    await fs.rename(tempPath, config.app.indexPath);

    logger.info('Pre-built index downloaded and ready.');
    return true;
  } catch (err) {
    logger.error('Index download failed — will fall back to building from scratch.', err);
    // Clean up partial download if it exists
    try {
      await fs.unlink(`${config.app.indexPath}.download.tmp`);
    } catch {
      // ignore
    }
    return false;
  }
}

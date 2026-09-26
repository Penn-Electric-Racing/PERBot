import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { BuildCache } from '../types.js';
import type { ServiceAccountAuth } from './googleAuth.js';
import type { SourceDocument } from './types.js';

/**
 * Google Shared Drive source. Scope is whatever the service account can see: every Shared
 * Drive it has been added to (or only `GDRIVE_DRIVE_IDS`), plus any folders in `GDRIVE_FOLDER_IDS`.
 * Subtrees under a folder named in `GDRIVE_EXCLUDE_FOLDERS` are skipped.
 *
 * Text comes from Drive's own export for Google Docs (markdown, so headings survive), Slides
 * and Sheets; PDFs go through unpdf, .docx through mammoth, plain text/markdown/csv as-is.
 * CAD, images, video, spreadsheets in office formats and anything over `GDRIVE_MAX_FILE_MB`
 * are skipped. Extracted text is cached by file id + modifiedTime in the build cache.
 */

const API = 'https://www.googleapis.com/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';

/** Google-native types → export MIME. */
const EXPORTS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/markdown',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};

/** Binary/uploaded types we can read. */
const DOWNLOADS: Record<string, 'pdf' | 'docx' | 'text'> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'text',
  'text/markdown': 'text',
  'text/csv': 'text',
};

const MAX_SHEET_CHARS = 20_000;
const MAX_ATTEMPTS = 6;

function backoff(attempt: number): Promise<void> {
  const ms = Math.min(60_000, 2_000 * 2 ** attempt) + Math.random() * 1_000;
  return new Promise((r) => setTimeout(r, ms));
}

async function isRateLimit(res: Response): Promise<boolean> {
  try {
    const body = await res.clone().text();
    return /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(body);
  } catch {
    return false;
  }
}
const REV_FOLDER = /^REV\s?-?(\d{1,2})\b/i;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  modifiedTime: string;
  createdTime: string;
  size?: string;
  webViewLink?: string;
  driveId?: string;
}

export type FileRoute = { type: 'export'; mime: string } | { type: 'download'; parser: 'pdf' | 'docx' | 'text' } | { type: 'skip'; reason: string };

export function routeFile(file: DriveFile, maxBytes: number): FileRoute {
  if (file.mimeType === FOLDER || file.mimeType === SHORTCUT) return { type: 'skip', reason: 'container' };
  const exportMime = EXPORTS[file.mimeType];
  if (exportMime) return { type: 'export', mime: exportMime };
  const parser = DOWNLOADS[file.mimeType];
  if (!parser) return { type: 'skip', reason: `unsupported type ${file.mimeType}` };
  if (file.size && Number(file.size) > maxBytes) return { type: 'skip', reason: `over ${Math.round(maxBytes / 1e6)} MB` };
  return { type: 'download', parser };
}

export interface FolderIndex {
  /** Ancestor folder names for a file, top-down, starting with the drive name. */
  pathOf(file: DriveFile): string[];
  /** True when any ancestor folder is in the exclusion list. */
  excluded(file: DriveFile): boolean;
}

/** Resolves breadcrumbs from the flat folder list a Shared Drive listing returns. */
export function buildFolderIndex(
  folders: DriveFile[],
  roots: Map<string, string>,
  excludeNames: string[],
  minRev = 0
): FolderIndex {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const exclude = new Set(excludeNames.map((n) => n.toLowerCase()));
  const excludedName = (name: string): boolean => {
    if (exclude.has(name.toLowerCase())) return true;
    const rev = name.match(REV_FOLDER);
    return rev !== null && Number(rev[1]) < minRev;
  };
  const chainCache = new Map<string, string[]>();

  const chain = (id: string | undefined, depth = 0): string[] => {
    if (!id || depth > 30) return [];
    const rootName = roots.get(id);
    if (rootName !== undefined) return [rootName];
    const cached = chainCache.get(id);
    if (cached) return cached;
    const folder = byId.get(id);
    const result = folder ? [...chain(folder.parents?.[0], depth + 1), folder.name] : [];
    chainCache.set(id, result);
    return result;
  };

  return {
    pathOf: (file) => chain(file.parents?.[0]),
    excluded: (file) => chain(file.parents?.[0]).some(excludedName),
  };
}

export class DriveService {
  constructor(private readonly auth: ServiceAccountAuth, private readonly fetchFn: typeof fetch = fetch) {}

  /**
   * GET with backoff. Drive signals rate limiting as 403 `userRateLimitExceeded` /
   * `rateLimitExceeded` as often as 429, so both are retried with exponential backoff + jitter.
   */
  private async get(path: string, params: Record<string, string>, accept?: string): Promise<Response> {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      const token = await this.auth.accessToken();
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          headers: { Authorization: `Bearer ${token}`, ...(accept ? { Accept: accept } : {}) },
          signal: AbortSignal.timeout(120_000),
        });
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) throw err;
        await backoff(attempt);
        continue;
      }
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && (await isRateLimit(res)));
      if (!retryable || attempt >= MAX_ATTEMPTS) return res;
      await backoff(attempt);
    }
  }

  private async getJson<T>(path: string, params: Record<string, string>): Promise<T> {
    const res = await this.get(path, params);
    if (!res.ok) throw new Error(`Drive ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  async listSharedDrives(): Promise<Array<{ id: string; name: string }>> {
    const drives: Array<{ id: string; name: string }> = [];
    let pageToken: string | undefined;
    do {
      const data = await this.getJson<{ drives?: Array<{ id: string; name: string }>; nextPageToken?: string }>('/drives', {
        pageSize: '100',
        ...(pageToken ? { pageToken } : {}),
      });
      drives.push(...(data.drives ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return drives;
  }

  private async listFiles(params: Record<string, string>): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const data = await this.getJson<{ files?: DriveFile[]; nextPageToken?: string }>('/files', {
        pageSize: '1000',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        fields: 'nextPageToken,files(id,name,mimeType,parents,modifiedTime,createdTime,size,webViewLink,driveId)',
        ...params,
        ...(pageToken ? { pageToken } : {}),
      });
      files.push(...(data.files ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return files;
  }

  /** Every non-trashed file and folder in one Shared Drive. */
  listDrive(driveId: string): Promise<DriveFile[]> {
    return this.listFiles({ corpora: 'drive', driveId, q: 'trashed = false' });
  }

  /** A folder subtree (any drive), breadth-first. */
  async listFolderTree(folderId: string): Promise<{ root: DriveFile | null; files: DriveFile[] }> {
    const root = await this.getJson<DriveFile>(`/files/${folderId}`, {
      supportsAllDrives: 'true',
      fields: 'id,name,mimeType,parents,modifiedTime,createdTime,driveId',
    }).catch(() => null);
    const files: DriveFile[] = [];
    const queue = [folderId];
    const seen = new Set<string>();
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const children = await this.listFiles({ corpora: 'allDrives', q: `'${id}' in parents and trashed = false` });
      for (const child of children) {
        files.push(child);
        if (child.mimeType === FOLDER) queue.push(child.id);
      }
    }
    return { root, files };
  }

  async fileText(file: DriveFile, route: FileRoute): Promise<string | null> {
    if (route.type === 'skip') return null;
    if (route.type === 'export') {
      let res = await this.get(`/files/${file.id}/export`, { mimeType: route.mime });
      if (res.status === 403 && route.mime === 'text/markdown') {
        // Markdown export is capped at 10 MB and image-heavy Docs exceed it (exportSizeLimitExceeded);
        // plain text of the same doc is a few hundred KB and always exports.
        res = await this.get(`/files/${file.id}/export`, { mimeType: 'text/plain' });
      }
      if (!res.ok) throw new Error(`export ${res.status} ${(await res.text()).match(/"reason":\s*"([^"]+)"/)?.[1] ?? ''}`.trim());
      const text = await res.text();
      const cap = route.mime === 'text/csv' ? MAX_SHEET_CHARS : config.gdrive.maxDocChars;
      return text.length > cap ? `${text.slice(0, cap)}\n[… truncated …]` : text;
    }
    const res = await this.get(`/files/${file.id}`, { alt: 'media', supportsAllDrives: 'true' });
    if (!res.ok) throw new Error(`download ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    let text: string;
    if (route.parser === 'pdf') {
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const out = await extractText(pdf, { mergePages: true });
      text = out.text;
    } else if (route.parser === 'docx') {
      text = (await mammoth.extractRawText({ buffer })).value;
    } else {
      text = buffer.toString('utf8');
    }
    const cap = config.gdrive.maxDocChars;
    return text.length > cap ? `${text.slice(0, cap)}\n[… truncated …]` : text;
  }

  /** Lists, extracts (or reuses cached text for) and packages every indexable Drive file. */
  async buildDocuments(cache: BuildCache): Promise<{ docs: SourceDocument[]; cache: BuildCache['drive'] }> {
    const { driveIds, folderIds, excludeFolderNames, maxFileBytes, maxFiles, minRev } = config.gdrive;
    const prev = cache.drive ?? {};
    const next: NonNullable<BuildCache['drive']> = {};
    const docs: SourceDocument[] = [];
    const counts = { drives: 0, listed: 0, fetched: 0, cached: 0, skipped: 0, excluded: 0, failed: 0, empty: 0 };

    // Collect every file with the folder index that explains its breadcrumb.
    const batches: Array<{ files: DriveFile[]; index: FolderIndex }> = [];

    let drives = await this.listSharedDrives();
    if (driveIds.length) drives = drives.filter((d) => driveIds.includes(d.id));
    for (const drive of drives) {
      const all = await this.listDrive(drive.id);
      const folders = all.filter((f) => f.mimeType === FOLDER);
      const index = buildFolderIndex(folders, new Map([[drive.id, drive.name]]), excludeFolderNames, minRev);
      batches.push({ files: all.filter((f) => f.mimeType !== FOLDER), index });
      counts.drives++;
      logger.info(`Drive "${drive.name}": ${all.length - folders.length} files in ${folders.length} folders.`);
    }
    for (const folderId of folderIds) {
      const { root, files } = await this.listFolderTree(folderId);
      const folders = files.filter((f) => f.mimeType === FOLDER);
      const index = buildFolderIndex(folders, new Map([[folderId, root?.name ?? 'Drive folder']]), excludeFolderNames, minRev);
      batches.push({ files: files.filter((f) => f.mimeType !== FOLDER), index });
      logger.info(`Drive folder "${root?.name ?? folderId}": ${files.length - folders.length} files.`);
    }

    for (const { files, index } of batches) {
      for (const file of files) {
        counts.listed++;
        if (docs.length >= maxFiles) break;
        if (index.excluded(file)) {
          counts.excluded++;
          continue;
        }
        const route = routeFile(file, maxFileBytes);
        if (route.type === 'skip') {
          counts.skipped++;
          continue;
        }

        let text: string;
        const hit = prev[file.id];
        if (hit && hit.modifiedTime === file.modifiedTime) {
          text = hit.text;
          counts.cached++;
        } else {
          try {
            text = (await this.fileText(file, route)) ?? '';
            counts.fetched++;
          } catch (err) {
            counts.failed++;
            logger.warn(`Drive: skipping "${file.name}" (${file.id}): ${(err as Error).message}`);
            continue;
          }
        }
        next[file.id] = { modifiedTime: file.modifiedTime, text };
        if ((counts.fetched + counts.cached) % 500 === 0) {
          logger.info(`Drive: ${counts.fetched + counts.cached} files read (${counts.fetched} fetched, ${counts.cached} cached), ${docs.length} kept so far.`);
        }

        const clean = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        if (clean.length < config.app.minPageChars) {
          counts.empty++;
          continue;
        }
        docs.push({
          id: `drive:${file.id}`,
          source: 'drive',
          // Spreadsheets are data, not write-ups: rank them like Notion records.
          kind: route.type === 'export' && route.mime === 'text/csv' ? 'record' : 'doc',
          title: file.name.replace(/\.(pdf|docx|txt|md|csv)$/i, ''),
          url: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
          ancestors: index.pathOf(file),
          cleanText: clean,
          createdTime: file.createdTime,
          lastEditedTime: file.modifiedTime,
        });
      }
    }

    logger.info(
      `Drive: ${docs.length} documents from ${counts.drives} shared drive(s) + ${folderIds.length} folder(s) — ` +
        `listed ${counts.listed}, fetched ${counts.fetched}, reused ${counts.cached}, skipped ${counts.skipped} unsupported, ` +
        `${counts.excluded} excluded, ${counts.empty} empty, ${counts.failed} failed.`
    );
    return { docs, cache: next };
  }
}

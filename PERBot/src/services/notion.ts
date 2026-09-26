import { Client } from '@notionhq/client';
import { config } from '../config.js';
import type { BuildCache, DocKind } from '../types.js';
import { cleanNotionMarkdown, isTemplatePlaceholder } from '../utils/notionText.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/chunk.js';

/** A page as returned by `search`, reduced to what the indexer needs. */
export interface RawNotionPage {
  id: string;
  title: string;
  url: string;
  parent: NotionParent | null;
  properties: Record<string, unknown>;
  createdTime: string;
  lastEditedTime: string;
  archived: boolean;
}

type NotionParent =
  | { type: 'workspace' }
  | { type: 'page_id'; page_id: string }
  | { type: 'block_id'; block_id: string }
  | { type: 'database_id'; database_id: string }
  | { type: 'data_source_id'; data_source_id: string; database_id?: string };

/** A page that made it through the filters, ready to be enriched and chunked. */
export interface IndexableDocument {
  page: RawNotionPage;
  kind: DocKind;
  /** Ancestor titles, top-down, excluding the page itself. */
  ancestors: string[];
  cleanText: string;
}

function normId(id: string): string {
  return id.replace(/-/g, '');
}

function richText(items: unknown): string {
  return Array.isArray(items) ? items.map((i: any) => i?.plain_text ?? '').join('').trim() : '';
}

export function extractTitle(page: any): string {
  for (const value of Object.values(page?.properties ?? {}) as any[]) {
    if (value?.type === 'title') {
      const plain = richText(value.title);
      if (plain) return plain;
    }
  }
  if (typeof page?.title === 'string' && page.title.trim()) return page.title.trim();
  return `Untitled ${page?.id ?? 'page'}`;
}

export function isDatabaseRow(page: RawNotionPage): boolean {
  return page.parent?.type === 'data_source_id' || page.parent?.type === 'database_id';
}

function rowDataSourceIds(page: RawNotionPage): string[] {
  const p = page.parent as any;
  return [p?.data_source_id, p?.database_id].filter(Boolean).map(normId);
}

/** Property values as searchable text ("Status: Available · Category: Aero"). */
export function propertiesText(properties: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const prop = raw as any;
    let value = '';
    switch (prop?.type) {
      case 'title':
        continue;
      case 'rich_text':
        value = richText(prop.rich_text);
        break;
      case 'select':
      case 'status':
        value = prop[prop.type]?.name ?? '';
        break;
      case 'multi_select':
        value = (prop.multi_select ?? []).map((o: any) => o.name).join(', ');
        break;
      case 'number':
        value = prop.number == null ? '' : String(prop.number);
        break;
      case 'date':
        value = prop.date?.start ? (prop.date.end ? `${prop.date.start} – ${prop.date.end}` : prop.date.start) : '';
        break;
      case 'checkbox':
        value = prop.checkbox ? 'Yes' : 'No';
        break;
      case 'url':
      case 'email':
      case 'phone_number':
        value = prop[prop.type] ?? '';
        break;
      case 'people':
        value = (prop.people ?? []).map((p: any) => p.name).filter(Boolean).join(', ');
        break;
      case 'formula':
        value = prop.formula?.string ?? (prop.formula?.number != null ? String(prop.formula.number) : '');
        break;
      default:
        continue;
    }
    if (value) lines.push(`${name}: ${value}`);
  }
  return lines.join('\n');
}

export class NotionService {
  private readonly client: Client;
  private readonly dbCache = new Map<string, { title: string; parent: NotionParent | null } | null>();
  private readonly blockParentCache = new Map<string, NotionParent | null>();
  private readonly ancestorCache = new Map<string, string[]>();

  constructor() {
    this.client = new Client({ auth: config.notion.token });
  }

  async listAllSharedPages(): Promise<RawNotionPage[]> {
    const pages: RawNotionPage[] = [];
    let cursor: string | undefined;

    while (true) {
      const response: any = await this.client.search({
        filter: { property: 'object', value: 'page' as const },
        page_size: 100,
        start_cursor: cursor,
      });

      for (const item of response.results ?? []) {
        if (item.object !== 'page') continue;
        pages.push({
          id: item.id,
          title: extractTitle(item),
          url: item.url,
          parent: item.parent ?? null,
          properties: item.properties ?? {},
          createdTime: item.created_time,
          lastEditedTime: item.last_edited_time,
          archived: Boolean(item.archived || item.in_trash),
        });
      }

      if (!response.has_more || !response.next_cursor) break;
      cursor = response.next_cursor;
    }

    logger.info(`Discovered ${pages.length} shared Notion pages.`);
    return pages;
  }

  async getPageMarkdown(pageId: string): Promise<string> {
    const response = await fetch(`https://api.notion.com/v1/pages/${pageId}/markdown`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.notion.token}`,
        'Notion-Version': config.notion.apiVersion,
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to fetch markdown for ${pageId}: ${response.status} ${text}`);
    }

    const data: any = await response.json();
    const markdown = typeof data?.markdown === 'string' ? data.markdown : '';
    if (data?.truncated) {
      logger.warn(`Markdown for page ${pageId} was truncated. Results may be incomplete.`);
    }
    return markdown;
  }

  private async getDatabase(databaseId: string): Promise<{ title: string; parent: NotionParent | null } | null> {
    const key = normId(databaseId);
    if (this.dbCache.has(key)) return this.dbCache.get(key)!;
    let result: { title: string; parent: NotionParent | null } | null = null;
    try {
      const db: any = await this.client.databases.retrieve({ database_id: databaseId });
      result = { title: richText(db.title) || '(database)', parent: db.parent ?? null };
      await sleep(120);
    } catch (err) {
      logger.warn(`Could not retrieve database ${databaseId} for breadcrumbs.`, (err as Error).message);
    }
    this.dbCache.set(key, result);
    return result;
  }

  private async getBlockParent(blockId: string): Promise<NotionParent | null> {
    const key = normId(blockId);
    if (this.blockParentCache.has(key)) return this.blockParentCache.get(key)!;
    let parent: NotionParent | null = null;
    try {
      const block: any = await this.client.blocks.retrieve({ block_id: blockId });
      parent = block.parent ?? null;
      await sleep(120);
    } catch (err) {
      logger.warn(`Could not retrieve block ${blockId} for breadcrumbs.`, (err as Error).message);
    }
    this.blockParentCache.set(key, parent);
    return parent;
  }

  /**
   * Titles of everything above `parent`, top-down. Page parents resolve from the pages we already
   * listed (no API call); database and block parents cost one cached request each. Stops silently
   * where the integration cannot see further up.
   */
  async ancestorsOf(parent: NotionParent | null, pagesById: Map<string, RawNotionPage>, depth = 0): Promise<string[]> {
    if (!parent || depth > 12) return [];
    switch (parent.type) {
      case 'workspace':
        return [];
      case 'page_id': {
        const key = normId(parent.page_id);
        const cached = this.ancestorCache.get(key);
        if (cached) return cached;
        const p = pagesById.get(key);
        if (!p) return [];
        const chain = [...(await this.ancestorsOf(p.parent, pagesById, depth + 1)), p.title];
        this.ancestorCache.set(key, chain);
        return chain;
      }
      case 'data_source_id':
      case 'database_id': {
        const dbId = (parent as any).database_id ?? (parent as any).data_source_id;
        const db = await this.getDatabase(dbId);
        if (!db) return [];
        return [...(await this.ancestorsOf(db.parent, pagesById, depth + 1)), db.title];
      }
      case 'block_id': {
        const blockParent = await this.getBlockParent(parent.block_id);
        return this.ancestorsOf(blockParent, pagesById, depth + 1);
      }
      default:
        return [];
    }
  }

  /**
   * Lists every shared page, fetches (or reuses cached) markdown, cleans it, and keeps the pages
   * worth indexing. Database rows are only kept when they carry a real write-up, unless their
   * data source is in `NOTION_INDEX_DATA_SOURCE_IDS`, in which case they are indexed as records.
   */
  async buildIndexableDocuments(cache: BuildCache): Promise<{ docs: IndexableDocument[]; cache: BuildCache }> {
    const rawPages = await this.listAllSharedPages();
    const pagesById = new Map(rawPages.map((p) => [normId(p.id), p]));
    const allowed = new Set(config.notion.allowedPageIds.map(normId));
    const forcedSources = new Set(config.notion.indexDataSourceIds.map(normId));
    const nextCache: BuildCache = { version: 1, pages: {} };
    const docs: IndexableDocument[] = [];

    const counts = { fetched: 0, cached: 0, rowsSkipped: 0, thin: 0, templates: 0, archived: 0, failed: 0 };

    for (const page of rawPages) {
      if (page.archived) {
        counts.archived++;
        continue;
      }
      if (allowed.size > 0 && !allowed.has(normId(page.id))) continue;

      const isRow = isDatabaseRow(page);
      const forced = isRow && rowDataSourceIds(page).some((id) => forcedSources.has(id));

      let markdown: string;
      const prev = cache.pages[page.id];
      if (prev && prev.lastEditedTime === page.lastEditedTime) {
        markdown = prev.markdown;
        counts.cached++;
      } else {
        try {
          markdown = await this.getPageMarkdown(page.id);
          counts.fetched++;
        } catch (err) {
          logger.warn(`Skipping page ${page.title} (${page.id})`, (err as Error).message);
          counts.failed++;
          continue;
        } finally {
          await sleep(config.app.indexRateLimitMs);
        }
      }
      nextCache.pages[page.id] = { lastEditedTime: page.lastEditedTime, markdown };

      const body = cleanNotionMarkdown(markdown);
      let kind: DocKind = 'doc';
      let cleanText = body;

      if (forced) {
        kind = 'record';
        const props = propertiesText(page.properties);
        cleanText = [props, body].filter(Boolean).join('\n\n');
      } else if (isRow) {
        if (body.length < config.app.minRecordBodyChars) {
          counts.rowsSkipped++;
          continue;
        }
      }

      if (cleanText.length < config.app.minPageChars) {
        counts.thin++;
        continue;
      }
      if (kind === 'doc' && isTemplatePlaceholder(cleanText)) {
        counts.templates++;
        continue;
      }

      const ancestors = await this.ancestorsOf(page.parent, pagesById);
      docs.push({ page, kind, ancestors, cleanText });

      if ((counts.fetched + counts.cached) % 500 === 0) {
        logger.info(`Processed ${counts.fetched + counts.cached}/${rawPages.length} pages (${docs.length} kept so far)`);
      }
    }

    logger.info(
      `Prepared ${docs.length} documents for indexing — fetched ${counts.fetched}, reused ${counts.cached} from cache; ` +
        `skipped ${counts.rowsSkipped} bare database rows, ${counts.thin} near-empty pages, ${counts.templates} untouched templates, ` +
        `${counts.archived} archived, ${counts.failed} failed.`
    );
    return { docs, cache: nextCache };
  }
}

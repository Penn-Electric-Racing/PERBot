import { Client } from '@notionhq/client';
import { config } from '../config.js';
import type { NotionPageRecord } from '../types.js';
import { makeSnippet, stripMarkdown } from '../utils/text.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/chunk.js';

function extractTitle(page: any): string {
  const properties = page?.properties ?? {};

  for (const value of Object.values(properties) as any[]) {
    if (value?.type === 'title' && Array.isArray(value.title)) {
      const plain = value.title.map((item: any) => item?.plain_text ?? '').join('').trim();
      if (plain) return plain;
    }
  }

  if (typeof page?.title === 'string' && page.title.trim()) {
    return page.title.trim();
  }

  return `Untitled ${page?.id ?? 'page'}`;
}

function parseRevNumber(value: string): number | null {
  const match = value.toUpperCase().match(/REV\s*([0-9]+)/);
  return match ? Number(match[1]) : null;
}

function isHistoricalPage(title: string, markdown: string): boolean {
  const corpus = `${title}\n${markdown}`.toLowerCase();
  if (/(archive|archived|historical|legacy|old season|deprecated)/i.test(corpus)) {
    return true;
  }

  const currentRev = parseRevNumber(config.app.currentRev);
  const pageRev = parseRevNumber(title) ?? parseRevNumber(markdown.slice(0, 500));
  if (currentRev !== null && pageRev !== null && pageRev < currentRev) {
    return true;
  }

  return false;
}

export class NotionService {
  private readonly client: Client;

  constructor() {
    this.client = new Client({ auth: config.notion.token });
  }

  async listAllSharedPages(): Promise<any[]> {
    const pages: any[] = [];
    let cursor: string | undefined;

    while (true) {
      const response: any = await this.client.search({
        filter: { property: 'object', value: 'page' as const },
        page_size: 100,
        start_cursor: cursor,
      });

      const batch = (response.results ?? []).filter((item: any) => item.object === 'page');
      pages.push(...batch);

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

  async buildIndexablePages(): Promise<NotionPageRecord[]> {
    const rawPages = await this.listAllSharedPages();
    const allowed = new Set(config.notion.allowedPageIds.map((item) => item.replace(/-/g, '')));
    const pageRecords: NotionPageRecord[] = [];

    for (const page of rawPages) {
      const normalizedId = String(page.id).replace(/-/g, '');
      if (allowed.size > 0 && !allowed.has(normalizedId) && !allowed.has(page.id)) {
        continue;
      }

      const title = extractTitle(page);

      try {
        const markdown = await this.getPageMarkdown(page.id);
        const plain = stripMarkdown(markdown || title);
        if (!plain) {
          await sleep(config.app.indexRateLimitMs);
          continue;
        }

        pageRecords.push({
          id: page.id,
          title,
          url: page.url,
          path: [title],
          lastEditedTime: page.last_edited_time,
          createdTime: page.created_time,
          isHistorical: isHistoricalPage(title, markdown),
          markdown,
          snippet: makeSnippet(plain),
        });
      } catch (error) {
        logger.warn(`Skipping page ${title} (${page.id})`, error);
      }

      await sleep(config.app.indexRateLimitMs);
    }

    logger.info(`Prepared ${pageRecords.length} pages for indexing.`);
    return pageRecords;
  }
}

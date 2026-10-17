import { Client } from '@notionhq/client';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { readTextRuns, toRichText, type PriceRow, type RowPatch } from './swap.js';

/**
 * Purchasing (PEFS) reads/writes for the price-check buttons: just the columns a swap
 * touches or guards on. Same database as BenBuys and the price listener.
 */

const num = (prop: any): number | null => (typeof prop?.number === 'number' ? prop.number : null);

export function parsePriceRow(page: any): PriceRow {
  const p = page?.properties ?? {};
  return {
    id: page.id,
    unitCost: num(p['Unit cost']),
    quantity: num(p['Quant.']),
    link: p['Link to product webpage']?.url ?? '',
    exported: Boolean(p['Exported?']?.checkbox),
    deleted: Boolean(page?.archived || page?.in_trash),
    notes: readTextRuns(p['Notes (internal)']),
    name: plain(Object.values(p).find((v: any) => v?.type === 'title')),
    part: plain(p['Cat. or model no.']),
    season: p['Season']?.select?.name ?? '',
    url: page?.url ?? '',
  };
}

const plain = (prop: any): string => (prop?.title ?? prop?.rich_text ?? []).map((t: any) => t?.plain_text ?? '').join('').trim();

export class PriceCheckNotion {
  private client: Client;

  constructor(token: string = config.notion.token) {
    this.client = new Client({ auth: token, notionVersion: config.notion.apiVersion });
  }

  async fetchRow(pageId: string): Promise<PriceRow> {
    return parsePriceRow(await this.client.pages.retrieve({ page_id: pageId }));
  }

  async writeRow(pageId: string, patch: RowPatch): Promise<void> {
    const properties: Record<string, any> = { 'Unit cost': { number: patch.unitCost } };
    if (patch.link !== undefined) properties['Link to product webpage'] = { url: patch.link };
    if (patch.notes !== undefined) properties['Notes (internal)'] = { rich_text: toRichText(patch.notes) };
    await this.client.pages.update({ page_id: pageId, properties: properties as any });
    logger.info(`Price check: row ${pageId} → Unit cost ${patch.unitCost}${patch.link !== undefined ? ', link updated' : ''}.`);
  }
}

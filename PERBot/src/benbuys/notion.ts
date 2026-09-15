import { Client } from '@notionhq/client';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { PurchasingRow, VendorAdapter } from './types.js';

/**
 * Notion access for the Purchasing (PEFS) database — the source of truth for BenBuys
 * orders. Reads select the vendor's ready, un-exported rows for `prep`; the writer marks
 * the rows from the last `prep` as ordered after `done`.
 *
 * Relevant schema (confirmed 2026-09-15): Name (title) · Cat. or model no. (text) · Quant.
 * (number) · Unit cost (number) · Season (select) · Payment Method (select: PEFS/PCard/
 * BenBuys) · PEFS Ready? (formula → "✅ Ready" | "❌ Missing fields") · Exported? (checkbox) ·
 * Include in next order (checkbox) · Electrical BENBuys / Mechanical BENBuys (boolean
 * formulas on the product link's domain) · Sanitized Description (CSV) (formula) · Order
 * Batch (text) · Run ID (text) · Procurement Status (select: Submitted) · Last Email Update (date).
 */

const READY_VALUE = '✅ Ready';

function text(prop: any): string {
  return (prop?.rich_text ?? prop?.title ?? []).map((t: any) => t?.plain_text ?? '').join('').trim();
}
function formulaValue(prop: any): any {
  const f = prop?.formula;
  return f ? f[f.type] : undefined;
}

export function parsePurchasingRow(page: any): PurchasingRow {
  const p = page?.properties ?? {};
  return {
    id: page.id,
    url: page.url ?? '',
    name: text(p['Name']),
    partNumber: text(p['Cat. or model no.']),
    quantity: Number(p['Quant.']?.number ?? 0),
    unitCost: Number(p['Unit cost']?.number ?? 0),
    subsystems: (p['Subsystem']?.multi_select ?? []).map((s: any) => s?.name ?? '').filter(Boolean),
    pointOfContact: (p['Point of contact']?.people ?? []).map((u: any) => u?.name ?? '').filter(Boolean),
    orderBatch: text(p['Order Batch']),
    link: p['Link to product webpage']?.url ?? '',
    sanitizedDescription: String(formulaValue(p['Sanitized Description (CSV)']) ?? '').trim(),
    notes: text(p['Notes (internal)']),
    readiness: String(formulaValue(p['PEFS Ready?']) ?? ''),
    includeInNextOrder: Boolean(p['Include in next order']?.checkbox),
  };
}

export interface RowSelection {
  ready: PurchasingRow[];
  notReady: PurchasingRow[];
}

export interface WriteBackResult {
  updated: string[];
  failed: { id: string; error: string }[];
}

export class PurchasingNotion {
  private client: Client;
  private dataSourceId: string;

  constructor(token: string = config.notion.token, dataSourceId: string = config.benbuys.purchasingDataSourceId) {
    this.client = new Client({ auth: token, notionVersion: config.notion.apiVersion });
    this.dataSourceId = dataSourceId;
  }

  private baseFilter(adapter: VendorAdapter): any[] {
    return [
      { property: 'Season', select: { equals: config.benbuys.season } },
      { property: 'Payment Method', select: { equals: 'BenBuys' } },
      { property: 'Exported?', checkbox: { equals: false } },
      { property: adapter.matchFormula, formula: { checkbox: { equals: true } } },
    ];
  }

  private async queryAll(filter: any): Promise<PurchasingRow[]> {
    const rows: PurchasingRow[] = [];
    let cursor: string | undefined;
    do {
      const response: any = await this.client.dataSources.query({
        data_source_id: this.dataSourceId,
        filter,
        sorts: [
          { property: 'Order Batch', direction: 'ascending' },
          { property: 'Subsystem', direction: 'ascending' },
        ],
        page_size: 100,
        start_cursor: cursor,
      });
      for (const page of response.results ?? []) rows.push(parsePurchasingRow(page));
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);
    return rows;
  }

  /**
   * The vendor's un-exported BenBuys rows for the season, split by `PEFS Ready?`. Two
   * queries (with / without the readiness clause) diffed by id, so the "fix in Notion"
   * list comes from the same formula the PEFS - Ready Export view uses.
   */
  async selectRows(adapter: VendorAdapter): Promise<RowSelection> {
    const base = this.baseFilter(adapter);
    const [ready, all] = await Promise.all([
      this.queryAll({ and: [...base, { property: 'PEFS Ready?', formula: { string: { equals: READY_VALUE } } }] }),
      this.queryAll({ and: base }),
    ]);
    const readyIds = new Set(ready.map((r) => r.id));
    const notReady = all.filter((r) => !readyIds.has(r.id));
    logger.info(`BenBuys ${adapter.key}: ${ready.length} ready, ${notReady.length} not ready.`);
    return { ready, notReady };
  }

  /** True when any row already carries this Run ID (guards a double `done`). */
  async runIdExists(runId: string): Promise<boolean> {
    const response: any = await this.client.dataSources.query({
      data_source_id: this.dataSourceId,
      filter: { property: 'Run ID', rich_text: { equals: runId } },
      page_size: 1,
    });
    return (response.results ?? []).length > 0;
  }

  /**
   * Mark the cached rows ordered. Sequential so one failure never hides the others. Also
   * clears `Include in next order` — the tick is consumed by the order it selected, so a
   * stale tick can never pull an already-ordered row into a later prep.
   */
  async markOrdered(pageIds: string[], runId: string, now: Date = new Date()): Promise<WriteBackResult> {
    const result: WriteBackResult = { updated: [], failed: [] };
    for (const id of pageIds) {
      try {
        await this.client.pages.update({
          page_id: id,
          properties: {
            'Exported?': { checkbox: true },
            'Include in next order': { checkbox: false },
            'Run ID': { rich_text: [{ text: { content: runId } }] },
            'Procurement Status': { select: { name: 'Submitted' } },
            'Last Email Update': { date: { start: now.toISOString() } },
          } as any,
        });
        result.updated.push(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`BenBuys write-back failed for ${id}`, err);
        result.failed.push({ id, error: message });
      }
    }
    logger.info(`BenBuys ${runId}: ${result.updated.length} rows marked ordered, ${result.failed.length} failed.`);
    return result;
  }
}

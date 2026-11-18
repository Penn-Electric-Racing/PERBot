import { Client } from '@notionhq/client';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Read-only view of the Purchasing (PEFS) database for answering questions like "did we order
 * the AIRs?", "has the DigiKey order arrived?" or "how much has Accumulator spent this season?".
 *
 * Where an order is is spread over several columns; `stageOf` folds them into one stage:
 *   Arrived? = Yes                                     → arrived
 *   Arrived? = Ready for Pickup                        → ready for pickup
 *   Procurement Status = Submitted / Last Email Update → ordered (purchasing confirmed by email)
 *   Exported?                                          → sent to purchasing (not confirmed yet)
 *   otherwise                                          → not submitted
 * (The `Status` select is unused: every row is empty as of 2026-11-17.)
 */

export type OrderStage = 'not submitted' | 'sent to purchasing' | 'ordered' | 'ready for pickup' | 'arrived';
export const ORDER_STAGES: OrderStage[] = ['not submitted', 'sent to purchasing', 'ordered', 'ready for pickup', 'arrived'];

export interface PurchaseRecord {
  id: string;
  url: string;
  name: string;
  partNumber: string;
  vendor: string;
  link: string;
  season: string;
  subsystems: string[];
  quantity: number | null;
  unitCost: number | null;
  totalCost: number | null;
  paymentMethod: string;
  orderBatch: string;
  pointOfContact: string[];
  urgency: string[];
  stage: OrderStage;
  /** Dates are ISO strings (date or datetime) or null. */
  createdAt: string | null;
  submittedAt: string | null;
  orderedAt: string | null;
  arrivedAt: string | null;
  receivedBy: string;
  notes: string;
  description: string;
}

const plain = (prop: any): string =>
  (prop?.title ?? prop?.rich_text ?? []).map((t: any) => t?.plain_text ?? '').join('').trim();
const num = (prop: any): number | null => (typeof prop?.number === 'number' ? prop.number : null);
const date = (prop: any): string | null => prop?.date?.start ?? null;
const names = (list: any[] | undefined): string[] => (list ?? []).map((o: any) => o?.name ?? '').filter(Boolean);
function formulaNumber(prop: any): number | null {
  const f = prop?.formula;
  return f?.type === 'number' && typeof f.number === 'number' ? f.number : null;
}

export function stageOf(row: { arrived: string; procurementSubmitted: boolean; emailUpdate: boolean; exported: boolean }): OrderStage {
  if (row.arrived === 'Yes') return 'arrived';
  if (row.arrived === 'Ready for Pickup') return 'ready for pickup';
  if (row.procurementSubmitted || row.emailUpdate) return 'ordered';
  if (row.exported) return 'sent to purchasing';
  return 'not submitted';
}

export function parsePurchaseRecord(page: any): PurchaseRecord {
  const p = page?.properties ?? {};
  const quantity = num(p['Quant.']);
  const unitCost = num(p['Unit cost']);
  const computed = quantity !== null && unitCost !== null ? quantity * unitCost : null;
  const orderedAt = date(p['Last Email Update']);
  return {
    id: page.id,
    url: page.url ?? '',
    name: plain(p['Name']),
    partNumber: plain(p['Cat. or model no.']),
    vendor: plain(p['Vendor']),
    link: p['Link to product webpage']?.url ?? '',
    season: p['Season']?.select?.name ?? '',
    subsystems: names(p['Subsystem']?.multi_select),
    quantity,
    unitCost,
    totalCost: formulaNumber(p['Total cost']) ?? computed,
    paymentMethod: p['Payment Method']?.select?.name ?? '',
    orderBatch: plain(p['Order Batch']),
    pointOfContact: names(p['Point of contact']?.people),
    urgency: names(p['Urgency']?.multi_select),
    stage: stageOf({
      arrived: p['Arrived?']?.status?.name ?? '',
      procurementSubmitted: p['Procurement Status']?.select?.name === 'Submitted',
      emailUpdate: Boolean(orderedAt),
      exported: Boolean(p['Exported?']?.checkbox),
    }),
    createdAt: page.created_time ?? null,
    submittedAt: date(p['Submitted at']),
    orderedAt,
    arrivedAt: date(p['Arrived at']),
    receivedBy: plain(p['Received by']),
    notes: plain(p['Notes (internal)']),
    description: plain(p['Vendor description and product selection notes']),
  };
}

/** Rows change all day (arrivals, new orders), so the whole table is re-read at most every few minutes. */
const CACHE_MS = 3 * 60_000;
let cache: { at: number; records: Promise<PurchaseRecord[]> } | null = null;

async function fetchAll(): Promise<PurchaseRecord[]> {
  const client = new Client({ auth: config.notion.token, notionVersion: config.notion.apiVersion });
  const records: PurchaseRecord[] = [];
  let cursor: string | undefined;
  do {
    const response: any = await client.dataSources.query({
      data_source_id: config.benbuys.purchasingDataSourceId,
      page_size: 100,
      start_cursor: cursor,
    });
    for (const page of response.results ?? []) {
      if (page?.object === 'page' && !page.in_trash && !page.archived) records.push(parsePurchaseRecord(page));
    }
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);
  logger.info(`Purchasing: loaded ${records.length} rows from Notion.`);
  return records;
}

export function loadPurchaseRecords(): Promise<PurchaseRecord[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.records;
  const records = fetchAll();
  cache = { at: Date.now(), records };
  records.catch(() => {
    if (cache?.records === records) cache = null;
  });
  return records;
}

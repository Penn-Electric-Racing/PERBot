import { Client } from '@notionhq/client';
import { parsePurchasingRow } from '../benbuys/notion.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { ArrivalRow } from './types.js';

/**
 * Purchasing (PEFS) access for package arrivals. Reads open rows (`Arrived?` ≠ Yes) for the
 * season; the only writes are `markArrived` (and its `unmarkArrived` undo), touching ONLY the arrival columns:
 *
 *   Arrived? (status: No / Ready for Pickup / Yes) — exists today; 256 of 257 REV12 rows read "No"
 *   Arrived at (date) · Received by (person or text) · Arrival photo (url) — Week-0 columns
 *
 * The three Week-0 columns are optional: the schema is read once and a column that doesn't
 * exist yet is skipped (with a warning), so arrivals work before anyone adds them. `Received by` as
 * a Text column gets the receiver's name instead of a person — a person property pings them in
 * Notion on every package they bring in (10/19), which buries the @s that matter.
 */

export const ARRIVED_YES = 'Yes';
const OPTIONAL_COLUMNS = ['Arrived at', 'Received by', 'Arrival photo'] as const;

function text(prop: any): string {
  return (prop?.rich_text ?? prop?.title ?? []).map((t: any) => t?.plain_text ?? '').join('').trim();
}

export function parseArrivalRow(page: any): ArrivalRow {
  const p = page?.properties ?? {};
  return {
    ...parsePurchasingRow(page),
    vendor: text(p['Vendor']),
    runId: text(p['Run ID']),
    arrived: p['Arrived?']?.status?.name ?? '',
    exported: Boolean(p['Exported?']?.checkbox),
    submittedAt: p['Submitted at']?.date?.start ?? null,
    orderedAt: p['Last Email Update']?.date?.start ?? null,
  };
}

export interface ArrivalWrite {
  /** When the photo was posted (ISO). */
  arrivedAt: string;
  receivedByNotionId: string | null;
  /** Written instead of the person when `Received by` is a Text column. */
  receivedByName: string | null;
  photoUrl: string | null;
}

export class ArrivalsNotion {
  private client: Client;
  private dataSourceId: string;
  /** Column name → Notion property type. */
  private columns: Promise<Map<string, string>> | null = null;

  constructor(token: string = config.notion.token, dataSourceId: string = config.benbuys.purchasingDataSourceId) {
    this.client = new Client({ auth: token, notionVersion: config.notion.apiVersion });
    this.dataSourceId = dataSourceId;
  }

  private async queryAll(filter: any): Promise<ArrivalRow[]> {
    const rows: ArrivalRow[] = [];
    let cursor: string | undefined;
    do {
      const response: any = await this.client.dataSources.query({
        data_source_id: this.dataSourceId,
        filter,
        page_size: 100,
        start_cursor: cursor,
      });
      for (const page of response.results ?? []) rows.push(parseArrivalRow(page));
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);
    return rows;
  }

  /** This season's rows that haven't arrived — the candidates a slip can match. */
  openRows(): Promise<ArrivalRow[]> {
    return this.queryAll({
      and: [
        { property: 'Season', select: { equals: config.benbuys.season } },
        { property: 'Arrived?', status: { does_not_equal: ARRIVED_YES } },
      ],
    });
  }

  /** Every row of one order (any arrival state), for "all arrived" at click time. */
  rowsForRun(runId: string): Promise<ArrivalRow[]> {
    return this.queryAll({ property: 'Run ID', rich_text: { equals: runId } });
  }

  async fetchRow(pageId: string): Promise<ArrivalRow> {
    return parseArrivalRow(await this.client.pages.retrieve({ page_id: pageId }));
  }

  private existingColumns(): Promise<Map<string, string>> {
    if (!this.columns) {
      this.columns = (this.client.dataSources.retrieve({ data_source_id: this.dataSourceId }) as Promise<any>)
        .then((ds) => {
          const names = new Map<string, string>(Object.entries(ds?.properties ?? {}).map(([k, v]: [string, any]) => [k, String(v?.type ?? '')]));
          const missing = OPTIONAL_COLUMNS.filter((c) => !names.has(c));
          if (missing.length) logger.warn(`Arrivals: Purchasing DB has no ${missing.join(' / ')} column yet; writing Arrived? only for those.`);
          return names;
        })
        .catch((err) => {
          this.columns = null; // retry on the next write
          throw err;
        });
    }
    return this.columns;
  }

  async markArrived(pageId: string, write: ArrivalWrite): Promise<void> {
    const columns = await this.existingColumns();
    const properties: Record<string, any> = { 'Arrived?': { status: { name: ARRIVED_YES } } };
    if (columns.has('Arrived at')) properties['Arrived at'] = { date: { start: write.arrivedAt } };
    if (columns.get('Received by') === 'rich_text' && write.receivedByName) {
      properties['Received by'] = { rich_text: [{ type: 'text', text: { content: write.receivedByName.slice(0, 100) } }] };
    } else if (columns.get('Received by') === 'people' && write.receivedByNotionId) {
      properties['Received by'] = { people: [{ id: write.receivedByNotionId }] };
    }
    if (columns.has('Arrival photo') && write.photoUrl) properties['Arrival photo'] = { url: write.photoUrl };
    await this.client.pages.update({ page_id: pageId, properties } as any);
  }

  /** Undo `markArrived`: the status goes back to what it was and the arrival columns are cleared. */
  async unmarkArrived(pageId: string, previousStatus: string): Promise<void> {
    const columns = await this.existingColumns();
    const properties: Record<string, any> = { 'Arrived?': { status: { name: previousStatus || 'No' } } };
    if (columns.has('Arrived at')) properties['Arrived at'] = { date: null };
    if (columns.get('Received by') === 'rich_text') properties['Received by'] = { rich_text: [] };
    else if (columns.get('Received by') === 'people') properties['Received by'] = { people: [] };
    if (columns.has('Arrival photo')) properties['Arrival photo'] = { url: null };
    await this.client.pages.update({ page_id: pageId, properties } as any);
  }

  /** Workspace people (for Slack poster → Notion `Received by`). */
  async listUsers(): Promise<{ id: string; name: string; email: string | null }[]> {
    const users: { id: string; name: string; email: string | null }[] = [];
    let cursor: string | undefined;
    do {
      const response: any = await this.client.users.list({ start_cursor: cursor, page_size: 100 });
      for (const user of response.results ?? []) {
        if (user?.type === 'bot' || !user?.id) continue;
        users.push({ id: user.id, name: user.name ?? '', email: user?.person?.email ?? null });
      }
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);
    return users;
  }
}

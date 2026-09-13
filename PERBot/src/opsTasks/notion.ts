import { Client } from '@notionhq/client';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Notion access for the Ops Tasks database (child of "REV12 Operations"). Reads feed the
 * Sunday digest; the small writers below back the digest's Slack buttons (Done / In
 * progress / Push a week) so members can update from Slack instead of opening Notion.
 * One row = one action item a member typed under their own name on a Saturday meeting
 * page. Schema: Task (title) · Owner (person) · Status (Not started / In progress /
 * Done) · Due (date, convention = next Saturday) · Week (date, the Saturday it was
 * assigned) · Created. Only Status matters for "open": anything not Done is open.
 */

export interface OpsTaskOwner {
  id: string;
  name: string;
  email: string | null;
}

export interface OpsTask {
  id: string;
  url: string;
  title: string;
  status: string;
  /** YYYY-MM-DD or null when the member left Due blank. */
  due: string | null;
  /**
   * YYYY-MM-DD the task was assigned at. Prefers the "Meeting date" rollup (from the
   * Meeting relation set automatically inside a meeting page), then the legacy hand-set
   * Week date, then the row's Created time — so carried-week counts never go blank.
   */
  week: string | null;
  owners: OpsTaskOwner[];
}

function readTitle(prop: any): string {
  return (prop?.title ?? []).map((t: any) => t?.plain_text ?? '').join('').trim();
}
function readDate(prop: any): string | null {
  const start = prop?.date?.start;
  return typeof start === 'string' ? start.slice(0, 10) : null;
}
/** A date rollup ("show original") arrives as rollup.date or rollup.array[0].date. */
function readRollupDate(prop: any): string | null {
  const r = prop?.rollup;
  if (!r) return null;
  if (r.type === 'date') return readDate(r);
  if (r.type === 'array') {
    for (const item of r.array ?? []) {
      const d = readDate(item);
      if (d) return d;
    }
  }
  return null;
}
function readCreated(page: any): string | null {
  const t = page?.created_time;
  return typeof t === 'string' ? t.slice(0, 10) : null;
}
function readOwners(prop: any): OpsTaskOwner[] {
  return (prop?.people ?? [])
    .filter((p: any) => typeof p?.id === 'string')
    .map((p: any) => ({
      id: p.id as string,
      name: typeof p.name === 'string' ? p.name : '',
      // Present when the integration has the "read user emails" capability (it does).
      email: typeof p?.person?.email === 'string' ? p.person.email : null,
    }));
}

export function parseOpsTask(page: any): OpsTask {
  const p = page?.properties ?? {};
  return {
    id: page.id,
    url: page.url ?? '',
    title: readTitle(p['Task']),
    status: p['Status']?.status?.name ?? '',
    due: readDate(p['Due']),
    week: readRollupDate(p['Meeting date']) ?? readDate(p['Week']) ?? readCreated(page),
    owners: readOwners(p['Owner']),
  };
}

export class OpsTasksNotion {
  private client: Client;

  constructor(token: string = config.notion.token) {
    this.client = new Client({ auth: token, notionVersion: config.notion.apiVersion });
  }

  /** Every row whose Status is not Done (paginated). */
  async queryOpenTasks(): Promise<OpsTask[]> {
    const tasks: OpsTask[] = [];
    let cursor: string | undefined;
    do {
      const response: any = await this.client.dataSources.query({
        data_source_id: config.opsTasks.dataSourceId,
        filter: { property: 'Status', status: { does_not_equal: 'Done' } },
        page_size: 100,
        start_cursor: cursor,
      });
      for (const page of response.results ?? []) tasks.push(parseOpsTask(page));
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);
    return tasks;
  }

  /** Re-read one task (button handlers do this before writing, so a stale DM can't clobber a newer edit). */
  async fetchTask(pageId: string): Promise<OpsTask> {
    const page: any = await this.client.pages.retrieve({ page_id: pageId });
    return parseOpsTask(page);
  }

  /** Set Status (a Notion status property — options: Not started / In progress / Done). */
  async setStatus(pageId: string, status: 'Not started' | 'In progress' | 'Done'): Promise<void> {
    await this.client.pages.update({ page_id: pageId, properties: { Status: { status: { name: status } } } as any });
    logger.info(`Ops task ${pageId} → Status ${status}.`);
  }

  /** Set the Due date (YYYY-MM-DD). */
  async setDue(pageId: string, dueIso: string): Promise<void> {
    await this.client.pages.update({ page_id: pageId, properties: { Due: { date: { start: dueIso } } } as any });
    logger.info(`Ops task ${pageId} → Due ${dueIso}.`);
  }
}

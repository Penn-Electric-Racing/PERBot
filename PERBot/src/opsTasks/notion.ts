import { Client } from '@notionhq/client';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { OpsMeeting, pickMeeting } from './meetings.js';

/**
 * Notion access for the Ops Tasks database (child of "REV12 Operations"). Reads feed the
 * Sunday digest; the small writers below back the digest's Slack buttons (Done / In
 * progress / Push a week) so members can update from Slack instead of opening Notion.
 * One row = one action item a member typed under their own name on a Saturday meeting
 * page. Schema: Task (title) · Owner (person) · Status (Not started / In progress /
 * Done) · Due (date, convention = next Saturday) · Meeting (relation → Ops Meetings row;
 * the meeting page's "This week" table is `Meeting contains this page`, its "Carried over"
 * table is `Status ≠ Done AND Meeting does not contain this page`) · Week (legacy date) ·
 * Created. Only Status matters for "open": anything not Done is open. A task with NO
 * Meeting never appears in any "This week" table and looks carried on every page, so the
 * Slack writers link it (see `meetingForDate`) and the digest relinks stragglers.
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
  /** Ops Meetings row ids in the Meeting relation (empty = not linked to any meeting page). */
  meetingIds: string[];
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
function readRelationIds(prop: any): string[] {
  return (prop?.relation ?? []).map((r: any) => r?.id).filter((id: any) => typeof id === 'string');
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
    meetingIds: readRelationIds(p['Meeting']),
  };
}

function parseMeeting(page: any): OpsMeeting | null {
  const date = readDate(page?.properties?.['Date']);
  return date ? { id: page.id, date } : null;
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

  /** Every Ops Meetings row with a Date, oldest first (a handful of rows — no need to filter server-side). */
  async listMeetings(): Promise<OpsMeeting[]> {
    const meetings: OpsMeeting[] = [];
    let cursor: string | undefined;
    do {
      const response: any = await this.client.dataSources.query({
        data_source_id: config.opsTasks.meetingsDataSourceId,
        filter: { property: 'Date', date: { is_not_empty: true } },
        sorts: [{ property: 'Date', direction: 'ascending' }],
        page_size: 100,
        start_cursor: cursor,
      });
      for (const page of response.results ?? []) {
        const m = parseMeeting(page);
        if (m) meetings.push(m);
      }
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);
    return meetings;
  }

  /** The meeting page a task dated `anchorIso` belongs to (see meetings.ts), or null if that page doesn't exist yet. */
  async meetingForDate(anchorIso: string): Promise<OpsMeeting | null> {
    return pickMeeting(await this.listMeetings(), anchorIso);
  }

  /**
   * Create a task (powers `/assign`): Status = Not started, Owner(s), optional Due, and the
   * Meeting relation when the caller found the week's page (so it shows in that page's
   * "This week" table instead of looking carried over).
   */
  async createTask(input: { title: string; ownerIds: string[]; dueIso: string | null; meetingId?: string | null }): Promise<OpsTask> {
    const properties: Record<string, any> = {
      Task: { title: [{ text: { content: input.title.slice(0, 200) } }] },
      Owner: { people: input.ownerIds.map((id) => ({ id })) },
      Status: { status: { name: 'Not started' } },
    };
    if (input.dueIso) properties['Due'] = { date: { start: input.dueIso } };
    if (input.meetingId) properties['Meeting'] = { relation: [{ id: input.meetingId }] };
    const page: any = await this.client.pages.create({
      parent: { type: 'data_source_id', data_source_id: config.opsTasks.dataSourceId },
      properties: properties as any,
    });
    logger.info(
      `Ops task created: "${input.title}" → ${input.ownerIds.length} owner(s), due ${input.dueIso ?? 'none'}, meeting ${input.meetingId ?? 'none'}.`
    );
    return parseOpsTask(page);
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

  /** Add a meeting page to the task's Meeting relation (keeps existing links; no-op if already linked). */
  async linkMeeting(task: OpsTask, meetingId: string): Promise<void> {
    if (task.meetingIds.includes(meetingId)) return;
    const relation = [...task.meetingIds, meetingId].map((id) => ({ id }));
    await this.client.pages.update({ page_id: task.id, properties: { Meeting: { relation } } as any });
    logger.info(`Ops task ${task.id} → linked to meeting ${meetingId}.`);
  }

  /** Set the Due date (YYYY-MM-DD). */
  async setDue(pageId: string, dueIso: string): Promise<void> {
    await this.client.pages.update({ page_id: pageId, properties: { Due: { date: { start: dueIso } } } as any });
    logger.info(`Ops task ${pageId} → Due ${dueIso}.`);
  }
}

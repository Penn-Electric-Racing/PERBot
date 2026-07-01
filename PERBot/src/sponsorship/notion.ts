import { Client } from '@notionhq/client';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { BankRowInput, NotionUser, PipelineRow, Stage } from './types.js';

/**
 * Notion access layer for the Sponsorship CRM (Prospect Bank + Pipeline).
 *
 * Uses the data-source API (Notion API version 2026-03-11): pages are created with
 * `parent: { type: 'data_source_id', data_source_id }` and rows are read via
 * `dataSources.query`. We follow the codebase convention of typing Notion payloads
 * loosely (the SDK's property unions are enormous) and validating values ourselves
 * before they reach here.
 */

export interface BankPageRef {
  id: string;
  url: string;
}

/** Build the Notes text, surfacing the Needs-Review flag (no dedicated Notion column exists). */
function buildNotes(input: BankRowInput): string {
  const lines: string[] = ['Auto-enriched by /sponsor.'];
  if (input.contact) {
    lines.push(
      `Contact from Hunter: ${input.contact.name || '(no name)'} <${input.contact.email}> ` +
        `(${input.contact.verificationStatus}, confidence ${input.contact.confidence}).`
    );
  } else {
    lines.push('No contact found via Hunter.');
  }
  if (input.needsReview) {
    lines.push(`⚠️ NEEDS REVIEW: ${input.reviewReason ?? 'verify contact before outreach'}.`);
  }
  return lines.join('\n');
}

// --- Notion property readers (query results are loosely typed) -----------------

function readTitle(prop: any): string {
  return (prop?.title ?? []).map((t: any) => t?.plain_text ?? '').join('').trim();
}
function readRichText(prop: any): string {
  return (prop?.rich_text ?? []).map((t: any) => t?.plain_text ?? '').join('').trim();
}
function readSelect(prop: any): string | null {
  return prop?.select?.name ?? null;
}
function readNumber(prop: any): number | null {
  return typeof prop?.number === 'number' ? prop.number : null;
}
function readDate(prop: any): string | null {
  return prop?.date?.start ?? null;
}
function readPeopleIds(prop: any): string[] {
  return (prop?.people ?? []).map((p: any) => p?.id).filter((id: any): id is string => typeof id === 'string');
}

function parsePipelineRow(page: any): PipelineRow {
  const p = page?.properties ?? {};
  return {
    id: page.id,
    url: page.url,
    company: readTitle(p['Company']),
    stage: (readSelect(p['Stage']) as Stage | null) ?? null,
    driUserIds: readPeopleIds(p['DRI']),
    dealValue: readNumber(p['Deal value ($)']),
    received: readNumber(p['Received ($)']),
    lastContact: readDate(p['Last contact']),
    nextAction: readRichText(p['Next action']),
    nextActionDate: readDate(p['Next action date']),
    notes: readRichText(p['Notes']),
  };
}

/** Stage filter that excludes the two terminal stages — i.e. live/active deals. */
const ACTIVE_STAGE_FILTER = {
  and: [
    { property: 'Stage', select: { does_not_equal: 'Won' } },
    { property: 'Stage', select: { does_not_equal: 'Lost' } },
  ],
};

export class SponsorNotion {
  private readonly client: Client;

  constructor(token: string = config.notion.token) {
    this.client = new Client({ auth: token, notionVersion: config.notion.apiVersion });
  }

  /**
   * Dedupe key: look up an existing Bank row by its canonical Domain URL. Returns the
   * page ref if one exists, else null. The caller passes an already-normalized
   * `https://<domain>` string so this is an exact-match filter.
   */
  async findBankRowByDomain(canonicalDomain: string): Promise<BankPageRef | null> {
    const response: any = await this.client.dataSources.query({
      data_source_id: config.sponsorship.bankDataSourceId,
      filter: { property: 'Domain', url: { equals: canonicalDomain } },
      page_size: 1,
    });

    const hit = (response.results ?? [])[0];
    return hit ? { id: hit.id, url: hit.url } : null;
  }

  /**
   * Create a Prospect Bank row from an enrichment result. Enrichment ALWAYS writes
   * Status = Available and Relationship = New (guardrail: Relationship is never
   * LLM-guessed). Contact fields are written only when Hunter returned a contact.
   */
  async createBankRow(input: BankRowInput): Promise<BankPageRef> {
    const { classification: c } = input;

    const properties: Record<string, any> = {
      Company: { title: [{ text: { content: input.company.slice(0, 200) } }] },
      Domain: { url: input.domain },
      Status: { select: { name: 'Available' } },
      Relationship: { select: { name: 'New' } },
      Tier: { select: { name: c.tier } },
      Type: { select: { name: c.type } },
      Channel: { select: { name: c.channel } },
      Category: { multi_select: c.categories.map((name) => ({ name })) },
      'Fit reason': { rich_text: [{ text: { content: c.fitReason } }] },
      'Needs Review': { checkbox: input.needsReview },
      Notes: { rich_text: [{ text: { content: buildNotes(input) } }] },
    };

    if (c.suggestedAngle) {
      properties['Suggested angle'] = { rich_text: [{ text: { content: c.suggestedAngle } }] };
    }
    if (input.contact) {
      if (input.contact.name) {
        properties['Contact name'] = { rich_text: [{ text: { content: input.contact.name } }] };
      }
      properties['Contact email'] = { email: input.contact.email };
    }

    const result: any = await this.client.pages.create({
      parent: { type: 'data_source_id', data_source_id: config.sponsorship.bankDataSourceId },
      properties: properties as any,
    });

    logger.info(`Created Bank row for ${input.company} (${input.domain}): ${result.url}`);
    return { id: result.id, url: result.url };
  }

  // --- Pipeline ---------------------------------------------------------------

  /** Query the Pipeline data source with an optional filter, following pagination. */
  private async queryPipeline(filter?: unknown): Promise<PipelineRow[]> {
    const rows: PipelineRow[] = [];
    let cursor: string | undefined;
    do {
      const response: any = await this.client.dataSources.query({
        data_source_id: config.sponsorship.pipelineDataSourceId,
        ...(filter ? { filter: filter as any } : {}),
        start_cursor: cursor,
        page_size: 100,
      });
      for (const page of response.results ?? []) rows.push(parsePipelineRow(page));
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);
    return rows;
  }

  /** All Won deals — feeds the win post + running total. */
  async queryWonDeals(): Promise<PipelineRow[]> {
    return this.queryPipeline({ property: 'Stage', select: { equals: 'Won' } });
  }

  /** Active deals owned by a given Notion user — powers `/sponsor me`. */
  async queryActiveDealsForUser(notionUserId: string): Promise<PipelineRow[]> {
    return this.queryPipeline({
      and: [ACTIVE_STAGE_FILTER, { property: 'DRI', people: { contains: notionUserId } }],
    });
  }

  /** Active deals whose Next action date is before `todayIso` — the Wednesday DM. */
  async queryStaleDeals(todayIso: string): Promise<PipelineRow[]> {
    return this.queryPipeline({
      and: [ACTIVE_STAGE_FILTER, { property: 'Next action date', date: { before: todayIso } }],
    });
  }

  /** Find Pipeline deals whose Company title contains `name` (for `/sponsor log`). */
  async findDealsByCompany(name: string): Promise<PipelineRow[]> {
    return this.queryPipeline({ property: 'Company', title: { contains: name } });
  }

  /**
   * Log a manual touch: stamp Last contact = `dateIso` and prepend a dated note.
   * Notes is capped so it can't grow unbounded across many touches.
   */
  async logTouch(row: PipelineRow, note: string, dateIso: string): Promise<void> {
    const dated = `${dateIso}: ${note}`;
    const merged = row.notes ? `${dated}\n${row.notes}` : dated;
    await this.client.pages.update({
      page_id: row.id,
      properties: {
        'Last contact': { date: { start: dateIso } },
        Notes: { rich_text: [{ text: { content: merged.slice(0, 1900) } }] },
      } as any,
    });
    logger.info(`Logged touch on ${row.company} (${row.id}).`);
  }

  /**
   * List workspace users (id + display name + email) for bridging Notion DRI persons
   * to Slack identities. Email may be null if the integration lacks the "read user
   * emails" capability — the identity resolver falls back to name matching then.
   */
  async listNotionUsers(): Promise<NotionUser[]> {
    const users: NotionUser[] = [];
    let cursor: string | undefined;
    do {
      const response: any = await this.client.users.list({ start_cursor: cursor, page_size: 100 });
      for (const user of response.results ?? []) {
        if (user?.type === 'bot' || !user?.id) continue;
        users.push({
          id: user.id,
          name: typeof user.name === 'string' ? user.name : '',
          email: typeof user?.person?.email === 'string' ? user.person.email : null,
        });
      }
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);
    return users;
  }
}

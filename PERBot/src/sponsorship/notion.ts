import { Client } from '@notionhq/client';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { SponsorScores } from './scoring.js';
import {
  BankLeadRow,
  BankRowInput,
  BankStatus,
  Category,
  NotionUser,
  PipelineDealInput,
  PipelineRow,
  SponsorType,
  Stage,
} from './types.js';

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

/** Prefix identifying a generated-draft toggle on a Bank page (regeneration replaces it). */
export const DRAFT_EMAIL_MARKER = '📧 Draft email';

/** Prefix identifying the specific-ask toggle on a Bank page. Set via `/sponsor ask`
 *  (or by hand); its contents are included VERBATIM in drafted outreach — specs are
 *  never paraphrased by the LLM. */
export const SPECIFIC_ASK_MARKER = '🎯 Specific ask';

/** Build the Notes text, surfacing the Needs-Review flag (no dedicated Notion column exists). */
function buildNotes(input: BankRowInput): string {
  const lines: string[] = ['Auto-enriched by /sponsor.'];
  if (input.contact) {
    const c = input.contact;
    const source =
      c.verificationStatus === 'provided'
        ? 'provided by requester'
        : `Hunter: ${c.verificationStatus}, confidence ${c.confidence}`;
    lines.push(`Contact (${source}): ${c.name || '(no name)'} <${c.email || 'no email'}>.`);
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
function readMultiSelect(prop: any): string[] {
  return (prop?.multi_select ?? []).map((o: any) => o?.name).filter((n: any): n is string => typeof n === 'string');
}
function readEmail(prop: any): string {
  return typeof prop?.email === 'string' ? prop.email : '';
}
function readUrl(prop: any): string {
  return typeof prop?.url === 'string' ? prop.url : '';
}
function readRelationCount(prop: any): number {
  return (prop?.relation ?? []).length;
}

function parseBankRow(page: any): BankLeadRow {
  const p = page?.properties ?? {};
  const contactName = readRichText(p['Contact name']);
  const contactEmail = readEmail(p['Contact email']);
  const categories = readMultiSelect(p['Category']) as Category[];
  return {
    id: page.id,
    url: page.url,
    company: readTitle(p['Company']),
    status: readSelect(p['Status']),
    type: (readSelect(p['Type']) as SponsorType) ?? 'Cash',
    categories: categories.length ? categories : ['General'],
    domain: readUrl(p['Domain']),
    fitReason: readRichText(p['Fit reason']),
    suggestedAngle: readRichText(p['Suggested angle']),
    contact:
      contactName || contactEmail
        ? { name: contactName, email: contactEmail, verificationStatus: 'from bank', confidence: 0 }
        : null,
    hasPipelineDeal: readRelationCount(p['Pipeline deal']) > 0,
    scores: {
      contactStrength: readNumber(p['Contact strength']),
      marketFit: readNumber(p['Market fit']),
      sponsorsOtherTeams: readNumber(p['Sponsors other teams']),
      valueBand: readNumber(p['Value band']),
      categoryNeed: readNumber(p['Category need']),
    },
  };
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
   * parsed lead (so a directed add can graduate it) if one exists, else null. The caller
   * passes an already-normalized `https://<domain>` string so this is an exact match.
   */
  async findBankRowByDomain(canonicalDomain: string): Promise<BankLeadRow | null> {
    const response: any = await this.client.dataSources.query({
      data_source_id: config.sponsorship.bankDataSourceId,
      filter: { property: 'Domain', url: { equals: canonicalDomain } },
      page_size: 1,
    });

    const hit = (response.results ?? [])[0];
    return hit ? parseBankRow(hit) : null;
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
      Status: { select: { name: input.status ?? 'Available' } },
      Relationship: { select: { name: 'New' } },
      // Tier is no longer written — it's a Notion formula derived from Priority.
      // We seed the three AI sub-scores; Contact strength + Sponsors other teams are
      // left blank for a human to fill (guardrail: the LLM never guesses those).
      'Market fit': { number: c.marketFit },
      'Value band': { number: c.valueBand },
      'Category need': { number: c.categoryNeed },
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
    if (input.claimedByNotionIds?.length) {
      properties['Claimed by'] = { people: input.claimedByNotionIds.map((id) => ({ id })) };
    }

    const result: any = await this.client.pages.create({
      parent: { type: 'data_source_id', data_source_id: config.sponsorship.bankDataSourceId },
      properties: properties as any,
    });

    logger.info(`Created Bank row for ${input.company} (${input.domain}): ${result.url}`);
    return { id: result.id, url: result.url };
  }

  /** Find Bank leads whose Company title contains `name` (for `/sponsor claim`). */
  async findBankRowsByCompany(name: string): Promise<BankLeadRow[]> {
    const response: any = await this.client.dataSources.query({
      data_source_id: config.sponsorship.bankDataSourceId,
      filter: { property: 'Company', title: { contains: name } },
      page_size: 25,
    });
    return (response.results ?? []).map(parseBankRow);
  }

  /**
   * Rankable prospects for `/sponsor rank`: every live Bank lead (excludes Dead and
   * already-Graduated rows), optionally filtered to one Category. Returns them parsed
   * with their sub-scores; the caller computes Priority + sorts (the Priority formula
   * isn't queryable/sortable via the API — see scoring.ts). Follows pagination.
   */
  async queryRankableProspects(category?: Category): Promise<BankLeadRow[]> {
    const conditions: any[] = [
      { property: 'Status', select: { does_not_equal: 'Dead' } },
      { property: 'Status', select: { does_not_equal: 'Graduated' } },
    ];
    if (category) conditions.push({ property: 'Category', multi_select: { contains: category } });

    const rows: BankLeadRow[] = [];
    let cursor: string | undefined;
    do {
      const response: any = await this.client.dataSources.query({
        data_source_id: config.sponsorship.bankDataSourceId,
        filter: { and: conditions },
        start_cursor: cursor,
        page_size: 100,
      });
      for (const page of response.results ?? []) rows.push(parseBankRow(page));
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);
    return rows;
  }

  /**
   * Set one or more priority sub-scores on a Bank row (powers `/sponsor score`).
   * Only the provided sub-scores are written; the rest are left untouched. The
   * Fit/Impact/Priority/Quadrant/Tier formulas recompute automatically in Notion.
   */
  async updateBankScores(pageId: string, scores: Partial<SponsorScores>): Promise<void> {
    const colByKey: Record<keyof SponsorScores, string> = {
      contactStrength: 'Contact strength',
      marketFit: 'Market fit',
      sponsorsOtherTeams: 'Sponsors other teams',
      valueBand: 'Value band',
      categoryNeed: 'Category need',
    };
    const properties: Record<string, any> = {};
    for (const key of Object.keys(colByKey) as (keyof SponsorScores)[]) {
      const value = scores[key];
      if (typeof value === 'number') properties[colByKey[key]] = { number: value };
    }
    if (Object.keys(properties).length === 0) return;
    await this.client.pages.update({ page_id: pageId, properties: properties as any });
    logger.info(`Updated scores on Bank row ${pageId}: ${Object.keys(properties).join(', ')}.`);
  }

  /** Mark a Bank lead claimed/graduated and set its owner(s). */
  async markBankClaimed(pageId: string, notionIds: string[], status: BankStatus): Promise<void> {
    await this.client.pages.update({
      page_id: pageId,
      properties: {
        Status: { select: { name: status } },
        'Claimed by': { people: notionIds.map((id) => ({ id })) },
      } as any,
    });
    logger.info(`Bank lead ${pageId} → ${status}, claimed by ${notionIds.join(', ')}.`);
  }

  // --- Pipeline ---------------------------------------------------------------

  /**
   * Open a Pipeline deal at Stage = Prospect, owned by the given DRI(s), linked to its
   * Bank row via the (dual) Bank source relation. Carries Type/Category/contact across
   * from enrichment. Source defaults to Cold; a next action + due date seed the nudge.
   */
  async createPipelineDeal(input: PipelineDealInput): Promise<BankPageRef> {
    const properties: Record<string, any> = {
      Company: { title: [{ text: { content: input.company.slice(0, 200) } }] },
      Stage: { select: { name: 'Prospect' } },
      Relationship: { select: { name: 'New' } },
      Source: { select: { name: 'Cold' } },
      Type: { select: { name: input.type } },
      Category: { multi_select: input.categories.map((name) => ({ name })) },
      DRI: { people: input.driNotionIds.map((id) => ({ id })) },
      'Bank source': { relation: [{ id: input.bankPageId }] },
      'Next action': { rich_text: [{ text: { content: input.nextAction.slice(0, 200) } }] },
      'Next action date': { date: { start: input.nextActionDateIso } },
    };
    if (input.contact) {
      if (input.contact.name) {
        properties['Contact name'] = { rich_text: [{ text: { content: input.contact.name } }] };
      }
      properties['Contact email'] = { email: input.contact.email };
    }

    const result: any = await this.client.pages.create({
      parent: { type: 'data_source_id', data_source_id: config.sponsorship.pipelineDataSourceId },
      properties: properties as any,
    });

    logger.info(`Opened Pipeline deal for ${input.company} (DRI ${input.driNotionIds.join(', ')}): ${result.url}`);
    return { id: result.id, url: result.url };
  }

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

  /** Deals flagged Reply pending by the Phase-3 flow — awaiting a DRI DM. */
  async queryReplyPending(): Promise<PipelineRow[]> {
    return this.queryPipeline({ property: 'Reply pending', checkbox: { equals: true } });
  }

  /** Clear the Reply pending flag once the DRI has been DM'd. */
  async clearReplyPending(pageId: string): Promise<void> {
    await this.client.pages.update({
      page_id: pageId,
      properties: { 'Reply pending': { checkbox: false } } as any,
    });
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
   * Mark a deal Won: Stage=Won, Received ($)=amount (the live counter), and Deal value
   * if it was blank. Stamps Last contact and prepends a dated WON note. The #operations
   * win post is triggered separately (by the command or the hourly job).
   */
  async markWon(row: PipelineRow, amountUsd: number, note: string, dateIso: string): Promise<void> {
    const properties: Record<string, any> = {
      Stage: { select: { name: 'Won' } },
      'Received ($)': { number: amountUsd },
      'Last contact': { date: { start: dateIso } },
    };
    if (row.dealValue == null) properties['Deal value ($)'] = { number: amountUsd };
    if (note) {
      const merged = `${dateIso}: WON — ${note}${row.notes ? `\n${row.notes}` : ''}`;
      properties['Notes'] = { rich_text: [{ text: { content: merged.slice(0, 1900) } }] };
    }
    await this.client.pages.update({ page_id: row.id, properties: properties as any });
    logger.info(`Marked WON: ${row.company} ($${amountUsd}).`);
  }

  /** Move a deal to any Stage and stamp Last contact. */
  async setStage(row: PipelineRow, stage: Stage, dateIso: string): Promise<void> {
    await this.client.pages.update({
      page_id: row.id,
      properties: {
        Stage: { select: { name: stage } },
        'Last contact': { date: { start: dateIso } },
      } as any,
    });
    logger.info(`Set stage ${stage}: ${row.company} (${row.id}).`);
  }

  // --- Page content (email template + drafts) ----------------------------------

  /**
   * Plain-text paragraphs of a page's body — used to read the team's outreach email
   * template live, so ops can edit the template in Notion without a redeploy. Every
   * block with rich text (paragraph, heading, quote…) becomes one paragraph string;
   * formatting is intentionally dropped (the draft is a plain-text email).
   */
  async fetchPageParagraphs(pageId: string): Promise<string[]> {
    const paragraphs: string[] = [];
    let cursor: string | undefined;
    do {
      const response: any = await this.client.blocks.children.list({
        block_id: pageId,
        start_cursor: cursor,
        page_size: 100,
      });
      for (const block of response.results ?? []) {
        const rich = block?.[block?.type]?.rich_text;
        if (!Array.isArray(rich)) continue;
        const text = rich.map((t: any) => t?.plain_text ?? '').join('').trim();
        if (text) paragraphs.push(text);
      }
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);
    return paragraphs;
  }

  /**
   * Recursively read a block's children as indented plain-text bullet lines
   * (depth-capped). Notion returns only one level per children.list call, so nested
   * bullets — sub-specs like a gear's bore diameter — require recursion or they'd be
   * silently dropped.
   */
  private async readBlockLines(blockId: string, depth: number): Promise<string[]> {
    if (depth > 3) return [];
    const lines: string[] = [];
    let cursor: string | undefined;
    do {
      const response: any = await this.client.blocks.children.list({
        block_id: blockId,
        start_cursor: cursor,
        page_size: 100,
      });
      for (const block of response.results ?? []) {
        const rich = block?.[block?.type]?.rich_text;
        if (Array.isArray(rich)) {
          const text = rich.map((t: any) => t?.plain_text ?? '').join('').trim();
          if (text) lines.push(`${'  '.repeat(depth)}- ${text}`);
        }
        if (block?.has_children) {
          lines.push(...(await this.readBlockLines(block.id, depth + 1)));
        }
      }
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);
    return lines;
  }

  /**
   * Read the `🎯 Specific ask` toggle from a Bank row's page, if present, as verbatim
   * bullet-line text ('' when there is no ask). Humans paste detailed multi-line specs
   * under the toggle in Notion; `/sponsor ask` creates/replaces it from Slack.
   */
  async fetchAskSection(pageId: string): Promise<string> {
    let cursor: string | undefined;
    do {
      const response: any = await this.client.blocks.children.list({
        block_id: pageId,
        start_cursor: cursor,
        page_size: 100,
      });
      for (const block of response.results ?? []) {
        const rich = block?.[block?.type]?.rich_text;
        if (!Array.isArray(rich)) continue;
        const text = rich.map((t: any) => t?.plain_text ?? '').join('');
        if (text.startsWith(SPECIFIC_ASK_MARKER) && block?.has_children) {
          return (await this.readBlockLines(block.id, 0)).join('\n');
        }
      }
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);
    return '';
  }

  /**
   * Create/replace the `🎯 Specific ask` toggle on a Bank row (powers `/sponsor ask`).
   * Each input line becomes one bullet under the toggle; people then refine the
   * details in Notion. Same replace-the-marker-toggle pattern as writeDraftEmail.
   */
  async writeAskSection(pageId: string, ask: string): Promise<{ blockId: string }> {
    const staleIds: string[] = [];
    let cursor: string | undefined;
    do {
      const response: any = await this.client.blocks.children.list({
        block_id: pageId,
        start_cursor: cursor,
        page_size: 100,
      });
      for (const block of response.results ?? []) {
        const rich = block?.toggle?.rich_text;
        if (!Array.isArray(rich)) continue;
        const text = rich.map((t: any) => t?.plain_text ?? '').join('');
        if (text.startsWith(SPECIFIC_ASK_MARKER)) staleIds.push(block.id);
      }
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);
    for (const id of staleIds) {
      await this.client.blocks.delete({ block_id: id });
    }

    const lines = ask
      .split('\n')
      .map((l) => l.replace(/^\s*[-•]\s*/, '').trim())
      .filter(Boolean);
    const result: any = await this.client.blocks.children.append({
      block_id: pageId,
      children: [
        {
          type: 'toggle',
          toggle: {
            rich_text: [
              { type: 'text', text: { content: `${SPECIFIC_ASK_MARKER} — included verbatim in drafted outreach` } },
            ],
            children: lines.map((l) => ({
              type: 'bulleted_list_item',
              bulleted_list_item: { rich_text: [{ type: 'text', text: { content: l.slice(0, 1900) } }] },
            })),
          },
        },
      ] as any,
    });

    const blockId: string = result?.results?.[0]?.id ?? '';
    logger.info(`Wrote specific-ask toggle on ${pageId} (${lines.length} lines).`);
    return { blockId };
  }

  /**
   * Write the draft email onto a Bank row's page body as a single toggle block
   * (`📧 Draft email — …`) holding one paragraph block per email paragraph.
   * Regenerating replaces the previous draft: any existing toggle starting with the
   * marker is deleted first (a toggle groups the draft atomically, so deletion can't
   * take out unrelated notes someone added to the page). Returns the toggle's block
   * id so callers can deep-link to it (page URL + `#<id without dashes>`).
   */
  async writeDraftEmail(pageId: string, title: string, paragraphs: string[]): Promise<{ blockId: string }> {
    const staleDraftIds: string[] = [];
    let cursor: string | undefined;
    do {
      const response: any = await this.client.blocks.children.list({
        block_id: pageId,
        start_cursor: cursor,
        page_size: 100,
      });
      for (const block of response.results ?? []) {
        const rich = block?.toggle?.rich_text;
        if (!Array.isArray(rich)) continue;
        const text = rich.map((t: any) => t?.plain_text ?? '').join('');
        if (text.startsWith(DRAFT_EMAIL_MARKER)) staleDraftIds.push(block.id);
      }
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);
    for (const id of staleDraftIds) {
      await this.client.blocks.delete({ block_id: id });
    }

    const result: any = await this.client.blocks.children.append({
      block_id: pageId,
      children: [
        {
          type: 'toggle',
          toggle: {
            rich_text: [{ type: 'text', text: { content: title.slice(0, 200) } }],
            children: paragraphs.map((p) => ({
              type: 'paragraph',
              paragraph: { rich_text: [{ type: 'text', text: { content: p.slice(0, 1900) } }] },
            })),
          },
        },
      ] as any,
    });

    const blockId: string = result?.results?.[0]?.id ?? '';
    logger.info(`Wrote draft email toggle on ${pageId} (${paragraphs.length} paragraphs).`);
    return { blockId };
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

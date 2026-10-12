import { Client } from '@notionhq/client';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { alnum } from './rank.js';
import type { Candidate } from './types.js';

/**
 * "Add to Purchasing" — turns one /parts option into a Purchasing (PEFS) row, so it shows
 * up in the normal flow (PEFS Ready? → /benbuys prep for DigiKey/McMaster).
 *
 * Writes only columns that exist with the expected type (the schema is read once, like
 * arrivals/notion.ts), so a renamed column is skipped with a warning instead of failing.
 * Payment Method is set to BenBuys only for DigiKey / McMaster links (that's how the team
 * orders from them); everything else is left for the requester to pick, along with
 * Subsystem — `PEFS Ready?` keeps flagging the row until it's complete.
 */

/** Column → Notion property type this writer produces. The title column is found by type. */
export const COLUMNS = {
  partNumber: ['Cat. or model no.', 'rich_text'],
  quantity: ['Quant.', 'number'],
  unitCost: ['Unit cost', 'number'],
  link: ['Link to product webpage', 'url'],
  season: ['Season', 'select'],
  vendor: ['Vendor', 'rich_text'],
  pointOfContact: ['Point of contact', 'people'],
  notes: ['Notes (internal)', 'rich_text'],
  paymentMethod: ['Payment Method', 'select'],
} as const;

const BENBUYS_DOMAINS = /(^|\.)(digikey\.com|digi-key\.com|mcmaster\.com)$/i;

export interface RowContext {
  /** The /parts text, e.g. "LM7805". */
  part: string;
  season: string;
  pointOfContactNotionId: string | null;
  /** Slack display name of whoever clicked, for the notes line. */
  addedBy: string;
  today?: Date;
}

export interface PurchasingDraft {
  name: string;
  partNumber: string;
  quantity: number;
  unitCost: number;
  link: string;
  vendor: string;
  notes: string;
  paymentMethod: string | null;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** 2 decimals, or up to 4 for sub-dollar unit prices (0.0425). */
const money = (n: number) => (n >= 1 ? n.toFixed(2) : String(Number(n.toFixed(4))));

/**
 * What the row will say. Pack listings are ordered in packs, so Quant. = packs and Unit
 * cost = price per pack (Quant. × Unit cost stays the order subtotal); a bulk price tier
 * is per unit, so Quant. = units at the tier price.
 */
export function draftRow(c: Candidate, ctx: RowContext): PurchasingDraft {
  const byPack = c.packSize > 1 && c.cost !== null;
  const quantity = byPack ? c.packsNeeded : c.qty;
  const unitCost = byPack ? c.cost! : c.unitCost ?? c.cost ?? 0;
  // The seller's catalog number if the LLM found one, else the part number typed in /parts.
  const typed = ctx.part.split(/\s+/).find((w) => /\d/.test(w)) ?? ctx.part;
  const partNumber = c.partNumber && alnum(c.partNumber) ? c.partNumber : typed;
  const date = (ctx.today ?? new Date()).toISOString().slice(0, 10);
  const cur = c.currency && c.currency !== 'USD' ? ` ${c.currency}` : '';
  const notes = [
    `Added from /parts "${ctx.part}" by ${ctx.addedBy} on ${date}.`,
    byPack ? `Sold in packs of ${c.packSize}: ${quantity} pack(s) = ${quantity * c.packSize} units for ${c.qty} needed.` : '',
    `Found at $${money(unitCost)}${cur}${byPack ? '/pack' : '/unit'}` +
      (c.shippingCost ? `, shipping ${c.shippingCost}` : '') +
      (c.shippingTime ? `, ${c.shippingTime}` : '') +
      (c.score !== null ? `, score ${c.score.toFixed(2)}` : '') + '.',
    c.notes.length ? `Flags: ${c.notes.join('; ')}.` : '',
    'Price read by an LLM from the listing; check it before ordering.',
  ].filter(Boolean).join(' ');
  return {
    name: (c.productName || c.pageTitle || c.title || partNumber).slice(0, 200),
    partNumber,
    quantity,
    unitCost,
    link: c.url,
    vendor: c.supplier ?? hostname(c.url).replace(/^www\./, ''),
    notes: notes.slice(0, 1900),
    paymentMethod: BENBUYS_DOMAINS.test(hostname(c.url)) ? 'BenBuys' : null,
  };
}

const richText = (content: string) => ({ rich_text: [{ text: { content } }] });

/**
 * Notion `properties` for the draft, limited to columns present in `schema` (name → type).
 * Returns the columns that were wanted but missing / of another type.
 */
export function buildProperties(draft: PurchasingDraft, ctx: RowContext, schema: Record<string, string>): { properties: Record<string, any>; skipped: string[] } {
  const properties: Record<string, any> = {};
  const skipped: string[] = [];
  const titleColumn = Object.keys(schema).find((k) => schema[k] === 'title');
  if (titleColumn) properties[titleColumn] = { title: [{ text: { content: draft.name } }] };
  else skipped.push('title');

  const values: Record<keyof typeof COLUMNS, any> = {
    partNumber: richText(draft.partNumber),
    quantity: { number: draft.quantity },
    unitCost: { number: draft.unitCost },
    link: { url: draft.link },
    season: ctx.season ? { select: { name: ctx.season } } : undefined,
    vendor: draft.vendor ? richText(draft.vendor) : undefined,
    pointOfContact: ctx.pointOfContactNotionId ? { people: [{ id: ctx.pointOfContactNotionId }] } : undefined,
    notes: richText(draft.notes),
    paymentMethod: draft.paymentMethod ? { select: { name: draft.paymentMethod } } : undefined,
  };
  for (const [key, [column, type]] of Object.entries(COLUMNS) as [keyof typeof COLUMNS, readonly [string, string]][]) {
    const value = values[key];
    if (value === undefined) continue;
    if (schema[column] === type) properties[column] = value;
    else skipped.push(column);
  }
  return { properties, skipped };
}

export class PartsNotion {
  private client: Client;
  private schema: Promise<Record<string, string>> | null = null;

  constructor(token: string = config.notion.token, private dataSourceId: string = config.benbuys.purchasingDataSourceId) {
    this.client = new Client({ auth: token, notionVersion: config.notion.apiVersion });
  }

  private columns(): Promise<Record<string, string>> {
    if (!this.schema) {
      this.schema = (this.client.dataSources.retrieve({ data_source_id: this.dataSourceId }) as Promise<any>)
        .then((ds) => Object.fromEntries(Object.entries<any>(ds?.properties ?? {}).map(([name, p]) => [name, p?.type ?? ''])))
        .catch((err) => {
          this.schema = null; // retry on the next add
          throw err;
        });
    }
    return this.schema;
  }

  /** Create the Purchasing row; returns its URL and any columns that couldn't be written. */
  async addCandidate(c: Candidate, ctx: RowContext): Promise<{ id: string; url: string; skipped: string[]; paymentMethod: string | null }> {
    const draft = draftRow(c, ctx);
    const { properties, skipped } = buildProperties(draft, ctx, await this.columns());
    if (skipped.length) logger.warn(`Part finder: Purchasing DB columns skipped (missing or different type): ${skipped.join(', ')}`);
    const page: any = await this.client.pages.create({
      parent: { type: 'data_source_id', data_source_id: this.dataSourceId },
      properties,
    } as any);
    return { id: page.id, url: page.url ?? '', skipped, paymentMethod: properties['Payment Method'] ? draft.paymentMethod : null };
  }

  /** Workspace people (Slack clicker → Notion `Point of contact`). */
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

import { Client } from '@notionhq/client';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { escapeMrkdwn, money, type PriceSwapValue } from './blocks.js';
import type { LedgerEvent, PriceRow } from './swap.js';

/**
 * 💸 Price Check Savings: the ledger behind "how much has the price check saved us".
 *
 * One Notion row per alert. The price listener (PER-Purchasing) writes it as Pending when it
 * DMs the alert; PERBot updates it when someone taps Use / Keep / Undo, and a sweep marks a
 * Used row Realized once the Purchasing row is ordered (Exported?) at that price. A click on
 * an alert the listener didn't log (sent before the ledger existed) creates the row here.
 *
 *   Saved $      (Old − Used unit cost) × Quant. on a Used row, else 0. Negative = a price
 *                increase accepted, i.e. a budget correction, reported apart from savings.
 *   Potential $  (Old − Offered unit cost) × Quant. at alert time: what the alert could save.
 *
 * Prices are in the row's own units (per pack on pack rows) and Quant. counts those units,
 * so both totals are plain dollars. A row is matched by Row ID + Old unit cost + Quant.: the
 * same fields the listener's one-alert-per-(row, price, quantity) Job Log key uses.
 */

export type Outcome = 'Pending' | 'Used' | 'Kept' | 'Undone' | 'Refused';

export interface LedgerRow {
  id: string;
  name: string;
  outcome: Outcome;
  saved: number;
  potential: number;
  realized: boolean;
  supplier: string;
  season: string;
  created: string;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** A Notion page id in its dashed form, whichever form it came in. */
export function dashedId(id: string): string {
  const h = id.replace(/-/g, '').toLowerCase();
  return h.length === 32 ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : id;
}

const rt = (s: string) => ({ rich_text: s ? [{ type: 'text', text: { content: s.slice(0, 2000) } }] : [] });
const dateProp = (d: Date | null) => ({ date: d ? { start: d.toISOString() } : null });

/** Properties for a ledger row PERBot has to create itself (the listener didn't log the alert). */
export function newRowProps(v: PriceSwapValue, row: PriceRow): Record<string, any> {
  const label = row.name || row.part || 'Purchasing row';
  const props: Record<string, any> = {
    Name: { title: [{ type: 'text', text: { content: `${label} ×${v.q}`.slice(0, 2000) } }] },
    Outcome: { select: { name: 'Pending' } },
    'Old unit cost': { number: v.o },
    'Quant.': { number: v.q },
    'Row ID': rt(dashedId(v.r)),
    Part: rt(row.part ?? ''),
    Supplier: rt(v.s ?? ''),
  };
  if (row.url) props['Purchasing row'] = { url: row.url };
  if (row.season) props.Season = { select: { name: row.season } };
  if (v.n !== undefined) {
    props['Offered unit cost'] = { number: v.n };
    props['Potential $'] = { number: round2((v.o - v.n) * v.q) };
    props.Direction = { select: { name: v.n < v.o ? 'Drop' : 'Rise' } };
  }
  if (v.l) props.Listing = { url: v.l };
  return props;
}

/** The update a click makes, or null when it shouldn't change the row (see record()). */
export function eventProps(e: LedgerEvent, who: string, current: Outcome | null): Record<string, any> | null {
  // A stale alert's refused Use mustn't overwrite what an earlier click already decided.
  if (e.kind === 'refused' && current && current !== 'Pending') return null;
  const v = e.value;
  const base = { 'Clicked by': rt(who), 'Clicked at': dateProp(e.at) };
  switch (e.kind) {
    case 'used': {
      if (v.n === undefined) return null;
      const props: Record<string, any> = {
        ...base,
        Outcome: { select: { name: 'Used' } },
        'Used unit cost': { number: v.n },
        'Saved $': { number: round2((v.o - v.n) * v.q) },
        Direction: { select: { name: v.n < v.o ? 'Drop' : 'Rise' } },
        Realized: { checkbox: false },
      };
      if (v.s) props.Supplier = rt(v.s);
      if (v.l) props.Listing = { url: v.l };
      return props;
    }
    case 'undone':
      return { ...base, Outcome: { select: { name: 'Undone' } }, 'Used unit cost': { number: null }, 'Saved $': { number: 0 }, Realized: { checkbox: false }, 'Ordered at': dateProp(null) };
    case 'kept':
      return { ...base, Outcome: { select: { name: 'Kept' } }, 'Saved $': { number: 0 } };
    case 'refused':
      return { ...base, Outcome: { select: { name: 'Refused' } } };
  }
}

export function parseLedgerRow(page: any): LedgerRow {
  const p = page?.properties ?? {};
  const text = (prop: any) => (prop?.title ?? prop?.rich_text ?? []).map((t: any) => t?.plain_text ?? '').join('');
  return {
    id: page.id,
    name: text(p.Name),
    outcome: (p.Outcome?.select?.name ?? 'Pending') as Outcome,
    saved: p['Saved $']?.number ?? 0,
    potential: p['Potential $']?.number ?? 0,
    realized: Boolean(p.Realized?.checkbox),
    supplier: text(p.Supplier),
    season: p.Season?.select?.name ?? '',
    created: page.created_time ?? '',
  };
}

// --- Stats --------------------------------------------------------------------------------------

export type Period = 'week' | 'season' | 'all';

export interface Summary {
  alerts: number;
  counts: Record<Outcome, number>;
  /** Accepted price drops: total saved, and how much of it was ordered at the new price. */
  saved: number;
  savedCount: number;
  realized: number;
  realizedCount: number;
  /** Accepted price increases (budget corrections), as a positive amount. */
  increases: number;
  increasesCount: number;
  /** Price drops offered but not taken (no answer yet, or Kept). */
  onTable: number;
  onTableCount: number;
  top: LedgerRow[];
}

export function inPeriod(r: LedgerRow, period: Period, season: string, now: Date): boolean {
  if (period === 'all') return true;
  if (period === 'season') return r.season === season;
  return Boolean(r.created) && now.getTime() - Date.parse(r.created) <= 7 * 24 * 3600 * 1000;
}

export function summarize(rows: LedgerRow[]): Summary {
  const counts: Record<Outcome, number> = { Pending: 0, Used: 0, Kept: 0, Undone: 0, Refused: 0 };
  const s: Summary = { alerts: rows.length, counts, saved: 0, savedCount: 0, realized: 0, realizedCount: 0, increases: 0, increasesCount: 0, onTable: 0, onTableCount: 0, top: [] };
  for (const r of rows) {
    counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
    if (r.outcome === 'Used' && r.saved > 0) {
      s.saved += r.saved;
      s.savedCount++;
      if (r.realized) {
        s.realized += r.saved;
        s.realizedCount++;
      }
    } else if (r.outcome === 'Used' && r.saved < 0) {
      s.increases -= r.saved;
      s.increasesCount++;
    } else if ((r.outcome === 'Pending' || r.outcome === 'Kept') && r.potential > 0) {
      s.onTable += r.potential;
      s.onTableCount++;
    }
  }
  s.saved = round2(s.saved);
  s.realized = round2(s.realized);
  s.increases = round2(s.increases);
  s.onTable = round2(s.onTable);
  s.top = rows.filter((r) => r.outcome === 'Used' && r.saved > 0).sort((a, b) => b.saved - a.saved).slice(0, 3);
  return s;
}

const PERIOD_TITLE: Record<Period, (season: string) => string> = {
  week: () => 'last 7 days',
  season: (season) => `${season} season`,
  all: () => 'all time',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function statsText(s: Summary, period: Period, season: string, ledgerUrl: string): string {
  const title = `*💸 Price check savings: ${PERIOD_TITLE[period](season)}*`;
  if (!s.alerts) return `${title}\nNo price alerts ${period === 'week' ? 'this week' : 'yet'}.`;
  const answered = s.alerts - s.counts.Pending;
  const lines = [
    title,
    `• *$${money(s.saved)} saved* on ${plural(s.savedCount, 'accepted price drop')}` +
      (s.savedCount ? ` ($${money(s.realized)} realized: ${plural(s.realizedCount, 'order')} placed at the new price)` : ''),
    s.increasesCount ? `• $${money(s.increases)} of price increases caught before ordering (${plural(s.increasesCount, 'row')})` : '',
    `• ${plural(s.alerts, 'alert')}: ${s.counts.Used} used · ${s.counts.Kept} kept · ${s.counts.Undone} undone` +
      (s.counts.Refused ? ` · ${s.counts.Refused} stale` : '') +
      ` · ${s.counts.Pending} no answer yet` +
      (answered ? ` (${Math.round((s.counts.Used / answered) * 100)}% of answered alerts used)` : ''),
    s.onTableCount ? `• $${money(s.onTable)} still on the table: ${plural(s.onTableCount, 'price drop')} not taken` : '',
  ];
  if (s.top.length) {
    lines.push('*Top saves*');
    s.top.forEach((r, i) => lines.push(`${i + 1}. ${escapeMrkdwn(r.name)}: $${money(r.saved)}${r.supplier ? ` (${escapeMrkdwn(r.supplier)})` : ''}`));
  }
  if (ledgerUrl) lines.push(`<${ledgerUrl}|Open the ledger in Notion>`);
  return lines.filter(Boolean).join('\n');
}

// --- Notion -------------------------------------------------------------------------------------

export class PriceLedger {
  private client: any;

  constructor(
    private dataSourceId: string = config.priceCheck.ledgerDataSourceId,
    client?: any
  ) {
    this.client = client ?? new Client({ auth: config.notion.token, notionVersion: config.notion.apiVersion });
  }

  get enabled(): boolean {
    return Boolean(this.dataSourceId);
  }

  private async query(filter: any, pageSize = 100, max = Infinity): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | undefined;
    do {
      const res: any = await this.client.dataSources.query({ data_source_id: this.dataSourceId, filter, page_size: pageSize, start_cursor: cursor });
      out.push(...res.results);
      cursor = res.has_more && out.length < max ? res.next_cursor : undefined;
    } while (cursor);
    return out;
  }

  /** The alert's ledger row (newest if a row somehow has two), or null. */
  async find(v: PriceSwapValue): Promise<any | null> {
    const rows = await this.query(
      {
        and: [
          { property: 'Row ID', rich_text: { equals: dashedId(v.r) } },
          { property: 'Old unit cost', number: { equals: v.o } },
          { property: 'Quant.', number: { equals: v.q } },
        ],
      },
      5,
      5
    );
    return rows.sort((a, b) => Date.parse(b.created_time) - Date.parse(a.created_time))[0] ?? null;
  }

  /**
   * Write a click to the ledger: update the alert's row, creating it first when the listener
   * didn't log it. Test alerts (`x`) are skipped. Returns what happened, for the log.
   */
  async record(e: LedgerEvent, who: string, fetchRow: (id: string) => Promise<PriceRow>): Promise<string> {
    if (!this.enabled) return 'ledger off';
    if (e.value.x) return 'test alert, not logged';
    let page = await this.find(e.value);
    const current = page ? parseLedgerRow(page).outcome : null;
    const props = eventProps(e, who, current);
    if (!props) return `kept ${current}`;
    if (!page) {
      page = await this.client.pages.create({ parent: { type: 'data_source_id', data_source_id: this.dataSourceId }, properties: newRowProps(e.value, await fetchRow(e.value.r)) });
    }
    await this.client.pages.update({ page_id: page.id, properties: props });
    return `${current ?? 'new'} → ${e.kind}`;
  }

  async rows(): Promise<LedgerRow[]> {
    return (await this.query(undefined)).map(parseLedgerRow);
  }

  /**
   * Mark Used rows Realized once their Purchasing row is ordered (Exported?) with Unit cost
   * still at the price that was used. Returns how many were marked.
   */
  async sweepRealized(fetchRow: (id: string) => Promise<PriceRow>, now: Date = new Date()): Promise<number> {
    if (!this.enabled) return 0;
    const open = await this.query({ and: [{ property: 'Outcome', select: { equals: 'Used' } }, { property: 'Realized', checkbox: { equals: false } }] });
    let marked = 0;
    for (const page of open) {
      const p = page.properties ?? {};
      const rowId = (p['Row ID']?.rich_text ?? []).map((t: any) => t.plain_text).join('');
      const used = p['Used unit cost']?.number;
      if (!rowId || typeof used !== 'number') continue;
      try {
        const row = await fetchRow(rowId);
        if (row.deleted || !row.exported || row.unitCost === null || Math.abs(row.unitCost - used) > 1e-6) continue;
        await this.client.pages.update({ page_id: page.id, properties: { Realized: { checkbox: true }, 'Ordered at': dateProp(now) } });
        marked++;
      } catch (err) {
        logger.warn(`Price check ledger: couldn't check row ${rowId} for Realized`, err);
      }
    }
    return marked;
  }
}

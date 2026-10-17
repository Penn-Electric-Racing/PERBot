import { nowTimeET } from '../sponsorship/dates.js';
import {
  actionKind,
  decodeValue,
  escapeMrkdwn,
  money,
  replaceActions,
  resultBlocks,
  type PriceSwapValue,
} from './blocks.js';

/**
 * What a price-check button click does — pure apart from the injected Notion/Slack calls, so
 * it's tested without either (actions.ts wires the real ones).
 *
 * Use: re-read the row and write the alert's price only if the row still reads what the
 * alert saw (same Unit cost and Quant., not yet ordered); otherwise say what changed and
 * write nothing. Writing Unit cost fires the price listener's webhook, so the row is re-priced
 * against the new value and stays quiet when it now matches. Keep: no write. Undo: the
 * reverse write, under the same guards, for a day.
 */

/** One run of a Notion rich-text value, kept only when every run is plain text (see readTextRuns). */
export interface TextRun {
  content: string;
  link: string | null;
  annotations?: any;
}

export interface PriceRow {
  id: string;
  unitCost: number | null;
  quantity: number | null;
  link: string;
  exported: boolean;
  deleted: boolean;
  /** `Notes (internal)` runs; null when it holds mentions/equations we won't rewrite. */
  notes: TextRun[] | null;
}

export interface RowPatch {
  unitCost: number;
  /** undefined = leave the link alone; null = clear it. */
  link?: string | null;
  /** undefined = leave the notes alone. */
  notes?: TextRun[];
}

export type Plan =
  | { kind: 'write'; unitCost: number; link?: string | null }
  | { kind: 'already' }
  | { kind: 'refuse'; reason: string };

const EPS = 1e-6;
const UNDO_WINDOW_S = 24 * 3600;
const NOTE_PREFIX = 'PERBot price check:';
const NOTION_RICH_TEXT_MAX_RUNS = 100;

const sameMoney = (a: number | null, b: number) => a !== null && Math.abs(a - b) < EPS;
const normUrl = (u: string | null | undefined) => (u ?? '').trim().replace(/\/+$/, '');

/** Whether clicking `kind` should write, and what. `v.n` must be set (use/undo values carry it). */
export function planSwap(kind: 'use' | 'undo', v: PriceSwapValue & { n: number }, row: PriceRow): Plan {
  if (row.deleted) return { kind: 'refuse', reason: 'This Purchasing row was deleted, so nothing was changed.' };
  if (row.exported) return { kind: 'refuse', reason: 'This row is already ordered (*Exported?* is checked), so *Unit cost* was left as is.' };
  if (row.quantity !== v.q) {
    return { kind: 'refuse', reason: `*Quant.* changed since this alert (now ${row.quantity ?? 'blank'}), so nothing was changed. The row gets re-priced on its own.` };
  }
  const [from, to] = kind === 'use' ? [v.o, v.n] : [v.n, v.o];
  const toLink = v.l === undefined ? undefined : kind === 'use' ? v.l : v.ol || null;
  const linkDone = toLink === undefined || normUrl(row.link) === normUrl(toLink);
  if (sameMoney(row.unitCost, to) && linkDone) return { kind: 'already' };
  // Price already at the target but the link isn't (edited by hand halfway): finish the job.
  if (!sameMoney(row.unitCost, from) && !sameMoney(row.unitCost, to)) {
    const now = row.unitCost === null ? 'blank' : `$${money(row.unitCost)}`;
    return { kind: 'refuse', reason: `*Unit cost* is now ${now} in Notion (changed since this alert), so nothing was changed.` };
  }
  return toLink === undefined ? { kind: 'write', unitCost: to } : { kind: 'write', unitCost: to, link: toLink };
}

/** The audit line a Use click leaves in `Notes (internal)`; Undo removes it by its prefix. */
export function noteLine(v: PriceSwapValue & { n: number }, who: string, dateIso: string): string {
  const supplier = v.s ? ` (${v.s})` : '';
  const link = v.l !== undefined ? ', product link updated' : '';
  return `${notePrefix(v)}${supplier}${link} via Slack, ${who}, ${dateIso}`;
}
function notePrefix(v: PriceSwapValue & { n: number }): string {
  return `${NOTE_PREFIX} Unit cost $${money(v.o)} → $${money(v.n)}`;
}

/** Plain-text runs of a rich_text property, or null if any run isn't plain text. */
export function readTextRuns(prop: any): TextRun[] | null {
  const runs: TextRun[] = [];
  for (const r of prop?.rich_text ?? []) {
    if (r?.type !== 'text' || typeof r?.text?.content !== 'string') return null;
    runs.push({ content: r.text.content, link: r.text.link?.url ?? null, ...(r.annotations ? { annotations: r.annotations } : {}) });
  }
  return runs;
}

export function toRichText(runs: TextRun[]): any[] {
  return runs.map((r) => ({
    type: 'text',
    text: { content: r.content, link: r.link ? { url: r.link } : null },
    ...(r.annotations ? { annotations: r.annotations } : {}),
  }));
}

/** `runs` plus `line` on its own line, or null when Notion's 100-run cap leaves no room. */
export function appendLine(runs: TextRun[], line: string): TextRun[] | null {
  if (runs.length >= NOTION_RICH_TEXT_MAX_RUNS) return null;
  const hasText = runs.some((r) => r.content.length > 0);
  return [...runs, { content: (hasText ? '\n' : '') + line, link: null }];
}

/**
 * `runs` without a last line that starts with `prefix` (and the newline before it), keeping
 * every other run's formatting; null when the last line isn't ours (someone edited after).
 */
export function dropLastLine(runs: TextRun[], prefix: string): TextRun[] | null {
  const full = runs.map((r) => r.content).join('');
  const nl = full.lastIndexOf('\n');
  if (!full.slice(nl + 1).startsWith(prefix)) return null;
  let keep = Math.max(nl, 0);
  const out: TextRun[] = [];
  for (const r of runs) {
    if (keep <= 0) break;
    const content = r.content.slice(0, keep);
    keep -= content.length;
    if (content) out.push({ ...r, content });
  }
  return out;
}

export interface PriceSwapDeps {
  fetchRow(id: string): Promise<PriceRow>;
  writeRow(id: string, patch: RowPatch): Promise<void>;
  /** The clicker's name for the Notion audit line (null → "a Slack user"). */
  displayName(slackUserId: string): Promise<string | null>;
  now(): Date;
}

export interface ClickInput {
  actionId: string;
  rawValue: string | undefined;
  clicker: string;
  /** The message's current blocks (body.message.blocks); absent on some containers. */
  existing: any[] | undefined;
}

export interface ClickResult {
  /** Rewrite the message to these blocks (replace_original). */
  blocks?: any[];
  /** Plain-text fallback for the rewritten message. */
  text?: string;
  /** Tell only the clicker (ephemeral), leaving the message as is. */
  whisper?: string;
  /** For the log. */
  log: string;
}

const etDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

function settle(existing: any[] | undefined, text: string, undo?: PriceSwapValue): ClickResult {
  if (!existing) return { whisper: text.replace(/\*/g, ''), log: text };
  return { blocks: replaceActions(existing, resultBlocks(text, undo)), text: text.replace(/\*/g, ''), log: text };
}

export async function handlePriceSwap(deps: PriceSwapDeps, input: ClickInput): Promise<ClickResult> {
  const kind = actionKind(input.actionId);
  const value = decodeValue(input.rawValue);
  if (!kind || !value) return { whisper: 'This button is out of date. Update *Unit cost* in Notion instead.', log: `bad value on ${input.actionId}` };
  const who = `<@${input.clicker}>`;
  const time = nowTimeET(deps.now());

  if (kind === 'keep') return settle(input.existing, `👍 ${who} kept $${money(value.o)}, so Notion wasn't changed · ${time}`);

  if (value.n === undefined) return { whisper: 'This button has no price on it. Update *Unit cost* in Notion instead.', log: 'use/undo without n' };
  const v = value as PriceSwapValue & { n: number };
  if (kind === 'undo' && v.t !== undefined && deps.now().getTime() / 1000 - v.t > UNDO_WINDOW_S) {
    return { whisper: 'Too late to undo from here. Change *Unit cost* in Notion.', log: 'undo expired' };
  }

  const row = await deps.fetchRow(v.r);
  const plan = planSwap(kind, v, row);
  if (plan.kind === 'refuse') return settle(input.existing, `⚠️ ${plan.reason}`);
  if (plan.kind === 'already') {
    const price = money(kind === 'use' ? v.n : v.o);
    return settle(input.existing, `✅ *Unit cost* is already $${price} in Notion.`);
  }

  const patch: RowPatch = { unitCost: plan.unitCost, ...(plan.link !== undefined ? { link: plan.link } : {}) };
  if (row.notes) {
    const notes =
      kind === 'use'
        ? appendLine(row.notes, noteLine(v, (await deps.displayName(input.clicker)) ?? 'a Slack user', etDate(deps.now())))
        : dropLastLine(row.notes, notePrefix(v));
    if (notes) patch.notes = notes;
  }
  await deps.writeRow(v.r, patch);

  const supplier = v.s ? ` (${escapeMrkdwn(v.s)})` : '';
  if (kind === 'use') {
    const link = v.l !== undefined ? ' and updated the product link' : '';
    const undo: PriceSwapValue = { ...v, t: Math.floor(deps.now().getTime() / 1000) };
    return settle(input.existing, `✅ ${who} set *Unit cost* to *$${money(v.n)}*${supplier}${link} · was $${money(v.o)} · ${time}`, undo);
  }
  const link = v.l !== undefined ? ' and restored the product link' : '';
  return settle(input.existing, `↩️ ${who} undid it: *Unit cost* is back to *$${money(v.o)}*${link} · ${time}`);
}

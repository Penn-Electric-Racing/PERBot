import type { ArrivalRow, Extraction, SlipMatch } from './types.js';
import { vendorKey } from './match.js';

/**
 * Block Kit for the thread reply under a packing-slip photo, plus the button value codec.
 * Pure. Replies name the requester, vendor, and items only — never prices (the extraction
 * doesn't read them, and Notion's cost columns are never rendered).
 *
 * Buttons:
 *   every row the slip shows is the whole open order → [✅ Confirm arrived] [Wrong order]
 *   the slip shows part of an order                  → [✅ These N arrived] [📦 All M arrived] [Wrong order]
 * Rows that aren't on the slip are only marked by "All M arrived", so a partial shipment
 * leaves the rest of the order at `Arrived? = No` — that IS the partial-shipment record.
 */

export const ARRIVAL_ACTION_IDS = {
  these: 'arrival_these',
  all: 'arrival_all',
  wrong: 'arrival_wrong',
} as const;
export const ARRIVAL_ACTION_RE = /^arrival_(these|all|wrong)$/;
export const ARRIVAL_ACTIONS_BLOCK = 'arrival_actions';

/** Slack caps a button value at 2000 chars. */
const MAX_VALUE_CHARS = 2000;
const MAX_LISTED = 15;

export interface ArrivalButtonValue {
  /** Slack user who posted the photo (→ Received by). */
  u: string;
  /** ts of the photo message (→ Arrived at, photo permalink). */
  ts: string;
  /** Run ID whose rows are included, minus `x`. */
  g?: string;
  x?: string[];
  /** Row ids included explicitly. */
  r?: string[];
}

const compact = (id: string) => id.replace(/-/g, '');

export function encodeValue(v: ArrivalButtonValue): string {
  return JSON.stringify(v);
}

export function decodeValue(raw: string | undefined): ArrivalButtonValue | null {
  try {
    const v = JSON.parse(raw ?? '');
    if (typeof v?.u !== 'string' || typeof v?.ts !== 'string') return null;
    const ids = (a: unknown) => (Array.isArray(a) ? a.filter((s): s is string => typeof s === 'string') : undefined);
    return { u: v.u, ts: v.ts, g: typeof v.g === 'string' ? v.g : undefined, x: ids(v.x), r: ids(v.r) };
  } catch {
    return null;
  }
}

/** The row ids a click covers, given the current rows of `g` (fetched at click time). */
export function targetIds(v: ArrivalButtonValue, runRowIds: string[]): string[] {
  const excluded = new Set((v.x ?? []).map(compact));
  const ids = new Set(runRowIds.map(compact).filter((id) => !excluded.has(id)));
  for (const id of v.r ?? []) ids.add(compact(id));
  return [...ids];
}

/**
 * "These N arrived" as the shorter of two encodings: the explicit matched ids, or the order
 * minus the rows the slip didn't show (a 90-of-93 slip would otherwise overflow 2000 chars).
 */
export function theseValue(match: SlipMatch, base: { u: string; ts: string }): ArrivalButtonValue {
  const matched = new Set(match.matchedRows.map((r) => r.id));
  const explicit: ArrivalButtonValue = { ...base, r: [...matched].map(compact) };
  if (!match.runId) return explicit;
  const extras = match.matchedRows.filter((r) => r.runId !== match.runId).map((r) => compact(r.id));
  const missing = match.orderRows.filter((r) => !matched.has(r.id)).map((r) => compact(r.id));
  const complement: ArrivalButtonValue = { ...base, g: match.runId, x: missing, ...(extras.length ? { r: extras } : {}) };
  return encodeValue(complement).length < encodeValue(explicit).length ? complement : explicit;
}

function allValue(match: SlipMatch, base: { u: string; ts: string }): ArrivalButtonValue {
  const extras = match.matchedRows.filter((r) => r.runId !== match.runId).map((r) => compact(r.id));
  return { ...base, g: match.runId!, ...(extras.length ? { r: extras } : {}) };
}

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? full;
}

function possessive(rows: ArrivalRow[]): string {
  const names = [...new Set(rows.flatMap((r) => r.pointOfContact).map(firstName).filter(Boolean))];
  if (names.length === 0) return 'an';
  const shown = names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(' and ');
  return `*${shown}*'s`;
}

export function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

function earliest(values: (string | null)[]): string | null {
  return values.filter((v): v is string => !!v).sort()[0] ?? null;
}

function vendorLabel(rows: ArrivalRow[], extraction: Extraction): string {
  return rows.find((r) => r.vendor)?.vendor || extraction.vendor || 'vendor';
}

function itemLine(row: ArrivalRow): string {
  const full = (row.name || row.partNumber).replace(/[<>|*_~`]/g, '').trim();
  const name = full.length <= 60 ? full : `${full.slice(0, 60).replace(/[\s,;(]+\S*$/, '')}…`;
  const qty = row.quantity > 0 ? ` ×${row.quantity}` : '';
  return row.url ? `• <${row.url}|${name}>${qty}` : `• ${name}${qty}`;
}

function button(text: string, actionId: string, value: ArrivalButtonValue, style?: 'primary' | 'danger'): any | null {
  const encoded = encodeValue(value);
  if (encoded.length > MAX_VALUE_CHARS) return null;
  return { type: 'button', text: { type: 'plain_text', text, emoji: true }, action_id: actionId, value: encoded, ...(style ? { style } : {}) };
}

export interface Reply {
  text: string;
  blocks: any[];
}

const SLIP_PLEASE =
  'To log it in Purchasing, reply here with a photo of the *packing slip* from inside the box (the sheet that lists part numbers), flat and in focus.';

export function buildReply(extraction: Extraction, match: SlipMatch, base: { u: string; ts: string }): Reply {
  // Most photos in the channel are the outside of the box: a label, no item lines. Ask for the slip
  // in the thread (thread replies are read too) rather than reporting a non-match.
  const labelOnly = match.lines.length === 0 && match.orderRows.length === 0;
  if (!extraction.isShippingDocument || !extraction.legible || labelOnly) {
    const lead = extraction.legible && extraction.isShippingDocument ? ':package: Got the label.' : ':camera: I couldn’t read part numbers in this one.';
    return { text: 'Packing slip photo needed', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${lead} ${SLIP_PLEASE}` } }] };
  }

  const unmatchedLines = match.lines.filter((l) => !l.row);
  const unmatchedPns = unmatchedLines
    .map((l) => l.line.vendorPartNumber ?? l.line.manufacturerPartNumber ?? l.line.customerReference)
    .filter((s): s is string => !!s);

  if (match.matchedRows.length === 0 && match.orderRows.length === 0) {
    const vendor = extraction.vendor ? `*${extraction.vendor}* ` : '';
    const text =
      `:grey_question: Read a ${vendor}slip with ${match.lines.length} item${match.lines.length === 1 ? '' : 's'}, ` +
      'but nothing on it matches an open row in Purchasing. Nothing was written — if it’s ours, mark it in Notion.';
    const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text } }];
    if (unmatchedPns.length) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `On the slip: ${unmatchedPns.slice(0, 8).join(', ')}` }] });
    }
    return { text: 'No matching open order for that packing slip.', blocks };
  }

  const contextRows = match.orderRows.length ? match.orderRows : match.matchedRows;
  const date = shortDate(earliest(contextRows.map((r) => r.orderedAt ?? r.submittedAt)));
  const order = `${possessive(contextRows)} *${vendorLabel(contextRows, extraction)}* order${date ? ` from *${date}*` : ''}`;
  const n = match.matchedRows.length;
  const total = match.orderRows.length;
  const wholeOrder = !match.runId || match.orderRows.every((r) => match.matchedRows.some((m) => m.id === r.id));

  let headline: string;
  if (match.confidence === 'exact') {
    headline = `:package: This is ${order} — the requisition number is on the slip. *${n} of ${total}* items matched by part number.`;
  } else if (match.confidence === 'weak') {
    headline = `:package: Best guess: ${order}, but only *${n} of ${match.lines.length}* slip lines matched an open row. Check before confirming.`;
  } else {
    headline = `:package: Looks like ${order}: *${n} of ${wholeOrder ? n : total}* items on this slip.`;
  }

  const listed = match.matchedRows.slice(0, MAX_LISTED).map(itemLine);
  if (match.matchedRows.length > MAX_LISTED) listed.push(`• …and ${match.matchedRows.length - MAX_LISTED} more`);

  const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text: headline } }];
  if (listed.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: listed.join('\n') } });

  const notes: string[] = [];
  if (!wholeOrder) notes.push(`${total - n} more item${total - n === 1 ? '' : 's'} on this order not in this box`);
  if (unmatchedPns.length) notes.push(`not found in Purchasing: ${unmatchedPns.slice(0, 6).join(', ')}${unmatchedPns.length > 6 ? '…' : ''}`);
  if (notes.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: notes.join(' · ') }] });

  const buttons = wholeOrder
    ? [button('Confirm arrived', ARRIVAL_ACTION_IDS.these, theseValue(match, base), 'primary')]
    : [
        n ? button(`These ${n} arrived`, ARRIVAL_ACTION_IDS.these, theseValue(match, base), 'primary') : null,
        button(`All ${total} arrived`, ARRIVAL_ACTION_IDS.all, allValue(match, base)),
      ];
  buttons.push(button('Wrong order', ARRIVAL_ACTION_IDS.wrong, base));
  const elements = buttons.filter(Boolean);
  if (elements.length > 1) blocks.push({ type: 'actions', block_id: ARRIVAL_ACTIONS_BLOCK, elements });
  else blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Too many items to confirm from Slack — mark them in Notion.' }] });

  return { text: `Packing slip: ${n} item${n === 1 ? '' : 's'} matched`, blocks };
}

function daysBetween(fromIso: string, toIso: string): number {
  const ms = new Date(toIso).getTime() - new Date(fromIso.length === 10 ? `${fromIso}T12:00:00Z` : fromIso).getTime();
  return Math.max(0, Math.round(ms / 86_400_000));
}

/** "Ordered Sep 28 → here Oct 10 (12 days) · requested Sep 20 (20 days end to end)". */
export function leadTimeLine(rows: ArrivalRow[], arrivedAtIso: string): string | null {
  const ordered = earliest(rows.map((r) => r.orderedAt));
  const requested = earliest(rows.map((r) => r.submittedAt));
  const parts: string[] = [];
  if (ordered) parts.push(`ordered ${shortDate(ordered)} → here ${shortDate(arrivedAtIso)} (*${daysBetween(ordered, arrivedAtIso)} days*)`);
  if (requested) parts.push(`requested ${shortDate(requested)} (*${daysBetween(requested, arrivedAtIso)} days* end to end)`);
  if (!parts.length) return null;
  const line = parts.join(' · ');
  return line[0]!.toUpperCase() + line.slice(1);
}

/** Swap the buttons for a one-line outcome, keeping the rest of the reply. */
export function settleBlocks(blocks: any[], outcome: string): any[] {
  const kept = blocks.filter((b) => b?.block_id !== ARRIVAL_ACTIONS_BLOCK);
  return [...kept, { type: 'context', elements: [{ type: 'mrkdwn', text: outcome }] }];
}

/** Two slips from the same vendor are the same package only if they share a tracking number. */
export function packageKey(extraction: Extraction): string | null {
  const tracking = extraction.trackingNumbers.map((t) => t.replace(/\s+/g, '').toUpperCase()).sort()[0];
  return tracking ? `${vendorKey(extraction.vendor)}:${tracking}` : null;
}

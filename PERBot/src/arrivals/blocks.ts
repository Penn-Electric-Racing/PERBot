import type { ArrivalRow, OpenOrder, Resolution, Scan, SlipMatch } from './types.js';
import { vendorDisplay, vendorKey, vendorsCompatible } from './match.js';

/**
 * Block Kit for the thread reply under a delivery photo, plus the button value codec. Pure.
 * Replies name requesters, vendors, and items only — never prices (the scan doesn't read them,
 * and Notion's cost columns are never rendered).
 *
 * One section per package the photo resolved:
 *   match  → the rows it shows. Whole order: [✅ Confirm arrived] [Wrong order];
 *            part of one: [✅ These N arrived] [📦 All M arrived] [Wrong order]
 *   choose → vendor known, order not: up to 3 likely orders as buttons + [None of these]
 * Rows not tapped stay `Arrived? = No` — that IS the partial-shipment record.
 *
 * When to say nothing (from #packages history, where most photos are banter, pickup proof, or
 * piles of boxes): not a delivery; a thread reply without a specific match; anything unresolved
 * except a top-level label/slip, which gets one nudge to post the packing slip.
 */

export const ARRIVAL_ACTION_IDS = {
  these: 'arrival_these',
  all: 'arrival_all',
  order: 'arrival_order',
  wrong: 'arrival_wrong',
} as const;
/** Buttons in one block need distinct action ids, so pick-list buttons carry a `:n` suffix. */
export const ARRIVAL_ACTION_RE = /^arrival_(these|all|order|wrong)(?::\d+)?$/;
export const ACTIONS_BLOCK_PREFIX = 'arrival_actions:';

/** Slack caps a button value at 2000 chars. */
const MAX_VALUE_CHARS = 2000;
const MAX_LISTED = 15;
const MAX_PACKAGES = 4;
const MAX_CHOICES = 3;

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

type Base = { u: string; ts: string };

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
export function theseValue(match: SlipMatch, base: Base): ArrivalButtonValue {
  const matched = new Set(match.matchedRows.map((r) => r.id));
  const explicit: ArrivalButtonValue = { ...base, r: [...matched].map(compact) };
  if (!match.runId) return explicit;
  const extras = match.matchedRows.filter((r) => r.runId !== match.runId).map((r) => compact(r.id));
  const missing = match.orderRows.filter((r) => !matched.has(r.id)).map((r) => compact(r.id));
  const complement: ArrivalButtonValue = { ...base, g: match.runId, x: missing, ...(extras.length ? { r: extras } : {}) };
  return encodeValue(complement).length < encodeValue(explicit).length ? complement : explicit;
}

/** A whole order: by Run ID when it has one (rows re-read at click time), else its row ids. */
export function orderValue(rows: ArrivalRow[], runId: string | null, base: Base, extras: ArrivalRow[] = []): ArrivalButtonValue {
  const extraIds = extras.map((r) => compact(r.id));
  if (runId) return { ...base, g: runId, ...(extraIds.length ? { r: extraIds } : {}) };
  return { ...base, r: [...new Set([...rows.map((r) => compact(r.id)), ...extraIds])] };
}

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? full;
}

function names(requesters: string[], max = 2): string {
  const first = [...new Set(requesters.map(firstName).filter(Boolean))];
  if (first.length === 0) return '';
  return first.length > max ? `${first.slice(0, max).join(', ')} +${first.length - max}` : first.join(' and ');
}

/** "*Mike*'s *DigiKey* order from *Oct 5*" / "the *DigiKey* order from *Oct 5*". */
function orderPhrase(rows: ArrivalRow[], vendor: string, date: string | null): string {
  const who = names(rows.flatMap((r) => r.pointOfContact));
  return `${who ? `*${who}*'s` : 'the'} *${vendor}* order${date ? ` from *${date}*` : ''}`;
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

function clean(s: string, max: number): string {
  const full = s.replace(/[<>|*_~`]/g, '').replace(/\s+/g, ' ').trim();
  return full.length <= max ? full : `${full.slice(0, max).replace(/[\s,;(]+\S*$/, '')}…`;
}

function itemLine(row: ArrivalRow): string {
  const name = clean(row.name || row.partNumber, 60);
  const qty = row.quantity > 0 ? ` ×${row.quantity}` : '';
  return row.url ? `• <${row.url}|${name}>${qty}` : `• ${name}${qty}`;
}

function button(text: string, actionId: string, value: ArrivalButtonValue, style?: 'primary' | 'danger'): any | null {
  const encoded = encodeValue(value);
  if (encoded.length > MAX_VALUE_CHARS) return null;
  return { type: 'button', text: { type: 'plain_text', text: text.slice(0, 75), emoji: true }, action_id: actionId, value: encoded, ...(style ? { style } : {}) };
}

function actions(index: number, elements: (any | null)[]): any {
  const present = elements.filter(Boolean);
  if (present.length <= 1) return { type: 'context', elements: [{ type: 'mrkdwn', text: 'Too many items to confirm from Slack — mark them in Notion.' }] };
  return { type: 'actions', block_id: `${ACTIONS_BLOCK_PREFIX}${index}`, elements: present };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function matchBlocks(index: number, match: SlipMatch, evidence: string | null, vendorHint: string | null, base: Base): any[] {
  const contextRows = match.orderRows.length ? match.orderRows : match.matchedRows;
  const date = shortDate(earliest(contextRows.map((r) => r.orderedAt ?? r.submittedAt)));
  // The label's spelling when it agrees with Notion ("Eurotech Distributors" over "eurotech direct"); Notion's when
  // the label names someone else (a UPS Store re-ship, a fulfiller).
  const rowVendor = match.matchedRows.find((r) => r.vendor)?.vendor || contextRows.find((r) => r.vendor)?.vendor || '';
  const agree = !!vendorHint && (!rowVendor || vendorsCompatible(vendorKey(vendorHint), vendorKey(rowVendor)));
  const titled = /[A-Z]/.test(rowVendor) ? rowVendor : rowVendor.replace(/(^|\s)[a-z]/g, (c) => c.toUpperCase());
  const vendor = clean(vendorDisplay(agree ? vendorHint : titled) || 'vendor', 40);
  const order = orderPhrase(contextRows, vendor, date);
  const n = match.matchedRows.length;
  const total = match.orderRows.length;
  const matched = new Set(match.matchedRows.map((r) => r.id));
  const wholeOrder = match.orderRows.every((r) => matched.has(r.id));
  const extras = match.matchedRows.filter((r) => !match.orderRows.some((o) => o.id === r.id));

  let headline: string;
  if (match.confidence === 'exact') {
    headline = `:package: This is ${order} — the requisition number is on the slip. *${n} of ${total}* items matched by part number.`;
  } else if (evidence) {
    headline = `:package: Probably ${order}: *${n} of ${wholeOrder ? n : total}* items.`;
  } else if (match.confidence === 'weak') {
    headline = `:package: Best guess: ${order}, but only *${n} of ${match.lines.length}* slip lines matched an open row. Check before confirming.`;
  } else {
    headline = `:package: Looks like ${order}: *${n} of ${wholeOrder ? n : total}* items on this slip.`;
  }

  const listed = match.matchedRows.slice(0, MAX_LISTED).map(itemLine);
  if (match.matchedRows.length > MAX_LISTED) listed.push(`• …and ${match.matchedRows.length - MAX_LISTED} more`);

  const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text: headline } }];
  if (listed.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: listed.join('\n') } });

  const unmatchedPns = match.lines
    .filter((l) => !l.row)
    .map((l) => l.line.vendorPartNumber ?? l.line.manufacturerPartNumber ?? l.line.customerReference)
    .filter((s): s is string => !!s);
  const notes: string[] = [];
  if (evidence) notes.push(`:mag: ${clean(evidence, 160)}`);
  if (!wholeOrder) notes.push(`${plural(total - match.orderRows.filter((r) => matched.has(r.id)).length, 'more item')} on this order not in this box`);
  if (unmatchedPns.length) notes.push(`not found in Purchasing: ${unmatchedPns.slice(0, 6).join(', ')}${unmatchedPns.length > 6 ? '…' : ''}`);
  if (notes.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: notes.join(' · ') }] });

  const buttons =
    wholeOrder || n === 0
      ? [
          n
            ? button('Confirm arrived', ARRIVAL_ACTION_IDS.these, theseValue(match, base), 'primary')
            : button(`All ${total} arrived`, ARRIVAL_ACTION_IDS.all, orderValue(match.orderRows, match.runId, base), 'primary'),
        ]
      : [
          button(`These ${n} arrived`, ARRIVAL_ACTION_IDS.these, theseValue(match, base), 'primary'),
          button(`All ${total} arrived`, ARRIVAL_ACTION_IDS.all, orderValue(match.orderRows, match.runId, base, extras)),
        ];
  buttons.push(button('Wrong order', ARRIVAL_ACTION_IDS.wrong, base));
  blocks.push(actions(index, buttons));
  return blocks;
}

function orderLabel(o: OpenOrder): string {
  const who = names(o.requesters, 1) || 'No requester';
  return `${who} · ${shortDate(o.date) ?? 'no date'} · ${plural(o.rows.length, 'item')}`;
}

function chooseBlocks(index: number, orders: OpenOrder[], vendor: string, base: Base): any[] {
  const shown = orders.slice(0, MAX_CHOICES);
  const v = clean(vendorDisplay(vendor) || vendor, 40);
  const only = shown[0]!;
  const who = names(only.rows.flatMap((r) => r.pointOfContact));
  const when = shortDate(only.date);
  const headline =
    shown.length === 1
      ? `:package: A *${v}* package. There’s one open ${v} order${who ? ` (*${who}*’s)` : ''}${when ? ` from *${when}*` : ''}. Is it this one?`
      : `:package: A *${v}* package. Which order is it?`;
  const lines = shown.map((o) => {
    const items = o.rows.slice(0, 3).map((r) => clean(r.name || r.partNumber, 40));
    const more = o.rows.length > 3 ? ` +${o.rows.length - 3}` : '';
    return `• *${orderLabel(o)}* — ${items.join(', ')}${more}`;
  });
  const buttons = shown.map((o, i) =>
    button(
      shown.length === 1 ? `Yes — ${plural(o.rows.length, 'item')} arrived` : orderLabel(o),
      `${ARRIVAL_ACTION_IDS.order}:${i}`,
      orderValue(o.rows, o.runId, base),
      shown.length === 1 ? 'primary' : undefined
    )
  );
  buttons.push(button(shown.length === 1 ? 'No' : 'None of these', ARRIVAL_ACTION_IDS.wrong, base));
  return [
    { type: 'section', text: { type: 'mrkdwn', text: headline } },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    actions(index, buttons),
  ];
}

export interface Reply {
  text: string;
  blocks: any[];
}

export interface ReplyContext extends Base {
  /** The photo was posted as a thread reply. */
  inThread: boolean;
  /** The message posted with the photo. */
  text?: string;
}

/** "Jlc picked up" names JLCPCB: the poster is talking about this vendor's delivery. */
export function textNamesVendor(text: string | undefined, vendor: string): boolean {
  const key = vendorKey(vendor);
  return !!key && (text ?? '').split(/[^A-Za-z0-9-]+/).some((w) => w.length >= 3 && vendorKey(w) === key);
}

const SLIP_PLEASE = 'If it’s ours, reply here with a photo of the *packing slip* from inside the box (the sheet that lists part numbers), or mark it in Notion.';

/** The thread reply for one delivery photo, or null to stay silent. */
export function buildReply(scan: Scan, resolutions: Resolution[], ctx: ReplyContext): Reply | null {
  if (scan.scene === 'not_a_delivery') return null;
  const base: Base = { u: ctx.u, ts: ctx.ts };

  // Pick-lists only at top level, and for a photo of a pile only when the message names the vendor
  // ("Jlc picked up"): otherwise a vendor alone isn't worth a prompt (pickup proof, "here's the haul").
  // One pick-list per vendor — two JLCPCB boxes don't need two identical questions.
  const chosen = new Set<string>();
  const sections: any[][] = [];
  for (const res of resolutions) {
    if (sections.length >= MAX_PACKAGES) break;
    const pkg = scan.packages[res.pkg];
    if (res.kind === 'match') sections.push(matchBlocks(sections.length, res.match, res.evidence, pkg?.vendor ?? null, base));
    if (res.kind !== 'choose' || ctx.inThread || chosen.has(vendorKey(res.vendor))) continue;
    if (scan.scene === 'several_packages' && !textNamesVendor(ctx.text, res.vendor)) continue;
    chosen.add(vendorKey(res.vendor));
    sections.push(chooseBlocks(sections.length, res.orders, res.vendor, base));
  }

  if (sections.length === 0) {
    const paperwork = scan.scene === 'packing_slip' || scan.scene === 'shipping_label';
    if (ctx.inThread || !paperwork) return null;
    const lead = scan.legible ? ':package: I couldn’t match this to an open order.' : ':camera: I couldn’t read the label.';
    return { text: 'Which order is this package?', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${lead} ${SLIP_PLEASE}` } }] };
  }

  const blocks: any[] = [];
  if (sections.length > 1) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `:package: ${sections.length} orders in this photo` }] });
  sections.forEach((s, i) => {
    if (i > 0) blocks.push({ type: 'divider' });
    blocks.push(...s);
  });
  return { text: sections.length > 1 ? `${sections.length} orders arrived — confirm them` : 'Package arrived — confirm the order', blocks };
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

/** Swap one package's buttons for a one-line outcome, keeping the rest of the reply. */
export function settleBlocks(blocks: any[], blockId: string, outcome: string): any[] {
  return blocks.map((b) => (b?.block_id === blockId ? { type: 'context', elements: [{ type: 'mrkdwn', text: outcome }] } : b));
}

/** Two photos of the same box share vendor + tracking number. */
export function packageKey(pkg: { vendor: string | null; trackingNumbers: string[] }): string | null {
  const tracking = pkg.trackingNumbers.map((t) => t.replace(/\s+/g, '').toUpperCase()).sort()[0];
  return tracking ? `${vendorKey(pkg.vendor)}:${tracking}` : null;
}

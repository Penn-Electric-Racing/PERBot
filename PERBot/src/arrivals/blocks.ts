import type { ArrivalRow, OpenOrder, Resolution, Scan, SlipMatch } from './types.js';
import { vendorDisplay, vendorKey, vendorsCompatible } from './match.js';

/**
 * Block Kit for the thread reply under a delivery photo, plus the button value codec. Pure.
 * Replies name requesters, vendors, and items only — never prices (the scan doesn't read them,
 * and Notion's cost columns are never rendered).
 *
 * One card per package the photo resolved — a single order, never a wall of candidates:
 *   headline   "Probably @Mike's Mouser order from Oct 5" (requesters @-mentioned, so the people
 *              who know what's in the box see it) or, vendor-only, "Is it @Mike's order from Oct 5?"
 *   items      the order's rows as checkboxes, the ones this box shows already ticked (≤ 10 rows;
 *              bigger orders fall back to a linked list + [These N arrived] [All M arrived])
 *   links      one line per row: Notion · product page (Slack doesn't make links inside a
 *              checkbox option clickable — a tap there toggles the box)
 *   actions    [Mark arrived] [Wrong order] [Other <vendor> orders… ▾]
 * Picking another order swaps the card in place; marking turns it into a receipt with [Undo].
 * Rows left unticked stay `Arrived? = No` — that IS the partial-shipment record.
 *
 * When to say nothing (from #packages history, where most photos are banter, pickup proof, or
 * piles of boxes): not a delivery; a thread reply without a specific match; anything unresolved
 * except a top-level label/slip, which gets one nudge to post the packing slip.
 */

export const ARRIVAL_ACTION_IDS = {
  these: 'arrival_these',
  all: 'arrival_all',
  /** Legacy pick-list buttons (`arrival_order:<i>`) on replies posted before cards. */
  order: 'arrival_order',
  wrong: 'arrival_wrong',
  /** Marks the ticked checkboxes of the card. */
  mark: 'arrival_mark',
  /** The checkboxes themselves — toggling one only needs an ack. */
  items: 'arrival_items',
  /** "Other <vendor> orders…" select — swaps the card to that order. */
  other: 'arrival_other',
  undo: 'arrival_undo',
} as const;
/** Buttons in one block need distinct action ids, so legacy pick-list buttons carry a `:n` suffix. */
export const ARRIVAL_ACTION_RE = /^arrival_(these|all|order|wrong|mark|items|other|undo)(?::\d+)?$/;
/** Every block of a card carries `arrival_<part>:<package index>`. */
const CARD_BLOCK_RE = /^arrival_(head|items|links|list|note|actions|done|choice|reminded):(\d+)/;
export const ACTIONS_BLOCK_PREFIX = 'arrival_actions:';
/** One section per candidate order in a pick-list: `arrival_choice:<package>:<order>`. */
export const CHOICE_BLOCK_PREFIX = 'arrival_choice:';

/** Slack caps a button value at 2000 chars. */
const MAX_VALUE_CHARS = 2000;
const MAX_LISTED = 15;
const MAX_PACKAGES = 4;
/** Slack's limit on checkbox options. */
const MAX_OPTIONS = 10;
const MAX_ALTERNATIVES = 10;
/** Items listed on a card too big for checkboxes. */
const CARD_LISTED = 8;

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
  /** `OpenOrder.key` of the card's order (to rebuild it after Undo, and for reminders). */
  k?: string;
  /** Undo only: when the rows were marked (epoch s), and which were `Ready for Pickup` before. */
  t?: number;
  p?: string[];
}

type Base = { u: string; ts: string };

/** Notion person name → Slack user id (see people.ts). */
export type People = Map<string, string>;

export const compact = (id: string) => id.replace(/-/g, '');

export function encodeValue(v: ArrivalButtonValue): string {
  return JSON.stringify(v);
}

export function decodeValue(raw: string | undefined): ArrivalButtonValue | null {
  try {
    const v = JSON.parse(raw ?? '');
    if (typeof v?.u !== 'string' || typeof v?.ts !== 'string') return null;
    const ids = (a: unknown) => (Array.isArray(a) ? a.filter((s): s is string => typeof s === 'string') : undefined);
    return {
      u: v.u,
      ts: v.ts,
      g: typeof v.g === 'string' ? v.g : undefined,
      x: ids(v.x),
      r: ids(v.r),
      k: typeof v.k === 'string' ? v.k : undefined,
      t: typeof v.t === 'number' ? v.t : undefined,
      p: ids(v.p),
    };
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

/**
 * "<@U1> and <@U2>" / "<@U1>, *Ana* +3" / "*Mike*" — requesters as Slack mentions where we know
 * them, so the reply pings the people who can tell what's in the box. At most `max` are named.
 */
export function who(requesters: string[], people?: People, max = 2): string {
  const unique = [...new Set(requesters.filter(Boolean))];
  if (unique.length === 0) return '';
  const shown = unique.slice(0, max).map((n) => (people?.get(n) ? `<@${people.get(n)}>` : `*${firstName(n)}*`));
  return unique.length > max ? `${shown.join(', ')} +${unique.length - max}` : shown.join(' and ');
}

/** "<@Mike>'s *DigiKey* order from *Oct 5*" / "the *DigiKey* order from *Oct 5*". */
function orderPhrase(rows: ArrivalRow[], vendor: string, date: string | null, people?: People): string {
  const whom = who(rows.flatMap((r) => r.pointOfContact), people);
  return `${whom ? `${whom}'s` : 'the'} *${vendor}* order${date ? ` from *${date}*` : ''}`;
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

/** A catalog number worth showing next to the name — what's printed on the bag ("SN74LVC245APWR"), not free text. */
function shownCode(row: ArrivalRow): string | null {
  const pn = row.partNumber.trim();
  if (!pn || pn.length > 30 || /\s/.test(pn) || !/\d/.test(pn)) return null;
  return row.name && row.name.toUpperCase().includes(pn.toUpperCase()) ? null : clean(pn, 30);
}

/** The row's product page, safe inside `<url|text>`; null when missing, not http(s), or absurdly long. */
function productUrl(row: ArrivalRow): string | null {
  const url = (row.link ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(url) || url.length > 500) return null;
  if (/^https?:\/\/([^/]+\.)?notion\.(so|site|com)\//i.test(url)) return null; // a Notion page pasted in as the product
  return url.replace(/\|/g, '%7C').replace(/>/g, '%3E').replace(/</g, '%3C');
}

/** "Mouser ↗" — the vendor's name for the product link (the link's host when the vendor is blank). */
function productLabel(row: ArrivalRow): string {
  const host = (row.link.match(/^https?:\/\/(?:www\.)?([^/:]+)/i)?.[1] ?? '').split('.').slice(-2, -1)[0] ?? '';
  return `${clean(vendorDisplay(row.vendor) || vendorDisplay(host) || 'Product page', 24)} ↗`;
}

/** "<product|Mouser ↗>", or "" without a product link. */
function productLink(row: ArrivalRow): string {
  const url = productUrl(row);
  return url ? `<${url}|${productLabel(row)}>` : '';
}

/** "• <notion|Bus Transceivers Single 8-bit…> `SN74LVC245APWR` ×2 · <product|Mouser ↗>" — the name links to the Purchasing row. */
function itemLine(row: ArrivalRow, max = 60): string {
  const name = clean(row.name || row.partNumber, max) || 'item';
  const code = shownCode(row);
  const qty = row.quantity > 0 ? ` ×${row.quantity}` : '';
  const product = productLink(row);
  return `• ${row.url ? `<${row.url}|${name}>` : name}${code ? ` \`${code}\`` : ''}${qty}${product ? ` · ${product}` : ''}`;
}

function button(text: string, actionId: string, value: ArrivalButtonValue, style?: 'primary' | 'danger'): any | null {
  const encoded = encodeValue(value);
  if (encoded.length > MAX_VALUE_CHARS) return null;
  return { type: 'button', text: { type: 'plain_text', text: text.slice(0, 75), emoji: true }, action_id: actionId, value: encoded, ...(style ? { style } : {}) };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A checkbox: "Bus Transceivers Single… `74LVC1T45GW` ×3" (Slack caps it at 75). No links — they don't click there. */
function option(row: ArrivalRow): any {
  const qty = row.quantity > 0 ? ` ×${row.quantity}` : '';
  const code = shownCode(row);
  const tail = `${code ? ` \`${code}\`` : ''}${qty}`;
  const name = clean(row.name || row.partNumber, Math.max(20, 72 - tail.length)) || 'item';
  const text = `${name}${tail}`.length <= 75 ? `${name}${tail}` : `${name}${qty}`;
  return { text: { type: 'mrkdwn', text }, value: compact(row.id) };
}

/** "`74LVC1T45GW,125`  <notion|Notion> · <product|Mouser ↗>" — one line per checkbox, in the same order. */
function linkLine(row: ArrivalRow): string | null {
  const code = shownCode(row);
  const what = code ? `\`${code}\`` : clean(row.name || row.partNumber, 32) || 'item';
  const notion = row.url && row.url.length <= 60 ? row.url : row.id ? `https://notion.so/${compact(row.id)}` : row.url;
  const links = [notion ? `<${notion}|Notion>` : '', productLink(row)].filter(Boolean);
  return links.length ? `${what}  ${links.join(' · ')}` : null;
}

/** "Theodor +7 · Sep 29 · Secondary and Inverter HVDC…" — plain text for a select option. */
function orderOptionLabel(o: OpenOrder): string {
  const first = o.rows[0] ? clean(o.rows[0].name || o.rows[0].partNumber, 30) : '';
  return [names(o.requesters, 1) || 'No contact', shortDate(o.date) ?? 'no date', plural(o.rows.length, 'item'), first].filter(Boolean).join(' · ');
}

function otherOrders(alternatives: OpenOrder[], vendor: string): any | null {
  const options = alternatives
    .filter((o) => o.key.length <= 150)
    .slice(0, MAX_ALTERNATIVES)
    .map((o) => ({ text: { type: 'plain_text', text: orderOptionLabel(o).slice(0, 75) }, value: o.key }));
  if (!options.length) return null;
  return { type: 'static_select', action_id: ARRIVAL_ACTION_IDS.other, placeholder: { type: 'plain_text', text: `Other ${vendor} orders (${options.length})…`.slice(0, 150) }, options };
}

export interface CardInput {
  headline: string;
  /** The order's open rows — what "all arrived" means. */
  rows: ArrivalRow[];
  /** Pre-ticked: the rows this box shows. */
  checked: ArrivalRow[];
  /** Matched rows from outside the order (ticked too). */
  extras?: ArrivalRow[];
  key: string | null;
  runId: string | null;
  vendor: string;
  notes?: string[];
  alternatives?: OpenOrder[];
  wrongLabel?: string;
}

/** One package's card. Block ids carry the package index so a tap settles only its own card. */
export function orderCard(index: number, card: CardInput, base: Base): any[] {
  const id = (part: string) => `arrival_${part}:${index}`;
  const extras = card.extras ?? [];
  const ticked = [...new Map([...card.checked, ...extras].map((r) => [r.id, r])).values()];
  const tickedIds = new Set(ticked.map((r) => r.id));
  const all = [...ticked, ...card.rows.filter((r) => !tickedIds.has(r.id))];
  const value: ArrivalButtonValue = { ...base, ...(card.key ? { k: card.key } : {}) };
  const notes = [...(card.notes ?? [])];
  const blocks: any[] = [{ type: 'section', block_id: id('head'), text: { type: 'mrkdwn', text: card.headline } }];
  const elements: (any | null)[] = [];

  const shown = all.length <= MAX_OPTIONS ? all : ticked.length && ticked.length <= MAX_OPTIONS ? ticked : null;
  if (shown) {
    const options = shown.map(option);
    const initial = options.filter((_o, i) => tickedIds.has(shown[i]!.id));
    blocks.push({
      type: 'actions',
      block_id: id('items'),
      elements: [{ type: 'checkboxes', action_id: ARRIVAL_ACTION_IDS.items, options, ...(initial.length ? { initial_options: initial } : {}) }],
    });
    // Context text caps at 3000 chars per element (long Amazon URLs): split across elements if needed.
    const linkTexts: any[] = [];
    for (const line of shown.map(linkLine).filter((l): l is string => !!l)) {
      const last = linkTexts[linkTexts.length - 1];
      if (last && last.text.length + line.length + 1 <= 3000) last.text += `\n${line}`;
      else if (line.length <= 3000) linkTexts.push({ type: 'mrkdwn', text: line });
    }
    if (linkTexts.length) blocks.push({ type: 'context', block_id: id('links'), elements: linkTexts.slice(0, 10) });
    elements.push(button('Mark arrived', ARRIVAL_ACTION_IDS.mark, value, 'primary'));
    if (shown.length < all.length) {
      notes.push(`${plural(all.length - shown.length, 'more item')} on this order not listed`);
      elements.push(button(`All ${card.rows.length} arrived`, ARRIVAL_ACTION_IDS.all, { ...orderValue(card.rows, card.runId, base, extras), ...(card.key ? { k: card.key } : {}) }));
    }
  } else {
    // Too many rows to tick one by one: list them and offer the two whole-set buttons.
    const listed = (ticked.length ? ticked : all).slice(0, CARD_LISTED).map((r) => itemLine(r));
    const more = (ticked.length ? ticked : all).length - listed.length;
    if (more > 0) listed.push(`• …and ${more} more`);
    blocks.push({ type: 'section', block_id: id('list'), text: { type: 'mrkdwn', text: listed.join('\n') } });
    const these = ticked.length && ticked.length < all.length
      ? button(`These ${ticked.length} arrived`, ARRIVAL_ACTION_IDS.these, { ...base, r: ticked.map((r) => compact(r.id)) }, 'primary')
      : null;
    elements.push(these, button(`All ${card.rows.length} arrived`, ARRIVAL_ACTION_IDS.all, orderValue(card.rows, card.runId, base, extras), these ? undefined : 'primary'));
  }

  elements.push(button(card.wrongLabel ?? 'Wrong order', ARRIVAL_ACTION_IDS.wrong, base));
  elements.push(otherOrders(card.alternatives ?? [], card.vendor));
  if (notes.length) blocks.push({ type: 'context', block_id: id('note'), elements: [{ type: 'mrkdwn', text: notes.join(' · ') }] });
  const present = elements.filter(Boolean);
  if (!present.some((e) => e.type === 'button' && e.action_id !== ARRIVAL_ACTION_IDS.wrong)) {
    blocks.push({ type: 'context', block_id: id('note'), elements: [{ type: 'mrkdwn', text: 'Too many items to confirm from Slack — mark them in Notion.' }] });
  }
  blocks.push({ type: 'actions', block_id: id('actions'), elements: present });
  return blocks;
}

function vendorName(rows: ArrivalRow[], hint: string | null): string {
  // The label's spelling when it agrees with Notion ("Eurotech Distributors" over "eurotech direct"); Notion's when
  // the label names someone else (a UPS Store re-ship, a fulfiller).
  const rowVendor = rows.find((r) => r.vendor)?.vendor || '';
  const agree = !!hint && (!rowVendor || vendorsCompatible(vendorKey(hint), vendorKey(rowVendor)));
  const titled = /[A-Z]/.test(rowVendor) ? rowVendor : rowVendor.replace(/(^|\s)[a-z]/g, (c) => c.toUpperCase());
  return clean(vendorDisplay(agree ? hint : titled) || 'vendor', 40);
}

/** A package matched to an order — by part numbers, a requisition number, or the model's grounded pick. */
export function matchCard(
  index: number,
  res: { match: SlipMatch; evidence: string | null; key?: string | null; alternatives?: OpenOrder[] },
  vendorHint: string | null,
  base: Base,
  people?: People
): any[] {
  const { match, evidence } = res;
  const contextRows = match.orderRows.length ? match.orderRows : match.matchedRows;
  const date = shortDate(earliest(contextRows.map((r) => r.orderedAt ?? r.submittedAt)));
  const vendor = vendorName([...match.matchedRows, ...contextRows], vendorHint);
  const order = orderPhrase(contextRows, vendor, date, people);
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

  const unmatchedPns = match.lines
    .filter((l) => !l.row)
    .map((l) => l.line.vendorPartNumber ?? l.line.manufacturerPartNumber ?? l.line.customerReference)
    .filter((s): s is string => !!s);
  const notes: string[] = [];
  if (evidence) notes.push(`:mag: ${clean(evidence, 160)}`);
  if (unmatchedPns.length) notes.push(`not found in Purchasing: ${unmatchedPns.slice(0, 6).join(', ')}${unmatchedPns.length > 6 ? '…' : ''}`);

  return orderCard(
    index,
    {
      headline,
      rows: match.orderRows.length ? match.orderRows : match.matchedRows,
      checked: n ? match.matchedRows.filter((r) => !extras.includes(r)) : match.orderRows,
      extras,
      key: res.key ?? null,
      runId: match.runId,
      vendor,
      notes,
      alternatives: res.alternatives,
    },
    base
  );
}

/** Vendor known, order not: the most plausible order as a card, the rest in the "Other … orders" select. */
export function guessCard(index: number, order: OpenOrder, alternatives: OpenOrder[], vendor: string, base: Base, people?: People, lead = ''): any[] {
  const v = clean(vendorDisplay(vendor) || vendor, 40);
  const whom = who(order.rows.flatMap((r) => r.pointOfContact), people);
  const when = shortDate(order.date);
  const headline = alternatives.length
    ? `${lead}:package: A *${v}* package. Is it ${whom ? `${whom}’s` : 'the'} order${when ? ` from *${when}*` : ''}?`
    : `${lead}:package: A *${v}* package. There’s one open ${v} order${whom ? ` (${whom}’s)` : ''}${when ? ` from *${when}*` : ''}. Is it this one?`;
  return orderCard(
    index,
    {
      headline,
      rows: order.rows,
      checked: order.rows,
      key: order.key,
      runId: order.runId,
      vendor: v,
      alternatives,
      wrongLabel: alternatives.length ? 'None of these' : 'No',
    },
    base
  );
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
  /** Requesters → Slack ids, for @-mentions. */
  people?: People;
}

/** "Jlc picked up" names JLCPCB: the poster is talking about this vendor's delivery. */
export function textNamesVendor(text: string | undefined, vendor: string): boolean {
  const key = vendorKey(vendor);
  return !!key && (text ?? '').split(/[^A-Za-z0-9-]+/).some((w) => w.length >= 3 && vendorKey(w) === key);
}

const SLIP_PLEASE = 'If it’s ours, reply here with a photo of the *packing slip* or a *bag label* (anything with part numbers), or mark it in Notion.';

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
    if (res.kind === 'match') sections.push(matchCard(sections.length, res, pkg?.vendor ?? null, base, ctx.people));
    if (res.kind !== 'choose' || ctx.inThread || chosen.has(vendorKey(res.vendor))) continue;
    if (scan.scene === 'several_packages' && !textNamesVendor(ctx.text, res.vendor)) continue;
    chosen.add(vendorKey(res.vendor));
    sections.push(guessCard(sections.length, res.orders[0]!, res.orders.slice(1), res.vendor, base, ctx.people));
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

/**
 * Settle one package after a tap: its buttons become a one-line outcome. In a pick-list the chosen
 * order stays (without its button) and the other candidates go; `chosen` is the tapped order's
 * index (`arrival_order:<i>`), absent for Wrong order / None of these. Other packages are untouched.
 */
export function settleBlocks(blocks: any[], blockId: string, outcome: string, chosen?: number): any[] {
  const pkgIndex = blockId.match(/^arrival_(?:actions|choice):(\d+)/)?.[1];
  if (pkgIndex === undefined) return blocks;
  const actionsId = `${ACTIONS_BLOCK_PREFIX}${pkgIndex}`;
  const choicePrefix = `${CHOICE_BLOCK_PREFIX}${pkgIndex}:`;
  const out: any[] = [];
  for (const b of blocks) {
    const id: string = b?.block_id ?? '';
    if (id === actionsId) out.push({ type: 'context', elements: [{ type: 'mrkdwn', text: outcome }] });
    else if (id.startsWith(choicePrefix)) {
      if (Number(id.slice(choicePrefix.length)) !== chosen) continue;
      const { accessory: _accessory, ...kept } = b;
      out.push(kept);
    } else out.push(b);
  }
  return out;
}

/** Two photos of the same box share vendor + tracking number. */
export function packageKey(pkg: { vendor: string | null; trackingNumbers: string[] }): string | null {
  const tracking = pkg.trackingNumbers.map((t) => t.replace(/\s+/g, '').toUpperCase()).sort()[0];
  return tracking ? `${vendorKey(pkg.vendor)}:${tracking}` : null;
}

/** The package index a card block belongs to (`arrival_items:2` → 2), or null for other blocks. */
export function cardIndex(blockId: string | undefined): number | null {
  const m = (blockId ?? '').match(CARD_BLOCK_RE);
  return m ? Number(m[2]) : null;
}

/** True when the message's card `index` is a new-style card (has a head block). */
export function isCard(blocks: any[], index: number): boolean {
  return blocks.some((b) => b?.block_id === `arrival_head:${index}`);
}

/** Swap card `index` for `replacement` in place (another order picked, or rebuilt after Undo). */
export function replaceCard(blocks: any[], index: number, replacement: any[]): any[] {
  const out: any[] = [];
  let inserted = false;
  for (const b of blocks) {
    if (cardIndex(b?.block_id) !== index) {
      out.push(b);
      continue;
    }
    if (!inserted) out.push(...replacement);
    inserted = true;
  }
  return inserted ? out : [...out, ...replacement];
}

/**
 * Settle card `index` after a tap. The headline stays; the checkboxes become a linked list of what
 * was marked; the buttons become the outcome line, plus [Undo] when there is something to undo.
 */
export function settleCard(blocks: any[], index: number, outcome: string, marked: ArrivalRow[] = [], undo: ArrivalButtonValue | null = null): any[] {
  const id = (part: string) => `arrival_${part}:${index}`;
  const out: any[] = [];
  let listed = false;
  for (const b of blocks) {
    const part = cardIndex(b?.block_id) === index ? (b.block_id as string).split(':')[0]!.replace('arrival_', '') : null;
    if (!part || part === 'head') {
      out.push(b);
    } else if ((part === 'items' || part === 'list') && !listed && marked.length) {
      const lines = marked.slice(0, MAX_LISTED).map((r) => itemLine(r));
      if (marked.length > MAX_LISTED) lines.push(`• …and ${marked.length - MAX_LISTED} more`);
      out.push({ type: 'section', block_id: id('list'), text: { type: 'mrkdwn', text: lines.join('\n') } });
      listed = true;
    } else if (part === 'actions') {
      out.push({ type: 'context', block_id: id('note'), elements: [{ type: 'mrkdwn', text: outcome }] });
      const undoButton = undo ? button('Undo', ARRIVAL_ACTION_IDS.undo, undo) : null;
      if (undoButton) out.push({ type: 'actions', block_id: id('done'), elements: [undoButton] });
    }
    // items/list (nothing marked), links, note, done, choice, reminded: dropped.
  }
  return out;
}

/** The DM a requester gets once their order is confirmed. */
export function arrivalDm(rows: ArrivalRow[], ctx: { clicker: string; poster: string; permalink: string | null; arrivedAtIso: string }): string {
  const vendor = vendorName(rows, null);
  const lines = rows.slice(0, 8).map((r) => itemLine(r, 50));
  if (rows.length > 8) lines.push(`• …and ${rows.length - 8} more`);
  const by = ctx.clicker === ctx.poster ? `<@${ctx.poster}>` : `<@${ctx.poster}> (confirmed by <@${ctx.clicker}>)`;
  const lead = leadTimeLine(rows, ctx.arrivedAtIso);
  return [
    `:package: Your *${vendor}* order is here — ${plural(rows.length, 'item')} received by ${by}:`,
    ...lines,
    ...(lead ? [lead] : []),
    ...(ctx.permalink ? [`<${ctx.permalink}|See the photo in #packages>`] : []),
  ].join('\n');
}

/** The one reminder a likely requester gets when a card sat untapped. */
export function reminderDm(order: OpenOrder, replyLink: string | null): string {
  const vendor = vendorName(order.rows, null);
  const items = order.rows.slice(0, 3).map((r) => clean(r.name || r.partNumber, 40)).join(', ');
  const more = order.rows.length > 3 ? ` +${order.rows.length - 3}` : '';
  return (
    `:package: A *${vendor}* package in #packages might be yours (${items}${more}). ` +
    `Nobody has confirmed it yet — ${replyLink ? `<${replyLink}|take a look>` : 'take a look'} and tap *Mark arrived* or *Wrong order*.`
  );
}

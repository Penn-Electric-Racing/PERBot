import OpenAI from 'openai';
import { config, hasOpenAI } from '../config.js';
import type { ArrivalRow, Extraction, OpenOrder } from './types.js';

/**
 * When a package carries text evidence (item hints like "cooling tube", slip descriptions) but no
 * part number matched, ask the model which of the candidate open orders it belongs to. The model
 * sees short handles (O3, R12) — never Notion ids — and its answer is validated against them, so it
 * can only point at rows we offered. A human still confirms every write.
 */

export interface Pick {
  order: OpenOrder;
  /** The rows the evidence points at (all of the order's rows when it can't tell). */
  rows: ArrivalRow[];
  confidence: 'high' | 'medium';
  evidence: string;
}

const MAX_ORDERS = 30;
const MAX_PICKS = 3;
const MAX_ITEMS = 15;

export interface PickPrompt {
  prompt: string;
  orders: Map<string, OpenOrder>;
  rows: Map<string, { order: string; row: ArrivalRow }>;
}

function itemName(row: ArrivalRow): string {
  return (row.name || row.partNumber).replace(/\s+/g, ' ').slice(0, 70);
}

export function buildPickPrompt(pkg: Extraction, orders: OpenOrder[], messageText: string): PickPrompt {
  const orderMap = new Map<string, OpenOrder>();
  const rowMap = new Map<string, { order: string; row: ArrivalRow }>();
  let r = 0;
  const blocks = orders.slice(0, MAX_ORDERS).map((o, i) => {
    const handle = `O${i + 1}`;
    orderMap.set(handle, o);
    const items = o.rows.slice(0, MAX_ITEMS).map((row) => {
      const rh = `R${++r}`;
      rowMap.set(rh, { order: handle, row });
      return `    ${rh}: ${itemName(row)} [${row.partNumber.slice(0, 40)}] ×${row.quantity}`;
    });
    const more = o.rows.length > MAX_ITEMS ? `\n    …and ${o.rows.length - MAX_ITEMS} more items` : '';
    return `${handle}: ${o.vendor || 'unknown vendor'} · requested by ${o.requesters.join(', ') || 'unknown'} · ${o.date?.slice(0, 10) ?? 'no date'} · ${o.rows.length} items\n${items.join('\n')}${more}`;
  });

  const evidence = [
    `This package's item hints: ${pkg.itemHints.join('; ') || 'none'}`,
    `Vendor: ${pkg.vendor ?? 'unknown'}`,
    `Addressee on label: ${pkg.addressee ?? 'none'}`,
    `Ship date: ${pkg.shipDate ?? 'unknown'}`,
    `Slip lines: ${pkg.lines.map((l) => [l.vendorPartNumber, l.manufacturerPartNumber, l.description].filter(Boolean).join(' / ')).join('; ') || 'none'}`,
    `Slack message (context; it may also describe OTHER packages in the photo): ${JSON.stringify(messageText.slice(0, 400) || '(none)')}`,
  ].join('\n');

  const prompt = `A package arrived at Penn Electric Racing. Decide which open purchase order(s) its contents belong to.

What we know about the package:
${evidence}

Open orders (only these exist):
${blocks.join('\n\n')}

Rules:
- Pick an order only if the evidence specifically points to it: an item hint or slip line that clearly names one of its items,
  a matching part/model number, or the addressee being its requester together with a plausible item.
  Same vendor alone is NOT evidence, and neither are generic words (box, parts, PCBs, components).
- Judge THIS package by its own item hints and slip lines; use the message only to understand them.
- The package may hold items from more than one order (e.g. the message lists "cooling tube" and "bracket stock"): return one
  pick per order, at most ${MAX_PICKS}. Return an empty list when nothing specific matches.
- "rows": the item handles (R…) the evidence names; empty if it points at the order but not specific items.
- confidence "high" when an item clearly matches; "medium" when it's a strong but indirect fit.
- evidence: one short phrase quoting what matched, e.g. "message says cooling tube; O2 has 'Clear PVC tubing'".

Reply with JSON only.`;
  return { prompt, orders: orderMap, rows: rowMap };
}

const PICK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['order', 'rows', 'confidence', 'evidence'],
  properties: {
    order: { type: 'string' },
    rows: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'medium'] },
    evidence: { type: 'string' },
  },
} as const;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['picks'],
  properties: { picks: { type: 'array', items: PICK_SCHEMA } },
} as const;

/** Validate the model's answer against the handles we offered: known orders only, rows only from their order, each order once. */
export function parsePicks(raw: unknown, built: PickPrompt): Pick[] {
  const picks: Pick[] = [];
  for (const p of Array.isArray((raw as any)?.picks) ? (raw as any).picks : []) {
    if (p?.confidence !== 'high' && p?.confidence !== 'medium') continue;
    const handle = String(p.order ?? '').trim();
    const order = built.orders.get(handle);
    if (!order || picks.some((x) => x.order === order)) continue;
    const rows: ArrivalRow[] = [];
    for (const h of Array.isArray(p.rows) ? p.rows : []) {
      const hit = built.rows.get(String(h).trim());
      if (hit && hit.order === handle) rows.push(hit.row);
    }
    picks.push({
      order,
      rows: rows.length ? [...new Set(rows)] : order.rows,
      confidence: p.confidence,
      evidence: String(p.evidence ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    });
    if (picks.length >= MAX_PICKS) break;
  }
  return picks;
}

/** Crude stem: lowercase letters only, strip -ing/-ed/-es/-s/-er/-e until stable, never below 3 letters
 *  ("soldering"/"solder" → "sold", "tubing"/"tube" → "tub", "wiring"/"wire" → "wir"). */
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  for (;;) {
    const next = w.replace(/(ings?|ed|es|s|er|e)$/, '');
    if (next === w || next.length < 3) return w;
    w = next;
  }
}

const VENDOR_WORDS = 'digikey digi key mcmaster carr jlcpcb jlc jlccnc amazon mouser xometry sendcutsend eurotech';

/** Words too common to tie a package to an item on their own (stored stemmed). */
const STOP = new Set(
  ['the', 'and', 'for', 'with', 'from', 'here', 'this', 'that', 'our', 'new', 'some', 'stock', 'part', 'kit', 'set', 'pack', 'piece',
    'item', 'order', 'box', 'small', 'large', 'black', 'red', 'blue', 'white', 'meter', 'feet', 'inch', 'tool',
    // filler from how people actually type ("cooling fittings or something")
    'something', 'stuff', 'thing', 'things', 'maybe', 'probably', 'idk', 'misc', 'other', 'etc', 'arrived', 'came', 'here'].map(stem)
);

export function terms(...texts: (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    for (const word of (t ?? '').split(/[^A-Za-z]+/)) {
      const s = stem(word);
      if (s.length >= 3 && !STOP.has(s)) out.add(s);
    }
  }
  return out;
}

/**
 * The deterministic check on the model. A pick survives only if one of its rows shares a word stem
 * with the package's own evidence — from an item hint, its head noun; from a slip line, any word.
 * "cooling tube" ↔ "PVC Tubing for Cooling" passes; "cooling fittings" ↔ "PVC Tubing for Cooling"
 * (only the adjective) and "buds" ↔ "Cotton Swabs" don't. Within a pick that passed, any shared word
 * keeps a row: "primary bracket stock" brings along "primary flange" from the order "welded inserts
 * stock" already matched (10/02).
 */
export function groundPicks(picks: Pick[], pkg: Extraction): Pick[] {
  // A vendor's name is not evidence about an item: "PCBs (JLCPCB)" must not ground a row called "JLCPCB Order 1".
  const vendorTerms = terms(pkg.vendor, ...picks.flatMap((p) => p.order.rows.map((r) => r.vendor)), VENDOR_WORDS);
  const drop = (set: Iterable<string>) => new Set([...set].filter((t) => !vendorTerms.has(t)));
  const slip = drop(terms(...pkg.lines.flatMap((l) => [l.description, l.vendorPartNumber, l.manufacturerPartNumber])));
  const heads = new Set([...pkg.itemHints.map((h) => [...drop(terms(h))].at(-1)).filter((t): t is string => !!t), ...slip]);
  const any = new Set([...drop(terms(...pkg.itemHints)), ...slip]);
  const codes = new Set(pkg.lines.flatMap((l) => [l.vendorPartNumber, l.manufacturerPartNumber]).filter(Boolean).map((c) => c!.toUpperCase()));
  const shares = (row: ArrivalRow, evidence: Set<string>) => {
    if (codes.has(row.partNumber.trim().toUpperCase())) return true;
    for (const t of terms(row.name, row.partNumber, row.sanitizedDescription)) if (evidence.has(t)) return true;
    return false;
  };
  const rowTerms = (r: ArrivalRow) => terms(r.name, r.partNumber, r.sanitizedDescription);
  return picks
    .filter((p) => p.order.rows.some((r) => shares(r, heads)))
    .map((p) => {
      const kept = (p.rows.some((r) => shares(r, any)) ? p.rows : p.order.rows).filter((r) => shares(r, any));
      // Hint words the kept rows don't account for can still name siblings ("primary" → "primary flange");
      // ones they do can't drag more in ("cooling" is already the T-fitting's, so "cooling fans" stays out).
      const explained = new Set(kept.flatMap((r) => [...rowTerms(r)]));
      const rest = new Set([...any].filter((t) => !explained.has(t)));
      const siblings = p.order.rows.filter((r) => !kept.includes(r) && shares(r, rest));
      return { ...p, rows: [...kept, ...siblings] };
    })
    .filter((p) => p.rows.length > 0);
}

let client: OpenAI | null = null;

export async function pickOrders(pkg: Extraction, orders: OpenOrder[], messageText: string): Promise<Pick[]> {
  if (!hasOpenAI() || orders.length === 0) return [];
  if (!client) client = new OpenAI({ apiKey: config.openai.apiKey });
  const built = buildPickPrompt(pkg, orders, messageText);
  const response = await client.responses.create({
    model: config.openai.responseModel,
    reasoning: { effort: 'low' },
    input: built.prompt,
    text: { format: { type: 'json_schema', name: 'order_pick', strict: true, schema: SCHEMA as any } },
  });
  return groundPicks(parsePicks(JSON.parse(response.output_text || '{}'), built), pkg);
}

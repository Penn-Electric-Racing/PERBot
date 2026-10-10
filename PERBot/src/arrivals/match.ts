import { normalizePartNumber } from '../benbuys/prep.js';
import type { ArrivalRow, Extraction, LineMatch, SlipLine, SlipMatch } from './types.js';

/**
 * Packing slip → open Purchasing rows. Pure (no Notion, no Slack, no LLM).
 *
 * Match keys, strongest first:
 *  1. An order number on the slip equal to a BenBuys requisition (`Run ID = BENBUYS-<req#>`).
 *     Exact, but rarely printed — DigiKey slips usually carry Penn's PO, which Notion doesn't hold.
 *  2. Part numbers: each slip line's vendor or manufacturer number against `Cat. or model no.`
 *     (normalized the way `/benbuys prep` normalizes). This is the workhorse — every row has one.
 *  3. The line's customer reference against the row's sanitized description, since `/benbuys prep`
 *     writes that description (truncated) into DigiKey's reference column.
 *  4. A shared model code (`partCodes`) between the slip line and a free-text row — many non-DigiKey
 *     rows hold a description, not a catalog number, in `Cat. or model no.`.
 * Rows from a different vendor are never candidates. Among several rows for one part, the one in
 * the slip's dominant order wins, then an equal quantity, then the oldest order (first in, first out).
 */

const VENDOR_ALIASES: [RegExp, string][] = [
  [/^digi-?key/, 'digikey'],
  [/^mcmaster/, 'mcmaster'],
  [/^mouser/, 'mouser'],
  [/^amazon|^amzn/, 'amazon'],
  [/^jlc/, 'jlcpcb'],
  [/^xometry/, 'xometry'],
  [/^send-?cut-?send/, 'sendcutsend'],
];

/**
 * "McMaster-Carr Supply Co." / "mcmaster carr" / "www.mcmaster.com" → "mcmaster". Vendors without an
 * alias key on their first word, so "Eurotech Distributors, Inc." and "eurotech direct" agree. "" = unknown.
 */
export function vendorKey(raw: string | null | undefined): string {
  const lower = (raw ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').trim();
  const joined = lower.replace(/[^a-z0-9-]+/g, '');
  if (!joined) return '';
  for (const [re, key] of VENDOR_ALIASES) if (re.test(joined)) return key;
  return lower.split(/[^a-z0-9]+/).find((w) => w && w !== 'the') ?? '';
}

/** The row's vendor from its Vendor text, else its product link's domain. */
export function rowVendorKey(row: ArrivalRow): string {
  const fromText = vendorKey(row.vendor);
  if (fromText) return fromText;
  try {
    return vendorKey(new URL(row.link).hostname);
  } catch {
    return '';
  }
}

function vendorsCompatible(a: string, b: string): boolean {
  return !a || !b || a === b || a.startsWith(b) || b.startsWith(a);
}

/** Digits of a requisition-looking order number, or null. BenBuys requisitions are 6–8 digits. */
function requisitionDigits(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  return /^\d{6,8}$/.test(digits) ? digits : null;
}

function normalizeRef(s: string | null | undefined): string {
  return (s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

/**
 * Model-number-like tokens: 6+ letters/digits with at least one of each ("FHLR2GCB2G", "LM358DR").
 * Pure numbers, plain words, and short sizes ("3x2.5mm") are too common to identify a part.
 */
export function partCodes(...texts: (string | null | undefined)[]): Set<string> {
  const codes = new Set<string>();
  for (const t of texts) {
    for (const tok of (t ?? '').toUpperCase().split(/[^A-Z0-9]+/)) {
      if (tok.length >= 6 && /[A-Z]/.test(tok) && /\d/.test(tok)) codes.add(tok);
    }
  }
  return codes;
}

function lineMatchesRow(line: SlipLine, row: ArrivalRow): boolean {
  const rowPn = normalizePartNumber(row.partNumber);
  if (rowPn) {
    for (const pn of [line.vendorPartNumber, line.manufacturerPartNumber]) {
      if (pn && normalizePartNumber(pn) === rowPn) return true;
    }
  }
  // A truncated reference must still carry real signal — 8+ characters, like reference.ts's floor.
  const ref = normalizeRef(line.customerReference);
  if (ref.length >= 8 && normalizeRef(row.sanitizedDescription).startsWith(ref)) return true;
  // Free-text rows ("5 meters of FHLR2GCB2G (3x2.5mm²)") share a model code with the slip's description.
  const rowCodes = partCodes(row.partNumber, row.name);
  for (const code of partCodes(line.vendorPartNumber, line.manufacturerPartNumber, line.description)) {
    if (rowCodes.has(code)) return true;
  }
  return false;
}

function orderTime(row: ArrivalRow): string {
  return row.orderedAt ?? row.submittedAt ?? '9999';
}

/** A slip line that lists 0 shipped (backordered) is not in the box. */
function shippedHere(line: SlipLine): boolean {
  return line.quantityShipped === null || line.quantityShipped > 0;
}

export function matchSlip(extraction: Extraction, openRows: ArrivalRow[]): SlipMatch {
  const slipVendor = vendorKey(extraction.vendor);
  const pool = openRows.filter((r) => vendorsCompatible(slipVendor, rowVendorKey(r)));
  const lines = extraction.lines.filter(shippedHere);

  // 1. Exact: an order number on the slip names a BenBuys requisition we recorded.
  const runIds = new Set(pool.map((r) => r.runId).filter(Boolean));
  let exactRunId: string | null = null;
  for (const { value } of extraction.orderNumbers) {
    const digits = requisitionDigits(value);
    if (digits && runIds.has(`BENBUYS-${digits}`)) {
      exactRunId = `BENBUYS-${digits}`;
      break;
    }
  }

  // 2. Candidates per line, then the dominant order = the Run ID covering the most lines. A tie
  //    names no order up front; quantity and age pick the rows, and the order follows from them.
  const candidates = lines.map((line) => pool.filter((r) => lineMatchesRow(line, r)));
  const runId = exactRunId ?? uniqueTop(candidates.map((rows) => [...new Set(rows.map((r) => r.runId).filter(Boolean))]));

  // 3. One row per line, never the same row twice.
  const used = new Set<string>();
  const matches: LineMatch[] = lines.map((line, i) => {
    const options = candidates[i]!.filter((r) => !used.has(r.id)).sort((a, b) => {
      const inOrder = Number(b.runId === runId && !!runId) - Number(a.runId === runId && !!runId);
      if (inOrder) return inOrder;
      const qty = Number(b.quantity === line.quantityShipped) - Number(a.quantity === line.quantityShipped);
      if (qty) return qty;
      return orderTime(a).localeCompare(orderTime(b));
    });
    const row = options[0] ?? null;
    if (row) used.add(row.id);
    return { line, row };
  });

  const matchedRows = matches.flatMap((m) => (m.row ? [m.row] : []));
  const order = runId ?? uniqueTop(matchedRows.map((r) => (r.runId ? [r.runId] : []))) ?? matchedRows.find((r) => r.runId)?.runId ?? null;
  const orderRows = order ? pool.filter((r) => r.runId === order) : [];

  let confidence: SlipMatch['confidence'] = 'none';
  if (exactRunId) confidence = 'exact';
  else if (matchedRows.length > 0) confidence = matchedRows.length * 2 >= lines.length ? 'strong' : 'weak';

  return { confidence, runId: order, orderRows, matchedRows, lines: matches };
}

/** The value appearing in the most groups, or null when nothing appears or the top is tied. */
function uniqueTop(groups: string[][]): string | null {
  const counts = new Map<string, number>();
  for (const group of groups) for (const v of group) counts.set(v, (counts.get(v) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0 || ranked[1]?.[1] === ranked[0]![1]) return null;
  return ranked[0]![0];
}

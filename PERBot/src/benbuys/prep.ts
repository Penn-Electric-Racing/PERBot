import type { CartLine, PrepResult, PrepWarning, PurchasingRow, VendorAdapter } from './types.js';

/**
 * `/benbuys prep` — pure logic (no Slack, no Notion). `buildPrep` turns the selected
 * rows into cart lines; `formatPrep` renders the three code blocks. Blocking validation
 * is the `PEFS Ready?` formula's job in Notion; everything here is a warning at most.
 */

/** Trim, collapse internal whitespace/newlines, uppercase — how the punchout keys parts. */
export function normalizePartNumber(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/** Sum quantities across rows with the same normalized part number; keep the source rows. */
export function aggregateRows(rows: PurchasingRow[], adapter: VendorAdapter): CartLine[] {
  const byPart = new Map<string, PurchasingRow[]>();
  for (const row of rows) {
    const pn = normalizePartNumber(row.partNumber);
    if (!pn) continue;
    const bucket = byPart.get(pn);
    if (bucket) bucket.push(row);
    else byPart.set(pn, [row]);
  }
  const lines: CartLine[] = [];
  for (const [partNumber, group] of byPart) {
    lines.push({
      partNumber,
      quantity: group.reduce((sum, r) => sum + r.quantity, 0),
      reference: adapter.referenceField({ partNumber, rows: group }),
      lineTotal: round2(group.reduce((sum, r) => sum + r.quantity * r.unitCost, 0)),
      rows: group,
    });
  }
  return lines;
}

export const HIGH_VALUE_LINE_USD = 100;

/** §6 warning checks — never exclude a row. */
export function warningsFor(lines: CartLine[], adapter: VendorAdapter): PrepWarning[] {
  const out: PrepWarning[] = [];
  for (const line of lines) {
    const vendorNote = adapter.partNumberWarning(line.partNumber);
    if (vendorNote) out.push({ partNumber: line.partNumber, message: vendorNote });

    const looksLikePart = line.rows.some((r) => {
      const cat = r.partNumber.trim().toLowerCase();
      return cat && (cat === r.name.trim().toLowerCase() || cat === r.sanitizedDescription.trim().toLowerCase());
    });
    if (looksLikePart) out.push({ partNumber: line.partNumber, message: 'description looks like a part number' });

    const batches = new Set(line.rows.map((r) => r.orderBatch.trim()));
    if (line.rows.length > 1 && batches.size > 1) {
      out.push({ partNumber: line.partNumber, message: `aggregated across batches (${[...batches].map((b) => b || 'blank').join(', ')})` });
    }

    if (line.lineTotal > HIGH_VALUE_LINE_USD) {
      out.push({ partNumber: line.partNumber, message: `high-value line ($${money(line.lineTotal)}) — double-check quantity` });
    }
  }
  return out;
}

/**
 * Select → aggregate → warn → total. `ready` rows are the Notion query result with the
 * `PEFS Ready?` clause; `notReady` are the same query without it, minus `ready`.
 * If any ready row has `Include in next order` ticked, only those rows are used.
 */
export function buildPrep(adapter: VendorAdapter, ready: PurchasingRow[], notReady: PurchasingRow[]): PrepResult {
  const cherry = ready.filter((r) => r.includeInNextOrder);
  const rows = cherry.length > 0 ? cherry : ready;
  const lines = aggregateRows(rows, adapter);
  return {
    vendorKey: adapter.key,
    lines,
    rows,
    notReady,
    warnings: warningsFor(lines, adapter),
    estimatedTotal: round2(rows.reduce((sum, r) => sum + r.quantity * r.unitCost, 0)),
    cherryPicked: cherry.length > 0,
  };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function money(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export interface PrepBlocks {
  /** Block 1 — paste into the punchout. Empty string when there are no lines. */
  cart: string;
  /** Block 2 — BEN Financials fields. */
  ben: string;
  /** Block 3 — summary. */
  summary: string;
}

/** The three code blocks of the prep reply, as plain text (caller wraps in ``` fences). */
export function formatPrep(adapter: VendorAdapter, prep: PrepResult, approvalThreshold: number): PrepBlocks {
  const cart = prep.lines.length ? adapter.formatCartLines(prep.lines) : '';

  const ben = [
    `Description:   ${adapter.benDescription}`,
    `Justification: ${adapter.benJustification}`,
    'Receipt Required: leave unchecked',
    'Services location: leave blank',
  ].join('\n');

  const approval =
    prep.estimatedTotal > approvalThreshold
      ? `likely APPROVAL REQUIRED (>$${approvalThreshold}; BEN total decides)`
      : `likely no approval needed (≤$${approvalThreshold}; BEN total decides)`;

  const summary: string[] = [];
  if (prep.lines.length === 0) {
    summary.push(`No ready ${adapter.label} rows to order.`);
  } else {
    summary.push(`${plural(prep.lines.length, 'line')} · ${plural(prep.rows.length, 'row')} · est. $${money(prep.estimatedTotal)} → ${approval}`);
    if (prep.cherryPicked) summary.push('Cherry-picked: only rows with "Include in next order" ticked.');
  }
  summary.push(
    prep.notReady.length
      ? `Not ready (fix in Notion): ${plural(prep.notReady.length, 'row')} — ${prep.notReady.map((r) => `<${r.url}|${slackEscape(r.name || r.partNumber || 'untitled')}>`).join(', ')}`
      : 'Not ready (fix in Notion): none'
  );
  summary.push(
    prep.warnings.length
      ? `Warnings: ${prep.warnings.length}\n${prep.warnings.map((w) => `  • ${w.partNumber}: ${w.message}`).join('\n')}`
      : 'Warnings: none'
  );
  if (prep.lines.length > 0) summary.push(`Next: /benbuys done <requisition#> <BEN total>`);

  return { cart, ben, summary: summary.join('\n') };
}

function slackEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '/');
}

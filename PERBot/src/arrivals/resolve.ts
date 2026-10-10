import { matchSlip } from './match.js';
import { eligibleRows, groupOrders, ordersForVendor, rankOrders } from './orders.js';
import { pickOrders, type Pick } from './pick.js';
import type { ArrivalRow, Extraction, OpenOrder, Resolution, Scan, SlipMatch } from './types.js';

/**
 * One scanned photo → Resolutions, strongest evidence first, per package:
 *   1. part numbers / requisition on a slip (deterministic `matchSlip`) — exact or strong wins outright;
 *   2. text evidence (item hints, slip descriptions) → the model picks among that vendor's open
 *      orders (or all open orders when the vendor is unknown), validated against what we offered —
 *      up to 3 orders, since one message often lists several items;
 *   3. a weak slip match, if that's all there is;
 *   4. vendor known → a pick-list of its most plausible open orders;
 *   5. nothing.
 * Only orders that went out before the photo are candidates (`eligibleRows`), and rows claimed by an
 * earlier package in the same photo aren't offered again.
 */

export type Picker = (pkg: Extraction, orders: OpenOrder[], messageText: string) => Promise<Pick[]>;

function pickToMatch(pick: Pick): SlipMatch {
  return {
    confidence: pick.confidence === 'high' ? 'strong' : 'weak',
    runId: pick.order.runId,
    orderRows: pick.order.rows,
    matchedRows: pick.rows,
    lines: [],
  };
}

type Unindexed = Resolution extends infer R ? (R extends any ? Omit<R, 'pkg'> : never) : never;

export async function resolvePackage(
  pkg: Extraction,
  rows: ArrivalRow[],
  asOf: Date,
  messageText: string,
  picker: Picker = pickOrders
): Promise<Unindexed[]> {
  let weak: SlipMatch | null = null;
  if (pkg.lines.length || pkg.orderNumbers.length) {
    const match = matchSlip(pkg, rows);
    if (match.confidence === 'exact' || match.confidence === 'strong') return [{ kind: 'match', match, evidence: null }];
    if (match.confidence === 'weak') weak = match;
  }

  const orders = groupOrders(rows);
  const vendorOrders = ordersForVendor(orders, pkg.vendor);
  const hasEvidence = pkg.itemHints.length > 0 || pkg.lines.some((l) => l.description);
  // A vendor with no open orders is often a misread (the carrier, a fulfiller): let the evidence decide.
  const pool = vendorOrders.length ? vendorOrders : orders;
  if (hasEvidence && pool.length) {
    const picks = await picker(pkg, rankOrders(pool, pkg, asOf), messageText);
    if (picks.length) return picks.map((p) => ({ kind: 'match', match: pickToMatch(p), evidence: p.evidence }));
  }

  if (weak) return [{ kind: 'match', match: weak, evidence: null }];
  if (vendorOrders.length) return [{ kind: 'choose', orders: rankOrders(vendorOrders, pkg, asOf), vendor: pkg.vendor! }];
  return [{ kind: 'none' }];
}

export async function resolveScan(scan: Scan, openRows: ArrivalRow[], asOf: Date, messageText: string, picker?: Picker): Promise<Resolution[]> {
  if (scan.scene === 'not_a_delivery') return [];
  // A pile photo with nothing said: any "hints" are the model describing boxes. Part numbers still count.
  const packagesIn = scan.scene === 'several_packages' && !messageText.trim() ? scan.packages.map((p) => ({ ...p, itemHints: [] })) : scan.packages;
  let rows = eligibleRows(openRows, asOf);
  const out: Resolution[] = [];
  for (const [i, pkg] of packagesIn.entries()) {
    for (const res of await resolvePackage(pkg, rows, asOf, messageText, picker)) {
      out.push({ ...res, pkg: i } as Resolution);
      if (res.kind === 'match') {
        const claimed = new Set(res.match.orderRows.concat(res.match.matchedRows).map((r) => r.id));
        rows = rows.filter((r) => !claimed.has(r.id));
      }
    }
  }
  return out;
}

import { rowVendorKey, vendorKey } from './match.js';
import type { ArrivalRow, Extraction, OpenOrder } from './types.js';

/**
 * Open orders a package could belong to. Pure.
 *
 * A row is a candidate only if it went out on an order (`Exported?`), hasn't arrived, and was
 * requested before the photo was posted — the last rule keeps a backtest over old photos from
 * matching orders placed after them, and is free in live use. Rows group into the order they
 * went out on: `Run ID`, or (for the ~70 rows without one) vendor + request day.
 */

const DAY = 86_400_000;
/** Older than this, an open order has almost certainly arrived unrecorded (nothing was marked before
 *  this feature): it isn't offered on vendor alone, and ranks after fresher orders. */
export const STALE_DAYS = 30;
/** Older than this, an open row isn't a candidate at all — "Is it the order from Aug 29?" on Oct 19 was the #1 complaint. */
export const MAX_AGE_DAYS = 90;

function time(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).getTime();
  return Number.isNaN(t) ? null : t;
}

export function eligibleRows(rows: ArrivalRow[], asOf: Date): ArrivalRow[] {
  const cutoff = asOf.getTime();
  return rows.filter((r) => {
    if (!r.exported || r.arrived === 'Yes') return false;
    const requested = time(r.submittedAt);
    if (requested !== null && requested > cutoff) return false;
    const placed = time(r.orderedAt) ?? requested;
    return placed === null || cutoff - placed <= MAX_AGE_DAYS * DAY;
  });
}

/** The order a row belongs to: `Run ID`, else request day, plus vendor (see groupOrders). */
export function orderKey(row: ArrivalRow): string {
  return `${row.runId || (row.submittedAt ?? '').slice(0, 10)}|${rowVendorKey(row) || 'unknown'}`;
}

/** Placed more than STALE_DAYS before `asOf`. Undated orders aren't stale (nothing to judge by). */
export function isStale(order: OpenOrder, asOf: Date): boolean {
  const t = time(order.date);
  return t !== null && asOf.getTime() - t > STALE_DAYS * DAY;
}

/**
 * One order = one vendor's rows in a run. PEFS export runs (PERPO-…) batch several vendors, and a
 * box only ever holds one vendor's slice; `runId` is kept only when the slice is the whole run, so
 * a button that re-reads the run at click time can't sweep in another vendor's rows.
 */
export function groupOrders(rows: ArrivalRow[]): OpenOrder[] {
  const byKey = new Map<string, ArrivalRow[]>();
  const runSize = new Map<string, number>();
  for (const r of rows) {
    const key = orderKey(r);
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
    if (r.runId) runSize.set(r.runId, (runSize.get(r.runId) ?? 0) + 1);
  }
  return [...byKey].map(([key, group]) => ({
    key,
    runId: group[0]!.runId && runSize.get(group[0]!.runId) === group.length ? group[0]!.runId : null,
    rows: group,
    vendor: group.find((r) => r.vendor)?.vendor ?? '',
    requesters: [...new Set(group.flatMap((r) => r.pointOfContact))],
    date: group.map((r) => r.orderedAt ?? r.submittedAt).filter((d): d is string => !!d).sort()[0] ?? null,
  }));
}

/** Orders from the package's vendor; [] when the vendor is unknown. */
export function ordersForVendor(orders: OpenOrder[], vendor: string | null): OpenOrder[] {
  const key = vendorKey(vendor);
  if (!key) return [];
  return orders.filter((o) => {
    const k = rowVendorKey(o.rows[0]!);
    return k === key || (!!k && (k.startsWith(key) || key.startsWith(k)));
  });
}

function nameTokens(name: string): string[] {
  return name.toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 2);
}

/** "KATHERINE SHEN" vs requester "Katherine Shen" / "Shen": shares the surname, or is the whole name. */
export function addresseeMatches(addressee: string | null, requesters: string[]): boolean {
  const a = nameTokens(addressee ?? '');
  if (a.length === 0) return false;
  return requesters.some((r) => {
    const t = nameTokens(r);
    return t.length > 0 && (t.at(-1) === a.at(-1) || (t.length === 1 && a.includes(t[0]!)));
  });
}

/**
 * Most plausible first: an addressee who requested it, then the order placed closest BEFORE the
 * ship date — or before the photo, when no ship date was read (McMaster ships next day, so an order
 * from yesterday is a prime candidate). Stale orders (STALE_DAYS) come after fresh ones, and orders
 * placed after the ship date go last. Nothing was marked arrived before this feature, so "oldest open
 * order" would surface long-delivered ones.
 */
export function rankOrders(orders: OpenOrder[], pkg: Extraction, asOf: Date): OpenOrder[] {
  const anchor = time(pkg.shipDate) ?? asOf.getTime();
  const gap = (o: OpenOrder) => {
    const t = time(o.date);
    if (t === null) return 365;
    const days = (anchor - t) / DAY;
    if (days < -1) return 365 + Math.abs(days); // ordered after it shipped: last
    return days > STALE_DAYS ? 180 + days : Math.abs(days);
  };
  return [...orders].sort((a, b) => {
    const named = Number(addresseeMatches(pkg.addressee, b.requesters)) - Number(addresseeMatches(pkg.addressee, a.requesters));
    return named || gap(a) - gap(b);
  });
}

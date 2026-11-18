import { ORDER_STAGES, type OrderStage, type PurchaseRecord } from './records.js';

/**
 * Turns a question's structured plan (from the LLM planner) into matching rows plus totals.
 * Counting and summing happen here, not in the model, so the numbers in an answer are exact.
 */

export const GROUP_BYS = ['vendor', 'subsystem', 'season', 'stage', 'paymentMethod', 'person', 'month', 'orderBatch'] as const;
export type GroupBy = (typeof GROUP_BYS)[number];
export const DATE_FIELDS = ['submitted', 'ordered', 'arrived', 'created'] as const;
export type DateField = (typeof DATE_FIELDS)[number];

export interface PurchasePlan {
  /** Item searches, OR'd together; a term matches when all its words appear in the row. */
  terms?: string[];
  vendors?: string[];
  subsystems?: string[];
  /** Empty → the current season (falling back to every season when item terms match nothing there). */
  seasons?: string[];
  allSeasons?: boolean;
  stages?: OrderStage[];
  paymentMethods?: string[];
  people?: string[];
  orderBatch?: string;
  dateField?: DateField;
  since?: string;
  until?: string;
  groupBy?: GroupBy;
  sort?: 'newest' | 'oldest' | 'cost';
}

export interface PurchaseGroup {
  key: string;
  count: number;
  total: number;
}

export interface PurchaseResult {
  /** The plan as actually run (season defaults filled in). */
  plan: PurchasePlan;
  matched: number;
  totalCost: number;
  /** Rows in `matched` with no cost recorded (left out of totalCost). */
  missingCost: number;
  stageCounts: Partial<Record<OrderStage, number>>;
  groups: PurchaseGroup[];
  rows: PurchaseRecord[];
  /** Notes on how the search was loosened to find something. */
  notes: string[];
}

export const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9.]+/).map((w) => w.replace(/^\.+|\.+$/g, '')).filter(Boolean);

function haystack(r: PurchaseRecord): { spaced: string; squashed: string } {
  const text = [r.name, r.partNumber, r.vendor, r.orderBatch, r.notes, r.description, r.link].join(' ').toLowerCase();
  return { spaced: text, squashed: squash(text) };
}

/** Every word of the term appears (part numbers also match with dashes/spaces ignored). */
export function termMatches(r: PurchaseRecord, term: string, mode: 'all' | 'any' = 'all'): boolean {
  const ws = words(term);
  if (ws.length === 0) return false;
  const h = haystack(r);
  if (squash(term).length >= 6 && h.squashed.includes(squash(term))) return true;
  // Short words must be whole words ("air" shouldn't hit "repair"); longer ones may be substrings.
  const hit = (w: string) =>
    w.length <= 4
      ? new RegExp(`(?:^|[^a-z0-9])${w.replace(/[.]/g, '\\.')}s?(?:$|[^a-z0-9])`).test(h.spaced)
      : h.spaced.includes(w) || h.squashed.includes(squash(w));
  return mode === 'all' ? ws.every(hit) : ws.some((w) => w.length >= 3 && hit(w));
}

function vendorMatches(r: PurchaseRecord, vendor: string): boolean {
  const v = squash(vendor);
  return Boolean(v) && (squash(r.vendor).includes(v) || squash(r.link).includes(v));
}

function dateOf(r: PurchaseRecord, field: DateField): string | null {
  switch (field) {
    case 'ordered':
      return r.orderedAt;
    case 'arrived':
      return r.arrivedAt;
    case 'created':
      return r.createdAt;
    default:
      return r.submittedAt ?? r.createdAt;
  }
}

const day = (iso: string | null): string => (iso ?? '').slice(0, 10);

function filterRows(records: PurchaseRecord[], plan: PurchasePlan, termMode: 'all' | 'any'): PurchaseRecord[] {
  const lower = (xs?: string[]) => (xs ?? []).map((x) => x.toLowerCase()).filter(Boolean);
  const seasons = lower(plan.seasons);
  const subsystems = lower(plan.subsystems);
  const payments = lower(plan.paymentMethods);
  const people = lower(plan.people);
  const stages = new Set(plan.stages ?? []);
  const field = plan.dateField ?? 'submitted';
  return records.filter((r) => {
    if (!plan.allSeasons && seasons.length && !seasons.includes(r.season.toLowerCase())) return false;
    if (subsystems.length && !r.subsystems.some((s) => subsystems.includes(s.toLowerCase()))) return false;
    if (payments.length && !payments.includes(r.paymentMethod.toLowerCase())) return false;
    if (stages.size && !stages.has(r.stage)) return false;
    if (people.length && !people.some((p) => r.pointOfContact.some((n) => n.toLowerCase().includes(p)) || r.receivedBy.toLowerCase().includes(p))) return false;
    if (plan.orderBatch && !r.orderBatch.toLowerCase().includes(plan.orderBatch.toLowerCase())) return false;
    if (plan.vendors?.length && !plan.vendors.some((v) => vendorMatches(r, v))) return false;
    if (plan.since || plan.until) {
      const d = day(dateOf(r, field));
      if (!d) return false;
      if (plan.since && d < plan.since.slice(0, 10)) return false;
      if (plan.until && d > plan.until.slice(0, 10)) return false;
    }
    if (plan.terms?.length && !plan.terms.some((t) => termMatches(r, t, termMode))) return false;
    return true;
  });
}

/** "McMaster-Carr", "McMaster Carr", "mcmaster" → one vendor; "Digi-Key"/"Digikey" likewise. */
export const vendorKey = (vendor: string): string => squash(vendor).replace(/(?:carr|inc|llc|corp|com)$/, '');

function groupKeys(r: PurchaseRecord, by: GroupBy, field: DateField): string[] {
  const or = (s: string) => s || '(blank)';
  switch (by) {
    case 'vendor':
      return [vendorKey(r.vendor) || '(blank)'];
    case 'subsystem':
      return r.subsystems.length ? r.subsystems : ['(blank)'];
    case 'season':
      return [or(r.season)];
    case 'stage':
      return [r.stage];
    case 'paymentMethod':
      return [or(r.paymentMethod)];
    case 'person':
      return r.pointOfContact.length ? r.pointOfContact : ['(blank)'];
    case 'month':
      return [or(day(dateOf(r, field)).slice(0, 7))];
    case 'orderBatch':
      return [or(r.orderBatch)];
  }
}

function sortRows(rows: PurchaseRecord[], plan: PurchasePlan): PurchaseRecord[] {
  const field = plan.dateField ?? 'submitted';
  const sorted = [...rows];
  if (plan.sort === 'cost') sorted.sort((a, b) => (b.totalCost ?? 0) - (a.totalCost ?? 0));
  else {
    const dir = plan.sort === 'oldest' ? 1 : -1;
    sorted.sort((a, b) => dir * (day(dateOf(a, field)) || '0').localeCompare(day(dateOf(b, field)) || '0'));
  }
  return sorted;
}

export function runPurchaseQuery(
  records: PurchaseRecord[],
  input: PurchasePlan,
  options: { currentSeason: string; rowLimit?: number }
): PurchaseResult {
  const notes: string[] = [];
  let plan: PurchasePlan = { ...input };
  if (!plan.allSeasons && !plan.seasons?.length) plan.seasons = [options.currentSeason];

  let rows = filterRows(records, plan, 'all');
  if (rows.length === 0 && plan.terms?.length && !input.seasons?.length && !input.allSeasons) {
    const everywhere = { ...plan, seasons: [], allSeasons: true };
    rows = filterRows(records, everywhere, 'all');
    if (rows.length) {
      notes.push(`Nothing matched in ${options.currentSeason}, so this searched every season.`);
      plan = everywhere;
    }
  }
  if (rows.length === 0 && plan.terms?.length) {
    const loose = filterRows(records, plan, 'any');
    if (loose.length) {
      notes.push('No row matched every word of the item, so these are partial matches; check they are the right part.');
      rows = loose;
    }
  }

  const field = plan.dateField ?? 'submitted';
  const stageCounts: Partial<Record<OrderStage, number>> = {};
  let totalCost = 0;
  let missingCost = 0;
  const groups = new Map<string, PurchaseGroup>();
  for (const r of rows) {
    stageCounts[r.stage] = (stageCounts[r.stage] ?? 0) + 1;
    if (r.totalCost === null) missingCost += 1;
    else totalCost += r.totalCost;
    if (plan.groupBy) {
      for (const key of groupKeys(r, plan.groupBy, field)) {
        const g = groups.get(key) ?? { key, count: 0, total: 0 };
        g.count += 1;
        g.total += r.totalCost ?? 0;
        groups.set(key, g);
      }
    }
  }
  if (plan.groupBy === 'vendor') {
    const spellings = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const k = vendorKey(r.vendor);
      const m = spellings.get(k) ?? new Map<string, number>();
      m.set(r.vendor, (m.get(r.vendor) ?? 0) + 1);
      spellings.set(k, m);
    }
    for (const g of groups.values()) {
      const m = spellings.get(g.key);
      if (m) g.key = [...m.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    }
  }
  const orderedStages = Object.fromEntries(
    ORDER_STAGES.filter((s) => stageCounts[s]).map((s) => [s, stageCounts[s]])
  ) as Partial<Record<OrderStage, number>>;

  return {
    plan,
    matched: rows.length,
    totalCost: Math.round(totalCost * 100) / 100,
    missingCost,
    stageCounts: orderedStages,
    groups: [...groups.values()]
      .map((g) => ({ ...g, total: Math.round(g.total * 100) / 100 }))
      .sort((a, b) => (plan.groupBy === 'month' ? b.key.localeCompare(a.key) : b.total - a.total || b.count - a.count)),
    rows: sortRows(rows, plan).slice(0, options.rowLimit ?? 40),
    notes,
  };
}

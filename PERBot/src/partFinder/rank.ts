import type { Candidate, Listing, RankMode } from './types.js';

/**
 * Quantity maths, scoring and top-N selection (port of ranking.py).
 *
 *   score = (effectiveCost / best) × multiplier
 *
 * effectiveCost = subtotal for the quantity + shipping (median of known shipping when
 * unknown); best = the lowest effectiveCost among listings without warning notes, so a
 * wrong-part bargain can't set the baseline; multiplier = the penalty factors in Weights.
 * 1.00 = the cheapest valid option with no drawbacks. Lower is better.
 */

export interface Weights {
  outOfStock: number;          // listed out of stock / backordered
  shortStock: number;          // stock shown but below the quantity needed
  stockUnknown: number;
  perShipDay: number;          // +2% per day of shipping beyond fastDays...
  shipDayCap: number;          // ...capped at +40%
  fastDays: number;
  slowNoteDays: number;        // add a "slow" note at this many days
  shipTimeUnknown: number;
  shipCostUnknown: number;     // on top of adding the median known shipping cost
  /** Confidence in where the price came from; unlisted sources get unknownSource. */
  source: Record<string, number>;
  unknownSource: number;
  listingPage: number;         // price is the lowest of many listings, may not be this part
  relevance: number;           // ×(1 + 0.6 × fraction of query words missing)
  mpnVariant: number;          // part number only inside a longer code (LM317L for LM317)
  outlier: number;             // unit cost < outlierRatio × the median...
  outlierRatio: number;        // ...likely the wrong item or an accessory
  outlierMinCount: number;     // need this many prices before judging outliers
  perSearchRank: number;       // tiny tiebreak favouring higher search positions
}

export const DEFAULT_WEIGHTS: Weights = {
  outOfStock: 1.6,
  shortStock: 1.4,
  stockUnknown: 1.03,
  perShipDay: 0.02,
  shipDayCap: 0.4,
  fastDays: 2,
  slowNoteDays: 10,
  shipTimeUnknown: 1.06,
  shipCostUnknown: 1.04,
  source: { llm: 1.02, 'llm snippet': 1.15 },
  unknownSource: 1.1,
  listingPage: 1.12,
  relevance: 0.6,
  mpnVariant: 1.08,
  outlier: 1.35,
  outlierRatio: 0.25,
  outlierMinCount: 4,
  perSearchRank: 0.005,
};

/** Defaults overridden by a partial set (e.g. parsed from PARTS_WEIGHTS_JSON); `source` merges. */
export function makeWeights(overrides: Partial<Weights> = {}): Weights {
  const unknown = Object.keys(overrides).filter((k) => !(k in DEFAULT_WEIGHTS));
  if (unknown.length) throw new Error(`Unknown part-finder weights: ${unknown.join(', ')}`);
  return { ...DEFAULT_WEIGHTS, ...overrides, source: { ...DEFAULT_WEIGHTS.source, ...(overrides.source ?? {}) } };
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** "Free" / "$5.99" / "4.50 USD" → number, else null. */
export function shipValue(ship: string | null): number | null {
  if (ship === 'Free') return 0;
  const digits = (ship ?? '').replace(/[^\d.]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/** Rough worst-case days until delivery from a shipping-time string. */
export function shipDays(text: string | null, today: Date = new Date()): number | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes('today') || t.includes('same')) return 1;
  if (t.includes('next business day')) return 2;
  let m = t.match(/(\d+)(?:\s?(?:-|–|to)\s?(\d+))?\s?(?:business\s|working\s)?(hour|day|week)/);
  if (m) {
    const n = Number(m[2] ?? m[1]);
    return m[3] === 'hour' ? Math.max(1, Math.ceil(n / 24)) : m[3] === 'day' ? n : 7 * n;
  }
  m = t.match(/([a-z]{3})[a-z]*\.?\s(\d{1,2})$/);
  if (m) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const month = months.indexOf(m[1]!);
    if (month < 0) return null;
    const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    let d = Date.UTC(today.getUTCFullYear(), month, Number(m[2]));
    if (d < start) d = Date.UTC(today.getUTCFullYear() + 1, month, Number(m[2]));
    return Math.max(Math.round((d - start) / 86_400_000), 1);
  }
  return null;
}

/** Lowercase letters and digits only, for loose matching ("LM-317" → "lm317"). */
export function alnum(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const STOP_WORDS = new Set(['price', 'buy', 'in', 'stock', 'for', 'the', 'a']);

/**
 * (fraction of query words found, part-number match, variant codes seen instead).
 * Part numbers = query words with digits. If one only shows up inside a longer code
 * (LM317L for LM317) it's a variant — maybe the same part in another package, maybe not.
 */
export function relevance(query: string, r: Pick<Listing, 'title' | 'snippet' | 'url' | 'pageTitle'>): { fraction: number; keyHit: boolean; variants: string[] } {
  const words = (query.toLowerCase().match(/[a-z0-9][a-z0-9.\-/x]*/g) ?? []).filter((w) => !STOP_WORDS.has(w));
  let url = r.url;
  try { url = decodeURIComponent(r.url); } catch { /* keep raw */ }
  const raw = `${r.title} ${r.pageTitle ?? ''} ${r.snippet} ${url}`;
  const hay = alnum(raw);
  const found = words.filter((w) => alnum(w) && hay.includes(alnum(w)));
  const keys = words.filter((w) => /\d/.test(w));
  const keyHit = !keys.length || keys.some((k) => hay.includes(alnum(k)));
  const tokens = new Map<string, string>();
  for (const t of raw.match(/[A-Za-z0-9][A-Za-z0-9.\-]*/g) ?? []) tokens.set(alnum(t), t);
  const variants: string[] = [];
  for (const k of keys.map(alnum)) {
    if (tokens.has(k)) continue; // exact token present: not a variant
    for (const [a, t] of tokens) if (a.includes(k) && !variants.includes(t)) variants.push(t);
  }
  return { fraction: words.length ? found.length / words.length : 1, keyHit, variants };
}

/** Pack maths, price tier, totals and stock check for `qty` units. */
export function applyQty(r: Listing, qty: number): Candidate {
  const breaks = [...r.priceBreaks].sort((a, b) => a.minQty - b.minQty);
  const tier = breaks.filter((b) => b.minQty <= qty).map((b) => b.price);
  const pack = tier.length ? 1 : Math.max(1, r.packSize || 1);
  const price = tier.length ? tier[tier.length - 1]! : r.cost;
  const packsNeeded = Math.ceil(qty / pack);
  const c: Candidate = {
    ...r, priceBreaks: breaks, packSize: pack, qty, packsNeeded,
    unitCost: null, subtotal: null, total: null, enoughStock: null,
    effectiveCost: null, score: null, notes: [], relevance: 1, mpnVariants: [], shipDays: null,
  };
  if (r.stock !== null) c.enoughStock = r.stock * pack >= qty; // stock counts packs on pack listings
  else if (r.inStock === false) c.enoughStock = false;
  if (price === null) return c;
  c.unitCost = round(price / pack, 4);
  c.subtotal = round(price * packsNeeded, 2);
  if (c.shippingCost === null && c.freeShipMin !== null && c.subtotal >= c.freeShipMin) c.shippingCost = 'Free';
  const ship = shipValue(c.shippingCost);
  if (ship !== null) c.total = round(c.subtotal + ship, 2);
  return c;
}

export class Scorer {
  constructor(readonly w: Weights = DEFAULT_WEIGHTS) {}

  /** Penalty multiplier for one priced candidate; appends to c.notes. */
  multiplier(c: Candidate, qty: number, medUnit: number | null, nUnits: number): number {
    const w = this.w;
    let mult = 1;
    if (c.enoughStock === false && c.inStock === false) { mult *= w.outOfStock; c.notes.push('out of stock'); }
    else if (c.enoughStock === false) { mult *= w.shortStock; c.notes.push(`stock below ${qty}`); }
    else if (c.enoughStock === null && c.inStock === null) mult *= w.stockUnknown;
    const days = shipDays(c.shippingTime);
    c.shipDays = days;
    if (days === null) mult *= w.shipTimeUnknown;
    else if (days > w.fastDays) {
      mult *= 1 + Math.min(w.perShipDay * (days - w.fastDays), w.shipDayCap);
      if (days >= w.slowNoteDays) c.notes.push(`slow: ~${days} days`);
    }
    if (shipValue(c.shippingCost) === null) { mult *= w.shipCostUnknown; c.notes.push('shipping cost estimated'); }
    mult *= w.source[c.costSource ?? 'llm snippet'] ?? w.unknownSource;
    if (c.listingPage) { mult *= w.listingPage; c.notes.push('search page: lowest listing'); }
    mult *= 1 + w.relevance * (1 - c.relevance);
    if (c.mpnVariants.length) mult *= w.mpnVariant;
    if (medUnit && nUnits >= w.outlierMinCount && c.unitCost !== null && c.unitCost < w.outlierRatio * medUnit) {
      mult *= w.outlier; c.notes.push('far cheaper than others - verify item');
    }
    return mult * (1 + w.perSearchRank * c.searchRank);
  }

  /** Attach score + human-readable notes to every candidate (unpriced ones keep score null). */
  scoreAll(cands: Candidate[], query: string, qty: number): Candidate[] {
    const priced = cands.filter((c) => c.subtotal !== null);
    const knownShip = priced.map((c) => shipValue(c.shippingCost)).filter((v): v is number => v !== null);
    const shipFill = median(knownShip) ?? 0;
    const units = priced.map((c) => c.unitCost).filter((v): v is number => !!v);
    const medUnit = median(units);
    const curCounts = new Map<string | null, number>();
    for (const c of priced) curCounts.set(c.currency, (curCounts.get(c.currency) ?? 0) + 1);
    const mainCur = [...curCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    for (const c of cands) {
      c.score = null;
      c.notes = [];
      const rel = relevance(query, c);
      c.relevance = rel.fraction;
      c.mpnVariants = rel.variants;
      if (c.subtotal === null) { c.notes.push('no price found'); continue; }
      if (!rel.keyHit) c.notes.push('part number not in listing');
      else if (rel.variants.length) c.notes.push(`listed as ${rel.variants.slice(0, 3).join(', ')} - check suffix`);
      if (c.currency && mainCur && c.currency !== mainCur) c.notes.push(`priced in ${c.currency}, not ${mainCur}`);
      const ship = shipValue(c.shippingCost);
      c.effectiveCost = round(c.subtotal + (ship ?? shipFill), 2);
    }

    // Baseline = cheapest *valid* option, so a wrong-part bargain doesn't skew everyone.
    const ok = cands.filter((c) => c.subtotal !== null);
    const clean = ok.filter((c) => !c.notes.length).map((c) => c.effectiveCost!);
    const best = Math.min(...(clean.length ? clean : ok.map((c) => c.effectiveCost!))) || 0.01;
    for (const c of ok) c.score = round((c.effectiveCost! / best) * this.multiplier(c, qty, medUnit, units.length), 3);
    return cands;
  }

  /** Best `top` options. Hard filters first; loosened only if too few candidates pass. */
  pickTop(cands: Candidate[], top: number, mode: RankMode = 'best', perSupplier = 2): Candidate[] {
    const tier = (c: Candidate) => {
      if (c.score === null) return 3; // unpriced
      if (c.notes.includes('part number not in listing') || c.notes.some((n) => n.startsWith('priced in'))) return 2;
      if (c.enoughStock === false) return 1;
      return 0;
    };
    const key = (c: Candidate) => (tier(c) === 3 ? -c.relevance : mode === 'cheapest' ? c.effectiveCost! : c.score!);
    const ordered = [...cands].sort((a, b) => tier(a) - tier(b) || key(a) - key(b) || a.searchRank - b.searchRank);
    const picked: Candidate[] = [];
    const per = new Map<string, number>();
    for (const c of ordered) { // first pass: cap listings per supplier for variety
      if (picked.length === top) break;
      const s = c.supplier ?? '';
      if ((per.get(s) ?? 0) < perSupplier) { picked.push(c); per.set(s, (per.get(s) ?? 0) + 1); }
    }
    for (const c of ordered) { // fill up if the cap left gaps
      if (picked.length === top) break;
      if (!picked.includes(c)) picked.push(c);
    }
    return picked.sort((a, b) => ordered.indexOf(a) - ordered.indexOf(b));
  }
}

/**
 * Part finder — shared types.
 *
 *   /parts <part> [-q N] [--cheapest]  → searches ~15 listings, an LLM reads each page,
 *                                         ranks the best 5 by cost/stock/shipping
 *   "Add to Purchasing" button          → creates a Purchasing (PEFS) row for that option
 *
 * Pipeline: search.ts (web search) → fetch.ts (page HTML) → extract.ts (LLM → fields)
 * → rank.ts (quantity maths, score, pick). Ported from the standalone Python scraper
 * (scraper2.py + ranking.py); field meanings match it.
 */

/** One web search hit, before the page is read. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** 0-based position across the merged searches (a tiny ranking tiebreak). */
  searchRank: number;
}

export interface PriceBreak {
  minQty: number;
  /** Per-unit price at or above minQty. */
  price: number;
}

/** What the LLM read off one listing (validated in extract.toListingInfo). */
export interface ListingInfo {
  /** Price of ONE listing as sold (a unit, or a pack when sold in packs), qty 1. */
  cost: number | null;
  currency: string | null;
  /** 'llm' = read from the page, 'llm snippet' = only the search snippet was available. */
  costSource: 'llm' | 'llm snippet' | null;
  supplier: string | null;
  /** The seller's catalog / order number (DigiKey "296-1234-ND"), else the MPN shown. */
  partNumber: string | null;
  productName: string | null;
  /** Search / category page listing many items (cost = lowest matching). */
  listingPage: boolean;
  priceRange: [number, number] | null;
  priceBreaks: PriceBreak[];
  packSize: number;
  inStock: boolean | null;
  stock: number | null;
  /** "Free", "4.50 USD", or null when unknown. */
  shippingCost: string | null;
  /** Order minimum for free shipping ("free over $50"). */
  freeShipMin: number | null;
  shippingTime: string | null;
  pageTitle: string | null;
  /** Fetch or LLM failure for this listing (it's still ranked from what's known). */
  error: string | null;
}

export interface Listing extends SearchResult, ListingInfo {}

/** A listing after apply-quantity and scoring. */
export interface Candidate extends Listing {
  qty: number;
  packsNeeded: number;
  unitCost: number | null;
  subtotal: number | null;
  total: number | null;
  enoughStock: boolean | null;
  effectiveCost: number | null;
  score: number | null;
  notes: string[];
  relevance: number;
  mpnVariants: string[];
  shipDays: number | null;
}

export type RankMode = 'best' | 'cheapest';

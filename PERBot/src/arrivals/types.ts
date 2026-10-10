/**
 * Package arrivals — shared types.
 *
 * Someone posts a photo of a packing slip in the arrivals channel → a vision model reads it
 * into an `Extraction` → `matchSlip` finds the open Purchasing (PEFS) rows it belongs to →
 * PERBot replies in the thread with buttons. Nothing is written to Notion until a human taps
 * one (Week 1 = suggest-only).
 */

import type { PurchasingRow } from '../benbuys/types.js';

export type OrderNumberKind = 'purchase_order' | 'sales_order' | 'invoice' | 'customer_reference' | 'other';

export interface SlipLine {
  /** The vendor's own catalog number (DigiKey `…-ND`, a McMaster number). */
  vendorPartNumber: string | null;
  manufacturerPartNumber: string | null;
  description: string | null;
  /** Quantity shipped in THIS box (backordered lines read 0). Null when unreadable. */
  quantityShipped: number | null;
  /** Per-line customer reference — `/benbuys prep` fills it with the row's sanitized description. */
  customerReference: string | null;
}

/** What the vision model read off the photo(s). Prices are deliberately never extracted. */
export interface Extraction {
  /** False for a box with no slip/label, a random photo, etc. */
  isShippingDocument: boolean;
  /** False when the text is too blurry/cropped to trust. */
  legible: boolean;
  vendor: string | null;
  orderNumbers: { kind: OrderNumberKind; value: string }[];
  trackingNumbers: string[];
  lines: SlipLine[];
}

/** A Purchasing row plus the fields arrivals needs on top of what BenBuys reads. */
export interface ArrivalRow extends PurchasingRow {
  vendor: string;
  runId: string;
  /** `Arrived?` status name: No / Ready for Pickup / Yes. */
  arrived: string;
  /** `Submitted at` — when the request was filed (internal lead-time start). */
  submittedAt: string | null;
  /** `Last Email Update` — when the order went out (vendor lead-time start). */
  orderedAt: string | null;
}

export type MatchConfidence = 'exact' | 'strong' | 'weak' | 'none';

export interface LineMatch {
  line: SlipLine;
  row: ArrivalRow | null;
}

export interface SlipMatch {
  confidence: MatchConfidence;
  /** The order most of the slip belongs to (`Run ID`), or null when the matched rows have none. */
  runId: string | null;
  /** Every open row of that order — what "all arrived" would mark. */
  orderRows: ArrivalRow[];
  /** Rows the slip actually shows (inside or outside the main order). */
  matchedRows: ArrivalRow[];
  lines: LineMatch[];
}

/**
 * Package arrivals — shared types.
 *
 * A photo posted in the arrivals channel → a vision model reads the scene into a `Scan` (one
 * `Extraction` per visible package) → each package is resolved against open Purchasing (PEFS)
 * orders → PERBot replies in the thread with buttons, or stays silent. Nothing is written to
 * Notion until a human taps a button.
 *
 * Shaped by #packages history (2026-07 → 10): of 19 photos, 1 showed a packing slip; 7 were a
 * shipping label, 4 the contents, 4 several packages at once, 2 not a delivery at all. So the
 * vendor (label, box branding, message text), the addressee, and item hints carry most of the signal.
 */

import type { PurchasingRow } from '../benbuys/types.js';

export type OrderNumberKind = 'purchase_order' | 'sales_order' | 'invoice' | 'customer_reference' | 'other';

export type Scene = 'packing_slip' | 'shipping_label' | 'contents' | 'several_packages' | 'not_a_delivery';

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

/** What the vision model read about ONE package. Prices are deliberately never extracted. */
export interface Extraction {
  /** The shipper: label FROM line, box branding, or the message text ("Jlc picked up"). */
  vendor: string | null;
  /** The person named on the label (SHIP TO / ATTN / consignee), not the university. */
  addressee: string | null;
  /** ISO date printed on the label/slip, if any. */
  shipDate: string | null;
  orderNumbers: { kind: OrderNumberKind; value: string }[];
  trackingNumbers: string[];
  /** Item lines from a packing slip or a contents label. */
  lines: SlipLine[];
  /** Short names of what's inside, from the message text or visible contents ("cooling tube"). */
  itemHints: string[];
}

export interface Scan {
  scene: Scene;
  /** False when labels/slips are present but too blurry, cropped, or far away to read. */
  legible: boolean;
  packages: Extraction[];
}

/** A Purchasing row plus the fields arrivals needs on top of what BenBuys reads. */
export interface ArrivalRow extends PurchasingRow {
  vendor: string;
  runId: string;
  /** `Arrived?` status name: No / Ready for Pickup / Yes. */
  arrived: string;
  /** `Exported?` — the row went out on an order (255 of 257 REV12 rows). */
  exported: boolean;
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

/** Open rows grouped into the order they went out on (`Run ID`, else vendor + submit day). */
export interface OpenOrder {
  key: string;
  runId: string | null;
  rows: ArrivalRow[];
  vendor: string;
  requesters: string[];
  /** When it was ordered (or requested, if no order date), ISO. */
  date: string | null;
}

/** How a package was resolved; `pkg` indexes `Scan.packages` (a message naming three items can yield three matches). */
export type Resolution =
  | { pkg: number; kind: 'match'; match: SlipMatch; evidence: string | null }
  | { pkg: number; kind: 'choose'; orders: OpenOrder[]; vendor: string }
  | { pkg: number; kind: 'none' };

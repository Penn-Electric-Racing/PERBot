/**
 * BenBuys ordering helper — shared types.
 *
 * Two Slack commands wrap the three clicks that must stay human (PennKey login, Submit
 * Order on the vendor punchout, Submit on BEN):
 *   /benbuys prep [vendor]          → cart paste block + BEN text + est. total + approval flag
 *   /benbuys done <req#> <total>    → requisition email sent, Notion rows marked ordered
 * Everything vendor-specific lives in a VendorAdapter (adapters/); prep/done are vendor-agnostic.
 */

/** One row of the Purchasing (PEFS) Notion database, already narrowed to what prep/done need. */
export interface PurchasingRow {
  id: string;
  url: string;
  name: string;
  /** `Cat. or model no.` exactly as typed (normalized separately). */
  partNumber: string;
  quantity: number;
  unitCost: number;
  subsystems: string[];
  pointOfContact: string[];
  orderBatch: string;
  link: string;
  /** `Sanitized Description (CSV)` — vendor notes with newlines and commas stripped. */
  sanitizedDescription: string;
  notes: string;
  /** `PEFS Ready?` formula text — `✅ Ready` or `❌ Missing fields`. */
  readiness: string;
  includeInNextOrder: boolean;
}

/** One punchout cart line: several rows with the same normalized part number collapse into one. */
export interface CartLine {
  partNumber: string;
  quantity: number;
  reference: string;
  /** Σ quantity × unit cost over the source rows. */
  lineTotal: number;
  rows: PurchasingRow[];
}

export interface PrepWarning {
  partNumber: string;
  message: string;
}

export interface PrepResult {
  vendorKey: string;
  lines: CartLine[];
  /** Rows that fed `lines` (what `done` will write back to). */
  rows: PurchasingRow[];
  /** `❌ Missing fields` rows that were excluded — fix in Notion. */
  notReady: PurchasingRow[];
  warnings: PrepWarning[];
  estimatedTotal: number;
  /** True when `Include in next order` narrowed the row set. */
  cherryPicked: boolean;
}

export interface VendorAdapter {
  key: string;
  label: string;
  /** Notion boolean formula that selects this vendor's rows (e.g. `Electrical BENBuys`). */
  matchFormula: string;
  /** Used in the requisition email body ("for electrical"). */
  subteam: string;
  benDescription: string;
  benJustification: string;
  /** The punchout's bulk-add paste format. */
  formatCartLines(lines: CartLine[]): string;
  /** What goes in the per-line reference column, already length-capped. */
  referenceField(line: { partNumber: string; rows: PurchasingRow[] }): string;
  /** Vendor-specific soft check on a normalized part number (null = fine). */
  partNumberWarning(partNumber: string): string | null;
  /** Slack user ids allowed to run `done` for this vendor. */
  operatorSlackIds: string[];
  signatureName: string;
  /** To: line only — CC comes from the shared config. */
  emailTo: string[];
}

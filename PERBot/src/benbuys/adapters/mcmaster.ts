import type { VendorAdapter } from '../types.js';

/**
 * McMaster-Carr (mechanical) — Phase 1.5 STUB. Operator: Sofia.
 *
 * Same code path as DigiKey; only this object changes. Blocked on (spec §9):
 *   1. `formatCartLines`: McMaster's punchout bulk-entry box takes part-per-line with a
 *      quantity, NOT comma-delimited — confirm the exact format from a screenshot first.
 *   2. Sofia's Slack id → `BENBUYS_MCMASTER_OPERATORS`.
 *   3. Mechanical Description / Justification wording.
 *   4. Whether mechanical rows use `Order Batch` at all (the schema says it's an electrical
 *      label; mechanical rows in the DB have it blank), so `referenceField` must fall through
 *      gracefully and the "aggregated across batches" warning may never fire.
 * `matchFormula` = `Mechanical BENBuys` exists in Notion today:
 *   contains(lower(format(prop("Link to product webpage"))), "mcmaster.com")
 */
export const mcmasterAdapter: VendorAdapter = {
  key: 'mcmaster',
  label: 'McMaster-Carr',
  matchFormula: 'Mechanical BENBuys',
  subteam: 'mechanical',
  benDescription: 'PER mechanical purchase',
  benJustification: "This is a purchase for PER's mechanical subteam.",
  operatorSlackIds: [],
  signatureName: '',
  emailTo: [],
  formatCartLines() {
    throw new Error('McMaster adapter is not built yet — see src/benbuys/adapters/mcmaster.ts');
  },
  referenceField() {
    throw new Error('McMaster adapter is not built yet — see src/benbuys/adapters/mcmaster.ts');
  },
  partNumberWarning() {
    return null;
  },
};

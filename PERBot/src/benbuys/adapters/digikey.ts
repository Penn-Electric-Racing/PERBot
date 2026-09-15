import { config } from '../../config.js';
import { truncateReference } from '../reference.js';
import type { CartLine, PurchasingRow, VendorAdapter } from '../types.js';

/**
 * DigiKey (electrical) — Phase 1. Operator: Katherine Shen.
 *
 * Cart paste format is the punchout's Bulk Add box: `qty, partnumber, reference` per line,
 * so the reference must never contain a comma (we use the `Sanitized Description (CSV)`
 * formula, which already strips them, and re-strip defensively).
 *
 * `matchFormula` is the existing Notion formula (`Link to product webpage` contains
 * digikey.com / digi-key.com). Don't reimplement it here — if the team adds a domain
 * variant they fix it in Notion and the bot follows.
 */
export const digikeyAdapter: VendorAdapter = {
  key: 'digikey',
  label: 'DigiKey',
  matchFormula: 'Electrical BENBuys',
  subteam: 'electrical',
  benDescription: config.benbuys.digikey.description,
  benJustification: config.benbuys.digikey.justification,
  operatorSlackIds: config.benbuys.digikey.operators,
  signatureName: config.benbuys.digikey.signatureName,
  emailTo: config.benbuys.digikey.to,

  formatCartLines(lines: CartLine[]): string {
    return lines.map((l) => `${l.quantity}, ${l.partNumber}, ${l.reference}`).join('\n');
  },

  referenceField({ partNumber, rows }: { partNumber: string; rows: PurchasingRow[] }): string {
    return truncateReference(partNumber, rows, config.benbuys.referenceMaxChars);
  },

  partNumberWarning(partNumber: string): string | null {
    return partNumber.endsWith('-ND')
      ? null
      : 'may be a manufacturer part number — DigiKey may pick different packaging';
  },
};

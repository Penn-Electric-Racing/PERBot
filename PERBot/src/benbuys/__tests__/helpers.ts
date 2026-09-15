import type { PurchasingRow, VendorAdapter } from '../types.js';
import { truncateReference } from '../reference.js';

/** A DigiKey-shaped adapter that doesn't touch config (tests must run without .env). */
export const testAdapter: VendorAdapter = {
  key: 'digikey',
  label: 'DigiKey',
  matchFormula: 'Electrical BENBuys',
  subteam: 'electrical',
  benDescription: 'PER electrical purchase',
  benJustification: "This is a purchase for PER's electrical subteam.",
  operatorSlackIds: ['U_OPERATOR'],
  signatureName: 'Katherine Shen',
  emailTo: ['purchasing@engineering.upenn.edu'],
  formatCartLines: (lines) => lines.map((l) => `${l.quantity}, ${l.partNumber}, ${l.reference}`).join('\n'),
  referenceField: ({ partNumber, rows }) => truncateReference(partNumber, rows, 35),
  partNumberWarning: (pn) => (pn.endsWith('-ND') ? null : 'may be a manufacturer part number — DigiKey may pick different packaging'),
};

let seq = 0;
export function row(overrides: Partial<PurchasingRow> & { partNumber: string }): PurchasingRow {
  seq += 1;
  const description = overrides.sanitizedDescription ?? `PART ${seq}`;
  return {
    id: `page-${seq}`,
    url: `https://notion.so/page-${seq}`,
    name: description,
    quantity: 1,
    unitCost: 1,
    subsystems: ['Misc (elec)'],
    pointOfContact: [],
    orderBatch: 'Order 1',
    link: 'https://www.digikey.com/x',
    sanitizedDescription: description,
    notes: '',
    readiness: '✅ Ready',
    includeInNextOrder: false,
    ...overrides,
  };
}

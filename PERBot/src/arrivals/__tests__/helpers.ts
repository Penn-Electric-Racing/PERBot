import { row as purchasingRow } from '../../benbuys/__tests__/helpers.js';
import type { ArrivalRow, Extraction, SlipLine } from '../types.js';

export function row(o: Partial<ArrivalRow> & { partNumber: string }): ArrivalRow {
  return {
    ...purchasingRow(o),
    vendor: 'DigiKey',
    runId: '',
    arrived: 'No',
    exported: true,
    submittedAt: '2026-09-20',
    orderedAt: '2026-09-28T15:00:00.000Z',
    ...o,
  };
}

export function line(pn: string, qty: number | null = 1, o: Partial<SlipLine> = {}): SlipLine {
  return { vendorPartNumber: pn, manufacturerPartNumber: null, description: null, quantityShipped: qty, customerReference: null, ...o };
}

export function pkg(lines: SlipLine[] = [], o: Partial<Extraction> = {}): Extraction {
  return { vendor: 'DigiKey', addressee: null, shipDate: null, orderNumbers: [], trackingNumbers: [], lines, itemHints: [], ...o };
}

export const BASE = { u: 'U_POSTER', ts: '1760100000.000100' };

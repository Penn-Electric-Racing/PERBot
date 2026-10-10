import { test } from 'node:test';
import assert from 'node:assert/strict';
import { row as purchasingRow } from '../../benbuys/__tests__/helpers.js';
import { buildReply, decodeValue, encodeValue, leadTimeLine, packageKey, settleBlocks, targetIds, theseValue } from '../blocks.js';
import { parseExtraction } from '../extract.js';
import { matchSlip, vendorKey } from '../match.js';
import type { ArrivalRow, Extraction, SlipLine } from '../types.js';

function row(o: Partial<ArrivalRow> & { partNumber: string }): ArrivalRow {
  return {
    ...purchasingRow(o),
    vendor: 'DigiKey',
    runId: '',
    arrived: 'No',
    submittedAt: '2026-09-20',
    orderedAt: '2026-09-28T15:00:00.000Z',
    ...o,
  };
}

function line(pn: string, qty: number | null = 1, o: Partial<SlipLine> = {}): SlipLine {
  return { vendorPartNumber: pn, manufacturerPartNumber: null, description: null, quantityShipped: qty, customerReference: null, ...o };
}

function slip(lines: SlipLine[], o: Partial<Extraction> = {}): Extraction {
  return { isShippingDocument: true, legible: true, vendor: 'DigiKey', orderNumbers: [], trackingNumbers: [], lines, ...o };
}

const BASE = { u: 'U_POSTER', ts: '1760100000.000100' };

test('vendorKey: spellings collapse; unknown stays empty', () => {
  assert.equal(vendorKey('McMaster-Carr Supply Co.'), 'mcmaster');
  assert.equal(vendorKey('mcmaster carr'), 'mcmaster');
  assert.equal(vendorKey('www.mcmaster.com'), 'mcmaster');
  assert.equal(vendorKey('Digi-Key Electronics'), 'digikey');
  assert.equal(vendorKey(null), '');
});

test('matchSlip: part numbers pick the order; whole order on the slip', () => {
  const a = row({ partNumber: 'A-ND', runId: 'BENBUYS-4334609' });
  const b = row({ partNumber: ' b-nd ', runId: 'BENBUYS-4334609' });
  const other = row({ partNumber: 'C-ND', runId: 'PERPO-1' });
  const m = matchSlip(slip([line('A-ND'), line('B-ND')]), [a, b, other]);
  assert.equal(m.confidence, 'strong');
  assert.equal(m.runId, 'BENBUYS-4334609');
  assert.deepEqual(m.matchedRows.map((r) => r.id), [a.id, b.id]);
  assert.deepEqual(m.orderRows.map((r) => r.id), [a.id, b.id]);
});

test('matchSlip: requisition number on the slip is an exact match even if parts differ', () => {
  const a = row({ partNumber: 'X-ND', runId: 'BENBUYS-4334609' });
  const m = matchSlip(slip([line('ZZZ')], { orderNumbers: [{ kind: 'purchase_order', value: 'PO 4334609' }] }), [a]);
  assert.equal(m.confidence, 'exact');
  assert.equal(m.runId, 'BENBUYS-4334609');
  assert.equal(m.matchedRows.length, 0);
  assert.equal(m.orderRows.length, 1);
});

test('matchSlip: never crosses vendors; manufacturer number and customer reference also match', () => {
  const mc = row({ partNumber: '91251A540', vendor: 'McMaster-Carr' });
  const dk = row({ partNumber: 'LM358DR', vendor: 'digikey', sanitizedDescription: 'OPAMP FOR PDU CURRENT SENSE' });
  const ref = row({ partNumber: 'Q-ND', vendor: 'Digi-Key', sanitizedDescription: 'HALL SENSOR BOARD CONNECTOR 4 PIN' });
  const m = matchSlip(
    slip([
      line('91251A540'),
      line('296-1395-1-ND', 1, { manufacturerPartNumber: 'LM358DR' }),
      line('OTHER-ND', 1, { customerReference: 'HALL SENSOR BOARD CONNEC' }),
    ]),
    [mc, dk, ref]
  );
  assert.deepEqual(m.lines.map((l) => l.row?.id ?? null), [null, dk.id, ref.id]);
});

test('matchSlip: same part on two orders → dominant order, then quantity, then oldest', () => {
  const old = row({ partNumber: 'R-ND', runId: 'BENBUYS-1111111', orderedAt: '2026-09-01', quantity: 5 });
  const newer = row({ partNumber: 'R-ND', runId: 'BENBUYS-2222222', orderedAt: '2026-09-20', quantity: 10 });
  const sibling = row({ partNumber: 'S-ND', runId: 'BENBUYS-2222222' });
  // S-ND votes for order 2222222, so R-ND goes there despite being newer.
  assert.equal(matchSlip(slip([line('R-ND', 5), line('S-ND')]), [old, newer, sibling]).lines[0]!.row?.id, newer.id);
  // Alone, quantity decides; with no quantity signal the oldest order wins.
  assert.equal(matchSlip(slip([line('R-ND', 10)]), [old, newer]).lines[0]!.row?.id, newer.id);
  assert.equal(matchSlip(slip([line('R-ND', null)]), [old, newer]).lines[0]!.row?.id, old.id);
});

test('matchSlip: backordered lines (0 shipped) are not in the box; one row per line', () => {
  const a = row({ partNumber: 'A-ND' });
  const m = matchSlip(slip([line('A-ND', 0), line('A-ND', 2), line('A-ND', 2)]), [a]);
  assert.equal(m.lines.length, 2);
  assert.equal(m.matchedRows.length, 1);
  assert.equal(m.confidence, 'strong');
});

test('matchSlip: under half the lines matched is weak', () => {
  const m = matchSlip(slip([line('A-ND'), line('NOPE1'), line('NOPE2')]), [row({ partNumber: 'A-ND' })]);
  assert.equal(m.confidence, 'weak');
});

test('parseExtraction: tolerates junk and drops lines with nothing to match on', () => {
  const e = parseExtraction({
    is_shipping_document: true,
    legible: true,
    vendor: '  DigiKey ',
    order_numbers: [{ kind: 'bogus', value: '123' }, { kind: 'invoice', value: '' }],
    tracking_numbers: ['1Z 999', 7],
    lines: [{ vendor_part_number: 'A-ND', quantity_shipped: '3' }, { description: 'just text' }],
  });
  assert.equal(e.vendor, 'DigiKey');
  assert.deepEqual(e.orderNumbers, [{ kind: 'other', value: '123' }]);
  assert.deepEqual(e.trackingNumbers, ['1Z 999']);
  assert.equal(e.lines.length, 1);
  assert.equal(e.lines[0]!.quantityShipped, null);
  assert.equal(parseExtraction(null).isShippingDocument, false);
});

test('theseValue: picks the shorter encoding; targetIds resolves both the same way', () => {
  const order = Array.from({ length: 60 }, (_, i) => row({ partNumber: `P${i}-ND`, runId: 'BENBUYS-4334609', id: `0000000${i}-aaaa-bbbb-cccc-dddddddddddd` }));
  const m = matchSlip(slip(order.slice(0, 58).map((r) => line(r.partNumber))), order);
  const v = theseValue(m, BASE);
  assert.equal(v.g, 'BENBUYS-4334609');
  assert.equal(v.x?.length, 2);
  assert.ok(encodeValue(v).length < 2000);
  const ids = targetIds(decodeValue(encodeValue(v))!, order.map((r) => r.id));
  assert.equal(ids.length, 58);
  assert.ok(!ids.includes(order[59]!.id.replace(/-/g, '')));

  const small = matchSlip(slip([line('P0-ND')]), order);
  const sv = theseValue(small, BASE);
  assert.equal(sv.g, undefined);
  assert.deepEqual(targetIds(sv, []), [order[0]!.id.replace(/-/g, '')]);
});

test('buildReply: whole order → Confirm + Wrong; partial → These N / All M / Wrong; no prices', () => {
  const a = row({ partNumber: 'A-ND', runId: 'BENBUYS-1', pointOfContact: ['Sofia Ramirez'], unitCost: 123.45, name: 'Hall sensor' });
  const b = row({ partNumber: 'B-ND', runId: 'BENBUYS-1', pointOfContact: ['Sofia Ramirez'], unitCost: 9.99 });
  const whole = buildReply(slip([line('A-ND'), line('B-ND')]), matchSlip(slip([line('A-ND'), line('B-ND')]), [a, b]), BASE);
  const json = JSON.stringify(whole.blocks);
  assert.match(json, /\*Sofia\*'s \*DigiKey\* order from \*Sep 28\*: \*2 of 2\* items/);
  assert.doesNotMatch(json, /123\.45|9\.99|\$/);
  const actions = whole.blocks.find((bl) => bl.type === 'actions');
  assert.deepEqual(actions.elements.map((e: any) => e.action_id), ['arrival_these', 'arrival_wrong']);

  const partial = buildReply(slip([line('A-ND')]), matchSlip(slip([line('A-ND')]), [a, b]), BASE);
  const pActions = partial.blocks.find((bl) => bl.type === 'actions');
  assert.deepEqual(pActions.elements.map((e: any) => e.text.text), ['These 1 arrived', 'All 2 arrived', 'Wrong order']);
  assert.match(JSON.stringify(partial.blocks), /1 more item on this order not in this box/);
});

test('buildReply: unreadable → retake; readable but unmatched → no buttons', () => {
  const blurry = buildReply(slip([], { legible: false }), matchSlip(slip([]), []), BASE);
  assert.match(JSON.stringify(blurry.blocks), /Retake it/);
  const unknown = buildReply(slip([line('NOPE-ND')]), matchSlip(slip([line('NOPE-ND')]), [row({ partNumber: 'A-ND' })]), BASE);
  assert.ok(!unknown.blocks.some((bl) => bl.type === 'actions'));
  assert.match(JSON.stringify(unknown.blocks), /NOPE-ND/);
});

test('leadTimeLine, settleBlocks, packageKey', () => {
  const r = row({ partNumber: 'A-ND', submittedAt: '2026-09-20', orderedAt: '2026-09-28T15:00:00.000Z' });
  assert.equal(leadTimeLine([r], '2026-10-10T16:00:00.000Z'), 'Ordered Sep 28 → here Oct 10 (*12 days*) · requested Sep 20 (*20 days* end to end)');
  assert.equal(leadTimeLine([row({ partNumber: 'A', submittedAt: null, orderedAt: null })], '2026-10-10T16:00:00.000Z'), null);

  const settled = settleBlocks([{ type: 'section' }, { type: 'actions', block_id: 'arrival_actions' }], 'done');
  assert.deepEqual(settled.map((b) => b.type), ['section', 'context']);

  assert.equal(packageKey(slip([], { trackingNumbers: ['1z 999 aa'] })), 'digikey:1Z999AA');
  assert.equal(packageKey(slip([])), null);
});

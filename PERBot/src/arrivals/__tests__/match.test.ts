import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeValue, encodeValue, leadTimeLine, packageKey, settleBlocks, targetIds, theseValue } from '../blocks.js';
import { parseScan } from '../extract.js';
import { matchSlip, partCodes, vendorKey } from '../match.js';
import { BASE, line, pkg, row } from './helpers.js';

test('vendorKey: spellings collapse; unaliased vendors key on their first word', () => {
  assert.equal(vendorKey('McMaster-Carr Supply Co.'), 'mcmaster');
  assert.equal(vendorKey('mcmaster carr'), 'mcmaster');
  assert.equal(vendorKey('www.mcmaster.com'), 'mcmaster');
  assert.equal(vendorKey('Digi-Key Electronics'), 'digikey');
  assert.equal(vendorKey('JLCCNC'), 'jlcpcb');
  assert.equal(vendorKey('Eurotech Distributors, Inc.'), 'eurotech');
  assert.equal(vendorKey('eurotech direct'), 'eurotech');
  assert.equal(vendorKey(null), '');
});

test('matchSlip: part numbers pick the order; whole order on the slip', () => {
  const a = row({ partNumber: 'A-ND', runId: 'BENBUYS-4334609' });
  const b = row({ partNumber: ' b-nd ', runId: 'BENBUYS-4334609' });
  const other = row({ partNumber: 'C-ND', runId: 'PERPO-1' });
  const m = matchSlip(pkg([line('A-ND'), line('B-ND')]), [a, b, other]);
  assert.equal(m.confidence, 'strong');
  assert.equal(m.runId, 'BENBUYS-4334609');
  assert.deepEqual(m.matchedRows.map((r) => r.id), [a.id, b.id]);
  assert.deepEqual(m.orderRows.map((r) => r.id), [a.id, b.id]);
});

test('matchSlip: requisition number on the slip is an exact match even if parts differ', () => {
  const a = row({ partNumber: 'X-ND', runId: 'BENBUYS-4334609' });
  const m = matchSlip(pkg([line('ZZZ')], { orderNumbers: [{ kind: 'purchase_order', value: 'PO 4334609' }] }), [a]);
  assert.equal(m.confidence, 'exact');
  assert.equal(m.matchedRows.length, 0);
  assert.equal(m.orderRows.length, 1);
});

test('matchSlip: never crosses vendors; manufacturer number and customer reference also match', () => {
  const mc = row({ partNumber: '91251A540', vendor: 'McMaster-Carr' });
  const dk = row({ partNumber: 'LM358DR', vendor: 'digikey' });
  const ref = row({ partNumber: 'Q-ND', vendor: 'Digi-Key', sanitizedDescription: 'HALL SENSOR BOARD CONNECTOR 4 PIN' });
  const m = matchSlip(
    pkg([line('91251A540'), line('296-1395-1-ND', 1, { manufacturerPartNumber: 'LM358DR' }), line('OTHER-ND', 1, { customerReference: 'HALL SENSOR BOARD CONNEC' })]),
    [mc, dk, ref]
  );
  assert.deepEqual(m.lines.map((l) => l.row?.id ?? null), [null, dk.id, ref.id]);
});

test('matchSlip: free-text rows match on a shared model code (real Eurotech bill of lading)', () => {
  const coroflex = row({ partNumber: '5 meters of FHLR2GCB2G (3x2.5mm²)', vendor: 'Eurotech Direct', link: '' });
  const plain = row({ partNumber: '5 meters of 2x 6mm^2', vendor: 'eurotech direct', link: '' });
  const digikey = row({ partNumber: 'FHLR2GCB2G', vendor: 'DigiKey' });
  const m = matchSlip(
    pkg(
      [line('P500031', 5, { description: 'Coroflex 9-2641 FHLR2GCB2G 3x2.5mm² ORG' }), line('P500023', 5, { description: 'Coroflex 9-2641 FHLR2GCB2G 2x6mm² ORG' })],
      { vendor: 'Eurotech Distributors, Inc.' }
    ),
    [coroflex, plain, digikey]
  );
  assert.deepEqual(m.lines.map((l) => l.row?.id ?? null), [coroflex.id, null]);
  assert.deepEqual([...partCodes('3x2.5mm² 5888694 FHLR2GCB2G LM358DR')], ['FHLR2GCB2G', 'LM358DR']);
});

test('matchSlip: same part on two orders → dominant order, then quantity, then oldest', () => {
  const old = row({ partNumber: 'R-ND', runId: 'BENBUYS-1111111', orderedAt: '2026-09-01', quantity: 5 });
  const newer = row({ partNumber: 'R-ND', runId: 'BENBUYS-2222222', orderedAt: '2026-09-20', quantity: 10 });
  const sibling = row({ partNumber: 'S-ND', runId: 'BENBUYS-2222222' });
  assert.equal(matchSlip(pkg([line('R-ND', 5), line('S-ND')]), [old, newer, sibling]).lines[0]!.row?.id, newer.id);
  assert.equal(matchSlip(pkg([line('R-ND', 10)]), [old, newer]).lines[0]!.row?.id, newer.id);
  assert.equal(matchSlip(pkg([line('R-ND', null)]), [old, newer]).lines[0]!.row?.id, old.id);
});

test('matchSlip: backordered lines (0 shipped) are not in the box; one row per line; under half is weak', () => {
  const a = row({ partNumber: 'A-ND' });
  const m = matchSlip(pkg([line('A-ND', 0), line('A-ND', 2), line('A-ND', 2)]), [a]);
  assert.equal(m.lines.length, 2);
  assert.equal(m.matchedRows.length, 1);
  assert.equal(matchSlip(pkg([line('A-ND'), line('NOPE1'), line('NOPE2')]), [a]).confidence, 'weak');
});

test('parseScan: tolerates junk; not_a_delivery drops packages; bad dates and empty lines go', () => {
  const s = parseScan({
    scene: 'shipping_label',
    legible: true,
    packages: [
      {
        vendor: '  DigiKey ',
        addressee: 'KATHERINE SHEN',
        ship_date: '28SEP26',
        order_numbers: [{ kind: 'bogus', value: '123' }, { kind: 'invoice', value: '' }],
        tracking_numbers: ['1Z 999', 7],
        lines: [{ vendor_part_number: 'A-ND', quantity_shipped: '3' }, {}],
        item_hints: ['cooling tube', ''],
      },
    ],
  });
  const p = s.packages[0]!;
  assert.equal(p.vendor, 'DigiKey');
  assert.equal(p.shipDate, null);
  assert.deepEqual(p.orderNumbers, [{ kind: 'other', value: '123' }]);
  assert.deepEqual(p.trackingNumbers, ['1Z 999']);
  assert.equal(p.lines.length, 1);
  assert.equal(p.lines[0]!.quantityShipped, null);
  assert.deepEqual(p.itemHints, ['cooling tube']);
  const hints = parseScan({ scene: 'contents', legible: true, packages: [{ item_hints: ['cardboard poster/tube', 'DigiKey box', 'PCBs', 'PCBs (JLCPCB)', 'heat fins', 'steering rack'] }] });
  assert.deepEqual(hints.packages[0]!.itemHints, ['heat fins', 'steering rack']);
  assert.deepEqual(parseScan({ scene: 'not_a_delivery', packages: [{ vendor: 'x' }] }).packages, []);
  assert.equal(parseScan(null).scene, 'not_a_delivery');
});

test('theseValue: picks the shorter encoding; targetIds resolves both the same way', () => {
  const order = Array.from({ length: 60 }, (_, i) => row({ partNumber: `P${i}-ND`, runId: 'BENBUYS-4334609', id: `0000000${i}-aaaa-bbbb-cccc-dddddddddddd` }));
  const m = matchSlip(pkg(order.slice(0, 58).map((r) => line(r.partNumber))), order);
  const v = theseValue(m, BASE);
  assert.equal(v.g, 'BENBUYS-4334609');
  assert.equal(v.x?.length, 2);
  assert.ok(encodeValue(v).length < 2000);
  const ids = targetIds(decodeValue(encodeValue(v))!, order.map((r) => r.id));
  assert.equal(ids.length, 58);
  assert.ok(!ids.includes(order[59]!.id.replace(/-/g, '')));
  const sv = theseValue(matchSlip(pkg([line('P0-ND')]), order), BASE);
  assert.equal(sv.g, undefined);
  assert.deepEqual(targetIds(sv, []), [order[0]!.id.replace(/-/g, '')]);
});

test('leadTimeLine, settleBlocks (one package only), packageKey', () => {
  const r = row({ partNumber: 'A-ND', submittedAt: '2026-09-20', orderedAt: '2026-09-28T15:00:00.000Z' });
  assert.equal(leadTimeLine([r], '2026-10-10T16:00:00.000Z'), 'Ordered Sep 28 → here Oct 10 (*12 days*) · requested Sep 20 (*20 days* end to end)');
  assert.equal(leadTimeLine([row({ partNumber: 'A', submittedAt: null, orderedAt: null })], '2026-10-10T16:00:00.000Z'), null);

  const blocks = [{ type: 'section' }, { type: 'actions', block_id: 'arrival_actions:0' }, { type: 'actions', block_id: 'arrival_actions:1' }];
  assert.deepEqual(settleBlocks(blocks, 'arrival_actions:1', 'done').map((b) => b.type), ['section', 'actions', 'context']);

  assert.equal(packageKey(pkg([], { trackingNumbers: ['1z 999 aa'] })), 'digikey:1Z999AA');
  assert.equal(packageKey(pkg([])), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { aggregateRows, buildPrep, formatPrep, normalizePartNumber, warningsFor } from '../prep.js';
import { cleanReferenceText, truncateAtWord, truncateReference } from '../reference.js';
import { row, testAdapter } from './helpers.js';

test('normalizePartNumber: trims, collapses wrapped whitespace/newlines, uppercases', () => {
  // The "wrapped 399-…" part numbers from the PEFS view render with soft breaks.
  assert.equal(normalizePartNumber('  399-C1206X223KDRACTUCT-ND '), '399-C1206X223KDRACTUCT-ND');
  assert.equal(normalizePartNumber('399-C0603C103K5RA\nCTUCT-ND'), '399-C0603C103K5RACTUCT-ND');
  assert.equal(normalizePartNumber('399-c0603c220j5gactuct-nd'), '399-C0603C220J5GACTUCT-ND');
  assert.equal(normalizePartNumber('505-LTC6820HMS#PBF-ND'), '505-LTC6820HMS#PBF-ND');
  assert.equal(normalizePartNumber('296-LP38693SD-3.3/NOPBCT-ND'), '296-LP38693SD-3.3/NOPBCT-ND');
  assert.equal(normalizePartNumber('MS1238E24B1+6-FHR-2EM'), 'MS1238E24B1+6-FHR-2EM');
});

test('aggregateRows: sums quantities across rows with the same normalized part number', () => {
  // Real duplicates from the current REV12 Order 1 view.
  const rows = [
    row({ partNumber: 'F2895CT-ND', quantity: 4, unitCost: 1, sanitizedDescription: 'TVS DIODE 5.5VWM 13VC SC705' }),
    row({ partNumber: 'f2895ct-nd ', quantity: 8, unitCost: 1, sanitizedDescription: 'TVS DIODE 5.5VWM 13VC SC705' }),
    row({ partNumber: 'BKCT3151-0-ND', quantity: 2, unitCost: 2.55, sanitizedDescription: 'CONN BANANA JACK SOLDER BLACK' }),
    row({ partNumber: 'BKCT3151-0-ND', quantity: 10, unitCost: 2.55, sanitizedDescription: 'CONN BANANA JACK SOLDER BLACK', subsystems: ['HV/Secondary'] }),
    row({ partNumber: '732-4649-1-ND', quantity: 3, unitCost: 0.23 }),
  ];
  const lines = aggregateRows(rows, testAdapter);
  assert.deepEqual(
    lines.map((l) => [l.partNumber, l.quantity, l.lineTotal, l.rows.length]),
    [
      ['F2895CT-ND', 12, 12, 2],
      ['BKCT3151-0-ND', 12, 30.6, 2],
      ['732-4649-1-ND', 3, 0.69, 1],
    ]
  );
  assert.equal(lines[0]!.reference, 'TVS DIODE 5.5VWM 13VC SC705');
});

test('aggregateRows: skips rows with an empty part number, keeps first-seen order', () => {
  const lines = aggregateRows([row({ partNumber: '   ' }), row({ partNumber: 'B-ND' }), row({ partNumber: 'A-ND' })], testAdapter);
  assert.deepEqual(lines.map((l) => l.partNumber), ['B-ND', 'A-ND']);
});

test('truncateAtWord: 35 chars at a word boundary, no ellipsis', () => {
  assert.equal(truncateAtWord('CAP CER 0.022UF 1KV X7R 1206', 35), 'CAP CER 0.022UF 1KV X7R 1206');
  assert.equal(
    truncateAtWord('ARM® Cortex®-M7 STM32F7 Microcontroller IC 32-Bit 216MHz 1MB (1M x 8) FLASH 100-LQFP (14x14)', 35),
    'ARM® Cortex®-M7 STM32F7'
  );
  assert.equal(truncateAtWord('Fan Tubeaxial 12VDC Square - 120mm L x 120mm H Ball 271.1 CFM', 35), 'Fan Tubeaxial 12VDC Square - 120mm');
  // Exactly at the boundary: keep the full word when the next char is a space.
  assert.equal(truncateAtWord('ABCDEFGHIJ ABCDEFGHIJ ABCDEFGHIJ AB DEF', 35), 'ABCDEFGHIJ ABCDEFGHIJ ABCDEFGHIJ AB');
  // Mid-word at the boundary: back up to the previous space.
  assert.equal(truncateAtWord('ABCDEFGHIJ ABCDEFGHIJ ABCDEFGHIJ ABCDEF', 35), 'ABCDEFGHIJ ABCDEFGHIJ ABCDEFGHIJ');
  // Short descriptions with too little signal are dropped so the caller can fall back.
  assert.equal(truncateAtWord('digikey', 35), '');
  // A single 40-char token has no word boundary: hard-cut at 35 rather than drop it.
  assert.equal(truncateAtWord('A'.repeat(40), 35), 'A'.repeat(35));
  // A word boundary that would leave < 8 chars of signal → '' (caller falls back).
  assert.equal(truncateAtWord('ABCDEFG HIJKLMNOPQRSTUVWXYZ0123456789ABCDEF', 35), '');
});

test('cleanReferenceText: commas and newlines never survive into a cart line', () => {
  assert.equal(cleanReferenceText('LEAD FREE, NO CLEAN\nFLUX  1L'), 'LEAD FREE NO CLEAN FLUX 1L');
});

test('truncateReference: falls back to the part number when the description is empty or too short', () => {
  assert.equal(truncateReference('497-16630-ND', [row({ partNumber: '497-16630-ND', sanitizedDescription: '' })], 35), '497-16630-ND');
  assert.equal(truncateReference('497-16630-ND', [row({ partNumber: '497-16630-ND', sanitizedDescription: 'digikey' })], 35), '497-16630-ND');
  assert.equal(
    truncateReference('X-ND', [row({ partNumber: 'X-ND', sanitizedDescription: 'ABCDEFG HIJKLMNOPQRSTUVWXYZ0123456789ABCDEF' })], 35),
    'X-ND'
  );
});

test('truncateReference: aggregated rows with differing descriptions get +N and stay within the cap', () => {
  const rows = [
    row({ partNumber: 'P-ND', sanitizedDescription: 'RES 1.5K OHM 1% 1/10W 0603 THICK FILM' }),
    row({ partNumber: 'P-ND', sanitizedDescription: 'RESISTOR 1.5K' }),
    row({ partNumber: 'P-ND', sanitizedDescription: 'RES 1.5K OHM 1% 1/10W 0603 THICK FILM' }),
  ];
  const ref = truncateReference('P-ND', rows, 35);
  assert.equal(ref, 'RES 1.5K OHM 1% 1/10W 0603 THICK +2');
  assert.equal(ref.length, 35);
  // Identical descriptions → no suffix.
  assert.equal(truncateReference('P-ND', [rows[0]!, rows[2]!], 35), 'RES 1.5K OHM 1% 1/10W 0603 THICK');
});

test('warningsFor: the four §6 checks, none of which exclude a row', () => {
  const rows = [
    row({ partNumber: 'CPF0603B47KE', quantity: 5, unitCost: 0.23 }), // no -ND
    row({ partNumber: 'MS1238E24B1+6-FHR-2EM', quantity: 2, unitCost: 34.95, name: 'MS1238E24B1+6-FHR-2EM', sanitizedDescription: 'digikey' }),
    row({ partNumber: '732-4649-1-ND', quantity: 3, unitCost: 0.23, orderBatch: 'Order 1' }),
    row({ partNumber: '732-4649-1-ND', quantity: 5, unitCost: 0.23, orderBatch: 'Order 2' }),
    row({ partNumber: '473-836LFNC-1L-ND', quantity: 3, unitCost: 49.19 }), // 147.57 > 100
  ];
  const lines = aggregateRows(rows, testAdapter);
  assert.equal(lines.length, 4);
  const warnings = warningsFor(lines, testAdapter).map((w) => `${w.partNumber}: ${w.message}`);
  assert.deepEqual(warnings, [
    'CPF0603B47KE: may be a manufacturer part number — DigiKey may pick different packaging',
    'MS1238E24B1+6-FHR-2EM: may be a manufacturer part number — DigiKey may pick different packaging',
    'MS1238E24B1+6-FHR-2EM: description looks like a part number',
    '732-4649-1-ND: aggregated across batches (Order 1, Order 2)',
    '473-836LFNC-1L-ND: high-value line ($147.57) — double-check quantity',
  ]);
});

test('buildPrep: "Include in next order" narrows to the ticked rows only', () => {
  const ready = [row({ partNumber: 'A-ND', includeInNextOrder: true }), row({ partNumber: 'B-ND' }), row({ partNumber: 'C-ND', includeInNextOrder: true })];
  const prep = buildPrep(testAdapter, ready, []);
  assert.equal(prep.cherryPicked, true);
  assert.deepEqual(prep.lines.map((l) => l.partNumber), ['A-ND', 'C-ND']);
  assert.deepEqual(prep.rows.map((r) => r.partNumber), ['A-ND', 'C-ND']);
  const all = buildPrep(testAdapter, ready.map((r) => ({ ...r, includeInNextOrder: false })), []);
  assert.equal(all.cherryPicked, false);
  assert.equal(all.lines.length, 3);
});

test('buildPrep: estimated total is Σ qty × unit cost over the selected rows, rounded to cents', () => {
  const prep = buildPrep(testAdapter, [row({ partNumber: 'A-ND', quantity: 500, unitCost: 0.14502 }), row({ partNumber: 'B-ND', quantity: 3, unitCost: 3.47 })], []);
  assert.equal(prep.estimatedTotal, 82.92);
});

test('formatPrep: zero ready rows → no paste block, not-ready rows still listed', () => {
  const notReady = [row({ partNumber: '1727-7329-1-ND', unitCost: 0, readiness: '❌ Missing fields', name: 'DIODE SCHOTTKY 20V 500MA SOD123' })];
  const blocks = formatPrep(testAdapter, buildPrep(testAdapter, [], notReady), 500);
  assert.equal(blocks.cart, '');
  assert.match(blocks.summary, /^No ready DigiKey rows to order\./);
  assert.match(blocks.summary, /Not ready \(fix in Notion\): 1 row — <https:\/\/notion\.so\/page-\d+\|DIODE SCHOTTKY 20V 500MA SOD123>/);
  assert.doesNotMatch(blocks.summary, /Next:/);
});

const SNAPSHOT = fileURLToPath(new URL('./fixtures/prep.snapshot.txt', import.meta.url));

test('formatPrep: snapshot of the three blocks', () => {
  const ready = [
    row({ id: 'r1', url: 'https://notion.so/r1', partNumber: '399-C1206X223KDRACTUCT-ND', quantity: 10, unitCost: 0.434, sanitizedDescription: 'CAP CER 0.022UF 1KV X7R 1206', orderBatch: 'Order 1' }),
    row({ id: 'r2', url: 'https://notion.so/r2', partNumber: '399-C0603C103K5RACTUCT-ND', quantity: 8, unitCost: 0.16, sanitizedDescription: 'CAP CER 10000PF 50V X7R 0603', orderBatch: 'Order 1' }),
    row({ id: 'r3', url: 'https://notion.so/r3', partNumber: '725-S1-12-BDM-ND', quantity: 3, unitCost: 4.1, sanitizedDescription: 'RELAY REED 1 N/C 1.5KV 12V', orderBatch: 'Order 1' }),
    row({ id: 'r4', url: 'https://notion.so/r4', partNumber: '399-c1206x223kdractuct-nd', quantity: 6, unitCost: 0.434, sanitizedDescription: 'CAP CER 0.022UF 1KV X7R 1206', orderBatch: 'Order 2' }),
    row({ id: 'r5', url: 'https://notion.so/r5', partNumber: '497-16630-ND', quantity: 10, unitCost: 17.779, sanitizedDescription: 'ARM® Cortex®-M7 STM32F7 Microcontroller IC 32-Bit 216MHz 1MB (1M x 8) FLASH 100-LQFP (14x14)', orderBatch: '' }),
    row({ id: 'r6', url: 'https://notion.so/r6', partNumber: 'CRGP2010F1M0', quantity: 10, unitCost: 0.44, sanitizedDescription: 'RES 1M OHM 1% 1.25W 2010', orderBatch: 'Order 2' }),
  ];
  const notReady = [
    row({ id: 'n1', url: 'https://notion.so/n1', partNumber: '1727-7329-1-ND', unitCost: 0, readiness: '❌ Missing fields', name: 'DIODE SCHOTTKY 20V 500MA SOD123' }),
    row({ id: 'n2', url: 'https://notion.so/n2', partNumber: '', readiness: '❌ Missing fields', name: 'Radiator | fans <TBD>' }),
  ];
  const blocks = formatPrep(testAdapter, buildPrep(testAdapter, ready, notReady), 500);
  const actual = `--- cart ---\n${blocks.cart}\n--- ben ---\n${blocks.ben}\n--- summary ---\n${blocks.summary}\n`;
  if (process.env.UPDATE_SNAPSHOTS) writeFileSync(SNAPSHOT, actual);
  assert.equal(actual, readFileSync(SNAPSHOT, 'utf8'));
});

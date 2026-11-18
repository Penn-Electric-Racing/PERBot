import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPurchasingBlocks, sanitizePlan } from '../answer.js';
import { runPurchaseQuery, termMatches } from '../query.js';
import { parsePurchaseRecord, stageOf, type PurchaseRecord } from '../records.js';

function rec(over: Partial<PurchaseRecord>): PurchaseRecord {
  return {
    id: over.name ?? 'id',
    url: 'https://notion.so/x',
    name: '',
    partNumber: '',
    vendor: '',
    link: '',
    season: 'REV12',
    subsystems: [],
    quantity: 1,
    unitCost: 10,
    totalCost: 10,
    paymentMethod: 'PEFS',
    orderBatch: '',
    pointOfContact: [],
    urgency: [],
    stage: 'ordered',
    createdAt: '2026-10-01T00:00:00.000Z',
    submittedAt: '2026-10-01',
    orderedAt: null,
    arrivedAt: null,
    receivedBy: '',
    notes: '',
    description: '',
    ...over,
  };
}

const ROWS = [
  rec({ name: 'AIR contactor', partNumber: 'EV200AAANA', vendor: 'DigiKey', subsystems: ['Accumulator'], totalCost: 300, stage: 'arrived', submittedAt: '2026-10-03' }),
  rec({ name: 'Busbar copper 1/8"', vendor: 'McMaster-Carr', subsystems: ['Accumulator'], totalCost: 120.5, stage: 'ordered', submittedAt: '2026-11-02' }),
  rec({ name: 'M6 bolts', vendor: 'McMaster', subsystems: ['Chassis'], totalCost: null, stage: 'not submitted', submittedAt: null }),
  rec({ name: 'Old AIR', season: 'REV11', vendor: 'Mouser', totalCost: 250, stage: 'sent to purchasing', submittedAt: '2025-12-01' }),
  rec({ name: 'LTC6811 BMS IC', partNumber: 'LTC6811HG-1#3ZZPBF', vendor: 'DigiKey', subsystems: ['Accumulator'], totalCost: 40, stage: 'ready for pickup' }),
];

test('stageOf folds the order columns into one stage', () => {
  const base = { arrived: 'No', procurementSubmitted: false, emailUpdate: false, exported: false };
  assert.equal(stageOf(base), 'not submitted');
  assert.equal(stageOf({ ...base, exported: true }), 'sent to purchasing');
  assert.equal(stageOf({ ...base, exported: true, emailUpdate: true }), 'ordered');
  assert.equal(stageOf({ ...base, arrived: 'Ready for Pickup', exported: true }), 'ready for pickup');
  assert.equal(stageOf({ ...base, arrived: 'Yes' }), 'arrived');
});

test('parsePurchaseRecord reads the Notion properties', () => {
  const r = parsePurchaseRecord({
    id: 'p1',
    url: 'https://notion.so/p1',
    created_time: '2026-10-01T00:00:00.000Z',
    properties: {
      Name: { title: [{ plain_text: 'AIR' }] },
      'Quant.': { number: 2 },
      'Unit cost': { number: 150 },
      'Total cost': { formula: { type: 'number', number: 300 } },
      Season: { select: { name: 'REV12' } },
      'Arrived?': { status: { name: 'No' } },
      'Exported?': { checkbox: true },
      'Procurement Status': { select: { name: 'Submitted' } },
      'Point of contact': { people: [{ name: 'Sam' }] },
      Vendor: { rich_text: [{ plain_text: 'DigiKey' }] },
    },
  });
  assert.equal(r.stage, 'ordered');
  assert.equal(r.totalCost, 300);
  assert.deepEqual(r.pointOfContact, ['Sam']);
  assert.equal(r.vendor, 'DigiKey');
});

test('termMatches handles part numbers with punctuation and word order', () => {
  assert.ok(termMatches(ROWS[4]!, 'ltc6811'));
  assert.ok(termMatches(ROWS[0]!, 'contactor air'));
  assert.ok(!termMatches(ROWS[1]!, 'air contactor'));
});

test('defaults to the current season and computes totals in code', () => {
  const r = runPurchaseQuery(ROWS, { subsystems: ['accumulator'], groupBy: 'vendor' }, { currentSeason: 'REV12' });
  assert.equal(r.matched, 3);
  assert.equal(r.totalCost, 460.5);
  assert.deepEqual(r.groups.map((g) => g.key), ['DigiKey', 'McMaster-Carr']);
  assert.deepEqual(r.stageCounts, { ordered: 1, 'ready for pickup': 1, arrived: 1 });
});

test('falls back to every season when the item is not in the current one', () => {
  const r = runPurchaseQuery(ROWS, { terms: ['old air'] }, { currentSeason: 'REV12' });
  assert.equal(r.matched, 1);
  assert.equal(r.rows[0]!.season, 'REV11');
  assert.equal(r.notes.length, 1);
});

test('vendor matching ignores punctuation, missing costs are counted separately', () => {
  const r = runPurchaseQuery(ROWS, { vendors: ['mcmaster'] }, { currentSeason: 'REV12' });
  assert.equal(r.matched, 2);
  assert.equal(r.totalCost, 120.5);
  assert.equal(r.missingCost, 1);
});

test('stage and date filters', () => {
  const open = runPurchaseQuery(ROWS, { stages: ['not submitted', 'ordered'] }, { currentSeason: 'REV12' });
  assert.equal(open.matched, 2);
  const recent = runPurchaseQuery(ROWS, { since: '2026-11-01' }, { currentSeason: 'REV12' });
  assert.deepEqual(recent.rows.map((x) => x.name), ['Busbar copper 1/8"']);
});

test('sanitizePlan drops unknown values', () => {
  const plan = sanitizePlan({
    terms: ['AIR', 3, ''],
    subsystems: ['accumulator', 'Nope'],
    seasons: ['11'],
    stages: ['Arrived', 'shipped'],
    groupBy: 'vibes',
    since: 'last week',
    until: '2026-11-30',
    extra: 'x',
  });
  assert.deepEqual(plan, { terms: ['AIR'], subsystems: ['Accumulator'], seasons: ['REV11'], stages: ['arrived'], until: '2026-11-30' });
});

test('blocks link the cited rows', () => {
  const blocks = buildPurchasingBlocks({ summary: 'Yes, arrived [2].', rows: [ROWS[1]!, ROWS[0]!], matched: 2, totalCost: 420.5 });
  assert.match(blocks[1].text.text, /^\[2\] <https:\/\/notion\.so\/x\|AIR contactor> · arrived$/);
  assert.match(blocks[2].elements[0].text, /2 matching rows · \$420\.5/);
});

test('short words only match whole words', () => {
  const pair = rec({ name: 'Bearing pair', notes: 'repair kit' });
  assert.ok(!termMatches(pair, 'AIR'));
  assert.ok(termMatches(rec({ name: 'AIRs for accumulator' }), 'AIR'));
});

test('vendor breakdown merges spellings under the most common one', () => {
  const rows = [
    rec({ vendor: 'McMaster-Carr', totalCost: 5 }),
    rec({ vendor: 'McMaster Carr', totalCost: 5 }),
    rec({ vendor: 'McMaster Carr', totalCost: 5 }),
    rec({ vendor: 'mcmaster', totalCost: 5 }),
    rec({ vendor: 'Digi-Key', totalCost: 1 }),
  ];
  const r = runPurchaseQuery(rows, { groupBy: 'vendor' }, { currentSeason: 'REV12' });
  assert.deepEqual(r.groups.map((g) => [g.key, g.count]), [['McMaster Carr', 4], ['Digi-Key', 1]]);
});

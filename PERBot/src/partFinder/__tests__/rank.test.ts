import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyQty, DEFAULT_WEIGHTS, makeWeights, relevance, Scorer, shipDays, shipValue } from '../rank.js';
import { candidate, listing } from './helpers.js';

const hit = (title: string) => ({ title, snippet: '', url: 'https://x.com/p/1', pageTitle: null });

test('shipDays: spans, hours, weeks, same day, dates', () => {
  const today = new Date(Date.UTC(2026, 9, 12)); // Mon Oct 12 2026
  assert.equal(shipDays('3-5 business days'), 5);
  assert.equal(shipDays('72 hours'), 3);
  assert.equal(shipDays('2 hours'), 1);
  assert.equal(shipDays('2 weeks'), 14);
  assert.equal(shipDays('ships today'), 1);
  assert.equal(shipDays('Thu, Oct 15', today), 3);
  assert.equal(shipDays('Jan 2', today), 82); // next year
  assert.equal(shipDays(null), null);
  assert.equal(shipDays('soon'), null);
});

test('shipValue: free, symbols, currency suffix, unknown', () => {
  assert.equal(shipValue('Free'), 0);
  assert.equal(shipValue('$5.99'), 5.99);
  assert.equal(shipValue('4.50 USD'), 4.5);
  assert.equal(shipValue(null), null);
  assert.equal(shipValue('call us'), null);
});

test('relevance: exact part number has no variants; a longer code is flagged', () => {
  assert.deepEqual(relevance('LM317', hit('LM317 regulator TO-220')), { fraction: 1, keyHit: true, variants: [] });
  const v = relevance('LM317', hit('LM317L regulator TO-92'));
  assert.equal(v.keyHit, true);
  assert.deepEqual(v.variants, ['LM317L']);
  assert.equal(relevance('LM7805 regulator', hit('7805 thing')).keyHit, false);
});

test('applyQty: pack listings are bought in packs', () => {
  const c = applyQty(listing(0, { cost: 5.9, packSize: 10 }), 25);
  assert.equal(c.packsNeeded, 3);
  assert.equal(c.subtotal, 17.7);
  assert.equal(c.unitCost, 0.59);
});

test('applyQty: a reached price break overrides the pack and the base price', () => {
  const c = applyQty(listing(0, { cost: 5.9, packSize: 10, priceBreaks: [{ minQty: 100, price: 0.45 }] }), 150);
  assert.equal(c.packSize, 1);
  assert.equal(c.subtotal, 67.5);
});

test('applyQty: stock counts packs; out of stock is not enough', () => {
  assert.equal(applyQty(listing(0, { packSize: 10, stock: 3 }), 25).enoughStock, true);
  assert.equal(applyQty(listing(0, { packSize: 10, stock: 2 }), 25).enoughStock, false);
  assert.equal(applyQty(listing(0, { inStock: false }), 1).enoughStock, false);
});

test('applyQty: free shipping only once the order clears the minimum', () => {
  const small = applyQty(listing(0, { cost: 0.89, shippingCost: null, freeShipMin: 100 }), 1);
  assert.equal(small.shippingCost, null);
  assert.equal(small.total, null);
  const big = applyQty(listing(0, { cost: 0.89, shippingCost: null, freeShipMin: 100 }), 200);
  assert.equal(big.shippingCost, 'Free');
  assert.equal(big.total, big.subtotal);
});

test('scoreAll: the cheapest clean option scores 1.00', () => {
  const cs = [candidate(0, 1), candidate(1, 2)];
  new Scorer().scoreAll(cs, 'LM7805', 1);
  assert.equal(cs[0]!.score, 1.02); // only the llm source factor
  assert.ok(cs[1]!.score! > 2);
});

test('scoreAll: a variant ranks below an exact match at the same price', () => {
  const variant = candidate(0, 1, 1, { title: 'LM317L regulator' }); // better search rank
  const exact = candidate(1, 1, 1, { title: 'LM317 regulator' });
  new Scorer().scoreAll([variant, exact], 'LM317', 1);
  assert.ok(exact.score! < variant.score!);
  assert.ok(variant.notes.some((n) => n.includes('check suffix')));
});

test('scoreAll: snippet-only prices rank below page prices', () => {
  const page = candidate(1, 1);
  const snip = candidate(0, 1, 1, { costSource: 'llm snippet' });
  new Scorer().scoreAll([snip, page], 'LM7805', 1);
  assert.ok(page.score! < snip.score!);
});

test('scoreAll: unpriced listings get a note and no score', () => {
  const c = candidate(0, null);
  new Scorer().scoreAll([c], 'LM7805', 1);
  assert.equal(c.score, null);
  assert.deepEqual(c.notes, ['no price found']);
});

test('custom weights change the ranking', () => {
  const ranked = (scorer: Scorer) => {
    const cs = [candidate(0, 1, 1, { shippingTime: '12 days' }), candidate(1, 1.1)];
    scorer.scoreAll(cs, 'LM7805', 1);
    return scorer.pickTop(cs, 2).map((c) => c.supplier);
  };
  assert.deepEqual(ranked(new Scorer()), ['site1', 'site0']); // slow shipping costs ~20%
  assert.deepEqual(ranked(new Scorer(makeWeights({ perShipDay: 0 }))), ['site0', 'site1']);
});

test('makeWeights: merges source, rejects typos, never mutates the defaults', () => {
  const w = makeWeights({ source: { llm: 1.5 } });
  assert.equal(w.source.llm, 1.5);
  assert.equal(w.source['llm snippet'], 1.15);
  assert.equal(DEFAULT_WEIGHTS.source.llm, 1.02);
  assert.throws(() => makeWeights({ outOfStok: 2 } as any), /outOfStok/);
});

test('pickTop: out-of-stock and wrong-part listings sink; unpriced go last', () => {
  const cs = [
    candidate(0, 1, 1, { inStock: false }),
    candidate(1, 1, 1, { title: 'something else' }),
    candidate(2, null),
    candidate(3, 3),
  ];
  const s = new Scorer();
  s.scoreAll(cs, 'LM7805', 1);
  assert.deepEqual(s.pickTop(cs, 4).map((c) => c.supplier), ['site3', 'site0', 'site1', 'site2']);
});

test('pickTop: at most perSupplier from one supplier unless that leaves gaps', () => {
  const cs = [0, 1, 2].map((i) => candidate(i, 1 + i / 10, 1, { supplier: 'mouser' })).concat(candidate(3, 2));
  const s = new Scorer();
  s.scoreAll(cs, 'LM7805', 1);
  assert.deepEqual(s.pickTop(cs, 3).map((c) => c.searchRank), [0, 1, 3]);
  assert.equal(s.pickTop(cs, 4).length, 4);
});

test('pickTop cheapest: lowest effective cost regardless of penalties', () => {
  const slow = candidate(0, 1, 1, { shippingTime: '30 days' });
  const fast = candidate(1, 1.1);
  const s = new Scorer();
  s.scoreAll([slow, fast], 'LM7805', 1);
  assert.equal(s.pickTop([slow, fast], 1, 'best')[0], fast);
  assert.equal(s.pickTop([slow, fast], 1, 'cheapest')[0], slow);
});

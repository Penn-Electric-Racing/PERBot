import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, pickByName, pickLiveDeal } from '../match.js';

const row = (company: string) => ({ company });

test('normalizeName: case and punctuation collapse', () => {
  assert.equal(normalizeName('Jane  Street, Inc.'), 'jane street inc');
  assert.equal(normalizeName('SKF'), normalizeName('Skf'));
});

test('pickByName: an exact name beats substring hits (Keye vs Hawkeyeind)', () => {
  const m = pickByName([row('Keye'), row('Hawkeyeind')], 'keye');
  assert.deepEqual(m, { kind: 'one', row: row('Keye') });
});

test('pickByName: two exact hits stay ambiguous and list only those (SKF vs Skf)', () => {
  const m = pickByName([row('SKF'), row('Skf'), row('SKF Marine')], 'Skf');
  assert.equal(m.kind, 'many');
  assert.deepEqual(m.kind === 'many' && m.rows.map((r) => r.company), ['SKF', 'Skf']);
});

test('pickByName: a single substring hit is taken; zero is none', () => {
  assert.deepEqual(pickByName([row('Jane Street Capital')], 'jane street'), { kind: 'one', row: row('Jane Street Capital') });
  assert.deepEqual(pickByName([], 'x'), { kind: 'none' });
});

test('pickByName: several substring hits with no exact one are ambiguous', () => {
  const m = pickByName([row('Altium'), row('Altium Designer')], 'alt');
  assert.equal(m.kind, 'many');
});

test('pickLiveDeal: the one live deal wins over closed ones; two live stay ambiguous', () => {
  const won = { stage: 'Won' };
  const live = { stage: 'Contacted' };
  assert.deepEqual(pickLiveDeal([won, live]), { kind: 'one', row: live });
  assert.equal(pickLiveDeal([live, { stage: 'In talks' }]).kind, 'many');
  assert.equal(pickLiveDeal([won, { stage: 'Lost' }]).kind, 'many');
  assert.deepEqual(pickLiveDeal([]), { kind: 'none' });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertDevTarget } from '../guard.js';
import { toProperties, toPropertyValue } from '../notionProps.js';
import { EXPECTED_COLUMNS, finalizeRow, presetRows, PRESETS, seedTag } from '../pefsSeed.js';

const ctx = { batch: '1102-164500', season: 'REV12', now: new Date('2026-11-02T12:00:00Z') };

test('toPropertyValue maps plain values by Notion type', () => {
  assert.deepEqual(toPropertyValue('number', 3), { number: 3 });
  assert.deepEqual(toPropertyValue('number', ''), { number: null });
  assert.deepEqual(toPropertyValue('checkbox', 'yes'), { checkbox: true });
  assert.deepEqual(toPropertyValue('select', 'BenBuys'), { select: { name: 'BenBuys' } });
  assert.deepEqual(toPropertyValue('status', 'No'), { status: { name: 'No' } });
  assert.deepEqual(toPropertyValue('multi_select', 'Electrical, Accumulator'), {
    multi_select: [{ name: 'Electrical' }, { name: 'Accumulator' }],
  });
  assert.deepEqual(toPropertyValue('title', 'X'), { title: [{ type: 'text', text: { content: 'X' } }] });
  assert.equal(toPropertyValue('formula', 'x'), undefined);
});

test('toProperties reports missing and unwritable columns instead of failing', () => {
  const result = toProperties({ Name: 'A', 'PEFS Ready?': 'x', Nope: 1 }, { Name: 'title', 'PEFS Ready?': 'formula' });
  assert.deepEqual(Object.keys(result.properties), ['Name']);
  assert.deepEqual(result.missing, ['Nope']);
  assert.deepEqual(result.unwritable, ['PEFS Ready?']);
});

test('every preset row is tagged and uses only known PEFS columns', () => {
  const known = new Set(EXPECTED_COLUMNS.map((c) => c.name));
  for (const name of Object.keys(PRESETS)) {
    for (const row of presetRows(name, ctx)) {
      const final = finalizeRow(row, ctx, name);
      assert.ok(String(final['Notes (internal)']).startsWith(seedTag(ctx.batch)), `${name}: tag`);
      assert.equal(final.Season, 'REV12');
      for (const col of Object.keys(final)) assert.ok(known.has(col), `${name}: unknown column ${col}`);
    }
  }
});

test('arrivals preset rows are already ordered and not arrived', () => {
  for (const row of presetRows('arrivals', ctx)) {
    assert.equal(row['Exported?'], true);
    assert.equal(row['Arrived?'], 'No');
    assert.equal(row['Run ID'], `DEV-${ctx.batch}`);
  }
});

test('all preset combines every preset; unknown preset throws', () => {
  const total = Object.keys(PRESETS).reduce((n, k) => n + presetRows(k, ctx).length, 0);
  assert.equal(presetRows('all', ctx).length, total);
  assert.throws(() => presetRows('nope', ctx), /Unknown preset/);
});

test('dev guard refuses outside dev mode', () => {
  assert.throws(() => assertDevTarget('PEFS', 'BENBUYS_PURCHASING_DS_ID', 'abc'), /dev mode/);
});

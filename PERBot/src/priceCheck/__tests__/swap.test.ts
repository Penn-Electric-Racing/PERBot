import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionKind,
  decodeValue,
  money,
  PRICE_ACTIONS_BLOCK_ID,
  PRICE_RESULT_BLOCK_ID,
  PRICE_UNDO_ACTION_ID,
  replaceActions,
  type PriceSwapValue,
} from '../blocks.js';
import {
  appendLine,
  dropLastLine,
  handlePriceSwap,
  planSwap,
  readTextRuns,
  type PriceRow,
  type PriceSwapDeps,
  type RowPatch,
  type TextRun,
} from '../swap.js';

const ROW_ID = '39e560bc-c039-80aa-bbbb-0123456789ab';
const value = (over: Partial<PriceSwapValue> = {}): PriceSwapValue & { n: number } => ({ v: 1, r: ROW_ID, q: 10, o: 50, n: 0.68, s: 'DigiKey', ...over }) as any;
const row = (over: Partial<PriceRow> = {}): PriceRow => ({
  id: ROW_ID,
  unitCost: 50,
  quantity: 10,
  link: 'https://www.digikey.com/p/1',
  exported: false,
  deleted: false,
  notes: [],
  ...over,
});
const plain = (runs: TextRun[] | null | undefined) => (runs ?? []).map((r) => r.content).join('');

test('actionKind: use/keep/undo with optional index, nothing else', () => {
  assert.equal(actionKind('price_swap_use:0'), 'use');
  assert.equal(actionKind('price_swap_use:12'), 'use');
  assert.equal(actionKind('price_swap_keep'), 'keep');
  assert.equal(actionKind(PRICE_UNDO_ACTION_ID), 'undo');
  assert.equal(actionKind('price_swap_use_0'), null);
  assert.equal(actionKind('ops_task_done'), null);
});

test('decodeValue: accepts the contract, rejects malformed payloads', () => {
  const ok = { v: 1, r: ROW_ID, q: 10, o: 50, n: 0.68, s: 'DigiKey', l: 'https://mouser.com/x', ol: '' };
  assert.deepEqual(decodeValue(JSON.stringify(ok)), ok);
  assert.deepEqual(decodeValue(JSON.stringify({ v: 1, r: ROW_ID.replace(/-/g, ''), q: 1, o: 2 })), { v: 1, r: ROW_ID.replace(/-/g, ''), q: 1, o: 2 });
  for (const bad of [
    'not json',
    undefined,
    { ...ok, v: 2 },
    { ...ok, r: 'page-1' },
    { ...ok, q: -1 },
    { ...ok, o: 'fifty' },
    { ...ok, n: 0 },
    { ...ok, l: 'javascript:alert(1)' },
    { ...ok, ol: 'ftp://x' },
  ]) {
    assert.equal(decodeValue(typeof bad === 'object' ? JSON.stringify(bad) : bad), null, JSON.stringify(bad));
  }
});

test('money: matches price_check.py (2 decimals, up to 4 under a dollar)', () => {
  assert.equal(money(50), '50.00');
  assert.equal(money(1234.5), '1,234.50');
  assert.equal(money(0.68), '0.68');
  assert.equal(money(0.5), '0.50');
  assert.equal(money(0.0425), '0.0425');
  assert.equal(money(0.02), '0.02');
});

test('replaceActions: swaps the buttons in place, drops an earlier outcome, keeps the alert', () => {
  const alert = { type: 'section', block_id: 'alert', text: { type: 'mrkdwn', text: 'Price dropped' } };
  const footer = { type: 'context', block_id: 'footer', elements: [] };
  const buttons = { type: 'actions', block_id: PRICE_ACTIONS_BLOCK_ID, elements: [] };
  const outcome = { type: 'section', block_id: PRICE_RESULT_BLOCK_ID, text: { type: 'mrkdwn', text: 'old' } };
  const fresh = [{ type: 'section', block_id: PRICE_RESULT_BLOCK_ID, text: { type: 'mrkdwn', text: 'new' } }];
  assert.deepEqual(replaceActions([alert, buttons, footer], fresh), [alert, ...fresh, footer]);
  assert.deepEqual(replaceActions([alert, outcome, buttons, footer], fresh), [alert, ...fresh, footer]);
  assert.deepEqual(replaceActions([alert], fresh), [alert, ...fresh]);
});

test('planSwap use: writes only while the row still reads what the alert saw', () => {
  assert.deepEqual(planSwap('use', value(), row()), { kind: 'write', unitCost: 0.68 });
  assert.deepEqual(planSwap('use', value(), row({ unitCost: 0.68 })), { kind: 'already' });
  assert.match((planSwap('use', value(), row({ unitCost: 42 })) as any).reason, /now \$42\.00/);
  assert.match((planSwap('use', value(), row({ unitCost: null })) as any).reason, /now blank/);
  assert.match((planSwap('use', value(), row({ quantity: 12 })) as any).reason, /Quant\.\* changed .*now 12/);
  assert.match((planSwap('use', value(), row({ exported: true })) as any).reason, /already ordered/);
  assert.match((planSwap('use', value(), row({ deleted: true })) as any).reason, /deleted/);
});

test('planSwap: switching listings writes the link too; Undo puts the old one back (or clears it)', () => {
  const v = value({ s: 'Mouser', n: 0.55, l: 'https://www.mouser.com/p/2', ol: 'https://www.digikey.com/p/1' });
  assert.deepEqual(planSwap('use', v, row()), { kind: 'write', unitCost: 0.55, link: 'https://www.mouser.com/p/2' });
  // Price written but link not yet → still a write (finishes the job).
  assert.deepEqual(planSwap('use', v, row({ unitCost: 0.55 })), { kind: 'write', unitCost: 0.55, link: 'https://www.mouser.com/p/2' });
  assert.deepEqual(planSwap('use', v, row({ unitCost: 0.55, link: 'https://www.mouser.com/p/2/' })), { kind: 'already' });
  assert.deepEqual(planSwap('undo', v, row({ unitCost: 0.55, link: 'https://www.mouser.com/p/2' })), { kind: 'write', unitCost: 50, link: 'https://www.digikey.com/p/1' });
  assert.deepEqual(planSwap('undo', { ...v, ol: '' }, row({ unitCost: 0.55, link: 'https://www.mouser.com/p/2' })), { kind: 'write', unitCost: 50, link: null });
});

test('planSwap undo: only from the written price', () => {
  assert.deepEqual(planSwap('undo', value(), row({ unitCost: 0.68 })), { kind: 'write', unitCost: 50 });
  assert.deepEqual(planSwap('undo', value(), row({ unitCost: 50 })), { kind: 'already' });
  assert.equal(planSwap('undo', value(), row({ unitCost: 0.7 })).kind, 'refuse');
});

test('notes: append adds a line, dropLastLine removes exactly it and keeps formatting', () => {
  const bold = { bold: true, italic: false, strikethrough: false, underline: false, code: false, color: 'default' };
  const runs: TextRun[] = [
    { content: 'Sold in packs of ', link: null },
    { content: '10', link: null, annotations: bold },
  ];
  const added = appendLine(runs, 'PERBot price check: Unit cost $50.00 → $0.68 via Slack');
  assert.equal(plain(added), 'Sold in packs of 10\nPERBot price check: Unit cost $50.00 → $0.68 via Slack');
  assert.deepEqual(dropLastLine(added!, 'PERBot price check: Unit cost $50.00 → $0.68'), runs);
  assert.equal(plain(appendLine([], 'only line')), 'only line');
  assert.deepEqual(dropLastLine([{ content: 'PERBot price check: x', link: null }], 'PERBot price check:'), []);
  assert.equal(dropLastLine([{ content: 'edited after\nby hand', link: null }], 'PERBot price check:'), null);
  assert.equal(appendLine(Array.from({ length: 100 }, () => ({ content: 'x', link: null })), 'y'), null);
});

test('readTextRuns: plain text only (mentions/equations → null, so they are never rewritten)', () => {
  assert.deepEqual(readTextRuns({ rich_text: [{ type: 'text', text: { content: 'a', link: { url: 'https://x.y' } } }] }), [
    { content: 'a', link: 'https://x.y' },
  ]);
  assert.deepEqual(readTextRuns({ rich_text: [] }), []);
  assert.deepEqual(readTextRuns(undefined), []);
  assert.equal(readTextRuns({ rich_text: [{ type: 'mention', mention: {} }] }), null);
});

// ---------------------------------------------------------------- handler, Notion faked

function fakeNotion(start: PriceRow) {
  let current = { ...start };
  const writes: RowPatch[] = [];
  const deps: PriceSwapDeps = {
    fetchRow: async () => ({ ...current }),
    writeRow: async (_id, patch) => {
      writes.push(patch);
      current = { ...current, unitCost: patch.unitCost, ...(patch.link !== undefined ? { link: patch.link ?? '' } : {}), ...(patch.notes ? { notes: patch.notes } : {}) };
    },
    displayName: async () => 'Arjun Sharma',
    now: () => new Date('2026-10-17T16:31:00Z'),
  };
  return { deps, writes, get row() { return current; } };
}

const message = () => [
  { type: 'section', block_id: 'alert', text: { type: 'mrkdwn', text: 'Price dropped on TEST' } },
  { type: 'actions', block_id: PRICE_ACTIONS_BLOCK_ID, elements: [] },
];
const click = (actionId: string, v: unknown, existing: any[] | undefined = message()) => ({
  actionId,
  rawValue: JSON.stringify(v),
  clicker: 'U123',
  existing,
});

test('handlePriceSwap: Use writes, leaves an audit line, and offers Undo; Undo restores both', async () => {
  const notion = fakeNotion(row({ notes: [{ content: 'Sold in packs of 10', link: null }] }));
  const used = await handlePriceSwap(notion.deps, click('price_swap_use:0', value()));
  assert.equal(notion.row.unitCost, 0.68);
  assert.equal(plain(notion.row.notes), 'Sold in packs of 10\nPERBot price check: Unit cost $50.00 → $0.68 (DigiKey) via Slack, Arjun Sharma, 2026-10-17');
  assert.match(used.text ?? '', /<@U123> set Unit cost to \$0\.68 \(DigiKey\) · was \$50\.00 · 12:31 PM/);
  const undoButton = used.blocks!.find((b) => b.block_id === PRICE_ACTIONS_BLOCK_ID).elements[0];
  assert.equal(undoButton.action_id, PRICE_UNDO_ACTION_ID);
  assert.equal(used.blocks![0].block_id, 'alert');

  const undone = await handlePriceSwap(notion.deps, { ...click(PRICE_UNDO_ACTION_ID, null, used.blocks), rawValue: undoButton.value });
  assert.equal(notion.row.unitCost, 50);
  assert.equal(plain(notion.row.notes), 'Sold in packs of 10');
  assert.match(undone.text ?? '', /undid it: Unit cost is back to \$50\.00/);
  assert.ok(!undone.blocks!.some((b) => b.block_id === PRICE_ACTIONS_BLOCK_ID), 'no buttons after Undo');
});

test('handlePriceSwap: a second Use click reports, never writes again', async () => {
  const notion = fakeNotion(row());
  await handlePriceSwap(notion.deps, click('price_swap_use:0', value()));
  const again = await handlePriceSwap(notion.deps, click('price_swap_use:0', value()));
  assert.equal(notion.writes.length, 1);
  assert.match(again.text ?? '', /already \$0\.68/);
});

test('handlePriceSwap: a row edited since the alert is refused and left alone', async () => {
  const notion = fakeNotion(row({ unitCost: 45 }));
  const res = await handlePriceSwap(notion.deps, click('price_swap_use:0', value()));
  assert.equal(notion.writes.length, 0);
  assert.match(res.text ?? '', /⚠️ Unit cost is now \$45\.00/);
});

test('handlePriceSwap: Keep writes nothing; notes with mentions are left untouched', async () => {
  const kept = fakeNotion(row());
  const res = await handlePriceSwap(kept.deps, click('price_swap_keep', value({ n: undefined, s: undefined })));
  assert.equal(kept.writes.length, 0);
  assert.match(res.text ?? '', /kept \$50\.00/);

  const mentions = fakeNotion(row({ notes: null }));
  await handlePriceSwap(mentions.deps, click('price_swap_use:0', value()));
  assert.equal(mentions.writes[0].notes, undefined);
  assert.equal(mentions.row.unitCost, 0.68);
});

test('handlePriceSwap: bad value / expired Undo / no message blocks → ephemeral reply', async () => {
  const notion = fakeNotion(row());
  assert.match((await handlePriceSwap(notion.deps, { ...click('price_swap_use:0', null), rawValue: '{oops' })).whisper ?? '', /out of date/);
  const old = Math.floor(new Date('2026-10-15T00:00:00Z').getTime() / 1000);
  assert.match((await handlePriceSwap(notion.deps, click(PRICE_UNDO_ACTION_ID, value({ t: old })))).whisper ?? '', /Too late/);
  const noBlocks = await handlePriceSwap(notion.deps, { ...click('price_swap_use:0', value()), existing: undefined });
  assert.equal(noBlocks.blocks, undefined);
  assert.match(noBlocks.whisper ?? '', /set Unit cost to \$0\.68/);
  assert.equal(notion.writes.length, 1);
});

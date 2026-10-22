import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buttonsFor,
  coldDealBlocks,
  DEAL_ACTION_IDS,
  DEAL_COLD_ACTION_RE,
  DEAL_STAGE_ACTION_RE,
  dealBlocks,
  lossReasonForAction,
  replaceDealBlocks,
} from '../dealBlocks.js';
import { buildStaleDm } from '../jobs/staleDm.js';
import { LOSS_REASONS, PipelineRow } from '../types.js';

function deal(over: Partial<PipelineRow> = {}): PipelineRow {
  return {
    id: 'p1',
    url: 'https://notion.so/p1',
    company: 'Acme',
    stage: 'Contacted',
    wonKind: null,
    driUserIds: ['u1'],
    dealValue: null,
    received: null,
    lastContact: null,
    nextAction: null,
    nextActionDate: null,
    notes: '',
    createdTime: '2026-09-01T12:00:00.000Z',
    contactedAt: '2026-09-02T15:00:00.000Z',
    lossReason: null,
    bankSourceId: null,
    coldAskedAt: null,
    ...over,
  };
}

const value = { d: 'p1', u: 'U1' };
const ids = (els: any[]) => els.map((e) => e.action_id);

// --- loss reason picker ---------------------------------------------------------------

test('buttonsFor: a Lost deal with no reason gets one button per reason, round-tripping to the full label', () => {
  const els = buttonsFor(deal({ stage: 'Lost' }), value);
  assert.equal(els.length, LOSS_REASONS.length);
  assert.deepEqual(els.map((e) => lossReasonForAction(e.action_id)), [...LOSS_REASONS]);
  assert.ok(els.every((e) => e.text.text.length <= 75), 'Slack caps button text at 75 chars');
});

test('buttonsFor: a Lost deal with a reason, or a Won deal, gets no buttons', () => {
  assert.equal(buttonsFor(deal({ stage: 'Lost', lossReason: 'No response' }), value).length, 0);
  assert.equal(buttonsFor(deal({ stage: 'Won' }), value).length, 0);
});

test('lossReasonForAction: ignores ids that are not reason buttons', () => {
  assert.equal(lossReasonForAction('deal_loss_99'), null);
  assert.equal(lossReasonForAction(DEAL_ACTION_IDS.lost), null);
});

test('replaceDealBlocks: clicking Lost swaps the stage buttons for the reason picker', () => {
  const before = dealBlocks(deal(), 'U1');
  const after = replaceDealBlocks(before, deal({ stage: 'Lost' }), 'U1', '❌ Lost', 'Contacted');
  const actions = after.find((b) => b.type === 'actions');
  assert.ok(ids(actions.elements).every((id: string) => lossReasonForAction(id)));
});

// --- gone cold ---------------------------------------------------------------------

test('coldDealBlocks: four choices, each routed to an existing handler', () => {
  const [, actions] = coldDealBlocks(deal(), 'U1', 'Acme — contacted Sep 2');
  assert.equal(actions.elements.length, 4);
  for (const id of ids(actions.elements)) assert.ok(DEAL_COLD_ACTION_RE.test(id) || DEAL_STAGE_ACTION_RE.test(id), id);
});

test('buildStaleDm: a deal both overdue and cold shows once, under cold', () => {
  const both = deal({ id: 'both', nextActionDate: '2026-09-20' });
  const { blocks, coldShown } = buildStaleDm([both, deal({ id: 'late', nextActionDate: '2026-09-21' })], [both], 'U1');
  const sections = blocks.filter((b) => b.block_id?.startsWith('deal:')).map((b) => b.block_id);
  assert.deepEqual(sections, ['deal:late', 'deal:both']);
  assert.deepEqual(coldShown.map((d) => d.id), ['both']);
});

test('buildStaleDm: stays under Slack’s 50-block cap and stamps only the cold deals shown', () => {
  const overdue = Array.from({ length: 30 }, (_, i) => deal({ id: `o${i}`, nextActionDate: '2026-09-20' }));
  const cold = Array.from({ length: 20 }, (_, i) =>
    deal({ id: `c${i}`, contactedAt: `2026-08-${String(i + 1).padStart(2, '0')}T15:00:00.000Z` })
  );
  const { blocks, coldShown } = buildStaleDm(overdue, cold, 'U1');
  assert.ok(blocks.length <= 50, `${blocks.length} blocks`);
  assert.equal(coldShown.length, 8);
  assert.equal(coldShown[0].id, 'c0', 'oldest first');
});

test('buildStaleDm: nothing to say → no blocks', () => {
  assert.equal(buildStaleDm([], [], 'U1').blocks.length, 0);
});

test('buildStaleDm: the cold line says when it was contacted and how long ago', () => {
  const { text } = buildStaleDm([], [deal()], 'U1', new Date('2026-10-14T13:00:00.000Z'));
  assert.match(text, /contacted Sep 2 \(41 days ago\), no reply yet/);
});

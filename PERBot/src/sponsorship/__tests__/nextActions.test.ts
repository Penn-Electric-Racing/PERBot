import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finalizeDealBlocks, buttonsFor, dealBlocks, DEAL_ACTION_IDS } from '../dealBlocks.js';
import { buildStaleDm, splitStaleClaims } from '../jobs/staleDm.js';
import { backfillNextAction, isAutoNextAction, nextActionAfterTouch, nextActionForStage } from '../nextActions.js';
import { PipelineRow } from '../types.js';

function deal(over: Partial<PipelineRow> = {}): PipelineRow {
  return {
    id: 'p1',
    url: 'https://notion.so/p1',
    company: 'Acme',
    stage: 'Prospect',
    wonKind: null,
    driUserIds: ['u1'],
    dealValue: null,
    received: null,
    lastContact: null,
    nextAction: 'Send first outreach',
    nextActionDate: '2026-09-08',
    notes: '',
    createdTime: '2026-09-01T12:00:00.000Z',
    contactedAt: null,
    lossReason: null,
    bankSourceId: null,
    coldAskedAt: null,
    releaseAskedAt: null,
    ...over,
  };
}

const TODAY = '2026-10-22';

// --- stage moves replace PERBot's own next action ---------------------------------------

test('nextActionForStage: Contacted swaps "Send first outreach" for a follow-up in 7 days, keeping the ask', () => {
  const row = deal({ nextAction: 'Send first outreach — reduced-cost PCB fab' });
  assert.deepEqual(nextActionForStage(row, 'Contacted', TODAY), {
    action: 'Follow up if no reply — reduced-cost PCB fab',
    dateIso: '2026-10-29',
  });
});

test('nextActionForStage: In talks / Won / Lost clear it', () => {
  for (const stage of ['In talks', 'Won', 'Lost'] as const) {
    assert.deepEqual(nextActionForStage(deal(), stage, TODAY), { action: '', dateIso: null }, stage);
  }
});

test("nextActionForStage: a person's own next action is never touched", () => {
  const row = deal({ nextAction: 'Call Priya Tuesday about the PCB order' });
  assert.equal(isAutoNextAction(row.nextAction), false);
  assert.equal(nextActionForStage(row, 'Contacted', TODAY), null);
  assert.equal(nextActionForStage(row, 'Lost', TODAY), null);
});

test('nextActionAfterTouch: a follow-up on a Contacted deal pushes the next one a week out', () => {
  const row = deal({ stage: 'Contacted', nextAction: 'Follow up if no reply' });
  assert.deepEqual(nextActionAfterTouch(row, TODAY), { action: 'Follow up if no reply', dateIso: '2026-10-29' });
  assert.equal(nextActionAfterTouch(deal({ stage: 'In talks' }), TODAY), null);
});

// --- one-time cleanup -------------------------------------------------------------------

test('backfillNextAction: recent Contacted → follow-up due 7 days after the last touch (can be overdue)', () => {
  const row = deal({ stage: 'Contacted', contactedAt: '2026-10-05T14:00:00.000Z', lastContact: '2026-10-09' });
  assert.deepEqual(backfillNextAction(row, TODAY), { action: 'Follow up if no reply', dateIso: '2026-10-16' });
});

test('backfillNextAction: Contacted 30+ days ago is cleared (the gone-cold check owns it)', () => {
  const row = deal({ stage: 'Contacted', contactedAt: '2026-08-01T14:00:00.000Z' });
  assert.deepEqual(backfillNextAction(row, TODAY), { action: '', dateIso: null });
});

test('backfillNextAction: In talks is cleared; Prospect and already-fixed deals are skipped', () => {
  assert.deepEqual(backfillNextAction(deal({ stage: 'In talks' }), TODAY), { action: '', dateIso: null });
  assert.equal(backfillNextAction(deal(), TODAY), null);
  assert.equal(backfillNextAction(deal({ stage: 'Contacted', nextAction: 'Follow up if no reply' }), TODAY), null);
});

// --- stale claims -----------------------------------------------------------------------

test('splitStaleClaims: never asked → ask; asked 7+ days ago → release; asked this week → wait', () => {
  const { ask, release } = splitStaleClaims(
    [
      deal({ id: 'new' }),
      deal({ id: 'due', releaseAskedAt: '2026-10-15' }),
      deal({ id: 'recent', releaseAskedAt: '2026-10-20' }),
      deal({ id: 'moved', stage: 'Contacted', releaseAskedAt: '2026-10-01' }),
    ],
    TODAY
  );
  assert.deepEqual(ask.map((d) => d.id), ['new']);
  assert.deepEqual(release.map((d) => d.id), ['due']);
});

test('splitStaleClaims: an ownerless claim is released at 21 days, with nobody to ask', () => {
  const { ask, release } = splitStaleClaims(
    [deal({ id: 'old', driUserIds: [], createdTime: '2026-09-30T12:00:00.000Z' }), deal({ id: 'young', driUserIds: [], createdTime: '2026-10-05T12:00:00.000Z' })],
    TODAY
  );
  assert.deepEqual(release.map((d) => d.id), ['old']);
  assert.equal(ask.length, 0);
});

test('buildStaleDm: a claim shows once, under claims, with Sent it / Release it, and releases get a heads-up', () => {
  const claim = deal({ id: 'c1' });
  const { blocks, claimsShown, text } = buildStaleDm(
    { overdue: [claim], cold: [], claims: [claim], released: [deal({ id: 'r1', company: 'Timken' })] },
    'U1',
    new Date('2026-10-22T13:00:00.000Z')
  );
  assert.equal(blocks.filter((b) => b.block_id === 'deal:c1').length, 1);
  assert.deepEqual(claimsShown.map((d) => d.id), ['c1']);
  const actions = blocks.find((b) => b.block_id === 'deal_actions:c1');
  assert.deepEqual(actions.elements.map((e: any) => e.action_id), [DEAL_ACTION_IDS.contacted, DEAL_ACTION_IDS.release]);
  assert.match(text, /claimed Sep 1 \(51 days ago\), not contacted yet/);
  assert.match(text, /Released back to the Bank.*Timken/);
  assert.ok(blocks.length <= 50);
});

test('buildStaleDm: all four sections full stays under the 50-block cap', () => {
  const many = (prefix: string, n: number, over: Partial<PipelineRow> = {}) => Array.from({ length: n }, (_, i) => deal({ id: `${prefix}${i}`, ...over }));
  const { blocks } = buildStaleDm(
    { overdue: many('o', 30), cold: many('k', 30, { stage: 'Contacted' }), claims: many('c', 30), released: many('r', 3) },
    'U1'
  );
  assert.ok(blocks.length <= 50, `${blocks.length} blocks`);
});

// --- buttons ----------------------------------------------------------------------------

test('buttonsFor: Contacted deals get a one-tap Followed up', () => {
  const ids = buttonsFor(deal({ stage: 'Contacted' }), { d: 'p1', u: 'U1' }).map((b) => b.action_id);
  assert.ok(ids.includes(DEAL_ACTION_IDS.followedUp));
  assert.ok(!buttonsFor(deal(), { d: 'p1', u: 'U1' }).some((b) => b.action_id === DEAL_ACTION_IDS.followedUp));
});

test('finalizeDealBlocks: keeps the line, adds the note, drops the buttons', () => {
  const out = finalizeDealBlocks(dealBlocks(deal(), 'U1'), 'p1', '🔓 Released');
  assert.equal(out.length, 1);
  assert.match(out[0].text.text, /Acme.*\n_🔓 Released_/s);
});

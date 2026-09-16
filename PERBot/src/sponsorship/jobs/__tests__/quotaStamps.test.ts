import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditWindow, bulkStampInstants, computeQuotaResults } from '../quotaAudit.js';
import { contactedStampFor } from '../stageSync.js';
import type { PipelineRow, QuotaRosterMember } from '../../types.js';

const NOW = '2026-09-12T17:22:03.688Z';

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
    createdTime: '2026-09-11T12:00:00.000Z',
    contactedAt: null,
    ...over,
  };
}

// --- stage sync: what date goes on a deal it has never stamped -----------------------

test('contactedStampFor: a deal that moved this week is dated now', () => {
  assert.equal(contactedStampFor(deal(), NOW, false), NOW);
});

test('contactedStampFor: a deal older than the sync is dated from the deal, not now', () => {
  // The 2026-09-12 sweep: sitting at Contacted since July, no Last contact recorded.
  const old = deal({ createdTime: '2026-07-23T10:00:00.000Z' });
  assert.equal(contactedStampFor(old, NOW, false), '2026-07-23T10:00:00.000Z');
});

test('contactedStampFor: an old deal contacted for real uses the recorded Last contact', () => {
  const old = deal({ createdTime: '2026-07-23T10:00:00.000Z', lastContact: '2026-09-12' });
  assert.equal(contactedStampFor(old, NOW, false), '2026-09-12');
});

test('contactedStampFor: already stamped, or still Prospect, is left alone', () => {
  assert.equal(contactedStampFor(deal({ contactedAt: '2026-09-01T00:00:00Z' }), NOW, false), null);
  assert.equal(contactedStampFor(deal({ stage: 'Prospect' }), NOW, false), null);
});

test('contactedStampFor: backfill still dates every unstamped deal from creation', () => {
  assert.equal(contactedStampFor(deal(), NOW, true), '2026-09-11T12:00:00.000Z');
});

// --- quota audit: one bulk write is not N contacts -----------------------------------

const WEEK = auditWindow('2026-09-19'); // Sat Sep 12 10:00 ET → Sat Sep 19 10:00 ET

test('bulkStampInstants: flags an instant shared by three untouched deals', () => {
  const swept = ['a', 'b', 'c'].map((id) => deal({ id, contactedAt: '2026-09-12T17:22:00.000Z' }));
  const real = deal({ id: 'd', contactedAt: '2026-09-14T14:10:00.000Z', lastContact: '2026-09-14' });
  assert.deepEqual([...bulkStampInstants([...swept, real], WEEK)], ['2026-09-12T17:22:00.000Z']);
});

test('bulkStampInstants: two deals in one minute is plausible outreach, not a sweep', () => {
  const pair = ['a', 'b'].map((id) => deal({ id, contactedAt: '2026-09-14T14:10:00.000Z' }));
  assert.equal(bulkStampInstants(pair, WEEK).size, 0);
});

test('bulkStampInstants: three /sponsor stage calls in one minute still count', () => {
  // setStage stamps Last contact as it moves the deal — each row carries its own record.
  const burst = ['a', 'b', 'c'].map((id) =>
    deal({ id, contactedAt: '2026-09-14T14:10:00.000Z', lastContact: '2026-09-14' })
  );
  assert.equal(bulkStampInstants(burst, WEEK).size, 0);
});

test('computeQuotaResults: a swept batch does not count toward quota', () => {
  const window = auditWindow('2026-09-19'); // Sat Sep 12 10:00 ET → Sat Sep 19 10:00 ET
  const members: QuotaRosterMember[] = [{ name: 'Katherine Shen', notionUserId: 'u1' }];
  const sweep = ['s1', 's2', 's3', 's4'].map((id) =>
    deal({ id, contactedAt: '2026-09-12T17:22:00.000Z', createdTime: '2026-07-23T10:00:00.000Z' })
  );
  const real = ['r1', 'r2', 'r3'].map((id, i) =>
    deal({ id, contactedAt: `2026-09-14T14:1${i}:00.000Z`, lastContact: '2026-09-14' })
  );
  const [result] = computeQuotaResults(members, [...sweep, ...real], window, 3);
  assert.equal(result.deals.length, 3, 'only the three real contacts count');
  assert.ok(result.met);
});

test('computeQuotaResults: contacts outside the window never count', () => {
  const window = auditWindow('2026-09-19');
  const members: QuotaRosterMember[] = [{ name: 'Arjun Sharma', notionUserId: 'u1' }];
  const before = deal({ id: 'b1', contactedAt: '2026-09-11T12:00:00.000Z' });
  const inside = deal({ id: 'i1', contactedAt: '2026-09-12T19:31:00.000Z' });
  const [result] = computeQuotaResults(members, [before, inside], window, 3);
  assert.deepEqual(result.deals.map((d) => d.id), ['i1']);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditWindow, bulkStampInstants, computeQuotaResults } from '../quotaAudit.js';
import type { PipelineRow, QuotaRosterMember } from '../../types.js';

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

test('computeQuotaResults: a Notion-side move earns nothing without the Slack command', () => {
  // Dragging the card to Contacted in Notion leaves `Contacted at` empty — nothing stamps it
  // now that the hourly stage sync is gone, so it cannot count. Running
  // `/sponsor stage <company> Contacted` afterwards stamps it and it counts.
  const window = auditWindow('2026-09-19');
  const members: QuotaRosterMember[] = [{ name: 'Katherine Shen', notionUserId: 'u1' }];
  const moved = deal({ id: 'm1', stage: 'Contacted', contactedAt: null, lastContact: '2026-09-15' });
  assert.equal(computeQuotaResults(members, [moved], window, 3)[0].deals.length, 0);

  const logged = { ...moved, contactedAt: '2026-09-15T18:00:00.000Z' };
  assert.equal(computeQuotaResults(members, [logged], window, 3)[0].deals.length, 1);
});

test('computeQuotaResults: claiming a lead earns nothing', () => {
  // /sponsor claim creates a Prospect deal and stamps no Contacted at.
  const window = auditWindow('2026-09-19');
  const members: QuotaRosterMember[] = [{ name: 'Arjun Sharma', notionUserId: 'u1' }];
  const claimed = deal({ id: 'c1', stage: 'Prospect', contactedAt: null });
  assert.equal(computeQuotaResults(members, [claimed], window, 3)[0].deals.length, 0);
});

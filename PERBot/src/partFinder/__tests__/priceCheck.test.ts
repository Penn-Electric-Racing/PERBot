import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queueKey, queuePriceCheck, type PriceCheckDeps } from '../priceCheck.js';

const ON = { enabled: true, dispatchRepo: 'owner/repo', dispatchToken: 'ghp_x' };

function harness(opts: { claimed?: boolean; claimError?: string; status?: number; settings?: PriceCheckDeps['settings'] } = {}) {
  const claims: [string, string][] = [];
  const requests: { url: string; init: any }[] = [];
  const deps: PriceCheckDeps = {
    settings: opts.settings ?? ON,
    claim: async (key, job) => {
      claims.push([key, job]);
      if (opts.claimError) throw new Error(opts.claimError);
      return !opts.claimed;
    },
    fetchImpl: (async (url: string, init: any) => {
      requests.push({ url, init });
      return { status: opts.status ?? 204 } as Response;
    }) as any,
  };
  return { deps, claims, requests };
}

test('queuePriceCheck: claims the queue key, then dispatches to the checker repo', async () => {
  const h = harness();
  assert.equal(await queuePriceCheck('page-1', h.deps), 'queued');
  assert.deepEqual(h.claims, [['price-check-queue page-1', 'price-check-queue']]);
  assert.equal(h.requests.length, 1);
  const { url, init } = h.requests[0]!;
  assert.equal(url, 'https://api.github.com/repos/owner/repo/dispatches');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer ghp_x');
  assert.deepEqual(JSON.parse(init.body), { event_type: 'price-check', client_payload: { page_id: 'page-1' } });
});

test('queuePriceCheck: off unless enabled', async () => {
  const h = harness({ settings: { ...ON, enabled: false } });
  assert.equal(await queuePriceCheck('page-1', h.deps), 'off');
  assert.equal(h.claims.length + h.requests.length, 0);
});

test('queuePriceCheck: an already queued row is not dispatched again', async () => {
  const h = harness({ claimed: true });
  assert.equal(await queuePriceCheck('page-1', h.deps), 'already-queued');
  assert.equal(h.requests.length, 0);
});

test('queuePriceCheck: no token still queues (the schedule picks it up)', async () => {
  const h = harness({ settings: { ...ON, dispatchToken: '' } });
  assert.equal(await queuePriceCheck('page-1', h.deps), 'queued');
  assert.equal(h.requests.length, 0);
});

test('queuePriceCheck: a rejected dispatch is logged, the row stays queued', async () => {
  const h = harness({ status: 404 });
  assert.equal(await queuePriceCheck('page-1', h.deps), 'queued');
});

test('queuePriceCheck: never throws', async () => {
  const h = harness({ claimError: 'Notion is down' });
  assert.equal(await queuePriceCheck('page-1', h.deps), 'failed');
  const broken = harness();
  broken.deps.fetchImpl = (async () => { throw new Error('network'); }) as any;
  assert.equal(await queuePriceCheck('page-1', broken.deps), 'failed');
});

test('queueKey matches the checker (price_check.py QUEUE_JOB)', () => {
  assert.equal(queueKey('abc'), 'price-check-queue abc');
});

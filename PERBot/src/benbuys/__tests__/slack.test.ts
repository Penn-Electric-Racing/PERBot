import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrepCache } from '../cache.js';
import { chunkFenced, handleDone, handlePrep, parseBenbuys, parseMoney, type BenbuysDeps } from '../slack.js';
import { buildPrep } from '../prep.js';
import { row, testAdapter } from './helpers.js';

test('parseBenbuys: prep defaults to digikey; vendor may be given', () => {
  assert.deepEqual(parseBenbuys('prep'), { kind: 'prep', vendor: 'digikey' });
  assert.deepEqual(parseBenbuys('  PREP  DigiKey '), { kind: 'prep', vendor: 'digikey' });
  assert.deepEqual(parseBenbuys('prep mcmaster'), { kind: 'prep', vendor: 'mcmaster' });
  assert.deepEqual(parseBenbuys(''), { kind: 'help' });
  assert.deepEqual(parseBenbuys('help'), { kind: 'help' });
});

test('parseBenbuys: done takes req# + total, optional vendor and --no-send anywhere', () => {
  assert.deepEqual(parseBenbuys('done 4321745 402.02'), { kind: 'done', vendor: 'digikey', requisition: '4321745', total: 402.02, dryRun: false });
  assert.deepEqual(parseBenbuys('done 4321745 $1,204.50 --no-send'), { kind: 'done', vendor: 'digikey', requisition: '4321745', total: 1204.5, dryRun: true });
  assert.deepEqual(parseBenbuys('done digikey 4321745 402'), { kind: 'done', vendor: 'digikey', requisition: '4321745', total: 402, dryRun: false });
  assert.deepEqual(parseBenbuys('done --dry-run 4321745 402'), { kind: 'done', vendor: 'digikey', requisition: '4321745', total: 402, dryRun: true });
});

test('parseBenbuys: done guards — 6–8 digit req#, positive decimal total', () => {
  assert.match(parseBenbuys('done 12345 402').error ?? '', /6–8 digits/);
  assert.match(parseBenbuys('done 123456789 402').error ?? '', /6–8 digits/);
  assert.match(parseBenbuys('done 4321745').error ?? '', /positive dollar amount/);
  assert.match(parseBenbuys('done 4321745 0').error ?? '', /positive dollar amount/);
  assert.match(parseBenbuys('done 4321745 -5').error ?? '', /positive dollar amount/);
  assert.match(parseBenbuys('done 4321745 402.123').error ?? '', /positive dollar amount/);
});

test('parseMoney', () => {
  assert.equal(parseMoney('$1,234.5'), 1234.5);
  assert.equal(parseMoney('402'), 402);
  assert.equal(parseMoney('abc'), null);
});

test('chunkFenced: splits long carts on line boundaries, each part fenced', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `${i}, PART-${i}-ND, REF`);
  const chunks = chunkFenced(lines.join('\n'), 200);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.startsWith('```\n') && c.endsWith('\n```'));
    assert.ok(c.length <= 200 + 8);
  }
  assert.equal(chunks.map((c) => c.slice(4, -4)).join('\n'), lines.join('\n'));
});

test('PrepCache: keyed by user + vendor, expires after the TTL', () => {
  let now = 1_000;
  const cache = new PrepCache(24 * 3600 * 1000, () => now);
  const prep = buildPrep(testAdapter, [row({ partNumber: 'A-ND' })], []);
  cache.set('U1', 'digikey', prep);
  assert.equal(cache.get('U1', 'digikey')?.prep, prep);
  assert.equal(cache.get('U2', 'digikey'), null);
  assert.equal(cache.get('U1', 'mcmaster'), null);
  now += 24 * 3600 * 1000 + 1;
  assert.equal(cache.get('U1', 'digikey'), null);
});

function fakeDeps(opts: { runIdExists?: boolean; failIds?: string[]; mailer?: 'ok' | 'fail' | null }) {
  const sent: any[] = [];
  const written: { ids: string[]; runId: string }[] = [];
  const deps: BenbuysDeps = {
    cache: new PrepCache(),
    notion: {
      runIdExists: async () => Boolean(opts.runIdExists),
      markOrdered: async (ids: string[], runId: string) => {
        written.push({ ids, runId });
        const failed = (opts.failIds ?? []).map((id) => ({ id, error: 'boom' }));
        return { updated: ids.filter((id) => !(opts.failIds ?? []).includes(id)), failed };
      },
    } as any,
    mailer:
      opts.mailer === null
        ? null
        : {
            name: 'fake',
            send: async (email: any) => {
              if (opts.mailer === 'fail') throw new Error('smtp down');
              sent.push(email);
              return { id: 'm1' };
            },
          },
  };
  return { deps, sent, written };
}

function replies() {
  const out: string[] = [];
  const respond: any = async (msg: any) => {
    out.push(msg.text);
  };
  return { out, respond };
}

const DONE = { kind: 'done' as const, vendor: 'digikey', requisition: '4321745', total: 402.02, dryRun: false };

test('handleDone: refuses non-operators, then missing prep, then duplicate Run ID — nothing sent', async () => {
  const { deps, sent, written } = fakeDeps({ runIdExists: true, mailer: 'ok' });
  let r = replies();
  await handleDone(deps, testAdapter, 'U_STRANGER', DONE, r.respond);
  assert.match(r.out[0]!, /Only the DigiKey operator/);

  r = replies();
  await handleDone(deps, testAdapter, 'U_OPERATOR', DONE, r.respond);
  assert.match(r.out[0]!, /run prep first/);

  deps.cache.set('U_OPERATOR', 'digikey', buildPrep(testAdapter, [row({ partNumber: 'A-ND' })], []));
  r = replies();
  await handleDone(deps, testAdapter, 'U_OPERATOR', DONE, r.respond);
  assert.match(r.out[0]!, /already recorded in Notion \(Run ID `BENBUYS-4321745`\)/);
  assert.equal(sent.length, 0);
  assert.equal(written.length, 0);
});

test('handleDone --no-send: previews the email and rows, writes nothing, keeps the cache', async () => {
  const { deps, sent, written } = fakeDeps({ mailer: null });
  deps.cache.set('U_OPERATOR', 'digikey', buildPrep(testAdapter, [row({ partNumber: 'A-ND', quantity: 2, unitCost: 300 })], []));
  const r = replies();
  await handleDone(deps, testAdapter, 'U_OPERATOR', { ...DONE, total: 600, dryRun: true }, r.respond);
  assert.match(r.out[0]!, /\*Dry run\*.*\$600\.00 · 1 lines · APPROVAL REQUIRED/);
  assert.match(r.out[0]!, /Subject: \[APPROVAL REQUIRED\] PER Requisition 4321745/);
  assert.match(r.out[0]!, /Would mark 1 rows ordered \(Run ID `BENBUYS-4321745`\)/);
  assert.equal(sent.length, 0);
  assert.equal(written.length, 0);
  assert.ok(deps.cache.get('U_OPERATOR', 'digikey'));
});

test('handleDone: no mailer configured → refuses before writing', async () => {
  const { deps, written } = fakeDeps({ mailer: null });
  deps.cache.set('U_OPERATOR', 'digikey', buildPrep(testAdapter, [row({ partNumber: 'A-ND' })], []));
  const r = replies();
  await handleDone(deps, testAdapter, 'U_OPERATOR', DONE, r.respond);
  assert.match(r.out[0]!, /isn’t configured/);
  assert.equal(written.length, 0);
});

test('handleDone: email failure → Notion untouched, cache kept for a retry', async () => {
  const { deps, written } = fakeDeps({ mailer: 'fail' });
  deps.cache.set('U_OPERATOR', 'digikey', buildPrep(testAdapter, [row({ partNumber: 'A-ND' })], []));
  const r = replies();
  await handleDone(deps, testAdapter, 'U_OPERATOR', DONE, r.respond);
  assert.match(r.out[0]!, /Couldn’t send the requisition email \(smtp down\)\. Notion was NOT updated/);
  assert.equal(written.length, 0);
  assert.ok(deps.cache.get('U_OPERATOR', 'digikey'));
});

test('handleDone: happy path — email, then write-back to exactly the cached rows, then cache cleared', async () => {
  const { deps, sent, written } = fakeDeps({ mailer: 'ok' });
  const rows = [row({ id: 'p1', partNumber: 'A-ND' }), row({ id: 'p2', partNumber: 'a-nd' }), row({ id: 'p3', partNumber: 'B-ND' })];
  deps.cache.set('U_OPERATOR', 'digikey', buildPrep(testAdapter, rows, []));
  const r = replies();
  await handleDone(deps, testAdapter, 'U_OPERATOR', DONE, r.respond);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, '[NO APPROVAL REQUIRED] PER Requisition 4321745');
  assert.match(sent[0].body, /\(2 line items\)/); // 3 rows → 2 aggregated lines, as BEN counts them
  assert.deepEqual(written, [{ ids: ['p1', 'p2', 'p3'], runId: 'BENBUYS-4321745' }]);
  assert.match(r.out[0]!, /✅ Requisition 4321745 · \$402\.02 · 2 lines · no approval required\./);
  assert.match(r.out[0]!, /Notion: 3 rows marked ordered/);
  assert.equal(deps.cache.get('U_OPERATOR', 'digikey'), null);
});

test('handleDone: partial write-back failure is reported and the cache is kept', async () => {
  const { deps, written } = fakeDeps({ mailer: 'ok', failIds: ['p2'] });
  const rows = [row({ id: 'p1', partNumber: 'A-ND' }), row({ id: 'p2', partNumber: 'B-ND', name: 'Second part' })];
  deps.cache.set('U_OPERATOR', 'digikey', buildPrep(testAdapter, rows, []));
  const r = replies();
  await handleDone(deps, testAdapter, 'U_OPERATOR', DONE, r.respond);
  assert.equal(written.length, 1);
  assert.match(r.out[0]!, /Notion: 1 rows marked ordered/);
  assert.match(r.out[0]!, /⚠️ 1 rows failed to update.*\n• <https:\/\/notion\.so\/page-\d+\|Second part> — boom/);
  assert.ok(deps.cache.get('U_OPERATOR', 'digikey'));
});

test('handlePrep: caches the result and warns when a previous prep was never closed with done', async () => {
  const ready = [row({ partNumber: 'A-ND', quantity: 2, unitCost: 1.5 }), row({ partNumber: 'B-ND' })];
  const deps: BenbuysDeps = { cache: new PrepCache(), mailer: null, notion: { selectRows: async () => ({ ready, notReady: [] }) } as any };
  let r = replies();
  await handlePrep(deps, testAdapter, 'U_OPERATOR', r.respond);
  assert.equal(r.out.length, 1);
  assert.doesNotMatch(r.out[0]!, /never ran/);
  assert.match(r.out[0]!, /\*DigiKey order prep\*/);
  assert.match(r.out[0]!, /2, A-ND, A-ND\n1, B-ND, B-ND/); // 6-char "PART n" notes fall back to the part number
  assert.equal(deps.cache.get('U_OPERATOR', 'digikey')?.prep.rows.length, 2);

  // Second prep without a done in between → double-order warning up top.
  r = replies();
  await handlePrep(deps, testAdapter, 'U_OPERATOR', r.respond);
  assert.match(r.out[0]!, /^⚠️ You prepped 2 DigiKey lines \dm ago and never ran `\/benbuys done`/);

  // Nothing to order → no cache entry, so a later prep won't warn.
  deps.notion = { selectRows: async () => ({ ready: [], notReady: [] }) } as any;
  r = replies();
  await handlePrep(deps, testAdapter, 'U_OPERATOR', r.respond);
  assert.match(r.out[0]!, /nothing to order/);
  assert.equal(deps.cache.get('U_OPERATOR', 'digikey'), null);
});

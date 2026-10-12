import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FindResult } from '../finder.js';
import { OpenAiCompatLlm, Pacer, parseJsonReply } from '../llm.js';
import { buildProperties, COLUMNS, draftRow, type RowContext } from '../notion.js';
import { Scorer } from '../rank.js';
import { handleAdd, money, optionText, parseParts, resultsMessage, SearchCache } from '../slack.js';
import { candidate } from './helpers.js';

// --- /parts parsing -------------------------------------------------------------------------------

test('parseParts: part words, quantity forms, cheapest, help', () => {
  assert.deepEqual(parseParts('LM7805 voltage regulator'), { kind: 'find', part: 'LM7805 voltage regulator', qty: 1, mode: 'best' });
  assert.equal((parseParts('LM7805 -q 50') as any).qty, 50);
  assert.equal((parseParts('LM7805 --qty 1,000') as any).qty, 1000);
  assert.equal((parseParts('qty:25 LM7805') as any).qty, 25);
  assert.equal((parseParts('LM7805 x10') as any).qty, 10);
  assert.deepEqual(parseParts('LM7805 --cheapest -q 5'), { kind: 'find', part: 'LM7805', qty: 5, mode: 'cheapest' });
  assert.equal(parseParts('').kind, 'help');
  assert.equal(parseParts('help').kind, 'help');
  assert.equal(parseParts('-q 5').kind, 'help'); // no part
});

test('parseParts: words starting with x are not quantities; bad quantities are errors', () => {
  assert.deepEqual(parseParts('xilinx fpga'), { kind: 'find', part: 'xilinx fpga', qty: 1, mode: 'best' });
  assert.match((parseParts('LM7805 -q many') as any).error, /whole number/);
  assert.match((parseParts('LM7805 -q') as any).error, /got "nothing"/);
  assert.match((parseParts('LM7805 -q 0') as any).error, /whole number/);
});

// --- formatting -----------------------------------------------------------------------------------

function result(cands = [candidate(0, 0.89, 50, { productName: 'LM7805 <TO-220> | 1.5A' }), candidate(1, null)]): FindResult {
  const s = new Scorer();
  s.scoreAll(cands, 'LM7805', 50);
  return { part: 'LM7805', query: 'LM7805 price', qty: 50, source: 'serper', llm: 'groq/x', top: s.pickTop(cands, 5), all: cands, stats: { candidates: 2, fetched: 2, priced: 1 } };
}

test('money: dollars for USD, 4 places under $1, code otherwise', () => {
  assert.equal(money(31, 'USD'), '$31.00');
  assert.equal(money(0.0425, null), '$0.0425');
  assert.equal(money(1234.5, 'EUR'), '1,234.50 EUR');
  assert.equal(money(null, 'USD'), 'n/a');
});

test('optionText: total, unit price, stock, shipping, escaped link text', () => {
  const t = optionText(result().top[0]!, 0);
  assert.match(t, /^\*1\. <https:\/\/site0\.com\/p\/0\|LM7805 &lt;TO-220&gt; \/ 1\.5A>\*/);
  assert.match(t, /\*\$44\.50\* total · 50 units @ \$0\.89\/unit · site0/);
  assert.match(t, /in stock · ships 2 days, free shipping/);
  assert.match(t, /_Score 1\.02_/);
});

test('resultsMessage: buttons only on priced options, ids/values point into the cache', () => {
  const msg: any = resultsMessage(result(), 'abc123', 'best');
  assert.equal(msg.response_type, 'ephemeral');
  const sections = msg.blocks.filter((b: any) => b.type === 'section').slice(1);
  assert.equal(sections.length, 2);
  assert.deepEqual(
    { id: sections[0].accessory.action_id, value: sections[0].accessory.value, style: sections[0].accessory.style },
    { id: 'parts_add_0', value: 'abc123:0', style: 'primary' }
  );
  assert.equal(sections[1].accessory, undefined); // no price → nothing to add
  assert.match(msg.blocks.at(-1).elements[0].text, /check the listing before ordering/);
});

test('resultsMessage: nothing found', () => {
  const msg: any = resultsMessage(result([]), 'x', 'best');
  assert.match(msg.text, /No listings found/);
});

// --- Notion row -----------------------------------------------------------------------------------

const ctx: RowContext = { part: 'LM7805 regulator', season: 'REV12', pointOfContactNotionId: 'notion-user-1', addedBy: 'Ada Park', today: new Date('2026-10-12T12:00:00Z') };
const fullSchema: Record<string, string> = {
  Name: 'title', ...Object.fromEntries(Object.values(COLUMNS).map(([name, type]) => [name, type])),
};

test('draftRow: single units use the (tier) unit price; seller catalog number wins', () => {
  const c = candidate(0, 0.89, 50, { partNumber: '296-13996-5-ND', priceBreaks: [{ minQty: 10, price: 0.62 }], url: 'https://www.digikey.com/p/1' });
  const d = draftRow(c, ctx);
  assert.equal(d.quantity, 50);
  assert.equal(d.unitCost, 0.62);
  assert.equal(d.partNumber, '296-13996-5-ND');
  assert.equal(d.paymentMethod, 'BenBuys');
  assert.match(d.notes, /Added from \/parts "LM7805 regulator" by Ada Park on 2026-10-12\./);
});

test('draftRow: pack listings are ordered in packs at the pack price', () => {
  const d = draftRow(candidate(0, 5.9, 25, { packSize: 10, url: 'https://amazon.com/dp/1' }), ctx);
  assert.equal(d.quantity, 3);
  assert.equal(d.unitCost, 5.9);
  assert.equal(d.partNumber, 'LM7805'); // no catalog number found → the typed part number
  assert.equal(d.paymentMethod, null); // not a BenBuys vendor: the requester picks
  assert.match(d.notes, /Sold in packs of 10: 3 pack\(s\) = 30 units for 25 needed\./);
});

test('buildProperties: writes every known column with the right shape', () => {
  const draft = draftRow(candidate(0, 0.89, 2, { url: 'https://www.mcmaster.com/1' }), ctx);
  const { properties, skipped } = buildProperties(draft, ctx, fullSchema);
  assert.deepEqual(skipped, []);
  assert.equal(properties['Name'].title[0].text.content, 'LM7805 voltage regulator');
  assert.deepEqual(properties['Quant.'], { number: 2 });
  assert.deepEqual(properties['Season'], { select: { name: 'REV12' } });
  assert.deepEqual(properties['Point of contact'], { people: [{ id: 'notion-user-1' }] });
  assert.deepEqual(properties['Payment Method'], { select: { name: 'BenBuys' } });
  assert.equal(properties['Link to product webpage'].url, 'https://www.mcmaster.com/1');
});

test('buildProperties: missing or retyped columns are skipped, not sent', () => {
  const schema = { ...fullSchema, Vendor: 'select' };
  delete (schema as any)['Notes (internal)'];
  const { properties, skipped } = buildProperties(draftRow(candidate(0, 1), ctx), { ...ctx, pointOfContactNotionId: null }, schema);
  assert.deepEqual(skipped.sort(), ['Notes (internal)', 'Vendor']);
  assert.equal(properties['Vendor'], undefined);
  assert.equal(properties['Point of contact'], undefined); // unknown person: left blank, not "skipped"
});

// --- button clicks --------------------------------------------------------------------------------

function addHarness(userId = 'U1') {
  const cache = new SearchCache();
  const searchId = cache.put(userId, result());
  const replies: any[] = [];
  const created: any[] = [];
  const notion: any = {
    listUsers: async () => [{ id: 'notion-user-1', name: 'Ada Park', email: 'ada@upenn.edu' }],
    addCandidate: async (c: any, rowCtx: any) => { created.push({ c, rowCtx }); return { id: 'p1', url: 'https://notion.so/p1', skipped: [], paymentMethod: null }; },
  };
  const client: any = { users: { info: async () => ({ user: { profile: { email: 'ada@upenn.edu', real_name: 'Ada Park' } } }) } };
  const respond = (async (m: any) => { replies.push(m); }) as any;
  return { deps: { llm: null, notion, cache }, searchId, replies, created, client, respond };
}

test('handleAdd: creates the row with the clicker as point of contact, once', async () => {
  const h = addHarness();
  await handleAdd(h.deps, `${h.searchId}:0`, 'U1', h.client, h.respond);
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].rowCtx.pointOfContactNotionId, 'notion-user-1');
  assert.equal(h.created[0].rowCtx.addedBy, 'Ada Park');
  assert.match(h.replies[0].text, /✅ Added option 1 to Purchasing: <https:\/\/notion\.so\/p1\|/);
  assert.match(h.replies[0].text, /Fill in Subsystem, Payment Method in Notion/);

  await handleAdd(h.deps, `${h.searchId}:0`, 'U1', h.client, h.respond);
  assert.equal(h.created.length, 1);
  assert.match(h.replies[1].text, /Already added/);
});

test('handleAdd: other users and expired searches are refused', async () => {
  const h = addHarness();
  await handleAdd(h.deps, `${h.searchId}:0`, 'U2', h.client, h.respond);
  await handleAdd(h.deps, 'nope:0', 'U1', h.client, h.respond);
  assert.equal(h.created.length, 0);
  assert.match(h.replies[0].text, /Only the person who ran this search/);
  assert.match(h.replies[1].text, /expired/);
});

test('handleAdd: a Notion failure is reported and the option can be retried', async () => {
  const h = addHarness();
  const ok = h.deps.notion.addCandidate;
  h.deps.notion.addCandidate = async () => { throw new Error('validation_error'); };
  await handleAdd(h.deps, `${h.searchId}:0`, 'U1', h.client, h.respond);
  assert.match(h.replies[0].text, /Couldn’t create the Purchasing row: validation_error/);
  h.deps.notion.addCandidate = ok;
  await handleAdd(h.deps, `${h.searchId}:0`, 'U1', h.client, h.respond);
  assert.equal(h.created.length, 1);
});

test('SearchCache: expires after the TTL and caps its size', () => {
  let now = 0;
  const cache = new SearchCache(1000, 2, () => now);
  const a = cache.put('U', result());
  now = 500;
  assert.ok(cache.get(a));
  now = 1501;
  assert.equal(cache.get(a), null);
  const ids = [cache.put('U', result()), cache.put('U', result()), cache.put('U', result())];
  assert.equal(cache.get(ids[0]!), null); // oldest evicted
  assert.ok(cache.get(ids[2]!));
});

// --- LLM client -----------------------------------------------------------------------------------

function fakeOpenAi(replies: string[]) {
  const bodies: any[] = [];
  const client: any = { chat: { completions: { create: async (body: any) => { bodies.push(body); return { choices: [{ message: { content: replies.shift() ?? '' } }] }; } } } };
  return { client, bodies };
}

test('parseJsonReply: plain and fenced JSON', () => {
  assert.deepEqual(parseJsonReply('{"cost": 1}'), { cost: 1 });
  assert.deepEqual(parseJsonReply('```json\n{"cost": 2.5}\n```'), { cost: 2.5 });
  assert.throws(() => parseJsonReply('sorry'));
});

test('OpenAiCompatLlm: JSON mode at temperature 0; reasoning effort only for gpt-oss', async () => {
  const a = fakeOpenAi(['{"ok": true}']);
  assert.deepEqual(await new OpenAiCompatLlm(a.client, 'gemini-x', 'gemini', 6000).json('sys', 'user'), { ok: true });
  assert.equal(a.bodies[0].temperature, 0);
  assert.deepEqual(a.bodies[0].response_format, { type: 'json_object' });
  assert.deepEqual(a.bodies[0].messages.map((m: any) => m.role), ['system', 'user']);
  assert.equal(a.bodies[0].reasoning_effort, undefined);

  const b = fakeOpenAi(['{}']);
  await new OpenAiCompatLlm(b.client, 'openai/gpt-oss-120b', 'groq', 6000).json('s', 'u');
  assert.equal(b.bodies[0].reasoning_effort, 'low');
});

test('OpenAiCompatLlm: a non-JSON reply is retried, then fails', async () => {
  const ok = fakeOpenAi(['no idea', '{"cost": 3}']);
  assert.deepEqual(await new OpenAiCompatLlm(ok.client, 'm', 'p', 6000).json('s', 'u'), { cost: 3 });
  const bad = fakeOpenAi(['no', 'still no']);
  await assert.rejects(new OpenAiCompatLlm(bad.client, 'm', 'p', 6000).json('s', 'u'), /not JSON/);
});

test('Pacer: spaces requests evenly across callers', async () => {
  let clock = 100;
  const slept: number[] = [];
  const pacer = new Pacer(2000, () => clock, async (ms) => { slept.push(ms); });
  await Promise.all([pacer.wait(), pacer.wait(), pacer.wait()]);
  assert.deepEqual(slept, [2000, 4000]); // first goes immediately
});

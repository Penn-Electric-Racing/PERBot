import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blankInfo, PAGE_CHARS, pageText, readListing, toListingInfo } from '../extract.js';
import { fetchHtml, MAX_PAGE_BYTES } from '../fetch.js';
import { findParts, mapLimit } from '../finder.js';
import { BackendError, cleanDdgUrl, parseDdgPage, search } from '../search.js';
import { FakeLlm, PAGE } from './helpers.js';

const result = (url = 'https://acme.com/p/lm7805', snippet = '') => ({ title: 'LM7805', url, snippet, searchRank: 0 });
const info = (d: any, source: 'llm' | 'llm snippet' = 'llm') => toListingInfo(d, blankInfo(), source);

// --- page → prompt ------------------------------------------------------------------------------

test('pageText: keeps heading, JSON-LD and product text; drops nav/footer/code', () => {
  const { title, ld, text } = pageText(PAGE);
  assert.equal(title, 'LM7805 Regulator (10pcs)');
  assert.match(ld, /"price": "5.90"/);
  assert.match(text, /\$5\.90 In stock: 120/);
  assert.doesNotMatch(text, /Cart|Gift cards|color: red/);
});

test('pageText: struck-out prices are labelled, not removed', () => {
  assert.match(pageText(PAGE).text, /\[struck-out: \$9\.99\]/);
});

test('pageText: capped, and the window starts near the heading', () => {
  const html = `<body><p>${'banner '.repeat(2000)}</p><h1>LM7805</h1><p>${'x'.repeat(20000)}</p></body>`;
  const { text } = pageText(html);
  assert.equal(text.length, PAGE_CHARS);
  assert.match(text, /LM7805/);
});

// --- LLM JSON → fields --------------------------------------------------------------------------

test('toListingInfo: full reply', () => {
  const i = info({
    cost: '5.90', currency: 'usd', supplier: ' Acme ', part_number: '296-1-ND', stock: 120, pack_size: 10,
    free_ship_min: 50, shipping_time: '2-3 days', price_min: 5.9, price_max: 7, price_breaks: [{ min_qty: 100, price: 0.45 }],
  });
  assert.equal(i.cost, 5.9);
  assert.equal(i.currency, 'USD');
  assert.equal(i.costSource, 'llm');
  assert.equal(i.supplier, 'Acme');
  assert.equal(i.partNumber, '296-1-ND');
  assert.equal(i.inStock, true); // implied by stock
  assert.equal(i.packSize, 10);
  assert.equal(i.freeShipMin, 50);
  assert.deepEqual(i.priceRange, [5.9, 7]);
  assert.deepEqual(i.priceBreaks, [{ minQty: 100, price: 0.45 }]);
});

test('toListingInfo: shipping cost', () => {
  const ship = (v: any) => info({ currency: 'USD', shipping_cost: v }).shippingCost;
  assert.equal(ship(0), 'Free');
  assert.equal(ship(4.5), '4.50 USD');
  assert.equal(ship(null), null);
  assert.equal(ship('free'), null);
  assert.equal(ship(-3), null);
});

test('toListingInfo: unusable prices are rejected', () => {
  for (const cost of [0, '0.00', null, 'call', true, -1]) {
    const i = info({ cost });
    assert.equal(i.cost, null, String(cost));
    assert.equal(i.costSource, null);
  }
});

test('toListingInfo: wrong types and junk are ignored', () => {
  const i = info({
    stock: 'lots', in_stock: 'yes', pack_size: 0, supplier: 7, currency: 5, listing_page: 'no',
    price_breaks: [{ min_qty: 1, price: 2 }, 'junk', { min_qty: 10 }],
  });
  assert.equal(i.stock, null);
  assert.equal(i.inStock, null);
  assert.equal(i.packSize, 1);
  assert.equal(i.supplier, null);
  assert.equal(i.currency, null);
  assert.deepEqual(i.priceBreaks, []);
  assert.equal(i.listingPage, false);
  assert.equal(info(null).cost, null); // not even an object
});

test('toListingInfo: out of stock wins over a stock count of 0', () => {
  assert.equal(info({ stock: 0, in_stock: false }).inStock, false);
});

// --- readListing --------------------------------------------------------------------------------

test('readListing: prompt carries query, snippet, JSON-LD and page; reply is mapped', async () => {
  const llm = new FakeLlm([{ cost: 5.9, currency: 'USD', supplier: 'Acme', pack_size: 10 }]);
  const r = await readListing(result(undefined, 'LM7805 from $5'), llm, 'LM7805', async () => PAGE);
  const prompt = llm.prompts[0]!.user;
  for (const part of ['Searching for: LM7805', 'LM7805 from $5', 'JSON-LD:', 'Page text:']) assert.ok(prompt.includes(part), part);
  assert.equal(r.cost, 5.9);
  assert.equal(r.costSource, 'llm');
  assert.equal(r.supplier, 'Acme');
  assert.equal(r.pageTitle, 'LM7805 Regulator (10pcs)');
  assert.equal(r.error, null);
});

test('readListing: a blocked page falls back to the snippet', async () => {
  const llm = new FakeLlm([{ cost: 1.25 }]);
  const r = await readListing(result(undefined, 'LM7805 $1.25'), llm, 'LM7805', async () => { throw new BackendError('HTTP 403'); });
  assert.ok(!llm.prompts[0]!.user.includes('Page text'));
  assert.equal(r.costSource, 'llm snippet');
  assert.equal(r.error, 'HTTP 403');
  assert.equal(r.supplier, 'acme.com');
});

test('readListing: an LLM failure is recorded, not thrown', async () => {
  const r = await readListing(result(), new FakeLlm([], '429 rate limited'), 'LM7805', async () => PAGE);
  assert.equal(r.cost, null);
  assert.equal(r.error, 'llm: 429 rate limited');
});

test('readListing: search URLs are listing pages even if the LLM disagrees', async () => {
  const r = await readListing(result('https://shop.com/search?q=lm7805'), new FakeLlm([{ listing_page: false }]), 'LM7805', async () => PAGE);
  assert.equal(r.listingPage, true);
});

// --- fetch / search -----------------------------------------------------------------------------

const fakeFetch = (body: string | Uint8Array, ctype: string, status = 200) =>
  (async () => new Response(body as any, { status, headers: { 'content-type': ctype } })) as unknown as typeof fetch;

test('fetchHtml: PDFs and HTTP errors are refused', async () => {
  await assert.rejects(fetchHtml('https://x.com/a.pdf', fakeFetch('%PDF', 'application/pdf')), /not a web page/);
  await assert.rejects(fetchHtml('https://x.com/', fakeFetch('', 'text/html', 403)), /HTTP 403/);
  assert.match(await fetchHtml('https://x.com/', fakeFetch('<h1>Hi</h1>', 'text/html; charset=utf-8')), /<h1>Hi<\/h1>/);
});

test('fetchHtml: stops reading after the byte cap', async () => {
  const big = new Uint8Array(MAX_PAGE_BYTES + 2_000_000).fill(97);
  const html = await fetchHtml('https://x.com/', fakeFetch(big, 'text/html'));
  assert.equal(html.length, MAX_PAGE_BYTES);
});

test('DuckDuckGo: redirect links unwrapped, ads skipped, next form found, challenge detected', () => {
  assert.equal(cleanDdgUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fmouser.com%2Fp&rut=x'), 'https://mouser.com/p');
  const page = parseDdgPage(`
    <div class="result result--ad"><a class="result__a" href="https://ad.com">Ad</a></div>
    <div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com">A</a>
      <a class="result__snippet">LM7805 $0.89</a></div>
    <form><input name="q" value="lm7805"><input name="s" value="10"><input name="vqd" value="abc"></form>`);
  assert.deepEqual(page.results, [{ title: 'A', url: 'https://a.com', snippet: 'LM7805 $0.89' }]);
  assert.deepEqual(page.next, { q: 'lm7805', s: '10', vqd: 'abc' });
  assert.equal(parseDdgPage('<div class="anomaly-modal"></div>').challenged, true);
});

test('search: falls through failing backends, dedupes, tops up with variants, numbers ranks', async () => {
  const calls: string[] = [];
  const res = await search('lm7805 price', 3, ['buy lm7805'], [
    ['broken', async () => { throw new BackendError('no key'); }],
    ['ok', async (q: string) => {
      calls.push(q);
      return q.startsWith('buy')
        ? [{ title: 'c', url: 'https://c.com', snippet: '' }]
        : [{ title: 'a', url: 'https://a.com/', snippet: '' }, { title: 'a2', url: 'https://a.com#x', snippet: '' }];
    }],
  ]);
  assert.equal(res.source, 'ok');
  assert.deepEqual(calls, ['lm7805 price', 'buy lm7805']);
  assert.deepEqual(res.results.map((r) => [r.url, r.searchRank]), [['https://a.com/', 0], ['https://c.com', 1]]);
});

test('search: every backend failing is an error', async () => {
  await assert.rejects(search('x', 3, [], [['a', async () => { throw new BackendError('down'); }]]), /All search backends failed/);
});

// --- finder -------------------------------------------------------------------------------------

test('mapLimit: keeps order and never exceeds the limit', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 3, 2, 4], 2, async (n) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, n));
    inFlight--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 30, 20, 40]);
  assert.equal(peak, 2);
});

test('findParts: end to end with fakes', async () => {
  const pages: Record<string, any> = {
    'https://cheap.com/p': { cost: 0.5, supplier: 'Cheap', shipping_cost: 0, shipping_time: '2 days', in_stock: true },
    'https://pricey.com/p': { cost: 2, supplier: 'Pricey', shipping_cost: 0, shipping_time: '2 days', in_stock: true },
  };
  const llm = new FakeLlm((user) => pages[/URL: (\S+)/.exec(user)![1]!]);
  const queries: string[][] = [];
  const r = await findParts('LM7805', {
    qty: 10, top: 5, pool: 5, llm,
    search: async (q, _n, variants) => {
      queries.push([q, ...variants]);
      return { source: 'fake', results: Object.keys(pages).reverse().map((url, i) => ({ title: 'LM7805', url, snippet: '', searchRank: i })) };
    },
    fetchHtml: async () => '<h1>LM7805</h1>',
  });
  assert.deepEqual(queries[0], ['LM7805 price', 'buy LM7805', 'LM7805 in stock']);
  assert.deepEqual(r.top.map((c) => c.supplier), ['Cheap', 'Pricey']);
  assert.equal(r.top[0]!.subtotal, 5);
  assert.deepEqual(r.stats, { candidates: 2, fetched: 2, priced: 2 });
  assert.equal(r.llm, 'fake/model');
});

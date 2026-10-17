import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeValue, PRICE_ACTIONS_BLOCK_ID, type PriceSwapValue } from '../blocks.js';
import {
  dashedId,
  eventProps,
  inPeriod,
  newRowProps,
  parseLedgerRow,
  PriceLedger,
  statsText,
  summarize,
  type LedgerRow,
} from '../ledger.js';
import { parseStats } from '../stats.js';
import { handlePriceSwap, type LedgerEvent, type PriceRow, type PriceSwapDeps } from '../swap.js';

const ROW_ID = '39e560bc-c039-80aa-bbbb-0123456789ab';
const AT = new Date('2026-10-17T19:00:00Z');
const value = (over: Partial<PriceSwapValue> = {}): PriceSwapValue => ({ v: 1, r: ROW_ID, q: 10, o: 5, n: 1.17, s: 'DigiKey', ...over });
const ev = (kind: LedgerEvent['kind'], over: Partial<PriceSwapValue> = {}): LedgerEvent => ({ kind, value: value(over), clicker: 'U1', at: AT });
const purchasingRow = (over: Partial<PriceRow> = {}): PriceRow => ({
  id: ROW_ID,
  unitCost: 5,
  quantity: 10,
  link: 'https://www.digikey.com/x',
  exported: false,
  deleted: false,
  notes: [],
  name: '5V regulator',
  part: 'LM7805CT/NOPB',
  season: 'REV12',
  url: 'https://www.notion.so/row',
  ...over,
});
const lrow = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  id: 'L1',
  name: 'Part ×10',
  outcome: 'Used',
  saved: 10,
  potential: 10,
  realized: false,
  supplier: 'DigiKey',
  season: 'REV12',
  created: AT.toISOString(),
  ...over,
});

test('ledger: Use records the saving in dollars, an accepted increase goes negative', () => {
  const used = eventProps(ev('used'), 'Ada', 'Pending')!;
  assert.equal(used.Outcome.select.name, 'Used');
  assert.equal(used['Saved $'].number, 38.3); // (5 − 1.17) × 10
  assert.equal(used.Direction.select.name, 'Drop');
  assert.equal(used['Used unit cost'].number, 1.17);
  assert.equal(used['Clicked by'].rich_text[0].text.content, 'Ada');
  const rise = eventProps(ev('used', { n: 6.5 }), 'Ada', 'Pending')!;
  assert.equal(rise['Saved $'].number, -15);
  assert.equal(rise.Direction.select.name, 'Rise');
  // A switched listing is recorded as the one used.
  assert.equal(eventProps(ev('used', { l: 'https://m.com/p', s: 'Mouser' }), 'Ada', 'Pending')!.Listing.url, 'https://m.com/p');
});

test('ledger: Undo and Keep zero the saving; a stale refusal never overwrites a decision', () => {
  const undone = eventProps(ev('undone'), 'Ada', 'Used')!;
  assert.equal(undone.Outcome.select.name, 'Undone');
  assert.equal(undone['Saved $'].number, 0);
  assert.equal(undone['Used unit cost'].number, null);
  assert.equal(undone.Realized.checkbox, false);
  assert.equal(eventProps(ev('kept'), 'Ada', 'Pending')!.Outcome.select.name, 'Kept');
  assert.equal(eventProps(ev('refused'), 'Ada', 'Pending')!.Outcome.select.name, 'Refused');
  assert.equal(eventProps(ev('refused'), 'Ada', 'Used'), null);
  assert.equal(eventProps(ev('refused'), 'Ada', null)!.Outcome.select.name, 'Refused');
});

test('ledger: a row PERBot creates itself carries the alert and the Purchasing row', () => {
  const p = newRowProps(value({ r: ROW_ID.replace(/-/g, ''), l: 'https://m.com/p' }), purchasingRow());
  assert.equal(p.Name.title[0].text.content, '5V regulator ×10');
  assert.equal(p['Row ID'].rich_text[0].text.content, ROW_ID); // dashed, so lookups match
  assert.equal(p['Potential $'].number, 38.3);
  assert.equal(p.Season.select.name, 'REV12');
  assert.equal(p['Purchasing row'].url, 'https://www.notion.so/row');
  assert.equal(p.Listing.url, 'https://m.com/p');
  assert.equal(dashedId(ROW_ID.toUpperCase()), ROW_ID);
});

test('ledger: summary splits savings, realized, increases, and drops left on the table', () => {
  const s = summarize([
    lrow({ name: 'A', saved: 38.3, realized: true }),
    lrow({ name: 'B', saved: 12 }),
    lrow({ name: 'C', saved: -15 }),
    lrow({ outcome: 'Kept', saved: 0, potential: 7.5 }),
    lrow({ outcome: 'Pending', saved: 0, potential: 2.5 }),
    lrow({ outcome: 'Pending', saved: 0, potential: -4 }), // a rise nobody answered: not "on the table"
    lrow({ outcome: 'Undone', saved: 0, potential: 9 }),
  ]);
  assert.equal(s.alerts, 7);
  assert.deepEqual([s.saved, s.savedCount, s.realized, s.realizedCount], [50.3, 2, 38.3, 1]);
  assert.deepEqual([s.increases, s.increasesCount], [15, 1]);
  assert.deepEqual([s.onTable, s.onTableCount], [10, 2]);
  assert.deepEqual(s.top.map((r) => r.name), ['A', 'B']);
  const text = statsText(s, 'season', 'REV12', 'https://notion.so/ledger');
  assert.match(text, /Price check savings: REV12 season/);
  assert.match(text, /\*\$50\.30 saved\* on 2 accepted price drops \(\$38\.30 realized: 1 order placed at the new price\)/);
  assert.match(text, /\$15\.00 of price increases caught before ordering \(1 row\)/);
  assert.match(text, /7 alerts: 3 used · 1 kept · 1 undone · 2 no answer yet \(60% of answered alerts used\)/);
  assert.match(text, /\$10\.00 still on the table: 2 price drops not taken/);
  assert.match(text, /1\. A: \$38\.30 \(DigiKey\)/);
  assert.match(text, /<https:\/\/notion\.so\/ledger\|Open the ledger in Notion>/);
  assert.match(statsText(summarize([]), 'week', 'REV12', ''), /No price alerts this week/);
});

test('ledger: periods and the /pricecheck arguments', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  assert.equal(inPeriod(lrow(), 'week', 'REV12', now), true);
  assert.equal(inPeriod(lrow({ created: '2026-10-01T00:00:00Z' }), 'week', 'REV12', now), false);
  assert.equal(inPeriod(lrow({ season: 'REV11' }), 'season', 'REV12', now), false);
  assert.equal(inPeriod(lrow({ season: 'REV11' }), 'all', 'REV12', now), true);
  assert.deepEqual(parseStats(''), { kind: 'stats', period: 'season', share: false });
  assert.deepEqual(parseStats('week share'), { kind: 'stats', period: 'week', share: true });
  assert.deepEqual(parseStats('all'), { kind: 'stats', period: 'all', share: false });
  assert.equal(parseStats('help').kind, 'help');
});

test('ledger: clicks hand the handler a ledger event (test alerts keep their flag)', async () => {
  let current = purchasingRow();
  const deps: PriceSwapDeps = {
    fetchRow: async () => ({ ...current }),
    writeRow: async (_id, patch) => {
      current = { ...current, unitCost: patch.unitCost };
    },
    displayName: async () => 'Ada',
    now: () => AT,
  };
  const existing = [{ type: 'section', text: { type: 'mrkdwn', text: 'alert' } }, { type: 'actions', block_id: PRICE_ACTIONS_BLOCK_ID, elements: [] }];
  const click = (actionId: string, v: PriceSwapValue) => handlePriceSwap(deps, { actionId, rawValue: JSON.stringify(v), clicker: 'U1', existing });
  assert.equal((await click('price_swap_keep', value({ n: undefined }))).ledger?.kind, 'kept');
  const used = await click('price_swap_use:0', value());
  assert.equal(used.ledger?.kind, 'used');
  assert.equal(used.ledger?.value.n, 1.17);
  assert.equal((await click('price_swap_use:0', value())).ledger?.kind, 'used'); // already at the price
  assert.equal((await click('price_swap_undo', value({ t: Math.floor(AT.getTime() / 1000) }))).ledger?.kind, 'undone');
  current = { ...current, unitCost: 3 };
  assert.equal((await click('price_swap_use:0', value())).ledger?.kind, 'refused');
  assert.equal((await click('price_swap_undo', value({ t: Math.floor(AT.getTime() / 1000) }))).ledger, undefined);
  assert.equal(decodeValue(JSON.stringify(value({ x: 1 })))?.x, 1);
});

/** A tiny stand-in for the Notion client: one data source of pages, filtered like Notion. */
function fakeNotion() {
  const store: any[] = [];
  const calls: string[] = [];
  const text = (p: any, prop: string) => p.properties[prop]?.rich_text?.[0]?.text?.content ?? '';
  // Notion echoes text values back with plain_text, which the parsers read.
  const stored = (props: any) => {
    const out = structuredClone(props);
    for (const v of Object.values<any>(out)) for (const t of v?.rich_text ?? v?.title ?? []) t.plain_text = t.text?.content ?? '';
    return out;
  };
  const client = {
    dataSources: {
      query: async ({ filter }: any) => {
        calls.push('query');
        const results = store.filter((p) =>
          (filter?.and ?? []).every((f: any) => {
            const prop = p.properties[f.property];
            if (f.rich_text) return text(p, f.property) === f.rich_text.equals;
            if (f.number) return prop?.number === f.number.equals;
            if (f.select) return prop?.select?.name === f.select.equals;
            if (f.checkbox) return Boolean(prop?.checkbox) === f.checkbox.equals;
            return true;
          })
        );
        return { results, has_more: false, next_cursor: null };
      },
    },
    pages: {
      create: async ({ properties }: any) => {
        calls.push('create');
        const page = { id: `L${store.length + 1}`, created_time: AT.toISOString(), properties: stored(properties) };
        store.push(page);
        return page;
      },
      update: async ({ page_id, properties }: any) => {
        calls.push('update');
        const page = store.find((p) => p.id === page_id);
        Object.assign(page.properties, stored(properties));
        return page;
      },
    },
  };
  return { client, store, calls };
}

test('ledger: record() updates the listener’s row, creates one when missing, skips test alerts', async () => {
  const fake = fakeNotion();
  const ledger = new PriceLedger('ds', fake.client);
  const fetchRow = async () => purchasingRow();

  assert.equal(await ledger.record(ev('used', { x: 1 }), 'Ada', fetchRow), 'test alert, not logged');
  assert.deepEqual(fake.calls, []);

  // No row yet (alert from before the ledger): created, then the click applied.
  assert.equal(await ledger.record(ev('used'), 'Ada', fetchRow), 'new → used');
  const row = parseLedgerRow(fake.store[0]);
  assert.deepEqual([row.outcome, row.saved, row.name], ['Used', 38.3, '5V regulator ×10']);

  // Same alert again: found, not duplicated. A late stale refusal leaves Used alone.
  assert.equal(await ledger.record(ev('refused'), 'Ada', fetchRow), 'kept Used');
  assert.equal(await ledger.record(ev('undone'), 'Bo', fetchRow), 'Used → undone');
  assert.equal(fake.store.length, 1);
  assert.equal(parseLedgerRow(fake.store[0]).outcome, 'Undone');
  assert.equal(await new PriceLedger('', fake.client).record(ev('used'), 'Ada', fetchRow), 'ledger off');
});

test('ledger: the sweep marks a Used row Realized only once ordered at the used price', async () => {
  const fake = fakeNotion();
  const ledger = new PriceLedger('ds', fake.client);
  await ledger.record(ev('used'), 'Ada', async () => purchasingRow());
  let row = purchasingRow({ unitCost: 1.17 });
  const fetchRow = async () => row;
  assert.equal(await ledger.sweepRealized(fetchRow, AT), 0); // not ordered yet
  row = purchasingRow({ unitCost: 2, exported: true });
  assert.equal(await ledger.sweepRealized(fetchRow, AT), 0); // ordered, but at another price
  row = purchasingRow({ unitCost: 1.17, exported: true });
  assert.equal(await ledger.sweepRealized(fetchRow, AT), 1);
  assert.equal(parseLedgerRow(fake.store[0]).realized, true);
  assert.equal(await ledger.sweepRealized(fetchRow, AT), 0); // already marked
});

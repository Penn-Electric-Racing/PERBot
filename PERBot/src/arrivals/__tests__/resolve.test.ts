import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReply, settleBlocks, textNamesVendor } from '../blocks.js';
import { addresseeMatches, eligibleRows, groupOrders, ordersForVendor, rankOrders } from '../orders.js';
import { buildPickPrompt, groundPicks, parsePicks, stem } from '../pick.js';
import { resolvePackage, resolveScan, type Picker } from '../resolve.js';
import type { Scan } from '../types.js';
import { BASE, line, pkg, row } from './helpers.js';

const OCT10 = new Date('2026-10-10T16:00:00Z');
const noPick: Picker = async () => [];

test('eligibleRows: ordered, not arrived, requested before the photo', () => {
  const ok = row({ partNumber: 'A' });
  const draft = row({ partNumber: 'B', exported: false });
  const arrived = row({ partNumber: 'C', arrived: 'Yes' });
  const later = row({ partNumber: 'D', submittedAt: '2026-10-12' });
  assert.deepEqual(eligibleRows([ok, draft, arrived, later], OCT10).map((r) => r.partNumber), ['A']);
});

test('groupOrders: by Run ID, else vendor + request day', () => {
  const orders = groupOrders([
    row({ partNumber: 'A', runId: 'BENBUYS-1' }),
    row({ partNumber: 'B', runId: 'BENBUYS-1' }),
    row({ partNumber: 'C', vendor: 'Amazon', submittedAt: '2026-09-02T10:00:00Z' }),
    row({ partNumber: 'D', vendor: 'amazon', submittedAt: '2026-09-02T18:00:00Z' }),
    row({ partNumber: 'E', vendor: 'Amazon', submittedAt: '2026-09-05' }),
  ]);
  assert.deepEqual(orders.map((o) => [o.key, o.rows.length]), [['BENBUYS-1|digikey', 2], ['2026-09-02|amazon', 2], ['2026-09-05|amazon', 1]]);
  assert.equal(orders[0]!.runId, 'BENBUYS-1');
});

test('ordersForVendor / addresseeMatches / rankOrders', () => {
  const orders = groupOrders([
    row({ partNumber: 'A', runId: 'R-OLD', orderedAt: '2026-08-01' }),
    row({ partNumber: 'B', runId: 'R-NEAR', orderedAt: '2026-09-25' }),
    row({ partNumber: 'C', runId: 'R-AFTER', orderedAt: '2026-10-05' }),
    row({ partNumber: 'D', runId: 'R-KATH', orderedAt: '2026-07-01', pointOfContact: ['Katherine Shen'] }),
    row({ partNumber: 'E', runId: 'MC', vendor: 'McMaster-Carr', link: '' }),
  ]);
  assert.equal(ordersForVendor(orders, 'Digi-Key').length, 4);
  assert.equal(ordersForVendor(orders, null).length, 0);
  assert.ok(addresseeMatches('KATHERINE SHEN', ['Katherine Shen']));
  assert.ok(!addresseeMatches('University of Pennsylvania', ['Katherine Shen']));
  const dk = ordersForVendor(orders, 'DigiKey');
  // Shipped Sep 28: the addressee's order first, then the one ordered just before shipping; one ordered after shipping last.
  assert.deepEqual(rankOrders(dk, pkg([], { shipDate: '2026-09-28', addressee: 'KATHERINE SHEN' }), OCT10).map((o) => o.runId), ['R-KATH', 'R-NEAR', 'R-OLD', 'R-AFTER']);
  // No ship date: the order placed just before the photo comes first (next-day shipping).
  assert.deepEqual(rankOrders(dk, pkg([]), OCT10).map((o) => o.runId), ['R-AFTER', 'R-NEAR', 'R-OLD', 'R-KATH']);
});

test('pick: prompt uses handles only; answers are validated against what was offered', () => {
  const orders = groupOrders([
    row({ partNumber: 'TUBE-1', name: 'Clear PVC tubing 3/8"', runId: 'R1', vendor: 'McMaster-Carr' }),
    row({ partNumber: 'BRKT', name: 'Bracket stock', runId: 'R2', vendor: 'McMaster-Carr' }),
  ]);
  const built = buildPickPrompt(pkg([], { vendor: 'McMaster-Carr', itemHints: ['cooling tube'] }), orders, '@Elijah cooling tube is here');
  assert.match(built.prompt, /O1: McMaster-Carr/);
  assert.match(built.prompt, /R1: Clear PVC tubing/);
  assert.doesNotMatch(built.prompt, /page-\d|notion\.so/);

  const picks = parsePicks(
    {
      picks: [
        { order: 'O1', rows: ['R1', 'R2', 'R99'], confidence: 'high', evidence: 'cooling tube ≈ PVC tubing' },
        { order: 'O1', rows: [], confidence: 'high', evidence: 'dupe' },
        { order: 'O7', rows: [], confidence: 'high', evidence: 'unknown order' },
        { order: 'O2', rows: [], confidence: 'medium', evidence: 'bracket stock' },
        { order: 'O2', rows: [], confidence: 'none', evidence: 'x' },
      ],
    },
    built
  );
  assert.deepEqual(picks.map((p) => [p.order.key, p.rows.map((r) => r.partNumber)]), [
    ['R1|mcmaster', ['TUBE-1']], // R2 belongs to O2, R99 doesn't exist
    ['R2|mcmaster', ['BRKT']], // no rows named → the whole order
  ]);
  assert.deepEqual(parsePicks({ picks: 'nope' }, built), []);
});

test('resolvePackage: slip match wins; hints go to the picker; vendor alone → pick-list; nothing → none', async () => {
  const rows = [
    row({ partNumber: 'A-ND', runId: 'BENBUYS-1' }),
    row({ partNumber: 'TUBE', name: 'PVC tubing', runId: 'MC-1', vendor: 'McMaster-Carr', link: '' }),
  ];
  const [strong] = await resolvePackage(pkg([line('A-ND')]), rows, OCT10, '', noPick);
  assert.equal(strong!.kind, 'match');

  let offered = 0;
  const picker: Picker = async (_p, orders) => {
    offered = orders.length;
    return [{ order: orders[0]!, rows: orders[0]!.rows, confidence: 'high', evidence: 'tube' }];
  };
  const [hinted] = await resolvePackage(pkg([], { vendor: 'McMaster-Carr', itemHints: ['cooling tube'] }), rows, OCT10, 'cooling tube is here', picker);
  assert.equal(offered, 1); // only McMaster orders offered
  assert.ok(hinted!.kind === 'match' && hinted!.evidence === 'tube');

  // A vendor with no open orders (a misread) still lets specific evidence search every order.
  await resolvePackage(pkg([], { vendor: 'DHL', itemHints: ['cooling tube'] }), rows, OCT10, '', picker);
  assert.equal(offered, 2);

  const [labelOnly] = await resolvePackage(pkg([], { vendor: 'DigiKey' }), rows, OCT10, 'Digikey here', noPick);
  assert.ok(labelOnly!.kind === 'choose' && labelOnly!.orders[0]!.key === 'BENBUYS-1|digikey');

  assert.equal((await resolvePackage(pkg([], { vendor: null }), rows, OCT10, '', noPick))[0]!.kind, 'none');
  assert.equal((await resolvePackage(pkg([], { vendor: 'Oshcut' }), rows, OCT10, '', noPick))[0]!.kind, 'none');
});

function scan(scene: Scan['scene'], packages = [pkg([], { vendor: 'DigiKey' })], legible = true): Scan {
  return { scene, legible, packages };
}

test('buildReply policy: silent for non-deliveries and unresolved thread photos; one nudge for a top-level label', async () => {
  const rows = [row({ partNumber: 'A-ND', runId: 'BENBUYS-1', pointOfContact: ['Mike Song'] })];
  const top = { ...BASE, inThread: false };
  const thread = { ...BASE, inThread: true };

  assert.equal(buildReply(scan('not_a_delivery', []), [], top), null);

  // Vendor-only label: pick-list at top level, silence in a thread.
  const label = scan('shipping_label');
  const res = await resolveScan(label, rows, OCT10, 'Digikey here', noPick);
  const choose = buildReply(label, res, top)!;
  assert.match(JSON.stringify(choose.blocks), /one open DigiKey order \(\*Mike\*’s\) from \*Sep 28\*/);
  assert.ok(choose.blocks.some((b) => b.type === 'actions' && b.elements[0].action_id === 'arrival_order:0'));
  assert.equal(buildReply(label, res, thread), null);

  // Contents photo with nothing to go on: silent even at top level.
  const contents = scan('contents', [pkg([], { vendor: null })]);
  assert.equal(buildReply(contents, await resolveScan(contents, rows, OCT10, '', noPick), top), null);

  // Unreadable label at top level → one nudge; in a thread → silent.
  const blurry = scan('shipping_label', [pkg([], { vendor: null })], false);
  const blurryRes = await resolveScan(blurry, rows, OCT10, '', noPick);
  assert.match(JSON.stringify(buildReply(blurry, blurryRes, top)!.blocks), /couldn’t read the label.*packing slip/);
  assert.equal(buildReply(blurry, blurryRes, thread), null);
});

test('buildReply: specific matches reply even in threads; a pile photo gets matches but no pick-lists', async () => {
  const rows = [
    row({ partNumber: 'A-ND', runId: 'BENBUYS-1', pointOfContact: ['Sofia Ramirez'], unitCost: 123.45, name: 'Hall sensor' }),
    row({ partNumber: 'B-ND', runId: 'BENBUYS-1', pointOfContact: ['Sofia Ramirez'], unitCost: 9.99 }),
    row({ partNumber: 'TUBE', name: 'PVC tubing', runId: 'MC-1', vendor: 'McMaster-Carr', link: '' }),
    row({ partNumber: 'NUT', name: 'Hex nuts', runId: 'MC-2', vendor: 'McMaster-Carr', link: '' }),
  ];
  const tubePicker: Picker = async (_p, orders) => {
    const o = orders.find((x) => x.runId === 'MC-1');
    return o ? [{ order: o, rows: o.rows, confidence: 'high', evidence: 'message says cooling tube' }] : [];
  };
  const pile = scan('several_packages', [pkg([line('A-ND')]), pkg([], { vendor: 'McMaster-Carr', itemHints: ['cooling tube'] }), pkg([], { vendor: 'McMaster-Carr' })]);
  const res = await resolveScan(pile, rows, OCT10, 'cooling tube is here', tubePicker);
  assert.deepEqual(res.map((r) => [r.pkg, r.kind]), [[0, 'match'], [1, 'match'], [2, 'choose']]);

  const reply = buildReply(pile, res, { ...BASE, inThread: false })!;
  const json = JSON.stringify(reply.blocks);
  assert.match(json, /2 orders in this photo/);
  assert.match(json, /\*Sofia\*'s \*DigiKey\* order from \*Sep 28\*/);
  assert.match(json, /Probably the \*McMaster-Carr\* order/);
  assert.match(json, /:mag: message says cooling tube/);
  assert.doesNotMatch(json, /123\.45|9\.99|\$|Which order/);
  const actionBlocks = reply.blocks.filter((b) => b.type === 'actions');
  assert.deepEqual(actionBlocks.map((b) => b.block_id), ['arrival_actions:0', 'arrival_actions:1']);
  assert.deepEqual(actionBlocks[0].elements.map((e: any) => e.text.text), ['These 1 arrived', 'All 2 arrived', 'Wrong order']);

  assert.equal(buildReply(pile, res, { ...BASE, inThread: true })!.blocks.filter((b) => b.type === 'actions').length, 2);
});

test('buildReply: one-order pick-list reads naturally; mixed-vendor PEFS runs never go by Run ID', async () => {
  const rows = [
    row({ partNumber: 'TUBE', name: 'Firewall tube', runId: 'PERPO-1', vendor: 'mcmaster', link: '', pointOfContact: [] }),
    row({ partNumber: 'SWAB', name: 'Cotton swabs', runId: 'PERPO-1', vendor: 'Amazon', link: '' }),
  ];
  const label = scan('shipping_label', [pkg([], { vendor: 'McMASTER-CARR' })]);
  const res = await resolveScan(label, rows, OCT10, '', noPick);
  const reply = buildReply(label, res, { ...BASE, inThread: false })!;
  const json = JSON.stringify(reply.blocks);
  assert.match(json, /A \*McMaster-Carr\* package\. There’s one open McMaster-Carr order from \*Sep 28\*\. Is it this one\?/);
  assert.match(json, /Yes — 1 item arrived/);
  const value = JSON.parse(reply.blocks.find((b) => b.type === 'actions').elements[0].value);
  assert.equal(value.g, undefined); // PERPO-1 also holds the Amazon row
  assert.equal(value.r.length, 1);
});

test('groundPicks: a picked row must share a word stem with the package evidence (backtest false positives)', () => {
  const [swabs, tubing] = groupOrders([
    row({ partNumber: 'B07', name: '1200pcs Precision Tip Cotton Swabs', runId: 'A1', vendor: 'Amazon' }),
    row({ partNumber: 'TUBE', name: 'DERNORD 3/8" ID PVC Tubing for Cooling', runId: 'A2', vendor: 'Amazon' }),
  ]);
  const pick = (o: typeof swabs) => ({ order: o!, rows: o!.rows, confidence: 'high' as const, evidence: '' });
  assert.deepEqual(groundPicks([pick(swabs)], pkg([], { itemHints: ['busbar pins', 'buds'] })), []);
  assert.equal(groundPicks([pick(tubing)], pkg([], { itemHints: ['cooling tube'] })).length, 1);
  assert.equal(groundPicks([pick(tubing)], pkg([line('X', 1, { description: 'clear tubing 10ft' })])).length, 1);
  assert.deepEqual(['soldering', 'solder', 'wiring', 'wire', 'tubes', 'bus'].map(stem), ['sold', 'sold', 'wir', 'wir', 'tub', 'bus']);

  // Backtest run 2: "PCBs (JLCPCB)" grounded "JLCPCB Order 1" through the vendor's own name.
  const [jlc] = groupOrders([row({ partNumber: 'JLC', name: 'JLCPCB Order 1', runId: 'J1', vendor: 'JLCPCB', link: '' })]);
  assert.deepEqual(groundPicks([pick(jlc)], pkg([], { vendor: 'JLCPCB', itemHints: ['PCBs (JLCPCB)'] })), []);
});

test('pile photos: a pick-list only when the message names the vendor, once per vendor', async () => {
  const rows = [row({ partNumber: 'PCB', name: 'Minion Test Board', runId: 'J1', vendor: 'JLCPCB', link: '' })];
  const pile = scan('several_packages', [pkg([], { vendor: 'JLCPCB' }), pkg([], { vendor: 'JLCPCB' })]);
  const res = await resolveScan(pile, rows, OCT10, 'Jlc picked up', noPick);
  assert.ok(textNamesVendor('Jlc picked up', 'JLCPCB'));
  assert.ok(!textNamesVendor('picked up', 'JLCPCB'));
  const named = buildReply(pile, res, { ...BASE, inThread: false, text: 'Jlc picked up' })!;
  assert.equal(named.blocks.filter((b) => b.type === 'actions').length, 1);
  assert.equal(buildReply(pile, res, { ...BASE, inThread: false, text: '' }), null);
});

test('pick-list: one section per order with its items linked to Notion; tapping keeps only the chosen order', async () => {
  const rows = [
    row({ partNumber: 'SN74LVC245APWR', name: 'Bus Transceivers Single 8-bit', runId: 'M1', vendor: 'Mouser', pointOfContact: ['Mike Song'], url: 'https://notion.so/r1', quantity: 2 }),
    ...['A1', 'A2', 'A3', 'A4', 'A5'].map((pn) => row({ partNumber: `${pn}-X1`, name: `Cap ${pn}`, runId: 'M1', vendor: 'Mouser', pointOfContact: ['Mike Song'] })),
    row({ partNumber: 'HV-PLUG-2', name: 'Secondary HVDC Plug', runId: 'M2', vendor: 'Mouser', pointOfContact: [], url: 'https://notion.so/r2' }),
  ];
  const label = scan('shipping_label', [pkg([], { vendor: 'Mouser Electronics' })]);
  const reply = buildReply(label, await resolveScan(label, rows, OCT10, 'mouser here', noPick), { ...BASE, inThread: false })!;
  const choices = reply.blocks.filter((b) => b.block_id?.startsWith('arrival_choice:0:'));
  assert.equal(choices.length, 2);
  assert.match(choices[0].text.text, /^\*Mike\* · Sep 28 · 6 items\n• <https:\/\/notion\.so\/r1\|Bus Transceivers Single 8-bit> `SN74LVC245APWR` ×2/);
  assert.match(choices[0].text.text, /_\+2 more_$/);
  assert.match(choices[1].text.text, /^\*No point of contact\*/);
  assert.deepEqual(choices.map((b) => [b.accessory.text.text, b.accessory.action_id]), [['This one', 'arrival_order:0'], ['This one', 'arrival_order:1']]);
  const none = reply.blocks.find((b) => b.block_id === 'arrival_actions:0');
  assert.deepEqual(none.elements.map((e: any) => e.text.text), ['None of these']);

  const settled = settleBlocks(reply.blocks, 'arrival_choice:0:1', 'done', 1);
  assert.deepEqual(settled.filter((b) => b.block_id?.startsWith('arrival_choice')).map((b) => [b.block_id, 'accessory' in b]), [['arrival_choice:0:1', false]]);
  assert.equal(settled.at(-1).elements[0].text, 'done');
  assert.equal(settleBlocks(reply.blocks, 'arrival_actions:0', 'nope').filter((b) => b.block_id?.startsWith('arrival_choice')).length, 0);
});

test('pile photos: the message’s items reach every package, not just the one the model filed them under', async () => {
  const rows = [
    row({ partNumber: 'LDO-1', name: 'LDO regulator', runId: 'M1', vendor: 'Mouser' }),
    row({ partNumber: 'B0FIT', name: 'Push-to-connect cooling fittings 3/8"', runId: 'A1', vendor: 'Amazon', link: '' }),
  ];
  const seenHints: string[][] = [];
  const picker: Picker = async (p, orders) => {
    seenHints.push(p.itemHints);
    const o = orders.find((x) => x.runId === 'A1');
    return o ? [{ order: o, rows: o.rows, confidence: 'high', evidence: 'cooling fittings' }] : [];
  };
  const pile = scan('several_packages', [pkg([], { vendor: 'Mouser', itemHints: ['cooling fittings'] }), pkg([], { vendor: 'Amazon' })]);
  const res = await resolveScan(pile, rows, OCT10, 'mouser parts and cooling fittings', picker);
  assert.deepEqual(seenHints, [['cooling fittings'], ['cooling fittings']]);
  assert.deepEqual(res.map((r) => [r.pkg, r.kind]), [[0, 'choose'], [1, 'match']]);
});

test('groundPicks: a hint grounds on its head noun, not on an adjective it shares', () => {
  const [fitting, tubing] = groupOrders([
    row({ partNumber: 'B0T', name: 'Cooling T-Fitting for Temp Sensor', runId: 'A1', vendor: 'Amazon' }),
    row({ partNumber: 'B0P', name: 'DERNORD 3/8" ID PVC Tubing for Cooling', runId: 'A2', vendor: 'Amazon' }),
  ]);
  const pick = (o: typeof fitting) => ({ order: o!, rows: o!.rows, confidence: 'high' as const, evidence: '' });
  const hints = pkg([], { vendor: 'Amazon', itemHints: ['mouser parts', 'cooling fittings or something'] });
  assert.deepEqual(groundPicks([pick(fitting), pick(tubing)], hints).map((p) => p.order.key), [fitting!.key]);
});

test('groundPicks: once an order is grounded by a head noun, a shared modifier brings its sibling rows along', () => {
  const [mc] = groupOrders([
    row({ partNumber: 'flange 8 feet', name: 'primary flange', runId: 'MC', vendor: 'mcmaster', link: '' }),
    row({ partNumber: '4130 tube', name: 'welded insert stock', runId: 'MC', vendor: 'mcmaster', link: '' }),
  ]);
  const hints = pkg([], { vendor: 'McMaster-Carr', itemHints: ['primary bracket stock', 'welded inserts stock'] });
  const [p] = groundPicks([{ order: mc!, rows: [mc!.rows[1]!], confidence: 'high', evidence: '' }], hints);
  assert.deepEqual(p!.rows.map((r) => r.name).sort(), ['primary flange', 'welded insert stock']);
});

test('groundPicks: a word the picked row already explains does not drag in siblings', () => {
  const [amz] = groupOrders([
    row({ partNumber: 'B0T', name: 'Cooling T-Fitting for Temp Sensor', runId: 'A1', vendor: 'Amazon' }),
    row({ partNumber: 'B0F', name: '12V Cooling Fans', runId: 'A1', vendor: 'Amazon' }),
  ]);
  const [p] = groundPicks([{ order: amz!, rows: [amz!.rows[0]!], confidence: 'high', evidence: '' }], pkg([], { vendor: 'Amazon', itemHints: ['cooling fittings'] }));
  assert.deepEqual(p!.rows.map((r) => r.name), ['Cooling T-Fitting for Temp Sensor']);
});

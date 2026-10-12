import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrivalDm, buildReply, replaceCard, settleCard, textNamesVendor, who } from '../blocks.js';
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
  assert.equal(choose.blocks.find((b) => b.block_id === 'arrival_actions:0').elements[0].action_id, 'arrival_mark');
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
  const actionBlocks = reply.blocks.filter((b) => b.block_id?.startsWith('arrival_actions:'));
  assert.deepEqual(actionBlocks.map((b) => b.block_id), ['arrival_actions:0', 'arrival_actions:1']);
  assert.deepEqual(actionBlocks[0].elements.map((e: any) => e.text?.text ?? e.type), ['Mark arrived', 'Wrong order']);
  // The slip showed A-ND only: it's ticked, its order-mate B-ND is listed unticked.
  const boxes = reply.blocks.find((b) => b.block_id === 'arrival_items:0').elements[0];
  assert.equal(boxes.options.length, 2);
  assert.equal(boxes.options[0].text.text, 'Hall sensor ×1');
  assert.deepEqual(boxes.initial_options.map((o: any) => o.text.text), ['Hall sensor ×1']);

  assert.equal(buildReply(pile, res, { ...BASE, inThread: true })!.blocks.filter((b) => b.block_id?.startsWith('arrival_actions:')).length, 2);
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
  assert.deepEqual(reply.blocks.find((b) => b.block_id === 'arrival_actions:0').elements.map((e: any) => e.text.text), ['Mark arrived', 'No']);
  // PERPO-1 also holds the Amazon row: only the McMaster row is offered.
  assert.deepEqual(reply.blocks.find((b) => b.block_id === 'arrival_items:0').elements[0].options.map((o: any) => o.text.text), ['Firewall tube ×1']);
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
  assert.equal(named.blocks.filter((b) => b.block_id?.startsWith('arrival_actions:')).length, 1);
  assert.equal(buildReply(pile, res, { ...BASE, inThread: false, text: '' }), null);
});

test('guess card: top order with requesters @-mentioned, items as checkboxes, the rest in a select; settle + swap', async () => {
  const rows = [
    row({ partNumber: 'SN74LVC245APWR', name: 'Bus Transceivers Single 8-bit', runId: 'M1', vendor: 'Mouser', pointOfContact: ['Mike Song', 'Ana Li'], url: 'https://notion.so/r1', quantity: 2 }),
    ...['A1', 'A2', 'A3', 'A4', 'A5'].map((pn) => row({ partNumber: `${pn}-X1`, name: `Cap ${pn}`, runId: 'M1', vendor: 'Mouser', pointOfContact: ['Mike Song'] })),
    row({ partNumber: 'HV-PLUG-2', name: 'Secondary HVDC Plug', runId: 'M2', vendor: 'Mouser', pointOfContact: [], url: 'https://notion.so/r2', orderedAt: '2026-09-20T15:00:00.000Z' }),
  ];
  const people = new Map([['Mike Song', 'U_MIKE']]);
  const label = scan('shipping_label', [pkg([], { vendor: 'Mouser Electronics' })]);
  const reply = buildReply(label, await resolveScan(label, rows, OCT10, 'mouser here', noPick), { ...BASE, inThread: false, people })!;

  const head = reply.blocks.find((b) => b.block_id === 'arrival_head:0').text.text;
  assert.equal(head, ':package: A *Mouser* package. Is it <@U_MIKE> and *Ana*’s order from *Sep 28*?');
  const boxes = reply.blocks.find((b) => b.block_id === 'arrival_items:0').elements[0];
  assert.equal(boxes.options.length, 6);
  assert.equal(boxes.initial_options.length, 6);
  assert.deepEqual(boxes.options[0].text, { type: 'mrkdwn', text: 'Bus Transceivers Single 8-bit `SN74LVC245APWR` ×2' });
  assert.equal(boxes.options[0].description.text, '<https://notion.so/r1|Open in Notion ↗>');
  // A long app.notion.com URL falls back to the short notion.so/<id> form.
  const long = row({ partNumber: 'X1', id: '3f0560bc-c039-8185-9ee4-e08d9394ffaa', url: `https://app.notion.com/p/${'x'.repeat(80)}` });
  const longCard = buildReply(scan('shipping_label', [pkg([], { vendor: 'DigiKey' })]), [{ pkg: 0, kind: 'choose', orders: groupOrders([long]), vendor: 'DigiKey' }], { ...BASE, inThread: false })!;
  assert.equal(longCard.blocks.find((b) => b.block_id === 'arrival_items:0').elements[0].options[0].description.text, '<https://notion.so/3f0560bcc03981859ee4e08d9394ffaa|Open in Notion ↗>');
  assert.ok(boxes.options.every((o: any) => o.text.text.length <= 75 && (o.description?.text.length ?? 0) <= 75));

  const actions = reply.blocks.find((b) => b.block_id === 'arrival_actions:0').elements;
  assert.deepEqual(actions.map((e: any) => e.text?.text ?? e.placeholder.text), ['Mark arrived', 'None of these', 'Other Mouser orders (1)…']);
  assert.deepEqual(actions[2].options.map((o: any) => [o.text.text, o.value]), [['No contact · Sep 20 · 1 item · Secondary HVDC Plug', 'M2|mouser']]);
  assert.equal(JSON.parse(actions[0].value).k, 'M1|mouser');

  // Marked: checkboxes → linked receipt, buttons → outcome + Undo; the headline stays.
  const undo = { ...BASE, r: ['a'], k: 'M1|mouser', t: 1 };
  const settled = settleCard(reply.blocks, 0, 'done', [rows[0]!], undo);
  assert.deepEqual(settled.map((b) => b.block_id), ['arrival_head:0', 'arrival_list:0', 'arrival_note:0', 'arrival_done:0']);
  assert.match(settled[1].text.text, /<https:\/\/notion\.so\/r1\|Bus Transceivers Single 8-bit> `SN74LVC245APWR` ×2/);
  assert.equal(settled[3].elements[0].action_id, 'arrival_undo');
  assert.deepEqual(settleCard(reply.blocks, 0, 'nope').map((b) => b.block_id), ['arrival_head:0', 'arrival_note:0']);

  // "Other orders…" swaps just this card.
  const swapped = replaceCard([{ type: 'divider' }, ...reply.blocks], 0, [{ type: 'section', block_id: 'arrival_head:0' }]);
  assert.deepEqual(swapped.map((b) => b.block_id ?? b.type), ['divider', 'arrival_head:0']);
});

test('who + DMs: mentions where known, first names otherwise; DM lists the requester’s items and lead time', () => {
  const people = new Map([['Mike Song', 'U_MIKE']]);
  assert.equal(who(['Mike Song', 'Ana Li', 'Bo Chen'], people), '<@U_MIKE>, *Ana* +1');
  assert.equal(who([], people), '');
  const r = row({ partNumber: 'A12-ND', name: 'Hall sensor', vendor: 'DigiKey', url: 'https://notion.so/x', quantity: 4 });
  const dm = arrivalDm([r], { clicker: 'U_C', poster: 'U_P', permalink: 'https://slack/p', arrivedAtIso: '2026-10-10T16:00:00.000Z' });
  assert.match(dm, /^:package: Your \*DigiKey\* order is here — 1 item received by <@U_P> \(confirmed by <@U_C>\):/);
  assert.match(dm, /<https:\/\/notion\.so\/x\|Hall sensor> `A12-ND` ×4/);
  assert.match(dm, /12 days/);
  assert.match(dm, /<https:\/\/slack\/p\|See the photo in #packages>/);
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

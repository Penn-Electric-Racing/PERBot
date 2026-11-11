import json
import re
from datetime import datetime, timezone

from perbot.arrivals.blocks import (
    ReplyContext,
    arrival_dm,
    build_reply,
    guess_card,
    replace_card,
    row_detail,
    settle_card,
    text_names_vendor,
    who,
)
from perbot.arrivals.models import Resolution, Scan
from perbot.arrivals.orders import addressee_matches, eligible_rows, group_orders, orders_for_vendor, rank_orders
from perbot.arrivals.pick import Pick, build_pick_prompt, ground_picks, is_generic, parse_picks, stem
from perbot.arrivals.resolve import resolve_package, resolve_scan
from perbot.arrivals.slack import thread_orders

from .helpers import BASE, line, pkg, row

OCT10 = datetime(2026, 10, 10, 16, 0, tzinfo=timezone.utc)


def no_pick(_p, _orders, _text):
    return []


def ctx(**o):
    return ReplyContext(u=BASE['u'], ts=BASE['ts'], **{'in_thread': False, **o})


def dumps(blocks):
    return json.dumps(blocks, ensure_ascii=False)


def block(blocks, block_id):
    return next(b for b in blocks if b.get('block_id') == block_id)


def test_eligible_rows_ordered_not_arrived_requested_before_the_photo():
    ok = row('A')
    draft = row('B', exported=False)
    arrived = row('C', arrived='Yes')
    later = row('D', submitted_at='2026-10-12')
    assert [r.part_number for r in eligible_rows([ok, draft, arrived, later], OCT10)] == ['A']


def test_group_orders_by_run_id_else_vendor_and_request_day():
    orders = group_orders([
        row('A', run_id='BENBUYS-1'),
        row('B', run_id='BENBUYS-1'),
        row('C', vendor='Amazon', submitted_at='2026-09-02T10:00:00Z'),
        row('D', vendor='amazon', submitted_at='2026-09-02T18:00:00Z'),
        row('E', vendor='Amazon', submitted_at='2026-09-05'),
    ])
    assert [(o.key, len(o.rows)) for o in orders] == [('BENBUYS-1|digikey', 2), ('2026-09-02|amazon', 2), ('2026-09-05|amazon', 1)]
    assert orders[0].run_id == 'BENBUYS-1'


def test_orders_for_vendor_addressee_matches_rank_orders():
    orders = group_orders([
        row('A', run_id='R-OLD', ordered_at='2026-08-01'),
        row('B', run_id='R-NEAR', ordered_at='2026-09-25'),
        row('C', run_id='R-AFTER', ordered_at='2026-10-05'),
        row('D', run_id='R-KATH', ordered_at='2026-07-01', point_of_contact=['Katherine Shen']),
        row('E', run_id='MC', vendor='McMaster-Carr', link=''),
    ])
    assert len(orders_for_vendor(orders, 'Digi-Key')) == 4
    assert len(orders_for_vendor(orders, None)) == 0
    assert addressee_matches('KATHERINE SHEN', ['Katherine Shen'])
    assert not addressee_matches('University of Pennsylvania', ['Katherine Shen'])
    dk = orders_for_vendor(orders, 'DigiKey')
    # Shipped Sep 28: the addressee's order first, then the one ordered just before shipping; one ordered after shipping last.
    shipped = pkg([], ship_date='2026-09-28', addressee='KATHERINE SHEN')
    assert [o.run_id for o in rank_orders(dk, shipped, OCT10)] == ['R-KATH', 'R-NEAR', 'R-OLD', 'R-AFTER']
    # No ship date: the order placed just before the photo comes first (next-day shipping).
    assert [o.run_id for o in rank_orders(dk, pkg([]), OCT10)] == ['R-AFTER', 'R-NEAR', 'R-OLD', 'R-KATH']


def test_pick_prompt_uses_handles_only_answers_are_validated_against_what_was_offered():
    orders = group_orders([
        row('TUBE-1', name='Clear PVC tubing 3/8"', run_id='R1', vendor='McMaster-Carr'),
        row('BRKT', name='Bracket stock', run_id='R2', vendor='McMaster-Carr'),
    ])
    built = build_pick_prompt(pkg([], vendor='McMaster-Carr', item_hints=['cooling tube']), orders, '@Elijah cooling tube is here')
    assert re.search('O1: McMaster-Carr', built.prompt)
    assert re.search('R1: Clear PVC tubing', built.prompt)
    assert not re.search(r'page-\d|notion\.so', built.prompt)

    picks = parse_picks(
        {
            'picks': [
                {'order': 'O1', 'rows': ['R1', 'R2', 'R99'], 'confidence': 'high', 'evidence': 'cooling tube ≈ PVC tubing'},
                {'order': 'O1', 'rows': [], 'confidence': 'high', 'evidence': 'dupe'},
                {'order': 'O7', 'rows': [], 'confidence': 'high', 'evidence': 'unknown order'},
                {'order': 'O2', 'rows': [], 'confidence': 'medium', 'evidence': 'bracket stock'},
                {'order': 'O2', 'rows': [], 'confidence': 'none', 'evidence': 'x'},
            ]
        },
        built,
    )
    assert [(p.order.key, [r.part_number for r in p.rows]) for p in picks] == [
        ('R1|mcmaster', ['TUBE-1']),  # R2 belongs to O2, R99 doesn't exist
        ('R2|mcmaster', ['BRKT']),  # no rows named → the whole order
    ]
    assert parse_picks({'picks': 'nope'}, built) == []


def test_resolve_package_slip_match_wins_hints_go_to_the_picker_vendor_alone_pick_list_nothing_none():
    rows = [row('A-ND', run_id='BENBUYS-1'), row('TUBE', name='PVC tubing', run_id='MC-1', vendor='McMaster-Carr', link='')]
    strong = resolve_package(pkg([line('A-ND')]), rows, OCT10, '', no_pick)[0]
    assert strong.kind == 'match'

    offered = {'n': 0}

    def picker(_p, orders, _text):
        offered['n'] = len(orders)
        return [Pick(order=orders[0], rows=orders[0].rows, confidence='high', evidence='tube')]

    hinted = resolve_package(pkg([], vendor='McMaster-Carr', item_hints=['cooling tube']), rows, OCT10, 'cooling tube is here', picker)[0]
    assert offered['n'] == 1  # only McMaster orders offered
    assert hinted.kind == 'match' and hinted.evidence == 'tube'

    # A vendor with no open orders (a misread) still lets specific evidence search every order.
    resolve_package(pkg([], vendor='DHL', item_hints=['cooling tube']), rows, OCT10, '', picker)
    assert offered['n'] == 2

    label_only = resolve_package(pkg([], vendor='DigiKey'), rows, OCT10, 'Digikey here', no_pick)[0]
    assert label_only.kind == 'choose' and label_only.orders[0].key == 'BENBUYS-1|digikey'

    assert resolve_package(pkg([], vendor=None), rows, OCT10, '', no_pick)[0].kind == 'none'
    assert resolve_package(pkg([], vendor='Oshcut'), rows, OCT10, '', no_pick)[0].kind == 'none'


def scan(scene, packages=None, legible=True):
    return Scan(scene=scene, legible=legible, packages=packages if packages is not None else [pkg([], vendor='DigiKey')])


def test_build_reply_policy_silent_for_non_deliveries_and_unresolved_thread_photos_one_nudge_for_a_top_level_label():
    rows = [row('A-ND', run_id='BENBUYS-1', point_of_contact=['Mike Song'])]
    top = ctx(in_thread=False)
    thread = ctx(in_thread=True)

    assert build_reply(scan('not_a_delivery', []), [], top) is None

    # Vendor-only label: pick-list at top level, silence in a thread.
    label = scan('shipping_label')
    res = resolve_scan(label, rows, OCT10, 'Digikey here', no_pick)
    choose = build_reply(label, res, top)
    assert re.search(r'one open DigiKey order \(\*Mike\*’s\) from \*Sep 28\*', dumps(choose.blocks))
    assert block(choose.blocks, 'arrival_actions:0')['elements'][0]['action_id'] == 'arrival_mark'
    assert build_reply(label, res, thread) is None

    # Contents photo with nothing to go on: silent even at top level.
    contents = scan('contents', [pkg([], vendor=None)])
    assert build_reply(contents, resolve_scan(contents, rows, OCT10, '', no_pick), top) is None

    # Unreadable label at top level → one nudge; in a thread → silent.
    blurry = scan('shipping_label', [pkg([], vendor=None)], False)
    blurry_res = resolve_scan(blurry, rows, OCT10, '', no_pick)
    assert re.search('couldn’t read the label.*packing slip', dumps(build_reply(blurry, blurry_res, top).blocks))
    assert build_reply(blurry, blurry_res, thread) is None


def test_build_reply_specific_matches_reply_even_in_threads_a_pile_photo_gets_matches_but_no_pick_lists():
    rows = [
        row('A-ND', run_id='BENBUYS-1', point_of_contact=['Sofia Ramirez'], unit_cost=123.45, name='Hall sensor'),
        row('B-ND', run_id='BENBUYS-1', point_of_contact=['Sofia Ramirez'], unit_cost=9.99),
        row('TUBE', name='PVC tubing', run_id='MC-1', vendor='McMaster-Carr', link=''),
        row('NUT', name='Hex nuts', run_id='MC-2', vendor='McMaster-Carr', link=''),
    ]

    def tube_picker(_p, orders, _text):
        o = next((x for x in orders if x.run_id == 'MC-1'), None)
        return [Pick(order=o, rows=o.rows, confidence='high', evidence='message says cooling tube')] if o else []

    pile = scan(
        'several_packages',
        [pkg([line('A-ND')]), pkg([], vendor='McMaster-Carr', item_hints=['cooling tube']), pkg([], vendor='McMaster-Carr')],
    )
    res = resolve_scan(pile, rows, OCT10, 'cooling tube is here', tube_picker)
    assert [(r.pkg, r.kind) for r in res] == [(0, 'match'), (1, 'match'), (2, 'choose')]

    reply = build_reply(pile, res, ctx(in_thread=False))
    j = dumps(reply.blocks)
    assert '2 orders in this photo' in j
    assert re.search(r"\*Sofia\*'s \*DigiKey\* order from \*Sep 28\*", j)
    assert re.search(r'Probably the \*McMaster-Carr\* order', j)
    assert ':mag: Why: message says cooling tube' in j
    assert ':mag: Why: part numbers on the slip match this order' in j
    assert not re.search(r'123\.45|9\.99|\$|Which order', j)
    action_blocks = [b for b in reply.blocks if (b.get('block_id') or '').startswith('arrival_actions:')]
    assert [b['block_id'] for b in action_blocks] == ['arrival_actions:0', 'arrival_actions:1']
    assert [(e.get('text') or {}).get('text') or e['type'] for e in action_blocks[0]['elements']] == ['Mark arrived', 'Wrong order']
    # The slip showed A-ND only: it's ticked, its order-mate B-ND is listed unticked.
    boxes = block(reply.blocks, 'arrival_items:0')['elements'][0]
    assert len(boxes['options']) == 2
    assert boxes['options'][0]['text']['text'] == 'Hall sensor ×1'
    assert [o['text']['text'] for o in boxes['initial_options']] == ['Hall sensor ×1']

    in_thread = build_reply(pile, res, ctx(in_thread=True))
    assert len([b for b in in_thread.blocks if (b.get('block_id') or '').startswith('arrival_actions:')]) == 2


def test_build_reply_one_order_pick_list_reads_naturally_mixed_vendor_pefs_runs_never_go_by_run_id():
    rows = [
        row('TUBE', name='Firewall tube', run_id='PERPO-1', vendor='mcmaster', link='', point_of_contact=[]),
        row('SWAB', name='Cotton swabs', run_id='PERPO-1', vendor='Amazon', link=''),
    ]
    label = scan('shipping_label', [pkg([], vendor='McMASTER-CARR')])
    res = resolve_scan(label, rows, OCT10, '', no_pick)
    reply = build_reply(label, res, ctx(in_thread=False))
    j = dumps(reply.blocks)
    assert re.search(r'A \*McMaster-Carr\* package\. There’s one open McMaster-Carr order from \*Sep 28\*\. Is it this one\?', j)
    assert [e['text']['text'] for e in block(reply.blocks, 'arrival_actions:0')['elements']] == ['Mark arrived', 'Wrong order']
    # PERPO-1 also holds the Amazon row: only the McMaster row is offered.
    assert [o['text']['text'] for o in block(reply.blocks, 'arrival_items:0')['elements'][0]['options']] == ['Firewall tube ×1']


def _pick(o):
    return Pick(order=o, rows=o.rows, confidence='high', evidence='')


def test_ground_picks_a_picked_row_must_share_a_word_stem_with_the_package_evidence():
    swabs, tubing = group_orders([
        row('B07', name='1200pcs Precision Tip Cotton Swabs', run_id='A1', vendor='Amazon'),
        row('TUBE', name='DERNORD 3/8" ID PVC Tubing for Cooling', run_id='A2', vendor='Amazon'),
    ])
    assert ground_picks([_pick(swabs)], pkg([], item_hints=['busbar pins', 'buds'])) == []
    assert len(ground_picks([_pick(tubing)], pkg([], item_hints=['cooling tube']))) == 1
    assert len(ground_picks([_pick(tubing)], pkg([line('X', 1, description='clear tubing 10ft')]))) == 1
    assert [stem(w) for w in ['soldering', 'solder', 'wiring', 'wire', 'tubes', 'bus']] == ['sold', 'sold', 'wir', 'wir', 'tub', 'bus']

    # Backtest run 2: "PCBs (JLCPCB)" grounded "JLCPCB Order 1" through the vendor's own name.
    (jlc,) = group_orders([row('JLC', name='JLCPCB Order 1', run_id='J1', vendor='JLCPCB', link='')])
    assert ground_picks([_pick(jlc)], pkg([], vendor='JLCPCB', item_hints=['PCBs (JLCPCB)'])) == []


def test_pile_photos_a_pick_list_only_when_the_message_names_the_vendor_once_per_vendor():
    rows = [row('PCB', name='Minion Test Board', run_id='J1', vendor='JLCPCB', link='')]
    pile = scan('several_packages', [pkg([], vendor='JLCPCB'), pkg([], vendor='JLCPCB')])
    res = resolve_scan(pile, rows, OCT10, 'Jlc picked up', no_pick)
    assert text_names_vendor('Jlc picked up', 'JLCPCB')
    assert not text_names_vendor('picked up', 'JLCPCB')
    named = build_reply(pile, res, ctx(in_thread=False, text='Jlc picked up'))
    assert len([b for b in named.blocks if (b.get('block_id') or '').startswith('arrival_actions:')]) == 1
    assert build_reply(pile, res, ctx(in_thread=False, text='')) is None


def test_guess_card_top_order_with_requesters_named_nothing_pre_ticked_the_rest_in_a_select_settle_and_swap():
    rows = [
        row('SN74LVC245APWR', name='Bus Transceivers Single 8-bit', run_id='M1', vendor='Mouser',
            point_of_contact=['Mike Song', 'Ana Li'], url='https://notion.so/r1', quantity=2),
        *[row(f'{pn}-X1', name=f'Cap {pn}', run_id='M1', vendor='Mouser', point_of_contact=['Mike Song']) for pn in ['A1', 'A2', 'A3', 'A4', 'A5']],
        row('HV-PLUG-2', name='Secondary HVDC Plug', run_id='M2', vendor='Mouser', point_of_contact=[],
            url='https://notion.so/r2', ordered_at='2026-09-20T15:00:00.000Z'),
    ]
    people = {'Mike Song': 'U_MIKE'}
    label = scan('shipping_label', [pkg([], vendor='Mouser Electronics')])
    reply = build_reply(label, resolve_scan(label, rows, OCT10, 'mouser here', no_pick), ctx(in_thread=False, people=people))

    head = block(reply.blocks, 'arrival_head:0')['text']['text']
    assert head == ':package: A *Mouser* package. Best guess: *Mike* and *Ana*’s order from *Sep 28* — tick what’s actually in the box.'
    assert re.search(r'only the vendor matched — 2 open Mouser orders.*\n.*@PERBot', block(reply.blocks, 'arrival_why:0')['elements'][0]['text'], re.S)
    boxes = block(reply.blocks, 'arrival_items:0')['elements'][0]
    assert len(boxes['options']) == 6
    assert 'initial_options' not in boxes
    assert boxes['options'][0]['text'] == {'type': 'mrkdwn', 'text': 'Bus Transceivers Single 8-bit `SN74LVC245APWR` ×2'}
    # Links can't be clicked inside a checkbox option, so they sit on a line of their own under the boxes.
    assert all('description' not in o for o in boxes['options'])
    links = block(reply.blocks, 'arrival_links:0')['elements'][0]['text'].split('\n')
    assert len(links) == 6
    assert re.fullmatch(r'`SN74LVC245APWR`  <https://notion\.so/r1\|Notion> · <https?://[^|]+\|Mouser ↗>', links[0])
    # A long app.notion.com URL falls back to the short notion.so/<id> form.
    long = row('X1', id='3f0560bc-c039-8185-9ee4-e08d9394ffaa', url=f"https://app.notion.com/p/{'x' * 80}", link='')
    long_card = build_reply(
        scan('shipping_label', [pkg([], vendor='DigiKey')]),
        [Resolution(kind='choose', pkg=0, orders=group_orders([long]), vendor='DigiKey')],
        ctx(in_thread=False),
    )
    assert block(long_card.blocks, 'arrival_links:0')['elements'][0]['text'] == '`X1`  <https://notion.so/3f0560bcc03981859ee4e08d9394ffaa|Notion>'
    assert all(len(o['text']['text']) <= 75 for o in boxes['options'])
    # A Notion page pasted in as the product link isn't a product page.
    pasted = row('X2', url='https://notion.so/r9', link='https://app.notion.com/p/penn-electric-racing/abc')
    pasted_card = build_reply(
        scan('shipping_label', [pkg([], vendor='DigiKey')]),
        [Resolution(kind='choose', pkg=0, orders=group_orders([pasted]), vendor='DigiKey')],
        ctx(in_thread=False),
    )
    assert block(pasted_card.blocks, 'arrival_links:0')['elements'][0]['text'] == '`X2`  <https://notion.so/r9|Notion>'

    actions = block(reply.blocks, 'arrival_actions:0')['elements']
    assert [(e.get('text') or e['placeholder'])['text'] for e in actions] == ['Mark arrived', 'Wrong order', 'Other Mouser orders (1)…']
    assert [(o['text']['text'], o['value']) for o in actions[2]['options']] == [('No contact · Sep 20 · 1 item · Secondary HVDC Plug', 'M2|mouser')]
    assert json.loads(actions[0]['value'])['k'] == 'M1|mouser'

    # Marked: checkboxes → linked receipt, buttons → outcome + Undo; the headline stays.
    undo = {**BASE, 'r': ['a'], 'k': 'M1|mouser', 't': 1}
    settled = settle_card(reply.blocks, 0, 'done', [rows[0]], undo)
    assert [b.get('block_id') for b in settled] == ['arrival_head:0', 'arrival_list:0', 'arrival_note:0', 'arrival_done:0']
    assert re.search(r'<https://notion\.so/r1\|Bus Transceivers Single 8-bit> `SN74LVC245APWR` ×2', settled[1]['text']['text'])
    assert settled[3]['elements'][0]['action_id'] == 'arrival_undo'
    assert [b.get('block_id') for b in settle_card(reply.blocks, 0, 'nope')] == ['arrival_head:0', 'arrival_note:0']

    # "Other orders…" swaps just this card.
    swapped = replace_card([{'type': 'divider'}, *reply.blocks], 0, [{'type': 'section', 'block_id': 'arrival_head:0'}])
    assert [b.get('block_id') or b['type'] for b in swapped] == ['divider', 'arrival_head:0']


def test_who_and_dms_mentions_where_known_first_names_otherwise_dm_lists_the_requesters_items_and_lead_time():
    people = {'Mike Song': 'U_MIKE'}
    assert who(['Mike Song', 'Ana Li', 'Bo Chen'], people) == '<@U_MIKE>, *Ana* and *Bo*'
    assert who(['Mike Song', 'Ana Li', 'Bo Chen'], None) == '*Mike*, *Ana* and *Bo*'
    assert who(['A A', 'B B', 'C C', 'D D', 'E E', 'F F']) == '*A*, *B*, *C*, *D* and 2 others'
    assert who([], people) == ''
    r = row('A12-ND', name='Hall sensor', vendor='DigiKey', url='https://notion.so/x', quantity=4)
    dm = arrival_dm([r], clicker='U_C', poster='U_P', permalink='https://slack/p', arrived_at_iso='2026-10-10T16:00:00.000Z')
    assert re.match(r'^:package: Your \*DigiKey\* order is here — 1 item received by <@U_P> \(confirmed by <@U_C>\):', dm)
    assert re.search(r'<https://notion\.so/x\|Hall sensor> `A12-ND` ×4', dm)
    assert '12 days' in dm
    assert '<https://slack/p|See the photo in #packages>' in dm


def test_pile_photos_the_messages_items_reach_every_package():
    rows = [
        row('LDO-1', name='LDO regulator', run_id='M1', vendor='Mouser'),
        row('B0FIT', name='Push-to-connect cooling fittings 3/8"', run_id='A1', vendor='Amazon', link=''),
    ]
    seen_hints = []

    def picker(p, orders, _text):
        seen_hints.append(p.item_hints)
        o = next((x for x in orders if x.run_id == 'A1'), None)
        return [Pick(order=o, rows=o.rows, confidence='high', evidence='cooling fittings')] if o else []

    pile = scan('several_packages', [pkg([], vendor='Mouser', item_hints=['cooling fittings']), pkg([], vendor='Amazon')])
    res = resolve_scan(pile, rows, OCT10, 'mouser parts and cooling fittings', picker)
    assert seen_hints == [['cooling fittings'], ['cooling fittings']]
    assert [(r.pkg, r.kind) for r in res] == [(0, 'choose'), (1, 'match')]


def test_ground_picks_a_hint_grounds_on_its_head_noun_not_on_an_adjective_it_shares():
    fitting, tubing = group_orders([
        row('B0T', name='Cooling T-Fitting for Temp Sensor', run_id='A1', vendor='Amazon'),
        row('B0P', name='DERNORD 3/8" ID PVC Tubing for Cooling', run_id='A2', vendor='Amazon'),
    ])
    hints = pkg([], vendor='Amazon', item_hints=['mouser parts', 'cooling fittings or something'])
    assert [p.order.key for p in ground_picks([_pick(fitting), _pick(tubing)], hints)] == [fitting.key]


def test_ground_picks_once_an_order_is_grounded_a_shared_modifier_brings_its_sibling_rows_along():
    (mc,) = group_orders([
        row('flange 8 feet', name='primary flange', run_id='MC', vendor='mcmaster', link=''),
        row('4130 tube', name='welded insert stock', run_id='MC', vendor='mcmaster', link=''),
    ])
    hints = pkg([], vendor='McMaster-Carr', item_hints=['primary bracket stock', 'welded inserts stock'])
    (p,) = ground_picks([Pick(order=mc, rows=[mc.rows[1]], confidence='high', evidence='')], hints)
    assert sorted(r.name for r in p.rows) == ['primary flange', 'welded insert stock']


def test_ground_picks_a_word_the_picked_row_already_explains_does_not_drag_in_siblings():
    (amz,) = group_orders([
        row('B0T', name='Cooling T-Fitting for Temp Sensor', run_id='A1', vendor='Amazon'),
        row('B0F', name='12V Cooling Fans', run_id='A1', vendor='Amazon'),
    ])
    (p,) = ground_picks([Pick(order=amz, rows=[amz.rows[0]], confidence='high', evidence='')], pkg([], vendor='Amazon', item_hints=['cooling fittings']))
    assert [r.name for r in p.rows] == ['Cooling T-Fitting for Temp Sensor']


# --- #packages feedback, Oct 2026 ------------------------------------------------------------------

OCT19 = datetime(2026, 10, 19, 16, 45, tzinfo=timezone.utc)


def test_stale_orders_never_guessed_on_vendor_alone_ranked_after_fresh_ones_gone_past_90_days():
    rows = [
        row('OLD1', name='Zip ties', vendor='Amazon', link='', submitted_at='2026-08-28', ordered_at='2026-08-29'),
        row('OLD2', name='Hose clamps', vendor='Amazon', link='', submitted_at='2026-09-02', ordered_at='2026-09-03', point_of_contact=['Elijah Jeoung']),
        row('ANCIENT', name='Gloves', vendor='Amazon', link='', submitted_at='2026-06-01', ordered_at='2026-06-02'),
    ]
    label = scan('shipping_label', [pkg([], vendor='Amazon')])
    assert [r.kind for r in resolve_scan(label, rows, OCT19, 'this has been here for a week', no_pick)] == ['none']
    assert [r.part_number for r in eligible_rows(rows, OCT19)] == ['OLD1', 'OLD2']
    # A fresh order is guessed first; stale ones stay reachable as alternatives, last.
    fresh = row('NEW', name='Paint brushes', vendor='Amazon', link='', submitted_at='2026-10-13', ordered_at='2026-10-14')
    res = resolve_scan(label, [*rows, fresh], OCT19, '', no_pick)
    assert res[0].kind == 'choose'
    assert [o.rows[0].part_number for o in res[0].orders] == ['NEW']
    ranked = rank_orders(group_orders(eligible_rows([*rows, fresh], OCT19)), pkg([], vendor='Amazon'), OCT19)
    assert [o.rows[0].part_number for o in ranked] == ['NEW', 'OLD2', 'OLD1']


def test_generic_rows_do_not_ground_and_the_guess_shows_whats_inside_and_ticks_nothing():
    boards = row('JLCPCB', name='JLCPCB Boards', run_id='PERPO-9', vendor='JLCPCB', link='https://cart.jlcpcb.com/shopcart/cart',
                 sanitized_description='Order everything in the shared cart $412.20', ordered_at='2026-10-01')
    pdu = row('REV12PDUFixedY475', name='REV12PDUFixedY475', run_id='PERPO-10', vendor='JLCPCB', link='', ordered_at='2026-10-07')
    assert is_generic(boards)
    assert not is_generic(pdu)
    (order,) = group_orders([boards])
    assert ground_picks([_pick(order)], pkg([], vendor='JLCPCB', item_hints=['PCM board', 'Dash board', 'BMS board', 'boards'])) == []

    one = build_reply(
        scan('contents', [pkg([], vendor='JLCPCB')]),
        [Resolution(kind='choose', pkg=0, orders=[order], vendor='JLCPCB')],
        ctx(in_thread=False),
    )
    assert 'initial_options' not in block(one.blocks, 'arrival_items:0')['elements'][0]
    links = block(one.blocks, 'arrival_links:0')['elements'][0]['text']
    assert re.search(r'— _Order everything in the shared cart_$', links)
    assert '412' not in links
    assert 'These items don’t say what’s inside' in dumps(one.blocks)


def test_wrong_order_the_button_carries_the_cards_order_and_every_rejection():
    rows = [
        row('P1', name='Gasket', run_id='MC-1', vendor='McMaster-Carr', link='', ordered_at='2026-10-15'),
        row('P2', name='Weld nut', run_id='MC-2', vendor='McMaster-Carr', link='', ordered_at='2026-10-14'),
        row('P3', name='Rod stock', run_id='MC-3', vendor='McMaster-Carr', link='', ordered_at='2026-10-10'),
    ]
    label = scan('shipping_label', [pkg([], vendor='McMaster-Carr')])
    res = resolve_scan(label, rows, OCT19, '', no_pick, {'MC-1|mcmaster'})
    assert [o.key for o in res[0].orders] == ['MC-2|mcmaster', 'MC-3|mcmaster']

    reply = build_reply(label, res, ctx(in_thread=False, rejected=['MC-1|mcmaster']))
    actions = block(reply.blocks, 'arrival_actions:0')['elements']
    wrong = json.loads(next(e for e in actions if e.get('action_id') == 'arrival_wrong')['value'])
    assert wrong['k'] == 'MC-2|mcmaster'
    assert wrong['n'] == ['MC-1|mcmaster']
    assert [o['value'] for o in next(e for e in actions if e.get('action_id') == 'arrival_other')['options']] == ['MC-3|mcmaster']

    # Swapped in after a rejection: the note is its own line, above the headline.
    (mc3,) = group_orders([rows[2]])
    swapped = guess_card(0, mc3, [], 'McMaster-Carr', BASE, '✗ <@U_T>: not that one — nothing was written. ', ['MC-1|mcmaster', 'MC-2|mcmaster'])
    assert re.match(r'^✗ <@U_T>: not that one — nothing was written\.\n:package: A \*McMaster-Carr\* package\.', swapped[0]['text']['text'])


def test_thread_orders_what_perbots_cards_in_a_thread_already_cover():
    rows = [row('BRKT', name='primary brackets', run_id='X-1', vendor='Xometry', link='')]
    label = scan('contents', [pkg([], vendor='Xometry')])
    card = build_reply(label, resolve_scan(label, rows, OCT10, '', no_pick), ctx(in_thread=False, rejected=['X-0|xometry']))
    thread = [
        {'ts': '1', 'user': 'U_T', 'text': 'brackets'},
        {'ts': '2', 'bot_id': 'B_PER', 'blocks': card.blocks},
        {'ts': '3', 'bot_id': 'B_OTHER', 'blocks': card.blocks},
    ]
    carded, rejected = thread_orders(thread, 'B_PER', ['X-9|xometry'])
    assert carded == {'X-1|xometry'}
    assert sorted(rejected) == ['X-0|xometry', 'X-9|xometry']
    assert len(thread_orders(thread, None)[0]) == 0


def test_corrections_may_get_a_vendor_guess_even_in_a_thread_and_a_clear_no_match_line():
    rows = [row('FIT', name='Barb fittings', run_id='A-1', vendor='Amazon', link='', ordered_at='2026-10-12', point_of_contact=['Elijah Jeoung'])]
    photo = scan('shipping_label', [pkg([], vendor='Amazon', item_hints=['cooling fittings'])])
    res = resolve_scan(photo, rows, OCT19, 'no, elijah cooling fittings are in this picture', no_pick)
    assert build_reply(photo, res, ctx(in_thread=True)) is None
    assert any(b.get('block_id') == 'arrival_actions:0' for b in build_reply(photo, res, ctx(in_thread=True, correction=True)).blocks)

    gasket = scan('contents', [pkg([], vendor=None, item_hints=['gasket'])])
    none = build_reply(gasket, [Resolution(kind='none', pkg=0)], ctx(in_thread=True, correction=True))
    assert re.search('couldn’t find an open order with “gasket” in it\\. It may not be in Purchasing', none.blocks[0]['text']['text'])
    top = build_reply(scan('shipping_label', [pkg([], vendor=None, item_hints=['gasket'])]), [Resolution(kind='none', pkg=0)], ctx(in_thread=False))
    assert re.search(r'with “gasket” in it — it may not be in Purchasing yet\..*@PERBot', top.blocks[0]['text']['text'])


def test_row_detail_the_vendor_facing_description_never_a_price_nothing_when_it_just_repeats_the_name():
    assert row_detail(row('X', name='Boards', sanitized_description='Boards')) is None
    assert row_detail(row('X', name='Boards', sanitized_description='BMS and Dash $ 1,204.50 total')) == 'BMS and Dash total'

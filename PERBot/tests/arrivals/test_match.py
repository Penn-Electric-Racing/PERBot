from perbot.arrivals.blocks import decode_value, encode_value, lead_time_line, package_key, settle_blocks, target_ids, these_value
from perbot.arrivals.extract import parse_scan
from perbot.arrivals.match import match_slip, part_codes, vendor_key
from perbot.arrivals.models import OrderNumber

from .helpers import BASE, line, pkg, row


def test_vendor_key_spellings_collapse_unaliased_vendors_key_on_their_first_word():
    assert vendor_key('McMaster-Carr Supply Co.') == 'mcmaster'
    assert vendor_key('mcmaster carr') == 'mcmaster'
    assert vendor_key('www.mcmaster.com') == 'mcmaster'
    assert vendor_key('Digi-Key Electronics') == 'digikey'
    assert vendor_key('JLCCNC') == 'jlcpcb'
    assert vendor_key('Eurotech Distributors, Inc.') == 'eurotech'
    assert vendor_key('eurotech direct') == 'eurotech'
    assert vendor_key(None) == ''


def test_match_slip_part_numbers_pick_the_order_whole_order_on_the_slip():
    a = row('A-ND', run_id='BENBUYS-4334609')
    b = row(' b-nd ', run_id='BENBUYS-4334609')
    other = row('C-ND', run_id='PERPO-1')
    m = match_slip(pkg([line('A-ND'), line('B-ND')]), [a, b, other])
    assert m.confidence == 'strong'
    assert m.run_id == 'BENBUYS-4334609'
    assert [r.id for r in m.matched_rows] == [a.id, b.id]
    assert [r.id for r in m.order_rows] == [a.id, b.id]


def test_match_slip_requisition_number_on_the_slip_is_an_exact_match_even_if_parts_differ():
    a = row('X-ND', run_id='BENBUYS-4334609')
    m = match_slip(pkg([line('ZZZ')], order_numbers=[OrderNumber('purchase_order', 'PO 4334609')]), [a])
    assert m.confidence == 'exact'
    assert len(m.matched_rows) == 0
    assert len(m.order_rows) == 1


def test_match_slip_never_crosses_vendors_manufacturer_number_and_customer_reference_also_match():
    mc = row('91251A540', vendor='McMaster-Carr')
    dk = row('LM358DR', vendor='digikey')
    ref = row('Q-ND', vendor='Digi-Key', sanitized_description='HALL SENSOR BOARD CONNECTOR 4 PIN')
    m = match_slip(
        pkg([
            line('91251A540'),
            line('296-1395-1-ND', 1, manufacturer_part_number='LM358DR'),
            line('OTHER-ND', 1, customer_reference='HALL SENSOR BOARD CONNEC'),
        ]),
        [mc, dk, ref],
    )
    assert [l.row.id if l.row else None for l in m.lines] == [None, dk.id, ref.id]


def test_match_slip_free_text_rows_match_on_a_shared_model_code():
    coroflex = row('5 meters of FHLR2GCB2G (3x2.5mm²)', vendor='Eurotech Direct', link='')
    plain = row('5 meters of 2x 6mm^2', vendor='eurotech direct', link='')
    digikey = row('FHLR2GCB2G', vendor='DigiKey')
    m = match_slip(
        pkg(
            [
                line('P500031', 5, description='Coroflex 9-2641 FHLR2GCB2G 3x2.5mm² ORG'),
                line('P500023', 5, description='Coroflex 9-2641 FHLR2GCB2G 2x6mm² ORG'),
            ],
            vendor='Eurotech Distributors, Inc.',
        ),
        [coroflex, plain, digikey],
    )
    assert [l.row.id if l.row else None for l in m.lines] == [coroflex.id, None]
    assert list(part_codes('3x2.5mm² 5888694 FHLR2GCB2G LM358DR')) == ['FHLR2GCB2G', 'LM358DR']


def test_match_slip_same_part_on_two_orders_dominant_order_then_quantity_then_oldest():
    old = row('R-ND', run_id='BENBUYS-1111111', ordered_at='2026-09-01', quantity=5)
    newer = row('R-ND', run_id='BENBUYS-2222222', ordered_at='2026-09-20', quantity=10)
    sibling = row('S-ND', run_id='BENBUYS-2222222')
    assert match_slip(pkg([line('R-ND', 5), line('S-ND')]), [old, newer, sibling]).lines[0].row.id == newer.id
    assert match_slip(pkg([line('R-ND', 10)]), [old, newer]).lines[0].row.id == newer.id
    assert match_slip(pkg([line('R-ND', None)]), [old, newer]).lines[0].row.id == old.id


def test_match_slip_backordered_lines_are_not_in_the_box_one_row_per_line_under_half_is_weak():
    a = row('A-ND')
    m = match_slip(pkg([line('A-ND', 0), line('A-ND', 2), line('A-ND', 2)]), [a])
    assert len(m.lines) == 2
    assert len(m.matched_rows) == 1
    assert match_slip(pkg([line('A-ND'), line('NOPE1'), line('NOPE2')]), [a]).confidence == 'weak'


def test_parse_scan_tolerates_junk_not_a_delivery_drops_packages_bad_dates_and_empty_lines_go():
    s = parse_scan({
        'scene': 'shipping_label',
        'legible': True,
        'packages': [
            {
                'vendor': '  DigiKey ',
                'addressee': 'KATHERINE SHEN',
                'ship_date': '28SEP26',
                'order_numbers': [{'kind': 'bogus', 'value': '123'}, {'kind': 'invoice', 'value': ''}],
                'tracking_numbers': ['1Z 999', 7],
                'lines': [{'vendor_part_number': 'A-ND', 'quantity_shipped': '3'}, {}],
                'item_hints': ['cooling tube', ''],
            }
        ],
    })
    p = s.packages[0]
    assert p.vendor == 'DigiKey'
    assert p.ship_date is None
    assert p.order_numbers == [OrderNumber('other', '123')]
    assert p.tracking_numbers == ['1Z 999']
    assert len(p.lines) == 1
    assert p.lines[0].quantity_shipped is None
    assert p.item_hints == ['cooling tube']
    hints = parse_scan({
        'scene': 'contents',
        'legible': True,
        'packages': [{'item_hints': ['cardboard poster/tube', 'DigiKey box', 'PCBs', 'PCBs (JLCPCB)', 'heat fins', 'steering rack']}],
    })
    assert hints.packages[0].item_hints == ['heat fins', 'steering rack']
    assert parse_scan({'scene': 'not_a_delivery', 'packages': [{'vendor': 'x'}]}).packages == []
    assert parse_scan(None).scene == 'not_a_delivery'


def test_these_value_picks_the_shorter_encoding_target_ids_resolves_both_the_same_way():
    order = [row(f'P{i}-ND', run_id='BENBUYS-4334609', id=f'0000000{i}-aaaa-bbbb-cccc-dddddddddddd') for i in range(60)]
    m = match_slip(pkg([line(r.part_number) for r in order[:58]]), order)
    v = these_value(m, BASE)
    assert v['g'] == 'BENBUYS-4334609'
    assert len(v['x']) == 2
    assert len(encode_value(v)) < 2000
    ids = target_ids(decode_value(encode_value(v)), [r.id for r in order])
    assert len(ids) == 58
    assert order[59].id.replace('-', '') not in ids
    sv = these_value(match_slip(pkg([line('P0-ND')]), order), BASE)
    assert 'g' not in sv
    assert target_ids(sv, []) == [order[0].id.replace('-', '')]


def test_lead_time_line_settle_blocks_one_package_only_package_key():
    r = row('A-ND', submitted_at='2026-09-20', ordered_at='2026-09-28T15:00:00.000Z')
    assert lead_time_line([r], '2026-10-10T16:00:00.000Z') == (
        'Ordered Sep 28 → here Oct 10 (*12 days*) · requested Sep 20 (*20 days* end to end)'
    )
    assert lead_time_line([row('A', submitted_at=None, ordered_at=None)], '2026-10-10T16:00:00.000Z') is None

    blocks = [{'type': 'section'}, {'type': 'actions', 'block_id': 'arrival_actions:0'}, {'type': 'actions', 'block_id': 'arrival_actions:1'}]
    assert [b['type'] for b in settle_blocks(blocks, 'arrival_actions:1', 'done')] == ['section', 'actions', 'context']

    assert package_key(pkg([], tracking_numbers=['1z 999 aa'])) == 'digikey:1Z999AA'
    assert package_key(pkg([])) is None

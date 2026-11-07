import os
import re
from pathlib import Path

from perbot.benbuys.prep import aggregate_rows, build_prep, format_prep, normalize_part_number, warnings_for
from perbot.benbuys.reference import clean_reference_text, truncate_at_word, truncate_reference

from .helpers import row, test_adapter


def test_normalize_part_number_trims_collapses_wrapped_whitespace_uppercases():
    # The "wrapped 399-…" part numbers from the PEFS view render with soft breaks.
    assert normalize_part_number('  399-C1206X223KDRACTUCT-ND ') == '399-C1206X223KDRACTUCT-ND'
    assert normalize_part_number('399-C0603C103K5RA\nCTUCT-ND') == '399-C0603C103K5RACTUCT-ND'
    assert normalize_part_number('399-c0603c220j5gactuct-nd') == '399-C0603C220J5GACTUCT-ND'
    assert normalize_part_number('505-LTC6820HMS#PBF-ND') == '505-LTC6820HMS#PBF-ND'
    assert normalize_part_number('296-LP38693SD-3.3/NOPBCT-ND') == '296-LP38693SD-3.3/NOPBCT-ND'
    assert normalize_part_number('MS1238E24B1+6-FHR-2EM') == 'MS1238E24B1+6-FHR-2EM'


def test_aggregate_rows_sums_quantities_across_rows_with_the_same_normalized_part_number():
    rows = [
        row('F2895CT-ND', quantity=4, unit_cost=1, sanitized_description='TVS DIODE 5.5VWM 13VC SC705'),
        row('f2895ct-nd ', quantity=8, unit_cost=1, sanitized_description='TVS DIODE 5.5VWM 13VC SC705'),
        row('BKCT3151-0-ND', quantity=2, unit_cost=2.55, sanitized_description='CONN BANANA JACK SOLDER BLACK'),
        row('BKCT3151-0-ND', quantity=10, unit_cost=2.55, sanitized_description='CONN BANANA JACK SOLDER BLACK', subsystems=['HV/Secondary']),
        row('732-4649-1-ND', quantity=3, unit_cost=0.23),
    ]
    lines = aggregate_rows(rows, test_adapter)
    assert [(l.part_number, l.quantity, l.line_total, len(l.rows)) for l in lines] == [
        ('F2895CT-ND', 12, 12, 2),
        ('BKCT3151-0-ND', 12, 30.6, 2),
        ('732-4649-1-ND', 3, 0.69, 1),
    ]
    assert lines[0].reference == 'TVS DIODE 5.5VWM 13VC SC705'


def test_aggregate_rows_skips_rows_with_an_empty_part_number_keeps_first_seen_order():
    lines = aggregate_rows([row('   '), row('B-ND'), row('A-ND')], test_adapter)
    assert [l.part_number for l in lines] == ['B-ND', 'A-ND']


def test_truncate_at_word_35_chars_at_a_word_boundary_no_ellipsis():
    assert truncate_at_word('CAP CER 0.022UF 1KV X7R 1206', 35) == 'CAP CER 0.022UF 1KV X7R 1206'
    assert (
        truncate_at_word('ARM® Cortex®-M7 STM32F7 Microcontroller IC 32-Bit 216MHz 1MB (1M x 8) FLASH 100-LQFP (14x14)', 35)
        == 'ARM® Cortex®-M7 STM32F7'
    )
    assert truncate_at_word('Fan Tubeaxial 12VDC Square - 120mm L x 120mm H Ball 271.1 CFM', 35) == 'Fan Tubeaxial 12VDC Square - 120mm'
    # Exactly at the boundary: keep the full word when the next char is a space.
    assert truncate_at_word('ABCDEFGHIJ ABCDEFGHIJ ABCDEFGHIJ AB DEF', 35) == 'ABCDEFGHIJ ABCDEFGHIJ ABCDEFGHIJ AB'
    # Mid-word at the boundary: back up to the previous space.
    assert truncate_at_word('ABCDEFGHIJ ABCDEFGHIJ ABCDEFGHIJ ABCDEF', 35) == 'ABCDEFGHIJ ABCDEFGHIJ ABCDEFGHIJ'
    # Short descriptions with too little signal are dropped so the caller can fall back.
    assert truncate_at_word('digikey', 35) == ''
    # A single 40-char token has no word boundary: hard-cut at 35 rather than drop it.
    assert truncate_at_word('A' * 40, 35) == 'A' * 35
    # A word boundary that would leave < 8 chars of signal → '' (caller falls back).
    assert truncate_at_word('ABCDEFG HIJKLMNOPQRSTUVWXYZ0123456789ABCDEF', 35) == ''


def test_clean_reference_text_commas_and_newlines_never_survive_into_a_cart_line():
    assert clean_reference_text('LEAD FREE, NO CLEAN\nFLUX  1L') == 'LEAD FREE NO CLEAN FLUX 1L'


def test_truncate_reference_falls_back_to_the_part_number_when_the_description_is_empty_or_too_short():
    assert truncate_reference('497-16630-ND', [row('497-16630-ND', sanitized_description='')], 35) == '497-16630-ND'
    assert truncate_reference('497-16630-ND', [row('497-16630-ND', sanitized_description='digikey')], 35) == '497-16630-ND'
    assert truncate_reference('X-ND', [row('X-ND', sanitized_description='ABCDEFG HIJKLMNOPQRSTUVWXYZ0123456789ABCDEF')], 35) == 'X-ND'


def test_truncate_reference_aggregated_rows_with_differing_descriptions_get_plus_n_and_stay_within_the_cap():
    rows = [
        row('P-ND', sanitized_description='RES 1.5K OHM 1% 1/10W 0603 THICK FILM'),
        row('P-ND', sanitized_description='RESISTOR 1.5K'),
        row('P-ND', sanitized_description='RES 1.5K OHM 1% 1/10W 0603 THICK FILM'),
    ]
    ref = truncate_reference('P-ND', rows, 35)
    assert ref == 'RES 1.5K OHM 1% 1/10W 0603 THICK +2'
    assert len(ref) == 35
    # Identical descriptions → no suffix.
    assert truncate_reference('P-ND', [rows[0], rows[2]], 35) == 'RES 1.5K OHM 1% 1/10W 0603 THICK'


def test_warnings_for_the_four_checks_none_of_which_exclude_a_row():
    rows = [
        row('CPF0603B47KE', quantity=5, unit_cost=0.23),  # no -ND
        row('MS1238E24B1+6-FHR-2EM', quantity=2, unit_cost=34.95, name='MS1238E24B1+6-FHR-2EM', sanitized_description='digikey'),
        row('732-4649-1-ND', quantity=3, unit_cost=0.23, order_batch='Order 1'),
        row('732-4649-1-ND', quantity=5, unit_cost=0.23, order_batch='Order 2'),
        row('473-836LFNC-1L-ND', quantity=3, unit_cost=49.19),  # 147.57 > 100
    ]
    lines = aggregate_rows(rows, test_adapter)
    assert len(lines) == 4
    assert [f'{w.part_number}: {w.message}' for w in warnings_for(lines, test_adapter)] == [
        'CPF0603B47KE: may be a manufacturer part number — DigiKey may pick different packaging',
        'MS1238E24B1+6-FHR-2EM: may be a manufacturer part number — DigiKey may pick different packaging',
        'MS1238E24B1+6-FHR-2EM: description looks like a part number',
        '732-4649-1-ND: aggregated across batches (Order 1, Order 2)',
        '473-836LFNC-1L-ND: high-value line ($147.57) — double-check quantity',
    ]


def test_build_prep_include_in_next_order_narrows_to_the_ticked_rows_only():
    ready = [row('A-ND', include_in_next_order=True), row('B-ND'), row('C-ND', include_in_next_order=True)]
    prep = build_prep(test_adapter, ready, [])
    assert prep.cherry_picked is True
    assert [l.part_number for l in prep.lines] == ['A-ND', 'C-ND']
    assert [r.part_number for r in prep.rows] == ['A-ND', 'C-ND']
    every = build_prep(test_adapter, [r.replace(include_in_next_order=False) for r in ready], [])
    assert every.cherry_picked is False
    assert len(every.lines) == 3


def test_build_prep_estimated_total_is_qty_times_unit_cost_rounded_to_cents():
    prep = build_prep(test_adapter, [row('A-ND', quantity=500, unit_cost=0.14502), row('B-ND', quantity=3, unit_cost=3.47)], [])
    assert prep.estimated_total == 82.92


def test_format_prep_zero_ready_rows_no_paste_block_not_ready_rows_still_listed():
    not_ready = [row('1727-7329-1-ND', unit_cost=0, readiness='❌ Missing fields', name='DIODE SCHOTTKY 20V 500MA SOD123')]
    blocks = format_prep(test_adapter, build_prep(test_adapter, [], not_ready), 500)
    assert blocks.cart == ''
    assert re.match(r'^No ready DigiKey rows to order\.', blocks.summary)
    assert re.search(
        r'Not ready \(fix in Notion\): 1 row — <https://notion\.so/page-\d+\|DIODE SCHOTTKY 20V 500MA SOD123>', blocks.summary
    )
    assert 'Next:' not in blocks.summary


SNAPSHOT = Path(__file__).parent / 'fixtures' / 'prep.snapshot.txt'


def test_format_prep_snapshot_of_the_three_blocks():
    ready = [
        row('399-C1206X223KDRACTUCT-ND', id='r1', url='https://notion.so/r1', quantity=10, unit_cost=0.434, sanitized_description='CAP CER 0.022UF 1KV X7R 1206', order_batch='Order 1'),
        row('399-C0603C103K5RACTUCT-ND', id='r2', url='https://notion.so/r2', quantity=8, unit_cost=0.16, sanitized_description='CAP CER 10000PF 50V X7R 0603', order_batch='Order 1'),
        row('725-S1-12-BDM-ND', id='r3', url='https://notion.so/r3', quantity=3, unit_cost=4.1, sanitized_description='RELAY REED 1 N/C 1.5KV 12V', order_batch='Order 1'),
        row('399-c1206x223kdractuct-nd', id='r4', url='https://notion.so/r4', quantity=6, unit_cost=0.434, sanitized_description='CAP CER 0.022UF 1KV X7R 1206', order_batch='Order 2'),
        row('497-16630-ND', id='r5', url='https://notion.so/r5', quantity=10, unit_cost=17.779, sanitized_description='ARM® Cortex®-M7 STM32F7 Microcontroller IC 32-Bit 216MHz 1MB (1M x 8) FLASH 100-LQFP (14x14)', order_batch=''),
        row('CRGP2010F1M0', id='r6', url='https://notion.so/r6', quantity=10, unit_cost=0.44, sanitized_description='RES 1M OHM 1% 1.25W 2010', order_batch='Order 2'),
    ]
    not_ready = [
        row('1727-7329-1-ND', id='n1', url='https://notion.so/n1', unit_cost=0, readiness='❌ Missing fields', name='DIODE SCHOTTKY 20V 500MA SOD123'),
        row('', id='n2', url='https://notion.so/n2', readiness='❌ Missing fields', name='Radiator | fans <TBD>'),
    ]
    blocks = format_prep(test_adapter, build_prep(test_adapter, ready, not_ready), 500)
    actual = f'--- cart ---\n{blocks.cart}\n--- ben ---\n{blocks.ben}\n--- summary ---\n{blocks.summary}\n'
    if os.environ.get('UPDATE_SNAPSHOTS'):
        SNAPSHOT.write_text(actual, encoding='utf-8')
    assert actual == SNAPSHOT.read_text(encoding='utf-8')

from types import SimpleNamespace as NS

from sponsorship.match import normalize_name, pick_by_name, pick_live_deal


def row(company: str) -> NS:
    return NS(company=company)


def test_normalize_name_case_and_punctuation_collapse():
    assert normalize_name('Jane  Street, Inc.') == 'jane street inc'
    assert normalize_name('SKF') == normalize_name('Skf')


def test_pick_by_name_exact_beats_substring():
    m = pick_by_name([row('Keye'), row('Hawkeyeind')], 'keye')
    assert m.kind == 'one' and m.row.company == 'Keye'


def test_pick_by_name_two_exact_hits_stay_ambiguous_and_list_only_those():
    m = pick_by_name([row('SKF'), row('Skf'), row('SKF Marine')], 'Skf')
    assert m.kind == 'many'
    assert [r.company for r in m.rows] == ['SKF', 'Skf']


def test_pick_by_name_single_substring_hit_taken_zero_is_none():
    m = pick_by_name([row('Jane Street Capital')], 'jane street')
    assert m.kind == 'one' and m.row.company == 'Jane Street Capital'
    assert pick_by_name([], 'x').kind == 'none'


def test_pick_by_name_several_substring_hits_ambiguous():
    assert pick_by_name([row('Altium'), row('Altium Designer')], 'alt').kind == 'many'


def test_pick_live_deal():
    won, live = NS(stage='Won'), NS(stage='Contacted')
    m = pick_live_deal([won, live])
    assert m.kind == 'one' and m.row is live
    assert pick_live_deal([live, NS(stage='In talks')]).kind == 'many'
    assert pick_live_deal([won, NS(stage='Lost')]).kind == 'many'
    assert pick_live_deal([]).kind == 'none'

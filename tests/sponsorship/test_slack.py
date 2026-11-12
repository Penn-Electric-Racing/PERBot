"""`/sponsor` parsing — the pieces most likely to drift in a port (regexes, number formatting)."""
from sponsorship.models import PipelineRow
from sponsorship.slack import (
    HEATMAP_AS_OF,
    HEATMAP_URL,
    compute_leaderboard,
    heatmap_text,
    parse_add,
    parse_email_arg,
    parse_log,
    parse_score,
    parse_stage,
    parse_won,
    unwrap_slack_links,
)


def test_heatmap_text_links_page_and_says_how_old():
    text = heatmap_text()
    assert f'<{HEATMAP_URL}|Sponsor heatmap>' in text
    assert HEATMAP_AS_OF in text


def test_unwrap_slack_links():
    assert unwrap_slack_links('<mailto:a@b.co|a@b.co> <https://x.com|x.com>') == 'a@b.co https://x.com'


def test_parse_add_structured_form():
    p = parse_add('jlcpcb.com for reduced-cost fab contact: Chloe Wang chloe@jlcpcb.com <@U123|arjun>')
    assert p.company == 'jlcpcb.com'
    assert p.known_ask == 'reduced-cost fab'
    assert p.contact_name == 'Chloe Wang'
    assert p.contact_email == 'chloe@jlcpcb.com'
    assert p.assignee_slack_ids == ['U123']


def test_parse_add_natural_phrasing_and_plain_handles():
    p = parse_add('Jane Street, DRI is @arjunsh contact is Stephanie, <mailto:s@jane.com|s@jane.com>')
    assert p.company == 'Jane Street'
    assert p.plain_handles == ['arjunsh']
    assert p.contact_email == 's@jane.com'
    assert p.contact_name == 'Stephanie'


def test_parse_won_plain_and_kind():
    w = parse_won('Jane Street $5,000 cash thanks Steph')
    assert (w.company, w.amount_usd, w.kind, w.note) == ('Jane Street', 5000, 'Cash donation', 'thanks Steph')
    assert parse_won('Altium 20k in-kind licenses').amount_usd == 20000
    assert parse_won('Altium nothing') is None


def test_parse_won_computed_discount():
    w = parse_won('Melasta 38% of $9000 cell discount')
    assert w.company == 'Melasta'
    assert w.amount_usd == 3420
    assert w.kind == 'Valued discount'
    assert w.computed == '38% of $9,000'
    assert parse_won('X 12.5% off 9k').computed == '12.5% of $9,000'


def test_parse_stage_log_score_email():
    assert parse_stage('Jane Street in talks') == ('Jane Street', 'In talks')
    assert parse_stage('Acme - Lost') == ('Acme', 'Lost')
    assert parse_stage('Acme') is None
    assert parse_log('Acme Corp - called, they’re interested') == ('Acme Corp', 'called, they’re interested')
    assert parse_score('JLCPCB contact:2 teams 3') == ('JLCPCB', {'contact_strength': 2, 'sponsors_other_teams': 3})
    assert parse_email_arg('Edgerton Gear for machining our gears') == ('Edgerton Gear', 'machining our gears')


def test_compute_leaderboard_co_credit_and_order():
    deals = [
        PipelineRow(id='a', stage='Won', received=5000, dri_user_ids=['u1', 'u2']),
        PipelineRow(id='b', stage='Contacted', dri_user_ids=['u2']),
        PipelineRow(id='c', stage='Lost', dri_user_ids=['u3']),
    ]
    rows = compute_leaderboard(deals, {'u1': 'Zed', 'u2': 'Amy', 'u3': 'Bo'})
    assert [(r.name, r.won_usd, r.won_count, r.active_count) for r in rows] == [
        ('Amy', 5000, 1, 1),
        ('Zed', 5000, 1, 0),
        ('Bo', 0, 0, 0),
    ]

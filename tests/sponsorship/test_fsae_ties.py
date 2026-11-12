import re
from types import SimpleNamespace as NS

from sponsorship.fsae_ties import FsaePerson, FsaeScan, Snippet, extract_snippets, find_team_page_links, format_fsae_evidence, verify_labels
from sponsorship.scoring import SponsorScores, rank_key

BIO = (
    'Our Leadership. Jane Doe, CTO. Jane joined Acme in 2019 after leading the powertrain group '
    "of Purdue's Formula SAE team for three seasons. Bob Roe, CEO, previously ran sales at Initech."
)


def test_find_team_page_links_keeps_same_site_team_pages_best_first():
    html = """
    <a href="/about">About</a>
    <a href="https://www.acme.com/company/leadership">Leadership</a>
    <a href="/products">Products</a>
    <a href="https://other.com/team">Partner team</a>
    <a href="/careers">Careers</a>
    <a href="/brochure-team.pdf">Team PDF</a>"""
    links = find_team_page_links(html, 'https://acme.com')
    assert links[0] == 'https://www.acme.com/company/leadership'
    assert 'https://acme.com/about' in links
    assert not any('other.com' in l or 'products' in l or l.endswith('.pdf') for l in links)
    assert links[-1] == 'https://acme.com/careers'


def test_extract_snippets_windows_each_mention_and_ignores_formula_e():
    assert extract_snippets('We sponsor a Formula E team and F1.', 'u') == []
    snips = extract_snippets(BIO, 'https://acme.com/team')
    assert len(snips) == 1
    assert 'Jane Doe' in snips[0].text
    # Two mentions close together merge into one window.
    assert len(extract_snippets('FSAE alum and Formula Student judge', 'u')) == 1


def test_verify_labels_keeps_only_verbatim_quotes_and_names():
    people, company_mentions = verify_labels(
        [Snippet('https://acme.com/team', BIO)],
        [
            {'snippet': 0, 'kind': 'person', 'person': 'Jane Doe', 'quote': "leading the powertrain group of Purdue's Formula SAE team"},
            {'snippet': 0, 'kind': 'person', 'person': 'John Smith', 'quote': "Purdue's Formula SAE team"},  # invented name
            {'snippet': 0, 'kind': 'person', 'person': 'Bob Roe', 'quote': 'Bob raced FSAE at MIT'},  # paraphrased
            {'snippet': 0, 'kind': 'company', 'quote': 'previously ran sales at Initech'},  # no FSAE term
            {'snippet': 3, 'kind': 'company', 'quote': 'Formula SAE'},  # out of range
        ],
    )
    assert [p.name for p in people] == ['Jane Doe']
    assert company_mentions == []


def test_verify_labels_keeps_verified_champion_on_company_mention():
    text = 'Torsten also initiated our program, donating over 1,000 devices to student racing teams such as Formula SAE.'
    people, company_mentions = verify_labels(
        [Snippet('u', text)],
        [{'snippet': 0, 'kind': 'company', 'person': 'Torsten', 'quote': 'donating over 1,000 devices to student racing teams such as Formula SAE'}],
    )
    assert people == []
    assert company_mentions[0].champion == 'Torsten'
    scan = FsaeScan(ties=False, people=people, company_mentions=company_mentions, pages_scanned=['u'])
    assert re.search(r'champion: Torsten', format_fsae_evidence(scan))


def test_format_fsae_evidence_names_people_and_stays_under_notion_limit():
    text = format_fsae_evidence(FsaeScan(ties=True, people=[FsaePerson('Jane Doe', 'x' * 3000, 'u')], pages_scanned=['u']))
    assert text.startswith('🏁 Jane Doe')
    assert len(text) <= 2000
    assert re.search(r'2 page', format_fsae_evidence(FsaeScan(ties=False, pages_scanned=['a', 'b'])))


def test_rank_key_puts_fsae_ties_above_higher_priority():
    hi = SponsorScores(3, 3, 3, 3, 3)
    lo = SponsorScores(contact_strength=0, market_fit=1, sponsors_other_teams=0, value_band=1, category_need=0)
    rows = [NS(name='big', fsae_ties=False, scores=hi), NS(name='alum-lo', fsae_ties=True, scores=lo), NS(name='alum-hi', fsae_ties=True, scores=hi)]
    assert [r.name for r in sorted(rows, key=rank_key)] == ['alum-hi', 'alum-lo', 'big']

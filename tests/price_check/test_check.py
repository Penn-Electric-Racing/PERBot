"""Offline tests for the price check itself: rows, comparison, the alert and its buttons, the
checker, the Job Log queue and the savings-ledger row. Notion, Slack and the search are faked."""
import json
from datetime import datetime, timezone

import pytest

from core.notion import NotionAPIError, page_id_from
from core.purchasing import PurchasingRow
from price_check import checker as pc
from price_check.database import CheckQueue, PurchasingPrices, alert_row_props
from price_check.models import Finding
from price_check.scrapers import llm_reader, regex_reader
from price_check.scrapers.ranking import Scorer
from price_check.views import PriceAlert
from tests.aio import as_coroutine, awaitable
from tests.price_check.fakes import CFG, DS, FakeNotion, FakeSlack, cfg, page


def listing(url, unit, qty=50, title='LM7805CT/NOPB regulator', supplier=None, **kw):
    r = {'title': title, 'url': url, 'snippet': '', 'search_rank': 0, **regex_reader._blank_info()}
    r.update({'cost': unit, 'currency': 'USD', 'cost_source': 'llm', 'supplier': supplier or url.split('/')[2],
              'in_stock': True, 'shipping_cost': 'Free', 'shipping_time': '2 days', **kw})
    return regex_reader.apply_qty(r, qty)


def scored(*rs, query='LM7805CT/NOPB', qty=50):
    rs = list(rs)
    Scorer().score_all(rs, query, qty)
    return rs


def checker(notion=None, slack=None, find=None, c=CFG, dry_run=False):
    return pc.Checker(c, notion or FakeNotion(), None if dry_run else (slack or FakeSlack()),
                         as_coroutine(find or (lambda row: scored(listing(row.link, 2.0)))), dry_run)


# ---------------------------------------------------------------- find
def _find_spy(monkeypatch, link_info):
    calls = []
    monkeypatch.setattr(llm_reader, 'part_info', awaitable(lambda r, llm, q: {**r, **link_info}))
    monkeypatch.setattr(llm_reader, 'find', awaitable(lambda term, qty, llm, read=(), **k:
                        calls.append((term, [r['url'] for r in read])) or ('', '', [])))
    return pc.PriceFinder(None, CFG), calls


async def test_find_searches_the_part_number_on_the_link(monkeypatch):
    find, calls = _find_spy(monkeypatch, {'mpn': '91290A115', 'manufacturer': None})
    await find(PurchasingRow.from_page(page(part='M3 socket head screws', link='https://mcmaster.com/x')))
    assert calls == [('91290A115', ['https://mcmaster.com/x'])]


async def test_find_falls_back_to_the_row_without_a_part_number_on_the_link(monkeypatch):
    find, calls = _find_spy(monkeypatch, {'mpn': None, 'fetch_error': 'HTTP 403'})
    await find(PurchasingRow.from_page(page(part='M3 socket head screws', link='https://mcmaster.com/x')))
    await find(PurchasingRow.from_page(page(part='M3 socket head screws', link='')))
    assert calls == [('M3 socket head screws', ['https://mcmaster.com/x']), ('M3 socket head screws', [])]


def test_llm_is_always_openai(monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'sk-test')
    monkeypatch.setenv('GROQ_API_KEY', 'gsk-test')
    monkeypatch.setenv('LLM_MODEL', 'some-groq-model')  # the scrapers' generic override
    llm = pc.make_llm(cfg(model='gpt-5'))
    assert (llm.provider, llm.model, llm.key) == ('openai', 'gpt-5', 'sk-test')
    monkeypatch.delenv('OPENAI_API_KEY')
    with pytest.raises(llm_reader.LLMError, match='OPENAI_API_KEY not set'):
        pc.make_llm(CFG)


# ---------------------------------------------------------------- rows
def test_parse_row():
    r = PurchasingRow.from_page(page())
    assert (r.name, r.part_number, r.quantity, r.unit_cost) == ('5V regulator', 'LM7805CT/NOPB', 50, 1.0)
    assert [(c.id, c.name, c.email) for c in r.contacts] == [('u1', 'Ada Lovelace', 'ada@upenn.edu')]
    assert r.pack_size == 1 and r.units == 50


def test_pack_rows_compare_per_unit():
    r = PurchasingRow.from_page(page(qty=5, cost=8.0, notes='Added from /parts. Sold in packs of 10: 5 pack(s).'))
    assert r.units == 50 and r.unit_price == 0.8
    assert Finding.compare(r, scored(listing(r.link, 0.8)), CFG) is None


@pytest.mark.parametrize('s', ['https://www.notion.so/team/5V-regulator-0123456789abcdef0123456789abcdef?pvs=4',
                               '0123456789abcdef0123456789abcdef', '01234567-89ab-cdef-0123-456789abcdef'])
def test_page_id_from(s):
    assert page_id_from(s).replace('-', '') == '0123456789abcdef0123456789abcdef'


def test_page_id_from_rejects_other_text():
    assert page_id_from('not a page') is None


@pytest.mark.parametrize('kw, reason', [
    ({'parent': '00000000-0000-0000-0000-000000000000'}, 'not a Purchasing row'),
    ({'exported': True}, 'already ordered'), ({'season': 'REV11'}, 'season REV11'), ({'season': ''}, 'season empty'),
    ({'cost': 0}, 'missing'), ({'part': ''}, 'missing'), ({'qty': 0}, 'missing')])
async def test_rows_that_are_not_checked(kw, reason):
    row = PurchasingRow.from_page(page(**kw))
    assert reason in PurchasingPrices(FakeNotion(), CFG).skip_reason(row)
    searched = []
    assert await checker(find=searched.append).check(row) == 'skipped' and searched == []


def test_open_purchasing_row_is_checked():
    assert PurchasingPrices(FakeNotion(), CFG).skip_reason(PurchasingRow.from_page(page())) is None
    assert PurchasingPrices(FakeNotion(), CFG).skip_reason(PurchasingRow.from_page(page(parent=DS.replace('-', '')))) is None


async def test_open_rows_query():
    notion = FakeNotion(rows=[page('a'), page('b')])
    assert [r.id for r in await PurchasingPrices(notion, CFG).open_rows(limit=1)] == ['a']
    ds, f, sorts, page_size = notion.queries[0]
    assert ds == DS and page_size == 1
    assert {'property': 'Exported?', 'checkbox': {'equals': False}} in f['and']
    assert {'property': 'Season', 'select': {'equals': 'REV12'}} in f['and']
    assert sorts == [{'timestamp': 'created_time', 'direction': 'ascending'}]


# ---------------------------------------------------------------- compare + alert text
def test_link_price_is_compared_first():
    row = PurchasingRow.from_page(page(cost=1.00))
    f = Finding.compare(row, scored(listing(row.link, 1.25), listing('https://cheap.com/p', 1.05)), CFG)
    assert f.at_link and f.found_unit == 1.25 and f.delta_pct == 25.0 and f.cheaper is None


def test_best_option_used_when_link_unpriced():
    row = PurchasingRow.from_page(page(cost=1.00))
    f = Finding.compare(row, scored(listing(row.link, None), listing('https://shop.com/p', 0.70)), CFG)
    assert not f.at_link and f.found_unit == 0.70 and f.delta_pct == -30.0


def test_small_change_or_small_total_is_not_alerted():
    row = PurchasingRow.from_page(page(cost=1.00, qty=2))
    assert Finding.compare(row, scored(listing(row.link, 1.05, qty=2), qty=2), CFG) is None  # 5%
    assert Finding.compare(row, scored(listing(row.link, 1.50, qty=2), qty=2), cfg(min_delta_usd=5)) is None  # +$1 total


def test_wrong_part_other_currency_and_short_stock_never_count():
    row = PurchasingRow.from_page(page(cost=1.00, link=''))
    rs = scored(listing('https://a.com/p', 0.30, title='MC7805 regulator'),
                listing('https://b.com/p', 0.40, currency='EUR'), listing('https://c.com/p', 0.50, stock=10))
    assert Finding.compare(row, rs, CFG) is None


def test_cheaper_option_is_reported():
    row = PurchasingRow.from_page(page(cost=1.00))
    f = Finding.compare(row, scored(listing(row.link, 1.30), listing('https://shop.com/p', 0.80)), CFG)
    assert f.cheaper.url == 'https://shop.com/p'
    text = PriceAlert(f).text()
    assert '*Price went up on <https://www.notion.so/p1|5V regulator>*' in text
    assert '$1.30/unit ($65.00)' in text and '*+30%*' in text
    assert 'Cheaper option: $0.80/unit at <https://shop.com/p|shop.com>' in text
    assert 'shipping cost estimated' not in text


def test_row_quantity_picks_the_price_break():
    row = PurchasingRow.from_page(page(qty=38, cost=1.00))
    link = listing(row.link, 1.86, qty=38, price_breaks=[(1, 1.86), (10, 1.33), (15, 1.18), (50, 1.08)])
    f = Finding.compare(row, scored(link, qty=38), CFG)
    assert f.found_unit == 1.18 and f.delta_pct == 18.0
    assert '$1.18/unit (15+ price) ($44.84)' in PriceAlert(f).text()


def test_alert_lists_flags_but_not_estimated_shipping():
    row = PurchasingRow.from_page(page(cost=1.00))
    f = Finding.compare(row, scored(listing(row.link, 1.50, shipping_cost=None)), CFG)
    f.found.notes = ['shipping cost estimated', 'search page: lowest listing']
    text = PriceAlert(f).text()
    assert '• Flags: search page: lowest listing' in text and 'estimated' not in text


# ---------------------------------------------------------------- checker
async def test_check_dms_point_of_contact_once():
    row = PurchasingRow.from_page(page())
    notion, slack = FakeNotion(), FakeSlack()
    find = lambda row: scored(listing(row.link, 1.40))  # noqa: E731
    assert await checker(notion, slack, find).check(row) == 'alerted'
    assert notion.created == ['price-alert p1 1 x50']
    assert slack.posts[0][0] == 'S1' and '+40%' in slack.posts[0][1]
    assert await checker(FakeNotion(claimed=notion.created), slack, find).check(row) == 'ok'
    assert len(slack.posts) == 1


async def test_new_quantity_can_alert_again():
    notion = FakeNotion(claimed=['price-alert p1 1 x50'])
    assert await checker(notion).check(PurchasingRow.from_page(page(qty=100))) == 'alerted'
    assert notion.created == ['price-alert p1 1 x100']


async def test_contact_matched_by_name_when_email_differs():
    slack = FakeSlack([('S2', 'Alan Turing', None)])
    await checker(slack=slack).check(PurchasingRow.from_page(page(contacts=(('u2', 'Alan Turing', 'alan@other.edu'),))))
    assert [c for c, _ in slack.posts] == ['S2']


async def test_contact_email_comes_from_the_workspace_users():
    slack = FakeSlack([('S9', 'Someone Else', 'ada@upenn.edu')])
    notion = FakeNotion(users=[{'id': 'u1', 'type': 'person', 'name': 'Ada', 'person': {'email': 'ada@upenn.edu'}}])
    await checker(notion, slack).check(PurchasingRow.from_page(page(contacts=(('u1', 'Ada', None),))))
    assert [c for c, _ in slack.posts] == ['S9']


async def test_unmatched_contact_falls_back_to_channel():
    slack = FakeSlack()
    await checker(slack=slack, c=cfg(channel='purchasing')).check(PurchasingRow.from_page(page(contacts=(('u9', 'Nobody Known', None),))))
    assert [c for c, _ in slack.posts] == ['purchasing']


async def test_no_target_and_no_channel_logs_the_alert(caplog):
    await checker().check(PurchasingRow.from_page(page(contacts=())))
    assert 'alert not sent' in caplog.text


async def test_dry_run_sends_and_claims_nothing(capsys):
    notion = FakeNotion()
    assert await checker(notion, dry_run=True).check(PurchasingRow.from_page(page())) == 'alerted'
    assert notion.created == [] and notion.ledger == []
    out = capsys.readouterr().out
    assert 'Price went up' in out
    assert '[View www.digikey.com (your link) ↗ | Use $2.00/unit · www.digikey.com | Keep $1.00/unit]' in out


async def test_unfindable_part_is_ok_not_retried():
    assert await checker(find=lambda row: []).check(PurchasingRow.from_page(page())) == 'ok'


async def test_search_failure_and_llm_outage_mean_retry():
    def boom(row):
        raise RuntimeError('All backends failed')
    assert await checker(find=boom).check(PurchasingRow.from_page(page())) == 'retry'
    outage = lambda row: scored(listing(row.link, None, fetch_error='llm: HTTP 429'))  # noqa: E731
    assert await checker(find=outage).check(PurchasingRow.from_page(page())) == 'retry'


async def test_sweep_counts_and_stops_on_repeated_outage():
    calls = []

    def find(row):
        calls.append(row.id)
        if row.id == 'p0':
            return scored(listing(row.link, 2.0))
        return scored(listing(row.link, None, fetch_error='llm: HTTP 429'))
    rows = [PurchasingRow.from_page(page(f'p{i}')) for i in range(6)]
    assert await checker(find=find).check_all(rows) == {'alerted': 1, 'retry': 3}
    assert calls == ['p0', 'p1', 'p2', 'p3']


async def test_one_failure_does_not_stop_the_sweep():
    def find(row):
        if row.id == 'p0':
            raise RuntimeError('All backends failed')
        return scored(listing(row.link, 1.0))
    assert await checker(find=find).check_all([PurchasingRow.from_page(page(f'p{i}')) for i in range(3)]) == {'retry': 1, 'ok': 2}


async def test_slack_post_failure_does_not_stop_the_run(caplog):
    class Down(FakeSlack):
        async def chat_postMessage(self, **kw):
            raise RuntimeError('not_in_channel')
    notion = FakeNotion()
    await checker(notion, Down()).check(PurchasingRow.from_page(page()))
    assert 'Slack post to S1 failed' in caplog.text
    assert notion.ledger == []  # not sent, so not logged


async def test_alert_dm_carries_the_buttons():
    slack = FakeSlack()
    await checker(slack=slack).check(PurchasingRow.from_page(page()))
    section, links, actions = slack.blocks[0]
    assert section['text']['text'] == slack.posts[0][1]
    assert links['block_id'] == 'price_swap_links' and actions['block_id'] == 'price_swap_actions'


# ---------------------------------------------------------------- queue (Job Log)
async def test_enqueue_claims_the_queue_key():
    notion = FakeNotion()
    assert await CheckQueue(notion, CFG).enqueue('p1') is True and notion.created == ['price-check-queue p1']
    assert await CheckQueue(notion, CFG).enqueue('p1') is False


async def test_queued_reads_entries_oldest_first():
    notion = FakeNotion(entries=[('e1', 'price-check-queue p1'), ('e2', 'price-check-queue  p2 '),
                                 ('e3', 'price-alert p1 1 x50')])
    assert await CheckQueue(notion, CFG).entries(limit=10) == [('e1', 'p1'), ('e2', 'p2')]
    ds, f, sorts, _ = notion.queries[0]
    assert ds == 'joblog-ds' and f == {'property': 'Job', 'rich_text': {'equals': 'price-check-queue'}}
    assert sorts == [{'property': 'Ran at', 'direction': 'ascending'}]


async def test_queue_new_rows_once_and_only_settled():
    notion = FakeNotion(rows=[page('new1', edited='2026-11-21T11:00:00.000Z'),
                              page('new2', edited='2026-11-21T11:00:00.000Z'),
                              page('busy', edited='2026-11-21T11:59:00.000Z'),
                              page('old', edited='2026-11-01T00:00:00.000Z')],
                        claimed=['price-check-queue new2'])
    since = datetime(2026, 11, 20, tzinfo=timezone.utc)
    settled = datetime(2026, 11, 21, 11, 30, tzinfo=timezone.utc)
    assert await CheckQueue(notion, CFG).queue_new_rows(since, settled) == ['new1']
    assert notion.created == ['price-check-queue new1']
    _, f, sorts, _ = notion.queries[0]
    assert {'timestamp': 'last_edited_time', 'last_edited_time': {'on_or_after': '2026-11-20T00:00:00.000Z'}} in f['and']
    assert sorts == [{'timestamp': 'last_edited_time', 'direction': 'ascending'}]
    dry = FakeNotion(rows=[page('new1')])
    assert await CheckQueue(dry, CFG).queue_new_rows(since, dry_run=True) == ['new1'] and dry.created == []


async def test_drain_marks_finished_entries_done():
    notion = FakeNotion(pages={'p1': page('p1'), 'p2': page('p2', exported=True)})
    assert await checker(notion).drain([('e1', 'p1'), ('e2', 'p2'), ('e3', 'gone')]) == {'alerted': 1, 'skipped': 1, 'gone': 1}
    assert notion.done == ['e1', 'e2', 'e3']


async def test_drain_preview_entries_are_not_marked():
    notion = FakeNotion(pages={'p1': page('p1')})
    assert await checker(notion).drain([(None, 'p1')]) == {'alerted': 1} and notion.done == []


async def test_drain_keeps_failures_queued_and_stops_on_outage():
    notion = FakeNotion(pages={f'p{i}': page(f'p{i}') for i in range(5)})
    outage = lambda row: scored(listing(row.link, None, fetch_error='llm: HTTP 429'))  # noqa: E731
    assert await checker(notion, find=outage).drain([(f'e{i}', f'p{i}') for i in range(5)]) == {'retry': 3}
    assert notion.done == []


async def test_drain_unreadable_page_is_retried():
    notion = FakeNotion(pages={'p1': NotionAPIError(502, '', 'bad gateway'), 'p2': page('p2')})
    assert await checker(notion).drain([('e1', 'p1'), ('e2', 'p2')]) == {'retry': 1, 'alerted': 1}
    assert notion.done == ['e2']


async def test_drain_dry_run_leaves_the_queue():
    notion = FakeNotion(pages={'p1': page('p1')})
    await checker(notion, dry_run=True).drain([('e1', 'p1')])
    assert notion.done == [] and notion.created == []


async def test_mark_done_failure_does_not_stop_the_queue(caplog):
    notion = FakeNotion(pages={'p1': page('p1'), 'p2': page('p2')})

    def update(page_id, properties):
        raise NotionAPIError(409, 'conflict_error', 'conflict')
    notion.pages.update = update
    assert await checker(notion).drain([('e1', 'p1'), ('e2', 'p2')]) == {'alerted': 2}
    assert caplog.text.count("couldn't mark queue entry") == 2


# ---------------------------------------------------------------- buttons (actions.py handles clicks)
def _values(block):
    return [(b['action_id'], json.loads(b['value'])) for b in block['elements']]


def test_buttons_use_found_price_at_own_link_and_keep():
    row = PurchasingRow.from_page(page(cost=1.00))
    block = PriceAlert(Finding.compare(row, scored(listing(row.link, 0.80)), CFG)).buttons()
    assert block['block_id'] == 'price_swap_actions'
    (use_id, use), (keep_id, keep) = _values(block)
    assert use_id == 'price_swap_use:0' and keep_id == 'price_swap_keep'
    assert use == {'v': 1, 'r': 'p1', 'q': 50, 'o': 1.0, 'n': 0.8, 's': 'www.digikey.com'}
    assert keep == {'v': 1, 'r': 'p1', 'q': 50, 'o': 1.0}
    assert [b['text']['text'] for b in block['elements']] == ['Use $0.80/unit · www.digikey.com', 'Keep $1.00/unit']
    assert block['elements'][0]['style'] == 'primary'


def test_test_alert_buttons_are_marked_for_the_ledger():
    row = PurchasingRow.from_page(page(cost=1.00))
    f = Finding.compare(row, scored(listing(row.link, 0.80)), CFG)
    assert all(v['x'] == 1 for _, v in _values(PriceAlert(f, test=True).buttons()))
    assert PriceAlert(f, test=True).text().startswith('🧪 *Test price alert on')


def test_cheaper_option_button_switches_the_link():
    row = PurchasingRow.from_page(page(cost=1.00))
    f = Finding.compare(row, scored(listing(row.link, 1.30), listing('https://shop.com/p', 0.80)), CFG)
    (a, found), (b, cheaper), _ = _values(PriceAlert(f).buttons())
    assert (a, b) == ('price_swap_use:0', 'price_swap_use:1')
    assert found['n'] == 1.3 and 'l' not in found
    assert cheaper['n'] == 0.8 and cheaper['l'] == 'https://shop.com/p' and cheaper['ol'] == 'https://www.digikey.com/x'
    els = PriceAlert(f).buttons()['elements']
    assert 'style' not in els[0] and els[1]['style'] == 'primary'


def test_flagged_cheaper_option_gets_no_button():
    row = PurchasingRow.from_page(page(cost=1.00))
    f = Finding.compare(row, scored(listing(row.link, 1.30), listing('https://shop.com/p', 0.80)), CFG)
    f.cheaper.notes = ['search page: lowest listing']
    assert [i for i, _ in _values(PriceAlert(f).buttons())] == ['price_swap_use:0', 'price_swap_keep']


def test_best_option_elsewhere_switches_link_even_from_empty():
    row = PurchasingRow.from_page(page(cost=1.00, link=None))
    use = _values(PriceAlert(Finding.compare(row, scored(listing('https://shop.com/p', 1.50)), CFG)).buttons())[0][1]
    assert use['l'] == 'https://shop.com/p' and use['ol'] == ''


def test_pack_row_buttons_carry_per_pack_prices():
    row = PurchasingRow.from_page(page(qty=5, cost=10.00, notes='Sold in packs of 10'))
    f = Finding.compare(row, scored(listing(row.link, 0.80, qty=50)), CFG)
    (_, use), (_, keep) = _values(PriceAlert(f).buttons())
    assert use['n'] == 8.0 and use['o'] == 10.0 and use['q'] == 5 and keep['o'] == 10.0
    assert PriceAlert(f).buttons()['elements'][1]['text']['text'] == 'Keep $1.00/unit'


def test_sub_dollar_prices_round_like_money():
    row = PurchasingRow.from_page(page(cost=0.10))
    assert _values(PriceAlert(Finding.compare(row, scored(listing(row.link, 0.0425123)), CFG)).buttons())[0][1]['n'] == 0.0425


def test_oversized_or_non_http_link_drops_that_button():
    row = PurchasingRow.from_page(page(cost=1.00))
    f = Finding.compare(row, scored(listing('https://shop.com/' + 'x' * 2100, 1.50)), CFG)
    assert PriceAlert(f).buttons() is None
    assert [b.get('block_id') for b in PriceAlert(f).blocks()[1:]] == ['price_swap_links']
    row = PurchasingRow.from_page(page(cost=1.00, link='digikey part 123'))
    assert PriceAlert(Finding.compare(row, scored(listing('https://shop.com/p', 1.50)), CFG)).buttons() is None


def test_view_links_for_every_option_even_flagged():
    row = PurchasingRow.from_page(page(cost=1.00))
    f = Finding.compare(row, scored(listing(row.link, 1.30), listing('https://shop.com/p', 0.80)), CFG)
    f.cheaper.notes = ['search page: lowest listing']
    links = PriceAlert(f).links()
    assert [(b['action_id'], b['url'], b['text']['text']) for b in links['elements']] == [
        ('price_swap_view:0', 'https://www.digikey.com/x', 'View www.digikey.com (your link) ↗'),
        ('price_swap_view:1', 'https://shop.com/p', 'View shop.com ↗')]
    assert all('value' not in b for b in links['elements'])
    assert [b.get('block_id') for b in PriceAlert(f).blocks()] == [None, 'price_swap_links', 'price_swap_actions']


def test_use_asks_for_a_check_first():
    row = PurchasingRow.from_page(page(cost=1.00))
    f = Finding.compare(row, scored(listing(row.link, 1.30), listing('https://shop.com/p', 0.80)), CFG)
    found, cheaper, keep = PriceAlert(f).buttons()['elements']
    assert found['confirm']['text']['text'] == (
        "Set Unit cost to $1.30 (www.digikey.com)? Open the listing first and check it's the right part, in stock, at this price.")
    assert 'switch the product link to it' in cheaper['confirm']['text']['text']
    assert found['confirm']['confirm']['text'] == 'Update Unit cost' and 'confirm' not in keep


# ---------------------------------------------------------------- savings ledger
async def test_alert_is_logged_to_the_ledger_once_sent():
    notion, slack = FakeNotion(), FakeSlack()
    find = lambda r: scored(listing(r.link, 1.30), listing('https://shop.com/p', 0.80))  # noqa: E731
    assert await checker(notion, slack, find).check(PurchasingRow.from_page(page(cost=1.00))) == 'alerted'
    (props,) = notion.ledger
    assert props['Outcome']['select']['name'] == 'Pending'
    assert props['Name']['title'][0]['text']['content'] == '5V regulator ×50'
    assert props['Row ID']['rich_text'][0]['text']['content'] == 'p1'
    assert (props['Old unit cost']['number'], props['Quant.']['number']) == (1.0, 50)
    assert props['Offered unit cost']['number'] == 0.8 and props['Potential $']['number'] == 10.0
    assert props['Direction']['select']['name'] == 'Drop'
    assert props['Supplier']['rich_text'][0]['text']['content'] == 'shop.com'
    assert props['Listing']['url'] == 'https://shop.com/p'
    assert props['Purchasing row']['url'] == 'https://www.notion.so/p1'
    assert props['Season']['select']['name'] == 'REV12' and 'Alert sent' in props


def test_pack_row_ledger_is_in_notion_units():
    row = PurchasingRow.from_page(page(qty=5, cost=10.00, notes='Sold in packs of 10'))
    props = alert_row_props(Finding.compare(row, scored(listing(row.link, 0.80, qty=50)), CFG))
    assert props['Offered unit cost']['number'] == 8.0 and props['Potential $']['number'] == 10.0


def test_price_rise_is_logged_as_a_rise():
    row = PurchasingRow.from_page(page(cost=1.00))
    props = alert_row_props(Finding.compare(row, scored(listing(row.link, 1.40)), CFG))
    assert props['Direction']['select']['name'] == 'Rise' and props['Potential $']['number'] == -20.0
    assert 'Listing' in props


async def test_nothing_logged_when_ledger_off():
    notion = FakeNotion()
    await checker(notion, c=cfg(ledger_data_source_id='')).check(PurchasingRow.from_page(page()))
    assert notion.ledger == []


async def test_ledger_failure_does_not_stop_the_alert(caplog):
    notion, slack = FakeNotion(), FakeSlack()
    create = notion.pages.create

    def no_ledger(parent, properties):
        if 'Run key' not in properties:
            raise NotionAPIError(404, 'object_not_found', 'no ledger')
        return create(parent, properties)
    notion.pages.create = no_ledger
    assert await checker(notion, slack).check(PurchasingRow.from_page(page())) == 'alerted'
    assert slack.posts and "couldn't log the alert" in caplog.text

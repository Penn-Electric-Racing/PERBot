import copy
import dataclasses
import json
import re
from datetime import datetime, timezone

from price_check.blocks import PRICE_ACTIONS_BLOCK_ID, decode_value
from price_check.ledger import (
    LedgerRow,
    PriceLedger,
    dashed_id,
    event_props,
    in_period,
    new_row_props,
    parse_ledger_row,
    stats_text,
    summarize,
)
from price_check.stats import ParsedStats, parse_stats
from price_check.swap import ClickInput, LedgerEvent, PriceRow, PriceSwapDeps, handle_price_swap
from utils.clock import to_iso

ROW_ID = '39e560bc-c039-80aa-bbbb-0123456789ab'
AT = datetime(2026, 10, 17, 19, 0, tzinfo=timezone.utc)


def value(**over):
    v = {'v': 1, 'r': ROW_ID, 'q': 10, 'o': 5, 'n': 1.17, 's': 'DigiKey', **over}
    return {k: x for k, x in v.items() if x is not None}


def ev(kind, **over):
    return LedgerEvent(kind, value(**over), 'U1', AT)


def purchasing_row(**over):
    base = dict(
        id=ROW_ID, unit_cost=5, quantity=10, link='https://www.digikey.com/x', exported=False, deleted=False, notes=[],
        name='5V regulator', part='LM7805CT/NOPB', season='REV12', url='https://www.notion.so/row',
    )
    return PriceRow(**{**base, **over})


def lrow(**over):
    base = dict(id='L1', name='Part ×10', outcome='Used', saved=10, potential=10, realized=False, supplier='DigiKey',
                season='REV12', created=to_iso(AT))
    return LedgerRow(**{**base, **over})


def test_use_records_the_saving_in_dollars_an_accepted_increase_goes_negative():
    used = event_props(ev('used'), 'Ada', 'Pending')
    assert used['Outcome']['select']['name'] == 'Used'
    assert used['Saved $']['number'] == 38.3  # (5 − 1.17) × 10
    assert used['Direction']['select']['name'] == 'Drop'
    assert used['Used unit cost']['number'] == 1.17
    assert used['Clicked by']['rich_text'][0]['text']['content'] == 'Ada'
    rise = event_props(ev('used', n=6.5), 'Ada', 'Pending')
    assert rise['Saved $']['number'] == -15
    assert rise['Direction']['select']['name'] == 'Rise'
    # A switched listing is recorded as the one used.
    assert event_props(ev('used', l='https://m.com/p', s='Mouser'), 'Ada', 'Pending')['Listing']['url'] == 'https://m.com/p'


def test_undo_and_keep_zero_the_saving_a_stale_refusal_never_overwrites_a_decision():
    undone = event_props(ev('undone'), 'Ada', 'Used')
    assert undone['Outcome']['select']['name'] == 'Undone'
    assert undone['Saved $']['number'] == 0
    assert undone['Used unit cost']['number'] is None
    assert undone['Realized']['checkbox'] is False
    assert event_props(ev('kept'), 'Ada', 'Pending')['Outcome']['select']['name'] == 'Kept'
    assert event_props(ev('refused'), 'Ada', 'Pending')['Outcome']['select']['name'] == 'Refused'
    assert event_props(ev('refused'), 'Ada', 'Used') is None
    assert event_props(ev('refused'), 'Ada', None)['Outcome']['select']['name'] == 'Refused'


def test_a_row_perbot_creates_itself_carries_the_alert_and_the_purchasing_row():
    p = new_row_props(value(r=ROW_ID.replace('-', ''), l='https://m.com/p'), purchasing_row())
    assert p['Name']['title'][0]['text']['content'] == '5V regulator ×10'
    assert p['Row ID']['rich_text'][0]['text']['content'] == ROW_ID  # dashed, so lookups match
    assert p['Potential $']['number'] == 38.3
    assert p['Season']['select']['name'] == 'REV12'
    assert p['Purchasing row']['url'] == 'https://www.notion.so/row'
    assert p['Listing']['url'] == 'https://m.com/p'
    assert dashed_id(ROW_ID.upper()) == ROW_ID


def test_summary_splits_savings_realized_increases_and_drops_left_on_the_table():
    s = summarize([
        lrow(name='A', saved=38.3, realized=True),
        lrow(name='B', saved=12),
        lrow(name='C', saved=-15),
        lrow(outcome='Kept', saved=0, potential=7.5),
        lrow(outcome='Pending', saved=0, potential=2.5),
        lrow(outcome='Pending', saved=0, potential=-4),  # a rise nobody answered: not "on the table"
        lrow(outcome='Undone', saved=0, potential=9),
    ])
    assert s.alerts == 7
    assert [s.saved, s.saved_count, s.realized, s.realized_count] == [50.3, 2, 38.3, 1]
    assert [s.increases, s.increases_count] == [15, 1]
    assert [s.on_table, s.on_table_count] == [10, 2]
    assert [r.name for r in s.top] == ['A', 'B']
    text = stats_text(s, 'season', 'REV12', 'https://notion.so/ledger')
    assert re.search('Price check savings: REV12 season', text)
    assert re.search(r'\*\$50\.30 saved\* on 2 accepted price drops \(\$38\.30 realized: 1 order placed at the new price\)', text)
    assert re.search(r'\$15\.00 of price increases caught before ordering \(1 row\)', text)
    assert re.search(r'7 alerts: 3 used · 1 kept · 1 undone · 2 no answer yet \(60% of answered alerts used\)', text)
    assert re.search(r'\$10\.00 still on the table: 2 price drops not taken', text)
    assert re.search(r'1\. A: \$38\.30 \(DigiKey\)', text)
    assert re.search(r'<https://notion\.so/ledger\|Open the ledger in Notion>', text)
    assert re.search('No price alerts this week', stats_text(summarize([]), 'week', 'REV12', ''))


def test_periods_and_the_pricecheck_arguments():
    now = datetime(2026, 10, 20, tzinfo=timezone.utc)
    assert in_period(lrow(), 'week', 'REV12', now) is True
    assert in_period(lrow(created='2026-10-01T00:00:00Z'), 'week', 'REV12', now) is False
    assert in_period(lrow(season='REV11'), 'season', 'REV12', now) is False
    assert in_period(lrow(season='REV11'), 'all', 'REV12', now) is True
    assert parse_stats('') == ParsedStats('stats', 'season', False)
    assert parse_stats('week share') == ParsedStats('stats', 'week', True)
    assert parse_stats('all') == ParsedStats('stats', 'all', False)
    assert parse_stats('help').kind == 'help'


def test_clicks_hand_the_handler_a_ledger_event():
    state = {'row': purchasing_row()}

    def write(_id, patch):
        state['row'] = dataclasses.replace(state['row'], unit_cost=patch.unit_cost)

    deps = PriceSwapDeps(
        fetch_row=lambda _id: dataclasses.replace(state['row']),
        write_row=write,
        display_name=lambda _u: 'Ada',
        now=lambda: AT,
    )
    existing = [
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': 'alert'}},
        {'type': 'actions', 'block_id': PRICE_ACTIONS_BLOCK_ID, 'elements': []},
    ]

    def click(action_id, v):
        return handle_price_swap(deps, ClickInput(action_id, json.dumps(v), 'U1', existing))

    assert click('price_swap_keep', value(n=None)).ledger.kind == 'kept'
    used = click('price_swap_use:0', value())
    assert used.ledger.kind == 'used'
    assert used.ledger.value['n'] == 1.17
    assert click('price_swap_use:0', value()).ledger.kind == 'used'  # already at the price
    assert click('price_swap_undo', value(t=int(AT.timestamp()))).ledger.kind == 'undone'
    state['row'] = dataclasses.replace(state['row'], unit_cost=3)
    assert click('price_swap_use:0', value()).ledger.kind == 'refused'
    assert click('price_swap_undo', value(t=int(AT.timestamp()))).ledger is None
    assert decode_value(json.dumps(value(x=1)))['x'] == 1


class _FakeNotion:
    """A tiny stand-in for the Notion client: one data source of pages, filtered like Notion."""

    def __init__(self):
        self.store = []
        self.calls = []
        fake = self

        class DataSources:
            def query(self, data_source_id, filter=None, page_size=None, start_cursor=None):
                fake.calls.append('query')
                results = [p for p in fake.store if all(fake._match(p, f) for f in (filter or {}).get('and', []))]
                return {'results': results, 'has_more': False, 'next_cursor': None}

        class Pages:
            def create(self, parent, properties):
                fake.calls.append('create')
                page = {'id': f'L{len(fake.store) + 1}', 'created_time': to_iso(AT), 'properties': fake._stored(properties)}
                fake.store.append(page)
                return page

            def update(self, page_id, properties):
                fake.calls.append('update')
                page = next(p for p in fake.store if p['id'] == page_id)
                page['properties'].update(fake._stored(properties))
                return page

        self.data_sources = DataSources()
        self.pages = Pages()

    @staticmethod
    def _stored(props):
        # Notion echoes text values back with plain_text, which the parsers read.
        out = copy.deepcopy(props)
        for v in out.values():
            for t in (v or {}).get('rich_text') or (v or {}).get('title') or []:
                t['plain_text'] = (t.get('text') or {}).get('content', '')
        return out

    @staticmethod
    def _match(page, f):
        prop = page['properties'].get(f['property'])
        if 'rich_text' in f:
            return ((prop or {}).get('rich_text') or [{}])[0].get('text', {}).get('content', '') == f['rich_text']['equals']
        if 'number' in f:
            return (prop or {}).get('number') == f['number']['equals']
        if 'select' in f:
            return ((prop or {}).get('select') or {}).get('name') == f['select']['equals']
        if 'checkbox' in f:
            return bool((prop or {}).get('checkbox')) == f['checkbox']['equals']
        return True


def test_record_updates_the_listeners_row_creates_one_when_missing_skips_test_alerts():
    fake = _FakeNotion()
    ledger = PriceLedger('ds', fake)

    def fetch_row(_id):
        return purchasing_row()

    assert ledger.record(ev('used', x=1), 'Ada', fetch_row) == 'test alert, not logged'
    assert fake.calls == []

    # No row yet (alert from before the ledger): created, then the click applied.
    assert ledger.record(ev('used'), 'Ada', fetch_row) == 'new → used'
    r = parse_ledger_row(fake.store[0])
    assert [r.outcome, r.saved, r.name] == ['Used', 38.3, '5V regulator ×10']

    # Same alert again: found, not duplicated. A late stale refusal leaves Used alone.
    assert ledger.record(ev('refused'), 'Ada', fetch_row) == 'kept Used'
    assert ledger.record(ev('undone'), 'Bo', fetch_row) == 'Used → undone'
    assert len(fake.store) == 1
    assert parse_ledger_row(fake.store[0]).outcome == 'Undone'
    assert PriceLedger('', fake).record(ev('used'), 'Ada', fetch_row) == 'ledger off'


def test_the_sweep_marks_a_used_row_realized_only_once_ordered_at_the_used_price():
    fake = _FakeNotion()
    ledger = PriceLedger('ds', fake)
    ledger.record(ev('used'), 'Ada', lambda _id: purchasing_row())
    state = {'row': purchasing_row(unit_cost=1.17)}

    def fetch_row(_id):
        return state['row']

    assert ledger.sweep_realized(fetch_row, AT) == 0  # not ordered yet
    state['row'] = purchasing_row(unit_cost=2, exported=True)
    assert ledger.sweep_realized(fetch_row, AT) == 0  # ordered, but at another price
    state['row'] = purchasing_row(unit_cost=1.17, exported=True)
    assert ledger.sweep_realized(fetch_row, AT) == 1
    assert parse_ledger_row(fake.store[0]).realized is True
    assert ledger.sweep_realized(fetch_row, AT) == 0  # already marked

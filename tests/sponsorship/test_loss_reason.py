import re
from datetime import datetime, timezone

from sponsorship.deal_blocks import (
    DEAL_ACTION_IDS,
    DEAL_COLD_ACTION_RE,
    DEAL_STAGE_ACTION_RE,
    DealButtonValue,
    buttons_for,
    cold_deal_blocks,
    deal_blocks,
    loss_reason_for_action,
    replace_deal_blocks,
)
from sponsorship.jobs.stale_dm import StaleDmInput, build_stale_dm
from sponsorship.models import LOSS_REASONS

from .helpers import deal as _deal

VALUE = DealButtonValue('p1', 'U1')


def deal(**over):
    return _deal(**{'contacted_at': '2026-09-02T15:00:00.000Z', **over})


def ids(els):
    return [e['action_id'] for e in els]


# --- loss reason picker ---------------------------------------------------------------


def test_lost_without_reason_gets_one_button_per_reason():
    els = buttons_for(deal(stage='Lost'), VALUE)
    assert len(els) == len(LOSS_REASONS)
    assert [loss_reason_for_action(e['action_id']) for e in els] == list(LOSS_REASONS)
    assert all(len(e['text']['text']) <= 75 for e in els), 'Slack caps button text at 75 chars'


def test_lost_with_reason_or_won_gets_no_buttons():
    assert buttons_for(deal(stage='Lost', loss_reason='No response'), VALUE) == []
    assert buttons_for(deal(stage='Won'), VALUE) == []


def test_loss_reason_for_action_ignores_non_reason_ids():
    assert loss_reason_for_action('deal_loss_99') is None
    assert loss_reason_for_action(DEAL_ACTION_IDS['lost']) is None


def test_clicking_lost_swaps_stage_buttons_for_reason_picker():
    before = deal_blocks(deal(), 'U1')
    after = replace_deal_blocks(before, deal(stage='Lost'), 'U1', '❌ Lost', 'Contacted')
    actions = next(b for b in after if b['type'] == 'actions')
    assert all(loss_reason_for_action(i) for i in ids(actions['elements']))


# --- gone cold ---------------------------------------------------------------------


def test_cold_deal_blocks_four_choices_each_routed():
    _, actions = cold_deal_blocks(deal(), 'U1', 'Acme — contacted Sep 2')
    assert len(actions['elements']) == 4
    for i in ids(actions['elements']):
        assert DEAL_COLD_ACTION_RE.match(i) or DEAL_STAGE_ACTION_RE.match(i), i


def test_overdue_and_cold_deal_shows_once_under_cold():
    both = deal(id='both', next_action_date='2026-09-20')
    dm = build_stale_dm(StaleDmInput(overdue=[both, deal(id='late', next_action_date='2026-09-21')], cold=[both]), 'U1')
    sections = [b['block_id'] for b in dm.blocks if (b.get('block_id') or '').startswith('deal:')]
    assert sections == ['deal:late', 'deal:both']
    assert [d.id for d in dm.cold_shown] == ['both']


def test_stale_dm_under_block_cap_and_shows_oldest_cold():
    overdue = [deal(id=f'o{i}', next_action_date='2026-09-20') for i in range(30)]
    cold = [deal(id=f'c{i}', contacted_at=f'2026-08-{i + 1:02d}T15:00:00.000Z') for i in range(20)]
    dm = build_stale_dm(StaleDmInput(overdue=overdue, cold=cold), 'U1')
    assert len(dm.blocks) <= 50, f'{len(dm.blocks)} blocks'
    assert len(dm.cold_shown) == 6
    assert dm.cold_shown[0].id == 'c0', 'oldest first'
    text = '\n'.join((b.get('text') or {}).get('text', '') for b in dm.blocks)
    assert re.search(r'You have \*30\* sponsorship deal\(s\).*oldest 10 shown', text)
    assert re.search(r'\*20\* deal\(s\) contacted 30\+ days ago.*oldest 6 shown', text)


def test_stale_dm_nothing_to_say():
    assert build_stale_dm(StaleDmInput(), 'U1').blocks == []


def test_cold_line_says_when_and_how_long_ago():
    dm = build_stale_dm(StaleDmInput(cold=[deal()]), 'U1', datetime(2026, 10, 14, 13, tzinfo=timezone.utc))
    assert re.search(r'contacted Sep 2 \(41 days ago\), no reply yet', dm.text)

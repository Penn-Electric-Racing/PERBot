import re
from datetime import datetime, timezone

from sponsorship.deal_blocks import DEAL_ACTION_IDS, DealButtonValue, buttons_for, deal_blocks, finalize_deal_blocks
from sponsorship.jobs.stale_dm import StaleDmInput, build_stale_dm, split_stale_claims
from sponsorship.next_actions import (
    NextActionChange,
    backfill_next_action,
    is_auto_next_action,
    next_action_after_touch,
    next_action_for_stage,
)

from .helpers import deal as _deal

TODAY = '2026-10-22'


def deal(**over):
    return _deal(**{'stage': 'Prospect', 'next_action': 'Send first outreach', 'next_action_date': '2026-09-08', **over})


# --- stage moves replace PERBot's own next action ---------------------------------------


def test_contacted_swaps_first_outreach_for_follow_up_keeping_the_ask():
    row = deal(next_action='Send first outreach — reduced-cost PCB fab')
    assert next_action_for_stage(row, 'Contacted', TODAY) == NextActionChange(
        'Follow up if no reply — reduced-cost PCB fab', '2026-10-29'
    )


def test_in_talks_won_lost_clear_it():
    for stage in ('In talks', 'Won', 'Lost'):
        assert next_action_for_stage(deal(), stage, TODAY) == NextActionChange('', None), stage


def test_persons_own_next_action_is_never_touched():
    row = deal(next_action='Call Priya Tuesday about the PCB order')
    assert is_auto_next_action(row.next_action) is False
    assert next_action_for_stage(row, 'Contacted', TODAY) is None
    assert next_action_for_stage(row, 'Lost', TODAY) is None


def test_follow_up_on_contacted_pushes_next_a_week_out():
    row = deal(stage='Contacted', next_action='Follow up if no reply')
    assert next_action_after_touch(row, TODAY) == NextActionChange('Follow up if no reply', '2026-10-29')
    assert next_action_after_touch(deal(stage='In talks'), TODAY) is None


# --- one-time cleanup -------------------------------------------------------------------


def test_backfill_recent_contacted_follow_up_after_last_touch():
    row = deal(stage='Contacted', contacted_at='2026-10-05T14:00:00.000Z', last_contact='2026-10-09')
    assert backfill_next_action(row, TODAY) == NextActionChange('Follow up if no reply', '2026-10-16')


def test_backfill_contacted_30_plus_days_ago_is_cleared():
    row = deal(stage='Contacted', contacted_at='2026-08-01T14:00:00.000Z')
    assert backfill_next_action(row, TODAY) == NextActionChange('', None)


def test_backfill_in_talks_cleared_prospect_and_fixed_skipped():
    assert backfill_next_action(deal(stage='In talks'), TODAY) == NextActionChange('', None)
    assert backfill_next_action(deal(), TODAY) is None
    assert backfill_next_action(deal(stage='Contacted', next_action='Follow up if no reply'), TODAY) is None


# --- stale claims -----------------------------------------------------------------------


def test_split_stale_claims_ask_release_wait():
    release, ask = split_stale_claims(
        [
            deal(id='new'),
            deal(id='due', release_asked_at='2026-10-15'),
            deal(id='recent', release_asked_at='2026-10-20'),
            deal(id='moved', stage='Contacted', release_asked_at='2026-10-01'),
        ],
        TODAY,
    )
    assert [d.id for d in ask] == ['new']
    assert [d.id for d in release] == ['due']


def test_ownerless_claim_released_at_21_days():
    release, ask = split_stale_claims(
        [
            deal(id='old', dri_user_ids=[], created_time='2026-09-30T12:00:00.000Z'),
            deal(id='young', dri_user_ids=[], created_time='2026-10-05T12:00:00.000Z'),
        ],
        TODAY,
    )
    assert [d.id for d in release] == ['old']
    assert ask == []


def test_claim_shows_once_with_sent_it_release_it_and_heads_up():
    claim = deal(id='c1')
    dm = build_stale_dm(
        StaleDmInput(overdue=[claim], claims=[claim], released=[deal(id='r1', company='Timken')]),
        'U1',
        datetime(2026, 10, 22, 13, tzinfo=timezone.utc),
    )
    assert sum(1 for b in dm.blocks if b.get('block_id') == 'deal:c1') == 1
    assert [d.id for d in dm.claims_shown] == ['c1']
    actions = next(b for b in dm.blocks if b.get('block_id') == 'deal_actions:c1')
    assert [e['action_id'] for e in actions['elements']] == [DEAL_ACTION_IDS['contacted'], DEAL_ACTION_IDS['release']]
    assert re.search(r'claimed Sep 1 \(51 days ago\), not contacted yet', dm.text)
    assert re.search(r'Released back to the Bank.*Timken', dm.text)
    assert len(dm.blocks) <= 50


def test_all_four_sections_full_stays_under_block_cap():
    def many(prefix, n, **over):
        return [deal(id=f'{prefix}{i}', **over) for i in range(n)]

    dm = build_stale_dm(
        StaleDmInput(overdue=many('o', 30), cold=many('k', 30, stage='Contacted'), claims=many('c', 30), released=many('r', 3)),
        'U1',
    )
    assert len(dm.blocks) <= 50, f'{len(dm.blocks)} blocks'


# --- buttons ----------------------------------------------------------------------------


def test_contacted_deals_get_one_tap_followed_up():
    value = DealButtonValue('p1', 'U1')
    assert DEAL_ACTION_IDS['followed_up'] in [b['action_id'] for b in buttons_for(deal(stage='Contacted'), value)]
    assert DEAL_ACTION_IDS['followed_up'] not in [b['action_id'] for b in buttons_for(deal(), value)]


def test_finalize_deal_blocks_keeps_line_adds_note_drops_buttons():
    out = finalize_deal_blocks(deal_blocks(deal(), 'U1'), 'p1', '🔓 Released')
    assert len(out) == 1
    assert re.search(r'Acme.*\n_🔓 Released_', out[0]['text']['text'], re.S)

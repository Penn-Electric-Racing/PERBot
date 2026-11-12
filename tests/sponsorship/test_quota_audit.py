import dataclasses
import re
from datetime import datetime, timezone

from sponsorship.jobs.quota_audit import (
    audit_window,
    build_follow_up_gap_line,
    bulk_stamp_instants,
    compute_quota_results,
    current_audit_window,
    follow_up_gap_deals,
)
from sponsorship.models import QuotaRosterMember

from .helpers import deal as _deal


def deal(**over):
    return _deal(**{'created_time': '2026-09-11T12:00:00.000Z', **over})


WEEK = audit_window('2026-09-19')  # Sat Sep 12 10:00 ET → Sat Sep 19 10:00 ET


def test_audit_window_is_et_wall_clock():
    assert WEEK.week_start_iso == '2026-09-12'
    assert WEEK.start == datetime(2026, 9, 12, 14, tzinfo=timezone.utc)
    assert WEEK.end == datetime(2026, 9, 19, 14, tzinfo=timezone.utc)


def test_current_audit_window_rolls_over_after_saturday_audit():
    # Wednesday → this Saturday.
    assert current_audit_window(datetime(2026, 9, 16, 16, tzinfo=timezone.utc)).week_end_iso == '2026-09-19'
    # Saturday 9am ET → today; Saturday 11am ET → next week.
    assert current_audit_window(datetime(2026, 9, 19, 13, tzinfo=timezone.utc)).week_end_iso == '2026-09-19'
    assert current_audit_window(datetime(2026, 9, 19, 15, tzinfo=timezone.utc)).week_end_iso == '2026-09-26'


# --- quota audit: one bulk write is not N contacts -----------------------------------


def test_bulk_stamp_flags_instant_shared_by_three_untouched_deals():
    swept = [deal(id=i, contacted_at='2026-09-12T17:22:00.000Z') for i in 'abc']
    real = deal(id='d', contacted_at='2026-09-14T14:10:00.000Z', last_contact='2026-09-14')
    assert bulk_stamp_instants([*swept, real], WEEK) == {'2026-09-12T17:22:00.000Z'}


def test_bulk_stamp_two_deals_in_a_minute_is_plausible():
    pair = [deal(id=i, contacted_at='2026-09-14T14:10:00.000Z') for i in 'ab']
    assert bulk_stamp_instants(pair, WEEK) == set()


def test_bulk_stamp_three_sponsor_stage_calls_still_count():
    burst = [deal(id=i, contacted_at='2026-09-14T14:10:00.000Z', last_contact='2026-09-14') for i in 'abc']
    assert bulk_stamp_instants(burst, WEEK) == set()


def test_swept_batch_does_not_count_toward_quota():
    members = [QuotaRosterMember('Katherine Shen', 'u1')]
    sweep = [deal(id=f's{n}', contacted_at='2026-09-12T17:22:00.000Z', created_time='2026-07-23T10:00:00.000Z') for n in range(4)]
    real = [deal(id=f'r{i}', contacted_at=f'2026-09-14T14:1{i}:00.000Z', last_contact='2026-09-14') for i in range(3)]
    [result] = compute_quota_results(members, [*sweep, *real], WEEK, 3)
    assert len(result.deals) == 3, 'only the three real contacts count'
    assert result.met


def test_contacts_outside_window_never_count():
    members = [QuotaRosterMember('Arjun Sharma', 'u1')]
    before = deal(id='b1', contacted_at='2026-09-11T12:00:00.000Z')
    inside = deal(id='i1', contacted_at='2026-09-12T19:31:00.000Z')
    [result] = compute_quota_results(members, [before, inside], WEEK, 3)
    assert [d.id for d in result.deals] == ['i1']


def test_notion_side_move_earns_nothing_without_slack_command():
    members = [QuotaRosterMember('Katherine Shen', 'u1')]
    moved = deal(id='m1', stage='Contacted', contacted_at=None, last_contact='2026-09-15')
    assert len(compute_quota_results(members, [moved], WEEK, 3)[0].deals) == 0
    logged = dataclasses.replace(moved, contacted_at='2026-09-15T18:00:00.000Z')
    assert len(compute_quota_results(members, [logged], WEEK, 3)[0].deals) == 1


def test_claiming_a_lead_earns_nothing():
    members = [QuotaRosterMember('Arjun Sharma', 'u1')]
    claimed = deal(id='c1', stage='Prospect', contacted_at=None)
    assert len(compute_quota_results(members, [claimed], WEEK, 3)[0].deals) == 0


# --- follow-up gap: contacted 7+ days ago, no reply, no touch since ------------------


def test_follow_up_gap_flags_deal_contacted_before_window_with_no_later_touch():
    stale = deal(id='a', contacted_at='2026-09-08T15:00:00.000Z', last_contact='2026-09-08')
    never_stamped = deal(id='b', contacted_at='2026-09-08T15:00:00.000Z')
    assert [d.id for d in follow_up_gap_deals([stale, never_stamped], WEEK)] == ['a', 'b']


def test_follow_up_gap_later_last_contact_is_a_follow_up():
    followed = deal(contacted_at='2026-09-08T15:00:00.000Z', last_contact='2026-09-15')
    assert follow_up_gap_deals([followed], WEEK) == []


def test_follow_up_gap_contacted_this_week_too_fresh():
    fresh = deal(contacted_at='2026-09-14T15:00:00.000Z', last_contact='2026-09-14')
    assert follow_up_gap_deals([fresh], WEEK) == []


def test_follow_up_gap_replied_unstamped_prospect_left_out():
    old = {'contacted_at': '2026-09-08T15:00:00.000Z', 'last_contact': '2026-09-08'}
    rows = [
        deal(id='talks', stage='In talks', **old),
        deal(id='nostamp', contacted_at=None, last_contact='2026-09-01'),
        deal(id='prospect', stage='Prospect', **old),
    ]
    assert follow_up_gap_deals(rows, WEEK) == []


def test_follow_up_gap_compares_against_et_contact_day():
    # 01:30 UTC on Sep 9 is 21:30 ET on Sep 8, so a Sep 8 Last contact is the same touch.
    late_evening = deal(contacted_at='2026-09-09T01:30:00.000Z', last_contact='2026-09-08')
    assert len(follow_up_gap_deals([late_evening], WEEK)) == 1


def test_follow_up_gap_line_counts_per_dri_most_first():
    assert build_follow_up_gap_line([], WEEK, lambda i: i) is None
    gap = [
        deal(id='a', dri_user_ids=['u1']),
        deal(id='b', dri_user_ids=['u2']),
        deal(id='c', dri_user_ids=['u2']),
        deal(id='d', dri_user_ids=[]),
    ]
    names = {'u1': 'Priya', 'u2': 'Sam'}
    line = build_follow_up_gap_line(gap, WEEK, lambda i: names[i])
    assert re.search(r'4 deals contacted 7–30 days ago, no reply yet', line)
    assert re.search(r'Sam 2 · Priya 1 · unassigned 1', line)
    assert '<@' not in line


def test_follow_up_gap_aged_out_after_30_days():
    # WEEK ends Sep 19 10:00 ET, so the cutoff is Aug 20 10:00 ET.
    aged = deal(id='aged', contacted_at='2026-08-15T15:00:00.000Z', last_contact='2026-08-15')
    edge = deal(id='edge', contacted_at='2026-08-21T15:00:00.000Z', last_contact='2026-08-21')
    assert [d.id for d in follow_up_gap_deals([aged, edge], WEEK)] == ['edge']

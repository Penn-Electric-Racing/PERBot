from ops_tasks.meetings import OpsMeeting, pick_meeting, saturday_on_or_after


def test_saturday_on_or_after_weekdays_roll_forward_saturday_stays_put():
    assert saturday_on_or_after('2026-09-13') == '2026-09-19'  # Sunday
    assert saturday_on_or_after('2026-09-14') == '2026-09-19'  # Monday
    assert saturday_on_or_after('2026-09-18') == '2026-09-19'  # Friday
    assert saturday_on_or_after('2026-09-19') == '2026-09-19'  # Saturday
    assert saturday_on_or_after('2026-09-19T21:30:00.000Z') == '2026-09-19'  # datetime tolerated


meetings = [OpsMeeting('m0919', '2026-09-19'), OpsMeeting('m0912', '2026-09-12'), OpsMeeting('m0829', '2026-08-29')]


def _id(m):
    return m.id if m else None


def test_pick_meeting_a_mid_week_task_belongs_to_the_coming_saturday():
    assert _id(pick_meeting(meetings, '2026-09-14')) == 'm0919'
    assert _id(pick_meeting(meetings, '2026-09-13')) == 'm0919'


def test_pick_meeting_a_task_dated_on_the_saturday_belongs_to_that_meeting():
    assert _id(pick_meeting(meetings, '2026-09-12')) == 'm0912'
    assert _id(pick_meeting(meetings, '2026-09-19')) == 'm0919'


def test_pick_meeting_never_links_to_a_past_meeting_or_a_later_week():
    assert pick_meeting(meetings, '2026-09-20') is None  # Sunday after the last page
    assert pick_meeting(meetings, '2026-09-05') is None  # week with no page (9/5 skipped)
    assert pick_meeting([], '2026-09-14') is None


def test_pick_meeting_a_page_stamped_with_its_sunday_creation_time_still_counts_for_that_week():
    sunday_stamped = [OpsMeeting('m0919', '2026-09-19'), OpsMeeting('m0926', '2026-09-20T13:00:00.000Z')]
    assert _id(pick_meeting(sunday_stamped, '2026-09-21')) == 'm0926'  # Monday → the page created Sunday
    assert _id(pick_meeting(sunday_stamped, '2026-09-26')) == 'm0926'  # the Saturday itself
    assert _id(pick_meeting(sunday_stamped, '2026-09-19')) == 'm0919'  # previous week unaffected
    assert pick_meeting(sunday_stamped, '2026-09-27') is None  # following week has no page yet


def test_pick_meeting_a_thursday_stamped_page_maps_to_its_saturday():
    odd = [OpsMeeting('thu', '2026-09-17')]
    assert _id(pick_meeting(odd, '2026-09-14')) == 'thu'
    assert _id(pick_meeting(odd, '2026-09-19')) == 'thu'

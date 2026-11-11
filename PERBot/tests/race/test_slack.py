import json
import re
from datetime import datetime, timezone

import httpx

from perbot.race.board import fetch_board, format_lap
from perbot.race.slack import ParsedRace, board_message, board_text, parse_race

rows = [
    {'rank': 1, 'name': 'Ben Ito', 'slack_id': 'UBEN', 'time_ms': 41234, 'cones': 0, 'laps': 6, 'set_at': '2026-10-09T00:00:00Z'},
    {'rank': 2, 'name': 'Ada Park', 'slack_id': 'UADA', 'time_ms': 43010, 'cones': 1, 'laps': 1, 'set_at': '2026-10-09T00:00:00Z'},
    {'rank': 4, 'name': 'Cam Lee', 'slack_id': None, 'time_ms': 61000, 'cones': 2, 'laps': 3, 'set_at': '2026-10-09T00:00:00Z'},
]


def test_parse_race_week_by_default_all_share_in_any_order_help():
    assert parse_race('') == ParsedRace('board', 'week', False)
    assert parse_race('all') == ParsedRace('board', 'all', False)
    assert parse_race(' Share  ALL ') == ParsedRace('board', 'all', True)
    assert parse_race('post') == ParsedRace('board', 'week', True)
    assert parse_race('help').kind == 'help'


def test_format_lap_minutes_two_decimals_padded_seconds():
    assert format_lap(41234) == '0:41.23'
    assert format_lap(65000) == '1:05.00'
    assert format_lap(9990) == '0:09.99'


def test_board_text_private_reply_uses_mentions_medals_cones_laps_and_your_place():
    t = board_text(rows, 'week', share=False, viewer='UADA')
    assert re.search(r'last 7 days', t)
    assert re.search(r'🥇 <@UBEN> {2}`0:41.23` {2}_6 laps_', t)
    assert re.search(r'🥈 <@UADA> {2}`0:43.01` {2}_\+1 cone, 1 lap_', t)
    assert re.search(r'4\. Cam Lee', t)  # no Slack id: plain name
    assert re.search(r"You're P2 with 0:43.01\.", t)
    assert re.search('not on this board yet', board_text(rows, 'all', share=False, viewer='UZZZ'))


def test_board_text_shared_posts_use_names_and_no_personal_footer():
    t = board_text(rows, 'all', share=True, viewer='UADA')
    assert 'all time' in t
    assert '🥇 Ben Ito' in t
    assert '<@' not in t
    assert "You're P" not in t


def test_empty_board_invites_a_first_lap_share_posts_in_channel():
    assert 'No laps this week' in board_text([], 'week', share=False)
    assert board_message(rows, 'week', share=True)['response_type'] == 'in_channel'
    assert board_message(rows, 'week', share=False)['response_type'] == 'ephemeral'


def test_fetch_board_calls_the_bot_rpc_with_the_service_key_and_a_7_day_window():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=rows)

    http = httpx.Client(transport=httpx.MockTransport(handler), base_url='http://x')
    now = datetime(2026, 10, 10, tzinfo=timezone.utc).timestamp() * 1000
    out = fetch_board('week', 10, now, http)
    assert len(out) == 3
    assert re.search(r'/rest/v1/rpc/bot_leaderboard$', str(seen[-1].url))
    assert json.loads(seen[-1].content) == {'since': '2026-10-03T00:00:00.000Z', 'lim': 10}
    fetch_board('all', 10, now, http)
    assert json.loads(seen[-1].content) == {'since': None, 'lim': 10}

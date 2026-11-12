"""`/race` — the REV12 members' time trial leaderboard.
  /race            top 10 of the last 7 days, just for you (with your own best)
  /race all        all time
  /race share      post the board in this channel (add "all" for all time)
Shared posts use plain names so nobody gets pinged; private replies use @mentions (which don't notify).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Literal

from slack_bolt import App

from config import config
from utils.logger import logger
from race.board import BoardRow, Period, fetch_board, format_lap, race_configured


@dataclass
class ParsedRace:
    kind: Literal['board', 'help']
    period: Period
    share: bool


def parse_race(text: str) -> ParsedRace:
    words = text.strip().lower().split()
    if any(w in ('help', '?') for w in words):
        return ParsedRace('help', 'week', False)
    return ParsedRace(
        'board',
        'all' if any(w in ('all', 'alltime', 'all-time') for w in words) else 'week',
        'share' in words or 'post' in words,
    )


USAGE = '\n'.join([
    '*REV12 time trial*',
    '• `/race`: the fastest laps of the last 7 days',
    '• `/race all`: the all-time board',
    '• `/race share`: post the board in this channel (add `all` for all time)',
])

MEDALS = ['🥇', '🥈', '🥉']


def board_text(rows: list[BoardRow], period: Period, share: bool, viewer: str | None = None) -> str:
    title = '*REV12 time trial: last 7 days*' if period == 'week' else '*REV12 time trial: all time*'
    if not rows:
        return f"{title}\nNo laps {'this week' if period == 'week' else 'yet'}. Be the first: {config.race.site_url}"

    def who(r: BoardRow) -> str:
        return f"<@{r['slack_id']}>" if not share and r['slack_id'] else r['name']

    lines = []
    for r in rows:
        place = MEDALS[r['rank'] - 1] if 1 <= r['rank'] <= len(MEDALS) else f"{r['rank']}."
        extra = ', '.join(
            x
            for x in [
                f"+{r['cones']} cone{'s' if r['cones'] > 1 else ''}" if r['cones'] else '',
                f"{r['laps']} lap{'s' if r['laps'] > 1 else ''}",
            ]
            if x
        )
        lines.append(f"{place} {who(r)}  `{format_lap(r['time_ms'])}`  _{extra}_")
    mine = next((r for r in rows if r['slack_id'] == viewer), None) if viewer else None
    if share:
        footer = ''
    elif mine:
        footer = f"\nYou're P{mine['rank']} with {format_lap(mine['time_ms'])}."
    else:
        footer = '\nYou’re not on this board yet.'
    return '\n'.join([title, *lines]) + footer


def board_message(rows: list[BoardRow], period: Period, share: bool, viewer: str | None = None) -> dict[str, Any]:
    text = board_text(rows, period, share, viewer)
    return {
        'response_type': 'in_channel' if share else 'ephemeral',
        'text': text,
        'blocks': [
            {'type': 'section', 'text': {'type': 'mrkdwn', 'text': text}},
            {
                'type': 'actions',
                'elements': [
                    {
                        'type': 'button',
                        'text': {'type': 'plain_text', 'text': 'Beat these times' if rows else 'Race now'},
                        'url': config.race.site_url,
                        'style': 'primary',
                        'action_id': 'race_open',
                    }
                ],
            },
        ],
    }


def register_race_command(app: App, load: Callable[[Period], list[BoardRow]] = fetch_board) -> None:
    # the button is a plain link; Slack still sends an action, which needs an ack
    @app.action('race_open')
    def _race_open(ack):
        ack()

    @app.command('/race')
    def _race(ack, command, respond):
        ack()
        parsed = parse_race(command.get('text') or '')
        if parsed.kind == 'help':
            respond(response_type='ephemeral', text=USAGE)
            return
        if not race_configured():
            respond(
                response_type='ephemeral',
                text=f'The time trial leaderboard isn’t connected yet (RACE_SUPABASE_URL / RACE_SUPABASE_SERVICE_KEY). You can still race at {config.race.site_url}',
            )
            return
        try:
            rows = load(parsed.period)
            respond(**board_message(rows, parsed.period, share=parsed.share, viewer=command.get('user_id')))
        except Exception as err:
            logger.error('/race failed', err)
            respond(response_type='ephemeral', text=f'✗ Couldn’t load the leaderboard: {err}')

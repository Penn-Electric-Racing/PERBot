"""The REV12 members' time trial leaderboard (race.pennelectricracing.com), read from its Supabase
database. `bot_leaderboard` can only be called with the service_role key, which lives on this server.
"""
from __future__ import annotations

import math
import time
from datetime import datetime, timezone
from typing import Any, Literal, TypedDict

import httpx

from ..config import config
from ..utils.clock import to_iso


class BoardRow(TypedDict):
    rank: int
    name: str
    slack_id: str | None
    time_ms: int
    cones: int
    laps: int
    set_at: str


Period = Literal['week', 'all']

WEEK_MS = 7 * 24 * 60 * 60 * 1000


def race_configured() -> bool:
    return bool(config.race.supabase_url and config.race.service_key)


def fetch_board(period: Period, limit: int = 10, now_ms: float | None = None, http: Any = None) -> list[BoardRow]:
    now = time.time() * 1000 if now_ms is None else now_ms
    since = to_iso(datetime.fromtimestamp((now - WEEK_MS) / 1000, tz=timezone.utc)) if period == 'week' else None
    client = http or httpx
    res = client.post(
        f"{config.race.supabase_url.rstrip('/')}/rest/v1/rpc/bot_leaderboard",
        headers={
            'apikey': config.race.service_key,
            'Authorization': f'Bearer {config.race.service_key}',
            'Content-Type': 'application/json',
        },
        json={'since': since, 'lim': limit},
        timeout=10,
    )
    if not res.is_success:
        raise RuntimeError(f'leaderboard request failed ({res.status_code}): {res.text[:200]}')
    return res.json()


def format_lap(ms: float) -> str:
    """41234 → "0:41.23" """
    t = ms / 1000
    m = math.floor(t / 60)
    s = t - m * 60
    return f"{m}:{'0' if s < 10 else ''}{s:.2f}"

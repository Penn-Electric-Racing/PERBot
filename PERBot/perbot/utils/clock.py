"""JS-style timestamps: the bot's JSON files and Notion writes use `Date#toISOString()` format."""
from __future__ import annotations

from datetime import datetime, timezone


def to_iso(dt: datetime) -> str:
    """`date.toISOString()`: UTC, millisecond precision, trailing Z."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def iso_now() -> str:
    return to_iso(datetime.now(timezone.utc))


def parse_iso(value: str) -> datetime:
    """Parses ISO strings Notion/Slack/JS emit ("2026-09-20", "…T15:00:00.000Z", "…+00:00").
    Date-only strings are midnight UTC, like `new Date('2026-09-20')`."""
    v = value.strip()
    if v.endswith('Z'):
        v = v[:-1] + '+00:00'
    dt = datetime.fromisoformat(v)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def now_ms() -> int:
    """`Date.now()`."""
    return int(datetime.now(timezone.utc).timestamp() * 1000)

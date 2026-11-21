"""Helpers shared by every feature: plain functions, no classes.

    from core import utils
    utils.price(0.0425)          # "0.0425"
    utils.to_iso(dt)             # "2026-11-21T16:50:56.358Z"
    utils.is_slot_open('Wednesday', 9)

  text     tokenizing and snippets for search, Slack escaping, JS-compatible number formatting
  time     JS-style ISO timestamps, and PER's timezone (America/New_York): dates, wall-clock
           times, and the late-tolerant cron slot check
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Literal
from zoneinfo import ZoneInfo

EASTERN = ZoneInfo('America/New_York')

WeekdayET = Literal['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']


# --- text -----------------------------------------------------------------------------------------


def clean_whitespace(text: str) -> str:
    return re.sub(r'\s+', ' ', text).strip()


def strip_markdown(text: str) -> str:
    """Markdown → plain text for tokenizing and for the excerpts shown in Slack."""
    s = re.sub(r'```[a-z]*\n?', ' ', text)
    s = re.sub(r'`([^`]+)`', r'\1', s)
    s = re.sub(r'!\[[^\]]*\]\([^)]*\)', ' ', s)
    s = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', s)
    s = re.sub(r'^#{1,6}\s+', '', s, flags=re.M)
    s = re.sub(r'^>\s+', '', s, flags=re.M)
    s = re.sub(r'^\s*[-*]\s+\[[ x]\]\s+', '', s, flags=re.M)
    s = re.sub(r'[*_~]', ' ', s)
    return clean_whitespace(s)


def tokenize(text: str) -> list[str]:
    return [t for t in re.split(r'[^a-z0-9]+', strip_markdown(text).lower()) if len(t) >= 2]

# Words that carry no retrieval signal in a question ("tell me about the PCM").

STOPWORDS = frozenset([
    'a', 'an', 'the', 'of', 'for', 'in', 'on', 'to', 'and', 'or', 'with', 'is', 'are', 'was', 'were', 'be',
    'it', 'its', 'this', 'that', 'these', 'those', 'i', 'we', 'our', 'you', 'your', 'me', 'my', 'us',
    'tell', 'about', 'what', 'whats', 'how', 'do', 'does', 'did', 'can', 'could', 'should', 'would',
    'where', 'when', 'which', 'who', 'why', 'explain', 'describe', 'show', 'find', 'give', 'info',
    'information', 'docs', 'doc', 'documentation', 'page', 'please', 'pls', 'any', 'some', 'there',
    'per', 'team', 'car', 'like', 'get', 'know', 'need', 'want', 'have', 'has', 'at', 'by', 'from', 'as',
    'up', 'so', 'if', 'into', 'out', 'more', 'all',
])


def content_terms(text: str) -> list[str]:
    return [t for t in tokenize(text) if t not in STOPWORDS]


def make_snippet(text: str, max_len: int = 220) -> str:
    cleaned = strip_markdown(text)
    if len(cleaned) <= max_len:
        return cleaned
    return f'{cleaned[: max_len - 1].strip()}…'


def excerpt_around_match(text: str, query: str, max_len: int = 240) -> str:
    cleaned = strip_markdown(text)
    if not cleaned:
        return ''

    tokens = content_terms(query)
    if not tokens:
        return make_snippet(cleaned, max_len)

    haystack = cleaned.lower()
    first_index = -1
    for token in tokens:
        idx = haystack.find(token)
        if idx != -1 and (first_index == -1 or idx < first_index):
            first_index = idx

    if first_index == -1:
        return make_snippet(cleaned, max_len)

    start = max(0, first_index - max_len // 3)
    if start > 0:
        ws = cleaned.find(' ', start)
        if ws != -1 and ws - start < 20:
            start = ws + 1
    end = min(len(cleaned), start + max_len)
    prefix = '…' if start > 0 else ''
    suffix = '…' if end < len(cleaned) else ''
    return f'{prefix}{cleaned[start:end].strip()}{suffix}'


def js_number(n: float | int) -> str:
    """`String(n)` for a JSON number: 3.0 → "3", 2.5 → "2.5"."""
    if isinstance(n, float) and n.is_integer():
        return str(int(n))
    return str(n)


def locale_int(n: float | int) -> str:
    """`n.toLocaleString('en-US')` for whole numbers: 12345 → "12,345"."""
    return f'{round(n):,}'


def js_round(n: float) -> int:
    """`Math.round(n)`: halves round up (toward +∞), unlike Python's banker's `round`."""
    return math.floor(n + 0.5)


def round2(n: float) -> float:
    """`Math.round(n * 100) / 100`."""
    return math.floor(n * 100 + 0.5) / 100


def escape(text: str) -> str:
    """Escape &, < and > for Slack mrkdwn (names and labels from Notion or scraped pages)."""
    return text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def money(n: float) -> str:
    """1,234.50: always 2 decimals."""
    return f'{n:,.2f}'


def price(n: float) -> str:
    """A unit price: 2 decimals, up to 4 for sub-dollar prices (0.0425)."""
    if n >= 1:
        return f'{n:,.2f}'
    s = f'{n:.4f}'.rstrip('0')
    decimals = s.split('.')[1] if '.' in s else ''
    return s + '0' * max(0, 2 - len(decimals))


def plural(n: int, one: str, many: str | None = None) -> str:
    """"1 row", "2 rows" ("2 boxes" with `many`)."""
    return f"{n} {one if n == 1 else (many or one + 's')}"


# --- timestamps -----------------------------------------------------------------------------------


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


# --- Eastern time ---------------------------------------------------------------------------------


@dataclass
class NowET:
    weekday: WeekdayET
    hour: int
    date_iso: str


def _date(iso: str) -> date:
    return date.fromisoformat(iso[:10])


def today_iso() -> str:
    """Today's date as YYYY-MM-DD in ET."""
    return datetime.now(EASTERN).strftime('%Y-%m-%d')


def now_et(now: datetime | None = None) -> NowET:
    """Today's ET weekday + hour."""
    local = (now or datetime.now(timezone.utc)).astimezone(EASTERN)
    return NowET(weekday=local.strftime('%A'), hour=local.hour, date_iso=local.strftime('%Y-%m-%d'))  # type: ignore[arg-type]


def is_slot_open(weekday: WeekdayET, hour: int, now: datetime | None = None) -> bool:
    """True when it's `weekday` in ET and the clock has reached `hour` (any later time that day
    counts). GitHub's cron fires hours late, so jobs gate on this instead of an exact hour."""
    et = now_et(now)
    return et.weekday == weekday and et.hour >= hour


def days_until(iso: str) -> int:
    """Whole days from today (ET) until `iso` (a YYYY-MM-DD date). Negative = overdue."""
    return (_date(iso) - _date(today_iso())).days


def iso_days_from_now(days: int) -> str:
    """YYYY-MM-DD `days` after today (ET)."""
    return (_date(today_iso()) + timedelta(days=days)).isoformat()


def iso_add_days(date_iso: str, days: int) -> str:
    """YYYY-MM-DD `days` after a given YYYY-MM-DD date (calendar arithmetic, no timezone)."""
    return (_date(date_iso) + timedelta(days=days)).isoformat()


def wall_time_to_utc(date_iso: str, hour: int) -> datetime:
    """The UTC instant of `hour`:00 ET on `date_iso`. DST-aware, so jobs can define windows in
    ET without depending on the runner's timezone (GitHub runners are UTC)."""
    naive = datetime.fromisoformat(f'{date_iso[:10]}T{hour:02d}:00:00').replace(tzinfo=timezone.utc)
    offset = naive.astimezone(EASTERN).utcoffset() or timedelta(hours=-5)
    return naive - offset


def now_time(now: datetime | None = None) -> str:
    """"1:42 PM" in ET — for "done at" stamps on Slack-updated messages."""
    local = (now or datetime.now(timezone.utc)).astimezone(EASTERN)
    h = local.hour % 12 or 12
    return f"{h}:{local.minute:02d} {'AM' if local.hour < 12 else 'PM'}"


def weekday_utc(iso: str) -> int:
    """JS `getUTCDay()` of a YYYY-MM-DD date: 0 = Sunday … 6 = Saturday."""
    return (_date(iso).weekday() + 1) % 7

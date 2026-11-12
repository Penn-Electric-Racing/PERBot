from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

ET = ZoneInfo('America/New_York')


def today_iso_et() -> str:
    """Today's date as YYYY-MM-DD in America/New_York (PER's timezone)."""
    return datetime.now(ET).strftime('%Y-%m-%d')


def _d(iso: str) -> date:
    return date.fromisoformat(iso[:10])


def days_until(iso: str) -> int:
    """Whole days from `iso` (a YYYY-MM-DD date) until today (ET). Negative = overdue."""
    return (_d(iso) - _d(today_iso_et())).days


def iso_days_from_now_et(days: int) -> str:
    """YYYY-MM-DD `days` after today (ET). Used to seed a deal's first next-action date."""
    return (_d(today_iso_et()) + timedelta(days=days)).isoformat()


def iso_add_days(date_iso: str, days: int) -> str:
    """YYYY-MM-DD `days` after a given YYYY-MM-DD date (calendar arithmetic, no timezone)."""
    return (_d(date_iso) + timedelta(days=days)).isoformat()


def et_wall_time_to_utc(date_iso: str, hour: int) -> datetime:
    """The UTC instant of `hour`:00 wall-clock time in America/New_York on `date_iso`.
    DST-aware (EDT = GMT-4, EST = GMT-5), so jobs can define windows in ET without depending on
    the runner's local timezone (GitHub runners are UTC)."""
    naive = datetime.fromisoformat(f'{date_iso[:10]}T{hour:02d}:00:00').replace(tzinfo=timezone.utc)
    # Same as the JS version: the offset in effect at the naive-UTC instant.
    offset = naive.astimezone(ET).utcoffset() or timedelta(hours=-5)
    return naive - offset


def now_time_et(now: datetime | None = None) -> str:
    """"1:42 PM" in ET — for "done at" stamps on Slack-updated messages."""
    local = (now or datetime.now(timezone.utc)).astimezone(ET)
    h = local.hour % 12 or 12
    return f"{h}:{local.minute:02d} {'AM' if local.hour < 12 else 'PM'}"


def weekday_utc(iso: str) -> int:
    """JS `getUTCDay()` of a YYYY-MM-DD date: 0 = Sunday … 6 = Saturday."""
    return (_d(iso).weekday() + 1) % 7

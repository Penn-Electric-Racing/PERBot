"""Run: `python -m perbot.meeting_notes.generate_notes`"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from .config import SUBSYSTEMS
from .notion_writer import SubsystemContent, create_meeting_notes_page, find_existing_meeting_page_for_today
from .parse_updates import EMPTY_UPDATE, ProcessedMessage, parse_subsystem_updates
from .slack_helpers import (
    find_most_recent_bot_thread,
    get_channel_id,
    get_message_permalink,
    get_thread_replies,
    get_user_display_name,
)
from .time_check import assert_expected_et_hour_range

ET = ZoneInfo('America/New_York')


def main() -> None:
    # Accept any Wednesday run between 11am-1pm ET (target is 12pm, but cron is flaky).
    assert_expected_et_hour_range(11, 13)

    # NOTES_DATE=YYYY-MM-DD overrides the page date for recovery runs after a failed Wednesday
    # cron (noon ET anchor avoids UTC day-boundary drift).
    notes_date = os.environ.get('NOTES_DATE')
    note_date = (
        datetime.fromisoformat(f'{notes_date}T12:00:00-04:00') if notes_date else datetime.now(timezone.utc)
    )

    # Idempotency: if a meeting page for this date already exists, don't create another one
    existing = find_existing_meeting_page_for_today(note_date)
    if existing:
        print(f'⊘ Meeting page for today already exists, skipping generation: {existing}')
        return

    since_unix = _monday_midnight_et_unix()
    print(f'Looking for kickoff threads posted since {datetime.fromtimestamp(since_unix, tz=timezone.utc).isoformat()}')

    contents: list[SubsystemContent] = []
    for sub in SUBSYSTEMS:
        print(f'\n--- Processing {sub.name} (#{sub.slack_channel}) ---')
        try:
            contents.append(_process_subsystem(sub.name, sub.slack_channel, since_unix))
        except Exception as err:
            print(f'Failed to process {sub.name}: {err}', file=sys.stderr)
            contents.append(SubsystemContent(sub.name, EMPTY_UPDATE, None, 0))

    url = create_meeting_notes_page(note_date, contents)
    print(f'\n✓ Meeting notes created: {url}')


def _process_subsystem(name: str, channel_name: str, since_unix: int) -> SubsystemContent:
    channel_id = get_channel_id(channel_name)
    thread_ts = find_most_recent_bot_thread(channel_name, since_unix)
    if not thread_ts:
        print(f'No kickoff thread found in #{channel_name} since Monday', file=sys.stderr)
        return SubsystemContent(name, EMPTY_UPDATE, None, 0)

    replies = get_thread_replies(channel_name, thread_ts)
    thread_link = get_message_permalink(channel_id, thread_ts)
    if not replies:
        print(f'Kickoff thread exists in #{channel_name} but no one replied')
        return SubsystemContent(name, EMPTY_UPDATE, thread_link, 0)

    processed: list[ProcessedMessage] = []
    total_images = 0
    for m in replies:
        author = get_user_display_name(m['user']) if m.get('user') else 'unknown'
        text = (m.get('text') or '').strip()
        image_count = sum(1 for f in m.get('files') or [] if (f.get('mimetype') or '').startswith('image/'))
        total_images += image_count
        permalink = get_message_permalink(channel_id, m['ts']) if m.get('ts') else None
        if text or image_count > 0:
            processed.append(ProcessedMessage(author, text, image_count, permalink))

    print(f'Found {len(replies)} replies, {total_images} images. Parsing...')
    updates = parse_subsystem_updates(name, processed) if processed else EMPTY_UPDATE
    return SubsystemContent(name, updates, thread_link, total_images)


def _monday_midnight_et_unix() -> int:
    et_now = datetime.now(ET)
    days_from_monday = et_now.weekday()  # Monday = 0
    monday = (et_now - timedelta(days=days_from_monday)).replace(hour=0, minute=0, second=0, microsecond=0)
    # Re-localize so the offset is Monday's (DST-correct), not today's.
    monday = monday.replace(tzinfo=None).replace(tzinfo=ET)
    return int(monday.timestamp())


if __name__ == '__main__':
    try:
        main()
    except Exception as err:
        print(f'Generate notes job crashed: {err}', file=sys.stderr)
        sys.exit(1)

"""Run: `python -m perbot.meeting_notes.post_kickoff`"""
from __future__ import annotations

import sys
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from .config import KICKOFF_MESSAGE, SUBSYSTEMS
from .slack_helpers import find_most_recent_bot_thread, post_kickoff_message
from .time_check import assert_expected_et_hour_range


def main() -> None:
    # Accept any Monday run between 8am-12pm ET. Cron may be delayed; the idempotency check below
    # ensures we don't post duplicate kickoffs.
    assert_expected_et_hour_range(8, 12)

    now = datetime.now(ZoneInfo('America/New_York'))
    date_str = f"{now.strftime('%B')} {now.day}"
    message = KICKOFF_MESSAGE.replace('{date}', date_str)

    # Look back 24 hours to detect existing kickoff threads (today's posts)
    since_unix = int(time.time()) - 24 * 60 * 60

    results: list[tuple[str, str, str]] = []
    for sub in SUBSYSTEMS:
        try:
            existing = find_most_recent_bot_thread(sub.slack_channel, since_unix)
            if existing:
                print(f'⊘ Kickoff already posted in #{sub.slack_channel} (ts={existing}), skipping')
                results.append((sub.slack_channel, 'skipped', ''))
                continue
            ts = post_kickoff_message(sub.slack_channel, message)
            print(f'✓ Posted in #{sub.slack_channel} (ts={ts})')
            results.append((sub.slack_channel, 'ok', ''))
        except Exception as err:
            print(f'✗ Failed for #{sub.slack_channel}: {err}', file=sys.stderr)
            results.append((sub.slack_channel, 'fail', str(err)))

    posted = sum(1 for r in results if r[1] == 'ok')
    skipped = sum(1 for r in results if r[1] == 'skipped')
    failures = [r for r in results if r[1] == 'fail']
    print(f'\nSummary: {posted} posted, {skipped} already existed, {len(failures)} failed.')
    if failures:
        sys.exit(1)


if __name__ == '__main__':
    try:
        main()
    except Exception as err:
        print(f'Kickoff post job crashed: {err}', file=sys.stderr)
        sys.exit(1)

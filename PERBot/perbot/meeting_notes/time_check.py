"""GitHub Actions cron is unreliable — runs can be delayed by hours, especially on Mondays. To
work around this, we schedule the workflow to fire many times across a window, and use this check
+ idempotency in the script itself to ensure only one effective run happens per scheduled
occurrence.

Manual (workflow_dispatch) runs always pass the time check so testing works.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo


def assert_expected_et_hour_range(min_hour: int, max_hour: int) -> None:
    if os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch':
        print('Manual run detected — skipping time check.')
        return
    et_hour = datetime.now(ZoneInfo('America/New_York')).hour
    if et_hour < min_hour or et_hour > max_hour:
        print(f'Skipping run — current ET hour is {et_hour}, expected range {min_hour}-{max_hour}.')
        sys.exit(0)


def assert_expected_et_hour(expected_hour: int) -> None:
    """Backward-compatible alias (single hour = accept that hour or the next)."""
    assert_expected_et_hour_range(expected_hour, expected_hour + 1)

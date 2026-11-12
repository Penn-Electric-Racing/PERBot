"""CLI: `python -m sponsorship.fix_next_actions_cli [--apply]`

One-time cleanup (2026-10-22) of deals past Prospect that still say "Send first outreach" (see
next_actions.py for the bug). It prints every planned change, and with --apply it writes them.
Re-running is safe: a fixed deal no longer matches, so it's skipped.
"""
from __future__ import annotations

import os
import sys

from sponsorship.dates import today_iso_et
from sponsorship.next_actions import backfill_next_action
from sponsorship.notion import SponsorNotion


def main(argv: list[str]) -> int:
    apply = '--apply' in argv or (os.environ.get('APPLY') or '').lower() == 'true'
    notion = SponsorNotion()
    today = today_iso_et()

    deals = notion.query_all_deals()
    plan = [(d, change) for d in deals if (change := backfill_next_action(d, today))]

    follow_ups = [p for p in plan if p[1].action]
    print(
        f'{len(deals)} deals; {len(plan)} to fix: {len(follow_ups)} get a follow-up, {len(plan) - len(follow_ups)} cleared.'
        f"{'' if apply else ' (dry run, pass --apply to write)'}"
    )
    for deal, change in plan:
        to = f'"{change.action}" due {change.date_iso}' if change.action else '(cleared)'
        print(f"  {(deal.stage or ''):<9} {(deal.company or 'Untitled'):<32} → {to}")
    if not apply:
        return 0

    done = 0
    code = 0
    for deal, change in plan:
        try:
            notion.apply_next_action(deal.id, change)
            done += 1
        except Exception as err:
            print(f'  ✗ {deal.company or deal.id}: {err}', file=sys.stderr)
            code = 1
    print(f'Wrote {done}/{len(plan)}.')
    return code


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

"""CLI: `python -m sponsorship.discovery_cli find "<need>"` / `… scout "<need>"`

Mirrors the `/sponsor find` and `/sponsor scout` Slack commands for testing without Slack. Both are
read-only (no Notion writes, no Hunter credits).
"""
from __future__ import annotations

import sys

from utils.text import js_number
from sponsorship.discovery import find_matching_prospects, scout_companies
from sponsorship.notion import SponsorNotion
from sponsorship.scoring import priority_score, quadrant

USAGE = 'Usage: python -m sponsorship.discovery_cli find "<need>"  |  … scout "<need>"'


def main(argv: list[str]) -> int:
    mode = argv[0] if argv else ''
    need = ' '.join(argv[1:]).strip()
    if mode not in ('find', 'scout') or not need:
        print(USAGE, file=sys.stderr)
        return 1

    notion = SponsorNotion()

    if mode == 'find':
        rows = [r for r in notion.query_rankable_prospects() if r.status == 'Available']
        print(f'\nSearching {len(rows)} unclaimed Bank leads for: {need}\n')
        matches = find_matching_prospects(need, rows)
        if not matches:
            print('No matches.\n')
            return 0
        for i, m in enumerate(matches):
            print(f'{i + 1}. {m.row.company} — {m.why}')
            print(f'   priority {js_number(priority_score(m.row.scores))} {quadrant(m.row.scores)} · {m.row.url}')
        print('')
        return 0

    known = notion.query_all_bank_domains()
    print(f'\nScouting new companies for: {need} (skipping {len(known)} known domains)\n')
    result = scout_companies(need, known)
    if not result.candidates:
        print(f'No candidates survived ({result.rejected_count} rejected by the homepage check).\n')
        return 0
    for c in result.candidates:
        badge = '✓' if c.verdict == 'confirmed' else '⚠️ unverified'
        print(f'{badge}  {c.company} ({c.hostname}) — {c.why}')
        if c.note:
            print(f'   verifier: {c.note}')
    if result.rejected_count > 0:
        print(f"\n{result.rejected_count} suggestion(s) dropped — homepage didn't match the claim.")
    print('\nAdd keepers with: python -m sponsorship.enrich_cli "<domain>"  (or /sponsor add <domain> in Slack)\n')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

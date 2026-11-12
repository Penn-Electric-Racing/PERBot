"""CLI: `python -m sponsorship.draft_cli "<company>" ["Sender Name"] ["inline ask"]`

Drafts the outreach email for one existing Bank prospect (same path as `/sponsor email`, minus
Slack): fills the team template, generates the fit paragraph (steered by the 🎯 Specific ask toggle
and/or the inline ask), writes the draft toggle onto the Bank page, and prints the email. Without a
sender name the [NAME] placeholder is left for a human.
"""
from __future__ import annotations

import sys

from sponsorship.email_draft import draft_outreach_email
from sponsorship.notion import SponsorNotion

USAGE = 'Usage: python -m sponsorship.draft_cli "<company>" ["Sender Name"] ["inline ask"]'


def main(argv: list[str]) -> int:
    args = [a.strip() for a in argv]
    company = args[0] if args else ''
    sender_name = args[1] if len(args) > 1 else ''
    ask = args[2] if len(args) > 2 else ''
    if not company:
        print(USAGE, file=sys.stderr)
        return 1

    notion = SponsorNotion()
    try:
        rows = notion.find_bank_rows_by_company(company)
        if len(rows) > 1:
            row = next((r for r in rows if r.company.lower() == company.lower()), None)
        else:
            row = rows[0] if rows else None
        if not row:
            if len(rows) > 1:
                print(f'\n✗  "{company}" matches several prospects — be more specific:', file=sys.stderr)
                for r in rows[:8]:
                    print(f'   • {r.company}  {r.url}', file=sys.stderr)
                print('', file=sys.stderr)
            else:
                print(
                    f'\n✗  No Bank prospect matches "{company}". Add it first: '
                    f'python -m sponsorship.enrich_cli "{company}"\n',
                    file=sys.stderr,
                )
            return 1

        result = draft_outreach_email(notion, row, sender_name, ask)
    except Exception as err:
        print(f'\n✗  Draft failed: {err}\n', file=sys.stderr)
        return 1

    print(f'\n📧  Drafted outreach for {result.company}')
    if result.has_ask:
        print('   🎯 Includes the specific ask (specs verbatim).')
    if not result.grounded:
        print('   ⚠️  Homepage unreachable — paragraph uses stored research only; review closely.')
    print(f'   Draft: {result.draft_url}')
    print('\n──────────────────────────────────────────────\n')
    print(result.email_text)
    print('\n──────────────────────────────────────────────')
    print('AI-assisted draft — review before sending.\n')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

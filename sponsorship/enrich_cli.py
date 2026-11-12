"""CLI: `python -m sponsorship.enrich_cli "<company or url>"`

Runs the enrichment pipeline for one company and prints a summary. Env is loaded via config.py
(dotenv). Useful for seeding the Bank and for testing the pipeline without Slack.
"""
from __future__ import annotations

import sys

from utils.text import js_number
from sponsorship.enrich_company import DomainResolutionError, enrich_company


def main(argv: list[str]) -> int:
    text = ' '.join(argv).strip()
    if not text:
        print('Usage: python -m sponsorship.enrich_cli "<company or url>"', file=sys.stderr)
        return 1

    try:
        result = enrich_company(text)
    except DomainResolutionError as err:
        print(f'\n✗  {err}\n', file=sys.stderr)
        return 1
    except Exception as err:
        print(f'\n✗  Enrichment failed: {err}\n', file=sys.stderr)
        return 1

    if result.deduped:
        print('\n↩︎  Already in the Bank — skipped.')
        print(f'   Company: {result.company}')
        print(f'   Domain:  {result.domain}')
        print(f'   Row:     {result.bank_page_url}\n')
        return 0

    c = result.classification
    assert c is not None
    contact = (
        f"{result.contact.name or '(no name)'} <{result.contact.email}> "
        f'— {result.contact.verification_status}, confidence {js_number(result.contact.confidence)}'
        if result.contact
        else '(none found)'
    )

    print('\n✅  Added to the Prospect Bank')
    print(f'   Company:  {result.company}')
    print(f'   Domain:   {result.domain}')
    print(f'   Type:     {c.type}   Channel: {c.channel}')
    print(f"   Category: {', '.join(c.categories)}")
    print(
        f'   Scores:   market {c.market_fit}/3 · value {c.value_band}/3 · need {c.category_need}/3 (AI) — '
        'set Contact strength + Sponsors other teams in Notion'
    )
    print(f'   Fit:      {c.fit_reason}')
    print(f"   Angle:    {c.suggested_angle or '(none)'}")
    print(f'   Contact:  {contact}')
    if result.fsae is None:
        print('   FSAE:     scan failed (run `python -m sponsorship.fsae_scan_cli` to retry)')
    elif result.fsae.ties:
        people = '; '.join(f'{p.name}: "{p.quote}"' for p in result.fsae.people)
        print(f'   FSAE:     🏁 {people}')
    else:
        print(f'   FSAE:     no ties found ({len(result.fsae.pages_scanned)} pages scanned)')
    if result.needs_review:
        print(f'   ⚠️  Needs review: {result.review_reason}')
    print(f'   Row:      {result.bank_page_url}\n')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

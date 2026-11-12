"""CLI: `python -m sponsorship.fsae_scan_cli [--dry-run] [--rescan] [--limit N] [--out report.csv]`

Backfills the FSAE-ties scan across every live Bank lead (Available + Claimed; the same set
`/sponsor rank` ranks). Rows already scanned are skipped unless --rescan, so a re-run only retries
the ones that failed. --dry-run prints results without writing.
"""
from __future__ import annotations

import argparse
import csv
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from sponsorship.dates import today_iso_et
from sponsorship.domain import extract_hostname
from sponsorship.fsae_ties import FsaeScan, format_fsae_evidence, scan_fsae_ties
from sponsorship.models import BankLeadRow
from sponsorship.notion import SponsorNotion

CONCURRENCY = 4


@dataclass
class _Result:
    row: BankLeadRow
    scan: FsaeScan | None = None
    error: str | None = None


def _csv_cell(s: str) -> str:
    return ' | '.join(part.strip() for part in s.split('\n')) if '\n' in s else s


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog='python -m sponsorship.fsae_scan_cli')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--rescan', action='store_true')
    parser.add_argument('--limit', type=int, default=None)
    parser.add_argument('--out')
    args = parser.parse_args(argv)

    notion = SponsorNotion()
    if not args.dry_run:
        added = notion.ensure_fsae_columns()
        if added:
            print(f"Added Bank columns: {', '.join(added)}")

    live = notion.query_rankable_prospects()
    todo = [r for r in live if args.rescan or not r.fsae_scanned_at]
    if args.limit is not None:
        todo = todo[: args.limit]
    print(f"{len(live)} live Bank rows; scanning {len(todo)}{' (dry run)' if args.dry_run else ''}.")

    today = today_iso_et()
    results: list[_Result] = []
    lock = threading.Lock()

    def scan_one(row: BankLeadRow) -> None:
        host = extract_hostname(row.domain)
        if not host:
            result = _Result(row, error='no domain')
        else:
            try:
                scan = scan_fsae_ties(row.company, host)
                if not args.dry_run:
                    notion.write_fsae_scan(row.id, scan, today)
                result = _Result(row, scan=scan)
                if scan.ties or scan.company_mentions:
                    evidence = ' / '.join(format_fsae_evidence(scan).split('\n'))
                    print(f"  {'🏁' if scan.ties else '· '} {row.company}: {evidence}")
            except Exception as err:
                result = _Result(row, error=str(err))
        with lock:
            results.append(result)
            if len(results) % 25 == 0:
                print(f'  …{len(results)}/{len(todo)}')

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        list(pool.map(scan_one, todo))

    ties = [r for r in results if r.scan and r.scan.ties]
    company = [r for r in results if r.scan and not r.scan.ties and r.scan.company_mentions]
    failed = [r for r in results if r.error]
    no_pages = [r for r in results if r.scan and not r.scan.pages_scanned]
    print(
        f'\nScanned {len(results)}: 🏁 {len(ties)} with FSAE ties · {len(company)} company-level FSAE mentions only · '
        f'{len(no_pages)} unreachable sites · {len(failed)} errors.'
    )
    for f in failed:
        print(f'  ✗ {f.row.company} ({f.row.domain}): {f.error}')

    if args.out:
        with open(args.out, 'w', newline='', encoding='utf-8') as fh:
            writer = csv.writer(fh, quoting=csv.QUOTE_ALL)
            writer.writerow(['company', 'domain', 'fsae_ties', 'people', 'evidence', 'pages_scanned', 'error', 'url'])
            for r in results:
                writer.writerow(
                    [
                        _csv_cell(v)
                        for v in [
                            r.row.company,
                            r.row.domain,
                            str(r.scan.ties).lower() if r.scan else '',
                            '; '.join(p.name for p in r.scan.people) if r.scan else '',
                            format_fsae_evidence(r.scan) if r.scan else '',
                            str(len(r.scan.pages_scanned)) if r.scan else '',
                            r.error or '',
                            r.row.url,
                        ]
                    ]
                )
        print(f'Report: {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

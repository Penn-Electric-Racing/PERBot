"""Smoke test for the price-check buttons without a real price check: DMs one Slack user a test
alert for a real Purchasing row, built exactly like a real one (views.PriceAlert). Posting writes nothing to
Notion; tapping a button does (once the bot is running). Test alerts carry `x: 1`,
so the savings ledger skips them.

  python -m price_check.cli <notion row url|id> <price> --to <Slack user id> [--supplier DigiKey] [--link <url>]

<price> is in the row's own units (per pack on pack rows). Use a throwaway row (not Exported?):
the buttons write its real Unit cost.
"""
from __future__ import annotations

import argparse
import sys

from core import utils
from core.config import config
from core.log import setup_logging
from core.notion import Notion, page_id_from
from core.slack import Slack
from price_check.database import PurchasingPrices
from price_check.models import Finding, Listing
from price_check.views import PriceAlert

__all__ = ['main']


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog='python -m price_check.cli', description='DM yourself a test price alert.')
    p.add_argument('row', help='Notion row URL or id')
    p.add_argument('price', type=float, help="the 'found' price, in the row's units")
    p.add_argument('--to', required=True, help='Slack user id to DM')
    p.add_argument('--supplier', default='Test supplier')
    p.add_argument('--link', help='listing URL (default: the row\'s own link)')
    a = p.parse_args(argv)
    row_id = page_id_from(a.row)
    if not row_id or not a.price > 0:
        p.error('need a Notion row URL/id and a price above 0')

    row = PurchasingPrices(Notion.shared(), config.price_check).get(row_id)
    if not (row.unit_cost > 0 and row.quantity > 0):
        sys.exit('That row has no Unit cost / Quant. to compare.')
    found = {'url': a.link or row.link, 'unit_cost': a.price / row.pack_size, 'supplier': a.supplier, 'notes': []}
    f = Finding(row, Listing(found), at_link=not a.link, delta_pct=round((a.price - row.unit_cost) / row.unit_cost * 100, 1))
    alert = PriceAlert(f, test=True)
    if alert.buttons() is None:
        sys.exit('No Use / Keep buttons for that link (not http, or over Slack\'s size cap).')
    Slack.shared().chat_postMessage(
        channel=a.to,
        text=f'Test price alert: ${utils.price(row.unit_cost)} → ${utils.price(a.price)}',
        blocks=alert.blocks(),
        unfurl_links=False,
    )
    print(f'Sent to {a.to}. Tap the buttons in Slack; check the row in Notion after each.')


if __name__ == '__main__':
    setup_logging()
    main()

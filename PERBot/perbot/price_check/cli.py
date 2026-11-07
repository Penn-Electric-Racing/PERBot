"""Smoke test for the price-check buttons without the price listener: DMs one Slack user a fake
alert for a real Purchasing row, with the same buttons price_check.py sends. Posting writes nothing
to Notion; tapping a button does (once PERBot with this handler is deployed).

  python -m perbot.price_check.cli <notion row url|id> <price> --to <Slack user id> [--supplier DigiKey] [--link <url>]

Use a throwaway row (not Exported?) — the buttons write its real Unit cost.
"""
from __future__ import annotations

import re
import sys
from typing import Any

from slack_sdk import WebClient

from ..config import config
from .blocks import PRICE_ACTIONS_BLOCK_ID, PRICE_LINKS_BLOCK_ID, PriceSwapValue, encode_value, escape_mrkdwn, money
from .notion import PriceCheckNotion, _plain


def _flag(args: list[str], name: str) -> str | None:
    if name in args:
        i = args.index(name)
        value = args[i + 1] if i + 1 < len(args) else None
        del args[i : i + 2]
        return value
    return None


def main(argv: list[str] | None = None) -> None:
    args = list(sys.argv[1:] if argv is None else argv)
    to = _flag(args, '--to')
    supplier = _flag(args, '--supplier') or 'Test supplier'
    link = _flag(args, '--link')
    row_arg = args[0] if args else ''
    price_arg = args[1] if len(args) > 1 else ''
    m = re.search(r'([0-9a-f]{32}|[0-9a-f-]{36})(?:\?.*)?$', row_arg, re.I)
    row_id = m.group(1) if m else None
    try:
        price = float(price_arg)
    except ValueError:
        price = 0
    if not row_id or not price > 0 or not to:
        print(
            'Usage: python -m perbot.price_check.cli <notion row url|id> <price> --to <Slack user id> [--supplier X] [--link <url>]',
            file=sys.stderr,
        )
        sys.exit(1)

    notion = PriceCheckNotion()
    row = notion.fetch_row(row_id)
    # The row's name / part number / page link, so the test alert reads like price_check.py's.
    page: Any = notion.client.pages.retrieve(row_id)
    props = page.get('properties') or {}
    name = _plain(next((v for v in props.values() if (v or {}).get('type') == 'title'), None))
    part = _plain(props.get('Cat. or model no.'))
    if row.unit_cost is None or row.quantity is None:
        raise RuntimeError('That row has no Unit cost / Quant. to compare.')
    # x: 1 keeps test clicks out of the savings ledger.
    base: PriceSwapValue = {'v': 1, 'r': row.id, 'q': row.quantity, 'o': row.unit_cost, 'x': 1}
    use_value: dict[str, Any] = {**base, 'n': price, 's': supplier}
    if link:
        use_value.update(l=link, ol=row.link)
    use = encode_value(use_value)  # type: ignore[arg-type]
    keep = encode_value(base)
    # Same as price_check.py: a View button for the listing (the --link, else the row's own link).
    candidate = link or row.link
    listing = candidate if re.fullmatch(r'https?://\S+', candidate or '', re.I) else None
    if not use or not keep:
        raise RuntimeError('Button value over 2000 chars (link too long).')

    q = int(row.quantity) if float(row.quantity).is_integer() else row.quantity
    label = escape_mrkdwn(name or part or row.id)
    text = '\n'.join([
        f"🧪 *Test price alert on <{page.get('url')}|{label}>*{f' (`{part}` ×{q})' if part else f' (×{q})'}",
        f'• In Notion: ${money(row.unit_cost)}',
        f'• Now: ${money(price)} at {escape_mrkdwn(supplier)}',
    ])
    blocks: list[dict[str, Any]] = [{'type': 'section', 'text': {'type': 'mrkdwn', 'text': text}}]
    if listing:
        blocks.append(
            {
                'type': 'actions',
                'block_id': PRICE_LINKS_BLOCK_ID,
                'elements': [
                    {
                        'type': 'button',
                        'action_id': 'price_swap_view:0',
                        'url': listing,
                        'text': {'type': 'plain_text', 'text': f'View {supplier} ↗'[:75]},
                    }
                ],
            }
        )
    blocks.append(
        {
            'type': 'actions',
            'block_id': PRICE_ACTIONS_BLOCK_ID,
            'elements': [
                {
                    'type': 'button',
                    'style': 'primary',
                    'text': {'type': 'plain_text', 'text': f'Use ${money(price)} · {supplier}'[:75]},
                    'action_id': 'price_swap_use:0',
                    'value': use,
                    'confirm': {
                        'title': {'type': 'plain_text', 'text': 'Update Notion?'},
                        'text': {
                            'type': 'plain_text',
                            'text': f"Set Unit cost to ${money(price)} ({supplier})? Open the listing first and check it's the right part, in stock, at this price."[:300],
                        },
                        'confirm': {'type': 'plain_text', 'text': 'Update Unit cost'},
                        'deny': {'type': 'plain_text', 'text': 'Not yet'},
                    },
                },
                {
                    'type': 'button',
                    'text': {'type': 'plain_text', 'text': f'Keep ${money(row.unit_cost)}'},
                    'action_id': 'price_swap_keep',
                    'value': keep,
                },
            ],
        }
    )
    WebClient(token=config.slack.bot_token).chat_postMessage(
        channel=to,
        text=f'Test price alert: ${money(row.unit_cost)} → ${money(price)}',
        unfurl_links=False,
        blocks=blocks,
    )
    print(f'Sent to {to}. Tap the buttons in Slack; check the row in Notion after each.')


if __name__ == '__main__':
    try:
        main()
    except Exception as err:
        print(err, file=sys.stderr)
        sys.exit(1)

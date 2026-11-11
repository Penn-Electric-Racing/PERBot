"""Buttons on the price-check DM and the blocks PERBot rewrites them into after a click.

The DM comes from the PER-Purchasing price listener (its own Render service), but it's posted
with PERBot's bot token, so Slack delivers the clicks to PERBot over Socket Mode — the listener
can't receive them. actions.py handles them; Notion stays the system of record.

Contract with PER-Purchasing's price_check.py (change both sides together):
  - the buttons sit in ONE `actions` block with block_id `price_swap_actions`
  - action_ids: `price_swap_use:<i>` (i = 0, 1, … so ids stay unique within the block) and
    `price_swap_keep`; PERBot adds `price_swap_undo` itself
  - value = JSON `PriceSwapValue` (below), ≤ 2000 chars (Slack's cap); `n`/`s`/`l`/`ol` only on
    use buttons
  - Use buttons carry a Slack `confirm` dialog (check the listing first), handled by Slack
  - a separate `price_swap_links` actions block holds View-listing link buttons
    (`price_swap_view:<i>`, url only). It isn't replaced on a click; PERBot only acks them
"""
from __future__ import annotations

import json
import math
import re
from typing import Any, Literal, NotRequired, TypedDict

PRICE_ACTIONS_BLOCK_ID = 'price_swap_actions'
PRICE_RESULT_BLOCK_ID = 'price_swap_result'
PRICE_UNDO_ACTION_ID = 'price_swap_undo'
PRICE_ACTION_RE = re.compile(r'^price_swap_(use|keep|undo)(?::\d+)?$')
PRICE_LINKS_BLOCK_ID = 'price_swap_links'
PRICE_VIEW_RE = re.compile(r'^price_swap_view(?::\d+)?$')

PriceAction = Literal['use', 'keep', 'undo']


def action_kind(action_id: str | None) -> PriceAction | None:
    m = PRICE_ACTION_RE.match(action_id or '')
    return m.group(1) if m else None  # type: ignore[return-value]


class PriceSwapValue(TypedDict):
    v: Literal[1]
    # Purchasing row (Notion page id).
    r: str
    # `Quant.` when the alert was sent.
    q: float
    # `Unit cost` when the alert was sent, as stored (per pack on pack rows).
    o: float
    # `Unit cost` to write, same units as `o`. Use buttons only.
    n: NotRequired[float]
    # Supplier label for the confirmation line.
    s: NotRequired[str]
    # New `Link to product webpage`, only when switching to a different listing.
    l: NotRequired[str]
    # The row's link when the alert was sent; Undo restores it when `l` was written.
    ol: NotRequired[str]
    # Unix seconds the Undo button was issued (set by PERBot; Undo expires after a day).
    t: NotRequired[float]
    # 1 on `price-check try` test alerts: clicks work but aren't written to the savings ledger.
    x: NotRequired[Literal[1]]


SLACK_VALUE_MAX = 2000
PAGE_ID_RE = re.compile(r'^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$', re.I)


def _is_number(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _is_money(x: Any) -> bool:
    return _is_number(x) and x >= 0


def _is_url(x: Any) -> bool:
    return isinstance(x, str) and len(x) <= 2000 and re.fullmatch(r'https?://\S+', x, re.I) is not None


def decode_value(raw: str | None) -> PriceSwapValue | None:
    """Parse a button value; None for anything malformed (a stale or hand-crafted payload)."""
    try:
        v = json.loads(raw or '')
    except (ValueError, TypeError):
        return None
    if not isinstance(v, dict) or v.get('v') != 1 or isinstance(v.get('v'), bool):
        return None
    if not isinstance(v.get('r'), str) or not PAGE_ID_RE.match(v['r']):
        return None
    if not _is_money(v.get('q')) or not _is_money(v.get('o')):
        return None
    if 'n' in v and not (_is_money(v['n']) and v['n'] > 0):
        return None
    if 's' in v and not isinstance(v['s'], str):
        return None
    if 'l' in v and not _is_url(v['l']):
        return None
    if 'ol' in v and v['ol'] != '' and not _is_url(v['ol']):
        return None
    if 't' in v and not _is_number(v['t']):
        return None
    out: PriceSwapValue = {'v': 1, 'r': v['r'], 'q': v['q'], 'o': v['o']}
    if 'n' in v:
        out['n'] = v['n']
    if v.get('s'):
        out['s'] = v['s'][:80]
    if 'l' in v:
        out['l'] = v['l']
    if 'ol' in v:
        out['ol'] = v['ol']
    if 't' in v:
        out['t'] = v['t']
    if v.get('x') == 1 and not isinstance(v.get('x'), bool):
        out['x'] = 1
    return out


def encode_value(v: PriceSwapValue) -> str | None:
    """JSON for a button value, or None when it would exceed Slack's 2000-char cap."""
    s = json.dumps(v, separators=(',', ':'), ensure_ascii=False)
    return s if len(s) <= SLACK_VALUE_MAX else None


def money(n: float) -> str:
    """Like price_check.py's money(): 2 decimals, up to 4 for sub-dollar prices (0.0425)."""
    if n >= 1:
        return f'{n:,.2f}'
    s = f'{n:.4f}'.rstrip('0')
    decimals = s.split('.')[1] if '.' in s else ''
    return s + '0' * max(0, 2 - len(decimals))


def escape_mrkdwn(s: str) -> str:
    """Escape text for mrkdwn (supplier labels come from scraped pages)."""
    return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def result_blocks(text: str, undo: PriceSwapValue | None = None) -> list[dict[str, Any]]:
    """What replaces the buttons: the outcome line, plus an Undo button after a write."""
    blocks: list[dict[str, Any]] = [{'type': 'section', 'block_id': PRICE_RESULT_BLOCK_ID, 'text': {'type': 'mrkdwn', 'text': text}}]
    value = encode_value(undo) if undo else None
    if value:
        blocks.append(
            {
                'type': 'actions',
                'block_id': PRICE_ACTIONS_BLOCK_ID,
                'elements': [
                    {
                        'type': 'button',
                        'text': {'type': 'plain_text', 'text': '↩️ Undo', 'emoji': True},
                        'action_id': PRICE_UNDO_ACTION_ID,
                        'value': value,
                    }
                ],
            }
        )
    return blocks


def replace_actions(existing: list[dict[str, Any]], replacement: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The message with its buttons (and any earlier outcome line) swapped for `replacement`, at the
    buttons' position. The alert text above them is left as sent."""

    def ours(b: Any) -> bool:
        return (b or {}).get('block_id') in (PRICE_ACTIONS_BLOCK_ID, PRICE_RESULT_BLOCK_ID)

    at = next((i for i, b in enumerate(existing) if ours(b)), -1)
    kept = [b for b in existing if not ours(b)]
    if at == -1:
        return [*kept, *replacement]
    insert_at = len([b for b in existing[:at] if not ours(b)])
    return [*kept[:insert_at], *replacement, *kept[insert_at:]]

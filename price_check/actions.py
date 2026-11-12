"""Button handler for the price listener's DMs (see blocks.py for the contract and swap.py for
what a click does). Anyone who can see the alert may click it — DMs reach only the row's Point of
contact, channel fallbacks reach the channel — and the outcome line names who did. One click per
row at a time, so a double-tap can't write the audit line twice.
"""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from functools import lru_cache

from slack_bolt import App

from utils.logger import logger
from price_check.blocks import PRICE_ACTION_RE, PRICE_VIEW_RE
from price_check.ledger import PriceLedger
from price_check.notion import PriceCheckNotion
from price_check.swap import ClickInput, PriceSwapDeps, handle_price_swap

_in_flight: set[str] = set()
_in_flight_lock = threading.Lock()


@lru_cache(maxsize=1)
def _notion() -> PriceCheckNotion:
    return PriceCheckNotion()


@lru_cache(maxsize=1)
def _ledger() -> PriceLedger:
    return PriceLedger()


def register_price_check_actions(app: App) -> None:
    # View-listing link buttons: Slack opens the URL itself but still reports the click, and an
    # un-acked click shows an error icon on the button.
    @app.action(PRICE_VIEW_RE)
    def _view(ack):
        ack()

    @app.action(PRICE_ACTION_RE)
    def _swap(ack, body, action, respond, client):
        ack()
        action_id = action.get('action_id', '')
        clicker = (body.get('user') or {}).get('id')
        if not clicker:
            return

        def whisper(text: str) -> None:
            respond(response_type='ephemeral', replace_original=False, text=text)

        def display_name(user: str) -> str | None:
            try:
                u = client.users_info(user=user).get('user') or {}
            except Exception:
                return None
            return (u.get('profile') or {}).get('real_name') or u.get('real_name') or u.get('name') or None

        row_id = ''
        try:
            parsed = json.loads(action.get('value') or '{}')
            row_id = parsed.get('r') or '' if isinstance(parsed, dict) else ''
        except ValueError:
            pass  # handle_price_swap reports the bad value
        with _in_flight_lock:
            if row_id and row_id in _in_flight:
                busy = True
            else:
                busy = False
                if row_id:
                    _in_flight.add(row_id)
        if busy:
            whisper('Already updating this row, one moment.')
            return

        notion = _notion()
        try:
            result = handle_price_swap(
                PriceSwapDeps(
                    fetch_row=notion.fetch_row,
                    write_row=notion.write_row,
                    display_name=display_name,
                    now=lambda: datetime.now(timezone.utc),
                ),
                ClickInput(action_id, action.get('value'), clicker, (body.get('message') or {}).get('blocks')),
            )
            if result.blocks is not None:
                respond(replace_original=True, blocks=result.blocks, text=result.text or 'Price check')
            elif result.whisper:
                whisper(result.whisper)
            logger.info(f"Price check button: {clicker} → {action_id} on {row_id or '?'}: {result.log}")
            # After the reply, so the ledger never slows the click down or fails it.
            if result.ledger:
                event = result.ledger

                def record() -> None:
                    try:
                        what = _ledger().record(event, display_name(clicker) or clicker, notion.fetch_row)
                        logger.info(f'Price check ledger: {row_id}: {what}')
                    except Exception as err:
                        logger.warn(f"Price check ledger: couldn't record {event.kind} on {row_id}", err)

                threading.Thread(target=record, daemon=True).start()
        except Exception as err:
            logger.error(f'Price check button {action_id} failed', err)
            whisper('✗ Could not update Notion. Try again, or change *Unit cost* in Notion.')
        finally:
            if row_id:
                with _in_flight_lock:
                    _in_flight.discard(row_id)

"""The price alert DM and its buttons.

  PriceAlert     the DM for a Finding: its text, View-listing links and Use / Keep buttons
  SwapHandler    what a click does. Pure apart from the injected Notion / Slack calls (SwapDeps),
                 so it's tested without either
  PriceAlertView the buttons' Slack callbacks (core.ui.View)

The contract between the DM and the handler (change both sides together):
  - the buttons sit in ONE `actions` block with block_id `price_swap_actions`
  - action_ids: `price_swap_use:<i>` (i = 0, 1, … so ids stay unique within the block) and
    `price_swap_keep`; PERBot adds `price_swap_undo` itself
  - value = JSON PriceSwapValue, ≤ 2000 chars (Slack's cap); `n`/`s`/`l`/`ol` only on use buttons
  - Use buttons carry a Slack `confirm` dialog (check the listing first), handled by Slack
  - a separate `price_swap_links` actions block holds View-listing link buttons
    (`price_swap_view:<i>`, url only). It isn't replaced on a click; PERBot only acks them

Use: re-read the row and write the alert's price only if the row still reads what the alert saw
(same Unit cost and Quant., not yet ordered); otherwise say what changed and write nothing. Keep:
no write. Undo: the reverse write, under the same guards, for a day. Every click is also returned
as a LedgerEvent for the savings ledger.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Awaitable, Callable

from core import aio, utils
from core.blocks import Actions, Button, Confirm, Section, render
from core.types.slack import Block
from core.ui import Interaction, View, button
from price_check.enums import ACTION_RE, ClickKind, ClickOutcome, SwapPlanKind
from price_check.models import (
    Finding,
    LedgerEvent,
    Listing,
    Notes,
    PriceRow,
    RowPatch,
    SwapValue,
)

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from price_check.database import PurchasingPrices, SavingsLedger

__all__ = [
    'PriceAlert', 'SwapDeps', 'ClickInput', 'ClickResult', 'SwapHandler', 'PriceAlertView', 'result_blocks',
    'replace_actions',
]

ACTIONS_BLOCK_ID = 'price_swap_actions'
RESULT_BLOCK_ID = 'price_swap_result'
LINKS_BLOCK_ID = 'price_swap_links'
UNDO_ACTION_ID = 'price_swap_undo'
VIEW_RE = re.compile(r'^price_swap_view(?::\d+)?$')
HTTP_URL_RE = re.compile(r'^https?://\S+$', re.I)

UNDO_WINDOW_S = 24 * 3600


# --- the DM ---------------------------------------------------------------------------------------


class PriceAlert:
    """The Slack message for one Finding. `test=True` makes a `price_check.cli` test alert."""

    def __init__(self, finding: Finding, test: bool = False):
        self.finding, self.test = finding, test

    def text(self) -> str:
        """Slack mrkdwn for the alert (emoji lead, <url|label> links)."""
        f, money, esc = self.finding, utils.price, utils.escape
        row, qty = f.row, f.row.units
        up = f.delta_pct > 0
        where = 'at your link' if f.at_link else 'best option found'
        supplier = esc(f.found.supplier or 'listing')
        lead = (
            '🧪 *Test price alert'
            if self.test
            else f"{':chart_with_upwards_trend:' if up else ':chart_with_downwards_trend:'} *Price {'went up' if up else 'dropped'}"
        )
        lines = [
            f'{lead} on <{row.url}|{esc(row.name or row.part_number)}>* (`{row.part_number}` ×{qty})',
            f'• In Notion: ${money(row.unit_price)}/unit (${money(row.unit_price * qty)})'
            + (f', ${money(row.unit_cost)}/pack of {row.pack_size}' if row.pack_size > 1 else ''),
            f'• Now ({where}): ${money(f.found_unit)}/unit{f.found.price_break} '
            f'(${money(f.found_unit * qty)}) at <{f.found.url}|{supplier}> - *{f.delta_pct:+.0f}%*',
        ]
        if f.cheaper:
            c = f.cheaper
            lines.append(
                f'• Cheaper option: ${money(c.unit_cost)}/unit at <{c.url}|{esc(c.supplier or "listing")}>'  # type: ignore[arg-type]
                + (f' ({c.flags[0]})' if c.flags else '')
            )
        if f.found.flags:
            lines.append(f"• Flags: {'; '.join(f.found.flags)}")
        lines.append(
            '_Tap a button to update `Unit cost` in Notion, or edit it there. Prices '
            'are read automatically from the listing, so check before ordering._'
        )
        return '\n'.join(lines)

    def _value(self, **extra: object) -> SwapValue:
        row = self.finding.row
        return SwapValue(row.id, row.quantity, row.unit_cost, test=self.test, **extra)  # type: ignore[arg-type]

    def _use_value(self, listing: Listing) -> SwapValue | None:
        """What a "Use" button for `listing` carries, or None when it can't be carried (no price, a
        non-http link, or over Slack's size cap)."""
        row = self.finding.row
        n = self.finding.row_price(listing.unit_cost)  # type: ignore[arg-type]
        if not n > 0:
            return None
        v = self._value(new=n, supplier=(listing.supplier or 'listing')[:80])
        if not listing.is_at(row.link):
            if not HTTP_URL_RE.match(listing.url):
                return None
            if row.link and not HTTP_URL_RE.match(row.link):
                return None  # Undo couldn't restore it
            v = v.replace(link=listing.url, old_link=row.link)
        return v if v.to_json() is not None else None

    def _offers(self) -> list[tuple[Listing, SwapValue]]:
        """The options that get a Use button: the found price, then an unflagged cheaper one. The
        last is the cheapest offered."""
        f = self.finding
        options = [f.found] + ([f.cheaper] if f.cheaper and not f.cheaper.flags else [])
        return [(o, v) for o, v in ((o, self._use_value(o)) for o in options) if v]

    def _use_button(self, i: int, listing: Listing, v: SwapValue) -> Button:
        supplier, n = v.supplier, v.new or 0
        switch = ' and switch the product link to it' if v.switches_link else ''
        return Button(
            f'Use ${utils.price(listing.unit_cost)}/unit · {supplier}',  # type: ignore[arg-type]
            f'price_swap_use:{i}',
            value=v.to_json(),
            # The human check: Slack asks before anything is written.
            confirm=Confirm(
                'Update Notion?',
                f'Set Unit cost to ${utils.price(n)} ({supplier}){switch}? Open the listing first and '
                "check it's the right part, in stock, at this price.",
                'Update Unit cost',
                'Not yet',
            ),
        )

    def _links(self) -> Actions | None:
        f = self.finding
        links = []
        for i, o in enumerate([f.found] + ([f.cheaper] if f.cheaper else [])):
            if not HTTP_URL_RE.match(o.url) or len(o.url) > 3000:
                continue
            mine = ' (your link)' if o.is_at(f.row.link) else ''
            links.append(Button(f"View {o.supplier or 'listing'}{mine} ↗", f'price_swap_view:{i}', url=o.url))
        return Actions(links, LINKS_BLOCK_ID) if links else None

    def _buttons(self) -> Actions | None:
        f = self.finding
        uses = [self._use_button(i, o, v) for i, (o, v) in enumerate(self._offers())]
        if not uses:
            return None
        uses[-1].style = 'primary'  # the cheapest option offered
        keep = Button(f'Keep ${utils.price(f.row.unit_price)}/unit', 'price_swap_keep', value=self._value().to_json())
        return Actions([*uses, keep], ACTIONS_BLOCK_ID)

    def links(self) -> Block | None:
        """Link buttons that open each option's listing (flagged ones too: looking is harmless), so
        whoever clicks Use has checked the page. None when no listing has an http link."""
        b = self._links()
        return b.to_dict() if b else None

    def buttons(self) -> Block | None:
        """The actions block: Use the found price, Use an unflagged cheaper option, and Keep the
        row's price. None when not even the found price can be a button."""
        b = self._buttons()
        return b.to_dict() if b else None

    def blocks(self, text: str | None = None) -> list[Block]:
        """Block Kit for the DM: the alert text, View-listing links, then Use / Keep."""
        return render(Section(text or self.text()), self._links(), self._buttons())

    def offered(self) -> tuple[float, str, str]:
        """(unit cost in the row's units, supplier, listing url) of the option the alert puts
        first: its primary Use button, or the found price when it has no buttons."""
        f, offers = self.finding, self._offers()
        if offers:
            _, v = offers[-1]
            return v.new, v.supplier, v.link or f.row.link  # type: ignore[return-value]
        return f.row_price(f.found_unit), f.found.supplier, f.found.url


# --- what a click puts back -----------------------------------------------------------------------


def result_blocks(text: str, undo: SwapValue | None = None) -> list[Block]:
    """What replaces the buttons: the outcome line, plus an Undo button after a write."""
    value = undo.to_json() if undo else None
    undo_block = Actions([Button('↩️ Undo', UNDO_ACTION_ID, value=value, emoji=True)], ACTIONS_BLOCK_ID) if value else None
    return render(Section(text, RESULT_BLOCK_ID), undo_block)


def replace_actions(existing: list[Block], replacement: list[Block]) -> list[Block]:
    """The message with its buttons (and any earlier outcome line) swapped for `replacement`, at
    the buttons' position. The alert text above them is left as sent."""

    def ours(b: Block | None) -> bool:
        return (b or {}).get('block_id') in (ACTIONS_BLOCK_ID, RESULT_BLOCK_ID)

    at = next((i for i, b in enumerate(existing) if ours(b)), -1)
    kept = [b for b in existing if not ours(b)]
    if at == -1:
        return [*kept, *replacement]
    insert_at = len([b for b in existing[:at] if not ours(b)])
    return [*kept[:insert_at], *replacement, *kept[insert_at:]]


# --- a click --------------------------------------------------------------------------------------


@dataclass
class SwapDeps:
    fetch_row: Callable[[str], Awaitable[PriceRow]]
    write_row: Callable[[str, RowPatch], Awaitable[None]]
    # The clicker's name for the Notion audit line (None → "a Slack user").
    display_name: Callable[[str], Awaitable[str | None]]
    now: Callable[[], datetime]


@dataclass
class ClickInput:
    action_id: str
    raw_value: str | None
    clicker: str
    # The message's current blocks (body.message.blocks); absent on some containers.
    existing: list[Block] | None


@dataclass
class ClickResult:
    # For the log.
    log: str
    # Rewrite the message to these blocks (replace_original).
    blocks: list[Block] | None = None
    # Plain-text fallback for the rewritten message.
    text: str | None = None
    # Tell only the clicker (ephemeral), leaving the message as is.
    whisper: str | None = None
    # What to record in the savings ledger (written after the reply).
    ledger: LedgerEvent | None = field(default=None)

    @classmethod
    def settle(cls, existing: list[Block] | None, text: str, undo: SwapValue | None = None) -> 'ClickResult':
        """Rewrite the message's buttons to `text` (+ Undo), or whisper it when the message's
        blocks aren't known."""
        if existing is None:
            return cls(log=text, whisper=text.replace('*', ''))
        return cls(log=text, blocks=replace_actions(existing, result_blocks(text, undo)), text=text.replace('*', ''))


class SwapHandler:
    """What a click does. Pure apart from the injected Notion / Slack calls, so it's tested
    without either."""

    def __init__(self, deps: SwapDeps):
        self.deps = deps

    async def handle(self, inp: ClickInput) -> ClickResult:
        deps, money, settle = self.deps, utils.price, ClickResult.settle
        kind = ClickKind.from_action_id(inp.action_id)
        v = SwapValue.from_json(inp.raw_value)
        if not kind or not v:
            return ClickResult(log=f'bad value on {inp.action_id}', whisper='This button is out of date. Update *Unit cost* in Notion instead.')
        who = f'<@{inp.clicker}>'
        time = utils.now_time(deps.now())

        def event(k: ClickOutcome) -> LedgerEvent:
            return LedgerEvent(k, v, inp.clicker, deps.now())

        if kind == ClickKind.KEEP:
            r = settle(inp.existing, f"👍 {who} kept ${money(v.old)}, so Notion wasn't changed · {time}")
            r.ledger = event(ClickOutcome.KEPT)
            return r

        if v.new is None:
            return ClickResult(log='use/undo without n', whisper='This button has no price on it. Update *Unit cost* in Notion instead.')
        if kind == ClickKind.UNDO and v.issued_at is not None and deps.now().timestamp() - v.issued_at > UNDO_WINDOW_S:
            return ClickResult(log='undo expired', whisper='Too late to undo from here. Change *Unit cost* in Notion.')

        row = await deps.fetch_row(v.row_id)
        plan = row.plan_swap(kind, v)
        if plan.kind == SwapPlanKind.REFUSE:
            # A refused Undo leaves the earlier Use standing, so only a refused Use is recorded.
            r = settle(inp.existing, f'⚠️ {plan.reason}')
            if kind == ClickKind.USE:
                r.ledger = event(ClickOutcome.REFUSED)
            return r
        if plan.kind == SwapPlanKind.ALREADY:
            r = settle(inp.existing, f'✅ *Unit cost* is already ${money(v.new if kind == ClickKind.USE else v.old)} in Notion.')
            r.ledger = event(ClickOutcome.USED if kind == ClickKind.USE else ClickOutcome.UNDONE)
            return r

        patch = RowPatch(unit_cost=plan.unit_cost, link=plan.link)
        if row.notes is not None:
            notes = Notes(row.notes)
            if kind == ClickKind.USE:
                date = deps.now().astimezone(utils.EASTERN).strftime('%Y-%m-%d')
                new = notes.append_line(v.note_line(await deps.display_name(inp.clicker) or 'a Slack user', date))
            else:
                new = notes.drop_last_line(v.note_prefix)
            if new is not None:
                patch.notes = new
        await deps.write_row(v.row_id, patch)

        supplier = f' ({utils.escape(v.supplier)})' if v.supplier else ''
        if kind == ClickKind.USE:
            link = ' and updated the product link' if v.switches_link else ''
            undo = v.replace(issued_at=int(deps.now().timestamp()))
            r = settle(inp.existing, f'✅ {who} set *Unit cost* to *${money(v.new)}*{supplier}{link} · was ${money(v.old)} · {time}', undo)
            r.ledger = event(ClickOutcome.USED)
            return r
        link = ' and restored the product link' if v.switches_link else ''
        r = settle(inp.existing, f'↩️ {who} undid it: *Unit cost* is back to *${money(v.old)}*{link} · {time}')
        r.ledger = event(ClickOutcome.UNDONE)
        return r


# --- the Slack callbacks --------------------------------------------------------------------------


class PriceAlertView(View):
    """Anyone who can see the alert may click it (DMs reach only the row's Point of contact, channel
    fallbacks reach the channel), and the outcome line names who did. One click per row at a
    time, so a double-tap can't write the audit line twice."""

    def __init__(self, purchasing: 'PurchasingPrices', ledger: 'SavingsLedger'):
        self.purchasing, self.ledger = purchasing, ledger
        self._in_flight: set[str] = set()

    @button(VIEW_RE)
    async def view_listing(self, interaction: Interaction) -> None:
        """Link buttons: Slack opens the URL itself but still reports the click, and an un-acked
        click shows an error icon on the button. The View acks it; nothing else to do."""

    @button(ACTION_RE)
    async def swap(self, interaction: Interaction) -> None:
        clicker, action_id = interaction.user_id, interaction.action_id
        if not clicker:
            return
        try:
            parsed = json.loads(interaction.value or '{}')
        except ValueError:
            parsed = None  # SwapHandler reports the bad value
        row_id = (parsed.get('r') or '') if isinstance(parsed, dict) else ''
        busy = bool(row_id) and row_id in self._in_flight
        if row_id and not busy:
            self._in_flight.add(row_id)
        if busy:
            await interaction.whisper('Already updating this row, one moment.')
            return
        try:
            result = await SwapHandler(
                SwapDeps(
                    fetch_row=self.purchasing.price_row,
                    write_row=self.purchasing.write_price,
                    display_name=interaction.display_name,
                    now=lambda: datetime.now(timezone.utc),
                )
            ).handle(ClickInput(action_id, interaction.value, clicker, interaction.message_blocks))
            if result.blocks is not None:
                await interaction.replace(result.blocks, result.text or 'Price check')
            elif result.whisper:
                await interaction.whisper(result.whisper)
            logger.info(f"Price check button: {clicker} → {action_id} on {row_id or '?'}: {result.log}")
            if result.ledger:
                # After the reply, so the ledger never slows the click down or fails it.
                aio.background(self._record, result.ledger, interaction, row_id, name='price-ledger')
        except Exception as err:
            logger.error(f'Price check button {action_id} failed', exc_info=err)
            await interaction.whisper('✗ Could not update Notion. Try again, or change *Unit cost* in Notion.')
        finally:
            if row_id:
                self._in_flight.discard(row_id)

    async def _record(self, event: LedgerEvent, interaction: Interaction, row_id: str) -> None:
        try:
            what = await self.ledger.record(event, await interaction.display_name(event.clicker) or event.clicker, self.purchasing.price_row)
            logger.info(f'Price check ledger: {row_id}: {what}')
        except Exception as err:
            logger.warning(f"Price check ledger: couldn't record {event.kind} on {row_id}", exc_info=err)

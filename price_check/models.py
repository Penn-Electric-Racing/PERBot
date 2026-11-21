"""The price check's models.

  Listing      one search result (a scraper's listing dict), read through properties
  SwapValue    what an alert button carries (its JSON value)
  Finding      a row whose price moved past the thresholds, and the listing(s) that show it
  PriceRow     a Purchasing row as an alert click sees it (can be blank, deleted, ordered)
  Notes        a row's `Notes (internal)` as plain-text runs, for the click's audit line
  RowPatch     what a click writes to a row
  SwapPlan     whether a click should write, and what
  LedgerEvent  a click outcome, as the savings ledger records it
  LedgerRow    one row of 💸 Price Check Savings
  Summary      what `/pricecheck` reports, over a set of ledger rows
  StatsQuery   a parsed `/pricecheck` command
"""
from __future__ import annotations

import dataclasses
import json
import math
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any, Self

from core import utils
from core.abc import NotionModel
from core.config import PriceCheckConfig
from core.database import Properties, date_value, rich_text_value
from core.purchasing import Col, PurchasingRow
from price_check.enums import (
    ClickKind,
    ClickOutcome,
    Direction,
    Outcome,
    Period,
    SwapPlanKind,
)
from price_check.scrapers import regex_reader
from price_check.scrapers.ranking import pick_top
from price_check.types import ListingPayload, PriceSwapValue

if TYPE_CHECKING:
    from core.types.notion import Page
    from price_check.database import PurchasingPrices

__all__ = [
    'UNSET', 'Listing', 'SwapValue', 'Finding', 'TextRun', 'Notes', 'PriceRow', 'RowPatch', 'SwapPlan', 'LedgerEvent', 'LedgerRow',
    'Summary', 'StatsQuery',
]

EPS = 1e-6


class _Unset:
    """`undefined` in a patch: leave the property alone (None means clear it)."""

    def __repr__(self) -> str:
        return 'UNSET'


UNSET: Any = _Unset()


# --- the check ------------------------------------------------------------------------------------


class Listing:
    """One search result. Wraps the scraper's dict (`data`, which the scrapers build and score);
    read it through the properties."""

    __slots__ = ('data',)

    def __init__(self, data: ListingPayload | dict[str, Any]):
        self.data: dict[str, Any] = data  # type: ignore[assignment]

    def __repr__(self) -> str:
        return f'<Listing {self.supplier!r} {self.unit_cost} {self.url!r}>'

    @property
    def url(self) -> str:
        return self.data.get('url') or ''

    @property
    def supplier(self) -> str:
        return self.data.get('supplier') or ''

    @property
    def unit_cost(self) -> float | None:
        return self.data.get('unit_cost')

    @property
    def currency(self) -> str:
        return self.data.get('currency') or 'USD'

    @property
    def is_usd(self) -> bool:
        return self.currency == 'USD'

    @property
    def notes(self) -> list[str]:
        return self.data.setdefault('notes', [])

    @notes.setter
    def notes(self, notes: list[str]) -> None:
        self.data['notes'] = notes

    @property
    def flags(self) -> list[str]:
        """Notes worth showing in an alert (an estimated shipping cost isn't)."""
        return [n for n in self.notes if n != 'shipping cost estimated']

    @property
    def price_break(self) -> str:
        """" (25+ price)" when a quantity price break set this listing's unit price, else ""."""
        bought = (self.data.get('packs_needed') or 0) * (self.data.get('pack_size') or 1)
        tier = max((b['min_qty'] for b in self.data.get('price_breaks') or [] if b['min_qty'] <= bought), default=None)
        return f' ({tier}+ price)' if tier and tier > 1 else ''

    @property
    def comparable(self) -> bool:
        """A priced USD listing of the right part with enough stock."""
        return bool(
            self.unit_cost
            and self.data.get('score') is not None
            and self.is_usd
            and self.data.get('enough_stock') is not False
            and not any(n == 'part number not in listing' or n.startswith('priced in') for n in self.notes)
        )

    def is_at(self, link: str) -> bool:
        """This listing is the page at `link` (the row's own product link)."""
        return bool(link) and regex_reader.same_url(self.url, link)


@dataclass
class Finding:
    row: PurchasingRow
    found: Listing  # the listing whose price is compared with the row
    at_link: bool  # found is the row's own product link
    delta_pct: float  # (found - sheet) / sheet x 100
    cheaper: Listing | None = None  # a better-priced option than `found`, if one was seen

    @property
    def found_unit(self) -> float:
        return self.found.unit_cost  # type: ignore[return-value]

    def row_price(self, unit_price: float) -> float:
        """A per-unit price in the row's own units (per pack on pack rows), rounded as shown."""
        n = unit_price * self.row.pack_size
        return round(n, 2 if n >= 1 else 4)

    @classmethod
    def compare(cls, row: PurchasingRow, results: list[ListingPayload], cfg: PriceCheckConfig) -> 'Finding | None':
        """A Finding when the found price moved past the thresholds, else None."""
        listings = [Listing(r) for r in results]
        link = next((r for r in listings if r.is_at(row.link) and r.unit_cost and r.is_usd), None)
        ranked = [r for r in (Listing(d) for d in pick_top(results, len(results))) if r.comparable]
        found = link or (ranked[0] if ranked else None)
        if not found:
            return None
        delta = found.unit_cost - row.unit_price  # type: ignore[operator]
        pct = delta / row.unit_price * 100
        if abs(pct) < cfg.threshold_pct or abs(delta) * row.units < cfg.min_delta_usd:
            return None
        cheaper = min((r for r in ranked if r.data is not found.data), key=lambda r: r.unit_cost, default=None)  # type: ignore[arg-type, return-value]
        if cheaper and cheaper.unit_cost >= min(found.unit_cost, row.unit_price):  # type: ignore[operator, type-var]
            cheaper = None
        return cls(row, found, link is not None, round(pct, 1), cheaper)


# --- a click --------------------------------------------------------------------------------------


@dataclass
class TextRun:
    """One run of a Notion rich-text value (kept only when every run is plain text)."""

    content: str
    link: str | None = None
    annotations: Any = None


class Notes(list[TextRun]):
    """`Notes (internal)` as plain-text runs, so a click can add or remove its audit line while
    keeping every other run's formatting."""

    MAX_RUNS = 100  # Notion's cap on rich-text runs

    @classmethod
    def read(cls, prop: Any) -> 'Notes | None':
        """The runs of a rich_text property, or None if any run isn't plain text (a mention or
        equation we won't rewrite)."""
        runs = cls()
        for r in (prop or {}).get('rich_text') or []:
            text = (r or {}).get('text') or {}
            if r.get('type') != 'text' or not isinstance(text.get('content'), str):
                return None
            runs.append(TextRun(text['content'], (text.get('link') or {}).get('url'), r.get('annotations')))
        return runs

    def to_rich_text(self) -> list[dict[str, Any]]:
        out = []
        for r in self:
            item: dict[str, Any] = {'type': 'text', 'text': {'content': r.content, 'link': {'url': r.link} if r.link else None}}
            if r.annotations:
                item['annotations'] = r.annotations
            out.append(item)
        return out

    def append_line(self, line: str) -> 'Notes | None':
        """These runs plus `line` on its own line, or None when the run cap leaves no room."""
        if len(self) >= self.MAX_RUNS:
            return None
        has_text = any(r.content for r in self)
        return Notes([*self, TextRun(('\n' if has_text else '') + line, None)])

    def drop_last_line(self, prefix: str) -> 'Notes | None':
        """These runs without a last line that starts with `prefix` (and the newline before it);
        None when the last line isn't ours (someone edited after)."""
        full = ''.join(r.content for r in self)
        nl = full.rfind('\n')
        if not full[nl + 1 :].startswith(prefix):
            return None
        keep = max(nl, 0)
        out = Notes()
        for r in self:
            if keep <= 0:
                break
            content = r.content[:keep]
            keep -= len(content)
            if content:
                out.append(dataclasses.replace(r, content=content))
        return out


def _is_number(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _is_money(x: Any) -> bool:
    return _is_number(x) and x >= 0


def _is_url(x: Any) -> bool:
    return isinstance(x, str) and len(x) <= 2000 and re.fullmatch(r'https?://\S+', x, re.I) is not None


_PAGE_ID_RE = re.compile(r'^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$', re.I)


@dataclass(frozen=True)
class SwapValue:
    """What an alert button carries. On the wire it's the JSON PriceSwapValue (types.py), at
    most 2000 characters (Slack's cap on a button value); `from_json` / `to_json` convert."""

    MAX_LEN = 2000
    NOTE_PREFIX = 'PERBot price check:'

    row_id: str  # r: the Purchasing row (Notion page id)
    qty: float  # q: `Quant.` when the alert was sent
    old: float  # o: `Unit cost` when the alert was sent, as stored (per pack on pack rows)
    new: float | None = None  # n: `Unit cost` to write, same units. Use buttons only
    supplier: str = ''  # s: supplier label for the confirmation line
    link: str | None = None  # l: new product link, only when switching to another listing
    old_link: str | None = None  # ol: the row's link at alert time ('' = it had none); Undo restores it
    issued_at: float | None = None  # t: Unix seconds the Undo button was issued (Undo expires after a day)
    test: bool = False  # x: a price_check.cli test alert, kept out of the savings ledger

    @classmethod
    def from_payload(cls, v: Any) -> 'SwapValue | None':
        """The value of a decoded button payload; None for anything malformed (a stale or
        hand-crafted payload)."""
        if not isinstance(v, dict) or v.get('v') != 1 or isinstance(v.get('v'), bool):
            return None
        if not isinstance(v.get('r'), str) or not _PAGE_ID_RE.match(v['r']):
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
        return cls(
            row_id=v['r'],
            qty=v['q'],
            old=v['o'],
            new=v.get('n'),
            supplier=(v.get('s') or '')[:80],
            link=v.get('l'),
            old_link=v.get('ol'),
            issued_at=v.get('t'),
            test=v.get('x') == 1 and not isinstance(v.get('x'), bool),
        )

    @classmethod
    def from_json(cls, raw: str | None) -> 'SwapValue | None':
        try:
            return cls.from_payload(json.loads(raw or ''))
        except (ValueError, TypeError):
            return None

    def to_payload(self) -> PriceSwapValue:
        out: dict[str, Any] = {'v': 1, 'r': self.row_id, 'q': self.qty, 'o': self.old}
        if self.new is not None:
            out['n'] = self.new
        if self.supplier:
            out['s'] = self.supplier
        if self.link is not None:
            out['l'] = self.link
        if self.old_link is not None:
            out['ol'] = self.old_link
        if self.issued_at is not None:
            out['t'] = self.issued_at
        if self.test:
            out['x'] = 1
        return out  # type: ignore[return-value]

    def to_json(self) -> str | None:
        """The button value, or None when it would exceed Slack's cap."""
        s = json.dumps(self.to_payload(), separators=(',', ':'), ensure_ascii=False)
        return s if len(s) <= self.MAX_LEN else None

    def replace(self, **changes: Any) -> 'SwapValue':
        return dataclasses.replace(self, **changes)

    @property
    def switches_link(self) -> bool:
        return self.link is not None

    @property
    def saved(self) -> float:
        """(old - new) x qty: what using this price saves (negative = a price increase)."""
        return utils.round2((self.old - (self.new or 0)) * self.qty)

    @property
    def note_prefix(self) -> str:
        return f'{self.NOTE_PREFIX} Unit cost ${utils.price(self.old)} → ${utils.price(self.new or 0)}'

    def note_line(self, who: str, date_iso: str) -> str:
        """The audit line a Use click leaves in `Notes (internal)`; Undo removes it by its prefix."""
        supplier = f' ({self.supplier})' if self.supplier else ''
        link = ', product link updated' if self.switches_link else ''
        return f'{self.note_prefix}{supplier}{link} via Slack, {who}, {date_iso}'


@dataclass
class RowPatch:
    unit_cost: float
    # UNSET = leave the link alone; None = clear it.
    link: Any = UNSET
    # UNSET = leave the notes alone.
    notes: Any = UNSET

    def props(self) -> dict[str, Any]:
        properties: dict[str, Any] = {Col.UNIT_COST: {'number': self.unit_cost}}
        if self.link is not UNSET:
            properties[Col.LINK] = {'url': self.link}
        if self.notes is not UNSET:
            properties[Col.NOTES] = {'rich_text': Notes(self.notes).to_rich_text()}
        return properties


@dataclass
class SwapPlan:
    kind: SwapPlanKind
    unit_cost: float = 0.0
    link: Any = UNSET
    reason: str = ''


@dataclass
class PriceRow(NotionModel):
    """The columns a click reads, writes or guards on. Unlike PurchasingRow, blanks stay None."""

    id: str
    unit_cost: float | None
    quantity: float | None
    link: str
    exported: bool
    deleted: bool
    # `Notes (internal)` runs; None when it holds mentions/equations we won't rewrite.
    notes: Notes | list[TextRun] | None
    # For the savings ledger (a row it has to create itself).
    name: str = ''
    part: str = ''
    season: str = ''
    url: str = ''

    @classmethod
    def _parse(cls, page: 'Page') -> Self:
        p = Properties(page)
        return cls(
            id=page['id'],
            unit_cost=p.number(Col.UNIT_COST),
            quantity=p.number(Col.QTY),
            link=p.url(Col.LINK),
            exported=p.checkbox(Col.EXPORTED),
            deleted=bool(page.get('archived') or page.get('in_trash')),
            notes=Notes.read(p.raw(Col.NOTES)),
            name=p.title(),
            part=p.text(Col.PART),
            season=p.select(Col.SEASON),
            url=page.get('url') or '',
        )

    def replace(self, **changes: Any) -> 'PriceRow':
        return dataclasses.replace(self, **changes)

    def apply(self, patch: RowPatch) -> None:
        """Write `patch` to this row in Notion."""
        db: PurchasingPrices = self.db  # type: ignore[assignment]
        db.write_price(self.id, patch)

    def plan_swap(self, kind: ClickKind, v: SwapValue) -> SwapPlan:
        """Whether clicking `kind` (use / undo) should write, and what. `v.new` must be set."""
        if self.deleted:
            return SwapPlan(SwapPlanKind.REFUSE, reason='This Purchasing row was deleted, so nothing was changed.')
        if self.exported:
            return SwapPlan(SwapPlanKind.REFUSE, reason='This row is already ordered (*Exported?* is checked), so *Unit cost* was left as is.')
        if self.quantity != v.qty:
            now_q = 'blank' if self.quantity is None else utils.js_number(self.quantity)
            return SwapPlan(
                SwapPlanKind.REFUSE,
                reason=f'*Quant.* changed since this alert (now {now_q}), so nothing was changed. The row gets re-priced on its own.',
            )
        frm, to = (v.old, v.new) if kind == ClickKind.USE else (v.new, v.old)
        if not v.switches_link:
            to_link: Any = UNSET
        else:
            to_link = v.link if kind == ClickKind.USE else (v.old_link or None)
        link_done = to_link is UNSET or _norm_url(self.link) == _norm_url(to_link)
        if _same_money(self.unit_cost, to) and link_done:
            return SwapPlan(SwapPlanKind.ALREADY)
        # Price already at the target but the link isn't (edited by hand halfway): finish the job.
        if not _same_money(self.unit_cost, frm) and not _same_money(self.unit_cost, to):
            now = 'blank' if self.unit_cost is None else f'${utils.price(self.unit_cost)}'
            return SwapPlan(SwapPlanKind.REFUSE, reason=f'*Unit cost* is now {now} in Notion (changed since this alert), so nothing was changed.')
        return SwapPlan(SwapPlanKind.WRITE, unit_cost=to, link=to_link)  # type: ignore[arg-type]


def _same_money(a: float | None, b: float) -> bool:
    return a is not None and abs(a - b) < EPS


def _norm_url(u: str | None) -> str:
    return re.sub(r'/+$', '', (u or '').strip())


# --- the savings ledger ---------------------------------------------------------------------------


@dataclass
class LedgerEvent:
    """A click outcome for the savings ledger."""

    kind: ClickOutcome
    value: SwapValue
    clicker: str
    at: datetime

    def props(self, who: str, current: Outcome | None) -> dict[str, Any] | None:
        """The ledger update this click makes, or None when it shouldn't change the row."""
        # A stale alert's refused Use mustn't overwrite what an earlier click already decided.
        if self.kind == ClickOutcome.REFUSED and current and current != Outcome.PENDING:
            return None
        v = self.value
        base = {'Clicked by': rich_text_value(who), 'Clicked at': date_value(self.at)}
        if self.kind == ClickOutcome.USED:
            if v.new is None:
                return None
            props: dict[str, Any] = {
                **base,
                'Outcome': Outcome.USED.prop(),
                'Used unit cost': {'number': v.new},
                'Saved $': {'number': v.saved},
                'Direction': (Direction.DROP if v.new < v.old else Direction.RISE).prop(),
                'Realized': {'checkbox': False},
            }
            if v.supplier:
                props['Supplier'] = rich_text_value(v.supplier)
            if v.link:
                props['Listing'] = {'url': v.link}
            return props
        if self.kind == ClickOutcome.UNDONE:
            return {
                **base,
                'Outcome': Outcome.UNDONE.prop(),
                'Used unit cost': {'number': None},
                'Saved $': {'number': 0},
                'Realized': {'checkbox': False},
                'Ordered at': date_value(None),
            }
        if self.kind == ClickOutcome.KEPT:
            return {**base, 'Outcome': Outcome.KEPT.prop(), 'Saved $': {'number': 0}}
        return {**base, 'Outcome': Outcome.REFUSED.prop()}


@dataclass
class LedgerRow(NotionModel):
    id: str
    name: str
    outcome: Outcome
    saved: float
    potential: float
    realized: bool
    supplier: str
    season: str
    created: str

    @classmethod
    def _parse(cls, page: 'Page') -> Self:
        p = Properties(page)
        return cls(
            id=page['id'],
            name=p.text('Name'),
            outcome=Outcome.from_prop(p.raw('Outcome'), Outcome.PENDING),
            saved=p.number('Saved $') or 0,
            potential=p.number('Potential $') or 0,
            realized=p.checkbox('Realized'),
            supplier=p.text('Supplier'),
            season=p.select('Season'),
            created=page.get('created_time') or '',
        )

    def in_period(self, period: Period, season: str, now: datetime) -> bool:
        if period == Period.ALL:
            return True
        if period == Period.SEASON:
            return self.season == season
        return bool(self.created) and (now - utils.parse_iso(self.created)).total_seconds() <= 7 * 24 * 3600


@dataclass
class Summary:
    alerts: int = 0
    counts: dict[str, int] = field(default_factory=lambda: {o: 0 for o in Outcome})
    # Accepted price drops: total saved, and how much of it was ordered at the new price.
    saved: float = 0
    saved_count: int = 0
    realized: float = 0
    realized_count: int = 0
    # Accepted price increases (budget corrections), as a positive amount.
    increases: float = 0
    increases_count: int = 0
    # Price drops offered but not taken (no answer yet, or Kept).
    on_table: float = 0
    on_table_count: int = 0
    top: list[LedgerRow] = field(default_factory=list)

    @classmethod
    def of(cls, rows: list[LedgerRow]) -> 'Summary':
        s = cls(alerts=len(rows))
        for r in rows:
            s.counts[r.outcome] = s.counts.get(r.outcome, 0) + 1
            if r.outcome == Outcome.USED and r.saved > 0:
                s.saved += r.saved
                s.saved_count += 1
                if r.realized:
                    s.realized += r.saved
                    s.realized_count += 1
            elif r.outcome == Outcome.USED and r.saved < 0:
                s.increases -= r.saved
                s.increases_count += 1
            elif r.outcome in (Outcome.PENDING, Outcome.KEPT) and r.potential > 0:
                s.on_table += r.potential
                s.on_table_count += 1
        s.saved, s.realized = utils.round2(s.saved), utils.round2(s.realized)
        s.increases, s.on_table = utils.round2(s.increases), utils.round2(s.on_table)
        s.top = sorted((r for r in rows if r.outcome == Outcome.USED and r.saved > 0), key=lambda r: r.saved, reverse=True)[:3]
        return s

    def text(self, period: Period, season: str, ledger_url: str) -> str:
        """The `/pricecheck` message."""
        plural, money = utils.plural, utils.price
        title = f'*💸 Price check savings: {period.title(season)}*'
        if not self.alerts:
            return f"{title}\nNo price alerts {'this week' if period == Period.WEEK else 'yet'}."
        c = self.counts
        answered = self.alerts - c[Outcome.PENDING]
        lines = [
            title,
            f"• *${money(self.saved)} saved* on {plural(self.saved_count, 'accepted price drop')}"
            + (
                f" (${money(self.realized)} realized: {plural(self.realized_count, 'order')} placed at the new price)"
                if self.saved_count
                else ''
            ),
            f"• ${money(self.increases)} of price increases caught before ordering ({plural(self.increases_count, 'row')})"
            if self.increases_count
            else '',
            f"• {plural(self.alerts, 'alert')}: {c[Outcome.USED]} used · {c[Outcome.KEPT]} kept · {c[Outcome.UNDONE]} undone"
            + (f' · {c[Outcome.REFUSED]} stale' if c[Outcome.REFUSED] else '')
            + f' · {c[Outcome.PENDING]} no answer yet'
            + (f" ({math.floor(c[Outcome.USED] / answered * 100 + 0.5)}% of answered alerts used)" if answered else ''),
            f"• ${money(self.on_table)} still on the table: {plural(self.on_table_count, 'price drop')} not taken"
            if self.on_table_count
            else '',
        ]
        if self.top:
            lines.append('*Top saves*')
            for i, r in enumerate(self.top):
                lines.append(f"{i + 1}. {utils.escape(r.name)}: ${money(r.saved)}{f' ({utils.escape(r.supplier)})' if r.supplier else ''}")
        if ledger_url:
            lines.append(f'<{ledger_url}|Open the ledger in Notion>')
        return '\n'.join(x for x in lines if x)


@dataclass
class StatsQuery:
    """A parsed `/pricecheck [week|all] [share]`."""

    help: bool
    period: Period
    share: bool

    @classmethod
    def parse(cls, text: str) -> 'StatsQuery':
        words = text.strip().lower().split()
        if any(w in ('help', '?') for w in words):
            return cls(True, Period.SEASON, False)
        if 'week' in words:
            period = Period.WEEK
        elif any(w in ('all', 'alltime', 'all-time') for w in words):
            period = Period.ALL
        else:
            period = Period.SEASON
        return cls(False, period, 'share' in words or 'post' in words)

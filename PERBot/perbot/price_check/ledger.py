"""💸 Price Check Savings: the ledger behind "how much has the price check saved us".

One Notion row per alert. The price listener (PER-Purchasing) writes it as Pending when it DMs
the alert; PERBot updates it when someone taps Use / Keep / Undo, and a sweep marks a Used row
Realized once the Purchasing row is ordered (Exported?) at that price. A click on an alert the
listener didn't log (sent before the ledger existed) creates the row here.

  Saved $      (Old − Used unit cost) × Quant. on a Used row, else 0. Negative = a price
               increase accepted, i.e. a budget correction, reported apart from savings.
  Potential $  (Old − Offered unit cost) × Quant. at alert time: what the alert could save.

Prices are in the row's own units (per pack on pack rows) and Quant. counts those units, so both
totals are plain dollars. A row is matched by Row ID + Old unit cost + Quant.: the same fields the
listener's one-alert-per-(row, price, quantity) Job Log key uses.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Literal

from ..utils.clock import parse_iso, to_iso
from ..utils.logger import logger
from .blocks import PriceSwapValue, escape_mrkdwn, money
from .swap import LedgerEvent, PriceRow

Outcome = Literal['Pending', 'Used', 'Kept', 'Undone', 'Refused']
OUTCOMES: tuple[Outcome, ...] = ('Pending', 'Used', 'Kept', 'Undone', 'Refused')


@dataclass
class LedgerRow:
    id: str
    name: str
    outcome: Outcome
    saved: float
    potential: float
    realized: bool
    supplier: str
    season: str
    created: str


def round2(n: float) -> float:
    """`Math.round(n * 100) / 100` (half rounds up, unlike Python's round)."""
    return math.floor(n * 100 + 0.5) / 100


def dashed_id(id_: str) -> str:
    """A Notion page id in its dashed form, whichever form it came in."""
    h = id_.replace('-', '').lower()
    return f'{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}' if len(h) == 32 else id_


def _rt(s: str) -> dict[str, Any]:
    return {'rich_text': [{'type': 'text', 'text': {'content': s[:2000]}}] if s else []}


def _date_prop(d: datetime | None) -> dict[str, Any]:
    return {'date': {'start': to_iso(d)} if d else None}


def new_row_props(v: PriceSwapValue, row: PriceRow) -> dict[str, Any]:
    """Properties for a ledger row PERBot has to create itself (the listener didn't log the alert)."""
    label = row.name or row.part or 'Purchasing row'
    q = _num(v['q'])
    props: dict[str, Any] = {
        'Name': {'title': [{'type': 'text', 'text': {'content': f'{label} ×{q}'[:2000]}}]},
        'Outcome': {'select': {'name': 'Pending'}},
        'Old unit cost': {'number': v['o']},
        'Quant.': {'number': v['q']},
        'Row ID': _rt(dashed_id(v['r'])),
        'Part': _rt(row.part or ''),
        'Supplier': _rt(v.get('s') or ''),
    }
    if row.url:
        props['Purchasing row'] = {'url': row.url}
    if row.season:
        props['Season'] = {'select': {'name': row.season}}
    if 'n' in v:
        props['Offered unit cost'] = {'number': v['n']}
        props['Potential $'] = {'number': round2((v['o'] - v['n']) * v['q'])}
        props['Direction'] = {'select': {'name': 'Drop' if v['n'] < v['o'] else 'Rise'}}
    if v.get('l'):
        props['Listing'] = {'url': v['l']}
    return props


def _num(n: float) -> str:
    return str(int(n)) if float(n).is_integer() else str(n)


def event_props(e: LedgerEvent, who: str, current: Outcome | None) -> dict[str, Any] | None:
    """The update a click makes, or None when it shouldn't change the row (see record())."""
    # A stale alert's refused Use mustn't overwrite what an earlier click already decided.
    if e.kind == 'refused' and current and current != 'Pending':
        return None
    v = e.value
    base = {'Clicked by': _rt(who), 'Clicked at': _date_prop(e.at)}
    if e.kind == 'used':
        if 'n' not in v:
            return None
        props: dict[str, Any] = {
            **base,
            'Outcome': {'select': {'name': 'Used'}},
            'Used unit cost': {'number': v['n']},
            'Saved $': {'number': round2((v['o'] - v['n']) * v['q'])},
            'Direction': {'select': {'name': 'Drop' if v['n'] < v['o'] else 'Rise'}},
            'Realized': {'checkbox': False},
        }
        if v.get('s'):
            props['Supplier'] = _rt(v['s'])
        if v.get('l'):
            props['Listing'] = {'url': v['l']}
        return props
    if e.kind == 'undone':
        return {
            **base,
            'Outcome': {'select': {'name': 'Undone'}},
            'Used unit cost': {'number': None},
            'Saved $': {'number': 0},
            'Realized': {'checkbox': False},
            'Ordered at': _date_prop(None),
        }
    if e.kind == 'kept':
        return {**base, 'Outcome': {'select': {'name': 'Kept'}}, 'Saved $': {'number': 0}}
    return {**base, 'Outcome': {'select': {'name': 'Refused'}}}


def _text(prop: Any) -> str:
    prop = prop or {}
    items = prop.get('title') if prop.get('title') is not None else prop.get('rich_text') or []
    return ''.join((t or {}).get('plain_text') or '' for t in items)


def parse_ledger_row(page: Any) -> LedgerRow:
    p = (page or {}).get('properties') or {}
    return LedgerRow(
        id=page['id'],
        name=_text(p.get('Name')),
        outcome=((p.get('Outcome') or {}).get('select') or {}).get('name') or 'Pending',
        saved=_number(p.get('Saved $')),
        potential=_number(p.get('Potential $')),
        realized=bool((p.get('Realized') or {}).get('checkbox')),
        supplier=_text(p.get('Supplier')),
        season=((p.get('Season') or {}).get('select') or {}).get('name') or '',
        created=page.get('created_time') or '',
    )


def _number(prop: Any) -> float:
    n = (prop or {}).get('number')
    return n if n is not None else 0


# --- Stats --------------------------------------------------------------------------------------

Period = Literal['week', 'season', 'all']


@dataclass
class Summary:
    alerts: int = 0
    counts: dict[str, int] = field(default_factory=lambda: {o: 0 for o in OUTCOMES})
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


def in_period(r: LedgerRow, period: Period, season: str, now: datetime) -> bool:
    if period == 'all':
        return True
    if period == 'season':
        return r.season == season
    return bool(r.created) and (now - parse_iso(r.created)).total_seconds() <= 7 * 24 * 3600


def summarize(rows: list[LedgerRow]) -> Summary:
    s = Summary(alerts=len(rows))
    for r in rows:
        s.counts[r.outcome] = s.counts.get(r.outcome, 0) + 1
        if r.outcome == 'Used' and r.saved > 0:
            s.saved += r.saved
            s.saved_count += 1
            if r.realized:
                s.realized += r.saved
                s.realized_count += 1
        elif r.outcome == 'Used' and r.saved < 0:
            s.increases -= r.saved
            s.increases_count += 1
        elif r.outcome in ('Pending', 'Kept') and r.potential > 0:
            s.on_table += r.potential
            s.on_table_count += 1
    s.saved = round2(s.saved)
    s.realized = round2(s.realized)
    s.increases = round2(s.increases)
    s.on_table = round2(s.on_table)
    s.top = sorted((r for r in rows if r.outcome == 'Used' and r.saved > 0), key=lambda r: r.saved, reverse=True)[:3]
    return s


def _period_title(period: Period, season: str) -> str:
    return {'week': 'last 7 days', 'season': f'{season} season', 'all': 'all time'}[period]


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f'{n} {one if n == 1 else (many or one + "s")}'


def stats_text(s: Summary, period: Period, season: str, ledger_url: str) -> str:
    title = f'*💸 Price check savings: {_period_title(period, season)}*'
    if not s.alerts:
        return f"{title}\nNo price alerts {'this week' if period == 'week' else 'yet'}."
    c = s.counts
    answered = s.alerts - c['Pending']
    lines = [
        title,
        f"• *${money(s.saved)} saved* on {_plural(s.saved_count, 'accepted price drop')}"
        + (
            f" (${money(s.realized)} realized: {_plural(s.realized_count, 'order')} placed at the new price)"
            if s.saved_count
            else ''
        ),
        f"• ${money(s.increases)} of price increases caught before ordering ({_plural(s.increases_count, 'row')})"
        if s.increases_count
        else '',
        f"• {_plural(s.alerts, 'alert')}: {c['Used']} used · {c['Kept']} kept · {c['Undone']} undone"
        + (f" · {c['Refused']} stale" if c['Refused'] else '')
        + f" · {c['Pending']} no answer yet"
        + (f" ({math.floor(c['Used'] / answered * 100 + 0.5)}% of answered alerts used)" if answered else ''),
        f"• ${money(s.on_table)} still on the table: {_plural(s.on_table_count, 'price drop')} not taken"
        if s.on_table_count
        else '',
    ]
    if s.top:
        lines.append('*Top saves*')
        for i, r in enumerate(s.top):
            lines.append(
                f"{i + 1}. {escape_mrkdwn(r.name)}: ${money(r.saved)}{f' ({escape_mrkdwn(r.supplier)})' if r.supplier else ''}"
            )
    if ledger_url:
        lines.append(f'<{ledger_url}|Open the ledger in Notion>')
    return '\n'.join(x for x in lines if x)


# --- Notion -------------------------------------------------------------------------------------


class PriceLedger:
    def __init__(self, data_source_id: str | None = None, client: Any = None):
        from ..config import config

        self.data_source_id = config.price_check.ledger_data_source_id if data_source_id is None else data_source_id
        if client is None:
            from ..notion_api import NotionClient

            client = NotionClient(auth=config.notion.token, notion_version=config.notion.api_version)
        self.client = client

    @property
    def enabled(self) -> bool:
        return bool(self.data_source_id)

    def _query(self, filter: Any, page_size: int = 100, max_rows: float = math.inf) -> list[Any]:
        out: list[Any] = []
        cursor: str | None = None
        while True:
            kwargs: dict[str, Any] = {'data_source_id': self.data_source_id, 'page_size': page_size, 'start_cursor': cursor}
            if filter is not None:
                kwargs['filter'] = filter
            res = self.client.data_sources.query(**kwargs)
            out.extend(res.get('results') or [])
            cursor = res.get('next_cursor') if res.get('has_more') and len(out) < max_rows else None
            if not cursor:
                return out

    def find(self, v: PriceSwapValue) -> Any | None:
        """The alert's ledger row (newest if a row somehow has two), or None."""
        rows = self._query(
            {
                'and': [
                    {'property': 'Row ID', 'rich_text': {'equals': dashed_id(v['r'])}},
                    {'property': 'Old unit cost', 'number': {'equals': v['o']}},
                    {'property': 'Quant.', 'number': {'equals': v['q']}},
                ]
            },
            5,
            5,
        )
        rows.sort(key=lambda p: parse_iso(p.get('created_time') or '1970-01-01'), reverse=True)
        return rows[0] if rows else None

    def record(self, e: LedgerEvent, who: str, fetch_row: Callable[[str], PriceRow]) -> str:
        """Write a click to the ledger: update the alert's row, creating it first when the listener
        didn't log it. Test alerts (`x`) are skipped. Returns what happened, for the log."""
        if not self.enabled:
            return 'ledger off'
        if e.value.get('x'):
            return 'test alert, not logged'
        page = self.find(e.value)
        current = parse_ledger_row(page).outcome if page else None
        props = event_props(e, who, current)
        if not props:
            return f'kept {current}'
        if not page:
            page = self.client.pages.create(
                parent={'type': 'data_source_id', 'data_source_id': self.data_source_id},
                properties=new_row_props(e.value, fetch_row(e.value['r'])),
            )
        self.client.pages.update(page_id=page['id'], properties=props)
        return f"{current or 'new'} → {e.kind}"

    def rows(self) -> list[LedgerRow]:
        return [parse_ledger_row(p) for p in self._query(None)]

    def sweep_realized(self, fetch_row: Callable[[str], PriceRow], now: datetime | None = None) -> int:
        """Mark Used rows Realized once their Purchasing row is ordered (Exported?) with Unit cost
        still at the price that was used. Returns how many were marked."""
        if not self.enabled:
            return 0
        when = now or datetime.now(timezone.utc)
        open_rows = self._query(
            {
                'and': [
                    {'property': 'Outcome', 'select': {'equals': 'Used'}},
                    {'property': 'Realized', 'checkbox': {'equals': False}},
                ]
            }
        )
        marked = 0
        for page in open_rows:
            p = page.get('properties') or {}
            row_id = ''.join(t.get('plain_text', '') for t in (p.get('Row ID') or {}).get('rich_text') or [])
            used = (p.get('Used unit cost') or {}).get('number')
            if not row_id or not isinstance(used, (int, float)):
                continue
            try:
                row = fetch_row(row_id)
                if row.deleted or not row.exported or row.unit_cost is None or abs(row.unit_cost - used) > 1e-6:
                    continue
                self.client.pages.update(
                    page_id=page['id'], properties={'Realized': {'checkbox': True}, 'Ordered at': _date_prop(when)}
                )
                marked += 1
            except Exception as err:
                logger.warn(f"Price check ledger: couldn't check row {row_id} for Realized", err)
        return marked

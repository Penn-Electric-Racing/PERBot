"""Open orders a package could belong to. Pure.

A row is a candidate only if it went out on an order (`Exported?`), hasn't arrived, and was
requested before the photo was posted — the last rule keeps a backtest over old photos from
matching orders placed after them, and is free in live use. Rows group into the order they went
out on: `Run ID`, or (for the ~70 rows without one) vendor + request day.
"""
from __future__ import annotations

import re
from datetime import datetime

from utils.clock import parse_iso
from arrivals.match import row_vendor_key, vendor_key
from arrivals.models import ArrivalRow, Extraction, OpenOrder

DAY_S = 86_400
# Older than this, an open order has almost certainly arrived unrecorded (nothing was marked
# before this feature): it isn't offered on vendor alone, and ranks after fresher orders.
STALE_DAYS = 30
# Older than this, an open row isn't a candidate at all — "Is it the order from Aug 29?" on Oct 19
# was the #1 complaint.
MAX_AGE_DAYS = 90


def iso_time(iso: str | None) -> float | None:
    """Epoch seconds of a Notion date/datetime; a bare date counts as noon UTC. None when unparsable."""
    if not iso:
        return None
    try:
        return parse_iso(f'{iso}T12:00:00Z' if len(iso) == 10 else iso).timestamp()
    except ValueError:
        return None


def eligible_rows(rows: list[ArrivalRow], as_of: datetime) -> list[ArrivalRow]:
    cutoff = as_of.timestamp()
    out = []
    for r in rows:
        if not r.exported or r.arrived == 'Yes':
            continue
        requested = iso_time(r.submitted_at)
        if requested is not None and requested > cutoff:
            continue
        placed = iso_time(r.ordered_at)
        if placed is None:
            placed = requested
        if placed is None or cutoff - placed <= MAX_AGE_DAYS * DAY_S:
            out.append(r)
    return out


def order_key(row: ArrivalRow) -> str:
    """The order a row belongs to: `Run ID`, else request day, plus vendor (see group_orders)."""
    return f"{row.run_id or (row.submitted_at or '')[:10]}|{row_vendor_key(row) or 'unknown'}"


def is_stale(order: OpenOrder, as_of: datetime) -> bool:
    """Placed more than STALE_DAYS before `as_of`. Undated orders aren't stale (nothing to judge by)."""
    t = iso_time(order.date)
    return t is not None and as_of.timestamp() - t > STALE_DAYS * DAY_S


def group_orders(rows: list[ArrivalRow]) -> list[OpenOrder]:
    """One order = one vendor's rows in a run. PEFS export runs (PERPO-…) batch several vendors, and
    a box only ever holds one vendor's slice; `run_id` is kept only when the slice is the whole run,
    so a button that re-reads the run at click time can't sweep in another vendor's rows."""
    by_key: dict[str, list[ArrivalRow]] = {}
    run_size: dict[str, int] = {}
    for r in rows:
        by_key.setdefault(order_key(r), []).append(r)
        if r.run_id:
            run_size[r.run_id] = run_size.get(r.run_id, 0) + 1
    orders = []
    for key, group in by_key.items():
        first = group[0]
        dates = sorted(d for d in (r.ordered_at or r.submitted_at for r in group) if d)
        orders.append(
            OpenOrder(
                key=key,
                run_id=first.run_id if first.run_id and run_size.get(first.run_id) == len(group) else None,
                rows=group,
                vendor=next((r.vendor for r in group if r.vendor), ''),
                requesters=list(dict.fromkeys(n for r in group for n in r.point_of_contact)),
                date=dates[0] if dates else None,
            )
        )
    return orders


def orders_for_vendor(orders: list[OpenOrder], vendor: str | None) -> list[OpenOrder]:
    """Orders from the package's vendor; [] when the vendor is unknown."""
    key = vendor_key(vendor)
    if not key:
        return []

    def same(o: OpenOrder) -> bool:
        k = row_vendor_key(o.rows[0])
        return k == key or (bool(k) and (k.startswith(key) or key.startswith(k)))

    return [o for o in orders if same(o)]


def _name_tokens(name: str) -> list[str]:
    return [t for t in re.split(r'[^a-z]+', name.lower()) if len(t) >= 2]


def addressee_matches(addressee: str | None, requesters: list[str]) -> bool:
    """"KATHERINE SHEN" vs requester "Katherine Shen" / "Shen": shares the surname, or is the whole name."""
    a = _name_tokens(addressee or '')
    if not a:
        return False
    for r in requesters:
        t = _name_tokens(r)
        if t and (t[-1] == a[-1] or (len(t) == 1 and t[0] in a)):
            return True
    return False


def rank_orders(orders: list[OpenOrder], pkg: Extraction, as_of: datetime) -> list[OpenOrder]:
    """Most plausible first: an addressee who requested it, then the order placed closest BEFORE the
    ship date — or before the photo, when no ship date was read (McMaster ships next day, so an order
    from yesterday is a prime candidate). Stale orders (STALE_DAYS) come after fresh ones, and orders
    placed after the ship date go last. Nothing was marked arrived before this feature, so "oldest
    open order" would surface long-delivered ones."""
    ship = iso_time(pkg.ship_date)
    anchor = ship if ship is not None else as_of.timestamp()

    def gap(o: OpenOrder) -> float:
        t = iso_time(o.date)
        if t is None:
            return 365
        days = (anchor - t) / DAY_S
        if days < -1:
            return 365 + abs(days)  # ordered after it shipped: last
        return 180 + days if days > STALE_DAYS else abs(days)

    return sorted(orders, key=lambda o: (-int(addressee_matches(pkg.addressee, o.requesters)), gap(o)))

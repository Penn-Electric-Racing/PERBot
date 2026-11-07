"""One scanned photo → Resolutions, strongest evidence first, per package:
  1. part numbers / requisition on a slip (deterministic `match_slip`) — exact or strong wins outright;
  2. text evidence (item hints, slip descriptions) → the model picks among that vendor's open orders
     (or all open orders when the vendor is unknown), validated against what we offered — up to 3
     orders, since one message often lists several items;
  3. a weak slip match, if that's all there is;
  4. vendor known → a pick-list of its most plausible open orders — never one older than STALE_DAYS,
     which on vendor alone is nearly always long delivered and simply never marked;
  5. nothing.
Only orders that went out before the photo are candidates (`eligible_rows`), rows claimed by an
earlier package in the same photo aren't offered again, and neither are orders someone already
called wrong in this thread (`exclude`, by `OpenOrder.key`).
"""
from __future__ import annotations

import dataclasses
from datetime import datetime
from typing import AbstractSet, Callable

from .match import match_slip
from .models import ArrivalRow, Extraction, OpenOrder, Resolution, Scan, SlipMatch
from .orders import eligible_rows, group_orders, is_stale, order_key, orders_for_vendor, rank_orders
from .pick import Pick, pick_orders

Picker = Callable[[Extraction, list[OpenOrder], str], list[Pick]]


def _pick_to_match(pick: Pick) -> SlipMatch:
    return SlipMatch(
        confidence='strong' if pick.confidence == 'high' else 'weak',
        run_id=pick.order.run_id,
        order_rows=pick.order.rows,
        matched_rows=pick.rows,
        lines=[],
    )


def resolve_package(
    pkg: Extraction,
    rows: list[ArrivalRow],
    as_of: datetime,
    message_text: str,
    picker: Picker = pick_orders,
) -> list[Resolution]:
    """Resolutions for one package (their `pkg` index is set by the caller)."""
    orders = group_orders(rows)
    vendor_orders = orders_for_vendor(orders, pkg.vendor)

    def matched(match: SlipMatch, evidence: str | None) -> Resolution:
        # The matched order's key, and the vendor's other open orders as a fallback list.
        ids = {r.id for r in match.order_rows}
        home = next((o for o in orders if any(r.id in ids for r in o.rows)), None)
        same_vendor = orders_for_vendor(orders, home.vendor) if home else vendor_orders
        return Resolution(
            kind='match',
            match=match,
            evidence=evidence,
            key=home.key if home else None,
            alternatives=rank_orders([o for o in same_vendor if o is not home], pkg, as_of),
        )

    weak: SlipMatch | None = None
    if pkg.lines or pkg.order_numbers:
        match = match_slip(pkg, rows)
        if match.confidence in ('exact', 'strong'):
            return [matched(match, None)]
        if match.confidence == 'weak':
            weak = match

    has_evidence = bool(pkg.item_hints) or any(l.description for l in pkg.lines)
    # A vendor with no open orders is often a misread (the carrier, a fulfiller): let the evidence decide.
    pool = vendor_orders or orders
    if has_evidence and pool:
        picks = picker(pkg, rank_orders(pool, pkg, as_of), message_text)
        if picks:
            return [matched(_pick_to_match(p), p.evidence) for p in picks]

    if weak:
        return [matched(weak, None)]
    fresh = [o for o in vendor_orders if not is_stale(o, as_of)]
    if fresh:
        return [Resolution(kind='choose', orders=rank_orders(fresh, pkg, as_of), vendor=pkg.vendor or '')]
    return [Resolution(kind='none')]


def resolve_scan(
    scan: Scan,
    open_rows: list[ArrivalRow],
    as_of: datetime,
    message_text: str,
    picker: Picker | None = None,
    exclude: AbstractSet[str] = frozenset(),
) -> list[Resolution]:
    if scan.scene == 'not_a_delivery':
        return []
    # A pile photo with nothing said: any "hints" are the model describing boxes. Part numbers still
    # count. With a message, its items belong to the pile, not to whichever box the model filed them
    # under ("mouser parts and cooling fittings" → the fittings are likely the Amazon box): every
    # package sees them all. ground_picks still requires an item of the picked order to share a word,
    # and rows one package claims aren't offered to the next.
    pile = scan.scene == 'several_packages'
    pile_hints = list(dict.fromkeys(h for p in scan.packages for h in p.item_hints))
    packages = (
        [dataclasses.replace(p, item_hints=pile_hints if message_text.strip() else []) for p in scan.packages]
        if pile
        else scan.packages
    )
    rows = [r for r in eligible_rows(open_rows, as_of) if order_key(r) not in exclude]
    out: list[Resolution] = []
    for i, pkg in enumerate(packages):
        for res in resolve_package(pkg, rows, as_of, message_text, picker or pick_orders):
            res.pkg = i
            out.append(res)
            if res.kind == 'match' and res.match:
                claimed = {r.id for r in [*res.match.order_rows, *res.match.matched_rows]}
                rows = [r for r in rows if r.id not in claimed]
    return out

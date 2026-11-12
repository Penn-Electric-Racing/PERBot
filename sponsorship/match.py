"""Picking ONE Bank lead / Pipeline deal out of a Notion title search. Notion's `title contains` is a
case-insensitive substring match, so "Keye" also hits "Hawkeyeind" and "Skf" hits both "SKF" rows —
an exact name must beat substrings, or the user gets a "be more specific" list they can't escape by
typing more.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Generic, Literal, TypeVar

T = TypeVar('T')


@dataclass
class NameMatch(Generic[T]):
    kind: Literal['one', 'none', 'many']
    row: T | None = None
    rows: list[T] = field(default_factory=list)


def normalize_name(name: str) -> str:
    """"Jane  Street, Inc." → "jane street inc" — case/punctuation-insensitive name key."""
    return re.sub(r'[^a-z0-9]+', ' ', name.lower()).strip()


def pick_by_name(rows: list[T], query: str) -> NameMatch[T]:
    """One row when the search is unambiguous: a single hit, or a single exact-name hit among
    substring hits. Several exact hits (two "SKF" rows) stay ambiguous — only the caller's domain can
    tell those apart. Rows need a `company` attribute."""
    if not rows:
        return NameMatch('none')
    if len(rows) == 1:
        return NameMatch('one', row=rows[0])
    key = normalize_name(query)
    exact = [r for r in rows if normalize_name(r.company) == key]  # type: ignore[attr-defined]
    if len(exact) == 1:
        return NameMatch('one', row=exact[0])
    return NameMatch('many', rows=exact if len(exact) > 1 else rows)


def pick_live_deal(deals: list[T]) -> NameMatch[T]:
    """Several deals for one company (an old Won/Lost one + a live one): the live one is the one a
    log/stage/won means. Still ambiguous if zero or 2+ are live. Deals need a `stage` attribute."""
    if not deals:
        return NameMatch('none')
    if len(deals) == 1:
        return NameMatch('one', row=deals[0])
    live = [d for d in deals if d.stage not in ('Won', 'Lost')]  # type: ignore[attr-defined]
    return NameMatch('one', row=live[0]) if len(live) == 1 else NameMatch('many', rows=deals)

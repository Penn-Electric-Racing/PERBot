"""Raw payloads of the price check: the alert buttons' JSON value and the scrapers' listings."""
from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict

__all__ = ['PriceSwapValue', 'PriceBreak', 'ListingPayload']


class PriceSwapValue(TypedDict):
    """The JSON value on an alert button (≤ 2000 chars, Slack's cap). models.SwapValue is the model."""

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
    # 1 on test alerts (price_check.cli): clicks work but aren't written to the savings ledger.
    x: NotRequired[Literal[1]]


class PriceBreak(TypedDict):
    min_qty: int
    unit_price: float


class ListingPayload(TypedDict, total=False):
    """One scored search result from price_check.scrapers (llm_reader.find). models.Listing wraps it."""

    url: str
    supplier: str
    unit_cost: float | None
    currency: str
    subtotal: float | None
    score: float | None
    relevance: float
    notes: list[str]
    price_breaks: list[PriceBreak]
    packs_needed: int
    pack_size: int
    enough_stock: bool | None
    fetch_error: str
    extra: Any

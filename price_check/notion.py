"""Purchasing (PEFS) reads/writes for the price-check buttons: just the columns a swap touches or
guards on. Same database as BenBuys and the price listener."""
from __future__ import annotations

from typing import Any

from config import config
from notion_api import NotionClient
from utils.logger import logger
from price_check.swap import UNSET, PriceRow, RowPatch, read_text_runs, to_rich_text


def _num(prop: Any) -> float | None:
    n = (prop or {}).get('number')
    return n if isinstance(n, (int, float)) and not isinstance(n, bool) else None


def _plain(prop: Any) -> str:
    prop = prop or {}
    items = prop.get('title') if prop.get('title') is not None else prop.get('rich_text') or []
    return ''.join((t or {}).get('plain_text') or '' for t in items).strip()


def parse_price_row(page: Any) -> PriceRow:
    p = (page or {}).get('properties') or {}
    return PriceRow(
        id=page['id'],
        unit_cost=_num(p.get('Unit cost')),
        quantity=_num(p.get('Quant.')),
        link=(p.get('Link to product webpage') or {}).get('url') or '',
        exported=bool((p.get('Exported?') or {}).get('checkbox')),
        deleted=bool(page.get('archived') or page.get('in_trash')),
        notes=read_text_runs(p.get('Notes (internal)')),
        name=_plain(next((v for v in p.values() if (v or {}).get('type') == 'title'), None)),
        part=_plain(p.get('Cat. or model no.')),
        season=((p.get('Season') or {}).get('select') or {}).get('name') or '',
        url=page.get('url') or '',
    )


class PriceCheckNotion:
    def __init__(self, token: str | None = None):
        self.client = NotionClient(auth=token or config.notion.token, notion_version=config.notion.api_version)

    def fetch_row(self, page_id: str) -> PriceRow:
        return parse_price_row(self.client.pages.retrieve(page_id))

    def write_row(self, page_id: str, patch: RowPatch) -> None:
        properties: dict[str, Any] = {'Unit cost': {'number': patch.unit_cost}}
        if patch.link is not UNSET:
            properties['Link to product webpage'] = {'url': patch.link}
        if patch.notes is not UNSET:
            properties['Notes (internal)'] = {'rich_text': to_rich_text(patch.notes)}
        self.client.pages.update(page_id, properties=properties)
        logger.info(
            f"Price check: row {page_id} → Unit cost {patch.unit_cost}{', link updated' if patch.link is not UNSET else ''}."
        )

"""Notion databases as typed collections of models.

  Properties   a page's properties, read by column name
  *_value      build a property value to write (rich_text_value, title_value, ...)
  Database[M]  one Notion data source whose pages are `M` rows: query, get, create, update

A subclass sets `model` and adds the queries its feature needs:

    class SavingsLedger(Database[LedgerRow]):
        model = LedgerRow

        def used(self) -> list[LedgerRow]:
            return self.query({'property': 'Outcome', 'select': {'equals': 'Used'}})

Rows come back bound to their database (`row.db`), so they can save themselves.
"""
from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Any, ClassVar, Generic, TypeVar

from core import utils
from core.notion import Notion, collect, plain_text, same_id
from core.types.notion import Page, PropertyValue

if TYPE_CHECKING:
    from core.abc import NotionModel

__all__ = ['Properties', 'Database', 'rich_text_value', 'title_value', 'date_value', 'select_value']

M = TypeVar('M', bound='NotionModel')


class Properties:
    """A page's properties, read by column name: the model's view of its payload. Missing or empty columns read as blank, never raise.

        p = Properties(page)
        p.number('Quant.'), p.text('Part number'), p.title()
    """

    __slots__ = ('_props',)

    def __init__(self, page: 'Page | None'):
        self._props: dict[str, PropertyValue] = (page or {}).get('properties') or {}

    def __contains__(self, name: str) -> bool:
        return name in self._props

    def raw(self, name: str) -> 'PropertyValue | None':
        return self._props.get(name)

    def text(self, name: str) -> str:
        """A title or rich_text value, trimmed."""
        return plain_text(self._props.get(name))

    def title(self) -> str:
        """The page's title, whatever its title column is called."""
        props = self._props
        return plain_text(next((v for v in props.values() if (v or {}).get('type') == 'title'), props.get('Name')))

    def number(self, name: str) -> float | None:
        n = (self._props.get(name) or {}).get('number')
        return n if isinstance(n, (int, float)) and not isinstance(n, bool) else None

    def select(self, name: str) -> str:
        return ((self._props.get(name) or {}).get('select') or {}).get('name') or ''

    def status(self, name: str) -> str:
        return ((self._props.get(name) or {}).get('status') or {}).get('name') or ''

    def checkbox(self, name: str) -> bool:
        return bool((self._props.get(name) or {}).get('checkbox'))

    def url(self, name: str) -> str:
        return (self._props.get(name) or {}).get('url') or ''

    def date(self, name: str) -> str | None:
        """A date property's start (ISO), or None."""
        return ((self._props.get(name) or {}).get('date') or {}).get('start')

    def formula(self, name: str) -> Any:
        f = (self._props.get(name) or {}).get('formula')
        return f.get(f.get('type')) if f else None

    def multi_select(self, name: str) -> list[str]:
        return [s.get('name') for s in (self._props.get(name) or {}).get('multi_select') or [] if s.get('name')]


# --- property values to write ---------------------------------------------------------------------


def rich_text_value(s: str, limit: int = 2000) -> 'PropertyValue':
    return {'rich_text': [{'type': 'text', 'text': {'content': s[:limit]}}] if s else []}


def title_value(s: str, limit: int = 2000) -> 'PropertyValue':
    return {'title': [{'type': 'text', 'text': {'content': s[:limit]}}]}


def date_value(d: datetime | None) -> 'PropertyValue':
    return {'date': {'start': utils.to_iso(d)} if d else None}


def select_value(name: str) -> 'PropertyValue':
    return {'select': {'name': name}}


class Database(Generic[M]):
    """One Notion data source whose pages are `model` rows."""

    model: ClassVar[type]

    def __init__(self, client: Notion, data_source_id: str):
        self.client, self.data_source_id = client, data_source_id

    @property
    def enabled(self) -> bool:
        """False when no data source is configured (the feature is off)."""
        return bool(self.data_source_id)

    def wrap(self, page: 'Page') -> M:
        """A page of this database as a bound row."""
        return self.model.from_page(page, db=self)

    def pages(self, filter: Any = None, sorts: list[Any] | None = None, limit: int | None = None, page_size: int | None = None) -> list['Page']:
        """Raw pages matching `filter` (all of them, or the first `limit`)."""
        args: dict[str, Any] = {'data_source_id': self.data_source_id, 'page_size': page_size or min(limit or 100, 100)}
        if filter is not None:
            args['filter'] = filter
        if sorts is not None:
            args['sorts'] = sorts
        return collect(self.client.data_sources.query, limit=limit, **args)

    def query(self, filter: Any = None, sorts: list[Any] | None = None, limit: int | None = None) -> list[M]:
        return [self.wrap(p) for p in self.pages(filter, sorts, limit)]

    def get(self, page_id: str) -> M:
        return self.wrap(self.client.pages.retrieve(page_id))

    def create(self, properties: dict[str, Any]) -> 'Page':
        return self.client.pages.create(parent={'type': 'data_source_id', 'data_source_id': self.data_source_id}, properties=properties)

    def update(self, page_id: str, properties: dict[str, Any]) -> None:
        self.client.pages.update(page_id=page_id, properties=properties)

    def owns(self, page: 'Page') -> bool:
        """False only when the page is known to live in another data source."""
        parent = ((page or {}).get('parent') or {}).get('data_source_id') or ''
        return not parent or same_id(parent, self.data_source_id)

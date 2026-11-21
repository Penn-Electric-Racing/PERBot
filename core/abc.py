"""Abstract base classes the models share.

`NotionModel` is a row of a Notion database. Rows are built from a page payload with
`Model.from_page(page, db=...)`; the database it came from is kept on the row (`row.db`), so the
row can act on itself (`row.save(...)`, `row.refresh()`). A row built without a database (in a test, or parsed from a payload by hand) is
read-only.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any, ClassVar, Self

from core.errors import NotionError

if TYPE_CHECKING:
    from core.database import Database
    from core.types.notion import Page

__all__ = ['NotionModel']


class NotionModel:
    """A row of a Notion database. Subclasses are dataclasses with `id` and `url` fields and
    implement `_parse(page)` to read their columns."""

    id: str
    url: str
    # The database this row was read from (None = read-only).
    _db: ClassVar[Any] = None

    @classmethod
    def from_page(cls, page: 'Page', db: 'Database[Any] | None' = None) -> Self:
        row = cls._parse(page)
        if db is not None:
            object.__setattr__(row, '_db', db)
        return row

    @classmethod
    def _parse(cls, page: 'Page') -> Self:
        raise NotImplementedError

    @property
    def db(self) -> 'Database[Any]':
        if self._db is None:
            raise NotionError(f'{type(self).__name__} {self.id} was not read from a database, so it cannot be changed.')
        return self._db

    def save(self, properties: dict[str, Any]) -> None:
        """Write Notion properties to this row's page."""
        self.db.update(self.id, properties)

    def refresh(self) -> Self:
        """This row as Notion has it now."""
        return self.db.get(self.id)

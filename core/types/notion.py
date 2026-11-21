"""Raw Notion API payloads (the parts PERBot reads)."""
from __future__ import annotations

from typing import Any, NotRequired, TypedDict

__all__ = ['PropertyValue', 'Parent', 'Page', 'QueryResponse']

# A property value as the API returns it: {'type': 'number', 'number': 3}, {'title': [...]}, ...
PropertyValue = dict[str, Any]


class Parent(TypedDict, total=False):
    type: str
    data_source_id: str
    database_id: str
    page_id: str


class Page(TypedDict):
    id: str
    url: NotRequired[str]
    properties: NotRequired[dict[str, PropertyValue]]
    parent: NotRequired[Parent]
    archived: NotRequired[bool]
    in_trash: NotRequired[bool]
    created_time: NotRequired[str]
    last_edited_time: NotRequired[str]


class QueryResponse(TypedDict):
    results: list[Page]
    has_more: NotRequired[bool]
    next_cursor: NotRequired[str | None]

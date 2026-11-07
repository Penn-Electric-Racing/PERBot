from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..config import config
from ..models import BuildCache, CachedPage, DocKind
from ..notion_api import NotionClient
from ..sources.models import SourceDocument
from ..utils.chunk import sleep
from ..utils.logger import logger
from ..utils.text import js_number
from ..utils.notion_text import clean_notion_markdown, is_template_placeholder


@dataclass
class RawNotionPage:
    """A page as returned by `search`, reduced to what the indexer needs."""

    id: str
    title: str
    url: str
    parent: dict[str, Any] | None
    properties: dict[str, Any]
    created_time: str
    last_edited_time: str
    archived: bool


def norm_id(id_: str) -> str:
    return id_.replace('-', '')


def rich_text(items: Any) -> str:
    return ''.join((i or {}).get('plain_text') or '' for i in items).strip() if isinstance(items, list) else ''


def extract_title(page: Any) -> str:
    for value in ((page or {}).get('properties') or {}).values():
        if (value or {}).get('type') == 'title':
            plain = rich_text(value.get('title'))
            if plain:
                return plain
    title = (page or {}).get('title')
    if isinstance(title, str) and title.strip():
        return title.strip()
    return f"Untitled {(page or {}).get('id') or 'page'}"


def is_database_row(page: RawNotionPage) -> bool:
    return (page.parent or {}).get('type') in ('data_source_id', 'database_id')


def _row_data_source_ids(page: RawNotionPage) -> list[str]:
    p = page.parent or {}
    return [norm_id(x) for x in (p.get('data_source_id'), p.get('database_id')) if x]


def properties_text(properties: dict[str, Any]) -> str:
    """Property values as searchable text ("Status: Available · Category: Aero")."""
    lines: list[str] = []
    for name, prop in properties.items():
        prop = prop or {}
        kind = prop.get('type')
        if kind == 'title':
            continue
        if kind == 'rich_text':
            value = rich_text(prop.get('rich_text'))
        elif kind in ('select', 'status'):
            value = (prop.get(kind) or {}).get('name') or ''
        elif kind == 'multi_select':
            value = ', '.join(o.get('name', '') for o in prop.get('multi_select') or [])
        elif kind == 'number':
            n = prop.get('number')
            value = '' if n is None else js_number(n)
        elif kind == 'date':
            d = prop.get('date') or {}
            value = (f"{d['start']} – {d['end']}" if d.get('end') else d['start']) if d.get('start') else ''
        elif kind == 'checkbox':
            value = 'Yes' if prop.get('checkbox') else 'No'
        elif kind in ('url', 'email', 'phone_number'):
            value = prop.get(kind) or ''
        elif kind == 'people':
            value = ', '.join(p.get('name') for p in prop.get('people') or [] if p.get('name'))
        elif kind == 'formula':
            f = prop.get('formula') or {}
            value = f.get('string') or (js_number(f['number']) if f.get('number') is not None else '')
        else:
            continue
        if value:
            lines.append(f'{name}: {value}')
    return '\n'.join(lines)


@dataclass
class _DbInfo:
    title: str
    parent: dict[str, Any] | None


@dataclass
class NotionService:
    client: NotionClient = field(
        default_factory=lambda: NotionClient(auth=config.notion.token, notion_version=config.notion.api_version)
    )
    _db_cache: dict[str, _DbInfo | None] = field(default_factory=dict)
    _block_parent_cache: dict[str, dict[str, Any] | None] = field(default_factory=dict)
    _ancestor_cache: dict[str, list[str]] = field(default_factory=dict)

    def list_all_shared_pages(self) -> list[RawNotionPage]:
        pages: list[RawNotionPage] = []
        cursor: str | None = None
        while True:
            response = self.client.search(
                filter={'property': 'object', 'value': 'page'}, page_size=100, start_cursor=cursor
            )
            for item in response.get('results') or []:
                if item.get('object') != 'page':
                    continue
                pages.append(
                    RawNotionPage(
                        id=item['id'],
                        title=extract_title(item),
                        url=item.get('url', ''),
                        parent=item.get('parent'),
                        properties=item.get('properties') or {},
                        created_time=item.get('created_time', ''),
                        last_edited_time=item.get('last_edited_time', ''),
                        archived=bool(item.get('archived') or item.get('in_trash')),
                    )
                )
            if not response.get('has_more') or not response.get('next_cursor'):
                break
            cursor = response['next_cursor']
        logger.info(f'Discovered {len(pages)} shared Notion pages.')
        return pages

    def get_page_markdown(self, page_id: str) -> str:
        data = self.client.pages.markdown(page_id)
        markdown = data.get('markdown') if isinstance(data.get('markdown'), str) else ''
        if data.get('truncated'):
            logger.warn(f'Markdown for page {page_id} was truncated. Results may be incomplete.')
        return markdown

    def _get_database(self, database_id: str) -> _DbInfo | None:
        key = norm_id(database_id)
        if key in self._db_cache:
            return self._db_cache[key]
        result: _DbInfo | None = None
        try:
            db = self.client.databases.retrieve(database_id)
            result = _DbInfo(title=rich_text(db.get('title')) or '(database)', parent=db.get('parent'))
            sleep(120)
        except Exception as err:
            logger.warn(f'Could not retrieve database {database_id} for breadcrumbs.', str(err))
        self._db_cache[key] = result
        return result

    def _get_block_parent(self, block_id: str) -> dict[str, Any] | None:
        key = norm_id(block_id)
        if key in self._block_parent_cache:
            return self._block_parent_cache[key]
        parent = None
        try:
            block = self.client.blocks.retrieve(block_id)
            parent = block.get('parent')
            sleep(120)
        except Exception as err:
            logger.warn(f'Could not retrieve block {block_id} for breadcrumbs.', str(err))
        self._block_parent_cache[key] = parent
        return parent

    def ancestors_of(self, parent: dict[str, Any] | None, pages_by_id: dict[str, RawNotionPage], depth: int = 0) -> list[str]:
        """Titles of everything above `parent`, top-down. Page parents resolve from the pages we
        already listed (no API call); database and block parents cost one cached request each.
        Stops silently where the integration cannot see further up."""
        if not parent or depth > 12:
            return []
        kind = parent.get('type')
        if kind == 'page_id':
            key = norm_id(parent['page_id'])
            cached = self._ancestor_cache.get(key)
            if cached:
                return cached
            p = pages_by_id.get(key)
            if not p:
                return []
            chain = [*self.ancestors_of(p.parent, pages_by_id, depth + 1), p.title]
            self._ancestor_cache[key] = chain
            return chain
        if kind in ('data_source_id', 'database_id'):
            db_id = parent.get('database_id') or parent.get('data_source_id')
            db = self._get_database(db_id)
            if not db:
                return []
            return [*self.ancestors_of(db.parent, pages_by_id, depth + 1), db.title]
        if kind == 'block_id':
            return self.ancestors_of(self._get_block_parent(parent['block_id']), pages_by_id, depth + 1)
        return []

    def build_indexable_documents(self, cache: BuildCache) -> tuple[list[SourceDocument], dict[str, CachedPage]]:
        """Lists every shared page, fetches (or reuses cached) markdown, cleans it, and keeps the
        pages worth indexing. Database rows are only kept when they carry a real write-up, unless
        their data source is in `NOTION_INDEX_DATA_SOURCE_IDS`, in which case they are indexed as
        records."""
        raw_pages = self.list_all_shared_pages()
        pages_by_id = {norm_id(p.id): p for p in raw_pages}
        allowed = {norm_id(x) for x in config.notion.allowed_page_ids}
        forced_sources = {norm_id(x) for x in config.notion.index_data_source_ids}
        next_cache: dict[str, CachedPage] = {}
        docs: list[SourceDocument] = []
        counts = dict(fetched=0, cached=0, rows_skipped=0, thin=0, templates=0, archived=0, failed=0)

        for page in raw_pages:
            if page.archived:
                counts['archived'] += 1
                continue
            if allowed and norm_id(page.id) not in allowed:
                continue

            is_row = is_database_row(page)
            forced = is_row and any(i in forced_sources for i in _row_data_source_ids(page))

            prev = cache['pages'].get(page.id)
            if prev and prev['lastEditedTime'] == page.last_edited_time:
                markdown = prev['markdown']
                counts['cached'] += 1
            else:
                try:
                    markdown = self.get_page_markdown(page.id)
                    counts['fetched'] += 1
                except Exception as err:
                    logger.warn(f'Skipping page {page.title} ({page.id})', str(err))
                    counts['failed'] += 1
                    continue
                finally:
                    sleep(config.app.index_rate_limit_ms)
            next_cache[page.id] = {'lastEditedTime': page.last_edited_time, 'markdown': markdown}

            body = clean_notion_markdown(markdown)
            kind: DocKind = 'doc'
            clean_text = body

            if forced:
                kind = 'record'
                props = properties_text(page.properties)
                clean_text = '\n\n'.join(x for x in (props, body) if x)
            elif is_row and len(body) < config.app.min_record_body_chars:
                counts['rows_skipped'] += 1
                continue

            if len(clean_text) < config.app.min_page_chars:
                counts['thin'] += 1
                continue
            if kind == 'doc' and is_template_placeholder(clean_text):
                counts['templates'] += 1
                continue

            docs.append(
                SourceDocument(
                    id=page.id,
                    source='notion',
                    kind=kind,
                    title=page.title,
                    url=page.url,
                    ancestors=self.ancestors_of(page.parent, pages_by_id),
                    clean_text=clean_text,
                    created_time=page.created_time,
                    last_edited_time=page.last_edited_time,
                )
            )

            if (counts['fetched'] + counts['cached']) % 500 == 0:
                logger.info(
                    f"Processed {counts['fetched'] + counts['cached']}/{len(raw_pages)} pages ({len(docs)} kept so far)"
                )

        logger.info(
            f"Prepared {len(docs)} documents for indexing — fetched {counts['fetched']}, reused {counts['cached']} from cache; "
            f"skipped {counts['rows_skipped']} bare database rows, {counts['thin']} near-empty pages, "
            f"{counts['templates']} untouched templates, {counts['archived']} archived, {counts['failed']} failed."
        )
        return docs, next_cache

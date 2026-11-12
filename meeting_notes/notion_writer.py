from __future__ import annotations

import os
import re
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from typing import Any
from zoneinfo import ZoneInfo

from notion_api import NotionClient
from meeting_notes.config import NOTION_PARENT_PAGE_ID
from meeting_notes.parse_updates import ParsedUpdate


@lru_cache(maxsize=1)
def _notion() -> NotionClient:
    return NotionClient(auth=os.environ.get('NOTION_API_KEY') or os.environ.get('NOTION_TOKEN') or '')


@dataclass
class SubsystemContent:
    subsystem: str
    updates: ParsedUpdate
    thread_link: str | None
    image_count: int


def _title_for(d: datetime) -> str:
    """"5/24 Mechanical Meeting" — Notion title convention used historically."""
    et = d.astimezone(ZoneInfo('America/New_York'))
    return f'{et.month}/{et.day} Mechanical Meeting'


def create_meeting_notes_page(d: datetime, subsystem_contents: list[SubsystemContent]) -> str:
    children = _build_page_blocks(subsystem_contents)
    # Notion caps `children` at 100 blocks per request — create the page with the first batch,
    # then append the rest in batches of 100.
    batch_size = 100
    result = _notion().pages.create(
        parent={'page_id': NOTION_PARENT_PAGE_ID},
        properties={'title': {'title': [{'text': {'content': _title_for(d)}}]}},
        children=children[:batch_size],
    )
    page_id = result['id']
    for i in range(batch_size, len(children), batch_size):
        _notion().blocks.children.append(page_id, children=children[i : i + batch_size])
    return result['url']


def find_existing_meeting_page_for_today(d: datetime | None = None) -> str | None:
    """Check if a meeting notes page for today's date already exists under the parent page.
    Returns the page URL if found, else None. Used for idempotency when the Wednesday job might
    fire multiple times due to GitHub Actions cron unreliability."""
    expected_title = _title_for(d or datetime.now(ZoneInfo('America/New_York')))
    cursor: str | None = None
    while True:
        result = _notion().blocks.children.list(NOTION_PARENT_PAGE_ID, start_cursor=cursor)
        for block in result.get('results') or []:
            if block.get('type') == 'child_page' and (block.get('child_page') or {}).get('title') == expected_title:
                return f"https://www.notion.so/{block['id'].replace('-', '')}"
        cursor = (result.get('next_cursor') or None) if result.get('has_more') else None
        if not cursor:
            return None


def _build_page_blocks(contents: list[SubsystemContent]) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []

    # Top: General Updates section (left empty — subteam leads fill in manually morning of meeting)
    blocks.append(_h1('General Updates/Announcements'))
    blocks.append(_numbered_list_item(''))

    for c in contents:
        u = c.updates
        blocks.append(_h1(c.subsystem))

        # 3-column block: Deadlines | Complete | Incomplete
        blocks.append(
            _column_list(
                [
                    [_h2('Deadlines'), *_parse_lines(u.deadlines)],
                    [_bold_paragraph('Complete'), *_parse_lines(u.complete)],
                    [_bold_paragraph('Incomplete'), *_parse_lines(u.incomplete)],
                ]
            )
        )

        blocks.append(_h2('Logistical Updates'))
        blocks.extend(_parse_bullets(u.logisticalUpdates))
        blocks.append(_h2('Design Updates (design issues, PDR feedback, CAD updates/screenshots, etc.)'))
        blocks.extend(_parse_bullets(u.designUpdates))
        blocks.append(_h2('Manufacturing Updates'))
        blocks.extend(_parse_bullets(u.manufacturingUpdates))
        blocks.append(_h2('Overdue Items + Catchup Plan'))
        blocks.extend(_parse_bullets(u.overdueItems))
        blocks.append(_h2('14-day Look-Ahead Overview'))
        blocks.extend(_parse_bullets(u.lookAhead))

        # Slack thread link — always include so people can verify source
        if c.thread_link:
            if c.image_count > 0:
                blocks.append(_paragraph_with_link(f'📷 {c.image_count} image(s) posted in thread — ', 'view in Slack', c.thread_link))
            else:
                blocks.append(_paragraph_with_link('💬 ', 'View source thread in Slack', c.thread_link))
        else:
            blocks.append(_italic_paragraph('⚠️ No update thread found for this subsystem this week'))
    return blocks


# --- Notion block helpers -----------------------------------------------------


def _text(content: str, **extra: Any) -> dict[str, Any]:
    return {'type': 'text', 'text': {'content': content}, **extra}


def _h1(text: str) -> dict[str, Any]:
    return {'object': 'block', 'type': 'heading_1', 'heading_1': {'rich_text': [_text(text)]}}


def _h2(text: str) -> dict[str, Any]:
    return {'object': 'block', 'type': 'heading_2', 'heading_2': {'rich_text': [_text(text)]}}


def _bold_paragraph(text: str) -> dict[str, Any]:
    return {'object': 'block', 'type': 'paragraph', 'paragraph': {'rich_text': [_text(text, annotations={'bold': True})]}}


def _italic_paragraph(text: str) -> dict[str, Any]:
    return {
        'object': 'block',
        'type': 'paragraph',
        'paragraph': {'rich_text': [_text(text, annotations={'italic': True, 'color': 'gray'})]},
    }


def _paragraph(text: str) -> dict[str, Any]:
    return {'object': 'block', 'type': 'paragraph', 'paragraph': {'rich_text': [_text(text)] if text else []}}


def _paragraph_with_link(prefix: str, link_text: str, url: str) -> dict[str, Any]:
    return {
        'object': 'block',
        'type': 'paragraph',
        'paragraph': {
            'rich_text': [_text(prefix), {'type': 'text', 'text': {'content': link_text, 'link': {'url': url}}}]
        },
    }


def _bullet_item(text: str) -> dict[str, Any]:
    return {'object': 'block', 'type': 'bulleted_list_item', 'bulleted_list_item': {'rich_text': [_text(text)]}}


def _numbered_list_item(text: str) -> dict[str, Any]:
    return {
        'object': 'block',
        'type': 'numbered_list_item',
        'numbered_list_item': {'rich_text': [_text(text)] if text else []},
    }


def _column_list(columns: list[list[dict[str, Any]]]) -> dict[str, Any]:
    return {
        'object': 'block',
        'type': 'column_list',
        'column_list': {
            'children': [
                # Notion requires at least one child block per column
                {'object': 'block', 'type': 'column', 'column': {'children': col or [_paragraph('')]}}
                for col in columns
            ]
        },
    }


def _lines(text: str) -> list[str]:
    return [line.strip() for line in text.split('\n') if line.strip()]


def _strip_dash(line: str) -> str:
    return re.sub(r'^[-*]\s*', '', line)


def _parse_bullets(text: str) -> list[dict[str, Any]]:
    """Content that should become bulleted list items. Lines that already start with "- " or "* "
    are treated as bullets; anything else is wrapped. Empty input → a single empty paragraph
    (Notion needs something there)."""
    if not text.strip():
        return [_paragraph('')]
    return [_bullet_item(_strip_dash(line)) for line in _lines(text)]


def _parse_lines(text: str) -> list[dict[str, Any]]:
    """Content for the Deadlines/Complete/Incomplete columns — each line becomes a plain bullet
    without preserving leading dashes."""
    if not text.strip():
        return []
    return [_bullet_item(_strip_dash(line)) for line in _lines(text)]

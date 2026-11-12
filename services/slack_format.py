from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from models import SearchResult
from utils.text import escape_slack, locale_int


def _source_line(result: SearchResult, index: int) -> str:
    page = result['page']
    tags: list[str] = []
    if page['revNumber']:
        tags.append(f"REV{page['revNumber']}")
    if page['isHistorical']:
        tags.append('*Historical*')
    if page['source'] == 'drive':
        tags.append(':open_file_folder: Drive')
    crumbs = ' › '.join(page['path'][:-1])
    meta = ' • '.join(x for x in [f'_{escape_slack(crumbs)}_' if crumbs else '', *tags] if x)
    lines = [
        f"*{index + 1}. <{page['url']}|{escape_slack(page['title'])}>*{f'  {meta}' if meta else ''}",
        f"> {escape_slack(result['excerpt'])}" if result['excerpt'] else '',
    ]
    return '\n'.join(x for x in lines if x)


@dataclass
class ResultMeta:
    weak: bool = False
    indexed_pages: int = 0
    generated_at: str = ''


def build_result_blocks(query: str, summary: str, results: list[SearchResult], meta: ResultMeta | None = None) -> list[dict[str, Any]]:
    meta = meta or ResultMeta()
    blocks: list[dict[str, Any]] = [
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': f'*PERBot results for:* `{escape_slack(query)}`'}},
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': summary[:2900]}},
        {'type': 'divider'},
    ]

    if not results:
        blocks.append(
            {
                'type': 'section',
                'text': {
                    'type': 'mrkdwn',
                    'text': 'No matching pages in the indexed docs. Try different words, an acronym spelled out, or a filter like `rev:11`.',
                },
            }
        )
        return blocks

    if meta.weak:
        blocks.append(
            {
                'type': 'context',
                'elements': [
                    {
                        'type': 'mrkdwn',
                        'text': ':thinking_face: Weak match — these are the closest pages, but they may not cover the question.',
                    }
                ],
            }
        )

    for index, result in enumerate(results):
        blocks.append({'type': 'section', 'text': {'type': 'mrkdwn', 'text': _source_line(result, index)[:2900]}})

    footer: list[str] = []
    if meta.indexed_pages:
        footer.append(f'{locale_int(meta.indexed_pages)} pages indexed')
    if meta.generated_at:
        footer.append(f'index from {meta.generated_at[:10]}')
    footer.append('`/dt <question>` · `rev:11` · `subsystem:pcm` · `historical:true`')
    blocks.append({'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': ' · '.join(footer)}]})
    return blocks

"""Turns the Notion `/pages/{id}/markdown` export into plain, searchable markdown.

The export is markdown with Notion-flavoured XML mixed in: `<columns>`, `<callout>`,
`<table>/<tr>/<td>`, `<mention-page>`, `<mention-date start="…"/>`, `<empty-block/>`,
`{toggle="true"}` suffixes, and every image as a signed S3 URL that is thousands of
characters long. Before this cleaner, 21% of all indexed characters were S3 query strings.

Only tags Notion itself emits are touched, and nothing inside ``` code fences is changed,
so `<stdint.h>` or `<Vec<T>>` in a firmware page survive.
"""
from __future__ import annotations

import re

SELF_CLOSING_DROP = [
    'empty-block', 'table_of_contents', 'breadcrumb', 'mention-user', 'unknown', 'unknown_mention',
    'video', 'audio', 'pdf', 'image', 'bookmark', 'link_preview', 'embed', 'divider', 'equation',
]

# Tags whose wrapper is removed but whose inner text is kept.
UNWRAP = [
    'columns', 'column', 'callout', 'details', 'toggle', 'synced_block', 'span', 'quote', 'file',
    'mention-page', 'mention-database', 'mention-block', 'page', 'link_to_page', 'child_page', 'b', 'i', 'u',
]

MONTHS = {
    'january': 1, 'february': 2, 'march': 3, 'april': 4, 'may': 5, 'june': 6, 'july': 7, 'august': 8,
    'september': 9, 'october': 10, 'november': 11, 'december': 12,
    'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'jun': 6, 'jul': 7, 'aug': 8, 'sep': 9, 'sept': 9, 'oct': 10,
    'nov': 11, 'dec': 12,
}

_DROP_RES = [re.compile(rf'<{re.escape(tag)}\b[^>]*/?>') for tag in SELF_CLOSING_DROP]
_UNWRAP_RES = [re.compile(rf'</?{re.escape(tag)}\b[^>]*>') for tag in UNWRAP]


def _convert_tables(md: str) -> str:
    def table(m: re.Match[str]) -> str:
        rows: list[str] = []
        for tr in re.finditer(r'<tr\b[^>]*>([\s\S]*?)</tr>', m.group(1)):
            cells = [re.sub(r'\s+', ' ', c.group(1)).strip() for c in re.finditer(r'<td\b[^>]*>([\s\S]*?)</td>', tr.group(1))]
            if any(cells):
                rows.append(' | '.join(cells))
        return '\n' + '\n'.join(rows) + '\n' if rows else '\n'

    return re.sub(r'<table\b[^>]*>([\s\S]*?)</table>', table, md)


def _clean_segment(md: str) -> str:
    s = md

    # Images: keep the caption, drop the (huge, signed, expiring) URL.
    s = re.sub(r'!\[([^\]]*)\]\([^)]*\)', lambda m: f'[Image: {m.group(1).strip()}]' if m.group(1).strip() else '', s)
    # Links: keep the text.
    s = re.sub(r'\[([^\]]+)\]\((?:https?:|mailto:|notion:|collection:)[^)]*\)', r'\1', s)
    # Bare S3 / attachment URLs that slipped through.
    s = re.sub(r'https?://prod-files-secure\.s3[^\s)>]*', '', s)
    s = re.sub(r'file://%7B[^\s)>]*', '', s)

    # Dates and mentions.
    s = re.sub(
        r'<mention-date\s+start="([^"]+)"(?:\s+end="([^"]+)")?[^>]*/>',
        lambda m: f'{m.group(1)} – {m.group(2)}' if m.group(2) else m.group(1),
        s,
    )
    s = re.sub(r'<database\b[^>]*>([\s\S]*?)</database>', lambda m: f'Database: {m.group(1).strip()}', s)
    s = re.sub(r'<summary\b[^>]*>([\s\S]*?)</summary>', lambda m: f'**{m.group(1).strip()}**', s)

    for rx in _DROP_RES:
        s = rx.sub('', s)
    s = re.sub(r'<br\s*/?>', '\n', s)

    s = _convert_tables(s)
    s = re.sub(r'</?(?:colgroup|col|tr|td|th|thead|tbody)\b[^>]*>', ' ', s)

    for rx in _UNWRAP_RES:
        s = rx.sub('', s)

    # Block attribute suffixes: {toggle="true"}, {color="gray"}, {i=1}
    s = re.sub(r'\s*\{[a-z_-]+=[^}]*\}', '', s)

    # Notion escapes markdown punctuation it wants shown literally.
    s = re.sub(r'\\([\\`*_{}\[\]()#+\-.!$|<>])', r'\1', s)

    # Column/toggle nesting is indented with tabs; two spaces keeps list nesting readable.
    s = re.sub(r'^\t+', lambda m: '  ' * len(m.group(0)), s, flags=re.M)

    s = '\n'.join(re.sub(r'[ \t]+$', '', line) for line in s.split('\n'))
    s = re.sub(r'\n{3,}', '\n\n', s).strip()
    return s


def clean_notion_markdown(markdown: str) -> str:
    if not markdown:
        return ''
    # Leave fenced code untouched.
    parts = re.split(r'(```[\s\S]*?```)', markdown)
    out = ''.join(part if i % 2 == 1 else _clean_segment(part) for i, part in enumerate(parts))
    return re.sub(r'\n{3,}', '\n\n', out).strip()


def is_template_placeholder(clean_text: str) -> bool:
    """Untouched issue/decision templates: headings plus the template's own instructions."""
    return (
        bool(re.search(r'Provide a brief summary of the issue', clean_text, re.I))
        or bool(
            re.search(
                r'Describe the issue in detail, including any relevant background information', clean_text, re.I
            )
        )
    ) and len(clean_text) < 900


def extract_rev_number(*texts: str | None) -> int | None:
    for t in texts:
        if not t:
            continue
        m = re.search(r'\bREV\s*-?\s*(\d{1,2})\b', t, re.I)
        if m:
            return int(m.group(1))
    return None


def _valid(y: int, m: int, d: int) -> str | None:
    if m < 1 or m > 12 or d < 1 or d > 31 or y < 2000 or y > 2100:
        return None
    return f'{y}-{m:02d}-{d:02d}'


def extract_doc_date(title: str) -> str | None:
    """Dates as they appear in PER page titles: "2018-09-04 Weekly Update", "REVX Updates - 02/12/2025",
    "9SLASH25SLASH19 Mech Updates", "July 13, 2022 REV8 Weekly Update", "4/15/26 Mech Meeting Notes".
    Titles like "11/5 Mechanical Meeting" have no year and return None."""
    t = title.replace('SLASH', '/')

    m = re.search(r'\b(20\d{2})-(\d{1,2})-(\d{1,2})\b', t)
    if m:
        return _valid(int(m.group(1)), int(m.group(2)), int(m.group(3)))

    m = re.search(r'\b(\d{1,2})/(\d{1,2})/(\d{2,4})\b', t)
    if m:
        y = 2000 + int(m.group(3)) if len(m.group(3)) == 2 else int(m.group(3))
        return _valid(y, int(m.group(1)), int(m.group(2)))

    m = re.search(r'\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(20\d{2})\b', t)
    if m:
        mo = MONTHS.get(m.group(1).lower())
        if mo:
            return _valid(int(m.group(3)), mo, int(m.group(2)))

    return None

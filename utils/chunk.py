"""Heading-aware chunking of cleaned markdown.

Chunks follow the page's own structure: a heading starts a new chunk once the current one
has real content, paragraphs and list items are never split mid-line unless one line alone
exceeds the maximum, and every chunk remembers the heading path it sits under. The text
that is embedded is prefixed with the page title, breadcrumb and that heading
(`build_embed_text`), which is what lets a chunk that says "the box contains three boards"
match a query about the PCM.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass


@dataclass
class TextChunk:
    heading: str | None
    text: str


@dataclass
class ChunkOptions:
    # Flush once a chunk reaches this many characters.
    target: int
    # Never exceed this; longer single lines are split at sentence boundaries.
    max: int
    # A heading only starts a new chunk when the current one has at least this much.
    min: int


HEADING_RE = re.compile(r'^(#{1,4})\s+(.+?)\s*#*\s*$')


def _split_long_line(line: str, max_len: int) -> list[str]:
    if len(line) <= max_len:
        return [line]
    out: list[str] = []
    rest = line
    while len(rest) > max_len:
        window = rest[:max_len]
        cut = max(window.rfind('. '), window.rfind('; '), window.rfind(', '))
        if cut < max_len * 0.5:
            cut = window.rfind(' ')
        if cut < max_len * 0.3:
            cut = max_len
        out.append(rest[: cut + 1].strip())
        rest = rest[cut + 1 :].strip()
    if rest:
        out.append(rest)
    return out


def chunk_markdown(clean: str, opts: ChunkOptions) -> list[TextChunk]:
    lines = clean.split('\n')
    chunks: list[TextChunk] = []
    heading_stack: list[tuple[int, str]] = []
    current: list[str] = []
    current_len = 0
    current_heading: str | None = None
    in_fence = False

    def heading_path() -> str | None:
        return ' › '.join(h[1] for h in heading_stack) if heading_stack else None

    def flush() -> None:
        nonlocal current, current_len, current_heading
        text = '\n'.join(current).strip()
        if text:
            chunks.append(TextChunk(current_heading, text))
        current = []
        current_len = 0
        current_heading = heading_path()

    for raw_line in lines:
        line = raw_line.rstrip()
        if line.startswith('```'):
            in_fence = not in_fence

        h = None if in_fence else HEADING_RE.match(line)
        if h:
            level = len(h.group(1))
            if current_len >= opts.min:
                flush()
            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()
            heading_stack.append((level, h.group(2).strip()))
            if current_len == 0:
                current_heading = heading_path()
            current.append(line)
            current_len += len(line) + 1
            continue

        for piece in _split_long_line(line, opts.max):
            if current_len > 0 and current_len + len(piece) + 1 > opts.max:
                flush()
            current.append(piece)
            current_len += len(piece) + 1
            if current_len >= opts.target and not in_fence:
                flush()
    flush()

    # Merge trailing crumbs (a lone heading, one short line) into their predecessor.
    merged: list[TextChunk] = []
    for c in chunks:
        prev = merged[-1] if merged else None
        if prev and len(c.text) < 120 and len(prev.text) + len(c.text) + 1 <= opts.max:
            prev.text = f'{prev.text}\n{c.text}'
        else:
            merged.append(c)
    return merged


def build_embed_text(title: str, ancestors: list[str], heading: str | None, text: str) -> str:
    """The exact string that gets embedded (and hashed) for a chunk."""
    crumbs = f"\n{' › '.join(ancestors)}" if ancestors else ''
    head = f'\n{heading}' if heading else ''
    return f'{title}{crumbs}{head}\n\n{text}'


def sleep(ms: float) -> None:
    time.sleep(ms / 1000)

from __future__ import annotations

import math
import re


def clean_whitespace(text: str) -> str:
    return re.sub(r'\s+', ' ', text).strip()


def strip_markdown(text: str) -> str:
    """Markdown → plain text for tokenizing and for the excerpts shown in Slack."""
    s = re.sub(r'```[a-z]*\n?', ' ', text)
    s = re.sub(r'`([^`]+)`', r'\1', s)
    s = re.sub(r'!\[[^\]]*\]\([^)]*\)', ' ', s)
    s = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', s)
    s = re.sub(r'^#{1,6}\s+', '', s, flags=re.M)
    s = re.sub(r'^>\s+', '', s, flags=re.M)
    s = re.sub(r'^\s*[-*]\s+\[[ x]\]\s+', '', s, flags=re.M)
    s = re.sub(r'[*_~]', ' ', s)
    return clean_whitespace(s)


def tokenize(text: str) -> list[str]:
    return [t for t in re.split(r'[^a-z0-9]+', strip_markdown(text).lower()) if len(t) >= 2]


# Words that carry no retrieval signal in a question ("tell me about the PCM").
STOPWORDS = frozenset([
    'a', 'an', 'the', 'of', 'for', 'in', 'on', 'to', 'and', 'or', 'with', 'is', 'are', 'was', 'were', 'be',
    'it', 'its', 'this', 'that', 'these', 'those', 'i', 'we', 'our', 'you', 'your', 'me', 'my', 'us',
    'tell', 'about', 'what', 'whats', 'how', 'do', 'does', 'did', 'can', 'could', 'should', 'would',
    'where', 'when', 'which', 'who', 'why', 'explain', 'describe', 'show', 'find', 'give', 'info',
    'information', 'docs', 'doc', 'documentation', 'page', 'please', 'pls', 'any', 'some', 'there',
    'per', 'team', 'car', 'like', 'get', 'know', 'need', 'want', 'have', 'has', 'at', 'by', 'from', 'as',
    'up', 'so', 'if', 'into', 'out', 'more', 'all',
])


def content_terms(text: str) -> list[str]:
    return [t for t in tokenize(text) if t not in STOPWORDS]


def make_snippet(text: str, max_len: int = 220) -> str:
    cleaned = strip_markdown(text)
    if len(cleaned) <= max_len:
        return cleaned
    return f'{cleaned[: max_len - 1].strip()}…'


def excerpt_around_match(text: str, query: str, max_len: int = 240) -> str:
    cleaned = strip_markdown(text)
    if not cleaned:
        return ''

    tokens = content_terms(query)
    if not tokens:
        return make_snippet(cleaned, max_len)

    haystack = cleaned.lower()
    first_index = -1
    for token in tokens:
        idx = haystack.find(token)
        if idx != -1 and (first_index == -1 or idx < first_index):
            first_index = idx

    if first_index == -1:
        return make_snippet(cleaned, max_len)

    start = max(0, first_index - max_len // 3)
    if start > 0:
        ws = cleaned.find(' ', start)
        if ws != -1 and ws - start < 20:
            start = ws + 1
    end = min(len(cleaned), start + max_len)
    prefix = '…' if start > 0 else ''
    suffix = '…' if end < len(cleaned) else ''
    return f'{prefix}{cleaned[start:end].strip()}{suffix}'


def escape_slack(text: str) -> str:
    return text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def js_number(n: float | int) -> str:
    """`String(n)` for a JSON number: 3.0 → "3", 2.5 → "2.5"."""
    if isinstance(n, float) and n.is_integer():
        return str(int(n))
    return str(n)


def locale_int(n: float | int) -> str:
    """`n.toLocaleString('en-US')` for whole numbers: 12345 → "12,345"."""
    return f'{round(n):,}'


def js_round(n: float) -> int:
    """`Math.round(n)`: halves round up (toward +∞), unlike Python's banker's `round`."""
    return math.floor(n + 0.5)


def round2(n: float) -> float:
    """`Math.round(n * 100) / 100`."""
    return math.floor(n * 100 + 0.5) / 100

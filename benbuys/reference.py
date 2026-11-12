from __future__ import annotations

import re

from benbuys.models import PurchasingRow

# Minimum useful reference length; below this the part number is more informative.
MIN_REFERENCE_SIGNAL = 8


def clean_reference_text(text: str) -> str:
    """Never let a comma (column shift) or a line break into a cart line."""
    return re.sub(r'\s+', ' ', re.sub(r'[,\r\n]+', ' ', text)).strip()


def truncate_at_word(text: str, max_len: int) -> str:
    """Cut to `max_len` chars at a word boundary, no ellipsis (a trailing `…` wastes characters and
    can trip non-ASCII handling in the punchout). Returns '' when the result would carry fewer than
    MIN_REFERENCE_SIGNAL chars of signal (a 7-char "digikey" note says nothing), so the caller can
    fall back to the part number."""
    t = clean_reference_text(text)
    if len(t) <= max_len:
        return t if len(t) >= MIN_REFERENCE_SIGNAL else ''
    cut = t[:max_len]
    if t[max_len] != ' ':
        space = cut.rfind(' ')
        if space > 0:
            cut = cut[:space]
    cut = cut.strip()
    return cut if len(cut) >= MIN_REFERENCE_SIGNAL else ''


def truncate_reference(part_number: str, rows: list[PurchasingRow], max_len: int) -> str:
    """The per-line reference for an aggregated cart line: the first row's sanitized description,
    truncated; `+N` appended when the other rows describe it differently; falls back to
    `Cat. or model no.` (the part number) when there's no usable description."""
    first = rows[0] if rows else None
    base = clean_reference_text(first.sanitized_description if first else '')
    others = {clean_reference_text(r.sanitized_description) for r in rows[1:]}
    others.discard(base)
    suffix = f' +{len(rows) - 1}' if others else ''
    body = truncate_at_word(base, max_len - len(suffix)) if base else ''
    if not body:
        return truncate_at_word(part_number, max_len) or part_number[:max_len]
    return f'{body}{suffix}'

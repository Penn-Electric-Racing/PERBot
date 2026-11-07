from __future__ import annotations

from dataclasses import dataclass

from ..models import DocKind, SourceKind


@dataclass
class SourceDocument:
    """What every source (Notion, Google Drive) hands the indexer: one cleaned document with a
    breadcrumb. The indexer chunks, embeds and scores from here on without caring where the text
    came from."""

    # Globally unique across sources, e.g. a Notion page id or `drive:<fileId>`.
    id: str
    source: SourceKind
    kind: DocKind
    title: str
    url: str
    # Ancestor titles, top-down, excluding the document itself.
    ancestors: list[str]
    clean_text: str
    created_time: str
    last_edited_time: str

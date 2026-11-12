"""Shared record shapes.

Index records are plain dicts with camelCase keys: they are the on-disk JSON format of the
nightly release (index.json, build-cache.json, index-status.json), so the keys must not change.
"""
from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict

InferredBranch = Literal['mechanical', 'electrical', 'operations', 'software', 'general', 'unknown']

InferredSubsystem = Literal[
    'accumulator', 'aero', 'chassis', 'drivetrain', 'suspension', 'vehicle dynamics', 'cooling',
    'driver interface', 'daqdash', 'pcm', 'hv', 'lv', 'electrical', 'software', 'operations',
    'general', 'unknown',
]

InferredDocType = Literal[
    'home', 'overview', 'design', 'spec', 'meeting_notes', 'bom', 'testing_logs', 'qa', 'general', 'unknown'
]

# Where a document came from.
SourceKind = Literal['notion', 'drive']

# `doc` = a written page. `record` = a database row indexed as title + property values.
DocKind = Literal['doc', 'record']


class QueryFilters(TypedDict, total=False):
    season: str
    subsystem: str
    historical: bool
    source: Literal['notion', 'drive']


class ParsedQuery(TypedDict):
    raw: str
    cleaned: str
    filters: QueryFilters


class PageRecord(TypedDict):
    """One indexed document. `path` is the full breadcrumb ending in the page's own title
    (e.g. ["Electrical", "PCM", "REV11 PCM Documentation"]); `pathText` joins it with " › ".
    The raw markdown is NOT stored here (it lives in the indexer's build cache) — chunks hold
    the cleaned text."""

    id: str
    source: SourceKind
    kind: DocKind
    title: str
    url: str
    path: list[str]
    pathText: str
    createdTime: str
    lastEditedTime: str
    # REVnn parsed from title / path / first lines, when present.
    revNumber: int | None
    # ISO date parsed from the title (meeting notes, weekly updates), when present.
    docDate: str | None
    isHistorical: bool
    # Characters of cleaned text on the page.
    textLength: int
    inferredBranch: InferredBranch
    inferredSubsystem: InferredSubsystem
    inferredDocType: InferredDocType


class ChunkRecord(TypedDict):
    id: str
    pageId: str
    chunkIndex: int
    # Nearest heading path inside the page ("Introduction › What is the PCM?"), if any.
    heading: str | None
    # Cleaned display text.
    text: str
    # sha1 of the exact string that was embedded; lets the nightly build reuse vectors.
    hash: str
    # int8 dequantization scale: float = int8 × scale (per-vector max-abs / 127).
    scale: float


class SearchIndex(TypedDict):
    """The JSON half of the index. Embeddings live beside it as one raw int8 file (chunk i at
    [i*dims, (i+1)*dims), dequantized with chunk.scale). int8 costs nothing measurable in ranking
    and is 4× smaller than float32, which is what lets the whole index sit in a 512 MB worker."""

    version: Literal[3]
    generatedAt: str
    currentRev: str
    embeddingModel: str
    embeddingDims: int
    pages: list[PageRecord]
    chunks: list[ChunkRecord]


class CachedPage(TypedDict):
    lastEditedTime: str
    markdown: str


class CachedDriveFile(TypedDict):
    modifiedTime: str
    text: str


class BuildCache(TypedDict):
    """Raw page markdown by page id, so unchanged pages are not re-fetched from Notion nightly."""

    version: Literal[1]
    # Notion: raw markdown per page id.
    pages: dict[str, CachedPage]
    # Google Drive: extracted text per file id.
    drive: NotRequired[dict[str, CachedDriveFile]]


class IndexStatus(TypedDict, total=False):
    state: Literal['idle', 'indexing', 'ready', 'error']
    phase: Literal['building_pages', 'discovering', 'chunking', 'embedding', 'saving', 'complete', 'error']
    startedAt: str
    completedAt: str
    generatedAt: str
    failedAt: str
    indexedPages: int
    indexedChunks: int
    totalPages: int
    totalChunks: int
    totalChunkBatches: int
    embeddedChunkBatches: int
    reusedEmbeddings: int
    lastError: str
    message: str


class SearchResult(TypedDict):
    page: PageRecord
    chunk: ChunkRecord
    # Fused + boosted score used for ordering before the reranker.
    score: float
    lexicalScore: float
    semanticScore: float
    # Short cleaned excerpt for the Slack card.
    excerpt: str


class SearchResponse(TypedDict):
    results: list[SearchResult]
    # True when even the best hit is a weak match; the answer step says so instead of guessing.
    weak: bool


Block = dict[str, Any]

"""On-disk layout (both gzipped when uploaded to the GitHub release):
  data/index.json        pages + chunks (text, no vectors)
  data/embeddings.i8     one raw int8 array, chunk i at [i*dims, (i+1)*dims)
  data/build-cache.json  raw Notion markdown per page id (indexer only)

Splitting vectors out keeps the JSON small enough to parse and lets the bot hold everything in
memory: ~15k chunks × 1536 int8 ≈ 23 MB.
"""
from __future__ import annotations

import itertools
import json
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from config import config
from models import BuildCache, IndexStatus, PageRecord, SearchIndex
from utils.bm25 import BM25Index, build_bm25_index
from utils.chunk import build_embed_text
from utils.clock import iso_now
from utils.logger import logger


@dataclass
class LoadedIndex:
    index: SearchIndex
    # int8 vectors as a (chunks, dims) matrix; multiply a dot product by `scales[i]` to get the
    # cosine (the query is a unit float vector).
    embeddings: np.ndarray
    scales: np.ndarray
    dims: int
    page_by_id: dict[str, PageRecord]
    # Chunk positions (into index.chunks / embeddings) for each page, in page order.
    chunk_idx_by_page: dict[str, list[int]]
    bm25: BM25Index
    loaded_at: str


_cached: LoadedIndex | None = None


def get_loaded_index() -> LoadedIndex | None:
    return _cached


def set_loaded_index(loaded: LoadedIndex | None) -> None:
    global _cached
    _cached = loaded


_temp_counter = itertools.count(1)
_temp_lock = threading.Lock()


def _write_json_atomic(file_path: str, value: Any) -> None:
    """Unique temp name per call so concurrent writers (status updates) never race on one file."""
    Path(file_path).parent.mkdir(parents=True, exist_ok=True)
    with _temp_lock:
        n = next(_temp_counter)
    temp_path = f'{file_path}.{os.getpid()}.{n}.tmp'
    with open(temp_path, 'w', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(temp_path, file_path)


def save_index(index: SearchIndex, embeddings: np.ndarray) -> None:
    flat = np.ascontiguousarray(embeddings, dtype=np.int8).reshape(-1)
    if flat.size != len(index['chunks']) * index['embeddingDims']:
        raise ValueError(
            f"Embedding buffer has {flat.size} values; expected {len(index['chunks'])} × {index['embeddingDims']}."
        )
    _write_json_atomic(config.app.index_path, index)
    Path(config.app.embeddings_path).parent.mkdir(parents=True, exist_ok=True)
    temp_path = f'{config.app.embeddings_path}.tmp'
    flat.tofile(temp_path)
    os.replace(temp_path, config.app.embeddings_path)


def read_index_files(
    index_path: str | None = None, embeddings_path: str | None = None
) -> tuple[SearchIndex, np.ndarray]:
    """Returns the index JSON and its embeddings as a (chunks, dims) int8 matrix."""
    with open(index_path or config.app.index_path, encoding='utf-8') as f:
        index: SearchIndex = json.load(f)
    if index.get('version') != 3:
        raise ValueError(f"Unsupported index version {index.get('version')}; expected 3.")
    raw = np.fromfile(embeddings_path or config.app.embeddings_path, dtype=np.int8)
    dims = index['embeddingDims']
    expected = len(index['chunks']) * dims
    if raw.size != expected:
        raise ValueError(f'Embeddings file has {raw.size} values; index expects {expected}.')
    return index, raw.reshape(len(index['chunks']), dims) if dims else raw.reshape(0, 0)


def quantize(vec: np.ndarray) -> tuple[np.ndarray, float]:
    """Per-vector int8 quantization: q = round(v / scale), scale = max|v| / 127."""
    v = np.asarray(vec, dtype=np.float32).astype(np.float64)
    m = float(np.max(np.abs(v))) if v.size else 0.0
    scale = (m / 127) or 1.0
    # floor(x + 0.5) is JS Math.round (half rounds up), unlike numpy's banker's rounding.
    q = np.floor(v / scale + 0.5).clip(-128, 127).astype(np.int8)
    return q, scale


def assemble_index(index: SearchIndex, embeddings: np.ndarray) -> LoadedIndex:
    page_by_id = {p['id']: p for p in index['pages']}
    chunks = index['chunks']
    embeddings = np.asarray(embeddings, dtype=np.int8).reshape(len(chunks), index['embeddingDims'])
    scales = np.asarray([c['scale'] for c in chunks], dtype=np.float32)
    chunk_idx_by_page: dict[str, list[int]] = {}
    lexical_docs: list[str] = []

    for i, chunk in enumerate(chunks):
        chunk_idx_by_page.setdefault(chunk['pageId'], []).append(i)
        page = page_by_id.get(chunk['pageId'])
        lexical_docs.append(
            build_embed_text(page['title'], page['path'][:-1], chunk['heading'], chunk['text']) if page else chunk['text']
        )

    return LoadedIndex(
        index=index,
        embeddings=embeddings,
        scales=scales,
        dims=index['embeddingDims'],
        page_by_id=page_by_id,
        chunk_idx_by_page=chunk_idx_by_page,
        bm25=build_bm25_index(lexical_docs),
        loaded_at=iso_now(),
    )


def load_index() -> LoadedIndex:
    """Reads the index files, builds the in-memory structures, and caches the result."""
    index, embeddings = read_index_files()
    loaded = assemble_index(index, embeddings)
    set_loaded_index(loaded)
    return loaded


def index_exists() -> bool:
    return os.path.exists(config.app.index_path) and os.path.exists(config.app.embeddings_path)


def load_build_cache() -> BuildCache:
    try:
        with open(config.app.build_cache_path, encoding='utf-8') as f:
            parsed = json.load(f)
        if parsed.get('version') == 1 and parsed.get('pages') is not None:
            return parsed
        logger.warn('Build cache has an unexpected shape; starting from an empty cache.')
    except FileNotFoundError:
        pass
    except Exception as err:
        # A corrupt or unreadable cache silently turns the nightly build into a full re-fetch; say so.
        logger.warn('Build cache could not be read; every page will be fetched again.', err)
    return {'version': 1, 'pages': {}}


def save_build_cache(cache: BuildCache) -> None:
    _write_json_atomic(config.app.build_cache_path, cache)


def load_status() -> IndexStatus | None:
    try:
        with open(config.app.status_path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def save_status(status: IndexStatus) -> None:
    _write_json_atomic(config.app.status_path, status)

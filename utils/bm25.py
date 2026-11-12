from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass

import numpy as np

from utils.text import tokenize

K1 = 1.2
B = 0.75

_DIGITS = re.compile(r'^\d+$')
_HEX = re.compile(r'^[0-9a-f]+$')


@dataclass
class Posting:
    docs: np.ndarray  # uint32 doc positions
    tfs: np.ndarray  # uint16 term frequencies


@dataclass
class BM25Index:
    """BM25 over an inverted index built once at load time."""

    doc_count: int
    avg_doc_len: float
    doc_len: np.ndarray
    # Per term: matching doc positions and term frequencies, packed as numpy arrays.
    postings: dict[str, Posting]


def is_indexable_term(t: str) -> bool:
    """Tokens that can never help a query and only bloat the postings map: PDF/telemetry noise
    such as hex blobs, long digit runs and base64-ish runs. Part numbers ("lm2596", "ad7606") survive."""
    if len(t) > 24:
        return False
    if len(t) >= 9 and _DIGITS.match(t):
        return False
    if len(t) >= 16 and _HEX.match(t):
        return False
    return True


def build_bm25_index(docs: list[str]) -> BM25Index:
    doc_len = np.zeros(len(docs), dtype=np.float32)
    building: dict[str, tuple[list[int], list[int]]] = {}
    total = 0

    for i, doc in enumerate(docs):
        tokens = [t for t in tokenize(doc) if is_indexable_term(t)]
        doc_len[i] = len(tokens)
        total += len(tokens)
        for term, count in Counter(tokens).items():
            p = building.get(term)
            if p is None:
                p = ([], [])
                building[term] = p
            p[0].append(i)
            p[1].append(min(count, 65535))

    # Pack into numpy arrays: ~2M postings as Python lists cost far more memory on Render.
    postings = {
        term: Posting(np.asarray(d, dtype=np.uint32), np.asarray(tf, dtype=np.uint16))
        for term, (d, tf) in building.items()
    }
    building.clear()

    return BM25Index(
        doc_count=len(docs),
        avg_doc_len=(total / len(docs)) if docs else 0.0,
        doc_len=doc_len,
        postings=postings,
    )


def idf(index: BM25Index, term: str) -> float:
    p = index.postings.get(term)
    df = len(p.docs) if p is not None else 0
    return math.log((index.doc_count - df + 0.5) / (df + 0.5) + 1)


def bm25_query(index: BM25Index, terms: list[tuple[str, float]], top_n: int) -> list[tuple[int, float]]:
    """Scores every document that contains at least one query term. Weights let glossary
    expansions count for less than the words the person actually typed. Returns (idx, score)."""
    scores: dict[int, float] = {}
    for term, weight in terms:
        p = index.postings.get(term)
        if p is None:
            continue
        term_idf = idf(index, term)
        tf = p.tfs.astype(np.float64)
        dl = index.doc_len[p.docs].astype(np.float64)
        denom = tf + K1 * (1 - B + (B * dl) / index.avg_doc_len)
        s = term_idf * ((tf * (K1 + 1)) / denom) * weight
        for d, v in zip(p.docs.tolist(), s.tolist()):
            scores[d] = scores.get(d, 0.0) + v
    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    return ranked[:top_n]

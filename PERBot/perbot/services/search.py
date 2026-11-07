"""Hybrid retrieval over chunks:
  query → (vector top-N, BM25 top-N) → reciprocal rank fusion → best chunk per page →
  title/path/recency boosts → Groq rerank of the top pages → top-K.

`rank_pages()` is the deterministic half (no LLM beyond the query embedding) so the eval
harness can score it on its own; `search_index()` adds the reranker and excerpts.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np

from ..config import config
from ..models import ChunkRecord, PageRecord, ParsedQuery, QueryFilters, SearchResponse, SearchResult
from ..utils.bm25 import bm25_query
from ..utils.rrf import reciprocal_rank_fusion
from ..utils.text import content_terms, excerpt_around_match, tokenize
from .index_store import LoadedIndex
from .llm import RerankCandidate, embed_query, rerank_results

VECTOR_CANDIDATES = 80
BM25_CANDIDATES = 80
RERANK_CANDIDATES = 15
# Below this cosine, even the best chunk is probably not about the question.
WEAK_COSINE = 0.34
_DOT_BLOCK = 2048

# PER acronyms → words, added to the lexical query at reduced weight (and the reverse).
GLOSSARY: dict[str, list[str]] = {
    'pcm': ['powertrain', 'control', 'module'],
    'daq': ['data', 'acquisition'],
    'daqdash': ['daq', 'dash', 'dashboard'],
    'dash': ['dashboard', 'daqdash'],
    'tsa': ['tractive', 'system', 'accumulator'],
    'ts': ['tractive', 'system'],
    'air': ['accumulator', 'isolation', 'relay'],
    'airs': ['accumulator', 'isolation', 'relay'],
    'bspd': ['brake', 'system', 'plausibility', 'device'],
    'imd': ['insulation', 'monitoring', 'device'],
    'ams': ['accumulator', 'management', 'system', 'bms'],
    'bms': ['battery', 'management', 'system', 'ams'],
    'lvbms': ['low', 'voltage', 'bms'],
    'pdu': ['power', 'distribution', 'unit'],
    'lv': ['low', 'voltage'],
    'hv': ['high', 'voltage'],
    'vd': ['vehicle', 'dynamics'],
    'di': ['driver', 'interface'],
    'moc': ['motor', 'controller'],
    'mocs': ['motor', 'controllers'],
    'rtds': ['ready', 'to', 'drive', 'sound'],
    'sdc': ['shutdown', 'circuit'],
    'ebs': ['emergency', 'brake', 'system'],
    'hil': ['hardware', 'in', 'the', 'loop'],
    'cfd': ['computational', 'fluid', 'dynamics'],
    'fea': ['finite', 'element', 'analysis'],
    'bom': ['bill', 'of', 'materials'],
    'pefs': ['purchasing', 'procurement'],
    'cdr': ['critical', 'design', 'review'],
    'pdr': ['preliminary', 'design', 'review'],
    'ses': ['structural', 'equivalency', 'spreadsheet'],
    'fsae': ['formula', 'sae'],
    'lec': ['lincoln', 'electric', 'competition'],
    '4wd': ['four', 'wheel', 'drive', 'awd'],
    'awd': ['all', 'wheel', 'drive', '4wd'],
    'tc': ['traction', 'control'],
    'tv': ['torque', 'vectoring'],
    'can': ['canbus'],
    'canbus': ['can', 'bus'],
    'dti': ['drivetrain', 'innovation', 'inverter'],
}

# Glossary keys that are also ordinary words; only expanded when typed in capitals ("AIR", "CAN").
UPPERCASE_ONLY = {'can', 'air', 'airs', 'di', 'ts', 'tc', 'tv', 'dash', 'ses'}

HIGH_LEVEL_HINTS = [
    'high level', 'overview', 'intro', 'introduction', 'summary', 'where should i start', 'new member', 'guide',
    'wiki', 'learn', 'onboarding',
]
NOTES_HINTS = [
    'latest notes', 'recent notes', 'meeting notes', 'meeting', 'notes', 'minutes', 'agenda', 'recent', 'latest',
    'update', 'updates', 'this week', 'last week',
]


def parse_query(text: str) -> ParsedQuery:
    tokens = text.split()
    filters: QueryFilters = {}
    remaining: list[str] = []

    for token in tokens:
        raw_key, *rest = token.split(':')
        value = ':'.join(rest).strip()
        key = raw_key.lower()
        if not value:
            remaining.append(token)
            continue
        if key in ('season', 'rev'):
            v = value.upper()
            filters['season'] = f'REV{v}' if re.fullmatch(r'\d+', v) else v
            continue
        if key == 'subsystem':
            filters['subsystem'] = value.lower()
            continue
        if key == 'historical':
            filters['historical'] = bool(re.fullmatch(r'(true|yes|1)', value, re.I))
            continue
        if key in ('source', 'in'):
            v = value.lower()
            if v in ('notion', 'drive'):
                filters['source'] = v  # type: ignore[typeddict-item]
                continue
        remaining.append(token)

    return {'raw': text, 'cleaned': ' '.join(remaining).strip(), 'filters': filters}


def _passes_filters(parsed: ParsedQuery, page: PageRecord) -> bool:
    f = parsed['filters']
    if f.get('source') and page['source'] != f['source']:
        return False
    if 'historical' in f and page['isHistorical'] != f['historical']:
        return False
    if f.get('season'):
        digits = re.sub(r'\D', '', f['season'])
        n = int(digits) if digits else 0
        hay = page['pathText'].lower()
        if not (page['revNumber'] == n or f['season'].lower() in hay):
            return False
    if f.get('subsystem'):
        hay = f"{page['inferredSubsystem']} {page['pathText']}".lower()
        if f['subsystem'] not in hay:
            return False
    return True


def expand_terms(query: str) -> list[tuple[str, float]]:
    typed = tokenize(query)
    out: dict[str, float] = {t: 1.0 for t in typed}
    content = set(content_terms(query))
    joined = ' '.join(typed)
    for acronym, words in GLOSSARY.items():
        typed_it = acronym in content and (
            acronym not in UPPERCASE_ONLY or re.search(rf'\b{acronym.upper()}\b', query) is not None
        )
        if typed_it:
            for w in words:
                if w not in out:
                    out[w] = 0.4
        elif len(words) > 1 and ' '.join(words) in joined and acronym not in out:
            out[acronym] = 0.8
    return list(out.items())


def _vector_top(loaded: LoadedIndex, q: np.ndarray, allowed: np.ndarray, top_n: int) -> list[tuple[int, float]]:
    if loaded.embeddings.size == 0:
        return []
    # Dot products in row blocks: upcasting the whole int8 matrix at once would be a ~90 MB
    # float temporary per query on a 512 MB worker.
    qf = q.astype(np.float32)
    n = loaded.embeddings.shape[0]
    dots = np.empty(n, dtype=np.float64)
    for start in range(0, n, _DOT_BLOCK):
        block = loaded.embeddings[start : start + _DOT_BLOCK].astype(np.float32)
        dots[start : start + len(block)] = block @ qf
    dots *= loaded.scales
    mask = allowed & (dots > 0.15)
    idxs = np.nonzero(mask)[0]
    order = idxs[np.argsort(-dots[idxs], kind='stable')][:top_n]
    return [(int(i), float(dots[i])) for i in order]


@dataclass
class RankedPage:
    page: PageRecord
    chunk: ChunkRecord
    chunk_idx: int
    score: float
    semantic_score: float
    lexical_score: float
    title_match: float


def rank_pages(loaded: LoadedIndex, parsed: ParsedQuery, query_embedding: np.ndarray) -> list[RankedPage]:
    """Deterministic ranking (query embedding aside): fused chunk scores → boosted page list."""
    query_text = parsed['cleaned'] or parsed['raw']
    chunks = loaded.index['chunks']

    page_allowed: dict[str, bool] = {}
    allowed = np.zeros(len(chunks), dtype=bool)
    for c, chunk in enumerate(chunks):
        pid = chunk['pageId']
        ok = page_allowed.get(pid)
        if ok is None:
            page = loaded.page_by_id.get(pid)
            ok = _passes_filters(parsed, page) if page else False
            page_allowed[pid] = ok
        allowed[c] = ok

    vec = _vector_top(loaded, query_embedding, allowed, VECTOR_CANDIDATES)
    lex = [r for r in bm25_query(loaded.bm25, expand_terms(query_text), BM25_CANDIDATES * 2) if allowed[r[0]]][
        :BM25_CANDIDATES
    ]

    vec_score = dict(vec)
    lex_score = dict(lex)
    fused = reciprocal_rank_fusion([[str(i) for i, _ in vec], [str(i) for i, _ in lex]])

    # Best chunk per page, with a little credit for a second matching chunk.
    by_page: dict[str, list[float]] = {}  # pid → [best idx, best score, second score]
    for key, score in fused.items():
        idx = int(key)
        pid = chunks[idx]['pageId']
        cur = by_page.get(pid)
        if cur is None:
            by_page[pid] = [idx, score, 0.0]
        elif score > cur[1]:
            by_page[pid] = [idx, score, cur[1]]
        elif score > cur[2]:
            cur[2] = score

    terms = content_terms(query_text)
    q = query_text.lower()
    wants_high_level = any(h in q for h in HIGH_LEVEL_HINTS)
    wants_notes = any(h in q for h in NOTES_HINTS)
    wants_historical = re.search(r'\b(historical|old|older|previous|past|rev\s?\d{1,2}|history)\b', q) is not None

    ranked: list[RankedPage] = []
    for pid, (best, best_score, second) in by_page.items():
        page = loaded.page_by_id[pid]
        best = int(best)
        chunk = chunks[best]
        score = best_score + 0.3 * second

        title_tokens = set(tokenize(page['title']))
        ancestor_tokens = set(tokenize(' '.join(page['path'][:-1])))
        title_hits = 0
        path_hits = 0
        for t in terms:
            if t in title_tokens:
                title_hits += 1
            elif t in ancestor_tokens:
                path_hits += 1
        title_match = title_hits / len(terms) if terms else 0.0
        path_match = path_hits / len(terms) if terms else 0.0
        score *= 1 + 0.6 * title_match + 0.15 * path_match
        if len(terms) >= 2 and ' '.join(terms) in page['title'].lower():
            score *= 1.25

        if page['kind'] == 'record':
            score *= 0.75
        # Older-season pages are usually the wrong answer unless the person asked for history;
        # a page from the current or previous season gets a nudge (last season's docs are often
        # the most complete write-up of a subsystem that carried over).
        if page['isHistorical']:
            score *= 1.05 if wants_historical else config.app.historical_penalty

        doc_type = page['inferredDocType']
        if doc_type == 'meeting_notes':
            score *= 1.1 if wants_notes else 0.9
        if wants_high_level and doc_type in ('home', 'overview'):
            score *= 1.15

        ranked.append(
            RankedPage(
                page=page,
                chunk=chunk,
                chunk_idx=best,
                score=score,
                semantic_score=vec_score.get(best, 0.0),
                lexical_score=lex_score.get(best, 0.0),
                title_match=title_match,
            )
        )

    ranked.sort(key=lambda r: r.score, reverse=True)
    return ranked


def search_index(loaded: LoadedIndex, raw_query: str, rerank: bool = True, top_k: int | None = None) -> SearchResponse:
    parsed = parse_query(raw_query)
    query_text = parsed['cleaned'] or parsed['raw']
    k = top_k if top_k is not None else config.app.top_k_results

    ranked = rank_pages(loaded, parsed, embed_query(query_text))
    if not ranked:
        return {'results': [], 'weak': True}

    ordered = ranked[:RERANK_CANDIDATES]
    if rerank and len(ordered) > 1:
        order = rerank_results(
            query_text,
            [
                RerankCandidate(
                    page_id=r.page['id'],
                    title=r.page['title'],
                    path_text=' › '.join(r.page['path'][:-1]) or r.page['source'],
                    text=r.chunk['text'][:500],
                )
                for r in ordered
            ],
        )
        pos = {pid: i for i, pid in enumerate(order)}
        ordered = sorted(ordered, key=lambda r: pos.get(r.page['id'], 99))

    top = ordered[:k]
    best = top[0]
    weak = best.semantic_score < WEAK_COSINE and best.title_match < 0.5

    results: list[SearchResult] = [
        {
            'page': r.page,
            'chunk': r.chunk,
            'score': r.score,
            'lexicalScore': r.lexical_score,
            'semanticScore': r.semantic_score,
            'excerpt': excerpt_around_match(r.chunk['text'], query_text),
        }
        for r in top
    ]
    return {'weak': weak, 'results': results}


def context_for_result(loaded: LoadedIndex, result: SearchResult, max_chars: int) -> str:
    """The best chunk plus its neighbour on the same page, for the answer model."""
    # Chunks are stored in page order, so a page's k-th chunk is idxs[k].
    idxs = loaded.chunk_idx_by_page.get(result['page']['id'], [])
    parts = [result['chunk']['text']]
    k = result['chunk']['chunkIndex'] + 1
    if k < len(idxs):
        parts.append(loaded.index['chunks'][idxs[k]]['text'])
    joined = '\n\n'.join(parts)
    return f'{joined[:max_chars]}…' if len(joined) > max_chars else joined

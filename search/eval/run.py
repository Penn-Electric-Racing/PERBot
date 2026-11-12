"""Retrieval eval: `python -m search.eval.run [--rerank] [--source notion] [--index path --embeddings path]`

For each golden query, a hit = an expected title substring (case-insensitive) appears in the
page title at rank ≤ k. Prints hit@1, hit@3, hit@5, MRR and the top-3 titles for every miss.
Without --rerank it scores `rank_pages` alone (no Groq), so numbers are deterministic.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from config import config
from services.index_store import assemble_index, read_index_files
from services.llm import embed_query
from services.search import parse_query, rank_pages, search_index

JUNK = re.compile(r'X-Amz|<empty-block|\{color=|<columns>|prod-files-secure')


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--rerank', action='store_true')
    # `--source notion` scores the Notion golden set with Drive pages excluded (isolates ranking
    # changes from corpus growth).
    ap.add_argument('--source')
    ap.add_argument('--index', default=config.app.index_path)
    ap.add_argument('--embeddings', default=config.app.embeddings_path)
    args = ap.parse_args(argv)

    golden = json.loads((Path(__file__).parent / 'golden.json').read_text(encoding='utf-8'))
    with_source = (lambda q: f'source:{args.source} {q}') if args.source else (lambda q: q)

    index, embeddings = read_index_files(args.index, args.embeddings)
    loaded = assemble_index(index, embeddings)
    print(
        f"Index: {len(index['pages'])} pages, {len(index['chunks'])} chunks, generated {index['generatedAt']}"
        f"{' (with Groq rerank)' if args.rerank else ''}\n"
    )

    hit1 = hit3 = hit5 = junk_top3 = 0
    rr = 0.0
    misses: list[str] = []

    for g in golden:
        if args.rerank:
            res = search_index(loaded, with_source(g['query']), rerank=True, top_k=10)
            titles = [r['page']['title'] for r in res['results']]
            texts = [r['chunk']['text'] for r in res['results']]
        else:
            parsed = parse_query(with_source(g['query']))
            ranked = rank_pages(loaded, parsed, embed_query(parsed['cleaned'] or parsed['raw']))[:10]
            titles = [r.page['title'] for r in ranked]
            texts = [r.chunk['text'] for r in ranked]
        junk_top3 += sum(1 for t in texts[:3] if JUNK.search(t))
        rank = next((i for i, t in enumerate(titles) if any(e.lower() in t.lower() for e in g['expect'])), -1)
        if rank == 0:
            hit1 += 1
        if 0 <= rank < 3:
            hit3 += 1
        if 0 <= rank < 5:
            hit5 += 1
        if rank >= 0:
            rr += 1 / (rank + 1)
        mark = '✗' if rank == -1 else '✓' if rank == 0 else str(rank + 1)
        print(f"{mark:>2}  {g['query']}")
        if rank != 0:
            misses.append(
                f"   {g['query']} → expected {' | '.join(g['expect'])}\n      got: {' · '.join(titles[:3])}"
            )

    n = len(golden)
    print(
        f'\nhit@1 {hit1}/{n} ({100 * hit1 / n:.0f}%)   hit@3 {hit3}/{n} ({100 * hit3 / n:.0f}%)   '
        f'hit@5 {hit5}/{n} ({100 * hit5 / n:.0f}%)   MRR {rr / n:.3f}'
    )
    print(f'top-3 chunks containing Notion XML / S3 junk: {junk_top3}/{3 * n}')
    if misses:
        print('\nNot at rank 1:\n' + '\n'.join(misses))


if __name__ == '__main__':
    try:
        main()
    except Exception as err:
        print(err, file=sys.stderr)
        sys.exit(1)

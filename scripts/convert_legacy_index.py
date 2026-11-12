"""One-off: turn the old single-file `notion-index.json` (v1, embeddings inline) into the indexer's
build cache so the first v2 build can skip re-fetching ~9,600 pages from Notion.

Usage: python scripts/convert_legacy_index.py <legacy notion-index.json> [out-dir]
"""
from __future__ import annotations

import json
import os
import sys


def main(argv: list[str]) -> int:
    if not argv:
        print('usage: convert_legacy_index.py <legacy notion-index.json> [out-dir]', file=sys.stderr)
        return 1
    legacy_path = argv[0]
    out_dir = argv[1] if len(argv) > 1 else './data'

    with open(legacy_path, 'rb') as f:
        buf = f.read()
    # Parse only the head (pages) — the inline chunk embeddings are most of the file.
    ci = buf.find(b',"chunks":[')
    if ci == -1:
        raise SystemExit('not a legacy index (no chunks array)')
    head = json.loads(buf[:ci].decode('utf-8') + '}')
    cache = {
        'version': 1,
        'pages': {p['id']: {'lastEditedTime': p.get('lastEditedTime'), 'markdown': p.get('markdown')} for p in head['pages']},
    }
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, 'build-cache.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False, separators=(',', ':'))
    print(f"wrote build cache for {len(head['pages'])} pages (generated {head.get('generatedAt')}) → {out}")
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

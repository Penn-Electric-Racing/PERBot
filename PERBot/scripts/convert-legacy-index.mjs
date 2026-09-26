// One-off: turn the old single-file `notion-index.json` (v1, embeddings inline) into the
// indexer's build cache so the first v2 build can skip re-fetching ~9,600 pages from Notion.
// Usage: node --max-old-space-size=8192 scripts/convert-legacy-index.mjs <legacy.json> [out-dir]
import fs from 'node:fs';
import path from 'node:path';

const [, , legacyPath, outDir = './data'] = process.argv;
if (!legacyPath) {
  console.error('usage: convert-legacy-index.mjs <legacy notion-index.json> [out-dir]');
  process.exit(1);
}
const buf = fs.readFileSync(legacyPath);
const marker = Buffer.from(',"chunks":[');
const ci = buf.indexOf(marker);
if (ci === -1) throw new Error('not a legacy index (no chunks array)');
const head = JSON.parse(buf.subarray(0, ci).toString('utf8') + '}');
const cache = { version: 1, pages: {} };
for (const p of head.pages) cache.pages[p.id] = { lastEditedTime: p.lastEditedTime, markdown: p.markdown };
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'build-cache.json'), JSON.stringify(cache));
console.log(`wrote build cache for ${head.pages.length} pages (generated ${head.generatedAt}) → ${path.join(outDir, 'build-cache.json')}`);

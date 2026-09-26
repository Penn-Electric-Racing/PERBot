import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../../config.js';
import { assembleIndex, readIndexFiles } from '../../services/index-store.js';
import { embedQuery } from '../../services/llm.js';
import { parseQuery, rankPages, searchIndex } from '../../services/search.js';

/**
 * Retrieval eval: `npm run search:eval [-- --rerank] [-- --index path/to/index.json --embeddings path]`
 *
 * For each golden query, a hit = an expected title substring (case-insensitive) appears in the
 * page title at rank ≤ k. Prints hit@1, hit@3, hit@5, MRR and the top-3 titles for every miss.
 * Without --rerank it scores `rankPages` alone (no Groq), so numbers are deterministic.
 */

interface Golden {
  query: string;
  expect: string[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const golden = JSON.parse(await fs.readFile(path.join(here, 'golden.json'), 'utf8')) as Golden[];
  const rerank = process.argv.includes('--rerank');
  // `--source notion` scores the Notion golden set with Drive pages excluded (isolates ranking
  // changes from corpus growth).
  const sourceFilter = arg('--source');
  const withSource = (query: string) => (sourceFilter ? `source:${sourceFilter} ${query}` : query);
  const indexPath = arg('--index') ?? config.app.indexPath;
  const embeddingsPath = arg('--embeddings') ?? config.app.embeddingsPath;

  const { index, embeddings } = await readIndexFiles(indexPath, embeddingsPath);
  const loaded = assembleIndex(index, embeddings);
  console.log(
    `Index: ${index.pages.length} pages, ${index.chunks.length} chunks, generated ${index.generatedAt}${rerank ? ' (with Groq rerank)' : ''}\n`
  );

  let hit1 = 0;
  let hit3 = 0;
  let hit5 = 0;
  let rr = 0;
  let junkTop3 = 0;
  const misses: string[] = [];
  const JUNK = /X-Amz|<empty-block|\{color=|<columns>|prod-files-secure/;

  for (const g of golden) {
    let titles: string[];
    let texts: string[];
    if (rerank) {
      const res = await searchIndex(loaded, withSource(g.query), { rerank: true, topK: 10 });
      titles = res.results.map((r) => r.page.title);
      texts = res.results.map((r) => r.chunk.text);
    } else {
      const parsed = parseQuery(withSource(g.query));
      const q = await embedQuery(parsed.cleaned || parsed.raw);
      const ranked = rankPages(loaded, parsed, q).slice(0, 10);
      titles = ranked.map((r) => r.page.title);
      texts = ranked.map((r) => r.chunk.text);
    }
    junkTop3 += texts.slice(0, 3).filter((t) => JUNK.test(t)).length;
    const rank = titles.findIndex((t) => g.expect.some((e) => t.toLowerCase().includes(e.toLowerCase())));
    if (rank === 0) hit1++;
    if (rank >= 0 && rank < 3) hit3++;
    if (rank >= 0 && rank < 5) hit5++;
    if (rank >= 0) rr += 1 / (rank + 1);
    const mark = rank === -1 ? '✗' : rank === 0 ? '✓' : `${rank + 1}`;
    console.log(`${mark.padStart(2)}  ${g.query}`);
    if (rank !== 0) misses.push(`   ${g.query} → expected ${g.expect.join(' | ')}\n      got: ${titles.slice(0, 3).join(' · ')}`);
  }

  const n = golden.length;
  console.log(`\nhit@1 ${hit1}/${n} (${((100 * hit1) / n).toFixed(0)}%)   hit@3 ${hit3}/${n} (${((100 * hit3) / n).toFixed(0)}%)   hit@5 ${hit5}/${n} (${((100 * hit5) / n).toFixed(0)}%)   MRR ${(rr / n).toFixed(3)}`);
  console.log(`top-3 chunks containing Notion XML / S3 junk: ${junkTop3}/${3 * n}`);
  if (misses.length) console.log(`\nNot at rank 1:\n${misses.join('\n')}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

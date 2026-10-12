import { config } from '../config.js';
import { findParts } from './finder.js';
import { createPartsLlm } from './llm.js';
import { money, optionText } from './slack.js';
import type { RankMode } from './types.js';

/**
 * Run a /parts search locally, without Slack or Notion writes (from PERBot/PERBot with .env):
 *   npm run parts -- "LM7805"
 *   npm run parts -- "LM7805" -q 50 --cheapest
 *   npm run parts -- "LM7805" --json            full candidate list as JSON
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const mode: RankMode = args.includes('--cheapest') ? 'cheapest' : 'best';
  const qIdx = args.findIndex((a) => a === '-q' || a === '--qty');
  const qty = qIdx >= 0 ? Number(args[qIdx + 1]) : 1;
  const part = args.filter((a, i) => !a.startsWith('-') && !(qIdx >= 0 && i === qIdx + 1)).join(' ');
  if (!part || !Number.isInteger(qty) || qty < 1) throw new Error('Usage: npm run parts -- "<part>" [-q N] [--cheapest] [--json]');

  const llm = createPartsLlm();
  if (!llm) throw new Error('No LLM configured: set GEMINI_API_KEY or GROQ_API_KEY in .env.');
  console.error(`Searching ${config.parts.pool} listings for "${part}" ×${qty} with ${llm.label}…`);
  const result = await findParts(part, { qty, mode, top: config.parts.top, pool: config.parts.pool, perSupplier: config.parts.perSupplier, llm });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Best ${result.top.length} of ${result.stats.candidates} (via ${result.source}; ${result.stats.fetched} pages read, ${result.stats.priced} priced)\n`);
  result.top.forEach((c, i) => {
    // Slack mrkdwn → plain text: drop the *bold* / _italic_ markers and unwrap <url|text>.
    console.log(optionText(c, i).replace(/<([^|>]+)\|([^>]+)>/g, '$2\n   $1').replace(/[*_]/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    if (c.error) console.log(`   (${c.error})`);
    console.log(`   Cat. no.: ${c.partNumber ?? 'n/a'} · cost ${money(c.cost, c.currency)}${c.packSize > 1 ? ` per pack of ${c.packSize}` : ''}\n`);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

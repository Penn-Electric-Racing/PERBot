import fs from 'node:fs/promises';
import path from 'node:path';
import { extractSlip } from './extract.js';
import { matchSlip } from './match.js';
import { ArrivalsNotion } from './notion.js';

/**
 * Read-only trial of the arrivals pipeline on local photos — the Week-1 accuracy check.
 *
 *   npm run arrivals:try -- slip.jpg                 one package (several files = one box)
 *   npm run arrivals:try -- --each ./slip-photos     every image in a folder, one package each
 *
 * Reads Notion, calls the vision model, writes nothing. Prices are never printed (never extracted).
 */

const TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

async function imagesIn(target: string): Promise<string[]> {
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) return [target];
  const names = (await fs.readdir(target)).filter((n) => TYPES[path.extname(n).toLowerCase()]).sort();
  return names.map((n) => path.join(target, n));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const each = args.includes('--each');
  const targets = args.filter((a) => a !== '--each');
  if (targets.length === 0) {
    console.error('Usage: npm run arrivals:try -- [--each] <image|folder> [...]   (.jpg/.png/.webp; convert HEIC first)');
    process.exitCode = 1;
    return;
  }

  const files = (await Promise.all(targets.map(imagesIn))).flat();
  const packages = each ? files.map((f) => [f]) : [files];
  const openRows = await new ArrivalsNotion().openRows();
  console.log(`${openRows.length} open Purchasing rows.\n`);

  const tally: Record<string, number> = {};
  for (const pkg of packages) {
    const images = await Promise.all(pkg.map(async (f) => ({ data: await fs.readFile(f), mimeType: TYPES[path.extname(f).toLowerCase()]! })));
    const started = Date.now();
    const extraction = await extractSlip(images);
    const match = matchSlip(extraction, openRows);
    tally[match.confidence] = (tally[match.confidence] ?? 0) + 1;

    console.log(`=== ${pkg.map((f) => path.basename(f)).join(' + ')}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    console.log(`slip: ${extraction.isShippingDocument ? 'yes' : 'NO'} · legible: ${extraction.legible ? 'yes' : 'NO'} · vendor: ${extraction.vendor ?? '?'}`);
    console.log(`order #s: ${extraction.orderNumbers.map((o) => `${o.kind}=${o.value}`).join(', ') || '-'}`);
    console.log(`tracking: ${extraction.trackingNumbers.join(', ') || '-'}`);
    console.log(`→ ${match.confidence.toUpperCase()} · run ${match.runId ?? '-'} · ${match.matchedRows.length} matched of ${match.lines.length} lines (order has ${match.orderRows.length} open rows)`);
    for (const { line, row } of match.lines) {
      const pn = line.vendorPartNumber ?? line.manufacturerPartNumber ?? line.customerReference ?? '?';
      console.log(`  ${row ? '✓' : '✗'} ${pn} ×${line.quantityShipped ?? '?'}${row ? `  →  ${row.name} (${row.partNumber}, ×${row.quantity}, ${row.runId || 'no run'})` : ''}`);
    }
    console.log('');
  }
  console.log('Summary:', JSON.stringify(tally));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

import { writeFileSync } from 'node:fs';
import { todayIsoET } from './dates.js';
import { extractHostname } from './domain.js';
import { FsaeScan, formatFsaeEvidence, scanFsaeTies } from './fsaeTies.js';
import { SponsorNotion } from './notion.js';
import type { BankLeadRow } from './types.js';

/**
 * CLI: `npm run fsae-scan [-- --dry-run] [--rescan] [--limit N] [--out report.csv]`
 * Backfills the FSAE-ties scan across every live Bank lead (Available + Claimed; the
 * same set `/sponsor rank` ranks). Rows already scanned are skipped unless --rescan, so
 * a re-run only retries the ones that failed. --dry-run prints results without writing.
 */

const CONCURRENCY = 4;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function csvCell(s: string): string {
  return `"${s.replace(/"/g, '""').replace(/\s*\n\s*/g, ' | ')}"`;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const rescan = process.argv.includes('--rescan');
  const limit = Number(arg('--limit') ?? Infinity);
  const out = arg('--out');

  const notion = new SponsorNotion();
  if (!dryRun) {
    const added = await notion.ensureFsaeColumns();
    if (added.length) console.log(`Added Bank columns: ${added.join(', ')}`);
  }

  const live = await notion.queryRankableProspects();
  const todo = live.filter((r) => rescan || !r.fsaeScannedAt).slice(0, limit);
  console.log(`${live.length} live Bank rows; scanning ${todo.length}${dryRun ? ' (dry run)' : ''}.`);

  const today = todayIsoET();
  const results: Array<{ row: BankLeadRow; scan?: FsaeScan; error?: string }> = [];
  let next = 0;
  let done = 0;

  async function worker(): Promise<void> {
    while (next < todo.length) {
      const row = todo[next++]!;
      const host = extractHostname(row.domain);
      if (!host) {
        results.push({ row, error: 'no domain' });
      } else {
        try {
          const scan = await scanFsaeTies(row.company, host);
          if (!dryRun) await notion.writeFsaeScan(row.id, scan, today);
          results.push({ row, scan });
          if (scan.ties || scan.companyMentions.length) {
            console.log(`  ${scan.ties ? '🏁' : '· '} ${row.company}: ${formatFsaeEvidence(scan).split('\n').join(' / ')}`);
          }
        } catch (err) {
          results.push({ row, error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (++done % 25 === 0) console.log(`  …${done}/${todo.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const ties = results.filter((r) => r.scan?.ties);
  const company = results.filter((r) => r.scan && !r.scan.ties && r.scan.companyMentions.length);
  const failed = results.filter((r) => r.error);
  const noPages = results.filter((r) => r.scan && r.scan.pagesScanned.length === 0);
  console.log(`\nScanned ${results.length}: 🏁 ${ties.length} with FSAE ties · ${company.length} company-level FSAE mentions only · ${noPages.length} unreachable sites · ${failed.length} errors.`);
  for (const f of failed) console.log(`  ✗ ${f.row.company} (${f.row.domain}): ${f.error}`);

  if (out) {
    const header = 'company,domain,fsae_ties,people,evidence,pages_scanned,error,url';
    const lines = results.map((r) =>
      [
        r.row.company,
        r.row.domain,
        r.scan ? String(r.scan.ties) : '',
        r.scan?.people.map((p) => p.name).join('; ') ?? '',
        r.scan ? formatFsaeEvidence(r.scan) : '',
        String(r.scan?.pagesScanned.length ?? ''),
        r.error ?? '',
        r.row.url,
      ].map(csvCell).join(',')
    );
    writeFileSync(out, [header, ...lines].join('\n') + '\n');
    console.log(`Report: ${out}`);
  }
}

void main();

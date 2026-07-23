import { findMatchingProspects, scoutCompanies } from './discovery.js';
import { SponsorNotion } from './notion.js';
import { priorityScore, quadrant } from './scoring.js';

/**
 * CLI: `npm run find -- "<need>"` / `npm run scout -- "<need>"`
 * Mirrors the `/sponsor find` and `/sponsor scout` Slack commands for testing
 * without Slack. Both are read-only (no Notion writes, no Hunter credits).
 */
async function main(): Promise<void> {
  const [mode, ...restArgs] = process.argv.slice(2);
  const need = restArgs.join(' ').trim();
  if ((mode !== 'find' && mode !== 'scout') || !need) {
    console.error('Usage: npm run find -- "<need>"  |  npm run scout -- "<need>"');
    process.exit(1);
  }

  const notion = new SponsorNotion();

  if (mode === 'find') {
    const rows = (await notion.queryRankableProspects()).filter((r) => r.status === 'Available');
    console.log(`\nSearching ${rows.length} unclaimed Bank leads for: ${need}\n`);
    const matches = await findMatchingProspects(need, rows);
    if (matches.length === 0) {
      console.log('No matches.\n');
      return;
    }
    for (const [i, { row, why }] of matches.entries()) {
      console.log(`${i + 1}. ${row.company} — ${why}`);
      console.log(`   priority ${priorityScore(row.scores)} ${quadrant(row.scores)} · ${row.url}`);
    }
    console.log('');
    return;
  }

  const known = await notion.queryAllBankDomains();
  console.log(`\nScouting new companies for: ${need} (skipping ${known.size} known domains)\n`);
  const { candidates, rejectedCount } = await scoutCompanies(need, known);
  if (candidates.length === 0) {
    console.log(`No candidates survived (${rejectedCount} rejected by the homepage check).\n`);
    return;
  }
  for (const c of candidates) {
    const badge = c.verdict === 'confirmed' ? '✓' : '⚠️ unverified';
    console.log(`${badge}  ${c.company} (${c.hostname}) — ${c.why}`);
    if (c.note) console.log(`   verifier: ${c.note}`);
  }
  if (rejectedCount > 0) console.log(`\n${rejectedCount} suggestion(s) dropped — homepage didn't match the claim.`);
  console.log('\nAdd keepers with: npm run enrich -- "<domain>"  (or /sponsor add <domain> in Slack)\n');
}

void main();

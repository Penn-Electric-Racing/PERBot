import { todayIsoET } from './dates.js';
import { backfillNextAction } from './nextActions.js';
import { SponsorNotion } from './notion.js';

/**
 * CLI: `npm run fix-next-actions [-- --apply]`
 * One-time cleanup (2026-10-22) of deals past Prospect that still say "Send first
 * outreach" (see nextActions.ts for the bug). It prints every planned change, and with
 * --apply it writes them. Re-running is safe: a fixed deal no longer matches, so it's skipped.
 */
async function main(): Promise<void> {
  const apply = process.argv.includes('--apply') || process.env.APPLY?.toLowerCase() === 'true';
  const notion = new SponsorNotion();
  const today = todayIsoET();

  const deals = await notion.queryAllDeals();
  const plan = deals.flatMap((d) => {
    const change = backfillNextAction(d, today);
    return change ? [{ deal: d, change }] : [];
  });

  const followUps = plan.filter((p) => p.change.action);
  console.log(`${deals.length} deals; ${plan.length} to fix: ${followUps.length} get a follow-up, ${plan.length - followUps.length} cleared.${apply ? '' : ' (dry run, pass --apply to write)'}`);
  for (const { deal, change } of plan) {
    const to = change.action ? `"${change.action}" due ${change.dateIso}` : '(cleared)';
    console.log(`  ${(deal.stage ?? '').padEnd(9)} ${(deal.company || 'Untitled').padEnd(32)} → ${to}`);
  }
  if (!apply) return;

  let done = 0;
  for (const { deal, change } of plan) {
    try {
      await notion.applyNextAction(deal.id, change);
      done++;
    } catch (err) {
      console.error(`  ✗ ${deal.company || deal.id}: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }
  console.log(`Wrote ${done}/${plan.length}.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

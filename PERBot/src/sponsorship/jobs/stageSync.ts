import { logger } from '../../utils/logger.js';
import { CONTACTED_STAGES, SponsorNotion } from '../notion.js';
import { PipelineRow } from '../types.js';

/**
 * Hourly stage sync: the weekly quota counts deals that MOVED OUT OF PROSPECT (outreach
 * sent — Arjun's rule, 2026-09-12: "movements from Prospect to Contacted"). `/sponsor
 * stage` / `/sponsor won` stamp `Contacted at` instantly, but people also edit Stage in
 * Notion, and Notion doesn't date select changes. So each run finds deals sitting at
 * Contacted / In talks / Won with no `Contacted at` and stamps them now (accurate to the
 * sync cadence). Once per deal, ever — moving back to Prospect and forward again never
 * re-stamps, so nobody can farm credit.
 *
 * STAGE_SYNC_BACKFILL=true (one-time, at rollout): stamp with the deal's creation time
 * instead of now, so deals that were already past Prospect before the column existed don't
 * all land in the current audit week.
 *
 * Idempotent by construction: only unstamped past-Prospect deals are written.
 */

/** ISO to stamp on `deal`, or null if it needs no stamp. */
export function contactedStampFor(deal: PipelineRow, nowIso: string, backfill: boolean): string | null {
  if (deal.contactedAt) return null;
  if (!deal.stage || !CONTACTED_STAGES.has(deal.stage)) return null;
  return backfill && deal.createdTime ? deal.createdTime : nowIso;
}

export async function syncContactedStamps(
  notion: SponsorNotion = new SponsorNotion(),
  backfill = process.env.STAGE_SYNC_BACKFILL?.toLowerCase() === 'true'
): Promise<{ scanned: number; stamped: number }> {
  const deals = await notion.queryAllDeals();
  const nowIso = new Date().toISOString();
  let stamped = 0;
  for (const deal of deals) {
    const iso = contactedStampFor(deal, nowIso, backfill);
    if (!iso) continue;
    await notion.writeContactedAt(deal.id, iso);
    stamped += 1;
    logger.info(`Stage sync: ${deal.company || deal.id} (${deal.stage}) → Contacted at ${iso}${backfill ? ' (backfill)' : ''}.`);
  }
  logger.info(`Stage sync: scanned ${deals.length} deals, stamped ${stamped}.`);
  return { scanned: deals.length, stamped };
}

// Entrypoint when run directly (GitHub Actions).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  syncContactedStamps().catch((err) => {
    logger.error('Stage sync job failed.', err);
    process.exitCode = 1;
  });
}

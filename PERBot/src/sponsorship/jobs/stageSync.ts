import { logger } from '../../utils/logger.js';
import { daysUntil } from '../dates.js';
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
 * `now` is only an honest guess for a deal that moved recently — it assumes the sync has
 * been watching continuously, so an unstamped deal must have just moved. That assumption is
 * false for any deal older than the sync itself, and the rollout run proved it: on
 * 2026-09-12 17:22 UTC the first-ever run stamped 8 deals sitting at Contacted since July
 * and August with `now` (STAGE_SYNC_BACKFILL wasn't set), dropping all 8 into that week's
 * quota window — one member's `/sponsor quota` read 11/3 off three real contacts.
 *
 * So a deal the sync has never stamped that is older than SYNC_FRESH_DAYS is treated as
 * bookkeeping catch-up, not this hour's outreach, and dated from its own evidence: Last
 * contact if someone recorded one, else the deal's creation time. Someone who really does
 * email an old prospect today records that contact (`/sponsor stage` stamps Last contact
 * for them), so genuine work still lands in the right week.
 *
 * Idempotent by construction: only unstamped past-Prospect deals are written.
 */

/** A never-stamped deal older than this predates the sync's watch — don't date it `now`. */
export const SYNC_FRESH_DAYS = 7;

/** ISO to stamp on `deal`, or null if it needs no stamp. */
export function contactedStampFor(deal: PipelineRow, nowIso: string, backfill: boolean): string | null {
  if (deal.contactedAt) return null;
  if (!deal.stage || !CONTACTED_STAGES.has(deal.stage)) return null;
  if (!deal.createdTime) return nowIso;
  if (backfill) return deal.createdTime;
  // Older than the sync's watch ⇒ catch-up, not this hour's outreach (see above).
  const ageDays = -daysUntil(deal.createdTime);
  if (ageDays > SYNC_FRESH_DAYS) return deal.lastContact ?? deal.createdTime;
  return nowIso;
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
    const dated = iso === nowIso ? '' : backfill ? ' (backfill)' : ' (pre-dates the sync — dated from the deal, not now)';
    logger.info(`Stage sync: ${deal.company || deal.id} (${deal.stage}) → Contacted at ${iso}${dated}.`);
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

import { logger } from '../../utils/logger.js';
import { SponsorNotion } from '../notion.js';
import { PipelineRow } from '../types.js';

/**
 * Hourly DRI sync: Notion doesn't record WHEN a person was added to a people property,
 * so PERBot keeps its own ledger on each Pipeline deal (`DRI assigned`: one
 * "<user id> <ISO>" line per current DRI). Each run diffs every deal's DRI set against
 * its ledger — new DRIs are stamped, removed DRIs are dropped, deals whose ledger is
 * empty are backfilled with the deal's creation time (the best evidence for assignments
 * that predate the ledger). The quota audit + `/sponsor quota` count by these stamps, so
 * a re-assignment onto an older deal counts in the week it happened (Arjun's rule,
 * 2026-09-11). Granularity is the sync cadence: an assign→unassign inside one hour is
 * invisible, which is fine.
 *
 * Idempotent by construction: only deals whose ledger would change are written.
 */

/** The ledger a deal should have now, or null if it's already correct. */
export function reconcileLedger(deal: PipelineRow, nowIso: string): Record<string, string> | null {
  const current = new Set(deal.driUserIds.map((id) => id.toLowerCase()));
  const next: Record<string, string> = {};
  const ledgerEmpty = Object.keys(deal.driAssignedAt).length === 0;
  for (const id of current) {
    // First-ever stamp on a deal → the deal's creation time (pre-ledger assignments);
    // later additions → now.
    next[id] = deal.driAssignedAt[id] ?? (ledgerEmpty && deal.createdTime ? deal.createdTime : nowIso);
  }
  const before = Object.entries(deal.driAssignedAt).sort().join('|');
  const after = Object.entries(next).sort().join('|');
  return before === after ? null : next;
}

export async function syncDriLedger(notion: SponsorNotion = new SponsorNotion()): Promise<{ scanned: number; updated: number }> {
  const deals = await notion.queryAllDeals();
  const nowIso = new Date().toISOString();
  let updated = 0;
  for (const deal of deals) {
    const next = reconcileLedger(deal, nowIso);
    if (!next) continue;
    await notion.writeDriLedger(deal.id, next);
    updated += 1;
    logger.info(`DRI sync: ${deal.company || deal.id} → ${Object.keys(next).length} DRI(s) stamped.`);
  }
  logger.info(`DRI sync: scanned ${deals.length} deals, updated ${updated}.`);
  return { scanned: deals.length, updated };
}

// Entrypoint when run directly (GitHub Actions).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  syncDriLedger().catch((err) => {
    logger.error('DRI sync job failed.', err);
    process.exitCode = 1;
  });
}

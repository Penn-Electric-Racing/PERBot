import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { claimOnce } from '../utils/schedule.js';

/**
 * Hands rows added by /parts to the Purchasing price checker (price_check.py in
 * PER-Purchase-Testing), which re-prices them (Mouser/DigiKey APIs + web) and DMs the
 * Point of contact when the price moved.
 *
 * The queue is the ⚙️ PERBot Job Log: one `price-check-queue <page id>` claim per row
 * (claimOnce, so a row is never queued twice). The checker also queues rows added in Notion
 * directly, drains the queue a batch at a time every 30 minutes, and marks entries done.
 * This just gets /parts rows checked sooner: queue now, and a GitHub repository_dispatch
 * starts the checker's workflow right away instead of on its schedule.
 *
 * Best effort: nothing here may break "Add to Purchasing", so errors are logged, not thrown.
 */

export const QUEUE_JOB = 'price-check-queue';
export const DISPATCH_EVENT = 'price-check';

export const queueKey = (pageId: string) => `${QUEUE_JOB} ${pageId}`;

export interface PriceCheckDeps {
  claim?: (key: string, job: string) => Promise<boolean>;
  fetchImpl?: typeof fetch;
  settings?: { enabled: boolean; dispatchRepo: string; dispatchToken: string };
}

export type QueueResult = 'off' | 'queued' | 'already-queued' | 'failed';

/** Queue a Purchasing page for a price check and wake the checker. Never throws. */
export async function queuePriceCheck(pageId: string, deps: PriceCheckDeps = {}): Promise<QueueResult> {
  const settings = deps.settings ?? config.priceCheck;
  if (!settings.enabled) return 'off';
  try {
    const fresh = await (deps.claim ?? claimOnce)(queueKey(pageId), QUEUE_JOB);
    if (!fresh) return 'already-queued';
    await dispatch(pageId, settings, deps.fetchImpl ?? fetch);
    return 'queued';
  } catch (err) {
    logger.warn(`Price check: could not queue ${pageId}`, err);
    return 'failed';
  }
}

/** POST /repos/{repo}/dispatches. A failure is logged only: the entry is already queued. */
async function dispatch(pageId: string, settings: NonNullable<PriceCheckDeps['settings']>, fetchImpl: typeof fetch): Promise<void> {
  if (!settings.dispatchToken || !settings.dispatchRepo) return;
  const res = await fetchImpl(`https://api.github.com/repos/${settings.dispatchRepo}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.dispatchToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ event_type: DISPATCH_EVENT, client_payload: { page_id: pageId } }),
  });
  if (res.status !== 204) {
    logger.warn(`Price check: dispatch to ${settings.dispatchRepo} returned HTTP ${res.status}; the 30-minute schedule will pick ${pageId} up.`);
  }
}

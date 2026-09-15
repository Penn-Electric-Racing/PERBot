import type { PrepResult } from './types.js';

/**
 * The last `prep` per (Slack user, vendor), so `done` writes back to exactly the rows the
 * operator pasted — never a re-derived set (someone may have added rows in between).
 * In-memory: PERBot is a single long-running worker and the window is 24h; a restart
 * simply means "run prep again", which `done` tells the operator.
 */
export const PREP_TTL_MS = 24 * 60 * 60 * 1000;

export interface CachedPrep {
  prep: PrepResult;
  createdAt: number;
}

export class PrepCache {
  private store = new Map<string, CachedPrep>();
  constructor(private ttlMs: number = PREP_TTL_MS, private now: () => number = Date.now) {}

  private key(slackUserId: string, vendorKey: string): string {
    return `${slackUserId}:${vendorKey}`;
  }

  set(slackUserId: string, vendorKey: string, prep: PrepResult): void {
    this.store.set(this.key(slackUserId, vendorKey), { prep, createdAt: this.now() });
  }

  /** null when missing or older than the TTL (expired entries are dropped). */
  get(slackUserId: string, vendorKey: string): CachedPrep | null {
    const k = this.key(slackUserId, vendorKey);
    const hit = this.store.get(k);
    if (!hit) return null;
    if (this.now() - hit.createdAt > this.ttlMs) {
      this.store.delete(k);
      return null;
    }
    return hit;
  }

  clear(slackUserId: string, vendorKey: string): void {
    this.store.delete(this.key(slackUserId, vendorKey));
  }
}

/**
 * Buttons on the price-check DM and the blocks PERBot rewrites them into after a click.
 *
 * The DM comes from the PER-Purchasing price listener (Python, its own Render service), but
 * it's posted with PERBot's bot token, so Slack delivers the clicks to PERBot over Socket
 * Mode — the listener can't receive them. actions.ts handles them; Notion stays the system
 * of record.
 *
 * Contract with PER-Purchasing's price_check.py (change both sides together):
 *   - the buttons sit in ONE `actions` block with block_id `price_swap_actions`
 *   - action_ids: `price_swap_use:<i>` (i = 0, 1, … so ids stay unique within the block) and
 *     `price_swap_keep`; PERBot adds `price_swap_undo` itself
 *   - value = JSON `PriceSwapValue` (below), ≤ 2000 chars (Slack's cap); `n`/`s`/`l`/`ol` only
 *     on use buttons
 *   - Use buttons carry a Slack `confirm` dialog (check the listing first), handled by Slack
 *   - a separate `price_swap_links` actions block holds View-listing link buttons
 *     (`price_swap_view:<i>`, url only). It isn't replaced on a click; PERBot only acks them
 */

export const PRICE_ACTIONS_BLOCK_ID = 'price_swap_actions';
export const PRICE_RESULT_BLOCK_ID = 'price_swap_result';
export const PRICE_UNDO_ACTION_ID = 'price_swap_undo';
export const PRICE_ACTION_RE = /^price_swap_(use|keep|undo)(?::\d+)?$/;
export const PRICE_LINKS_BLOCK_ID = 'price_swap_links';
export const PRICE_VIEW_RE = /^price_swap_view(?::\d+)?$/;

export type PriceAction = 'use' | 'keep' | 'undo';

export function actionKind(actionId: string): PriceAction | null {
  const m = PRICE_ACTION_RE.exec(actionId ?? '');
  return m ? (m[1] as PriceAction) : null;
}

export interface PriceSwapValue {
  v: 1;
  /** Purchasing row (Notion page id). */
  r: string;
  /** `Quant.` when the alert was sent. */
  q: number;
  /** `Unit cost` when the alert was sent, as stored (per pack on pack rows). */
  o: number;
  /** `Unit cost` to write, same units as `o`. Use buttons only. */
  n?: number;
  /** Supplier label for the confirmation line. */
  s?: string;
  /** New `Link to product webpage`, only when switching to a different listing. */
  l?: string;
  /** The row's link when the alert was sent; Undo restores it when `l` was written. */
  ol?: string;
  /** Unix seconds the Undo button was issued (set by PERBot; Undo expires after a day). */
  t?: number;
}

const SLACK_VALUE_MAX = 2000;
const PAGE_ID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

const isMoney = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const isUrl = (x: unknown): x is string => typeof x === 'string' && x.length <= 2000 && /^https?:\/\/\S+$/i.test(x);

/** Parse a button value; null for anything malformed (a stale or hand-crafted payload). */
export function decodeValue(raw: string | undefined): PriceSwapValue | null {
  let v: any;
  try {
    v = JSON.parse(raw ?? '');
  } catch {
    return null;
  }
  if (v?.v !== 1 || typeof v.r !== 'string' || !PAGE_ID_RE.test(v.r)) return null;
  if (!isMoney(v.q) || !isMoney(v.o)) return null;
  if (v.n !== undefined && !(isMoney(v.n) && v.n > 0)) return null;
  if (v.s !== undefined && typeof v.s !== 'string') return null;
  if (v.l !== undefined && !isUrl(v.l)) return null;
  if (v.ol !== undefined && v.ol !== '' && !isUrl(v.ol)) return null;
  if (v.t !== undefined && !(typeof v.t === 'number' && Number.isFinite(v.t))) return null;
  const out: PriceSwapValue = { v: 1, r: v.r, q: v.q, o: v.o };
  if (v.n !== undefined) out.n = v.n;
  if (v.s) out.s = v.s.slice(0, 80);
  if (v.l !== undefined) out.l = v.l;
  if (v.ol !== undefined) out.ol = v.ol;
  if (v.t !== undefined) out.t = v.t;
  return out;
}

/** JSON for a button value, or null when it would exceed Slack's 2000-char cap. */
export function encodeValue(v: PriceSwapValue): string | null {
  const s = JSON.stringify(v);
  return s.length <= SLACK_VALUE_MAX ? s : null;
}

/** Like price_check.py's money(): 2 decimals, up to 4 for sub-dollar prices (0.0425). */
export function money(n: number): string {
  if (n >= 1) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const s = n.toFixed(4).replace(/0+$/, '');
  const decimals = s.split('.')[1] ?? '';
  return s + '0'.repeat(Math.max(0, 2 - decimals.length));
}

/** Escape text for mrkdwn (supplier labels come from scraped pages). */
export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** What replaces the buttons: the outcome line, plus an Undo button after a write. */
export function resultBlocks(text: string, undo?: PriceSwapValue): any[] {
  const blocks: any[] = [{ type: 'section', block_id: PRICE_RESULT_BLOCK_ID, text: { type: 'mrkdwn', text } }];
  const value = undo ? encodeValue(undo) : null;
  if (value) {
    blocks.push({
      type: 'actions',
      block_id: PRICE_ACTIONS_BLOCK_ID,
      elements: [{ type: 'button', text: { type: 'plain_text', text: '↩️ Undo', emoji: true }, action_id: PRICE_UNDO_ACTION_ID, value }],
    });
  }
  return blocks;
}

/**
 * The message with its buttons (and any earlier outcome line) swapped for `replacement`, at
 * the buttons' position. The alert text above them is left as sent.
 */
export function replaceActions(existing: any[], replacement: any[]): any[] {
  const ours = (b: any) => b?.block_id === PRICE_ACTIONS_BLOCK_ID || b?.block_id === PRICE_RESULT_BLOCK_ID;
  const at = existing.findIndex(ours);
  const kept = existing.filter((b) => !ours(b));
  if (at === -1) return [...kept, ...replacement];
  const insertAt = existing.slice(0, at).filter((b) => !ours(b)).length;
  return [...kept.slice(0, insertAt), ...replacement, ...kept.slice(insertAt)];
}

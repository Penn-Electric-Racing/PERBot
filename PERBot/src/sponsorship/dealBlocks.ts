import { PipelineRow } from './types.js';

/**
 * Block Kit for deal lists (Wednesday stale DM, Saturday digest's next actions,
 * `/sponsor me`): one section per deal + a button row whose options depend on the
 * stage. Clicks are handled by actions.ts in the Bolt app; Notion stays the system
 * of record and every Slack-driven change leaves a dated "via Slack" line in Notes.
 *
 * Button values carry the deal id AND the Slack user the list was rendered for, so a
 * click is honoured only from that user.
 */

export const DEAL_ACTION_IDS = {
  contacted: 'deal_stage_contacted',
  inTalks: 'deal_stage_intalks',
  lost: 'deal_stage_lost',
  wonOpen: 'deal_won_open',
  touchOpen: 'deal_touch_open',
} as const;
export const DEAL_STAGE_ACTION_RE = /^deal_stage_(contacted|intalks|lost)$/;
export const WON_MODAL_ID = 'sponsor_won_modal';
export const TOUCH_MODAL_ID = 'sponsor_touch_modal';

export interface DealButtonValue {
  d: string; // deal page id
  u: string; // Slack user the buttons were rendered for
}
export function encodeDealValue(v: DealButtonValue): string {
  return JSON.stringify(v);
}
export function decodeDealValue(raw: string | undefined): DealButtonValue | null {
  try {
    const v = JSON.parse(raw ?? '');
    return typeof v?.d === 'string' && typeof v?.u === 'string' ? { d: v.d, u: v.u } : null;
  } catch {
    return null;
  }
}

export const dealSectionId = (dealId: string) => `deal:${dealId}`;
export const dealActionsId = (dealId: string) => `deal_actions:${dealId}`;

function button(text: string, actionId: string, value: DealButtonValue, style?: 'primary' | 'danger') {
  return {
    type: 'button',
    text: { type: 'plain_text', text, emoji: true },
    action_id: actionId,
    value: encodeDealValue(value),
    ...(style ? { style } : {}),
  };
}

/** Default one-line summary (the `/sponsor me` style). */
export function defaultDealLine(deal: PipelineRow): string {
  const stage = deal.stage ?? 'Prospect';
  const next = deal.nextAction ? ` — Next: ${deal.nextAction}` : '';
  const due = deal.nextActionDate ? ` (due ${deal.nextActionDate})` : '';
  return `<${deal.url}|${deal.company || 'Untitled'}> — *${stage}*${next}${due}`;
}

/** Buttons that make sense from this stage (none once Won/Lost). */
export function buttonsFor(deal: PipelineRow, value: DealButtonValue): any[] {
  const stage = deal.stage ?? 'Prospect';
  if (stage === 'Won' || stage === 'Lost') return [];
  const out: any[] = [];
  if (stage === 'Prospect') out.push(button('📨 Contacted', DEAL_ACTION_IDS.contacted, value, 'primary'));
  if (stage === 'Prospect' || stage === 'Contacted') {
    out.push(button('💬 In talks', DEAL_ACTION_IDS.inTalks, value, stage === 'Contacted' ? 'primary' : undefined));
  }
  out.push(button('🏆 Won', DEAL_ACTION_IDS.wonOpen, value, stage === 'In talks' ? 'primary' : undefined));
  out.push(button('❌ Lost', DEAL_ACTION_IDS.lost, value));
  out.push(button('📝 Log touch', DEAL_ACTION_IDS.touchOpen, value));
  return out;
}

/**
 * The blocks for one deal. `line` overrides the summary (contexts like the stale DM show
 * overdue info); `note` (e.g. "📨 Contacted · 1:42 PM via Slack") is appended after an update.
 */
export function dealBlocks(deal: PipelineRow, slackUserId: string, opts: { line?: string; note?: string } = {}): any[] {
  const value: DealButtonValue = { d: deal.id, u: slackUserId };
  const line = opts.line ?? defaultDealLine(deal);
  const text = opts.note ? `${line}\n_${opts.note}_` : line;
  const blocks: any[] = [{ type: 'section', block_id: dealSectionId(deal.id), text: { type: 'mrkdwn', text } }];
  const elements = buttonsFor(deal, value);
  if (elements.length > 0) blocks.push({ type: 'actions', block_id: dealActionsId(deal.id), elements });
  return blocks;
}

/** Header + deals + optional footer. `lineFor` lets each context format its own deal line. */
export function dealListBlocks(
  header: string,
  deals: PipelineRow[],
  slackUserId: string,
  opts: { footer?: string; lineFor?: (d: PipelineRow) => string } = {}
): any[] {
  const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text: header } }];
  // Slack rejects duplicate block_ids, so a deal can appear only once per message.
  const seen = new Set<string>();
  for (const d of deals) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    blocks.push(...dealBlocks(d, slackUserId, { line: opts.lineFor?.(d) }));
  }
  if (opts.footer) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: opts.footer }] });
  return blocks;
}

/**
 * Rewrite one deal inside an existing message: keeps the deal's original first line
 * (swapping a `*Old stage*` marker if present), appends `note`, and re-derives the buttons
 * from the updated deal. Returns a new blocks array.
 */
export function replaceDealBlocks(blocks: any[], updated: PipelineRow, slackUserId: string, note: string, previousStage: string | null): any[] {
  const out: any[] = [];
  let done = false;
  for (const b of blocks) {
    if (b?.block_id === dealSectionId(updated.id)) {
      if (!done) {
        let line: string = String(b?.text?.text ?? '').split('\n')[0] || defaultDealLine(updated);
        if (previousStage && updated.stage && previousStage !== updated.stage) line = line.replace(`*${previousStage}*`, `*${updated.stage}*`);
        out.push(...dealBlocks(updated, slackUserId, { line, note }));
        done = true;
      }
      continue;
    }
    if (b?.block_id === dealActionsId(updated.id)) continue;
    out.push(b);
  }
  return done ? out : [...blocks, ...dealBlocks(updated, slackUserId, { note })];
}

import { isoAddDays } from './dates.js';
import { PipelineRow, Stage } from './types.js';

/**
 * The Next actions PERBot writes itself, and what replaces them as a deal moves.
 *
 * WHY (2026-10-22): claiming set "Send first outreach" (due claim + 7 days) and nothing
 * ever cleared it, so 185 deals already at Contacted / In talks kept showing up in the
 * Wednesday DM as "overdue: send first outreach". Now a stage move swaps PERBot's own
 * action for the right next one. Anything a person typed is left alone.
 */

export const FIRST_OUTREACH_ACTION = 'Send first outreach';
export const FOLLOW_UP_ACTION = 'Follow up if no reply';
export const CHECK_REPLY_ACTION = 'Check for a reply (no reply after 30 days)';

/** Days after a contact (or a logged follow-up) before the follow-up comes due. */
export const FOLLOW_UP_DAYS = 7;

/** Contacted this long ago with no reply → the Wednesday "gone cold" check owns the deal instead. */
export const COLD_AFTER_DAYS = 30;

const AUTO_PREFIXES = [FIRST_OUTREACH_ACTION, FOLLOW_UP_ACTION, CHECK_REPLY_ACTION];

/** True for a blank Next action or one PERBot wrote, so it's safe to replace. */
export function isAutoNextAction(action: string | null): boolean {
  const a = (action ?? '').trim();
  return a === '' || AUTO_PREFIXES.some((p) => a.startsWith(p));
}

/** "Send first outreach — reduced-cost PCB fab" → " — reduced-cost PCB fab", so the ask survives the swap. */
function askSuffix(action: string | null): string {
  const a = (action ?? '').trim();
  for (const p of AUTO_PREFIXES) if (a.startsWith(p)) return a.slice(p.length);
  return '';
}

export interface NextActionChange {
  /** '' clears the property. */
  action: string;
  /** null clears the date. */
  dateIso: string | null;
}

/**
 * What a move to `stage` on `todayIso` should do to the deal's Next action, or null to
 * leave it alone (a person's own action, or a stage with nothing to say).
 * - Contacted: follow up in 7 days if there's no reply.
 * - In talks / Won / Lost: clear it. The conversation, or the deal, has moved on.
 */
export function nextActionForStage(row: PipelineRow, stage: Stage, todayIso: string): NextActionChange | null {
  if (!isAutoNextAction(row.nextAction)) return null;
  if (stage === 'Contacted') return { action: `${FOLLOW_UP_ACTION}${askSuffix(row.nextAction)}`, dateIso: isoAddDays(todayIso, FOLLOW_UP_DAYS) };
  if (stage === 'Prospect') return null;
  if (!row.nextAction && !row.nextActionDate) return null;
  return { action: '', dateIso: null };
}

/** A follow-up was logged on a Contacted deal: the next one comes due a week later. */
export function nextActionAfterTouch(row: PipelineRow, todayIso: string): NextActionChange | null {
  if (row.stage !== 'Contacted' || !isAutoNextAction(row.nextAction)) return null;
  return { action: `${FOLLOW_UP_ACTION}${askSuffix(row.nextAction)}`, dateIso: isoAddDays(todayIso, FOLLOW_UP_DAYS) };
}

/**
 * One-time cleanup of deals the old bug left behind: past Prospect but still carrying
 * "Send first outreach". A Contacted deal under 30 days old gets the follow-up it should
 * have had, due 7 days after its last touch. That can be in the past, because it really
 * is overdue. Older Contacted deals and everything past Contacted get cleared.
 */
export function backfillNextAction(row: PipelineRow, todayIso: string): NextActionChange | null {
  if (!(row.nextAction ?? '').startsWith(FIRST_OUTREACH_ACTION)) return null;
  if (!row.stage || row.stage === 'Prospect') return null;
  if (row.stage === 'Contacted') {
    const contactedDay = row.contactedAt?.slice(0, 10) ?? row.lastContact?.slice(0, 10) ?? null;
    if (contactedDay && contactedDay > isoAddDays(todayIso, -COLD_AFTER_DAYS)) {
      const last = row.lastContact && row.lastContact.slice(0, 10) > contactedDay ? row.lastContact.slice(0, 10) : contactedDay;
      return { action: `${FOLLOW_UP_ACTION}${askSuffix(row.nextAction)}`, dateIso: isoAddDays(last, FOLLOW_UP_DAYS) };
    }
  }
  return { action: '', dateIso: null };
}

/** Notion property payload for a change. */
export function nextActionProperties(change: NextActionChange): Record<string, any> {
  return {
    'Next action': { rich_text: change.action ? [{ text: { content: change.action } }] : [] },
    'Next action date': { date: change.dateIso ? { start: change.dateIso } : null },
  };
}

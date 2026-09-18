import { isoAddDays } from '../sponsorship/dates.js';

/**
 * Which Saturday meeting page a task belongs to. Pure helpers (no Notion) so they're
 * testable; `OpsTasksNotion` supplies the meeting list.
 *
 * Rule: a task dated D (created / assigned on D) belongs to the first meeting on or after
 * D, up to and including the Saturday of that week. So something assigned from Slack on
 * Monday lands in the coming Saturday's "This week" table instead of looking carried, and
 * something typed on the Saturday itself belongs to that day's meeting.
 */

export interface OpsMeeting {
  id: string;
  /** YYYY-MM-DD from the meeting row's Date property. */
  date: string;
}

/** The Saturday on or after `iso` (YYYY-MM-DD); `iso` itself when it is a Saturday. */
export function saturdayOnOrAfter(iso: string): string {
  const day = iso.slice(0, 10);
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  return isoAddDays(day, (6 - dow + 7) % 7);
}

/**
 * The meeting a task anchored at `anchorIso` belongs to: the meeting page whose Date falls
 * in the same Sunday–Saturday week as the anchor (earliest such page if several). Matching
 * by week, not exact date, tolerates the repeating template stamping Date with the page's
 * creation moment (Sunday morning) before the lead sets it to the Saturday. `null` when no
 * page for that week exists yet.
 */
export function pickMeeting(meetings: OpsMeeting[], anchorIso: string): OpsMeeting | null {
  const week = saturdayOnOrAfter(anchorIso);
  const candidates = meetings
    .filter((m) => saturdayOnOrAfter(m.date) === week)
    .sort((a, b) => a.date.localeCompare(b.date));
  return candidates[0] ?? null;
}

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
 * The meeting a task anchored at `anchorIso` belongs to: the earliest meeting dated within
 * [anchor, Saturday-of-that-week]. `null` when no such page exists yet (the repeating
 * template creates pages ahead of the meeting; before that there is nothing to link to).
 */
export function pickMeeting(meetings: OpsMeeting[], anchorIso: string): OpsMeeting | null {
  const from = anchorIso.slice(0, 10);
  const to = saturdayOnOrAfter(from);
  const candidates = meetings
    .filter((m) => m.date >= from && m.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date));
  return candidates[0] ?? null;
}

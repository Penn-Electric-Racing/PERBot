/** Today's date as YYYY-MM-DD in America/New_York (PER's timezone). */
export function todayIsoET(): string {
  // en-CA formats as ISO-like YYYY-MM-DD.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Whole days from `iso` (a YYYY-MM-DD date) until today (ET). Negative = overdue. */
export function daysUntil(iso: string): number {
  const today = new Date(`${todayIsoET()}T00:00:00`);
  const target = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

/** YYYY-MM-DD `days` after today (ET). Used to seed a deal's first next-action date. */
export function isoDaysFromNowET(days: number): string {
  const d = new Date(`${todayIsoET()}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
}

/** YYYY-MM-DD `days` after a given YYYY-MM-DD date (calendar arithmetic, no timezone). */
export function isoAddDays(dateIso: string, days: number): string {
  const d = new Date(`${dateIso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The UTC instant of `hour`:00 wall-clock time in America/New_York on `dateIso`.
 * DST-aware via Intl (EDT = GMT-4, EST = GMT-5), so jobs can define windows in ET
 * without depending on the runner's local timezone (GitHub runners are UTC).
 */
export function etWallTimeToUtc(dateIso: string, hour: number): Date {
  const naive = new Date(`${dateIso.slice(0, 10)}T${String(hour).padStart(2, '0')}:00:00Z`);
  const label =
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
      .formatToParts(naive)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-5';
  const m = label.match(/GMT([+-]\d+)(?::(\d+))?/);
  const offsetHours = m ? Number(m[1]) : -5;
  const offsetMinutes = m?.[2] ? Number(m[2]) : 0;
  const offsetTotalMin = offsetHours * 60 + Math.sign(offsetHours) * offsetMinutes;
  return new Date(naive.getTime() - offsetTotalMin * 60_000);
}

/** "1:42 PM" in ET — for "done at" stamps on Slack-updated messages. */
export function nowTimeET(now: Date = new Date()): string {
  return now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
}

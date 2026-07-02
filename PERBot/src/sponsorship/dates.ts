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

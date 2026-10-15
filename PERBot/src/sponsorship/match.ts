/**
 * Picking ONE Bank lead / Pipeline deal out of a Notion title search. Notion's
 * `title contains` is a case-insensitive substring match, so "Keye" also hits
 * "Hawkeyeind" and "Skf" hits both "SKF" rows — an exact name must beat substrings,
 * or the user gets a "be more specific" list they can't escape by typing more.
 */

export type NameMatch<T> = { kind: 'one'; row: T } | { kind: 'none' } | { kind: 'many'; rows: T[] };

/** "Jane  Street, Inc." → "jane street inc" — case/punctuation-insensitive name key. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * One row when the search is unambiguous: a single hit, or a single exact-name hit among
 * substring hits. Several exact hits (two "SKF" rows) stay ambiguous — only the caller's
 * domain can tell those apart.
 */
export function pickByName<T extends { company: string }>(rows: T[], query: string): NameMatch<T> {
  if (rows.length === 0) return { kind: 'none' };
  if (rows.length === 1) return { kind: 'one', row: rows[0]! };
  const key = normalizeName(query);
  const exact = rows.filter((r) => normalizeName(r.company) === key);
  if (exact.length === 1) return { kind: 'one', row: exact[0]! };
  return { kind: 'many', rows: exact.length > 1 ? exact : rows };
}

/**
 * Several deals for one company (an old Won/Lost one + a live one): the live one is
 * the one a log/stage/won means. Still ambiguous if zero or 2+ are live.
 */
export function pickLiveDeal<T extends { stage: string | null }>(deals: T[]): NameMatch<T> {
  if (deals.length === 0) return { kind: 'none' };
  if (deals.length === 1) return { kind: 'one', row: deals[0]! };
  const live = deals.filter((d) => d.stage !== 'Won' && d.stage !== 'Lost');
  return live.length === 1 ? { kind: 'one', row: live[0]! } : { kind: 'many', rows: deals };
}

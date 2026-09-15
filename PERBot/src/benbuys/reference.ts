import type { PurchasingRow } from './types.js';

/** Minimum useful reference length; below this the part number is more informative. */
export const MIN_REFERENCE_SIGNAL = 8;

/** Never let a comma (column shift) or a line break into a cart line. */
export function cleanReferenceText(text: string): string {
  return text.replace(/[,\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Cut to `max` chars at a word boundary, no ellipsis (a trailing `…` wastes characters
 * and can trip non-ASCII handling in the punchout). Returns '' when the result would carry
 * fewer than MIN_REFERENCE_SIGNAL chars of signal (a 7-char "digikey" note says nothing),
 * so the caller can fall back to the part number.
 */
export function truncateAtWord(text: string, max: number): string {
  const t = cleanReferenceText(text);
  if (t.length <= max) return t.length >= MIN_REFERENCE_SIGNAL ? t : '';
  let cut = t.slice(0, max);
  if (t[max] !== ' ') {
    const space = cut.lastIndexOf(' ');
    if (space > 0) cut = cut.slice(0, space);
  }
  cut = cut.trim();
  return cut.length >= MIN_REFERENCE_SIGNAL ? cut : '';
}

/**
 * The per-line reference for an aggregated cart line: the first row's sanitized
 * description, truncated; `+N` appended when the other rows describe it differently;
 * falls back to `Cat. or model no.` (the part number) when there's no usable description.
 */
export function truncateReference(partNumber: string, rows: PurchasingRow[], max: number): string {
  const first = rows[0];
  const base = cleanReferenceText(first?.sanitizedDescription ?? '');
  const others = new Set(rows.slice(1).map((r) => cleanReferenceText(r.sanitizedDescription)));
  others.delete(base);
  const suffix = others.size > 0 ? ` +${rows.length - 1}` : '';
  const body = base ? truncateAtWord(base, max - suffix.length) : '';
  if (!body) return truncateAtWord(partNumber, max) || partNumber.slice(0, max);
  return `${body}${suffix}`;
}

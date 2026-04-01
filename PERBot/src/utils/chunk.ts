import { cleanWhitespace } from './text.js';

export function chunkText(text: string, maxChars: number, overlapChars: number): string[] {
  const cleaned = cleanWhitespace(text);
  if (!cleaned) return [];
  if (cleaned.length <= maxChars) return [cleaned];

  const chunks: string[] = [];
  let start = 0;

  while (start < cleaned.length) {
    const end = Math.min(cleaned.length, start + maxChars);
    let sliceEnd = end;

    if (end < cleaned.length) {
      const window = cleaned.slice(start, end);
      const lastBreak = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'), window.lastIndexOf(' '));
      if (lastBreak > maxChars * 0.6) {
        sliceEnd = start + lastBreak + 1;
      }
    }

    const chunk = cleaned.slice(start, sliceEnd).trim();
    if (chunk) chunks.push(chunk);
    if (sliceEnd >= cleaned.length) break;

    start = Math.max(0, sliceEnd - overlapChars);
  }

  return chunks;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

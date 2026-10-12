import { BackendError, UA } from './search.js';

/** Stop reading a page after this many bytes (some listings are huge). */
export const MAX_PAGE_BYTES = 5_000_000;
const TIMEOUT_MS = 15_000;

/**
 * GET a page as text. Refuses non-HTML (datasheet PDFs are common part-number hits) and
 * stops reading after MAX_PAGE_BYTES. Throws BackendError on HTTP errors.
 */
export async function fetchHtml(url: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  });
  if (res.status !== 200) throw new BackendError(`HTTP ${res.status}`);
  const ctype = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (ctype && !ctype.includes('html') && !ctype.includes('xml')) {
    await res.body?.cancel();
    throw new BackendError(`not a web page (${ctype})`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_PAGE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => undefined);
  const charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1] ?? 'utf-8';
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder('utf-8'); // unknown charset name in the headers
  }
  return decoder.decode(Buffer.concat(chunks).subarray(0, MAX_PAGE_BYTES));
}

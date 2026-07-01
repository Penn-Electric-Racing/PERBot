import { logger } from '../utils/logger.js';

/**
 * Deterministically fetch a company's homepage (and /about if the homepage is thin)
 * and reduce it to plain text for the classifier. This is NOT the LLM — it's the
 * grounding evidence the LLM classifies. Best-effort: on any failure we return
 * whatever text we have (possibly empty), and the classifier still runs on the
 * company name + domain.
 */

const MAX_TEXT_CHARS = 6000;
const FETCH_TIMEOUT_MS = 12_000;

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'PERBot-Sponsorship/1.0 (+https://github.com/Penn-Electric-Racing/PERBot)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return '';
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) return '';
    return stripHtml(await res.text());
  } catch (err) {
    logger.warn(`Homepage fetch failed for ${url}`, err);
    return '';
  }
}

/**
 * Returns cleaned homepage text for `hostname`, augmented with /about text when the
 * homepage alone is thin. Capped at MAX_TEXT_CHARS.
 */
export async function fetchCompanyText(hostname: string): Promise<string> {
  const base = `https://${hostname}`;
  let text = await fetchText(base);

  if (text.length < 600) {
    const about = await fetchText(`${base}/about`);
    if (about) text = `${text} ${about}`.trim();
  }

  return text.slice(0, MAX_TEXT_CHARS);
}

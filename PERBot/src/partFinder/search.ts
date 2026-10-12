import * as cheerio from 'cheerio';
import { logger } from '../utils/logger.js';
import type { SearchResult } from './types.js';

/**
 * Web search for part listings. First backend that works wins (no google.com scraping):
 *   Brave Search API      BRAVE_API_KEY            ~2k queries/mo free
 *   Serper.dev (Google)   SERPER_API_KEY           2,500 free, no card
 *   Google CSE            GOOGLE_API_KEY + GOOGLE_CSE_ID   100/day
 *   DuckDuckGo HTML       no key — but it challenges datacenter IPs (Render) quickly, so
 *                         set one of the keys on the deploy.
 */

export class BackendError extends Error {}

type Hit = Omit<SearchResult, 'searchRank'>;
export type Backend = (query: string, n: number) => Promise<Hit[]>;

const TIMEOUT_MS = 15_000;
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

async function getJson(url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new BackendError(`HTTP ${res.status}`);
  return res.json();
}

const stripTags = (html: string) => cheerio.load(html).text();

export const brave: Backend = async (query, n) => {
  const key = process.env.BRAVE_API_KEY?.trim();
  if (!key) throw new BackendError('BRAVE_API_KEY not set');
  const out: Hit[] = [];
  for (let page = 0; page < 10 && out.length < n; page++) { // count ≤ 20, offset = page index
    const params = new URLSearchParams({ q: query, count: '20', offset: String(page) });
    let data: any;
    try {
      data = await getJson(`https://api.search.brave.com/res/v1/web/search?${params}`, {
        headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
      });
    } catch (err) {
      if (out.length) break;
      throw err;
    }
    const items: any[] = data?.web?.results ?? [];
    out.push(...items.map((i) => ({ title: i.title ?? '', url: i.url ?? '', snippet: stripTags(i.description ?? '') })));
    if (items.length < 20) break;
  }
  return out.slice(0, n);
};

export const serper: Backend = async (query, n) => {
  const key = process.env.SERPER_API_KEY?.trim();
  if (!key) throw new BackendError('SERPER_API_KEY not set');
  const out: Hit[] = [];
  for (let page = 1; page <= Math.min(Math.ceil(n / 10), 10); page++) { // 10 per call = 1 credit
    let data: any;
    try {
      data = await getJson('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: 10, page }),
      });
    } catch (err) {
      if (out.length) break;
      throw err;
    }
    const items: any[] = data?.organic ?? [];
    out.push(...items.map((i) => ({ title: i.title ?? '', url: i.link ?? '', snippet: i.snippet ?? '' })));
    if (items.length < 10) break;
  }
  return out.slice(0, n);
};

export const googleCse: Backend = async (query, n) => {
  const key = process.env.GOOGLE_API_KEY?.trim();
  const cx = process.env.GOOGLE_CSE_ID?.trim();
  if (!key || !cx) throw new BackendError('GOOGLE_API_KEY / GOOGLE_CSE_ID not set');
  const out: Hit[] = [];
  for (let start = 1; start <= Math.min(n, 100); start += 10) { // 10 per call, 100 max
    const params = new URLSearchParams({ key, cx, q: query, num: '10', start: String(start) });
    let data: any;
    try {
      data = await getJson(`https://www.googleapis.com/customsearch/v1?${params}`);
    } catch (err) {
      if (out.length) break;
      throw err;
    }
    const items: any[] = data?.items ?? [];
    out.push(...items.map((i) => ({ title: i.title ?? '', url: i.link ?? '', snippet: i.snippet ?? '' })));
    if (items.length < 10) break;
  }
  return out.slice(0, n);
};

/** Unwrap DuckDuckGo's //duckduckgo.com/l/?uddg=<url> redirect links. */
export function cleanDdgUrl(href: string): string {
  if (!href.includes('duckduckgo.com/l/')) return href;
  try {
    return new URL(href, 'https://duckduckgo.com').searchParams.get('uddg') ?? href;
  } catch {
    return href;
  }
}

/** Results + the "Next" form of one DDG HTML results page. */
export function parseDdgPage(html: string): { results: Hit[]; next: Record<string, string> | null; challenged: boolean } {
  const $ = cheerio.load(html);
  const challenged = $('.anomaly-modal, #challenge-form').length > 0 || /captcha/i.test(html);
  const results: Hit[] = [];
  $('div.result').each((_, el) => {
    const res = $(el);
    if (res.hasClass('result--ad')) return; // sponsored
    const a = res.find('a.result__a').first();
    if (!a.length) return;
    results.push({
      title: a.text().trim(),
      url: cleanDdgUrl(a.attr('href') ?? ''),
      snippet: res.find('.result__snippet').first().text().replace(/\s+/g, ' ').trim(),
    });
  });
  let next: Record<string, string> | null = null;
  $('form').each((_, f) => {
    const data: Record<string, string> = {};
    $(f).find('input[name]').each((__, i) => { data[$(i).attr('name')!] = $(i).attr('value') ?? ''; });
    if ('s' in data && 'vqd' in data) next = data;
  });
  return { results, next, challenged };
}

export const duckduckgo: Backend = async (query, n) => {
  const out: Hit[] = [];
  let form: Record<string, string> | null = { q: query };
  while (form && out.length < n) {
    if (out.length) await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1000)); // be gentle
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      body: new URLSearchParams(form),
      headers: { 'User-Agent': UA, Referer: 'https://html.duckduckgo.com/' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch((err) => { throw new BackendError(String(err)); });
    if (res.status !== 200) {
      if (out.length) break;
      throw new BackendError(`HTTP ${res.status}${res.status === 202 ? ' (rate-limited)' : ''}`);
    }
    const page = parseDdgPage(await res.text());
    if (page.challenged || !page.results.length) {
      if (out.length) break;
      throw new BackendError(page.challenged ? 'challenge page returned' : 'no results parsed');
    }
    out.push(...page.results);
    form = page.next;
  }
  return out.slice(0, n);
};

export const BACKENDS: [string, Backend][] = [['brave', brave], ['serper', serper], ['google_cse', googleCse], ['duckduckgo', duckduckgo]];

/** Top `n` unique URLs from the first working backend, topping up with `variants`. */
export async function search(query: string, n: number, variants: string[] = [], backends = BACKENDS): Promise<{ source: string; results: SearchResult[] }> {
  const errors: Record<string, string> = {};
  for (const [name, fn] of backends) {
    try {
      const res: Hit[] = [];
      const seen = new Set<string>();
      for (const q of [query, ...variants]) {
        if (res.length >= n) break;
        let batch: Hit[];
        try {
          batch = await fn(q, n);
        } catch (err) {
          if (res.length) continue; // extra variants are best-effort
          throw err;
        }
        for (const r of batch) {
          const u = r.url.split('#')[0]!.replace(/\/+$/, '');
          if (u && !seen.has(u)) { seen.add(u); res.push(r); }
        }
      }
      if (res.length) return { source: name, results: res.slice(0, n).map((r, i) => ({ ...r, searchRank: i })) };
      errors[name] = 'empty result';
    } catch (err) {
      errors[name] = err instanceof Error ? err.message : String(err);
    }
    logger.info(`Part finder: search backend ${name} skipped (${errors[name]})`);
  }
  throw new BackendError(`All search backends failed: ${JSON.stringify(errors)}`);
}

import { chatJson } from './discovery.js';
import { extractHostname } from './domain.js';
import { fetchHtml, stripHtml } from './homepage.js';

/**
 * FSAE-ties detector: does anyone at this company have Formula SAE / Formula Student
 * history? A former FSAE member in leadership is the warmest cold lead we get, so
 * `/sponsor rank` puts these rows above everything else.
 *
 * Two stages, same split as enrichment:
 *   1. Deterministic — crawl the homepage plus its leadership/team/about pages (same host,
 *      capped) and regex for FSAE terms. No match → no ties, no LLM call.
 *   2. Groq — label each matched snippet: a named PERSON with FSAE history, the COMPANY
 *      itself backing/recruiting from FSAE, or neither. Every label is checked against the
 *      page text: the quote must be verbatim and the person's name must appear in it, so
 *      the evidence written to Notion is never LLM-invented.
 *
 * Coverage caveat: sites that render bios client-side (React/Webflow CMS) return little
 * text to a plain fetch, so "no ties" means "none found on the public HTML", not "none".
 */

/** FSAE terms. Excludes "Formula E"/"Formula 1" (pro series, not student history). */
export const FSAE_PATTERN = /\b(?:formula[\s-]*sae|fsae|formula[\s-]+student|formula[\s-]+hybrid|sae[\s-]+formula)\b/gi;

/** Path or link-text words that mark a page likely to hold people's bios. */
const TEAM_PAGE_HINT = /\b(?:about|team|leadership|people|management|founders?|our[\s-]?story|who[\s-]?we[\s-]?are|executives?|board|company|careers)\b/i;

/** Tried when the homepage links to nothing that looks like a team page. */
const FALLBACK_PATHS = ['/about', '/about-us', '/team', '/our-team', '/leadership', '/company'];

const MAX_LINKED_PAGES = 6;
const SNIPPET_RADIUS = 280;
const MAX_SNIPPETS = 8;

export interface FsaePerson {
  name: string;
  quote: string;
  url: string;
}

export interface FsaeCompanyMention {
  quote: string;
  url: string;
  /** Named internal champion (e.g. whoever runs their FSAE donation program), when the page names one. */
  champion?: string;
}

export interface FsaeScan {
  /** True when at least one named person has verified FSAE/Formula Student history. */
  ties: boolean;
  people: FsaePerson[];
  /** The company itself sponsoring / recruiting from FSAE — a lead for "Sponsors other teams". */
  companyMentions: FsaeCompanyMention[];
  pagesScanned: string[];
}

export interface Snippet {
  url: string;
  text: string;
}

function sameSite(a: string, b: string): boolean {
  return a.replace(/^www\./, '') === b.replace(/^www\./, '');
}

/**
 * Same-site links from `html` that look like leadership/team/about pages, best first.
 * A link counts when its path or its anchor text carries a team-page word.
 */
export function findTeamPageLinks(html: string, baseUrl: string, limit = MAX_LINKED_PAGES): string[] {
  const baseHost = extractHostname(baseUrl) ?? '';
  const scored = new Map<string, number>();
  const anchor = /<a\b[^>]*?href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(anchor)) {
    let url: URL;
    try {
      url = new URL(m[1]!, baseUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || !sameSite(url.hostname, baseHost)) continue;
    if (/\.(?:pdf|jpe?g|png|gif|svg|zip|mp4)$/i.test(url.pathname) || url.pathname === '/') continue;
    const text = stripHtml(m[2] ?? '');
    const inPath = TEAM_PAGE_HINT.test(url.pathname.replace(/[-_/]/g, ' '));
    const inText = TEAM_PAGE_HINT.test(text);
    if (!inPath && !inText) continue;
    // Leadership/team pages beat a generic "About"; careers pages rank last.
    let score = (inPath ? 2 : 0) + (inText ? 1 : 0);
    if (/leadership|team|people|founder|executive|management|board/i.test(url.pathname + ' ' + text)) score += 3;
    if (/careers/i.test(url.pathname)) score -= 2;
    const key = `${url.origin}${url.pathname.replace(/\/$/, '')}`;
    scored.set(key, Math.max(scored.get(key) ?? -Infinity, score));
  }
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([u]) => u);
}

/**
 * Windows of text around each FSAE match, overlapping windows merged, capped. Wide
 * enough to take in the name at the top of a typical bio paragraph.
 */
export function extractSnippets(text: string, url: string, radius = SNIPPET_RADIUS): Snippet[] {
  const spans: Array<[number, number]> = [];
  for (const m of text.matchAll(FSAE_PATTERN)) {
    const start = Math.max(0, m.index! - radius);
    const end = Math.min(text.length, m.index! + m[0].length + radius);
    const last = spans[spans.length - 1];
    if (last && start <= last[1]) last[1] = end;
    else spans.push([start, end]);
  }
  return spans.map(([s, e]) => ({ url, text: text.slice(s, e).trim() }));
}

function normalize(s: string): string {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface RawLabel {
  snippet?: unknown;
  kind?: unknown;
  person?: unknown;
  quote?: unknown;
}

/**
 * Keep only labels the page text backs up: the quote must appear verbatim in its
 * snippet and must itself contain an FSAE term; a PERSON label also needs the name to
 * appear in the snippet. Anything else is dropped rather than trusted.
 */
export function verifyLabels(snippets: Snippet[], labels: RawLabel[]): Pick<FsaeScan, 'people' | 'companyMentions'> {
  const people: FsaePerson[] = [];
  const companyMentions: FsaeCompanyMention[] = [];
  for (const l of labels) {
    const idx = typeof l.snippet === 'number' ? l.snippet : Number(l.snippet);
    const snip = snippets[idx];
    const quote = typeof l.quote === 'string' ? l.quote.trim() : '';
    if (!snip || !quote) continue;
    const hay = normalize(snip.text);
    if (!hay.includes(normalize(quote))) continue;
    if (!new RegExp(FSAE_PATTERN.source, 'i').test(quote)) continue;

    const name = typeof l.person === 'string' ? l.person.trim() : '';
    const nameOk = name !== '' && hay.includes(normalize(name));
    if (l.kind === 'person') {
      if (!nameOk) continue;
      if (people.some((p) => normalize(p.name) === normalize(name))) continue;
      people.push({ name, quote: quote.slice(0, 300), url: snip.url });
    } else if (l.kind === 'company') {
      const dup = companyMentions.some((c) => normalize(c.quote) === normalize(quote));
      if (!dup && companyMentions.length < 2) {
        companyMentions.push({ quote: quote.slice(0, 300), url: snip.url, ...(nameOk ? { champion: name } : {}) });
      }
    }
  }
  return { people, companyMentions };
}

const LABEL_PROMPT = `You read short excerpts from a company's website. Each excerpt mentions Formula SAE (FSAE) or Formula Student, the university race-car design competitions.

For EACH excerpt, return one label:
- "person": a specific, named person who WORKS AT THIS COMPANY was themselves a member, lead, driver, or faculty advisor of a Formula SAE / Formula Student team (e.g. a staff bio: "While at university she was technical lead on her Formula SAE team").
- "company": the company, or someone at it acting for it, sponsors, donates to, supplies, works with, or recruits from Formula SAE / Formula Student teams, or a job listing asks for FSAE experience. An employee who RUNS a sponsorship/donation program is "company" (put their name in "person"), not "person" — running a program is not having been on a team.
- "none": anything else (news links, event listings, unrelated mentions).

A testimonial or quote from a student team or from someone at ANOTHER organization (a customer, a partner) is never "person"; label it "company" if it shows the company working with FSAE teams, else "none".

Return ONLY JSON: {"labels":[{"snippet":<excerpt number>,"kind":"person"|"company"|"none","person":"<full name exactly as written, or empty>","quote":"<the shortest verbatim span, max 200 chars, that contains the FSAE / Formula Student mention and shows the label>"}]}
Copy "quote" and "person" character-for-character from the excerpt. Never guess a name that isn't written in the excerpt.`;

async function labelSnippets(company: string, snippets: Snippet[]): Promise<RawLabel[]> {
  const body = snippets.map((s, i) => `[${i}] ${s.text}`).join('\n\n');
  const parsed = await chatJson(LABEL_PROMPT, `Company: ${company}\n\nExcerpts:\n${body}`);
  return Array.isArray(parsed.labels) ? (parsed.labels as RawLabel[]) : [];
}

/**
 * Scan `hostname`'s homepage + team pages for FSAE history. Throws only if the Groq
 * labelling call fails (so a batch run can retry that company); fetch failures just
 * mean fewer pages scanned.
 */
export async function scanFsaeTies(company: string, hostname: string): Promise<FsaeScan> {
  const base = `https://${hostname}`;
  const homeHtml = await fetchHtml(base);
  // Dead DNS / bot wall on the homepage almost always means the same on every subpage.
  if (!homeHtml) return { ties: false, people: [], companyMentions: [], pagesScanned: [] };
  const linked = findTeamPageLinks(homeHtml, base);
  const candidates = linked.length ? linked : FALLBACK_PATHS.map((p) => `${base}${p}`);

  const pages: Array<{ url: string; text: string }> = [{ url: base, text: stripHtml(homeHtml) }];
  for (const url of candidates) {
    const html = await fetchHtml(url);
    if (html) pages.push({ url, text: stripHtml(html) });
  }

  const snippets = pages.flatMap((p) => extractSnippets(p.text, p.url)).slice(0, MAX_SNIPPETS);
  const pagesScanned = pages.map((p) => p.url);
  if (snippets.length === 0) return { ties: false, people: [], companyMentions: [], pagesScanned };

  const labels = await labelSnippets(company, snippets);
  const { people, companyMentions } = verifyLabels(snippets, labels);
  return { ties: people.length > 0, people, companyMentions, pagesScanned };
}

/** One Notion rich_text value (≤2000 chars) summarizing the scan for humans. */
export function formatFsaeEvidence(scan: FsaeScan): string {
  const lines: string[] = [];
  for (const p of scan.people) lines.push(`🏁 ${p.name}: "${p.quote}" (${p.url})`);
  for (const c of scan.companyMentions) {
    lines.push(`Company${c.champion ? ` (champion: ${c.champion})` : ''}: "${c.quote}" (${c.url})`);
  }
  if (lines.length === 0) lines.push(`No FSAE mentions on ${scan.pagesScanned.length} page(s) scanned.`);
  return lines.join('\n').slice(0, 1990);
}

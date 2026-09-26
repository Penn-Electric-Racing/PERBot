/**
 * Turns the Notion `/pages/{id}/markdown` export into plain, searchable markdown.
 *
 * The export is markdown with Notion-flavoured XML mixed in: `<columns>`, `<callout>`,
 * `<table>/<tr>/<td>`, `<mention-page>`, `<mention-date start="…"/>`, `<empty-block/>`,
 * `{toggle="true"}` suffixes, and every image as a signed S3 URL that is thousands of
 * characters long. Before this cleaner, 21% of all indexed characters were S3 query strings.
 *
 * Only tags Notion itself emits are touched, and nothing inside ``` code fences is changed,
 * so `<stdint.h>` or `<Vec<T>>` in a firmware page survive.
 */

const SELF_CLOSING_DROP = [
  'empty-block',
  'table_of_contents',
  'breadcrumb',
  'mention-user',
  'unknown',
  'unknown_mention',
  'video',
  'audio',
  'pdf',
  'image',
  'bookmark',
  'link_preview',
  'embed',
  'divider',
  'equation',
];

/** Tags whose wrapper is removed but whose inner text is kept. */
const UNWRAP = [
  'columns',
  'column',
  'callout',
  'details',
  'toggle',
  'synced_block',
  'span',
  'quote',
  'file',
  'mention-page',
  'mention-database',
  'mention-block',
  'page',
  'link_to_page',
  'child_page',
  'b',
  'i',
  'u',
];

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function convertTables(md: string): string {
  return md.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/g, (_m, body: string) => {
    const rows: string[] = [];
    for (const tr of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...tr[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
        c[1]!.replace(/\s+/g, ' ').trim()
      );
      if (cells.some((c) => c)) rows.push(cells.join(' | '));
    }
    return rows.length ? `\n${rows.join('\n')}\n` : '\n';
  });
}

function cleanSegment(md: string): string {
  let s = md;

  // Images: keep the caption, drop the (huge, signed, expiring) URL.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt.trim() ? `[Image: ${alt.trim()}]` : ''));
  // Links: keep the text.
  s = s.replace(/\[([^\]]+)\]\((?:https?:|mailto:|notion:|collection:)[^)]*\)/g, '$1');
  // Bare S3 / attachment URLs that slipped through.
  s = s.replace(/https?:\/\/prod-files-secure\.s3[^\s)>]*/g, '');
  s = s.replace(/file:\/\/%7B[^\s)>]*/g, '');

  // Dates and mentions.
  s = s.replace(/<mention-date\s+start="([^"]+)"(?:\s+end="([^"]+)")?[^>]*\/>/g, (_m, a: string, b?: string) =>
    b ? `${a} – ${b}` : a
  );
  s = s.replace(/<database\b[^>]*>([\s\S]*?)<\/database>/g, (_m, name: string) => `Database: ${name.trim()}`);
  s = s.replace(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g, (_m, t: string) => `**${t.trim()}**`);

  for (const tag of SELF_CLOSING_DROP) {
    s = s.replace(new RegExp(`<${escapeRe(tag)}\\b[^>]*\\/?>`, 'g'), '');
  }
  s = s.replace(/<br\s*\/?>/g, '\n');

  s = convertTables(s);
  s = s.replace(/<\/?(?:colgroup|col|tr|td|th|thead|tbody)\b[^>]*>/g, ' ');

  for (const tag of UNWRAP) {
    s = s.replace(new RegExp(`<\\/?${escapeRe(tag)}\\b[^>]*>`, 'g'), '');
  }

  // Block attribute suffixes: {toggle="true"}, {color="gray"}, {i=1}
  s = s.replace(/\s*\{[a-z_-]+=[^}]*\}/g, '');

  // Notion escapes markdown punctuation it wants shown literally.
  s = s.replace(/\\([\\`*_{}\[\]()#+\-.!$|<>])/g, '$1');

  // Column/toggle nesting is indented with tabs; two spaces keeps list nesting readable.
  s = s.replace(/^\t+/gm, (t) => '  '.repeat(t.length));

  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return s;
}

export function cleanNotionMarkdown(markdown: string): string {
  if (!markdown) return '';
  // Leave fenced code untouched.
  const parts = markdown.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part, i) => (i % 2 === 1 ? part : cleanSegment(part)))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Untouched issue/decision templates: headings plus the template's own instructions. */
export function isTemplatePlaceholder(cleanText: string): boolean {
  return (
    /Provide a brief summary of the issue/i.test(cleanText) ||
    /Describe the issue in detail, including any relevant background information/i.test(cleanText)
  ) && cleanText.length < 900;
}

export function extractRevNumber(...texts: Array<string | null | undefined>): number | null {
  for (const t of texts) {
    if (!t) continue;
    const m = t.match(/\bREV\s*-?\s*(\d{1,2})\b/i);
    if (m) return Number(m[1]);
  }
  return null;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function valid(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * Dates as they appear in PER page titles: "2018-09-04 Weekly Update", "REVX Updates - 02/12/2025",
 * "9SLASH25SLASH19 Mech Updates", "July 13, 2022 REV8 Weekly Update", "4/15/26 Mech Meeting Notes".
 * Titles like "11/5 Mechanical Meeting" have no year and return null.
 */
export function extractDocDate(title: string): string | null {
  const t = title.replace(/SLASH/g, '/');

  let m = t.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));

  m = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return valid(y, Number(m[1]), Number(m[2]));
  }

  m = t.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(20\d{2})\b/);
  if (m) {
    const mo = MONTHS[m[1]!.toLowerCase()];
    if (mo) return valid(Number(m[3]), mo, Number(m[2]));
  }

  return null;
}

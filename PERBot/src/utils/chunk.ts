/**
 * Heading-aware chunking of cleaned markdown.
 *
 * Chunks follow the page's own structure: a heading starts a new chunk once the current one
 * has real content, paragraphs and list items are never split mid-line unless one line alone
 * exceeds the maximum, and every chunk remembers the heading path it sits under. The text
 * that is embedded is prefixed with the page title, breadcrumb and that heading
 * (`buildEmbedText`), which is what lets a chunk that says "the box contains three boards"
 * match a query about the PCM.
 */

export interface TextChunk {
  heading: string | null;
  text: string;
}

export interface ChunkOptions {
  /** Flush once a chunk reaches this many characters. */
  target: number;
  /** Never exceed this; longer single lines are split at sentence boundaries. */
  max: number;
  /** A heading only starts a new chunk when the current one has at least this much. */
  min: number;
}

const HEADING_RE = /^(#{1,4})\s+(.+?)\s*#*\s*$/;

function splitLongLine(line: string, max: number): string[] {
  if (line.length <= max) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('; '), window.lastIndexOf(', '));
    if (cut < max * 0.5) cut = window.lastIndexOf(' ');
    if (cut < max * 0.3) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function chunkMarkdown(clean: string, opts: ChunkOptions): TextChunk[] {
  const lines = clean.split('\n');
  const chunks: TextChunk[] = [];
  const headingStack: Array<{ level: number; text: string }> = [];
  let current: string[] = [];
  let currentLen = 0;
  let currentHeading: string | null = null;
  let inFence = false;

  const headingPath = () => (headingStack.length ? headingStack.map((h) => h.text).join(' › ') : null);

  const flush = () => {
    const text = current.join('\n').trim();
    if (text) chunks.push({ heading: currentHeading, text });
    current = [];
    currentLen = 0;
    currentHeading = headingPath();
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.startsWith('```')) inFence = !inFence;

    const h = inFence ? null : line.match(HEADING_RE);
    if (h) {
      const level = h[1]!.length;
      if (currentLen >= opts.min) flush();
      while (headingStack.length && headingStack[headingStack.length - 1]!.level >= level) headingStack.pop();
      headingStack.push({ level, text: h[2]!.trim() });
      if (currentLen === 0) currentHeading = headingPath();
      current.push(line);
      currentLen += line.length + 1;
      continue;
    }

    for (const piece of splitLongLine(line, opts.max)) {
      if (currentLen > 0 && currentLen + piece.length + 1 > opts.max) flush();
      current.push(piece);
      currentLen += piece.length + 1;
      if (currentLen >= opts.target && !inFence) flush();
    }
  }
  flush();

  // Merge trailing crumbs (a lone heading, one short line) into their predecessor.
  const merged: TextChunk[] = [];
  for (const c of chunks) {
    const prev = merged[merged.length - 1];
    if (prev && c.text.length < 120 && prev.text.length + c.text.length + 1 <= opts.max) {
      prev.text = `${prev.text}\n${c.text}`;
    } else {
      merged.push(c);
    }
  }
  return merged;
}

/** The exact string that gets embedded (and hashed) for a chunk. */
export function buildEmbedText(title: string, ancestors: string[], heading: string | null, text: string): string {
  const crumbs = ancestors.length ? `\n${ancestors.join(' › ')}` : '';
  const head = heading ? `\n${heading}` : '';
  return `${title}${crumbs}${head}\n\n${text}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

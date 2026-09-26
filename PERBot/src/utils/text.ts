export function cleanWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/** Markdown → plain text for tokenizing and for the excerpts shown in Slack. */
export function stripMarkdown(input: string): string {
  return cleanWhitespace(
    input
      .replace(/```[a-z]*\n?/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^>\s+/gm, '')
      .replace(/^\s*[-*]\s+\[[ x]\]\s+/gm, '')
      .replace(/[*_~]/g, ' ')
  );
}

export function tokenize(input: string): string[] {
  return stripMarkdown(input)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
}

/** Words that carry no retrieval signal in a question ("tell me about the PCM"). */
export const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'in', 'on', 'to', 'and', 'or', 'with', 'is', 'are', 'was', 'were', 'be',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'we', 'our', 'you', 'your', 'me', 'my', 'us',
  'tell', 'about', 'what', 'whats', 'how', 'do', 'does', 'did', 'can', 'could', 'should', 'would',
  'where', 'when', 'which', 'who', 'why', 'explain', 'describe', 'show', 'find', 'give', 'info',
  'information', 'docs', 'doc', 'documentation', 'page', 'please', 'pls', 'any', 'some', 'there',
  'per', 'team', 'car', 'like', 'get', 'know', 'need', 'want', 'have', 'has', 'at', 'by', 'from', 'as',
  'up', 'so', 'if', 'into', 'out', 'more', 'all',
]);

export function contentTerms(input: string): string[] {
  return tokenize(input).filter((t) => !STOPWORDS.has(t));
}

export function makeSnippet(input: string, maxLen = 220): string {
  const cleaned = stripMarkdown(input);
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1).trim()}…`;
}

export function excerptAroundMatch(text: string, query: string, maxLen = 240): string {
  const cleaned = stripMarkdown(text);
  if (!cleaned) return '';

  const tokens = contentTerms(query);
  if (tokens.length === 0) return makeSnippet(cleaned, maxLen);

  const haystack = cleaned.toLowerCase();
  let firstIndex = -1;

  for (const token of tokens) {
    const idx = haystack.indexOf(token);
    if (idx !== -1 && (firstIndex === -1 || idx < firstIndex)) {
      firstIndex = idx;
    }
  }

  if (firstIndex === -1) return makeSnippet(cleaned, maxLen);

  let start = Math.max(0, firstIndex - Math.floor(maxLen / 3));
  if (start > 0) {
    const ws = cleaned.indexOf(' ', start);
    if (ws !== -1 && ws - start < 20) start = ws + 1;
  }
  const end = Math.min(cleaned.length, start + maxLen);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < cleaned.length ? '…' : '';
  return `${prefix}${cleaned.slice(start, end).trim()}${suffix}`;
}

export function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

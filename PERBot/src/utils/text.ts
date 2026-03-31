export function cleanWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

export function stripMarkdown(input: string): string {
  return cleanWhitespace(
    input
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^>\s+/gm, '')
      .replace(/[*_~]/g, ' ')
  );
}

export function tokenize(input: string): string[] {
  return stripMarkdown(input)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
}

export function makeSnippet(input: string, maxLen = 220): string {
  const cleaned = stripMarkdown(input);
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1).trim()}…`;
}

export function excerptAroundMatch(text: string, query: string, maxLen = 280): string {
  const cleaned = stripMarkdown(text);
  if (!cleaned) return '';

  const tokens = tokenize(query);
  if (tokens.length === 0) return makeSnippet(cleaned, maxLen);

  const haystack = cleaned.toLowerCase();
  let firstIndex = -1;

  for (const token of tokens) {
    const idx = haystack.indexOf(token.toLowerCase());
    if (idx !== -1 && (firstIndex === -1 || idx < firstIndex)) {
      firstIndex = idx;
    }
  }

  if (firstIndex === -1) return makeSnippet(cleaned, maxLen);

  const start = Math.max(0, firstIndex - Math.floor(maxLen / 3));
  const end = Math.min(cleaned.length, start + maxLen);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < cleaned.length ? '…' : '';
  return `${prefix}${cleaned.slice(start, end).trim()}${suffix}`;
}

export function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

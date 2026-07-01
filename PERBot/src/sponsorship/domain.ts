/**
 * Deterministic domain handling for enrichment (no LLM involved — guardrail:
 * domain resolution is mechanical). A `/sponsor add` argument is either a URL/domain
 * ("https://acme.com", "acme.com") or a bare company name ("Acme Robotics"). We can
 * only resolve the former deterministically; bare names are resolved downstream via
 * Hunter's company→domain lookup.
 */

/** Strip protocol, path, port, and a leading www. → bare lowercase hostname, or null. */
export function extractHostname(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let candidate = trimmed;
  try {
    // new URL() needs a scheme; add one if the user omitted it.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
    candidate = new URL(withScheme).hostname;
  } catch {
    return null;
  }

  const host = candidate.toLowerCase().replace(/^www\./, '');
  // Must look like a real domain: at least one dot and a plausible TLD.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return host;
}

/** True when the input looks like a URL/domain rather than a company name. */
export function looksLikeDomain(input: string): boolean {
  const trimmed = input.trim();
  // A bare name usually has spaces; a domain does not and contains a dot.
  if (/\s/.test(trimmed) && !/^[a-z]+:\/\//i.test(trimmed)) return false;
  return extractHostname(trimmed) !== null;
}

/** The canonical form we store in Notion's Domain (url) column and dedupe on. */
export function toCanonicalUrl(hostname: string): string {
  return `https://${hostname.toLowerCase().replace(/^www\./, '')}`;
}

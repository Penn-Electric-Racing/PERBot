import type { WebClient } from '@slack/web-api';
import { logger } from '../utils/logger.js';
import { NotionUser } from './types.js';

/**
 * Bridges a Pipeline DRI (a native Notion person) to a Slack user, and vice-versa.
 *
 * Primary key is EMAIL — because DRI is a real person property (not a freeform name
 * field), email is a strong unique join. When email is unavailable (the Notion
 * integration lacks the "read user emails" capability, or a member's Slack/Notion
 * emails differ) we fall back to a CONSERVATIVE name match against the Slack directory,
 * ported from per-risk's ownerResolver: exact normalized name, unique token-subset, or
 * unique surname+first-initial. Anything ambiguous is left unresolved, never guessed.
 *
 * Scopes: `users:read` (directory) and `users:read.email` (email match).
 */

export interface Indexed {
  id: string;
  exact: Set<string>; // normalized full names
  tokens: Set<string>; // individual name tokens
  email: string | null; // lowercased
}

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokensOf(s: string): string[] {
  return normalize(s).split(' ').filter(Boolean);
}

function indexEntry(id: string, names: string[], email: string | null): Indexed {
  const exact = new Set<string>();
  const tokens = new Set<string>();
  for (const n of names) {
    const norm = normalize(n);
    if (norm) exact.add(norm);
    for (const t of tokensOf(n)) tokens.add(t);
  }
  return { id, exact, tokens, email: email ? email.toLowerCase() : null };
}

/** Conservative name match — returns the single confident candidate, or null. */
function matchByName(name: string, candidates: Indexed[]): Indexed | null {
  const norm = normalize(name);
  if (!norm) return null;

  const exact = candidates.filter((c) => c.exact.has(norm));
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null; // ambiguous — don't guess

  const qTokens = tokensOf(name);
  if (qTokens.length === 0) return null;

  const subset = candidates.filter((c) => qTokens.every((t) => c.tokens.has(t)));
  if (subset.length === 1) return subset[0]!;
  if (subset.length > 1) return null;

  // Nickname fallback: exact surname + matching first initial, uniquely.
  if (qTokens.length >= 2) {
    const surname = qTokens[qTokens.length - 1]!;
    const firstInitial = qTokens[0]![0];
    const nick = candidates.filter(
      (c) => c.tokens.has(surname) && [...c.tokens].some((t) => t !== surname && t[0] === firstInitial)
    );
    if (nick.length === 1) return nick[0]!;
  }
  return null;
}

/** Fetch the Slack member directory as a name/email index (paginated). */
export async function fetchSlackDirectory(client: WebClient): Promise<Indexed[]> {
  const dir: Indexed[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await client.users.list({ limit: 200, cursor });
    for (const m of res.members ?? []) {
      if (m.deleted || m.is_bot || m.id === 'USLACKBOT') continue;
      const real = m.profile?.real_name ?? m.real_name ?? '';
      const display = m.profile?.display_name ?? '';
      const handle = m.name ?? '';
      if (!(real || display || handle)) continue;
      dir.push(indexEntry(m.id, [real, display, handle], m.profile?.email ?? null));
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return dir;
}

export function indexNotionUsers(users: NotionUser[]): Indexed[] {
  return users.map((u) => indexEntry(u.id, [u.name], u.email));
}

/** Notion DRI person → Slack user ID (email first, then conservative name match). */
export async function notionUserToSlackId(
  client: WebClient,
  notionUser: NotionUser,
  slackDir: Indexed[]
): Promise<string | null> {
  if (notionUser.email) {
    const email = notionUser.email.toLowerCase();
    const byEmail = slackDir.find((m) => m.email === email);
    if (byEmail) return byEmail.id;
    try {
      const lookup: any = await client.users.lookupByEmail({ email });
      if (lookup.user?.id) return lookup.user.id;
    } catch {
      // fall through to name matching
    }
  }
  const byName = matchByName(notionUser.name, slackDir);
  if (!byName) logger.warn(`Identity: could not resolve Notion user "${notionUser.name}" to Slack.`);
  return byName?.id ?? null;
}

/** Slack caller → their Notion user ID (email first, then conservative name match). */
export async function slackUserToNotionId(
  client: WebClient,
  slackUserId: string,
  notionIndex: Indexed[]
): Promise<string | null> {
  const info: any = await client.users.info({ user: slackUserId });
  const email: string | undefined = info?.user?.profile?.email;
  if (email) {
    const target = email.toLowerCase();
    const byEmail = notionIndex.find((u) => u.email === target);
    if (byEmail) return byEmail.id;
  }
  const name = info?.user?.profile?.real_name ?? info?.user?.real_name ?? info?.user?.name ?? '';
  const byName = matchByName(name, notionIndex);
  return byName?.id ?? null;
}

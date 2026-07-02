import { WebClient } from '@slack/web-api';
import { config } from '../../config.js';

/**
 * Shared helpers for the scheduled sponsorship jobs (GitHub Actions cron). Jobs are
 * standalone entrypoints, so each builds its own Slack WebClient from the bot token.
 *
 * Idempotency (mandatory — cron can fire late or double): jobs stamp each post/DM with
 * an invisible Slack message-metadata marker and check history for it before sending
 * again (falling back to a legacy in-text marker for older posts).
 */

/** Invisible marker carried in a message's Slack metadata (not shown to users). */
export interface WinMeta {
  eventType: string;
  /** Payload key/value pair that uniquely identifies the post (e.g. deal id, date). */
  key: string;
  value: string;
}

export function makeSlackClient(): WebClient {
  return new WebClient(config.slack.botToken);
}

const CHANNEL_ID_RE = /^[CG][A-Z0-9]{6,}$/;

/** Resolve a channel name ("operations") or ID ("C0123ABC") to a channel ID. */
export async function resolveChannelId(client: WebClient, nameOrId: string): Promise<string | null> {
  const clean = nameOrId.replace(/^#/, '');
  if (CHANNEL_ID_RE.test(clean)) return clean;

  let cursor: string | undefined;
  do {
    const res: any = await client.conversations.list({
      types: 'public_channel,private_channel',
      limit: 200,
      cursor,
      exclude_archived: true,
    });
    for (const ch of res.channels ?? []) {
      if (ch.name === clean) return ch.id as string;
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return null;
}

/**
 * True if a recent message in the channel/DM already carries this marker — either in
 * invisible Slack metadata (new posts) or as a legacy in-text marker (older posts, kept
 * for backward compatibility so we don't re-announce something posted the old way).
 */
export async function alreadyPosted(
  client: WebClient,
  channelId: string,
  meta: WinMeta,
  legacyText: string
): Promise<boolean> {
  const res: any = await client.conversations.history({
    channel: channelId,
    limit: 200,
    include_all_metadata: true,
  });
  return (res.messages ?? []).some((m: any) => {
    const md = m?.metadata;
    if (md?.event_type === meta.eventType && String(md?.event_payload?.[meta.key]) === meta.value) return true;
    return typeof m?.text === 'string' && m.text.includes(legacyText);
  });
}

/** The metadata object to attach to a chat.postMessage call for `meta`. */
export function metadataFor(meta: WinMeta): { event_type: string; event_payload: Record<string, string> } {
  return { event_type: meta.eventType, event_payload: { [meta.key]: meta.value } };
}

import { WebClient } from '@slack/web-api';
import { config } from '../../config.js';

/**
 * Shared helpers for the scheduled sponsorship jobs (GitHub Actions cron). Jobs are
 * standalone entrypoints, so each builds its own Slack WebClient from the bot token.
 *
 * Idempotency (mandatory — cron can fire late or double): jobs embed a stable marker
 * string in every post/DM and check history for it before sending again. This mirrors
 * PERBot's meeting-notes per-channel guard.
 */

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

/** True if `marker` appears in a recent message of the given channel/DM. */
export async function channelHasMarker(client: WebClient, channelId: string, marker: string): Promise<boolean> {
  const res: any = await client.conversations.history({ channel: channelId, limit: 200 });
  return (res.messages ?? []).some((m: any) => typeof m?.text === 'string' && m.text.includes(marker));
}

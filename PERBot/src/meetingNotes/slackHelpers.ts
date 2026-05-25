import { WebClient } from '@slack/web-api';
import { SLACK_WORKSPACE_SUBDOMAIN, KICKOFF_SIGNATURE } from './config';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// Cache channel IDs across calls within a single job run
const channelIdCache = new Map<string, string>();

export async function getChannelId(channelName: string): Promise<string> {
  if (channelIdCache.has(channelName)) {
    return channelIdCache.get(channelName)!;
  }

  let cursor: string | undefined;
  do {
    try {
      const result = await slack.conversations.list({
        types: 'public_channel,private_channel',
        limit: 1000,
        cursor,
      });
      const match = result.channels?.find((c) => c.name === channelName);
      if (match?.id) {
        channelIdCache.set(channelName, match.id);
        return match.id;
      }
      cursor = result.response_metadata?.next_cursor || undefined;
    } catch (err: any) {
      if (err.data) {
        console.error(`Slack error in conversations.list:`, JSON.stringify(err.data, null, 2));
      }
      throw err;
    }
  } while (cursor);

  throw new Error(`Slack channel #${channelName} not found (is the bot invited?)`);
}

export async function postKickoffMessage(channelName: string, text: string): Promise<string> {
  const channelId = await getChannelId(channelName);
  try {
    const result = await slack.chat.postMessage({
      channel: channelId,
      text,
      mrkdwn: true,
    });
    if (!result.ts) throw new Error(`No timestamp returned from chat.postMessage in #${channelName}`);
    return result.ts;
  } catch (err: any) {
    // Surface the full Slack error so we can see `needed` and `provided` scopes
    if (err.data) {
      console.error(`Slack error details for #${channelName}:`, JSON.stringify(err.data, null, 2));
    }
    throw err;
  }
}

/**
 * Find the most recent kickoff message posted by THIS bot in the given channel
 * since the supplied unix timestamp. Returns the message ts (thread root) or null.
 */
export async function findMostRecentBotThread(
  channelName: string,
  sinceUnixSeconds: number
): Promise<string | null> {
  const channelId = await getChannelId(channelName);
  const auth = await slack.auth.test();
  const botUserId = auth.user_id;

  const result = await slack.conversations.history({
    channel: channelId,
    oldest: String(sinceUnixSeconds),
    limit: 100,
  });

  const botMessages = result.messages?.filter(
    (m) => m.user === botUserId && (m.text ?? '').includes(KICKOFF_SIGNATURE)
  );

  // conversations.history returns newest-first, so [0] is most recent
  return botMessages?.[0]?.ts ?? null;
}

export async function getThreadReplies(channelName: string, threadTs: string) {
  const channelId = await getChannelId(channelName);
  const result = await slack.conversations.replies({
    channel: channelId,
    ts: threadTs,
    limit: 200,
  });
  // First message in `messages` is the thread root (kickoff). Skip it.
  return (result.messages ?? []).slice(1);
}

/**
 * Build a clickable Slack permalink for a message.
 * Format: https://<workspace>.slack.com/archives/<channelId>/p<ts-without-dot>
 */
export function getMessagePermalink(channelId: string, ts: string): string {
  return `https://${SLACK_WORKSPACE_SUBDOMAIN}.slack.com/archives/${channelId}/p${ts.replace('.', '')}`;
}

/**
 * Resolve user IDs to display names so the LLM sees "[Alan] busbar replaced"
 * instead of "[U07A9C3D2] busbar replaced". Cached per run.
 */
const userNameCache = new Map<string, string>();
export async function getUserDisplayName(userId: string): Promise<string> {
  if (userNameCache.has(userId)) return userNameCache.get(userId)!;
  try {
    const result = await slack.users.info({ user: userId });
    const name =
      result.user?.profile?.display_name ||
      result.user?.profile?.real_name ||
      result.user?.name ||
      userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

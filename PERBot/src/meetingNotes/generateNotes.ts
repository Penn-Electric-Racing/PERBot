import { SUBSYSTEMS } from './config';
import {
  getChannelId,
  findMostRecentBotThread,
  getThreadReplies,
  getMessagePermalink,
  getUserDisplayName,
} from './slackHelpers';
import { parseSubsystemUpdates, EMPTY_UPDATE } from './parseUpdates';
import { createMeetingNotesPage, SubsystemContent } from './notionWriter';
import { assertExpectedETHour } from './timeCheck';

async function main(): Promise<void> {
  assertExpectedETHour(12);

  // Start-of-week cutoff: Monday 00:00 in ET, converted to unix seconds
  const sinceUnix = computeMondayMidnightETUnix();
  console.log(`Looking for kickoff threads posted since ${new Date(sinceUnix * 1000).toISOString()}`);

  const subsystemContents: SubsystemContent[] = [];

  for (const sub of SUBSYSTEMS) {
    console.log(`\n--- Processing ${sub.name} (#${sub.slackChannel}) ---`);

    try {
      const content = await processSubsystem(sub.name, sub.slackChannel, sinceUnix);
      subsystemContents.push(content);
    } catch (err) {
      console.error(`Failed to process ${sub.name}:`, err);
      // Don't kill the whole run — push an empty entry and continue
      subsystemContents.push({
        subsystem: sub.name,
        updates: EMPTY_UPDATE,
        threadLink: null,
        imageCount: 0,
      });
    }
  // Be polite to Gemini's rate limit — 2s between calls
  await new Promise((r) => setTimeout(r, 2000));
  }

  const url = await createMeetingNotesPage(new Date(), subsystemContents);
  console.log(`\n✓ Meeting notes created: ${url}`);
}

async function processSubsystem(
  name: string,
  channelName: string,
  sinceUnix: number
): Promise<SubsystemContent> {
  const channelId = await getChannelId(channelName);
  const threadTs = await findMostRecentBotThread(channelName, sinceUnix);

  if (!threadTs) {
    console.warn(`No kickoff thread found in #${channelName} since Monday`);
    return { subsystem: name, updates: EMPTY_UPDATE, threadLink: null, imageCount: 0 };
  }

  const replies = await getThreadReplies(channelName, threadTs);
  const threadLink = getMessagePermalink(channelId, threadTs);

  if (replies.length === 0) {
    console.log(`Kickoff thread exists in #${channelName} but no one replied`);
    return { subsystem: name, updates: EMPTY_UPDATE, threadLink, imageCount: 0 };
  }

  // Build thread text with author names so Gemini sees who said what
  const lines: string[] = [];
  for (const m of replies) {
    const author = m.user ? await getUserDisplayName(m.user) : 'unknown';
    const text = (m.text ?? '').trim();
    if (text) lines.push(`[${author}] ${text}`);
  }
  const threadText = lines.join('\n\n');

  // Count image attachments across all replies
  const imageCount = replies.reduce((acc, m) => {
    const files = (m as unknown as { files?: { mimetype?: string }[] }).files ?? [];
    return acc + files.filter((f) => f.mimetype?.startsWith('image/')).length;
  }, 0);

  console.log(`Found ${replies.length} replies, ${imageCount} images. Calling Gemini...`);
  const updates = threadText.trim()
    ? await parseSubsystemUpdates(name, threadText)
    : EMPTY_UPDATE;

  return { subsystem: name, updates, threadLink, imageCount };
}

/**
 * Compute the unix timestamp (seconds) for Monday 00:00 in America/New_York
 * of the current week. Used as the "oldest" filter when looking for kickoff threads.
 */
function computeMondayMidnightETUnix(): number {
  // Get the current date in ET
  const now = new Date();
  const etNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));

  // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const dayOfWeek = etNow.getDay();
  // Days to subtract to reach Monday of this week (Mon → 0, Tue → 1, ..., Sun → 6)
  const daysFromMonday = (dayOfWeek + 6) % 7;

  const mondayET = new Date(etNow);
  mondayET.setDate(mondayET.getDate() - daysFromMonday);
  mondayET.setHours(0, 0, 0, 0);

  // mondayET above is naive — interpret it as ET, get the equivalent UTC instant
  // by asking what UTC offset ET currently has and adjusting
  const etOffsetMs = computeETOffsetMs(mondayET);
  const mondayMidnightUtcMs = mondayET.getTime() + etOffsetMs;
  return Math.floor(mondayMidnightUtcMs / 1000);
}

function computeETOffsetMs(date: Date): number {
  // The difference between UTC time and the same wall-clock time in ET
  const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const etDate = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return utcDate.getTime() - etDate.getTime();
}

main().catch((err) => {
  console.error('Generate notes job crashed:', err);
  process.exit(1);
});

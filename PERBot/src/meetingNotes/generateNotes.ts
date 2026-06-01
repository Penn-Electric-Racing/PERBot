import { SUBSYSTEMS } from './config';
import {
  getChannelId,
  findMostRecentBotThread,
  getThreadReplies,
  getMessagePermalink,
  getUserDisplayName,
} from './slackHelpers';
import {
  parseSubsystemUpdates,
  EMPTY_UPDATE,
  ProcessedMessage,
} from './parseUpdates';
import {
  createMeetingNotesPage,
  findExistingMeetingPageForToday,
  SubsystemContent,
} from './notionWriter';
import { assertExpectedETHourRange } from './timeCheck';

async function main(): Promise<void> {
  // Accept any Wednesday run between 11am-1pm ET (target is 12pm, but cron is flaky).
  assertExpectedETHourRange(11, 13);

  // Idempotency: if a meeting page for today already exists, don't create another one
  const existingPageUrl = await findExistingMeetingPageForToday();
  if (existingPageUrl) {
    console.log(`⊘ Meeting page for today already exists, skipping generation: ${existingPageUrl}`);
    return;
  }

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
      subsystemContents.push({
        subsystem: sub.name,
        updates: EMPTY_UPDATE,
        threadLink: null,
        imageCount: 0,
      });
    }
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

  const processedMessages: ProcessedMessage[] = [];
  let totalImageCount = 0;
  for (const m of replies) {
    const author = m.user ? await getUserDisplayName(m.user) : 'unknown';
    const text = (m.text ?? '').trim();
    const files =
      (m as unknown as { files?: { mimetype?: string }[] }).files ?? [];
    const imageCount = files.filter((f) => f.mimetype?.startsWith('image/')).length;
    totalImageCount += imageCount;
    const permalink = m.ts ? getMessagePermalink(channelId, m.ts) : null;
    if (text || imageCount > 0) {
      processedMessages.push({ author, text, imageCount, permalink });
    }
  }

  console.log(`Found ${replies.length} replies, ${totalImageCount} images. Parsing...`);
  const updates =
    processedMessages.length > 0
      ? await parseSubsystemUpdates(name, processedMessages)
      : EMPTY_UPDATE;

  return { subsystem: name, updates, threadLink, imageCount: totalImageCount };
}

function computeMondayMidnightETUnix(): number {
  const now = new Date();
  const etNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dayOfWeek = etNow.getDay();
  const daysFromMonday = (dayOfWeek + 6) % 7;

  const mondayET = new Date(etNow);
  mondayET.setDate(mondayET.getDate() - daysFromMonday);
  mondayET.setHours(0, 0, 0, 0);

  const etOffsetMs = computeETOffsetMs(mondayET);
  const mondayMidnightUtcMs = mondayET.getTime() + etOffsetMs;
  return Math.floor(mondayMidnightUtcMs / 1000);
}

function computeETOffsetMs(date: Date): number {
  const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const etDate = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return utcDate.getTime() - etDate.getTime();
}

main().catch((err) => {
  console.error('Generate notes job crashed:', err);
  process.exit(1);
});

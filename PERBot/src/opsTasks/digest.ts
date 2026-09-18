import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { claimJobRun, isSlotOpenET } from '../utils/schedule.js';
import { todayIsoET } from '../sponsorship/dates.js';
import { fetchSlackDirectory, notionUserToSlackId } from '../sponsorship/identity.js';
import { makeSlackClient } from '../sponsorship/jobs/shared.js';
import { buildDigestBlocks } from './blocks.js';
import { isOverdue, sortTasks, taskLine } from './format.js';
import { pickMeeting } from './meetings.js';
import { OpsTask, OpsTasksNotion } from './notion.js';

// Formatting helpers live in format.ts (shared with blocks.ts); re-exported for existing importers.
export { carriedWeeks, isOverdue, sortTasks, taskLine } from './format.js';

/**
 * Sunday 10 AM ET Ops-tasks digest — DMs ONLY, never a channel post (Arjun's call,
 * 2026-09-11). Each Ops member with an open task in the Ops Tasks database gets one
 * short DM listing exactly their own open tasks: 🔴 on anything past Due, and a
 * "carried N wks" tag on anything assigned before the most recent Saturday. Members
 * with nothing open get nothing (silence is valid).
 *
 * Why "everything open" rather than "assigned this week": a Status-based query can't go
 * silent if a meeting page is created late or a task never gets linked to a meeting, and
 * it is the honest picture anyway.
 *
 * Idempotency: two DST cron triggers, and only the one landing on 10am ET does the work
 * (same pattern as the sponsorship digest). DMs post straight to the user ID.
 */

/** Seed rows created so Notion would show every member's group; skipped until renamed. */
export const PLACEHOLDER_RE = /^rename me/i;


export function isPlaceholder(task: OpsTask): boolean {
  return task.title === '' || PLACEHOLDER_RE.test(task.title);
}

/**
 * Link open tasks that have no Meeting relation to the meeting page their date falls in
 * (see meetings.ts). Such tasks come from `/assign` runs before the week's page existed and
 * from rows added on the old Week-filtered pages; unlinked, they never appear in any
 * "This week" table and look carried over on every page. Mutates the passed tasks so the
 * DMs sent right after use the linked meeting's date for "carried N wks". Returns the count.
 */
export async function linkOrphanTasks(notion: OpsTasksNotion, tasks: OpsTask[], dryRun = false): Promise<number> {
  const orphans = tasks.filter((t) => t.meetingIds.length === 0 && t.week);
  if (orphans.length === 0) return 0;
  const meetings = await notion.listMeetings();
  let linked = 0;
  for (const task of orphans) {
    const meeting = pickMeeting(meetings, task.week!);
    if (!meeting) {
      logger.info(`Ops digest: "${task.title}" (dated ${task.week}) has no meeting page to link to yet.`);
      continue;
    }
    try {
      if (!dryRun) await notion.linkMeeting(task, meeting.id);
      task.meetingIds.push(meeting.id);
      task.week = meeting.date;
      linked++;
    } catch (err) {
      logger.warn(`Ops digest: could not link "${task.title}" to meeting ${meeting.date}.`, err);
    }
  }
  logger.info(`Ops digest: linked ${linked}/${orphans.length} unlinked task(s) to their meeting page${dryRun ? ' (dry run)' : ''}.`);
  return linked;
}

export function buildDigest(tasks: OpsTask[]): string {
  const sorted = sortTasks(tasks);
  const overdue = sorted.filter(isOverdue).length;
  const header = `:clipboard: *Your open Ops tasks (${sorted.length}${overdue > 0 ? `, ${overdue} overdue` : ''})*`;
  const footer = `_Update here with the buttons or in Notion — Saturday's walkthrough runs off this list. <${config.opsTasks.myOpenViewUrl}|My open>_`;
  return [header, ...sorted.map(taskLine), footer].join('\n');
}

export async function runOpsDigest(force = process.env.FORCE_OPS_DIGEST?.toLowerCase() === 'true'): Promise<void> {
  if (!force && !isSlotOpenET('Sunday', 10)) {
    logger.info('Ops digest: not Sunday ≥10:00 ET and not forced — skipping.');
    return;
  }
  const dryRun = process.env.OPS_DIGEST_DRY_RUN?.toLowerCase() === 'true';
  // Late-tolerant gate + two DST crons ⇒ dedupe via the Job Log (DM jobs can't read DM history).
  if (!force && !dryRun && !(await claimJobRun('ops-tasks-digest'))) return;

  const notion = new OpsTasksNotion();
  const open = await notion.queryOpenTasks();
  const real = open.filter((t) => !isPlaceholder(t));
  logger.info(`Ops digest (${todayIsoET()}): ${open.length} open rows, ${open.length - real.length} placeholders skipped.`);
  await linkOrphanTasks(notion, real, dryRun);

  // One list per owner; a co-owned task appears in every owner's DM.
  const byOwner = new Map<string, { owner: OpsTask['owners'][number]; tasks: OpsTask[] }>();
  for (const task of real) {
    if (task.owners.length === 0) {
      logger.warn(`Ops digest: "${task.title}" has no Owner — nobody to DM.`);
      continue;
    }
    for (const owner of task.owners) {
      const entry = byOwner.get(owner.id) ?? { owner, tasks: [] };
      entry.tasks.push(task);
      byOwner.set(owner.id, entry);
    }
  }
  if (byOwner.size === 0) {
    logger.info('Ops digest: nobody has open tasks — nothing to send.');
    return;
  }

  const client = makeSlackClient();
  const slackDir = await fetchSlackDirectory(client);

  for (const { owner, tasks } of byOwner.values()) {
    const slackUserId = await notionUserToSlackId(client, owner, slackDir);
    const label = owner.name || owner.email || owner.id;
    if (!slackUserId) {
      logger.warn(`Ops digest: no Slack match for ${label} — skipping ${tasks.length} task(s).`);
      continue;
    }
    const text = buildDigest(tasks);
    if (dryRun) {
      logger.info(`Ops digest (dry run) → ${label} (${slackUserId}):\n${text}`);
      continue;
    }
    // Blocks carry the Done / In progress / Push buttons (handled by opsTasks/actions.ts);
    // `text` is the notification/fallback copy.
    await client.chat.postMessage({ channel: slackUserId, text, blocks: buildDigestBlocks(tasks, slackUserId), unfurl_links: false });
    logger.info(`Ops digest: sent ${tasks.length} task(s) to ${label}.`);
  }
}

// Entrypoint when run directly (GitHub Actions).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runOpsDigest().catch((err) => {
    logger.error('Ops digest job failed.', err);
    process.exitCode = 1;
  });
}

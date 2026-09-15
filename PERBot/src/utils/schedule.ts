import { Client } from '@notionhq/client';
import { config } from '../config.js';
import { logger } from './logger.js';

/**
 * Scheduling helpers for the GitHub-Actions cron jobs.
 *
 * WHY: GitHub's cron on this repo fires LATE — routinely 2–4 hours (2026-09-12: the
 * 14:00/15:00 UTC quota-audit triggers ran at 16:43 and 17:43 UTC; the 13:00/14:00 digest
 * triggers ran at 15:55/16:37; the Wednesday stale DM at 17:04/17:22). Every job used an
 * exact-hour gate (`hour === 10`), so the late runs logged "skipping" and exited green —
 * nothing was sent for weeks. So:
 *
 *  1. `isSlotOpenET` is late-tolerant: right weekday (ET) and the slot hour has BEGUN —
 *     a fire any time later that day still runs.
 *  2. Because that lets both DST cron triggers (and any stray extra fire) through,
 *     `claimJobRun` records each real run in the ⚙️ PERBot Job Log data source in Notion
 *     and refuses a second claim for the same key (job + ET date). DM jobs can't read
 *     their own DM history for a marker (no im:history), so this is their dedup.
 *
 * `claimOnce` is the same record, keyed to a one-shot event instead of a day — for things
 * announced exactly once ever (a deal's win post). Channel-history markers can't do that
 * job: they only look back as far as the history page we read, so a post that scrolls out
 * of that window looks un-sent and gets sent again. A Notion record doesn't scroll.
 */

export type WeekdayET = 'Sunday' | 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday';

/** Today's ET weekday + hour. */
export function nowET(now: Date = new Date()): { weekday: WeekdayET; hour: number; dateIso: string } {
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' }) as WeekdayET;
  const hour = Number(now.toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'America/New_York' }));
  const dateIso = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  return { weekday, hour: hour === 24 ? 0 : hour, dateIso };
}

/** True when it's `weekday` in ET and the clock has reached `hour` (any later time that day counts). */
export function isSlotOpenET(weekday: WeekdayET, hour: number, now: Date = new Date()): boolean {
  const et = nowET(now);
  return et.weekday === weekday && et.hour >= hour;
}

/**
 * Claim this job's run for today (ET). Returns true if this process is the first to do so
 * (go ahead and send); false if a record already exists (another cron fire already did the
 * work — skip).
 */
export async function claimJobRun(job: string, dateIso: string = nowET().dateIso): Promise<boolean> {
  return claimOnce(`${job} ${dateIso}`, job);
}

/**
 * Claim `key` in the Job Log once and for all (no date in the key) — for events announced
 * exactly once ever, like a deal's win post. Returns true if this process is the first to
 * claim it, false if a record already exists (someone already did it — skip).
 *
 * Writes the record BEFORE the caller sends, so a crash mid-send is "sent" rather than
 * "send it again" — the safer failure for anything that posts to a channel or DMs people.
 * If the Job Log data source isn't configured, returns true with a warning (no dedup).
 */
export async function claimOnce(key: string, job: string): Promise<boolean> {
  const dsId = config.notion.jobLogDataSourceId;
  if (!dsId) {
    logger.warn(`Job log: NOTION_JOB_LOG_DS_ID not set — cannot dedupe "${key}".`);
    return true;
  }
  const client = new Client({ auth: config.notion.token, notionVersion: config.notion.apiVersion });
  const existing: any = await client.dataSources.query({
    data_source_id: dsId,
    filter: { property: 'Run key', title: { equals: key } },
    page_size: 1,
  });
  if ((existing.results ?? []).length > 0) {
    logger.info(`Job log: "${key}" already claimed — skipping.`);
    return false;
  }
  await client.pages.create({
    parent: { type: 'data_source_id', data_source_id: dsId },
    properties: {
      'Run key': { title: [{ text: { content: key } }] },
      Job: { rich_text: [{ text: { content: job } }] },
      'Ran at': { date: { start: new Date().toISOString() } },
    } as any,
  });
  logger.info(`Job log: claimed "${key}".`);
  return true;
}

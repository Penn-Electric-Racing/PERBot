import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { config } from '../config.js';
import { indexNotionUsers, slackUserToNotionId, type Indexed } from '../sponsorship/identity.js';
import { resolveChannelId } from '../sponsorship/jobs/shared.js';
import { logger } from '../utils/logger.js';
import { ARRIVAL_ACTION_IDS, ARRIVAL_ACTION_RE, decodeValue, leadTimeLine, packageKey, settleBlocks, targetIds } from './blocks.js';
import { ARRIVED_YES, ArrivalsNotion } from './notion.js';
import { isImage, loadImages, parentText, processDelivery, withNames } from './pipeline.js';
import type { ArrivalRow } from './types.js';

/**
 * Package arrivals in `ARRIVALS_CHANNEL`. Every human message with a photo (top level or in a
 * thread) runs through `processDelivery`; PERBot replies in the thread only when it has something
 * useful (see blocks.ts:buildReply), and writes Notion only when someone taps a button — only the
 * arrival columns. Other bots (the Copy Center webhook, B11's RFID logger) are ignored.
 *
 * Slack setup: bot scope `files:read` and the `message.channels` event (`message.groups` too if
 * the channel is private), then reinstall.
 */

const notion = new ArrivalsNotion();

let channelId: Promise<string | null> | null = null;
function arrivalsChannelId(client: WebClient): Promise<string | null> {
  if (!channelId) {
    channelId = resolveChannelId(client, config.arrivals.channel).then(
      (id) => {
        if (!id) logger.warn(`Arrivals: channel "${config.arrivals.channel}" not found; the listener is idle.`);
        return id;
      },
      (err) => {
        channelId = null; // retry on the next message
        throw err;
      }
    );
  }
  return channelId;
}

/** Slack redelivers events it thinks we missed; one message is processed once per process. */
const seen = new Set<string>();
/** Package key (vendor + tracking) → permalink of the reply that already covers that box. */
const packages = new Map<string, string>();
/** Threads that already got a "post the packing slip" nudge — one per thread is enough. */
const nudged = new Set<string>();

/** Keep the dedupe memory bounded: drop the oldest entry past 500. */
function cap(coll: Set<string> | Map<string, string>): void {
  if (coll.size > 500) coll.delete(coll.keys().next().value!);
}

async function handlePhoto(client: WebClient, event: any): Promise<void> {
  const threadTs = event.thread_ts ?? event.ts;
  const inThread = Boolean(event.thread_ts && event.thread_ts !== event.ts);
  const reply = (text: string, blocks?: any[]) =>
    client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text, ...(blocks ? { blocks } : {}), unfurl_links: false });

  try {
    const images = await loadImages(client, event.files);
    if (images.length === 0) return;
    const [text, parent, openRows] = await Promise.all([
      withNames(client, event.text ?? ''),
      inThread ? parentText(client, event.channel, threadTs) : Promise.resolve(undefined),
      notion.openRows(),
    ]);
    const { scan, resolutions, reply: answer } = await processDelivery(
      { ts: event.ts, user: event.user, text, parentText: parent, inThread, images },
      openRows
    );
    logger.info(
      `Arrivals: ${event.ts} scene=${scan.scene} legible=${scan.legible} packages=${scan.packages.length} ` +
        `→ ${resolutions.map((r) => r.kind).join(',') || '-'} reply=${answer ? 'yes' : 'silent'}`
    );
    if (!answer) return;

    const isNudge = !answer.blocks.some((b) => b.type === 'actions');
    if (isNudge && nudged.has(threadTs)) return;

    // A second photo of a box we already answered for: point at that reply instead.
    const keys = scan.packages.map(packageKey).filter((k): k is string => !!k);
    const earlier = keys.map((k) => packages.get(k)).find(Boolean);
    if (earlier && keys.every((k) => packages.has(k))) {
      await reply(`:package: Same box as <${earlier}|this one> (same tracking number) — confirm it there.`);
      return;
    }

    const posted: any = await reply(answer.text, answer.blocks);
    if (isNudge) {
      nudged.add(threadTs);
      cap(nudged);
    } else if (keys.length && posted?.ts) {
      const link: any = await client.chat.getPermalink({ channel: event.channel, message_ts: posted.ts }).catch(() => null);
      for (const k of keys) if (link?.permalink) packages.set(k, link.permalink as string);
      cap(packages);
    }
  } catch (err) {
    logger.error('Arrivals: photo handling failed', err);
    // Stay quiet in threads (most thread photos are banter); a top-level failure gets one line.
    if (!inThread) await reply(':warning: I couldn’t process that photo. Mark the order in Notion for now; the error is in the Render logs.').catch(() => undefined);
  }
}

// --- Click handling ---------------------------------------------------------------------------

let peopleIndex: { at: number; index: Promise<Indexed[]> } | null = null;
function notionPeople(): Promise<Indexed[]> {
  if (!peopleIndex || Date.now() - peopleIndex.at > 3_600_000) {
    peopleIndex = { at: Date.now(), index: notion.listUsers().then(indexNotionUsers) };
    peopleIndex.index.catch(() => (peopleIndex = null));
  }
  return peopleIndex.index;
}

async function receiverNotionId(client: WebClient, slackUserId: string): Promise<string | null> {
  try {
    return await slackUserToNotionId(client, slackUserId, await notionPeople());
  } catch (err) {
    logger.warn(`Arrivals: could not resolve ${slackUserId} to a Notion person`, err);
    return null;
  }
}

async function rowsFor(ids: string[], known: ArrivalRow[]): Promise<ArrivalRow[]> {
  const byId = new Map(known.map((r) => [r.id.replace(/-/g, ''), r]));
  const rows: ArrivalRow[] = [];
  for (const id of ids) rows.push(byId.get(id) ?? (await notion.fetchRow(id)));
  return rows;
}

export function registerArrivals(app: App): void {
  if (!config.arrivals.channel) {
    logger.info('Arrivals: ARRIVALS_CHANNEL unset; delivery-photo listener disabled.');
    return;
  }

  app.event('message', async ({ event, client }) => {
    const e = event as any;
    if (e.bot_id || !e.user || e.subtype === 'message_changed' || !Array.isArray(e.files) || !e.files.some(isImage)) return;
    if (e.channel !== (await arrivalsChannelId(client))) return;
    const id = `${e.channel}:${e.ts}`;
    if (seen.has(id)) return;
    seen.add(id);
    cap(seen);
    await handlePhoto(client, e);
  });

  app.action(ARRIVAL_ACTION_RE, async ({ ack, body, action, respond, client }) => {
    await ack();
    const actionId = (action as any)?.action_id as string;
    const blockId = (action as any)?.block_id as string;
    const value = decodeValue((action as any)?.value);
    const clicker = (body as any)?.user?.id as string | undefined;
    const channel = (body as any)?.channel?.id as string | undefined;
    const existing: any[] = (body as any)?.message?.blocks ?? [];
    if (!value || !clicker || !channel) return;

    if (actionId === ARRIVAL_ACTION_IDS.wrong) {
      await respond({
        replace_original: true,
        text: 'Not this order',
        blocks: settleBlocks(existing, blockId, `✗ <@${clicker}>: not this order — nothing was written. Mark it in Notion if it’s ours.`),
      });
      return;
    }

    try {
      const runRows = value.g ? await notion.rowsForRun(value.g) : [];
      const rows = await rowsFor(targetIds(value, runRows.map((r) => r.id)), runRows);
      const already = rows.filter((r) => r.arrived === ARRIVED_YES);
      const todo = rows.filter((r) => r.arrived !== ARRIVED_YES);

      const arrivedAt = new Date(Number(value.ts) * 1000).toISOString();
      const [receivedBy, permalink] = await Promise.all([
        receiverNotionId(client, value.u),
        client.chat.getPermalink({ channel, message_ts: value.ts }).then((r: any) => (r?.permalink as string) ?? null, () => null),
      ]);

      const failed: ArrivalRow[] = [];
      for (const row of todo) {
        try {
          await notion.markArrived(row.id, { arrivedAt, receivedByNotionId: receivedBy, photoUrl: permalink });
        } catch (err) {
          logger.error(`Arrivals: write failed for ${row.id}`, err);
          failed.push(row);
        }
      }

      const done = todo.length - failed.length;
      const parts = [`✅ <@${clicker}> marked *${done}* item${done === 1 ? '' : 's'} arrived (received by <@${value.u}>)`];
      if (already.length) parts.push(`${already.length} already marked`);
      if (failed.length) parts.push(`⚠️ ${failed.length} failed — set Arrived? in Notion`);
      const lead = leadTimeLine(rows, arrivedAt);
      const outcome = parts.join(' · ') + (lead ? `\n${lead}` : '');
      await respond({ replace_original: true, text: `${done} items marked arrived`, blocks: settleBlocks(existing, blockId, outcome) });
      logger.info(`Arrivals: ${clicker} ${actionId} → ${done} marked, ${already.length} already, ${failed.length} failed.`);
    } catch (err) {
      logger.error(`Arrivals: ${actionId} failed`, err);
      await respond({ response_type: 'ephemeral', replace_original: false, text: '✗ Could not update Notion. Try again, or set Arrived? in Notion.' });
    }
  });
}

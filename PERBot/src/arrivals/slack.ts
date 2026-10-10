import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { config } from '../config.js';
import { indexNotionUsers, slackUserToNotionId, type Indexed } from '../sponsorship/identity.js';
import { resolveChannelId } from '../sponsorship/jobs/shared.js';
import { logger } from '../utils/logger.js';
import {
  ARRIVAL_ACTION_IDS,
  ARRIVAL_ACTION_RE,
  buildReply,
  decodeValue,
  leadTimeLine,
  packageKey,
  settleBlocks,
  targetIds,
} from './blocks.js';
import { extractSlip, type SlipImage } from './extract.js';
import { matchSlip } from './match.js';
import { ARRIVED_YES, ArrivalsNotion } from './notion.js';
import type { ArrivalRow } from './types.js';

/**
 * Package arrivals (Week 1, suggest-only). A photo posted in `ARRIVALS_CHANNEL` (top level or
 * a thread) → read the slip → match open Purchasing rows → reply in the thread with buttons.
 * Notion is written only when someone taps a button, and only the arrival columns.
 *
 * Slack setup: bot scope `files:read` (to download the photo) and the `message.channels`
 * event (`message.groups` too if the channel is private), then reinstall.
 */

const notion = new ArrivalsNotion();

/** OpenAI accepts these directly; anything else (HEIC from iPhones) goes via Slack's JPEG thumbnail. */
const DIRECT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_IMAGES = 4;

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

/** Keep the dedupe memory bounded: drop the oldest entry past 500. */
function cap(coll: Set<string> | Map<string, string>): void {
  if (coll.size > 500) coll.delete(coll.keys().next().value!);
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${config.slack.botToken}` } });
  const type = res.headers.get('content-type') ?? '';
  // Without files:read Slack answers with its HTML sign-in page, not an error status.
  if (!res.ok || !type.startsWith('image/')) {
    throw new Error(`Could not download the photo (HTTP ${res.status}, ${type || 'no type'}); does the bot have files:read?`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function loadImages(client: WebClient, files: any[]): Promise<SlipImage[]> {
  const images: SlipImage[] = [];
  for (let file of files.slice(0, MAX_IMAGES)) {
    if (!file.url_private) file = ((await client.files.info({ file: file.id })) as any).file ?? file;
    if (DIRECT_TYPES.has(file.mimetype) && file.url_private_download) {
      images.push({ data: await download(file.url_private_download), mimeType: file.mimetype });
    } else {
      const thumb = file.thumb_1024 ?? file.thumb_960 ?? file.thumb_720;
      if (thumb) images.push({ data: await download(thumb), mimeType: 'image/jpeg' });
    }
  }
  return images;
}

async function handlePhoto(client: WebClient, event: any): Promise<void> {
  const threadTs = event.thread_ts ?? event.ts;
  const reply = (text: string, blocks?: any[]) =>
    client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text, ...(blocks ? { blocks } : {}), unfurl_links: false });

  try {
    const images = await loadImages(client, event.files.filter((f: any) => String(f.mimetype ?? '').startsWith('image/')));
    if (images.length === 0) return;

    const extraction = await extractSlip(images);
    const key = packageKey(extraction);
    const earlier = key ? packages.get(key) : undefined;
    if (earlier) {
      await reply(`:package: Same box as <${earlier}|this one> (same tracking number) — confirm it there.`);
      return;
    }

    const match = matchSlip(extraction, extraction.legible ? await notion.openRows() : []);
    const { text, blocks } = buildReply(extraction, match, { u: event.user, ts: event.ts });
    const posted: any = await reply(text, blocks);
    logger.info(
      `Arrivals: ${event.ts} vendor=${extraction.vendor ?? '?'} lines=${extraction.lines.length} ` +
        `matched=${match.matchedRows.length} confidence=${match.confidence} run=${match.runId ?? '-'}`
    );
    if (key && posted?.ts && match.matchedRows.length) {
      const link: any = await client.chat.getPermalink({ channel: event.channel, message_ts: posted.ts }).catch(() => null);
      if (link?.permalink) {
        packages.set(key, link.permalink as string);
        cap(packages);
      }
    }
  } catch (err) {
    logger.error('Arrivals: photo handling failed', err);
    await reply(':warning: I couldn’t process that photo. Mark the order in Notion for now; the error is in the Render logs.').catch(() => undefined);
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
    logger.info('Arrivals: ARRIVALS_CHANNEL unset; packing-slip listener disabled.');
    return;
  }

  app.event('message', async ({ event, client }) => {
    const e = event as any;
    if (e.bot_id || !e.user || !Array.isArray(e.files) || !e.files.some((f: any) => String(f.mimetype ?? '').startsWith('image/'))) return;
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
    const value = decodeValue((action as any)?.value);
    const clicker = (body as any)?.user?.id as string | undefined;
    const channel = (body as any)?.channel?.id as string | undefined;
    const existing: any[] = (body as any)?.message?.blocks ?? [];
    if (!value || !clicker || !channel) return;

    if (actionId === ARRIVAL_ACTION_IDS.wrong) {
      await respond({ replace_original: true, text: 'Marked as the wrong order', blocks: settleBlocks(existing, `✗ <@${clicker}> says this isn’t the right order — nothing was written. Mark it in Notion.`) });
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
      await respond({ replace_original: true, text: `${done} items marked arrived`, blocks: settleBlocks(existing, outcome) });
      logger.info(`Arrivals: ${clicker} ${actionId} → ${done} marked, ${already.length} already, ${failed.length} failed.`);
    } catch (err) {
      logger.error(`Arrivals: ${actionId} failed`, err);
      await respond({ response_type: 'ephemeral', replace_original: false, text: '✗ Could not update Notion. Try again, or set Arrived? in Notion.' });
    }
  });
}

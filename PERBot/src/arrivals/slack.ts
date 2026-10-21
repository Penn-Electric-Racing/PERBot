import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { config } from '../config.js';
import { indexNotionUsers, slackUserToNotionId, type Indexed } from '../sponsorship/identity.js';
import { resolveChannelId } from '../sponsorship/jobs/shared.js';
import { logger } from '../utils/logger.js';
import {
  ARRIVAL_ACTION_IDS,
  ARRIVAL_ACTION_RE,
  arrivalDm,
  cardIndex,
  compact,
  decodeValue,
  guessCard,
  isCard,
  leadTimeLine,
  packageKey,
  reminderDm,
  replaceCard,
  settleBlocks,
  settleCard,
  targetIds,
} from './blocks.js';
import { ARRIVED_YES, ArrivalsNotion } from './notion.js';
import { eligibleRows, groupOrders, ordersForVendor, rankOrders } from './orders.js';
import { peopleMap } from './people.js';
import { isImage, loadImages, parentText, processDelivery, slackName, withNames } from './pipeline.js';
import type { ArrivalRow, Extraction } from './types.js';

/**
 * Package arrivals in `ARRIVALS_CHANNEL`. Every human message with a photo (top level or in a
 * thread) runs through `processDelivery`; PERBot replies in the thread only when it has something
 * useful (see blocks.ts:buildReply), and writes Notion only when someone taps a button — only the
 * arrival columns. Other bots (the Copy Center webhook, B11's RFID logger) are ignored.
 *
 * People: replies @-mention the likely order's requesters (named, not pinged, on a vendor-only
 * guess); when rows are marked, each requester gets a DM (not whoever tapped or posted); a card
 * untapped for 4 h DMs them once (see remindStale). Every mark can be undone from the card for 24 h.
 *
 * Corrections: `@PERBot <what's in it>` in a package thread looks again with that text (handleArrivalsMention)
 * instead of searching the docs, and so does a plain reply from whoever just tapped Wrong order with
 * nothing left to offer. Wrong order otherwise swaps the card to the vendor's next open order. Orders
 * rejected in a thread are never offered there again, and a photo whose orders already have a card in
 * its thread gets no second card.
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
/** Thread ts → order keys someone tapped Wrong order on there (the cards carry them too, until settled). */
const rejectedIn = new Map<string, Set<string>>();
/** Thread ts → who just ran out of candidates on Wrong order: their next plain reply there is a correction. */
const awaiting = new Map<string, { user: string; until: number }>();
const AWAIT_MS = 30 * 60_000;

/** Keep the dedupe memory bounded: drop the oldest entry past 500. */
function cap(coll: Set<string> | Map<string, unknown>): void {
  if (coll.size > 500) coll.delete(coll.keys().next().value!);
}

function reject(threadTs: string, keys: string[]): void {
  const set = rejectedIn.get(threadTs) ?? new Set<string>();
  for (const k of keys) set.add(k);
  rejectedIn.set(threadTs, set);
  cap(rejectedIn);
}

/**
 * What PERBot's cards in a thread already cover: `carded` = orders with a card (open or marked),
 * `rejected` = orders tapped Wrong order on. Read from the cards' button values plus memory.
 */
export function threadOrders(messages: any[], bot: string | null, remembered: Iterable<string> = []): { carded: Set<string>; rejected: Set<string> } {
  const carded = new Set<string>();
  const rejected = new Set<string>(remembered);
  for (const m of messages) {
    if (!bot || m?.bot_id !== bot) continue;
    for (const b of m.blocks ?? []) {
      if (cardIndex(b?.block_id) === null) continue;
      for (const el of b.elements ?? []) {
        const v = decodeValue(el?.value);
        if (v?.k) carded.add(v.k);
        for (const k of v?.n ?? []) rejected.add(k);
      }
    }
  }
  for (const k of rejected) carded.delete(k);
  return { carded, rejected };
}

async function threadMessages(client: WebClient, channel: string, threadTs: string): Promise<any[]> {
  try {
    return ((await client.conversations.replies({ channel, ts: threadTs, limit: 200 })) as any).messages ?? [];
  } catch (err) {
    logger.warn(`Arrivals: could not read thread ${threadTs}`, err);
    return [];
  }
}

/**
 * `opts.correction`: re-run `event` (the photo) with `opts.text` — what someone said is in the box —
 * replacing the photo's own message as the evidence.
 */
export async function handlePhoto(client: WebClient, event: any, opts: { correction?: boolean; text?: string; photoText?: string } = {}): Promise<void> {
  const threadTs = event.thread_ts ?? event.ts;
  const inThread = Boolean(event.thread_ts && event.thread_ts !== event.ts);
  const reply = (text: string, blocks?: any[]) =>
    client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text, ...(blocks ? { blocks } : {}), unfurl_links: false });

  try {
    const images = await loadImages(client, event.files);
    if (images.length === 0) return;
    const [text, parent, openRows, people, thread, ids] = await Promise.all([
      withNames(client, opts.text ?? event.text ?? ''),
      inThread || opts.correction ? parentText(client, event.channel, threadTs) : Promise.resolve(undefined),
      notion.openRows(),
      peopleMap(client, notion),
      inThread || opts.correction ? threadMessages(client, event.channel, threadTs) : Promise.resolve([]),
      ownIds(client),
    ]);
    const { carded, rejected } = threadOrders(thread, ids.bot, rejectedIn.get(threadTs));
    const { scan, resolutions, reply: answer } = await processDelivery(
      {
        ts: event.ts,
        user: event.user,
        text,
        // A correction is about the photo: its own message is the context, the correction the evidence.
        parentText: opts.correction ? [parent, opts.photoText].filter(Boolean).join('\n') || undefined : parent,
        inThread,
        images,
        people,
        rejected,
        carded: opts.correction ? new Set() : carded,
        correction: opts.correction,
      },
      openRows
    );
    logger.info(
      `Arrivals: ${event.ts} scene=${scan.scene} legible=${scan.legible} packages=${scan.packages.length} ` +
        `→ ${resolutions.map((r) => r.kind).join(',') || '-'} reply=${answer ? 'yes' : 'silent'}`
    );
    if (!answer) return;

    const isNudge = !answer.blocks.some((b) => b.type === 'actions');
    if (isNudge && nudged.has(threadTs) && !opts.correction) return;

    // A second photo of a box we already answered for: point at that reply instead.
    const keys = scan.packages.map(packageKey).filter((k): k is string => !!k);
    const earlier = keys.map((k) => packages.get(k)).find(Boolean);
    if (earlier && keys.every((k) => packages.has(k)) && !opts.correction) {
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
    // Stay quiet in threads (most thread photos are banter); a top-level failure or an asked-for look gets one line.
    if (!inThread || opts.correction) await reply(':warning: I couldn’t process that photo. Mark the order in Notion for now; the error is in the Render logs.').catch(() => undefined);
  }
}

// --- Corrections --------------------------------------------------------------------------------

/** Look again at the thread's latest photo (at or before the correction) with `text` as the evidence. False: no photo there. */
async function correct(client: WebClient, event: any, text: string): Promise<boolean> {
  const threadTs = event.thread_ts as string;
  const thread = await threadMessages(client, event.channel, threadTs);
  const photo = [...thread].reverse().find((m) => isPhotoPost(m) && Number(m.ts) <= Number(event.ts));
  if (!photo) return false;
  // A photo posted as a reply has its own message; the thread's first message comes in as the parent.
  const photoText = photo.ts !== threadTs && photo.text ? await withNames(client, photo.text) : undefined;
  logger.info(`Arrivals: looking again at ${photo.ts} with "${text.slice(0, 80)}"`);
  await handlePhoto(client, { ...photo, channel: event.channel, thread_ts: threadTs }, { correction: true, text, photoText });
  return true;
}

/**
 * `@PERBot <what's in it>` in a package thread: look again at that thread's photo with the text,
 * rather than the docs search the mention would otherwise run (10/19: "no, elijah cooling fittings
 * are in this picture" got a page of cooling-loop meeting notes). True when handled here.
 */
export async function handleArrivalsMention(client: WebClient, event: any, botUserId?: string): Promise<boolean> {
  if (!event?.thread_ts) return false;
  const arrivals = await arrivalsChannelId(client).catch(() => null);
  if (!arrivals || event.channel !== arrivals) return false;
  // A mention with a photo: the photo listener reads it, message text included.
  if (Array.isArray(event.files) && event.files.some(isImage)) return true;
  const text = String(event.text ?? '')
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (m: string, id: string) => (id === botUserId ? ' ' : m))
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return false;
  awaiting.delete(event.thread_ts);
  return correct(client, event, text);
}

/** A plain reply from whoever just ran out of candidates on Wrong order (see `awaiting`). */
function awaitedReply(e: any): boolean {
  if (e?.bot_id || !e?.user || e?.subtype || !e?.thread_ts || !e?.text) return false;
  const w = awaiting.get(e.thread_ts);
  if (!w || w.user !== e.user) return false;
  if (w.until < Date.now()) {
    awaiting.delete(e.thread_ts);
    return false;
  }
  return true;
}

// --- Catch-up sweep ---------------------------------------------------------------------------
// Socket Mode drops events while the bot is down (deploys, restarts) or reconnecting, and a missed
// photo never gets another event. So at startup and every 15 minutes, re-read the channel's recent
// photo posts and handle any PERBot hasn't answered — the listener's own `seen` set keeps a photo
// from being handled twice in one process.

const SWEEP_WINDOW_MS = 36 * 3_600_000;
const SWEEP_EVERY_MS = 15 * 60_000;
/** Leave fresh posts to the live listener (its event may still be in flight). */
const SWEEP_MIN_AGE_MS = 2 * 60_000;

let ownIdsP: Promise<{ bot: string | null; user: string | null }> | null = null;
/** PERBot's bot id (on its messages) and user id (in its @-mentions). */
function ownIds(client: WebClient): Promise<{ bot: string | null; user: string | null }> {
  if (!ownIdsP) {
    ownIdsP = client.auth.test().then(
      (r: any) => ({ bot: (r?.bot_id as string) ?? null, user: (r?.user_id as string) ?? null }),
      () => {
        ownIdsP = null;
        return { bot: null, user: null };
      }
    );
  }
  return ownIdsP;
}
async function botId(client: WebClient): Promise<string | null> {
  return (await ownIds(client)).bot;
}

/** A human photo post. */
export function isPhotoPost(m: any): boolean {
  return !m?.bot_id && !!m?.user && m?.subtype !== 'message_changed' && Array.isArray(m?.files) && m.files.some(isImage);
}

/** PERBot already replied in the photo's thread after it was posted. */
export function alreadyAnswered(photo: any, threadMessages: any[], bot: string | null): boolean {
  return !!bot && threadMessages.some((m) => m?.bot_id === bot && Number(m.ts) > Number(photo.ts));
}

/** Photo posts since `oldest` (top level, and replies in those threads) with each one's thread. */
export async function recentPhotoPosts(client: WebClient, channel: string, oldest: string): Promise<{ msg: any; thread: any[] }[]> {
  const top: any[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await client.conversations.history({ channel, oldest, limit: 200, cursor });
    top.push(...(res.messages ?? []));
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const out: { msg: any; thread: any[] }[] = [];
  for (const m of top) {
    const thread: any[] = m.reply_count ? ((await client.conversations.replies({ channel, ts: m.ts, limit: 200 })) as any).messages ?? [m] : [m];
    for (const t of thread) if (isPhotoPost(t) && Number(t.ts) >= Number(oldest)) out.push({ msg: t, thread });
  }
  return out.sort((a, b) => Number(a.msg.ts) - Number(b.msg.ts));
}

let sweeping = false;
async function sweep(client: WebClient): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const channel = await arrivalsChannelId(client);
    if (!channel) return;
    const bot = await botId(client);
    const oldest = ((Date.now() - SWEEP_WINDOW_MS) / 1000).toFixed(6);
    const freshCutoff = (Date.now() - SWEEP_MIN_AGE_MS) / 1000;
    const posts = await recentPhotoPosts(client, channel, oldest);
    for (const { msg, thread } of posts) {
      const id = `${channel}:${msg.ts}`;
      if (seen.has(id) || Number(msg.ts) > freshCutoff) continue;
      seen.add(id);
      cap(seen);
      if (alreadyAnswered(msg, thread, bot)) continue;
      logger.info(`Arrivals: catching up on a missed photo ${msg.ts}`);
      await handlePhoto(client, { ...msg, channel });
    }
    await remindStale(client, channel, posts.map((p) => p.thread), bot);
  } catch (err) {
    logger.warn('Arrivals: catch-up sweep failed', err);
  } finally {
    sweeping = false;
  }
}

// --- Reminders -----------------------------------------------------------------------------------
// A card nobody tapped for 4 hours: DM its order's requesters once (9am–10pm Eastern), and note it on
// the card — the note doubles as the "already reminded" marker, so restarts don't re-send.

const REMIND_AFTER_MS = 4 * 3_600_000;

function waking(now = new Date()): boolean {
  const hour = Number(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }));
  return hour >= 9 && hour < 22;
}

/** Insert `block` right after the block with `afterId`. */
function insertAfter(blocks: any[], afterId: string, block: any): any[] {
  const i = blocks.findIndex((b) => b?.block_id === afterId);
  return i < 0 ? [...blocks, block] : [...blocks.slice(0, i + 1), block, ...blocks.slice(i + 1)];
}

async function remindStale(client: WebClient, channel: string, threads: any[][], bot: string | null): Promise<void> {
  if (!bot || !waking()) return;
  const cutoff = (Date.now() - REMIND_AFTER_MS) / 1000;
  const replies = new Map<string, any>();
  for (const thread of threads) for (const m of thread) if (m?.bot_id === bot && Number(m.ts) < cutoff && Array.isArray(m.blocks)) replies.set(m.ts, m);

  let open: ArrivalRow[] | null = null;
  let people: Map<string, string> | null = null;
  for (const m of replies.values()) {
    let blocks: any[] = m.blocks;
    for (const b of m.blocks as any[]) {
      const index = cardIndex(b?.block_id);
      if (index === null || b.block_id !== `arrival_actions:${index}` || !isCard(blocks, index)) continue;
      if (blocks.some((x) => x?.block_id === `arrival_reminded:${index}`)) continue;
      const key = (b.elements ?? []).map((el: any) => decodeValue(el?.value)?.k).find(Boolean);
      if (!key) continue;
      open ??= await notion.openRows();
      people ??= await peopleMap(client, notion);
      const order = groupOrders(open).find((o) => o.key === key);
      if (!order) continue; // marked in Notion meanwhile
      const targets = [...new Set(order.rows.flatMap((r) => r.pointOfContact).map((n) => people!.get(n)).filter((id): id is string => !!id))].slice(0, 3);
      const link = await client.chat.getPermalink({ channel, message_ts: m.ts }).then((r: any) => (r?.permalink as string) ?? null, () => null);
      for (const target of targets) {
        await client.chat.postMessage({ channel: target, text: reminderDm(order, link), unfurl_links: false }).catch((err) => logger.warn(`Arrivals: reminder DM to ${target} failed`, err));
      }
      const note = targets.length
        ? `:bell: Reminded ${targets.map((t) => `<@${t}>`).join(', ')} by DM`
        : ':bell: Still unconfirmed — mark it in Notion if it’s ours';
      blocks = insertAfter(blocks, b.block_id, { type: 'context', block_id: `arrival_reminded:${index}`, elements: [{ type: 'mrkdwn', text: note }] });
      logger.info(`Arrivals: reminded ${targets.length} requester(s) about ${m.ts} card ${index}.`);
    }
    if (blocks !== m.blocks) await client.chat.update({ channel, ts: m.ts, text: m.text ?? 'Package arrived', blocks }).catch((err) => logger.warn('Arrivals: could not note the reminder', err));
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

const UNDO_WINDOW_S = 24 * 3600;
const NO_PACKAGE: Extraction = { vendor: null, addressee: null, shipDate: null, orderNumbers: [], trackingNumbers: [], lines: [], itemHints: [] };

/** The `{u, ts}` a card's buttons carry (every card has a Wrong order button). */
function cardBase(blocks: any[], index: number): { u: string; ts: string } | null {
  const actions = blocks.find((b) => b?.block_id === `arrival_actions:${index}`);
  for (const el of actions?.elements ?? []) {
    const v = decodeValue(el?.value);
    if (v) return { u: v.u, ts: v.ts };
  }
  return null;
}

/**
 * A fresh card for order `key`, as of the photo: its open rows plus `restored` (rows an Undo just
 * reopened — the Notion query can lag the write by a moment), the vendor's other orders as the select.
 */
async function cardForOrder(index: number, key: string, base: { u: string; ts: string }, lead: string, restored: ArrivalRow[] = [], rejected: string[] = []): Promise<any[] | null> {
  const asOf = new Date(Number(base.ts) * 1000);
  const open = await notion.openRows();
  const byId = new Map(open.map((r) => [r.id, r]));
  for (const r of restored) byId.set(r.id, r);
  const orders = groupOrders(eligibleRows([...byId.values()], asOf));
  const order = orders.find((o) => o.key === key);
  if (!order) return null;
  const others = ordersForVendor(orders, order.vendor).filter((o) => o !== order && !rejected.includes(o.key));
  // Only who/when carries over from the tapped button — not its undo rows or rejections.
  return guessCard(index, order, rankOrders(others, NO_PACKAGE, asOf), order.vendor, { u: base.u, ts: base.ts }, lead, rejected);
}

/** The order keys in card `index`'s "Other … orders" select, in the order shown. */
function selectKeys(blocks: any[], index: number): string[] {
  const actions = blocks.find((b) => b?.block_id === `arrival_actions:${index}`);
  const select = (actions?.elements ?? []).find((el: any) => el?.action_id === ARRIVAL_ACTION_IDS.other);
  return (select?.options ?? []).map((o: any) => String(o?.value ?? '')).filter(Boolean);
}

/** DM each requester whose rows were just marked (not the person who tapped, nor the one who posted the photo). */
async function dmRequesters(client: WebClient, rows: ArrivalRow[], ctx: { clicker: string; poster: string; permalink: string | null; arrivedAtIso: string }): Promise<void> {
  const people = await peopleMap(client, notion);
  const byPerson = new Map<string, ArrivalRow[]>();
  for (const row of rows) {
    for (const name of row.pointOfContact) {
      const slackId = people.get(name);
      if (!slackId || slackId === ctx.clicker || slackId === ctx.poster) continue;
      byPerson.set(slackId, [...(byPerson.get(slackId) ?? []), row]);
    }
  }
  for (const [slackId, theirs] of byPerson) {
    await client.chat
      .postMessage({ channel: slackId, text: arrivalDm(theirs, ctx), unfurl_links: false })
      .catch((err) => logger.warn(`Arrivals: could not DM ${slackId}`, err));
  }
}

export function registerArrivals(app: App): void {
  if (!config.arrivals.channel) {
    logger.info('Arrivals: ARRIVALS_CHANNEL unset; delivery-photo listener disabled.');
    return;
  }

  logger.info(`Arrivals: listening for delivery photos in "${config.arrivals.channel}".`);
  setTimeout(() => void sweep(app.client), 30_000);
  setInterval(() => void sweep(app.client), SWEEP_EVERY_MS);

  app.event('message', async ({ event, client }) => {
    const e = event as any;
    const photo = isPhotoPost(e);
    if (!photo && !awaitedReply(e)) return;
    const arrivals = await arrivalsChannelId(client).catch((err) => {
      logger.error('Arrivals: could not resolve the channel', err);
      return null;
    });
    if (e.channel !== arrivals) return;
    const id = `${e.channel}:${e.ts}`;
    if (seen.has(id)) return;
    seen.add(id);
    cap(seen);
    if (photo) return void (await handlePhoto(client, e));
    const me = (await ownIds(client)).user;
    if (me && String(e.text).includes(`<@${me}`)) return; // the mention handler has it
    awaiting.delete(e.thread_ts);
    await correct(client, e, String(e.text)).catch((err) => logger.error('Arrivals: correction failed', err));
  });

  app.action(ARRIVAL_ACTION_RE, async ({ ack, body, action, respond, client }) => {
    await ack();
    const a = action as any;
    const actionId = a?.action_id as string;
    // A checkbox toggled: its state rides along with the next button tap.
    if (actionId === ARRIVAL_ACTION_IDS.items) return;
    const blockId = a?.block_id as string;
    const clicker = (body as any)?.user?.id as string | undefined;
    const channel = (body as any)?.channel?.id as string | undefined;
    const message = (body as any)?.message;
    const existing: any[] = message?.blocks ?? [];
    if (!clicker || !channel) return;
    const index = cardIndex(blockId);
    const card = index !== null && isCard(existing, index);
    const replace = (blocks: any[], text = message?.text ?? 'Package arrived') => respond({ replace_original: true, text, blocks });
    const whisper = (text: string) => respond({ response_type: 'ephemeral', replace_original: false, text });

    try {
      // "Other <vendor> orders…": swap this card for the picked order.
      if (actionId === ARRIVAL_ACTION_IDS.other) {
        const key = a?.selected_option?.value as string | undefined;
        const base = index !== null ? cardBase(existing, index) : null;
        if (!key || !base || index === null) return;
        const rejected = (existing.find((b) => b?.block_id === `arrival_actions:${index}`)?.elements ?? [])
          .map((el: any) => decodeValue(el?.value)?.n ?? [])
          .flat();
        const next = await cardForOrder(index, key, base, `↪️ <@${clicker}> switched orders.`, [], rejected);
        if (!next) return void (await whisper('That order isn’t open anymore — someone may have just marked it. Check Notion.'));
        await replace(replaceCard(existing, index, next));
        return;
      }

      const value = decodeValue(a?.value);
      if (!value) return;

      if (actionId === ARRIVAL_ACTION_IDS.undo) {
        if (value.t && Date.now() / 1000 - value.t > UNDO_WINDOW_S) return void (await whisper('Too late to undo here — fix it in Notion.'));
        const ready = new Set(value.p ?? []);
        const restored: ArrivalRow[] = [];
        for (const id of value.r ?? []) {
          const previous = ready.has(id) ? 'Ready for Pickup' : 'No';
          await notion.unmarkArrived(id, previous);
          restored.push({ ...(await notion.fetchRow(id)), arrived: previous });
        }
        const lead = `↩️ <@${clicker}> undid that — ${restored.length} item${restored.length === 1 ? '' : 's'} back to not arrived. `;
        const next = index !== null && value.k ? await cardForOrder(index, value.k, value, lead, restored) : null;
        await replace(next && index !== null ? replaceCard(existing, index, next) : settleCard(existing, index ?? 0, lead.trim()));
        logger.info(`Arrivals: ${clicker} undid ${restored.length} rows.`);
        return;
      }

      if (actionId === ARRIVAL_ACTION_IDS.wrong) {
        // Never a dead end: swap to the vendor's next open order not yet rejected; with none left, ask what's inside.
        const threadTs = message?.thread_ts ?? message?.ts;
        const rejected = [...new Set([...(value.n ?? []), ...(value.k ? [value.k] : [])])];
        if (threadTs) reject(threadTs, rejected);
        if (card && index !== null) {
          for (const key of selectKeys(existing, index).filter((k) => !rejected.includes(k))) {
            const next = await cardForOrder(index, key, value, `✗ <@${clicker}>: not that one — nothing was written.`, [], rejected);
            if (next) return void (await replace(replaceCard(existing, index, next), 'Not that order'));
          }
        }
        const text = `✗ <@${clicker}>: not this order — nothing was written. Reply here with what’s in the box (or who it’s for) and I’ll look again, or mark it in Notion.`;
        if (threadTs) {
          awaiting.set(threadTs, { user: clicker, until: Date.now() + AWAIT_MS });
          cap(awaiting);
        }
        await replace(card ? settleCard(existing, index!, text) : settleBlocks(existing, blockId, text), 'Not this order');
        return;
      }

      // Mark arrived: the ticked checkboxes. Legacy/whole-set buttons: the ids in the value.
      let ids: string[];
      let runRows: ArrivalRow[] = [];
      if (actionId === ARRIVAL_ACTION_IDS.mark) {
        const state = (body as any)?.state?.values?.[`arrival_items:${index}`]?.[ARRIVAL_ACTION_IDS.items];
        // No state for an untouched box group: fall back to what the card pre-ticked.
        const shownTicks = existing.find((b) => b?.block_id === `arrival_items:${index}`)?.elements?.[0]?.initial_options;
        ids = ((state ? state.selected_options : shownTicks) ?? []).map((o: any) => String(o.value));
        if (!ids.length) return void (await whisper('Tick the items that arrived, then tap *Mark arrived*.'));
      } else {
        runRows = value.g ? await notion.rowsForRun(value.g) : [];
        ids = targetIds(value, runRows.map((r) => r.id));
      }
      const rows = await rowsFor(ids, runRows);
      const already = rows.filter((r) => r.arrived === ARRIVED_YES);
      const todo = rows.filter((r) => r.arrived !== ARRIVED_YES);

      const arrivedAt = new Date(Number(value.ts) * 1000).toISOString();
      const [receivedBy, receivedByName, permalink] = await Promise.all([
        receiverNotionId(client, value.u),
        slackName(client, value.u).then((n) => (n === value.u ? null : n), () => null),
        client.chat.getPermalink({ channel, message_ts: value.ts }).then((r: any) => (r?.permalink as string) ?? null, () => null),
      ]);

      const marked: ArrivalRow[] = [];
      const failed: ArrivalRow[] = [];
      for (const row of todo) {
        try {
          await notion.markArrived(row.id, { arrivedAt, receivedByNotionId: receivedBy, receivedByName, photoUrl: permalink });
          marked.push(row);
        } catch (err) {
          logger.error(`Arrivals: write failed for ${row.id}`, err);
          failed.push(row);
        }
      }

      const done = marked.length;
      const parts = [`✅ <@${clicker}> marked *${done}* item${done === 1 ? '' : 's'} arrived (received by <@${value.u}>)`];
      if (already.length) parts.push(`${already.length} already marked`);
      if (failed.length) parts.push(`⚠️ ${failed.length} failed — set Arrived? in Notion`);
      const lead = leadTimeLine(rows, arrivedAt);
      const outcome = parts.join(' · ') + (lead ? `\n${lead}` : '');

      if (card) {
        const undo = done
          ? {
              u: value.u,
              ts: value.ts,
              r: marked.map((r) => compact(r.id)),
              p: marked.filter((r) => r.arrived === 'Ready for Pickup').map((r) => compact(r.id)),
              ...(value.k ? { k: value.k } : {}),
              t: Math.floor(Date.now() / 1000),
            }
          : null;
        await replace(settleCard(existing, index!, outcome, marked, undo), `${done} items marked arrived`);
      } else {
        const chosen = actionId.match(/^arrival_order:(\d+)$/);
        await replace(settleBlocks(existing, blockId, outcome, chosen ? Number(chosen[1]) : undefined), `${done} items marked arrived`);
      }
      logger.info(`Arrivals: ${clicker} ${actionId} → ${done} marked, ${already.length} already, ${failed.length} failed.`);
      if (done) await dmRequesters(client, marked, { clicker, poster: value.u, permalink, arrivedAtIso: arrivedAt });
    } catch (err) {
      logger.error(`Arrivals: ${actionId} failed`, err);
      await whisper('✗ Could not update Notion. Try again, or set Arrived? in Notion.');
    }
  });
}

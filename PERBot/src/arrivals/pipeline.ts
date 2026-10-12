import type { WebClient } from '@slack/web-api';
import { config } from '../config.js';
import { buildReply, type People, type Reply } from './blocks.js';
import { scanPhotos, type SlipImage } from './extract.js';
import { resolveScan, type Picker } from './resolve.js';
import type { ArrivalRow, Resolution, Scan } from './types.js';

/**
 * One Slack message with photos → scan → resolutions → reply (or silence). Shared by the live
 * listener (slack.ts) and the read-only backtest (cli.ts), so the backtest exercises exactly the
 * code that runs in the channel.
 */

/** OpenAI accepts these directly; anything else (HEIC from iPhones) goes via Slack's JPEG thumbnail. */
const DIRECT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_IMAGES = 4;

export interface DeliveryMessage {
  ts: string;
  user: string;
  /** Message text with Slack mentions replaced by names. */
  text: string;
  /** The thread's first message (names resolved), when this is a reply. */
  parentText?: string;
  inThread: boolean;
  images: SlipImage[];
  /** Requesters → Slack ids, so the reply can @-mention them. */
  people?: People;
}

export interface DeliveryResult {
  scan: Scan;
  resolutions: Resolution[];
  reply: Reply | null;
}

export async function processDelivery(msg: DeliveryMessage, openRows: ArrivalRow[], picker?: Picker): Promise<DeliveryResult> {
  const scan = await scanPhotos(msg.images, { text: msg.text, parentText: msg.parentText });
  const resolutions = await resolveScan(scan, openRows, new Date(Number(msg.ts) * 1000), [msg.parentText, msg.text].filter(Boolean).join('\n'), picker);
  return { scan, resolutions, reply: buildReply(scan, resolutions, { u: msg.user, ts: msg.ts, inThread: msg.inThread, text: msg.text, people: msg.people }) };
}

// --- Slack plumbing shared by the listener and the backtest -----------------------------------

export function isImage(file: any): boolean {
  return String(file?.mimetype ?? '').startsWith('image/');
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

export async function loadImages(client: WebClient, files: any[]): Promise<SlipImage[]> {
  const images: SlipImage[] = [];
  for (let file of files.filter(isImage).slice(0, MAX_IMAGES)) {
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

const names = new Map<string, string>();

/** "<@U07M54CLKNY> cooling tube is here" → "@Elijah Jeoung cooling tube is here" — owners are evidence. */
export async function withNames(client: WebClient, text: string): Promise<string> {
  const ids = [...new Set([...text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!))];
  for (const id of ids) {
    if (names.has(id)) continue;
    try {
      const info: any = await client.users.info({ user: id });
      names.set(id, info.user?.real_name || info.user?.profile?.real_name || info.user?.name || id);
    } catch {
      names.set(id, id);
    }
  }
  return text.replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id: string) => `@${names.get(id) ?? id}`);
}

/** The thread's first message text (names resolved), or undefined. */
export async function parentText(client: WebClient, channel: string, threadTs: string): Promise<string | undefined> {
  try {
    const res: any = await client.conversations.replies({ channel, ts: threadTs, limit: 1 });
    const text = res.messages?.[0]?.text;
    return text ? await withNames(client, text) : undefined;
  } catch {
    return undefined;
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { WebClient } from '@slack/web-api';
import { config } from '../config.js';
import { resolveChannelId } from '../sponsorship/jobs/shared.js';
import type { Reply } from './blocks.js';
import { ArrivalsNotion } from './notion.js';
import { isImage, loadImages, processDelivery, withNames, type DeliveryMessage, type DeliveryResult } from './pipeline.js';
import type { ArrivalRow } from './types.js';

/**
 * Read-only runs of the arrivals pipeline. Reads Slack + Notion, calls the vision model, posts
 * and writes nothing. Prices are never printed (never extracted).
 *
 *   npm run arrivals:try -- slip.jpg [more.jpg] [--text "Jlc picked up"]   one message (files = one post)
 *   npm run arrivals:try -- --each ./photos                                 every image as its own post
 *   npm run arrivals:backtest -- [--limit 30]                               replay ARRIVALS_CHANNEL's history:
 *       every human photo (threads too), matched against orders as of when it was posted, printing
 *       what PERBot would have replied — or that it would have stayed silent.
 */

const TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
}

/** Block Kit → plain text for the terminal. */
function render(reply: Reply | null): string {
  if (!reply) return '  (silent)';
  return reply.blocks
    .map((b) => {
      if (b.type === 'section') return b.text.text;
      if (b.type === 'context') return `  ${b.elements.map((e: any) => e.text).join(' ')}`;
      if (b.type === 'actions') return `  [${b.elements.map((e: any) => e.text.text).join('] [')}]`;
      return b.type === 'divider' ? '  ---' : '';
    })
    .join('\n')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
}

function summarize(label: string, { scan, resolutions, reply }: DeliveryResult, seconds: number): void {
  console.log(`=== ${label}  (${seconds.toFixed(1)}s)`);
  console.log(`scene: ${scan.scene} · legible: ${scan.legible ? 'yes' : 'NO'} · packages: ${scan.packages.length}`);
  scan.packages.forEach((p, i) => {
    const bits = [
      `vendor=${p.vendor ?? '?'}`,
      p.addressee ? `to=${p.addressee}` : '',
      p.shipDate ? `shipped=${p.shipDate}` : '',
      p.orderNumbers.length ? `#=${p.orderNumbers.map((o) => o.value).join(',')}` : '',
      p.lines.length ? `lines=${p.lines.length}` : '',
      p.itemHints.length ? `hints=${p.itemHints.join('; ')}` : '',
    ].filter(Boolean);
    console.log(`  pkg ${i + 1}: ${bits.join(' · ')} → ${resolutions[i]?.kind ?? '-'}`);
  });
  console.log(render(reply));
  console.log('');
}

async function tryLocal(args: string[], openRows: ArrivalRow[]): Promise<void> {
  const text = flag(args, '--text') ?? '';
  const each = args.includes('--each');
  const targets = args.filter((a) => a !== '--each');
  if (targets.length === 0) throw new Error('Usage: npm run arrivals:try -- [--each] <image|folder> [...] [--text "message"]');
  const files: string[] = [];
  for (const t of targets) {
    const stat = await fs.stat(t);
    if (!stat.isDirectory()) files.push(t);
    else files.push(...(await fs.readdir(t)).filter((n) => TYPES[path.extname(n).toLowerCase()]).sort().map((n) => path.join(t, n)));
  }
  for (const pkg of each ? files.map((f) => [f]) : [files]) {
    const images = await Promise.all(pkg.map(async (f) => ({ data: await fs.readFile(f), mimeType: TYPES[path.extname(f).toLowerCase()] ?? 'image/jpeg' })));
    const started = Date.now();
    const msg: DeliveryMessage = { ts: String(Date.now() / 1000), user: 'U_LOCAL', text, inThread: false, images };
    summarize(pkg.map((f) => path.basename(f)).join(' + '), await processDelivery(msg, openRows), (Date.now() - started) / 1000);
  }
}

async function backtest(args: string[], openRows: ArrivalRow[]): Promise<void> {
  const limit = Number(flag(args, '--limit') ?? 50);
  const client = new WebClient(config.slack.botToken);
  const channel = await resolveChannelId(client, config.arrivals.channel || 'packages');
  if (!channel) throw new Error('ARRIVALS_CHANNEL not found');

  const top: any[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await client.conversations.history({ channel, limit: 200, cursor });
    top.push(...(res.messages ?? []));
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const posts: { msg: any; parent?: any }[] = [];
  for (const m of top) {
    posts.push({ msg: m });
    if (m.reply_count) {
      const res: any = await client.conversations.replies({ channel, ts: m.ts, limit: 200 });
      for (const r of (res.messages ?? []).slice(1)) posts.push({ msg: r, parent: m });
    }
  }
  const photos = posts.filter(({ msg }) => !msg.bot_id && msg.user && (msg.files ?? []).some(isImage)).sort((a, b) => Number(a.msg.ts) - Number(b.msg.ts)).slice(-limit);
  console.log(`${photos.length} human photo posts in #${config.arrivals.channel || 'packages'} (Slack keeps ~90 days).\n`);

  const tally: Record<string, number> = {};
  for (const { msg, parent } of photos) {
    const started = Date.now();
    const result = await processDelivery(
      {
        ts: msg.ts,
        user: msg.user,
        text: await withNames(client, msg.text ?? ''),
        parentText: parent ? await withNames(client, parent.text ?? '') : undefined,
        inThread: Boolean(parent),
        images: await loadImages(client, msg.files),
      },
      openRows
    );
    const outcome = !result.reply ? 'silent' : result.reply.blocks.some((b) => b.type === 'actions') ? 'buttons' : 'nudge';
    tally[outcome] = (tally[outcome] ?? 0) + 1;
    const when = new Date(Number(msg.ts) * 1000).toISOString().slice(0, 10);
    summarize(`${when} ${parent ? '(thread) ' : ''}${JSON.stringify((msg.text ?? '').slice(0, 60))}`, result, (Date.now() - started) / 1000);
  }
  console.log('Outcomes:', JSON.stringify(tally));
}

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  const openRows = await new ArrivalsNotion().openRows();
  console.log(`${openRows.length} open Purchasing rows.\n`);
  if (mode === 'backtest') await backtest(args, openRows);
  else await tryLocal(args, openRows);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

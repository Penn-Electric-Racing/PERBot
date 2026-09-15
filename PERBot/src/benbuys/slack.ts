import type { App, RespondFn } from '@slack/bolt';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { DEFAULT_VENDOR, LIVE_VENDORS, isVendorKey, resolveAdapter } from './adapters/index.js';
import { PrepCache } from './cache.js';
import { buildRequisitionEmail, renderEmail } from './email.js';
import { createMailer, type Mailer } from './mailer.js';
import { PurchasingNotion } from './notion.js';
import { buildPrep, formatPrep, money } from './prep.js';
import type { VendorAdapter } from './types.js';

/**
 * `/benbuys prep [vendor]` and `/benbuys done <req#> <total> [--no-send]`.
 * All replies are ephemeral. Vendor defaults to digikey.
 */

export type ParsedBenbuys =
  | { kind: 'help' }
  | { kind: 'prep'; vendor: string }
  | { kind: 'done'; vendor: string; requisition: string; total: number; dryRun: boolean; error?: string };

export const REQUISITION_RE = /^\d{6,8}$/;

/** "$1,234.50" · "1234.5" · "402" → number, or null. */
export function parseMoney(raw: string): number | null {
  const cleaned = raw.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return n > 0 ? n : null;
}

export function parseBenbuys(text: string): ParsedBenbuys {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const sub = (tokens.shift() ?? '').toLowerCase();
  const dryRun = tokens.some((t) => /^--?(no-send|dry-run)$/i.test(t));
  const args = tokens.filter((t) => !/^--?(no-send|dry-run)$/i.test(t));
  let vendor = DEFAULT_VENDOR;
  const vendorIdx = args.findIndex((t) => isVendorKey(t));
  if (vendorIdx >= 0) vendor = args.splice(vendorIdx, 1)[0]!.toLowerCase();

  if (sub === 'prep') return { kind: 'prep', vendor };
  if (sub === 'done') {
    const [req = '', totalRaw = ''] = args;
    const total = parseMoney(totalRaw);
    const base = { kind: 'done' as const, vendor, requisition: req, total: total ?? 0, dryRun };
    if (!REQUISITION_RE.test(req)) return { ...base, error: `Requisition number should be 6–8 digits (got "${req || 'nothing'}").` };
    if (total === null) return { ...base, error: `Total should be a positive dollar amount like 402.02 (got "${totalRaw || 'nothing'}").` };
    return base;
  }
  return { kind: 'help' };
}

export const USAGE = [
  '*BenBuys ordering helper*',
  `• \`/benbuys prep [vendor]\` — cart paste block + BEN fields + estimated total from the ready, un-exported Notion rows (vendors: ${LIVE_VENDORS.join(', ')}; default ${DEFAULT_VENDOR}).`,
  '• `/benbuys done <requisition#> <BEN total>` — after Submit on BEN: sends the requisition email and marks the prepped rows ordered in Notion. Add `--no-send` to preview without sending or writing.',
].join('\n');

function fence(text: string): string {
  return '```\n' + text.replace(/```/g, "'''") + '\n```';
}

/** Slack caps a message at ~40k chars; keep each ephemeral reply comfortably under that. */
const MAX_MESSAGE_CHARS = 30_000;

/** Split a code block into several ≤ MAX_MESSAGE_CHARS fenced chunks on line boundaries. */
export function chunkFenced(text: string, max: number = MAX_MESSAGE_CHARS): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of text.split('\n')) {
    if (size + line.length + 1 > max && current.length) {
      chunks.push(fence(current.join('\n')));
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length) chunks.push(fence(current.join('\n')));
  return chunks;
}

export interface BenbuysDeps {
  notion: PurchasingNotion;
  cache: PrepCache;
  mailer: Mailer | null;
}

/** Prep run by this user in the last 24h that was never closed with `done` — the double-order trap. */
function pendingPrepWarning(deps: BenbuysDeps, adapter: VendorAdapter, userId: string): string {
  const pending = deps.cache.get(userId, adapter.key);
  if (!pending) return '';
  const ageMin = Math.max(1, Math.round((Date.now() - pending.createdAt) / 60_000));
  const age = ageMin >= 60 ? `${Math.round(ageMin / 60)}h` : `${ageMin}m`;
  return `⚠️ You prepped ${pending.prep.lines.length} ${adapter.label} lines ${age} ago and never ran \`/benbuys done\`. If you already placed that order, run \`done\` for it FIRST — otherwise those rows are still un-exported and will be ordered again.\n`;
}

export async function handlePrep(deps: BenbuysDeps, adapter: VendorAdapter, userId: string, respond: RespondFn): Promise<void> {
  const pendingWarning = pendingPrepWarning(deps, adapter, userId);
  const { ready, notReady } = await deps.notion.selectRows(adapter);
  const prep = buildPrep(adapter, ready, notReady);
  const blocks = formatPrep(adapter, prep, config.benbuys.approvalThreshold);

  if (prep.lines.length === 0) {
    deps.cache.clear(userId, adapter.key);
    await respond({ response_type: 'ephemeral', text: `${pendingWarning}*${adapter.label} — nothing to order.*\n${blocks.summary}` });
    return;
  }

  deps.cache.set(userId, adapter.key, prep);
  const header = `${pendingWarning}*${adapter.label} order prep* — paste block 1 into the punchout's Bulk Add box, block 2 into BEN Financials.`;
  const cartChunks = chunkFenced(blocks.cart);
  const tail = `${fence(blocks.ben)}\n${blocks.summary}`;
  if (cartChunks.length === 1 && header.length + cartChunks[0]!.length + tail.length < MAX_MESSAGE_CHARS) {
    await respond({ response_type: 'ephemeral', text: `${header}\n${cartChunks[0]}\n${tail}` });
    return;
  }
  await respond({ response_type: 'ephemeral', text: `${header}\n_(cart is long — pasted in ${cartChunks.length} parts, in order)_` });
  for (const [i, chunk] of cartChunks.entries()) {
    await respond({ response_type: 'ephemeral', text: `Part ${i + 1}/${cartChunks.length}\n${chunk}` });
  }
  await respond({ response_type: 'ephemeral', text: tail });
}

export async function handleDone(
  deps: BenbuysDeps,
  adapter: VendorAdapter,
  userId: string,
  parsed: Extract<ParsedBenbuys, { kind: 'done' }>,
  respond: RespondFn
): Promise<void> {
  if (!adapter.operatorSlackIds.includes(userId)) {
    await respond({ response_type: 'ephemeral', text: `Only the ${adapter.label} operator can run \`/benbuys done\`.` });
    return;
  }
  const cached = deps.cache.get(userId, adapter.key);
  if (!cached) {
    await respond({ response_type: 'ephemeral', text: `No \`/benbuys prep ${adapter.key}\` from you in the last 24h — run prep first so I know exactly which rows you ordered.` });
    return;
  }
  const runId = `BENBUYS-${parsed.requisition}`;
  if (await deps.notion.runIdExists(runId)) {
    await respond({ response_type: 'ephemeral', text: `Requisition ${parsed.requisition} is already recorded in Notion (Run ID \`${runId}\`). Nothing sent.` });
    return;
  }

  const prep = cached.prep;
  const email = buildRequisitionEmail(adapter, {
    requisitionNumber: parsed.requisition,
    total: parsed.total,
    lineCount: prep.lines.length,
    from: config.benbuys.from,
    cc: config.benbuys.cc,
    approvalThreshold: config.benbuys.approvalThreshold,
  });
  const flag = email.approvalRequired ? 'APPROVAL REQUIRED' : 'no approval required';

  if (parsed.dryRun) {
    await respond({
      response_type: 'ephemeral',
      text: [
        `*Dry run* — nothing sent, nothing written. Requisition ${parsed.requisition} · $${money(parsed.total)} · ${prep.lines.length} lines · ${flag}.`,
        fence(renderEmail(email)),
        `Would mark ${prep.rows.length} rows ordered (Run ID \`${runId}\`):`,
        prep.rows.map((r) => `• <${r.url}|${r.name || r.partNumber}>`).join('\n'),
      ].join('\n'),
    });
    return;
  }

  if (!deps.mailer) {
    await respond({ response_type: 'ephemeral', text: 'Email sending isn’t configured on this PERBot deploy (set the BENBUYS_MAIL_* env vars). Nothing sent, nothing written — use `--no-send` to preview.' });
    return;
  }

  // Email first, so a Notion failure never loses the email.
  try {
    await deps.mailer.send(email);
  } catch (err) {
    logger.error('BenBuys email send failed', err);
    await respond({ response_type: 'ephemeral', text: `✗ Couldn’t send the requisition email (${err instanceof Error ? err.message : String(err)}). Notion was NOT updated — fix the mail config and run \`done\` again.` });
    return;
  }

  const result = await deps.notion.markOrdered(prep.rows.map((r) => r.id), runId);
  if (result.failed.length === 0) deps.cache.clear(userId, adapter.key);

  const lines = [
    `✅ Requisition ${parsed.requisition} · $${money(parsed.total)} · ${prep.lines.length} lines · ${flag}.`,
    `Email sent to ${email.to.join(', ')} (cc ${email.cc.join(', ')}) — subject: ${email.subject}`,
    `Notion: ${result.updated.length} rows marked ordered (Run ID \`${runId}\`).`,
  ];
  if (result.failed.length) {
    const failedRows = result.failed.map((f) => {
      const row = prep.rows.find((r) => r.id === f.id);
      return `• <${row?.url ?? ''}|${row?.name || f.id}> — ${f.error}`;
    });
    lines.push(`⚠️ ${result.failed.length} rows failed to update (email already sent — fix by hand or re-run \`done\`; the Run ID guard will block until you clear it):\n${failedRows.join('\n')}`);
  }
  await respond({ response_type: 'ephemeral', text: lines.join('\n') });
}

export function registerBenbuysCommand(app: App, deps: BenbuysDeps = { notion: new PurchasingNotion(), cache: new PrepCache(), mailer: createMailer() }): void {
  if (!deps.mailer) logger.warn('BenBuys: no email transport configured — `/benbuys done` will only work with --no-send.');

  app.command('/benbuys', async ({ ack, command, respond }) => {
    await ack();
    const parsed = parseBenbuys(command.text);
    if (parsed.kind === 'help') {
      await respond({ response_type: 'ephemeral', text: USAGE });
      return;
    }
    const adapter = resolveAdapter(parsed.vendor);
    if (!adapter) {
      await respond({ response_type: 'ephemeral', text: `Vendor "${parsed.vendor}" isn’t live yet. Available: ${LIVE_VENDORS.join(', ')}.` });
      return;
    }
    try {
      if (parsed.kind === 'prep') {
        await handlePrep(deps, adapter, command.user_id, respond);
      } else if (parsed.error) {
        await respond({ response_type: 'ephemeral', text: `${parsed.error}\nUsage: \`/benbuys done <requisition#> <BEN total>\`` });
      } else {
        await handleDone(deps, adapter, command.user_id, parsed, respond);
      }
    } catch (err) {
      logger.error(`/benbuys ${parsed.kind} failed`, err);
      await respond({ response_type: 'ephemeral', text: `✗ /benbuys ${parsed.kind} hit an error: ${err instanceof Error ? err.message : String(err)}. Check the PERBot logs.` });
    }
  });
}

import type { App, RespondArguments, RespondFn } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { indexNotionUsers, slackUserToNotionId, type Indexed } from '../sponsorship/identity.js';
import { logger } from '../utils/logger.js';
import { findParts, type FindOptions, type FindResult } from './finder.js';
import { createPartsLlm, type JsonLlm } from './llm.js';
import { PartsNotion } from './notion.js';
import { makeWeights, Scorer } from './rank.js';
import type { Candidate, RankMode } from './types.js';

/**
 * `/parts <part> [-q N] [--cheapest]` — the best places to buy a part, just for you.
 * Each option has an "Add to Purchasing" button that creates the Purchasing (PEFS) row.
 * Searches take ~1 minute (one LLM call per page, paced to the free tier), so the command
 * replies "searching…" first and posts the results when they're ready.
 */

export type ParsedParts =
  | { kind: 'help' }
  | { kind: 'find'; part: string; qty: number; mode: RankMode; error?: string };

export function parseParts(text: string): ParsedParts {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || /^(help|\?)$/i.test(tokens[0]!)) return { kind: 'help' };
  let qty = 1;
  let mode: RankMode = 'best';
  let error: string | undefined;
  const words: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const inline = /^(?:qty[:=]|x)(\S+)$/i.exec(t);
    const flag = /^(?:-q|--qty|qty)$/i.test(t);
    if (inline || flag) {
      const raw = inline ? inline[1]! : tokens[++i] ?? '';
      const n = Number(raw.replace(/,/g, ''));
      if (Number.isInteger(n) && n >= 1 && n <= 1_000_000) qty = n;
      else if (inline && /^x/i.test(t) && !/^\d/.test(raw)) words.push(t); // "x7r" is a word, not a quantity
      else error = `Quantity should be a whole number like \`-q 50\` (got "${raw || 'nothing'}").`;
    } else if (/^--?cheapest$/i.test(t)) {
      mode = 'cheapest';
    } else {
      words.push(t);
    }
  }
  const part = words.join(' ');
  if (!part) return { kind: 'help' };
  return { kind: 'find', part, qty, mode, ...(error ? { error } : {}) };
}

export const USAGE = [
  '*Part finder*: the best places to buy a part, ranked by cost, stock and shipping.',
  '• `/parts LM7805` - best 5 for one unit',
  '• `/parts LM7805 -q 50` - for 50 units (pack sizes, price breaks and free-shipping minimums count)',
  '• `/parts LM7805 -q 50 --cheapest` - lowest order total only',
  'Each option has an *Add to Purchasing* button that creates the Purchasing (PEFS) row with you as point of contact.',
].join('\n');

// --- Formatting --------------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/** Text that goes inside <url|text>: no pipes or angle brackets. */
function linkText(s: string): string {
  return esc(s).replace(/\|/g, '/').slice(0, 150);
}

export function money(v: number | null, cur: string | null): string {
  if (v === null) return 'n/a';
  const n = v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 4 : 2 });
  return !cur || cur === 'USD' ? `$${n}` : `${n} ${cur}`;
}

export function optionText(c: Candidate, i: number): string {
  const cur = c.currency;
  const title = `*${i + 1}. <${c.url}|${linkText(c.productName || c.pageTitle || c.title || c.url)}>*`;
  const buy = c.packSize > 1 ? `${c.packsNeeded} pack(s) of ${c.packSize}` : `${c.qty} unit${c.qty === 1 ? '' : 's'}`;
  const cost =
    c.total !== null ? `*${money(c.total, cur)}* total`
      : c.subtotal !== null ? `*${money(c.subtotal, cur)}* + shipping`
        : '*no price found*';
  const line1 = [cost, `${buy}${c.unitCost !== null ? ` @ ${money(c.unitCost, cur)}/unit` : ''}`, esc(c.supplier ?? '')].filter(Boolean).join(' · ');
  const stock =
    c.stock !== null ? `${c.stock.toLocaleString('en-US')} in stock`
      : c.inStock === true ? 'in stock' : c.inStock === false ? 'out of stock' : 'stock unknown';
  const ship = [
    c.shippingTime ? `ships ${esc(c.shippingTime)}` : '',
    c.shippingCost === 'Free' ? 'free shipping' : c.shippingCost ? `shipping ${esc(c.shippingCost)}` : 'shipping unknown',
    c.freeShipMin !== null && c.shippingCost !== 'Free' ? `free over ${money(c.freeShipMin, cur)}` : '',
  ].filter(Boolean).join(', ');
  const breaks = c.priceBreaks.length ? `Price breaks: ${c.priceBreaks.map((b) => `${b.minQty}+ @ ${money(b.price, cur)}`).join(', ')}` : '';
  const score = c.score !== null ? `Score ${c.score.toFixed(2)}` : 'Unranked';
  const footer = `_${[score, ...c.notes.map(esc)].join(' · ')}_`;
  return [title, line1, `${stock} · ${ship}`, breaks, footer].filter(Boolean).join('\n');
}

export const ADD_ACTION_RE = /^parts_add_\d+$/;

export function resultsMessage(r: FindResult, searchId: string, mode: RankMode): RespondArguments {
  const header = `*Best ${r.top.length} of ${r.stats.candidates} for "${esc(r.part)}" ×${r.qty}* (${mode === 'cheapest' ? 'cheapest total' : 'best value'})`;
  if (!r.top.length) return { response_type: 'ephemeral', text: `${header}\nNo listings found. Try a different part number or wording.` };
  const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text: header } }];
  r.top.forEach((c, i) => {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: optionText(c, i) },
      ...(c.subtotal !== null
        ? {
          accessory: {
            type: 'button',
            action_id: `parts_add_${i}`,
            text: { type: 'plain_text', text: 'Add to Purchasing' },
            value: `${searchId}:${i}`,
            ...(i === 0 ? { style: 'primary' } : {}),
          },
        }
        : {}),
    });
  });
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `Score 1.00 = cheapest with no drawbacks; lower is better. ${r.stats.fetched} pages read, ${r.stats.priced} with prices · via ${esc(r.source)} + ${esc(r.llm)}. Prices are read by an LLM, so check the listing before ordering.`,
    }],
  });
  return { response_type: 'ephemeral', text: header, blocks };
}

// --- Search cache (what the buttons point at) -------------------------------------------------

export const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedSearch {
  userId: string;
  result: FindResult;
  /** option index → Notion row URL, so a second click doesn't create a duplicate row. */
  added: Map<number, string>;
  createdAt: number;
}

/** In-memory like benbuys/cache.ts: a restart just means "search again". */
export class SearchCache {
  private store = new Map<string, CachedSearch>();
  constructor(private ttlMs = SEARCH_TTL_MS, private maxEntries = 200, private now: () => number = Date.now) {}

  put(userId: string, result: FindResult): string {
    const id = randomUUID().slice(0, 8);
    this.store.set(id, { userId, result, added: new Map(), createdAt: this.now() });
    while (this.store.size > this.maxEntries) this.store.delete(this.store.keys().next().value!);
    return id;
  }

  get(id: string): CachedSearch | null {
    const hit = this.store.get(id);
    if (!hit) return null;
    if (this.now() - hit.createdAt > this.ttlMs) {
      this.store.delete(id);
      return null;
    }
    return hit;
  }
}

// --- Wiring ------------------------------------------------------------------------------------

export interface PartsDeps {
  llm: JsonLlm | null;
  notion: PartsNotion;
  cache: SearchCache;
  find?: (part: string, opts: FindOptions) => Promise<FindResult>;
}

function scorerFromConfig(): Scorer {
  if (!config.parts.weightsJson) return new Scorer();
  try {
    return new Scorer(makeWeights(JSON.parse(config.parts.weightsJson)));
  } catch (err) {
    logger.error('Part finder: PARTS_WEIGHTS_JSON is invalid; using default weights', err);
    return new Scorer();
  }
}

/** Searches running per user: one at a time, so a double-submit doesn't burn the LLM quota. */
const running = new Set<string>();

export async function handleFind(deps: PartsDeps, parsed: Extract<ParsedParts, { kind: 'find' }>, userId: string, respond: RespondFn): Promise<void> {
  if (!deps.llm) {
    await respond({ response_type: 'ephemeral', text: 'The part finder needs an LLM key on this PERBot deploy (GEMINI_API_KEY or GROQ_API_KEY).' });
    return;
  }
  if (running.has(userId)) {
    await respond({ response_type: 'ephemeral', text: 'You already have a `/parts` search running; I’ll post it when it’s done.' });
    return;
  }
  running.add(userId);
  try {
    await respond({ response_type: 'ephemeral', text: `🔎 Searching ${config.parts.pool} listings for *${esc(parsed.part)}* ×${parsed.qty}. This takes about a minute…` });
    const result = await (deps.find ?? findParts)(parsed.part, {
      qty: parsed.qty,
      mode: parsed.mode,
      top: config.parts.top,
      pool: config.parts.pool,
      perSupplier: config.parts.perSupplier,
      llm: deps.llm,
      scorer: scorerFromConfig(),
    });
    const searchId = deps.cache.put(userId, result);
    await respond(resultsMessage(result, searchId, parsed.mode));
  } finally {
    running.delete(userId);
  }
}

let peopleIndex: { at: number; index: Promise<Indexed[]> } | null = null;
function notionPeople(notion: PartsNotion): Promise<Indexed[]> {
  if (!peopleIndex || Date.now() - peopleIndex.at > 3_600_000) {
    peopleIndex = { at: Date.now(), index: notion.listUsers().then(indexNotionUsers) };
    peopleIndex.index.catch(() => (peopleIndex = null));
  }
  return peopleIndex.index;
}

async function displayName(client: WebClient, userId: string): Promise<string> {
  try {
    const info: any = await client.users.info({ user: userId });
    return info?.user?.profile?.real_name || info?.user?.real_name || info?.user?.name || userId;
  } catch {
    return userId;
  }
}

export async function handleAdd(deps: PartsDeps, value: string, userId: string, client: WebClient, respond: RespondFn): Promise<void> {
  const [searchId = '', idx = ''] = value.split(':');
  const index = Number(idx);
  const cached = deps.cache.get(searchId);
  const candidate = cached?.result.top[index];
  if (!cached || !candidate) {
    await respond({ response_type: 'ephemeral', replace_original: false, text: 'That search has expired (PERBot keeps them for 24h and forgets them on restart). Run `/parts` again.' });
    return;
  }
  if (cached.userId !== userId) {
    await respond({ response_type: 'ephemeral', replace_original: false, text: 'Only the person who ran this search can add from it.' });
    return;
  }
  const existing = cached.added.get(index);
  if (existing) {
    await respond({ response_type: 'ephemeral', replace_original: false, text: `Already added: <${existing}|open the Purchasing row>.` });
    return;
  }
  cached.added.set(index, 'pending'); // block a fast double-click while Notion is writing

  try {
    const [poc, addedBy] = await Promise.all([
      notionPeople(deps.notion).then((idx) => slackUserToNotionId(client, userId, idx)).catch((err) => {
        logger.warn(`Part finder: could not resolve ${userId} to a Notion person`, err);
        return null;
      }),
      displayName(client, userId),
    ]);
    const row = await deps.notion.addCandidate(candidate, {
      part: cached.result.part,
      season: config.benbuys.season,
      pointOfContactNotionId: poc,
      addedBy,
    });
    cached.added.set(index, row.url);
    const todo = ['Subsystem', row.paymentMethod ? '' : 'Payment Method', poc ? '' : 'Point of contact'].filter(Boolean);
    await respond({
      response_type: 'ephemeral',
      replace_original: false,
      text: [
        `✅ Added option ${index + 1} to Purchasing: <${row.url}|${linkText(candidate.productName || candidate.title)}>.`,
        `Fill in ${todo.join(', ')} in Notion until \`PEFS Ready?\` shows ✅.`,
        row.skipped.length ? `_(Couldn’t write ${row.skipped.join(', ')}: those columns are missing or a different type.)_` : '',
      ].filter(Boolean).join('\n'),
    });
  } catch (err) {
    cached.added.delete(index);
    logger.error('Part finder: add to Purchasing failed', err);
    await respond({ response_type: 'ephemeral', replace_original: false, text: `✗ Couldn’t create the Purchasing row: ${err instanceof Error ? err.message : String(err)}` });
  }
}

export function registerPartsCommand(app: App, deps?: PartsDeps): void {
  const resolved: PartsDeps = deps ?? { llm: createPartsLlm(), notion: new PartsNotion(), cache: new SearchCache() };
  if (!resolved.llm) logger.warn('Part finder: no LLM key (GEMINI_API_KEY / GROQ_API_KEY); /parts will say so.');

  app.command('/parts', async ({ ack, command, respond }) => {
    await ack();
    const parsed = parseParts(command.text);
    if (parsed.kind === 'help') {
      await respond({ response_type: 'ephemeral', text: USAGE });
      return;
    }
    if (parsed.error) {
      await respond({ response_type: 'ephemeral', text: `${parsed.error}\n${USAGE}` });
      return;
    }
    try {
      await handleFind(resolved, parsed, command.user_id, respond);
    } catch (err) {
      logger.error('/parts failed', err);
      await respond({ response_type: 'ephemeral', text: `✗ /parts hit an error: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  app.action(ADD_ACTION_RE, async ({ ack, body, action, client, respond }) => {
    await ack();
    await handleAdd(resolved, (action as any).value ?? '', body.user.id, client, respond);
  });
}

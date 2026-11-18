import { config, hasOpenAI } from '../config.js';
import { getOpenAIClient, wellFormed } from '../services/llm.js';
import { logger } from '../utils/logger.js';
import { DATE_FIELDS, GROUP_BYS, runPurchaseQuery, type PurchasePlan, type PurchaseResult } from './query.js';
import { loadPurchaseRecords, ORDER_STAGES, type OrderStage, type PurchaseRecord } from './records.js';

/**
 * "@PERBot did we order the AIRs?" → a small model turns the question into a filter plan,
 * `runPurchaseQuery` does the matching and the math, and the answer model writes the reply
 * from those rows only.
 */

const SUBSYSTEMS = ['Aero', 'Chassis', 'Drivetrain', 'VD', 'Accumulator', 'PCM', 'PDU', 'HV/Secondary', 'DAQDASH', 'Software', 'Misc (mech)', 'Misc (elec)', 'Suspension'];
const PAYMENT_METHODS = ['PEFS', 'PCard', 'BenBuys'];
const DB_URL = 'https://www.notion.so/a7d560bcc03982da8789016dc965c90a';

const strings = (v: unknown, max = 8): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()).slice(0, max) : [];
const isoDate = (v: unknown): string | undefined =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined;
const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  allowed.find((a) => typeof v === 'string' && a.toLowerCase() === v.toLowerCase());

/** Keeps only fields and values the query understands; the model's output is never trusted as-is. */
export function sanitizePlan(raw: any): PurchasePlan {
  const r = raw && typeof raw === 'object' ? raw : {};
  const canon = (xs: string[], allowed: string[]) =>
    xs.map((x) => allowed.find((a) => a.toLowerCase() === x.toLowerCase())).filter((x): x is string => Boolean(x));
  const plan: PurchasePlan = {
    terms: strings(r.terms),
    vendors: strings(r.vendors),
    subsystems: canon(strings(r.subsystems), SUBSYSTEMS),
    seasons: strings(r.seasons).map((s) => s.toUpperCase().replace(/^(?:REV)?\s*(\d+)$/, 'REV$1')),
    allSeasons: r.allSeasons === true,
    stages: strings(r.stages).map((s) => pick(s, ORDER_STAGES)).filter((s): s is OrderStage => Boolean(s)),
    paymentMethods: canon(strings(r.paymentMethods), PAYMENT_METHODS),
    people: strings(r.people, 4),
    orderBatch: typeof r.orderBatch === 'string' && r.orderBatch.trim() ? r.orderBatch.trim() : undefined,
    dateField: pick(r.dateField, DATE_FIELDS),
    since: isoDate(r.since),
    until: isoDate(r.until),
    groupBy: pick(r.groupBy, GROUP_BYS),
    sort: pick(r.sort, ['newest', 'oldest', 'cost'] as const),
  };
  return Object.fromEntries(
    Object.entries(plan).filter(([, v]) => v !== undefined && v !== false && !(Array.isArray(v) && v.length === 0))
  ) as PurchasePlan;
}

function extractJson(text: string): any {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const list = (items: object) => ({ type: 'array', items });
const nullable = (type: string, extra: object = {}) => ({ type: [type, 'null'], ...extra });
/** Strict structured output: every key present, null/[] when unused, values from fixed vocabularies. */
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['terms', 'vendors', 'subsystems', 'seasons', 'allSeasons', 'stages', 'paymentMethods', 'people', 'orderBatch', 'dateField', 'since', 'until', 'groupBy', 'sort'],
  properties: {
    terms: list({ type: 'string' }),
    vendors: list({ type: 'string' }),
    subsystems: list({ type: 'string', enum: SUBSYSTEMS }),
    seasons: list({ type: 'string' }),
    allSeasons: { type: 'boolean' },
    stages: list({ type: 'string', enum: ORDER_STAGES }),
    paymentMethods: list({ type: 'string', enum: PAYMENT_METHODS }),
    people: list({ type: 'string' }),
    orderBatch: nullable('string'),
    dateField: nullable('string', { enum: [...DATE_FIELDS, null] }),
    since: nullable('string'),
    until: nullable('string'),
    groupBy: nullable('string', { enum: [...GROUP_BYS, null] }),
    sort: nullable('string', { enum: ['newest', 'oldest', 'cost', null] }),
  },
};

export async function planPurchaseQuery(question: string, today = new Date()): Promise<PurchasePlan> {
  const prompt = `Turn a Penn Electric Racing teammate's question about the team's purchasing database into a JSON filter plan.
Today is ${today.toISOString().slice(0, 10)}. The current season is ${config.app.currentRev}; earlier seasons: REV11.

Each database row is one purchased item: name, part number, vendor, product link, quantity, unit cost, season, subsystem(s), payment method, order batch, point of contact (the teammate who requested it), and dates.
Order stages, in order: "not submitted" (requested, not sent to purchasing) → "sent to purchasing" (exported, order not confirmed) → "ordered" (purchasing confirmed by email) → "ready for pickup" → "arrived".

Fields (use [] / null / false for anything the question doesn't need):
- terms: item searches, e.g. ["busbar"], ["AIR", "contactor"], ["M6 bolt"], or a part number like ["LTC6811"]. Short — the item's key words only, no filler like "order" or "parts". Give 2-3 alternative spellings/synonyms as separate terms when useful (["AIR", "contactor"], ["heat shrink", "heatshrink"]).
- vendors: e.g. ["DigiKey"], ["McMaster"], ["Mouser"].
- subsystems: any of ${JSON.stringify(SUBSYSTEMS)}.
- seasons: e.g. ["REV11"]. Leave empty unless the question names a season or car; set "allSeasons": true for all-time/history questions.
- stages: any of ${JSON.stringify(ORDER_STAGES)} — only when the question filters by status (e.g. "what hasn't arrived yet" → ["not submitted","sent to purchasing","ordered","ready for pickup"]; "what's ready for pickup" → ["ready for pickup"]). Do NOT set stages for "has X been ordered/arrived?" — the answer needs to see X whatever its stage.
- paymentMethods: any of ${JSON.stringify(PAYMENT_METHODS)}.
- people: teammate names when the question asks about someone's orders ("what did Alex order").
- orderBatch: e.g. "Order 3".
- since / until (YYYY-MM-DD) with dateField: "submitted" (default) | "ordered" | "arrived" | "created". "this week", "last month", "since October" → concrete dates.
- groupBy: one of ${JSON.stringify(GROUP_BYS)} for breakdowns ("spending by subsystem", "which vendors do we use most").
- sort: "newest" (default) | "oldest" | "cost" (most expensive first).

Question: ${JSON.stringify(question.slice(0, 600))}

Reply with the JSON plan.`;

  const response = await getOpenAIClient().responses.create({
    model: config.answers.rerankModel,
    input: wellFormed(prompt),
    reasoning: { effort: 'low' },
    text: { format: { type: 'json_schema', name: 'purchase_plan', strict: true, schema: PLAN_SCHEMA } },
  }, { timeout: 30_000 });
  const plan = sanitizePlan(extractJson(response.output_text ?? ''));
  logger.info(`Purchasing plan: ${JSON.stringify(plan)}`);
  return plan;
}

const money = (n: number | null): string =>
  n === null ? '?' : `$${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

export function rowLine(r: PurchaseRecord, n: number): string {
  const parts = [
    `[${n}] ${r.name || '(unnamed)'}`,
    r.partNumber && `part ${r.partNumber}`,
    r.vendor && `vendor ${r.vendor}`,
    `${r.quantity ?? '?'} × ${money(r.unitCost)} = ${money(r.totalCost)}`,
    r.season,
    r.subsystems.length && r.subsystems.join('/'),
    r.paymentMethod,
    r.orderBatch,
    `stage: ${r.stage}`,
    r.submittedAt && `submitted ${r.submittedAt.slice(0, 10)}`,
    r.orderedAt && `order confirmed ${r.orderedAt.slice(0, 10)}`,
    r.arrivedAt && `arrived ${r.arrivedAt.slice(0, 10)}`,
    r.receivedBy && `received by ${r.receivedBy}`,
    r.pointOfContact.length && `requested by ${r.pointOfContact.join(', ')}`,
    r.urgency.length && `urgency ${r.urgency.join('/')}`,
    r.notes && `notes: ${r.notes.slice(0, 160)}`,
  ];
  return parts.filter(Boolean).join(' | ');
}

export function describeResult(result: PurchaseResult): string {
  const lines = [
    `Filter applied: ${JSON.stringify(result.plan)}`,
    `Rows matched: ${result.matched}`,
    `Total cost of matched rows: ${money(result.totalCost)}${result.missingCost ? ` (${result.missingCost} rows have no cost recorded)` : ''}`,
    `By stage: ${Object.entries(result.stageCounts).map(([s, c]) => `${s} ${c}`).join(', ') || 'none'}`,
  ];
  if (result.groups.length) {
    lines.push(
      `Breakdown by ${result.plan.groupBy}:`,
      ...result.groups.slice(0, 25).map((g) => `- ${g.key}: ${g.count} rows, ${money(g.total)}`)
    );
  }
  for (const note of result.notes) lines.push(`Note: ${note}`);
  if (result.rows.length < result.matched) lines.push(`Rows below: the first ${result.rows.length} of ${result.matched} (sorted ${result.plan.sort ?? 'newest'}).`);
  return lines.join('\n');
}

export interface PurchasingAnswer {
  summary: string;
  rows: PurchaseRecord[];
  matched: number;
  totalCost: number;
}

export async function answerPurchasing(question: string): Promise<PurchasingAnswer> {
  if (!hasOpenAI()) {
    return { summary: 'Purchasing lookups need `OPENAI_API_KEY` set for PERBot.', rows: [], matched: 0, totalCost: 0 };
  }
  const [records, plan] = await Promise.all([loadPurchaseRecords(), planPurchaseQuery(question)]);
  const result = runPurchaseQuery(records, plan, { currentSeason: config.app.currentRev, rowLimit: 40 });

  const prompt = `You are PERBot, the assistant for Penn Electric Racing (Penn's Formula SAE Electric team), in the team's Slack.
A teammate asked about the team's purchases. Below is what the Purchasing (PEFS) Notion database returned for their question: the filter that was run, exact counts and totals computed from every matching row, and the matching rows themselves.

Order stages: "not submitted" (requested, never sent to purchasing) → "sent to purchasing" (exported to purchasing, no order confirmation yet) → "ordered" (purchasing confirmed the order by email) → "ready for pickup" → "arrived".

Rules:
- Answer only from this data. Never guess prices, dates, quantities or statuses that aren't in a row.
- Lead with the direct answer ("Yes — ordered on Oct 3, arrived Oct 10 [1]" / "No — I don't see that in the purchasing database").
- Use the computed counts and totals exactly as given; don't re-add the rows yourself.
- Cite rows inline like [1] or [2][3].
- If several rows could be the item, list the likely ones briefly instead of picking one. If the matches look unrelated to what they asked, say you couldn't find it and suggest a different name or part number.
- REV11 arrival status was never tracked consistently: for REV11 rows, "not arrived" usually just means nobody marked it. Say so when it matters.
- For lists, use "•" bullets with name, quantity, cost and stage; show at most ~12 and say how many more there are.
- Slack mrkdwn: *bold* for key terms, no headers, no markdown links. Stay under 2,000 characters.

Question: ${question}

${describeResult(result)}

Rows:
${result.rows.map((r, i) => rowLine(r, i + 1)).join('\n') || '(none)'}`;

  const response = await getOpenAIClient().responses.create({
    model: config.openai.answerModel,
    input: wellFormed(prompt),
    reasoning: { effort: 'low' },
  }, { timeout: 60_000 });
  return {
    summary: response.output_text?.trim() || "I searched the purchasing database but couldn't write an answer.",
    rows: result.rows,
    matched: result.matched,
    totalCost: result.totalCost,
  };
}

const slackEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Answer, then links to the rows it cited (or the first few), then a one-line footer. */
export function buildPurchasingBlocks(answer: PurchasingAnswer): any[] {
  const cited = [...new Set([...answer.summary.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))]
    .filter((n) => n >= 1 && n <= answer.rows.length)
    .slice(0, 10);
  const linked = (cited.length ? cited : answer.rows.slice(0, 5).map((_, i) => i + 1)).map((n) => {
    const r = answer.rows[n - 1]!;
    const label = slackEscape(r.name || r.partNumber || 'row').replace(/\|/g, '/').slice(0, 80);
    return `[${n}] <${r.url}|${label}> · ${r.stage}`;
  });

  const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text: answer.summary.slice(0, 2900) } }];
  if (linked.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: linked.join('\n').slice(0, 2900) } });
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `:package: From <${DB_URL}|Purchasing (PEFS)> · ${answer.matched} matching row${answer.matched === 1 ? '' : 's'}${answer.matched ? ` · ${money(answer.totalCost)} total` : ''}`,
      },
    ],
  });
  return blocks;
}

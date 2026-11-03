import type { PlainRow } from './notionProps.js';

/**
 * Test rows for the sandbox Purchasing (PEFS) database, one preset per workflow that reads it.
 * Column names match the prod schema (see benbuys/notion.ts, arrivals/notion.ts, priceCheck/notion.ts).
 *
 * Every seeded row gets `[dev-seed <batch>]` at the start of `Notes (internal)` so `list` / `clean`
 * can find exactly the rows the seeder made (and nothing a person typed into the sandbox).
 */

export const SEED_TAG = '[dev-seed';

export function seedTag(batch: string): string {
  return `${SEED_TAG} ${batch}]`;
}

/** Short, sortable batch id, e.g. `1102-1645`. */
export function newBatchId(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function daysAgo(days: number, now: Date): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

export interface SeedContext {
  batch: string;
  season: string;
  now?: Date;
}

/** Columns every seeded row carries unless the preset/file overrides them. */
export function baseRow(ctx: SeedContext): PlainRow {
  return {
    Season: ctx.season,
    'Payment Method': 'BenBuys',
    'Exported?': false,
    'Include in next order': false,
    'Order Batch': `dev-${ctx.batch}`,
  };
}

type Preset = (ctx: SeedContext) => PlainRow[];

/** DigiKey (Electrical BENBuys): ready rows, a duplicate part number to collapse, one not-ready row. */
const benbuys: Preset = () => [
  {
    Name: 'RES 10K OHM 1% 1/10W 0603',
    'Cat. or model no.': '311-10.0KHRCT-ND',
    'Quant.': 50,
    'Unit cost': 0.1,
    Subsystem: ['Electrical'],
    'Link to product webpage': 'https://www.digikey.com/en/products/detail/yageo/RC0603FR-0710KL/726880',
    Vendor: 'DigiKey',
  },
  {
    Name: 'CAP CER 10UF 25V X5R 0805',
    'Cat. or model no.': '1276-2891-1-ND',
    'Quant.': 20,
    'Unit cost': 0.21,
    Subsystem: ['Electrical'],
    'Link to product webpage': 'https://www.digikey.com/en/products/detail/samsung-electro-mechanics/CL21A106KAYNNNE/3886850',
    Vendor: 'DigiKey',
  },
  {
    // Same part as the first row from another subsystem — prep should collapse these into one cart line.
    Name: 'RES 10K OHM 1% 1/10W 0603 (accumulator)',
    'Cat. or model no.': '311-10.0KHRCT-ND',
    'Quant.': 25,
    'Unit cost': 0.1,
    Subsystem: ['Accumulator'],
    'Link to product webpage': 'https://www.digikey.com/en/products/detail/yageo/RC0603FR-0710KL/726880',
    Vendor: 'DigiKey',
  },
  {
    // No unit cost / part number → should land in prep's "Not ready (fix in Notion)" list.
    Name: 'CONN HEADER 2POS (missing fields)',
    'Quant.': 10,
    Subsystem: ['Electrical'],
    'Link to product webpage': 'https://www.digikey.com/en/products/detail/molex/0022232021/26667',
    Vendor: 'DigiKey',
  },
];

/** McMaster-Carr (Mechanical BENBuys). */
const mcmaster: Preset = () => [
  {
    Name: 'Socket head screw M5 x 0.8 x 16mm (pack of 50)',
    'Cat. or model no.': '91290A230',
    'Quant.': 2,
    'Unit cost': 11.45,
    Subsystem: ['Suspension'],
    'Link to product webpage': 'https://www.mcmaster.com/91290A230/',
    Vendor: 'McMaster-Carr',
  },
  {
    Name: 'Nylon-insert locknut M5 x 0.8 (pack of 100)',
    'Cat. or model no.': '94645A115',
    'Quant.': 1,
    'Unit cost': 6.02,
    Subsystem: ['Drivetrain'],
    'Link to product webpage': 'https://www.mcmaster.com/94645A115/',
    Vendor: 'McMaster-Carr',
  },
];

/** Already-ordered rows waiting on delivery — what a packing-slip photo in #packages matches against. */
const arrivals: Preset = (ctx) => {
  const now = ctx.now ?? new Date();
  const ordered = {
    'Exported?': true,
    'Run ID': `DEV-${ctx.batch}`,
    'Procurement Status': 'Submitted',
    'Submitted at': daysAgo(4, now),
    'Last Email Update': daysAgo(4, now),
    'Arrived?': 'No',
  };
  return [
    { ...benbuys(ctx)[0], ...ordered },
    { ...benbuys(ctx)[1], ...ordered },
    { ...mcmaster(ctx)[0], ...ordered },
  ];
};

/** One un-exported row with a link and cost — pass its URL to `npm run price-check:try`. */
const pricecheck: Preset = () => [
  {
    Name: 'IC MCU 32BIT 512KB FLASH 64LQFP (price check test)',
    'Cat. or model no.': '497-STM32F405RGT6-ND',
    'Quant.': 3,
    'Unit cost': 15.89,
    Subsystem: ['Electrical'],
    'Link to product webpage': 'https://www.digikey.com/en/products/detail/stmicroelectronics/STM32F405RGT6/2747117',
    Vendor: 'DigiKey',
  },
];

export const PRESETS: Record<string, Preset> = { benbuys, mcmaster, arrivals, pricecheck };

export function presetRows(name: string, ctx: SeedContext): PlainRow[] {
  if (name === 'all') return Object.keys(PRESETS).flatMap((key) => presetRows(key, ctx));
  const preset = PRESETS[name];
  if (!preset) throw new Error(`Unknown preset "${name}". Use one of: ${[...Object.keys(PRESETS), 'all'].join(', ')}.`);
  return preset(ctx);
}

/** Base columns + the row, with the seed tag prepended to `Notes (internal)`. */
export function finalizeRow(row: PlainRow, ctx: SeedContext, label: string): PlainRow {
  const note = typeof row['Notes (internal)'] === 'string' ? ` ${row['Notes (internal)']}` : '';
  return {
    ...baseRow(ctx),
    ...row,
    'Notes (internal)': `${seedTag(ctx.batch)} ${label}${note}`.trim(),
  };
}

/**
 * Columns the bot reads or writes on Purchasing. `schema` reports which the sandbox lacks.
 * Optional ones are skipped gracefully by arrivals when missing.
 */
export const EXPECTED_COLUMNS: { name: string; types: string[]; optional?: boolean }[] = [
  { name: 'Name', types: ['title'] },
  { name: 'Cat. or model no.', types: ['rich_text'] },
  { name: 'Quant.', types: ['number'] },
  { name: 'Unit cost', types: ['number'] },
  { name: 'Season', types: ['select'] },
  { name: 'Payment Method', types: ['select'] },
  { name: 'Subsystem', types: ['multi_select'] },
  { name: 'Point of contact', types: ['people'] },
  { name: 'Link to product webpage', types: ['url'] },
  { name: 'Vendor', types: ['rich_text'] },
  { name: 'Notes (internal)', types: ['rich_text'] },
  { name: 'Order Batch', types: ['rich_text'] },
  { name: 'Run ID', types: ['rich_text'] },
  { name: 'Exported?', types: ['checkbox'] },
  { name: 'Include in next order', types: ['checkbox'] },
  { name: 'Procurement Status', types: ['select'] },
  { name: 'Last Email Update', types: ['date'] },
  { name: 'Submitted at', types: ['date'] },
  { name: 'Arrived?', types: ['status'] },
  { name: 'PEFS Ready?', types: ['formula'] },
  { name: 'Electrical BENBuys', types: ['formula'] },
  { name: 'Mechanical BENBuys', types: ['formula'] },
  { name: 'Sanitized Description (CSV)', types: ['formula'] },
  { name: 'Arrived at', types: ['date'], optional: true },
  { name: 'Received by', types: ['rich_text', 'people'], optional: true },
  { name: 'Arrival photo', types: ['url'], optional: true },
];

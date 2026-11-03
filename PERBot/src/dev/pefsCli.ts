import { Client } from '@notionhq/client';
import fs from 'node:fs/promises';
import { config } from '../config.js';
import { assertDevTarget } from './guard.js';
import { toProperties, type PlainRow, type Schema } from './notionProps.js';
import { EXPECTED_COLUMNS, finalizeRow, newBatchId, presetRows, PRESETS, SEED_TAG, seedTag } from './pefsSeed.js';

/**
 * DEV ONLY: seed / inspect / clean test rows in the SANDBOX Purchasing (PEFS) database.
 * Refuses to run outside dev mode or against the prod database (see dev/guard.ts).
 *
 *   npm run dev:pefs -- schema                       compare sandbox columns with what the bot expects
 *   npm run dev:pefs -- seed <preset> [--dry-run]    presets: benbuys | mcmaster | arrivals | pricecheck | all
 *   npm run dev:pefs -- seed --file rows.json        custom rows: [{ "Name": "...", "Quant.": 3, ... }]
 *   npm run dev:pefs -- list [batch]                 rows made by the seeder (optionally one batch)
 *   npm run dev:pefs -- clean [batch] [--dry-run]    move seeded rows to the trash
 *
 * Seeded rows default to Season=$BENBUYS_SEASON, Payment Method=BenBuys, not exported; any column in
 * a preset or file overrides those. Columns the sandbox doesn't have are skipped with a warning.
 */

const USAGE = `Usage:
  npm run dev:pefs -- schema
  npm run dev:pefs -- seed <${[...Object.keys(PRESETS), 'all'].join('|')}> [--dry-run]
  npm run dev:pefs -- seed --file rows.json [--dry-run]
  npm run dev:pefs -- list [batch]
  npm run dev:pefs -- clean [batch] [--dry-run]`;

function takeFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function takeOption(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
}

function plain(prop: any): string {
  return (prop?.rich_text ?? prop?.title ?? []).map((t: any) => t?.plain_text ?? '').join('').trim();
}

class SandboxPefs {
  private client = new Client({ auth: config.notion.token, notionVersion: config.notion.apiVersion });

  constructor(private dataSourceId: string) {}

  async schema(): Promise<Schema> {
    const ds: any = await this.client.dataSources.retrieve({ data_source_id: this.dataSourceId });
    const schema: Schema = {};
    for (const [name, prop] of Object.entries<any>(ds.properties ?? {})) schema[name] = prop.type;
    return schema;
  }

  async create(properties: Record<string, unknown>): Promise<{ id: string; url: string }> {
    const page: any = await this.client.pages.create({
      parent: { type: 'data_source_id', data_source_id: this.dataSourceId },
      properties: properties as any,
    } as any);
    return { id: page.id, url: page.url };
  }

  async seeded(batch?: string): Promise<any[]> {
    const pages: any[] = [];
    let cursor: string | undefined;
    do {
      const response: any = await this.client.dataSources.query({
        data_source_id: this.dataSourceId,
        filter: { property: 'Notes (internal)', rich_text: { contains: batch ? seedTag(batch) : SEED_TAG } },
        page_size: 100,
        start_cursor: cursor,
      });
      pages.push(...(response.results ?? []));
      cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    } while (cursor);
    return pages;
  }

  async trash(pageId: string): Promise<void> {
    await this.client.pages.update({ page_id: pageId, in_trash: true } as any);
  }
}

async function cmdSchema(db: SandboxPefs): Promise<void> {
  const schema = await db.schema();
  let problems = 0;
  for (const col of EXPECTED_COLUMNS) {
    const actual = schema[col.name];
    if (!actual) {
      console.log(`${col.optional ? '·' : '✗'} missing ${col.optional ? '(optional) ' : ''}${col.name} [${col.types.join('|')}]`);
      if (!col.optional) problems++;
    } else if (!col.types.includes(actual)) {
      console.log(`✗ wrong type  ${col.name}: ${actual}, expected ${col.types.join('|')}`);
      problems++;
    } else {
      console.log(`✓ ${col.name} [${actual}]`);
    }
  }
  const extra = Object.keys(schema).filter((name) => !EXPECTED_COLUMNS.some((c) => c.name === name));
  if (extra.length) console.log(`\nOther columns (not used by the bot): ${extra.join(', ')}`);
  console.log(problems ? `\n${problems} problem(s) — fix the sandbox copy so it matches prod.` : '\nSandbox schema matches.');
}

async function loadRows(args: string[], ctx: { batch: string; season: string }): Promise<{ label: string; row: PlainRow }[]> {
  const file = takeOption(args, '--file');
  if (file) {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    const rows: PlainRow[] = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => ({ label: `file:${file}`, row }));
  }
  const preset = args[0];
  if (!preset) throw new Error(USAGE);
  const names = preset === 'all' ? Object.keys(PRESETS) : [preset];
  return names.flatMap((name) => presetRows(name, ctx).map((row) => ({ label: name, row })));
}

async function cmdSeed(db: SandboxPefs, args: string[], dryRun: boolean): Promise<void> {
  const ctx = { batch: newBatchId(), season: config.benbuys.season };
  const rows = await loadRows(args, ctx);
  const schema = await db.schema();
  if (!schema['Notes (internal)']) {
    throw new Error('Sandbox PEFS has no "Notes (internal)" column — the seeder tags rows there so clean can find them.');
  }

  const skipped = new Set<string>();
  console.log(`${dryRun ? '[dry run] ' : ''}Seeding ${rows.length} row(s) as batch ${ctx.batch} (season ${ctx.season})...`);
  for (const { label, row } of rows) {
    const { properties, missing, unwritable } = toProperties(finalizeRow(row, ctx, label), schema);
    [...missing, ...unwritable].forEach((name) => skipped.add(name));
    const name = String(row.Name ?? '(untitled)');
    if (dryRun) {
      console.log(`  - [${label}] ${name}`);
      continue;
    }
    const page = await db.create(properties);
    console.log(`  + [${label}] ${name}\n      ${page.url}`);
  }
  if (skipped.size) console.warn(`\nSkipped columns not in the sandbox (or not writable): ${[...skipped].join(', ')}`);
  console.log(`\nDone. Remove with: npm run dev:pefs -- clean ${ctx.batch}`);
}

async function cmdList(db: SandboxPefs, batch?: string): Promise<void> {
  const pages = await db.seeded(batch);
  if (!pages.length) return console.log('No seeded rows.');
  for (const page of pages) {
    const p = page.properties ?? {};
    const tag = plain(p['Notes (internal)']).match(/\[dev-seed ([^\]]+)\]/)?.[1] ?? '?';
    const flags = [
      p['Exported?']?.checkbox ? 'exported' : '',
      p['Arrived?']?.status?.name ? `arrived=${p['Arrived?'].status.name}` : '',
      p['PEFS Ready?']?.formula?.string ?? '',
    ].filter(Boolean).join(' · ');
    console.log(`${tag}  ${plain(p['Name'])}  ${flags}\n      ${page.url}`);
  }
  console.log(`\n${pages.length} seeded row(s).`);
}

async function cmdClean(db: SandboxPefs, batch: string | undefined, dryRun: boolean): Promise<void> {
  const pages = await db.seeded(batch);
  for (const page of pages) {
    if (!dryRun) await db.trash(page.id);
    console.log(`${dryRun ? '  would trash' : '  trashed'} ${plain(page.properties?.['Name'])}`);
  }
  console.log(`${dryRun ? '[dry run] ' : ''}${pages.length} seeded row(s)${batch ? ` in batch ${batch}` : ''}.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--dev');
  const dryRun = takeFlag(args, '--dry-run');
  const command = args.shift();
  const db = new SandboxPefs(
    assertDevTarget('Purchasing (PEFS) database', 'BENBUYS_PURCHASING_DS_ID', config.benbuys.purchasingDataSourceId)
  );

  switch (command) {
    case 'schema':
      return cmdSchema(db);
    case 'seed':
      return cmdSeed(db, args, dryRun);
    case 'list':
      return cmdList(db, args[0]);
    case 'clean':
      return cmdClean(db, args[0], dryRun);
    default:
      throw new Error(USAGE);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

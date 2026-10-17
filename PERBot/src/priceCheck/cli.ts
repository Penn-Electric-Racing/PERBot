import { Client } from '@notionhq/client';
import { WebClient } from '@slack/web-api';
import { config } from '../config.js';
import { encodeValue, escapeMrkdwn, money, PRICE_ACTIONS_BLOCK_ID, PRICE_LINKS_BLOCK_ID, type PriceSwapValue } from './blocks.js';
import { PriceCheckNotion } from './notion.js';

/**
 * Smoke test for the price-check buttons without the price listener: DMs one Slack user a
 * fake alert for a real Purchasing row, with the same buttons price_check.py sends. Posting
 * writes nothing to Notion; tapping a button does (once PERBot with this handler is deployed).
 *
 *   npm run price-check:try -- <notion row url|id> <price> --to <Slack user id> [--supplier DigiKey] [--link <url>]
 *
 * Use a throwaway row (not Exported?) — the buttons write its real Unit cost.
 */

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const to = flag(args, '--to');
  const supplier = flag(args, '--supplier') ?? 'Test supplier';
  const link = flag(args, '--link');
  const [rowArg, priceArg] = args;
  const rowId = rowArg?.match(/([0-9a-f]{32}|[0-9a-f-]{36})(?:\?.*)?$/i)?.[1];
  const price = Number(priceArg);
  if (!rowId || !(price > 0) || !to) {
    console.error('Usage: npm run price-check:try -- <notion row url|id> <price> --to <Slack user id> [--supplier X] [--link <url>]');
    process.exit(1);
  }

  const row = await new PriceCheckNotion().fetchRow(rowId);
  // The row's name / part number / page link, so the test alert reads like price_check.py's.
  const page: any = await new Client({ auth: config.notion.token, notionVersion: config.notion.apiVersion }).pages.retrieve({ page_id: rowId });
  const plain = (prop: any) => (prop?.title ?? prop?.rich_text ?? []).map((t: any) => t.plain_text).join('').trim();
  const name = plain(Object.values(page.properties ?? {}).find((v: any) => v?.type === 'title'));
  const part = plain(page.properties?.['Cat. or model no.']);
  if (row.unitCost === null || row.quantity === null) throw new Error('That row has no Unit cost / Quant. to compare.');
  // x: 1 keeps test clicks out of the savings ledger.
  const base: PriceSwapValue = { v: 1, r: row.id, q: row.quantity, o: row.unitCost, x: 1 };
  const use = encodeValue({ ...base, n: price, s: supplier, ...(link ? { l: link, ol: row.link } : {}) });
  const keep = encodeValue(base);
  // Same as price_check.py: a View button for the listing (the --link, else the row's own link).
  const listing = /^https?:\/\/\S+$/i.test(link ?? row.link) ? (link ?? row.link) : null;
  if (!use || !keep) throw new Error('Button value over 2000 chars (link too long).');

  const label = escapeMrkdwn(name || part || row.id);
  const text = [
    `🧪 *Test price alert on <${page.url}|${label}>*${part ? ` (\`${part}\` ×${row.quantity})` : ` (×${row.quantity})`}`,
    `• In Notion: $${money(row.unitCost)}`,
    `• Now: $${money(price)} at ${escapeMrkdwn(supplier)}`,
  ].join('\n');
  await new WebClient(config.slack.botToken).chat.postMessage({
    channel: to,
    text: `Test price alert: $${money(row.unitCost)} → $${money(price)}`,
    unfurl_links: false,
    blocks: <any[]>[
      { type: 'section', text: { type: 'mrkdwn', text } },
      ...(listing
        ? [
            {
              type: 'actions',
              block_id: PRICE_LINKS_BLOCK_ID,
              elements: [{ type: 'button', action_id: 'price_swap_view:0', url: listing, text: { type: 'plain_text', text: `View ${supplier} ↗`.slice(0, 75) } }],
            },
          ]
        : []),
      {
        type: 'actions',
        block_id: PRICE_ACTIONS_BLOCK_ID,
        elements: [
          {
            type: 'button',
            style: 'primary',
            text: { type: 'plain_text', text: `Use $${money(price)} · ${supplier}`.slice(0, 75) },
            action_id: 'price_swap_use:0',
            value: use,
            confirm: {
              title: { type: 'plain_text', text: 'Update Notion?' },
              text: { type: 'plain_text', text: `Set Unit cost to $${money(price)} (${supplier})? Open the listing first and check it's the right part, in stock, at this price.`.slice(0, 300) },
              confirm: { type: 'plain_text', text: 'Update Unit cost' },
              deny: { type: 'plain_text', text: 'Not yet' },
            },
          },
          { type: 'button', text: { type: 'plain_text', text: `Keep $${money(row.unitCost)}` }, action_id: 'price_swap_keep', value: keep },
        ],
      },
    ],
  });
  console.log(`Sent to ${to}. Tap the buttons in Slack; check the row in Notion after each.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import type { App } from '@slack/bolt';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { inPeriod, PriceLedger, statsText, summarize, type Period } from './ledger.js';
import { PriceCheckNotion } from './notion.js';

/**
 * `/pricecheck` — what the price check has saved, from the 💸 Price Check Savings ledger.
 *   /pricecheck            this season, just for you
 *   /pricecheck week|all   the last 7 days / all time
 *   /pricecheck share      post it in this channel
 * Also runs the sweep that marks Used rows Realized once they're ordered at the new price.
 */

export interface ParsedStats {
  kind: 'stats' | 'help';
  period: Period;
  share: boolean;
}

export function parseStats(text: string): ParsedStats {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.some((w) => w === 'help' || w === '?')) return { kind: 'help', period: 'season', share: false };
  const period: Period = words.includes('week') ? 'week' : words.some((w) => w === 'all' || w === 'alltime' || w === 'all-time') ? 'all' : 'season';
  return { kind: 'stats', period, share: words.includes('share') || words.includes('post') };
}

export const USAGE = [
  '*Price check savings*',
  '• `/pricecheck`: this season, just for you',
  '• `/pricecheck week` or `/pricecheck all`: the last 7 days, or all time',
  '• `/pricecheck share`: post it in this channel',
].join('\n');

const SWEEP_EVERY_MS = 6 * 3600 * 1000;

export function registerPriceCheckStats(app: App, ledger = new PriceLedger(), notion = new PriceCheckNotion()): void {
  app.command('/pricecheck', async ({ ack, command, respond }) => {
    await ack();
    const parsed = parseStats(command.text);
    if (parsed.kind === 'help') return void (await respond({ response_type: 'ephemeral', text: USAGE }));
    if (!ledger.enabled) return void (await respond({ response_type: 'ephemeral', text: 'The savings ledger is off (PRICE_CHECK_LEDGER_DS_ID is empty).' }));
    try {
      const season = config.benbuys.season;
      const now = new Date();
      const rows = (await ledger.rows()).filter((r) => inPeriod(r, parsed.period, season, now));
      const text = statsText(summarize(rows), parsed.period, season, config.priceCheck.ledgerUrl);
      await respond({ response_type: parsed.share ? 'in_channel' : 'ephemeral', text, unfurl_links: false } as any);
    } catch (err) {
      logger.error('/pricecheck failed', err);
      await respond({ response_type: 'ephemeral', text: '✗ Could not read the savings ledger. Try again in a minute.' });
    }
  });

  if (!ledger.enabled) return;
  const sweep = () =>
    ledger
      .sweepRealized((id) => notion.fetchRow(id))
      .then((n) => n && logger.info(`Price check ledger: ${n} row(s) now Realized.`))
      .catch((err) => logger.warn('Price check ledger: Realized sweep failed', err));
  setTimeout(sweep, 90_000).unref();
  setInterval(sweep, SWEEP_EVERY_MS).unref();
}

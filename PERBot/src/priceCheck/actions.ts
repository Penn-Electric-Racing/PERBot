import type { App } from '@slack/bolt';
import { logger } from '../utils/logger.js';
import { PRICE_ACTION_RE, PRICE_VIEW_RE } from './blocks.js';
import { PriceLedger } from './ledger.js';
import { PriceCheckNotion } from './notion.js';
import { handlePriceSwap } from './swap.js';

/**
 * Button handler for the price listener's DMs (see blocks.ts for the contract and swap.ts
 * for what a click does). Anyone who can see the alert may click it — DMs reach only the
 * row's Point of contact, channel fallbacks reach the channel — and the outcome line names
 * who did. One click per row at a time, so a double-tap can't write the audit line twice.
 */

const notion = new PriceCheckNotion();
const ledger = new PriceLedger();
const inFlight = new Set<string>();

export function registerPriceCheckActions(app: App): void {
  // View-listing link buttons: Slack opens the URL itself but still reports the click, and an
  // un-acked click shows an error icon on the button.
  app.action(PRICE_VIEW_RE, async ({ ack }) => {
    await ack();
  });

  app.action(PRICE_ACTION_RE, async ({ ack, body, action, respond, client }) => {
    await ack();
    const a = action as any;
    const actionId = a?.action_id as string;
    const clicker = (body as any)?.user?.id as string | undefined;
    if (!clicker) return;
    const whisper = (text: string) => respond({ response_type: 'ephemeral', replace_original: false, text });
    const displayName = async (user: string): Promise<string | null> => {
      const info: any = await client.users.info({ user }).catch(() => null);
      return info?.user?.profile?.real_name || info?.user?.real_name || info?.user?.name || null;
    };

    let rowId = '';
    try {
      rowId = JSON.parse(a?.value ?? '{}')?.r ?? '';
    } catch {
      // handlePriceSwap reports the bad value
    }
    if (rowId && inFlight.has(rowId)) return void (await whisper('Already updating this row, one moment.'));
    if (rowId) inFlight.add(rowId);

    try {
      const result = await handlePriceSwap(
        {
          fetchRow: (id) => notion.fetchRow(id),
          writeRow: (id, patch) => notion.writeRow(id, patch),
          displayName,
          now: () => new Date(),
        },
        { actionId, rawValue: a?.value, clicker, existing: (body as any)?.message?.blocks }
      );
      if (result.blocks) await respond({ replace_original: true, blocks: result.blocks, text: result.text ?? 'Price check' });
      else if (result.whisper) await whisper(result.whisper);
      logger.info(`Price check button: ${clicker} → ${actionId} on ${rowId || '?'}: ${result.log}`);
      // After the reply, so the ledger never slows the click down or fails it.
      if (result.ledger) {
        const e = result.ledger;
        ledger
          .record(e, (await displayName(clicker)) ?? clicker, (id) => notion.fetchRow(id))
          .then((what) => logger.info(`Price check ledger: ${rowId}: ${what}`))
          .catch((err) => logger.warn(`Price check ledger: couldn't record ${e.kind} on ${rowId}`, err));
      }
    } catch (err) {
      logger.error(`Price check button ${actionId} failed`, err);
      await whisper('✗ Could not update Notion. Try again, or change *Unit cost* in Notion.');
    } finally {
      if (rowId) inFlight.delete(rowId);
    }
  });
}

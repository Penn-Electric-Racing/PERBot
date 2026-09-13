import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { nowTimeET, todayIsoET } from './dates.js';
import {
  DEAL_ACTION_IDS,
  DEAL_STAGE_ACTION_RE,
  decodeDealValue,
  replaceDealBlocks,
  TOUCH_MODAL_ID,
  WON_MODAL_ID,
} from './dealBlocks.js';
import { announceWonNow } from './jobs/winPost.js';
import { SponsorNotion } from './notion.js';
import { parseWon } from './slack.js';
import { PipelineRow, Stage, WON_KINDS, WonKind } from './types.js';

/**
 * Button + form handlers for deal lists (stale DM, weekly digest, `/sponsor me`).
 * Registered from app.ts; Socket Mode delivers the interactions.
 *
 * Stage buttons (Contacted / In talks / Lost): ack → ownership check → re-read the deal →
 * `setStage` (which also stamps `Contacted at` on the first move out of Prospect — the
 * weekly quota signal) with a dated "via Slack" note → rewrite that deal's blocks in the
 * original message. Won and Log touch need input, so they open a small modal; on submit
 * we write to Notion and post a confirmation back to where the button lived (the
 * original message can't be edited from a modal submission — its buttons stay, and a
 * later click reports "already Won").
 */

const notion = new SponsorNotion();

interface ModalMeta {
  d: string; // deal id
  u: string; // Slack user
  ch: string; // channel/DM the button lived in
  eph: boolean; // the button was on an ephemeral message
  ru: string; // response_url (ephemeral follow-ups)
}

const STAGE_FOR_ACTION: Record<string, Stage> = {
  [DEAL_ACTION_IDS.contacted]: 'Contacted',
  [DEAL_ACTION_IDS.inTalks]: 'In talks',
  [DEAL_ACTION_IDS.lost]: 'Lost',
};
const STAGE_EMOJI: Record<string, string> = { Contacted: '📨', 'In talks': '💬', Won: '🏆', Lost: '❌' };

function containerMeta(body: any, value: { d: string; u: string }): ModalMeta {
  return {
    d: value.d,
    u: value.u,
    ch: body?.container?.channel_id ?? body?.channel?.id ?? '',
    eph: Boolean(body?.container?.is_ephemeral),
    ru: body?.response_url ?? '',
  };
}

/** Confirmation after a modal submit: ephemeral via response_url where the button was ephemeral, else a DM/channel post. */
async function confirm(client: WebClient, meta: ModalMeta, text: string): Promise<void> {
  if (meta.eph && meta.ru) {
    await fetch(meta.ru, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
    });
    return;
  }
  await client.chat.postMessage({ channel: meta.ch || meta.u, text, unfurl_links: false });
}

function stageOrder(stage: Stage | null): number {
  return ['Prospect', 'Contacted', 'In talks', 'Won', 'Lost'].indexOf(stage ?? 'Prospect');
}

export function registerSponsorActions(app: App): void {
  // --- Contacted / In talks / Lost -------------------------------------------------
  app.action(DEAL_STAGE_ACTION_RE, async ({ ack, body, action, respond }) => {
    await ack();
    const actionId = (action as any)?.action_id as string;
    const value = decodeDealValue((action as any)?.value);
    const clicker = (body as any)?.user?.id as string | undefined;
    if (!value || !clicker) return;
    if (clicker !== value.u) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: "That deal list isn't yours — ask its DRI to update it." });
      return;
    }
    const target = STAGE_FOR_ACTION[actionId];
    if (!target) return;

    try {
      const deal = await notion.fetchDeal(value.d);
      const previous = deal.stage;
      let updated: PipelineRow = deal;
      let note: string;
      if (deal.stage === 'Won' || deal.stage === 'Lost') {
        note = `${STAGE_EMOJI[deal.stage]} Already ${deal.stage} in Notion`;
      } else if (deal.stage === target || (target !== 'Lost' && stageOrder(deal.stage) > stageOrder(target))) {
        note = `Already at *${deal.stage}* in Notion`;
      } else {
        await notion.setStage(deal, target, todayIsoET(), `Moved to ${target} via Slack`);
        updated = { ...deal, stage: target, contactedAt: deal.contactedAt ?? new Date().toISOString() };
        note = `${STAGE_EMOJI[target]} ${target} · ${nowTimeET()} via Slack${target === 'Contacted' && !deal.contactedAt ? ' · counts toward this week’s quota' : ''}`;
      }

      const existing: any[] | undefined = (body as any)?.message?.blocks;
      if (existing) {
        await respond({ replace_original: true, blocks: replaceDealBlocks(existing, updated, value.u, note, previous), text: `${updated.company}: ${note}` });
      } else {
        await respond({ response_type: 'ephemeral', replace_original: false, text: `${updated.company}: ${note}` });
      }
      logger.info(`Deal button: ${clicker} → ${actionId} on ${updated.company}.`);
    } catch (err) {
      logger.error(`Deal button ${actionId} failed`, err);
      await respond({ response_type: 'ephemeral', replace_original: false, text: '✗ Could not update that deal in Notion — try again or use `/sponsor stage`.' });
    }
  });

  // --- Won → modal -------------------------------------------------------------------
  app.action(DEAL_ACTION_IDS.wonOpen, async ({ ack, body, action, client, respond }) => {
    await ack();
    const value = decodeDealValue((action as any)?.value);
    const clicker = (body as any)?.user?.id as string | undefined;
    if (!value || !clicker) return;
    if (clicker !== value.u) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: "That deal list isn't yours." });
      return;
    }
    const deal = await notion.fetchDeal(value.d);
    if (deal.stage === 'Won') {
      await respond({ response_type: 'ephemeral', replace_original: false, text: `${deal.company} is already Won in Notion.` });
      return;
    }
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: 'modal',
        callback_id: WON_MODAL_ID,
        private_metadata: JSON.stringify(containerMeta(body, value)),
        title: { type: 'plain_text', text: 'Mark deal Won' },
        submit: { type: 'plain_text', text: 'Mark Won' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*${deal.company}* → Stage *Won*. This records the amount in Received ($) and posts the win to #${config.sponsorship.winPostChannel}.` } },
          {
            type: 'input',
            block_id: 'amount',
            label: { type: 'plain_text', text: 'Amount received' },
            hint: { type: 'plain_text', text: 'e.g. 5000 · $5k · 38% of $9k (a discount, auto-tagged Valued discount)' },
            element: { type: 'plain_text_input', action_id: 'amount', placeholder: { type: 'plain_text', text: '$5,000' } },
          },
          {
            type: 'input',
            block_id: 'kind',
            optional: true,
            label: { type: 'plain_text', text: 'How it came in' },
            element: {
              type: 'static_select',
              action_id: 'kind',
              placeholder: { type: 'plain_text', text: 'Cash / in-kind / discount' },
              options: WON_KINDS.map((k) => ({ text: { type: 'plain_text', text: k }, value: k })),
            },
          },
          {
            type: 'input',
            block_id: 'note',
            optional: true,
            label: { type: 'plain_text', text: 'Note (shown under the win post)' },
            element: { type: 'plain_text_input', action_id: 'note', multiline: true, max_length: 300 },
          },
        ],
      },
    });
  });

  app.view(WON_MODAL_ID, async ({ ack, body, view, client }) => {
    const meta = JSON.parse(view.private_metadata || '{}') as ModalMeta;
    const values: any = view.state.values;
    const amountText = String(values?.amount?.amount?.value ?? '').trim();
    const kindPick = values?.kind?.kind?.selected_option?.value as WonKind | undefined;
    const noteText = String(values?.note?.note?.value ?? '').trim();
    // Reuse the /sponsor won parser on a placeholder company so "$5k" / "38% of $9k" both work.
    const parsed = parseWon(`deal ${amountText}`);
    if (!parsed) {
      await ack({ response_action: 'errors', errors: { amount: 'Enter a number ($5,000, 5k) or a discount (38% of $9k).' } });
      return;
    }
    await ack();
    const clicker = (body as any)?.user?.id as string | undefined;
    if (clicker !== meta.u) return;
    try {
      const deal = await notion.fetchDeal(meta.d);
      const kind: WonKind | undefined = kindPick ?? parsed.kind;
      const note = noteText || parsed.note || '';
      await notion.markWon(deal, parsed.amountUsd, note, todayIsoET(), kind);
      let posted = false;
      try {
        posted = await announceWonNow(client as WebClient, notion, deal, parsed.amountUsd, kind ?? null, note);
      } catch (err) {
        logger.error('Won modal: announcement failed (deal still marked Won)', err);
      }
      const usd = `$${Math.round(parsed.amountUsd).toLocaleString('en-US')}`;
      await confirm(
        client as WebClient,
        meta,
        `🏆 *${deal.company}* marked *Won* — ${usd}${kind ? ` (${kind.toLowerCase()})` : ''}${parsed.computed ? ` _(${parsed.computed})_` : ''}${posted ? ` · posted to #${config.sponsorship.winPostChannel}` : ''}. <${deal.url}|Open in Notion>`
      );
      logger.info(`Won modal: ${clicker} marked ${deal.company} Won ($${parsed.amountUsd}).`);
    } catch (err) {
      logger.error('Won modal failed', err);
      await confirm(client as WebClient, meta, '✗ Could not mark that deal Won — try `/sponsor won <company> <amount>`.');
    }
  });

  // --- Log touch → modal -------------------------------------------------------------
  app.action(DEAL_ACTION_IDS.touchOpen, async ({ ack, body, action, client, respond }) => {
    await ack();
    const value = decodeDealValue((action as any)?.value);
    const clicker = (body as any)?.user?.id as string | undefined;
    if (!value || !clicker) return;
    if (clicker !== value.u) {
      await respond({ response_type: 'ephemeral', replace_original: false, text: "That deal list isn't yours." });
      return;
    }
    const deal = await notion.fetchDeal(value.d);
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: 'modal',
        callback_id: TOUCH_MODAL_ID,
        private_metadata: JSON.stringify(containerMeta(body, value)),
        title: { type: 'plain_text', text: 'Log a touch' },
        submit: { type: 'plain_text', text: 'Log it' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*${deal.company}* — stamps Last contact = today and adds a dated note (same as \`/sponsor log\`).` } },
          {
            type: 'input',
            block_id: 'note',
            label: { type: 'plain_text', text: 'What happened?' },
            element: { type: 'plain_text_input', action_id: 'note', multiline: true, max_length: 500, placeholder: { type: 'plain_text', text: 'Called Chloe, sending the deck Monday' } },
          },
        ],
      },
    });
  });

  app.view(TOUCH_MODAL_ID, async ({ ack, body, view, client }) => {
    const meta = JSON.parse(view.private_metadata || '{}') as ModalMeta;
    const noteText = String((view.state.values as any)?.note?.note?.value ?? '').trim();
    if (!noteText) {
      await ack({ response_action: 'errors', errors: { note: 'Add a short note.' } });
      return;
    }
    await ack();
    const clicker = (body as any)?.user?.id as string | undefined;
    if (clicker !== meta.u) return;
    try {
      const deal = await notion.fetchDeal(meta.d);
      await notion.logTouch(deal, `${noteText} (via Slack)`, todayIsoET());
      await confirm(client as WebClient, meta, `📝 Logged on *${deal.company}* (Last contact = today): ${noteText}`);
      logger.info(`Touch modal: ${clicker} logged a touch on ${deal.company}.`);
    } catch (err) {
      logger.error('Touch modal failed', err);
      await confirm(client as WebClient, meta, '✗ Could not log that — try `/sponsor log <company> - <note>`.');
    }
  });
}

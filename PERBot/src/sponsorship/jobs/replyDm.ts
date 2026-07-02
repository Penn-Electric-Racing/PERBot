import { logger } from '../../utils/logger.js';
import { fetchSlackDirectory, notionUserToSlackId } from '../identity.js';
import { SponsorNotion } from '../notion.js';
import { NotionUser } from '../types.js';
import { makeSlackClient } from './shared.js';

/**
 * Phase-3 reply DM (the PERBot half of the hybrid). A Power Automate flow watches the
 * shared inbox, matches a sponsor's reply to its Pipeline deal, stamps Last contact +
 * Stage `In talks`, and ticks the deal's **Reply pending** checkbox. This job (short
 * cron) DMs the deal's DRI(s) so they follow up, then clears the flag.
 *
 * Idempotency: clearing the flag after a successful DM makes re-runs a no-op. If a deal
 * has DRIs but every DM throws (transient), the flag is left set to retry next run; if
 * no DRI is reachable at all, the flag is cleared (with a warning) so it can't loop.
 */
export async function runReplyDm(): Promise<void> {
  const client = makeSlackClient();
  const notion = new SponsorNotion();

  const deals = await notion.queryReplyPending();
  if (deals.length === 0) {
    logger.info('Reply DM: nothing pending.');
    return;
  }

  const notionUsersById = new Map<string, NotionUser>((await notion.listNotionUsers()).map((u) => [u.id, u]));
  const slackDir = await fetchSlackDirectory(client);

  for (const deal of deals) {
    let resolved = 0;
    let sent = 0;

    for (const notionId of deal.driUserIds) {
      const user = notionUsersById.get(notionId);
      if (!user) continue;
      const slackUserId = await notionUserToSlackId(client, user, slackDir);
      if (!slackUserId) {
        logger.warn(`Reply DM: no Slack match for DRI ${user.name || notionId} on ${deal.company}.`);
        continue;
      }
      resolved++;
      try {
        // Post straight to the user ID — Slack opens the DM automatically, so this needs
        // only `chat:write` (not the `im:write` that conversations.open requires).
        const text =
          `:incoming_envelope: *${deal.company}* just replied to your outreach — follow up soon! ` +
          `<${deal.url}|Open the deal>`;
        await client.chat.postMessage({ channel: slackUserId, text, unfurl_links: false });
        sent++;
      } catch (err) {
        logger.error(`Reply DM: failed to DM DRI for ${deal.company}`, err);
      }
    }

    // Clear the flag when we sent at least one DM, or when there was no one to DM at all
    // (so it can't loop). Leave it set only when DRIs resolved but every send failed.
    if (sent > 0 || resolved === 0) {
      await notion.clearReplyPending(deal.id);
      if (sent === 0) logger.warn(`Reply DM: ${deal.company} had no reachable DRI — flag cleared, no DM sent.`);
      else logger.info(`Reply DM: notified ${sent} DRI(s) for ${deal.company}.`);
    } else {
      logger.warn(`Reply DM: all DMs failed for ${deal.company} — leaving flag set to retry.`);
    }
  }
}

// Entrypoint when run directly (GitHub Actions).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runReplyDm().catch((err) => {
    logger.error('Reply DM job failed.', err);
    process.exitCode = 1;
  });
}

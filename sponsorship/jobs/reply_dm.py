"""Phase-3 reply DM (the PERBot half of the hybrid). A Power Automate flow watches the shared inbox,
matches a sponsor's reply to its Pipeline deal, stamps Last contact + Stage `In talks`, and ticks
the deal's **Reply pending** checkbox. This job (short cron) DMs the deal's DRI(s) so they follow
up, then clears the flag.

Idempotency: clearing the flag after a successful DM makes re-runs a no-op. If a deal has DRIs but
every DM throws (transient), the flag is left set to retry next run; if no DRI is reachable at all,
the flag is cleared (with a warning) so it can't loop.

Run: `python -m sponsorship.jobs.reply_dm`
"""
from __future__ import annotations

import sys

from utils.logger import logger
from sponsorship.identity import fetch_slack_directory, notion_user_to_slack_id
from sponsorship.notion import SponsorNotion
from sponsorship.jobs.shared import make_slack_client


def run_reply_dm() -> None:
    client = make_slack_client()
    notion = SponsorNotion()

    deals = notion.query_reply_pending()
    if not deals:
        logger.info('Reply DM: nothing pending.')
        return

    notion_users_by_id = {u.id: u for u in notion.list_notion_users()}
    slack_dir = fetch_slack_directory(client)

    for deal in deals:
        resolved = 0
        sent = 0

        for notion_id in deal.dri_user_ids:
            user = notion_users_by_id.get(notion_id)
            if not user:
                continue
            slack_user_id = notion_user_to_slack_id(client, user, slack_dir)
            if not slack_user_id:
                logger.warn(f'Reply DM: no Slack match for DRI {user.name or notion_id} on {deal.company}.')
                continue
            resolved += 1
            try:
                # Post straight to the user ID — Slack opens the DM automatically, so this needs only
                # `chat:write` (not the `im:write` that conversations.open requires).
                text = (
                    f':incoming_envelope: *{deal.company}* just replied to your outreach — follow up soon! '
                    f'<{deal.url}|Open the deal>'
                )
                client.chat_postMessage(channel=slack_user_id, text=text, unfurl_links=False)
                sent += 1
            except Exception as err:
                logger.error(f'Reply DM: failed to DM DRI for {deal.company}', err)

        # Clear the flag when we sent at least one DM, or when there was no one to DM at all (so it
        # can't loop). Leave it set only when DRIs resolved but every send failed.
        if sent > 0 or resolved == 0:
            notion.clear_reply_pending(deal.id)
            if sent == 0:
                logger.warn(f'Reply DM: {deal.company} had no reachable DRI — flag cleared, no DM sent.')
            else:
                logger.info(f'Reply DM: notified {sent} DRI(s) for {deal.company}.')
        else:
            logger.warn(f'Reply DM: all DMs failed for {deal.company} — leaving flag set to retry.')


if __name__ == '__main__':
    try:
        run_reply_dm()
    except Exception as err:
        logger.error('Reply DM job failed.', err)
        sys.exit(1)

"""Win post: when a Pipeline deal reaches Stage = Won, post ONCE to #operations with the running
total toward the semester goal. Gated to Won only (no prospect/stage/touch posts — that would be
spam). Announced once per deal, ever.

Two callers: the hourly cron (`run_win_post`) and the `/sponsor won` command (which calls
`announce_won_now` for an instant post). Both claim the same Job Log key, so whichever runs first
wins and the other skips — no duplicate.

DEDUP — why it's a Notion record and not a channel marker (bug, fixed 2026-09-15): this job
re-posts every Won deal it can't find a marker for, and `already_posted` only reads the most recent
200 messages of #operations. Once a win post scrolled past that window, the deal looked
un-announced and got announced again — and the fresh post scrolled out too, so old wins kept
resurfacing at random. The Job Log claim (`sponsor-win <deal id>`, permanent) can't scroll away;
the channel marker is kept only as a secondary guard for wins posted before this existed.

Wins announced before the claim existed are seeded by a one-time `WIN_POST_BACKFILL=true` run —
see `run_win_post`.

Run: `python -m sponsorship.jobs.win_post`
"""
from __future__ import annotations

import logging
import os
import sys

from core import http
from core.config import config
from core.job_log import JobLog
from core.log import setup_logging
from core.slack import Slack
from sponsorship.notion import SponsorNotion
from sponsorship.wins import (
    announce_win_if_new,
    latest_won_note,
    resolve_dri_mentions,
    total_raised,
    win_claim_key,
)

logger = logging.getLogger(__name__)


async def run_win_post(backfill: bool | None = None) -> None:
    """WIN_POST_BACKFILL=true (one-time, at rollout): claim every currently-Won deal in the Job Log
    WITHOUT posting. Wins announced before the claim existed have no record, and the ones that
    already scrolled out of #operations' recent history would otherwise be re-announced on the next
    run — this seeds them as done. Run it once before the first normal run."""
    if backfill is None:
        backfill = (os.environ.get('WIN_POST_BACKFILL') or '').lower() == 'true'
    client = Slack.shared()
    notion = SponsorNotion()

    channel_id = await Slack.wrap(client).resolve_channel_id(config.sponsorship.win_post_channel)
    if not channel_id:
        logger.error(f'Win post: could not resolve channel "{config.sponsorship.win_post_channel}".')
        return

    won = await notion.query_won_deals()
    if not won:
        logger.info('Win post: no Won deals.')
        return

    if backfill:
        claimed = sum([1 for deal in won if await JobLog.shared().claim_once(win_claim_key(deal), 'sponsor-win')])
        logger.info(f'Win post: backfill marked {claimed}/{len(won)} Won deals as announced — nothing posted.')
        return

    # Directories for DRI shoutouts — fetched once, reused across all deals.
    notion_users_by_id = {u.id: u for u in await notion.list_notion_users()}
    slack_dir = await Slack.wrap(client).fetch_directory()

    total = total_raised(won)
    for deal in won:
        dri = await resolve_dri_mentions(client, deal.dri_user_ids, notion_users_by_id, slack_dir)
        await announce_win_if_new(client, channel_id, deal, total, dri, latest_won_note(deal))


if __name__ == '__main__':
    setup_logging()
    try:
        http.run(run_win_post())
    except Exception as err:
        logger.error('Win post job failed.', exc_info=err)
        sys.exit(1)

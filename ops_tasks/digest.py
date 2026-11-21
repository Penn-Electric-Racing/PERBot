"""Sunday 10 AM ET Ops-tasks digest — DMs ONLY, never a channel post (2026-09-11). Each Ops
member with an open task in the Ops Tasks database gets one short DM listing exactly their own
open tasks: 🔴 on anything past Due, and a "carried N wks" tag on anything assigned before the
most recent Saturday. Members with nothing open get nothing (silence is valid).

Why "everything open" rather than "assigned this week": a Status-based query can't go silent if
a meeting page is created late or a task never gets linked to a meeting, and it is the honest
picture anyway.

Idempotency: two DST cron triggers, and only the one landing on 10am ET does the work (same
pattern as the sponsorship digest). DMs post straight to the user ID.

Run: `python -m ops_tasks.digest`
"""
from __future__ import annotations

import logging
import os
import re
import sys

from core import http, utils
from core.job_log import JobLog
from core.log import setup_logging
from core.slack import Slack
from ops_tasks.blocks import build_digest_blocks, digest_footer, digest_header
from ops_tasks.format import carried_weeks, is_overdue, sort_tasks, task_line  # noqa: F401  (re-exported)
from ops_tasks.meetings import pick_meeting
from ops_tasks.notion import OpsTask, OpsTaskOwner, OpsTasksNotion

logger = logging.getLogger(__name__)

# Seed rows created so Notion would show every member's group; skipped until renamed.
PLACEHOLDER_RE = re.compile(r'^rename me', re.I)


def is_placeholder(task: OpsTask) -> bool:
    return task.title == '' or PLACEHOLDER_RE.match(task.title) is not None


async def link_orphan_tasks(notion: OpsTasksNotion, tasks: list[OpsTask], dry_run: bool = False) -> int:
    """Link open tasks that have no Meeting relation to the meeting page their date falls in (see
    meetings.py). Such tasks come from `/assign` runs before the week's page existed and from rows
    added on the old Week-filtered pages; unlinked, they never appear in any "This week" table and
    look carried over on every page. Mutates the passed tasks so the DMs sent right after use the
    linked meeting's date for "carried N wks". Returns the count."""
    orphans = [t for t in tasks if not t.meeting_ids and t.week]
    if not orphans:
        return 0
    meetings = await notion.list_meetings()
    linked = 0
    for task in orphans:
        meeting = pick_meeting(meetings, task.week or '')
        if not meeting:
            logger.info(f'Ops digest: "{task.title}" (dated {task.week}) has no meeting page to link to yet.')
            continue
        try:
            if not dry_run:
                await notion.link_meeting(task, meeting.id)
            task.meeting_ids.append(meeting.id)
            task.week = meeting.date
            linked += 1
        except Exception as err:
            logger.warning(f'Ops digest: could not link "{task.title}" to meeting {meeting.date}.', exc_info=err)
    logger.info(
        f"Ops digest: linked {linked}/{len(orphans)} unlinked task(s) to their meeting page{' (dry run)' if dry_run else ''}."
    )
    return linked


def build_digest(tasks: list[OpsTask]) -> str:
    ordered = sort_tasks(tasks)
    return '\n'.join([digest_header(ordered), *[task_line(t) for t in ordered], digest_footer()])


async def run_ops_digest(force: bool | None = None) -> None:
    if force is None:
        force = (os.environ.get('FORCE_OPS_DIGEST') or '').lower() == 'true'
    if not force and not utils.is_slot_open('Sunday', 10):
        logger.info('Ops digest: not Sunday ≥10:00 ET and not forced — skipping.')
        return
    dry_run = (os.environ.get('OPS_DIGEST_DRY_RUN') or '').lower() == 'true'
    # Late-tolerant gate + two DST crons ⇒ dedupe via the Job Log (DM jobs can't read DM history).
    if not force and not dry_run and not await JobLog.shared().claim_run('ops-tasks-digest'):
        return

    notion = OpsTasksNotion()
    open_tasks = await notion.query_open_tasks()
    real = [t for t in open_tasks if not is_placeholder(t)]
    logger.info(f'Ops digest ({utils.today_iso()}): {len(open_tasks)} open rows, {len(open_tasks) - len(real)} placeholders skipped.')
    await link_orphan_tasks(notion, real, dry_run)

    # One list per owner; a co-owned task appears in every owner's DM.
    by_owner: dict[str, tuple[OpsTaskOwner, list[OpsTask]]] = {}
    for task in real:
        if not task.owners:
            logger.warning(f'Ops digest: "{task.title}" has no Owner — nobody to DM.')
            continue
        for owner in task.owners:
            by_owner.setdefault(owner.id, (owner, []))[1].append(task)
    if not by_owner:
        logger.info('Ops digest: nobody has open tasks — nothing to send.')
        return

    client = Slack.shared()
    slack_dir = await Slack.wrap(client).fetch_directory()

    for owner, tasks in by_owner.values():
        slack_user_id = await Slack.wrap(client).notion_user_to_slack_id(owner, slack_dir)
        label = owner.name or owner.email or owner.id
        if not slack_user_id:
            logger.warning(f'Ops digest: no Slack match for {label} — skipping {len(tasks)} task(s).')
            continue
        text = build_digest(tasks)
        if dry_run:
            logger.info(f'Ops digest (dry run) → {label} ({slack_user_id}):\n{text}')
            continue
        # Blocks carry the Done / In progress / Push buttons (handled by ops_tasks/views.py);
        # `text` is the notification/fallback copy.
        await client.chat_postMessage(channel=slack_user_id, text=text, blocks=build_digest_blocks(tasks, slack_user_id), unfurl_links=False)
        logger.info(f'Ops digest: sent {len(tasks)} task(s) to {label}.')


if __name__ == '__main__':
    setup_logging()
    try:
        http.run(run_ops_digest())
    except Exception as err:
        logger.error('Ops digest job failed.', exc_info=err)
        sys.exit(1)

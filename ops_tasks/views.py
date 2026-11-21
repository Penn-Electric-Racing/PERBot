"""The Ops-task digest's buttons (Done / In progress / Push a week).

Each click: ownership check (value.u == clicker) → RE-READ the task from Notion (the DM may be a
week old) → write → rewrite just that task's blocks in the original message via response_url.
Idempotent: a second click on an already-Done task reports the state rather than writing again.
"""
from __future__ import annotations

import logging
from functools import lru_cache

from core import utils
from core.ui import Interaction, View, button
from ops_tasks.blocks import (
    OPS_ACTION_IDS,
    OPS_ACTION_RE,
    decode_value,
    replace_task_blocks,
    task_blocks,
)
from ops_tasks.notion import OpsTasksNotion

logger = logging.getLogger(__name__)

__all__ = ['OpsTaskView', 'pushed_due']


@lru_cache(maxsize=1)
def _notion() -> OpsTasksNotion:
    return OpsTasksNotion()


def pushed_due(current_due: str | None, today_iso: str | None = None) -> str:
    """Push a week: from the later of today and the current due date, so an overdue task lands
    next week, not still in the past."""
    today = today_iso or utils.today_iso()
    base = current_due if current_due and current_due > today else today
    return utils.iso_add_days(base, 7)


class OpsTaskView(View):
    @button(OPS_ACTION_RE)
    def ops_task_button(self, interaction: Interaction) -> None:
        action_id = interaction.action_id
        value = decode_value(interaction.value)
        clicker = interaction.user_id
        if not value or not clicker:
            return
        if clicker != value.u:
            interaction.whisper("That task list isn't yours — ask the owner to update it.")
            return

        notion = _notion()
        try:
            task = notion.fetch_task(value.t)
            settled = False
            if task.status == 'Done':
                note = '✅ Already Done in Notion'
                settled = True
            elif action_id == OPS_ACTION_IDS['done']:
                notion.set_status(task.id, 'Done')
                task = task.replace(status='Done')
                note = f'✅ Done · {utils.now_time()} via Slack'
                settled = True
            elif action_id == OPS_ACTION_IDS['progress']:
                notion.set_status(task.id, 'In progress')
                task = task.replace(status='In progress')
                note = f'🚧 In progress · {utils.now_time()} via Slack'
            else:
                due = pushed_due(task.due)
                notion.set_due(task.id, due)
                task = task.replace(due=due)
                note = f'⏭ Pushed to {due} · {utils.now_time()} via Slack'

            existing = interaction.message_blocks
            replacement = task_blocks(task, value.u, note=note, settled=settled)
            if existing is not None:
                interaction.respond(replace_original=True, blocks=replace_task_blocks(existing, task.id, replacement), text=f'{task.title}: {note}')
            else:
                interaction.whisper(f'{task.title}: {note}')
            logger.info(f'Ops task button: {clicker} → {action_id} on "{task.title}".')
        except Exception as err:
            logger.error(f'Ops task button {action_id} failed', exc_info=err)
            interaction.whisper('✗ Could not update that task in Notion — try again or edit it in Notion.')

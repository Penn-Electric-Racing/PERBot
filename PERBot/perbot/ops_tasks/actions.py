"""Button handlers for the Ops-tasks digest (registered from app.py; Socket Mode delivers the
clicks, so "Interactivity" just has to be switched on in the Slack app config).

Each click: ack within 3s → ownership check (value.u == clicker) → RE-READ the task from Notion
(the DM may be a week old) → write → rewrite just that task's blocks in the original message
via response_url. Idempotent: a second click on an already-Done task reports the state rather
than writing again.
"""
from __future__ import annotations

from functools import lru_cache

from slack_bolt import App

from ..sponsorship.dates import iso_add_days, now_time_et, today_iso_et
from ..utils.logger import logger
from .blocks import OPS_ACTION_IDS, OPS_ACTION_RE, decode_value, replace_task_blocks, task_blocks
from .notion import OpsTasksNotion


@lru_cache(maxsize=1)
def _notion() -> OpsTasksNotion:
    return OpsTasksNotion()


def pushed_due(current_due: str | None, today_iso: str | None = None) -> str:
    """Push a week: from the later of today and the current due date, so an overdue task lands
    next week, not still in the past."""
    today = today_iso or today_iso_et()
    base = current_due if current_due and current_due > today else today
    return iso_add_days(base, 7)


def register_ops_task_actions(app: App) -> None:
    @app.action(OPS_ACTION_RE)
    def _ops_task_button(ack, body, action, respond):
        ack()
        action_id = action.get('action_id', '')
        value = decode_value(action.get('value'))
        clicker = (body.get('user') or {}).get('id')
        if not value or not clicker:
            return
        if clicker != value.u:
            respond(response_type='ephemeral', replace_original=False, text="That task list isn't yours — ask the owner to update it.")
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
                note = f'✅ Done · {now_time_et()} via Slack'
                settled = True
            elif action_id == OPS_ACTION_IDS['progress']:
                notion.set_status(task.id, 'In progress')
                task = task.replace(status='In progress')
                note = f'🚧 In progress · {now_time_et()} via Slack'
            else:
                due = pushed_due(task.due)
                notion.set_due(task.id, due)
                task = task.replace(due=due)
                note = f'⏭ Pushed to {due} · {now_time_et()} via Slack'

            existing = (body.get('message') or {}).get('blocks')
            replacement = task_blocks(task, value.u, note=note, settled=settled)
            if existing is not None:
                respond(replace_original=True, blocks=replace_task_blocks(existing, task.id, replacement), text=f'{task.title}: {note}')
            else:
                respond(response_type='ephemeral', replace_original=False, text=f'{task.title}: {note}')
            logger.info(f'Ops task button: {clicker} → {action_id} on "{task.title}".')
        except Exception as err:
            logger.error(f'Ops task button {action_id} failed', err)
            respond(
                response_type='ephemeral',
                replace_original=False,
                text='✗ Could not update that task in Notion — try again or edit it in Notion.',
            )

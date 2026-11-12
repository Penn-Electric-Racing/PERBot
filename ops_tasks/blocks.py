"""Block Kit for the Ops-tasks digest DM: one section per task followed by a row of buttons (Done
/ In progress / Push a week). Clicks are handled by actions.py in the Bolt app (Socket Mode),
which writes to Notion and rewrites the DM in place — Slack is a second way to update, Notion
stays the system of record.

Button values carry the task id AND the Slack user the DM was sent to, so a click is honoured
only from that user (cheap ownership check that needs no directory lookup).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from config import config
from ops_tasks.format import is_overdue, sort_tasks, task_line
from ops_tasks.notion import OpsTask

OPS_ACTION_IDS = {'done': 'ops_task_done', 'progress': 'ops_task_progress', 'push': 'ops_task_push'}
OPS_ACTION_RE = re.compile(r'^ops_task_(done|progress|push)$')


@dataclass
class OpsButtonValue:
    # Notion page id of the task.
    t: str
    # Slack user id the buttons were rendered for.
    u: str


def encode_value(v: OpsButtonValue) -> str:
    return json.dumps({'t': v.t, 'u': v.u}, separators=(',', ':'))


def decode_value(raw: str | None) -> OpsButtonValue | None:
    try:
        v = json.loads(raw or '')
    except ValueError:
        return None
    if isinstance(v, dict) and isinstance(v.get('t'), str) and isinstance(v.get('u'), str):
        return OpsButtonValue(v['t'], v['u'])
    return None


def section_block_id(task_id: str) -> str:
    return f'ops_task:{task_id}'


def actions_block_id(task_id: str) -> str:
    return f'ops_task_actions:{task_id}'


def _button(text: str, action_id: str, value: OpsButtonValue, style: str | None = None) -> dict[str, Any]:
    b: dict[str, Any] = {
        'type': 'button',
        'text': {'type': 'plain_text', 'text': text, 'emoji': True},
        'action_id': action_id,
        'value': encode_value(value),
    }
    if style:
        b['style'] = style
    return b


def task_blocks(task: OpsTask, slack_user_id: str, note: str | None = None, settled: bool = False) -> list[dict[str, Any]]:
    """The two blocks for one task. `note` (e.g. "✅ Done · 1:42 PM") is appended to the line after
    a Slack update; `settled` drops the buttons (task is Done)."""
    value = OpsButtonValue(task.id, slack_user_id)
    bare = re.sub(r'^• ', '', task_line(task))
    line = f'~{bare}~' if settled else bare
    text = f'{line}\n{note}' if note else line
    blocks: list[dict[str, Any]] = [{'type': 'section', 'block_id': section_block_id(task.id), 'text': {'type': 'mrkdwn', 'text': text}}]
    if not settled:
        elements = [_button('✅ Done', OPS_ACTION_IDS['done'], value, 'primary')]
        if task.status != 'In progress':
            elements.append(_button('🚧 In progress', OPS_ACTION_IDS['progress'], value))
        elements.append(_button('⏭ Push a week', OPS_ACTION_IDS['push'], value))
        blocks.append({'type': 'actions', 'block_id': actions_block_id(task.id), 'elements': elements})
    return blocks


def digest_header(tasks: list[OpsTask]) -> str:
    overdue = sum(1 for t in tasks if is_overdue(t))
    return f":clipboard: *Your open Ops tasks ({len(tasks)}{f', {overdue} overdue' if overdue > 0 else ''})*"


def digest_footer() -> str:
    return (
        "_Update here with the buttons or in Notion — Saturday's walkthrough runs off this list. "
        f'<{config.ops_tasks.my_open_view_url}|My open>_'
    )


def build_digest_blocks(tasks: list[OpsTask], slack_user_id: str) -> list[dict[str, Any]]:
    """Full digest as blocks (header + tasks + footer). Pair with build_digest() text as the fallback."""
    ordered = sort_tasks(tasks)
    return [
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': digest_header(ordered)}},
        *[b for t in ordered for b in task_blocks(t, slack_user_id)],
        {'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': digest_footer()}]},
    ]


def replace_task_blocks(blocks: list[dict[str, Any]], task_id: str, replacement: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Replace one task's blocks inside an existing message (by block_id). Returns a new list."""
    out: list[dict[str, Any]] = []
    inserted = False
    for b in blocks:
        bid = (b or {}).get('block_id')
        if bid == section_block_id(task_id):
            if not inserted:
                out.extend(replacement)
                inserted = True
            continue
        if bid == actions_block_id(task_id):
            continue
        out.append(b)
    return out if inserted else [*blocks, *replacement]


def assignment_dm_blocks(task: OpsTask, assigner_slack_id: str, assignee_slack_id: str) -> list[dict[str, Any]]:
    """The DM an assignee gets from `/assign`: who assigned it + the task with its buttons."""
    return [
        {'type': 'section', 'text': {'type': 'mrkdwn', 'text': f':pushpin: <@{assigner_slack_id}> assigned you a task:'}},
        *task_blocks(task, assignee_slack_id),
        {
            'type': 'context',
            'elements': [
                {
                    'type': 'mrkdwn',
                    'text': f"_It's in the Ops Tasks list — Sunday's digest will include it. <{config.ops_tasks.my_open_view_url}|My open>_",
                }
            ],
        },
    ]

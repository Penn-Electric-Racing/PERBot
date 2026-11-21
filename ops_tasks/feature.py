"""Ops tasks in Slack: `/assign`, its form, the "Assign as Ops task" message shortcut, and the
digest's buttons (views.OpsTaskView). The weekly digest itself is a GitHub Actions job
(`python -m ops_tasks.digest`).
"""
from __future__ import annotations

import json
import logging
from typing import Any

from core.feature import Feature, command, shortcut
from core.ui import modal
from ops_tasks.assign import (
    ASSIGN_MODAL_ID,
    ASSIGN_SHORTCUT_ID,
    USAGE,
    assign_modal,
    create_and_announce,
    dedupe,
    next_saturday_iso,
    parse_assign,
    resolve_owners,
    task_from_message,
)
from ops_tasks.views import OpsTaskView

logger = logging.getLogger(__name__)

__all__ = ['OpsTasks']


class OpsTasks(Feature):
    name = 'ops-tasks'

    def __init__(self) -> None:
        self.views = [OpsTaskView()]

    @command('/assign')
    async def assign(self, ack, command, respond, client) -> None:
        parsed = parse_assign(command.get('text') or '')
        user_id = command['user_id']
        wants_form = not parsed.task or (not parsed.slack_ids and not parsed.handles and not parsed.self)
        if wants_form:
            # Open the form immediately (trigger_id is only good for 3s) — no Notion calls first.
            await ack()
            try:
                await client.views_open(
                    trigger_id=command['trigger_id'],
                    view=assign_modal(
                        {'ch': command['channel_id'], 'a': user_id},
                        [user_id] if parsed.self else parsed.slack_ids,
                        parsed.task,
                        parsed.due_iso,
                    ),
                )
            except Exception as err:
                logger.error('/assign: could not open form', exc_info=err)
                await respond(response_type='ephemeral', text=USAGE)
            return

        await ack()
        try:
            slack_ids = dedupe([user_id, *parsed.slack_ids]) if parsed.self else parsed.slack_ids
            notion_ids, resolved_slack_ids, unresolved = await resolve_owners(client, slack_ids, parsed.handles)
            if not notion_ids:
                await respond(
                    response_type='ephemeral',
                    text=f"I couldn't match {', '.join(unresolved) or 'that person'} to a Notion account. Pick them from the @ popup so it turns into a blue chip, or run plain `/assign` for the form.",
                )
                return
            _, public_text = await create_and_announce(
                client, user_id, resolved_slack_ids, notion_ids, parsed.task, parsed.due_iso or next_saturday_iso()
            )
            await respond(response_type='in_channel', text=public_text)
            warnings: list[str] = []
            if unresolved:
                warnings.append(f"Couldn't match {', '.join(unresolved)} — not added.")
            if parsed.bad_date:
                warnings.append(
                    f'Didn\'t understand the date "{parsed.bad_date}" — used next Saturday. Try "by Friday" or "by 9/20".'
                )
            if warnings:
                await respond(response_type='ephemeral', text=' '.join(warnings))
        except Exception as err:
            logger.error('/assign failed', exc_info=err)
            await respond(response_type='ephemeral', text='✗ Something went wrong creating that task. Check the PERBot logs.')

    @modal(ASSIGN_MODAL_ID)
    async def assign_submit(self, ack, body, view, client) -> None:
        values = (view.get('state') or {}).get('values') or {}
        users: list[str] = ((values.get('owners') or {}).get('owners') or {}).get('selected_users') or []
        task = str(((values.get('task') or {}).get('task') or {}).get('value') or '').strip()
        due_iso: str | None = ((values.get('due') or {}).get('due') or {}).get('selected_date')
        if not users or not task:
            errors: dict[str, str] = {}
            if not users:
                errors['owners'] = 'Pick at least one person.'
            if not task:
                errors['task'] = 'What needs doing?'
            await ack(response_action='errors', errors=errors)
            return
        await ack()
        meta = json.loads(view.get('private_metadata') or '{}')
        assigner = (body.get('user') or {}).get('id') or meta.get('a')
        try:
            notion_ids, resolved_slack_ids, unresolved = await resolve_owners(client, users, [])
            if not notion_ids:
                await client.chat_postMessage(
                    channel=assigner,
                    text=f"I couldn't match {', '.join(unresolved)} to a Notion account, so nothing was assigned.",
                )
                return
            _, public_text = await create_and_announce(
                client, assigner, resolved_slack_ids, notion_ids, task, due_iso or next_saturday_iso()
            )
            # Public post in the channel the command was run in; if the bot can't post there (a
            # private channel it isn't in), tell the assigner privately instead.
            try:
                kwargs: dict[str, Any] = {'channel': meta.get('ch'), 'text': public_text, 'unfurl_links': False}
                if meta.get('ts'):
                    kwargs['thread_ts'] = meta['ts']
                await client.chat_postMessage(**kwargs)
            except Exception:
                await client.chat_postMessage(
                    channel=assigner,
                    text=f"{public_text}\n_(couldn't post in that channel — invite PERBot to it)_",
                    unfurl_links=False,
                )
            if unresolved:
                await client.chat_postMessage(channel=assigner, text=f"Couldn't match {', '.join(unresolved)} to Notion — not added.")
        except Exception as err:
            logger.error('/assign form failed', exc_info=err)
            await client.chat_postMessage(channel=assigner, text='✗ Something went wrong creating that task. Check the PERBot logs.')

    @shortcut({'callback_id': ASSIGN_SHORTCUT_ID, 'type': 'message_action'})
    async def assign_shortcut(self, ack, shortcut, client) -> None:
        await ack()
        msg = shortcut.get('message') or {}
        channel = (shortcut.get('channel') or {}).get('id') or ''
        thread_ts = msg.get('thread_ts') or msg.get('ts')
        # Pre-fill "who" with the message's author when it's a person (not a bot post) — the usual
        # case is "assign this to the person who raised it"; easy to change in the form.
        author = msg.get('user') if isinstance(msg.get('user'), str) and not msg.get('bot_id') else None
        try:
            meta: dict[str, Any] = {'ch': channel, 'a': (shortcut.get('user') or {}).get('id') or ''}
            if thread_ts:
                meta['ts'] = thread_ts
            await client.views_open(
                trigger_id=shortcut['trigger_id'],
                view=assign_modal(meta, [author] if author else [], task_from_message(str(msg.get('text') or '')), None),
            )
        except Exception as err:
            logger.error('Assign shortcut: could not open form', exc_info=err)

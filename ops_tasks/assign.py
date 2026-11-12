"""`/assign @person <task> [by <date>]` — put a task on someone's Ops list from Slack
(2026-09-13). Anyone can assign. Creates an Ops Tasks row (Status Not started, Due = the date
given, else NEXT SATURDAY — the meeting convention), then:
  • posts PUBLICLY in the channel the command was run in ("📌 @A assigned @B: …"), and
  • DMs each assignee the task with the Done / In progress / Push buttons.
If the person or the task text is missing, PERBot opens a small form (person picker, task,
date) pre-filled with whatever it could parse; plain `/assign` opens it empty. Mentions arrive
as real `<@U…>` only if the command has link-escaping on; typed `@handles` are resolved via the
Slack directory (same as /sponsor). `me` = yourself.

THREADS: Slack doesn't allow custom slash commands inside threads (platform rule), so two
thread-friendly entry points share the same code path:
  • a MESSAGE SHORTCUT ("Assign as Ops task" in a message's ··· menu, threads included) that
    opens the form pre-filled with that message's text and author; and
  • `@PERBot assign @person <task> [by <date>]` typed in the thread (app_mention).
Both post the public confirmation as a reply IN that thread.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date
from functools import lru_cache
from typing import Any

from slack_bolt import App
from slack_sdk import WebClient

from sponsorship.dates import iso_add_days, today_iso_et, weekday_utc
from sponsorship.slack import MENTION_RE, extract_plain_handles, resolve_assignees, unwrap_slack_links
from utils.logger import logger
from ops_tasks.blocks import assignment_dm_blocks
from ops_tasks.format import task_line
from ops_tasks.notion import OpsTask, OpsTasksNotion

ASSIGN_MODAL_ID = 'ops_assign_modal'
ASSIGN_SHORTCUT_ID = 'ops_assign_shortcut'


@lru_cache(maxsize=1)
def _notion() -> OpsTasksNotion:
    return OpsTasksNotion()


@dataclass
class ParsedAssign:
    # Real Slack mentions.
    slack_ids: list[str]
    # Typed @handles (not real mentions) — resolved via the directory.
    handles: list[str]
    # `me` was used.
    self: bool
    task: str
    # YYYY-MM-DD parsed from a trailing "by <date>" / "due <date>", or None.
    due_iso: str | None
    # The raw date phrase when one was given but not understood.
    bad_date: str | None


def next_saturday_iso(today_iso: str | None = None) -> str:
    """Next Saturday (ET) — the default Due; on a Saturday it's the following one."""
    today = today_iso or today_iso_et()
    days = (6 - weekday_utc(today) + 7) % 7 or 7
    return iso_add_days(today, days)


WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']


def parse_due_date(phrase: str, today_iso: str | None = None) -> str | None:
    """"friday" · "next sat" · "tomorrow" · "9/20" · "2026-09-20" → YYYY-MM-DD (None if not understood)."""
    today = today_iso or today_iso_et()
    t = re.sub(r'\.$', '', re.sub(r'^(next|this)\s+', '', phrase.strip().lower()))
    if not t:
        return None
    if t == 'today':
        return today
    if t == 'tomorrow':
        return iso_add_days(today, 1)
    if t in ('eow', 'end of week'):
        return next_saturday_iso(today)
    wd = next((i for i, w in enumerate(WEEKDAYS) if w == t or w[:3] == t), -1)
    if wd >= 0:
        return iso_add_days(today, (wd - weekday_utc(today) + 7) % 7 or 7)
    if re.fullmatch(r'(\d{4})-(\d{2})-(\d{2})', t):
        return t
    m = re.fullmatch(r'(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?', t)
    if m:
        y = m.group(3)
        year = (2000 + int(y) if len(y) == 2 else int(y)) if y else int(today[:4])
        iso = f'{year}-{int(m.group(1)):02d}-{int(m.group(2)):02d}'
        try:
            date.fromisoformat(iso)
        except ValueError:
            return None
        # A month/day already past this year means next year (e.g. "1/10" typed in December).
        if not y and iso < today:
            nxt = f'{year + 1}{iso[4:]}'
            try:
                return iso_add_days(nxt, 0)
            except ValueError:
                return None
        return iso
    return None


def parse_assign(raw: str, today_iso: str | None = None) -> ParsedAssign:
    today = today_iso or today_iso_et()
    text = unwrap_slack_links(raw).strip()
    slack_ids = [m.group(1) for m in MENTION_RE.finditer(text)]
    text = MENTION_RE.sub(' ', text)
    handles, text = extract_plain_handles(text)
    is_self = False
    if re.match(r'^me\b', text, re.I):
        is_self = True
        text = re.sub(r'^me\b[:,]?\s*', '', text, flags=re.I)
    due_iso: str | None = None
    bad_date: str | None = None
    by = re.search(r'\s+(?:by|due)\s+([^,]+?)\s*$', text, re.I)
    if by:
        parsed = parse_due_date(by.group(1), today)
        if parsed:
            due_iso = parsed
            text = text[: by.start()].strip()
        else:
            bad_date = by.group(1).strip()
    task = re.sub(r'\s+', ' ', re.sub(r'[\s,;:\-–—]+$', '', re.sub(r'^[:\-–—]\s*', '', text))).strip()
    return ParsedAssign(slack_ids, handles, is_self, task, due_iso, bad_date)


def _short_date(iso: str) -> str:
    """"Sat, 9/20" (en-US weekday short + numeric month/day)."""
    d = date.fromisoformat(iso[:10])
    return f"{d.strftime('%a')}, {d.month}/{d.day}"


def _create_and_announce(
    client: WebClient,
    assigner_slack_id: str,
    assignee_slack_ids: list[str],
    owner_notion_ids: list[str],
    task_title: str,
    due_iso: str | None,
) -> tuple[OpsTask, str]:
    """Create the task, post publicly, DM each assignee. Returns (task, public line)."""
    notion = _notion()
    # Link to the week's meeting page so the task shows under "This week" there. The page is
    # created ahead of time by the repeating template; if it isn't there yet the task is created
    # unlinked and the Sunday digest links it once the page exists.
    meeting_id: str | None = None
    try:
        meeting = notion.meeting_for_date(today_iso_et())
        meeting_id = meeting.id if meeting else None
        if not meeting_id:
            logger.warn(f'/assign: no Ops Meetings page for the week of {today_iso_et()} yet — creating "{task_title}" unlinked.')
    except Exception as err:
        logger.warn('/assign: meeting lookup failed — creating the task unlinked.', err)
    task = notion.create_task(task_title, owner_notion_ids, due_iso, meeting_id)
    who = ', '.join(f'<@{i}>' for i in assignee_slack_ids)
    due_part = f' · due {_short_date(task.due)}' if task.due else ''
    public_text = f':pushpin: <@{assigner_slack_id}> assigned {who}: *{task.title}*{due_part} · <{task.url}|Open in Notion>'
    for assignee in assignee_slack_ids:
        try:
            client.chat_postMessage(
                channel=assignee,
                text=f'<@{assigner_slack_id}> assigned you: {task_line(task)}',
                blocks=assignment_dm_blocks(task, assigner_slack_id, assignee),
                unfurl_links=False,
            )
        except Exception as err:
            logger.error(f'/assign: DM to {assignee} failed', err)
    return task, public_text


def _resolve_owners(client: WebClient, slack_ids: list[str], handles: list[str]) -> tuple[list[str], list[str], list[str]]:
    """Resolve Slack mentions/handles → Notion owners; returns Slack ids alongside for the DMs."""
    notion_ids, labels, unresolved = resolve_assignees(client, slack_ids, handles)
    # labels are `<@U…>` for every resolved person, in the same order as notion_ids.
    resolved_slack_ids = [re.sub(r'^<@|>$', '', label) for label in labels]
    return notion_ids, resolved_slack_ids, unresolved


def _assign_modal(meta: dict[str, Any], users: list[str], task: str, due_iso: str | None) -> dict[str, Any]:
    owners_el: dict[str, Any] = {
        'type': 'multi_users_select',
        'action_id': 'owners',
        'placeholder': {'type': 'plain_text', 'text': 'Pick one or more people'},
    }
    if users:
        owners_el['initial_users'] = users
    task_el: dict[str, Any] = {
        'type': 'plain_text_input',
        'action_id': 'task',
        'max_length': 200,
        'placeholder': {'type': 'plain_text', 'text': 'Email Toray about the carbon sponsorship'},
    }
    if task:
        task_el['initial_value'] = task
    return {
        'type': 'modal',
        'callback_id': ASSIGN_MODAL_ID,
        'private_metadata': json.dumps(meta),
        'title': {'type': 'plain_text', 'text': 'Assign an Ops task'},
        'submit': {'type': 'plain_text', 'text': 'Assign'},
        'close': {'type': 'plain_text', 'text': 'Cancel'},
        'blocks': [
            {'type': 'input', 'block_id': 'owners', 'label': {'type': 'plain_text', 'text': 'Who'}, 'element': owners_el},
            {'type': 'input', 'block_id': 'task', 'label': {'type': 'plain_text', 'text': 'Task'}, 'element': task_el},
            {
                'type': 'input',
                'block_id': 'due',
                'optional': True,
                'label': {'type': 'plain_text', 'text': 'Due'},
                'hint': {'type': 'plain_text', 'text': 'Defaults to next Saturday (the meeting).'},
                'element': {'type': 'datepicker', 'action_id': 'due', 'initial_date': due_iso or next_saturday_iso()},
            },
        ],
    }


USAGE = (
    'Usage: `/assign @person <task> [by <date>]` — e.g. `/assign @koseli Email Toray about carbon by Friday`. '
    'Several people are fine; `me` works too. No date → due next Saturday. Plain `/assign` opens a form.'
)


def _dedupe(ids: list[str]) -> list[str]:
    return list(dict.fromkeys(ids))


def register_assign_command(app: App) -> None:
    @app.command('/assign')
    def _assign(ack, command, respond, client):
        parsed = parse_assign(command.get('text') or '')
        user_id = command['user_id']
        wants_form = not parsed.task or (not parsed.slack_ids and not parsed.handles and not parsed.self)
        if wants_form:
            # Open the form immediately (trigger_id is only good for 3s) — no Notion calls first.
            ack()
            try:
                client.views_open(
                    trigger_id=command['trigger_id'],
                    view=_assign_modal(
                        {'ch': command['channel_id'], 'a': user_id},
                        [user_id] if parsed.self else parsed.slack_ids,
                        parsed.task,
                        parsed.due_iso,
                    ),
                )
            except Exception as err:
                logger.error('/assign: could not open form', err)
                respond(response_type='ephemeral', text=USAGE)
            return

        ack()
        try:
            slack_ids = _dedupe([user_id, *parsed.slack_ids]) if parsed.self else parsed.slack_ids
            notion_ids, resolved_slack_ids, unresolved = _resolve_owners(client, slack_ids, parsed.handles)
            if not notion_ids:
                respond(
                    response_type='ephemeral',
                    text=f"I couldn't match {', '.join(unresolved) or 'that person'} to a Notion account. Pick them from the @ popup so it turns into a blue chip, or run plain `/assign` for the form.",
                )
                return
            _, public_text = _create_and_announce(
                client, user_id, resolved_slack_ids, notion_ids, parsed.task, parsed.due_iso or next_saturday_iso()
            )
            respond(response_type='in_channel', text=public_text)
            warnings: list[str] = []
            if unresolved:
                warnings.append(f"Couldn't match {', '.join(unresolved)} — not added.")
            if parsed.bad_date:
                warnings.append(
                    f'Didn\'t understand the date "{parsed.bad_date}" — used next Saturday. Try "by Friday" or "by 9/20".'
                )
            if warnings:
                respond(response_type='ephemeral', text=' '.join(warnings))
        except Exception as err:
            logger.error('/assign failed', err)
            respond(response_type='ephemeral', text='✗ Something went wrong creating that task. Check the PERBot logs.')

    @app.view(ASSIGN_MODAL_ID)
    def _assign_submit(ack, body, view, client):
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
            ack(response_action='errors', errors=errors)
            return
        ack()
        meta = json.loads(view.get('private_metadata') or '{}')
        assigner = (body.get('user') or {}).get('id') or meta.get('a')
        try:
            notion_ids, resolved_slack_ids, unresolved = _resolve_owners(client, users, [])
            if not notion_ids:
                client.chat_postMessage(
                    channel=assigner,
                    text=f"I couldn't match {', '.join(unresolved)} to a Notion account, so nothing was assigned.",
                )
                return
            _, public_text = _create_and_announce(
                client, assigner, resolved_slack_ids, notion_ids, task, due_iso or next_saturday_iso()
            )
            # Public post in the channel the command was run in; if the bot can't post there (a
            # private channel it isn't in), tell the assigner privately instead.
            try:
                kwargs: dict[str, Any] = {'channel': meta.get('ch'), 'text': public_text, 'unfurl_links': False}
                if meta.get('ts'):
                    kwargs['thread_ts'] = meta['ts']
                client.chat_postMessage(**kwargs)
            except Exception:
                client.chat_postMessage(
                    channel=assigner,
                    text=f"{public_text}\n_(couldn't post in that channel — invite PERBot to it)_",
                    unfurl_links=False,
                )
            if unresolved:
                client.chat_postMessage(channel=assigner, text=f"Couldn't match {', '.join(unresolved)} to Notion — not added.")
        except Exception as err:
            logger.error('/assign form failed', err)
            client.chat_postMessage(channel=assigner, text='✗ Something went wrong creating that task. Check the PERBot logs.')


def _task_from_message(text: str) -> str:
    """Message text → a sensible task title (mentions/links unwrapped, whitespace collapsed, capped)."""
    return re.sub(r'\s+', ' ', MENTION_RE.sub('', unwrap_slack_links(text))).strip()[:200]


def register_assign_shortcut(app: App) -> None:
    """"Assign as Ops task" message shortcut — works from any message, including thread replies."""

    @app.shortcut({'callback_id': ASSIGN_SHORTCUT_ID, 'type': 'message_action'})
    def _assign_shortcut(ack, shortcut, client):
        ack()
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
            client.views_open(
                trigger_id=shortcut['trigger_id'],
                view=_assign_modal(meta, [author] if author else [], _task_from_message(str(msg.get('text') or '')), None),
            )
        except Exception as err:
            logger.error('Assign shortcut: could not open form', err)


def assign_from_mention(client: WebClient, text: str, user_id: str, channel: str, thread_ts: str | None = None) -> None:
    """`@PERBot assign @person <task> [by <date>]` — the in-thread text path (app_mention).
    `text` must already have the bot's own mention removed but OTHER mentions intact. There's no
    trigger_id on an event, so missing info gets a usage reply in the thread instead of the form."""
    body = re.sub(r'^\s*assign\b[:,]?\s*', '', text, flags=re.I)
    parsed = parse_assign(body)

    def reply(t: str) -> None:
        kwargs: dict[str, Any] = {'channel': channel, 'text': t, 'unfurl_links': False}
        if thread_ts:
            kwargs['thread_ts'] = thread_ts
        client.chat_postMessage(**kwargs)

    if not parsed.task or (not parsed.slack_ids and not parsed.handles and not parsed.self):
        usage = USAGE.replace('Usage: `/assign', 'Usage: `@PERBot assign').replace(
            ' Plain `/assign` opens a form.',
            ' (Slash commands don’t work in threads — the ··· menu → *Assign as Ops task* opens the form.)',
        )
        reply(f'<@{user_id}> {usage}')
        return
    try:
        slack_ids = _dedupe([user_id, *parsed.slack_ids]) if parsed.self else parsed.slack_ids
        notion_ids, resolved_slack_ids, unresolved = _resolve_owners(client, slack_ids, parsed.handles)
        if not notion_ids:
            reply(f"<@{user_id}> I couldn't match {', '.join(unresolved) or 'that person'} to a Notion account — nothing assigned.")
            return
        _, public_text = _create_and_announce(
            client, user_id, resolved_slack_ids, notion_ids, parsed.task, parsed.due_iso or next_saturday_iso()
        )
        notes: list[str] = []
        if unresolved:
            notes.append(f"(couldn't match {', '.join(unresolved)} — not added)")
        if parsed.bad_date:
            notes.append(f'(didn\'t understand "{parsed.bad_date}" — used next Saturday)')
        reply(f"{public_text}\n_{' '.join(notes)}_" if notes else public_text)
    except Exception as err:
        logger.error('assign-from-mention failed', err)
        reply(f'<@{user_id}> ✗ Something went wrong creating that task. Check the PERBot logs.')

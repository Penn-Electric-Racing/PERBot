"""Button + form handlers for deal lists (stale DM, weekly digest, `/sponsor me`). Registered from
app.py; Socket Mode delivers the interactions.

Stage buttons (Contacted / In talks / Lost): ack → ownership check → re-read the deal → `set_stage`
(which also stamps `Contacted at` on the first move out of Prospect — the weekly quota signal) with
a dated "via Slack" note → rewrite that deal's blocks in the original message. Won and Log touch
need input, so they open a small modal; on submit we write to Notion and post a confirmation back
to where the button lived (the original message can't be edited from a modal submission — its
buttons stay, and a later click reports "already Won").

Lost leaves a row of reason buttons in place of the stage buttons. A tap writes `Loss reason`, and
skipping it is fine. The Wednesday DM's "gone cold" buttons (Still waiting / No reply, close it /
They said no) resolve deals that sat at Contacted for 30+ days, so nobody has to decide on their
own when "no reply" has become "lost".
"""
from __future__ import annotations

import dataclasses
import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Callable

from slack_sdk.web.async_client import AsyncWebClient

from core import http, utils
from core.config import config
from core.ui import Interaction, View, button, modal
from sponsorship.deal_blocks import (
    APPLY_VIA_MODAL_ID,
    DEAL_ACTION_IDS,
    DEAL_COLD_ACTION_RE,
    DEAL_LOSS_ACTION_RE,
    DEAL_STAGE_ACTION_RE,
    TOUCH_MODAL_ID,
    WON_MODAL_ID,
    DealButtonValue,
    decode_deal_value,
    finalize_deal_blocks,
    loss_reason_for_action,
    replace_deal_blocks,
)
from sponsorship.models import WON_KINDS, LossReason, PipelineRow, Stage
from sponsorship.next_actions import CHECK_REPLY_ACTION, next_action_after_touch
from sponsorship.notion import SponsorNotion
from sponsorship.slack import parse_won
from sponsorship.wins import announce_won_now, fmt_usd

logger = logging.getLogger(__name__)

__all__ = [
    'ModalMeta', 'STAGE_FOR_ACTION', 'STAGE_EMOJI', 'COLD_WAIT_DAYS', 'LOSS_REASON_FOLLOW_UP',
    'NOT_YOURS', 'DealView',
]

notion = SponsorNotion()

Respond = Callable[..., Any]


@dataclass
class ModalMeta:
    d: str  # deal id
    u: str  # Slack user
    ch: str = ''  # channel/DM the button lived in
    eph: bool = False  # the button was on an ephemeral message
    ru: str = ''  # response_url (ephemeral follow-ups)
    b: str | None = None  # Bank row id (Apply via modal only)

    @classmethod
    def load(cls, raw: str | None) -> ModalMeta:
        try:
            v = json.loads(raw or '{}')
        except ValueError:
            v = {}
        names = {f.name for f in dataclasses.fields(cls)}
        v = {k: val for k, val in (v if isinstance(v, dict) else {}).items() if k in names}
        return cls(**{'d': '', 'u': '', **v})

    def dump(self) -> str:
        data = {k: v for k, v in dataclasses.asdict(self).items() if v is not None}
        return json.dumps(data, separators=(',', ':'))


STAGE_FOR_ACTION: dict[str, Stage] = {
    DEAL_ACTION_IDS['contacted']: 'Contacted',
    DEAL_ACTION_IDS['in_talks']: 'In talks',
    DEAL_ACTION_IDS['lost']: 'Lost',
}
STAGE_EMOJI = {'Contacted': '📨', 'In talks': '💬', 'Won': '🏆', 'Lost': '❌'}


def _container_meta(body: dict[str, Any], value: DealButtonValue) -> ModalMeta:
    container = body.get('container') or {}
    return ModalMeta(
        d=value.d,
        u=value.u,
        ch=container.get('channel_id') or (body.get('channel') or {}).get('id') or '',
        eph=bool(container.get('is_ephemeral')),
        ru=body.get('response_url') or '',
    )


async def _confirm(client: AsyncWebClient, meta: ModalMeta, text: str) -> None:
    """Confirmation after a modal submit: ephemeral via response_url where the button was
    ephemeral, else a DM/channel post."""
    if meta.eph and meta.ru:
        await http.post(
            meta.ru, json={'response_type': 'ephemeral', 'replace_original': False, 'text': text}, timeout=15
        )
        return
    await client.chat_postMessage(channel=meta.ch or meta.u, text=text, unfurl_links=False)


async def _eph(respond: Respond, text: str) -> None:
    await respond(response_type='ephemeral', replace_original=False, text=text)


# Days a "Still waiting" pushes the next check out; the stale DM surfaces it when due.
COLD_WAIT_DAYS = 14

# What each reason does beyond being recorded, shown after the tap.
LOSS_REASON_FOLLOW_UP: dict[LossReason, str] = {
    'Bounced or wrong contact': 'not really a no. Found someone else? Move it back with `/sponsor stage <company> Contacted`',
    'No budget or capacity right now': 'worth another try next season',
}


async def _rewrite_deal(
    respond: Respond, body: dict[str, Any], updated: PipelineRow, slack_user_id: str, note: str, previous: str | None
) -> None:
    """Rewrite the deal's blocks in place when the click came from a message, else answer ephemerally."""
    existing = (body.get('message') or {}).get('blocks')
    if existing:
        await respond(
            replace_original=True,
            blocks=replace_deal_blocks(existing, updated, slack_user_id, note, previous),
            text=f'{updated.company}: {note}',
        )
    else:
        await _eph(respond, f'{updated.company}: {note}')


async def _stage_order(stage: str | None) -> int:
    return ['Prospect', 'Contacted', 'In talks', 'Won', 'Lost'].index(stage or 'Prospect')


async def _clicked(body: dict[str, Any], action: dict[str, Any], respond: Respond, not_yours: str) -> DealButtonValue | None:
    """The button's deal value when the clicker is the person the list was rendered for; else None
    (and, for someone else's list, a polite ephemeral no)."""
    value = decode_deal_value(action.get('value'))
    clicker = (body.get('user') or {}).get('id')
    if not value or not clicker:
        return None
    if clicker != value.u:
        await _eph(respond, not_yours)
        return None
    return value


NOT_YOURS = "That deal list isn't yours — ask its DRI to update it."


def _view_value(view: dict[str, Any], block_id: str) -> Any:
    return ((view.get('state') or {}).get('values') or {}).get(block_id, {}).get(block_id, {})


class DealView(View):
    """The deal card's buttons (stage, followed up, release, gone cold, loss reason, won, touch)
    and the modals they open."""

    # --- Contacted / In talks / Lost -------------------------------------------------
    @button(DEAL_STAGE_ACTION_RE)
    async def stage(self, interaction: Interaction) -> None:
        respond = interaction.respond
        body = interaction.body
        action = interaction.action
        action_id = interaction.action_id
        value = await _clicked(body, action, respond, NOT_YOURS)
        target = STAGE_FOR_ACTION.get(action_id)
        if not value or not target:
            return

        try:
            deal = await notion.fetch_deal(value.d)
            previous = deal.stage
            updated = deal
            if deal.stage in ('Won', 'Lost'):
                note = f'{STAGE_EMOJI[deal.stage]} Already {deal.stage} in Notion'
            elif deal.stage == target or (target != 'Lost' and await _stage_order(deal.stage) > await _stage_order(target)):
                note = f'Already at *{deal.stage}* in Notion'
            else:
                await notion.set_stage(deal, target, utils.today_iso(), f'Moved to {target} via Slack')
                updated = dataclasses.replace(deal, stage=target, contacted_at=deal.contacted_at or utils.iso_now())
                quota_note = ' · counts toward this week’s quota' if target == 'Contacted' and not deal.contacted_at else ''
                lost_note = ' · why? (optional, one tap)' if target == 'Lost' else ''
                note = f'{STAGE_EMOJI[target]} {target} · {utils.now_time()} via Slack{quota_note}{lost_note}'

            await _rewrite_deal(respond, body, updated, value.u, note, previous)
            logger.info(f"Deal button: {body['user']['id']} → {action_id} on {updated.company}.")
        except Exception as err:
            logger.error(f'Deal button {action_id} failed', exc_info=err)
            await _eph(respond, '✗ Could not update that deal in Notion — try again or use `/sponsor stage`.')

    # --- 📨 Followed up (one tap, no modal) -------------------------------------------
    @button(DEAL_ACTION_IDS['followed_up'])
    async def followed_up(self, interaction: Interaction) -> None:
        respond = interaction.respond
        body = interaction.body
        action = interaction.action
        value = await _clicked(body, action, respond, NOT_YOURS)
        if not value:
            return
        try:
            deal = await notion.fetch_deal(value.d)
            today = utils.today_iso()
            await notion.log_touch(deal, 'Followed up (via Slack)', today)
            nxt = next_action_after_touch(deal, today)
            updated = dataclasses.replace(deal, last_contact=today)
            if nxt:
                updated = dataclasses.replace(updated, next_action=nxt.action, next_action_date=nxt.date_iso)
            nudge = f' · next nudge {nxt.date_iso} if still no reply' if nxt and nxt.date_iso else ''
            note = f'📨 Followed up · {utils.now_time()}{nudge}'
            await _rewrite_deal(respond, body, updated, value.u, note, deal.stage)
            logger.info(f"Followed up: {body['user']['id']} on {deal.company}.")
        except Exception as err:
            logger.error('Followed-up button failed', exc_info=err)
            await _eph(respond, '✗ Could not log that in Notion — try `/sponsor log <company> - followed up`.')

    # --- 🔓 Release a claim that was never contacted --------------------------------------
    @button(DEAL_ACTION_IDS['release'])
    async def release(self, interaction: Interaction) -> None:
        respond = interaction.respond
        body = interaction.body
        action = interaction.action
        value = await _clicked(body, action, respond, "That claim isn't yours — ask its DRI.")
        if not value:
            return
        try:
            deal = await notion.fetch_deal(value.d)
            if deal.stage != 'Prospect':
                await _rewrite_deal(
                    respond, body, deal, value.u, f"Already at *{deal.stage or 'Prospect'}* in Notion — not released", deal.stage
                )
                return
            await notion.release_claim(deal)
            note = '🔓 Released back to the Bank — anyone can `/sponsor claim` it now'
            existing = interaction.message_blocks
            if existing:
                await interaction.respond(replace_original=True, blocks=finalize_deal_blocks(existing, deal.id, note), text=f'{deal.company}: released')
            else:
                await _eph(respond, f'{deal.company}: {note}')
            logger.info(f"Release: {body['user']['id']} released {deal.company}.")
        except Exception as err:
            logger.error('Release button failed', exc_info=err)
            await _eph(respond, '✗ Could not release that claim — try again, or move it in Notion.')

    # --- Gone cold: Still waiting / No reply, close it / They said no ------------------
    @button(DEAL_COLD_ACTION_RE)
    async def cold(self, interaction: Interaction) -> None:
        respond = interaction.respond
        body = interaction.body
        action = interaction.action
        action_id = interaction.action_id
        value = await _clicked(body, action, respond, NOT_YOURS)
        if not value:
            return
        try:
            deal = await notion.fetch_deal(value.d)
            previous = deal.stage
            updated = deal
            if deal.stage != 'Contacted':
                note = f"Already at *{deal.stage or 'Prospect'}* in Notion"
            elif action_id == DEAL_ACTION_IDS['cold_wait']:
                due = utils.iso_days_from_now(COLD_WAIT_DAYS)
                await notion.set_next_action(deal.id, CHECK_REPLY_ACTION, due)
                updated = dataclasses.replace(deal, next_action=CHECK_REPLY_ACTION, next_action_date=due)
                note = f"⏳ Still waiting · next check {due} (it'll be in the Wednesday DM once due)"
            elif action_id == DEAL_ACTION_IDS['cold_no_reply']:
                await notion.set_stage(
                    deal, 'Lost', utils.today_iso(), 'Closed as Lost via Slack: no reply after 30+ days', 'No response'
                )
                updated = dataclasses.replace(deal, stage='Lost', loss_reason='No response')
                note = f'🔕 Lost · no response · {utils.now_time()} via Slack'
            else:
                await notion.set_stage(deal, 'Lost', utils.today_iso(), 'Moved to Lost via Slack: they said no')
                updated = dataclasses.replace(deal, stage='Lost')
                note = f'❌ Lost · {utils.now_time()} via Slack · why? (optional, one tap)'
            await _rewrite_deal(respond, body, updated, value.u, note, previous)
            logger.info(f"Cold deal button: {body['user']['id']} → {action_id} on {updated.company}.")
        except Exception as err:
            logger.error(f'Cold deal button {action_id} failed', exc_info=err)
            await _eph(respond, '✗ Could not update that deal in Notion — try again or use `/sponsor stage`.')

    # --- Loss reason (one tap after Lost) ----------------------------------------------
    @button(DEAL_LOSS_ACTION_RE)
    async def loss_reason(self, interaction: Interaction) -> None:
        respond = interaction.respond
        body = interaction.body
        action = interaction.action
        action_id = interaction.action_id
        reason = loss_reason_for_action(action_id)
        if not reason:
            return
        value = await _clicked(body, action, respond, NOT_YOURS)
        if not value:
            return
        try:
            deal = await notion.fetch_deal(value.d)
            if deal.stage != 'Lost':
                await _eph(respond, f"{deal.company} is at *{deal.stage or 'Prospect'}* now, not Lost — no reason recorded.")
                return
            ask_for_link = reason == 'Sent to a form, application or another team' and bool(deal.bank_source_id)
            if ask_for_link:
                # Open first: Slack's trigger_id expires ~3s after the click, before Notion writes finish.
                meta = dataclasses.replace(_container_meta(body, value), b=deal.bank_source_id)
                try:
                    await interaction.client.views_open(
                        trigger_id=body['trigger_id'],
                        view={
                            'type': 'modal',
                            'callback_id': APPLY_VIA_MODAL_ID,
                            'private_metadata': meta.dump(),
                            'title': {'type': 'plain_text', 'text': 'Where do they apply?'},
                            'submit': {'type': 'plain_text', 'text': 'Save link'},
                            'close': {'type': 'plain_text', 'text': 'Skip'},
                            'blocks': [
                                {
                                    'type': 'section',
                                    'text': {
                                        'type': 'mrkdwn',
                                        'text': f"*{deal.company}*: paste the form or application link and next season's outreach goes straight there.",
                                    },
                                },
                                {
                                    'type': 'input',
                                    'block_id': 'url',
                                    'label': {'type': 'plain_text', 'text': 'Form / application link'},
                                    'element': {
                                        'type': 'url_text_input',
                                        'action_id': 'url',
                                        'placeholder': {'type': 'plain_text', 'text': 'https://…'},
                                    },
                                },
                            ],
                        },
                    )
                except Exception as err:
                    logger.warning(f'Loss reason: could not open the Apply via modal for {deal.company}', exc_info=err)
            await notion.write_loss_reason(deal, reason, utils.today_iso())
            updated = dataclasses.replace(deal, loss_reason=reason)
            extra = LOSS_REASON_FOLLOW_UP.get(reason, '')
            if reason == "Policy: doesn't sponsor teams like ours" and deal.bank_source_id:
                await notion.mark_bank_dead(deal.bank_source_id)
                extra = "Bank lead marked Dead, so it won't be pitched again"
            if ask_for_link:
                extra = 'add the link in the popup and it goes on the Bank row'
            note = f"❌ Lost · {reason}{f' · {extra}' if extra else ''}"
            await _rewrite_deal(respond, body, updated, value.u, note, 'Lost')
            logger.info(f"Loss reason: {body['user']['id']} → \"{reason}\" on {deal.company}.")
        except Exception as err:
            logger.error(f'Loss reason {action_id} failed', exc_info=err)
            await _eph(respond, '✗ Could not save that reason in Notion — try again, or set Loss reason on the deal in Notion.')

    @modal(APPLY_VIA_MODAL_ID)
    async def apply_via_submit(self, ack, body, view, client) -> None:
        meta = ModalMeta.load(view.get('private_metadata'))
        url = str(_view_value(view, 'url').get('value') or '').strip()
        if not re.match(r'^https?://\S+$', url, re.I):
            await ack(response_action='errors', errors={'url': 'Paste a full link starting with https://'})
            return
        await ack()
        clicker = (body.get('user') or {}).get('id')
        if clicker != meta.u or not meta.b:
            return
        try:
            await notion.write_bank_apply_via(meta.b, url)
            await _confirm(client, meta, f'📄 Saved the application link on the Bank row: {url}')
            logger.info(f'Apply via: {clicker} saved {url} on Bank row {meta.b}.')
        except Exception as err:
            logger.error('Apply-via modal failed', exc_info=err)
            await _confirm(client, meta, '✗ Could not save that link — add it to the Bank row’s Apply via column in Notion.')

    # --- Won → modal -------------------------------------------------------------------
    @button(DEAL_ACTION_IDS['won_open'])
    async def won_open(self, interaction: Interaction) -> None:
        respond = interaction.respond
        body = interaction.body
        action = interaction.action
        value = await _clicked(body, action, respond, "That deal list isn't yours.")
        if not value:
            return
        deal = await notion.fetch_deal(value.d)
        if deal.stage == 'Won':
            await _eph(respond, f'{deal.company} is already Won in Notion.')
            return
        await interaction.client.views_open(
            trigger_id=body['trigger_id'],
            view={
                'type': 'modal',
                'callback_id': WON_MODAL_ID,
                'private_metadata': _container_meta(body, value).dump(),
                'title': {'type': 'plain_text', 'text': 'Mark deal Won'},
                'submit': {'type': 'plain_text', 'text': 'Mark Won'},
                'close': {'type': 'plain_text', 'text': 'Cancel'},
                'blocks': [
                    {
                        'type': 'section',
                        'text': {
                            'type': 'mrkdwn',
                            'text': f'*{deal.company}* → Stage *Won*. This records the amount in Received ($) and posts the win '
                            f'to #{config.sponsorship.win_post_channel}.',
                        },
                    },
                    {
                        'type': 'input',
                        'block_id': 'amount',
                        'label': {'type': 'plain_text', 'text': 'Amount received'},
                        'hint': {
                            'type': 'plain_text',
                            'text': 'e.g. 5000 · $5k · 38% of $9k (a discount, auto-tagged Valued discount)',
                        },
                        'element': {
                            'type': 'plain_text_input',
                            'action_id': 'amount',
                            'placeholder': {'type': 'plain_text', 'text': '$5,000'},
                        },
                    },
                    {
                        'type': 'input',
                        'block_id': 'kind',
                        'optional': True,
                        'label': {'type': 'plain_text', 'text': 'How it came in'},
                        'element': {
                            'type': 'static_select',
                            'action_id': 'kind',
                            'placeholder': {'type': 'plain_text', 'text': 'Cash / in-kind / discount'},
                            'options': [{'text': {'type': 'plain_text', 'text': k}, 'value': k} for k in WON_KINDS],
                        },
                    },
                    {
                        'type': 'input',
                        'block_id': 'note',
                        'optional': True,
                        'label': {'type': 'plain_text', 'text': 'Note (shown under the win post)'},
                        'element': {'type': 'plain_text_input', 'action_id': 'note', 'multiline': True, 'max_length': 300},
                    },
                ],
            },
        )

    @modal(WON_MODAL_ID)
    async def won_submit(self, ack, body, view, client) -> None:
        meta = ModalMeta.load(view.get('private_metadata'))
        amount_text = str(_view_value(view, 'amount').get('value') or '').strip()
        kind_pick = (_view_value(view, 'kind').get('selected_option') or {}).get('value')
        note_text = str(_view_value(view, 'note').get('value') or '').strip()
        # Reuse the /sponsor won parser on a placeholder company so "$5k" / "38% of $9k" both work.
        parsed = parse_won(f'deal {amount_text}')
        if not parsed:
            await ack(response_action='errors', errors={'amount': 'Enter a number ($5,000, 5k) or a discount (38% of $9k).'})
            return
        await ack()
        clicker = (body.get('user') or {}).get('id')
        if clicker != meta.u:
            return
        try:
            deal = await notion.fetch_deal(meta.d)
            kind = kind_pick or parsed.kind
            note = note_text or parsed.note or ''
            await notion.mark_won(deal, parsed.amount_usd, note, utils.today_iso(), kind)
            posted = False
            try:
                posted = await announce_won_now(client, notion, deal, parsed.amount_usd, kind, note)
            except Exception as err:
                logger.error('Won modal: announcement failed (deal still marked Won)', exc_info=err)
            kind_note = f' ({kind.lower()})' if kind else ''
            computed = f' _({parsed.computed})_' if parsed.computed else ''
            posted_note = f' · posted to #{config.sponsorship.win_post_channel}' if posted else ''
            await _confirm(
                client,
                meta,
                f'🏆 *{deal.company}* marked *Won* — {fmt_usd(parsed.amount_usd)}{kind_note}{computed}{posted_note}. '
                f'<{deal.url}|Open in Notion>',
            )
            logger.info(f'Won modal: {clicker} marked {deal.company} Won (${parsed.amount_usd}).')
        except Exception as err:
            logger.error('Won modal failed', exc_info=err)
            await _confirm(client, meta, '✗ Could not mark that deal Won — try `/sponsor won <company> <amount>`.')

    # --- Log touch → modal -------------------------------------------------------------
    @button(DEAL_ACTION_IDS['touch_open'])
    async def touch_open(self, interaction: Interaction) -> None:
        respond = interaction.respond
        body = interaction.body
        action = interaction.action
        value = await _clicked(body, action, respond, "That deal list isn't yours.")
        if not value:
            return
        deal = await notion.fetch_deal(value.d)
        await interaction.client.views_open(
            trigger_id=body['trigger_id'],
            view={
                'type': 'modal',
                'callback_id': TOUCH_MODAL_ID,
                'private_metadata': _container_meta(body, value).dump(),
                'title': {'type': 'plain_text', 'text': 'Log a touch'},
                'submit': {'type': 'plain_text', 'text': 'Log it'},
                'close': {'type': 'plain_text', 'text': 'Cancel'},
                'blocks': [
                    {
                        'type': 'section',
                        'text': {
                            'type': 'mrkdwn',
                            'text': f'*{deal.company}* — stamps Last contact = today and adds a dated note (same as `/sponsor log`).',
                        },
                    },
                    {
                        'type': 'input',
                        'block_id': 'note',
                        'label': {'type': 'plain_text', 'text': 'What happened?'},
                        'element': {
                            'type': 'plain_text_input',
                            'action_id': 'note',
                            'multiline': True,
                            'max_length': 500,
                            'placeholder': {'type': 'plain_text', 'text': 'Called Chloe, sending the deck Monday'},
                        },
                    },
                ],
            },
        )

    @modal(TOUCH_MODAL_ID)
    async def touch_submit(self, ack, body, view, client) -> None:
        meta = ModalMeta.load(view.get('private_metadata'))
        note_text = str(_view_value(view, 'note').get('value') or '').strip()
        if not note_text:
            await ack(response_action='errors', errors={'note': 'Add a short note.'})
            return
        await ack()
        clicker = (body.get('user') or {}).get('id')
        if clicker != meta.u:
            return
        try:
            deal = await notion.fetch_deal(meta.d)
            await notion.log_touch(deal, f'{note_text} (via Slack)', utils.today_iso())
            await _confirm(client, meta, f'📝 Logged on *{deal.company}* (Last contact = today): {note_text}')
            logger.info(f'Touch modal: {clicker} logged a touch on {deal.company}.')
        except Exception as err:
            logger.error('Touch modal failed', exc_info=err)
            await _confirm(client, meta, '✗ Could not log that — try `/sponsor log <company> - <note>`.')

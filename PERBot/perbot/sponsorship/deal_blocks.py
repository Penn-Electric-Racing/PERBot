"""Block Kit for deal lists (Wednesday stale DM, Saturday digest's next actions, `/sponsor me`): one
section per deal + a button row whose options depend on the stage. Clicks are handled by actions.py
in the Bolt app; Notion stays the system of record and every Slack-driven change leaves a dated
"via Slack" line in Notes.

Button values carry the deal id AND the Slack user the list was rendered for, so a click is
honoured only from that user.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Callable

from .models import LOSS_REASONS, LossReason, PipelineRow

DEAL_ACTION_IDS = {
    'contacted': 'deal_stage_contacted',
    'in_talks': 'deal_stage_intalks',
    'lost': 'deal_stage_lost',
    'won_open': 'deal_won_open',
    'touch_open': 'deal_touch_open',
    'cold_wait': 'deal_cold_wait',
    'cold_no_reply': 'deal_cold_noreply',
    'cold_said_no': 'deal_cold_saidno',
    'followed_up': 'deal_followed_up',
    'release': 'deal_release',
}
DEAL_STAGE_ACTION_RE = re.compile(r'^deal_stage_(contacted|intalks|lost)$')
DEAL_COLD_ACTION_RE = re.compile(r'^deal_cold_(wait|noreply|saidno)$')
# One button per Loss reason: `deal_loss_<index into LOSS_REASONS>`.
DEAL_LOSS_ACTION_RE = re.compile(r'^deal_loss_(\d+)$')
APPLY_VIA_MODAL_ID = 'sponsor_apply_via_modal'

# Short button labels for LOSS_REASONS (same order). The full label goes to Notion.
LOSS_BUTTON_LABELS: dict[str, str] = {
    'No response': '🔕 No response',
    'Replied, then went quiet': '🤐 Went quiet',
    "Policy: doesn't sponsor teams like ours": "🚫 Policy: doesn't sponsor",
    'Sent to a form, application or another team': '📄 Sent to a form',
    'No budget or capacity right now': '💸 No budget now',
    'Regular price only, no discount': '🏷️ Price only',
    "Couldn't do the work we needed": "🛠️ Can't do the work",
    'Bounced or wrong contact': '📭 Wrong contact',
}


def loss_reason_for_action(action_id: str) -> LossReason | None:
    m = DEAL_LOSS_ACTION_RE.match(action_id)
    if not m:
        return None
    i = int(m.group(1))
    return LOSS_REASONS[i] if i < len(LOSS_REASONS) else None


WON_MODAL_ID = 'sponsor_won_modal'
TOUCH_MODAL_ID = 'sponsor_touch_modal'


@dataclass
class DealButtonValue:
    d: str  # deal page id
    u: str  # Slack user the buttons were rendered for


def encode_deal_value(v: DealButtonValue) -> str:
    return json.dumps({'d': v.d, 'u': v.u}, separators=(',', ':'))


def decode_deal_value(raw: str | None) -> DealButtonValue | None:
    try:
        v = json.loads(raw or '')
    except (ValueError, TypeError):
        return None
    return DealButtonValue(v['d'], v['u']) if isinstance(v, dict) and isinstance(v.get('d'), str) and isinstance(v.get('u'), str) else None


def deal_section_id(deal_id: str) -> str:
    return f'deal:{deal_id}'


def deal_actions_id(deal_id: str) -> str:
    return f'deal_actions:{deal_id}'


def _button(text: str, action_id: str, value: DealButtonValue, style: str | None = None) -> dict[str, Any]:
    b: dict[str, Any] = {
        'type': 'button',
        'text': {'type': 'plain_text', 'text': text, 'emoji': True},
        'action_id': action_id,
        'value': encode_deal_value(value),
    }
    if style:
        b['style'] = style
    return b


def default_deal_line(deal: PipelineRow) -> str:
    """Default one-line summary (the `/sponsor me` style)."""
    stage = deal.stage or 'Prospect'
    nxt = f' — Next: {deal.next_action}' if deal.next_action else ''
    due = f' (due {deal.next_action_date})' if deal.next_action_date else ''
    return f"<{deal.url}|{deal.company or 'Untitled'}> — *{stage}*{nxt}{due}"


def buttons_for(deal: PipelineRow, value: DealButtonValue) -> list[dict[str, Any]]:
    """Buttons that make sense from this stage. None once Won. A Lost deal with no reason yet gets
    the reason picker instead. It's optional, so ignoring it leaves the deal Lost with the reason blank."""
    stage = deal.stage or 'Prospect'
    if stage == 'Lost':
        return [] if deal.loss_reason else loss_reason_buttons(value)
    if stage == 'Won':
        return []
    out: list[dict[str, Any]] = []
    if stage == 'Prospect':
        out.append(_button('📨 Contacted', DEAL_ACTION_IDS['contacted'], value, 'primary'))
    if stage in ('Prospect', 'Contacted'):
        out.append(_button('💬 In talks', DEAL_ACTION_IDS['in_talks'], value, 'primary' if stage == 'Contacted' else None))
    # One tap instead of the Log touch modal: stamps Last contact and pushes the follow-up a week out.
    if stage == 'Contacted':
        out.append(_button('📨 Followed up', DEAL_ACTION_IDS['followed_up'], value))
    out.append(_button('🏆 Won', DEAL_ACTION_IDS['won_open'], value, 'primary' if stage == 'In talks' else None))
    out.append(_button('❌ Lost', DEAL_ACTION_IDS['lost'], value))
    out.append(_button('📝 Log touch', DEAL_ACTION_IDS['touch_open'], value))
    return out


def loss_reason_buttons(value: DealButtonValue) -> list[dict[str, Any]]:
    """The reason picker: one tap writes `Loss reason`."""
    return [_button(LOSS_BUTTON_LABELS[reason], f'deal_loss_{i}', value) for i, reason in enumerate(LOSS_REASONS)]


def cold_deal_blocks(deal: PipelineRow, slack_user_id: str, line: str) -> list[dict[str, Any]]:
    """A deal at Contacted for 30+ days with no reply (the Wednesday DM's "gone cold" section).
    After a click, actions.py swaps these for the normal stage buttons."""
    value = DealButtonValue(deal.id, slack_user_id)
    return [
        {'type': 'section', 'block_id': deal_section_id(deal.id), 'text': {'type': 'mrkdwn', 'text': line}},
        {
            'type': 'actions',
            'block_id': deal_actions_id(deal.id),
            'elements': [
                _button('⏳ Still waiting', DEAL_ACTION_IDS['cold_wait'], value),
                _button('💬 They replied', DEAL_ACTION_IDS['in_talks'], value, 'primary'),
                _button('🔕 No reply, close it', DEAL_ACTION_IDS['cold_no_reply'], value),
                _button('👎 They said no', DEAL_ACTION_IDS['cold_said_no'], value),
            ],
        },
    ]


def stale_claim_blocks(deal: PipelineRow, slack_user_id: str, line: str) -> list[dict[str, Any]]:
    """A claim still at Prospect two weeks on (the Wednesday DM's "claimed, not contacted" section).
    Released automatically a week after asking if it's still at Prospect."""
    value = DealButtonValue(deal.id, slack_user_id)
    return [
        {'type': 'section', 'block_id': deal_section_id(deal.id), 'text': {'type': 'mrkdwn', 'text': line}},
        {
            'type': 'actions',
            'block_id': deal_actions_id(deal.id),
            'elements': [
                _button('📨 Sent it', DEAL_ACTION_IDS['contacted'], value, 'primary'),
                _button('🔓 Release it', DEAL_ACTION_IDS['release'], value),
            ],
        },
    ]


def finalize_deal_blocks(blocks: list[dict[str, Any]], deal_id: str, note: str) -> list[dict[str, Any]]:
    """Close out one deal in a message: keep its first line, append `note`, drop its buttons (a
    released deal has none)."""
    out = []
    for b in blocks:
        if (b or {}).get('block_id') == deal_actions_id(deal_id):
            continue
        if (b or {}).get('block_id') == deal_section_id(deal_id):
            line = str(((b.get('text') or {}).get('text')) or '').split('\n')[0]
            b = {**b, 'text': {'type': 'mrkdwn', 'text': f'{line}\n_{note}_'}}
        out.append(b)
    return out


def deal_blocks(deal: PipelineRow, slack_user_id: str, line: str | None = None, note: str | None = None) -> list[dict[str, Any]]:
    """The blocks for one deal. `line` overrides the summary (contexts like the stale DM show overdue
    info); `note` (e.g. "📨 Contacted · 1:42 PM via Slack") is appended after an update."""
    value = DealButtonValue(deal.id, slack_user_id)
    text_line = line if line is not None else default_deal_line(deal)
    text = f'{text_line}\n_{note}_' if note else text_line
    blocks: list[dict[str, Any]] = [{'type': 'section', 'block_id': deal_section_id(deal.id), 'text': {'type': 'mrkdwn', 'text': text}}]
    elements = buttons_for(deal, value)
    if elements:
        blocks.append({'type': 'actions', 'block_id': deal_actions_id(deal.id), 'elements': elements})
    return blocks


def deal_list_blocks(
    header: str,
    deals: list[PipelineRow],
    slack_user_id: str,
    footer: str | None = None,
    line_for: Callable[[PipelineRow], str] | None = None,
) -> list[dict[str, Any]]:
    """Header + deals + optional footer. `line_for` lets each context format its own deal line."""
    blocks: list[dict[str, Any]] = [{'type': 'section', 'text': {'type': 'mrkdwn', 'text': header}}]
    # Slack rejects duplicate block_ids, so a deal can appear only once per message.
    seen: set[str] = set()
    for d in deals:
        if d.id in seen:
            continue
        seen.add(d.id)
        blocks.extend(deal_blocks(d, slack_user_id, line=line_for(d) if line_for else None))
    if footer:
        blocks.append({'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': footer}]})
    return blocks


def replace_deal_blocks(
    blocks: list[dict[str, Any]], updated: PipelineRow, slack_user_id: str, note: str, previous_stage: str | None
) -> list[dict[str, Any]]:
    """Rewrite one deal inside an existing message: keeps the deal's original first line (swapping a
    `*Old stage*` marker if present), appends `note`, and re-derives the buttons from the updated
    deal. Returns a new blocks list."""
    out: list[dict[str, Any]] = []
    done = False
    for b in blocks:
        bid = (b or {}).get('block_id')
        if bid == deal_section_id(updated.id):
            if not done:
                line = str(((b.get('text') or {}).get('text')) or '').split('\n')[0] or default_deal_line(updated)
                if previous_stage and updated.stage and previous_stage != updated.stage:
                    line = line.replace(f'*{previous_stage}*', f'*{updated.stage}*', 1)
                out.extend(deal_blocks(updated, slack_user_id, line=line, note=note))
                done = True
            continue
        if bid == deal_actions_id(updated.id):
            continue
        out.append(b)
    return out if done else [*blocks, *deal_blocks(updated, slack_user_id, note=note)]

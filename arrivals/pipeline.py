"""One Slack message with photos → scan → resolutions → reply (or silence). Shared by the live
listener (slack.py) and the read-only backtest (cli.py), so the backtest exercises exactly the code
that runs in the channel.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import AbstractSet, Any

from slack_sdk.web.async_client import AsyncWebClient

from arrivals.blocks import Reply, ReplyContext, build_reply
from arrivals.extract import ScanContext, SlipImage, scan_photos
from arrivals.models import Resolution, Scan
from arrivals.people import People
from arrivals.resolve import Picker, resolve_scan
from core import http
from core.config import config
from core.purchasing import PurchasingRow

__all__ = [
    'DIRECT_TYPES', 'MAX_IMAGES', 'DeliveryMessage', 'DeliveryResult', 'process_delivery',
    'resolution_key', 'is_image', 'load_images', 'slack_name', 'with_names', 'parent_text',
]

# OpenAI accepts these directly; anything else (HEIC from iPhones) goes via Slack's JPEG thumbnail.
DIRECT_TYPES = {'image/jpeg', 'image/png', 'image/webp', 'image/gif'}
MAX_IMAGES = 4


@dataclass
class DeliveryMessage:
    ts: str
    user: str
    # Message text with Slack mentions replaced by names.
    text: str
    in_thread: bool
    images: list[SlipImage]
    # The thread's first message (names resolved), when this is a reply.
    parent_text: str | None = None
    # Requesters → Slack ids, so the reply can @-mention them.
    people: People | None = None
    # Orders someone called wrong in this thread: never candidates again.
    rejected: AbstractSet[str] = field(default_factory=frozenset)
    # Orders that already have a card in this thread: a second photo of the same box adds nothing.
    carded: AbstractSet[str] = field(default_factory=frozenset)
    # `@PERBot <what's in it>` asking to look again.
    correction: bool = False


@dataclass
class DeliveryResult:
    scan: Scan
    resolutions: list[Resolution]
    reply: Reply | None


async def process_delivery(msg: DeliveryMessage, open_rows: list[PurchasingRow], picker: Picker | None = None) -> DeliveryResult:
    scan = await scan_photos(msg.images, ScanContext(text=msg.text, parent_text=msg.parent_text))
    as_of = datetime.fromtimestamp(float(msg.ts), tz=timezone.utc)
    message_text = '\n'.join(x for x in (msg.parent_text, msg.text) if x)
    every = await resolve_scan(scan, open_rows, as_of, message_text, picker, msg.rejected)
    resolutions = [r for r in every if (resolution_key(r) or '') not in msg.carded]
    # Everything this photo found already has a card in the thread: stay quiet rather than repeat it (10/13).
    if every and not resolutions:
        return DeliveryResult(scan, resolutions, None)
    reply = build_reply(
        scan,
        resolutions,
        ReplyContext(
            u=msg.user,
            ts=msg.ts,
            in_thread=msg.in_thread,
            text=msg.text,
            people=msg.people,
            correction=msg.correction,
            rejected=list(msg.rejected),
        ),
    )
    return DeliveryResult(scan, resolutions, reply)


def resolution_key(res: Resolution) -> str | None:
    """The order a resolution's card would show (`OpenOrder.key`), or None."""
    if res.kind == 'match':
        return res.key
    if res.kind == 'choose':
        return res.orders[0].key if res.orders else None
    return None


# --- Slack plumbing shared by the listener and the backtest -----------------------------------


def is_image(file: Any) -> bool:
    return str((file or {}).get('mimetype') or '').startswith('image/')


async def _download(url: str) -> bytes:
    res = await http.get(url, headers={'Authorization': f'Bearer {config.slack.bot_token}'}, timeout=60)
    kind = res.headers.get('content-type') or ''
    # Without files:read Slack answers with its HTML sign-in page, not an error status.
    if not res.ok or not kind.startswith('image/'):
        raise RuntimeError(
            f"Could not download the photo (HTTP {res.status_code}, {kind or 'no type'}); does the bot have files:read?"
        )
    return res.content


async def load_images(client: AsyncWebClient, files: list[Any]) -> list[SlipImage]:
    images: list[SlipImage] = []
    for file in [f for f in files or [] if is_image(f)][:MAX_IMAGES]:
        if not file.get('url_private'):
            file = (await client.files_info(file=file['id'])).get('file') or file
        if file.get('mimetype') in DIRECT_TYPES and file.get('url_private_download'):
            images.append(SlipImage(await _download(file['url_private_download']), file['mimetype']))
        else:
            thumb = file.get('thumb_1024') or file.get('thumb_960') or file.get('thumb_720')
            if thumb:
                images.append(SlipImage(await _download(thumb), 'image/jpeg'))
    return images


_names: dict[str, str] = {}
_MENTION = re.compile(r'<@([A-Z0-9]+)(?:\|[^>]*)?>')


async def slack_name(client: AsyncWebClient, id_: str) -> str:
    """A Slack user's real name (cached), or their id when Slack won't say."""
    if id_ not in _names:
        await with_names(client, f'<@{id_}>')
    return _names.get(id_, id_)


async def with_names(client: AsyncWebClient, text: str) -> str:
    """"<@U07M54CLKNY> cooling tube is here" → "@Elijah Jeoung cooling tube is here" — owners are evidence."""
    for id_ in dict.fromkeys(m.group(1) for m in _MENTION.finditer(text)):
        if id_ in _names:
            continue
        try:
            user = (await client.users_info(user=id_)).get('user') or {}
            _names[id_] = user.get('real_name') or (user.get('profile') or {}).get('real_name') or user.get('name') or id_
        except Exception:
            _names[id_] = id_
    return _MENTION.sub(lambda m: f'@{_names.get(m.group(1), m.group(1))}', text)


async def parent_text(client: AsyncWebClient, channel: str, thread_ts: str) -> str | None:
    """The thread's first message text (names resolved), or None."""
    try:
        messages = (await client.conversations_replies(channel=channel, ts=thread_ts, limit=1)).get('messages') or []
        text = messages[0].get('text') if messages else None
        return await with_names(client, text) if text else None
    except Exception:
        return None

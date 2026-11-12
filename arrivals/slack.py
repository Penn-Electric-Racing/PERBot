"""Package arrivals in `ARRIVALS_CHANNEL`. Every human message with a photo (top level or in a thread)
runs through `process_delivery`; PERBot replies in the thread only when it has something useful (see
blocks.py:build_reply), and writes Notion only when someone taps a button — only the arrival columns.
Other bots (the Copy Center webhook, B11's RFID logger) are ignored.

People: replies @-mention the likely order's requesters (named, not pinged, on a vendor-only guess);
when rows are marked, each requester gets a DM (not whoever tapped or posted); a card untapped for 4 h
DMs them once (see _remind_stale). Every mark can be undone from the card for 24 h.

Corrections: `@PERBot <what's in it>` in a package thread looks again with that text
(handle_arrivals_mention) instead of searching the docs, and so does a plain reply from whoever just
tapped Wrong order with nothing left to offer. Wrong order otherwise swaps the card to the vendor's
next open order. Orders rejected in a thread are never offered there again, and a photo whose orders
already have a card in its thread gets no second card.

Slack setup: bot scope `files:read` and the `message.channels` event (`message.groups` too if the
channel is private), then reinstall.
"""
from __future__ import annotations

import dataclasses
import re
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any, Iterable
from zoneinfo import ZoneInfo

from slack_bolt import App
from slack_sdk import WebClient

from config import config
from sponsorship.identity import Indexed, index_notion_users, slack_user_to_notion_id
from sponsorship.jobs.shared import resolve_channel_id
from utils.clock import to_iso
from utils.logger import logger
from arrivals.blocks import (
    ARRIVAL_ACTION_IDS,
    ARRIVAL_ACTION_RE,
    ArrivalButtonValue,
    arrival_dm,
    card_index,
    compact,
    decode_value,
    guess_card,
    is_card,
    lead_time_line,
    package_key,
    reminder_dm,
    replace_card,
    settle_blocks,
    settle_card,
    target_ids,
)
from arrivals.models import ArrivalRow, Extraction
from arrivals.notion import ARRIVED_YES, ArrivalsNotion, ArrivalWrite
from arrivals.orders import eligible_rows, group_orders, orders_for_vendor, rank_orders
from arrivals.people import people_map
from arrivals.pipeline import DeliveryMessage, is_image, load_images, parent_text, process_delivery, slack_name, with_names


@lru_cache(maxsize=1)
def _notion() -> ArrivalsNotion:
    return ArrivalsNotion()


_channel_id: str | None = None
_channel_lock = threading.Lock()


def _arrivals_channel_id(client: WebClient) -> str | None:
    """Resolved once; a lookup error raises and is retried on the next message."""
    global _channel_id
    with _channel_lock:
        if _channel_id is None:
            found = resolve_channel_id(client, config.arrivals.channel)
            if not found:
                logger.warn(f'Arrivals: channel "{config.arrivals.channel}" not found; the listener is idle.')
            _channel_id = found or ''
        return _channel_id or None


class _Capped(OrderedDict):
    """Insertion-ordered memory that drops its oldest entry past 500 (bounded dedupe state)."""

    def __setitem__(self, key: Any, value: Any) -> None:
        super().__setitem__(key, value)
        if len(self) > 500:
            self.popitem(last=False)

    def add(self, key: Any) -> None:
        self[key] = True


_state_lock = threading.RLock()
# Slack redelivers events it thinks we missed; one message is processed once per process.
_seen = _Capped()
# Package key (vendor + tracking) → permalink of the reply that already covers that box.
_packages = _Capped()
# Threads that already got a "post the packing slip" nudge — one per thread is enough.
_nudged = _Capped()
# Thread ts → order keys someone tapped Wrong order on there (the cards carry them too, until settled).
_rejected_in = _Capped()
# Thread ts → (user, until) who just ran out of candidates on Wrong order: their next plain reply there is a correction.
_awaiting = _Capped()
AWAIT_S = 30 * 60


def _claim(id_: str) -> bool:
    """Marks a message seen; False when it already was."""
    with _state_lock:
        if id_ in _seen:
            return False
        _seen.add(id_)
        return True


def _reject(thread_ts: str, keys: list[str]) -> None:
    with _state_lock:
        current = set(_rejected_in.get(thread_ts) or set())
        current.update(keys)
        _rejected_in[thread_ts] = current


def thread_orders(messages: list[Any], bot: str | None, remembered: Iterable[str] = ()) -> tuple[set[str], set[str]]:
    """What PERBot's cards in a thread already cover: (carded, rejected) — orders with a card (open or
    marked), and orders tapped Wrong order on. Read from the cards' button values plus memory."""
    carded: dict[str, None] = {}
    rejected: dict[str, None] = dict.fromkeys(remembered)
    for m in messages:
        if not bot or (m or {}).get('bot_id') != bot:
            continue
        for b in m.get('blocks') or []:
            if card_index((b or {}).get('block_id')) is None:
                continue
            for el in b.get('elements') or []:
                v = decode_value((el or {}).get('value'))
                if v and v.get('k'):
                    carded[v['k']] = None
                for k in (v or {}).get('n') or []:
                    rejected[k] = None
    for k in rejected:
        carded.pop(k, None)
    return set(carded), set(rejected)


def _thread_messages(client: WebClient, channel: str, thread_ts: str) -> list[Any]:
    try:
        return client.conversations_replies(channel=channel, ts=thread_ts, limit=200).get('messages') or []
    except Exception as err:
        logger.warn(f'Arrivals: could not read thread {thread_ts}', err)
        return []


def handle_photo(
    client: WebClient,
    event: dict[str, Any],
    correction: bool = False,
    text: str | None = None,
    photo_text: str | None = None,
) -> None:
    """With `correction`: re-run `event` (the photo) with `text` — what someone said is in the box —
    replacing the photo's own message as the evidence."""
    thread_ts = event.get('thread_ts') or event['ts']
    in_thread = bool(event.get('thread_ts') and event.get('thread_ts') != event.get('ts'))

    def reply(t: str, blocks: list[Any] | None = None) -> Any:
        kwargs: dict[str, Any] = {'channel': event['channel'], 'thread_ts': thread_ts, 'text': t, 'unfurl_links': False}
        if blocks is not None:
            kwargs['blocks'] = blocks
        return client.chat_postMessage(**kwargs)

    try:
        images = load_images(client, event.get('files') or [])
        if not images:
            return
        look_around = in_thread or correction
        notion = _notion()
        with ThreadPoolExecutor(max_workers=6) as pool:
            text_f = pool.submit(with_names, client, text if text is not None else event.get('text') or '')
            parent_f = pool.submit(parent_text, client, event['channel'], thread_ts) if look_around else None
            rows_f = pool.submit(notion.open_rows)
            people_f = pool.submit(people_map, client, notion)
            thread_f = pool.submit(_thread_messages, client, event['channel'], thread_ts) if look_around else None
            ids_f = pool.submit(_own_ids, client)
            said = text_f.result()
            parent = parent_f.result() if parent_f else None
            open_rows = rows_f.result()
            people = people_f.result()
            thread = thread_f.result() if thread_f else []
            ids = ids_f.result()
        with _state_lock:
            remembered = list(_rejected_in.get(thread_ts) or ())
        carded, rejected = thread_orders(thread, ids[0], remembered)
        # A correction is about the photo: its own message is the context, the correction the evidence.
        context = ('\n'.join(x for x in (parent, photo_text) if x) or None) if correction else parent
        result = process_delivery(
            DeliveryMessage(
                ts=event['ts'],
                user=event.get('user') or '',
                text=said,
                parent_text=context,
                in_thread=in_thread,
                images=images,
                people=people,
                rejected=rejected,
                carded=set() if correction else carded,
                correction=correction,
            ),
            open_rows,
        )
        scan, resolutions, answer = result.scan, result.resolutions, result.reply
        logger.info(
            f"Arrivals: {event['ts']} scene={scan.scene} legible={str(scan.legible).lower()} packages={len(scan.packages)} "
            f"→ {','.join(r.kind for r in resolutions) or '-'} reply={'yes' if answer else 'silent'}"
        )
        if not answer:
            return

        is_nudge = not any(b.get('type') == 'actions' for b in answer.blocks)
        with _state_lock:
            if is_nudge and thread_ts in _nudged and not correction:
                return
            # A second photo of a box we already answered for: point at that reply instead.
            keys = [k for k in (package_key(p) for p in scan.packages) if k]
            earlier = next((_packages[k] for k in keys if _packages.get(k)), None)
            same_box = bool(earlier) and all(k in _packages for k in keys) and not correction
        if same_box:
            reply(f':package: Same box as <{earlier}|this one> (same tracking number) — confirm it there.')
            return

        posted = reply(answer.text, answer.blocks)
        if is_nudge:
            with _state_lock:
                _nudged.add(thread_ts)
        elif keys and posted.get('ts'):
            try:
                link = client.chat_getPermalink(channel=event['channel'], message_ts=posted['ts']).get('permalink')
            except Exception:
                link = None
            if link:
                with _state_lock:
                    for k in keys:
                        _packages[k] = link
    except Exception as err:
        logger.error('Arrivals: photo handling failed', err)
        # Stay quiet in threads (most thread photos are banter); a top-level failure or an asked-for look gets one line.
        if not in_thread or correction:
            try:
                reply(':warning: I couldn’t process that photo. Mark the order in Notion for now; the error is in the Render logs.')
            except Exception:
                pass


# --- Corrections --------------------------------------------------------------------------------


def _correct(client: WebClient, event: dict[str, Any], text: str) -> bool:
    """Look again at the thread's latest photo (at or before the correction) with `text` as the
    evidence. False: no photo there."""
    thread_ts = event['thread_ts']
    thread = _thread_messages(client, event['channel'], thread_ts)
    photo = next((m for m in reversed(thread) if is_photo_post(m) and float(m['ts']) <= float(event['ts'])), None)
    if not photo:
        return False
    # A photo posted as a reply has its own message; the thread's first message comes in as the parent.
    photo_text = with_names(client, photo['text']) if photo['ts'] != thread_ts and photo.get('text') else None
    logger.info(f"Arrivals: looking again at {photo['ts']} with \"{text[:80]}\"")
    handle_photo(client, {**photo, 'channel': event['channel'], 'thread_ts': thread_ts}, correction=True, text=text, photo_text=photo_text)
    return True


def handle_arrivals_mention(client: WebClient, event: dict[str, Any], bot_user_id: str | None = None) -> bool:
    """`@PERBot <what's in it>` in a package thread: look again at that thread's photo with the text,
    rather than the docs search the mention would otherwise run (10/19: "no, elijah cooling fittings
    are in this picture" got a page of cooling-loop meeting notes). True when handled here."""
    if not config.arrivals.channel or not (event or {}).get('thread_ts'):
        return False
    try:
        arrivals = _arrivals_channel_id(client)
    except Exception:
        arrivals = None
    if not arrivals or event.get('channel') != arrivals:
        return False
    # A mention with a photo: the photo listener reads it, message text included.
    if isinstance(event.get('files'), list) and any(is_image(f) for f in event['files']):
        return True
    text = re.sub(
        r'<@([A-Z0-9]+)(?:\|[^>]*)?>', lambda m: ' ' if m.group(1) == bot_user_id else m.group(0), str(event.get('text') or '')
    )
    text = re.sub(r'\s+', ' ', text).strip()
    if not text:
        return False
    with _state_lock:
        _awaiting.pop(event['thread_ts'], None)
    return _correct(client, event, text)


def _awaited_reply(e: dict[str, Any]) -> bool:
    """A plain reply from whoever just ran out of candidates on Wrong order (see `_awaiting`)."""
    if e.get('bot_id') or not e.get('user') or e.get('subtype') or not e.get('thread_ts') or not e.get('text'):
        return False
    with _state_lock:
        w = _awaiting.get(e['thread_ts'])
        if not w or w[0] != e['user']:
            return False
        if w[1] < time.time():
            _awaiting.pop(e['thread_ts'], None)
            return False
    return True


# --- Catch-up sweep ---------------------------------------------------------------------------
# Socket Mode drops events while the bot is down (deploys, restarts) or reconnecting, and a missed
# photo never gets another event. So at startup and every 15 minutes, re-read the channel's recent
# photo posts and handle any PERBot hasn't answered — the listener's own `_seen` memory keeps a
# photo from being handled twice in one process.

SWEEP_WINDOW_S = 36 * 3600
SWEEP_EVERY_S = 15 * 60
# Leave fresh posts to the live listener (its event may still be in flight).
SWEEP_MIN_AGE_S = 2 * 60

_own_ids_cache: tuple[str | None, str | None] | None = None


def _own_ids(client: WebClient) -> tuple[str | None, str | None]:
    """PERBot's (bot id, user id): the id on its messages, and the one in its @-mentions."""
    global _own_ids_cache
    if _own_ids_cache is None:
        try:
            r = client.auth_test()
            _own_ids_cache = (r.get('bot_id'), r.get('user_id'))
        except Exception:
            return None, None
    return _own_ids_cache


def is_photo_post(m: Any) -> bool:
    """A human photo post."""
    m = m or {}
    return (
        not m.get('bot_id')
        and bool(m.get('user'))
        and m.get('subtype') != 'message_changed'
        and isinstance(m.get('files'), list)
        and any(is_image(f) for f in m['files'])
    )


def already_answered(photo: Any, thread_messages: list[Any], bot: str | None) -> bool:
    """PERBot already replied in the photo's thread after it was posted."""
    return bool(bot) and any(
        (m or {}).get('bot_id') == bot and float(m['ts']) > float(photo['ts']) for m in thread_messages
    )


def recent_photo_posts(client: WebClient, channel: str, oldest: str) -> list[tuple[dict[str, Any], list[Any]]]:
    """Photo posts since `oldest` (top level, and replies in those threads) with each one's thread."""
    top: list[Any] = []
    cursor: str | None = None
    while True:
        res = client.conversations_history(channel=channel, oldest=oldest, limit=200, cursor=cursor)
        top.extend(res.get('messages') or [])
        cursor = (res.get('response_metadata') or {}).get('next_cursor') or None
        if not cursor:
            break
    out: list[tuple[dict[str, Any], list[Any]]] = []
    for m in top:
        thread = (client.conversations_replies(channel=channel, ts=m['ts'], limit=200).get('messages') or [m]) if m.get('reply_count') else [m]
        for t in thread:
            if is_photo_post(t) and float(t['ts']) >= float(oldest):
                out.append((t, thread))
    return sorted(out, key=lambda p: float(p[0]['ts']))


_sweeping = threading.Lock()


def _sweep(client: WebClient) -> None:
    if not _sweeping.acquire(blocking=False):
        return
    try:
        channel = _arrivals_channel_id(client)
        if not channel:
            return
        bot = _own_ids(client)[0]
        oldest = f'{time.time() - SWEEP_WINDOW_S:.6f}'
        fresh_cutoff = time.time() - SWEEP_MIN_AGE_S
        posts = recent_photo_posts(client, channel, oldest)
        for msg, thread in posts:
            if float(msg['ts']) > fresh_cutoff or not _claim(f"{channel}:{msg['ts']}"):
                continue
            if already_answered(msg, thread, bot):
                continue
            logger.info(f"Arrivals: catching up on a missed photo {msg['ts']}")
            handle_photo(client, {**msg, 'channel': channel})
        _remind_stale(client, channel, [t for _, t in posts], bot)
    except Exception as err:
        logger.warn('Arrivals: catch-up sweep failed', err)
    finally:
        _sweeping.release()


# --- Reminders -----------------------------------------------------------------------------------
# A card nobody tapped for 4 hours: DM its order's requesters once (9am–10pm Eastern), and note it on
# the card — the note doubles as the "already reminded" marker, so restarts don't re-send.

REMIND_AFTER_S = 4 * 3600


def _waking(now: datetime | None = None) -> bool:
    hour = (now or datetime.now(timezone.utc)).astimezone(ZoneInfo('America/New_York')).hour
    return 9 <= hour < 22


def _insert_after(blocks: list[Any], after_id: str, block: Any) -> list[Any]:
    """Insert `block` right after the block with `after_id`."""
    i = next((n for n, b in enumerate(blocks) if (b or {}).get('block_id') == after_id), -1)
    return [*blocks, block] if i < 0 else [*blocks[: i + 1], block, *blocks[i + 1 :]]


def _remind_stale(client: WebClient, channel: str, threads: list[list[Any]], bot: str | None) -> None:
    if not bot or not _waking():
        return
    cutoff = time.time() - REMIND_AFTER_S
    replies: dict[str, Any] = {}
    for thread in threads:
        for m in thread:
            if (m or {}).get('bot_id') == bot and float(m['ts']) < cutoff and isinstance(m.get('blocks'), list):
                replies[m['ts']] = m

    open_rows: list[ArrivalRow] | None = None
    people: dict[str, str] | None = None
    for m in replies.values():
        blocks: list[Any] = m['blocks']
        for b in m['blocks']:
            index = card_index((b or {}).get('block_id'))
            if index is None or b.get('block_id') != f'arrival_actions:{index}' or not is_card(blocks, index):
                continue
            if any((x or {}).get('block_id') == f'arrival_reminded:{index}' for x in blocks):
                continue
            key = next((v['k'] for v in (decode_value((el or {}).get('value')) for el in b.get('elements') or []) if v and v.get('k')), None)
            if not key:
                continue
            if open_rows is None:
                open_rows = _notion().open_rows()
            if people is None:
                people = people_map(client, _notion())
            order = next((o for o in group_orders(open_rows) if o.key == key), None)
            if not order:
                continue  # marked in Notion meanwhile
            targets = list(dict.fromkeys(people[n] for r in order.rows for n in r.point_of_contact if people.get(n)))[:3]
            try:
                link = client.chat_getPermalink(channel=channel, message_ts=m['ts']).get('permalink')
            except Exception:
                link = None
            for target in targets:
                try:
                    client.chat_postMessage(channel=target, text=reminder_dm(order, link), unfurl_links=False)
                except Exception as err:
                    logger.warn(f'Arrivals: reminder DM to {target} failed', err)
            note = (
                f":bell: Reminded {', '.join(f'<@{t}>' for t in targets)} by DM"
                if targets
                else ':bell: Still unconfirmed — mark it in Notion if it’s ours'
            )
            blocks = _insert_after(
                blocks,
                b['block_id'],
                {'type': 'context', 'block_id': f'arrival_reminded:{index}', 'elements': [{'type': 'mrkdwn', 'text': note}]},
            )
            logger.info(f"Arrivals: reminded {len(targets)} requester(s) about {m['ts']} card {index}.")
        if blocks is not m['blocks']:
            try:
                client.chat_update(channel=channel, ts=m['ts'], text=m.get('text') or 'Package arrived', blocks=blocks)
            except Exception as err:
                logger.warn('Arrivals: could not note the reminder', err)


# --- Click handling ---------------------------------------------------------------------------

_people_index: tuple[float, list[Indexed]] | None = None
_people_index_lock = threading.Lock()


def _notion_people() -> list[Indexed]:
    global _people_index
    with _people_index_lock:
        if not _people_index or time.time() - _people_index[0] > 3600:
            _people_index = (time.time(), index_notion_users(_notion().list_users()))
        return _people_index[1]


def _receiver_notion_id(client: WebClient, slack_user_id: str) -> str | None:
    try:
        return slack_user_to_notion_id(client, slack_user_id, _notion_people())
    except Exception as err:
        logger.warn(f'Arrivals: could not resolve {slack_user_id} to a Notion person', err)
        return None


def _rows_for(ids: list[str], known: list[ArrivalRow]) -> list[ArrivalRow]:
    by_id = {r.id.replace('-', ''): r for r in known}
    return [by_id.get(i) or _notion().fetch_row(i) for i in ids]


UNDO_WINDOW_S = 24 * 3600
NO_PACKAGE = Extraction()


def _card_base(blocks: list[Any], index: int) -> dict[str, str] | None:
    """The `{u, ts}` a card's buttons carry (every card has a Wrong order button)."""
    actions = next((b for b in blocks if (b or {}).get('block_id') == f'arrival_actions:{index}'), None)
    for el in (actions or {}).get('elements') or []:
        v = decode_value((el or {}).get('value'))
        if v:
            return {'u': v['u'], 'ts': v['ts']}
    return None


def _card_for_order(
    index: int,
    key: str,
    base: dict[str, str],
    lead: str,
    restored: list[ArrivalRow] | None = None,
    rejected: list[str] | None = None,
) -> list[Any] | None:
    """A fresh card for order `key`, as of the photo: its open rows plus `restored` (rows an Undo just
    reopened — the Notion query can lag the write by a moment), the vendor's other orders as the select."""
    rejected = rejected or []
    as_of = datetime.fromtimestamp(float(base['ts']), tz=timezone.utc)
    by_id = {r.id: r for r in _notion().open_rows()}
    for r in restored or []:
        by_id[r.id] = r
    orders = group_orders(eligible_rows(list(by_id.values()), as_of))
    order = next((o for o in orders if o.key == key), None)
    if not order:
        return None
    others = [o for o in orders_for_vendor(orders, order.vendor) if o is not order and o.key not in rejected]
    # Only who/when carries over from the tapped button — not its undo rows or rejections.
    return guess_card(index, order, rank_orders(others, NO_PACKAGE, as_of), order.vendor, {'u': base['u'], 'ts': base['ts']}, lead, rejected)


def _select_keys(blocks: list[Any], index: int) -> list[str]:
    """The order keys in card `index`'s "Other … orders" select, in the order shown."""
    actions = next((b for b in blocks if (b or {}).get('block_id') == f'arrival_actions:{index}'), None)
    select = next((el for el in (actions or {}).get('elements') or [] if (el or {}).get('action_id') == ARRIVAL_ACTION_IDS['other']), None)
    return [str(o.get('value') or '') for o in (select or {}).get('options') or [] if o.get('value')]


def _dm_requesters(client: WebClient, rows: list[ArrivalRow], clicker: str, poster: str, permalink: str | None, arrived_at_iso: str) -> None:
    """DM each requester whose rows were just marked (not the person who tapped, nor the one who posted the photo)."""
    people = people_map(client, _notion())
    by_person: dict[str, list[ArrivalRow]] = {}
    for row in rows:
        for name in row.point_of_contact:
            slack_id = people.get(name)
            if not slack_id or slack_id in (clicker, poster):
                continue
            by_person.setdefault(slack_id, []).append(row)
    for slack_id, theirs in by_person.items():
        try:
            client.chat_postMessage(
                channel=slack_id,
                text=arrival_dm(theirs, clicker=clicker, poster=poster, permalink=permalink, arrived_at_iso=arrived_at_iso),
                unfurl_links=False,
            )
        except Exception as err:
            logger.warn(f'Arrivals: could not DM {slack_id}', err)


def _start_sweeps(client: WebClient) -> None:
    def loop() -> None:
        time.sleep(30)
        while True:
            _sweep(client)
            time.sleep(SWEEP_EVERY_S)

    threading.Thread(target=loop, name='arrivals-sweep', daemon=True).start()


def register_arrivals(app: App) -> None:
    if not config.arrivals.channel:
        logger.info('Arrivals: ARRIVALS_CHANNEL unset; delivery-photo listener disabled.')
        return

    logger.info(f'Arrivals: listening for delivery photos in "{config.arrivals.channel}".')
    _start_sweeps(app.client)

    @app.event('message')
    def _message(event, client):
        e = event
        photo = is_photo_post(e)
        if not photo and not _awaited_reply(e):
            return
        try:
            arrivals = _arrivals_channel_id(client)
        except Exception as err:
            logger.error('Arrivals: could not resolve the channel', err)
            return
        if e.get('channel') != arrivals or not _claim(f"{e['channel']}:{e['ts']}"):
            return
        if photo:
            handle_photo(client, e)
            return
        me = _own_ids(client)[1]
        if me and f'<@{me}' in str(e.get('text')):
            return  # the mention handler has it
        with _state_lock:
            _awaiting.pop(e['thread_ts'], None)
        try:
            _correct(client, e, str(e.get('text')))
        except Exception as err:
            logger.error('Arrivals: correction failed', err)

    @app.action(ARRIVAL_ACTION_RE)
    def _action(ack, body, action, respond, client):
        ack()
        action_id = action.get('action_id', '')
        # A checkbox toggled: its state rides along with the next button tap.
        if action_id == ARRIVAL_ACTION_IDS['items']:
            return
        _handle_click(body, action, respond, client)


def _handle_click(body: dict[str, Any], action: dict[str, Any], respond: Any, client: WebClient) -> None:
    action_id: str = action.get('action_id', '')
    block_id: str = action.get('block_id', '')
    clicker = (body.get('user') or {}).get('id')
    channel = (body.get('channel') or {}).get('id')
    message = body.get('message') or {}
    existing: list[Any] = message.get('blocks') or []
    if not clicker or not channel:
        return
    index = card_index(block_id)
    card = index is not None and is_card(existing, index)
    notion = _notion()

    def replace(blocks: list[Any], text: str | None = None) -> None:
        respond(replace_original=True, text=text or message.get('text') or 'Package arrived', blocks=blocks)

    def whisper(text: str) -> None:
        respond(response_type='ephemeral', replace_original=False, text=text)

    try:
        # "Other <vendor> orders…": swap this card for the picked order.
        if action_id == ARRIVAL_ACTION_IDS['other']:
            key = (action.get('selected_option') or {}).get('value')
            base = _card_base(existing, index) if index is not None else None
            if not key or not base or index is None:
                return
            actions = next((b for b in existing if (b or {}).get('block_id') == f'arrival_actions:{index}'), None)
            rejected = [k for el in (actions or {}).get('elements') or [] for k in ((decode_value((el or {}).get('value')) or {}).get('n') or [])]
            nxt = _card_for_order(index, key, base, f'↪️ <@{clicker}> switched orders.', [], rejected)
            if not nxt:
                whisper('That order isn’t open anymore — someone may have just marked it. Check Notion.')
                return
            replace(replace_card(existing, index, nxt))
            return

        value = decode_value(action.get('value'))
        if not value:
            return

        if action_id == ARRIVAL_ACTION_IDS['undo']:
            if value.get('t') and time.time() - value['t'] > UNDO_WINDOW_S:
                whisper('Too late to undo here — fix it in Notion.')
                return
            ready = set(value.get('p') or [])
            restored: list[ArrivalRow] = []
            for id_ in value.get('r') or []:
                previous = 'Ready for Pickup' if id_ in ready else 'No'
                notion.unmark_arrived(id_, previous)
                restored.append(dataclasses.replace(notion.fetch_row(id_), arrived=previous))
            lead = f"↩️ <@{clicker}> undid that — {len(restored)} item{'' if len(restored) == 1 else 's'} back to not arrived. "
            nxt = _card_for_order(index, value['k'], value, lead, restored) if index is not None and value.get('k') else None  # type: ignore[arg-type]
            replace(replace_card(existing, index, nxt) if nxt and index is not None else settle_card(existing, index or 0, lead.strip()))
            logger.info(f'Arrivals: {clicker} undid {len(restored)} rows.')
            return

        if action_id == ARRIVAL_ACTION_IDS['wrong']:
            # Never a dead end: swap to the vendor's next open order not yet rejected; with none left, ask what's inside.
            thread_ts = message.get('thread_ts') or message.get('ts')
            rejected = list(dict.fromkeys([*(value.get('n') or []), *([value['k']] if value.get('k') else [])]))
            if thread_ts:
                _reject(thread_ts, rejected)
            if card and index is not None:
                for key in [k for k in _select_keys(existing, index) if k not in rejected]:
                    nxt = _card_for_order(index, key, value, f'✗ <@{clicker}>: not that one — nothing was written.', [], rejected)  # type: ignore[arg-type]
                    if nxt:
                        replace(replace_card(existing, index, nxt), 'Not that order')
                        return
            text = (
                f'✗ <@{clicker}>: not this order — nothing was written. Reply here with what’s in the box '
                '(or who it’s for) and I’ll look again, or mark it in Notion.'
            )
            if thread_ts:
                with _state_lock:
                    _awaiting[thread_ts] = (clicker, time.time() + AWAIT_S)
            replace(settle_card(existing, index, text) if card and index is not None else settle_blocks(existing, block_id, text), 'Not this order')
            return

        # Mark arrived: the ticked checkboxes. Legacy/whole-set buttons: the ids in the value.
        run_rows: list[ArrivalRow] = []
        if action_id == ARRIVAL_ACTION_IDS['mark']:
            state = (((body.get('state') or {}).get('values') or {}).get(f'arrival_items:{index}') or {}).get(ARRIVAL_ACTION_IDS['items'])
            # No state for an untouched box group: fall back to what the card pre-ticked.
            items_block = next((b for b in existing if (b or {}).get('block_id') == f'arrival_items:{index}'), None)
            shown_ticks = (((items_block or {}).get('elements') or [{}])[0]).get('initial_options')
            selected = state.get('selected_options') if state else shown_ticks
            ids = [str(o.get('value')) for o in selected or []]
            if not ids:
                whisper('Tick the items that arrived, then tap *Mark arrived*.')
                return
        else:
            run_rows = notion.rows_for_run(value['g']) if value.get('g') else []
            ids = target_ids(value, [r.id for r in run_rows])
        rows = _rows_for(ids, run_rows)
        already = [r for r in rows if r.arrived == ARRIVED_YES]
        todo = [r for r in rows if r.arrived != ARRIVED_YES]

        arrived_at = to_iso(datetime.fromtimestamp(float(value['ts']), tz=timezone.utc))
        with ThreadPoolExecutor(max_workers=3) as pool:
            received_f = pool.submit(_receiver_notion_id, client, value['u'])
            name_f = pool.submit(slack_name, client, value['u'])
            link_f = pool.submit(client.chat_getPermalink, channel=channel, message_ts=value['ts'])
            received_by = received_f.result()
            try:
                name = name_f.result()
                received_by_name = None if name == value['u'] else name
            except Exception:
                received_by_name = None
            try:
                permalink = link_f.result().get('permalink')
            except Exception:
                permalink = None

        marked: list[ArrivalRow] = []
        failed: list[ArrivalRow] = []
        for row in todo:
            try:
                notion.mark_arrived(row.id, ArrivalWrite(arrived_at, received_by, received_by_name, permalink))
                marked.append(row)
            except Exception as err:
                logger.error(f'Arrivals: write failed for {row.id}', err)
                failed.append(row)

        done = len(marked)
        parts = [f"✅ <@{clicker}> marked *{done}* item{'' if done == 1 else 's'} arrived (received by <@{value['u']}>)"]
        if already:
            parts.append(f'{len(already)} already marked')
        if failed:
            parts.append(f'⚠️ {len(failed)} failed — set Arrived? in Notion')
        lead = lead_time_line(rows, arrived_at)
        outcome = ' · '.join(parts) + (f'\n{lead}' if lead else '')

        if card and index is not None:
            undo: ArrivalButtonValue | None = None
            if done:
                undo = {
                    'u': value['u'],
                    'ts': value['ts'],
                    'r': [compact(r.id) for r in marked],
                    'p': [compact(r.id) for r in marked if r.arrived == 'Ready for Pickup'],
                }
                if value.get('k'):
                    undo['k'] = value['k']
                undo['t'] = int(time.time())
            replace(settle_card(existing, index, outcome, marked, undo), f'{done} items marked arrived')
        else:
            chosen = re.match(r'^arrival_order:(\d+)$', action_id)
            replace(settle_blocks(existing, block_id, outcome, int(chosen.group(1)) if chosen else None), f'{done} items marked arrived')
        logger.info(f'Arrivals: {clicker} {action_id} → {done} marked, {len(already)} already, {len(failed)} failed.')
        if done:
            _dm_requesters(client, marked, clicker, value['u'], permalink, arrived_at)
    except Exception as err:
        logger.error(f'Arrivals: {action_id} failed', err)
        whisper('✗ Could not update Notion. Try again, or set Arrived? in Notion.')

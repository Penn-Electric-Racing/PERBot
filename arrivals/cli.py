"""Read-only runs of the arrivals pipeline. Reads Slack + Notion, calls the vision model, posts and
writes nothing. Prices are never printed (never extracted).

  python -m arrivals.cli try slip.jpg [more.jpg] [--text "Jlc picked up"]   one message (files = one post)
  python -m arrivals.cli try --each ./photos                               every image as its own post
  python -m arrivals.cli backtest [--limit 30]                             replay ARRIVALS_CHANNEL's history:
      every human photo (threads too), matched against orders as of when it was posted, printing what
      PERBot would have replied — or that it would have stayed silent.
  python -m arrivals.cli post <ts|permalink> [--force|--replace]           the one mode that WRITES to Slack:
      posts the reply the live bot missed into that message's thread; --replace rebuilds PERBot's untapped
      reply there in place (after a layout change). See post_missed.
"""
from __future__ import annotations

import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from slack_sdk import WebClient

from config import config
from sponsorship.jobs.shared import resolve_channel_id
from arrivals.blocks import Reply
from arrivals.extract import SlipImage
from arrivals.models import ArrivalRow
from arrivals.notion import ArrivalsNotion
from arrivals.people import people_map
from arrivals.pipeline import DeliveryMessage, DeliveryResult, is_image, load_images, parent_text, process_delivery, with_names
from arrivals.slack import already_answered, handle_photo, is_photo_post

TYPES = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp'}


def _flag(args: list[str], name: str) -> str | None:
    if name in args:
        i = args.index(name)
        value = args[i + 1] if i + 1 < len(args) else None
        del args[i : i + 2]
        return value
    return None


def render(reply: Reply | None) -> str:
    """Block Kit → plain text for the terminal."""
    if not reply:
        return '  (silent)'

    def element(e: dict[str, Any]) -> str:
        if e.get('type') == 'checkboxes':
            ticked = {o['value'] for o in e.get('initial_options') or []}
            return '\n'.join(
                f"  {'☑' if o['value'] in ticked else '☐'} {o['text']['text']}"
                + (f"  ({o['description']['text']})" if o.get('description') else '')
                for o in e['options']
            )
        if e.get('type') == 'static_select':
            return f"  [▾ {e['placeholder']['text']}: {' | '.join(o['text']['text'] for o in e['options'])}]"
        return f"  [{e['text']['text']}]"

    def block(b: dict[str, Any]) -> str:
        if b.get('type') == 'section':
            return b['text']['text']
        if b.get('type') == 'context':
            return '  ' + ' '.join(e['text'] for e in b['elements'])
        if b.get('type') == 'actions':
            return '\n'.join(element(e) for e in b['elements'])
        return '  ---' if b.get('type') == 'divider' else ''

    text = re.sub(r'<([^|>]+)\|([^>]+)>', r'\2', '\n'.join(block(b) for b in reply.blocks))
    return '\n'.join(f'  {l}' for l in text.split('\n'))


def _summarize(label: str, result: DeliveryResult, seconds: float) -> None:
    scan = result.scan
    print(f'=== {label}  ({seconds:.1f}s)')
    print(f"scene: {scan.scene} · legible: {'yes' if scan.legible else 'NO'} · packages: {len(scan.packages)}")
    for i, p in enumerate(scan.packages):
        bits = [
            f"vendor={p.vendor or '?'}",
            f'to={p.addressee}' if p.addressee else '',
            f'shipped={p.ship_date}' if p.ship_date else '',
            f"#={','.join(o.value for o in p.order_numbers)}" if p.order_numbers else '',
            f'lines={len(p.lines)}' if p.lines else '',
            f"hints={'; '.join(p.item_hints)}" if p.item_hints else '',
        ]
        kind = result.resolutions[i].kind if i < len(result.resolutions) else '-'
        print(f"  pkg {i + 1}: {' · '.join(b for b in bits if b)} → {kind}")
    print(render(result.reply))
    print('')


def try_local(args: list[str], open_rows: list[ArrivalRow]) -> None:
    text = _flag(args, '--text') or ''
    each = '--each' in args
    targets = [a for a in args if a != '--each']
    if not targets:
        raise RuntimeError('Usage: python -m arrivals.cli try [--each] <image|folder> [...] [--text "message"]')
    files: list[Path] = []
    for t in targets:
        p = Path(t)
        if p.is_dir():
            files.extend(sorted(f for f in p.iterdir() if f.suffix.lower() in TYPES))
        else:
            files.append(p)
    for group in ([[f] for f in files] if each else [files]):
        images = [SlipImage(f.read_bytes(), TYPES.get(f.suffix.lower(), 'image/jpeg')) for f in group]
        started = time.time()
        msg = DeliveryMessage(ts=str(time.time()), user='U_LOCAL', text=text, in_thread=False, images=images)
        _summarize(' + '.join(f.name for f in group), process_delivery(msg, open_rows), time.time() - started)


def backtest(args: list[str], open_rows: list[ArrivalRow]) -> None:
    limit = int(_flag(args, '--limit') or 50)
    client = WebClient(token=config.slack.bot_token)
    channel = resolve_channel_id(client, config.arrivals.channel or 'packages')
    if not channel:
        raise RuntimeError('ARRIVALS_CHANNEL not found')

    top: list[Any] = []
    cursor: str | None = None
    while True:
        res = client.conversations_history(channel=channel, limit=200, cursor=cursor)
        top.extend(res.get('messages') or [])
        cursor = (res.get('response_metadata') or {}).get('next_cursor') or None
        if not cursor:
            break

    posts: list[tuple[dict[str, Any], dict[str, Any] | None]] = []
    for m in top:
        posts.append((m, None))
        if m.get('reply_count'):
            res = client.conversations_replies(channel=channel, ts=m['ts'], limit=200)
            posts.extend((r, m) for r in (res.get('messages') or [])[1:])
    photos = sorted(
        (p for p in posts if not p[0].get('bot_id') and p[0].get('user') and any(is_image(f) for f in p[0].get('files') or [])),
        key=lambda p: float(p[0]['ts']),
    )[-limit:]
    print(f"{len(photos)} human photo posts in #{config.arrivals.channel or 'packages'} (Slack keeps ~90 days).\n")

    tally: dict[str, int] = {}
    for msg, parent in photos:
        started = time.time()
        result = process_delivery(
            DeliveryMessage(
                ts=msg['ts'],
                user=msg['user'],
                text=with_names(client, msg.get('text') or ''),
                parent_text=with_names(client, parent.get('text') or '') if parent else None,
                in_thread=bool(parent),
                images=load_images(client, msg.get('files') or []),
            ),
            open_rows,
        )
        if not result.reply:
            outcome = 'silent'
        elif any(b.get('type') == 'actions' for b in result.reply.blocks):
            outcome = 'buttons'
        else:
            outcome = 'nudge'
        tally[outcome] = tally.get(outcome, 0) + 1
        when = datetime.fromtimestamp(float(msg['ts']), tz=timezone.utc).strftime('%Y-%m-%d')
        label = f"{when} {'(thread) ' if parent else ''}{json.dumps((msg.get('text') or '')[:60], ensure_ascii=False)}"
        _summarize(label, result, time.time() - started)
    print('Outcomes:', json.dumps(tally))


def post_missed(args: list[str]) -> None:
    """Post the reply the live bot missed (it was down, or the event never arrived): runs the same
    handler as the listener on one message and replies in its thread as PERBot. Taps on the buttons
    are handled by the deployed bot, so run this only once the deploy is healthy. Refuses if PERBot
    already replied."""
    force = '--force' in args
    target = next((a for a in args if not a.startswith('--')), '')
    m = re.search(r'p?(\d{10})\.?(\d{6})', target)
    if not m:
        raise RuntimeError('Usage: python -m arrivals.cli post <message ts or permalink> [--force | --replace]')
    message_ts = f'{m.group(1)}.{m.group(2)}'
    client = WebClient(token=config.slack.bot_token)
    channel = resolve_channel_id(client, config.arrivals.channel or 'packages')
    if not channel:
        raise RuntimeError('ARRIVALS_CHANNEL not found')

    res = client.conversations_history(channel=channel, latest=message_ts, oldest=message_ts, inclusive=True, limit=1)
    msg = (res.get('messages') or [None])[0]
    if not msg:
        # A thread reply: permalinks carry the parent as ?thread_ts=…
        parent = re.search(r'thread_ts=(\d+\.\d+)', ' '.join(args))
        if not parent:
            raise RuntimeError(f'No top-level message {message_ts} in the channel; for a thread reply pass its permalink.')
        thread = client.conversations_replies(channel=channel, ts=parent.group(1), latest=message_ts, oldest=message_ts, inclusive=True, limit=1)
        msg = next((x for x in thread.get('messages') or [] if x.get('ts') == message_ts), None)
        if not msg:
            raise RuntimeError(f'Message {message_ts} not found.')
    if not is_photo_post(msg):
        raise RuntimeError('That message has no photo.')

    me = client.auth_test()
    thread_ts = msg.get('thread_ts') or msg['ts']
    thread_messages = client.conversations_replies(channel=channel, ts=thread_ts, limit=200).get('messages') or []
    if '--replace' in args:
        # Rebuild PERBot's earlier reply in place (e.g. after a layout change) — never one someone already tapped.
        earlier = next((x for x in thread_messages if x.get('bot_id') == me.get('bot_id') and float(x['ts']) > float(msg['ts'])), None)
        if not earlier:
            raise RuntimeError('No PERBot reply to replace in that thread.')
        if not any(re.match(r'^arrival_(actions|choice):', b.get('block_id') or '') for b in earlier.get('blocks') or []):
            raise RuntimeError('That reply was already settled; leaving it alone.')
        in_thread = bool(msg.get('thread_ts') and msg['thread_ts'] != msg['ts'])
        notion = ArrivalsNotion()
        result = process_delivery(
            DeliveryMessage(
                ts=msg['ts'],
                user=msg['user'],
                text=with_names(client, msg.get('text') or ''),
                parent_text=parent_text(client, channel, msg['thread_ts']) if in_thread else None,
                in_thread=in_thread,
                images=load_images(client, msg.get('files') or []),
                people=people_map(client, notion),
            ),
            notion.open_rows(),
        )
        if not result.reply:
            raise RuntimeError('The pipeline now stays silent on this photo; not touching the old reply.')
        client.chat_update(channel=channel, ts=earlier['ts'], text=result.reply.text, blocks=result.reply.blocks)
        print(render(result.reply))
        print(f"Replaced PERBot's reply {earlier['ts']}.")
        return
    if already_answered(msg, thread_messages, me.get('bot_id')) and not force:
        raise RuntimeError('PERBot already replied in that thread (pass --force to post anyway).')

    handle_photo(client, {**msg, 'channel': channel})
    print(f'Done — check the thread on {message_ts}.')


def main(argv: list[str] | None = None) -> None:
    args = list(sys.argv[1:] if argv is None else argv)
    mode = args.pop(0) if args else ''
    if mode == 'post':
        post_missed(args)
        return
    open_rows = ArrivalsNotion().open_rows()
    print(f'{len(open_rows)} open Purchasing rows.\n')
    if mode == 'backtest':
        backtest(args, open_rows)
    else:
        try_local(args, open_rows)


if __name__ == '__main__':
    try:
        main()
    except Exception as err:
        print(err, file=sys.stderr)
        sys.exit(1)

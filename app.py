"""PERBot's Slack entrypoint (Socket Mode): `/dt`, `/anon`, `/reindex`, `/indexstatus`, @PERBot
mentions, and every feature module's commands, buttons and modals.

Run: `python -m app`
"""
from __future__ import annotations

import os
import random
import re
import subprocess
import sys
import threading
from dataclasses import dataclass
from typing import Any

from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler
from slack_sdk import WebClient

from arrivals.slack import handle_arrivals_mention, register_arrivals
from benbuys.slack import register_benbuys_command
from config import config
from models import IndexStatus, SearchResult
from ops_tasks.actions import register_ops_task_actions
from ops_tasks.assign import assign_from_mention, register_assign_command, register_assign_shortcut
from price_check.actions import register_price_check_actions
from price_check.stats import register_price_check_stats
from race.slack import register_race_command
from services.index_downloader import download_index_from_release, fetch_index_stamp
from services.index_store import (
    LoadedIndex,
    assemble_index,
    get_loaded_index,
    index_exists,
    load_index,
    load_status,
    read_index_files,
    set_loaded_index,
)
from services.llm import AnswerSource, ThreadMessage, answer_from_sources, classify_mention, summarize_thread
from services.search import context_for_result, search_index
from services.slack_format import ResultMeta, build_result_blocks
from sponsorship.actions import register_sponsor_actions
from sponsorship.slack import register_sponsor_commands
from utils.logger import logger

app = App(token=config.slack.bot_token)

# ---------------------------------------------------------------------------------------------
# Index lifecycle: load once, hot-swap when the nightly release updates.
# ---------------------------------------------------------------------------------------------

_reindex_lock = threading.Lock()
_reindex_in_progress = False
# `updated_at` of the release asset the loaded index came from; drives the hourly refresh.
_loaded_stamp: str | None = None
# One load at a time: concurrent /dt calls during startup or a hot swap all wait on this lock and
# then find the index already loaded.
_load_lock = threading.Lock()


def _unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def ensure_index_loaded() -> LoadedIndex | None:
    cached = get_loaded_index()
    if cached:
        return cached
    with _load_lock:
        return get_loaded_index() or _load_or_download()


def _load_or_download() -> LoadedIndex | None:
    global _loaded_stamp
    if not index_exists():
        dl = download_index_from_release()
        if not dl:
            return None
        _loaded_stamp = dl.get('stamp')
    try:
        loaded = load_index()
        idx = loaded.index
        logger.info(
            f"Index loaded: {len(idx['pages'])} pages, {len(idx['chunks'])} chunks (generated {idx.get('generatedAt')})."
        )
        if not _loaded_stamp:
            _loaded_stamp = fetch_index_stamp()
        return loaded
    except Exception as err:
        # A half-replaced pair (download overlapping the nightly upload) would otherwise wedge the
        # bot: the files exist, so nothing re-downloads. Drop them so the next call fetches a fresh pair.
        logger.error('Index files exist but could not be loaded; discarding them.', err)
        _unlink(config.app.index_path)
        _unlink(config.app.embeddings_path)
        _loaded_stamp = None
        return None


def refresh_index_if_newer() -> None:
    global _loaded_stamp
    if _reindex_in_progress:
        return
    stamp = fetch_index_stamp()
    if not stamp or stamp == _loaded_stamp:
        return

    logger.info(f'Release index updated ({stamp}); downloading the new one.')
    nxt = {'index_path': f'{config.app.index_path}.next', 'embeddings_path': f'{config.app.embeddings_path}.next'}
    dl = download_index_from_release(nxt)
    if not dl:
        return
    try:
        # Parse the new files first (cheap to fail), then swap the files into place and rebuild the
        # in-memory index with the old one already released — holding both plus BM25 scratch would
        # roughly triple memory on a 512 MB worker. Queries during the rebuild wait on the load lock.
        index, embeddings = read_index_files(nxt['index_path'], nxt['embeddings_path'])
        with _load_lock:
            os.replace(nxt['index_path'], config.app.index_path)
            os.replace(nxt['embeddings_path'], config.app.embeddings_path)
            _loaded_stamp = dl.get('stamp')
            set_loaded_index(None)
            set_loaded_index(assemble_index(index, embeddings))
        logger.info(f"Swapped in index generated {index.get('generatedAt')} ({len(index['pages'])} pages).")
    except Exception as err:
        logger.error('New index could not be loaded; keeping the current one.', err)
        _unlink(nxt['index_path'])
        _unlink(nxt['embeddings_path'])


def _refresh_loop(stop: threading.Event, every_s: float) -> None:
    while not stop.wait(every_s):
        try:
            refresh_index_if_newer()
        except Exception as err:
            logger.warn('Index refresh check failed.', err)


def _format_status(status: IndexStatus | None) -> str:
    loaded = get_loaded_index()
    parts = [
        (
            f"*Loaded index:* {len(loaded.index['pages']):,} pages, {len(loaded.index['chunks']):,} chunks, "
            f"generated {loaded.index.get('generatedAt')}"
        )
        if loaded
        else '*Loaded index:* none'
    ]
    if not status:
        parts.append('No index build status has been recorded on this machine.')
        return '\n'.join(parts)
    parts.extend(
        [
            f"*Last build phase:* {status.get('phase')}",
            f"*Message:* {status['message']}" if status.get('message') else '',
            f"*Pages:* {status['totalPages']}" if status.get('totalPages') else '',
            f"*Chunks:* {status['totalChunks']}" if status.get('totalChunks') else '',
            (
                f"*Embedding progress:* {status.get('embeddedChunkBatches') or 0}/{status['totalChunkBatches']} batches "
                f"({status.get('reusedEmbeddings') or 0} reused)"
            )
            if status.get('totalChunkBatches')
            else '',
            f"*Completed:* {status['completedAt']}" if status.get('completedAt') else '',
            f"*Failed:* {status['failedAt']}" if status.get('failedAt') else '',
            f"*Last error:* {status['lastError'][:800]}" if status.get('lastError') else '',
        ]
    )
    return '\n'.join(p for p in parts if p)


# ---------------------------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------------------------


@dataclass
class Answer:
    summary: str
    results: list[SearchResult]
    meta: ResultMeta


def answer_query(query: str) -> Answer:
    loaded = ensure_index_loaded()
    if not loaded:
        status = load_status()
        summary = (
            f'I am still building the PER Notion index.\n{_format_status(status)}'
            if status and status.get('state') == 'indexing'
            else 'I do not have a search index loaded yet. Run `/reindex`, or check that the nightly index build succeeded.'
        )
        return Answer(summary, [], ResultMeta())

    response = search_index(loaded, query)
    results, weak = response['results'], response['weak']
    sources = [
        AnswerSource(
            n=i + 1,
            title=r['page']['title'],
            path_text=r['page'].get('pathText') or '',
            url=r['page']['url'],
            is_historical=bool(r['page'].get('isHistorical')),
            rev_number=r['page'].get('revNumber'),
            text=context_for_result(loaded, r, 2600 if i == 0 else 1600),
        )
        for i, r in enumerate(results[: config.app.max_results_to_summarize])
    ]
    summary = answer_from_sources(query, sources, weak)
    meta = ResultMeta(
        weak=weak, indexed_pages=len(loaded.index['pages']), generated_at=loaded.index.get('generatedAt') or ''
    )
    return Answer(summary, results, meta)


def start_background_reindex(channel_id: str | None = None, thread_ts: str | None = None, trigger_label: str = '') -> bool:
    """Runs the indexer in a child process (it holds far more memory than the bot) and reloads the
    index when it exits cleanly. False if a reindex is already running."""
    global _reindex_in_progress
    with _reindex_lock:
        if _reindex_in_progress:
            return False
        _reindex_in_progress = True
    logger.info(f'[PERBot] Starting background reindex ({trigger_label})...')

    def notify(text: str) -> None:
        if not channel_id:
            return
        try:
            app.client.chat_postMessage(channel=channel_id, thread_ts=thread_ts, text=text)
        except Exception as post_error:
            logger.error('Failed to post reindex message.', post_error)

    def run() -> None:
        global _reindex_in_progress
        try:
            code = subprocess.run([sys.executable, '-m', 'indexer'], env=os.environ.copy()).returncode
        except Exception as error:
            _reindex_in_progress = False
            logger.error('Background reindex failed to start.', error)
            notify(':x: PERBot failed to start the reindex job. Check the Render logs.')
            return
        _reindex_in_progress = False
        if code == 0:
            logger.info('[PERBot] Background reindex finished successfully; reloading.')
            try:
                with _load_lock:
                    load_index()
                notify(':white_check_mark: PERBot finished reindexing and is using the new index.')
            except Exception as err:
                logger.error('Reindex finished but the new index failed to load.', err)
                notify(':x: Reindex finished but the new index could not be loaded. Check Render logs.')
        else:
            logger.error(f'[PERBot] Background reindex exited with code={code}')
            notify(':x: PERBot reindexing failed. Run `/indexstatus` and check Render logs for details.')

    threading.Thread(target=run, name='reindex', daemon=True).start()
    return True


@app.command('/dt')
def _dt(ack, command, client):
    query = (command.get('text') or '').strip()

    if not query:
        ack(
            response_type='ephemeral',
            text=(
                'Usage: `/dt your question here`\nExamples: `/dt how does the PCM box connect to the PDU` · '
                '`/dt rev:11 accumulator cooling` · `/dt subsystem:aero layup schedule`'
            ),
        )
        return

    ack(response_type='ephemeral', text=f'PERBot is searching the docs for: {query}')

    try:
        parent = client.chat_postMessage(
            channel=command['channel_id'],
            text=f'PERBot search: {query}',
            blocks=[
                {'type': 'section', 'text': {'type': 'mrkdwn', 'text': f':mag: *PERBot search started*\n*Query:* `{query}`'}}
            ],
        )
        answer = answer_query(query)
        client.chat_postMessage(
            channel=command['channel_id'],
            thread_ts=parent['ts'],
            text=f'PERBot results for: {query}',
            blocks=build_result_blocks(query, answer.summary, answer.results, answer.meta),
            unfurl_links=False,
            unfurl_media=False,
        )
    except Exception as error:
        logger.error('Slash command failed.', error)
        client.chat_postMessage(channel=command['channel_id'], text=f'PERBot hit an error while searching for: {query}')


@app.command('/anon')
def _anon(ack, command, client, respond):
    allowed_channels = config.slack.anon_allowed_channels
    if command.get('channel_name') not in allowed_channels:
        ack(
            response_type='ephemeral',
            text=f"`/anon` can only be used in: {', '.join(f'#{name}' for name in allowed_channels)}",
        )
        return

    text = (command.get('text') or '').strip()
    if not text:
        ack(
            response_type='ephemeral',
            text='Usage: `/anon your message`\nPERBot will post your message in this channel without revealing who sent it.',
        )
        return

    ack()

    try:
        client.chat_postMessage(
            channel=command['channel_id'],
            text=f':bust_in_silhouette: Anonymous: {text}',
            blocks=[
                {'type': 'section', 'text': {'type': 'mrkdwn', 'text': text}},
                {'type': 'context', 'elements': [{'type': 'mrkdwn', 'text': ':bust_in_silhouette: Sent anonymously via `/anon`'}]},
            ],
            unfurl_links=False,
            unfurl_media=False,
        )
        respond(response_type='ephemeral', text=':white_check_mark: Your anonymous message was posted.')
    except Exception as error:
        # Log only the error itself — never the sender or message text, so anonymity holds even in
        # server logs.
        logger.error('Anonymous message post failed.', error)
        respond(
            response_type='ephemeral',
            text=':x: PERBot could not post your anonymous message. If this is a private channel, invite @PERBot to it first and try again.',
        )


def _user_can_reindex(user_id: str | None) -> bool:
    if not user_id:
        return False
    allowed = config.slack.reindex_allowed_user_ids
    return not allowed or user_id in allowed


@app.command('/reindex')
def _reindex(ack, command, client):
    ack(response_type='ephemeral', text='PERBot received your reindex request.')

    if not _user_can_reindex(command.get('user_id')):
        client.chat_postEphemeral(
            channel=command['channel_id'], user=command['user_id'], text='You are not allowed to run `/reindex` for PERBot.'
        )
        return

    try:
        parent = client.chat_postMessage(
            channel=command['channel_id'],
            text='PERBot reindex request',
            blocks=[
                {
                    'type': 'section',
                    'text': {
                        'type': 'mrkdwn',
                        'text': ':arrows_counterclockwise: *PERBot reindex requested*\nStarting a background rebuild of the Notion index.',
                    },
                }
            ],
        )
        started = start_background_reindex(channel_id=command['channel_id'], thread_ts=parent['ts'], trigger_label='/reindex')
        client.chat_postMessage(
            channel=command['channel_id'],
            thread_ts=parent['ts'],
            text=':hourglass_flowing_sand: Reindex started. PERBot will post here when it finishes.'
            if started
            else ':warning: A PERBot reindex is already in progress.',
        )
    except Exception as error:
        logger.error('Reindex command failed.', error)
        client.chat_postMessage(channel=command['channel_id'], text=':x: PERBot could not start the reindex job.')


@app.command('/indexstatus')
def _indexstatus(ack, command, client):
    ack()
    client.chat_postEphemeral(channel=command['channel_id'], user=command['user_id'], text=_format_status(load_status()))


# ---------------------------------------------------------------------------------------------
# @PERBot mentions: assign → arrivals → thread → chat → docs
# ---------------------------------------------------------------------------------------------

_user_name_cache: dict[str, str] = {}


def _display_name(client: WebClient, user_id: str) -> str:
    cached = _user_name_cache.get(user_id)
    if cached:
        return cached
    name = user_id
    try:
        user = client.users_info(user=user_id).get('user') or {}
        name = user.get('real_name') or (user.get('profile') or {}).get('display_name') or user.get('name') or user_id
    except Exception:
        pass  # fall back to the id
    _user_name_cache[user_id] = name
    return name


def _fetch_thread(client: WebClient, channel: str, thread_ts: str, bot_user_id: str | None) -> list[ThreadMessage]:
    res: Any = client.conversations_replies(channel=channel, ts=thread_ts, limit=200)
    messages: list[ThreadMessage] = []
    for m in res.get('messages') or []:
        if not m.get('text'):
            continue
        if bot_user_id and m.get('user') == bot_user_id:
            continue
        name = _display_name(client, m['user']) if m.get('user') else m.get('username') or 'someone'
        messages.append(ThreadMessage(name=name, text=m['text']))
    return messages


def _clean_mention_text(text: str) -> str:
    text = re.sub(r'<@[^>]+>', ' ', text)
    return re.sub(r'^\s*PERBot[:,\-]?\s*', '', text, flags=re.I).strip()


CHAT_REPLIES = [
    "I'm a docs bot — ask me something about the car or the team and I'll dig through Notion. Try `@PERBot how does the PCM talk to the motor controllers?`",
    "Nothing to look up there. Ask me a docs question (`@PERBot what changed in the REV11 accumulator?`) or `@PERBot summarize this thread` inside a thread.",
]


@app.event('app_mention')
def _app_mention(event, client, context):
    raw_text = event.get('text') or ''
    thread_ts = event.get('thread_ts') or event.get('ts')
    in_thread = bool(event.get('thread_ts'))
    bot_user_id = context.bot_user_id

    # "@PERBot assign @person <task> [by <date>]" — the in-thread way to assign (slash commands
    # can't run in threads). Strip only the bot's own mention so assignee mentions survive.
    without_bot = (re.sub(rf'<@{bot_user_id}(?:\|[^>]*)?>', ' ', raw_text) if bot_user_id else raw_text).strip()
    if re.match(r'^assign\b', without_bot, re.I):
        assign_from_mention(client, without_bot, event.get('user'), event['channel'], thread_ts)
        return

    # In a #packages thread, "@PERBot <what's in the box>" corrects the package match, not a docs question.
    try:
        if handle_arrivals_mention(client, event, bot_user_id):
            return
    except Exception as error:
        logger.error('Arrivals mention failed.', error)
        return

    query = _clean_mention_text(raw_text)

    def reply(text: str, blocks: list[dict[str, Any]] | None = None) -> None:
        kwargs: dict[str, Any] = {'blocks': blocks} if blocks else {}
        client.chat_postMessage(
            channel=event['channel'], thread_ts=thread_ts, text=text, unfurl_links=False, unfurl_media=False, **kwargs
        )

    if not query:
        reply('Ask me a PER docs question after mentioning me. Example: `@PERBot what changed in REV11 chassis?`')
        return

    try:
        intent = classify_mention(query, in_thread)
        logger.info(f'Mention intent={intent} inThread={in_thread} text="{query[:80]}"')

        if intent == 'chat':
            reply(random.choice(CHAT_REPLIES))
            return

        if intent == 'thread':
            messages = _fetch_thread(client, event['channel'], event['thread_ts'], bot_user_id)
            if not messages:
                reply("I couldn't read this thread (I may not have history access in this channel).")
                return
            summary = summarize_thread(query, messages)
            reply(summary, [{'type': 'section', 'text': {'type': 'mrkdwn', 'text': summary[:2900]}}])
            return

        answer = answer_query(query)
        reply(f'PERBot results for: {query}', build_result_blocks(query, answer.summary, answer.results, answer.meta))
    except Exception as error:
        logger.error('Mention handler failed.', error)
        reply('PERBot hit an error while answering. Check Render logs and try `/indexstatus`.')


register_sponsor_commands(app)
register_ops_task_actions(app)
register_assign_command(app)
register_assign_shortcut(app)
register_sponsor_actions(app)
register_benbuys_command(app)
register_arrivals(app)
register_race_command(app)
register_price_check_actions(app)
register_price_check_stats(app)


def main() -> None:
    if not config.slack.app_token:
        raise RuntimeError('Missing required environment variable: SLACK_APP_TOKEN (needed for Socket Mode).')
    logger.info('[PERBot] Starting Slack Socket Mode...')
    handler = SocketModeHandler(app, config.slack.app_token)
    handler.connect()
    logger.info('⚡️ PERBot is running in Slack Socket Mode.')
    logger.info(f'Index path: {config.app.index_path}')

    loaded = ensure_index_loaded()
    if not loaded and config.app.auto_bootstrap_on_missing_index:
        status = load_status()
        if not status or status.get('state') != 'indexing':
            start_background_reindex(trigger_label='auto-bootstrap')

    if config.app.index_refresh_minutes > 0:
        threading.Thread(
            target=_refresh_loop,
            args=(threading.Event(), config.app.index_refresh_minutes * 60),
            name='index-refresh',
            daemon=True,
        ).start()

    # Block the main thread; the socket client and listeners run on their own threads.
    threading.Event().wait()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as error:
        logger.error('Failed to start PERBot.', error)
        sys.exit(1)

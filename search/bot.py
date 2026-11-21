"""Doc search in Slack: `/dt`, `/reindex`, `/indexstatus`, and answers to @PERBot docs questions.

  IndexManager  the in-memory index: load once, hot-swap when the nightly release updates, and
                rebuild in a child process on `/reindex`
  DocSearch     the commands (registered by feature.Search), and `answer_mention` for app.py's
                mention router
"""
from __future__ import annotations

import logging
import os
import random
import subprocess
import sys
import threading
from dataclasses import dataclass
from typing import Any

from slack_sdk import WebClient

from core.config import config
from search.engine import context_for_result, search_index
from search.index_downloader import download_index_from_release, fetch_index_stamp
from search.index_store import (
    LoadedIndex,
    assemble_index,
    get_loaded_index,
    index_exists,
    load_index,
    load_status,
    read_index_files,
    set_loaded_index,
)
from search.llm import (
    AnswerSource,
    ThreadMessage,
    answer_from_sources,
    classify_mention,
    summarize_thread,
)
from search.models import IndexStatus, SearchResult
from search.slack_format import ResultMeta, build_result_blocks

logger = logging.getLogger(__name__)

__all__ = ['LOGS_HINT', 'format_status', 'user_can_reindex', 'IndexManager', 'Answer', 'DocSearch']

LOGS_HINT = 'Check the server logs (`journalctl -u perbot`)'


def _unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass

def format_status(status: IndexStatus | None) -> str:
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

def user_can_reindex(user_id: str | None) -> bool:
    if not user_id:
        return False
    allowed = config.slack.reindex_allowed_user_ids
    return not allowed or user_id in allowed


class IndexManager:
    def __init__(self, post: Any = None):
        # post(channel, thread_ts, text): how reindex progress reaches Slack.
        self.post = post
        self._reindex_lock = threading.Lock()
        self.reindex_in_progress = False
        # `updated_at` of the release asset the loaded index came from; drives the hourly refresh.
        self._loaded_stamp: str | None = None
        # One load at a time: concurrent /dt calls during startup or a hot swap all wait on this
        # lock and then find the index already loaded.
        self._load_lock = threading.Lock()

    def ensure_loaded(self) -> LoadedIndex | None:
        cached = get_loaded_index()
        if cached:
            return cached
        with self._load_lock:
            return get_loaded_index() or self._load_or_download()

    def _load_or_download(self) -> LoadedIndex | None:
        if not index_exists():
            dl = download_index_from_release()
            if not dl:
                return None
            self._loaded_stamp = dl.get('stamp')
        try:
            loaded = load_index()
            idx = loaded.index
            logger.info(f"Index loaded: {len(idx['pages'])} pages, {len(idx['chunks'])} chunks (generated {idx.get('generatedAt')}).")
            if not self._loaded_stamp:
                self._loaded_stamp = fetch_index_stamp()
            return loaded
        except Exception as err:
            # A half-replaced pair (download overlapping the nightly upload) would otherwise wedge
            # the bot: the files exist, so nothing re-downloads. Drop them so the next call fetches
            # a fresh pair.
            logger.error('Index files exist but could not be loaded; discarding them.', exc_info=err)
            _unlink(config.app.index_path)
            _unlink(config.app.embeddings_path)
            self._loaded_stamp = None
            return None

    def refresh_if_newer(self) -> None:
        if self.reindex_in_progress:
            return
        stamp = fetch_index_stamp()
        if not stamp or stamp == self._loaded_stamp:
            return
        logger.info(f'Release index updated ({stamp}); downloading the new one.')
        nxt = {'index_path': f'{config.app.index_path}.next', 'embeddings_path': f'{config.app.embeddings_path}.next'}
        dl = download_index_from_release(nxt)
        if not dl:
            return
        try:
            # Parse the new files first (cheap to fail), then swap the files into place and rebuild
            # the in-memory index with the old one already released: holding both plus BM25 scratch
            # would roughly triple memory. Queries during the rebuild wait on the load lock.
            index, embeddings = read_index_files(nxt['index_path'], nxt['embeddings_path'])
            with self._load_lock:
                os.replace(nxt['index_path'], config.app.index_path)
                os.replace(nxt['embeddings_path'], config.app.embeddings_path)
                self._loaded_stamp = dl.get('stamp')
                set_loaded_index(None)
                set_loaded_index(assemble_index(index, embeddings))
            logger.info(f"Swapped in index generated {index.get('generatedAt')} ({len(index['pages'])} pages).")
        except Exception as err:
            logger.error('New index could not be loaded; keeping the current one.', exc_info=err)
            _unlink(nxt['index_path'])
            _unlink(nxt['embeddings_path'])

    def start_refresh_loop(self, every_s: float) -> None:
        def loop() -> None:
            stop = threading.Event()
            while not stop.wait(every_s):
                try:
                    self.refresh_if_newer()
                except Exception as err:
                    logger.warning('Index refresh check failed.', exc_info=err)

        threading.Thread(target=loop, name='index-refresh', daemon=True).start()

    def start_reindex(self, channel_id: str | None = None, thread_ts: str | None = None, trigger_label: str = '') -> bool:
        """Runs the indexer in a child process (it holds far more memory than the bot) and reloads
        the index when it exits cleanly. False if a reindex is already running."""
        with self._reindex_lock:
            if self.reindex_in_progress:
                return False
            self.reindex_in_progress = True
        logger.info(f'[PERBot] Starting background reindex ({trigger_label})...')

        def notify(text: str) -> None:
            if not channel_id or not self.post:
                return
            try:
                self.post(channel_id, thread_ts, text)
            except Exception as post_error:
                logger.error('Failed to post reindex message.', exc_info=post_error)

        def run() -> None:
            try:
                code = subprocess.run([sys.executable, '-m', 'search.indexer'], env=os.environ.copy()).returncode
            except Exception as error:
                self.reindex_in_progress = False
                logger.error('Background reindex failed to start.', exc_info=error)
                notify(f':x: PERBot failed to start the reindex job. {LOGS_HINT}.')
                return
            self.reindex_in_progress = False
            if code == 0:
                logger.info('[PERBot] Background reindex finished successfully; reloading.')
                try:
                    with self._load_lock:
                        load_index()
                    notify(':white_check_mark: PERBot finished reindexing and is using the new index.')
                except Exception as err:
                    logger.error('Reindex finished but the new index failed to load.', exc_info=err)
                    notify(f':x: Reindex finished but the new index could not be loaded. {LOGS_HINT}.')
            else:
                logger.error(f'[PERBot] Background reindex exited with code={code}')
                notify(':x: PERBot reindexing failed. Run `/indexstatus` and check the server logs (`journalctl -u perbot`) for details.')

        threading.Thread(target=run, name='reindex', daemon=True).start()
        return True

    def start(self) -> None:
        """At bot start: load (or bootstrap) the index and start the hourly refresh."""
        loaded = self.ensure_loaded()
        if not loaded and config.app.auto_bootstrap_on_missing_index:
            status = load_status()
            if not status or status.get('state') != 'indexing':
                self.start_reindex(trigger_label='auto-bootstrap')
        if config.app.index_refresh_minutes > 0:
            self.start_refresh_loop(config.app.index_refresh_minutes * 60)


@dataclass
class Answer:
    summary: str
    results: list[SearchResult]
    meta: ResultMeta


class DocSearch:
    CHAT_REPLIES = [
        "I'm a docs bot — ask me something about the car or the team and I'll dig through Notion. Try `@PERBot how does the PCM talk to the motor controllers?`",
        "Nothing to look up there. Ask me a docs question (`@PERBot what changed in the REV11 accumulator?`) or `@PERBot summarize this thread` inside a thread.",
    ]

    def __init__(self, index: IndexManager | None = None):
        self.index = index or IndexManager()
        self._user_names: dict[str, str] = {}

    # --- answering --------------------------------------------------------------------------------

    def answer(self, query: str) -> Answer:
        loaded = self.index.ensure_loaded()
        if not loaded:
            status = load_status()
            summary = (
                f'I am still building the PER Notion index.\n{format_status(status)}'
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
        meta = ResultMeta(weak=weak, indexed_pages=len(loaded.index['pages']), generated_at=loaded.index.get('generatedAt') or '')
        return Answer(summary, results, meta)

    def _display_name(self, client: WebClient, user_id: str) -> str:
        cached = self._user_names.get(user_id)
        if cached:
            return cached
        name = user_id
        try:
            user = client.users_info(user=user_id).get('user') or {}
            name = user.get('real_name') or (user.get('profile') or {}).get('display_name') or user.get('name') or user_id
        except Exception:
            pass  # fall back to the id
        self._user_names[user_id] = name
        return name

    def _fetch_thread(self, client: WebClient, channel: str, thread_ts: str, bot_user_id: str | None) -> list[ThreadMessage]:
        res: Any = client.conversations_replies(channel=channel, ts=thread_ts, limit=200)
        messages: list[ThreadMessage] = []
        for m in res.get('messages') or []:
            if not m.get('text') or (bot_user_id and m.get('user') == bot_user_id):
                continue
            name = self._display_name(client, m['user']) if m.get('user') else m.get('username') or 'someone'
            messages.append(ThreadMessage(name=name, text=m['text']))
        return messages

    def answer_mention(self, client: WebClient, event: dict[str, Any], query: str, bot_user_id: str | None, reply: Any) -> None:
        """A docs question, a thread summary, or small talk (classified by the model)."""
        in_thread = bool(event.get('thread_ts'))
        try:
            intent = classify_mention(query, in_thread)
            logger.info(f'Mention intent={intent} inThread={in_thread} text="{query[:80]}"')
            if intent == 'chat':
                reply(random.choice(self.CHAT_REPLIES))
                return
            if intent == 'thread':
                messages = self._fetch_thread(client, event['channel'], event['thread_ts'], bot_user_id)
                if not messages:
                    reply("I couldn't read this thread (I may not have history access in this channel).")
                    return
                summary = summarize_thread(query, messages)
                reply(summary, [{'type': 'section', 'text': {'type': 'mrkdwn', 'text': summary[:2900]}}])
                return
            answer = self.answer(query)
            reply(f'PERBot results for: {query}', build_result_blocks(query, answer.summary, answer.results, answer.meta))
        except Exception as error:
            logger.error('Mention handler failed.', exc_info=error)
            reply(f'PERBot hit an error while answering. {LOGS_HINT} and try `/indexstatus`.')

    # --- commands ---------------------------------------------------------------------------------

    def dt(self, ack: Any, command: dict[str, Any], client: WebClient) -> None:
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
                blocks=[{'type': 'section', 'text': {'type': 'mrkdwn', 'text': f':mag: *PERBot search started*\n*Query:* `{query}`'}}],
            )
            answer = self.answer(query)
            client.chat_postMessage(
                channel=command['channel_id'],
                thread_ts=parent['ts'],
                text=f'PERBot results for: {query}',
                blocks=build_result_blocks(query, answer.summary, answer.results, answer.meta),
                unfurl_links=False,
                unfurl_media=False,
            )
        except Exception as error:
            logger.error('Slash command failed.', exc_info=error)
            client.chat_postMessage(channel=command['channel_id'], text=f'PERBot hit an error while searching for: {query}')

    def reindex(self, ack: Any, command: dict[str, Any], client: WebClient) -> None:
        ack(response_type='ephemeral', text='PERBot received your reindex request.')
        if not user_can_reindex(command.get('user_id')):
            client.chat_postEphemeral(channel=command['channel_id'], user=command['user_id'], text='You are not allowed to run `/reindex` for PERBot.')
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
            started = self.index.start_reindex(channel_id=command['channel_id'], thread_ts=parent['ts'], trigger_label='/reindex')
            client.chat_postMessage(
                channel=command['channel_id'],
                thread_ts=parent['ts'],
                text=':hourglass_flowing_sand: Reindex started. PERBot will post here when it finishes.'
                if started
                else ':warning: A PERBot reindex is already in progress.',
            )
        except Exception as error:
            logger.error('Reindex command failed.', exc_info=error)
            client.chat_postMessage(channel=command['channel_id'], text=':x: PERBot could not start the reindex job.')

    def index_status(self, ack: Any, command: dict[str, Any], client: WebClient) -> None:
        ack()
        client.chat_postEphemeral(channel=command['channel_id'], user=command['user_id'], text=format_status(load_status()))


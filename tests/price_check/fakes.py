"""Fakes for the price check's tests: one Notion client and one Slack WebClient (the bot's real
clients' call surface), and a PriceCheckConfig that ignores the environment."""
from __future__ import annotations

import dataclasses
from typing import Any

from core import utils
from core.config import PriceCheckConfig
from core.notion import NotionAPIError

DS = '39e560bc-c039-83db-9f16-076cb18f7d7b'  # Purchasing
JOB_LOG = 'joblog-ds'
LEDGER = 'ledger-ds'

_CFG = dict(
    enabled=False, purchasing_data_source_id=DS, season='REV12', job_log_data_source_id=JOB_LOG,
    ledger_data_source_id=LEDGER, ledger_url='', threshold_pct=10, min_delta_usd=0, channel='',
    model='gpt-5-mini', pool=15, batch=10, lookback_hours=168, poll_seconds=120, settle_seconds=60,
    max_per_hour=20,
)


def cfg(**kw: Any) -> PriceCheckConfig:
    return PriceCheckConfig(**{**_CFG, **kw})


CFG = cfg()


def page(pid='p1', part='LM7805CT/NOPB', qty=50, cost=1.00, link='https://www.digikey.com/x',
         contacts=(('u1', 'Ada Lovelace', 'ada@upenn.edu'),), notes='', season='REV12',
         exported=False, parent=DS, edited='2026-11-21T11:00:00.000Z'):
    return {'id': pid, 'url': f'https://www.notion.so/{pid}', 'last_edited_time': edited,
            'parent': {'type': 'data_source_id', 'data_source_id': parent}, 'properties': {
        'Name': {'type': 'title', 'title': [{'plain_text': '5V regulator'}]},
        'Cat. or model no.': {'type': 'rich_text', 'rich_text': [{'plain_text': part}]},
        'Quant.': {'type': 'number', 'number': qty},
        'Unit cost': {'type': 'number', 'number': cost},
        'Link to product webpage': {'type': 'url', 'url': link},
        'Notes (internal)': {'type': 'rich_text', 'rich_text': [{'plain_text': notes}]},
        'Point of contact': {'type': 'people', 'people': [
            {'id': i, 'name': n, 'person': {'email': e}} for i, n, e in contacts]},
        'Season': {'type': 'select', 'select': {'name': season} if season else None},
        'Exported?': {'type': 'checkbox', 'checkbox': exported},
    }}


class _Sub:
    def __init__(self, **fns: Any):
        self.__dict__.update(fns)


class FakeNotion:
    """Notion client over: Job Log claims (by key) and queue entries, Purchasing pages (`pages` by id,
    `rows` for queries), savings-ledger rows, and workspace users."""

    def __init__(self, claimed=(), rows=(), entries=(), pages=None, users=()):
        self.claimed, self.created = set(claimed), []  # claim keys, in order
        self.rows, self.entries, self.page_data = list(rows), list(entries), dict(pages or {})
        self.users_list, self.ledger, self.done, self.queries = list(users), [], [], []
        self.data_sources = _Sub(query=self._query)
        self.pages = _Sub(retrieve=self._retrieve, create=self._create, update=self._update)
        self.users = _Sub(list=self._users)

    def _query(self, data_source_id, filter=None, sorts=None, page_size=None, start_cursor=None):
        f = filter or {}
        if f.get('property') == 'Run key':  # claim_once
            hit = f['title']['equals'] in self.claimed
            return {'results': [{'id': 'x'}] if hit else [], 'has_more': False}
        self.queries.append((data_source_id, f, sorts, page_size))
        if f.get('property') == 'Job':  # the queue
            res = [{'id': eid, 'properties': {'Run key': {'title': [{'plain_text': key}]}}} for eid, key in self.entries]
        else:  # Purchasing rows (open / edited since)
            res = list(self.rows)
            since = next((c['last_edited_time']['on_or_after'] for c in f.get('and', [])
                          if c.get('timestamp') == 'last_edited_time'), None)
            if since:
                res = [r for r in res if utils.parse_iso(r['last_edited_time']) >= utils.parse_iso(since)]
        return {'results': res, 'has_more': False}

    def _retrieve(self, page_id):
        if page_id not in self.page_data:
            raise NotionAPIError(404, 'object_not_found', f'no page {page_id}')
        p = self.page_data[page_id]
        if isinstance(p, Exception):
            raise p
        return p

    def _create(self, parent, properties):
        if 'Run key' in properties:
            key = properties['Run key']['title'][0]['text']['content']
            self.created.append(key)
            self.claimed.add(key)
        else:
            self.ledger.append(properties)
        return {'id': f'new{len(self.created) + len(self.ledger)}'}

    def _update(self, page_id, properties):
        assert properties == {'Job': {'rich_text': [{'text': {'content': 'price-check-done'}}]}}
        self.done.append(page_id)
        self.entries = [e for e in self.entries if e[0] != page_id]

    def _users(self, start_cursor=None, page_size=None):
        return {'results': self.users_list, 'has_more': False}


class FakeSlack:
    """WebClient: a member directory, and the DMs posted."""

    def __init__(self, members=(('S1', 'Ada Lovelace', 'ada@upenn.edu'),)):
        self.members = [{'id': i, 'name': n.split()[0].lower(), 'profile': {'real_name': n, 'email': e}}
                        for i, n, e in members]
        self.posts, self.blocks = [], []

    def users_list(self, limit=200, cursor=None):
        return {'members': self.members, 'response_metadata': {}}

    def users_lookupByEmail(self, email):
        raise RuntimeError('users_not_found')

    def chat_postMessage(self, channel, text, blocks=None, unfurl_links=None):
        self.posts.append((channel, text))
        self.blocks.append(blocks)
        return {'ok': True}


def replace(c: PriceCheckConfig, **kw: Any) -> PriceCheckConfig:
    return dataclasses.replace(c, **kw)

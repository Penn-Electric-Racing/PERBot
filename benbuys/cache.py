"""The last `prep` per (Slack user, vendor), so `done` writes back to exactly the rows the operator
pasted — never a re-derived set (someone may have added rows in between). In-memory: PERBot is a
single long-running worker and the window is 24h; a restart simply means "run prep again", which
`done` tells the operator."""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Callable

from benbuys.models import PrepResult

PREP_TTL_MS = 24 * 60 * 60 * 1000


@dataclass
class CachedPrep:
    prep: PrepResult
    created_at: float  # epoch ms


class PrepCache:
    def __init__(self, ttl_ms: float = PREP_TTL_MS, now: Callable[[], float] = lambda: time.time() * 1000):
        self._store: dict[str, CachedPrep] = {}
        self._ttl_ms = ttl_ms
        self._now = now
        self._lock = threading.Lock()

    @staticmethod
    def _key(slack_user_id: str, vendor_key: str) -> str:
        return f'{slack_user_id}:{vendor_key}'

    def set(self, slack_user_id: str, vendor_key: str, prep: PrepResult) -> None:
        with self._lock:
            self._store[self._key(slack_user_id, vendor_key)] = CachedPrep(prep, self._now())

    def get(self, slack_user_id: str, vendor_key: str) -> CachedPrep | None:
        """None when missing or older than the TTL (expired entries are dropped)."""
        k = self._key(slack_user_id, vendor_key)
        with self._lock:
            hit = self._store.get(k)
            if not hit:
                return None
            if self._now() - hit.created_at > self._ttl_ms:
                del self._store[k]
                return None
            return hit

    def clear(self, slack_user_id: str, vendor_key: str) -> None:
        with self._lock:
            self._store.pop(self._key(slack_user_id, vendor_key), None)

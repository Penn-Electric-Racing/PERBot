from __future__ import annotations

import sys
import traceback
from datetime import datetime, timezone
from typing import Any


def _stamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _meta(meta: Any) -> str:
    if meta is None:
        return ''
    if isinstance(meta, BaseException):
        return ' ' + ''.join(traceback.format_exception(type(meta), meta, meta.__traceback__)).rstrip()
    return f' {meta}'


class _Logger:
    def info(self, message: str, meta: Any = None) -> None:
        print(f'[{_stamp()}] INFO  {message}{_meta(meta)}', flush=True)

    def warn(self, message: str, meta: Any = None) -> None:
        print(f'[{_stamp()}] WARN  {message}{_meta(meta)}', file=sys.stderr, flush=True)

    def error(self, message: str, meta: Any = None) -> None:
        print(f'[{_stamp()}] ERROR {message}{_meta(meta)}', file=sys.stderr, flush=True)


logger = _Logger()

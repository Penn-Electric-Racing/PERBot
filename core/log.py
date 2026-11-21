"""Logging setup. Modules log through the standard library:

    import logging
    logger = logging.getLogger(__name__)
    logger.error('Notion write failed', exc_info=err)

and each entrypoint (`app.py`, every `python -m ...` job and CLI) calls `setup_logging()` once.
"""
from __future__ import annotations

import logging
import sys
import time

__all__ = ['setup_logging']

FORMAT = '[%(asctime)s.%(msecs)03dZ] %(levelname)-7s %(name)s: %(message)s'
DATEFMT = '%Y-%m-%dT%H:%M:%S'

# Libraries that log every request at INFO.
QUIET = ('httpx', 'httpcore', 'urllib3', 'openai')


def setup_logging(level: int | str = logging.INFO) -> None:
    """Timestamped (UTC) lines on stderr, which systemd's journal and GitHub Actions both keep."""
    handler = logging.StreamHandler(sys.stderr)
    formatter = logging.Formatter(FORMAT, DATEFMT)
    formatter.converter = time.gmtime
    handler.setFormatter(formatter)
    logging.basicConfig(level=level, handlers=[handler], force=True)
    for name in QUIET:
        logging.getLogger(name).setLevel(logging.WARNING)

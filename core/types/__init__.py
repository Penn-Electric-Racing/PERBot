"""TypedDicts for the raw payloads PERBot reads and writes: Notion pages and Slack blocks. Models
(`core.abc`, each feature's `models.py`) are built from these; nothing else should poke at raw
payloads.

  notion.py   raw Notion API payloads
  slack.py    Block Kit dicts and interaction bodies
"""

from .notion import *
from .slack import *

__all__ = (
    'PropertyValue', 'Parent', 'Page', 'QueryResponse', 'Block', 'ActionPayload',
    'InteractionUser', 'InteractionMessage', 'InteractionBody',
)

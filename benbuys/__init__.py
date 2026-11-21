"""BenBuys: `/benbuys prep` builds a BEN purchase from the ready Purchasing rows, `/benbuys done`
records the requisition and emails it.

  feature.py     BenBuys: the `/benbuys` command
  slack.py       the prep / done handlers and their parser
  prep.py        turns the selected rows into the prep message (pure)
  email.py       the requisition email
  mailer.py      email transport (pluggable)
  cache.py       PrepCache: the last prep per (user, vendor)
  reference.py   cleaning and truncating the reference text
  notion.py      PurchasingNotion: the rows BenBuys reads and writes
  models.py      shared types (VendorAdapter, ...)

Run with `python -m`:

  cli.py         `python -m benbuys.cli`: local checks without Slack

adapters/ holds one module per vendor and the registry (resolve_adapter).
"""

from .cache import *
from .email import *
from .feature import *
from .mailer import *
from .models import *
from .notion import *
from .prep import *
from .reference import *
from .slack import *

__all__ = (
    'PREP_TTL_MS', 'CachedPrep', 'PrepCache', 'RequisitionEmail', 'build_requisition_email',
    'render_email', 'BenBuys', 'Mailer', 'to_rfc822', 'GmailApiMailer', 'WebhookMailer',
    'create_mailer', 'CartLine', 'PrepWarning', 'PrepResult', 'VendorAdapter', 'READY_VALUE',
    'RowSelection', 'WriteBackResult', 'PurchasingNotion', 'normalize_part_number',
    'aggregate_rows', 'HIGH_VALUE_LINE_USD', 'warnings_for', 'build_prep', 'money',
    'PrepBlocks', 'format_prep', 'MIN_REFERENCE_SIGNAL', 'clean_reference_text',
    'truncate_at_word', 'truncate_reference', 'ParsedBenbuys', 'REQUISITION_RE', 'parse_money',
    'parse_benbuys', 'USAGE', 'MAX_MESSAGE_CHARS', 'chunk_fenced', 'BenbuysDeps', 'handle_prep',
    'handle_done',
)

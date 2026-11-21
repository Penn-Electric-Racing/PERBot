"""The price check: re-price open Purchasing rows, DM the orderer when a price moved, and track
what the alert buttons saved.

  feature.py    PriceCheck: /pricecheck, the buttons and the background tasks
  checker.py    PriceFinder (the search) and Checker (check a row, drain the queue)
  worker.py     the bot's polling worker
  views.py      PriceAlert (the DM), SwapHandler (a click), PriceAlertView (the Slack callbacks)
  database.py   PurchasingPrices, CheckQueue, SavingsLedger (the Notion side)
  models.py     Finding, PriceRow, Notes, LedgerEvent, LedgerRow, Summary, ...
  types.py      raw payloads: the alert buttons' JSON value, scraper listings
  enums.py      the fixed value sets (CheckStatus, ClickKind, Outcome, ...)

Run with `python -m`:

  check.py      `python -m price_check.check`: run the check (its docstring describes it)
  cli.py        `python -m price_check.cli`: DM yourself a test alert

scrapers/ holds the web search, the distributor APIs and the page readers.
"""

from .checker import *
from .database import *
from .enums import *
from .feature import *
from .models import *
from .types import *
from .views import *
from .worker import *

__all__ = (
    'make_llm', 'row_label', 'is_outage', 'PriceFinder', 'Checker', 'PurchasingPrices',
    'CheckQueue', 'SavingsLedger', 'alert_row_props', 'click_row_props', 'CheckStatus',
    'ClickKind', 'ClickOutcome', 'SwapPlanKind', 'Outcome', 'Direction', 'Period', 'PriceCheck',
    'UNSET', 'Listing', 'SwapValue', 'Finding', 'TextRun', 'Notes', 'PriceRow', 'RowPatch',
    'SwapPlan', 'LedgerEvent', 'LedgerRow', 'Summary', 'StatsQuery', 'PriceSwapValue',
    'PriceBreak', 'ListingPayload', 'PriceAlert', 'SwapDeps', 'ClickInput', 'ClickResult',
    'SwapHandler', 'PriceAlertView', 'result_blocks', 'replace_actions', 'HourlyLimit',
    'Poller', 'Worker',
)

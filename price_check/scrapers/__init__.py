"""Part search: find where to buy a part and what an order would cost.

  websearch.py       web search backends (Brave, Serper, Google CSE, DuckDuckGo) and page fetching
  distributors.py    Mouser and DigiKey APIs (exact prices, stock, minimum order)
  regex_reader.py    reads a page with JSON-LD / meta tags / regex
  llm_reader.py      reads pages with an LLM; find() is the price check's search
  ranking.py         scores the options (Weights, Scorer) and picks the best (pick_top)

Run with `python -m`:

  regex_scraper.py   `python -m price_check.scrapers.regex_scraper "LM7805" -q 50`
  llm_scraper.py     `python -m price_check.scrapers.llm_scraper "LM7805" -q 50`

Both readers have their own part_info() and apply_qty(); import those from the module.
"""

from .distributors import *
from .llm_reader import *
from .ranking import *
from .regex_reader import *
from .websearch import *

__all__ = (
    'MAX_RECORDS', 'MOUSER_URL', 'DIGIKEY_TOKEN_URL', 'DIGIKEY_SEARCH_URL', 'SITE_RES',
    'APIError', 'order_units', 'mouser', 'digikey', 'APIS', 'lookup', 'drop_api_sites',
    'PROVIDERS', 'BATCH_DEFAULT', 'PAGE_CHARS', 'LD_CHARS', 'SYSTEM', 'LLMError', 'LLM',
    'page_text', 'to_info', 'search_term', 'drop_unseen_prices', 'BATCH_SYSTEM', 'pages_info',
    'snippets_info', 'find', 'Weights', 'relevance', 'ship_days', 'ship_value', 'pick_top',
    'Scorer', 'CURRENCY_SYMBOLS', 'MONEY', 'MONEY_RE', 'NOISE_BEFORE_RE', 'NOISE_AFTER_RE',
    'LISTING_URL_RE', 'FREE_SHIP_RE', 'FREE_SHIP_MIN_RES', 'FREE_SHIP_COND_BEFORE_RE',
    'FREE_SHIP_COND_AFTER_RE', 'SHIP_COST_RE', 'SPAN', 'SHIP_TIME_RES', 'PACK_RES', 'STOCK_RES',
    'OUT_OF_STOCK_RE', 'RELATED_LD_KEYS', 'same_url', 'enrich', 'SCORER', 'score_all', 'UA',
    'BackendError', 'brave', 'serper', 'google_cse', 'duckduckgo', 'BACKENDS', 'MAX_PAGE_BYTES',
    'search',
)

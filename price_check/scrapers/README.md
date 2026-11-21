# Part search (`price_check/scrapers/`)

The price check is built on these. They also work on their own as a
command-line part finder.

Find the best places to buy an electronic part (or anything else sold online).
Give it a part number and a quantity. It searches the web, reads about 30
listings, works out what your order would cost from each one, including pack
sizes, bulk pricing and shipping, and ranks the best 5.

```
$ python -m price_check.scrapers.regex_scraper "LM7805" -q 50
Best 5 of 30 results for "LM7805"  x50  (via serper; 27 pages read, 22 with prices; ranked by best)

1. LM7805CT/NOPB Texas Instruments | Mouser
   https://www.mouser.com/ProductDetail/...
   Score:         1.00  (1.00 = cheapest, no drawbacks; search rank #4)
   Supplier:      Mouser Electronics
   Cost:          0.89 USD  (json-ld)
   Price breaks:  10+ @ 0.62, 100+ @ 0.48
   Unit cost:     0.62 USD
   Buy:           50 unit(s) = 31.00 USD
   Stock:         12,400
   Shipping time: 1-2 days
   Shipping cost: Free
   Total:         31.00 USD
...
```
*(Illustrative output: real prices and results vary.)*

There are two scrapers. They share the same search and ranking code:

| | How it reads each page | Needs |
|---|---|---|
| **`regex_scraper`** | Structured product data (schema.org JSON-LD), then `<meta>` tags, then regex over the text | Nothing extra |
| **`llm_scraper`** | Sends the cleaned-up page text to a free or cheap LLM, which returns the fields as JSON | A free LLM API key, or Ollama |

`regex_scraper` is fast, free and predictable. `llm_scraper` copes better with
unusual page layouts and wording, such as conditional shipping offers, pack
sizes and price tables. It is slower, because free LLM tiers limit requests
per minute.

## Setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

### API keys in `.env`

Put your keys in a `.env` file in the project folder and both scrapers load it
automatically:

```bash
cp .env.example .env    # then fill in the keys you have
```

`.env` is git-ignored. Variables already set in your shell take priority, and
blank lines in the file are ignored. You can also `export` any of the
variables below instead.

### Search API key (recommended)

Both scrapers use the first search source that works:

| Source | Free tier | Environment variable |
|---|---|---|
| [Brave Search API](https://api.search.brave.com) | about 2,000 queries/month | `BRAVE_API_KEY` |
| [Serper.dev](https://serper.dev) (Google results) | 2,500 queries, no card | `SERPER_API_KEY` |
| Google Programmable Search | 100/day | `GOOGLE_API_KEY` + `GOOGLE_CSE_ID` |
| DuckDuckGo HTML | no key needed | none |

DuckDuckGo works without a key but rate-limits quickly (usually for 15-60
minutes), so set one of the keys if you search often.

### Mouser and DigiKey API keys (recommended for electronic parts)

Mouser and DigiKey pages are hard to scrape, but both have free APIs that give
exact price breaks, stock, minimum order and lead time. When keys are set,
both scrapers add up to `--api` parts (default 10) from each API to the pool,
and skip scraped pages from that distributor's site.

| API | How to get a key | Environment variables |
|---|---|---|
| [Mouser Search API](https://www.mouser.com/api-hub/) | free, ~1,000 calls/day | `MOUSER_API_KEY` |
| [DigiKey Product Information v4](https://developer.digikey.com) | create an app (Production, Product Information V4), free tier | `DIGIKEY_CLIENT_ID` + `DIGIKEY_CLIENT_SECRET` |

DigiKey uses `DIGIKEY_SITE` (default `US`) and `DIGIKEY_CURRENCY` (default
`USD`). Neither API reports shipping costs, so shipping is treated as
unknown unless you set the free-shipping minimum for your country, for
example `MOUSER_FREE_SHIP_MIN=50` and `DIGIKEY_FREE_SHIP_MIN=100`. Check the
distributor's site for the current amount.

### LLM key (only for `llm_scraper`)

| Provider | Free tier | Environment variable | Default model |
|---|---|---|---|
| [OpenAI](https://platform.openai.com/api-keys) | no (paid) | `OPENAI_API_KEY` | `gpt-5-mini` |
| [Google Gemini](https://aistudio.google.com/apikey) | yes, no card | `GEMINI_API_KEY` | `gemini-3.1-flash-lite` |
| [Groq](https://console.groq.com/keys) | yes, no card | `GROQ_API_KEY` | `qwen/qwen3.8-27b` |
| [OpenRouter](https://openrouter.ai) | `:free` models | `OPENROUTER_API_KEY` | `meta-llama/llama-3.3-70b-instruct:free` |
| [Ollama](https://ollama.com) (local) | free | none (must be running on `localhost:11434`) | `llama3.2` |

`llm_scraper` uses the first provider in this list that has a key set. You can
choose a different provider with `--provider`, and a different model with
`--model` or `LLM_MODEL=...`. If a provider says the default model doesn't
exist (free model names change often), pass a current one with `--model`.

## Usage

```bash
python -m price_check.scrapers.regex_scraper "LM7805 voltage regulator"  # best 5 for 1 unit
python -m price_check.scrapers.regex_scraper "LM7805" -q 50              # you need 50 units
python -m price_check.scrapers.regex_scraper "LM7805" --rank cheapest    # lowest order total only
python -m price_check.scrapers.regex_scraper "LM7805" --pool 50 -n 10    # compare 50 results, show 10
python -m price_check.scrapers.regex_scraper "LM7805" --json             # machine-readable output
python -m price_check.scrapers.regex_scraper "LM7805" --no-fetch         # search snippets only (fast)
python -m price_check.scrapers.regex_scraper "LM7805" --weights w.json   # custom ranking weights

export OPENAI_API_KEY=...
python -m price_check.scrapers.llm_scraper "LM7805" -q 50 -v             # same, with LLM extraction
python -m price_check.scrapers.llm_scraper "LM7805" --provider groq --rpm 30
python -m price_check.scrapers.llm_scraper "LM7805" --no-fetch           # one LLM call over all snippets
```

### Options (both scrapers)

| Option | Default | Meaning |
|---|---|---|
| `-q, --qty N` | 1 | Units you need. Used for pack maths, bulk price tiers, stock checks and free-shipping minimums. |
| `-n, --top N` | 5 | How many options to show. |
| `--pool N` | 30 | How many search results to read and compare. |
| `--rank best\|cheapest` | `best` | `best` uses the weighted score (below); `cheapest` uses the lowest order total. |
| `--per-supplier N` | 2 | Maximum options shown from one supplier, unless that would leave fewer than `--top`. |
| `--exact` | off | Search the query exactly. By default "price" is added, and "buy …" / "… in stock" searches top up the pool. |
| `--no-fetch` | off | Don't open the result pages; use only the search titles and snippets. |
| `--weights FILE` | none | JSON file that overrides ranking weights (see below). |
| `--api N` | 10 | Parts to take from each distributor API that has keys set. `0` turns the APIs off. |
| `--json` | off | Print the full results as JSON. |
| `-v, --verbose` | off | Log skipped search sources, LLM retries and fetch errors to stderr. |

`llm_scraper` only:

| Option | Default | Meaning |
|---|---|---|
| `--provider` | first with a key | `openai`, `gemini`, `groq`, `openrouter` or `ollama`. |
| `--model` | provider default | LLM model ID (or set `LLM_MODEL`). |
| `--rpm N` | 15 | Maximum LLM requests per minute, to stay inside free-tier limits. 30 pages at 15 rpm takes about 2 minutes. |

## How it works

```
search ──► fetch each page ──► extract fields ──► apply quantity ──► score ──► pick top N
(websearch)  (websearch)        regex_scraper       apply_qty          ranking
                               or llm_scraper
```

1. **Search** (`websearch.search`): gets `--pool` unique URLs from the first
   search source that works. The Mouser and DigiKey APIs (`distributors`)
   are queried too. Their results arrive with all fields filled in, so they
   skip steps 2 and 3. If web search fails, the API results are still ranked.
2. **Fetch** (`websearch._fetch_html`): downloads each page (up to 5 MB). PDFs
   and other non-HTML files are skipped. If a site blocks the request, the
   search snippet is used instead.
3. **Extract**. Each listing gets these fields: `cost`, `currency`,
   `supplier`, `stock` / `in_stock`, `shipping_cost`, `free_ship_min`,
   `shipping_time`, `price_breaks`, `price_range`, `listing_page` (a search or
   category page rather than one product), and, in `llm_scraper`,
   `pack_size`.
   - `regex_scraper`: JSON-LD → `<meta>`/microdata → regex over the text after
     the product's `<h1>` → regex over the search snippet. Each step only
     fills fields that are still empty.
   - `llm_scraper`: the page is cut down to about 8,000 characters of visible
     text around the `<h1>`. Crossed-out prices are labelled
     `[struck-out: …]`, and any JSON-LD and the search snippet are added. The
     LLM is asked for the same fields as a JSON object, and every value is
     type-checked before it is used.
4. **Quantity** (`apply_qty`): rounds `--qty` up to the distributor's minimum
   order and order multiple (API results only), then picks the bulk price tier
   that quantity reaches.
   Otherwise it divides by the pack size ("Pack of 10", "30pcs") to get packs
   needed. It then checks stock and applies the free-shipping minimum.
5. **Score and pick** (`ranking.Scorer`): see below.

## Ranking

Lower is better. **1.00** means the cheapest valid option with no drawbacks.

```
score = (effective_cost / best) × multiplier
```

- **`effective_cost`** = subtotal for your quantity + shipping. When shipping
  is unknown, the median shipping cost of the other listings is used.
- **`best`** = the lowest `effective_cost` among listings with no warning
  notes (wrong part number, variant suffix, other currency), so a wrong-part
  bargain can't set the baseline.
- **`multiplier`** = all of the factors below multiplied together:

| Condition | Factor | `Weights` field |
|---|---|---|
| Out of stock | × 1.6 | `out_of_stock` |
| Stock below `--qty` | × 1.4 | `short_stock` |
| Stock unknown | × 1.03 | `stock_unknown` |
| Ships in more than 2 days | × (1 + 0.02 × (days − 2)), at most × 1.40 | `per_ship_day`, `fast_days`, `ship_day_cap` |
| Shipping time unknown | × 1.06 | `ship_time_unknown` |
| Shipping cost unknown | × 1.04 | `ship_cost_unknown` |
| Where the price came from | api / json-ld / meta × 1.0, llm × 1.02, page text × 1.05, snippet / llm snippet × 1.15, other × 1.1 | `source`, `unknown_source` |
| Search or category page | × 1.12 | `listing_page` |
| Query words missing | × (1 + 0.6 × fraction missing) | `relevance` |
| Only a longer part number found (LM317L for LM317) | × 1.08 | `mpn_variant` |
| Unit cost below 25% of the median (once 4+ prices are known) | × 1.35 | `outlier`, `outlier_ratio`, `outlier_min_count` |
| Search position (tiebreak) | × (1 + 0.005 × rank) | `per_search_rank` |

Example: if the best option is $10 delivered, a $11 listing that ships in 5
days, with unknown stock, a price read by the LLM, at search position #3,
scores `1.1 × 1.06 × 1.03 × 1.02 × 1.015 ≈ 1.24`.

**Picking the top N** (`Scorer.pick_top`): listings are first sorted into
groups, and each group comes ahead of the next regardless of score:

1. everything not in a group below,
2. not enough stock,
3. part number not found, or priced in a different currency,
4. no price.

Within a group they are sorted by score (or by `effective_cost` with
`--rank cheapest`), with at most `--per-supplier` options from one supplier.

### Changing the weights

Every number above is a field of the `Weights` dataclass in `price_check/scrapers/ranking.py`.
There are three ways to change them:

```python
# 1. Edit the defaults in price_check/scrapers/ranking.py

# 2. From code
from price_check.scrapers import Scorer, Weights
scorer = Scorer(Weights(out_of_stock=2.0, per_ship_day=0.05))
scorer.score_all(results, "LM7805", qty=50)
top = scorer.pick_top(results, 5)
```

```bash
# 3. Per run, with a JSON file containing only the values you want to change
cat > w.json <<'EOF'
{"out_of_stock": 2.0, "per_ship_day": 0.05, "source": {"snippet": 1.3}}
EOF
python -m price_check.scrapers.regex_scraper "LM7805" --weights w.json
```

`source` entries are merged with the defaults. Any name the file doesn't
recognise, such as a typo, stops the run with an error.

## JSON output

`--json` prints:

```json
{
  "query": "LM7805 price", "qty": 50, "source": "serper", "rank": "best",
  "candidates": 30, "fetched": 27, "priced": 22,
  "results": [ { "title": "...", "url": "...", "score": 1.0, "notes": [], ... } ]
}
```

`llm_scraper` also adds `"llm": "<provider>/<model>"`. Each result includes
every extracted field, plus `unit_cost`, `pack_size`, `packs_needed`,
`subtotal`, `total`, `effective_cost`, `enough_stock`, `ship_days`,
`relevance`, `mpn_variants`, `notes` and `fetch_error`.

## Limitations

- Sites that block scripts (eBay, and DigiKey without an API key) fall back to
  the search snippet, which is less reliable and is ranked lower because of that.
- Prices are compared in whatever currency each site shows. Listings in a
  different currency from most others are flagged, not converted.
- LLM extraction can still get things wrong. Check the listing before buying,
  especially when a result has notes.
- Free LLM tiers have daily request limits (for example, about 1,000 requests
  a day on Gemini Flash-Lite), so a 30-result search uses about 30 of them.

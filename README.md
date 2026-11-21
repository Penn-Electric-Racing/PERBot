# PERBot

PERBot is a Slack + Notion documentation bot for Penn Electric Racing.

It does three things:
1. listens for `/dt ...` slash commands in Slack,
2. listens for `@PERBot ...` mentions in Slack,
3. searches a local index of your shared Notion pages and returns the top 3 matches, plus a short synthesized answer.

## What this MVP does well
- searches across the Notion pages shared with your internal integration,
- returns the top 3 results,
- labels likely historical results,
- supports lightweight filters like `season:REV11` and `subsystem:chassis`,
- works in Slack Socket Mode,
- optionally uses OpenAI for embeddings + answer synthesis.

## Project structure

PERBot is pure Python (3.11+). Dependencies live in `pyproject.toml`.

```text
PERBot/
  .env                        # your tokens (copy .env.example)
  requirements.txt            # dependencies: pip install -r requirements.txt
  pyproject.toml              # project metadata + pytest config
  deploy/                     # Lightsail setup, systemd unit, SSH deploy script
  app.py                      # Slack bot entrypoint (Socket Mode): PERBot adds each Feature, routes @mentions
  core/                       # what every feature shares; features import from here, never from each other
    config.py                 # config: every setting, from the environment / .env
    feature.py ui.py bolt.py  # Feature (@command/@event/@shortcut/@modal/@task), View (@button), Bolt adapter
    blocks.py database.py abc.py  # Block Kit builders, Database[Model] + Properties, NotionModel
    notion.py                 # Notion: the API client (Notion.shared()); collect, plain_text, dashed_id, ...
    slack.py                  # Slack: the client (Slack.shared()), directory; match_by_name, unwrap_links, ...
    llm.py                    # LLM: OpenAI + Groq clients (LLM.shared())
    job_log.py                # JobLog: once-only records in the ⚙️ Job Log (cron dedup, alerts, queue)
    purchasing.py             # Purchasing (PEFS) database: PurchasingRow, Purchasing.rows / row
    utils.py log.py           # helper functions (text, timestamps, Eastern time); setup_logging()
  search/                     # doc search: /dt, /reindex, /indexstatus, @PERBot docs answers
    feature.py                # Search: the commands + the index load/refresh task
    bot.py                    # IndexManager (load / hot-swap / reindex) + DocSearch (the answers)
    indexer.py                # Notion/Drive crawler + index builder: python -m search.indexer
    engine.py                 # hybrid BM25 + vector ranking and filters
    index_store.py            # reads/writes the index + int8 embeddings
    index_downloader.py       # pulls the nightly index from the GitHub release
    llm.py                    # embeddings, answers, classify/rerank
    notion.py drive.py        # Notion / Google Drive crawlers
    slack_format.py           # Slack block formatting
  sponsorship/                # /sponsor (feature.py), deal buttons + modals (views.py), jobs + CLIs
  price_check/                # price-check worker, alert buttons, /pricecheck
    scrapers/                 # part search: web search, Mouser/DigiKey, LLM page reading
  ops_tasks/                  # /assign, its modal + message shortcut, the digest buttons (views.py)
  arrivals/                   # delivery photos → package cards (views.py), the nudge sweep task
  benbuys/ race/ anon/        # /benbuys, /race, /anon (each a feature.py)
  meeting_notes/              # GitHub Actions jobs only
  tests/                      # pytest suite
```

Code layout: each feature is a folder that imports only from `core/` (and itself). Its
`feature.py` is a `Feature` holding the Slack listeners, its `views.py` holds the `View`s for its
buttons, and `app.py` only does `PERBot.add_feature(...)` for each.

| Piece | Where |
|---|---|
| `Feature` with `@command` / `@event` / `@shortcut` / `@modal` / `@task` methods; `PERBot.add_feature(...)` | `core/feature.py` |
| `View` with `@button(action_id or regex)` callbacks that receive an `Interaction`, plus `@modal` | `core/ui.py` |
| Block Kit builders (`Section`, `Actions`, `Button`, `Confirm`, ...) | `core/blocks.py` |
| `NotionModel.from_page(page, db)`: models built from payloads that keep their database | `core/abc.py` |
| `Database[Model]` (`query`, `get`, `create`, `update`), `Properties(page)` readers, `*_value()` writers | `core/database.py` |
| Plain helper functions: `utils.price`, `utils.escape`, `utils.to_iso`, `utils.is_slot_open`, ... | `core/utils.py` |
| `Choice` / `SelectOption` enums (they compare equal to plain strings) | `core/enums.py` |
| `PERBotError` → `ConfigError`, `NotionError`, `SlackError`, `ScraperError` | `core/errors.py` |
| TypedDicts for raw payloads | `core/types/` |

A feature has `feature.py` and, as it needs them, `views.py`, `models.py`, `types.py`, `enums.py`,
`database.py` and its own CLIs (`price_check/` has the full set).

Imports are direct: a name is imported from the module that defines it
(`from core.notion import Notion`, `from price_check.feature import PriceCheck`), never through a
package. Each package's `__init__.py` is its map: a docstring listing its modules, `from .module
import *` for each library module, and an `__all__`. A module run with `python -m` holds only its
CLI (`main()`); its shared code lives in a library module next to it (`check.py` → `checker.py`,
`jobs/quota_audit.py` → `quota.py`, `llm_scraper.py` → `llm_reader.py`), so the package never
imports the module it's about to run.

Where code goes:

| What it is | Where it goes |
|---|---|
| a stateless helper | a module function (`core/utils.py`, or the feature module it serves) |
| something about one kind of data | a method or property on that data's class (`listing.flags`, `value.saved`) |
| a way to build an object | a classmethod (`from_page`, `from_json`, `ClickKind.from_action_id`) |
| state (a client, a database, a lock, config) | a class with `__init__` |
| a CLI | a `main()` function in the module |

So no classes of only `@staticmethod`s: a raw payload is a TypedDict in `types.py`, and the model
that wraps it (`SwapValue`, `Listing`, `LedgerRow`) lives in `models.py`. Bolt injects listener arguments by parameter name, so bound methods
are registered through `core.bolt.listener(...)`; `Feature` and `View` do this for you.

## Exactly where to paste your tokens

Create a file called `.env` in the project root by copying `.env.example`.

```bash
cp .env.example .env
```

Then open `.env` and paste the real secrets here:

```env
SLACK_BOT_TOKEN=xoxb-your-real-bot-token
SLACK_APP_TOKEN=xapp-your-real-app-token
NOTION_TOKEN=secret_your_real_notion_token
OPENAI_API_KEY=sk-your-real-openai-api-key
```

### Which token goes where?
- `SLACK_BOT_TOKEN` = your Slack bot token from the Slack app OAuth page
- `SLACK_APP_TOKEN` = your Slack app-level token for Socket Mode
- `NOTION_TOKEN` = your Notion internal integration secret
- `OPENAI_API_KEY` = your OpenAI API key

### Optional values in `.env`
- `CURRENT_REV=REV11` controls the historical-doc heuristic
- `TOP_K_RESULTS=3` keeps output to 3 results
- `NOTION_ALLOWED_PAGE_IDS=` lets you restrict indexing if you ever want to

## OpenAI setup (for best-answer summaries and semantic search)

OpenAI is **separate from your ChatGPT subscription/billing**. To use PERBot's LLM summary and embeddings features, create an API key in the OpenAI developer platform, then paste it into `.env` as `OPENAI_API_KEY`. If you skip this, PERBot still works, but it falls back to keyword-only search plus raw result snippets.

### Exact steps
1. Go to the OpenAI developer platform and create an API key.
2. If prompted, add API billing there; ChatGPT billing does not automatically carry over.
3. Open your local `.env` file.
4. Paste the key on this line:

```env
OPENAI_API_KEY=sk-your-real-openai-api-key
```

### OpenAI-related `.env` values
```env
OPENAI_API_KEY=sk-your-real-openai-api-key
OPENAI_RESPONSE_MODEL=gpt-5
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

### What each one does
- `OPENAI_API_KEY` = lets PERBot call OpenAI
- `OPENAI_RESPONSE_MODEL` = model used to write the short best-answer summary
- `OPENAI_EMBEDDING_MODEL` = model used for semantic search embeddings


## Deployment (AWS Lightsail over SSH)

PERBot uses Slack **Socket Mode**: it holds an outbound WebSocket to Slack, so the server needs no
public URL, open ports or load balancer. It runs as a `systemd` service on a Lightsail Ubuntu instance.
The scheduled jobs (nightly index, sponsorship DMs, digests) keep running in GitHub Actions.

### Files
- `deploy/setup.sh` — one-time setup on the instance: Python venv, dependencies, swap, systemd service
- `deploy/perbot.service` — the systemd unit (runs `.venv/bin/python app.py`, restarts on crash and at boot)
- `deploy/deploy.sh` — run from your laptop: pulls the pushed branch on the server, installs, restarts

### Instance
Ubuntu 24.04, **2 GB RAM or more**: the bot keeps the search index and embeddings in memory, and
`/reindex` runs the indexer alongside it. `setup.sh` also adds a 2 GB swap file. No inbound firewall
rules are needed beyond SSH (22).

### First-time setup
```bash
ssh -i ~/.ssh/LightsailDefaultKey.pem ubuntu@<instance-ip>
git clone https://github.com/Penn-Electric-Racing/PERBot.git ~/PERBot
cd ~/PERBot && git checkout python
bash deploy/setup.sh
nano .env                      # fill in the tokens (see .env.example)
sudo systemctl restart perbot
journalctl -u perbot -f        # watch it connect
```
If the repo is private, clone with a GitHub deploy key or a token.

### Deploying updates
Push your commits, then from your laptop:
```bash
PERBOT_HOST=ubuntu@<instance-ip> PERBOT_KEY=~/.ssh/LightsailDefaultKey.pem bash deploy/deploy.sh
```
It resets the server's checkout to `origin/python`, installs dependencies, restarts the service and
prints the last log lines if it fails to start. Only pushed commits are deployed.

### On the server
| Task | Command |
| --- | --- |
| Status | `sudo systemctl status perbot` |
| Live logs | `journalctl -u perbot -f` |
| Restart / stop | `sudo systemctl restart perbot` / `sudo systemctl stop perbot` |
| Change a token | edit `~/PERBot/.env`, then restart |

Run only **one** copy of the bot per Slack app: a second Socket Mode connection (for example your
laptop) splits events with the server.

### Index behavior
- The nightly GitHub Action (`build-index.yml`) builds the index and uploads it to the `notion-index-latest` release; the bot downloads it at startup and hot-swaps a newer one every `INDEX_REFRESH_MINUTES`.
- If no index can be downloaded and `AUTO_BOOTSTRAP_ON_MISSING_INDEX=true`, the bot runs the indexer itself in a child process.
- Index files live in `~/PERBot/data/` on the server.

### Notion webhooks
Socket Mode removes the need for a public Slack endpoint, but **Notion webhooks require a public HTTPS endpoint**, so PERBot doesn't use them: the index refreshes nightly and on `/reindex`, and the [price check](#price-check) polls Notion.

## Price check

Watches the Purchasing (PEFS) Notion database and, when a new row's price has moved, DMs the row's
Point of contact on Slack. Rows can come from anywhere: typed into Notion, imported, or another app.
Each new row is re-priced at its quantity (web search, Mouser/DigiKey APIs and an LLM reading the
product pages) and compared with the `Unit cost` in Notion. This used to be the separate
`PER-Purchasing` repo. It now runs **inside the bot** on a background thread when
`PRICE_CHECK_ENABLED=true`. It's all in `price_check/` and uses the shared clients in `core/` (`Notion`, `Slack`, `JobLog`,
`PurchasingRow`, `config.price_check`):

| File | What it does |
|---|---|
| `feature.py` | `PriceCheck`: `/pricecheck`, the alert buttons, and the worker / Realized-sweep tasks |
| `worker.py` | the background loop: poll Notion, rate-limit, back off (`Worker`) |
| `checker.py` | `PriceFinder` (search a row), `Checker` (re-price a row, DM the alert) |
| `check.py` | the manual CLI: `python -m price_check.check` |
| `database.py` | `PurchasingPrices`, `CheckQueue` (⚙️ Job Log), `SavingsLedger` (💸 Price Check Savings) |
| `models.py` | `Finding`, `PriceRow`, `Notes`, `LedgerEvent`, `LedgerRow`, `Summary`, `StatsQuery` |
| `views.py` | `PriceAlert` (the DM), `SwapHandler` (what a click does), `PriceAlertView` (the buttons) |
| `enums.py`, `types.py` | `CheckStatus`, `Outcome`, ...; the button value and listing payloads |
| `cli.py` | DM yourself a test alert |
| `scrapers/` | the part search ([`price_check/scrapers/README.md`](price_check/scrapers/README.md)) |

```
every 2 min: Purchasing rows edited since the last look (open, complete, settled)
  → queue in the ⚙️ Job Log (once per row, ever)
  → worker: search + Mouser/DigiKey + LLM → price at Quant.
  → price moved past the threshold → Slack DM to the Point of contact (with Use / Keep buttons)
  → button click → PriceAlertView (price_check/views.py) updates Unit cost, logs 💸 Price Check Savings
```

### How it works
1. **Poll:** every `PRICE_CHECK_POLL_SECONDS` (120) the bot asks Notion for this season's open,
   complete rows edited since the last poll. A row edited within the last
   `PRICE_CHECK_SETTLE_SECONDS` (60), plus a minute because Notion rounds edit times, is left for
   the next poll, so a row typed in field by field is checked once it's done.
2. **Queue:** new rows are queued in the ⚙️ Job Log as `price-check-queue <page id>`. That entry stays
   forever (as `price-check-done` once checked), so a row is queued once, however often it's edited.
3. **Check:** one worker checks the queue one row at a time, at most 20 an hour
   (`PRICE_CHECK_MAX_PER_HOUR`). If search or the LLM is failing (quota, outage), the row stays
   queued and the worker backs off 10 min, 20 min, … up to 6 h.

The queue lives in Notion, so a restart loses nothing. The first poll after startup looks back
`PRICE_CHECK_LOOKBACK_HOURS` (default a week), which covers rows added while the bot was down.

**Which rows:** this season's (`BENBUYS_SEASON`) rows with `Exported?` unchecked and a
`Cat. or model no.`, `Quant.` and `Unit cost`.

**The check:** the row's `Link to product webpage` is read first and the manufacturer part number
shown there is searched (`Cat. or model no.` is only the fallback, since it's often a description).
The price at that link is used if it could be read, else the best-ranked option. Pack rows ("Sold in
packs of N" in the notes) are compared per unit. It alerts when the unit price moved at least
`PRICE_CHECK_THRESHOLD_PCT` (10) and the order total at least `PRICE_CHECK_MIN_DELTA_USD` (0).

**Who gets it:** Notion person → Slack user by email, then an unambiguous name match. No match →
`PRICE_CHECK_CHANNEL` if set, else the log. Each alert is claimed once in the Job Log as
`price-alert <row id> <unit cost> x<quant>`, so a row alerts again only after its `Unit cost` or
`Quant.` changes. Each alert sent is also logged as a Pending row in 💸 Price Check Savings.

### Turning it on
1. In `~/PERBot/.env`: `PRICE_CHECK_ENABLED=true` and `SERPER_API_KEY` (or `BRAVE_API_KEY`). It reads
   product pages with OpenAI on the bot's `OPENAI_API_KEY`. Optionally the Mouser/DigiKey keys and
   `PRICE_CHECK_CHANNEL`.
2. The Slack app needs `users:read` and `users:read.email` on top of `chat:write`, to find people.
3. `sudo systemctl restart perbot`. The log shows `price check: polling Purchasing every 120s …`, or
   `price check: not started: …` with the reason (a missing key never stops the bot).

Run it on one machine only: a laptop running `app.py` with it enabled would search the same rows (the
Job Log still stops double DMs).

### Settings
| Variable | Default | What it does |
|---|---|---|
| `PRICE_CHECK_ENABLED` | `false` | Run the price check in the bot |
| `SERPER_API_KEY` / `BRAVE_API_KEY` | one required | Web search (DuckDuckGo blocks cloud servers) |
| `OPENAI_API_KEY` | required (the bot's) | OpenAI reads the product pages |
| `PRICE_CHECK_MODEL` | `gpt-5-mini` | OpenAI model for the price check |
| `MOUSER_API_KEY`, `DIGIKEY_CLIENT_ID` + `DIGIKEY_CLIENT_SECRET` | optional | Exact distributor prices and stock |
| `PRICE_CHECK_THRESHOLD_PCT` | `10` | Alert when the unit price moved at least this much (%) |
| `PRICE_CHECK_MIN_DELTA_USD` | `0` | …and the order total moved at least this much ($) |
| `PRICE_CHECK_CHANNEL` | none | Post here when the Point of contact has no Slack match |
| `PRICE_CHECK_POLL_SECONDS` | `120` | How often to look for new rows |
| `PRICE_CHECK_SETTLE_SECONDS` | `60` | Wait this long after a row's last edit |
| `PRICE_CHECK_MAX_PER_HOUR` | `20` | Rows checked per hour at most |
| `PRICE_CHECK_LOOKBACK_HOURS` | `168` | On startup, catch up on rows edited this recently |
| `PRICE_CHECK_POOL` | `15` | Search results read per row |
| `BENBUYS_SEASON`, `BENBUYS_PURCHASING_DS_ID`, `NOTION_JOB_LOG_DS_ID`, `PRICE_CHECK_LEDGER_DS_ID` | as the bot | Which season and databases |

### Manual commands
```bash
python -m price_check.check --queue --dry-run -v       # one pass: new rows + queue, nothing written
python -m price_check.check --enqueue <notion page url> # queue a row by hand
python -m price_check.check --row <notion page url>     # check one row now
python -m price_check.check --all --dry-run -v         # every open row, print alerts only
python -m price_check.scrapers.llm_scraper "LM7805" -q 50       # the part search on its own
python -m price_check.cli <row url> <price> --to <Slack user id> # DM yourself a test alert's buttons
```

## Install

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run the indexer (optional)

The bot downloads the nightly index from the GitHub release on startup, so you only need this
to build one locally:

```bash
python -m search.indexer
```

This finds every Notion page shared with your integration (plus Google Drive when configured),
chunks and embeds it, and saves `data/index.json` + `data/embeddings.i8`.

## Start the Slack bot

```bash
python app.py
```

## Tests

```bash
pytest
```

## Scheduled jobs and CLIs

Run these from the repo root. Each GitHub Actions workflow runs one of them:

| What | Command |
| --- | --- |
| Nightly index build | `python -m indexer` |
| Sponsor win post (hourly) | `python -m sponsorship.jobs.win_post` |
| Sponsor stale DM (Wed) | `python -m sponsorship.jobs.stale_dm` |
| Sponsor reply DM | `python -m sponsorship.jobs.reply_dm` |
| Sponsor weekly digest (Sat) | `python -m sponsorship.jobs.weekly_digest` |
| Sponsor quota audit (Sat) | `python -m sponsorship.jobs.quota_audit` |
| Ops tasks digest (Sun) | `python -m ops_tasks.digest` |
| Meeting notes kickoff / generate | `python -m meeting_notes.post_kickoff` / `generate_notes` |

Local tools: `sponsorship.enrich_cli`, `draft_cli`, `discovery_cli`, `fsae_scan_cli`,
`fix_next_actions_cli`, `benbuys.cli`, `arrivals.cli`, `price_check.cli`, `price_check.check`,
`price_check.scrapers.llm_scraper` / `regex_scraper`,
`search.eval.run`, and `scripts/convert_legacy_index.py`.

## How to use PERBot in Slack

### Slash command
```text
/dt REV11 chassis packaging
```

### Mention
```text
@PERBot what do we have on accumulator shutdown logic?
```

### Filter examples
```text
/dt season:REV11 subsystem:chassis cooling layout
/dt historical:true REV10 suspension
@PERBot season:REV11 inverter packaging notes
```

## Important setup notes

### Slack
Make sure your Slack app has:
- Socket Mode enabled
- `/dt` slash command configured
- `app_mention` event subscription enabled
- OAuth scopes:
  - `commands`
  - `chat:write`
  - `app_mentions:read`

### Notion
Make sure your Notion integration:
- is an **internal integration**,
- has **Read content** enabled,
- has been explicitly shared onto the root pages / databases you want indexed.

If a page was not shared to the integration, PERBot cannot read it.

## Current limitations
- slash commands do not truly attach to a pre-existing user message, so PERBot creates a small search-parent message and then replies in a thread under it,
- the historical tag is heuristic-based,
- this MVP uses a local JSON index rather than Postgres / a vector DB,
- Notion webhooks are not wired in yet; the index refreshes nightly (or run `/reindex`).

## Recommended next upgrades
- add scheduled reindexing,
- add Notion webhooks,
- add reranking by subsystem and doc type,
- add admin-only `/dt reindex`,
- add better breadcrumb reconstruction from parent pages/databases.


## Set-it-and-forget-it core

This version keeps the Slack bot responsive and makes indexing durable.

What it adds:
- automatic bootstrap indexing if no index exists
- `/reindex` to manually rebuild in Slack
- `/indexstatus` to check build progress in Slack
- persistent `index-status.json`
- lexical index is saved before embeddings finish
- embedding checkpoints are saved every few batches
- the indexer runs in a child process so the bot stays responsive

Recommended server `.env` settings:

```env
AUTO_BOOTSTRAP_ON_MISSING_INDEX=true
SAVE_CHECKPOINT_EVERY_BATCHES=10
SLACK_REINDEX_ALLOWED_USER_IDS=U12345678
```

Recommended Slack slash commands:
- `/dt`
- `/reindex`
- `/indexstatus`
- `/race`: the REV12 members' time trial leaderboard (`/race`, `/race all`, `/race share`). Needs `RACE_SUPABASE_URL` and `RACE_SUPABASE_SERVICE_KEY` (the Supabase project behind race.pennelectricracing.com; the service_role key stays on the server). Without them `/race` just links to the game.

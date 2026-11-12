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
  render.yaml                 # Render background-worker blueprint
  app.py                      # Slack bot entrypoint (Socket Mode): python app.py
  config.py                   # environment variable loading
  indexer.py                  # Notion/Drive crawler + index builder: python indexer.py
  models.py                   # shared types
  services/
    index_store.py            # reads/writes the index + int8 embeddings
    index_downloader.py       # pulls the nightly index from the GitHub release
    llm.py                    # OpenAI embeddings/answers, Groq classify/rerank
    notion.py                 # Notion API crawler / markdown fetcher
    search.py                 # hybrid BM25 + vector ranking and filters
    slack_format.py           # Slack block formatting
  sponsorship/                # /sponsor, deal buttons, sponsorship jobs + CLIs
  ops_tasks/ benbuys/ arrivals/ price_check/ race/ meeting_notes/ sources/ search/
  utils/                      # chunking, logging, text, scheduling helpers
  tests/                      # pytest suite
```

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


## Cloud deployment (recommended: Render background worker)

Because PERBot uses Slack **Socket Mode**, it does **not** need a public Slack request URL. The cleanest cloud deployment is a **background worker** that maintains the outbound WebSocket connection to Slack. Render background workers are a good fit for this pattern. Slack’s Socket Mode docs explain that Socket Mode uses a WebSocket connection instead of a public HTTP Request URL, and Render’s worker docs describe long-running processes that do not receive inbound traffic.

### Included deployment files
- `render.yaml` — Render worker blueprint (`pip install -r requirements.txt`, then `python app.py`)

### How to deploy on Render
1. Push this project to a GitHub repo.
2. In Render, create a new service from that repo.
3. Render should detect `render.yaml`; if not, choose **Background Worker** manually.
4. Add these environment variables in Render:
   - `SLACK_BOT_TOKEN`
   - `SLACK_APP_TOKEN`
   - `NOTION_TOKEN`
   - `OPENAI_API_KEY` (recommended)
5. Deploy.

### Important cloud behavior
- The nightly GitHub Action (`build-index.yml`) builds the index and uploads it to the `notion-index-latest` release; the bot downloads it at startup and hot-swaps a newer one every `INDEX_REFRESH_MINUTES`.
- If no index can be downloaded and `AUTO_BOOTSTRAP_ON_MISSING_INDEX=true`, the bot runs the indexer itself in a child process.

### If you later add Notion webhooks
Socket Mode removes the need for a public Slack endpoint, but **Notion webhooks still require a public HTTP endpoint**. For the current MVP, the included worker setup skips webhooks and relies on startup/manual reindexing instead.

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
python indexer.py
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
`fix_next_actions_cli`, `benbuys.cli`, `arrivals.cli`, `price_check.cli`,
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

Recommended Render env vars:

```env
AUTO_BOOTSTRAP_ON_MISSING_INDEX=true
INDEX_PATH=/YOUR-DISK-MOUNT-PATH/index.json
INDEX_STATUS_PATH=/YOUR-DISK-MOUNT-PATH/index-status.json
SAVE_CHECKPOINT_EVERY_BATCHES=10
SLACK_REINDEX_ALLOWED_USER_IDS=U12345678
```

Recommended Slack slash commands:
- `/dt`
- `/reindex`
- `/indexstatus`
- `/race`: the REV12 members' time trial leaderboard (`/race`, `/race all`, `/race share`). Needs `RACE_SUPABASE_URL` and `RACE_SUPABASE_SERVICE_KEY` (the Supabase project behind race.pennelectricracing.com; the service_role key stays on the server). Without them `/race` just links to the game.

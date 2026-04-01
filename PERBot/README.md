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

```text
perbot/
  .env.example                # copy to .env and paste your real tokens here
  package.json                # dependencies + npm scripts
  tsconfig.json               # TypeScript config
  README.md                   # setup guide
  data/
    notion-index.json         # generated after indexing
  src/
    app.ts                    # Slack bot entrypoint
    config.ts                 # environment variable loading
    indexer.ts                # Notion crawler + local index builder
    types.ts                  # shared TypeScript types
    services/
      index-store.ts          # reads/writes the local JSON index
      llm.ts                  # OpenAI embeddings + summary logic
      notion.ts               # Notion API crawler / markdown fetcher
      search.ts               # ranking and filter logic
      slack-format.ts         # Slack block formatting
    utils/
      chunk.ts                # chunking + sleep helpers
      logger.ts               # logging helper
      text.ts                 # text cleanup helpers
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

Because PERBot uses Slack **Socket Mode**, it does **not** need a public Slack request URL. The cleanest cloud deployment is a **background worker** that maintains the outbound WebSocket connection to Slack. Render background workers are a good fit for this pattern. Slack’s Socket Mode docs explain that Socket Mode uses a WebSocket connection instead of a public HTTP Request URL, and Render’s worker docs describe long-running processes that do not receive inbound traffic. citeturn393795search2turn393795search3

### Included deployment files
- `render.yaml` — one-click-ish Render worker blueprint
- `scripts-run-cloud.mjs` — startup script that can build the Notion index, then start the Slack app

### How to deploy on Render
1. Push this project to a GitHub repo.
2. In Render, create a new service from that repo.
3. Render should detect `render.yaml`; if not, choose **Background Worker** manually.
4. Add these environment variables in Render:
   - `SLACK_BOT_TOKEN`
   - `SLACK_APP_TOKEN`
   - `NOTION_TOKEN`
   - `OPENAI_API_KEY` (recommended)
5. Keep `ALWAYS_REINDEX_ON_START=true` for the first deploy so the worker builds the Notion index before connecting to Slack.
6. Deploy.

### Important cloud behavior
- `npm run start:cloud` will build the Notion index at startup **if** there is no index yet, or whenever `ALWAYS_REINDEX_ON_START=true`.
- This is fine for an MVP with hundreds of pages, but it means cold starts and deploys may take longer.
- Later, you will probably want a separate scheduled reindex job instead of rebuilding on every start.

### If you later add Notion webhooks
Socket Mode removes the need for a public Slack endpoint, but **Notion webhooks still require a public HTTP endpoint**. For the current MVP, the included worker setup skips webhooks and relies on startup/manual reindexing instead.

## Install

```bash
npm install
```

If your machine has a private npm registry configured and install fails, run:

```bash
npm install --registry=https://registry.npmjs.org/
```

## Run the Notion indexer first

Before PERBot can answer anything, build the local index:

```bash
npm run index
```

This does the following:
- finds every Notion page shared with your integration,
- downloads page markdown,
- chunks each page,
- optionally creates embeddings,
- saves everything to `data/notion-index.json`.

## Start the Slack bot

For development:

```bash
npm run dev
```

For a production build:

```bash
npm run build
npm start
```

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
- Notion webhooks are not wired in yet, so re-run `npm run index` whenever you want fresh content.

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
- Node heap cap for the indexer

Recommended Render env vars:

```env
ALWAYS_REINDEX_ON_START=false
AUTO_BOOTSTRAP_ON_MISSING_INDEX=true
INDEX_PATH=/YOUR-DISK-MOUNT-PATH/notion-index.json
INDEX_STATUS_PATH=/YOUR-DISK-MOUNT-PATH/index-status.json
INDEXER_HEAP_MB=1536
SAVE_CHECKPOINT_EVERY_BATCHES=10
SLACK_REINDEX_ALLOWED_USER_IDS=U12345678
```

Recommended Slack slash commands:
- `/dt`
- `/reindex`
- `/indexstatus`

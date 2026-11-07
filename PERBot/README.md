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


## Cloud deployment (AWS Lightsail)

PERBot runs as a single always-on Node process on an AWS Lightsail instance, managed by systemd. It uses Slack **Socket Mode**, so it opens an outbound WebSocket to Slack and needs no public URL, load balancer, or inbound ports other than SSH. On startup it downloads the pre-built search index from the `notion-index-latest` GitHub release, so the instance needs no persistent index storage.

Run only one copy of a given Slack app at a time. Slack splits events between all connected Socket Mode clients, so a second copy would receive only some of them. Stop the old process before starting a new one with the same tokens.

### Instance
- **Image:** Ubuntu 24.04 LTS
- **Size:** 2 GB of memory. The bot needs a Node heap of about 500 MB to load the index, and memory peaks at about 800 MB to 1 GB during an index refresh, so 512 MB and 1 GB plans are too small.
- **Networking:** attach a static IP.
- **Firewall:** allow only port 22 (SSH), for both IPv4 and IPv6. Delete the default HTTP rule.

### First-time setup
SSH in with the instance's key:

```bash
ssh -i <key>.pem ubuntu@<server-ip>
```

Add swap, install Node 22, and build the bot:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

sudo git clone https://github.com/Penn-Electric-Racing/PERBot.git /opt/perbot
sudo chown -R ubuntu:ubuntu /opt/perbot
cd /opt/perbot/PERBot && npm ci && npm run build
```

Create `/opt/perbot/PERBot/.env` with the bot's environment variables, then run `chmod 600 .env`. Keep each value on one line, and base64-encode `GDRIVE_SERVICE_ACCOUNT_JSON` if you set it. Use relative index paths:

```env
INDEX_PATH=./data/index.json
EMBEDDINGS_PATH=./data/embeddings.i8
INDEX_STATUS_PATH=./data/index-status.json
```

Create `/etc/systemd/system/perbot.service`:

```ini
[Unit]
Description=PERBot
After=network-online.target
Wants=network-online.target

[Service]
User=ubuntu
WorkingDirectory=/opt/perbot/PERBot
EnvironmentFile=/opt/perbot/PERBot/.env
ExecStart=/usr/bin/node --enable-source-maps --max-old-space-size=1024 dist/app.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`WorkingDirectory` matters because `dist/indexer.js` and `./data` are relative paths.

Start the bot and make it start on boot:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now perbot
```

### Deploying updates
There is no auto-deploy. To release what is on `main`, SSH in and run:

```bash
cd /opt/perbot/PERBot
git pull && npm ci && npm run build && sudo systemctl restart perbot
```

### Operating the bot

```bash
journalctl -u perbot -f            # follow the logs
sudo systemctl status perbot       # check that it is running
sudo systemctl restart perbot      # restart, also needed after editing .env
sudo systemctl stop perbot         # stop
```

### Important cloud behavior
- The nightly `build-index.yml` GitHub Action builds the index, and the bot checks hourly for a newer one (`INDEX_REFRESH_MINUTES`). The scheduled sponsorship, ops, and meeting notes jobs also run in GitHub Actions, not on the instance.
- Avoid `/reindex` on a 2 GB instance. The default 1536 MB indexer heap plus the running bot won't fit in memory. Run the **Build Notion Index** workflow instead.
- If the index can't be downloaded at startup and `AUTO_BOOTSTRAP_ON_MISSING_INDEX=true`, the bot starts a full reindex on its own, which has the same memory cost.

### If you later add Notion webhooks
Socket Mode removes the need for a public Slack endpoint, but **Notion webhooks still require a public HTTP endpoint**. The current setup skips webhooks and relies on the nightly index build instead.

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

Recommended production env vars:

```env
AUTO_BOOTSTRAP_ON_MISSING_INDEX=true
INDEX_PATH=./data/index.json
EMBEDDINGS_PATH=./data/embeddings.i8
INDEX_STATUS_PATH=./data/index-status.json
INDEXER_HEAP_MB=1536
SAVE_CHECKPOINT_EVERY_BATCHES=10
SLACK_REINDEX_ALLOWED_USER_IDS=U12345678
```

Recommended Slack slash commands:
- `/dt`
- `/reindex`
- `/indexstatus`
- `/race`: the REV12 members' time trial leaderboard (`/race`, `/race all`, `/race share`). Needs `RACE_SUPABASE_URL` and `RACE_SUPABASE_SERVICE_KEY` (the Supabase project behind race.pennelectricracing.com; the service_role key stays on the server). Without them `/race` just links to the game.


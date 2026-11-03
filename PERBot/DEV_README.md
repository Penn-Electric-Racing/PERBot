# PERBot — Dev / Test Instance

A second, fully separate PERBot for trying changes without touching the real Slack channels or the
real Notion databases. It runs the **same code** as prod; only the configuration differs.

```
                 same code (dev branch)
                          │
        ┌─────────────────┴─────────────────┐
        ▼                                   ▼
   PERBot (prod)                       PERBot Dev
   .env                                .env.dev  + PERBOT_ENV=dev
   ./data (index)                      ./data-dev (index)
   Slack app "PERBot"                  Slack app "PERBot Dev"
   Notion integration "PERBot"         Notion integration "PERBot Dev"
     → shared with real pages/DBs        → shared ONLY with 🧪 PERBot Sandbox
```

---

## 1. What dev mode does

Turn it on with any of:

```bash
PERBOT_ENV=dev   # preferred
DEV=true
--dev            # CLI arg
```

When on (see `src/env.ts`):

| | Prod (default) | Dev mode |
|---|---|---|
| Env file | `.env` | `.env.dev` only (`.env` is never read) |
| Notion IDs/URLs not set in env | fall back to the prod IDs hard-coded in `src/config.ts` | **empty**: no prod fallback, ever |
| Local index | `./data/` | `./data-dev/` |
| Index downloaded from GitHub release | `notion-index-latest` | `notion-index-dev` (not the prod index) |
| BenBuys email recipients (`BENBUYS_DIGIKEY_TO`, `BENBUYS_CC`) | purchasing@ + CC pair | **empty** unless set |
| Startup log | normal | `DEV MODE` warning |

The real isolation comes from the **tokens**: the dev Slack app and the dev Notion integration can
only see what you give them. Dev mode adds a second layer, so a missing setting can never quietly
point at a prod database.

> Override the env file path with `DOTENV_CONFIG_PATH=...` if needed.

---

## 2. Notion: the sandbox

Don't clone the whole PER Notion. Build a **sandbox inside the existing workspace** and give it its
own integration. Notion integrations only see pages explicitly shared with them, so the dev token
can't touch prod. Staying in the same workspace keeps real members around, so people-based features
(task owners, digest DMs, `/assign`, quota roster) still work.

```
PER Notion workspace
└── 🧪 PERBot Sandbox   (private teamspace or private page)
     ├── Sponsorship/  Bank, Pipeline, Email Template page, Ops Quota Roster, Weekly Quota Audit
     ├── Ops/          Ops Tasks, Ops Meetings
     ├── Purchasing/   Purchasing (PEFS), Price Check Savings
     ├── Mechanical Meeting Notes   (parent page for generated notes)
     ├── ⚙️ PERBot Job Log
     └── Docs/         a handful of sample pages for /dt search
```

### Steps

1. **Create the sandbox.** Make a private teamspace (or private page) named `🧪 PERBot Sandbox` so
   members don't hit test data in search.
2. **Duplicate the databases into it.**
   - Keep **property names and types identical**. The code looks properties up by name.
   - Duplicate **related databases together** (e.g. Ops Tasks + Ops Meetings; Bank + Pipeline) so
     relations point at the sandbox copies, not prod. Open one row afterwards and check a relation.
   - Delete most rows and keep a few realistic ones.
3. **Create the integration.** Go to <https://www.notion.so/profile/integrations>, create a new
   **internal** integration named `PERBot Dev` with read + update + insert content, and copy its
   token.
4. **Share only the sandbox.** On the sandbox root page, use `•••` → **Connections** → add
   `PERBot Dev`. Do **not** connect it anywhere else.
5. **Collect the IDs** for `.env.dev`. Copy each database's link (`•••` → *Copy link*). The
   32-character hex string in the URL is the ID.
   - The `*_DS_ID` variables are **data source** IDs. Open the database → `•••` →
     *Manage data sources* → copy the data source ID.

| `.env.dev` variable | Sandbox item |
|---|---|
| `NOTION_ALLOWED_PAGE_IDS` | sandbox root page (limits `/dt` indexing to the sandbox) |
| `NOTION_JOB_LOG_DS_ID` | ⚙️ PERBot Job Log |
| `SPONSOR_BANK_DS_ID`, `SPONSOR_PIPELINE_DS_ID` | Sponsor Bank, Pipeline |
| `SPONSOR_EMAIL_TEMPLATE_PAGE_ID` | Sponsorship Email Template page |
| `SPONSOR_QUOTA_ROSTER_DS_ID`, `SPONSOR_QUOTA_AUDIT_DS_ID`, `SPONSOR_QUOTA_AUDIT_URL` | Ops Quota Roster, Weekly Quota Audit |
| `OPS_TASKS_DS_ID`, `OPS_MEETINGS_DS_ID`, `OPS_TASKS_MY_OPEN_URL` | Ops Tasks, Ops Meetings, "My open" view link |
| `BENBUYS_PURCHASING_DS_ID` | Purchasing (PEFS) |
| `PRICE_CHECK_LEDGER_DS_ID`, `PRICE_CHECK_LEDGER_URL` | Price Check Savings |
| `MEETING_NOTES_PARENT_PAGE_ID` | Mechanical Meeting Notes page |

Anything left blank: that feature runs with an empty ID and fails or does nothing in dev. It never
falls back to prod.

---

## 3. Slack: the dev app

Create a second app at <https://api.slack.com/apps> named **PERBot Dev**. Install it in the PER
workspace (simplest) or a separate test workspace (stronger isolation).

- **Socket Mode:** on. Create an app-level token with `connections:write` (→ `SLACK_APP_TOKEN`).
- **Bot token scopes:** at least `commands`, `chat:write`, `app_mentions:read`. Copy the rest from
  the prod app's *OAuth & Permissions* page so behaviour matches.
- **Event subscriptions:** `app_mention`, plus `message.channels` / `message.groups` if testing
  arrivals.
- **Slash commands:** `/dt`, `/anon`, `/reindex`, `/indexstatus`, `/assign`, `/sponsor`,
  `/benbuys`, `/race`, `/pricecheck`. Only add the ones you're testing.
- **Interactivity:** on (buttons and modals). Add the message shortcut with callback ID
  `ops_assign_shortcut` if testing `/assign` from a message.
- Create a private **`#perbot-dev`** channel, invite the bot, and point channel settings
  (`SPONSOR_WIN_CHANNEL`, `SPONSOR_QUOTA_CHANNEL`, `ARRIVALS_CHANNEL`) at it.

> ⚠️ In the same workspace, both bots register the same slash commands, so Slack makes users pick
> which app runs `/sponsor`. Use `#perbot-dev` and pick **PERBot Dev**, or use a separate workspace.

> ⚠️ Meeting-notes kickoff posts to the subsystem channels listed in `src/meetingNotes/config.ts`.
> Don't run `postKickoff` in dev unless the dev app is only in test channels.

---

## 4. Configure and run

```bash
cd PERBot
cp .env.dev.example .env.dev     # fill in tokens + sandbox IDs (.env.dev is gitignored)
npm install
npm run index:dev                # build ./data-dev index from the sandbox
npm run dev:test                 # run the bot with auto-reload
```

| Script | What it does |
|---|---|
| `npm run dev:test` | Bot in dev mode with auto-reload (`tsx watch`) |
| `npm run index:dev` | Build the dev search index into `./data-dev` |
| `npm run start:dev` | Run the built bot (`npm run build` first) in dev mode |

Any other script or job runs against the sandbox if you prefix it:

```bash
PERBOT_ENV=dev npm run job:sponsor-win
PERBOT_ENV=dev STALE_DRY_RUN=true npm run job:sponsor-stale
PERBOT_ENV=dev npm run arrivals:try -- <args>
```

---

## 5. Seeding test data: PEFS (Purchasing)

`npm run dev:pefs` inserts test rows into the **sandbox** Purchasing (PEFS) database, so you can
exercise BenBuys, arrivals and price check without typing rows by hand. Code: `src/dev/`.

It **refuses to run** unless dev mode is on, `BENBUYS_PURCHASING_DS_ID` is set in `.env.dev`, and
that ID isn't the prod database.

```bash
npm run dev:pefs -- schema                    # check the sandbox copy has every column the bot uses
npm run dev:pefs -- seed benbuys --dry-run    # preview
npm run dev:pefs -- seed benbuys              # insert
npm run dev:pefs -- list                      # show seeded rows (+ PEFS Ready? / exported / arrived)
npm run dev:pefs -- clean                     # trash ALL seeded rows (or: clean <batch>)
```

| Preset | Rows | Exercise with |
|---|---|---|
| `benbuys` | 3 ready DigiKey rows (two share a part number → one cart line) + 1 missing-fields row | `/benbuys prep digikey` or `PERBOT_ENV=dev npm run benbuys:prep -- digikey` |
| `mcmaster` | 2 McMaster-Carr rows | `/benbuys prep mcmaster` |
| `arrivals` | 3 rows already ordered (exported, Run ID `DEV-<batch>`, Submitted, `Arrived?` = No) | post a packing-slip photo in the arrivals channel, or `PERBOT_ENV=dev npm run arrivals:try` |
| `pricecheck` | 1 un-exported DigiKey row | `PERBOT_ENV=dev npm run price-check:try -- <row url> <price> --to <your Slack ID>` |
| `all` | all of the above | |

**Defaults on every row:** Season = `$BENBUYS_SEASON` (REV12), Payment Method = BenBuys, not
exported, Order Batch `dev-<batch>`. Anything in a preset or file overrides these.

**Custom rows:** `npm run dev:pefs -- seed --file my-rows.json`, where the file is an array of
`{ "Column name": value }` objects. Values are converted using the sandbox column types: text,
number, checkbox, select/status (name), multi-select (array or `"a, b"`), url, and date (ISO).

```json
[
  { "Name": "Fuse 30A", "Cat. or model no.": "F4772-ND", "Quant.": 4, "Unit cost": 2.5,
    "Subsystem": ["Electrical"], "Link to product webpage": "https://www.digikey.com/...", "Vendor": "DigiKey" }
]
```

**How cleanup finds rows:** every seeded row starts its `Notes (internal)` with
`[dev-seed <batch>]`. `list` and `clean` only ever touch rows carrying that tag, never rows someone
typed into the sandbox.

**Notes:**
- Formula columns (`PEFS Ready?`, `Electrical BENBuys`, …) can't be written. They compute from the
  other columns, so they only come out right if the sandbox copy kept the prod formulas. Check
  with `list`.
- `Point of contact` (person) isn't set. If the sandbox's `PEFS Ready?` formula requires it, rows
  show ❌ until you fill it in Notion.
- Columns the sandbox lacks are skipped with a warning. Run `schema` to see what's missing.

---

## 6. Hosting the dev bot (optional)

The bot uses Socket Mode (outbound connection only, no inbound ports), so it runs fine in a
separate container next to prod.

- **Your laptop:** `npm run dev:test`. Best for active development.
- **Render:** add a second **background worker** (e.g. `perbot-dev`) that tracks the `dev`
  branch, with `PERBOT_ENV=dev` and the dev tokens as env vars. Each Render service is its own
  container. Suspend it when not in use. *(Not in `render.yaml` yet.)*
- **Docker:** one image, two containers with different env files and volumes. *(No Dockerfile in
  the repo yet.)*

  ```
  perbot      --env-file .env                    -v ./data:/app/data
  perbot-dev  --env-file .env.dev -e PERBOT_ENV=dev  -v ./data-dev:/app/data-dev
  ```

---

## 7. Gotchas

- **GitHub Actions cron jobs only run on `main`.** Scheduled workflows (digests, win posts, quota
  audit, meeting notes) won't fire from `dev`. Run them locally with `PERBOT_ENV=dev` instead.
- **Keep the sandbox schema in sync.** If a PR adds or renames a Notion property, change the sandbox
  database too, or dev breaks while prod works (or the other way round).
- **Shared API keys** (OpenAI, Groq, Hunter) can be reused in `.env.dev`, but dev usage counts
  against the same quota. Hunter's free tier is only 50 credits a month.
- **BenBuys:** leave `BENBUYS_DIGIKEY_TO` / `BENBUYS_CC` empty, or set them to your own address,
  so `/benbuys done` never emails purchasing for real.

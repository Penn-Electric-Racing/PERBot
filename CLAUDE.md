# CLAUDE.md — PERBot

Operating manual for Claude Code working in this repo. Keep it high-signal and stable;
put execution plans in GitHub issues, not here. Merge into an existing CLAUDE.md if one exists.

## What this repo is

**PERBot** is Penn Electric Racing's automation layer: a TypeScript Slack app plus scheduled
GitHub Actions jobs that connect Slack, Notion, and Groq. Existing systems include meeting-notes
automation, `/risk`, and `/dt` doc search. The current work is the **Sponsorship enrichment module**
that feeds the Sponsorship CRM in Notion.

Repo: `Penn-Electric-Racing/PERBot` · Runtime: Node.js + TypeScript · Deploy: GitHub Actions (cron)
and the PERBot Slack app. ~$30/mo total infra.

## Stack & where things run

- **Slack**: PERBot commands (`/risk`, `/dt`, and the new `/sponsor`).
- **Notion**: system of record (Sponsorship CRM). Accessed via the Notion API.
- **Groq**: all LLM generation. Target model: **`openai/gpt-oss-120b`** with `reasoning_effort: low`
  (replaces `llama-3.3-70b-versatile`, which Groq **decommissions Aug 16 2026**; free/dev tier is affected).
  Text-only (no vision). Read the model ID from a single **`GROQ_MODEL`** env var everywhere.
  ⚠️ **P0, not yet done:** existing call sites (meeting-notes parser, `/risk`, `/dt` rerank) still send the
  old string — migrate them to `GROQ_MODEL` before the deadline. Tracked in GitHub issues.
- **Hunter.io**: contact/email enrichment + verification. Free tier to start (50 credits/mo).
- **GitHub Actions**: scheduled/bulk jobs.
- Secrets live as **GitHub repository secrets**: `SLACK_BOT_TOKEN`, `NOTION_API_KEY`,
  `GROQ_API_KEY`, and (new) `HUNTER_API_KEY`. Never hardcode keys.

## Sponsorship module — architecture

Two Notion databases: the **Prospect Bank** (researched, unclaimed leads) feeds the **Pipeline**
(active deals). Enrichment writes into the Bank. A Bank row graduates to a Pipeline deal when a
member claims it and sends first outreach.

`enrichCompany(nameOrUrl)` pipeline:
1. Resolve company → domain.
2. Fetch the company homepage/about text (deterministic; not the LLM).
3. Groq → **structured JSON only** (forced schema): `fit_reason`, `suggested_angle`, `tier`,
   `category[]`, `cash_vs_inkind`, `channel`.
4. Hunter Domain Search / Email Finder → contacts + role + **verified email + confidence**.
5. Dedupe against the Bank **by domain**.
6. Create a Bank row: `Status = Available`, `Relationship = New`, and `Contact name` + `Contact email`
   from Hunter. Flag **Needs Review** if Hunter confidence is low or the email is unverified.

`Relationship` (New / Returning / Lapsed) is **not** guessed by the LLM — default every enriched row to
New. Returning/Lapsed is set by a human or by checking against past Won deals. Since PER is starting
fresh, everything is New now; Won deals become next season's Returning/Lapsed (warm) list.

## Pipeline stages (5-stage model — kept deliberately simple)

Volunteers won't maintain a 7-stage funnel, so the Pipeline uses 5 stages, each tied to a real event
(not a subjective gradient). `Stage probability` and `Weighted value` formulas key off these:

- **Prospect** (10%) — claimed, not yet emailed
- **Contacted** (20%) — outreach sent, no reply
- **In talks** (50%) — they replied / it's live (collapses old Engaged+Proposal+Committed)
- **Won** (100%) — terminal
- **Lost** (0%) — terminal

The only human-critical move is **→ Won** (the live counter and the #operations win post read from it).
The **→ In talks** move should be auto-advanced by the Phase-3 reply-capture flow when a sponsor
replies, so the most-forgotten transition costs nothing.

## Notifications / motivation layer (PERBot jobs — in scope)

- **Win post**: on Notion `Stage = Won`, post once to **#operations** with the running % to $35k.
  Gated to Won only — no prospect/stage/touch posts (that would be spam).
- **Wednesday 9 AM personalized stale DM**: scheduled job reads the CRM and DMs each member *only their
  own* overdue deals, timed for weekly check-ins. No DM if they have nothing overdue (silence is valid).
- **Reply DM** (from Phase 3): DM the deal's DRI when their sponsor replies. Event-driven, rare.

## Non-negotiable guardrails

- **The LLM never invents contact data.** Emails/contacts come **only** from Hunter, always with
  verification status + confidence stored. LLM-guessed emails are a severe bug (burns deliverability).
- **No AI-drafted outreach.** The team uses its own email templates; the LLM does **not** write
  outreach copy. The enrichment's `suggested_angle` may be *merged* into a template later (mechanical
  fill, not generative writing), but there is no AI drafting layer and no auto-send under the team's name.
- **Structured assertions over freeform LLM judgment.** Force Groq to return a fixed JSON schema and
  validate it; don't parse prose.
- **Draft-not-send / read-not-act** is the default for every side-effectful step.

## Notion API quirks (learned the hard way — respect these)

- Formulas: `let()` is **not supported** via DDL/`update_data_source` — inline all references, even
  when repetitive.
- Relations: use a **single** `ADD COLUMN ... RELATION(ds, DUAL 'reverse' 'reverse-slug')`; issuing
  both sides creates four columns.
- A **failed `ALTER COLUMN` can silently drop unrelated SELECT columns** — always re-fetch and verify
  schema after a schema change.
- Person-property filters referencing the current viewer are **silently dropped by the API** — set a
  hardcoded UUID or leave the "= Me" filter as a one-click manual UI step.
- Overdue flag pattern that works: `dateBetween(prop("Date"), now(), "days") < 0` = overdue.

## Idempotency (mandatory for scheduled/bulk jobs)

GitHub Actions cron can fire **late or double** under load. Every scheduled or bulk job must guard
with: a time-check, a per-record guard, and (for Slack posts) a per-channel guard. For bulk
enrichment, the per-domain dedupe guard also prevents re-spending Hunter credits on re-runs.

## Notion IDs (this workspace)

- Sponsorship CRM page: `390560bc-c039-812e-a208-d14aa17a8243`
- **Pipeline** data source: `64bb332e-543c-4286-9e67-c3bda963cfdd`
- **Prospect Bank** data source: `fd42b16b-2833-42c3-b72d-f6322145ed4e`
- REV12 Operations (parent): `38e560bc-c039-8131-9a35-d3ef98c7a06c`

## Prospect Bank schema (valid values for the enrichment writer)

- `Company` (title), `Domain` (url), `Fit reason` (text), `Suggested angle` (text),
  `Warm contact` (text), `Contact name` (text), `Contact email` (email), `Notes` (text), `Claimed by` (people)
- `Status`: Available · Claimed · Graduated · Dead
- `Relationship`: New · Returning · Lapsed
- `Tier`: Tier 1 · Tier 2 · Tier 3
- `Warmth`: Warm intro · Existing vendor · Cold
- `Type`: Cash · In-Kind
- `Channel`: Vendor · Alumni employer · Competitor sponsor · Category/TAM · Local/Regional · Inbound · Other
- `Category` (multi-select): Aerodynamics · Chassis/DI · Drivetrain · Suspension · Accumulator ·
  Vehicle Dynamics · Electrical Hardware · Manufacturing · Software/CAD · General · Business/Ops · Team-wide
- Relation to Pipeline: `Pipeline deal`

The **Pipeline** mirrors `Contact name`, `Contact email`, and `Relationship` (they carry through
graduation), plus its own `Stage`, `DRI`, `Deal value ($)`, `Received ($)`, `Last contact`,
`Next action` / `Next action date`, `Source`, and the `Stage probability` / `Weighted value` / `Flag`
formulas. Won deals + `Relationship` make the Pipeline double as the **sponsor database** across seasons.

## Conventions

- Prefer **full-file replacements** over diff-style patches once a file gets complex.
- For any non-code setup (GitHub UI, secrets, Slack app config, Power Automate), write
  **click-by-click** steps.
- Retrieving other repos: `codeload.github.com` tarball is reliable where the unauthenticated REST
  API rate-limits; filter `node_modules/` before extracting.
- Two recurring pushes max: **Wednesday 9 AM** personalized stale DM + **Sunday** digest (carries the
  progress line). Everything else is pull (Notion views). Win posts are event-driven, not a recurring push.

## Commands

**Slack (`/sponsor`) — three commands, no drafting command:**
- `/sponsor add [company|url]` — runs enrichment, drops a deduped researched row into the Bank (Available).
  - **Directed add:** `/sponsor add <company> for <ask> contact: <name> <email> @person` — when you
    already know the ask, contact, and/or owner. The ask becomes the `Suggested angle` verbatim **and**
    steers the LLM's Tier/Type/Category; a `contact:` you type is written as the contact (verificationStatus
    `provided`) and **replaces the Hunter lookup** — a human-typed contact isn't LLM-invented, so it's
    allowed by the no-fabricated-contacts guardrail; each `@mention` is resolved to a Notion person and the
    lead is **graduated straight to a Pipeline deal** (Stage `Prospect`, DRI = the mention, Bank row →
    `Graduated`/`Claimed`, next action seeded +7 days). All three of `for <ask>`, `contact: …`, and
    `@person` are optional and independent. Parsing lives in `slack.ts:parseAdd` (mentions anywhere; ask
    after " for "; contact after "contact:"; Slack's `<url>`/`<mailto:>` wrappers are unwrapped first).
    A directed add against an already-banked domain is reported, not double-graduated.
- `/sponsor claim <company> [@person]` — graduate an existing **Bank** lead into a Pipeline deal (Stage
  `Prospect`, DRI = the caller by default, or the @mentioned people). Marks the Bank row `Graduated`/
  `Claimed`. This is the "own it myself" path — no mention needed, it uses the caller's Slack identity.
  A directed `/sponsor add` against an already-banked domain now does the same graduation inline (instead
  of just reporting "already in Bank"). Both no-op with a link if the lead is already a deal.
  - **Assignee mentions.** Slack slash commands send `@Name` as plain text (`@handle`), NOT a real
    `<@U…>` mention, unless the command has "Escape channels, users, and links" enabled. So the assignee
    resolver (`identity.ts:resolveSlackHandles`) handles BOTH: real `<@U…>` mentions AND plain-text
    `@handles`/names, looked up in the Slack directory (usernames are unique → safe; ambiguous display
    names left unresolved). Enabling link-escaping on the command is optional but cleaner.
  - **Forgiving parser** (`slack.ts:parseAdd`): handles natural phrasing, not just rigid keywords —
    `Jane Street, DRI is @X contact is Steph, s@jane.com` parses to company `Jane Street`, DRI `@X`,
    contact `Steph <s@jane.com>`. Company = the lead text before the first metadata boundary
    (comma / `for` / `contact` / `dri` / `owner`); mentions, emails, `for <ask>`, and `contact <is|:> …`
    are extracted from anywhere in the string.
- `/sponsor log [company] [note]` — manual touch logger; stamps `Last contact` + appends note on the
  Pipeline row. Covers phone/in-person/off-domain touches the email flow can't see.
- `/sponsor won <company> <amount> [note]` — marks the deal `Stage = Won`, writes `Received ($)` (and
  `Deal value` if blank), stamps `Last contact`, and **posts the win to #operations immediately** (reusing
  the win-post `sponsor-won:<id>` marker so the hourly job won't double-post). Amount accepts `$5,000`,
  `5000`, `5k`, **or a discount** — `38% of $9k` / `38% discount on cells worth $9000` computes `$3,420`
  and shows the derivation in the confirmation (`parseWon`).
- `/sponsor stage <company> <stage>` — moves a deal to any stage (`Prospect`/`Contacted`/`In talks`/`Won`/
  `Lost`) + stamps `Last contact`. For `Won` it nudges you to use `/sponsor won` to also record the amount.
- `/sponsor me` — returns the caller's own active deals + next actions (pull view).

**npm scripts** (run from the `PERBot/` subdirectory — the Node project root)
- Install: `npm ci`
- Dev (Socket Mode, watch): `npm run dev`
- Build: `npm run build` · Typecheck only: `npm run check`
- Enrich one company: `npm run enrich -- "<company or url>"`
- Win-post job (cron): `npm run job:sponsor-win`
- Wednesday stale-DM job (cron): `npm run job:sponsor-stale` (set `FORCE_STALE_DM=true` to run off-day)
- Reply-DM job (cron, Phase 3): `npm run job:sponsor-reply`
- There is no `npm test` yet.

## Out of scope for Claude Code

- **No historical backfill** — PER is starting fresh, so there's no last-season data to enter. The
  baseline (close rate, avg deal size) is generated *forward*: recalibrate the stage probabilities and
  set a real prospect quota after ~10–20 closed/lost deals. Until then, drive **activity targets**, not
  conversion targets. Seeding the Bank with warm leads (vendor list, alumni employers, competitor
  sponsors) is manual Notion work.
- **Phase 3 email reply-capture — HYBRID (built).** Split so the hard part (DRI→Slack identity) stays in
  PERBot where the resolver lives:
  - **Power Automate half** (built in the Power Automate UI, not this repo): a flow on
    `electric@engineering.upenn.edu` (Gmail connector) matches an inbound reply to its Pipeline deal by
    **Contact email contains `@<sender-domain>`**, then via the Notion API stamps `Last contact`, sets
    `Stage = In talks`, and ticks the **Reply pending** checkbox.
  - **PERBot half** (`jobs/replyDm.ts`, cron hourly): finds deals with `Reply pending = true`, DMs the
    DRI(s) to follow up, and clears the flag (clearing = idempotency). See "Setup" for the flow's HTTP bodies.

## As-built notes (sponsorship module — read before extending)

The module lives in `PERBot/src/sponsorship/`. Layers: `domain.ts` (deterministic
resolve) → `homepage.ts` (fetch+strip) → `classify.ts` (Groq forced-JSON) →
`hunter.ts` (contacts) → `enrichCompany.ts` (orchestrator) → `notion.ts` (CRM I/O).
Slack surface in `slack.ts`; cron jobs in `jobs/`. Model comes from `GROQ_MODEL`
(`openai/gpt-oss-120b`, `reasoning_effort: low`) via `config.groq.model`.

Deltas from the spec above, discovered while building against the live Notion schema:

- **`Needs Review` is a checkbox column** on the Prospect Bank (added via MCP DDL). It's
  set true when the Hunter contact is missing / low-confidence / unverified, and the *reason*
  is also written as a `⚠️ NEEDS REVIEW: …` line in **Notes** (`notion.ts:buildNotes`). Filter
  the Bank on the checkbox to triage.
- **`cash_vs_inkind` → the `Type` property** (Cash / In-Kind). The LLM's `category[]`
  maps to the `Category` multi-select; a row never writes an empty multi-select (defaults
  to `General`). All enum values are validated in `classify.ts` against `types.ts` — keep
  `types.ts` in sync if the Notion select options change.
- **Dedupe runs before Hunter** so re-runs don't re-spend credits. The dedupe key is the
  canonical `https://<domain>` stored in the Bank `Domain` column (exact-match filter).
- **Enrichment always writes `Status = Available`, `Relationship = New`.** Relationship is
  never LLM-guessed (guardrail).
- **Slack ↔ Notion identity (`identity.ts`): email primary, conservative name fallback.**
  DRI is a native Notion *person* (unlike per-risk, which stores Slack IDs in text and
  name-matches typed names), so email is the natural strong join key. When email is
  unavailable (Notion integration lacks the "read user emails" capability, or Slack/Notion
  emails differ), we fall back to the same conservative name matcher per-risk uses (exact
  normalized name / unique token-subset / unique surname+first-initial) — ambiguous is left
  unresolved, never guessed. Needs Slack scopes **`users:read`** + **`users:read.email`**;
  enable the Notion integration's **read-user-emails** capability for the primary path.
- **Config now accepts `NOTION_TOKEN` *or* `NOTION_API_KEY`**, and `SLACK_APP_TOKEN` is
  optional (only the Socket-Mode app needs it) — so the cron job entrypoints can import
  `config` in a minimal env. Jobs need only `SLACK_BOT_TOKEN` + `NOTION_API_KEY`.
- **Win post @-mentions the deal's DRI(s)** for a shoutout ("Huge shoutout to @X for landing this
  one!"), resolving each Notion DRI → Slack via `winPost.ts:resolveDriMentions` (Slack mention, or the
  Notion display name if there's no Slack match). Directories are fetched once per run.
- **Win post is polled hourly**, not event-driven (no Notion webhook in this repo). Idempotency
  uses an **invisible Slack message-metadata marker** (`event_type: sponsor_win`, payload `deal_id`)
  checked via `conversations.history` `include_all_metadata` (`shared.ts:alreadyPosted`); a legacy in-text
  `sponsor-won:<id>` marker is still honored. The win post is to a **channel** (#operations), where the
  bot has `channels:history`.
- **All DM jobs post straight to the user ID** (`chat.postMessage({ channel: <Uxxxx> })`), which Slack
  auto-opens and which needs only **`chat:write`** — NOT `im:write`/`im:history` (the bot lacks those, and
  `conversations.open`/DM-history reads would fail). Consequently DM jobs can't read DM history for a
  marker, so their idempotency is elsewhere: **reply DM** clears the Notion `Reply pending` flag after
  sending; **stale DM** uses a Wednesday-**9am-ET** time gate so only the DST-correct cron fires the work.

## Setup (click-by-click — do these once)

**1. Add the `HUNTER_API_KEY` GitHub secret**
- GitHub → `Penn-Electric-Racing/PERBot` → **Settings** → **Secrets and variables** → **Actions**.
- **New repository secret** → Name `HUNTER_API_KEY`, Value = your Hunter key → **Add secret**.
- (Enrichment via `/sponsor add` runs in the Render worker too — add `HUNTER_API_KEY` to the
  Render service's **Environment** as well.)

**2. (Optional) Set the win-post channel**
- Same page → **Variables** tab → **New repository variable** → Name `SPONSOR_WIN_CHANNEL`,
  Value = the channel name (`operations`) or ID (`C…`). Defaults to `operations` if unset.
- The bot must be **invited to that channel** (and to members' DMs are opened automatically).

**3. Register the `/sponsor` slash command in the Slack app**
- <https://api.slack.com/apps> → the **PERBot** app → **Slash Commands** → **Create New Command**.
- Command: `/sponsor` · Request URL: not needed for Socket Mode (any placeholder, e.g.
  `https://example.com/slack`) · Short description: `Sponsorship CRM: add / log / me` ·
  Usage hint: `add <company|url> | log <company> - <note> | me` → **Save**.
- **OAuth & Permissions** → confirm bot scopes include `commands`, `chat:write`,
  `users:read`, `users:read.email`, `channels:read`, `channels:history` (for the win-post
  marker check). Add any missing, then **Reinstall to Workspace**.

**4. Verify**
- `npm run enrich -- "https://www.altium.com"` locally (with env set) → a Bank row appears.
- In Slack: `/sponsor add altium.com`, then `/sponsor me`.
- Trigger the jobs manually from the **Actions** tab (`workflow_dispatch`); the stale DM has a
  `force` input to run off-Wednesday.

**5. Phase-3 Power Automate flow ("Sponsor reply capture")** — the email half of reply-capture.
Uses the same Notion integration token PERBot uses; the PERBot `job:sponsor-reply` cron does the DRI DM.
- **Trigger:** Gmail → *When a new email arrives (V3)* on `electric@engineering.upenn.edu`, folder Inbox.
- **Compose `SenderDomain`:** `toLower(last(split(trim(replace(replace(triggerOutputs()?['body/From'],'>',''),'<','')),'@')))`
- **Compose `Today`:** `formatDateTime(convertTimeZone(utcNow(),'UTC','Eastern Standard Time'),'yyyy-MM-dd')`
- **HTTP — Query Notion** (POST `https://api.notion.com/v1/data_sources/64bb332e-543c-4286-9e67-c3bda963cfdd/query`,
  headers `Authorization: Bearer <NOTION_API_KEY>`, `Notion-Version: 2025-09-03`, `Content-Type: application/json`):
  ```json
  { "filter": { "and": [
    { "property": "Contact email", "email": { "contains": "@<SenderDomain>" } },
    { "property": "Stage", "select": { "does_not_equal": "Won" } },
    { "property": "Stage", "select": { "does_not_equal": "Lost" } }
  ] }, "page_size": 1 }
  ```
- **Condition:** `length(body('Query_Notion')?['results']) > 0`. If yes →
- **HTTP — Update page** (PATCH `https://api.notion.com/v1/pages/<first result id>`, same headers):
  ```json
  { "properties": {
    "Last contact": { "date": { "start": "<Today>" } },
    "Stage": { "select": { "name": "In talks" } },
    "Reply pending": { "checkbox": true }
  } }
  ```
- Notes: mark the HTTP inputs **secure**; if `Notion-Version: 2025-09-03` errors, use `2026-03-11`.
  Only the first active deal per sender domain is matched (page_size 1). Deals need a `Contact email`.

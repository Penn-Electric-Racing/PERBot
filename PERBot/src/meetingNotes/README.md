# Meeting Notes Automation

Auto-generates the weekly Mechanical Meeting Notes Notion page from Slack thread updates.

## How it works

```
Monday 9am ET    →  PERBot posts a kickoff message in each of the 6 mechanical subsystem channels
Mon/Tue/Wed AM   →  Members reply in-thread with their weekly updates (freeform)
Wednesday 12pm ET → PERBot scrapes each thread, asks Gemini to bucket the content into the
                     standard sections (Logistical / Design / Manufacturing / Overdue / Look-Ahead
                     + Deadlines/Complete/Incomplete), and creates a new "MM/DD Mechanical Meeting"
                     page under REV12 Mechanical Meeting Notes.
```

The General Updates/Announcements section at the top is left empty for subteam leads to fill in
manually before the Wednesday meeting.

## Channel → Subsystem mapping

| Slack channel | Notion section |
| --- | --- |
| `#accumulator` | Accumulator |
| `#drivetrain` | Drivetrain |
| `#suspension` | Suspension ඞ |
| `#driver_interface` | Driver Interface |
| `#aero_composites` | Aerodynamics |
| `#vehicledynamics` | Vehicle Dynamics |

(The channel was `#chassis` until July 2026 — renamed to match the subsystem.)

## Setup (one-time)

### 1. Dependencies

From `PERBot/`:

```bash
npm install @slack/web-api @notionhq/client @google/generative-ai
npm install --save-dev tsx @types/node
```

### 2. GitHub Secrets

Repo → Settings → Secrets and variables → Actions → New repository secret.
Add all three:

- `SLACK_BOT_TOKEN` — starts with `xoxb-`
- `NOTION_API_KEY` — starts with `secret_` or `ntn_`
- `GEMINI_API_KEY` — starts with `AIza` ([get one free](https://aistudio.google.com/apikey))

### 3. Slack bot scopes

The bot needs these scopes in the Slack app config (api.slack.com/apps):

- `chat:write` — post kickoff messages
- `channels:read` — find channels by name
- `channels:history` — read thread replies in public channels
- `groups:history` — same, for any private subsystem channels
- `users:read` — resolve user IDs to display names

After adding scopes, reinstall the app to the workspace and **invite the bot to all 6 subsystem channels** (`/invite @PERBot`).

### 4. Notion integration

The Notion API key must belong to an integration that has been **explicitly shared with the REV12 Mechanical Meeting Notes page** (and the parent REV12 page if relevant).

In Notion: open the page → top right `•••` menu → Connections → add the PERBot integration.

## Testing

Manual run from the GitHub Actions tab:

1. Go to repo → Actions → "Meeting Notes — Monday Kickoff" → "Run workflow"
2. Wait, verify kickoff posts appear in all 6 channels
3. Post a few replies in one of the threads
4. Go to Actions → "Meeting Notes — Wednesday Generate" → "Run workflow"
5. Check Notion for the new "MM/DD Mechanical Meeting" page

Note: the script checks the current ET hour and exits if it isn't 9 (Monday) or 12 (Wednesday).
**For manual testing, comment out the `assertExpectedETHour(...)` line temporarily.**

## Customizing

| Want to change | Edit |
| --- | --- |
| Channel list / subsystem names | `config.ts` → `SUBSYSTEMS` |
| Parent Notion page (e.g. REV13) | `config.ts` → `NOTION_PARENT_PAGE_ID` |
| Kickoff message wording | `config.ts` → `KICKOFF_MESSAGE` |
| Run time | `.github/workflows/meeting-notes-{monday,wednesday}.yml` cron + the `assertExpectedETHour(...)` value |
| What sections appear in Notion | `notionWriter.ts` → `buildPageBlocks` |
| How Gemini buckets content | `parseUpdates.ts` → the prompt |

## Known v1 limitations

- **Images** in the Slack threads are linked back to (not embedded). The Notion page shows
  `📷 N image(s) posted in thread — view in Slack` with a clickable link.
- **No DST handling beyond Eastern Time.** If PER ever needs this in a non-ET timezone, update
  both the cron expressions and the timezone string in `generateNotes.ts` and `timeCheck.ts`.
- **Run failures aren't reported to Slack.** Check the Actions tab if a Wednesday meeting starts
  without a notes page. The job log will show what broke.
- **No de-duping.** If the Wednesday workflow runs twice, you'll get two Notion pages.
  The `workflow_dispatch` trigger makes accidental reruns easy — be aware.

## Replicating for Electrical / other subteams

Most efficient path: duplicate this whole `meetingNotes/` folder as `meetingNotesElectrical/`,
edit the config, and add two more workflow files. Both copies can share the same Slack/Notion/Gemini
credentials in GitHub Secrets — no need to duplicate those.

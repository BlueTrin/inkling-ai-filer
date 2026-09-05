# inkling-ai-filer

Scanned pages land in a Google Drive folder. Every 15 minutes a Google Apps
Script lists that folder. If it is empty it exits, having spent nothing. If it
is not, each page goes to Claude once, comes back with a name and a topic
folder, and the file is renamed and moved.

- **$0 and zero tokens on an idle day.** The poller is a folder listing, not a
  model call.
- **~$0.005 a page** when there is something to file, capped by a daily call
  limit.
- **Nothing is ever deleted**, and anything the model is not confident about
  goes to `_Unsorted` rather than to a guessed folder.

The design idea worth stealing: separate the cheap trigger from the expensive
brain. A scheduled LLM session that wakes hourly to find an empty folder costs
real money to learn nothing, because it reloads its system prompt, tool
definitions and connector schemas before it can look. A cron-shaped thing that
is not an LLM does the same check for free, and you only pay when there is
work.

## Layout

```
  src/Code.gs          the whole implementation, ~200 lines
  test/parse.test.js   the pure parsing path, node --test
```

## How it works

```
  scanner app                Google Drive                Apps Script (free)         Anthropic API
  ───────────                ────────────                ──────────────────         ─────────────
    scan ──── auto-upload ──► Notes/Inbox/
                                   │
                                   │   every 15 min, time-driven trigger
                                   │   ┌──────────────────────────────┐
                                   └──►│ list files in Inbox          │
                                       │                              │
                                       │ empty?  ──► exit   0 tokens  │
                                       │                              │
                                       │ for each file:               │
                                       │   settled >60s?              │
                                       │   size < 20MB?               │
                                       │   ───────────────────────────┼──► POST /v1/messages
                                       │                              │    (base64 PDF + prompt)
                                       │   ◄──────────────────────────┼─── {name, folder,
                                       │                              │     confidence, summary}
                                       │   rename + moveTo(target)    │
                                       │   append row to index Sheet  │
                                       └──────────────────────────────┘
                                   │
                                   ▼
                        Notes/Work/Projects/
                        Notes/Personal/
                        Notes/_Unsorted/     ◄── low confidence, oversized, or 3x failed
```

**Location is the queue.** Anything sitting in `Inbox/` is unprocessed, and
processing ends by moving the file out. That makes the whole thing idempotent
by construction, self-healing after a crashed run, and inspectable by eye — no
watermark timestamp, no per-file marker to read back.

## Setup

### 1. Create the Drive layout

```
  My Drive/
    Notes/
      Inbox/            <- scanner auto-upload target. Work queue. Normally empty
      Work/
        Projects/
        Other/
      Personal/
      _Unsorted/        <- needs a human glance
      index             <- a Google Sheet
```

Copy each folder ID out of its URL: `/folders/<THIS_PART>`.

Pick the taxonomy before you start: the folder names you create here are the
labels the model is allowed to emit, and changing them later means re-filing.
Start with the folders that already have real pages waiting for them. Two or
three is a fine starting point, because `_Unsorted` absorbs whatever does not
fit and a monthly glance at it tells you which folder is actually missing.
Adding a folder later is one new Drive folder and one entry in `TARGETS`;
removing one means moving files by hand, so err towards fewer.

### 2. Create the index Sheet

A Google Sheet named `index`, with the header row:

```
when | status | message | folder | confidence | summary | in_tok | out_tok | usd
```

Every action appends one row. The token columns are what make the running cost
auditable — sum the `usd` column monthly rather than trusting any estimate.

### 3. Install the script

script.google.com -> new project -> paste `src/Code.gs`.

### 4. Script Properties

No configuration lives in this repo, so the file you commit is the file that
runs. Project Settings -> Script Properties.

| Property | Required | Default | Notes |
|---|---|---|---|
| `ANTHROPIC_KEY` | yes | — | From console.anthropic.com |
| `INBOX_ID` | yes | — | Folder ID from the Drive URL |
| `UNSORTED_ID` | yes | — | |
| `INDEX_SHEET_ID` | yes | — | From step 2 |
| `TARGETS` | yes | — | JSON: `{"Work/Projects":"1AbC...","Personal":"1DeF..."}` |
| `DRY_RUN` | no | `true` | Only the exact string `false` goes live |
| `MODEL` | no | `claude-haiku-4-5` | |
| `MIN_CONFIDENCE` | no | `0.6` | Below this, the file goes to `_Unsorted` |
| `DAILY_CALL_CAP` | no | `100` | Runaway-spend backstop |
| `PRICE_IN_PER_MTOK` / `PRICE_OUT_PER_MTOK` | no | `1.0` / `5.0` | Only affects the index's cost column |
| `MAX_MB`, `SETTLE_SECONDS`, `MAX_ATTEMPTS` | no | `20`, `60`, `3` | |

`DRY_RUN` defaults to true and only the exact string `false` disables it, so a
missing or misspelled property cannot silently start moving files.

### 5. Dry run

Put three test pages in `Inbox/` — one clearly matching a folder, one clearly
matching another, one deliberately scribbled. Run `watchInbox` by hand and
accept the Drive and external-request scopes when prompted.

Expect three `DRY` rows in the index, two above `MIN_CONFIDENCE` with sensible
folders and the scribbled one below it. Nothing has moved. Dry run does not
move files, so re-running it re-classifies and re-charges for everything still
in `Inbox/` — run it deliberately, not on a loop.

### 6. Go live

Set `DRY_RUN` to the exact string `false` and run `watchInbox` by hand once
more. Going live is a properties edit, not a code edit, so it is not a commit.

Expect the confident files filed into their folders, the scribbled one in
`_Unsorted`, and three new index rows carrying token counts. `Inbox/` should
now be empty; if a file is still there, read its description for `attempts=`.

### 7. Edge cases, before scheduling

Run these by hand while no trigger exists, so a bad result cannot repeat every
15 minutes.

| Test | Action | Expected |
|---|---|---|
| Oversized | Drop a 40 MB file in `Inbox/` | `PARKED — oversized`, moved to `_Unsorted`, **no API call** |
| Bad key | Set `ANTHROPIC_KEY` to garbage, add one page | Three retries, then `attempts=1` in the file description, file left in `Inbox/`, no crash loop |

Restore the real key afterwards and confirm the parked page processes on the
next manual run.

### 8. Schedule the trigger

Triggers -> Add trigger -> function `watchInbox`, time-driven, every 15
minutes. The system is unattended from here.

### 9. Point a scanner at Inbox

Any scanner app that auto-uploads to Drive works — the iOS Drive app's own
scanner, or a third-party app with a Drive destination. Point it at
`Notes/Inbox`. Auto-upload usually applies only to scans created *after* it is
enabled, so anything already in the app has to be uploaded by hand once.

## What happens when the model is wrong

Two failure classes, deliberately handled differently:

| Reply | Class | Handling |
|---|---|---|
| Prose, truncated JSON, HTTP 5xx | Transient | Throws, attempt counter bumped, 3 strikes then `_Unsorted` |
| Valid JSON naming a folder that does not exist, or `confidence: "0.9"` | Deterministic | Confidence 0, straight to `_Unsorted`, **no retry** |

Retrying a deterministic failure spends money to get the same answer back.
`validateVerdict_` never throws; `JSON.parse` still does.

An unrecognised folder is not trusted, but the model's suggested *name* is
still applied, so the file arrives in `_Unsorted` already readable. A wrong
confident guess costs more than an unsorted file, because an unsorted file is
visible and a misfiled one is not.

Other failure modes and what covers them:

| Failure | Mitigation |
|---|---|
| File still uploading when the trigger fires | `SETTLE_SECONDS` skips files modified in the last 60s |
| Two runs overlap | `LockService.tryLock(0)` |
| Model returns a fenced reply | Fences stripped before parsing |
| API 429 or 5xx | 3 retries, exponential backoff, then the attempt counter |
| Runaway loop | `DAILY_CALL_CAP` |
| Oversized scan | Files over `MAX_MB` parked in `_Unsorted`, before any API call |
| Script crashes mid-batch | Queue-by-location: the next run resumes where it stopped |
| Key leaked | The key lives in Script Properties, never in the source |

## Cost

```
  per page:  ~4,000 input tokens (scanned page image) x $1/MTok  = $0.0040
                200 output tokens                     x $5/MTok  = $0.0010
                                                                   ───────
                                                                   $0.0050

  150 pages/month  ->  $0.75        idle month  ->  $0.00
  daily cap 100 calls  ->  worst case ~$0.50/day
```

Hosting is $0: the Apps Script free quota is roughly 90 minutes of runtime and
20,000 `UrlFetchApp` calls a day, and an idle check uses about a second and no
fetches. Free-tier limits and API prices both change — re-check before relying
on these numbers.

## Naming convention

`YYYY-MM-DD topic.pdf`, e.g. `2026-09-06 project kickoff notes.pdf`. Date first
so alphabetical order is chronological order. Drive appends ` (2)` on
collisions.

## Tests

```bash
npm test
```

`Code.gs` cannot be unit-tested inside Apps Script, but the functions that
decide where a file goes are pure and have no top-level side effects, so the
test evaluates the source in a `vm` context and exercises them directly. That
covers the failure most likely to go unnoticed: a model reply that is prose, or
fenced, or names a folder that does not exist.

## Version control for the deployed script

`clasp` is worth adding only once the thing has classified a page — a login, an
`appsscript.json` and a script id are three new failure modes, and adding them
to the critical path early means debugging the deployment tool and the design
at the same time.

```bash
npm i -g @google/clasp
clasp login
clasp clone <SCRIPT_ID>        # writes .clasp.json, which .gitignore excludes
clasp push
```

From then on `src/Code.gs` is edited here, tested with `npm test`, and pushed.

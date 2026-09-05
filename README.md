# inkling-ai-filer

Scanned pages land in a Google Drive folder. Every 15 minutes a Google Apps
Script lists that folder. If it is empty it exits, having spent nothing. If it
is not, each page goes to Claude once, comes back with a name and a topic
folder, and the file is renamed and moved.

- **$0 and zero tokens on an idle day.** The poller is a folder listing, not a
  model call.
- **~$0.005 a page** when there is something to file — nearer 1p for a
  multi-page document — capped by a daily call limit.
- **Nothing is ever deleted**, and anything the model is not confident about
  goes to `_Unsorted` rather than to a guessed folder.
- **The folder tree is read, not configured.** Rename, move or delete folders
  in Drive and the filer follows, because it discovers destinations on each run
  rather than reading a list you typed once.

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
                                       │ walk the tree once, for the  │
                                       │ list of allowed folders      │
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
                        Notes/Work/Projects/   ◄── discovered, not configured
                        Notes/Personal/
                        Notes/_Unsorted/       ◄── low confidence, ambiguous,
                                                   oversized, or 3x failed
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

Copy **one** ID out of the URL of `Notes/` itself: `/folders/<THIS_PART>`. That
is the root the filer walks; it finds the destination folders underneath on its
own, so there is no list of folder IDs to maintain.

These starting folders are a seed, not a commitment. Start with the two or
three that already have real pages waiting for them and let the rest emerge —
create a folder in Drive and it becomes a destination on the next run, rename
one and filing follows the new name, delete one and it stops being offered.
Nothing here needs editing when you do.

Anything that fits nowhere lands in `_Unsorted` with a note about the folder it
wishes existed, which is how you find out what the taxonomy is missing rather
than guessing on day one.

### 2. Create the index Sheet

A blank Google Sheet named `index`. That is the whole step — the script writes
its own header row the first time it logs anything:

```
when | status | message | folder | confidence | summary | suggested | in_tok | out_tok | usd
```

Every action inserts one row **directly beneath the header**, so the most recent
thing that happened is the first thing you see. The token columns are what make
the running cost auditable — sum the `usd` column monthly rather than trusting
any estimate.

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
| `ROOT_ID` | yes | — | The folder discovery walks beneath, e.g. `Notes/` |
| `DRY_RUN` | no | `true` | Only the exact string `false` goes live |
| `MODEL` | no | `claude-haiku-4-5` | |
| `MIN_CONFIDENCE` | no | `0.6` | Below this, the file goes to `_Unsorted` |
| `DAILY_CALL_CAP` | no | `100` | Runaway-spend backstop |
| `FOLDER_CREATION` | no | `propose` | `propose` records a suggested folder, `off` drops it. Folders are never created automatically |
| `MAX_DEPTH` | no | `3` | Levels below the root that discovery descends |
| `MAX_FOLDERS` | no | `100` | Destination cap. Hitting it is logged, not silent |
| `SAMPLES_PER_FOLDER` | no | `3` | Example filenames shown per folder |
| `NOTE_FILE` | no | `README.md` | Filename read for a folder's description of itself |
| `NOTE_CHARS` | no | `300` | How much of that note reaches the prompt |
| `DATE_FORMAT` | no | `yyyy-mm-dd hh:mm:ss` | Timestamp format in the index |
| `PRICE_IN_PER_MTOK` / `PRICE_OUT_PER_MTOK` | no | `1.0` / `5.0` | Only affects the index's cost column |
| `MAX_MB`, `SETTLE_SECONDS`, `MAX_ATTEMPTS` | no | `20`, `60`, `3` | |

`DRY_RUN` defaults to true and only the exact string `false` disables it, so a
missing or misspelled property cannot silently start moving files.

**A scheduled run refuses to run dry.** A dry run never empties `Inbox`, so on
a 15-minute trigger the same files would be re-classified and re-billed every
cycle until the daily cap — silently, since nothing is obviously wrong. If the
trigger fires while `DRY_RUN` is on, the run throws before spending anything;
Apps Script surfaces that in the execution log and its failure notification.
Manual dry runs are unaffected, which is the only way you should be doing
them.

### 5. Dry run

Put three test pages in `Inbox/` — one clearly matching a folder, one clearly
matching another, one deliberately scribbled. Run `watchInbox` by hand and
accept the Drive and external-request scopes when prompted.

Expect three `DRY` rows in the index, two above `MIN_CONFIDENCE` with sensible
folders and the scribbled one below it. Nothing has moved. Dry run does not
move files, so re-running it re-classifies and re-charges for everything still
in `Inbox/` — run it deliberately, not on a loop.

**Check the folder names in those rows before going live.** They are the tree
as discovered, so if `ROOT_ID` points somewhere unintended you will see it here
— folders you never meant as filing destinations, or none of the ones you did.

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

## The folder tree evolves

The destination list is not configuration. On any run that has work to do, the
filer walks the tree beneath `ROOT_ID` — three levels down, up to 100 folders —
and whatever it finds is what the model is allowed to choose from. So:

- **Create** a folder in Drive and it is a destination on the next run.
- **Rename** one and filing follows, because the tree is re-read every time.
- **Delete** one and it stops being offered. Trashed folders are excluded.
- **Move** one and its path label changes. Files already filed stay put.

The model is shown a couple of example filenames from each folder alongside its
name, so a folder called `Misc` is still legible by its contents. That also
means the tree teaches the model what your folders mean without you having to
name them carefully.

### Telling the model what a folder is for

A folder name is often too small to carry its meaning. `Admin` might mean
council tax, or invoices you have issued, or both — and a folder you
created five minutes ago has no contents to infer it from.

Put a **`README.md`** inside any folder and its text is shown to the model
beside the folder name:

```markdown
# Admin

Council tax, TV licence and DVLA correspondence.
Anything from a bank, broker or DVLA provider.
```

Markdown structure is flattened to a single line, so headings and bullets are
fine — only the words reach the prompt. Entirely optional, per folder: without
one, the folder falls back to its name plus a few example filenames.

The note file never appears in those examples, and a missing, empty or
unreadable one is treated as no note rather than an error — a broken README
must never stop a page being filed.

This is also the better place for scope than the folder name. `Admin` with a
note explaining it covers bills beats a folder called
`Admin-and-Bills`, because you can change what a folder means without
renaming it and re-filing what is already inside.

**No folder is ever created automatically.** When a page fits nowhere, the model
records the folder it thinks should exist in the `suggested` column and the page
goes to `_Unsorted`. Group that column once a month and the folders you actually
need are the ones that keep coming up. See `FOLDER_CREATION`.

### Problems with the tree are reported, not swallowed

Some things a folder tree can do make reliable filing impossible. These append a
`TREE` row to the index, once — repeated only if the problem changes, so a tree
you have decided to leave alone does not nag every fifteen minutes.

| Row | Meaning | What to do |
|---|---|---|
| `DUPLICATE` | Two or more folders whose names mean the same thing, e.g. `Admin/Insurance` and `Admin/Insurances`. Case, accents, punctuation and a trailing plural are ignored when comparing | Merge them, or accept it. Nothing is filed differently because of this row |
| `SKIPPED` | A folder name contains `/`, which would re-parse as two levels | Rename it. Until then it is not a destination |
| `CAPPED` | More than `MAX_FOLDERS` folders exist, so some are not destinations | Raise the cap or prune the tree |

The same name under different parents — `Work/Admin` and `Personal/Admin` — is
reported too. That is often deliberate, and dismissing it costs one glance.

### When the model cannot choose

If two folders fit a page equally well, the model is told to say so rather than
pick one. Those pages get an `AMBIGUOUS` row naming both candidates and go to
`_Unsorted` with their suggested name applied.

This is the case duplicate folders actually cause, and it is the reason the
report above exists: an arbitrary pick between two plausible folders is the
misfile that is hardest to notice later.

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
| `ROOT_ID` points too high, e.g. at My Drive | The discovered set is listed in the dry run before anything moves |
| Two folders mean the same thing | Reported as `DUPLICATE`; pages that cannot be placed become `AMBIGUOUS` rather than a coin flip |
| Folder renamed mid-batch | One page at most goes to `_Unsorted`, which is the designed handling for an unknown label |

## Index statuses

| Status | Meaning |
|---|---|
| `FILED` | Renamed and moved into a folder |
| `UNSORTED` | Below `MIN_CONFIDENCE`, or an unrecognised folder. Name still applied |
| `AMBIGUOUS` | Two or more folders fit equally. Both named in the message |
| `TREE` | A problem with the folder structure. See above |
| `PARKED` | Oversized, or failed `MAX_ATTEMPTS` times |
| `RETRY` | A transient failure; the file stays in `Inbox/` |
| `CAP` | `DAILY_CALL_CAP` reached; the run stopped |
| `DRY` | `DRY_RUN` is on. The message carries what would have happened |

## Cost

```
  per page:  ~4,000 input tokens (scanned page image) x $1/MTok  = $0.0040
                200 output tokens                     x $5/MTok  = $0.0010
                                                                   ───────
                                                                   $0.0050
```

**Budget per document, not per page.** That figure is per page and holds up in
practice, but real paperwork is rarely one page. Measured on live runs: a
one-page letter came to ~4,200 input tokens ($0.005), while a
multi-page bill came to ~9,500 ($0.010). Input tokens dominate
entirely — output is a hundred-odd tokens either way.

```
  150 documents/month  ->  ~$1.50      idle month  ->  $0.00
  daily cap 100 calls  ->  worst case ~$1/day
```

The folder list, the folder notes and the example filenames are all sent on
every call, so a large taxonomy raises the per-page cost — a few hundred extra
tokens for a handful of folders, more like 2,000 at the 100-folder cap.

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

## Licence

MIT — see `LICENSE`.

# inkling-ai-filer

Scan a page on your phone. A few minutes later it is sitting in the right
folder in Google Drive, under a name that tells you what it is.

That is the whole product. There is no app to open and no interface. A Google
Apps Script watches one Drive folder; when something lands in it, the page goes
to Claude once, comes back with a name and a destination, and gets filed. On
days when you scan nothing, nothing happens and nothing is spent.

It is deliberately small — about 500 lines of one file — and it is built so
that the parts most likely to go wrong fail visibly rather than quietly.

## Why it's a Google Apps Script

The obvious way to build this is to give an AI agent a schedule: wake up every
hour, look in the folder, file whatever is there. That works, and it is
expensive in a way that is easy to miss. An agent starting a fresh session has
to read its instructions, its tool definitions and its connector schemas before
it can do anything at all — including before it can find out the folder is
empty. Most hours it will be empty. You end up paying a monthly subscription's
worth to be told "nothing new" several hundred times.

So the two jobs are kept apart. Checking whether there is work is cheap and
constant. Doing the work is expensive and rare. The thing that wakes up every
fifteen minutes is a folder listing, which costs nothing, and the model is only
ever invoked once there is a page in front of it. An idle day costs nothing at
all; a busy one costs about a penny a document.

That leaves the question of what should do the waking up, and Apps Script wins
mostly by already being there. It is free. It can already read your Drive, so
there is no OAuth flow to build, no service account, no key to rotate. It has a
scheduler built in, and somewhere to keep the API key. And it runs on Google's
machines, so nothing on your desk has to be switched on for your scans to get
filed.

The alternatives all cost you something. A cron job on your laptop is free too,
but it only files things while the laptop is awake. A small cloud function
would work, but then you are building the Drive authentication that Apps Script
hands you for nothing.

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
                                       │   log a row to the index     │
                                       └──────────────────────────────┘
                                   │
                                   ▼
                        Notes/Invoices/        ◄── discovered, not configured
                        Notes/Contracts/
                        Notes/_Unsorted/      ◄── low confidence, ambiguous,
                                                  oversized, or 3x failed
```

**The folder is the queue.** Anything sitting in `Inbox/` is unprocessed, and
processing ends by moving the file out. Nothing tracks what has been done
already — no watermark timestamp, no marker written into each file — because
the location says it. That one choice is why the system is idempotent, why it
recovers from a crash halfway through a batch without any cleanup, and why you
can tell at a glance whether it is behind.

## Setting it up

Half an hour, most of it waiting for Drive.

**1. Make the folders.** In Drive, create a folder — `Notes` is as good a name
as any — and inside it two folders that are machinery rather than filing:
`Inbox`, where scans land, and `_Unsorted`, where anything the filer cannot
place goes. Then create two or three topic folders for the paperwork you
actually have.

Do not agonise over the taxonomy. It is a seed, not a commitment: you can add,
rename, move and delete folders later and the filer just follows, because it
reads the tree fresh on every run rather than a list you typed once. Starting
with too few is the cheaper mistake — `_Unsorted` will tell you what is
missing.

Copy one ID out of the URL of `Notes` itself, the part after `/folders/`. The
filer finds everything underneath on its own, so that is the only folder ID you
will need besides the two machinery folders.

**2. Make the index.** A blank Google Sheet, in the same folder. That is the
entire step — the script writes its own header the first time it logs
something, and every action after that is inserted at the top, so the most
recent thing is the first thing you see.

The index is worth more than it sounds. It is an audit log, a running cost
meter, and — because every row carries a one-line summary of the document — a
searchable table of your paperwork that builds itself.

**3. Install the script.** Go to [script.google.com](https://script.google.com),
make a new project, delete the stub it gives you, and paste in `src/Code.gs`.

**4. Fill in five settings.** Project Settings → Script Properties. You need
`ROOT_ID`, `INBOX_ID`, `UNSORTED_ID` and `INDEX_SHEET_ID` — the IDs from steps
1 and 2 — plus `ANTHROPIC_KEY` from
[console.anthropic.com](https://console.anthropic.com), which needs a few
dollars of credit on it. Everything else has a sensible default; the full list
is in [Miscellaneous](#every-setting).

No configuration lives in this repo, which is what makes the committed file the
file that runs.

**5. Do a dry run.** Put two or three pages in `Inbox`, wait a minute, then run
`watchInbox` by hand from the editor and accept the permissions when asked.

Nothing moves. You get one row per page saying what *would* have happened.
Read them: the folder names in those rows are the tree as the script discovered
it, so if `ROOT_ID` is pointing somewhere unintended, this is where you find
out — before anything has been touched.

A dry run still calls the model, so it costs the same as a real one. It also
does not empty `Inbox`, which means re-running it re-classifies and re-charges
for everything still sitting there. Run it deliberately.

**6. Go live.** Add a `DRY_RUN` property set to the exact string `false`, and
run `watchInbox` once more by hand. This time the files are renamed and moved,
and `Inbox` should end up empty. Going live is a settings change, not a code
change.

**7. Try to break it, while you still can.** Two minutes, and worth doing
before there is a trigger that could repeat a bad result every quarter of an
hour. Drop a 40 MB file in `Inbox` — it should be parked in `_Unsorted` with
no API call at all, since the size check runs before anything expensive. Then
set the API key to nonsense and add a page: expect three retries, a note in the
file's description, and the file still sitting safely in `Inbox`. Put the real
key back and it files on the next run.

**8. Schedule it.** Triggers → Add Trigger → `watchInbox`, time-driven, every
fifteen minutes. Polling more often costs nothing extra — an empty check is
free — so the interval is a latency choice, not a cost one.

**9. Point a scanner at `Inbox`.** Any scanner app that can auto-upload to
Drive will do, including the Drive app's own. Auto-upload usually applies only
to scans made after you switch it on, so anything already in the app needs
uploading by hand once.

## Living with it

### The tree is yours to reorganise

The list of destinations is not configuration. On every run that has work to
do, the filer walks the tree beneath your root folder and whatever it finds is
what the model may choose from. Create a folder and it is a destination on the
next run. Rename one and filing follows the new name. Delete one and it stops
being offered. Move one and its label changes. None of that requires touching
the script or its settings.

To help the model understand a folder, it is shown a couple of the filenames
already inside it — so a folder called `Misc` is still legible by its contents.

### Telling the model what a folder is for

A folder name is often too small to carry its meaning. `Admin` might be bank
statements, or invoices you have issued, or both, and a folder you made five
minutes ago has no contents to infer it from.

Put a `README.md` inside any folder and its text is shown to the model beside
the folder name:

```markdown
# Admin

Council tax, TV licence and DVLA correspondence.
Anything from a bank, broker or DVLA provider.
```

Optional, per folder, and markdown structure is flattened away so only the
words reach the model. This is a better home for scope than the folder name is:
you can change what a folder means without renaming it and re-filing everything
already inside.

### It will not invent folders

When a page fits nowhere, the model records the folder it thinks *should* exist
and the page goes to `_Unsorted`. It never creates anything.

That is deliberate, and it is the decision most likely to be second-guessed by
someone who has not watched it go wrong. A model that can create folders
produces sprawl — `Insurance` in March, `Insurance renewals` in May, `Home
insurance` in July, each defensible on the day. Sprawl is worse than a full
`_Unsorted` because it is invisible: the tree still looks organised, and the
duplicates become the context for the next decision.

So the suggestions accumulate in a column instead. Read them once a month; the
folder you actually need is the one that keeps coming up. Then make it by hand,
in five seconds, and the filer picks it up on the next run.

### When it is not sure

Anything the model is not confident about goes to `_Unsorted` rather than to a
guessed folder, and if two folders fit a page equally well the model is told to
say so rather than pick one. A wrong confident guess costs more than an
unsorted file, because the unsorted file is visible and the misfiled one is
not.

The filer also notices when your tree has become hard to file into — two
folders whose names mean the same thing, a folder name containing a slash, more
folders than it will consider — and says so in the index. Once, not every
fifteen minutes.

### When something goes wrong

Failures are sorted into two kinds, because they deserve opposite treatment.
Transient ones — a network blip, a truncated reply, a 500 — are retried, three
times, and then the file is parked with a counter in its description. Permanent
ones — a well-formed reply naming a folder that does not exist — are *not*
retried, because spending another API call to be told the same thing twice is
just spending.

Nothing is ever deleted, and Drive keeps version history, so the worst outcome
is a file in the wrong place that you drag back.

---

# Miscellaneous

Reference material. Nothing here is needed to use the thing.

## Every setting

All configuration is Script Properties. Only the first five are required.

| Property | Default | Notes |
|---|---|---|
| `ANTHROPIC_KEY` | — | From console.anthropic.com |
| `ROOT_ID` | — | The folder discovery walks beneath |
| `INBOX_ID` | — | Where scans land |
| `UNSORTED_ID` | — | Where the unplaceable go |
| `INDEX_SHEET_ID` | — | The log Sheet |
| `DRY_RUN` | `true` | Only the exact string `false` goes live |
| `MODEL` | `claude-haiku-4-5` | |
| `MIN_CONFIDENCE` | `0.6` | Below this, the file goes to `_Unsorted` |
| `DAILY_CALL_CAP` | `100` | Runaway-spend backstop |
| `FOLDER_CREATION` | `propose` | `propose` records a suggestion; `off` drops it. Folders are never created |
| `MAX_DEPTH` | `3` | Levels below the root that discovery descends |
| `MAX_FOLDERS` | `100` | Destination cap. Hitting it is logged, not silent |
| `SAMPLES_PER_FOLDER` | `3` | Example filenames shown per folder |
| `NOTE_FILE` | `README.md` | The file read for a folder's description of itself |
| `NOTE_CHARS` | `300` | How much of that note reaches the prompt |
| `DATE_FORMAT` | `yyyy-mm-dd hh:mm:ss` | Timestamp format in the index |
| `MAX_MB` | `20` | Larger files are parked without an API call |
| `SETTLE_SECONDS` | `60` | Files touched more recently are assumed to be still uploading |
| `MAX_ATTEMPTS` | `3` | Strikes before a file is parked |
| `PRICE_IN_PER_MTOK` / `PRICE_OUT_PER_MTOK` | `1.0` / `5.0` | Only affects the index's cost column |

`DRY_RUN` defaults to true and only the exact string `false` disables it, so a
missing or misspelled property cannot start moving files.

**A scheduled run refuses to run dry.** A dry run never empties `Inbox`, so on
a trigger it would re-classify and re-bill the same files every cycle, silently.
If the trigger fires while `DRY_RUN` is on, the run throws before spending
anything. Manual dry runs are unaffected, which is the only way you should be
doing them.

## Index statuses

| Status | Meaning |
|---|---|
| `FILED` | Renamed and moved into a folder |
| `UNSORTED` | Below `MIN_CONFIDENCE`, or an unrecognised folder. The name is still applied |
| `AMBIGUOUS` | Two or more folders fit equally. Both named in the message |
| `TREE` | A problem with the folder structure |
| `PARKED` | Oversized, or failed `MAX_ATTEMPTS` times |
| `RETRY` | A transient failure; the file stays in `Inbox` |
| `CAP` | `DAILY_CALL_CAP` reached; the run stopped |
| `DRY` | `DRY_RUN` is on. The message says what would have happened |

Rows that were not filed carry a short explanation in the message column —
whether the model declined to choose, named a folder that does not exist, or
offered a suggestion that was rejected. Those three look identical in the
folder column and need telling apart.

`TREE` rows come in three kinds: `DUPLICATE` for two folders whose names mean
the same thing once case, accents, punctuation and a trailing plural are
ignored; `SKIPPED` for a folder name containing `/`, which would re-parse as
two levels; and `CAPPED` for exceeding `MAX_FOLDERS`. The same name under two
different parents is reported too — often deliberate, and dismissing it costs
one glance.

## Failure modes

| Failure | Mitigation |
|---|---|
| File still uploading when the trigger fires | `SETTLE_SECONDS` skips recently modified files |
| Two runs overlap | `LockService.tryLock(0)` |
| Model returns a fenced reply | Fences stripped before parsing |
| Model returns prose | Parse throws, counts as an attempt, 3 strikes to `_Unsorted` |
| Model names a folder that does not exist | Confidence 0, no retry, and the name is kept as a suggestion |
| API 429 or 5xx | 3 retries, exponential backoff, then the attempt counter |
| Runaway loop | `DAILY_CALL_CAP` |
| Oversized scan | Parked before any API call |
| Script crashes mid-batch | The next run resumes where it stopped, because location is the queue |
| Key leaked | The key lives in Script Properties, never in the source |
| `ROOT_ID` points too high | The discovered set is listed in the dry run before anything moves |
| Two folders mean the same thing | Reported as `DUPLICATE`; unplaceable pages become `AMBIGUOUS` rather than a coin flip |
| Folder renamed mid-batch | At most one page goes to `_Unsorted` |

## What it costs

```
  per page:  ~4,000 input tokens (scanned page image) x $1/MTok  = $0.0040
                200 output tokens                     x $5/MTok  = $0.0010
                                                                   ───────
                                                                   $0.0050
```

Budget per document rather than per page: that figure holds up, but real
paperwork is rarely one page. Measured on live runs, a one-page letter came
to about 4,200 input tokens and a multi-page bill to about 9,500 —
half a cent and a cent respectively. Input dominates completely; output is a
hundred-odd tokens either way.

```
  150 documents/month  ->  ~$1.50      idle month  ->  $0.00
  daily cap 100 calls  ->  worst case ~$1/day
```

The folder list, the folder notes and the example filenames are sent on every
call, so a large tree raises the per-page cost — a few hundred tokens for a
handful of folders, nearer 2,000 at the cap.

Hosting is free. The Apps Script quota is roughly 90 minutes of runtime and
20,000 outbound fetches a day; an idle check takes about a second and no
fetches, so ninety-six of them a day is under two minutes. Free-tier limits and
API prices both change — re-check before relying on any of this.

## Naming

`YYYY-MM-DD topic.pdf`, so alphabetical order is chronological order. Drive
appends ` (2)` on collisions.

## Tests

```bash
npm test
```

`Code.gs` cannot be unit-tested inside Apps Script, but the functions that
decide where a file goes are pure and the file has no top-level statements, so
the suite evaluates the source in a `vm` context and calls them directly. It
covers the failures most likely to go unnoticed: a reply that is prose, or
fenced, or names a folder that does not exist; a suggestion that should have
been rejected; two folder names that mean the same thing.

Anything touching Drive, Sheets or the API is not covered, and is what the dry
run in step 5 is for.

## Version control for the deployed script

`clasp` is worth adding only once the thing has filed a page — a login, an
`appsscript.json` and a script id are three new ways to fail, and adding them
early means debugging the deployment tool and the design at the same time.

```bash
npm i -g @google/clasp
clasp login
clasp clone <SCRIPT_ID>        # writes .clasp.json, which .gitignore excludes
clasp push
```

## Licence

MIT — see `LICENSE`.

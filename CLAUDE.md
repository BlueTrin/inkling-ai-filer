# inkling-ai-filer — working notes for Claude

## What this is

A Google Apps Script that watches a Drive folder, sends each new scanned page
to Claude once, and files it under a name the model chose. The design
constraint that shaped everything is **zero cost and zero tokens on days when
nothing is scanned**. That is why the poller is a time-driven Apps Script
trigger and not a scheduled Claude session.

Destination folders are discovered from the Drive tree on each run that has
work, not configured, so the taxonomy can be reorganised in Drive without
touching anything here.

## Start here

`README.md` is the design record and the build sequence, in order. `src/Code.gs`
is about 200 lines and is the whole implementation.

## Invariants — do not break these without saying so

- **`src/Code.gs` is the only copy of the implementation.** Documentation
  excerpts it and must never re-embed the whole file. Two copies drift.
- **No configuration in the source.** Every value is a Script Property, read
  in `cfg_()`. This is what makes the committed file the file that runs. Do not
  reintroduce a `CFG` literal with folder IDs in it.
- **Nothing account-specific is ever committed.** No folder IDs, sheet IDs,
  script ids, API keys, or a real taxonomy. Examples in code, tests and docs
  stay generic.
- **The tree walk happens only after the inbox is known to be non-empty**, and
  once per run rather than once per file. Reversing that order is what would
  quietly break the zero-cost-when-idle guarantee, and nothing would fail
  visibly when it did.
- **The script never creates a folder.** `FOLDER_CREATION` has no working
  `auto` mode yet; suggestions are recorded and read by a human. The failure
  this avoids is taxonomy sprawl, which is invisible and compounds — see the
  design note before implementing `auto`.
- **An ambiguous verdict is never resolved by picking one.** If the model names
  two folders it could not choose between, the page goes to `_Unsorted` with an
  `AMBIGUOUS` row. Arbitrary tie-breaking is the misfile that is hardest to
  notice.
- **Tree-level problems are reported once, not every run.** `reportTreeProblems_`
  hashes the report and stays quiet until it changes. Without that it would log
  the same duplicate-folder row every fifteen minutes forever.
- **`DRY_RUN` defaults to true** and only the exact string `false` disables it.
  A missing or misspelled property must never start moving a user's files.
- **Trailing underscore marks a private helper.** Apps Script only lists
  underscore-free functions in the Run dropdown and only those can be bound to a
  trigger, so `watchInbox` is the single public name. Keep it that way.
- **`Code.gs` has no top-level statements** other than function declarations.
  `test/parse.test.js` evaluates the file in a `vm` context; a top-level
  `PropertiesService` call would break every test.
- **Transient failures retry, deterministic ones do not.** `JSON.parse` throws
  and goes through `bumpAttempts_`; `validateVerdict_` never throws and returns
  confidence 0. An invented folder name is not worth three API calls.

## Testing

```bash
npm test        # node --test, no dependencies
```

The tests cover the pure path only: fence stripping, verdict validation,
suggestion sanitising, duplicate detection, filename safety. That is deliberate — it is the code most likely to fail
silently, and the only part testable outside Apps Script. Anything touching
`DriveApp`, `SpreadsheetApp` or `UrlFetchApp` is verified by the manual setup
steps in the README instead.

## Open decisions

1. **Per-folder confidence.** `MIN_CONFIDENCE` is global. A misfiled insurance
   renewal costs more than a misfiled shopping list, so the threshold arguably
   belongs per folder rather than per script.
2. **The `auto` creation threshold.** Deliberately unset: pick it after a month
   of real `suggested` values rather than guessing now.
3. **`_Unsorted` notification.** A `MailApp` nudge, or is a periodic glance
   enough?
4. **Retention.** Does anything ever leave Drive, or does the archive just grow?

## Conventions

British spelling in prose. The documentation is a design record, not a
tutorial: state the decision and the rejected alternatives, skip the
encouragement.

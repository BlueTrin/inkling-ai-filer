# inkling-ai-filer — working notes for Claude

## What this is

A Google Apps Script that watches a Drive folder, sends each new scanned page
to Claude once, and files it under a name the model chose. The design
constraint that shaped everything is **zero cost and zero tokens on days when
nothing is scanned**. That is why the poller is a time-driven Apps Script
trigger and not a scheduled Claude session.

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
npm test        # node --test, 23 assertions, no dependencies
```

The tests cover the pure path only: fence stripping, verdict validation,
filename safety. That is deliberate — it is the code most likely to fail
silently, and the only part testable outside Apps Script. Anything touching
`DriveApp`, `SpreadsheetApp` or `UrlFetchApp` is verified by the manual setup
steps in the README instead.

## Open decisions

1. **Scope.** The prompt says "handwritten or printed", but the worked example
   taxonomy is note-shaped. If household paperwork is in scope for a given
   deployment, the taxonomy needs folders for it, and `MIN_CONFIDENCE` probably
   needs to be higher for those than the global 0.6 — a misfiled insurance
   renewal costs more than a misfiled shopping list.
2. **LICENSE.** Absent, and needed before this is useful to anyone else.
3. **`_Unsorted` notification.** A `MailApp` nudge, or is a periodic glance
   enough?
4. **Retention.** Does anything ever leave Drive, or does the archive just grow?

## Conventions

British spelling in prose. The documentation is a design record, not a
tutorial: state the decision and the rejected alternatives, skip the
encouragement.

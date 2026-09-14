# Lane S's code-line unit change — evaluation, 2026-09-14

Lane S (`brandonpayton/lane-s-setuid-integrity`) carries two unmerged commits:

- `19bb692c4` **Build: Budget code lines, not comment lines** — changes the
  surface budget's `lineCount` measure so blank and comment lines stop
  counting, and rebaselines every line-count ceiling, slack and target into
  the new unit.
- `ff1fa23e9` **Build: Mark lane S deferred** — reconciles
  `docs/surface-budget.json` (`status: "open"`) with the master plan
  (DEFERRED by the maintainer 2026-09-12), and rewrites the lane's closure
  statement to say a digest is **verified**, not merely emitted.

## Why this needs a decision rather than a merge

The second commit is a straight record correction and is not in question.

The first changes the campaign's **unit of account** for every line-count
gate. Its own commit message states the motivation plainly: lane S's fix was
"50 lines of code and 48 lines of comment, and only the comments were
arguable." A lane changing the instrument because its own change did not fit
is adjacent to the standing rule *never raise a ceiling to make a check
pass*, even though this lowers every number rather than raising it.

## What was measured, 2026-09-14

Lane S's `countCodeLines` was extracted verbatim and run against the current
campaign branch (`brandonpayton/rust-first-abi44-reconcile`), not lane S's
older tree:

| surface | whole | code | comment share | lane S ceiling |
|---|---|---|---|---|
| `forkTypeScript` | 24726 | 19804 | 19.9% | 19804 |
| `workerMainTypeScript` | 7499 | 5958 | 20.5% | 5958 |
| `sffsTypeScript` | 3716 | 3047 | 18.0% | 3047 |
| `memoryFsTypeScript` | 8501 | 7473 | 12.1% | 7473 |
| `kernelWorkerTypeScript` | 32718 | 26495 | 19.0% | 26495 |
| `kernelHostImportTypeScript` | 4774 | 3822 | 19.9% | 3822 |
| `hostKernelPlumbingTypeScript` | 5689 | **4575** | 19.6% | **4734** |

Three readings follow.

**It is not a selective loosening.** The comment share is 12–20% across all
seven surfaces. No surface gains disproportionate room, so the rebaseline is
a proportional conversion rather than headroom granted where a lane wanted
it.

**Six ceilings are exact.** They equal the file as it stands with no padding,
so the ratchet bites at the same place in the new unit.

**One ceiling would give back a banked reduction.** Lane S branched from
`002149196`, before lane L landed. `hostKernelPlumbingTypeScript` has since
fallen to 4575 code lines. Merging lane S's 4734 unchanged would hand back
**159 code lines** that lane L already banked. Any merge of `19bb692c4` must
resolve that ceiling to **4575**.

**It also removes a gaming vector.** Under `wc -l`, deleting comments banked
a reduction that cost a second host nothing. Under the new measure it banks
nothing, which is the honest result.

## The counter itself

String- and block-comment-aware, and it refuses to return a count for text
ending inside an unterminated block comment — the failure mode that would
otherwise look exactly like a large reduction. Lane S reports seven
perturbations, each run and each failing (H-2). Those were read, not re-run
here.

One residual: a line consisting only of a multi-line template literal's text
counts as code. Lane S names this and argues it is right, since the text is
content the file carries. Agreed, and it is the conservative direction.

## The merge conflict

Small: one hunk in `docs/surface-budget.json`, one in
`host/test/surface-budget.test.ts`, both against lane L's landed changes.

## What this did not establish

Whether the maintainer wants the campaign's unit of account changed at all.
Every census and derived target in the master plan — lane L's 3600, lane K's
12000, lane I's 1200 — was derived in whole lines. Lane S scales them by each
surface's comment ratio, which preserves them in real terms but means the
plan's prose figures and the gate's figures no longer read the same.

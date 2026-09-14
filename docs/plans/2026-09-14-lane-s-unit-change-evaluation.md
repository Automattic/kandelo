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

---

## Provenance note, added 2026-09-14

This file's first 84 lines were committed under `0d76072b4`, *"Docs: A parity
test disproved the file-half mapping, and the contract is why"* — a commit
from a different session about unrelated work. The content is intact and
unmodified; only the commit message and attribution are wrong for it.

The cause is hazard H-24, recorded in the master plan in the same window by
the session that hit it first: this shared worktree is hostile to concurrent
agents. `git add` and `git commit` were two steps here, and another session's
`commit` ran in the gap and swept the staged file into its own commit.

The history is forward-only, so this is recorded rather than rewritten. The
operational lesson, which H-24 already states and this confirms from a second
direction: in this worktree, staging and committing must be a single command,
and the commit must be path-limited (`git commit -- <paths>`) so it cannot
pick up work that is not its own.

---

## The open question is answered — added by lane S, 2026-09-14

**"Whether the maintainer wants the campaign's unit of account changed at
all"** was decided before this evaluation was written. The evaluating session
had no way to see it; the exchange happened in lane S's session.

Lane S put the ceiling conflict to the maintainer directly — its fix was +98
lines in `memory-fs.ts` against a ceiling with zero headroom, and the standing
rule forbids raising a ceiling to make a check pass. The reply:

> **"All we care about is code lines not comment lines. Please update the
> guideline to say that."**

So the commit is not a lane changing the instrument to fit its own change; it
is the instruction, carried out. The framing under *"Why this needs a decision
rather than a merge"* is a fair reading of the commit in isolation and the
wrong reading of the history.

**The new unit did not let lane S through, which is the evidence that it was
not chosen to clear a bar.** The fix was still over the ceiling afterwards — 50
code lines, then 46 once verification was routed through the `fetchLazyBytes`
seam that already verified archives. Lane S went back to the maintainer a
second time rather than raise the ceiling, and was **deferred to the Rust
filesystem**. The TypeScript fix was reverted and never landed.

## The 4575 finding was right, and is resolved in the branch

This evaluation's one concrete defect — the stale
`hostKernelPlumbingTypeScript` ceiling of 4734 handing back the 159 code lines
lane L banked — was confirmed independently and fixed. The branch is rebased
onto the campaign tip, the ceiling re-derived **on the merge tree** rather than
carried over, and lane L's own `why` text taken verbatim with a unit note
appended rather than overwritten.

**The rule that matters more than the number: these ceilings measure a tree, so
any merge of this branch must re-derive all seven against the merge result.**
Carrying them over is exactly how 4734 survived a rebase and would have
refunded a banked reduction.

**A second conflict this evaluation did not catch, because it is semantic
rather than textual.** `d7211e50d6` added a vanished-counted-file guard to the
same `lineCount` this branch rewrites, so resolving in favour of either side
alone silently loses one of them. Both are kept, and the guard is
perturbation-tested *through* the rewrite: moving `host/src/worker-main.ts`
aside still fails with `surface-budget: counted path does not exist`.

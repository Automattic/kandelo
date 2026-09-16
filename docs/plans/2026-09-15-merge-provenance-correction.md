# Merge provenance correction — lane Y/V third tranche, 2026-09-15

Two commits on `brandonpayton/epoll-kernel-route` carry messages that do not
describe what they contain. Both are published, so this records the truth
forward rather than rewriting them.

## What each commit actually is

| commit | message says | what it is |
|---|---|---|
| `4ddfac2e2` | *"Docs: Handoff — host_fetch_deferred should carry the descriptor"* | **The merge.** Two parents, `3081089ff` (campaign tip) and `5aef74226` (lane Y tip), 34 files, +877/−241. |
| `ee707c8ca` | *"Merge lane Y/V third tranche, and take its repoint over B41's retirement"* | **Not a merge.** One parent, one file, +42/−42 — the surface-budget re-derivation that belongs with the merge. |

## How it happened

H-24, and this is its third occurrence today. The merge was resolved and
staged; the surface budget then has to run before committing, which takes
about 75 seconds. Inside that window another session ran `git commit`, which
consumed the staged `MERGE_HEAD` and produced the merge commit under its own
docs message. The later commit then carried the merge's intended message but
only the budget change.

The mitigation H-24 already prescribes — write, add and commit in ONE shell
invocation — does not cover this case, because a *merge* cannot be collapsed
that way: the resolution has to exist in the tree before the gate can run
against it. **For a merge in a shared worktree the window is irreducible**
unless the merge is done in a private worktree and fast-forwarded in, which is
what the maintainer suggested earlier and what should have been done here.

## Why this is not fixed by amending

`brandonpayton/epoll-kernel-route` is PR #1350's head. Both commits are
pushed, other sessions have built on them, and the standing constraint for
this branch is forward-only: never amend, never force-push. Rewriting two
published commits to fix their subject lines would trade a documentation
defect for a history defect.

## What the merge actually did

Recorded here because `4ddfac2e2`'s message does not:

28 commits of lane Y/V's third tranche. The single conflict was
`perturb/browser-worker-node-globals.json`, deleted here under B41's
retirement and modified on the lane, which repointed its three trials into
`host/src/process-lifecycle.ts` — a file genuinely in the browser worker's
value-import graph. **The resolution took the lane's repoint over the
retirement**, a deliberate departure from the recorded B41 decision, on the
evidence that the repointed trials run 3 trials, 0 survived, which is more
coverage than retirement plus the barrel trial.

`hostVfsTypeScript` banked 8819 → 8801. Every other line-count ceiling was
re-derived against the merge result and was already exact. The code-line
unit, the `sffsModuleEntryPoints` contingency and both slack fixes were
carried through and checked rather than assumed.

Validation at the time: surface budget and citation gates **145 passing**;
`hostVfsTypeScript` perturbed to 8800 and observed failing. The browser suite
and the tranche's other new trials were not run.

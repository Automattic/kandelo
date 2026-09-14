# Lane X — process and exec

Paste everything below into a fresh agent.

---

You are working **lane X (process and exec)** of the Kandelo Rust-first
campaign. Always call it by its label, not just the letter.

## Set up your own worktree first

    cd /Users/brandon/kandelo-abi44-reconcile
    git worktree add /Users/brandon/kandelo-lane-x \
        -b brandonpayton/lane-x-process-exec brandonpayton/rust-first-abi44-reconcile
    cd /Users/brandon/kandelo-lane-x

Work **only** in that worktree, on that branch. Never commit on
`brandonpayton/rust-first-abi44-reconcile` or `brandonpayton/epoll-kernel-route`,
and never merge PR #1350 — the maintainer is the sole merger.

## Your gate

`parseShebangReferences` **12 → 0** — references to `parseShebang` in
`host/src`.

## End state

The kernel decides what a spawn would run — script or binary, and which
interpreter — and `parseShebang` no longer exists in the host. `posix_spawn`
and `execve` give the **same answer for the same file**, which they do not
today. That divergence is the defect; the line count is just how it is
measured.

## Where shebang belongs — already settled, do not relitigate

`#!` is a **kernel** feature on Linux, the BSDs and macOS: `execve(2)` itself
substitutes the interpreter. **POSIX does not specify `#!` at all.** What POSIX
requires is that the libc `execlp`/`execvp` family fall back to `sh` when
`execve` returns `[ENOEXEC]`.

The host floor is worker launch and the syscall channel — that is lane F's
floor, shared rather than duplicated. **Nothing about interpreting an
executable's format is host work.** The kernel already owns `execve`.

## The collision you must manage

Every current `parseShebang` call site is in **one file**:
`host/src/process-lifecycle.ts`. That is the shared implementation lane E
credits, and it is the file lane F (fork inversion) is likeliest to brush.

Before you start, check whether lane F is touching it, and say plainly in your
first report that you are holding it. If lane F needs it, yield and sequence
after their next merge rather than racing. This lane is 2–5 days; it is not
worth a merge conflict in the campaign's most contended file.

## The blocker, and a time box

B10's direction is settled; its blocker is a panic with a precise bisect.
**Time-box the bisect to one day.** If it has not fallen out by then, hand the
bisect back with what you learned rather than letting a 2-day lane run five.
Say so explicitly — that is a report, not a deferral.

## Non-negotiables

- Run `cd host && npx vitest run test/surface-budget.test.ts` **before every
  commit** and read its verdict lines. Use the `host/` form; the repo-root
  form fetches an unpinned vitest.
- **Never raise a ceiling to make a check pass.** Bank reductions by lowering it.
- **Perturb every new guard until you have seen it fail** and quote the failure
  text.
- A POSIX gap stays visible as a gap. Do not turn an unsupported path into
  silent success; return the correct failure mode.
- Process state is authoritative — `fork`, `exec`, `posix_spawn`, `waitpid`,
  fd tables and zombie/reaping state must stay coherent across transitions.
- ABI stays at **44**. No `ABI_VERSION` bumps.
- **Deferrals are the maintainer's call.** Land the safe part, then stop and
  argue it — what, why, cost, follow-up — and ask. Never self-defer.

## Provisioning gotchas, learned the hard way 2026-09-14

- Export `CARGO_NET_OFFLINE=true` for `./run.sh setup`.
- **Gate on exit codes, never on piped output.**
- Syscall/process changes are not validated by unit tests alone. Consider the
  conformance suites under `tests/posix/` and `tests/libc/`.

## When you have something to merge

Write a merge handoff into the master plan naming: the exact SHA and branch,
the conflicts you hit and the resolution you **tested**, the suites you ran
with their numbers, and what you did **not** establish.

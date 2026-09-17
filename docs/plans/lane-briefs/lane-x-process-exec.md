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

`parseShebangReferences` **2 → 0** — `grep -ro 'parseShebang' host/src | wc -l`.

**Not 12.** That figure appeared in earlier plan text and in the first version
of this brief. The ceiling was banked 12 -> 2 on 2026-09-15 after measuring:
most references went when B10's kernel-side work landed, and only the two in
`host/src/process-lifecycle.ts` survive. The old slack EQUALLED the ceiling,
which disables the banking test by construction — `actual > ceiling - slack - 1`
reduces to `actual > -1` — so the surface could not have caught its own
reduction. Slack is now 1. Read gates from `docs/surface-budget.json`, never
from prose, including this brief.

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

## The blocker — the bisect is DONE, do not repeat it

A previous agent finished this. Start from its result, not from scratch.

**What is already banked in the branch:** `exec_target::probe`, its export, the
ABI snapshot entry and six tests, all with **no production caller** — inert, so
they cannot fault anything. The repoint itself was **reverted**; that is why
`parseShebang` is still present and why this lane's deletion is not banked yet.

**The fault:** `kernel_exec_target_probe` traps with a wasm `unreachable` — a
Rust panic. It is NOT an artifact-stamping refusal and NOT a missing export;
both of those hypotheses were tested and disproved. Three `vi.fn()` spawn files
were also shown unrelated, by reverting all four commits and getting
byte-identical failure counts.

**The bisect, recorded in `1fd2141d8`:** a sentinel return placed BEFORE the
`exec_target::probe` call clears the fault; placed AFTER it reproduces. The
suspect is therefore `resolve_shebang`'s internal header read —
`rootfs::read` through `blob_read`/`image_read` for an overlay-backed target.

**Why it was never caught:** `resolve_shebang` had never executed in the
TypeScript kernel at all. Only `crates/host-native` called it.

**What you need next:** the panic's actual line, which requires a kernel built
WITHOUT `panic=immediate-abort`. That is the first thing to do.

**A trap for you:** the native test
`probe_resolves_an_overlay_target_without_trapping` exercises exactly the
failing shape and PASSES — because `MockHostIO` has no blob/image byte source.
It is committed saying so. Do not read it as evidence the path is sound.

This lane becomes progress only when the trap is fixed and `6b3a00438` is
reapplied as a single commit. Until then it is addition without its deletion,
which the campaign's standing lesson calls not-a-port.

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

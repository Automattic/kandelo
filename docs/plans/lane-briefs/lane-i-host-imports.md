# Lane I — host import surface (this lane IS goal V4)

**Start this when lane V (VFS / one SFFS) lands, not before** — both move
filesystem semantics into Rust, and I3's target is the code lane V is
rewriting. Everything else in this brief is ready now.

Paste everything below into a fresh agent.

---

You are working **lane I (host imports)** of the Kandelo Rust-first campaign.
Always call it by its label, not just the letter.

## Set up your own worktree first

    cd /Users/brandon/kandelo-abi44-reconcile
    git worktree add /Users/brandon/kandelo-lane-i \
        -b brandonpayton/lane-i-host-imports brandonpayton/rust-first-abi44-reconcile
    cd /Users/brandon/kandelo-lane-i

Work **only** in that worktree, on that branch. Never commit on
`brandonpayton/rust-first-abi44-reconcile` or `brandonpayton/epoll-kernel-route`,
and never merge PR #1350 — the maintainer is the sole merger.

## Your gate

- `hostImportFunctions` **72 → 40**
- `kernelHostImportTypeScript` **3822 → 2100** (`host/src/kernel.ts`, code lines)

Both figures are **code lines** (non-blank, non-comment), the unit the budget
adopted 2026-09-14. Older plan prose quotes whole-line numbers — 1,200 and
2,650 appear in places — and those are not your gate. Read the gate from
`docs/surface-budget.json`, never from prose.

## Why this lane matters more than its size suggests

The campaign's primary goal is **V4: minimise the host API surface so a new
host (wasmtime) is cheap to write.** Every other lane serves that indirectly.
**This lane is that goal**, stated as a number.

`crates/host-native` — 17,757 lines of Rust with no JavaScript — is the
existence proof for what a second host must write today. Your job is to make
that list shorter.

## The surface, grouped by what a new host would have to write

72 functions plus `env.memory`, counted from the built artifact:

| group | count | what it is |
|---|---|---|
| **Filesystem** | **28** | `openat`, `read`, `write`, `pread`, `pwrite`, `seek`, `close`, `fstat`, `fstatat`, … |
| **Graphics** | ~22 | 10 `gl_*`, 6 `kms_*`, 4 `gbm_*`, framebuffer bind/unbind, `fb_write` |
| **Network** | ~12 | 7 `net_*`, 3 `udp_*`, `getaddrinfo`, `network_local_address` |
| **Everything else** | 10 | `clock_gettime`, `getrandom`, `waitpid`, `futex_wake`, `set_alarm`, … |

## End state, and the observation that defines it

**A new host should implement bytes and capabilities, never POSIX semantics.**

That is not a slogan — it is what the grouping shows. **28 of 72 imports are
POSIX filesystem operations**, and the kernel *already* implements POSIX
filesystem semantics in Rust for tmpfs, rootfs and SFFS. Those 28 exist so the
host can answer questions the kernel is already equipped to answer itself.

I1–I2 are 2–3 days. **I3 is the rest**, and it is the one that moves the
number: pushing POSIX filesystem semantics behind the import wall so the host
supplies bytes, not behaviour.

## Non-negotiables

- Run `cd host && npx vitest run test/surface-budget.test.ts` **before every
  commit** and read its verdict lines. Use the `host/` form; the repo-root
  form fetches an unpinned vitest.
- **Never raise a ceiling to make a check pass.** Bank reductions by lowering it.
- **Perturb every new guard until you have seen it fail** and quote the failure
  text.
- `hostImportFunctions` is counted **from the built artifact**, not from source.
  Rebuild before you believe a number.
- A wrapper is not a port. Migration progress is host lines **removed** — ask
  "will this line exist when the migration is done?" and land the deletion
  with the addition.
- When you face a dilemma about whether something must be TypeScript, **stop
  and discuss with the maintainer** rather than growing the host surface. The
  direction of travel is one way.
- ABI stays at **44**. No `ABI_VERSION` bumps. Do not run
  `cargo xtask dump-abi` concurrently with another agent.
- **Deferrals are the maintainer's call.** Land the safe part, then stop and
  argue it — what, why, cost, follow-up — and ask. Never self-defer.

## Provisioning gotchas, learned the hard way 2026-09-14

- Export `CARGO_NET_OFFLINE=true` for `./run.sh setup`.
- **Gate on exit codes, never on piped output.**
- Import-surface changes are host-runtime changes: Node and browser are peers,
  and neither may land alone.

## When you have something to merge

Write a merge handoff into the master plan naming: the exact SHA and branch,
the conflicts you hit and the resolution you **tested**, the suites you ran
with their numbers, and what you did **not** establish.

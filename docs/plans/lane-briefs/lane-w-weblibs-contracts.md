# Lane W — `web-libs` session contracts

Paste everything below into a fresh agent.

---

You are working **lane W (`web-libs` contracts)** of the Kandelo Rust-first
campaign. Always call it by its label, not just the letter.

## Set up your own worktree first

    cd /Users/brandon/kandelo-abi44-reconcile
    git worktree add /Users/brandon/kandelo-lane-w \
        -b brandonpayton/lane-w-weblibs-contracts brandonpayton/rust-first-abi44-reconcile
    cd /Users/brandon/kandelo-lane-w

Work **only** in that worktree, on that branch. Never commit on
`brandonpayton/rust-first-abi44-reconcile` or `brandonpayton/epoll-kernel-route`,
and never merge PR #1350 — the maintainer is the sole merger.

## Your gate

- `sessionKernelFormatParsers` **5 → 0**
- `sessionHandMaintainedSyscallNames` stays **0** (already closed — do not
  regress it)

## The finding, from the W1 census

`docs/plans/2026-09-11-lane-w1-census.md`. `kernel-host.ts` (2,776 of 5,360
lines) holds **three** populations, not the two the lane originally assumed:

1. **The host contract** — `KernelHost`, `KernelLike`, `FileSystemLike`,
   `PtyHandle`, `KmsDisplayHandle`, `AudioOutputHandle`, `Snapshot`. What a
   native host would want and cannot use today.
2. **Browser product surface** — gallery, boot descriptors, sharing, terminal
   policy. **This stays.** Descriptor validation is a security boundary:
   boot descriptors and shared URLs are untrusted input and need versioning,
   size caps, mount limits and loud failures. Do not weaken it.
3. **Hand-written parsers of kernel-emitted formats** — your target.

**The kernel writes `/proc`, and the UI parses it back.** `parseMaps`,
`parseMounts`, `parseProcEntry`, `parseStatusBytes` and `parseRangeSize`
re-derive structured data from text the kernel itself serialised, using
hand-written regexes against strings like
`"00400000-005c2000 r-xp 00000000 fe:00 14222"`.

This is the same shape as the syscall-name table that lane W already closed:
a hand-maintained 137-entry list against a generator's 233. The fix that
worked there — generate the reader from the same Rust authority that writes
the format — is the pattern here. Existing TypeScript that parses a platform
format is a **port target**, not a thing to patch.

## Why this lane is safe to run in parallel

Everything you touch lives under `web-libs/kandelo-session/src/`, which is
disjoint from lane F (`host/src/fork-*`, `worker-main.ts`), lane V
(`host/src/vfs/`) and lane N (`docs/`, `scripts/`). Keep it that way: if a
change pulls you into `host/src/`, stop and say so rather than widening.

## Non-negotiables

- Run `cd host && npx vitest run test/surface-budget.test.ts` **before every
  commit** and read its verdict lines. Use the `host/` form; the repo-root
  form fetches an unpinned vitest.
- **Never raise a ceiling to make a check pass.** Bank reductions by lowering it.
- **Perturb every new guard until you have seen it fail** and quote the failure
  text. For a generated reader, the perturbation that matters is changing the
  Rust writer and confirming the generated reader changes with it — otherwise
  you have replaced one hand-maintained copy with another.
- ABI stays at **44**. No `ABI_VERSION` bumps.
- Node and browser are peers. A host-runtime behaviour change is incomplete
  until both have the same platform-observable behaviour.
- **Deferrals are the maintainer's call.** Land the safe part, then stop and
  argue it — what, why, cost, follow-up — and ask. Never self-defer.

## Provisioning gotchas, learned the hard way 2026-09-14

- Export `CARGO_NET_OFFLINE=true` for `./run.sh setup`.
- **Gate on exit codes, never on piped output.**
- Browser-facing changes are not complete from code reasoning. Use
  `./run.sh browser` with `--port N --strictPort` (5401 collides across
  workspaces). Note `build-rootfs.sh` is currently broken by a 404 from
  `ftpmirror.gnu.org` in `packages/registry/bash/package.toml`; that is with
  the maintainer and is not yours.

## When you have something to merge

Write a merge handoff into the master plan naming: the exact SHA and branch,
the conflicts you hit and the resolution you **tested**, the suites you ran
with their numbers, and what you did **not** establish.

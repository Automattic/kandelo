# Lane V — the VFS image, and the filesystem we implement twice

Paste everything below into a fresh agent.

---

You are working **lane V (VFS / one SFFS)** of the Kandelo Rust-first campaign.
Always call it by its label, not just the letter.

## Set up your own worktree first

    cd /Users/brandon/kandelo-abi44-reconcile
    git worktree add /Users/brandon/kandelo-lane-v \
        -b brandonpayton/lane-v-vfs-one-sffs brandonpayton/rust-first-abi44-reconcile
    cd /Users/brandon/kandelo-lane-v

Work **only** in that worktree, on that branch. Never commit on
`brandonpayton/rust-first-abi44-reconcile` or `brandonpayton/epoll-kernel-route`,
and never merge PR #1350 — the maintainer is the sole merger.

## Your gate — this is what "done" means

`docs/surface-budget.json`, lane V closure:

- `sffsTypeScript` **3047 → 0** (`host/src/vfs/sharedfs-vendor.ts`)
- `memoryFsTypeScript` **7141 → 0** (`host/src/vfs/memory-fs.ts`)

Both numbers are **code lines** (non-blank, non-comment) as of 2026-09-14.
The SFFS block filesystem is implemented twice — here, and in Rust across
`sffs.rs` + `sffs_write.rs` + `sffs_deferred.rs`, same superblock geometry,
same allocators, same magic. One of the two must go, and the kernel owns
the format.

## Why you can start now

Lane Y (image builders) **closed 2026-09-14**:
`imageBuilderFilesystemImporters` reached 0, so no file under `images/`
imports the host TypeScript filesystem any more. That was the blocker. The
Rust `sffs-module` also gained `sm_image_read`, a bounded random-access read
of the loaded image, which exists specifically to retire
`MemoryFileSystem`'s last runtime role, `imageBodyBytes`.

**That grant is a debt you are expected to pay.** `sffsModuleEntryPoints`
carries a `contingency` in the budget: a twenty-third `sm_*` entry point
requires `memoryFsTypeScript` to have reached 0. If you genuinely need a
twenty-third to *get* to 0, that is a fresh argument to the maintainer —
put it to them, do not edit the contingency.

## Read before touching code

1. `docs/plans/2026-09-11-MASTER-PLAN.md`, the `LANE V` section — especially
   "V AFTER THE MERGE", which carries a corpus measurement taken five times
   and got wrong the first four.
2. `docs/plans/2026-09-12-lane-v9-scoping.md`.
3. The corpus finding that matters: of 76 files binding a `MemoryFileSystem`,
   **32 are pure fixtures** (`saveImage`/`writeFile`/`mkdir`/`chmod` only),
   ~20 only read back what they wrote (`SffsImageFs` already has all four
   methods), ~12 follow the lazy decision, and **~6 are the real residue**
   with genuine fd/POSIX surface (`fstat` `seek` `append` `fchmod` `fsync`
   `link`). `binary-resolver.test.ts` binds one variable and calls exactly
   one method on it — `saveImage()` — across 77 assertions.

Begin with the end in mind: move the **consumer** to its end state first,
then build what that demands. Slice by dependency. Never one big rewrite.

## Non-negotiables

- Run `cd host && npx vitest run test/surface-budget.test.ts` **before every
  commit** and read its verdict lines. Use the `host/` form; the repo-root
  form fetches an unpinned vitest.
- **Never raise a ceiling to make a check pass.** Bank reductions by lowering
  the ceiling in the same commit.
- **Perturb every new guard until you have seen it fail**, and quote the
  failure text in the commit message. A guard you have not seen fail is not
  a guard.
- Deletion is the deliverable. A wrapper is not a port: ask "will this line
  exist when the migration is done?" Measure the net before claiming progress.
- ABI stays at **44**. No `ABI_VERSION` bumps.
- Do not run `cargo xtask dump-abi` concurrently with another agent; it
  rewrites eleven files including `abi/snapshot.json`.
- **Deferrals are the maintainer's call.** If you want to defer something,
  land the safe part, then stop and argue it — what, why, cost, follow-up —
  and ask. Never self-defer.

## Provisioning gotchas, learned the hard way 2026-09-14

- A fresh worktree inherits no sysroot, no `local-binaries/`, no
  `node_modules`. Building them is expected work, not a blocker.
- Export `CARGO_NET_OFFLINE=true` for `./run.sh setup`, or the install step
  fails trying to reach `index.crates.io`.
- **Gate on exit codes, never on piped output.** `./run.sh setup | tail` gives
  you `tail`'s status and will report success for a failed build. Redirect to
  a log and check `$?`.
- `./run.sh setup` does not rebuild musl once a sysroot exists. After editing
  `libc/musl-overlay/`, run `scripts/build-musl.sh` — the compiler reads the
  SYSROOT copy, not the overlay.
- The build is GREEN as of 2026-09-15: `./run.sh setup` reaches real exit
  code 0 and `"outcome":"succeeded"`, and the browser suite runs to
  completion at 164 passed / 14 failed — all fourteen on the documented
  pre-existing list. If you see a build failure, it is probably yours.
  Three blockers were cleared today and each hid the next: B40 (a GNU
  redirector serving 404s, fixed by a mirror list), B43 (the Xcode
  licence), and B44 (Xcode 27's `libSystem.tbd` being unreadable by the
  pinned LLVM, fixed by building SpiderMonkey's host tools inside Nix).

## When you have something to merge

Write a merge handoff into the master plan naming: the exact SHA and branch,
the conflicts you hit and the resolution you **tested** (not predicted), any
rebuild required before validating, the suites you ran with their numbers, and
the failures that are known-red and not yours. Say explicitly what you did
**not** establish.

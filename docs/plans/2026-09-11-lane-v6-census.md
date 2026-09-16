# Lane V6 — census of the six SFFS consumers

**Date: 2026-09-11. Status: complete.**

Lane V said V6 "is the deliverable that decides whether the rest is weeks
or days, and nobody has done it." It is done. **The answer is days for
five of the six.**

## What each consumer actually imports from `sharedfs-vendor.ts`

| Consumer | Imports |
|---|---|
| `host/src/vfs/rootfs-overlay.ts` | `ENOENT`, `ENOSPC`, `O_CREAT`, `O_RDONLY`, `O_TRUNC`, `O_WRONLY`, `SFSError` |
| `host/src/vfs/image-helpers.ts` | `EEXIST` |
| `host/src/vfs/package-deferred-tree.ts` | `ENOENT`, `SFSError` |
| `images/vfs/scripts/staged-product-inputs.ts` | `ENOENT` |
| `images/vfs/scripts/dinit-image-helpers.ts` | `ENOENT`, `SFSError`, `S_IFMT`, `S_IFREG` |
| **`host/src/vfs/memory-fs.ts`** | **`SharedFS`** + `EROFS`, `O_CREAT`, `O_EXCL`, `O_TRUNC`, `SFSError`, and four identity types |

**Five of the six take constants and an error class. Exactly one imports
the filesystem.**

The census lane V treated as the decisive unknown has a narrow answer:
`sharedfs-vendor.ts` has **one real consumer**, and it is `memory-fs.ts` —
the file lane V is already committed to deleting.

## Most of those constants are already generated

| Constant | In `generated/abi.ts`? |
|---|---|
| `O_CREAT`, `O_EXCL`, `O_TRUNC`, `O_RDONLY`, `O_WRONLY` | **yes** (`OPEN_FLAGS`) |
| `S_IFMT`, `S_IFREG` | **yes** (`FILE_MODES`) |
| `ENOENT`, `ENOSPC`, `EROFS`, `EEXIST` | **no** |

So four of the five constant-only consumers can be repointed at a table
that already exists, today, with no new Rust.

**And `memory-fs.ts` already imports both.** It takes `OPEN_FLAGS` from
`generated/abi` at line 20 and `O_CREAT` from `sharedfs-vendor` at line
31, then aliases `OPEN_FLAGS.O_CREAT` at line 501. **Two sources for the
same constant in one file** — the drift hazard is already present, not
hypothetical.

## V-D1: there is no generated errno table

`ENOENT`, `ENOSPC`, `EROFS` and `EEXIST` are hand-written in
`sharedfs-vendor.ts`, and `exec-target.ts` declares its own
`const EAGAIN = 11; const EFBIG = 27; ...` as well. **Errno numbers are
ABI**, and unlike open flags and mode bits they have no generated table.

This is the same class as L-D2 (the hand-written scratch pointer table)
and W-D1 (the hand-copied syscall names): **ABI knowledge reaching
TypeScript by hand when a generator already exists for its neighbours.**

Adding an `ERRNO` table to `dump_abi.rs` is small and unblocks all five
constant-only consumers.

## What this changes about lane V

The lane's increments assumed V6 would find several consumers needing
real filesystem service from the kernel, and that serving them would be
"the bulk". **It found one**, and that one is already scheduled for
deletion.

Revised:

- **V6 — this census.** Done.
- **V7 — add the generated `ERRNO` table** (V-D1), then repoint the five
  constant-only consumers at `generated/abi.ts`. **This removes five of
  six imports of `sharedfs-vendor.ts` without touching a filesystem.**
- **V8 — `SFSError` gets a home** outside the implementation being
  deleted.
- **V9 — the real work: `memory-fs.ts` stops using `SharedFS`.** With V7
  and V8 done, this is the only thing standing between the repo and
  deleting `sharedfs-vendor.ts`.
- **V10 — delete `sharedfs-vendor.ts`.**

**Lane Y still blocks the `memory-fs.ts` deletion** (36 importers under
`images/`), but it does **not** block deleting `sharedfs-vendor.ts` —
V7–V10 can proceed in parallel with lane Y. That ordering was not visible
before this census.

## Estimate

Lane V was **10–20 agent-days, "unknown until V6"**. V7 and V8 are
**1–3 days**; V9 is the remainder and is genuinely large because
`memory-fs.ts` is 8,501 lines.

**Revised: 8–16 agent-days, medium.** The confidence improves because the
census removed the possibility that five more consumers each needed a
bespoke kernel service.

## What this census did not establish

- **How `memory-fs.ts` uses `SharedFS`**, only that it is the sole
  importer. V9 needs that reading and it is the lane's real unknown.
- **Whether the four identity types** (`ConditionalNamespaceIdentity`,
  `NamespaceEntryIdentity`, `SharedFsIdentityState`, `SfsStatResult`)
  carry behaviour or are pure shapes.
- **Whether `exec-target.ts`'s hand-written errno constants agree with the
  kernel's.** They were noticed, not checked.

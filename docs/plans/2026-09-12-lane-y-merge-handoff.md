# Lane Y / V4 — merge handoff

**Branch: `brandonpayton/lane-y-image-writer`. Worktree:
`/Users/brandon/kandelo-lane-y`. Never pushed; the maintainer is sole merger.**

This is a **good merge point in the middle of the lane**, not the end of it.
What is finished is a complete, coherent unit; what remains is named below so
nobody reads the merge as "lane Y is done".

## What is finished: lane V's V4

**An image the Rust export writes is now one the kernel can load back**, with
every deferred file keeping its real size, its archive linkage, and the length
that bounds its fetch. Before this, the export turned every deferred file into
an empty one and the loader refused any image that did not carry a `KLZY`
section — so an image the kernel wrote was one the kernel could not read.

Nine increments, each with its mutation-trial result in its own commit body:

1. SDEF carries the archive linkage, so it can replace KLZY
2. The export describes archive members instead of emptying them
3. The loader keeps a deferred file's description, so an export can re-emit it
4. SDEF declares the archives its records point into
5. **An image the kernel exports is one the kernel can load** — V4 closed
6. The export emits a whole image, not a filesystem with no wrapper
7. An archive's fetch description has somewhere to live
8. Type-check the VFS builders, which nothing was checking
9. Deferred-ness in the stat record

## Why merge now rather than at the end of the lane

**It unblocks the lane S agent.** Lane S was deferred with *"I only want the
problem fixed for the new Rust-based FS which is not completed yet."* The part
it needs — somewhere to record an integrity digest for a deferred file — now
exists and is carried end to end.
`docs/plans/2026-09-12-lane-s-deferral-handoff.md` opens with an update box
telling that agent where a digest goes and what stays its own decision. Merging
lets it work **against** the format instead of around it.

## Risk, with the specific reason it is low

**Nothing in production goes through the Rust export yet.** The one change on
the kernel boot path is `load_image_inner`, and an image carrying a `KLZY`
section takes exactly the branch it always did — tested against a deliberately
disagreeing KLZY/SDEF pair to prove which carrier wins.

The `SDEF` section format went v1 → v4 in this branch. **No artifact anywhere
carries any version of it**, it appears in no fixture, and `SDEF` occurs zero
times in `abi/snapshot.json`. Each bump exists so a kernel built before the
change refuses a section it would otherwise misread, rather than for
compatibility with something deployed.

**No `ABI_VERSION` bump. No `dump-abi`. `abi/snapshot.json`,
`host/src/generated/abi.ts`, `dump_abi.rs` and `libc/musl-overlay` are
untouched, as is `host/src/kernel-worker.ts`.**

## Verify before merging

All were green at the tip:

* `cargo test -p runtime-core --lib` — 2160 passed, 0 failed
* `cargo test -p sffs-module`
* `cargo test -p xtask vfs_image_describe`
* `cargo build -p runtime-core --target wasm32-unknown-unknown`
* `crates/sffs-module/build-wasm.sh` — must print "imports nothing (contract
  holds)"; the module has no import section and that is a contract, not a
  coincidence
* `cd host && npx vitest run test/surface-budget.test.ts test/sffs-image-fs.test.ts`
  — run it from `host/`, not the repository root (H-10: the root form fetches
  an unpinned vitest)

**No ceiling was raised.** One surface was ADDED — `sffsModuleEntryPoints`,
banked at its measured value of 19 rather than left to grow unwatched.

## Carry forward

* **Gap 10's policy half is lane S's.** Whether a digest is MANDATORY is
  deliberately undecided here: an empty descriptor is a representable state and
  a test says so. Note that a mandatory rule is not enforceable until producers
  emit SDEF, because a `KLZY`-described image yields an empty descriptor.
* **Gap 11 — the VFSI container header constants are hand-carried into
  TypeScript.** The campaign's fourth instance of that class after L-D2, W-D1
  and V-D1. Closing it needs an ABI regeneration, so it must be scheduled
  rather than taken opportunistically.
* **Gap 12** — a production build script imports a `host/test/` helper.
* **`images/tsconfig.typecheck.json` is deliberately NOT wired as a blocking
  gate.** It found four type errors in code nothing was checking; one was this
  lane's and is fixed, three remain. A gate with a baseline of three cannot
  detect the fourth.

  Verified inert, so it carries no merge risk: nothing auto-discovers it, and
  the only workflow watching a tsconfig watches `host/tsconfig.json`. **When
  the three are gone, wire it the way `host` already does** — `host/package.json`
  has `"typecheck": "tsc -p tsconfig.typecheck.json"`, so the matching script
  is the natural home rather than a new mechanism.

  Run it with `./host/node_modules/.bin/tsc`, not `npx tsc` from the repository
  root: the root form prints "This is not the tsc command you are looking for"
  and exits non-zero having checked nothing, which reads like a failure with no
  errors. Same shape as H-10.
* **The two biggest builder files are not recipes.** `staged-product-inputs.ts`
  (1,975 lines, 50 parse/verify sites) and `vfs-product-builder-contract.ts`
  (952 lines, 55) do archive extraction, path-traversal defence and integrity
  verification of untrusted input. Two of the three remaining type errors are
  in the first, one of them an unvalidated-input hole. This is a port target,
  and whether it is lane Y's or its own lane is a maintainer decision.

## What is NOT in this branch

**Y5's repoint.** Measured as one connected component rather than a
file-at-a-time pass: repointing the 13 type-only importers gives 79 errors,
widening to every file declaring `MemoryFileSystem` in a signature gives 45, and
cutting the component at the 7 files whose bodies need the omitted methods gives
191, because those 7 sit in the middle of the call graph rather than at its
edge. The attempt was reverted; the numbers are in the master plan under
LANE Y.

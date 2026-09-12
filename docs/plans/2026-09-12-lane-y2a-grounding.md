# Lane Y2a — grounding: the assertions are covered, and two gaps the census missed

**Date: 2026-09-12. Status: complete. Worktree `/Users/brandon/kandelo-lane-y`,
branch `brandonpayton/lane-y-image-writer`.**

Y2's first act, before writing any Rust. Three questions the Y1 census left
open or did not ask, each answered by measurement rather than reading.

## 1. The three policy assertions ARE covered. The hazard is refuted.

Lane Y's known hazards said the three policy assertions are "the most likely
thing to be silently dropped" and that "nobody has checked whether a test would
notice their absence". Somebody has now. **They would notice.**

**The method matters more than the result, because the obvious version of this
check answers the wrong question.** `assertVfsImageCapacity` and
`assertVfsImageHeadroom` already have direct unit tests in
`host/test/vfs-image.test.ts`, and it would have been easy to stop there and
call the assertions covered. A unit test on the function cannot notice the
function being **unwired from `serializeImage`** — and unwiring is precisely
what a migration does. So the perturbation disables the **call site** inside
`serializeImage` (`if (false && …)`), leaving each function body untouched.

Each perturbation asserts its anchor matches **exactly once** before applying,
so a perturbation cannot silently skip — the H-2 failure mode where an anchor
matches three places and reads identically to being killed.

Baseline for the detector set: **6 files, 126 tests, all passing.**

| Call site disabled | Result | Detectors |
|---|---|---|
| `assertVfsImageHeadroom` | **1 failed / 125 passed** | `vfs-image.test.ts` — "enforces the declared reserve **before writing** a product image" |
| `assertNoStaleWasmArtifacts` | **23 failed / 103 passed** | 10 in `vfs-image-helpers.test.ts`, 13 in `vfs-image-wasm-policy.test.ts` |
| `assertVfsImageCapacity` | **1 failed / 125 passed** | `vfs-image.test.ts` — "rejects an encoded ceiling hidden by a smaller runtime buffer **before writing**" |

Two observations worth carrying into the migration:

* **`assertNoStaleWasmArtifacts` is not exported and has no direct unit test,
  yet it has 23 detectors.** Its coverage is entirely through the pipeline. The
  symbol-level reading ("no test references it") would have concluded the
  opposite of the truth.
* **Headroom and capacity have exactly one detector each.** Real, but thin —
  one test each stands between a migration and silently dropping a published
  artifact's size guarantee. Worth knowing before Y3 moves them, not after.

## 2. Gap 7 — Rust has no VFSI container writer

The census listed six image-level gaps. There is a seventh, and it sits
upstream of the other six: **the Rust side can read the image container but
cannot write it.**

`VFSI_MAGIC` occurs only in `crates/runtime-core/src/sffs.rs` — the reader
(`sffs_span`, `unwrap_vfsi`, `kernel_lazy_span`). `SffsWriter::finish` yields an
`SffsImage`, which is the raw SFFS body: superblock, both bitmaps, the inode
table and blocks. It is not what a `.vfs.zst` contains.

What a `.vfs.zst` contains, decompressed, is the container the TypeScript writer
builds at `host/src/vfs/memory-fs.ts:7345`:

```
header(16) | sab | u32 lazyLen | lazyJson
           | u32 archiveLen | archiveJson     (flag 1<<1)
           | u32 metadataLen | metadataJson   (flag 1<<2)
           | u32 kernelLazyLen | KLZY
```

**No container writer means no production image**, however complete the body
writer is. Note also what V5 does and does not remove: deferred metadata moves
into the body as SDEF, but the **image metadata** section
(`VFS_IMAGE_FLAG_HAS_METADATA`: `version`, `kernelAbi`, `createdBy`) still needs
a home, so the container does not simply collapse to the body.

## 3. Gap 8 — `SffsWriter` is one-pass, and the builders read back mid-build

This is structural, and it is the finding that most changes the lane's size.

`SffsWriter`'s entire mutator surface is `mkdir`, `create_file`,
`create_deferred_file`, `symlink`, `link`, `set_owner`, `set_mode`, `set_times`,
`finish`. **There is no `unlink`, no lookup, and no read.** It is an
append-only, write-once builder.

The builders are not append-only. They read back what they have written:

* `readVfsBytes` (`images/vfs/scripts/vfs-image-helpers.ts:204`) does
  `stat` → `open` → `read` against the filesystem under construction;
* `walkVfsFiles` (line 291) recurses the whole tree with `opendir`/`readdir`;
* `assertNoStaleWasmArtifacts` — the very assertion Y3 must preserve — **walks
  the entire image and reads every `.wasm` file back out** to check it against
  the ABI.

The Y1 census counted 24 distinct `MemoryFileSystem` methods and then framed the
gap as "six operations and three assertions". **Roughly ten of the 24 are
read-back-during-build** — `stat` (17 calls), `lstat` (8), `read`/`open`/`close`
(7 each), `readdir` (5), `getLazyEntry` (10), `isPathDeferred` (4) — and an
append-only writer cannot serve any of them. The gap is not six operations; it
is that the Rust side has a *builder* where the lane needs a *filesystem*.

## 4. The substrate candidate, and the decision it forces

**`crates/runtime-core/src/tmpfs.rs` is already a 1,724-line mutable POSIX
filesystem in Rust**, and its vocabulary is very close to the builders':
`lstat`, `open`/`read`/`write`, `mkdir`, `unlink`, `statfs`, `link`,
`opendir`/`readdir`/`getdents64`, `chmod`, `chown`, `utimensat`, `symlink`,
`readlink`, `rename`, `truncate_handle`. **Two of the census's six gaps —
`unlink` and `statfs` — are already implemented there.**

Two properties make adopting it a decision rather than a detail:

* **It is a global singleton.** `static TMPFS_ENABLED`, `static TMPFS_NOW_SEC`,
  module-level functions over one store. A builder process that produces more
  than one image, or a test suite that builds several, has nowhere to put the
  second filesystem.
* **It is mid-cutover for the kernel** and ships disabled
  (`TMPFS_ENABLED: AtomicBool::new(false)`, "defaults OFF so this machinery is
  dormant … until the cutover increment enables tmpfs"). Making it instantiable
  couples lane Y to that work.

The three candidate substrates, none yet chosen:

1. **Make `tmpfs` instantiable** and build on it. Most reuse, but it edits a
   subsystem mid-cutover and touches the kernel's own path.
2. **Give `SffsWriter` read-back and `unlink`.** Scoped to the writer, but it
   reimplements a filesystem beside one that exists — the exact "SFFS exists
   twice" defect lane V is closing, in a third location.
3. **Keep a shadow tree in the TypeScript bridge**, Rust writes once at the end.
   Smallest Rust change, but the bridge then holds filesystem semantics in
   TypeScript, which is the surface the campaign is removing.

**This is a maintainer decision and is not taken here.**

## What this changes about lane Y

The lane is not "six operations, one bridge, a mechanical repoint". It is:
a container writer, a mutable-filesystem substrate decision, the six
image-level operations on top of whichever substrate wins, and then the
cutover. The Y1 estimate of 8–15 agent-days was made without gaps 7 and 8 in
view and should be read as a floor, consistent with this plan's own note that
every estimate so far has been larger than filed.

**What this grounding did NOT establish:** whether byte-level block allocation
order agrees between the writers for a real image (the four cross-language
fixtures say it does for four small trees); and what the `.vfs.zst` container
should look like after V5, which is a lane V question lane Y will hit first.

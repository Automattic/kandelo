# Lane Y1 — census of the VFS image builders

**Date: 2026-09-11. Status: complete. This is Y1, lane Y's first increment.**

Its job was to establish what the builders actually need from the
TypeScript filesystem, and what the Rust writer can already serve.

**The headline: lane Y's gate was measuring the wrong thing, and the Rust
side is far closer to sufficient than the lane assumed.**

## What the builders actually use

**36 files under `images/`** import `host/src/vfs/memory-fs.ts` or
`host/src/vfs/sharedfs-vendor.ts` — 34 under `images/vfs/scripts/` plus
`images/vfs/lib/demo-login.ts` and
`images/vfs/lib/init/spidermonkey-npm-runtime.ts`.

Those last two were missed by a first pass that looked only at
`images/vfs/scripts/`, and the gate caught it on the first run: the
measure counts all of `images/` and reported `imageBuilderFilesystemImporters
is 36, above its ceiling of 34`. A hand-counted ceiling is exactly the kind
of number that should be set by the measure rather than by the person
writing the prose.

Most reach it through a small helper vocabulary — `writeVfsFile`,
`writeVfsBinary`, `ensureDir`, `ensureDirRecursive`, `symlink`,
`walkAndWrite`, `saveImage` — but **that vocabulary is not the whole
contract**, and an early reading of this census wrongly concluded it was.
The builders also call `MemoryFileSystem` directly. **24 distinct
methods**, by call count:

| Method | Calls | | Method | Calls |
|---|---|---|---|---|
| `chmod` | 31 | | `saveImage` | 4 |
| `stat` | 17 | | `isPathDeferred` | 4 |
| `chown` | 17 | | `registerLazyFile` | 3 |
| `getLazyEntry` | 10 | | `rebaseToNewFileSystem` | 3 |
| `lstat` | 8 | | `readlink` | 3 |
| `read` / `open` / `close` | 7 each | | `opendir` / `closedir` | 3 |
| `getImageMetadata` | 6 | | `exportLazyArchiveEntries` | 3 |
| `verifyImportedLazyAtomicGroupSeals` | 5 | | `symlink` | 2 |
| `readdir` | 5 | | `setImageMetadata` | 2 |
| `statfs` | 4 | | `unlink` | 1 |

So the builders need **a writable filesystem with POSIX metadata**, not a
tree-builder: modes, ownership, symlinks, stat, directory iteration, plus
lazy-file registration and image serialization.

Only two files reach past `MemoryFileSystem` into `sharedfs-vendor.ts`,
and only for **constants** — `ENOENT`, `SFSError`, `S_IFMT`, `S_IFREG` in
`dinit-image-helpers.ts`, and `ENOENT` in `staged-product-inputs.ts`.
**The lane text's claim that three builders "write the format directly"
was wrong.** None of them does; they use error codes and mode bits.

## Where the format is actually written

**One call.** Every builder funnels through `saveImage` →
`serializeImage` → `fs.saveImage(...)`. All 13,502 lines touch the SFFS
format at that single point.

`serializeImage` also carries policy that is not format work and must not
be lost with it: `assertNoStaleWasmArtifacts` (an ABI check on Wasm
artifacts inside the image), `assertVfsImageHeadroom`,
`assertVfsImageCapacity`, and zstd level-19 compression.

## What the Rust side already has

Nearly all of it, split across three modules:

| Builder need | Rust |
|---|---|
| `chmod` | `SffsWriter::set_mode` |
| `chown` | `SffsWriter::set_owner` |
| `symlink` | `SffsWriter::symlink` |
| `ensureDir` | `SffsWriter::mkdir` |
| `writeVfsFile` / `writeVfsBinary` | `SffsWriter::create_file` |
| `registerLazyFile` | `SffsWriter::create_deferred_file` |
| hard links | `SffsWriter::link` |
| timestamps | `SffsWriter::set_times` |
| `saveImage` | `SffsWriter::finish` / `to_vec` |
| `stat` / `lstat` | `Sffs::stat_ino`, `file_type` |
| `readdir` / `opendir` | `Sffs::read_dir` |
| `readlink` | `Sffs::read_link` |
| `open` / `read` / `close` | `Sffs::read_at` |
| `isPathDeferred` / `getLazyEntry` | `Sffs::deferred_section`, `sffs_deferred::get` |

**The genuine gaps are image-level, not filesystem-level**: `statfs`
(derivable from `Sffs::geometry`), `getImageMetadata` /
`setImageMetadata`, `verifyImportedLazyAtomicGroupSeals`,
`exportLazyArchiveEntries` / `registerLazyArchiveFromEntries`,
`rebaseToNewFileSystem`, `unlink`, plus the three policy assertions and
compression above.

That is roughly **six operations and three assertions**, against a lane
that was scoped as though the whole filesystem had to be rebuilt.

## The gate was measuring the wrong thing

Lane Y's surface was `imageBuilderTypeScript` — 13,502 lines, target
2,000. **That target is unreachable and, more importantly, undesirable.**

The 13,502 lines are overwhelmingly *recipes*: which packages go in the
LAMP image, how WordPress is preinstalled, what dinit services a MariaDB
image declares. **That is product configuration and it stays.** A
line-count target on this lane invites deleting exactly the wrong 13,502
lines — `wordpress-preinstall.ts` is 921 lines of product logic that has
nothing to do with the image format.

Lane Y is **not a line-reduction lane.** Its value is decoupling: goal V3
(one implementation of the format) and unblocking lane V (which cannot
delete `memory-fs.ts` while 36 builder files import it).

**The surface is therefore replaced**: `imageBuilderFilesystemImporters`
— the number of files under `images/` importing `memory-fs.ts` or
`sharedfs-vendor.ts`. **Ceiling 36, target 0.** That is the fact lane V
is blocked on, and it goes to zero exactly when the lane is done.

## Revised increments

- **Y1 — this census.** Done.
- **Y2 — close the six image-level gaps** in Rust: image metadata, lazy
  archive import/export, rebase, unlink, `statfs` from geometry.
- **Y3 — move the three policy assertions** (`assertNoStaleWasmArtifacts`,
  headroom, capacity) to sit with the writer, so a new image path cannot
  skip them.
- **Y4 — one bridge** the builders call instead of `MemoryFileSystem`,
  exposing the 24 methods above over the Rust implementation.
- **Y5 — repoint 34 files.** Mechanical once Y4 exists.
- **Y6 — replace the constants** `ENOENT`/`SFSError`/`S_IFMT`/`S_IFREG`
  in the two files that take them from `sharedfs-vendor.ts` with generated
  ABI constants.
- **The recipes are not touched** and that is the point.

## Effect on the estimate

Lane Y was estimated at **10–20 agent-days** assuming the format had to
be reimplemented for builders. The Rust implementation being nearly
complete makes the work more predictable — six operations, one bridge, a
mechanical repoint — but the acceptance bar is unchanged and it is the
expensive part: **nine production images must build byte-identically**
before the TypeScript path is removed.

**Revised: 8–15 agent-days**, and the confidence moves from "unknown
until Y1" to medium.

## What this census did not establish

- **Whether byte-identical output is achievable** without changes to the
  Rust writer's block allocation order. The four existing cross-language
  fixtures suggest it is; nine whole images is a much larger claim.
- **What `rebaseToNewFileSystem` is for.** Three call sites, and it did
  not become clear from the imports alone.
- **Whether the policy assertions have coverage.** They are the part most
  likely to be silently dropped in a migration, and nobody has checked
  whether a test would notice.


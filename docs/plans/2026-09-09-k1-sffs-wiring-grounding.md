# K1 Grounding — Wiring `crates/runtime-core/src/sffs.rs`

> Read-only grounding pass, 2026-09-09. Worktree
> `/Users/brandon/kandelo-abi44-reconcile`, branch
> `brandonpayton/rust-first-abi44-reconcile` (head of PR #1350).
> **No code was changed.** This file is the only file written.
>
> Companion to `2026-09-09-rust-first-value-plan.md` (K1 = Tier 1, serves
> **V3** and V1), `2026-09-09-whole-kernel-rust-migration-census.md` (§3 F3,
> §7), and `2026-09-09-runtime-ts-disposition-ledger.md`.

## 0. What was VERIFIED vs INFERRED

Everything below is labelled. Nothing inferred is presented as fact.

**Commands actually run (all passed / produced the output cited):**

```
bash scripts/dev-shell.sh -- cargo test -p runtime-core \
    --target aarch64-apple-darwin --lib sffs
    → 15 passed; 0 failed  (includes real_rootfs_image_lists_root_and_reads_passwd,
      which reads the REAL local-binaries/source-only-v1/.../rootfs.vfs)

node tools/mkrootfs/bin/mkrootfs.mjs inspect host/wasm/rootfs.vfs \
    --format json --metadata
    → 375 entries {d:19, l:272, f:84}, metadata
      {"version":1,"kernelAbi":44,"createdBy":"mkrootfs build"}
```

Plus three throwaway Node scripts (written to the session scratchpad, **not**
to the repo) that re-implement `sffs.rs`'s exact decoding rules — superblock
checks, `inode_offset`, `stat_ino` (with its `nlink == 0` free-slot rule),
`block_ptr_in`, `block_map`, `read_at`, `read_dir` with the identical
`isValidDirEntry` predicate, and inline/indirect `read_link` — and walk real
production images with them. Their results are quoted as VERIFIED below.

**Not run:** Vitest, Playwright, `cargo test --workspace`, libc/posix/sortix,
`scripts/check-abi-version.sh`, any benchmark. This is a grounding pass; no
behavior claim is made about the branch as a whole.

**One incidental finding while establishing the test command:** on this branch
`cargo test -p runtime-core --lib` **without** `--target <host-target>` fails
with 391 errors (the workspace default target is wasm32, which has no `std`
and rejects `panic=abort` tests). This matches
`docs/agent-guidance/validation.md:23`, which already requires `--target`. Not
a defect — recorded so the next agent does not misread it as one.

---

## 1. Q1 — What `sffs.rs` implements today, and what it does not

### 1.1 What it implements (512 lines, `crates/runtime-core/src/sffs.rs`)

| capability | site | notes |
|---|---|---|
| VFSI container unwrap → inner SFFS bytes | `sffs.rs:26-33` | reads magic/version/`sabLen`; **ignores `flags` at offset 8 and everything after the SAB** |
| SFFS superblock validation + inode-table bounds proof | `:86-102` | validates magic, version, `BLOCK_SIZE`, and that the whole inode table fits, so later offsets need no per-call check |
| `stat_ino` → mode, nlink, size, mtime/ctime/atime (ms), uid, gid, generation | `:114-132` | |
| `block_map`: 10 direct + 1024 single-indirect + double-indirect, sparse holes as physical block 0 | `:138-171` | `u64` arithmetic guards against wasm32 `usize` wrap on a corrupt block number (`:142-147`, `:190-193`) |
| `read_at` positioned read, EOF clamp, holes read as zeros | `:176-201` | |
| `read_dir` with the vendor's exact `isValidDirEntry` predicate | `:208-240` | `rec_len >= 8 && rec_len % 4 == 0 && off+rec_len <= blockEnd && name_len <= rec_len-8` |
| `lookup` (linear scan) | `:245-250` | deliberately no `DirIndex`; see gap G7 |
| `read_link` — inline (`size <= 40`) and block-backed, with an oversize guard | `:255-272` | |
| `resolve` — absolute path walk, `ENOTDIR`, symlink splicing, `follow_final` (stat vs lstat), `MAX_SYMLINK_HOPS = 8` → `ELOOP` | `:289-322` | |
| 15 unit tests incl. a real-image test | `:334-511` | all pass (VERIFIED) |

Constants match `sharedfs-vendor.ts` exactly where both define them:
`BLOCK_SIZE 4096`, `INODE_SIZE 128`, `INODES_PER_BLOCK 32`, `DIRECT_BLOCKS 10`,
`PTRS_PER_BLOCK 1024`, `INLINE_SYMLINK_SIZE 40`, `ROOT_INO 1`,
`MAX_SYMLINK_HOPS 8`, `SB_TOTAL_INODES 16`, `SB_INODE_TABLE_START 36`, and the
`INO_*` field offsets (`sharedfs-vendor.ts:21-138` vs `sffs.rs:37-58`).

### 1.2 VERIFIED: it parses real production images correctly

Walking with `sffs.rs`'s exact rules:

| image | SAB bytes | dirs | files | symlinks | other | decode errors |
|---|---|---|---|---|---|---|
| `host/wasm/rootfs.vfs` | 16,777,216 | 18 (+root) | 84 | 272 | 0 | **0** |
| `.../shell.vfs.zst` | 16,777,216 | 1,225 | 7,601 | 333 | 0 | **0** |
| `.../wordpress.vfs.zst` | 218,103,808 | 1,933 | 13,112 | 333 | 0 | **0** |
| `.../kandelo-sdk.vfs.zst` | 268,435,456 | 136 | 2,298 | 4 | 0 | **0** |

Cross-checked against the TypeScript authority: `mkrootfs inspect
host/wasm/rootfs.vfs` reports **375 entries {d:19, l:272, f:84}**; the
`sffs.rs`-rules walk reports **374 + root = 375, {d:18+root, l:272, f:84}**.
**Exact match.** No hard-linked inodes exist in any of the four images (every
inode appeared under exactly one path), and no entry had a type outside
dir/file/symlink.

**Conclusion (VERIFIED): the on-disk SFFS *binary* layer is fully readable by
`sffs.rs` today, on real images, at production scale.** The gaps are all above
or beside that layer.

### 1.3 The gaps, named

Feature-by-feature against `host/src/vfs/sharedfs-vendor.ts` (3,752 lines) and
`host/src/vfs/memory-fs.ts` (8,198 lines).

**G1 — The whole write path is absent (by design, and correct).**
`SharedFS` implements `mkfs`, `open/openUnlocked`, `write`, `writeAt`,
`append`, `ftruncate`, `unlink`, `rename`, `mkdir`, `rmdir`, `symlink`,
`link`, `chmod`, `chown`, `lchown`, `utimens`, block/inode allocation
(`blockAlloc`, `blockAllocWithGrow`, `grow`, `inodeAlloc`, `inodeFree`),
`freeBlocksFrom`, `zeroInodeRange` — roughly `sharedfs-vendor.ts:353-3760`.
`sffs.rs` implements none of it. **This is not a K1 gap**: `rootfs.rs` already
owns mutation (overlay `Regular`, copy-on-write, whiteouts). The image is an
immutable base layer. Recorded so nobody later mistakes it for missing work.

**G2 — VFSI container sections after the SAB are entirely unparsed.**
`unwrap_vfsi` (`sffs.rs:26-33`) reads only magic/version/`sabLen`. It never
reads `flags` (offset 8) and never touches the trailing sections that
`memory-fs.ts:936-965` (`sectionOffsetAfterArchives`) parses:

```
[16-byte header][SAB bytes][u32 lazyLen][lazy JSON]
                            [u32 archiveLen][lazy-archive JSON]   (if flag 1<<1)
                            [u32 metadataLen][image-metadata JSON] (if flag 1<<2)
```

VERIFIED on real images:

| image | flags | lazy JSON | lazy-archive JSON | image metadata |
|---|---|---|---|---|
| `host/wasm/rootfs.vfs` | `0x5` | 10,720 B (65 entries) | — | `{"version":1,"kernelAbi":44,"createdBy":"mkrootfs build"}` |
| `shell.vfs.zst` | `0xF` | 79 entries | **2,779,271 B** | + `shellComposition` |
| `wordpress.vfs.zst` | `0xF` | 79 entries | **2,779,295 B** | + `capacity`, `baseImage{sha256,kernelAbi:44}` |
| `kandelo-sdk.vfs.zst` | `0x4` | 0 | — | `{"version":1,"kernelAbi":44,…}` |

**G3 — and this is the one that changes K1's size: a lazy stub's real size is
NOT in the SFFS layer.** VERIFIED by dumping the inodes named in the lazy JSON
of `host/wasm/rootfs.vfs`:

```
/usr/bin/bash   declared size 3028830 | inode size 0  direct 0,0,0,0,0,0,0,0,0,0  ind 0  dind 0
/usr/bin/sudo   declared size 2118858 | inode size 0  direct all-zero
/usr/bin/dash   declared size  640120 | inode size 0  direct all-zero
```

A lazy stub (`SharedFS.createLazyStub`, `sharedfs-vendor.ts:2437`) is a
**zero-size, zero-block regular inode**. The real size, the fetch URL, and the
`(ino, generation, dataSequence)` identity binding live **only** in the
trailing lazy JSON. A kernel that parsed the SFFS layer alone would report
`/usr/bin/bash` as a 0-byte file and `exec` it as an empty program — a silent
lie, exactly the class of failure the platform-values contract forbids.

So **`sffs.rs` alone is not sufficient to reproduce today's tree.** It
reproduces the *concrete* tree (VERIFIED exact match on the base image's 375
entries, of which the 65 lazy stubs are size-0 in both readers because
`mkrootfs inspect` reports the SFFS size too — the *runtime* size comes from
`MemoryFileSystem.lazyFileForStat`, `memory-fs.ts:3612-3620`, which is the
layer above). See §9 and NEEDS-DEFER-DECISION D1.

**G4 — Allocation bitmaps and free-space accounting are unread.**
`sffs.rs` never reads `SB_TOTAL_BLOCKS(12)`, `SB_FREE_BLOCKS(20)`,
`SB_FREE_INODES(24)`, `SB_INODE_BITMAP_START(28)`,
`SB_BLOCK_BITMAP_START(32)`, `SB_DATA_START(40)`, `SB_MAX_SIZE_BLOCKS(68)`,
`SB_GROW_CHUNK_BLOCKS(72)` (all defined at `sharedfs-vendor.ts:103-122`).
Consequences:
- No real `statfs`. `rootfs::statfs` (`rootfs.rs:2257-2279`) currently returns
  **hard-coded placeholders** with an explicit `// RAMFS_MAGIC (placeholder;
  reconciled at cutover)` comment. VERIFIED geometry that *is* available in
  the image and could feed it: e.g. `host/wasm/rootfs.vfs` → totalBlocks 4096,
  freeBlocks 3280, totalInodes 16384, freeInodes 16008, maxSizeBlocks 65536.
- `sffs.rs` uses `nlink == 0` as its free-slot test (`:119`); the vendor uses
  the **inode bitmap** (`inodeIsAllocated`, `sharedfs-vendor.ts:1541`). These
  agree on every image checked (no decode errors, exact entry-count match) but
  they are not the same predicate. A genuine, if small, divergence.

**G5 — In-buffer FD table and lock words are unread.** `FD_TABLE_OFFSET 256`,
`FD_ENTRY_SIZE 24`, `MAX_FDS`, `SB_GLOBAL_LOCK(60)`, `SB_NAMESPACE_LOCK(64)`,
`INO_LOCK_STATE(0)`, `INO_OPEN_COUNT(112)`, plus the whole `Atomics`-based
lock discipline (`sbLock`, `namespaceLock`, `inodeReadLock`/`WriteLock`,
`waitForAtomicChange`, `sharedfs-vendor.ts:762-1155`). Correct to omit —
`rootfs.rs` owns OFDs and the kernel is the sole reader after cutover — **but
it means the kernel reads the image lock-free.** Today the host still mutates
the same buffer at boot (see G9). Stated, not hidden.

**G6 — `INO_DIR_SEQUENCE(116)` / `INO_DATA_SEQUENCE(120)` are unread.**
`generation` is read (`sffs.rs:130`); `dataSequence` is not. The lazy identity
binding is keyed on `(ino, generation, dataSequence)`
(`memory-fs.ts:3612-3619`, `:3637-3653`). VERIFIED: every lazy entry in
`rootfs.vfs` carries `dataSequence: 1` and a `generation` equal to its `ino`.
So the field is needed if the kernel ever owns lazy identity.

**G7 — No `DirIndex`.** `sharedfs-vendor.ts:1549-1717` builds a hash index for
directories `>= DIR_INDEX_MIN_SIZE` (64 KiB) to make `dirLookup` sublinear.
`sffs.rs:245-250` does a linear `read_dir` scan per `lookup`, and `read_dir`
itself re-reads blocks through `read_at`. `sffs.rs:242-244` documents this as
deliberate ("an in-process optimization with no on-disk form"). Correct for a
one-shot tree build; a **latent hot-path risk** if `lookup`/`resolve` were ever
called per-syscall. Under the plan in §10 they are not — the tree is built
once and `rootfs.rs`'s own `BTreeMap` serves lookups thereafter.

**G8 — `..` is a no-op in `resolve`** (`sffs.rs:302`, documented at `:283-288`
as deferred). `SharedFS.pathResolve` (`:2188`) handles it properly. Under the
§10 plan `resolve` is not on the boot path at all (the builder walks with
`read_dir`), so this stays a documented limitation of an unused entry point —
but it must not be left unresolved if `resolve` ever becomes reachable.

**G9 — Host mutations applied to the image *before* the tree is emitted.**
Not a `sffs.rs` gap; a gap in the "kernel parses the image" model. VERIFIED
three sites mutate the restored `MemoryFileSystem` between restore and manifest
emission:
1. `normalizeLegacyRootfs` (`default-mounts.ts:160-168`, called from
   `restoreVerifiedImageMounts:281`) — appends `nobody:x:65534:` to
   `/etc/group` for already-published dinit demo images.
2. `ensureMountParentDirectories` (`default-mounts.ts:187-210`; called
   `node-kernel-worker-entry.ts:1202`) — `mkdir`s parents of extra mounts.
3. Browser only: writes a TLS cert into the image
   (`browser-kernel-worker-entry.ts:1170-1179`).

A kernel parsing the raw image sees none of these. Each is either re-expressible
in the kernel (2 is trivial — the overlay already receives
`foreignMountPrefixes`; 3 is a `rootfs_write_file`) or is an explicit
compatibility shim (1). See NEEDS-DEFER-DECISION D3.

**G10 — zstd.** Real distributed images are `.vfs.zst` (`shell`, `wordpress`,
`kandelo-sdk`, …). `sffs.rs:3` states "Consumes DECOMPRESSED bytes (zstd is a
host-side transport codec)"; `memory-fs.ts:900` (`maybeDecompressImage`) does
the decompression. Keeping zstd host-side is defensible as transport, but it
means "the host supplies only bytes" concretely means "the host supplies
*decompressed* bytes", and the host keeps `fzstd`. Not a blocker; stated so the
V3 claim stays honest.

**G11 — Not gaps.** Hard links need no special code (dirents point at inodes;
VERIFIED none exist in current images, and the mechanism works by
construction). Symlinks (inline and block-backed) are covered. Compression of
*file data* does not exist in SFFS — only whole-image zstd.

---

## 2. Q2 — How the kernel receives image bytes today, and whether that shape suffices

### 2.1 The existing byte-provider design

`rootfs.rs` already treats the host as a raw-byte transport. One enum, one
closure:

```rust
// crates/runtime-core/src/rootfs.rs:1201-1208
pub enum ByteReq {
    Base    { blob_id: u64, offset: u64 },   // a rootfs base file's bytes
    Archive { archive_id: u32, offset: u64 }, // a whole lazy archive
}
```

The closure is `FnMut(ByteReq, &mut [u8]) -> Result<usize, Errno>`. It is
constructed at exactly **8 call sites**, all shaped identically:

- `crates/runtime-core/src/syscalls.rs:5035`, `:5299`, `:5831`, `:6282`, `:17055`
- `crates/runtime-core/src/exec_target.rs:558`
- `crates/kernel/src/wasm_api.rs:1611`, `:1661`

Each routes to `HostIO::blob_read` / `HostIO::fetch_archive`
(`process.rs:67`, `:78`; implemented by `WasmHostIO` at `wasm_api.rs:377`,
`:392`), which call the imports:

```
env.host_blob_read(blob_id_lo, blob_id_hi, buf_ptr, buf_len, offset_lo, offset_hi) -> i32
env.host_fetch_archive(archive_id, buf_ptr, buf_len, offset_lo, offset_hi) -> i32
```

Host side: `kernel.ts:2746-2792` (`#hostBlobRead`) and `:2795-2830`
(`#hostFetchArchive`) stage into a buffer outside kernel memory, then publish
once. Providers are installed by `setRootfsBlobProvider` /
`setRootfsArchiveProvider` (`kernel.ts:972`), wired from
`kernel-worker.ts:5115`, built by `createRootfsBlobProvider`
(`rootfs-manifest.ts:323-354`), which maps `blob_id → backend path → memfs
positioned read`, and translates a not-yet-materialized lazy leaf to `-EAGAIN`
so the kernel parks and retries.

`host_blob_read` is therefore **already exactly the right shape**: a positioned
read of `buf_len` bytes at `offset` from an opaque 64-bit id. The census (§6,
"image bytes | 2 | 2 | already correct") is accurate.

### 2.2 Is it sufficient for `sffs` parsing? — **No, not as `sffs.rs` is written**

`Sffs<'a>` (`sffs.rs:77-81`) holds `bytes: &'a [u8]` — a **fully resident
slice**. `mount`, `stat_ino`, `block_map`, `read_at`, `read_dir` all index it
directly. There is no seam through which a byte callback could serve blocks.

So wiring `sffs.rs` requires one of:

**(a) Make the image resident in kernel memory.** Feasible for the base image;
**not** feasible in general. VERIFIED superblock geometry:

| image | SAB (must be resident) | inode table | used data blocks |
|---|---|---|---|
| `host/wasm/rootfs.vfs` | 16 MiB | 2 MiB | 3.3 MiB |
| `shell.vfs.zst` | 16 MiB | 2 MiB | 12.0 MiB |
| `wordpress.vfs.zst` | **208 MiB** | 6 MiB | **207 MiB** |
| `kandelo-sdk.vfs.zst` | **256 MiB** | — | — |

`KERNEL_MEMORY_MAX_PAGES = 16384` (1 GiB, `host-native/src/lib.rs:54`). A
208–256 MiB resident copy *fits*, but it doubles the image footprint while the
host still holds its own decompressed copy, on a platform with a recorded
image-switch OOM history in WebKit. This is a STRONG DOUBT (§11, SD-1).

**(b) Refactor `sffs.rs` to a block-source abstraction** — replace `bytes:
&'a [u8]` with a `trait BlockSource { fn block(&mut self, n: u32) -> Result<&[u8], Errno> }`
(or `fn read_at(&mut self, off: u64, dst: &mut [u8])`) plus a small LRU of
4 KiB blocks, and serve it from `ByteReq`. This is the shape that keeps "host
supplies only bytes" literally true at any image size. It is a **real rewrite
of `sffs.rs`'s internals** — every `self.bytes[...]` index becomes a fallible
block fetch — but it is confined to that one 512-line file and its 15 tests.

**(c) Hybrid: resident inode table + streamed data.** The tree build needs the
superblock, the inode table (2–6 MiB), and the directory data blocks; file
*content* blocks are only needed on `read()`. Cheapest resident set is a few
MiB even for wordpress. This is (b) with a deliberate pinning policy.

**No new host import is needed for any of these** — see Q6.

---

## 3. Q3 — The current boot path for an image, end to end

Traced through the Node entry; the browser entry is the same algorithm (this is
census F1 — the two entries duplicate 54 functions).

```
 1. image bytes arrive as `msg.rootfsImage` (Node, node-kernel-worker-entry.ts:1489)
    or `msg.vfsImage` (browser, browser-kernel-worker-entry.ts:1104)

 2. buildVirtualPlatformIO(...)                    node-…-entry.ts:1147
      └─ resolveForNodeKernelSession(DEFAULT_MOUNT_SPEC, imageBytes, …)
           └─ restoreVerifiedImageMounts()         default-mounts.ts:260-283
                └─ restoreVerifiedVfsImage()       load-image.ts:24-31
                     ├─ MemoryFileSystem.fromImage()          memory-fs.ts:7220
                     │    ├─ parseImageHeader()               memory-fs.ts:897-927
                     │    │     magic "VFSI", version 1, flags, sabLen
                     │    │     (zstd auto-detect: maybeDecompressImage)
                     │    ├─ new SharedArrayBuffer + copy SAB slice
                     │    ├─ SharedFS.mount()                 sharedfs-vendor.ts:502
                     │    ├─ lazy JSON  → lazyFiles map        memory-fs.ts:4531,4588
                     │    ├─ archive JSON → lazyArchiveInodes  memory-fs.ts:4813,5007
                     │    └─ metadata JSON (kernelAbi …)       memory-fs.ts:7267
                     └─ verifyImportedLazyAtomicGroupSeals()   (sha256 cohort auth)
           └─ normalizeLegacyRootfs(fs)            default-mounts.ts:160  ← MUTATES
 3. ensureMountParentDirectories(rootfsMemfs, …)   node-…-entry.ts:1202   ← MUTATES
    rewriteLazyFileUrls / rewriteLazyArchiveUrls   node-…-entry.ts:1204-1205
    setLazyFetcher(…)                              node-…-entry.ts:1226
 4. drop the `/` host mount; keep the memfs alive
    only as the blob byte store                    node-…-entry.ts:1229-1239

 5. buildRootfsLazyWiring(memfs.exportLazyArchiveEntries(), fetcher)
                                                   node-…-entry.ts:1494
 6. emitRootfsManifest(memfs, p=>p, lazyInput)     rootfs-manifest.ts:172-293
       ── walks the WHOLE tree via backend.opendir/readdir/lstat/readlink
       ── emits "RTFS" v3: header + parent-first entries + archive table
       ── returns blobPaths: Map<ino, backendPath>
 7. kernelWorker.configureRootfsOverlay(buffer, blobProvider, archiveProvider,
                                        foreignPrefixes, nosuid)
                                                   kernel-worker.ts:5039-5052
 8. kernelWorker.init(kernelWasmBytes)
       └─ #maybeLoadKernelRootfs(instance)         kernel-worker.ts:5063-5140
            kernel_set_rootfs_now(...)
            ptr = kernel_alloc_scratch(len); copy manifest into kernel memory
            kernel_rootfs_load_manifest(ptr, len)  wasm_api.rs:1518
                 └─ rootfs::load_manifest()        rootfs.rs:968-1046
                      insert_base_dir / insert_base_file /
                      insert_base_symlink / insert_lazy_file + set_base_times
            setRootfsBlobProvider / setRootfsArchiveProvider
            kernel_rootfs_set_foreign_prefixes(...)
            kernel_set_rootfs_enabled(1)
```

**Who parses what, today:**

| layer | parsed by |
|---|---|
| zstd frame | TypeScript (`memory-fs.ts:900`) |
| VFSI header + flags + section framing | TypeScript (`memory-fs.ts:897-965`) |
| SFFS superblock / inodes / dirents / block map | TypeScript (`sharedfs-vendor.ts`) |
| lazy-file JSON, lazy-archive JSON (+ sha256 seals) | TypeScript (`memory-fs.ts`) |
| image metadata JSON (the ABI stamp) | TypeScript (`memory-fs.ts:7122`) |
| **RTFS manifest** | **Rust** (`rootfs.rs:968`) |
| the tree, permissions, times, lookups, reads, COW | **Rust** (`rootfs.rs`) |
| lazy-archive **zip** decode + inflate | **Rust** (`rootfs.rs:1210+`, `zip.rs`) |

The kernel already owns the tree and the zip decode. It does not own the image
format. That is precisely census F3.

---

## 4. Q4 — Where sffs wiring plugs in, and what it touches

### 4.1 The integration point is `rootfs.rs`'s base-tree inserters — not `syscalls.rs`

`load_manifest_inner` (`rootfs.rs:977-1046`) is a *parser* that drives four
inserters:

```rust
insert_base_dir(&path, mode, uid, gid, ino)
insert_base_file(&path, blob_id, size, mode, uid, gid, ino)
insert_base_symlink(&path, &target, mode, uid, gid, ino)
insert_lazy_file(&path, archive_id, &source_path, size, mode, uid, gid, ino)
set_base_times(&path, mtime_sec, mtime_nsec)
```

An SFFS-driven builder is a **second parser calling the same four inserters**.
It is additive next to `load_manifest`, in the same module. This is the whole
integration point.

`sffs.rs` already supplies everything those inserters need:
`SffsStat { mode, nlink, size, mtime_ms, ctime_ms, atime_ms, uid, gid, ino,
generation }` (`sffs.rs:60-71`) plus `read_dir` and `read_link`. The `blob_id`
convention is already "the file's inode number"
(`rootfs-manifest.ts:26-31`, `:267-268`), which is exactly what `sffs` hands
back — so `BaseRegular { blob_id: ino, size }` is produced identically.

### 4.2 What it touches in `syscalls.rs` (46,885 lines) — precisely

**Nothing, if `ByteReq` is left unchanged.** The only `syscalls.rs` coupling to
this subsystem is the five exhaustive `match req` closures:

| line | context |
|---|---|
| `syscalls.rs:5035` | `read()` on a rootfs file handle |
| `syscalls.rs:5299` | `write()` — COW read-before-write of a base file |
| `syscalls.rs:5831` | `pread`-shaped positioned read |
| `syscalls.rs:6282` | (byte-source closure) |
| `syscalls.rs:17055` | (byte-source closure) |

Plus `exec_target.rs:558` and `wasm_api.rs:1611`, `:1661`. Each is a 3–6 line
`match` on `ByteReq::Base` / `ByteReq::Archive`.

**Adding a `ByteReq` variant (e.g. `Image { offset }`) means editing all 8
sites** — mechanical, ~5 lines each, but it *is* a `syscalls.rs` edit and
should be stated as such. The alternative (§6) avoids it entirely.

The other 143 `crate::rootfs::` references in `syscalls.rs` are unaffected:
they call `claims_path`, `lstat`, `open`, `read`, `write`, `statfs`, handle
predicates — all of which operate on the tree `rootfs.rs` owns, regardless of
which parser built it.

### 4.3 Other files touched

| file | change |
|---|---|
| `crates/runtime-core/src/rootfs.rs` | new `load_sffs_image` beside `load_manifest`; reuse the four inserters |
| `crates/runtime-core/src/sffs.rs` | block-source refactor (§2.2b) unless the image is resident |
| `crates/kernel/src/wasm_api.rs` | one new export (`kernel_rootfs_load_image`) → `abi/snapshot.json` regen |
| `host/src/kernel-worker.ts:5063-5140` | supply the image the way it supplies the manifest today |
| `host/src/{node,browser}-kernel-worker-entry.ts` | stop calling `emitRootfsManifest`; hand raw bytes instead (**both**, per the host-runtime contract) |
| `host/src/vfs/rootfs-manifest.ts` | the walker becomes dead at cutover; the blob provider is replaced by a raw-image provider |
| `crates/host-native/src/guest.rs:1375-1500` | keeps using RTFS (its `build_manifest_from_dir` synthesizes a manifest from a directory, not from an image) — **RTFS must not be deleted in K1** |

---

## 5. Q5 — Real VFS images available in this worktree

VERIFIED present:

| path | bytes | shape |
|---|---|---|
| `crates/runtime-core/src/testdata/tiny.vfs` | 262,164 | committed fixture; `sffs.rs`'s 14 unit tests use it |
| `crates/runtime-core/src/testdata/rtfs-v3-lazy.bin` | 280 | **TS-emitted** RTFS v3 fixture (see below) |
| `crates/runtime-core/src/testdata/tiny.zip` | 517 | zip fixture |
| `host/wasm/rootfs.vfs` | 16,788,017 | real base rootfs, ABI 44, 375 entries, 65 lazy files |
| `local-binaries/source-only-v1/programs/wasm32/rootfs.vfs` | 16,788,017 | same |
| `.../shell.vfs.zst` | 19,569,484 | 9,159 entries, 79 lazy files, 2.78 MB archive metadata |
| `.../wordpress.vfs.zst` | 220,896,397 | 15,378 entries, 208 MiB SAB |
| `.../kandelo-sdk.vfs.zst` | 268,435,551 | 2,438 entries, 256 MiB SAB, no lazy |
| `.../{lamp,nginx-vfs,nginx-php-vfs,node-vfs,mariadb-test}.vfs.zst` | — | additional demo images |

`sffs.rs:487-511` already has `real_rootfs_image_lists_root_and_reads_passwd`,
which probes both `rootfs.vfs` candidate paths and **skips** if absent. VERIFIED
it ran (both paths exist) and passed.

**The pattern to copy for cross-authority fixtures** is `rootfs.rs:3153-3193`
(`load_manifest_ts_emitted_v3_fixture_round_trips`): a fixture emitted by the
*real* TypeScript emitter, committed under `testdata/`, regenerated by
`host/scripts/gen-rtfs-v3-fixture.mts`, with the comment "If the TS emitter and
this loader ever disagree on the v3 wire format, this test — not just the
hand-built byte vectors above — is what catches the drift." K1 wants the same
device pointed the other way: a *tree-equality* fixture asserting the Rust
SFFS builder and the TS walker agree.

---

## 6. Q6 — Does wiring sffs require a host-contract change?

**No new `env.host_*` import is required, and no import signature changes.**
This is the strongest part of K1's case.

Two viable delivery shapes, neither of which grows the contract:

**(A) Push, via a new kernel *export*** — `kernel_rootfs_load_image(ptr, len)`,
sitting beside `kernel_rootfs_load_manifest` (`wasm_api.rs:1518`). The host
already does exactly this dance for the manifest at `kernel-worker.ts:5104-5108`
(`kernel_alloc_scratch` → copy → call). An export is not an import; the host
API surface (85 `host_*`) is unchanged, and `EXPECTED_HOST_IMPORT_COUNT = 84`
does not move. Requires `abi/snapshot.json` regeneration (additive). Only
viable if the image is resident (SD-1).

**(B) Pull, reusing `host_blob_read` unchanged.** Its signature is already
"positioned read of `buf_len` bytes at `offset` from an opaque `u64` id"
(`kernel.ts:2746`). Serving raw image bytes needs only a differently-shaped
*provider* on the host — a memcpy out of the decompressed image buffer —
replacing `createRootfsBlobProvider`'s `ino → path → memfs read`. Same import,
same arity, same types, **strictly simpler host semantics**, and it deletes the
host's `blobPaths` map and (eventually) its need to hold a `MemoryFileSystem`
at all.

Shape (B) does change what `blob_id` *means*. Per `docs/agent-guidance/abi.md`
("Changing an existing syscall's meaning, errno behavior, blocking behavior, fd
inheritance, memory ownership, or pointer interpretation can require an ABI
bump even if the snapshot is unchanged"), that is a **semantic ABI change**.
Whether it needs an `ABI_VERSION` bump or rides the unreleased ABI-44 epoch is
the maintainer's call (NEEDS-DEFER-DECISION D4). It is *not* a growth of the
host contract.

Direction of travel is **down**: at full cutover, `host_blob_read` becomes the
image-bytes import, `host_fetch_archive` stays, and the host stops resolving
inode numbers to paths — one fewer concept a host author must implement.

---

## 7. Q7 — What the ABI stamp actually gates today

### 7.1 Where it is written

`scripts/build-rootfs.sh:197`:

```sh
metadata_args=(--kernel-abi "$ABI_VERSION")
if [ -n "${ROOTFS_ABI_SNAPSHOT_SHA256:-}" ]; then
    metadata_args+=(--abi-snapshot-sha256 "$ROOTFS_ABI_SNAPSHOT_SHA256")
fi
```

→ `tools/mkrootfs/src/cli/build.ts:132-137` parses the flags, `:254-262`
packs them into `VfsImageMetadata { version: 1, kernelAbi, abiSnapshotSha256?,
createdBy }` → `builder.ts:70,123` → `MemoryFileSystem` serializes it as the
trailing JSON metadata section (`memory-fs.ts:7071-7100`, flag `1 << 2`).

VERIFIED in the shipped artifacts: `host/wasm/rootfs.vfs` carries
`{"version":1,"kernelAbi":44,"createdBy":"mkrootfs build"}`. `wordpress.vfs.zst`
carries a nested `"baseImage":{…,"kernelAbi":44}` as well.
**`--abi-snapshot-sha256` is not present in any image in this worktree** — only
`--kernel-abi` is actually being stamped today.

### 7.2 Where it is enforced

Three readers, and **none of them is the runtime load path**:

| site | what it does | live? |
|---|---|---|
| `host/src/binary-resolver.ts:2911-2926` (`hasVfsArtifactPolicyFailuresForBytes`) | `readImageMetadata(bytes)?.kernelAbi !== ABI_VERSION` → treat the artifact as a policy failure; fail-closed on any inspection error | **yes** — artifact resolution / cache invalidation |
| `host/src/vfs/memory-fs.ts:7158-7170` (`assertImageKernelAbi`) | throws on mismatch, tolerates an absent declaration | **no caller in `host/src`, `web-libs`, `apps`, `tools`, `scripts`, or `images`** (VERIFIED by repo-wide grep excluding `dist`/`node_modules`) |
| `scripts/vfs-has-stale-abi.mjs` | standalone CLI, "the shell resolver" peer of the TS check | **no caller anywhere.** VERIFIED: the only repo-wide references are its own usage string (`:100`) and two CI *path-scope* lists (`.github/actions/detect-change-scope/{ci-scope-paths.sh:77,test-ci-scope-paths.sh:190}`) |

`tools/mkrootfs/src/cli/inspect.ts:226` also reads it, for display only.

### 7.3 What depends on the stamp

- **`binary-resolver.ts`.** An ABI bump makes every stamped `.vfs`/`.vfs.zst`
  in the binary index resolve as stale, forcing a rebuild through the normal
  package path. This is the stamp's real job today, and it is a *build/cache*
  function, not a *runtime* function.
- **`docs/agent-guidance/abi.md`** explicitly lists "VFS image metadata that
  binds images carrying Wasm programs to a kernel ABI" as ABI surface.
- **The reason the stamp exists at all is that images carry Wasm programs.** An
  image's `/usr/bin/*.wasm` must match the running kernel's ABI. Note that the
  *program* also carries its own ABI custom section, checked independently:
  `worker-main.ts:4827` / `:5577` (`verifyProgramAbi`) and
  `node-kernel-worker-entry.ts:1109-1122` (`describeWasmArtifactPolicyFailures`
  + `extractAbiVersion`, → `ENOEXEC` on mismatch).

**Consequence for V3:** the per-image stamp is *redundant with* the per-program
check at runtime, and is load-bearing only for build-time artifact freshness.
That is a much smaller dependency than "an ABI change breaks images" suggests —
and it means removing the stamp is mostly a `binary-resolver.ts` + build-cache
question, not a runtime-safety question. Two dead readers
(`assertImageKernelAbi`, `vfs-has-stale-abi.mjs`) can go with it.

---

## 8. The dormant-flag-then-cutover pattern: does it apply?

**Yes, and better than for most items**, because `rootfs.rs` already has the
machinery:

- `rootfs::set_enabled(bool)` (`rootfs.rs:560`) and
  `kernel_set_rootfs_enabled` (`wasm_api.rs:1530`) — the gate `tmpfs.rs`
  established and Phase 5 used.
- `rootfs::reset()` (`:667`) — `load_manifest` already resets on any error so a
  partial tree is never left behind (`:968-976`). An SFFS builder inherits that
  discipline for free.
- `kernel_rootfs_export_tree` (`wasm_api.rs:1695`, "RXPT" format, `rootfs.rs`
  §Tree export) — **already serializes the whole overlay tree for the host.**
  That is a ready-made *parity oracle*: build the tree from RTFS, export;
  build it from SFFS, export; assert byte equality. No new export needed for
  the comparison itself.

So the dormant phase is: `load_sffs_image` exists, is called with the image,
builds a *shadow* tree, and the two exports are diffed — with RTFS still the
live authority. The flip is one call-site change plus deleting
`emitRootfsManifest`'s two call sites.

---

## 9. Honest sizing: K1 is **bigger** than "wire ~500 lines of finished Rust"

The value plan (§5) says *"~500 lines of Rust already written and reviewed…
Unblocks the entire bundle architecture for almost no risk. Highest value/risk
ratio in the campaign."* The value/risk judgement still looks right. The
*size* does not.

**Confirmed small / already done:**
- The SFFS binary layer is genuinely complete and correct on real images at
  production scale (§1.2, VERIFIED).
- The integration seam is four existing inserter functions (§4.1).
- No `syscalls.rs` change is needed under the recommended shape (§4.2).
- No new host import (§6).
- A parity oracle already exists (§8).

**Newly discovered work, none of which the plan text anticipates:**
1. **`sffs.rs`'s resident-`&[u8]` API does not fit a byte-provider** (§2.2).
   Either accept a 208–256 MiB resident copy or refactor the file's internals
   to a block source. Real work in the one file, plus its 15 tests.
2. **Lazy stubs are size-0 in SFFS** (§1.3, G3). The kernel cannot produce
   today's tree from the SFFS layer alone. The lazy linkage is JSON in the
   VFSI trailer — 10 KB for the base image, **2.78 MB** for shell/wordpress,
   including sha256 integrity, mount prefixes, atomic-group seals, and three
   `kandelo-deferred-tree-v{1,2,3}` schema kinds.
3. **Three host mutations happen between restore and manifest emission** (§1.3,
   G9) and would be lost.
4. **`host-native` builds RTFS manifests from a directory, not from an image**
   (`guest.rs:1375-1500`), so RTFS must survive K1 rather than be replaced.

Item 2 is the one that changes the shape of the work. A truthful K1 either
stops at the concrete-tree layer and keeps a *reduced* host-supplied lazy
linkage, or grows to include a no_std JSON parser and the deferred-tree schema.
That is a maintainer decision, not mine (D1).

---

## 10. Proposed implementation plan — ordered, independently testable increments

Each increment is landable and green on its own. Validation commands are exact.
`<host-target>` = `rustc -vV | awk '/^host/ {print $2}'` (here
`aarch64-apple-darwin`).

### K1.0 — Baseline evidence (no production code)

Extend `sffs.rs`'s test module with a **full-tree walk** over the real images
present in the worktree (skipping cleanly when absent, as `:487-495` already
does): assert entry counts and per-entry `(path, type, mode, uid, gid, size,
symlink target)` against a committed expectation generated from
`mkrootfs inspect`. This pins today's VERIFIED exact match (§1.2) as a
regression test before anything moves.

```
bash scripts/dev-shell.sh -- cargo test -p runtime-core --target <host-target> --lib sffs
```

### K1.1 — Decide and implement the byte-delivery shape

**Blocked on SD-1 / D2.** Either:
- resident: add `kernel_rootfs_load_image(ptr, len)` + snapshot regen; or
- streaming: refactor `Sffs` onto a `BlockSource` trait with a bounded block
  cache, keeping a `&[u8]` impl so all 15 existing tests still pass unchanged.

```
bash scripts/dev-shell.sh -- cargo test -p runtime-core --target <host-target> --lib sffs
bash scripts/check-abi-version.sh          # if an export was added
```

### K1.2 — `rootfs::load_sffs_image` (dormant)

New function beside `load_manifest`, driving `insert_base_dir` /
`insert_base_file` / `insert_base_symlink` / `set_base_times` from an `Sffs`
pre-order walk. Not called by anything yet. `reset()`-on-error discipline
copied from `load_manifest` (`:968-976`).

```
bash scripts/dev-shell.sh -- cargo test -p runtime-core --target <host-target> --lib rootfs
```

### K1.3 — Parity oracle in Rust

A `#[cfg(test)]` test that, for `tiny.vfs` and (when present) the real
`rootfs.vfs`: builds the tree via `load_manifest` from a TS-emitted RTFS
fixture, snapshots `export_tree()`; resets; builds via `load_sffs_image` from
the same image; asserts the two RXPT buffers are byte-identical modulo the
known lazy/mutation deltas, which the test must **enumerate explicitly** rather
than mask.

```
bash scripts/dev-shell.sh -- cargo test -p runtime-core --target <host-target> --lib rootfs
```

### K1.4 — Lazy linkage

**Blocked on D1.** Whichever answer: either the kernel parses the VFSI lazy
section, or the host supplies a *lazy-only* RTFS-shaped linkage (a small
subset of today's manifest) and `load_sffs_image` takes it as a second
argument. Either way the acceptance test is that `/usr/bin/bash` in
`host/wasm/rootfs.vfs` stats as 3,028,830 bytes, not 0.

```
bash scripts/dev-shell.sh -- cargo test -p runtime-core --target <host-target> --lib
```

### K1.5 — Host wiring, both hosts, still dormant

`kernel-worker.ts` gains an image-supply path beside
`configureRootfsOverlay`; **both** `node-kernel-worker-entry.ts` and
`browser-kernel-worker-entry.ts` supply it (host-runtime contract: no
Node-first landing). RTFS still drives the live tree.

```
cd host && npx vitest run
```

### K1.6 — Cutover

Flip the live path to `load_sffs_image`; re-express the three host mutations
(G9) inside the kernel or document each as a compatibility boundary; keep
`load_manifest` for `host-native`.

```
bash scripts/dev-shell.sh -- cargo test --workspace --exclude xtask --target <host-target>
cd host && npx vitest run
cd apps/browser-demos && npx playwright test --grep-invert "@slow" --project=chromium
./run.sh browser        # manual verification of a real image boot
bash scripts/check-abi-version.sh
```

Boot time is a real risk under the streaming shape (a tree build that was one
host→kernel crossing becomes many). **Measure before claiming anything:**
`docs/agent-guidance/performance.md` governs; no "neutral" without numbers.

### K1.7 — Retire the stamp

Only after the above. Remove `--kernel-abi` stamping, the
`binary-resolver.ts:2911` check, the dead `assertImageKernelAbi`, and the dead
`scripts/vfs-has-stale-abi.mjs`; re-express image freshness against the
kernel↔host contract. Touches `tools/mkrootfs` and `scripts/`, which the value
plan puts **out of scope** — so this increment is a scope question (D5), not a
free tail.

---

## 11. STRONG DOUBT

**SD-1 — The kernel cannot hold every image in memory.**
`wordpress.vfs.zst` restores a **208 MiB** SAB and `kandelo-sdk.vfs.zst` a
**256 MiB** one (VERIFIED from their superblocks). `KERNEL_MEMORY_MAX_PAGES`
is 1 GiB (`host-native/src/lib.rs:54`). A resident copy fits arithmetically but
duplicates the image while the host still holds its decompressed original, on a
platform with a recorded WebKit image-switch reclaim problem. **The
"kernel-owns-the-format" model holds — but only in the streaming form.** The
resident form is the shape `sffs.rs` is written for today, so this is a
genuine, unresolved tension between the finished code and the architecture.

**SD-2 — `sffs.rs`'s public API is incompatible with the byte-provider it is
supposed to consume.** `Sffs<'a> { bytes: &'a [u8] }` (`sffs.rs:77-81`). This
is not a wiring gap; it is a design mismatch. Whoever wrote the census entry
"~500 lines of Rust already written and reviewed, referenced by nothing"
appears not to have checked this. It does not invalidate K1 — it re-sizes it.

**SD-3 — A no_std JSON parser in the kernel would be a large new surface.** If
D1 resolves toward "the kernel parses the VFSI lazy sections", the kernel takes
on parsing up to 2.78 MB of JSON carrying sha256 integrity records,
mount-prefix validation, atomic-group seals, and three schema versions
(`kandelo-deferred-tree-v{1,2,3}`, `kandelo-legacy-zip-v1`). This is untrusted
input with a security contract (the ledger classifies boot-descriptor
validation as MIGRATE for exactly that reason), so it is defensible — but it is
a **new parser subsystem**, not an incidental addition, and it belongs to K8's
budget more naturally than K1's.

**SD-4 — Lock-free reads of a buffer the host still mutates.** `sffs.rs`
implements none of `SharedFS`'s `Atomics` discipline (G5). During the dormant
phase both readers touch the same bytes. Benign only if the host performs no
mutation while the kernel reads. The three known mutations (G9) all happen at
boot, before `init`, so the window is probably clean — but this is INFERRED
from call ordering, not proven by a test, and it should be proven.

**No ABI_VERSION bump is *demanded* by K1's mechanics.** Adding an export is
additive (snapshot regen only). Repurposing `host_blob_read`'s `blob_id`
semantics is a judgement call under `abi.md` — see D4.

---

## 12. NEEDS-DEFER-DECISION

Per the standing rule, I am not deciding any of these. Each is written with
what / why / cost now / cost of deferring / my recommendation.

### D1 — Who owns the VFSI lazy sections?

- **What.** The lazy-file JSON and lazy-archive JSON in the VFSI trailer are
  the only source of a lazy file's real size, fetch URL, and
  `(ino, generation, dataSequence)` identity. `sffs.rs` parses neither.
- **Why it must be decided now.** Without an answer, K1 cannot produce a
  correct tree: `/usr/bin/bash` would stat as 0 bytes (VERIFIED). Every
  downstream increment depends on the choice.
- **Cost of doing it now (kernel owns it).** A no_std JSON parser plus the
  deferred-tree schema, integrity records, and atomic-group seals — SD-3.
  Plausibly comparable in size to everything else in K1 combined.
- **Cost of deferring (host keeps supplying lazy linkage).** K1 ships a
  *hybrid*: the kernel owns the SFFS binary layer and the concrete tree; the
  host still emits a reduced, lazy-only manifest. V3 is advanced but not
  completed, and the phrase "the kernel parses the image" would be only
  partly true — which the docs must say plainly.
- **Recommendation.** Take the hybrid for K1 and give the lazy layer to K8,
  where `memory-fs.ts`'s 11,950 lines are already scheduled to move. Rationale:
  it keeps K1's Tier-1 risk profile, it delivers the actual V3 enabler (the
  kernel owns the format that the *tree* lives in), and it does not smuggle a
  JSON+crypto subsystem into an item advertised as "almost no risk". But this
  makes K1 a partial V3 step, and only the maintainer should accept that.

### D2 — Resident image or streaming block source?

- **What.** §2.2 (a) vs (b)/(c).
- **Cost now (streaming).** Refactor `sffs.rs`'s internals; design a block
  cache; measure boot-time regression on both hosts.
- **Cost of deferring (resident, streaming later).** Ships faster and matches
  the code as written, but adds 208–256 MiB of kernel-resident memory for the
  large demo images, and the refactor is then done later under more coupling.
- **Recommendation.** Streaming, with a resident fast path for small images if
  measurement justifies it. Reason: it is the only shape in which the V4
  sentence "the host supplies only bytes" is true at every image size, and
  SD-1 makes the resident shape a boundary rather than a design.

### D3 — The three pre-manifest host mutations (G9)

- **What.** `normalizeLegacyRootfs` (`/etc/group` nobody fixup),
  `ensureMountParentDirectories`, and the browser TLS-cert write.
- **Cost now.** (2) and (3) are straightforward to re-express in the kernel.
  (1) is a compatibility shim for already-published demo images and must either
  move into the kernel as a documented boundary or be dropped, which changes
  behavior for those images.
- **Cost of deferring.** The host keeps a writable `MemoryFileSystem` purely to
  apply three edits, which undercuts the "retire memory-fs.ts as a reader"
  goal.
- **Recommendation.** Move (2) and (3) into the kernel during K1.6; raise (1)
  separately as an explicit compatibility-boundary decision. It is a
  package/demo-compat question, not a platform question, and it should be
  decided as one.

### D4 — Does repurposing `host_blob_read`'s `blob_id` need an `ABI_VERSION` bump?

- **What.** Shape (B) in §6 keeps the signature and changes the meaning.
- **Cost now (bump).** Re-instrumentation and package rebuilds — which the
  campaign says are available (value plan §3.1).
- **Cost of deferring (ride ABI 44).** A semantic change lands under an
  existing `ABI_VERSION`, which `abi.md` warns against; if ABI 44 is truly
  unreleased the risk is nil, but the precedent is bad.
- **Recommendation.** Ride ABI 44 *if and only if* the maintainer confirms 44
  is unreleased and this is the same epoch as the fork campaign's other
  semantic changes; otherwise bump. Either way, record the decision in
  `docs/abi-versioning.md` rather than leaving it implicit.

### D5 — Is stamp removal (K1.7) in scope?

- **What.** `--kernel-abi` is written by `tools/mkrootfs` and enforced by
  `host/src/binary-resolver.ts` and (dead) `scripts/vfs-has-stale-abi.mjs`.
  The value plan §1 puts `tools/mkrootfs` and `scripts/` **out of scope**, but
  §8 makes "images carry no guest-ABI stamp" a definition-of-done for V3.
- **Cost now.** A small toolchain excursion, plus deciding what replaces the
  build-cache freshness signal the stamp currently provides.
- **Cost of deferring.** V3's definition of done stays unreachable inside this
  campaign's declared scope — a stated contradiction, not a discovered one.
- **Recommendation.** Carve out the stamp specifically as an in-scope exception,
  since it is ABI surface (`abi.md`) rather than build tooling. But flag that
  the two dead readers (`assertImageKernelAbi`, `vfs-has-stale-abi.mjs`) can be
  deleted immediately and independently — that part is pure subtraction with no
  scope question at all.

---

## 13. One-line summary for the campaign ledger

`sffs.rs` is **verified correct** on real production images (exact tree match
against the TypeScript authority, 375/9,159/15,378-entry images, zero decode
errors), plugs into `rootfs.rs`'s four existing base-tree inserters with **no
`syscalls.rs` change and no new host import** — but it is **not** a drop-in:
its resident-`&[u8]` API does not fit the byte-provider (SD-1/SD-2), and lazy
stubs carry size 0 in the SFFS layer so the VFSI lazy sections must be owned by
someone (D1). K1 is a real, high-value, Tier-1 item, and it is larger than
"wire 500 finished lines".

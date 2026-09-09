# K1b Grounding — Should the VFSI trailing JSON exist at all?

> Read-only grounding pass, 2026-09-09. Worktree
> `/Users/brandon/kandelo-abi44-reconcile`, branch
> `brandonpayton/rust-first-abi44-reconcile` (head of PR #1350).
> **No code was changed.** This file is the only file written.
>
> Companion to `2026-09-09-k1-sffs-wiring-grounding.md` (whose gaps G2/G3 and
> STRONG DOUBTs SD-1..SD-4 this pass re-tests),
> `2026-09-09-rust-first-value-plan.md` (V3, the Bar), and
> `2026-09-09-whole-kernel-rust-migration-census.md` (§3 F3, §7).

## 0. What was VERIFIED vs INFERRED, and what re-testing changed

The campaign has four times inherited a "floor" that was false on re-test. Three
of the prior grounding's four STRONG DOUBTs move on re-measurement.

**Commands actually run:**

```
bash scripts/dev-shell.sh -- cargo test -p runtime-core \
    --target aarch64-apple-darwin --lib sffs
    → 15 passed; 0 failed   (re-verified, not inherited)

node tools/mkrootfs/bin/mkrootfs.mjs inspect <image> --format json
    → run on host/wasm/rootfs.vfs and shell.vfs
```

Plus three throwaway Node scripts in the session scratchpad (**not** committed):
a VFSI trailing-section dumper, a per-field/per-section size accountant, and a
full SFFS tree walker that re-implements `crates/runtime-core/src/sffs.rs`'s
exact decoding rules (superblock validation, `inode_offset`, `stat_ino` with the
`nlink == 0` free-slot rule, `block_ptr_in`, `block_map` incl. single- and
double-indirect, `read_at` with sparse holes, `read_dir` with the identical
`isValidDirEntry` predicate, inline `read_link`) and **instruments which
physical blocks a tree build actually touches**. All nine production images in
the worktree were decoded. Results below labelled VERIFIED come from these runs.

**Not run:** Vitest, Playwright, `cargo test --workspace`, libc/posix/sortix,
`scripts/check-abi-version.sh`, any benchmark, any browser session. This is a
grounding pass. No behavior claim is made about the branch as a whole.

**Incidental correction to the prior grounding.** Its §5 table lists e.g.
`shell.vfs.zst | 19,569,484` bytes. That is the **decompressed** size; the file
on disk is 1,426,809 bytes. Same for the other `.zst` rows. Cosmetic, but the
compression ratios matter to §7's cost discussion, so it is corrected here.

---

## 1. Q1 — What is EXACTLY in the trailing JSON

### 1.1 The container, re-derived from bytes (Q3 answered here too)

`MemoryFileSystem.toImage` (`host/src/vfs/memory-fs.ts:7066-7118`) writes, and
`restoreParsedImage` (`:7229-7315`) reads:

```
+0    u32  magic 0x56465349 "VFSI"
+4    u32  version = 1
+8    u32  flags
+12   u32  sabLen = N
+16   N    raw SharedArrayBuffer (the SFFS block filesystem)
+16+N u32  lazyLen = M            }  ALWAYS present (even when 0)
      M    lazy-file JSON         }
      u32  archiveLen = L         }  only when flags & (1<<1)
      L    lazy-archive JSON      }
      u32  metadataLen = P        }  only when flags & (1<<2)
      P    image-metadata JSON    }
```

Flag bits, and there are exactly four (`memory-fs.ts:485-488`):

| bit | constant | effect |
|---|---|---|
| `1<<0` | `VFS_IMAGE_FLAG_HAS_LAZY` | declares the lazy-file JSON section is meaningful |
| `1<<1` | `VFS_IMAGE_FLAG_HAS_LAZY_ARCHIVES` | **adds** the lazy-archive section |
| `1<<2` | `VFS_IMAGE_FLAG_HAS_METADATA` | **adds** the image-metadata section |
| `1<<3` | `VFS_IMAGE_FLAG_HAS_TYPED_LAZY_ARCHIVES` | adds **no section**; asserts each archive group carries a `kind` discriminator |

**VERIFIED — there are no other sections.** Decoding all nine images and
computing `image.byteLength - (end of metadata section)` yields **0 for every
one**. Nothing is hidden after the metadata section, and no image sets a flag
bit above 3.

**VERIFIED, and this matters for staging (§7):** `restoreParsedImage` never
asserts that the image ends where the metadata section ends, and never rejects
unknown flag bits. Therefore **a new section appended after the metadata
section is invisible to — and harmless to — every existing reader**, including
the standalone `scripts/vfs-has-stale-abi.mjs`. That is the safe staging seam.

Per-image measurements (VERIFIED; sizes are of the *decompressed* image):

| image | flags | sabLen | lazy JSON | archive JSON | metadata JSON | trailer total | unparsed tail |
|---|---|---|---|---|---|---|---|
| `host/wasm/rootfs.vfs` | `0x5` | 16 MiB | 10,720 | — | 57 | 10,785 | **0** |
| `shell.vfs` | `0xF` | 16 MiB | 12,833 | **2,779,271** | 136 | 2,792,252 | **0** |
| `wordpress.vfs` | `0xF` | 208 MiB | 12,951 | **2,779,295** | 315 | 2,792,573 | **0** |
| `lamp.vfs` | `0xF` | 249 MiB | 12,951 | 2,779,295 | 315 | 2,792,573 | **0** |
| `nginx-php-vfs.vfs` | `0xF` | 62 MiB | 12,951 | 2,779,295 | 315 | 2,792,573 | **0** |
| `nginx-vfs.vfs` | `0xF` | 21 MiB | 12,951 | 2,779,295 | 315 | 2,792,573 | **0** |
| `node-vfs.vfs` | `0xF` | 82 MiB | 12,951 | 1,832,939 | 315 | 1,846,217 | **0** |
| `kandelo-sdk.vfs` | `0x4` | 256 MiB | 0 | — | 71 | 79 | **0** |
| `mariadb-test.vfs` | `0x4` | 64 MiB | 0 | — | 71 | 79 | **0** |
| `crates/runtime-core/src/testdata/tiny.vfs` | `0x0` | 256 KiB | 0 | — | — | 4 | **0** |

### 1.2 Section A — lazy-file JSON: seven fields, and the kernel needs one

Type `LazyFileEntry` (`memory-fs.ts:113-124`). VERIFIED: every entry in every
image carries exactly `ino, generation, dataSequence, path, paths, url, size`
— no field is ever absent, none is ever extra.

| field | who needs it | why |
|---|---|---|
| `size` | **KERNEL** | the only reason a lazy stub is not a 0-byte lie. `stat` must report it |
| `ino` | **KERNEL** (as a key) | identifies which SFFS inode the size belongs to |
| `url` | **HOST only** | rewritten at boot by *both* entries (`node-kernel-worker-entry.ts:1204-1205`, `browser-kernel-worker-entry.ts:1111-1112`) and again by the demo app loaders (`apps/browser-demos/lib/init/{rootfs-lazy-files,shell-lazy-files,image-owned-runtime-urls}.ts`). The kernel never sees a URL today and must not start |
| `path`, `paths` | **HOST** | host-side identity/aliasing for `replaceIfIdentity`. The kernel derives paths from the SFFS tree itself |
| `generation`, `dataSequence` | **HOST** | the anti-clobber identity check in `SharedFS.replaceIfIdentity` (`sharedfs-vendor.ts:2459-2495`), a host-side concern while the host performs the fetch-and-replace |

**Kernel-needed subset of section A: `(ino, size)` — 12 bytes per entry.**
65 entries in the base image, 79 in every derived image.

### 1.3 Section B — lazy-archive JSON: 2.78 MB, and 99.93% of it is one array

`SerializedLazyArchiveEntry` (`memory-fs.ts:377-411`) is a large, genuinely
variable-shape type: `kind`, `content` (`LazyTreeContent` with decoder,
mediaType, sha256, bytes, expandedBytes, sourceEntryCount, transports[],
modePolicy, a full `source` inventory, and a `materialization` plan),
`inventory[]` (`LazyTreeRegistrationEntry`), `activation` (mode, capabilities,
roots, `atomicGroup` cohort seal), `url`, `mountPrefix`, `integrity`,
`materialized`, and `entries[]`.

**VERIFIED, and this is the finding that changes the answer: in all nine
production images, almost none of that shape is used.**

| property | measured across all 9 images |
|---|---|
| group `kind` values present | **`kandelo-legacy-zip-v1` only** — never v1/v2/v3 typed trees |
| groups carrying `content` | **0** |
| groups carrying `inventory` | **0** (18 bytes total, i.e. `[]`) |
| groups carrying `activation` | **0** |
| `content.source` inventories | **0** |
| `content.materialization` plans | **0** |
| entry `type` values present | **`"file"` only** |
| entries with `isSymlink: true` | **0** |
| entries with `deleted: true` | **0** |
| entries with `materialized: true` | **0** |

Section-size accounting for `shell.vfs`'s 2,779,271-byte archive section:

```
entries[]      2,777,374 B   (99.93%)
inventory[]           18 B   (nine empty arrays)
content                0 B
materialization        0 B
group scaffolding  ~1,879 B   (kind/url/mountPrefix/integrity/materialized × 9)
```

The 2.78 MB is **7,467 fixed-shape records**, nine groups' worth. And those
records are massively redundant. VERIFIED across every image:

- `sourcePath === archivePath` for **7,467 / 7,467** entries
- `inodeGroup === sourcePath` for **7,467 / 7,467** entries
- `vfsPath === mountPrefix + "/" + sourcePath` for **7,467 / 7,467** entries

So each entry stores the same path string **four times** (`vfsPath`,
`archivePath`, `sourcePath`, `inodeGroup`): 366,254 + 3 × 328,919 = 1,353,011
bytes of the 2.78 MB is literal duplication, before counting JSON's key names
and punctuation.

**What the kernel actually consumes from section B, today.** Not the JSON —
`buildRootfsLazyWiring` (`host/src/vfs/rootfs-lazy-archives.ts:47-131`) reduces
it to two things:

1. `RootfsLazyFile { archiveId, sourcePath }` keyed by `vfsPath`, plus the
   member's `size` (which reaches the kernel via `lstat`, see §1.5); and
2. an `archives[]` table of `{ archiveId, size }`.

`archiveId` is **minted host-side at boot** (`nextArchiveId++`, `:59`, `:80`).
It is not in the image and never has been. URLs stay in the host closure
(`record.transports`), and the kernel's `host_fetch_archive(archive_id, …)`
never carries one.

`sha256`/`bytes` integrity, `activation`, atomic-group seals
(`verifyImportedLazyAtomicGroupSeals`, `memory-fs.ts:3969`, called from
`load-image.ts:29`, `:40` and `rootfs-overlay.ts:170`), and the closed-asset
allow-list (`closed-lazy-assets.ts`) are **all host-side fetch authority**. They
gate what bytes the host is allowed to hand over. The kernel is downstream of
that decision and needs none of it.

**Kernel-needed subset of section B: per member `(ino, archive_id, size,
source_path)`; per group `(archive_id, archive_bytes, mount_prefix)`.**

### 1.4 Section C — image metadata: variable-shape, and not-kernel

VERIFIED contents:

```
rootfs.vfs      {"version":1,"kernelAbi":44,"createdBy":"mkrootfs build"}                     (57 B)
kandelo-sdk     {"version":1,"kernelAbi":44,"createdBy":"images/vfs/scripts/saveImage"}       (71 B)
shell.vfs       + "shellComposition":{"schema":1,"kind":"package-rootfs-shell"}              (136 B)
wordpress/lamp/ + "capacity":{"maxByteLength":805306368},
node-vfs/nginx*   "baseImage":{"sha256":"41772d…","bytes":1426809,"kernelAbi":44}            (315 B)
```

Readers, all build-time or artifact-resolution time, all via
`MemoryFileSystem.readImageMetadata`: `host/src/binary-resolver.ts:2919`,
`images/vfs/scripts/{vfs-product-builder-contract.ts:266,
build-source-rootfs-shell-image.ts:636,722, staged-product-inputs.ts:193}`,
`scripts/{assert-source-rootfs-shell-composition.ts:45,
source-rootfs-shell-node-smoke.ts:52}`,
`apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts:1161`,
`tools/mkrootfs/src/cli/inspect.ts:226`.

`VfsImageMetadata` has an index signature (`[key: string]: unknown`,
`memory-fs.ts:453-466`) and its shape genuinely varies per builder. **This is
the one section where JSON is the right encoding**, it is 57–315 bytes, and the
kernel needs none of it. It should stay JSON and stay host-side. (Its
`kernelAbi` field is the V3 stamp; see §7.4.)

### 1.5 Where the kernel gets the real size TODAY

`emitRootfsManifest` (`host/src/vfs/rootfs-manifest.ts:172-293`) walks the
restored `MemoryFileSystem` and calls `backend.lstat`, which is
`MemoryFileSystem.adaptStatWithLazySize` (`memory-fs.ts:3606-3620`) —
**the lazy-adjusted size**. So:

- a URL-backed lazy file is emitted as `KIND_FILE` with `blob_id = ino` and
  `size = the real size`. The kernel is told the truth and never learns the URL.
- an archive-backed member is emitted as `KIND_LAZY_FILE` carrying
  `archive_id | source_path_len | source_path`, plus the same real `size`.
- the manifest ends with an archive table: `archive_count u32`, then
  `archive_id u32 | archive_size u64` per archive.

Confirmed by `mkrootfs inspect host/wasm/rootfs.vfs`: it reports **84 regular
files, of which zero have size 0** — because the 65 lazy stubs already report
their real sizes through this same lazy-adjusted path.

**So the kernel already receives every lazy fact it needs, in a binary format
it already parses, today.** `rootfs.rs`'s `MANIFEST_MAGIC = 0x5346_5452`
("RTFS"), `MANIFEST_VERSION_V3 = 3` (`rootfs.rs:923-926`), decoded by
`load_manifest_inner` (`:977-1046`) into `insert_lazy_file(path, archive_id,
source_path, size, mode, uid, gid, ino)` (`:826`) and an `archives` table
(`:1017-1028`).

**The trailing JSON is not the kernel's interface to lazy metadata. It is the
image-persistence form of information the kernel already consumes in binary.**
The K1 blocker is therefore not "the kernel must learn to parse JSON"; it is
"if the host stops walking the image, something else must carry the lazy delta,
and the SFFS binary layer does not."

---

## 2. Q2 — Variable-shape vs fixed-shape, and a candidate binary layout

### 2.1 The split

| section | genuinely variable-shape? | verdict |
|---|---|---|
| image metadata (C) | **yes** — open index signature, per-builder provenance objects | keep JSON, keep host-side, 57–315 B |
| lazy-archive group scaffolding (B, per group) | partly — `content`/`activation`/`materialization` are open-ended **but unused by every shipped image** | fixed-shape binary for the kernel-needed fields; leave the open-ended producer fields in a host-side JSON section |
| lazy-archive `entries[]` (B) | **no** — 7,467 identical 12-key records, 3 of whose 4 path strings are provably derivable | binary table |
| lazy-file entries (A) | **no** — 7 fixed keys, always all present | binary table for `(ino,size)`; URL/identity stay host-side JSON |

### 2.2 Candidate layout — copying the repo's own binary-section idiom

The idiom to copy is `crates/fork-codec/src/imported_globals.rs` (see §5.2):
4-byte magic, `u16` version, `u16` header size, `u32` count, `u32` reserved;
size-prefixed records with trailing variable-length names; structural constants
in `crates/shared/src/lib.rs`; a committed cross-language fixture.

```
"KLZY" lazy-linkage section — the KERNEL-facing subset, appended after metadata,
gated by flags bit 4. All little-endian.

header (16 B):
  +0  magic "KLZY"          +4  u16 version      +6  u16 header_size
  +8  u32 group_count       +12 u16 file_count_hi? -> use u32 file_count at +12

group record (variable, size-prefixed):
  +0  u32 record_size       +4  u32 archive_id (host-independent, image-assigned)
  +8  u64 archive_bytes     +16 u16 flags        +18 u16 mount_prefix_len
  +20 mount_prefix[]
  flags bit0 = SOURCE_PATH_DERIVED: every member's source path is its VFS path
               with `mount_prefix + "/"` stripped (the writer must PROVE this
               per group, and emit explicit paths for the group otherwise)

file record (20 B + optional path):
  +0  u32 ino              +4  u32 archive_id (0 = URL-backed single file)
  +8  u64 size             +16 u16 source_path_len  +18 u16 flags
  +20 source_path[]        (absent when archive_id == 0, or when the group is
                            SOURCE_PATH_DERIVED)
```

`archive_id` becomes image-assigned rather than boot-minted. That is a
simplification: `buildRootfsLazyWiring`'s id-minting pass disappears and the
"manifest table and provider table can never drift" invariant it documents
(`rootfs-lazy-archives.ts:14-16`) becomes structural instead of procedural.

### 2.3 Encoded size, measured against `shell.vfs`

| component | count | explicit source paths | derived source paths |
|---|---|---|---|
| header | 1 | 16 B | 16 B |
| group records | 9 | 216 B | 216 B |
| URL-backed lazy files | 79 | 1,580 B | 1,580 B |
| archive members (fixed part) | 7,467 | 149,340 B | 149,340 B |
| archive members (path bytes) | 7,467 | 328,919 B | 0 B |
| **total** | | **480,071 B (469 KiB)** | **151,152 B (148 KiB)** |

Against today's **2,792,104 B** of lazy + archive JSON: **5.8× smaller**
explicit, **18.5× smaller** derived. The image-metadata JSON (136 B) is
unchanged in both.

For scale, the RTFS manifest the host already pushes into kernel memory for
`shell.vfs` is ≈1.34 MB (VERIFIED estimate: 9,160 entries × 57 B fixed +
426,775 B of path bytes + 5,397 B of symlink targets + 7,467 lazy tails). So
a kernel that parses SFFS itself and receives only this lazy section moves
**less** data across the boundary than today, by roughly 3× (explicit) or 9×
(derived) — and stops re-serializing a tree it can already read.

### 2.4 What a binary table CANNOT absorb

The URL/transport/integrity/activation half. Those are host fetch authority
(§1.3) and they are variable-shape by design. They should stay a JSON section
that only the host reads — smaller than today (no `entries[]`), roughly the
current lazy-file JSON plus nine group headers, ≈14 KB for `shell.vfs`.

---

## 3. Q4 — Blast radius, quantified honestly

### 3.1 The decisive fact: the format writer is IN SCOPE

`tools/mkrootfs/src/builder.ts:24` imports
`../../../host/src/vfs/memory-fs` **by source path**. `tools/mkrootfs` never
touches the container bytes: it calls `mfs.registerLazyFile(path, url, size,
mode)` (`builder.ts:158`) and `mfs.toImage()`. Its `package.json` has one
runtime dependency (`fflate`) and no vendored copy of the format.

**VERIFIED: changing the trailing-section encoding requires zero code changes
in `tools/mkrootfs`.** Rebuilding is a `npm run build` away and the new
encoding arrives for free.

Same for `images/vfs/scripts/**`: every one of its container touchpoints
(`vfs-product-builder-contract.ts:266`,
`build-source-rootfs-shell-image.ts:636,644,722,732`,
`staged-product-inputs.ts:193`) goes through `MemoryFileSystem.readImageMetadata`
/ `fromImagePreservingCapacity`, i.e. the API, not the bytes.

### 3.2 The complete set of files that read container bytes directly

Repo-wide grep for `VFS_IMAGE_MAGIC | 0x56465349 | parseImageHeader |
sectionOffsetAfterArchives | readImageMetadata`, excluding `node_modules` and
`dist`:

| file | nature | impact of a new appended section | impact of changing existing framing |
|---|---|---|---|
| `host/src/vfs/memory-fs.ts` | **the format owner** (16 sites) | the work | the work |
| `scripts/vfs-has-stale-abi.mjs` | **independent re-implementation** of magic/version/flags/sabLen/lazyLen/archiveLen/metadataLen + `JSON.parse` (`:12-90`) | **none** — it stops at the metadata section | must be updated **or deleted** (prior grounding VERIFIED it has no caller anywhere) |
| `scripts/resolve-binary.bundle.mjs` | generated bundle of `binary-resolver.ts` ("do not edit", header line 1) | none | regenerate via `scripts/build-resolve-binary-bundle.sh` |
| `host/src/binary-resolver.ts:2919` | calls `readImageMetadata` | none | none |
| `host/scripts/gen-sffs-rust-fixture.mts` | fixture generator, comment only | none | none |
| `docs/architecture.md:2128-2141` | the documented layout table | must document the new bit and section | must be rewritten |
| tests: `host/test/vfs-image.test.ts` (8), `tools/mkrootfs/test/{cli,builder}.test.ts` (3), `host/test/shell-vfs-build.test.ts` (2), `tests/package-system/{source-rootfs-shell-bridge,resolve-binary}.test.ts` | assert framing / metadata | some added | real fallout, sized below |

Test fallout by API usage (files touching `exportLazy*`/`importLazy*`/
`registerLazyArchive`/`createLazyStub`/`serializeValidatedLazy`):
`host/test/lazy-tree.test.ts` (87 sites), `lazy-archive.test.ts` (65),
`sharedfs-safety.test.ts` (16), plus 14 further files with ≤6 sites each. Most
of these exercise the **object API**, not the encoding, so they survive a
re-encode; the ones that assert bytes do not. This is real work and is not
estimated here beyond the site counts.

### 3.3 What must be rebuilt

Every `.vfs`/`.vfs.zst` artifact. That is nine images in this worktree plus the
demo images built on demand by `images/vfs/scripts/**`. The campaign already
grants this: *"This entire campaign is one ABI epoch… Re-instrumentation and
package rebuilds are available"* (value plan §1).

### 3.4 Honest summary of blast radius

**A new appended section reaches zero out-of-scope code.** Changing the
existing framing reaches exactly two out-of-scope files, one of which
(`vfs-has-stale-abi.mjs`) is dead and one of which (`resolve-binary.bundle.mjs`)
is generated. This is far smaller than the value plan's out-of-scope boundary
implies, because the boundary was drawn around directories and the format lives
in `host/src/vfs/`, which is in scope.

---

## 4. Q6 — Does the kernel need lazy metadata at LOAD or at FIRST ACCESS?

### 4.1 The set of lazy inodes must be known at LOAD. Proven, not argued.

The tempting cheap answer is: let the kernel treat "size 0, zero blocks" as
"ask the host". **That is unsound, and the counter-example is in a shipped
image.** `mkrootfs inspect shell.vfs` reports **10 genuinely-empty regular
files** — including `/home/.nethack/perm` and `/home/.nethack/record`, which lie
outside every archive group's `mountPrefix` (`/usr`) and are therefore concrete,
truly-empty files coexisting in the same image with 7,546 size-0 lazy stubs.
A "size 0 means lazy" rule would turn those into permanent EAGAIN or EIO.

`SharedFS.createLazyStub` (`sharedfs-vendor.ts:2437-2453`) writes a size-0,
zero-block inode, and `replaceIfIdentity` (`:2496`) **refuses to replace any
inode whose `INO_SIZE != 0`** — "Lazy backing is attached only to an untouched
empty stub." That is a deliberate safety property: a size-0/zero-block inode is
provably content-free, whereas a nonzero-size/zero-block inode is a legal SFFS
**sparse file** that any reader would serve as zeros. So "just put the real size
in the SFFS inode" is not the free win it looks like — it converts a visible
0-byte failure into a silent all-zeros lie, which the platform-values contract
forbids.

(There is a narrow opening: inode bytes **124-127 are documented reserved** —
`sharedfs-vendor.ts:138`, *"reserved for future fields (flags, xattrs, etc.)"*.
An explicit `INO_FLAG_DEFERRED` bit there would disambiguate. It does not by
itself carry `archive_id`/`source_path`, and it changes the inode contract for
every existing reader, so it is recorded as an option, not a recommendation —
see NEEDS-DEFER-DECISION D-B3.)

### 4.2 Per-entry details could be deferred, but there is no benefit

Given that the *set* must be known at load, the per-entry payload is
`(archive_id, size, source_path)` — the same records. Deferring only the `size`
would still require `stat()` to park and round-trip per file, on a path where
today one host→kernel crossing serves the whole tree. That trades a 148–469 KiB
one-shot table for thousands of syscall-path round trips, on a platform whose
recorded worst boot pathology is *"a PHP file-metadata syscall storm (~19.7k)"*.

**Conclusion (VERIFIED premise, reasoned conclusion): on-demand metadata via the
byte provider is not the cheapest correct answer. It is more expensive and no
simpler.** What *is* correct and cheap is that the **bytes** stay on demand —
which they already are, through `host_blob_read` / `host_fetch_archive`.

### 4.3 One option that would delete the size table — and its cost

An archive's ZIP **central directory** already contains every member's name and
uncompressed size, and `crates/runtime-core/src/zip.rs` already decodes it. If
the host provider supported **ranged** reads, the kernel could fetch the last
few KiB of each archive at load and learn every member's size with no metadata
at all.

It does not. `fetchArchive` (`rootfs-lazy-archives.ts:135-155`) downloads the
**whole** archive and caches it; a positioned read of the tail therefore
triggers a full download of all nine archives (≈55 MB for `shell.vfs`) at boot,
destroying laziness. Making it ranged is a **host-capability change** (HTTP
Range support, per-transport, on both hosts) — see STRONG DOUBT SD-B4. Recorded
as a real design option whose cost lands in exactly the place V4 says not to
grow.

---

## 5. Q5 — Precedent in this repo

### 5.1 RTFS is the precedent, and it already covers lazy metadata

`rootfs-manifest.ts:10-30` documents the wire format; `rootfs.rs:900-1046`
parses it. It already has: a magic, a version, versioned entry kinds
(`1=dir, 2=file, 3=symlink, 4=lazy file`), length-prefixed UTF-8 paths, a
trailing table, and a `MANIFEST_VERSION`/`MANIFEST_VERSION_V3` dual-accept
(`rootfs.rs:983`). It also already has the cross-authority fixture device:
`rootfs.rs:3153-3193` (`load_manifest_ts_emitted_v3_fixture_round_trips`)
consumes `testdata/rtfs-v3-lazy.bin`, emitted by the **real** TypeScript emitter
via `host/scripts/gen-rtfs-v3-fixture.mts`.

**Could the lazy metadata "simply become manifest V4"? It already IS manifest
V3.** The question is not whether to invent an encoding — it is *where the
records live*: in a host-emitted manifest (today) or in the image itself
(what V3 requires).

That distinction is load-bearing, because RTFS cannot simply move into the
image: `crates/host-native/src/guest.rs:1375-1500` builds an RTFS manifest from
a **directory**, not from an image, so RTFS must survive regardless.

### 5.2 The section idiom to copy

`crates/fork-codec/src/imported_globals.rs:16-27` documents, and `:152-230`
decodes, the `KFIG` section: magic, `u16` version, `u16` header size, `u32`
record count, `u32` reserved; then size-prefixed records with trailing
length-prefixed UTF-8 names. Every framing or consistency violation yields
`Err(Errno::EINVAL)` and it never panics. Its structural constants live in
`crates/shared/src/lib.rs` and it is cross-checked by a committed fixture
emitted by the real encoder. `fork-instrument` writes the peer sections into
Wasm custom sections through the same discipline.

This is a mature, in-repo, no_std pattern for exactly this problem, and it is
the one the `KLZY` sketch in §2.2 follows.

### 5.3 No kernel JSON parser exists; adding one is a dependency decision

VERIFIED: `crates/runtime-core/Cargo.toml` has three dependencies —
`miniz_oxide`, `spin`, `wasm-posix-shared`. `crates/kernel/Cargo.toml` adds
`dlmalloc` on wasm. No `serde`, no `serde_json`, no JSON of any kind anywhere
in the workspace's kernel path. A no_std JSON parser means either a new
third-party dependency (vetting, `no_std`, kernel `.wasm` size) or a
hand-written one, in the kernel, over untrusted image bytes.

---

## 6. SD-2 re-tested — the right shape for `Sffs`

### 6.1 The prior sizing was pessimistic

Prior grounding SD-2: *"every `self.bytes[...]` index becomes a fallible block
fetch — a real rewrite of `sffs.rs`'s internals."*

**VERIFIED by count: there are 18 `self.bytes` references in the whole file**
(`sffs.rs:117,118,124-130,147,156,160,166,195,196,262,263,267`), and they
concentrate in five places:

- 9 inode-field reads in `stat_ino` (`:117-130`) — all `r32`/`r64` at
  `inode_offset(ino)`, i.e. **one inode-table block**
- 1 indirect-pointer read in `block_ptr_in` (`:147`)
- 3 block-pointer reads in `block_map` (`:156,160,166`)
- 2 data-slice copies in `read_at` (`:195,196`)
- 3 in `read_link` (`:262,263,267`)

Every one already funnels through the bounds-checked helpers `r32`/`r64`
(`:12-24`), which take `&[u8]` and an offset. A `BlockSource` refactor touches
**six functions**, not the file. The public API (`mount`, `stat_ino`, `read_at`,
`read_dir`, `lookup`, `read_link`, `resolve`) does not have to change shape at
all if the source is stored in the struct rather than borrowed.

**SD-2 stands as a real design mismatch, and its cost estimate should come
down.**

### 6.2 SD-1 re-tested — the resident set is ≤ 9.5 MiB, not 208–256 MiB

The instrumented walker measured which physical blocks a **tree build** must
read (superblock + inode-table blocks touched + directory data blocks +
indirect blocks + block-backed symlink targets):

| image | SAB | inode table | used data | tree entries | **blocks touched to BUILD the tree** |
|---|---|---|---|---|---|
| `rootfs.vfs` | 16 MiB | 2 MiB | 3.2 MiB | 375 | 31 blocks = **0.12 MiB** |
| `shell.vfs` | 16 MiB | 2 MiB | 11.5 MiB | 9,160 | 1,518 blocks = **5.93 MiB** |
| `wordpress.vfs` | **208 MiB** | 6 MiB | 207.1 MiB | 15,379 | 2,426 blocks = **9.48 MiB** |
| `lamp.vfs` | **249 MiB** | 6 MiB | 248.1 MiB | 15,475 | 2,426 blocks = **9.48 MiB** |
| `kandelo-sdk.vfs` | **256 MiB** | 8 MiB | 56.4 MiB | 2,439 | 216 blocks = **0.84 MiB** |

(The walker's entry counts cross-check the prior grounding exactly:
375 / 9,159+root / 15,378+root / 2,438+root. It also VERIFIED that
**every symlink in every image is inline** (`size <= 40`), so no symlink
target needs a data block, and that superblock geometry for a real `statfs`
is present and readable — e.g.
`wordpress.vfs`: totalBlocks 53,248, freeBlocks 232, totalInodes 49,152,
freeInodes 33,772, maxSizeBlocks 196,608.)

**SD-1's premise — "the kernel must hold 208–256 MiB resident" — is false for
the tree build.** A paged cursor over 4 KiB blocks with a bounded cache needs
single-digit MiB even for the largest image. The 208 MiB is *file content*,
which is exactly what `read()` already streams on demand today.

### 6.3 Recommended shape

**A paged cursor: `Sffs<S: BlockSource>` holding an owned source plus a small
bounded 4 KiB block cache**, with `impl BlockSource for &[u8]` so all 15
existing tests keep passing verbatim.

- *Resident buffer* — matches today's code, but duplicates 208–256 MiB while the
  host still holds its decompressed copy, on a platform with a recorded WebKit
  image-switch reclaim problem. Rejected on §6.2's evidence: it buys nothing the
  cursor doesn't.
- *Streaming reader* — wrong abstraction. `block_map`'s double-indirect walk and
  `resolve`'s symlink splicing are random access, not sequential.
- *Paged cursor* — right. `mount()` already validates the whole inode-table
  region fits (`sffs.rs:95-101`), which under a cursor becomes a length check
  plus a first-block fetch.

**One requirement this places on the host, which must be stated rather than
assumed: the image block provider must be able to answer synchronously.** It
can: the decompressed image already lives in the kernel worker's own memory on
both hosts (`node-kernel-worker-entry.ts:1489` `msg.rootfsImage`,
`browser-kernel-worker-entry.ts:1104` `msg.vfsImage`), so an image-block read is
a `memcpy`, never an `EAGAIN` park. If it ever became a park, the whole tree
build would have to be restartable — a much larger design. Recorded as a
constraint on the provider, not as a discovered floor.

---

## 7. Q7 — Recommendation

### 7.1 The four candidates

**(A) Keep JSON, write a no_std parser.** Rejected. It imports a parser
subsystem plus a dependency decision (§5.3) into the kernel, over untrusted
input, to read 2.78 MB of records that are 99.93% one fixed-shape array with
1.35 MB of literal string duplication (§1.3). It solves a problem that does not
need to exist.

**(B) Change the format to a binary section.** The `KLZY` sketch in §2.2.
469 KiB explicit / 148 KiB derived vs 2,792 KiB today; no kernel JSON parser;
reuses the repo's own `KFIG` idiom and `rootfs.rs`'s existing
`insert_lazy_file`.

**(C) On-demand metadata via the existing byte provider.** Rejected on evidence.
§4.1 proves the lazy *set* must be known at load (10 genuinely-empty files
coexist with size-0 stubs in `shell.vfs`), and once the set is known the
per-entry payload is the same records — so on-demand costs thousands of parked
round trips to save a 148 KiB table.

**(D) Ranged reads of the ZIP central directory.** Would delete the size table
entirely, but requires HTTP Range support in the archive transport on both
hosts — growing host capability, which V4 forbids without proof of necessity.
Recorded, not recommended (SD-B4).

### 7.2 Recommendation: (B), appended section, dual-written first

The single recommendation is **(B)**, executed in this order, because §1.1
VERIFIED that an appended section is invisible to every existing reader.

1. **Define the section.** Constants in `crates/shared/src/lib.rs` next to the
   `WPK_FORK_*` families; decoder in `crates/runtime-core/src/sffs.rs` (or a
   sibling `sffs_lazy.rs`) following `imported_globals.rs`'s validation
   discipline — every framing violation `Err(Errno::EINVAL)`, never panics.
   Encoder in `host/src/vfs/memory-fs.ts`. Committed cross-language fixture in
   both directions, the way `rtfs-v3-lazy.bin` already works.
2. **Dual-write.** `toImage` emits the existing lazy + archive JSON sections
   *and* appends `KLZY` under flags bit 4. Every existing reader — including
   `scripts/vfs-has-stale-abi.mjs` — is unaffected (VERIFIED: no reader checks
   for trailing bytes or unknown flag bits). Rebuild images; nothing changes
   behaviorally.
3. **Prove equivalence.** A test asserts that `KLZY`, decoded in Rust, and the
   JSON, decoded in TypeScript and reduced through `buildRootfsLazyWiring`,
   produce identical `(vfsPath → archiveId, sourcePath, size)` maps and identical
   archive tables, on all nine real images. This is the same
   parity-oracle device the prior grounding found in
   `kernel_rootfs_export_tree` (`wasm_api.rs:1695`), pointed at the lazy layer.
4. **Cut over the reader.** `rootfs::load_sffs_image` builds the tree from SFFS
   and applies `KLZY` to produce `insert_lazy_file` / real-size `insert_base_file`
   calls. RTFS stays for `host-native`'s directory-derived manifests
   (`guest.rs:1375-1500`).
5. **Delete the JSON entries array.** Once the kernel is the reader, the
   lazy-archive JSON section shrinks to the host's fetch authority (URLs,
   transports, sha256, activation, seals) with **no `entries[]`**, and the
   lazy-file JSON keeps URL + identity but drops nothing else. The image-metadata
   JSON stays as-is.

**Cost.** New Rust decoder ≈250–350 lines with tests (compare
`imported_globals.rs`); new TS encoder ≈150 lines in `memory-fs.ts`; the
`Sffs<S: BlockSource>` refactor from §6 (six functions, 18 call sites); a
committed fixture pair; the test fallout in §3.2. Zero out-of-scope code
changes. Zero new host imports. All images rebuilt.

**What this buys that (A) does not:** the kernel never learns to parse JSON, the
image shrinks by ~2.3 MB per derived image before compression, `archive_id`
minting leaves the host, and the format the kernel owns is one the repo already
knows how to version, fixture, and fuzz.

### 7.3 The typed deferred-tree schema needs a decision, not a port

The `kandelo-deferred-tree-v{1,2,3}` kinds, `LazyTreeContent`, source
inventories, materialization plans, activation modes, and atomic-group seals are
**used by no production image and by no image build script**. VERIFIED: the only
producers/consumers in the repo are `host/src/vfs/package-deferred-tree.ts`
(which imports `node:crypto` at module scope, so it cannot run in a browser),
`host/src/vfs/memory-fs.ts`, and two `apps/browser-demos/test/*.spec.ts` specs.
Every shipped group is `kandelo-legacy-zip-v1`.

The prior grounding's SD-3 sized K1's JSON burden by that schema. **On
re-measurement, that burden is not in any artifact.** It is a supported
capability with no current user — which is a scope question for the maintainer
(D-B2), not a kernel-parser requirement.

### 7.4 What this means for removing the guest-ABI stamp

**The stamp is independent of everything above, and cheaper than it looks.**
`kernelAbi` lives in the image-metadata JSON (§1.4) — a 57–315 byte section that
this recommendation does not touch. Removing it is:

- stop passing `--kernel-abi` in `scripts/build-rootfs.sh:197` →
  `tools/mkrootfs/src/cli/build.ts:132-137`;
- delete the `hasVfsArtifactPolicyFailuresForBytes` ABI comparison
  (`host/src/binary-resolver.ts:2911-2926`) and replace the build-cache
  freshness signal it provides;
- delete two already-dead readers, `MemoryFileSystem.assertImageKernelAbi`
  (`memory-fs.ts:7158-7170`) and `scripts/vfs-has-stale-abi.mjs` — the prior
  grounding VERIFIED both have no caller, and §3.2 re-confirms the latter is a
  standalone re-implementation nothing invokes.

Runtime safety does not depend on the stamp: a program's own ABI custom section
is checked independently (`worker-main.ts:4827`, `:5577`;
`node-kernel-worker-entry.ts:1109-1122` → `ENOEXEC`). The stamp's live job is
**build-cache freshness**, not load-time safety.

**Under recommendation (B), V3's "images carry no guest-ABI stamp" becomes
reachable**: once the kernel owns the SFFS layer *and* the lazy linkage, nothing
in the image is bound to the guest ABI except the Wasm programs inside it, which
carry their own check.

---

## 8. STRONG DOUBT

**SD-B1 — Repurposing `host_blob_read` for image bytes is a semantic ABI
change.** No new import is needed for any option here:
`host_blob_read(blob_id_lo, blob_id_hi, buf_ptr, buf_len, offset_lo,
offset_hi)` (`wasm_api.rs:79-86`) is
already a positioned read of an opaque 64-bit id, and image blocks fit it
exactly. But `blob_id` today *means* "the file's inode number"
(`rootfs-manifest.ts:26-31`), and serving image blocks changes that meaning.
`docs/agent-guidance/abi.md` says a changed meaning can require a bump even with
an unchanged snapshot. **This is the same question the prior grounding raised as
D4 and it is still unresolved.** The alternative — a new `ByteReq::Image
{ offset }` variant — is structurally cleaner but edits all 8 `match req` sites
(`syscalls.rs:5035,5299,5831,6282,17055`; `exec_target.rs:558`;
`wasm_api.rs:1611,1661`), i.e. it *is* a `syscalls.rs` edit.

**SD-B2 — Changing the VFSI container may itself be ABI surface.**
`docs/agent-guidance/abi.md` lists *"VFS image metadata that binds Wasm programs
to a kernel ABI"* as ABI surface. A new flag bit and section is additive and
invisible to old readers (§1.1, VERIFIED), which argues no bump. Removing the
JSON sections at step 5 is not. **I am not deciding whether step 5 demands an
`ABI_VERSION` bump.** Flagged rather than assumed.

**SD-B3 — Lock-free reads of a buffer the host may still mutate (inherited
SD-4, still unproven).** `sffs.rs` implements none of `SharedFS`'s `Atomics`
discipline. Under a paged cursor the kernel re-reads blocks *after* boot, which
widens the window the prior grounding reasoned was closed by call ordering. The
prior grounding's three known host mutations (`normalizeLegacyRootfs`,
`ensureMountParentDirectories`, the browser TLS-cert write) all precede `init`,
but that remains INFERRED from call ordering and is **not proven by a test**. A
paged cursor makes proving it more important, not less.

**SD-B4 — Option (D) would grow host capability.** Ranged archive reads would
delete the per-member size table entirely, but require HTTP Range support in the
archive transport on both hosts. That is exactly the direction V4 forbids
without proof of necessity. Recorded so it is not quietly adopted later as an
"optimization".

**SD-B5 — `SOURCE_PATH_DERIVED` is a correctness assumption, not a fact of the
format.** The 100% match measured in §1.3 is a property of today's *builders*,
not of the format. Any writer emitting it must **prove** the invariant per group
and fall back to explicit paths otherwise. Adopting the 18.5× number without
that proof would be exactly the kind of convenient illusion the Bar forbids.

**No `ABI_VERSION` bump is demanded by the mechanics of (B) as staged in §7.2
steps 1-4.** Step 5 and SD-B1 are judgement calls that belong to the
maintainer.

---

## 9. NEEDS-DEFER-DECISION

Per the standing rule, I am deciding none of these.

### D-B1 — Does the trailing-section change count as an ABI change?

- **What.** Adding flag bit 4 and a `KLZY` section (steps 1-4), and later
  removing the JSON `entries[]` (step 5).
- **Why now.** It determines whether K1b lands inside the ABI-44 epoch as a
  regen-only change or forces a bump.
- **Cost now (bump).** Re-instrumentation and package rebuilds — which the
  campaign says are available.
- **Cost of deferring.** A format change with real semantics rides an existing
  `ABI_VERSION`, which `abi.md` warns against.
- **Recommendation.** Steps 1-4 are additive and invisible to existing readers
  (VERIFIED §1.1) — snapshot regen only. Decide step 5 separately, and record the
  decision in `docs/abi-versioning.md` rather than leaving it implicit.

### D-B2 — What happens to the typed deferred-tree schema?

- **What.** `kandelo-deferred-tree-v{1,2,3}`, `LazyTreeContent`, source
  inventories, materialization plans, activation modes, atomic-group seals.
- **Why now.** It is the single largest driver of "how much shape must the new
  encoding carry", and §7.3 VERIFIED that **no shipped image and no image build
  script uses any of it**.
- **Cost now (carry it).** The binary section must express open-ended producer
  metadata, which is precisely what binary sections are bad at — probably
  meaning a host-side JSON section survives alongside `KLZY` permanently.
- **Cost of deferring / declaring it build-only.** A supported capability is
  narrowed. If a future package needs typed trees, the work returns.
- **Recommendation.** Split it: the **kernel-needed** subset (ino, archive,
  size, source path) goes in `KLZY` for *all* kinds; the **host-needed**
  open-ended subset stays JSON in a host-only section. That way typed trees keep
  working, the kernel never parses their variable shape, and no capability is
  withdrawn. But whether to keep investing in an unused schema at all is the
  maintainer's call.

### D-B3 — Should SFFS inode bytes 124-127 gain a deferred-backing flag?

- **What.** `sharedfs-vendor.ts:138` reserves inode bytes 124-127 "for future
  fields (flags, xattrs, etc.)". A `INO_FLAG_DEFERRED` bit there would make the
  lazy *set* readable from the SFFS layer alone.
- **Why now.** It changes what the lazy section must carry: with the flag,
  `KLZY` shrinks to sizes and archive linkage and needs no "which inodes" list.
- **Cost now.** Touches the inode contract every existing reader shares;
  `replaceIfIdentity`'s "`INO_SIZE != 0` ⇒ refuse" safety rule
  (`sharedfs-vendor.ts:2495`) would need re-derivation if size ever moved into
  the stub too.
- **Cost of deferring.** `KLZY` carries an `ino` per entry — 4 bytes × 7,546 =
  30 KiB. Trivial. Deferring costs almost nothing.
- **Recommendation.** **Defer.** The saving is 30 KiB and the risk is a shared
  on-disk contract. Do not open the inode format for this.

### D-B4 — Is `host/src/vfs/memory-fs.ts` acting as a build tool in scope?

- **What.** The campaign scopes out `tools/mkrootfs` and `images/vfs/scripts`,
  but §3.1 VERIFIED that the *format writer* they use is
  `host/src/vfs/memory-fs.ts`, which is in scope. Editing it changes what the
  out-of-scope tools produce.
- **Why now.** Recommendation (B) rests on this being acceptable.
- **Cost now.** None mechanically — no out-of-scope file changes. But it means
  the campaign is, in effect, changing an artifact format the toolchain owns.
- **Cost of deferring.** V3 is unreachable: the kernel cannot own a format whose
  writer nobody may touch.
- **Recommendation.** Carve out the VFSI **container encoding** as explicitly
  in scope (it is runtime format authority, and it already lives in
  `host/src/vfs/`), while leaving `tools/mkrootfs`'s CLI, manifest language, and
  build behavior out of scope. This is a narrower exception than the prior
  grounding's D5.

### D-B5 — The three pre-manifest host mutations (inherited, still open)

`normalizeLegacyRootfs` (`default-mounts.ts:160-168`),
`ensureMountParentDirectories` (`:187-210`), and the browser TLS-cert write
(`browser-kernel-worker-entry.ts:1170-1179`) mutate the restored filesystem
between restore and manifest emission. A kernel parsing the raw image sees none
of them. **This pass found nothing new and changes no part of the prior
grounding's D3.** Restated here so it is not lost: it is still undecided, and
recommendation (B) does not resolve it.

---

## 10. One-line summary for the campaign ledger

The VFSI trailer is three JSON sections and nothing else (VERIFIED: zero
unparsed tail bytes on all nine production images). Only **two facts in it are
kernel-relevant** — a lazy file's real size, and an archive member's
`(archive_id, source_path, size)` — and the kernel already receives both today,
**in binary**, through RTFS v3's `KIND_LAZY_FILE` entries. The 2.78 MB archive
JSON is 99.93% one fixed-shape 7,467-record array in which three of four path
strings are provably redundant, uses only the `kandelo-legacy-zip-v1` kind, and
carries no `content`, `inventory`, `activation`, source inventory, or
materialization plan in **any** shipped image. So the no_std JSON problem should
be **deleted, not solved**: replace the kernel-needed subset with a binary
section in the repo's own `KFIG` idiom (469 KiB explicit / 148 KiB derived vs
2,792 KiB), appended under a new flag bit — which VERIFIED no existing reader
can even see — and leave URLs, integrity, seals, and image metadata as host-side
JSON. Blast radius into the out-of-scope toolchain is **zero code changes**
(`tools/mkrootfs` imports `host/src/vfs/memory-fs` by source path), plus rebuilt
images. `Sffs` should become a **paged cursor** over a `BlockSource`: the prior
grounding's 208–256 MiB residency fear is false — a full tree build touches
**≤ 9.48 MiB** even for the 249 MiB `lamp.vfs` — and the refactor is 18 call
sites across six functions, not a rewrite.

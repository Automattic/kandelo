# K8 Grounding — Moving VFS runtime authority into Rust

> Read-only grounding pass, 2026-09-09. Worktree
> `/Users/brandon/kandelo-abi44-reconcile`, branch
> `integration/k-tier1-20260909` (tip `bd3364c95`).
> **No code was changed.** This file is the only file written.
>
> Builds on `2026-09-09-rust-first-value-plan.md` (V3, the Bar, §2c which is
> binding here), `2026-09-09-k1b-image-format-grounding.md`,
> `2026-09-09-k1-sffs-wiring-grounding.md`, the census §3 F3 / §5.8 / §7, and
> `2026-09-09-runtime-ts-disposition-ledger.md`.
> Binding guidance: `docs/agent-guidance/{browser-and-user,validation,abi}.md`.

---

## 0. Method, and what is VERIFIED vs INFERRED

Everything below labelled **VERIFIED** was read in the source on this branch at
the cited line, or measured with `wc`/`grep`/`python3` in this session. Nothing
was inherited from the prior groundings without re-reading it — four inherited
"floors" have already been disproved in this campaign, and this pass disproves
or materially re-frames three more inherited claims (§1.1, §2.5, §7).

**Not run:** no build, no `cargo test`, no Vitest, no Playwright, no browser
session, no `./run.sh setup` or `local-build` (another process owns the build
cache). This is a grounding pass; it makes no behaviour claim about the branch.

**Stale citations corrected.** The census, the ledger, and this task's brief all
cite `syscalls.rs:2068` / `:2122` for the `/dev/shm` carve-out. On this branch
the predicate is at **`crates/runtime-core/src/syscalls.rs:2105-2107`** and the
special-case probe at **`:2124-2135`**. `syscalls.rs` is 46,885+ lines and moves
under every K item; cite by symbol as well as line.

---

## 1. Q1 — What still makes `memory-fs.ts` the runtime authority

### 1.1 The headline finding: for `/`, it already is not. Phase 5 took that.

The census F3 sentence — *"the format … is read at runtime by
`host/src/vfs/sharedfs-vendor.ts` (3,752) and `memory-fs.ts` (8,198)"* — was
true before the Phase 5 tmpfs/rootfs cutover. It is **no longer true for the
metadata/tree half**, and K8 must not be planned as though it were.

**VERIFIED — the host `/` mount is unconditionally dropped on both hosts:**

- `host/src/node-kernel-worker-entry.ts:1239` —
  `const guestMounts = mounts.filter((m) => m.mountPoint !== "/");`
  with the comment at `:1230-1238`: *"Phase 5 cutover: the in-kernel rootfs
  overlay is the unconditional sole `/` authority… the backing
  MemoryFileSystem stays alive as the `blob_read` byte store and lazy-group
  source even though it is no longer mounted."*
- `host/src/browser-kernel-worker-entry.ts:1148`, identical filter, identical
  comment at `:1139-1147`.

**VERIFIED — every default scratch mount is kernel tmpfs, not memfs.**
`host/src/vfs/default-mounts.ts:26-34` lists `KERNEL_TMPFS_OWNED_PREFIXES` =
`/tmp`, `/var/tmp`, `/var/log`, `/var/run`, `/home/maker`, `/root`, `/srv` —
exactly the seven `scratch` entries of `DEFAULT_MOUNT_SPEC` (`:71-106`) — and
`filterMountSpecForKernelTmpfs` (`:220-226`) removes every one of them before a
backend is materialised. The comment at `:212-218` is explicit that the filter
"is always applied".

**Therefore the complete set of guest-facing host filesystem mounts on a
default boot is:**

| host | surviving mounts | backend |
|---|---|---|
| browser | `/dev/shm`, `/dev` | `MemoryFileSystem` over `shmSab`; `DeviceFileSystem` |
| Node | `/dev/shm`, `/dev`, plus `extras` (session-seed `/run/kandelo-run`) | same, plus `HostFileSystem` |

(`browser-kernel-worker-entry.ts:1129-1133`; `node-kernel-worker-entry.ts:1190-1195`.)

So the honest question is not "what still makes `memory-fs.ts` the runtime FS
authority for `/`" — nothing does — but **"which runtime paths still read bytes
or metadata through it."** There are exactly four, enumerated next.

### 1.2 RUNTIME read path 1 — every base-file `read()`, via the blob provider

**This is the big one, and it is per-syscall.** `rootfs.rs` owns the tree, but
it does not own the bytes. Base-file content is pulled back through the host on
`ByteReq::Base`, and the provider is:

`host/src/vfs/rootfs-manifest.ts:323-353` — `createRootfsBlobProvider(backend, blobPaths)`:

```ts
return (blobId, offset, dest) => {
  const path = blobPaths.get(Number(blobId));      // ino → path
  if (path === undefined) return -2;               // ENOENT
  handle = backend.open(path, O_RDONLY, 0);        // MemoryFileSystem.open
  return backend.read(handle, dest, Number(offset), dest.length);
};
```

Installed at `node-kernel-worker-entry.ts:1505` and
`browser-kernel-worker-entry.ts:1379`, both through
`KernelWorker.configureRootfsOverlay` (`host/src/kernel-worker.ts:5026`,
`:5036`).

Three things make this the load-bearing item:

1. It is a **live per-read path** through `MemoryFileSystem.open`/`read` →
   `SharedFS` — i.e. through both files K8 targets.
2. `blobPaths` is a host-side `ino → path` map built by walking the tree
   (`rootfs-manifest.ts:183`, `:268`). **The host is resolving a name.** That is
   precisely the 25-import concept V4 §4 says a host must never implement, and
   K9 depends on it going away.
3. Its own doc comment (`rootfs-manifest.ts:318-321`) concedes it "opens per
   call for now".

**Retiring it is exactly K1's unlanded step 4** (see §1.5).

### 1.3 RUNTIME read path 2 — `/dev/shm`, a real live filesystem

`MemoryFileSystem.create(shmSab)` (`node-kernel-worker-entry.ts:1178-1180`,
16 MiB) / `MemoryFileSystem.fromExisting(msg.shmSab)`
(`browser-kernel-worker-entry.ts:1097`, 1 MiB allocated at
`browser-kernel-host.ts:300`), mounted `nosuid` at `/dev/shm`. Every path and fd
operation on that subtree is served by `memory-fs.ts` → `sharedfs-vendor.ts`.
This is the **only** subtree where they are still a complete filesystem
authority. §2 grounds it.

### 1.4 RUNTIME read path 3 — the lazy fetch/materialisation authority

`memfs.setLazyFetcher(...)` (`node:1226`, `browser:1122`/`:1128`),
`memfs.exportLazyArchiveEntries()` feeding `buildRootfsLazyWiring`
(`node:1495`, `browser:1373`, `host/src/vfs/rootfs-lazy-archives.ts:47-131`),
`subscribeLazyDownloads` (`node:1207`, `browser:1135`), and
`rewriteLazyFileUrls`/`rewriteLazyArchiveUrls` (`node:1204-1205`,
`browser:1111-1112`). The archive *fetch* (`rootfs-lazy-archives.ts:135-155`)
runs on demand at first touch of a lazy member, i.e. **at runtime**.

This is host fetch authority — URLs, transports, sha256 seals, the closed-asset
allow-list, activation cohorts — and K1b §1.3 already decided it stays
host-side. K8 does not take it. What K8 *can* take is the **id minting**:
`archive_id` is `nextArchiveId++` at boot (`rootfs-lazy-archives.ts:59`, `:80`),
and K1's `KLZY` already carries an image-assigned `archive_id`, so the minting
pass and its "manifest table and provider table can never drift" procedural
invariant (`rootfs-lazy-archives.ts:14-16`) become structural.

### 1.5 RUNTIME read path 4 — snapshot / export / sharing, which needs the WRITER

**VERIFIED, and this is the constraint most likely to be missed.**
`export_rootfs_image` is a live `KernelHost` API on both hosts
(`browser-kernel-host.ts:1260`, `node-kernel-host.ts:937`), handled in the
kernel worker at `browser-kernel-worker-entry.ts:4010-4046` and
`node-kernel-worker-entry.ts:3951-3990`. It calls:

```ts
const { image: overlayImage } = await exportRootfsImageFromOverlay({
  baseImage: await memfs!.saveImage(),                 // ← the image WRITER
  overlayTree: kernelWorker.rootfsExportTree(),        // ← RXPT from Rust
  readCowBytes: (path) => kernelWorker.rootfsReadFile(path),
});
```

`host/src/vfs/rootfs-overlay-export.ts:1-33` documents the algorithm: clone the
base image with `MemoryFileSystem.fromImage`, reconcile it against the kernel's
authoritative RXPT tree, and re-serialise with `saveImage()`.

**So a running kernel writes VFS images at runtime, in the browser, using
`memory-fs.ts` + `sharedfs-vendor.ts` as the writer.** `saveImage` needs the
entire `SharedFS` mutation stack — `mkfs`, `blockAlloc`, `grow`, `inodeAlloc`,
`dirAddEntry`, `write` (`sharedfs-vendor.ts:353`, `:887`, `:922`, `:950`,
`:998`, `:1889`, `:2836`). None of that is deletable by K8.

### 1.6 A live defect this pass found: a stale-authority diagnostic

`host/src/browser-kernel-worker-entry.ts:424-432` —
`readServiceLogForProcess` reads `/var/log/nginx.log` through
`readFileFromFs` (`:4522-4540`), which opens it on **`memfs`**. `/var/log` has
been kernel tmpfs since Phase 5 (`default-mounts.ts:26-34`), and the host `/`
mount is dropped anyway, so this read can never find the file: it returns
`null`, and the process-failure context silently omits the nginx log.

This is a truthful-failure violation of the quiet kind — a diagnostic that
reports nothing because it queries a retired authority — and it is the only
remaining caller of `readFileFromFs`. K8 should delete it or repoint it at
`kernelWorker.rootfsReadFile`. Recorded as **D-K8-6**.

### 1.7 What must SURVIVE in `memory-fs.ts`, and for whom

**K8 may not simply delete the file.** Measured region split of its 8,269 lines
(boundaries read in source; `saveImage` at `:7029`, `readImageMetadata` at
`:7149`, `readImageKernelLazyLinkage` at `:7188`, `assertImageKernelAbi` at
`:7229`, `fromImage` at `:7292`, `open` at `:7430`, `closedir` at `:7982`):

| region | lines | fate under K8 | who needs it |
|---|---|---|---|
| lazy/deferred-tree validation, HTTP transport retry, integrity + seal validation (`:1-3141` less the container parsers) | ≈3,060 | **SURVIVES** | host fetch authority (K1b §1.3): URLs, transports, sha256, atomic-group seals, closed-asset allow-list |
| container header + section framing parsers (`parseImageHeader:905`, `sectionOffsetAfterArchives:938`, `decodeJsonSection:977`, `maybeDecompressImage:741`) | ≈80 | **SPLIT** — the kernel takes the decode half (`sffs::sffs_span`, `sffs::kernel_lazy_span`); the host keeps it for the host-only JSON sections and for zstd | both |
| `MemoryFileSystem` lazy registry / deferred trees / materialisation / seals (`:3142-7028`) | 3,887 | **SURVIVES** | host fetch authority; `tools/mkrootfs` `registerLazyFile`; `images/vfs/scripts` |
| image container **encode** + restore (`:7029-7429`) | 401 | **SURVIVES** | `tools/mkrootfs/src/builder.ts:24` (imports by source path); `images/vfs/scripts/**`; **and the runtime `export_rootfs_image` path on both hosts** (§1.5) |
| `FileSystemBackend` runtime FS surface (`:7430-7985`) | **556** | **RETIRED** | nothing, once `/dev/shm` is kernel-owned (§2) and the blob provider is gone (§1.2) |
| tail helpers — `createFreshMemoryFileSystem`, inode identity, `createImmutableProductBackend`, `resolveMountSetIdCapability` (`:7986-8269`) | 284 | **SURVIVES** | builder + product-image tooling |

**`sharedfs-vendor.ts` (3,752 lines) survives essentially whole**, as the image
writer's block allocator and directory mutator. K1's `sffs.rs` (752 lines)
already replaces its *read* path, but the read helpers (`r32`/`r64`,
`inodeOffset`, `inodeBlockMap`, `dirLookup`) are shared machinery for the write
path, so removing the reader role removes ~0 lines from this file. It only
leaves the repo when `mkrootfs` moves to Rust — **toolchain campaign, out of
scope** (value plan §1, §3.3).

### 1.8 The BUILDER carve-out (value plan §2c D-B4), stated exactly

`tools/mkrootfs/src/builder.ts:24` imports `../../../host/src/vfs/memory-fs` by
source path. Per D-B4 the VFSI **container encoding** is IN scope; mkrootfs's
CLI, manifest language, and build behaviour are OUT. Concretely, K8 may change
what `saveImage`/`fromImage` write and read; it may **not** change or remove
`registerLazyFile`, `registerLazyArchiveFromEntries`, `importLazyEntries`,
`exportLazyEntries`, `exportLazyArchiveEntries`, `setImageMetadata`,
`readImageMetadata`, `readImageCapacity`, `fromImagePreservingCapacity`,
`rebaseToNewFileSystem`, or the `FileSystemBackend` methods those builders use
to populate a tree — those are the builder API, and the same API is what
`rootfs-overlay-export.ts` uses at runtime.

**Consequence: the `FileSystemBackend` surface at `:7430-7985` cannot actually
be deleted either — only its role as a *guest-visible mount* can.** `mkrootfs`
and `rootfs-overlay-export` both call `open`/`write`/`mkdir`/`symlink`/`chmod`
on a `MemoryFileSystem` to build a tree. What K8 removes is that any *guest
syscall* ever reaches it. That is authority, not lines.

### 1.9 Test fallout, sized not scoped

93 files across `host/test`, `tools/mkrootfs/test`, `tests/`, and
`apps/browser-demos/test` reference `memory-fs` or `sharedfs-vendor`, totalling
**41,048 lines**. The largest: `host/test/lazy-tree.test.ts` (3,909),
`host/test/binary-resolver.test.ts` (3,590), `tools/mkrootfs/test/cli.test.ts`
(1,527), `host/test/vfs.test.ts` (1,417), `host/test/lazy-archive.test.ts`
(1,269), `host/test/vfs-image.test.ts` (1,214),
`host/test/sharedfs-safety.test.ts` (1,009). Most exercise the **object API**,
which §1.7 says survives, so most survive. The ones that assert the mount is
guest-visible, or that assert manifest emission, do not.

---

## 2. Q2 — `/dev/shm`, and whether an in-kernel shmfs really depends on K7

### 2.1 The carve-out, exactly

`crates/runtime-core/src/syscalls.rs:2105-2107`:

```rust
fn is_host_backed_devfs_path(path: &[u8]) -> bool {
    path == b"/dev/shm" || path.starts_with(b"/dev/shm/")
}
```

**13 sites** (the definition plus 12 uses), all in `syscalls.rs`, all of the
shape `is_devfs_namespace_path(p) && !is_host_backed_devfs_path(p)` = "kernel
owns this": `:2161` (`namespace_lstat_raw` ENOENT trapdoor), `:2339`
(`resolve_namespace_path_from` — allows creation under `/dev/shm`), `:2471`
(`ensure_host_mutable_namespace_path` — exempts it from `EROFS`), `:3286`
(`sys_open`), `:7698` (`sys_stat`), `:7744` (`sys_lstat`), `:8499`
(`sys_opendir`), `:14939` (`sys_openat`), `:15113` (`sys_fstatat`), `:17026`
(`sys_pathconf`), `:17091` (`sys_fpathconf`), `:18112`
(`virtual_statfs_for_path`).

Plus a **14th, non-predicate special case** at `:2124-2135`: `namespace_lstat_raw`
`fs_lstat`s the literal `/dev/shm` *before* consulting kernel devfs and accepts
the result only if it is a directory — *"`/dev/shm` is a higher-priority
writable host mount on both Node and browser."*

**Every other path in `/dev` is kernel-owned**, and unknown names hard-fail
`ENOENT` (`:2158-2163`) or `EROFS` (`:2469-2477`). Device *files* are matched in
`match_virtual_device` (`:218-231`: `/dev/null`, `/dev/console`, `/dev/zero`,
`/dev/urandom`, `/dev/random`, `/dev/full`, `/dev/fb0`, `/dev/input/mice`,
`/dev/dsp`, `/dev/dri/*`); directories in `crates/runtime-core/src/devfs.rs`.

Folding `/dev/shm` into the kernel therefore **deletes the predicate and all 12
negative guards plus the special case** — a genuine V2/V4 simplification of
`syscalls.rs`'s namespace routing, not just a relocation.

### 2.2 Everything that uses `/dev/shm`

**In libc — two functions, both upstream musl, no overlay override**
(`libc/musl-overlay/include/sys/mman.h:144-145` and `semaphore.h:26,31` carry
declarations only; `libc/glue/` has no `/dev/shm` reference at all — its `shm*`
symbols are SysV `shmget`/`shmat`/`shmctl`, `libc/glue/syscall_glue.c:1754-1804`,
a different mechanism):

- **`shm_open`** — `libc/musl/src/mman/shm_open.c:22` builds `"/dev/shm/" + name`
  in `__shm_mapname`, then `open(name, flag|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK, mode)`
  (`:30`). `shm_unlink` (`:37-42`) is a plain `unlink`. **No mmap here** — the
  fd is bare; mapping is the caller's choice.
- **`sem_open`** — `libc/musl/src/thread/sem_open.c`. It needs three things from
  the mount: `open` with `O_NOFOLLOW` (`:30`, `:88`); **`link(tmp, name)` +
  `unlink(tmp)`** for atomic creation via `/dev/shm/tmp-<nsec>` (`:118`,
  `:130-132`) — i.e. **hardlink support**; and **`mmap(0, sizeof(sem_t),
  PROT_READ|PROT_WRITE, MAP_SHARED, fd, 0)`** at `:91` and `:124`. It dedupes
  live mappings by `st_ino` (`:145-151`), so **stable inode identity is
  load-bearing**.

**Real users — VERIFIED there are none in shipped software.** No
`packages/registry/**` build or runtime path calls either; the five grep hits
are autoconf caches/logs, and `packages/registry/ruby/build-ruby.sh:715,734`
explicitly sets `ac_cv_func_sem_open=no` / `ac_cv_func_shm_open=no`. The only
callers are conformance suites — `tests/libc/libc-test/src/functional/sem_open.c`,
`.../pthread_cancel-points.c:84-110`, `tests/sortix/os-test/basic/sys_mman/shm_{open,unlink}.c`,
`.../basic/semaphore/sem_{open,close,unlink}.c` — of which only
`libc-test/functional/sem_open.c` maps, and **that test is a recorded timeout
today** (`docs/libc-test-failures.md:38`). Plus `examples/chown_sentinel_test.c:210`,
which uses `/dev/shm/lchown-target` only as a known-writable path.

`host/test/file-shared-memory.test.ts:126-127,694,778` uses the *string*
`"/dev/shm/php-cache"` against a mocked backend — a harness fixture, not a guest.

### 2.3 What an shmfs generalized from `tmpfs.rs` needs that `tmpfs.rs` lacks

`crates/runtime-core/src/tmpfs.rs` is 1,724 lines. Its model: `InodeKind::{Dir(BTreeMap),
Regular(Vec<u8>), Symlink(Vec<u8>), Special(u32)}` (`:105-116`) — **file contents
are a flat `Vec<u8>`, no page structure** — under one process-global spinlock
(`TmpfsGlobal`, `:374-415`), living in the kernel's single wasm `Memory`, so it
is already visible to every process of one kernel instance without any
protocol. Mounts are a `const SCRATCH_MOUNTS` table (`:92-101`) with per-mount
`st_dev` from `TMPFS_DEV_BASE = 0x7400_0000` (`:79`). Handles are negative,
banded (`:73-74`, `:503-511`).

It already has everything `shm_open`/`sem_open` need except the mount itself:
`open:551`, `read:628`, `write:649`, `truncate_handle:696`, `unlink:845`,
`lstat:537`, `fstat:689`, `statfs:915`, `rename:939`, **`link:1020`** (the
hardlink `sem_open` requires), `chmod:1127`, `chown:1138`, `utimensat:1206`,
`opendir:1059`/`readdir:1092`/`getdents64:1303`, and stable per-mount
`(st_dev, st_ino)`.

**The gaps:**

1. **No `/dev/shm` mount entry.** `SCRATCH_MOUNTS` is a `const` with no runtime
   registration. An eighth entry (`mode 0o1777`, uid/gid 0,
   `st_dev = TMPFS_DEV_BASE + 7`) is the whole change — it reuses the existing
   handle bands and needs no new module. Whether shmfs should be a *separate*
   module or an eighth tmpfs mount is D-K8-2 below.
2. **Reconciling with the devfs carve-out** — the 13 sites of §2.1, plus
   `devfs.rs:45`'s `DevfsEntry::ShmDir` and `devfs.rs:162`'s listing of `shm`
   as a `DT_DIR` child of `/dev` (which must stay so `readdir("/dev")` still
   shows it, but must no longer short-circuit).
3. **No mmap of any kind.** `grep -E 'mmap|MAP_SHARED|page' tmpfs.rs` → zero
   hits. There is no page table, no dirty tracking, no mapping registry, no
   `msync` hook. §2.5 is where this matters.
4. Host wiring to delete: `shmSab` + `MemoryFileSystem.create/fromExisting`
   (`node:1178-1180`, `browser:1097`, `browser-kernel-host.ts:300-301,509`,
   `browser-kernel-protocol.ts:91`), the `/dev/shm` mount entries
   (`node:1191`, `browser:1131`), its entry in `rootfsForeignPrefixes`
   (`node:1241-1247`, `browser:1150-1155`), and the macOS rewrite in
   `host/src/platform/node.ts:72-88`.

### 2.4 The `shmSab` is NOT a shared mapping — this is where the K7 story starts

**VERIFIED by exhaustive grep:** `shmSab` appears at exactly six sites —
`browser-kernel-protocol.ts:91`, `browser-kernel-host.ts:232,300,301,509`,
`browser-kernel-worker-entry.ts:1097`, `node-kernel-worker-entry.ts:1178-1179`.
The browser main thread allocates and formats it and hands it to the **kernel
worker**; the Node kernel worker allocates it itself. **No process worker ever
receives it.** It is a single-consumer `SharedArrayBuffer` used as a byte store
for one `MemoryFileSystem`, not as memory shared with guests.

So the census sentence — H5 *"defers this until SAB-shared `mmap` handled in
Rust first"* — rests on a false premise about what the SAB is. That specific
dependency is **REFUTED**.

### 2.5 But a real dependency exists in its place, and it is not K7

Here is the mechanism, verified in code.

**There are two shared-file-mapping backends in `host/src/kernel-worker.ts`**
(≈3,000 lines total: types `:1581-1760`, state `:3209-3245`, dispatch
`:13219-13800`, the bulk `:26871-29365`):

1. **Host-handle backing** — `prepareSharedMmapFromFile` (`:27029`) →
   `registerPreparedSharedMmap` (`:27189`). Requires `stat.hostHandle !== null`.
   Creates a `SharedMmapBacking` (`:1636-1646`) keyed by backend-qualified
   `(dev, ino)`, with a page cache, a `version` counter, dirty-run merging
   (`mergeChangedFileMappingRuns:28154`) and **cross-process publication**
   (`publishSharedMmapBackingObservers:28127`; import side
   `:28067`, `:28107-28122` — `const wasStale = (mapping.seenVersion ?? 0) !== backing.version`).
   **This is the path `/dev/shm` uses today**, because its `MemoryFileSystem`
   mount yields a real host handle.
2. **fd-writeback for kernel-owned files** — selected when
   `stat.hostHandle === null`, i.e. in-kernel tmpfs and memfd
   (`:27055-27116`, `registerFdWritebackSharedMmap:27256`). Read-only maps fall
   through to `populateMmapFromFile`; **writable maps get a real bridge**: pread
   to populate, `F_DUPFD_CLOEXEC` for a stable writeback fd, pwrite at
   msync/munmap/exec/teardown with `(dev, ino)` revalidation
   (`flushFdWritebackMapping:27493`). The comment at `:27093-27099` is explicit
   that the kernel's `fd_supports_mmap_writeback`
   (`syscalls.rs:10297-10307`, which requires `ofd.host_handle >= 0`) is
   deliberately not consulted, *"because this path does not write to host
   storage — it writes back to the kernel-owned file through the guest's own
   fd."*

**So writable `MAP_SHARED` of a kernel-owned file already works.** An shmfs
generalized from `tmpfs.rs` inherits it unchanged, because path (2) is selected
on `hostHandle === null`, not on the pathname. **K7 is not needed for that.**

**The real gap is direction.** Path (2) is **flush-only**. Verified at
`:29520-29556` (`flushSharedMappings`) and `:9622-9648`
(`prepareAddressSpaceForExec`): `fdWriteback` mappings are pushed out, and the
import side (`syncFileSharedMappingsFromProcess`, `:28067`, `:28107`) is gated
on `mapping.backingKey`, which fd-writeback mappings deliberately do not have
(`:29119` — `if (!mapping.backingKey && mapping.fdWriteback)`).

**Therefore:** moving `/dev/shm` to an in-kernel shmfs as-is would take
`MAP_SHARED` on `/dev/shm` from *"converges between processes at syscall
boundaries"* to *"one-shot snapshot in, flush-only out"*. That is a **silent
regression of a documented capability** — `docs/posix-status.md:426`
(`/dev/shm/*`: *"Stable-identity backends support host-coordinated `MAP_SHARED`
across processes at syscall boundaries"*) and `:227` (`shm_open()`). The
platform-values contract forbids landing it silently.

### 2.6 Verdict on the K7 dependency

**The stated dependency is REFUTED; a narrower real one replaces it.**

- **REFUTED:** *"blocked until SAB-shared `mmap` is handled in Rust"*. The
  `shmSab` is not a shared mapping (§2.4). Kernel-owned files already support
  writable `MAP_SHARED` (§2.5). And `fd_supports_mmap_writeback`
  (`syscalls.rs:10297-10307`) already **excludes** kernel-owned files from the
  host page cache by design — so moving `/dev/shm` into the kernel *removes* it
  from K7's machinery rather than deepening the coupling. The dependency edge in
  the value plan (§5 Tier 3, and §7's `K7 ──► H5`) and the census's
  `K8 depends on K1, K7` (census §10) are **wrong as written**.
- **REAL:** kernel-owned-file `MAP_SHARED` has no cross-process *import* path.
  This must be closed before or with the `/dev/shm` cutover.
- **It can be discharged inside K8**, and more cheaply than by K7: give
  fd-writeback mappings a backing keyed on the kernel `(dev, ino)` and reuse the
  existing publish/import code (`:28127`, `:28067`) — the machinery exists, it
  is simply not wired for `hostHandle === null`. Alternatively the kernel, which
  owns the bytes in one global store (`tmpfs.rs:374-415`), can serve the
  convergence itself, which is strictly better than a host page cache and is the
  V1/V2 answer.
- **Sequencing verdict: K8's shmfs does NOT wait for K7.** It waits for one
  bounded piece of mapping work that belongs to it.

**A second, independent risk that must not be traded away silently:** the
fd-writeback path's writeback descriptor is a **guest-visible fd number**, and
`kernel-worker.ts:1615-1633` documents that a guest `closefrom`/`dup2` can
repoint it — which is why `expectedDev`/`expectedIno` are re-checked before every
pwrite. Today `/dev/shm` does not use that path. Moving it there adopts that
risk. It is guarded, not unguarded, but it is new exposure and belongs in the
report.

**A documentation defect found in passing:** `docs/posix-status.md:225` still
says *"in-kernel memfd and any backend unable to prove stable identity return
`ENOTSUP` for `MAP_SHARED`"*. The fd-writeback bridge (`kernel-worker.ts:27082-27116`)
made that false for kernel-owned regular files. Recorded as **D-K8-5**.

---

## 3. Q3 — Step 5 and the ABI stamp: what removing it concretely requires

Value plan §2c decision 3 split this out with its own ABI ruling. Scoping it
concretely, in three parts.

### 3.1 Part A — what still reads the JSON after `KLZY`

**VERIFIED on this branch: `KLZY` has landed but nothing consumes it, and the
kernel still does not parse an image at all.**

- `crates/runtime-core/src/klzy.rs` (479 lines) — decoder plus tests.
  `decode_kernel_lazy_linkage` (`:113`) is called **only from its own tests**
  (`:281,299,306,314,...`).
- `crates/runtime-core/src/sffs.rs` (752 lines) — `Sffs<S: BlockSource>`
  (`:236`), `sffs_span` (`:101`), `kernel_lazy_span` (`:139`). **No caller
  outside the file**: `grep -rn "Sffs::mount\|sffs::" crates --include='*.rs'`
  excluding `sffs.rs` itself returns nothing.
- There is **no `load_sffs_image`** and **no `kernel_rootfs_load_image`** export.
- Host encoder: `host/src/vfs/kernel-lazy-section.ts` (437 lines),
  `MemoryFileSystem.readImageKernelLazyLinkage` (`memory-fs.ts:7188`), fixture
  generator `host/scripts/gen-klzy-fixture.mts`, equivalence test
  `host/test/vfs-image-kernel-lazy.test.ts` (542 lines).

**So K1 landed steps 1-3 of its own §7.2 plan (define, dual-write, prove
equivalence). Steps 4 (cut over the reader) and 5 (delete the JSON `entries[]`)
are unlanded, and step 4 is K8's actual first job.** The `~12,000 lines` figure
and the "K1 already unblocked the bundle" framing both need this correction.

Until step 4, the JSON is read by: `MemoryFileSystem.fromImage`
(`memory-fs.ts:7292`) → `importLazyEntries` (`:4557`) and
`importVerifiedLazyArchiveEntries` (`:5055`); then
`exportLazyArchiveEntries` (`:5595`) → `buildRootfsLazyWiring`
(`rootfs-lazy-archives.ts:47-131`) → RTFS v3 `KIND_LAZY_FILE`
(`rootfs-manifest.ts:172-293`) → `rootfs::load_manifest` (`rootfs.rs:977-1046`).
After step 4 the kernel reads `KLZY` directly and the **host-needed** half
(URLs, transports, integrity, activation, seals) stays JSON in a host-only
section, per §2c decision 7 (D-B2).

### 3.2 Part B — what enforces `--kernel-abi` / `--abi-snapshot-sha256` at load

**Written** at `scripts/build-rootfs.sh:197` →
`tools/mkrootfs/src/cli/build.ts:132-137` → `:254-262` →
`tools/mkrootfs/src/builder.ts:70,123` → `MemoryFileSystem` metadata JSON
section (`memory-fs.ts:7029+`, flag `1<<2`).
K1b §7.1 VERIFIED that **`--abi-snapshot-sha256` is not present in any image in
this worktree** — only `--kernel-abi` is actually stamped.

**Read** by four sites, and **none of them is the runtime load path**:

| site | what it does | live? |
|---|---|---|
| `host/src/binary-resolver.ts:2911-2926` (`hasVfsArtifactPolicyFailuresForBytes`) | `readImageMetadata(bytes)?.kernelAbi !== ABI_VERSION` → the artifact is a policy failure; fail-closed on inspection error | **yes** — artifact resolution / build-cache invalidation |
| `host/src/vfs/memory-fs.ts:7229` (`assertImageKernelAbi`) | throws on mismatch, tolerates an absent declaration | **no caller** anywhere outside tests |
| `scripts/vfs-has-stale-abi.mjs` | standalone re-implementation of the container framing + `JSON.parse` | **no caller** — only its own usage string and two CI path-scope lists |
| `tools/mkrootfs/src/cli/inspect.ts:226` | display only | n/a |

**So the answer to "what enforces it at load" is: nothing. There is no load-time
enforcement to remove.** The stamp's only live job is build-cache freshness in
`binary-resolver.ts`.

### 3.3 Part C — what breaks for an OLD image when the stamp goes

**Nothing at load time, because nothing checked it at load time.** The real
guard is per-Wasm-program and is independent: `verifyProgramAbi` in
`host/src/worker-main.ts:4827` and `:5577`, and
`describeWasmArtifactPolicyFailures` + `extractAbiVersion` in
`node-kernel-worker-entry.ts:1109-1122`, which fail `ENOEXEC` on mismatch. An
ABI-43 image loaded by an ABI-44 kernel still fails loudly the first time it
execs a stale program — at the right layer, naming the right artifact.

What *does* break is **build-cache freshness**: an ABI bump would stop
invalidating stamped `.vfs`/`.vfs.zst` entries in the binary index, so a stale
image could be resolved and served. That signal must be replaced, not dropped.
The right replacement is the mechanism the repo already prefers — a
closure-derived cache key (`build.toml` `inputs` / `cacheKeys` /
`crates/*/build_deps.rs`, the `build-freshness: closure-derived cache-keys`
pattern), because the image's real freshness input is the *kernel build closure*,
not a hand-written integer. Removing the stamp without replacing the signal
would recreate exactly the "silently served a STALE kernel despite green unit
tests" failure of PR #1328.

### 3.4 Concrete scope of "remove the stamp"

1. Drop `--kernel-abi` (and the unused `--abi-snapshot-sha256`) from
   `scripts/build-rootfs.sh:197` and `tools/mkrootfs/src/cli/build.ts:132-137,254-262`.
   *(This is a mkrootfs CLI change — see STRONG DOUBT SD-K8-3 on the D-B4
   carve-out.)*
2. Delete `hasVfsArtifactPolicyFailuresForBytes`'s ABI comparison
   (`binary-resolver.ts:2911-2926`) **and land its replacement freshness signal in
   the same change.**
3. Delete the two dead readers: `assertImageKernelAbi` (`memory-fs.ts:7229`) and
   `scripts/vfs-has-stale-abi.mjs`, plus the two CI path-scope list entries that
   name the latter.
4. Keep `kernelAbi` out of the metadata type, or keep the field as pure
   provenance with no comparison — decide explicitly, do not leave it half-read.
5. Record the ruling in `docs/abi-versioning.md` under the ABI 44 section, per
   §2e's D2 decision that later K items append there.

**ABI ruling needed (not mine to make): D-K8-3.** `docs/agent-guidance/abi.md`
lists *"VFS image metadata that binds Wasm programs to a kernel ABI"* as ABI
surface. Removing that binding is a **withdrawal** of ABI surface, not an
addition — and §3.3 shows it withdraws nothing that was enforced. My reading is
that it is an amendment inside the unreleased ABI-44 epoch
(`abi-versioning.md:790-794`, the rule K13a used), not a bump. But it is a
judgement about the ABI contract's *meaning* and belongs to the maintainer.

**This is the actual V3 completion.** After step 4 and this removal, an image
contains: an SFFS block filesystem the kernel parses, a `KLZY` linkage section
the kernel parses, and host-only JSON for fetch authority and provenance.
Nothing in it is bound to the guest ABI except the Wasm programs inside it,
which carry and check their own. That is exactly V3's *"images carry no
guest-ABI stamp; the only versioned boundary is kernel↔host."*

---

## 4. Q4 — The three pre-manifest host mutations

K1 proved (value plan §2f, SD-B3 resolved) that `fromImage` copies into a fresh
SAB, so all three operate on a copy and the source image is never mutated. That
closes the *lock-free-read* concern. It does **not** close this one: a kernel
parsing the raw image sees a tree the host has since changed. Under step 4 the
host stops walking the image, so whatever these three do must either move or
disappear. Taking them one at a time, because they are three different kinds of
thing and the correct answer differs for each.

### 4.1 `normalizeLegacyRootfs` — `host/src/vfs/default-mounts.ts:160-168`

Appends `nobody:x:65534:` to `/etc/group` when absent. Its own comment:
*"Compatibility for already-published dinit demo images that contain a nobody
user but not the matching nobody group. php-fpm validates `group = nobody`
during pool startup and exits EX_CONFIG (78) without it."* Called from
`restoreVerifiedImageMounts` (`default-mounts.ts:278`).

**Verdict: do NOT move it into the kernel. Delete it and rebuild the images.**
This is a patch for *specific already-published demo image artifacts*. Moving it
into the kernel would put demo-image-specific `/etc/group` editing into the
kernel's boot path — package-specific behaviour in the platform, which the
platform-values contract forbids in as many words. The campaign is one ABI epoch
and grants image rebuilds (value plan §1); every image is being rebuilt for
`KLZY` anyway. If some artifact genuinely cannot be rebuilt, that is a
compatibility boundary that must be *named and documented*, not silently
re-implemented in Rust.

**Cost of getting this wrong is asymmetric**: keeping it costs an image rebuild;
moving it costs a permanent demo-shaped special case inside the kernel.

### 4.2 `ensureMountParentDirectories` — `host/src/vfs/default-mounts.ts:187-210`

`mkdir`s the parent components of extra mount points so the kernel's
per-component search-permission checks can reach them. Called at
`node-kernel-worker-entry.ts:1202`.

**Verdict: this must move into the kernel, and it is nearly free.** The kernel
*already receives the exact input it needs* — `rootfsForeignPrefixes`
(`node:1241-1247`, `browser:1150-1155`) → `kernel_rootfs_set_foreign_prefixes`
→ `rootfs::set_foreign_prefixes` (`rootfs.rs:464`). Synthesising the parent
directories of a prefix it already holds is a `rootfs.rs`-local change using the
existing `insert_base_dir` inserter. It is also *more correct* there: the
namespace is the kernel's, and today the host is guessing at what the kernel's
permission checks will require.

### 4.3 The browser TLS-cert write — `browser-kernel-worker-entry.ts:1170-1179`

Writes the runtime-generated MITM CA certificate to
`/etc/ssl/certs/ca-certificates.crt` (creating `/etc`, `/etc/ssl`,
`/etc/ssl/certs`) so guest OpenSSL trusts it.

**Verdict: must move into the kernel, and the mechanism already exists — no new
host surface.** `kernel_rootfs_write_file` is already an export
(`host/src/kernel-scratch.ts:163`, `:278`, `:352`) with a host-side wrapper
`KernelWorker.rootfsWriteFile`, used today by the `write_vfs_file` RPC
(`browser-kernel-worker-entry.ts:3969-3985`, `node-kernel-worker-entry.ts:4012-4030`,
protocol at `browser-kernel-protocol.ts:161` / `node-kernel-protocol.ts:242`,
callers `browser-kernel-host.ts:1233`, `node-kernel-host.ts:922`). This content is
genuinely per-session runtime data and can never be baked into an image, so it
*must* be a runtime write.

**One sequencing constraint, and it is real:** today the cert is written at
`:1170-1179`, *before* `CentralizedKernelWorker` is constructed at `:1187`.
Moving it to `rootfsWriteFile` requires it to happen after `init`, and before
any guest process runs. That is a genuine ordering change in the browser boot,
so it needs a browser test that a fresh session's first HTTPS-using process
trusts the CA — not code reasoning (`docs/agent-guidance/browser-and-user.md`).

### 4.4 What this means for K8 overall

The three mutations are **not one problem**. One is an image-artifact patch that
should be deleted (4.1); one is namespace policy the kernel already has the
inputs for (4.2); one is genuine runtime data with an existing kernel write path
(4.3). None of them requires new host surface, and none of them blocks step 4 —
they block the *deletion of `emitRootfsManifest`*, which is the same moment.
D-B5 in the value plan can be closed with these three answers, subject to the
maintainer accepting 4.1's "rebuild, don't re-implement".

---

## 5. Q5 — The host/kernel byte line, drawn exactly, with counts

### 5.1 The line

**Below the line (the host stays):** *the host opens an opaque handle it was
given, and moves bytes on it.* Concretely — `host_open`-equivalents on a
**handle the kernel already resolved**, `host_read`/`host_write`/
`host_pread`/`host_pwrite`/`host_seek`/`host_close`, `host_blob_read`
(positioned read of an opaque 64-bit id), `host_fetch_archive`, and the
transport that produces bytes: OPFS `FileSystemSyncAccessHandle`, Node `fs`,
`fetch`. Also below the line: **zstd decompression of the image**, because it is
a transport codec (`sffs.rs:3`; `maybeDecompressImage`, `memory-fs.ts:741`) —
stated so the V3 claim stays honest that "the host supplies bytes" means
*decompressed* bytes.

**Above the line (the kernel owns):** anything that requires knowing what the
bytes *mean* — path resolution, the inode tree, permissions, times, directory
structure, the SFFS/VFSI/`KLZY` formats, lazy linkage, tar/zip decode, mount
policy, the manifest.

**The single sharpest test:** does the host have to resolve a *name*? If yes it
is above the line. `createRootfsBlobProvider`'s `blobPaths.get(blobId)` →
`backend.open(path)` (`rootfs-manifest.ts:328-334`) is the clearest current
violation, and V4 §4 puts the target for the name-taking concept at **0**.

### 5.2 Counted, `host/src/vfs/` = **23,089** lines on this branch

(Up from the ledger's 22,599: `kernel-lazy-section.ts` (+437) and `memory-fs.ts`
growth from K1.)

| side | lines | files |
|---|---|---|
| **Below the line — genuine host byte stores + transport (KEEP)** | **3,884** | `opfs-worker.ts` 1445, `host-fs.ts` 768, `closed-lazy-assets.ts` 699, `opfs.ts` 364, `opfs-channel.ts` 295, `opfs-stat.ts` 75, `time.ts` 63, `browser-lazy-fetcher.ts` 62, `opfs-types.d.ts` 46, `opfs-directory-iterator.ts` 33, `opfs-append.ts` 29, `lazy-url.ts` 5 |
| **The seam — dispatch, shared types, barrel (KEEP, shrinks)** | **813** | `vfs.ts` 498, `types.ts` 105, `index.ts` 105, `canonical-text.ts` 44, `product-mount-contract.ts` 37, `i64.ts` 24 |
| **Above the line** | **18,392** | `memory-fs.ts` 8269, `sharedfs-vendor.ts` 3752, `privileged-projection.ts` 864, `package-deferred-tree.ts` 861, `tar.ts` 649, `materialization-plan.ts` 577, `kernel-lazy-section.ts` 437, `zip.ts` 389, `rootfs-manifest.ts` 354, `default-mounts.ts` 348, `device-fs.ts` 339, `default-mounts-node.ts` 330, `rootfs-overlay-export.ts` 318, `package-deferred-tree-contract.ts` 250, `rootfs-overlay.ts` 172, `rootfs-lazy-archives.ts` 141, `hardlink-graph.ts` 106, `image-helpers.ts` 96, `deferred-tree-limits.ts` 81, `load-image.ts` 59 |

**Roughly 4,700 lines below the line and in the seam; 18,400 above it.**

**But "above the line" ≠ "K8 deletes it" — see §7.** Most of `memory-fs.ts` and
essentially all of `sharedfs-vendor.ts` are above the line *as runtime
authority* while remaining necessary *as the builder and the runtime image
writer* (§1.7). They stop being consulted by a guest syscall; they do not leave
the repo until the toolchain campaign.

### 5.3 Two things on the above-the-line list that deserve separate notice

- **`privileged-projection.ts` — 864 lines, zero production consumers.**
  VERIFIED: repo-wide, the only references are `host/test/privileged-projection.test.ts`,
  `host/test/kernel-authority-boundary.test.ts:8,307` (which asserts
  `package.json` does *not* export it), and two CI exclusion lists
  (`scripts/ci-run-test-suite.sh:49`,
  `tests/scripts/ci-run-test-suite-groups.test.sh:521`) that **exclude its test
  from the default suite**. 864 lines of unexercised surface sitting inside K8's
  blast radius. It needs a disposition decision (D-K8-4), not a silent port.
- **`device-fs.ts` — 339 lines, probably fully shadowed.** The kernel owns every
  `/dev` path except `/dev/shm` (§2.1) — directories via `devfs.rs`, device
  files via `match_virtual_device` (`syscalls.rs:218-231`), PTYs via
  `match_pty_stat`, `/dev/fd/*` via `match_dev_fd` — and unknown `/dev` names
  hard-fail before the host is consulted (`:2158-2163`). **INFERRED (high
  confidence, not proven):** the `/dev` `DeviceFileSystem` mount is unreachable
  from any guest syscall. Proving it is cheap and should be a K8 increment:
  instrument the backend to throw on any call, boot both hosts, run the devfs
  conformance paths, and delete it if nothing fires. Do not delete it on
  reasoning alone.

---

## 6. Q6 — Browser: what must be validated, and what would break silently

`docs/agent-guidance/browser-and-user.md` is binding here: browser persistence
and sharing are **platform contract**, boot descriptors and shared URLs are
untrusted input, and browser-facing fixes are not complete from code reasoning
alone. K8 touches all three.

### 6.1 What would break SILENTLY — the failures a Node-only run would miss

1. **The TLS CA cert (§4.3).** Moving it after `init` is a browser-boot ordering
   change with no Node counterpart. If it lands late, every HTTPS-using guest
   fails certificate verification — and OpenSSL's failure surfaces inside the
   guest, not as a host error. Silent by construction.
2. **`export_rootfs_image` (§1.5).** It requires a quiescent kernel
   (`browser-kernel-worker-entry.ts:4022-4029`) and reconciles RXPT against a
   `saveImage()` clone. If `KLZY` write-back, lazy-descriptor preservation, or
   the base-image clone regresses, the export still *succeeds* and produces a
   subtly wrong image — which the user then persists or shares. This is the
   exact failure mode `browser-and-user.md` names: presenting state as a
   durable, verified platform image when it is not.
3. **Lazy archives.** `/dev/shm` and blob-provider changes both sit next to the
   fetcher wiring (`browser:1111-1128`). A double-fetch or a dropped fetcher is
   invisible in Node (local `file://` reads) and expensive in the browser (the
   comment at `browser:1143-1146` says leaving `/` mounted *"would double-fetch
   lazy archives"* — the hazard is already known).
4. **Image-switch memory.** The recorded WebKit reclaim problem
   (Safari image-switch OOM) means any change to how many `MemoryFileSystem` /
   SAB copies are live across a switch is a browser-only risk. K8 *reduces*
   copies, which is the good direction, but the claim needs measuring.
5. **Service worker.** The SW caches VFS images and lazy bundles and performs
   CORS projection. A container-format change (step 5 removing `entries[]`)
   changes image bytes and therefore cache identity; a stale cached image is a
   silent wrong-artifact boot.
6. **`/dev/shm` mmap convergence (§2.5).** If a guest ever uses `sem_open`, the
   regression is a lost wakeup, not an error.

### 6.2 What must actually be run

Per `docs/agent-guidance/validation.md`, and stated as evidence-for-a-claim:

- **`./run.sh browser`, manual**, for the CA-cert ordering and a full demo boot
  (shell, wordpress) — `docs/agent-guidance/browser-and-user.md` requires manual
  verification of user-visible browser fixes.
- **Playwright**, at minimum: `rootfs-export.spec.ts` (the export contract),
  `vfs-import-seal-boundary.spec.ts` (untrusted-image boundary),
  `lazy-archive-runtime.spec.ts` and `closed-lazy-asset-sources-browser.spec.ts`
  (lazy fetch), `package-deferred-tree-browser.spec.ts`,
  `kandelo-source-rootfs-shell.spec.ts`, `kandelo-wordpress.spec.ts`,
  `service-worker-scope-state.spec.ts` and `sw-bridge-fetch.spec.ts` (SW),
  `kandelo-url.spec.ts` and `scoped-deployments.spec.ts` (sharing / boot
  descriptors), `openssl-rootfs.spec.ts` (the CA cert), plus the OPFS group
  (`opfs-*.spec.ts`) because §5 claims OPFS is untouched and that claim should
  be tested rather than asserted.
- **`kandelo-webkit-smoke.spec.ts`** specifically, for the image-switch
  reclaim path.
- **Node parity** for every one of the above that has a Node counterpart
  (`node-host-counterparts.spec.ts`, `host/test/node-rootfs-export.test.ts`) —
  the host-runtime contract forbids landing this Node-first or browser-later.
- **Conformance**: `tests/libc` and `tests/sortix` shm/semaphore paths, because
  §2 changes what `/dev/shm` is. Note `libc-test functional/sem_open` is a
  **known timeout today** (`docs/libc-test-failures.md:38`) — so it cannot be
  used as a pass/fail oracle for §2.5 without first being made to run.

### 6.3 One browser-specific asymmetry to preserve deliberately

`/dev/shm` is 16 MiB on Node (`node:1178`) and **1 MiB on browser**
(`browser-kernel-host.ts:300`). An in-kernel shmfs has no such split — it draws
from the kernel's own memory. That is a behaviour change in both directions
(browsers gain capacity, Node loses an explicit bound) and should be an
intentional, stated decision with a real limit, not an accident of the port.

---

## 7. Challenging the ~12,000-line framing — the evidence disagrees

The census and value plan size K8 at **~12,000 lines**, sourced from
`memory-fs.ts` (8,198) + `sharedfs-vendor.ts` (3,752) = 11,950. Four
measurements say that number does not describe K8's work.

1. **Most of those lines are the writer and the fetch authority, and both
   survive** (§1.7). The `FileSystemBackend` runtime surface is **556 lines** of
   `memory-fs.ts`; the container encode/decode is ~480. `sharedfs-vendor.ts`
   loses ~0 lines, because its read helpers are shared with the write path that
   `saveImage` needs.
2. **The `/` runtime authority was already retired by Phase 5** (§1.1). K8
   inherits a much smaller live surface than the census recorded.
3. **`sffs.rs` + `klzy.rs` are still wired to nothing** (§3.1). K8's first real
   job is K1's unlanded step 4 — writing `rootfs::load_sffs_image` and the
   `ByteReq::Image` plumbing — which is *new Rust*, not retired TypeScript.
4. **Deletion, counted honestly.** What K8 plausibly removes:
   `memory-fs.ts` FS surface as a mount (556, retained as builder API),
   `rootfs-manifest.ts` (354, dies at cutover), `rootfs-lazy-archives.ts` (141,
   id minting becomes structural), the `/dev/shm` host wiring (~40 across four
   files), the `is_host_backed_devfs_path` predicate + 12 guards + the
   `:2124-2135` probe in `syscalls.rs` (~60), the ABI-stamp readers (~130
   including `vfs-has-stale-abi.mjs`), `device-fs.ts` if §5.3 proves out (339),
   and the step-5 JSON `entries[]` encoder/validator shrink (low hundreds).
   **Order of 1,500–2,500 TypeScript lines removed, against a comparable amount
   of new Rust.**

**Better framing for K8, and the one this grounding recommends:**

> K8 is not a 12,000-line deletion. It is **four authority transfers** —
> (a) base-file bytes, from a name-resolving host provider to a kernel-parsed
> image; (b) `/dev/shm`, from a host `MemoryFileSystem` to an in-kernel shmfs;
> (c) the three pre-manifest mutations, from host pre-edits to kernel ownership
> or image rebuilds; (d) image compatibility, from a guest-ABI stamp to the
> kernel↔host boundary — that together complete V3. `memory-fs.ts` and
> `sharedfs-vendor.ts` stop being *read by the running system* and become purely
> the image **writer**, which is toolchain and leaves later.

That framing also fixes the dependency graph: **K8 depends on K1 *step 4*, which
K1 did not land**, and **not on K7** (§2.6).

---

## 8. STRONG DOUBT

**SD-K8-1 — "K8 depends on K7" is not supported by the code.** The census
(§10) and the value plan (§5 Tier 3, §7) both draw it. §2.4 shows the premise
(`shmSab` as shared mapping) is false and §2.5 shows kernel-owned files already
have a writable `MAP_SHARED` bridge; §2.6 shows the true gap is a missing
*import* direction that K8 can close in the machinery that already exists. Do
not schedule K8 behind K7 on the strength of the inherited edge. **This is the
fifth inherited claim in this campaign to fail re-test** (after
wasmtime-exnref, the E1 GC blockers, the V8 `epoll_pwait` claim, and the
`netif.rs` "kernel cannot reach process memory" assertion).

**SD-K8-2 — no new host surface is needed anywhere in K8, and any proposal to
add one should be refused.** Verified for each part: image bytes ride
`ByteReq::Image` on the existing `host_blob_read` import (value plan §2c
decision 2 — a typed variant, not a repurposed `blob_id`); the shmfs *removes*
a host mount rather than adding a capability; the TLS-cert write uses the
existing `kernel_rootfs_write_file` export (§4.3); the ABI stamp removal only
deletes. If an increment starts asking for a new `env.host_*`, that is the
signal the design went wrong, not that the floor was found.

**SD-K8-3 — removing `--kernel-abi` edits `tools/mkrootfs`'s CLI, which D-B4
put OUT of scope.** §2c D-B4 carves in the container *encoding* and carves out
mkrootfs's CLI, manifest language, and build behaviour. A CLI flag is
squarely the carved-out half. Either the carve-out needs a narrow, explicit
extension for this one flag, or the flag must be deprecated (accepted and
ignored) rather than removed. Flagged rather than assumed — see D-K8-3.

**SD-K8-4 — the kernel CAN own this format; there is no place it cannot.**
Recording this because the opposite is the tempting conclusion. `sffs.rs`
already decodes production images exactly (K1b §1.2, re-confirmed: `Sffs<S:
BlockSource>` at `sffs.rs:236`, 15 unit tests); `klzy.rs` carries the lazy
linkage; `zip.rs` already decodes archive members; `rootfs.rs` already owns the
tree, permissions, COW, and the RXPT export. The only genuinely host-side pieces
are zstd transport, the fetch authority (URLs/seals/allow-list), and the
per-builder metadata JSON — and each has a stated, defensible reason. No part of
the *format* is host-only.

**SD-K8-5 — `sem_open` cannot be used as the shmfs acceptance oracle in its
current state.** It is the one test that exercises `MAP_SHARED` on `/dev/shm`
and it is a recorded **timeout** (`docs/libc-test-failures.md:38`). A cutover
"validated" by a suite in which the load-bearing test does not run is
unvalidated. Either fix it first or state plainly that §2.5's convergence
property is untested.

**SD-K8-6 — do not let "the tests still pass" stand in for the mmap
convergence property.** No shipped package uses `shm_open`/`sem_open` (§2.2), so
§2.5's regression would produce a **green suite**. Absence of a failing test is
not evidence of preserved behaviour when there is no test.

---

## 9. NEEDS-DEFER-DECISION

Per the standing rule I am deciding none of these.

### D-K8-1 — Does K1's unlanded step 4 belong to K1 or to K8?

- **What.** `rootfs::load_sffs_image`, the `ByteReq::Image { offset }` variant
  and its 8 `match req` sites, the raw-image provider replacing
  `createRootfsBlobProvider`, and deleting `emitRootfsManifest`'s two call sites.
- **Why now.** It determines who owns the item, and whether K8 is scheduled as
  "continue from a landed cutover" (it is not) or "land the cutover, then the
  three transfers" (it is).
- **Cost now.** K8 grows by K1's §10 K1.2–K1.6 increments. Its own parity oracle
  already exists (`kernel_rootfs_export_tree`, `wasm_api.rs:1695`), so the risk
  is bounded, but it is real Rust work with a real cutover.
- **Cost of deferring.** K8's other three transfers can each land independently
  (`/dev/shm`, the mutations, the stamp), but **V3 is not completed by any of
  them** without step 4 — the kernel still does not parse its own image.
- **Recommendation.** Fold step 4 into K8 as its first increment and rename the
  item accordingly, so that "K8 complete" and "V3 complete" mean the same thing.
  Correct the dependency table in the census (§10) and value plan (§5, §7).

### D-K8-2 — Separate `shmfs` module, or an eighth `tmpfs.rs` mount?

- **What.** `SCRATCH_MOUNTS` (`tmpfs.rs:92-101`) is a `const` table. `/dev/shm`
  could be an eighth entry, or a distinct module generalized from `tmpfs.rs`.
- **Why now.** It sets whether `/dev/shm` shares the tmpfs global lock, handle
  bands, and `statfs` magic, and whether POSIX-shm-specific behaviour
  (`sem_open`'s inode-identity dedupe, an explicit capacity limit, `SHM_*`
  semantics) has anywhere to live.
- **Cost now (separate module).** Duplication of a 1,724-line module's inode
  tree, or a refactor into a shared core — real work, and `tmpfs.rs` is a
  Phase-5 cutover asset nobody wants to destabilise.
- **Cost now (eighth mount).** Cheapest by far, but `/dev/shm` inherits
  `TMPFS_MAGIC` in `statfs` (`tmpfs.rs:915`) where Linux reports `TMPFS_MAGIC`
  too, so that is fine — the real cost is that POSIX-shm policy has no home and
  the mount table stops being "the scratch mounts".
- **Recommendation.** Start as an eighth entry with its own `st_dev`, behind the
  dormant-flag-then-cutover pattern; extract a module only if POSIX-shm-specific
  policy actually accumulates. But the naming ("SCRATCH_MOUNTS") should be fixed
  in the same change so the table stops lying about what it holds.

### D-K8-3 — The ABI ruling for stamp removal, and the D-B4 carve-out

- **What.** (a) Does removing the guest-ABI stamp require an `ABI_VERSION` bump?
  (b) Does dropping `--kernel-abi` from `tools/mkrootfs/src/cli/build.ts` breach
  the §2c D-B4 carve-out?
- **Why now.** §2c decision 3 explicitly reserved this ruling, and it gates the
  actual V3 completion.
- **Cost now (bump).** Re-instrumentation and package rebuilds — which the
  campaign says are available (value plan §1).
- **Cost of deferring.** A change that `abi.md` names as ABI surface rides an
  existing `ABI_VERSION` with the decision unrecorded — exactly what §2e's D2
  set out to stop.
- **Recommendation.** (a) Amendment inside the unreleased ABI-44 epoch, not a
  bump: §3.3 shows nothing enforced the stamp at load, so no compatibility
  promise is being broken; record it in `docs/abi-versioning.md`'s ABI 44
  section. (b) Extend the carve-out narrowly to "flags that exist only to stamp
  the container", or deprecate-and-ignore the flag instead of removing it. Both
  halves are the maintainer's call.

### D-K8-4 — What happens to `privileged-projection.ts` (864 lines, unused)?

- **What.** Zero production consumers; its only test is excluded from the CI
  default suite (`scripts/ci-run-test-suite.sh:49`).
- **Why now.** It sits inside K8's blast radius and would otherwise be ported or
  maintained by inertia.
- **Cost now (delete).** A capability with no user is withdrawn; if it encodes a
  security boundary someone intends to use, the design is lost.
- **Cost of deferring.** 864 lines of unexercised, uncovered surface travels
  through the migration.
- **Recommendation.** Do not port it in K8 either way. Get an explicit
  keep-and-cover or delete decision first — the same question §2c D-B2 asked
  about the unused typed deferred-tree schema, and it should be answered
  together with it.

### D-K8-5 — `docs/posix-status.md`'s mmap row is stale

- **What.** `:225` says in-kernel memfd returns `ENOTSUP` for `MAP_SHARED`; the
  fd-writeback bridge (`kernel-worker.ts:27082-27116`) made that false for
  kernel-owned regular files, and `:426` documents a `/dev/shm` cross-process
  property §2.5 shows would regress under a naive cutover.
- **Why now.** Documentation is platform contract. K8 changes exactly what these
  rows describe, and they are currently describing something else.
- **Cost now.** A doc edit, plus deciding what `/dev/shm`'s row should truthfully
  say after the cutover.
- **Cost of deferring.** The platform documents a capability it does not have,
  then silently loses a capability it does.
- **Recommendation.** Fix the memfd row now as a standalone truthful-failure fix
  (it is independent of K8), and rewrite the `/dev/shm` row *as part of* the
  shmfs cutover with whatever §2.6's convergence work actually delivers.

### D-K8-6 — The stale nginx-log diagnostic (§1.6)

- **What.** `readServiceLogForProcess` / `readFileFromFs`
  (`browser-kernel-worker-entry.ts:424-432`, `:4522-4540`) reads
  `/var/log/nginx.log` from a retired authority and silently yields nothing.
- **Why now.** It is the last caller of a `memfs` FS method that K8 retires, and
  leaving it would make K8 look like it removed a working diagnostic.
- **Cost now.** Repoint at `kernelWorker.rootfsReadFile` (which the same file
  already uses at `:4602`), or delete it.
- **Cost of deferring.** A diagnostic that lies by omission survives the
  migration, and the failure it was written for stays undiagnosable.
- **Recommendation.** Repoint rather than delete — it exists because someone
  needed nginx's log at failure time — but it is small enough that either is
  defensible, and it is package-shaped (`name === "nginx"`), which is worth a
  second look on its own terms.

---

## 10. Suggested increment order (dormant flag, then cut over)

Following the pattern `tmpfs.rs` proved across twelve increments, and the
batching policy in value plan §2d. Each increment is independently committable;
validation batches at the marked checkpoints.

| # | increment | gate |
|---|---|---|
| K8.0 | Baseline evidence: prove `/dev` `DeviceFileSystem` reachability (§5.3); prove today's `/dev/shm` `MAP_SHARED` cross-process convergence with a real two-process test, so §2.5's regression is measurable rather than argued | the two probes ARE the gate |
| K8.1 | `rootfs::load_sffs_image` beside `load_manifest`, driving the same four inserters, **dormant**; `ByteReq::Image { offset }` + its 8 `match req` sites | `cargo test -p runtime-core`; RXPT parity oracle (`wasm_api.rs:1695`) RTFS-tree vs SFFS-tree, byte-equal, on all nine images |
| K8.2 | Host supplies raw image bytes on both entries; `emitRootfsManifest` still live. Cut over behind the flag | parity oracle again, both hosts |
| K8.3 | Flip: delete `emitRootfsManifest`'s two call sites, `blobPaths`, `createRootfsBlobProvider`; land §4.2 (parent dirs in `rootfs.rs`) and §4.3 (TLS cert via `rootfsWriteFile`); resolve §4.1 by image rebuild | **browser** (`./run.sh browser` + the §6.2 spec set) + Node + conformance |
| K8.4 | Close the kernel-owned-file `MAP_SHARED` import direction (§2.6) | the K8.0 convergence test, now green on a kernel-owned file |
| K8.5 | shmfs: eighth mount (D-K8-2), delete the predicate + 12 guards + the `:2124-2135` probe, delete `shmSab` wiring and `platform/node.ts:72-88` | conformance shm/semaphore paths; browser + Node |
| K8.6 | Step 5: drop the JSON `entries[]`; host-only JSON keeps URLs/integrity/seals | nine-image equivalence, hard-failing (value plan §2f decision (a)) |
| K8.7 | Stamp removal + its replacement freshness signal (§3.4), pending D-K8-3 | `check-abi-version.sh`; a test that a stale image is still rejected by the *new* signal |

---

## 11. One-line summary for the campaign ledger

Phase 5 already took `/` away from `memory-fs.ts`, so K8 is not a 12,000-line
deletion: the surviving runtime read paths are exactly four — every base-file
`read()` through a name-resolving host blob provider
(`rootfs-manifest.ts:323-353`), the `/dev/shm` mount, the lazy fetch authority,
and the runtime **image writer** that `export_rootfs_image` needs on both hosts —
and the first of those is K1's step 4, which **did not land** (`sffs.rs` and
`klzy.rs` still have zero production callers). `memory-fs.ts` must survive as
that writer plus the fetch authority (≈7,600 of its 8,269 lines);
`sharedfs-vendor.ts` survives essentially whole and leaves only with the
toolchain campaign; what K8 removes is ~1,500–2,500 lines and, far more
importantly, four *authorities*. The K7 dependency is **refuted** — `shmSab` is
a single-consumer byte store, never a shared mapping, and kernel-owned files
already have a writable `MAP_SHARED` bridge (`kernel-worker.ts:27082-27116`) —
but a narrower real dependency replaces it: that bridge is **flush-only**, so a
naive `/dev/shm` cutover would silently regress the cross-process convergence
`docs/posix-status.md:426` documents, and no shipped package would fail. The ABI
stamp turns out to have **no load-time enforcement at all** (its two other
readers are dead), so removing it costs one thing only: replacing the
build-cache freshness signal in `binary-resolver.ts:2911-2926` with a
closure-derived key — and that removal *is* V3's completion.

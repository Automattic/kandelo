# Browser-backed storage for Kandelo VFS mounts (issue #974)

Status: research prototype. This note records the design space, the constraints found in the codebase, the prototype that was built, initial measurements, and a recommendation for follow-up work. The measurements below are single runs on one machine and one browser; the follow-up validation issue defines the evidence required before any behavior here is described as supported.

## Why

Every byte of a browser mount lives in a SharedArrayBuffer today. The root image and all scratch mounts resolve to `MemoryFileSystem` (host/src/vfs/default-mounts.ts), whose SharedFS layout keeps file data, metadata, and inode tables resident in one growable SAB for the life of the machine. Lazy files and deferred trees make content arrive late, but never leave: materialized bytes stay in the SAB forever, and `invalidateLazyData()` drops only the lazy record, not the data. The image ceiling (`IMAGE_MEMFS_MAX_BYTES`, 1 GiB) and the session profiles (256 to 768 MiB) are therefore hard ceilings on the useful filesystem, and a growing WordPress site (database, uploads, caches) will eventually not fit.

The goal from issue #974: mount a filesystem whose complete contents do not need to remain in memory, through the normal platform path, with accurate POSIX behavior and truthful failure modes.

## Constraints discovered in the codebase

These shape every candidate design:

1. `FileSystemBackend` (host/src/vfs/types.ts) is synchronous in every method except the optional `preparePath`. The Rust kernel calls backends from inside Wasm import callbacks; a backend cannot await.
2. Two sanctioned async escapes already exist in tree: (a) throw `EAGAIN`, after which the kernel worker parks the syscall and retries on a timer while the guest stays blocked in `Atomics.wait` (used by lazy materialization, roughly 10 ms granularity); (b) a SharedArrayBuffer channel plus `Atomics.wait` against a dedicated proxy worker that performs the async storage calls (used by `OpfsFileSystem` via `opfs-channel.ts` and `opfs-worker.ts`).
3. The VFS runs on the kernel worker; nothing may move to the main thread. OPFS sync access handles require a worker anyway.
4. Mounts are fixed at `VirtualPlatformIO` construction. The plug-in point for new mounts is the mount spec resolver (`resolveForBrowser` / `resolveForNode`), reached from the kernel worker init path. Until this work, the init protocol carried only the VFS image; no mount list crossed the worker boundary.
5. The boot descriptor layer already declared an `opfs` mount source (`web-libs/kandelo-session`: `MountSource`, `DescriptorMount.name`, `HARD_CAPS.allowedMountSources`) but nothing resolved it. The posix-status Phase D table lists the OPFS backend as an open gap with WordPress named as the consumer.
6. `OpfsFileSystem` exists, is exported, has channel unit tests and six Chromium Playwright specs, and was mounted nowhere. Its documented boundaries: no hardlinks and no symlinks (ENOTSUP), modes/ownership/timestamps accepted as no-ops, readdir inode numbers are 0, rename and unlink-while-open are supported (session-scoped identity tokens plus an orphan directory), file fsync maps to `flush()`, directory fsync is not a crash barrier, and statfs reports real origin quota via `storage.estimate()`.
7. Advisory locks and shared mmap key off exact `dev`/`ino` identity; an eviction design must never change a live file's identity.
8. One OPFS proxy per workspace per session is the supported coherence model; concurrent writers from multiple tabs on the same workspace are not.

## Design space

### A. Mount the existing OPFS backend through the normal path

Make the declared `opfs` mount source real: a boot mounts a named, origin-scoped OPFS workspace (for example at `/persist`) backed by `OpfsFileSystem`. File data lives in OPFS; kernel memory holds only the 4 MiB channel plus per-op buffers. This is the cache-size-zero point of the design space the issue sketches: every read and write crosses the channel to the proxy worker.

Pros: smallest correct step; reuses a landed, tested backend; directly bounds memory for user data; exercises the whole mount path end to end; produces real measurements that size the follow-up cache work. Cons: verified on Chromium and Firefox, with WebKit rejecting cleanly (real Safari untested); POSIX gaps (links, permissions, timestamps) are real and stay visible; every operation serializes the machine behind one storage op; throughput capped by the channel data section.

### B. Paged hybrid: SharedFS metadata plus block cache over OPFS

Keep all metadata (inodes, directories, links, modes, timestamps) in a small SharedFS SAB and page fixed-size data blocks between a bounded in-memory cache and an OPFS container (or per-chunk files), with write-back and eviction. SharedFS is already block-pointer based (4 KiB blocks, direct plus indirect), which maps naturally onto a page cache keyed by (ino, block index).

Pros: preserves full POSIX semantics including hardlinks, symlinks, modes, and stable identity across eviction (metadata never leaves memory); bounded memory with cache locality for hot data; the only shape on the table that could eventually back `/` itself. Cons: by far the largest build (dirty tracking, write-back scheduling, crash-consistency journal, recovery, quota handling); mmap of paged files needs a story (mapped pages cannot be evicted); needs its own Playwright-level durability tests. This is the long-term answer, and too large for a first prototype.

### C. IndexedDB tiers

Either a full backend (metadata and chunks in IndexedDB) or an IndexedDB metadata plane over OPFS bytes. IndexedDB works in every browser and has transactions, but every operation is async (so it needs the same proxy-worker bridge), values are copied on read and write, and transaction commit costs dominate small-file workloads. There is no IndexedDB code or test shim anywhere in the repo today. Worth measuring later as the cross-browser fallback tier where OPFS sync access handles are missing (Firefox and WebKit gaps), not worth building first.

### D. Evictable lazy base

The lazy file and deferred tree machinery already re-fetches content by URL and digest. Making clean materialized lazy bytes evictable back to stubs would bound the read-mostly base image's residency without any new storage backend, reusing verified re-fetch. It does not help writable data, and SharedFS SABs do not shrink (freed blocks are reused, not returned), so it bounds growth rather than footprint. Complementary to A and B, not a substitute.

## What the prototype implements (option A, end to end)

Host core (all through the normal platform path):

- `MountSpec.source` gains `"opfs"` with a validated `opfsName` (path-safe ASCII, no leading dot, max 64 chars). Root (`/`) cannot be an opfs mount.
- `resolveForBrowser` gains `opfsChannels` (mount path to channel SAB); an `opfs` spec entry without an initialized channel fails loudly rather than degrading to memory.
- `resolveForNode` gains `opfsWorkspaceRoot`; the Node peer of a workspace is a `HostFileSystem` over a persistent named directory, and a spec with opfs mounts fails loudly without that root rather than mapping persistence onto the ephemeral session dir.
- `OpfsProxyWorker` init accepts a workspace name and scopes the whole proxy (including the unlink-orphan directory and its sweep) to `kandelo-opfs/<name>/` under the origin root. Init errors (OPFS unavailable, bad name) now post an explicit error message instead of an unhandled rejection.
- The init protocol carries `opfsMounts` (path, name, channel SAB); the kernel worker extends the canonical spec, resolves through the shared verified resolver, and creates each mount point directory in the mount that owns its parent (`ensureMountPointDirectories`, walking the owner chain), so path walks and the parent's listing reflect the real mount table.
- `BrowserKernel.boot` / `initFromImage` accept `opfsMounts: [{ path, name }]`. The main thread owns proxy-worker lifecycle: it takes an exclusive Web Lock per workspace (`kandelo-opfs-workspace:<name>`; a second tab fails the boot loudly, satisfying the single-writer coherence boundary), completes the init/ready handshake before the kernel boots, and tears both down on destroy, including boots that fail before the kernel worker exists.

Session and demo wiring: a boot descriptor mount `{ path, source: "opfs", name }` (already allowed by the descriptor caps) now flows through `kandelo-session` into the kernel boot call.

Defect fixed along the way: `OpfsFileSystem.readdir` now copies entry-name bytes out of the shared channel before `TextDecoder.decode()` (Chrome rejects SAB-backed views; see the measurements section).

Test coverage added: resolver and validation unit tests (`host/test/vfs/opfs-mount-source.test.ts`), boot descriptor projection tests in `web-libs/kandelo-session`, a Chromium Playwright boot spec (`apps/browser-demos/test/opfs-mount-boot.spec.ts`: persistence across reboot and reload, real ENOTSUP failures, quota-truthful `df`, single-writer lock refusal, a nested workspace listed by its parent), a cross-browser spec (`opfs-mount-cross-browser.spec.ts`: Firefox persistence across kernels, WebKit rejecting the boot loudly), a backend-level readdir regression spec (`opfs-readdir.spec.ts`), an `opfsMounts` option on the test-runner page, and a lock-conflict page fixture.

## Truthful-state properties

- Persistence: workspace data is origin-scoped browser storage. It is clearable by the browser, per-profile, quota-bounded, unverified, and not shareable. Nothing presents it as a durable platform image. `statfs` on the mount reports the origin quota estimate, so `df` tells the truth about the backing store.
- POSIX gaps stay visible: `link` and `symlink` return ENOTSUP on the mount; locks work because the backend provides exact identity; fsync promises only `flush()`. These remain documented OPFS boundaries, not new silent behavior.
- Failure modes are loud: missing OPFS, a held workspace lock, malformed names, and an uninitialized channel all reject the boot with specific errors.

## Initial measurements and findings

All numbers are from one interactive run on one machine (Apple Silicon macOS, Chromium via Chrome, Vite dev server, kernel and packages built from source at the prototype revision). They are direction-setting, not benchmark evidence; the follow-up issue defines the real benchmark requirements.

- Sequential 32 MiB write to an opfs mount through `dd bs=1M`: 698 MB/s. Sequential read back: 1.3 GB/s. The same workload against a memfs scratch mount measured 995 MB/s write and 2.2 GB/s read for the portion that fit, so the zero-cache OPFS path ran at roughly 60 to 70 percent of memfs throughput for large sequential I/O.
- The memfs comparison run could not complete: `/tmp` returned ENOSPC at 15 MiB (its 16 MiB scratch SAB ceiling), while the opfs mount absorbed the full file against a roughly 10 GiB origin quota. This is the issue's premise observed directly.
- `navigator.storage.estimate()` usage grew by exactly the written 32 MiB, confirming the bytes live in origin storage rather than kernel memory. `df -k` on the mount reported the same usage against the quota estimate.
- Persistence held across kernel destroy/reboot and full page reloads (verified interactively and by the Playwright spec).
- Small-file, metadata-heavy, random-access, and concurrent workloads were not measured. The syscall benchmark suites were not run against an opfs mount; `benchmarks/suites/syscall-io` targets memfs paths and needs a variant to cover this backend.

Mounting the backend for the first time also exposed a latent defect: `OpfsFileSystem.readdir` decoded entry names with `TextDecoder.decode()` on a SharedArrayBuffer-backed view, which Chrome rejects (a boundary docs/browser-support.md already documents). Directory listings on an OPFS mount returned empty or EIO in Chromium while passing in Node-based unit tests, because Node's TextDecoder accepts SAB views and no existing browser spec drove a non-empty readdir through this path. Fixed by copying the name bytes out of the channel before decoding, matching the idiom the rest of the OPFS stack already uses. This is direct evidence for the porting-failures-are-platform-feedback rule: the mount path found a bug that unit tests structurally could not.

## Browser support boundaries

Chromium: full path (sync access handles). Firefox: the cross-browser spec passes the persistence flow. WebKit, as built for Playwright: the proxy cannot start and the boot is rejected with an explicit error, which the spec pins as the required failure mode; real Safari is untested. The cross-browser fallback tier (design C) is the identified follow-up if WebKit support matters before its OPFS gap closes.

## What was not built, deliberately

- No cache layer (design B): the prototype is the cache-size-zero baseline that the cache design should be measured against.
- No multi-tab sharing of one workspace: the Web Lock makes the single-writer boundary explicit instead.
- No IndexedDB tier (design C) and no lazy eviction (design D).
- No change to `fsync` semantics, image export, or ABI surfaces. The VFS image format is untouched; opfs mounts are boot-scoped like scratch mounts and are not part of the exported image, so no `ABI_VERSION` impact was identified (the snapshot check still needs to run in CI before any landing).

## Recommendation

Land option A first (after real validation on a machine with the full toolchain): it closes the declared descriptor seam and gives WordPress-class workloads a place to put bulk data outside the SAB today. Its measured per-op cost is exactly the motivation and the baseline for design B. Then pursue B as the real scalability answer, reusing the proxy-worker bridge and adding a bounded block cache under SharedFS metadata. Keep C as a measured fallback decision, not an assumption, and D as an independent memory win for the base image.

## Demo machines and the path to persistent-by-default

The prototype ships two gallery machines as demonstration vehicles: "Persistent shell" (guided write/reload/read cards over /persist) and "fbDOOM (persistent saves)" (the game's own $HOME-derived save directory mounted on a workspace, zero game changes). Separate tiles are a transitional shape, not the proposed end state: they duplicate gallery rows and hide the capability behind a variant users can miss.

The intended end state is persistence as a per-machine launch option, and eventually the default: a "persistent home" toggle in the launch dialog replacing the duplicate tiles, defaulting on where the backend is verified. The prerequisite is replacing the second-tab refusal with a clearly disclosed ephemeral fallback: when the workspace lock is already held, boot without the workspace and show a persistent, unmissable warning that this session is ephemeral. Refusing the boot is correct for an explicitly requested mount, but it is too hostile for a default. Silently degrading to memory is forbidden by the persistence-disclosure contract, so the loud-banner fallback is the only default-compatible design. Full persistent-by-default for everything arrives naturally with design B, when the machine image itself is browser-backed.

## Follow-up issues worth filing

1. Validate and land the opfs mount source (option A) with the full suite ladder: host Vitest, Chromium Playwright boot spec, three-browser failure-mode spec, libc/posix conformance on both hosts, syscall-io benchmarks on both hosts, docs updates (architecture.md, browser-support.md, posix-status.md Phase D).
2. Node host protocol plumbing for opfs-source mounts (the resolver peer exists; the Node kernel entry does not yet accept extra mounts from its host API).
3. Design B block-cache prototype behind the same mount source.
4. Quota and eviction UX: surface `navigator.storage.persist()` state, QuotaExceededError, and workspace management (list, delete) through kandelo-session.
5. Design D: evictable clean lazy content.
6. Launch-dialog "persistent home" toggle replacing the demo tiles, gated on the second-tab ephemeral-fallback banner described above; includes the fbdoom Backspace-quits port quirk (warn in copy now, consider patching the port).

# Phase 5: VFS Backend → Rust (implementation plan)

Part of the rust-first runtime migration
(`docs/plans/2026-08-25-rust-first-runtime-design.md`, §C "VFS backend").
Goal: move filesystem *authority* out of the TypeScript host and into the
portable Rust kernel core (`crates/runtime-core`), reducing the host's role to
raw byte-leaf providers (`fetch`, OPFS, Node `fs`, IndexedDB/Cache Storage).

## Ground truth (investigated 2026-08-28, worktree kandelo-epoll, ABI 43)

Path/namespace authority is **already in Rust**. `runtime-core/src/syscalls.rs`
owns per-component path resolution (`resolve_namespace_path_from`, symlink
walking with `ELOOP`, `..`/mount crossing, per-component access checks) and all
synthetic namespaces (procfs `match_procfs`, devfs `match_devfs_stat`, virtual
devices, pty, `/dev/fd`, fifo, and read-only synthetic regulars like
`/etc/mtab`). The single metadata funnel is `namespace_lstat_raw`
(syscalls.rs:2075): it checks every synthetic namespace, then falls through to
`host.host_lstat(path)` for "real" files.

The TypeScript VFS is therefore only a **flat, canonical-path backing store**:
given an already-resolved absolute path it does lstat/open/read/write/readdir.
`FileSystemBackend` (host/src/vfs/types.ts:67) says as much: "paths are
mount-relative, already resolved." ~21,700 TS lines total across host/src/vfs/*;
~17.5k is pure data-structure logic portable to Rust (in-memory tree, tar, zip,
VFS-image + zstd header parse, lazy-tree descriptors, materialization recipes,
seal verification, overlay merge, hardlink graph); ~4.1k is genuine host I/O
that STAYS host-side as byte leaves (browser `fetch`+CORS, OPFS sync-access,
Node `fs`).

An existing working pattern to generalize: **negative host-handle convention**.
`descriptor_backing.rs` serves some regular files (e.g. `/etc/mtab`) wholly from
Rust memory. `host_handle >= 0` = a real host handle; `host_handle <=
-SYNTHETIC_REGULAR_HANDLE_BASE (1e9)` = a Rust-owned in-memory backing. A Rust
tmpfs is a generalization of this, not a greenfield subsystem.

## Architecture decision

**A runtime-core FS choke layer, not a WasmHostIO change.** `WasmHostIO` is a
zero-sized unit struct constructed inline in ~30 places in the kernel crate and
is the *host-adapter* layer; putting FS authority there would keep it out of the
portable core and off the native host. Instead, introduce a small
`runtime-core::vfs` module with helper fns (`fs_open`, `fs_lstat`, `fs_stat`,
`fs_mkdir`, `fs_unlink`, `fs_rename`, `fs_symlink`, `fs_readlink`, `fs_opendir`,
`fs_readdir`, `fs_chmod`, `fs_truncate`, `fs_statfs`, …) that:

1. consult a global Rust-owned mount table for the requested canonical path, and
2. serve it from an in-Rust store when the prefix is Rust-owned, else delegate
   to `host.host_*`.

The ~40 scattered `host.host_*` FS call sites in syscalls.rs migrate to these
helpers. Open files in a Rust-owned mount get a handle in a new reserved
negative range (`TMPFS_HANDLE_BASE`), and the handle-based ops (read/write/seek/
fstat/close/ftruncate/readdir) route by handle range, mirroring
`is_synthetic_regular_handle`. The store itself follows the existing
`GlobalBackingTable` UnsafeCell+spinlock pattern used by eventfd/timerfd/pipes.

Both browser and Node use `kernel.wasm` → they get this identically (host-parity
preserved by construction). The native reference host (separate branch) picks up
the same runtime-core module for free.

## Increment breakdown

- **1a (first slice): Rust tmpfs for the scratch mounts, core ops.** The mount
  layout (host/src/vfs/default-mounts.ts:48-83) already splits `/`
  (source:"image") from empty `scratch` tmpfs mounts: `/tmp`, `/var/tmp`,
  `/var/log`, `/var/run`, `/home/maker`, `/root`, `/srv`. Scratch mounts start
  empty → **zero parser migration**. Implement the choke layer + an in-Rust
  inode tree (regular files + dirs) supporting open/creat/read/write/lseek/
  fstat/lstat/stat/mkdir/rmdir/unlink/opendir/readdir. Validate with a guest that
  exercises them under `/tmp`. Host keeps serving `/` and all other mounts.
- **1b: symlinks.** symlink/readlink in tmpfs + cross-mount symlink resolution
  through `namespace_readlink_raw`/`resolve_namespace_path_from`.
- **1c: rename/link/metadata + `st_dev`/EXDEV/statfs/nosuid.** Assign each Rust
  mount its own `st_dev`; reproduce EXDEV on cross-authority rename/link; match
  per-mount `statfs` flags (scratch mounts are `nosuid`, default-mounts.ts:55).
- **1d: cut over all scratch mounts; delete the host-side scratch
  `MemoryFileSystem` mounts** from default-mounts.ts / default-mounts-node.ts so
  those prefixes never call `host_*`. Validate WordPress Chromium boot (it writes
  `/tmp`, `/var/run`, `/run`, sessions) + host Vitest + native cargo test.
- **Increment 2 (later): image-backed rootfs → Rust tree** fed by a host manifest
  + `blob_read`/`blob_stat` byte-leaves; host stops owning the rootfs tree.
- **Increment 3+ (later): parser migration** (tar/zip/VFS-image/zstd-header/
  lazy-tree/seal) into runtime-core, and the `WAKE_BLOB_READY` async-completion
  path for blocking opens on unmaterialized lazy nodes (new op class in
  `blocked_retry.rs` + new wake type in `wakeup_event_wire`).

## Biggest correctness risks (increment 1)

1. **Split-authority mount seam.** After 1a the namespace is hybrid: Rust owns
   `/tmp` etc., TS owns `/`. `..` and symlinks that cross the boundary must still
   resolve — the tmpfs must slot into `namespace_lstat_raw`/`namespace_readlink_raw`
   at exactly the mount-prefix decision so a `/tmp` symlink into `/usr` (and back)
   works. Wrong prefix check → shadow or leak.
2. **`st_dev` identity + EXDEV.** TS `VirtualPlatformIO.qualifyStat` assigns
   distinct `st_dev` per backend and raises EXDEV on cross-backend link/rename.
   Rust must match, or `rename(2)`/hardlink/`st_dev`-based identity break.
3. **`statfs`/`ST_NOSUID` parity** for scratch mounts.
4. **Node/browser parity** — both hosts drop the scratch backend identically.

## As-built wiring (increments 1a + 1b)

**Dormant by default.** A master flag (`crate::tmpfs::set_enabled`, default
off) gates all path-op interception via `claims_path` (= enabled AND
scratch-prefix). So the whole tmpfs stays inert on real hosts and in the
existing test corpus — which uses `/tmp`, `/root`, `/home/maker`, etc. as
ordinary mock-host paths — until the cutover increment enables it at boot and
removes the host-side scratch mounts. Unconditional interception broke ~114
existing unit tests that assumed host-served scratch paths; gating restores them
and matches the "no behavior change until cutover" principle. `owns_path` stays
a pure prefix predicate (used by unit tests); the syscall dispatch gates on
`claims_path`; handle-op arms need no flag (a tmpfs handle only exists when
enabled). The Phase 5 wiring test flips the flag on (via an RAII guard).

The interception lives in the **runtime-core syscall path** (not the `WasmHostIO`
adapter) so it is unit-testable with a recording mock host — the mock-host test
is the completeness guarantee: any missed interception site surfaces as a
scratch-path host FS op. Shape:

- **Path metadata:** `namespace_lstat_raw` gets a tmpfs arm; `fs_stat`/`fs_lstat`
  helpers replace the ~23 direct `host.host_stat`/`host_lstat` call sites (used
  by `stat`/`lstat`/`fstatat`/existence checks) so path stat is consistent.
- **open:** `open_scratch_tmpfs` helper, called from both `sys_open` and
  `sys_openat`, builds a `FileType::Regular` OFD with a tmpfs handle and
  `FileId::Host{tmpfs dev,ino}` (gives locks a stable identity for free).
- **Handle I/O:** targeted tmpfs arms in `sys_read`/`sys_pread`/`sys_write`/
  `sys_pwrite`/`sys_lseek`/`sys_fstat` (tmpfs files are `FileType::Regular`, so
  read/write fall into the ordinary arm; the cursor stays Rust-owned in
  `OpenFileDesc::offset`).
- **Lifecycle:** four `descriptor_backing` arms (`manages_ofd`,
  `is_live_managed_ofd`, `add_ref_for_ofd`, `release_for_ofd`) mirror the
  synthetic-regular pattern, so fork/dup/exec/close refcount `open_count`
  correctly (unlink-while-open works); the `sys_close` dispatch routes tmpfs
  handles to `release_for_ofd` instead of `host_close`.
- **Directory path ops:** `sys_mkdir`/`sys_mkdirat`, `sys_rmdir`, `sys_unlink`
  get early tmpfs arms.
- **Handle ranges (disjoint):** procfs `(-200, -1e9]`, synthetic regular
  `(-2e9, -1e9]` (now upper-and-lower bounded), tmpfs file `(-3e9, -2e9]`, tmpfs
  dir `<= -3e9`. The prior unbounded synthetic range would have shadowed tmpfs
  handles in the synthetic dispatch arms.

**Directory OFDs (done):** a tmpfs directory opens as a
`FileType::Directory` OFD carrying a dedicated sentinel handle
(`TMPFS_DIR_SENTINEL = -170`, disjoint from procfs -150 / devfs -160), mirroring
`devfs_open_dir`. `sys_getdents64` gains a tmpfs branch that regenerates entries
from the live store via `tmpfs::getdents64` → `procfs::write_virtual_dirents64`
(which injects `.`/`..` and honors the cookie/short-buffer protocol). The
sentinel is added to the four other directory special-case sites: the lseek
kernel-generated-directory branch (seekdir/rewinddir), `sys_fstat` (returns the
tmpfs dir stat), the close "nothing to clean up" branch, and the negative-handle
directory-backing validity check. `ftruncate`/`truncate`/`fallocate` also done
(increment 1c).

**Symlinks (done):** `InodeKind::Symlink` holds the target bytes;
`tmpfs::symlink`/`readlink` plus arms in `sys_symlink`/`sys_symlinkat`,
`sys_readlink`/`sys_readlinkat`, and — critically — `namespace_readlink_raw`, so
the kernel path resolver follows tmpfs symlinks (including relative targets that
resolve back into the same mount). lstat reports `S_IFLNK`; getdents reports
`DT_LNK`.

**chmod/chown (done):** `tmpfs::chmod`/`chown`/`fchmod`/`fchown` update inode
mode/uid/gid; arms in `sys_chmod`/`sys_fchmodat`/`sys_fchmod`, `sys_chown`/
`sys_lchown`/`sys_fchownat`/`sys_fchown`. The existing permission checks
(`check_owner_or_root`, `prepare_chown_ids`) run against the tmpfs stat, so
`_POSIX_CHOWN_RESTRICTED` and owner checks are enforced; the fd-based paths
handle both the tmpfs file handle and the directory sentinel. (Note: open still
does not *enforce* mode bits on access — that per-inode enforcement is a separate
deferred item; chmod correctly stores and reports them.)

**Still deferred before the real-host cutover:**
`rename`/`link`/`access`/`utimensat`/`statfs` on tmpfs; AF_UNIX
socket and FIFO names created under a scratch prefix
(still host-backed → would split-brain); per-inode permission enforcement
against the caller's credentials; `st_dev`-based EXDEV on cross-authority
rename/link. Until the full set lands, running a real host against a
partially-wired tree is inconsistent — browser/Node validation is gated on the
cutover, and nothing merges until the migration is complete.

## Validation contract per increment

host Vitest (`host/test`) + a guest exercise + (from 1d) WordPress Chromium boot
via `WASM_POSIX_RESOLUTION_POLICY=source-only-v1
WASM_POSIX_SOURCE_ONLY_BINARY_ROOT=<repo>/local-binaries/source-only-v1`, plus
native `cargo test -p kandelo-runtime-core`. No "VFS works" claim without the
evidence for that exact claim.

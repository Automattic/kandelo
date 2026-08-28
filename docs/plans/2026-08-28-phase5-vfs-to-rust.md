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

## Validation contract per increment

host Vitest (`host/test`) + a guest exercise + (from 1d) WordPress Chromium boot
via `WASM_POSIX_RESOLUTION_POLICY=source-only-v1
WASM_POSIX_SOURCE_ONLY_BINARY_ROOT=<repo>/local-binaries/source-only-v1`, plus
native `cargo test -p kandelo-runtime-core`. No "VFS works" claim without the
evidence for that exact claim.

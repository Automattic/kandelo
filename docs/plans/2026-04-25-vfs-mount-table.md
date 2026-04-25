# Mount-Table VFS — Design

> **Context:** This supersedes Phase 3.2–3.9 of
> [`docs/plans/2026-04-23-vfs-as-source-of-truth.md`](2026-04-23-vfs-as-source-of-truth.md).
> The original plan's `OverlayPlatformIO` design let host paths fall
> through implicitly ("the kernel's `/` is also macOS's `/`"), which
> made the abstraction leaky — tests that wrote files via Node `fs` and
> handed paths to the kernel were relying on that leak. This design
> replaces implicit fall-through with explicit mounts.

## Principle

**The VFS is the only lens through which the kernel and tests interact
with filesystems.** Nothing falls through. If a path isn't mounted, it
doesn't exist (→ `ENOENT`).

## Mount table

A list of `{ path: string, backend: Backend }` entries. A single-lookup
resolver maps any VFS path to `(backend, mountPath, subPath)` via
longest-prefix match.

```
Mounts: { "/etc": memfs_etc, "/tmp": host_tmp, "/home/user": host_home }

resolve("/etc/passwd")        → (memfs_etc,  "/etc",        "/passwd")
resolve("/tmp/foo")           → (host_tmp,   "/tmp",        "/foo")
resolve("/home/user/notes")   → (host_home,  "/home/user",  "/notes")
resolve("/usr/bin/vim")       → null → ENOENT
resolve("/etcetera")          → null (prefix-only match is not ownership)
```

Edge cases:

- Path exactly equals a mount point (`resolve("/etc")`) → `(backend, "/etc", "/")`. The backend must handle stat'ing its own root.
- Prefix match requires `path === mount || path.startsWith(mount + "/")`. `path.startsWith(mount)` alone would falsely match `/etcetera` under `/etc`.
- Root mount (`{ path: "/", backend: X }`) is supported but strongly discouraged. It silently owns everything not claimed by a more specific mount, reintroducing the implicit-fallthrough problem. The mount spec should use specific prefixes.
- Trailing slashes on mount declarations are normalized away (`/etc/` → `/etc`).

Resolution is O(mounts) linear scan. Mount counts are small (<20); this is fine.

## Backends

Every backend implements a subset of `PlatformIO` containing only FS ops:

```typescript
interface Backend {
  // Handle-based
  open(subPath: string, flags: number, mode: number): number;
  close(handle: number): number;
  read(handle: number, buf: Uint8Array, offset: number | null, length: number): number;
  write(handle: number, buf: Uint8Array, offset: number | null, length: number): number;
  seek(handle: number, offset: number, whence: number): number;
  fstat(handle: number): StatResult;
  ftruncate(handle: number, length: number): void;
  fsync(handle: number): void;
  fchmod(handle: number, mode: number): void;
  fchown(handle: number, uid: number, gid: number): void;

  // Path-based (paths are sub-mount, i.e. already stripped of the mount prefix)
  stat(subPath: string): StatResult;
  lstat(subPath: string): StatResult;
  mkdir(subPath: string, mode: number): void;
  rmdir(subPath: string): void;
  unlink(subPath: string): void;
  rename(oldSubPath: string, newSubPath: string): void;
  link(existingSubPath: string, newSubPath: string): void;
  symlink(target: string, subPath: string): void;
  readlink(subPath: string): string;
  chmod(subPath: string, mode: number): void;
  chown(subPath: string, uid: number, gid: number): void;
  access(subPath: string, mode: number): void;
  utimensat(subPath: string, atimeSec: number, atimeNsec: number, mtimeSec: number, mtimeNsec: number): void;

  // Directory iteration
  opendir(subPath: string): number;
  readdir(handle: number): { name: string; type: number; ino: number } | null;
  closedir(handle: number): void;
}
```

**Important:** paths handed to backends are *sub-mount paths*. A file at VFS `/etc/passwd` under a mount at `/etc` arrives at the backend as `/passwd`. Backends don't know their mount point; the router owns the translation.

### Backend flavors for v1

| Backend | Use | Environment | Notes |
|---|---|---|---|
| `MemFsBackend` | Image-backed and in-memory scratch | Node + Browser | Wraps a `MemoryFileSystem`. |
| `HostDirBackend` | Host-backed scratch | Node only | Wraps a host directory with prefix rewriting. |

Kernel synthetic paths (`/proc`, `/dev`, PTY) stay in the kernel and are intercepted **before** reaching the mount table. They never hit a backend.

## Handle namespace

Each backend gets its own handle range, encoded by tagging the high bits of every handle it returns. The router uses the tag to dispatch. Scheme:

```
Bits 31..28: backend index (0-15)
Bits 27..0:  backend-local handle value
```

Router maintains a stable list of backends. `open()` returns `(backendIdx << 28) | subHandle`. `read()/write()/close()` etc. strip the tag and dispatch.

This avoids a `Map<handle, backend>` lookup per syscall (hot path). 15 backends is plenty.

## Path normalization

VFS paths are absolute, already normalized (no `.` or `..` segments, no doubled slashes). The kernel's path resolver does this before calling into the host, so the mount router assumes normalized input.

**Anti-escape:** `HostDirBackend` still validates sub-paths for `..` traversal at backend entry, as defense in depth. A sub-path that escapes the mount is rejected with `EACCES`. This matters because backend-internal code uses `path.join(hostRoot, subPath)` — without the check, `subPath = "/../etc/passwd"` could escape.

## uid/gid policy

Each backend owns uid/gid translation for its own files:

- `MemFsBackend`: returns honest uid/gid from the memfs inode (from the image).
- `HostDirBackend`: returns `uid=1000, gid=1000` unconditionally. Matches `Process::new`'s default euid. Programs running inside the kernel with euid=1000 see their own files as self-owned; tools with ownership checks (git's "dubious ownership" etc.) are satisfied. The real macOS uid of the user running the kernel is never exposed.

This replaces the `NodePlatformIO.DEFAULT_HOST_UID = 1000` hack that layered the override on top of a catch-all backend. Now it's the backend's own concern, which is where it semantically belongs.

## Non-FS operations

`clockGettime`, `nanosleep`, network, `waitpid`, futex, etc. are *not* FS operations and bypass the mount table entirely. They live on a separate `HostServices` object held by the kernel worker.

`MountRouter implements PlatformIO` by routing FS ops through the mount table and delegating non-FS ops to the `HostServices` reference.

## Mount spec (unified across Node + Browser)

A declarative spec shared by all environments; environments differ only in how they resolve each mount's backend.

```typescript
// host/src/vfs/default-mounts.ts
export interface MountSpec {
  path: string;          // VFS mount point (e.g., "/etc")
  source: "image" | "scratch";
  readonly?: boolean;    // backend should enforce read-only (future Phase 5 concern)
  ephemeral?: boolean;   // scratch dir wiped on kernel destroy
}

export const DEFAULT_MOUNT_SPEC: MountSpec[] = [
  { path: "/etc",       source: "image",   readonly: true  },
  { path: "/tmp",       source: "scratch", ephemeral: true },
  { path: "/var/tmp",   source: "scratch" },
  { path: "/home/user", source: "scratch" },
  { path: "/var/log",   source: "scratch" },
  { path: "/var/run",   source: "scratch", ephemeral: true },
  { path: "/root",      source: "scratch" },
  { path: "/srv",       source: "scratch" },
];
```

Per-environment resolvers:

```typescript
// Node
function resolveForNode(
  spec: MountSpec,
  rootfsImage: Uint8Array,
  sessionDir: string,
): Backend {
  switch (spec.source) {
    case "image":   return MemFsBackend.fromImageSubtree(rootfsImage, spec.path);
    case "scratch": return new HostDirBackend(join(sessionDir, spec.path));
  }
}

// Browser
function resolveForBrowser(
  spec: MountSpec,
  rootfsImage: Uint8Array,
): Backend {
  switch (spec.source) {
    case "image":   return MemFsBackend.fromImageSubtree(rootfsImage, spec.path);
    case "scratch": return MemFsBackend.empty(1 * 1024 * 1024);
  }
}
```

Tests and consumers can override the spec selectively (e.g., point `/tmp` at a specific host dir for file-handoff tests) by cloning and mutating `DEFAULT_MOUNT_SPEC` before passing it in.

## Session scratch dir (Node)

On `NodeKernelHost.init`, create `$TMPDIR/wasm-kernel-session-<pid>/` and populate subdirs for every `scratch`-sourced mount. On `destroy`, `rm -rf` the session dir.

Ephemeral mounts (`/tmp`, `/var/run`) are marked; once Phase 5 permission enforcement lands, these could get an `rm -rf` + recreate on every process boot to match real Linux `/tmp` semantics. Not in scope for this PR.

## Failure modes

| Situation | Result |
|---|---|
| `open("/etcetera")` | `ENOENT` (no mount covers this) |
| `open("/tmp/../etc/passwd")` | depends on kernel path resolver; if it resolves to `/etc/passwd` (mount crosses), allowed; if it stays as `/tmp/../etc/passwd` because kernel doesn't normalize, `HostDirBackend` rejects with `EACCES` |
| `rename("/etc/passwd", "/tmp/passwd")` | `EXDEV` (cross-backend rename) |
| `link("/etc/passwd", "/tmp/passwd")` | `EXDEV` |
| Backend throws uncaught exception | MountRouter converts to `EIO` and returns a negative errno from the PlatformIO call |

## Migration of bridging tests

Tests that previously wrote files via Node `fs` and handed paths to the kernel:

- **`host/test/dlopen-e2e.test.ts`**: `BUILD_DIR` is currently `os.tmpdir() + "/wasm-dlopen-e2e"`. The kernel won't see this path. Fix: before spawning the kernel, set up a mount `/opt/dlopen-build → BUILD_DIR` (HostDirBackend). Hand the kernel `/opt/dlopen-build/libmath.so`.
- **`host/test/git.test.ts`**: Uses `/tmp/git-commit-test-...` paths passed directly to git. Since `/tmp` is already mounted as a scratch `HostDirBackend`, the path needs to resolve against that mount's host-side directory. Fix: the test writes to the mount's host root (accessible via the `centralized-test-helper` API that surfaces the session scratch dir), and hands git the VFS path `/tmp/...`.

Both cases: the centralized-test-helper grows a `getMountHostPath(vfsPath) → hostPath` helper so tests can write files that the kernel will see.

## What stays the same

- `MemoryFileSystem` API (unchanged).
- `rootfs.vfs` image format (unchanged).
- `mkrootfs` tool (unchanged).
- Kernel `sys_open`, `sys_stat`, etc. (unchanged signatures; they still call `host.host_open` extern as today).
- The host-side binding `hostOpen(pathPtr, pathLen, flags, mode)` in `kernel.ts` (unchanged; it calls `io.open(path)` where `io` is now a `MountRouter` instead of `NodePlatformIO`).

## What goes away

- `NodePlatformIO`'s FS methods (`open`, `read`, `stat`, etc.) — migrated to `HostDirBackend`. Non-FS methods live on in `HostServices`.
- `OverlayPlatformIO` (already rolled back in `prairie-headlight`).
- `synthetic_file_content()` and `SYNTHETIC_FILE_HANDLE` in `crates/kernel/src/syscalls.rs` plus ~20 call sites.
- The `NodePlatformIO.DEFAULT_HOST_UID` hack pattern that would've been needed.

## Test plan

1. Unit: `MountTable.resolve()` — longest-prefix, exact-match, prefix-only-miss, no-mount-miss, root-mount.
2. Unit: `MemFsBackend` — round-trip stat/read/write through sub-mount translation.
3. Unit: `HostDirBackend` — prefix rewrite, anti-escape rejection, uid/gid=1000 regardless of host.
4. Unit: `MountRouter` — handle namespace tagging, dispatch correctness, cross-backend rename fails.
5. Integration: rootfs image → MemFsBackend mount at `/etc` → kernel stat/read of `/etc/passwd`.
6. Integration: HostDirBackend at `/tmp` → kernel writes file → test reads via mount's host path → bytes match.
7. Regression: all 5 suites (cargo, vitest, libc-test, POSIX, sortix) + ABI snapshot check.

## Out of scope (future Phase 4/5 concerns)

- `readonly` enforcement on mounts.
- Overlay/union mounts (multiple backends at the same prefix).
- Mount permissions (uid/gid-gated access to the mount itself).
- Dynamic mount/unmount from user space.
- Persistent scratch across runs (would use OPFS in browser, snapshot file on Node).

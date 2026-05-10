# VFS Mount Cutover — Investigation Notes (PR 4/5)

**Date:** 2026-05-09  
**Investigator:** Task 4.1 deep audit  
**Goal:** Confirm the existing `VirtualPlatformIO` + `MountConfig` infrastructure is suitable as the foundation for PR 4/5, which will mount `rootfs.vfs` into a `MountConfig` slot and remove synthetic `/etc/passwd` fallbacks.

---

## 1. VirtualPlatformIO Mount Lookup Mechanism

**File:** `host/src/vfs/vfs.ts:44–59`

The `resolve(path: string)` method:

1. **Algorithm:** Linear scan with longest-prefix matching (by design).
2. **Prefix matching:** Mounts are **pre-sorted by prefix length (longest first)** in the constructor:
   ```typescript
   .sort((a, b) => b.prefix.length - a.prefix.length)
   ```
3. **Match logic:** For each mount:
   - If mount prefix is `/`, match immediately and return the full path as `relativePath` (line 49–50).
   - Otherwise, match if path equals the prefix exactly OR starts with `prefix + "/"` (line 52).
4. **Trailing slash handling:** Mount points are normalized in `normalizeMountPoint()` — all trailing slashes stripped except the root `/` (line 14–20).
5. **Path stripping:** When a match is found, the mount prefix is removed from the path:
   ```typescript
   let rel = path.slice(m.prefix.length);
   if (!rel.startsWith("/")) rel = "/" + rel;
   ```
   This ensures paths sent to backends are always relative to their mount point and start with `/`.
6. **Root mount behavior:** The `/` mount is the catch-all; if it exists, it is guaranteed to match every path (because mounts are sorted longest-first and `/` is last).

**Conclusion:** Longest-prefix matching with pre-sorted mounts is correct and efficient (linear time, but prefixes are typically short). No path normalization (`.`/`..` resolution) is done by the VFS router itself — paths are passed as-is to backends.

---

## 2. Unmounted Path Semantics

**File:** `host/src/vfs/vfs.ts:44–59`

The `resolve()` method throws `ENOENT` if no mount matches:
```typescript
throw new Error(`ENOENT: no mount for path: ${path}`);
```

**No fallback mechanism exists.** The architecture enforces: **"VFS is the only lens; nothing falls through."**

This design choice has important consequences:
- If there is no `/` mount, even `/tmp` or `/home` is unmounted and returns `ENOENT`.
- All backends must be explicitly configured in the mounts array passed to the constructor.
- `VirtualPlatformIO` requires at least one mount (line 39–41):
  ```typescript
  if (this.mounts.length === 0) {
    throw new Error("VirtualPlatformIO requires at least one mount");
  }
  ```

**Current semantics:** Unmounted paths fail with hard error, not silently falling through to a default backend. This is the desired end-state and is already enforced.

---

## 3. Sub-Mount Path Translation

**File:** `host/src/vfs/vfs.ts:52–55`

When a path like `/etc/passwd` resolves to a backend mounted at `/etc`:

1. The VFS strips the mount prefix: `"/etc/passwd".slice(4)` → `"passwd"`
2. It prepends `/` if needed: `rel.startsWith("/")` check (line 54) ensures the backend always sees `/passwd`
3. The backend receives the mount-relative path: `/passwd`

**Examples:**
- Path `/etc/passwd` with mount `/etc` → backend sees `/passwd`
- Path `/tmp/file` with mount `/` → backend sees `/tmp/file`
- Path `/etc` with mount `/etc` → backend sees `/`

Backends are responsible for their own path normalization (`.` and `..` handling) if needed. The VFS router does not normalize paths — it only strips the mount prefix and ensures a leading `/`.

---

## 4. Default/Root Mount on Current Main

**Files:**
- Browser: `examples/browser/lib/kernel-worker-entry.ts:189–194`
- Node (current main): Not found — `run-example.ts` and `NodeKernelHost` do NOT explicitly set up mounts.

**Browser kernelOwnedFs setup (line 189–194):**
```typescript
const mounts: Array<{ mountPoint: string; backend: any }> = [
  { mountPoint: "/dev/shm", backend: shmfs },
  { mountPoint: "/dev", backend: devfs },
  { mountPoint: "/", backend: memfs },
];
io = new VirtualPlatformIO(mounts, new BrowserTimeProvider());
```

The browser kernel-owned mode explicitly:
- Mounts `/dev/shm` (shared memory FS) — **ephemeral, per-session**
- Mounts `/dev` (device FS) — static kernel devices
- Mounts `/` (memory FS from the vfsImage) — **the main rootfs**

**Node host (main branch):**

`NodeKernelHost` (lines 325–346 in `run-example.ts`) does NOT set up any mounts. It appears the Node host is currently NOT using `VirtualPlatformIO` — instead using the deprecated `NodePlatformIO` directly. This is confirmed by the grep results:
- `examples/run-example.ts` does NOT construct mounts
- `host/test/centralized-test-helper.ts:213` defaults to `new NodePlatformIO()` when `options.io` is not provided

**Current state:** The Node host has NO default mount setup on main. It relies on direct host filesystem access via `NodePlatformIO`, **not a virtual mount table.** This is the key gap that PR 4 must address.

**Browser legacy (non-kernelOwnedFs) mode:**

When `kernelOwnedFs: false` (the existing demos), the browser still uses `VirtualPlatformIO` but constructs it from a shared MemoryFileSystem + /dev. The setup is in the worker, but the main thread has no awareness of mounts — it populates files directly into `kernel.fs` (the MemoryFileSystem SAB).

---

## 5. Cross-Backend Operations

**Files:**
- `host/src/vfs/vfs.ts:61–71` (resolveTwoPaths)

When operations span two paths (e.g., `rename`, `link`), the VFS calls `resolveTwoPaths()`:
```typescript
const { backend, rel1, rel2 } = this.resolveTwoPaths(oldPath, newPath);
if (r1.backend !== r2.backend) {
  throw new Error("EXDEV: cross-device link");
}
```

**Behavior:**
- If both paths resolve to the **same backend instance**, the operation proceeds with both relative paths.
- If the backends differ (different mount points), it returns `EXDEV` — cross-device link error.

**Examples:**
- `rename("/etc/passwd", "/etc/shadow")` (same mount `/etc`) → succeeds within that backend
- `rename("/etc/passwd", "/tmp/backup")` (different mounts `/etc` and `/` or `/tmp`) → `EXDEV`
- `link("/usr/bin/bash", "/bin/sh")` (different mounts) → `EXDEV`

**Cross-mount moves are NOT supported.** This is a deliberate design choice that keeps the VFS simple but **requires all related files to live on the same backend** (e.g., all system config in `/etc` mounted to the same backend as `/etc/shadow`).

**Handle namespace:** Each backend maintains its own file handle space (fd, dir handle). The VFS router translates global handles to backend-local handles via a `Map<globalHandle, { backend, localHandle }>` (lines 25–26, 73–83). Backends never see global handles — they are isolated.

---

## 6. Browser vs Node Host VFS Setup

### Browser (kernel-owned mode)

**File:** `examples/browser/lib/kernel-worker-entry.ts:170–206`

In `kernelOwnedFs: true` mode:
1. Main thread does NOT allocate `fsSab` or `memfs` (line 147–150 in `browser-kernel.ts`).
2. Demo calls `kernel.boot(vfsImage: Uint8Array)`, passing pre-built VFS image bytes.
3. Worker loads the image into a `MemoryFileSystem`:
   ```typescript
   memfs = MemoryFileSystem.fromImage(msg.vfsImage, { maxByteLength: 1 * 1024 * 1024 * 1024 });
   ```
4. Worker sets up the mount table (lines 189–194):
   - `/dev/shm` → shared memory FS (for POSIX semaphores, message queues)
   - `/dev` → DeviceFileSystem (kernel devices: null, zero, urandom, tty, pts, etc.)
   - `/` → MemoryFileSystem (from the vfsImage)
5. Worker constructs `VirtualPlatformIO` with these mounts.

**Key insight:** The browser's `kernelOwnedFs` mode is ALREADY the target architecture. It demonstrates how a vfsImage should be mounted and used. **PR 4 must adopt this pattern for the Node host.**

**Browser (legacy mode, kernelOwnedFs: false):**

The main thread allocates a SAB and creates a MemoryFileSystem. The demo populates files directly via `kernel.fs.open()` / `.write()`. The worker doesn't construct mounts explicitly — instead, it uses the pre-existing SAB. This path is **deprecated** per the design (line 48–54 in `browser-kernel.ts` deprecation note).

### Node host (current main)

**File:** `host/src/node-kernel-host.ts:75–114`

The Node host does NOT handle VFS at all. It spawns a worker thread and communicates via messages. The worker (`node-kernel-worker-entry.ts`) constructs the kernel and processes syscalls. **The worker's `PlatformIO` is NOT set up in the init message.** Instead, the kernel worker gets a hard-coded `NodePlatformIO()` directly.

Grep shows: `host/test/centralized-test-helper.ts:213` defaults to `new NodePlatformIO()` when options.io is undefined. This implies the kernel worker defaults to unvirtualized host FS access.

**Current state:** Node host is NOT using `VirtualPlatformIO`. It needs to:
1. Detect or receive a path to `rootfs.vfs` (or load it from a known location).
2. Load it into a `MemoryFileSystem`.
3. Construct a `MountConfig[]` array (similar to browser's kernel-worker-entry.ts:189–194).
4. Pass the mounts to the kernel worker so it constructs `VirtualPlatformIO`.

---

## 7. NodePlatformIO Direct Callers (Migration Debt)

**Grep results:** 21 locations still use `new NodePlatformIO()` directly:

**Demos/examples (6):**
1. `examples/run-hello.ts:32`
2. `examples/nginx-test/nginx-wrapper.ts:173`
3. `examples/wordpress/test/wordpress-server.test.ts:74`
4. `examples/mariadb-test/run-tests.ts:190`
5. `examples/libs/openssl/test/ssl-basic.test.ts:39`
6. `examples/cpython/debug-test.ts:37`

**Tests (15):**
1. `host/test/nginx.test.ts:92`
2. `host/test/node-platform-io-uid-gid.test.ts:30, 37, 44, 56` (4 locations)
3. `host/test/centralized-test-helper.ts:213` (default when options.io is undefined)
4. `host/test/kernel.test.ts:13`
5. `host/test/getaddrinfo.test.ts:13`
6. `host/test/multi-worker.test.ts:35, 58, 72, 88` (4 locations)
7. `host/test/git.test.ts:167`
8. `host/test/framebuffer-integration.test.ts:56`

**All are bypassing the mount router.** These depend on implicit fall-through to the host filesystem. Per the design, they need to:
- Load/create a rootfs image.
- Set up explicit mounts (at minimum, a `/` mount to the image or host).
- Construct `VirtualPlatformIO` with those mounts.

---

## 8. synthetic_file_content Call Sites

**File:** `crates/kernel/src/syscalls.rs`

The `synthetic_file_content(path: &[u8]) -> Option<&'static [u8]>` function (lines 120–144) hardcodes static content for three files:
- `/etc/passwd` — POSIX user database (root, daemon, nobody, www-data, redis, mysql, user)
- `/etc/group` — POSIX group database (same accounts)
- `/etc/hosts` — localhost mappings

**Call sites (10 unique functions, 14 total references):**

| Function | Lines | Purpose |
|----------|-------|---------|
| `open()` | 403, 409 | Check if path is synthetic; return SYNTHETIC_FILE_HANDLE instead of opening via backend |
| `fstat()` | 631, 1064 | Return synthetic stat for open synthetic files |
| `fstat()` (continued) | 1066 | Return hardcoded size (0) for synthetic files |
| `lseek()` / `fseek()` | 1524–1525 | Return hardcoded size for synthetic files |
| `ftruncate()` | 2108–2109 | Return size of synthetic file content |
| `statx()` | 2451 | Check if path is synthetic; skip backend stat() |
| `readlink()` | 2501 | Check if path is synthetic (all return ENOENT) |
| `access()` | 2624 | Check if path is synthetic (all are readable) |
| `openat()` | 5793, 5799 | Same as `open()` |
| `statx()` (duplicate path) | 5880 | Same as earlier `statx()` |
| `openat()` (duplicate) | 7729, 7729 | Same as earlier `openat()` |
| `getpwnam_r()` (test) | 15011, 15023 | Hardcoded fallback in unit tests |

**Pattern:** Every file-opening syscall (`open`, `openat`, `statx`, `access`, etc.) and metadata syscall checks `synthetic_file_content()` **before** asking the backend. If a match is found, a special `SYNTHETIC_FILE_HANDLE = -100` is returned, and reads are serviced from the static string.

**Impact on PR 4:** Once `rootfs.vfs` is mounted at `/`, the kernel will ask the backend for `/etc/passwd` (from the image), so `synthetic_file_content()` becomes unnecessary. **The plan removes this function entirely (PR 4.5) once the image is guaranteed to have `/etc/passwd`.**

---

## 9. Recommendations for PR 4/5 Design

### 9.1 What Must Be Done (Forced by Current Code)

1. **Node host must use `VirtualPlatformIO`:**
   - The browser already does this. The Node host must follow the same pattern.
   - The kernel worker (not the main thread) should construct the mount table and `VirtualPlatformIO` instance.
   - This requires the worker to have a way to load the rootfs.vfs image — either:
     - Hardcoded path on disk (e.g., `node_modules/@wasm-posix/rootfs/rootfs.vfs` or env var)
     - Passed via the init message from the Node host main thread
     - Built as part of the demo's VFS setup

2. **The VirtualPlatformIO constructor requires at least one mount:**
   - Every call site must provide a `MountConfig[]` with at least one entry.
   - A root `/` mount is the minimum; it can be MemoryFileSystem (from vfsImage), HostFileSystem, or any other backend.

3. **Cross-mount operations are not supported:**
   - Rename/link between different mounts returns `EXDEV`.
   - This is acceptable — the rootfs image should contain all needed `/etc`, `/usr`, `/bin` directories.
   - If a demo needs fallback to the host filesystem (e.g., for dynamic mounts), it must be in a separate mount point (e.g., `/workspace` → HostFileSystem).

4. **Path normalization is not done by the VFS router:**
   - Backends receive paths with mount prefix stripped, starting with `/`.
   - Backends must handle `.` and `..` themselves if needed (the existing backends do).

5. **synthetic_file_content() must be removed (PR 4.5):**
   - The rootfs.vfs must include `/etc/passwd`, `/etc/group`, and `/etc/hosts`.
   - Once mounted, the kernel asks the backend instead of checking synthetic_file_content.
   - All 10 call sites in `syscalls.rs` must be removed.

### 9.2 What Is Optional or Flexible

1. **Where the rootfs.vfs is stored:**
   - Can be in `node_modules`, a package resource, passed as bytes, or generated on startup.
   - The PR should document a reasonable default (e.g., npm package path).

2. **Extra mounts (beyond `/` and `/dev`):**
   - The browser mounts `/dev/shm` for POSIX semaphores. The Node host might not need this if it uses native Node.js semaphores via the network backend.
   - Additional mounts for `/workspace`, `/host`, etc., can be configured per-demo.

3. **Readonly mounts:**
   - The `MountConfig` interface includes an optional `readonly` field, but it is currently ignored by `VirtualPlatformIO`.
   - Future PRs can implement read-only enforcement if needed.

4. **Migration path for tests/demos:**
   - Not all 21 direct `NodePlatformIO` users need to migrate in PR 4.
   - The critical ones are `run-example.ts` (the main CLI demo) and high-level tests.
   - Tests that need to bypass the VFS can be marked `@skip` or updated to explicitly construct mounts.

### 9.3 Design Pattern to Adopt

The browser's `kernel-worker-entry.ts:170–206` is the reference implementation:

```typescript
// Load or construct the root FS
let memfs: MemoryFileSystem;
if (msg.vfsImage) {
  memfs = MemoryFileSystem.fromImage(msg.vfsImage, options);
} else if (msg.fsSab) {
  memfs = MemoryFileSystem.fromExisting(msg.fsSab);
}

// Set up standard mounts
const mounts: MountConfig[] = [
  { mountPoint: "/dev/shm", backend: new MemoryFileSystem(...) },
  { mountPoint: "/dev", backend: new DeviceFileSystem() },
  { mountPoint: "/", backend: memfs },
  // Optional: { mountPoint: "/workspace", backend: new HostFileSystem(...) }
];

// Construct the VFS router
io = new VirtualPlatformIO(mounts, timeProvider);
```

**For the Node host:**
1. Main thread (`NodeKernelHost`) should optionally accept a `vfsImage` buffer or path in options.
2. If provided, pass it to the worker in the init message.
3. Worker loads the image into `MemoryFileSystem.fromImage()`.
4. Worker constructs mounts (at least `/dev` and `/` as above).
5. Worker creates `VirtualPlatformIO` before creating `CentralizedKernelWorker`.

### 9.4 synthetic_file_content() Removal Strategy

1. **PR 4.1** (this investigation): Confirm architecture. ✓
2. **PR 4.2**: Create `MountSpec` and `MountResolver` (config schema).
3. **PR 4.3**: Wire Node host to load rootfs.vfs and apply default mounts.
4. **PR 4.4**: Wire Browser host to load rootfs.vfs and apply default mounts.
5. **PR 4.5**: Remove `synthetic_file_content()` and all 10 call sites (atomic PR, no half-migration).

The removal must be atomic because:
- If the kernel still checks `synthetic_file_content()` before the VFS has mounted the image, daemons will fail.
- If the VFS is mounted but the kernel still short-circuits synthetic_file_content, the VFS files are shadowed.
- The PR must ensure: (a) all 21 demos/tests use explicit mounts, and (b) the image includes `/etc/passwd` before synthetic_file_content is removed.

### 9.5 Expected Outcome

After all 5 PRs in this phase:

1. **VirtualPlatformIO is the sole filesystem interface** for both Node and browser hosts.
2. **rootfs.vfs is the source of truth** for `/etc`, `/usr`, `/bin`, etc.
3. **No synthetic files** — everything comes from the VFS image.
4. **Explicit mounts** — each environment declares its mount table, not implicit fallthrough.
5. **Demos and tests** are self-contained — they declare what FS they need (rootfs + optional /workspace host bind).

---

## References

- **VirtualPlatformIO:** `host/src/vfs/vfs.ts:22–251`
- **MountConfig:** `host/src/vfs/types.ts:48–52`
- **FileSystemBackend:** `host/src/vfs/types.ts:9–41`
- **HostFileSystem:** `host/src/vfs/host-fs.ts:54–273`
- **MemoryFileSystem:** `host/src/vfs/memory-fs.ts:73–...`
- **DeviceFileSystem:** `host/src/vfs/device-fs.ts:78–...`
- **Browser kernel-owned setup:** `examples/browser/lib/kernel-worker-entry.ts:170–206`
- **Browser kernel interface:** `examples/browser/lib/browser-kernel.ts:50–55, 145–195`
- **synthetic_file_content:** `crates/kernel/src/syscalls.rs:110–144, 403, 631, 1064, 1524, 2108, 2451, 2501, 2624, 5793, 5880, 7729, 15011, 15023`
- **NodePlatformIO direct callers:** 21 instances identified via grep (listed in section 7).


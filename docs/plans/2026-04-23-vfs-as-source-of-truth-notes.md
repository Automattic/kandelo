# VFS-as-Source-of-Truth — Phase 3 Investigation Notes

## How open(2) reaches disk today (Node)

1. User program calls musl `open()` → `channel_syscall.c` writes args to the channel and yields.
2. Kernel `handle_channel` dispatches to `sys_open` (`crates/kernel/src/syscalls.rs:~230`).
3. `sys_open` resolves the path against cwd, then consults the virtual-path interceptors in order:
   - `match_virtual_device` (e.g. `/dev/null`, `/dev/zero`)
   - `match_pty_stat` / `match_dev_fd`
   - `match_devfs_dir`
   - **`synthetic_file_content`** — matches `/etc/passwd`, `/etc/group`, `/etc/hosts` and returns a fake OFD with `host_handle = SYNTHETIC_FILE_HANDLE (-100)`
   - `match_procfs`
4. Only if **none** of those match does `sys_open` call `host.host_open(path, flags, mode)`.
5. `host_open` is an extern declared in `crates/kernel/src/wasm_api.rs:40`. The host binds it to TypeScript at kernel-worker init time.
6. The TS implementation delegates through the `PlatformIO` interface to the configured backend — `NodePlatformIO.open` (`host/src/platform/node.ts:46`), which calls `fs.openSync(path, flags, mode)` against the real host filesystem (with a `/dev/shm/*` rewrite to `$TMPDIR/wasm-posix-shm`).

So today, when a program opens `/etc/passwd`:
- The kernel short-circuits at `synthetic_file_content`, returns a fake fd with content baked into the Rust binary (line `"root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:user:/home/user:/bin/sh\n"`).
- `NodePlatformIO` is never consulted. `fs.openSync("/etc/passwd")` is never called.
- Read/fstat/close on the returned fd are all handled by special-cased branches keyed off `ofd.host_handle == SYNTHETIC_FILE_HANDLE` — 8 such sites.

## Synthetic-code call sites (to be deleted in Task 3.5)

Per `grep -nE "SYNTHETIC_FILE_HANDLE|synthetic_file_content" crates/kernel/src/syscalls.rs`:

- `100` — constant definition
- `104` — `synthetic_file_content()` function
- `249`/`255` — `sys_open` fast-path + OFD construction
- `469–471` — close special-case (no host_handle to close)
- `888–890` — read path (copies from static bytes)
- `1293–1294` — lseek path (uses baked-in size)
- `1871–1877` — fstat path (synthesizes `st_ino=0x45544300` ("ETC\0"), `st_mode = S_IFREG|0o444`, size from baked content)
- `2213/2218` — sys_stat fast-path
- `2262/2268` — sys_lstat fast-path
- `2379` — sys_access fast-path (always succeeds)
- `5365/5371`/`5415/5452` — sys_openat / sys_newfstatat fast-paths
- `7244` — one more access-like check
- `14140–14237` — cargo tests that verify synthetic content behavior

Total: ~20 code sites + 4 tests.

## Overlay design for Phase 3.2

With the rootfs image loaded into a `MemoryFileSystem`, the host needs to route FS syscalls to either memfs (for image-owned paths) or the fallback (typically `NodePlatformIO`) for everything else. That's the `OverlayPlatformIO` from Task 3.2.

### Path ownership

A path is "owned" by memfs if any entry in the image covers it — not just a file, but any ancestor directory too. Concretely: at construction time, walk the loaded memfs tree once and compute the set of "owned roots" — the top-level paths under `/` that the image has entries for. For the Phase 2 MANIFEST that means `{/bin, /dev, /etc, /home, /lib, /proc, /root, /run, /sbin, /srv, /sys, /tmp, /usr, /var}`.

A path is owned iff it equals or is prefixed by any owned root.

Caveat: `/proc` and `/dev` are claimed by the image as empty directories, but the kernel already intercepts `/proc/*` and `/dev/*` before reaching host FS. That's fine — the overlay check is downstream of the kernel's synthetic interception; kernel-matched paths never reach us. For the overlay's purposes, `/proc` and `/dev` being owned just means "if anything slips through, route to the empty memfs dir" — safe default.

### Handle namespace

memfs and `NodePlatformIO` both return integer handles. They can collide — memfs typically returns small values (1, 2, …) and Node fs handles start around 3 but vary. If a program opens a memfs file (handle 5) then a host file (handle 5), the overlay can't tell them apart on read/write/close.

Two options:

1. **Handle offset**: add a high constant (e.g. `0x40000000`) to memfs handles at open, strip at close/read/write/stat. Keeps both namespaces opaque to callers. Downside: pollutes handle values that the kernel log/debug might inspect; requires verifying no syscall returns handles to user code (it shouldn't — user code sees kernel-level ofd indices, not PlatformIO handles, but this needs confirmation).

2. **Handle map**: maintain `Map<handle, "memfs" | "node">` on the overlay. Handle creation adds to the map; close removes. Cleaner but adds a hash lookup per syscall.

Recommendation: go with option 1 (offset). The syscall hot path is performance-sensitive per CLAUDE.md (and a PR that micro-optimized kernel-worker.ts was reverted for making things worse on app workloads). A branch-free handle-detection via bit masking is cheaper than a Map lookup and doesn't touch kernel-worker.

### Per-op routing

For each `PlatformIO` method:

- **Path-based** (`open`, `stat`, `lstat`, `mkdir`, `rmdir`, `unlink`, `rename`, `link`, `symlink`, `readlink`, `chmod`, `chown`, `access`, `utimensat`, `opendir`): check `isOwned(path)`; route to memfs or fallback.
  - Tricky: `rename(oldPath, newPath)` and `link(existingPath, newPath)` involve two paths. If they cross the boundary (one owned, one not) the operation can't work with current semantics — error with `EXDEV` (cross-device link). Matches POSIX behavior for mount boundaries.
- **Handle-based** (`close`, `read`, `write`, `seek`, `fstat`, `ftruncate`, `fsync`, `fchmod`, `fchown`, `readdir`, `closedir`): strip the offset; route based on whether the handle was in the memfs range.
- **Non-FS** (`clockGettime`, `nanosleep`, network, process, exec, signal, IPC, futex): delegate unchanged to fallback.

### What the overlay needs that memfs doesn't have yet

Spot checks against `PlatformIO` interface:

- ✅ `open`, `close`, `read`, `write`, `seek`, `fstat`, `ftruncate`, `fsync`, `fchmod`, `fchown` — implemented on `MemoryFileSystem`.
- ✅ `stat`, `lstat`, `mkdir`, `rmdir`, `unlink`, `rename`, `link`, `symlink`, `readlink`, `chmod`, `chown`, `access`, `utimensat`, `opendir`, `readdir`, `closedir` — implemented.
- ❌ Many non-FS methods — memfs doesn't have `clockGettime`/`nanosleep`/network/etc. **Those all stay on the fallback backend unconditionally**. The overlay isn't memfs-with-fallback-time; it's memfs-for-FS-only.

So the overlay wraps both backends and splits operations by type. The implementation is a straightforward adapter — no new kernel work needed beyond this.

## Risk inventory for Phase 3.5 (synthetic removal)

The change is "delete 20 code sites + retarget 4 tests", which is mechanical. Real risks:

1. **Synthetic `st_ino=0x45544300` ("ETC") was unique** — some test or user-space code might key off it. Grep confirms only the kernel's own fstat uses that constant; no user-space dependency.
2. **Synthetic files were read-only** (open with `O_WRONLY` returned EROFS via `-30`). Post-migration, `/etc/passwd` lives in memfs and is writable. Tests that expected EROFS will fail and need updating to expect success (or test `/etc/passwd` won't be used for the EROFS check going forward).
3. **Tests expecting specific bytes** — `cargo test` has tests that compare reads against `synthetic_file_content(b"/etc/passwd").unwrap()`. After removal, the function is gone, so those tests must be rewritten to compare against a MockHost that returns the expected bytes from `host_read`, or deleted if they no longer serve a purpose.
4. **Sortix tests that open `/etc/passwd`** — these run against `NodePlatformIO`, which will see the path pass through (since synthetic is gone). Without the overlay in place, `NodePlatformIO` tries `fs.openSync("/etc/passwd")` against the real macOS `/etc/passwd`. That file exists on macOS but has different content. Test would likely fail.

**Sequencing matters**: Task 3.2 (overlay) + 3.3 (Node loads rootfs into overlay) must land before Task 3.5 (synthetic removal). If they land out of order, sortix tests break.

5. **Browser path** (Task 3.4): today the browser has no `NodePlatformIO` fallback — everything goes through `MemoryFileSystem`. Synthetic interception fills the gap. When synthetic is removed, the browser must load `rootfs.vfs` into the memfs, or `/etc/passwd` opens fail. Equally load-bearing as Node.

## Takeaway for executing Phase 3

- Tasks 3.2, 3.3, 3.4 land first and leave synthetic interception in place — the overlay sits in front of `NodePlatformIO` but the kernel still short-circuits `/etc/*` via synthetic. The image is built but not yet load-bearing.
- Task 3.5 deletes synthetic in one atomic commit. Because 3.2–3.4 are in place, the traffic that used to hit synthetic now hits the overlay → memfs → real image bytes from `rootfs/etc/passwd`. If done right, zero behavior change beyond the new uid/gid honesty.
- Task 3.6 smoke-tests the round-trip with a real C program to prove it end-to-end.

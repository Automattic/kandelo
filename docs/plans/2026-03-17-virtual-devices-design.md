# Virtual Device Files Design

**Goal:** Intercept `/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/random`, `/dev/full`, `/dev/fd/N`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr` in the kernel so programs can open and use them without host filesystem support.

**Architecture:** Path-based interception in the kernel before host delegation. Virtual devices use `FileType::CharDevice` with negative `host_handle` values to encode device type. Read/write handled in existing sys_read/sys_write by checking for negative host_handle in the CharDevice path. `/dev/fd/N` and stdio aliases are open-time redirects that dup an existing fd.

**Design principle:** Central kernel handles this for clean fd namespace management. Stateless device I/O is a candidate for per-process/host-layer optimization later if profiling shows the kernel round-trip is a bottleneck.

---

## Device Inventory

| Device | Read | Write | Seek | Stat |
|--------|------|-------|------|------|
| `/dev/null` | EOF (0 bytes) | Discard (return count) | No-op, return 0 | S_IFCHR, 0666 |
| `/dev/zero` | Fill buf with 0s | Discard (return count) | No-op, return 0 | S_IFCHR, 0666 |
| `/dev/urandom` | `host_getrandom()` | Discard (return count) | No-op, return 0 | S_IFCHR, 0666 |
| `/dev/random` | Same as urandom | Same | Same | Same |
| `/dev/full` | Fill buf with 0s | Return ENOSPC | No-op, return 0 | S_IFCHR, 0666 |
| `/dev/fd/N` | Reopen fd N (dup) | — | — | — |
| `/dev/stdin` | Alias → fd 0 | — | — | — |
| `/dev/stdout` | Alias → fd 1 | — | — | — |
| `/dev/stderr` | Alias → fd 2 | — | — | — |

`/dev/fd/N` and stdio aliases are open-time redirects — they dup an existing fd rather than creating a new device OFD.

`/dev/tty` (controlling terminal) involves shared process-group state; stubbed as ENXIO for now.

## host_handle Encoding

CharDevice negative host_handle values encode virtual device type. This space is independent from Pipe and Socket negative handles (disambiguated by FileType).

```
CharDevice host_handle:
  >= 0   → real host handle (stdin/stdout/stderr)
  -1     → /dev/null
  -2     → /dev/zero
  -3     → /dev/urandom (and /dev/random)
  -4     → /dev/full
```

## Path Interception

A helper function `match_virtual_device(path: &[u8]) -> Option<VirtualDevice>` centralizes path matching. Used in:

- **sys_open / sys_openat** — after `resolve_path()`, before `host_open()`. For device matches: create OFD with `FileType::CharDevice` and negative host_handle. For `/dev/fd/N` and stdio aliases: extract target fd, validate, dup it.
- **sys_stat / sys_lstat / sys_fstatat** — before `host.host_stat()`. Return synthetic stat.
- **sys_access** — before `host.host_access()`. Return Ok for known devices.

## Synthetic stat

All virtual devices return:
```
st_mode:    S_IFCHR | 0o666
st_nlink:   1
st_size:    0
st_uid:     proc.euid
st_gid:     proc.egid
st_dev:     5  (deterministic, distinguishes from real fs)
st_ino:     device_id (1-4)
st_rdev:    (major << 8) | minor per device
atime/mtime/ctime: 0
```

## Handle Interception

In sys_read/sys_write, the existing `match file_type` branches on Pipe, Socket, and default. In the default arm (which covers CharDevice), check for negative host_handle before calling host.host_read/host_write:

- **-1 (null):** read → 0, write → count
- **-2 (zero):** read → fill zeros + count, write → count
- **-3 (urandom):** read → host_getrandom(), write → count
- **-4 (full):** read → fill zeros + count, write → ENOSPC

In sys_lseek: for CharDevice with negative host_handle, return 0 (no-op).

In sys_fstat: for CharDevice with negative host_handle, return synthetic stat.

## Tests

- `open("/dev/null")` → valid fd, read returns 0, write returns count
- `open("/dev/zero")` → read fills zeros, write returns count
- `open("/dev/urandom")` → read returns requested bytes via host_getrandom, non-zero content
- `open("/dev/full")` → read returns zeros, write returns ENOSPC
- `open("/dev/fd/1")` → dup of fd 1
- `open("/dev/stdin")` → dup of fd 0
- `stat("/dev/null")` → S_IFCHR, mode 0666
- `fstat(dev_null_fd)` → same synthetic stat
- `access("/dev/null", R_OK|W_OK)` → Ok
- `lseek(dev_null_fd, ...)` → returns 0
- `open("/dev/nonexistent")` → falls through to host (ENOENT)
- `open("/dev/fd/999")` where fd 999 doesn't exist → EBADF
- `open("/dev/fd/abc")` → ENOENT

## Files to Modify

| File | Changes |
|------|---------|
| `crates/kernel/src/syscalls.rs` | Add `VirtualDevice` enum, `match_virtual_device()`, intercept in sys_open, sys_read, sys_write, sys_lseek, sys_stat, sys_lstat, sys_fstat, sys_fstatat, sys_access + tests |
| `crates/kernel/src/wasm_api.rs` | No changes needed (existing kernel_open/read/write exports call the modified sys_* functions) |
| `glue/syscall_glue.c` | No changes needed (existing SYS_OPEN/READ/WRITE dispatch is sufficient) |
| `docs/posix-status.md` | Add virtual device file support entry |

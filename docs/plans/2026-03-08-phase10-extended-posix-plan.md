# Phase 10: Extended POSIX APIs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add commonly-needed POSIX APIs that are straightforward kernel-level implementations: system info, file extensions, resource limits, and fd convenience calls.

**Architecture:** Mix of kernel-internal state (umask, uname, rlimits), host-delegated calls (ftruncate, fsync), pure computation (sysconf), and extensions to existing syscalls (dup3, pipe2, writev/readv).

**Tech Stack:** Rust (no_std compatible), wasm32-unknown-unknown target

**Test command:** `cargo test --target $(rustc -vV | grep host | awk '{print $2}') -p kandelo`

**Build command:** `cargo build --target wasm32-unknown-unknown -Z build-std=core,alloc -Z build-std-features=panic_immediate_abort -p kandelo --release`

---

## Design Decisions

### DD1: umask applied in kernel, not host
The umask filters mode bits before passing to host_open/host_mkdir. This ensures consistent behavior regardless of host platform.

### DD2: ftruncate/fsync require new HostIO methods
These need new host_ftruncate and host_fsync methods in the HostIO trait. The host backend (NodePlatformIO) will implement them via fs.ftruncateSync/fs.fsyncSync.

### DD3: writev/readv loop over iovecs calling existing read/write
Rather than adding kernel-internal vectored I/O, we iterate through iovec entries and call the existing sys_read/sys_write for each. This reuses all existing pipe/socket/file dispatch logic.

### DD4: getrlimit/setrlimit are advisory only
Limits are stored but not enforced. The Wasm runtime does not yet provide the hooks needed for full resource-limit enforcement.

### DD5: sysconf returns Wasm-appropriate values
_SC_PAGE_SIZE=65536 (Wasm page size), _SC_NPROCESSORS_ONLN=1 (single-threaded), etc.

---

## Task 1: Add umask support

**Files:**
- Modify: `crates/kernel/src/process.rs` — add `pub umask: u32` field
- Modify: `crates/kernel/src/syscalls.rs` — add sys_umask, apply mask in sys_open and sys_mkdir
- Modify: `crates/shared/src/lib.rs` — add Umask=74 syscall number
- Modify: `crates/kernel/src/wasm_api.rs` — add kernel_umask export

**Implementation:**
```rust
/// umask — set file creation mask, return previous mask
pub fn sys_umask(proc: &mut Process, mask: u32) -> u32 {
    let old = proc.umask;
    proc.umask = mask & 0o777;
    old
}
```

Apply in sys_open: `let effective_mode = mode & !proc.umask;`
Apply in sys_mkdir: `let effective_mode = mode & !proc.umask;`

Default umask: 0o022 (standard Unix default)

**Tests:**
- test_umask_default_022
- test_umask_set_and_get_old
- test_umask_masks_high_bits

---

## Task 2: Add uname support

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — add sys_uname
- Modify: `crates/shared/src/lib.rs` — add Uname=75 syscall number
- Modify: `crates/kernel/src/wasm_api.rs` — add kernel_uname export

**Implementation:**
```rust
/// uname — get system identification
/// Writes 5 strings (sysname, nodename, release, version, machine) to buffer
/// Each string is null-terminated, max 65 bytes each = 325 bytes total
pub fn sys_uname(buf: &mut [u8]) -> Result<(), Errno> {
    if buf.len() < 325 {
        return Err(Errno::EINVAL);
    }
    let fields: [&[u8]; 5] = [
        b"wasm-posix",   // sysname
        b"localhost",    // nodename
        b"1.0.0",        // release
        b"kandelo", // version
        b"wasm32",       // machine
    ];
    for (i, field) in fields.iter().enumerate() {
        let offset = i * 65;
        let len = field.len().min(64);
        buf[offset..offset + len].copy_from_slice(&field[..len]);
        buf[offset + len] = 0; // null terminator
    }
    Ok(())
}
```

**Tests:**
- test_uname_returns_fields
- test_uname_buffer_too_small

---

## Task 3: Add sysconf support

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — add sys_sysconf
- Modify: `crates/shared/src/lib.rs` — add Sysconf=76, sysconf constants
- Modify: `crates/kernel/src/wasm_api.rs` — add kernel_sysconf export

**Implementation:**
```rust
/// sysconf — get configurable system variables
pub fn sys_sysconf(name: i32) -> Result<i64, Errno> {
    match name {
        0 => Ok(1),        // _SC_ARG_MAX (not applicable, return 1)
        1 => Ok(0),        // _SC_CHILD_MAX (no fork support)
        2 => Ok(100),      // _SC_CLK_TCK (clock ticks per second)
        4 => Ok(1024),     // _SC_OPEN_MAX
        6 => Ok(1),        // _SC_NPROCESSORS_ONLN
        8 => Ok(1),        // _SC_NPROCESSORS_CONF
        30 => Ok(65536),   // _SC_PAGE_SIZE / _SC_PAGESIZE (Wasm page = 64KB)
        _ => Err(Errno::EINVAL),
    }
}
```

**Tests:**
- test_sysconf_page_size
- test_sysconf_open_max
- test_sysconf_invalid

---

## Task 4: Add dup3 and pipe2

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — add sys_dup3, sys_pipe2
- Modify: `crates/shared/src/lib.rs` — add Dup3=77, Pipe2=78 syscall numbers
- Modify: `crates/kernel/src/wasm_api.rs` — add kernel_dup3, kernel_pipe2 exports

**Implementation:**
```rust
/// dup3 — dup2 with flags (O_CLOEXEC)
pub fn sys_dup3(proc: &mut Process, oldfd: i32, newfd: i32, flags: u32) -> Result<i32, Errno> {
    if oldfd == newfd { return Err(Errno::EINVAL); } // dup3 differs from dup2 here
    // Close newfd if open
    // Dup oldfd to newfd
    // If O_CLOEXEC set, set FD_CLOEXEC on newfd
}

/// pipe2 — pipe with flags (O_NONBLOCK, O_CLOEXEC)
pub fn sys_pipe2(proc: &mut Process, flags: u32) -> Result<(i32, i32), Errno> {
    let (read_fd, write_fd) = sys_pipe(proc)?;
    if flags & O_CLOEXEC != 0 {
        // Set FD_CLOEXEC on both fds
    }
    if flags & O_NONBLOCK != 0 {
        // Set O_NONBLOCK on both OFDs
    }
    Ok((read_fd, write_fd))
}
```

**Tests:**
- test_dup3_with_cloexec
- test_dup3_same_fd_einval
- test_pipe2_nonblock
- test_pipe2_cloexec

---

## Task 5: Add ftruncate and fsync (with new HostIO methods)

**Files:**
- Modify: `crates/kernel/src/process.rs` — add host_ftruncate, host_fsync to HostIO trait
- Modify: `crates/kernel/src/syscalls.rs` — add sys_ftruncate, sys_fsync
- Modify: `crates/shared/src/lib.rs` — add Ftruncate=79, Fsync=80 syscall numbers
- Modify: `crates/kernel/src/wasm_api.rs` — add kernel_ftruncate, kernel_fsync exports + WasmHostIO impls

**Implementation:**
```rust
// In HostIO trait:
fn host_ftruncate(&mut self, handle: i64, length: i64) -> Result<(), Errno>;
fn host_fsync(&mut self, handle: i64) -> Result<(), Errno>;

/// ftruncate — truncate file to specified length
pub fn sys_ftruncate(proc: &mut Process, host: &mut dyn HostIO, fd: i32, length: i64) -> Result<(), Errno> {
    let entry = proc.fd_table.get(fd).ok_or(Errno::EBADF)?;
    let ofd = proc.ofd_table.get(entry.ofd_index).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Regular { return Err(Errno::EINVAL); }
    // Check writable
    host.host_ftruncate(ofd.host_handle, length)
}

/// fsync — synchronize file to storage
pub fn sys_fsync(proc: &mut Process, host: &mut dyn HostIO, fd: i32) -> Result<(), Errno> {
    let entry = proc.fd_table.get(fd).ok_or(Errno::EBADF)?;
    let ofd = proc.ofd_table.get(entry.ofd_index).ok_or(Errno::EBADF)?;
    if ofd.file_type != FileType::Regular { return Err(Errno::EINVAL); }
    host.host_fsync(ofd.host_handle)
}
```

**Tests:**
- test_ftruncate_regular_file
- test_ftruncate_not_regular_file_einval
- test_fsync_regular_file
- test_fsync_pipe_einval

---

## Task 6: Add writev and readv

**Files:**
- Modify: `crates/kernel/src/syscalls.rs` — add sys_writev, sys_readv
- Modify: `crates/shared/src/lib.rs` — add Writev=81, Readv=82 syscall numbers, WasmIovec struct
- Modify: `crates/kernel/src/wasm_api.rs` — add kernel_writev, kernel_readv exports

**Implementation:**
```rust
/// WasmIovec - matches struct iovec layout
#[repr(C)]
pub struct WasmIovec {
    pub iov_base: u32, // pointer (in Wasm memory)
    pub iov_len: u32,  // length
}

/// writev — write from multiple buffers
pub fn sys_writev(proc: &mut Process, host: &mut dyn HostIO, fd: i32, iovecs: &[(u32, u32)]) -> Result<usize, Errno> {
    let mut total = 0usize;
    for &(base, len) in iovecs {
        if len == 0 { continue; }
        // Note: In wasm_api.rs, the caller will extract data from wasm memory
        // Here we receive pre-extracted byte slices
    }
    Ok(total)
}
```

Actually, writev/readv are best implemented at the wasm_api.rs level since they need direct memory access for the iovec array. The kernel_writev export will parse the iovec array from Wasm memory and call sys_write for each buffer.

**Tests:**
- test_writev_multiple_buffers
- test_readv_multiple_buffers
- test_writev_empty_iovec

---

## Task 7: Add getrlimit/setrlimit

**Files:**
- Modify: `crates/kernel/src/process.rs` — add rlimits to Process
- Modify: `crates/kernel/src/syscalls.rs` — add sys_getrlimit, sys_setrlimit
- Modify: `crates/shared/src/lib.rs` — add Getrlimit=83, Setrlimit=84, resource constants
- Modify: `crates/kernel/src/wasm_api.rs` — add exports

**Implementation:**
```rust
// Resource limit struct
pub struct Rlimit {
    pub rlim_cur: u64, // soft limit
    pub rlim_max: u64, // hard limit
}

// Resource constants
pub const RLIMIT_NOFILE: u32 = 7;
pub const RLIMIT_NPROC: u32 = 6;
pub const RLIMIT_STACK: u32 = 3;
pub const RLIMIT_DATA: u32 = 2;
pub const RLIMIT_FSIZE: u32 = 1;
pub const RLIM_INFINITY: u64 = u64::MAX;

// Defaults
RLIMIT_NOFILE: cur=1024, max=4096
RLIMIT_STACK: cur=8MB, max=INFINITY
Others: cur=INFINITY, max=INFINITY
```

**Tests:**
- test_getrlimit_nofile_default
- test_setrlimit_and_getrlimit
- test_getrlimit_invalid_resource

---

## Task 8: Update docs and TypeScript wrappers

**Files:**
- Modify: `docs/posix-status.md` — add entries for all new APIs, update Phase 10
- Modify: `host/src/kernel.ts` — add TypeScript convenience methods
- Modify: `host/src/types.ts` — add ftruncate/fsync to PlatformIO interface

---

## Summary

This plan adds 12 new syscalls in 8 tasks:
1. umask — file creation mask
2. uname — system identification
3. sysconf — system configuration values
4. dup3, pipe2 — fd convenience extensions
5. ftruncate, fsync — file operations (requires new HostIO methods)
6. writev, readv — scatter-gather I/O
7. getrlimit, setrlimit — resource limits (advisory)
8. Docs + TypeScript wrappers

Total: ~30 new tests, no Asyncify or multi-worker needed.

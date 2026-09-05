//! Increment 2 of the native Wasmtime host: boot the real kernel and run a
//! trivial guest program through the real syscall channel — no browser, no
//! Node, no JavaScript.
//!
//! Increment 1 ([`crate::load_kernel_and_read_abi`]) proved Wasmtime can load
//! the real `kernel.wasm` and drive the atomic wait/notify channel primitive.
//! This increment closes the loop: it creates a process in the kernel,
//! instantiates a real SDK-built guest on its own OS thread over a second
//! shared memory, and runs the host-side **channel pump** that carries each
//! syscall the guest posts into `kernel_handle_channel` and the result back.
//!
//! The guest ([`fixtures/native_hello.c`]) issues exactly four syscalls —
//! `mmap` (anonymous, during `_start`), `getpid`, `write(1, …)`, and
//! `exit_group` — so this exercises the whole spine (process creation, memory
//! layout, the two-thread wait/notify handoff, RAW pointer-arg marshalling for
//! `write`, anonymous-mmap address-space growth, `host_write` routed to real
//! stdout, and exit-status collection) with no VFS and no fork.
//!
//! ## Two memories, one channel
//!
//! The kernel and the guest run in **separate** Wasmtime instances with
//! **separate** shared linear memories. The syscall channel lives inside the
//! *guest's* memory at `channel_offset`; the kernel operates only on its own
//! *scratch* memory. The pump is the bridge: it copies the channel header +
//! marshalled pointer buffers from guest memory into the kernel scratch, calls
//! `kernel_handle_channel`, then copies the return/errno (and any `Out` buffers)
//! back into the guest channel. The guest blocks in `memory.atomic.wait32` on
//! the channel status word; the host wakes it with `SharedMemory::atomic_notify`
//! after a release store of `COMPLETE`.
//!
//! HOST-ONLY: build/test with an explicit host target (see `Cargo.toml`).

use std::cell::UnsafeCell;
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write as _};
use std::os::unix::fs::{DirEntryExt, FileExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use wasmtime::{
    Caller, Engine, Global, GlobalType, Linker, MemoryType, Module, Mutability, Ref, SharedMemory,
    Store, Val, ValType,
};

use wasm_posix_shared::channel::{
    ARGS_OFFSET, ARG_SIZE, DATA_OFFSET, DATA_SIZE, ERRNO_OFFSET, MIN_CHANNEL_SIZE,
    REQUEST_FLAGS_OFFSET, REQUEST_FLAG_OPAQUE_RECORD, RETURN_OFFSET, STATUS_OFFSET, SYSCALL_OFFSET,
};
use wasm_posix_shared::abi::extended_syscalls::{SYS_CLONE, SYS_EXIT_GROUP};
use wasm_posix_shared::abi::host_intercepted::{SYS_EXECVE, SYS_EXECVEAT, SYS_SPAWN};
use wasm_posix_shared::channel_record::RECORD_MAGIC;
use wasm_posix_shared::flags as open_flags;
use wasm_posix_shared::host_abi::{
    SyscallArgDesc, SyscallArgDirection, SyscallArgSize, SYSCALL_ARG_DESCRIPTORS,
};
use wasm_posix_shared::platform_limits::PROCESS_STARTUP_MAX_ARGV_COUNT;
use wasm_posix_shared::seek::SEEK_END;
use wasm_posix_shared::{ChannelStatus, Syscall};

// --- Channel status word values --------------------------------------------
// Mirror of `WASM_POSIX_CHANNEL_STATUS_*` in `libc/glue/abi_constants.h`, which
// the guest glue writes/reads. These are not exported by the shared Rust crate
// because only the host and the guest glue (never the kernel) touch the status
// word, so they are pinned here against that generated header.
/// Documents the full status-word alphabet the guest cycles through; the pump
/// only ever reads PENDING and writes COMPLETE.
#[allow(dead_code)]
const STATUS_IDLE: u32 = 0;
const STATUS_PENDING: u32 = 1;
const STATUS_COMPLETE: u32 = 2;

// --- Process memory layout constants ----------------------------------------
// Mirror of the ABI-generated `PROCESS_MEMORY_*` constants in
// `host/src/generated/abi.ts` (the source of truth `computeProcessMemoryLayout`
// consumes). They are TypeScript-generated today, so they are pinned here; if
// they ever move into the shared Rust crate this block should import them.
const WASM_PAGE_SIZE: usize = 65536;
const DEFAULT_MAX_PAGES: usize = 16384;
const DEFAULT_INITIAL_PAGES: usize = 17;
/// When a guest exports no `__heap_base`, the control/channel region is placed
/// at this fixed byte offset, matching `PROCESS_MEMORY_FALLBACK_BRK_BASE`.
const FALLBACK_BRK_BASE: usize = 16_777_216;
const MAIN_CHANNEL_PRIMARY_PAGE: usize = 1;
/// `ceil(MIN_CHANNEL_SIZE / WASM_PAGE_SIZE)` — the channel spans this many pages.
const CHANNEL_PAGES: usize = (MIN_CHANNEL_SIZE + WASM_PAGE_SIZE - 1) / WASM_PAGE_SIZE;

// Per-thread slot layout (mirrors host/src/thread-allocator.ts + the
// PROCESS_MEMORY_THREAD_SLOT_* constants in the generated ABI). Each spawned
// thread gets a 4-page slot; within it the TLS page is page 0 and the channel's
// primary page is page 2 (page 1 is the fork-save page, unused here).
const PAGES_PER_THREAD_SLOT: usize = 4;
const THREAD_SLOT_TLS_PAGE: usize = 0;
const THREAD_SLOT_CHANNEL_PRIMARY_PAGE: usize = 2;
/// Thread slots reserved below `brk_base`, so a spawned thread's channel/TLS
/// pages never collide with the guest's brk/mmap allocations. A test needs one;
/// this leaves generous headroom.
const RESERVED_THREAD_SLOTS: usize = 16;

/// The kernel imports `env.memory` with these bounds (see increment 1).
const KERNEL_MEMORY_MIN_PAGES: u32 = 18;
const KERNEL_MEMORY_MAX_PAGES: u32 = 16384;

/// StdioKind ABI value for `HostPipe` — fds 0/1/2 become host-bridged pipes
/// whose `host_handle == fd`, so `write(1, …)` routes to `host_write(1, …)`.
/// Matches `StdioKind::from_abi(0)` in `crates/runtime-core/src/process.rs`.
const STDIO_KIND_HOST_PIPE: i32 = 0;

/// The resolved process memory layout for a single guest, computed exactly like
/// the TypeScript host's `computeProcessMemoryLayout` with no `__heap_base`.
#[derive(Debug, Clone, Copy)]
struct ProcessLayout {
    initial_pages: usize,
    channel_offset: usize,
    brk_base: usize,
    max_addr: usize,
    /// First page of the thread-slot arena (just past the main channel); thread
    /// slot N begins at `first_thread_slot_page + N * PAGES_PER_THREAD_SLOT`.
    first_thread_slot_page: usize,
}

impl ProcessLayout {
    /// `imported_min_pages` is the guest's imported `env.memory` minimum.
    fn compute(imported_min_pages: usize) -> Self {
        let min_pages = DEFAULT_INITIAL_PAGES.max(imported_min_pages);
        // No `__heap_base` export → fall back to the fixed control base, exactly
        // like `heapBase ?? PROCESS_FALLBACK_BRK_BASE` in the TS host.
        let first_free_byte = FALLBACK_BRK_BASE.max(min_pages * WASM_PAGE_SIZE);
        let control_base_page = first_free_byte.div_ceil(WASM_PAGE_SIZE);
        let channel_page = control_base_page + MAIN_CHANNEL_PRIMARY_PAGE;
        let channel_offset = channel_page * WASM_PAGE_SIZE;
        // The thread-slot arena sits between the main channel and brk_base, so
        // thread channels/TLS never collide with the guest's brk/mmap region.
        let first_thread_slot_page = channel_page + CHANNEL_PAGES;
        let thread_arena_end_page =
            first_thread_slot_page + RESERVED_THREAD_SLOTS * PAGES_PER_THREAD_SLOT;
        // Initial memory need only cover the main channel; thread slots and brk
        // grow lazily. brk starts above the reserved thread arena.
        let initial_pages = min_pages.max(first_thread_slot_page);
        let brk_base = thread_arena_end_page * WASM_PAGE_SIZE;
        let max_addr = DEFAULT_MAX_PAGES * WASM_PAGE_SIZE;
        Self {
            initial_pages,
            channel_offset,
            brk_base,
            max_addr,
            first_thread_slot_page,
        }
    }
}

/// Captured host I/O for the process's stdout/stderr host pipes.
#[derive(Default)]
struct CapturedIo {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

// --- Host capabilities: sandboxed default + opt-in native-directory mount --
//
// N1-I1a: the native host's default `/` and `/tmp` are the in-kernel rootfs
// overlay and tmpfs (see the `kernel_set_rootfs_now`/`kernel_set_tmpfs_enabled`/
// `kernel_set_rootfs_enabled` calls in `run_guest`), a sandboxed in-memory VFS
// that never touches the host.
//
// N1-I1b adds the only way to reach the real host filesystem: an explicit
// [`NativeMount`] registered as a rootfs *foreign prefix*
// (`kernel_rootfs_set_foreign_prefixes`, called in `run_guest` before rootfs
// authority is enabled — see `crates/kernel/src/wasm_api.rs`). The overlay
// disowns a foreign-prefixed subtree (`rootfs::owns_path` returns false under
// it), so the kernel's path resolution falls through to `host_lstat`/
// `host_stat`/`host_open`/`host_pread`/`host_fstat`/`host_seek`/
// `host_opendir`/`host_readdir`/`host_closedir`/`host_readlink` for paths
// under the mount — exactly like Node's `HostFileSystem`/`extraMounts` (see
// `host/src/vfs/host-fs.ts`, `host/src/node-kernel-worker-entry.ts`). With no
// mount configured, those imports stay trapped
// (`define_unknown_imports_as_traps`) — a truthful boundary, since the
// overlay claims all of `/` and they must never fire.

/// An explicit native host-directory mount into the guest's VFS (N1-I1b), at
/// parity with Node's `extraMounts`/`HostFileSystem(hostPath, mountPoint)`.
/// `mount_point` must be a top-level absolute path (e.g. `/host`) for this
/// increment — no nested-parent seeding of the overlay is performed, so a
/// mount point nested under an existing overlay directory is not supported.
#[derive(Debug, Clone)]
pub struct NativeMount {
    /// The absolute VFS path this mount is visible at.
    pub mount_point: String,
    /// The real host directory backing it.
    pub host_dir: PathBuf,
    /// Mirrors Node's `MountConfig.readonly`. **Not enforced** by this
    /// increment: `VirtualPlatformIO` does not check `readonly` for
    /// `HostFileSystem` mounts either (only `MemoryFileSystem.mount()` does —
    /// see `host/src/vfs/vfs.ts` / `host/src/vfs/memory-fs.ts`), so leaving it
    /// unenforced here matches the platform's actual behavior rather than
    /// claiming a guarantee neither host currently provides for this mount
    /// kind.
    pub readonly: bool,
}

/// One registered mount's VFS-path prefix and its real host root directory.
struct MountPoint {
    /// Normalized: no trailing slash (this increment's mount points are
    /// top-level, so never literally `"/"`).
    prefix: String,
    root: PathBuf,
}

/// `WasmDirent::d_type` values (crates/shared), a subset of Linux's `DT_*`.
const DT_UNKNOWN: u32 = 0;
const DT_DIR: u32 = 4;
const DT_REG: u32 = 8;
const DT_LNK: u32 = 10;
/// Size of the `repr(C)` `WasmStat` the kernel reads back (crates/shared).
const WASM_STAT_SIZE: usize = 88;
/// First host handle the FS hands out; kept clear of the 0/1/2 stdio range.
/// Shared by both the file-handle and directory-handle tables — they are
/// disjoint maps, so overlapping numbers between them are harmless.
const HOST_FS_FIRST_HANDLE: i64 = 1000;

/// A blocking stdin (fd 0, a HostPipe) whose data is not ready on the first
/// read. `host_read(0)` returns EAGAIN once — forcing the kernel to block and
/// the pump to park the read — then delivers the line, then EOF. This is how a
/// real host pipe behaves when input arrives on a later poll; the call counter
/// just makes it deterministic for the test.
const HOST_STDIN_LINE: &[u8] = b"stdin via blocking read\n";

/// fd 0 (stdin, always present) plus, when one or more [`NativeMount`]s are
/// configured, real host-directory file/dir/symlink access scoped to them.
///
/// Path containment for a mount is enforced *lexically*: a guest path (with
/// the owning mount's prefix stripped) is split into components, `..` pops
/// the last pushed component (never below that mount's root), and the
/// remainder is joined onto `root`. This is a scoped boundary, not a
/// symlink-escape-proof sandbox — a symlink placed *inside* the mounted tree
/// that points outside it is still followed by the real filesystem, exactly
/// like any other host-directory passthrough (mirrors Node's
/// `HostFileSystem.safePath`). That lexical guard is defense in depth, since
/// the kernel already normalizes guest-visible paths before calling into
/// these capabilities.
///
/// Unix-only (`std::os::unix::fs::*`): this workspace has no Windows CI
/// target for the native host.
struct HostFs {
    /// Number of host_read(0) calls so far (drives the EAGAIN-then-data stdin).
    stdin_reads: Mutex<u32>,
    /// Registered mounts, longest-prefix-first (mirrors `VirtualPlatformIO`'s
    /// mount sort in `host/src/vfs/vfs.ts`), so a nested mount would win over
    /// a shorter enclosing one — though this increment only exercises a
    /// single top-level mount. Empty by default (T1's sandboxed path).
    mounts: Vec<MountPoint>,
    /// Open regular-file (or O_DIRECTORY-opened directory) handles from
    /// `host_open`, shared across all mounts — a handle alone identifies its
    /// `File`, so no further mount lookup is needed once open.
    files: Mutex<HashMap<i64, File>>,
    /// Open directory-iteration handles from `host_opendir`.
    dirs: Mutex<HashMap<i64, fs::ReadDir>>,
    next_handle: Mutex<i64>,
}

impl HostFs {
    fn new(mounts: &[NativeMount]) -> Self {
        let mut mount_points: Vec<MountPoint> = mounts
            .iter()
            .map(|m| MountPoint {
                prefix: normalize_mount_point(&m.mount_point),
                root: m.host_dir.clone(),
            })
            .collect();
        // Longest prefix first, so `resolve`'s first match is the most
        // specific mount.
        mount_points.sort_by(|a, b| b.prefix.len().cmp(&a.prefix.len()));
        Self {
            stdin_reads: Mutex::new(0),
            mounts: mount_points,
            files: Mutex::new(HashMap::new()),
            dirs: Mutex::new(HashMap::new()),
            next_handle: Mutex::new(HOST_FS_FIRST_HANDLE),
        }
    }

    fn alloc_handle(&self) -> i64 {
        let mut next = self.next_handle.lock().unwrap();
        let h = *next;
        *next += 1;
        h
    }

    /// Resolve a full guest VFS path to a real host path: find the owning
    /// mount (longest-prefix match, mirroring `VirtualPlatformIO.resolve` in
    /// `host/src/vfs/vfs.ts`), strip its prefix (mirroring
    /// `HostFileSystem.guestAbsoluteToMountRelative`), then lexically join the
    /// remainder onto that mount's root (mirroring `HostFileSystem.safePath`'s
    /// component walk — see the struct doc comment for the exact containment
    /// guarantee this collapses to). Returns a positive errno on failure,
    /// including when no mount claims the path — never expected in practice,
    /// since the kernel only calls these imports for paths a registered
    /// foreign prefix has disowned from the overlay.
    fn resolve(&self, guest_path: &[u8]) -> Result<PathBuf, i32> {
        let s = std::str::from_utf8(guest_path).map_err(|_| libc_errno::EINVAL)?;
        if !s.starts_with('/') {
            return Err(libc_errno::EINVAL);
        }
        let Some(mount) = self.mounts.iter().find(|m| {
            s == m.prefix.as_str()
                || (s.len() > m.prefix.len()
                    && s.as_bytes()[m.prefix.len()] == b'/'
                    && s.starts_with(m.prefix.as_str()))
        }) else {
            return Err(libc_errno::ENOENT);
        };
        let rel = if s.len() == mount.prefix.len() { "" } else { &s[mount.prefix.len() + 1..] };
        let mut stack: Vec<&str> = Vec::new();
        for component in rel.split('/') {
            match component {
                "" | "." => {}
                ".." => {
                    stack.pop();
                }
                other => stack.push(other),
            }
        }
        let mut resolved = mount.root.clone();
        resolved.extend(stack);
        Ok(resolved)
    }
}

/// Normalize a mount point the way `VirtualPlatformIO.normalizeMountPoint`
/// does (`host/src/vfs/vfs.ts`): ensure a leading `/`, drop a trailing `/`
/// (unless it is exactly `/`).
fn normalize_mount_point(mount_point: &str) -> String {
    let mp =
        if mount_point.starts_with('/') { mount_point.to_string() } else { format!("/{mount_point}") };
    if mp != "/" && mp.ends_with('/') { mp[..mp.len() - 1].to_string() } else { mp }
}

/// Translate the guest's Linux-numbered `O_*` open flags (`wasm_posix_shared::
/// flags`) into `std::fs::OpenOptions`, mirroring `translateOpenFlags` in
/// `host/src/vfs/host-fs.ts`.
fn open_options_from_flags(flags: u32, mode: u32) -> OpenOptions {
    let mut opts = OpenOptions::new();
    let accmode = flags & open_flags::O_ACCMODE;
    opts.read(accmode != open_flags::O_WRONLY);
    opts.write(accmode == open_flags::O_WRONLY || accmode == open_flags::O_RDWR);
    if flags & open_flags::O_CREAT != 0 {
        if flags & open_flags::O_EXCL != 0 {
            opts.create_new(true);
        } else {
            opts.create(true);
        }
        opts.mode(mode & 0o7777);
    }
    if flags & open_flags::O_TRUNC != 0 {
        opts.truncate(true);
    }
    if flags & open_flags::O_APPEND != 0 {
        opts.append(true);
    }
    opts
}

/// Map an `io::Error` from a real filesystem call to a Linux-numbered errno.
///
/// `raw_os_error()` is deliberately not used as a general fallback: this host
/// process may run on macOS, whose errno numbering diverges from Linux's past
/// the handful of very old, universally-shared POSIX codes (e.g. `ENAMETOOLONG`,
/// `ELOOP`, and `ENOTEMPTY` all have different numbers on macOS than on Linux).
/// Passing a raw macOS errno through would silently forge a wrong Linux errno
/// for the guest. `ErrorKind` is portable, so match on it and collapse anything
/// it doesn't cover to `EIO` — a truthful "something failed" instead of a
/// possibly-wrong specific errno.
fn errno_from_io(e: &std::io::Error) -> i32 {
    use std::io::ErrorKind as K;
    match e.kind() {
        K::NotFound => libc_errno::ENOENT,
        K::PermissionDenied => libc_errno::EACCES,
        K::AlreadyExists => libc_errno::EEXIST,
        K::NotADirectory => libc_errno::ENOTDIR,
        K::IsADirectory => libc_errno::EISDIR,
        K::InvalidInput => libc_errno::EINVAL,
        _ => libc_errno::EIO,
    }
}

/// Combine two 32-bit words into a signed 64-bit value (high word first),
/// mirroring `signedI64FromWords` in `host/src/kernel.ts` — the same
/// low/high-word convention `host_pread`/`host_seek` use throughout this file.
fn combine_i64(lo: i32, hi: i32) -> i64 {
    ((hi as i64) << 32) | (lo as u32 as i64)
}

/// Serialize a `WasmStat` (mode + size, other fields zero) into kernel memory at
/// `stat_ptr`, matching the field offsets the kernel's `repr(C)` struct expects
/// (see host/src/kernel.ts `#writeStatToMemory`).
unsafe fn write_wasm_stat(mem: &SharedMemory, stat_ptr: usize, mode: u32, size: u64, nlink: u32) {
    let mut b = [0u8; WASM_STAT_SIZE];
    b[16..20].copy_from_slice(&mode.to_le_bytes()); // st_mode
    b[20..24].copy_from_slice(&nlink.to_le_bytes()); // st_nlink
    b[32..40].copy_from_slice(&size.to_le_bytes()); // st_size
    unsafe { write_bytes(mem, stat_ptr, &b) };
}

/// Serialize a real `std::fs::Metadata` into a `WasmStat`. `Metadata::mode()`
/// already carries the `S_IFMT` file-type bits (`S_IFDIR`/`S_IFREG`/`S_IFLNK`
/// etc.), which are numerically identical between Linux and the BSD/macOS
/// heritage `st_mode` encoding, so no translation is needed.
unsafe fn write_wasm_stat_from_metadata(mem: &SharedMemory, stat_ptr: usize, meta: &fs::Metadata) {
    unsafe { write_wasm_stat(mem, stat_ptr, meta.mode(), meta.size(), meta.nlink() as u32) };
}

/// The result of running a trivial guest to completion.
#[derive(Debug)]
pub struct RunOutcome {
    /// The process exit code the kernel recorded for `exit_group`.
    pub exit_code: i32,
    /// Everything the guest wrote to fd 1 via `host_write`.
    pub stdout: Vec<u8>,
    /// Everything the guest wrote to fd 2 via `host_write`.
    pub stderr: Vec<u8>,
    /// The syscall numbers the guest posted, in order — a witness that the
    /// program really ran the expected path (mmap, getpid, write, exit_group).
    pub syscall_trace: Vec<u32>,
}

// --- Raw shared-memory access helpers ---------------------------------------
//
// `SharedMemory` pre-reserves its maximum virtual size, so the base pointer is
// stable across `grow`, and the memory is `Send + Sync`, so both the kernel
// thread (pump) and the guest thread read/write it without a `Store` borrow.
// Every access below is bounds-agnostic; callers keep offsets within the
// allocated layout.

fn mem_base(mem: &SharedMemory) -> *mut u8 {
    mem.data().as_ptr() as *mut UnsafeCell<u8> as *mut u8
}

/// Copy `len` bytes out of `mem` starting at byte `off`.
unsafe fn read_bytes(mem: &SharedMemory, off: usize, len: usize) -> Vec<u8> {
    unsafe { core::slice::from_raw_parts(mem_base(mem).add(off), len) }.to_vec()
}

/// Copy `bytes` into `mem` starting at byte `off`.
unsafe fn write_bytes(mem: &SharedMemory, off: usize, bytes: &[u8]) {
    unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), mem_base(mem).add(off), bytes.len()) };
}

unsafe fn read_u32(mem: &SharedMemory, off: usize) -> u32 {
    let b = unsafe { read_bytes(mem, off, 4) };
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

unsafe fn read_i64(mem: &SharedMemory, off: usize) -> i64 {
    let b = unsafe { read_bytes(mem, off, 8) };
    i64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])
}

/// A `&AtomicU32` view of the 4-byte word at `off` (must be 4-byte aligned).
unsafe fn atomic_u32(mem: &SharedMemory, off: usize) -> &AtomicU32 {
    unsafe { &*(mem_base(mem).add(off) as *const AtomicU32) }
}

/// Read a NUL-terminated C string out of guest memory starting at `ptr` (a
/// native wasm32 guest byte address — pointers are 4 bytes LE in every
/// guest this host runs). Used by `execve`/`execveat`'s `run_pump` branches
/// (N1-I3c Task 1, N1-I3d Task 1) to read the `path` argument, and by
/// `handle_exec_common` to read each `argv`/`envp` entry
/// `read_guest_string_array` finds. Bounds itself against the guest
/// memory's OWN actual size (`mem.data().len()`, not some fixed cap) so an
/// out-of-range `ptr` cannot walk past the mapped region: a `ptr` already at
/// or past the end of memory reads as an empty string, and a string with no
/// NUL before the end of memory reads to the end of memory rather than
/// panicking. This mirrors the Node reference host's bounded scan
/// (`readExecPathFromProcess`/`readStringArrayFromProcess`,
/// `host/src/kernel-worker.ts:23747-23829`), though Task 1 does not yet
/// distinguish "ran off the end of memory" from "found a very long,
/// legitimately-terminated string" the way that reference does (Task 2's
/// failure matrix is the natural home for that distinction; this happy-path
/// task never hits it because its fixtures use small, well-formed strings).
fn read_guest_cstring(mem: &SharedMemory, ptr: u32) -> Vec<u8> {
    let base = ptr as usize;
    let total = mem.data().len();
    if base >= total {
        return Vec::new();
    }
    let remaining = unsafe { core::slice::from_raw_parts(mem_base(mem).add(base), total - base) };
    let end = remaining.iter().position(|&b| b == 0).unwrap_or(remaining.len());
    remaining[..end].to_vec()
}

/// Walk a NULL-terminated array of 4-byte LE guest pointers (`execve`'s
/// `argv`/`envp` — native wasm32 guests only, per this file's module doc
/// comment) starting at `arr_ptr`, reading each entry via
/// [`read_guest_cstring`]. Bounded by `max` entries, mirroring the Node
/// reference host's `readStringArrayFromProcess`'s
/// `PROCESS_STARTUP_MAX_ARGV_COUNT` ceiling (`host/src/kernel-
/// worker.ts:23781`), so a malformed or unterminated array cannot walk
/// memory (or grow the returned `Vec`) without bound.
///
/// Returns `Err(-E2BIG)` — the same "-errno" convention every kernel-call
/// result in this file already uses (`token < 0`, `commit < 0`, ...), so
/// callers can uniformly do `-err` to get a positive errno for
/// `complete_channel`/`fail_spawn`-style completion — if the array holds
/// more than `max` non-null entries before a NULL terminator, or
/// `Err(-EFAULT)` if the pointer-array scan itself would run past the end of
/// guest memory before finding one. `arr_ptr == 0` is the documented "no
/// array" case (matching `posix_spawn`'s/`execve`'s own NULL-argv/envp
/// convention) and returns an empty `Vec`, not an error.
fn read_guest_string_array(mem: &SharedMemory, arr_ptr: u32, max: usize) -> Result<Vec<Vec<u8>>, i32> {
    if arr_ptr == 0 {
        return Ok(Vec::new());
    }
    let total = mem.data().len();
    let mut out = Vec::new();
    let mut cursor = arr_ptr as usize;
    loop {
        if cursor.checked_add(4).is_none_or(|end| end > total) {
            return Err(-libc_errno::EFAULT);
        }
        let entry = unsafe { read_u32(mem, cursor) };
        if entry == 0 {
            return Ok(out);
        }
        if out.len() >= max {
            return Err(-libc_errno::E2BIG);
        }
        out.push(read_guest_cstring(mem, entry));
        cursor += 4;
    }
}

/// Grow `mem` so byte `end_addr` is accessible, mirroring the TS host's
/// `growMemoryToCover`. Returns an error if the shared memory cannot grow that
/// far (a truthful capacity boundary, never a silent short mapping).
fn grow_to_cover(mem: &SharedMemory, end_addr: usize) -> anyhow::Result<()> {
    let required_pages = end_addr.div_ceil(WASM_PAGE_SIZE) as u64;
    let current_pages = mem.size();
    if required_pages > current_pages {
        mem.grow(required_pages - current_pages)
            .map_err(|e| anyhow::anyhow!("guest memory.grow to {required_pages} pages failed: {e}"))?;
    }
    Ok(())
}

/// The pointer-arg descriptors the native marshaller uses for `syscall_nr`.
///
/// Most come from the authoritative `SYSCALL_ARG_DESCRIPTORS`. The epoll
/// syscalls are the exception: they carry pointer args but have no table entry
/// because the browser/Node host special-cases epoll rather than using the
/// generic descriptor path. The kernel dispatch (crates/kernel/src/wasm_api.rs)
/// still reads epoll_ctl's event at arg3 and epoll_pwait's events array at arg1
/// from the channel scratch, so the native host must stage them itself. The
/// `epoll_event` record is 16 bytes (events: u32 @0, data: u64 @8).
fn arg_descriptors(syscall_nr: u32) -> Vec<SyscallArgDesc> {
    use wasm_posix_shared::abi::extended_syscalls as ext;

    fn desc(
        arg_index: u8,
        direction: SyscallArgDirection,
        size: SyscallArgSize,
        nullable: bool,
    ) -> SyscallArgDesc {
        SyscallArgDesc {
            arg_index,
            direction,
            size,
            nullable,
            required: !nullable,
            copy_out_length: None,
        }
    }

    if syscall_nr == ext::SYS_EPOLL_CTL {
        return vec![desc(3, SyscallArgDirection::In, SyscallArgSize::Fixed { size: 16 }, false)];
    }
    if syscall_nr == ext::SYS_EPOLL_PWAIT {
        return vec![
            // events array [out], sized maxevents (arg2) * 16 bytes.
            desc(
                1,
                SyscallArgDirection::Out,
                SyscallArgSize::Arg { arg_index: 2, multiplier: 16, add: 0 },
                false,
            ),
            // optional sigmask [in], 8 bytes; NULL (skipped) for plain epoll_wait.
            desc(4, SyscallArgDirection::In, SyscallArgSize::Fixed { size: 8 }, true),
        ];
    }
    SYSCALL_ARG_DESCRIPTORS
        .iter()
        .find(|d| d.syscall_number == syscall_nr)
        .map(|d| d.args.to_vec())
        .unwrap_or_default()
}

/// One pointer buffer the host staged into the kernel scratch for a RAW syscall.
struct StagedArg {
    /// The original guest-memory address of the buffer.
    guest_ptr: usize,
    /// Byte offset of the staged copy within the scratch DATA region.
    data_off: usize,
    len: usize,
    /// Whether the kernel writes results here that must be copied back to the
    /// guest after the call (`Out`/`InOut`).
    copy_back: bool,
}

/// The imported shared kernel memory the pump reads/writes scratch through.
fn new_shared(engine: &Engine, min: u32, max: u32) -> anyhow::Result<SharedMemory> {
    Ok(SharedMemory::new(engine, MemoryType::shared(min, max))?)
}

/// The guest's launch environment: argv and environment variables, encoded as
/// raw UTF-8 bytes (no NUL terminator — the guest CRT appends its own,
/// mirroring `host/src/worker-main.ts`'s `encodeStartupMetadata`), plus any
/// explicit native-directory mounts (N1-I1b).
#[derive(Debug, Clone, Default)]
pub struct GuestOptions {
    /// `argv[0]`, `argv[1]`, ... delivered via `kernel_get_argc`/`kernel_argv_read`.
    /// Empty means `argc == 0`, which the guest CRT's historical "a.out"
    /// fallback serves (see `libc/musl-overlay/crt/crt1.c`).
    pub argv: Vec<String>,
    /// `NAME=value` entries delivered via `kernel_environ_count`/`kernel_environ_get`.
    pub env: Vec<String>,
    /// Explicit native host-directory mounts, at parity with Node's
    /// `extraMounts`. Empty (the default) keeps the guest fully sandboxed —
    /// no real host directory is ever reachable — matching T1's behavior
    /// exactly.
    pub mounts: Vec<NativeMount>,
    /// An in-memory base VFS image (N1-I2) to load into the rootfs overlay's
    /// `/` before rootfs authority is enabled. `None` (the default) keeps
    /// N1-I1a's behavior exactly: the overlay's `/` starts and stays empty,
    /// with no manifest loaded and the `host_blob_read` import unreachable.
    pub base_image: Option<BaseImage>,
}

/// Boot the real `kernel.wasm` and run `guest_wasm` to completion through the
/// real channel, with `options` controlling its argv/env, mounts, and base
/// image. Before dispatch, it enables the in-kernel rootfs overlay (`/`) and
/// tmpfs (`/tmp`). With `options.base_image == None` (the default), no
/// manifest is loaded and no blob is ever reachable, so the guest gets a
/// **sandboxed in-memory VFS** (N1-I1a) — writable, but backed by nothing on
/// the host filesystem. With `options.base_image == Some(..)` (N1-I2), that
/// image's RTFS manifest is loaded into the overlay before rootfs authority
/// is enabled, so `/` starts with real base-file content instead, served
/// through `host_blob_read` from the image's blob map. `host_fetch_archive`
/// and the host-FS `host_open` family are never called for any path the
/// overlay still owns (see `define_kernel_host_imports`). `options.mounts`
/// (N1-I1b, empty by default) opts specific top-level subtrees back into the
/// real host filesystem via the rootfs foreign-prefix mechanism — the only
/// way to reach it. Returns the guest's exit code, captured stdout/stderr,
/// and the syscall trace.
pub fn run_guest(
    kernel_wasm: &Path,
    guest_wasm: &[u8],
    options: &GuestOptions,
) -> anyhow::Result<RunOutcome> {
    let engine = crate::kernel_engine()?;

    // --- Guest module, layout, and memory (created first so kernel host imports
    // that touch process memory — e.g. host_futex_wake — can reference it) -----
    let guest_module = Module::new(&engine, guest_wasm)?;
    let (guest_mem, layout) = compute_guest_memory(&engine, &guest_module)?;

    // --- Kernel instance (this thread owns it and the pump) -----------------
    let kernel_module = Module::from_file(&engine, kernel_wasm)?;
    let kernel_mem = new_shared(&engine, KERNEL_MEMORY_MIN_PAGES, KERNEL_MEMORY_MAX_PAGES)?;
    let captured = Arc::new(Mutex::new(CapturedIo::default()));

    // fd 0 (stdin) always; real host-directory access only for the mounts
    // `options.mounts` names (empty by default — T1's sandboxed path).
    let fs = Arc::new(HostFs::new(&options.mounts));

    // N1-I2: the base-image blob map `host_blob_read` serves reads from,
    // populated from `options.base_image` when the caller supplies one.
    // Empty (the default, `options.base_image == None`) keeps the import
    // live but unreachable, exactly like N1-I1a: with no manifest loaded, the
    // overlay has no `BaseRegular` entries to read.
    let base_blobs: Arc<BTreeMap<u64, Vec<u8>>> = Arc::new(
        options
            .base_image
            .as_ref()
            .map(|image| image.blobs.clone())
            .unwrap_or_default(),
    );

    // N1-I3a Task 2: the "current process memory" cell `host_futex_wake`
    // routes through (see its doc comment). Starts pointed at the FIRST
    // process's memory — correct until the pump binds it to a different
    // process ahead of a `kernel_handle_channel` call.
    let current_memory: Arc<Mutex<SharedMemory>> = Arc::new(Mutex::new(guest_mem.clone()));
    // N1-I3a Task 3: the "current pid" cell `host_waitpid` reads to learn
    // which process is calling it (see its doc comment) — the exact same
    // out-of-band pattern as `current_memory` above, set alongside it by
    // `bind_and_dispatch`. `0` is a placeholder never read before the first
    // real dispatch (the boot process's own pid is not known yet at this
    // point in `run_guest`).
    let current_pid: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
    // N1-I3a Task 3: host-side waitpid bookkeeping (`host_waitpid`'s doc
    // comment) — populated below (the boot process) and by `handle_spawn`/
    // `run_pump`'s exit-commit branch.
    let wait_table: Arc<Mutex<WaitTable>> = Arc::new(Mutex::new(WaitTable::default()));

    let mut kernel_store = Store::new(&engine, ());
    let mut klinker: Linker<()> = Linker::new(&engine);
    klinker.define(&mut kernel_store, "env", "memory", kernel_mem.clone())?;
    define_kernel_host_imports(
        &mut klinker,
        &kernel_mem,
        &captured,
        &fs,
        &current_memory,
        &base_blobs,
        &current_pid,
        &wait_table,
    )?;
    // Everything else the kernel imports (the ~77 unused host_* capabilities)
    // traps: a trivial no-VFS program touches none of them, and a trap is a
    // truthful boundary that surfaces any surprise syscall loudly.
    klinker.define_unknown_imports_as_traps(&kernel_module)?;
    let kernel = klinker.instantiate(&mut kernel_store, &kernel_module)?;

    let abi = kernel
        .get_typed_func::<(), i32>(&mut kernel_store, "__abi_version")?
        .call(&mut kernel_store, ())?;
    if abi != crate::EXPECTED_ABI_VERSION {
        anyhow::bail!("kernel __abi_version {abi} != expected {}", crate::EXPECTED_ABI_VERSION);
    }

    // Typed handles to the kernel exports the pump drives.
    let alloc_scratch = kernel.get_typed_func::<u32, i32>(&mut kernel_store, "kernel_alloc_scratch")?;
    let create_process = kernel
        .get_typed_func::<(u32, u32, u32), i32>(&mut kernel_store, "kernel_create_process_with_stdio")?;
    let set_brk_base = kernel.get_typed_func::<(u32, i32), i32>(&mut kernel_store, "kernel_set_brk_base")?;
    let set_mmap_base = kernel.get_typed_func::<(u32, i32), i32>(&mut kernel_store, "kernel_set_mmap_base")?;
    let set_max_addr = kernel.get_typed_func::<(u32, i32), i32>(&mut kernel_store, "kernel_set_max_addr")?;
    let set_current_tid = kernel.get_typed_func::<(u32, u32), i32>(&mut kernel_store, "kernel_set_current_tid")?;
    let handle_channel =
        kernel.get_typed_func::<(i32, u32, u32, i64), i32>(&mut kernel_store, "kernel_handle_channel")?;
    let get_exit_status = kernel.get_typed_func::<u32, i32>(&mut kernel_store, "kernel_get_process_exit_status")?;
    // The blocking-retry protocol: on EAGAIN the host asks for a retry token,
    // re-dispatches under it, and releases it when the op completes.
    let blocking_retry_token =
        kernel.get_typed_func::<(u32, u32, u32), i64>(&mut kernel_store, "kernel_blocking_retry_token")?;
    let blocking_retry_release =
        kernel.get_typed_func::<(u32, u32, i64), i32>(&mut kernel_store, "kernel_blocking_retry_release")?;
    // A worker thread's exit routes here (not the process-exit path), returning
    // the thread's clear-child-tid pointer for the pump to clear + notify.
    let thread_exit =
        kernel.get_typed_func::<(u32, u32), i64>(&mut kernel_store, "kernel_thread_exit")?;
    // The sandboxed in-memory VFS toggles (crates/kernel/src/wasm_api.rs). No
    // manifest is loaded and no blob/archive provider is installed here — see
    // the call site below.
    let set_rootfs_now =
        kernel.get_typed_func::<(u32, u32, u32), i32>(&mut kernel_store, "kernel_set_rootfs_now")?;
    let set_tmpfs_enabled =
        kernel.get_typed_func::<i32, i32>(&mut kernel_store, "kernel_set_tmpfs_enabled")?;
    let set_rootfs_enabled =
        kernel.get_typed_func::<i32, i32>(&mut kernel_store, "kernel_set_rootfs_enabled")?;
    // N1-I1b: register any explicit native-directory mounts as rootfs foreign
    // prefixes, so the overlay disowns them (see the call site below).
    let set_foreign_prefixes = kernel
        .get_typed_func::<(i32, u32), i32>(&mut kernel_store, "kernel_rootfs_set_foreign_prefixes")?;
    // N1-I2: replace the overlay's (empty) base layer from `options.base_image`'s
    // RTFS manifest, if one was supplied (see the call site below).
    let rootfs_load_manifest = kernel
        .get_typed_func::<(i32, u32), i32>(&mut kernel_store, "kernel_rootfs_load_manifest")?;
    // N1-I3a Task 2: posix_spawn. `kernel_spawn_process` parses the raw
    // wire blob and builds the child Process; `kernel_spawn_blob_decode`
    // decodes the SAME blob shape into the host-private argv/envp read-back
    // framing (so this host never re-implements the `posix_spawn` guest
    // ABI); `kernel_publish_spawn_child` records the parent/child edge once
    // the child is fully launched (see `handle_spawn`).
    let spawn_process =
        kernel.get_typed_func::<(u32, u32, i32, i32), i32>(&mut kernel_store, "kernel_spawn_process")?;
    let spawn_blob_decode =
        kernel.get_typed_func::<(i32, i32, i32), i32>(&mut kernel_store, "kernel_spawn_blob_decode")?;
    let publish_spawn_child =
        kernel.get_typed_func::<(u32, u32), i32>(&mut kernel_store, "kernel_publish_spawn_child")?;
    // The rollback seam for a `kernel_publish_spawn_child` `-ECHILD`
    // rejection (see `handle_spawn`): the child's Process record still
    // exists unpublished and must be removed by the host.
    let remove_process = kernel.get_typed_func::<u32, i32>(&mut kernel_store, "kernel_remove_process")?;
    // N1-I3b Task 1: the exec-target authority `handle_spawn` uses to source
    // the spawned child's program bytes from the in-kernel VFS instead of a
    // host-side program map. `kernel_spawn_exec_target_prepare` resolves
    // `path` against the CHILD's namespace (X_OK) and retains an exact
    // executable object, returning an opaque token; `kernel_exec_target_size`/
    // `kernel_exec_target_read` stream that target's bytes into kernel
    // scratch memory; `kernel_spawn_exec_commit` records the child's initial
    // image once every byte has been read back (see `read_exec_target_bytes`
    // and its call site in `handle_spawn`). `kernel_exec_target_cancel` is
    // the rollback seam for a prepared-but-not-committed target. N1-I3b Task 2
    // calls it on the failure/rollback matrix's target-retained branches (a
    // read/compile failure after `prepare` succeeded, and — best-effort,
    // since the kernel's own `take` inside `kernel_spawn_exec_commit` usually
    // consumes the token before validation fails — a `commit` failure too);
    // Task 1's happy path and a `prepare` failure itself never call it (no
    // token exists yet in the latter case).
    let spawn_exec_target_prepare = kernel.get_typed_func::<(u32, u32, u32, u32), i32>(
        &mut kernel_store,
        "kernel_spawn_exec_target_prepare",
    )?;
    let exec_target_size =
        kernel.get_typed_func::<(u32, u32), i64>(&mut kernel_store, "kernel_exec_target_size")?;
    let exec_target_read = kernel.get_typed_func::<(u32, u32, u32, i32, u32, u32), i32>(
        &mut kernel_store,
        "kernel_exec_target_read",
    )?;
    let spawn_exec_commit = kernel
        .get_typed_func::<(u32, u32, u32), i32>(&mut kernel_store, "kernel_spawn_exec_commit")?;
    let exec_target_cancel =
        kernel.get_typed_func::<(u32, u32), i32>(&mut kernel_store, "kernel_exec_target_cancel")?;
    // N1-I3c Task 1: `execve` — REPLACES the calling process's image in
    // place (same pid, fresh address space, new program), never a new
    // process. Reuses the OWNER-GENERIC `exec_target_size`/`exec_target_read`/
    // `exec_target_cancel` bindings above (called with owner_pid = the
    // exec'ing pid, not a spawn child's pid), but resolves `path` against
    // THIS process's OWN namespace/credentials via `kernel_exec_target_prepare`
    // (unlike `kernel_spawn_exec_target_prepare`, which resolves against a
    // not-yet-launched spawn child) and commits the pure in-kernel POSIX
    // exec transition — cloexec fds, set-ID creds, signal reset,
    // memory-accounting reset, `clear_threads`, `exec_generation` bump — via
    // `kernel_exec_commit` instead of publishing a new child
    // (`kernel_spawn_exec_commit`). See the `SYS_EXECVE`/`SYS_EXECVEAT`
    // branches in `run_pump`/`handle_exec_common` for the full prepare ->
    // read -> compile -> commit -> swap flow.
    let exec_target_prepare = kernel.get_typed_func::<(u32, u32, i32, u32, u32, u32), i32>(
        &mut kernel_store,
        "kernel_exec_target_prepare",
    )?;
    let exec_commit =
        kernel.get_typed_func::<(u32, u32, u32), i32>(&mut kernel_store, "kernel_exec_commit")?;
    // N1-I3d Task 3: resolve a prepared target's `#!` chain in the kernel —
    // shared by BOTH `handle_exec_common` (owner = the exec'ing pid) and
    // `handle_spawn` (owner = the not-yet-launched child pid), called right
    // after `kernel_exec_target_prepare`/`kernel_spawn_exec_target_prepare`
    // succeeds and before `read_exec_target_bytes`/`Module::new`/commit — see
    // `apply_shebang`. The kernel owns ALL shebang decision logic (decode,
    // interpreter retarget, one-level nesting limit, argv-prefix assembly);
    // this host only decodes the returned record.
    let exec_target_resolve_shebang = kernel.get_typed_func::<(u32, u32, u32, u32), i64>(
        &mut kernel_store,
        "kernel_exec_target_resolve_shebang",
    )?;
    // N1-I3a Task 3: `host_waitpid`'s reap + status-encoding support.
    // `kernel_get_process_exit_signal` disambiguates `get_exit_status`'s
    // "shell-style" 128+signal encoding from a genuine 128-255 exit code
    // (see `encode_wait_status`); `kernel_reap_exited_child` releases the
    // kernel's own zombie once a parked `wait4` resolves (called by the pump
    // itself, never from inside `host_waitpid` — see its doc comment).
    let get_exit_signal =
        kernel.get_typed_func::<u32, i32>(&mut kernel_store, "kernel_get_process_exit_signal")?;
    let reap_exited_child =
        kernel.get_typed_func::<(u32, u32), i32>(&mut kernel_store, "kernel_reap_exited_child")?;

    // --- Kernel-side process setup -------------------------------------------
    // Only the pid is created here; the rest of this process's launch (scratch
    // allocation, brk/mmap/max-addr, spawning its guest thread) is
    // [`launch_process`]'s job, called below after the kernel-wide rootfs/tmpfs
    // setup — the same reusable step Task 2 will call again for a spawned
    // child's pid (created via a different kernel export, `kernel_spawn_process`).
    let pid_i = create_process.call(
        &mut kernel_store,
        (
            STDIO_KIND_HOST_PIPE as u32,
            STDIO_KIND_HOST_PIPE as u32,
            STDIO_KIND_HOST_PIPE as u32,
        ),
    )?;
    if pid_i <= 0 {
        anyhow::bail!("kernel_create_process_with_stdio returned {pid_i}");
    }
    let pid = pid_i as u32;

    // --- Sandboxed in-memory VFS: enable the overlay + tmpfs, before dispatch --
    // (N1-I1a). Publish the wall clock first (the overlay stamps mutation
    // metadata with it — see `kernel_set_rootfs_now`'s doc comment), then hand
    // scratch-mount (`/tmp`, ...) authority to the kernel. With no
    // `options.base_image` (the default), no manifest is loaded and no blob
    // provider is reachable, so the overlay's `/` starts empty and every
    // overlay-created file is stored inline (`rootfs::Entry::Regular(Vec<u8>)`)
    // — `host_blob_read`/`host_fetch_archive` are never called and
    // `host_open` is never reached for any path the overlay still owns. When
    // `options.base_image` IS supplied (N1-I2, see the call site below), its
    // manifest is loaded before rootfs authority is enabled, so `/` starts
    // with that real base tree instead, and `host_blob_read` serves its
    // `BaseRegular` entries' bytes from the blob map already wired above.
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let now_sec = now.as_secs();
    set_rootfs_now.call(
        &mut kernel_store,
        (now_sec as u32, (now_sec >> 32) as u32, now.subsec_nanos()),
    )?;
    set_tmpfs_enabled.call(&mut kernel_store, 1)?;
    // N1-I2: load `options.base_image`'s manifest into the overlay, mirroring
    // `kernel-worker.ts`'s `#maybeLoadKernelRootfs` ordering (publish the wall
    // clock, THEN load the manifest, THEN register foreign prefixes, THEN
    // enable rootfs authority). `options.base_image` is `None` by default, so
    // this block is skipped entirely and the overlay's `/` stays empty exactly
    // like N1-I1a. The manifest bytes are staged into a fresh KERNEL-memory
    // scratch allocation (the main channel scratch allocated above is a
    // distinct, already-spoken-for region), then handed to
    // `kernel_rootfs_load_manifest` — the same alloc-then-write-then-call
    // pattern the foreign-prefixes block below uses.
    if let Some(base_image) = &options.base_image {
        let manifest_len = base_image.manifest.len() as u32;
        let manifest_ptr = alloc_scratch.call(&mut kernel_store, manifest_len)?;
        if manifest_ptr <= 0 {
            anyhow::bail!(
                "kernel_alloc_scratch({manifest_len}) for the base image manifest returned {manifest_ptr}"
            );
        }
        unsafe { write_bytes(&kernel_mem, manifest_ptr as u32 as usize, &base_image.manifest) };
        let loaded = rootfs_load_manifest.call(&mut kernel_store, (manifest_ptr, manifest_len))?;
        if loaded < 0 {
            // Malformed manifest: leave `/` empty (the N1-I1a default) rather
            // than proceed with a partial tree — a truthful failure, mirroring
            // `#maybeLoadKernelRootfs`'s early return on a negative `load()`
            // result. `kernel_rootfs_load_manifest`/`rootfs::load_manifest`
            // already reset the overlay to empty on this path, so nothing
            // further to undo here.
            eprintln!(
                "[host-native] kernel_rootfs_load_manifest({manifest_len} bytes) failed: {loaded}; \
                 leaving / empty"
            );
        }
    }
    // N1-I1b: register `options.mounts`' VFS paths as rootfs foreign prefixes
    // BEFORE enabling rootfs authority (`kernel_rootfs_set_foreign_prefixes`'s
    // doc comment requires this ordering), so the overlay never claims those
    // subtrees in the first place. The prefixes are NUL-separated bytes staged
    // into the KERNEL's own memory (the export's `ptr` is a kernel-memory
    // address, like every other kernel export pointer argument) via a second
    // `kernel_alloc_scratch` allocation — the main channel scratch allocated
    // above is a distinct, already-spoken-for region. Empty `options.mounts`
    // (the default) skips this entirely, leaving the overlay as the sole `/`
    // authority exactly like T1.
    if !options.mounts.is_empty() {
        let mut prefixes = Vec::new();
        for mount in &options.mounts {
            // Register the SAME normalized path `HostFs::new` derives from
            // `mount.mount_point` (see `normalize_mount_point`), so the
            // overlay disowns exactly the subtree `HostFs` serves. Using the
            // raw `mount_point` here would silently diverge from `HostFs` for
            // a non-canonical value (e.g. `"host"` with no leading slash is
            // dropped entirely by `kernel_rootfs_set_foreign_prefixes`, since
            // it ignores non-absolute prefixes) even though `HostFs` still
            // serves it at `/host`.
            prefixes.extend_from_slice(normalize_mount_point(&mount.mount_point).as_bytes());
            prefixes.push(0);
        }
        let prefixes_ptr = alloc_scratch.call(&mut kernel_store, prefixes.len() as u32)?;
        if prefixes_ptr <= 0 {
            anyhow::bail!(
                "kernel_alloc_scratch({}) for foreign prefixes returned {prefixes_ptr}",
                prefixes.len()
            );
        }
        unsafe { write_bytes(&kernel_mem, prefixes_ptr as u32 as usize, &prefixes) };
        let n = set_foreign_prefixes.call(&mut kernel_store, (prefixes_ptr, prefixes.len() as u32))?;
        if n < 0 {
            anyhow::bail!("kernel_rootfs_set_foreign_prefixes failed: {n}");
        }
    }
    set_rootfs_enabled.call(&mut kernel_store, 1)?;

    // --- Guest instance on its own OS thread --------------------------------
    // Records the status the guest requests if it ever calls the `kernel_exit`
    // import directly (the SIGKILL fast-path); the normal exit path is
    // `SYS_exit_group` over the channel, handled by the pump.
    let import_exit_status = Arc::new(Mutex::new(None::<i32>));
    let launch_argv: Arc<Vec<Vec<u8>>> =
        Arc::new(options.argv.iter().map(|s| s.as_bytes().to_vec()).collect());
    let launch_env: Arc<Vec<Vec<u8>>> =
        Arc::new(options.env.iter().map(|s| s.as_bytes().to_vec()).collect());
    let process = launch_process(
        &engine,
        &mut kernel_store,
        &alloc_scratch,
        &set_brk_base,
        &set_mmap_base,
        &set_max_addr,
        guest_module,
        guest_mem,
        layout,
        pid,
        import_exit_status.clone(),
        launch_argv,
        launch_env,
    )?;
    let mut processes = vec![process];
    // N1-I3a Task 3: the boot process's ppid is the sentinel `0` — never a
    // real pid, so the boot process itself can never be `waitpid`'d (nothing
    // above it exists in this host's process model).
    wait_table.lock().unwrap().parent_of.insert(pid, 0);

    // --- The channel pump ---------------------------------------------------
    let mut syscall_trace = Vec::new();
    let exit_code = run_pump(
        &mut kernel_store,
        &engine,
        &kernel_mem,
        &mut processes,
        &set_current_tid,
        &handle_channel,
        &get_exit_status,
        &get_exit_signal,
        &blocking_retry_token,
        &blocking_retry_release,
        &thread_exit,
        &alloc_scratch,
        &set_brk_base,
        &set_mmap_base,
        &set_max_addr,
        &spawn_process,
        &spawn_blob_decode,
        &publish_spawn_child,
        &remove_process,
        &reap_exited_child,
        &spawn_exec_target_prepare,
        &exec_target_size,
        &exec_target_read,
        &spawn_exec_commit,
        &exec_target_cancel,
        &exec_target_prepare,
        &exec_commit,
        &exec_target_resolve_shebang,
        &current_memory,
        &current_pid,
        &wait_table,
        &mut syscall_trace,
    )?;

    let io = captured.lock().unwrap();
    Ok(RunOutcome {
        exit_code,
        stdout: io.stdout.clone(),
        stderr: io.stderr.clone(),
        syscall_trace,
    })
}

/// [`run_guest`] with no argv/env (`argc == 0`, the guest CRT's historical
/// "a.out" fallback). Kept for the pre-N1-I1a fixtures/tests that predate
/// caller-supplied launch metadata and never touch argv/env.
pub fn run_trivial_guest(kernel_wasm: &Path, guest_wasm: &[u8]) -> anyhow::Result<RunOutcome> {
    run_guest(kernel_wasm, guest_wasm, &GuestOptions::default())
}

// --- N1-I2: in-memory base VFS image (RTFS manifest + blob map) ------------
//
// N1-I1 enables an EMPTY in-kernel rootfs overlay `/` (no manifest, no blob
// provider — see `run_guest`'s "Sandboxed in-memory VFS" section above). N1-I2
// lets the native host serve REAL base-file content instead: it builds a
// small in-memory tree, emits it as an RTFS-v3 manifest (the exact wire format
// `crates/runtime-core/src/rootfs.rs`'s `load_manifest` parses, mirroring the
// host-side encoder `host/src/vfs/rootfs-manifest.ts`'s `emitRootfsManifest`),
// and wires the `host_blob_read` import (below) to serve file bytes from an
// in-memory `blob_id -> Vec<u8>` map, where `blob_id == ino` for a file (the
// same convention `rootfs-manifest.ts` documents). Task 1 built the
// manifest/map and wired the import; Task 2 threads a `BaseImage` through
// `GuestOptions.base_image` and loads it at boot (see `run_guest`) via
// `kernel_rootfs_load_manifest`, before rootfs authority is enabled.

/// RTFS wire-format magic ("RTFS" little-endian) and version this builder
/// emits. Must match `MANIFEST_MAGIC`/`MANIFEST_VERSION_V3` in
/// `crates/runtime-core/src/rootfs.rs` and `RTFS_MAGIC`/`RTFS_VERSION` in
/// `host/src/vfs/rootfs-manifest.ts`.
pub const RTFS_MAGIC: u32 = 0x5346_5452;
pub const RTFS_VERSION: u32 = 3;

/// RTFS entry `kind` byte values the kernel parser understands
/// (`rootfs.rs::load_manifest_inner`). This builder only ever emits
/// `RTFS_KIND_DIR`/`RTFS_KIND_FILE` — a small hand-built base image has no
/// symlinks or lazy (archive-backed) files; those two kinds are out of scope
/// for N1-I2 (deferred, not silently unsupported: the kernel parser still
/// understands kind 3/4, this builder just never emits them).
const RTFS_KIND_DIR: u8 = 1;
const RTFS_KIND_FILE: u8 = 2;

/// One directory or regular-file entry in a small, hand-built base tree.
/// `contents: None` is a directory; `Some(bytes)` is a regular file whose
/// `blob_id` (in the emitted manifest) equals `ino`, per the shared
/// "`blob_id = ino`" convention (see `host/src/vfs/rootfs-manifest.ts`'s
/// module doc comment).
#[derive(Debug, Clone)]
pub struct BaseEntrySpec {
    /// Absolute, kernel-facing path (e.g. `"/"`, `"/etc"`, `"/etc/hello"`).
    pub path: String,
    pub ino: u64,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub mtime_sec: u64,
    pub mtime_nsec: u32,
    /// `None` for a directory; `Some(bytes)` for a regular file's content.
    pub contents: Option<Vec<u8>>,
}

impl BaseEntrySpec {
    /// A directory entry (uid/gid/mtime all zero — a caller needing specific
    /// ownership or timestamps constructs the struct directly).
    pub fn dir(path: impl Into<String>, ino: u64, mode: u32) -> Self {
        Self { path: path.into(), ino, mode, uid: 0, gid: 0, mtime_sec: 0, mtime_nsec: 0, contents: None }
    }

    /// A regular-file entry (uid/gid/mtime all zero).
    pub fn file(path: impl Into<String>, ino: u64, mode: u32, contents: Vec<u8>) -> Self {
        Self {
            path: path.into(),
            ino,
            mode,
            uid: 0,
            gid: 0,
            mtime_sec: 0,
            mtime_nsec: 0,
            contents: Some(contents),
        }
    }
}

/// An in-memory base VFS image: an RTFS-v3 manifest plus the `blob_id -> file
/// bytes` map its file entries reference. Built entirely in memory from a
/// small hand-written tree spec — never from `rootfs.vfs`/SFFS
/// (`crates/runtime-core/src/sffs.rs`), which stays out of scope for N1-I2.
#[derive(Debug, Clone, Default)]
pub struct BaseImage {
    /// The RTFS-v3 buffer, ready for `kernel_rootfs_load_manifest`.
    pub manifest: Vec<u8>,
    /// `blob_id (== ino for a file) -> file content`, the map `host_blob_read`
    /// (below) serves reads from.
    pub blobs: BTreeMap<u64, Vec<u8>>,
}

/// Build a `BaseImage` from `entries`. `entries` MUST be parent-first (a
/// directory's entry before any of its children) — the same pre-order-walk
/// invariant `emitRootfsManifest` guarantees by construction; this builder
/// trusts the caller's order instead of re-deriving it from paths, since
/// N1-I2's images are small and hand-built (never walked from a real
/// filesystem).
///
/// Emits exactly the wire format `rootfs.rs::load_manifest_inner` parses:
/// header (`magic`/`version`/`entry_count`), per entry
/// `kind/mode/uid/gid/ino/blob_id/size/mtime_sec/mtime_nsec/path[/target]`
/// (`target_len` always 0 — this builder emits no symlinks), and a trailing
/// archive table (`archive_count = 0` — no lazy archives in this builder's
/// scope).
pub fn build_base_image(entries: &[BaseEntrySpec]) -> BaseImage {
    let mut buf = Vec::new();
    buf.extend_from_slice(&RTFS_MAGIC.to_le_bytes());
    buf.extend_from_slice(&RTFS_VERSION.to_le_bytes());
    buf.extend_from_slice(&(entries.len() as u32).to_le_bytes());

    let mut blobs = BTreeMap::new();
    for e in entries {
        let (kind, blob_id, size) = match &e.contents {
            None => (RTFS_KIND_DIR, 0u64, 0u64),
            Some(bytes) => (RTFS_KIND_FILE, e.ino, bytes.len() as u64),
        };
        buf.push(kind);
        // Mask to the permission bits, mirroring `emitRootfsManifest`'s
        // `mode & 0o7777` (`host/src/vfs/rootfs-manifest.ts`). The kernel
        // re-masks on insert (`insert_base_dir`/`insert_base_file`) either
        // way, but masking here removes a footgun for a caller that passes
        // a raw `std::fs::Metadata::mode()` (which carries `S_IFMT` file-type
        // bits) straight through.
        buf.extend_from_slice(&(e.mode & 0o7777).to_le_bytes());
        buf.extend_from_slice(&e.uid.to_le_bytes());
        buf.extend_from_slice(&e.gid.to_le_bytes());
        buf.extend_from_slice(&e.ino.to_le_bytes());
        buf.extend_from_slice(&blob_id.to_le_bytes());
        buf.extend_from_slice(&size.to_le_bytes());
        buf.extend_from_slice(&e.mtime_sec.to_le_bytes());
        buf.extend_from_slice(&e.mtime_nsec.to_le_bytes());
        let path_bytes = e.path.as_bytes();
        buf.extend_from_slice(&(path_bytes.len() as u32).to_le_bytes());
        buf.extend_from_slice(path_bytes);
        buf.extend_from_slice(&0u32.to_le_bytes()); // target_len = 0: no symlinks.
        if let Some(bytes) = &e.contents {
            blobs.insert(e.ino, bytes.clone());
        }
    }
    // Trailing archive table: always present in v3, empty (no lazy archives
    // in this builder's scope).
    buf.extend_from_slice(&0u32.to_le_bytes());

    BaseImage { manifest: buf, blobs }
}

#[cfg(test)]
mod base_image_tests {
    use super::*;

    /// One RTFS entry as parsed back by `parse_rtfs` below.
    struct ParsedEntry {
        kind: u8,
        #[allow(dead_code)]
        mode: u32,
        #[allow(dead_code)]
        uid: u32,
        #[allow(dead_code)]
        gid: u32,
        ino: u64,
        blob_id: u64,
        size: u64,
        #[allow(dead_code)]
        mtime_sec: u64,
        #[allow(dead_code)]
        mtime_nsec: u32,
        path: String,
        #[allow(dead_code)]
        target: Vec<u8>,
    }

    /// A from-scratch RTFS-v3 reader, deliberately independent of both
    /// `build_base_image`'s writer above and `rootfs.rs::load_manifest`'s
    /// parser, so this test locks the wire format on its own terms (mirrors
    /// the brief's instruction to verify the format "independent of the
    /// kernel"). Panics on any malformed input — test-only, not
    /// production-hardened.
    fn parse_rtfs(buf: &[u8]) -> (u32, u32, Vec<ParsedEntry>, u32) {
        let mut pos = 0usize;
        fn u8_at(buf: &[u8], pos: &mut usize) -> u8 {
            let v = buf[*pos];
            *pos += 1;
            v
        }
        fn u32_at(buf: &[u8], pos: &mut usize) -> u32 {
            let v = u32::from_le_bytes(buf[*pos..*pos + 4].try_into().unwrap());
            *pos += 4;
            v
        }
        fn u64_at(buf: &[u8], pos: &mut usize) -> u64 {
            let v = u64::from_le_bytes(buf[*pos..*pos + 8].try_into().unwrap());
            *pos += 8;
            v
        }
        let magic = u32_at(buf, &mut pos);
        let version = u32_at(buf, &mut pos);
        let count = u32_at(buf, &mut pos);
        let mut entries = Vec::new();
        for _ in 0..count {
            let kind = u8_at(buf, &mut pos);
            let mode = u32_at(buf, &mut pos);
            let uid = u32_at(buf, &mut pos);
            let gid = u32_at(buf, &mut pos);
            let ino = u64_at(buf, &mut pos);
            let blob_id = u64_at(buf, &mut pos);
            let size = u64_at(buf, &mut pos);
            let mtime_sec = u64_at(buf, &mut pos);
            let mtime_nsec = u32_at(buf, &mut pos);
            let path_len = u32_at(buf, &mut pos) as usize;
            let path = String::from_utf8(buf[pos..pos + path_len].to_vec()).unwrap();
            pos += path_len;
            let target_len = u32_at(buf, &mut pos) as usize;
            let target = buf[pos..pos + target_len].to_vec();
            pos += target_len;
            entries.push(ParsedEntry {
                kind,
                mode,
                uid,
                gid,
                ino,
                blob_id,
                size,
                mtime_sec,
                mtime_nsec,
                path,
                target,
            });
        }
        let archive_count = u32_at(buf, &mut pos);
        assert_eq!(pos, buf.len(), "trailing bytes after the (empty) archive table");
        (magic, version, entries, archive_count)
    }

    #[test]
    fn build_base_image_round_trips_a_tiny_tree() {
        let image = build_base_image(&[
            BaseEntrySpec::dir("/", 1, 0o755),
            BaseEntrySpec::dir("/etc", 2, 0o755),
            BaseEntrySpec::file("/etc/hello", 3, 0o644, b"hi from base\n".to_vec()),
        ]);

        // Header bytes, checked directly first (the brief's exact assertion).
        assert_eq!(&image.manifest[0..4], &RTFS_MAGIC.to_le_bytes(), "magic");
        assert_eq!(&image.manifest[4..8], &RTFS_VERSION.to_le_bytes(), "version");
        assert_eq!(&image.manifest[8..12], &3u32.to_le_bytes(), "entry count");

        let (magic, version, entries, archive_count) = parse_rtfs(&image.manifest);
        assert_eq!(magic, RTFS_MAGIC);
        assert_eq!(version, RTFS_VERSION);
        assert_eq!(archive_count, 0, "no lazy archives in this builder's scope");
        assert_eq!(entries.len(), 3);

        assert_eq!(entries[0].kind, RTFS_KIND_DIR);
        assert_eq!(entries[0].path, "/");
        assert_eq!(entries[0].ino, 1);

        assert_eq!(entries[1].kind, RTFS_KIND_DIR);
        assert_eq!(entries[1].path, "/etc");
        assert_eq!(entries[1].ino, 2);

        assert_eq!(entries[2].kind, RTFS_KIND_FILE);
        assert_eq!(entries[2].path, "/etc/hello");
        assert_eq!(entries[2].ino, 3);
        assert_eq!(entries[2].blob_id, entries[2].ino, "blob_id must equal ino for a file");
        assert_eq!(entries[2].size, 13);

        assert_eq!(
            image.blobs.get(&3).map(Vec::as_slice),
            Some(b"hi from base\n".as_slice()),
            "the blob map must be keyed by ino for a file"
        );
    }

    /// Task-1-review fix: a caller that passes a raw `mode` carrying `S_IFMT`
    /// file-type bits (e.g. straight from `std::fs::Metadata::mode()`) must
    /// not have those bits leak into the emitted manifest — `build_base_image`
    /// must mask to `& 0o7777` itself, mirroring `emitRootfsManifest`'s
    /// `mode & 0o7777` (`host/src/vfs/rootfs-manifest.ts`), rather than
    /// relying solely on the kernel's own re-mask on insert.
    #[test]
    fn build_base_image_masks_file_type_bits_out_of_mode() {
        const S_IFDIR: u32 = 0o040000;
        const S_IFREG: u32 = 0o100000;
        let image = build_base_image(&[
            BaseEntrySpec::dir("/", 1, S_IFDIR | 0o755),
            BaseEntrySpec::file("/hello", 2, S_IFREG | 0o644, b"hi\n".to_vec()),
        ]);

        let (_, _, entries, _) = parse_rtfs(&image.manifest);
        assert_eq!(entries[0].mode, 0o755, "directory entry mode must be masked to 0o7777");
        assert_eq!(entries[1].mode, 0o644, "file entry mode must be masked to 0o7777");
    }
}

/// Define the minimal native `host_*` capabilities the boot + trivial path
/// needs; every other host import is left to `define_unknown_imports_as_traps`.
#[allow(clippy::too_many_arguments)]
fn define_kernel_host_imports(
    linker: &mut Linker<()>,
    kernel_mem: &SharedMemory,
    captured: &Arc<Mutex<CapturedIo>>,
    fs: &Arc<HostFs>,
    current_memory: &Arc<Mutex<SharedMemory>>,
    base_blobs: &Arc<BTreeMap<u64, Vec<u8>>>,
    current_pid: &Arc<Mutex<u32>>,
    wait_table: &Arc<Mutex<WaitTable>>,
) -> anyhow::Result<()> {
    // host_futex_wake(addr, count) -> i32: wake up to `count` waiters parked on
    // the futex word at process address `addr` (in GUEST memory). musl's
    // pthread machinery and clear-child-tid use this. `addr` is a raw address
    // in WHICHEVER process the kernel is currently dispatching for — unlike
    // every other host_* import here, the kernel passes no pid, so the host
    // must track "the process currently bound via kernel_set_current_tid" out
    // of band. `current_memory` is that shared cell: the pump (`bind_and_
    // dispatch`) updates it to the dispatching channel's owning process's
    // memory immediately before every `kernel_handle_channel` call, so a
    // futex wake fired synchronously from within that call always lands on
    // the right process's `SharedMemory` (N1-I3a Task 2 — before this fix,
    // this closure permanently captured the FIRST process's memory, which
    // was harmless with exactly one process but silently wrong for any
    // futex/pthread operation a spawned child performs).
    {
        let current_memory = current_memory.clone();
        linker.func_wrap(
            "env",
            "host_futex_wake",
            move |_c: Caller<'_, ()>, addr: i32, count: i32| -> i32 {
                let n = if count < 0 { i32::MAX } else { count };
                let mem = current_memory.lock().unwrap().clone();
                mem.atomic_notify(addr as u32 as u64, n as u32)
                    .map(|woke| woke as i32)
                    .unwrap_or(0)
            },
        )?;
    }
    // host_write(handle, buf_ptr, buf_len) -> i32: route fd 1/2 to captured
    // stdout/stderr (the process was created with HostPipe stdio). buf_ptr is a
    // kernel-memory address the pump staged the bytes at.
    {
        let mem = kernel_mem.clone();
        let cap = captured.clone();
        linker.func_wrap(
            "env",
            "host_write",
            move |_c: Caller<'_, ()>, handle: i64, ptr: i32, len: i32| -> i32 {
                if len < 0 {
                    return -(libc_errno::EINVAL);
                }
                let bytes = unsafe { read_bytes(&mem, ptr as u32 as usize, len as usize) };
                let mut io = cap.lock().unwrap();
                match handle {
                    1 => io.stdout.extend_from_slice(&bytes),
                    2 => io.stderr.extend_from_slice(&bytes),
                    _ => return -(libc_errno::EBADF),
                }
                len
            },
        )?;
    }
    // host_debug_log(ptr, len): kernel diagnostics → this host's stderr.
    {
        let mem = kernel_mem.clone();
        linker.func_wrap(
            "env",
            "host_debug_log",
            move |_c: Caller<'_, ()>, ptr: i32, len: i32| {
                if len < 0 {
                    return;
                }
                let bytes = unsafe { read_bytes(&mem, ptr as u32 as usize, len as usize) };
                let mut err = std::io::stderr();
                let _ = err.write_all(b"[kernel] ");
                let _ = err.write_all(&bytes);
                let _ = err.write_all(b"\n");
            },
        )?;
    }
    // host_clock_gettime(clock_id, sec_ptr, nsec_ptr) -> i32: real wall clock.
    {
        let mem = kernel_mem.clone();
        linker.func_wrap(
            "env",
            "host_clock_gettime",
            move |_c: Caller<'_, ()>, _clock_id: i32, sec_ptr: i32, nsec_ptr: i32| -> i32 {
                let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
                unsafe {
                    write_bytes(&mem, sec_ptr as u32 as usize, &(now.as_secs() as i64).to_le_bytes());
                    write_bytes(&mem, nsec_ptr as u32 as usize, &(now.subsec_nanos() as i64).to_le_bytes());
                }
                0
            },
        )?;
    }
    // host_close(handle) -> i32: releases an open host-FS file handle if this
    // is one (only possible when a mount is configured); otherwise a no-op
    // success (the stdio HostPipes 0/1/2 need nothing released).
    {
        let fs = fs.clone();
        linker.func_wrap("env", "host_close", move |_c: Caller<'_, ()>, handle: i64| -> i32 {
            fs.files.lock().unwrap().remove(&handle);
            0
        })?;
    }
    // host_read(handle, buf_ptr, len) -> i32:
    //   - handle 0 (stdin, a HostPipe): a blocking source — EAGAIN on the
    //     first read (so the kernel blocks and the pump parks it), then one
    //     line, then EOF. This is how a real host pipe behaves when input
    //     arrives on a later poll; the call counter just makes it
    //     deterministic.
    //   - an open host-FS handle (only possible when a mount is configured):
    //     read from the real file's current OS cursor. Regular-file reads
    //     normally arrive via host_pread instead (the kernel owns their
    //     offset); this path exists for parity/defensiveness if a
    //     non-regular host-backed handle ever reaches it.
    //   - anything else: EBADF (no other host-FS handle exists).
    {
        let fs = fs.clone();
        let mem = kernel_mem.clone();
        linker.func_wrap(
            "env",
            "host_read",
            move |_c: Caller<'_, ()>, handle: i64, buf_ptr: i32, len: i32| -> i32 {
                if len < 0 {
                    return -libc_errno::EINVAL;
                }
                if handle == 0 {
                    let mut calls = fs.stdin_reads.lock().unwrap();
                    *calls += 1;
                    return match *calls {
                        1 => -libc_errno::EAGAIN, // not ready yet: block
                        2 => {
                            let n = HOST_STDIN_LINE.len().min(len as usize);
                            unsafe {
                                write_bytes(&mem, buf_ptr as u32 as usize, &HOST_STDIN_LINE[..n])
                            };
                            n as i32
                        }
                        _ => 0, // EOF
                    };
                }
                let mut files = fs.files.lock().unwrap();
                let Some(file) = files.get_mut(&handle) else {
                    return -libc_errno::EBADF;
                };
                let mut tmp = vec![0u8; len as usize];
                match file.read(&mut tmp) {
                    Ok(n) => {
                        unsafe { write_bytes(&mem, buf_ptr as u32 as usize, &tmp[..n]) };
                        n as i32
                    }
                    Err(e) => -errno_from_io(&e),
                }
            },
        )?;
    }
    // N1-I1b: real host-directory FS syscalls, wired ONLY when at least one
    // mount is configured. With no mount, these stay to
    // `define_unknown_imports_as_traps` below — a truthful boundary, since
    // the overlay claims all of `/` and the kernel's path resolution can
    // never reach them.
    if !fs.mounts.is_empty() {
        // host_lstat / host_stat(path, len, stat_ptr) -> i32: real metadata
        // from the mounted host directory tree. `lstat` does not follow a
        // final symlink; `stat` does.
        for (name, follow_final) in [("host_lstat", false), ("host_stat", true)] {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                name,
                move |_c: Caller<'_, ()>, path_ptr: i32, path_len: i32, stat_ptr: i32| -> i32 {
                    if path_len < 0 {
                        return -libc_errno::EINVAL;
                    }
                    let raw = unsafe { read_bytes(&mem, path_ptr as u32 as usize, path_len as usize) };
                    let resolved = match fs.resolve(&raw) {
                        Ok(p) => p,
                        Err(e) => return -e,
                    };
                    let meta =
                        if follow_final { fs::metadata(&resolved) } else { fs::symlink_metadata(&resolved) };
                    match meta {
                        Ok(m) => {
                            unsafe { write_wasm_stat_from_metadata(&mem, stat_ptr as u32 as usize, &m) };
                            0
                        }
                        Err(e) => -errno_from_io(&e),
                    }
                },
            )?;
        }
        // host_open(path, len, flags, mode) -> i64: open a real file (or,
        // with O_DIRECTORY, a real directory — used only for its
        // fstat/close identity; actual iteration goes through host_opendir)
        // under the mounted tree. Returns a handle or a negated errno.
        {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                "host_open",
                move |_c: Caller<'_, ()>, path_ptr: i32, path_len: i32, flags: i32, mode: i32| -> i64 {
                    if path_len < 0 {
                        return -(libc_errno::EINVAL as i64);
                    }
                    let raw = unsafe { read_bytes(&mem, path_ptr as u32 as usize, path_len as usize) };
                    let resolved = match fs.resolve(&raw) {
                        Ok(p) => p,
                        Err(e) => return -(e as i64),
                    };
                    let opts = open_options_from_flags(flags as u32, mode as u32);
                    match opts.open(&resolved) {
                        Ok(file) => {
                            let handle = fs.alloc_handle();
                            fs.files.lock().unwrap().insert(handle, file);
                            handle
                        }
                        Err(e) => -(errno_from_io(&e) as i64),
                    }
                },
            )?;
        }
        // host_pread(handle, buf_ptr, len, offset_lo, offset_hi) -> i32: the
        // kernel owns the file offset for host-backed regular files and reads
        // at an explicit position, so this is the read path that actually
        // fires (not host_read). Reads at `offset` without disturbing the
        // file's OS cursor.
        {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                "host_pread",
                move |_c: Caller<'_, ()>, handle: i64, buf_ptr: i32, len: i32, off_lo: i32, off_hi: i32| -> i32 {
                    if len < 0 {
                        return -libc_errno::EINVAL;
                    }
                    let files = fs.files.lock().unwrap();
                    let Some(file) = files.get(&handle) else {
                        return -libc_errno::EBADF;
                    };
                    let offset = combine_i64(off_lo, off_hi) as u64;
                    let mut tmp = vec![0u8; len as usize];
                    match file.read_at(&mut tmp, offset) {
                        Ok(n) => {
                            unsafe { write_bytes(&mem, buf_ptr as u32 as usize, &tmp[..n]) };
                            n as i32
                        }
                        Err(e) => -errno_from_io(&e),
                    }
                },
            )?;
        }
        // host_seek(handle, offset_lo, offset_hi, whence) -> i64: the kernel
        // owns the OFD offset for host-backed files and computes
        // SEEK_SET/SEEK_CUR's new position itself, consulting this return
        // value only for SEEK_END (where only the host knows the real file
        // size); see crates/runtime-core/src/syscalls.rs sys_lseek. So this
        // need not reposition any host-side cursor — it only has to answer
        // "what position does this offset/whence resolve to", which for
        // SEEK_SET/SEEK_CUR the caller already computed into `offset` itself.
        {
            let fs = fs.clone();
            linker.func_wrap(
                "env",
                "host_seek",
                move |_c: Caller<'_, ()>, handle: i64, off_lo: i32, off_hi: i32, whence: i32| -> i64 {
                    let files = fs.files.lock().unwrap();
                    let Some(file) = files.get(&handle) else {
                        return -(libc_errno::EBADF as i64);
                    };
                    let offset = combine_i64(off_lo, off_hi);
                    let result = if whence as u32 == SEEK_END {
                        match file.metadata() {
                            Ok(m) => (m.len() as i64).saturating_add(offset),
                            Err(e) => return -(errno_from_io(&e) as i64),
                        }
                    } else {
                        offset
                    };
                    if result < 0 {
                        -(libc_errno::EIO as i64)
                    } else {
                        result
                    }
                },
            )?;
        }
        // host_fstat(handle, stat_ptr) -> i32: real metadata for an open
        // host-FS handle (file or O_DIRECTORY-opened directory).
        {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                "host_fstat",
                move |_c: Caller<'_, ()>, handle: i64, stat_ptr: i32| -> i32 {
                    let files = fs.files.lock().unwrap();
                    let Some(file) = files.get(&handle) else {
                        return -libc_errno::EBADF;
                    };
                    match file.metadata() {
                        Ok(m) => {
                            unsafe { write_wasm_stat_from_metadata(&mem, stat_ptr as u32 as usize, &m) };
                            0
                        }
                        Err(e) => -errno_from_io(&e),
                    }
                },
            )?;
        }
        // host_readlink(path, len, buf_ptr, buf_len) -> i32: the raw symlink
        // target (not translated or re-rooted), truncated to `buf_len`,
        // matching `host_readlink` in host/src/kernel.ts.
        {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                "host_readlink",
                move |_c: Caller<'_, ()>, path_ptr: i32, path_len: i32, buf_ptr: i32, buf_len: i32| -> i32 {
                    if path_len < 0 || buf_len < 0 {
                        return -libc_errno::EINVAL;
                    }
                    let raw = unsafe { read_bytes(&mem, path_ptr as u32 as usize, path_len as usize) };
                    let resolved = match fs.resolve(&raw) {
                        Ok(p) => p,
                        Err(e) => return -e,
                    };
                    match fs::read_link(&resolved) {
                        Ok(target) => {
                            let target_bytes = target.into_os_string().into_encoded_bytes();
                            let n = target_bytes.len().min(buf_len as usize);
                            unsafe { write_bytes(&mem, buf_ptr as u32 as usize, &target_bytes[..n]) };
                            n as i32
                        }
                        Err(e) => -errno_from_io(&e),
                    }
                },
            )?;
        }
        // host_opendir(path, len) -> i64: a fresh directory-iteration handle
        // over the mounted host directory, or a negated errno.
        {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                "host_opendir",
                move |_c: Caller<'_, ()>, path_ptr: i32, path_len: i32| -> i64 {
                    if path_len < 0 {
                        return -(libc_errno::EINVAL as i64);
                    }
                    let raw = unsafe { read_bytes(&mem, path_ptr as u32 as usize, path_len as usize) };
                    let resolved = match fs.resolve(&raw) {
                        Ok(p) => p,
                        Err(e) => return -(e as i64),
                    };
                    match fs::read_dir(&resolved) {
                        Ok(rd) => {
                            let handle = fs.alloc_handle();
                            fs.dirs.lock().unwrap().insert(handle, rd);
                            handle
                        }
                        Err(e) => -(errno_from_io(&e) as i64),
                    }
                },
            )?;
        }
        // host_readdir(dir_handle, dirent_ptr, name_ptr, name_len) -> i32:
        // writes one `WasmDirent` (16 bytes: d_ino u64 @0, d_type u32 @8,
        // d_namlen u32 @12 — see crates/shared `WasmDirent`) plus the raw
        // entry name, matching `#hostReaddir` in host/src/kernel.ts. Returns 1
        // (entry written), 0 (end of directory), or a negated errno.
        //
        // A name that does not fit `name_len` fails ERANGE, but — unlike the
        // TS host's `#hostReaddir`, which buffers the oversized entry in
        // `pendingDirectoryEntries` so a larger-buffer retry sees the same
        // entry again — this call has already consumed it from
        // `std::fs::ReadDir`, which offers no peek/pushback: `rd.next()` has
        // already advanced past it by the time its name is measured. The
        // entry is silently skipped, not retried. This is a real, narrow
        // divergence from Node (a single oversized directory entry can go
        // missing from a listing), not a claim this host doesn't actually
        // meet; closing it would need a one-entry lookahead buffer, which is
        // out of scope for this increment.
        {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                "host_readdir",
                move |_c: Caller<'_, ()>, dir_handle: i64, dirent_ptr: i32, name_ptr: i32, name_len: i32| -> i32 {
                    if name_len < 0 {
                        return -libc_errno::EINVAL;
                    }
                    let mut dirs = fs.dirs.lock().unwrap();
                    let Some(rd) = dirs.get_mut(&dir_handle) else {
                        return -libc_errno::EBADF;
                    };
                    match rd.next() {
                        None => 0,
                        Some(Err(e)) => -errno_from_io(&e),
                        Some(Ok(entry)) => {
                            let name = entry.file_name().into_encoded_bytes();
                            if name.len() > name_len as usize {
                                return -libc_errno::ERANGE;
                            }
                            let d_type = match entry.file_type() {
                                Ok(ft) if ft.is_dir() => DT_DIR,
                                Ok(ft) if ft.is_file() => DT_REG,
                                Ok(ft) if ft.is_symlink() => DT_LNK,
                                _ => DT_UNKNOWN,
                            };
                            unsafe {
                                let dp = dirent_ptr as u32 as usize;
                                write_bytes(&mem, dp, &entry.ino().to_le_bytes());
                                write_bytes(&mem, dp + 8, &d_type.to_le_bytes());
                                write_bytes(&mem, dp + 12, &(name.len() as u32).to_le_bytes());
                                write_bytes(&mem, name_ptr as u32 as usize, &name);
                            }
                            1
                        }
                    }
                },
            )?;
        }
        // host_closedir(dir_handle) -> i32.
        {
            let fs = fs.clone();
            linker.func_wrap("env", "host_closedir", move |_c: Caller<'_, ()>, dir_handle: i64| -> i32 {
                fs.dirs.lock().unwrap().remove(&dir_handle);
                0
            })?;
        }
    }
    // host_blob_read(blob_id_lo, blob_id_hi, buf_ptr, buf_len, offset_lo,
    // offset_hi) -> i32 (N1-I2): the rootfs overlay's content byte-leaf read
    // for a `BaseRegular` entry loaded from a `BaseImage` manifest (see the
    // "in-memory base VFS image" section above). blob_id/offset are 64-bit
    // values split into lo/hi 32-bit words for the (JS-shaped) ABI, matching
    // `host_pread`'s offset convention — mirrors `wasm_api.rs:79-86` exactly.
    // Returns bytes written into `buf_ptr` (0 at EOF), or a negated errno:
    // ENOENT for a blob_id with no entry in the map (never expected once a
    // manifest has been loaded correctly, since every `BaseRegular` entry's
    // blob_id came from this same map — but a real, truthful boundary if it
    // ever happens). With no `BaseImage` loaded (`base_blobs` empty, T1's and
    // N1-I1's default), this import is simply never reached: the overlay has
    // no `BaseRegular` entries to read.
    {
        let mem = kernel_mem.clone();
        let blobs = base_blobs.clone();
        linker.func_wrap(
            "env",
            "host_blob_read",
            move |_c: Caller<'_, ()>,
                  blob_id_lo: u32,
                  blob_id_hi: u32,
                  buf_ptr: i32,
                  buf_len: i32,
                  offset_lo: u32,
                  offset_hi: u32|
                  -> i32 {
                if buf_len < 0 {
                    return -libc_errno::EINVAL;
                }
                let blob_id = ((blob_id_hi as u64) << 32) | (blob_id_lo as u64);
                let Some(bytes) = blobs.get(&blob_id) else {
                    return -libc_errno::ENOENT;
                };
                let offset = (((offset_hi as u64) << 32) | (offset_lo as u64)) as usize;
                if offset >= bytes.len() {
                    return 0; // EOF
                }
                let remaining = &bytes[offset..];
                let n = remaining.len().min(buf_len as usize);
                unsafe { write_bytes(&mem, buf_ptr as u32 as usize, &remaining[..n]) };
                n as i32
            },
        )?;
    }
    // host_is_thread_worker() -> i32: 0 — the single guest is the process
    // leader (tid == pid), not a pthread worker, so exit_group takes the full
    // process-exit path in commit_current_task_exit.
    linker.func_wrap("env", "host_is_thread_worker", |_c: Caller<'_, ()>| -> i32 { 0 })?;
    // host_getrandom(buf_ptr, len) -> i32: OS entropy via /dev/urandom.
    {
        let mem = kernel_mem.clone();
        linker.func_wrap(
            "env",
            "host_getrandom",
            move |_c: Caller<'_, ()>, buf_ptr: i32, len: i32| -> i32 {
                if len < 0 {
                    return -(libc_errno::EINVAL);
                }
                let mut buf = vec![0u8; len as usize];
                match File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)) {
                    Ok(()) => {
                        unsafe { write_bytes(&mem, buf_ptr as u32 as usize, &buf) };
                        len
                    }
                    Err(_) => -(libc_errno::EIO),
                }
            },
        )?;
    }
    // host_waitpid(pid, options, status_ptr) -> i32: N1-I3a Task 3. The
    // kernel's own `sys_waitpid` (`crates/runtime-core/src/syscalls.rs`)
    // delegates ENTIRELY to this import (its `_proc` parameter is unused) —
    // it never consults its own process table to pick or validate a child —
    // so this closure implements the WHOLE POSIX `waitpid` contract itself,
    // using host-side bookkeeping (`wait_table`) instead of any kernel
    // state: `-ECHILD` when `pid` does not name a live-or-zombie child of
    // the CALLING process (`current_pid`, an out-of-band "who is
    // dispatching right now" cell exactly like `host_futex_wake`'s
    // `current_memory` above — `bind_and_dispatch` sets both immediately
    // before every `kernel_handle_channel` call), `-EAGAIN` (or `0` under
    // `WNOHANG`) when the child exists but has not exited, or the reaped
    // child's pid with the wait-status word written to `status_ptr` (a
    // KERNEL address — see `crates/kernel/src/wasm_api.rs`'s `host_waitpid`
    // wrapper, which passes the address of its own local variable, later
    // copied into the caller's actual `wstatus_ptr` by `kernel_wait4`
    // itself) once it has.
    //
    // This MUST NOT truly block or call back into another kernel export.
    // It runs synchronously inside the single-threaded pump's
    // `kernel_handle_channel` call — the same thread that must also keep
    // servicing the target child's own channel so it can run to exit and
    // reentering the kernel instance while already inside one of its calls
    // risks aliasing its process-table borrows. `Wait4` is one of
    // `syscall_can_block`'s syscalls, so returning `-EAGAIN` here is
    // exactly the existing "park and retry" signal the blocking poll/read
    // table already implements (`run_pump`'s `blocked` vec): the pump parks
    // the request and retries it on a later iteration, by which point
    // `run_pump`'s exit-commit branch has recorded the child's status in
    // `wait_table`. `kernel_reap_exited_child` is deliberately NOT called
    // from here for the same non-reentrancy reason; the pump calls it
    // itself, non-nested, immediately after a `Wait4` dispatch resolves
    // (see both call sites in `run_pump`/`dispatch_once`'s caller).
    {
        let kernel_mem = kernel_mem.clone();
        let current_pid = current_pid.clone();
        let wait_table = wait_table.clone();
        linker.func_wrap(
            "env",
            "host_waitpid",
            move |_c: Caller<'_, ()>, pid: i32, options: i32, status_ptr: i32| -> i32 {
                if pid == 0 || pid < -1 {
                    // Process-group-scoped waitpid needs pgid tracking this
                    // increment does not have (single-level spawn tree
                    // only — see this file's module doc comment); ENOSYS is
                    // a truthful "not implemented yet", mirroring
                    // `kernel_execve` above, never a silently wrong result.
                    return -(libc_errno::ENOSYS);
                }
                let caller = *current_pid.lock().unwrap();
                let mut guard = wait_table.lock().unwrap();
                let WaitTable { parent_of, exited } = &mut *guard;

                let mut child: Option<u32> = None;
                if pid == -1 {
                    for (&c, &p) in parent_of.iter() {
                        if p == caller && exited.contains_key(&c) {
                            child = Some(c);
                            break;
                        }
                    }
                } else {
                    let target = pid as u32;
                    if parent_of.get(&target) != Some(&caller) {
                        return -(libc_errno::ECHILD);
                    }
                    if exited.contains_key(&target) {
                        child = Some(target);
                    }
                }

                let Some(child_pid) = child else {
                    let has_a_child =
                        pid != -1 || parent_of.values().any(|&p| p == caller);
                    if !has_a_child {
                        return -(libc_errno::ECHILD);
                    }
                    return if options & (wasm_posix_shared::wait::WNOHANG as i32) != 0 {
                        0
                    } else {
                        -(libc_errno::EAGAIN)
                    };
                };

                let status_word = exited.remove(&child_pid).expect("contains_key just checked");
                parent_of.remove(&child_pid);
                drop(guard);
                if status_ptr != 0 {
                    unsafe {
                        write_bytes(&kernel_mem, status_ptr as u32 as usize, &status_word.to_le_bytes())
                    };
                }
                child_pid as i32
            },
        )?;
    }
    Ok(())
}

/// Encode a `waitpid`(2) wait-status word from a process's exit code and
/// terminating signal (0 for a normal exit), matching the standard
/// `WIFEXITED`/`WEXITSTATUS`/`WIFSIGNALED`/`WTERMSIG` macro encoding every
/// POSIX host in this repo uses (see `sysroot/include/sys/wait.h`: a normal
/// exit packs the low 8 bits of the exit code into bits 8-15 and leaves the
/// low 7 bits — the "died by signal" field — zero, so `WIFEXITED` (`!TERMSIG`)
/// holds and `WEXITSTATUS` recovers the code; a signal death packs the signal
/// number into the low 7 bits (bit 7 marks a core dump, never set here, so
/// `WCOREDUMP` is always false).
fn encode_wait_status(exit_code: i32, exit_signal: i32) -> i32 {
    if exit_signal != 0 {
        exit_signal & 0x7f
    } else {
        (exit_code & 0xff) << 8
    }
}

/// Host-side bookkeeping `host_waitpid` needs but the kernel's own
/// `sys_waitpid` does not track for it (see `host_waitpid`'s doc comment):
/// which pid belongs to which caller, and which exited children are still
/// unreaped zombies. Populated by `run_guest` (the boot process, ppid `0` —
/// never a real pid, so the boot process itself can never be "waited for"),
/// `handle_spawn` (a newly launched child's real parent), and `run_pump`'s
/// exit-commit branch (every process's encoded wait status, the moment its
/// main channel posts exit) — consulted, never mutated, from inside the
/// `host_waitpid` import closure above.
#[derive(Default)]
struct WaitTable {
    /// child pid -> the pid that launched it. Removed once the child is
    /// reaped (matching real `waitpid`: a second wait on the same pid is
    /// `-ECHILD`, not a stale hit).
    parent_of: HashMap<u32, u32>,
    /// Exited-but-unreaped children: child pid -> the encoded wait-status
    /// word (`encode_wait_status`). Removed once reaped.
    exited: HashMap<u32, i32>,
}

/// Compute a guest module's process memory layout and allocate the shared
/// memory backing it, mirroring the TS host's `computeProcessMemoryLayout`.
/// Split out of [`launch_process`] (rather than folded into it) because the
/// FIRST process's memory must exist BEFORE the kernel instance is even
/// created: `define_kernel_host_imports` wires `host_futex_wake` directly to
/// that memory at kernel-instantiation time, so `run_guest` must call this
/// before instantiating the kernel. A later increment's spawned child has no
/// such ordering constraint (the kernel instance already exists), but calls
/// this same helper first for consistency, then [`launch_process`] with the
/// result.
fn compute_guest_memory(engine: &Engine, guest_module: &Module) -> anyhow::Result<(SharedMemory, ProcessLayout)> {
    let imported_min_pages = guest_module
        .imports()
        .find_map(|i| match i.ty() {
            wasmtime::ExternType::Memory(m) if i.module() == "env" && i.name() == "memory" => {
                Some(m.minimum() as usize)
            }
            _ => None,
        })
        .ok_or_else(|| anyhow::anyhow!("guest does not import env.memory"))?;
    let layout = ProcessLayout::compute(imported_min_pages);
    let memory = new_shared(engine, layout.initial_pages as u32, DEFAULT_MAX_PAGES as u32)?;
    Ok((memory, layout))
}

/// Launch one guest process instance and return the [`GuestProcess`] the pump
/// then services: push its brk/mmap/max-addr into the kernel, spawn its guest
/// OS thread over `memory`, and register its main channel.
///
/// `pid` must already exist as a kernel-side process record — this helper
/// does not create it, since the two callers use different kernel entry
/// points for that (the boot path uses `kernel_create_process_with_stdio`;
/// a spawned child, Task 2, will use `kernel_spawn_process`), and `memory`/
/// `layout` must already be computed (see [`compute_guest_memory`]'s doc
/// comment for why memory creation cannot always happen inside this
/// function). This is exactly the "instance launch" logic `spawn_guest_thread`
/// and `run_guest` used to inline for the single hard-coded process; Task 2
/// reuses it verbatim to launch a `posix_spawn`ed child's process instance.
///
/// Deliberately NOT included here: the kernel-wide rootfs overlay/tmpfs/
/// base-image enablement (`kernel_set_rootfs_now`/`kernel_set_tmpfs_enabled`/
/// `kernel_set_rootfs_enabled`/`kernel_rootfs_load_manifest`) and foreign-
/// prefix registration in `run_guest`. Those are one-time, kernel-instance-
/// wide toggles (no `pid` parameter in their signatures), not per-process
/// launch state, so a spawned child must NOT re-run them — they stay in
/// `run_guest`'s boot sequence, executed once before any process (including
/// the first) is launched.
#[allow(clippy::too_many_arguments)]
fn launch_process(
    engine: &Engine,
    kernel_store: &mut Store<()>,
    alloc_scratch: &wasmtime::TypedFunc<u32, i32>,
    set_brk_base: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_mmap_base: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_max_addr: &wasmtime::TypedFunc<(u32, i32), i32>,
    guest_module: Module,
    memory: SharedMemory,
    layout: ProcessLayout,
    pid: u32,
    import_exit_status: Arc<Mutex<Option<i32>>>,
    launch_argv: Arc<Vec<Vec<u8>>>,
    launch_env: Arc<Vec<Vec<u8>>>,
) -> anyhow::Result<GuestProcess> {
    let scratch_ptr = alloc_scratch.call(&mut *kernel_store, MIN_CHANNEL_SIZE as u32)?;
    if scratch_ptr <= 0 {
        anyhow::bail!("kernel_alloc_scratch({MIN_CHANNEL_SIZE}) returned {scratch_ptr}");
    }
    let scratch_base = scratch_ptr as u32 as usize;

    for (name, val) in [
        ("kernel_set_brk_base", set_brk_base.call(&mut *kernel_store, (pid, layout.brk_base as i32))?),
        ("kernel_set_mmap_base", set_mmap_base.call(&mut *kernel_store, (pid, layout.brk_base as i32))?),
        ("kernel_set_max_addr", set_max_addr.call(&mut *kernel_store, (pid, layout.max_addr as i32))?),
    ] {
        if val < 0 {
            anyhow::bail!("{name} failed: {val}");
        }
    }

    let main_handle = spawn_guest_thread(
        engine,
        guest_module.clone(),
        memory.clone(),
        layout,
        import_exit_status,
        launch_argv,
        launch_env,
    );
    let mut thread_handles = HashMap::new();
    thread_handles.insert(layout.channel_offset, main_handle);

    Ok(GuestProcess {
        pid,
        module: guest_module,
        memory,
        scratch_base,
        layout,
        channels: vec![PumpChannel { offset: layout.channel_offset, tid: pid, is_main: true }],
        next_thread_slot: 0,
        thread_handles,
    })
}

/// Instantiate the guest on a fresh OS thread and run it to `_start`. The
/// thread blocks inside `_start` on each syscall's `wait32`; the pump on the
/// kernel thread services them. It never returns for a normal exit (the guest
/// parks after `exit_group`), so the ordinary caller must not join it — it is
/// reclaimed when the process exits. N1-R's `reclaim_parked_thread` +
/// `join_reclaimed_thread` are the one exception: on execve-success or spawn
/// `-ECHILD` rollback, the pump publishes `CH_TEARDOWN` on this thread's
/// channel, notifies it, and joins the returned handle deterministically
/// instead of abandoning it (see `GuestProcess::thread_handles`).
fn spawn_guest_thread(
    engine: &Engine,
    module: Module,
    guest_mem: SharedMemory,
    layout: ProcessLayout,
    import_exit_status: Arc<Mutex<Option<i32>>>,
    launch_argv: Arc<Vec<Vec<u8>>>,
    launch_env: Arc<Vec<Vec<u8>>>,
) -> thread::JoinHandle<()> {
    let engine = engine.clone();
    thread::spawn(move || {
        let mut store = Store::new(&engine, ());
        let mut linker: Linker<()> = Linker::new(&engine);
        linker.define(&mut store, "env", "memory", guest_mem.clone()).unwrap();
        // The guest reads env.__channel_base to find the channel; provide it as
        // a mutable i32 global set to the layout's channel offset.
        let channel_base = Global::new(
            &mut store,
            GlobalType::new(ValType::I32, Mutability::Var),
            Val::I32(layout.channel_offset as i32),
        )
        .unwrap();
        linker.define(&mut store, "env", "__channel_base", channel_base).unwrap();

        // Host-provided launch metadata: real argv/env from the caller's
        // `GuestOptions`, matching the copy contract `host/src/worker-main.ts`'s
        // `copyEntry` uses (a zero-capacity call is a side-effect-free length
        // query; the CRT always makes one before its one exact-capacity copy —
        // see `libc/musl-overlay/crt/crt1.c`). Empty argv/env (`argc/envc == 0`,
        // `run_trivial_guest`'s default) still takes the CRT's "a.out" fallback,
        // and `kernel_argv_read`/`kernel_environ_get` are simply never called
        // (the CRT's per-index loop does not execute). secure_exec = 0 skips the
        // fd-securing path; is_fork_child = 0 runs main rather than the exec path.
        {
            let argv = launch_argv.clone();
            linker.func_wrap("kernel", "kernel_get_argc", move || -> i32 { argv.len() as i32 }).unwrap();
        }
        {
            let env = launch_env.clone();
            linker
                .func_wrap("kernel", "kernel_environ_count", move || -> i32 { env.len() as i32 })
                .unwrap();
        }
        {
            let argv = launch_argv.clone();
            let mem = guest_mem.clone();
            linker
                .func_wrap(
                    "kernel",
                    "kernel_argv_read",
                    move |_c: Caller<'_, ()>, index: u32, buf_ptr: i32, buf_max: u32| -> i32 {
                        copy_launch_entry(&mem, &argv, index, buf_ptr, buf_max)
                    },
                )
                .unwrap();
        }
        {
            let env = launch_env.clone();
            let mem = guest_mem.clone();
            linker
                .func_wrap(
                    "kernel",
                    "kernel_environ_get",
                    move |_c: Caller<'_, ()>, index: u32, buf_ptr: i32, buf_max: u32| -> i32 {
                        copy_launch_entry(&mem, &env, index, buf_ptr, buf_max)
                    },
                )
                .unwrap();
        }
        linker.func_wrap("kernel", "kernel_get_secure_exec", || -> i32 { 0 }).unwrap();
        linker.func_wrap("kernel", "kernel_is_fork_child", || -> i32 { 0 }).unwrap();
        // The SIGKILL-only fast-path import. A normal exit never calls it; if it
        // ever fires, record the status and trap to unwind _start.
        {
            let status = import_exit_status.clone();
            linker
                .func_wrap("kernel", "kernel_exit", move |_c: Caller<'_, ()>, s: i32| -> anyhow::Result<()> {
                    *status.lock().unwrap() = Some(s);
                    Err(anyhow::anyhow!("kernel_exit({s})"))
                })
                .unwrap();
        }
        // kernel_clone: pthread_create calls this import directly (not the
        // syscall glue) so the thread entry fn/arg can travel in the channel
        // data region. Post a SYS_CLONE request on this (main) channel and block
        // for the pump to allocate the child tid and launch the worker thread.
        {
            let mem = guest_mem.clone();
            let ch = layout.channel_offset;
            linker
                .func_wrap(
                    "kernel",
                    "kernel_clone",
                    move |_c: Caller<'_, ()>,
                          fn_ptr: i32,
                          stack_ptr: i32,
                          flags: i32,
                          arg: i32,
                          ptid: i32,
                          tls: i32,
                          ctid: i32|
                          -> i32 {
                        let clone_args = [
                            flags as i64,
                            stack_ptr as i64,
                            ptid as i64,
                            tls as i64,
                            ctid as i64,
                            0i64,
                        ];
                        unsafe {
                            write_bytes(&mem, ch + SYSCALL_OFFSET, &SYS_CLONE.to_le_bytes());
                            for (i, a) in clone_args.iter().enumerate() {
                                write_bytes(&mem, ch + ARGS_OFFSET + i * ARG_SIZE, &a.to_le_bytes());
                            }
                            write_bytes(&mem, ch + DATA_OFFSET, &(fn_ptr as u32).to_le_bytes());
                            write_bytes(&mem, ch + DATA_OFFSET + 4, &(arg as u32).to_le_bytes());
                            write_bytes(&mem, ch + REQUEST_FLAGS_OFFSET, &0u32.to_le_bytes());
                            atomic_u32(&mem, ch + STATUS_OFFSET).store(STATUS_PENDING, Ordering::SeqCst);
                        }
                        let _ = mem.atomic_notify((ch + STATUS_OFFSET) as u64, 1);
                        loop {
                            let s = unsafe { atomic_u32(&mem, ch + STATUS_OFFSET) }.load(Ordering::SeqCst);
                            if s != STATUS_PENDING {
                                break;
                            }
                            std::thread::sleep(Duration::from_micros(200));
                        }
                        let tid = unsafe { read_i64(&mem, ch + RETURN_OFFSET) } as i32;
                        unsafe {
                            atomic_u32(&mem, ch + STATUS_OFFSET).store(STATUS_IDLE, Ordering::SeqCst);
                        }
                        tid
                    },
                )
                .unwrap();
        }
        // kernel_wait4: registered defensively so a guest that happens to
        // import "kernel.kernel_wait4" does not trap the build. In practice
        // the CURRENT glue (`libc/glue/channel_syscall.c`, which replaced
        // `syscall_glue.c` — see that file's own header comment) has no
        // wasm32posix override routing `waitpid`/`wait4` through a direct
        // "kernel.*" import the way `pthread_create` does for `kernel_clone`
        // (`libc/musl-overlay/src/thread/wasm32posix/clone.c`): musl's stock
        // `waitpid`/`wait4` call `__syscall_cp(SYS_wait4, ...)`, the GENERIC
        // channel post. `SYS_WAIT4` (139) therefore arrives on the process's
        // MAIN channel like any other syscall and is serviced by the
        // generic `dispatch_once` path in `run_pump` (RAW-marshalled per
        // `SYSCALL_ARG_DESCRIPTORS`'s `Wait4` entry) — no `ch.is_main`
        // special-casing needed, unlike `SYS_CLONE`/`SYS_SPAWN`. Blocking
        // and reaping are `host_waitpid`'s job (N1-I3a Task 3, an `env`
        // import the KERNEL itself calls from inside `kernel_wait4`/
        // `sys_waitpid` — see that closure's doc comment) plus
        // `syscall_can_block`/the exit-commit branch below, not this import.
        {
            let mem = guest_mem.clone();
            let ch = layout.channel_offset;
            linker
                .func_wrap(
                    "kernel",
                    "kernel_wait4",
                    move |_c: Caller<'_, ()>,
                          pid: i32,
                          wstatus_ptr: i32,
                          options: i32,
                          rusage_ptr: i32|
                          -> i32 {
                        let wait_args = [
                            pid as i64,
                            wstatus_ptr as i64,
                            options as i64,
                            rusage_ptr as i64,
                            0i64,
                            0i64,
                        ];
                        unsafe {
                            write_bytes(&mem, ch + SYSCALL_OFFSET, &(Syscall::Wait4 as u32).to_le_bytes());
                            for (i, a) in wait_args.iter().enumerate() {
                                write_bytes(&mem, ch + ARGS_OFFSET + i * ARG_SIZE, &a.to_le_bytes());
                            }
                            write_bytes(&mem, ch + REQUEST_FLAGS_OFFSET, &0u32.to_le_bytes());
                            atomic_u32(&mem, ch + STATUS_OFFSET).store(STATUS_PENDING, Ordering::SeqCst);
                        }
                        let _ = mem.atomic_notify((ch + STATUS_OFFSET) as u64, 1);
                        loop {
                            let s = unsafe { atomic_u32(&mem, ch + STATUS_OFFSET) }.load(Ordering::SeqCst);
                            if s != STATUS_PENDING {
                                break;
                            }
                            std::thread::sleep(Duration::from_micros(200));
                        }
                        let (ret, errno) = unsafe {
                            (read_i64(&mem, ch + RETURN_OFFSET), read_u32(&mem, ch + ERRNO_OFFSET))
                        };
                        unsafe {
                            atomic_u32(&mem, ch + STATUS_OFFSET).store(STATUS_IDLE, Ordering::SeqCst);
                        }
                        // This import bypasses `__do_syscall_impl`'s generic
                        // "ret<0 -> -errno" post-processing (it is called
                        // directly, not through the RAW channel path), so it
                        // must apply that same convention itself.
                        if ret < 0 { -(errno as i32) } else { ret as i32 }
                    },
                )
                .unwrap();
        }
        // kernel_execve: execve()/execveat() call this import directly.
        // Image replacement is a later increment (I3c); return ENOSYS (a real
        // posix errno) rather than leaving this to the default trap-stub, so
        // a guest that calls execve() sees a truthful "not implemented yet"
        // failure instead of an abrupt host trap.
        linker
            .func_wrap(
                "kernel",
                "kernel_execve",
                |_c: Caller<'_, ()>, _path_ptr: i32, _path_len: i32| -> i32 { -(libc_errno::ENOSYS) },
            )
            .unwrap();
        // The fork-exec import set is imported but never reached on this
        // (non-forking) path; a trap is the truthful boundary.
        linker.define_unknown_imports_as_traps(&module).unwrap();

        let instance = match linker.instantiate(&mut store, &module) {
            Ok(i) => i,
            Err(e) => {
                eprintln!("guest instantiate failed: {e}");
                return;
            }
        };
        let start = instance
            .get_typed_func::<(), ()>(&mut store, "_start")
            .expect("guest exports _start");
        // Blocks until the guest parks after exit_group (normal), or traps.
        let _ = start.call(&mut store, ());
    })
}

/// Launch a worker (pthread) on a fresh OS thread over the shared guest memory.
/// It sets the thread's channel base, stack, and TLS, calls the thread entry via
/// the indirect function table, then posts SYS_EXIT on its channel and parks for
/// the pump to release it. Detached in the ordinary case — the pump routes
/// its exit and never joins it — except under N1-R reclamation (execve
/// success tearing down a still-live worker channel), which joins the
/// returned handle via `GuestProcess::thread_handles`.
#[allow(clippy::too_many_arguments)]
fn spawn_worker_thread(
    engine: &Engine,
    module: &Module,
    guest_mem: SharedMemory,
    channel_offset: usize,
    tls_offset: usize,
    stack_ptr: u32,
    tls_ptr: u32,
    fn_ptr: u32,
    arg: u32,
) -> thread::JoinHandle<()> {
    let engine = engine.clone();
    let module = module.clone();
    thread::spawn(move || {
        if let Err(e) = run_worker_thread(
            &engine, &module, &guest_mem, channel_offset, tls_offset, stack_ptr, tls_ptr, fn_ptr, arg,
        ) {
            eprintln!("worker thread (channel {channel_offset:#x}) failed: {e:?}");
        }
    })
}

#[allow(clippy::too_many_arguments)]
fn run_worker_thread(
    engine: &Engine,
    module: &Module,
    guest_mem: &SharedMemory,
    channel_offset: usize,
    tls_offset: usize,
    stack_ptr: u32,
    tls_ptr: u32,
    fn_ptr: u32,
    arg: u32,
) -> anyhow::Result<()> {
    let mut store = Store::new(engine, ());
    let mut linker: Linker<()> = Linker::new(engine);
    linker.define(&mut store, "env", "memory", guest_mem.clone())?;
    let channel_base = Global::new(
        &mut store,
        GlobalType::new(ValType::I32, Mutability::Var),
        Val::I32(channel_offset as i32),
    )?;
    linker.define(&mut store, "env", "__channel_base", channel_base)?;
    // The worker reaches the kernel through the syscall glue (its own channel),
    // not through the kernel.* imports, so every kernel.* import can trap.
    linker.define_unknown_imports_as_traps(module)?;

    let instance = linker.instantiate(&mut store, module)?;

    // Thread prelude (mirrors the TS thread worker): initialize this thread's
    // TLS in its slot, point __stack_pointer at the pthread stack, then run musl
    // thread-pointer setup. __channel_base was already set as an import global.
    if let Ok(init_tls) = instance.get_typed_func::<i32, ()>(&mut store, "__wasm_init_tls") {
        init_tls.call(&mut store, tls_offset as i32)?;
    }
    let sp = instance
        .get_global(&mut store, "__stack_pointer")
        .ok_or_else(|| anyhow::anyhow!("guest missing __stack_pointer"))?;
    sp.set(&mut store, Val::I32(stack_ptr as i32))?;
    if let Ok(thread_init) = instance.get_typed_func::<i32, ()>(&mut store, "__wasm_thread_init") {
        thread_init.call(&mut store, tls_ptr as i32)?;
    }

    // Call the thread entry via the indirect function table with its argument.
    let table = instance
        .get_table(&mut store, "__indirect_function_table")
        .ok_or_else(|| anyhow::anyhow!("guest missing __indirect_function_table"))?;
    let entry = table
        .get(&mut store, u64::from(fn_ptr))
        .ok_or_else(|| anyhow::anyhow!("thread entry {fn_ptr} out of table range"))?;
    let func = match entry {
        Ref::Func(Some(f)) => f,
        _ => anyhow::bail!("thread entry {fn_ptr} is not a function"),
    };
    let results_len = func.ty(&store).results().len();
    let mut results = vec![Val::I32(0); results_len];
    match func.call(&mut store, &[Val::I32(arg as i32)], &mut results) {
        // musl's detached-thread exit (__unmapself) issues SYS_munmap + SYS_exit
        // — which the pump routes to kernel_thread_exit — then executes
        // `unreachable` to halt the thread. That trap is the expected, clean end
        // of the thread, exactly like the process exit trap on the main thread.
        Err(e) if is_unreachable_trap(&e) => Ok(()),
        Err(e) => Err(e),
        // A thread entry that returns without self-exiting is unusual (musl
        // always exits via __pthread_exit); post the exit ourselves as a fallback.
        Ok(()) => {
            post_thread_exit(guest_mem, channel_offset);
            Ok(())
        }
    }
}

/// Whether a Wasmtime error is a guest `unreachable` trap (the expected halt at
/// the end of the process/thread exit path).
fn is_unreachable_trap(e: &anyhow::Error) -> bool {
    matches!(
        e.downcast_ref::<wasmtime::Trap>(),
        Some(wasmtime::Trap::UnreachableCodeReached)
    )
}

/// Post SYS_EXIT on a worker's channel and wait (bounded) for the pump to
/// complete it. The pump routes this to kernel_thread_exit and drops the channel.
fn post_thread_exit(guest_mem: &SharedMemory, channel_offset: usize) {
    let ch = channel_offset;
    unsafe {
        write_bytes(guest_mem, ch + SYSCALL_OFFSET, &(Syscall::Exit as u32).to_le_bytes());
        for i in 0..6 {
            write_bytes(guest_mem, ch + ARGS_OFFSET + i * ARG_SIZE, &0i64.to_le_bytes());
        }
        write_bytes(guest_mem, ch + REQUEST_FLAGS_OFFSET, &0u32.to_le_bytes());
        atomic_u32(guest_mem, ch + STATUS_OFFSET).store(STATUS_PENDING, Ordering::SeqCst);
    }
    let _ = guest_mem.atomic_notify((ch + STATUS_OFFSET) as u64, 1);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let s = unsafe { atomic_u32(guest_mem, ch + STATUS_OFFSET) }.load(Ordering::SeqCst);
        if s != STATUS_PENDING || Instant::now() > deadline {
            break;
        }
        std::thread::sleep(Duration::from_micros(200));
    }
}

/// A live guest channel the pump services: its byte offset in guest memory and
/// the tid to bind (kernel_set_current_tid) before dispatching its syscalls.
#[derive(Clone, Copy)]
struct PumpChannel {
    offset: usize,
    tid: u32,
    is_main: bool,
}

/// One process the pump manages: its own compiled guest module, shared
/// memory, kernel-scratch region, pid, process memory layout, and its live
/// channels (the main channel plus any worker-thread channels sharing this
/// process's memory).
///
/// N1-I3a Task 1 generalized the pump from a single hard-coded process to a
/// `Vec<GuestProcess>` so a later increment (posix_spawn) could push
/// additional entries — one per spawned child, each with its OWN memory —
/// without restructuring the pump loop again. Task 2 is that increment: a
/// successful `SYS_SPAWN` (see `handle_spawn`) pushes exactly one more entry
/// per call, one per launched child.
struct GuestProcess {
    pid: u32,
    /// The compiled module this process's main thread and any of its worker
    /// (pthread) threads instantiate from. Kept per-process (rather than a
    /// single pump-wide module) so a future spawned child can run a
    /// different program than its parent.
    module: Module,
    memory: SharedMemory,
    scratch_base: usize,
    layout: ProcessLayout,
    channels: Vec<PumpChannel>,
    /// Next unused slot index in this process's reserved thread-slot arena
    /// (`layout.first_thread_slot_page`); each `pthread_create` (SYS_CLONE)
    /// consumes one. Per-process because the arena itself is carved out of
    /// this process's own memory layout.
    next_thread_slot: usize,
    /// The OS `JoinHandle` backing each live entry in `channels`, keyed by
    /// that channel's `offset` (the same key `reclaim_parked_thread` writes
    /// the teardown sentinel to). Normally these threads are never joined —
    /// they park forever in the channel's `memory.atomic.wait32` and are
    /// left for the OS to reclaim at process teardown (see
    /// `spawn_guest_thread`/`spawn_worker_thread`'s doc comments). N1-R's
    /// reclamation paths (execve-success, spawn `-ECHILD` rollback) are the
    /// exception: they publish `CH_TEARDOWN` on a channel, then look up and
    /// `join()` its handle here for deterministic reclamation instead of
    /// abandoning it.
    thread_handles: HashMap<usize, thread::JoinHandle<()>>,
}

/// A blocking syscall parked awaiting readiness (or its timeout deadline). The
/// pump re-dispatches it under `token` on later iterations instead of looping in
/// place, so one channel's blocked op never starves another channel.
#[derive(Clone, Copy)]
struct BlockedOp {
    /// Index into the pump's `processes` vec that owns `channel` — needed to
    /// find the right memory/pid/scratch on a later retry pass, since a
    /// channel's byte offset alone is not process-unique (two processes'
    /// deterministically computed `ProcessLayout`s can share the same
    /// channel offset in their own, distinct memories).
    process_index: usize,
    channel: PumpChannel,
    syscall_nr: u32,
    /// `> 0` pins a stable OFD target that must be released on completion; `0`
    /// is a host-only-snapshot syscall (poll) with nothing to pin.
    token: i64,
    deadline: Option<Instant>,
}

/// Read a channel's 6 syscall args.
fn read_channel_args(guest_mem: &SharedMemory, offset: usize) -> [i64; 6] {
    let mut args = [0i64; 6];
    for (i, a) in args.iter_mut().enumerate() {
        *a = unsafe { read_i64(guest_mem, offset + ARGS_OFFSET + i * ARG_SIZE) };
    }
    args
}

/// Read a channel's posted request: syscall number, args, and whether it is an
/// opaque record (from the header flag, never the stale data-buffer magic).
fn read_channel_request(guest_mem: &SharedMemory, offset: usize) -> (u32, [i64; 6], bool) {
    let syscall_nr = unsafe { read_u32(guest_mem, offset + SYSCALL_OFFSET) };
    let args = read_channel_args(guest_mem, offset);
    let request_flags = unsafe { read_u32(guest_mem, offset + REQUEST_FLAGS_OFFSET) };
    (syscall_nr, args, request_flags & REQUEST_FLAG_OPAQUE_RECORD != 0)
}

/// Stage a RAW request into the scratch: clear the record-magic slot, stamp the
/// syscall number, marshal In/Out pointer buffers (rewriting `args`), and write
/// the args. Returns the staged buffers for post-call copy-back.
fn stage_raw(
    kernel_mem: &SharedMemory,
    guest_mem: &SharedMemory,
    scratch_ptr: usize,
    syscall_nr: u32,
    args: &mut [i64; 6],
) -> anyhow::Result<Vec<StagedArg>> {
    unsafe {
        write_bytes(kernel_mem, scratch_ptr + DATA_OFFSET, &[0u8; 4]);
        write_bytes(kernel_mem, scratch_ptr + SYSCALL_OFFSET, &syscall_nr.to_le_bytes());
    }
    let staged = marshal_in(kernel_mem, guest_mem, scratch_ptr, syscall_nr, args)?;
    unsafe {
        for (i, a) in args.iter().enumerate() {
            write_bytes(kernel_mem, scratch_ptr + ARGS_OFFSET + i * ARG_SIZE, &a.to_le_bytes());
        }
    }
    // The kernel keys record decoding on DATA[0..4]; a RAW buffer that begins
    // with the opaque-record magic would misroute. Fail loudly, never corrupt.
    if unsafe { read_u32(kernel_mem, scratch_ptr + DATA_OFFSET) } == RECORD_MAGIC {
        anyhow::bail!(
            "RAW syscall {syscall_nr} staged a buffer starting with RECORD_MAGIC; \
             the kernel would misroute it as an opaque record"
        );
    }
    Ok(staged)
}

/// Stage and dispatch one channel request once under `retry_token`, binding the
/// channel's tid first. Returns `(ret, errno, staged)`. For a record it blind-
/// transports the data region both ways; for RAW it marshals pointer args. Does
/// not complete the channel and does not handle exit (the caller does).
#[allow(clippy::too_many_arguments)]
fn dispatch_once(
    store: &mut Store<()>,
    guest_mem: &SharedMemory,
    kernel_mem: &SharedMemory,
    scratch_ptr: usize,
    pid: u32,
    ch: PumpChannel,
    syscall_nr: u32,
    is_record: bool,
    args: &mut [i64; 6],
    retry_token: i64,
    set_current_tid: &wasmtime::TypedFunc<(u32, u32), i32>,
    handle_channel: &wasmtime::TypedFunc<(i32, u32, u32, i64), i32>,
    current_memory: &Arc<Mutex<SharedMemory>>,
    current_pid: &Arc<Mutex<u32>>,
) -> anyhow::Result<(i64, u32, Vec<StagedArg>)> {
    if is_record {
        // Opaque-record blind transport: stamp the syscall, blind-copy the data
        // region into the scratch, dispatch (the kernel decodes it and writes
        // OUT spans back), blind-copy the data region back for the guest to
        // unmarshal, then clear the scratch magic for the next RAW syscall.
        unsafe {
            write_bytes(kernel_mem, scratch_ptr + SYSCALL_OFFSET, &syscall_nr.to_le_bytes());
            let record_in = read_bytes(guest_mem, ch.offset + DATA_OFFSET, DATA_SIZE);
            write_bytes(kernel_mem, scratch_ptr + DATA_OFFSET, &record_in);
        }
        bind_and_dispatch(
            store, scratch_ptr, pid, ch.tid, retry_token, set_current_tid, handle_channel, guest_mem,
            current_memory, current_pid,
        )?;
        let (ret, errno) = read_ret_errno(kernel_mem, scratch_ptr);
        unsafe {
            let record_out = read_bytes(kernel_mem, scratch_ptr + DATA_OFFSET, DATA_SIZE);
            write_bytes(guest_mem, ch.offset + DATA_OFFSET, &record_out);
            write_bytes(kernel_mem, scratch_ptr + DATA_OFFSET, &[0u8; 4]);
        }
        Ok((ret, errno, Vec::new()))
    } else {
        let staged = stage_raw(kernel_mem, guest_mem, scratch_ptr, syscall_nr, args)?;
        bind_and_dispatch(
            store, scratch_ptr, pid, ch.tid, retry_token, set_current_tid, handle_channel, guest_mem,
            current_memory, current_pid,
        )?;
        let (ret, errno) = read_ret_errno(kernel_mem, scratch_ptr);
        Ok((ret, errno, staged))
    }
}

/// Bind the channel's tid (a one-shot binding consumed by the dispatch), point
/// the shared "current process memory" cell at this channel's owning process
/// (see `host_futex_wake`'s doc comment — a futex wake fired synchronously
/// from inside `kernel_handle_channel` must land on the CALLING process's
/// memory, not whichever process happened to be dispatched last) and the
/// "current pid" cell `host_waitpid` reads (N1-I3a Task 3 — same reasoning,
/// same mechanism), and call `kernel_handle_channel`.
#[allow(clippy::too_many_arguments)]
fn bind_and_dispatch(
    store: &mut Store<()>,
    scratch_ptr: usize,
    pid: u32,
    tid: u32,
    retry_token: i64,
    set_current_tid: &wasmtime::TypedFunc<(u32, u32), i32>,
    handle_channel: &wasmtime::TypedFunc<(i32, u32, u32, i64), i32>,
    guest_mem: &SharedMemory,
    current_memory: &Arc<Mutex<SharedMemory>>,
    current_pid: &Arc<Mutex<u32>>,
) -> anyhow::Result<()> {
    let bind = set_current_tid.call(&mut *store, (pid, tid))?;
    if bind < 0 {
        anyhow::bail!("kernel_set_current_tid({pid},{tid}) failed: {bind}");
    }
    *current_memory.lock().unwrap() = guest_mem.clone();
    *current_pid.lock().unwrap() = pid;
    handle_channel.call(&mut *store, (scratch_ptr as i32, MIN_CHANNEL_SIZE as u32, pid, retry_token))?;
    Ok(())
}

/// Publish a completed syscall to its channel and wake the guest: copy back Out
/// buffers, grow guest memory for mmap/brk, write RETURN/ERRNO, then release-
/// store COMPLETE and notify the guest's `wait32`.
fn complete_channel(
    guest_mem: &SharedMemory,
    kernel_mem: &SharedMemory,
    scratch_ptr: usize,
    ch: PumpChannel,
    syscall_nr: u32,
    args: &[i64; 6],
    staged: &[StagedArg],
    ret: i64,
    errno: u32,
) -> anyhow::Result<()> {
    for s in staged {
        if s.copy_back {
            let bytes = unsafe { read_bytes(kernel_mem, scratch_ptr + s.data_off, s.len) };
            unsafe { write_bytes(guest_mem, s.guest_ptr, &bytes) };
        }
    }
    if ret >= 0 {
        if syscall_nr == Syscall::Mmap as u32 {
            grow_to_cover(guest_mem, ret as usize + args[1] as u32 as usize)?;
        } else if syscall_nr == Syscall::Brk as u32 {
            grow_to_cover(guest_mem, ret as usize)?;
        }
    }
    unsafe {
        write_bytes(guest_mem, ch.offset + RETURN_OFFSET, &ret.to_le_bytes());
        write_bytes(guest_mem, ch.offset + ERRNO_OFFSET, &errno.to_le_bytes());
        atomic_u32(guest_mem, ch.offset + STATUS_OFFSET).store(STATUS_COMPLETE, Ordering::SeqCst);
    }
    guest_mem
        .atomic_notify((ch.offset + STATUS_OFFSET) as u64, 1)
        .map_err(|e| anyhow::anyhow!("atomic_notify failed: {e}"))?;
    Ok(())
}

/// Test-only hook (N1-R Task 2): counts every reclaimed guest thread whose
/// `JoinHandle::join()` returned `Ok(())` after a `reclaim_parked_thread`
/// teardown. Always compiled under `cfg(test)` (both `guest.rs` and
/// `lib.rs`'s test module are part of the same crate, so this is visible to
/// `smoke_execve_reclaims_thread`), never touched by production code paths.
/// It exists because there is no other externally observable signal that a
/// specific OS thread — parked deep inside a live Wasmtime `Instance::call`
/// on its own stack — actually unwound and its closure returned, short of
/// `join()`ing it, which is exactly what production code already does.
#[cfg(test)]
pub(crate) static RECLAIMED_THREAD_JOIN_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Host-driven thread reclamation (N1-R Task 2, consuming Task 1's
/// `ChannelStatus::Teardown`): publish `TEARDOWN` into `ch`'s status word
/// (release store — the guest's wake-side re-read uses `__ATOMIC_SEQ_CST`,
/// at least as strong as acquire, so the write is visible before it
/// observes `TEARDOWN`) and notify any guest thread parked in this channel's
/// `memory.atomic.wait32`. Mirrors `complete_channel`'s exact status-word
/// address math (`ch.offset + STATUS_OFFSET`) so this targets the SAME
/// address the guest glue parks on.
///
/// The guest glue (`libc/glue/channel_syscall.c`, Task 1) re-reads the
/// status word on wake and, on `TEARDOWN`, `__builtin_trap()`s immediately
/// instead of reading `CH_RETURN`/`CH_ERRNO` — wasmtime unwinds the guest
/// stack, the thread's `Store`/`SharedMemory` clone drop, and the spawning
/// closure returns. Validated end-to-end by the spike (`exp_d`,
/// `docs/plans/2026-09-05-native-thread-reclamation-spike.md`).
///
/// This function ONLY publishes the sentinel and notifies — it does not
/// join. Callers must not treat `ch` as servicable afterward (no further
/// syscall will ever post on it) and are responsible for looking up and
/// joining its `JoinHandle` (see [`join_reclaimed_thread`]) for
/// deterministic reclamation.
fn reclaim_parked_thread(mem: &SharedMemory, ch: &PumpChannel) {
    unsafe {
        atomic_u32(mem, ch.offset + STATUS_OFFSET)
            .store(ChannelStatus::Teardown as u32, Ordering::Release);
    }
    let _ = mem.atomic_notify((ch.offset + STATUS_OFFSET) as u64, 1);
}

/// Join a thread handle after [`reclaim_parked_thread`] has already
/// published `TEARDOWN` and notified it. The thread is expected to trap and
/// return promptly (no wasm executes between the notify and the trap check
/// — see `channel_syscall.c`'s teardown check immediately after the wait
/// loop), so this blocking `join()` is not expected to hang; if the guest
/// glue is ever missing the Task 1 check (a stale/mismatched build), the
/// thread would re-park forever and this join WOULD hang — that staleness
/// is exactly the class of failure the ABI/build contracts (fixture
/// rebuild, `scripts/build-musl.sh`) exist to make loud elsewhere, not a
/// case this function tries to detect itself.
fn join_reclaimed_thread(handle: thread::JoinHandle<()>) {
    match handle.join() {
        Ok(()) => {
            #[cfg(test)]
            RECLAIMED_THREAD_JOIN_COUNT.fetch_add(1, Ordering::SeqCst);
        }
        Err(_) => {
            eprintln!(
                "[host-native] a reclaimed guest thread panicked instead of trapping cleanly on \
                 TEARDOWN"
            );
        }
    }
}

/// Publish `TEARDOWN` to every PARKED live channel of `proc_` (execve-success
/// reclaims ALL of the old process's parked channels, not just the caller's
/// main one — a still-running worker/pthread channel that is genuinely
/// parked in its wait would otherwise be left abandoned in the superseded
/// image) and join each such channel's thread handle. Consumes `proc_`
/// because the old `GuestProcess` (its module, memory, and any remaining
/// bookkeeping) has no further use once this returns.
///
/// "Parked" is decided empirically per channel, right here, by its OWN
/// status word: a channel reads `STATUS_PENDING` if and only if its guest
/// thread has posted a request and is at, or about to enter,
/// `memory.atomic.wait32` on this exact word (see `channel_syscall.c`'s
/// wait loop — it stores `CH_PENDING` immediately before waiting and
/// nothing else changes it away from `PENDING` except a pump completion).
/// The caller's own exec-posting channel is always in this state (`run_pump`
/// only reaches `handle_exec_common` while servicing a `PENDING` channel,
/// and it deliberately never completes it — see that function's doc
/// comment), so it is always reclaimed.
///
/// NOTE (carried from the spike, Q3/Q4): a sibling worker channel that is
/// NOT `PENDING` right now means its thread is compute-bound inside the
/// guest, not parked in this channel's wait — epoch/fuel cannot interrupt
/// it (spike Q1/Q2), and forcibly writing `TEARDOWN` there would be
/// clobbered by that thread's OWN next `CH_PENDING` store before it ever
/// waits, so `join()`ing such a handle could hang forever waiting for a
/// syscall this now-orphaned channel will never receive. This function
/// deliberately does NOT touch or join a non-parked channel's thread — it
/// is the documented, out-of-scope multi-threaded-execve residual (the
/// handle is dropped unjoined, same shape as the pre-N1-R single-channel
/// leak this task replaces for the common, single-threaded case).
fn reclaim_all_channels(proc_: GuestProcess) {
    let GuestProcess {
        memory,
        channels,
        mut thread_handles,
        ..
    } = proc_;
    for ch in &channels {
        let status =
            unsafe { atomic_u32(&memory, ch.offset + STATUS_OFFSET) }.load(Ordering::SeqCst);
        if status != STATUS_PENDING {
            // Compute-bound sibling, not parked — leave it alone (see this
            // function's doc comment); drop its handle unjoined.
            thread_handles.remove(&ch.offset);
            continue;
        }
        reclaim_parked_thread(&memory, ch);
        if let Some(handle) = thread_handles.remove(&ch.offset) {
            join_reclaimed_thread(handle);
        }
    }
}

/// The channel pump: a single-threaded event loop that services every live
/// channel of every live process and parks blocking syscalls in a table
/// (re-dispatching them across iterations) rather than looping in place — so
/// a blocked op on one channel never starves another. Returns the exit code
/// of the FIRST process's (`processes[0]`, the boot process) main channel
/// once it has posted exit/exit_group.
///
/// N1-I3a Task 1 made `processes` a `Vec` so Task 2 (posix_spawn) could push
/// additional entries here. Task 2 does exactly that (see the `SYS_SPAWN`
/// branch below) and, since a run can now have more than one process, also
/// widens the "whose main-channel exit ends the pump" rule Task 1 flagged as
/// out of scope. `processes[0]`'s exit no longer returns immediately: it is
/// recorded (`root_exit_code`) and the pump keeps running until every
/// spawned child (`processes[1..]`) has ALSO finished all of its channels,
/// only then returning the recorded code. Without this drain, whichever of
/// the parent/child happened to exit first would nondeterministically decide
/// when the run ends — and since this task's own test has no `waitpid` to
/// synchronize on, an immediate return on the parent's exit could return
/// before the child had even started running, making the "child's stdout
/// appears" assertion flaky. A spawned child's own main-channel exit always
/// just commits into the kernel's process table and drops its channel (never
/// ends the pump by itself). This branch also RECORDS every process's exit
/// (`kernel_get_process_exit_status`/`kernel_get_process_exit_signal`,
/// encoded via `encode_wait_status`) into `wait_table`, whether or not a
/// parent is currently parked on it — N1-I3a Task 3's `host_waitpid`
/// resolves against exactly that record (see its doc comment), and
/// `kernel_reap_exited_child` is called from THIS function (never from
/// inside `host_waitpid` itself) at the two places a `Wait4` dispatch can
/// resolve successfully: the immediate (non-parked) path below and the
/// blocked-retry path above. `processes[0]`'s OWN non-main (worker-thread)
/// channels are NOT part of the drain condition — unchanged from before
/// Task 2, a still-blocked worker thread of the boot process never delays
/// the return.
#[allow(clippy::too_many_arguments)]
fn run_pump(
    kernel_store: &mut Store<()>,
    engine: &Engine,
    kernel_mem: &SharedMemory,
    processes: &mut Vec<GuestProcess>,
    set_current_tid: &wasmtime::TypedFunc<(u32, u32), i32>,
    handle_channel: &wasmtime::TypedFunc<(i32, u32, u32, i64), i32>,
    get_exit_status: &wasmtime::TypedFunc<u32, i32>,
    get_exit_signal: &wasmtime::TypedFunc<u32, i32>,
    blocking_retry_token: &wasmtime::TypedFunc<(u32, u32, u32), i64>,
    blocking_retry_release: &wasmtime::TypedFunc<(u32, u32, i64), i32>,
    thread_exit: &wasmtime::TypedFunc<(u32, u32), i64>,
    alloc_scratch: &wasmtime::TypedFunc<u32, i32>,
    set_brk_base: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_mmap_base: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_max_addr: &wasmtime::TypedFunc<(u32, i32), i32>,
    spawn_process: &wasmtime::TypedFunc<(u32, u32, i32, i32), i32>,
    spawn_blob_decode: &wasmtime::TypedFunc<(i32, i32, i32), i32>,
    publish_spawn_child: &wasmtime::TypedFunc<(u32, u32), i32>,
    remove_process: &wasmtime::TypedFunc<u32, i32>,
    reap_exited_child: &wasmtime::TypedFunc<(u32, u32), i32>,
    spawn_exec_target_prepare: &wasmtime::TypedFunc<(u32, u32, u32, u32), i32>,
    exec_target_size: &wasmtime::TypedFunc<(u32, u32), i64>,
    exec_target_read: &wasmtime::TypedFunc<(u32, u32, u32, i32, u32, u32), i32>,
    spawn_exec_commit: &wasmtime::TypedFunc<(u32, u32, u32), i32>,
    exec_target_cancel: &wasmtime::TypedFunc<(u32, u32), i32>,
    exec_target_prepare: &wasmtime::TypedFunc<(u32, u32, i32, u32, u32, u32), i32>,
    exec_commit: &wasmtime::TypedFunc<(u32, u32, u32), i32>,
    exec_target_resolve_shebang: &wasmtime::TypedFunc<(u32, u32, u32, u32), i64>,
    current_memory: &Arc<Mutex<SharedMemory>>,
    current_pid: &Arc<Mutex<u32>>,
    wait_table: &Arc<Mutex<WaitTable>>,
    trace: &mut Vec<u32>,
) -> anyhow::Result<i32> {
    let mut blocked: Vec<BlockedOp> = Vec::new();
    let hard_cap = Instant::now() + Duration::from_secs(30);
    // Set once `processes[0]` (the boot process) posts exit/exit_group; the
    // pump keeps running until every spawned child (`processes[1..]`) has
    // also finished all of its channels (see the return check below and this
    // function's doc comment), so a child's stdout/exit is guaranteed to have
    // landed before this returns even though nothing here waits for it via
    // `waitpid` yet.
    let mut root_exit_code: Option<i32> = None;

    loop {
        if Instant::now() > hard_cap {
            let total_channels: usize = processes.iter().map(|p| p.channels.len()).sum();
            anyhow::bail!(
                "pump timed out after 30s ({} process(es), {total_channels} channel(s), {} blocked op(s))",
                processes.len(),
                blocked.len()
            );
        }
        let mut progressed = false;

        // 1) Re-dispatch parked blocking ops under their tokens. The kernel
        // re-decides readiness each attempt; on a timeout deadline a final
        // non-blocking evaluation ends the wait.
        let mut i = 0;
        while i < blocked.len() {
            let op = blocked[i];
            let proc = &processes[op.process_index];
            let guest_mem = proc.memory.clone();
            let scratch_ptr = proc.scratch_base;
            let pid = proc.pid;
            let mut args = read_channel_args(&guest_mem, op.channel.offset);
            let deadline_passed = op.deadline.is_some_and(|d| Instant::now() >= d);

            let staged = stage_raw(kernel_mem, &guest_mem, scratch_ptr, op.syscall_nr, &mut args)?;
            if deadline_passed {
                force_zero_timeout(kernel_mem, scratch_ptr, op.syscall_nr);
            }
            bind_and_dispatch(
                kernel_store,
                scratch_ptr,
                pid,
                op.channel.tid,
                op.token.max(0),
                set_current_tid,
                handle_channel,
                &guest_mem,
                current_memory,
                current_pid,
            )?;
            let (ret, errno) = read_ret_errno(kernel_mem, scratch_ptr);

            if !deadline_passed && ret == -1 && errno == libc_errno::EAGAIN as u32 {
                i += 1;
                continue; // still blocked
            }
            // N1-I3a Task 3: a parked `wait4` that just resolved (`ret` is the
            // reaped child's pid) releases the kernel's own zombie here — a
            // plain top-level call, never nested inside `host_waitpid` (see
            // its doc comment for why).
            if op.syscall_nr == Syscall::Wait4 as u32 && ret >= 0 {
                let removed = reap_exited_child.call(&mut *kernel_store, (pid, ret as u32))?;
                if removed < 0 {
                    eprintln!(
                        "[host-native] kernel_reap_exited_child({pid},{ret}) after a resolved \
                         parked wait4 failed: {removed}"
                    );
                }
            }
            complete_channel(
                &guest_mem, kernel_mem, scratch_ptr, op.channel, op.syscall_nr, &args, &staged, ret, errno,
            )?;
            if op.token > 0 {
                blocking_retry_release.call(&mut *kernel_store, (pid, op.channel.tid, op.token))?;
            }
            blocked.remove(i);
            progressed = true;
        }

        // 2) Service each live process's live channels' newly posted requests.
        for pi in 0..processes.len() {
            let pid = processes[pi].pid;
            let scratch_ptr = processes[pi].scratch_base;
            let layout = processes[pi].layout;
            let guest_mem = processes[pi].memory.clone();
            let guest_module = processes[pi].module.clone();

            let mut ci = 0;
            while ci < processes[pi].channels.len() {
                let ch = processes[pi].channels[ci];
                // A channel whose request is already parked stays PENDING until
                // the op completes; the retry loop owns it, so do not
                // re-dispatch it here (that would double-process and leak a
                // second retry token).
                if blocked.iter().any(|op| op.process_index == pi && op.channel.offset == ch.offset) {
                    ci += 1;
                    continue;
                }
                let status =
                    unsafe { atomic_u32(&guest_mem, ch.offset + STATUS_OFFSET) }.load(Ordering::SeqCst);
                if status != STATUS_PENDING {
                    ci += 1;
                    continue;
                }
                progressed = true;
                let (syscall_nr, mut args, is_record) = read_channel_request(&guest_mem, ch.offset);
                trace.push(syscall_nr);

                // Process exit on the MAIN channel: the kernel commits the
                // status then traps via kernel_exit's `unreachable`. Only
                // `processes[0]`'s (the boot process) exit marks the run as
                // done, but does not necessarily return immediately (see this
                // function's doc comment: it drains any spawned children
                // first). A spawned child's exit always just commits into the
                // kernel and drops its channel.
                if ch.is_main && (syscall_nr == Syscall::Exit as u32 || syscall_nr == SYS_EXIT_GROUP) {
                    let _ = stage_raw(kernel_mem, &guest_mem, scratch_ptr, syscall_nr, &mut args)?;
                    let _ = bind_and_dispatch(
                        kernel_store, scratch_ptr, pid, ch.tid, 0, set_current_tid, handle_channel,
                        &guest_mem, current_memory, current_pid,
                    );
                    let code = get_exit_status
                        .call(&mut *kernel_store, pid)
                        .unwrap_or(args[0] as i32 & 0xff);
                    if pi == 0 {
                        root_exit_code = Some(code);
                    }
                    // N1-I3a Task 3: record this exit for `host_waitpid`
                    // regardless of whether a parent is parked on it yet —
                    // the parked-retry loop above finds it on a later
                    // iteration (see `run_pump`'s doc comment). Every
                    // process gets a record (including the boot process,
                    // whose `parent_of` sentinel ppid `0` makes it
                    // unwaitable — see `run_guest`), for one uniform path.
                    let signal = get_exit_signal.call(&mut *kernel_store, pid).unwrap_or(0);
                    wait_table.lock().unwrap().exited.insert(pid, encode_wait_status(code, signal));
                    // No one reads a response to this final syscall (whether
                    // this is the boot process or a spawned child), so drop
                    // the channel (like a worker thread's exit) rather than
                    // completing it. A spawned child's exit is now committed
                    // in the kernel's process table (Zombie/Exited) and
                    // recorded in `wait_table`, ready for `host_waitpid` to
                    // resolve a parked or future `waitpid`.
                    processes[pi].channels.remove(ci);
                    continue; // the vec shifted; do not advance ci
                }

                // Worker-thread exit on a NON-main channel: route to
                // kernel_thread_exit (which keeps the shared process — fds,
                // pipes — alive), clear the child-tid futex word for any
                // joiner, then complete and drop the channel so it is no
                // longer polled. This must NOT go to the process-exit path, or
                // it would tear the shared pipe out from under a still-blocked
                // reader.
                if !ch.is_main && syscall_nr == Syscall::Exit as u32 {
                    let ctid = thread_exit.call(&mut *kernel_store, (pid, ch.tid))?;
                    if ctid > 0 {
                        unsafe { write_bytes(&guest_mem, ctid as u32 as usize, &0i32.to_le_bytes()) };
                        let _ = guest_mem.atomic_notify(ctid as u64, 1);
                    }
                    complete_channel(
                        &guest_mem, kernel_mem, scratch_ptr, ch, syscall_nr, &args, &[], 0, 0,
                    )?;
                    processes[pi].channels.remove(ci);
                    continue; // the vec shifted; do not advance ci
                }

                // Thread creation on the MAIN channel: dispatch clone so the
                // kernel allocates the child tid, carve a slot from this
                // process's reserved arena, launch the worker OS thread,
                // register its channel, and return the tid to the caller.
                if ch.is_main && syscall_nr == SYS_CLONE {
                    let fn_ptr = unsafe { read_u32(&guest_mem, ch.offset + DATA_OFFSET) };
                    let arg = unsafe { read_u32(&guest_mem, ch.offset + DATA_OFFSET + 4) };
                    let stack_ptr = args[1] as u32;
                    let tls_ptr = args[3] as u32;

                    let mut clone_args = args;
                    let _ = stage_raw(kernel_mem, &guest_mem, scratch_ptr, syscall_nr, &mut clone_args)?;
                    bind_and_dispatch(
                        kernel_store, scratch_ptr, pid, ch.tid, 0, set_current_tid, handle_channel,
                        &guest_mem, current_memory, current_pid,
                    )?;
                    let (tid, errno) = read_ret_errno(kernel_mem, scratch_ptr);
                    if tid < 0 {
                        complete_channel(
                            &guest_mem, kernel_mem, scratch_ptr, ch, syscall_nr, &args, &[], tid, errno,
                        )?;
                        ci += 1;
                        continue;
                    }
                    let next_thread_slot = processes[pi].next_thread_slot;
                    if next_thread_slot >= RESERVED_THREAD_SLOTS {
                        anyhow::bail!("out of reserved thread slots ({RESERVED_THREAD_SLOTS})");
                    }
                    let slot_page = layout.first_thread_slot_page + next_thread_slot * PAGES_PER_THREAD_SLOT;
                    processes[pi].next_thread_slot += 1;
                    let thread_channel_offset =
                        (slot_page + THREAD_SLOT_CHANNEL_PRIMARY_PAGE) * WASM_PAGE_SIZE;
                    let tls_offset = (slot_page + THREAD_SLOT_TLS_PAGE) * WASM_PAGE_SIZE;
                    // Materialize + zero the whole slot (TLS, fork-save, channel).
                    grow_to_cover(&guest_mem, (slot_page + PAGES_PER_THREAD_SLOT) * WASM_PAGE_SIZE)?;
                    unsafe {
                        write_bytes(
                            &guest_mem,
                            slot_page * WASM_PAGE_SIZE,
                            &vec![0u8; PAGES_PER_THREAD_SLOT * WASM_PAGE_SIZE],
                        );
                    }
                    let worker_handle = spawn_worker_thread(
                        engine,
                        &guest_module,
                        guest_mem.clone(),
                        thread_channel_offset,
                        tls_offset,
                        stack_ptr,
                        tls_ptr,
                        fn_ptr,
                        arg,
                    );
                    processes[pi].channels.push(PumpChannel {
                        offset: thread_channel_offset,
                        tid: tid as u32,
                        is_main: false,
                    });
                    processes[pi].thread_handles.insert(thread_channel_offset, worker_handle);
                    complete_channel(
                        &guest_mem, kernel_mem, scratch_ptr, ch, syscall_nr, &args, &[], tid, 0,
                    )?;
                    ci += 1;
                    continue;
                }

                // posix_spawn (N1-I3a Task 2 / N1-I3b Task 1): a fresh-image
                // child, never a fork. Fully self-contained — decodes the
                // blob, resolves the program through the kernel's exec-target
                // authority against the in-kernel VFS, creates + launches the
                // child, and completes this (parent) channel itself — so just
                // move on.
                if ch.is_main && syscall_nr == SYS_SPAWN {
                    handle_spawn(
                        kernel_store, engine, kernel_mem, processes, pi, ch, &args, alloc_scratch,
                        spawn_blob_decode, spawn_process, publish_spawn_child, remove_process, set_brk_base,
                        set_mmap_base, set_max_addr, spawn_exec_target_prepare, exec_target_size,
                        exec_target_read, spawn_exec_commit, exec_target_cancel,
                        exec_target_resolve_shebang, wait_table,
                    )?;
                    ci += 1;
                    continue;
                }

                // execve (N1-I3c Task 1 happy path, Task 2 failure matrix):
                // image REPLACEMENT in place — the SAME pid keeps running,
                // but a fresh address space and a brand-new instance. Never
                // a new process (that is SYS_SPAWN above), so no
                // `parent_of`/new-pid `wait_table` bookkeeping applies —
                // only the rare fatal-termination case below touches
                // `wait_table` at all (an `exited` record, exactly like a
                // real process exit). `handle_exec_common` does exactly ONE
                // of: (a) replace `processes[pi]` in place (success — see its
                // doc comment for the abandoned-old-thread leak this
                // deliberately accepts), (b) complete THIS channel with a
                // truthful errno (the full failure matrix — see its doc
                // comment), or (c) truthfully terminate `pid` when a
                // post-commit host-side failure leaves no sound way to
                // resume the caller or swap in a working image (returns
                // `Some(fatal_exit_code)`, folded into `root_exit_code`
                // below when this is the boot process). In every case this
                // channel index (`ci`) must not be re-examined this pass: on
                // success `ch` no longer belongs to any live process (its
                // process was just replaced); on an ordinary failure it was
                // already completed by `handle_exec_common`/`fail_exec`; on
                // fatal termination `processes[pi]`'s channels (including
                // `ch`) were just cleared.
                //
                // Wire args (see `libc/musl/src/process/execve.c`'s plain
                // `syscall(SYS_execve, path, argv, envp)`): `args[0]` = path
                // (C-string ptr), `args[1]` = argv, `args[2]` = envp. `execve`
                // always resolves relative to the caller's own cwd with no
                // extra flags, so it calls the shared helper with the fixed
                // `AT_FDCWD`/`flags=0` pair — see the `SYS_EXECVEAT` branch
                // below for the dirfd/flags-carrying sibling.
                if ch.is_main && syscall_nr == SYS_EXECVE {
                    let guest_mem = processes[pi].memory.clone();
                    let path_bytes = read_guest_cstring(&guest_mem, args[0] as u32);
                    let argv_ptr = args[1] as u32;
                    let envp_ptr = args[2] as u32;
                    if let Some(fatal_exit_code) = handle_exec_common(
                        kernel_store, engine, kernel_mem, processes, pi, ch, syscall_nr, &args,
                        open_flags::AT_FDCWD, path_bytes, argv_ptr, envp_ptr, 0, alloc_scratch,
                        set_brk_base, set_mmap_base, set_max_addr, exec_target_prepare, exec_target_size,
                        exec_target_read, exec_commit, exec_target_cancel, exec_target_resolve_shebang,
                        remove_process, wait_table,
                    )? {
                        if pi == 0 {
                            root_exit_code = Some(fatal_exit_code);
                        }
                    }
                    ci += 1;
                    continue;
                }

                // execveat (N1-I3d Task 1): the SAME image-replacement flow
                // as `execve` above, sharing `handle_exec_common` in its
                // entirety — the only difference is where the dirfd/path/
                // flags wire args come from. Wire args (see
                // `libc/musl/src/process/fexecve.c`'s `syscall(SYS_execveat,
                // fd, "", argv, envp, AT_EMPTY_PATH)` — the only in-tree
                // caller, but the general wire shape any raw
                // `syscall(SYS_execveat, dirfd, path, argv, envp, flags)`
                // caller uses): `args[0]` = dirfd (signed fd or `AT_FDCWD`),
                // `args[1]` = path (C-string ptr), `args[2]` = argv,
                // `args[3]` = envp, `args[4]` = flags (e.g. `AT_EMPTY_PATH`
                // for `fexecve`'s fd-only form). The guest's real dirfd and
                // flags are passed straight through to
                // `kernel_exec_target_prepare`, which already resolves an
                // `AT_EMPTY_PATH`+empty-path request against the fd itself —
                // nothing here needs to special-case that combination.
                if ch.is_main && syscall_nr == SYS_EXECVEAT {
                    let guest_mem = processes[pi].memory.clone();
                    let dirfd = args[0] as i32;
                    let path_bytes = read_guest_cstring(&guest_mem, args[1] as u32);
                    let argv_ptr = args[2] as u32;
                    let envp_ptr = args[3] as u32;
                    let flags = args[4] as u32;
                    if let Some(fatal_exit_code) = handle_exec_common(
                        kernel_store, engine, kernel_mem, processes, pi, ch, syscall_nr, &args, dirfd,
                        path_bytes, argv_ptr, envp_ptr, flags, alloc_scratch, set_brk_base, set_mmap_base,
                        set_max_addr, exec_target_prepare, exec_target_size, exec_target_read, exec_commit,
                        exec_target_cancel, exec_target_resolve_shebang, remove_process, wait_table,
                    )? {
                        if pi == 0 {
                            root_exit_code = Some(fatal_exit_code);
                        }
                    }
                    ci += 1;
                    continue;
                }

                let (ret, errno, staged) = dispatch_once(
                    kernel_store, &guest_mem, kernel_mem, scratch_ptr, pid, ch, syscall_nr, is_record,
                    &mut args, 0, set_current_tid, handle_channel, current_memory, current_pid,
                )?;

                if !is_record
                    && ret == -1
                    && errno == libc_errno::EAGAIN as u32
                    && syscall_can_block(syscall_nr)
                {
                    // `wait4` has no fd/OFD target for the kernel's
                    // blocked-retry registry to pin (`BlockingRetryOperation
                    // ::from_syscall` — a workspace-crate table this
                    // host-native-only increment must not edit — has no
                    // entry for it, unlike `poll`'s "host-only-snapshot"
                    // carve-out). It needs no pinning anyway: nothing else
                    // can race a child's exit status out from under a parked
                    // waiter. `token: 0` is exactly the SAME "nothing to
                    // pin" convention `BlockedOp`'s doc comment already
                    // documents for poll.
                    let token = if syscall_nr == Syscall::Wait4 as u32 {
                        0
                    } else {
                        let token =
                            blocking_retry_token.call(&mut *kernel_store, (pid, ch.tid, syscall_nr))?;
                        if token < 0 {
                            anyhow::bail!("kernel_blocking_retry_token({syscall_nr}) failed: {token}");
                        }
                        token
                    };
                    blocked.push(BlockedOp {
                        process_index: pi,
                        channel: ch,
                        syscall_nr,
                        token,
                        deadline: blocking_deadline(syscall_nr, &args),
                    });
                    // Leave the guest parked; do not complete.
                } else {
                    // N1-I3a Task 3: an UNPARKED `wait4` that resolved on its
                    // very first dispatch (the child had already exited
                    // before the parent even called `waitpid`) needs the
                    // same non-nested reap as the parked-retry path above.
                    if syscall_nr == Syscall::Wait4 as u32 && ret >= 0 {
                        let removed = reap_exited_child.call(&mut *kernel_store, (pid, ret as u32))?;
                        if removed < 0 {
                            eprintln!(
                                "[host-native] kernel_reap_exited_child({pid},{ret}) after an \
                                 immediately-resolved wait4 failed: {removed}"
                            );
                        }
                    }
                    complete_channel(
                        &guest_mem, kernel_mem, scratch_ptr, ch, syscall_nr, &args, &staged, ret, errno,
                    )?;
                }
                ci += 1;
            }
        }

        // The boot process has exited AND every spawned child
        // (`processes[1..]`) has finished all of its channels: the run is
        // done. `processes[0]`'s OWN non-main (thread) channels are
        // deliberately excluded from this check — unchanged from before
        // Task 2, a still-blocked worker thread of the boot process does not
        // delay the return (see e.g. `native_thread.c`'s detached writer).
        if let Some(code) = root_exit_code {
            if processes[1..].iter().all(|p| p.channels.is_empty()) {
                return Ok(code);
            }
        }

        // Idle only when nothing was ready this pass, to keep latency low while
        // avoiding a hot spin.
        if !progressed {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

/// N1-I3a Task 2 / N1-I3b Task 1: intercept a `posix_spawn` request posted as
/// `SYS_SPAWN` on a process's main channel. Wire args (see `libc/musl-
/// overlay/src/process/wasm32posix/posix_spawn.c`): arg0/1 = path ptr/len,
/// arg2/3 = blob ptr/len, arg4 = pid_out_ptr — all guest-memory
/// addresses/lengths, since `SYS_SPAWN` is RAW (`wasm_posix_shared::
/// host_raw_syscalls::HOST_RAW_SYSCALLS`), so the pump intercepts it here
/// before any `dispatch_once`/RAW-arg marshalling — exactly like the
/// `SYS_CLONE` branch above.
///
/// Never re-implements the `posix_spawn` guest ABI: the blob is decoded via
/// the kernel's own `kernel_spawn_blob_decode` (to resolve the child's
/// argv/env) and parsed a SECOND time by the kernel's own
/// `kernel_spawn_process` (to build the child `Process`) — this host only
/// stages bytes into kernel memory and reads the decoded framing back. The
/// child's PROGRAM BYTES come from the in-kernel VFS, through the kernel's
/// exec-target authority (N1-I3b Task 1 — no more host-side program map):
/// once `kernel_spawn_process` returns a `child_pid`,
/// `kernel_spawn_exec_target_prepare(parent_pid, child_pid, path)` resolves
/// `path` (the spawn `path` arg, or — if empty — the decoded `argv[0]`)
/// against the CHILD's namespace with `X_OK` and retains an exact executable
/// object behind an opaque token; `read_exec_target_bytes` streams that
/// target's full contents out via `kernel_exec_target_size`/
/// `kernel_exec_target_read`; `Module::new` compiles those bytes (N1-I3b Task
/// 2 moved this compile step BEFORE `kernel_spawn_exec_commit`, deliberately
/// diverging from Task 1's original prepare/read/commit/compile order — see
/// the note at the `Module::new` call site for why: `kernel_spawn_exec_commit`
/// unconditionally consumes the token via the kernel's own `take`, so a
/// `Module::new` failure discovered AFTER commit would have nothing left to
/// `kernel_exec_target_cancel`); and `kernel_spawn_exec_commit` records the
/// child's initial image once every byte has been read AND compiled
/// successfully (see that helper's doc comment for why full coverage is
/// required). An unresolvable `path`/`argv[0]` is a truthful negative-errno
/// token from `prepare`, never a silent success.
///
/// N1-I3b Task 2's full failure/rollback matrix: every failure path reports a
/// truthful errno to the parent (via `fail_spawn`) and leaks neither the
/// child's kernel process-table entry nor a retained exec target. A `prepare`
/// failure (case 1) has no token to cancel — only `kernel_remove_process`
/// runs. A `read_exec_target_bytes` or `Module::new` failure (case 2) has a
/// target STILL retained (never committed) — `kernel_exec_target_cancel`
/// runs before `kernel_remove_process`. A `kernel_spawn_exec_commit` failure
/// (case 3) runs the same cancel-then-remove sequence best-effort, even
/// though the kernel's own `take` inside commit usually already consumed the
/// token (see that call site's note) — belt-and-suspenders against any commit
/// failure path that does not reach `take`.
///
/// N1-I3d Task 3 inserts `apply_shebang` right after `prepare` succeeds,
/// before any of the above: `ShebangError::Resolved` means the kernel's
/// `kernel_exec_target_resolve_shebang` export itself failed (including
/// `ENOEXEC` for a nested `#!` chain) and already released every token it
/// touched — same shape as case 1, only `rollback_spawned_child` (no
/// cancel). `ShebangError::ScratchAlloc` means `apply_shebang`'s OWN scratch
/// allocation failed before the export was even called — `token` (from
/// `prepare`) is still retained, so this runs `rollback_exec_target` (cancel
/// then remove), the same shape as case 2. On success, `token` and
/// `argv_list` are REBOUND to the resolved interpreter's target and the `#!`
/// argv-prefix + `orig_argv[1..]` — cases 2 and 3 below, and the successful
/// launch, all operate on the resolved values, never the original script's.
///
/// On success: launches the child as a brand-new `GuestProcess` (Task 1's
/// `compute_guest_memory`/`launch_process` — a fresh image, never a fork),
/// pushes it onto `processes`, publishes the parent/child edge
/// (`kernel_publish_spawn_child`), writes the child pid to the parent's
/// `pid_out_ptr`, and completes the parent's channel with `ret == 0` (POSIX's
/// `posix_spawn` success encoding; see `posix_spawn.c`'s `if (ret < 0) return
/// -ret;` — a non-negative `ret` is returned to the caller as-is). On any
/// failure, completes the parent's channel with `ret == -1` and a positive
/// errno instead (`__do_syscall_impl`'s own `-errno`-on-negative convention).
/// A `kernel_publish_spawn_child` `-ECHILD` rejection rolls the kernel's
/// process-table entry back via `kernel_remove_process` (see that call site
/// below for the one remaining, documented gap: the already-launched OS
/// thread/Wasmtime instance itself is not torn down).
///
/// Once fully published, the child is recorded in `wait_table` under its
/// REAL parent pid (N1-I3a Task 3's `host_waitpid` reaps it later — see that
/// closure's doc comment). The child, once launched, simply runs; its
/// stdout/stderr land in the SAME captured buffers as every other process
/// (`host_write` is keyed by fd, not by process — see `define_kernel_host_
/// imports`), which is how the spawn/wait tests observe it ran.
#[allow(clippy::too_many_arguments)]
fn handle_spawn(
    kernel_store: &mut Store<()>,
    engine: &Engine,
    kernel_mem: &SharedMemory,
    processes: &mut Vec<GuestProcess>,
    pi: usize,
    ch: PumpChannel,
    args: &[i64; 6],
    alloc_scratch: &wasmtime::TypedFunc<u32, i32>,
    spawn_blob_decode: &wasmtime::TypedFunc<(i32, i32, i32), i32>,
    spawn_process: &wasmtime::TypedFunc<(u32, u32, i32, i32), i32>,
    publish_spawn_child: &wasmtime::TypedFunc<(u32, u32), i32>,
    remove_process: &wasmtime::TypedFunc<u32, i32>,
    set_brk_base: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_mmap_base: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_max_addr: &wasmtime::TypedFunc<(u32, i32), i32>,
    spawn_exec_target_prepare: &wasmtime::TypedFunc<(u32, u32, u32, u32), i32>,
    exec_target_size: &wasmtime::TypedFunc<(u32, u32), i64>,
    exec_target_read: &wasmtime::TypedFunc<(u32, u32, u32, i32, u32, u32), i32>,
    spawn_exec_commit: &wasmtime::TypedFunc<(u32, u32, u32), i32>,
    exec_target_cancel: &wasmtime::TypedFunc<(u32, u32), i32>,
    exec_target_resolve_shebang: &wasmtime::TypedFunc<(u32, u32, u32, u32), i64>,
    wait_table: &Arc<Mutex<WaitTable>>,
) -> anyhow::Result<()> {
    let parent_pid = processes[pi].pid;
    let caller_tid = ch.tid;
    let guest_mem = processes[pi].memory.clone();

    let path_ptr = args[0] as u32 as usize;
    let path_len = args[1] as u32 as usize;
    let blob_ptr = args[2] as u32 as usize;
    let blob_len = args[3] as u32 as usize;
    let pid_out_ptr = args[4] as u32 as usize;

    if blob_len == 0 {
        return fail_spawn(&guest_mem, kernel_mem, ch, args, libc_errno::EINVAL);
    }
    // `kernel_spawn_process` itself rejects `blob_len > MIN_CHANNEL_SIZE`
    // with E2BIG; check the same bound here (before wasting a scratch
    // allocation on a blob that can never be spawned) and report the same
    // errno for consistency.
    if blob_len > MIN_CHANNEL_SIZE {
        return fail_spawn(&guest_mem, kernel_mem, ch, args, libc_errno::E2BIG);
    }

    let path_bytes = unsafe { read_bytes(&guest_mem, path_ptr, path_len) };
    let path_str = String::from_utf8_lossy(&path_bytes).into_owned();
    let blob_bytes = unsafe { read_bytes(&guest_mem, blob_ptr, blob_len) };

    // Stage the blob into a fresh kernel-memory scratch region — both
    // `kernel_spawn_blob_decode` and `kernel_spawn_process` require a
    // kernel-owned range, never a raw guest address: the two engines run in
    // separate Wasmtime instances with separate memories (this file's module
    // doc comment).
    let scratch = alloc_scratch.call(&mut *kernel_store, blob_len as u32)?;
    if scratch <= 0 {
        return fail_spawn(&guest_mem, kernel_mem, ch, args, libc_errno::ENOMEM);
    }
    let scratch = scratch as u32 as usize;

    unsafe { write_bytes(kernel_mem, scratch, &blob_bytes) };
    let decoded_len =
        spawn_blob_decode.call(&mut *kernel_store, (scratch as i32, blob_len as i32, blob_len as i32))?;
    if decoded_len < 0 {
        return fail_spawn(&guest_mem, kernel_mem, ch, args, -decoded_len);
    }
    let (argv_list, envp_list) = read_decoded_argv_envp(kernel_mem, scratch);

    // `kernel_spawn_blob_decode` overwrote `scratch` in place; re-stage the
    // untouched RAW blob bytes before `kernel_spawn_process`'s own parse.
    unsafe { write_bytes(kernel_mem, scratch, &blob_bytes) };
    let child_pid =
        spawn_process.call(&mut *kernel_store, (parent_pid, caller_tid, scratch as i32, blob_len as i32))?;
    if child_pid <= 0 {
        let errno = if child_pid < 0 { -child_pid } else { libc_errno::EIO };
        return fail_spawn(&guest_mem, kernel_mem, ch, args, errno);
    }
    let child_pid = child_pid as u32;

    // N1-I3b: resolve the child's program bytes from the in-kernel VFS,
    // through the kernel's exec-target authority, against the CHILD's namespace
    // (never the parent's — see `kernel_spawn_exec_target_prepare`'s doc
    // comment). Per POSIX the spawn `path` argument is authoritative: an empty
    // `path` is NOT resolved from `argv[0]` — it is passed through and the
    // kernel rejects it with ENOENT (`kernel_spawn_exec_target_prepare`,
    // wasm_api.rs:3073-3074), which is the correct posix_spawn failure.
    let resolve_bytes = path_str.as_bytes();
    let path_scratch = alloc_scratch.call(&mut *kernel_store, resolve_bytes.len() as u32)?;
    if path_scratch <= 0 {
        rollback_spawned_child(kernel_store, remove_process, child_pid, "a scratch-allocation failure resolving the exec target");
        return fail_spawn(&guest_mem, kernel_mem, ch, args, libc_errno::ENOMEM);
    }
    let path_scratch = path_scratch as u32 as usize;
    unsafe { write_bytes(kernel_mem, path_scratch, resolve_bytes) };

    let token = spawn_exec_target_prepare.call(
        &mut *kernel_store,
        (parent_pid, child_pid, path_scratch as u32, resolve_bytes.len() as u32),
    )?;
    if token < 0 {
        // Resolution failure (e.g. ENOENT/EACCES/ENOTDIR from the kernel's
        // path walk): no target was ever retained, so there is nothing to
        // cancel — just reclaim the child's unpublished Process record and
        // report the truthful errno. This is case 1 of N1-I3b Task 2's
        // failure/rollback matrix.
        rollback_spawned_child(kernel_store, remove_process, child_pid, "a kernel_spawn_exec_target_prepare failure");
        return fail_spawn(&guest_mem, kernel_mem, ch, args, -token);
    }
    let token = token as u32;

    // N1-I3d Task 3: resolve `token`'s `#!` chain in the kernel BEFORE
    // streaming any bytes — a `#!` script's own bytes are never a valid Wasm
    // module (see the `Module::new` ENOEXEC handling below), so the target
    // this function goes on to read/compile/commit must already be the
    // resolved INTERPRETER's target, never the script's. `apply_shebang`
    // does no shebang decision logic itself; it only calls the kernel export
    // and decodes the record it returns (see its doc comment). On success,
    // `token` is rebound to `final_token` (the interpreter's token when the
    // input was a script, or the unchanged input token otherwise) and
    // `argv_list` is rebound to the resolved launch argv (the `#!`
    // argv-prefix + `orig_argv[1..]`, or `argv_list` unchanged).
    let (token, argv_list) = match apply_shebang(
        kernel_store,
        kernel_mem,
        exec_target_resolve_shebang,
        alloc_scratch,
        child_pid,
        token,
        &argv_list,
    )? {
        Ok(pair) => pair,
        Err(ShebangError::ScratchAlloc(errno)) => {
            // `apply_shebang`'s OWN scratch allocation failed before the
            // kernel export was ever called — `token` (from `prepare`
            // above) is still fully retained, exactly like the
            // `read_scratch <= 0` case just below. Same rollback shape.
            rollback_exec_target(
                kernel_store, exec_target_cancel, remove_process, child_pid, token,
                "a shebang-record scratch-allocation failure",
            );
            return fail_spawn(&guest_mem, kernel_mem, ch, args, errno);
        }
        Err(ShebangError::Resolved(errno)) => {
            // `kernel_exec_target_resolve_shebang` itself returned a
            // negative errno. Per its contract, the kernel already released
            // every token it touched (the input token AND any
            // half-resolved interpreter token) on this failure path — same
            // shape as the `spawn_exec_target_prepare` failure above:
            // nothing here to cancel, only the still-unpublished child
            // Process record to reclaim.
            rollback_spawned_child(
                kernel_store, remove_process, child_pid,
                "a kernel_exec_target_resolve_shebang failure",
            );
            return fail_spawn(&guest_mem, kernel_mem, ch, args, errno);
        }
    };

    // Stream the retained target's full contents out of the kernel into host
    // memory, through a fixed-size scratch region — a FRESH allocation, since
    // the blob-decode scratch above is a different, already-consumed region.
    // `prepare`/`apply_shebang` above already retained a target under
    // `token`, so from here on any failure must run through
    // `rollback_exec_target` (cancel THEN remove — N1-I3b Task 2's
    // target-retained branches), never the bare `rollback_spawned_child` the
    // earlier `prepare`-failure branch uses.
    let read_scratch = alloc_scratch.call(&mut *kernel_store, EXEC_TARGET_READ_CHUNK)?;
    if read_scratch <= 0 {
        rollback_exec_target(
            kernel_store, exec_target_cancel, remove_process, child_pid, token,
            "a scratch-allocation failure reading the exec target",
        );
        return fail_spawn(&guest_mem, kernel_mem, ch, args, libc_errno::ENOMEM);
    }
    let program_bytes = match read_exec_target_bytes(
        kernel_store,
        kernel_mem,
        exec_target_size,
        exec_target_read,
        read_scratch as u32,
        EXEC_TARGET_READ_CHUNK,
        child_pid,
        token,
    )? {
        Ok(bytes) => bytes,
        Err(errno) => {
            // Case 2 of the failure/rollback matrix: the target was
            // retained by `prepare` but its bytes could not be fully read
            // back (a kernel-reported size/read errno, or a short read that
            // left the coverage check unsatisfiable). The target is still
            // retained — cancel it before reclaiming the child.
            rollback_exec_target(
                kernel_store, exec_target_cancel, remove_process, child_pid, token,
                "a read_exec_target_bytes failure",
            );
            return fail_spawn(&guest_mem, kernel_mem, ch, args, errno);
        }
    };

    // Case 2 (continued): the bytes read back fully and cleanly, but they
    // are not a well-formed Wasm module. `apply_shebang` above already
    // resolved any `#!` chain in the kernel (exactly one level; a nested
    // chain is a `ShebangError::Resolved(ENOEXEC)` handled above, well
    // before this point), so `token`/`program_bytes` here are always the
    // INTERPRETER's — a non-wasm target reaching `Module::new` is therefore
    // a genuinely malformed executable, not an unresolved script. Catch
    // `Module::new`'s error instead of letting it `?`-propagate into a
    // pump-ending `bail!`: a bad exec target is a per-spawn POSIX failure
    // (`ENOEXEC`, mirroring Node's `isWasmModuleBytes` -> `ENOEXEC` in
    // `host/src/exec-target.ts:453`), not a host/kernel malfunction. The
    // target is still retained at this point (never committed), so cancel
    // it before reclaiming the child.
    let child_module = match Module::new(engine, &program_bytes) {
        Ok(module) => module,
        Err(_) => {
            rollback_exec_target(
                kernel_store, exec_target_cancel, remove_process, child_pid, token,
                "a Module::new compile failure (non-wasm exec target bytes)",
            );
            return fail_spawn(&guest_mem, kernel_mem, ch, args, libc_errno::ENOEXEC);
        }
    };

    let commit = spawn_exec_commit.call(&mut *kernel_store, (parent_pid, child_pid, token))?;
    if commit < 0 {
        // Case 3: `kernel_spawn_exec_commit` already `take`s the target out
        // of the child's ledger before validating, so on most commit
        // failures the token is already consumed and a `cancel` call here is
        // a harmless best-effort no-op (it will itself fail, logged, because
        // the ledger no longer holds the token). Call it anyway — cheap
        // insurance against any commit-failure path that does NOT reach that
        // `take` and so leaves the target retained — before reclaiming the
        // child, per this function's no-leak contract.
        rollback_exec_target(
            kernel_store, exec_target_cancel, remove_process, child_pid, token,
            "a kernel_spawn_exec_commit failure",
        );
        return fail_spawn(&guest_mem, kernel_mem, ch, args, -commit);
    }
    let (child_mem, child_layout) = compute_guest_memory(engine, &child_module)?;
    let child_import_exit_status = Arc::new(Mutex::new(None::<i32>));
    let child = launch_process(
        engine,
        kernel_store,
        alloc_scratch,
        set_brk_base,
        set_mmap_base,
        set_max_addr,
        child_module,
        child_mem,
        child_layout,
        child_pid,
        child_import_exit_status,
        Arc::new(argv_list),
        Arc::new(envp_list),
    )?;
    processes.push(child);
    let child_pi = processes.len() - 1;

    let disposition = publish_spawn_child.call(&mut *kernel_store, (parent_pid, child_pid))?;
    if disposition < -1 {
        // The kernel rejected publication. Per `publish_spawn_child`'s
        // documented contract (crates/runtime-core/src/process_table.rs
        // ~:1517-1550): `-ESRCH` means the child is ALREADY absent (already
        // self-reaped/removed — nothing left to remove), `-EINVAL` means bad
        // arguments (the child was never a pending spawn publication — also
        // nothing to remove), and `-ECHILD` SPECIFICALLY means the child's
        // Process record still exists, unpublished, because the PARENT
        // disappeared out from under this call — that record must be
        // reclaimed via the host's rollback seam (`kernel_remove_process`),
        // exactly like the Node reference host's
        // `#rollbackSpawnWithinKernelEntry` does on `-ECHILD`. Best-effort:
        // log rather than fail the whole run if the removal itself errors.
        if disposition == -(libc_errno::ECHILD as i32) {
            let removed = remove_process.call(&mut *kernel_store, child_pid)?;
            if removed < 0 {
                eprintln!(
                    "[host-native] kernel_remove_process({child_pid}) after a -ECHILD spawn-publish \
                     rejection failed: {removed}"
                );
            }
            // N1-R Task 2: also reclaim the just-launched child's OWN
            // OS thread/Wasmtime instance — the same `reclaim_all_channels`
            // teardown-sentinel path `handle_exec_common` uses on a
            // successful exec — instead of leaving it running forever
            // against a process the kernel just erased. `child_pi` is
            // guaranteed to still be `processes.len() - 1`: nothing else
            // pushes to `processes` between the push above and this
            // synchronous check, so `pop()` removes exactly (and only) the
            // rejected child, disturbing no other process's index.
            debug_assert_eq!(child_pi, processes.len() - 1);
            if let Some(child_proc) = processes.pop() {
                reclaim_all_channels(child_proc);
            }
        }
        // Reclamation above is best-effort, same as `kernel_remove_process`
        // just above it: a child whose thread has not yet posted its first
        // syscall (not yet PARKED — see `reclaim_all_channels`'s doc
        // comment) cannot be safely joined here either, and is the same
        // documented residual as a compute-bound execve sibling. Report the
        // truthful failure to the parent rather than claiming success.
        return fail_spawn(&guest_mem, kernel_mem, ch, args, -disposition);
    }

    // N1-I3a Task 3: the child is fully published now (won't be rolled back
    // above), so it becomes waitable by its REAL parent. This must happen
    // before returning — the child's own OS thread is already running
    // concurrently and could exit (posting on its channel, processed by a
    // later pump iteration) before this function returns.
    wait_table.lock().unwrap().parent_of.insert(child_pid, parent_pid);

    if pid_out_ptr != 0 {
        unsafe { write_bytes(&guest_mem, pid_out_ptr, &(child_pid as i32).to_le_bytes()) };
    }
    complete_channel(&guest_mem, kernel_mem, 0, ch, SYS_SPAWN, args, &[], 0, 0)
}

/// Complete a failed `SYS_SPAWN` request: `ret == -1` and a positive errno,
/// matching `__do_syscall_impl`'s `if (result < 0) return -(long)err;`
/// convention (`posix_spawn.c` then returns that errno value directly, per
/// POSIX — it never sets the global `errno`). No child is left behind on any
/// of this function's call sites except the one documented in `handle_spawn`.
fn fail_spawn(
    guest_mem: &SharedMemory,
    kernel_mem: &SharedMemory,
    ch: PumpChannel,
    args: &[i64; 6],
    errno: i32,
) -> anyhow::Result<()> {
    complete_channel(guest_mem, kernel_mem, 0, ch, SYS_SPAWN, args, &[], -1, errno as u32)
}

/// N1-I3c Task 1 / N1-I3d Task 1: the shared image-replacement body behind
/// BOTH `execve`'s `SYS_EXECVE` and `execveat`'s `SYS_EXECVEAT` requests
/// posted on a process's MAIN channel. Either syscall REPLACES the CALLING
/// process's image IN PLACE — same pid, fresh address space, a brand-new
/// module instance running the new program — never a new process (that is
/// `SYS_SPAWN`/[`handle_spawn`]). The two syscalls differ only in where their
/// wire args come from (`SYS_EXECVE` has no dirfd/flags; `SYS_EXECVEAT` reads
/// a real dirfd and flags word — see each `run_pump` branch's doc comment for
/// the exact wire layout): the caller has already read `dirfd`, `path_bytes`,
/// `argv_ptr`, `envp_ptr`, and `flags` out of guest memory (or fixed them at
/// `AT_FDCWD`/`0` for plain `execve`) by the time it calls this function.
///
/// Drives the SAME exec-target authority [`handle_spawn`] uses
/// (`kernel_exec_target_prepare` -> [`read_exec_target_bytes`] ->
/// `Module::new` -> `kernel_exec_commit`), but resolves `path` against THIS
/// process's OWN namespace/credentials (`kernel_exec_target_prepare`, not
/// the spawn family's not-yet-launched-child variant) and commits the pure
/// in-kernel POSIX exec transition (`kernel_exec_commit`: cloexec fds,
/// set-ID creds, signal reset, memory-accounting reset, `clear_threads`,
/// `exec_generation` bump) instead of publishing a new child.
///
/// N1-I3c Task 2 hardens Task 1's happy path plus basic failure handling
/// into the FULL POSIX failure/rollback matrix, whose crux is the success/
/// failure ASYMMETRY: a failed `execve`/`execveat` is an ORDINARY syscall
/// that RETURNS to the caller (the OLD image keeps running), so every
/// failure branch that does not reach `kernel_exec_commit` completes `ch`
/// (the caller's own channel) with the truthful errno via [`fail_exec`] and
/// performs NO image swap; a `kernel_exec_commit` SUCCESS never resumes the
/// caller (see the swap site below). The matrix:
///   1. `read_guest_string_array` fault or `kernel_exec_target_prepare`
///      returning `token < 0`: no target was ever retained, so there is
///      nothing to cancel — just [`fail_exec`] with the truthful errno.
///   1b. (N1-I3d Task 3) `apply_shebang` resolving `token`'s `#!` chain:
///      `ShebangError::Resolved` means `kernel_exec_target_resolve_shebang`
///      itself failed (including `ENOEXEC` for a nested `#!` chain) and the
///      kernel already released every token it touched — same shape as
///      case 1, nothing to cancel. `ShebangError::ScratchAlloc` means
///      `apply_shebang`'s OWN scratch allocation failed before the export
///      was even called — `token` is still retained, so this cancels it
///      first (same shape as case 2's `read_scratch` sub-case). On success,
///      `token` and `argv_list` are REBOUND to the resolved interpreter's
///      target and the `#!` argv-prefix + `orig_argv[1..]` — everything
///      from here on (case 2/3/4, and a successful swap) operates on the
///      resolved values, never the original script's.
///   2. A `read_exec_target_bytes` errno OR a `Module::new` compile
///      failure — by this point `apply_shebang` has already resolved any
///      `#!` chain (exactly one level; deeper nesting is case 1b's
///      `ENOEXEC`), so a non-wasm target reaching `Module::new` here is a
///      genuinely malformed executable, mirroring `handle_spawn`'s
///      identical `Module::new` handling: the target IS retained under
///      `token` at this point, so `kernel_exec_target_cancel`
///      ([`cancel_exec_target`], best-effort) runs FIRST, then
///      [`fail_exec`] with the mapped errno (read) or `ENOEXEC` (compile)
///      resumes the caller. `Module::new`'s `Err` is matched explicitly
///      here — never allowed to `?`-propagate into a pump-ending `bail!` —
///      exactly like `handle_spawn`'s `child_module` handling.
///   3. `kernel_exec_commit` returning `commit < 0`: the target is still
///      retained (commit failed before consuming it) — cancel it
///      ([`cancel_exec_target`], best-effort), then [`fail_exec`] with
///      `-commit`. NO swap.
///   4. A `compute_guest_memory`/`launch_process` failure AFTER
///      `kernel_exec_commit` already returned `0`: see
///      [`terminate_process_after_failed_exec_commit`]'s doc comment — this
///      is the one case that can neither resume the caller NOR swap in a
///      working new image, so it truthfully terminates `pid` instead.
///
/// On success (`commit == 0` and the host-side relaunch also succeeds):
/// computes a fresh address space ([`compute_guest_memory`]) and launches a
/// brand-new [`GuestProcess`] for the SAME `pid` ([`launch_process`] —
/// exactly `handle_spawn`'s launch sequence, but reusing the exec'ing
/// process's own pid rather than a freshly allocated one), then overwrites
/// `processes[pi]` with it. The calling channel `ch` is DELIBERATELY never
/// completed — see the inline comment at the swap site for why waking it
/// with a normal completion would be unsound. Instead (N1-R Task 2) the OLD
/// `GuestProcess` — `ch`'s channel AND any other live channel it still owns
/// (a still-running worker/pthread thread) — is handed to
/// `reclaim_all_channels`, which tears down and joins every one of them
/// that is genuinely PARKED in its wait; a compute-bound sibling thread that
/// is NOT parked at that moment is the one residual this does not chase
/// (see that function's doc comment) — it cannot be interrupted by this
/// cooperative mechanism and is left, unjoined, exactly as the whole old
/// process used to be before this task.
///
/// Returns `Ok(None)` for every ordinary outcome (the channel was completed,
/// or the image was swapped). Returns `Ok(Some(fatal_exit_code))` only for
/// case 4 above, so `run_pump`'s caller can fold it into `root_exit_code`
/// when `pi == 0` — see [`terminate_process_after_failed_exec_commit`].
#[allow(clippy::too_many_arguments)]
fn handle_exec_common(
    kernel_store: &mut Store<()>,
    engine: &Engine,
    kernel_mem: &SharedMemory,
    processes: &mut Vec<GuestProcess>,
    pi: usize,
    ch: PumpChannel,
    syscall_nr: u32,
    args: &[i64; 6],
    dirfd: i32,
    path_bytes: Vec<u8>,
    argv_ptr: u32,
    envp_ptr: u32,
    flags: u32,
    alloc_scratch: &wasmtime::TypedFunc<u32, i32>,
    set_brk_base: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_mmap_base: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_max_addr: &wasmtime::TypedFunc<(u32, i32), i32>,
    exec_target_prepare: &wasmtime::TypedFunc<(u32, u32, i32, u32, u32, u32), i32>,
    exec_target_size: &wasmtime::TypedFunc<(u32, u32), i64>,
    exec_target_read: &wasmtime::TypedFunc<(u32, u32, u32, i32, u32, u32), i32>,
    exec_commit: &wasmtime::TypedFunc<(u32, u32, u32), i32>,
    exec_target_cancel: &wasmtime::TypedFunc<(u32, u32), i32>,
    exec_target_resolve_shebang: &wasmtime::TypedFunc<(u32, u32, u32, u32), i64>,
    remove_process: &wasmtime::TypedFunc<u32, i32>,
    wait_table: &Arc<Mutex<WaitTable>>,
) -> anyhow::Result<Option<i32>> {
    let pid = processes[pi].pid;
    let caller_tid = ch.tid;
    let guest_mem = processes[pi].memory.clone();

    let argv_list = match read_guest_string_array(&guest_mem, argv_ptr, PROCESS_STARTUP_MAX_ARGV_COUNT) {
        Ok(list) => list,
        Err(errno) => return fail_exec(&guest_mem, kernel_mem, ch, syscall_nr, args, -errno).map(|()| None),
    };
    let envp_list = match read_guest_string_array(&guest_mem, envp_ptr, PROCESS_STARTUP_MAX_ARGV_COUNT) {
        Ok(list) => list,
        Err(errno) => return fail_exec(&guest_mem, kernel_mem, ch, syscall_nr, args, -errno).map(|()| None),
    };

    // Stage the path into a KERNEL-memory scratch region: `kernel_exec_
    // target_prepare` requires a kernel-owned range, exactly like
    // `handle_spawn`'s `resolve_bytes` staging — the two engines run in
    // separate Wasmtime instances with separate memories (this file's
    // module doc comment).
    let path_scratch = alloc_scratch.call(&mut *kernel_store, path_bytes.len() as u32)?;
    if path_scratch <= 0 {
        return fail_exec(&guest_mem, kernel_mem, ch, syscall_nr, args, libc_errno::ENOMEM).map(|()| None);
    }
    let path_scratch = path_scratch as u32 as usize;
    unsafe { write_bytes(kernel_mem, path_scratch, &path_bytes) };

    let token = exec_target_prepare.call(
        &mut *kernel_store,
        (pid, caller_tid, dirfd, path_scratch as u32, path_bytes.len() as u32, flags),
    )?;
    if token < 0 {
        // Case 1: no target was ever retained on a `prepare` failure, so
        // there is nothing to cancel — just resume the caller with the
        // truthful errno.
        return fail_exec(&guest_mem, kernel_mem, ch, syscall_nr, args, -token).map(|()| None);
    }
    let token = token as u32;

    // N1-I3d Task 3: resolve `token`'s `#!` chain in the kernel BEFORE
    // streaming any bytes — see `handle_spawn`'s identical call site for the
    // full rationale. `apply_shebang` does no shebang decision logic itself;
    // it only calls the kernel export and decodes the record it returns
    // (see its doc comment). On success, `token` is rebound to
    // `final_token` and `argv_list` is rebound to the resolved launch argv.
    let (token, argv_list) = match apply_shebang(
        kernel_store,
        kernel_mem,
        exec_target_resolve_shebang,
        alloc_scratch,
        pid,
        token,
        &argv_list,
    )? {
        Ok(pair) => pair,
        Err(ShebangError::ScratchAlloc(errno)) => {
            // `apply_shebang`'s OWN scratch allocation failed before the
            // kernel export was ever called — `token` (from `prepare`
            // above) is still fully retained, exactly like the
            // `read_scratch <= 0` case just below. Same rollback shape.
            cancel_exec_target(
                kernel_store, exec_target_cancel, pid, token, "a shebang-record scratch-allocation failure",
            );
            return fail_exec(&guest_mem, kernel_mem, ch, syscall_nr, args, errno).map(|()| None);
        }
        Err(ShebangError::Resolved(errno)) => {
            // `kernel_exec_target_resolve_shebang` itself returned a
            // negative errno. Per its contract, the kernel already released
            // every token it touched (the input token AND any
            // half-resolved interpreter token) on this failure path —
            // exactly like Case 1's `prepare` failure above: nothing here
            // to cancel.
            return fail_exec(&guest_mem, kernel_mem, ch, syscall_nr, args, errno).map(|()| None);
        }
    };

    let read_scratch = alloc_scratch.call(&mut *kernel_store, EXEC_TARGET_READ_CHUNK)?;
    if read_scratch <= 0 {
        cancel_exec_target(kernel_store, exec_target_cancel, pid, token, "a scratch-allocation failure");
        return fail_exec(&guest_mem, kernel_mem, ch, syscall_nr, args, libc_errno::ENOMEM).map(|()| None);
    }
    let program_bytes = match read_exec_target_bytes(
        kernel_store,
        kernel_mem,
        exec_target_size,
        exec_target_read,
        read_scratch as u32,
        EXEC_TARGET_READ_CHUNK,
        pid,
        token,
    )? {
        Ok(bytes) => bytes,
        Err(errno) => {
            // Case 2: the target was retained by `prepare`/`apply_shebang`
            // but its bytes could not be fully read back — cancel it before
            // resuming the caller.
            cancel_exec_target(
                kernel_store, exec_target_cancel, pid, token, "a read_exec_target_bytes failure",
            );
            return fail_exec(&guest_mem, kernel_mem, ch, syscall_nr, args, errno).map(|()| None);
        }
    };

    // Case 2 (continued): the bytes read back fully and cleanly, but they
    // are not a well-formed Wasm module. `apply_shebang` above already
    // resolved any `#!` chain in the kernel (exactly one level; a nested
    // chain is a `ShebangError::Resolved(ENOEXEC)` handled above, well
    // before this point), so `token`/`program_bytes` here are always the
    // INTERPRETER's — a non-wasm target reaching `Module::new` is therefore
    // a genuinely malformed executable, not an unresolved script. Catch
    // `Module::new`'s error instead of letting it `?`-propagate into a
    // pump-ending `bail!`: a bad exec target is a per-`execve`/`execveat`
    // POSIX failure (`ENOEXEC`), not a host/kernel malfunction, mirroring
    // `handle_spawn`'s `child_module` handling exactly. The target is still
    // retained at this point (never committed), so cancel it before
    // resuming the caller.
    let new_module = match Module::new(engine, &program_bytes) {
        Ok(module) => module,
        Err(_) => {
            cancel_exec_target(
                kernel_store, exec_target_cancel, pid, token,
                "a Module::new compile failure (non-wasm exec target bytes)",
            );
            return fail_exec(&guest_mem, kernel_mem, ch, syscall_nr, args, libc_errno::ENOEXEC)
                .map(|()| None);
        }
    };

    let commit = exec_commit.call(&mut *kernel_store, (pid, caller_tid, token))?;
    if commit < 0 {
        // Case 3: `kernel_exec_commit` failed before consuming the retained
        // target (or left it retained on this path) — cancel it, best-effort,
        // before resuming the caller. NO swap.
        cancel_exec_target(kernel_store, exec_target_cancel, pid, token, "a kernel_exec_commit failure");
        return fail_exec(&guest_mem, kernel_mem, ch, syscall_nr, args, -commit).map(|()| None);
    }

    // --- SUCCESS: `kernel_exec_commit` returned 0, so the kernel already
    // completed the POSIX exec transition (cloexec fds, set-ID creds,
    // signal reset, memory-accounting reset, clear_threads, exec_generation
    // bump) for THIS pid. Now build the host-side half: a fresh address
    // space and a brand-new module instance running the new program, on the
    // SAME pid `launch_process` re-pushes brk/mmap/max-addr for (required
    // because commit just reset the kernel's memory accounting).
    //
    // Case 4: from here on, a failure can no longer be reported to the
    // caller (the kernel has already committed the new program; there is no
    // "old image" left to truthfully resume) — see
    // `terminate_process_after_failed_exec_commit`'s doc comment.
    let (new_mem, new_layout) = match compute_guest_memory(engine, &new_module) {
        Ok(v) => v,
        Err(error) => {
            return Ok(Some(terminate_process_after_failed_exec_commit(
                kernel_store, processes, pi, pid, remove_process, wait_table,
                "compute_guest_memory", &error,
            )));
        }
    };
    let new_proc = match launch_process(
        engine,
        kernel_store,
        alloc_scratch,
        set_brk_base,
        set_mmap_base,
        set_max_addr,
        new_module,
        new_mem,
        new_layout,
        pid,
        Arc::new(Mutex::new(None)),
        Arc::new(argv_list),
        Arc::new(envp_list),
    ) {
        Ok(v) => v,
        Err(error) => {
            return Ok(Some(terminate_process_after_failed_exec_commit(
                kernel_store, processes, pi, pid, remove_process, wait_table,
                "launch_process", &error,
            )));
        }
    };

    // N1-R Task 2: the exec'ing guest thread — this channel's OS thread,
    // `ch` — is right now parked in a REAL Wasm `memory.atomic.wait32` on
    // `ch`'s status word, inside the OLD, now-superseded module instance
    // and memory. We never COMPLETE `ch` (`kernel_exec_commit` already
    // performed the actual POSIX exec transition in the kernel, so waking
    // it with a normal completion would resume execution inside the doomed
    // PRE-exec instance — exactly the image POSIX `execve`/`execveat` just
    // replaced), but we do RECLAIM it: swap `new_proc` into `processes[pi]`
    // first (so the pump starts servicing it from the very next loop
    // iteration), take the OLD `GuestProcess` out, and hand it to
    // `reclaim_all_channels`, which publishes `CH_TEARDOWN` + notifies each
    // of its PARKED channels (not just `ch` — see that function's doc
    // comment for the multi-channel case and its documented compute-bound
    // residual) and `join()`s each one's `JoinHandle`. The guest glue
    // (`channel_syscall.c`, N1-R Task 1) traps immediately on observing
    // `TEARDOWN` instead of resuming, so this is sound: no parked thread
    // resumes the doomed image, and none leaks anymore (validated by the
    // spike, `docs/plans/2026-09-05-native-thread-reclamation-spike.md`,
    // `exp_d`).
    let old_proc = std::mem::replace(&mut processes[pi], new_proc);
    reclaim_all_channels(old_proc);
    Ok(None)
}

/// N1-I3c Task 2's execve-only analog of [`rollback_exec_target`]: cancels a
/// retained target under `token` (best-effort — logs on failure/trap rather
/// than failing the whole run) WITHOUT `handle_spawn`'s
/// `rollback_spawned_child` step, because an `execve` failure never touches
/// `pid`'s process-table entry — the caller's OWN process keeps running its
/// OLD image; unlike a not-yet-published spawn child, it is never reclaimed.
fn cancel_exec_target(
    kernel_store: &mut Store<()>,
    exec_target_cancel: &wasmtime::TypedFunc<(u32, u32), i32>,
    pid: u32,
    token: u32,
    reason: &str,
) {
    match exec_target_cancel.call(&mut *kernel_store, (pid, token)) {
        Ok(canceled) if canceled < 0 => {
            eprintln!(
                "[host-native] kernel_exec_target_cancel({pid}, {token}) after {reason} failed: \
                 {canceled}"
            );
        }
        Err(error) => {
            eprintln!(
                "[host-native] kernel_exec_target_cancel({pid}, {token}) after {reason} trapped: \
                 {error}"
            );
        }
        Ok(_) => {}
    }
}

/// N1-I3c Task 2: a `compute_guest_memory`/`launch_process` failure AFTER
/// `kernel_exec_commit` already returned `0` is the one `execve` failure
/// this task cannot resume the caller from. The kernel-side POSIX exec
/// transition (cloexec fds, set-ID creds, signal reset, `clear_threads`,
/// `exec_generation` bump) already committed for `pid` against the NEW
/// program, so as far as the KERNEL is concerned the old image is already
/// gone — even though the host never managed to produce a working new
/// module instance to run it. Resuming the parked caller (`ch`) here would
/// let it keep running the stale HOST-side instance of the OLD program
/// while the KERNEL believes the new one is running: an unobservable,
/// POSIX-violating split-brain between host and kernel state. There is no
/// sound "resume" for that state, so this truthfully TERMINATES `pid`
/// instead of pretending either image survived:
///   - best-effort `kernel_remove_process(pid)` purges the kernel's
///     process-table entry outright — the same call
///     `rollback_spawned_child` uses for other doomed processes; a normal
///     `Zombie`/`Exited` transition is not available here because nothing
///     will ever re-enter the kernel for this pid to commit one.
///   - a synthetic fatal exit code (`128 + SIGKILL` = `137`, the standard
///     shell convention for "killed") is recorded into `wait_table` so a
///     parked or future `waitpid` on `pid` resolves instead of hanging
///     forever, exactly like `run_pump`'s own `Syscall::Exit` branch
///     records a real exit.
///   - every channel on `processes[pi]` (including the exec'ing caller's
///     `ch`, still parked mid `memory.atomic.wait32` in the now-purged old
///     image) is dropped so the pump never services this process again.
///
/// `processes[pi]`'s `GuestProcess` entry itself is deliberately LEFT IN
/// PLACE (never `Vec::remove`d) rather than physically removed: `run_pump`'s
/// `blocked: Vec<BlockedOp>` list references live entries by `Vec` INDEX
/// (`BlockedOp::process_index`), and this function runs from inside
/// `run_pump`'s `for pi in 0..processes.len()` pass — shifting indices out
/// from under `blocked` entries that belong to OTHER, unrelated processes
/// is a real correctness hazard this rare, best-effort path must not
/// introduce. An inert, channel-less `GuestProcess` entry is exactly the
/// same shape a normal process exit already leaves behind in `processes`
/// (see `run_pump`'s `Syscall::Exit` branch, which likewise never removes
/// the `Vec` entry), so this matches an established convention rather than
/// inventing a new one; it is the fatal-exit-code return value + emptied
/// channel list that make it inert, not physical removal from `processes`.
///
/// Returns the synthetic fatal exit code so `handle_exec_common`'s caller
/// (`run_pump`) can fold it into `root_exit_code` when `pi == 0`.
fn terminate_process_after_failed_exec_commit(
    kernel_store: &mut Store<()>,
    processes: &mut [GuestProcess],
    pi: usize,
    pid: u32,
    remove_process: &wasmtime::TypedFunc<u32, i32>,
    wait_table: &Arc<Mutex<WaitTable>>,
    stage: &str,
    error: &anyhow::Error,
) -> i32 {
    eprintln!(
        "[host-native] execve/execveat({pid}): {stage} failed AFTER kernel_exec_commit \
         succeeded — the kernel already committed the new program's POSIX exec transition, so \
         the caller cannot be resumed; terminating pid {pid} instead: {error}"
    );
    match remove_process.call(&mut *kernel_store, pid) {
        Ok(removed) if removed < 0 => {
            eprintln!(
                "[host-native] kernel_remove_process({pid}) after a post-commit {stage} failure \
                 failed: {removed}"
            );
        }
        Err(trap) => {
            eprintln!(
                "[host-native] kernel_remove_process({pid}) after a post-commit {stage} failure \
                 trapped: {trap}"
            );
        }
        Ok(_) => {}
    }
    const FATAL_EXIT_CODE: i32 = 128 + 9; // shell convention: "killed by SIGKILL"
    wait_table.lock().unwrap().exited.insert(pid, encode_wait_status(FATAL_EXIT_CODE, 0));
    processes[pi].channels.clear();
    FATAL_EXIT_CODE
}

/// Complete a failed `SYS_EXECVE`/`SYS_EXECVEAT` request on the CALLING
/// process's own channel: `ret == -1` and a positive errno, matching
/// `__do_syscall_impl`'s generic `if (result < 0) return -(long)err;`
/// convention — exactly [`fail_spawn`]'s contract, except a failed
/// `execve`/`execveat` resumes the SAME process/thread that called it
/// (POSIX: `execve`/`execveat` only return to the caller on failure). This
/// is the success/failure asymmetry's failure half in its entirety: every
/// `handle_exec_common` branch that calls this did NOT reach
/// `kernel_exec_commit` (or reached it and it failed), so the OLD image is
/// still the truth and the caller must be resumed with the truthful errno —
/// never a swap. Retained-target cancellation (`cancel_exec_target`) is the
/// CALLER's responsibility, done immediately before invoking this, mirroring
/// `handle_spawn`'s `rollback_exec_target` ordering. `syscall_nr` is passed
/// through to `complete_channel` (`SYS_EXECVE` or `SYS_EXECVEAT`, whichever
/// the caller actually posted) purely for fidelity — `complete_channel` only
/// branches on `syscall_nr` for `ret >= 0` (mmap/brk growth), never reached
/// here since `ret` is always `-1` on this path.
fn fail_exec(
    guest_mem: &SharedMemory,
    kernel_mem: &SharedMemory,
    ch: PumpChannel,
    syscall_nr: u32,
    args: &[i64; 6],
    errno: i32,
) -> anyhow::Result<()> {
    complete_channel(guest_mem, kernel_mem, 0, ch, syscall_nr, args, &[], -1, errno as u32)
}

/// `handle_spawn`'s Task 1 happy-path rollback: the child's `Process` record
/// was already created (`kernel_spawn_process`) but never published
/// (`kernel_publish_spawn_child` hasn't run yet), so it is still ours to
/// reclaim. Best-effort — logs rather than failing the whole run if the
/// removal itself errors, exactly like the `-ECHILD` publish-rejection
/// rollback below `handle_spawn` already does.
fn rollback_spawned_child(
    kernel_store: &mut Store<()>,
    remove_process: &wasmtime::TypedFunc<u32, i32>,
    child_pid: u32,
    reason: &str,
) {
    match remove_process.call(&mut *kernel_store, child_pid) {
        Ok(removed) if removed < 0 => {
            eprintln!(
                "[host-native] kernel_remove_process({child_pid}) after {reason} failed: {removed}"
            );
        }
        Err(error) => {
            eprintln!(
                "[host-native] kernel_remove_process({child_pid}) after {reason} trapped: {error}"
            );
        }
        Ok(_) => {}
    }
}

/// N1-I3b Task 2's target-retained rollback: like [`rollback_spawned_child`],
/// but for a failure that happens AFTER `kernel_spawn_exec_target_prepare`
/// already retained a target under `token` (a read, compile, or commit
/// failure — see `handle_spawn`'s doc comment for the exact case list).
/// Cancels the retained target first (`kernel_exec_target_cancel`,
/// best-effort — logs on failure/trap rather than failing the whole run),
/// THEN reclaims the child's still-unpublished `Process` record via
/// [`rollback_spawned_child`]. Ordering matters even though both calls are
/// keyed on `child_pid`: the target is filed under that pid in the kernel's
/// per-process ledger (`kernel_spawn_exec_target_prepare`'s doc comment), so
/// canceling it first is the conservative order — reclaiming the process
/// record first would still work (the ledger lives on the `Process` itself,
/// so `kernel_remove_process` drops any retained target with it), but
/// canceling explicitly first makes the target's release independently
/// observable and keeps this helper correct even if that invariant ever
/// changes.
fn rollback_exec_target(
    kernel_store: &mut Store<()>,
    exec_target_cancel: &wasmtime::TypedFunc<(u32, u32), i32>,
    remove_process: &wasmtime::TypedFunc<u32, i32>,
    child_pid: u32,
    token: u32,
    reason: &str,
) {
    match exec_target_cancel.call(&mut *kernel_store, (child_pid, token)) {
        Ok(canceled) if canceled < 0 => {
            eprintln!(
                "[host-native] kernel_exec_target_cancel({child_pid}, {token}) after {reason} \
                 failed: {canceled}"
            );
        }
        Err(error) => {
            eprintln!(
                "[host-native] kernel_exec_target_cancel({child_pid}, {token}) after {reason} \
                 trapped: {error}"
            );
        }
        Ok(_) => {}
    }
    rollback_spawned_child(kernel_store, remove_process, child_pid, reason);
}

/// A chunk size for `read_exec_target_bytes`'s kernel-scratch buffer: large
/// enough that even a several-MB guest program needs only a handful of
/// `kernel_exec_target_read` round trips, small enough to stay a trivial
/// kernel-scratch allocation.
const EXEC_TARGET_READ_CHUNK: u32 = 65536;

/// N1-I3b Task 1: stream a prepared exec target's full contents out of the
/// kernel through a fixed-size scratch buffer. `owner_pid` is the process the
/// target is retained under (the CHILD pid for a spawn — see
/// `kernel_spawn_exec_target_prepare`'s doc comment; the calling process
/// itself for an in-place `execve`, not used by this increment). Calls
/// `size_fn` once, then loops `read_fn` — which writes up to `scratch_len`
/// bytes into KERNEL memory at `scratch_ptr` — copying each chunk out of
/// `kernel_mem` into the returned `Vec<u8>` until every byte has been read.
/// The kernel's own commit-time coverage check
/// (`PreparedExecTarget::observed_bytes`) requires this full, contiguous,
/// zero-gap coverage before `kernel_spawn_exec_commit`/`kernel_exec_commit`
/// will succeed, so a caller MUST drain this to completion (or `size == 0`)
/// before committing.
///
/// Returns `Ok(Ok(bytes))` on a full, successful read. A genuine call
/// failure (the `TypedFunc::call` itself trapping — a host/kernel
/// malfunction, not a normal outcome) still propagates via the outer
/// `anyhow::Result`'s `?`, ending the whole pump exactly as before this
/// function existed. A NORMAL negative-errno result from the kernel (a bad
/// size, a failed read, or a short read that leaves the coverage gap
/// unsatisfiable) is instead `Ok(Err(errno))` — N1-I3b Task 2's callers map
/// this to a truthful `fail_spawn` errno rather than a pump `bail!` (see
/// `handle_spawn`'s call site).
fn read_exec_target_bytes(
    kernel_store: &mut Store<()>,
    kernel_mem: &SharedMemory,
    size_fn: &wasmtime::TypedFunc<(u32, u32), i64>,
    read_fn: &wasmtime::TypedFunc<(u32, u32, u32, i32, u32, u32), i32>,
    scratch_ptr: u32,
    scratch_len: u32,
    owner_pid: u32,
    token: u32,
) -> anyhow::Result<Result<Vec<u8>, i32>> {
    let size = size_fn.call(&mut *kernel_store, (owner_pid, token))?;
    if size < 0 {
        return Ok(Err(-size as i32));
    }
    let total = size as usize;
    let mut out = Vec::with_capacity(total);
    let mut offset: i64 = 0;
    while (out.len() as i64) < size {
        let want = core::cmp::min(scratch_len as i64, size - offset) as u32;
        let n = read_fn.call(
            &mut *kernel_store,
            (owner_pid, token, offset as u32, (offset >> 32) as i32, scratch_ptr, want),
        )?;
        if n < 0 {
            return Ok(Err(-n));
        }
        if n == 0 {
            break; // EOF short of `size`: the check below reports the gap.
        }
        let chunk = unsafe { read_bytes(kernel_mem, scratch_ptr as usize, n as usize) };
        out.extend_from_slice(&chunk);
        offset += n as i64;
    }
    if out.len() != total {
        // Not a kernel-reported errno (the reads themselves all succeeded) —
        // a coverage-gap invariant violation. EIO is the closest POSIX errno
        // for "the underlying object did not deliver a promised read".
        return Ok(Err(libc_errno::EIO));
    }
    Ok(Ok(out))
}

/// N1-I3d Task 3: the two ways [`apply_shebang`] can fail, distinguished
/// ONLY so each call site can run the CORRECT rollback for `token` — never a
/// shebang decision the host itself makes.
///
/// - `ScratchAlloc`: `apply_shebang`'s own scratch allocation for the record
///   buffer failed BEFORE `kernel_exec_target_resolve_shebang` was ever
///   called. The input `token` (from `kernel_exec_target_prepare`/
///   `kernel_spawn_exec_target_prepare`) is therefore still fully retained —
///   exactly the same shape as `handle_exec_common`'s/`handle_spawn`'s own
///   pre-existing `read_scratch <= 0` case, so the caller must run its
///   normal target-retained rollback (`cancel_exec_target`/
///   `rollback_exec_target`).
/// - `Resolved`: the kernel export itself returned a negative errno. Per
///   `resolve_shebang`'s contract (`crates/runtime-core/src/exec_target.rs`):
///   "On every error path, zero tokens from this call are left retained" —
///   the kernel has ALREADY released the input token and any half-resolved
///   interpreter token, so the caller must NOT cancel anything; this is the
///   shebang-stage analog of a `prepare` failure itself (Case 1 in both
///   `handle_exec_common` and `handle_spawn`).
enum ShebangError {
    ScratchAlloc(i32),
    Resolved(i32),
}

/// N1-I3d Task 3: resolve `token`'s `#!` chain through the kernel's
/// `kernel_exec_target_resolve_shebang` export and decode its record. ALL
/// shebang decision logic — is this a script, the one-level nesting limit,
/// interpreter retargeting, argv-prefix assembly — is the kernel's (see that
/// export's doc comment in `crates/kernel/src/wasm_api.rs` and
/// `resolve_shebang`'s in `crates/runtime-core/src/exec_target.rs`). This
/// helper does nothing beyond allocating a scratch buffer for the record,
/// calling the export, and decoding the fixed record layout it documents:
/// `[kind: u8][final_token: u32]`, then, only if `kind == 1` (the input
/// token was a `#!` script), `[has_arg: u8][interp_len: u32][arg_len: u32]
/// [script_path_len: u32][interp bytes][arg bytes][script_path bytes]`.
///
/// `owner_pid` is the process `token` is retained under — the exec'ing pid
/// itself for `execve`/`execveat` ([`handle_exec_common`]), or the
/// not-yet-launched CHILD pid for `posix_spawn` ([`handle_spawn`]), exactly
/// matching `kernel_exec_target_prepare`'s/
/// `kernel_spawn_exec_target_prepare`'s own owner conventions (the kernel's
/// `resolve_shebang` re-prepares the interpreter under that SAME owner, so
/// this never changes across the call).
///
/// Returns `Ok(Ok((final_token, launch_argv)))` on success: `final_token` is
/// what the caller must actually `read_exec_target_bytes`/`Module::new`/
/// commit from here on, and `launch_argv` is either `orig_argv` unchanged
/// (`kind == 0`, not a script) or `[interp] + [arg]? + [script_path] +
/// orig_argv[1..]` (`kind == 1`) — POSIX's `#!` argv-prefix convention,
/// mirroring the host's former `resolveShebangChain`
/// (`host/src/exec-target.ts`), which this kernel export now replaces.
///
/// Returns `Ok(Err(ShebangError::_))` for the two failure shapes documented
/// on [`ShebangError`] itself — both are NORMAL outcomes this function
/// itself never rolls back (that is the caller's job, using the errno and
/// the matched variant to pick the right rollback). A genuine call failure
/// (`TypedFunc::call` itself trapping — a host/kernel malfunction) still
/// propagates via the outer `anyhow::Result`'s `?`, ending the whole pump —
/// unchanged from every other kernel-export call site in this file.
fn apply_shebang(
    kernel_store: &mut Store<()>,
    kernel_mem: &SharedMemory,
    resolve_fn: &wasmtime::TypedFunc<(u32, u32, u32, u32), i64>,
    alloc_scratch: &wasmtime::TypedFunc<u32, i32>,
    owner_pid: u32,
    token: u32,
    orig_argv: &[Vec<u8>],
) -> anyhow::Result<Result<(u32, Vec<Vec<u8>>), ShebangError>> {
    // 8 KiB comfortably covers the record's fixed 18-byte header plus any
    // realistic interpreter path, one `#!` argument, and script path. A
    // record that does not fit is the kernel export's own `-EOVERFLOW`,
    // handled uniformly below via `ShebangError::Resolved`.
    const SHEBANG_RECORD_SCRATCH: u32 = 8192;
    let out_scratch = alloc_scratch.call(&mut *kernel_store, SHEBANG_RECORD_SCRATCH)?;
    if out_scratch <= 0 {
        return Ok(Err(ShebangError::ScratchAlloc(libc_errno::ENOMEM)));
    }
    let out_ptr = out_scratch as u32;

    let result =
        resolve_fn.call(&mut *kernel_store, (owner_pid, token, out_ptr, SHEBANG_RECORD_SCRATCH))?;
    if result < 0 {
        return Ok(Err(ShebangError::Resolved((-result) as i32)));
    }

    let record_len = result as usize;
    let record = unsafe { read_bytes(kernel_mem, out_ptr as usize, record_len) };
    if record.len() < 5 {
        anyhow::bail!(
            "kernel_exec_target_resolve_shebang({owner_pid}, {token}) returned a record shorter \
             than its fixed 5-byte minimum ({} bytes)",
            record.len()
        );
    }
    let kind = record[0];
    let final_token = u32::from_le_bytes(record[1..5].try_into().unwrap());
    if kind == 0 {
        return Ok(Ok((final_token, orig_argv.to_vec())));
    }

    if record.len() < 18 {
        anyhow::bail!(
            "kernel_exec_target_resolve_shebang({owner_pid}, {token}) returned a kind==1 record \
             shorter than its fixed 18-byte header ({} bytes)",
            record.len()
        );
    }
    let has_arg = record[5] != 0;
    let interp_len = u32::from_le_bytes(record[6..10].try_into().unwrap()) as usize;
    let arg_len = u32::from_le_bytes(record[10..14].try_into().unwrap()) as usize;
    let script_path_len = u32::from_le_bytes(record[14..18].try_into().unwrap()) as usize;

    let interp_end = 18usize.checked_add(interp_len);
    let arg_end = interp_end.and_then(|e| e.checked_add(arg_len));
    let script_path_end = arg_end.and_then(|e| e.checked_add(script_path_len));
    let (Some(interp_end), Some(arg_end), Some(script_path_end)) = (interp_end, arg_end, script_path_end)
    else {
        anyhow::bail!(
            "kernel_exec_target_resolve_shebang({owner_pid}, {token}) returned overflowing field \
             lengths (interp={interp_len}, arg={arg_len}, script_path={script_path_len})"
        );
    };
    if script_path_end > record.len() {
        anyhow::bail!(
            "kernel_exec_target_resolve_shebang({owner_pid}, {token}) returned a record too short \
             for its own declared field lengths ({} bytes, needs {script_path_end})",
            record.len()
        );
    }
    let interp = record[18..interp_end].to_vec();
    let arg = record[interp_end..arg_end].to_vec();
    let script_path = record[arg_end..script_path_end].to_vec();

    let mut launch_argv = Vec::with_capacity(2 + usize::from(has_arg) + orig_argv.len().saturating_sub(1));
    launch_argv.push(interp);
    if has_arg {
        launch_argv.push(arg);
    }
    launch_argv.push(script_path);
    if orig_argv.len() > 1 {
        launch_argv.extend_from_slice(&orig_argv[1..]);
    }
    Ok(Ok((final_token, launch_argv)))
}

/// Parse `kernel_spawn_blob_decode`'s host-private read-back framing —
/// `[argc u32][envc u32]` then `argc + envc` entries of `[len u32][bytes]`,
/// argv first then envp (see `crate::spawn::serialize_argv_envp` in
/// `crates/runtime-core/src/spawn.rs`) — out of KERNEL memory at `ptr` into
/// owned `Vec<Vec<u8>>`s, ready for `launch_process`'s `launch_argv`/
/// `launch_env` (which expect raw bytes with no NUL terminator, matching this
/// framing exactly).
fn read_decoded_argv_envp(kernel_mem: &SharedMemory, ptr: usize) -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
    let argc = unsafe { read_u32(kernel_mem, ptr) } as usize;
    let envc = unsafe { read_u32(kernel_mem, ptr + 4) } as usize;
    let mut cursor = ptr + 8;
    let mut take = |count: usize| -> Vec<Vec<u8>> {
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            let len = unsafe { read_u32(kernel_mem, cursor) } as usize;
            cursor += 4;
            out.push(unsafe { read_bytes(kernel_mem, cursor, len) });
            cursor += len;
        }
        out
    };
    let argv = take(argc);
    let envp = take(envc);
    (argv, envp)
}

/// Read the `(RETURN, ERRNO)` pair the kernel wrote into the scratch header.
fn read_ret_errno(mem: &SharedMemory, scratch_ptr: usize) -> (i64, u32) {
    unsafe {
        (
            read_i64(mem, scratch_ptr + RETURN_OFFSET),
            read_u32(mem, scratch_ptr + ERRNO_OFFSET),
        )
    }
}

/// Whether a syscall can block (return EAGAIN meaning "not ready, wait") and so
/// should be parked and re-dispatched by the pump rather than completed. `poll`
/// is bounded by a caller timeout; readiness-driven waits (read/accept woken by
/// another task, or a child not yet exited under `wait4` — N1-I3a Task 3's
/// `host_waitpid`) return `None` from [`blocking_deadline`] and wait
/// indefinitely.
fn syscall_can_block(syscall_nr: u32) -> bool {
    syscall_nr == Syscall::Poll as u32
        || syscall_nr == Syscall::Read as u32
        || syscall_nr == Syscall::Wait4 as u32
}

/// The wall-clock deadline for a timeout-bounded blocking syscall, or `None` for
/// an infinite wait. `poll`'s timeout is arg2 in milliseconds; a negative value
/// means block forever.
fn blocking_deadline(syscall_nr: u32, args: &[i64; 6]) -> Option<Instant> {
    if syscall_nr == Syscall::Poll as u32 {
        let timeout_ms = args[2] as i32;
        if timeout_ms < 0 {
            None
        } else {
            Some(Instant::now() + Duration::from_millis(timeout_ms as u64))
        }
    } else {
        None
    }
}

/// Rewrite the syscall's timeout arg in the kernel scratch to zero so a final
/// re-dispatch is a non-blocking evaluation: the kernel returns the timed-out
/// result (0, revents cleared) instead of EAGAIN. `sys_poll` does not track
/// elapsed time — the host owns the deadline — so this is how the timeout ends.
fn force_zero_timeout(mem: &SharedMemory, scratch_ptr: usize, syscall_nr: u32) {
    if syscall_nr == Syscall::Poll as u32 {
        unsafe {
            write_bytes(mem, scratch_ptr + ARGS_OFFSET + 2 * ARG_SIZE, &0i64.to_le_bytes());
        }
    }
}

/// Stage a RAW syscall's `In`/`InOut` pointer buffers into the kernel scratch
/// DATA region and rewrite the corresponding arg words to the absolute kernel
/// addresses the kernel expects. Returns the staged buffers for post-call
/// copy-back. Errors loudly on any descriptor form this increment does not
/// implement, so an unexpected syscall surfaces instead of being mis-marshalled.
fn marshal_in(
    kernel_mem: &SharedMemory,
    guest_mem: &SharedMemory,
    scratch_ptr: usize,
    syscall_nr: u32,
    args: &mut [i64; 6],
) -> anyhow::Result<Vec<StagedArg>> {
    let mut staged = Vec::new();
    let mut cursor = 0usize;
    for d in &arg_descriptors(syscall_nr) {
        if d.copy_out_length.is_some() {
            anyhow::bail!("syscall {syscall_nr}: copy_out_length special-case not implemented");
        }
        let idx = d.arg_index as usize;
        let guest_ptr = args[idx] as u32 as usize;
        let size = match d.size {
            SyscallArgSize::Fixed { size } => size as usize,
            SyscallArgSize::Arg { arg_index, multiplier, add } => {
                (args[arg_index as usize] as u32 as usize) * multiplier as usize + add as usize
            }
            // A nul-terminated string (path): scan guest memory for the NUL up
            // to the ceiling and stage the whole string including it.
            SyscallArgSize::CString { max_bytes, .. } => {
                let max = max_bytes as usize;
                let base = mem_base(guest_mem);
                let mut n = 0usize;
                while n < max && unsafe { *base.add(guest_ptr + n) } != 0 {
                    n += 1;
                }
                if n >= max {
                    anyhow::bail!(
                        "syscall {syscall_nr}: CString arg {idx} is not NUL-terminated within \
                         {max} bytes"
                    );
                }
                n + 1 // include the NUL
            }
            other => anyhow::bail!("syscall {syscall_nr}: unsupported arg size {other:?}"),
        };
        if d.nullable && guest_ptr == 0 {
            continue;
        }
        // Align each staged buffer to 8 bytes for safe kernel struct access.
        cursor = (cursor + 7) & !7;
        let data_off = DATA_OFFSET + cursor;
        let kernel_addr = scratch_ptr + data_off;
        if size == 0 {
            args[idx] = kernel_addr as i64;
            continue;
        }
        match d.direction {
            SyscallArgDirection::In | SyscallArgDirection::InOut => {
                let bytes = unsafe { read_bytes(guest_mem, guest_ptr, size) };
                unsafe { write_bytes(kernel_mem, kernel_addr, &bytes) };
            }
            SyscallArgDirection::Out => {}
        }
        args[idx] = kernel_addr as i64;
        staged.push(StagedArg {
            guest_ptr,
            data_off,
            len: size,
            copy_back: matches!(d.direction, SyscallArgDirection::Out | SyscallArgDirection::InOut),
        });
        cursor += size;
    }
    Ok(staged)
}

/// Read one argv/environ entry for `kernel_argv_read`/`kernel_environ_get`,
/// mirroring the TS host's `copyEntry` contract (`host/src/worker-main.ts`):
/// an out-of-range `index` is `-EINVAL`; `buf_max == 0` is a side-effect-free
/// length query (the CRT always probes once before allocating its lifetime
/// region, then makes one exact-capacity copy); a `buf_max` too small for the
/// entry is `-ERANGE`; a null destination with a nonzero capacity is
/// `-EFAULT`. `entries` holds raw UTF-8 bytes with no NUL — the CRT appends
/// its own after the copy.
fn copy_launch_entry(
    guest_mem: &SharedMemory,
    entries: &[Vec<u8>],
    index: u32,
    buf_ptr: i32,
    buf_max: u32,
) -> i32 {
    let Some(entry) = usize::try_from(index).ok().and_then(|i| entries.get(i)) else {
        return -libc_errno::EINVAL;
    };
    let len = entry.len();
    if buf_max == 0 {
        return len as i32;
    }
    if (buf_max as usize) < len {
        return -libc_errno::ERANGE;
    }
    if buf_ptr == 0 {
        return -libc_errno::EFAULT;
    }
    unsafe { write_bytes(guest_mem, buf_ptr as u32 as usize, entry) };
    len as i32
}

/// Minimal errno values the native host returns from `host_*`/`kernel_*`
/// capabilities. Pinned here to avoid a `libc` dependency for these constants.
mod libc_errno {
    pub const ENOENT: i32 = 2;
    pub const E2BIG: i32 = 7;
    pub const ENOEXEC: i32 = 8;
    pub const EIO: i32 = 5;
    pub const ENOMEM: i32 = 12;
    pub const EFAULT: i32 = 14;
    pub const EBADF: i32 = 9;
    pub const ECHILD: i32 = 10;
    pub const EAGAIN: i32 = 11;
    pub const EACCES: i32 = 13;
    pub const EEXIST: i32 = 17;
    pub const ENOTDIR: i32 = 20;
    pub const EISDIR: i32 = 21;
    pub const EINVAL: i32 = 22;
    pub const ERANGE: i32 = 34;
    pub const ENOSYS: i32 = 38;
}

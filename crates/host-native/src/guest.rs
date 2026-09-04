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
use wasm_posix_shared::channel_record::RECORD_MAGIC;
use wasm_posix_shared::flags as open_flags;
use wasm_posix_shared::host_abi::{
    SyscallArgDesc, SyscallArgDirection, SyscallArgSize, SYSCALL_ARG_DESCRIPTORS,
};
use wasm_posix_shared::seek::SEEK_END;
use wasm_posix_shared::Syscall;

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
    let guest_mem = new_shared(&engine, layout.initial_pages as u32, DEFAULT_MAX_PAGES as u32)?;

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

    let mut kernel_store = Store::new(&engine, ());
    let mut klinker: Linker<()> = Linker::new(&engine);
    klinker.define(&mut kernel_store, "env", "memory", kernel_mem.clone())?;
    define_kernel_host_imports(&mut klinker, &kernel_mem, &captured, &fs, &guest_mem, &base_blobs)?;
    // Everything else the kernel imports (the ~78 unused host_* capabilities)
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

    // --- Kernel-side process setup ------------------------------------------
    let scratch_ptr = alloc_scratch.call(&mut kernel_store, MIN_CHANNEL_SIZE as u32)?;
    if scratch_ptr <= 0 {
        anyhow::bail!("kernel_alloc_scratch({MIN_CHANNEL_SIZE}) returned {scratch_ptr}");
    }
    let scratch_ptr_u = scratch_ptr as u32 as usize;

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

    for (name, val) in [
        ("kernel_set_brk_base", set_brk_base.call(&mut kernel_store, (pid, layout.brk_base as i32))?),
        ("kernel_set_mmap_base", set_mmap_base.call(&mut kernel_store, (pid, layout.brk_base as i32))?),
        ("kernel_set_max_addr", set_max_addr.call(&mut kernel_store, (pid, layout.max_addr as i32))?),
    ] {
        if val < 0 {
            anyhow::bail!("{name} failed: {val}");
        }
    }

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
    spawn_guest_thread(
        &engine,
        guest_module.clone(),
        guest_mem.clone(),
        layout,
        import_exit_status.clone(),
        launch_argv,
        launch_env,
    );

    // --- The channel pump ---------------------------------------------------
    let mut syscall_trace = Vec::new();
    let exit_code = run_pump(
        &mut kernel_store,
        &engine,
        &guest_module,
        &guest_mem,
        &kernel_mem,
        scratch_ptr_u,
        pid,
        layout,
        &set_current_tid,
        &handle_channel,
        &get_exit_status,
        &blocking_retry_token,
        &blocking_retry_release,
        &thread_exit,
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
fn define_kernel_host_imports(
    linker: &mut Linker<()>,
    kernel_mem: &SharedMemory,
    captured: &Arc<Mutex<CapturedIo>>,
    fs: &Arc<HostFs>,
    guest_mem: &SharedMemory,
    base_blobs: &Arc<BTreeMap<u64, Vec<u8>>>,
) -> anyhow::Result<()> {
    // host_futex_wake(addr, count) -> i32: wake up to `count` waiters parked on
    // the futex word at process address `addr` (in GUEST memory). musl's
    // pthread machinery and clear-child-tid use this. Returns the count.
    {
        let mem = guest_mem.clone();
        linker.func_wrap(
            "env",
            "host_futex_wake",
            move |_c: Caller<'_, ()>, addr: i32, count: i32| -> i32 {
                let n = if count < 0 { i32::MAX } else { count };
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
    Ok(())
}

/// Instantiate the guest on a fresh OS thread and run it to `_start`. The
/// thread blocks inside `_start` on each syscall's `wait32`; the pump on the
/// kernel thread services them. It never returns for a normal exit (the guest
/// parks after `exit_group`), so the caller must not join it — it is reclaimed
/// when the process exits.
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
/// the pump to release it. Detached — the pump routes its exit; never joined.
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

/// A blocking syscall parked awaiting readiness (or its timeout deadline). The
/// pump re-dispatches it under `token` on later iterations instead of looping in
/// place, so one channel's blocked op never starves another channel.
#[derive(Clone, Copy)]
struct BlockedOp {
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
        bind_and_dispatch(store, scratch_ptr, pid, ch.tid, retry_token, set_current_tid, handle_channel)?;
        let (ret, errno) = read_ret_errno(kernel_mem, scratch_ptr);
        unsafe {
            let record_out = read_bytes(kernel_mem, scratch_ptr + DATA_OFFSET, DATA_SIZE);
            write_bytes(guest_mem, ch.offset + DATA_OFFSET, &record_out);
            write_bytes(kernel_mem, scratch_ptr + DATA_OFFSET, &[0u8; 4]);
        }
        Ok((ret, errno, Vec::new()))
    } else {
        let staged = stage_raw(kernel_mem, guest_mem, scratch_ptr, syscall_nr, args)?;
        bind_and_dispatch(store, scratch_ptr, pid, ch.tid, retry_token, set_current_tid, handle_channel)?;
        let (ret, errno) = read_ret_errno(kernel_mem, scratch_ptr);
        Ok((ret, errno, staged))
    }
}

/// Bind the channel's tid (a one-shot binding consumed by the dispatch) and call
/// `kernel_handle_channel`.
fn bind_and_dispatch(
    store: &mut Store<()>,
    scratch_ptr: usize,
    pid: u32,
    tid: u32,
    retry_token: i64,
    set_current_tid: &wasmtime::TypedFunc<(u32, u32), i32>,
    handle_channel: &wasmtime::TypedFunc<(i32, u32, u32, i64), i32>,
) -> anyhow::Result<()> {
    let bind = set_current_tid.call(&mut *store, (pid, tid))?;
    if bind < 0 {
        anyhow::bail!("kernel_set_current_tid({pid},{tid}) failed: {bind}");
    }
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

/// The channel pump: a single-threaded event loop that services every live guest
/// channel and parks blocking syscalls in a table (re-dispatching them across
/// iterations) rather than looping in place — so a blocked op on one channel
/// never starves another. Returns the process exit code when the main channel
/// posts exit/exit_group.
#[allow(clippy::too_many_arguments)]
fn run_pump(
    kernel_store: &mut Store<()>,
    engine: &Engine,
    guest_module: &Module,
    guest_mem: &SharedMemory,
    kernel_mem: &SharedMemory,
    scratch_ptr: usize,
    pid: u32,
    layout: ProcessLayout,
    set_current_tid: &wasmtime::TypedFunc<(u32, u32), i32>,
    handle_channel: &wasmtime::TypedFunc<(i32, u32, u32, i64), i32>,
    get_exit_status: &wasmtime::TypedFunc<u32, i32>,
    blocking_retry_token: &wasmtime::TypedFunc<(u32, u32, u32), i64>,
    blocking_retry_release: &wasmtime::TypedFunc<(u32, u32, i64), i32>,
    thread_exit: &wasmtime::TypedFunc<(u32, u32), i64>,
    trace: &mut Vec<u32>,
) -> anyhow::Result<i32> {
    let mut channels = vec![PumpChannel { offset: layout.channel_offset, tid: pid, is_main: true }];
    let mut blocked: Vec<BlockedOp> = Vec::new();
    // Index of the next thread slot to hand out from the reserved arena.
    let mut next_thread_slot = 0usize;
    let hard_cap = Instant::now() + Duration::from_secs(30);

    loop {
        if Instant::now() > hard_cap {
            anyhow::bail!(
                "pump timed out after 30s ({} channel(s), {} blocked op(s))",
                channels.len(),
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
            let mut args = read_channel_args(guest_mem, op.channel.offset);
            let deadline_passed = op.deadline.is_some_and(|d| Instant::now() >= d);

            let staged = stage_raw(kernel_mem, guest_mem, scratch_ptr, op.syscall_nr, &mut args)?;
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
            )?;
            let (ret, errno) = read_ret_errno(kernel_mem, scratch_ptr);

            if !deadline_passed && ret == -1 && errno == libc_errno::EAGAIN as u32 {
                i += 1;
                continue; // still blocked
            }
            complete_channel(
                guest_mem, kernel_mem, scratch_ptr, op.channel, op.syscall_nr, &args, &staged, ret, errno,
            )?;
            if op.token > 0 {
                blocking_retry_release.call(&mut *kernel_store, (pid, op.channel.tid, op.token))?;
            }
            blocked.remove(i);
            progressed = true;
        }

        // 2) Service each live channel's newly posted request.
        let mut ci = 0;
        while ci < channels.len() {
            let ch = channels[ci];
            // A channel whose request is already parked stays PENDING until the
            // op completes; the retry loop owns it, so do not re-dispatch it here
            // (that would double-process and leak a second retry token).
            if blocked.iter().any(|op| op.channel.offset == ch.offset) {
                ci += 1;
                continue;
            }
            let status = unsafe { atomic_u32(guest_mem, ch.offset + STATUS_OFFSET) }.load(Ordering::SeqCst);
            if status != STATUS_PENDING {
                ci += 1;
                continue;
            }
            progressed = true;
            let (syscall_nr, mut args, is_record) = read_channel_request(guest_mem, ch.offset);
            trace.push(syscall_nr);

            // Process exit on the MAIN channel: the kernel commits the status
            // then traps via kernel_exit's `unreachable`; read the status and
            // end the run.
            if ch.is_main && (syscall_nr == Syscall::Exit as u32 || syscall_nr == SYS_EXIT_GROUP) {
                let _ = stage_raw(kernel_mem, guest_mem, scratch_ptr, syscall_nr, &mut args)?;
                let _ = bind_and_dispatch(
                    kernel_store, scratch_ptr, pid, ch.tid, 0, set_current_tid, handle_channel,
                );
                let code = get_exit_status
                    .call(&mut *kernel_store, pid)
                    .unwrap_or(args[0] as i32 & 0xff);
                return Ok(code);
            }

            // Worker-thread exit on a NON-main channel: route to
            // kernel_thread_exit (which keeps the shared process — fds, pipes —
            // alive), clear the child-tid futex word for any joiner, then
            // complete and drop the channel so it is no longer polled. This must
            // NOT go to the process-exit path, or it would tear the shared pipe
            // out from under a still-blocked reader.
            if !ch.is_main && syscall_nr == Syscall::Exit as u32 {
                let ctid = thread_exit.call(&mut *kernel_store, (pid, ch.tid))?;
                if ctid > 0 {
                    unsafe { write_bytes(guest_mem, ctid as u32 as usize, &0i32.to_le_bytes()) };
                    let _ = guest_mem.atomic_notify(ctid as u64, 1);
                }
                complete_channel(
                    guest_mem, kernel_mem, scratch_ptr, ch, syscall_nr, &args, &[], 0, 0,
                )?;
                channels.remove(ci);
                continue; // the vec shifted; do not advance ci
            }

            // Thread creation on the MAIN channel: dispatch clone so the kernel
            // allocates the child tid, carve a slot from the reserved arena,
            // launch the worker OS thread, register its channel, and return the
            // tid to the caller.
            if ch.is_main && syscall_nr == SYS_CLONE {
                let fn_ptr = unsafe { read_u32(guest_mem, ch.offset + DATA_OFFSET) };
                let arg = unsafe { read_u32(guest_mem, ch.offset + DATA_OFFSET + 4) };
                let stack_ptr = args[1] as u32;
                let tls_ptr = args[3] as u32;

                let mut clone_args = args;
                let _ = stage_raw(kernel_mem, guest_mem, scratch_ptr, syscall_nr, &mut clone_args)?;
                bind_and_dispatch(
                    kernel_store, scratch_ptr, pid, ch.tid, 0, set_current_tid, handle_channel,
                )?;
                let (tid, errno) = read_ret_errno(kernel_mem, scratch_ptr);
                if tid < 0 {
                    complete_channel(
                        guest_mem, kernel_mem, scratch_ptr, ch, syscall_nr, &args, &[], tid, errno,
                    )?;
                    ci += 1;
                    continue;
                }
                if next_thread_slot >= RESERVED_THREAD_SLOTS {
                    anyhow::bail!("out of reserved thread slots ({RESERVED_THREAD_SLOTS})");
                }
                let slot_page = layout.first_thread_slot_page + next_thread_slot * PAGES_PER_THREAD_SLOT;
                next_thread_slot += 1;
                let thread_channel_offset = (slot_page + THREAD_SLOT_CHANNEL_PRIMARY_PAGE) * WASM_PAGE_SIZE;
                let tls_offset = (slot_page + THREAD_SLOT_TLS_PAGE) * WASM_PAGE_SIZE;
                // Materialize + zero the whole slot (TLS, fork-save, channel).
                grow_to_cover(guest_mem, (slot_page + PAGES_PER_THREAD_SLOT) * WASM_PAGE_SIZE)?;
                unsafe {
                    write_bytes(
                        guest_mem,
                        slot_page * WASM_PAGE_SIZE,
                        &vec![0u8; PAGES_PER_THREAD_SLOT * WASM_PAGE_SIZE],
                    );
                }
                spawn_worker_thread(
                    engine,
                    guest_module,
                    guest_mem.clone(),
                    thread_channel_offset,
                    tls_offset,
                    stack_ptr,
                    tls_ptr,
                    fn_ptr,
                    arg,
                );
                channels.push(PumpChannel {
                    offset: thread_channel_offset,
                    tid: tid as u32,
                    is_main: false,
                });
                complete_channel(
                    guest_mem, kernel_mem, scratch_ptr, ch, syscall_nr, &args, &[], tid, 0,
                )?;
                ci += 1;
                continue;
            }

            let (ret, errno, staged) = dispatch_once(
                kernel_store, guest_mem, kernel_mem, scratch_ptr, pid, ch, syscall_nr, is_record,
                &mut args, 0, set_current_tid, handle_channel,
            )?;

            if !is_record
                && ret == -1
                && errno == libc_errno::EAGAIN as u32
                && syscall_can_block(syscall_nr)
            {
                let token = blocking_retry_token.call(&mut *kernel_store, (pid, ch.tid, syscall_nr))?;
                if token < 0 {
                    anyhow::bail!("kernel_blocking_retry_token({syscall_nr}) failed: {token}");
                }
                blocked.push(BlockedOp {
                    channel: ch,
                    syscall_nr,
                    token,
                    deadline: blocking_deadline(syscall_nr, &args),
                });
                // Leave the guest parked; do not complete.
            } else {
                complete_channel(
                    guest_mem, kernel_mem, scratch_ptr, ch, syscall_nr, &args, &staged, ret, errno,
                )?;
            }
            ci += 1;
        }

        // Idle only when nothing was ready this pass, to keep latency low while
        // avoiding a hot spin.
        if !progressed {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
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
/// another task) return `None` from [`blocking_deadline`] and wait indefinitely.
fn syscall_can_block(syscall_nr: u32) -> bool {
    syscall_nr == Syscall::Poll as u32 || syscall_nr == Syscall::Read as u32
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
    pub const EIO: i32 = 5;
    pub const EBADF: i32 = 9;
    pub const EAGAIN: i32 = 11;
    pub const EACCES: i32 = 13;
    pub const EEXIST: i32 = 17;
    pub const ENOTDIR: i32 = 20;
    pub const EISDIR: i32 = 21;
    pub const EINVAL: i32 = 22;
    pub const EFAULT: i32 = 14;
    pub const ERANGE: i32 = 34;
}

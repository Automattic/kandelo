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
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{Read, Write as _};
use std::os::fd::{AsFd, BorrowedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileExt, MetadataExt};
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use wasmtime::{
    AnyRef, Caller, Engine, ExternRef, ExternType, Global, GlobalType, Instance, Linker,
    MemoryType, Module, Mutability, Ref, SharedMemory, Store, Table, Val, ValType,
};

// The handle-only host filesystem contract (K9). `cap_std::fs::Dir` IS the
// mount-root-handle abstraction this contract asks for: a `Dir` is a directory
// capability that cannot be escaped through `..` or an absolute symlink, so
// "the host resolves at most one path component relative to a directory handle
// it previously issued" is enforced by the type rather than by a lexical guard
// this host has to keep correct by hand. `cap_fs_ext` adds the two options
// cap-std keeps unexported (`follow`, `maybe_dir`) plus `set_times`/
// `set_symlink_times`, which is `utimensat(2)` in cap-std's own vocabulary.
// `rustix` covers the two `*at` operations neither crate exposes
// (`chownat`, `fstatvfs`); `libc` covers `fpathconf(3)` and the platform's
// `UTIME_NOW`/`UTIME_OMIT` spellings, which are NOT the Linux values the
// kernel sends.
use cap_fs_ext::{
    DirExt as _, FollowSymlinks, OpenOptionsFollowExt as _, OpenOptionsMaybeDirExt as _,
    SystemTimeSpec,
};
use cap_std::fs::{
    Dir as CapDir, DirBuilder as CapDirBuilder, DirBuilderExt as _, FileType as CapFileType,
    Metadata as CapMetadata, MetadataExt as _, OpenOptions as CapOpenOptions, OpenOptionsExt as _,
    Permissions as CapPermissions, PermissionsExt as _, ReadDir as CapReadDir,
};

use wasm_posix_shared::channel::{
    ARGS_OFFSET, ARG_SIZE, DATA_OFFSET, DATA_SIZE, ERRNO_OFFSET, MIN_CHANNEL_SIZE,
    REQUEST_FLAGS_OFFSET, REQUEST_FLAG_OPAQUE_RECORD, RETURN_OFFSET, STATUS_OFFSET, SYSCALL_OFFSET,
};
use wasm_posix_shared::abi::extended_syscalls::{SYS_CLONE, SYS_EXIT_GROUP};
use wasm_posix_shared::trap_signal::WasmTrapKind;
use wasm_posix_shared::abi::host_intercepted::{SYS_EXECVE, SYS_EXECVEAT, SYS_FORK, SYS_SPAWN, SYS_VFORK};
use wasm_posix_shared::channel_record::RECORD_MAGIC;
use wasm_posix_shared::flags as open_flags;
use wasm_posix_shared::fork_contract::MODE_VFORK;
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
/// Three of the five values the header declares (`ERROR` and `TEARDOWN` are
/// the others); the pump only ever reads PENDING and writes COMPLETE.
#[allow(dead_code)]
const STATUS_IDLE: u32 = 0;
const STATUS_PENDING: u32 = 1;
const STATUS_COMPLETE: u32 = 2;

// --- Process memory layout constants ----------------------------------------
// Imported from `wasm-posix-shared`, which owns them. They were previously
// re-declared here as local literals with a comment saying they would be
// imported "if they ever move into the shared Rust crate" — they were already
// there, so this host carried a second copy of numbers that decide where a
// process's syscall channel lives.
const WASM_PAGE_SIZE: usize = wasm_posix_shared::process_memory::WASM_PAGE_SIZE as usize;
const DEFAULT_MAX_PAGES: usize = wasm_posix_shared::process_memory::DEFAULT_MAX_PAGES as usize;
/// `ceil(MIN_CHANNEL_SIZE / WASM_PAGE_SIZE)` — the channel spans this many pages.
const CHANNEL_PAGES: usize = wasm_posix_shared::process_memory::CHANNEL_PAGES as usize;

// Per-thread slot layout. These are ABI, owned by `wasm-posix-shared` and
// consumed by every host through it -- they were previously re-declared here
// as private literals despite this crate already depending on the crate that
// exports them, which is how a layout constant comes to have two definitions
// that can drift.
const PAGES_PER_THREAD_SLOT: usize =
    wasm_posix_shared::process_memory::PAGES_PER_THREAD_SLOT as usize;
const THREAD_SLOT_TLS_PAGE: usize =
    wasm_posix_shared::process_memory::THREAD_SLOT_TLS_PAGE as usize;
const THREAD_SLOT_CHANNEL_PRIMARY_PAGE: usize =
    wasm_posix_shared::process_memory::THREAD_SLOT_CHANNEL_PRIMARY_PAGE as usize;

/// Bytes one pthread control slot occupies.
const THREAD_SLOT_BYTES: usize = PAGES_PER_THREAD_SLOT * WASM_PAGE_SIZE;

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
pub(crate) struct ProcessLayout {
    initial_pages: usize,
    channel_offset: usize,
    brk_base: usize,
    max_addr: usize,
    /// The program's declared concurrent-pthread ceiling
    /// (`__wasm_posix_thread_slots`), or the host default when it declares
    /// none. Reported to the kernel as this process's quota; the kernel
    /// refuses `clone` past it with POSIX EAGAIN.
    thread_slot_count: u32,
    /// B27a: the process's data model, 4 for a wasm32 image and 8 for a
    /// wasm64 one, read from the program's own memory type.
    ///
    /// A property of the address space, not of any one syscall: it decides how
    /// many bytes a caller-native record occupies, so the host staging one and
    /// the kernel parsing it must agree. It is derived here, beside the rest of
    /// the layout, because this is where the host reads the program's bytes —
    /// the same moment `host/src/kernel-worker.ts` calls `detectPtrWidth`.
    ///
    /// Derived through `wasm_artifact::detect_pointer_width`, which is the one
    /// authority: `detectPtrWidth` on the TypeScript hosts is that same
    /// function compiled to wasm, and `exec_target::finish_commit` calls it
    /// directly. This host does not get its own second implementation.
    pointer_width: u8,
}

impl ProcessLayout {
    /// `imported_min_pages` is the guest's imported `env.memory` minimum;
    /// `guest_bytes` is the program itself, read for `__heap_base` and its
    /// pthread declaration.
    ///
    /// **The placement arithmetic is not here.** It is
    /// `wasm_posix_shared::process_memory::compute_layout`, so this host no
    /// longer carries its own description of a process address space.
    ///
    /// The TypeScript hosts still carry theirs. Moving them to the same
    /// function is written and held on
    /// `brandonpayton/lane-l-typescript-layout-held`; it wedges
    /// `./run.sh local-build`, for the reason lane L's plan records.
    ///
    /// This host previously ignored `__heap_base` entirely and always placed
    /// control memory at `FALLBACK_BRK_BASE`, while the TypeScript hosts
    /// placed it at the program's own heap base. For a program whose heap base
    /// sits below 16 MiB that was merely a different address; for one linked
    /// above it, this host put the syscall channel inside the program's own
    /// static data. Asking the shared function closes both.
    fn compute(imported_min_pages: usize, guest_bytes: &[u8]) -> anyhow::Result<Self> {
        use wasm_posix_shared::process_memory as pm;

        let declared = wasm_artifact::read_thread_slot_declaration(guest_bytes);
        let thread_slot_count = pm::resolve_thread_slot_count(declared, pm::DEFAULT_THREAD_SLOTS)
            .map_err(|value| {
                anyhow::anyhow!("invalid process thread slot declaration: {value}")
            })?;

        let layout = pm::compute_layout(pm::LayoutRequest {
            maximum_pages: pm::DEFAULT_MAX_PAGES,
            imported_minimum_pages: u32::try_from(imported_min_pages).unwrap_or(u32::MAX),
            requested_minimum_pages: 0,
            heap_base: wasm_artifact::read_heap_base(guest_bytes),
            thread_slot_count,
        })
        .map_err(|error| match error {
            pm::LayoutError::MaximumPagesTooSmall { maximum_pages } => {
                anyhow::anyhow!("invalid process maximum pages: {maximum_pages}")
            }
            pm::LayoutError::InitialPagesExceedMaximum {
                initial_pages,
                maximum_pages,
            } => anyhow::anyhow!(
                "initial pages {initial_pages} exceed process maximum {maximum_pages}"
            ),
        })?;

        Ok(Self {
            initial_pages: layout.initial_pages as usize,
            channel_offset: layout.channel_offset as usize,
            brk_base: layout.brk_base as usize,
            max_addr: layout.max_addr as usize,
            thread_slot_count,
            pointer_width: wasm_artifact::detect_pointer_width(guest_bytes),
        })
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
// it), so the kernel's path resolution falls through to this host for paths
// under the mount — exactly like Node's `HostFileSystem`/`extraMounts` (see
// `host/src/vfs/host-fs.ts`, `host/src/node-kernel-worker-entry.ts`). With no
// mount configured, those imports stay trapped
// (`define_unknown_imports_as_traps`) — a truthful boundary, since the
// overlay claims all of `/` and they must never fire.
//
// K9 changed WHAT falls through. The kernel resolves the namespace and calls
// the handle-relative `*at` family — `host_openat`, `host_fstatat`,
// `host_mkdirat`, `host_unlinkat`, `host_renameat`, `host_linkat`,
// `host_symlinkat`, `host_readlinkat`, `host_fchmodat`, `host_fchownat`,
// `host_utimensat` — plus the handle operations (`host_pread`, `host_pwrite`,
// `host_fstat`, `host_seek`, `host_readdir`, `host_fstatfs`, `host_fpathconf`,
// `host_close`). Each takes a directory handle this host issued plus at most
// one path component; the mount's root handle is published through
// `kernel_rootfs_set_foreign_mount_roots`, and a mount with no published root
// has no directory capability at all.

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

/// One registered mount's VFS-path prefix and the directory handle this host
/// published for it.
struct MountPoint {
    /// Normalized: no trailing slash (this increment's mount points are
    /// top-level, so never literally `"/"`).
    prefix: String,
    /// The handle `kernel_rootfs_set_foreign_mount_roots` binds to `prefix`, so
    /// every kernel path operation under this mount starts its walk here.
    ///
    /// `None` when the configured host directory could not be opened at all.
    /// The mount then has no directory capability, no handle is published for
    /// it, and the kernel answers `ENOSYS` for every path under it — the
    /// truthful boundary the handle-only contract defines, not a silent
    /// fallback to some other resolution path.
    root_handle: Option<i64>,
}

/// `WasmDirent::d_type` values, asked of `crates/shared` rather than copied.
///
/// These were written out as `0`, `4`, `8`, `10` under a comment naming
/// `crates/shared` as the source -- the same numbers stated twice with the
/// citation attached, which is the shape this lane removes. `shared` declares
/// all eight; this host maps four and answers `DT_UNKNOWN` for the rest,
/// which POSIX allows and which is why only four are named here.
const DT_UNKNOWN: u32 = wasm_posix_shared::dirent::DT_UNKNOWN;
const DT_DIR: u32 = wasm_posix_shared::dirent::DT_DIR;
const DT_REG: u32 = wasm_posix_shared::dirent::DT_REG;
const DT_LNK: u32 = wasm_posix_shared::dirent::DT_LNK;
/// Size of the `repr(C)` `WasmStat` the kernel reads back.
///
/// Asked of the shared type rather than written down. These were `88` and
/// `72` with a comment naming `crates/shared` as the source -- the same size
/// stated twice, which is the thing this lane exists to stop. A field added
/// to `WasmStat` moved one of them and not the other, and the statfs path is
/// one of the five imports no test in this repository executes.
const WASM_STAT_SIZE: usize = core::mem::size_of::<wasm_posix_shared::WasmStat>();
/// Size of the `repr(C)` `WasmStatfs` the kernel reads back.
const WASM_STATFS_SIZE: usize = core::mem::size_of::<wasm_posix_shared::WasmStatfs>();
/// Size of the `repr(C)` `WasmDirent` the kernel reads back.
const WASM_DIRENT_SIZE: usize = core::mem::size_of::<wasm_posix_shared::WasmDirent>();
/// First host handle the FS hands out; kept clear of the 0/1/2 stdio range.
///
/// K9 collapsed the two disjoint handle namespaces (files from `host_open`,
/// directory cursors from `host_opendir`) into ONE table, so a handle number is
/// now unique across files and directories and `host_close` releases either.
const HOST_FS_FIRST_HANDLE: i64 = 1000;

/// A blocking stdin (fd 0, a HostPipe) whose data is not ready on the first
/// read. `host_read(0)` returns EAGAIN once — forcing the kernel to block and
/// the pump to park the read — then delivers the line, then EOF. This is how a
/// real host pipe behaves when input arrives on a later poll; the call counter
/// just makes it deterministic for the test.
const HOST_STDIN_LINE: &[u8] = b"stdin via blocking read\n";

/// One live host object behind a handle the kernel holds.
///
/// K9 folded the old file table and directory-cursor table into this one enum.
/// A directory is not a separate namespace any more: `host_openat` with
/// `O_DIRECTORY` yields a [`HostObject::Dir`], `host_readdir` iterates it, and
/// `host_close` releases it exactly like a file.
enum HostObject {
    /// A regular (or otherwise non-directory) file. Kept as a plain
    /// `std::fs::File` once opened: the capability question was answered when
    /// the owning [`CapDir`] opened it by name, and the read/pread/seek paths
    /// want `std::os::unix::fs::FileExt`.
    File(File),
    Dir(DirHandle),
}

/// A directory capability plus the state `host_readdir` iterates it with.
struct DirHandle {
    dir: CapDir,
    /// Created on the FIRST `host_readdir`, so a directory handle used only to
    /// walk a path or answer `fstat`/`statfs` never opens a directory stream.
    entries: Option<CapReadDir>,
    /// One-entry lookahead, and the whole reason this is not just an iterator.
    ///
    /// `host_readdir` must consume EXACTLY once: an error has to leave the
    /// iterator on the same entry, because the kernel may return a short but
    /// successful `getdents64` after copying earlier records and then retry
    /// this same host operation on the next syscall. `std::fs::ReadDir` (what
    /// the pre-K9 `host_opendir` used) offers no peek or pushback, so an
    /// oversized name was silently *skipped* — a real divergence from the
    /// Node host, now closed: the entry is parked here until it is delivered.
    pending: Option<PendingEntry>,
}

/// A directory entry read from the host but not yet accepted by the kernel.
struct PendingEntry {
    ino: u64,
    d_type: u32,
    name: Vec<u8>,
}

impl DirHandle {
    fn new(dir: CapDir) -> Self {
        Self {
            dir,
            entries: None,
            pending: None,
        }
    }
}

/// fd 0 (stdin, always present) plus, when one or more [`NativeMount`]s are
/// configured, a real host-directory capability per mount.
///
/// # Containment is a type, not a lexical guard
///
/// Before K9 this struct re-implemented a POSIX namespace: it took a whole
/// guest path, matched it against a longest-prefix mount table, stripped the
/// prefix, and lexically walked the remainder with a `..`-popping stack — a
/// second resolution of a path the kernel had already resolved, and one that
/// still followed a symlink inside the tree pointing out of it.
///
/// None of that survives. The kernel resolves the namespace and hands this
/// host one directory handle plus one path component, so the only containment
/// question left is "may this handle reach that name", which is precisely what
/// [`cap_std::fs::Dir`] answers: a `Dir` cannot be escaped through `..` or
/// through an absolute symlink. The guarantee is therefore *stronger* than the
/// pre-K9 lexical one and is enforced by the type rather than by code this
/// host has to keep correct.
///
/// KNOWN DIVERGENCE FROM NODE, and it is this host being stricter: a symlink
/// stored INSIDE a mounted tree whose target escapes that tree is followed by
/// Node's `HostFileSystem.safePath` (`host/src/vfs/host-fs.ts`) and refused
/// here. Kandelo's own mount contract says a mount is a subtree, so refusing is
/// the behaviour that matches the contract and Node is the host that is loose —
/// but the two hosts do differ today, and that is recorded here rather than
/// papered over. Nothing shipped exercises it: the kernel resolves every
/// intermediate symlink itself, so only a FINAL component that is an escaping
/// symlink reaches this difference at all.
///
/// Unix-only (`std::os::unix::fs::*`): this workspace has no Windows CI
/// target for the native host.
struct HostFs {
    /// Number of host_read(0) calls so far (drives the EAGAIN-then-data stdin).
    stdin_reads: Mutex<u32>,
    /// Registered mounts and the root handle published for each. No ordering
    /// is implied: longest-prefix mount routing is the kernel's job now
    /// (`runtime_core::rootfs::foreign_mount_root`), not this host's. Empty by
    /// default (T1's sandboxed path).
    mounts: Vec<MountPoint>,
    /// Every live handle this host has issued — mount roots, files, and
    /// directories alike. One table, because K9 gave directories and files one
    /// handle namespace and one `host_close`.
    objects: Mutex<HashMap<i64, HostObject>>,
    next_handle: Mutex<i64>,
}

impl HostFs {
    /// Open each configured mount's real directory as a [`CapDir`] and register
    /// it as that mount's root handle.
    ///
    /// A directory that cannot be opened is reported and left unpublished
    /// rather than retried later or faked: the mount then has no directory
    /// capability at all, which is a boundary the kernel already models
    /// (`ENOSYS` for every path under it).
    fn new(mounts: &[NativeMount]) -> Self {
        let mut next_handle = HOST_FS_FIRST_HANDLE;
        let mut objects: HashMap<i64, HostObject> = HashMap::new();
        let mut mount_points = Vec::with_capacity(mounts.len());
        for mount in mounts {
            let prefix = normalize_mount_point(&mount.mount_point);
            let root_handle = match CapDir::open_ambient_dir(
                &mount.host_dir,
                cap_std::ambient_authority(),
            ) {
                Ok(dir) => {
                    let handle = next_handle;
                    next_handle += 1;
                    objects.insert(handle, HostObject::Dir(DirHandle::new(dir)));
                    Some(handle)
                }
                Err(error) => {
                    eprintln!(
                        "[host-native] mount {prefix} -> {}: {error}; publishing no directory \
                         capability for it (the kernel will answer ENOSYS under {prefix})",
                        mount.host_dir.display()
                    );
                    None
                }
            };
            mount_points.push(MountPoint {
                prefix,
                root_handle,
            });
        }
        Self {
            stdin_reads: Mutex::new(0),
            mounts: mount_points,
            objects: Mutex::new(objects),
            next_handle: Mutex::new(next_handle),
        }
    }

    fn alloc_handle(&self) -> i64 {
        let mut next = self.next_handle.lock().unwrap();
        let h = *next;
        *next += 1;
        h
    }

    fn insert(&self, object: HostObject) -> i64 {
        let handle = self.alloc_handle();
        self.objects.lock().unwrap().insert(handle, object);
        handle
    }

    /// Run `f` against the directory capability behind `handle`.
    ///
    /// `EBADF` for an unknown handle, `ENOTDIR` for a handle that names a file:
    /// both are the errno the kernel would get from a real `*at` call, and
    /// neither can be reached by a kernel that only passes back handles this
    /// host issued with `O_DIRECTORY`.
    fn with_dir<T>(&self, handle: i64, f: impl FnOnce(&mut DirHandle) -> Result<T, i32>) -> Result<T, i32> {
        let mut objects = self.objects.lock().unwrap();
        match objects.get_mut(&handle) {
            Some(HostObject::Dir(dir)) => f(dir),
            Some(HostObject::File(_)) => Err(libc_errno::ENOTDIR),
            None => Err(libc_errno::EBADF),
        }
    }

    /// Run `f` against the open file behind `handle`. `EISDIR` for a directory
    /// handle, which is what POSIX gives a `read`/`pread` of a directory.
    fn with_file<T>(&self, handle: i64, f: impl FnOnce(&File) -> Result<T, i32>) -> Result<T, i32> {
        let objects = self.objects.lock().unwrap();
        match objects.get(&handle) {
            Some(HostObject::File(file)) => f(file),
            Some(HostObject::Dir(_)) => Err(libc_errno::EISDIR),
            None => Err(libc_errno::EBADF),
        }
    }

    /// Run `f` against the raw descriptor behind `handle`, file or directory.
    /// The two whole-filesystem queries (`fstatfs`, `fpathconf`) are answered
    /// from either kind, because they are properties of the filesystem the
    /// object lives on rather than of the object.
    fn with_fd<T>(&self, handle: i64, f: impl FnOnce(BorrowedFd<'_>) -> Result<T, i32>) -> Result<T, i32> {
        let objects = self.objects.lock().unwrap();
        match objects.get(&handle) {
            Some(HostObject::File(file)) => f(file.as_fd()),
            Some(HostObject::Dir(dir)) => f(dir.dir.as_fd()),
            None => Err(libc_errno::EBADF),
        }
    }

    /// Run `f` against two directory capabilities at once — the shape
    /// `renameat` and `linkat` need, since both must present their two entries
    /// to the host filesystem in a single call for the operation to be atomic.
    /// The two handles may be the same directory.
    fn with_two_dirs<T>(
        &self,
        a: i64,
        b: i64,
        f: impl FnOnce(&CapDir, &CapDir) -> Result<T, i32>,
    ) -> Result<T, i32> {
        let objects = self.objects.lock().unwrap();
        let lookup = |handle: i64| match objects.get(&handle) {
            Some(HostObject::Dir(dir)) => Ok(&dir.dir),
            Some(HostObject::File(_)) => Err(libc_errno::ENOTDIR),
            None => Err(libc_errno::EBADF),
        };
        let dir_a = lookup(a)?;
        let dir_b = lookup(b)?;
        f(dir_a, dir_b)
    }

    /// The `kernel_rootfs_set_foreign_mount_roots` payload: for every mount
    /// with a published root, an 8-byte little-endian `i64` handle followed by
    /// the mount's canonical prefix bytes and a NUL terminator.
    fn foreign_mount_root_records(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        for mount in &self.mounts {
            let Some(handle) = mount.root_handle else {
                continue;
            };
            buf.extend_from_slice(&handle.to_le_bytes());
            buf.extend_from_slice(mount.prefix.as_bytes());
            buf.push(0);
        }
        buf
    }
}

/// Validate the one path component the handle-only contract allows, and return
/// it as an `OsStr` a [`CapDir`] method can take.
///
/// The kernel resolves the namespace, so a component it sends is never empty,
/// never contains `/`, and is never `..`. Rejecting those here is not defensive
/// duplication of the kernel's work — it is the point at which a contract
/// violation becomes a visible `EINVAL` instead of a silent traversal. `.` IS
/// allowed: that is how the contract names a mount root, or any directory
/// naming itself.
fn one_component(raw: &[u8]) -> Result<&OsStr, i32> {
    if raw.is_empty() || raw == b".." || raw.contains(&b'/') || raw.contains(&0) {
        return Err(libc_errno::EINVAL);
    }
    Ok(OsStr::from_bytes(raw))
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
/// flags`) into a [`CapOpenOptions`], mirroring `translateOpenFlags` in
/// `host/src/vfs/host-fs.ts`.
///
/// `maybe_dir(true)` is unconditional: cap-std refuses to open a directory
/// unless the caller says a directory is acceptable, and POSIX `open(2)` on a
/// directory is legal for `O_RDONLY`, so refusing it here would invent a
/// restriction the platform does not have. `O_DIRECTORY` is NOT expressed as a
/// flag — the caller inspects the opened object's type instead, so a
/// non-directory produces `ENOTDIR` on every platform rather than relying on a
/// custom flag surviving cap-std's per-platform open path.
fn open_options_from_flags(flags: u32, mode: u32) -> CapOpenOptions {
    let mut opts = CapOpenOptions::new();
    let accmode = flags & open_flags::O_ACCMODE;
    opts.read(accmode != open_flags::O_WRONLY);
    opts.write(accmode == open_flags::O_WRONLY || accmode == open_flags::O_RDWR);
    opts.maybe_dir(true);
    if flags & open_flags::O_NOFOLLOW != 0 {
        // The kernel walks a path it has already resolved. A component that is
        // still a symlink means the tree changed underneath the walk, and
        // `ELOOP` is the truthful answer rather than a re-followed link the
        // kernel never authorised.
        opts.follow(FollowSymlinks::No);
    }
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
/// A raw `raw_os_error()` is never passed through: this host process may run on
/// macOS, whose errno numbering diverges from Linux's past the handful of very
/// old, universally-shared POSIX codes (`ENAMETOOLONG`, `ELOOP`, and
/// `ENOTEMPTY` all have different numbers on macOS than on Linux). Passing a
/// raw macOS errno through would silently forge a wrong Linux errno for the
/// guest.
///
/// It is translated *by name* instead. The host's own `libc::E*` constant says
/// which condition occurred; the Linux number for that same condition is what
/// the guest is told. K9 made this matter: the newly implemented write side has
/// failure modes (`ENOTEMPTY` from `rmdir`, `EXDEV` from `rename`, `ELOOP` from
/// an `O_NOFOLLOW` walk step, `ENOSPC`, `EROFS`) that `ErrorKind` either does
/// not name or names only on unstable variants, and collapsing them all to
/// `EIO` would tell the guest something false about why its call failed.
/// Anything outside the table falls back to the portable `ErrorKind` mapping
/// and then to `EIO` — a truthful "something failed" rather than a guess.
fn errno_from_io(e: &std::io::Error) -> i32 {
    if let Some(raw) = e.raw_os_error() {
        // Ordered as in `asm-generic/errno-base.h` / `errno.h` for review
        // against the Linux numbers on the right.
        let by_name: &[(i32, i32)] = &[
            (libc::EPERM, 1),
            (libc::ENOENT, 2),
            (libc::ESRCH, 3),
            (libc::EINTR, 4),
            (libc::EIO, 5),
            (libc::ENXIO, 6),
            (libc::EBADF, 9),
            (libc::EAGAIN, 11),
            (libc::ENOMEM, 12),
            (libc::EACCES, 13),
            (libc::EFAULT, 14),
            (libc::EBUSY, 16),
            (libc::EEXIST, 17),
            (libc::EXDEV, 18),
            (libc::ENODEV, 19),
            (libc::ENOTDIR, 20),
            (libc::EISDIR, 21),
            (libc::EINVAL, 22),
            (libc::ENFILE, 23),
            (libc::EMFILE, 24),
            (libc::EFBIG, 27),
            (libc::ENOSPC, 28),
            (libc::ESPIPE, 29),
            (libc::EROFS, 30),
            (libc::EMLINK, 31),
            (libc::ERANGE, 34),
            (libc::ENAMETOOLONG, 36),
            (libc::ENOSYS, 38),
            (libc::ENOTEMPTY, 39),
            (libc::ELOOP, 40),
            (libc::ENOTSUP, 95),
            (libc::EDQUOT, 122),
        ];
        if let Some((_, linux)) = by_name.iter().find(|(native, _)| *native == raw) {
            return *linux;
        }
    }
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

/// Translate a `rustix::io::Errno` the same way [`errno_from_io`] translates an
/// `io::Error`: by name, into the Linux number the guest expects.
fn errno_from_rustix(e: rustix::io::Errno) -> i32 {
    errno_from_raw(e.raw_os_error())
}

/// Translate a raw platform errno into the Linux number for the same condition.
fn errno_from_raw(raw: i32) -> i32 {
    errno_from_io(&std::io::Error::from_raw_os_error(raw))
}

/// Read one path component out of kernel memory and validate it against the
/// handle-only contract. See [`one_component`].
///
/// # Safety
/// `ptr`/`len` must name a readable region of the kernel's shared memory, which
/// is the kernel's own guarantee for every pointer argument it passes.
unsafe fn read_component(
    mem: &SharedMemory,
    ptr: i32,
    len: i32,
) -> Result<std::ffi::OsString, i32> {
    if len < 0 {
        return Err(libc_errno::EINVAL);
    }
    let raw = unsafe { read_bytes(mem, ptr as u32 as usize, len as usize) };
    Ok(one_component(&raw)?.to_os_string())
}

/// Read the two components `renameat` and `linkat` name, validating both before
/// either is used.
///
/// # Safety
/// As [`read_component`].
unsafe fn read_two_components(
    mem: &SharedMemory,
    a_ptr: i32,
    a_len: i32,
    b_ptr: i32,
    b_len: i32,
) -> Result<(std::ffi::OsString, std::ffi::OsString), i32> {
    let a = unsafe { read_component(mem, a_ptr, a_len) }?;
    let b = unsafe { read_component(mem, b_ptr, b_len) }?;
    Ok((a, b))
}

/// Translate a `chown`/`fchown` uid/gid pair into rustix's "change this one?"
/// options. POSIX gives `(uid_t)-1` the meaning "leave this field alone", and
/// `chown(path, -1, -1)` is a legal call whose only effect is to update
/// `st_ctime` — so it must not be turned into "set the owner to 4294967295".
fn owner_group(uid: u32, gid: u32) -> (Option<rustix::fs::Uid>, Option<rustix::fs::Gid>) {
    let owner = (uid != u32::MAX).then(|| rustix::fs::Uid::from_raw(uid));
    let group = (gid != u32::MAX).then(|| rustix::fs::Gid::from_raw(gid));
    (owner, group)
}

/// Map a real file type onto the `WasmDirent::d_type` value for it.
fn dirent_type(file_type: &CapFileType) -> u32 {
    if file_type.is_dir() {
        DT_DIR
    } else if file_type.is_file() {
        DT_REG
    } else if file_type.is_symlink() {
        DT_LNK
    } else {
        DT_UNKNOWN
    }
}

/// Linux's `UTIME_NOW`, the value the kernel puts in a `utimensat` nanosecond
/// field to mean "stamp this with the current time".
const LINUX_UTIME_NOW: i64 = (1 << 30) - 1;
/// Linux's `UTIME_OMIT`: "leave this timestamp alone".
const LINUX_UTIME_OMIT: i64 = (1 << 30) - 2;

/// Decode one `(sec, nsec)` pair from a `utimensat` request into cap-std's
/// symbolic form.
///
/// `None` is `UTIME_OMIT`. `SymbolicNow` is `UTIME_NOW` — symbolic rather than
/// a captured `SystemTime::now()` so the platform stamps the time at the moment
/// it performs the operation, which is what `UTIME_NOW` means.
///
/// The sentinels arriving here are LINUX's; the running platform may spell them
/// differently, which is exactly why they are decoded rather than forwarded.
fn utimens_spec(sec: i64, nsec: i64) -> Result<Option<SystemTimeSpec>, i32> {
    match nsec {
        LINUX_UTIME_OMIT => Ok(None),
        LINUX_UTIME_NOW => Ok(Some(SystemTimeSpec::SymbolicNow)),
        0..=999_999_999 => {
            let nanos = Duration::from_nanos(nsec as u64);
            let time = if sec >= 0 {
                UNIX_EPOCH
                    .checked_add(Duration::from_secs(sec as u64))
                    .and_then(|t| t.checked_add(nanos))
            } else {
                // A pre-epoch timestamp is legal POSIX; represent it rather
                // than rejecting or clamping it.
                UNIX_EPOCH
                    .checked_sub(Duration::from_secs(sec.unsigned_abs()))
                    .and_then(|t| t.checked_add(nanos))
            };
            let time = time.ok_or(libc_errno::EINVAL)?;
            Ok(Some(SystemTimeSpec::Absolute(
                cap_std::time::SystemTime::from_std(time),
            )))
        }
        // Any other nanosecond value is out of range for POSIX `utimensat`.
        _ => Err(libc_errno::EINVAL),
    }
}

/// Map the ABI's `pathconf` name (`wasm_posix_shared::pathconf`, a small dense
/// enumeration of its own) onto this platform's `_PC_*` constant.
///
/// `None` means the running platform has no `_PC_*` constant for that limit —
/// several of the ABI's names are Linux-only (`SOCK_MAXBUF`, `TEXTDOMAIN_MAX`,
/// `FALLOC`, `TIMESTAMP_RESOLUTION`) — and the caller answers "indeterminate"
/// rather than inventing a value.
fn native_pathconf_name(name: i32) -> Option<libc::c_int> {
    use wasm_posix_shared::pathconf as pc;
    Some(match name {
        pc::LINK_MAX => libc::_PC_LINK_MAX,
        pc::MAX_CANON => libc::_PC_MAX_CANON,
        pc::MAX_INPUT => libc::_PC_MAX_INPUT,
        pc::NAME_MAX => libc::_PC_NAME_MAX,
        pc::PATH_MAX => libc::_PC_PATH_MAX,
        pc::PIPE_BUF => libc::_PC_PIPE_BUF,
        pc::CHOWN_RESTRICTED => libc::_PC_CHOWN_RESTRICTED,
        pc::NO_TRUNC => libc::_PC_NO_TRUNC,
        pc::VDISABLE => libc::_PC_VDISABLE,
        pc::SYNC_IO => libc::_PC_SYNC_IO,
        pc::ASYNC_IO => libc::_PC_ASYNC_IO,
        pc::PRIO_IO => libc::_PC_PRIO_IO,
        pc::FILESIZEBITS => libc::_PC_FILESIZEBITS,
        pc::REC_INCR_XFER_SIZE => libc::_PC_REC_INCR_XFER_SIZE,
        pc::REC_MAX_XFER_SIZE => libc::_PC_REC_MAX_XFER_SIZE,
        pc::REC_MIN_XFER_SIZE => libc::_PC_REC_MIN_XFER_SIZE,
        pc::REC_XFER_ALIGN => libc::_PC_REC_XFER_ALIGN,
        pc::ALLOC_SIZE_MIN => libc::_PC_ALLOC_SIZE_MIN,
        pc::SYMLINK_MAX => libc::_PC_SYMLINK_MAX,
        pc::POSIX2_SYMLINKS => libc::_PC_2_SYMLINKS,
        _ => return None,
    })
}

/// Ask the platform for one `pathconf` limit on an open descriptor.
///
/// `fpathconf` returns -1 for BOTH "this limit is indeterminate" (errno
/// untouched) and "this call failed" (errno set), so errno is cleared first to
/// tell the two apart — otherwise a stale errno from an unrelated earlier call
/// would turn a legitimate "no limit" into a failure.
fn fpathconf_value(fd: BorrowedFd<'_>, native_name: libc::c_int) -> Result<i64, i32> {
    use std::os::fd::AsRawFd;
    unsafe { *errno_location() = 0 };
    let value = unsafe { libc::fpathconf(fd.as_raw_fd(), native_name) };
    if value == -1 {
        let raw = unsafe { *errno_location() };
        if raw != 0 {
            return Err(errno_from_raw(raw));
        }
    }
    Ok(value as i64)
}

/// The address of this thread's `errno`.
///
/// `std::io::Error::last_os_error()` can read errno but nothing in `std` can
/// clear it, and [`fpathconf_value`] must clear it to distinguish "no limit"
/// from "failed". The accessor is spelled differently per platform; both are
/// the documented public symbol behind the `errno` macro.
///
/// # Safety
/// The returned pointer is valid for the calling thread only.
#[cfg(target_os = "linux")]
unsafe fn errno_location() -> *mut libc::c_int {
    unsafe { libc::__errno_location() }
}

#[cfg(target_vendor = "apple")]
unsafe fn errno_location() -> *mut libc::c_int {
    unsafe { libc::__error() }
}

/// Serialize a `statvfs` answer into the `WasmStatfs` the kernel reads back,
/// at the field offsets its `repr(C)` struct expects (mirrors
/// `#writeStatfsToMemory` in `host/src/kernel.ts`).
fn write_wasm_statfs(
    mem: &SharedMemory,
    dest: KernelLent,
    vfs: &rustix::fs::StatVfs,
) -> Result<(), i32> {
    // `statvfs` reports mount flags in its own `ST_*` bitset, whose numbering
    // is not portable; only the two flags POSIX defines for every platform are
    // forwarded, re-spelled with LINUX's `ST_RDONLY`/`ST_NOSUID` values because
    // that is the numbering the guest's libc reads.
    const LINUX_ST_RDONLY: u32 = 1;
    const LINUX_ST_NOSUID: u32 = 2;
    let mut flags = 0u32;
    if vfs.f_flag.contains(rustix::fs::StatVfsMountFlags::RDONLY) {
        flags |= LINUX_ST_RDONLY;
    }
    if vfs.f_flag.contains(rustix::fs::StatVfsMountFlags::NOSUID) {
        flags |= LINUX_ST_NOSUID;
    }
    let mut b = [0u8; WASM_STATFS_SIZE];
    // f_type stays 0: `statvfs` carries no filesystem-type magic number, and a
    // fabricated one would be a lie about which filesystem this is.
    b[4..8].copy_from_slice(&(vfs.f_bsize as u32).to_le_bytes()); // f_bsize
    b[8..16].copy_from_slice(&vfs.f_blocks.to_le_bytes()); // f_blocks
    b[16..24].copy_from_slice(&vfs.f_bfree.to_le_bytes()); // f_bfree
    b[24..32].copy_from_slice(&vfs.f_bavail.to_le_bytes()); // f_bavail
    b[32..40].copy_from_slice(&vfs.f_files.to_le_bytes()); // f_files
    b[40..48].copy_from_slice(&vfs.f_ffree.to_le_bytes()); // f_ffree
    b[48..56].copy_from_slice(&vfs.f_fsid.to_le_bytes()); // f_fsid
    b[56..60].copy_from_slice(&(vfs.f_namemax as u32).to_le_bytes()); // f_namelen
    b[60..64].copy_from_slice(&(vfs.f_frsize as u32).to_le_bytes()); // f_frsize
    b[64..68].copy_from_slice(&flags.to_le_bytes()); // f_flags
    dest.write(mem, &b)
}

/// Combine two 32-bit words into a signed 64-bit value (high word first),
/// mirroring `signedI64FromWords` in `host/src/kernel.ts` — the same
/// low/high-word convention `host_pread`/`host_seek` use throughout this file.
fn combine_i64(lo: i32, hi: i32) -> i64 {
    ((hi as i64) << 32) | (lo as u32 as i64)
}

/// Serialize a real `std::fs::Metadata` into a `WasmStat`. `Metadata::mode()`
/// already carries the `S_IFMT` file-type bits (`S_IFDIR`/`S_IFREG`/`S_IFLNK`
/// etc.), which are numerically identical between Linux and the BSD/macOS
/// heritage `st_mode` encoding, so no translation is needed.
fn write_wasm_stat_from_metadata(
    mem: &SharedMemory,
    dest: KernelLent,
    meta: &fs::Metadata,
) -> Result<(), i32> {
    write_wasm_stat_fields(
        mem,
        dest,
            StatFields {
                ino: meta.ino(),
                mode: meta.mode(),
                nlink: meta.nlink() as u32,
                uid: meta.uid(),
                gid: meta.gid(),
                size: meta.size(),
                atime: (meta.atime(), meta.atime_nsec()),
                mtime: (meta.mtime(), meta.mtime_nsec()),
                ctime: (meta.ctime(), meta.ctime_nsec()),
        },
    )
}

/// Serialize a [`CapMetadata`] — what every `*at` metadata query on a directory
/// capability returns — into a `WasmStat`.
fn write_wasm_stat_from_cap_metadata(
    mem: &SharedMemory,
    dest: KernelLent,
    meta: &CapMetadata,
) -> Result<(), i32> {
    write_wasm_stat_fields(
        mem,
        dest,
            StatFields {
                ino: meta.ino(),
                mode: meta.mode(),
                nlink: meta.nlink() as u32,
                uid: meta.uid(),
                gid: meta.gid(),
                size: meta.size(),
                atime: (meta.atime(), meta.atime_nsec()),
                mtime: (meta.mtime(), meta.mtime_nsec()),
                ctime: (meta.ctime(), meta.ctime_nsec()),
        },
    )
}

/// The `WasmStat` fields this host can answer truthfully from a real host
/// filesystem. `st_dev` and `st_rdev` are deliberately absent: a host device
/// number is meaningless in the guest's device namespace, and the kernel owns
/// device identity for every backend it exposes.
struct StatFields {
    ino: u64,
    mode: u32,
    nlink: u32,
    uid: u32,
    gid: u32,
    size: u64,
    atime: (i64, i64),
    mtime: (i64, i64),
    ctime: (i64, i64),
}

fn write_wasm_stat_fields(
    mem: &SharedMemory,
    dest: KernelLent,
    f: StatFields,
) -> Result<(), i32> {
    let mut b = [0u8; WASM_STAT_SIZE];
    b[8..16].copy_from_slice(&f.ino.to_le_bytes()); // st_ino
    b[16..20].copy_from_slice(&f.mode.to_le_bytes()); // st_mode
    b[20..24].copy_from_slice(&f.nlink.to_le_bytes()); // st_nlink
    b[24..28].copy_from_slice(&f.uid.to_le_bytes()); // st_uid
    b[28..32].copy_from_slice(&f.gid.to_le_bytes()); // st_gid
    b[32..40].copy_from_slice(&f.size.to_le_bytes()); // st_size
    // A pre-epoch timestamp cannot be represented in the unsigned `st_*time_sec`
    // fields; clamp to 0 rather than wrap into the far future.
    let sec = |s: i64| -> u64 { u64::try_from(s).unwrap_or(0) };
    let nsec = |n: i64| -> u32 { u32::try_from(n).unwrap_or(0) };
    b[40..48].copy_from_slice(&sec(f.atime.0).to_le_bytes()); // st_atime_sec
    b[48..52].copy_from_slice(&nsec(f.atime.1).to_le_bytes()); // st_atime_nsec
    b[56..64].copy_from_slice(&sec(f.mtime.0).to_le_bytes()); // st_mtime_sec
    b[64..68].copy_from_slice(&nsec(f.mtime.1).to_le_bytes()); // st_mtime_nsec
    b[72..80].copy_from_slice(&sec(f.ctime.0).to_le_bytes()); // st_ctime_sec
    b[80..84].copy_from_slice(&nsec(f.ctime.1).to_le_bytes()); // st_ctime_nsec
    dest.write(mem, &b)
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
    /// N1-I4 Task 3: the co-resident fork-module's proof-of-use counters,
    /// SUMMED across every guest OS thread this run ever instantiated one
    /// for (the boot process, and any spawned/forked/exec'd descendant).
    /// `Default::default()` (all zero) for any run with `enable_fork_module
    /// == false` — test-observability plumbing, exactly like
    /// `syscall_trace`, not a behavior change.
    pub fork_proof_of_use: ForkProofOfUse,
}

/// N1-I4 Task 3: proof-of-use counters accumulated (by simple addition, never
/// reset) from EVERY co-resident fork-module instance a [`run_guest`] call
/// ever instantiates. A frames-only fork (this task's scope) drives ONLY
/// `frames_committed` (a parent's capture/unwind) and `frames_replayed` (a
/// parent's OR a child's rewind) — the four reference-path counters must
/// stay `0` until I5 starts driving reference reconstruction; a nonzero
/// value there would mean the frames-only coordinator accidentally exercised
/// the inert reference/exception host-import stubs `instantiate_fork_module`
/// wires as traps, which is exactly what [`RunOutcome::fork_proof_of_use`]'s
/// tests assert never happens.
#[derive(Debug, Clone, Copy, Default)]
pub struct ForkProofOfUse {
    pub frames_committed: i64,
    pub frames_replayed: i64,
    pub references_reconstructed: i64,
    pub exnrefs_reconstructed: i64,
    pub gc_nodes_reconstructed: i64,
    /// N1-I5 Task 3: static roots the `DRIVE_OP_STATIC_ROOT` step published
    /// into the anyref transit. Stays `0` unless the fork's graph actually
    /// contains a static-root recipe.
    pub static_roots_published: i64,
    /// N1-I5 Task 3: plan steps `fm_drive_execute`'s injected loop drove
    /// (ALLOC/FILL/EXN/STATIC_ROOT). Stays `0` for a funcref-only fork,
    /// which builds a zero-step plan.
    pub drive_steps_executed: i64,
}

/// Best-effort, additive fold of one fork-module instance's proof-of-use
/// counters (read via the single folded `fm_stats(field)` accessor) into the
/// shared accumulator. A failing `fm_stats` call is skipped (best-effort);
/// each counter is additive so a `run_guest` call folding many instances
/// (boot + descendants) never overwrites. See the call sites' doc comments.
fn fold_fork_proof_of_use(fm: &ForkModule, store: &mut Store<()>, acc: &mut ForkProofOfUse) {
    if let Ok(v) = fm.fm_stats.call(&mut *store, FM_STAT_FRAMES_COMMITTED) {
        acc.frames_committed += v;
    }
    if let Ok(v) = fm.fm_stats.call(&mut *store, FM_STAT_FRAMES_REPLAYED) {
        acc.frames_replayed += v;
    }
    if let Ok(v) = fm.fm_stats.call(&mut *store, FM_STAT_REFERENCES_RECONSTRUCTED) {
        acc.references_reconstructed += v;
    }
    if let Ok(v) = fm.fm_stats.call(&mut *store, FM_STAT_EXNREFS_RECONSTRUCTED) {
        acc.exnrefs_reconstructed += v;
    }
    if let Ok(v) = fm.fm_stats.call(&mut *store, FM_STAT_GC_NODES_RECONSTRUCTED) {
        acc.gc_nodes_reconstructed += v;
    }
    if let Ok(v) = fm.fm_stats.call(&mut *store, FM_STAT_STATIC_ROOTS_PUBLISHED) {
        acc.static_roots_published += v;
    }
    if let Ok(v) = fm.fm_stats.call(&mut *store, FM_STAT_DRIVE_STEPS_EXECUTED) {
        acc.drive_steps_executed += v;
    }
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

/// Resolve `(addr, len)` against a `SharedMemory`'s OWN current extent,
/// returning the byte offset to copy at.
///
/// Shared by the two cross-memory imports below for BOTH sides of a copy —
/// the guest range and the kernel range — because the reasoning is identical:
/// fitting inside a live linear memory is the only thing an address can be
/// checked for from outside the instance that owns it.
///
/// **The rule is not written here.** It is
/// `wasm_posix_shared::host_memory::checked_range`, which is also what
/// `host/src/kernel-scratch.ts`'s corpus is checked against — this function
/// used to restate the rule and name the TypeScript it was transcribed from,
/// which is two descriptions of one contract.
///
/// `mem.data().len()` is read fresh on every call rather than cached, because
/// a guest may `memory.grow` between calls.
fn checked_shared_range(mem: &SharedMemory, addr: u64, len: u32) -> Option<usize> {
    wasm_posix_shared::host_memory::checked_range(
        addr,
        len as u64,
        mem.data().len() as u64,
        false,
    )
    .ok()
    .and_then(|addr| usize::try_from(addr).ok())
}

/// A kernel-scratch allocation, carrying the capacity it was actually given.
///
/// # The invariant, and why a pointer alone cannot carry it
///
/// A region the KERNEL lends this host, proven once at the boundary.
///
/// The mirror of [`KernelScratch`], for the other direction. `KernelScratch`
/// covers memory this host ASKS the kernel for; this covers memory the kernel
/// HANDS this host — a `(ptr, capacity)` pair arriving as import arguments,
/// which the host then writes into.
///
/// Outbound had a type and a source guard. Inbound was a `usize`, and sixteen
/// sites wrote at one without proving anything (L-D3). The JavaScript host has
/// carried the inbound type all along — `#rustLentKernelDestination` in
/// `host/src/kernel.ts`, whose comment is the whole argument:
///
/// > fitting in the current WebAssembly Memory proves only addressability,
/// > not ownership. The Rust import arguments name the allocation and its
/// > capacity; keeping both in an authenticated token prevents a later caller
/// > from substituting total Memory length for the allocation bound.
///
/// The proof is `wasm_posix_shared::host_memory::checked_range`, the same rule
/// the corpus checks in both hosts. Holding an offset that only this
/// constructor can produce is what stops a caller reaching for the raw
/// pointer again further down.
#[derive(Debug, Clone, Copy)]
struct KernelLent {
    offset: usize,
    capacity: u32,
}

impl KernelLent {
    /// Prove a `(ptr, capacity)` pair the kernel passed in, or refuse it.
    ///
    /// `None` is the caller's cue to answer `-EFAULT`, which is what this
    /// host already does wherever it proves a kernel range today
    /// (`proc_copy_in`/`proc_copy_out`) and what the JavaScript host answers
    /// for the same condition.
    fn prove(mem: &SharedMemory, ptr: u64, capacity: u32) -> Option<Self> {
        checked_shared_range(mem, ptr, capacity).map(|offset| Self { offset, capacity })
    }

    /// Copy `bytes` in, refusing a write longer than the lender promised.
    ///
    /// The capacity check is the half a bounds check cannot supply: being
    /// inside the memory does not mean being inside what was lent.
    fn write(self, mem: &SharedMemory, bytes: &[u8]) -> Result<(), i32> {
        if bytes.len() > self.capacity as usize {
            return Err(-libc_errno::EFAULT);
        }
        unsafe { write_bytes(mem, self.offset, bytes) };
        Ok(())
    }

}

/// Prove a lent `(ptr, capacity)` and copy `bytes` into it, or refuse.
///
/// The shape every kernel host import needs: the kernel names a buffer and
/// how big it is, the host writes no more than that, and an address it cannot
/// map is `-EFAULT` rather than a `copy_nonoverlapping` into whatever is
/// there.
fn write_lent(
    mem: &SharedMemory,
    ptr: u64,
    capacity: u32,
    bytes: &[u8],
) -> Result<(), i32> {
    let Some(dest) = KernelLent::prove(mem, ptr, capacity) else {
        return Err(-libc_errno::EFAULT);
    };
    dest.write(mem, bytes)
}

/// `kernel_alloc_scratch(n)` answers with an address inside kernel memory.
/// That address being in bounds proves the host CAN address those bytes; it
/// does not prove the allocator gave *this caller* `n` of them. Nothing about
/// the returned `i32` distinguishes "you were given 64 KiB here" from "you
/// were given 8 bytes here", so a later write of the wrong length lands
/// somewhere the allocator has already promised to someone else, and every
/// bounds check in the world still passes.
///
/// The JavaScript host has an ownership type for exactly this fact
/// (`OwnedKernelScratchRegion` in `host/src/kernel-scratch.ts`). This host had
/// none: it allocated, checked `ptr > 0`, and wrote through a bare
/// `copy_nonoverlapping`. Every call site was sound by construction — each
/// asked for `len` and wrote `len` — but "sound by construction" is a property
/// of the code as written, not an invariant anything enforces, and it is one
/// careless edit from being false with no test able to see it.
#[derive(Debug, Clone, Copy)]
struct KernelScratch {
    ptr: i32,
    capacity: u32,
}

impl KernelScratch {
    /// Ask the kernel for `capacity` bytes of scratch.
    ///
    /// `purpose` appears in the failure so a boot that cannot get scratch says
    /// which allocation it was, rather than only how many bytes it wanted.
    fn allocate(
        alloc_scratch: &wasmtime::TypedFunc<u32, i32>,
        kernel_store: &mut Store<()>,
        capacity: u32,
        purpose: &str,
    ) -> anyhow::Result<Self> {
        let ptr = alloc_scratch.call(&mut *kernel_store, capacity)?;
        if ptr <= 0 {
            anyhow::bail!("kernel_alloc_scratch({capacity}) for {purpose} returned {ptr}");
        }
        Ok(Self { ptr, capacity })
    }

    /// Ask for `capacity` bytes, reporting exhaustion as an ANSWER rather than
    /// an error.
    ///
    /// A syscall that cannot get scratch owes its caller ENOMEM, not a host
    /// abort — so the exec and spawn paths need "no scratch" as a value they
    /// can turn into an errno, while boot needs it as a failure. The trap a
    /// kernel call can itself raise stays an error in both.
    fn allocate_or_none(
        alloc_scratch: &wasmtime::TypedFunc<u32, i32>,
        kernel_store: &mut Store<()>,
        capacity: u32,
    ) -> anyhow::Result<Option<Self>> {
        let ptr = alloc_scratch.call(&mut *kernel_store, capacity)?;
        Ok((ptr > 0).then_some(Self { ptr, capacity }))
    }

    /// The address to hand a kernel export, paired with its length.
    fn ptr(self) -> i32 {
        self.ptr
    }

    /// The capacity the allocator gave, which is the ONLY length a kernel
    /// export may be told this region holds.
    fn capacity(self) -> u32 {
        self.capacity
    }

    /// Fill this region with `bytes`.
    ///
    /// Refuses two different things, and they are genuinely different: bytes
    /// longer than the capacity the allocator gave (the invariant above), and
    /// a region that does not fit inside kernel memory at all (the ordinary
    /// bounds rule, asked of the whole capacity rather than of the write, so a
    /// region that could never have been valid is refused even when a short
    /// write into it would have fitted).
    fn write(self, kernel_mem: &SharedMemory, bytes: &[u8]) -> anyhow::Result<()> {
        if bytes.len() > self.capacity as usize {
            anyhow::bail!(
                "kernel scratch write of {} bytes exceeds the {} bytes the allocator gave it",
                bytes.len(),
                self.capacity,
            );
        }
        let offset = checked_shared_range(kernel_mem, self.ptr as u32 as u64, self.capacity)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "kernel scratch at {} with capacity {} is not inside kernel memory",
                    self.ptr,
                    self.capacity,
                )
            })?;
        unsafe { write_bytes(kernel_mem, offset, bytes) };
        Ok(())
    }
}

/// Copy `len` bytes from guest process memory at `addr` into kernel memory at
/// `dst_ptr` (`host_proc_read_bytes`). Returns 0, or `-EFAULT` if either range
/// is not wholly inside its own memory.
///
/// The copy is NOT atomic: another thread of the guest process may write these
/// bytes while they are being read, and no host can serialize against it. See
/// `HostIO::proc_write_bytes`'s doc comment
/// (`crates/runtime-core/src/process.rs`) for the contract this implements and
/// the copy-once-then-parse rule it obliges every kernel caller to follow.
fn proc_copy_in(
    guest: &SharedMemory,
    addr: u64,
    kernel: &SharedMemory,
    dst_ptr: u64,
    len: u32,
) -> i32 {
    let Some(src_off) = checked_shared_range(guest, addr, len) else {
        return -(libc_errno::EFAULT);
    };
    let Some(dst_off) = checked_shared_range(kernel, dst_ptr, len) else {
        return -(libc_errno::EFAULT);
    };
    let bytes = unsafe { read_bytes(guest, src_off, len as usize) };
    unsafe { write_bytes(kernel, dst_off, &bytes) };
    0
}

/// Copy `len` bytes from kernel memory at `src_ptr` into guest process memory
/// at `addr` (`host_proc_write_bytes`). Returns 0, or `-EFAULT` if either
/// range is not wholly inside its own memory. Non-atomic, as above.
fn proc_copy_out(
    kernel: &SharedMemory,
    src_ptr: u64,
    guest: &SharedMemory,
    addr: u64,
    len: u32,
) -> i32 {
    let Some(src_off) = checked_shared_range(kernel, src_ptr, len) else {
        return -(libc_errno::EFAULT);
    };
    let Some(dst_off) = checked_shared_range(guest, addr, len) else {
        return -(libc_errno::EFAULT);
    };
    let bytes = unsafe { read_bytes(kernel, src_off, len as usize) };
    unsafe { write_bytes(guest, dst_off, &bytes) };
    0
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

/// Zero a fresh anonymous mapping, as POSIX requires and the TS kernel worker
/// does for the same syscall (`ensureProcessMemoryCovers`).
///
/// The kernel keeps only the mapping's metadata: `munmap` cannot shrink wasm
/// memory, so the bytes an earlier mapping wrote are still there when the
/// kernel places a new one over them. Whole 64 KiB pages, because that is the
/// kernel's mapping granularity (`MemoryManager::mmap_anonymous`), clamped to
/// the memory `grow_to_cover` just made addressable.
fn zero_anonymous_mapping(mem: &SharedMemory, addr: usize, len: usize) {
    let end = addr
        .saturating_add(len.div_ceil(WASM_PAGE_SIZE).saturating_mul(WASM_PAGE_SIZE))
        .min(mem.data_size());
    if end > addr {
        unsafe { core::ptr::write_bytes(mem_base(mem).add(addr), 0, end - addr) };
    }
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

/// The Wasm value type a guest of this data model uses for a linear-memory
/// address: `i32` for wasm32, `i64` for wasm64.
///
/// B27b: every host-supplied global or host import that carries a guest
/// ADDRESS has to be declared in the guest's own index type, because Wasmtime
/// matches import types exactly. Before the wasm64 arm existed this host wrote
/// `ValType::I32` and `i32` parameters inline at each such site, which is the
/// same hidden wasm32 assumption `marshal_in`'s record sizing carried.
fn guest_index_type(pointer_width: u8) -> ValType {
    if pointer_width == 8 { ValType::I64 } else { ValType::I32 }
}

/// A guest address as a [`Val`] of that guest's index type.
fn guest_index_val(pointer_width: u8, addr: usize) -> Val {
    if pointer_width == 8 { Val::I64(addr as i64) } else { Val::I32(addr as i32) }
}

/// The imported shared kernel memory the pump reads/writes scratch through.
///
/// `pointer_width` is the DATA MODEL of the module that will import this
/// memory: a wasm64 module declares a 64-bit `env.memory`, and a 32-bit
/// `SharedMemory` does not satisfy that import (Wasmtime rejects the
/// instantiation on index-type mismatch). The kernel is a wasm32 module, so
/// its own memory is always built at width 4.
fn new_shared(engine: &Engine, min: u32, max: u32, pointer_width: u8) -> anyhow::Result<SharedMemory> {
    let ty = MemoryType::builder()
        .shared(true)
        .memory64(pointer_width == 8)
        .min(u64::from(min))
        .max(Some(u64::from(max)))
        .build()?;
    Ok(SharedMemory::new(engine, ty)?)
}

/// N1-I4 Task 2: a PRIVATE, byte-for-byte copy of `parent_mem`'s CURRENT
/// (already-grown) contents into a FRESH `SharedMemory` — the
/// private-memory half of `SYS_FORK` (`handle_fork`). Unlike I3a's thread
/// clone (`spawn_worker_thread`, which SHARES `guest_mem` directly with the
/// new OS thread), a `fork()` child must diverge from its parent: after this
/// call, a write to either the parent's or the child's memory must be
/// invisible to the other.
///
/// Copies `parent_mem.size()` pages — the parent's ACTUAL current extent —
/// rather than `ProcessLayout::initial_pages`, so anything the parent grew
/// into since its own launch (brk/mmap growth, and any co-resident
/// fork-module region already reserved by `instantiate_fork_module`/
/// `grow_to_cover`) is preserved in the child too; forking after either kind
/// of growth must not silently truncate the child's image. The new memory's
/// own `maximum` is [`DEFAULT_MAX_PAGES`] — the SAME ceiling
/// [`compute_guest_memory`] gives every guest memory in this host — so the
/// child can grow exactly as far as the parent could have.
///
/// # Soundness
/// `SharedMemory::data()` (via [`mem_base`]) gives a raw view with no
/// Rust-level exclusivity guarantee — this is exactly as sound (or
/// unsound) as every other raw access in this file (`read_bytes`/
/// `write_bytes`). The caller (`handle_fork`, running on the pump thread
/// while the forking guest thread is itself blocked inside its own
/// `kernel_fork` import call awaiting this very operation — see that
/// closure's busy-wait) is responsible for there being no OTHER concurrent
/// writer to `parent_mem` at the moment of the copy.
fn clone_guest_memory(engine: &Engine, parent_mem: &SharedMemory) -> anyhow::Result<SharedMemory> {
    let current_pages = parent_mem.size();
    // The child's memory must carry the PARENT's index type: a fork child
    // runs the parent's own module, so a 32-bit copy of a wasm64 parent
    // would not satisfy the module's `env.memory` import.
    let child_mem = new_shared(
        engine,
        current_pages as u32,
        DEFAULT_MAX_PAGES as u32,
        if parent_mem.ty().is_64() { 8 } else { 4 },
    )?;
    let len = current_pages as usize * WASM_PAGE_SIZE;
    unsafe {
        core::ptr::copy_nonoverlapping(mem_base(parent_mem), mem_base(&child_mem), len);
    }
    Ok(child_mem)
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
    /// with no manifest loaded and the `host_fetch_deferred` import unreachable.
    pub base_image: Option<BaseImage>,
    /// N1-I4 Task 2: instantiate a co-resident fork-module
    /// (`crates/fork-module`) alongside EVERY process this run launches (the
    /// boot process, and any spawned/forked descendant — see
    /// `launch_process`) and shrink each process's kernel-visible `max_addr`
    /// ceiling below the module's reserved region (see `launch_process`'s
    /// `kernel_set_max_addr` call site and `compute_fork_module_region`'s
    /// doc comment). `false` (the default) preserves every test that
    /// predates this increment byte-for-byte: no fork module is
    /// instantiated, and `max_addr` is the plain `ProcessLayout::max_addr`
    /// ceiling. Only a caller that actually built
    /// `local-binaries/fork_module32.wasm` (`crates/fork-module/build-
    /// wasm.sh`) should set this `true` — `run_guest` fails loudly (never
    /// silently skips) if it is `true` but the artifact is missing.
    pub enable_fork_module: bool,
    /// Test hook: deliver this signal to every fork child right after it is
    /// registered and its thread started, before its replay can report
    /// `SYS_FORK_REPLAY_READY`. `None` (the default) in every real run. Lets
    /// a test prove that a child killed inside its launch window still gives
    /// the parent its pid and a reapable zombie.
    pub fork_child_launch_signal: Option<u32>,
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
/// through `host_fetch_deferred` from the image's blob map. Lazy archives
/// and the host-FS `host_openat` family are never called for any path the
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
    // B29: a failure that implicates the kernel ARTIFACT gets the artifact's
    // own provenance attached, here, where the path is known.
    //
    // Without this the whole diagnosis a reader receives is
    // `failed to find function export kernel_set_process_pointer_width`,
    // repeated once per test -- a message that reads as "the kernel is broken"
    // when the cause is "your kernel predates your base". A reproduction of
    // exactly that (one export removed from an otherwise current kernel) turns
    // 57 passing tests into 30 failures, every one of them that bare line, with
    // nothing naming the artifact, its tier, or its age.
    //
    // The wrapper is here rather than around the forty `get_typed_func`
    // bindings because this is the outermost point that still knows which
    // artifact was loaded, and `implicates_kernel_artifact` keeps the note off
    // failures that are about the guest or the run.
    run_guest_inner(kernel_wasm, guest_wasm, options).map_err(|error| {
        if crate::implicates_kernel_artifact(&error) {
            let provenance = crate::kernel_artifact_provenance(kernel_wasm);
            error.context(provenance)
        } else {
            error
        }
    })
}

/// Compile a guest program, refusing one that declares a DIFFERENT ABI epoch.
///
/// L-D4. This host used to read no guest `__abi_version` at all -- only the
/// kernel's -- so a program built for another epoch instantiated normally and
/// failed later, or not at all, while
/// `crates/host-native/fixtures/README.md` asserted the opposite.
///
/// The rule is the peer host's, so the two cannot answer one question two
/// ways: `host/src/process-lifecycle.ts` refuses a declared epoch that
/// disagrees with the kernel's and lets a binary declaring NONE through,
/// because predating the marker is a different fact from being stale. The
/// reader is `wasm_artifact::read_abi_version`, the same one the kernel's own
/// provenance report uses.
///
/// This does NOT close L-D4. An import the host cannot find by NAME is still
/// stubbed by `define_unknown_imports_as_traps` rather than refused -- six of
/// the sixteen kernel imports these fixtures declare are stubbed today -- and
/// nothing here sees channel-LAYOUT drift. What it catches is an epoch bump
/// that left a program behind.
fn guest_module_for_this_epoch(engine: &Engine, program_bytes: &[u8]) -> anyhow::Result<Module> {
    if let Some(declared) = wasm_artifact::read_abi_version(program_bytes) {
        if declared != crate::EXPECTED_ABI_VERSION {
            anyhow::bail!(
                "guest program declares ABI {declared}, but this host runs ABI {}; \
                 rebuild it against this branch's libc",
                crate::EXPECTED_ABI_VERSION,
            );
        }
    }
    Ok(Module::new(engine, program_bytes)?)
}

fn run_guest_inner(
    kernel_wasm: &Path,
    guest_wasm: &[u8],
    options: &GuestOptions,
) -> anyhow::Result<RunOutcome> {
    let engine = crate::kernel_engine()?;

    // --- Guest module, layout, and memory (created first so kernel host imports
    // that touch process memory — e.g. host_futex_wake — can reference it) -----
    let guest_module = guest_module_for_this_epoch(&engine, guest_wasm)?;
    let (guest_mem, layout) = compute_guest_memory(&engine, &guest_module, guest_wasm)?;

    // --- Kernel instance (this thread owns it and the pump) -----------------
    let kernel_module = Module::from_file(&engine, kernel_wasm)?;
    // The kernel is a wasm32 module on every host, so its own imported
    // memory is always 32-bit regardless of the guest's data model.
    let kernel_mem = new_shared(&engine, KERNEL_MEMORY_MIN_PAGES, KERNEL_MEMORY_MAX_PAGES, 4)?;
    let captured = Arc::new(Mutex::new(CapturedIo::default()));

    // fd 0 (stdin) always; real host-directory access only for the mounts
    // `options.mounts` names (empty by default — T1's sandboxed path).
    let fs = Arc::new(HostFs::new(&options.mounts));

    // N1-I2: the base-image blob map `host_fetch_deferred` serves reads from,
    // populated from `options.base_image` when the caller supplies one.
    // Empty (the default, `options.base_image == None`) keeps the import
    // live but unreachable, exactly like N1-I1a: with no manifest loaded, the
    // overlay has no `BaseRegular` entries to read.
    let base_image_bytes: Arc<Vec<u8>> = Arc::new(
        options
            .base_image
            .as_ref()
            .map(|image| image.image.clone())
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
        &base_image_bytes,
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
    // B27a: the process data model. `get_typed_func` (not a fallible lookup
    // with a silent fallback) is the point — this export is REQUIRED, exactly
    // as `host/src/kernel-worker.ts` treats it. Until this binding existed the
    // native host never registered a width at all, and every caller-native
    // record on this host was sized by `Process::pointer_width`'s DEFAULT of
    // 4: correct for the wasm32 guests this host runs today, but a default
    // nobody chose rather than a fact anybody established.
    let set_pointer_width =
        kernel.get_typed_func::<(u32, u32), i32>(&mut kernel_store, "kernel_set_process_pointer_width")?;
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
    let thread_parent_tid_target = kernel
        .get_typed_func::<(u32, u32), i64>(&mut kernel_store, "kernel_thread_parent_tid_target")?;
    // Where the kernel placed a thread's control slot, and the release that
    // returns that range to its allocator once the thread is gone.
    let thread_slot_addr = kernel
        .get_typed_func::<(u32, u32), i64>(&mut kernel_store, "kernel_thread_slot_addr")?;
    let release_host_region = kernel
        .get_typed_func::<(u32, i32, i32), i32>(&mut kernel_store, "kernel_release_host_region")?;
    let set_thread_slot_quota = kernel
        .get_typed_func::<(u32, u32), i32>(&mut kernel_store, "kernel_set_thread_slot_quota")?;
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
    // K9: attach this host's directory capability to each registered foreign
    // prefix. Without a published root handle a foreign mount has a name in the
    // namespace but no way to be reached, so the kernel answers `ENOSYS` under
    // it; with one, the kernel walks it component by component from that handle.
    let set_foreign_mount_roots = kernel.get_typed_func::<(i32, u32), i32>(
        &mut kernel_store,
        "kernel_rootfs_set_foreign_mount_roots",
    )?;
    // N1-I2: replace the overlay's (empty) base layer from `options.base_image`'s
    // RTFS manifest, if one was supplied (see the call site below).
    let rootfs_load_image = kernel
        .get_typed_func::<(u32, u32), i32>(&mut kernel_store, "kernel_rootfs_load_image")?;
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
    // N1-I4 Task 2: `SYS_FORK`/`SYS_VFORK` (`handle_fork`). Clones the
    // caller's kernel-side `Process` state (signal mask, credentials, ...)
    // under a freshly allocated child pid; the host-side private-memory copy
    // and child guest `Instance`/co-resident module are `handle_fork`'s own
    // job (this export creates identity only, mirroring `kernel_spawn_process`
    // above).
    let fork_process =
        kernel.get_typed_func::<(u32, u32, u32), i32>(&mut kernel_store, "kernel_fork_process")?;
    // Lane F step 2: the kernel owns every fork launch. These report what
    // only this host can observe (a launch that could not start, a vfork
    // image whose threads were joined) and drain the kernel's decisions.
    let fork_launch_failed =
        kernel.get_typed_func::<(u32, u32), i32>(&mut kernel_store, "kernel_fork_launch_failed")?;
    let vfork_address_space_released = kernel
        .get_typed_func::<(u32, u32), i32>(&mut kernel_store, "kernel_vfork_address_space_released")?;
    let drain_fork_lifecycle_events = kernel
        .get_typed_func::<(i32, u32, u32), u32>(&mut kernel_store, "kernel_drain_fork_lifecycle_events")?;
    let generate_host_signal =
        kernel.get_typed_func::<(u32, u32), i32>(&mut kernel_store, "kernel_generate_host_signal")?;
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
    // — `host_fetch_deferred` is never called and
    // `host_openat` is never reached for any path the overlay still owns. When
    // `options.base_image` IS supplied (N1-I2, see the call site below), its
    // manifest is loaded before rootfs authority is enabled, so `/` starts
    // with that real base tree instead, and `host_fetch_deferred` serves its
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
    if options.base_image.is_some() {
        // The kernel parses the image ITSELF, pulling bytes through
        // `host_image_read` — the same seam production uses. It used to be
        // handed an RTFS-v3 manifest through scratch memory, which made the
        // host a second author of the tree and left nowhere to say where a
        // deferred file's bytes live.
        let image_len = base_image_bytes.len() as u64;
        let loaded = rootfs_load_image.call(
            &mut kernel_store,
            (image_len as u32, (image_len >> 32) as u32),
        )?;
        if loaded < 0 {
            // A malformed image leaves `/` empty rather than half-built, which
            // `rootfs::load_image` already guarantees by resetting on failure.
            eprintln!(
                "[host-native] kernel_rootfs_load_image({image_len} bytes) failed: {loaded}; \
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
        let prefix_scratch = KernelScratch::allocate(
            &alloc_scratch,
            &mut kernel_store,
            prefixes.len() as u32,
            "foreign prefixes",
        )?;
        prefix_scratch.write(&kernel_mem, &prefixes)?;
        let n = set_foreign_prefixes
            .call(&mut kernel_store, (prefix_scratch.ptr(), prefix_scratch.capacity()))?;
        if n < 0 {
            anyhow::bail!("kernel_rootfs_set_foreign_prefixes failed: {n}");
        }
        // K9: now attach a directory capability to each of those prefixes.
        // `HostFs::new` already opened every mount's real directory and holds
        // it in the one handle table; this publishes those handles so the
        // kernel's path walk has somewhere to start.
        //
        // The payload is a sequence of self-describing records — an 8-byte
        // little-endian `i64` handle, then the mount's canonical prefix bytes,
        // then a NUL — staged into the KERNEL's own memory like the prefixes
        // above. It must land BEFORE `kernel_set_rootfs_enabled(1)`, for the
        // same reason the prefixes must: a mount that becomes reachable before
        // its root handle exists would answer ENOSYS for a window.
        //
        // A mount whose directory could not be opened contributes no record.
        // That is deliberate and already reported by `HostFs::new`: the kernel
        // then answers ENOSYS under it, which is the truthful boundary rather
        // than a mount that silently resolves somewhere else.
        let roots = fs.foreign_mount_root_records();
        if !roots.is_empty() {
            let root_scratch = KernelScratch::allocate(
                &alloc_scratch,
                &mut kernel_store,
                roots.len() as u32,
                "foreign mount roots",
            )?;
            root_scratch.write(&kernel_mem, &roots)?;
            let attached = set_foreign_mount_roots
                .call(&mut kernel_store, (root_scratch.ptr(), root_scratch.capacity()))?;
            let expected = fs.mounts.iter().filter(|m| m.root_handle.is_some()).count() as i32;
            if attached != expected {
                // A record that matched no registered prefix means the two
                // registrations disagree about a mount's canonical spelling,
                // which would leave that mount unreachable. Fail the boot
                // rather than run a machine whose namespace is a surprise.
                anyhow::bail!(
                    "kernel_rootfs_set_foreign_mount_roots attached {attached} of {expected} \
                     mount roots: a published root handle did not match any registered foreign \
                     prefix"
                );
            }
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
    // N1-I4 Task 3: computed once from the boot module's OWN raw bytes (the
    // only site with them in scope — `wasmtime::Module` retains no
    // custom-section accessor, per `compute_guest_fork_format`'s doc
    // comment). `None` for any non-fork-instrumented guest, which is every
    // fixture that predates this task.
    let boot_fork_format = compute_guest_fork_format(guest_wasm)?.map(Arc::new);
    // N1-I4 Task 3: shared, SUMMED-into accumulator for
    // `RunOutcome::fork_proof_of_use` — see that field's doc comment. Threaded
    // through `launch_process`/`run_pump` exactly like `wait_table`.
    let fork_proof_of_use: Arc<Mutex<ForkProofOfUse>> = Arc::new(Mutex::new(ForkProofOfUse::default()));
    let process = launch_process(
        &engine,
        &mut kernel_store,
        &alloc_scratch,
        &set_thread_slot_quota,
        &set_brk_base,
        &set_mmap_base,
        &set_max_addr,
        &set_pointer_width,
        guest_module,
        guest_mem,
        layout,
        pid,
        import_exit_status.clone(),
        launch_argv,
        launch_env,
        options.enable_fork_module,
        ForkEntry::Normal, // the boot process is never itself a fork child
        boot_fork_format,
        Arc::clone(&fork_proof_of_use),
        false, // a fresh boot image: register its data model
    )?;
    let mut processes = vec![process];
    // N1-I3a Task 3: the boot process's ppid is the sentinel `0` — never a
    // real pid, so the boot process itself can never be `waitpid`'d (nothing
    // above it exists in this host's process model).
    wait_table.lock().unwrap().parent_of.insert(pid, 0);

    let fork_launch = ForkLaunchKernel {
        fork_process,
        launch_failed: fork_launch_failed,
        vfork_released: vfork_address_space_released,
        drain: drain_fork_lifecycle_events,
        drain_scratch: KernelScratch::allocate(
            &alloc_scratch,
            &mut kernel_store,
            (64 * wasm_posix_shared::fork_lifecycle_event_wire::RECORD_BYTES) as u32,
            "the fork-lifecycle event drain",
        )?,
        generate_host_signal,
    };

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
        &thread_parent_tid_target,
        &thread_slot_addr,
        &release_host_region,
        &alloc_scratch,
        &set_thread_slot_quota,
        &set_brk_base,
        &set_mmap_base,
        &set_max_addr,
        &set_pointer_width,
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
        &fork_launch,
        options.fork_child_launch_signal,
        &current_memory,
        &current_pid,
        &wait_table,
        options.enable_fork_module,
        &fork_proof_of_use,
        &mut syscall_trace,
    )?;

    let io = captured.lock().unwrap();
    let fork_proof_of_use = *fork_proof_of_use.lock().unwrap();
    Ok(RunOutcome {
        exit_code,
        stdout: io.stdout.clone(),
        stderr: io.stderr.clone(),
        syscall_trace,
        fork_proof_of_use,
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
// and wires the `host_fetch_deferred` import (below) to serve file bytes from an
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

/// An in-memory base VFS image: the real container bytes the kernel parses.
///
/// It used to be an RTFS-v3 manifest plus a `blob_id -> file bytes` map, and
/// that shape was the problem. A manifest is a HOST-side description of a
/// filesystem: the host builds it, the kernel trusts it, and the same tree now
/// has two authors — which is the defect this campaign exists to remove, found
/// in the reference host itself. It also could not survive URI addressing,
/// because the format has no field in which to say where a deferred file's
/// bytes live.
///
/// Now the host builds the artifact the kernel actually reads, with the
/// kernel's own writer, and the kernel parses it through
/// `kernel_rootfs_load_image` exactly as it does in production.
#[derive(Debug, Clone, Default)]
pub struct BaseImage {
    /// The VFS container bytes, ready for `kernel_rootfs_load_image`. The
    /// kernel pulls them through `host_image_read` rather than being handed
    /// them, which is the same positioned-read seam production uses.
    pub image: Vec<u8>,
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
    use runtime_core::kandelo_image_write::{Content, KandeloImageConfig, KandeloImageWriter};

    // Sized generously and fixed: this builder serves hand-written test trees,
    // and an image that cannot fit its own tree is a test bug rather than a
    // capacity question worth computing.
    let mut w = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(4 * 1024 * 1024))
        .expect("mkfs for the in-memory base image");
    let root = w.root();

    // Paths arrive parent-first, the same ordering the manifest required, so a
    // parent is always in `dirs` before a child names it.
    let mut dirs: BTreeMap<String, u32> = BTreeMap::new();
    dirs.insert("/".to_string(), root);
    for e in entries {
        if e.path == "/" {
            continue;
        }
        let (parent_path, name) = match e.path.rsplit_once('/') {
            Some(("", name)) => ("/", name),
            Some((parent, name)) => (parent, name),
            None => ("/", e.path.as_str()),
        };
        let parent = *dirs
            .get(parent_path)
            .unwrap_or_else(|| panic!("base image entry {} names no known parent", e.path));
        match &e.contents {
            None => {
                let ino = w
                    .mkdir(parent, name.as_bytes(), e.mode & 0o7777)
                    .expect("base image mkdir");
                dirs.insert(e.path.clone(), ino);
            }
            Some(bytes) => {
                w.create_file(parent, name.as_bytes(), e.mode & 0o7777, Content::Bytes(bytes))
                    .expect("base image create_file");
            }
        }
    }

    // Declared even though this builder defers nothing: `load_image` refuses an
    // image that describes its deferred files NOWHERE, because it cannot tell
    // "none" from "recorded somewhere I cannot read".
    w.declare_deferred_section();
    let body = w
        .finish()
        .expect("finish the base image")
        .to_vec(&runtime_core::kandelo_image_write::NoContent)
        .expect("materialize the base image body");

    let sections = runtime_core::vfsi_container::ContainerSections {
        lazy_json: b"",
        archive_json: None,
        metadata_json: None,
        kernel_lazy: None,
    };
    let image = runtime_core::vfsi_container::wrap(&body, &sections).expect("wrap the container");
    BaseImage { image }
}

/// Cross-memory copy primitive tests (`host_proc_read_bytes` /
/// `host_proc_write_bytes`). These exercise the free functions rather than the
/// import closures so no kernel instance is needed; the closures add only the
/// `pid == current_pid` liveness check on top.
///
/// The cases mirror the JS host's contract tests
/// (`host/test/kernel-public-scratch.test.ts`) so both hosts are pinned to the
/// same failure modes: an out-of-range guest range, an out-of-range kernel
/// range, a null address with a positive length, and the exact
/// end-of-memory boundary.
#[cfg(test)]
mod proc_bytes_tests {
    use super::*;

    const PAGE: usize = 65536;

    fn mems() -> (Engine, SharedMemory, SharedMemory) {
        let engine = crate::kernel_engine().expect("engine");
        let guest = new_shared(&engine, 1, 1, 4).expect("guest mem");
        let kernel = new_shared(&engine, 1, 1, 4).expect("kernel mem");
        (engine, guest, kernel)
    }

    #[test]
    fn copy_in_moves_guest_bytes_into_kernel_memory() {
        let (_engine, guest, kernel) = mems();
        unsafe { write_bytes(&guest, 128, &[1, 2, 3, 4]) };
        assert_eq!(proc_copy_in(&guest, 128, &kernel, 4096, 4), 0);
        assert_eq!(unsafe { read_bytes(&kernel, 4096, 4) }, vec![1, 2, 3, 4]);
    }

    #[test]
    fn copy_out_moves_kernel_bytes_into_guest_memory() {
        let (_engine, guest, kernel) = mems();
        unsafe { write_bytes(&kernel, 4096, &[9, 8, 7, 6]) };
        assert_eq!(proc_copy_out(&kernel, 4096, &guest, 128, 4), 0);
        assert_eq!(unsafe { read_bytes(&guest, 128, 4) }, vec![9, 8, 7, 6]);
    }

    #[test]
    fn a_guest_range_past_the_end_of_memory_is_efault() {
        let (_engine, guest, kernel) = mems();
        assert_eq!(proc_copy_in(&guest, PAGE as u64, &kernel, 4096, 1), -14);
        assert_eq!(proc_copy_out(&kernel, 4096, &guest, PAGE as u64, 1), -14);
    }

    #[test]
    fn a_kernel_range_past_the_end_of_memory_is_efault() {
        let (_engine, guest, kernel) = mems();
        assert_eq!(proc_copy_in(&guest, 128, &kernel, PAGE as u64, 1), -14);
        assert_eq!(proc_copy_out(&kernel, PAGE as u64, &guest, 128, 1), -14);
    }

    #[test]
    fn an_address_above_the_addressable_range_is_efault_not_truncated() {
        // The u64 address that aliases guest offset 128 if the host were to
        // narrow it to 32 bits. It must be rejected, never wrapped.
        let (_engine, guest, kernel) = mems();
        let aliasing = (1u64 << 32) | 128;
        assert_eq!(proc_copy_in(&guest, aliasing, &kernel, 4096, 4), -14);
        assert_eq!(proc_copy_out(&kernel, 4096, &guest, aliasing, 4), -14);
    }

    #[test]
    fn a_null_address_with_a_positive_length_is_efault() {
        let (_engine, guest, kernel) = mems();
        assert_eq!(proc_copy_in(&guest, 0, &kernel, 4096, 4), -14);
        assert_eq!(proc_copy_out(&kernel, 0, &guest, 128, 4), -14);
        // A zero-length copy at address zero is legal and copies nothing.
        assert_eq!(proc_copy_in(&guest, 0, &kernel, 0, 0), 0);
        assert_eq!(proc_copy_out(&kernel, 0, &guest, 0, 0), 0);
    }

    #[test]
    fn the_exact_end_of_memory_boundary_is_inclusive() {
        let (_engine, guest, kernel) = mems();
        let last4 = (PAGE - 4) as u64;
        assert_eq!(proc_copy_in(&guest, last4, &kernel, 4096, 4), 0);
        assert_eq!(proc_copy_in(&guest, last4, &kernel, 4096, 5), -14);
        assert_eq!(proc_copy_out(&kernel, 4096, &guest, last4, 4), 0);
        assert_eq!(proc_copy_out(&kernel, 4096, &guest, last4, 5), -14);
    }

    /// L-D1, stated as the case a bounds check cannot see.
    ///
    /// The pointer here is genuinely inside kernel memory and the write is
    /// genuinely inside kernel memory — every range check passes. What is
    /// false is that the allocator gave this caller that many bytes, and that
    /// fact lives beside the pointer or nowhere. Before `KernelScratch` this
    /// host wrote through a bare `copy_nonoverlapping` after a `ptr > 0`
    /// check, so this write landed silently on whatever the allocator had
    /// already promised to the next caller.
    #[test]
    fn a_write_longer_than_the_capacity_the_allocator_gave_is_refused() {
        let (_engine, _guest, kernel) = mems();
        let scratch = KernelScratch {
            ptr: 4096,
            capacity: 8,
        };

        // In bounds and within capacity: written.
        scratch
            .write(&kernel, &[1, 2, 3, 4, 5, 6, 7, 8])
            .expect("a write that fits the capacity is allowed");
        assert_eq!(
            unsafe { read_bytes(&kernel, 4096, 8) },
            vec![1, 2, 3, 4, 5, 6, 7, 8],
        );

        // One byte more. Still far inside a 64 KiB memory, so no bounds check
        // can object — only the capacity can.
        let error = scratch
            .write(&kernel, &[9; 9])
            .expect_err("a write past the allocated capacity must be refused");
        assert!(
            error.to_string().contains("exceeds the 8 bytes"),
            "refusal should name the capacity, said: {error}",
        );
        assert_eq!(
            unsafe { read_bytes(&kernel, 4096, 9) },
            vec![1, 2, 3, 4, 5, 6, 7, 8, 0],
            "the refused write must not have touched memory",
        );
    }

    /// This host places control memory above the program's OWN heap base.
    ///
    /// Not a restatement of `compute_layout`'s corpus, which checks the
    /// rule. This checks that THIS HOST reaches it with the program's
    /// `__heap_base` rather than with the fixed fallback — which is what it
    /// used to do, and what no other test here can see: **not one of the 42
    /// fixtures in `crates/host-native/fixtures/` exports `__heap_base`**, so
    /// every integration test takes the `None` branch and lands on the same
    /// 16 MiB fallback the old code produced. They prove nothing broke; they
    /// cannot prove anything changed.
    ///
    /// The 32 MiB case is the one that mattered: with the fallback, control
    /// memory landed at page 256 — INSIDE the static data of a program whose
    /// own heap starts at page 512.
    #[test]
    fn a_guests_own_heap_base_decides_where_control_memory_goes() {
        let guest = |heap_base: u32, pages: u32| {
            wat::parse_str(&format!(
                "(module (import \"env\" \"memory\" (memory {pages})) \
                 (global (export \"__heap_base\") i32 (i32.const {heap_base})))"
            ))
            .expect("valid wat")
        };

        // 32 MiB is page 512, so the channel lands on page 513.
        let high = guest(32 * 1024 * 1024, 1);
        let layout = ProcessLayout::compute(1, &high).expect("places a layout");
        assert_eq!(layout.channel_offset, 513 * 65536);
        assert_eq!(layout.brk_base, 515 * 65536);
        assert!(
            layout.channel_offset > 32 * 1024 * 1024,
            "the channel must sit ABOVE the guest's own static data, not at \
             the 16 MiB fallback this host used to assume",
        );

        // Below the fallback, the heap base still decides.
        let low = guest(2 * 1024 * 1024, 1);
        let layout = ProcessLayout::compute(1, &low).expect("places a layout");
        assert_eq!(layout.channel_offset, 33 * 65536);

        // And with no `__heap_base` at all, the fallback — the shape every
        // fixture in this crate has.
        let none = wat::parse_str(r#"(module (import "env" "memory" (memory 1)))"#)
            .expect("valid wat");
        let layout = ProcessLayout::compute(1, &none).expect("places a layout");
        assert_eq!(layout.channel_offset, 257 * 65536);
    }
    /// Nothing in this host may reach the scratch allocator except through
    /// [`KernelScratch`].
    ///
    /// The type only carries capacity beside pointer for callers that USE
    /// it. A site calling `kernel_alloc_scratch` directly gets a bare `i32`
    /// back and then restates the length when it hands the region to a
    /// kernel export — which is where the two can disagree, and which is how
    /// this host looked before L5. Three sites were still doing exactly that
    /// after the first pass: the two exec-target read chunks and the shebang
    /// record buffer, each passing a hand-written constant beside a pointer.
    ///
    /// A source check rather than a type-level one because the allocator is
    /// a plain `TypedFunc` the host receives from the kernel instance, so
    /// there is nowhere to hang a private constructor.
    /// `crates/kernel/src/wasm_api.rs` is guarded the same way, by
    /// `host/test/kernel-scratch-contract.test.ts`.
    #[test]
    fn the_scratch_allocator_is_reached_only_through_the_capacity_type() {
        let source = include_str!("guest.rs");
        // Assembled rather than written, because this file is its own
        // input: a literal needle would count ITSELF. The first run said
        // "found 4" for two real call sites plus the two literals in this
        // test, which is a guard reporting a violation it invented.
        let needle = concat!("alloc_scratch", ".call(");
        // CODE lines only. Assembling the needle stops it matching itself,
        // but it does not stop a COMMENT from matching -- and this check
        // failed exactly that way while the escape rule below was being
        // added, because the explanation quoted the call it was about. A
        // guard that a comment can break teaches people not to explain
        // things near it.
        let calls = source
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .filter(|line| line.contains(needle))
            .count();
        assert_eq!(
            calls, 2,
            "every kernel_alloc_scratch call must go through KernelScratch, \
             whose two constructors are its only permitted callers; found {calls}",
        );

        // The count above is of a SPELLING, and `cargo xtask perturb` walked
        // past it: `let sneaky = &alloc_scratch; sneaky.call(..)` allocates
        // bare and never writes the counted text. So the handle must also
        // never escape to another name -- that is the invariant, and the
        // call count is only its most visible consequence.
        let binding = concat!("alloc_", "scratch");
        let mut escapes = Vec::new();
        for (number, line) in source.lines().enumerate() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") || !trimmed.contains(binding) {
                continue;
            }
            // Binding the HANDLE, not the result of calling it. The first
            // version flagged `let ptr = alloc_scratch.call(..)` inside the
            // two constructors -- which is the allocation, the thing this
            // type exists to do -- so the rule is the right-hand side being
            // the bare identifier rather than any mention of it.
            let Some(rest) = trimmed.strip_prefix("let ") else { continue };
            let Some((_, value)) = rest.split_once('=') else { continue };
            let value = value.trim().trim_end_matches(';').trim();
            let value = value.trim_start_matches('&').trim_start_matches('*');
            if value == binding {
                escapes.push(format!("guest.rs:{}: {}", number + 1, trimmed));
            }
        }
        assert!(
            escapes.is_empty(),
            "the scratch allocator was bound to another name, which reaches \
             it without writing the text this check counts: {escapes:?}. \
             Allocate through KernelScratch instead.",
        );

        // ...and both of them ARE those constructors, so the count cannot be
        // satisfied by two fresh bare call sites while the type goes unused.
        for constructor in ["fn allocate(", "fn allocate_or_none("] {
            let start = source.find(constructor).unwrap_or_else(|| {
                panic!("{constructor} is gone; this check no longer means anything")
            });
            let body = &source[start..];
            let end = body.find("\n    }\n").expect("constructor body ends");
            assert!(
                body[..end].contains(needle),
                "{constructor} no longer allocates; the count is measuring something else",
            );
        }
    }
    /// The kernel's host imports may not write through a raw pointer at all.
    ///
    /// L-D3 was sixteen sites writing at an address the kernel handed in, with
    /// no range proof. One of them crashed the process with SIGBUS when its
    /// proof was removed. They are all proven now, through [`KernelLent`] --
    /// the inbound mirror of [`KernelScratch`], and the Rust counterpart of
    /// `#rustLentKernelDestination` in `host/src/kernel.ts`.
    ///
    /// So the invariant is no longer a count. It is that `write_bytes` does
    /// not appear in this function: every write goes through a region that
    /// was proven at the boundary, and a raw one is the thing being
    /// prevented. That took three tries to state, and the first two are worth
    /// keeping because they are the same mistake twice:
    ///
    ///   * counting addresses whose NAME looked like a pointer -- which
    ///     `host_readdir` already evaded with `let dp = dirent_ptr as ...`;
    ///   * counting writes minus proofs -- which went quietly wrong the
    ///     moment a proof was spelled `KernelLent::prove` instead of
    ///     `checked_shared_range`, and which assumed every proof in this
    ///     function belonged to a write in it.
    ///
    /// Zero is not a proxy for the invariant. It is the invariant.
    #[test]
    fn the_kernel_host_imports_never_write_through_a_raw_pointer() {
        let source = include_str!("guest.rs");
        // Assembled, and CODE lines only: a comment mentioning the call must
        // not be able to fail this, which is a mistake this file has already
        // made once.
        let marker = concat!("fn define_kernel_", "host_imports(");
        let needle = concat!("write_", "bytes(");

        let start = source.find(marker).unwrap_or_else(|| {
            panic!("{marker} is gone; this check no longer measures anything")
        });
        let body = &source[start..];
        let end = body.find("\n}\n").expect("the import function ends");
        let body = &body[..end];

        let raw: Vec<&str> = body
            .lines()
            .map(str::trim_start)
            .filter(|line| !line.starts_with("//"))
            .filter(|line| line.contains(needle))
            .collect();

        assert!(
            raw.is_empty(),
            "a kernel host import writes through a raw pointer: {raw:?}. The \
             kernel names a buffer and its capacity; prove the pair with \
             KernelLent (or write_lent) and answer -EFAULT when it does not \
             map. That is what the JavaScript host does for the same import.",
        );

        // ...and the body is really this function's, not an empty slice: a
        // marker that matched a comment would make the check above vacuous.
        assert!(
            body.len() > 10_000,
            "the scanned import body is {} bytes, which is too small to be \
             this function -- the scan is broken, not the host clean",
            body.len(),
        );
    }

    /// The channel status words really are pinned against the header.
    ///
    /// Their comment says they are "pinned here against that generated
    /// header" -- `WASM_POSIX_CHANNEL_STATUS_*` in
    /// `libc/glue/abi_constants.h`, which the guest glue writes and reads.
    /// Nothing pinned them. The comment described an intention in the
    /// present tense, which is the same thing as a citation that has rotted:
    /// a reader checking this host against its own comment would find them
    /// agreeing and learn nothing.
    ///
    /// These cannot be asked of `wasm_posix_shared` -- it does not declare
    /// them, because only the host and the guest glue touch the status word.
    /// The header is the single source, so the test reads it.
    #[test]
    fn the_channel_status_words_match_the_generated_header() {
        let header = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../libc/glue/abi_constants.h");
        let text = std::fs::read_to_string(&header).unwrap_or_else(|error| {
            panic!(
                "{}: {error}. These constants mirror that header and have no \
                 other source; if it moved, this host's status words are \
                 unanchored.",
                header.display(),
            )
        });

        for (name, expected) in [
            ("WASM_POSIX_CHANNEL_STATUS_IDLE", STATUS_IDLE),
            ("WASM_POSIX_CHANNEL_STATUS_PENDING", STATUS_PENDING),
            ("WASM_POSIX_CHANNEL_STATUS_COMPLETE", STATUS_COMPLETE),
        ] {
            let needle = format!("#define {name} ");
            let line = text
                .lines()
                .find(|l| l.starts_with(&needle))
                .unwrap_or_else(|| panic!("{name} is gone from the header"));
            let value: u32 = line[needle.len()..]
                .trim()
                .trim_end_matches('u')
                .parse()
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(
                value, expected,
                "{name} is {value} in the header and {expected} here",
            );
        }
    }

    /// The three record sizes still equal what they were written as.
    ///
    /// They are asked of `crates/shared` now instead of written down, which
    /// removes a transcription -- but it also changes WHERE they come from,
    /// and a change that silently altered one would be a worse bug than the
    /// duplication it removed. The old values are pinned here so the switch
    /// is provably behaviour-preserving.
    ///
    /// If a field is added to one of those structs this test fails, which is
    /// the right moment to look: the number moving is correct, and everything
    /// reading that record on the other side of the ABI has to move with it.
    #[test]
    fn the_shared_record_sizes_are_what_this_host_used_to_hardcode() {
        assert_eq!(WASM_STAT_SIZE, 88, "WasmStat");
        assert_eq!(WASM_STATFS_SIZE, 72, "WasmStatfs");
        assert_eq!(WASM_DIRENT_SIZE, 16, "WasmDirent");

        // The dirent type values moved the same way, for the same reason.
        assert_eq!((DT_UNKNOWN, DT_DIR, DT_REG, DT_LNK), (0, 4, 8, 10));

        // ...and the host's own serializers still fill exactly one record,
        // which is what makes the capacity above the right one to prove.
        assert_eq!(
            core::mem::size_of::<wasm_posix_shared::WasmDirent>(),
            8 + 4 + 4,
            "d_ino + d_type + d_namlen, with no padding a repr(C) struct \
             would have to explain",
        );
    }

    /// The inbound half of the capacity invariant, which a bounds check
    /// cannot supply.
    ///
    /// [`KernelLent`] exists so a write is bounded by what the kernel LENT,
    /// not by what the memory happens to hold. The distinction is the whole
    /// of L-D1 and L-D3: an address being inside the memory proves the host
    /// can reach those bytes, never that this caller was given them.
    ///
    /// The sibling for the outbound direction is
    /// `a_region_that_does_not_fit_kernel_memory_is_refused_even_for_a_short_write`.
    #[test]
    fn a_lent_region_bounds_a_write_by_the_capacity_not_by_the_memory() {
        let (_engine, _guest, kernel) = mems();

        // A pair that does not fit the memory is refused outright, so no
        // caller ever holds a region it cannot write.
        assert!(
            KernelLent::prove(&kernel, (PAGE - 4) as u64, 64).is_none(),
            "a region running past the end of kernel memory must not prove",
        );
        assert!(
            KernelLent::prove(&kernel, 0, 8).is_none(),
            "a null pointer is a failed allocation, not an address",
        );

        // A pair that fits proves, and an honest write lands.
        let lent = KernelLent::prove(&kernel, 4096, 8).expect("8 bytes at 4096 fit");
        assert!(lent.write(&kernel, &[1, 2, 3, 4]).is_ok());
        assert_eq!(unsafe { read_bytes(&kernel, 4096, 4) }, vec![1, 2, 3, 4]);

        // ...and the capacity still binds, even though the memory has room
        // for the longer write. This is the case a bounds check passes and
        // the invariant refuses.
        assert_eq!(
            lent.write(&kernel, &[0u8; 9]),
            Err(-libc_errno::EFAULT),
            "nine bytes into an eight-byte lend must be refused, though the \
             memory would have taken them",
        );
    }

    /// A launch entry is refused at a pointer past the end of the memory,
    /// with the errno the TypeScript host gives.
    ///
    /// `copy_launch_entry`'s own doc comment says it mirrors `copyEntry` in
    /// `host/src/worker-main.ts`, and it reproduced that contract's every
    /// errno -- EINVAL for a bad index, the zero-capacity length query,
    /// ERANGE for a capacity below the entry, EFAULT for a null destination.
    /// What it did not reproduce was the step that is not an errno: the TS
    /// version proves the range before copying and converts a refusal into
    /// EFAULT. Without that, a `buf_ptr` inside wasm32 but past the end of
    /// this memory reached `copy_nonoverlapping`.
    ///
    /// This is the transcription argument at its sharpest: the comment names
    /// the source, the visible contract came across intact, and the
    /// guarantee that was implicit in the source host went missing.
    /// A guest that declares a DIFFERENT ABI epoch is refused; one that
    /// declares NONE is not.
    ///
    /// Built from synthetic bytes rather than a fixture on purpose. Every
    /// committed fixture declares 44, so a mutation that weakens
    /// `guest_module_for_this_epoch` would SURVIVE a run over the corpus --
    /// the guard would be one no test could fail. These bytes are the two
    /// cases the corpus cannot supply.
    fn wasm_declaring(name: &[u8; 13], epoch: u8) -> Vec<u8> {
        let mut m: Vec<u8> = vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
        m.extend_from_slice(&[0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f]); // () -> i32
        m.extend_from_slice(&[0x03, 0x02, 0x01, 0x00]); // one func, type 0
        m.extend_from_slice(&[0x07, 0x11, 0x01, 0x0d]); // export section, one name of 13
        m.extend_from_slice(name);
        m.extend_from_slice(&[0x00, 0x00]); // kind func, index 0
        m.extend_from_slice(&[0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, epoch, 0x0b]); // i32.const
        m
    }

    #[test]
    fn a_guest_from_another_abi_epoch_is_refused_and_a_pre_marker_one_is_not() {
        let engine = Engine::default();
        let expected = crate::EXPECTED_ABI_VERSION as u8;

        let current = wasm_declaring(b"__abi_version", expected);
        assert_eq!(
            wasm_artifact::read_abi_version(&current),
            Some(crate::EXPECTED_ABI_VERSION),
            "the synthetic module must actually declare the epoch, or this test \
             proves nothing about either case below",
        );
        assert!(
            guest_module_for_this_epoch(&engine, &current).is_ok(),
            "a guest declaring THIS host's epoch must run",
        );

        let stale = wasm_declaring(b"__abi_version", expected - 1);
        let err = guest_module_for_this_epoch(&engine, &stale)
            .expect_err("a guest declaring a different epoch must be refused");
        let rendered = format!("{err:#}");
        assert!(
            rendered.contains("declares ABI") && rendered.contains("rebuild it"),
            "the refusal must name the epoch and say what to do, got: {rendered}",
        );

        // The peer host lets a binary predating the marker through, because
        // that is a different fact from being stale. Same name length, so the
        // module's section sizes are unchanged and only the NAME differs.
        let unmarked = wasm_declaring(b"__abi_versioX", expected - 1);
        assert_eq!(
            wasm_artifact::read_abi_version(&unmarked),
            None,
            "the unmarked module must genuinely carry no marker",
        );
        assert!(
            guest_module_for_this_epoch(&engine, &unmarked).is_ok(),
            "a guest declaring NO epoch must still run, as host/src/\
             process-lifecycle.ts allows",
        );
    }

    #[test]
    fn a_launch_entry_past_the_end_of_memory_is_efault_not_a_raw_copy() {
        let (_engine, guest, _kernel) = mems();
        let entries = vec![b"PATH=/usr/bin".to_vec()];
        let len = entries[0].len() as u32;

        // In bounds: the copy happens and the length comes back.
        assert_eq!(copy_launch_entry(&guest, &entries, 0, 256, len), len as i32);
        assert_eq!(unsafe { read_bytes(&guest, 256, len as usize) }, entries[0]);

        // One page memory, so this address is a legal wasm32 pointer that
        // this memory does not own. The engine would refuse it in the
        // JavaScript host; here only the rule does.
        assert_eq!(
            copy_launch_entry(&guest, &entries, 0, PAGE as u64, len),
            -libc_errno::EFAULT,
        );

        // Straddling the end is refused too, which a "pointer < length"
        // check would have allowed.
        assert_eq!(
            copy_launch_entry(&guest, &entries, 0, (PAGE - 4) as u64, len),
            -libc_errno::EFAULT,
        );

        // The errnos that were already right stay right.
        assert_eq!(copy_launch_entry(&guest, &entries, 7, 256, len), -libc_errno::EINVAL);
        assert_eq!(copy_launch_entry(&guest, &entries, 0, 256, 0), len as i32);
        assert_eq!(copy_launch_entry(&guest, &entries, 0, 256, len - 1), -libc_errno::ERANGE);
        assert_eq!(copy_launch_entry(&guest, &entries, 0, 0, len), -libc_errno::EFAULT);
    }

    /// A scratch pointer may not travel to a kernel export without the
    /// capacity of the SAME region beside it.
    ///
    /// The sibling check above guarantees every allocation goes through
    /// [`KernelScratch`], and the type guarantees a write cannot exceed what
    /// the allocator gave. Neither covers the length a call site hands to a
    /// kernel export beside the pointer, which is the third place the two can
    /// disagree — and where this host was still restating lengths after L5's
    /// first pass.
    ///
    /// Writing this check is what found the last one. A site that binds the
    /// pointer to a local first (`let s = region.<pointer>() as u32 as usize`)
    /// reads like a base address for manual indexing, and was classified as
    /// one; it then passed the BLOB's length where
    /// `kernel_spawn_blob_decode` declares `buf_capacity`, so the kernel's own
    /// `blob_len > buf_capacity` refusal was fed the same number twice and
    /// could never fire. Hazard H-2 on the far side of the ABI, created by a
    /// restated length on this one.
    ///
    /// Two exemptions, both genuine base addresses: the syscall channel's
    /// base, stored on `GuestProcess` and indexed against
    /// `MIN_CHANNEL_SIZE` for the life of the process. An exemption list
    /// that grows silently is how a guard stops meaning anything, so the
    /// count is pinned.
    #[test]
    fn a_scratch_pointer_never_travels_without_its_own_capacity() {
        let source = include_str!("guest.rs");
        // Assembled, like the sibling check: a literal needle would match
        // inside this test and report violations it invented.
        let pointer = concat!(".p", "tr()");
        let capacity = concat!(".cap", "acity()");

        let mut paired = 0usize;
        let mut exempt = 0usize;
        let mut offenders: Vec<String> = Vec::new();

        let mut at = 0usize;
        while let Some(found) = source[at..].find(pointer) {
            let idx = at + found;
            at = idx + pointer.len();

            // The receiver is the identifier immediately before the call.
            // An empty one means prose or a doc comment, not code.
            let head = &source[..idx];
            let region: String = head
                .chars()
                .rev()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            if region.is_empty() {
                continue;
            }

            // The statement this use sits in, and the one after it: a site
            // may bind the pointer to a local and pass it on the next line.
            let rest = &source[at..];
            let stmt_end = rest.find(';').map(|i| i + 1).unwrap_or(rest.len());
            let stmt = &rest[..stmt_end];
            let tail = &rest[stmt_end..];
            let next_end = tail.find(';').map(|i| i + 1).unwrap_or(tail.len());
            let window = format!("{stmt}{}", &tail[..next_end]);
            let needle = format!("{region}{capacity}");

            if window.contains(&needle) {
                paired += 1;
            } else if stmt.trim_start().starts_with("as u32 as usize;") {
                // A base address kept for manual indexing. Named, counted,
                // and capped below — never a silent fallthrough.
                exempt += 1;
            } else {
                let line = source[..idx].lines().count();
                offenders.push(format!("{region} at guest.rs:{line}"));
            }
        }

        assert!(
            offenders.is_empty(),
            "a scratch pointer reached a call without its own region's \
             capacity beside it: {offenders:?}. Ask the region, do not \
             restate the length — they are the two that can disagree.",
        );
        assert_eq!(
            exempt, 2,
            "exactly two scratch pointers are base addresses (the syscall \
             channel, per process); found {exempt}. A new one is not \
             automatically wrong, but it must be read and this count moved \
             deliberately, never to make the check pass.",
        );
        assert!(
            paired >= 8,
            "only {paired} pointer/capacity pairs found; this check reads \
             its own file, so a collapse to zero means the scan broke, not \
             that the host got cleaner. Raise this floor when sites are \
             added. Lower it only for a site you can name as deleted, and \
             record the name here — never to make a run pass. The floor was \
             9 until the native host stopped staging a manifest for the \
             kernel to walk: `rootfs_load_manifest(manifest.ptr(), \
             manifest.capacity())` became `kernel_rootfs_load_image(len_lo, \
             len_hi)`, where the kernel allocates its own buffer and the \
             host writes into it through `host_image_read`. That pair left \
             the host; it did not move somewhere the scan cannot see.",
        );
    }
    /// The other half: a capacity that does not fit the memory at all is
    /// refused even when the bytes being written would have.
    #[test]
    fn a_region_that_does_not_fit_kernel_memory_is_refused_even_for_a_short_write() {
        let (_engine, _guest, kernel) = mems();
        let scratch = KernelScratch {
            ptr: (PAGE - 4) as i32,
            capacity: 64,
        };
        let error = scratch
            .write(&kernel, &[1, 2])
            .expect_err("a region past the end of memory must be refused");
        assert!(
            error.to_string().contains("not inside kernel memory"),
            "refusal should name the memory, said: {error}",
        );
    }
}

#[cfg(test)]
mod base_image_tests {
    use super::*;

    /// Mount the image with the kernel's OWN reader.
    ///
    /// The tests below used to parse an RTFS manifest byte by byte, which
    /// asserted the shape of a host-side description rather than whether the
    /// kernel could read what this host produced. Mounting is the question
    /// that matters, and it is the same code the kernel runs.
    fn mount(image: &[u8]) -> runtime_core::kandelo_image_fs::KandeloImageFs<&[u8]> {
        // Past the container header: `KandeloImageFs::mount` reads a BODY, while the
        // kernel is handed the whole container and finds the body itself.
        let body = &image[runtime_core::kandelo_image_fs::VFSI_HEADER_SIZE..];
        runtime_core::kandelo_image_fs::KandeloImageFs::mount(body).expect("the kernel's reader mounts it")
    }

    #[test]
    fn build_base_image_round_trips_a_tiny_tree() {
        let image = build_base_image(&[
            BaseEntrySpec::dir("/", 1, 0o755),
            BaseEntrySpec::dir("/etc", 2, 0o755),
            BaseEntrySpec::file("/etc/hello", 3, 0o644, b"hi from base\n".to_vec()),
        ]);

        let fs = mount(&image.image);
        let etc = fs.resolve(b"/etc", true).expect("/etc");
        assert_eq!(
            fs.stat_ino(etc).expect("stat /etc").mode & 0o7777,
            0o755,
            "a directory keeps the mode the spec gave it",
        );
        let hello = fs.resolve(b"/etc/hello", true).expect("/etc/hello");
        let st = fs.stat_ino(hello).expect("stat /etc/hello");
        assert_eq!(st.mode & 0o7777, 0o644);
        // The bytes are IN the image now. They used to live in a side map the
        // host served by inode number, which is the arrangement that could not
        // survive addressing a resource by URI.
        assert_eq!(st.size, 13, "the file's real length, carried by the image");
    }

    /// Task-1-review fix: a caller that passes a raw `mode` carrying `S_IFMT`
    /// file-type bits (e.g. straight from `std::fs::Metadata::mode()`) must
    /// not have those bits leak into the emitted IMAGE — `build_base_image`
    /// must mask to `& 0o7777` itself rather than relying solely on the
    /// kernel's own re-mask on insert.
    #[test]
    fn build_base_image_masks_file_type_bits_out_of_mode() {
        const S_IFDIR: u32 = 0o040000;
        const S_IFREG: u32 = 0o100000;
        let image = build_base_image(&[
            BaseEntrySpec::dir("/", 1, S_IFDIR | 0o755),
            BaseEntrySpec::file("/hello", 2, S_IFREG | 0o644, b"hi\n".to_vec()),
        ]);

        // Read back through the kernel's reader: `S_IFMT` bits that survived
        // would show up here as a mode this filesystem never meant to store.
        let fs = mount(&image.image);
        let hello = fs.resolve(b"/hello", true).expect("/hello");
        assert_eq!(
            fs.stat_ino(hello).expect("stat").mode & 0o7777,
            0o644,
            "file mode must be masked to 0o7777",
        );
        assert_eq!(
            fs.stat_ino(hello).expect("stat").mode & 0o170000,
            0o100000,
            "and the image's own type bits say REGULAR, not whatever the caller passed",
        );
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
    base_image_bytes: &Arc<Vec<u8>>,
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
    // host_proc_read_bytes(pid, addr, dst_ptr, len) -> i32 and
    // host_proc_write_bytes(pid, addr, src_ptr, len) -> i32: the kernel's
    // general cross-memory primitive. `addr` is an address in the GUEST
    // process `pid`; `dst_ptr`/`src_ptr` are addresses in KERNEL memory.
    //
    // The two address widths are deliberately different, and the closures'
    // parameter types say so. `addr` is `u64` because it names a location in a
    // guest whose width the kernel does not control — one signature covers a
    // wasm32 and a wasm64 guest, and an address above 4 GiB from a wasm64
    // guest must be rejectable rather than silently aliased down to its low 32
    // bits. `dst_ptr`/`src_ptr` are `u32` because they name a location in the
    // kernel's OWN linear memory, and this host runs the wasm32 kernel build
    // (`target/wasm32-unknown-unknown/release/kandelo_kernel.wasm`, see
    // `crate::EXPECTED_HOST_IMPORT_COUNT`'s neighbours in `lib.rs`), where a
    // kernel pointer is an `i32`. A wasm64 kernel would import these with an
    // `i64` in that position; matching the module's declared type is what
    // `Linker::func_wrap` checks, so that build would need its own closure
    // rather than silently mismatching here. Until
    // now both fell to `define_unknown_imports_as_traps`, so any kernel path
    // reaching for process memory killed a native run — truthful, but it meant
    // the native host could not run the DRI/KMS paths that have used this
    // primitive since it was introduced, and could not run anything the
    // Rust-first campaign converts onto it.
    //
    // Resolving `pid` → memory: this host binds the dispatching process's
    // memory and pid into `current_memory`/`current_pid` immediately before
    // every `kernel_handle_channel` call (`bind_and_dispatch`), and the
    // contract on `HostIO::proc_write_bytes` states that the only sound target
    // is the process currently being dispatched for — it is live by
    // construction, because these imports never re-enter the kernel and host
    // dispatch is synchronous, so no exec or exit can interleave and rebind
    // the pid's memory underneath the copy.
    //
    // So these closures resolve `pid` by CHECKING it against `current_pid`
    // rather than by looking it up in a pid-keyed registry. That is a
    // deliberate choice, not a shortcut. A registry would have to be kept in
    // step with four process-creation sites, `handle_exec_common`'s
    // `std::mem::replace` of a process's entire image, and every teardown
    // path; a single missed update there is a silent write into the WRONG
    // process's memory — a stale entry cannot be distinguished from a live one
    // at the point of use. Checking the binding the pump already maintains has
    // no stale state to miss: a target that is not the dispatching process
    // returns `-ESRCH` and the caller sees a boundary instead of corruption.
    // Reaching a peer process's memory would need its own liveness proof and
    // is a separate contract change, exactly as the trait doc says.
    {
        let kmem = kernel_mem.clone();
        let current_memory = current_memory.clone();
        let current_pid = current_pid.clone();
        linker.func_wrap(
            "env",
            "host_proc_read_bytes",
            move |_c: Caller<'_, ()>, pid: i32, addr: u64, dst_ptr: u32, len: u32| -> i32 {
                if pid < 0 || pid as u32 != *current_pid.lock().unwrap() {
                    return -(libc_errno::ESRCH);
                }
                let guest = current_memory.lock().unwrap().clone();
                proc_copy_in(&guest, addr, &kmem, u64::from(dst_ptr), len)
            },
        )?;
    }
    {
        let kmem = kernel_mem.clone();
        let current_memory = current_memory.clone();
        let current_pid = current_pid.clone();
        linker.func_wrap(
            "env",
            "host_proc_write_bytes",
            move |_c: Caller<'_, ()>, pid: i32, addr: u64, src_ptr: u32, len: u32| -> i32 {
                if pid < 0 || pid as u32 != *current_pid.lock().unwrap() {
                    return -(libc_errno::ESRCH);
                }
                let guest = current_memory.lock().unwrap().clone();
                proc_copy_out(&kmem, u64::from(src_ptr), &guest, addr, len)
            },
        )?;
    }
    // host_write(handle, buf_ptr, buf_len) -> i32: route fd 1/2 to captured
    // stdout/stderr (the process was created with HostPipe stdio). buf_ptr is a
    // kernel-memory address the pump staged the bytes at.
    //
    // An open host-FS handle writes at that file's own OS cursor. Regular-file
    // writes normally arrive via host_pwrite instead (the kernel owns their
    // offset); this path is the parity twin of `host_read`'s, for a non-regular
    // host-backed handle that reaches it.
    {
        let mem = kernel_mem.clone();
        let cap = captured.clone();
        let fs = fs.clone();
        linker.func_wrap(
            "env",
            "host_write",
            move |_c: Caller<'_, ()>, handle: i64, ptr: i32, len: i32| -> i32 {
                if len < 0 {
                    return -(libc_errno::EINVAL);
                }
                let bytes = unsafe { read_bytes(&mem, ptr as u32 as usize, len as usize) };
                match handle {
                    1 => cap.lock().unwrap().stdout.extend_from_slice(&bytes),
                    2 => cap.lock().unwrap().stderr.extend_from_slice(&bytes),
                    _ => {
                        // `Write for &File` writes at the file's own OS cursor
                        // without needing a `&mut File`.
                        return match fs.with_file(handle, |file| {
                            (&mut &*file).write(&bytes).map_err(|e| errno_from_io(&e))
                        }) {
                            Ok(n) => n as i32,
                            Err(errno) => -errno,
                        };
                    }
                }
                len
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
                // Two separate lends: the kernel names two independent
                // 8-byte slots, and proving one says nothing about the other.
                if let Err(errno) =
                    write_lent(&mem, sec_ptr as u32 as u64, 8, &(now.as_secs() as i64).to_le_bytes())
                {
                    return errno;
                }
                if let Err(errno) = write_lent(
                    &mem,
                    nsec_ptr as u32 as u64,
                    8,
                    &(now.subsec_nanos() as i64).to_le_bytes(),
                ) {
                    return errno;
                }
                0
            },
        )?;
    }
    // host_close(handle) -> i32: releases an open host-FS handle if this is one
    // (only possible when a mount is configured); otherwise a no-op success
    // (the stdio HostPipes 0/1/2 need nothing released).
    //
    // K9: this is now the ONLY release import. A directory handle is closed
    // here exactly like a file handle — `host_closedir` is gone, and with it
    // the second host-owned handle namespace the kernel had to remember which
    // close to call for.
    {
        let fs = fs.clone();
        linker.func_wrap("env", "host_close", move |_c: Caller<'_, ()>, handle: i64| -> i32 {
            fs.objects.lock().unwrap().remove(&handle);
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
                            match write_lent(
                                &mem,
                                buf_ptr as u32 as u64,
                                len as u32,
                                &HOST_STDIN_LINE[..n],
                            ) {
                                Ok(()) => n as i32,
                                Err(errno) => errno,
                            }
                        }
                        _ => 0, // EOF
                    };
                }
                let mut tmp = vec![0u8; len as usize];
                let read = fs.with_file(handle, |file| {
                    // `Read for &File` reads at the file's own OS cursor
                    // without needing a `&mut File`, so the handle table stays
                    // behind a shared borrow.
                    (&mut &*file).read(&mut tmp).map_err(|e| errno_from_io(&e))
                });
                match read {
                    Ok(n) => {
                        match write_lent(&mem, buf_ptr as u32 as u64, len as u32, &tmp[..n]) {
                            Ok(()) => n as i32,
                            Err(errno) => errno,
                        }
                    }
                    Err(errno) => -errno,
                }
            },
        )?;
    }
    // K9: the handle-only host filesystem contract, wired ONLY when at least
    // one mount is configured. With no mount every one of these is left to
    // `define_unknown_imports_as_traps` below — a truthful boundary, since the
    // overlay claims all of `/` and the kernel can never reach a host directory
    // capability that was never published.
    //
    // Every import in this block takes a directory handle this host previously
    // issued plus AT MOST ONE path component. None of them takes a guest path,
    // a mount prefix, a `..`, or a symlink chain: the kernel resolves the POSIX
    // namespace itself and steps this host one component at a time from a mount
    // root published through `kernel_rootfs_set_foreign_mount_roots`. See
    // `crates/runtime-core/src/hostdir.rs` for the contract and its rationale.
    //
    // This is also where host-native stops being a read-only host. Before K9 it
    // could open, stat, read and list a mounted directory but could not create
    // or remove an entry in it at all — every write-side name operation trapped.
    // The `*at` family below closes that: `mkdirat`, `unlinkat`, `renameat`,
    // `linkat`, `symlinkat`, `fchmodat`, `fchownat` and `utimensat` are new
    // native capability, not a relocation of something that already worked.
    if !fs.mounts.is_empty() {
        // host_openat(dir, name_ptr, name_len, flags, mode) -> i64: open one
        // component of a directory capability. Returns a handle or a negated
        // errno.
        //
        // `O_DIRECTORY` is not passed to the OS as a flag; the opened object's
        // own type decides. A directory always becomes a `HostObject::Dir` (so
        // `host_readdir` can iterate it and a read of it answers `EISDIR`),
        // whether or not `O_DIRECTORY` was asked for, and `O_DIRECTORY` on a
        // non-directory is `ENOTDIR`.
        {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                "host_openat",
                move |_c: Caller<'_, ()>,
                      dir: i64,
                      name_ptr: i32,
                      name_len: i32,
                      flags: i32,
                      mode: i32|
                      -> i64 {
                    let name = match unsafe { read_component(&mem, name_ptr, name_len) } {
                        Ok(name) => name,
                        Err(errno) => return -(errno as i64),
                    };
                    let flags = flags as u32;
                    let opened = fs.with_dir(dir, |dh| {
                        if name.as_os_str().as_bytes() == b"." {
                            // The directory naming itself. It must be a FRESH
                            // descriptor: the kernel owns what it is handed and
                            // will close it, while a mount root has to outlive
                            // every walk that borrows it.
                            return dh
                                .dir
                                .try_clone()
                                .map(|d| HostObject::Dir(DirHandle::new(d)))
                                .map_err(|e| errno_from_io(&e));
                        }
                        let opts = open_options_from_flags(flags, mode as u32);
                        let file = dh
                            .dir
                            .open_with(&name, &opts)
                            .map_err(|e| errno_from_io(&e))?;
                        let is_dir = file.metadata().map_err(|e| errno_from_io(&e))?.is_dir();
                        if flags & open_flags::O_DIRECTORY != 0 && !is_dir {
                            return Err(libc_errno::ENOTDIR);
                        }
                        let std_file = file.into_std();
                        if is_dir {
                            Ok(HostObject::Dir(DirHandle::new(CapDir::from_std_file(
                                std_file,
                            ))))
                        } else {
                            Ok(HostObject::File(std_file))
                        }
                    });
                    match opened {
                        Ok(object) => fs.insert(object),
                        Err(errno) => -(errno as i64),
                    }
                },
            )?;
        }
        // host_fstatat(dir, name_ptr, name_len, flags, stat_ptr) -> i32:
        // metadata for one component of a directory capability.
        // `AT_SYMLINK_NOFOLLOW` describes the symlink itself rather than its
        // target — which is why this cannot reduce to opening the entry and
        // calling `host_fstat`: opening a symlink follows it.
        {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                "host_fstatat",
                move |_c: Caller<'_, ()>,
                      dir: i64,
                      name_ptr: i32,
                      name_len: i32,
                      flags: i32,
                      stat_ptr: i32|
                      -> i32 {
                    let name = match unsafe { read_component(&mem, name_ptr, name_len) } {
                        Ok(name) => name,
                        Err(errno) => return -errno,
                    };
                    let nofollow = flags as u32 & open_flags::AT_SYMLINK_NOFOLLOW != 0;
                    let meta = fs.with_dir(dir, |dh| {
                        let result = if name.as_os_str().as_bytes() == b"." {
                            // A directory handle is never itself a symlink, so
                            // NOFOLLOW has nothing to withhold here.
                            dh.dir.dir_metadata()
                        } else if nofollow {
                            dh.dir.symlink_metadata(&name)
                        } else {
                            dh.dir.metadata(&name)
                        };
                        result.map_err(|e| errno_from_io(&e))
                    });
                    match meta {
                        Ok(m) => {
                            let Some(dest) = KernelLent::prove(
                                &mem,
                                stat_ptr as u32 as u64,
                                WASM_STAT_SIZE as u32,
                            ) else {
                                return -libc_errno::EFAULT;
                            };
                            match write_wasm_stat_from_cap_metadata(&mem, dest, &m) {
                                Ok(()) => 0,
                                Err(errno) => errno,
                            }
                        }
                        Err(errno) => -errno,
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
                move |_c: Caller<'_, ()>,
                      handle: i64,
                      buf_ptr: i32,
                      len: i32,
                      off_lo: i32,
                      off_hi: i32|
                      -> i32 {
                    if len < 0 {
                        return -libc_errno::EINVAL;
                    }
                    let offset = combine_i64(off_lo, off_hi) as u64;
                    let mut tmp = vec![0u8; len as usize];
                    match fs.with_file(handle, |file| {
                        file.read_at(&mut tmp, offset).map_err(|e| errno_from_io(&e))
                    }) {
                        Ok(n) => {
                            match write_lent(&mem, buf_ptr as u32 as u64, len as u32, &tmp[..n]) {
                                Ok(()) => n as i32,
                                Err(errno) => errno,
                            }
                        }
                        Err(errno) => -errno,
                    }
                },
            )?;
        }
        // host_pwrite(handle, buf_ptr, len, offset_lo, offset_hi) -> i32: the
        // write-side twin of host_pread, and the reason a program can now do
        // more with a mounted tree than read it. The kernel owns the OFD
        // offset, so this writes at an explicit position and never moves the
        // file's OS cursor.
        {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                "host_pwrite",
                move |_c: Caller<'_, ()>,
                      handle: i64,
                      buf_ptr: i32,
                      len: i32,
                      off_lo: i32,
                      off_hi: i32|
                      -> i32 {
                    if len < 0 {
                        return -libc_errno::EINVAL;
                    }
                    let bytes = unsafe { read_bytes(&mem, buf_ptr as u32 as usize, len as usize) };
                    let offset = combine_i64(off_lo, off_hi) as u64;
                    match fs.with_file(handle, |file| {
                        file.write_at(&bytes, offset).map_err(|e| errno_from_io(&e))
                    }) {
                        Ok(n) => n as i32,
                        Err(errno) => -errno,
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
                    let offset = combine_i64(off_lo, off_hi);
                    let resolved = fs.with_file(handle, |file| {
                        if whence as u32 == SEEK_END {
                            let len = file.metadata().map_err(|e| errno_from_io(&e))?.len();
                            Ok((len as i64).saturating_add(offset))
                        } else {
                            Ok(offset)
                        }
                    });
                    match resolved {
                        Ok(result) if result < 0 => -(libc_errno::EIO as i64),
                        Ok(result) => result,
                        Err(errno) => -(errno as i64),
                    }
                },
            )?;
        }
        // host_fstat(handle, stat_ptr) -> i32: real metadata for any open host
        // handle — file or directory, out of the one handle table K9 collapsed
        // them into.
        {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                "host_fstat",
                move |_c: Caller<'_, ()>, handle: i64, stat_ptr: i32| -> i32 {
                    let objects = fs.objects.lock().unwrap();
                    // L-D3: the kernel's `stat_ptr` is proven once, here, and
                    // travels as a region rather than as an address.
                    let Some(dest) =
                        KernelLent::prove(&mem, stat_ptr as u32 as u64, WASM_STAT_SIZE as u32)
                    else {
                        return -libc_errno::EFAULT;
                    };
                    match objects.get(&handle) {
                        Some(HostObject::File(file)) => match file.metadata() {
                            Ok(m) => match write_wasm_stat_from_metadata(&mem, dest, &m) {
                                Ok(()) => 0,
                                Err(errno) => errno,
                            },
                            Err(e) => -errno_from_io(&e),
                        },
                        Some(HostObject::Dir(dh)) => match dh.dir.dir_metadata() {
                            Ok(m) => match write_wasm_stat_from_cap_metadata(&mem, dest, &m) {
                                Ok(()) => 0,
                                Err(errno) => errno,
                            },
                            Err(e) => -errno_from_io(&e),
                        },
                        None => -libc_errno::EBADF,
                    }
                },
            )?;
        }
        // host_ftruncate(handle, length) -> i32.
        {
            let fs = fs.clone();
            linker.func_wrap(
                "env",
                "host_ftruncate",
                move |_c: Caller<'_, ()>, handle: i64, length: i64| -> i32 {
                    let Ok(length) = u64::try_from(length) else {
                        return -libc_errno::EINVAL;
                    };
                    match fs
                        .with_file(handle, |file| file.set_len(length).map_err(|e| errno_from_io(&e)))
                    {
                        Ok(()) => 0,
                        Err(errno) => -errno,
                    }
                },
            )?;
        }
        // host_fsync(handle) -> i32: durability for a handle the guest asked to
        // be durable. `fsync` (not `fdatasync`) because `fsync(2)` flushes
        // metadata too, and it goes through the descriptor so a directory
        // handle — `fsync` on a directory is how a rename is made durable — is
        // as valid a target as a file.
        {
            let fs = fs.clone();
            linker.func_wrap(
                "env",
                "host_fsync",
                move |_c: Caller<'_, ()>, handle: i64| -> i32 {
                    match fs.with_fd(handle, |fd| rustix::fs::fsync(fd).map_err(errno_from_rustix)) {
                        Ok(()) => 0,
                        Err(errno) => -errno,
                    }
                },
            )?;
        }
        // host_fchmod(handle, mode) -> i32 and host_fchown(handle, uid, gid)
        // -> i32: the handle forms of chmod/chown, answered from the open
        // object rather than by naming it again.
        {
            let fs = fs.clone();
            linker.func_wrap(
                "env",
                "host_fchmod",
                move |_c: Caller<'_, ()>, handle: i64, mode: i32| -> i32 {
                    // `RawMode` is `u16` on macOS and `u32` on Linux, so the
                    // cast has to name the platform's own width.
                    let mode = rustix::fs::Mode::from_bits_truncate(
                        (mode as u32 & 0o7777) as rustix::fs::RawMode,
                    );
                    match fs.with_fd(handle, |fd| {
                        rustix::fs::fchmod(fd, mode).map_err(errno_from_rustix)
                    }) {
                        Ok(()) => 0,
                        Err(errno) => -errno,
                    }
                },
            )?;
        }
        {
            let fs = fs.clone();
            linker.func_wrap(
                "env",
                "host_fchown",
                move |_c: Caller<'_, ()>, handle: i64, uid: i32, gid: i32| -> i32 {
                    let (owner, group) = owner_group(uid as u32, gid as u32);
                    match fs.with_fd(handle, |fd| {
                        rustix::fs::fchown(fd, owner, group).map_err(errno_from_rustix)
                    }) {
                        Ok(()) => 0,
                        Err(errno) => -errno,
                    }
                },
            )?;
        }
        // host_mkdirat(dir, name_ptr, name_len, mode) -> i32.
        {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                "host_mkdirat",
                move |_c: Caller<'_, ()>, dir: i64, name_ptr: i32, name_len: i32, mode: i32| -> i32 {
                    let name = match unsafe { read_component(&mem, name_ptr, name_len) } {
                        Ok(name) => name,
                        Err(errno) => return -errno,
                    };
                    let mut builder = CapDirBuilder::new();
                    builder.mode(mode as u32 & 0o7777);
                    match fs.with_dir(dir, |dh| {
                        dh.dir
                            .create_dir_with(&name, &builder)
                            .map_err(|e| errno_from_io(&e))
                    }) {
                        Ok(()) => 0,
                        Err(errno) => -errno,
                    }
                },
            )?;
        }
        // host_unlinkat(dir, name_ptr, name_len, flags) -> i32. `AT_REMOVEDIR`
        // selects `rmdir(2)`; POSIX defines the same operation for both,
        // distinguished by that flag, so there is no separate rmdir import.
        {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                "host_unlinkat",
                move |_c: Caller<'_, ()>, dir: i64, name_ptr: i32, name_len: i32, flags: i32| -> i32 {
                    let name = match unsafe { read_component(&mem, name_ptr, name_len) } {
                        Ok(name) => name,
                        Err(errno) => return -errno,
                    };
                    let remove_dir = flags as u32 & open_flags::AT_REMOVEDIR != 0;
                    match fs.with_dir(dir, |dh| {
                        let result = if remove_dir {
                            dh.dir.remove_dir(&name)
                        } else {
                            // `remove_file` is `unlinkat` without
                            // `AT_REMOVEDIR`, so it removes a symlink itself
                            // rather than what the symlink points at.
                            dh.dir.remove_file(&name)
                        };
                        result.map_err(|e| errno_from_io(&e))
                    }) {
                        Ok(()) => 0,
                        Err(errno) => -errno,
                    }
                },
            )?;
        }
        // host_renameat(old_dir, old_ptr, old_len, new_dir, new_ptr, new_len)
        // -> i32. Both entries are named in ONE host call so the host
        // filesystem's atomicity survives; two operations would not be a
        // rename.
        {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                "host_renameat",
                move |_c: Caller<'_, ()>,
                      old_dir: i64,
                      old_ptr: i32,
                      old_len: i32,
                      new_dir: i64,
                      new_ptr: i32,
                      new_len: i32|
                      -> i32 {
                    let (old_name, new_name) = match unsafe {
                        read_two_components(&mem, old_ptr, old_len, new_ptr, new_len)
                    } {
                        Ok(names) => names,
                        Err(errno) => return -errno,
                    };
                    match fs.with_two_dirs(old_dir, new_dir, |from, to| {
                        from.rename(&old_name, to, &new_name)
                            .map_err(|e| errno_from_io(&e))
                    }) {
                        Ok(()) => 0,
                        Err(errno) => -errno,
                    }
                },
            )?;
        }
        // host_linkat(old_dir, old_ptr, old_len, new_dir, new_ptr, new_len,
        // flags) -> i32. `flags` is always 0 from the kernel: it resolved the
        // existing path itself, so `AT_SYMLINK_FOLLOW` has already been applied
        // or withheld before this call. Any other value is a contract
        // violation, and `EINVAL` says so rather than silently ignoring it.
        {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                "host_linkat",
                move |_c: Caller<'_, ()>,
                      old_dir: i64,
                      old_ptr: i32,
                      old_len: i32,
                      new_dir: i64,
                      new_ptr: i32,
                      new_len: i32,
                      flags: i32|
                      -> i32 {
                    if flags != 0 {
                        return -libc_errno::EINVAL;
                    }
                    let (old_name, new_name) = match unsafe {
                        read_two_components(&mem, old_ptr, old_len, new_ptr, new_len)
                    } {
                        Ok(names) => names,
                        Err(errno) => return -errno,
                    };
                    match fs.with_two_dirs(old_dir, new_dir, |from, to| {
                        from.hard_link(&old_name, to, &new_name)
                            .map_err(|e| errno_from_io(&e))
                    }) {
                        Ok(()) => 0,
                        Err(errno) => -errno,
                    }
                },
            )?;
        }
        // host_symlinkat(target_ptr, target_len, dir, name_ptr, name_len)
        // -> i32. `target` is OPAQUE data stored verbatim — it may be absolute,
        // it may contain `/`, and this host never resolves it, which is why it
        // goes through `symlink_contents` rather than cap-std's `symlink` (the
        // latter refuses an absolute target). Only `name` names an entry to
        // create, and only `name` is a single component.
        {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                "host_symlinkat",
                move |_c: Caller<'_, ()>,
                      target_ptr: i32,
                      target_len: i32,
                      dir: i64,
                      name_ptr: i32,
                      name_len: i32|
                      -> i32 {
                    if target_len <= 0 {
                        return -libc_errno::EINVAL;
                    }
                    let target =
                        unsafe { read_bytes(&mem, target_ptr as u32 as usize, target_len as usize) };
                    if target.contains(&0) {
                        return -libc_errno::EINVAL;
                    }
                    let name = match unsafe { read_component(&mem, name_ptr, name_len) } {
                        Ok(name) => name,
                        Err(errno) => return -errno,
                    };
                    let target = OsStr::from_bytes(&target);
                    match fs.with_dir(dir, |dh| {
                        dh.dir
                            .symlink_contents(target, &name)
                            .map_err(|e| errno_from_io(&e))
                    }) {
                        Ok(()) => 0,
                        Err(errno) => -errno,
                    }
                },
            )?;
        }
        // host_readlinkat(dir, name_ptr, name_len, buf_ptr, buf_len) -> i32:
        // the raw symlink target, neither translated nor re-rooted, truncated
        // to `buf_len`. `read_link_contents` is the un-sanitized read that
        // matches this: cap-std's `read_link` would reject an absolute target,
        // but the kernel resolves targets itself and needs the bytes as stored.
        {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                "host_readlinkat",
                move |_c: Caller<'_, ()>,
                      dir: i64,
                      name_ptr: i32,
                      name_len: i32,
                      buf_ptr: i32,
                      buf_len: i32|
                      -> i32 {
                    if buf_len < 0 {
                        return -libc_errno::EINVAL;
                    }
                    let name = match unsafe { read_component(&mem, name_ptr, name_len) } {
                        Ok(name) => name,
                        Err(errno) => return -errno,
                    };
                    match fs.with_dir(dir, |dh| {
                        dh.dir
                            .read_link_contents(&name)
                            .map_err(|e| errno_from_io(&e))
                    }) {
                        Ok(target) => {
                            let bytes = target.into_os_string().into_encoded_bytes();
                            let n = bytes.len().min(buf_len as usize);
                            match write_lent(
                                &mem,
                                buf_ptr as u32 as u64,
                                buf_len as u32,
                                &bytes[..n],
                            ) {
                                Ok(()) => n as i32,
                                Err(errno) => errno,
                            }
                        }
                        Err(errno) => -errno,
                    }
                },
            )?;
        }
        // host_fchmodat(dir, name_ptr, name_len, mode) -> i32.
        //
        // Not reducible to open-then-fchmod: `open(O_RDONLY)` fails `EACCES` on
        // a file the caller owns but cannot read — which `chmod(2)` must still
        // permit — and blocks indefinitely on a FIFO with no writer.
        {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                "host_fchmodat",
                move |_c: Caller<'_, ()>, dir: i64, name_ptr: i32, name_len: i32, mode: i32| -> i32 {
                    let name = match unsafe { read_component(&mem, name_ptr, name_len) } {
                        Ok(name) => name,
                        Err(errno) => return -errno,
                    };
                    let perms = CapPermissions::from_mode(mode as u32 & 0o7777);
                    match fs.with_dir(dir, |dh| {
                        dh.dir
                            .set_permissions(&name, perms)
                            .map_err(|e| errno_from_io(&e))
                    }) {
                        Ok(()) => 0,
                        Err(errno) => -errno,
                    }
                },
            )?;
        }
        // host_fchownat(dir, name_ptr, name_len, uid, gid, flags) -> i32.
        // `AT_SYMLINK_NOFOLLOW` gives `lchown(2)`, which is why the handle form
        // `host_fchown` does not cover this family: a symlink cannot be opened
        // without following it, so changing a symlink's own ownership requires
        // naming it. cap-std models no ownership operation, so this is
        // `rustix`'s `chownat` on the `Dir`'s own descriptor — still one
        // component, still relative to a capability that cannot be escaped.
        {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                "host_fchownat",
                move |_c: Caller<'_, ()>,
                      dir: i64,
                      name_ptr: i32,
                      name_len: i32,
                      uid: i32,
                      gid: i32,
                      flags: i32|
                      -> i32 {
                    let name = match unsafe { read_component(&mem, name_ptr, name_len) } {
                        Ok(name) => name,
                        Err(errno) => return -errno,
                    };
                    let (owner, group) = owner_group(uid as u32, gid as u32);
                    let at_flags = if flags as u32 & open_flags::AT_SYMLINK_NOFOLLOW != 0 {
                        rustix::fs::AtFlags::SYMLINK_NOFOLLOW
                    } else {
                        rustix::fs::AtFlags::empty()
                    };
                    match fs.with_dir(dir, |dh| {
                        rustix::fs::chownat(&dh.dir, name.as_os_str(), owner, group, at_flags)
                            .map_err(errno_from_rustix)
                    }) {
                        Ok(()) => 0,
                        Err(errno) => -errno,
                    }
                },
            )?;
        }
        // host_utimensat(dir, name_ptr, name_len, atime_sec, atime_nsec,
        // mtime_sec, mtime_nsec, flags) -> i32.
        //
        // The kernel sends LINUX's `UTIME_NOW`/`UTIME_OMIT` sentinels in the
        // nanosecond fields. They are NOT the values this host's platform uses
        // (macOS spells them -1 and -2), so they are decoded here into cap-std's
        // symbolic vocabulary — `SystemTimeSpec::SymbolicNow`, and a `None` that
        // means "leave this timestamp alone" — and cap-std re-spells them for
        // whichever platform is running. Passing the raw Linux numbers through
        // would silently stamp a timestamp in the year 2004 on macOS.
        {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                "host_utimensat",
                move |_c: Caller<'_, ()>,
                      dir: i64,
                      name_ptr: i32,
                      name_len: i32,
                      atime_sec: i64,
                      atime_nsec: i64,
                      mtime_sec: i64,
                      mtime_nsec: i64,
                      flags: i32|
                      -> i32 {
                    let name = match unsafe { read_component(&mem, name_ptr, name_len) } {
                        Ok(name) => name,
                        Err(errno) => return -errno,
                    };
                    let atime = match utimens_spec(atime_sec, atime_nsec) {
                        Ok(spec) => spec,
                        Err(errno) => return -errno,
                    };
                    let mtime = match utimens_spec(mtime_sec, mtime_nsec) {
                        Ok(spec) => spec,
                        Err(errno) => return -errno,
                    };
                    let nofollow = flags as u32 & open_flags::AT_SYMLINK_NOFOLLOW != 0;
                    match fs.with_dir(dir, |dh| {
                        let result = if nofollow {
                            dh.dir.set_symlink_times(&name, atime, mtime)
                        } else {
                            dh.dir.set_times(&name, atime, mtime)
                        };
                        result.map_err(|e| errno_from_io(&e))
                    }) {
                        Ok(()) => 0,
                        Err(errno) => -errno,
                    }
                },
            )?;
        }
        // host_fstatfs(handle, statfs_ptr) -> i32: filesystem statistics for an
        // open host object, file or directory.
        //
        // `fstatvfs` rather than `fstatfs`: the POSIX form has the same field
        // names on every platform this host builds for, while `struct statfs`
        // is a different struct on macOS than on Linux. `f_type` stays 0
        // because `statvfs` carries no filesystem-type magic — a truthful
        // "unknown", not a fabricated one.
        {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                "host_fstatfs",
                move |_c: Caller<'_, ()>, handle: i64, statfs_ptr: i32| -> i32 {
                    match fs
                        .with_fd(handle, |fd| rustix::fs::fstatvfs(fd).map_err(errno_from_rustix))
                    {
                        Ok(vfs) => {
                            let Some(dest) = KernelLent::prove(
                                &mem,
                                statfs_ptr as u32 as u64,
                                WASM_STATFS_SIZE as u32,
                            ) else {
                                return -libc_errno::EFAULT;
                            };
                            match write_wasm_statfs(&mem, dest, &vfs) {
                                Ok(()) => 0,
                                Err(errno) => errno,
                            }
                        }
                        Err(errno) => -errno,
                    }
                },
            )?;
        }
        // host_fpathconf(handle, name, value_ptr) -> i32: one `pathconf(3)`
        // limit for the filesystem an open host object lives on.
        //
        // `name` is the ABI's own small enumeration (`wasm_posix_shared::
        // pathconf`), NOT a `_PC_*` number, and `_PC_*` numbering differs
        // between Linux and macOS — so it is translated by name, exactly as
        // `errno_from_io` translates errno. A limit this platform has no
        // `_PC_*` constant for, and a limit the platform itself reports as
        // indeterminate, both write -1, which is how the kernel's
        // `host_fpathconf` decoder spells `None` ("no limit / indeterminate").
        {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                "host_fpathconf",
                move |_c: Caller<'_, ()>, handle: i64, name: i32, value_ptr: i32| -> i32 {
                    let result = fs.with_fd(handle, |fd| {
                        let Some(native_name) = native_pathconf_name(name) else {
                            return Ok(-1i64);
                        };
                        fpathconf_value(fd, native_name)
                    });
                    match result {
                        Ok(value) => {
                            if let Err(errno) = write_lent(
                                &mem,
                                value_ptr as u32 as u64,
                                8,
                                &value.to_le_bytes(),
                            ) {
                                return errno;
                            }
                            0
                        }
                        Err(errno) => -errno,
                    }
                },
            )?;
        }
        // host_readdir(dir_handle, dirent_ptr, name_ptr, name_len) -> i32:
        // writes one `WasmDirent` (16 bytes: d_ino u64 @0, d_type u32 @8,
        // d_namlen u32 @12 — see crates/shared `WasmDirent`) plus the raw entry
        // name. Returns 1 (entry written), 0 (end of directory), or a negated
        // errno.
        //
        // CONSUME EXACTLY ONCE. A name that does not fit `name_len` fails
        // ERANGE and the entry stays parked in `DirHandle::pending`, so the
        // kernel's retry — a normal outcome, since `getdents64` may return a
        // short but successful result after copying earlier records — sees the
        // SAME entry again. The pre-K9 `host_opendir`/`std::fs::ReadDir`
        // implementation could not do this (no peek, no pushback) and silently
        // dropped an oversized entry from the listing; this one-entry lookahead
        // is what closes that divergence from the Node host.
        {
            let fs = fs.clone();
            let mem = kernel_mem.clone();
            linker.func_wrap(
                "env",
                "host_readdir",
                move |_c: Caller<'_, ()>,
                      dir_handle: i64,
                      dirent_ptr: i32,
                      name_ptr: i32,
                      name_len: i32|
                      -> i32 {
                    if name_len < 0 {
                        return -libc_errno::EINVAL;
                    }
                    let entry = fs.with_dir(dir_handle, |dh| {
                        if dh.pending.is_none() {
                            if dh.entries.is_none() {
                                dh.entries = Some(dh.dir.entries().map_err(|e| errno_from_io(&e))?);
                            }
                            let next = dh.entries.as_mut().expect("entries created above").next();
                            match next {
                                None => return Ok(None),
                                Some(Err(e)) => return Err(errno_from_io(&e)),
                                Some(Ok(entry)) => {
                                    // ONE `lstat` answers both fields.
                                    // `DirEntry::metadata` does not traverse a
                                    // symlink, which is what `d_type` must
                                    // describe (`DT_LNK`, not the target's
                                    // type). If it fails — the entry can be
                                    // unlinked between being listed and being
                                    // stat'd — fall back to the type alone
                                    // with a zero inode rather than aborting a
                                    // listing that is otherwise fine.
                                    let (ino, d_type) = match entry.metadata() {
                                        Ok(m) => (m.ino(), dirent_type(&m.file_type())),
                                        Err(_) => (
                                            0,
                                            entry
                                                .file_type()
                                                .map(|ft| dirent_type(&ft))
                                                .unwrap_or(DT_UNKNOWN),
                                        ),
                                    };
                                    dh.pending = Some(PendingEntry {
                                        ino,
                                        d_type,
                                        name: entry.file_name().into_encoded_bytes(),
                                    });
                                }
                            }
                        }
                        let pending = dh.pending.as_ref().expect("pending filled above");
                        if pending.name.len() > name_len as usize {
                            // Leave `pending` in place: the kernel will retry.
                            return Err(libc_errno::ERANGE);
                        }
                        Ok(dh.pending.take())
                    });
                    match entry {
                        Ok(None) => 0, // end of directory
                        Ok(Some(entry)) => {
                            // Two lends, because the kernel names two buffers:
                            // a 16-byte dirent record and a separate name
                            // buffer whose capacity it already told us
                            // (`name_len`, checked above for the CONTENT but
                            // never for the ADDRESS until now).
                            let mut record = [0u8; WASM_DIRENT_SIZE];
                            record[..8].copy_from_slice(&entry.ino.to_le_bytes());
                            record[8..12].copy_from_slice(&entry.d_type.to_le_bytes());
                            record[12..].copy_from_slice(
                                &(entry.name.len() as u32).to_le_bytes(),
                            );
                            if let Err(errno) =
                                write_lent(
                                    &mem,
                                    dirent_ptr as u32 as u64,
                                    WASM_DIRENT_SIZE as u32,
                                    &record,
                                )
                            {
                                return errno;
                            }
                            match write_lent(
                                &mem,
                                name_ptr as u32 as u64,
                                name_len as u32,
                                &entry.name,
                            ) {
                                Ok(()) => 1,
                                Err(errno) => errno,
                            }
                        }
                        Err(errno) => -errno,
                    }
                },
            )?;
        }
    }
    // host_fetch_deferred(uri_ptr, uri_len, buf_ptr, buf_len, offset_lo,
    // offset_hi) -> i32: a positioned read of a resource the `/` image does not
    // carry, named by the URI the image recorded. `offset` is a 64-bit value
    // split into lo/hi 32-bit words for the (JS-shaped) ABI, matching
    // `host_pread`'s convention — mirrors `wasm_api.rs`'s declaration exactly.
    //
    // The `kind` discriminator and the id are gone. They existed because the
    // kernel addressed a resource by a number from one of two namespaces, and
    // a host could only resolve that by keeping its own table mapping numbers
    // back to addresses — a second author for where a file's bytes live, with
    // the image as the first. A URI is a complete address, so the table has
    // nothing to hold and a base file's blob and a lazy archive's raw bytes
    // stop being different requests.
    //
    // This host answers ENOENT at every address, and that is the whole truthful
    // implementation rather than a stub standing in for one. `build_base_image`
    // writes every file RESIDENT into the container, so nothing in an image this
    // host builds is deferred and no correct kernel ever asks. The import still
    // has to exist — `wasm_api.rs` declares it, and an undeclared import fails
    // instantiation — so a kernel that asks anyway gets a loud, specific refusal
    // at the boundary instead of bytes this host was never given. Deferred
    // fetching is exercised where a host really serves it:
    // `host/test/sdef-image-runtime.test.ts`, over loopback HTTP.
    {
        let mem = kernel_mem.clone();
        linker.func_wrap(
            "env",
            "host_fetch_deferred",
            move |_c: Caller<'_, ()>,
                  uri_ptr: i32,
                  uri_len: i32,
                  buf_ptr: i32,
                  buf_len: i32,
                  _offset_lo: u32,
                  _offset_hi: u32|
                  -> i32 {
                if buf_len < 0 || uri_len < 0 {
                    return -libc_errno::EINVAL;
                }
                // Read the address before refusing it. An import that rejects
                // without looking cannot report WHICH address went unserved,
                // and that is the one fact a failure here needs to carry.
                let uri = unsafe { read_bytes(&mem, uri_ptr as u32 as usize, uri_len as usize) };
                let _ = (&uri, buf_ptr);
                eprintln!(
                    "[host-native] host_fetch_deferred({}) — this host builds \
                     fully-resident images and serves no deferred bytes",
                    String::from_utf8_lossy(&uri),
                );
                -libc_errno::ENOENT
            },
        )?;
    }
    {
        // `host_image_read(buf_ptr, buf_len, offset_lo, offset_hi) -> i32`: a
        // positioned window onto the ONE container this kernel booted from, so
        // it can parse its own image instead of consuming a tree the host
        // walked and re-encoded. Returns bytes written (0 at end of image), or
        // a negated errno.
        let mem = kernel_mem.clone();
        let image = base_image_bytes.clone();
        linker.func_wrap(
            "env",
            "host_image_read",
            move |_c: Caller<'_, ()>,
                  buf_ptr: i32,
                  buf_len: i32,
                  offset_lo: u32,
                  offset_hi: u32|
                  -> i32 {
                if buf_len < 0 {
                    return -libc_errno::EINVAL;
                }
                let offset = (((offset_hi as u64) << 32) | (offset_lo as u64)) as usize;
                if offset >= image.len() {
                    return 0; // end of image
                }
                let remaining = &image[offset..];
                let n = remaining.len().min(buf_len as usize);
                match write_lent(&mem, buf_ptr as u32 as u64, buf_len as u32, &remaining[..n]) {
                    Ok(()) => n as i32,
                    Err(errno) => errno,
                }
            },
        )?;
    }
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
                        match write_lent(&mem, buf_ptr as u32 as u64, len as u32, &buf) {
                            Ok(()) => len,
                            Err(errno) => errno,
                        }
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
                    // The reaping already happened above, so a bad status
                    // pointer cannot un-reap the child: report EFAULT and let
                    // the caller see the loss, rather than write through it.
                    if let Err(errno) = write_lent(
                        &kernel_mem,
                        status_ptr as u32 as u64,
                        4,
                        &status_word.to_le_bytes(),
                    ) {
                        return errno;
                    }
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
fn compute_guest_memory(
    engine: &Engine,
    guest_module: &Module,
    guest_bytes: &[u8],
) -> anyhow::Result<(SharedMemory, ProcessLayout)> {
    let imported_min_pages = guest_module
        .imports()
        .find_map(|i| match i.ty() {
            wasmtime::ExternType::Memory(m) if i.module() == "env" && i.name() == "memory" => {
                Some(m.minimum() as usize)
            }
            _ => None,
        })
        .ok_or_else(|| anyhow::anyhow!("guest does not import env.memory"))?;
    let layout = ProcessLayout::compute(imported_min_pages, guest_bytes)?;
    let memory =
        new_shared(engine, layout.initial_pages as u32, DEFAULT_MAX_PAGES as u32, layout.pointer_width)?;
    Ok((memory, layout))
}

// --- N1-I4 Task 1: the co-resident fork-module (PIC side module) -----------
//
// `crates/fork-module` is built (`crates/fork-module/build-wasm.sh`) as a
// POSITION-INDEPENDENT (`--pie`) wasm side module: it imports the guest's
// `env.memory` plus the placement globals `env.__memory_base` (immutable),
// `env.__stack_pointer` (mutable), and `env.__table_base` (immutable), and
// its data segments are PASSIVE, copied to `__memory_base + offset` by its
// own start function during instantiation. Placing its static data/BSS/
// shadow stack at a HOST-CHOSEN region — instead of the fixed low offsets a
// plain cdylib would use — is the gating fix: those offsets would otherwise
// collide with and corrupt live guest data. This mirrors the placement
// contract `host/src/fork-module-instance.ts:415-542` already uses on the
// browser/Node hosts; see that file's `instantiateForkModule` for the
// reference this section ports.
//
// This is FRAMES-ONLY (N1-I4 Task 1): it instantiates the module and binds
// its `fm_*` coordinator exports. No `SYS_FORK`/kernel wiring happens here
// (Task 2); no capture/replay is driven here (Task 3).
//
// Externref stage E2: the module no longer imports `env.resolve_externref`
// or `env.__wpk_fork_host_externref_handle`. A fork does not carry a raw host
// externref, so the module never has to name or rebuild one.
//
// H3 (host-surface minimization, 2026-09-06): the `wpk_fork_host.*` seam
// (`crate::fork_host_capabilities::NativeForkHostCapabilities`) this comment
// used to describe was deleted — it was never called from this path (or any
// other). The fork-module artifact no longer declares those imports, so
// there is nothing left for `define_unknown_imports_as_traps` to catch here.

/// Byte size of the fork-module's own shadow stack, appended above its
/// static/BSS footprint when reserving its host-owned region. Mirrors
/// `FORK_MODULE_SHADOW_STACK_BYTES` in `host/src/fork-module-instance.ts`
/// (kept local here, not in `wasm-posix-shared`, because it is a host-side
/// placement policy constant, not part of the wire ABI).
const FORK_MODULE_SHADOW_STACK_BYTES: usize = 1 << 20;

/// Byte size of the staging slab reserved above the fork-module's shadow
/// stack: ONE wasm page, as `STAGING_SLAB_BYTES` in
/// `host/src/fork-module-instance.ts`, whose doc comment has the measurement
/// behind it. An admission larger than this goes to a buffer the module maps
/// to its size (`fm_admission_buffer`); see [`admit_guest`].
const FORK_MODULE_STAGING_SLAB_BYTES: usize = WASM_PAGE_SIZE;

/// Define `env.native_test_host_externref(handle: i32) -> externref` — a
/// TEST-ONLY host import, never declared by a real program, that hands the
/// guest a genuine HOST object: a fresh `ExternRef` wrapping `handle` as its
/// Rust data. It is the plain local host import the externref fork fixtures
/// get their host object from, the native mate of the one the JS-host tests
/// supply (`host/test/fork-host-externref-refusal.test.ts`).
///
/// A fork that holds such a value is REFUSED with `EOPNOTSUPP` (externref
/// stage E2): the fork module has no way to name or rebuild a host object in a
/// fresh child, so this import keeps no registry and no provenance -- every
/// call mints a new object, and nothing on the fork path ever looks one up.
/// [`define_externref_payload_probe`] reads `handle` back so a fixture can
/// prove the PARENT kept the exact object across the refused fork.
///
/// Wired ONLY when a guest module actually declares it (the
/// `guest_declares(name)` gating every optional wire in `spawn_guest_thread`
/// uses), so it is a no-op for every other program.
fn define_host_externref_source(linker: &mut Linker<()>) -> anyhow::Result<()> {
    linker.func_wrap(
        "env",
        "native_test_host_externref",
        move |mut caller: Caller<'_, ()>, handle: i32| -> wasmtime::Result<Option<wasmtime::Rooted<ExternRef>>> {
            ExternRef::new(&mut caller, handle as u32).map(Some)
        },
    )?;
    Ok(())
}

/// N1-I5 Task 3: define `env.native_test_externref_payload(v: externref) ->
/// i32` — a TEST-ONLY diagnostic import, never declared by a real program,
/// that unwraps the `u32` payload [`define_host_externref_source`] wrapped an
/// externref around (via `ExternRef::new(&mut store, handle: u32)`). A fixture
/// cannot read or compare an opaque externref itself, so its only way to prove
/// "the object I hold after my fork was refused is the SAME one I held
/// before" is to hand it back to the host and let the host tell it. A null
/// externref reports `-1`, a truthful sentinel distinct from every valid
/// handle a fixture uses (all small positive constants) — never a silently
/// wrong `0`.
///
/// Wired ONLY when a guest module actually declares this import (mirrors the
/// `guest_declares(name)` gating every other optional reference wire in
/// `spawn_guest_thread`), so it is a no-op for every other program, including
/// every other pre-existing fixture.
fn define_externref_payload_probe(linker: &mut Linker<()>) -> anyhow::Result<()> {
    linker.func_wrap(
        "env",
        "native_test_externref_payload",
        move |caller: Caller<'_, ()>, v: Option<wasmtime::Rooted<ExternRef>>| -> wasmtime::Result<i32> {
            let Some(v) = v else {
                return Ok(-1);
            };
            match v.data(&caller)? {
                Some(data) => match data.downcast_ref::<u32>() {
                    Some(handle) => Ok(*handle as i32),
                    None => Ok(-1),
                },
                None => Ok(-1),
            }
        },
    )?;
    Ok(())
}

/// N1-I5b Task 1: define `env.native_test_funcref_call(f: funcref) -> i32` —
/// a TEST-ONLY diagnostic import, never declared by a real program, that
/// CALLS `f` (a niladic, `i32`-returning function — the only shape this
/// task's fixture needs) from HOST Rust and returns its result (`-1` for a
/// null funcref, never expected for a value this fixture's own capture/
/// replay path produces). This is the funcref analogue of
/// [`define_externref_payload_probe`]'s `native_test_externref_payload`, and
/// exists for the SAME reason: `native_fork_refs.wat`'s own doc comment
/// explains why a genuine funcref VALUE cannot be produced or manipulated
/// from portable C on this SDK's toolchain, so the WAT fixture needs some
/// host-provided way to prove "the reconstructed LOCAL, when called, returns
/// the sentinel's value" without a wasm-level call mechanism of its own.
/// Deliberately does NOT go through a wasm table/`call_indirect` — an
/// earlier version of this fixture wrote the local into a destination table
/// before calling it and tripped a SEPARATE, unrelated gap (`wasm-fork-
/// instrument` tracks every `table.set` anywhere in the module for
/// module-state/table-dirty-page capture, an out-of-scope-for-this-task
/// import family with no native host body yet — see this file's "N1-I5b
/// Task 1" section doc comment and `native_fork_refs.wat`'s HISTORY note).
/// Calling `f` directly, HOST-side, from the `Func` value the import
/// receives needs no table at all.
fn define_funcref_call_probe(linker: &mut Linker<()>) -> anyhow::Result<()> {
    linker.func_wrap(
        "env",
        "native_test_funcref_call",
        move |mut caller: Caller<'_, ()>, f: Option<wasmtime::Func>| -> wasmtime::Result<i32> {
            let Some(f) = f else {
                return Ok(-1);
            };
            let typed = f.typed::<(), i32>(&caller)?;
            typed.call(&mut caller, ())
        },
    )?;
    Ok(())
}

/// The `kandelo.wpk_fork.*` custom sections an activation admission carries:
/// section `i` is `fork_codec::AdmissionSectionKind` wire number `i + 1`. The
/// same list the Node/browser writer keeps (`FORK_ADMISSION_SECTIONS` in
/// `host/src/fork-guest-sections.ts`).
const FORK_ADMISSION_SECTIONS: [&str; 7] = [
    wasm_posix_shared::abi::WPK_FORK_LINKED_FRAME_FORMAT_SECTION,
    wasm_posix_shared::abi::WPK_FORK_MODULE_STATE_FORMAT_SECTION,
    "kandelo.wpk_fork.resume_catalog",
    wasm_posix_shared::abi::WPK_FORK_GC_CODEC_SECTION,
    wasm_posix_shared::abi::WPK_FORK_EXCEPTION_CODEC_SECTION,
    wasm_posix_shared::abi::WPK_FORK_IMPORTED_GLOBALS_SECTION,
    wasm_posix_shared::abi::WPK_FORK_IMPORTED_TABLES_SECTION,
];

/// Every custom section of a wasm module, located by `wasmparser`.
/// `wasmtime::Module` has no custom-section accessor, so the host walks the
/// raw bytes -- LOCATING sections only; what is in them is the reader's job.
fn custom_sections(wasm_bytes: &[u8]) -> impl Iterator<Item = anyhow::Result<wasmparser::CustomSectionReader<'_>>> {
    wasmparser::Parser::new(0).parse_all(wasm_bytes).filter_map(|payload| match payload {
        Ok(wasmparser::Payload::CustomSection(section)) => Some(Ok(section)),
        Ok(_) => None,
        Err(e) => Some(Err(e.into())),
    })
}

/// What this host knows about one fork-instrumented guest program, computed
/// once from its raw bytes (the only point they are in hand) and shared by
/// every launch of that program through an `Arc`: its template id and its
/// `kandelo.wpk_fork.*` custom sections, located and copied VERBATIM.
///
/// The host decodes none of those sections. It stages them in one `KFAA`
/// admission descriptor ([`GuestForkFormat::admission`]) and the co-resident
/// fork module decodes and validates every one in `fm_admit_activation` --
/// the same entry, and the same descriptor, the Node/browser host uses. This
/// host used to carry its own readers of the linked-frame, resume-catalog and
/// GC-codec sections and seed each fact through its own `fm_*` call, and it
/// never seeded the exception codec or the host-exception owner at all.
#[derive(Debug, Clone)]
pub(crate) struct GuestForkFormat {
    /// This guest's fork TEMPLATE ID: a plain SHA-256 over its module bytes,
    /// which only the host holds. Matches `computeForkModuleTemplateId` in
    /// `host/src/fork-guest-sections.ts` byte for byte, so a native parent and
    /// a JavaScript child agree about which module an activation is.
    pub template_id: [u8; 32],
    /// `(AdmissionSectionKind wire number, section bytes)`, in file order.
    pub sections: Vec<(u32, Vec<u8>)>,
}

impl GuestForkFormat {
    /// One located section's bytes, or `None` when the guest has none.
    fn section(&self, kind: fork_codec::AdmissionSectionKind) -> Option<&[u8]> {
        self.sections.iter().find(|(k, _)| *k == kind as u32).map(|(_, bytes)| bytes.as_slice())
    }

    /// Activation `activation_id`'s `KFAA` admission descriptor, with this
    /// worker's fork-child `flags`.
    fn admission(&self, activation_id: u32, flags: u32) -> Vec<u8> {
        let sections: Vec<(u32, &[u8])> = self.sections.iter().map(|(k, b)| (*k, b.as_slice())).collect();
        fork_codec::encode_activation_admission(activation_id, flags, &self.template_id, &sections)
    }
}

/// How a fresh guest OS thread should enter its program (N1-I4 Task 3).
/// Replaces the old `fork_child_pending_replay: bool` — a legacy fork child
/// could only ever be stubbed (never actually run its program; see the
/// `ChildPendingStub` variant's doc comment for why that path is kept, not
/// deleted). A REAL fork child (the common case once a guest is
/// fork-instrumented) drives `ChildReplay` instead.
#[derive(Clone, Copy)]
enum ForkEntry {
    /// The ordinary case: call `_start` from the top. Used for the boot
    /// process, every `posix_spawn`ed child, every `execve`d image, and —
    /// when the PARENT'S OWN program is not fork-instrumented — even a fork
    /// child (see `ChildPendingStub`).
    Normal,
    /// N1-I4 Task 2's legacy stub, preserved for a `use_fork_module` fork of
    /// a NON-instrumented guest (`GuestProcess::fork_format == None`): no
    /// coordinator exists to drive a real replay for such a guest (it was
    /// never `wasm-fork-instrument`ed, so it has no `wpk_fork_*` exports to
    /// call), so this never executes a single instruction of the child's
    /// copied program and instead posts an immediate synthetic
    /// `SYS_EXIT_GROUP(0)` — see [`post_fork_child_pending_exit`]. No test
    /// exercises this today (the one `use_fork_module` test now uses an
    /// instrumented fixture, per N1-I4 Task 3), but `handle_fork` cannot
    /// assume every `use_fork_module` guest is instrumented, so this
    /// fallback stays.
    ChildPendingStub,
    /// N1-I4 Task 3: a REAL fork child. `root` is its launch root: the
    /// parent's activation-0 continuation anchor, which the parent published
    /// in its fork control word and `handle_fork` read back (the Node/browser
    /// `forkBufAddr`). The child installs through `fm_child_install(pid, root)`
    /// and then enters `wpk_fork_resume_start()` -- see
    /// `run_fork_capable_entry`.
    ChildReplay { root: u32 },
    /// Real vfork (N1 residual): a BORROWED child sharing the parked parent's
    /// `SharedMemory` -- the borrowed sibling of `ChildReplay`. `root` is the
    /// parent's live launch root (read, never copied); `private_prefix` is the
    /// child-private workspace `fm_child_install` carves its fixed runtime
    /// prefix from, so the guest's active-frame-pointer rewrites never touch
    /// the parked parent's; `owner_control` is the PARENT's fork control word,
    /// which a borrowed child's module uses as its own (as `forkOwnerControlAddr`
    /// does on the JavaScript hosts) and never writes.
    ChildBorrowedReplay { root: u32, private_prefix: u32, owner_control: u32 },
}

/// `kernel_fork`'s two reachable phases on a native guest thread (N1-I4 Task
/// 3). `Idle` covers BOTH "no fork has happened yet" and "the process has
/// returned to normal execution after a previous fork's replay finished" —
/// the entry loop resets this back to `Idle` once `fm_finish_replay`
/// succeeds (see `drive_fork_capture_seal_and_launch_child`'s tail and
/// `kernel_fork`'s `Replaying` arm), so a SECOND, later `fork()` call is
/// captured exactly like the first. `Replaying` covers both PARENT replay
/// (after `fm_begin_replay`) and CHILD replay (after `fm_begin_child_
/// replay`) — the closure's own behavior at this phase (`wpk_fork_rewind_
/// end` + `fm_finish_replay` + return `fork_result`) is identical either
/// way; only the entry loop's choice of which `fm_begin_*` call preceded it
/// differs.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ForkCoordPhase {
    Idle,
    Replaying,
}

/// N1-I4 Task 3: mutable state shared, via `Arc`, between a guest OS thread's
/// entry-driving loop ([`run_fork_capable_entry`]) and its `kernel_fork`
/// import closure. Both run on the SAME OS thread in practice (a guest never
/// forks from a worker thread — see `kernel_fork`'s own doc comment), so
/// nothing here is ever actually contended — but `Linker::func_wrap`'s
/// `IntoFunc` bound requires every captured value to be `Send + Sync`
/// regardless (Wasmtime's `Store`/`Func` types are usable from any thread
/// the embedder chooses, even though this host only ever calls this one
/// from its own guest thread), so this uses `Arc<Atomic*>` — the same
/// cross-thread-safe-by-construction shape `import_exit_status: Arc<Mutex<
/// Option<i32>>>` already uses elsewhere in this file — rather than a
/// simpler but non-`Send` `Rc<Cell<_>>`. `kernel_fork` is called TWICE per
/// fork: once at `Idle` (starts capture, never blocks on the channel itself
/// — see that branch), and once at `Replaying` (re-entered from within the
/// resumed frame chain the guest's OWN resume-table dispatch walks back to)
/// to learn the ACTUAL `fork()` return value now that the child's pid (or
/// `0`, for the child itself) is known.
struct ForkCoordState {
    phase: AtomicU32,
    /// The value `kernel_fork` returns while `phase == Replaying`: the
    /// child's pid (parent) or `0` (child), or a negative errno if capture
    /// or child-creation failed. Stored as the bit pattern of an `i32`.
    fork_result: AtomicU32,
    /// The `mode` argument (`fork()` vs `vfork()`) `kernel_fork`'s `Idle`
    /// branch recorded, needed by the entry loop to choose `SYS_FORK` vs
    /// `SYS_VFORK` when it finally posts the real channel request (AFTER
    /// capture completes — see `drive_fork_capture_seal_and_launch_child`).
    mode: AtomicU32,
    /// Whether the PARENT's pending replay is an ABORT-replay (`1`) rather than
    /// a NORMAL rewind-replay (`0`). Set when the entry loop drives the parent
    /// through `fm_parent_replay(abort=1)` — an unsupported-reference (gated) fork or a
    /// failed child launch, mirroring TS `beginAbortReplay` — so the
    /// `Replaying`-phase finish drives `fm_parent_finish(1)` (the guest's
    /// `wpk_fork_abort_end` flip) instead of `fm_parent_finish(0)`
    /// (`wpk_fork_rewind_end`). Reset to `0` at the start of every capture and
    /// after each finish. Stored as a `u32` (0/1) to match the other fields.
    abort_replay: AtomicU32,
}

const FORK_COORD_PHASE_IDLE: u32 = 0;
const FORK_COORD_PHASE_REPLAYING: u32 = 1;

impl ForkCoordState {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            phase: AtomicU32::new(FORK_COORD_PHASE_IDLE),
            fork_result: AtomicU32::new(0),
            mode: AtomicU32::new(0),
            abort_replay: AtomicU32::new(0),
        })
    }

    fn phase(&self) -> ForkCoordPhase {
        match self.phase.load(Ordering::SeqCst) {
            FORK_COORD_PHASE_REPLAYING => ForkCoordPhase::Replaying,
            _ => ForkCoordPhase::Idle,
        }
    }

    fn set_phase(&self, phase: ForkCoordPhase) {
        let raw = match phase {
            ForkCoordPhase::Idle => FORK_COORD_PHASE_IDLE,
            ForkCoordPhase::Replaying => FORK_COORD_PHASE_REPLAYING,
        };
        self.phase.store(raw, Ordering::SeqCst);
    }

    fn fork_result(&self) -> i32 {
        self.fork_result.load(Ordering::SeqCst) as i32
    }

    fn set_fork_result(&self, value: i32) {
        self.fork_result.store(value as u32, Ordering::SeqCst);
    }

    fn mode(&self) -> u32 {
        self.mode.load(Ordering::SeqCst)
    }

    fn set_mode(&self, value: u32) {
        self.mode.store(value, Ordering::SeqCst);
    }

    fn is_abort_replay(&self) -> bool {
        self.abort_replay.load(Ordering::SeqCst) != 0
    }

    fn set_abort_replay(&self, value: bool) {
        self.abort_replay.store(u32::from(value), Ordering::SeqCst);
    }
}

/// Compute [`GuestForkFormat`] from a guest program's raw wasm bytes, or
/// `Ok(None)` if the guest carries no `kandelo.wpk_fork.linked_frames`
/// section at all (an ordinary, non-fork-instrumented program -- the common
/// case). Called once at every site that compiles a fresh guest `Module`
/// from raw bytes ([`run_guest`]'s boot module, `handle_spawn`'s child,
/// `handle_exec_common`'s new image); a fork child reuses its parent's value.
///
/// The admission is checked here too, by `fork_codec::admit_activation` --
/// the decoder `fm_admit_activation` runs, not a host copy of it -- because
/// an exec has a point of no return before the new image's worker admits:
/// a malformed section refuses the exec with `ENOEXEC` rather than killing
/// the process after it has committed.
pub(crate) fn compute_guest_fork_format(wasm_bytes: &[u8]) -> anyhow::Result<Option<GuestForkFormat>> {
    let mut sections = Vec::new();
    for section in custom_sections(wasm_bytes) {
        let section = section?;
        if let Some(i) = FORK_ADMISSION_SECTIONS.iter().position(|name| *name == section.name()) {
            sections.push((i as u32 + 1, section.data().to_vec()));
        }
    }
    let format = GuestForkFormat { template_id: <sha2::Sha256 as sha2::Digest>::digest(wasm_bytes).into(), sections };
    if format.section(fork_codec::AdmissionSectionKind::LinkedFrames).is_none() {
        return Ok(None);
    }
    fork_codec::admit_activation(&format.admission(0, 0), Some(4))
        .map_err(|rejection| anyhow::anyhow!("fork admission refused: {}", rejection.reason()))?;
    Ok(Some(format))
}

/// Read the fork-module's `dylink.0` custom section's `mem_info` subsection
/// straight out of its raw wasm bytes: `(memory_size, memory_align_bytes)`.
/// Mirrors `readForkModuleMemInfo` in `host/src/fork-module-instance.ts` --
/// the module is a PIC side module (see this section's module doc comment),
/// so its own static/BSS footprint is not baked into fixed linear-memory
/// offsets; the host must read this section to know how large a region to
/// reserve before choosing `__memory_base`.
fn read_fork_module_mem_info(wasm_bytes: &[u8]) -> anyhow::Result<(usize, usize)> {
    for section in custom_sections(wasm_bytes) {
        let wasmparser::KnownCustom::Dylink0(reader) = section?.as_known() else { continue };
        for subsection in reader {
            if let wasmparser::Dylink0Subsection::MemInfo(info) = subsection? {
                return Ok((info.memory_size as usize, 1usize << info.memory_alignment));
            }
        }
        anyhow::bail!("fork-module dylink.0 has no mem_info subsection");
    }
    anyhow::bail!("fork-module is not a PIC side module (no dylink.0 custom section)");
}

/// Field indices for `fm_stats(field) -> i64`, the single folded proof-of-use
/// counter accessor (replacing the former 11 individual `fm_*` counter
/// exports). These MUST match `fm_stats`'s match arms in
/// `crates/fork-module/src/lib.rs` and `FmStatField` in
/// `host/src/fork-module-backend.ts`; all three ship in lockstep.
pub const FM_STAT_FRAMES_COMMITTED: u32 = 0;
pub const FM_STAT_FRAMES_REPLAYED: u32 = 1;
pub const FM_STAT_REFERENCES_RECONSTRUCTED: u32 = 2;
// Field 3 is retired (it counted host externrefs a fork reconstructed; since
// externref stage E2 a fork carries none), so it has no constant here.
pub const FM_STAT_EXNREFS_RECONSTRUCTED: u32 = 4;
pub const FM_STAT_GC_NODES_RECONSTRUCTED: u32 = 5;
pub const FM_STAT_STATIC_ROOTS_PUBLISHED: u32 = 6;
pub const FM_STAT_DRIVE_STEPS_EXECUTED: u32 = 7;

/// The co-resident fork-module (`crates/fork-module`), instantiated sharing a
/// guest's linear memory. See this file's "N1-I4 Task 1" section doc comment.
///
/// `Clone` (N1-I4 Task 3): every field is a cheap handle (`wasmtime::Instance`
/// is `Copy`; `wasmtime::TypedFunc` is `Clone`) into the SAME `Store` this was
/// instantiated in -- cloning does not create a second module instance. This
/// lets `spawn_guest_thread` hand one copy to its `kernel_fork` import closure
/// while keeping the original for the entry loop's own coordinator calls.
///
/// The `fm_*` entries bound here are exactly the ones the Node/browser host
/// calls for the same step, in the same order. Everything a fork CAPTURES goes
/// through the module's own exports, bound into the guest by name
/// ([`bind_guest_fork_imports`]); this host keeps no capture state of its own.
#[derive(Clone)]
pub struct ForkModule {
    /// The instantiated fork-module, in the `Store` passed to
    /// [`instantiate_fork_module`].
    pub instance: wasmtime::Instance,
    /// First byte of the host-reserved region (== the module's
    /// `__memory_base`).
    pub memory_base: usize,
    /// Total bytes reserved: the module's static/BSS footprint (from its
    /// `dylink.0` mem_info, rounded up to its declared alignment) plus its
    /// shadow stack ([`FORK_MODULE_SHADOW_STACK_BYTES`]). The region is
    /// `[memory_base, memory_base + region_bytes)`.
    pub region_bytes: usize,
    /// The staging slab: [`FORK_MODULE_STAGING_SLAB_BYTES`] reserved ABOVE
    /// the module's shadow stack, mirroring `stagingBase` in
    /// `host/src/fork-module-instance.ts`. A per-call scratch: the module
    /// copies what it is given during the entry that takes it, so the slab
    /// holds one request at a time -- in practice activation 0's admission.
    pub staging_base: usize,
    /// The objects `__wpk_fork_host_ref_identity` has numbered, by identity
    /// (index + 1). See [`instantiate_fork_module`].
    ref_identities: Arc<Mutex<Vec<wasmtime::OwnedRooted<AnyRef>>>>,
    /// Where `fm_bind_activation` placed activation 0's static roots in
    /// [`Self::static_root_catalog_table`], or `u32::MAX` while this worker has
    /// harvested none. See [`fill_static_root_catalog`].
    static_root_base: Arc<AtomicU32>,

    // -- Coordinator (`fm_*`) exports, bound once here so callers never
    // re-look-up a name (a typo would only surface at the FIRST call site,
    // not at instantiation) -----------------------------------------------
    /// `(pointer_width, fixed_prefix_size, archive_control_addr, channel_base)`.
    ///
    /// `archive_control_addr` is the worker's fork control word: the one
    /// below its main channel (`channel - FORK_SAVE_BUFFER_SIZE`), or for a
    /// borrowed vfork child its OWNER's, as the JavaScript hosts pass. The
    /// module publishes a COW child's launch root there; this host has no
    /// dlopen, so no peer ever publishes an archive behind it.
    pub fm_set_format: wasmtime::TypedFunc<(u32, u32, u32, u32), ()>,
    /// `fm_admit_activation(desc_ptr, len) -> errno`: one activation's `KFAA`
    /// admission descriptor ([`GuestForkFormat::admission`]).
    pub fm_admit_activation: wasmtime::TypedFunc<(u32, u32), i32>,
    /// `fm_admission_buffer(len) -> ptr`, `0` + `fm_last_errno` on failure: a
    /// module-mapped buffer for an admission larger than the staging slab,
    /// released by the `fm_admit_activation` that reads it.
    pub fm_admission_buffer: wasmtime::TypedFunc<u32, u32>,
    /// `fm_bind_activation(id, func_catalog_len, static_root_len) -> row`, `0`
    /// + `fm_last_errno` on failure. See [`bind_activation`].
    pub fm_bind_activation: wasmtime::TypedFunc<(u32, u32, u32), u32>,
    /// `fm_publish_bindings(activation, rows_ptr, count) -> errno`: which
    /// identity group each catalog entry is. See [`publish_table_bindings`].
    pub fm_publish_bindings: wasmtime::TypedFunc<(u32, u32, u32), i32>,
    pub fm_last_errno: wasmtime::TypedFunc<(), i32>,
    /// `fm_phase()` -- the module's fork phase. See [`in_fork_capture`].
    pub fm_phase: wasmtime::TypedFunc<(), u32>,
    /// Proof-of-use statistics: the single folded counter accessor
    /// (`fm_stats(field) -> i64`), replacing the former 11 individual `fm_*`
    /// counter exports. Field indices are the `FM_STAT_*` constants above.
    pub fm_stats: wasmtime::TypedFunc<u32, i64>,
    /// `fm_capture_begin()` -- opens this fork's capture graph and resets the
    /// module's bump heap; the first module call of a capture.
    pub fm_capture_begin: wasmtime::TypedFunc<(), ()>,
    /// `fm_parent_begin_capture(channel_base) -> act0_root` -- the module
    /// allocates its own arena and drives each guest `wpk_fork_unwind_begin`.
    pub fm_parent_begin_capture: wasmtime::TypedFunc<u32, u32>,
    /// `fm_parent_seal_capture(channel_base) -> journal_image_ptr` -- drives
    /// each guest `wpk_fork_unwind_end()`, seals the capture into the module's
    /// arena, and serializes the child image (0 + `fm_last_errno` on failure).
    pub fm_parent_seal_capture: wasmtime::TypedFunc<u32, u32>,
    /// `fm_parent_replay(abort)` -- begins the parent rewind (or, with `abort`,
    /// the abort replay) and drives each guest `wpk_fork_{rewind,abort}_begin`.
    pub fm_parent_replay: wasmtime::TypedFunc<u32, ()>,
    /// `fm_parent_finish(abort)` -- drives each guest
    /// `wpk_fork_{rewind,abort}_end()`, then finishes the replay.
    pub fm_parent_finish: wasmtime::TypedFunc<u32, ()>,
    /// `fm_child_install(pid, launch_root, borrowed_base, borrowed_bytes) ->
    /// errno` -- ONE call installs a COW or borrowed fork child. See
    /// [`run_fork_capable_entry`].
    pub fm_child_install: wasmtime::TypedFunc<(u32, u32, u32, u32), i32>,

    /// The module's OWN imported funcref table (`env.__wpk_fork_function_catalog`)
    /// -- created empty by [`instantiate_fork_module`] and filled, after a guest
    /// instance exists, with that guest's own exported catalog entries.
    pub function_catalog_table: Table,
    /// The module's OWN imported funcref table (`env.__wpk_fork_drive_table`)
    /// the injected `fm_drive_execute` `call_indirect`s; filled by
    /// [`bind_activation`].
    pub drive_table: Table,
    /// The module's own module-defined, module-EXPORTED anyref static-root
    /// catalog (`__wpk_fork_static_root_catalog`) the static-root binder
    /// `table.get`s. The module grows it as `fm_bind_activation` places each
    /// catalog; this host only writes a guest's harvested static-root values
    /// into the placed range ([`fill_static_root_catalog`]).
    pub static_root_catalog_table: Table,
}

/// Instantiate the co-resident fork-module (`crate::fork_module_path()`)
/// sharing `guest_mem` as its `env.memory`, placing its static/BSS/shadow-
/// stack region at the TOP of `layout.max_addr` (frames-only — N1-I4 Task
/// 1). See this file's "N1-I4 Task 1" section doc comment for the design
/// this ports from `host/src/fork-module-instance.ts:415-542`.
///
/// ## Region placement, and why it is safe
///
/// The module is PIC: its data/BSS/shadow stack live at `__memory_base +
/// offset`, so the host must choose a region of `guest_mem` the module can
/// own without colliding with the guest's own data. This computes that
/// region's size from the module's own `dylink.0` `mem_info` (its real
/// static footprint, not a guess) plus a 1 MiB shadow stack, and places it
/// ending exactly at `layout.max_addr` — the SAME ceiling value
/// `launch_process` already passes to the kernel's `kernel_set_max_addr`
/// export for this process (see that call site). Reusing that exact knob is
/// deliberate: a caller that, instead of `layout.max_addr`, passes this
/// function's returned `memory_base` to `kernel_set_max_addr` SHRINKS the
/// process's kernel-visible address ceiling, so the kernel's own mmap/brk
/// allocator can never hand the guest an address inside `[memory_base,
/// memory_base + region_bytes)` afterward — the reservation becomes
/// KERNEL-ENFORCED (the kernel is the address-space authority for this
/// process), not merely "unlikely to collide". This is the same safety
/// property the browser/Node host's `continuationMmap` gets by routing a
/// real `mmap` through the kernel, reached here through a different existing
/// knob instead of a synthesized channel round-trip.
///
/// Task 1 does NOT itself call `kernel_set_max_addr` — this function has no
/// kernel `Store`/pid in scope, and Task 1 is instantiation-only (no
/// `SYS_FORK` wiring). Wiring that shrink into `launch_process` — so it is
/// actually kernel-enforced for a live, running guest, rather than merely
/// computed — is Task 2/3's job, once a real fork path exists to protect.
/// The smoke test below instantiates against a freshly computed layout whose
/// guest never runs, so the un-enforced reservation cannot collide with
/// anything in that scope either way.
///
/// Before returning, this grows `guest_mem`'s wasm-visible size to cover the
/// reserved region ([`grow_to_cover`]) — `SharedMemory` pre-reserves its
/// hard virtual maximum, but ordinary wasm loads/stores are bounds-checked
/// against the CURRENT (grown) size, so the module's own start function
/// (which writes its passive data segments into the region) would trap
/// without this.
/// Pure computation of the co-resident fork-module's placement: reads
/// `crate::fork_module_path()`'s bytes fresh and returns `(memory_base,
/// region_bytes)` — the SAME math [`instantiate_fork_module`] used to do
/// inline, split out here (N1-I4 Task 2) so [`launch_process`] can learn
/// `memory_base` — the value it must pass to the kernel's
/// `kernel_set_max_addr` export (see that call site's doc comment for
/// concern 3: shrinking the process's kernel-visible ceiling BELOW this
/// region so the kernel's own brk/mmap allocator can never collide with it)
/// — BEFORE the guest OS thread that actually instantiates the module even
/// exists. Touches no `Store`/`Engine` state; only file I/O and arithmetic,
/// so it is safe to call from the pump/kernel thread while a guest OS thread
/// is live.
pub(crate) fn compute_fork_module_region(layout: &ProcessLayout) -> anyhow::Result<(usize, usize)> {
    let fork_module_wasm_path = crate::fork_module_path();
    let wasm_bytes = std::fs::read(&fork_module_wasm_path)
        .map_err(|e| anyhow::anyhow!("reading {}: {e}", fork_module_wasm_path.display()))?;

    let (mem_size, mem_align) = read_fork_module_mem_info(&wasm_bytes)?;
    anyhow::ensure!(mem_align > 0 && mem_align.is_power_of_two(), "fork-module mem_align {mem_align} is not a power of two");
    let static_bytes = mem_size.div_ceil(mem_align) * mem_align;
    // Low to high, as `host/src/fork-module-instance.ts` lays it out: the
    // static footprint, the shadow stack, then the staging slab -- above the
    // stack's top, so the stack, which grows DOWN, can never reach it.
    let min_region_bytes = static_bytes + FORK_MODULE_SHADOW_STACK_BYTES + FORK_MODULE_STAGING_SLAB_BYTES;

    let region_end = layout.max_addr;
    anyhow::ensure!(
        min_region_bytes <= region_end,
        "fork-module region ({min_region_bytes} bytes) does not fit under max_addr ({region_end})"
    );
    // Place the region so it ends exactly at `region_end`, aligning its base
    // DOWN (this can only grow the region slightly, never shrink it below
    // `min_region_bytes`, and never push the base below 0 given the `ensure!`
    // above).
    //
    // TO 16 BYTES AT LEAST, not merely to the module's own `mem_align`. The
    // base is where the module's data lands, and `mem_align` is what THAT
    // needs; but this base is also where a vfork BORROWED child's region ENDS
    // (`compute_vfork_borrowed_region` sets the child's `max_addr` to it), so
    // it is the child module's STACK TOP as well, and the shadow stack pointer
    // must be 16-byte aligned regardless of how the module's data happens to
    // be. The storage conversion deleted the last 16-aligned static (the
    // 64 KiB scratch cell), `dylink.0` dropped to an 8-byte `mem_align`, and
    // this base fell to 8-aligned -- which the `stack_top % 16` check below
    // then refused for EVERY fork-module process launch, because every one
    // reserves its borrowed-child region up front. The module's alignment
    // was never the stack's requirement; it only happened to satisfy it.
    let base_align = mem_align.max(16);
    let memory_base = (region_end - min_region_bytes) / base_align * base_align;
    let region_bytes = region_end - memory_base;
    let stack_top = region_end - FORK_MODULE_STAGING_SLAB_BYTES;
    anyhow::ensure!(
        stack_top % 16 == 0,
        "fork-module stack top 0x{stack_top:x} is not 16-byte aligned"
    );
    anyhow::ensure!(
        i32::try_from(stack_top).is_ok(),
        "fork-module region top 0x{stack_top:x} does not fit in a wasm32 i32 address"
    );
    Ok((memory_base, region_bytes))
}

/// Real vfork (N1 residual): the child-private region a BORROWED vfork
/// child needs, reserved up front (whether or not a vfork ever actually
/// happens) for every `use_fork_module` process — the same "reserve now,
/// use lazily" precedent as the co-resident fork-module region itself.
///
/// A COW fork child reuses the PARENT's exact numeric [`ProcessLayout`]
/// (`handle_fork`'s `let layout = processes[pi].layout;`), because it gets
/// its OWN, separate `SharedMemory` — same addresses, different bytes. A
/// vfork child instead shares the SAME `SharedMemory` as the parent, so
/// reusing the parent's layout verbatim would make the child's own
/// fork-module instance collide byte-for-byte with the still-live parent's
/// one (both anchored at the SAME `compute_fork_module_region(&layout)`
/// address). This function carves a SECOND, same-shaped fork-module region
/// strictly BELOW the parent's own (`compute_fork_module_region` again, fed
/// a synthetic layout whose `max_addr` is the parent's own region's base),
/// plus a private channel and a private fixed-runtime-prefix target
/// immediately below that — pure functions of `layout` alone, so parent and
/// (thanks to `handle_fork`'s existing layout-reuse) any vfork child agree
/// on the same numbers without needing any new per-process state.
///
/// At most one vfork child can ever be live per parent today (the kernel's
/// own `vfork_child` re-entrancy guard, and this host's fork/vfork-is-
/// main-thread-only restriction — see `kernel_fork`'s doc comment —
/// together make a second concurrent borrower from the SAME parent
/// unreachable), so reserving exactly one such region is always enough.
#[derive(Debug, Clone, Copy)]
struct VforkBorrowedRegion {
    /// The ceiling every `use_fork_module` process's own `kernel_set_max_
    /// addr` must use (via `launch_process`) instead of the raw fork-module
    /// region base, so the guest's own brk/mmap allocator can never
    /// encroach on either reserved region.
    guest_ceiling: usize,
    /// The `layout.max_addr` a borrowed child's OWN `instantiate_fork_
    /// module` call must use (via a layout clone), so its module lands in
    /// `[private_prefix's page, this)`, never overlapping the parent's own
    /// live `[this, layout.max_addr)`.
    child_module_max_addr: usize,
    /// The child's private main channel — never the parent's own `layout.
    /// channel_offset`.
    channel_offset: usize,
    /// The child-private `target` [`crates/fork-module`]'s `copy_borrowed_
    /// child_prefix` (via `fm_begin_borrowed_child_replay`) copies the
    /// parent's mutable fixed runtime prefix into.
    private_prefix: usize,
}

fn compute_vfork_borrowed_region(layout: &ProcessLayout) -> anyhow::Result<VforkBorrowedRegion> {
    let (parent_module_base, _) = compute_fork_module_region(layout)?;
    let mut child_module_layout = *layout;
    child_module_layout.max_addr = parent_module_base;
    let (child_module_base, _) = compute_fork_module_region(&child_module_layout)?;
    let reserved_below_child_module = CHANNEL_PAGES * WASM_PAGE_SIZE + WASM_PAGE_SIZE;
    anyhow::ensure!(
        child_module_base >= reserved_below_child_module,
        "vfork-borrowed region has no room for a private channel/prefix below {child_module_base:#x}"
    );
    let channel_offset = child_module_base - CHANNEL_PAGES * WASM_PAGE_SIZE;
    let private_prefix = channel_offset - WASM_PAGE_SIZE;
    Ok(VforkBorrowedRegion {
        guest_ceiling: private_prefix,
        child_module_max_addr: parent_module_base,
        channel_offset,
        private_prefix,
    })
}

pub(crate) fn instantiate_fork_module(
    engine: &Engine,
    store: &mut Store<()>,
    guest_mem: &SharedMemory,
    layout: &ProcessLayout,
) -> anyhow::Result<ForkModule> {
    let fork_module_wasm_path = crate::fork_module_path();
    let wasm_bytes = std::fs::read(&fork_module_wasm_path)
        .map_err(|e| anyhow::anyhow!("reading {}: {e}", fork_module_wasm_path.display()))?;
    let module = Module::new(engine, &wasm_bytes)?;

    let (memory_base, region_bytes) = compute_fork_module_region(layout)?;
    // The staging slab is the region's top; the shadow stack's top is its base.
    let staging_base = memory_base + region_bytes - FORK_MODULE_STAGING_SLAB_BYTES;
    let stack_top = staging_base;

    grow_to_cover(guest_mem, memory_base + region_bytes)?;

    let mut linker: Linker<()> = Linker::new(engine);
    linker.define(&mut *store, "env", "memory", guest_mem.clone())?;

    // The module's imported reference-carrying tables: an empty, growable
    // table exactly matching each import's declared type (frames-only never
    // populates any of them — they are the funcref-reconstruction path, I5's
    // job). Reading the declared `TableType` back off the import — rather
    // than assuming a shape — means a future module rebuild that changes
    // these declarations fails loudly here instead of silently mismatching.
    // Every imported table is funcref: the module's anyref tables (the GC
    // transit and the static-root catalog) are its own exports, resolved
    // after instantiation below, so no host mints a GC-typed table.
    // N1-I5 Task 1: the two funcref tables below are kept as named
    // `Table` handles (not just defined into the linker and dropped) so
    // `spawn_guest_thread` can populate them, AFTER a guest instance exists,
    // from that guest's own exported catalog/drive tables — see this
    // function's returned [`ForkModule::function_catalog_table`]/
    // [`ForkModule::drive_table`].
    // `wasmtime::Table` is a cheap `Copy` handle into this `Store`, so
    // capturing it here and also handing a copy to `linker.define` are the
    // SAME underlying table — growing/populating the captured handle later
    // is visible to the module through its import.
    let mut fork_module_table = |name: &str, init: Ref| -> anyhow::Result<Table> {
        let ty = module
            .imports()
            .find(|i| i.module() == "env" && i.name() == name)
            .ok_or_else(|| anyhow::anyhow!("fork-module does not import env.{name}"))
            .and_then(|i| match i.ty() {
                ExternType::Table(t) => Ok(t),
                other => anyhow::bail!("fork-module env.{name} is a {other:?}, not a table"),
            })?;
        let table = Table::new(&mut *store, ty, init)?;
        linker.define(&mut *store, "env", name, table)?;
        Ok(table)
    };
    fork_module_table("__indirect_function_table", Ref::Func(None))?;
    let function_catalog_table = fork_module_table("__wpk_fork_function_catalog", Ref::Func(None))?;
    let drive_table = fork_module_table("__wpk_fork_drive_table", Ref::Func(None))?;

    let memory_base_global = Global::new(
        &mut *store,
        GlobalType::new(ValType::I32, Mutability::Const),
        Val::I32(memory_base as i32),
    )?;
    linker.define(&mut *store, "env", "__memory_base", memory_base_global)?;

    let table_base_global = Global::new(
        &mut *store,
        GlobalType::new(ValType::I32, Mutability::Const),
        Val::I32(0),
    )?;
    linker.define(&mut *store, "env", "__table_base", table_base_global)?;

    let stack_pointer_global = Global::new(
        &mut *store,
        GlobalType::new(ValType::I32, Mutability::Var),
        Val::I32(stack_top as i32),
    )?;
    linker.define(&mut *store, "env", "__stack_pointer", stack_pointer_global)?;

    // `__wpk_fork_host_materialize_dlopen_archive(generation) -> errno`: the
    // module asks a host to instantiate libraries a PEER dlopened. This host
    // has no dlopen, so no archive is ever published behind its control word
    // and it is never asked -- the module only asks after reading a published
    // archive. Answered ENOSYS (38), the truthful "this host cannot load
    // libraries", rather than left to the trap pass, so a future host path that
    // did publish an archive would see an errno it can report.
    linker.func_wrap(
        "env",
        "__wpk_fork_host_materialize_dlopen_archive",
        |_generation: i64| -> i32 { 38 },
    )?;
    // The module's two identity floors (`host/src/fork-module-host-
    // capabilities.ts` states each one's reason): wasm cannot compare two
    // references, so the host answers with a stable non-zero integer per
    // distinct value and the module keys its own maps on it. Identity 0 is
    // never issued; the module reads 0 as "no recipe bound".
    //
    // A function's `Func::to_raw` pointer is stable for this `Store`'s life
    // (`a_native_host_can_identify_funcrefs`), so functions are numbered by it.
    let func_ids: Mutex<HashMap<usize, i32>> = Mutex::new(HashMap::new());
    linker.func_wrap(
        "env",
        "__wpk_fork_host_func_identity",
        move |mut caller: Caller<'_, ()>, f: Option<wasmtime::Func>| -> wasmtime::Result<i32> {
            let f = f.ok_or_else(|| wasmtime::Error::msg("__wpk_fork_host_func_identity(null)"))?;
            let mut ids = func_ids.lock().unwrap();
            let next = ids.len() as i32 + 1;
            Ok(*ids.entry(f.to_raw(&mut caller) as usize).or_insert(next))
        },
    )?;
    // A GC object has no stable integer of its own, so it is kept (rooted) and
    // found again by `ref.eq`. Rooting pins it, where the JavaScript hosts'
    // `WeakMap` does not, so the pool is cleared at every `fm_capture_begin`
    // (`kernel_fork`): the module's only map keyed by it, `fm_gc_identity_*`,
    // is reset there too (`reset_bump_heap`), and both callers, the injected
    // `gc_lookup` / `gc_claim` shims, run only inside a capture.
    let ref_identities: Arc<Mutex<Vec<wasmtime::OwnedRooted<AnyRef>>>> = Arc::default();
    let pool = Arc::clone(&ref_identities);
    linker.func_wrap(
        "env",
        "__wpk_fork_host_ref_identity",
        move |mut caller: Caller<'_, ()>, v: Option<wasmtime::Rooted<AnyRef>>| -> wasmtime::Result<i32> {
            let v = v.ok_or_else(|| wasmtime::Error::msg("__wpk_fork_host_ref_identity(null)"))?;
            let mut pool = pool.lock().unwrap();
            for (i, known) in pool.iter().enumerate() {
                if wasmtime::Rooted::ref_eq(&mut caller, known, &v)? {
                    return Ok(i as i32 + 1);
                }
            }
            pool.push(v.to_owned_rooted(&mut caller)?);
            Ok(pool.len() as i32)
        },
    )?;
    linker.define_unknown_imports_as_traps(&module)?;

    let instance = linker.instantiate(&mut *store, &module)?;

    macro_rules! fm_func {
        ($name:literal : $params:ty => $ret:ty) => {
            instance
                .get_typed_func::<$params, $ret>(&mut *store, $name)
                .map_err(|e| anyhow::anyhow!("fork-module missing/mistyped export {}: {e}", $name))?
        };
    }

    // The module's own anyref static-root catalog: module-defined and
    // module-EXPORTED, grown by the module as it places catalogs. A missing
    // export is an ABI mismatch.
    let static_root_catalog_table = instance
        .get_table(&mut *store, wasm_posix_shared::abi::WPK_FORK_STATIC_ROOT_CATALOG_EXPORT)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "fork-module missing export {}",
                wasm_posix_shared::abi::WPK_FORK_STATIC_ROOT_CATALOG_EXPORT
            )
        })?;

    Ok(ForkModule {
        instance,
        memory_base,
        region_bytes,
        staging_base,
        ref_identities,
        static_root_base: Arc::new(AtomicU32::new(u32::MAX)),
        fm_set_format: fm_func!("fm_set_format": (u32, u32, u32, u32) => ()),
        fm_admit_activation: fm_func!("fm_admit_activation": (u32, u32) => i32),
        fm_admission_buffer: fm_func!("fm_admission_buffer": u32 => u32),
        fm_bind_activation: fm_func!("fm_bind_activation": (u32, u32, u32) => u32),
        fm_publish_bindings: fm_func!("fm_publish_bindings": (u32, u32, u32) => i32),
        fm_last_errno: fm_func!("fm_last_errno": () => i32),
        fm_phase: fm_func!("fm_phase": () => u32),
        fm_stats: fm_func!("fm_stats": u32 => i64),
        fm_capture_begin: fm_func!("fm_capture_begin": () => ()),
        fm_parent_begin_capture: fm_func!("fm_parent_begin_capture": u32 => u32),
        fm_parent_seal_capture: fm_func!("fm_parent_seal_capture": u32 => u32),
        fm_parent_replay: fm_func!("fm_parent_replay": u32 => ()),
        fm_parent_finish: fm_func!("fm_parent_finish": u32 => ()),
        fm_child_install: fm_func!("fm_child_install": (u32, u32, u32, u32) => i32),
        function_catalog_table,
        drive_table,
        static_root_catalog_table,
    })
}

/// The fork control word of the thread whose channel is at `channel_offset`:
/// the first word above the control prefix of the fork-save page directly
/// below that channel (`channelOffset - FORK_BUF_SIZE` on the JavaScript
/// hosts). A forking parent publishes its launch root there before it posts
/// `SYS_FORK`, [`handle_fork`] reads it back, and `fm_child_install` publishes
/// a COW child's own launch root in the child's copy.
fn fork_control_word(channel_offset: usize) -> usize {
    channel_offset - wasm_posix_shared::process_memory::FORK_SAVE_BUFFER_SIZE as usize
}

/// Seed this worker's format and admit activation 0: the two calls
/// `ForkModuleContinuationBackend.setup()` and `admitActivation` make
/// (`host/src/fork-module-backend.ts`), in the same order.
///
/// `fm_set_format` is given the channel base, the worker's fork control word
/// (`control`, see [`fork_control_word`]) and a fixed prefix of 0 --
/// activation 0's admission supplies the prefix. It RESETS every
/// per-activation record, so it runs first, once per worker.
///
/// The admission is staged in the slab, or, when it does not fit, in a buffer
/// the module maps to its size and releases as `fm_admit_activation` returns
/// (`stage` in `fork-module-backend.ts`). The module decodes and validates
/// every section and derives what this host used to seed fact by fact: the
/// resume catalog, the template id, the GC and exception codecs and the
/// host-exception owner.
fn admit_guest(
    store: &mut Store<()>,
    fm: &ForkModule,
    guest_mem: &SharedMemory,
    format: &GuestForkFormat,
    channel_offset: usize,
    control: u32,
    flags: u32,
) -> anyhow::Result<()> {
    fm.fm_set_format.call(&mut *store, (4, 0, control, channel_offset as u32))?;
    let errno = fm.fm_last_errno.call(&mut *store, ())?;
    anyhow::ensure!(errno == 0, "fm_set_format failed: errno {errno}");
    let desc = format.admission(0, flags);
    let at = if desc.len() <= FORK_MODULE_STAGING_SLAB_BYTES {
        fm.staging_base
    } else {
        let at = fm.fm_admission_buffer.call(&mut *store, desc.len() as u32)?;
        let errno = fm.fm_last_errno.call(&mut *store, ())?;
        anyhow::ensure!(at != 0, "fm_admission_buffer({}) failed: errno {errno}", desc.len());
        at as usize
    };
    anyhow::ensure!(at + desc.len() <= guest_mem.data().len(), "admission buffer {at:#x} is outside guest memory");
    // SAFETY: in bounds (checked above); the slab and a module-mapped buffer
    // belong to this worker alone.
    unsafe { write_bytes(guest_mem, at, &desc) };
    let errno = fm.fm_admit_activation.call(&mut *store, (at as u32, desc.len() as u32))?;
    anyhow::ensure!(errno == 0, "fm_admit_activation refused activation 0: errno {errno}");
    Ok(())
}

/// The row `fm_bind_activation` answers for an admitted, instantiated
/// activation.
#[derive(Debug, Clone, Copy)]
struct ActivationRow {
    func_catalog_base: u32,
    static_root_base: u32,
}

/// Bind the admitted activation 0 after its instantiation, as
/// `ForkActivations.register` does through `bindActivation`: one module call
/// places its two merged catalogs and publishes its resume assignment, and
/// this host does the reference-typed work only it can -- the guest places its
/// own resume thunks from the published `(ptr, count)`, and every guest export
/// the module drives is `Table.set` into `__wpk_fork_drive_table` at the row's
/// drive base. The row's catalog bases are returned for the catalog mirrors.
///
/// EVERY SLOT THE MODULE DRIVES is bound, not just the phase flips: the module
/// `call_indirect`s these slots itself (unwind/rewind/abort, module-state
/// save/restore, the table shims), and an unbound slot is a call on null --
/// eleven native fork tests once trapped `undefined element` on exactly that.
/// This is `FORK_ACTIVATION_DRIVE_BINDINGS` in the JavaScript hosts, with the
/// offsets read from `fork_codec`. A REQUIRED slot whose export is missing is a
/// broken artifact and says so; the rest depend on what the guest contains.
fn bind_activation(
    store: &mut Store<()>,
    fm: &ForkModule,
    instance: &Instance,
    guest_mem: &SharedMemory,
) -> anyhow::Result<ActivationRow> {
    use fork_codec::drive_plan as slots;
    use wasm_posix_shared::abi as fork_abi;

    let mut table_len = |name: &str| instance.get_table(&mut *store, name).map_or(0, |t| t.size(&*store) as u32);
    let func_len = table_len("__wpk_fork_function_catalog");
    let static_len = table_len(fork_abi::WPK_FORK_STATIC_ROOT_CATALOG_EXPORT);
    let at = fm.fm_bind_activation.call(&mut *store, (0, func_len, static_len))? as usize;
    let errno = fm.fm_last_errno.call(&mut *store, ())?;
    anyhow::ensure!(at != 0, "fm_bind_activation(0) failed: errno {errno}");
    anyhow::ensure!(at + 20 <= guest_mem.data().len(), "fm_bind_activation row {at:#x} is outside guest memory");
    // SAFETY: in bounds (checked above); read before the next module call,
    // which may rewrite the row.
    let [drive_base, func_catalog_base, static_root_base, resume_ptr, resume_count] =
        std::array::from_fn(|i| unsafe { read_u32(guest_mem, at + i * 4) });

    place_resume_thunks(store, instance, 0, resume_ptr, resume_count)?;

    let bindings: [(u32, &str, bool); 19] = [
        (slots::DRIVE_OP_ALLOC, fork_abi::WPK_FORK_REFERENCE_EXPORT_GC_ALLOCATE, false),
        (slots::DRIVE_OP_FILL, fork_abi::WPK_FORK_REFERENCE_EXPORT_GC_FILL, false),
        (slots::DRIVE_OP_EXN, fork_abi::WPK_FORK_EXCEPTION_EXPORT_MATERIALIZE, false),
        (slots::DRIVE_SLOT_RESTORE, fork_abi::WPK_FORK_EXPORT_MODULE_STATE_RESTORE, true),
        (slots::DRIVE_SLOT_FINISH_RESTORE, fork_abi::WPK_FORK_EXPORT_MODULE_STATE_FINISH_RESTORE, true),
        (slots::DRIVE_SLOT_REWIND_BEGIN, fork_abi::WPK_FORK_EXPORT_REWIND_BEGIN, true),
        (slots::DRIVE_SLOT_ABORT_BEGIN, fork_abi::WPK_FORK_EXPORT_ABORT_BEGIN, true),
        (slots::DRIVE_SLOT_UNWIND_END, fork_abi::WPK_FORK_EXPORT_UNWIND_END, true),
        (slots::DRIVE_SLOT_REWIND_END, fork_abi::WPK_FORK_EXPORT_REWIND_END, true),
        (slots::DRIVE_SLOT_ABORT_END, fork_abi::WPK_FORK_EXPORT_ABORT_END, true),
        (slots::DRIVE_SLOT_UNWIND_BEGIN, fork_abi::WPK_FORK_EXPORT_UNWIND_BEGIN, true),
        (slots::DRIVE_SLOT_GC_ENCODE, fork_abi::WPK_FORK_REFERENCE_EXPORT_GC_ENCODE_SLOT, false),
        (slots::DRIVE_SLOT_GC_PROBE, fork_abi::WPK_FORK_REFERENCE_EXPORT_GC_PROBE, false),
        (slots::DRIVE_SLOT_MODULE_STATE_SAVE, fork_abi::WPK_FORK_EXPORT_MODULE_STATE_SAVE, true),
        (slots::DRIVE_SLOT_MODULE_TABLE_STATE_SAVE, fork_abi::WPK_FORK_EXPORT_MODULE_TABLE_STATE_SAVE, false),
        (slots::DRIVE_SLOT_EXN_THROW_RECIPE, fork_abi::WPK_FORK_EXCEPTION_EXPORT_THROW_RECIPE, false),
        // The guest's own table shims. The module reaches a guest table only
        // through these; with no dlopen here nothing publishes a patch, but a
        // guest table mutation still commits through them.
        (slots::DRIVE_SLOT_TABLE_READ, fork_abi::WPK_FORK_EXPORT_MODULE_TABLE_READ, true),
        (slots::DRIVE_SLOT_TABLE_LENGTH, fork_abi::WPK_FORK_EXPORT_MODULE_TABLE_LENGTH, true),
        (slots::DRIVE_SLOT_TABLE_APPLY, fork_abi::WPK_FORK_EXPORT_MODULE_TABLE_APPLY, true),
    ];
    // Sized to the WHOLE stride, so every slot the module derives from the
    // drive base is addressable even when this host binds nothing into it.
    let needed = u64::from(drive_base) + u64::from(slots::DRIVE_SLOTS_PER_ACTIVATION);
    let current = fm.drive_table.size(&*store);
    if needed > current {
        fm.drive_table.grow(&mut *store, needed - current, Ref::Func(None))?;
    }
    for (slot, export, required) in bindings {
        let at = u64::from(drive_base) + u64::from(slot);
        match instance.get_func(&mut *store, export) {
            Some(func) => fm
                .drive_table
                .set(&mut *store, at, Ref::Func(Some(func)))
                .map_err(|e| anyhow::anyhow!("binding __wpk_fork_drive_table[{at}] ({export}) failed: {e:#}"))?,
            None if required => anyhow::bail!(
                "fork-instrumented guest exports no {export}; the module drives drive-table slot {slot} \
                 and an unbound slot is a call_indirect on null"
            ),
            None => {}
        }
    }
    publish_table_bindings(store, fm, instance, guest_mem)?;
    Ok(ActivationRow { func_catalog_base, static_root_base })
}

/// Tell the module which identity group each of the guest's private tables
/// is, one `__wpk_fork_table_<owner>` export per group, so the module elects
/// each table's sparse-state writer (`fm_publish_bindings`, the table-space
/// rows `ForkImportIdentity` publishes on the JS hosts).
///
/// A group per export is the whole identity question on this host: it runs
/// one activation, which exports each of its tables once, so no two catalog
/// entries name one table. Without a publication the module answers "not
/// owned" for every table, and a capture writes no table state at all -- the
/// missing election behind `smoke_fork_externref_table`.
fn publish_table_bindings(
    store: &mut Store<()>,
    fm: &ForkModule,
    instance: &Instance,
    guest_mem: &SharedMemory,
) -> anyhow::Result<()> {
    use fork_codec::bindings::{encode_binding_rows, BindingRow, IMPORT_SPACE_TABLE};

    let prefix = wasm_posix_shared::abi::WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX;
    let mut rows = Vec::new();
    for export in instance.exports(&mut *store) {
        let Some(suffix) = export.name().strip_prefix(prefix) else { continue };
        let owner: u32 = suffix
            .parse()
            .ok()
            .filter(|&owner| owner != 0 && !suffix.starts_with('0'))
            .ok_or_else(|| anyhow::anyhow!("malformed table catalog export {}", export.name()))?;
        anyhow::ensure!(export.into_table().is_some(), "table catalog {prefix}{suffix} is not a table");
        rows.push(BindingRow::export(IMPORT_SPACE_TABLE, owner, owner));
    }
    if rows.is_empty() {
        return Ok(());
    }
    let bytes = encode_binding_rows(&rows);
    anyhow::ensure!(
        bytes.len() <= FORK_MODULE_STAGING_SLAB_BYTES && fm.staging_base + bytes.len() <= guest_mem.data().len(),
        "{} table bindings do not fit the staging slab",
        rows.len()
    );
    // SAFETY: in bounds (checked above); the slab belongs to this worker alone.
    unsafe { write_bytes(guest_mem, fm.staging_base, &bytes) };
    let errno = fm.fm_publish_bindings.call(&mut *store, (0, fm.staging_base as u32, rows.len() as u32))?;
    anyhow::ensure!(errno == 0, "fm_publish_bindings refused activation 0's tables: errno {errno}");
    Ok(())
}

/// Have one freshly instantiated guest place its OWN resume thunks, at the
/// slots the fork module chose.
///
/// Mirrors `ForkResumeTable.registerActivation` (`host/src/fork-resume-
/// table.ts`) exactly: hand the guest the whole activation's decision, the
/// `(ptr, count)` [`bind_activation`] read from the module's row. The module
/// decided every slot when this guest's admission registered its ordinals,
/// and writes that decision into the memory it and the guest SHARE; the guest's emitted
/// `__wpk_fork_place_resume_thunks` copies each thunk out of its own
/// `__wpk_fork_resume_catalog` table into the module's resume table. Two calls,
/// whatever the activation's size, and not one funcref passes through this
/// host.
///
/// # What this replaces, and why a second numbering was not safe to keep
///
/// This host used to mint its own `wasmtime::Table`, size it to
/// `catalog_ordinals.len() + 1`, and write record `i` to slot `i + 1` — its
/// own numbering, never asking the module that owns the assignment. The
/// JavaScript host had the identical second allocator and the two agreed only
/// while nothing was ever released: `dlclose` of a library while a
/// later-loaded one is still open makes them differ on three coordinates, and
/// the guest then resumes into ANOTHER activation's thunk — a real function of
/// the right type, so nothing traps (census 194). That is why the numbering
/// moved into the module, and why a host that keeps its own copy of it
/// quietly re-opens the hole for its own hosts.
///
/// The slots this produces for a single-activation native guest are the same
/// `i + 1` the old loop produced, because the module sorts a dense 0..n-1
/// catalog and allocates from 1. That is a coincidence of this host's one
/// supported shape, not the contract: the contract is that there is ONE
/// allocator and it is the module's.
///
/// # The same-artifact guard, which this host did not have
///
/// `registerActivation` compares the module's assigned count against the
/// guest's own catalog table length, because the shim uses a record's ordinal
/// as an INDEX into that catalog. A guest instantiated from a different
/// artifact than the one whose ordinals were seeded places a prefix and leaves
/// the rest at no slot at all, silently. The check is O(1) and it is made here
/// too, by name, so the native host fails the same way the JavaScript one
/// does instead of resuming into whatever the prefix left behind.
fn place_resume_thunks(
    store: &mut Store<()>,
    instance: &Instance,
    activation: u32,
    ptr: u32,
    count: u32,
) -> anyhow::Result<()> {
    // NO EARLY RETURN ON `count == 0`, and that is the whole point of the
    // guard below. An activation that holds no slots IS a success publishing
    // `(0, 0)` — a side module with no fork-instrumented function seeds an
    // EMPTY resume catalog, and reading that as an error once cost a real
    // fork. But "the module assigned nothing" and "this guest has nothing to
    // place" are two different facts, and a module seeded with an empty
    // ordinal set against an instance exporting N > 0 thunks is exactly the
    // mismatch the check catches. Returning here first would skip it for the
    // one case it exists for, leaving a bare `undefined element` trap inside a
    // fork child where the JavaScript host gives the named error.
    // `ForkResumeTable.registerActivation` applies both checks
    // unconditionally; so does this.
    let catalog = instance
        .get_table(&mut *store, "__wpk_fork_resume_catalog")
        .ok_or_else(|| anyhow::anyhow!("guest missing __wpk_fork_resume_catalog export"))?;
    let catalog_len = catalog.size(&mut *store);
    anyhow::ensure!(
        catalog_len == u64::from(count),
        "activation {activation} instantiated with {catalog_len} resume thunks, but the module \
         assigned {count} slots from the catalog it was seeded with. The seeded module and the \
         instantiated one are not the same artifact."
    );

    let place = instance
        .get_typed_func::<(u32, u32), u32>(&mut *store, "__wpk_fork_place_resume_thunks")
        .map_err(|e| {
            anyhow::anyhow!(
                "guest exports no __wpk_fork_place_resume_thunks, so it cannot place its own \
                 resume thunks. A fork-instrumented artifact always carries it; this one was \
                 instrumented by an older toolchain or not at all: {e}"
            )
        })?;
    // The return is `max(count, 0)` — what was ASKED for, not what succeeded.
    // Every failure mode inside the shim traps, so there is nothing to check
    // here that would not be a check against itself. Called even at `count ==
    // 0`, where the shim's signed loop guard exits immediately: the call costs
    // nothing and keeps the shim-export check above unconditional too, which
    // is the same shape `registerActivation` has.
    place.call(store, (ptr, count))?;
    Ok(())
}

/// Bind every `env.__wpk_fork_*` import the guest declares to the fork
/// module's export of the same name -- functions, the unwind tag, the resume
/// and GC-transit tables alike -- as `buildForkGuestImports` does on the
/// JavaScript hosts. Driven off the guest artifact's own import list, so an
/// import the module starts serving needs no edit here.
///
/// The module is the authority on everything it exports: this host adds no
/// fork import of its own, and in particular keeps no capture state -- every
/// frame, reference and module-state record a fork carries goes into the
/// module's arena, which is what its parent replay and `fm_child_install` read.
/// An import the module does not export (the two per-activation globals) is
/// left to the default-value pass.
fn bind_guest_fork_imports(
    linker: &mut Linker<()>,
    store: &mut Store<()>,
    module: &Module,
    fm: &ForkModule,
) -> anyhow::Result<()> {
    for import in module.imports() {
        if import.module() != "env" || !import.name().starts_with("__wpk_fork_") {
            continue;
        }
        if let Some(export) = fm.instance.get_export(&mut *store, import.name()) {
            linker
                .define(&mut *store, "env", import.name(), export)
                .map_err(|e| anyhow::anyhow!("binding the fork module's {} into the guest: {e:#}", import.name()))?;
        }
    }
    Ok(())
}

/// Copy activation 0's harvested static roots (the guest's
/// `__wpk_fork_static_root_catalog`) into the module's merged catalog at the
/// base `fm_bind_activation` placed them -- `ForkMergedStaticRoots.fill` on the
/// JavaScript hosts. A capture and a child install both read the merged
/// catalog, and `fm_child_install` nulls it once its drive has run, so it is
/// filled before each. A no-op for a worker that harvested no static roots.
fn fill_static_root_catalog(
    mut store: impl wasmtime::AsContextMut,
    fm: &ForkModule,
    guest_roots: Table,
) -> anyhow::Result<()> {
    let base = fm.static_root_base.load(Ordering::SeqCst);
    if base == u32::MAX {
        return Ok(());
    }
    for i in 0..guest_roots.size(&mut store) {
        let root = guest_roots
            .get(&mut store, i)
            .ok_or_else(|| anyhow::anyhow!("guest static-root catalog[{i}] is out of bounds"))?;
        fm.static_root_catalog_table
            .set(&mut store, u64::from(base) + i, root)
            .map_err(|e| anyhow::anyhow!("populating fork-module static-root catalog[{i}] failed: {e:#}"))?;
    }
    Ok(())
}

/// `kernel_fork`'s capture begin, in `worker-main.ts`'s order: open the
/// module's capture graph (`fm_capture_begin`, which also resets the module's
/// identity map, so this host's identity pool is emptied with it), refill the
/// merged static-root catalog the capture reads, then open the capture -- the
/// module allocates its own arena -- and have the module drive
/// the guest's `wpk_fork_unwind_begin`. The returned launch root is published
/// in the forking thread's fork control word, where `handle_fork` reads it.
///
/// Returns what `kernel_fork` returns to the (now unwinding) guest: 0, or
/// `-errno` when the capture could not open, in which case nothing unwinds and
/// no `SYS_FORK` is posted.
fn begin_fork_capture(
    caller: &mut Caller<'_, ()>,
    fm: &ForkModule,
    mem: &SharedMemory,
    ch: usize,
) -> wasmtime::Result<i32> {
    fm.ref_identities.lock().unwrap().clear();
    fm.fm_capture_begin.call(&mut *caller, ())?;
    if let Some(guest_roots) = caller
        .get_export(wasm_posix_shared::abi::WPK_FORK_STATIC_ROOT_CATALOG_EXPORT)
        .and_then(|export| export.into_table())
    {
        fill_static_root_catalog(&mut *caller, fm, guest_roots).map_err(wasmtime::Error::msg)?;
    }
    let root = fm.fm_parent_begin_capture.call(&mut *caller, ch as u32)?;
    let errno = fm.fm_last_errno.call(&mut *caller, ())?;
    if errno != 0 {
        return Ok(-errno);
    }
    // SAFETY: the control word is inside the forking thread's own fork-save
    // page, which the process layout reserves below its channel.
    unsafe { write_bytes(mem, fork_control_word(ch), &root.to_le_bytes()) };
    Ok(0)
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
    set_thread_slot_quota: &wasmtime::TypedFunc<(u32, u32), i32>,
    set_brk_base: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_mmap_base: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_max_addr: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_pointer_width: &wasmtime::TypedFunc<(u32, u32), i32>,
    guest_module: Module,
    memory: SharedMemory,
    layout: ProcessLayout,
    pid: u32,
    import_exit_status: Arc<Mutex<Option<i32>>>,
    launch_argv: Arc<Vec<Vec<u8>>>,
    launch_env: Arc<Vec<Vec<u8>>>,
    use_fork_module: bool,
    fork_entry: ForkEntry,
    fork_format: Option<Arc<GuestForkFormat>>,
    fork_proof_of_use: Arc<Mutex<ForkProofOfUse>>,
    replacing_exec_image: bool,
) -> anyhow::Result<GuestProcess> {
    let scratch = KernelScratch::allocate(
        &*alloc_scratch,
        &mut *kernel_store,
        MIN_CHANNEL_SIZE as u32,
        "the process syscall channel",
    )?;
    let scratch_base = scratch.ptr() as u32 as usize;

    // N1-I4 Task 2 concern 3: when this process will co-reside a fork-module
    // (`use_fork_module`), the kernel's OWN `max_addr` ceiling for `pid` must
    // be the region's `memory_base` — STRICTLY below the module's reserved
    // static/BSS/shadow-stack region — never the plain `ProcessLayout::
    // max_addr` the module's placement math treats as the region's END. This
    // makes the reservation KERNEL-ENFORCED (see `instantiate_fork_module`'s
    // doc comment): the kernel's own brk/mmap allocator can then never hand
    // this process an address inside the module's region, even before any
    // fork ever happens and for BOTH the parent (this call, at its own
    // launch) and a fork child (this same function, called again from
    // `handle_fork`). `use_fork_module == false` (every test that predates
    // this increment) keeps the plain `layout.max_addr` ceiling, byte-for-
    // byte unchanged.
    //
    // Real vfork (N1 residual): this ceiling must additionally exclude the
    // SECOND, private region a future BORROWED vfork child's own co-resident
    // fork-module instance would need inside this SAME `SharedMemory` (see
    // `compute_vfork_borrowed_region`'s doc comment) — reserved here, up
    // front, for every `use_fork_module` process regardless of whether it
    // ever actually vforks.
    let max_addr = if use_fork_module {
        compute_vfork_borrowed_region(&layout)?.guest_ceiling
    } else {
        layout.max_addr
    };

    for (name, val) in [
        // POSIX: the program's own concurrent-thread ceiling. This host used
        // to report its arena size (16) instead, because a fixed arena was all
        // it could place; with placement in the kernel it honours the
        // declaration like the JavaScript hosts do. The kernel refuses a clone
        // past it with EAGAIN, before a tid exists, which is what POSIX
        // requires of a failed `pthread_create`. It bounds live threads only:
        // an exited thread stops counting the moment it is reaped.
        (
            "kernel_set_thread_slot_quota",
            set_thread_slot_quota
                .call(&mut *kernel_store, (pid, layout.thread_slot_count))?,
        ),
        ("kernel_set_brk_base", set_brk_base.call(&mut *kernel_store, (pid, layout.brk_base as i32))?),
        ("kernel_set_mmap_base", set_mmap_base.call(&mut *kernel_store, (pid, layout.brk_base as i32))?),
        ("kernel_set_max_addr", set_max_addr.call(&mut *kernel_store, (pid, max_addr as i32))?),
    ] {
        if val < 0 {
            anyhow::bail!("{name} failed: {val}");
        }
    }

    // B27a: register this process's data model, because the kernel parses
    // caller-native records for it and one kernel instance serves wasm32 and
    // wasm64 processes at once. The host contributes it at exactly the moment
    // an address space comes into being, because the host is what read the
    // program's bytes — the same contract `host/src/kernel-worker.ts` states
    // at its own `kernel_set_process_pointer_width` call.
    //
    // An exec re-launch deliberately does NOT re-register. `kernel_exec_
    // commit` has already replaced the width inside `exec_target::finish_
    // commit`, read from the incoming image's own artifact bytes before the
    // point of no return, and the kernel's process record survives the image
    // swap. Writing it again here would make the host a second authority over
    // the same question — harmless while the two agree, and silently resolved
    // in the host's favour the day they do not.
    //
    // A fork child DOES pass through here, and re-registering is correct
    // rather than redundant: it is a fresh address space this host just
    // created, from bytes this host just read, which is the same shape the
    // TypeScript hosts' own `registerProcess` has for a fork child. The width
    // it writes agrees with the one `kernel_fork_process` already inherited
    // through the fork state record, because both describe the same image.
    if !replacing_exec_image {
        let rc = set_pointer_width
            .call(&mut *kernel_store, (pid, u32::from(layout.pointer_width)))?;
        if rc < 0 {
            anyhow::bail!(
                "kernel_set_process_pointer_width(pid={pid}, width={}) failed: {rc}",
                layout.pointer_width
            );
        }
    }

    let main_handle = spawn_guest_thread(
        engine,
        guest_module.clone(),
        memory.clone(),
        layout,
        pid,
        import_exit_status,
        launch_argv,
        launch_env,
        use_fork_module,
        fork_entry,
        fork_format.clone(),
        fork_proof_of_use,
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
        thread_handles,
        fork_format,
        signal_killed: false,
    })
}

/// Real vfork (N1 residual): launch a BORROWED vfork child sharing the
/// parent's exact `SharedMemory` handle (never `clone_guest_memory`'s
/// private byte-copy) instead of `launch_process`'s "fresh, owned memory"
/// shape. Mirrors `launch_process` closely (same `alloc_scratch`/`kernel_
/// set_brk_base`/`kernel_set_mmap_base`/`kernel_set_max_addr` sequence,
/// same `spawn_guest_thread` call), but:
///   - brk/mmap bases are the PARENT's own unchanged values (real vfork
///     shares the whole address space, heap included);
///   - `max_addr` is `vregion.guest_ceiling` — the SAME numeric ceiling the
///     parent's own launch already enforced (a pure function of `parent_
///     layout`, so this pid's guest-visible ceiling matches the parent's
///     exactly, as real vfork requires);
///   - the channel offset and the fork-module's own `__memory_base` are
///     BOTH the child-private addresses `compute_vfork_borrowed_region`
///     reserved, never the parent's own (which would collide inside the
///     literally-shared memory).
///
/// The parent's own channel stays parked in `handle_fork`'s
/// [`ParkedForkParent`] record; the kernel decides when it completes.
#[allow(clippy::too_many_arguments)]
fn launch_vfork_borrowed_child(
    engine: &Engine,
    kernel_store: &mut Store<()>,
    alloc_scratch: &wasmtime::TypedFunc<u32, i32>,
    set_thread_slot_quota: &wasmtime::TypedFunc<(u32, u32), i32>,
    set_brk_base: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_mmap_base: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_max_addr: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_pointer_width: &wasmtime::TypedFunc<(u32, u32), i32>,
    guest_module: Module,
    guest_mem: SharedMemory,
    parent_layout: ProcessLayout,
    vregion: &VforkBorrowedRegion,
    pid: u32,
    fork_entry: ForkEntry,
    fork_format: Option<Arc<GuestForkFormat>>,
    fork_proof_of_use: Arc<Mutex<ForkProofOfUse>>,
) -> anyhow::Result<GuestProcess> {
    let scratch = KernelScratch::allocate(
        &*alloc_scratch,
        &mut *kernel_store,
        MIN_CHANNEL_SIZE as u32,
        "the forked process syscall channel",
    )?;
    let scratch_base = scratch.ptr() as u32 as usize;

    for (name, val) in [
        // POSIX: the program's own concurrent-thread ceiling. This host used
        // to report its arena size (16) instead, because a fixed arena was all
        // it could place; with placement in the kernel it honours the
        // declaration like the JavaScript hosts do. The kernel refuses a clone
        // past it with EAGAIN, before a tid exists, which is what POSIX
        // requires of a failed `pthread_create`. It bounds live threads only:
        // an exited thread stops counting the moment it is reaped.
        (
            "kernel_set_thread_slot_quota",
            set_thread_slot_quota
                .call(&mut *kernel_store, (pid, parent_layout.thread_slot_count))?,
        ),
        (
            "kernel_set_brk_base",
            set_brk_base.call(&mut *kernel_store, (pid, parent_layout.brk_base as i32))?,
        ),
        (
            "kernel_set_mmap_base",
            set_mmap_base.call(&mut *kernel_store, (pid, parent_layout.brk_base as i32))?,
        ),
        (
            "kernel_set_max_addr",
            set_max_addr.call(&mut *kernel_store, (pid, vregion.guest_ceiling as i32))?,
        ),
        // B27a: a borrowed vfork child is a FRESH kernel process record (its
        // pid came from `kernel_fork_process`) running the PARENT's image in
        // the parent's own memory, so its data model is the parent's, and it
        // is registered here for the same reason the sibling brk/mmap/max-addr
        // values are re-sent: this is a launch, not an exec re-registration.
        (
            "kernel_set_process_pointer_width",
            set_pointer_width
                .call(&mut *kernel_store, (pid, u32::from(parent_layout.pointer_width)))?,
        ),
    ] {
        if val < 0 {
            anyhow::bail!("{name} failed: {val}");
        }
    }

    let mut child_layout = parent_layout;
    child_layout.channel_offset = vregion.channel_offset;
    child_layout.max_addr = vregion.child_module_max_addr;

    let main_handle = spawn_guest_thread(
        engine,
        guest_module.clone(),
        guest_mem.clone(),
        child_layout,
        pid,
        Arc::new(Mutex::new(None)),
        Arc::new(Vec::new()),
        Arc::new(Vec::new()),
        true, // a borrowed vfork child always co-resides its own fork-module
        fork_entry,
        fork_format.clone(),
        fork_proof_of_use,
    );
    let mut thread_handles = HashMap::new();
    thread_handles.insert(child_layout.channel_offset, main_handle);

    Ok(GuestProcess {
        pid,
        module: guest_module,
        memory: guest_mem,
        scratch_base,
        layout: child_layout,
        channels: vec![PumpChannel { offset: child_layout.channel_offset, tid: pid, is_main: true }],
        thread_handles,
        fork_format,
        signal_killed: false,
    })
}

/// Instantiate the guest on a fresh OS thread and run it to `_start`. The
/// thread blocks inside `_start` on each syscall's `wait32`; the pump on the
/// kernel thread services them. The ordinary caller must not join it: the
/// pump does. When the kernel records the process's exit, and on
/// execve-success or spawn `-ECHILD` rollback, the pump publishes
/// `CH_TEARDOWN` on this thread's channel, notifies it, and joins the handle
/// (see `GuestProcess::thread_handles`); the guest traps on `CH_TEARDOWN` and
/// `run_fork_capable_entry` returns.
fn spawn_guest_thread(
    engine: &Engine,
    module: Module,
    guest_mem: SharedMemory,
    layout: ProcessLayout,
    pid: u32,
    import_exit_status: Arc<Mutex<Option<i32>>>,
    launch_argv: Arc<Vec<Vec<u8>>>,
    launch_env: Arc<Vec<Vec<u8>>>,
    use_fork_module: bool,
    fork_entry: ForkEntry,
    fork_format: Option<Arc<GuestForkFormat>>,
    fork_proof_of_use: Arc<Mutex<ForkProofOfUse>>,
) -> thread::JoinHandle<()> {
    let engine = engine.clone();
    thread::spawn(move || {
        let mut store = Store::new(&engine, ());
        let mut linker: Linker<()> = Linker::new(&engine);
        linker.define(&mut store, "env", "memory", guest_mem.clone()).unwrap();
        // The guest reads env.__channel_base to find the channel; provide it
        // as a mutable global holding the layout's channel offset, in the
        // guest's own index type — a wasm64 guest declares it `mut i64`, and a
        // 32-bit global does not satisfy that import.
        let channel_base = Global::new(
            &mut store,
            GlobalType::new(guest_index_type(layout.pointer_width), Mutability::Var),
            guest_index_val(layout.pointer_width, layout.channel_offset),
        )
        .unwrap();
        linker.define(&mut store, "env", "__channel_base", channel_base).unwrap();

        // N1-I4 Task 2: instantiate the co-resident fork-module in this SAME
        // `Store` as the guest instance about to be created below (a `Func`
        // can only be handed to `Linker::define` for the `Store` it was
        // created in), then bind every guest fork import from its exports
        // ([`bind_guest_fork_imports`]). This runs for EVERY process launched
        // with `use_fork_module` (the boot process, a spawned child, or a fork
        // child), so the parent side of a later fork already has this wiring
        // from its own launch. Kept alive past this block: the `kernel_fork`
        // import closure and the entry loop both drive its `fm_*` entries.
        let mut fork_module: Option<ForkModule> = None;
        // N1-I4 Task 3: shared coordinator state between `kernel_fork` and
        // the entry loop at the end of this function — see
        // `ForkCoordState`'s doc comment.
        let coord = ForkCoordState::new();
        if use_fork_module {
            let fm = match instantiate_fork_module(&engine, &mut store, &guest_mem, &layout) {
                Ok(fm) => fm,
                Err(e) => {
                    eprintln!("instantiate_fork_module failed: {e:#}");
                    return;
                }
            };
            if let Err(e) = bind_guest_fork_imports(&mut linker, &mut store, &module, &fm) {
                eprintln!("{e:#}");
                return;
            }
            // Seed this FRESH module instance's format and admit activation
            // 0, once, before any `fork()`. `fork_format` is `None` for a
            // non-instrumented guest: nothing to admit, and its `kernel_fork`
            // import never reaches the module (the direct-passthrough branch
            // below). A borrowed vfork child's control word is its parked
            // owner's, as `forkOwnerControlAddr` is on the JavaScript hosts.
            if let Some(fmt) = fork_format.as_ref() {
                use fork_codec::activation_admission::{
                    ADMISSION_FLAG_BORROWED_CHILD as BORROWED, ADMISSION_FLAG_FORK_CHILD as CHILD,
                };
                let own_control = fork_control_word(layout.channel_offset) as u32;
                let (flags, control) = match fork_entry {
                    ForkEntry::ChildReplay { .. } => (CHILD, own_control),
                    ForkEntry::ChildBorrowedReplay { owner_control, .. } => (CHILD | BORROWED, owner_control),
                    ForkEntry::Normal | ForkEntry::ChildPendingStub => (0, own_control),
                };
                if let Err(e) =
                    admit_guest(&mut store, &fm, &guest_mem, fmt, layout.channel_offset, control, flags)
                {
                    eprintln!("{e:#}");
                    return;
                }
            }
            fork_module = Some(fm);
        }

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
        // B27b: `char *buf` is the guest's own pointer type, so these two
        // imports are declared `(i32 i32 i32) -> i32` by a wasm32 guest and
        // `(i32 i64 i32) -> i32` by a wasm64 one. Wasmtime matches import
        // types exactly, so the host must define the arm the loaded image
        // actually declares rather than one shape for both.
        {
            let argv = launch_argv.clone();
            let mem = guest_mem.clone();
            if layout.pointer_width == 8 {
                linker
                    .func_wrap(
                        "kernel",
                        "kernel_argv_read",
                        move |_c: Caller<'_, ()>, index: u32, buf_ptr: i64, buf_max: u32| -> i32 {
                            copy_launch_entry(&mem, &argv, index, buf_ptr as u64, buf_max)
                        },
                    )
                    .unwrap();
            } else {
                linker
                    .func_wrap(
                        "kernel",
                        "kernel_argv_read",
                        move |_c: Caller<'_, ()>, index: u32, buf_ptr: i32, buf_max: u32| -> i32 {
                            copy_launch_entry(&mem, &argv, index, buf_ptr as u32 as u64, buf_max)
                        },
                    )
                    .unwrap();
            }
        }
        {
            let env = launch_env.clone();
            let mem = guest_mem.clone();
            if layout.pointer_width == 8 {
                linker
                    .func_wrap(
                        "kernel",
                        "kernel_environ_get",
                        move |_c: Caller<'_, ()>, index: u32, buf_ptr: i64, buf_max: u32| -> i32 {
                            copy_launch_entry(&mem, &env, index, buf_ptr as u64, buf_max)
                        },
                    )
                    .unwrap();
            } else {
                linker
                    .func_wrap(
                        "kernel",
                        "kernel_environ_get",
                        move |_c: Caller<'_, ()>, index: u32, buf_ptr: i32, buf_max: u32| -> i32 {
                            copy_launch_entry(&mem, &env, index, buf_ptr as u32 as u64, buf_max)
                        },
                    )
                    .unwrap();
            }
        }
        linker.func_wrap("kernel", "kernel_get_secure_exec", || -> i32 { 0 }).unwrap();
        linker.func_wrap("kernel", "kernel_is_fork_child", || -> i32 { 0 }).unwrap();
        // The SIGKILL-only fast-path import. A normal exit never calls it; if it
        // ever fires, record the status and trap to unwind _start.
        {
            let status = import_exit_status.clone();
            linker
                .func_wrap("kernel", "kernel_exit", move |_c: Caller<'_, ()>, s: i32| -> wasmtime::Result<()> {
                    *status.lock().unwrap() = Some(s);
                    Err(wasmtime::Error::msg(format!("kernel_exit({s})")))
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
        // kernel_fork (N1-I4 Task 2): `fork()`/`vfork()`/`_Fork()` call this
        // import DIRECTLY (`libc/glue/channel_syscall.c:492-493,577-600),
        // never through the generic channel dispatcher (`__do_syscall_impl`
        // explicitly returns ENOSYS for `SYS_FORK`/`SYS_VFORK`) — this keeps
        // wasm-fork-instrument's call-graph rewriting scoped to fork callers
        // alone, per that file's own module doc comment. Mirrors
        // `kernel_clone` immediately above: post `SYS_FORK`/`SYS_VFORK` +
        // `mode` on THIS channel (this import is only ever reached from the
        // process's main thread — a worker-thread `fork()` is not wired up
        // by this host and traps, unchanged from before this task) and block
        // for the pump's `handle_fork` (N1-I4 Task 2) to create the child and
        // report back. Unlike `kernel_clone`'s tid, the value this import
        // returns is used DIRECTLY as `kernel_fork`'s own C-level return —
        // `__do_syscall_impl`'s generic "ret<0 -> -errno" post-processing
        // never runs for a direct import call, so apply that SAME convention
        // here explicitly, exactly like `kernel_wait4` below.
        //
        // N1-I4 Task 3: for a FORK-INSTRUMENTED guest (`fork_format.is_some()`
        // — i.e. `fork_module` was seeded above), this import no longer does
        // the whole round trip itself. Its two reachable phases
        // (`ForkCoordState::phase`):
        //
        //  - `Idle` (the first call, straight from the guest's own `fork()`
        //    wrapper, still mid-stack): starts capture ([`begin_fork_capture`],
        //    which has the module drive the guest's OWN
        //    `wpk_fork_unwind_begin(root)`, flipping it to UNWINDING) — and
        //    returns `0` immediately WITHOUT posting anything on the
        //    channel. Per `wasm-fork-instrument`'s contract (see this file's
        //    "N1-I4 Task 1" section doc comment and `crates/fork-instrument/
        //    src/instrument.rs`'s `populate_lexical_call` doc comment), the
        //    guest's OWN postamble at THIS call site sees `_wpk_fork_state
        //    == UNWINDING` upon return and starts unwinding the REAL,
        //    already-live call chain itself (spilling each frame into the
        //    fork-module via the already-wired `__wpk_fork_frame_*`
        //    imports), eventually escaping the OS thread's outer `_start`
        //    call as an uncaught `env.__wpk_fork_unwind` exception —
        //    `run_fork_capable_entry`'s loop catches that, drives the
        //    seal/serialize/channel-post/parent-replay-begin sequence, and
        //    only THEN re-enters this instance via `wpk_fork_resume_start`.
        //  - `Replaying` (a SECOND call, reached by that resume-table
        //    dispatch walking back down to this exact call site — see
        //    `ForkCoordPhase`'s doc comment): the rewind of frame STATE is
        //    already done by this point, so this closes it out —
        //    `wpk_fork_rewind_end` (flips `_wpk_fork_state` back to NORMAL)
        //    then `fm_finish_replay` — and returns the REAL value (child pid
        //    for the parent, `0` for the child, or a negative errno)
        //    `run_fork_capable_entry` recorded in `coord.fork_result`.
        //
        // For a NON-instrumented guest (`fork_module` is `None` or
        // `fork_format` was `None`, so `fork_module` was never seeded with a
        // format), this import keeps the OLD direct-passthrough behavior
        // byte-for-byte: post `SYS_FORK`/`SYS_VFORK` on the channel and
        // block for `handle_fork`'s reply — there is no coordinator to
        // drive, so the reply IS the whole answer.
        {
            let mem = guest_mem.clone();
            let ch = layout.channel_offset;
            let fm_for_import = fork_module.clone();
            let has_format = fork_format.is_some();
            let coord = Arc::clone(&coord);
            linker
                .func_wrap(
                    "kernel",
                    "kernel_fork",
                    move |mut caller: Caller<'_, ()>, mode: i32| -> wasmtime::Result<i32> {
                        let Some(fm) = (if has_format { fm_for_import.as_ref() } else { None }) else {
                            let syscall_nr = if mode as u32 == MODE_VFORK { SYS_VFORK } else { SYS_FORK };
                            unsafe {
                                write_bytes(&mem, ch + SYSCALL_OFFSET, &syscall_nr.to_le_bytes());
                                write_bytes(&mem, ch + ARGS_OFFSET, &(mode as i64).to_le_bytes());
                                for i in 1..6 {
                                    write_bytes(&mem, ch + ARGS_OFFSET + i * ARG_SIZE, &0i64.to_le_bytes());
                                }
                                write_bytes(&mem, ch + REQUEST_FLAGS_OFFSET, &0u32.to_le_bytes());
                                atomic_u32(&mem, ch + STATUS_OFFSET).store(STATUS_PENDING, Ordering::SeqCst);
                            }
                            let _ = mem.atomic_notify((ch + STATUS_OFFSET) as u64, 1);
                            loop {
                                let s = unsafe { atomic_u32(&mem, ch + STATUS_OFFSET) }.load(Ordering::SeqCst);
                                if s == ChannelStatus::Teardown as u32 {
                                    // The kernel ended this process while it
                                    // was parked in fork: unwind, as the glue
                                    // does, instead of reading a stale reply.
                                    return Err(wasmtime::Trap::UnreachableCodeReached.into());
                                }
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
                            return Ok(if ret < 0 { -(errno as i32) } else { ret as i32 });
                        };

                        match coord.phase() {
                            ForkCoordPhase::Idle => {
                                coord.set_mode(mode as u32);
                                coord.set_abort_replay(false);
                                begin_fork_capture(&mut caller, fm, &mem, ch)
                            }
                            ForkCoordPhase::Replaying => {
                                // Coarse replay-finish: ONE module call drives the
                                // guest's `wpk_fork_rewind_end()` (normal replay) or
                                // `wpk_fork_abort_end()` (abort replay — a gated or
                                // failed-launch fork) then finishes the process replay,
                                // folding the former `caller_export_typed(REWIND_END)` +
                                // direct call + `fm_finish_replay`. The entry loop
                                // recorded which via `coord.is_abort_replay()`.
                                let abort = coord.is_abort_replay();
                                fm.fm_parent_finish.call(&mut caller, u32::from(abort))?;
                                let errno = fm.fm_last_errno.call(&mut caller, ())?;
                                if errno != 0 {
                                    return Err(wasmtime::Error::msg(format!(
                                        "fm_parent_finish failed: errno {errno}"
                                    )));
                                }
                                coord.set_abort_replay(false);
                                coord.set_phase(ForkCoordPhase::Idle);
                                Ok(coord.fork_result())
                            }
                        }
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
        // B27b: `const char *path` is the guest's own pointer type, so a
        // wasm64 guest declares this `(i64 i32) -> i32`. The body ignores
        // both arguments, but the DECLARED type still has to match or the
        // instantiation fails.
        if layout.pointer_width == 8 {
            linker
                .func_wrap(
                    "kernel",
                    "kernel_execve",
                    |_c: Caller<'_, ()>, _path_ptr: i64, _path_len: i32| -> i32 { -(libc_errno::ENOSYS) },
                )
                .unwrap();
        } else {
            linker
                .func_wrap(
                    "kernel",
                    "kernel_execve",
                    |_c: Caller<'_, ()>, _path_ptr: i32, _path_len: i32| -> i32 { -(libc_errno::ENOSYS) },
                )
                .unwrap();
        }
        // The test-only host-object source and probes the reference fork
        // fixtures declare (see `define_host_externref_source`). No real
        // program declares any of them, so this is a no-op for every other
        // guest. Every `__wpk_fork_*` import was bound from the fork module
        // above ([`bind_guest_fork_imports`]).
        let guest_declares = |name: &str| module.imports().any(|i| i.module() == "env" && i.name() == name);
        let probes: [(&str, fn(&mut Linker<()>) -> anyhow::Result<()>); 3] = [
            ("native_test_host_externref", define_host_externref_source),
            ("native_test_externref_payload", define_externref_payload_probe),
            ("native_test_funcref_call", define_funcref_call_probe),
        ];
        for (name, define) in probes {
            if guest_declares(name) {
                if let Err(e) = define(&mut linker) {
                    eprintln!("wiring env.{name} failed: {e:#}");
                    return;
                }
            }
        }

        // The fork-exec import set is imported but never reached on this
        // (non-forking) path; a trap is the truthful boundary.
        linker.define_unknown_imports_as_traps(&module).unwrap();
        // N1-I4 Task 3: a real ABI-43+ fork-instrumented guest unconditionally
        // imports a much larger surface than the 5 frame imports + unwind tag
        // + resume table this function wires explicitly above — the FULL
        // module-state save/restore family (`__wpk_fork_module_state_*`) and
        // the reference/exception routing family (`__wpk_fork_ref_gc_*`/
        // `__wpk_fork_ref_exn_*`), declared once per program regardless of
        // whether it ever actually captures a reference. Every FUNCTION
        // import in those families is already covered by `define_unknown_
        // imports_as_traps` just above (frames-only must never actually call
        // one — see this file's "N1-I4 Task 1" section doc comment and
        // `ForkProofOfUse`'s), but a handful of NON-function imports remain
        // unresolved after that call: `env.__wpk_fork_ref_gc_transit` (a
        // table) and `env.__wpk_fork_module_activation`/`env.__wpk_fork_
        // module_state_table_generation_addr` (globals) — `Linker::define_
        // unknown_imports_as_traps` only ever handles `ExternType::Func`
        // (traps have no meaning for a table/global import: there is no
        // "call" to intercept), so those three still need SOME value.
        // `define_unknown_imports_as_default_values` fills in exactly the
        // imports still unresolved at this point (every function AND
        // `env.__wpk_fork_resume_table`, wired for real above, are already
        // defined, so this touches only those three) with the zero/null
        // value for their declared type. This is the platform boundary this
        // task accepts as-is rather than second-guessing: a single-
        // activation, no-reference, no-dlopen fork never reads `env.__wpk_
        // fork_ref_gc_transit`/the two globals for real, and a resume path
        // that actually needed a real value here would fail loudly (a trap
        // or an observably wrong resume) rather than silently — exactly the
        // truthful-failure contract `smoke_fork_parent_child`'s full
        // assertions and `fm_last_errno` checks are there to catch.
        linker.define_unknown_imports_as_default_values(&mut store, &module).unwrap();

        let instance = match linker.instantiate(&mut store, &module) {
            Ok(i) => i,
            Err(e) => {
                eprintln!("guest instantiate failed: {e}");
                return;
            }
        };

        // Bind the admitted activation now that its instance exists: the
        // guest's own `__wpk_fork_resume_catalog` and catalog tables do not
        // exist until instantiation completes, so this MUST run after
        // `linker.instantiate` and BEFORE `run_fork_capable_entry` calls the
        // bootstrap/`_start`/`wpk_fork_resume_start` exports that
        // `call_indirect` through the resume table. See [`bind_activation`].
        //
        // Then populate the co-resident module's imported reference-carrying
        // tables from THIS GUEST's own exports, at the bases the row gives --
        // mirrors `worker-main.ts`'s catalog sink and static-root mirror.
        // Every export is looked up optionally: a non-instrumented fixture
        // declares none of them, and is never admitted or bound.
        if let (Some(fm), Some(_)) = (fork_module.as_ref(), fork_format.as_ref()) {
            let row = match bind_activation(&mut store, fm, &instance, &guest_mem) {
                Ok(row) => row,
                Err(e) => {
                    eprintln!("binding activation 0 failed: {e:#}");
                    return;
                }
            };
            // -- Funcref catalog mirror -------------------------------------
            if let Some(guest_catalog) = instance.get_table(&mut store, "__wpk_fork_function_catalog") {
                let len = guest_catalog.size(&mut store);
                let base = u64::from(row.func_catalog_base);
                let grow = (base + len).saturating_sub(fm.function_catalog_table.size(&store));
                if len > 0 {
                    if let Err(e) = fm.function_catalog_table.grow(&mut store, grow, Ref::Func(None)) {
                        eprintln!("growing fork-module __wpk_fork_function_catalog failed: {e:#}");
                        return;
                    }
                    for i in 0..len {
                        match guest_catalog.get(&mut store, i) {
                            Some(v @ Ref::Func(_)) => {
                                if let Err(e) = fm.function_catalog_table.set(&mut store, base + i, v) {
                                    eprintln!(
                                        "populating fork-module __wpk_fork_function_catalog[{i}] failed: {e:#}"
                                    );
                                    return;
                                }
                            }
                            Some(other) => {
                                eprintln!(
                                    "guest __wpk_fork_function_catalog[{i}] is {other:?}, not a funcref"
                                );
                                return;
                            }
                            None => {
                                eprintln!("guest __wpk_fork_function_catalog[{i}] is out of bounds");
                                return;
                            }
                        }
                    }
                }
            }

            // -- Static-root catalog (activation 0 only) ----------------------
            // The guest's OWN `__wpk_fork_static_root_catalog` export is a
            // harvest BUFFER, filled by the guest's
            // `__wpk_fork_static_root_harvest` export exactly once, right after
            // instantiation and before any other guest code runs -- which is
            // where this block sits. The module's merged catalog is then filled
            // from it here, for a fork child's install, and again before every
            // capture ([`begin_fork_capture`]).
            if let Some(guest_roots) =
                instance.get_table(&mut store, wasm_posix_shared::abi::WPK_FORK_STATIC_ROOT_CATALOG_EXPORT)
            {
                if guest_roots.size(&mut store) > 0 {
                    let Ok(harvest) = instance.get_typed_func::<(), ()>(
                        &mut store,
                        wasm_posix_shared::abi::WPK_FORK_STATIC_ROOT_HARVEST_EXPORT,
                    ) else {
                        eprintln!(
                            "guest declares a non-empty {} but is missing/mistyped {}",
                            wasm_posix_shared::abi::WPK_FORK_STATIC_ROOT_CATALOG_EXPORT,
                            wasm_posix_shared::abi::WPK_FORK_STATIC_ROOT_HARVEST_EXPORT
                        );
                        return;
                    };
                    if let Err(e) = harvest.call(&mut store, ()) {
                        eprintln!(
                            "{} failed: {e:#}",
                            wasm_posix_shared::abi::WPK_FORK_STATIC_ROOT_HARVEST_EXPORT
                        );
                        return;
                    }
                    fm.static_root_base.store(row.static_root_base, Ordering::SeqCst);
                    if let Err(e) = fill_static_root_catalog(&mut store, fm, guest_roots) {
                        eprintln!("{e:#}");
                        return;
                    }
                }
            }
        }

        run_fork_capable_entry(
            &mut store,
            &instance,
            &guest_mem,
            layout.channel_offset,
            fork_module.as_ref(),
            &coord,
            pid,
            fork_entry,
        );

        // N1-I4 Task 3: fold this thread's fork-module proof-of-use counters
        // into the shared accumulator — see `ForkProofOfUse`'s doc comment.
        // Best-effort (a `fm_*_reconstructed` call failing here is not this
        // thread's problem to report; `run_fork_capable_entry` already
        // reported everything that could go wrong with the coordinator
        // itself) and additive, never overwriting: a `run_guest` call may
        // instantiate many fork-module instances (boot + every descendant),
        // each with its OWN, independent counters that all start at `0`.
        if let Some(fm) = fork_module.as_ref() {
            let mut acc = fork_proof_of_use.lock().unwrap();
            fold_fork_proof_of_use(fm, &mut store, &mut acc);
        }
    })
}

/// Read a guest export by name and check it against `Params`/`Results` via
/// [`wasmtime::Instance::get_typed_func`], logging and returning `None` on
/// any failure (missing export, wrong signature) instead of panicking. Used
/// by [`run_fork_capable_entry`], which has direct `Instance`/`Store` access.
fn get_guest_export_typed<Params, Results>(
    store: &mut Store<()>,
    instance: &wasmtime::Instance,
    name: &str,
) -> Option<wasmtime::TypedFunc<Params, Results>>
where
    Params: wasmtime::WasmParams,
    Results: wasmtime::WasmResults,
{
    match instance.get_typed_func::<Params, Results>(&mut *store, name) {
        Ok(f) => Some(f),
        Err(e) => {
            eprintln!("guest missing/mistyped export {name}: {e:#}");
            None
        }
    }
}

/// Whether a Wasmtime error represents an uncaught Wasm exception escaping a
/// call into the guest (`wasmtime::ThrownException` — NOT `Trap::
/// UnhandledTag`, a DIFFERENT error shape reserved for the stack-switching/
/// continuations proposal; Wasmtime 48's exceptions-proposal implementation
/// stores the actual pending exception object on the `Store` itself — see
/// `Store::take_pending_exception`, called at this function's one call site
/// — and returns this zero-payload marker error from the call, per `wasmtime
/// ::exception::ThrownException`'s own doc comment). This is the shape an
/// escaped `env.__wpk_fork_unwind` throw takes once it propagates all the
/// way out of the guest's outer `_start` call (see `kernel_fork`'s `Idle`
/// branch's doc comment for why this is the expected, deliberate way a fresh
/// fork capture surfaces to the host, not a bug). Wasmtime does not
/// distinguish WHICH tag was thrown at this level (that requires inspecting
/// the taken `ExnRef`'s own tag, which this frames-only task does not do —
/// see [`run_fork_capable_entry`]'s call site for why), so that function
/// additionally requires this to be seen only straight after the LEXICAL
/// `_start` entry (never during a replay/resume call) before treating it as
/// a fork capture.
fn is_thrown_exception_escape(e: &wasmtime::Error) -> bool {
    e.downcast_ref::<wasmtime::ThrownException>().is_some()
}

/// Whether this worker's fork module has a capture open -- `PHASE_CAPTURE` in
/// `crates/fork-module/src/lib.rs`, the phase `fm_parent_begin_capture`
/// enters and the seal leaves.
fn in_fork_capture(store: &mut Store<()>, fork_module: Option<&ForkModule>) -> bool {
    const FORK_MODULE_PHASE_CAPTURE: u32 = 1;
    fork_module.is_some_and(|fm| fm.fm_phase.call(&mut *store, ()).ok() == Some(FORK_MODULE_PHASE_CAPTURE))
}

/// N1-I4 Task 3: drive one guest OS thread (either a fresh, `_start`-from-the-
/// top launch, or a fork child's `fm_child_install`-seeded resume) to
/// completion, transparently handling however many `fork()`s it makes along
/// the way. Replaces Task 2's unconditional `let _ = start.call(...)` (and
/// its `fork_child_pending_replay` stub, still used for a NON-instrumented
/// guest — see [`ForkEntry::ChildPendingStub`]'s doc comment).
///
/// The loop alternates between the guest's LEXICAL entry (`_start`, called
/// exactly once, only for [`ForkEntry::Normal`]) and its instrumented
/// `wpk_fork_resume_start` export (called every time execution must
/// re-enter after a fork: once per capture the lexical entry made, seeded by
/// [`drive_fork_capture_seal_and_launch_child`]'s `fm_parent_replay` for a
/// PARENT, or once up front, seeded by this function's own `fm_child_install`
/// call, for a fresh fork child). Either call
/// blocks until the guest parks after `exit_group` (normal — the loop
/// returns), traps via the `kernel_exit` SIGKILL fast path or a normal
/// `unreachable` halt (also normal — the loop returns), or escapes with an
/// uncaught `env.__wpk_fork_unwind` exception ([`is_unhandled_tag_trap`]) —
/// the ONLY case the loop continues on, by driving the seal/serialize/
/// channel-post/parent-replay-begin sequence before looping back to call
/// `wpk_fork_resume_start`.
fn run_fork_capable_entry(
    store: &mut Store<()>,
    instance: &wasmtime::Instance,
    guest_mem: &SharedMemory,
    channel_offset: usize,
    fork_module: Option<&ForkModule>,
    coord: &Arc<ForkCoordState>,
    pid: u32,
    fork_entry: ForkEntry,
) {
    if matches!(fork_entry, ForkEntry::ChildPendingStub) {
        // N1-I4 Task 2's legacy stub — see `ForkEntry::ChildPendingStub`'s
        // doc comment for why this path still exists and why running this
        // copied program's `_start` here would be a fork bomb.
        post_fork_child_pending_exit(guest_mem, channel_offset);
        return;
    }

    let Some(start) = get_guest_export_typed::<(), ()>(&mut *store, instance, "_start") else {
        return;
    };
    // A non-instrumented guest has no `wpk_fork_resume_start` export at all
    // (its `kernel_fork` import, if it even has one, never reaches
    // `ForkCoordPhase::Replaying` — see that closure's doc comment) — that
    // is fine as long as this loop never actually needs to call it (i.e.
    // `fork_entry` is `Normal` and the guest never captures a fork). Missing
    // is therefore NOT logged as an error here; a later attempt to actually
    // USE it (below) is.
    let resume_start = instance
        .get_typed_func::<(), ()>(&mut *store, wasm_posix_shared::abi::WPK_FORK_EXPORT_RESUME_START)
        .ok();

    // N1-I4 Task 3 (bootstrap fix): `wasm-fork-instrument` converts every
    // ACTIVE element/data segment on an instrumented guest to PASSIVE and
    // defers their initialization into an EXPORTED bootstrap function — the
    // module has no `start` function of its own after instrumentation (see
    // `crates/fork-instrument/src/module_state.rs`'s `inject`/`emit_
    // bootstrap_helper`/`emit_thread_bootstrap_helper`). Node/browser call
    // this exact export, once, straight after instantiation and BEFORE the
    // guest's own entry point (`host/src/worker-main.ts:4714` before `_start`
    // at `:5036`; `:6898` for a fresh-table thread/child instance) — this
    // host must too, or the guest's own `__indirect_function_table` (and any
    // `.data`/`.rodata`) is never populated, and the FIRST `call_indirect`
    // (or first read of static data) traps. `ForkEntry::Normal` gets a
    // brand-new instance whose linear memory + tables need FULL init (data
    // copy + table.init + the guest's real, original `main`-reaching start
    // logic) — `WPK_FORK_EXPORT_MODULE_BOOTSTRAP`. `ForkEntry::ChildReplay`
    // gets a FRESH instance too, but one whose linear memory is a byte-for-
    // byte private copy of an ALREADY-bootstrapped parent (so its `.data`/
    // `.rodata` are already correct) with brand-new, EMPTY instance-local
    // tables — `WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP` re-inits just the
    // tables (and `DataDrop`s the now-redundant data segments) without
    // re-copying memory or re-running the original start, exactly matching
    // `worker-main.ts:6898`'s thread/child-instance variant.
    //
    // A NON-instrumented guest exports NEITHER name, so
    // `get_typed_func(...).ok()` simply finds nothing and this is a byte-
    // for-byte no-op for it — this is what keeps every pre-existing,
    // non-instrumented test (and the `ChildPendingStub` legacy path, handled
    // above before this point is ever reached) unaffected, without needing
    // to thread `fork_format`/"is this guest instrumented" down into this
    // function at all: the guest's own export list is the ground truth.
    let bootstrap_export = match fork_entry {
        ForkEntry::Normal => wasm_posix_shared::abi::WPK_FORK_EXPORT_MODULE_BOOTSTRAP,
        // A borrowed vfork child is ALSO a fresh instance over the (shared)
        // memory — same "empty instance-local tables" shape as an ordinary
        // COW `ChildReplay`, just borrowing rather than owning the bytes.
        ForkEntry::ChildReplay { .. } | ForkEntry::ChildBorrowedReplay { .. } => {
            wasm_posix_shared::abi::WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP
        }
        ForkEntry::ChildPendingStub => unreachable!("handled above"),
    };
    if let Ok(bootstrap) = instance.get_typed_func::<(), ()>(&mut *store, bootstrap_export) {
        if let Err(e) = bootstrap.call(&mut *store, ()) {
            eprintln!("{bootstrap_export} failed: {e:#}");
            return;
        }
    }

    let mut entry_is_lexical = true;
    // A fork child installs with ONE module call, as on the Node/browser host
    // (`installChild` in `host/src/fork-module-backend.ts`): the module reads
    // the arena root out of the launch root's prefix, publishes a COW child's
    // launch root in its own control word, carves a borrowed child's
    // workspace, seeds, attaches (module-state restore and finish included),
    // drives the install plan -- growing its own transit table first -- and
    // nulls the merged static-root catalog the drive read. What stays this
    // host's is done before: binding the drive slots and filling that catalog.
    let (launch_root, borrowed_base, borrowed_bytes) = match fork_entry {
        ForkEntry::ChildReplay { root } => (Some(root), 0, 0),
        // `compute_vfork_borrowed_region` reserves exactly one page below the
        // child's private channel for the workspace: where it is and how big
        // are the only facts about it the module cannot derive.
        ForkEntry::ChildBorrowedReplay { root, private_prefix, .. } => {
            (Some(root), private_prefix, WASM_PAGE_SIZE as u32)
        }
        ForkEntry::Normal | ForkEntry::ChildPendingStub => (None, 0, 0),
    };
    if let Some(root) = launch_root {
        let Some(fm) = fork_module else {
            eprintln!("fork child replay requested with no fork-module");
            return;
        };
        match fm.fm_child_install.call(&mut *store, (pid, root, borrowed_base, borrowed_bytes)) {
            Ok(0) => {}
            Ok(errno) => {
                eprintln!("fm_child_install failed: errno {errno}");
                return;
            }
            // A trap inside the install is the guest's own restore or rewind
            // faulting: report it like any other guest fault, so the parent's
            // wait(2) learns the child is gone instead of hanging.
            Err(e) => {
                match wasmtime_trap_kind(&e) {
                    Some(kind) => report_guest_fault(guest_mem, channel_offset, kind, &e),
                    None => eprintln!("fm_child_install failed: {e:#}"),
                }
                return;
            }
        }
        coord.set_phase(ForkCoordPhase::Replaying);
        coord.set_fork_result(0);
        entry_is_lexical = false;
    }

    loop {
        let result = if entry_is_lexical {
            start.call(&mut *store, ())
        } else {
            match resume_start.as_ref() {
                Some(f) => f.call(&mut *store, ()),
                None => {
                    eprintln!(
                        "guest is missing {} for a required fork replay",
                        wasm_posix_shared::abi::WPK_FORK_EXPORT_RESUME_START
                    );
                    return;
                }
            }
        };
        match result {
            Ok(()) => return,
            // An `unreachable` trap is either the host unwinding this thread
            // on purpose or the guest faulting, and this loop must not guess
            // which. It asks the channel, as `worker-main.ts` asks
            // `kernelExitStatus` before treating the trap as an exit:
            //
            //  * `CH_TEARDOWN` on this thread's channel: the pump has already
            //    decided this process's fate and woke the thread to unwind
            //    it. It does that after the kernel records the process's exit
            //    (`run_pump`'s exit branch — the native form of JS's
            //    `kernel_exit` returning once the exit is committed) and when
            //    it reclaims a superseded image (execve success, spawn
            //    rollback — the native form of JS's `ExecRetirement`). The
            //    glue's `__builtin_trap()` is that unwind. Nothing to report,
            //    and posting on the channel would race the pump's join.
            //  * Anything else: the guest executed `unreachable` itself. That
            //    is a fault, reported as SIGILL through the kernel exactly as
            //    the arm below reports every other trap kind.
            Err(e) if is_unreachable_trap(&e) => {
                let channel_status =
                    unsafe { atomic_u32(guest_mem, channel_offset + STATUS_OFFSET) }
                        .load(Ordering::SeqCst);
                if channel_status != ChannelStatus::Teardown as u32 {
                    report_guest_fault(
                        guest_mem,
                        channel_offset,
                        WasmTrapKind::IllegalInstruction,
                        &e,
                    );
                }
                return;
            }
            Err(e) if is_thrown_exception_escape(&e) => {
                // Only a fork's capture unwind may escape, and the MODULE says
                // whether one is open -- `worker-main.ts` asks the same
                // question (`forkPhase`). Asking which entry was running
                // instead refused a fork child that forks again: its capture
                // unwinds out of its replay entry. Anything else escaping is
                // a genuine bug or a foreign (non-fork) exception.
                if !in_fork_capture(store, fork_module) {
                    eprintln!("unexpected exception escape outside a fork capture: {e:#}");
                    return;
                }
                // Consume the pending exception the `Store` is holding
                // rooted (per `ThrownException`'s own doc comment: "the
                // caller should either continue propagating the error
                // upward, or take and handle the exception"). This task does
                // not inspect the taken `ExnRef`'s own tag (frames-only has
                // exactly one possible escaping tag in practice, `env.
                // __wpk_fork_unwind`); it only clears the slot so it cannot
                // leak into and confuse a later, unrelated call.
                if store.take_pending_exception().is_none() {
                    eprintln!(
                        "is_thrown_exception_escape matched but the store has no pending \
                         exception to take — this should not happen"
                    );
                }
                let Some(fm) = fork_module else {
                    eprintln!("fork-unwind exception escaped with no fork-module");
                    return;
                };
                if !drive_fork_capture_seal_and_launch_child(store, guest_mem, channel_offset, fm, coord) {
                    return;
                }
                entry_is_lexical = false;
            }
            Err(e) => {
                match wasmtime_trap_kind(&e) {
                    Some(kind) => report_guest_fault(guest_mem, channel_offset, kind, &e),
                    None => eprintln!("guest entry failed: {e:#}"),
                }
                return;
            }
        }
    }
}

/// N1-I4 Task 3: runs once, from the entry loop, right after the guest's
/// lexical call escapes with an uncaught `env.__wpk_fork_unwind` exception --
/// i.e. right after `kernel_fork`'s `Idle` branch began the capture
/// ([`begin_fork_capture`]) and the guest's own instrumented postambles spilled
/// every live frame, and every reference it held, into the fork module while
/// unwinding the real call stack back out to this point. The same sequence
/// `worker-main.ts` runs at the same point:
///
///  1. `fm_parent_seal_capture` -- drives the guest's `wpk_fork_unwind_end`,
///     seals the capture into the module's own arena and serializes the
///     child-inheritable journal image, all in the still parent-owned memory
///     the child's copy is taken from.
///  2. The real `SYS_FORK`/`SYS_VFORK` channel post (mode from `coord.mode`).
///     `handle_fork` reads the launch root [`begin_fork_capture`] published in
///     this thread's fork control word; this blocks until the kernel answers
///     the parent: the child's pid, or a negative errno.
///  3. `fm_parent_replay` -- begins the parent's own rewind, so the caller's
///     next `wpk_fork_resume_start` walks back down to the `fork()` call site
///     and re-enters `kernel_fork` at `Replaying` for `coord.fork_result`.
///
/// A seal that fails -- a reference the platform cannot carry (`EOPNOTSUPP`,
/// externref stage E2) or an allocation failure -- creates no child: the
/// parent's committed frames are abort-replayed and its `fork()` returns
/// `-errno`, as `worker-main.ts` does on `ContinuationAllocationError`. So does
/// a kernel refusal of the child.
///
/// Returns `false` (having already logged the truthful failure) when a module
/// call fails outright; the caller then ends this OS thread without calling
/// `wpk_fork_resume_start` -- at that point there is no honest way to resume.
fn drive_fork_capture_seal_and_launch_child(
    store: &mut Store<()>,
    guest_mem: &SharedMemory,
    ch: usize,
    fm: &ForkModule,
    coord: &Arc<ForkCoordState>,
) -> bool {
    let sealed = fm
        .fm_parent_seal_capture
        .call(&mut *store, ch as u32)
        .and_then(|_image| fm.fm_last_errno.call(&mut *store, ()));
    let fork_result = match sealed {
        Ok(0) => {
            let mode = coord.mode();
            let syscall_nr = if mode == MODE_VFORK { SYS_VFORK } else { SYS_FORK };
            unsafe {
                write_bytes(guest_mem, ch + SYSCALL_OFFSET, &syscall_nr.to_le_bytes());
                write_bytes(guest_mem, ch + ARGS_OFFSET, &(mode as i64).to_le_bytes());
                for i in 1..6 {
                    write_bytes(guest_mem, ch + ARGS_OFFSET + i * ARG_SIZE, &0i64.to_le_bytes());
                }
                write_bytes(guest_mem, ch + REQUEST_FLAGS_OFFSET, &0u32.to_le_bytes());
                atomic_u32(guest_mem, ch + STATUS_OFFSET).store(STATUS_PENDING, Ordering::SeqCst);
            }
            let _ = guest_mem.atomic_notify((ch + STATUS_OFFSET) as u64, 1);
            loop {
                let s = unsafe { atomic_u32(guest_mem, ch + STATUS_OFFSET) }.load(Ordering::SeqCst);
                if s == ChannelStatus::Teardown as u32 {
                    // The kernel ended this process while it was parked in fork
                    // (a fatal signal, or a vfork containment): end this thread
                    // without resuming guest code.
                    return false;
                }
                if s != STATUS_PENDING {
                    break;
                }
                std::thread::sleep(Duration::from_micros(200));
            }
            let (ret, errno) =
                unsafe { (read_i64(guest_mem, ch + RETURN_OFFSET), read_u32(guest_mem, ch + ERRNO_OFFSET)) };
            unsafe {
                atomic_u32(guest_mem, ch + STATUS_OFFSET).store(STATUS_IDLE, Ordering::SeqCst);
            }
            if ret < 0 { -(errno as i32) } else { ret as i32 }
        }
        Ok(errno) => {
            // Visible, as the JavaScript hosts' `fork_aborted` report is.
            eprintln!(
                "[host-native] fork aborted: the capture could not seal (errno {errno}); no child \
                 was created and the parent's frames are replayed. See docs/fork-reference-support.md."
            );
            -errno
        }
        Err(e) => {
            eprintln!("fm_parent_seal_capture failed: {e:#}");
            return false;
        }
    };
    coord.set_fork_result(fork_result);

    // A FAILED fork -- a refused seal or a refused child -- resumes the parent
    // at `fork()` with the errno through the ABORT replay; a launched one
    // through the ordinary rewind. `coord` records which, so the paired
    // `Replaying`-phase finish drives the matching `fm_parent_finish(abort)`.
    let abort = fork_result < 0;
    coord.set_abort_replay(abort);
    let replayed = fm
        .fm_parent_replay
        .call(&mut *store, u32::from(abort))
        .and_then(|()| fm.fm_last_errno.call(&mut *store, ()));
    match replayed {
        Ok(0) => {}
        Ok(errno) => {
            eprintln!("fm_parent_replay({abort}) failed: errno {errno}");
            return false;
        }
        Err(e) => {
            eprintln!("fm_parent_replay({abort}) failed: {e:#}");
            return false;
        }
    }
    coord.set_phase(ForkCoordPhase::Replaying);
    true
}

/// N1-I4 Task 2: post an already-successful `SYS_EXIT_GROUP(0)` on a fork
/// child's own main channel (mirrors [`post_thread_exit`]'s bounded
/// post-and-wait shape, but on the MAIN channel with `SYS_EXIT_GROUP`
/// instead of a worker thread's `SYS_exit`), so `run_pump`'s existing
/// process-exit branch commits this pending-replay child's exit — kernel
/// zombie/exit-status recording, `wait_table` insertion, channel removal —
/// through the SAME machinery every other process's exit uses. See
/// `spawn_guest_thread`'s `fork_child_pending_replay` branch for why this
/// child never runs any of its copied program before this call.
fn post_fork_child_pending_exit(guest_mem: &SharedMemory, channel_offset: usize) {
    post_process_exit_group(guest_mem, channel_offset, 0);
}

/// The kind of fault a wasmtime error represents, or `None` when the error is
/// not a Wasm trap at all.
///
/// Structural: wasmtime hands back a typed [`wasmtime::Trap`], so this host
/// never has to recognise an engine's prose the way a JavaScript host must.
/// Both routes end at the same policy —
/// [`wasm_posix_shared::trap_signal::WasmTrapKind::signal`] — which is the
/// point of putting that policy in `crates/shared`.
///
/// `wasmtime::Trap` is `#[non_exhaustive]`; an unrecognised variant returns
/// `None` rather than being folded into a nearby signal, because guessing
/// which fault a guest took is exactly the illusion this host should not
/// create.
fn wasmtime_trap_kind(error: &wasmtime::Error) -> Option<WasmTrapKind> {
    use wasmtime::Trap;
    Some(match error.downcast_ref::<Trap>()? {
        Trap::MemoryOutOfBounds | Trap::HeapMisaligned => WasmTrapKind::Memory,
        Trap::TableOutOfBounds | Trap::ArrayOutOfBounds => WasmTrapKind::Bounds,
        Trap::StackOverflow => WasmTrapKind::Stack,
        Trap::IntegerOverflow
        | Trap::IntegerDivisionByZero
        | Trap::BadConversionToInteger => WasmTrapKind::Arithmetic,
        Trap::IndirectCallToNull
        | Trap::BadSignature
        | Trap::UnreachableCodeReached
        | Trap::NullReference
        | Trap::CastFailure => WasmTrapKind::IllegalInstruction,
        _ => return None,
    })
}

/// End a guest that faulted, with the exit status the fault produces.
///
/// A trap is not a return: the guest never reaches `exit(2)`, so without this
/// its OS thread simply ends, the kernel never learns the process is gone, and
/// a parent parked in `wait(2)` waits forever. This host previously did
/// exactly that — it printed the wasmtime error and returned — while both
/// JavaScript hosts recorded `128 + signum` for the same fault. That was the
/// gap: a guest divide-by-zero was `SIGFPE` on Node and in the browser and
/// nothing at all here.
///
/// KNOWN REMAINING GAP, recorded rather than papered over: the JavaScript
/// hosts additionally call `kernel_mark_process_signaled(pid, signum)` so
/// `WIFSIGNALED` is true and `WTERMSIG` names the signal. That export must be
/// called on the kernel `Store`, which belongs to the pump thread, not to this
/// guest OS thread — so this host reports the right status without the signal
/// flag. Tracked in `docs/future-improvements.md`.
fn post_guest_trap_exit(guest_mem: &SharedMemory, channel_offset: usize, status: i32) {
    post_process_exit_group(guest_mem, channel_offset, status);
}

/// The guest faulted. Report it as the signal every other Kandelo host
/// reports for the same fault, and end the process so the kernel — and any
/// parent in `wait(2)` — learns it is gone.
fn report_guest_fault(
    guest_mem: &SharedMemory,
    channel_offset: usize,
    kind: WasmTrapKind,
    error: &wasmtime::Error,
) {
    let signum = kind.signal();
    let status = wasm_posix_shared::trap_signal::signal_exit_status(signum);
    eprintln!(
        "guest faulted: {} trap (signal {signum}, status {status}): {error:#}",
        kind.as_str()
    );
    post_guest_trap_exit(guest_mem, channel_offset, status);
}

/// Post `exit_group(status)` on a channel and wait (bounded) for the pump.
fn post_process_exit_group(guest_mem: &SharedMemory, channel_offset: usize, status: i32) {
    let ch = channel_offset;
    unsafe {
        write_bytes(guest_mem, ch + SYSCALL_OFFSET, &SYS_EXIT_GROUP.to_le_bytes());
        for i in 0..6 {
            let value = if i == 0 { status as i64 } else { 0i64 };
            write_bytes(guest_mem, ch + ARGS_OFFSET + i * ARG_SIZE, &value.to_le_bytes());
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
    layout: ProcessLayout,
    use_fork_module: bool,
    fork_format: Option<Arc<GuestForkFormat>>,
    fork_proof_of_use: Arc<Mutex<ForkProofOfUse>>,
) -> thread::JoinHandle<()> {
    let engine = engine.clone();
    let module = module.clone();
    thread::spawn(move || {
        if let Err(e) = run_worker_thread(
            &engine, &module, &guest_mem, channel_offset, tls_offset, stack_ptr, tls_ptr, fn_ptr, arg,
            layout, use_fork_module, fork_format, fork_proof_of_use,
        ) {
            eprintln!("worker thread (channel {channel_offset:#x}) failed: {e:?}");
        }
    })
}

/// N1 residual #4a (non-main-thread `fork()`): a worker (pthread) thread that
/// can itself call a REAL, fork-instrumented `fork()` — not just run to
/// completion or trap. Before this task, `kernel.kernel_fork` was never wired
/// on a worker thread's own `Store` at all (`define_unknown_imports_as_traps`
/// stubbed it, along with every other `kernel.*` import); a guest calling
/// `fork()` from a pthread hit an unknown-import trap that silently ended the
/// OS thread with no POSIX-shaped error, hanging any `pthread_join` on it
/// forever. This function instead mirrors [`spawn_guest_thread`]'s own
/// `kernel_fork` wiring (fork-module instantiation, frame-capture imports,
/// the Idle/Replaying coordinator dance) closed over THIS thread's own
/// channel offset — never the process's main one — and drives an entry loop
/// shaped like [`run_fork_capable_entry`] (lexical call, catch a fork-unwind
/// escape exactly once, seal/launch the child, replay via the module's
/// uniform `wpk_fork_resume_start` dispatcher) starting from the pthread's
/// own indirect-table entry function rather than `_start`.
///
/// A worker thread is never itself a fork CHILD (`ForkEntry` does not apply
/// here — a plain `pthread_create` launch is always the "lexical, from the
/// top" shape [`ForkEntry::Normal`] already names), so only the
/// fork-CAPTURE half of the coordinator is reachable from this function.
///
/// Only `fork()`/`_Fork()` (`mode != MODE_VFORK`) is serviced from a
/// non-main channel — `handle_fork`'s vfork-is-main-thread-only invariant is
/// unchanged by this task (a `vfork()`'d child borrows the WHOLE process
/// address space, the kernel refuses a second borrower of one address space
/// with `EAGAIN`, and this host's borrowed-child region is laid out for the
/// main thread only). A `vfork()` call on this thread gets a
/// truthful, immediate `-ENOSYS` instead of ever touching the channel:
/// `run_pump`'s dispatch has no path for a non-main `SYS_VFORK` request, so
/// posting one here would simply hang until the pump's 30s hard cap.
///
/// Known limitation (documented, not fixed by this task): this reuses the
/// SAME `layout`-derived fork-module memory region every guest OS thread of
/// this process (including the main thread) uses — safe as long as at most
/// one thread of a process is mid-fork-capture/replay at any instant. Two
/// threads of the SAME process calling `fork()`
/// *concurrently* is not race-safe under this design; POSIX programs that do
/// this are already on thin ice (a forked child inherits only the calling
/// thread, so any lock held by another thread never releases in the child),
/// so this is treated as an accepted, narrow, documented residual rather
/// than a wall — giving every worker thread its OWN, disjoint fork-module
/// region would need new address-space layout (ABI-adjacent), out of scope
/// here.
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
    layout: ProcessLayout,
    use_fork_module: bool,
    fork_format: Option<Arc<GuestForkFormat>>,
    fork_proof_of_use: Arc<Mutex<ForkProofOfUse>>,
) -> anyhow::Result<()> {
    let mut store = Store::new(engine, ());
    let mut linker: Linker<()> = Linker::new(engine);
    linker.define(&mut store, "env", "memory", guest_mem.clone())?;
    // Same index-type rule as `spawn_guest_thread`'s own `__channel_base`:
    // a wasm64 guest's thread instance declares this global `mut i64`.
    let channel_base = Global::new(
        &mut store,
        GlobalType::new(guest_index_type(layout.pointer_width), Mutability::Var),
        guest_index_val(layout.pointer_width, channel_offset),
    )?;
    linker.define(&mut store, "env", "__channel_base", channel_base)?;

    // N1 residual #4a: give THIS thread its own co-resident fork-module, its
    // fork imports and `kernel_fork` wiring, closed over its own channel —
    // mirrors `spawn_guest_thread`'s wiring; see this function's doc comment
    // for what differs (channel identity, no `ForkEntry`, vfork rejected).
    let mut fork_module: Option<ForkModule> = None;
    let coord = ForkCoordState::new();
    if use_fork_module {
        let fm = instantiate_fork_module(engine, &mut store, guest_mem, &layout)
            .map_err(|e| anyhow::anyhow!("instantiate_fork_module failed: {e:#}"))?;
        bind_guest_fork_imports(&mut linker, &mut store, module, &fm)?;
        if let Some(fmt) = fork_format.as_ref() {
            // This thread's own channel, not the layout's: the module maps its
            // storage through it. The control word is the process's, as a
            // JavaScript pthread worker passes. A pthread is never a fork child.
            let control = fork_control_word(layout.channel_offset) as u32;
            admit_guest(&mut store, &fm, guest_mem, fmt, channel_offset, control, 0)?;
        }
        fork_module = Some(fm);
    }

    // `kernel_fork` (N1 residual #4a): mirrors `spawn_guest_thread`'s own
    // import byte-for-byte, except closed over THIS thread's `channel_offset`
    // and its own, freshly-created `coord` above — see this function's doc
    // comment for the `vfork` restriction.
    {
        let mem = guest_mem.clone();
        let ch = channel_offset;
        let fm_for_import = fork_module.clone();
        let has_format = fork_format.is_some();
        let coord = Arc::clone(&coord);
        linker.func_wrap(
            "kernel",
            "kernel_fork",
            move |mut caller: Caller<'_, ()>, mode: i32| -> wasmtime::Result<i32> {
                if mode as u32 == MODE_VFORK {
                    // vfork is main-thread-only — see this function's doc
                    // comment. A truthful, immediate failure, never posted to
                    // the channel (the pump has no dispatch for a non-main
                    // SYS_VFORK request, so posting one would hang until its
                    // 30s hard cap).
                    return Ok(-(libc_errno::ENOSYS));
                }
                let Some(fm) = (if has_format { fm_for_import.as_ref() } else { None }) else {
                    unsafe {
                        write_bytes(&mem, ch + SYSCALL_OFFSET, &SYS_FORK.to_le_bytes());
                        write_bytes(&mem, ch + ARGS_OFFSET, &(mode as i64).to_le_bytes());
                        for i in 1..6 {
                            write_bytes(&mem, ch + ARGS_OFFSET + i * ARG_SIZE, &0i64.to_le_bytes());
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
                    return Ok(if ret < 0 { -(errno as i32) } else { ret as i32 });
                };

                match coord.phase() {
                    ForkCoordPhase::Idle => {
                        coord.set_mode(mode as u32);
                        coord.set_abort_replay(false);
                        begin_fork_capture(&mut caller, fm, &mem, ch)
                    }
                    ForkCoordPhase::Replaying => {
                        // Coarse replay-finish (worker-thread mirror): drive the
                        // guest's `wpk_fork_rewind_end()` (normal) or
                        // `wpk_fork_abort_end()` (abort — gated/failed-launch) then
                        // finish the replay in one module call, per
                        // `coord.is_abort_replay()`.
                        let abort = coord.is_abort_replay();
                        fm.fm_parent_finish.call(&mut caller, u32::from(abort))?;
                        let errno = fm.fm_last_errno.call(&mut caller, ())?;
                        if errno != 0 {
                            return Err(wasmtime::Error::msg(format!(
                                "fm_parent_finish failed: errno {errno}"
                            )));
                        }
                        coord.set_abort_replay(false);
                        coord.set_phase(ForkCoordPhase::Idle);
                        Ok(coord.fork_result())
                    }
                }
            },
        )?;
    }

    // `kernel_exit` (pre-existing, orthogonal gap this task also closes):
    // `libc/glue/channel_syscall.c`'s generic dispatcher calls
    // `kernel.kernel_exit` DIRECTLY for a per-thread `SYS_EXIT` (musl's
    // `__pthread_exit` path for a NORMALLY-RETURNING thread — distinct from
    // `SYS_EXIT_GROUP`, which stays on the generic channel path and a
    // detached thread's `__unmapself` teardown, which posts `SYS_munmap`
    // then `SYS_exit` over the ordinary channel, matching `is_unreachable_
    // trap`'s doc comment below). Before this task NO worker-thread `Store`
    // wired this import at all (an unrelated, pre-existing gap this exact
    // shape's fixture — a pthread that actually RETURNS rather than parking
    // forever — happens to also exercise; see `native_thread.c`'s own doc
    // comment: "a returning pthread would run musl's detached-thread
    // teardown ... which needs thread-teardown machinery the minimal native
    // host does not provide yet"). Reuses `post_thread_exit` (the SAME
    // channel-post-and-wait sequence a thread's `__unmapself` path already
    // drives) so `run_pump`'s existing per-thread exit handling (`kernel_
    // thread_exit`, clearing the child-tid futex, dropping the channel) is
    // the ONE path every worker-thread exit goes through, whether reached
    // via `__unmapself`'s ordinary channel post or `__pthread_exit`'s direct
    // import. Returns an `Err` carrying `ThreadKernelExit` (never `Ok`,
    // matching this import's own `_Noreturn` C declaration) so the entry
    // loop below can recognize it as a clean, already-handled exit rather
    // than a genuine failure.
    {
        let mem = guest_mem.clone();
        let ch = channel_offset;
        linker.func_wrap(
            "kernel",
            "kernel_exit",
            move |_c: Caller<'_, ()>, _status: i32| -> wasmtime::Result<()> {
                post_thread_exit(&mem, ch);
                Err(wasmtime::Error::new(ThreadKernelExit))
            },
        )?;
    }

    // The worker reaches the kernel through the syscall glue (its own
    // channel), not through the remaining kernel.* imports (kernel_clone,
    // kernel_wait4, kernel_get_argc, ...), so every OTHER kernel.* import
    // can still trap — unchanged from before this task. Nested `pthread_
    // create`/`kernel_clone` FROM a worker thread is a separate, pre-
    // existing, out-of-scope gap (the SAME "import not wired
    // on this Store" shape this task fixes for `kernel_fork` alone).
    //
    // N1 residual #4a: the large reference-capture (`__wpk_fork_ref_*`) and
    // module-state-save/restore FUNCTION import family is declared by every
    // fork-instrumented guest unconditionally, regardless of whether it ever
    // actually captures a reference — see `spawn_guest_thread`'s identical
    // "N1-I4 Task 3" doc comment. A frames-only fork (this fixture's own
    // shape) never calls any of them, so leaving every FUNCTION import in
    // that family to `define_unknown_imports_as_traps` above (a trap only
    // fires if actually CALLED) is the same accepted platform boundary
    // `smoke_fork_parent_child` already validates on the main thread. The
    // NON-function imports in that same family (`env.__wpk_fork_ref_gc_
    // transit`, a table; the two `__wpk_fork_module_*` globals) cannot be
    // trap-stubbed (a trap has no meaning for a table/global read), so they
    // fall through to `define_unknown_imports_as_default_values` — the
    // zero/empty value for their declared type, unreachable by a
    // frames-only fork for the exact same reason.
    linker.define_unknown_imports_as_traps(module)?;
    linker.define_unknown_imports_as_default_values(&mut store, module)?;

    let instance = linker.instantiate(&mut store, module)?;

    // Bind THIS thread's admitted activation, as `spawn_guest_thread` does:
    // its guest places its own resume thunks and every slot the module drives
    // is bound, before anything `call_indirect`s through either table. See
    // [`bind_activation`].
    if let (Some(fm), Some(_)) = (fork_module.as_ref(), fork_format.as_ref()) {
        bind_activation(&mut store, fm, &instance, guest_mem)?;
    }

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

    // N1 residual #4a: a fork-instrumented guest converts every active
    // element segment to passive and defers their init into an exported
    // bootstrap function (see `run_fork_capable_entry`'s doc comment) — this
    // fresh, per-thread `Instance`'s own `__indirect_function_table` needs
    // the SAME table-only re-init a fork child's fresh instance gets
    // (`WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP`): this thread's memory is
    // the process's own SHARED memory (already correctly populated by the
    // main thread's own full bootstrap at process launch), so only the
    // per-instance TABLE needs populating here, never a re-copy of
    // `.data`/`.rodata` (which would wrongly reset already-live globals back
    // to their initial values). A non-instrumented guest exports no such
    // name, so `get_typed_func(...).ok()` finds nothing and this is a
    // byte-for-byte no-op for it, exactly like every pre-existing,
    // non-instrumented worker-thread test.
    if let Ok(bootstrap) = instance
        .get_typed_func::<(), ()>(&mut store, wasm_posix_shared::abi::WPK_FORK_EXPORT_MODULE_THREAD_BOOTSTRAP)
    {
        bootstrap.call(&mut store, ())?;
    }

    // N1 residual #4a: `wasm-fork-instrument` generates TWO different
    // "resume-selected call" wrappers for a fork-instrumented guest —
    // `wpk_fork_resume_start` (`() -> ()`, hardcoded to invoke `_start`
    // DIRECTLY — see `emit_fixed_resume_boundaries`'s own
    // `CallTarget::Direct(start)`) and `wpk_fork_resume_thread` (`(i32,
    // i32) -> i32`, `CallTarget::Indirect` over `__indirect_function_
    // table` — the ONE shaped for a pthread entry point). Both share the
    // SAME underlying "is this a fresh call or a resume?" dispatch
    // (`emit_resume_selected_call`); they differ only in what a FRESH
    // (non-replayed) call actually invokes. `resume_start` is `_start`-only
    // and is NEVER correct here (confirmed empirically: calling it for a
    // worker thread's own resume, or from a fork CHILD launched by a
    // worker-thread-originated fork, traps `indirect call type mismatch`
    // inside `wpk_fork_resume_start` — this was this task's real, deep RED
    // state, not a wiring omission). `resume_thread` takes the SAME
    // `(table_index, argument)` pair on EVERY call — both the very first
    // (lexical) entry and every later replay re-entry — since its own
    // internal dispatch, not this host, decides whether to actually invoke
    // `__indirect_function_table[table_index](argument)` fresh or resume a
    // captured continuation instead. A non-instrumented guest declares
    // neither export, so this falls back to the ORIGINAL raw indirect-call
    // mechanism unchanged (`smoke_fork_from_thread`'s non-instrumented
    // sibling scenario, and every pre-existing worker-thread test, use this
    // branch).
    let resume_thread = instance
        .get_typed_func::<(i32, i32), i32>(&mut store, wasm_posix_shared::abi::WPK_FORK_EXPORT_RESUME_THREAD)
        .ok();
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

    // N1 residual #4a: mirrors `run_fork_capable_entry`'s own loop shape — a
    // call that may escape as a THROWN `__wpk_fork_unwind` exception (a
    // `fork()` call capturing this thread's own live call stack), after which this drives the SAME capture/seal/launch-child
    // sequence (`drive_fork_capture_seal_and_launch_child`, already generic
    // over "which channel") and re-enters via `resume_thread` — using the
    // IDENTICAL `(fn_ptr, arg)` pair every time (see above for why this is
    // correct on both the lexical and the replay call).
    let result = loop {
        let step = match resume_thread.as_ref() {
            Some(f) => f.call(&mut store, (fn_ptr as i32, arg as i32)).map(|_| ()),
            None => {
                let results_len = func.ty(&store).results().len();
                let mut results = vec![Val::I32(0); results_len];
                func.call(&mut store, &[Val::I32(arg as i32)], &mut results)
            }
        };
        match step {
            // musl's detached-thread exit (__unmapself) issues SYS_munmap + SYS_exit
            // — which the pump routes to kernel_thread_exit — then executes
            // `unreachable` to halt the thread. That trap is the expected, clean end
            // of the thread, exactly like the process exit trap on the main thread.
            Err(e) if is_unreachable_trap(&e) => break Ok(()),
            // `kernel_exit`'s own closure already posted SYS_EXIT and
            // completed the channel round trip (see its wiring's doc
            // comment) before returning this marker error to force the wasm
            // call stack to unwind — an already-fully-handled, clean exit,
            // not a failure.
            Err(e) if e.downcast_ref::<ThreadKernelExit>().is_some() => break Ok(()),
            Err(e) if is_thrown_exception_escape(&e) => {
                // Only a fork's capture unwind may escape -- `run_fork_
                // capable_entry`'s identical guard.
                if !in_fork_capture(&mut store, fork_module.as_ref()) {
                    break Err(anyhow::anyhow!(
                        "unexpected exception escape outside a fork capture: {e:#}"
                    ));
                }
                if store.take_pending_exception().is_none() {
                    eprintln!(
                        "is_thrown_exception_escape matched but the store has no pending \
                         exception to take — this should not happen"
                    );
                }
                let Some(fm) = fork_module.as_ref() else {
                    break Err(anyhow::anyhow!("fork-unwind exception escaped with no fork-module"));
                };
                if !drive_fork_capture_seal_and_launch_child(&mut store, guest_mem, channel_offset, fm, &coord) {
                    break Err(anyhow::anyhow!("fork-capture seal/launch-child failed (see stderr)"));
                }
            }
            Err(e) => break Err(e.into()),
            // A thread entry that returns without self-exiting is unusual
            // (musl always exits via __pthread_exit); post the exit
            // ourselves as a fallback — applies equally whether this is the
            // thread's very first (lexical) return or a REPLAYED program
            // reaching the same natural end past its own `fork()` call.
            Ok(()) => {
                post_thread_exit(guest_mem, channel_offset);
                break Ok(());
            }
        }
    };

    // Fold this thread's own fork-module proof-of-use counters into the
    // shared accumulator — mirrors `spawn_guest_thread`'s identical,
    // best-effort, additive fold (see that call site's doc comment).
    if let Some(fm) = fork_module.as_ref() {
        let mut acc = fork_proof_of_use.lock().unwrap();
        fold_fork_proof_of_use(fm, &mut store, &mut acc);
    }

    result
}

/// N1 residual #4a: marker error `run_worker_thread`'s own `kernel_exit`
/// import closure returns to force its calling wasm frame to unwind — see
/// that closure's doc comment. Not a real failure; `run_worker_thread`'s
/// entry loop recognizes this exact type and treats it as an
/// already-fully-handled clean exit, exactly like `is_unreachable_trap`.
#[derive(Debug)]
struct ThreadKernelExit;

impl std::fmt::Display for ThreadKernelExit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "kernel_exit (worker thread)")
    }
}

impl std::error::Error for ThreadKernelExit {}

/// Whether a Wasmtime error is a guest `unreachable` trap.
///
/// The trap alone does not say whether the guest faulted or was unwound by
/// the host; each caller must decide that from state it can read.
/// `run_fork_capable_entry` does (`CH_TEARDOWN` on its channel, else SIGILL).
/// `run_worker_thread` still treats every such trap as a clean thread exit —
/// see `docs/future-improvements.md`.
fn is_unreachable_trap(e: &wasmtime::Error) -> bool {
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
    /// The OS `JoinHandle` backing each live entry in `channels`, keyed by
    /// that channel's `offset` (the same key `reclaim_parked_thread` writes
    /// the teardown sentinel to). The main thread's handle is joined when
    /// the kernel records the process's exit (`run_pump`'s exit branch). The
    /// reclamation paths (execve-success, spawn `-ECHILD` rollback) likewise
    /// publish `CH_TEARDOWN` on a channel, then look up and `join()` its
    /// handle here. Other handles (worker threads still running at exit) are
    /// left for the OS to reclaim at process teardown.
    thread_handles: HashMap<usize, thread::JoinHandle<()>>,
    /// N1-I4 Task 3: this process's own [`GuestForkFormat`] (from its OWN
    /// `Module::new` call site — `run_guest`'s boot module, `handle_spawn`'s
    /// child, or `handle_exec_common`'s new image), or `None` for a
    /// non-fork-instrumented program. `handle_fork` clones this for a fork
    /// child (the SAME bytes, so the SAME format) rather than recomputing
    /// it, and uses `is_some()` to decide whether a fork of THIS process can
    /// drive a real [`ForkEntry::ChildReplay`] or must fall back to
    /// [`ForkEntry::ChildPendingStub`].
    fork_format: Option<Arc<GuestForkFormat>>,
    /// The kernel recorded this process's death by a signal (another
    /// process's `kill`, a host-generated signal, or a vfork containment),
    /// and the pump has recorded its wait status. From then on every one of
    /// its threads is torn down (`CH_TEARDOWN` + join) the moment it parks
    /// on its channel, and none of its requests is dispatched: the kernel
    /// must never see another syscall from a process it already ended. Set
    /// only by `retire_signal_killed_processes`.
    signal_killed: bool,
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
    pointer_width: u8,
) -> anyhow::Result<Vec<StagedArg>> {
    unsafe {
        write_bytes(kernel_mem, scratch_ptr + DATA_OFFSET, &[0u8; 4]);
        write_bytes(kernel_mem, scratch_ptr + SYSCALL_OFFSET, &syscall_nr.to_le_bytes());
    }
    let staged = marshal_in(kernel_mem, guest_mem, scratch_ptr, syscall_nr, args, pointer_width)?;
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
    pointer_width: u8,
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
        let staged = stage_raw(kernel_mem, guest_mem, scratch_ptr, syscall_nr, args, pointer_width)?;
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
            if args[3] as u32 & wasm_posix_shared::mmap::MAP_ANONYMOUS != 0 {
                zero_anonymous_mapping(guest_mem, ret as usize, args[1] as u32 as usize);
            }
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

/// The kernel exports behind a kernel-owned fork launch (lane F step 2).
///
/// The kernel decides when a parked fork or vfork parent returns: at the
/// child's `SYS_FORK_REPLAY_READY`, at its death before that, at a reported
/// launch failure, or (vfork) once the borrowed image is released. This host
/// keeps only what the kernel cannot observe -- whether a child realm could
/// be launched, and whether every thread that ran on a borrowed image has
/// been joined -- and reports those facts through these exports. It is the
/// contract the Node and browser hosts run in `host/src/kernel-worker.ts`.
struct ForkLaunchKernel {
    fork_process: wasmtime::TypedFunc<(u32, u32, u32), i32>,
    launch_failed: wasmtime::TypedFunc<(u32, u32), i32>,
    vfork_released: wasmtime::TypedFunc<(u32, u32), i32>,
    drain: wasmtime::TypedFunc<(i32, u32, u32), u32>,
    /// Kernel scratch the fork-lifecycle records are drained into.
    drain_scratch: KernelScratch,
    /// `kernel_generate_host_signal`, used only by the test hook that kills
    /// a fork child inside its launch window
    /// (`GuestOptions::fork_child_launch_signal`).
    generate_host_signal: wasmtime::TypedFunc<(u32, u32), i32>,
}

/// A parent's `SYS_FORK`/`SYS_VFORK` request, left `STATUS_PENDING` (so its
/// calling thread stays parked) until the kernel's fork-lifecycle queue
/// decides its result. The pump never re-dispatches a parked request.
struct ParkedForkParent {
    child_pid: u32,
    process_index: usize,
    /// The image the request was posted from. An exec of the parent replaces
    /// `processes[process_index].memory`; the record then no longer names a
    /// live channel even if the new image reuses the same channel offset.
    parent_mem: SharedMemory,
    scratch_ptr: usize,
    ch: PumpChannel,
    syscall_nr: u32,
    args: [i64; 6],
}

impl ParkedForkParent {
    /// Whether the parked thread still exists: same image, not killed, and
    /// its channel is still one the pump services.
    fn still_parked(&self, processes: &[GuestProcess]) -> bool {
        processes.get(self.process_index).is_some_and(|p| {
            mem_base(&p.memory) == mem_base(&self.parent_mem)
                && !p.signal_killed
                && p.channels.iter().any(|c| c.offset == self.ch.offset && c.tid == self.ch.tid)
        })
    }
}

/// Report that a fork child could not be launched: no realm was started, so
/// the kernel rolls a still-launching child back and queues the parent's
/// `-errno`. A child that already died stays the parent's zombie.
fn report_fork_launch_failed(
    kernel_store: &mut Store<()>,
    launch: &ForkLaunchKernel,
    child_pid: u32,
    errno: i32,
) -> anyhow::Result<()> {
    let outcome = launch.launch_failed.call(&mut *kernel_store, (child_pid, errno as u32))?;
    anyhow::ensure!(
        outcome >= 0,
        "kernel_fork_launch_failed({child_pid}, {errno}) refused: {outcome}"
    );
    Ok(())
}

/// End a vfork borrow after this host tore down a realm that may have run on
/// the parent's image: `RESUME` when every one of its threads was joined
/// (exact quiescence), `CONTAIN` when one is still running and cannot be
/// stopped. Called at every image end; the kernel is the authority on
/// whether `pid` was a borrower at all (`ESRCH` when it was not).
fn release_vfork_address_space(
    kernel_store: &mut Store<()>,
    launch: &ForkLaunchKernel,
    pid: u32,
    quiescent: bool,
) -> anyhow::Result<()> {
    use wasm_posix_shared::fork_lifecycle_event_wire::{RELEASE_CONTAIN, RELEASE_RESUME};
    let disposition = if quiescent { RELEASE_RESUME } else { RELEASE_CONTAIN };
    let rc = launch.vfork_released.call(&mut *kernel_store, (pid, disposition))?;
    anyhow::ensure!(
        rc == 0 || rc == -libc_errno::ESRCH,
        "kernel_vfork_address_space_released({pid}, {disposition}) refused: {rc}"
    );
    Ok(())
}

/// Complete parked fork parents from the kernel's fork-lifecycle records:
/// the one place a parked parent is completed. `KIND_VFORK_AWAITING_
/// QUIESCENCE` needs no action here, because this host already releases at
/// each image end (`release_vfork_address_space`).
fn complete_parked_fork_parents(
    kernel_store: &mut Store<()>,
    kernel_mem: &SharedMemory,
    launch: &ForkLaunchKernel,
    processes: &[GuestProcess],
    parked: &mut Vec<ParkedForkParent>,
) -> anyhow::Result<()> {
    use wasm_posix_shared::fork_lifecycle_event_wire as wire;
    if parked.is_empty() {
        return Ok(());
    }
    let (drain_ptr, drain_capacity) = (launch.drain_scratch.ptr(), launch.drain_scratch.capacity());
    let max = drain_capacity / wire::RECORD_BYTES as u32;
    loop {
        let count = launch.drain.call(&mut *kernel_store, (drain_ptr, drain_capacity, max))?;
        anyhow::ensure!(count <= max, "fork-lifecycle drain returned {count} of at most {max}");
        let bytes = unsafe {
            read_bytes(kernel_mem, drain_ptr as u32 as usize, count as usize * wire::RECORD_BYTES)
        };
        for record in bytes.chunks_exact(wire::RECORD_BYTES) {
            let field = |offset: usize| {
                i32::from_le_bytes(record[offset..offset + 4].try_into().expect("4-byte field"))
            };
            if field(wire::KIND_OFFSET) as u32 != wire::KIND_PARENT_COMPLETE {
                continue;
            }
            let child_pid = field(wire::CHILD_PID_OFFSET) as u32;
            let Some(index) = parked.iter().position(|p| p.child_pid == child_pid) else {
                continue;
            };
            let parent = parked.swap_remove(index);
            // A sibling thread may have exec'd the parent image, or the parent
            // may have been killed, while this thread was parked.
            if !parent.still_parked(processes) {
                continue;
            }
            anyhow::ensure!(
                processes[parent.process_index].pid == field(wire::PARENT_PID_OFFSET) as u32
                    && parent.ch.tid == field(wire::PARENT_TID_OFFSET) as u32,
                "fork child {child_pid} completed a parent this host did not park"
            );
            let value = field(wire::VALUE_OFFSET);
            let (ret, errno) = if value > 0 { (value as i64, 0) } else { (-1, (-value) as u32) };
            complete_channel(
                &parent.parent_mem, kernel_mem, parent.scratch_ptr, parent.ch, parent.syscall_nr,
                &parent.args, &[], ret, errno,
            )?;
        }
        if count < max {
            return Ok(());
        }
    }
}

/// The native kill path: retire every process the kernel has ended by a
/// signal since the last pass.
///
/// Signal death is decided in the kernel (a guest `kill`, a host-generated
/// signal, a vfork containment). This host learns of it here, as
/// `reapKilledProcessesAfterSyscall` does on the JavaScript hosts: it records
/// the wait status, drops the process's parked and blocked requests, and
/// tears down every thread already parked on its channel (`CH_TEARDOWN` +
/// join). A thread still computing cannot be stopped from outside; the pump
/// tears it down the moment it next parks, and never dispatches its request.
/// If the process borrowed a vfork parent's image, the borrow ends here:
/// `RESUME` when every thread was joined, `CONTAIN` otherwise.
#[allow(clippy::too_many_arguments)]
fn retire_signal_killed_processes(
    kernel_store: &mut Store<()>,
    launch: &ForkLaunchKernel,
    get_exit_status: &wasmtime::TypedFunc<u32, i32>,
    get_exit_signal: &wasmtime::TypedFunc<u32, i32>,
    processes: &mut [GuestProcess],
    blocked: &mut Vec<BlockedOp>,
    parked: &mut Vec<ParkedForkParent>,
    wait_table: &Arc<Mutex<WaitTable>>,
    root_exit_code: &mut Option<i32>,
) -> anyhow::Result<()> {
    for pi in 0..processes.len() {
        if processes[pi].signal_killed || processes[pi].channels.is_empty() {
            continue;
        }
        let pid = processes[pi].pid;
        let signal = get_exit_signal.call(&mut *kernel_store, pid)?;
        if signal <= 0 {
            continue;
        }
        let code = get_exit_status.call(&mut *kernel_store, pid)?;
        wait_table.lock().unwrap().exited.insert(pid, encode_wait_status(code, signal));
        if pi == 0 {
            *root_exit_code = Some(code);
        }
        blocked.retain(|op| op.process_index != pi);
        parked.retain(|p| p.process_index != pi);
        let proc_ = &mut processes[pi];
        proc_.signal_killed = true;
        let memory = proc_.memory.clone();
        let parked_channels: Vec<PumpChannel> = proc_
            .channels
            .iter()
            .copied()
            .filter(|ch| {
                unsafe { atomic_u32(&memory, ch.offset + STATUS_OFFSET) }.load(Ordering::SeqCst)
                    == STATUS_PENDING
            })
            .collect();
        for ch in &parked_channels {
            teardown_parked_thread(proc_, ch);
        }
        let quiescent = proc_.channels.is_empty();
        release_vfork_address_space(kernel_store, launch, pid, quiescent)?;
    }
    Ok(())
}

/// Unwind one parked thread of a signal-killed process and drop its channel.
fn teardown_parked_thread(proc_: &mut GuestProcess, ch: &PumpChannel) {
    reclaim_parked_thread(&proc_.memory, ch);
    if let Some(handle) = proc_.thread_handles.remove(&ch.offset) {
        if handle.join().is_err() {
            eprintln!(
                "[host-native] pid {}'s signal-killed thread panicked instead of unwinding on \
                 TEARDOWN",
                proc_.pid
            );
        }
    }
    proc_.channels.retain(|c| c.offset != ch.offset);
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
///
/// Returns whether every channel's thread was reclaimed and joined: the
/// exact-quiescence proof a vfork release needs before the parent's image
/// may be handed back (`release_vfork_address_space`).
fn reclaim_all_channels(proc_: GuestProcess) -> bool {
    let GuestProcess {
        memory,
        channels,
        mut thread_handles,
        ..
    } = proc_;
    let mut quiescent = true;
    for ch in &channels {
        let status =
            unsafe { atomic_u32(&memory, ch.offset + STATUS_OFFSET) }.load(Ordering::SeqCst);
        if status != STATUS_PENDING {
            // Compute-bound sibling, not parked — leave it alone (see this
            // function's doc comment); drop its handle unjoined.
            thread_handles.remove(&ch.offset);
            quiescent = false;
            continue;
        }
        reclaim_parked_thread(&memory, ch);
        if let Some(handle) = thread_handles.remove(&ch.offset) {
            join_reclaimed_thread(handle);
        }
    }
    quiescent
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
    thread_parent_tid_target: &wasmtime::TypedFunc<(u32, u32), i64>,
    thread_slot_addr: &wasmtime::TypedFunc<(u32, u32), i64>,
    release_host_region: &wasmtime::TypedFunc<(u32, i32, i32), i32>,
    alloc_scratch: &wasmtime::TypedFunc<u32, i32>,
    set_thread_slot_quota: &wasmtime::TypedFunc<(u32, u32), i32>,
    set_brk_base: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_mmap_base: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_max_addr: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_pointer_width: &wasmtime::TypedFunc<(u32, u32), i32>,
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
    launch: &ForkLaunchKernel,
    fork_child_launch_signal: Option<u32>,
    current_memory: &Arc<Mutex<SharedMemory>>,
    current_pid: &Arc<Mutex<u32>>,
    wait_table: &Arc<Mutex<WaitTable>>,
    use_fork_module: bool,
    fork_proof_of_use: &Arc<Mutex<ForkProofOfUse>>,
    trace: &mut Vec<u32>,
) -> anyhow::Result<i32> {
    let mut blocked: Vec<BlockedOp> = Vec::new();
    // Fork and vfork parents whose result the kernel has not decided yet.
    let mut parked_forks: Vec<ParkedForkParent> = Vec::new();
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

        // 0) Retire processes the kernel ended by a signal, and forget parked
        // fork parents whose thread no longer exists (exec'd or killed).
        retire_signal_killed_processes(
            kernel_store, launch, get_exit_status, get_exit_signal, processes, &mut blocked,
            &mut parked_forks, wait_table, &mut root_exit_code,
        )?;
        parked_forks.retain(|parent| parent.still_parked(processes));

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
            // The parked op belongs to THIS process, so its record sizes
            // are this process's data model, not the one dispatching now.
            let pointer_width = proc.layout.pointer_width;
            let mut args = read_channel_args(&guest_mem, op.channel.offset);
            let deadline_passed = op.deadline.is_some_and(|d| Instant::now() >= d);

            let staged =
                stage_raw(kernel_mem, &guest_mem, scratch_ptr, op.syscall_nr, &mut args, pointer_width)?;
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
            let pointer_width = layout.pointer_width;
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
                // A thread of a process the kernel already killed has just
                // parked: unwind it instead of dispatching into a dead
                // process (see `retire_signal_killed_processes`).
                if processes[pi].signal_killed {
                    teardown_parked_thread(&mut processes[pi], &ch);
                    progressed = true;
                    continue; // the vec shifted; do not advance ci
                }
                // A fork/vfork parent stays parked until the kernel decides
                // its result (`complete_parked_fork_parents`).
                if parked_forks.iter().any(|p| p.process_index == pi && p.ch.offset == ch.offset) {
                    ci += 1;
                    continue;
                }
                progressed = true;
                let (syscall_nr, mut args, is_record) = read_channel_request(&guest_mem, ch.offset);
                trace.push(syscall_nr);

                // Process exit on the MAIN channel: the kernel commits the
                // status, then the pump wakes the exited thread with
                // `CH_TEARDOWN` so it unwinds (below). Only
                // `processes[0]`'s (the boot process) exit marks the run as
                // done, but does not necessarily return immediately (see this
                // function's doc comment: it drains any spawned children
                // first). A spawned child's exit always just commits into the
                // kernel and drops its channel.
                if ch.is_main && (syscall_nr == Syscall::Exit as u32 || syscall_nr == SYS_EXIT_GROUP) {
                    let _ = stage_raw(
                        kernel_mem, &guest_mem, scratch_ptr, syscall_nr, &mut args, pointer_width,
                    )?;
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
                    // The exit is recorded, so unwind the thread that posted
                    // it, as a JavaScript host does: its `kernel_exit` waits
                    // for this same commit and then traps, and the worker
                    // loop treats that trap as an exit only because the exit
                    // is recorded. Here `CH_TEARDOWN` is that fact, published
                    // on the thread's own channel: the glue traps on it and
                    // `run_fork_capable_entry` returns cleanly (and so folds
                    // this process's fork proof-of-use) instead of reporting a
                    // fault. Joined, because the channel is PENDING -- the
                    // thread is at or entering its wait on this word -- so it
                    // unwinds promptly; see `reclaim_parked_thread`. Without
                    // this the thread parked forever, and a guest that trapped
                    // right after posting its exit was indistinguishable from
                    // one that faulted.
                    //
                    // Joined directly rather than through
                    // `join_reclaimed_thread`, whose test counter is evidence
                    // of exec/rollback reclamation specifically.
                    reclaim_parked_thread(&guest_mem, &ch);
                    if let Some(handle) = processes[pi].thread_handles.remove(&ch.offset) {
                        if handle.join().is_err() {
                            eprintln!(
                                "[host-native] pid {pid}'s exited main thread panicked instead of \
                                 unwinding on TEARDOWN"
                            );
                        }
                    }
                    // No one reads a response to this final syscall (whether
                    // this is the boot process or a spawned child), so drop
                    // the channel (like a worker thread's exit) rather than
                    // completing it. A spawned child's exit is now committed
                    // in the kernel's process table (Zombie/Exited) and
                    // recorded in `wait_table`, ready for `host_waitpid` to
                    // resolve a parked or future `waitpid`.
                    processes[pi].channels.remove(ci);
                    // If this process borrowed a vfork parent's image, the
                    // exit ended the borrow in the kernel; the join above is
                    // the quiescence proof (a vfork child has no other
                    // threads, which the kernel enforces).
                    let quiescent = processes[pi].channels.is_empty();
                    release_vfork_address_space(kernel_store, launch, pid, quiescent)?;
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
                    // Drop this worker's JoinHandle alongside its channel, and
                    // hand its control slot back to the kernel's address-space
                    // allocator: POSIX counts threads that exist now, so an
                    // exited thread's slot must be available to the next
                    // `pthread_create`. The kernel deliberately does not free
                    // it at `kernel_thread_exit` -- only a host knows when a
                    // worker can no longer touch its slot, and here it can:
                    // this thread reached its `exit` syscall on this channel.
                    processes[pi].thread_handles.remove(&ch.offset);
                    let slot_addr =
                        ch.offset - THREAD_SLOT_CHANNEL_PRIMARY_PAGE * WASM_PAGE_SIZE;
                    let released = release_host_region.call(
                        &mut *kernel_store,
                        (pid, slot_addr as i32, THREAD_SLOT_BYTES as i32),
                    )?;
                    anyhow::ensure!(
                        released >= 0,
                        "kernel refused release of thread control slot {slot_addr:#x} for \
                         pid={pid}: {released}"
                    );
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
                    let _ = stage_raw(
                        kernel_mem, &guest_mem, scratch_ptr, syscall_nr, &mut clone_args, pointer_width,
                    )?;
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
                    // CLONE_PARENT_SETTID: the kernel names the address, the
                    // host performs the write -- the same division of labour
                    // as the ctid clear on thread exit below. Asking the
                    // kernel rather than testing the flag here is what keeps
                    // this host and the JavaScript hosts agreeing; when each
                    // tested the flag itself, only the JavaScript hosts
                    // honoured it, so a worker thread here ran with
                    // `struct pthread.tid == 0` and deadlocked musl's
                    // thread-list lock on the second `pthread_create`.
                    let ptid = thread_parent_tid_target
                        .call(&mut *kernel_store, (pid, tid as u32))?;
                    if ptid > 0 {
                        unsafe {
                            write_bytes(&guest_mem, ptid as u32 as usize, &tid.to_le_bytes());
                        }
                    }

                    // Where the slot goes is the kernel's decision, taken
                    // inside the `clone` just dispatched: it reserved the range
                    // from the same address-space allocator that answers mmap,
                    // so the slot cannot collide with a mapping, the brk heap,
                    // or a sibling thread's slot. This host used to compute the
                    // address itself out of a fixed 16-slot arena, which is why
                    // its real concurrent ceiling was 16 rather than whatever
                    // the program declared.
                    //
                    // What is left is the part only a host can do: grow the
                    // memory until the range is addressable, and zero it.
                    let slot_addr = thread_slot_addr.call(&mut *kernel_store, (pid, tid as u32))?;
                    anyhow::ensure!(
                        slot_addr > 0
                            && (slot_addr as usize) % WASM_PAGE_SIZE == 0,
                        "kernel placed no control slot for pid={pid} tid={tid}: {slot_addr}"
                    );
                    let slot_addr = slot_addr as usize;
                    let thread_channel_offset =
                        slot_addr + THREAD_SLOT_CHANNEL_PRIMARY_PAGE * WASM_PAGE_SIZE;
                    let tls_offset = slot_addr + THREAD_SLOT_TLS_PAGE * WASM_PAGE_SIZE;
                    // Materialize + zero the whole slot (TLS, fork-save, channel).
                    grow_to_cover(&guest_mem, slot_addr + THREAD_SLOT_BYTES)?;
                    unsafe {
                        write_bytes(&guest_mem, slot_addr, &vec![0u8; THREAD_SLOT_BYTES]);
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
                        layout,
                        use_fork_module,
                        processes[pi].fork_format.clone(),
                        Arc::clone(fork_proof_of_use),
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
                        spawn_blob_decode, spawn_process, publish_spawn_child, remove_process,
                        set_thread_slot_quota, set_brk_base,
                        set_mmap_base, set_max_addr, set_pointer_width,
                        spawn_exec_target_prepare, exec_target_size,
                        exec_target_read, spawn_exec_commit, exec_target_cancel,
                        exec_target_resolve_shebang, wait_table, use_fork_module, fork_proof_of_use,
                    )?;
                    ci += 1;
                    continue;
                }

                // SYS_FORK/SYS_VFORK (N1-I4 Task 2): a private-memory child,
                // posted by this host's OWN `kernel_fork` import closure
                // (`spawn_guest_thread`) -- the guest's `fork()`/`vfork()`/
                // `_Fork()` call `kernel.kernel_fork(mode)` DIRECTLY
                // (`libc/glue/channel_syscall.c`), never through the generic
                // channel dispatcher, so this interception happens here for
                // the SAME reason `SYS_CLONE`/`SYS_SPAWN` above do: before
                // any `dispatch_once`/RAW-arg marshalling. See
                // `handle_fork`'s doc comment for the full child-identity +
                // private-memory-copy + co-resident-module sequence, and why
                // the child never executes any of its copied program in this
                // increment (that is Task 3's job). A request `handle_fork`
                // already serviced stays PENDING in `parked_forks` and is
                // skipped above, so it can never launch a second child.
                //
                // N1 residual #4a: `fork()`/`_Fork()` (never `vfork()` — see
                // `run_worker_thread`'s doc comment for why that stays
                // main-channel-only) is now serviced from ANY channel, not
                // just the process's main one — `handle_fork` already reads
                // `ch.tid` generically (it never assumed "main thread"), so
                // this is the only pump-side gate that needed relaxing.
                // `SYS_VFORK` keeps the original `ch.is_main` restriction
                // unchanged.
                if syscall_nr == SYS_FORK || (ch.is_main && syscall_nr == SYS_VFORK) {
                    handle_fork(
                        kernel_store, engine, kernel_mem, processes, pi, ch, syscall_nr, &args,
                        launch, &mut parked_forks, fork_child_launch_signal, alloc_scratch,
                        set_thread_slot_quota, set_brk_base, set_mmap_base,
                        set_max_addr, set_pointer_width, use_fork_module, fork_proof_of_use, wait_table,
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
                        set_thread_slot_quota, set_brk_base, set_mmap_base, set_max_addr,
                        set_pointer_width,
                        exec_target_prepare, exec_target_size,
                        exec_target_read, exec_commit, exec_target_cancel, exec_target_resolve_shebang,
                        remove_process, launch, wait_table, use_fork_module, fork_proof_of_use,
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
                        path_bytes, argv_ptr, envp_ptr, flags, alloc_scratch, set_thread_slot_quota,
                        set_brk_base, set_mmap_base,
                        set_max_addr, set_pointer_width, exec_target_prepare, exec_target_size,
                        exec_target_read, exec_commit,
                        exec_target_cancel, exec_target_resolve_shebang, remove_process, launch,
                        wait_table, use_fork_module, fork_proof_of_use,
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
                    &mut args, pointer_width, 0, set_current_tid, handle_channel, current_memory,
                    current_pid,
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

        // 3) Complete the fork and vfork parents whose result the kernel
        // decided during this pass (a child's replay-ready report, its death,
        // a launch failure, or a vfork release).
        let parked_before = parked_forks.len();
        complete_parked_fork_parents(kernel_store, kernel_mem, launch, processes, &mut parked_forks)?;
        progressed |= parked_forks.len() != parked_before;

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
    set_thread_slot_quota: &wasmtime::TypedFunc<(u32, u32), i32>,
    set_brk_base: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_mmap_base: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_max_addr: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_pointer_width: &wasmtime::TypedFunc<(u32, u32), i32>,
    spawn_exec_target_prepare: &wasmtime::TypedFunc<(u32, u32, u32, u32), i32>,
    exec_target_size: &wasmtime::TypedFunc<(u32, u32), i64>,
    exec_target_read: &wasmtime::TypedFunc<(u32, u32, u32, i32, u32, u32), i32>,
    spawn_exec_commit: &wasmtime::TypedFunc<(u32, u32, u32), i32>,
    exec_target_cancel: &wasmtime::TypedFunc<(u32, u32), i32>,
    exec_target_resolve_shebang: &wasmtime::TypedFunc<(u32, u32, u32, u32), i64>,
    wait_table: &Arc<Mutex<WaitTable>>,
    use_fork_module: bool,
    fork_proof_of_use: &Arc<Mutex<ForkProofOfUse>>,
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
    let Some(blob_scratch) =
        KernelScratch::allocate_or_none(&*alloc_scratch, &mut *kernel_store, blob_len as u32)?
    else {
        return fail_spawn(&guest_mem, kernel_mem, ch, args, libc_errno::ENOMEM);
    };
    blob_scratch.write(kernel_mem, &blob_bytes)?;
    let scratch = blob_scratch.ptr() as u32 as usize;
    // Second argument is the REGION's capacity, not the blob's length: the
    // kernel refuses `blob_len > buf_capacity`, and feeding it `blob_len`
    // twice is what made that refusal unable to fire.
    let decoded_len = spawn_blob_decode.call(
        &mut *kernel_store,
        (scratch as i32, blob_scratch.capacity() as i32, blob_len as i32),
    )?;
    if decoded_len < 0 {
        return fail_spawn(&guest_mem, kernel_mem, ch, args, -decoded_len);
    }
    let (argv_list, envp_list) = read_decoded_argv_envp(kernel_mem, scratch);

    // `kernel_spawn_blob_decode` overwrote `scratch` in place; re-stage the
    // untouched RAW blob bytes before `kernel_spawn_process`'s own parse.
    // Through the region, like the first staging above: a bare
    // `write_bytes` here would be the same unchecked copy L-D1 filed.
    blob_scratch.write(kernel_mem, &blob_bytes)?;
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
    let Some(path_scratch) = KernelScratch::allocate_or_none(
        &*alloc_scratch,
        &mut *kernel_store,
        resolve_bytes.len() as u32,
    )?
    else {
        rollback_spawned_child(kernel_store, remove_process, child_pid, "a scratch-allocation failure resolving the exec target");
        return fail_spawn(&guest_mem, kernel_mem, ch, args, libc_errno::ENOMEM);
    };
    path_scratch.write(kernel_mem, resolve_bytes)?;

    let token = spawn_exec_target_prepare.call(
        &mut *kernel_store,
        (
            parent_pid,
            child_pid,
            path_scratch.ptr() as u32,
            path_scratch.capacity(),
        ),
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
    let Some(read_scratch) = KernelScratch::allocate_or_none(
        &*alloc_scratch,
        &mut *kernel_store,
        EXEC_TARGET_READ_CHUNK,
    )?
    else {
        rollback_exec_target(
            kernel_store, exec_target_cancel, remove_process, child_pid, token,
            "a scratch-allocation failure reading the exec target",
        );
        return fail_spawn(&guest_mem, kernel_mem, ch, args, libc_errno::ENOMEM);
    };
    let program_bytes = match read_exec_target_bytes(
        kernel_store,
        kernel_mem,
        exec_target_size,
        exec_target_read,
        read_scratch.ptr() as u32,
        read_scratch.capacity(),
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
    let child_module = match guest_module_for_this_epoch(engine, &program_bytes) {
        Ok(module) => module,
        Err(_) => {
            rollback_exec_target(
                kernel_store, exec_target_cancel, remove_process, child_pid, token,
                "a rejected exec target (a different ABI epoch, or non-wasm bytes)",
            );
            return fail_spawn(&guest_mem, kernel_mem, ch, args, libc_errno::ENOEXEC);
        }
    };
    // N1-I4 Task 3: computed from THIS child's own raw bytes (a spawned
    // child can run a different program than its parent — see
    // `GuestProcess::module`'s doc comment — so it never reuses the
    // parent's `fork_format`).
    let child_fork_format = compute_guest_fork_format(&program_bytes)?.map(Arc::new);

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
    let (child_mem, child_layout) = compute_guest_memory(engine, &child_module, &program_bytes)?;
    let child_import_exit_status = Arc::new(Mutex::new(None::<i32>));
    let child = launch_process(
        engine,
        kernel_store,
        alloc_scratch,
        set_thread_slot_quota,
        set_brk_base,
        set_mmap_base,
        set_max_addr,
        set_pointer_width,
        child_module,
        child_mem,
        child_layout,
        child_pid,
        child_import_exit_status,
        Arc::new(argv_list),
        Arc::new(envp_list),
        use_fork_module,
        ForkEntry::Normal, // a posix_spawn child is a fresh image, never a fork replay
        child_fork_format,
        Arc::clone(fork_proof_of_use),
        false, // a fresh spawn image: register its data model
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

/// N1-I4 Task 2/3: intercept a `SYS_FORK`/`SYS_VFORK` request the guest's own
/// `kernel_fork` import closure (`spawn_guest_thread`) posted on its main
/// channel — for a fork-instrumented parent (Task 3), this is posted only
/// AFTER `run_fork_capable_entry` already drove the full capture (the
/// parent's live frames already spilled into the fork-module, its journal
/// already sealed and serialized); for a non-instrumented parent (Task 2's
/// original scope), it is posted immediately, with no capture at all. Drives
/// the FULL child-identity + private-memory-copy + co-resident-module setup:
///
///  1. `kernel_fork_process(parent_pid, caller_tid, mode)` allocates the
///     child's kernel-side `Process` record (a real clone: signal mask,
///     credentials, ...) under a freshly allocated child pid.
///  2. [`clone_guest_memory`] makes a PRIVATE byte-for-byte copy of the
///     PARENT's CURRENT guest memory into a FRESH `SharedMemory` — never
///     shared, unlike I3a's thread clone. For an instrumented parent this
///     copy ALSO carries every spilled frame and the serialized journal
///     image, since the fork-module shares the SAME guest memory.
///  3. [`launch_process`] (the SAME helper `handle_spawn`/`run_guest`'s boot
///     path use) creates the child's guest `Instance` over that copy, under
///     the child pid, with a co-resident fork-module when `use_fork_module`.
///     `fork_entry` (computed above from `fork_format` + this channel's
///     smuggled root/image fields — see this function's body) tells
///     `run_fork_capable_entry` whether the child can drive a REAL
///     `fm_begin_child_replay` (Task 3) or must fall back to the legacy
///     `ChildPendingStub` (Task 2's original behavior, preserved for a
///     non-instrumented `use_fork_module` guest).
///
/// The kernel, not this function, decides the PARENT's result (lane F step
/// 2). A `kernel_fork_process` refusal creates nothing and is answered at
/// once. Otherwise the parent's request stays `STATUS_PENDING` in
/// `parked_forks` and `complete_parked_fork_parents` answers it from the
/// kernel's fork-lifecycle record: the child pid once the child's replay
/// reports `SYS_FORK_REPLAY_READY` (or the child dies first, or, for vfork,
/// once the borrowed image is released), or `-errno` once a launch failure
/// is reported. Every host-side failure before the child's thread starts
/// (region layout, memory clone, launch) is reported through
/// `kernel_fork_launch_failed(ENOMEM)`; nothing here removes the child.
#[allow(clippy::too_many_arguments)]
fn handle_fork(
    kernel_store: &mut Store<()>,
    engine: &Engine,
    kernel_mem: &SharedMemory,
    processes: &mut Vec<GuestProcess>,
    pi: usize,
    ch: PumpChannel,
    syscall_nr: u32,
    args: &[i64; 6],
    launch: &ForkLaunchKernel,
    parked_forks: &mut Vec<ParkedForkParent>,
    fork_child_launch_signal: Option<u32>,
    alloc_scratch: &wasmtime::TypedFunc<u32, i32>,
    set_thread_slot_quota: &wasmtime::TypedFunc<(u32, u32), i32>,
    set_brk_base: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_mmap_base: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_max_addr: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_pointer_width: &wasmtime::TypedFunc<(u32, u32), i32>,
    use_fork_module: bool,
    fork_proof_of_use: &Arc<Mutex<ForkProofOfUse>>,
    wait_table: &Arc<Mutex<WaitTable>>,
) -> anyhow::Result<()> {
    let parent_pid = processes[pi].pid;
    let caller_tid = ch.tid;
    let scratch_ptr = processes[pi].scratch_base;
    let guest_mem = processes[pi].memory.clone();
    let mode = args[0] as u32;
    let fork_format = processes[pi].fork_format.clone();

    // N1-I4 Task 3: for a fork-instrumented parent, the entry loop (via
    // `drive_fork_capture_seal_and_launch_child`) already drove the FULL
    // capture -- the parent's frames and references are already in the fork
    // module's arena and its journal serialized -- before posting THIS request,
    // and `begin_fork_capture` published the launch root in the forking
    // thread's fork control word. Read it back NOW, from the PARENT's still
    // intact memory, as the JavaScript kernel worker reads `forkBufAddr`
    // (`readForkContinuationAnchor`); the child's copy, taken below, inherits
    // the same bytes. A non-instrumented parent (`fork_format == None`) never
    // publishes one -- its `kernel_fork` took the direct-passthrough branch --
    // so its child launches via the legacy `ChildPendingStub` instead.
    let fork_entry = match fork_format.as_ref() {
        Some(_) => {
            let root = unsafe { read_u32(&guest_mem, fork_control_word(ch.offset)) };
            if root == 0 {
                eprintln!(
                    "[host-native] fork pid={parent_pid}: no launch root was published; \
                     falling back to the legacy pending-replay stub for the child"
                );
                ForkEntry::ChildPendingStub
            } else {
                ForkEntry::ChildReplay { root }
            }
        }
        None => ForkEntry::ChildPendingStub,
    };

    let child_pid = launch.fork_process.call(&mut *kernel_store, (parent_pid, caller_tid, mode))?;
    if child_pid <= 0 {
        let errno = if child_pid < 0 { -child_pid } else { libc_errno::EAGAIN };
        return complete_channel(
            &guest_mem, kernel_mem, scratch_ptr, ch, syscall_nr, args, &[], -1, errno as u32,
        );
    }
    let child_pid = child_pid as u32;
    // From here the kernel owns the parent's result: park the request.
    parked_forks.push(ParkedForkParent {
        child_pid,
        process_index: pi,
        parent_mem: guest_mem.clone(),
        scratch_ptr,
        ch,
        syscall_nr,
        args: *args,
    });

    let layout = processes[pi].layout;

    // Real vfork (N1 residual): a fork-instrumented parent's `vfork()` gets
    // a genuinely BORROWED child instead of the ordinary COW path below —
    // the child shares the parent's OWN `SharedMemory` handle (never
    // `clone_guest_memory`'s private byte-copy). The parent stays parked
    // until the kernel completes it: after this child's exec or exit, once
    // this host proved the child's threads joined and released the image
    // (`release_vfork_address_space`) — real POSIX vfork semantics. A
    // NON-instrumented guest's vfork
    // (`ForkEntry::ChildPendingStub`) has no coordinator to drive a real
    // borrowed replay and falls through to the ordinary COW path below,
    // unchanged from this host's pre-existing (POSIX-permissible, if
    // weaker) behavior for that case.
    if mode == MODE_VFORK {
        if let ForkEntry::ChildReplay { root } = fork_entry {
            let vregion = match compute_vfork_borrowed_region(&layout) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[host-native] vfork {child_pid}: borrowed-region layout failed: {e:#}");
                    return report_fork_launch_failed(kernel_store, launch, child_pid, libc_errno::ENOMEM);
                }
            };
            // Defensive: `launch_process`'s own `kernel_set_max_addr` already
            // reserves this whole range, and instantiating the PARENT's own
            // fork-module already grew `guest_mem` all the way to
            // `layout.max_addr` (which covers every byte below it) — this is
            // a cheap, idempotent insurance call, not new growth in practice.
            grow_to_cover(&guest_mem, layout.max_addr)?;
            unsafe {
                write_bytes(&guest_mem, vregion.channel_offset, &vec![0u8; MIN_CHANNEL_SIZE]);
            }
            let child_mem = guest_mem.clone();
            let child_module = processes[pi].module.clone();
            let borrowed_entry = ForkEntry::ChildBorrowedReplay {
                root,
                private_prefix: vregion.private_prefix as u32,
                owner_control: fork_control_word(layout.channel_offset) as u32,
            };
            wait_table.lock().unwrap().parent_of.insert(child_pid, parent_pid);
            let launched = launch_vfork_borrowed_child(
                engine,
                kernel_store,
                alloc_scratch,
                set_thread_slot_quota,
                set_brk_base,
                set_mmap_base,
                set_max_addr,
                set_pointer_width,
                child_module,
                child_mem,
                layout,
                &vregion,
                child_pid,
                borrowed_entry,
                fork_format.clone(),
                Arc::clone(fork_proof_of_use),
            );
            let child = match launched {
                Ok(c) => c,
                Err(e) => {
                    // The child's thread never started (the launch spawns it
                    // last), so no realm touched the borrowed image.
                    eprintln!("[host-native] vfork child {child_pid} launch failed: {e:#}");
                    wait_table.lock().unwrap().parent_of.remove(&child_pid);
                    return report_fork_launch_failed(kernel_store, launch, child_pid, libc_errno::ENOMEM);
                }
            };
            processes.push(child);
            return signal_fork_child_on_launch(kernel_store, launch, child_pid, fork_child_launch_signal);
        }
    }

    let child_mem = match clone_guest_memory(engine, &guest_mem) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[host-native] fork child {child_pid} memory clone failed: {e:#}");
            return report_fork_launch_failed(kernel_store, launch, child_pid, libc_errno::ENOMEM);
        }
    };
    // The byte-for-byte copy above ALSO copied the parent's own channel
    // header, including the very `SYS_FORK` request (still `STATUS_PENDING`)
    // this function is servicing right now. `processes.push(child)` below
    // makes the child's channel visible to `run_pump`'s scanning loop
    // immediately — concurrently with, and possibly BEFORE, the child's own
    // OS thread (spawned inside `launch_process`, which still has to
    // instantiate a fork-module and compile/instantiate the guest module)
    // ever reaches `post_fork_child_pending_exit`. Left uncleared, the pump
    // would misread that stale copied `SYS_FORK` as a FRESH request from the
    // child and recursively fork it again — a self-sustaining process
    // explosion with no real guest code involved (observed: 30s hard-cap
    // bail with 150+ processes before this fix). Zero the copied main
    // channel's header now, synchronously, before `launch_process` even
    // spawns that thread — mirrors the Node reference host's OWN identical
    // defensive zero (`host/src/node-kernel-worker-entry.ts`'s
    // `handleOrdinaryFork`: `new Uint8Array(childMemory.buffer,
    // childChannelOffset, CH_TOTAL_SIZE).fill(0)`).
    unsafe { write_bytes(&child_mem, layout.channel_offset, &vec![0u8; MIN_CHANNEL_SIZE]) };

    // N1-I4 Task 3 (bootstrap-fix follow-up): register the child as
    // waitable by its REAL parent — mirrors `handle_spawn`'s identical
    // `parent_of.insert` (N1-I3a Task 3's original `host_waitpid`
    // contract). This was MISSING from `handle_fork` entirely: no test
    // before this task ever reached a genuinely-replayed `waitpid()` call
    // against a real fork child, so the gap was invisible — `host_waitpid`
    // silently returned `-ECHILD` for a legitimate, live fork child (its
    // `parent_of` map simply had no entry for it), which musl's `waitpid()`
    // wrapper surfaces as an immediate `-1`/`ECHILD` failure with `*status`
    // left UNTOUCHED — exactly why the parent's `WEXITSTATUS(st)` read back
    // `0` from `st`'s zero-initialized stack slot instead of ever blocking
    // for (and reaping) the child's real `_exit(3)`. Must happen before
    // returning, same reasoning as `handle_spawn`'s: the child's own OS
    // thread is about to start running concurrently and could exit before
    // this function returns.
    wait_table.lock().unwrap().parent_of.insert(child_pid, parent_pid);

    let child_module = processes[pi].module.clone();
    let child_import_exit_status = Arc::new(Mutex::new(None::<i32>));
    let child = launch_process(
        engine,
        kernel_store,
        alloc_scratch,
        set_thread_slot_quota,
        set_brk_base,
        set_mmap_base,
        set_max_addr,
        set_pointer_width,
        child_module,
        child_mem,
        layout,
        child_pid,
        child_import_exit_status,
        Arc::new(Vec::new()),
        Arc::new(Vec::new()),
        use_fork_module,
        fork_entry,
        fork_format,
        Arc::clone(fork_proof_of_use),
        false, // a fork child's address space is new to this host
    );
    let child = match child {
        Ok(c) => c,
        Err(e) => {
            // `launch_process` spawns the child's thread last, so no realm
            // started: a truthful launch failure, not a host abort.
            eprintln!("[host-native] fork child {child_pid} launch failed: {e:#}");
            wait_table.lock().unwrap().parent_of.remove(&child_pid);
            return report_fork_launch_failed(kernel_store, launch, child_pid, libc_errno::ENOMEM);
        }
    };
    processes.push(child);

    // POSIX: fork() returns the child's pid to the PARENT, but only once the
    // kernel decides it (the child's replay-ready report, or its death).
    signal_fork_child_on_launch(kernel_store, launch, child_pid, fork_child_launch_signal)
}

/// Test hook: deliver `signal` to a fork child right after this host
/// registered it and started its thread, before its replay can report
/// `SYS_FORK_REPLAY_READY` -- the native mate of `onForkChildRegistered` in
/// `host/test/centralized-test-helper.ts`. `None` (every production run)
/// does nothing. The pump is single-threaded, so the child cannot reach its
/// replay-ready request before this returns.
fn signal_fork_child_on_launch(
    kernel_store: &mut Store<()>,
    launch: &ForkLaunchKernel,
    child_pid: u32,
    signal: Option<u32>,
) -> anyhow::Result<()> {
    let Some(signal) = signal else {
        return Ok(());
    };
    let rc = launch.generate_host_signal.call(&mut *kernel_store, (child_pid, signal))?;
    anyhow::ensure!(rc == 0, "kernel_generate_host_signal({child_pid}, {signal}) failed: {rc}");
    Ok(())
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
    set_thread_slot_quota: &wasmtime::TypedFunc<(u32, u32), i32>,
    set_brk_base: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_mmap_base: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_max_addr: &wasmtime::TypedFunc<(u32, i32), i32>,
    set_pointer_width: &wasmtime::TypedFunc<(u32, u32), i32>,
    exec_target_prepare: &wasmtime::TypedFunc<(u32, u32, i32, u32, u32, u32), i32>,
    exec_target_size: &wasmtime::TypedFunc<(u32, u32), i64>,
    exec_target_read: &wasmtime::TypedFunc<(u32, u32, u32, i32, u32, u32), i32>,
    exec_commit: &wasmtime::TypedFunc<(u32, u32, u32), i32>,
    exec_target_cancel: &wasmtime::TypedFunc<(u32, u32), i32>,
    exec_target_resolve_shebang: &wasmtime::TypedFunc<(u32, u32, u32, u32), i64>,
    remove_process: &wasmtime::TypedFunc<u32, i32>,
    launch: &ForkLaunchKernel,
    wait_table: &Arc<Mutex<WaitTable>>,
    use_fork_module: bool,
    fork_proof_of_use: &Arc<Mutex<ForkProofOfUse>>,
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
    let Some(path_scratch) = KernelScratch::allocate_or_none(
        &*alloc_scratch,
        &mut *kernel_store,
        path_bytes.len() as u32,
    )?
    else {
        return fail_exec(&guest_mem, kernel_mem, ch, syscall_nr, args, libc_errno::ENOMEM).map(|()| None);
    };
    path_scratch.write(kernel_mem, &path_bytes)?;

    let token = exec_target_prepare.call(
        &mut *kernel_store,
        (
            pid,
            caller_tid,
            dirfd,
            path_scratch.ptr() as u32,
            path_scratch.capacity(),
            flags,
        ),
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

    let Some(read_scratch) = KernelScratch::allocate_or_none(
        &*alloc_scratch,
        &mut *kernel_store,
        EXEC_TARGET_READ_CHUNK,
    )?
    else {
        cancel_exec_target(kernel_store, exec_target_cancel, pid, token, "a scratch-allocation failure");
        return fail_exec(&guest_mem, kernel_mem, ch, syscall_nr, args, libc_errno::ENOMEM).map(|()| None);
    };
    let program_bytes = match read_exec_target_bytes(
        kernel_store,
        kernel_mem,
        exec_target_size,
        exec_target_read,
        read_scratch.ptr() as u32,
        read_scratch.capacity(),
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
    let new_module = match guest_module_for_this_epoch(engine, &program_bytes) {
        Ok(module) => module,
        Err(_) => {
            cancel_exec_target(
                kernel_store, exec_target_cancel, pid, token,
                "a rejected exec target (a different ABI epoch, or non-wasm bytes)",
            );
            return fail_exec(&guest_mem, kernel_mem, ch, syscall_nr, args, libc_errno::ENOEXEC)
                .map(|()| None);
        }
    };
    // N1-I4 Task 3: computed from THIS new image's own raw bytes — an
    // execve'd image can be fork-instrumented even if the process it
    // replaces was not (or vice versa), so it never reuses `processes[pi]`'s
    // OLD `fork_format`. A well-formed wasm module (already proven by the
    // `Module::new` success above) with a corrupt KLCF/KFRC custom section
    // is treated the same as a compile failure: cancel the retained target
    // and resume the caller with `ENOEXEC` rather than letting a parse error
    // `?`-propagate into a pump-ending `bail!`.
    let new_fork_format = match compute_guest_fork_format(&program_bytes) {
        Ok(f) => f.map(Arc::new),
        Err(_) => {
            cancel_exec_target(
                kernel_store, exec_target_cancel, pid, token,
                "a compute_guest_fork_format failure (malformed fork-instrumentation metadata)",
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
    let (new_mem, new_layout) = match compute_guest_memory(engine, &new_module, &program_bytes) {
        Ok(v) => v,
        Err(error) => {
            return Ok(Some(terminate_process_after_failed_exec_commit(
                kernel_store, processes, pi, pid, remove_process, launch, wait_table,
                "compute_guest_memory", &error,
            )));
        }
    };
    let new_proc = match launch_process(
        engine,
        kernel_store,
        alloc_scratch,
        set_thread_slot_quota,
        set_brk_base,
        set_mmap_base,
        set_max_addr,
        set_pointer_width,
        new_module,
        new_mem,
        new_layout,
        pid,
        Arc::new(Mutex::new(None)),
        Arc::new(argv_list),
        Arc::new(envp_list),
        use_fork_module,
        ForkEntry::Normal, // an exec'd image is never itself a fork replay
        new_fork_format,
        Arc::clone(fork_proof_of_use),
        true, // exec: the kernel already replaced the width at commit
    ) {
        Ok(v) => v,
        Err(error) => {
            return Ok(Some(terminate_process_after_failed_exec_commit(
                kernel_store, processes, pi, pid, remove_process, launch, wait_table,
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
    //
    // `pid` may be a vfork child that borrowed its parent's image. The exec
    // commit already ended that borrow in the kernel; once the old image's
    // threads are joined, report the release so the kernel can complete the
    // parked parent (or contain both images if a thread could not be joined).
    let old_proc = std::mem::replace(&mut processes[pi], new_proc);
    let quiescent = reclaim_all_channels(old_proc);
    release_vfork_address_space(kernel_store, launch, pid, quiescent)?;
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
    launch: &ForkLaunchKernel,
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
    // Never leave a vfork parent parked forever, even on this rare path: tear
    // down the old image's parked threads, then report the release. `pid`
    // may have borrowed its parent's image; the kernel decides.
    let proc_ = &mut processes[pi];
    let memory = proc_.memory.clone();
    let mut quiescent = true;
    for ch in proc_.channels.clone() {
        let status =
            unsafe { atomic_u32(&memory, ch.offset + STATUS_OFFSET) }.load(Ordering::SeqCst);
        if status == STATUS_PENDING {
            teardown_parked_thread(proc_, &ch);
        } else {
            quiescent = false;
        }
    }
    proc_.channels.clear();
    if let Err(e) = release_vfork_address_space(kernel_store, launch, pid, quiescent) {
        eprintln!(
            "[host-native] releasing a vfork borrow after a post-commit {stage} failure \
             failed: {e:#}"
        );
    }
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
    let Some(out_scratch) =
        KernelScratch::allocate_or_none(&*alloc_scratch, &mut *kernel_store, SHEBANG_RECORD_SCRATCH)?
    else {
        return Ok(Err(ShebangError::ScratchAlloc(libc_errno::ENOMEM)));
    };
    let out_ptr = out_scratch.ptr() as u32;

    let result = resolve_fn.call(
        &mut *kernel_store,
        (owner_pid, token, out_ptr, out_scratch.capacity()),
    )?;
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
    pointer_width: u8,
) -> anyhow::Result<Vec<StagedArg>> {
    let mut staged = Vec::new();
    let mut cursor = 0usize;
    for d in &arg_descriptors(syscall_nr) {
        if d.copy_out_length.is_some() {
            anyhow::bail!("syscall {syscall_nr}: copy_out_length special-case not implemented");
        }
        let idx = d.arg_index as usize;
        // A kernel-dereferenced argument is not staged at all: the kernel
        // reads and writes the caller's memory itself through
        // `host_proc_read_bytes`/`host_proc_write_bytes`, which this host
        // already provides. Leave the guest address in place; the caller's
        // data model is the process's registered pointer width, which the
        // kernel looks up for itself — the one this host registered from the
        // same `ProcessLayout` that `pointer_width` above came from.
        if d.size == SyscallArgSize::KernelDereferenced {
            continue;
        }
        // A wasm32 guest address is the low 32 bits (an i32 the guest may have
        // sign-extended into the channel slot); a wasm64 one is the whole
        // word. Truncating a wasm64 address to 32 bits would silently alias it
        // to a different page, so the width decides the mask.
        let guest_ptr = if pointer_width == 8 {
            args[idx] as u64 as usize
        } else {
            args[idx] as u32 as usize
        };
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
            // A caller-native record: the byte count is a property of the
            // CALLING PROCESS's data model, not of this syscall's arguments.
            // The rule is the one `host/src/kernel-worker.ts` applies
            // (`pointerWidth === 8 ? wasm64Size : wasm32Size`), and the kernel
            // selects the matching parse from the same process's registered
            // pointer width on its side of the channel.
            //
            // B27b: this used to resolve to `wasm32_size` unconditionally, on
            // the stated grounds that the host runs wasm32 guests only. It now
            // reads the CALLING process's own width — the same value this host
            // registered with `kernel_set_process_pointer_width` at launch, so
            // the two sides of the channel select from one fact rather than
            // from two independent assumptions about the guest.
            SyscallArgSize::ProcessLayout { wasm32_size, wasm64_size } => {
                if pointer_width == 8 { wasm64_size as usize } else { wasm32_size as usize }
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
    buf_ptr: u64,
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
    // The TS `copyEntry` this mirrors proves the range before it copies and
    // turns a refusal into `-EFAULT`. The transcription kept every errno and
    // dropped the proof, so a `buf_ptr` inside wasm32 but past the end of
    // this memory reached `copy_nonoverlapping` -- undefined behaviour here,
    // where the JavaScript host gets a `RangeError` from the engine and
    // answers `-EFAULT`. Same rule, same errno, now on both sides.
    let Some(offset) = checked_shared_range(guest_mem, buf_ptr, len as u32) else {
        return -libc_errno::EFAULT;
    };
    unsafe { write_bytes(guest_mem, offset, entry) };
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
    pub const ESRCH: i32 = 3;
    pub const EAGAIN: i32 = 11;
    pub const EACCES: i32 = 13;
    pub const EEXIST: i32 = 17;
    pub const ENOTDIR: i32 = 20;
    pub const EISDIR: i32 = 21;
    pub const EINVAL: i32 = 22;
    pub const ERANGE: i32 = 34;
    pub const ENOSYS: i32 = 38;
}

/// N1-I4 Task 1: the co-resident fork-module (PIC side module) instantiation
/// smoke test. Lives here (not `lib.rs`) rather than in `crate::tests`
/// because it needs this module's private `ProcessLayout`/
/// `compute_guest_memory` — the SAME cross-module-privacy convention
/// `base_image_tests` above already uses for this file's other test-only
/// access to private items.
#[cfg(test)]
mod fork_module_tests {
    use super::*;
    use std::path::PathBuf;

    /// Mirrors `lib.rs`'s `kernel_path_or_skip`: a fresh checkout without the
    /// locally-built fork-module artifact skips (with a clear message)
    /// rather than failing with an obscure file-not-found panic. Building it
    /// is not this test's job — see `crates/fork-module/build-wasm.sh`.
    fn fork_module_path_or_skip() -> Option<PathBuf> {
        let path = crate::fork_module_path();
        if path.exists() {
            Some(path)
        } else {
            eprintln!(
                "SKIP fork-module smoke test: {} not found.\n  Build it with:\n    \
                 scripts/dev-shell.sh bash crates/fork-module/build-wasm.sh",
                path.display()
            );
            None
        }
    }

    /// The PRIMARY-RISK proof for N1-I4: Wasmtime can instantiate the
    /// `fork-module` PIC side module co-resident with a guest, sharing the
    /// guest's `SharedMemory` as `env.memory`, with the placement globals +
    /// inert reference-import stubs `instantiate_fork_module` supplies — and
    /// a real coordinator call (`fm_set_format`) then succeeds against that
    /// instance. This does not run the guest program itself (Task 1 is
    /// instantiation-only — see `instantiate_fork_module`'s doc comment);
    /// `compute_guest_memory` against the SAME committed `native_hello.wasm`
    /// fixture `run_trivial_guest` uses elsewhere gives a real, correctly
    /// laid-out guest `SharedMemory`/`ProcessLayout` to instantiate against.
    #[test]
    fn smoke_instantiates_fork_module() -> anyhow::Result<()> {
        let Some(_fork_module_path) = fork_module_path_or_skip() else {
            return Ok(());
        };

        let engine = crate::kernel_engine()?;
        let guest_wasm = crate::fixtures::fixture("native_hello.wasm");
        let guest_module = Module::new(&engine, guest_wasm)?;
        let (guest_mem, layout) = compute_guest_memory(&engine, &guest_module, guest_wasm)?;

        let mut fm_store = Store::new(&engine, ());
        let fork_module = instantiate_fork_module(&engine, &mut fm_store, &guest_mem, &layout)?;

        assert!(fork_module.region_bytes > 0, "expected a non-empty reserved region");
        assert!(
            fork_module.memory_base + fork_module.region_bytes <= layout.max_addr,
            "reserved region [0x{:x}, +0x{:x}) must not exceed max_addr 0x{:x}",
            fork_module.memory_base,
            fork_module.region_bytes,
            layout.max_addr,
        );

        // A benign coordinator call: seed the linked-frame format for a
        // wasm32 guest (pointer_width = 4) with no fixed prefix. Success
        // (fm_last_errno() == 0) proves the instance is not just linked but
        // genuinely executable: the call reaches real fork-module code,
        // which itself only works if the module's start function already
        // relocated its passive data segments into the reserved region.
        fork_module.fm_set_format.call(&mut fm_store, (4, 0, 0, 0))?;
        let errno = fork_module.fm_last_errno.call(&mut fm_store, ())?;
        assert_eq!(errno, 0, "fm_set_format(4, 0, 0, 0) must succeed on a wasm32 guest");

        Ok(())
    }

    /// An exec has a point of no return before its new image's worker admits,
    /// so a malformed fork section must be found while the exec can still
    /// answer ENOEXEC -- by the module's own decoder, run on the descriptor
    /// the worker would stage. A module with no fork sections is simply not
    /// fork-instrumented.
    #[test]
    fn a_malformed_fork_section_is_found_before_launch() -> anyhow::Result<()> {
        let plain = wat::parse_str("(module)")?;
        assert!(compute_guest_fork_format(&plain)?.is_none());
        let malformed = wat::parse_str(r#"(module (@custom "kandelo.wpk_fork.linked_frames" "\de\ad"))"#)?;
        let err = compute_guest_fork_format(&malformed).expect_err("a malformed section must be refused");
        assert!(format!("{err:#}").contains("fork admission refused"), "got: {err:#}");
        Ok(())
    }

    /// A guest instance shaped like the two exports `place_resume_thunks`
    /// reads, and nothing else.
    ///
    /// Deliberately NOT an SDK-built guest. What is under test is the HOST's
    /// guard, which reads exactly two things off the instance: the LENGTH of
    /// `__wpk_fork_resume_catalog`, and whether
    /// `__wpk_fork_place_resume_thunks` is there. A real fork-instrumented
    /// artifact would pin those to whatever its own instrumentation produced,
    /// which is the opposite of what a guard test needs -- it needs to state
    /// the mismatch.
    fn stand_in_guest(
        engine: &Engine,
        store: &mut Store<()>,
        catalog_len: u32,
        with_shim: bool,
    ) -> anyhow::Result<Instance> {
        let shim = if with_shim {
            r#"(func (export "__wpk_fork_place_resume_thunks")
                 (param i32 i32) (result i32) (local.get 1))"#
        } else {
            ""
        };
        let wat = format!(
            r#"(module
                 (table (export "__wpk_fork_resume_catalog") {catalog_len} funcref)
                 {shim})"#
        );
        let module = Module::new(engine, &wat)?;
        Ok(Linker::new(engine).instantiate(store, &module)?)
    }

    /// THE COUNT-ZERO DIRECTION of the same-artifact guard, on the host that
    /// used to skip it.
    ///
    /// A resume slot is an index into the table a forked guest
    /// `call_indirect`s through, and the emitted placement shim uses a
    /// published record's ORDINAL as an index into the guest's own catalog
    /// table. So a module seeded from one artifact and a guest instantiated
    /// from another has to be caught, and both hosts catch it by comparing
    /// the module's assigned count against the guest's catalog length.
    ///
    /// `place_resume_thunks` used to return early when that count was ZERO,
    /// ahead of the comparison. "The module assigned nothing" and "this guest
    /// has nothing to place" are different facts: an empty seeded ordinal set
    /// against an instance exporting two thunks is a MISMATCH, not an empty
    /// activation. With the early return, this host accepted it silently and
    /// left a bare `undefined element` trap to surface inside a fork child
    /// later, while the JavaScript host named it
    /// (`host/test/fork-resume-table.test.ts`, "refuses a guest with thunks
    /// the module was seeded with NONE of").
    ///
    /// The three cases below are the whole of the guard: a mismatch is
    /// refused by name, a genuine empty activation is accepted, and the
    /// shim-export check is reached at count zero too.
    #[test]
    fn place_resume_thunks_checks_the_artifact_even_when_nothing_was_assigned(
    ) -> anyhow::Result<()> {
        let engine = crate::kernel_engine()?;
        let mut store = Store::new(&engine, ());

        // 1. TWO thunks against an assignment of none: refused, by name.
        let mismatched = stand_in_guest(&engine, &mut store, 2, true)?;
        let err = place_resume_thunks(&mut store, &mismatched, 0, 0, 0)
            .expect_err("a guest with 2 thunks and a module seeded with none must be refused");
        let text = format!("{err:#}");
        assert!(
            text.contains("not the same artifact"),
            "the refusal must name the cause, got: {text}"
        );
        assert!(
            text.contains("instantiated with 2 resume thunks"),
            "the refusal must carry both counts, got: {text}"
        );

        // 2. A GENUINE empty activation is still a success. A side module
        //    with no fork-instrumented function seeds an empty resume catalog
        //    and holds no slots -- `libneeded-provider.so` in
        //    `fork-from-dlopen-side-module-e2e` is exactly that, and reading
        //    it as an error once cost a real fork. So the guard must refuse
        //    the mismatch above WITHOUT refusing this.
        let empty = stand_in_guest(&engine, &mut store, 0, true)?;
        place_resume_thunks(&mut store, &empty, 0, 0, 0)
            .expect("an activation that holds no slots is a success, not an error");

        // 3. The placement-shim check is reached at count zero as well. Both
        //    of this function's named diagnostics are unconditional, the way
        //    `ForkResumeTable.registerActivation` has always applied them; an
        //    early return would have skipped this one too.
        let without_shim = stand_in_guest(&engine, &mut store, 0, false)?;
        let err = place_resume_thunks(&mut store, &without_shim, 0, 0, 0)
            .expect_err("a guest with no placement shim cannot place its own thunks");
        assert!(
            format!("{err:#}").contains("exports no __wpk_fork_place_resume_thunks"),
            "the refusal must name the missing export, got: {err:#}"
        );

        Ok(())
    }

    /// N1-F6: regenerates `native_fork_gc_struct_cycle.wasm` from the
    /// reviewed `.wat` source. WHY a Rust generator, not the dev shell's
    /// WABT `wat2wasm`: WABT does not accept current Wasm-GC syntax even
    /// with `--enable-gc` (no `ref.i31`, `i31.get_s`) — see
    /// `host/test/fixtures/gc-reference-cycle-fresh-worker-bytes.ts`'s own
    /// doc comment for the same constraint on the TypeScript side. The Rust
    /// `wat` crate (already a dev-dependency here) compiles it fine.
    /// Regenerate with (from repo root, inside `scripts/dev-shell.sh`):
    ///   cargo test -p host-native --lib -- --ignored \
    ///     regenerate_native_fork_gc_struct_cycle_fixture --nocapture
    /// then run `scripts/run-wasm-fork-instrument.sh` on the written
    /// `.wasm` — see the `.wat` file's own doc comment for the exact
    /// command.
    #[test]
    #[ignore = "writes crates/host-native/fixtures/native_fork_gc_struct_cycle.wasm"]
    fn regenerate_native_fork_gc_struct_cycle_fixture() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures");
        let wat_path = dir.join("native_fork_gc_struct_cycle.wat");
        let wat_src = std::fs::read_to_string(&wat_path)
            .unwrap_or_else(|e| panic!("read {}: {e}", wat_path.display()));
        let wasm = wat::parse_str(&wat_src).expect("compile native_fork_gc_struct_cycle.wat");
        let out_path = dir.join("native_fork_gc_struct_cycle.wasm");
        std::fs::write(&out_path, &wasm)
            .unwrap_or_else(|e| panic!("write {}: {e}", out_path.display()));
        eprintln!("wrote {} ({} bytes)", out_path.display(), wasm.len());
    }

    /// N1-F6 SETTLING EXPERIMENT: regenerates
    /// `native_fork_gc_two_object_cycle.wasm` from the reviewed `.wat`
    /// source. See [`regenerate_native_fork_gc_struct_cycle_fixture`]'s doc
    /// comment for why a Rust generator, not WABT.
    #[test]
    #[ignore = "writes crates/host-native/fixtures/native_fork_gc_two_object_cycle.wasm"]
    fn regenerate_native_fork_gc_two_object_cycle_fixture() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures");
        let wat_path = dir.join("native_fork_gc_two_object_cycle.wat");
        let wat_src = std::fs::read_to_string(&wat_path)
            .unwrap_or_else(|e| panic!("read {}: {e}", wat_path.display()));
        let wasm = wat::parse_str(&wat_src).expect("compile native_fork_gc_two_object_cycle.wat");
        let out_path = dir.join("native_fork_gc_two_object_cycle.wasm");
        std::fs::write(&out_path, &wasm)
            .unwrap_or_else(|e| panic!("write {}: {e}", out_path.display()));
        eprintln!("wrote {} ({} bytes)", out_path.display(), wasm.len());
    }

    /// N1-F6 Task 5 (array un-gate): regenerates
    /// `native_fork_gc_array_cycle.wasm` from the reviewed `.wat` source.
    /// See [`regenerate_native_fork_gc_struct_cycle_fixture`]'s doc comment
    /// for why a Rust generator, not WABT.
    #[test]
    #[ignore = "writes crates/host-native/fixtures/native_fork_gc_array_cycle.wasm"]
    fn regenerate_native_fork_gc_array_cycle_fixture() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures");
        let wat_path = dir.join("native_fork_gc_array_cycle.wat");
        let wat_src = std::fs::read_to_string(&wat_path)
            .unwrap_or_else(|e| panic!("read {}: {e}", wat_path.display()));
        let wasm = wat::parse_str(&wat_src).expect("compile native_fork_gc_array_cycle.wat");
        let out_path = dir.join("native_fork_gc_array_cycle.wasm");
        std::fs::write(&out_path, &wasm)
            .unwrap_or_else(|e| panic!("write {}: {e}", out_path.display()));
        eprintln!("wrote {} ({} bytes)", out_path.display(), wasm.len());
    }
}

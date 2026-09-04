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
use std::fs::File;
use std::io::{Read, Write as _};
use std::path::Path;
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
use wasm_posix_shared::host_abi::{
    SyscallArgDesc, SyscallArgDirection, SyscallArgSize, SYSCALL_ARG_DESCRIPTORS,
};
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

// --- Minimal host capabilities -----------------------------------------
//
// N1-I1a: the native host's default `/` and `/tmp` are the in-kernel rootfs
// overlay and tmpfs (see the `kernel_set_rootfs_now`/`kernel_set_tmpfs_enabled`/
// `kernel_set_rootfs_enabled` calls in `run_guest`), a sandboxed in-memory VFS
// that never touches the host. `host_lstat`/`host_stat`/`host_open`/
// `host_pread`/`host_fstat` are consequently left to `define_unknown_imports_
// as_traps` — a truthful boundary, since the overlay claims all of `/` (no
// foreign prefixes are registered) and so these imports must never fire on
// this path. A later increment restores real host-directory access, scoped to
// an explicit mount, and re-adds them for that mount's paths only.
//
// `HostFs` is reduced to its one remaining duty: serving fd 0 (stdin, a
// HostPipe) as a deterministic blocking source.

/// A blocking stdin (fd 0, a HostPipe) whose data is not ready on the first
/// read. `host_read(0)` returns EAGAIN once — forcing the kernel to block and
/// the pump to park the read — then delivers the line, then EOF. This is how a
/// real host pipe behaves when input arrives on a later poll; the call counter
/// just makes it deterministic for the test.
const HOST_STDIN_LINE: &[u8] = b"stdin via blocking read\n";

/// The blocking-stdin delivery counter (the only host-FS-shaped duty left once
/// the in-kernel overlay/tmpfs own `/` and `/tmp` by default).
struct HostFs {
    /// Number of host_read(0) calls so far (drives the EAGAIN-then-data stdin).
    stdin_reads: Mutex<u32>,
}

impl HostFs {
    fn new() -> Self {
        Self { stdin_reads: Mutex::new(0) }
    }
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
/// mirroring `host/src/worker-main.ts`'s `encodeStartupMetadata`). A later
/// increment adds an optional native-directory mount here.
#[derive(Debug, Clone, Default)]
pub struct GuestOptions {
    /// `argv[0]`, `argv[1]`, ... delivered via `kernel_get_argc`/`kernel_argv_read`.
    /// Empty means `argc == 0`, which the guest CRT's historical "a.out"
    /// fallback serves (see `libc/musl-overlay/crt/crt1.c`).
    pub argv: Vec<String>,
    /// `NAME=value` entries delivered via `kernel_environ_count`/`kernel_environ_get`.
    pub env: Vec<String>,
}

/// Boot the real `kernel.wasm` and run `guest_wasm` to completion through the
/// real channel, with `options` controlling its argv/env. This is the native
/// host's default run path (N1-I1a): before dispatch, it enables the
/// in-kernel rootfs overlay (`/`) and tmpfs (`/tmp`) with no manifest and no
/// blob provider, so the guest gets a **sandboxed in-memory VFS** — writable,
/// but backed by nothing on the host filesystem. `host_blob_read`/
/// `host_fetch_archive` and the host-FS `host_open` family are never called on
/// this path (see `define_kernel_host_imports`). Returns the guest's exit
/// code, captured stdout/stderr, and the syscall trace.
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

    // The native host's only remaining host-FS-shaped duty: fd 0 (stdin).
    let fs = Arc::new(HostFs::new());

    let mut kernel_store = Store::new(&engine, ());
    let mut klinker: Linker<()> = Linker::new(&engine);
    klinker.define(&mut kernel_store, "env", "memory", kernel_mem.clone())?;
    define_kernel_host_imports(&mut klinker, &kernel_mem, &captured, &fs, &guest_mem)?;
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
    // scratch-mount (`/tmp`, ...) and `/` authority to the kernel. No manifest
    // is loaded and no blob provider is installed, so the overlay's `/` starts
    // empty and every overlay-created file is stored inline
    // (`rootfs::Entry::Regular(Vec<u8>)`) — `host_blob_read`/`host_fetch_archive`
    // are never called and `host_open` is never reached; this is a fully
    // sandboxed, writable, in-memory default with no host directory mounted.
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let now_sec = now.as_secs();
    set_rootfs_now.call(
        &mut kernel_store,
        (now_sec as u32, (now_sec >> 32) as u32, now.subsec_nanos()),
    )?;
    set_tmpfs_enabled.call(&mut kernel_store, 1)?;
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

/// Define the minimal native `host_*` capabilities the boot + trivial path
/// needs; every other host import is left to `define_unknown_imports_as_traps`.
fn define_kernel_host_imports(
    linker: &mut Linker<()>,
    kernel_mem: &SharedMemory,
    captured: &Arc<Mutex<CapturedIo>>,
    fs: &Arc<HostFs>,
    guest_mem: &SharedMemory,
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
    // host_close(handle) -> i32: no-op success. Nothing in this host holds a
    // real host-FS cursor to release (the overlay/tmpfs own `/` and `/tmp`
    // in-kernel; a host_open handle is never issued on this path) and the
    // stdio HostPipes 0/1/2 need nothing released.
    linker.func_wrap("env", "host_close", |_c: Caller<'_, ()>, _handle: i64| -> i32 { 0 })?;
    // host_lstat / host_stat / host_open / host_pread / host_fstat are
    // deliberately NOT wired here. With the in-kernel rootfs overlay owning
    // `/` and no foreign mount prefixes registered (see `run_guest`), the
    // kernel's path resolution never falls through to these host FS
    // capabilities — `define_unknown_imports_as_traps` below makes that a
    // loud trap if it ever did, rather than silently serving a host file this
    // sandboxed default must not expose.
    // host_read(handle, buf_ptr, len) -> i32: fd 0 (stdin, a HostPipe) is a
    // blocking source — EAGAIN on the first read (so the kernel blocks and the
    // pump parks it), then one line, then EOF. This is how a real host pipe
    // behaves when input arrives on a later poll; the call counter just makes
    // it deterministic. Every other handle is a bug (no other host-FS handle
    // exists) and reports EBADF.
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
                if handle != 0 {
                    return -libc_errno::EBADF;
                }
                let mut calls = fs.stdin_reads.lock().unwrap();
                *calls += 1;
                match *calls {
                    1 => -libc_errno::EAGAIN, // not ready yet: block
                    2 => {
                        let n = HOST_STDIN_LINE.len().min(len as usize);
                        unsafe { write_bytes(&mem, buf_ptr as u32 as usize, &HOST_STDIN_LINE[..n]) };
                        n as i32
                    }
                    _ => 0, // EOF
                }
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
/// capabilities. Pinned here to avoid a `libc` dependency for six constants.
mod libc_errno {
    pub const EIO: i32 = 5;
    pub const EBADF: i32 = 9;
    pub const EAGAIN: i32 = 11;
    pub const EINVAL: i32 = 22;
    pub const EFAULT: i32 = 14;
    pub const ERANGE: i32 = 34;
}

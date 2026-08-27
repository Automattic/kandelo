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
    Caller, Engine, Global, GlobalType, Linker, MemoryType, Module, Mutability, SharedMemory,
    Store, Val, ValType,
};

use wasm_posix_shared::channel::{
    ARGS_OFFSET, ARG_SIZE, DATA_OFFSET, DATA_SIZE, ERRNO_OFFSET, MIN_CHANNEL_SIZE,
    REQUEST_FLAGS_OFFSET, REQUEST_FLAG_OPAQUE_RECORD, RETURN_OFFSET, STATUS_OFFSET, SYSCALL_OFFSET,
};
use wasm_posix_shared::abi::extended_syscalls::SYS_EXIT_GROUP;
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
        // Thread slots are not preallocated for this single-threaded guest, so
        // the arena ends right after the main channel's pages.
        let thread_arena_end_page = channel_page + CHANNEL_PAGES;
        let initial_pages = min_pages.max(thread_arena_end_page);
        let brk_base = thread_arena_end_page * WASM_PAGE_SIZE;
        let max_addr = DEFAULT_MAX_PAGES * WASM_PAGE_SIZE;
        Self {
            initial_pages,
            channel_offset,
            brk_base,
            max_addr,
        }
    }
}

/// Captured host I/O for the process's stdout/stderr host pipes.
#[derive(Default)]
struct CapturedIo {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
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

/// The pointer-arg descriptors declared for `syscall_nr`, or `&[]` when the
/// syscall marshals no pointers (pure scalar).
fn descriptors_for(syscall_nr: u32) -> &'static [SyscallArgDesc] {
    SYSCALL_ARG_DESCRIPTORS
        .iter()
        .find(|d| d.syscall_number == syscall_nr)
        .map(|d| d.args)
        .unwrap_or(&[])
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

/// Boot the real `kernel.wasm` and run `guest_wasm` (a trivial, non-forking,
/// no-VFS program) to completion through the real channel. Returns its exit
/// code, captured stdout/stderr, and the syscall trace.
pub fn run_trivial_guest(kernel_wasm: &Path, guest_wasm: &[u8]) -> anyhow::Result<RunOutcome> {
    let engine = crate::kernel_engine()?;

    // --- Kernel instance (this thread owns it and the pump) -----------------
    let kernel_module = Module::from_file(&engine, kernel_wasm)?;
    let kernel_mem = new_shared(&engine, KERNEL_MEMORY_MIN_PAGES, KERNEL_MEMORY_MAX_PAGES)?;
    let captured = Arc::new(Mutex::new(CapturedIo::default()));

    let mut kernel_store = Store::new(&engine, ());
    let mut klinker: Linker<()> = Linker::new(&engine);
    klinker.define(&mut kernel_store, "env", "memory", kernel_mem.clone())?;
    define_kernel_host_imports(&mut klinker, &kernel_mem, &captured)?;
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

    // Compile the guest and read its imported-memory minimum for the layout.
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

    for (name, val) in [
        ("kernel_set_brk_base", set_brk_base.call(&mut kernel_store, (pid, layout.brk_base as i32))?),
        ("kernel_set_mmap_base", set_mmap_base.call(&mut kernel_store, (pid, layout.brk_base as i32))?),
        ("kernel_set_max_addr", set_max_addr.call(&mut kernel_store, (pid, layout.max_addr as i32))?),
    ] {
        if val < 0 {
            anyhow::bail!("{name} failed: {val}");
        }
    }

    // --- Guest instance on its own OS thread --------------------------------
    let guest_mem = new_shared(&engine, layout.initial_pages as u32, DEFAULT_MAX_PAGES as u32)?;
    // Records the status the guest requests if it ever calls the `kernel_exit`
    // import directly (the SIGKILL fast-path); the normal exit path is
    // `SYS_exit_group` over the channel, handled by the pump.
    let import_exit_status = Arc::new(Mutex::new(None::<i32>));
    spawn_guest_thread(&engine, guest_module, guest_mem.clone(), layout, import_exit_status.clone());

    // --- The channel pump ---------------------------------------------------
    let mut syscall_trace = Vec::new();
    let exit_code = run_pump(
        &mut kernel_store,
        &guest_mem,
        &kernel_mem,
        scratch_ptr_u,
        pid,
        layout,
        &set_current_tid,
        &handle_channel,
        &get_exit_status,
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

/// Define the minimal native `host_*` capabilities the boot + trivial path
/// needs; every other host import is left to `define_unknown_imports_as_traps`.
fn define_kernel_host_imports(
    linker: &mut Linker<()>,
    kernel_mem: &SharedMemory,
    captured: &Arc<Mutex<CapturedIo>>,
) -> anyhow::Result<()> {
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
    // host_close(handle) -> i32: process exit closes fds 0/1/2 (the HostPipe
    // stdio). Nothing host-side needs releasing — the captured buffers persist
    // — so acknowledge success.
    linker.func_wrap("env", "host_close", |_c: Caller<'_, ()>, _handle: i64| -> i32 { 0 })?;
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

        // Host-provided launch metadata. argc/envc = 0 takes crt1.c's "a.out"
        // fallback, so kernel_argv_read / kernel_environ_get are never called
        // and are left to trap. secure_exec = 0 skips the fd-securing path;
        // is_fork_child = 0 runs main rather than the exec path.
        linker.func_wrap("kernel", "kernel_get_argc", || -> i32 { 0 }).unwrap();
        linker.func_wrap("kernel", "kernel_environ_count", || -> i32 { 0 }).unwrap();
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
        // argv_read / environ_get / the fork-exec set are imported but never
        // reached on this path; a trap is the truthful boundary.
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

/// Run the channel pump until the guest posts `exit`/`exit_group`. Returns the
/// kernel-recorded exit code. Records the syscall trace into `trace` and the
/// thread-local `LAST_TRACE`.
#[allow(clippy::too_many_arguments)]
fn run_pump(
    kernel_store: &mut Store<()>,
    guest_mem: &SharedMemory,
    kernel_mem: &SharedMemory,
    scratch_ptr: usize,
    pid: u32,
    layout: ProcessLayout,
    set_current_tid: &wasmtime::TypedFunc<(u32, u32), i32>,
    handle_channel: &wasmtime::TypedFunc<(i32, u32, u32, i64), i32>,
    get_exit_status: &wasmtime::TypedFunc<u32, i32>,
    trace: &mut Vec<u32>,
) -> anyhow::Result<i32> {
    let status_off = layout.channel_offset + STATUS_OFFSET;
    let deadline = Instant::now() + Duration::from_secs(30);

    let exit_code = loop {
        if Instant::now() > deadline {
            anyhow::bail!("pump timed out after 30s (trace so far: {trace:?})");
        }
        let status = unsafe { atomic_u32(guest_mem, status_off) }.load(Ordering::SeqCst);
        if status != STATUS_PENDING {
            thread::yield_now();
            std::thread::sleep(Duration::from_micros(50));
            continue;
        }

        // The SeqCst load of PENDING happens-after the guest's SeqCst store, so
        // the syscall number, args, and request flags written before it are
        // visible.
        let syscall_nr = unsafe { read_u32(guest_mem, layout.channel_offset + SYSCALL_OFFSET) };
        let mut args = [0i64; 6];
        for (i, a) in args.iter_mut().enumerate() {
            *a = unsafe { read_i64(guest_mem, layout.channel_offset + ARGS_OFFSET + i * ARG_SIZE) };
        }
        // The record vs RAW decision is read from the header flag (written fresh
        // every request beside the syscall number), never the data-buffer magic:
        // that magic can be stale across fork or a reused channel slot, but the
        // flag cannot. RAW syscalls never set it. Matches kernel-worker.ts.
        let request_flags = unsafe { read_u32(guest_mem, layout.channel_offset + REQUEST_FLAGS_OFFSET) };
        let is_record = request_flags & REQUEST_FLAG_OPAQUE_RECORD != 0;
        trace.push(syscall_nr);

        // Bind the leader task (tid == pid) — dispatch returns ESRCH without it.
        let bind = set_current_tid.call(&mut *kernel_store, (pid, pid))?;
        if bind < 0 {
            anyhow::bail!("kernel_set_current_tid({pid},{pid}) failed: {bind}");
        }

        let (ret, errno) = if is_record {
            // --- Phase 2 opaque-record blind transport (Option A) -----------
            // The guest self-marshalled every pointer span into a record at
            // CH_DATA. The host is out of the data path: stamp the syscall
            // number, blind-copy the whole data region into the kernel scratch,
            // dispatch (the kernel decodes the record, writes OUT/InOut results
            // back into it at their span offsets), then blind-copy the data
            // region back so the guest's __unmarshal delivers them. No
            // descriptors, no arg rewriting, no mmap growth — the record is
            // authoritative for both scalars and pointers.
            unsafe {
                write_bytes(kernel_mem, scratch_ptr + SYSCALL_OFFSET, &syscall_nr.to_le_bytes());
                let record_in = read_bytes(guest_mem, layout.channel_offset + DATA_OFFSET, DATA_SIZE);
                write_bytes(kernel_mem, scratch_ptr + DATA_OFFSET, &record_in);
            }
            handle_channel.call(&mut *kernel_store, (scratch_ptr as i32, MIN_CHANNEL_SIZE as u32, pid, 0))?;
            let ret = unsafe { read_i64(kernel_mem, scratch_ptr + RETURN_OFFSET) };
            let errno = unsafe { read_u32(kernel_mem, scratch_ptr + ERRNO_OFFSET) };
            unsafe {
                let record_out = read_bytes(kernel_mem, scratch_ptr + DATA_OFFSET, DATA_SIZE);
                write_bytes(guest_mem, layout.channel_offset + DATA_OFFSET, &record_out);
                // Clear the record magic in the reusable scratch so a later RAW
                // scalar-only syscall is not wrongly decoded as a record.
                write_bytes(kernel_mem, scratch_ptr + DATA_OFFSET, &[0u8; 4]);
            }
            (ret, errno)
        } else {
            // --- RAW descriptor-marshalled path -----------------------------
            // Clear the DATA magic slot so a scalar syscall never trips the
            // kernel's record-decode magic check, write the syscall number and
            // (possibly pointer-rewritten) args, then marshal RAW pointer bufs.
            unsafe {
                write_bytes(kernel_mem, scratch_ptr + DATA_OFFSET, &[0u8; 4]);
                write_bytes(kernel_mem, scratch_ptr + SYSCALL_OFFSET, &syscall_nr.to_le_bytes());
            }
            let staged = marshal_in(kernel_mem, guest_mem, scratch_ptr, syscall_nr, &mut args)?;
            unsafe {
                for (i, a) in args.iter().enumerate() {
                    write_bytes(kernel_mem, scratch_ptr + ARGS_OFFSET + i * ARG_SIZE, &a.to_le_bytes());
                }
            }
            // Guard against a RAW buffer that begins with the opaque-record
            // magic: the kernel keys record decoding on DATA[0..4], so such a
            // buffer would misroute. Fail loudly rather than corrupt silently.
            let magic = unsafe { read_u32(kernel_mem, scratch_ptr + DATA_OFFSET) };
            if magic == RECORD_MAGIC {
                anyhow::bail!(
                    "RAW syscall {syscall_nr} staged a buffer starting with RECORD_MAGIC; \
                     the kernel would misroute it as an opaque record"
                );
            }

            // The kernel dispatches exit/exit_group by committing the exit status
            // and then calling its `kernel_exit` export, which ends in
            // `unreachable` to halt the task. So `kernel_handle_channel` *traps*
            // on exit — the expected, successful end of the run, not an error.
            // The status is committed before the trap; read it and finish. The
            // guest is left parked on the never-completed exit channel and
            // reclaimed at process teardown.
            let is_exit = syscall_nr == Syscall::Exit as u32 || syscall_nr == SYS_EXIT_GROUP;
            let rc_result = handle_channel
                .call(&mut *kernel_store, (scratch_ptr as i32, MIN_CHANNEL_SIZE as u32, pid, 0));
            if is_exit {
                let code = get_exit_status
                    .call(&mut *kernel_store, pid)
                    .unwrap_or(args[0] as i32 & 0xff);
                break code;
            }
            let rc = rc_result?;

            let ret = unsafe { read_i64(kernel_mem, scratch_ptr + RETURN_OFFSET) };
            let errno = unsafe { read_u32(kernel_mem, scratch_ptr + ERRNO_OFFSET) };

            // Copy back any Out/InOut buffers into the guest.
            for s in &staged {
                if s.copy_back {
                    let bytes = unsafe { read_bytes(kernel_mem, scratch_ptr + s.data_off, s.len) };
                    unsafe { write_bytes(guest_mem, s.guest_ptr, &bytes) };
                }
            }

            // mmap/brk hand out addresses at/above the initial memory end; grow
            // the guest memory to cover them before the guest resumes.
            if rc == 0 || ret >= 0 {
                if syscall_nr == Syscall::Mmap as u32 && ret >= 0 {
                    grow_to_cover(guest_mem, ret as usize + args[1] as u32 as usize)?;
                } else if syscall_nr == Syscall::Brk as u32 && ret >= 0 {
                    grow_to_cover(guest_mem, ret as usize)?;
                }
            }
            (ret, errno)
        };

        // Publish result to the guest channel, then wake it: release-store
        // COMPLETE first so the guest's re-check of the wait word sees the
        // change, then notify to unpark its wait32.
        unsafe {
            write_bytes(guest_mem, layout.channel_offset + RETURN_OFFSET, &ret.to_le_bytes());
            write_bytes(guest_mem, layout.channel_offset + ERRNO_OFFSET, &errno.to_le_bytes());
        }
        unsafe { atomic_u32(guest_mem, status_off) }.store(STATUS_COMPLETE, Ordering::SeqCst);
        guest_mem
            .atomic_notify(status_off as u64, 1)
            .map_err(|e| anyhow::anyhow!("atomic_notify failed: {e}"))?;
    };

    Ok(exit_code)
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
    for d in descriptors_for(syscall_nr) {
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

/// Minimal errno values the native host returns from `host_*` capabilities.
/// Pinned here to avoid a `libc` dependency for four constants.
mod libc_errno {
    pub const EBADF: i32 = 9;
    pub const EIO: i32 = 5;
    pub const EINVAL: i32 = 22;
}

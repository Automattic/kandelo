//! K10 I7 -- native WASI, from the same module Node and the browser load.
//!
//! Before this, `crates/host-native` had no WASI support of any kind
//! (`grep -rn wasi crates/host-native/src/*.rs` found nothing). That is the
//! strongest argument for moving the shim into Rust at all: the migration is
//! not "the same TypeScript logic, relocated", it is a capability this host
//! never had, obtained without writing a native implementation.
//!
//! What this proves, under Wasmtime:
//!
//!   * `local-binaries/wasi_module32.wasm` -- byte-for-byte the artifact the
//!     other two hosts load -- instantiates against a host-chosen region of a
//!     shared memory;
//!   * its exports are usable directly as a WASI guest's
//!     `wasi_snapshot_preview1` imports, so the guest's calls are wasm->wasm;
//!   * the channel handshake works against a real second thread: the module
//!     blocks in `memory.atomic.wait32` and a servicer wakes it with
//!     `SharedMemory::atomic_notify`.
//!
//! Run with:
//!   cargo test -p host-native --target <host-triple> --test wasi_module
//!
//! Requires `bash crates/wasi-module/build-wasm.sh` to have staged the
//! artifact. A missing artifact SKIPS with a loud message rather than
//! failing: this crate's other suites must stay runnable in a checkout that
//! has not built the WASI module, and a green run that silently proved
//! nothing would be worse than either.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use wasm_posix_shared::{channel, ChannelStatus, Syscall};
use wasmtime::{
    Config, Engine, Global, GlobalType, Instance, Linker, MemoryType, Module, Mutability,
    SharedMemory, Store, Val, ValType,
};

const PAGE: usize = 65536;
/// The guest's own declared minimum. The host-owned band starts above it,
/// exactly as `computeProcessMemoryLayout` places the channel above a
/// process's `importedMemoryMinimumPages`.
const GUEST_MIN_PAGES: u32 = 4;
/// The host-owned band: the syscall channel, then the module's region.
const CHANNEL_PAGE: u32 = GUEST_MIN_PAGES;
const CHANNEL_PAGES: u32 = 2;
const MODULE_PAGES: u32 = 4;
const INITIAL_PAGES: u32 = CHANNEL_PAGE + CHANNEL_PAGES + MODULE_PAGES;
const MAX_PAGES: u32 = 256;

const CHANNEL_BASE: usize = CHANNEL_PAGE as usize * PAGE;
const MODULE_BASE: usize = (CHANNEL_PAGE + CHANNEL_PAGES) as usize * PAGE;
const MODULE_REGION_BYTES: usize = MODULE_PAGES as usize * PAGE;

/// A WASI guest of the shape Kandelo accepts: it IMPORTS its memory rather
/// than defining one. K10 probe 4 established that a module defining its own
/// memory cannot be served at all -- a self-defined memory is not shared, so
/// there is no syscall channel -- which is why `worker-main.ts` refuses that
/// category outright.
const GUEST_WAT: &str = r#"
(module
  (import "env" "memory" (memory 1 65536 shared))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_seek"
    (func $fd_seek (param i32 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_prestat_get"
    (func $fd_prestat_get (param i32 i32) (result i32)))

  (global $iov i32 (i32.const 2048))
  (global $data i32 (i32.const 2100))
  (global $out i32 (i32.const 2200))

  ;; Writes "native" to fd 1 and returns the byte count the shim reports.
  (func (export "_start") (result i32)
    (i32.store8 (global.get $data) (i32.const 110))  ;; n
    (i32.store8 (i32.add (global.get $data) (i32.const 1)) (i32.const 97))  ;; a
    (i32.store8 (i32.add (global.get $data) (i32.const 2)) (i32.const 116)) ;; t
    (i32.store8 (i32.add (global.get $data) (i32.const 3)) (i32.const 105)) ;; i
    (i32.store8 (i32.add (global.get $data) (i32.const 4)) (i32.const 118)) ;; v
    (i32.store8 (i32.add (global.get $data) (i32.const 5)) (i32.const 101)) ;; e
    (i32.store (global.get $iov) (global.get $data))
    (i32.store (i32.add (global.get $iov) (i32.const 4)) (i32.const 6))
    (drop (call $fd_write
      (i32.const 1) (global.get $iov) (i32.const 1) (global.get $out)))
    (i32.load (global.get $out)))

  ;; Hands a full-width i64 through the shim and returns what came back.
  (func (export "seek_roundtrip") (param $off i64) (result i64)
    (drop (call $fd_seek
      (i32.const 4) (local.get $off) (i32.const 0) (global.get $out)))
    (i64.load (global.get $out)))

  ;; The preopen the module seeded, reported back through the guest.
  (func (export "prestat_len") (result i32)
    (drop (call $fd_prestat_get (i32.const 3) (global.get $out)))
    (i32.load (i32.add (global.get $out) (i32.const 4))))

  (func (export "prestat_of") (param $fd i32) (result i32)
    (call $fd_prestat_get (local.get $fd) (global.get $out))))
"#;

/// The 46 names the module must supply, and that a real wasi-libc guest may
/// import any subset of.
const WASI_ENTRY_POINTS: &[&str] = &[
    "args_get", "args_sizes_get", "environ_get", "environ_sizes_get", "clock_res_get",
    "clock_time_get", "fd_advise", "fd_allocate", "fd_close", "fd_datasync", "fd_fdstat_get",
    "fd_fdstat_set_flags", "fd_fdstat_set_rights", "fd_filestat_get", "fd_filestat_set_size",
    "fd_filestat_set_times", "fd_pread", "fd_prestat_get", "fd_prestat_dir_name", "fd_pwrite",
    "fd_read", "fd_readdir", "fd_renumber", "fd_seek", "fd_sync", "fd_tell", "fd_write",
    "path_create_directory", "path_filestat_get", "path_filestat_set_times", "path_link",
    "path_open", "path_readlink", "path_remove_directory", "path_rename", "path_symlink",
    "path_unlink_file", "poll_oneoff", "proc_exit", "proc_raise", "random_get", "sched_yield",
    "sock_accept", "sock_recv", "sock_send", "sock_shutdown",
];

fn engine() -> Engine {
    let mut config = Config::new();
    config.wasm_threads(true);
    // Wasmtime 48 gates SharedMemory construction behind its own knob; the
    // channel handshake is built on it. Same reasoning as `kernel_engine`.
    config.shared_memory(true);
    Engine::new(&config).expect("engine")
}

fn base_ptr(mem: &SharedMemory) -> *mut u8 {
    mem.data().as_ptr() as *mut u8
}

/// SAFETY: every caller stays inside the memory's reserved range, which
/// `SharedMemory` pre-reserves to its maximum so the base pointer is stable.
unsafe fn read_u32(mem: &SharedMemory, off: usize) -> u32 {
    unsafe { base_ptr(mem).add(off).cast::<u32>().read_unaligned() }
}

unsafe fn read_i64(mem: &SharedMemory, off: usize) -> i64 {
    unsafe { base_ptr(mem).add(off).cast::<i64>().read_unaligned() }
}

unsafe fn write_i64(mem: &SharedMemory, off: usize, value: i64) {
    unsafe { base_ptr(mem).add(off).cast::<i64>().write_unaligned(value) }
}

unsafe fn write_u32(mem: &SharedMemory, off: usize, value: u32) {
    unsafe { base_ptr(mem).add(off).cast::<u32>().write_unaligned(value) }
}

unsafe fn status_word(mem: &SharedMemory) -> &AtomicU32 {
    unsafe { &*base_ptr(mem).add(CHANNEL_BASE + channel::STATUS_OFFSET).cast::<AtomicU32>() }
}

/// One syscall as the servicer saw it.
#[derive(Debug, Clone)]
struct SeenCall {
    nr: u32,
    args: [i64; 6],
}

/// Plays the kernel: block on the channel status word, service what appears,
/// publish the result, and wake the module back. The same protocol
/// `host/src/kernel-worker.ts` implements and `guest.rs`'s pump implements
/// natively.
fn spawn_servicer(
    mem: SharedMemory,
    stop: Arc<AtomicU32>,
    seen: Arc<std::sync::Mutex<Vec<SeenCall>>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let pending = ChannelStatus::Pending as u32;
        let complete = ChannelStatus::Complete as u32;
        let idle = ChannelStatus::Idle as u32;
        while stop.load(Ordering::SeqCst) == 0 {
            // SAFETY: fixed offsets inside the channel region.
            unsafe {
                if status_word(&mem).load(Ordering::SeqCst) != pending {
                    let _ = mem.atomic_wait32(
                        (CHANNEL_BASE + channel::STATUS_OFFSET) as u64,
                        idle,
                        Some(std::time::Duration::from_millis(50)),
                    );
                    continue;
                }

                let nr = read_u32(&mem, CHANNEL_BASE + channel::SYSCALL_OFFSET);
                let mut args = [0i64; 6];
                for (index, slot) in args.iter_mut().enumerate() {
                    *slot = read_i64(
                        &mem,
                        CHANNEL_BASE + channel::ARGS_OFFSET + index * channel::ARG_SIZE,
                    );
                }
                seen.lock().unwrap().push(SeenCall { nr, args });

                let (result, errno) = service(&mem, nr, &args);
                write_i64(&mem, CHANNEL_BASE + channel::RETURN_OFFSET, result);
                write_u32(&mem, CHANNEL_BASE + channel::ERRNO_OFFSET, errno);
                status_word(&mem).store(complete, Ordering::SeqCst);
                let _ = mem.atomic_notify(
                    (CHANNEL_BASE + channel::STATUS_OFFSET) as u64,
                    1,
                );

                // Wait for the module to reset the word before looking again.
                while stop.load(Ordering::SeqCst) == 0
                    && status_word(&mem).load(Ordering::SeqCst) == complete
                {
                    let _ = mem.atomic_wait32(
                        (CHANNEL_BASE + channel::STATUS_OFFSET) as u64,
                        complete,
                        Some(std::time::Duration::from_millis(10)),
                    );
                }
            }
        }
    })
}

/// The handful of syscalls this harness drives. An unrecognised one is
/// ENOSYS, never success, so a wrong syscall number fails the test rather
/// than passing quietly.
fn service(mem: &SharedMemory, nr: u32, args: &[i64; 6]) -> (i64, u32) {
    if nr == Syscall::Openat as u32 {
        // The module opening "/" for its preopen.
        (3, 0)
    } else if nr == Syscall::Writev as u32 {
        // Total the iovec array describes, as a real writev reports.
        let iovs = args[1] as usize;
        let count = args[2] as usize;
        let mut total = 0i64;
        for index in 0..count {
            // SAFETY: the guest's iovec array, inside its own memory.
            total += unsafe { read_u32(mem, iovs + index * 8 + 4) } as i64;
        }
        (total, 0)
    } else if nr == Syscall::Seek as u32 {
        // Reassemble the low/high words Kandelo's lseek ABI carries.
        let low = args[1] as u32 as u64;
        let high = args[2] as i32 as i64;
        (((high << 32) | low as i64), 0)
    } else {
        (-1, 38) // ENOSYS
    }
}

#[test]
fn host_native_runs_a_wasi_guest_through_the_shared_wasi_module() {
    let module_path = host_native::wasi_module_path();
    if !module_path.exists() {
        eprintln!(
            "SKIP: {} is missing. Build it with \
             `bash crates/wasi-module/build-wasm.sh`.",
            module_path.display()
        );
        return;
    }
    let wasm = std::fs::read(&module_path).expect("read wasi module");

    let engine = engine();
    let module = Module::new(&engine, &wasm).expect("compile wasi module");

    // The module must not have grown a host-import surface. This is the V4
    // claim, checked against the artifact this host actually loads.
    for import in module.imports() {
        assert_eq!(
            import.module(),
            "env",
            "wasi-module imported from an unexpected namespace: {}.{}",
            import.module(),
            import.name()
        );
        assert!(
            !import.name().starts_with("host_"),
            "wasi-module must not require a host capability, found env.{}",
            import.name()
        );
    }

    let exported: std::collections::BTreeSet<&str> =
        module.exports().map(|e| e.name()).collect();
    let missing: Vec<&&str> = WASI_ENTRY_POINTS
        .iter()
        .filter(|name| !exported.contains(**name))
        .collect();
    assert!(missing.is_empty(), "wasi-module is missing exports: {missing:?}");

    let mem = SharedMemory::new(&engine, MemoryType::shared(INITIAL_PAGES, MAX_PAGES))
        .expect("shared memory");

    let mut store: Store<()> = Store::new(&engine, ());
    let mut linker: Linker<()> = Linker::new(&engine);
    linker.define(&store, "env", "memory", mem.clone()).unwrap();
    let const_i32 = |store: &mut Store<()>, value: i32| {
        Global::new(
            store,
            GlobalType::new(ValType::I32, Mutability::Const),
            Val::I32(value),
        )
        .unwrap()
    };
    let base = const_i32(&mut store, MODULE_BASE as i32);
    let table_base = const_i32(&mut store, 0);
    let stack = Global::new(
        &mut store,
        GlobalType::new(ValType::I32, Mutability::Var),
        Val::I32((MODULE_BASE + MODULE_REGION_BYTES) as i32),
    )
    .unwrap();
    linker.define(&store, "env", "__memory_base", base).unwrap();
    linker.define(&store, "env", "__table_base", table_base).unwrap();
    linker.define(&store, "env", "__stack_pointer", stack).unwrap();
    // The table must be created before the `define` call so the immutable
    // borrow of `store` there does not overlap this mutable one.
    let indirect_table = wasmtime::Table::new(
        &mut store,
        wasmtime::TableType::new(wasmtime::RefType::FUNCREF, 0, None),
        wasmtime::Ref::Func(None),
    )
    .unwrap();
    linker
        .define(&store, "env", "__indirect_function_table", indirect_table)
        .unwrap();

    let shim: Instance = linker
        .instantiate(&mut store, &module)
        .expect("instantiate wasi-module against a host-chosen region");

    // Start the servicer before anything that blocks on the channel.
    let stop = Arc::new(AtomicU32::new(0));
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let servicer = spawn_servicer(mem.clone(), stop.clone(), seen.clone());

    let init = shim
        .get_typed_func::<(u32, u32, u32, u32, u32, u32, u32), i32>(&mut store, "wasi_module_init")
        .unwrap();
    assert_eq!(init.call(&mut store, (CHANNEL_BASE as u32, 0, 0, 0, 0, 0, 0)).unwrap(), 0);

    // This BLOCKS in `memory.atomic.wait32` until the servicer thread answers,
    // which is the whole point: the handshake works natively.
    let start = shim
        .get_typed_func::<(), i32>(&mut store, "wasi_module_start")
        .unwrap();
    assert_eq!(
        start.call(&mut store, ()).unwrap(),
        0,
        "wasi_module_start must complete a real openat round trip"
    );

    // --- now the guest, with the module's exports as its WASI imports -------
    let guest_bytes = wat::parse_str(GUEST_WAT).expect("assemble guest");
    let guest_module = Module::new(&engine, &guest_bytes).expect("compile guest");

    let mut guest_linker: Linker<()> = Linker::new(&engine);
    guest_linker.define(&store, "env", "memory", mem.clone()).unwrap();
    for name in ["fd_write", "fd_seek", "fd_prestat_get"] {
        let func = shim
            .get_func(&mut store, name)
            .unwrap_or_else(|| panic!("wasi-module exports {name}"));
        guest_linker
            .define(&store, "wasi_snapshot_preview1", name, func)
            .unwrap();
    }
    let guest = guest_linker
        .instantiate(&mut store, &guest_module)
        .expect("a side module's exports are usable as a guest's imports");

    let start = guest
        .get_typed_func::<(), i32>(&mut store, "_start")
        .unwrap();
    assert_eq!(
        start.call(&mut store, ()).unwrap(),
        6,
        r#"the guest wrote "native" and the shim reported 6 bytes"#
    );

    // A full-width i64 must survive the guest -> module -> channel round trip.
    // 0x0123456789ABCDEF is not exactly representable as an f64.
    let seek = guest
        .get_typed_func::<i64, i64>(&mut store, "seek_roundtrip")
        .unwrap();
    let probe = 0x0123_4567_89AB_CDEFi64;
    assert_eq!(seek.call(&mut store, probe).unwrap(), probe, "i64 fidelity");
    assert_eq!(seek.call(&mut store, -1).unwrap(), -1, "sign extension");

    // The preopen the module seeded is visible to the guest.
    let prestat_len = guest
        .get_typed_func::<(), i32>(&mut store, "prestat_len")
        .unwrap();
    assert_eq!(prestat_len.call(&mut store, ()).unwrap(), 1, r#"the name "/""#);
    let prestat_of = guest
        .get_typed_func::<i32, i32>(&mut store, "prestat_of")
        .unwrap();
    assert_eq!(
        prestat_of.call(&mut store, 9).unwrap(),
        8,
        "a non-preopen fd is EBADF, not a trap"
    );

    stop.store(1, Ordering::SeqCst);
    servicer.join().unwrap();

    let calls = seen.lock().unwrap().clone();
    let numbers: Vec<u32> = calls.iter().map(|c| c.nr).collect();
    assert_eq!(
        numbers,
        vec![
            Syscall::Openat as u32,
            Syscall::Writev as u32,
            Syscall::Seek as u32,
            Syscall::Seek as u32,
        ],
        "the servicer saw exactly the expected syscalls, in order"
    );
    // The seek arrived as low/high words rather than a truncated double.
    assert_eq!(calls[2].args[1], 0x89AB_CDEFu32 as i64, "low word");
    assert_eq!(calls[2].args[2], 0x0123_4567, "high word");
    // fd_prestat_get is pure-local and must not have reached the kernel.
    assert_eq!(calls.len(), 4);
}

//! Native reference host for Kandelo, built on Wasmtime.
//!
//! This crate is the third-engine conformance host from the Rust-first
//! runtime design (`docs/plans/2026-08-25-rust-first-runtime-design.md`,
//! roadmap phase 3). It loads the *same* real `kernel.wasm` artifact that
//! the browser and Node hosts run — not the kernel compiled as a native
//! rlib — on a non-JavaScript engine. Running the real artifact, the real
//! ABI, and the real channel primitive on Wasmtime is the freeze-gate acid
//! test that the platform boundary is not secretly JavaScript-shaped.
//!
//! This first increment brings the (previously throwaway) feasibility spike
//! in-tree as committed, tested code:
//!
//! * [`load_kernel_and_read_abi`] instantiates `kernel.wasm` with an imported
//!   shared memory, stubs the `env.host_*` imports as traps, and reads back
//!   `__abi_version`. It also reports the observed import surface so a future
//!   ABI change surfaces here as a failed assertion.
//! * [`run_wait_notify_handshake`] exercises the exact guest-blocks /
//!   kernel-wakes primitive the syscall channel depends on: a waiter blocks in
//!   `memory.atomic.wait32` on a shared memory while a notifier on another OS
//!   thread wakes it with `memory.atomic.notify`.
//!
//! HOST-ONLY: Wasmtime does not build for `wasm32-unknown-unknown`; build and
//! test this crate with an explicit host target (see `Cargo.toml`).

use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use wasmtime::{Config, Engine, ExternType, Linker, MemoryType, Module, SharedMemory, Store};

/// Increment 2: boot the kernel and run a trivial guest through the real
/// channel. See [`guest::run_trivial_guest`].
pub mod guest;
pub use guest::{run_guest, run_trivial_guest, GuestOptions, NativeMount, RunOutcome};

/// ABI version this native host expects the kernel to advertise. Must match
/// `wasm_posix_shared::ABI_VERSION` (currently 44). A kernel built for a
/// different ABI will fail the smoke test loudly rather than run wrong.
pub const EXPECTED_ABI_VERSION: i32 = 44;

/// The kernel imports `env.memory` as a shared memory with this minimum page
/// count (18 pages) ...
pub const KERNEL_MEMORY_MIN_PAGES: u32 = 18;

/// ... and this maximum page count (16384 pages == 1 GiB, matching the
/// `--max-memory=1073741824` link arg in `.cargo/config.toml`).
pub const KERNEL_MEMORY_MAX_PAGES: u32 = 16384;

/// Number of `env.host_*` function imports the kernel expects the host to
/// provide (the `HostCapabilities` surface). The native host stubs them as
/// traps for now; the full implementation lands in later phases. This count is
/// asserted by the smoke test so an ABI/import-surface change surfaces here.
///
/// The 2026-08-25 feasibility spike measured 83 on the ABI-43 kernel; the
/// ABI-44 opaque-transport flip dropped one (→82), and the Phase-5 in-kernel
/// rootfs overlay added two byte-provider imports (`host_blob_read`,
/// `host_fetch_archive`), so the real reconciled ABI-44 artifact imports 84
/// (verified via `wasm-objdump -x local-binaries/kernel.wasm`).
pub const EXPECTED_HOST_IMPORT_COUNT: usize = 84;

/// The observed shape of the kernel's `env.memory` import.
#[derive(Debug, Clone)]
pub struct MemoryImport {
    /// Whether the memory is declared `shared` (required for the atomic
    /// wait/notify channel handshake).
    pub shared: bool,
    /// Minimum size in Wasm pages (64 KiB each).
    pub minimum: u64,
    /// Maximum size in Wasm pages, if declared.
    pub maximum: Option<u64>,
}

/// The import surface the native host must satisfy to run a kernel module.
#[derive(Debug, Clone, Default)]
pub struct KernelImportSurface {
    /// Names (without the `env.` prefix) of every `host_*` *function* import,
    /// in module order.
    pub host_fn_imports: Vec<String>,
    /// The `env.memory` import shape, if the module imports a memory.
    pub memory: Option<MemoryImport>,
    /// Any imports that are neither `env.memory` nor an `env.host_*` function,
    /// recorded as `"<module>.<name>"` for diagnostics. Expected to be empty.
    pub other_imports: Vec<String>,
}

/// A Wasmtime engine configured for the kernel's required feature set: the
/// threads proposal (shared memory + atomic wait/notify). Bulk-memory and
/// mutable-globals are enabled by default in this Wasmtime version.
pub fn kernel_engine() -> wasmtime::Result<Engine> {
    let mut config = Config::new();
    config.wasm_threads(true);
    Engine::new(&config)
}

/// Enumerate the import surface of a compiled kernel `Module` without
/// instantiating it.
pub fn inspect_kernel_module(module: &Module) -> KernelImportSurface {
    let mut surface = KernelImportSurface::default();
    for import in module.imports() {
        match import.ty() {
            ExternType::Memory(mem) if import.module() == "env" && import.name() == "memory" => {
                surface.memory = Some(MemoryImport {
                    shared: mem.is_shared(),
                    minimum: mem.minimum(),
                    maximum: mem.maximum(),
                });
            }
            ExternType::Func(_)
                if import.module() == "env" && import.name().starts_with("host_") =>
            {
                surface.host_fn_imports.push(import.name().to_string());
            }
            _ => surface
                .other_imports
                .push(format!("{}.{}", import.module(), import.name())),
        }
    }
    surface
}

/// Part 1 of the spike: load a real `kernel.wasm`, define its imported shared
/// `env.memory`, stub the `env.host_*` imports as traps, instantiate, and read
/// back `__abi_version`. Returns the ABI value and the observed import surface.
///
/// `__abi_version` is a pure accessor that touches none of the host imports,
/// so stubbing them as traps is sufficient to run it.
pub fn load_kernel_and_read_abi(path: &Path) -> wasmtime::Result<(i32, KernelImportSurface)> {
    let engine = kernel_engine()?;
    let module = Module::from_file(&engine, path)?;
    let surface = inspect_kernel_module(&module);

    let shared = SharedMemory::new(
        &engine,
        MemoryType::shared(KERNEL_MEMORY_MIN_PAGES, KERNEL_MEMORY_MAX_PAGES),
    )?;
    let mut store = Store::new(&engine, ());
    let mut linker = Linker::new(&engine);
    linker.define(&mut store, "env", "memory", shared)?;
    // Stub the 82 env.host_* imports as traps. This first increment only
    // needs __abi_version, which invokes none of them; the real
    // HostCapabilities implementation lands in later phases.
    linker.define_unknown_imports_as_traps(&module)?;

    let instance = linker.instantiate(&mut store, &module)?;
    let abi = instance.get_typed_func::<(), i32>(&mut store, "__abi_version")?;
    let version = abi.call(&mut store, ())?;
    Ok((version, surface))
}

/// Part 2 of the spike: the syscall-channel blocking primitive. A waiter
/// instance on its own OS thread blocks in `memory.atomic.wait32(addr, 0, -1)`
/// on a shared memory; a notifier instance on this thread wakes it with
/// `memory.atomic.notify(addr, 1)`. This is the exact guest-blocks /
/// kernel-wakes handshake the channel depends on.
///
/// Returns `(woke, wait_result)` where `woke` is the count of waiters the
/// notify awoke (expected 1) and `wait_result` is the `wait32` return code
/// (expected 0 == "woken").
pub fn run_wait_notify_handshake() -> wasmtime::Result<(i32, i32)> {
    let engine = kernel_engine()?;

    // A minimal module that imports one shared memory and exposes wait/notify.
    let wat = r#"(module
        (import "env" "memory" (memory 1 10 shared))
        (func (export "wait") (param i32 i32) (result i32)
          (memory.atomic.wait32 (local.get 0) (local.get 1) (i64.const -1)))
        (func (export "notify") (param i32) (result i32)
          (memory.atomic.notify (local.get 0) (i32.const 1))))"#;
    let module = Module::new(&engine, wat)?;

    let shared = SharedMemory::new(&engine, MemoryType::shared(1, 10))?;
    // Ensure the wait word starts at the expected value (0) so the waiter
    // actually parks instead of returning "not-equal".
    unsafe {
        std::ptr::write_volatile(shared.data().as_ptr() as *mut u8, 0u8);
    }

    let waiter = {
        let engine = engine.clone();
        let module = module.clone();
        let mem = shared.clone();
        thread::spawn(move || -> wasmtime::Result<i32> {
            let mut store = Store::new(&engine, ());
            let mut linker = Linker::new(&engine);
            linker.define(&mut store, "env", "memory", mem)?;
            let instance = linker.instantiate(&mut store, &module)?;
            let wait = instance.get_typed_func::<(i32, i32), i32>(&mut store, "wait")?;
            // Block on addr 0, expecting the current value 0, no timeout.
            wait.call(&mut store, (0, 0))
        })
    };

    // Give the waiter time to reach the parked wait32 before notifying.
    thread::sleep(Duration::from_millis(300));

    let mut store = Store::new(&engine, ());
    let mut linker = Linker::new(&engine);
    linker.define(&mut store, "env", "memory", shared)?;
    let instance = linker.instantiate(&mut store, &module)?;
    let notify = instance.get_typed_func::<i32, i32>(&mut store, "notify")?;
    let woke = notify.call(&mut store, 0)?;

    let wait_result = waiter
        .join()
        .map_err(|_| wasmtime::Error::msg("waiter thread panicked"))??;
    Ok((woke, wait_result))
}

/// Repository root, derived from this crate's manifest location
/// (`crates/host-native` → `../..`).
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

/// Path to the locally-built kernel artifact the smoke tests load
/// (`local-binaries/kernel.wasm`, produced by `install_local_binary kernel`).
pub fn kernel_wasm_path() -> PathBuf {
    repo_root().join("local-binaries").join("kernel.wasm")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use wasm_posix_shared::Syscall;

    /// Return the kernel path, or `None` (with a clear skip message) if it has
    /// not been built. This keeps a fresh checkout without built binaries from
    /// failing with an obscure file-not-found panic; it is not a substitute for
    /// building the kernel in CI.
    fn kernel_path_or_skip() -> Option<PathBuf> {
        let path = kernel_wasm_path();
        if path.exists() {
            Some(path)
        } else {
            eprintln!(
                "SKIP host-native smoke test: {} not found.\n  Build it with:\n    \
                 scripts/dev-shell.sh cargo build --release -p kandelo -Z build-std=core,alloc\n    \
                 source scripts/install-local-binary.sh; \
                 install_local_binary kernel \
                 target/wasm32-unknown-unknown/release/kandelo_kernel.wasm kandelo-kernel.wasm",
                path.display()
            );
            None
        }
    }

    /// Part 1: Wasmtime loads the real ABI-44 kernel.wasm and `__abi_version`
    /// reads back 44, over an imported shared memory with the host imports
    /// stubbed as traps. Also pins the observed import surface.
    #[test]
    fn smoke_loads_real_kernel_and_reads_abi() -> wasmtime::Result<()> {
        let Some(path) = kernel_path_or_skip() else {
            return Ok(());
        };

        let (abi, surface) = load_kernel_and_read_abi(&path)?;
        assert_eq!(
            abi, EXPECTED_ABI_VERSION,
            "kernel __abi_version mismatch: an ABI change requires updating EXPECTED_ABI_VERSION"
        );

        let mem = surface
            .memory
            .as_ref()
            .expect("kernel must import env.memory");
        assert!(mem.shared, "env.memory must be imported shared");
        assert_eq!(
            mem.minimum,
            u64::from(KERNEL_MEMORY_MIN_PAGES),
            "env.memory minimum pages"
        );
        assert_eq!(
            mem.maximum,
            Some(u64::from(KERNEL_MEMORY_MAX_PAGES)),
            "env.memory maximum pages"
        );

        assert!(
            surface.other_imports.is_empty(),
            "unexpected non-(memory|host_*) imports: {:?}",
            surface.other_imports
        );
        assert_eq!(
            surface.host_fn_imports.len(),
            EXPECTED_HOST_IMPORT_COUNT,
            "env.host_* import count changed (surface pinned so ABI drift is visible): {:?}",
            surface.host_fn_imports
        );
        Ok(())
    }

    /// Part 2: the cross-thread atomic wait/notify channel handshake. A waiter
    /// on another OS thread parks in `wait32`; the notifier wakes exactly one
    /// and `wait32` returns 0 (woken).
    #[test]
    fn smoke_channel_wait_notify_handshake() -> wasmtime::Result<()> {
        let (woke, wait_result) = run_wait_notify_handshake()?;
        assert_eq!(woke, 1, "notify must wake exactly one waiter");
        assert_eq!(wait_result, 0, "wait32 must return 0 (woken)");
        Ok(())
    }

    /// Increment 2: the native host boots the real kernel and runs a real
    /// SDK-built guest end-to-end through the channel. The guest issues exactly
    /// mmap → getpid → write → exit_group; a green run proves the whole native
    /// spine (process creation, layout, two-thread wait/notify, RAW pointer
    /// marshalling for write, anon-mmap growth, host_write → stdout, exit code).
    #[test]
    fn smoke_runs_trivial_guest_through_channel() -> anyhow::Result<()> {
        let Some(path) = kernel_path_or_skip() else {
            return Ok(());
        };
        // The committed fixture is built through the SDK exactly like
        // scripts/build-programs.sh (see fixtures/README.md).
        let guest = include_bytes!("../fixtures/native_hello.wasm");

        let outcome = run_trivial_guest(&path, guest)?;

        assert_eq!(
            outcome.exit_code, 0,
            "guest exit code (stdout: {:?}, stderr: {:?}, trace: {:?})",
            String::from_utf8_lossy(&outcome.stdout),
            String::from_utf8_lossy(&outcome.stderr),
            outcome.syscall_trace,
        );
        assert_eq!(
            outcome.stdout,
            b"hello from the native wasmtime host\n",
            "guest stdout must arrive via host_write"
        );
        assert!(outcome.stderr.is_empty(), "guest wrote unexpected stderr");
        // The exact syscall path the program takes, proving it ran (not just
        // exited): the startup argv mmap, __init_tp's set_tid_address, getpid,
        // the write, then exit_group.
        use wasm_posix_shared::abi::extended_syscalls;
        assert_eq!(
            outcome.syscall_trace,
            vec![
                Syscall::Mmap as u32,
                extended_syscalls::SYS_SET_TID_ADDRESS,
                Syscall::Getpid as u32,
                Syscall::Write as u32,
                extended_syscalls::SYS_EXIT_GROUP,
            ],
            "unexpected syscall trace"
        );
        Ok(())
    }

    /// Increment 3: the native host carries a **Phase 2 opaque-record** syscall
    /// end-to-end. `uname(2)` is non-RAW, so the flipped glue self-marshals the
    /// struct-utsname pointer into a record; the host blind-transports it, the
    /// kernel decodes it and writes the struct back into the record's Out span,
    /// and the host blind-copies it back for the guest to unmarshal. A correct
    /// `sysname` line proves the whole opaque-transport round-trip works on a
    /// non-JS engine — the freeze-gate point of the rust-first roadmap.
    #[test]
    fn smoke_runs_record_path_guest_uname() -> anyhow::Result<()> {
        let Some(path) = kernel_path_or_skip() else {
            return Ok(());
        };
        let guest = include_bytes!("../fixtures/native_uname.wasm");

        let outcome = run_trivial_guest(&path, guest)?;

        assert_eq!(
            outcome.exit_code, 0,
            "guest exit code (stdout: {:?}, stderr: {:?}, trace: {:?})",
            String::from_utf8_lossy(&outcome.stdout),
            String::from_utf8_lossy(&outcome.stderr),
            outcome.syscall_trace,
        );
        // The kernel's compiled-in uname sysname (crates/runtime-core sys_uname).
        // If the record round-trip dropped or corrupted the Out span, this line
        // would be empty or garbage instead.
        assert_eq!(
            outcome.stdout, b"wasm-posix\n",
            "uname sysname must arrive via the opaque-record round-trip"
        );
        // The record-path syscall (uname = 75) sits between startup and the write.
        use wasm_posix_shared::abi::extended_syscalls;
        assert_eq!(
            outcome.syscall_trace,
            vec![
                Syscall::Mmap as u32,
                extended_syscalls::SYS_SET_TID_ADDRESS,
                Syscall::Uname as u32,
                Syscall::Write as u32,
                extended_syscalls::SYS_EXIT_GROUP,
            ],
            "unexpected syscall trace"
        );
        Ok(())
    }

    /// Increment 4: the RAW `Out`-buffer copy-back path (untested by the
    /// In-only `write` and the record-path `uname`). A pipe round-trip —
    /// pipe (record Out), write into the in-kernel pipe (RAW In), read back
    /// (RAW Out: the kernel fills the kernel scratch and the host copies it
    /// into the guest buffer), then write to stdout — proves the RAW Out
    /// copy-back and in-kernel pipe I/O on a non-JS engine.
    #[test]
    fn smoke_runs_raw_out_pipe_roundtrip() -> anyhow::Result<()> {
        let Some(path) = kernel_path_or_skip() else {
            return Ok(());
        };
        let guest = include_bytes!("../fixtures/native_pipe.wasm");

        let outcome = run_trivial_guest(&path, guest)?;

        assert_eq!(
            outcome.exit_code, 0,
            "guest exit code (stdout: {:?}, stderr: {:?}, trace: {:?})",
            String::from_utf8_lossy(&outcome.stdout),
            String::from_utf8_lossy(&outcome.stderr),
            outcome.syscall_trace,
        );
        assert_eq!(
            outcome.stdout, b"piped through the native host\n",
            "the bytes read back from the pipe must arrive via RAW Out copy-back"
        );
        // The read (RAW Out) must appear in the trace — the coverage this adds.
        assert!(
            outcome.syscall_trace.contains(&(Syscall::Read as u32)),
            "expected a read syscall in the trace: {:?}",
            outcome.syscall_trace
        );
        Ok(())
    }

    // Increment 5's `smoke_runs_host_fs_open_read` (native_hostfs.c/.wasm)
    // exercised host_lstat/host_open/host_read serving a fixed single-file
    // fake host filesystem as the default `/`. N1-I1a retires that default:
    // the in-kernel rootfs overlay now owns `/` (see `smoke_runs_inmemory_vfs`
    // above), so `host_open` is never reached on the default path and the fake
    // HostFs no longer serves files. The same host_open/host_lstat/host_read
    // capability plumbing is restored, correctly scoped to an explicit native
    // directory mount, by N1-I1b's `smoke_runs_native_dir_mount` below.

    /// Phase 4, increment 1: the native host's blocking wait capability. A
    /// blocking syscall (poll with a timeout, no fds) returns EAGAIN; the host
    /// must own the *waiting* — get a retry token, re-dispatch under it, and on
    /// the deadline force a non-blocking evaluation so the kernel returns 0
    /// (timed out). poll(NULL, 0, N) is the smallest such op: no readiness
    /// sources, no cross-process concurrency, pure timeout path. Proves the
    /// kernel's retry-token protocol drives a blocking wait on a non-JS engine.
    #[test]
    fn smoke_blocking_poll_timeout() -> anyhow::Result<()> {
        let Some(path) = kernel_path_or_skip() else {
            return Ok(());
        };
        let guest = include_bytes!("../fixtures/native_poll.wasm");

        let start = Instant::now();
        let outcome = run_trivial_guest(&path, guest)?;
        let elapsed = start.elapsed();

        assert_eq!(
            outcome.exit_code, 0,
            "guest exit code (stdout: {:?}, stderr: {:?}, trace: {:?})",
            String::from_utf8_lossy(&outcome.stdout),
            String::from_utf8_lossy(&outcome.stderr),
            outcome.syscall_trace,
        );
        assert_eq!(
            outcome.stdout, b"poll timed out\n",
            "poll must return 0 after timing out, not EAGAIN"
        );
        // The guest asked for a 60ms timeout; the host actually waited (rather
        // than returning immediately), so real time must have elapsed. Loose
        // lower bound to stay robust on a busy CI host.
        assert!(
            elapsed >= Duration::from_millis(30),
            "expected the poll timeout to actually wait; elapsed {elapsed:?}"
        );
        Ok(())
    }

    /// Phase 4, readiness-driven blocking on one channel. A blocking read on
    /// stdin returns EAGAIN (the host serves it as not-ready-yet), so the pump
    /// parks it with a retry token and re-dispatches until the host delivers the
    /// line — the read completes from data that arrived after it blocked. This
    /// isolates the read-park/retry path before the two-thread test adds
    /// concurrency.
    #[test]
    fn smoke_blocking_read_becomes_ready() -> anyhow::Result<()> {
        let Some(path) = kernel_path_or_skip() else {
            return Ok(());
        };
        let guest = include_bytes!("../fixtures/native_stdin.wasm");

        let outcome = run_trivial_guest(&path, guest)?;

        assert_eq!(
            outcome.exit_code, 0,
            "guest exit code (stdout: {:?}, stderr: {:?}, trace: {:?})",
            String::from_utf8_lossy(&outcome.stdout),
            String::from_utf8_lossy(&outcome.stderr),
            outcome.syscall_trace,
        );
        assert_eq!(
            outcome.stdout, b"stdin via blocking read\n",
            "the blocked read must complete with the line the host delivered"
        );
        Ok(())
    }

    /// Phase 4 (B.3), the payoff: a blocking read woken across threads. The main
    /// thread blocks in read() on an empty pipe while a second (writer) thread
    /// writes to it. This can only work if the pump services the writer's channel
    /// while the reader is parked — the multi-channel event loop's reason to
    /// exist. Exercises clone/thread-launch, per-thread channels, cross-thread
    /// readiness wakeup, and thread-exit routing.
    #[test]
    fn smoke_blocking_read_woken_by_thread() -> anyhow::Result<()> {
        let Some(path) = kernel_path_or_skip() else {
            return Ok(());
        };
        let guest = include_bytes!("../fixtures/native_thread.wasm");

        let outcome = run_trivial_guest(&path, guest)?;

        assert_eq!(
            outcome.exit_code, 0,
            "guest exit code (stdout: {:?}, stderr: {:?}, trace: {:?})",
            String::from_utf8_lossy(&outcome.stdout),
            String::from_utf8_lossy(&outcome.stderr),
            outcome.syscall_trace,
        );
        assert_eq!(
            outcome.stdout, b"woken by thread\n",
            "the blocked read must complete with the bytes the writer thread sent"
        );
        Ok(())
    }

    /// N1-I1a: the native host defaults to a **sandboxed in-memory VFS** — the
    /// in-kernel rootfs overlay owns `/` and tmpfs owns `/tmp`, both empty and
    /// writable, with no manifest loaded and no blob provider installed. A
    /// `mkdir`/`open(O_CREAT)`/`write`/`lseek`/`read` round-trip under both `/`
    /// and `/tmp` proves the guest gets a real writable filesystem with no host
    /// directory ever mounted. It also proves argv/env are now real (not the
    /// historical `argc == 0` "a.out" fallback): `kernel_get_argc` /
    /// `kernel_argv_read` deliver `argv[1]` to the guest.
    #[test]
    fn smoke_runs_inmemory_vfs() -> anyhow::Result<()> {
        let Some(path) = kernel_path_or_skip() else {
            return Ok(());
        };
        let guest = include_bytes!("../fixtures/native_vfs.wasm");

        let options = guest::GuestOptions {
            argv: vec!["prog".to_string(), "hello".to_string()],
            env: vec![],
            mounts: vec![],
            base_image: None,
            ..Default::default()
        };
        let outcome = guest::run_guest(&path, guest, &options)?;

        assert_eq!(
            outcome.exit_code, 0,
            "guest exit code (stdout: {:?}, stderr: {:?}, trace: {:?})",
            String::from_utf8_lossy(&outcome.stdout),
            String::from_utf8_lossy(&outcome.stderr),
            outcome.syscall_trace,
        );
        assert_eq!(
            outcome.stdout,
            b"hello-data\nhello-tmp\nargc:2\nhello\n".as_slice(),
            "expected the / overlay + /tmp tmpfs round-trip and argv[1] via kernel_argv_read"
        );
        Ok(())
    }

    /// N1-I2: the native host loads a real, hand-built in-memory `BaseImage`
    /// into the rootfs overlay's `/` before rootfs authority is enabled, and a
    /// guest reads a real base file through it. Unlike `smoke_runs_inmemory_vfs`
    /// (which only ever exercises overlay-CREATED files with no manifest
    /// loaded), this proves the boot-time `kernel_rootfs_load_manifest` call
    /// and the `host_blob_read` import (wired in Task 1, unreachable until
    /// this load) both work end-to-end on a non-JS engine: `open("/etc/hello")`
    /// resolves against a `BaseRegular` entry the manifest describes, and its
    /// content comes back byte-for-byte from the image's blob map.
    #[test]
    fn smoke_reads_base_file() -> anyhow::Result<()> {
        let Some(path) = kernel_path_or_skip() else {
            return Ok(());
        };
        let guest = include_bytes!("../fixtures/native_base_read.wasm");

        let base_image = guest::build_base_image(&[
            guest::BaseEntrySpec::dir("/", 1, 0o755),
            guest::BaseEntrySpec::dir("/etc", 2, 0o755),
            guest::BaseEntrySpec::file("/etc/hello", 3, 0o644, b"hi from base\n".to_vec()),
        ]);
        let options = guest::GuestOptions { base_image: Some(base_image), ..Default::default() };
        let outcome = guest::run_guest(&path, guest, &options)?;

        assert_eq!(
            outcome.exit_code, 0,
            "guest exit code (stdout: {:?}, stderr: {:?}, trace: {:?})",
            String::from_utf8_lossy(&outcome.stdout),
            String::from_utf8_lossy(&outcome.stderr),
            outcome.syscall_trace,
        );
        assert_eq!(
            outcome.stdout, b"hi from base\n".as_slice(),
            "expected the base file's real content, served via host_blob_read"
        );
        Ok(())
    }

    /// N1-I1b: an explicit native host-directory mount is the ONLY way to
    /// reach the real host filesystem on this host, at parity with Node's
    /// `extraMounts`/`HostFileSystem`. A top-level mount point (`/host`, so no
    /// overlay parent-dir seeding is needed) is registered as a rootfs
    /// foreign prefix, so the overlay disowns that subtree and the kernel's
    /// path resolution falls through to the native host's mount-aware
    /// `HostFs`. The guest opens/reads a real file under the mounted temp
    /// directory; a byte-exact round-trip proves the whole mechanism: the
    /// foreign-prefix registration, the mount-point-prefix strip, and the
    /// real `host_open`/`host_pread`/`host_close` FS syscalls.
    #[test]
    fn smoke_runs_native_dir_mount() -> anyhow::Result<()> {
        let Some(path) = kernel_path_or_skip() else {
            return Ok(());
        };
        let guest = include_bytes!("../fixtures/native_mount.wasm");

        let host_dir = std::env::temp_dir().join(format!(
            "kandelo-host-native-mount-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&host_dir)?;
        let contents = b"hello from a mounted native directory\n";
        std::fs::write(host_dir.join("greeting.txt"), contents)?;

        let options = guest::GuestOptions {
            mounts: vec![guest::NativeMount {
                mount_point: "/host".to_string(),
                host_dir: host_dir.clone(),
                readonly: false,
            }],
            ..Default::default()
        };
        let outcome = guest::run_guest(&path, guest, &options);
        let _ = std::fs::remove_dir_all(&host_dir);
        let outcome = outcome?;

        assert_eq!(
            outcome.exit_code, 0,
            "guest exit code (stdout: {:?}, stderr: {:?}, trace: {:?})",
            String::from_utf8_lossy(&outcome.stdout),
            String::from_utf8_lossy(&outcome.stderr),
            outcome.syscall_trace,
        );
        assert_eq!(
            outcome.stdout,
            contents.as_slice(),
            "expected the mounted file's real contents via host_open/host_pread"
        );
        Ok(())
    }

    /// N1-I1 final review: a non-canonical `mount_point` (here, `"host"` with
    /// no leading slash) must still work, because the foreign-prefix
    /// registration in `run_guest` and the mount-path stripping in `HostFs`
    /// must agree on the SAME normalized path. Before the fix, `run_guest`
    /// sent the raw `"host"` to `kernel_rootfs_set_foreign_prefixes`, which
    /// silently drops any non-absolute entry (see
    /// `runtime_core::rootfs::set_foreign_prefixes`) — so the overlay kept
    /// claiming `/host`, `open("/host/greeting.txt")` never fell through to
    /// `HostFs`, and the guest exited 10 (ENOENT). This asserts the mount
    /// works anyway: the guest, unaware of the raw config string, still
    /// reads `/host/greeting.txt` (the normalized path `HostFs` serves it
    /// at) successfully.
    #[test]
    fn smoke_runs_native_dir_mount_with_non_canonical_mount_point() -> anyhow::Result<()> {
        let Some(path) = kernel_path_or_skip() else {
            return Ok(());
        };
        let guest = include_bytes!("../fixtures/native_mount.wasm");

        let host_dir = std::env::temp_dir().join(format!(
            "kandelo-host-native-mount-noncanon-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&host_dir)?;
        let contents = b"hello from a non-canonically-mounted native directory\n";
        std::fs::write(host_dir.join("greeting.txt"), contents)?;

        let options = guest::GuestOptions {
            // No leading slash: `HostFs` still normalizes this to `/host`
            // (see `normalize_mount_point`), so the guest's fixed
            // `open("/host/greeting.txt")` must still resolve into
            // `host_dir` if the foreign-prefix registration agrees.
            mounts: vec![guest::NativeMount {
                mount_point: "host".to_string(),
                host_dir: host_dir.clone(),
                readonly: false,
            }],
            ..Default::default()
        };
        let outcome = guest::run_guest(&path, guest, &options);
        let _ = std::fs::remove_dir_all(&host_dir);
        let outcome = outcome?;

        assert_eq!(
            outcome.exit_code, 0,
            "guest exit code (stdout: {:?}, stderr: {:?}, trace: {:?}) — a non-canonical \
             mount_point (\"host\", no leading slash) must still work: the foreign-prefix \
             registration must use the same normalized path HostFs serves",
            String::from_utf8_lossy(&outcome.stdout),
            String::from_utf8_lossy(&outcome.stderr),
            outcome.syscall_trace,
        );
        assert_eq!(
            outcome.stdout,
            contents.as_slice(),
            "expected the mounted file's real contents via host_open/host_pread"
        );
        Ok(())
    }

    /// Phase 4, epoll readiness. The browser/Node host is the one place epoll
    /// readiness is still reimplemented in TypeScript: epoll_pwait is converted
    /// to a host-built poll and never reaches the kernel's sys_epoll_pwait (a
    /// Chrome V8 crash workaround). This proves the kernel's own epoll path is
    /// sound when driven through the real channel on a non-V8 engine — the
    /// prerequisite for moving that decision back into the kernel for the JS
    /// hosts. The guest makes a pipe readable, registers EPOLLIN via epoll_ctl,
    /// and the kernel's sys_epoll_pwait detects and reports it.
    #[test]
    fn smoke_epoll_readiness_via_kernel() -> anyhow::Result<()> {
        let Some(path) = kernel_path_or_skip() else {
            return Ok(());
        };
        let guest = include_bytes!("../fixtures/native_epoll.wasm");

        let outcome = run_trivial_guest(&path, guest)?;

        assert_eq!(
            outcome.exit_code, 0,
            "guest exit code (stdout: {:?}, stderr: {:?}, trace: {:?})",
            String::from_utf8_lossy(&outcome.stdout),
            String::from_utf8_lossy(&outcome.stderr),
            outcome.syscall_trace,
        );
        assert_eq!(
            outcome.stdout, b"epoll ready\n",
            "epoll_wait must report the readable pipe (kernel-decided readiness)"
        );
        use wasm_posix_shared::abi::extended_syscalls as ext;
        assert!(
            outcome.syscall_trace.contains(&ext::SYS_EPOLL_CTL)
                && outcome.syscall_trace.contains(&ext::SYS_EPOLL_PWAIT),
            "expected epoll_ctl and epoll_pwait in the trace (routed to the kernel, \
             not a host poll conversion): {:?}",
            outcome.syscall_trace
        );
        Ok(())
    }

    /// N1-I3a Task 2: `posix_spawn` launches a FRESH-IMAGE child process
    /// (never a fork) resolved from the native host's `GuestOptions.programs`
    /// map. The parent `posix_spawn`s `"child"` and exits; the child (a
    /// distinct guest module, its own memory, its own OS thread) runs to
    /// completion and writes its own line. Reaping (`waitpid`) is Task 3 —
    /// not exercised here — so this proves only that `SYS_SPAWN` is
    /// intercepted, the blob is decoded and resolved via `programs`, and the
    /// child is actually launched and runs: its stdout must appear in the
    /// SAME captured buffer as the parent's (`host_write` is keyed by fd, not
    /// by process). The pump drains the spawned child to completion before
    /// returning (see `run_pump`'s doc comment), so this assertion is not a
    /// race against the child's startup.
    #[test]
    fn smoke_spawn_launches_child() -> anyhow::Result<()> {
        let Some(path) = kernel_path_or_skip() else {
            return Ok(());
        };
        let parent = include_bytes!("../fixtures/native_spawn_parent.wasm");
        let child = include_bytes!("../fixtures/native_spawn_child.wasm");

        let mut programs = std::collections::HashMap::new();
        programs.insert("child".to_string(), child.to_vec());
        let options = guest::GuestOptions { programs, ..Default::default() };
        let outcome = guest::run_guest(&path, parent, &options)?;

        assert_eq!(
            outcome.exit_code, 0,
            "parent exit code (stdout: {:?}, stderr: {:?}, trace: {:?})",
            String::from_utf8_lossy(&outcome.stdout),
            String::from_utf8_lossy(&outcome.stderr),
            outcome.syscall_trace,
        );
        assert!(
            outcome
                .stdout
                .windows(b"child ok\n".len())
                .any(|w| w == b"child ok\n"),
            "expected the spawned child's stdout line to appear: {:?}",
            String::from_utf8_lossy(&outcome.stdout)
        );
        Ok(())
    }

    /// N1-I3a Task 3: `host_waitpid` parked reaping. The parent `posix_spawn`s
    /// `"child"` (same fixtures as `smoke_spawn_launches_child`), then
    /// `waitpid`s it and prints the decoded `WEXITSTATUS`. The child hasn't
    /// necessarily exited by the time the parent calls `waitpid` — this
    /// proves the PARKED-retry path (the pump keeps servicing the child's
    /// channel while the parent's `wait4` is parked as EAGAIN, exactly like
    /// the existing blocking poll/read table), not just an already-exited
    /// child. `child _exit(7)` must decode to `WEXITSTATUS == 7`.
    #[test]
    fn smoke_spawn_waitpid() -> anyhow::Result<()> {
        let Some(path) = kernel_path_or_skip() else {
            return Ok(());
        };
        let parent = include_bytes!("../fixtures/native_spawn_parent.wasm");
        let child = include_bytes!("../fixtures/native_spawn_child.wasm");

        let mut programs = std::collections::HashMap::new();
        programs.insert("child".to_string(), child.to_vec());
        let options = guest::GuestOptions { programs, ..Default::default() };
        let outcome = guest::run_guest(&path, parent, &options)?;

        assert_eq!(
            outcome.exit_code, 0,
            "parent exit code (stdout: {:?}, stderr: {:?}, trace: {:?})",
            String::from_utf8_lossy(&outcome.stdout),
            String::from_utf8_lossy(&outcome.stderr),
            outcome.syscall_trace,
        );
        let stdout = String::from_utf8_lossy(&outcome.stdout);
        assert!(stdout.contains("child ok"), "expected the child's stdout line: {stdout:?}");
        assert!(
            stdout.contains("status=7"),
            "expected the parent to report the reaped child's WEXITSTATUS (7): {stdout:?}"
        );
        Ok(())
    }
}

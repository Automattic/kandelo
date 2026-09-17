//! The wasm export surface.
//!
//! These are the function values the host splices straight into the guest's
//! `wasi_snapshot_preview1` import namespace. Each export name and signature
//! is fixed by the WASI Preview 1 specification, so the guest calls them as
//! ordinary wasm->wasm calls with no JavaScript frame in between. K10 probe 1
//! confirmed a side module's export is directly usable as another instance's
//! import, i64 parameters included, on Node, Chromium, and WebKit.
//!
//! Everything here is a thin adapter: it unwraps the process-wide shim and
//! flattens `Result<(), WasiErrno>` into the `i32` errno the guest expects.
//! All behavior lives in [`crate::shim`], where it is testable on the host.

use core::cell::UnsafeCell;

use wasi_abi::WasiErrno;

use crate::channel::WasmChannel;
use crate::mem::WasmMemory;
use crate::shim::{StringBlob, WasiShim};

type Shim = WasiShim<WasmMemory, WasmChannel>;

/// The process's single shim.
///
/// A process worker runs one guest on one thread, and every WASI call arrives
/// on that thread, so there is no concurrent access to guard against. The
/// wrapper exists because a `static mut` reference is denied in this edition,
/// not because a lock is needed.
struct ShimCell(UnsafeCell<Option<Shim>>);

// SAFETY: wasm32 without threads in this module; see the note above.
unsafe impl Sync for ShimCell {}

static SHIM: ShimCell = ShimCell(UnsafeCell::new(None));

/// Called before the guest is instantiated but after the process is
/// kernel-registered, so the channel is already live.
///
/// `argv`/`env` are NUL-separated blobs the host has already written into
/// guest memory. Passing their location rather than the strings keeps the
/// module free of an allocator and of any UTF-8 handling.
#[unsafe(no_mangle)]
pub extern "C" fn wasi_module_init(
    channel_offset: u32,
    argv_ptr: u32,
    argv_count: u32,
    argv_bytes: u32,
    env_ptr: u32,
    env_count: u32,
    env_bytes: u32,
) -> i32 {
    // SAFETY: single-threaded; see `ShimCell`.
    let slot = unsafe { &mut *SHIM.0.get() };
    *slot = Some(WasiShim::new(
        WasmMemory,
        WasmChannel::new(channel_offset as u64),
        StringBlob {
            ptr: argv_ptr,
            count: argv_count,
            bytes: argv_bytes,
        },
        StringBlob {
            ptr: env_ptr,
            count: env_count,
            bytes: env_bytes,
        },
    ));
    0
}

/// Open the `/` preopen. Separate from `wasi_module_init` because it issues a
/// syscall, and the host may want the module instantiated before it is
/// willing to block.
#[unsafe(no_mangle)]
pub extern "C" fn wasi_module_start() -> i32 {
    with_mut(|shim| shim.init())
}

fn with(f: impl FnOnce(&Shim) -> Result<(), WasiErrno>) -> i32 {
    // SAFETY: single-threaded; see `ShimCell`.
    let slot = unsafe { &*SHIM.0.get() };
    match slot {
        // A WASI call before `wasi_module_init` is a host sequencing bug, not
        // something the guest can cause. Report it rather than trapping.
        None => WasiErrno::NotCapable.as_i32(),
        Some(shim) => flatten(f(shim)),
    }
}

fn with_mut(f: impl FnOnce(&mut Shim) -> Result<(), WasiErrno>) -> i32 {
    // SAFETY: single-threaded; see `ShimCell`.
    let slot = unsafe { &mut *SHIM.0.get() };
    match slot {
        None => WasiErrno::NotCapable.as_i32(),
        Some(shim) => flatten(f(shim)),
    }
}

fn flatten(result: Result<(), WasiErrno>) -> i32 {
    match result {
        Ok(()) => WasiErrno::Success.as_i32(),
        Err(errno) => errno.as_i32(),
    }
}

/// Defines a `wasi_snapshot_preview1` export that borrows the shim immutably.
macro_rules! wasi_export {
    ($name:ident ( $($arg:ident : $ty:ty),* $(,)? ) => $method:ident) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn $name($($arg: $ty),*) -> i32 {
            with(|shim| shim.$method($($arg),*))
        }
    };
}

/// Same, for the two entry points that mutate the preopen table.
macro_rules! wasi_export_mut {
    ($name:ident ( $($arg:ident : $ty:ty),* $(,)? ) => $method:ident) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn $name($($arg: $ty),*) -> i32 {
            with_mut(|shim| shim.$method($($arg),*))
        }
    };
}

/// Vestigial `__heap_base` / `__data_end` exports.
///
/// `rustc` unconditionally appends `--export=__heap_base --export=__data_end`
/// for a wasm `cdylib`, but a position-independent (`--pie`) side module has
/// no static heap base -- its data lives at `__memory_base`-relative offsets
/// the HOST chooses -- so `wasm-ld` does not define them and the forced export
/// fails to link. Defining these trivial symbols satisfies the export. Their
/// values are meaningless and nothing consumes them; `crates/fork-module`
/// carries the same workaround for the same reason.
#[unsafe(no_mangle)]
pub extern "C" fn __heap_base() -> i32 {
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn __data_end() -> i32 {
    0
}

// --- args / environ -------------------------------------------------------
wasi_export!(args_get(argv: u32, argv_buf: u32) => args_get);
wasi_export!(args_sizes_get(argc_out: u32, buf_size_out: u32) => args_sizes_get);
wasi_export!(environ_get(environ: u32, environ_buf: u32) => environ_get);
wasi_export!(environ_sizes_get(count_out: u32, size_out: u32) => environ_sizes_get);

// --- clocks ---------------------------------------------------------------
wasi_export!(clock_res_get(clock_id: u32, res_out: u32) => clock_res_get);
wasi_export!(clock_time_get(clock_id: u32, precision: u64, time_out: u32) => clock_time_get);

// --- fd -------------------------------------------------------------------
#[unsafe(no_mangle)]
pub extern "C" fn fd_advise(_fd: u32, _offset: u64, _len: u64, _advice: u32) -> i32 {
    with(|shim| shim.fd_advise())
}
wasi_export!(fd_allocate(fd: u32, offset: u64, len: u64) => fd_allocate);
wasi_export_mut!(fd_close(fd: u32) => fd_close);
wasi_export!(fd_datasync(fd: u32) => fd_datasync);
wasi_export!(fd_fdstat_get(fd: u32, fdstat_ptr: u32) => fd_fdstat_get);
wasi_export!(fd_fdstat_set_flags(fd: u32, fdflags: u16) => fd_fdstat_set_flags);
#[unsafe(no_mangle)]
pub extern "C" fn fd_fdstat_set_rights(_fd: u32, _base: u64, _inheriting: u64) -> i32 {
    with(|shim| shim.fd_fdstat_set_rights())
}
wasi_export!(fd_filestat_get(fd: u32, filestat_ptr: u32) => fd_filestat_get);
wasi_export!(fd_filestat_set_size(fd: u32, size: u64) => fd_filestat_set_size);
wasi_export!(
    fd_filestat_set_times(fd: u32, atim: u64, mtim: u64, fst_flags: u16)
        => fd_filestat_set_times
);
wasi_export!(
    fd_pread(fd: u32, iovs: u32, iovs_len: u32, offset: u64, nread_out: u32) => fd_pread
);
wasi_export!(fd_prestat_get(fd: u32, prestat_ptr: u32) => fd_prestat_get);
wasi_export!(fd_prestat_dir_name(fd: u32, path: u32, path_len: u32) => fd_prestat_dir_name);
wasi_export!(
    fd_pwrite(fd: u32, iovs: u32, iovs_len: u32, offset: u64, nwritten_out: u32) => fd_pwrite
);
wasi_export!(fd_read(fd: u32, iovs: u32, iovs_len: u32, nread_out: u32) => fd_read);
wasi_export!(
    fd_readdir(fd: u32, buf: u32, buf_len: u32, cookie: u64, size_out: u32) => fd_readdir
);
wasi_export_mut!(fd_renumber(from: u32, to: u32) => fd_renumber);
wasi_export!(fd_seek(fd: u32, offset: i64, whence: u32, new_offset_out: u32) => fd_seek);
wasi_export!(fd_sync(fd: u32) => fd_sync);
wasi_export!(fd_tell(fd: u32, offset_out: u32) => fd_tell);
wasi_export!(fd_write(fd: u32, iovs: u32, iovs_len: u32, nwritten_out: u32) => fd_write);

// --- paths ----------------------------------------------------------------
wasi_export!(path_create_directory(fd: u32, path: u32, path_len: u32) => path_create_directory);
wasi_export!(
    path_filestat_get(fd: u32, flags: u32, path: u32, path_len: u32, filestat_ptr: u32)
        => path_filestat_get
);
wasi_export!(
    path_filestat_set_times(
        fd: u32, flags: u32, path: u32, path_len: u32,
        atim: u64, mtim: u64, fst_flags: u16,
    ) => path_filestat_set_times
);
wasi_export!(
    path_link(
        old_fd: u32, old_flags: u32, old_path: u32, old_len: u32,
        new_fd: u32, new_path: u32, new_len: u32,
    ) => path_link
);
wasi_export!(
    path_open(
        dirfd: u32, lookup_flags: u32, path: u32, path_len: u32,
        oflags: u16, rights_base: u64, rights_inheriting: u64,
        fdflags: u16, fd_out: u32,
    ) => path_open
);
wasi_export!(
    path_readlink(fd: u32, path: u32, path_len: u32, buf: u32, buf_len: u32, size_out: u32)
        => path_readlink
);
wasi_export!(path_remove_directory(fd: u32, path: u32, path_len: u32) => path_remove_directory);
wasi_export!(
    path_rename(
        old_fd: u32, old_path: u32, old_len: u32,
        new_fd: u32, new_path: u32, new_len: u32,
    ) => path_rename
);
wasi_export!(
    path_symlink(old_path: u32, old_len: u32, fd: u32, new_path: u32, new_len: u32)
        => path_symlink
);
wasi_export!(path_unlink_file(fd: u32, path: u32, path_len: u32) => path_unlink_file);

// --- poll / process -------------------------------------------------------
wasi_export!(
    poll_oneoff(in_ptr: u32, out_ptr: u32, nsubscriptions: u32, nevents_out: u32)
        => poll_oneoff
);

/// Issues `SYS_EXIT` and returns.
///
/// Unwinding the guest out of `_start` stays a host act: `worker-main.ts`
/// wraps this in the one JS thunk that throws `WasiExit` after it returns.
/// The alternatives -- trapping, or minting an exception tag -- both turn a
/// normal exit into something noisier for no gain on a path taken once per
/// process.
#[unsafe(no_mangle)]
pub extern "C" fn proc_exit(code: u32) {
    // SAFETY: single-threaded; see `ShimCell`.
    if let Some(shim) = unsafe { &*SHIM.0.get() } {
        shim.proc_exit(code);
    }
}

wasi_export!(proc_raise(sig: u32) => proc_raise);
#[unsafe(no_mangle)]
pub extern "C" fn sched_yield() -> i32 {
    with(|shim| shim.sched_yield())
}
wasi_export!(random_get(buf: u32, buf_len: u32) => random_get);

// --- sockets --------------------------------------------------------------
#[unsafe(no_mangle)]
pub extern "C" fn sock_accept(_fd: u32, _flags: u32, _fd_out: u32) -> i32 {
    with(|shim| shim.sock_accept())
}
wasi_export!(
    sock_recv(
        fd: u32, iovs: u32, iovs_len: u32, ri_flags: u16,
        ro_datalen_out: u32, ro_flags_out: u32,
    ) => sock_recv
);
wasi_export!(
    sock_send(fd: u32, iovs: u32, iovs_len: u32, si_flags: u16, nwritten_out: u32) => sock_send
);
wasi_export!(sock_shutdown(fd: u32, how: u32) => sock_shutdown);

//! Wasm export layer -- FFI boundary that the TypeScript host calls.
//!
//! This module supports two operating modes:
//!
//! **Mode 0 (Traditional):** Each process Worker instantiates its own kernel.
//! Syscalls go through 156 `kernel_*` exports. The Global Kernel Lock (GKL)
//! serializes access when threads share the kernel. Process state lives in
//! the global `PROCESS`.
//!
//! **Mode 1 (Centralized):** A single kernel instance manages all processes
//! via `kernel_handle_channel`. Process state lives in `PROCESS_TABLE`.
//! User programs use channel IPC (channel_syscall.c) instead of kernel imports.
//! GKL is bypassed. The 156 `kernel_*` exports are unused.
//!
//! This module declares:
//! 1. Host function imports (functions the host must provide).
//! 2. A `WasmHostIO` struct implementing the `HostIO` trait via those imports.
//! 3. Global kernel state (`PROCESS` for mode=0, `PROCESS_TABLE` for mode=1).
//! 4. Export functions: 156 `kernel_*` (mode=0) + channel/process-table (mode=1).

extern crate alloc;

use alloc::vec::Vec;
use core::slice;

use wasm_posix_shared::{Errno, WasmDirent, WasmStat, WasmTimespec};
use wasm_posix_shared::fd_flags::FD_CLOEXEC;

use crate::ofd::FileType;
use crate::process::{HostIO, Process};
use crate::syscalls;

// ---------------------------------------------------------------------------
// 1. Host function imports
// ---------------------------------------------------------------------------

#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn host_debug_log(ptr: *const u8, len: u32);
    fn host_open(path_ptr: *const u8, path_len: u32, flags: u32, mode: u32) -> i64;
    fn host_close(handle: i64) -> i32;
    fn host_read(handle: i64, buf_ptr: *mut u8, buf_len: u32) -> i32;
    fn host_write(handle: i64, buf_ptr: *const u8, buf_len: u32) -> i32;
    fn host_seek(handle: i64, offset_lo: u32, offset_hi: i32, whence: u32) -> i64;
    fn host_fstat(handle: i64, stat_ptr: *mut u8) -> i32;
    fn host_stat(path_ptr: *const u8, path_len: u32, stat_ptr: *mut u8) -> i32;
    fn host_lstat(path_ptr: *const u8, path_len: u32, stat_ptr: *mut u8) -> i32;
    fn host_mkdir(path_ptr: *const u8, path_len: u32, mode: u32) -> i32;
    fn host_rmdir(path_ptr: *const u8, path_len: u32) -> i32;
    fn host_unlink(path_ptr: *const u8, path_len: u32) -> i32;
    fn host_rename(old_ptr: *const u8, old_len: u32, new_ptr: *const u8, new_len: u32) -> i32;
    fn host_link(old_ptr: *const u8, old_len: u32, new_ptr: *const u8, new_len: u32) -> i32;
    fn host_symlink(target_ptr: *const u8, target_len: u32, link_ptr: *const u8, link_len: u32) -> i32;
    fn host_readlink(path_ptr: *const u8, path_len: u32, buf_ptr: *mut u8, buf_len: u32) -> i32;
    fn host_chmod(path_ptr: *const u8, path_len: u32, mode: u32) -> i32;
    fn host_chown(path_ptr: *const u8, path_len: u32, uid: u32, gid: u32) -> i32;
    fn host_access(path_ptr: *const u8, path_len: u32, amode: u32) -> i32;
    fn host_opendir(path_ptr: *const u8, path_len: u32) -> i64;
    fn host_readdir(dir_handle: i64, dirent_ptr: *mut u8, name_ptr: *mut u8, name_len: u32) -> i32;
    fn host_closedir(dir_handle: i64) -> i32;
    fn host_clock_gettime(clock_id: u32, sec_ptr: *mut i64, nsec_ptr: *mut i64) -> i32;
    fn host_nanosleep(sec: i64, nsec: i64) -> i32;
    fn host_ftruncate(handle: i64, length: i64) -> i32;
    fn host_fsync(handle: i64) -> i32;
    fn host_fchmod(handle: i64, mode: u32) -> i32;
    fn host_fchown(handle: i64, uid: u32, gid: u32) -> i32;
    fn host_kill(pid: i32, sig: u32) -> i32;
    fn host_exec(path_ptr: *const u8, path_len: u32) -> i32;
    fn host_set_alarm(seconds: u32) -> i32;
    fn host_set_posix_timer(timer_id: i32, signo: i32, value_ms_lo: u32, value_ms_hi: u32, interval_ms_lo: u32, interval_ms_hi: u32) -> i32;
    fn host_sigsuspend_wait() -> i32;
    fn host_call_signal_handler(handler_index: u32, signum: u32, sa_flags: u32) -> i32;
    fn host_getrandom(buf_ptr: *mut u8, buf_len: u32) -> i32;
    fn host_utimensat(path_ptr: *const u8, path_len: u32, atime_sec: i64, atime_nsec: i64, mtime_sec: i64, mtime_nsec: i64) -> i32;
    fn host_waitpid(pid: i32, options: u32, status_ptr: *mut i32) -> i32;
    fn host_net_connect(handle: i32, addr_ptr: *const u8, addr_len: u32, port: u32) -> i32;
    fn host_net_send(handle: i32, buf_ptr: *const u8, buf_len: u32, flags: u32) -> i32;
    fn host_net_recv(handle: i32, buf_ptr: *mut u8, buf_len: u32, flags: u32) -> i32;
    fn host_net_close(handle: i32) -> i32;
    fn host_net_listen(fd: i32, port: u32, addr_a: u32, addr_b: u32, addr_c: u32, addr_d: u32) -> i32;
    fn host_getaddrinfo(name_ptr: *const u8, name_len: u32, result_ptr: *mut u8, result_len: u32) -> i32;
    fn host_fcntl_lock(
        path_ptr: *const u8, path_len: u32,
        pid: u32, cmd: u32, lock_type: u32,
        start_lo: u32, start_hi: u32,
        len_lo: u32, len_hi: u32,
        result_ptr: *mut u8,
    ) -> i32;
    fn host_fork() -> i32;
    fn host_futex_wait(addr: u32, expected: u32, timeout_ns_lo: u32, timeout_ns_hi: u32) -> i32;
    fn host_futex_wake(addr: u32, count: u32) -> i32;
    fn host_clone(fn_ptr: u32, arg: u32, stack_ptr: u32, tls_ptr: u32, ctid_ptr: u32) -> i32;
    fn host_is_thread_worker() -> i32;
}

// ---------------------------------------------------------------------------
// 2. WasmHostIO -- bridges HostIO trait to the imported host functions
// ---------------------------------------------------------------------------

struct WasmHostIO;

/// Map a negative i32 return value from the host to an `Errno`.
/// Negative means error; the absolute value is the errno code.
fn i32_to_result(val: i32) -> Result<(), Errno> {
    if val < 0 {
        match Errno::from_u32((-val) as u32) {
            Some(e) => Err(e),
            None => Err(Errno::EIO),
        }
    } else {
        Ok(())
    }
}

impl HostIO for WasmHostIO {
    fn host_open(&mut self, path: &[u8], flags: u32, mode: u32) -> Result<i64, Errno> {
        let result = unsafe { host_open(path.as_ptr(), path.len() as u32, flags, mode) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result)
        }
    }

    fn host_close(&mut self, handle: i64) -> Result<(), Errno> {
        let result = unsafe { host_close(handle) };
        i32_to_result(result)
    }

    fn host_read(&mut self, handle: i64, buf: &mut [u8]) -> Result<usize, Errno> {
        let result = unsafe { host_read(handle, buf.as_mut_ptr(), buf.len() as u32) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }

    fn host_write(&mut self, handle: i64, buf: &[u8]) -> Result<usize, Errno> {
        let result = unsafe { host_write(handle, buf.as_ptr(), buf.len() as u32) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }

    fn host_seek(&mut self, handle: i64, offset: i64, whence: u32) -> Result<i64, Errno> {
        let offset_lo = offset as u32;
        let offset_hi = (offset >> 32) as i32;
        let result = unsafe { host_seek(handle, offset_lo, offset_hi, whence) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result)
        }
    }

    fn host_fstat(&mut self, handle: i64) -> Result<WasmStat, Errno> {
        let mut stat = WasmStat {
            st_dev: 0,
            st_ino: 0,
            st_mode: 0,
            st_nlink: 0,
            st_uid: 0,
            st_gid: 0,
            st_size: 0,
            st_atime_sec: 0,
            st_atime_nsec: 0,
            st_mtime_sec: 0,
            st_mtime_nsec: 0,
            st_ctime_sec: 0,
            st_ctime_nsec: 0,
            _pad: 0,
        };
        let stat_ptr = &mut stat as *mut WasmStat as *mut u8;
        let result = unsafe { host_fstat(handle, stat_ptr) };
        i32_to_result(result)?;
        Ok(stat)
    }

    fn host_stat(&mut self, path: &[u8]) -> Result<WasmStat, Errno> {
        let mut stat = WasmStat {
            st_dev: 0, st_ino: 0, st_mode: 0, st_nlink: 0, st_uid: 0, st_gid: 0,
            st_size: 0, st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0,
            st_mtime_nsec: 0, st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
        };
        let stat_ptr = &mut stat as *mut WasmStat as *mut u8;
        let result = unsafe { host_stat(path.as_ptr(), path.len() as u32, stat_ptr) };
        i32_to_result(result)?;
        Ok(stat)
    }

    fn host_lstat(&mut self, path: &[u8]) -> Result<WasmStat, Errno> {
        let mut stat = WasmStat {
            st_dev: 0, st_ino: 0, st_mode: 0, st_nlink: 0, st_uid: 0, st_gid: 0,
            st_size: 0, st_atime_sec: 0, st_atime_nsec: 0, st_mtime_sec: 0,
            st_mtime_nsec: 0, st_ctime_sec: 0, st_ctime_nsec: 0, _pad: 0,
        };
        let stat_ptr = &mut stat as *mut WasmStat as *mut u8;
        let result = unsafe { host_lstat(path.as_ptr(), path.len() as u32, stat_ptr) };
        i32_to_result(result)?;
        Ok(stat)
    }

    fn host_mkdir(&mut self, path: &[u8], mode: u32) -> Result<(), Errno> {
        let result = unsafe { host_mkdir(path.as_ptr(), path.len() as u32, mode) };
        i32_to_result(result)
    }

    fn host_rmdir(&mut self, path: &[u8]) -> Result<(), Errno> {
        let result = unsafe { host_rmdir(path.as_ptr(), path.len() as u32) };
        i32_to_result(result)
    }

    fn host_unlink(&mut self, path: &[u8]) -> Result<(), Errno> {
        let result = unsafe { host_unlink(path.as_ptr(), path.len() as u32) };
        i32_to_result(result)
    }

    fn host_rename(&mut self, oldpath: &[u8], newpath: &[u8]) -> Result<(), Errno> {
        let result = unsafe {
            host_rename(
                oldpath.as_ptr(), oldpath.len() as u32,
                newpath.as_ptr(), newpath.len() as u32,
            )
        };
        i32_to_result(result)
    }

    fn host_link(&mut self, oldpath: &[u8], newpath: &[u8]) -> Result<(), Errno> {
        let result = unsafe {
            host_link(
                oldpath.as_ptr(), oldpath.len() as u32,
                newpath.as_ptr(), newpath.len() as u32,
            )
        };
        i32_to_result(result)
    }

    fn host_symlink(&mut self, target: &[u8], linkpath: &[u8]) -> Result<(), Errno> {
        let result = unsafe {
            host_symlink(
                target.as_ptr(), target.len() as u32,
                linkpath.as_ptr(), linkpath.len() as u32,
            )
        };
        i32_to_result(result)
    }

    fn host_readlink(&mut self, path: &[u8], buf: &mut [u8]) -> Result<usize, Errno> {
        let result = unsafe {
            host_readlink(path.as_ptr(), path.len() as u32, buf.as_mut_ptr(), buf.len() as u32)
        };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }

    fn host_chmod(&mut self, path: &[u8], mode: u32) -> Result<(), Errno> {
        let result = unsafe { host_chmod(path.as_ptr(), path.len() as u32, mode) };
        i32_to_result(result)
    }

    fn host_chown(&mut self, path: &[u8], uid: u32, gid: u32) -> Result<(), Errno> {
        let result = unsafe { host_chown(path.as_ptr(), path.len() as u32, uid, gid) };
        i32_to_result(result)
    }

    fn host_access(&mut self, path: &[u8], amode: u32) -> Result<(), Errno> {
        let result = unsafe { host_access(path.as_ptr(), path.len() as u32, amode) };
        i32_to_result(result)
    }

    fn host_opendir(&mut self, path: &[u8]) -> Result<i64, Errno> {
        let result = unsafe { host_opendir(path.as_ptr(), path.len() as u32) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result)
        }
    }

    fn host_readdir(&mut self, handle: i64, name_buf: &mut [u8]) -> Result<Option<(u64, u32, usize)>, Errno> {
        let mut dirent = WasmDirent { d_ino: 0, d_type: 0, d_namlen: 0 };
        let dirent_ptr = &mut dirent as *mut WasmDirent as *mut u8;
        let result = unsafe {
            host_readdir(handle, dirent_ptr, name_buf.as_mut_ptr(), name_buf.len() as u32)
        };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else if result == 0 {
            Ok(None)
        } else {
            Ok(Some((dirent.d_ino, dirent.d_type, dirent.d_namlen as usize)))
        }
    }

    fn host_closedir(&mut self, handle: i64) -> Result<(), Errno> {
        let result = unsafe { host_closedir(handle) };
        i32_to_result(result)
    }

    fn host_clock_gettime(&mut self, clock_id: u32) -> Result<(i64, i64), Errno> {
        let mut sec: i64 = 0;
        let mut nsec: i64 = 0;
        let result = unsafe {
            host_clock_gettime(clock_id, &mut sec as *mut i64, &mut nsec as *mut i64)
        };
        i32_to_result(result)?;
        Ok((sec, nsec))
    }

    fn host_nanosleep(&mut self, seconds: i64, nanoseconds: i64) -> Result<(), Errno> {
        gkl_release();
        let result = unsafe { host_nanosleep(seconds, nanoseconds) };
        gkl_acquire();
        i32_to_result(result)
    }

    fn host_ftruncate(&mut self, handle: i64, length: i64) -> Result<(), Errno> {
        let result = unsafe { host_ftruncate(handle, length) };
        i32_to_result(result)
    }

    fn host_fsync(&mut self, handle: i64) -> Result<(), Errno> {
        let result = unsafe { host_fsync(handle) };
        i32_to_result(result)
    }

    fn host_fchmod(&mut self, handle: i64, mode: u32) -> Result<(), Errno> {
        let result = unsafe { host_fchmod(handle, mode) };
        i32_to_result(result)
    }

    fn host_fchown(&mut self, handle: i64, uid: u32, gid: u32) -> Result<(), Errno> {
        let result = unsafe { host_fchown(handle, uid, gid) };
        i32_to_result(result)
    }

    fn host_kill(&mut self, pid: i32, sig: u32) -> Result<(), Errno> {
        let ret = unsafe { host_kill(pid, sig) };
        if ret < 0 {
            match Errno::from_u32((-ret) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(())
        }
    }

    fn host_exec(&mut self, path: &[u8]) -> Result<(), Errno> {
        let ret = unsafe { host_exec(path.as_ptr(), path.len() as u32) };
        if ret < 0 {
            match Errno::from_u32((-ret) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(())
        }
    }

    fn host_set_alarm(&mut self, seconds: u32) -> Result<(), Errno> {
        let result = unsafe { host_set_alarm(seconds) };
        i32_to_result(result)
    }

    fn host_set_posix_timer(&mut self, timer_id: i32, signo: i32, value_ms: i64, interval_ms: i64) -> Result<(), Errno> {
        let result = unsafe {
            host_set_posix_timer(
                timer_id, signo,
                value_ms as u32, (value_ms >> 32) as u32,
                interval_ms as u32, (interval_ms >> 32) as u32,
            )
        };
        i32_to_result(result)
    }

    fn host_sigsuspend_wait(&mut self) -> Result<u32, Errno> {
        gkl_release();
        let result = unsafe { host_sigsuspend_wait() };
        gkl_acquire();
        if result < 0 {
            Err(Errno::from_u32((-result) as u32).unwrap_or(Errno::EINTR))
        } else {
            Ok(result as u32)
        }
    }

    fn host_call_signal_handler(&mut self, handler_index: u32, signum: u32, sa_flags: u32) -> Result<(), Errno> {
        let result = unsafe { host_call_signal_handler(handler_index, signum, sa_flags) };
        i32_to_result(result)
    }

    fn host_getrandom(&mut self, buf: &mut [u8]) -> Result<usize, Errno> {
        let result = unsafe { host_getrandom(buf.as_mut_ptr(), buf.len() as u32) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }

    fn host_utimensat(&mut self, path: &[u8], atime_sec: i64, atime_nsec: i64, mtime_sec: i64, mtime_nsec: i64) -> Result<(), Errno> {
        let result = unsafe { host_utimensat(path.as_ptr(), path.len() as u32, atime_sec, atime_nsec, mtime_sec, mtime_nsec) };
        i32_to_result(result)
    }
    fn host_waitpid(&mut self, pid: i32, options: u32) -> Result<(i32, i32), Errno> {
        let mut status: i32 = 0;
        gkl_release();
        let result = unsafe { host_waitpid(pid, options, &mut status) };
        gkl_acquire();
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok((result, status))
        }
    }

    fn host_net_connect(&mut self, handle: i32, addr: &[u8], port: u16) -> Result<(), Errno> {
        let result = unsafe { host_net_connect(handle, addr.as_ptr(), addr.len() as u32, port as u32) };
        i32_to_result(result)
    }

    fn host_net_send(&mut self, handle: i32, data: &[u8], flags: u32) -> Result<usize, Errno> {
        let result = unsafe { host_net_send(handle, data.as_ptr(), data.len() as u32, flags) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }

    fn host_net_recv(&mut self, handle: i32, _len: u32, flags: u32, buf: &mut [u8]) -> Result<usize, Errno> {
        let result = unsafe { host_net_recv(handle, buf.as_mut_ptr(), buf.len() as u32, flags) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }

    fn host_net_close(&mut self, handle: i32) -> Result<(), Errno> {
        let result = unsafe { host_net_close(handle) };
        i32_to_result(result)
    }

    fn host_net_listen(&mut self, fd: i32, port: u16, addr: &[u8; 4]) -> Result<(), Errno> {
        let result = unsafe {
            host_net_listen(fd, port as u32, addr[0] as u32, addr[1] as u32, addr[2] as u32, addr[3] as u32)
        };
        i32_to_result(result)
    }

    fn host_getaddrinfo(&mut self, name: &[u8], result_buf: &mut [u8]) -> Result<usize, Errno> {
        let result = unsafe { host_getaddrinfo(name.as_ptr(), name.len() as u32, result_buf.as_mut_ptr(), result_buf.len() as u32) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result as usize)
        }
    }

    fn host_fcntl_lock(
        &mut self,
        path: &[u8], pid: u32, cmd: u32, lock_type: u32,
        start: i64, len: i64,
        result_buf: &mut [u8],
    ) -> Result<(), Errno> {
        let start_lo = start as u32;
        let start_hi = (start >> 32) as u32;
        let len_lo = len as u32;
        let len_hi = (len >> 32) as u32;
        let result = unsafe {
            host_fcntl_lock(
                path.as_ptr(), path.len() as u32,
                pid, cmd, lock_type,
                start_lo, start_hi,
                len_lo, len_hi,
                result_buf.as_mut_ptr(),
            )
        };
        i32_to_result(result)
    }

    fn host_fork(&self) -> i32 {
        gkl_release();
        let result = unsafe { host_fork() };
        gkl_acquire();
        result
    }

    fn host_futex_wait(&mut self, addr: u32, expected: u32, timeout_ns: i64) -> Result<i32, Errno> {
        let lo = timeout_ns as u32;
        let hi = (timeout_ns >> 32) as u32;
        // Release the GKL before blocking — otherwise no other thread can make
        // progress while this one waits.
        gkl_release();
        let result = unsafe { host_futex_wait(addr, expected, lo, hi) };
        gkl_acquire();
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result)
        }
    }

    fn host_futex_wake(&mut self, addr: u32, count: u32) -> Result<i32, Errno> {
        let result = unsafe { host_futex_wake(addr, count) };
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result)
        }
    }

    fn host_clone(&mut self, fn_ptr: u32, arg: u32, stack_ptr: u32, tls_ptr: u32, ctid_ptr: u32) -> Result<i32, Errno> {
        // Release GKL before blocking — host_clone blocks on Atomics.wait
        // until the process-manager assigns a TID.
        gkl_release();
        let result = unsafe { host_clone(fn_ptr, arg, stack_ptr, tls_ptr, ctid_ptr) };
        gkl_acquire();
        if result < 0 {
            match Errno::from_u32((-result) as u32) {
                Some(e) => Err(e),
                None => Err(Errno::EIO),
            }
        } else {
            Ok(result)
        }
    }
}

// ---------------------------------------------------------------------------
// 3. Global kernel state
// ---------------------------------------------------------------------------

use core::cell::UnsafeCell;
use core::sync::atomic::{AtomicI32, Ordering};

/// Wrapper to allow `UnsafeCell<Option<Process>>` in a `static`.
struct GlobalProcess(UnsafeCell<Option<Process>>);

/// SAFETY: Access is serialized by the GKL (Global Kernel Lock).
unsafe impl Sync for GlobalProcess {}

static PROCESS: GlobalProcess = GlobalProcess(UnsafeCell::new(None));

use crate::process_table::{GlobalProcessTable, ProcessTable};
static PROCESS_TABLE: GlobalProcessTable = GlobalProcessTable(UnsafeCell::new(ProcessTable::new()));

// ---------------------------------------------------------------------------
// 3b. Cross-process procfs helpers
// ---------------------------------------------------------------------------
// These functions are called from syscalls.rs during procfs operations.
// SAFETY: Only called while inside kernel_handle_channel (GKL held or
// centralized mode which is single-threaded).

/// Get all active PIDs from the process table.
/// Returns empty Vec in mode=0 (single-process).
pub(crate) fn procfs_all_pids() -> Vec<u32> {
    if crate::is_centralized_mode() {
        let table = unsafe { &*PROCESS_TABLE.0.get() };
        table.all_pids()
    } else {
        Vec::new()
    }
}

/// Generate procfs content for a foreign process (cross-process access).
/// Returns None if the pid doesn't exist or is the current process
/// (caller should use the local Process for self-access).
pub(crate) fn procfs_generate_for_pid(pid: u32, entry: &crate::procfs::ProcfsEntry) -> Option<Vec<u8>> {
    if !crate::is_centralized_mode() {
        return None;
    }
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let proc = table.get(pid)?;
    match entry {
        crate::procfs::ProcfsEntry::Stat(_) => Some(crate::procfs::generate_stat(proc)),
        crate::procfs::ProcfsEntry::Status(_) => Some(crate::procfs::generate_status(proc)),
        crate::procfs::ProcfsEntry::Cmdline(_) => Some(crate::procfs::generate_cmdline(proc)),
        crate::procfs::ProcfsEntry::Environ(_) => Some(crate::procfs::generate_environ(proc)),
        crate::procfs::ProcfsEntry::Maps(_) => Some(crate::procfs::generate_maps(proc)),
        crate::procfs::ProcfsEntry::FdInfo(_, fd) => crate::procfs::generate_fdinfo(proc, *fd),
        _ => None,
    }
}

/// Get the readlink target for a procfs symlink in a foreign process.
pub(crate) fn procfs_readlink_for_pid(pid: u32, entry: &crate::procfs::ProcfsEntry, buf: &mut [u8]) -> Option<usize> {
    if !crate::is_centralized_mode() {
        return None;
    }
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let proc = table.get(pid)?;
    crate::procfs::procfs_readlink(proc, entry, buf).ok()
}

/// Generate directory entries for a foreign process's procfs directory.
pub(crate) fn procfs_getdents64_for_pid(
    pid: u32,
    ofd_path: &[u8],
    buf: &mut [u8],
    offset: i64,
) -> Option<(usize, i64, bool)> {
    if !crate::is_centralized_mode() {
        return None;
    }
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let proc = table.get(pid)?;
    let pids = table.all_pids();
    crate::procfs::procfs_getdents64(proc, ofd_path, buf, offset, &pids).ok()
}

// ---------------------------------------------------------------------------
// 3a. Global Kernel Lock (GKL)
// ---------------------------------------------------------------------------

/// Global Kernel Lock — a futex-backed spinlock in shared linear memory.
/// Every syscall acquires it on entry and releases on exit. This serializes
/// all kernel access when multiple threads share the same Memory.
///
/// DEPRECATED: In centralized mode (mode=1), GKL is bypassed because the
/// kernel services one syscall at a time from the JS event loop.
/// GKL is only needed for mode=0 (traditional) where multiple threads
/// in a process Worker share the kernel state.
/// When mode=0 is fully removed, GKL and GklGuard can be deleted.
static GKL: AtomicI32 = AtomicI32::new(0);

#[cfg(target_arch = "wasm32")]
fn gkl_addr() -> u32 {
    &GKL as *const AtomicI32 as u32
}

#[cfg(target_arch = "wasm32")]
fn gkl_acquire() {
    loop {
        match GKL.compare_exchange_weak(0, 1, Ordering::Acquire, Ordering::Relaxed) {
            Ok(_) => break,
            Err(_) => {
                // Block via futex until lock is released
                unsafe { host_futex_wait(gkl_addr(), 1, 0xFFFFFFFF, 0xFFFFFFFF); }
            }
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn gkl_release() {
    GKL.store(0, Ordering::Release);
    unsafe { host_futex_wake(gkl_addr(), 1); }
}

#[cfg(not(target_arch = "wasm32"))]
fn gkl_acquire() {}

#[cfg(not(target_arch = "wasm32"))]
fn gkl_release() {}

/// RAII guard that releases the Global Kernel Lock on drop.
/// Ensures GKL is released even on early returns or panics.
struct GklGuard;

impl GklGuard {
    fn acquire() -> Self {
        if !crate::is_centralized_mode() {
            gkl_acquire();
        }
        GklGuard
    }
}

impl Drop for GklGuard {
    fn drop(&mut self) {
        if !crate::is_centralized_mode() {
            gkl_release();
        }
    }
}

/// Get a mutable reference to the global process, acquiring the GKL.
/// Returns a GklGuard that releases the lock when dropped.
///
/// In mode 0 (traditional): uses the single global PROCESS.
/// In mode 1 (centralized): looks up current_pid in PROCESS_TABLE.
///
/// SAFETY: Must only be called from kernel export functions.
#[inline]
unsafe fn get_process() -> (GklGuard, &'static mut Process) {
    let guard = GklGuard::acquire();
    if crate::is_centralized_mode() {
        let table = unsafe { &mut *PROCESS_TABLE.0.get() };
        match table.current_process() {
            Some(p) => (guard, p),
            #[cfg(target_arch = "wasm32")]
            None => core::arch::wasm32::unreachable(),
            #[cfg(not(target_arch = "wasm32"))]
            None => panic!("no current process in table"),
        }
    } else {
        let ptr = PROCESS.0.get();
        match unsafe { &mut *ptr } {
            Some(p) => (guard, p),
            #[cfg(target_arch = "wasm32")]
            None => core::arch::wasm32::unreachable(),
            #[cfg(not(target_arch = "wasm32"))]
            None => panic!("kernel not initialized"),
        }
    }
}


// ---------------------------------------------------------------------------
// 3b. Memory growth helper
// ---------------------------------------------------------------------------

/// Grow Wasm memory if `end_addr` exceeds the current memory size.
/// Wasm pages are 64KB each. Returns true if memory was sufficient or grown.
#[cfg(target_arch = "wasm32")]
fn ensure_memory_covers(end_addr: u32) {
    let current_pages = core::arch::wasm32::memory_size(0) as u32;
    let current_bytes = current_pages * 65536;
    if end_addr > current_bytes {
        let needed_pages = (end_addr - current_bytes + 65535) / 65536;
        core::arch::wasm32::memory_grow(0, needed_pages as usize);
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn ensure_memory_covers(_end_addr: u32) {
    // No-op on non-Wasm targets (tests)
}

// 3c. Signal delivery at syscall boundaries
// ---------------------------------------------------------------------------

/// Check for and deliver pending signals before/after syscall.
fn deliver_pending_signals(proc: &mut Process, host: &mut WasmHostIO) {
    use crate::signal::{DefaultAction, default_action, SignalHandler};
    let centralized = crate::is_centralized_mode();
    loop {
        // In centralized mode, peek first so we can skip Handler signals
        // (they'll be delivered by the glue code via kernel_dequeue_signal).
        if centralized {
            let signum = match proc.signals.peek_deliverable() {
                Some(s) if s < wasm_posix_shared::signal::NSIG => s,
                _ => break,
            };
            let action = proc.signals.get_action(signum);
            match action.handler {
                SignalHandler::Handler(_) => break, // Leave for glue-side delivery
                SignalHandler::Default => {
                    let _ = proc.signals.dequeue();
                    match default_action(signum) {
                        DefaultAction::Terminate | DefaultAction::CoreDump => {
                            proc.state = crate::process::ProcessState::Exited;
                            proc.exit_status = 128 + signum as i32;
                        }
                        _ => {}
                    }
                }
                SignalHandler::Ignore => {
                    let _ = proc.signals.dequeue();
                }
            }
        } else {
            // Traditional mode: dequeue and handle all signals directly
            let (signum, _si_value, _si_code) = match proc.signals.dequeue() {
                Some(s) => s,
                None => break,
            };
            if proc.state == crate::process::ProcessState::Exited {
                break;
            }
            let action = proc.signals.get_action(signum);
            match action.handler {
                SignalHandler::Handler(idx) => {
                    if host.host_call_signal_handler(idx, signum, action.flags).is_err() {
                        // Handler call failed — fall back to default action (POSIX).
                        // The signal has already been dequeued, so we must handle it here.
                        match default_action(signum) {
                            DefaultAction::Terminate | DefaultAction::CoreDump => {
                                proc.state = crate::process::ProcessState::Exited;
                                proc.exit_status = 128 + signum as i32;
                            }
                            _ => {}
                        }
                    }
                }
                SignalHandler::Default => {
                    match default_action(signum) {
                        DefaultAction::Terminate | DefaultAction::CoreDump => {
                            proc.state = crate::process::ProcessState::Exited;
                            proc.exit_status = 128 + signum as i32;
                        }
                        _ => {}
                    }
                }
                SignalHandler::Ignore => {}
            }
        }
        if proc.state == crate::process::ProcessState::Exited { break; }
    }
}

// ---------------------------------------------------------------------------
// 4. Exported kernel functions
// ---------------------------------------------------------------------------

/// Set kernel operating mode. 0 = traditional, 1 = centralized.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_mode(mode: u32) {
    crate::set_kernel_mode(mode);
}

/// Allocate a scratch buffer from the kernel's own heap allocator.
/// Returns the offset in kernel Wasm memory. The caller must ensure
/// the buffer is not freed (it lives for the lifetime of the kernel).
/// This is critical: the host must NOT use memory.grow() for scratch
/// space, as the kernel's allocator would then treat those grown pages
/// as available heap, leading to overlapping writes and corruption.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_alloc_scratch(size: u32) -> u32 {
    extern crate alloc;
    let layout = alloc::alloc::Layout::from_size_align(size as usize, 16).unwrap();
    let ptr = unsafe { alloc::alloc::alloc_zeroed(layout) };
    if ptr.is_null() {
        return 0;
    }
    ptr as u32
}

/// Read the approximate Wasm stack pointer for debugging.
/// Returns the address of a stack variable, which is close to the current SP.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_stack_pointer() -> u32 {
    let sentinel: u32 = 0xDEAD;
    &sentinel as *const u32 as u32
}

/// Return the current Wasm memory size in pages using the `memory.size` instruction.
/// This is the true internal page count — may differ from what JS reports for shared memory.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_memory_pages() -> u32 {
    #[cfg(target_arch = "wasm32")]
    {
        core::arch::wasm32::memory_size(0) as u32
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}

/// Create a new process in the process table (centralized mode).
/// Returns 0 on success, -EEXIST if pid already exists.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_create_process(pid: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.create_process(pid) {
        Ok(()) => 0,
        Err(()) => -(Errno::EEXIST as i32),
    }
}

/// Set the mmap address space upper bound for a process.
/// Used to prevent mmap from overlapping the channel region.
/// Returns 0 on success, -ESRCH if pid not found.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_max_addr(pid: u32, max_addr: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    if let Some(proc) = table.get_mut(pid) {
        proc.memory.set_max_addr(max_addr);
        0
    } else {
        -(Errno::ESRCH as i32)
    }
}

/// Set the working directory for a process (centralized mode).
/// Called by host to set the initial cwd before the process starts.
/// Returns 0 on success, -ESRCH if pid not found.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_cwd(pid: u32, path_ptr: *const u8, path_len: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    if let Some(proc) = table.get_mut(pid) {
        let path = unsafe { core::slice::from_raw_parts(path_ptr, path_len as usize) };
        proc.cwd = path.to_vec();
        0
    } else {
        -(Errno::ESRCH as i32)
    }
}

/// Set the argv for a process (centralized mode).
/// The argv is a null-separated concatenation of arguments.
/// Called by host to populate /proc/<pid>/cmdline.
/// Returns 0 on success, -ESRCH if pid not found.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_process_argv(pid: u32, data_ptr: *const u8, data_len: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    if let Some(proc) = table.get_mut(pid) {
        let data = unsafe { core::slice::from_raw_parts(data_ptr, data_len as usize) };
        proc.argv.clear();
        // Split on null bytes
        for arg in data.split(|&b| b == 0) {
            if !arg.is_empty() {
                proc.argv.push(arg.to_vec());
            }
        }
        0
    } else {
        -(Errno::ESRCH as i32)
    }
}

/// Mark a process's stdin (fd 0) as a pipe instead of a terminal.
/// This disables terminal line discipline (no ECHO, no ICANON) and makes
/// isatty(0) return false. Used when providing buffered stdin data.
/// Returns 0 on success, -ESRCH if pid not found.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_stdin_pipe(pid: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    if let Some(proc) = table.get_mut(pid) {
        // Change OFD 0 (stdin) from CharDevice to Pipe
        if let Some(ofd) = proc.ofd_table.get_mut(0) {
            ofd.file_type = crate::ofd::FileType::Pipe;
        }
        0
    } else {
        -(Errno::ESRCH as i32)
    }
}

/// Remove a process from the process table (centralized mode).
/// Returns 0 on success, -ESRCH if pid not found.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_remove_process(pid: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.remove_process(pid) {
        Some(_) => 0,
        None => -(Errno::ESRCH as i32),
    }
}

/// Fork a process in the process table (centralized mode).
/// Clones parent's Process state and creates a child with `child_pid`.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fork_process(parent_pid: u32, child_pid: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.fork_process(parent_pid, child_pid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}

/// Check if a process is a fork child (centralized mode).
/// Returns 1 if fork child, 0 otherwise, -ESRCH if not found.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_is_fork_child_pid(pid: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) => if proc.fork_child { 1 } else { 0 },
        None => -(Errno::ESRCH as i32),
    }
}

/// Clear the fork_child flag for a process (centralized mode).
/// Called by the host after returning 0 to a fork child's SYS_FORK call.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_clear_fork_child(pid: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.get_mut(pid) {
        Some(proc) => { proc.fork_child = false; 0 }
        None => -(Errno::ESRCH as i32),
    }
}

/// Get process exit status (centralized mode).
/// Returns exit_status if process is exited, -1 if still alive, -ESRCH if not found.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_process_exit_status(pid: u32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) if proc.state == crate::process::ProcessState::Exited => proc.exit_status,
        Some(_) => -1,
        None => -(Errno::ESRCH as i32),
    }
}

/// Check if a process has SA_NOCLDWAIT set for SIGCHLD (centralized mode).
/// Returns 1 if SA_NOCLDWAIT is set, 0 if not, -ESRCH if process not found.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_has_sa_nocldwait(pid: u32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) => {
            let action = proc.signals.get_action(wasm_posix_shared::signal::SIGCHLD);
            if action.flags & wasm_posix_shared::signal::SA_NOCLDWAIT != 0 {
                1
            } else {
                // POSIX: setting SIGCHLD to SIG_IGN also implies SA_NOCLDWAIT
                match action.handler {
                    crate::signal::SignalHandler::Ignore => 1,
                    _ => 0,
                }
            }
        }
        None => -(Errno::ESRCH as i32),
    }
}

/// Reset signal mask for a process (centralized mode).
/// In centralized mode, fork children re-execute _start, so they don't get
/// musl's __restore_sigs after fork(). Clear the blocked mask so the child
/// starts with no signals blocked, matching a fresh process.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_reset_signal_mask(pid: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.get_mut(pid) {
        Some(proc) => { proc.signals.blocked = 0; proc.sigsuspend_saved_mask = None; 0 }
        None => -(Errno::ESRCH as i32),
    }
}

/// Check if a signal is blocked for a process (centralized mode).
/// Returns 1 if blocked, 0 if not blocked, -ESRCH if process not found.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_is_signal_blocked(pid: u32, signum: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) => {
            if signum == 0 || signum >= 65 { return 0; }
            if proc.signals.blocked & (1u64 << (signum - 1)) != 0 { 1 } else { 0 }
        }
        None => -(Errno::ESRCH as i32),
    }
}

/// Get fork exec path for a specific process (centralized mode).
/// Writes path to buf, returns bytes written, 0 if no exec path, -ESRCH if not found.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_fork_exec_path_pid(pid: u32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) => match &proc.fork_exec_path {
            Some(path) => {
                let len = path.len().min(buf_len as usize);
                let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, len) };
                buf.copy_from_slice(&path[..len]);
                len as i32
            }
            None => 0,
        },
        None => -(Errno::ESRCH as i32),
    }
}

/// Get the CWD for a specific process (centralized mode).
/// Writes CWD to buf, returns bytes written, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_cwd(pid: u32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) => {
            let len = proc.cwd.len().min(buf_len as usize);
            let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, len) };
            buf.copy_from_slice(&proc.cwd[..len]);
            len as i32
        }
        None => -(Errno::ESRCH as i32),
    }
}

/// Get the file path for an fd in a specific process (centralized mode).
/// Used by the host to resolve fexecve fd paths.
/// Writes path to buf, returns bytes written, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_fd_path(pid: u32, fd: i32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) => {
            match proc.fd_table.get(fd) {
                Ok(entry) => {
                    let ofd_idx = entry.ofd_ref.0;
                    match proc.ofd_table.get(ofd_idx) {
                        Some(ofd) => {
                            if ofd.path.is_empty() {
                                return -(Errno::ENOENT as i32);
                            }
                            let len = ofd.path.len().min(buf_len as usize);
                            let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, len) };
                            buf.copy_from_slice(&ofd.path[..len]);
                            len as i32
                        }
                        None => -(Errno::EBADF as i32),
                    }
                }
                Err(e) => -(e as i32),
            }
        }
        None => -(Errno::ESRCH as i32),
    }
}

/// Dequeue one pending Handler signal for a process (centralized mode).
/// Writes signal delivery info to `out_ptr` (24 bytes):
///   [0..4] signum (u32), [4..8] handler_index (u32), [8..12] sa_flags (u32),
///   [16..24] old_blocked_mask (u64)
/// Applies sa_mask | sig_bit(signum) to the process's blocked mask (POSIX).
/// Returns signum (>0) if a signal was dequeued, 0 if none pending.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_dequeue_signal(pid: u32, out_ptr: *mut u8) -> i32 {
    use crate::signal::{SignalHandler, sig_bit};
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let proc = match table.get_mut(pid) {
        Some(p) => p,
        None => return 0,
    };
    loop {
        let signum = match proc.signals.peek_deliverable() {
            Some(s) if s < wasm_posix_shared::signal::NSIG => s,
            _ => return 0,
        };
        let action = proc.signals.get_action(signum);
        match action.handler {
            SignalHandler::Handler(idx) => {
                let (_dequeued_sig, si_value, si_code) = proc.signals.dequeue().unwrap();
                // If returning from sigsuspend, restore original mask before saving
                // old_mask for the handler. This ensures the handler's saved mask
                // is the pre-sigsuspend mask (POSIX: sigsuspend restores mask on return).
                if let Some(saved) = proc.sigsuspend_saved_mask.take() {
                    proc.signals.blocked = saved;
                }
                // Save old mask, apply new (POSIX: block sa_mask + the signal itself)
                let old_mask = proc.signals.blocked;
                proc.signals.blocked |= action.mask | sig_bit(signum);
                // If SA_ONSTACK and alt stack is configured (not SS_DISABLE),
                // mark that we're executing on the alt stack.
                const SA_ONSTACK: u32 = 0x08000000;
                const SS_ONSTACK: u32 = 1;
                const SS_DISABLE: u32 = 2;
                // Track whether we're transitioning onto the alt stack
                let mut switch_to_alt_stack = false;
                if action.flags & SA_ONSTACK != 0
                    && proc.alt_stack_flags & SS_DISABLE == 0
                    && proc.alt_stack_sp != 0
                {
                    // Only switch stacks when first entering alt stack (depth 0 → 1).
                    // Nested signals on the alt stack keep the current __stack_pointer.
                    if proc.alt_stack_depth == 0 {
                        switch_to_alt_stack = true;
                    }
                    proc.alt_stack_depth += 1;
                    proc.alt_stack_flags |= SS_ONSTACK;
                }
                // Write to output buffer:
                //   [0..4] signum, [4..8] handler_idx, [8..12] flags,
                //   [12..16] si_value, [16..24] old_mask,
                //   [24..28] si_code, [28..32] si_pid, [32..36] si_uid,
                //   [36..40] alt_sp (0 if no switch), [40..44] alt_size
                let buf = unsafe { slice::from_raw_parts_mut(out_ptr, 44) };
                buf[0..4].copy_from_slice(&signum.to_le_bytes());
                buf[4..8].copy_from_slice(&idx.to_le_bytes());
                buf[8..12].copy_from_slice(&action.flags.to_le_bytes());
                buf[12..16].copy_from_slice(&si_value.to_le_bytes());
                buf[16..24].copy_from_slice(&old_mask.to_le_bytes());
                buf[24..28].copy_from_slice(&si_code.to_le_bytes());
                buf[28..32].copy_from_slice(&proc.pid.to_le_bytes());
                buf[32..36].copy_from_slice(&proc.uid.to_le_bytes());
                if switch_to_alt_stack {
                    buf[36..40].copy_from_slice(&proc.alt_stack_sp.to_le_bytes());
                    buf[40..44].copy_from_slice(&proc.alt_stack_size.to_le_bytes());
                } else {
                    buf[36..44].fill(0);
                }
                return signum as i32;
            }
            SignalHandler::Default => {
                use crate::signal::{DefaultAction, default_action};
                let _ = proc.signals.dequeue();
                match default_action(signum) {
                    DefaultAction::Terminate | DefaultAction::CoreDump => {
                        // Process is dying; clear sigsuspend state
                        proc.sigsuspend_saved_mask = None;
                        proc.state = crate::process::ProcessState::Exited;
                        proc.exit_status = 128 + signum as i32;
                        return 0;
                    }
                    _ => continue,
                }
            }
            SignalHandler::Ignore => {
                let _ = proc.signals.dequeue();
                continue;
            }
        }
    }
}

/// Handle exec semantics on a process in the process table (centralized mode).
/// Serializes the process as exec state (closes CLOEXEC, resets handlers), then
/// re-creates the process from that sanitized state.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_exec_setup(pid: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    {
        let proc = match table.get_mut(pid) {
            Some(p) => p,
            None => return -(Errno::ESRCH as i32),
        };

        // Apply pending fork fd actions (from posix_spawn) before exec.
        // These are dup2/close ops that rearrange fds (e.g., pipe write end → fd 1)
        // and must take effect before CLOEXEC removal during exec serialization.
        if !proc.fork_fd_actions.is_empty() {
            let actions: alloc::vec::Vec<_> = proc.fork_fd_actions.drain(..).collect();
            let mut host = WasmHostIO;
            for action in actions {
                use crate::process::FdAction;
                match action {
                    FdAction::Dup2 { old_fd, new_fd } => {
                        if let Err(e) = syscalls::sys_dup2(proc, &mut host, old_fd, new_fd) {
                            return -(e as i32);
                        }
                    }
                    FdAction::Close { fd } => {
                        if let Err(e) = syscalls::sys_close(proc, &mut host, fd) {
                            return -(e as i32);
                        }
                    }
                    FdAction::Open { fd, ref path, flags, mode } => {
                        match syscalls::sys_open(proc, &mut host, path, flags as u32, mode as u32) {
                            Ok(opened_fd) => {
                                if opened_fd != fd {
                                    if let Err(e) = syscalls::sys_dup2(proc, &mut host, opened_fd, fd) {
                                        return -(e as i32);
                                    }
                                    let _ = syscalls::sys_close(proc, &mut host, opened_fd);
                                }
                            }
                            Err(e) => return -(e as i32),
                        }
                    }
                }
            }
        }
    }

    // Close CLOEXEC fds BEFORE serialization so pipe/host-handle refcounts
    // are properly decremented. Without this, the exec serialization silently
    // drops CLOEXEC fds from the FD table without adjusting global refcounts,
    // leaving pipes with phantom writers and preventing EOF on reads.
    {
        let proc = match table.get_mut(pid) {
            Some(p) => p,
            None => return -(Errno::ESRCH as i32),
        };
        let cloexec_fds: alloc::vec::Vec<i32> = proc.fd_table.iter()
            .filter(|(_, entry)| entry.fd_flags & FD_CLOEXEC != 0)
            .map(|(fd, _)| fd)
            .collect();
        let mut host = WasmHostIO;
        for fd in cloexec_fds {
            let _ = syscalls::sys_close(proc, &mut host, fd);
        }
    }

    // Re-borrow after fd action scope ends
    let proc = match table.get(pid) {
        Some(p) => p,
        None => return -(Errno::ESRCH as i32),
    };

    // Serialize as exec state (signal handler reset, etc.)
    // CLOEXEC fds were already closed above, so serialization just preserves what's left.
    let mut buf = alloc::vec![0u8; 64 * 1024];
    let written = match crate::fork::serialize_exec_state(proc, &mut buf) {
        Ok(n) => n,
        Err(e) => return -(e as i32),
    };

    // Deserialize back to replace the process with exec-sanitized version
    match crate::fork::deserialize_exec_state(&buf[..written], pid) {
        Ok(new_proc) => {
            table.get_mut(pid).map(|p| {
                *p = new_proc;
                p.has_exec = true;
            });
            0
        }
        Err(e) => -(e as i32),
    }
}

/// Handle a syscall via the channel protocol (centralized mode).
///
/// Reads the channel layout from kernel Memory at `offset`:
///   - syscall number at offset+4
///   - args[0..6] at offset+8
///
/// `pid` identifies which process to service.
///
/// Dispatches to the appropriate kernel function, then writes:
///   - return value at offset+32
///   - errno at offset+36
///
/// Returns the raw syscall result (also written to channel).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_handle_channel(offset: u32, pid: u32) -> i32 {
    use wasm_posix_shared::channel::*;

    // Set current process for dispatch
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    table.set_current_pid(pid);

    // Read syscall number and args from kernel memory
    let base = offset as usize;
    let mem = unsafe {
        let ptr = base as *const u8;
        core::slice::from_raw_parts(ptr, MIN_CHANNEL_SIZE)
    };

    let syscall_nr = u32::from_le_bytes([mem[SYSCALL_OFFSET], mem[SYSCALL_OFFSET+1], mem[SYSCALL_OFFSET+2], mem[SYSCALL_OFFSET+3]]);

    let mut args = [0i32; ARGS_COUNT];
    for i in 0..ARGS_COUNT {
        let off = ARGS_OFFSET + i * 4;
        args[i] = i32::from_le_bytes([mem[off], mem[off+1], mem[off+2], mem[off+3]]);
    }

    // Pointer args in the channel reference kernel memory (JS copies data
    // into the data buffer at offset + DATA_OFFSET). Convert relative
    // data-buffer references: if an arg points to offset 0 of the data
    // buffer in the channel, it should be `base + DATA_OFFSET` in absolute
    // kernel memory terms. The JS layer sets pointer args as absolute
    // kernel-memory addresses, so we pass them through unchanged.

    let result = dispatch_channel_syscall(syscall_nr, &args);

    // Write result back to channel
    let out = unsafe {
        let ptr = base as *mut u8;
        core::slice::from_raw_parts_mut(ptr, MIN_CHANNEL_SIZE)
    };

    let ret_val: i32;
    let errno_val: u32;
    if result < 0 {
        // Negative result: the absolute value is the errno
        ret_val = -1;
        errno_val = (-result) as u32;
    } else {
        ret_val = result;
        errno_val = 0;
    }

    out[RETURN_OFFSET..RETURN_OFFSET+4].copy_from_slice(&ret_val.to_le_bytes());
    out[ERRNO_OFFSET..ERRNO_OFFSET+4].copy_from_slice(&errno_val.to_le_bytes());

    result
}

/// Compute the length of a null-terminated C string at `ptr` in kernel memory.
/// Safety: `ptr` must point to valid kernel memory containing a null terminator.
unsafe fn cstr_len(ptr: *const u8) -> u32 {
    if ptr.is_null() { return 0; }
    let mut len = 0u32;
    while unsafe { *ptr.add(len as usize) } != 0 && len < 4096 {
        len += 1;
    }
    len
}

/// Dispatch a syscall by number with raw musl arguments.
///
/// IMPORTANT: The args are in musl's raw format, NOT the kernel_* export format.
/// For path syscalls, musl passes null-terminated string pointers without explicit
/// lengths. This function computes string lengths via cstr_len() because the JS
/// layer has already copied the strings into kernel memory.
///
/// Returns the raw kernel result (negative = -errno, non-negative = success value).
fn dispatch_channel_syscall(nr: u32, args: &[i32; 6]) -> i32 {
    let a1 = args[0];
    let a2 = args[1];
    let a3 = args[2];
    let a4 = args[3];
    let a5 = args[4];
    let a6 = args[5];

    // Syscall number constants (must match glue/syscall_glue.c)
    match nr {
        // Process info (0-arg)
        28 => kernel_getpid(),                     // SYS_GETPID
        29 => kernel_getppid(),                    // SYS_GETPPID
        30 => kernel_getuid() as i32,              // SYS_GETUID
        31 => kernel_geteuid() as i32,             // SYS_GETEUID
        32 => kernel_getgid() as i32,              // SYS_GETGID
        33 => kernel_getegid() as i32,             // SYS_GETEGID
        89 => kernel_getpgrp() as i32,             // SYS_GETPGRP
        92 => kernel_setsid() as i32,              // SYS_SETSID
        214 => {                                   // SYS_GETPGID
            let (_gkl, proc) = unsafe { get_process() };
            let pid = a1 as u32;
            // In centralized mode, support cross-process getpgid via ProcessTable
            if pid != 0 && pid != proc.pid && crate::is_centralized_mode() {
                let table = unsafe { &*PROCESS_TABLE.0.get() };
                match table.get(pid) {
                    Some(target) => target.pgid as i32,
                    None => -(Errno::ESRCH as i32),
                }
            } else {
                match syscalls::sys_getpgid(proc, pid) {
                    Ok(pgid) => pgid as i32,
                    Err(e) => -(e as i32),
                }
            }
        }

        // File operations — musl: (path, flags, mode)
        1 => { // SYS_OPEN
            let p = a1 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_open(p, len, a2 as u32, a3 as u32)
        }
        2 => { // SYS_CLOSE
            // Check if this is a mqueue descriptor
            let mq_table = unsafe { crate::mqueue::global_mqueue_table() };
            if mq_table.is_mqd(a1 as u32) {
                match mq_table.mq_close(a1 as u32) {
                    Ok(()) => 0,
                    Err(e) => -(e as i32),
                }
            } else {
                kernel_close(a1)
            }
        }
        3 => kernel_read(a1, a2 as *mut u8, a3 as u32), // SYS_READ: (fd, buf, count)
        4 => kernel_write(a1, a2 as *const u8, a3 as u32), // SYS_WRITE: (fd, buf, count)
        5 => kernel_lseek(a1, a2 as u32, a3, a4 as u32) as i32, // SYS_LSEEK: (fd, off_lo, off_hi, whence)
        119 => {  // SYS__LLSEEK: (fd, off_hi, off_lo, result_ptr, whence)
            let result = kernel_lseek(a1, a3 as u32, a2, a5 as u32);
            if result < 0 {
                result as i32
            } else {
                // Write 64-bit result to result_ptr
                let ptr = a4 as usize as *mut u8;
                unsafe {
                    let bytes = result.to_le_bytes();
                    for i in 0..8 {
                        *ptr.add(i) = bytes[i];
                    }
                }
                0
            }
        }
        6 => kernel_fstat(a1, a2 as *mut u8),      // SYS_FSTAT: (fd, stat_ptr)
        64 => kernel_pread(a1, a2 as *mut u8, a3 as u32, a4 as u32, a5), // SYS_PREAD: (fd, buf, count, off_lo, off_hi)
        65 => kernel_pwrite(a1, a2 as *const u8, a3 as u32, a4 as u32, a5), // SYS_PWRITE

        // FD operations
        7 => kernel_dup(a1),                       // SYS_DUP
        8 => kernel_dup2(a1, a2),                  // SYS_DUP2
        77 => kernel_dup3(a1, a2, a3 as u32),      // SYS_DUP3
        9 => kernel_pipe(a1 as *mut i32),          // SYS_PIPE: (pipefd_ptr)
        78 => kernel_pipe2(a2 as u32, a1 as *mut i32), // SYS_PIPE2: (pipefd_ptr, flags) → kernel wants (flags, pipefd_ptr)
        10 => {  // SYS_FCNTL: (fd, cmd, arg)
            match a2 as u32 {
                // Lock commands: arg is a pointer to struct flock
                // POSIX: 5=F_GETLK, 6=F_SETLK, 7=F_SETLKW; 12-14=64-bit variants
                // OFD:   36=F_OFD_GETLK, 37=F_OFD_SETLK, 38=F_OFD_SETLKW
                5 | 6 | 7 | 12 | 13 | 14 | 36 | 37 | 38 => kernel_fcntl_lock(a1, a2 as u32, a3 as *mut u8),
                _ => kernel_fcntl(a1, a2 as u32, a3 as u32),
            }
        }
        121 => kernel_flock(a1, a2 as u32),        // SYS_FLOCK

        // Stat — musl: (path, stat_buf) / (path, stat_buf) / (dirfd, path, stat_buf, flags)
        11 => { // SYS_STAT
            let p = a1 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_stat(p, len, a2 as *mut u8)
        }
        12 => { // SYS_LSTAT
            let p = a1 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_lstat(p, len, a2 as *mut u8)
        }
        93 => { // SYS_FSTATAT: (dirfd, path, stat_buf, flags)
            let p = a2 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_fstatat(a1, p, len, a3 as *mut u8, a4 as u32)
        }

        // Directory operations — musl passes null-terminated paths
        13 => { // SYS_MKDIR: (path, mode)
            let p = a1 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_mkdir(p, len, a2 as u32)
        }
        14 => { // SYS_RMDIR: (path)
            let p = a1 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_rmdir(p, len)
        }
        15 => { // SYS_UNLINK: (path)
            let p = a1 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_unlink(p, len)
        }
        16 => { // SYS_RENAME: (old_path, new_path)
            let old = a1 as *const u8;
            let new = a2 as *const u8;
            kernel_rename(old, unsafe { cstr_len(old) }, new, unsafe { cstr_len(new) })
        }
        17 => { // SYS_LINK: (old_path, new_path)
            let old = a1 as *const u8;
            let new = a2 as *const u8;
            kernel_link(old, unsafe { cstr_len(old) }, new, unsafe { cstr_len(new) })
        }
        18 => { // SYS_SYMLINK: (target, linkpath)
            let tgt = a1 as *const u8;
            let lnk = a2 as *const u8;
            kernel_symlink(tgt, unsafe { cstr_len(tgt) }, lnk, unsafe { cstr_len(lnk) })
        }
        19 => { // SYS_READLINK: (path, buf, bufsiz)
            let p = a1 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_readlink(p, len, a2 as *mut u8, a3 as u32)
        }
        20 => { // SYS_CHMOD: (path, mode)
            let p = a1 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_chmod(p, len, a2 as u32)
        }
        21 => { // SYS_CHOWN: (path, uid, gid)
            let p = a1 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_chown(p, len, a2 as u32, a3 as u32)
        }
        22 => { // SYS_ACCESS: (path, mode)
            let p = a1 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_access(p, len, a2 as u32)
        }
        23 => kernel_getcwd(a1 as *mut u8, a2 as u32), // SYS_GETCWD: (buf, size)
        24 => { // SYS_CHDIR: (path)
            let p = a1 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_chdir(p, len)
        }
        127 => kernel_fchdir(a1),                  // SYS_FCHDIR
        25 => { // SYS_OPENDIR: (path)
            let p = a1 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_opendir(p, len)
        }
        26 => kernel_readdir(a1, a2 as *mut u8, a3 as *mut u8, a4 as u32), // SYS_READDIR
        27 => kernel_closedir(a1),                 // SYS_CLOSEDIR
        122 => kernel_getdents64(a1, a2 as *mut u8, a3 as u32), // SYS_GETDENTS64

        // Process control
        34 => { kernel_exit(a1); }                 // SYS_EXIT
        35 => kernel_kill(a1, a2 as u32),          // SYS_KILL
        38 => kernel_raise(a1 as u32),             // SYS_RAISE

        // Signals
        36 => kernel_sigaction(a1 as u32, a2 as *const u8, a3 as *mut u8), // SYS_SIGACTION
        37 => {  // SYS_SIGPROCMASK: (how, set_ptr, oldset_ptr, sigsetsize)
            // musl passes pointers to sigset_t (8 bytes). Read set from pointer,
            // call kernel, write old set to output pointer.
            // POSIX: if set is NULL, the signal mask is not changed (query only).
            let (_gkl, proc) = unsafe { get_process() };
            if a2 != 0 {
                let ptr = a2 as usize as *const u32;
                let (set_lo, set_hi) = unsafe { (*ptr, *ptr.add(1)) };
                let set = ((set_hi as u64) << 32) | (set_lo as u64);
                // Call sys_sigprocmask directly — kernel_sigprocmask returns
                // old mask as i64 which is negative when bit 63 (signal 64) is
                // set, causing the old `if result < 0` check to misfire.
                let old_mask = match syscalls::sys_sigprocmask(proc, a1 as u32, set) {
                    Ok(old) => old,
                    Err(e) => return -(e as i32),
                };
                if a3 != 0 {
                    let ptr = a3 as usize as *mut u8;
                    unsafe {
                        let bytes = old_mask.to_le_bytes();
                        for i in 0..8 { *ptr.add(i) = bytes[i]; }
                    }
                }
                let mut host = WasmHostIO;
                deliver_pending_signals(proc, &mut host);
                0
            } else {
                // set is NULL: just read the current mask without modifying
                if a3 != 0 {
                    let ptr = a3 as usize as *mut u8;
                    unsafe {
                        let bytes = proc.signals.blocked.to_le_bytes();
                        for i in 0..8 { *ptr.add(i) = bytes[i]; }
                    }
                }
                0
            }
        }
        73 => kernel_signal(a1 as u32, a2 as u32), // SYS_SIGNAL
        39 => kernel_alarm(a1 as u32),             // SYS_ALARM
        110 => {  // SYS_SIGSUSPEND: (mask_ptr, sigsetsize)
            let (mask_lo, mask_hi) = if a1 != 0 {
                let ptr = a1 as usize as *const u32;
                unsafe { (*ptr, *ptr.add(1)) }
            } else {
                (0u32, 0u32)
            };
            kernel_sigsuspend(mask_lo, mask_hi)
        }
        111 => kernel_pause(),                     // SYS_PAUSE
        206 => {  // SYS_RT_SIGPENDING: (set_ptr, sigsetsize)
            let (_gkl, proc) = unsafe { get_process() };
            if a1 != 0 {
                let ptr = a1 as usize as *mut u8;
                unsafe {
                    let bytes = proc.signals.pending.to_le_bytes();
                    for i in 0..8 { *ptr.add(i) = bytes[i]; }
                }
            }
            0
        }
        207 => { // SYS_RT_SIGTIMEDWAIT: (mask_ptr, info_ptr, timeout_ptr, sigsetsize)
            let (_gkl, proc) = unsafe { get_process() };
            let mut host = WasmHostIO;
            // Read the 64-bit signal mask from the pointer
            let mask = if a1 != 0 {
                let p = a1 as usize as *const u8;
                let mut bytes = [0u8; 8];
                unsafe { for i in 0..8 { bytes[i] = *p.add(i); } }
                u64::from_le_bytes(bytes)
            } else {
                0
            };
            // Read timeout from timespec pointer (time64: i64 sec + i64 nsec)
            let timeout_ms = if a3 != 0 {
                let p = a3 as usize as *const u8;
                let mut sec_bytes = [0u8; 8];
                let mut nsec_bytes = [0u8; 8];
                unsafe {
                    for i in 0..8 { sec_bytes[i] = *p.add(i); }
                    for i in 0..8 { nsec_bytes[i] = *p.add(8 + i); }
                }
                let sec = i64::from_le_bytes(sec_bytes);
                let nsec = i64::from_le_bytes(nsec_bytes);
                (sec * 1000 + nsec / 1_000_000) as i32
            } else {
                -1 // NULL timeout = wait indefinitely
            };
            let result = match syscalls::sys_sigtimedwait(proc, &mut host, mask, timeout_ms) {
                Ok((sig, si_value, si_code)) => {
                    // Write siginfo_t if pointer is non-null
                    if a2 != 0 {
                        let p = a2 as usize as *mut u8;
                        // siginfo_t layout: si_signo(0), si_errno(4), si_code(8),
                        //   si_pid(12), si_uid(16), si_value(20)
                        let sig_bytes = (sig as i32).to_le_bytes();
                        let code_bytes = si_code.to_le_bytes();
                        let pid_bytes = proc.pid.to_le_bytes();
                        let uid_bytes = proc.uid.to_le_bytes();
                        let val_bytes = si_value.to_le_bytes();
                        unsafe {
                            for i in 0..4 { *p.add(i) = sig_bytes[i]; }
                            for i in 0..4 { *p.add(8 + i) = code_bytes[i]; }
                            for i in 0..4 { *p.add(12 + i) = pid_bytes[i]; }
                            for i in 0..4 { *p.add(16 + i) = uid_bytes[i]; }
                            for i in 0..4 { *p.add(20 + i) = val_bytes[i]; }
                        }
                    }
                    sig as i32
                }
                Err(e) => -(e as i32),
            };
            deliver_pending_signals(proc, &mut host);
            result
        }

        // Time
        40 => kernel_clock_gettime(a1 as u32, a2 as *mut u8), // SYS_CLOCK_GETTIME
        41 => kernel_nanosleep(a1 as *const u8),   // SYS_NANOSLEEP
        123 => kernel_clock_getres(a1 as u32, a2 as *mut u8), // SYS_CLOCK_GETRES
        124 => kernel_clock_nanosleep(a1 as u32, a2 as u32, a3 as *const u8), // SYS_CLOCK_NANOSLEEP
        125 => { // SYS_UTIMENSAT: (dirfd, path, times, flags)
            // path can be NULL (0) for futimens(fd, times) → utimensat(fd, NULL, times, 0)
            let (p, len) = if a2 == 0 {
                (core::ptr::null(), 0u32)
            } else {
                let p = a2 as *const u8;
                (p, unsafe { cstr_len(p) })
            };
            kernel_utimensat(a1, p, len, a3 as *const u8, a4 as u32)
        }
        66 => kernel_time() as i32,                // SYS_TIME
        68 => kernel_usleep(a1 as u32),            // SYS_USLEEP

        // Memory
        46 => { // SYS_MMAP: (addr, len, prot, flags, fd, pgoffset)
            // musl sends page offset (off / 4096) as a6.
            // Convert to byte offset for kernel_mmap (lo, hi).
            let pgoff = a6 as u32;
            let byte_off = (pgoff as u64) << 12; // * 4096
            kernel_mmap(a1 as u32, a2 as u32, a3 as u32, a4 as u32, a5, byte_off as u32, (byte_off >> 32) as i32) as i32
        }
        47 => kernel_munmap(a1 as u32, a2 as u32), // SYS_MUNMAP
        48 => kernel_brk(a1 as u32) as i32,        // SYS_BRK
        49 => kernel_mprotect(a1 as u32, a2 as u32, a3 as u32), // SYS_MPROTECT
        126 => kernel_mremap(a1 as u32, a2 as u32, a3 as u32, a4 as u32) as i32, // SYS_MREMAP
        128 => kernel_madvise(a1 as u32, a2 as u32, a3 as u32), // SYS_MADVISE

        // Environment — musl: name/value are null-terminated strings
        42 => kernel_isatty(a1),                   // SYS_ISATTY
        43 => { // SYS_GETENV: (name, buf, buf_len)
            let p = a1 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_getenv(p, len, a2 as *mut u8, a3 as u32)
        }
        44 => { // SYS_SETENV: (name, value, overwrite)
            let n = a1 as *const u8;
            let v = a2 as *const u8;
            kernel_setenv(n, unsafe { cstr_len(n) }, v, unsafe { cstr_len(v) }, a3 as u32)
        }
        45 => { // SYS_UNSETENV: (name)
            let p = a1 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_unsetenv(p, len)
        }
        74 => kernel_umask(a1 as u32) as i32,      // SYS_UMASK
        75 => kernel_uname(a1 as *mut u8, 390), // SYS_UNAME (musl passes 1 arg; struct utsname = 6x65 = 390)
        76 => kernel_sysconf(a1) as i32,           // SYS_SYSCONF
        120 => kernel_getrandom(a1 as *mut u8, a2 as u32, a3 as u32), // SYS_GETRANDOM
        109 => { // SYS_REALPATH: (path, buf, buf_len)
            let p = a1 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_realpath(p, len, a2 as *mut u8, a3 as u32)
        }

        // Sockets
        50 => kernel_socket(a1 as u32, a2 as u32, a3 as u32), // SYS_SOCKET
        61 => kernel_socketpair(a1 as u32, a2 as u32, a3 as u32, a4 as *mut i32), // SYS_SOCKETPAIR
        51 => kernel_bind(a1, a2 as *const u8, a3 as u32), // SYS_BIND
        52 => kernel_listen(a1, a2 as u32),        // SYS_LISTEN
        53 => kernel_accept4(a1, a2 as *mut u8, a3 as *mut u8, 0), // SYS_ACCEPT
        384 => kernel_accept4(a1, a2 as *mut u8, a3 as *mut u8, a4 as u32), // SYS_ACCEPT4
        54 => kernel_connect(a1, a2 as *const u8, a3 as u32), // SYS_CONNECT
        55 => kernel_send(a1, a2 as *const u8, a3 as u32, a4 as u32), // SYS_SEND
        56 => kernel_recv(a1, a2 as *mut u8, a3 as u32, a4 as u32), // SYS_RECV
        57 => kernel_shutdown(a1, a2 as u32),      // SYS_SHUTDOWN
        58 => kernel_getsockopt(a1, a2 as u32, a3 as u32, a4 as *mut u8, a5 as *mut u32), // SYS_GETSOCKOPT
        59 => kernel_setsockopt(a1, a2 as u32, a3 as u32, a4 as *const u8, a5 as u32), // SYS_SETSOCKOPT
        114 => kernel_getsockname(a1, a2 as u32, a3 as u32), // SYS_GETSOCKNAME
        115 => kernel_getpeername(a1, a2 as u32, a3 as u32), // SYS_GETPEERNAME
        140 => { // SYS_GETADDRINFO: (name, result_buf)
            let p = a1 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_getaddrinfo(p, len, a2 as *mut u8)
        }
        137 => kernel_sendmsg(a1, a2 as *const u8, a3 as u32), // SYS_SENDMSG
        138 => kernel_recvmsg(a1, a2 as *mut u8, a3 as u32), // SYS_RECVMSG
        62 => kernel_sendto(a1, a2 as *const u8, a3 as u32, a4 as u32, a5 as *const u8, a6 as u32), // SYS_SENDTO
        63 => kernel_recvfrom(a1, a2 as *mut u8, a3 as u32, a4 as u32, a5 as *mut u8, a6 as u32), // SYS_RECVFROM

        // Poll/select
        60 => kernel_poll(a1 as *mut u8, a2 as u32, a3), // SYS_POLL
        251 => kernel_ppoll(a1 as *mut u8, a2 as u32, a3, a4 as u32, a5 as u32, a6 as u32), // SYS_PPOLL
        103 => kernel_select(a1, a2 as *mut u8, a3 as *mut u8, a4 as *mut u8, a5 as i32), // SYS_SELECT

        // Terminal
        70 => kernel_tcgetattr(a1, a2 as *mut u8, 256), // SYS_TCGETATTR
        71 => kernel_tcsetattr(a1, a2 as u32, a3 as *const u8, 256), // SYS_TCSETATTR
        72 => kernel_ioctl(a1, a2 as u32, a3 as *mut u8, 256), // SYS_IOCTL

        // File system
        79 => kernel_ftruncate(a1, a2 as u32, a3 as u32), // SYS_FTRUNCATE
        80 => kernel_fsync(a1),                    // SYS_FSYNC
        85 => { // SYS_TRUNCATE: (path, len_lo, len_hi)
            let p = a1 as *const u8;
            let plen = unsafe { cstr_len(p) };
            kernel_truncate(p, plen, a2 as u32, a3 as u32)
        }
        86 => kernel_fdatasync(a1),                // SYS_FDATASYNC
        87 => kernel_fchmod(a1, a2 as u32),        // SYS_FCHMOD
        88 => kernel_fchown(a1, a2 as u32, a3 as u32), // SYS_FCHOWN
        129 => { // SYS_STATFS64: (path, sizeof, statfs_buf)
            let p = a1 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_statfs(p, len, a3 as *mut u8)
        }
        130 => kernel_fstatfs(a1, a3 as *mut u8),  // SYS_FSTATFS64: (fd, sizeof, buf)
        81 => kernel_writev(a1, a2 as *const u8, a3), // SYS_WRITEV
        82 => kernel_readv(a1, a2 as *mut u8, a3), // SYS_READV
        295 => kernel_preadv(a1, a2 as *mut u8, a3, a4 as u32, a5), // SYS_PREADV
        296 => kernel_pwritev(a1, a2 as *const u8, a3, a4 as u32, a5), // SYS_PWRITEV
        294 => kernel_sendfile(a1, a2, a3 as *mut u8, a4 as u32), // SYS_SENDFILE

        // *at variants — musl: (dirfd, path, ...) without explicit path_len
        69 => { // SYS_OPENAT: (dirfd, path, flags, mode)
            let p = a2 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_openat(a1, p, len, a3 as u32, a4 as u32)
        }
        94 => { // SYS_UNLINKAT: (dirfd, path, flags)
            let p = a2 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_unlinkat(a1, p, len, a3 as u32)
        }
        95 => { // SYS_MKDIRAT: (dirfd, path, mode)
            let p = a2 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_mkdirat(a1, p, len, a3 as u32)
        }
        96 => { // SYS_RENAMEAT: (olddirfd, oldpath, newdirfd, newpath)
            let old = a2 as *const u8;
            let new = a4 as *const u8;
            kernel_renameat(a1, old, unsafe { cstr_len(old) }, a3, new, unsafe { cstr_len(new) })
        }
        97 => { // SYS_FACCESSAT: (dirfd, path, mode, flags)
            let p = a2 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_faccessat(a1, p, len, a3 as u32, a4 as u32)
        }
        98 => { // SYS_FCHMODAT: (dirfd, path, mode, flags)
            let p = a2 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_fchmodat(a1, p, len, a3 as u32, a4 as u32)
        }
        99 => { // SYS_FCHOWNAT: (dirfd, path, uid, gid, flags)
            let p = a2 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_fchownat(a1, p, len, a3 as u32, a4 as u32, a5 as u32)
        }
        100 => { // SYS_LINKAT: (olddirfd, oldpath, newdirfd, newpath, flags)
            let old = a2 as *const u8;
            let new = a4 as *const u8;
            kernel_linkat(a1, old, unsafe { cstr_len(old) }, a3, new, unsafe { cstr_len(new) }, a5 as u32)
        }
        101 => { // SYS_SYMLINKAT: (target, newdirfd, linkpath)
            let tgt = a1 as *const u8;
            let lnk = a3 as *const u8;
            kernel_symlinkat(tgt, unsafe { cstr_len(tgt) }, a2, lnk, unsafe { cstr_len(lnk) })
        }
        102 => { // SYS_READLINKAT: (dirfd, path, buf, bufsiz)
            let p = a2 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_readlinkat(a1, p, len, a3 as *mut u8, a4 as u32)
        }

        // Resource limits
        83 => kernel_getrlimit(a1 as u32, a2 as *mut u8), // SYS_GETRLIMIT
        84 => kernel_setrlimit(a1 as u32, a2 as *const u8), // SYS_SETRLIMIT
        250 => {  // SYS_PRLIMIT64: (pid, resource, new_rlim_ptr, old_rlim_ptr)
            // Get old limits first, then set new
            let mut ret = 0i32;
            if a4 != 0 {
                ret = kernel_getrlimit(a2 as u32, a4 as *mut u8);
            }
            if ret >= 0 && a3 != 0 {
                ret = kernel_setrlimit(a2 as u32, a3 as *const u8);
            }
            ret
        }

        // UID/GID
        90 => {                                    // SYS_SETPGID
            let pid = a1 as u32;
            let pgid = a2 as u32;
            let (_gkl, proc) = unsafe { get_process() };
            let effective_pid = if pid == 0 { proc.pid } else { pid };
            if effective_pid == proc.pid {
                // Self — use syscalls::sys_setpgid
                match syscalls::sys_setpgid(proc, pid, pgid) {
                    Ok(()) => {
                        let mut host = WasmHostIO;
                        deliver_pending_signals(proc, &mut host);
                        0
                    }
                    Err(e) => -(e as i32),
                }
            } else if crate::is_centralized_mode() {
                // Cross-process setpgid in centralized mode
                let new_pgid = if pgid == 0 { effective_pid } else { pgid };
                let table = unsafe { &mut *PROCESS_TABLE.0.get() };
                match table.get_mut(effective_pid) {
                    Some(target) => {
                        // POSIX: can only setpgid on a child of the calling process
                        if target.ppid != proc.pid {
                            -(Errno::ESRCH as i32)
                        } else if target.has_exec {
                            // POSIX: cannot setpgid on a child that has called exec
                            -(Errno::EACCES as i32)
                        } else if target.sid != proc.sid {
                            // POSIX: both processes must be in the same session
                            -(Errno::EPERM as i32)
                        } else if target.sid == target.pid {
                            // POSIX: cannot change pgid of a session leader
                            -(Errno::EPERM as i32)
                        } else {
                            target.pgid = new_pgid;
                            0
                        }
                    }
                    None => -(Errno::ESRCH as i32),
                }
            } else {
                -(Errno::ESRCH as i32)
            }
        }
        91 => {                                    // SYS_GETSID
            let (_gkl, proc) = unsafe { get_process() };
            let pid = a1 as u32;
            // In centralized mode, support cross-process getsid via ProcessTable
            if pid != 0 && pid != proc.pid && crate::is_centralized_mode() {
                let table = unsafe { &*PROCESS_TABLE.0.get() };
                match table.get(pid) {
                    Some(target) => target.sid as i32,
                    None => -(Errno::ESRCH as i32),
                }
            } else {
                match syscalls::sys_getsid(proc, pid) {
                    Ok(sid) => sid as i32,
                    Err(e) => -(e as i32),
                }
            }
        }
        104 => kernel_setuid(a1 as u32),           // SYS_SETUID
        105 => kernel_setgid(a1 as u32),           // SYS_SETGID
        106 => kernel_seteuid(a1 as u32),          // SYS_SETEUID
        107 => kernel_setegid(a1 as u32),          // SYS_SETEGID
        108 => kernel_getrusage(a1, a2 as *mut u8, 144), // SYS_GETRUSAGE (musl passes 2 args; time64 rusage = 18x8 = 144)
        131 => kernel_setresuid(a1 as u32, a2 as u32, a3 as u32), // SYS_SETRESUID
        132 => kernel_getresuid(a1 as *mut u32, a2 as *mut u32, a3 as *mut u32), // SYS_GETRESUID
        133 => kernel_setresgid(a1 as u32, a2 as u32, a3 as u32), // SYS_SETRESGID
        134 => kernel_getresgid(a1 as *mut u32, a2 as *mut u32, a3 as *mut u32), // SYS_GETRESGID
        135 => kernel_getgroups(a1 as u32, a2 as *mut u32), // SYS_GETGROUPS
        136 => kernel_setgroups(a1 as u32, a2 as *const u32), // SYS_SETGROUPS

        // Wait
        139 => kernel_wait4(a1, a2 as *mut i32, a3 as u32, a4 as *mut u8), // SYS_WAIT4

        // Fork/exec/clone
        211 => { // SYS_EXECVE: (path, ...)
            let p = a1 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_execve(p, len)
        }
        386 => { // SYS_EXECVEAT: (dirfd, path, argv, envp, flags)
            let p = a2 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_execveat(a1 as i32, p, len, a5 as u32)
        }
        212 => kernel_fork(),                      // SYS_FORK
        213 => kernel_fork(),                      // SYS_VFORK (treat as fork)
        201 => kernel_clone(0, a2 as u32, a1 as u32, 0, a3 as u32, a4 as u32, a5 as u32), // SYS_CLONE

        // Futex
        200 => kernel_futex(a1 as u32, a2 as u32, a3 as u32, a4 as u32, a5 as u32, a6 as u32), // SYS_FUTEX

        // Thread
        202 => kernel_gettid(),                    // SYS_GETTID
        203 => kernel_set_tid_address(a1 as u32),  // SYS_SET_TID_ADDRESS
        261 => kernel_set_robust_list(a1 as u32, a2 as u32), // SYS_SET_ROBUST_LIST
        262 => kernel_get_robust_list(a1 as u32, a2 as u32, a3 as u32), // SYS_GET_ROBUST_LIST

        // prctl
        223 => kernel_prctl(a1 as u32, a2 as u32, a3 as *mut u8, a4 as u32), // SYS_PRCTL

        // pathconf
        112 => { // SYS_PATHCONF
            let p = a1 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_pathconf(a1 as u32, len as u32, a2) as i32
        }
        113 => kernel_fpathconf(a1, a2) as i32,    // SYS_FPATHCONF

        // setreuid/setregid — map to setresuid/setresgid with -1 for saved ID
        215 => kernel_setresuid(a1 as u32, a2 as u32, 0xFFFFFFFF), // SYS_SETREUID
        216 => kernel_setresgid(a1 as u32, a2 as u32, 0xFFFFFFFF), // SYS_SETREGID

        // Timer
        225 => kernel_setitimer(a1 as u32, a2 as *const u8, a3 as *mut u8), // SYS_SETITIMER
        224 => kernel_getitimer(a1 as u32, a2 as *mut u8), // SYS_GETITIMER
        // clock_settime — always return EPERM (cannot set clock in Wasm sandbox)
        226 => -(Errno::EPERM as i32), // SYS_CLOCK_SETTIME
        // sched_yield — no-op in Wasm (single-threaded per worker)
        229 => 0, // SYS_SCHED_YIELD

        // statx — musl: (dirfd, path, flags, mask, statxbuf)
        260 => {
            let p = a2 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_statx(a1, p, len, a3 as u32, a4 as u32, a5 as *mut u8)
        }

        // SysV IPC — handled by kernel IpcTable
        337 => { // SYS_MSGGET: (key, flags)
            let ipc = unsafe { crate::ipc::global_ipc_table() };
            let pid = unsafe { &*PROCESS_TABLE.0.get() }.current_pid();
            // Get uid/gid from current process
            let (uid, gid) = unsafe {
                let pt = &*PROCESS_TABLE.0.get();
                match pt.get(pid) {
                    Some(p) => (p.euid, p.egid),
                    None => (0, 0),
                }
            };
            match ipc.msgget(a1, a2 as u32, pid, uid, gid) {
                Ok(id) => id,
                Err(e) => -(e as i32),
            }
        }
        338 => { // SYS_MSGRCV: (qid, msgp, msgsz, msgtyp, flags)
            let ipc = unsafe { crate::ipc::global_ipc_table() };
            let pid = unsafe { &*PROCESS_TABLE.0.get() }.current_pid();
            match ipc.msgrcv(a1, a3 as u32, a4, a5 as u32, pid) {
                Ok(result) => {
                    // Write {mtype (4B), mtext} to msgp (kernel scratch)
                    let out = a2 as *mut u8;
                    let mtype_bytes = result.mtype.to_le_bytes();
                    unsafe {
                        for i in 0..4 { *out.add(i) = mtype_bytes[i]; }
                        for (i, &b) in result.data.iter().enumerate() {
                            *out.add(4 + i) = b;
                        }
                    }
                    result.data.len() as i32
                }
                Err(e) => -(e as i32),
            }
        }
        339 => { // SYS_MSGSND: (qid, msgp, msgsz, flags)
            let ipc = unsafe { crate::ipc::global_ipc_table() };
            let pid = unsafe { &*PROCESS_TABLE.0.get() }.current_pid();
            // Read mtype from msgp, mtext from msgp+4
            let msgp = a2 as *const u8;
            let msgsz = a3 as usize;
            let mtype = unsafe {
                i32::from_le_bytes([*msgp, *msgp.add(1), *msgp.add(2), *msgp.add(3)])
            };
            let data = unsafe { core::slice::from_raw_parts(msgp.add(4), msgsz) };
            match ipc.msgsnd(a1, mtype, data, a4 as u32, pid) {
                Ok(()) => 0,
                Err(e) => -(e as i32),
            }
        }
        340 => { // SYS_MSGCTL: (qid, cmd, buf_ptr)
            let ipc = unsafe { crate::ipc::global_ipc_table() };
            let pid = unsafe { &*PROCESS_TABLE.0.get() }.current_pid();
            let cmd = a2 & !0x100; // strip IPC_64
            match ipc.msgctl(a1, cmd, pid) {
                Ok(Some(info)) => {
                    if a3 != 0 {
                        let out = a3 as *mut u8;
                        unsafe { write_msqid_ds(out, &info); }
                    }
                    0
                }
                Ok(None) => 0,
                Err(e) => -(e as i32),
            }
        }
        341 => { // SYS_SEMGET: (key, nsems, flags)
            let ipc = unsafe { crate::ipc::global_ipc_table() };
            let pid = unsafe { &*PROCESS_TABLE.0.get() }.current_pid();
            let (uid, gid) = unsafe {
                let pt = &*PROCESS_TABLE.0.get();
                match pt.get(pid) {
                    Some(p) => (p.euid, p.egid),
                    None => (0, 0),
                }
            };
            match ipc.semget(a1, a2 as u32, a3 as u32, pid, uid, gid) {
                Ok(id) => id,
                Err(e) => -(e as i32),
            }
        }
        342 => { // SYS_SEMOP: (semid, sops_ptr, nsops)
            let ipc = unsafe { crate::ipc::global_ipc_table() };
            let pid = unsafe { &*PROCESS_TABLE.0.get() }.current_pid();
            let nsops = a3 as usize;
            let sops_ptr = a2 as *const u8;
            let mut sops = alloc::vec::Vec::with_capacity(nsops);
            for i in 0..nsops {
                let base = unsafe { sops_ptr.add(i * 6) };
                let num = unsafe { u16::from_le_bytes([*base, *base.add(1)]) };
                let op = unsafe { i16::from_le_bytes([*base.add(2), *base.add(3)]) };
                let flg = unsafe { u16::from_le_bytes([*base.add(4), *base.add(5)]) };
                sops.push(crate::ipc::SemOp { num, op, flg });
            }
            match ipc.semop(a1, &sops, pid) {
                Ok(()) => 0,
                Err(e) => -(e as i32),
            }
        }
        343 => { // SYS_SEMCTL: (semid, semnum, cmd, arg)
            let ipc = unsafe { crate::ipc::global_ipc_table() };
            let pid = unsafe { &*PROCESS_TABLE.0.get() }.current_pid();
            let cmd = a3 & !0x100; // strip IPC_64
            // SETALL (17): arg points to u16[] in scratch
            if cmd == 17 {
                // First get nsems via IPC_STAT
                match ipc.semctl(a1, 0, 2, pid, 0) { // IPC_STAT=2
                    Ok(crate::ipc::SemCtlResult::Stat(info)) => {
                        let nsems = info.nsems as usize;
                        let ptr = a4 as *const u8;
                        let mut vals = alloc::vec::Vec::with_capacity(nsems);
                        for i in 0..nsems {
                            let base = unsafe { ptr.add(i * 2) };
                            vals.push(unsafe { u16::from_le_bytes([*base, *base.add(1)]) });
                        }
                        match ipc.semctl_set_all(a1, &vals) {
                            Ok(()) => 0,
                            Err(e) => -(e as i32),
                        }
                    }
                    _ => -(Errno::EINVAL as i32),
                }
            } else {
                match ipc.semctl(a1, a2, cmd, pid, a4) {
                    Ok(crate::ipc::SemCtlResult::Ok) => 0,
                    Ok(crate::ipc::SemCtlResult::Value(v)) => v,
                    Ok(crate::ipc::SemCtlResult::Stat(info)) => {
                        if a4 != 0 {
                            let out = a4 as *mut u8;
                            unsafe { write_semid_ds(out, &info); }
                        }
                        0
                    }
                    Ok(crate::ipc::SemCtlResult::All(vals)) => {
                        // GETALL: write u16[] to arg pointer
                        if a4 != 0 {
                            let out = a4 as *mut u8;
                            for (i, &v) in vals.iter().enumerate() {
                                let bytes = v.to_le_bytes();
                                unsafe {
                                    *out.add(i * 2) = bytes[0];
                                    *out.add(i * 2 + 1) = bytes[1];
                                }
                            }
                        }
                        0
                    }
                    Err(e) => -(e as i32),
                }
            }
        }
        344 => { // SYS_SHMGET: (key, size, flags)
            let ipc = unsafe { crate::ipc::global_ipc_table() };
            let pid = unsafe { &*PROCESS_TABLE.0.get() }.current_pid();
            let (uid, gid) = unsafe {
                let pt = &*PROCESS_TABLE.0.get();
                match pt.get(pid) {
                    Some(p) => (p.euid, p.egid),
                    None => (0, 0),
                }
            };
            match ipc.shmget(a1, a2 as u32, a3 as u32, pid, uid, gid) {
                Ok(id) => id,
                Err(e) => -(e as i32),
            }
        }
        // SYS_SHMAT (345), SYS_SHMDT (346): intercepted by host for process memory management
        345 => kernel_ipc_shmat(a1, a2, a3),
        346 => kernel_ipc_shmdt(a1),
        347 => { // SYS_SHMCTL: (shmid, cmd, buf_ptr)
            let ipc = unsafe { crate::ipc::global_ipc_table() };
            let pid = unsafe { &*PROCESS_TABLE.0.get() }.current_pid();
            let cmd = a2 & !0x100; // strip IPC_64
            match ipc.shmctl(a1, cmd, pid) {
                Ok(Some(info)) => {
                    if a3 != 0 {
                        let out = a3 as *mut u8;
                        unsafe { write_shmid_ds(out, &info); }
                    }
                    0
                }
                Ok(None) => 0,
                Err(e) => -(e as i32),
            }
        }

        // epoll
        239 => kernel_epoll_create1(a1 as u32),     // SYS_EPOLL_CREATE1: (flags)
        378 => kernel_epoll_create1(0),              // SYS_EPOLL_CREATE: (size) — flags=0
        240 => kernel_epoll_ctl(a1, a2, a3, a4 as *const u8), // SYS_EPOLL_CTL: (epfd, op, fd, event_ptr)
        241 => kernel_epoll_pwait(a1, a2 as *mut u8, a3, a4, a5 as u32), // SYS_EPOLL_PWAIT: (epfd, events, maxevents, timeout, sigmask_ptr)
        379 => kernel_epoll_pwait(a1, a2 as *mut u8, a3, a4, 0), // SYS_EPOLL_WAIT: (epfd, events, maxevents, timeout)

        // eventfd
        242 => kernel_eventfd2(a1 as u32, a2 as u32), // SYS_EVENTFD2: (initval, flags)
        380 => kernel_eventfd2(a1 as u32, 0),          // SYS_EVENTFD: (initval) — no flags

        // timerfd
        243 => kernel_timerfd_create(a1 as u32, a2 as u32), // SYS_TIMERFD_CREATE: (clockid, flags)
        244 => kernel_timerfd_settime(a1, a2 as u32, a3 as *const u8, a4 as *mut u8), // SYS_TIMERFD_SETTIME
        245 => kernel_timerfd_gettime(a1, a2 as *mut u8), // SYS_TIMERFD_GETTIME

        // signalfd
        246 => kernel_signalfd4(a1, a2 as u32, a3 as u32, a4 as u32), // SYS_SIGNALFD4: (fd, mask_ptr, sigsetsize, flags)
        377 => kernel_signalfd4(a1, a2 as u32, a3 as u32, 0),          // SYS_SIGNALFD: (fd, mask_ptr, sigsetsize)

        // Stubs that return 0 or -ENOSYS
        204 => kernel_raise(a2 as u32),            // SYS_TKILL

        // SYS_RT_SIGQUEUEINFO: send signal with si_value (sigqueue)
        // a1=pid, a2=sig, a3=siginfo_ptr (copied to CH_DATA by host)
        205 => {
            // Extract si_value.sival_int from siginfo_t at offset 20
            // Layout: si_signo(4), si_errno(4), si_code(4), si_pid(4), si_uid(4), si_value(4)
            let si_value = if a3 != 0 {
                let info_ptr = a3 as *const u8;
                let info = unsafe { slice::from_raw_parts(info_ptr, 24) };
                i32::from_le_bytes(info[20..24].try_into().unwrap())
            } else {
                0
            };
            kernel_kill_with_value(a1, a2 as u32, si_value)
        },

        // SYS_RT_SIGRETURN: signal handler return — clean up alt stack state
        208 => {
            let (_gkl, proc) = unsafe { get_process() };
            if proc.alt_stack_depth > 0 {
                proc.alt_stack_depth -= 1;
                if proc.alt_stack_depth == 0 {
                    const SS_ONSTACK: u32 = 1;
                    proc.alt_stack_flags &= !SS_ONSTACK;
                }
            }
            0
        }

        // SYS_SIGALTSTACK: store/retrieve alternate stack state
        209 => kernel_sigaltstack(a1 as *const u8, a2 as *mut u8),

        // SYS_SCHED_GET_PRIORITY_MAX: POSIX requires at least 32 levels for SCHED_RR/SCHED_FIFO
        234 => {
            let policy = a1;
            if policy >= 0 && policy <= 2 { 32 } else { -(Errno::EINVAL as i32) }
        }
        // SYS_SCHED_GET_PRIORITY_MIN
        235 => {
            let policy = a1;
            if policy >= 0 && policy <= 2 { 1 } else { -(Errno::EINVAL as i32) }
        }

        // SYS_SCHED_GETPARAM: write sched_priority=0 to param struct
        230 => kernel_sched_getparam(a1, a2 as *mut u8),
        // SYS_SCHED_SETPARAM: no-op (return 0 for valid pid)
        231 => kernel_sched_validate_pid(a1),
        // SYS_SCHED_GETSCHEDULER: always SCHED_OTHER (0) for valid PIDs
        232 => kernel_sched_validate_pid(a1),
        // SYS_SCHED_SETSCHEDULER: no-op (return 0 for valid pid)
        233 => kernel_sched_validate_pid(a1),

        // SYS_SCHED_RR_GET_INTERVAL: (pid, timespec_ptr)
        236 => {
            let (_gkl, proc) = unsafe { get_process() };
            let pid = a1 as u32;
            if pid != 0 && pid != proc.pid {
                -(Errno::ESRCH as i32)
            } else if a2 == 0 {
                -(Errno::EFAULT as i32)
            } else {
                // Write a reasonable RR interval: 100ms
                let p = a2 as usize as *mut u8;
                let sec: i64 = 0;
                let nsec: i64 = 100_000_000; // 100ms
                unsafe {
                    let sec_bytes = sec.to_le_bytes();
                    let nsec_bytes = nsec.to_le_bytes();
                    for i in 0..8 { *p.add(i) = sec_bytes[i]; }
                    for i in 0..8 { *p.add(8 + i) = nsec_bytes[i]; }
                }
                0
            }
        }

        // mlock/munlock: no-op in Wasm (all memory is "locked")
        // Return ENOMEM for addresses beyond Wasm memory bounds
        279 | 280 => { // mlock, mlock2: (addr, len, ...)
            let addr = a1 as u32;
            let len = a2 as u32;
            if addr.checked_add(len).map_or(true, |end| end > 1_073_741_824) {
                -(Errno::ENOMEM as i32)
            } else {
                0
            }
        }
        281 => { // munlock: (addr, len)
            let addr = a1 as u32;
            let len = a2 as u32;
            if addr.checked_add(len).map_or(true, |end| end > 1_073_741_824) {
                -(Errno::ENOMEM as i32)
            } else {
                0
            }
        }
        282 | 283 => 0, // mlockall, munlockall: success
        // SYS_GETPRIORITY
        285 => {
            let (_gkl, proc) = unsafe { get_process() };
            match syscalls::sys_getpriority(proc, a1, a2 as u32) {
                Ok(v) => v,
                Err(e) => -(e as i32),
            }
        }
        286 => { // SYS_SETPRIORITY
            let (_gkl, proc) = unsafe { get_process() };
            match syscalls::sys_setpriority(proc, a1, a2 as u32, a3) {
                Ok(()) => 0,
                Err(e) => -(e as i32),
            }
        }

        252 => { // SYS_PSELECT6_TIME64: (nfds, readfds, writefds, exceptfds, timeout_ms, mask_ptr)
            // Args pre-decoded by host: timeout → ms, mask stored at mask_ptr (8 bytes: lo+hi)
            let mask_ptr = a6 as *const u8;
            let (has_mask, mask_lo, mask_hi) = if mask_ptr.is_null() {
                (0u32, 0u32, 0u32)
            } else {
                let mb = unsafe { core::slice::from_raw_parts(mask_ptr, 8) };
                (1u32,
                 u32::from_le_bytes([mb[0], mb[1], mb[2], mb[3]]),
                 u32::from_le_bytes([mb[4], mb[5], mb[6], mb[7]]))
            };
            kernel_pselect6(a1, a2 as *mut u8, a3 as *mut u8, a4 as *mut u8, a5, has_mask, mask_lo, mask_hi)
        }
        299 => { // SYS_LCHOWN: (path, uid, gid) — treat like chown (no symlink distinction)
            let p = a1 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_chown(p, len, a2 as u32, a3 as u32)
        }
        307 => 0, // SYS_FADVISE64: advisory, always succeed

        // POSIX timers
        326 => kernel_timer_create(a1 as u32, a2 as *const u8, a3 as *mut i32), // SYS_TIMER_CREATE
        327 => kernel_timer_settime(a1 as i32, a2 as i32, a3 as *const u8, a4 as *mut u8), // SYS_TIMER_SETTIME
        328 => kernel_timer_gettime(a1 as i32, a2 as *mut u8), // SYS_TIMER_GETTIME
        329 => kernel_timer_getoverrun(a1 as i32), // SYS_TIMER_GETOVERRUN
        330 => kernel_timer_delete(a1 as i32), // SYS_TIMER_DELETE

        208 => { // SYS_SYSINFO
            let buf_ptr = a1 as *mut u8;
            let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, 312) };
            match syscalls::sys_sysinfo(buf) {
                Ok(()) => 0,
                Err(e) => -(e as i32),
            }
        }

        256 => { // SYS_MEMFD_CREATE: (name, flags)
            let (_gkl, proc) = unsafe { get_process() };
            let name_ptr = a1 as *const u8;
            let name_len = unsafe { cstr_len(name_ptr) } as usize;
            let name = if name_ptr.is_null() || name_len == 0 {
                &[]
            } else {
                unsafe { slice::from_raw_parts(name_ptr, name_len) }
            };
            match syscalls::sys_memfd_create(proc, name, a2 as u32) {
                Ok(fd) => fd,
                Err(e) => -(e as i32),
            }
        }
        290 => { // SYS_COPY_FILE_RANGE: (fd_in, off_in*, fd_out, off_out*, len, flags)
            let (_gkl, proc) = unsafe { get_process() };
            let mut host = WasmHostIO;
            let off_in_ptr = a2 as *mut u8;
            let off_out_ptr = a4 as *mut u8;
            let off_in = if off_in_ptr.is_null() {
                None
            } else {
                let bytes = unsafe { slice::from_raw_parts(off_in_ptr, 8) };
                Some(i64::from_le_bytes(bytes.try_into().unwrap()))
            };
            let off_out = if off_out_ptr.is_null() {
                None
            } else {
                let bytes = unsafe { slice::from_raw_parts(off_out_ptr, 8) };
                Some(i64::from_le_bytes(bytes.try_into().unwrap()))
            };
            match syscalls::sys_copy_file_range(proc, &mut host, a1, off_in, a3, off_out, a5 as usize) {
                Ok(n) => {
                    // Update offset pointers if provided
                    if !off_in_ptr.is_null() {
                        if let Some(orig) = off_in {
                            let new_off = orig + n as i64;
                            let buf = unsafe { slice::from_raw_parts_mut(off_in_ptr, 8) };
                            buf.copy_from_slice(&new_off.to_le_bytes());
                        }
                    }
                    if !off_out_ptr.is_null() {
                        if let Some(orig) = off_out {
                            let new_off = orig + n as i64;
                            let buf = unsafe { slice::from_raw_parts_mut(off_out_ptr, 8) };
                            buf.copy_from_slice(&new_off.to_le_bytes());
                        }
                    }
                    n as i32
                }
                Err(e) => -(e as i32),
            }
        }

        291 => { // SYS_SPLICE: (fd_in, off_in*, fd_out, off_out*, len, flags)
            let (_gkl, proc) = unsafe { get_process() };
            let mut host = WasmHostIO;
            let off_in_ptr = a2 as *mut u8;
            let off_out_ptr = a4 as *mut u8;
            let off_in = if off_in_ptr.is_null() {
                None
            } else {
                let bytes = unsafe { slice::from_raw_parts(off_in_ptr, 8) };
                Some(i64::from_le_bytes(bytes.try_into().unwrap()))
            };
            let off_out = if off_out_ptr.is_null() {
                None
            } else {
                let bytes = unsafe { slice::from_raw_parts(off_out_ptr, 8) };
                Some(i64::from_le_bytes(bytes.try_into().unwrap()))
            };
            match syscalls::sys_splice(proc, &mut host, a1, off_in, a3, off_out, a5 as usize, a6 as u32) {
                Ok(n) => {
                    if !off_in_ptr.is_null() {
                        if let Some(orig) = off_in {
                            let buf = unsafe { slice::from_raw_parts_mut(off_in_ptr, 8) };
                            buf.copy_from_slice(&(orig + n as i64).to_le_bytes());
                        }
                    }
                    if !off_out_ptr.is_null() {
                        if let Some(orig) = off_out {
                            let buf = unsafe { slice::from_raw_parts_mut(off_out_ptr, 8) };
                            buf.copy_from_slice(&(orig + n as i64).to_le_bytes());
                        }
                    }
                    n as i32
                }
                Err(e) => -(e as i32),
            }
        }
        293 => 0, // SYS_READAHEAD: advisory, always succeed
        297 => kernel_preadv(a1, a2 as *mut u8, a3, a4 as u32, a5), // SYS_PREADV2 (ignore flags in a6)
        298 => kernel_pwritev(a1, a2 as *const u8, a3, a4 as u32, a5), // SYS_PWRITEV2 (ignore flags in a6)

        // -- Scheduling stubs (single-CPU Wasm) --
        237 => 0, // SYS_SCHED_SETAFFINITY: no-op (single CPU)
        238 => { // SYS_SCHED_GETAFFINITY: return a 1-bit cpuset
            let size = a2 as usize;
            let mask_ptr = a3 as *mut u8;
            if size == 0 || mask_ptr.is_null() {
                -(Errno::EINVAL as i32)
            } else {
                let mask = unsafe { slice::from_raw_parts_mut(mask_ptr, size) };
                for b in mask.iter_mut() { *b = 0; }
                mask[0] = 1; // CPU 0 available
                0
            }
        }

        // -- Memory/sync stubs --
        257 => 0, // SYS_MEMBARRIER: no-op (single-threaded per process in Wasm)
        273 => 0, // SYS_SYNC: no-op (all I/O is synchronous to host)
        274 => 0, // SYS_SYNCFS: no-op
        278 => 0, // SYS_MSYNC: no-op (MAP_PRIVATE changes are process-local, file-backed writes go through write())

        // -- Process stubs --
        287 => 0, // SYS_PERSONALITY: return 0 (current personality, PER_LINUX)

        // -- Filesystem --
        304 => 0, // SYS_SYSLOG (kernel log): no-op (not the libc syslog)
        306 => { // SYS_RENAMEAT2: (olddirfd, oldpath, newdirfd, newpath, flags)
            // Ignore flags (RENAME_NOREPLACE, RENAME_EXCHANGE) — delegate to renameat
            let old = a2 as *const u8;
            let new = a4 as *const u8;
            kernel_renameat(a1, old, unsafe { cstr_len(old) }, a3, new, unsafe { cstr_len(new) })
        }
        308 => { // SYS_FALLOCATE: (fd, mode, offset_lo, offset_hi, len_lo, len_hi)
            let mode = a2 as u32;
            if mode != 0 {
                -(Errno::EOPNOTSUPP as i32)
            } else {
                let (_gkl, proc) = unsafe { get_process() };
                let mut host = WasmHostIO;
                let offset = ((a4 as u32 as u64) << 32 | (a3 as u32 as u64)) as i64;
                let len = ((a6 as u32 as u64) << 32 | (a5 as u32 as u64)) as i64;
                match syscalls::sys_fallocate(proc, &mut host, a1, offset, len) {
                    Ok(()) => 0,
                    Err(e) => -(e as i32),
                }
            }
        }
        323 => 0, // SYS_SYNC_FILE_RANGE: advisory, no-op
        325 => { // SYS_GETCPU: (cpu*, node*, unused)
            let cpu_ptr = a1 as *mut u32;
            let node_ptr = a2 as *mut u32;
            if !cpu_ptr.is_null() {
                unsafe { *cpu_ptr = 0; }
            }
            if !node_ptr.is_null() {
                unsafe { *node_ptr = 0; }
            }
            0
        }

        // --- xattr stubs: no extended attribute support ---
        // fgetxattr/fsetxattr/fremovexattr/flistxattr
        350 => -(Errno::ENODATA as i32), // SYS_FGETXATTR: no attrs → ENODATA
        351 => 0,                         // SYS_FLISTXATTR: empty list → 0 bytes
        352 => -(Errno::ENODATA as i32), // SYS_FREMOVEXATTR: no attrs → ENODATA
        353 => 0,                         // SYS_FSETXATTR: silently accept
        // getxattr/setxattr/removexattr/listxattr (path-based)
        354 => -(Errno::ENODATA as i32), // SYS_GETXATTR
        355 => 0,                         // SYS_LISTXATTR: empty list
        356 => -(Errno::ENODATA as i32), // SYS_LGETXATTR
        357 => 0,                         // SYS_LLISTXATTR: empty list
        358 => -(Errno::ENODATA as i32), // SYS_LREMOVEXATTR
        359 => 0,                         // SYS_LSETXATTR: silently accept
        360 => -(Errno::ENODATA as i32), // SYS_REMOVEXATTR
        361 => 0,                         // SYS_SETXATTR: silently accept

        // --- setfsuid/setfsgid: return previous uid/gid ---
        370 => 1000, // SYS_SETFSUID: return current fsuid (1000)
        371 => 1000, // SYS_SETFSGID: return current fsgid (1000)

        // --- faccessat2/fchmodat2: delegate to existing implementations ---
        382 => { // SYS_FACCESSAT2: (dirfd, path, mode, flags)
            let path = a2 as *const u8;
            kernel_faccessat(a1, path, unsafe { cstr_len(path) }, a3 as u32, a4 as u32)
        }
        383 => { // SYS_FCHMODAT2: (dirfd, path, mode, flags)
            let path = a2 as *const u8;
            kernel_fchmodat(a1, path, unsafe { cstr_len(path) }, a3 as u32, a4 as u32)
        }

        // --- inotify stubs: create eventfd-like fd ---
        247 | 381 => { // SYS_INOTIFY_INIT1 / SYS_INOTIFY_INIT
            let (_gkl, proc) = unsafe { get_process() };
            match syscalls::sys_inotify_init(proc) {
                Ok(fd) => fd,
                Err(e) => -(e as i32),
            }
        }
        248 => 1, // SYS_INOTIFY_ADD_WATCH: return dummy watch descriptor
        249 => 0, // SYS_INOTIFY_RM_WATCH: no-op success

        // --- mknod/mknodat: create regular files and FIFOs ---
        // S_IFIFO nodes are created as regular files (sufficient for basic
        // mkfifo/mknod tests that don't actually use FIFO I/O semantics).
        271 => { // SYS_MKNOD: (path, mode, dev)
            let path = a1 as *const u8;
            let mode = a2 as u32;
            let file_type = mode & 0o170000;
            if file_type != 0 && file_type != 0o100000 && file_type != 0o010000 {
                -(Errno::EPERM as i32)
            } else {
                kernel_mknod(path, unsafe { cstr_len(path) }, mode & 0o7777)
            }
        }
        272 => { // SYS_MKNODAT: (dirfd, path, mode, dev)
            let path = a2 as *const u8;
            let mode = a3 as u32;
            let file_type = mode & 0o170000;
            if file_type != 0 && file_type != 0o100000 && file_type != 0o010000 {
                -(Errno::EPERM as i32)
            } else {
                kernel_mknodat(a1, path, unsafe { cstr_len(path) }, mode & 0o7777)
            }
        }

        // POSIX message queues
        331 => { // SYS_MQ_OPEN: (name_ptr, flags, mode, attr_ptr)
            let p = a1 as *const u8;
            let name_len = unsafe { cstr_len(p) };
            let name = unsafe { core::str::from_utf8_unchecked(core::slice::from_raw_parts(p, name_len as usize)) };
            let flags = a2 as u32;
            let mode = a3 as u32;
            let has_attr = a4 != 0 && (flags & 0o100) != 0; // O_CREAT
            let (maxmsg, msgsize) = if has_attr {
                let attr_ptr = a4 as *const u8;
                let maxmsg = unsafe { i32::from_le_bytes([*attr_ptr.add(4), *attr_ptr.add(5), *attr_ptr.add(6), *attr_ptr.add(7)]) } as u32;
                let msgsize = unsafe { i32::from_le_bytes([*attr_ptr.add(8), *attr_ptr.add(9), *attr_ptr.add(10), *attr_ptr.add(11)]) } as u32;
                (maxmsg, msgsize)
            } else {
                (0, 0)
            };
            let table = unsafe { crate::mqueue::global_mqueue_table() };
            match table.mq_open(name, flags, mode, maxmsg, msgsize, has_attr) {
                Ok(mqd) => mqd as i32,
                Err(e) => -(e as i32),
            }
        }
        332 => { // SYS_MQ_UNLINK: (name_ptr)
            let p = a1 as *const u8;
            let name_len = unsafe { cstr_len(p) };
            let name = unsafe { core::str::from_utf8_unchecked(core::slice::from_raw_parts(p, name_len as usize)) };
            let table = unsafe { crate::mqueue::global_mqueue_table() };
            match table.mq_unlink(name) {
                Ok(()) => 0,
                Err(e) => -(e as i32),
            }
        }
        333 => { // SYS_MQ_TIMEDSEND: (mqd, msg_ptr, msg_len, priority, timeout_ptr)
            let data = unsafe { core::slice::from_raw_parts(a2 as *const u8, a3 as usize) };
            let table = unsafe { crate::mqueue::global_mqueue_table() };
            match table.mq_send(a1 as u32, data, a4 as u32) {
                Ok(result) => {
                    if let Some(notif) = result.notification {
                        table.set_pending_notification(notif);
                    }
                    0
                }
                Err(e) => -(e as i32),
            }
        }
        334 => { // SYS_MQ_TIMEDRECEIVE: (mqd, msg_ptr, msg_len, prio_ptr, timeout_ptr)
            let table = unsafe { crate::mqueue::global_mqueue_table() };
            match table.mq_receive(a1 as u32, a3 as u32) {
                Ok(result) => {
                    // Write message data to kernel memory (msg_ptr adjusted by host)
                    let dst = unsafe { core::slice::from_raw_parts_mut(a2 as *mut u8, result.data.len()) };
                    dst.copy_from_slice(&result.data);
                    // Write priority if pointer provided
                    if a4 != 0 {
                        let prio_ptr = a4 as *mut u8;
                        let prio_bytes = result.priority.to_le_bytes();
                        unsafe {
                            *prio_ptr = prio_bytes[0];
                            *prio_ptr.add(1) = prio_bytes[1];
                            *prio_ptr.add(2) = prio_bytes[2];
                            *prio_ptr.add(3) = prio_bytes[3];
                        }
                    }
                    result.data.len() as i32
                }
                Err(e) => -(e as i32),
            }
        }
        335 => { // SYS_MQ_NOTIFY: (mqd, sev_ptr)
            let table = unsafe { crate::mqueue::global_mqueue_table() };
            let pid = unsafe { &*PROCESS_TABLE.0.get() }.current_pid();
            if a2 == 0 {
                // NULL sigevent = unregister
                match table.mq_notify(a1 as u32, pid, None, 0) {
                    Ok(()) => 0,
                    Err(e) => -(e as i32),
                }
            } else {
                let sev_ptr = a2 as *const u8;
                let signo = unsafe { i32::from_le_bytes([*sev_ptr.add(4), *sev_ptr.add(5), *sev_ptr.add(6), *sev_ptr.add(7)]) } as u32;
                let notify = unsafe { i32::from_le_bytes([*sev_ptr.add(8), *sev_ptr.add(9), *sev_ptr.add(10), *sev_ptr.add(11)]) } as u32;
                match table.mq_notify(a1 as u32, pid, Some(notify), signo) {
                    Ok(()) => 0,
                    Err(e) => -(e as i32),
                }
            }
        }
        336 => { // SYS_MQ_GETSETATTR: (mqd, new_attr_ptr, old_attr_ptr)
            let table = unsafe { crate::mqueue::global_mqueue_table() };
            let new_flags = if a2 != 0 {
                let ptr = a2 as *const u8;
                let flags = unsafe { i32::from_le_bytes([*ptr, *ptr.add(1), *ptr.add(2), *ptr.add(3)]) };
                Some(flags as u32)
            } else {
                None
            };
            match table.mq_getsetattr(a1 as u32, new_flags) {
                Ok(attr) => {
                    if a3 != 0 {
                        let out = a3 as *mut u8;
                        unsafe {
                            // Write struct mq_attr: { long mq_flags, mq_maxmsg, mq_msgsize, mq_curmsgs, __unused[4] }
                            let f = (attr.flags as i32).to_le_bytes();
                            let mm = (attr.maxmsg as i32).to_le_bytes();
                            let ms = (attr.msgsize as i32).to_le_bytes();
                            let cm = (attr.curmsgs as i32).to_le_bytes();
                            for i in 0..4 { *out.add(i) = f[i]; }
                            for i in 0..4 { *out.add(4 + i) = mm[i]; }
                            for i in 0..4 { *out.add(8 + i) = ms[i]; }
                            for i in 0..4 { *out.add(12 + i) = cm[i]; }
                            // Zero __unused[4]
                            for i in 16..32 { *out.add(i) = 0; }
                        }
                    }
                    0
                }
                Err(e) => -(e as i32),
            }
        }

        253..=254 | 262 | 265..=268 | 289 | 292 | 301..=303 | 305 | 309..=322 | 324 | 348..=349 | 362..=369 | 373..=376 | 386 => {
            // Remaining stubs: return ENOSYS
            -(Errno::ENOSYS as i32)
        }

        _ => -(Errno::ENOSYS as i32),
    }
}

// ---------------------------------------------------------------------------
// SysV IPC kernel exports
// ---------------------------------------------------------------------------

/// Set the current process for subsequent kernel_ipc_* calls.
/// Host must call this before kernel_ipc_shmat/shmdt/shm_read_chunk/shm_write_chunk.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_current_pid(pid: u32) {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    table.set_current_pid(pid);
}

/// Attach to shared memory segment. Returns segment size, or negative errno.
/// Host uses this + kernel_ipc_shm_read_chunk to transfer data to process memory.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_shmat(shmid: i32, _shmaddr: i32, _flags: i32) -> i32 {
    let ipc = unsafe { crate::ipc::global_ipc_table() };
    let pid = unsafe { &*PROCESS_TABLE.0.get() }.current_pid();
    match ipc.shmat(shmid, pid) {
        Ok(size) => size as i32,
        Err(e) => -(e as i32),
    }
}

/// Detach from shared memory segment.
/// Host should call kernel_ipc_shm_write_chunk first to sync data back.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_shmdt(shmid: i32) -> i32 {
    let ipc = unsafe { crate::ipc::global_ipc_table() };
    let pid = unsafe { &*PROCESS_TABLE.0.get() }.current_pid();
    match ipc.shmdt(shmid, pid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}

/// Read a chunk of shared memory segment data into scratch area.
/// Returns bytes written to out_ptr.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_shm_read_chunk(shmid: i32, offset: u32, out_ptr: *mut u8, max_len: u32) -> i32 {
    let ipc = unsafe { crate::ipc::global_ipc_table() };
    let buf = unsafe { core::slice::from_raw_parts_mut(out_ptr, max_len as usize) };
    match ipc.shm_read_chunk(shmid, offset, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    }
}

/// Write a chunk of data from scratch area into shared memory segment.
/// Returns bytes written.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_shm_write_chunk(shmid: i32, offset: u32, data_ptr: *const u8, data_len: u32) -> i32 {
    let ipc = unsafe { crate::ipc::global_ipc_table() };
    let data = unsafe { core::slice::from_raw_parts(data_ptr, data_len as usize) };
    match ipc.shm_write_chunk(shmid, offset, data) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    }
}

// ---------------------------------------------------------------------------
// SysV IPC struct serialization helpers (wasm32 layout)
// ---------------------------------------------------------------------------

/// Write struct ipc_perm to kernel memory (36 bytes).
unsafe fn write_ipc_perm(out: *mut u8, key: i32, uid: u32, gid: u32, cuid: u32, cgid: u32, mode: u32, seq: i32) {
    let write_i32 = |ptr: *mut u8, off: usize, val: i32| {
        let bytes = val.to_le_bytes();
        for i in 0..4 { *ptr.add(off + i) = bytes[i]; }
    };
    let write_u32 = |ptr: *mut u8, off: usize, val: u32| {
        let bytes = val.to_le_bytes();
        for i in 0..4 { *ptr.add(off + i) = bytes[i]; }
    };
    write_i32(out, 0, key);
    write_u32(out, 4, uid);
    write_u32(out, 8, gid);
    write_u32(out, 12, cuid);
    write_u32(out, 16, cgid);
    write_u32(out, 20, mode);
    write_i32(out, 24, seq);
    // Padding bytes 28-35
    for i in 28..36 { *out.add(i) = 0; }
}

/// Write i64 as two i32 halves (little-endian) at offset.
unsafe fn write_time(out: *mut u8, offset: usize, secs: i64) {
    let lo = (secs & 0xFFFF_FFFF) as i32;
    let hi = (secs >> 32) as i32;
    let lo_bytes = lo.to_le_bytes();
    let hi_bytes = hi.to_le_bytes();
    for i in 0..4 { *out.add(offset + i) = lo_bytes[i]; }
    for i in 0..4 { *out.add(offset + 4 + i) = hi_bytes[i]; }
}

/// Write struct msqid_ds to kernel memory (96 bytes).
unsafe fn write_msqid_ds(out: *mut u8, info: &crate::ipc::MsgQueueInfo) {
    // Zero the whole struct first
    for i in 0..96 { *out.add(i) = 0; }
    write_ipc_perm(out, info.key, info.uid, info.gid, info.cuid, info.cgid, info.mode, info.seq);
    // 36-39: padding
    write_time(out, 40, info.stime);
    write_time(out, 48, info.rtime);
    write_time(out, 56, info.ctime);
    let write_u32 = |ptr: *mut u8, off: usize, val: u32| {
        let bytes = val.to_le_bytes();
        for i in 0..4 { *ptr.add(off + i) = bytes[i]; }
    };
    let write_i32 = |ptr: *mut u8, off: usize, val: i32| {
        let bytes = val.to_le_bytes();
        for i in 0..4 { *ptr.add(off + i) = bytes[i]; }
    };
    write_u32(out, 64, info.cbytes);
    write_u32(out, 68, info.qnum);
    write_u32(out, 72, info.qbytes);
    write_i32(out, 76, info.lspid);
    write_i32(out, 80, info.lrpid);
}

/// Write struct semid_ds to kernel memory (72 bytes).
unsafe fn write_semid_ds(out: *mut u8, info: &crate::ipc::SemSetInfo) {
    for i in 0..72 { *out.add(i) = 0; }
    write_ipc_perm(out, info.key, info.uid, info.gid, info.cuid, info.cgid, info.mode, info.seq);
    // 36-39: padding
    write_time(out, 40, info.otime);
    write_time(out, 48, info.ctime);
    // nsems at 56 as u16
    let nsems_bytes = (info.nsems as u16).to_le_bytes();
    *out.add(56) = nsems_bytes[0];
    *out.add(57) = nsems_bytes[1];
}

/// Write struct shmid_ds to kernel memory (88 bytes).
unsafe fn write_shmid_ds(out: *mut u8, info: &crate::ipc::ShmSegInfo) {
    for i in 0..88 { *out.add(i) = 0; }
    write_ipc_perm(out, info.key, info.uid, info.gid, info.cuid, info.cgid, info.mode, info.seq);
    let write_u32 = |ptr: *mut u8, off: usize, val: u32| {
        let bytes = val.to_le_bytes();
        for i in 0..4 { *ptr.add(off + i) = bytes[i]; }
    };
    let write_i32 = |ptr: *mut u8, off: usize, val: i32| {
        let bytes = val.to_le_bytes();
        for i in 0..4 { *ptr.add(off + i) = bytes[i]; }
    };
    write_u32(out, 36, info.segsz);
    write_time(out, 40, info.atime);
    write_time(out, 48, info.dtime);
    write_time(out, 56, info.ctime);
    write_i32(out, 64, info.cpid);
    write_i32(out, 68, info.lpid);
    write_u32(out, 72, info.nattch);
}

// ---------------------------------------------------------------------------
// POSIX mqueue kernel exports
// ---------------------------------------------------------------------------

/// Drain pending mqueue notification. Writes (pid: u32, signo: u32) to out_ptr.
/// Returns 1 if a notification was pending, 0 otherwise.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mq_drain_notification(out_ptr: *mut u8) -> i32 {
    let table = unsafe { crate::mqueue::global_mqueue_table() };
    match table.take_pending_notification() {
        Some(notif) => {
            if !out_ptr.is_null() {
                let pid_bytes = notif.pid.to_le_bytes();
                let signo_bytes = notif.signo.to_le_bytes();
                unsafe {
                    for i in 0..4 { *out_ptr.add(i) = pid_bytes[i]; }
                    for i in 0..4 { *out_ptr.add(4 + i) = signo_bytes[i]; }
                }
            }
            1
        }
        None => 0,
    }
}

/// Check if an fd is a mqueue descriptor.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mq_is_mqd(fd: i32) -> i32 {
    let table = unsafe { crate::mqueue::global_mqueue_table() };
    if table.is_mqd(fd as u32) { 1 } else { 0 }
}

/// Initialize the kernel with a new process.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_init(pid: u32) {
    unsafe {
        *PROCESS.0.get() = Some(Process::new(pid));
    }
}

/// Serialize current process state for fork. Returns bytes written, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_fork_state(buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    match crate::fork::serialize_fork_state(proc, buf) {
        Ok(written) => written as i32,
        Err(e) => -(e as i32),
    }
}

/// Initialize kernel from serialized fork state (child side).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_init_from_fork(buf_ptr: *const u8, buf_len: u32, child_pid: u32) -> i32 {
    let buf = unsafe { core::slice::from_raw_parts(buf_ptr, buf_len as usize) };
    match crate::fork::deserialize_fork_state(buf, child_pid) {
        Ok(proc) => {
            unsafe { *PROCESS.0.get() = Some(proc); }
            0
        }
        Err(e) => -(e as i32),
    }
}

/// Serialize exec-safe state. Returns bytes written on success, negative errno on error.
/// Exec state differs from fork: closes CLOEXEC fds, resets caught signal handlers,
/// preserves pending signals and signal mask.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_exec_state(buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    match crate::fork::serialize_exec_state(proc, buf) {
        Ok(written) => written as i32,
        Err(e) => -(e as i32),
    }
}

/// Initialize kernel from exec state (replaces current process image).
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_init_from_exec(buf_ptr: *const u8, buf_len: u32, pid: u32) -> i32 {
    let buf = unsafe { core::slice::from_raw_parts(buf_ptr, buf_len as usize) };
    match crate::fork::deserialize_exec_state(buf, pid) {
        Ok(proc) => {
            unsafe { *PROCESS.0.get() = Some(proc); }
            0
        }
        Err(e) => -(e as i32),
    }
}

/// Convert a pipe's OFD from kernel-internal to host-delegated.
/// After this, reads/writes for this OFD will go through host_read/host_write.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_convert_pipe_to_host(ofd_idx: u32, new_host_handle: i64) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let ofd = match proc.ofd_table.get_mut(ofd_idx as usize) {
        Some(ofd) => ofd,
        None => return -(Errno::EBADF as i32),
    };
    if ofd.file_type != FileType::Pipe {
        return -(Errno::EINVAL as i32);
    }
    ofd.host_handle = new_host_handle;
    0
}

/// Enumerate pipe OFDs. Writes (ofd_index: u32, host_handle: i64, is_read: u32) tuples to buf.
/// Returns number of pipe OFDs found.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_pipe_ofds(buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let entry_size = 4 + 8 + 4; // ofd_index(u32) + host_handle(i64) + is_read(u32)
    let max_entries = buf.len() / entry_size;
    let mut count = 0usize;

    for (idx, ofd) in proc.ofd_table.iter() {
        if ofd.file_type == FileType::Pipe && count < max_entries {
            let off = count * entry_size;
            buf[off..off + 4].copy_from_slice(&(idx as u32).to_le_bytes());
            buf[off + 4..off + 12].copy_from_slice(&ofd.host_handle.to_le_bytes());
            // Pipes with offset 0 (or flag-based) are write ends; kernel uses
            // positive host_handle index parity to distinguish read/write.
            // Since pipe pairs share the same |host_handle|, we check status_flags
            // for O_WRONLY (bit 0) to determine end.
            let is_read = if ofd.status_flags & 1 == 0 { 1u32 } else { 0u32 };
            buf[off + 12..off + 16].copy_from_slice(&is_read.to_le_bytes());
            count += 1;
        }
    }
    count as i32
}

/// Open a file. Returns fd (>= 0) on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_open(
    path_ptr: *const u8,
    path_len: u32,
    flags: u32,
    mode: u32,
) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_open(proc, &mut host, path, flags, mode) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// mknod — create a regular file node.
/// Only supports S_IFREG (regular files). Creates an empty file via open+close.
fn kernel_mknod(path_ptr: *const u8, path_len: u32, mode: u32) -> i32 {
    use wasm_posix_shared::flags::{O_CREAT, O_EXCL, O_WRONLY};
    let (_gkl, proc) = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let flags = O_CREAT | O_EXCL | O_WRONLY;
    match syscalls::sys_open(proc, &mut host, path, flags, mode) {
        Ok(fd) => {
            let _ = syscalls::sys_close(proc, &mut host, fd);
            0
        }
        Err(e) => -(e as i32),
    }
}

/// mknodat — create a regular file node relative to directory fd.
fn kernel_mknodat(dirfd: i32, path_ptr: *const u8, path_len: u32, mode: u32) -> i32 {
    use wasm_posix_shared::flags::{O_CREAT, O_EXCL, O_WRONLY};
    let (_gkl, proc) = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let flags = O_CREAT | O_EXCL | O_WRONLY;
    match syscalls::sys_openat(proc, &mut host, dirfd, path, flags, mode) {
        Ok(fd) => {
            let _ = syscalls::sys_close(proc, &mut host, fd);
            0
        }
        Err(e) => -(e as i32),
    }
}

/// Close a file descriptor. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_close(fd: i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_close(proc, &mut host, fd) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Read from a file descriptor. Returns bytes read (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_read(fd: i32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_read(proc, &mut host, fd, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Write to a file descriptor. Returns bytes written (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_write(fd: i32, buf_ptr: *const u8, buf_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let buf = unsafe { slice::from_raw_parts(buf_ptr, buf_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_write(proc, &mut host, fd, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Seek within a file. The 64-bit offset is passed as two 32-bit halves
/// because some Wasm host bindings lack native i64 support.
/// Returns the new offset (i64) or negative errno (i64).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_lseek(fd: i32, offset_lo: u32, offset_hi: i32, whence: u32) -> i64 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let offset = ((offset_hi as i64) << 32) | (offset_lo as u64 as i64);
    let result = match syscalls::sys_lseek(proc, &mut host, fd, offset, whence) {
        Ok(pos) => pos,
        Err(e) => -(e as i64),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// pread - read at offset without modifying position. Returns bytes read or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pread(fd: i32, buf_ptr: *mut u8, buf_len: u32, offset_lo: u32, offset_hi: i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let offset = ((offset_hi as i64) << 32) | (offset_lo as u64 as i64);
    let result = match syscalls::sys_pread(proc, &mut host, fd, buf, offset) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// pwrite - write at offset without modifying position. Returns bytes written or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pwrite(fd: i32, buf_ptr: *const u8, buf_len: u32, offset_lo: u32, offset_hi: i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let buf = unsafe { slice::from_raw_parts(buf_ptr, buf_len as usize) };
    let offset = ((offset_hi as i64) << 32) | (offset_lo as u64 as i64);
    let result = match syscalls::sys_pwrite(proc, &mut host, fd, buf, offset) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Duplicate a file descriptor. Returns new fd (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_dup(fd: i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_dup(proc, fd) {
        Ok(new_fd) => new_fd,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Duplicate a file descriptor to a specific target fd.
/// Returns newfd (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_dup2(oldfd: i32, newfd: i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_dup2(proc, &mut host, oldfd, newfd) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Create a pipe. Writes [read_fd, write_fd] to the pointer.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pipe(fildes_ptr: *mut i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_pipe(proc) {
        Ok((read_fd, write_fd)) => {
            unsafe {
                *fildes_ptr = read_fd;
                *fildes_ptr.add(1) = write_fd;
            }
            0
        }
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Duplicate a file descriptor to a specific target fd with flags.
/// Returns newfd (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_dup3(oldfd: i32, newfd: i32, flags: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_dup3(proc, &mut host, oldfd, newfd, flags) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Create a pipe with flags. Writes [read_fd, write_fd] to the pointer.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pipe2(flags: u32, fd_ptr: *mut i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_pipe2(proc, flags) {
        Ok((r, w)) => {
            unsafe {
                *fd_ptr = r;
                *fd_ptr.add(1) = w;
            }
            0
        }
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Create an eventfd file descriptor.
/// Returns fd (>= 0) on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_eventfd2(initval: u32, flags: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_eventfd2(proc, initval, flags) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Create an epoll instance.
/// Returns fd (>= 0) on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_epoll_create1(flags: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_epoll_create1(proc, flags) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Modify an epoll interest list.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_epoll_ctl(epfd: i32, op: i32, fd: i32, event_ptr: *const u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };

    // Read epoll_event struct from memory: { events: u32, data: u64 }
    // On wasm32 without packing, u64 may be at offset 4 or 8 depending on alignment.
    // musl's epoll_event on non-x86_64: events at offset 0 (4B), data at offset 4 (8B) = 12B total.
    // But wasm32 aligns u64 to 8 bytes, so it's likely: events at 0, pad at 4, data at 8 = 16B.
    // We'll try reading from offset 4 (packed) since musl doesn't use __packed__ on non-x86_64.
    // Actually, for epoll_data_t which is a union, the alignment depends on the platform.
    // On wasm32, the union has 4-byte alignment if the ABI is ILP32, making epoll_event 12 bytes.
    let (events, data) = if !event_ptr.is_null() {
        unsafe {
            let events = core::ptr::read_unaligned(event_ptr as *const u32);
            let data = core::ptr::read_unaligned(event_ptr.add(4) as *const u64);
            (events, data)
        }
    } else {
        (0u32, 0u64)
    };

    let result = match syscalls::sys_epoll_ctl(proc, epfd, op, fd, events, data) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Wait for events on an epoll instance.
/// Returns number of ready events (>= 0), or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_epoll_pwait(
    epfd: i32,
    events_ptr: *mut u8,
    maxevents: i32,
    timeout: i32,
    sigmask_ptr: u32,
) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;

    // Read signal mask if provided
    let sigmask = if sigmask_ptr != 0 {
        #[cfg(target_arch = "wasm32")]
        {
            let ptr = sigmask_ptr as *const u64;
            Some(unsafe { *ptr })
        }
        #[cfg(not(target_arch = "wasm32"))]
        { None }
    } else {
        None
    };

    let result = match syscalls::sys_epoll_pwait(proc, &mut host, epfd, maxevents, timeout, sigmask) {
        Ok((count, events)) => {
            // Write events to output buffer
            // Each epoll_event: { events: u32, data: u64 } = 12 bytes (packed on wasm32)
            for (i, (ev, data)) in events.iter().enumerate() {
                let offset = i * 12;
                unsafe {
                    core::ptr::write_unaligned(events_ptr.add(offset) as *mut u32, *ev);
                    core::ptr::write_unaligned(events_ptr.add(offset + 4) as *mut u64, *data);
                }
            }
            count
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Create a timerfd.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_timerfd_create(clock_id: u32, flags: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_timerfd_create(proc, clock_id, flags) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Set or disarm a timerfd timer.
/// new_value_ptr points to itimerspec (32 bytes: interval_sec, interval_nsec, value_sec, value_nsec).
/// old_value_ptr (if non-null) receives the old itimerspec.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_timerfd_settime(fd: i32, flags: u32, new_ptr: *const u8, old_ptr: *mut u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;

    // Read itimerspec: { it_interval: { tv_sec, tv_nsec }, it_value: { tv_sec, tv_nsec } }
    // On wasm32: each field is i64, so 4 x 8 = 32 bytes total
    let (isec, insec, vsec, vnsec) = unsafe {
        let isec = core::ptr::read_unaligned(new_ptr as *const i64);
        let insec = core::ptr::read_unaligned(new_ptr.add(8) as *const i64);
        let vsec = core::ptr::read_unaligned(new_ptr.add(16) as *const i64);
        let vnsec = core::ptr::read_unaligned(new_ptr.add(24) as *const i64);
        (isec, insec, vsec, vnsec)
    };

    let result = match syscalls::sys_timerfd_settime(proc, &mut host, fd, flags, isec, insec, vsec, vnsec) {
        Ok((oisec, oinsec, ovsec, ovnsec)) => {
            if !old_ptr.is_null() {
                unsafe {
                    core::ptr::write_unaligned(old_ptr as *mut i64, oisec);
                    core::ptr::write_unaligned(old_ptr.add(8) as *mut i64, oinsec);
                    core::ptr::write_unaligned(old_ptr.add(16) as *mut i64, ovsec);
                    core::ptr::write_unaligned(old_ptr.add(24) as *mut i64, ovnsec);
                }
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get the remaining time of a timerfd timer.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_timerfd_gettime(fd: i32, cur_ptr: *mut u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;

    let result = match syscalls::sys_timerfd_gettime(proc, &mut host, fd) {
        Ok((isec, insec, vsec, vnsec)) => {
            unsafe {
                core::ptr::write_unaligned(cur_ptr as *mut i64, isec);
                core::ptr::write_unaligned(cur_ptr.add(8) as *mut i64, insec);
                core::ptr::write_unaligned(cur_ptr.add(16) as *mut i64, vsec);
                core::ptr::write_unaligned(cur_ptr.add(24) as *mut i64, vnsec);
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Create or update a signalfd.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_signalfd4(fd: i32, mask_ptr: u32, _sigsetsize: u32, flags: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };

    // Read signal mask from pointer
    let mask = if mask_ptr != 0 {
        #[cfg(target_arch = "wasm32")]
        {
            unsafe { *(mask_ptr as *const u64) }
        }
        #[cfg(not(target_arch = "wasm32"))]
        { 0u64 }
    } else {
        0u64
    };

    let result = match syscalls::sys_signalfd4(proc, fd, mask, flags) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get file status. Writes a `WasmStat` struct to the pointer.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fstat(fd: i32, stat_ptr: *mut u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fstat(proc, &mut host, fd) {
        Ok(stat) => {
            let stat_bytes = unsafe {
                slice::from_raw_parts(
                    &stat as *const WasmStat as *const u8,
                    core::mem::size_of::<WasmStat>(),
                )
            };
            unsafe {
                core::ptr::copy_nonoverlapping(stat_bytes.as_ptr(), stat_ptr, stat_bytes.len());
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// fcntl operations. Returns result (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fcntl(fd: i32, cmd: u32, arg: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_fcntl(proc, fd, cmd, arg) {
        Ok(val) => val,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// fcntl lock operations. The flock struct is read from/written to the pointer.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fcntl_lock(fd: i32, cmd: u32, flock_ptr: *mut u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let flock = unsafe { &mut *(flock_ptr as *mut wasm_posix_shared::WasmFlock) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fcntl_lock(proc, fd, cmd, flock, &mut host) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// BSD flock() — whole-file advisory locking.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_flock(fd: i32, operation: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_flock(proc, fd, operation, &mut host) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Stat a file by path. Writes a `WasmStat` struct to the pointer.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_stat(path_ptr: *const u8, path_len: u32, stat_ptr: *mut u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_stat(proc, &mut host, path) {
        Ok(stat) => {
            let stat_bytes = unsafe {
                slice::from_raw_parts(
                    &stat as *const WasmStat as *const u8,
                    core::mem::size_of::<WasmStat>(),
                )
            };
            unsafe {
                core::ptr::copy_nonoverlapping(stat_bytes.as_ptr(), stat_ptr, stat_bytes.len());
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Lstat a file by path (does not follow symlinks). Writes a `WasmStat` struct.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_lstat(path_ptr: *const u8, path_len: u32, stat_ptr: *mut u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_lstat(proc, &mut host, path) {
        Ok(stat) => {
            let stat_bytes = unsafe {
                slice::from_raw_parts(
                    &stat as *const WasmStat as *const u8,
                    core::mem::size_of::<WasmStat>(),
                )
            };
            unsafe {
                core::ptr::copy_nonoverlapping(stat_bytes.as_ptr(), stat_ptr, stat_bytes.len());
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Create a directory. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mkdir(path_ptr: *const u8, path_len: u32, mode: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_mkdir(proc, &mut host, path, mode) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Remove a directory. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_rmdir(path_ptr: *const u8, path_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_rmdir(proc, &mut host, path) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Unlink (delete) a file. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_unlink(path_ptr: *const u8, path_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_unlink(proc, &mut host, path) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Rename a file. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_rename(
    old_ptr: *const u8,
    old_len: u32,
    new_ptr: *const u8,
    new_len: u32,
) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let oldpath = unsafe { slice::from_raw_parts(old_ptr, old_len as usize) };
    let newpath = unsafe { slice::from_raw_parts(new_ptr, new_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_rename(proc, &mut host, oldpath, newpath) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Create a hard link. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_link(
    old_ptr: *const u8,
    old_len: u32,
    new_ptr: *const u8,
    new_len: u32,
) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let oldpath = unsafe { slice::from_raw_parts(old_ptr, old_len as usize) };
    let newpath = unsafe { slice::from_raw_parts(new_ptr, new_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_link(proc, &mut host, oldpath, newpath) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Create a symbolic link. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_symlink(
    target_ptr: *const u8,
    target_len: u32,
    link_ptr: *const u8,
    link_len: u32,
) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let target = unsafe { slice::from_raw_parts(target_ptr, target_len as usize) };
    let linkpath = unsafe { slice::from_raw_parts(link_ptr, link_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_symlink(proc, &mut host, target, linkpath) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Read a symbolic link. Returns bytes read (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_readlink(
    path_ptr: *const u8,
    path_len: u32,
    buf_ptr: *mut u8,
    buf_len: u32,
) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_readlink(proc, &mut host, path, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Change file permissions. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_chmod(path_ptr: *const u8, path_len: u32, mode: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_chmod(proc, &mut host, path, mode) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Change file ownership. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_chown(path_ptr: *const u8, path_len: u32, uid: u32, gid: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_chown(proc, &mut host, path, uid, gid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Check file accessibility. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_access(path_ptr: *const u8, path_len: u32, amode: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_access(proc, &mut host, path, amode) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Change working directory. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_chdir(path_ptr: *const u8, path_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_chdir(proc, &mut host, path) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Change directory by file descriptor. Returns 0 or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fchdir(fd: i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fchdir(proc, fd) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get current working directory. Returns length written (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getcwd(buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_getcwd(proc, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Open a directory for reading. Returns dir handle (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_opendir(path_ptr: *const u8, path_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_opendir(proc, &mut host, path) {
        Ok(dh) => dh,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Read next directory entry. Returns 1 if entry read, 0 if end, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_readdir(
    dir_handle: i32,
    dirent_ptr: *mut u8,
    name_ptr: *mut u8,
    name_len: u32,
) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let dirent_buf = unsafe {
        slice::from_raw_parts_mut(dirent_ptr, core::mem::size_of::<WasmDirent>())
    };
    let name_buf = unsafe { slice::from_raw_parts_mut(name_ptr, name_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_readdir(proc, &mut host, dir_handle, dirent_buf, name_buf) {
        Ok(n) => n,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Close a directory stream. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_closedir(dir_handle: i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_closedir(proc, &mut host, dir_handle) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Read directory entries in linux_dirent64 format. Returns bytes written or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getdents64(fd: i32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_getdents64(proc, &mut host, fd, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Rewind a directory stream to the beginning. Returns 0 on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_rewinddir(dir_handle: i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_rewinddir(proc, &mut host, dir_handle) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Return current position in a directory stream. Returns position (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_telldir(dir_handle: i32) -> i64 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_telldir(proc, dir_handle) {
        Ok(pos) => pos as i64,
        Err(e) => -(e as i64),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Seek to a position in a directory stream. Returns 0 on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_seekdir(dir_handle: i32, loc_lo: u32, loc_hi: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let loc = (loc_hi as u64) << 32 | (loc_lo as u64);
    let result = match syscalls::sys_seekdir(proc, &mut host, dir_handle, loc) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get the process ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getpid() -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = syscalls::sys_getpid(proc);
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get the parent process ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getppid() -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = syscalls::sys_getppid(proc);
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get the real user ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getuid() -> u32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = syscalls::sys_getuid(proc);
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get the effective user ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_geteuid() -> u32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = syscalls::sys_geteuid(proc);
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get the real group ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getgid() -> u32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = syscalls::sys_getgid(proc);
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get the effective group ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getegid() -> u32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = syscalls::sys_getegid(proc);
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get the process group ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getpgrp() -> u32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = syscalls::sys_getpgrp(proc);
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get the process group ID of a process. Queries the ProcessTable directly
/// (no current-process context needed). Returns pgid on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getpgid_direct(pid: u32) -> i32 {
    if !crate::is_centralized_mode() {
        return -(Errno::ENOSYS as i32);
    }
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    match table.get(pid) {
        Some(proc) => proc.pgid as i32,
        None => -(Errno::ESRCH as i32),
    }
}

/// Set the process group ID. Returns 0 on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setpgid(pid: u32, pgid: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_setpgid(proc, pid, pgid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get the session ID. Returns session ID on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getsid(pid: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_getsid(proc, pid) {
        Ok(sid) => sid as i32,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Create a new session. Returns session ID on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setsid() -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_setsid(proc) {
        Ok(sid) => sid as i32,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Send a signal to a process. Returns 0 on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_kill(pid: i32, sig: u32) -> i32 {
    kernel_kill_with_value(pid, sig, 0)
}

/// Send signal with si_value (for sigqueue/rt_sigqueueinfo).
fn kernel_kill_with_value(pid: i32, sig: u32, si_value: i32) -> i32 {
    use wasm_posix_shared::signal::NSIG;
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;

    // In centralized mode, handle cross-process kill directly via ProcessTable.
    let is_local = pid == proc.pid as i32 || pid == 0 || pid == -(proc.pgid as i32);
    if !is_local && crate::is_centralized_mode() && pid > 0 {
        if sig >= NSIG && sig != 0 {
            deliver_pending_signals(proc, &mut host);
            return -(Errno::EINVAL as i32);
        }
        let table = unsafe { &mut *PROCESS_TABLE.0.get() };
        let result = match table.get_mut(pid as u32) {
            Some(target) => {
                if sig > 0 {
                    target.signals.raise_with_value(sig, si_value);
                    deliver_pending_signals(target, &mut host);
                }
                0
            }
            None => -(Errno::ESRCH as i32),
        };
        deliver_pending_signals(proc, &mut host);
        return result;
    }
    // Centralized mode: kill(-pgid, sig) sends signal to all processes in group |pid|
    if !is_local && crate::is_centralized_mode() && pid < -1 {
        if sig >= NSIG && sig != 0 {
            deliver_pending_signals(proc, &mut host);
            return -(Errno::EINVAL as i32);
        }
        let target_pgid = (-pid) as u32;
        let caller_pid = proc.pid;
        let table = unsafe { &*PROCESS_TABLE.0.get() };
        let pids = table.pids_in_group(target_pgid);
        if pids.is_empty() {
            deliver_pending_signals(proc, &mut host);
            return -(Errno::ESRCH as i32);
        }
        let table = unsafe { &mut *PROCESS_TABLE.0.get() };
        for &target_pid in &pids {
            if let Some(target) = table.get_mut(target_pid) {
                if sig > 0 {
                    target.signals.raise_with_value(sig, si_value);
                    deliver_pending_signals(target, &mut host);
                }
            }
        }
        if let Some(caller) = table.get_mut(caller_pid) {
            deliver_pending_signals(caller, &mut host);
        }
        return 0;
    }

    // Local or traditional mode: use sys_kill (which uses raise, not raise_with_value)
    // For local sigqueue, raise with value on the current process directly
    if si_value != 0 && sig > 0 {
        proc.signals.raise_with_value(sig, si_value);
        deliver_pending_signals(proc, &mut host);
        return 0;
    }
    let result = match syscalls::sys_kill(proc, &mut host, pid, sig) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// sigaltstack — get/set alternate signal stack state.
/// ss_ptr points to stack_t (12 bytes on wasm32: u32 ss_sp, u32 ss_flags, u32 ss_size).
/// oss_ptr receives the previous state (may be null).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sigaltstack(ss_ptr: *const u8, oss_ptr: *mut u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };

    // Write old state to oss_ptr if non-null
    if !oss_ptr.is_null() {
        let buf = unsafe { slice::from_raw_parts_mut(oss_ptr, 12) };
        buf[0..4].copy_from_slice(&proc.alt_stack_sp.to_le_bytes());
        buf[4..8].copy_from_slice(&proc.alt_stack_flags.to_le_bytes());
        buf[8..12].copy_from_slice(&proc.alt_stack_size.to_le_bytes());
    }

    // Read new state from ss_ptr if non-null
    if !ss_ptr.is_null() {
        // POSIX: cannot modify alt stack while executing on it (SS_ONSTACK)
        const SS_ONSTACK: u32 = 1;
        const SS_DISABLE: u32 = 2;
        if proc.alt_stack_flags & SS_ONSTACK != 0 {
            return -(Errno::EPERM as i32);
        }
        let buf = unsafe { slice::from_raw_parts(ss_ptr, 12) };
        let flags = u32::from_le_bytes(buf[4..8].try_into().unwrap());
        if flags & SS_DISABLE != 0 {
            proc.alt_stack_sp = 0;
            proc.alt_stack_flags = SS_DISABLE;
            proc.alt_stack_size = 0;
        } else {
            proc.alt_stack_sp = u32::from_le_bytes(buf[0..4].try_into().unwrap());
            proc.alt_stack_flags = flags;
            proc.alt_stack_size = u32::from_le_bytes(buf[8..12].try_into().unwrap());
        }
    }

    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    0
}

/// Validate a PID exists for sched_* operations (centralized mode).
/// Returns 0 if PID is valid (pid==0 means current process), -ESRCH if not found.
fn kernel_sched_validate_pid(pid: i32) -> i32 {
    if pid == 0 {
        return 0; // pid 0 means current process
    }
    if crate::is_centralized_mode() {
        let table = unsafe { &*PROCESS_TABLE.0.get() };
        if table.get(pid as u32).is_none() {
            return -(Errno::ESRCH as i32);
        }
    }
    0
}

/// sched_getparam — write scheduling parameters (sched_priority = 0) to param_ptr.
/// struct sched_param starts with int sched_priority at offset 0.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sched_getparam(pid: i32, param_ptr: *mut u8) -> i32 {
    if param_ptr.is_null() {
        return -(Errno::EINVAL as i32);
    }
    let validate = kernel_sched_validate_pid(pid);
    if validate < 0 { return validate; }
    // Set sched_priority = 0 (SCHED_OTHER always has priority 0)
    let buf = unsafe { slice::from_raw_parts_mut(param_ptr, 4) };
    buf.copy_from_slice(&0i32.to_le_bytes());
    0
}

/// Deliver a signal from an external source (host). Called by host when
/// another process sends a signal to this one via kill().
/// Returns 0 on success, -EINVAL for invalid signal.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_deliver_signal(sig: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    if sig == 0 || sig >= wasm_posix_shared::signal::NSIG {
        return -(Errno::EINVAL as i32);
    }
    proc.signals.raise(sig);
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    0
}

/// Send a signal to the current process. Returns 0 on success, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_raise(sig: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_raise(proc, &mut host, sig) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Set signal action. act_ptr/oldact_ptr point to structs:
///   [0..4] handler (u32), [4..8] flags (u32), [8..16] mask (u64)
/// If act_ptr is null (0), only reads the old action.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sigaction(sig: u32, act_ptr: *const u8, oldact_ptr: *mut u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };

    // Parse new action from act_ptr (if non-null)
    let (handler_val, flags, mask) = if !act_ptr.is_null() {
        let act = unsafe { core::slice::from_raw_parts(act_ptr, 16) };
        let handler = u32::from_le_bytes([act[0], act[1], act[2], act[3]]);
        let flags = u32::from_le_bytes([act[4], act[5], act[6], act[7]]);
        let mask = u64::from_le_bytes([act[8], act[9], act[10], act[11], act[12], act[13], act[14], act[15]]);
        (handler, flags, mask)
    } else {
        // No new action — just read old
        let old_action = proc.signals.get_action(sig);
        if !oldact_ptr.is_null() {
            let old = unsafe { core::slice::from_raw_parts_mut(oldact_ptr, 16) };
            let h = match old_action.handler {
                crate::signal::SignalHandler::Default => 0u32,
                crate::signal::SignalHandler::Ignore => 1u32,
                crate::signal::SignalHandler::Handler(ptr) => ptr,
            };
            old[0..4].copy_from_slice(&h.to_le_bytes());
            old[4..8].copy_from_slice(&old_action.flags.to_le_bytes());
            old[8..16].copy_from_slice(&old_action.mask.to_le_bytes());
        }
        let mut host = WasmHostIO;
        deliver_pending_signals(proc, &mut host);
        return 0;
    };

    let result = match syscalls::sys_sigaction(proc, sig, handler_val, flags, mask) {
        Ok((old_handler, old_flags, old_mask)) => {
            if !oldact_ptr.is_null() {
                let old = unsafe { core::slice::from_raw_parts_mut(oldact_ptr, 16) };
                old[0..4].copy_from_slice(&old_handler.to_le_bytes());
                old[4..8].copy_from_slice(&old_flags.to_le_bytes());
                old[8..16].copy_from_slice(&old_mask.to_le_bytes());
            }
            0
        }
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// signal() — set signal handler (legacy API). Returns old handler or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_signal(signum: u32, handler: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_signal(proc, signum, handler) {
        Ok(old) => old,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Manipulate the signal mask. The 64-bit set is passed as two 32-bit halves.
/// Returns old mask as i64 (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sigprocmask(how: u32, set_lo: u32, set_hi: u32) -> i64 {
    let (_gkl, proc) = unsafe { get_process() };
    let set = ((set_hi as u64) << 32) | (set_lo as u64);
    let result = match syscalls::sys_sigprocmask(proc, how, set) {
        Ok(old) => old as i64,
        Err(e) => -(e as i64),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get the current time from a clock source.
/// Writes a WasmTimespec struct to ts_ptr.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_clock_gettime(clock_id: u32, ts_ptr: *mut u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_clock_gettime(proc, &mut host, clock_id) {
        Ok(ts) => {
            let ts_bytes = unsafe {
                slice::from_raw_parts(
                    &ts as *const WasmTimespec as *const u8,
                    core::mem::size_of::<WasmTimespec>(),
                )
            };
            unsafe {
                core::ptr::copy_nonoverlapping(ts_bytes.as_ptr(), ts_ptr, ts_bytes.len());
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Sleep for a specified duration.
/// Reads a WasmTimespec struct from req_ptr.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_nanosleep(req_ptr: *const u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let req = unsafe { &*(req_ptr as *const WasmTimespec) };
    let result = match syscalls::sys_nanosleep(proc, &mut host, req) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get clock resolution. Returns 0 or negative errno. Writes WasmTimespec to ts_ptr.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_clock_getres(clock_id: u32, ts_ptr: *mut u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_clock_getres(proc, clock_id) {
        Ok(ts) => {
            if !ts_ptr.is_null() {
                let ts_bytes = unsafe {
                    slice::from_raw_parts(
                        &ts as *const WasmTimespec as *const u8,
                        core::mem::size_of::<WasmTimespec>(),
                    )
                };
                unsafe {
                    core::ptr::copy_nonoverlapping(ts_bytes.as_ptr(), ts_ptr, ts_bytes.len());
                }
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Sleep with clock selection. Returns 0 or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_clock_nanosleep(clock_id: u32, flags: u32, req_ptr: *const u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let req = unsafe { &*(req_ptr as *const WasmTimespec) };
    let result = match syscalls::sys_clock_nanosleep(proc, &mut host, clock_id, flags, req, req_ptr) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Set file timestamps. Returns 0 or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_utimensat(dirfd: i32, path_ptr: *const u8, path_len: u32, times_ptr: *const u8, flags: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let times = if times_ptr.is_null() {
        None
    } else {
        Some(unsafe { &*(times_ptr as *const [WasmTimespec; 2]) })
    };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_utimensat(proc, &mut host, dirfd, path, times, flags) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Remap memory. Returns MAP_FAILED (-1 as u32) since Wasm doesn't support this.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mremap(old_addr: u32, old_len: u32, new_len: u32, flags: u32) -> u32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_mremap(proc, old_addr, old_len, new_len, flags) {
        Ok(addr) => addr,
        Err(e) => (-(e as i32)) as u32,
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Memory advice hint. No-op, returns 0.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_madvise(addr: u32, len: u32, advice: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_madvise(proc, addr, len, advice) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// statfs — get filesystem statistics. Writes WasmStatfs struct to buf_ptr.
/// Returns 0 on success.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_statfs(path_ptr: *const u8, path_len: u32, buf_ptr: *mut u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let _path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let statfs = syscalls::sys_statfs(proc);
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, core::mem::size_of::<wasm_posix_shared::WasmStatfs>()) };
    let bytes = unsafe { core::slice::from_raw_parts(&statfs as *const _ as *const u8, core::mem::size_of::<wasm_posix_shared::WasmStatfs>()) };
    buf.copy_from_slice(bytes);
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    0
}

/// fstatfs — get filesystem statistics for an open fd.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fstatfs(fd: i32, buf_ptr: *mut u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fstatfs(proc, fd) {
        Ok(statfs) => {
            let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, core::mem::size_of::<wasm_posix_shared::WasmStatfs>()) };
            let bytes = unsafe { core::slice::from_raw_parts(&statfs as *const _ as *const u8, core::mem::size_of::<wasm_posix_shared::WasmStatfs>()) };
            buf.copy_from_slice(bytes);
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// setresuid — set real, effective, and saved user IDs.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setresuid(ruid: u32, euid: u32, suid: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_setresuid(proc, ruid, euid, suid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// getresuid — get real, effective, and saved user IDs.
/// Writes three u32 values to the pointers.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getresuid(ruid_ptr: *mut u32, euid_ptr: *mut u32, suid_ptr: *mut u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let (ruid, euid, suid) = syscalls::sys_getresuid(proc);
    unsafe {
        *ruid_ptr = ruid;
        *euid_ptr = euid;
        *suid_ptr = suid;
    }
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    0
}

/// setresgid — set real, effective, and saved group IDs.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setresgid(rgid: u32, egid: u32, sgid: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_setresgid(proc, rgid, egid, sgid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// getresgid — get real, effective, and saved group IDs.
/// Writes three u32 values to the pointers.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getresgid(rgid_ptr: *mut u32, egid_ptr: *mut u32, sgid_ptr: *mut u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let (rgid, egid, sgid) = syscalls::sys_getresgid(proc);
    unsafe {
        *rgid_ptr = rgid;
        *egid_ptr = egid;
        *sgid_ptr = sgid;
    }
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    0
}

/// getgroups — get supplementary group IDs.
/// Returns count on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getgroups(size: u32, list_ptr: *mut u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_getgroups(proc, size) {
        Ok((count, gid)) => {
            if size > 0 {
                unsafe { *list_ptr = gid; }
            }
            count as i32
        }
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// setgroups — set supplementary group IDs (no-op).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setgroups(size: u32, _list_ptr: *const u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_setgroups(proc, size) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Extract SCM_RIGHTS ancillary FDs from msg_control, returning InFlightFd entries.
/// Each FD is looked up in the sender's process and serialized for cross-process delivery.
fn extract_scm_rights(
    proc: &crate::process::Process,
    control_ptr: usize,
    control_len: usize,
) -> Vec<crate::pipe::InFlightFd> {
    use crate::pipe::{InFlightFd, InFlightSocket};
    use crate::socket::{SocketDomain, SocketType, SocketState};
    use wasm_posix_shared::socket::SOL_SOCKET;
    use wasm_posix_shared::socket::SCM_RIGHTS;

    let mut result = Vec::new();
    if control_ptr == 0 || control_len == 0 {
        return result;
    }

    let control = unsafe { slice::from_raw_parts(control_ptr as *const u8, control_len) };

    // Walk cmsg list: each cmsghdr is { cmsg_len: u32, cmsg_level: u32, cmsg_type: u32 }
    // followed by data. Alignment is 4 bytes on wasm32.
    let mut offset = 0;
    while offset + 12 <= control_len {
        let cmsg_len = u32::from_le_bytes([
            control[offset], control[offset + 1], control[offset + 2], control[offset + 3],
        ]) as usize;
        let cmsg_level = u32::from_le_bytes([
            control[offset + 4], control[offset + 5], control[offset + 6], control[offset + 7],
        ]);
        let cmsg_type = u32::from_le_bytes([
            control[offset + 8], control[offset + 9], control[offset + 10], control[offset + 11],
        ]);

        if cmsg_len < 12 || offset + cmsg_len > control_len {
            break;
        }

        if cmsg_level == SOL_SOCKET && cmsg_type == SCM_RIGHTS {
            // Data starts at offset + 12, length = cmsg_len - 12
            let data_len = cmsg_len - 12;
            let num_fds = data_len / 4;
            for i in 0..num_fds {
                let fd_offset = offset + 12 + i * 4;
                let fd_num = i32::from_le_bytes([
                    control[fd_offset], control[fd_offset + 1],
                    control[fd_offset + 2], control[fd_offset + 3],
                ]);

                // Look up this FD in the sender's process
                if let Ok(fd_entry) = proc.fd_table.get(fd_num) {
                    if let Some(ofd) = proc.ofd_table.get(fd_entry.ofd_ref.0) {
                        let mut in_flight = InFlightFd {
                            file_type: match ofd.file_type {
                                crate::ofd::FileType::Pipe => 0,
                                crate::ofd::FileType::Socket => 1,
                                crate::ofd::FileType::Regular => 2,
                                crate::ofd::FileType::Directory => 3,
                                crate::ofd::FileType::CharDevice => 4,
                                crate::ofd::FileType::PtyMaster => 6,
                                crate::ofd::FileType::PtySlave => 7,
                                _ => 5,
                            },
                            status_flags: ofd.status_flags,
                            host_handle: ofd.host_handle,
                            offset: ofd.offset,
                            path: ofd.path.clone(),
                            socket: None,
                        };

                        // For socket FDs, serialize socket state
                        if ofd.file_type == crate::ofd::FileType::Socket {
                            let sock_idx = (-(ofd.host_handle + 1)) as usize;
                            if let Some(sock) = proc.sockets.get(sock_idx) {
                                in_flight.socket = Some(InFlightSocket {
                                    domain: match sock.domain {
                                        SocketDomain::Unix => 0,
                                        SocketDomain::Inet => 1,
                                        SocketDomain::Inet6 => 2,
                                    },
                                    sock_type: match sock.sock_type {
                                        SocketType::Stream => 0,
                                        SocketType::Dgram => 1,
                                    },
                                    protocol: sock.protocol,
                                    state: match sock.state {
                                        SocketState::Unbound => 0,
                                        SocketState::Bound => 1,
                                        SocketState::Listening => 2,
                                        SocketState::Connected => 3,
                                        SocketState::Closed => 4,
                                    },
                                    send_buf_idx: sock.send_buf_idx,
                                    recv_buf_idx: sock.recv_buf_idx,
                                    global_pipes: sock.global_pipes,
                                    shut_rd: sock.shut_rd,
                                    shut_wr: sock.shut_wr,
                                    bind_addr: sock.bind_addr,
                                    bind_port: sock.bind_port,
                                    peer_addr: sock.peer_addr,
                                    peer_port: sock.peer_port,
                                });
                            }
                        }

                        result.push(in_flight);
                    }
                }
            }
        }

        // Advance to next cmsg (aligned to 4 bytes)
        offset += (cmsg_len + 3) & !3;
    }

    result
}

/// sendmsg — send a message on a socket.
/// Parses msghdr to extract iov[0] and delegates to sys_sendmsg.
/// Handles SCM_RIGHTS ancillary data by serializing FDs into the pipe's ancillary queue.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sendmsg(fd: i32, msg_ptr: *const u8, flags: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;

    // Parse msghdr: msg_name(0), msg_namelen(4), msg_iov(8), msg_iovlen(12),
    //               msg_control(16), msg_controllen(20), msg_flags(24)
    let msg = unsafe { slice::from_raw_parts(msg_ptr, 28) };
    let name_ptr = u32::from_le_bytes([msg[0], msg[1], msg[2], msg[3]]) as usize;
    let name_len = u32::from_le_bytes([msg[4], msg[5], msg[6], msg[7]]) as usize;
    let iov_ptr = u32::from_le_bytes([msg[8], msg[9], msg[10], msg[11]]) as usize;
    let iov_len = u32::from_le_bytes([msg[12], msg[13], msg[14], msg[15]]);
    let control_ptr = u32::from_le_bytes([msg[16], msg[17], msg[18], msg[19]]) as usize;
    let control_len = u32::from_le_bytes([msg[20], msg[21], msg[22], msg[23]]) as usize;

    if iov_len == 0 {
        deliver_pending_signals(proc, &mut host);
        return 0;
    }

    // Extract SCM_RIGHTS ancillary FDs before sending data
    let ancillary_fds = extract_scm_rights(proc, control_ptr, control_len);

    // Parse first iovec: iov_base at offset 0, iov_len at offset 4
    let iov = unsafe { slice::from_raw_parts(iov_ptr as *const u8, 8) };
    let base = u32::from_le_bytes([iov[0], iov[1], iov[2], iov[3]]) as usize;
    let len = u32::from_le_bytes([iov[4], iov[5], iov[6], iov[7]]) as usize;

    let buf = unsafe { slice::from_raw_parts(base as *const u8, len) };

    // If msg_name is set, use sendto with the destination address
    let result = if name_ptr != 0 && name_len > 0 {
        let addr = unsafe { slice::from_raw_parts(name_ptr as *const u8, name_len) };
        match syscalls::sys_sendto(proc, &mut host, fd, buf, flags, addr) {
            Ok(n) => n as i32,
            Err(e) => -(e as i32),
        }
    } else {
        match syscalls::sys_sendmsg(proc, &mut host, fd, buf, flags) {
            Ok(n) => n as i32,
            Err(e) => -(e as i32),
        }
    };

    // If data was sent successfully and we have ancillary FDs, push them to the pipe
    if result > 0 && !ancillary_fds.is_empty() {
        // Increment pipe refcounts for socket FDs being passed BEFORE
        // borrowing the send pipe (avoids double &mut borrow of global_pipe_table).
        for in_flight in &ancillary_fds {
            if let Some(ref sock_info) = in_flight.socket {
                if sock_info.global_pipes {
                    let pt = unsafe { crate::pipe::global_pipe_table() };
                    if let Some(idx) = sock_info.send_buf_idx {
                        if let Some(p) = pt.get_mut(idx) {
                            p.add_writer();
                        }
                    }
                    if let Some(idx) = sock_info.recv_buf_idx {
                        if let Some(p) = pt.get_mut(idx) {
                            p.add_reader();
                        }
                    }
                }
            }
        }

        // Now push ancillary data to the socket's send pipe
        if let Ok(fd_entry) = proc.fd_table.get(fd) {
            if let Some(ofd) = proc.ofd_table.get(fd_entry.ofd_ref.0) {
                if ofd.file_type == crate::ofd::FileType::Socket {
                    let sock_idx = (-(ofd.host_handle + 1)) as usize;
                    if let Some(sock) = proc.sockets.get(sock_idx) {
                        if let Some(send_idx) = sock.send_buf_idx {
                            let pipe = if sock.global_pipes {
                                unsafe { crate::pipe::global_pipe_table().get_mut(send_idx) }
                            } else {
                                proc.pipes.get_mut(send_idx).and_then(|p| p.as_mut())
                            };
                            if let Some(pipe) = pipe {
                                pipe.push_ancillary(ancillary_fds);
                            }
                        }
                    }
                }
            }
        }
    }

    deliver_pending_signals(proc, &mut host);
    result
}

/// Install SCM_RIGHTS FDs in the receiver's process, returning the new FD numbers.
fn install_scm_rights_fds(
    proc: &mut crate::process::Process,
    in_flight: Vec<crate::pipe::InFlightFd>,
) -> Vec<i32> {
    use crate::ofd::FileType;
    use crate::socket::{SocketDomain, SocketType, SocketState, SocketInfo};

    let mut new_fds = Vec::new();

    for entry in in_flight {
        match entry.file_type {
            1 => {
                // Socket FD — create new socket in receiver's process
                if let Some(ref sock_data) = entry.socket {
                    let domain = match sock_data.domain {
                        0 => SocketDomain::Unix,
                        1 => SocketDomain::Inet,
                        _ => SocketDomain::Inet6,
                    };
                    let sock_type = match sock_data.sock_type {
                        0 => SocketType::Stream,
                        _ => SocketType::Dgram,
                    };
                    let state = match sock_data.state {
                        0 => SocketState::Unbound,
                        1 => SocketState::Bound,
                        2 => SocketState::Listening,
                        3 => SocketState::Connected,
                        _ => SocketState::Closed,
                    };

                    let mut sock = SocketInfo::new(domain, sock_type, sock_data.protocol);
                    sock.state = state;
                    sock.send_buf_idx = sock_data.send_buf_idx;
                    sock.recv_buf_idx = sock_data.recv_buf_idx;
                    sock.global_pipes = sock_data.global_pipes;
                    sock.shut_rd = sock_data.shut_rd;
                    sock.shut_wr = sock_data.shut_wr;
                    sock.bind_addr = sock_data.bind_addr;
                    sock.bind_port = sock_data.bind_port;
                    sock.peer_addr = sock_data.peer_addr;
                    sock.peer_port = sock_data.peer_port;

                    // Allocate socket slot in receiver
                    let new_sock_idx = proc.sockets.alloc(sock);

                    let new_host_handle = -((new_sock_idx as i64) + 1);
                    let ofd_idx = proc.ofd_table.create(
                        FileType::Socket,
                        entry.status_flags,
                        new_host_handle,
                        entry.path.clone(),
                    );
                    if let Ok(new_fd) = proc.fd_table.alloc(crate::fd::OpenFileDescRef(ofd_idx), 0) {
                        new_fds.push(new_fd);
                    }
                }
            }
            0 => {
                // Pipe FD
                let ofd_idx = proc.ofd_table.create(
                    FileType::Pipe,
                    entry.status_flags,
                    entry.host_handle,
                    entry.path.clone(),
                );
                if let Ok(new_fd) = proc.fd_table.alloc(crate::fd::OpenFileDescRef(ofd_idx), 0) {
                    new_fds.push(new_fd);
                }
            }
            6 | 7 => {
                // PTY master (6) or slave (7) — share by incrementing refs
                let is_master = entry.file_type == 6;
                let file_type = if is_master { FileType::PtyMaster } else { FileType::PtySlave };
                let pty_idx = entry.host_handle as usize;
                if let Some(pty) = crate::pty::get_pty(pty_idx) {
                    if is_master { pty.master_refs += 1; } else { pty.slave_refs += 1; }
                }
                let ofd_idx = proc.ofd_table.create(
                    file_type,
                    entry.status_flags,
                    entry.host_handle,
                    entry.path.clone(),
                );
                if let Ok(new_fd) = proc.fd_table.alloc(crate::fd::OpenFileDescRef(ofd_idx), 0) {
                    new_fds.push(new_fd);
                }
            }
            _ => {
                // Regular file / directory / char device — share via host_handle
                let file_type = match entry.file_type {
                    2 => FileType::Regular,
                    3 => FileType::Directory,
                    4 => FileType::CharDevice,
                    _ => FileType::Regular,
                };
                let ofd_idx = proc.ofd_table.create(
                    file_type,
                    entry.status_flags,
                    entry.host_handle,
                    entry.path.clone(),
                );
                if let Some(ofd) = proc.ofd_table.get_mut(ofd_idx) {
                    ofd.offset = entry.offset;
                }
                if let Ok(new_fd) = proc.fd_table.alloc(crate::fd::OpenFileDescRef(ofd_idx), 0) {
                    new_fds.push(new_fd);
                }
            }
        }
    }

    new_fds
}

/// recvmsg — receive a message from a socket.
/// Parses msghdr to extract iov[0]. For DGRAM sockets, uses recvfrom to fill msg_name.
/// Delivers SCM_RIGHTS ancillary data by installing FDs in the receiver's process.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_recvmsg(fd: i32, msg_ptr: *mut u8, flags: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;

    // Parse msghdr: msg_name(0), msg_namelen(4), msg_iov(8), msg_iovlen(12),
    //               msg_control(16), msg_controllen(20), msg_flags(24)
    let msg = unsafe { slice::from_raw_parts(msg_ptr, 28) };
    let name_ptr = u32::from_le_bytes([msg[0], msg[1], msg[2], msg[3]]) as usize;
    let name_len = u32::from_le_bytes([msg[4], msg[5], msg[6], msg[7]]) as usize;
    let iov_ptr = u32::from_le_bytes([msg[8], msg[9], msg[10], msg[11]]) as usize;
    let iov_len = u32::from_le_bytes([msg[12], msg[13], msg[14], msg[15]]);
    let control_ptr = u32::from_le_bytes([msg[16], msg[17], msg[18], msg[19]]) as usize;
    let control_len = u32::from_le_bytes([msg[20], msg[21], msg[22], msg[23]]) as usize;

    if iov_len == 0 {
        deliver_pending_signals(proc, &mut host);
        return 0;
    }

    // Parse first iovec
    let iov = unsafe { slice::from_raw_parts(iov_ptr as *const u8, 8) };
    let base = u32::from_le_bytes([iov[0], iov[1], iov[2], iov[3]]) as usize;
    let len = u32::from_le_bytes([iov[4], iov[5], iov[6], iov[7]]) as usize;

    let buf = unsafe { slice::from_raw_parts_mut(base as *mut u8, len) };

    // Use recvfrom if msg_name is provided (to fill source address)
    let result = if name_ptr != 0 && name_len > 0 {
        let addr_buf = unsafe { slice::from_raw_parts_mut(name_ptr as *mut u8, name_len) };
        match syscalls::sys_recvfrom(proc, &mut host, fd, buf, flags, addr_buf) {
            Ok((data_len, addr_written)) => {
                // Update msg_namelen with actual address length
                let msg_mut = unsafe { slice::from_raw_parts_mut(msg_ptr, 28) };
                msg_mut[4..8].copy_from_slice(&(addr_written as u32).to_le_bytes());
                data_len as i32
            }
            Err(e) => -(e as i32),
        }
    } else {
        match syscalls::sys_recvmsg(proc, &mut host, fd, buf, flags) {
            Ok(n) => n as i32,
            Err(e) => -(e as i32),
        }
    };

    // Check for SCM_RIGHTS ancillary data on the recv pipe.
    // Pop ancillary data in a limited scope to avoid holding &mut pipe across
    // install_scm_rights_fds (which modifies proc).
    let mut ancillary_delivered = false;
    if result > 0 {
        let popped = 'pop: {
            let (recv_idx, use_global) = {
                let fd_entry = match proc.fd_table.get(fd) {
                    Ok(e) => e,
                    _ => break 'pop None,
                };
                let ofd = match proc.ofd_table.get(fd_entry.ofd_ref.0) {
                    Some(o) if o.file_type == crate::ofd::FileType::Socket => o,
                    _ => break 'pop None,
                };
                let sock_idx = (-(ofd.host_handle + 1)) as usize;
                match proc.sockets.get(sock_idx) {
                    Some(s) => (s.recv_buf_idx, s.global_pipes),
                    None => break 'pop None,
                }
            };
            let recv_idx = match recv_idx {
                Some(i) => i,
                None => break 'pop None,
            };
            let pipe = if use_global {
                unsafe { crate::pipe::global_pipe_table().get_mut(recv_idx) }
            } else {
                proc.pipes.get_mut(recv_idx).and_then(|p| p.as_mut())
            };
            match pipe {
                Some(p) => p.pop_ancillary(),
                None => None,
            }
        };

        if let Some(in_flight) = popped {
            let new_fds = install_scm_rights_fds(proc, in_flight);
            // Build cmsg response in msg_control buffer
            if control_ptr != 0 && control_len > 0 && !new_fds.is_empty() {
                let cmsg_data_len = new_fds.len() * 4;
                let cmsg_len = 12 + cmsg_data_len; // cmsghdr + FD data
                let cmsg_space = (cmsg_len + 3) & !3; // aligned
                if cmsg_space <= control_len {
                    let ctrl = unsafe {
                        slice::from_raw_parts_mut(control_ptr as *mut u8, control_len)
                    };
                    // cmsg_len
                    ctrl[0..4].copy_from_slice(&(cmsg_len as u32).to_le_bytes());
                    // cmsg_level = SOL_SOCKET
                    ctrl[4..8].copy_from_slice(&1u32.to_le_bytes());
                    // cmsg_type = SCM_RIGHTS
                    ctrl[8..12].copy_from_slice(&1u32.to_le_bytes());
                    // FD numbers
                    for (i, &new_fd) in new_fds.iter().enumerate() {
                        let off = 12 + i * 4;
                        ctrl[off..off + 4].copy_from_slice(&new_fd.to_le_bytes());
                    }
                    // Set msg_controllen
                    let msg_mut = unsafe { slice::from_raw_parts_mut(msg_ptr, 28) };
                    msg_mut[20..24].copy_from_slice(&(cmsg_space as u32).to_le_bytes());
                    ancillary_delivered = true;
                }
            }
        }
    }

    if !ancillary_delivered {
        // Zero out msg_controllen to indicate no ancillary data
        let msg_mut = unsafe { slice::from_raw_parts_mut(msg_ptr, 28) };
        msg_mut[20..24].copy_from_slice(&0u32.to_le_bytes());
    }

    deliver_pending_signals(proc, &mut host);
    result
}

/// wait4 — wait for child process. Writes status to wstatus_ptr, ignores rusage.
/// Returns child pid on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_wait4(pid: i32, wstatus_ptr: *mut i32, options: u32, _rusage_ptr: *mut u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_waitpid(proc, &mut host, pid, options) {
        Ok((child_pid, status)) => {
            if !wstatus_ptr.is_null() {
                unsafe { *wstatus_ptr = status; }
            }
            child_pid
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Check if a file descriptor refers to a terminal.
/// Returns 1 if terminal, or negative errno on error (ENOTTY if not a terminal).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_isatty(fd: i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_isatty(proc, fd) {
        Ok(v) => v,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get an environment variable by name.
/// Returns the length of the value on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getenv(
    name_ptr: *const u8,
    name_len: u32,
    buf_ptr: *mut u8,
    buf_len: u32,
) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let name = unsafe { slice::from_raw_parts(name_ptr, name_len as usize) };
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_getenv(proc, name, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Set an environment variable.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setenv(
    name_ptr: *const u8,
    name_len: u32,
    val_ptr: *const u8,
    val_len: u32,
    overwrite: u32,
) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let name = unsafe { slice::from_raw_parts(name_ptr, name_len as usize) };
    let value = unsafe { slice::from_raw_parts(val_ptr, val_len as usize) };
    let result = match syscalls::sys_setenv(proc, name, value, overwrite != 0) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Remove an environment variable.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_unsetenv(name_ptr: *const u8, name_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let name = unsafe { slice::from_raw_parts(name_ptr, name_len as usize) };
    let result = match syscalls::sys_unsetenv(proc, name) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Return the number of environment variables in proc.environ.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_environ_count() -> u32 {
    let (_gkl, proc) = unsafe { get_process() };
    proc.environ.len() as u32
}

/// Read the environment variable at `index` as "KEY=VALUE" into buf.
/// Returns the number of bytes written, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_environ_get(index: u32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let idx = index as usize;
    if idx >= proc.environ.len() {
        return -(Errno::EINVAL as i32);
    }
    let entry = &proc.environ[idx];
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    if buf.len() < entry.len() {
        return -(Errno::ERANGE as i32);
    }
    buf[..entry.len()].copy_from_slice(entry);
    entry.len() as i32
}

// ---------------------------------------------------------------------------
// Argv support — host pushes args, program reads them at startup
// ---------------------------------------------------------------------------

/// Clear all argv entries.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_clear_argv() {
    let (_gkl, proc) = unsafe { get_process() };
    proc.argv.clear();
}

/// Push an argument string. Called by host before _start.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_push_argv(ptr: *const u8, len: u32) {
    let (_gkl, proc) = unsafe { get_process() };
    let data = unsafe { slice::from_raw_parts(ptr, len as usize) };
    proc.argv.push(data.to_vec());
}

/// Return the number of arguments.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_argc() -> u32 {
    let (_gkl, proc) = unsafe { get_process() };
    proc.argv.len() as u32
}

/// Copy argument at `index` into `buf_ptr`. Returns bytes written.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_argv_read(index: u32, buf_ptr: *mut u8, buf_max: u32) -> u32 {
    let (_gkl, proc) = unsafe { get_process() };
    if let Some(arg) = proc.argv.get(index as usize) {
        let len = arg.len().min(buf_max as usize);
        let dst = unsafe { slice::from_raw_parts_mut(buf_ptr, len) };
        dst.copy_from_slice(&arg[..len]);
        len as u32
    } else {
        0
    }
}

/// getrandom — fill buffer with random bytes from the host.
/// Returns number of bytes written, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getrandom(buf_ptr: *mut u8, buf_len: u32, _flags: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let mut host = WasmHostIO;
    let result = match host.host_getrandom(buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// mmap. Returns address or MAP_FAILED (0xFFFFFFFF).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mmap(addr: u32, len: u32, prot: u32, flags: u32, fd: i32, offset_lo: u32, offset_hi: i32) -> u32 {
    let (_gkl, proc) = unsafe { get_process() };
    let offset = ((offset_hi as i64) << 32) | (offset_lo as u64 as i64);
    let result = match syscalls::sys_mmap(proc, addr, len, prot, flags, fd, offset) {
        Ok(a) => a,
        Err(_) => wasm_posix_shared::mmap::MAP_FAILED,
    };

    // Ensure Wasm memory covers the mapped region (skip PROT_NONE mappings
    // which only reserve address space without needing physical backing).
    if result != wasm_posix_shared::mmap::MAP_FAILED && prot != 0 {
        let end = result.saturating_add(len);
        ensure_memory_covers(end);
    }

    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// munmap. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_munmap(addr: u32, len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_munmap(proc, addr, len) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// brk. Returns the current or new program break.
/// Grows Wasm memory if the new break exceeds the current memory size.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_brk(addr: u32) -> u32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = syscalls::sys_brk(proc, addr);

    // Ensure Wasm memory covers the new program break.
    if result > 0 {
        ensure_memory_covers(result);
    }

    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// mprotect. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mprotect(addr: u32, len: u32, prot: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_mprotect(proc, addr, len, prot) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Exit the process. Closes all fds and dir streams, sets state to Exited.
/// For thread workers, just sets exit_status without destroying shared state.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_exit(status: i32) -> ! {
    {
        let (_gkl, proc) = unsafe { get_process() };
        if unsafe { host_is_thread_worker() } != 0 {
            // Thread exit: don't destroy shared process state (FDs, pipes, etc.).
            // Just set exit status and return — the glue will trap via unreachable.
            proc.exit_status = status;
            // Drop GKL guard before trapping
        } else {
            let mut host = WasmHostIO;
            syscalls::sys_exit(proc, &mut host, status);
        }
    } // _gkl dropped here — GKL released
    // Halt execution — musl's _exit loops forever if we just return.
    #[cfg(target_arch = "wasm32")]
    unsafe { core::arch::wasm32::unreachable(); }
    #[cfg(not(target_arch = "wasm32"))]
    unreachable!("kernel_exit should not return");
}

/// Get the exit status of the current process (set by kernel_exit).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_exit_status() -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    proc.exit_status
}

// ---------------------------------------------------------------------------
// Socket and poll exports
// ---------------------------------------------------------------------------

/// Create a socket. Returns fd or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_socket(domain: u32, sock_type: u32, protocol: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_socket(proc, &mut host, domain, sock_type, protocol) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Create a connected pair of sockets. Returns 0 on success, negative errno on error.
/// Writes the two fds to sv_ptr[0] and sv_ptr[1].
#[unsafe(no_mangle)]
pub extern "C" fn kernel_socketpair(domain: u32, sock_type: u32, protocol: u32, sv_ptr: *mut i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_socketpair(proc, &mut host, domain, sock_type, protocol) {
        Ok((fd0, fd1)) => {
            unsafe {
                *sv_ptr = fd0;
                *sv_ptr.add(1) = fd1;
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Bind a socket to an address. Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_bind(fd: i32, addr_ptr: *const u8, addr_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let addr = unsafe { slice::from_raw_parts(addr_ptr, addr_len as usize) };
    let result = match syscalls::sys_bind(proc, fd, addr) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Listen for connections. Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_listen(fd: i32, backlog: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_listen(proc, &mut host, fd, backlog) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Accept a connection with flags. Returns new fd or negative errno.
/// Flags: SOCK_CLOEXEC, SOCK_NONBLOCK (same values as socket()).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_accept4(fd: i32, addr_ptr: *mut u8, addrlen_ptr: *mut u8, flags: u32) -> i32 {
    use wasm_posix_shared::socket::{SOCK_CLOEXEC, SOCK_NONBLOCK};
    use wasm_posix_shared::fd_flags::FD_CLOEXEC;
    use wasm_posix_shared::flags::O_NONBLOCK;

    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_accept(proc, &mut host, fd) {
        Ok(new_fd) => {
            // Apply SOCK_CLOEXEC flag
            if flags & SOCK_CLOEXEC != 0 {
                if let Ok(entry) = proc.fd_table.get_mut(new_fd) {
                    entry.fd_flags |= FD_CLOEXEC;
                }
            }
            // Apply SOCK_NONBLOCK flag
            if flags & SOCK_NONBLOCK != 0 {
                if let Ok(entry) = proc.fd_table.get(new_fd) {
                    if let Some(ofd) = proc.ofd_table.get_mut(entry.ofd_ref.0) {
                        ofd.status_flags |= O_NONBLOCK;
                    }
                }
            }
            // Write peer address if buffers provided
            if !addr_ptr.is_null() && !addrlen_ptr.is_null() {
                let addrlen_buf = unsafe { slice::from_raw_parts_mut(addrlen_ptr, 4) };
                let max_len = u32::from_le_bytes(addrlen_buf.try_into().unwrap_or([0; 4])) as usize;
                // Get the accepted socket's peer address
                let entry = proc.fd_table.get(new_fd);
                if let Ok(entry) = entry {
                    let ofd = proc.ofd_table.get(entry.ofd_ref.0);
                    if let Some(ofd) = ofd {
                        let sock_idx = (-(ofd.host_handle + 1)) as usize;
                        if let Some(sock) = proc.sockets.get(sock_idx) {
                            let mut sa = [0u8; 16];
                            sa[0] = 2; // AF_INET
                            let port_be = sock.peer_port.to_be_bytes();
                            sa[2] = port_be[0];
                            sa[3] = port_be[1];
                            sa[4] = sock.peer_addr[0];
                            sa[5] = sock.peer_addr[1];
                            sa[6] = sock.peer_addr[2];
                            sa[7] = sock.peer_addr[3];
                            let n = max_len.min(16);
                            let addr_buf = unsafe { slice::from_raw_parts_mut(addr_ptr, n) };
                            addr_buf.copy_from_slice(&sa[..n]);
                            addrlen_buf.copy_from_slice(&16u32.to_le_bytes());
                        }
                    }
                }
            } else if !addrlen_ptr.is_null() {
                let buf = unsafe { slice::from_raw_parts_mut(addrlen_ptr, 4) };
                buf.copy_from_slice(&0u32.to_le_bytes());
            }
            new_fd
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Connect to an address. Returns 0 on success, negative errno on error.
///
/// In centralized mode, if the same-process loopback connect fails with
/// ECONNREFUSED, searches ALL processes in the ProcessTable for a matching
/// listener. This enables cross-process loopback (e.g. nginx → php-fpm).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_connect(fd: i32, addr_ptr: *const u8, addr_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let addr = unsafe { slice::from_raw_parts(addr_ptr, addr_len as usize) };
    let result = match syscalls::sys_connect(proc, &mut host, fd, addr) {
        Ok(()) => 0,
        Err(Errno::ECONNREFUSED) if crate::is_centralized_mode() && addr_len >= 8 => {
            // Check if this is a loopback address
            let ip = [addr[4], addr[5], addr[6], addr[7]];
            if ip == [127, 0, 0, 1] {
                // Try cross-process loopback connect
                match cross_process_loopback_connect(proc, fd, addr) {
                    Ok(()) => 0,
                    Err(e) => -(e as i32),
                }
            } else {
                -(Errno::ECONNREFUSED as i32)
            }
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Cross-process loopback TCP connect (centralized mode only).
///
/// Searches all processes in the ProcessTable for a listening socket on the
/// target port, then creates global pipe pairs to connect the two processes.
fn cross_process_loopback_connect(
    proc: &mut Process,
    fd: i32,
    addr: &[u8],
) -> Result<(), Errno> {
    use crate::socket::{SocketDomain, SocketInfo, SocketState, SocketType};
    use crate::pipe::PipeBuffer;

    let port = u16::from_be_bytes([addr[2], addr[3]]);
    let ip = [addr[4], addr[5], addr[6], addr[7]];

    // Get the client socket info
    let entry = proc.fd_table.get(fd)?;
    let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
    let sock_idx = (-(ofd.host_handle + 1)) as usize;

    // For UDP DGRAM connect, just record peer address (no cross-process search needed)
    {
        let sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
        if sock.sock_type == SocketType::Dgram {
            let client = proc.sockets.get_mut(sock_idx).ok_or(Errno::EBADF)?;
            client.state = SocketState::Connected;
            client.peer_addr = ip;
            client.peer_port = port;
            return Ok(());
        }
    }

    // Search ALL processes for a listener on the target port
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let my_pid = proc.pid;

    // Find the listener process and socket index
    let mut listener_pid: Option<u32> = None;
    let mut listener_sock_idx: Option<usize> = None;

    // Iterate all processes in REVERSE pid order (skip self).
    // Prefer highest pid — when parent and child both inherit a listener
    // (e.g. FPM master forks worker), the child (worker) is the one
    // that actually calls accept().
    for (&pid, target_proc) in table.processes.iter().rev() {
        if pid == my_pid {
            continue;
        }
        for idx in 0..target_proc.sockets.len() {
            if let Some(s) = target_proc.sockets.get(idx) {
                if s.state == SocketState::Listening
                    && s.bind_port == port
                    && s.sock_type == SocketType::Stream
                    && (s.bind_addr == [0, 0, 0, 0] || s.bind_addr == [127, 0, 0, 1])
                {
                    listener_pid = Some(pid);
                    listener_sock_idx = Some(idx);
                    break;
                }
            }
        }
        if listener_pid.is_some() {
            break;
        }
    }

    let listener_pid = listener_pid.ok_or(Errno::ECONNREFUSED)?;
    let listener_sock_idx = listener_sock_idx.ok_or(Errno::ECONNREFUSED)?;

    // Allocate two pipe buffers in the GLOBAL pipe table for bidirectional data:
    //   pipe_a: client writes → server reads
    //   pipe_b: server writes → client reads
    let pipe_table = unsafe { crate::pipe::global_pipe_table() };
    let pipe_a_idx = pipe_table.alloc(PipeBuffer::new(65536));
    let pipe_b_idx = pipe_table.alloc(PipeBuffer::new(65536));

    // Get the current process again (table borrow was released)
    let proc = table.get_mut(my_pid).ok_or(Errno::ESRCH)?;

    // Set up client socket (in current process)
    let client_sock = proc.sockets.get(sock_idx).ok_or(Errno::EBADF)?;
    let client_addr = if client_sock.bind_addr == [0; 4] { [127, 0, 0, 1] } else { client_sock.bind_addr };
    let mut client_port = client_sock.bind_port;
    if client_port == 0 {
        client_port = proc.next_ephemeral_port;
        proc.next_ephemeral_port = proc.next_ephemeral_port.wrapping_add(1);
        if proc.next_ephemeral_port == 0 {
            proc.next_ephemeral_port = 49152;
        }
    }

    let client = proc.sockets.get_mut(sock_idx).ok_or(Errno::EBADF)?;
    client.send_buf_idx = Some(pipe_a_idx);
    client.recv_buf_idx = Some(pipe_b_idx);
    client.state = SocketState::Connected;
    client.peer_addr = ip;
    client.peer_port = port;
    client.global_pipes = true; // pipes are in global pipe table
    if client.bind_port == 0 {
        client.bind_port = client_port;
        client.bind_addr = [127, 0, 0, 1];
    }

    // Now set up the accepted socket in the LISTENER's process
    let listener_proc = table.get_mut(listener_pid).ok_or(Errno::ESRCH)?;

    let listener_bind_addr = listener_proc.sockets.get(listener_sock_idx).map(|s| s.bind_addr).unwrap_or([0; 4]);
    let listener_bind_port = listener_proc.sockets.get(listener_sock_idx).map(|s| s.bind_port).unwrap_or(0);

    let mut accepted_sock = SocketInfo::new(SocketDomain::Inet, SocketType::Stream, 0);
    accepted_sock.state = SocketState::Connected;
    accepted_sock.recv_buf_idx = Some(pipe_a_idx); // reads client's writes
    accepted_sock.send_buf_idx = Some(pipe_b_idx); // writes to client's reads
    accepted_sock.bind_addr = listener_bind_addr;
    accepted_sock.bind_port = listener_bind_port;
    accepted_sock.peer_addr = client_addr;
    accepted_sock.peer_port = client_port;
    accepted_sock.global_pipes = true; // pipes are in global pipe table
    let accepted_idx = listener_proc.sockets.alloc(accepted_sock);

    // Push to listener's backlog
    let listener = listener_proc.sockets.get_mut(listener_sock_idx).ok_or(Errno::EBADF)?;
    listener.listen_backlog.push(accepted_idx);

    Ok(())
}

/// Send data on a socket. Returns bytes sent or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_send(fd: i32, buf_ptr: *const u8, buf_len: u32, flags: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let buf = unsafe { slice::from_raw_parts(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_send(proc, &mut host, fd, buf, flags) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Receive data from a socket. Returns bytes received or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_recv(fd: i32, buf_ptr: *mut u8, buf_len: u32, flags: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_recv(proc, &mut host, fd, buf, flags) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Shut down a socket. Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_shutdown(fd: i32, how: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_shutdown(proc, &mut host, fd, how) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get socket option. Returns 0 on success, negative errno on error.
/// Writes the option value to optval_ptr. optlen_ptr points to buffer size
/// on input, receives actual written size on output.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getsockopt(fd: i32, level: u32, optname: u32, optval_ptr: *mut u8, optlen_ptr: *mut u32) -> i32 {
    use wasm_posix_shared::socket::*;
    let (_gkl, proc) = unsafe { get_process() };

    // Handle struct tcp_info (TCP_INFO)
    if level == IPPROTO_TCP && optname == TCP_INFO {
        let result = match syscalls::sys_getsockopt_tcp_info(proc, fd) {
            Ok(info_buf) => {
                let avail = if !optlen_ptr.is_null() {
                    unsafe { *optlen_ptr as usize }
                } else {
                    syscalls::TCP_INFO_SIZE
                };
                let write_len = if avail < syscalls::TCP_INFO_SIZE { avail } else { syscalls::TCP_INFO_SIZE };
                let out = unsafe { slice::from_raw_parts_mut(optval_ptr, write_len) };
                out.copy_from_slice(&info_buf[..write_len]);
                if !optlen_ptr.is_null() {
                    unsafe { *optlen_ptr = write_len as u32; }
                }
                0
            }
            Err(e) => -(e as i32),
        };
        let mut host = WasmHostIO;
        deliver_pending_signals(proc, &mut host);
        return result;
    }

    // Handle struct timeval options (SO_RCVTIMEO, SO_SNDTIMEO)
    if level == SOL_SOCKET && (optname == SO_RCVTIMEO || optname == SO_SNDTIMEO) {
        let result = match syscalls::sys_getsockopt_timeout(proc, fd, optname) {
            Ok(timeout_us) => {
                let tv_sec = (timeout_us / 1_000_000) as i64;
                let tv_usec = (timeout_us % 1_000_000) as i64;
                let buf = unsafe { slice::from_raw_parts_mut(optval_ptr, 16) };
                buf[0..8].copy_from_slice(&tv_sec.to_le_bytes());
                buf[8..16].copy_from_slice(&tv_usec.to_le_bytes());
                if !optlen_ptr.is_null() {
                    unsafe { *optlen_ptr = 16; }
                }
                0
            }
            Err(e) => -(e as i32),
        };
        let mut host = WasmHostIO;
        deliver_pending_signals(proc, &mut host);
        return result;
    }

    let result = match syscalls::sys_getsockopt(proc, fd, level, optname) {
        Ok(val) => {
            // Write as u32 (4 bytes) for int-valued options
            let val_ptr = optval_ptr as *mut u32;
            unsafe { *val_ptr = val; }
            if !optlen_ptr.is_null() {
                unsafe { *optlen_ptr = 4; }
            }
            0
        }
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Set socket option. Returns 0 on success, negative errno on error.
/// optval_ptr points to the option value buffer, optlen is its size.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setsockopt(fd: i32, level: u32, optname: u32, optval_ptr: *const u8, optlen: u32) -> i32 {
    use wasm_posix_shared::socket::*;
    let (_gkl, proc) = unsafe { get_process() };

    // Handle struct timeval options (SO_RCVTIMEO, SO_SNDTIMEO).
    // On wasm32 time64: struct timeval = { i64 tv_sec, i64 tv_usec } = 16 bytes.
    if level == SOL_SOCKET && (optname == SO_RCVTIMEO || optname == SO_SNDTIMEO) {
        if optval_ptr.is_null() || optlen < 16 {
            let mut host = WasmHostIO;
            deliver_pending_signals(proc, &mut host);
            return -(Errno::EINVAL as i32);
        }
        let buf = unsafe { slice::from_raw_parts(optval_ptr, 16) };
        let tv_sec = i64::from_le_bytes(buf[0..8].try_into().unwrap());
        let tv_usec = i64::from_le_bytes(buf[8..16].try_into().unwrap());
        if tv_sec < 0 || tv_usec < 0 || tv_usec >= 1_000_000 {
            let mut host = WasmHostIO;
            deliver_pending_signals(proc, &mut host);
            return -(Errno::EINVAL as i32);
        }
        let timeout_us = (tv_sec as u64) * 1_000_000 + (tv_usec as u64);
        let result = match syscalls::sys_setsockopt_timeout(proc, fd, optname, timeout_us) {
            Ok(()) => 0,
            Err(e) => -(e as i32),
        };
        let mut host = WasmHostIO;
        deliver_pending_signals(proc, &mut host);
        return result;
    }

    // Read first 4 bytes as u32 value (covers most int-valued options)
    let optval = if !optval_ptr.is_null() && optlen >= 4 {
        let buf = unsafe { slice::from_raw_parts(optval_ptr, 4) };
        u32::from_le_bytes(buf.try_into().unwrap())
    } else if !optval_ptr.is_null() && optlen > 0 {
        // For options smaller than 4 bytes, read what we have
        let buf = unsafe { slice::from_raw_parts(optval_ptr, optlen as usize) };
        let mut val_bytes = [0u8; 4];
        val_bytes[..optlen as usize].copy_from_slice(buf);
        u32::from_le_bytes(val_bytes)
    } else {
        0
    };
    let result = match syscalls::sys_setsockopt(proc, fd, level, optname, optval) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Poll file descriptors. Returns number of ready fds, or negative errno.
/// fds_ptr points to an array of WasmPollFd structs (8 bytes each: i32 fd, i16 events, i16 revents).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_poll(fds_ptr: *mut u8, nfds: u32, timeout: i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let fds = unsafe {
        slice::from_raw_parts_mut(fds_ptr as *mut wasm_posix_shared::WasmPollFd, nfds as usize)
    };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_poll(proc, &mut host, fds, timeout) {
        Ok(n) => n,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Send data to a specific address. Returns bytes sent or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sendto(
    fd: i32,
    buf_ptr: *const u8,
    buf_len: u32,
    flags: u32,
    addr_ptr: *const u8,
    addr_len: u32,
) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let buf = unsafe { slice::from_raw_parts(buf_ptr, buf_len as usize) };
    let addr = if addr_ptr.is_null() || addr_len == 0 {
        &[]
    } else {
        unsafe { slice::from_raw_parts(addr_ptr, addr_len as usize) }
    };
    let result = match syscalls::sys_sendto(proc, &mut host, fd, buf, flags, addr) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Receive data with sender address. Returns bytes received or negative errno.
/// Writes sender address to addr_ptr and address length to addr_len_ptr.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_recvfrom(
    fd: i32,
    buf_ptr: *mut u8,
    buf_len: u32,
    flags: u32,
    addr_ptr: *mut u8,
    addrlen_ptr: u32,
) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    // addrlen_ptr is a channel-rewritten pointer to a u32 containing the buffer size
    let addr_len = if addrlen_ptr != 0 {
        unsafe { *(addrlen_ptr as *const u32) }
    } else {
        0
    };
    let addr_buf = if !addr_ptr.is_null() && addr_len > 0 {
        unsafe { slice::from_raw_parts_mut(addr_ptr, addr_len as usize) }
    } else {
        &mut []
    };
    let result = match syscalls::sys_recvfrom(proc, &mut host, fd, buf, flags, addr_buf) {
        Ok((n, actual_addr_len)) => {
            if addrlen_ptr != 0 {
                unsafe { *(addrlen_ptr as *mut u32) = actual_addr_len as u32; }
            }
            n as i32
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// time() - returns seconds since epoch as i64.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_time() -> i64 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_time(proc, &mut host) {
        Ok(t) => t,
        Err(e) => -(e as i64),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// gettimeofday() - writes sec and usec to the given pointers.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_gettimeofday(sec_ptr: *mut i64, usec_ptr: *mut i64) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_gettimeofday(proc, &mut host) {
        Ok((sec, usec)) => {
            unsafe {
                *sec_ptr = sec;
                *usec_ptr = usec;
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// usleep() - sleep for usec microseconds.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_usleep(usec: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_usleep(proc, &mut host, usec) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// openat() - open relative to directory fd.
/// Returns fd on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_openat(dirfd: i32, path_ptr: *const u8, path_len: u32, flags: u32, mode: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_openat(proc, &mut host, dirfd, path, flags, mode) {
        Ok(fd) => fd,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// fstatat() - stat relative to directory fd.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fstatat(dirfd: i32, path_ptr: *const u8, path_len: u32, stat_ptr: *mut u8, flags: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_fstatat(proc, &mut host, dirfd, path, flags) {
        Ok(stat) => {
            let stat_bytes = unsafe {
                slice::from_raw_parts(
                    &stat as *const WasmStat as *const u8,
                    core::mem::size_of::<WasmStat>(),
                )
            };
            unsafe {
                core::ptr::copy_nonoverlapping(stat_bytes.as_ptr(), stat_ptr, stat_bytes.len());
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// unlinkat() - unlink relative to directory fd.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_unlinkat(dirfd: i32, path_ptr: *const u8, path_len: u32, flags: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_unlinkat(proc, &mut host, dirfd, path, flags) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// mkdirat() - mkdir relative to directory fd.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_mkdirat(dirfd: i32, path_ptr: *const u8, path_len: u32, mode: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_mkdirat(proc, &mut host, dirfd, path, mode) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// renameat() - rename relative to directory fds.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_renameat(olddirfd: i32, old_ptr: *const u8, old_len: u32, newdirfd: i32, new_ptr: *const u8, new_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let oldpath = unsafe { slice::from_raw_parts(old_ptr, old_len as usize) };
    let newpath = unsafe { slice::from_raw_parts(new_ptr, new_len as usize) };
    let result = match syscalls::sys_renameat(proc, &mut host, olddirfd, oldpath, newdirfd, newpath) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

// ---------------------------------------------------------------------------
// Terminal / ioctl exports
// ---------------------------------------------------------------------------

/// Get terminal attributes. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_tcgetattr(fd: i32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_tcgetattr(proc, fd, buf) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Set terminal attributes. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_tcsetattr(fd: i32, action: u32, buf_ptr: *const u8, buf_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let buf = unsafe { core::slice::from_raw_parts(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_tcsetattr(proc, fd, action, buf) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Perform an ioctl operation. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ioctl(fd: i32, request: u32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_ioctl(proc, fd, request, buf) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// prctl — process control. Returns 0 on success, or negative errno.
/// buf_ptr is used for PR_SET_NAME (read name from buf) and PR_GET_NAME (write name to buf).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_prctl(option: u32, arg2: u32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_prctl(proc, option, arg2, buf) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Set file creation mask. Returns the previous mask value.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_umask(mask: u32) -> u32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = syscalls::sys_umask(proc, mask);
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get system identification. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_uname(buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_uname(buf) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get configurable system variables. Returns the value on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sysconf(name: i32) -> i64 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_sysconf(name) {
        Ok(val) => val,
        Err(e) => -(e as i64),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Truncate a file to a specified length. Returns 0 on success, or negative errno on error.
/// The 64-bit length is passed as two 32-bit halves for Wasm compatibility.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ftruncate(fd: i32, length_lo: u32, length_hi: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let length = ((length_hi as i64) << 32) | (length_lo as u64 as i64);
    let result = match syscalls::sys_ftruncate(proc, &mut host, fd, length) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Synchronize file state to storage. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fsync(fd: i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fsync(proc, &mut host, fd) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Truncate a file to a specified length (path-based). Returns 0 on success, or negative errno on error.
/// The 64-bit length is passed as two 32-bit halves for Wasm compatibility.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_truncate(path_ptr: *const u8, path_len: u32, length_lo: u32, length_hi: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let length = ((length_hi as i64) << 32) | (length_lo as u64 as i64);
    let result = match syscalls::sys_truncate(proc, &mut host, path, length) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Synchronize file data to storage (alias for fsync). Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fdatasync(fd: i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fdatasync(proc, &mut host, fd) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Change file mode via file descriptor. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fchmod(fd: i32, mode: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fchmod(proc, &mut host, fd, mode) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Change file owner and group via file descriptor. Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fchown(fd: i32, uid: u32, gid: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_fchown(proc, &mut host, fd, uid, gid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Write data from multiple buffers (scatter-gather I/O).
/// iov_ptr points to an array of iovec structs, each 8 bytes: (iov_base: u32, iov_len: u32).
/// Returns total bytes written (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_writev(fd: i32, iov_ptr: *const u8, iovcnt: i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;

    let result = 'done: {
        if iovcnt <= 0 || iovcnt > 1024 {
            break 'done -(Errno::EINVAL as i32);
        }

        let mut total: usize = 0;
        for i in 0..iovcnt as usize {
            let iov = unsafe { iov_ptr.add(i * 8) };
            let base = unsafe {
                u32::from_le_bytes([*iov, *iov.add(1), *iov.add(2), *iov.add(3)])
            };
            let len = unsafe {
                u32::from_le_bytes([*iov.add(4), *iov.add(5), *iov.add(6), *iov.add(7)])
            };

            if len == 0 {
                continue;
            }
            let buf = unsafe { slice::from_raw_parts(base as *const u8, len as usize) };
            match syscalls::sys_write(proc, &mut host, fd, buf) {
                Ok(n) => {
                    total += n;
                    if n < len as usize {
                        break;
                    }
                }
                Err(e) => {
                    if total > 0 {
                        break 'done total as i32;
                    }
                    break 'done -(e as i32);
                }
            }
        }
        total as i32
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Read data into multiple buffers (scatter-gather I/O).
/// iov_ptr points to an array of iovec structs, each 8 bytes: (iov_base: u32, iov_len: u32).
/// Returns total bytes read (>= 0) or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_readv(fd: i32, iov_ptr: *mut u8, iovcnt: i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;

    let result = 'done: {
        if iovcnt <= 0 || iovcnt > 1024 {
            break 'done -(Errno::EINVAL as i32);
        }

        let mut total: usize = 0;
        for i in 0..iovcnt as usize {
            let iov = unsafe { iov_ptr.add(i * 8) };
            let base = unsafe {
                u32::from_le_bytes([*iov, *iov.add(1), *iov.add(2), *iov.add(3)])
            };
            let len = unsafe {
                u32::from_le_bytes([*iov.add(4), *iov.add(5), *iov.add(6), *iov.add(7)])
            };

            if len == 0 {
                continue;
            }
            let buf = unsafe { slice::from_raw_parts_mut(base as *mut u8, len as usize) };
            match syscalls::sys_read(proc, &mut host, fd, buf) {
                Ok(n) => {
                    total += n;
                    if n < len as usize || n == 0 {
                        break;
                    }
                }
                Err(e) => {
                    if total > 0 {
                        break 'done total as i32;
                    }
                    break 'done -(e as i32);
                }
            }
        }
        total as i32
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// preadv -- scatter-gather read at offset.
/// iov_ptr points to iovec array (8 bytes each: base u32, len u32).
/// offset is split into (lo, hi) u32 pair.
/// Returns total bytes read or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_preadv(fd: i32, iov_ptr: *mut u8, iovcnt: i32, offset_lo: u32, offset_hi: i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let offset = ((offset_hi as i64) << 32) | (offset_lo as u64 as i64);

    let result = 'done: {
        if iovcnt <= 0 || iovcnt > 1024 {
            break 'done -(Errno::EINVAL as i32);
        }

        let mut total: usize = 0;
        let mut cur_offset = offset;
        for i in 0..iovcnt as usize {
            let iov = unsafe { iov_ptr.add(i * 8) };
            let base = unsafe {
                u32::from_le_bytes([*iov, *iov.add(1), *iov.add(2), *iov.add(3)])
            };
            let len = unsafe {
                u32::from_le_bytes([*iov.add(4), *iov.add(5), *iov.add(6), *iov.add(7)])
            };

            if len == 0 {
                continue;
            }
            let buf = unsafe { slice::from_raw_parts_mut(base as *mut u8, len as usize) };
            match syscalls::sys_pread(proc, &mut host, fd, buf, cur_offset) {
                Ok(n) => {
                    total += n;
                    cur_offset += n as i64;
                    if n < len as usize || n == 0 {
                        break;
                    }
                }
                Err(e) => {
                    if total > 0 {
                        break 'done total as i32;
                    }
                    break 'done -(e as i32);
                }
            }
        }
        total as i32
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// pwritev -- scatter-gather write at offset.
/// iov_ptr points to iovec array (8 bytes each: base u32, len u32).
/// offset is split into (lo, hi) u32 pair.
/// Returns total bytes written or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pwritev(fd: i32, iov_ptr: *const u8, iovcnt: i32, offset_lo: u32, offset_hi: i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let offset = ((offset_hi as i64) << 32) | (offset_lo as u64 as i64);

    let result = 'done: {
        if iovcnt <= 0 || iovcnt > 1024 {
            break 'done -(Errno::EINVAL as i32);
        }

        let mut total: usize = 0;
        let mut cur_offset = offset;
        for i in 0..iovcnt as usize {
            let iov = unsafe { iov_ptr.add(i * 8) };
            let base = unsafe {
                u32::from_le_bytes([*iov, *iov.add(1), *iov.add(2), *iov.add(3)])
            };
            let len = unsafe {
                u32::from_le_bytes([*iov.add(4), *iov.add(5), *iov.add(6), *iov.add(7)])
            };

            if len == 0 {
                continue;
            }
            let buf = unsafe { slice::from_raw_parts(base as *const u8, len as usize) };
            match syscalls::sys_pwrite(proc, &mut host, fd, buf, cur_offset) {
                Ok(n) => {
                    total += n;
                    cur_offset += n as i64;
                    if n < len as usize {
                        break;
                    }
                }
                Err(e) => {
                    if total > 0 {
                        break 'done total as i32;
                    }
                    break 'done -(e as i32);
                }
            }
        }
        total as i32
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// sendfile -- copy data between file descriptors.
/// offset_ptr points to an i64 offset (or is null to use current position).
/// Returns total bytes copied or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sendfile(out_fd: i32, in_fd: i32, offset_ptr: *mut u8, count: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;

    let offset = if offset_ptr.is_null() {
        -1i64
    } else {
        let bytes = unsafe { slice::from_raw_parts(offset_ptr, 8) };
        i64::from_le_bytes(bytes.try_into().unwrap())
    };

    let result = match syscalls::sys_sendfile(proc, &mut host, out_fd, in_fd, offset, count as usize) {
        Ok(n) => {
            // Update offset_ptr if provided
            if !offset_ptr.is_null() && offset >= 0 {
                let new_offset = offset + n as i64;
                let buf = unsafe { slice::from_raw_parts_mut(offset_ptr, 8) };
                buf.copy_from_slice(&new_offset.to_le_bytes());
            }
            n as i32
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// statx -- extended file stat.
/// Delegates to fstatat and fills the statx buffer from WasmStat.
/// statx struct layout: we write a simplified version compatible with musl expectations.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_statx(
    dirfd: i32,
    path_ptr: *const u8,
    path_len: u32,
    flags: u32,
    mask: u32,
    statx_ptr: *mut u8,
) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };

    let result = match syscalls::sys_statx(proc, &mut host, dirfd, path, flags, mask) {
        Ok(st) => {
            // Fill statx struct (256 bytes)
            // We fill the key fields that musl expects
            let buf = unsafe { slice::from_raw_parts_mut(statx_ptr, 256) };
            // Zero out first
            for b in buf.iter_mut() {
                *b = 0;
            }
            // stx_mask (u32 @ 0): STATX_BASIC_STATS = 0x07ff
            buf[0..4].copy_from_slice(&0x07ffu32.to_le_bytes());
            // stx_blksize (u32 @ 4): default 4096
            buf[4..8].copy_from_slice(&4096u32.to_le_bytes());
            // stx_attributes (u64 @ 8): 0
            // stx_nlink (u32 @ 16)
            buf[16..20].copy_from_slice(&st.st_nlink.to_le_bytes());
            // stx_uid (u32 @ 20)
            buf[20..24].copy_from_slice(&st.st_uid.to_le_bytes());
            // stx_gid (u32 @ 24)
            buf[24..28].copy_from_slice(&st.st_gid.to_le_bytes());
            // stx_mode (u16 @ 28)
            buf[28..30].copy_from_slice(&(st.st_mode as u16).to_le_bytes());
            // stx_ino (u64 @ 32)
            buf[32..40].copy_from_slice(&st.st_ino.to_le_bytes());
            // stx_size (u64 @ 40)
            buf[40..48].copy_from_slice(&st.st_size.to_le_bytes());
            // stx_blocks (u64 @ 48): size / 512
            let blocks = (st.st_size + 511) / 512;
            buf[48..56].copy_from_slice(&blocks.to_le_bytes());
            // stx_attributes_mask (u64 @ 56): 0
            // stx_atime (statx_timestamp @ 64): tv_sec(i64) + tv_nsec(u32) + pad(i32) = 16 bytes
            buf[64..72].copy_from_slice(&st.st_atime_sec.to_le_bytes());
            buf[72..76].copy_from_slice(&st.st_atime_nsec.to_le_bytes());
            // stx_btime (@ 80): 0 (birth time not tracked)
            // stx_ctime (@ 96)
            buf[96..104].copy_from_slice(&st.st_ctime_sec.to_le_bytes());
            buf[104..108].copy_from_slice(&st.st_ctime_nsec.to_le_bytes());
            // stx_mtime (@ 112)
            buf[112..120].copy_from_slice(&st.st_mtime_sec.to_le_bytes());
            buf[120..124].copy_from_slice(&st.st_mtime_nsec.to_le_bytes());
            // stx_rdev_major (u32 @ 128), stx_rdev_minor (u32 @ 132)
            // stx_dev_major (u32 @ 136), stx_dev_minor (u32 @ 140)
            buf[136..140].copy_from_slice(&(st.st_dev as u32).to_le_bytes());
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Get resource limits. Writes soft and hard limits as two u64 LE values (16 bytes) to rlim_ptr.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getrlimit(resource: u32, rlim_ptr: *mut u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_getrlimit(proc, resource) {
        Ok((soft, hard)) => {
            let buf = unsafe { core::slice::from_raw_parts_mut(rlim_ptr, 16) };
            buf[0..8].copy_from_slice(&soft.to_le_bytes());
            buf[8..16].copy_from_slice(&hard.to_le_bytes());
            0
        }
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Set resource limits. Reads soft and hard limits as two u64 LE values (16 bytes) from rlim_ptr.
/// Returns 0 on success, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setrlimit(resource: u32, rlim_ptr: *const u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let buf = unsafe { core::slice::from_raw_parts(rlim_ptr, 16) };
    let soft = u64::from_le_bytes([buf[0], buf[1], buf[2], buf[3], buf[4], buf[5], buf[6], buf[7]]);
    let hard = u64::from_le_bytes([buf[8], buf[9], buf[10], buf[11], buf[12], buf[13], buf[14], buf[15]]);
    let result = match syscalls::sys_setrlimit(proc, resource, soft, hard) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

// ---------------------------------------------------------------------------
// Phase 12: Remaining *at() variants
// ---------------------------------------------------------------------------

/// faccessat — check file accessibility relative to directory fd.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_faccessat(dirfd: i32, path_ptr: *const u8, path_len: u32, amode: u32, flags: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_faccessat(proc, &mut host, dirfd, path, amode, flags) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// fchmodat — change file mode relative to directory fd.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fchmodat(dirfd: i32, path_ptr: *const u8, path_len: u32, mode: u32, flags: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_fchmodat(proc, &mut host, dirfd, path, mode, flags) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// fchownat — change file owner/group relative to directory fd.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fchownat(dirfd: i32, path_ptr: *const u8, path_len: u32, uid: u32, gid: u32, flags: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let result = match syscalls::sys_fchownat(proc, &mut host, dirfd, path, uid, gid, flags) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// linkat — create hard link relative to directory fds.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_linkat(olddirfd: i32, old_ptr: *const u8, old_len: u32, newdirfd: i32, new_ptr: *const u8, new_len: u32, flags: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let oldpath = unsafe { slice::from_raw_parts(old_ptr, old_len as usize) };
    let newpath = unsafe { slice::from_raw_parts(new_ptr, new_len as usize) };
    let result = match syscalls::sys_linkat(proc, &mut host, olddirfd, oldpath, newdirfd, newpath, flags) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// symlinkat — create symbolic link relative to directory fd.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_symlinkat(target_ptr: *const u8, target_len: u32, newdirfd: i32, link_ptr: *const u8, link_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let target = unsafe { slice::from_raw_parts(target_ptr, target_len as usize) };
    let linkpath = unsafe { slice::from_raw_parts(link_ptr, link_len as usize) };
    let result = match syscalls::sys_symlinkat(proc, &mut host, target, newdirfd, linkpath) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// readlinkat — read symbolic link relative to directory fd.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_readlinkat(dirfd: i32, path_ptr: *const u8, path_len: u32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_readlinkat(proc, &mut host, dirfd, path, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

// ---------------------------------------------------------------------------
// Phase 12: select()
// ---------------------------------------------------------------------------

/// select — synchronous I/O multiplexing.
///
/// Each fd_set is 128 bytes (1024 bits). Null pointer means that set is not used.
/// Returns number of ready fds, or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_select(
    nfds: i32,
    readfds_ptr: *mut u8,
    writefds_ptr: *mut u8,
    exceptfds_ptr: *mut u8,
    timeout_ms: i32,
) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };

    let readfds = if readfds_ptr.is_null() {
        None
    } else {
        Some(unsafe { core::slice::from_raw_parts_mut(readfds_ptr, 128) })
    };
    let writefds = if writefds_ptr.is_null() {
        None
    } else {
        Some(unsafe { core::slice::from_raw_parts_mut(writefds_ptr, 128) })
    };
    let exceptfds = if exceptfds_ptr.is_null() {
        None
    } else {
        Some(unsafe { core::slice::from_raw_parts_mut(exceptfds_ptr, 128) })
    };

    let mut host = WasmHostIO;
    let result = match syscalls::sys_select(proc, &mut host, nfds, readfds, writefds, exceptfds, timeout_ms) {
        Ok(n) => n,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

// ---------------------------------------------------------------------------
// Phase 12: setuid/setgid/seteuid/setegid
// ---------------------------------------------------------------------------

/// setuid — set real and effective user ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setuid(uid: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_setuid(proc, uid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// setgid — set real and effective group ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setgid(gid: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_setgid(proc, gid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// seteuid — set effective user ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_seteuid(euid: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_seteuid(proc, euid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// setegid — set effective group ID.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setegid(egid: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_setegid(proc, egid) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

// ---------------------------------------------------------------------------
// Phase 12: getrusage
// ---------------------------------------------------------------------------

/// getrusage — get resource usage. Writes 144-byte rusage struct.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getrusage(who: i32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_getrusage(proc, who, buf) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

// ---------------------------------------------------------------------------
// realpath
// ---------------------------------------------------------------------------

/// realpath — resolve canonical path. Returns bytes written, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_realpath(
    path_ptr: *const u8,
    path_len: u32,
    buf_ptr: *mut u8,
    buf_len: u32,
) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let result = match syscalls::sys_realpath(proc, &mut host, path, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

// ---------------------------------------------------------------------------
// execve
// ---------------------------------------------------------------------------

/// Execute a new program. On success, traps (never returns) because the
/// process image is being replaced asynchronously by the host. On failure,
/// returns negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_execve(path_ptr: *const u8, path_len: u32) -> i32 {
    let result = {
        let (_gkl, proc) = unsafe { get_process() };
        let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
        let mut host = WasmHostIO;
        match syscalls::sys_execve(proc, &mut host, path) {
            Ok(()) => Ok(()),
            Err(e) => {
                deliver_pending_signals(proc, &mut host);
                Err(e)
            }
        }
        // _gkl is dropped here, releasing the Global Kernel Lock
    };

    match result {
        Ok(()) => {
            // Exec succeeded — the host is asynchronously replacing this process
            // image. Trap to stop the current wasm execution immediately.
            // GKL must be released before trapping so subsequent kernel calls
            // (e.g. kernel_get_exec_state) don't deadlock.
            #[cfg(target_arch = "wasm32")]
            unsafe {
                core::arch::wasm32::unreachable();
            }
            #[cfg(not(target_arch = "wasm32"))]
            {
                0
            }
        }
        Err(e) => -(e as i32),
    }
}

/// Execute a new program via file descriptor (fexecve / execveat).
/// Same trap-on-success semantics as kernel_execve.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_execveat(dirfd: i32, path_ptr: *const u8, path_len: u32, flags: u32) -> i32 {
    let result = {
        let (_gkl, proc) = unsafe { get_process() };
        let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
        let mut host = WasmHostIO;
        match syscalls::sys_execveat(proc, &mut host, dirfd, path, flags) {
            Ok(()) => Ok(()),
            Err(e) => {
                deliver_pending_signals(proc, &mut host);
                Err(e)
            }
        }
    };

    match result {
        Ok(()) => {
            #[cfg(target_arch = "wasm32")]
            unsafe {
                core::arch::wasm32::unreachable();
            }
            #[cfg(not(target_arch = "wasm32"))]
            {
                0
            }
        }
        Err(e) => -(e as i32),
    }
}

// ---------------------------------------------------------------------------
// fork (guest-initiated)
// ---------------------------------------------------------------------------

/// Fork the current process. Returns child PID in parent, 0 in child, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fork() -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let host = WasmHostIO;
    match syscalls::sys_fork(proc, &host) {
        Ok(pid) => pid as i32,
        Err(e) => -(e as i32),
    }
}

/// clone — spawn a new thread. Returns child TID in parent, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_clone(
    fn_ptr: u32, stack_ptr: u32, flags: u32, arg: u32,
    ptid_ptr: u32, tls_ptr: u32, ctid_ptr: u32,
) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    match syscalls::sys_clone(proc, &mut host, fn_ptr, stack_ptr, flags, arg, ptid_ptr, tls_ptr, ctid_ptr) {
        Ok(tid) => tid,
        Err(e) => -(e as i32),
    }
}

/// Returns 1 if this process is a fork child (should exec on startup), 0 otherwise.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_is_fork_child() -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    if proc.fork_child { 1 } else { 0 }
}

/// Read the saved fork exec path into buf. Returns bytes written, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_fork_exec_path(buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    match &proc.fork_exec_path {
        Some(path) => {
            let len = path.len().min(buf_len as usize);
            let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, len) };
            buf.copy_from_slice(&path[..len]);
            len as i32
        }
        None => 0,
    }
}

/// Read fork exec argv[idx] into buf. Returns bytes written, 0 if index out of range.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_fork_exec_argv(idx: u32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    match &proc.fork_exec_argv {
        Some(argv) => {
            if (idx as usize) < argv.len() {
                let arg = &argv[idx as usize];
                let len = arg.len().min(buf_len as usize);
                let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, len) };
                buf.copy_from_slice(&arg[..len]);
                len as i32
            } else {
                0
            }
        }
        None => 0,
    }
}

/// Return the number of fork exec argv entries, or 0 if none.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_fork_exec_argc() -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    match &proc.fork_exec_argv {
        Some(argv) => argv.len() as i32,
        None => 0,
    }
}

/// Save exec path and argv to be used after fork in the child.
/// argv is passed as a pointer to an array of (ptr, len) pairs.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_fork_exec(
    path_ptr: *const u8, path_len: u32,
    argv_ptrs: *const u32, argc: u32,
) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let path = unsafe { slice::from_raw_parts(path_ptr, path_len as usize) };
    proc.fork_exec_path = Some(path.to_vec());

    let mut argv = alloc::vec::Vec::new();
    for i in 0..argc {
        let entry_ptr = unsafe { argv_ptrs.add((i * 2) as usize) };
        let arg_ptr = unsafe { *entry_ptr } as *const u8;
        let arg_len = unsafe { *entry_ptr.add(1) } as usize;
        let arg = unsafe { slice::from_raw_parts(arg_ptr, arg_len) };
        argv.push(arg.to_vec());
    }
    proc.fork_exec_argv = Some(argv);
    0
}

/// Add an fd action to apply before exec in fork child.
/// action_type: 0=DUP2(fd1→fd2), 1=CLOSE(fd1), 2=OPEN(fd1, path at fd2 interpreted as ptr+len)
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_fork_fd_action(action_type: u32, fd1: i32, fd2: i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    use crate::process::FdAction;
    match action_type {
        0 => proc.fork_fd_actions.push(FdAction::Dup2 { old_fd: fd1, new_fd: fd2 }),
        1 => proc.fork_fd_actions.push(FdAction::Close { fd: fd1 }),
        _ => return -(wasm_posix_shared::Errno::EINVAL as i32),
    }
    0
}

/// Apply saved fork fd actions (dup2, close). Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_apply_fork_fd_actions() -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let actions: alloc::vec::Vec<_> = proc.fork_fd_actions.drain(..).collect();
    for action in actions {
        match action {
            crate::process::FdAction::Dup2 { old_fd, new_fd } => {
                if let Err(e) = syscalls::sys_dup2(proc, &mut host, old_fd, new_fd) {
                    return -(e as i32);
                }
            }
            crate::process::FdAction::Close { fd } => {
                if let Err(e) = syscalls::sys_close(proc, &mut host, fd) {
                    return -(e as i32);
                }
            }
            crate::process::FdAction::Open { fd, ref path, flags, mode } => {
                match syscalls::sys_open(proc, &mut host, &path, flags as u32, mode as u32) {
                    Ok(opened_fd) => {
                        if opened_fd != fd {
                            if let Err(e) = syscalls::sys_dup2(proc, &mut host, opened_fd, fd) {
                                return -(e as i32);
                            }
                            let _ = syscalls::sys_close(proc, &mut host, opened_fd);
                        }
                    }
                    Err(e) => return -(e as i32),
                }
            }
        }
    }
    // Clear fork_child flag after applying actions
    proc.fork_child = false;
    0
}

/// Clear saved fork exec state (path, argv, fd_actions).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_clear_fork_exec() -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    proc.fork_exec_path = None;
    proc.fork_exec_argv = None;
    proc.fork_fd_actions.clear();
    proc.fork_child = false;
    0
}

/// Set PID/PPID on an existing process (used by asyncify fork to update
/// identity after full memory snapshot restoration without full re-init).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_child_pid(new_pid: u32) {
    let (_gkl, proc) = unsafe { get_process() };
    proc.ppid = proc.pid;
    proc.pid = new_pid;
}

// ---------------------------------------------------------------------------
// alarm
// ---------------------------------------------------------------------------

/// Schedule a SIGALRM after `seconds` seconds.
/// Returns the number of seconds remaining from a previous alarm, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_alarm(seconds: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_alarm(proc, &mut host, seconds) {
        Ok(remaining) => remaining as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

// ---------------------------------------------------------------------------
// setitimer / getitimer
// ---------------------------------------------------------------------------

/// setitimer -- set interval timer.
/// new_ptr points to an array of 4 longs (16 bytes on wasm32):
///   { interval_sec, interval_usec, value_sec, value_usec }
/// This matches musl's time64 path which packs values as long[4].
/// old_ptr receives the previous values as 4 longs (may be null).
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setitimer(which: u32, new_ptr: *const u8, old_ptr: *mut u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;

    // Parse new itimerval from memory (4 x i32 longs on wasm32)
    let (interval_sec, interval_usec, value_sec, value_usec) = if new_ptr.is_null() {
        (0i64, 0i64, 0i64, 0i64)
    } else {
        let new_bytes = unsafe { slice::from_raw_parts(new_ptr, 16) };
        let interval_sec = i32::from_le_bytes(new_bytes[0..4].try_into().unwrap()) as i64;
        let interval_usec = i32::from_le_bytes(new_bytes[4..8].try_into().unwrap()) as i64;
        let value_sec = i32::from_le_bytes(new_bytes[8..12].try_into().unwrap()) as i64;
        let value_usec = i32::from_le_bytes(new_bytes[12..16].try_into().unwrap()) as i64;
        (interval_sec, interval_usec, value_sec, value_usec)
    };

    let result = match syscalls::sys_setitimer(
        proc, &mut host, which,
        interval_sec, interval_usec, value_sec, value_usec,
    ) {
        Ok((old_isec, old_iusec, old_vsec, old_vusec)) => {
            if !old_ptr.is_null() {
                let old_bytes = unsafe { slice::from_raw_parts_mut(old_ptr, 16) };
                old_bytes[0..4].copy_from_slice(&(old_isec as i32).to_le_bytes());
                old_bytes[4..8].copy_from_slice(&(old_iusec as i32).to_le_bytes());
                old_bytes[8..12].copy_from_slice(&(old_vsec as i32).to_le_bytes());
                old_bytes[12..16].copy_from_slice(&(old_vusec as i32).to_le_bytes());
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// getitimer -- get current value of interval timer.
/// curr_ptr receives the current values as 4 longs (16 bytes on wasm32).
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getitimer(which: u32, curr_ptr: *mut u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_getitimer(proc, &mut host, which) {
        Ok((isec, iusec, vsec, vusec)) => {
            if !curr_ptr.is_null() {
                let buf = unsafe { slice::from_raw_parts_mut(curr_ptr, 16) };
                buf[0..4].copy_from_slice(&(isec as i32).to_le_bytes());
                buf[4..8].copy_from_slice(&(iusec as i32).to_le_bytes());
                buf[8..12].copy_from_slice(&(vsec as i32).to_le_bytes());
                buf[12..16].copy_from_slice(&(vusec as i32).to_le_bytes());
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

// ---------------------------------------------------------------------------
// POSIX timers (timer_create / timer_settime / timer_gettime / etc.)
// ---------------------------------------------------------------------------

/// SIGEV_SIGNAL = 0, SIGEV_NONE = 1.
const SIGEV_SIGNAL: u32 = 0;
/// TIMER_ABSTIME flag for timer_settime.
const TIMER_ABSTIME: i32 = 1;

/// timer_create(clock_id, sigevent_ptr, timerid_ptr)
/// musl sends ksigevent = {sigev_value(i32), sigev_signo(i32), sigev_notify(i32), sigev_tid(i32)} = 16 bytes.
/// Returns 0 on success, negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_timer_create(clock_id: u32, sevp_ptr: *const u8, timerid_ptr: *mut i32) -> i32 {
    use crate::process::PosixTimerState;

    let (_gkl, proc) = unsafe { get_process() };

    // Parse sigevent (default: SIGEV_SIGNAL with SIGALRM)
    let (sigev_signo, sigev_value, sigev_notify) = if sevp_ptr.is_null() {
        (14u32, 0i32, SIGEV_SIGNAL) // default: SIGALRM
    } else {
        let buf = unsafe { slice::from_raw_parts(sevp_ptr, 16) };
        let value = i32::from_le_bytes(buf[0..4].try_into().unwrap());
        let signo = i32::from_le_bytes(buf[4..8].try_into().unwrap()) as u32;
        let notify = i32::from_le_bytes(buf[8..12].try_into().unwrap()) as u32;
        (signo, value, notify)
    };

    // Only SIGEV_SIGNAL and SIGEV_NONE are supported
    if sigev_notify != SIGEV_SIGNAL && sigev_notify != 1 {
        return -(Errno::EINVAL as i32);
    }

    // Allocate timer slot
    let timer_id = {
        let mut slot = None;
        for (i, s) in proc.posix_timers.iter().enumerate() {
            if s.is_none() {
                slot = Some(i);
                break;
            }
        }
        match slot {
            Some(i) => i,
            None => {
                let i = proc.posix_timers.len();
                proc.posix_timers.push(None);
                i
            }
        }
    };

    proc.posix_timers[timer_id] = Some(PosixTimerState {
        clock_id,
        sigev_signo,
        sigev_value,
        interval_sec: 0,
        interval_nsec: 0,
        value_sec: 0,
        value_nsec: 0,
        overrun: 0,
    });

    if !timerid_ptr.is_null() {
        unsafe { *timerid_ptr = timer_id as i32; }
    }

    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    0
}

/// timer_settime(timerid, flags, new_value_ptr, old_value_ptr)
/// new/old are itimerspec as 4 × i64 = 32 bytes: {interval_sec, interval_nsec, value_sec, value_nsec}.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_timer_settime(timerid: i32, flags: i32, new_ptr: *const u8, old_ptr: *mut u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;

    let tid = timerid as usize;
    let timer = match proc.posix_timers.get_mut(tid) {
        Some(Some(t)) => t,
        _ => return -(Errno::EINVAL as i32),
    };

    // Write old value if requested
    if !old_ptr.is_null() {
        let buf = unsafe { slice::from_raw_parts_mut(old_ptr, 32) };
        buf[0..8].copy_from_slice(&timer.interval_sec.to_le_bytes());
        buf[8..16].copy_from_slice(&timer.interval_nsec.to_le_bytes());
        buf[16..24].copy_from_slice(&timer.value_sec.to_le_bytes());
        buf[24..32].copy_from_slice(&timer.value_nsec.to_le_bytes());
    }

    // Read new value
    let (int_sec, int_nsec, val_sec, val_nsec) = if new_ptr.is_null() {
        (0i64, 0i64, 0i64, 0i64)
    } else {
        let buf = unsafe { slice::from_raw_parts(new_ptr, 32) };
        (
            i64::from_le_bytes(buf[0..8].try_into().unwrap()),
            i64::from_le_bytes(buf[8..16].try_into().unwrap()),
            i64::from_le_bytes(buf[16..24].try_into().unwrap()),
            i64::from_le_bytes(buf[24..32].try_into().unwrap()),
        )
    };

    timer.interval_sec = int_sec;
    timer.interval_nsec = int_nsec;
    timer.value_sec = val_sec;
    timer.value_nsec = val_nsec;
    timer.overrun = 0;

    // Convert to milliseconds for the host timer.
    // 0 = disarm, 1+ = armed.
    let value_ms;
    if val_sec == 0 && val_nsec == 0 {
        value_ms = 0i64; // disarm
    } else if flags & TIMER_ABSTIME != 0 {
        // Absolute time: compute relative delay from current clock
        let (now_sec, now_nsec) = host.host_clock_gettime(timer.clock_id).unwrap_or((0, 0));
        let diff_sec = val_sec - now_sec;
        let diff_nsec = val_nsec - now_nsec;
        let total_ms = diff_sec * 1000 + diff_nsec / 1_000_000;
        // Minimum 1ms for armed timers
        value_ms = if total_ms < 1 { 1 } else { total_ms };
    } else {
        // Relative time — minimum 1ms for non-zero values
        let ms = val_sec * 1000 + val_nsec / 1_000_000;
        value_ms = if ms < 1 { 1 } else { ms };
    }

    let interval_ms = if int_sec == 0 && int_nsec == 0 {
        0i64
    } else {
        let ms = int_sec * 1000 + int_nsec / 1_000_000;
        if ms < 1 { 1 } else { ms } // minimum 1ms for repeating
    };

    let signo = timer.sigev_signo as i32;
    let _ = host.host_set_posix_timer(timerid, signo, value_ms, interval_ms);

    deliver_pending_signals(proc, &mut host);
    0
}

/// timer_gettime(timerid, curr_value_ptr)
/// Writes current itimerspec (32 bytes) to curr_value_ptr.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_timer_gettime(timerid: i32, curr_ptr: *mut u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;

    let tid = timerid as usize;
    let timer = match proc.posix_timers.get(tid) {
        Some(Some(t)) => t,
        _ => return -(Errno::EINVAL as i32),
    };

    if !curr_ptr.is_null() {
        let buf = unsafe { slice::from_raw_parts_mut(curr_ptr, 32) };
        buf[0..8].copy_from_slice(&timer.interval_sec.to_le_bytes());
        buf[8..16].copy_from_slice(&timer.interval_nsec.to_le_bytes());
        buf[16..24].copy_from_slice(&timer.value_sec.to_le_bytes());
        buf[24..32].copy_from_slice(&timer.value_nsec.to_le_bytes());
    }

    deliver_pending_signals(proc, &mut host);
    0
}

/// timer_getoverrun(timerid)
/// Returns the overrun count on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_timer_getoverrun(timerid: i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;

    let tid = timerid as usize;
    let result = match proc.posix_timers.get(tid) {
        Some(Some(t)) => t.overrun,
        _ => return -(Errno::EINVAL as i32),
    };

    deliver_pending_signals(proc, &mut host);
    result
}

/// timer_delete(timerid)
#[unsafe(no_mangle)]
pub extern "C" fn kernel_timer_delete(timerid: i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;

    let tid = timerid as usize;
    match proc.posix_timers.get(tid) {
        Some(Some(_)) => {}
        _ => return -(Errno::EINVAL as i32),
    }

    // Disarm the host timer
    let _ = host.host_set_posix_timer(timerid, 0, 0, 0);
    proc.posix_timers[tid] = None;

    deliver_pending_signals(proc, &mut host);
    0
}

/// Called by the host when a repeating POSIX timer fires to increment the overrun counter.
/// This is used for timer_getoverrun() support.
#[unsafe(no_mangle)]
/// Called by the host when a POSIX timer's interval fires.
/// If the timer's signal is already pending (blocked), increments overrun and
/// returns 1 (don't send signal again). If not pending, resets overrun to 0
/// and returns 0 (host should call sendSignalToProcess for a new delivery cycle).
pub extern "C" fn kernel_posix_timer_interval_fire(pid: u32, timer_id: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    if let Some(proc) = table.get_mut(pid) {
        if let Some(Some(timer)) = proc.posix_timers.get_mut(timer_id as usize) {
            let signo = timer.sigev_signo as u64;
            if signo > 0 && signo <= 64 {
                let mask = 1u64 << (signo - 1);
                if proc.signals.pending & mask != 0 {
                    // Signal already pending — this is an overrun
                    timer.overrun += 1;
                    return 1;
                } else {
                    // New delivery cycle — reset overrun
                    timer.overrun = 0;
                    return 0;
                }
            }
        }
    }
    0
}

// ---------------------------------------------------------------------------
// sigsuspend
// ---------------------------------------------------------------------------

/// Temporarily replace the signal mask and suspend until a signal is delivered.
/// The mask is passed as two u32 halves (lo, hi) to form a u64.
/// Always returns negative EINTR on success (signal was delivered).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sigsuspend(mask_lo: u32, mask_hi: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let mask = ((mask_hi as u64) << 32) | (mask_lo as u64);
    let result = match syscalls::sys_sigsuspend(proc, &mut host, mask) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// pause -- suspend until a signal is delivered.
/// Always returns negative EINTR.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pause() -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_pause(proc, &mut host) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// rt_sigtimedwait -- wait for a signal from a specified set.
/// mask is passed as (lo, hi) u32 halves. timeout_ms is in milliseconds (-1 for infinite).
/// Returns signal number on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_rt_sigtimedwait(mask_lo: u32, mask_hi: u32, timeout_ms: i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let mask = ((mask_hi as u64) << 32) | (mask_lo as u64);
    let result = match syscalls::sys_sigtimedwait(proc, &mut host, mask, timeout_ms) {
        Ok((sig, _si_value, _si_code)) => sig as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// pathconf -- get configurable pathname variable for a path.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pathconf(path_ptr: u32, path_len: u32, name: i32) -> i64 {
    let (_gkl, proc) = unsafe { get_process() };
    let path = unsafe {
        core::slice::from_raw_parts(path_ptr as *const u8, path_len as usize)
    };
    let result = match syscalls::sys_pathconf(path, name) {
        Ok(v) => v,
        Err(e) => -(e as i64),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// fpathconf -- get configurable pathname variable for an open fd.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_fpathconf(fd: i32, name: i32) -> i64 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_fpathconf(proc, fd, name) {
        Ok(v) => v,
        Err(e) => -(e as i64),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// getsockname -- get local socket address.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getsockname(fd: i32, buf_ptr: u32, addrlen_ptr: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    // addrlen_ptr points to a u32 containing the buffer size (channel-rewritten pointer)
    let addrlen = if addrlen_ptr != 0 {
        unsafe { *(addrlen_ptr as *const u32) }
    } else {
        0
    };
    let buf = unsafe {
        core::slice::from_raw_parts_mut(buf_ptr as *mut u8, addrlen as usize)
    };
    let result = match syscalls::sys_getsockname(proc, fd, buf) {
        Ok(n) => {
            // Write actual addrlen back
            if addrlen_ptr != 0 {
                unsafe { *(addrlen_ptr as *mut u32) = n as u32; }
            }
            0 // getsockname returns 0 on success
        }
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// getpeername -- get remote socket address.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getpeername(fd: i32, buf_ptr: u32, addrlen_ptr: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let addrlen = if addrlen_ptr != 0 {
        unsafe { *(addrlen_ptr as *const u32) }
    } else {
        0
    };
    let buf = unsafe {
        core::slice::from_raw_parts_mut(buf_ptr as *mut u8, addrlen as usize)
    };
    let result = match syscalls::sys_getpeername(proc, fd, buf) {
        Ok(n) => {
            if addrlen_ptr != 0 {
                unsafe { *(addrlen_ptr as *mut u32) = n as u32; }
            }
            0
        }
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Resolve a hostname to an IP address. Returns bytes written or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getaddrinfo(name_ptr: *const u8, name_len: u32, result_ptr: *mut u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let name = unsafe { slice::from_raw_parts(name_ptr, name_len as usize) };
    let result_buf = unsafe { slice::from_raw_parts_mut(result_ptr, 16) };
    match syscalls::sys_getaddrinfo(proc, &mut host, name, result_buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    }
}

// ---------------------------------------------------------------------------
// Thread identity stubs (pre-threading)
// ---------------------------------------------------------------------------

/// gettid — returns pid (tid == pid until threading is implemented).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_gettid() -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    syscalls::sys_gettid(proc)
}

/// set_tid_address — STUB: ignores tidptr, returns pid.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_tid_address(_tidptr: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    syscalls::sys_set_tid_address(proc)
}

/// set_robust_list — stores the robust list head pointer (no-op for now).
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_robust_list(_head: u32, _len: u32) -> i32 {
    match syscalls::sys_set_robust_list() {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    }
}

/// get_robust_list — returns 0 to indicate robust list support.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_robust_list(_pid: u32, _head_ptr: u32, _len_ptr: u32) -> i32 {
    0
}

/// thread_exit — clean up thread state in the kernel.
/// Called by the host when a thread Worker exits.
/// Removes the thread from the process's thread table.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_thread_exit(pid: u32, tid: u32) -> i32 {
    if crate::is_centralized_mode() {
        let pt = unsafe { &mut *PROCESS_TABLE.0.get() };
        if let Some(proc) = pt.get_mut(pid) {
            proc.remove_thread(tid);
        }
    }
    0
}

/// futex — real implementation via host Atomics.wait/notify.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_futex(uaddr: u32, op: u32, val: u32, timeout: u32, uaddr2: u32, val3: u32) -> i32 {
    let _gkl = GklGuard::acquire();
    let mut host = WasmHostIO;
    match syscalls::sys_futex(&mut host, uaddr, op, val, timeout, uaddr2, val3) {
        Ok(n) => n,
        Err(e) => -(e as i32),
    }
}

// ---------------------------------------------------------------------------
// ppoll / pselect6
// ---------------------------------------------------------------------------

/// ppoll — poll with atomic signal mask swap.
/// has_mask: 1 if a signal mask was provided (even if all-zero), 0 if NULL.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ppoll(fds_ptr: *mut u8, nfds: u32, timeout_ms: i32, has_mask: u32, mask_lo: u32, mask_hi: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let fds = unsafe {
        slice::from_raw_parts_mut(fds_ptr as *mut wasm_posix_shared::WasmPollFd, nfds as usize)
    };
    let mask = if has_mask != 0 {
        Some(((mask_hi as u64) << 32) | (mask_lo as u64))
    } else {
        None
    };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_ppoll(proc, &mut host, fds, timeout_ms, mask) {
        Ok(n) => n,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// pselect6 — select with atomic signal mask swap.
/// has_mask: 1 if a signal mask was provided (even if all-zero), 0 if NULL.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pselect6(
    nfds: i32,
    readfds_ptr: *mut u8,
    writefds_ptr: *mut u8,
    exceptfds_ptr: *mut u8,
    timeout_ms: i32,
    has_mask: u32,
    mask_lo: u32,
    mask_hi: u32,
) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };

    let readfds = if readfds_ptr.is_null() {
        None
    } else {
        Some(unsafe { core::slice::from_raw_parts_mut(readfds_ptr, 128) })
    };
    let writefds = if writefds_ptr.is_null() {
        None
    } else {
        Some(unsafe { core::slice::from_raw_parts_mut(writefds_ptr, 128) })
    };
    let exceptfds = if exceptfds_ptr.is_null() {
        None
    } else {
        Some(unsafe { core::slice::from_raw_parts_mut(exceptfds_ptr, 128) })
    };

    let mask = if has_mask != 0 {
        Some(((mask_hi as u64) << 32) | (mask_lo as u64))
    } else {
        None
    };

    let mut host = WasmHostIO;
    let result = match syscalls::sys_pselect6(proc, &mut host, nfds, readfds, writefds, exceptfds, timeout_ms, mask) {
        Ok(n) => n,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

// ---------------------------------------------------------------------------
// TCP bridge exports — used by the host to inject external TCP connections
// into the kernel's pipe-buffer-backed socket system.
// ---------------------------------------------------------------------------

/// Inject an external TCP connection into a listening socket's backlog.
///
/// Called by the host when a real TCP connection arrives. Creates pipe pairs
/// and an accepted socket, mirroring the loopback connect pattern.
///
/// Returns the recv_pipe_idx on success (host derives send_pipe_idx = recv_pipe_idx + 1),
/// or negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_inject_connection(
    pid: u32,
    listener_fd: i32,
    peer_addr_a: u32,
    peer_addr_b: u32,
    peer_addr_c: u32,
    peer_addr_d: u32,
    peer_port: u32,
) -> i32 {
    use crate::pipe::PipeBuffer;
    use crate::socket::{SocketDomain, SocketInfo, SocketState, SocketType};
    use crate::ofd::FileType;

    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let proc = match table.get_mut(pid) {
        Some(p) => p,
        None => return -(Errno::ESRCH as i32),
    };

    // Look up the listener socket via fd
    let entry = match proc.fd_table.get(listener_fd) {
        Ok(e) => e,
        Err(e) => return -(e as i32),
    };
    let ofd = match proc.ofd_table.get(entry.ofd_ref.0) {
        Some(o) => o,
        None => return -(Errno::EBADF as i32),
    };
    if ofd.file_type != FileType::Socket {
        return -(Errno::ENOTSOCK as i32);
    }
    let listener_idx = (-(ofd.host_handle + 1)) as usize;

    let sock = match proc.sockets.get(listener_idx) {
        Some(s) => s,
        None => return -(Errno::EBADF as i32),
    };
    if sock.state != SocketState::Listening {
        return -(Errno::EINVAL as i32);
    }

    let bind_addr = sock.bind_addr;
    let bind_port = sock.bind_port;

    // Allocate two pipe buffers for bidirectional data:
    //   recv_pipe: host writes (incoming TCP data) → process reads
    //   send_pipe: process writes → host reads (outgoing TCP data)
    // Reuse freed consecutive slots to avoid unbounded growth of proc.pipes.
    let (recv_pipe_idx, send_pipe_idx) = proc.alloc_pipe_pair(
        PipeBuffer::new(65536),
        PipeBuffer::new(65536),
    );

    // Create accepted socket with pipe buffers
    let mut accepted_sock = SocketInfo::new(SocketDomain::Inet, SocketType::Stream, 0);
    accepted_sock.state = SocketState::Connected;
    accepted_sock.recv_buf_idx = Some(recv_pipe_idx);
    accepted_sock.send_buf_idx = Some(send_pipe_idx);
    accepted_sock.bind_addr = bind_addr;
    accepted_sock.bind_port = bind_port;
    accepted_sock.peer_addr = [
        peer_addr_a as u8,
        peer_addr_b as u8,
        peer_addr_c as u8,
        peer_addr_d as u8,
    ];
    accepted_sock.peer_port = peer_port as u16;
    let accepted_idx = proc.sockets.alloc(accepted_sock);

    // Push to listener's backlog
    let listener = match proc.sockets.get_mut(listener_idx) {
        Some(s) => s,
        None => return -(Errno::EBADF as i32),
    };
    listener.listen_backlog.push(accepted_idx);

    recv_pipe_idx as i32
}

/// Read data from a pipe buffer into kernel memory.
/// Returns number of bytes read, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pipe_read(pid: u32, pipe_idx: u32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let proc = match table.get_mut(pid) {
        Some(p) => p,
        None => return -(Errno::ESRCH as i32),
    };
    let pipe = match proc.pipes.get_mut(pipe_idx as usize) {
        Some(Some(p)) => p,
        _ => return -(Errno::EBADF as i32),
    };
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    pipe.read(buf) as i32
}

/// Write data from kernel memory into a pipe buffer.
/// Returns number of bytes written, or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pipe_write(pid: u32, pipe_idx: u32, buf_ptr: *const u8, buf_len: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let proc = match table.get_mut(pid) {
        Some(p) => p,
        None => return -(Errno::ESRCH as i32),
    };
    let pipe = match proc.pipes.get_mut(pipe_idx as usize) {
        Some(Some(p)) => p,
        _ => return -(Errno::EBADF as i32),
    };
    let buf = unsafe { slice::from_raw_parts(buf_ptr, buf_len as usize) };
    pipe.write(buf) as i32
}

/// Close the write end of a pipe buffer (signals EOF to the reader).
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pipe_close_write(pid: u32, pipe_idx: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let proc = match table.get_mut(pid) {
        Some(p) => p,
        None => return -(Errno::ESRCH as i32),
    };
    let pipe = match proc.pipes.get_mut(pipe_idx as usize) {
        Some(Some(p)) => p,
        _ => return -(Errno::EBADF as i32),
    };
    pipe.close_write_end();
    // Free the buffer if both endpoints are now closed
    if pipe.is_fully_closed() {
        proc.pipes[pipe_idx as usize] = None;
    }
    0
}

/// Close the read end of a pipe buffer (signals to the writer that nobody is reading).
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pipe_close_read(pid: u32, pipe_idx: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let proc = match table.get_mut(pid) {
        Some(p) => p,
        None => return -(Errno::ESRCH as i32),
    };
    let pipe = match proc.pipes.get_mut(pipe_idx as usize) {
        Some(Some(p)) => p,
        _ => return -(Errno::EBADF as i32),
    };
    pipe.close_read_end();
    // Free the buffer if both endpoints are now closed
    if pipe.is_fully_closed() {
        proc.pipes[pipe_idx as usize] = None;
    }
    0
}

/// Check if a pipe's write end is still open.
/// Returns 1 if open, 0 if closed, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pipe_is_write_open(pid: u32, pipe_idx: u32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let proc = match table.get(pid) {
        Some(p) => p,
        None => return -(Errno::ESRCH as i32),
    };
    let pipe = match proc.pipes.get(pipe_idx as usize) {
        Some(Some(p)) => p,
        _ => return -(Errno::EBADF as i32),
    };
    if pipe.is_write_end_open() { 1 } else { 0 }
}

/// Check if a pipe's read end is still open.
/// Returns 1 if open, 0 if closed, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pipe_is_read_open(pid: u32, pipe_idx: u32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let proc = match table.get(pid) {
        Some(p) => p,
        None => return -(Errno::ESRCH as i32),
    };
    let pipe = match proc.pipes.get(pipe_idx as usize) {
        Some(Some(p)) => p,
        _ => return -(Errno::EBADF as i32),
    };
    if pipe.is_read_end_open() { 1 } else { 0 }
}

/// Look up the recv pipe index for a socket fd.
/// Returns the recv_buf_idx or -1 if the fd is not a connected socket.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_socket_recv_pipe(pid: u32, fd: i32) -> i32 {
    use crate::ofd::FileType;

    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let proc = match table.get(pid) {
        Some(p) => p,
        None => return -1,
    };
    let entry = match proc.fd_table.get(fd) {
        Ok(e) => e,
        Err(_) => return -1,
    };
    let ofd = match proc.ofd_table.get(entry.ofd_ref.0) {
        Some(o) => o,
        None => return -1,
    };
    if ofd.file_type != FileType::Socket {
        return -1;
    }
    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = match proc.sockets.get(sock_idx) {
        Some(s) => s,
        None => return -1,
    };
    match sock.recv_buf_idx {
        Some(idx) => idx as i32,
        None => -1,
    }
}

/// Look up the pipe/buffer index for a fd (for reading).
/// For pipe fds: returns the pipe index.
/// For socket fds: returns recv_buf_idx.
/// Returns -1 if the fd is not a pipe or connected socket.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_fd_pipe_idx(pid: u32, fd: i32) -> i32 {
    use crate::ofd::FileType;

    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let proc = match table.get(pid) {
        Some(p) => p,
        None => return -1,
    };
    let entry = match proc.fd_table.get(fd) {
        Ok(e) => e,
        Err(_) => return -1,
    };
    let ofd = match proc.ofd_table.get(entry.ofd_ref.0) {
        Some(o) => o,
        None => return -1,
    };
    match ofd.file_type {
        FileType::Pipe if ofd.host_handle < 0 => {
            (-(ofd.host_handle + 1)) as i32
        }
        FileType::Socket => {
            let sock_idx = (-(ofd.host_handle + 1)) as usize;
            match proc.sockets.get(sock_idx) {
                Some(sock) => match sock.recv_buf_idx {
                    Some(idx) => idx as i32,
                    None => -1,
                },
                None => -1,
            }
        }
        _ => -1,
    }
}

/// Check if a file descriptor has O_NONBLOCK set.
/// Returns 1 if non-blocking, 0 if blocking, -1 if fd not found.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_is_fd_nonblock(pid: u32, fd: i32) -> i32 {
    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let proc = match table.get(pid) {
        Some(p) => p,
        None => return -1,
    };
    let entry = match proc.fd_table.get(fd) {
        Ok(e) => e,
        Err(_) => return -1,
    };
    let ofd = match proc.ofd_table.get(entry.ofd_ref.0) {
        Some(o) => o,
        None => return -1,
    };
    if ofd.status_flags & wasm_posix_shared::flags::O_NONBLOCK != 0 { 1 } else { 0 }
}

/// Get socket timeout in milliseconds for a fd.
/// is_recv: 1 = SO_RCVTIMEO, 0 = SO_SNDTIMEO.
/// Returns timeout in ms, 0 if no timeout, -1 if fd is not a socket.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_socket_timeout_ms(pid: u32, fd: i32, is_recv: i32) -> i64 {
    use crate::ofd::FileType;

    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let proc = match table.get(pid) {
        Some(p) => p,
        None => return -1,
    };
    let entry = match proc.fd_table.get(fd) {
        Ok(e) => e,
        Err(_) => return -1,
    };
    let ofd = match proc.ofd_table.get(entry.ofd_ref.0) {
        Some(o) => o,
        None => return -1,
    };
    if ofd.file_type != FileType::Socket {
        return -1;
    }
    let sock_idx = (-(ofd.host_handle + 1)) as usize;
    let sock = match proc.sockets.get(sock_idx) {
        Some(s) => s,
        None => return -1,
    };
    let timeout_us = if is_recv != 0 { sock.recv_timeout_us } else { sock.send_timeout_us };
    // Convert microseconds to milliseconds (round up to avoid 0ms for non-zero timeouts)
    if timeout_us == 0 {
        0
    } else {
        ((timeout_us + 999) / 1000) as i64
    }
}

/// Look up the send pipe/buffer index for a fd (for writing).
/// For pipe fds: returns the pipe index.
/// For socket fds: returns send_buf_idx.
/// Returns -1 if the fd is not a pipe or connected socket.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_get_fd_send_pipe_idx(pid: u32, fd: i32) -> i32 {
    use crate::ofd::FileType;

    let table = unsafe { &*PROCESS_TABLE.0.get() };
    let proc = match table.get(pid) {
        Some(p) => p,
        None => return -1,
    };
    let entry = match proc.fd_table.get(fd) {
        Ok(e) => e,
        Err(_) => return -1,
    };
    let ofd = match proc.ofd_table.get(entry.ofd_ref.0) {
        Some(o) => o,
        None => return -1,
    };
    match ofd.file_type {
        FileType::Pipe if ofd.host_handle < 0 => {
            (-(ofd.host_handle + 1)) as i32
        }
        FileType::Socket => {
            let sock_idx = (-(ofd.host_handle + 1)) as usize;
            match proc.sockets.get(sock_idx) {
                Some(sock) => match sock.send_buf_idx {
                    Some(idx) => idx as i32,
                    None => -1,
                },
                None => -1,
            }
        }
        _ => -1,
    }
}

// ── PTY host exports ──
// These exports allow the host to create and drive PTY pairs from outside
// the kernel's syscall channel (e.g. for browser xterm.js integration).

/// Create a PTY pair and wire fds 0/1/2 of `pid` to the slave side.
/// Returns the PTY index on success, or negative errno on failure.
///
/// This replaces the default CharDevice stdin/stdout/stderr with a PtySlave
/// so that `isatty()` returns true and the process gets a real terminal.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pty_create(pid: u32) -> i32 {
    use crate::fd::OpenFileDescRef;
    use crate::ofd::FileType;
    use wasm_posix_shared::flags::O_RDWR;

    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let proc = match table.get_mut(pid) {
        Some(p) => p,
        None => return -(Errno::ESRCH as i32),
    };

    // Allocate a new PTY pair
    let pty_idx = match crate::pty::alloc_pty() {
        Some(idx) => idx,
        None => return -(Errno::ENOSPC as i32),
    };

    // Configure the PTY pair
    let pty = crate::pty::get_pty(pty_idx).unwrap();
    pty.locked = false; // unlockpt equivalent
    pty.slave_refs = 1; // one OFD references the slave
    pty.master_refs = 1; // host holds the master side

    // Set controlling terminal
    pty.terminal.session_id = pid as i32;
    pty.terminal.foreground_pgid = pid as i32;

    // Create a PtySlave OFD. host_handle stores pty_idx for the kernel's
    // read/write handlers to find the right PTY pair.
    let path = {
        extern crate alloc;
        use alloc::format;
        format!("/dev/pts/{}", pty_idx).into_bytes()
    };
    let ofd_idx = proc.ofd_table.create(FileType::PtySlave, O_RDWR, pty_idx as i64, path);

    // Close the existing CharDevice OFDs for fds 0, 1, 2
    for fd in 0..3i32 {
        if let Ok(entry) = proc.fd_table.get(fd) {
            let old_ofd_ref = entry.ofd_ref.0;
            proc.ofd_table.dec_ref(old_ofd_ref);
        }
    }

    // Point fds 0, 1, 2 to the shared PtySlave OFD (ref_count = 3)
    // The OFD was created with ref_count=1, so inc_ref twice more
    proc.ofd_table.inc_ref(ofd_idx);
    proc.ofd_table.inc_ref(ofd_idx);
    let _ = proc.fd_table.set_at(0, OpenFileDescRef(ofd_idx), 0);
    let _ = proc.fd_table.set_at(1, OpenFileDescRef(ofd_idx), 0);
    let _ = proc.fd_table.set_at(2, OpenFileDescRef(ofd_idx), 0);

    // Set the session ID on the process itself
    proc.sid = pid;

    pty_idx as i32
}

/// Write data from the host (master side) to a PTY's input, processing
/// it through the line discipline. Returns bytes consumed.
///
/// If ISIG is enabled and a signal character is received (Ctrl-C, Ctrl-\,
/// Ctrl-Z), the corresponding signal is raised on the foreground process group.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pty_master_write(pty_idx: u32, buf_ptr: *const u8, buf_len: u32) -> i32 {
    let pty = match crate::pty::get_pty(pty_idx as usize) {
        Some(p) => p,
        None => return -(Errno::ENOENT as i32),
    };

    let data = unsafe { core::slice::from_raw_parts(buf_ptr, buf_len as usize) };

    // Collect signals generated by ISIG processing.
    // We need the foreground pgid from the PTY before we borrow the process table.
    let mut pending_signals: [(u32, i32); 3] = [(0, 0); 3];
    let mut signal_count = 0usize;

    for &byte in data {
        if let Some(signum) = pty.process_master_input(byte) {
            let fg_pgid = pty.terminal.foreground_pgid;
            if signal_count < pending_signals.len() {
                pending_signals[signal_count] = (signum, fg_pgid);
                signal_count += 1;
            }
        }
    }

    // Deliver any signals to the foreground process group (same pattern as SIGWINCH).
    if signal_count > 0 {
        let table = unsafe { &mut *PROCESS_TABLE.0.get() };
        for i in 0..signal_count {
            let (signum, fg_pgid) = pending_signals[i];
            if fg_pgid > 0 {
                let pids = table.pids_in_group(fg_pgid as u32);
                for pid in pids {
                    if let Some(proc) = table.get_mut(pid) {
                        proc.signals.raise(signum);
                    }
                }
            }
        }
    }

    // After writing input, wake any slave reader by ensuring data is available.
    // The host is responsible for calling scheduleWakeBlockedRetries().
    buf_len as i32
}

/// Read data from the PTY output buffer (master side reads slave's output).
/// Returns bytes read, or 0 if the output buffer is empty.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pty_master_read(pty_idx: u32, buf_ptr: *mut u8, buf_len: u32) -> i32 {
    let pty = match crate::pty::get_pty(pty_idx as usize) {
        Some(p) => p,
        None => return -(Errno::ENOENT as i32),
    };

    let buf = unsafe { core::slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    pty.master_read(buf) as i32
}

/// Set the window size of a PTY and send SIGWINCH to the foreground process group.
/// Returns 0 on success, negative errno on failure.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pty_set_winsize(pty_idx: u32, rows: u32, cols: u32) -> i32 {
    let pty = match crate::pty::get_pty(pty_idx as usize) {
        Some(p) => p,
        None => return -(Errno::ENOENT as i32),
    };

    pty.terminal.winsize = crate::terminal::WinSize {
        ws_row: rows as u16,
        ws_col: cols as u16,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    // Send SIGWINCH to foreground process group
    let fg_pgid = pty.terminal.foreground_pgid;
    if fg_pgid > 0 {
        let table = unsafe { &mut *PROCESS_TABLE.0.get() };
        let pids = table.pids_in_group(fg_pgid as u32);
        for pid in pids {
            if let Some(proc) = table.get_mut(pid) {
                proc.signals.raise(wasm_posix_shared::signal::SIGWINCH);
            }
        }
    }

    0
}

// ---------------------------------------------------------------------------
// Wakeup event drain
// ---------------------------------------------------------------------------

/// Drain pending wakeup events into the output buffer.
///
/// Each event is 5 bytes: pipe_idx (u32 LE) + wake_type (u8).
/// Returns the number of events written.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_drain_wakeup_events(out_ptr: *mut u8, out_len: u32, max_events: u32) -> u32 {
    let out = unsafe { slice::from_raw_parts_mut(out_ptr, out_len as usize) };
    crate::wakeup::drain(out, max_events)
}

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

use core::slice;

use wasm_posix_shared::{Errno, WasmDirent, WasmStat, WasmTimespec};

use crate::ofd::FileType;
use crate::process::{HostIO, Process};
use crate::syscalls;

// ---------------------------------------------------------------------------
// 1. Host function imports
// ---------------------------------------------------------------------------

#[link(wasm_import_module = "env")]
unsafe extern "C" {
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
    fn host_sigsuspend_wait() -> i32;
    fn host_call_signal_handler(handler_index: u32, signum: u32) -> i32;
    fn host_getrandom(buf_ptr: *mut u8, buf_len: u32) -> i32;
    fn host_utimensat(path_ptr: *const u8, path_len: u32, atime_sec: i64, atime_nsec: i64, mtime_sec: i64, mtime_nsec: i64) -> i32;
    fn host_waitpid(pid: i32, options: u32, status_ptr: *mut i32) -> i32;
    fn host_net_connect(handle: i32, addr_ptr: *const u8, addr_len: u32, port: u32) -> i32;
    fn host_net_send(handle: i32, buf_ptr: *const u8, buf_len: u32, flags: u32) -> i32;
    fn host_net_recv(handle: i32, buf_ptr: *mut u8, buf_len: u32, flags: u32) -> i32;
    fn host_net_close(handle: i32) -> i32;
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
    // SysV IPC
    fn host_ipc_msgget(key: i32, flags: i32) -> i32;
    fn host_ipc_msgsnd(qid: i32, msg_ptr: i32, msg_sz: i32, flags: i32) -> i32;
    fn host_ipc_msgrcv(qid: i32, msg_ptr: i32, msg_sz: i32, msgtyp: i32, flags: i32) -> i32;
    fn host_ipc_msgctl(qid: i32, cmd: i32, buf_ptr: i32) -> i32;
    fn host_ipc_semget(key: i32, nsems: i32, flags: i32) -> i32;
    fn host_ipc_semop(semid: i32, sops_ptr: i32, nsops: i32) -> i32;
    fn host_ipc_semctl(semid: i32, semnum: i32, cmd: i32, arg: i32) -> i32;
    fn host_ipc_shmget(key: i32, size: i32, flags: i32) -> i32;
    fn host_ipc_shmat(shmid: i32, shmaddr: i32, flags: i32) -> i32;
    fn host_ipc_shmdt(addr: i32) -> i32;
    fn host_ipc_shmctl(shmid: i32, cmd: i32, buf_ptr: i32) -> i32;
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

    fn host_call_signal_handler(&mut self, handler_index: u32, signum: u32) -> Result<(), Errno> {
        let result = unsafe { host_call_signal_handler(handler_index, signum) };
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
    while let Some(signum) = proc.signals.dequeue() {
        if proc.state == crate::process::ProcessState::Exited {
            break;
        }
        match proc.signals.get_handler(signum) {
            SignalHandler::Handler(idx) => {
                let _ = host.host_call_signal_handler(idx, signum);
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
}

// ---------------------------------------------------------------------------
// 4. Exported kernel functions
// ---------------------------------------------------------------------------

/// Set kernel operating mode. 0 = traditional, 1 = centralized.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_set_mode(mode: u32) {
    crate::set_kernel_mode(mode);
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

/// Handle exec semantics on a process in the process table (centralized mode).
/// Serializes the process as exec state (closes CLOEXEC, resets handlers), then
/// re-creates the process from that sanitized state.
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_exec_setup(pid: u32) -> i32 {
    let table = unsafe { &mut *PROCESS_TABLE.0.get() };
    let proc = match table.get(pid) {
        Some(p) => p,
        None => return -(Errno::ESRCH as i32),
    };

    // Serialize as exec state (handles CLOEXEC fd removal, signal handler reset, etc.)
    let mut buf = alloc::vec![0u8; 64 * 1024];
    let written = match crate::fork::serialize_exec_state(proc, &mut buf) {
        Ok(n) => n,
        Err(e) => return -(e as i32),
    };

    // Deserialize back to replace the process with exec-sanitized version
    match crate::fork::deserialize_exec_state(&buf[..written], pid) {
        Ok(new_proc) => {
            table.get_mut(pid).map(|p| *p = new_proc);
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

        // File operations — musl: (path, flags, mode)
        1 => { // SYS_OPEN
            let p = a1 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_open(p, len, a2 as u32, a3 as u32)
        }
        2 => kernel_close(a1),                     // SYS_CLOSE
        3 => kernel_read(a1, a2 as *mut u8, a3 as u32), // SYS_READ: (fd, buf, count)
        4 => kernel_write(a1, a2 as *const u8, a3 as u32), // SYS_WRITE: (fd, buf, count)
        5 => kernel_lseek(a1, a2 as u32, a3, a4 as u32) as i32, // SYS_LSEEK: (fd, off_lo, off_hi, whence)
        6 => kernel_fstat(a1, a2 as *mut u8),      // SYS_FSTAT: (fd, stat_ptr)
        64 => kernel_pread(a1, a2 as *mut u8, a3 as u32, a4 as u32, a5), // SYS_PREAD: (fd, buf, count, off_lo, off_hi)
        65 => kernel_pwrite(a1, a2 as *const u8, a3 as u32, a4 as u32, a5), // SYS_PWRITE

        // FD operations
        7 => kernel_dup(a1),                       // SYS_DUP
        8 => kernel_dup2(a1, a2),                  // SYS_DUP2
        77 => kernel_dup3(a1, a2, a3 as u32),      // SYS_DUP3
        9 => kernel_pipe(a1 as *mut i32),          // SYS_PIPE: (pipefd_ptr)
        78 => kernel_pipe2(a2 as u32, a1 as *mut i32), // SYS_PIPE2: (pipefd_ptr, flags) → kernel wants (flags, pipefd_ptr)
        10 => kernel_fcntl(a1, a2 as u32, a3 as u32), // SYS_FCNTL
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
        37 => kernel_sigprocmask(a1 as u32, a2 as u32, a3 as u32) as i32, // SYS_SIGPROCMASK
        73 => kernel_signal(a1 as u32, a2 as u32), // SYS_SIGNAL
        39 => kernel_alarm(a1 as u32),             // SYS_ALARM
        110 => kernel_sigsuspend(a1 as u32, a2 as u32), // SYS_SIGSUSPEND
        111 => kernel_pause(),                     // SYS_PAUSE
        207 => kernel_rt_sigtimedwait(a1 as u32, a2 as u32, a3), // SYS_RT_SIGTIMEDWAIT

        // Time
        40 => kernel_clock_gettime(a1 as u32, a2 as *mut u8), // SYS_CLOCK_GETTIME
        41 => kernel_nanosleep(a1 as *const u8),   // SYS_NANOSLEEP
        123 => kernel_clock_getres(a1 as u32, a2 as *mut u8), // SYS_CLOCK_GETRES
        124 => kernel_clock_nanosleep(a1 as u32, a2 as u32, a3 as *const u8), // SYS_CLOCK_NANOSLEEP
        125 => { // SYS_UTIMENSAT: (dirfd, path, times, flags)
            let p = a2 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_utimensat(a1, p, len, a3 as *const u8, a4 as u32)
        }
        66 => kernel_time() as i32,                // SYS_TIME
        68 => kernel_usleep(a1 as u32),            // SYS_USLEEP

        // Memory
        46 => kernel_mmap(a1 as u32, a2 as u32, a3 as u32, a4 as u32, a5, 0, 0) as i32, // SYS_MMAP
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
        75 => kernel_uname(a1 as *mut u8, a2 as u32), // SYS_UNAME
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
        53 => kernel_accept(a1),                   // SYS_ACCEPT
        54 => kernel_connect(a1, a2 as *const u8, a3 as u32), // SYS_CONNECT
        55 => kernel_send(a1, a2 as *const u8, a3 as u32, a4 as u32), // SYS_SEND
        56 => kernel_recv(a1, a2 as *mut u8, a3 as u32, a4 as u32), // SYS_RECV
        57 => kernel_shutdown(a1, a2 as u32),      // SYS_SHUTDOWN
        58 => kernel_getsockopt(a1, a2 as u32, a3 as u32, a4 as *mut u32), // SYS_GETSOCKOPT
        59 => kernel_setsockopt(a1, a2 as u32, a3 as u32, a4 as u32), // SYS_SETSOCKOPT
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
        251 => kernel_ppoll(a1 as *mut u8, a2 as u32, a3, a4 as u32, a5 as u32), // SYS_PPOLL
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
        129 => { // SYS_STATFS: (path, statfs_buf)
            let p = a1 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_statfs(p, len, a2 as *mut u8)
        }
        130 => kernel_fstatfs(a1, a2 as *mut u8),  // SYS_FSTATFS
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

        // UID/GID
        90 => kernel_setpgid(a1 as u32, a2 as u32), // SYS_SETPGID
        91 => kernel_getsid(a1 as u32),            // SYS_GETSID
        104 => kernel_setuid(a1 as u32),           // SYS_SETUID
        105 => kernel_setgid(a1 as u32),           // SYS_SETGID
        106 => kernel_seteuid(a1 as u32),          // SYS_SETEUID
        107 => kernel_setegid(a1 as u32),          // SYS_SETEGID
        108 => kernel_getrusage(a1, a2 as *mut u8, a3 as u32), // SYS_GETRUSAGE
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

        // Timer
        225 => kernel_setitimer(a1 as u32, a2 as *const u8, a3 as *mut u8), // SYS_SETITIMER
        224 => kernel_getitimer(a1 as u32, a2 as *mut u8), // SYS_GETITIMER

        // statx — musl: (dirfd, path, flags, mask, statxbuf)
        260 => {
            let p = a2 as *const u8;
            let len = unsafe { cstr_len(p) };
            kernel_statx(a1, p, len, a3 as u32, a4 as u32, a5 as *mut u8)
        }

        // SysV IPC
        337 => kernel_ipc_msgget(a1, a2),          // SYS_MSGGET
        338 => kernel_ipc_msgrcv(a1, a2, a3, a4, a5), // SYS_MSGRCV
        339 => kernel_ipc_msgsnd(a1, a2, a3, a4),  // SYS_MSGSND
        340 => kernel_ipc_msgctl(a1, a2, a3),       // SYS_MSGCTL
        341 => kernel_ipc_semget(a1, a2, a3),       // SYS_SEMGET
        342 => kernel_ipc_semop(a1, a2, a3),        // SYS_SEMOP
        343 => kernel_ipc_semctl(a1, a2, a3, a4),   // SYS_SEMCTL
        344 => kernel_ipc_shmget(a1, a2, a3),       // SYS_SHMGET
        345 => kernel_ipc_shmat(a1, a2, a3),        // SYS_SHMAT
        346 => kernel_ipc_shmdt(a1),                // SYS_SHMDT
        347 => kernel_ipc_shmctl(a1, a2, a3),       // SYS_SHMCTL

        // eventfd
        242 => kernel_eventfd2(a1 as u32, a2 as u32), // SYS_EVENTFD2: (initval, flags)
        380 => kernel_eventfd2(a1 as u32, 0),          // SYS_EVENTFD: (initval) — no flags

        // Stubs that return 0 or -ENOSYS
        204 => kernel_raise(a2 as u32),            // SYS_TKILL
        208 | 209 | 226 | 230..=238 | 239..=241 | 243..=249 | 252..=254 | 256..=257 | 262 | 265..=268 | 271..=274 | 287 | 289..=293 | 297..=298 | 301..=305 | 306 | 308..=324 | 325..=336 | 348..=349 | 350..=369 | 370..=371 | 373..=379 | 381..=383 | 386 => {
            // Many of these are stubs in the glue layer too; return ENOSYS
            -(Errno::ENOSYS as i32)
        }

        _ => -(Errno::ENOSYS as i32),
    }
}

// ---------------------------------------------------------------------------
// SysV IPC kernel exports — thin wrappers to host imports
// ---------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_msgget(key: i32, flags: i32) -> i32 {
    unsafe { host_ipc_msgget(key, flags) }
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_msgsnd(qid: i32, msg_ptr: i32, msg_sz: i32, flags: i32) -> i32 {
    unsafe { host_ipc_msgsnd(qid, msg_ptr, msg_sz, flags) }
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_msgrcv(qid: i32, msg_ptr: i32, msg_sz: i32, msgtyp: i32, flags: i32) -> i32 {
    unsafe { host_ipc_msgrcv(qid, msg_ptr, msg_sz, msgtyp, flags) }
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_msgctl(qid: i32, cmd: i32, buf_ptr: i32) -> i32 {
    unsafe { host_ipc_msgctl(qid, cmd, buf_ptr) }
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_semget(key: i32, nsems: i32, flags: i32) -> i32 {
    unsafe { host_ipc_semget(key, nsems, flags) }
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_semop(semid: i32, sops_ptr: i32, nsops: i32) -> i32 {
    unsafe { host_ipc_semop(semid, sops_ptr, nsops) }
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_semctl(semid: i32, semnum: i32, cmd: i32, arg: i32) -> i32 {
    unsafe { host_ipc_semctl(semid, semnum, cmd, arg) }
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_shmget(key: i32, size: i32, flags: i32) -> i32 {
    unsafe { host_ipc_shmget(key, size, flags) }
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_shmat(shmid: i32, shmaddr: i32, flags: i32) -> i32 {
    unsafe { host_ipc_shmat(shmid, shmaddr, flags) }
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_shmdt(addr: i32) -> i32 {
    unsafe { host_ipc_shmdt(addr) }
}

#[unsafe(no_mangle)]
pub extern "C" fn kernel_ipc_shmctl(shmid: i32, cmd: i32, buf_ptr: i32) -> i32 {
    unsafe { host_ipc_shmctl(shmid, cmd, buf_ptr) }
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
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_kill(proc, &mut host, pid, sig) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
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
    let result = match syscalls::sys_clock_nanosleep(proc, &mut host, clock_id, flags, req) {
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

/// sendmsg — send a message on a socket.
/// Parses msghdr to extract iov[0] and delegates to sys_sendmsg.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_sendmsg(fd: i32, msg_ptr: *const u8, flags: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;

    // Parse msghdr: msg_iov at offset 8, msg_iovlen at offset 12
    let msg = unsafe { slice::from_raw_parts(msg_ptr, 28) };
    let iov_ptr = u32::from_le_bytes([msg[8], msg[9], msg[10], msg[11]]) as usize;
    let iov_len = u32::from_le_bytes([msg[12], msg[13], msg[14], msg[15]]);

    if iov_len == 0 {
        deliver_pending_signals(proc, &mut host);
        return 0;
    }

    // Parse first iovec: iov_base at offset 0, iov_len at offset 4
    let iov = unsafe { slice::from_raw_parts(iov_ptr as *const u8, 8) };
    let base = u32::from_le_bytes([iov[0], iov[1], iov[2], iov[3]]) as usize;
    let len = u32::from_le_bytes([iov[4], iov[5], iov[6], iov[7]]) as usize;

    let buf = unsafe { slice::from_raw_parts(base as *const u8, len) };
    let result = match syscalls::sys_sendmsg(proc, &mut host, fd, buf, flags) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// recvmsg — receive a message from a socket.
/// Parses msghdr to extract iov[0] and delegates to sys_recvmsg.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_recvmsg(fd: i32, msg_ptr: *mut u8, flags: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;

    // Parse msghdr: msg_iov at offset 8, msg_iovlen at offset 12
    let msg = unsafe { slice::from_raw_parts(msg_ptr, 28) };
    let iov_ptr = u32::from_le_bytes([msg[8], msg[9], msg[10], msg[11]]) as usize;
    let iov_len = u32::from_le_bytes([msg[12], msg[13], msg[14], msg[15]]);

    if iov_len == 0 {
        deliver_pending_signals(proc, &mut host);
        return 0;
    }

    // Parse first iovec
    let iov = unsafe { slice::from_raw_parts(iov_ptr as *const u8, 8) };
    let base = u32::from_le_bytes([iov[0], iov[1], iov[2], iov[3]]) as usize;
    let len = u32::from_le_bytes([iov[4], iov[5], iov[6], iov[7]]) as usize;

    let buf = unsafe { slice::from_raw_parts_mut(base as *mut u8, len) };
    let result = match syscalls::sys_recvmsg(proc, &mut host, fd, buf, flags) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    // Zero out msg_controllen to indicate no ancillary data
    let msg_mut = unsafe { slice::from_raw_parts_mut(msg_ptr, 28) };
    msg_mut[20..24].copy_from_slice(&0u32.to_le_bytes());
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
    let result = match syscalls::sys_listen(proc, fd, backlog) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Accept a connection. Returns new fd or negative errno.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_accept(fd: i32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_accept(proc, &mut host, fd) {
        Ok(new_fd) => new_fd,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// Connect to an address. Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_connect(fd: i32, addr_ptr: *const u8, addr_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let addr = unsafe { slice::from_raw_parts(addr_ptr, addr_len as usize) };
    let result = match syscalls::sys_connect(proc, &mut host, fd, addr) {
        Ok(()) => 0,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
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
/// Writes the option value to optval_ptr.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getsockopt(fd: i32, level: u32, optname: u32, optval_ptr: *mut u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let result = match syscalls::sys_getsockopt(proc, fd, level, optname) {
        Ok(val) => {
            unsafe { *optval_ptr = val; }
            0
        }
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// Set socket option. Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setsockopt(fd: i32, level: u32, optname: u32, optval: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
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
    let addr = unsafe { slice::from_raw_parts(addr_ptr, addr_len as usize) };
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
    addr_len: u32,
) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let buf = unsafe { slice::from_raw_parts_mut(buf_ptr, buf_len as usize) };
    let addr_buf = unsafe { slice::from_raw_parts_mut(addr_ptr, addr_len as usize) };
    let result = match syscalls::sys_recvfrom(proc, &mut host, fd, buf, flags, addr_buf) {
        Ok((n, _addr_len)) => n as i32,
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
/// new_ptr points to struct itimerval (32 bytes):
///   { struct timeval it_interval (16 bytes), struct timeval it_value (16 bytes) }
///   where struct timeval = { i64 tv_sec, i64 tv_usec } (wasm32 layout)
/// old_ptr receives the previous itimerval (may be null).
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_setitimer(which: u32, new_ptr: *const u8, old_ptr: *mut u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;

    // Parse new itimerval from memory
    let (interval_sec, interval_usec, value_sec, value_usec) = if new_ptr.is_null() {
        (0i64, 0i64, 0i64, 0i64)
    } else {
        let new_bytes = unsafe { slice::from_raw_parts(new_ptr, 32) };
        let interval_sec = i64::from_le_bytes(new_bytes[0..8].try_into().unwrap());
        let interval_usec = i64::from_le_bytes(new_bytes[8..16].try_into().unwrap());
        let value_sec = i64::from_le_bytes(new_bytes[16..24].try_into().unwrap());
        let value_usec = i64::from_le_bytes(new_bytes[24..32].try_into().unwrap());
        (interval_sec, interval_usec, value_sec, value_usec)
    };

    let result = match syscalls::sys_setitimer(
        proc, &mut host, which,
        interval_sec, interval_usec, value_sec, value_usec,
    ) {
        Ok((old_isec, old_iusec, old_vsec, old_vusec)) => {
            if !old_ptr.is_null() {
                let old_bytes = unsafe { slice::from_raw_parts_mut(old_ptr, 32) };
                old_bytes[0..8].copy_from_slice(&old_isec.to_le_bytes());
                old_bytes[8..16].copy_from_slice(&old_iusec.to_le_bytes());
                old_bytes[16..24].copy_from_slice(&old_vsec.to_le_bytes());
                old_bytes[24..32].copy_from_slice(&old_vusec.to_le_bytes());
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

/// getitimer -- get current value of interval timer.
/// curr_ptr receives the current itimerval (32 bytes).
/// Returns 0 on success, negative errno on error.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getitimer(which: u32, curr_ptr: *mut u8) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let mut host = WasmHostIO;
    let result = match syscalls::sys_getitimer(proc, &mut host, which) {
        Ok((isec, iusec, vsec, vusec)) => {
            if !curr_ptr.is_null() {
                let buf = unsafe { slice::from_raw_parts_mut(curr_ptr, 32) };
                buf[0..8].copy_from_slice(&isec.to_le_bytes());
                buf[8..16].copy_from_slice(&iusec.to_le_bytes());
                buf[16..24].copy_from_slice(&vsec.to_le_bytes());
                buf[24..32].copy_from_slice(&vusec.to_le_bytes());
            }
            0
        }
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
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
        Ok(sig) => sig as i32,
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
pub extern "C" fn kernel_getsockname(fd: i32, buf_ptr: u32, buf_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let buf = unsafe {
        core::slice::from_raw_parts_mut(buf_ptr as *mut u8, buf_len as usize)
    };
    let result = match syscalls::sys_getsockname(proc, fd, buf) {
        Ok(n) => n as i32,
        Err(e) => -(e as i32),
    };
    let mut host = WasmHostIO;
    deliver_pending_signals(proc, &mut host);
    result
}

/// getpeername -- get remote socket address.
#[unsafe(no_mangle)]
pub extern "C" fn kernel_getpeername(fd: i32, buf_ptr: u32, buf_len: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let buf = unsafe {
        core::slice::from_raw_parts_mut(buf_ptr as *mut u8, buf_len as usize)
    };
    let result = match syscalls::sys_getpeername(proc, fd, buf) {
        Ok(n) => n as i32,
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
        let pt = unsafe { &mut *crate::PROCESS_TABLE.0.get() };
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
#[unsafe(no_mangle)]
pub extern "C" fn kernel_ppoll(fds_ptr: *mut u8, nfds: u32, timeout_ms: i32, mask_lo: u32, mask_hi: u32) -> i32 {
    let (_gkl, proc) = unsafe { get_process() };
    let fds = unsafe {
        slice::from_raw_parts_mut(fds_ptr as *mut wasm_posix_shared::WasmPollFd, nfds as usize)
    };
    let mask = if mask_lo == 0 && mask_hi == 0 {
        None
    } else {
        Some(((mask_hi as u64) << 32) | (mask_lo as u64))
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
#[unsafe(no_mangle)]
pub extern "C" fn kernel_pselect6(
    nfds: i32,
    readfds_ptr: *mut u8,
    writefds_ptr: *mut u8,
    exceptfds_ptr: *mut u8,
    timeout_ms: i32,
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

    let mask = if mask_lo == 0 && mask_hi == 0 {
        None
    } else {
        Some(((mask_hi as u64) << 32) | (mask_lo as u64))
    };

    let mut host = WasmHostIO;
    let result = match syscalls::sys_pselect6(proc, &mut host, nfds, readfds, writefds, exceptfds, timeout_ms, mask) {
        Ok(n) => n,
        Err(e) => -(e as i32),
    };
    deliver_pending_signals(proc, &mut host);
    result
}

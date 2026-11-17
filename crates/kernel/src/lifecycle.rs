//! Synchronous process-lifecycle transitions behind the kernel exports.
//!
//! Each export validates its request against the process table and commits
//! it in the same call. Production GL and DRI run synchronously in the kernel
//! worker, and their cleanup either completes inside the commit or stops the
//! kernel as a fatal host fault (`syscalls::apply_dri_release_effect`), so no
//! lifecycle transition is ever left pending on host work.
// The exports that construct every request live in `wasm_api`, which only
// builds for Wasm; host-target unit tests exercise a subset.
#![cfg_attr(not(any(target_arch = "wasm32", target_arch = "wasm64")), allow(dead_code))]
use crate::process::{HostIO, ProcessState};
use crate::process_table::{ProcessTable, ProcessRemovalState};
use crate::syscalls;
use wasm_posix_shared::Errno;

#[derive(Clone, Copy, Debug)]
pub(crate) enum Request {
    Exec {
        pid: u32,
        tid: u32,
        target: u32,
    },
    SpawnExec {
        parent: u32,
        child: u32,
        target: u32,
    },
    Exit {
        pid: u32,
        tid: u32,
        status: i32,
        thread_worker: bool,
    },
    SignalExit {
        pid: u32,
        signum: u32,
    },
    ReapInit {
        pid: u32,
    },
    Remove {
        pid: u32,
        reap: bool,
    },
    ReleaseRetry {
        pid: u32,
        tid: u32,
        token: i64,
    },
}
impl Request {
    fn pid(self) -> u32 {
        match self {
            Self::Exec { pid, .. }
            | Self::Exit { pid, .. }
            | Self::Remove { pid, .. }
            | Self::ReleaseRetry { pid, .. }
            | Self::SignalExit { pid, .. }
            | Self::ReapInit { pid } => pid,
            Self::SpawnExec { child, .. } => child,
        }
    }
}

pub(crate) enum Completion {
    Exec,
    Exit(i32),
    Removed(ProcessRemovalState),
    RetryReleased,
    Signaled,
    InitReaped(crate::process_table::InitReap),
}

/// Refuse a request before it consumes anything. A process whose prepared
/// exec target has an uncertain native close (`has_retiring`) is contained:
/// no lifecycle transition may run until that target's custody resolves.
fn check(table: &ProcessTable, request: Request) -> Result<(), Errno> {
    let proc = table.get(request.pid()).ok_or(Errno::ESRCH)?;
    if proc.prepared_exec_targets.has_retiring() {
        return Err(Errno::EBUSY);
    }
    match request {
        Request::SpawnExec { parent, .. } => {
            if table.get(parent).is_none() || proc.ppid != parent {
                return Err(Errno::ESRCH);
            }
        }
        Request::Exit { pid, tid, .. } => table.validate_task(pid, tid)?,
        Request::ReleaseRetry { tid, token, .. } => {
            if token <= 0 {
                return Err(Errno::EINVAL);
            }
            if proc
                .blocked_retries
                .active_binding_current()?
                .is_some_and(|binding| binding.token == token)
            {
                return Err(Errno::EBUSY);
            }
            if proc
                .blocked_retries
                .binding_for_token(token)
                .is_none_or(|binding| binding.tid != tid)
            {
                return Err(Errno::ENOENT);
            }
        }
        // Exec owner validation stays in `exec_target::commit_*`, whose
        // consuming error path retires an invalid target.
        Request::Exec { .. }
        | Request::Remove { .. }
        | Request::SignalExit { .. }
        | Request::ReapInit { .. } => (),
    }
    Ok(())
}

/// Validate and commit one lifecycle request.
pub(crate) fn run(
    table: &mut ProcessTable,
    host: &mut dyn HostIO,
    request: Request,
) -> Result<Completion, Errno> {
    check(table, request)?;
    Ok(match request {
        Request::Exec { pid, tid, target } => {
            let (proc, locks) = table.process_and_advisory_locks(pid).ok_or(Errno::ESRCH)?;
            crate::exec_target::commit_process(proc, locks, host, pid, tid, target)?;
            Completion::Exec
        }
        Request::SpawnExec {
            parent,
            child,
            target,
        } => {
            let (proc, locks) = table
                .process_and_advisory_locks(child)
                .ok_or(Errno::ESRCH)?;
            crate::exec_target::commit_spawn(proc, locks, host, parent, child, target)?;
            Completion::Exec
        }
        Request::Exit {
            pid,
            status,
            thread_worker,
            ..
        } => {
            let (proc, locks) = table.process_and_advisory_locks(pid).ok_or(Errno::ESRCH)?;
            if thread_worker {
                proc.exit_status = status & 0xff;
                proc.exit_signal = 0;
            } else {
                syscalls::sys_exit_with_locks(proc, locks, host, status);
            }
            Completion::Exit(proc.exit_status)
        }
        Request::SignalExit { pid, signum } => {
            let (proc, locks) = table.process_and_advisory_locks(pid).ok_or(Errno::ESRCH)?;
            crate::signal::terminate_process_by_signal_with_locks(proc, locks, host, signum);
            Completion::Signaled
        }
        Request::ReapInit { pid } => {
            Completion::InitReaped(table.reap_for_init_with_io(pid, host).ok_or(Errno::ECHILD)?)
        }
        Request::Remove { pid, reap } => Completion::Removed(
            if reap {
                table.reap_process_with_io(pid, host)
            } else {
                table.remove_process_with_io(pid, host)
            }
            .ok_or(Errno::ESRCH)?,
        ),
        Request::ReleaseRetry { pid, tid, token } => {
            let (proc, locks) = table.process_and_advisory_locks(pid).ok_or(Errno::ESRCH)?;
            syscalls::release_blocking_retry_binding(proc, locks, host, tid, token)?;
            Completion::RetryReleased
        }
    })
}

/// Retire thread `tid` of `pid` and return its clear-child-TID pointer.
///
/// With `clear_child_tid`, store zero at that pointer and wake one futex
/// waiter, as Linux does for `CLONE_CHILD_CLEARTID`. A failed store is
/// ignored like Linux's faulting `put_user`, and only a successful store
/// wakes. A process that is no longer running has no memory to store into.
pub(crate) fn thread_exit(
    table: &mut ProcessTable,
    host: &mut dyn HostIO,
    pid: u32,
    tid: u32,
    clear_child_tid: bool,
) -> Result<usize, Errno> {
    let proc = table.get(pid).ok_or(Errno::ESRCH)?;
    if proc.prepared_exec_targets.has_retiring() {
        return Err(Errno::EBUSY);
    }
    if proc.get_thread(tid).is_none() {
        return Err(Errno::ESRCH);
    }
    let (proc, locks) = table.process_and_advisory_locks(pid).ok_or(Errno::ESRCH)?;
    let ctid = syscalls::cleanup_exiting_thread_with_state(proc, locks, host, tid)?.ctid_ptr;
    if clear_child_tid
        && ctid != 0
        && matches!(proc.state, ProcessState::Running | ProcessState::Stopped)
        && host.proc_write_bytes(pid as i32, ctid as u64, &0u32.to_le_bytes()) == 0
    {
        crate::wait_park::with(|parks| parks.futex_wake(pid, ctid as u64, 1, u32::MAX));
    }
    Ok(ctid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        exec_target::{PreparedExecOwner, PreparedExecTarget},
        fd::OpenFileDescRef,
        ofd::FileType,
        wait_park::Resume,
        wait_queue::{WaitKind, WakeSource},
    };
    use alloc::{vec, vec::Vec};
    use core::sync::atomic::{AtomicI64, Ordering};
    use wasm_posix_shared::{WasmStat, WasmStatfs, flags::O_RDONLY, mode::S_IFREG};
    static HANDLES: AtomicI64 = AtomicI64::new(50000);
    const IMAGE: &[u8] = b"\0asm\x01\0\0\0";

    struct Host {
        closed: Vec<i64>,
        close_error: Option<Errno>,
        preads: Vec<i64>,
        writes: Vec<(i32, u64, Vec<u8>)>,
        write_result: i32,
    }
    impl Host {
        fn new() -> Self {
            Self {
                closed: Vec::new(),
                close_error: None,
                preads: Vec::new(),
                writes: Vec::new(),
                write_result: 0,
            }
        }
    }
    fn stat(handle: i64) -> WasmStat {
        WasmStat {
            st_dev: 7,
            st_ino: handle as u64,
            st_mode: S_IFREG | 0o755,
            st_size: IMAGE.len() as u64,
            st_nlink: 1,
            st_uid: 0,
            st_gid: 0,
            st_atime_sec: 0,
            st_atime_nsec: 0,
            st_mtime_sec: 0,
            st_mtime_nsec: 0,
            st_ctime_sec: 0,
            st_ctime_nsec: 0,
            _pad: 0,
            st_rdev: 0,
        }
    }
    fn statfs() -> WasmStatfs {
        WasmStatfs {
            f_type: 1,
            f_fsid: 19,
            f_flags: wasm_posix_shared::statfs_flags::ST_NOSUID,
            f_bsize: 4096,
            f_blocks: 1,
            f_bfree: 0,
            f_bavail: 0,
            f_files: 1,
            f_ffree: 0,
            f_namelen: 255,
            f_frsize: 4096,
            _pad: 0,
        }
    }
    impl HostIO for Host {
        fn proc_write_bytes(&mut self, pid: i32, addr: u64, bytes: &[u8]) -> i32 {
            self.writes.push((pid, addr, bytes.to_vec()));
            self.write_result
        }

        fn host_close(&mut self, h: i64) -> Result<(), Errno> {
            self.closed.push(h);
            if let Some(error) = self.close_error.take() {
                return Err(error);
            }
            Ok(())
        }
        fn host_read(&mut self, _: i64, _: &mut [u8]) -> Result<usize, Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_write(&mut self, _: i64, _: &[u8]) -> Result<usize, Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_seek(&mut self, _: i64, _: i64, _: u32) -> Result<i64, Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_fstat(&mut self, h: i64) -> Result<WasmStat, Errno> {
            Ok(stat(h))
        }
        fn host_fstatfs(&mut self, _: i64) -> Result<WasmStatfs, Errno> {
            Ok(statfs())
        }
        fn host_pread(&mut self, handle: i64, out: &mut [u8], offset: i64) -> Result<usize, Errno> {
            self.preads.push(handle);
            let offset = usize::try_from(offset).map_err(|_| Errno::EINVAL)?;
            let bytes = IMAGE.get(offset..).ok_or(Errno::EINVAL)?;
            let len = out.len().min(bytes.len());
            out[..len].copy_from_slice(&bytes[..len]);
            Ok(len)
        }
        fn host_readdir(
            &mut self,
            _: i64,
            _: &mut [u8],
        ) -> Result<Option<(u64, u32, usize)>, Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_clock_gettime(&mut self, _: u32) -> Result<(i64, i64), Errno> {
            Ok((0, 0))
        }
        fn host_ftruncate(&mut self, _: i64, _: i64) -> Result<(), Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_fsync(&mut self, _: i64) -> Result<(), Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_fchmod(&mut self, _: i64, _: u32) -> Result<(), Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_fchown(&mut self, _: i64, _: u32, _: u32) -> Result<(), Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_set_alarm(&mut self, _: u32) -> Result<(), Errno> {
            Ok(())
        }
        fn host_set_posix_timer(&mut self, _: i32, _: i32, _: i64, _: i64) -> Result<(), Errno> {
            Ok(())
        }
        fn host_getrandom(&mut self, _: &mut [u8]) -> Result<usize, Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_net_connect(&mut self, _: i32, _: &[u8], _: u16) -> Result<(), Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_net_connect_status(&mut self, _: i32) -> Result<(), Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_net_send(&mut self, _: i32, _: &[u8], _: u32) -> Result<usize, Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_net_recv(&mut self, _: i32, _: u32, _: u32, _: &mut [u8]) -> Result<usize, Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_net_close(&mut self, _: i32) -> Result<(), Errno> {
            Ok(())
        }
        fn host_net_listen(&mut self, _: i32, _: u16, _: &[u8; 4]) -> Result<(), Errno> {
            Err(Errno::ENOSYS)
        }
        fn host_getaddrinfo(&mut self, _: &[u8], _: &mut [u8]) -> Result<usize, Errno> {
            Err(Errno::ENOSYS)
        }
        fn bind_framebuffer(&mut self, _: i32, _: usize, _: usize, _: u32, _: u32, _: u32, _: u32) {
        }
        fn unbind_framebuffer(&mut self, _: i32) {}
        fn fb_write(&mut self, _: i32, _: usize, _: &[u8]) {}
    }
    static KERNEL_TABLE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    // runtime-core is a dependency here, so its isolated test-only allocator
    // is deliberately unavailable. Exercise the actual kernel singleton under
    // one test lock, preserving its real monotonic task identities/generations.
    fn fixture() -> (
        &'static mut ProcessTable,
        Host,
        u32,
        i64,
        std::sync::MutexGuard<'static, ()>,
    ) {
        let guard = KERNEL_TABLE_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let table = unsafe { &mut *crate::process_table::GLOBAL_PROCESS_TABLE.0.get() };
        let pid = table.create_process().unwrap();
        (
            table,
            Host::new(),
            pid,
            HANDLES.fetch_add(100, Ordering::Relaxed),
            guard,
        )
    }
    fn prepare(
        table: &mut ProcessTable,
        pid: u32,
        owner: PreparedExecOwner,
        handle: i64,
    ) -> (u32, usize) {
        let proc = table.get_mut(pid).unwrap();
        let prepared = proc
            .ofd_table
            .prepare(FileType::Regular, O_RDONLY, b"/program")
            .unwrap();
        let idx = proc.ofd_table.publish(prepared, handle);
        let id = proc.ofd_table.get(idx).unwrap().ofd_id;
        let mut target = PreparedExecTarget::new(
            owner,
            OpenFileDescRef(idx),
            id,
            Some(crate::lock::FileId::Host {
                dev: 7,
                ino: handle as u64,
            }),
            stat(handle),
            statfs(),
            b"/program".to_vec(),
        )
        .unwrap();
        target.record_read(0, IMAGE).unwrap();
        (proc.prepared_exec_targets.insert(target).unwrap(), idx)
    }
    fn park_ctid(pid: u32, addr: u64) -> usize {
        crate::wait_park::with(|parks| {
            parks
                .park(
                    pid,
                    pid,
                    WaitKind::Futex,
                    vec![WakeSource::Futex { pid, addr }],
                    None,
                    Resume::Futex {
                        bitset: u32::MAX,
                        timeout_ns: None,
                    },
                )
                .unwrap();
            parks.pending_completions()
        })
    }


    #[test]
        fn init_reap_wrapper_keeps_existing_child_and_absence_error_contract() {
            let (mut table, mut host, _pid, _base, _table_guard) = fixture();
            let child = table
                .create_init_child(vec![b"/init-child".to_vec()])
                .unwrap();
            assert!(matches!(
                run(&mut table, &mut host, Request::ReapInit { pid: child }),
                Err(Errno::ECHILD)
            ));
            assert!(table.get(child).is_some());
            let (proc, locks) = table.process_and_advisory_locks(child).unwrap();
            syscalls::sys_exit_with_locks(proc, locks, &mut host, 42);
            match run(&mut table, &mut host, Request::ReapInit { pid: child }).unwrap() {
                Completion::InitReaped(reap) => {
                    assert_eq!(reap.pid, child);
                    assert_eq!(reap.exit_status, 42);
                }
                _ => panic!("init reap completion"),
            }
            assert!(table.get(child).is_none());
        }

    #[test]
    fn successful_final_preclose_runs_normal_retirement_without_second_close() {
        let (mut table, mut host, pid, base, _guard) = fixture();
        let (target, idx) = prepare(
            &mut table,
            pid,
            PreparedExecOwner::Process {
                pid,
                caller_tid: pid,
                generation: 0,
            },
            base,
        );
        let (proc, locks) = table.process_and_advisory_locks(pid).unwrap();
        crate::exec_target::cancel(proc, locks, &mut host, pid, target).unwrap();
        assert_eq!(host.closed, [base]);
        assert!(proc.ofd_table.get(idx).is_none());
        assert!(
            proc.prepared_exec_targets
                .retained_identity(target)
                .is_err()
        );
        assert_eq!(
            crate::exec_target::cancel(proc, locks, &mut host, pid, target),
            Err(Errno::EINVAL)
        );
        assert_eq!(host.closed, [base]);
    }

    #[test]
    fn nonfinal_local_and_real_fork_shared_references_do_not_preclose() {
        for fork in [false, true] {
            let (mut table, mut host, pid, base, _guard) = fixture();
            let (target, idx) = prepare(
                &mut table,
                pid,
                PreparedExecOwner::Process {
                    pid,
                    caller_tid: pid,
                    generation: 0,
                },
                base,
            );
            let proc = table.get_mut(pid).unwrap();
            let id = proc.ofd_table.get(idx).unwrap().ofd_id;
            proc.ofd_table.try_inc_ref_exact(idx, id).unwrap();
            let fd = proc.fd_table.alloc(OpenFileDescRef(idx), 0).unwrap();
            let child = if fork {
                Some(table.fork_process_for_caller(pid, pid).unwrap())
            } else {
                None
            };
            if fork {
                let (proc, locks) = table.process_and_advisory_locks(pid).unwrap();
                syscalls::sys_close_with_locks(proc, locks, &mut host, fd).unwrap();
                assert_eq!(proc.ofd_table.get(idx).unwrap().ref_count, 1);
            }
            host.close_error = Some(Errno::EIO);
            let (proc, locks) = table.process_and_advisory_locks(pid).unwrap();
            crate::exec_target::cancel(proc, locks, &mut host, pid, target).unwrap();
            assert!(host.closed.is_empty());
            assert_eq!(
                host.close_error,
                Some(Errno::EIO),
                "no native close attempted"
            );
            host.close_error = None;
            let last_pid = child.unwrap_or(pid);
            let (proc, locks) = table.process_and_advisory_locks(last_pid).unwrap();
            syscalls::sys_close_with_locks(proc, locks, &mut host, fd).unwrap();
            assert_eq!(host.closed, [base]);
        }
    }

    #[test]
    fn quarantined_target_cannot_read_or_close_a_reused_native_number() {
        let (mut table, mut host, pid, base, _guard) = fixture();
        let (old, old_idx) = prepare(
            &mut table,
            pid,
            PreparedExecOwner::Process {
                pid,
                caller_tid: pid,
                generation: 0,
            },
            base,
        );
        host.close_error = Some(Errno::EIO);
        {
            let (proc, locks) = table.process_and_advisory_locks(pid).unwrap();
            assert_eq!(
                crate::exec_target::cancel(proc, locks, &mut host, pid, old),
                Err(Errno::EIO)
            );
        }
        // A backend may have consumed its native fd before returning EIO. A new
        // actual target can then legitimately carry the same numeric host handle.
        let (replacement, new_idx) = prepare(
            &mut table,
            pid,
            PreparedExecOwner::Process {
                pid,
                caller_tid: pid,
                generation: 0,
            },
            base,
        );
        assert_ne!(old_idx, new_idx);
        let proc = table.get_mut(pid).unwrap();
        assert_ne!(
            proc.ofd_table.get(old_idx).unwrap().ofd_id,
            proc.ofd_table.get(new_idx).unwrap().ofd_id
        );
        let mut bytes = [0xa5; 8];
        assert_eq!(
            crate::exec_target::read(proc, &mut host, pid, old, 0, &mut bytes),
            Err(Errno::EBUSY)
        );
        assert_eq!(bytes, [0xa5; 8]);
        assert!(host.preads.is_empty());
        assert_eq!(crate::exec_target::size(proc, pid, old), Err(Errno::EBUSY));
        assert_eq!(
            crate::exec_target::artifact_bytes(proc, pid, old),
            Err(Errno::EBUSY)
        );
        let (proc, locks) = table.process_and_advisory_locks(pid).unwrap();
        assert_eq!(
            crate::exec_target::commit_process(proc, locks, &mut host, pid, pid, old),
            Err(Errno::EBUSY)
        );
        assert_eq!(
            crate::exec_target::cancel(proc, locks, &mut host, pid, old),
            Err(Errno::EIO)
        );
        assert_eq!(host.closed, [base]);
        crate::exec_target::cancel(proc, locks, &mut host, pid, replacement).unwrap();
        assert_eq!(
            host.closed,
            [base, base],
            "only the independently owned replacement closes next"
        );
        assert_eq!(
            crate::exec_target::cancel(proc, locks, &mut host, pid, old),
            Err(Errno::EIO)
        );
        assert_eq!(host.closed, [base, base]);
        assert!(
            proc.prepared_exec_targets
                .retained_identity(old)
                .unwrap()
                .retiring
        );
    }

    #[test]
    fn prepared_target_native_close_has_one_transaction_entry_point() {
        let target_source = include_str!("../../runtime-core/src/exec_target.rs");
        // All executable target access/close must use the typed OFD transaction;
        // direct raw-number HostIO closes here bypass its retained custody proof.
        let start = target_source.find("pub fn cancel(").unwrap();
        let end = target_source[start..].find("fn metadata_matches(").unwrap() + start;
        assert!(!target_source[start..end].contains("host.host_close("));
        let snapshot = include_str!("../../runtime-core/src/fork.rs");
        let start = snapshot.find("pub fn serialize_fork_state(").unwrap();
        let body = &snapshot[start..];
        assert!(body.find("has_retiring()").unwrap() < body.find("Writer::new").unwrap());
    }

    #[test]
    fn uncertain_target_containment_precedes_lifecycle_and_signal_mutation() {
        let (mut table, mut host, pid, base, _guard) = fixture();
        let (target, _) = prepare(
            &mut table,
            pid,
            PreparedExecOwner::Process {
                pid,
                caller_tid: pid,
                generation: 0,
            },
            base,
        );
        host.close_error = Some(Errno::EIO);
        let (proc, locks) = table.process_and_advisory_locks(pid).unwrap();
        crate::exec_target::cancel(proc, locks, &mut host, pid, target).unwrap_err();
        proc.caught_handler_depth = 3;
        proc.raise_signal(15);
        assert_eq!(
            crate::signal::try_deliver_pending_signals_with_locks(proc, locks, &mut host),
            crate::signal::SignalProgress::ProtocolFaultOwned
        );
        assert!(proc.signals.is_pending(15));
        assert_eq!(proc.caught_handler_depth, 3);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                crate::signal::dequeue_signal_for(proc, pid, 15)
            }))
            .is_err()
        );
        assert!(proc.signals.is_pending(15));
        assert_eq!(
            syscalls::commit_exec_state_with_locks(proc, locks, &mut host, pid),
            Err(Errno::EBUSY)
        );
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                syscalls::sys_exit_with_locks(proc, locks, &mut host, 42)
            }))
            .is_err()
        );
        assert_eq!(proc.state, ProcessState::Running);
        assert_eq!(proc.exit_status, 0);
        assert_eq!(proc.caught_handler_depth, 3);
        let mut wire = [0xa5; 256];
        assert_eq!(
            crate::fork::serialize_fork_state(proc, &mut wire),
            Err(Errno::EBUSY)
        );
        assert_eq!(wire, [0xa5; 256]);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                crate::exec_target::drain_prepared_exec_targets(proc, locks, &mut host)
            }))
            .is_err()
        );
        assert!(
            proc.prepared_exec_targets
                .retained_identity(target)
                .unwrap()
                .retiring
        );
        assert!(matches!(
            run(&mut table, &mut host, Request::Remove { pid, reap: false }),
            Err(Errno::EBUSY)
        ));
        assert!(matches!(
            thread_exit(&mut table, &mut host, pid, pid, false),
            Err(Errno::EBUSY)
        ));
        assert!(table.remove_process_with_io(pid, &mut host).is_none());
        assert_eq!(table.fork_process_for_caller(pid, pid), Err(Errno::EBUSY));
        assert_eq!(table.get(pid).unwrap().state, ProcessState::Running);
        assert_eq!(host.closed, [base]);
    }

    #[test]
    fn clear_tid_flag_and_fault_preserve_legacy_return_and_wake_semantics() {
        for (clear, ptr, write_result) in [
            (false, 0x3000, 0),
            (true, 0, 0),
            (true, 0x3000, -(Errno::EFAULT as i32)),
        ] {
            let (mut table, mut host, pid, _, _guard) = fixture();
            let tid = table.create_thread(pid, pid, 0, 0, ptr).unwrap();
            let before = if ptr != 0 {
                park_ctid(pid, ptr as u64)
            } else {
                crate::wait_park::with(|parks| parks.pending_completions())
            };
            host.write_result = write_result;
            assert_eq!(
                thread_exit(&mut table, &mut host, pid, tid, clear),
                Ok(ptr)
            );
            assert_eq!(host.writes.len(), usize::from(clear && ptr != 0));
            assert_eq!(
                crate::wait_park::with(|parks| parks.pending_completions()),
                before
            );
            assert_eq!(
                thread_exit(&mut table, &mut host, pid, tid, clear),
                Err(Errno::ESRCH)
            );
        }
    }

    #[test]
    fn failed_final_close_quarantines_the_target_and_never_retries_the_raw_handle() {
        let (mut table, mut host, pid, base, _guard) = fixture();
        let (target, idx) = prepare(
            &mut table,
            pid,
            PreparedExecOwner::Process {
                pid,
                caller_tid: pid,
                generation: 0,
            },
            base,
        );
        host.close_error = Some(Errno::EIO);
        let (proc, locks) = table.process_and_advisory_locks(pid).unwrap();
        assert_eq!(
            crate::exec_target::cancel(proc, locks, &mut host, pid, target),
            Err(Errno::EIO)
        );
        assert!(
            proc.prepared_exec_targets
                .retained_identity(target)
                .unwrap()
                .retiring
        );
        assert_eq!(proc.ofd_table.get(idx).unwrap().ref_count, 1);
        assert!(matches!(
            proc.prepared_exec_targets.get(target),
            Err(Errno::EBUSY)
        ));
        let id = proc.ofd_table.get(idx).unwrap().ofd_id;
        assert_eq!(proc.ofd_table.try_inc_ref_exact(idx, id), Err(Errno::EBUSY));
        assert_eq!(
            syscalls::release_prepared_exec_ofd_with_locks(
                proc,
                locks,
                &mut host,
                OpenFileDescRef(idx)
            ),
            Err(Errno::EBUSY)
        );
        for _ in 0..2 {
            let (proc, locks) = table.process_and_advisory_locks(pid).unwrap();
            assert_eq!(
                crate::exec_target::cancel(proc, locks, &mut host, pid, target),
                Err(Errno::EIO)
            );
        }
        assert_eq!(
            host.closed,
            [base],
            "uncertain error never authorizes raw-fd retry"
        );
    }

}

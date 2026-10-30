//! Kernel wrapper ordering for owned query retirement. This is an internal
//! driver, not an export or a public pending result. A future scheduler must
//! retain the same intent across turns; legacy exports require completion.
use crate::process::HostIO;
use crate::process_table::{ProcessTable, RemoveProcessResult};
use crate::syscalls::{self, GlQueryTeardown};
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
    ThreadExit {
        pid: u32,
        tid: u32,
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
            | Self::ThreadExit { pid, .. }
            | Self::Remove { pid, .. }
            | Self::ReleaseRetry { pid, .. }
            | Self::SignalExit { pid, .. }
            | Self::ReapInit { pid } => pid,
            Self::SpawnExec { child, .. } => child,
        }
    }
    fn cleanup_tid(self) -> Option<u32> {
        match self {
            Self::ThreadExit { tid, .. }
            | Self::ReleaseRetry { tid, .. }
            | Self::Exit {
                tid,
                thread_worker: true,
                ..
            } => Some(tid),
            _ => None,
        }
    }
}
/// Linear kernel-side intent. Scalar arguments and the existing process
/// generation are captured once; callers cannot redirect a resumed intent.
pub(crate) struct Intent {
    request: Request,
    generation: u64,
    finished: bool,
}
pub(crate) enum Completion {
    Exec,
    Exit(i32),
    ThreadExit(usize),
    Removed(RemoveProcessResult),
    RetryReleased,
    Signaled,
    InitReaped(crate::process_table::InitReap),
}
#[must_use]
pub(crate) enum Progress {
    PendingOwned,
    ProtocolFaultOwned,
    Complete(Completion),
}
impl Progress {
    /// Existing exports have no pending result contract yet. They must not
    /// turn owned-pending into success, ESRCH, an exit status or a cleared TID.
    pub(crate) fn require_complete(self) -> Completion {
        match self {
            Self::Complete(done) => done,
            Self::PendingOwned => {
                panic!("owned query lifecycle requires pending intent scheduling")
            }
            Self::ProtocolFaultOwned => {
                panic!("owned query lifecycle requires protocol containment")
            }
        }
    }
}
impl Intent {
    pub(crate) fn capture(table: &ProcessTable, request: Request) -> Result<Self, Errno> {
        let generation = table
            .get(request.pid())
            .ok_or(Errno::ESRCH)?
            .exec_generation;
        Ok(Self {
            request,
            generation,
            finished: false,
        })
    }
    /// Invalid foreign authority must not cancel somebody else's query. For
    /// exec, leave the existing consuming error path intact when target-owner
    /// validation fails; it cannot reach the image commit point in that case.
    fn may_preflight(&self, table: &ProcessTable) -> Result<bool, Errno> {
        let proc = table.get(self.request.pid()).ok_or(Errno::ESRCH)?;
        if proc.exec_generation != self.generation {
            return Err(Errno::ESRCH);
        }
        match self.request {
            Request::Exec { pid, tid, target } => {
                Ok(proc.prepared_exec_targets.get(target).is_ok_and(|t| {
                    t.owner()
                        .validate_process(pid, tid, self.generation)
                        .is_ok()
                }) && table.validate_task(pid, tid).is_ok())
            }
            Request::SpawnExec {
                parent,
                child,
                target,
            } => {
                if table.get(parent).is_none() || proc.ppid != parent {
                    return Err(Errno::ESRCH);
                }
                Ok(proc.prepared_exec_targets.get(target).is_ok_and(|t| {
                    t.owner()
                        .validate_spawn(parent, child, self.generation)
                        .is_ok()
                }))
            }
            Request::ThreadExit { tid, .. } => {
                if proc.get_thread(tid).is_none() {
                    return Err(Errno::ESRCH);
                }
                Ok(true)
            }
            Request::Exit { pid, tid, .. } => {
                table.validate_task(pid, tid)?;
                Ok(true)
            }
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
                    .is_none_or(|b| b.tid != tid)
                {
                    return Err(Errno::ENOENT);
                }
                Ok(true)
            }
            Request::Remove { .. } | Request::SignalExit { .. } => Ok(true),
            Request::ReapInit { pid } => {
                Ok(table.is_exited_child_of(crate::process_table::SYNTHETIC_INIT_PID, pid))
            }
        }
    }
    pub(crate) fn step(
        &mut self,
        table: &mut ProcessTable,
        host: &mut dyn HostIO,
    ) -> Result<Progress, Errno> {
        if self.finished {
            return Err(Errno::EINVAL);
        }
        if self.may_preflight(table)? {
            let proc = table.get_mut(self.request.pid()).ok_or(Errno::ESRCH)?;
            match syscalls::preflight_gl_query_teardown(proc, host, self.request.cleanup_tid()) {
                GlQueryTeardown::PendingOwned => return Ok(Progress::PendingOwned),
                GlQueryTeardown::ProtocolFaultOwned => return Ok(Progress::ProtocolFaultOwned),
                GlQueryTeardown::Ready => (),
            }
        }
        // Everything below consumes resources or publishes lifecycle facts.
        // Marking first prevents duplicate effects even after a terminal error.
        self.finished = true;
        let completion = match self.request {
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
            Request::ThreadExit { pid, tid } => {
                let (proc, locks) = table.process_and_advisory_locks(pid).ok_or(Errno::ESRCH)?;
                let thread = syscalls::cleanup_exiting_thread_with_state(proc, locks, host, tid)?;
                Completion::ThreadExit(thread.ctid_ptr)
            }
            Request::SignalExit { pid, signum } => {
                let (proc, locks) = table.process_and_advisory_locks(pid).ok_or(Errno::ESRCH)?;
                crate::signal::terminate_process_by_signal_with_locks(proc, locks, host, signum);
                Completion::Signaled
            }
            Request::ReapInit { pid } => {
                Completion::InitReaped(table.reap_for_init(pid).ok_or(Errno::ECHILD)?)
            }
            Request::Remove { pid, reap } => Completion::Removed(
                if reap {
                    table.reap_process(pid)
                } else {
                    table.remove_process(pid)
                }
                .ok_or(Errno::ESRCH)?,
            ),
            Request::ReleaseRetry { pid, tid, token } => {
                let (proc, locks) = table.process_and_advisory_locks(pid).ok_or(Errno::ESRCH)?;
                syscalls::release_blocking_retry_binding(proc, locks, host, tid, token)?;
                Completion::RetryReleased
            }
        };
        Ok(Progress::Complete(completion))
    }
}

/// One-shot boundary for the current ABI wrappers. Future pending scheduling
/// must retain Intent and call step again, rather than recreating this helper.
pub(crate) fn legacy(
    table: &mut ProcessTable,
    host: &mut dyn HostIO,
    request: Request,
) -> Result<Completion, Errno> {
    Intent::capture(table, request)?
        .step(table, host)
        .map(Progress::require_complete)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        blocked_retry::{BlockingRetryOperation, BlockingRetryTarget, StableOfdTarget},
        exec_target::{PreparedExecOwner, PreparedExecTarget},
        fd::OpenFileDescRef,
        gl_query_receipt::{self as wire, Control, Mode, Reply},
        gl_query_request::{GlQueryOwner, GlQueryRequest},
        ofd::FileType,
        process::ProcessState,
    };
    use alloc::{collections::VecDeque, vec, vec::Vec};
    use core::sync::atomic::{AtomicI64, Ordering};
    use wasm_posix_shared::{WasmStat, WasmStatfs, flags::O_RDONLY, mode::S_IFREG};
    static HANDLES: AtomicI64 = AtomicI64::new(50000);
    const IMAGE: &[u8] = b"\0asm\x01\0\0\0";

    struct Host {
        replies: VecDeque<Result<Vec<u8>, i32>>,
        controls: Vec<Control>,
        closed: Vec<i64>,
    }
    impl Host {
        fn new() -> Self {
            Self {
                replies: VecDeque::new(),
                controls: Vec::new(),
                closed: Vec::new(),
            }
        }
        fn reply(&mut self, token: i64, control: Control, mode: Option<Mode>, reply: Reply) {
            self.replies.push_back(Ok(wire::encode_reply(
                &reply,
                wire::ExpectedReply {
                    control,
                    token: token as u64,
                    capacity: 0,
                    retirement_mode: mode,
                },
            )
            .unwrap()));
        }
        fn retired(&mut self, token: i64) {
            self.reply(
                token,
                Control::Cancel,
                Some(Mode::Cancel),
                Reply::Retired {
                    mode: Mode::Cancel,
                    accepted: true,
                },
            );
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
        fn host_close(&mut self, h: i64) -> Result<(), Errno> {
            self.closed.push(h);
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
        fn host_pread(&mut self, _: i64, out: &mut [u8], offset: i64) -> Result<usize, Errno> {
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
        fn gl_query(&mut self, _: i32, op: u32, input: &[u8], out: &mut [u8], _: u32) -> i32 {
            assert_eq!(op, wasm_posix_shared::gl::KERNEL_GL_QUERY_CONTROL);
            self.controls
                .push(wire::decode_request(input).unwrap().control);
            match self.replies.pop_front().unwrap_or(Err(-5)) {
                Ok(bytes) => {
                    let n = bytes.len().min(out.len());
                    out[..n].copy_from_slice(&bytes[..n]);
                    bytes.len() as i32
                }
                Err(error) => error,
            }
        }
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
    /// Wrapper tests start with a captured query; renderer admission/current
    /// validation is independently covered by runtime-core. This fixture uses
    /// the actual OFD pin, BlockingRetryState and receipt engine, not a boolean
    /// substitute for pending native custody.
    fn admit(
        table: &mut ProcessTable,
        host: &mut Host,
        pid: u32,
        tid: u32,
        handle: i64,
    ) -> (i64, usize) {
        let proc = table.get_mut(pid).unwrap();
        let idx = proc.ofd_table.create(
            FileType::Regular,
            O_RDONLY,
            handle,
            b"/query-owner".to_vec(),
        );
        let id = proc.ofd_table.get(idx).unwrap().ofd_id;
        let fd = proc.fd_table.alloc(OpenFileDescRef(idx), 0).unwrap();
        let target = StableOfdTarget {
            original_fd: fd,
            ofd_idx: idx,
            ofd_id: id,
        };
        let request = GlQueryRequest::new(
            GlQueryOwner {
                target,
                pid: pid as i32,
                tid,
                session_id: 1,
                display_id: 1,
                context_id: Some(7),
                draw_surface_id: Some(0),
                read_surface_id: Some(0),
                pointer_width: 4,
            },
            wasm_posix_shared::gl::QOP_FINISH,
            vec![],
            0,
            0,
        )
        .unwrap();
        let token = proc.blocked_retries.prepare_insert().unwrap();
        proc.ofd_table.try_inc_ref_exact(idx, id).unwrap();
        assert!(
            proc.blocked_retries
                .insert_prepared(
                    token,
                    tid,
                    BlockingRetryOperation::GlQuery,
                    BlockingRetryTarget::GlQuery(request)
                )
                .is_ok()
        );
        host.reply(token, Control::Begin, None, Reply::Pending);
        assert!(matches!(
            syscalls::step_retained_gl_query(proc, host, tid, token),
            Ok(crate::gl_query_request::GlQueryProgress::PendingOwned)
        ));
        (token, idx)
    }
    fn prepare(
        table: &mut ProcessTable,
        pid: u32,
        owner: PreparedExecOwner,
        handle: i64,
    ) -> (u32, usize) {
        let proc = table.get_mut(pid).unwrap();
        let idx = proc
            .ofd_table
            .create(FileType::Regular, O_RDONLY, handle, b"/program".to_vec());
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
    fn pending(host: &mut Host, token: i64) {
        host.reply(
            token,
            Control::Cancel,
            Some(Mode::Cancel),
            Reply::Retiring(Mode::Cancel),
        );
    }

    #[test]
    fn exec_wrapper_keeps_prepared_target_and_generation_until_cleanup_ack() {
        for spawn in [false, true] {
            let (mut table, mut host, parent, base, _table_guard) = fixture();
            let pid = if spawn {
                table.fork_process_for_caller(parent, parent).unwrap()
            } else {
                parent
            };
            let owner = if spawn {
                PreparedExecOwner::Spawn {
                    parent_pid: parent,
                    child_pid: pid,
                    launch: 0,
                }
            } else {
                PreparedExecOwner::Process {
                    pid,
                    caller_tid: pid,
                    generation: 0,
                }
            };
            let (target, idx) = prepare(&mut table, pid, owner, base + 1);
            let (other, _) = prepare(&mut table, pid, owner, base + 2);
            let (token, _) = admit(&mut table, &mut host, pid, pid, base + 3);
            let request = if spawn {
                Request::SpawnExec {
                    parent,
                    child: pid,
                    target,
                }
            } else {
                Request::Exec {
                    pid,
                    tid: pid,
                    target,
                }
            };
            let mut intent = Intent::capture(&table, request).unwrap();
            pending(&mut host, token);
            assert!(matches!(
                intent.step(&mut table, &mut host),
                Ok(Progress::PendingOwned)
            ));
            let proc = table.get(pid).unwrap();
            assert_eq!(proc.exec_generation, 0);
            assert!(proc.exe.is_none());
            assert!(proc.prepared_exec_targets.get(target).is_ok());
            assert!(proc.prepared_exec_targets.get(other).is_ok());
            assert!(host.closed.is_empty());
            host.retired(token + 1);
            assert!(matches!(
                intent.step(&mut table, &mut host),
                Ok(Progress::ProtocolFaultOwned)
            ));
            assert!(
                table
                    .get(pid)
                    .unwrap()
                    .prepared_exec_targets
                    .get(target)
                    .is_ok()
            );
            host.retired(token);
            assert!(matches!(
                intent.step(&mut table, &mut host),
                Ok(Progress::Complete(Completion::Exec))
            ));
            let proc = table.get(pid).unwrap();
            assert_eq!(proc.exec_generation, 1);
            assert_eq!(proc.exe, Some(OpenFileDescRef(idx)));
            assert!(proc.prepared_exec_targets.get(target).is_err());
            assert!(proc.prepared_exec_targets.get(other).is_err());
            assert!(host.closed.contains(&(base + 2)));
            assert!(!host.closed.contains(&(base + 1)));
            let count = host.controls.len();
            assert!(matches!(
                intent.step(&mut table, &mut host),
                Err(Errno::EINVAL)
            ));
            assert_eq!(host.controls.len(), count);
        }
    }
    #[test]
    fn exit_wrapper_freezes_status_and_does_not_publish_while_owned() {
        for thread_worker in [false, true] {
            let (mut table, mut host, pid, base, _table_guard) = fixture();
            let tid = if thread_worker {
                table.create_thread(pid, pid, 0, 0, 0).unwrap()
            } else {
                pid
            };
            table.bind_current_tid(pid, tid).unwrap();
            let (token, _) = admit(&mut table, &mut host, pid, tid, base);
            let mut intent = Intent::capture(
                &table,
                Request::Exit {
                    pid,
                    tid,
                    status: 0x123,
                    thread_worker,
                },
            )
            .unwrap();
            pending(&mut host, token);
            assert!(matches!(
                intent.step(&mut table, &mut host),
                Ok(Progress::PendingOwned)
            ));
            assert_eq!(table.get(pid).unwrap().exit_status, 0);
            assert_eq!(table.get(pid).unwrap().state, ProcessState::Running);
            assert!(table.has_current_tid_binding(pid));
            assert!(host.closed.is_empty());
            host.retired(token);
            assert!(matches!(
                intent.step(&mut table, &mut host),
                Ok(Progress::Complete(Completion::Exit(0x23)))
            ));
            assert_eq!(
                table.get(pid).unwrap().state,
                if thread_worker {
                    ProcessState::Running
                } else {
                    ProcessState::Exited
                }
            );
        }
    }
    #[test]
    fn thread_exit_wrapper_cannot_return_ctid_or_remove_task_before_retirement() {
        let (mut table, mut host, pid, base, _table_guard) = fixture();
        let tid = table.create_thread(pid, pid, 0, 0, 0x2000).unwrap();
        let (token, _) = admit(&mut table, &mut host, pid, tid, base);
        let mut intent = Intent::capture(&table, Request::ThreadExit { pid, tid }).unwrap();
        pending(&mut host, token);
        assert!(matches!(
            intent.step(&mut table, &mut host),
            Ok(Progress::PendingOwned)
        ));
        assert_eq!(
            table.get(pid).unwrap().get_thread(tid).unwrap().ctid_ptr,
            0x2000
        );
        host.retired(token);
        assert!(matches!(
            intent.step(&mut table, &mut host),
            Ok(Progress::Complete(Completion::ThreadExit(0x2000)))
        ));
        assert!(table.get(pid).unwrap().get_thread(tid).is_none());
    }
    #[test]
    fn remove_and_reap_wrappers_keep_record_and_cleanup_effects_until_ack() {
        for reap in [false, true] {
            let (mut table, mut host, pid, base, _table_guard) = fixture();
            let (token, idx) = admit(&mut table, &mut host, pid, pid, base);
            let mut intent = Intent::capture(&table, Request::Remove { pid, reap }).unwrap();
            pending(&mut host, token);
            assert!(matches!(
                intent.step(&mut table, &mut host),
                Ok(Progress::PendingOwned)
            ));
            assert_eq!(
                table
                    .get(pid)
                    .unwrap()
                    .ofd_table
                    .get(idx)
                    .unwrap()
                    .ref_count,
                2
            );
            assert!(host.closed.is_empty());
            host.retired(token);
            let completion = intent.step(&mut table, &mut host).unwrap();
            let Progress::Complete(Completion::Removed(removal)) = completion else {
                panic!("completed removal");
            };
            assert!(removal.host_closes.contains(&base));
            assert!(
                host.closed.is_empty(),
                "host cleanup is owned by the completion, not a pending intent"
            );
            assert!(table.get(pid).is_none());
        }
    }
    #[test]
    fn retry_release_wrapper_keeps_exact_token_and_pin_through_protocol_failure() {
        let (mut table, mut host, pid, base, _table_guard) = fixture();
        let (token, idx) = admit(&mut table, &mut host, pid, pid, base);
        let mut wrong = Intent::capture(
            &table,
            Request::ReleaseRetry {
                pid,
                tid: pid,
                token: token + 1,
            },
        )
        .unwrap();
        assert!(matches!(
            wrong.step(&mut table, &mut host),
            Err(Errno::ENOENT)
        ));
        assert_eq!(host.controls, vec![Control::Begin]);
        let mut intent = Intent::capture(
            &table,
            Request::ReleaseRetry {
                pid,
                tid: pid,
                token,
            },
        )
        .unwrap();
        host.replies.push_back(Ok(vec![0; 32]));
        assert!(matches!(
            intent.step(&mut table, &mut host),
            Ok(Progress::ProtocolFaultOwned)
        ));
        assert_eq!(
            table
                .get(pid)
                .unwrap()
                .ofd_table
                .get(idx)
                .unwrap()
                .ref_count,
            2
        );
        host.retired(token);
        assert!(matches!(
            intent.step(&mut table, &mut host),
            Ok(Progress::Complete(Completion::RetryReleased))
        ));
        assert!(
            table
                .get(pid)
                .unwrap()
                .blocked_retries
                .binding_for_token(token)
                .is_none()
        );
        assert_eq!(
            table
                .get(pid)
                .unwrap()
                .ofd_table
                .get(idx)
                .unwrap()
                .ref_count,
            1
        );
    }
    #[test]
    fn signal_exit_wrapper_preserves_signal_bookkeeping_until_actual_cleanup() {
        let (mut table, mut host, pid, base, _table_guard) = fixture();
        let (token, _) = admit(&mut table, &mut host, pid, pid, base);
        table.get_mut(pid).unwrap().caught_handler_depth = 4;
        let mut intent = Intent::capture(&table, Request::SignalExit { pid, signum: 9 }).unwrap();
        pending(&mut host, token);
        assert!(matches!(
            intent.step(&mut table, &mut host),
            Ok(Progress::PendingOwned)
        ));
        assert_eq!(table.get(pid).unwrap().caught_handler_depth, 4);
        assert_eq!(table.get(pid).unwrap().exit_signal, 0);
        host.retired(token);
        assert!(matches!(
            intent.step(&mut table, &mut host),
            Ok(Progress::Complete(Completion::Signaled))
        ));
        assert_eq!(table.get(pid).unwrap().exit_signal, 9);
        assert_eq!(table.get(pid).unwrap().state, ProcessState::Exited);
    }
    #[test]
    fn stale_generation_intent_cannot_cancel_a_replacement_images_receipt() {
        let (mut table, mut host, pid, base, _table_guard) = fixture();
        let mut stale = Intent::capture(&table, Request::Remove { pid, reap: false }).unwrap();
        table.get_mut(pid).unwrap().exec_generation = 1;
        let (token, _) = admit(&mut table, &mut host, pid, pid, base);
        assert!(matches!(
            stale.step(&mut table, &mut host),
            Err(Errno::ESRCH)
        ));
        assert_eq!(host.controls, vec![Control::Begin]);
        let mut fresh = Intent::capture(
            &table,
            Request::ReleaseRetry {
                pid,
                tid: pid,
                token,
            },
        )
        .unwrap();
        host.retired(token);
        assert!(matches!(
            fresh.step(&mut table, &mut host),
            Ok(Progress::Complete(Completion::RetryReleased))
        ));
    }
    #[test]
    fn legacy_wrapper_cannot_report_pending_removal_as_success_or_esrch() {
        let (mut table, mut host, pid, base, _table_guard) = fixture();
        let (token, _) = admit(&mut table, &mut host, pid, pid, base);
        pending(&mut host, token);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| legacy(
                &mut table,
                &mut host,
                Request::Remove { pid, reap: false }
            )))
            .is_err()
        );
        assert!(table.get(pid).is_some());
        assert!(host.closed.is_empty());
        let mut intent = Intent::capture(&table, Request::Remove { pid, reap: false }).unwrap();
        host.retired(token);
        assert!(matches!(
            intent.step(&mut table, &mut host),
            Ok(Progress::Complete(Completion::Removed(_)))
        ));
    }
    #[test]
    fn init_reap_wrapper_keeps_existing_child_and_absence_error_contract() {
        let (mut table, mut host, _pid, _base, _table_guard) = fixture();
        let child = table
            .create_init_child(vec![b"/init-child".to_vec()])
            .unwrap();
        assert!(matches!(
            legacy(&mut table, &mut host, Request::ReapInit { pid: child }),
            Err(Errno::ECHILD)
        ));
        assert!(table.get(child).is_some());
        let (proc, locks) = table.process_and_advisory_locks(child).unwrap();
        syscalls::sys_exit_with_locks(proc, locks, &mut host, 42);
        match legacy(&mut table, &mut host, Request::ReapInit { pid: child }).unwrap() {
            Completion::InitReaped(reap) => {
                assert_eq!(reap.pid, child);
                assert_eq!(reap.exit_status, 42);
            }
            _ => panic!("init reap completion"),
        }
        assert!(table.get(child).is_none());
    }
    #[test]
    fn invalid_exec_owner_preserves_main_consumption_without_canceling_another_query() {
        let (mut table, mut host, pid, base, _table_guard) = fixture();
        let other = table.create_thread(pid, pid, 0, 0, 0).unwrap();
        let (target, _) = prepare(
            &mut table,
            pid,
            PreparedExecOwner::Process {
                pid,
                caller_tid: pid,
                generation: 0,
            },
            base + 1,
        );
        let (token, _) = admit(&mut table, &mut host, pid, pid, base + 2);
        let mut invalid = Intent::capture(
            &table,
            Request::Exec {
                pid,
                tid: other,
                target,
            },
        )
        .unwrap();
        assert!(matches!(
            invalid.step(&mut table, &mut host),
            Err(Errno::EINVAL)
        ));
        assert!(
            table
                .get(pid)
                .unwrap()
                .prepared_exec_targets
                .get(target)
                .is_err()
        );
        assert!(host.closed.contains(&(base + 1)));
        assert_eq!(host.controls, vec![Control::Begin]);
        assert!(
            table
                .get(pid)
                .unwrap()
                .blocked_retries
                .has_external_query_receipts()
        );
        let mut cleanup = Intent::capture(
            &table,
            Request::ReleaseRetry {
                pid,
                tid: pid,
                token,
            },
        )
        .unwrap();
        host.retired(token);
        assert!(matches!(
            cleanup.step(&mut table, &mut host),
            Ok(Progress::Complete(Completion::RetryReleased))
        ));
    }
}

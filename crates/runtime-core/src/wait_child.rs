//! `wait4` / `waitid`, owned by the kernel.
//!
//! # Why this exists
//!
//! Until step 3 of `docs/plans/2026-09-27-guest-waits-into-rust.md`, both
//! syscalls never reached the kernel on Node or in the browser: the host
//! intercepted them, asked the kernel for a child status
//! (`kernel_wait_child_poll`), and when there was none it kept the blocked
//! channel in a host list that a dozen host call sites had to remember to
//! re-poll -- after a child exit, an auto-reap, a `setpgid`, a signal, a
//! `tkill`, a cancellation. The native host had a third copy, with its own
//! child bookkeeping. Every one of those decisions is kernel state: which
//! child changed, whether it matches the waiter, and whether a signal came
//! first.
//!
//! Now the kernel answers the syscall, parks the caller in
//! [`crate::wait_park`] when no child is ready, and re-decides parked waiters
//! itself whenever a child's waitable state changes
//! ([`crate::wait_park::note_children_changed`] is called from each mutation
//! of that state). The host only publishes the result.
//!
//! # Where the result goes
//!
//! Both syscalls carry their output pointers as raw caller addresses (channel
//! scalar contract): the status, `siginfo_t` and `rusage` are written through
//! the kernel's cross-memory primitive when the wait is decided, which for a
//! parked waiter is long after any per-call staging is gone. The addresses
//! are probed when the syscall starts, so a bad pointer is `EFAULT` before
//! any child status is consumed, as it was when the host checked them.

use wasm_posix_shared::wait::{
    EVENT_CONTINUED, EVENT_EXITED, EVENT_STOPPED, WCONTINUED, WEXITED, WNOHANG, WNOWAIT, WSTOPPED,
    WUNTRACED,
};
use wasm_posix_shared::{signal::SIGCHLD, Errno, KernelRusage, WASM_RUSAGE_WIRE_SIZE};

use crate::process::{ChildWaitEvent, HostIO};
use crate::process_table::ProcessTable;
use crate::process_wire::{write_siginfo, NativeSiginfo, ProcessDataModel};
use crate::syscalls::GuestTask;

/// `waitid` id types (Linux values; musl passes them through).
pub const P_ALL: u32 = 0;
pub const P_PID: u32 = 1;
pub const P_PGID: u32 = 2;

/// Where a decided wait writes its answer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChildWaitOutput {
    /// `wait4(pid, status, options, rusage)`: both optional.
    Wait4 { status: u64, rusage: u64 },
    /// `waitid(idtype, id, info, options, rusage)`: `info` is required.
    Waitid { siginfo: u64, rusage: u64 },
}

/// One `wait4` / `waitid` request, validated.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ChildWait {
    /// waitpid-style target: `> 0` one pid, `-1` any child, `0` the caller's
    /// group, `< -1` the group `-target`.
    pub target: i32,
    /// `wait::EVENT_*` bits this wait accepts.
    pub event_mask: u32,
    /// `WNOWAIT`: report without consuming.
    pub peek: bool,
    pub nohang: bool,
    pub output: ChildWaitOutput,
}

impl ChildWait {
    /// Validate `wait4`'s arguments. Pointers are checked by [`Self::probe`].
    pub fn wait4(pid: i32, status: u64, options: u32, rusage: u64) -> Result<Self, Errno> {
        if options & !(WNOHANG | WUNTRACED | WSTOPPED | WCONTINUED) != 0 {
            return Err(Errno::EINVAL);
        }
        // `INT_MIN` names no process group (Linux: ESRCH); its negation
        // would overflow.
        if pid == i32::MIN {
            return Err(Errno::ESRCH);
        }
        let mut event_mask = EVENT_EXITED;
        if options & (WUNTRACED | WSTOPPED) != 0 {
            event_mask |= EVENT_STOPPED;
        }
        if options & WCONTINUED != 0 {
            event_mask |= EVENT_CONTINUED;
        }
        Ok(Self {
            target: pid,
            event_mask,
            peek: false,
            nohang: options & WNOHANG != 0,
            output: ChildWaitOutput::Wait4 { status, rusage },
        })
    }

    /// Validate `waitid`'s arguments. Pointers are checked by [`Self::probe`].
    pub fn waitid(idtype: u32, id: i64, options: u32, siginfo: u64, rusage: u64) -> Result<Self, Errno> {
        let allowed = WNOHANG | WNOWAIT | WEXITED | WSTOPPED | WUNTRACED | WCONTINUED;
        if options & !allowed != 0 {
            return Err(Errno::EINVAL);
        }
        let target = match idtype {
            P_PID if id > 0 && id <= i64::from(i32::MAX) => id as i32,
            P_PGID if id == 0 => 0,
            P_PGID if id > 0 && id <= i64::from(i32::MAX) => -(id as i32),
            P_ALL => -1,
            _ => return Err(Errno::EINVAL),
        };
        let mut event_mask = 0;
        if options & WEXITED != 0 {
            event_mask |= EVENT_EXITED;
        }
        if options & (WSTOPPED | WUNTRACED) != 0 {
            event_mask |= EVENT_STOPPED;
        }
        if options & WCONTINUED != 0 {
            event_mask |= EVENT_CONTINUED;
        }
        if event_mask == 0 {
            return Err(Errno::EINVAL);
        }
        Ok(Self {
            target,
            event_mask,
            peek: options & WNOWAIT != 0,
            nohang: options & WNOHANG != 0,
            output: ChildWaitOutput::Waitid { siginfo, rusage },
        })
    }

    /// Fix "the caller's process group" (`pid == 0`, `P_PGID` with id 0) to
    /// the group the caller is in now, at the call.
    ///
    /// Linux resolves it once, at call entry; a parked wait keeps waiting on
    /// that group even if the caller later changes its own. Re-reading it on
    /// every re-poll would let a `setpgid` by the waiter redirect a wait that
    /// is already in progress.
    pub fn freeze_caller_group(mut self, caller_pgid: u32) -> Self {
        if self.target == 0 {
            if let Ok(pgid) = i32::try_from(caller_pgid) {
                self.target = -pgid;
            }
        }
        self
    }

    /// `EFAULT` unless every output range is addressable in the caller.
    ///
    /// Wasm memory has no write-only or read-only pages, so a range the
    /// kernel can read is a range it can later write.
    pub fn probe(&self, host: &mut dyn HostIO, task: GuestTask) -> Result<(), Errno> {
        let model = data_model(task)?;
        let mut check = |addr: u64, len: usize, required: bool| -> Result<(), Errno> {
            if addr == 0 {
                return if required { Err(Errno::EFAULT) } else { Ok(()) };
            }
            let mut scratch = [0u8; 160];
            if host.proc_read_bytes(task.pid as i32, addr, &mut scratch[..len]) < 0 {
                return Err(Errno::EFAULT);
            }
            Ok(())
        };
        match self.output {
            ChildWaitOutput::Wait4 { status, rusage } => {
                check(status, 4, false)?;
                check(rusage, WASM_RUSAGE_WIRE_SIZE as usize, false)
            }
            ChildWaitOutput::Waitid { siginfo, rusage } => {
                check(siginfo, model.siginfo_size(), true)?;
                check(rusage, WASM_RUSAGE_WIRE_SIZE as usize, false)
            }
        }
    }

    /// Select a waitable child of `task`, consuming its event unless this is
    /// a `WNOWAIT` peek. `Ok(None)`: a matching child exists but has nothing
    /// to report. `ECHILD`: no matching child.
    pub fn poll(
        &self,
        table: &mut ProcessTable,
        task: GuestTask,
    ) -> Result<Option<(u32, ChildWaitEvent)>, Errno> {
        table.validate_task(task.pid, task.tid)?;
        table.poll_wait_event(
            task.pid,
            self.target,
            self.event_mask,
            if self.peek { WNOWAIT } else { 0 },
        )
    }

    /// Whether reporting `event` releases the child's zombie.
    pub fn reaps(&self, event: &ChildWaitEvent) -> bool {
        !self.peek && event.event_mask == EVENT_EXITED
    }

    /// Write the answer for `child`'s `event` into the caller and return the
    /// syscall's value.
    pub fn report(
        &self,
        host: &mut dyn HostIO,
        task: GuestTask,
        child: u32,
        event: &ChildWaitEvent,
    ) -> Result<i32, Errno> {
        let model = data_model(task)?;
        let mut write = |addr: u64, bytes: &[u8]| -> Result<(), Errno> {
            if addr != 0 && host.proc_write_bytes(task.pid as i32, addr, bytes) < 0 {
                return Err(Errno::EFAULT);
            }
            Ok(())
        };
        match self.output {
            ChildWaitOutput::Wait4 { status, rusage } => {
                write(status, &event.wait_status.to_le_bytes())?;
                write(rusage, &rusage_bytes(&event.rusage))?;
                Ok(child as i32)
            }
            ChildWaitOutput::Waitid { siginfo, rusage } => {
                let mut info = [0u8; 160];
                let info = &mut info[..model.siginfo_size()];
                write_siginfo(
                    info,
                    NativeSiginfo {
                        signo: SIGCHLD as i32,
                        code: event.si_code,
                        word_1: child as i32,
                        word_2_bits: event.child_uid,
                        // si_status shares the union slot of si_value.
                        value_bits: u64::from(event.si_status as u32),
                    },
                    model,
                )?;
                write(siginfo, info)?;
                write(rusage, &rusage_bytes(&event.rusage))?;
                Ok(0)
            }
        }
    }

    /// The answer when nothing is ready and the caller said `WNOHANG`.
    /// `waitid` zeroes `info` so the caller can tell (POSIX: `si_pid == 0`).
    pub fn report_nothing(&self, host: &mut dyn HostIO, task: GuestTask) -> Result<i32, Errno> {
        if let ChildWaitOutput::Waitid { siginfo, .. } = self.output {
            let zero = [0u8; 160];
            let len = data_model(task)?.siginfo_size();
            if host.proc_write_bytes(task.pid as i32, siginfo, &zero[..len]) < 0 {
                return Err(Errno::EFAULT);
            }
        }
        Ok(0)
    }
}

/// What announcing one recorded exit to its parent requires of the caller.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExitNotice {
    /// Announced (SIGCHLD generated), or there is no parent to tell.
    Done,
    /// The parent asked not to keep zombies (SA_NOCLDWAIT, or SIGCHLD set to
    /// SIG_IGN): reap the child; no SIGCHLD is generated.
    AutoReap,
    /// The child is an unpublished `posix_spawn` child: hidden from its parent
    /// until publication, so announce it later.
    Defer,
}

/// Whether a process asked not to keep zombie children.
///
/// POSIX: SA_NOCLDWAIT on SIGCHLD, or SIGCHLD explicitly set to SIG_IGN
/// (the default disposition, also "ignore", does NOT imply it).
pub fn parent_discards_zombies(parent: &crate::process::Process) -> bool {
    let action = parent.signals.get_action(SIGCHLD);
    action.flags & wasm_posix_shared::signal::SA_NOCLDWAIT != 0
        || matches!(action.handler, crate::signal::SignalHandler::Ignore)
}

/// Announce `child`'s recorded exit to its parent, as Linux's exit_notify
/// does: generate SIGCHLD carrying the child's pid, uid and status, unless
/// the parent discards zombies, in which case the caller reaps the child.
///
/// The kernel runs this before re-deciding any parked wait, so a parent's
/// `waitpid` never returns an exit whose SIGCHLD has not been generated --
/// its handler runs as `waitpid` returns.
pub fn announce_exit(table: &mut ProcessTable, child: u32) -> ExitNotice {
    let (ppid, uid, code, status) = match table.get(child) {
        Some(proc) if proc.state == crate::process::ProcessState::Exited => {
            if proc.spawn_publication_pending {
                return ExitNotice::Defer;
            }
            let (code, status) = match proc.wait_event {
                Some(event) => (event.si_code, event.si_status),
                None => (wasm_posix_shared::wait::CLD_EXITED, proc.exit_status),
            };
            (proc.ppid, proc.real_uid(), code, status)
        }
        // Already reaped (or never a zombie): nothing to announce.
        _ => return ExitNotice::Done,
    };
    let Some(parent) = table.get_mut(ppid) else {
        return ExitNotice::Done;
    };
    if !matches!(
        parent.state,
        crate::process::ProcessState::Running | crate::process::ProcessState::Stopped
    ) {
        return ExitNotice::Done;
    }
    let discards = parent_discards_zombies(parent);
    // Linux (do_notify_parent): SA_NOCLDWAIT only suppresses the zombie; a
    // caught SIGCHLD is still sent. Only SIG_IGN suppresses the signal. POSIX
    // leaves it unspecified.
    let ignored = matches!(
        parent.signals.get_action(SIGCHLD).handler,
        crate::signal::SignalHandler::Ignore
    );
    if !ignored {
        parent.raise_signal_with_metadata(SIGCHLD, u64::from(status as u32), code, child, uid);
    }
    if discards { ExitNotice::AutoReap } else { ExitNotice::Done }
}

fn data_model(task: GuestTask) -> Result<ProcessDataModel, Errno> {
    ProcessDataModel::from_width(i64::from(task.pointer_width))
}

/// The eighteen little-endian `i64` slots of the rusage wire record.
pub fn rusage_bytes(rusage: &KernelRusage) -> [u8; WASM_RUSAGE_WIRE_SIZE as usize] {
    let slots = [
        rusage.ru_utime_sec,
        rusage.ru_utime_usec,
        rusage.ru_stime_sec,
        rusage.ru_stime_usec,
        rusage.ru_maxrss,
        rusage.ru_ixrss,
        rusage.ru_idrss,
        rusage.ru_isrss,
        rusage.ru_minflt,
        rusage.ru_majflt,
        rusage.ru_nswap,
        rusage.ru_inblock,
        rusage.ru_oublock,
        rusage.ru_msgsnd,
        rusage.ru_msgrcv,
        rusage.ru_nsignals,
        rusage.ru_nvcsw,
        rusage.ru_nivcsw,
    ];
    let mut out = [0u8; WASM_RUSAGE_WIRE_SIZE as usize];
    for (i, slot) in slots.iter().enumerate() {
        out[i * 8..i * 8 + 8].copy_from_slice(&slot.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::process_table::ProcessTable;

    #[test]
    fn wait4_rejects_unknown_options_and_maps_events() {
        assert_eq!(ChildWait::wait4(-1, 0, 0x40, 0), Err(Errno::EINVAL));
        let w = ChildWait::wait4(-1, 0, WUNTRACED | WCONTINUED | WNOHANG, 0).unwrap();
        assert_eq!(w.event_mask, EVENT_EXITED | EVENT_STOPPED | EVENT_CONTINUED);
        assert!(w.nohang);
        assert!(!w.peek);
        assert_eq!(ChildWait::wait4(-1, 0, 0, 0).unwrap().event_mask, EVENT_EXITED);
    }

    #[test]
    fn waitid_maps_id_types_and_requires_an_event() {
        let pgid = ChildWait::waitid(P_PGID, 7, WEXITED, 8, 0).unwrap();
        assert_eq!(pgid.target, -7);
        assert_eq!(ChildWait::waitid(P_PGID, 0, WEXITED, 8, 0).unwrap().target, 0);
        assert_eq!(ChildWait::waitid(P_ALL, 99, WEXITED, 8, 0).unwrap().target, -1);
        assert_eq!(ChildWait::waitid(P_PID, 0, WEXITED, 8, 0), Err(Errno::EINVAL));
        assert_eq!(ChildWait::waitid(9, 1, WEXITED, 8, 0), Err(Errno::EINVAL));
        assert_eq!(ChildWait::waitid(P_ALL, 0, WNOHANG, 8, 0), Err(Errno::EINVAL));
        assert!(ChildWait::waitid(P_ALL, 0, WEXITED | WNOWAIT, 8, 0).unwrap().peek);
    }

    fn family() -> (ProcessTable, u32, u32) {
        let mut table = ProcessTable::new();
        let parent = table.create_process().unwrap();
        let child = table.create_process().unwrap();
        table.get_mut(child).unwrap().ppid = parent;
        (table, parent, child)
    }

    #[test]
    fn a_running_child_keeps_the_wait_pending_and_none_is_echild() {
        let (mut table, parent, child) = family();
        let task = GuestTask::wasm32(parent, parent);
        let any = ChildWait::wait4(-1, 0, 0, 0).unwrap();
        assert_eq!(any.poll(&mut table, task), Ok(None));
        let other = ChildWait::wait4(child as i32 + 100, 0, 0, 0).unwrap();
        assert_eq!(other.poll(&mut table, task), Err(Errno::ECHILD));
    }

    #[test]
    fn a_peek_leaves_the_exit_and_a_wait_consumes_it() {
        let (mut table, parent, child) = family();
        assert!(table.get_mut(child).unwrap().record_normal_exit(3));
        let task = GuestTask::wasm32(parent, parent);
        let peek = ChildWait::waitid(P_PID, i64::from(child), WEXITED | WNOWAIT, 8, 0).unwrap();
        let (pid, event) = peek.poll(&mut table, task).unwrap().unwrap();
        assert_eq!(pid, child);
        assert!(!peek.reaps(&event), "WNOWAIT never reaps");
        let wait = ChildWait::wait4(child as i32, 0, 0, 0).unwrap();
        let (_, event) = wait.poll(&mut table, task).unwrap().unwrap();
        assert_eq!(event.wait_status, 3 << 8);
        assert!(wait.reaps(&event));
        assert_eq!(wait.poll(&mut table, task), Ok(None), "the event is consumed");
    }

    #[test]
    fn a_stop_is_reported_only_to_a_wait_that_asked_for_it() {
        let (mut table, parent, child) = family();
        table.get_mut(child).unwrap().record_stop(wasm_posix_shared::signal::SIGSTOP);
        let task = GuestTask::wasm32(parent, parent);
        assert_eq!(ChildWait::wait4(-1, 0, 0, 0).unwrap().poll(&mut table, task), Ok(None));
        let untraced = ChildWait::wait4(-1, 0, WUNTRACED, 0).unwrap();
        let (_, event) = untraced.poll(&mut table, task).unwrap().unwrap();
        assert_eq!(event.event_mask, EVENT_STOPPED);
        assert!(!untraced.reaps(&event), "a stop never reaps");
    }

    #[test]
    fn recording_a_child_state_marks_child_waits_for_a_re_poll() {
        let (mut table, _parent, child) = family();
        crate::wait_park::with(|p| p.take_dirty_child_waiters());
        assert!(table.get_mut(child).unwrap().record_normal_exit(0));
        assert!(
            crate::wait_park::with(|p| p.take_dirty_child_waiters()).is_some(),
            "an exit must make parked waiters re-poll"
        );
        table.remove_process(child);
        assert!(
            crate::wait_park::with(|p| p.take_dirty_child_waiters()).is_some(),
            "a removal can turn a wait into ECHILD"
        );
    }

    #[test]
    fn the_callers_group_is_fixed_when_the_wait_starts() {
        let own = ChildWait::wait4(0, 0, 0, 0).unwrap().freeze_caller_group(9);
        assert_eq!(own.target, -9);
        let pgid0 = ChildWait::waitid(P_PGID, 0, WEXITED, 8, 0).unwrap().freeze_caller_group(9);
        assert_eq!(pgid0.target, -9);
        let one = ChildWait::wait4(5, 0, 0, 0).unwrap().freeze_caller_group(9);
        assert_eq!(one.target, 5, "an explicit target is left alone");
    }

    fn catch_sigchld(proc: &mut crate::process::Process, flags: u32, handler: crate::signal::SignalHandler) {
        proc.signals
            .set_action(
                SIGCHLD,
                crate::signal::SignalAction { handler, flags, mask: 0 },
            )
            .unwrap();
    }

    #[test]
    fn an_exit_sends_the_parent_sigchld_with_the_childs_status() {
        let (mut table, parent, child) = family();
        catch_sigchld(table.get_mut(parent).unwrap(), 0, crate::signal::SignalHandler::Handler(9));
        assert!(table.get_mut(child).unwrap().record_normal_exit(7));
        assert_eq!(announce_exit(&mut table, child), ExitNotice::Done);
        let proc = table.get_mut(parent).unwrap();
        assert_ne!(proc.pending_for(parent) & crate::signal::sig_bit(SIGCHLD), 0);
        let info = proc.consume_signal_for(parent, SIGCHLD).expect("pending");
        assert_eq!(info.sender_pid, child);
        assert_eq!(info.si_code, wasm_posix_shared::wait::CLD_EXITED);
        assert_eq!(info.si_value_bits, 7, "si_status rides in the value slot");
        assert!(table.get(child).is_some(), "a caught SIGCHLD keeps the zombie");
    }

    #[test]
    fn a_parent_that_discards_zombies_gets_an_auto_reap() {
        // SIG_IGN: reaped, no signal.
        let (mut table, parent, child) = family();
        catch_sigchld(table.get_mut(parent).unwrap(), 0, crate::signal::SignalHandler::Ignore);
        assert!(table.get_mut(child).unwrap().record_signal_exit(9));
        assert_eq!(announce_exit(&mut table, child), ExitNotice::AutoReap);
        assert_eq!(table.get(parent).unwrap().pending_for(parent) & crate::signal::sig_bit(SIGCHLD), 0);
        // SA_NOCLDWAIT with a handler: reaped, and (as on Linux) still signalled.
        let (mut table, parent, child) = family();
        catch_sigchld(
            table.get_mut(parent).unwrap(),
            wasm_posix_shared::signal::SA_NOCLDWAIT,
            crate::signal::SignalHandler::Handler(9),
        );
        assert!(table.get_mut(child).unwrap().record_normal_exit(0));
        assert_eq!(announce_exit(&mut table, child), ExitNotice::AutoReap);
        assert_ne!(table.get(parent).unwrap().pending_for(parent) & crate::signal::sig_bit(SIGCHLD), 0);
    }

    #[test]
    fn an_unpublished_spawn_child_is_announced_after_publication() {
        let (mut table, _parent, child) = family();
        table.get_mut(child).unwrap().spawn_publication_pending = true;
        assert!(table.get_mut(child).unwrap().record_normal_exit(0));
        assert_eq!(announce_exit(&mut table, child), ExitNotice::Defer);
        table.get_mut(child).unwrap().spawn_publication_pending = false;
        assert_eq!(announce_exit(&mut table, child), ExitNotice::Done);
    }

    #[test]
    fn a_child_of_init_is_left_for_inits_own_reap() {
        // Synthetic init ignores SIGCHLD, but it is not an ordinary parent
        // that discards zombies: it reaps a child only once the host has
        // published the exit (`ProcessTable::publish_process_exit`), and that
        // reap tells a kernel-started child's owner how it ended
        // (`InitReap`). Announcing must not reap it first; it does not,
        // because `ProcessTable::get_mut` never hands out init.
        let mut table = ProcessTable::new();
        let child = table.create_init_child(vec![b"agent".to_vec()]).unwrap();
        table.get_mut(child).unwrap().spawn_publication_pending = false;
        assert!(table.get_mut(child).unwrap().record_normal_exit(3));
        assert_eq!(announce_exit(&mut table, child), ExitNotice::Done);
        assert!(table.get(child).is_some(), "init has not reaped it yet");
        let publication = table.publish_process_exit(child).unwrap();
        let reap = publication.reaped_by_init.expect("init reaps on publication");
        assert_eq!((reap.pid, reap.exit_status, reap.exit_signal), (child, 3, 0));
    }

    #[test]
    fn recording_an_exit_queues_exactly_one_notice() {
        let (mut table, _parent, child) = family();
        crate::wait_park::take_exit_notices();
        assert!(table.get_mut(child).unwrap().record_normal_exit(0));
        assert!(!table.get_mut(child).unwrap().record_signal_exit(9), "a zombie exits once");
        assert_eq!(crate::wait_park::take_exit_notices(), vec![child]);
    }

    #[test]
    fn rusage_bytes_are_eighteen_le_slots() {
        let mut r = KernelRusage::default();
        r.ru_utime_sec = 3;
        r.ru_nivcsw = -2;
        let b = rusage_bytes(&r);
        assert_eq!(i64::from_le_bytes(b[0..8].try_into().unwrap()), 3);
        assert_eq!(i64::from_le_bytes(b[136..144].try_into().unwrap()), -2);
    }
}

//! CPU-time accounting: what `getrusage()`, `times()`, `clock()`, the
//! CPU-time clocks and `wait4()`'s resource usage report.
//!
//! Wasm hosts expose no per-thread CPU clock, so the host measures each task
//! (thread) at its syscall boundaries, identically on Node.js and in
//! browsers:
//!
//! - **user time** is the wall-clock time from the completion of one of the
//!   task's syscalls to the kernel worker taking up its next one. It is the
//!   time the task spends running guest code, and it also includes any time
//!   the host did not schedule the task's worker and the time a request
//!   waited for the kernel worker to take it up.
//! - **system time** is the time the kernel worker spends handling the
//!   task's syscall requests.
//!
//! Time a task spends blocked in a syscall is neither. Accounting starts when
//! the task's first syscall completes, so worker start-up is not charged.
//!
//! A process's own usage is the sum over all of its tasks, past and present,
//! and survives `exec`. The kernel freezes it when the process exits. When a
//! parent consumes the exit with a wait, the child's own usage and that of
//! its own waited-for descendants are added to the parent's children usage,
//! as POSIX requires for `RUSAGE_CHILDREN` and `tms_cutime`/`tms_cstime`;
//! children reaped without a wait (`SIGCHLD` ignored, `SA_NOCLDWAIT`, init)
//! are not counted.

use crate::process::{HostIO, Process, ProcessState};
use crate::process_table::ProcessTable;
use wasm_posix_shared::{Errno, KernelRusage};

const NS_PER_SEC: u64 = 1_000_000_000;

/// User and system CPU time in nanoseconds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CpuTime {
    pub user_ns: u64,
    pub system_ns: u64,
}

impl CpuTime {
    pub fn saturating_add(self, other: Self) -> Self {
        CpuTime {
            user_ns: self.user_ns.saturating_add(other.user_ns),
            system_ns: self.system_ns.saturating_add(other.system_ns),
        }
    }

    pub fn total_ns(self) -> u64 {
        self.user_ns.saturating_add(self.system_ns)
    }

    /// The rusage wire record for this usage: `ru_utime` and `ru_stime`.
    /// Kandelo measures no other `struct rusage` field; they stay zero.
    pub fn rusage(self) -> KernelRusage {
        let (user_sec, user_usec) = seconds_and_micros(self.user_ns);
        let (system_sec, system_usec) = seconds_and_micros(self.system_ns);
        KernelRusage {
            ru_utime_sec: user_sec,
            ru_utime_usec: user_usec,
            ru_stime_sec: system_sec,
            ru_stime_usec: system_usec,
            ..KernelRusage::default()
        }
    }

    /// `(seconds, nanoseconds)` of the total, as a CPU-time clock reads it.
    pub fn timespec(self) -> (i64, i64) {
        let total = self.total_ns();
        (i64::try_from(total / NS_PER_SEC).unwrap_or(i64::MAX), (total % NS_PER_SEC) as i64)
    }
}

fn seconds_and_micros(ns: u64) -> (i64, i64) {
    (
        i64::try_from(ns / NS_PER_SEC).unwrap_or(i64::MAX),
        ((ns % NS_PER_SEC) / 1_000) as i64,
    )
}

/// A process's own usage: frozen at exit, otherwise measured by the host now.
pub fn process_usage(proc: &Process, host: &mut dyn HostIO) -> CpuTime {
    match proc.cpu_at_exit {
        Some(usage) => usage,
        None => host.host_task_cpu_time(proc.pid, 0).unwrap_or_default(),
    }
}

/// Freeze `proc`'s own usage as it exits. Its tasks may still be running on
/// the host at this point; the host includes their current intervals.
pub fn freeze_at_exit(proc: &mut Process, host: &mut dyn HostIO) {
    if proc.cpu_at_exit.is_none() {
        proc.cpu_at_exit = Some(host.host_task_cpu_time(proc.pid, 0).unwrap_or_default());
    }
}

/// What a wait reports for `child`: its own usage plus that of its
/// terminated, waited-for descendants, as Linux's `wait4()` does.
pub fn wait_usage(child: &Process, host: &mut dyn HostIO) -> CpuTime {
    process_usage(child, host).saturating_add(child.cpu_children)
}

/// Charge the exited `child` that `parent` is consuming with a wait to the
/// parent's children usage. Returns the usage charged.
pub fn charge_waited_child(table: &mut ProcessTable, parent: u32, child: u32, host: &mut dyn HostIO) -> CpuTime {
    let Some(usage) = table.get(child).map(|child| wait_usage(child, host)) else {
        return CpuTime::default();
    };
    if let Some(parent) = table.get_mut(parent) {
        parent.cpu_children = parent.cpu_children.saturating_add(usage);
    }
    usage
}

/// What `getrusage(who)` reports for `proc`.
pub fn getrusage(proc: &Process, host: &mut dyn HostIO, who: i32) -> Result<KernelRusage, Errno> {
    use wasm_posix_shared::rusage::{RUSAGE_CHILDREN, RUSAGE_SELF};
    match who {
        RUSAGE_SELF => Ok(process_usage(proc, host).rusage()),
        RUSAGE_CHILDREN => Ok(proc.cpu_children.rusage()),
        _ => Err(Errno::EINVAL),
    }
}

/// The clock a CPU-time clock ID names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CpuClock {
    /// A process's CPU time: `CLOCK_PROCESS_CPUTIME_ID` (pid 0, the caller)
    /// or `clock_getcpuclockid()`'s encoding.
    Process(u32),
    /// A thread's CPU time: `CLOCK_THREAD_CPUTIME_ID` (tid 0, the caller) or
    /// `pthread_getcpuclockid()`'s encoding.
    Thread(u32),
}

/// Decode a CPU-time clock ID, or `None` for any other clock.
///
/// musl encodes a process clock as `(-pid-1)*8 + 2` and a thread clock as
/// `(-tid-1)*8 + 6`, Linux's `CPUCLOCK_SCHED` forms; an encoded id of 0 names
/// the caller. A positive id whose low bits happen to match (such as 10, from
/// an invalid negative pid) is not an encoded clock.
pub fn decode_cpu_clock(clock_id: u32) -> Option<CpuClock> {
    use wasm_posix_shared::clock::{CLOCK_PROCESS_CPUTIME_ID, CLOCK_THREAD_CPUTIME_ID};
    match clock_id {
        CLOCK_PROCESS_CPUTIME_ID => return Some(CpuClock::Process(0)),
        CLOCK_THREAD_CPUTIME_ID => return Some(CpuClock::Thread(0)),
        _ => {}
    }
    let id = clock_id as i32;
    if id >= 0 {
        return None;
    }
    let target = !(id >> 3) as u32;
    match id & 7 {
        2 => Some(CpuClock::Process(target)),
        6 => Some(CpuClock::Thread(target)),
        _ => None,
    }
}

/// The task a CPU-time clock reads, for task `caller_tid` of process
/// `caller_pid`: `(pid, tid)`, with tid 0 for a whole process.
///
/// A process clock may name any process, including an unreaped zombie. A
/// thread clock may name only a thread of the caller's own process, as on
/// Linux. An absent target is `EINVAL`, which musl's `clock_getcpuclockid()`
/// reports as `ESRCH`.
fn clock_target(
    table: &ProcessTable,
    caller_pid: u32,
    caller_tid: u32,
    clock: CpuClock,
) -> Result<(u32, u32), Errno> {
    match clock {
        CpuClock::Process(pid) => {
            let pid = if pid == 0 { caller_pid } else { pid };
            match table.get(pid) {
                Some(proc) if proc.state != ProcessState::Limbo => Ok((pid, 0)),
                _ => Err(Errno::EINVAL),
            }
        }
        CpuClock::Thread(tid) => {
            // The kernel names the main thread by its pid or by 0.
            let tid = match (tid, caller_tid) {
                (0, 0) => caller_pid,
                (0, caller) => caller,
                (tid, _) => tid,
            };
            let proc = table.get(caller_pid).ok_or(Errno::EINVAL)?;
            if tid == proc.pid || proc.get_thread(tid).is_some() {
                Ok((caller_pid, tid))
            } else {
                Err(Errno::EINVAL)
            }
        }
    }
}

/// Read a CPU-time clock for task `caller_tid` of process `caller_pid`. An
/// exited process reads its frozen usage.
pub fn read_cpu_clock(
    table: &ProcessTable,
    host: &mut dyn HostIO,
    caller_pid: u32,
    caller_tid: u32,
    clock: CpuClock,
) -> Result<CpuTime, Errno> {
    match clock_target(table, caller_pid, caller_tid, clock)? {
        (pid, 0) => Ok(process_usage(table.get(pid).ok_or(Errno::EINVAL)?, host)),
        // A thread that has not yet made a syscall has no measured time.
        (pid, tid) => Ok(host.host_task_cpu_time(pid, tid).unwrap_or_default()),
    }
}

/// `clock_gettime()` of a CPU-time clock for task `caller_tid` of process
/// `caller_pid`.
pub fn clock_gettime(
    table: &ProcessTable,
    host: &mut dyn HostIO,
    caller_pid: u32,
    caller_tid: u32,
    clock: CpuClock,
) -> Result<wasm_posix_shared::WasmTimespec, Errno> {
    let (tv_sec, tv_nsec) = read_cpu_clock(table, host, caller_pid, caller_tid, clock)?.timespec();
    Ok(wasm_posix_shared::WasmTimespec { tv_sec, tv_nsec })
}

/// `clock_getres()` of a CPU-time clock: the 1 ms Kandelo reports for every
/// clock, once the clock's target exists.
pub fn clock_getres(
    table: &ProcessTable,
    caller_pid: u32,
    caller_tid: u32,
    clock: CpuClock,
) -> Result<wasm_posix_shared::WasmTimespec, Errno> {
    clock_target(table, caller_pid, caller_tid, clock)?;
    Ok(wasm_posix_shared::WasmTimespec { tv_sec: 0, tv_nsec: 1_000_000 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::CpuHost;
    use wasm_posix_shared::clock::{CLOCK_PROCESS_CPUTIME_ID, CLOCK_THREAD_CPUTIME_ID};

    fn ms(user: u64, system: u64) -> CpuTime {
        CpuTime { user_ns: user * 1_000_000, system_ns: system * 1_000_000 }
    }

    fn process_clock(pid: i32) -> u32 {
        ((-pid - 1) as u32).wrapping_mul(8).wrapping_add(2)
    }

    fn thread_clock(tid: i32) -> u32 {
        ((-tid - 1) as u32).wrapping_mul(8).wrapping_add(6)
    }

    #[test]
    fn cpu_clocks_read_the_accounting_of_their_target() {
        let mut table = ProcessTable::new();
        let caller = table.create_process().unwrap();
        let other = table.create_process().unwrap();
        let mut host = CpuHost::new(&[
            ((caller, 0), ms(300, 20)),
            ((caller, caller), ms(100, 5)),
            ((other, 0), ms(7, 1)),
        ]);
        let read = |host: &mut CpuHost, clock_id: u32| {
            clock_gettime(&table, host, caller, caller, decode_cpu_clock(clock_id).unwrap())
                .map(|ts| (ts.tv_sec, ts.tv_nsec))
        };
        assert_eq!(read(&mut host, CLOCK_PROCESS_CPUTIME_ID), Ok((0, 320_000_000)));
        assert_eq!(read(&mut host, CLOCK_THREAD_CPUTIME_ID), Ok((0, 105_000_000)));
        assert_eq!(read(&mut host, process_clock(0)), Ok((0, 320_000_000)));
        assert_eq!(read(&mut host, process_clock(other as i32)), Ok((0, 8_000_000)));
        assert_eq!(read(&mut host, thread_clock(caller as i32)), Ok((0, 105_000_000)));
        // Another process's thread is not the caller's to read.
        assert_eq!(read(&mut host, thread_clock(other as i32)), Err(Errno::EINVAL));
        assert_eq!(read(&mut host, process_clock(0x0fff_fff0)), Err(Errno::EINVAL));

        let res = |clock_id: u32| clock_getres(&table, caller, caller, decode_cpu_clock(clock_id).unwrap());
        assert_eq!(res(process_clock(other as i32)).map(|ts| ts.tv_nsec), Ok(1_000_000));
        assert_eq!(res(process_clock(0x0fff_fff0)).err(), Some(Errno::EINVAL));
        assert_eq!(res(thread_clock(other as i32)).err(), Some(Errno::EINVAL));
    }

    #[test]
    fn an_exited_process_reports_its_frozen_usage() {
        let mut table = ProcessTable::new();
        let caller = table.create_process().unwrap();
        let zombie = table.create_process().unwrap();
        let mut host = CpuHost::new(&[((zombie, 0), ms(50, 4))]);
        freeze_at_exit(table.get_mut(zombie).unwrap(), &mut host);
        assert!(table.get_mut(zombie).unwrap().record_normal_exit(0));
        // The host forgets a retired process; the kernel does not need it to.
        host.forget();
        let ts = clock_gettime(&table, &mut host, caller, caller, CpuClock::Process(zombie)).unwrap();
        assert_eq!((ts.tv_sec, ts.tv_nsec), (0, 54_000_000));
    }

    #[test]
    fn a_waited_for_child_and_its_descendants_reach_the_parent() {
        let mut table = ProcessTable::new();
        let parent = table.create_process().unwrap();
        let child = table.create_process().unwrap();
        table.get_mut(child).unwrap().ppid = parent;
        table.get_mut(child).unwrap().cpu_children = ms(30, 3);
        let mut host = CpuHost::new(&[((child, 0), ms(200, 10))]);
        freeze_at_exit(table.get_mut(child).unwrap(), &mut host);
        assert_eq!(wait_usage(table.get(child).unwrap(), &mut host), ms(230, 13));
        assert_eq!(charge_waited_child(&mut table, parent, child, &mut host), ms(230, 13));
        let parent_proc = table.get(parent).unwrap();
        assert_eq!(parent_proc.cpu_children, ms(230, 13));
        let wire = getrusage(parent_proc, &mut host, wasm_posix_shared::rusage::RUSAGE_CHILDREN).unwrap();
        assert_eq!((wire.ru_utime_sec, wire.ru_utime_usec, wire.ru_stime_usec), (0, 230_000, 13_000));
    }

    #[test]
    fn rusage_splits_seconds_and_microseconds() {
        let usage = CpuTime { user_ns: 2_345_678_901, system_ns: 999_999 };
        let wire = usage.rusage();
        assert_eq!((wire.ru_utime_sec, wire.ru_utime_usec), (2, 345_678));
        assert_eq!((wire.ru_stime_sec, wire.ru_stime_usec), (0, 999));
        assert_eq!(wire.ru_maxrss, 0);
        assert_eq!(usage.timespec(), (2, 346_678_900));
    }

    #[test]
    fn decodes_musl_cpu_clock_ids() {
        let process = |pid: i32| ((-pid - 1) * 8 + 2) as u32;
        let thread = |tid: i32| ((-tid - 1) * 8 + 6) as u32;
        assert_eq!(decode_cpu_clock(2), Some(CpuClock::Process(0)));
        assert_eq!(decode_cpu_clock(3), Some(CpuClock::Thread(0)));
        assert_eq!(decode_cpu_clock(process(0)), Some(CpuClock::Process(0)));
        assert_eq!(decode_cpu_clock(process(123)), Some(CpuClock::Process(123)));
        assert_eq!(decode_cpu_clock(thread(456)), Some(CpuClock::Thread(456)));
        // clock_getcpuclockid(-2) encodes 10: not a CPU clock.
        assert_eq!(decode_cpu_clock(process(-2)), None);
        assert_eq!(decode_cpu_clock(0), None);
        assert_eq!(decode_cpu_clock(1), None);
        // Linux's PROF and VIRT encodings are not produced by musl.
        assert_eq!(decode_cpu_clock(((-124i32) * 8) as u32), None);
    }
}

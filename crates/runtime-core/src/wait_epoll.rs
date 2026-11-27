//! Epoll wait arguments and copyout survive a park in the guest's address space.

use wasm_posix_shared::{Errno, WasmEpollEvent, epoll::MAX_EVENTS};

use crate::process::{HostIO, Process};
use crate::signal::SignalMaskWaitKind;
use crate::syscalls::{self, GuestTask, ParkOutcome};
use crate::wait_park::{self, Resume};
use crate::wait_queue::{MonotonicNs, WaitKind, WakeSource};

/// Some backends can report readiness only when queried. Keep their polling
/// cadence within the kernel's existing deadline timer.
pub const PROBE_INTERVAL_NS: MonotonicNs = 10_000_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Request {
    fd: i32,
    events: u64,
    capacity: i32,
    pub started: MonotonicNs,
    pub token: u64,
    pub timeout_ns: Option<u64>,
}

impl Request {
    pub fn start(
        proc: &mut Process,
        peers: &mut [&mut Process],
        host: &mut dyn HostIO,
        task: GuestTask,
        fd: i32,
        events: u64,
        capacity: i32,
        timeout_ms: i32,
        mask_address: u64,
        mask_size: u64,
    ) -> Result<ParkOutcome, Errno> {
        if !(1..=MAX_EVENTS).contains(&capacity) || (mask_address != 0 && mask_size != 8) {
            return Err(Errno::EINVAL);
        }
        let size = (capacity as u32) * (size_of::<WasmEpollEvent>() as u32);
        if events == 0 || host.proc_validate_range(
            task.pid as i32, events, size as usize,
            wasm_posix_shared::ProcessMemoryAccess::Write,
        ) < 0 {
            return Err(Errno::EFAULT);
        }
        let mask = if mask_address != 0 {
            let mut bytes = [0; size_of::<u64>()];
            if host.proc_read_bytes(task.pid as i32, mask_address, &mut bytes) < 0 {
                return Err(Errno::EFAULT);
            }
            Some(u64::from_le_bytes(bytes))
        } else {
            None
        };
        let mut request = Self {
            fd,
            events,
            capacity,
            started: 0,
            token: 0,
            timeout_ns: (timeout_ms > 0).then(|| timeout_ms as u64 * 1_000_000),
        };
        match request.attempt(proc, peers, host, timeout_ms, mask) {
            Ok(count) => Ok(ParkOutcome::Done(count)),
            Err(Errno::EAGAIN) => {
                let result = (|| {
                    request.started = wait_park::now_ns(host)?;
                    request.token = proc
                        .epoll_waits
                        .iter()
                        .find(|(tid, _)| *tid == task.tid)
                        .map(|(_, lease)| lease.token)
                        .ok_or(Errno::EIO)?;
                    let deadline = request
                        .timeout_ns
                        .map(|ns| request.started.saturating_add(ns as i64));
                    wait_park::with(|parks| {
                        parks.park(
                            task.pid,
                            task.tid,
                            WaitKind::EpollWait,
                            alloc::vec![WakeSource::Epoll],
                            deadline,
                            Resume::Epoll(request),
                        )
                    })
                    .map(ParkOutcome::Parked)
                })();
                if result.is_err() {
                    crate::epoll::finish_wait(proc, task.tid);
                    proc.finish_signal_mask_wait_for(task.tid, SignalMaskWaitKind::EpollPwait);
                }
                result
            }
            Err(error) => Err(error),
        }
    }

    pub fn retry(
        self,
        proc: &mut Process,
        peers: &mut [&mut Process],
        host: &mut dyn HostIO,
        tid: u32,
    ) -> Result<i32, Errno> {
        if !proc
            .epoll_waits
            .iter()
            .any(|(owner, lease)| *owner == tid && lease.token == self.token)
        {
            return Err(Errno::ESRCH);
        }
        if matches!(
            syscalls::epoll_wait_still_blocked(proc, host, tid, self.token, peers),
            Ok(true)
        ) {
            return Err(Errno::EAGAIN);
        }
        self.attempt(proc, peers, host, -1, None)
    }

    fn attempt(
        self,
        proc: &mut Process,
        peers: &mut [&mut Process],
        host: &mut dyn HostIO,
        timeout_ms: i32,
        mask: Option<u64>,
    ) -> Result<i32, Errno> {
        let (count, events) = syscalls::sys_epoll_pwait_with_peers(
            proc,
            host,
            self.fd,
            self.capacity,
            timeout_ms,
            mask,
            peers,
        )?;
        if count > 0 {
            const EVENTS_PER_COPY: usize = 64;
            const EVENT_BYTES: usize = size_of::<WasmEpollEvent>();
            // The ready queue has already consumed these events. Reuse a
            // bounded buffer so copyout cannot lose them to a heap allocation.
            let mut bytes = [0; EVENTS_PER_COPY * EVENT_BYTES];
            let mut address = self.events;
            for batch in events.chunks(EVENTS_PER_COPY) {
                let output = &mut bytes[..batch.len() * EVENT_BYTES];
                for (record, &(flags, data)) in output.chunks_exact_mut(EVENT_BYTES).zip(batch) {
                    record[..4].copy_from_slice(&flags.to_le_bytes());
                    record[8..16].copy_from_slice(&data.to_le_bytes());
                }
                if host.proc_write_bytes(proc.pid as i32, address, output) < 0 {
                    return Err(Errno::EFAULT);
                }
                address += output.len() as u64;
            }
        }
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wait_park::Parks;

    fn park(parks: &mut Parks, timeout_ns: Option<u64>, token: u64) -> u64 {
        let request = Request {
            fd: 4,
            events: 1_024,
            capacity: 1,
            started: 0,
            token,
            timeout_ns,
        };
        parks
            .park(
                2,
                2,
                WaitKind::EpollWait,
                alloc::vec![WakeSource::Epoll],
                timeout_ns.map(|ns| ns as i64),
                Resume::Epoll(request),
            )
            .unwrap()
    }

    #[test]
    fn epoll_uses_the_first_of_its_probe_and_deadline() {
        let mut parks = Parks::new();
        let generation = park(&mut parks, Some(8), 61);
        assert_eq!(parks.next_timeout_ns(0), Some(8));
        assert!(parks.take_epoll_waiters(7).is_empty());
        assert_eq!(parks.take_epoll_waiters(8).len(), 1);
        assert_eq!(parks.expire(8), [(2, 2, 8)]);
        let complete = parks.take_completions();
        assert_eq!(complete.len(), 1);
        assert_eq!((complete[0].generation, complete[0].value), (generation, 0));
        assert_eq!(parks.take_finished_epoll(), [(2, 2, 61, true)]);
        assert_eq!(parks.next_timeout_ns(8), None);
    }

    #[test]
    fn epoll_notification_and_retirement_preserve_park_identity() {
        let mut parks = Parks::new();
        let old = park(&mut parks, None, 41);
        assert_eq!(parks.next_timeout_ns(0), Some(PROBE_INTERVAL_NS));
        parks.note_epoll_ready();
        let first = parks.take_epoll_waiters(1);
        assert_eq!(first.len(), 1);
        parks.retire_process(2);
        let current = park(&mut parks, None, 42);
        assert_ne!(old, current);
        parks.finish_epoll_waiter(first[0].0, 1);
        assert!(parks.take_completions().is_empty());
        parks.note_epoll_ready();
        let second = parks.take_epoll_waiters(2);
        parks.finish_epoll_waiter(second[0].0, 1);
        assert_eq!(parks.take_completions()[0].generation, current);
    }
}

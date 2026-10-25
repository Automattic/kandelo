//! Readiness subscriptions for epoll. Callbacks enqueue candidates even if a
//! descriptor stays readable between waits; delivery always rechecks state.
use crate::{descriptor_backing::with_epolls, lock::OfdId};
use alloc::vec::Vec;
use wasm_posix_shared::epoll::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Pipe(u32, u8),
    Accept(u32),
    Pty(u32, bool),
    Description(OfdId),
    Backing(crate::ofd::FileType, i64),
    Network(i32),
    Device(i64),
    DatagramCapacity(OfdId),
}

/// Called at the mutation, before the host drains its separate wake queue.
/// A callback must never run while the epoll backing table is borrowed.
pub fn notify(source: Source, events: u32) {
    with_epolls(|table| {
        // A dormant exclusive instance can receive a candidate, but cannot
        // suppress a different instance that actually has a sleeping waiter.
        let mut exclusive_selected = false;
        let mut changed = Vec::new();
        for (idx, ep) in table.iter_mut() {
            for interest in &mut ep.interests {
                if interest.disabled
                    || !interest.sources.contains(&source)
                    || interest.events & events == 0 && events & (EPOLLERR | EPOLLHUP) == 0
                {
                    continue;
                }
                if interest.events & EPOLLEXCLUSIVE != 0 {
                    if exclusive_selected {
                        continue;
                    }
                    if ep.waiters != 0 {
                        exclusive_selected = true;
                    }
                }
                interest.pending = true;
                changed.push(idx);
            }
        }
        // Child readiness wakes its parents without consuming a child event.
        // Cycles are rejected by ctl, so four passes cover every legal path.
        for _ in 0..4 {
            let mut parents = Vec::new();
            for (idx, ep) in table.iter_mut() {
                for interest in &mut ep.interests {
                    if !interest.disabled
                        && interest.events & EPOLLIN != 0
                        && changed.iter().any(|child| {
                            interest.sources.contains(&Source::Backing(
                                crate::ofd::FileType::Epoll,
                                -(*child as i64 + 1),
                            ))
                        })
                    {
                        interest.pending = true;
                        parents.push(idx);
                    }
                }
            }
            changed = parents;
            if changed.is_empty() {
                break;
            }
        }
    });
}

pub fn forget(id: OfdId) {
    with_epolls(|table| {
        for (_, ep) in table.iter_mut() {
            ep.interests.retain(|interest| interest.ofd_id != id);
            ep.cursor %= ep.interests.len().max(1);
        }
    });
}

/// Network engines count actual notifications (including arrivals while still
/// readable). Sampling the counter cannot lose a drain/refill between waits.
pub fn network_generation(handle: i32, generations: [Option<u64>; 2], terminal: u32) {
    let mut events = 0;
    with_epolls(|table| {
        for (_, ep) in table.iter_mut() {
            for i in &mut ep.interests {
                if !i.sources.contains(&Source::Network(handle)) {
                    continue;
                }
                for direction in 0..2 {
                    if generations[direction].is_some()
                        && i.network_generations[direction].is_some()
                        && generations[direction] != i.network_generations[direction]
                    {
                        events |= if direction == 0 {
                            EPOLLIN | EPOLLRDNORM | EPOLLPRI | EPOLLRDHUP | terminal
                        } else {
                            EPOLLOUT | EPOLLWRNORM | EPOLLWRBAND | terminal
                        };
                    }
                }
                i.network_generations = generations;
            }
        }
    });
    if events != 0 {
        notify(Source::Network(handle), events);
    }
}

/// An in-flight wait owns the exact description, independently of the fd number
/// another thread may close and reuse. The backing reference also records a
/// sleeper for EPOLLEXCLUSIVE callback selection.
pub struct WaitLease {
    pub index: usize,
    pub token: u64,
    _description: crate::ofd::SharedOfdState,
}
impl WaitLease {
    pub fn new(
        index: usize,
        description: crate::ofd::SharedOfdState,
    ) -> Result<Self, wasm_posix_shared::Errno> {
        with_epolls(|table| {
            table.add_ref(index)?;
            table.get_mut(index).unwrap().waiters += 1;
            Ok(())
        })?;
        static LAST_WAIT_TOKEN: core::sync::atomic::AtomicU64 =
            core::sync::atomic::AtomicU64::new(0);
        let token = LAST_WAIT_TOKEN
            .fetch_update(
                core::sync::atomic::Ordering::Relaxed,
                core::sync::atomic::Ordering::Relaxed,
                |last| last.checked_add(1),
            )
            .expect("epoll wait identity space exhausted")
            + 1;
        Ok(Self {
            index,
            token,
            _description: description,
        })
    }
}
impl Drop for WaitLease {
    fn drop(&mut self) {
        with_epolls(|table| {
            if let Some(ep) = table.get_mut(self.index) {
                ep.waiters = ep.waiters.saturating_sub(1);
            }
            table.release(self.index);
        });
    }
}

pub fn finish_wait(proc: &mut crate::process::Process, tid: u32) {
    if let Some(pos) = proc.epoll_waits.iter().position(|(owner, _)| *owner == tid) {
        proc.epoll_waits.remove(pos);
    }
}

pub fn device_generation(source: Source, generation: (u64, u32), events: u32) {
    let changed = with_epolls(|table| {
        let mut changed = false;
        for (_, ep) in table.iter_mut() {
            for i in &mut ep.interests {
                if i.sources.contains(&source) {
                    changed |= i.device_generation.is_some_and(|old| old != generation);
                    i.device_generation = Some(generation);
                }
            }
        }
        changed
    });
    if changed {
        notify(source, events);
    }
}

pub fn signal_generation(id: OfdId, generations: [Option<u64>; 2]) {
    let changed = with_epolls(|table| {
        let mut changed = false;
        for (_, ep) in table.iter_mut() {
            for i in &mut ep.interests {
                if i.ofd_id == id {
                    changed |=
                        i.network_generations[0].is_some() && i.network_generations != generations;
                    i.network_generations = generations;
                }
            }
        }
        changed
    });
    if changed {
        notify(Source::Description(id), EPOLLIN);
    }
}

pub fn finish_wait_token(proc: &mut crate::process::Process, tid: u32, token: u64) {
    if token != 0
        && proc
            .epoll_waits
            .iter()
            .any(|(owner, lease)| *owner == tid && lease.token == token)
    {
        finish_wait(proc, tid);
    }
}

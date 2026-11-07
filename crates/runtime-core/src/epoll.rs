//! Readiness subscriptions for epoll. Callbacks enqueue candidates even if a
//! descriptor stays readable between waits; delivery always rechecks state.
use crate::{descriptor_backing::with_epolls, lock::OfdId};
use core::sync::atomic::{AtomicU64, Ordering};
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

static LAST_NOTIFICATION: AtomicU64 = AtomicU64::new(0);

/// Called at the mutation, before the host drains its separate wake queue.
/// A callback must never run while the epoll backing table is borrowed.
pub fn notify(source: Source, events: u32) {
    // No allocation is allowed after an event producer has committed its VFS
    // mutation. The actual shared instance owns its cascade marker; a global
    // epoch distinguishes this callback from older pending events. The table's
    // lock serializes assignment and the complete cascade, including callers
    // on different native threads. No callback can reenter this borrowed table.
    with_epolls(|table| {
        let epoch = match LAST_NOTIFICATION.load(Ordering::Relaxed).checked_add(1) {
            Some(epoch) => epoch,
            None => {
                // This is scratch, not persistent identity. Clear only marks,
                // preserving every pending event/waiter, before safely reusing1.
                for (_, ep) in table.iter_mut() { ep.notification_epoch = 0; }
                1
            }
        };
        LAST_NOTIFICATION.store(epoch, Ordering::Relaxed);
        // A dormant exclusive instance can receive a candidate, but cannot
        // suppress a different instance that actually has a sleeping waiter.
        let mut exclusive_selected = false;
        for (_, ep) in table.iter_mut() {
            for interest in &mut ep.interests {
                if interest.disabled
                    || !interest.sources.contains(&source)
                    || interest.events & events == 0 && events & (EPOLLERR | EPOLLHUP) == 0
                {
                    continue;
                }
                if interest.events & EPOLLEXCLUSIVE != 0 {
                    if exclusive_selected { continue; }
                    if ep.waiters != 0 { exclusive_selected = true; }
                }
                interest.pending = true;
                ep.notification_epoch = epoch;
            }
        }
        // Query before taking each mutable interest, so child markers can be
        // inspected without aliasing the backing table or allocating a list.
        // Cycles are rejected by ctl; four passes cover all legal parent edges
        // regardless of slot order. Already-pending old events are not sources.
        let slots = table.iter_mut().map(|(index, _)| index + 1).last().unwrap_or(0);
        for _ in 0..4 {
            let mut advanced = false;
            for parent in 0..slots {
                let interests = table.get(parent).map_or(0, |ep| ep.interests.len());
                for index in 0..interests {
                    let ready = {
                        let interest = &table.get(parent).unwrap().interests[index];
                        !interest.disabled && interest.events & EPOLLIN != 0 &&
                            interest.sources.iter().any(|source| {
                                let Source::Backing(crate::ofd::FileType::Epoll, handle) = *source else { return false; };
                                let child = handle.checked_neg().and_then(|value| value.checked_sub(1))
                                    .and_then(|value| usize::try_from(value).ok());
                                child.and_then(|child| table.get(child))
                                    .is_some_and(|ep| ep.notification_epoch == epoch)
                            })
                    };
                    if ready {
                        let ep = table.get_mut(parent).unwrap();
                        advanced |= ep.notification_epoch != epoch;
                        ep.notification_epoch = epoch;
                        ep.interests[index].pending = true;
                    }
                }
            }
            if !advanced { break; }
        }
    });
}

#[cfg(test)]
pub(crate) fn force_notification_wrap_for_test() {
    with_epolls(|_| LAST_NOTIFICATION.store(u64::MAX, Ordering::Relaxed));
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

// Native component evidence can count allocations across the actual mutation
// callback. This allocator is absent from every production/guest build.
#[cfg(all(test, not(any(target_arch = "wasm32", target_arch = "wasm64"))))]
pub(crate) mod allocation_probe {
    use core::alloc::{GlobalAlloc, Layout};
    use core::cell::Cell;
    use std::alloc::System;
    std::thread_local! {
        static TRACK: Cell<bool> = const { Cell::new(false) };
        static COUNT: Cell<usize> = const { Cell::new(0) };
    }
    struct CountAlloc;
    #[global_allocator]
    static ALLOCATOR: CountAlloc = CountAlloc;
    fn note() {
        if TRACK.try_with(Cell::get).unwrap_or(false) {
            let _ = COUNT.try_with(|count| count.set(count.get().saturating_add(1)));
        }
    }
    unsafe impl GlobalAlloc for CountAlloc {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            note();unsafe { System.alloc(layout) }
        }
        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            note();unsafe { System.alloc_zeroed(layout) }
        }
        unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
            note();unsafe { System.realloc(pointer, layout, size) }
        }
        unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
            unsafe { System.dealloc(pointer, layout) }
        }
    }
    pub(crate) fn measure(f: impl FnOnce()) -> usize {
        COUNT.with(|count| count.set(0));
        struct Restore(bool);
        impl Drop for Restore { fn drop(&mut self) { TRACK.with(|track| track.set(self.0)); } }
        let restore = Restore(TRACK.with(|track| track.replace(true)));
        f();
        let count = COUNT.with(Cell::get);drop(restore);count
    }
}

//! POLLOUT wake primitives for ALSA PCM fds.
//!
//! [`super::tick::tick`] calls [`wake_pollout`] on every still-RUNNING
//! OFD after advancing `hw_ptr`. The wake pushes a
//! [`crate::wakeup::WAKE_WRITABLE`] event onto the global wakeup
//! buffer so the host drains the AlsaPcm wake alongside the existing
//! pipe / accept wakeup loop.
//!
//! A7 wires up the actual `poll(POLLOUT)` arm in `sys_poll` that
//! consumes the wake; v1 keeps the consumer side a stub. Tests can
//! observe the wake via [`drain_wake_count`] under [`TEST_WAKE_LOCK`].

use alloc::collections::BTreeMap;
use core::cell::UnsafeCell;

struct WakeTracker {
    counts: UnsafeCell<BTreeMap<usize, u32>>,
}

// SAFETY: the centralized kernel processes one syscall at a time;
// cargo tests serialize via [`TEST_WAKE_LOCK`].
unsafe impl Sync for WakeTracker {}

static POLLOUT_WAKES: WakeTracker = WakeTracker {
    counts: UnsafeCell::new(BTreeMap::new()),
};

/// Signal that `ofd_idx`'s `poll(POLLOUT)` condition may now be
/// satisfied. Pushes a [`crate::wakeup::WAKE_WRITABLE`] onto the
/// global wakeup buffer for host-side drain; tests can call
/// [`drain_wake_count`] (under [`TEST_WAKE_LOCK`]) to verify the
/// signal fired.
pub fn wake_pollout(ofd_idx: usize) {
    let map = unsafe { &mut *POLLOUT_WAKES.counts.get() };
    *map.entry(ofd_idx).or_insert(0) += 1;
    crate::wakeup::push(ofd_idx as u32, crate::wakeup::WAKE_WRITABLE);
}

#[cfg(test)]
pub(crate) fn drain_wake_count(ofd_idx: usize) -> u32 {
    let map = unsafe { &mut *POLLOUT_WAKES.counts.get() };
    map.remove(&ofd_idx).unwrap_or(0)
}

#[cfg(test)]
pub(crate) fn reset() {
    let map = unsafe { &mut *POLLOUT_WAKES.counts.get() };
    map.clear();
}

/// Serializes tests that touch the global POLLOUT_WAKES tracker (and,
/// transitively, the [`crate::process_table::GLOBAL_PROCESS_TABLE`]
/// reachable via [`super::tick::tick`]). Same pattern as
/// [`crate::audio::sab::TEST_SAB_LOCK`].
#[cfg(test)]
pub static TEST_WAKE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> std::sync::MutexGuard<'static, ()> {
        let g = TEST_WAKE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        g
    }

    #[test]
    fn wake_pollout_increments_per_ofd_count() {
        let _g = fresh();
        wake_pollout(7);
        wake_pollout(7);
        wake_pollout(11);
        assert_eq!(drain_wake_count(7), 2);
        assert_eq!(drain_wake_count(11), 1);
        assert_eq!(drain_wake_count(99), 0);
    }

    #[test]
    fn drain_resets_the_counter_for_the_ofd() {
        let _g = fresh();
        wake_pollout(3);
        assert_eq!(drain_wake_count(3), 1);
        assert_eq!(drain_wake_count(3), 0);
    }
}

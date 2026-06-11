//! Per-OFD wake hook for input-event readers.
//!
//! `push_event` calls [`wake_event_reader`] each time a previously-
//! empty ring transitions to non-empty. The host-side wake plumbing
//! (a `pendingInputReaders` registry keyed by OFD index, analogous to
//! `pendingPipeReaders` in `host/src/kernel-worker.ts`) lands in
//! Phase B together with the browser InputSource — until then this is
//! a no-op marker so the producer side can be shipped + tested in
//! isolation. Polls without targeted wake still complete via the
//! host's poll-retry timeout, the same way DRI card0's vblank reader
//! does today.

/// Notify the host that the per-OFD ring at `ofd_idx` is newly
/// non-empty so any pending `poll(POLLIN)` reader can be woken.
///
/// **v1 is a no-op.** Routing input wake events through
/// `crate::wakeup::push` today would collide with the pipe-index
/// namespace: the host's `drainAndProcessWakeupEvents` looks up
/// `wakeIdx` in `pendingPipeReaders`, and an OFD index that happens
/// to match a live pipe index would wake the wrong waiter. Phase B
/// will either allocate a separate wake-idx space (mirroring
/// `wakeup::alloc_accept_wake_idx`) or introduce a new wake-type bit
/// so the host can dispatch unambiguously.
pub fn wake_event_reader(_ofd_idx: usize) {
    // Intentionally empty; see module docs.
}

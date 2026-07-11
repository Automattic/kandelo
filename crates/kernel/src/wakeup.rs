//! Wakeup event buffer for kernel-driven poll/select notification.
//!
//! When pipe operations, listener accept queues, or AF_UNIX datagram send
//! state changes readiness, events are pushed into a global buffer. The host
//! drains this buffer after each syscall and wakes targeted waiters where an
//! identity is available or performs a bounded broad retry otherwise.

use alloc::vec::Vec;
use core::cell::UnsafeCell;

/// Pipe became readable (data was written, or write-end closed).
pub const WAKE_READABLE: u8 = 1;

/// Pipe became writable (data was read, or read-end closed).
pub const WAKE_WRITABLE: u8 = 2;

/// Listener accept queue received a pending connection.
pub const WAKE_ACCEPT: u8 = 4;

/// AF_UNIX datagram send readiness or its immediate result changed.
///
/// Datagram writers do not have a pipe index that the host can target. The
/// host therefore retries untargeted blocked sends and issues a broad
/// readiness wake for poll/select/epoll operations when capacity,
/// associations, shutdown, close, or pathname state changes.
pub const WAKE_DATAGRAM_WRITABLE: u8 = 8;

/// A readiness change event.
#[derive(Debug, Clone, Copy)]
pub struct WakeupEvent {
    pub idx: u32,
    pub wake_type: u8,
}

struct WakeupBuffer {
    events: UnsafeCell<Vec<WakeupEvent>>,
    next_accept_idx: UnsafeCell<u32>,
}

unsafe impl Sync for WakeupBuffer {}

static WAKEUP_BUFFER: WakeupBuffer = WakeupBuffer {
    events: UnsafeCell::new(Vec::new()),
    next_accept_idx: UnsafeCell::new(1),
};

/// Allocate a host-visible readiness token for a listening socket.
pub fn alloc_accept_wake_idx() -> u32 {
    let next = unsafe { &mut *WAKEUP_BUFFER.next_accept_idx.get() };
    if *next == 0 {
        *next = 1;
    }
    let idx = *next;
    *next = if idx >= i32::MAX as u32 { 1 } else { idx + 1 };
    idx
}

/// Push a wakeup event into the global buffer.
pub fn push(idx: u32, wake_type: u8) {
    let events = unsafe { &mut *WAKEUP_BUFFER.events.get() };
    events.push(WakeupEvent { idx, wake_type });
}

/// Push an accept-readiness event for a listening socket.
pub fn push_accept(accept_idx: u32) {
    push(accept_idx, WAKE_ACCEPT);
}

/// Notify the host that AF_UNIX datagram send readiness or its immediate
/// outcome may have changed.
pub fn push_datagram_writable() {
    push(0, WAKE_DATAGRAM_WRITABLE);
}

/// Drain all pending wakeup events, writing them to the output buffer.
/// Returns the number of events written.
///
/// Each event is serialized as: idx (u32 LE) + wake_type (u8) = 5 bytes.
pub fn drain(out: &mut [u8], max_events: u32) -> u32 {
    let events = unsafe { &mut *WAKEUP_BUFFER.events.get() };
    let count = events.len().min(max_events as usize);
    let bytes_per_event = 5;
    let max_by_buf = out.len() / bytes_per_event;
    let count = count.min(max_by_buf);

    for i in 0..count {
        let ev = &events[i];
        let offset = i * bytes_per_event;
        let idx_bytes = ev.idx.to_le_bytes();
        out[offset] = idx_bytes[0];
        out[offset + 1] = idx_bytes[1];
        out[offset + 2] = idx_bytes[2];
        out[offset + 3] = idx_bytes[3];
        out[offset + 4] = ev.wake_type;
    }

    events.clear();
    count as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reset() {
        let events = unsafe { &mut *WAKEUP_BUFFER.events.get() };
        events.clear();
        let next = unsafe { &mut *WAKEUP_BUFFER.next_accept_idx.get() };
        *next = 1;
    }

    #[test]
    fn test_push_and_drain() {
        reset();

        push(5, WAKE_READABLE);
        push(10, WAKE_WRITABLE);
        push_accept(12);
        push_datagram_writable();

        let mut buf = [0u8; 25];
        let count = drain(&mut buf, 10);
        assert_eq!(count, 4);

        // Event 0: pipe_idx=5, WAKE_READABLE
        assert_eq!(u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]), 5);
        assert_eq!(buf[4], WAKE_READABLE);

        // Event 1: pipe_idx=10, WAKE_WRITABLE
        assert_eq!(u32::from_le_bytes([buf[5], buf[6], buf[7], buf[8]]), 10);
        assert_eq!(buf[9], WAKE_WRITABLE);

        // Event 2: idx=12, WAKE_ACCEPT
        assert_eq!(u32::from_le_bytes([buf[10], buf[11], buf[12], buf[13]]), 12);
        assert_eq!(buf[14], WAKE_ACCEPT);

        // Event 3: broad datagram-writable readiness change.
        assert_eq!(u32::from_le_bytes([buf[15], buf[16], buf[17], buf[18]]), 0);
        assert_eq!(buf[19], WAKE_DATAGRAM_WRITABLE);

        // Buffer should be empty now
        let count2 = drain(&mut buf, 10);
        assert_eq!(count2, 0);
    }

    #[test]
    fn test_push_always_records_events() {
        reset();

        push(1, WAKE_READABLE);

        let mut buf = [0u8; 10];
        let count = drain(&mut buf, 10);
        assert_eq!(count, 1);
        assert_eq!(u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]), 1);
        assert_eq!(buf[4], WAKE_READABLE);
    }

    #[test]
    fn test_drain_respects_max() {
        reset();

        push(1, WAKE_READABLE);
        push(2, WAKE_WRITABLE);
        push(3, WAKE_READABLE);

        let mut buf = [0u8; 25];
        let count = drain(&mut buf, 2);
        assert_eq!(count, 2);

        // drain clears all, even if not all were written
        let count2 = drain(&mut buf, 10);
        assert_eq!(count2, 0);
    }
}

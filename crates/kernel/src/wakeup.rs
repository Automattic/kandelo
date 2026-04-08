//! Wakeup event buffer for kernel-driven poll/select notification.
//!
//! When pipe operations change readiness state (data written, data read,
//! endpoint closed), events are pushed into a global buffer. The host
//! drains this buffer after each syscall to wake only the specific
//! poll/select/reader/writer waiters that are affected.

use alloc::vec::Vec;
use core::cell::UnsafeCell;

/// Pipe became readable (data was written, or write-end closed).
pub const WAKE_READABLE: u8 = 1;

/// Pipe became writable (data was read, or read-end closed).
pub const WAKE_WRITABLE: u8 = 2;

/// A readiness change event for a pipe.
#[derive(Debug, Clone, Copy)]
pub struct WakeupEvent {
    pub pipe_idx: u32,
    pub wake_type: u8,
}

struct WakeupBuffer {
    events: UnsafeCell<Vec<WakeupEvent>>,
}

unsafe impl Sync for WakeupBuffer {}

static WAKEUP_BUFFER: WakeupBuffer = WakeupBuffer {
    events: UnsafeCell::new(Vec::new()),
};

/// Push a wakeup event into the global buffer.
/// Only generates events in centralized mode (host drains after each syscall).
pub fn push(pipe_idx: u32, wake_type: u8) {
    if !crate::is_centralized_mode() {
        return;
    }
    let events = unsafe { &mut *WAKEUP_BUFFER.events.get() };
    events.push(WakeupEvent { pipe_idx, wake_type });
}

/// Drain all pending wakeup events, writing them to the output buffer.
/// Returns the number of events written.
///
/// Each event is serialized as: pipe_idx (u32 LE) + wake_type (u8) = 5 bytes.
pub fn drain(out: &mut [u8], max_events: u32) -> u32 {
    let events = unsafe { &mut *WAKEUP_BUFFER.events.get() };
    let count = events.len().min(max_events as usize);
    let bytes_per_event = 5;
    let max_by_buf = out.len() / bytes_per_event;
    let count = count.min(max_by_buf);

    for i in 0..count {
        let ev = &events[i];
        let offset = i * bytes_per_event;
        let idx_bytes = ev.pipe_idx.to_le_bytes();
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
    }

    #[test]
    fn test_push_and_drain() {
        reset();
        // Enable centralized mode for test
        crate::set_kernel_mode(1);

        push(5, WAKE_READABLE);
        push(10, WAKE_WRITABLE);

        let mut buf = [0u8; 20];
        let count = drain(&mut buf, 10);
        assert_eq!(count, 2);

        // Event 0: pipe_idx=5, WAKE_READABLE
        assert_eq!(u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]), 5);
        assert_eq!(buf[4], WAKE_READABLE);

        // Event 1: pipe_idx=10, WAKE_WRITABLE
        assert_eq!(u32::from_le_bytes([buf[5], buf[6], buf[7], buf[8]]), 10);
        assert_eq!(buf[9], WAKE_WRITABLE);

        // Buffer should be empty now
        let count2 = drain(&mut buf, 10);
        assert_eq!(count2, 0);

        crate::set_kernel_mode(0);
    }

    #[test]
    fn test_no_events_in_non_centralized_mode() {
        reset();
        crate::set_kernel_mode(0);

        push(1, WAKE_READABLE);

        let mut buf = [0u8; 10];
        let count = drain(&mut buf, 10);
        assert_eq!(count, 0);
    }

    #[test]
    fn test_drain_respects_max() {
        reset();
        crate::set_kernel_mode(1);

        push(1, WAKE_READABLE);
        push(2, WAKE_WRITABLE);
        push(3, WAKE_READABLE);

        let mut buf = [0u8; 25];
        let count = drain(&mut buf, 2);
        assert_eq!(count, 2);

        // drain clears all, even if not all were written
        let count2 = drain(&mut buf, 10);
        assert_eq!(count2, 0);

        crate::set_kernel_mode(0);
    }
}

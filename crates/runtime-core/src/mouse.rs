//! `/dev/input/mice` — Linux-compatible PS/2 mouse stream.
//!
//! Surface mirrors what the Linux `mousedev` driver exposes: a character
//! device that yields PS/2 mouse packets to user-space readers. The
//! kernel does not generate motion itself — the host injects events via
//! [`inject_event`] (translated from browser `mousemove` / `mousedown` /
//! `mouseup` events on a canvas).
//!
//! ## Protocol
//!
//! Standard 3-byte PS/2 mouse packet — what `/dev/input/mice` emits in
//! its default mode (no IMPS/2 magic-knock for wheel support yet):
//!
//! ```text
//!     bit  7      6      5     4     3    2    1    0
//!  byte0  YOVF  XOVF  YSIGN XSIGN  ALW1 MID  RIGHT LEFT
//!  byte1  signed dx  (-128..127)
//!  byte2  signed dy  (-128..127)  — POSITIVE = mouse moved UP
//! ```
//!
//! Bit 3 of byte0 is always 1 (PS/2 frame sync). Bit 4 = X sign, bit 5 =
//! Y sign — mouseutils-style signed-magnitude encoding rather than two's
//! complement; we set the sign bit to mirror the high bit of the dx/dy
//! byte so a naive reader that just treats the byte as `int8_t` still
//! gets the right value.
//!
//! Y is reported with positive = up to match Linux mousedev. Browser
//! mouse coordinates have positive = down, so the canvas listener
//! inverts dy before calling `BrowserKernel.injectMouseEvent`.
//!
//! ## Single-owner
//!
//! The device is single-open. A second `open` from a different pid
//! returns `EBUSY`. Re-opens by the current owner are allowed (mirrors
//! Linux mousedev's exclusive-grab semantics). Owner is released when
//! the process closes its last
//! `/dev/input/mice` fd, or exits.
//!
//! Multi-fd within one process shares the queue — packets are consumed
//! in order regardless of which fd reads first. fbDOOM, the only
//! consumer here today, opens the device once.

extern crate alloc;

use alloc::collections::VecDeque;
use core::cell::UnsafeCell;
use core::sync::atomic::AtomicI32;

/// Owning pid of `/dev/input/mice`, or `-1` if free.
pub static MICE_OWNER: AtomicI32 = AtomicI32::new(-1);

/// Bytes per PS/2 packet emitted by `/dev/input/mice` in standard mode.
const PACKET_LEN: usize = 3;

/// Cap the queue so a chatty host can't OOM the kernel. 4096 packets is
/// ~10 seconds of motion at a typical ~400Hz mouse poll rate; well past
/// what any well-behaved consumer would let pile up. Excess packets are
/// dropped at the head (oldest events drop, freshest kept) — same
/// trade-off Linux's `mousedev` makes when its 32-event ring overflows.
const MAX_QUEUED_BYTES: usize = 4096 * PACKET_LEN;

struct GlobalMouseQueue(UnsafeCell<VecDeque<u8>>);
unsafe impl Sync for GlobalMouseQueue {}

static GLOBAL: GlobalMouseQueue = GlobalMouseQueue(UnsafeCell::new(VecDeque::new()));

fn queue() -> &'static mut VecDeque<u8> {
    unsafe { &mut *GLOBAL.0.get() }
}

/// Most packets one [`inject_event`] call may generate.
///
/// A displacement larger than one packet can carry is split across
/// several (see [`inject_event`]), and the caller-supplied delta is a
/// full `i32`, so the split needs a bound. The queue holds
/// `MAX_QUEUED_BYTES / PACKET_LEN` packets, and anything past that would
/// evict its own earlier packets — emitting more is pure work for bytes
/// no reader can ever see.
const MAX_PACKETS_PER_EVENT: usize = MAX_QUEUED_BYTES / PACKET_LEN;

/// Encode and enqueue a mouse event.
///
/// `dy` is in the *PS/2 sense* — positive = mouse moved up; the host is
/// responsible for inverting browser positive-down deltas before
/// calling. `buttons` is a bitmask: bit 0 = left, bit 1 = right, bit 2 =
/// middle.
///
/// A PS/2 packet carries at most `-128..=127` per axis. A larger
/// displacement is **split across consecutive packets** so the full
/// motion reaches the reader, rather than being clamped and the excess
/// silently discarded — which is what a `mousedev` reader expects, and
/// what the guest needs for a pointer to land where the user put it.
/// Both axes advance together, so a single fast diagonal movement stays
/// diagonal instead of turning a corner. Bounded by
/// [`MAX_PACKETS_PER_EVENT`]; a displacement past that bound is
/// truncated, because further packets would evict the ones already
/// queued for this same event.
///
/// A zero displacement still emits exactly one packet: that is how a
/// button press or release with no motion is delivered.
///
/// Idempotent on overflow: when the queue would exceed
/// [`MAX_QUEUED_BYTES`] the oldest packet is dropped to make room. The
/// caller cannot tell — same behavior as Linux mousedev.
///
/// Splitting used to live in the host, in
/// `host/src/framebuffer/browser-controls.ts`, which looped over
/// `injectMouseEvent` because this function clamped. That put the PS/2
/// device model's packet-generation rule outside the device model, gave
/// every host its own copy to get right, and left the Node and native
/// hosts with the clamping behavior the browser had already rejected.
/// Workstream K11.
pub fn inject_event(dx: i32, dy: i32, buttons: u32) {
    let mut remaining_x = dx;
    let mut remaining_y = dy;
    let mut packets = 0usize;
    loop {
        let step_x = remaining_x.clamp(i8::MIN as i32, i8::MAX as i32);
        let step_y = remaining_y.clamp(i8::MIN as i32, i8::MAX as i32);
        enqueue_packet(step_x as i8, step_y as i8, buttons);
        remaining_x -= step_x;
        remaining_y -= step_y;
        packets += 1;
        if (remaining_x == 0 && remaining_y == 0) || packets >= MAX_PACKETS_PER_EVENT {
            return;
        }
    }
}

fn enqueue_packet(dx_i8: i8, dy_i8: i8, buttons: u32) {
    // PS/2 byte0: bit3 always 1, bits0..2 = button state, bits4..5 =
    // sign of dx/dy mirroring the byte's high bit, bits6..7 = overflow
    // (we never set since each step fits in i8).
    let mut b0: u8 = 0x08 | ((buttons & 0x07) as u8);
    if dx_i8 < 0 {
        b0 |= 0x10;
    }
    if dy_i8 < 0 {
        b0 |= 0x20;
    }
    let b1 = dx_i8 as u8;
    let b2 = dy_i8 as u8;

    let q = queue();
    while q.len() + PACKET_LEN > MAX_QUEUED_BYTES {
        // Drop one whole packet from the front rather than tearing a
        // packet boundary — readers expect 3-byte alignment.
        for _ in 0..PACKET_LEN {
            q.pop_front();
        }
    }
    q.push_back(b0);
    q.push_back(b1);
    q.push_back(b2);
}

/// Drain up to `buf.len()` bytes into `buf`. Returns the number of
/// bytes copied. Reads in whole-packet units when possible — if `buf`
/// is smaller than 3 bytes the call still drains byte-by-byte (matches
/// Linux: a tiny read picks up whichever bytes are next).
///
/// Returns 0 when the queue is empty; callers translate that to
/// `EAGAIN` for non-blocking opens (the device opens with `O_NONBLOCK`
/// implicit in our model since there's no host blocking primitive
/// behind it).
pub fn read_into(buf: &mut [u8]) -> usize {
    let q = queue();
    let mut n = 0;
    while n < buf.len() {
        match q.pop_front() {
            Some(b) => {
                buf[n] = b;
                n += 1;
            }
            None => break,
        }
    }
    n
}

/// True if at least one packet is buffered. Used by `poll`/`select` to
/// decide POLLIN.
pub fn has_data() -> bool {
    !queue().is_empty()
}

/// Drop all queued events when the owner exits or closes its last fd so a
/// fresh open by a successor sees an empty queue.
pub fn reset() {
    queue().clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes tests that touch the global queue. cargo runs tests
    /// concurrently by default; without this they would race on the
    /// shared VecDeque inside `GLOBAL`.
    static QUEUE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn fresh() -> std::sync::MutexGuard<'static, ()> {
        // Tolerate poisoned locks from earlier failed assertions — the
        // queue is reset before each test, so prior panics don't leave
        // observable state behind.
        let g = QUEUE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        g
    }

    #[test]
    fn empty_queue_reads_zero() {
        let _g = fresh();
        let mut buf = [0u8; 3];
        assert_eq!(read_into(&mut buf), 0);
        assert!(!has_data());
    }

    #[test]
    fn inject_then_read_one_packet() {
        let _g = fresh();
        inject_event(5, -7, 0b001); // left button, dx=+5, dy=-7
        assert!(has_data());
        let mut buf = [0u8; 3];
        assert_eq!(read_into(&mut buf), 3);
        // bit3 always set + left button (bit0) + dy negative (bit5)
        assert_eq!(buf[0], 0x08 | 0x01 | 0x20);
        assert_eq!(buf[1] as i8, 5);
        assert_eq!(buf[2] as i8, -7);
        assert!(!has_data());
    }

    #[test]
    fn first_packet_of_a_split_saturates_each_axis() {
        // A displacement wider than one packet leads with a saturated
        // packet and carries the remainder in the packets after it; see
        // `large_displacement_splits_across_packets_preserving_total`.
        let _g = fresh();
        inject_event(500, -500, 0);
        let mut buf = [0u8; 3];
        read_into(&mut buf);
        assert_eq!(buf[1] as i8, 127);
        assert_eq!(buf[2] as i8, -128);
        // dx positive, dy negative
        assert_eq!(buf[0] & 0x10, 0);
        assert_eq!(buf[0] & 0x20, 0x20);
    }

    #[test]
    fn read_drains_in_packet_order() {
        let _g = fresh();
        inject_event(1, 2, 0);
        inject_event(3, 4, 0b010);
        let mut buf = [0u8; 6];
        assert_eq!(read_into(&mut buf), 6);
        assert_eq!(buf[1] as i8, 1);
        assert_eq!(buf[2] as i8, 2);
        assert_eq!(buf[4] as i8, 3);
        assert_eq!(buf[5] as i8, 4);
        assert_eq!(buf[3] & 0x07, 0b010); // right button on second
    }

    #[test]
    fn small_buf_drains_partial_then_resumes() {
        let _g = fresh();
        inject_event(10, 20, 0);
        let mut buf = [0u8; 2];
        assert_eq!(read_into(&mut buf), 2);
        let mut buf2 = [0u8; 4];
        assert_eq!(read_into(&mut buf2), 1);
        assert_eq!(buf2[0] as i8, 20);
    }

    #[test]
    fn reset_drops_pending() {
        let _g = fresh();
        inject_event(1, 1, 0);
        inject_event(2, 2, 0);
        assert!(has_data());
        reset();
        assert!(!has_data());
        let mut buf = [0u8; 3];
        assert_eq!(read_into(&mut buf), 0);
    }

    /// Read every queued packet back as `(buttons, dx, dy)` triples.
    fn drain_packets() -> alloc::vec::Vec<(u8, i32, i32)> {
        let mut out = alloc::vec::Vec::new();
        let mut buf = [0u8; PACKET_LEN];
        while read_into(&mut buf) == PACKET_LEN {
            out.push((buf[0] & 0x07, buf[1] as i8 as i32, buf[2] as i8 as i32));
        }
        out
    }

    #[test]
    fn displacement_within_one_packet_stays_one_packet() {
        let _g = fresh();
        inject_event(127, -128, 0b010);
        assert_eq!(drain_packets(), alloc::vec![(0b010, 127, -128)]);
    }

    #[test]
    fn zero_displacement_still_reports_button_state() {
        // A press or release with no motion must reach the reader.
        let _g = fresh();
        inject_event(0, 0, 0b001);
        assert_eq!(drain_packets(), alloc::vec![(0b001, 0, 0)]);
    }

    #[test]
    fn large_displacement_splits_across_packets_preserving_total() {
        let _g = fresh();
        inject_event(300, -260, 0b101);
        let packets = drain_packets();
        // Both axes advance together, so a fast diagonal stays diagonal.
        assert_eq!(
            packets,
            alloc::vec![(0b101, 127, -128), (0b101, 127, -128), (0b101, 46, -4)]
        );
        // The whole displacement arrives; nothing is silently dropped.
        let total_x: i32 = packets.iter().map(|p| p.1).sum();
        let total_y: i32 = packets.iter().map(|p| p.2).sum();
        assert_eq!((total_x, total_y), (300, -260));
    }

    #[test]
    fn one_axis_finishing_early_does_not_stop_the_other() {
        let _g = fresh();
        inject_event(5, 400, 0);
        let packets = drain_packets();
        assert_eq!(packets, alloc::vec![(0, 5, 127), (0, 0, 127), (0, 0, 127), (0, 0, 19)]);
        assert_eq!(packets.iter().map(|p| p.2).sum::<i32>(), 400);
    }

    #[test]
    fn split_is_bounded_so_an_extreme_delta_cannot_spin() {
        // The delta arrives from the host as a full i32. Splitting it at
        // 127 per packet without a bound would be ~16.9M iterations for
        // i32::MAX, every one of them evicting a packet queued moments
        // earlier by this same call.
        let _g = fresh();
        inject_event(i32::MAX, i32::MIN, 0);
        assert_eq!(drain_packets().len(), MAX_QUEUED_BYTES / PACKET_LEN);
    }

    #[test]
    fn overflow_drops_oldest_whole_packet() {
        let _g = fresh();
        let cap_packets = MAX_QUEUED_BYTES / PACKET_LEN;
        for i in 0..cap_packets {
            inject_event(i as i32 % 100, 0, 0);
        }
        // One past capacity — should drop the very first packet.
        inject_event(99, 0, 0b100);
        // Drain everything; first packet's dx must NOT be 0 (the dx of
        // the originally-first packet was 0 % 100 = 0; if we still have
        // it, that proves the drop didn't happen).
        let mut all = [0u8; MAX_QUEUED_BYTES];
        let n = read_into(&mut all);
        assert_eq!(n, MAX_QUEUED_BYTES);
        // packet 0 was {dx=0, ...}; after drop, head is packet 1 {dx=1}.
        assert_eq!(all[1] as i8, 1);
        // Tail packet is the freshest one we just injected.
        let last = MAX_QUEUED_BYTES - PACKET_LEN;
        assert_eq!(all[last + 1] as i8, 99);
        assert_eq!(all[last] & 0x07, 0b100);
    }
}

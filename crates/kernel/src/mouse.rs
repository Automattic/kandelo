//! Linux-compatible input devices for graphical programs.
//!
//! Kandelo's default text input contract is still POSIX terminal I/O
//! through `/dev/tty` / PTYs / stdio. These devices are opt-in Linux
//! compatibility surfaces for framebuffer, X, Wayland, SDL, and similar
//! graphical stacks that expect raw seat devices:
//!
//! - `/dev/input/mice`: Linux `mousedev` PS/2 byte stream.
//! - `/dev/input/event0`: Linux evdev relative pointer.
//! - `/dev/input/event1`: Linux evdev keyboard key edges.
//!
//! The kernel does not generate input itself — the host injects events
//! translated from browser canvas focus, keyboard, and pointer events.
//! Browser-specific details stay on the host side; guest-visible data uses
//! standard Linux device protocols.
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
//! Linux mousedev's exclusive-grab semantics for our single-process
//! model). Owner is released when the process closes its last
//! `/dev/input/mice` fd, or exits.
//!
//! Multi-fd within one process shares the queue — packets are consumed
//! in order regardless of which fd reads first.

extern crate alloc;

use alloc::collections::VecDeque;
use core::cell::UnsafeCell;
use core::sync::atomic::AtomicI32;
use core::sync::atomic::{AtomicU32, Ordering};

/// Owning pid of `/dev/input/mice`, or `-1` if free.
pub(crate) static MICE_OWNER: AtomicI32 = AtomicI32::new(-1);

/// Owning pid of `/dev/input/event0`, or `-1` if free.
pub(crate) static EVENT0_OWNER: AtomicI32 = AtomicI32::new(-1);

/// Owning pid of `/dev/input/event1`, or `-1` if free.
pub(crate) static EVENT1_OWNER: AtomicI32 = AtomicI32::new(-1);

/// Bytes per PS/2 packet emitted by `/dev/input/mice` in standard mode.
const PACKET_LEN: usize = 3;

/// Cap the queue so a chatty host can't OOM the kernel. 4096 packets is
/// ~10 seconds of motion at a typical ~400Hz mouse poll rate; well past
/// what any well-behaved consumer would let pile up. Excess packets are
/// dropped at the head (oldest events drop, freshest kept) — same
/// trade-off Linux's `mousedev` makes when its 32-event ring overflows.
const MAX_QUEUED_BYTES: usize = 4096 * PACKET_LEN;

const EVDEV_EVENT_LEN: usize = 16;
const MAX_QUEUED_EVDEV_BYTES: usize = 4096 * EVDEV_EVENT_LEN;

const EV_SYN: u16 = 0x00;
const EV_KEY: u16 = 0x01;
const EV_REL: u16 = 0x02;
const SYN_REPORT: u16 = 0x00;
const REL_X: u16 = 0x00;
const REL_Y: u16 = 0x01;
const REL_WHEEL: u16 = 0x08;
const BTN_LEFT: u16 = 0x110;
const BTN_RIGHT: u16 = 0x111;
const BTN_MIDDLE: u16 = 0x112;

struct GlobalMouseQueue(UnsafeCell<VecDeque<u8>>);
unsafe impl Sync for GlobalMouseQueue {}

static GLOBAL: GlobalMouseQueue = GlobalMouseQueue(UnsafeCell::new(VecDeque::new()));
static EVDEV_GLOBAL: GlobalMouseQueue = GlobalMouseQueue(UnsafeCell::new(VecDeque::new()));
static KEYBOARD_GLOBAL: GlobalMouseQueue = GlobalMouseQueue(UnsafeCell::new(VecDeque::new()));
static EVDEV_BUTTONS: AtomicU32 = AtomicU32::new(0);

fn queue() -> &'static mut VecDeque<u8> {
    unsafe { &mut *GLOBAL.0.get() }
}

fn evdev_queue() -> &'static mut VecDeque<u8> {
    unsafe { &mut *EVDEV_GLOBAL.0.get() }
}

fn keyboard_queue() -> &'static mut VecDeque<u8> {
    unsafe { &mut *KEYBOARD_GLOBAL.0.get() }
}

/// Encode and enqueue a mouse event. `dx` / `dy` are clamped into
/// signed 8-bit range. `dy` is in the *PS/2 sense* — positive = mouse
/// moved up; the host is responsible for inverting browser
/// positive-down deltas before calling.
///
/// `buttons` is a bitmask: bit 0 = left, bit 1 = right, bit 2 = middle.
///
/// Idempotent on overflow: when the queue would exceed
/// [`MAX_QUEUED_BYTES`] the oldest packet is dropped to make room. The
/// caller cannot tell — same behavior as Linux mousedev.
pub fn inject_event(dx: i32, dy: i32, buttons: u32) {
    let mut rem_x = dx.clamp(i16::MIN as i32, i16::MAX as i32);
    let mut rem_y = dy.clamp(i16::MIN as i32, i16::MAX as i32);
    if rem_x == 0 && rem_y == 0 {
        push_ps2_packet(0, 0, buttons);
    }
    while rem_x != 0 || rem_y != 0 {
        let step_x = rem_x.clamp(i8::MIN as i32, i8::MAX as i32);
        let step_y = rem_y.clamp(i8::MIN as i32, i8::MAX as i32);
        push_ps2_packet(step_x as i8, step_y as i8, buttons);
        rem_x -= step_x;
        rem_y -= step_y;
    }

    inject_evdev_event(dx, dy, buttons);
}

fn push_ps2_packet(dx_i8: i8, dy_i8: i8, buttons: u32) {
    // PS/2 byte0: bit3 always 1, bits0..2 = button state, bits4..5 =
    // sign of dx/dy mirroring the byte's high bit, bits6..7 = overflow
    // (we never set since clamped fits in i8).
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

fn push_evdev(type_: u16, code: u16, value: i32) {
    push_input_event(evdev_queue(), type_, code, value);
}

fn push_keyboard(type_: u16, code: u16, value: i32) {
    push_input_event(keyboard_queue(), type_, code, value);
}

fn push_input_event(q: &mut VecDeque<u8>, type_: u16, code: u16, value: i32) {
    while q.len() + EVDEV_EVENT_LEN > MAX_QUEUED_EVDEV_BYTES {
        for _ in 0..EVDEV_EVENT_LEN {
            q.pop_front();
        }
    }

    let sec = crate::current_time_secs() as i32;
    let usec = 0i32;
    for b in sec.to_le_bytes() {
        q.push_back(b);
    }
    for b in usec.to_le_bytes() {
        q.push_back(b);
    }
    for b in type_.to_le_bytes() {
        q.push_back(b);
    }
    for b in code.to_le_bytes() {
        q.push_back(b);
    }
    for b in value.to_le_bytes() {
        q.push_back(b);
    }
}

fn inject_evdev_event(dx: i32, dy: i32, buttons: u32) {
    let mut any = false;
    let prev = EVDEV_BUTTONS.swap(buttons & 0x07, Ordering::SeqCst);
    for (bit, code) in [
        (0x01u32, BTN_LEFT),
        (0x02u32, BTN_RIGHT),
        (0x04u32, BTN_MIDDLE),
    ] {
        let was_down = prev & bit != 0;
        let is_down = buttons & bit != 0;
        if was_down != is_down {
            push_evdev(EV_KEY, code, if is_down { 1 } else { 0 });
            any = true;
        }
    }
    if dx != 0 {
        push_evdev(EV_REL, REL_X, dx);
        any = true;
    }
    if dy != 0 {
        // Browser deltas are inverted before reaching inject_event so `dy`
        // is PS/2 positive-up. evdev REL_Y follows the common mouse-device
        // convention where positive means down, so invert it back.
        push_evdev(EV_REL, REL_Y, -dy);
        any = true;
    }
    if any {
        push_evdev(EV_SYN, SYN_REPORT, 0);
    }
}

/// Encode and enqueue one Linux evdev wheel event for `/dev/input/event0`.
///
/// `delta` uses evdev REL_WHEEL convention: positive means wheel-up and
/// negative means wheel-down. The PS/2 `/dev/input/mice` stream intentionally
/// remains a plain three-byte mouse stream for now.
pub fn inject_wheel_event(delta: i32) {
    if delta == 0 {
        return;
    }
    push_evdev(
        EV_REL,
        REL_WHEEL,
        delta.clamp(i8::MIN as i32, i8::MAX as i32),
    );
    push_evdev(EV_SYN, SYN_REPORT, 0);
}

/// Encode and enqueue one Linux evdev keyboard key edge for
/// `/dev/input/event1`. `keycode` is a Linux input-event key code
/// (for common PC keys, this matches the Linux MEDIUMRAW numeric key
/// codes used by raw console input). `pressed` maps to value 1 for
/// key-down and 0 for key-up.
pub fn inject_key_event(keycode: u16, pressed: bool) {
    if EVENT1_OWNER.load(Ordering::SeqCst) == -1 {
        return;
    }
    push_keyboard(EV_KEY, keycode, if pressed { 1 } else { 0 });
    push_keyboard(EV_SYN, SYN_REPORT, 0);
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

pub fn read_event_into(buf: &mut [u8]) -> usize {
    read_queue_into(evdev_queue(), buf)
}

pub fn read_key_event_into(buf: &mut [u8]) -> usize {
    read_queue_into(keyboard_queue(), buf)
}

fn read_queue_into(q: &mut VecDeque<u8>, buf: &mut [u8]) -> usize {
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

pub fn has_event_data() -> bool {
    !evdev_queue().is_empty()
}

pub fn has_key_event_data() -> bool {
    !keyboard_queue().is_empty()
}

/// Drop all queued events. Called on process exit / exec by the owner
/// so a fresh open by a successor sees an empty queue.
pub fn reset() {
    queue().clear();
    evdev_queue().clear();
    keyboard_queue().clear();
    EVDEV_BUTTONS.store(0, Ordering::SeqCst);
}

pub fn reset_mice() {
    queue().clear();
}

pub fn reset_event0() {
    evdev_queue().clear();
    EVDEV_BUTTONS.store(0, Ordering::SeqCst);
}

pub fn reset_event1() {
    keyboard_queue().clear();
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
    fn dx_clamped_to_i8_range() {
        let _g = fresh();
        inject_event(500, -500, 0);
        let mut buf = [0u8; 12];
        assert_eq!(read_into(&mut buf), 12);
        assert_eq!(buf[1] as i8, 127);
        assert_eq!(buf[2] as i8, -128);
        // dx positive, dy negative
        assert_eq!(buf[0] & 0x10, 0);
        assert_eq!(buf[0] & 0x20, 0x20);
        let total_dx = (buf[1] as i8 as i32)
            + (buf[4] as i8 as i32)
            + (buf[7] as i8 as i32)
            + (buf[10] as i8 as i32);
        let total_dy = (buf[2] as i8 as i32)
            + (buf[5] as i8 as i32)
            + (buf[8] as i8 as i32)
            + (buf[11] as i8 as i32);
        assert_eq!(total_dx, 500);
        assert_eq!(total_dy, -500);
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

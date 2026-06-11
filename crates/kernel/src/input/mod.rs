//! evdev input subsystem — backs `/dev/input/event{0,1}`.
//!
//! v1 covers `EVIOCG*` ioctl helpers + the canvas-dim cache used to
//! size `EVIOCGABS(ABS_X/ABS_Y)`. Host event push + sys_read ring
//! drain land in A4/A5.

use core::sync::atomic::{AtomicU32, Ordering};

use wasm_posix_shared::input::*;

/// Canvas pixel dimensions used by `EVIOCGABS(ABS_X/ABS_Y)` on the
/// pointer device. The host sets these once a KMS canvas attaches
/// (A4 wires `HostIO`'s canvas-dims push); until then the default
/// is 1280×720 so SDL2 probes don't see a degenerate 0-wide axis
/// and reject the device.
static CANVAS_W: AtomicU32 = AtomicU32::new(1280);
static CANVAS_H: AtomicU32 = AtomicU32::new(720);

pub fn canvas_dims() -> (u32, u32) {
    (CANVAS_W.load(Ordering::Relaxed), CANVAS_H.load(Ordering::Relaxed))
}

/// Update the canvas-dim cache. Both dimensions are clamped to at
/// least 1 so `maximum = w - 1` in the EVIOCGABS reply doesn't go
/// negative.
pub fn set_canvas_dims(width: u32, height: u32) {
    CANVAS_W.store(width.max(1), Ordering::Relaxed);
    CANVAS_H.store(height.max(1), Ordering::Relaxed);
}

fn set_bit(buf: &mut [u8], bit: u16) {
    let byte = (bit as usize) >> 3;
    let shift = (bit as usize) & 7;
    if byte < buf.len() {
        buf[byte] |= 1 << shift;
    }
}

/// Populate `buf` (already zeroed) with the bitmap returned by
/// `EVIOCGBIT(ev_type, len)` for the given device (`0` = keyboard,
/// `1` = pointer). Out-of-range bits are silently dropped — Linux
/// truncates to whatever buffer length the caller passed.
pub fn populate_evbit(device: u8, ev_type: u16, buf: &mut [u8]) {
    match (device, ev_type) {
        // ev_type = 0 — "which EV_* types does this device produce?"
        (_, 0) => {
            set_bit(buf, EV_SYN);
            set_bit(buf, EV_KEY);
            if device == 1 {
                set_bit(buf, EV_REL);
                set_bit(buf, EV_ABS);
            }
        }
        // Keyboard advertises every KEY_* in the kbd surface range
        // (A1 picked 1..=KEY_MICMUTE precisely so this is a single
        // loop instead of a 248-entry table). KEY_RESERVED (0) is
        // deliberately excluded — Linux doesn't advertise it either.
        (0, t) if t == EV_KEY => {
            for k in 1..=KEY_MICMUTE {
                set_bit(buf, k);
            }
        }
        // Pointer advertises only the five mouse buttons.
        (1, t) if t == EV_KEY => {
            for &b in &[BTN_LEFT, BTN_RIGHT, BTN_MIDDLE, BTN_SIDE, BTN_EXTRA] {
                set_bit(buf, b);
            }
        }
        (1, t) if t == EV_REL => {
            set_bit(buf, REL_X);
            set_bit(buf, REL_Y);
            set_bit(buf, REL_WHEEL);
            set_bit(buf, REL_HWHEEL);
        }
        (1, t) if t == EV_ABS => {
            set_bit(buf, ABS_X);
            set_bit(buf, ABS_Y);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canvas_dims_round_trip_and_clamp_to_one() {
        set_canvas_dims(640, 480);
        assert_eq!(canvas_dims(), (640, 480));
        set_canvas_dims(0, 0);
        assert_eq!(canvas_dims(), (1, 1));
        // Restore the default so any test running in parallel that
        // expects 1280×720 sees the original value.
        set_canvas_dims(1280, 720);
    }

    #[test]
    fn evbit_type_query_kbd_advertises_syn_and_key_only() {
        let mut buf = [0u8; 4];
        populate_evbit(0, 0, &mut buf);
        assert_eq!(buf[0], (1 << EV_SYN) | (1 << EV_KEY));
        assert_eq!(&buf[1..], &[0, 0, 0]);
    }

    #[test]
    fn evbit_type_query_pointer_adds_rel_and_abs() {
        let mut buf = [0u8; 4];
        populate_evbit(1, 0, &mut buf);
        assert_eq!(
            buf[0],
            (1 << EV_SYN) | (1 << EV_KEY) | (1 << EV_REL) | (1 << EV_ABS)
        );
    }

    #[test]
    fn evbit_kbd_advertises_key_a_and_key_z_not_reserved() {
        let mut buf = [0u8; 32];
        populate_evbit(0, EV_KEY, &mut buf);
        let a_byte = (KEY_A >> 3) as usize;
        let z_byte = (KEY_Z >> 3) as usize;
        assert_ne!(buf[a_byte] & (1 << (KEY_A & 7)), 0);
        assert_ne!(buf[z_byte] & (1 << (KEY_Z & 7)), 0);
        assert_eq!(buf[0] & 1, 0, "KEY_RESERVED must not be advertised");
    }

    #[test]
    fn evbit_pointer_advertises_btn_left_not_key_a() {
        // BTN_LEFT = 0x110 = bit 272 → byte 34. KEY_A = 30 → byte 3.
        let mut buf = [0u8; 40];
        populate_evbit(1, EV_KEY, &mut buf);
        let left_byte = (BTN_LEFT >> 3) as usize;
        assert_ne!(buf[left_byte] & (1 << (BTN_LEFT & 7)), 0);
        let a_byte = (KEY_A >> 3) as usize;
        assert_eq!(buf[a_byte] & (1 << (KEY_A & 7)), 0);
    }

    #[test]
    fn evbit_pointer_rel_query_advertises_wheels() {
        let mut buf = [0u8; 4];
        populate_evbit(1, EV_REL, &mut buf);
        assert_ne!(buf[0] & (1 << REL_X), 0);
        assert_ne!(buf[0] & (1 << REL_Y), 0);
        assert_ne!(buf[0] & (1 << REL_HWHEEL), 0);
        assert_ne!(buf[1] & (1 << (REL_WHEEL - 8)), 0);
    }

    #[test]
    fn evbit_pointer_abs_query_advertises_x_and_y() {
        let mut buf = [0u8; 4];
        populate_evbit(1, EV_ABS, &mut buf);
        assert_eq!(buf[0], (1 << ABS_X) | (1 << ABS_Y));
    }

    #[test]
    fn evbit_kbd_abs_query_is_empty() {
        // Keyboard has no absolute axes — populate_evbit leaves the
        // caller-zeroed buffer alone.
        let mut buf = [0u8; 4];
        populate_evbit(0, EV_ABS, &mut buf);
        assert_eq!(buf, [0; 4]);
    }

    #[test]
    fn evbit_truncates_silently_when_buf_too_small() {
        let mut buf = [0u8; 1];
        populate_evbit(0, EV_KEY, &mut buf);
        // KEY_ESC (1) fits in bit 1; KEY_A (30) fell off the end —
        // no panic.
        assert_ne!(buf[0] & (1 << KEY_ESC), 0);
    }
}

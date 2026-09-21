//! evdev input subsystem — backs `/dev/input/event{0,1}`.
//!
//! Covers the canvas-dim cache used to size `EVIOCGABS(ABS_X/ABS_Y)`,
//! the `EVIOCGBIT(*)` bitmap helper, and (in [`dispatch`]) the host-
//! callable event fan-out.

pub mod dispatch;

use core::sync::atomic::{AtomicU32, AtomicU8, Ordering};

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

/// Device-global pressed-key bitmaps for `EVIOCGKEY`, indexed by device
/// (0 = keyboard, 1 = pointer) and sized to `KEY_CNT` bits so every code
/// Kandelo emits fits (keys `1..=KEY_MICMUTE`, `BTN_*` up to `BTN_EXTRA`).
///
/// This mirrors Linux's per-device `dev->key`: it is machine-wide device
/// state shared by every open fd and every process. It therefore
/// "survives fork" the same way the canvas dims do — it lives in the one
/// kernel instance, not in per-process state serialized by `fork.rs` —
/// and, crucially, it is updated even when a per-fd event ring overflows.
/// That is what makes `SYN_DROPPED` recovery real: after a drop, a client
/// re-reads `EVIOCGKEY` and sees the true current key state, unsticking
/// any key whose release was lost.
const KEYSTATE_BYTES: usize = (KEY_CNT as usize) / 8;
static KEYSTATE: [[AtomicU8; KEYSTATE_BYTES]; 2] = [
    [const { AtomicU8::new(0) }; KEYSTATE_BYTES],
    [const { AtomicU8::new(0) }; KEYSTATE_BYTES],
];

/// Record an `EV_KEY` transition in the device-global keystate bitmap.
/// `value != 0` (press or autorepeat) sets the bit; `value == 0`
/// (release) clears it. Unknown devices and out-of-range codes are
/// ignored. Called from the event fan-out so keystate stays correct
/// regardless of ring overflow.
pub fn note_key_event(device: u8, code: u16, value: i32) {
    if device > 1 {
        return;
    }
    let byte = (code as usize) >> 3;
    if byte >= KEYSTATE_BYTES {
        return;
    }
    let mask = 1u8 << ((code as usize) & 7);
    let cell = &KEYSTATE[device as usize][byte];
    if value != 0 {
        cell.fetch_or(mask, Ordering::Relaxed);
    } else {
        cell.fetch_and(!mask, Ordering::Relaxed);
    }
}

/// Copy the device-global pressed-key bitmap into `buf` for `EVIOCGKEY`,
/// truncated to `buf.len()` (Linux copies `min(len, sizeof(dev->key))`).
/// The caller zeroes `buf` first, so any bytes beyond the tracked range
/// stay zero. Unknown devices leave `buf` untouched.
pub fn copy_key_state(device: u8, buf: &mut [u8]) {
    if device > 1 {
        return;
    }
    let n = buf.len().min(KEYSTATE_BYTES);
    for (i, out) in buf[..n].iter_mut().enumerate() {
        *out = KEYSTATE[device as usize][i].load(Ordering::Relaxed);
    }
}

/// Clear both device keystate bitmaps. Test-only: the bitmaps are global,
/// so a test that presses keys must reset them to stay independent.
#[cfg(test)]
pub fn reset_key_state() {
    for device in &KEYSTATE {
        for cell in device {
            cell.store(0, Ordering::Relaxed);
        }
    }
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
        (_, 0) => {
            set_bit(buf, EV_SYN);
            set_bit(buf, EV_KEY);
            if device == 1 {
                set_bit(buf, EV_REL);
                set_bit(buf, EV_ABS);
            }
        }
        // A1 picked 1..=KEY_MICMUTE precisely so this is a single
        // loop instead of a 248-entry table. KEY_RESERVED (0) is
        // skipped so the bitmap matches Linux byte-for-byte.
        (0, t) if t == EV_KEY => {
            for k in 1..=KEY_MICMUTE {
                set_bit(buf, k);
            }
        }
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
        let mut buf = [0u8; 4];
        populate_evbit(0, EV_ABS, &mut buf);
        assert_eq!(buf, [0; 4]);
    }

    #[test]
    fn evbit_truncates_silently_when_buf_too_small() {
        // KEY_ESC fits in bit 1; KEY_A (30) falls off — no panic.
        let mut buf = [0u8; 1];
        populate_evbit(0, EV_KEY, &mut buf);
        assert_ne!(buf[0] & (1 << KEY_ESC), 0);
    }

    #[test]
    fn keystate_press_sets_bit_release_clears_it() {
        reset_key_state();
        let mut buf = [0u8; KEYSTATE_BYTES];
        // Nothing pressed yet.
        copy_key_state(0, &mut buf);
        let a_byte = (KEY_A >> 3) as usize;
        let a_mask = 1u8 << (KEY_A & 7);
        assert_eq!(buf[a_byte] & a_mask, 0);
        // Press → bit set.
        note_key_event(0, KEY_A, 1);
        buf = [0u8; KEYSTATE_BYTES];
        copy_key_state(0, &mut buf);
        assert_ne!(buf[a_byte] & a_mask, 0);
        // Release → bit cleared.
        note_key_event(0, KEY_A, 0);
        buf = [0u8; KEYSTATE_BYTES];
        copy_key_state(0, &mut buf);
        assert_eq!(buf[a_byte] & a_mask, 0);
        reset_key_state();
    }

    #[test]
    fn keystate_autorepeat_keeps_key_down() {
        reset_key_state();
        note_key_event(0, KEY_A, 1);
        note_key_event(0, KEY_A, 2); // autorepeat, key still physically down
        let mut buf = [0u8; KEYSTATE_BYTES];
        copy_key_state(0, &mut buf);
        let a_byte = (KEY_A >> 3) as usize;
        assert_ne!(buf[a_byte] & (1u8 << (KEY_A & 7)), 0);
        reset_key_state();
    }

    #[test]
    fn keystate_is_per_device_keyboard_and_pointer_are_disjoint() {
        reset_key_state();
        // A button press on the pointer must not show on the keyboard.
        note_key_event(1, BTN_LEFT, 1);
        let mut kbd = [0u8; KEYSTATE_BYTES];
        let mut ptr = [0u8; KEYSTATE_BYTES];
        copy_key_state(0, &mut kbd);
        copy_key_state(1, &mut ptr);
        let left_byte = (BTN_LEFT >> 3) as usize;
        let left_mask = 1u8 << (BTN_LEFT & 7);
        assert_eq!(kbd[left_byte] & left_mask, 0, "keyboard must not see BTN_LEFT");
        assert_ne!(ptr[left_byte] & left_mask, 0, "pointer records BTN_LEFT");
        reset_key_state();
    }

    #[test]
    fn keystate_copy_truncates_to_caller_buffer_without_panic() {
        reset_key_state();
        note_key_event(0, KEY_A, 1);
        // KEY_A = 30 → byte 3; a 2-byte buffer drops it, no panic.
        let mut small = [0xffu8; 2];
        copy_key_state(0, &mut small);
        assert_eq!(&small, &[0u8, 0u8]);
        reset_key_state();
    }

    #[test]
    fn keystate_ignores_unknown_device_and_out_of_range_code() {
        reset_key_state();
        note_key_event(2, KEY_A, 1); // device out of range — no-op
        note_key_event(0, KEY_CNT, 1); // code past the bitmap — no-op
        let mut buf = [0u8; KEYSTATE_BYTES];
        copy_key_state(0, &mut buf);
        assert!(buf.iter().all(|&b| b == 0));
        reset_key_state();
    }
}

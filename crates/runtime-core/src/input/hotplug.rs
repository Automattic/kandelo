//! Host-described evdev devices — `/dev/input/event2` up to `event31`.
//!
//! The keyboard (`event0`) and pointer (`event1`) exist for the life of the
//! machine. Other input hardware comes and goes: a browser reveals a gamepad
//! only after a button press, and it can disconnect at any time. The host
//! describes such a device with a [`WpkInputDeviceDesc`] (the shape of Linux
//! `uinput`'s legacy `struct uinput_user_dev`), and this registry owns
//! everything a guest can observe about it: the node, its identity and
//! capabilities, its current key and axis state, and its connection lifetime.
//!
//! Each connection gets a kernel-wide serial number. An evdev open file
//! description records the serial it opened (`InputFdState::serial`), so a
//! descriptor left open across a disconnect keeps failing with `ENODEV` even
//! after another device reuses the number — as on Linux, where the old
//! `struct evdev` is dead and a new open reaches the new one.
//!
//! Like the Linux input core (`input_handle_event`), the registry drops
//! records the device did not advertise, key and axis records that do not
//! change device state (axes after `input_defuzz_abs_event`), and a
//! `SYN_REPORT` that would close an empty frame.

use core::sync::atomic::{AtomicI64, AtomicU32, Ordering};

use wasm_posix_shared::input::{
    WpkInputAbsinfo, WpkInputDeviceDesc, WpkInputId, ABS_CNT, EV_ABS, EV_KEY, EV_SYN,
    INPUT_FIXED_DEVICES, INPUT_MAX_DEVICES, KEY_CNT, SYN_REPORT,
};
use wasm_posix_shared::Errno;

const SLOTS: usize = (INPUT_MAX_DEVICES - INPUT_FIXED_DEVICES) as usize;
const KEY_BYTES: usize = (KEY_CNT as usize) / 8;

/// Whether `device` is in the host-described range (`event2`..=`event31`).
pub fn is_hotplug(device: u8) -> bool {
    (INPUT_FIXED_DEVICES..INPUT_MAX_DEVICES).contains(&device)
}

fn slot(device: u8) -> Option<usize> {
    is_hotplug(device).then(|| (device - INPUT_FIXED_DEVICES) as usize)
}

fn test_bit(bits: &[u8], bit: usize) -> bool {
    bits.get(bit >> 3).is_some_and(|b| b & (1 << (bit & 7)) != 0)
}

/// One connected host-described device.
pub struct HostInputDevice {
    serial: u64,
    name_len: usize,
    /// Identity and capabilities as validated at connect. `absinfo[axis].value`
    /// is the axis's current value, updated by every delivered record.
    desc: WpkInputDeviceDesc,
    /// Pressed-key bitmap for `EVIOCGKEY`.
    keystate: [u8; KEY_BYTES],
    /// A record has been delivered since the last `SYN_REPORT`.
    frame_pending: bool,
}

impl HostInputDevice {
    pub fn name(&self) -> &[u8] {
        &self.desc.name[..self.name_len]
    }

    pub fn id(&self) -> WpkInputId {
        self.desc.id
    }

    fn has_key(&self, code: u16) -> bool {
        test_bit(&self.desc.key_bits, code as usize)
    }

    fn has_abs(&self) -> bool {
        self.desc.abs_bits.iter().any(|b| *b != 0)
    }

    fn has_axis(&self, axis: u16) -> bool {
        test_bit(&self.desc.abs_bits, axis as usize)
    }

    /// `EVIOCGBIT(ev_type)` into a zeroed `buf`, truncated to its length.
    pub fn populate_evbit(&self, ev_type: u16, buf: &mut [u8]) {
        let copy = |src: &[u8], buf: &mut [u8]| {
            let n = buf.len().min(src.len());
            buf[..n].copy_from_slice(&src[..n]);
        };
        match ev_type {
            0 => {
                let mut types = 1u8 << EV_SYN;
                if self.desc.key_bits.iter().any(|b| *b != 0) {
                    types |= 1 << EV_KEY;
                }
                if self.has_abs() {
                    types |= 1 << EV_ABS;
                }
                copy(&[types], buf);
            }
            t if t == EV_KEY => copy(&self.desc.key_bits, buf),
            t if t == EV_ABS => copy(&self.desc.abs_bits, buf),
            _ => {}
        }
    }

    /// `EVIOCGABS(axis)`. Linux answers `EINVAL` for a device without
    /// absolute axes and the stored (zero, if never set) absinfo for any
    /// axis code of one that has them.
    pub fn absinfo(&self, axis: u16) -> Result<WpkInputAbsinfo, Errno> {
        if !self.has_abs() || axis >= ABS_CNT {
            return Err(Errno::EINVAL);
        }
        Ok(self.desc.absinfo[axis as usize])
    }

    /// `EVIOCGKEY` into a zeroed `buf`, truncated to its length.
    pub fn copy_key_state(&self, buf: &mut [u8]) {
        let n = buf.len().min(KEY_BYTES);
        buf[..n].copy_from_slice(&self.keystate[..n]);
    }

    /// Apply one record to device state, as Linux's `input_handle_event`
    /// does. Returns the value to deliver, or `None` to drop the record.
    fn accept(&mut self, ev_type: u16, code: u16, value: i32) -> Option<i32> {
        match ev_type {
            t if t == EV_SYN => {
                if code == SYN_REPORT && self.frame_pending {
                    self.frame_pending = false;
                    Some(value)
                } else {
                    None
                }
            }
            t if t == EV_KEY => {
                if !self.has_key(code) {
                    return None;
                }
                // Autorepeat passes without changing state; otherwise only a
                // transition is delivered.
                if value != 2 {
                    let byte = &mut self.keystate[(code as usize) >> 3];
                    let mask = 1u8 << (code & 7);
                    if (*byte & mask != 0) == (value != 0) {
                        return None;
                    }
                    *byte ^= mask;
                }
                self.frame_pending = true;
                Some(value)
            }
            t if t == EV_ABS => {
                if !self.has_axis(code) {
                    return None;
                }
                let info = &mut self.desc.absinfo[code as usize];
                let value = defuzz(value, info.value, info.fuzz);
                if value == info.value {
                    return None;
                }
                info.value = value;
                self.frame_pending = true;
                Some(value)
            }
            _ => None,
        }
    }
}

/// Linux `input_defuzz_abs_event`: small movements within the advertised
/// fuzz are absorbed or smoothed rather than reported as noise.
fn defuzz(value: i32, old: i32, fuzz: i32) -> i32 {
    if fuzz != 0 {
        let (v, o, f) = (value as i64, old as i64, fuzz as i64);
        if v > o - f / 2 && v < o + f / 2 {
            return old;
        }
        if v > o - f && v < o + f {
            return ((o * 3 + v) / 4) as i32;
        }
        if v > o - f * 2 && v < o + f * 2 {
            return ((o + v) / 2) as i32;
        }
    }
    value
}

struct Registry {
    slots: [Option<crate::IoBox<HostInputDevice>>; SLOTS],
    next_serial: u64,
}

static REGISTRY: spin::Mutex<Registry> = spin::Mutex::new(Registry {
    slots: [const { None }; SLOTS],
    next_serial: 1,
});

/// `/dev/input`'s mtime/ctime: when its set of nodes last changed. Zero
/// means not yet stamped; see [`input_dir_time`].
static DIR_TIME_SEC: AtomicI64 = AtomicI64::new(0);
static DIR_TIME_NSEC: AtomicU32 = AtomicU32::new(0);

fn stamp_dir(now: (i64, u32)) {
    DIR_TIME_SEC.store(now.0, Ordering::Relaxed);
    DIR_TIME_NSEC.store(now.1, Ordering::Relaxed);
}

/// `/dev/input`'s modification time. The fixed nodes were created with the
/// machine, so the directory is stamped with the wall clock the first time
/// anything observes it, then again on every connect and disconnect.
/// Scanners without `inotify` (SDL's Linux joystick fallback) rescan only
/// when this changes, and never while it reads 0.
pub fn input_dir_time() -> (i64, u32) {
    let sec = DIR_TIME_SEC.load(Ordering::Relaxed);
    if sec != 0 {
        return (sec, DIR_TIME_NSEC.load(Ordering::Relaxed));
    }
    let now = crate::current_time_secs();
    if now != 0 {
        // A connect may have stamped it meanwhile; keep the later value.
        let _ = DIR_TIME_SEC.compare_exchange(0, now, Ordering::Relaxed, Ordering::Relaxed);
    }
    (DIR_TIME_SEC.load(Ordering::Relaxed), DIR_TIME_NSEC.load(Ordering::Relaxed))
}

/// Validate a description the way `uinput` validates `uinput_user_dev`.
fn validate(desc: &WpkInputDeviceDesc) -> Result<(WpkInputDeviceDesc, usize), Errno> {
    let mut desc = *desc;
    let name_len = desc
        .name
        .iter()
        .position(|b| *b == 0)
        .ok_or(Errno::EINVAL)?;
    if name_len == 0 || core::str::from_utf8(&desc.name[..name_len]).is_err() {
        return Err(Errno::EINVAL);
    }
    desc.name[name_len..].fill(0);
    // The input core never advertises KEY_RESERVED.
    desc.key_bits[0] &= !1;
    for axis in 0..ABS_CNT as usize {
        let info = &mut desc.absinfo[axis];
        if !test_bit(&desc.abs_bits, axis) {
            *info = WpkInputAbsinfo::default();
            continue;
        }
        let range = info.maximum as i64 - info.minimum as i64;
        if range < 0
            || info.fuzz < 0
            || info.flat < 0
            || info.flat as i64 > range
            || info.resolution < 0
        {
            return Err(Errno::EINVAL);
        }
    }
    Ok((desc, name_len))
}

/// Plug in a device. Returns its number `N` (`/dev/input/eventN`): the
/// lowest free one, as Linux's input core allocates minors.
pub fn connect(desc: &WpkInputDeviceDesc, now: (i64, u32)) -> Result<u8, Errno> {
    let (desc, name_len) = validate(desc)?;
    let mut registry = REGISTRY.lock();
    let index = registry
        .slots
        .iter()
        .position(Option::is_none)
        .ok_or(Errno::ENOSPC)?;
    let serial = registry.next_serial;
    let device = crate::IoBox::try_new(HostInputDevice {
        serial,
        name_len,
        desc,
        keystate: [0; KEY_BYTES],
        frame_pending: false,
    })?;
    registry.next_serial = serial.checked_add(1).ok_or(Errno::EOVERFLOW)?;
    registry.slots[index] = Some(device);
    drop(registry);
    stamp_dir(now);
    Ok(index as u8 + INPUT_FIXED_DEVICES)
}

/// Unplug a device. Returns the serial of the connection that ended, so
/// the caller can wake the descriptors still bound to it.
pub fn disconnect(device: u8, now: (i64, u32)) -> Result<u64, Errno> {
    let index = slot(device).ok_or(Errno::ENODEV)?;
    let removed = REGISTRY.lock().slots[index].take().ok_or(Errno::ENODEV)?;
    stamp_dir(now);
    Ok(removed.serial)
}

/// The serial of the connection currently at `device`. The fixed devices
/// are always connected, with serial 0.
pub fn serial(device: u8) -> Option<u64> {
    if device < INPUT_FIXED_DEVICES {
        return Some(0);
    }
    let index = slot(device)?;
    REGISTRY.lock().slots[index].as_ref().map(|d| d.serial)
}

/// Whether a descriptor bound to (`device`, `serial`) still reaches a
/// connected device.
pub fn is_live(device: u8, serial: u64) -> bool {
    self::serial(device) == Some(serial)
}

/// Every connected host-described device number, ascending.
pub fn connected() -> impl Iterator<Item = u8> {
    let registry = REGISTRY.lock();
    let mut present = [false; SLOTS];
    for (index, slot) in registry.slots.iter().enumerate() {
        present[index] = slot.is_some();
    }
    drop(registry);
    (0..SLOTS)
        .filter(move |index| present[*index])
        .map(|index| index as u8 + INPUT_FIXED_DEVICES)
}

/// Run `f` on the device a descriptor is bound to, or fail with `ENODEV`
/// if that connection has ended.
pub fn with_device<R>(
    device: u8,
    serial: u64,
    f: impl FnOnce(&HostInputDevice) -> R,
) -> Result<R, Errno> {
    let index = slot(device).ok_or(Errno::ENODEV)?;
    let registry = REGISTRY.lock();
    match registry.slots[index].as_deref() {
        Some(d) if d.serial == serial => Ok(f(d)),
        _ => Err(Errno::ENODEV),
    }
}

/// Apply a host record to a connected device. Returns the connection serial
/// and the value to deliver, or `None` when the record is dropped (device
/// not connected, capability not advertised, or no state change).
pub fn accept_event(device: u8, ev_type: u16, code: u16, value: i32) -> Option<(u64, i32)> {
    let index = slot(device)?;
    let mut registry = REGISTRY.lock();
    let d = registry.slots[index].as_deref_mut()?;
    d.accept(ev_type, code, value).map(|value| (d.serial, value))
}

/// Disconnect everything and forget the directory stamp. Test-only: the
/// registry is global, so tests go through [`test_guard`].
#[cfg(test)]
pub fn reset_for_test() {
    let mut registry = REGISTRY.lock();
    for slot in registry.slots.iter_mut() {
        *slot = None;
    }
    drop(registry);
    stamp_dir((0, 0));
}

#[cfg(test)]
static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Serialize a test against every other test that observes or changes the
/// global registry, starting from an empty one.
#[cfg(test)]
pub(crate) fn test_guard() -> std::sync::MutexGuard<'static, ()> {
    let guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    reset_for_test();
    guard
}

#[cfg(test)]
pub fn test_desc(name: &str, keys: &[u16], axes: &[(u16, i32, i32, i32)]) -> WpkInputDeviceDesc {
    let mut desc = WpkInputDeviceDesc::default();
    desc.id = WpkInputId { bustype: 0x06, vendor: 0x1209, product: 0x0003, version: 1 };
    desc.name[..name.len()].copy_from_slice(name.as_bytes());
    for &key in keys {
        desc.key_bits[(key as usize) >> 3] |= 1 << (key & 7);
    }
    for &(axis, min, max, fuzz) in axes {
        desc.abs_bits[(axis as usize) >> 3] |= 1 << (axis & 7);
        desc.absinfo[axis as usize] = WpkInputAbsinfo {
            value: 0,
            minimum: min,
            maximum: max,
            fuzz,
            flat: 0,
            resolution: 0,
        };
    }
    desc
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_posix_shared::input::{
        ABS_X, ABS_Y, BTN_A, BTN_B, INPUT_DEVICE_NAME_BYTES, KEY_RESERVED,
    };

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        test_guard()
    }

    fn pad() -> WpkInputDeviceDesc {
        test_desc("pad", &[BTN_A, BTN_B], &[(ABS_X, -32768, 32767, 0), (ABS_Y, -32768, 32767, 16)])
    }

    #[test]
    fn connect_takes_lowest_free_number_and_reuses_it_with_a_new_serial() {
        let _g = lock();
        assert_eq!(connect(&pad(), (10, 0)), Ok(2));
        assert_eq!(connect(&pad(), (11, 0)), Ok(3));
        let first = serial(2).unwrap();
        assert_eq!(disconnect(2, (12, 0)), Ok(first));
        assert_eq!(serial(2), None);
        assert_eq!(connect(&pad(), (13, 0)), Ok(2));
        let second = serial(2).unwrap();
        assert_ne!(first, second);
        assert!(!is_live(2, first));
        assert!(is_live(2, second));
        assert_eq!(connected().collect::<std::vec::Vec<_>>(), [2, 3]);
    }

    #[test]
    fn fixed_devices_are_always_live_and_cannot_be_disconnected() {
        let _g = lock();
        assert!(is_live(0, 0) && is_live(1, 0));
        assert_eq!(disconnect(0, (1, 0)), Err(Errno::ENODEV));
        assert_eq!(disconnect(1, (1, 0)), Err(Errno::ENODEV));
        assert_eq!(disconnect(2, (1, 0)), Err(Errno::ENODEV));
        assert_eq!(disconnect(INPUT_MAX_DEVICES, (1, 0)), Err(Errno::ENODEV));
    }

    #[test]
    fn every_number_in_use_is_enospc() {
        let _g = lock();
        for n in INPUT_FIXED_DEVICES..INPUT_MAX_DEVICES {
            assert_eq!(connect(&pad(), (1, 0)), Ok(n));
        }
        assert_eq!(connect(&pad(), (1, 0)), Err(Errno::ENOSPC));
    }

    #[test]
    fn connect_and_disconnect_stamp_the_directory() {
        let _g = lock();
        connect(&pad(), (100, 5)).unwrap();
        assert_eq!(input_dir_time(), (100, 5));
        disconnect(2, (200, 7)).unwrap();
        assert_eq!(input_dir_time(), (200, 7));
    }

    #[test]
    fn invalid_descriptions_are_einval() {
        let _g = lock();
        let mut unterminated = pad();
        unterminated.name = [b'x'; INPUT_DEVICE_NAME_BYTES];
        assert_eq!(connect(&unterminated, (1, 0)), Err(Errno::EINVAL));
        let mut empty = pad();
        empty.name = [0; INPUT_DEVICE_NAME_BYTES];
        assert_eq!(connect(&empty, (1, 0)), Err(Errno::EINVAL));
        let mut not_utf8 = pad();
        not_utf8.name[0] = 0xff;
        assert_eq!(connect(&not_utf8, (1, 0)), Err(Errno::EINVAL));
        let inverted = test_desc("pad", &[], &[(ABS_X, 10, -10, 0)]);
        assert_eq!(connect(&inverted, (1, 0)), Err(Errno::EINVAL));
        let mut flat = test_desc("pad", &[], &[(ABS_X, 0, 10, 0)]);
        flat.absinfo[ABS_X as usize].flat = 11;
        assert_eq!(connect(&flat, (1, 0)), Err(Errno::EINVAL));
        assert_eq!(connected().count(), 0);
    }

    #[test]
    fn key_reserved_and_unadvertised_axis_entries_are_not_kept() {
        let _g = lock();
        let mut desc = test_desc("pad", &[KEY_RESERVED, BTN_A], &[]);
        desc.absinfo[ABS_Y as usize].maximum = 99;
        connect(&desc, (1, 0)).unwrap();
        let s = serial(2).unwrap();
        with_device(2, s, |d| {
            let mut keys = [0u8; KEY_BYTES];
            d.populate_evbit(EV_KEY, &mut keys);
            assert_eq!(keys[0] & 1, 0, "KEY_RESERVED must not be advertised");
            assert!(test_bit(&keys, BTN_A as usize));
            let mut types = [0u8; 1];
            d.populate_evbit(0, &mut types);
            assert_eq!(types[0], (1 << EV_SYN) | (1 << EV_KEY));
            assert_eq!(d.absinfo(ABS_Y).err(), Some(Errno::EINVAL), "no EV_ABS at all");
        })
        .unwrap();
    }

    #[test]
    fn records_follow_input_core_filtering() {
        let _g = lock();
        connect(&pad(), (1, 0)).unwrap();
        let s = serial(2).unwrap();
        // Empty frame: dropped.
        assert_eq!(accept_event(2, EV_SYN, SYN_REPORT, 0), None);
        // Unadvertised key and axis: dropped.
        assert_eq!(accept_event(2, EV_KEY, wasm_posix_shared::input::BTN_X, 1), None);
        assert_eq!(accept_event(2, EV_ABS, wasm_posix_shared::input::ABS_Z, 1), None);
        // Press, repeated press (dropped), autorepeat (passes), release.
        assert_eq!(accept_event(2, EV_KEY, BTN_A, 1), Some((s, 1)));
        assert_eq!(accept_event(2, EV_KEY, BTN_A, 1), None);
        assert_eq!(accept_event(2, EV_KEY, BTN_A, 2), Some((s, 2)));
        assert_eq!(accept_event(2, EV_SYN, SYN_REPORT, 0), Some((s, 0)));
        assert_eq!(accept_event(2, EV_SYN, SYN_REPORT, 0), None);
        // Axis: unchanged value dropped; fuzz-less axis reports exactly.
        assert_eq!(accept_event(2, EV_ABS, ABS_X, 0), None);
        assert_eq!(accept_event(2, EV_ABS, ABS_X, 1000), Some((s, 1000)));
        // ABS_Y has fuzz 16: within fuzz/2 is absorbed, within fuzz smoothed.
        assert_eq!(accept_event(2, EV_ABS, ABS_Y, 7), None);
        assert_eq!(accept_event(2, EV_ABS, ABS_Y, 12), Some((s, 3)));
        assert_eq!(accept_event(2, EV_ABS, ABS_Y, 1000), Some((s, 1000)));
        with_device(2, s, |d| {
            assert_eq!(d.absinfo(ABS_X).unwrap().value, 1000);
            assert_eq!(d.absinfo(ABS_Y).unwrap().value, 1000);
            // An unadvertised axis of a device with EV_ABS reads as zero.
            assert_eq!(d.absinfo(wasm_posix_shared::input::ABS_RZ).unwrap().maximum, 0);
            let mut keys = [0u8; KEY_BYTES];
            d.copy_key_state(&mut keys);
            assert!(test_bit(&keys, BTN_A as usize));
        })
        .unwrap();
        assert_eq!(accept_event(2, EV_KEY, BTN_A, 0), Some((s, 0)));
        // A disconnected device accepts nothing.
        disconnect(2, (2, 0)).unwrap();
        assert_eq!(accept_event(2, EV_KEY, BTN_A, 1), None);
        assert_eq!(with_device(2, s, |_| ()), Err(Errno::ENODEV));
    }
}

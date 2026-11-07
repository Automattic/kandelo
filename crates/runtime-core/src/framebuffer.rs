//! `/dev/fb0` geometry — the one display mode the device reports.
//!
//! The device boots at 640×400, the mode fbDOOM was written against. A
//! program selects another with `FBIOPUT_VSCREENINFO` before it maps or
//! writes the device; every `FBIOGET_*SCREENINFO`, `mmap` length check,
//! and `bind_framebuffer` call reads the mode back from here. The mode
//! belongs to the device for as long as one process owns it; releasing
//! the device returns it to the boot mode.

use core::sync::atomic::{AtomicU32, Ordering};
use wasm_posix_shared::Errno;

pub const DEFAULT_WIDTH: u32 = 640;
pub const DEFAULT_HEIGHT: u32 = 400;

/// Largest mode the device accepts: 3840×2160 (4K UHD), a 32 MiB buffer.
pub const MAX_WIDTH: u32 = 3840;
pub const MAX_HEIGHT: u32 = 2160;

static WIDTH: AtomicU32 = AtomicU32::new(DEFAULT_WIDTH);
static HEIGHT: AtomicU32 = AtomicU32::new(DEFAULT_HEIGHT);

/// The device mode. A syscall reads it once and derives the stride and
/// buffer size from that one pair.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Geometry {
    pub width: u32,
    pub height: u32,
}

impl Geometry {
    /// BGRA32 — the only pixel format `/dev/fb0` reports.
    pub const BYTES_PER_PIXEL: u32 = 4;

    /// `fb_fix_screeninfo.line_length`: bytes per scanline.
    pub fn line_length(self) -> u32 {
        self.width * Self::BYTES_PER_PIXEL
    }

    /// `fb_fix_screeninfo.smem_len`: bytes in the whole framebuffer, and
    /// the exact length an `mmap` of the device must request.
    pub fn smem_len(self) -> u32 {
        self.line_length() * self.height
    }
}

pub fn geometry() -> Geometry {
    Geometry {
        width: WIDTH.load(Ordering::Relaxed),
        height: HEIGHT.load(Ordering::Relaxed),
    }
}

/// Check a mode without setting it. A dimension of 0 or past the maximum
/// is `EINVAL`, as a Linux driver rejects a mode it cannot display.
pub fn check_geometry(width: u32, height: u32) -> Result<(), Errno> {
    if !(1..=MAX_WIDTH).contains(&width) || !(1..=MAX_HEIGHT).contains(&height) {
        return Err(Errno::EINVAL);
    }
    Ok(())
}

/// Set the device mode, after [`check_geometry`].
pub fn set_geometry(width: u32, height: u32) -> Result<(), Errno> {
    check_geometry(width, height)?;
    WIDTH.store(width, Ordering::Relaxed);
    HEIGHT.store(height, Ordering::Relaxed);
    Ok(())
}

/// Release `/dev/fb0` if `pid` owns it, returning the device to its boot
/// mode first. Idempotent: safe from `close`, `munmap`, exec and exit even
/// when `pid` never owned the device.
///
/// WHY: the device has one owner, so nobody else is using the mode when
/// that owner leaves. Resetting it means each program starts from the boot
/// mode instead of whatever the previous owner chose, and a program that
/// needs another mode asks for it. The mode is reset before ownership is
/// cleared, so a new owner never observes the old one.
pub fn release_owner(pid: u32) {
    let owner = &crate::process_table::FB0_OWNER;
    if owner.load(Ordering::SeqCst) != pid as i32 {
        return;
    }
    WIDTH.store(DEFAULT_WIDTH, Ordering::Relaxed);
    HEIGHT.store(DEFAULT_HEIGHT, Ordering::Relaxed);
    let _ = owner.compare_exchange(pid as i32, -1, Ordering::SeqCst, Ordering::SeqCst);
}

/// The mode and `FB0_OWNER` are machine-global, so every test that reads or
/// changes either (here, in `syscalls` and in `process_table`) holds this
/// guard. It starts the test from a fresh device: no owner, boot mode.
#[cfg(test)]
pub(crate) fn lock_device_for_test() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
    crate::process_table::FB0_OWNER.store(-1, Ordering::SeqCst);
    set_geometry(DEFAULT_WIDTH, DEFAULT_HEIGHT).unwrap();
    guard
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_geometry_is_640x400_bgra32() {
        let _device = lock_device_for_test();
        let fb = geometry();
        assert_eq!((fb.width, fb.height), (DEFAULT_WIDTH, DEFAULT_HEIGHT));
        assert_eq!(fb.line_length(), 640 * 4);
        assert_eq!(fb.smem_len(), 640 * 400 * 4);
    }

    #[test]
    fn set_geometry_moves_stride_and_buffer_size() {
        let _device = lock_device_for_test();
        set_geometry(1280, 800).unwrap();
        let fb = geometry();
        assert_eq!((fb.width, fb.height), (1280, 800));
        assert_eq!(fb.line_length(), 1280 * 4);
        assert_eq!(fb.smem_len(), 1280 * 800 * 4);
    }

    #[test]
    fn set_geometry_accepts_the_maximum_mode() {
        let _device = lock_device_for_test();
        set_geometry(MAX_WIDTH, MAX_HEIGHT).unwrap();
        assert_eq!(geometry().smem_len(), MAX_WIDTH * MAX_HEIGHT * 4);
    }

    #[test]
    fn set_geometry_rejects_a_mode_out_of_range_and_keeps_the_current_one() {
        let _device = lock_device_for_test();
        set_geometry(1280, 800).unwrap();
        for (width, height) in [(0, 800), (1280, 0), (MAX_WIDTH + 1, 800), (1280, MAX_HEIGHT + 1)] {
            assert_eq!(set_geometry(width, height), Err(Errno::EINVAL));
        }
        assert_eq!(geometry(), Geometry { width: 1280, height: 800 });
    }

    #[test]
    fn release_by_the_owner_restores_the_boot_mode() {
        let _device = lock_device_for_test();
        let owner = &crate::process_table::FB0_OWNER;
        owner.store(7, Ordering::SeqCst);
        set_geometry(1280, 800).unwrap();

        // Another pid's release changes neither the owner nor the mode.
        release_owner(8);
        assert_eq!(owner.load(Ordering::SeqCst), 7);
        assert_eq!(geometry(), Geometry { width: 1280, height: 800 });

        release_owner(7);
        assert_eq!(owner.load(Ordering::SeqCst), -1);
        assert_eq!(geometry(), Geometry { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
    }
}

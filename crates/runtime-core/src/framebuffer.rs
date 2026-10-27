//! `/dev/fb0` geometry — the one display mode the device reports.
//!
//! The device boots at 640×400, the mode fbDOOM was written against. A
//! program selects another with `FBIOPUT_VSCREENINFO` before it maps or
//! writes the device; every `FBIOGET_*SCREENINFO`, `mmap` length check,
//! and `bind_framebuffer` call reads the mode back from here. Like a Linux
//! fbdev driver, the mode belongs to the device, so it outlives the
//! process that set it.

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

#[cfg(test)]
mod tests {
    use super::*;

    /// Tests run single-threaded (`RUST_TEST_THREADS = 1`), and the mode is
    /// device state: restore the default so a later test still sees the
    /// geometry a fresh kernel boots with.
    fn restore_default() {
        set_geometry(DEFAULT_WIDTH, DEFAULT_HEIGHT).unwrap();
    }

    #[test]
    fn default_geometry_is_640x400_bgra32() {
        restore_default();
        let fb = geometry();
        assert_eq!((fb.width, fb.height), (DEFAULT_WIDTH, DEFAULT_HEIGHT));
        assert_eq!(fb.line_length(), 640 * 4);
        assert_eq!(fb.smem_len(), 640 * 400 * 4);
    }

    #[test]
    fn set_geometry_moves_stride_and_buffer_size() {
        set_geometry(1280, 800).unwrap();
        let fb = geometry();
        assert_eq!((fb.width, fb.height), (1280, 800));
        assert_eq!(fb.line_length(), 1280 * 4);
        assert_eq!(fb.smem_len(), 1280 * 800 * 4);
        restore_default();
    }

    #[test]
    fn set_geometry_accepts_the_maximum_mode() {
        set_geometry(MAX_WIDTH, MAX_HEIGHT).unwrap();
        assert_eq!(geometry().smem_len(), MAX_WIDTH * MAX_HEIGHT * 4);
        restore_default();
    }

    #[test]
    fn set_geometry_rejects_a_mode_out_of_range_and_keeps_the_current_one() {
        set_geometry(1280, 800).unwrap();
        for (width, height) in [(0, 800), (1280, 0), (MAX_WIDTH + 1, 800), (1280, MAX_HEIGHT + 1)] {
            assert_eq!(set_geometry(width, height), Err(Errno::EINVAL));
        }
        assert_eq!(geometry(), Geometry { width: 1280, height: 800 });
        restore_default();
    }
}

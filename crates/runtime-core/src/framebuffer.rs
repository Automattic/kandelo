//! `/dev/fb0` geometry — the one display mode the device reports.
//!
//! The mode belongs to the machine, not to the build. The host pushes the
//! image's declared geometry through `kernel_set_fb_geometry` before pid 1
//! runs; every `FBIOGET_*SCREENINFO`, `mmap` length check, and
//! `bind_framebuffer` call reads it back from here. An image that declares
//! nothing keeps 640×400, the mode fbDOOM was written against.

use core::sync::atomic::{AtomicU32, Ordering};

pub const DEFAULT_WIDTH: u32 = 640;
pub const DEFAULT_HEIGHT: u32 = 400;

/// Largest `width * height` whose [`Geometry::smem_len`] still fits in `u32`.
const MAX_PIXELS: u32 = u32::MAX / Geometry::BYTES_PER_PIXEL;

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

/// Set the device mode. Each dimension is raised to at least 1 so the
/// reported stride stays non-zero. A pair whose `smem_len` would not fit
/// in `u32` keeps the current mode.
pub fn set_geometry(width: u32, height: u32) {
    let width = width.max(1);
    let height = height.max(1);
    if u64::from(width) * u64::from(height) > u64::from(MAX_PIXELS) {
        return;
    }
    WIDTH.store(width, Ordering::Relaxed);
    HEIGHT.store(height, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tests run single-threaded (`RUST_TEST_THREADS = 1`), and the mode is
    /// machine-wide state: restore the default so a later test still sees
    /// the geometry a fresh kernel boots with.
    fn restore_default() {
        set_geometry(DEFAULT_WIDTH, DEFAULT_HEIGHT);
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
        set_geometry(1280, 800);
        let fb = geometry();
        assert_eq!((fb.width, fb.height), (1280, 800));
        assert_eq!(fb.line_length(), 1280 * 4);
        assert_eq!(fb.smem_len(), 1280 * 800 * 4);
        restore_default();
    }

    #[test]
    fn set_geometry_raises_a_zero_dimension_to_one() {
        set_geometry(0, 0);
        assert_eq!(geometry(), Geometry { width: 1, height: 1 });
        restore_default();
    }

    #[test]
    fn set_geometry_keeps_the_current_mode_for_an_unrepresentable_pair() {
        set_geometry(1280, 800);
        set_geometry(u32::MAX, u32::MAX);
        assert_eq!(geometry(), Geometry { width: 1280, height: 800 });

        set_geometry(MAX_PIXELS, 1);
        let fb = geometry();
        assert_eq!((fb.width, fb.height), (MAX_PIXELS, 1));
        assert_eq!(fb.smem_len(), MAX_PIXELS * 4);
        restore_default();
    }
}

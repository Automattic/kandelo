//! Modes supported by the virtual monitor. Its scanout has no fixed panel
//! timing: the host fits whichever framebuffer the guest selects.

use alloc::vec::Vec;
use wasm_posix_shared::dri::WpkDrmModeModeinfo;

/// Keep the host's density-aware preferred mode first, followed by standard
/// modes. Publishing alternatives must not change a compositor's default.
pub fn connector_modes(preferred: WpkDrmModeModeinfo) -> Vec<WpkDrmModeModeinfo> {
    let mut modes = Vec::new();
    if preferred.hdisplay != 0 && preferred.vdisplay != 0 {
        modes.push(preferred);
    }
    for (width, height) in [
        (640, 480),
        (800, 600),
        (960, 540),
        (1024, 768),
        (1280, 720),
        (1280, 800),
        (1280, 960),
        (1280, 1024),
        (1366, 768),
        (1440, 900),
        (1600, 900),
        (1600, 1200),
        (1680, 1050),
        (1920, 1080),
        (1920, 1200),
        (2560, 1440),
        (3840, 2160),
    ] {
        if modes
            .iter()
            .any(|m| m.hdisplay == width && m.vdisplay == height)
        {
            continue;
        }
        // Synthetic 60 Hz timings, matching the virtual host's preferred
        // mode. DRIVER only: alternatives must never become preferred.
        let htotal = width + 280;
        let vtotal = height + 45;
        let mut mode = WpkDrmModeModeinfo {
            clock: (u32::from(htotal) * u32::from(vtotal) * 60 + 500) / 1000,
            hdisplay: width,
            hsync_start: width + 88,
            hsync_end: width + 132,
            htotal,
            vdisplay: height,
            vsync_start: height + 4,
            vsync_end: height + 9,
            vtotal,
            vrefresh: 60,
            mode_type: 1 << 6,
            ..Default::default()
        };
        let name = alloc::format!("{width}x{height}");
        mode.name[..name.len()].copy_from_slice(name.as_bytes());
        modes.push(mode);
    }
    modes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_preferred_mode_and_removes_duplicate_standard_size() {
        for (width, height) in [(960, 540), (1920, 1080), (1470, 1080)] {
            let modes = connector_modes(WpkDrmModeModeinfo {
                hdisplay: width,
                vdisplay: height,
                mode_type: (1 << 3) | (1 << 6),
                ..Default::default()
            });
            assert_eq!((modes[0].hdisplay, modes[0].vdisplay), (width, height));
            assert_eq!(
                modes.iter().filter(|m| m.mode_type & (1 << 3) != 0).count(),
                1
            );
            assert_eq!(
                modes
                    .iter()
                    .filter(|m| m.hdisplay == width && m.vdisplay == height)
                    .count(),
                1
            );
            assert!(
                modes
                    .iter()
                    .any(|m| m.hdisplay == 3840 && m.vdisplay == 2160)
            );
            for mode in &modes[1..] {
                let hz = u64::from(mode.clock) * 1000
                    / (u64::from(mode.htotal) * u64::from(mode.vtotal));
                assert!((59..=60).contains(&hz));
            }
        }
    }
}

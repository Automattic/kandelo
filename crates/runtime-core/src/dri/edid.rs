//! The virtual connector's EDID (VESA E-EDID 1.4 base block).
//!
//! WHY (decision D-14): compositors name an output by the make, model and
//! serial number its EDID reports (wlroots and libdisplay-info build the
//! output description from them, and compositor configuration matches on
//! that description). A connector with no EDID gets a generic name that a
//! configuration cannot pin. The virtual display therefore reports a
//! Kandelo-identified EDID whose identity never changes, while its timing
//! and size fields describe the display the host actually presents:
//!
//! - Identity: manufacturer `KDL` (a three-letter code chosen for Kandelo;
//!   it is not an assigned PNP ID), product code 1, serial number 1 with the
//!   serial string `0001`, product name `Kandelo`, model year 2026.
//! - The first detailed timing is the connector's first advertised mode
//!   (the host's preferred mode) with the exact timings GETCONNECTOR
//!   reports, so the EDID's preferred timing and the mode list agree.
//! - A display range limits descriptor bounds every advertised mode
//!   (vertical and horizontal rates, pixel clock), with no timing formula,
//!   so a parser does not invent modes the connector does not list. No
//!   established or standard timings are claimed: those name VESA DMT/GTF
//!   timings, which differ from the virtual modes.
//! - The physical size is the connector's (`mm_width`/`mm_height`), in the
//!   detailed timing (mm) and the basic display parameters (cm); an unknown
//!   size (0) stays undefined.
//! - Digital input, 8 bits per color, RGB 4:4:4, sRGB as the default color
//!   space (with the sRGB primaries), DPMS active-off (DPMS Off darkens the
//!   CRTC).

use wasm_posix_shared::dri::WpkDrmModeModeinfo;

pub const EDID_LEN: usize = 128;

const MANUFACTURER: [u8; 3] = *b"KDL";
const PRODUCT_CODE: u16 = 1;
const SERIAL_NUMBER: u32 = 1;
const MODEL_YEAR: u16 = 2026;
const PRODUCT_NAME: &[u8] = b"Kandelo";
const SERIAL_STRING: &[u8] = b"0001";

/// `DRM_MODE_FLAG_*` polarity and interlace bits.
const FLAG_PHSYNC: u32 = 1 << 0;
const FLAG_PVSYNC: u32 = 1 << 2;
const FLAG_INTERLACE: u32 = 1 << 4;

/// One 18-byte detailed timing descriptor for `mode` at `mm` millimetres,
/// or `None` when the timing does not fit the descriptor's fields.
fn detailed_timing(mode: &WpkDrmModeModeinfo, (mm_w, mm_h): (u32, u32)) -> Option<[u8; 18]> {
    let clock = (mode.clock + 5) / 10; // 10 kHz units
    let hactive = u32::from(mode.hdisplay);
    let vactive = u32::from(mode.vdisplay);
    let hblank = u32::from(mode.htotal).checked_sub(hactive)?;
    let vblank = u32::from(mode.vtotal).checked_sub(vactive)?;
    let hso = u32::from(mode.hsync_start).checked_sub(hactive)?;
    let hsw = u32::from(mode.hsync_end).checked_sub(u32::from(mode.hsync_start))?;
    let vso = u32::from(mode.vsync_start).checked_sub(vactive)?;
    let vsw = u32::from(mode.vsync_end).checked_sub(u32::from(mode.vsync_start))?;
    if clock == 0 || clock > 0xffff || hactive > 0xfff || hblank > 0xfff || vactive > 0xfff
        || vblank > 0xfff || hso > 0x3ff || hsw > 0x3ff || vso > 0x3f || vsw > 0x3f
    {
        return None;
    }
    let (mm_w, mm_h) = (mm_w.min(0xfff), mm_h.min(0xfff));
    let mut flags = 0x18; // digital separate sync
    if mode.flags & FLAG_INTERLACE != 0 {
        flags |= 0x80;
    }
    if mode.flags & FLAG_PVSYNC != 0 {
        flags |= 0x04;
    }
    if mode.flags & FLAG_PHSYNC != 0 {
        flags |= 0x02;
    }
    Some([
        clock as u8, (clock >> 8) as u8,
        hactive as u8, hblank as u8, ((hactive >> 8) << 4 | hblank >> 8) as u8,
        vactive as u8, vblank as u8, ((vactive >> 8) << 4 | vblank >> 8) as u8,
        hso as u8, hsw as u8, ((vso & 0xf) << 4 | (vsw & 0xf)) as u8,
        ((hso >> 8) << 6 | (hsw >> 8) << 4 | (vso >> 4) << 2 | (vsw >> 4)) as u8,
        mm_w as u8, mm_h as u8, ((mm_w >> 8) << 4 | mm_h >> 8) as u8,
        0, 0, flags,
    ])
}

/// A display descriptor carrying `text` (at most 13 bytes), terminated by a
/// line feed and padded with spaces, as the 0xFC/0xFF descriptors require.
fn text_descriptor(tag: u8, text: &[u8]) -> [u8; 18] {
    debug_assert!(text.len() <= 13);
    let mut out = [0x20u8; 18];
    out[..5].copy_from_slice(&[0, 0, 0, tag, 0]);
    out[5..5 + text.len()].copy_from_slice(text);
    if text.len() < 13 {
        out[5 + text.len()] = 0x0a;
    }
    out
}

/// The display range limits descriptor (0xFD) covering `modes`: vertical
/// rate in Hz, horizontal rate in kHz and maximum pixel clock in 10 MHz
/// steps, rounded outward, with "range limits only" (no timing formula).
fn range_limits(modes: &[WpkDrmModeModeinfo]) -> [u8; 18] {
    let (mut min_v, mut max_v, mut min_h, mut max_h, mut max_clock) = (u64::MAX, 0, u64::MAX, 0, 0);
    for mode in modes {
        let (clock, htotal, vtotal) =
            (u64::from(mode.clock), u64::from(mode.htotal), u64::from(mode.vtotal));
        if clock == 0 || htotal == 0 || vtotal == 0 {
            continue;
        }
        let v_millihz = clock * 1_000_000 / (htotal * vtotal);
        let h_hz = clock * 1000 / htotal;
        min_v = min_v.min(v_millihz / 1000);
        max_v = max_v.max(v_millihz.div_ceil(1000));
        min_h = min_h.min(h_hz / 1000);
        max_h = max_h.max(h_hz.div_ceil(1000));
        max_clock = max_clock.max(clock.div_ceil(10_000));
    }
    let byte = |v: u64| v.clamp(1, 255) as u8;
    let mut out = [0x20u8; 18];
    out[..5].copy_from_slice(&[0, 0, 0, 0xfd, 0]);
    out[5] = byte(min_v);
    out[6] = byte(max_v);
    out[7] = byte(min_h);
    out[8] = byte(max_h);
    out[9] = byte(max_clock);
    out[10] = 0x01; // range limits only
    out[11] = 0x0a;
    out
}

/// A 10-bit CIE coordinate.
fn chroma(v: f64) -> u16 {
    (v * 1024.0 + 0.5) as u16
}

/// The EDID of the virtual connector advertising `modes` (the preferred
/// mode first) at a physical size of `mm` millimetres.
///
/// Panics if the first mode cannot be a detailed timing: the host bounds
/// the preferred mode at 3840x2160 (`connectorModeSize`), so a mode beyond
/// the descriptor's range is a host fault, not a display to describe.
pub fn build(modes: &[WpkDrmModeModeinfo], mm: (u32, u32)) -> [u8; EDID_LEN] {
    let mut e = [0u8; EDID_LEN];
    e[0..8].copy_from_slice(&[0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]);
    let letter = |c: u8| u16::from(c - b'A' + 1);
    let maker = letter(MANUFACTURER[0]) << 10 | letter(MANUFACTURER[1]) << 5 | letter(MANUFACTURER[2]);
    e[8..10].copy_from_slice(&maker.to_be_bytes());
    e[10..12].copy_from_slice(&PRODUCT_CODE.to_le_bytes());
    e[12..16].copy_from_slice(&SERIAL_NUMBER.to_le_bytes());
    e[16] = 0xff; // byte 17 is a model year
    e[17] = (MODEL_YEAR - 1990) as u8;
    e[18] = 1;
    e[19] = 4;
    e[20] = 0x80 | 0x20; // digital, 8 bits per primary color
    let cm = |mm: u32| ((mm + 5) / 10).min(255) as u8;
    if mm.0 != 0 && mm.1 != 0 {
        e[21] = cm(mm.0);
        e[22] = cm(mm.1);
    }
    e[23] = 120; // gamma 2.2
    e[24] = 0x20 | 0x04 | 0x02; // active-off, sRGB default, preferred timing native
    let [rx, ry, gx, gy, bx, by, wx, wy] =
        [0.640, 0.330, 0.300, 0.600, 0.150, 0.060, 0.3127, 0.3290].map(chroma);
    let low = |a: u16, b: u16, c: u16, d: u16| ((a & 3) << 6 | (b & 3) << 4 | (c & 3) << 2 | (d & 3)) as u8;
    e[25] = low(rx, ry, gx, gy);
    e[26] = low(bx, by, wx, wy);
    for (i, v) in [rx, ry, gx, gy, bx, by, wx, wy].into_iter().enumerate() {
        e[27 + i] = (v >> 2) as u8;
    }
    // No established timings (35..38); unused standard timings are 01 01.
    for slot in e[38..54].chunks_exact_mut(2) {
        slot.copy_from_slice(&[1, 1]);
    }
    let preferred = modes.first().expect("the virtual connector advertises a mode");
    let dtd = detailed_timing(preferred, mm).unwrap_or_else(|| panic!(
        "fatal KMS fault: the virtual connector's preferred mode {}x{} (clock {} kHz) does not fit \
         an EDID detailed timing; the host must bound it",
        preferred.hdisplay, preferred.vdisplay, preferred.clock));
    e[54..72].copy_from_slice(&dtd);
    e[72..90].copy_from_slice(&text_descriptor(0xfc, PRODUCT_NAME));
    e[90..108].copy_from_slice(&text_descriptor(0xff, SERIAL_STRING));
    e[108..126].copy_from_slice(&range_limits(modes));
    e[126] = 0; // no extension blocks
    let sum = e[..127].iter().fold(0u8, |acc, &b| acc.wrapping_add(b));
    e[127] = 0u8.wrapping_sub(sum);
    e
}

#[cfg(test)]
mod tests {
    use super::*;

    fn modes() -> alloc::vec::Vec<WpkDrmModeModeinfo> {
        let preferred = WpkDrmModeModeinfo {
            clock: 148_500, hdisplay: 1920, hsync_start: 2008, hsync_end: 2052, htotal: 2200,
            vdisplay: 1080, vsync_start: 1084, vsync_end: 1089, vtotal: 1125, vrefresh: 60,
            flags: FLAG_PHSYNC | FLAG_PVSYNC, mode_type: (1 << 3) | (1 << 6), ..Default::default()
        };
        crate::dri::modes::connector_modes(preferred)
    }

    #[test]
    fn edid_is_a_valid_e_edid_1_4_base_block() {
        let e = build(&modes(), (527, 296));
        assert_eq!(&e[..8], &[0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0]);
        assert_eq!(e.iter().fold(0u8, |a, &b| a.wrapping_add(b)), 0, "checksum");
        assert_eq!((e[18], e[19]), (1, 4), "version 1.4");
        assert_eq!(e[126], 0, "no extensions");
        // Manufacturer "KDL": three 5-bit letters, big-endian.
        let id = u16::from_be_bytes([e[8], e[9]]);
        let letter = |shift: u16| (((id >> shift) & 0x1f) as u8 + b'A' - 1) as char;
        assert_eq!([letter(10), letter(5), letter(0)], ['K', 'D', 'L']);
        assert_eq!(u32::from_le_bytes(e[12..16].try_into().unwrap()), 1, "serial number");
        assert_eq!((e[21], e[22]), (53, 30), "size in cm");
        // Every descriptor slot is a defined descriptor.
        assert_eq!(&e[75..78], &[0xfc, 0, b'K']);
        assert_eq!(&e[72 + 5..72 + 13], b"Kandelo\n");
        assert_eq!(&e[90 + 3..90 + 4], &[0xff]);
        assert_eq!(e[108 + 3], 0xfd);
    }

    #[test]
    fn edid_preferred_timing_matches_the_first_advertised_mode() {
        let modes = modes();
        let e = build(&modes, (527, 296));
        let d = &e[54..72];
        let m = &modes[0];
        assert_eq!(u16::from_le_bytes([d[0], d[1]]), 14850, "clock in 10 kHz");
        assert_eq!(u16::from(d[2]) | u16::from(d[4] >> 4) << 8, m.hdisplay);
        assert_eq!(u16::from(d[3]) | u16::from(d[4] & 0xf) << 8, m.htotal - m.hdisplay);
        assert_eq!(u16::from(d[5]) | u16::from(d[7] >> 4) << 8, m.vdisplay);
        assert_eq!(u16::from(d[6]) | u16::from(d[7] & 0xf) << 8, m.vtotal - m.vdisplay);
        assert_eq!(u16::from(d[8]) | u16::from(d[11] >> 6) << 8, m.hsync_start - m.hdisplay);
        assert_eq!(u16::from(d[9]) | u16::from((d[11] >> 4) & 3) << 8, m.hsync_end - m.hsync_start);
        assert_eq!(u16::from(d[10] >> 4) | u16::from((d[11] >> 2) & 3) << 4, m.vsync_start - m.vdisplay);
        assert_eq!(u16::from(d[10] & 0xf) | u16::from(d[11] & 3) << 4, m.vsync_end - m.vsync_start);
        assert_eq!(u16::from(d[12]) | u16::from(d[14] >> 4) << 8, 527, "width mm");
        assert_eq!(u16::from(d[13]) | u16::from(d[14] & 0xf) << 8, 296, "height mm");
        assert_eq!(d[17], 0x18 | 0x04 | 0x02, "digital separate sync, +h +v");
        // The range limits cover every advertised mode.
        let r = &e[108..126];
        for mode in &modes {
            let hz = u64::from(mode.clock) * 1000 / (u64::from(mode.htotal) * u64::from(mode.vtotal));
            let khz = u64::from(mode.clock) / u64::from(mode.htotal);
            assert!((u64::from(r[5])..=u64::from(r[6])).contains(&hz), "{}x{}", mode.hdisplay, mode.vdisplay);
            assert!((u64::from(r[7])..=u64::from(r[8])).contains(&khz));
            assert!(u64::from(r[9]) * 10_000 >= u64::from(mode.clock));
        }
    }

    #[test]
    fn edid_identity_is_stable_and_an_unknown_size_stays_undefined() {
        let a = build(&modes(), (0, 0));
        let b = build(&crate::dri::modes::connector_modes(Default::default()), (300, 200));
        assert_eq!(&a[8..18], &b[8..18], "make, product, serial and year never change");
        assert_eq!(&a[72..108], &b[72..108], "name and serial descriptors never change");
        assert_eq!((a[21], a[22]), (0, 0));
        assert_ne!(&a[54..72], &b[54..72], "the timing follows the preferred mode");
    }
}

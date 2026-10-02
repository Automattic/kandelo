//! rustdemo — a reference Rust library with a C ABI, the canonical shape
//! for a Rust-based Kandelo package. It uses `std` (CString, OnceLock,
//! slices) to exercise the std-in-a-staticlib path, and exposes a small
//! C API that C/C++ packages link against like any other library.
use std::ffi::{c_char, c_uchar, CString};
use std::sync::OnceLock;

/// CRC-32 (IEEE 802.3) over `len` bytes at `data`.
///
/// # Safety
/// `data` must point to at least `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn rustdemo_crc32(data: *const c_uchar, len: usize) -> u32 {
    let bytes = std::slice::from_raw_parts(data, len);
    let mut crc: u32 = 0xFFFF_FFFF;
    for &byte in bytes {
        crc ^= byte as u32;
        for _ in 0..8 {
            // mask = 0xFFFF_FFFF when the low bit is set, else 0.
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// A NUL-terminated version string owned by the library.
#[no_mangle]
pub extern "C" fn rustdemo_version() -> *const c_char {
    static VERSION: OnceLock<CString> = OnceLock::new();
    VERSION
        .get_or_init(|| CString::new("rustdemo 0.1.0").unwrap())
        .as_ptr()
}

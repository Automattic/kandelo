//! Read-only ZIP archive reader. Ported from host/src/vfs/zip.ts.
//! no_std + alloc. Parses ZIP central-directory metadata without
//! decompressing the whole archive; entry decompression (Task 5) will use
//! `miniz_oxide` for DEFLATE.

use wasm_posix_shared::Errno;

/// End Of Central Directory record signature ("PK\x05\x06" LE).
const EOCD_SIG: u32 = 0x0605_4b50;
/// Minimum size of an EOCD record (fixed fields, zero-length comment).
const EOCD_MIN: usize = 22;
/// Maximum span to search backward for the EOCD: the fixed record plus the
/// largest possible trailing comment (64 KiB - 1).
const EOCD_MAX_SEARCH: usize = 65557;

/// Bounds-checked little-endian u16 read.
#[allow(dead_code)] // Used by central directory / local header parsing (later tasks).
fn r16(b: &[u8], off: usize) -> Option<u16> {
    let e = off.checked_add(2)?;
    if e > b.len() { return None; }
    Some(u16::from_le_bytes([b[off], b[off + 1]]))
}

/// Bounds-checked little-endian u32 read.
fn r32(b: &[u8], off: usize) -> Option<u32> {
    let e = off.checked_add(4)?;
    if e > b.len() { return None; }
    Some(u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]]))
}

/// Locate the End Of Central Directory record by scanning backward from
/// `len - EOCD_MIN` down to `max(0, len - EOCD_MAX_SEARCH)` for `EOCD_SIG`.
///
/// Mirrors `findEOCD` in `host/src/vfs/zip.ts`.
pub fn find_eocd(data: &[u8]) -> Result<usize, Errno> {
    if data.len() < EOCD_MIN {
        return Err(Errno::EINVAL);
    }
    let search_start = data.len().saturating_sub(EOCD_MAX_SEARCH);
    let mut i = data.len() - EOCD_MIN;
    loop {
        if r32(data, i) == Some(EOCD_SIG) {
            return Ok(i);
        }
        if i == search_start {
            break;
        }
        i -= 1;
    }
    Err(Errno::EINVAL)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;

    const TINY_ZIP: &[u8] = include_bytes!("testdata/tiny.zip");

    #[test]
    fn find_eocd_locates_signature() {
        let off = find_eocd(TINY_ZIP).expect("EOCD should be found in tiny.zip");
        assert_eq!(r32(TINY_ZIP, off), Some(EOCD_SIG));
    }

    #[test]
    fn find_eocd_rejects_corrupted_signature() {
        let mut corrupted: Vec<u8> = TINY_ZIP.to_vec();
        let off = find_eocd(TINY_ZIP).expect("EOCD should be found in tiny.zip");
        // Flip a byte of the signature so it no longer matches.
        corrupted[off] ^= 0xff;
        assert_eq!(find_eocd(&corrupted), Err(Errno::EINVAL));
    }

    #[test]
    fn find_eocd_rejects_too_short_input() {
        assert_eq!(find_eocd(&[0u8; 10]), Err(Errno::EINVAL));
    }

    #[test]
    fn r16_and_r32_are_bounds_checked() {
        let buf = [0x01, 0x02, 0x03, 0x04];
        assert_eq!(r16(&buf, 0), Some(0x0201));
        assert_eq!(r16(&buf, 3), None);
        assert_eq!(r32(&buf, 0), Some(0x0403_0201));
        assert_eq!(r32(&buf, 1), None);
    }
}

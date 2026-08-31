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

/// Central directory file header signature ("PK\x01\x02" LE).
const CENTRAL_DIR_SIG: u32 = 0x0201_4b50;
/// Fixed-size portion of a central directory file header, before the
/// variable-length name/extra/comment fields.
const CENTRAL_DIR_FIXED_SIZE: usize = 46;
/// General-purpose bit flag 3: a trailing data descriptor follows the file
/// data instead of the central directory carrying authoritative sizes.
const GPFLAG_DATA_DESCRIPTOR: u16 = 0x0008;
/// Zip64 "look elsewhere" sentinel value for 32-bit size/offset fields.
const ZIP64_SENTINEL: u32 = 0xFFFF_FFFF;

/// Supported compression methods: stored (0) and deflate (8).
const METHOD_STORE: u16 = 0;
const METHOD_DEFLATE: u16 = 8;

/// A single member parsed from a ZIP central directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipEntry {
    /// Exact member-name bytes from the central directory (strict UTF-8,
    /// round-trip verified).
    pub name: alloc::vec::Vec<u8>,
    /// High byte of `version made by`: the creator OS (3 == Unix).
    pub creator_os: u8,
    pub method: u16,
    pub compressed_size: u32,
    pub uncompressed_size: u32,
    pub external_attrs: u32,
    pub local_offset: u32,
}

/// Bounds-checked little-endian u16 read.
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

/// Walk the central directory and return every member entry.
///
/// Mirrors `parseZipCentralDirectory` in `host/src/vfs/zip.ts`.
pub fn read_central_directory(data: &[u8]) -> Result<alloc::vec::Vec<ZipEntry>, Errno> {
    use alloc::string::String;
    use alloc::vec::Vec;

    let eocd_offset = find_eocd(data)?;
    let entry_count = r16(data, eocd_offset + 10).ok_or(Errno::EINVAL)?;
    let cd_offset = r32(data, eocd_offset + 16).ok_or(Errno::EINVAL)?;

    let mut entries = Vec::with_capacity(entry_count as usize);
    let mut offset = usize::try_from(cd_offset).map_err(|_| Errno::EINVAL)?;

    for _ in 0..entry_count {
        if r32(data, offset) != Some(CENTRAL_DIR_SIG) {
            return Err(Errno::EINVAL);
        }

        let version_made_by = r16(data, offset + 4).ok_or(Errno::EINVAL)?;
        let gpflag = r16(data, offset + 8).ok_or(Errno::EINVAL)?;
        let method = r16(data, offset + 10).ok_or(Errno::EINVAL)?;
        let compressed_size = r32(data, offset + 20).ok_or(Errno::EINVAL)?;
        let uncompressed_size = r32(data, offset + 24).ok_or(Errno::EINVAL)?;
        let name_len = r16(data, offset + 28).ok_or(Errno::EINVAL)? as usize;
        let extra_len = r16(data, offset + 30).ok_or(Errno::EINVAL)? as usize;
        let comment_len = r16(data, offset + 32).ok_or(Errno::EINVAL)? as usize;
        let external_attrs = r32(data, offset + 38).ok_or(Errno::EINVAL)?;
        let local_offset = r32(data, offset + 42).ok_or(Errno::EINVAL)?;

        if gpflag & GPFLAG_DATA_DESCRIPTOR != 0 {
            return Err(Errno::EINVAL);
        }
        if method != METHOD_STORE && method != METHOD_DEFLATE {
            return Err(Errno::EINVAL);
        }
        if compressed_size == ZIP64_SENTINEL
            || uncompressed_size == ZIP64_SENTINEL
            || local_offset == ZIP64_SENTINEL
        {
            return Err(Errno::EINVAL);
        }

        let name_start = offset.checked_add(CENTRAL_DIR_FIXED_SIZE).ok_or(Errno::EINVAL)?;
        let name_end = name_start.checked_add(name_len).ok_or(Errno::EINVAL)?;
        if name_end > data.len() {
            return Err(Errno::EINVAL);
        }
        let name_bytes = &data[name_start..name_end];
        let name_str = core::str::from_utf8(name_bytes).map_err(|_| Errno::EINVAL)?;
        if String::from(name_str).into_bytes() != name_bytes {
            return Err(Errno::EINVAL);
        }

        entries.push(ZipEntry {
            name: name_bytes.to_vec(),
            creator_os: (version_made_by >> 8) as u8,
            method,
            compressed_size,
            uncompressed_size,
            external_attrs,
            local_offset,
        });

        let advance = CENTRAL_DIR_FIXED_SIZE
            .checked_add(name_len)
            .and_then(|v| v.checked_add(extra_len))
            .and_then(|v| v.checked_add(comment_len))
            .ok_or(Errno::EINVAL)?;
        offset = offset.checked_add(advance).ok_or(Errno::EINVAL)?;
        if offset > data.len() {
            return Err(Errno::EINVAL);
        }
    }

    Ok(entries)
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

    fn find_entry<'a>(entries: &'a [ZipEntry], name: &str) -> &'a ZipEntry {
        entries
            .iter()
            .find(|e| e.name == name.as_bytes())
            .unwrap_or_else(|| panic!("entry {name:?} not found"))
    }

    #[test]
    fn read_central_directory_returns_tiny_zip_entries() {
        let entries = read_central_directory(TINY_ZIP)
            .expect("tiny.zip central directory should parse");

        // bin/, bin/big.txt, bin/link, etc/, etc/small.txt
        assert_eq!(entries.len(), 5);
        for entry in &entries {
            assert_eq!(entry.creator_os, 3, "all tiny.zip members are Unix-created");
        }

        let small = find_entry(&entries, "etc/small.txt");
        assert_eq!(small.method, METHOD_STORE);
        assert_eq!(small.compressed_size, 6);
        assert_eq!(small.uncompressed_size, 6);

        let big = find_entry(&entries, "bin/big.txt");
        assert_eq!(big.method, METHOD_DEFLATE);
        assert_eq!(big.compressed_size, 22);
        assert_eq!(big.uncompressed_size, 4096);

        let link = find_entry(&entries, "bin/link");
        assert_eq!(link.method, METHOD_STORE);
        assert_eq!(link.compressed_size, 7);
        assert_eq!(link.uncompressed_size, 7);
        // 0120777 (symlink, rwxrwxrwx) packed into the high 16 bits.
        assert_eq!((link.external_attrs >> 16) & 0xffff, 0o120777);
    }
}

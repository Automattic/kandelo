//! Decoder for the VFS image's kernel-facing lazy-linkage section ("KLZY").
//!
//! The wire format is emitted by the real TypeScript image writer
//! (`encodeKernelLazySection` in `host/src/vfs/kernel-lazy-section.ts`, reached
//! through `MemoryFileSystem.saveImage`); its structural constants live in
//! `crates/shared/src/lib.rs` (`VFS_IMAGE_KERNEL_LAZY_*`) and the layout is
//! documented there. The committed cross-language fixture
//! `testdata/klzy-v1.bin` is emitted by that real encoder and decoded here, the
//! same drift guard `rtfs-v3-lazy.bin` provides for the RTFS manifest.
//!
//! This decoder is the pure `&[u8] -> struct` half. Every framing or
//! consistency violation (bad magic/version/header size, a nonzero reserved
//! field, a truncated or inconsistent record, a zero or duplicated archive id,
//! an out-of-order archive id, an unknown flag, a zero or duplicated inode, a
//! file record naming an undeclared archive, a source path present without an
//! archive or absent with one, invalid UTF-8, or trailing bytes) yields
//! `Err(Errno::EINVAL)`; the function never panics.
//!
//! What it deliberately does NOT carry is host authority: fetch URLs and
//! transports, integrity digests, activation modes, atomic-group seals, and
//! per-builder image metadata all stay in the image's host-side JSON sections.
//! The kernel is downstream of the host's decision about which bytes it may
//! hand over, and needs none of that to know a lazy file's real size or which
//! archive member backs it.

use alloc::collections::BTreeSet;
use alloc::string::String;
use alloc::vec::Vec;
use wasm_posix_shared::abi;
use wasm_posix_shared::Errno;

const MAGIC: [u8; 4] = abi::VFS_IMAGE_KERNEL_LAZY_MAGIC;
const VERSION: u16 = abi::VFS_IMAGE_KERNEL_LAZY_VERSION;
const HEADER_SIZE: u16 = abi::VFS_IMAGE_KERNEL_LAZY_HEADER_SIZE;
const GROUP_HEADER_SIZE: u16 = abi::VFS_IMAGE_KERNEL_LAZY_GROUP_HEADER_SIZE;
const FILE_HEADER_SIZE: u16 = abi::VFS_IMAGE_KERNEL_LAZY_FILE_HEADER_SIZE;
const GROUP_KNOWN_FLAGS: u16 = abi::VFS_IMAGE_KERNEL_LAZY_GROUP_KNOWN_FLAGS;

/// One lazy archive the image declares: an image-assigned id, the archive's
/// total byte length (what the kernel needs to bound a `host_fetch_archive`
/// read), and the VFS prefix its members were mounted under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelLazyArchive {
    pub archive_id: u32,
    pub archive_bytes: u64,
    pub mount_prefix: String,
}

/// One deferred file: the inode it backs, its real size, and — when it is an
/// archive member rather than a URL-backed single file — which archive and
/// which member within it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelLazyFile {
    pub ino: u32,
    pub size: u64,
    /// `0` for a URL-backed single lazy file (the host owns its transport).
    pub archive_id: u32,
    /// Empty exactly when `archive_id == 0`.
    pub source_path: String,
}

/// The whole decoded section: every archive the image declares, and every
/// inode whose contents are deferred.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct KernelLazyLinkage {
    pub archives: Vec<KernelLazyArchive>,
    pub files: Vec<KernelLazyFile>,
}

fn r_u16(bytes: &[u8], offset: u64) -> Result<u16, Errno> {
    let offset = usize::try_from(offset).map_err(|_| Errno::EINVAL)?;
    let end = offset.checked_add(2).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(offset..end).ok_or(Errno::EINVAL)?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

fn r_u32(bytes: &[u8], offset: u64) -> Result<u32, Errno> {
    let offset = usize::try_from(offset).map_err(|_| Errno::EINVAL)?;
    let end = offset.checked_add(4).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(offset..end).ok_or(Errno::EINVAL)?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn r_u64(bytes: &[u8], offset: u64) -> Result<u64, Errno> {
    let offset = usize::try_from(offset).map_err(|_| Errno::EINVAL)?;
    let end = offset.checked_add(8).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(offset..end).ok_or(Errno::EINVAL)?;
    let mut buf = [0u8; 8];
    buf.copy_from_slice(slice);
    Ok(u64::from_le_bytes(buf))
}

/// Read a length-prefixed UTF-8 name. Rejects invalid UTF-8 and embedded NULs:
/// both reach a path resolver, and a NUL would silently truncate a name there.
fn read_name(bytes: &[u8], offset: u64, len: u32) -> Result<String, Errno> {
    let offset = usize::try_from(offset).map_err(|_| Errno::EINVAL)?;
    let len = usize::try_from(len).map_err(|_| Errno::EINVAL)?;
    let end = offset.checked_add(len).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(offset..end).ok_or(Errno::EINVAL)?;
    if slice.contains(&0) {
        return Err(Errno::EINVAL);
    }
    core::str::from_utf8(slice)
        .map(String::from)
        .map_err(|_| Errno::EINVAL)
}

/// Decode and validate a `KLZY` lazy-linkage section.
///
/// `bytes` is the raw section payload (without the container's `u32` length
/// prefix). Returns the archives in declaration order and the deferred files
/// in the order the writer emitted them.
pub fn decode_kernel_lazy_linkage(bytes: &[u8]) -> Result<KernelLazyLinkage, Errno> {
    if bytes.len() < HEADER_SIZE as usize {
        return Err(Errno::EINVAL); // truncated header
    }
    if bytes.get(0..4) != Some(&MAGIC[..]) {
        return Err(Errno::EINVAL); // invalid magic
    }
    if r_u16(bytes, 4)? != VERSION || r_u16(bytes, 6)? != HEADER_SIZE {
        return Err(Errno::EINVAL); // unsupported version/header
    }
    let group_count = r_u32(bytes, 8)?;
    let file_count = r_u32(bytes, 12)?;
    if r_u32(bytes, 16)? != 0 {
        return Err(Errno::EINVAL); // reserved field is nonzero
    }

    let mut offset: u64 = HEADER_SIZE as u64;
    let mut archive_ids: BTreeSet<u32> = BTreeSet::new();
    let mut previous_archive_id: i64 = 0;
    let mut archives: Vec<KernelLazyArchive> = Vec::new();
    archives.try_reserve(group_count as usize).map_err(|_| Errno::ENOMEM)?;
    for _ in 0..group_count {
        let header_end = offset
            .checked_add(GROUP_HEADER_SIZE as u64)
            .ok_or(Errno::EINVAL)?;
        if header_end > bytes.len() as u64 {
            return Err(Errno::EINVAL); // group record header truncated
        }
        let record_size = r_u32(bytes, offset)?;
        let archive_id = r_u32(bytes, offset + 4)?;
        let archive_bytes = r_u64(bytes, offset + 8)?;
        let flags = r_u16(bytes, offset + 16)?;
        let reserved = r_u16(bytes, offset + 18)?;
        let mount_prefix_len = r_u32(bytes, offset + 20)?;

        // `record_size == 24 + mount_prefix_len`, within bounds. Computed in
        // u64 so a hostile 32-bit sum cannot wrap.
        let expected_size = (GROUP_HEADER_SIZE as u64)
            .checked_add(mount_prefix_len as u64)
            .ok_or(Errno::EINVAL)?;
        let record_end = offset.checked_add(record_size as u64).ok_or(Errno::EINVAL)?;
        if record_size as u64 != expected_size || record_end > bytes.len() as u64 {
            return Err(Errno::EINVAL); // invalid group record bounds
        }
        if flags & !GROUP_KNOWN_FLAGS != 0 || reserved != 0 {
            return Err(Errno::EINVAL); // unknown flag or nonzero reserved field
        }
        // Archive ids are strictly increasing, which also makes them unique.
        if archive_id == 0 || (archive_id as i64) <= previous_archive_id {
            return Err(Errno::EINVAL); // zero, duplicated, or unordered archive id
        }
        previous_archive_id = archive_id as i64;
        archive_ids.insert(archive_id);

        let mount_prefix = read_name(bytes, offset + GROUP_HEADER_SIZE as u64, mount_prefix_len)?;
        archives.push(KernelLazyArchive {
            archive_id,
            archive_bytes,
            mount_prefix,
        });
        offset = record_end;
    }

    let mut inodes: BTreeSet<u32> = BTreeSet::new();
    let mut files: Vec<KernelLazyFile> = Vec::new();
    files.try_reserve(file_count as usize).map_err(|_| Errno::ENOMEM)?;
    for _ in 0..file_count {
        let header_end = offset
            .checked_add(FILE_HEADER_SIZE as u64)
            .ok_or(Errno::EINVAL)?;
        if header_end > bytes.len() as u64 {
            return Err(Errno::EINVAL); // file record header truncated
        }
        let record_size = r_u32(bytes, offset)?;
        let ino = r_u32(bytes, offset + 4)?;
        let size = r_u64(bytes, offset + 8)?;
        let archive_id = r_u32(bytes, offset + 16)?;
        let source_path_len = r_u32(bytes, offset + 20)?;

        let expected_size = (FILE_HEADER_SIZE as u64)
            .checked_add(source_path_len as u64)
            .ok_or(Errno::EINVAL)?;
        let record_end = offset.checked_add(record_size as u64).ok_or(Errno::EINVAL)?;
        if record_size as u64 != expected_size || record_end > bytes.len() as u64 {
            return Err(Errno::EINVAL); // invalid file record bounds
        }
        if ino == 0 || !inodes.insert(ino) {
            return Err(Errno::EINVAL); // zero or duplicate inode
        }
        // A member must name a declared archive; a URL-backed file must not
        // carry a source path, and a member must.
        if archive_id == 0 {
            if source_path_len != 0 {
                return Err(Errno::EINVAL); // source path without an archive
            }
        } else {
            if !archive_ids.contains(&archive_id) {
                return Err(Errno::EINVAL); // undeclared archive id
            }
            if source_path_len == 0 {
                return Err(Errno::EINVAL); // archive member without a source path
            }
        }

        let source_path = read_name(bytes, offset + FILE_HEADER_SIZE as u64, source_path_len)?;
        files.push(KernelLazyFile {
            ino,
            size,
            archive_id,
            source_path,
        });
        offset = record_end;
    }

    if offset != bytes.len() as u64 {
        return Err(Errno::EINVAL); // trailing bytes
    }
    Ok(KernelLazyLinkage { archives, files })
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    /// Emitted by the REAL TypeScript encoder; see
    /// `host/scripts/gen-klzy-fixture.mts` for the tree it describes.
    const KLZY_FIXTURE: &[u8] = include_bytes!("testdata/klzy-v1.bin");

    fn build(groups: &[(u32, u64, &str)], files: &[(u32, u64, u32, &str)]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&MAGIC);
        out.extend_from_slice(&VERSION.to_le_bytes());
        out.extend_from_slice(&HEADER_SIZE.to_le_bytes());
        out.extend_from_slice(&(groups.len() as u32).to_le_bytes());
        out.extend_from_slice(&(files.len() as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        for (id, bytes, prefix) in groups {
            let name = prefix.as_bytes();
            out.extend_from_slice(&(GROUP_HEADER_SIZE as u32 + name.len() as u32).to_le_bytes());
            out.extend_from_slice(&id.to_le_bytes());
            out.extend_from_slice(&bytes.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // flags
            out.extend_from_slice(&0u16.to_le_bytes()); // reserved
            out.extend_from_slice(&(name.len() as u32).to_le_bytes());
            out.extend_from_slice(name);
        }
        for (ino, size, archive_id, source_path) in files {
            let name = source_path.as_bytes();
            out.extend_from_slice(&(FILE_HEADER_SIZE as u32 + name.len() as u32).to_le_bytes());
            out.extend_from_slice(&ino.to_le_bytes());
            out.extend_from_slice(&size.to_le_bytes());
            out.extend_from_slice(&archive_id.to_le_bytes());
            out.extend_from_slice(&(name.len() as u32).to_le_bytes());
            out.extend_from_slice(name);
        }
        out
    }

    fn valid() -> Vec<u8> {
        build(
            &[(1, 4096, "/usr"), (2, 8192, "/opt")],
            &[(7, 11, 0, ""), (9, 512, 1, "bin/tool"), (11, 3, 2, "share/x")],
        )
    }

    #[test]
    fn decodes_groups_and_files_in_order() {
        let decoded = decode_kernel_lazy_linkage(&valid()).expect("decode");
        assert_eq!(decoded.archives.len(), 2);
        assert_eq!(decoded.archives[0].archive_id, 1);
        assert_eq!(decoded.archives[0].archive_bytes, 4096);
        assert_eq!(decoded.archives[0].mount_prefix, "/usr");
        assert_eq!(decoded.archives[1].mount_prefix, "/opt");
        assert_eq!(decoded.files.len(), 3);
        assert_eq!(decoded.files[0].ino, 7);
        assert_eq!(decoded.files[0].size, 11);
        assert_eq!(decoded.files[0].archive_id, 0);
        assert_eq!(decoded.files[0].source_path, "");
        assert_eq!(decoded.files[1].archive_id, 1);
        assert_eq!(decoded.files[1].source_path, "bin/tool");
        assert_eq!(decoded.files[2].archive_id, 2);
    }

    #[test]
    fn empty_section_decodes_to_no_linkage() {
        let decoded = decode_kernel_lazy_linkage(&build(&[], &[])).expect("decode");
        assert_eq!(decoded, KernelLazyLinkage::default());
    }

    #[test]
    fn rejects_truncated_header() {
        for len in 0..HEADER_SIZE as usize {
            assert!(decode_kernel_lazy_linkage(&valid()[..len]).is_err(), "len {len}");
        }
    }

    #[test]
    fn rejects_bad_magic_version_and_header_size() {
        let mut bad = valid();
        bad[0] ^= 0xff;
        assert!(decode_kernel_lazy_linkage(&bad).is_err(), "magic");
        let mut bad = valid();
        bad[4..6].copy_from_slice(&2u16.to_le_bytes());
        assert!(decode_kernel_lazy_linkage(&bad).is_err(), "version");
        let mut bad = valid();
        bad[6..8].copy_from_slice(&24u16.to_le_bytes());
        assert!(decode_kernel_lazy_linkage(&bad).is_err(), "header size");
    }

    #[test]
    fn rejects_nonzero_reserved_fields() {
        let mut bad = valid();
        bad[16..20].copy_from_slice(&1u32.to_le_bytes());
        assert!(decode_kernel_lazy_linkage(&bad).is_err(), "header reserved");
        // Group 0's reserved u16 lives at header + 18.
        let mut bad = valid();
        let at = HEADER_SIZE as usize + 18;
        bad[at..at + 2].copy_from_slice(&1u16.to_le_bytes());
        assert!(decode_kernel_lazy_linkage(&bad).is_err(), "group reserved");
    }

    #[test]
    fn rejects_unknown_group_flags() {
        let mut bad = valid();
        let at = HEADER_SIZE as usize + 16;
        bad[at..at + 2].copy_from_slice(&1u16.to_le_bytes());
        assert!(decode_kernel_lazy_linkage(&bad).is_err());
    }

    #[test]
    fn rejects_zero_duplicate_and_unordered_archive_ids() {
        assert!(decode_kernel_lazy_linkage(&build(&[(0, 1, "/usr")], &[])).is_err(), "zero");
        assert!(
            decode_kernel_lazy_linkage(&build(&[(3, 1, "/a"), (3, 1, "/b")], &[])).is_err(),
            "duplicate"
        );
        assert!(
            decode_kernel_lazy_linkage(&build(&[(4, 1, "/a"), (2, 1, "/b")], &[])).is_err(),
            "unordered"
        );
    }

    #[test]
    fn rejects_zero_and_duplicate_inodes() {
        assert!(decode_kernel_lazy_linkage(&build(&[], &[(0, 1, 0, "")])).is_err(), "zero ino");
        assert!(
            decode_kernel_lazy_linkage(&build(&[], &[(5, 1, 0, ""), (5, 2, 0, "")])).is_err(),
            "duplicate ino"
        );
    }

    #[test]
    fn rejects_source_path_and_archive_id_mismatch() {
        assert!(
            decode_kernel_lazy_linkage(&build(&[], &[(5, 1, 0, "bin/x")])).is_err(),
            "source path without archive"
        );
        assert!(
            decode_kernel_lazy_linkage(&build(&[(1, 1, "/usr")], &[(5, 1, 1, "")])).is_err(),
            "archive member without source path"
        );
        assert!(
            decode_kernel_lazy_linkage(&build(&[(1, 1, "/usr")], &[(5, 1, 2, "bin/x")])).is_err(),
            "undeclared archive id"
        );
    }

    #[test]
    fn rejects_inconsistent_record_size() {
        let mut bad = valid();
        let at = HEADER_SIZE as usize;
        let size = u32::from_le_bytes([bad[at], bad[at + 1], bad[at + 2], bad[at + 3]]);
        bad[at..at + 4].copy_from_slice(&(size + 1).to_le_bytes());
        assert!(decode_kernel_lazy_linkage(&bad).is_err());
    }

    #[test]
    fn rejects_record_size_overflowing_the_section() {
        let mut bad = valid();
        let at = HEADER_SIZE as usize;
        bad[at..at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        bad[at + 20..at + 24].copy_from_slice(&(u32::MAX - GROUP_HEADER_SIZE as u32).to_le_bytes());
        assert!(decode_kernel_lazy_linkage(&bad).is_err());
    }

    #[test]
    fn rejects_trailing_bytes() {
        let mut bad = valid();
        bad.push(0);
        assert!(decode_kernel_lazy_linkage(&bad).is_err());
    }

    #[test]
    fn rejects_invalid_utf8_and_embedded_nul_names() {
        let mut bad = build(&[(1, 4096, "abcd")], &[]);
        let at = HEADER_SIZE as usize + GROUP_HEADER_SIZE as usize;
        bad[at] = 0xff;
        assert!(decode_kernel_lazy_linkage(&bad).is_err(), "invalid utf-8");
        let mut bad = build(&[(1, 4096, "abcd")], &[]);
        bad[at] = 0;
        assert!(decode_kernel_lazy_linkage(&bad).is_err(), "embedded NUL");
    }

    #[test]
    fn rejects_truncation_at_every_length() {
        // Every prefix of a valid section is either a decodable shorter
        // section or an error; none may panic.
        let full = valid();
        for len in 0..full.len() {
            let _ = decode_kernel_lazy_linkage(&full[..len]);
        }
    }

    #[test]
    fn declared_counts_larger_than_the_payload_are_rejected_without_overallocating() {
        // A hostile count must not drive a multi-gigabyte reservation before
        // the framing check runs; `try_reserve` turns that into an error.
        let mut bad = valid();
        bad[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(decode_kernel_lazy_linkage(&bad).is_err());
        let mut bad = valid();
        bad[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(decode_kernel_lazy_linkage(&bad).is_err());
    }

    #[test]
    fn ts_emitted_fixture_round_trips() {
        let decoded = decode_kernel_lazy_linkage(KLZY_FIXTURE).expect("decode TS fixture");
        assert_eq!(
            decoded.archives,
            vec![
                KernelLazyArchive {
                    archive_id: 1,
                    archive_bytes: 4096,
                    mount_prefix: String::from("/usr"),
                },
                KernelLazyArchive {
                    archive_id: 2,
                    archive_bytes: 8192,
                    mount_prefix: String::from("/opt/ünïcøde"),
                },
            ]
        );
        // One URL-backed lazy file, then the archive members of both groups.
        let url_backed: Vec<&KernelLazyFile> =
            decoded.files.iter().filter(|f| f.archive_id == 0).collect();
        assert_eq!(url_backed.len(), 1);
        assert_eq!(url_backed[0].size, 4242);
        assert_eq!(url_backed[0].source_path, "");

        let members: Vec<(u32, u64, &str)> = decoded
            .files
            .iter()
            .filter(|f| f.archive_id != 0)
            .map(|f| (f.archive_id, f.size, f.source_path.as_str()))
            .collect();
        assert_eq!(
            members,
            vec![
                (1, 12u64, "bin/one"),
                (1, 34u64, "share/tw ö.txt"),
                (2, 56u64, "lib/three"),
            ]
        );
    }
}

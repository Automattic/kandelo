//! The `/` image's in-body deferred-file section ("SDEF").
//!
//! # What it carries, and why it lives in the filesystem
//!
//! A deferred file is one the image describes but does not contain: the image
//! records how big it really is and how to obtain it, and something fetches the
//! bytes on demand. That description used to live in JSON sections appended
//! after the filesystem body, which made an image have TWO authors — the writer
//! of the body and the writer of the JSON — and therefore two descriptions of
//! the same files that could disagree. They did: a body written by one producer
//! and metadata carried over from another assign different inode numbers, and
//! every deferred file silently became an empty regular file.
//!
//! Putting the record in the body removes the second author. There is one
//! artifact, written once, and "the metadata disagrees with the filesystem"
//! stops being a state that can be expressed.
//!
//! # Two checks this makes unrepresentable, which is not the same as removing
//!
//! Worth stating precisely, because a reader who finds them gone should know
//! they were retired by construction rather than dropped for convenience:
//!
//! * A **production-side check** that an image's deferred metadata resolves in
//!   its own body. It compared two things this format does not have two of.
//! * The **`KLZY`-versus-JSON check**, which compared the image's two
//!   DESCRIPTIONS of its deferred files against each other. That one was
//!   always the weaker of the pair: both descriptions could agree perfectly
//!   and both still disagree with the body, which is exactly the defect that
//!   motivated this format. Agreement between two descriptions is not
//!   agreement with the thing described.
//!
//! What does NOT go away is validating an image that arrives from outside. A
//! boot descriptor or a shared URL is untrusted input, and no property of our
//! own writer says anything about an image our writer did not produce. That is
//! why [`decode`] is written to the contract below rather than trusting its
//! input, and why a restore-time check on what arrives is not redundant with a
//! production-time check on what we emit: they defend against different
//! things.
//!
//! # What the kernel understands, and what it refuses to
//!
//! The line is **whether the kernel acts on the field**, not whether the field
//! is small or convenient to carry. A record names the inode that is deferred,
//! the file's real length, and — when the bytes are a member of a lazy archive
//! rather than a standalone fetch — which archive and which member within it.
//! The kernel acts on every one of those: it needs the inode to find the file,
//! the size to answer `stat` and bound a read, and the archive linkage to know
//! which archive to fetch and what to extract from it.
//!
//! Everything the kernel merely carries stays in the payload — fetch URL,
//! transport, integrity digest, activation mode, atomic-group seal — and is
//! **never inspected here**. The kernel is a courier for those. Whoever fetches still decides whether a URL may be fetched,
//! validates the digest, and honours the activation mode; carrying the bytes
//! authorises nothing. The format already does exactly this for symlink
//! targets, and storing a target confers no authority over what it resolves to.
//!
//! # Why the archive linkage is a field and not payload bytes
//!
//! This section exists to become an image's ONE description of its deferred
//! files, which means it has to carry everything the section it replaces
//! carried — and [`crate::klzy`] carries the archive linkage as typed, checked
//! fields. Burying that linkage in the payload would not preserve the courier
//! property, it would destroy it: the kernel would have to parse the payload to
//! fetch an archive member, and "the payload is opaque" would become a comment
//! rather than a fact. Promoting the two fields the kernel already acts on
//! keeps the opaque half genuinely opaque.
//!
//! Keeping the payload opaque is also what bounds the attack surface. An image
//! can arrive from a shared link, so these bytes are untrusted input, and the
//! less structure this parser understands the less there is to get wrong.
//!
//! # Parser contract
//!
//! Total and bounded: every framing or consistency violation yields
//! [`Errno::EINVAL`], and no input causes a panic or an unbounded allocation.
//! Record count and payload length are capped, every offset is checked against
//! the section's own length, and inode numbers must strictly ascend — which
//! rejects duplicates and lets a lookup binary-search rather than scan.
//!
//! This is the same discipline [`crate::klzy`] already applies to the section
//! this one replaces.

use alloc::vec::Vec;
use wasm_posix_shared::Errno;

/// "SDEF", little-endian.
pub const MAGIC: [u8; 4] = *b"SDEF";
/// Version 2 adds the archive linkage. There is no version 1 image anywhere —
/// nothing has ever emitted this section outside its own tests — so the bump
/// does not exist for compatibility with a deployed artifact. It exists so a
/// kernel built before the linkage landed REJECTS a section it would otherwise
/// misread as v1, whose records are eight bytes shorter. A stale binary should
/// fail loudly rather than silently read an archive member as a URL-backed file.
pub const VERSION: u16 = 2;
pub const HEADER_SIZE: u16 = 16;
/// `record_size | ino | size | archive_id | source_path_len | payload_len` —
/// the fixed part of one record.
pub const RECORD_HEADER_SIZE: u32 = 28;

/// Caps that make a hostile section cheap to reject.
///
/// Neither is a format limit anyone should design against: a million deferred
/// files is far past any real image (the largest today declares 79), and a
/// 64 KiB payload is far past any real fetch descriptor. They exist so a
/// corrupt length field cannot make the kernel allocate.
pub const MAX_RECORDS: u32 = 1 << 20;
pub const MAX_PAYLOAD_LEN: u32 = 64 * 1024;
/// A member path inside an archive. `PATH_MAX`, for the same reason the other
/// two caps exist: a corrupt length field must be cheap to reject.
pub const MAX_SOURCE_PATH_LEN: u32 = 4096;

/// One deferred file, as the section describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeferredRecord {
    /// The SFFS inode whose contents are deferred.
    pub ino: u32,
    /// The file's real length. The inode in the body is a zero-length stub.
    pub size: u64,
    /// The lazy archive backing this file, or `0` when the bytes are fetched
    /// standalone and the payload is the only way to locate them. Mirrors
    /// [`crate::klzy::KernelLazyFile::archive_id`].
    pub archive_id: u32,
    /// The member path within `archive_id`. Non-empty exactly when
    /// `archive_id != 0`; the encoder and decoder both enforce that, so a
    /// reader never has to decide what a half-specified linkage means.
    pub source_path: Vec<u8>,
    /// Opaque fetch description. Meaningful only to whoever fetches.
    pub payload: Vec<u8>,
}

/// A decoded section. Records are ordered by `ino` and each `ino` appears once.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeferredSection {
    pub records: Vec<DeferredRecord>,
}

impl DeferredSection {
    /// The record for `ino`, if the section declares one.
    pub fn get(&self, ino: u32) -> Option<&DeferredRecord> {
        self.records
            .binary_search_by_key(&ino, |record| record.ino)
            .ok()
            .map(|index| &self.records[index])
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }
}

fn r_u16(bytes: &[u8], offset: usize) -> Result<u16, Errno> {
    let end = offset.checked_add(2).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(offset..end).ok_or(Errno::EINVAL)?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

fn r_u32(bytes: &[u8], offset: usize) -> Result<u32, Errno> {
    let end = offset.checked_add(4).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(offset..end).ok_or(Errno::EINVAL)?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn r_u64(bytes: &[u8], offset: usize) -> Result<u64, Errno> {
    let end = offset.checked_add(8).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(offset..end).ok_or(Errno::EINVAL)?;
    let mut buf = [0u8; 8];
    buf.copy_from_slice(slice);
    Ok(u64::from_le_bytes(buf))
}

/// Serialize `records` into a section.
///
/// Records must already be sorted by `ino` with no duplicates; that is the
/// writer's job and a violation is a writer bug, so it is reported rather than
/// silently repaired.
pub fn encode(records: &[DeferredRecord]) -> Result<Vec<u8>, Errno> {
    if records.len() > MAX_RECORDS as usize {
        return Err(Errno::EINVAL);
    }
    let mut previous: Option<u32> = None;
    for record in records {
        if record.ino == 0 {
            return Err(Errno::EINVAL);
        }
        if let Some(previous) = previous {
            if record.ino <= previous {
                return Err(Errno::EINVAL);
            }
        }
        previous = Some(record.ino);
        if record.payload.len() > MAX_PAYLOAD_LEN as usize {
            return Err(Errno::EINVAL);
        }
        if record.source_path.len() > MAX_SOURCE_PATH_LEN as usize {
            return Err(Errno::EINVAL);
        }
        // Half a linkage has no meaning: an archive with no member to extract,
        // or a member with no archive to extract it from. Refused here so the
        // decoder never has to invent a reading for one.
        if (record.archive_id == 0) != record.source_path.is_empty() {
            return Err(Errno::EINVAL);
        }
    }

    let mut out = Vec::new();
    out.extend_from_slice(&MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&HEADER_SIZE.to_le_bytes());
    out.extend_from_slice(&(records.len() as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // reserved

    for record in records {
        let payload_len = record.payload.len() as u32;
        let source_path_len = record.source_path.len() as u32;
        // Records stay 4-aligned so a reader never makes an unaligned access
        // and so `record_size` can be validated without knowing the padding
        // rule separately.
        let unpadded = RECORD_HEADER_SIZE
            .checked_add(source_path_len)
            .and_then(|n| n.checked_add(payload_len))
            .ok_or(Errno::EINVAL)?;
        let record_size = unpadded.next_multiple_of(4);
        out.extend_from_slice(&record_size.to_le_bytes());
        out.extend_from_slice(&record.ino.to_le_bytes());
        out.extend_from_slice(&record.size.to_le_bytes());
        out.extend_from_slice(&record.archive_id.to_le_bytes());
        out.extend_from_slice(&source_path_len.to_le_bytes());
        out.extend_from_slice(&payload_len.to_le_bytes());
        out.extend_from_slice(&record.source_path);
        out.extend_from_slice(&record.payload);
        for _ in unpadded..record_size {
            out.push(0);
        }
    }
    Ok(out)
}

/// Parse a section. Every malformed input is [`Errno::EINVAL`]; none panics.
pub fn decode(bytes: &[u8]) -> Result<DeferredSection, Errno> {
    if bytes.len() < HEADER_SIZE as usize {
        return Err(Errno::EINVAL);
    }
    if bytes[0..4] != MAGIC {
        return Err(Errno::EINVAL);
    }
    if r_u16(bytes, 4)? != VERSION {
        return Err(Errno::EINVAL);
    }
    if r_u16(bytes, 6)? != HEADER_SIZE {
        return Err(Errno::EINVAL);
    }
    let record_count = r_u32(bytes, 8)?;
    if record_count > MAX_RECORDS {
        return Err(Errno::EINVAL);
    }
    // Reserved fields are checked rather than ignored, so a later version that
    // gives this field meaning cannot be silently misread by this one.
    if r_u32(bytes, 12)? != 0 {
        return Err(Errno::EINVAL);
    }

    let mut records = Vec::new();
    // Capacity is taken from the count only after the count is capped AND
    // bounded by what the section could possibly hold, so a large count in a
    // short section cannot make this allocate.
    let smallest_record = RECORD_HEADER_SIZE as usize;
    let remaining = bytes.len() - HEADER_SIZE as usize;
    if (record_count as usize).saturating_mul(smallest_record) > remaining {
        return Err(Errno::EINVAL);
    }
    records.reserve(record_count as usize);

    let mut offset = HEADER_SIZE as usize;
    let mut previous: Option<u32> = None;
    for _ in 0..record_count {
        let record_size = r_u32(bytes, offset)?;
        if record_size < RECORD_HEADER_SIZE || record_size % 4 != 0 {
            return Err(Errno::EINVAL);
        }
        let end = offset
            .checked_add(record_size as usize)
            .ok_or(Errno::EINVAL)?;
        if end > bytes.len() {
            return Err(Errno::EINVAL);
        }
        let ino = r_u32(bytes, offset + 4)?;
        if ino == 0 {
            return Err(Errno::EINVAL);
        }
        // Strictly ascending: rejects duplicates, and lets `get` binary-search.
        if let Some(previous) = previous {
            if ino <= previous {
                return Err(Errno::EINVAL);
            }
        }
        previous = Some(ino);
        let size = r_u64(bytes, offset + 8)?;
        let archive_id = r_u32(bytes, offset + 16)?;
        let source_path_len = r_u32(bytes, offset + 20)?;
        if source_path_len > MAX_SOURCE_PATH_LEN {
            return Err(Errno::EINVAL);
        }
        // The same rule `encode` enforces, checked independently rather than
        // trusted: this section can arrive from a shared link.
        if (archive_id == 0) != (source_path_len == 0) {
            return Err(Errno::EINVAL);
        }
        let payload_len = r_u32(bytes, offset + 24)?;
        if payload_len > MAX_PAYLOAD_LEN {
            return Err(Errno::EINVAL);
        }
        let unpadded = RECORD_HEADER_SIZE
            .checked_add(source_path_len)
            .and_then(|n| n.checked_add(payload_len))
            .ok_or(Errno::EINVAL)?;
        if record_size < unpadded || record_size - unpadded >= 4 {
            // The padding must be exactly what `encode` would have written, so
            // one section has one byte representation.
            return Err(Errno::EINVAL);
        }
        let source_path_start = offset + RECORD_HEADER_SIZE as usize;
        let source_path_end = source_path_start + source_path_len as usize;
        let source_path = bytes
            .get(source_path_start..source_path_end)
            .ok_or(Errno::EINVAL)?
            .to_vec();
        let payload_start = source_path_end;
        let payload_end = payload_start + payload_len as usize;
        let payload = bytes
            .get(payload_start..payload_end)
            .ok_or(Errno::EINVAL)?
            .to_vec();
        records.push(DeferredRecord {
            ino,
            size,
            archive_id,
            source_path,
            payload,
        });
        offset = end;
    }

    // Trailing bytes mean the section and its record count disagree.
    if offset != bytes.len() {
        return Err(Errno::EINVAL);
    }
    Ok(DeferredSection { records })
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    // Byte offsets of each field WITHIN one record, named once. Several of
    // these tests corrupt a specific field; when the record gained the archive
    // linkage, the ones that hardcoded `+16` for `payload_len` kept passing
    // while poking at `archive_id` instead — refusing for a reason the test was
    // not written to check. Naming the offsets makes that mistake visible.
    const INO_AT: usize = 4;
    const ARCHIVE_ID_AT: usize = 16;
    const SOURCE_PATH_LEN_AT: usize = 20;
    const PAYLOAD_LEN_AT: usize = 24;

    fn record(ino: u32, size: u64, payload: &[u8]) -> DeferredRecord {
        DeferredRecord {
            ino,
            size,
            archive_id: 0,
            source_path: Vec::new(),
            payload: payload.to_vec(),
        }
    }

    /// An archive-member record: the linkage half this format gained in v2.
    fn member(ino: u32, size: u64, archive_id: u32, source_path: &[u8]) -> DeferredRecord {
        DeferredRecord {
            ino,
            size,
            archive_id,
            source_path: source_path.to_vec(),
            payload: Vec::new(),
        }
    }

    #[test]
    fn round_trips_records_including_an_empty_payload() {
        let records = vec![
            record(2, 4242, b"https://example.invalid/a"),
            record(7, 0, b""),
            record(9, u64::MAX, &[0xffu8; 300]),
        ];
        let encoded = encode(&records).expect("encode");
        let decoded = decode(&encoded).expect("decode");
        assert_eq!(decoded.records, records);
        assert_eq!(decoded.get(7).unwrap().size, 0);
        assert_eq!(decoded.get(9).unwrap().payload.len(), 300);
        assert!(decoded.get(3).is_none());
    }

    #[test]
    fn an_empty_section_round_trips() {
        let encoded = encode(&[]).expect("encode");
        assert_eq!(encoded.len(), HEADER_SIZE as usize);
        assert!(decode(&encoded).expect("decode").is_empty());
    }

    #[test]
    fn an_archive_member_round_trips_its_linkage_beside_an_opaque_payload() {
        let records = vec![
            member(2, 99_999, 7, b"usr/bin/php"),
            DeferredRecord {
                ino: 5,
                size: 12,
                archive_id: 3,
                source_path: b"a/b".to_vec(),
                payload: b"https://example/x".to_vec(),
            },
        ];
        let decoded = decode(&encode(&records).expect("encodes")).expect("decodes");
        assert_eq!(decoded.records, records);
        // The linkage is reachable by inode, which is how the loader will use
        // it: find the record for the inode the walk is standing on.
        let found = decoded.get(2).expect("record for ino 2");
        assert_eq!(found.archive_id, 7);
        assert_eq!(found.source_path, b"usr/bin/php");
        assert_eq!(found.size, 99_999);
    }

    #[test]
    fn a_source_path_is_carried_byte_for_byte_and_never_parsed() {
        // Not UTF-8, has a NUL, has traversal in it. The section carries member
        // paths; deciding whether one is acceptable belongs to whoever extracts
        // the archive, exactly as it does for the payload.
        let hostile: &[u8] = b"../\xff\x00etc/shadow";
        let records = vec![member(2, 1, 9, hostile)];
        let decoded = decode(&encode(&records).expect("encodes")).expect("decodes");
        assert_eq!(decoded.records[0].source_path, hostile);
    }

    #[test]
    fn refuses_a_half_specified_linkage_in_both_directions() {
        // An archive with no member to extract from it.
        let no_path = vec![DeferredRecord {
            ino: 2,
            size: 1,
            archive_id: 4,
            source_path: Vec::new(),
            payload: Vec::new(),
        }];
        assert_eq!(encode(&no_path), Err(Errno::EINVAL));

        // A member with no archive to extract it from.
        let no_archive = vec![DeferredRecord {
            ino: 2,
            size: 1,
            archive_id: 0,
            source_path: b"a".to_vec(),
            payload: Vec::new(),
        }];
        assert_eq!(encode(&no_archive), Err(Errno::EINVAL));

        // And the decoder refuses both byte-shapes independently, because a
        // section can arrive from somewhere our encoder never touched. Built by
        // encoding a valid member and then clearing one half of the pair.
        let mut bytes = encode(&[member(2, 1, 4, b"m")]).expect("encodes");
        let archive_id_at = HEADER_SIZE as usize + ARCHIVE_ID_AT;
        bytes[archive_id_at..archive_id_at + 4].copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(decode(&bytes), Err(Errno::EINVAL));

        let mut bytes = encode(&[record(2, 1, b"")]).expect("encodes");
        bytes[archive_id_at..archive_id_at + 4].copy_from_slice(&4u32.to_le_bytes());
        assert_eq!(decode(&bytes), Err(Errno::EINVAL));
    }

    #[test]
    fn refuses_an_oversized_source_path_rather_than_allocating_for_it() {
        let too_long = vec![b'x'; MAX_SOURCE_PATH_LEN as usize + 1];
        assert_eq!(encode(&[member(2, 1, 4, &too_long)]), Err(Errno::EINVAL));

        // At the cap it is accepted, so the refusal above is the cap and not an
        // off-by-one that would reject a legal path.
        let at_cap = vec![b'x'; MAX_SOURCE_PATH_LEN as usize];
        let encoded = encode(&[member(2, 1, 4, &at_cap)]).expect("cap is inclusive");
        assert_eq!(decode(&encoded).expect("decodes").records[0].source_path, at_cap);

        // A length field past the cap is refused by the decoder. Mutation
        // testing caught the obvious version of this check answering a
        // different question: overwriting the length in a short record makes
        // the FRAMING check fire first, so removing the cap changed no outcome.
        // This builds what only the cap can reject — a record that is fully
        // present, correctly framed and correctly padded, whose single fault is
        // that its member path is one byte over the cap.
        let source_path_len = MAX_SOURCE_PATH_LEN + 1;
        let record_size = (RECORD_HEADER_SIZE + source_path_len).next_multiple_of(4);
        let mut section = Vec::new();
        section.extend_from_slice(&MAGIC);
        section.extend_from_slice(&VERSION.to_le_bytes());
        section.extend_from_slice(&HEADER_SIZE.to_le_bytes());
        section.extend_from_slice(&1u32.to_le_bytes());
        section.extend_from_slice(&0u32.to_le_bytes());
        section.extend_from_slice(&record_size.to_le_bytes());
        section.extend_from_slice(&2u32.to_le_bytes()); // ino
        section.extend_from_slice(&1u64.to_le_bytes()); // size
        section.extend_from_slice(&4u32.to_le_bytes()); // archive_id: linkage is whole
        section.extend_from_slice(&source_path_len.to_le_bytes());
        section.extend_from_slice(&0u32.to_le_bytes()); // payload_len
        section.resize(HEADER_SIZE as usize + record_size as usize, b'x');
        assert_eq!(
            section.len(),
            HEADER_SIZE as usize + record_size as usize,
            "the record is fully present, not truncated"
        );
        assert_eq!(decode(&section), Err(Errno::EINVAL));
    }

    #[test]
    fn a_version_one_section_is_refused_rather_than_silently_reinterpreted() {
        // The version field is the ONLY thing separating the two record
        // layouts, and most v1 sections would fail v2's framing anyway — which
        // is why the first version of this test passed with the check removed.
        //
        // These bytes are the case that matters: a section that is VALID under
        // both layouts and means something different under each. As v1 it is
        // one deferred file with a 12-byte opaque payload and no archive. Read
        // as v2 it is a deferred file backed by archive 12 at member "abcd" —
        // a fetch from a place the writer never named. Nothing but the version
        // field distinguishes them, so this is what the field is worth.
        let payload: [u8; 12] = [
            4, 0, 0, 0, // becomes source_path_len under v2
            0, 0, 0, 0, // becomes payload_len under v2
            b'a', b'b', b'c', b'd', // becomes the member path under v2
        ];
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&MAGIC);
        bytes.extend_from_slice(&1u16.to_le_bytes()); // VERSION 1
        bytes.extend_from_slice(&HEADER_SIZE.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes()); // one record
        bytes.extend_from_slice(&0u32.to_le_bytes()); // reserved
        bytes.extend_from_slice(&32u32.to_le_bytes()); // record_size: 20 + 12
        bytes.extend_from_slice(&2u32.to_le_bytes()); // ino
        bytes.extend_from_slice(&10u64.to_le_bytes()); // size
        bytes.extend_from_slice(&12u32.to_le_bytes()); // v1 payload_len / v2 archive_id
        bytes.extend_from_slice(&payload);

        assert_eq!(decode(&bytes), Err(Errno::EINVAL), "refused as a v1 section");

        // And the reinterpretation this refuses is real, not hypothetical: the
        // same bytes with only the version field changed decode cleanly into
        // that different meaning.
        let mut as_v2 = bytes.clone();
        as_v2[4..6].copy_from_slice(&VERSION.to_le_bytes());
        let misread = decode(&as_v2).expect("well-formed as v2");
        assert_eq!(misread.records[0].archive_id, 12);
        assert_eq!(misread.records[0].source_path, b"abcd");
    }

    #[test]
    fn payload_bytes_are_returned_exactly_and_never_interpreted() {
        // The payload is opaque, so bytes that would break any structured
        // parser must survive untouched.
        let hostile: &[u8] = b"{\"url\": \x00\xff\x80 not json at all \n\r\0";
        let encoded = encode(&[record(2, 1, hostile)]).expect("encode");
        let decoded = decode(&encoded).expect("decode");
        assert_eq!(decoded.get(2).unwrap().payload, hostile);
    }

    #[test]
    fn rejects_every_framing_violation() {
        let good = encode(&[record(2, 1, b"x"), record(3, 2, b"yy")]).expect("encode");

        let mut bad_magic = good.clone();
        bad_magic[0] ^= 0xff;
        assert_eq!(decode(&bad_magic), Err(Errno::EINVAL), "magic");

        let mut bad_version = good.clone();
        bad_version[4] = 9;
        assert_eq!(decode(&bad_version), Err(Errno::EINVAL), "version");

        let mut bad_header = good.clone();
        bad_header[6] = 99;
        assert_eq!(decode(&bad_header), Err(Errno::EINVAL), "header size");

        let mut reserved = good.clone();
        reserved[12] = 1;
        assert_eq!(decode(&reserved), Err(Errno::EINVAL), "reserved must be 0");

        let mut count_too_high = good.clone();
        count_too_high[8..12].copy_from_slice(&0xffff_ffffu32.to_le_bytes());
        assert_eq!(decode(&count_too_high), Err(Errno::EINVAL), "record count");

        let mut truncated = good.clone();
        truncated.truncate(truncated.len() - 1);
        assert_eq!(decode(&truncated), Err(Errno::EINVAL), "truncated");

        let mut trailing = good.clone();
        trailing.push(0);
        assert_eq!(decode(&trailing), Err(Errno::EINVAL), "trailing bytes");

        assert_eq!(decode(&[]), Err(Errno::EINVAL), "empty input");
        assert_eq!(decode(&good[..8]), Err(Errno::EINVAL), "short header");
    }

    #[test]
    fn rejects_a_zero_or_out_of_order_inode() {
        let mut zero = encode(&[record(2, 1, b"x")]).expect("encode");
        zero[HEADER_SIZE as usize + INO_AT..HEADER_SIZE as usize + INO_AT + 4]
            .copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(decode(&zero), Err(Errno::EINVAL), "inode 0");

        // Descending and duplicate inode numbers are both rejected, which is
        // what makes `get` a binary search rather than a scan.
        let mut descending = encode(&[record(2, 1, b"x"), record(3, 1, b"y")]).expect("encode");
        // Derived from the section, not hardcoded: a record-layout change must
        // not leave this test silently poking at the wrong field and passing.
        let first_record_size =
            u32::from_le_bytes(descending[HEADER_SIZE as usize..HEADER_SIZE as usize + 4]
                .try_into()
                .expect("4 bytes")) as usize;
        let second = HEADER_SIZE as usize + first_record_size;
        descending[second + INO_AT..second + INO_AT + 4].copy_from_slice(&1u32.to_le_bytes());
        assert_eq!(decode(&descending), Err(Errno::EINVAL), "descending");

        let mut duplicate = encode(&[record(2, 1, b"x"), record(3, 1, b"y")]).expect("encode");
        duplicate[second + INO_AT..second + INO_AT + 4].copy_from_slice(&2u32.to_le_bytes());
        assert_eq!(decode(&duplicate), Err(Errno::EINVAL), "duplicate");

        assert_eq!(encode(&[record(0, 1, b"x")]), Err(Errno::EINVAL), "encode 0");
        assert_eq!(
            encode(&[record(3, 1, b"x"), record(2, 1, b"y")]),
            Err(Errno::EINVAL),
            "encode unsorted"
        );
    }

    #[test]
    fn rejects_a_record_whose_length_fields_disagree() {
        let good = encode(&[record(2, 1, b"payload")]).expect("encode");

        let mut payload_past_record = good.clone();
        payload_past_record[HEADER_SIZE as usize + PAYLOAD_LEN_AT..HEADER_SIZE as usize + PAYLOAD_LEN_AT + 4]
            .copy_from_slice(&1000u32.to_le_bytes());
        assert_eq!(decode(&payload_past_record), Err(Errno::EINVAL));

        let mut unaligned = good.clone();
        unaligned[HEADER_SIZE as usize..HEADER_SIZE as usize + 4]
            .copy_from_slice(&29u32.to_le_bytes());
        assert_eq!(decode(&unaligned), Err(Errno::EINVAL), "unaligned size");

        let mut undersized = good.clone();
        undersized[HEADER_SIZE as usize..HEADER_SIZE as usize + 4]
            .copy_from_slice(&4u32.to_le_bytes());
        assert_eq!(decode(&undersized), Err(Errno::EINVAL), "below the header");

        // Over-padding is refused so a section has exactly one encoding.
        let mut overpadded = good.clone();
        let size = u32::from_le_bytes([
            overpadded[HEADER_SIZE as usize],
            overpadded[HEADER_SIZE as usize + 1],
            overpadded[HEADER_SIZE as usize + 2],
            overpadded[HEADER_SIZE as usize + 3],
        ]);
        overpadded[HEADER_SIZE as usize..HEADER_SIZE as usize + 4]
            .copy_from_slice(&(size + 4).to_le_bytes());
        overpadded.extend_from_slice(&[0, 0, 0, 0]);
        assert_eq!(decode(&overpadded), Err(Errno::EINVAL), "over-padded");
    }

    #[test]
    fn refuses_an_oversized_payload_rather_than_allocating_for_it() {
        let huge = vec![0u8; MAX_PAYLOAD_LEN as usize + 1];
        assert_eq!(encode(&[record(2, 1, &huge)]), Err(Errno::EINVAL));

        // And a section that CLAIMS one, without carrying it, is refused
        // before the claim is used to size anything.
        let mut claim = encode(&[record(2, 1, b"x")]).expect("encode");
        claim[HEADER_SIZE as usize + PAYLOAD_LEN_AT..HEADER_SIZE as usize + PAYLOAD_LEN_AT + 4]
            .copy_from_slice(&(MAX_PAYLOAD_LEN + 1).to_le_bytes());
        assert_eq!(decode(&claim), Err(Errno::EINVAL));
    }

    #[test]
    fn the_payload_cap_bounds_one_record_even_in_a_section_large_enough_to_hold_it() {
        // Mutation testing found this cap doing nothing observable: every test
        // that exercised it had a record whose `record_size` was ALREADY too
        // small, so the framing check fired first and removing the cap changed
        // no outcome. The cap was untested, not useless — it bounds a SINGLE
        // record independently of how large the section is, so a 100 MB
        // section cannot carry one 100 MB payload.
        //
        // This builds exactly that: a well-framed record, big enough to hold
        // the payload it claims, whose only fault is that the payload is over
        // the cap. Nothing else can reject it.
        let payload_len = MAX_PAYLOAD_LEN + 1;
        let record_size = (RECORD_HEADER_SIZE + payload_len).next_multiple_of(4);
        let mut section = Vec::new();
        section.extend_from_slice(&MAGIC);
        section.extend_from_slice(&VERSION.to_le_bytes());
        section.extend_from_slice(&HEADER_SIZE.to_le_bytes());
        section.extend_from_slice(&1u32.to_le_bytes());
        section.extend_from_slice(&0u32.to_le_bytes());
        section.extend_from_slice(&record_size.to_le_bytes());
        section.extend_from_slice(&2u32.to_le_bytes());
        section.extend_from_slice(&1u64.to_le_bytes());
        section.extend_from_slice(&0u32.to_le_bytes()); // archive_id
        section.extend_from_slice(&0u32.to_le_bytes()); // source_path_len
        section.extend_from_slice(&payload_len.to_le_bytes());
        section.resize(HEADER_SIZE as usize + record_size as usize, 0);

        // Sanity: the section really is self-consistent apart from the cap, so
        // a pass here would mean the cap is the only thing that could reject
        // it — and a fail means it did.
        assert_eq!(
            section.len(),
            HEADER_SIZE as usize + record_size as usize,
            "the record is fully present, not truncated"
        );
        assert_eq!(decode(&section), Err(Errno::EINVAL));
    }

    #[test]
    fn a_huge_record_count_in_a_short_section_does_not_allocate() {
        // The count is capped AND checked against what the section could hold,
        // so a hostile header cannot turn into a multi-megabyte reservation.
        let mut header = Vec::new();
        header.extend_from_slice(&MAGIC);
        header.extend_from_slice(&VERSION.to_le_bytes());
        header.extend_from_slice(&HEADER_SIZE.to_le_bytes());
        header.extend_from_slice(&(MAX_RECORDS - 1).to_le_bytes());
        header.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(decode(&header), Err(Errno::EINVAL));
    }
}

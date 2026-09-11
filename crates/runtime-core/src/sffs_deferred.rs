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
//! Exactly three fields per record: which inode is deferred, how big the file
//! really is, and how long the payload is. It needs the first to find the file,
//! the second to answer `stat` and bound a read, and the third to hand the
//! payload on intact.
//!
//! The payload itself — fetch URL, transport, integrity digest, activation
//! mode, atomic-group seal — is **never inspected here**. The kernel is a
//! courier. Whoever fetches still decides whether a URL may be fetched,
//! validates the digest, and honours the activation mode; carrying the bytes
//! authorises nothing. The format already does exactly this for symlink
//! targets, and storing a target confers no authority over what it resolves to.
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
pub const VERSION: u16 = 1;
pub const HEADER_SIZE: u16 = 16;
/// `record_size | ino | size | payload_len` — the fixed part of one record.
pub const RECORD_HEADER_SIZE: u32 = 20;

/// Caps that make a hostile section cheap to reject.
///
/// Neither is a format limit anyone should design against: a million deferred
/// files is far past any real image (the largest today declares 79), and a
/// 64 KiB payload is far past any real fetch descriptor. They exist so a
/// corrupt length field cannot make the kernel allocate.
pub const MAX_RECORDS: u32 = 1 << 20;
pub const MAX_PAYLOAD_LEN: u32 = 64 * 1024;

/// One deferred file, as the section describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeferredRecord {
    /// The SFFS inode whose contents are deferred.
    pub ino: u32,
    /// The file's real length. The inode in the body is a zero-length stub.
    pub size: u64,
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
    }

    let mut out = Vec::new();
    out.extend_from_slice(&MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&HEADER_SIZE.to_le_bytes());
    out.extend_from_slice(&(records.len() as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // reserved

    for record in records {
        let payload_len = record.payload.len() as u32;
        // Records stay 4-aligned so a reader never makes an unaligned access
        // and so `record_size` can be validated without knowing the padding
        // rule separately.
        let unpadded = RECORD_HEADER_SIZE
            .checked_add(payload_len)
            .ok_or(Errno::EINVAL)?;
        let record_size = unpadded.next_multiple_of(4);
        out.extend_from_slice(&record_size.to_le_bytes());
        out.extend_from_slice(&record.ino.to_le_bytes());
        out.extend_from_slice(&record.size.to_le_bytes());
        out.extend_from_slice(&payload_len.to_le_bytes());
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
        let payload_len = r_u32(bytes, offset + 16)?;
        if payload_len > MAX_PAYLOAD_LEN {
            return Err(Errno::EINVAL);
        }
        let unpadded = RECORD_HEADER_SIZE
            .checked_add(payload_len)
            .ok_or(Errno::EINVAL)?;
        if record_size < unpadded || record_size - unpadded >= 4 {
            // The padding must be exactly what `encode` would have written, so
            // one section has one byte representation.
            return Err(Errno::EINVAL);
        }
        let payload_start = offset + RECORD_HEADER_SIZE as usize;
        let payload_end = payload_start + payload_len as usize;
        let payload = bytes
            .get(payload_start..payload_end)
            .ok_or(Errno::EINVAL)?
            .to_vec();
        records.push(DeferredRecord { ino, size, payload });
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

    fn record(ino: u32, size: u64, payload: &[u8]) -> DeferredRecord {
        DeferredRecord {
            ino,
            size,
            payload: payload.to_vec(),
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
        zero[HEADER_SIZE as usize + 4..HEADER_SIZE as usize + 8]
            .copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(decode(&zero), Err(Errno::EINVAL), "inode 0");

        // Descending and duplicate inode numbers are both rejected, which is
        // what makes `get` a binary search rather than a scan.
        let mut descending = encode(&[record(2, 1, b"x"), record(3, 1, b"y")]).expect("encode");
        let second = HEADER_SIZE as usize + 24;
        descending[second + 4..second + 8].copy_from_slice(&1u32.to_le_bytes());
        assert_eq!(decode(&descending), Err(Errno::EINVAL), "descending");

        let mut duplicate = encode(&[record(2, 1, b"x"), record(3, 1, b"y")]).expect("encode");
        duplicate[second + 4..second + 8].copy_from_slice(&2u32.to_le_bytes());
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
        payload_past_record[HEADER_SIZE as usize + 16..HEADER_SIZE as usize + 20]
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
        claim[HEADER_SIZE as usize + 16..HEADER_SIZE as usize + 20]
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

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
//! Two fields crossed that line in v5, and they crossed it because the kernel
//! began ACTING on them rather than because they were convenient to promote.
//!
//! * The **URI** is how the kernel names the resource when it asks the host for
//!   bytes. It used to ask by `(kind, id)` — a number the host could only
//!   resolve by keeping its own table mapping ids back to addresses, which is
//!   the second author this format exists to abolish, rebuilt one layer up. A
//!   URI is a complete address by construction, so relaying it leaves the host
//!   with nothing to remember and nothing to disagree with.
//! * The **digest** is what the kernel checks arriving bytes against. It has to
//!   be typed for the same reason the archive linkage is: a courier cannot
//!   verify what it refuses to read, and leaving the digest in the payload
//!   meant nobody verified at all — not the kernel, which could not look, and
//!   not the host, which was never asked to.
//!
//! Everything the kernel merely carries still stays in the payload — transport
//! selection, activation mode, atomic-group seal — and is **never inspected
//! here**. The kernel remains a courier for those. Whoever fetches still
//! decides whether a URI may be fetched at all and honours the activation mode;
//! carrying the bytes authorises nothing. The format already does exactly this
//! for symlink targets, and storing a target confers no authority over what it
//! resolves to.
//!
//! # What the digest defends against, stated because it is a security field
//!
//! It defends the bytes in TRANSIT, not the image. A digest proves that what
//! arrived is what the image's author described; it proves nothing about the
//! author. Anyone who can rewrite an image can rewrite the digest beside the
//! description it covers, so this is no defence against a hostile image — that
//! is still the job of whoever decides an image may be loaded. What it does
//! catch is a substituted, truncated, or corrupted fetch of an archive an
//! otherwise trustworthy image named, which is the failure that previously
//! reached the filesystem as silently wrong file contents.
//!
//! # The archive table, and the field it deliberately drops
//!
//! A record that names an archive is useless without the archive's LENGTH: the
//! kernel fetches a whole archive to extract one member, and needs the length
//! to bound that read. So the section declares every archive it references,
//! once, as `archive_id -> bytes`, and refuses a record naming one it did not
//! declare.
//!
//! `KLZY` (the retired section this one replaced; its reader was removed on
//! 2026-10-02) also carried a `mount_prefix` per archive. **This does not**,
//! because the kernel never reads it — measured, not assumed: the only thing in
//! the tree that touches `mount_prefix` is a test fixture BUILDING a KLZY
//! section. Carrying a field no consumer reads is how a format acquires
//! obligations nobody can later justify removing.
//!
//! # Why the archive linkage is a field and not payload bytes
//!
//! This section exists to become an image's ONE description of its deferred
//! files, which means it has to carry everything the section it replaces
//! carried — and `KLZY` carried the archive linkage as typed, checked
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
//! This is the same discipline the `KLZY` reader applied to the section
//! this one replaced.

use alloc::vec::Vec;
use wasm_posix_shared::Errno;

/// "SDEF", little-endian.
pub const MAGIC: [u8; 4] = *b"SDEF";
/// Version 2 added the per-file archive linkage, version 3 the archive TABLE
/// those records point into, version 4 a payload on each archive so an
/// archive's own fetch descriptor has somewhere to live, and version 5 the URI
/// and integrity digest on both kinds — the two fields the kernel stopped
/// merely carrying.
///
/// **Three bumps while building one section is worth being honest about.** Each
/// was forced by the same discovery arriving later than it should have: the
/// section carried less than the thing it replaces. KLZY has the linkage (v2),
/// KLZY has the archive table (v3), and the host-side archive JSON has the
/// descriptors (v4). Designing against "what does the thing we are replacing
/// carry" from the start would have been one change. It is recorded rather than
/// tidied because the next format that replaces another will be tempted the
/// same way.
///
/// No version of this section exists in any artifact — nothing has ever emitted
/// it outside its own tests — so no bump is for compatibility with something
/// deployed. They exist so a kernel built before each change REJECTS a section
/// it would otherwise misread: v1 records are eight bytes shorter, a v2 reader
/// reads v3's archive count as the reserved field it requires to be zero, and a
/// v3 reader reads v4's variable-length archive entries as fixed 12-byte ones,
/// and a v4 reader reads v5's URI as payload bytes and its digest as records.
/// A stale binary should fail loudly rather than silently fetch from the wrong
/// place — and for v5 that matters more than for the bumps before it, because
/// a v4 reader would not merely misread the section, it would verify nothing
/// while appearing to work.
pub const VERSION: u16 = 5;
pub const HEADER_SIZE: u16 = 16;
/// `record_size | ino | size | archive_id | source_path_len | payload_len |
/// uri_len | digest[32]` — the fixed part of one record.
pub const RECORD_HEADER_SIZE: u32 = 64;

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
/// A fetch address. Same reason again, and the same number: no real URI for an
/// image's archive approaches four kilobytes, and a corrupt length field must
/// not be able to make the kernel allocate.
pub const MAX_URI_LEN: u32 = 4096;
/// The length of the integrity digest both record kinds carry: SHA-256.
///
/// Fixed rather than length-prefixed on purpose. A variable-length digest field
/// would mean the kernel choosing an algorithm from the bytes it was handed,
/// and "which hash does this image want" is not a question an untrusted image
/// gets to answer. One algorithm, one length, and a different one later is a
/// version bump that a stale reader refuses.
pub const DIGEST_LEN: usize = 32;
/// An all-zero digest means the producer declared none.
///
/// A sentinel rather than a presence flag because it costs nothing and adds no
/// attack surface: whoever can set this field to zero can equally set it to the
/// hash of bytes they chose, so an image that wants no verification can always
/// have none. The sentinel only has to be distinguishable from a real digest,
/// and a SHA-256 of all zeroes will not be observed.
pub const DIGEST_NONE: [u8; DIGEST_LEN] = [0u8; DIGEST_LEN];
/// The fixed part of one archive-table entry:
/// `entry_size | archive_id | bytes | payload_len | uri_len | digest[32]`.
pub const ARCHIVE_ENTRY_SIZE: u32 = 56;
/// Far past any real image; the largest today declares a handful.
pub const MAX_ARCHIVES: u32 = 1 << 16;

pub const METADATA_BUDGET_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const RECORD_RESIDENT_BYTES: usize = 128;
pub(crate) const ARCHIVE_RESIDENT_BYTES: usize = 96;

pub(crate) fn copy_metadata_bytes(bytes: &[u8]) -> Result<Vec<u8>, Errno> {
    let mut copied = Vec::new();
    copied.try_reserve_exact(bytes.len()).map_err(|_| Errno::ENOMEM)?;
    copied.extend_from_slice(bytes);
    Ok(copied)
}

struct MetadataBudget<'a> {
    remaining: usize,
    admit: Option<&'a mut dyn FnMut(usize) -> Result<(), Errno>>,
}

impl MetadataBudget<'_> {
    fn take(&mut self, bytes: usize) -> Result<(), Errno> {
        let remaining = self.remaining.checked_sub(bytes).ok_or(Errno::ENOMEM)?;
        if let Some(admit) = self.admit.as_mut() { admit(bytes)?; }
        self.remaining = remaining;
        Ok(())
    }
}

struct MetadataReader<'a, F> {
    read: F,
    length: u64,
    budget: MetadataBudget<'a>,
}

impl<F: FnMut(u64, &mut [u8]) -> Result<usize, Errno>> MetadataReader<'_, F> {
    fn exact(&mut self, offset: u64, destination: &mut [u8]) -> Result<(), Errno> {
        if offset.checked_add(destination.len() as u64).ok_or(Errno::EINVAL)? > self.length {
            return Err(Errno::EINVAL);
        }
        let mut done = 0;
        while done < destination.len() {
            let length = core::cmp::min(4096, destination.len() - done);
            let count = (self.read)(offset + done as u64, &mut destination[done..done + length])?;
            if count == 0 { return Err(Errno::EINVAL); }
            if count > length { return Err(Errno::EIO); }
            done += count;
        }
        Ok(())
    }

    fn bytes(&mut self, offset: u64, length: u32) -> Result<Vec<u8>, Errno> {
        self.budget.take(length as usize)?;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(length as usize).map_err(|_| Errno::ENOMEM)?;
        bytes.resize(length as usize, 0);
        self.exact(offset, &mut bytes)?;
        Ok(bytes)
    }
}

/// One deferred file, as the section describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeferredRecord {
    /// The KIFS inode whose contents are deferred.
    pub ino: u32,
    /// The file's real length. The inode in the body is a zero-length stub.
    pub size: u64,
    /// The lazy archive backing this file, or `0` when the bytes are fetched
    /// standalone and `uri` is the only way to locate them.
    pub archive_id: u32,
    /// The member path within `archive_id`. Non-empty exactly when
    /// `archive_id != 0`; the encoder and decoder both enforce that, so a
    /// reader never has to decide what a half-specified linkage means.
    pub source_path: Vec<u8>,
    /// Where the bytes are, as an address the kernel relays to whoever fetches.
    ///
    /// Meaningful for a standalone file (`archive_id == 0`), which has no
    /// archive to be fetched with; an archive member's address is its
    /// archive's, and carrying a second one here would be a second author for
    /// the same fact. Empty means the producer named no address, which is not
    /// an error at this layer — a section can describe files a caller already
    /// has the bytes for — but it is the whole story for whether they can ever
    /// be fetched.
    pub uri: Vec<u8>,
    /// SHA-256 of the file's `size` bytes as they should land in the
    /// filesystem: the inflated member for an archive member, the fetched
    /// bytes for a standalone file. [`DIGEST_NONE`] when the producer declared
    /// none.
    pub digest: [u8; DIGEST_LEN],
    /// Opaque fetch description: transport selection, activation mode, and the
    /// atomic-group seal. Meaningful only to whoever fetches. The address and
    /// the digest are NOT in here — they are the two fields the kernel acts on
    /// and so the two it reads.
    pub payload: Vec<u8>,
}

/// One lazy archive the section declares: the id records point at, and the
/// archive's total byte length, which is what bounds a whole-archive fetch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeferredArchive {
    pub archive_id: u32,
    pub bytes: u64,
    /// Where the archive is, as an address the kernel relays to whoever
    /// fetches. Empty means the producer named none, and an archive with no
    /// address cannot be fetched at all.
    pub uri: Vec<u8>,
    /// SHA-256 of the archive's `bytes` as fetched, before any decompression.
    /// [`DIGEST_NONE`] when the producer declared none.
    ///
    /// This is the digest every production image's archives already carry in
    /// host-side JSON, given a typed home so the kernel can check it. Before
    /// v5 a Rust-written image declared how long its archives were and nothing
    /// else, and the digest was dropped on the floor by every producer that
    /// went through this format.
    pub digest: [u8; DIGEST_LEN],
    /// Opaque fetch description for the archive itself: transport selection and
    /// activation mode. Same contract as a record's payload — the kernel
    /// carries it and never reads it.
    pub payload: Vec<u8>,
}

/// A decoded section. Archives are ordered by `archive_id` and records by
/// `ino`; each appears once, and every record's archive is declared.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeferredSection {
    pub archives: Vec<DeferredArchive>,
    pub records: Vec<DeferredRecord>,
}

impl DeferredSection {
    /// The declared byte length of `archive_id`, if the section declares it.
    pub fn archive_bytes(&self, archive_id: u32) -> Option<u64> {
        self.archives
            .binary_search_by_key(&archive_id, |a| a.archive_id)
            .ok()
            .map(|i| self.archives[i].bytes)
    }
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

fn r_digest(bytes: &[u8], offset: usize) -> Result<[u8; DIGEST_LEN], Errno> {
    let end = offset.checked_add(DIGEST_LEN).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(offset..end).ok_or(Errno::EINVAL)?;
    let mut out = [0u8; DIGEST_LEN];
    out.copy_from_slice(slice);
    Ok(out)
}

fn r_u64(bytes: &[u8], offset: usize) -> Result<u64, Errno> {
    let end = offset.checked_add(8).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(offset..end).ok_or(Errno::EINVAL)?;
    let mut buf = [0u8; 8];
    buf.copy_from_slice(slice);
    Ok(u64::from_le_bytes(buf))
}

/// The SHA-256 of `bytes`, in the form a record's `digest` field holds.
pub fn digest_of(bytes: &[u8]) -> [u8; DIGEST_LEN] {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(bytes);
    let out = hasher.finalize();
    let mut digest = [0u8; DIGEST_LEN];
    digest.copy_from_slice(&out);
    digest
}

/// Whether `bytes` may be accepted for a record declaring `expected`.
///
/// [`DIGEST_NONE`] accepts anything, because the producer declared nothing to
/// check against. That is deliberately a decision this function makes ONCE
/// rather than one every caller re-derives: "no digest declared" and "digest
/// matched" must reach a caller as the same answer, or the caller acquires a
/// third branch it will eventually get wrong in the permissive direction.
///
/// Whether an image is ALLOWED to declare nothing is a different question, and
/// not this function's — it belongs to whoever decides an image may be loaded.
pub fn digest_accepts(expected: &[u8; DIGEST_LEN], bytes: &[u8]) -> bool {
    *expected == DIGEST_NONE || digest_of(bytes) == *expected
}

/// Take a caller-supplied digest: empty (the producer declared none) or
/// exactly [`DIGEST_LEN`] bytes. Any other length is a caller bug — a
/// truncated or over-long hash is not a hash — and is refused rather than
/// padded, because a padded digest would verify against nothing and look like
/// a declared one.
pub fn digest_from(digest: &[u8]) -> Result<[u8; DIGEST_LEN], Errno> {
    if digest.is_empty() {
        return Ok(DIGEST_NONE);
    }
    if digest.len() != DIGEST_LEN {
        return Err(Errno::EINVAL);
    }
    let mut out = [0u8; DIGEST_LEN];
    out.copy_from_slice(digest);
    Ok(out)
}

/// Serialize `records` into a section.
///
/// Records must already be sorted by `ino` with no duplicates; that is the
/// writer's job and a violation is a writer bug, so it is reported rather than
/// silently repaired.
pub fn encode(archives: &[DeferredArchive], records: &[DeferredRecord]) -> Result<Vec<u8>, Errno> {
    let encoded_bytes = encoded_len(archives.iter(), records.iter(), |id|
        archives.binary_search_by_key(&id, |archive| archive.archive_id).is_ok())?;
    let mut out = Vec::new();
    out.try_reserve_exact(encoded_bytes).map_err(|_| Errno::ENOMEM)?;
    let mut emit = |bytes: &[u8]| { out.extend_from_slice(bytes); Ok(()) };
    encode_header(archives.len(), records.len(), &mut emit)?;
    for archive in archives { encode_archive(archive, &mut emit)?; }
    for record in records { encode_record(record, &mut emit)?; }
    if out.len() != encoded_bytes { return Err(Errno::EIO); }
    Ok(out)
}

pub(crate) fn encoded_len<'a>(
    archives: impl ExactSizeIterator<Item = &'a DeferredArchive> + Clone,
    records: impl ExactSizeIterator<Item = &'a DeferredRecord> + Clone,
    declared: impl Fn(u32) -> bool,
) -> Result<usize, Errno> {
    if records.len() > MAX_RECORDS as usize || archives.len() > MAX_ARCHIVES as usize {
        return Err(Errno::EINVAL);
    }
    let mut previous_archive: Option<u32> = None;
    for archive in archives.clone() {
        if archive.archive_id == 0 {
            return Err(Errno::EINVAL);
        }
        if let Some(previous) = previous_archive {
            if archive.archive_id <= previous {
                return Err(Errno::EINVAL);
            }
        }
        previous_archive = Some(archive.archive_id);
        if archive.payload.len() > MAX_PAYLOAD_LEN as usize {
            return Err(Errno::EINVAL);
        }
        if archive.uri.len() > MAX_URI_LEN as usize {
            return Err(Errno::EINVAL);
        }
    }
    let mut previous: Option<u32> = None;
    for record in records.clone() {
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
        if record.uri.len() > MAX_URI_LEN as usize {
            return Err(Errno::EINVAL);
        }
        // An archive member's address is its archive's. A second one here
        // would be a second author for the same fact, which is the defect this
        // whole section exists to remove — so it is refused, not ignored.
        if record.archive_id != 0 && !record.uri.is_empty() {
            return Err(Errno::EINVAL);
        }
        // Half a linkage has no meaning: an archive with no member to extract,
        // or a member with no archive to extract it from. Refused here so the
        // decoder never has to invent a reading for one.
        if (record.archive_id == 0) != record.source_path.is_empty() {
            return Err(Errno::EINVAL);
        }
        // A record pointing at an archive the section never declared has no
        // length to bound a fetch with, so it is not a record — it is a
        // dangling reference.
        if record.archive_id != 0 && !declared(record.archive_id) {
            return Err(Errno::EINVAL);
        }
    }

    let mut budget = MetadataBudget { remaining: METADATA_BUDGET_BYTES, admit: None };
    budget.take(archives.len().checked_mul(ARCHIVE_RESIDENT_BYTES).ok_or(Errno::ENOMEM)?)?;
    budget.take(records.len().checked_mul(RECORD_RESIDENT_BYTES).ok_or(Errno::ENOMEM)?)?;
    let mut encoded_bytes = HEADER_SIZE as usize;
    for archive in archives {
        let fields = archive.uri.len().checked_add(archive.payload.len()).ok_or(Errno::ENOMEM)?;
        budget.take(fields)?;
        encoded_bytes = encoded_bytes.checked_add((ARCHIVE_ENTRY_SIZE as usize + fields).next_multiple_of(4))
            .ok_or(Errno::ENOMEM)?;
    }
    for record in records {
        let fields = record.uri.len().checked_add(record.payload.len())
            .and_then(|bytes| bytes.checked_add(record.source_path.len())).ok_or(Errno::ENOMEM)?;
        budget.take(fields)?;
        encoded_bytes = encoded_bytes.checked_add((RECORD_HEADER_SIZE as usize + fields).next_multiple_of(4))
            .ok_or(Errno::ENOMEM)?;
    }
    Ok(encoded_bytes)
}

pub(crate) fn encode_header(
    archive_count: usize,
    record_count: usize,
    emit: &mut impl FnMut(&[u8]) -> Result<(), Errno>,
) -> Result<(), Errno> {
    emit(&MAGIC)?;
    emit(&VERSION.to_le_bytes())?;
    emit(&HEADER_SIZE.to_le_bytes())?;
    emit(&(record_count as u32).to_le_bytes())?;
    emit(&(archive_count as u32).to_le_bytes())
}

pub(crate) fn encode_archive(
    archive: &DeferredArchive,
    emit: &mut impl FnMut(&[u8]) -> Result<(), Errno>,
) -> Result<(), Errno> {
    let payload_len = archive.payload.len() as u32;
    let uri_len = archive.uri.len() as u32;
    let unpadded = ARCHIVE_ENTRY_SIZE
        .checked_add(payload_len)
        .and_then(|length| length.checked_add(uri_len))
        .ok_or(Errno::EINVAL)?;
    let entry_size = unpadded.next_multiple_of(4);
    emit(&entry_size.to_le_bytes())?;
    emit(&archive.archive_id.to_le_bytes())?;
    emit(&archive.bytes.to_le_bytes())?;
    emit(&payload_len.to_le_bytes())?;
    emit(&uri_len.to_le_bytes())?;
    emit(&archive.digest)?;
    emit(&archive.payload)?;
    emit(&archive.uri)?;
    emit(&[0; 3][..(entry_size - unpadded) as usize])
}

pub(crate) fn encode_record(
    record: &DeferredRecord,
    emit: &mut impl FnMut(&[u8]) -> Result<(), Errno>,
) -> Result<(), Errno> {
    let payload_len = record.payload.len() as u32;
    let source_path_len = record.source_path.len() as u32;
    let uri_len = record.uri.len() as u32;
    let unpadded = RECORD_HEADER_SIZE
        .checked_add(source_path_len)
        .and_then(|length| length.checked_add(payload_len))
        .and_then(|length| length.checked_add(uri_len))
        .ok_or(Errno::EINVAL)?;
    let record_size = unpadded.next_multiple_of(4);
    emit(&record_size.to_le_bytes())?;
    emit(&record.ino.to_le_bytes())?;
    emit(&record.size.to_le_bytes())?;
    emit(&record.archive_id.to_le_bytes())?;
    emit(&source_path_len.to_le_bytes())?;
    emit(&payload_len.to_le_bytes())?;
    emit(&uri_len.to_le_bytes())?;
    emit(&record.digest)?;
    emit(&record.source_path)?;
    emit(&record.payload)?;
    emit(&record.uri)?;
    emit(&[0; 3][..(record_size - unpadded) as usize])
}

/// Parse within the default metadata budget; framing errors are `EINVAL`
/// and exhausted metadata admission is `ENOMEM`.
pub fn decode(bytes: &[u8]) -> Result<DeferredSection, Errno> {
    decode_from(bytes.len() as u64, METADATA_BUDGET_BYTES, |offset, destination| {
        let start = usize::try_from(offset).map_err(|_| Errno::EINVAL)?;
        let end = start.checked_add(destination.len()).ok_or(Errno::EINVAL)?;
        destination.copy_from_slice(bytes.get(start..end).ok_or(Errno::EINVAL)?);
        Ok(destination.len())
    })
}

pub fn decode_from(
    length: u64,
    budget_bytes: usize,
    read: impl FnMut(u64, &mut [u8]) -> Result<usize, Errno>,
) -> Result<DeferredSection, Errno> {
    decode_from_with_admission(length, budget_bytes, read, |_| Ok(()))
}

pub fn decode_from_with_admission(
    length: u64,
    budget_bytes: usize,
    read: impl FnMut(u64, &mut [u8]) -> Result<usize, Errno>,
    mut admit: impl FnMut(usize) -> Result<(), Errno>,
) -> Result<DeferredSection, Errno> {
    if length < u64::from(HEADER_SIZE) { return Err(Errno::EINVAL); }
    let mut input = MetadataReader { read, length, budget: MetadataBudget { remaining: budget_bytes, admit: Some(&mut admit) } };
    let mut header = [0; HEADER_SIZE as usize];
    input.exact(0, &mut header)?;
    if header[..4] != MAGIC || r_u16(&header, 4)? != VERSION || r_u16(&header, 6)? != HEADER_SIZE {
        return Err(Errno::EINVAL);
    }
    let record_count = r_u32(&header, 8)?;
    let archive_count = r_u32(&header, 12)?;
    if record_count > MAX_RECORDS || archive_count > MAX_ARCHIVES {
        return Err(Errno::EINVAL);
    }
    let minimum = u64::from(HEADER_SIZE) + u64::from(archive_count) * u64::from(ARCHIVE_ENTRY_SIZE)
        + u64::from(record_count) * u64::from(RECORD_HEADER_SIZE);
    if minimum > length { return Err(Errno::EINVAL); }
    input.budget.take((archive_count as usize).checked_mul(ARCHIVE_RESIDENT_BYTES).ok_or(Errno::ENOMEM)?)?;
    input.budget.take((record_count as usize).checked_mul(RECORD_RESIDENT_BYTES).ok_or(Errno::ENOMEM)?)?;
    let mut archives: Vec<DeferredArchive> = Vec::new();
    archives.try_reserve_exact(archive_count as usize).map_err(|_| Errno::ENOMEM)?;
    let mut at = u64::from(HEADER_SIZE);
    let mut previous_archive = None;
    for _ in 0..archive_count {
        let mut entry = [0; ARCHIVE_ENTRY_SIZE as usize];
        input.exact(at, &mut entry)?;
        let entry_size = r_u32(&entry, 0)?;
        let end = at.checked_add(u64::from(entry_size)).ok_or(Errno::EINVAL)?;
        if entry_size < ARCHIVE_ENTRY_SIZE || entry_size % 4 != 0 || end > length {
            return Err(Errno::EINVAL);
        }
        let archive_id = r_u32(&entry, 4)?;
        if archive_id == 0 || previous_archive.is_some_and(|previous| archive_id <= previous) {
            return Err(Errno::EINVAL);
        }
        previous_archive = Some(archive_id);
        let archive_bytes = r_u64(&entry, 8)?;
        let payload_len = r_u32(&entry, 16)?;
        let uri_len = r_u32(&entry, 20)?;
        if payload_len > MAX_PAYLOAD_LEN || uri_len > MAX_URI_LEN { return Err(Errno::EINVAL); }
        let digest = r_digest(&entry, 24)?;
        let unpadded = ARCHIVE_ENTRY_SIZE.checked_add(payload_len)
            .and_then(|bytes| bytes.checked_add(uri_len)).ok_or(Errno::EINVAL)?;
        if entry_size < unpadded || entry_size - unpadded >= 4 { return Err(Errno::EINVAL); }
        let payload_start = at + u64::from(ARCHIVE_ENTRY_SIZE);
        let payload = input.bytes(payload_start, payload_len)?;
        let uri = input.bytes(payload_start + u64::from(payload_len), uri_len)?;
        archives.push(DeferredArchive { archive_id, bytes: archive_bytes, uri, digest, payload });
        at = end;
    }
    if u64::from(record_count) * u64::from(RECORD_HEADER_SIZE) > length - at {
        return Err(Errno::EINVAL);
    }
    let mut records = Vec::new();
    records.try_reserve_exact(record_count as usize).map_err(|_| Errno::ENOMEM)?;
    let mut previous = None;
    for _ in 0..record_count {
        let mut entry = [0; RECORD_HEADER_SIZE as usize];
        input.exact(at, &mut entry)?;
        let record_size = r_u32(&entry, 0)?;
        let end = at.checked_add(u64::from(record_size)).ok_or(Errno::EINVAL)?;
        if record_size < RECORD_HEADER_SIZE || record_size % 4 != 0 || end > length {
            return Err(Errno::EINVAL);
        }
        let ino = r_u32(&entry, 4)?;
        if ino == 0 || previous.is_some_and(|previous| ino <= previous) { return Err(Errno::EINVAL); }
        previous = Some(ino);
        let size = r_u64(&entry, 8)?;
        let archive_id = r_u32(&entry, 16)?;
        let source_path_len = r_u32(&entry, 20)?;
        let payload_len = r_u32(&entry, 24)?;
        let uri_len = r_u32(&entry, 28)?;
        if source_path_len > MAX_SOURCE_PATH_LEN || payload_len > MAX_PAYLOAD_LEN || uri_len > MAX_URI_LEN
            || (archive_id == 0) != (source_path_len == 0)
            || (archive_id != 0 && (uri_len != 0
                || archives.binary_search_by_key(&archive_id, |archive| archive.archive_id).is_err()))
        {
            return Err(Errno::EINVAL);
        }
        let digest = r_digest(&entry, 32)?;
        let unpadded = RECORD_HEADER_SIZE.checked_add(source_path_len)
            .and_then(|bytes| bytes.checked_add(payload_len))
            .and_then(|bytes| bytes.checked_add(uri_len)).ok_or(Errno::EINVAL)?;
        if record_size < unpadded || record_size - unpadded >= 4 { return Err(Errno::EINVAL); }
        let source_path_start = at + u64::from(RECORD_HEADER_SIZE);
        let payload_start = source_path_start + u64::from(source_path_len);
        let source_path = input.bytes(source_path_start, source_path_len)?;
        let payload = input.bytes(payload_start, payload_len)?;
        let uri = input.bytes(payload_start + u64::from(payload_len), uri_len)?;
        records.push(DeferredRecord { ino, size, archive_id, source_path, uri, digest, payload });
        at = end;
    }
    if at != length { return Err(Errno::EINVAL); }
    Ok(DeferredSection { archives, records })
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
    // ... and the same for an archive-table entry, which v4 gave a length
    // prefix and a payload. Both changes moved every offset a test had
    // hardcoded, and the tests went on passing while corrupting a neighbouring
    // field. Third time in this file; named once, here.
    const A_ENTRY_SIZE_AT: usize = 0;
    const A_ID_AT: usize = 4;
    const A_PAYLOAD_LEN_AT: usize = 16;
    const ARCHIVE_ID_AT: usize = 16;
    const SOURCE_PATH_LEN_AT: usize = 20;
    const PAYLOAD_LEN_AT: usize = 24;
    const URI_LEN_AT: usize = 28;

    fn record(ino: u32, size: u64, payload: &[u8]) -> DeferredRecord {
        DeferredRecord {
            ino,
            size,
            archive_id: 0,
            source_path: Vec::new(),
            uri: Vec::new(),
            digest: DIGEST_NONE,
            payload: payload.to_vec(),
        }
    }

    /// Where the first record begins: past the header AND past however many
    /// archive-table entries the section declares. Derived, because adding the
    /// table moved this and two tests that hardcoded `HEADER_SIZE` went on
    /// passing while poking at the archive table instead of the record they
    /// meant to corrupt.
    fn records_at(section: &[u8]) -> usize {
        let archive_count = u32::from_le_bytes(section[12..16].try_into().expect("4 bytes"));
        // Walked, not multiplied: since v4 an archive entry carries a payload,
        // so the table has no fixed stride. A helper that assumed one would put
        // every offset-poking test back to corrupting the wrong field, which is
        // the mistake this helper exists to prevent.
        let mut at = HEADER_SIZE as usize;
        for _ in 0..archive_count {
            let entry_size =
                u32::from_le_bytes(section[at..at + 4].try_into().expect("4 bytes")) as usize;
            at += entry_size;
        }
        at
    }

    /// Where archive-table entry `index` begins, walked rather than multiplied.
    fn archive_at(section: &[u8], index: usize) -> usize {
        let mut at = HEADER_SIZE as usize;
        for _ in 0..index {
            let entry_size =
                u32::from_le_bytes(section[at..at + 4].try_into().expect("4 bytes")) as usize;
            at += entry_size;
        }
        at
    }

    /// Encode with an archive table DERIVED from the records. Tests that are
    /// about record fields should not have to restate the archives those
    /// records name; tests that are about the table itself call `encode`
    /// directly, below.
    fn enc(records: &[DeferredRecord]) -> Result<Vec<u8>, Errno> {
        let mut ids: Vec<u32> = records
            .iter()
            .map(|r| r.archive_id)
            .filter(|id| *id != 0)
            .collect();
        ids.sort_unstable();
        ids.dedup();
        let archives: Vec<DeferredArchive> = ids
            .into_iter()
            .map(|archive_id| DeferredArchive {
                archive_id,
                bytes: 4096,
                uri: Vec::new(),
                digest: DIGEST_NONE,
                payload: Vec::new(),
            })
            .collect();
        encode(&archives, records)
    }

    /// An archive-member record: the linkage half this format gained in v2.
    fn member(ino: u32, size: u64, archive_id: u32, source_path: &[u8]) -> DeferredRecord {
        DeferredRecord {
            ino,
            size,
            archive_id,
            source_path: source_path.to_vec(),
            uri: Vec::new(),
            digest: DIGEST_NONE,
            payload: Vec::new(),
        }
    }

    #[test]
    fn positioned_decode_bounds_requests_and_handles_short_reads() {
        let archives = vec![DeferredArchive { archive_id: 7, bytes: 123,
            uri: b"https://example.invalid/archive".to_vec(), digest: [3; DIGEST_LEN],
            payload: vec![9; 8193] }];
        let mut linked = record(5, 42, &[7; MAX_PAYLOAD_LEN as usize]);
        linked.archive_id = 7;
        linked.source_path = vec![b'p'; MAX_SOURCE_PATH_LEN as usize];
        let records = vec![record(2, u64::MAX, b"opaque"), linked];
        let bytes = encode(&archives, &records).unwrap();
        for short in [1, 3, 17, 4096] {
            let mut largest = 0;
            let decoded = decode_from(bytes.len() as u64, METADATA_BUDGET_BYTES, |offset, destination| {
                largest = largest.max(destination.len());
                let count = core::cmp::min(short, destination.len());
                destination[..count].copy_from_slice(&bytes[offset as usize..offset as usize + count]);
                Ok(count)
            }).unwrap();
            assert_eq!(decoded, DeferredSection { archives: archives.clone(), records: records.clone() });
            assert!(largest <= 4096);
        }
    }

    #[test]
    fn positioned_decode_preserves_source_errors_and_allows_a_clean_retry() {
        let bytes = enc(&[record(2, 17, &[8; 8193])]).unwrap();
        let mut requests = 0;
        let expected = decode_from(bytes.len() as u64, METADATA_BUDGET_BYTES, |offset, destination| {
            requests += 1;
            destination.copy_from_slice(&bytes[offset as usize..offset as usize + destination.len()]);
            Ok(destination.len())
        }).unwrap();
        for error in [Errno::EAGAIN, Errno::ENOMEM, Errno::EIO, Errno::ENOSPC] {
            for fail_at in 0..requests {
                let mut calls = 0;
                assert_eq!(decode_from(bytes.len() as u64, METADATA_BUDGET_BYTES, |offset, destination| {
                    if calls == fail_at { return Err(error); }
                    calls += 1;
                    destination.copy_from_slice(&bytes[offset as usize..offset as usize + destination.len()]);
                    Ok(destination.len())
                }), Err(error));
            }
        }
        assert_eq!(decode(&bytes), Ok(expected));
    }

    #[test]
    fn positioned_decode_rejects_terabyte_framing_from_its_header_without_a_body_buffer() {
        let header = encode(&[], &[]).unwrap();
        let mut calls = 0;
        assert_eq!(decode_from(1u64 << 40, METADATA_BUDGET_BYTES, |offset, destination| {
            calls += 1;
            assert_eq!(offset, 0);
            assert_eq!(destination.len(), HEADER_SIZE as usize);
            destination.copy_from_slice(&header);
            Ok(destination.len())
        }), Err(Errno::EINVAL));
        assert_eq!(calls, 1);
        assert_eq!(decode_from(u64::from(HEADER_SIZE) - 1, 0,
            |_, _| panic!("a short section must not be read")), Err(Errno::EINVAL));
    }

    #[test]
    fn shared_admission_failure_precedes_field_reads_and_preserves_typed_errors() {
        let bytes = enc(&[record(2, 9, b"payload")]).unwrap();
        for error in [Errno::ENOMEM, Errno::EAGAIN, Errno::EIO] {
            for denied_charge in [1, 2] {
                let mut charged = 0;
                let mut read_end = 0;
                let decoded = decode_from_with_admission(bytes.len() as u64, METADATA_BUDGET_BYTES,
                    |offset, destination| {
                        read_end = read_end.max(offset + destination.len() as u64);
                        destination.copy_from_slice(&bytes[offset as usize..offset as usize + destination.len()]);
                        Ok(destination.len())
                    }, |count| {
                        if count != 0 { charged += 1; }
                        if count != 0 && charged == denied_charge { Err(error) } else { Ok(()) }
                    });
                assert_eq!(decoded, Err(error));
                assert_eq!(charged, denied_charge);
                assert!(read_end <= u64::from(HEADER_SIZE) + u64::from(RECORD_HEADER_SIZE));
                if denied_charge == 1 { assert_eq!(read_end, u64::from(HEADER_SIZE)); }
            }
        }
        let mut charged_bytes = 0;
        let decoded = decode_from_with_admission(bytes.len() as u64, METADATA_BUDGET_BYTES,
            |offset, destination| {
                destination.copy_from_slice(&bytes[offset as usize..offset as usize + destination.len()]);
                Ok(destination.len())
            }, |count| { charged_bytes += count; Ok(()) });
        assert_eq!(decoded, decode(&bytes));
        assert_eq!(charged_bytes, RECORD_RESIDENT_BYTES + b"payload".len());
    }

    #[test]
    fn positioned_metadata_admission_charges_models_and_fields_before_allocation() {
        assert!(core::mem::size_of::<DeferredRecord>() <= RECORD_RESIDENT_BYTES);
        assert!(core::mem::size_of::<DeferredArchive>() <= ARCHIVE_RESIDENT_BYTES);
        let bytes = enc(&[record(2, 9, b"payload")]).unwrap();
        let budget = RECORD_RESIDENT_BYTES + b"payload".len();
        for limit in [0, budget - 1, budget] {
            let actual = decode_from(bytes.len() as u64, limit, |offset, destination| {
                destination.copy_from_slice(&bytes[offset as usize..offset as usize + destination.len()]);
                Ok(destination.len())
            });
            if limit < budget { assert_eq!(actual, Err(Errno::ENOMEM)); }
            else { assert_eq!(actual, decode(&bytes)); }
        }
        let mut header = encode(&[], &[]).unwrap();
        header[8..12].copy_from_slice(&MAX_RECORDS.to_le_bytes());
        assert_eq!(decode_from(header.len() as u64, 0, |_, destination| {
            destination.copy_from_slice(&header);
            Ok(destination.len())
        }), Err(Errno::EINVAL));
    }

    #[test]
    fn positioned_decode_refuses_generated_overbudget_records_without_a_section_buffer() {
        let count = 128u32;
        let record_bytes = u64::from(RECORD_HEADER_SIZE + MAX_PAYLOAD_LEN);
        let length = u64::from(HEADER_SIZE) + u64::from(count) * record_bytes;
        let mut transferred = 0;
        assert_eq!(decode_from(length, METADATA_BUDGET_BYTES, |offset, destination| {
            assert!(destination.len() <= 4096);
            transferred += destination.len();
            destination.fill(7);
            if offset == 0 {
                let mut header = encode(&[], &[]).unwrap();
                header[8..12].copy_from_slice(&count.to_le_bytes());
                destination.copy_from_slice(&header);
            } else if (offset - u64::from(HEADER_SIZE)) % record_bytes == 0 {
                let index = ((offset - u64::from(HEADER_SIZE)) / record_bytes) as u32;
                assert_eq!(destination.len(), RECORD_HEADER_SIZE as usize);
                destination.fill(0);
                destination[0..4].copy_from_slice(&(RECORD_HEADER_SIZE + MAX_PAYLOAD_LEN).to_le_bytes());
                destination[4..8].copy_from_slice(&(index + 1).to_le_bytes());
                destination[24..28].copy_from_slice(&MAX_PAYLOAD_LEN.to_le_bytes());
            }
            Ok(destination.len())
        }), Err(Errno::ENOMEM));
        assert!(transferred < METADATA_BUDGET_BYTES);
        let records: Vec<_> = (0..count).map(|index| record(index + 1, 0, &[7; MAX_PAYLOAD_LEN as usize])).collect();
        assert_eq!(enc(&records), Err(Errno::ENOMEM));
    }

    #[test]
    fn positioned_decode_distinguishes_truncation_and_invalid_transport_counts() {
        let bytes = enc(&[record(2, 1, b"payload")]).unwrap();
        assert_eq!(decode_from(bytes.len() as u64, METADATA_BUDGET_BYTES, |_, _| Ok(0)), Err(Errno::EINVAL));
        assert_eq!(decode_from(bytes.len() as u64, METADATA_BUDGET_BYTES,
            |_, destination| Ok(destination.len() + 1)), Err(Errno::EIO));
        assert_eq!(decode_from(bytes.len() as u64, METADATA_BUDGET_BYTES, |offset, destination| {
            if offset >= u64::from(HEADER_SIZE) { return Ok(0); }
            destination.copy_from_slice(&bytes[..destination.len()]);
            Ok(destination.len())
        }), Err(Errno::EINVAL));
    }

    #[test]
    fn round_trips_records_including_an_empty_payload() {
        let records = vec![
            record(2, 4242, b"https://example.invalid/a"),
            record(7, 0, b""),
            record(9, u64::MAX, &[0xffu8; 300]),
        ];
        let encoded = enc(&records).expect("encode");
        let decoded = decode(&encoded).expect("decode");
        assert_eq!(decoded.records, records);
        assert_eq!(decoded.get(7).unwrap().size, 0);
        assert_eq!(decoded.get(9).unwrap().payload.len(), 300);
        assert!(decoded.get(3).is_none());
    }

    #[test]
    fn an_empty_section_round_trips() {
        let encoded = enc(&[]).expect("encode");
        assert_eq!(encoded.len(), HEADER_SIZE as usize);
        assert!(decode(&encoded).expect("decode").is_empty());
    }

    #[test]
    fn fallible_encoding_sinks_preserve_exact_bytes_and_stop_on_error() {
        let archives = vec![DeferredArchive { archive_id: 3, bytes: 123, uri: b"archive".to_vec(),
            digest: [9; DIGEST_LEN], payload: vec![11; 4097] }];
        let records = vec![record(2, 42, b"standalone"), member(7, 88, 3, b"member/path")];
        let expected = encode(&archives, &records).unwrap();
        let length = encoded_len(archives.iter(), records.iter(), |id| id == 3).unwrap();
        assert_eq!(length, expected.len());
        for limit in [0, 4, 15, 16, 56, 4096, expected.len() - 1, expected.len()] {
            let mut actual = Vec::new();
            let mut stopped = false;
            let mut emit = |bytes: &[u8]| {
                assert!(!stopped);
                if bytes.len() > limit - actual.len() { stopped = true; return Err(Errno::ENOSPC); }
                actual.extend_from_slice(bytes);
                Ok(())
            };
            let result = (|| {
                encode_header(archives.len(), records.len(), &mut emit)?;
                for archive in &archives { encode_archive(archive, &mut emit)?; }
                for record in &records { encode_record(record, &mut emit)?; }
                Ok(())
            })();
            assert_eq!(actual, expected[..actual.len()]);
            if limit == expected.len() { assert_eq!(result, Ok(())); assert_eq!(actual, expected); }
            else { assert_eq!(result, Err(Errno::ENOSPC)); }
        }
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
                uri: Vec::new(),
                digest: DIGEST_NONE,
                payload: b"https://example/x".to_vec(),
            },
        ];
        let decoded = decode(&enc(&records).expect("encodes")).expect("decodes");
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
        let decoded = decode(&enc(&records).expect("encodes")).expect("decodes");
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
            uri: Vec::new(),
            digest: DIGEST_NONE,
            payload: Vec::new(),
        }];
        assert_eq!(enc(&no_path), Err(Errno::EINVAL));

        // A member with no archive to extract it from.
        let no_archive = vec![DeferredRecord {
            ino: 2,
            size: 1,
            archive_id: 0,
            source_path: b"a".to_vec(),
            uri: Vec::new(),
            digest: DIGEST_NONE,
            payload: Vec::new(),
        }];
        assert_eq!(enc(&no_archive), Err(Errno::EINVAL));

        // And the decoder refuses both byte-shapes independently, because a
        // section can arrive from somewhere our encoder never touched. Built by
        // encoding a valid member and then clearing one half of the pair.
        let mut bytes = enc(&[member(2, 1, 4, b"m")]).expect("encodes");
        let archive_id_at = records_at(&bytes) + ARCHIVE_ID_AT;
        bytes[archive_id_at..archive_id_at + 4].copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(decode(&bytes), Err(Errno::EINVAL));

        let mut bytes = enc(&[record(2, 1, b"")]).expect("encodes");
        // Its own offset: this section declares no archives, so its records
        // start somewhere else than the one above.
        let archive_id_at = records_at(&bytes) + ARCHIVE_ID_AT;
        bytes[archive_id_at..archive_id_at + 4].copy_from_slice(&4u32.to_le_bytes());
        assert_eq!(decode(&bytes), Err(Errno::EINVAL));
    }

    #[test]
    fn refuses_an_oversized_source_path_rather_than_allocating_for_it() {
        let too_long = vec![b'x'; MAX_SOURCE_PATH_LEN as usize + 1];
        assert_eq!(enc(&[member(2, 1, 4, &too_long)]), Err(Errno::EINVAL));

        // At the cap it is accepted, so the refusal above is the cap and not an
        // off-by-one that would reject a legal path.
        let at_cap = vec![b'x'; MAX_SOURCE_PATH_LEN as usize];
        let encoded = enc(&[member(2, 1, 4, &at_cap)]).expect("cap is inclusive");
        assert_eq!(decode(&encoded).expect("decodes").records[0].source_path, at_cap);

        // A length field past the cap is refused by the decoder. Mutation
        // testing caught the obvious version of this check answering a
        // different question: overwriting the length in a short record makes
        // the FRAMING check fire first, so removing the cap changed no outcome.
        // This builds what only the cap can reject — a record that is fully
        // present, correctly framed and correctly padded, whose single fault is
        // that its member path is one byte over the cap.
        // Mutation caught this a SECOND time after the archive table landed:
        // the record named archive 4 while the section declared none, so the
        // dangling-archive rule rejected it and the cap was again unreached.
        // Every other rule this record could break is now satisfied on purpose.
        let source_path_len = MAX_SOURCE_PATH_LEN + 1;
        let record_size = (RECORD_HEADER_SIZE + source_path_len).next_multiple_of(4);
        let mut section = Vec::new();
        section.extend_from_slice(&MAGIC);
        section.extend_from_slice(&VERSION.to_le_bytes());
        section.extend_from_slice(&HEADER_SIZE.to_le_bytes());
        section.extend_from_slice(&1u32.to_le_bytes()); // one record
        section.extend_from_slice(&1u32.to_le_bytes()); // one archive
        // One archive-table entry, declared with no payload.
        section.extend_from_slice(&ARCHIVE_ENTRY_SIZE.to_le_bytes());
        section.extend_from_slice(&4u32.to_le_bytes()); // archive 4, declared
        section.extend_from_slice(&4096u64.to_le_bytes());
        section.extend_from_slice(&0u32.to_le_bytes()); // payload_len
        section.extend_from_slice(&0u32.to_le_bytes()); // uri_len
        section.extend_from_slice(&DIGEST_NONE); // digest
        let records_start = section.len();
        section.extend_from_slice(&record_size.to_le_bytes());
        section.extend_from_slice(&2u32.to_le_bytes()); // ino
        section.extend_from_slice(&1u64.to_le_bytes()); // size
        section.extend_from_slice(&4u32.to_le_bytes()); // archive_id: declared above
        section.extend_from_slice(&source_path_len.to_le_bytes());
        section.extend_from_slice(&0u32.to_le_bytes()); // payload_len
        section.extend_from_slice(&0u32.to_le_bytes()); // uri_len
        section.extend_from_slice(&DIGEST_NONE); // digest
        section.resize(records_start + record_size as usize, b'x');
        assert_eq!(
            section.len(),
            records_start + record_size as usize,
            "the record is fully present, not truncated",
        );
        assert_eq!(decode(&section), Err(Errno::EINVAL));

        // The proof that nothing ELSE rejects it: the same section with a legal
        // member path decodes. Without this the test could go on passing for a
        // third unrelated reason.
        let legal_len = MAX_SOURCE_PATH_LEN;
        let legal_size = (RECORD_HEADER_SIZE + legal_len).next_multiple_of(4);
        let mut legal = section[..records_start].to_vec();
        legal.extend_from_slice(&legal_size.to_le_bytes());
        legal.extend_from_slice(&2u32.to_le_bytes());
        legal.extend_from_slice(&1u64.to_le_bytes());
        legal.extend_from_slice(&4u32.to_le_bytes());
        legal.extend_from_slice(&legal_len.to_le_bytes());
        legal.extend_from_slice(&0u32.to_le_bytes()); // payload_len
        legal.extend_from_slice(&0u32.to_le_bytes()); // uri_len
        legal.extend_from_slice(&DIGEST_NONE); // digest
        legal.resize(records_start + legal_size as usize, b'x');
        assert_eq!(
            decode(&legal).expect("only the cap was wrong").records[0]
                .source_path
                .len(),
            legal_len as usize,
        );
    }

    #[test]
    fn the_archive_table_round_trips_and_is_reachable_by_id() {
        let archives = alloc::vec![
            DeferredArchive {
                archive_id: 3,
                bytes: 1_024,
                uri: Vec::new(),
                digest: DIGEST_NONE,
                payload: Vec::new()
            },
            DeferredArchive {
                archive_id: 9,
                bytes: 8_000_000,
                uri: Vec::new(),
                digest: DIGEST_NONE,
                payload: Vec::new()
            },
        ];
        let records = alloc::vec![member(2, 10, 3, b"a"), member(5, 20, 9, b"b/c")];
        let decoded = decode(&encode(&archives, &records).expect("encodes")).expect("decodes");
        assert_eq!(decoded.archives, archives);
        assert_eq!(decoded.records, records);
        assert_eq!(decoded.archive_bytes(3), Some(1_024));
        assert_eq!(decoded.archive_bytes(9), Some(8_000_000));
        assert_eq!(decoded.archive_bytes(4), None, "an id it never declared");
    }

    #[test]
    fn an_archives_own_fetch_description_round_trips() {
        // Without this an image declares how long its archives are and
        // nothing else — silently dropping the digest every production image's
        // archives carry today. The kernel does not read these bytes; it only
        // has to not lose them.
        let digest: &[u8] = b"https://example.invalid/php.zip#sha256:abcdef";
        let archives = alloc::vec![DeferredArchive {
            archive_id: 3,
            bytes: 8_000_000,
            uri: Vec::new(),
            digest: DIGEST_NONE,
            payload: digest.to_vec(),
        }];
        let records = alloc::vec![member(2, 10, 3, b"usr/bin/php")];
        let decoded = decode(&encode(&archives, &records).expect("encodes")).expect("decodes");
        assert_eq!(decoded.archives[0].payload, digest);
        assert_eq!(decoded.archive_bytes(3), Some(8_000_000));

        // An archive with no descriptor stays a real, representable state: the
        // format does not force one, because whether a producer must supply it
        // is a policy question (whether unverified bytes may be trusted) and
        // answering it in the format would decide it by accident.
        let bare = alloc::vec![DeferredArchive {
            archive_id: 3,
            bytes: 8_000_000,
            uri: Vec::new(),
            digest: DIGEST_NONE,
            payload: Vec::new(),
        }];
        let decoded = decode(&encode(&bare, &records).expect("encodes")).expect("decodes");
        assert!(decoded.archives[0].payload.is_empty());
    }

    #[test]
    fn archive_entries_of_different_lengths_are_all_found() {
        // Since v4 the table has no fixed stride, so every entry's position
        // depends on the one before it. A reader that multiplied would find the
        // first and garbage after it; ascending ids with DIFFERENT payload
        // lengths is what makes that visible.
        let archives = alloc::vec![
            DeferredArchive {
                archive_id: 1,
                bytes: 1,
                uri: Vec::new(),
                digest: DIGEST_NONE,
                payload: Vec::new()
            },
            DeferredArchive {
                archive_id: 2,
                bytes: 2,
                uri: Vec::new(),
                digest: DIGEST_NONE,
                payload: b"x".to_vec()
            },
            DeferredArchive {
                archive_id: 3,
                bytes: 3,
                uri: Vec::new(),
                digest: DIGEST_NONE,
                payload: b"a much longer descriptor".to_vec()
            },
            DeferredArchive {
                archive_id: 4,
                bytes: 4,
                uri: Vec::new(),
                digest: DIGEST_NONE,
                payload: b"yy".to_vec()
            },
        ];
        let decoded = decode(&encode(&archives, &[]).expect("encodes")).expect("decodes");
        assert_eq!(decoded.archives, archives);
        for (id, bytes) in [(1u32, 1u64), (2, 2), (3, 3), (4, 4)] {
            assert_eq!(decoded.archive_bytes(id), Some(bytes), "archive {id}");
        }
    }

    #[test]
    fn an_oversized_archive_descriptor_is_refused() {
        let too_long = vec![0u8; MAX_PAYLOAD_LEN as usize + 1];
        let archives = alloc::vec![DeferredArchive {
            archive_id: 3,
            bytes: 1,
            uri: Vec::new(),
            digest: DIGEST_NONE,
            payload: too_long,
        }];
        assert_eq!(encode(&archives, &[]), Err(Errno::EINVAL));

        // At the cap it encodes, so the refusal is the cap and not an
        // off-by-one turning away a legal descriptor.
        let at_cap = vec![0u8; MAX_PAYLOAD_LEN as usize];
        let ok = alloc::vec![DeferredArchive {
            archive_id: 3,
            bytes: 1,
            uri: Vec::new(),
            digest: DIGEST_NONE,
            payload: at_cap.clone(),
        }];
        assert_eq!(
            decode(&encode(&ok, &[]).expect("cap is inclusive")).expect("decodes").archives[0]
                .payload
                .len(),
            at_cap.len(),
        );

        // A length field past the cap must be refused BY THE CAP. Overwriting it
        // in a short entry makes the framing check fire first, which is how the
        // record-payload and member-path caps each got caught doing nothing.
        // So this builds an entry long enough to hold what it claims, correctly
        // framed and padded, whose single fault is the cap.
        let payload_len = MAX_PAYLOAD_LEN + 1;
        let entry_size = (ARCHIVE_ENTRY_SIZE + payload_len).next_multiple_of(4);
        let mut section = Vec::new();
        section.extend_from_slice(&MAGIC);
        section.extend_from_slice(&VERSION.to_le_bytes());
        section.extend_from_slice(&HEADER_SIZE.to_le_bytes());
        section.extend_from_slice(&0u32.to_le_bytes()); // no records
        section.extend_from_slice(&1u32.to_le_bytes()); // one archive
        section.extend_from_slice(&entry_size.to_le_bytes());
        section.extend_from_slice(&3u32.to_le_bytes()); // archive_id
        section.extend_from_slice(&1u64.to_le_bytes()); // bytes
        section.extend_from_slice(&payload_len.to_le_bytes());
        // Written explicitly, not left to the `resize` fill below. When v5 gave
        // the entry these two fields, the fill made `uri_len` read as 0x78787878
        // and the ADDRESS cap rejected the section first -- so deleting the
        // descriptor cap changed no outcome and the trial that removes it began
        // surviving. Third time in this file that an entry gaining a field put a
        // hand-built fixture onto the wrong rule.
        section.extend_from_slice(&0u32.to_le_bytes()); // uri_len
        section.extend_from_slice(&DIGEST_NONE);
        section.resize(HEADER_SIZE as usize + entry_size as usize, b'x');
        assert_eq!(
            section.len(),
            HEADER_SIZE as usize + entry_size as usize,
            "the entry is fully present, not truncated",
        );
        assert_eq!(decode(&section), Err(Errno::EINVAL));

        // The proof that only the cap rejected it: the same entry with a legal
        // descriptor length decodes.
        let legal_len = MAX_PAYLOAD_LEN;
        let legal_size = (ARCHIVE_ENTRY_SIZE + legal_len).next_multiple_of(4);
        let mut legal = section[..HEADER_SIZE as usize].to_vec();
        legal.extend_from_slice(&legal_size.to_le_bytes());
        legal.extend_from_slice(&3u32.to_le_bytes());
        legal.extend_from_slice(&1u64.to_le_bytes());
        legal.extend_from_slice(&legal_len.to_le_bytes());
        legal.extend_from_slice(&0u32.to_le_bytes());
        legal.extend_from_slice(&DIGEST_NONE);
        legal.resize(HEADER_SIZE as usize + legal_size as usize, b'x');
        assert_eq!(
            decode(&legal).expect("only the cap was wrong").archives[0]
                .payload
                .len(),
            legal_len as usize,
        );
    }

    #[test]
    fn an_over_padded_archive_entry_is_refused() {
        // One section, one byte representation — the same rule records get.
        // Without it an image has slack bytes inside its archive table that no
        // field accounts for.
        let good = encode(
            &alloc::vec![DeferredArchive {
                archive_id: 3,
                bytes: 1,
                uri: Vec::new(),
                digest: DIGEST_NONE,
                payload: b"d".to_vec(),
            }],
            &[],
        )
        .expect("encodes");
        let mut over = good.clone();
        let size_at = archive_at(&over, 0) + A_ENTRY_SIZE_AT;
        let size = u32::from_le_bytes(over[size_at..size_at + 4].try_into().expect("4 bytes"));
        over[size_at..size_at + 4].copy_from_slice(&(size + 4).to_le_bytes());
        over.extend_from_slice(&[0, 0, 0, 0]);
        assert_eq!(decode(&over), Err(Errno::EINVAL), "over-padded");
        assert!(decode(&good).is_ok(), "and the unmodified section decodes");
    }

    #[test]
    fn a_record_naming_an_undeclared_archive_is_refused_by_both_halves() {
        let declared = alloc::vec![DeferredArchive {
            archive_id: 3,
            bytes: 1,
            uri: Vec::new(),
            digest: DIGEST_NONE,
            payload: Vec::new()
        }];
        let dangling = alloc::vec![member(2, 10, 4, b"a")];
        assert_eq!(encode(&declared, &dangling), Err(Errno::EINVAL));

        // The decoder checks it independently: an image can arrive from a
        // shared link, and a dangling reference is precisely the shape that
        // would otherwise reach the fetch path with no length to bound it.
        let mut bytes = encode(&declared, &alloc::vec![member(2, 10, 3, b"a")]).expect("encodes");
        let archive_id_at = records_at(&bytes) + ARCHIVE_ID_AT;
        bytes[archive_id_at..archive_id_at + 4].copy_from_slice(&4u32.to_le_bytes());
        assert_eq!(decode(&bytes), Err(Errno::EINVAL));
    }

    #[test]
    fn archive_ids_must_be_nonzero_and_strictly_ascending() {
        let zero = alloc::vec![DeferredArchive {
            archive_id: 0,
            bytes: 1,
            uri: Vec::new(),
            digest: DIGEST_NONE,
            payload: Vec::new()
        }];
        assert_eq!(
            encode(&zero, &[]),
            Err(Errno::EINVAL),
            "0 is the no-archive sentinel"
        );

        let descending = alloc::vec![
            DeferredArchive {
                archive_id: 9,
                bytes: 1,
                uri: Vec::new(),
                digest: DIGEST_NONE,
                payload: Vec::new()
            },
            DeferredArchive {
                archive_id: 3,
                bytes: 1,
                uri: Vec::new(),
                digest: DIGEST_NONE,
                payload: Vec::new()
            },
        ];
        assert_eq!(encode(&descending, &[]), Err(Errno::EINVAL));

        let duplicate = alloc::vec![
            DeferredArchive {
                archive_id: 3,
                bytes: 1,
                uri: Vec::new(),
                digest: DIGEST_NONE,
                payload: Vec::new()
            },
            DeferredArchive {
                archive_id: 3,
                bytes: 2,
                uri: Vec::new(),
                digest: DIGEST_NONE,
                payload: Vec::new()
            },
        ];
        assert_eq!(
            encode(&duplicate, &[]),
            Err(Errno::EINVAL),
            "one archive with two lengths has no correct reading",
        );

        // The decoder enforces both independently, which is what lets
        // `archive_bytes` binary-search.
        let good = encode(
            &alloc::vec![
                DeferredArchive {
                    archive_id: 3,
                    bytes: 1,
                    uri: Vec::new(),
                    digest: DIGEST_NONE,
                    payload: Vec::new()
                },
                DeferredArchive {
                    archive_id: 9,
                    bytes: 1,
                    uri: Vec::new(),
                    digest: DIGEST_NONE,
                    payload: Vec::new()
                },
            ],
            &[],
        )
        .expect("encodes");
        let mut out_of_order = good.clone();
        let second_id = archive_at(&out_of_order, 1) + A_ID_AT;
        out_of_order[second_id..second_id + 4].copy_from_slice(&3u32.to_le_bytes());
        assert_eq!(decode(&out_of_order), Err(Errno::EINVAL), "duplicate");

        let mut zeroed = good.clone();
        let first_id = archive_at(&zeroed, 0) + A_ID_AT;
        zeroed[first_id..first_id + 4].copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(decode(&zeroed), Err(Errno::EINVAL), "zero id");

        // Both pokes are asserted to hit the FIELD they mean: with the id left
        // alone the same section decodes, so a future layout change that moves
        // these offsets fails here instead of passing for another reason.
        assert!(decode(&good).is_ok(), "the unmodified section decodes");
    }

    #[test]
    fn the_archive_cap_bounds_a_section_large_enough_to_hold_the_table() {
        // Mutation testing caught the obvious version of this doing nothing:
        // overwriting the count in a SHORT section makes the "table does not
        // fit" check fire first, so deleting the cap changed no outcome — the
        // same shape (an earlier check masking the one under test) as the
        // payload and member-path caps before it.
        //
        // This builds what only the cap can reject: a section that really is
        // long enough to hold the table it declares, with ascending nonzero
        // ids so no per-entry rule can turn it away either. The count being one
        // past the cap is its single fault.
        let build = |archive_count: u32| -> Vec<u8> {
            let mut out = Vec::new();
            out.extend_from_slice(&MAGIC);
            out.extend_from_slice(&VERSION.to_le_bytes());
            out.extend_from_slice(&HEADER_SIZE.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes()); // no records
            out.extend_from_slice(&archive_count.to_le_bytes());
            for id in 1..=archive_count {
                out.extend_from_slice(&ARCHIVE_ENTRY_SIZE.to_le_bytes());
                out.extend_from_slice(&id.to_le_bytes());
                out.extend_from_slice(&4096u64.to_le_bytes());
                out.extend_from_slice(&0u32.to_le_bytes()); // payload_len
                out.extend_from_slice(&0u32.to_le_bytes()); // uri_len
                out.extend_from_slice(&DIGEST_NONE); // digest
            }
            out
        };

        let over = build(MAX_ARCHIVES + 1);
        assert_eq!(
            over.len(),
            HEADER_SIZE as usize + (MAX_ARCHIVES as usize + 1) * ARCHIVE_ENTRY_SIZE as usize,
            "the table is fully present, not truncated",
        );
        assert_eq!(decode(&over), Err(Errno::EINVAL));

        // At the cap the same shape is accepted, so the refusal above is the
        // cap rather than an off-by-one turning away a legal section.
        assert_eq!(
            decode(&build(MAX_ARCHIVES))
                .expect("the cap is inclusive")
                .archives
                .len(),
            MAX_ARCHIVES as usize,
        );
    }

    #[test]
    fn a_table_that_does_not_fit_the_section_is_refused_before_it_is_read() {
        // A different rule from the cap: a count well inside the cap whose
        // table the section is too short to contain. Refused on the section's
        // own length, without the count being used to reserve anything.
        let mut bytes = enc(&[record(2, 1, b"x")]).expect("encodes");
        bytes[12..16].copy_from_slice(&1_000u32.to_le_bytes());
        assert_eq!(decode(&bytes), Err(Errno::EINVAL));
    }

    #[test]
    fn a_section_with_no_archives_is_byte_identical_to_one_from_before_the_table() {
        // The table costs nothing when unused: the count field is the u32 that
        // was reserved, and an empty table writes no bytes. That is what makes
        // adding it safe for the URL-backed images that have no archives.
        let records = alloc::vec![record(2, 10, b"u")];
        let with_empty_table = encode(&[], &records).expect("encodes");
        assert_eq!(
            with_empty_table.len(),
            HEADER_SIZE as usize + (RECORD_HEADER_SIZE as usize + 1).next_multiple_of(4),
            "header + one record, and not one byte of table",
        );
    }

    #[test]
    fn an_archives_address_and_digest_survive_the_round_trip() {
        // The two fields v5 promoted out of the payload. They are the whole
        // reason the kernel can fetch an archive without the host keeping a
        // second table, and verify the bytes when they arrive — so a section
        // that silently dropped either would leave both capabilities looking
        // present and doing nothing.
        let uri: &[u8] = b"https://example.invalid/php-8.3.zip";
        let digest = [0xABu8; DIGEST_LEN];
        let archives = vec![DeferredArchive {
            archive_id: 3,
            bytes: 8_000_000,
            uri: uri.to_vec(),
            digest,
            payload: b"transport=range".to_vec(),
        }];
        let records = vec![member(2, 10, 3, b"usr/bin/php")];
        let decoded = decode(&encode(&archives, &records).expect("encodes")).expect("decodes");
        assert_eq!(decoded.archives[0].uri, uri);
        assert_eq!(decoded.archives[0].digest, digest);
        // And the opaque half is still opaque and still beside them, so
        // promoting two fields did not cost the third.
        assert_eq!(decoded.archives[0].payload, b"transport=range");
    }

    #[test]
    fn a_standalone_files_address_and_digest_survive_the_round_trip() {
        // A standalone file has no archive, so its URI is the only thing in the
        // world that says where its bytes are and its digest the only thing
        // that says whether the right ones arrived.
        let uri: &[u8] = b"https://example.invalid/blobs/ls";
        let digest = [0x5Au8; DIGEST_LEN];
        let mut r = record(2, 4_242, b"activation=eager");
        r.uri = uri.to_vec();
        r.digest = digest;
        let decoded = decode(&enc(&[r]).expect("encodes")).expect("decodes");
        assert_eq!(decoded.records[0].uri, uri);
        assert_eq!(decoded.records[0].digest, digest);
        assert_eq!(decoded.records[0].payload, b"activation=eager");
    }

    #[test]
    fn an_archive_member_may_not_carry_an_address_of_its_own() {
        // An archive member is addressed by its archive. A second address on
        // the member would be a second author for one fact — the exact defect
        // this section exists to abolish — so it is refused rather than
        // ignored, by the encoder AND independently by the decoder, because a
        // section can arrive from a shared link without passing our encoder.
        let mut m = member(2, 10, 3, b"usr/bin/php");
        m.uri = b"https://example.invalid/elsewhere".to_vec();
        assert_eq!(enc(&[m]), Err(Errno::EINVAL));

        // Built by hand, because the encoder will not emit one. Assembled from
        // scratch rather than spliced out of a legal section: an earlier version
        // grew a record and patched two length fields, and the framing check
        // rejected the result before the address rule was ever reached -- so
        // deleting that rule changed no outcome and its trial survived.
        let source_path: &[u8] = b"a";
        let uri: &[u8] = b"http://x/";
        let build = |uri: &[u8]| -> Vec<u8> {
            let record_size = (RECORD_HEADER_SIZE + source_path.len() as u32 + uri.len() as u32)
                .next_multiple_of(4);
            let mut out = Vec::new();
            out.extend_from_slice(&MAGIC);
            out.extend_from_slice(&VERSION.to_le_bytes());
            out.extend_from_slice(&HEADER_SIZE.to_le_bytes());
            out.extend_from_slice(&1u32.to_le_bytes()); // one record
            out.extend_from_slice(&1u32.to_le_bytes()); // one archive
            // The archive the member names, declared with a length, so the
            // dangling-reference rule cannot be the one that rejects.
            out.extend_from_slice(&ARCHIVE_ENTRY_SIZE.to_le_bytes());
            out.extend_from_slice(&3u32.to_le_bytes());
            out.extend_from_slice(&4096u64.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes()); // payload_len
            out.extend_from_slice(&0u32.to_le_bytes()); // uri_len
            out.extend_from_slice(&DIGEST_NONE);
            let records_start = out.len();
            out.extend_from_slice(&record_size.to_le_bytes());
            out.extend_from_slice(&2u32.to_le_bytes()); // ino
            out.extend_from_slice(&10u64.to_le_bytes()); // size
            out.extend_from_slice(&3u32.to_le_bytes()); // the declared archive
            out.extend_from_slice(&(source_path.len() as u32).to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes()); // payload_len
            out.extend_from_slice(&(uri.len() as u32).to_le_bytes());
            out.extend_from_slice(&DIGEST_NONE);
            out.extend_from_slice(source_path);
            out.extend_from_slice(uri);
            out.resize(records_start + record_size as usize, 0);
            out
        };
        assert_eq!(decode(&build(uri)), Err(Errno::EINVAL));
        // The control: the identical section with no address on the member
        // decodes, so the refusal above is the address rule and not framing,
        // padding, the archive linkage, or the archive table.
        assert_eq!(
            decode(&build(b"")).expect("legal without the member's address").records[0].archive_id,
            3
        );
    }

    #[test]
    fn an_oversized_address_is_refused_rather_than_allocated_for() {
        // Same reason the payload and member-path caps exist: a length field is
        // the one part of an untrusted section that can ask the kernel to
        // allocate before anything has been validated.
        let mut over = record(2, 1, b"");
        over.uri = vec![b'u'; MAX_URI_LEN as usize + 1];
        assert_eq!(enc(&[over]), Err(Errno::EINVAL));

        // An ARCHIVE's address has its own cap and its own check. The record's
        // covered neither: `encode` validates archives in a separate loop, so a
        // test that only oversizes a record's address leaves the archive half
        // entirely unexercised.
        let over_archive = vec![DeferredArchive {
            archive_id: 3,
            bytes: 1,
            uri: vec![b'u'; MAX_URI_LEN as usize + 1],
            digest: DIGEST_NONE,
            payload: Vec::new(),
        }];
        assert_eq!(encode(&over_archive, &[]), Err(Errno::EINVAL));
        let at_cap_archive = vec![DeferredArchive {
            archive_id: 3,
            bytes: 1,
            uri: vec![b'u'; MAX_URI_LEN as usize],
            digest: DIGEST_NONE,
            payload: Vec::new(),
        }];
        assert_eq!(
            decode(&encode(&at_cap_archive, &[]).expect("the cap is inclusive"))
                .expect("decodes")
                .archives[0]
                .uri
                .len(),
            MAX_URI_LEN as usize
        );

        // At the cap it is accepted, so the refusal is the cap and not an
        // off-by-one turning away a legal address.
        let mut at_cap = record(2, 1, b"");
        at_cap.uri = vec![b'u'; MAX_URI_LEN as usize];
        let encoded = enc(&[at_cap]).expect("the cap is inclusive");
        assert_eq!(
            decode(&encoded).expect("decodes").records[0].uri.len(),
            MAX_URI_LEN as usize
        );

        // And the decoder enforces it independently, on a record that is fully
        // present and correctly framed so that only the cap can reject it —
        // the masking-check shape the member-path cap needed twice.
        let uri_len = MAX_URI_LEN + 1;
        let record_size = (RECORD_HEADER_SIZE + uri_len).next_multiple_of(4);
        let mut section = Vec::new();
        section.extend_from_slice(&MAGIC);
        section.extend_from_slice(&VERSION.to_le_bytes());
        section.extend_from_slice(&HEADER_SIZE.to_le_bytes());
        section.extend_from_slice(&1u32.to_le_bytes()); // one record
        section.extend_from_slice(&0u32.to_le_bytes()); // no archives
        let records_start = section.len();
        section.extend_from_slice(&record_size.to_le_bytes());
        section.extend_from_slice(&2u32.to_le_bytes()); // ino
        section.extend_from_slice(&1u64.to_le_bytes()); // size
        section.extend_from_slice(&0u32.to_le_bytes()); // standalone
        section.extend_from_slice(&0u32.to_le_bytes()); // source_path_len
        section.extend_from_slice(&0u32.to_le_bytes()); // payload_len
        section.extend_from_slice(&uri_len.to_le_bytes());
        section.extend_from_slice(&DIGEST_NONE);
        section.resize(records_start + record_size as usize, b'u');
        assert_eq!(decode(&section), Err(Errno::EINVAL));
    }

    #[test]
    fn a_digest_that_is_not_a_sha256_is_refused_rather_than_padded() {
        // A truncated or over-long hash is not a hash. Padding one would turn a
        // caller's mistake into a digest that verifies against nothing while
        // looking exactly like a declared one — verification that reports
        // success having checked a value nobody computed.
        assert_eq!(digest_from(&[0u8; DIGEST_LEN - 1]), Err(Errno::EINVAL));
        assert_eq!(digest_from(&[0u8; DIGEST_LEN + 1]), Err(Errno::EINVAL));
        // Empty is the one short length that means something: no digest.
        assert_eq!(digest_from(b""), Ok(DIGEST_NONE));
        assert_eq!(digest_from(&[7u8; DIGEST_LEN]), Ok([7u8; DIGEST_LEN]));
    }

    #[test]
    fn a_declared_digest_accepts_only_the_bytes_it_names() {
        // The predicate every verifying caller asks. Covered HERE, beside the
        // function, rather than only through the kernel's fetch paths: a
        // mutation that made it return `true` unconditionally survived this
        // module's own suite, because nothing in it had ever called the
        // function. A verifier that reports success having checked nothing is
        // the one failure this whole change exists to prevent, so it is not
        // covered only somewhere else.
        let bytes: &[u8] = b"the bytes the image described";
        let declared = digest_of(bytes);
        assert!(digest_accepts(&declared, bytes));
        assert!(!digest_accepts(&declared, b"something else entirely"));
        assert!(
            !digest_accepts(&declared, b"the bytes the image described "),
            "one trailing byte is a different object"
        );
        // Declaring nothing accepts anything: that is the sentinel, and it must
        // reach a caller as the same answer a match does.
        assert!(digest_accepts(&DIGEST_NONE, b"anything at all"));
        // And the algorithm is the one the format names, not whatever this
        // build happens to link: SHA-256 of the empty input, spelled out.
        assert_eq!(
            digest_of(b""),
            [
                0xe3, 0xb0, 0xc4, 0x42, 0x98, 0xfc, 0x1c, 0x14, 0x9a, 0xfb, 0xf4, 0xc8, 0x99, 0x6f,
                0xb9, 0x24, 0x27, 0xae, 0x41, 0xe4, 0x64, 0x9b, 0x93, 0x4c, 0xa4, 0x95, 0x99, 0x1b,
                0x78, 0x52, 0xb8, 0x55,
            ],
        );
    }

    #[test]
    fn the_section_header_is_the_bytes_it_has_always_been() {
        // A GOLDEN, spelled as literals on purpose.
        //
        // The neighbouring test asserts that every version but ours is refused,
        // and it is written in terms of `VERSION` — so it moves with the
        // constant and can never notice the constant changing. Mutation proved
        // that: dropping the version back to 3 left it green.
        //
        // A version number is a wire contract, not an implementation detail.
        // The only test that can hold it is one that states the byte. If this
        // fails, either the format changed — in which case bump the version and
        // update this line deliberately — or something changed it by accident,
        // which is the case this exists for.
        let empty = encode(&[], &[]).expect("encodes");
        assert_eq!(
            empty,
            alloc::vec![
                b'S', b'D', b'E', b'F', // magic
                5, 0, // version 5
                16, 0, // header size
                0, 0, 0, 0, // record count
                0, 0, 0, 0, // archive count
            ],
            "SDEF's header is a wire format; a change here is a format change",
        );

        // And the record/archive entry headers, for the same reason: a reader
        // built elsewhere lays these out by hand.
        assert_eq!(RECORD_HEADER_SIZE, 64);
        assert_eq!(ARCHIVE_ENTRY_SIZE, 56);
        assert_eq!(DIGEST_LEN, 32);
    }

    #[test]
    fn every_version_but_this_one_is_refused() {
        // The version field is what separates layouts whose records are
        // different widths, so a reader must refuse anything it was not written
        // for rather than parse it as its own. Asserted against a section this
        // encoder produced, so the only thing changed is the version.
        let good = enc(&[record(2, 10, b"abcd")]).expect("encode");
        assert!(decode(&good).is_ok(), "the unmodified section decodes");
        // VERSION - 1 matters most and was the one missing: a mutation that
        // fails to bump the version leaves the reader accepting exactly that,
        // and a loop testing only distant neighbours would not notice.
        for wrong in [0u16, VERSION - 1, VERSION + 1, u16::MAX] {
            let mut bytes = good.clone();
            bytes[4..6].copy_from_slice(&wrong.to_le_bytes());
            assert_eq!(
                decode(&bytes),
                Err(Errno::EINVAL),
                "version {wrong} must be refused, not parsed as {VERSION}",
            );
        }
    }

    #[test]
    fn a_version_one_section_cannot_be_reinterpreted_as_this_one() {
        // Version 1 had no archive linkage and a 20-byte record header, so its
        // payload-length field sits where this version reads an archive id.
        // Under v2 that WAS a clean misread -- the bytes below decoded as a
        // fetch from archive 12 at member "abcd", from a section that named no
        // archive at all -- and only the version check stood in the way.
        //
        // Version 3 closes it a second time and by construction: a record may
        // not name an archive the section did not declare, and a v1 section
        // declares none. Recorded because it is the kind of property that is
        // easy to lose in a later edit without noticing what it was doing.
        let payload: [u8; 12] = [
            4, 0, 0, 0, // v2/v3 would read: source_path_len
            0, 0, 0, 0, // v2/v3 would read: payload_len
            b'a', b'b', b'c', b'd', // v2/v3 would read: the member path
        ];
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&MAGIC);
        bytes.extend_from_slice(&1u16.to_le_bytes()); // VERSION 1
        bytes.extend_from_slice(&HEADER_SIZE.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes()); // one record
        bytes.extend_from_slice(&0u32.to_le_bytes()); // v1 reserved / v3 archive_count
        bytes.extend_from_slice(&32u32.to_le_bytes()); // record_size: 20 + 12
        bytes.extend_from_slice(&2u32.to_le_bytes()); // ino
        bytes.extend_from_slice(&10u64.to_le_bytes()); // size
        bytes.extend_from_slice(&12u32.to_le_bytes()); // v1 payload_len / v3 archive_id
        bytes.extend_from_slice(&payload);

        assert_eq!(decode(&bytes), Err(Errno::EINVAL), "refused as a v1 section");

        // And with the version corrected, it is STILL refused -- by the
        // dangling-archive rule, since archive 12 was never declared. The
        // misread is now unrepresentable rather than merely guarded against.
        let mut as_current = bytes.clone();
        as_current[4..6].copy_from_slice(&VERSION.to_le_bytes());
        assert_eq!(
            decode(&as_current),
            Err(Errno::EINVAL),
            "a record naming an undeclared archive is refused on its own",
        );
    }

    #[test]
    fn payload_bytes_are_returned_exactly_and_never_interpreted() {
        // The payload is opaque, so bytes that would break any structured
        // parser must survive untouched.
        let hostile: &[u8] = b"{\"url\": \x00\xff\x80 not json at all \n\r\0";
        let encoded = enc(&[record(2, 1, hostile)]).expect("encode");
        let decoded = decode(&encoded).expect("decode");
        assert_eq!(decoded.get(2).unwrap().payload, hostile);
    }

    #[test]
    fn rejects_every_framing_violation() {
        let good = enc(&[record(2, 1, b"x"), record(3, 2, b"yy")]).expect("encode");

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
        let mut zero = enc(&[record(2, 1, b"x")]).expect("encode");
        let ino_at = records_at(&zero) + INO_AT;
        zero[ino_at..ino_at + 4]
            .copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(decode(&zero), Err(Errno::EINVAL), "inode 0");

        // Descending and duplicate inode numbers are both rejected, which is
        // what makes `get` a binary search rather than a scan.
        let mut descending = enc(&[record(2, 1, b"x"), record(3, 1, b"y")]).expect("encode");
        // Derived from the section, not hardcoded: a record-layout change must
        // not leave this test silently poking at the wrong field and passing.
        let first_record_size =
            u32::from_le_bytes(descending[records_at(&descending)..records_at(&descending) + 4]
                .try_into()
                .expect("4 bytes")) as usize;
        let second = records_at(&descending) + first_record_size;
        descending[second + INO_AT..second + INO_AT + 4].copy_from_slice(&1u32.to_le_bytes());
        assert_eq!(decode(&descending), Err(Errno::EINVAL), "descending");

        let mut duplicate = enc(&[record(2, 1, b"x"), record(3, 1, b"y")]).expect("encode");
        duplicate[second + INO_AT..second + INO_AT + 4].copy_from_slice(&2u32.to_le_bytes());
        assert_eq!(decode(&duplicate), Err(Errno::EINVAL), "duplicate");

        assert_eq!(enc(&[record(0, 1, b"x")]), Err(Errno::EINVAL), "encode 0");
        assert_eq!(
            enc(&[record(3, 1, b"x"), record(2, 1, b"y")]),
            Err(Errno::EINVAL),
            "encode unsorted"
        );
    }

    #[test]
    fn rejects_a_record_whose_length_fields_disagree() {
        let good = enc(&[record(2, 1, b"payload")]).expect("encode");

        let mut payload_past_record = good.clone();
        let at = records_at(&payload_past_record) + PAYLOAD_LEN_AT;
        payload_past_record[at..at + 4]
            .copy_from_slice(&1000u32.to_le_bytes());
        assert_eq!(decode(&payload_past_record), Err(Errno::EINVAL));

        let mut unaligned = good.clone();
        let size_at = records_at(&unaligned);
        unaligned[size_at..size_at + 4]
            .copy_from_slice(&29u32.to_le_bytes());
        assert_eq!(decode(&unaligned), Err(Errno::EINVAL), "unaligned size");

        let mut undersized = good.clone();
        let size_at = records_at(&undersized);
        undersized[size_at..size_at + 4]
            .copy_from_slice(&4u32.to_le_bytes());
        assert_eq!(decode(&undersized), Err(Errno::EINVAL), "below the header");

        // Over-padding is refused so a section has exactly one encoding.
        let mut overpadded = good.clone();
        let size_at = records_at(&overpadded);
        let size = u32::from_le_bytes(
            overpadded[size_at..size_at + 4].try_into().expect("4 bytes"),
        );
        overpadded[size_at..size_at + 4]
            .copy_from_slice(&(size + 4).to_le_bytes());
        overpadded.extend_from_slice(&[0, 0, 0, 0]);
        assert_eq!(decode(&overpadded), Err(Errno::EINVAL), "over-padded");
    }

    #[test]
    fn refuses_an_oversized_payload_rather_than_allocating_for_it() {
        let huge = vec![0u8; MAX_PAYLOAD_LEN as usize + 1];
        assert_eq!(enc(&[record(2, 1, &huge)]), Err(Errno::EINVAL));

        // And a section that CLAIMS one, without carrying it, is refused
        // before the claim is used to size anything.
        let mut claim = enc(&[record(2, 1, b"x")]).expect("encode");
        let at = records_at(&claim) + PAYLOAD_LEN_AT;
        claim[at..at + 4]
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

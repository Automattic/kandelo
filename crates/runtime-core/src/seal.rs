//! The archive payload's two halves: a descriptor the kernel carries, and a
//! seal a consumer verifies.
//!
//! # Why this is here and not in `sdef`
//!
//! `sdef` is the FORMAT, and its contract is that the payload is
//! opaque: *"whoever fetches decides whether a URL may be fetched, validates
//! the digest, and honours the activation mode; carrying the bytes authorises
//! nothing."* This module is one of those "whoever"s — the builder's own
//! filesystem, authenticating an image before it derives from it. The format
//! still never looks inside a payload; a consumer above it does.
//!
//! # Why the descriptor and the seal are separate halves
//!
//! The seal carries a digest OF the descriptor. If they were one blob the
//! digest would cover bytes containing itself, which cannot be computed and
//! cannot be checked. So the layout says where the digested half ends.
//!
//! # What this DOES NOT establish, stated because it is a security mechanism
//!
//! A cohort digest is a DIGEST, not a signature. It proves that a cohort is
//! internally consistent — that no member was swapped, dropped, duplicated
//! under a second name, or had its descriptor edited after sealing. It proves
//! nothing about WHO sealed it: anyone able to rewrite a whole image can
//! re-seal it consistently and this will accept the result.
//!
//! That is not a regression — the TypeScript cohort digest this replaced
//! (`cohortSha256`, since deleted) had exactly the same property — but it is the difference between "this image was not
//! tampered with in part" and "this image came from someone trusted", and only
//! the first is on offer here. Whoever decides an image may be loaded at all is
//! still deciding the second, and this does not relieve them of it.
//!
//! # Why a byte layout and not JSON
//!
//! The TypeScript cohort identity was `JSON.stringify({schema:1,id,members:[…]})`.
//! A Rust verifier of images sealed that way would have to reproduce
//! JavaScript's serialiser exactly — key order, escaping, non-ASCII — over
//! member names that are archive paths. Writing the canonical form as a LAYOUT
//! removes that at the root: the canonical form IS the format, which is the
//! only place a canonical form is safe to live.

use alloc::vec::Vec;
use wasm_posix_shared::Errno;
use sha2::{Digest, Sha256};
use crate::IoBuffer;

/// Layout version. A reader that does not know a version refuses rather than
/// guessing, because a misread seal is a seal that passes for the wrong bytes.
const PAYLOAD_VERSION: u32 = 1;

/// Cohort-identity domain tag. Prefixing the digest input means a digest
/// computed for one purpose can never be mistaken for one computed for another.
const COHORT_TAG: &[u8] = b"kandelo.image.cohort.v1\0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArchiveSeal {
    /// The activation group this archive belongs to.
    pub id: Vec<u8>,
    /// This archive's name WITHIN the group, which is what the cohort digest
    /// sorts by. Not the URL: a group may carry the same URL twice under
    /// different names, and sorting by URL would silently reorder them.
    pub member: Vec<u8>,
    /// How many archives the group must contain. A cohort missing a member is
    /// a cohort that would activate partially, which is the thing atomic
    /// activation exists to prevent.
    pub expected_count: u32,
    pub cohort_digest: [u8; 32],
    pub descriptor_digest: [u8; 32],
}

/// What an archive's payload says about its cohort membership.
///
/// # Why PENDING is a state and not the absence of one
///
/// A cohort digest covers every member, so it cannot be computed when a member
/// is registered — the last member is not known yet. The producer therefore
/// records membership and the module completes the seal at export.
///
/// Between those two moments the payload says "in cohort X as member Y, digests
/// not yet computed". **That must not be representable as `None`.** An image
/// that reaches a consumer still pending is one the producer FAILED to seal,
/// and if pending read as "no cohort" that failure would arrive looking exactly
/// like an archive that was never meant to be in one. The difference between
/// "no seal was wanted" and "a seal was wanted and never written" is the entire
/// question, and two states cannot express it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SealState {
    /// Not part of an activation cohort.
    None,
    /// Declared by the producer; digests owed.
    ///
    /// It carries the expected count even though export could COUNT the
    /// pending members instead. That count is precisely what is wrong when a
    /// producer forgets one: export would seal a cohort of two that was meant
    /// to be three, every digest would agree, and the verifier would accept
    /// it. A count derived from the members cannot catch a missing member.
    Pending { id: Vec<u8>, member: Vec<u8>, expected_count: u32 },
    /// Completed at export.
    Sealed(ArchiveSeal),
}

impl SealState {
    /// The cohort this payload names, as `(id, member, expected count)`.
    ///
    /// PENDING and SEALED answer the same way on purpose. Membership is what
    /// the PRODUCER declared; the digests are what the module computed from it.
    /// Export recomputes every cohort from this, so a re-export after adding a
    /// member re-seals the members already sealed rather than leaving them
    /// bound to the cohort digest of a group that no longer exists.
    pub fn cohort(&self) -> Option<(&[u8], &[u8], u32)> {
        match self {
            SealState::None => None,
            SealState::Pending { id, member, expected_count } => {
                Some((id, member, *expected_count))
            }
            SealState::Sealed(seal) => Some((&seal.id, &seal.member, seal.expected_count)),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArchivePayload {
    /// Opaque to everything but the fetcher: URL, transport, content digest.
    pub descriptor: Vec<u8>,
    pub seal: SealState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ArchiveSealRef<'a> {
    pub id: &'a [u8],
    pub member: &'a [u8],
    pub expected_count: u32,
    pub cohort_digest: [u8; 32],
    pub descriptor_digest: [u8; 32],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SealStateRef<'a> {
    None,
    Pending { id: &'a [u8], member: &'a [u8], expected_count: u32 },
    Sealed(ArchiveSealRef<'a>),
}

impl<'a> SealStateRef<'a> {
    pub fn cohort(&self) -> Option<(&'a [u8], &'a [u8], u32)> {
        match self {
            Self::None => None,
            Self::Pending { id, member, expected_count } => Some((id, member, *expected_count)),
            Self::Sealed(seal) => Some((seal.id, seal.member, seal.expected_count)),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ArchivePayloadRef<'a> {
    pub descriptor: &'a [u8],
    pub seal: SealStateRef<'a>,
}

pub fn encode_ref(payload: &ArchivePayloadRef<'_>) -> Result<IoBuffer<u8>, Errno> {
    u32::try_from(payload.descriptor.len()).map_err(|_| Errno::EINVAL)?;
    let mut length = 9usize.checked_add(payload.descriptor.len()).ok_or(Errno::ENOMEM)?;
    if let Some((id, member, _)) = payload.seal.cohort() {
        u32::try_from(id.len()).map_err(|_| Errno::EINVAL)?;
        u32::try_from(member.len()).map_err(|_| Errno::EINVAL)?;
        length = length.checked_add(12).and_then(|length| length.checked_add(id.len()))
            .and_then(|length| length.checked_add(member.len())).ok_or(Errno::ENOMEM)?;
        if matches!(payload.seal, SealStateRef::Sealed(_)) {
            length = length.checked_add(64).ok_or(Errno::ENOMEM)?;
        }
    }
    let mut output = IoBuffer::try_with_capacity(length)?;
    output.extend_from_slice(&PAYLOAD_VERSION.to_le_bytes());
    output.extend_from_slice(&(payload.descriptor.len() as u32).to_le_bytes());
    output.extend_from_slice(payload.descriptor);
    output.push(match payload.seal {
        SealStateRef::None => 0,
        SealStateRef::Sealed(_) => 1,
        SealStateRef::Pending { .. } => 2,
    });
    if let Some((id, member, expected_count)) = payload.seal.cohort() {
        output.extend_from_slice(&(id.len() as u32).to_le_bytes());
        output.extend_from_slice(id);
        output.extend_from_slice(&(member.len() as u32).to_le_bytes());
        output.extend_from_slice(member);
        output.extend_from_slice(&expected_count.to_le_bytes());
        if let SealStateRef::Sealed(seal) = payload.seal {
            output.extend_from_slice(&seal.cohort_digest);
            output.extend_from_slice(&seal.descriptor_digest);
        }
    }
    Ok(output)
}

fn put_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_bytes(out: &mut Vec<u8>, bytes: &[u8]) -> Result<(), Errno> {
    let len = u32::try_from(bytes.len()).map_err(|_| Errno::EINVAL)?;
    put_u32(out, len);
    out.extend_from_slice(bytes);
    Ok(())
}

/// Write an archive payload.
///
/// NOT YET CALLED IN PRODUCTION, and the warning saying so is accurate: nothing
/// SEALS yet. [`verify_cohorts`] runs on every load, so the enforcement point
/// exists and is tested — but no producer emits a seal, so today it
/// authenticates images that carry none, which it correctly accepts.
///
/// That is the honest state and not a soft landing: the capability is inert
/// until a producer seals. The intended producer is the image export itself
/// (sealing at EXPORT, so no builder can forget to), and wiring that is what
/// removes this `allow`.
#[allow(dead_code)]
pub fn encode(payload: &ArchivePayload) -> Result<Vec<u8>, Errno> {
    let mut out = Vec::new();
    put_u32(&mut out, PAYLOAD_VERSION);
    put_bytes(&mut out, &payload.descriptor)?;
    match &payload.seal {
        SealState::None => out.push(0),
        SealState::Sealed(seal) => {
            out.push(1);
            put_bytes(&mut out, &seal.id)?;
            put_bytes(&mut out, &seal.member)?;
            put_u32(&mut out, seal.expected_count);
            out.extend_from_slice(&seal.cohort_digest);
            out.extend_from_slice(&seal.descriptor_digest);
        }
        SealState::Pending { id, member, expected_count } => {
            out.push(2);
            put_bytes(&mut out, id)?;
            put_bytes(&mut out, member)?;
            put_u32(&mut out, *expected_count);
        }
    }
    Ok(out)
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn u32(&mut self) -> Result<u32, Errno> {
        let end = self.at.checked_add(4).ok_or(Errno::EINVAL)?;
        let slice = self.bytes.get(self.at..end).ok_or(Errno::EINVAL)?;
        self.at = end;
        let mut word = [0u8; 4];
        word.copy_from_slice(slice);
        Ok(u32::from_le_bytes(word))
    }

    fn bytes_ref(&mut self) -> Result<&'a [u8], Errno> {
        let len = self.u32()? as usize;
        let end = self.at.checked_add(len).ok_or(Errno::EINVAL)?;
        let slice = self.bytes.get(self.at..end).ok_or(Errno::EINVAL)?;
        self.at = end;
        Ok(slice)
    }

    fn bytes(&mut self) -> Result<Vec<u8>, Errno> {
        Ok(self.bytes_ref()?.to_vec())
    }

    fn digest(&mut self) -> Result<[u8; 32], Errno> {
        let end = self.at.checked_add(32).ok_or(Errno::EINVAL)?;
        let slice = self.bytes.get(self.at..end).ok_or(Errno::EINVAL)?;
        self.at = end;
        let mut out = [0u8; 32];
        out.copy_from_slice(slice);
        Ok(out)
    }

    fn byte(&mut self) -> Result<u8, Errno> {
        let value = *self.bytes.get(self.at).ok_or(Errno::EINVAL)?;
        self.at += 1;
        Ok(value)
    }
}

pub fn decode_ref(bytes: &[u8]) -> Result<ArchivePayloadRef<'_>, Errno> {
    if bytes.is_empty() {
        return Ok(ArchivePayloadRef { descriptor: &[], seal: SealStateRef::None });
    }
    let mut reader = Reader { bytes, at: 0 };
    if reader.u32()? != PAYLOAD_VERSION { return Err(Errno::EINVAL); }
    let descriptor = reader.bytes_ref()?;
    let seal = match reader.byte()? {
        0 => SealStateRef::None,
        1 => SealStateRef::Sealed(ArchiveSealRef {
            id: reader.bytes_ref()?,
            member: reader.bytes_ref()?,
            expected_count: reader.u32()?,
            cohort_digest: reader.digest()?,
            descriptor_digest: reader.digest()?,
        }),
        2 => SealStateRef::Pending {
            id: reader.bytes_ref()?,
            member: reader.bytes_ref()?,
            expected_count: reader.u32()?,
        },
        _ => return Err(Errno::EINVAL),
    };
    if reader.at != bytes.len() { return Err(Errno::EINVAL); }
    Ok(ArchivePayloadRef { descriptor, seal })
}

/// Decode an archive payload.
///
/// An EMPTY payload is not an error: an archive with no fetch description is a
/// representable state, and one described by `KLZY` always has exactly that,
/// because `KLZY` carries no descriptor field at all.
pub fn decode(bytes: &[u8]) -> Result<ArchivePayload, Errno> {
    // AN EMPTY PAYLOAD IS THE ABSENCE OF A DESCRIPTION, not a malformed one,
    // and this early return is the whole of that rule.
    //
    // It matters more since `rootfs::load_image` began authenticating cohorts:
    // `KLZY` has no payload field at all, so an image described that way
    // reaches the verifier with an empty vector for every archive, and a
    // loader that refused it would refuse every pre-`SDEF` image for not
    // saying something its carrier cannot say. A second emptiness check in
    // `verify_cohorts` was written and then deleted — it could not fail,
    // because this decided first.
    //
    // It does not weaken the check. Blanking a member's payload does not hide
    // it from a cohort: the members that remain still declare the count, and a
    // cohort short of its count is refused. What blanking buys is one fewer
    // member, which is the thing atomic activation exists to catch.
    if bytes.is_empty() {
        return Ok(ArchivePayload { descriptor: Vec::new(), seal: SealState::None });
    }
    let mut r = Reader { bytes, at: 0 };
    if r.u32()? != PAYLOAD_VERSION {
        return Err(Errno::EINVAL);
    }
    let descriptor = r.bytes()?;
    let seal = match r.byte()? {
        0 => SealState::None,
        1 => SealState::Sealed(ArchiveSeal {
            id: r.bytes()?,
            member: r.bytes()?,
            expected_count: r.u32()?,
            cohort_digest: r.digest()?,
            descriptor_digest: r.digest()?,
        }),
        2 => SealState::Pending {
            id: r.bytes()?,
            member: r.bytes()?,
            expected_count: r.u32()?,
        },
        // A state this reader does not know. Refused rather than guessed,
        // because a reader that cannot tell whether a seal was OWED cannot
        // safely treat the archive as unsealed.
        _ => return Err(Errno::EINVAL),
    };
    // Trailing bytes mean this is not the record it claims to be. Ignoring them
    // would let one payload decode two ways depending on who read it.
    if r.at != bytes.len() {
        return Err(Errno::EINVAL);
    }
    Ok(ArchivePayload { descriptor, seal })
}

/// The bytes a cohort's digest is taken over.
///
/// Sorted by member name so the same cohort produces the same identity whatever
/// order its archives were declared in, and length-prefixed throughout so no
/// two different member lists can produce the same bytes by running their
/// fields together.
pub fn cohort_identity(id: &[u8], members: &mut Vec<(Vec<u8>, [u8; 32])>) -> Result<Vec<u8>, Errno> {
    members.sort_by(|left, right| left.0.cmp(&right.0));
    let mut out = Vec::new();
    out.extend_from_slice(COHORT_TAG);
    put_bytes(&mut out, id)?;
    put_u32(&mut out, u32::try_from(members.len()).map_err(|_| Errno::EINVAL)?);
    for (member, digest) in members.iter() {
        put_bytes(&mut out, member)?;
        out.extend_from_slice(digest);
    }
    Ok(out)
}

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let mut out = [0u8; 32];
    out.copy_from_slice(&hasher.finalize());
    out
}

/// Complete every declared activation cohort, turning declarations into seals.
///
/// Takes the archives as `(archive_id, payload bytes)` and returns the payloads
/// that must replace them. Archives naming no cohort are absent from the
/// result: this rewrites what it seals and nothing else.
///
/// # Why this recomputes rather than sealing what is pending
///
/// Sealing only `Pending` payloads looks equivalent and is not. A second export
/// after adding a member would leave the members sealed by the first export
/// bound to the OLD cohort digest, and the image would fail its own verifier
/// with no visible cause. Recomputing every cohort from the membership both
/// states carry has no such state, and makes exporting twice mean what
/// exporting once means.
///
/// # Errno
///
/// `EINVAL` throughout, and deliberately not `EPERM`. Every failure here is the
/// PRODUCER contradicting itself while building an image that does not exist
/// yet — a cohort short of the count it declared, two members disagreeing about
/// that count, one member name standing for two archives. None of them is a
/// question about authenticity, which is what `EPERM` is reserved for.
pub fn seal_cohorts<Bytes: AsRef<[u8]>>(archives: &[(u32, Bytes)]) -> Result<IoBuffer<(u32, IoBuffer<u8>)>, Errno> {
    let mut cohorts = collect_cohorts(archives, false)?;
    let count = cohorts.iter().try_fold(0usize, |count, cohort| {
        count.checked_add(cohort.members.len()).ok_or(Errno::ENOMEM)
    })?;
    let mut output = IoBuffer::try_with_capacity(count)?;
    for cohort in &mut cohorts {
        let cohort_digest = cohort.digest()?;
        for member in &cohort.members {
            output.push((member.archive_id, encode_ref(&ArchivePayloadRef {
                descriptor: member.descriptor,
                seal: SealStateRef::Sealed(ArchiveSealRef {
                    id: cohort.id,
                    member: member.name,
                    expected_count: cohort.expected_count,
                    cohort_digest,
                    descriptor_digest: member.descriptor_digest,
                }),
            })?));
        }
    }
    Ok(output)
}

struct CohortMember<'a> {
    archive_id: u32,
    ordinal: usize,
    name: &'a [u8],
    descriptor: &'a [u8],
    descriptor_digest: [u8; 32],
}

struct Cohort<'a> {
    id: &'a [u8],
    expected_count: u32,
    declared_digest: Option<[u8; 32]>,
    members: IoBuffer<CohortMember<'a>>,
}

impl Cohort<'_> {
    fn digest(&mut self) -> Result<[u8; 32], Errno> {
        self.members.sort_unstable_by(|left, right| left.name.cmp(right.name));
        let mut hasher = Sha256::new();
        hasher.update(COHORT_TAG);
        hasher.update(u32::try_from(self.id.len()).map_err(|_| Errno::EINVAL)?.to_le_bytes());
        hasher.update(self.id);
        hasher.update(u32::try_from(self.members.len()).map_err(|_| Errno::EINVAL)?.to_le_bytes());
        for member in &self.members {
            hasher.update(u32::try_from(member.name.len()).map_err(|_| Errno::EINVAL)?.to_le_bytes());
            hasher.update(member.name);
            hasher.update(member.descriptor_digest);
        }
        self.members.sort_unstable_by_key(|member| member.ordinal);
        Ok(hasher.finalize().into())
    }
}

fn collect_cohorts<Bytes: AsRef<[u8]>>(archives: &[(u32, Bytes)], verify: bool) -> Result<IoBuffer<Cohort<'_>>, Errno> {
    let refusal = if verify { Errno::EPERM } else { Errno::EINVAL };
    let mut cohorts: IoBuffer<Cohort<'_>> = IoBuffer::new();
    for (ordinal, (archive_id, bytes)) in archives.iter().enumerate() {
        let payload = decode_ref(bytes.as_ref())?;
        let Some((id, name, expected_count)) = payload.seal.cohort() else { continue; };
        let descriptor_digest = sha256(payload.descriptor);
        let declared_digest = if verify {
            let SealStateRef::Sealed(seal) = payload.seal else { return Err(refusal); };
            if descriptor_digest != seal.descriptor_digest { return Err(refusal); }
            Some(seal.cohort_digest)
        } else {
            None
        };
        let member = CohortMember { archive_id: *archive_id, ordinal, name, descriptor: payload.descriptor, descriptor_digest };
        if let Some(cohort) = cohorts.iter_mut().find(|cohort| cohort.id == id) {
            if cohort.expected_count != expected_count || cohort.declared_digest != declared_digest
                || cohort.members.iter().any(|member| member.name == name)
            {
                return Err(refusal);
            }
            cohort.members.try_push(member)?;
        } else {
            let mut members = IoBuffer::new();
            members.try_push(member)?;
            cohorts.try_push(Cohort { id, expected_count, declared_digest, members })?;
        }
    }
    for cohort in &cohorts {
        if u32::try_from(cohort.members.len()).map_err(|_| Errno::EINVAL)? != cohort.expected_count {
            return Err(refusal);
        }
    }
    Ok(cohorts)
}

/// Authenticate every sealed activation cohort among a loaded image's archives.
///
/// Each entry is `(archive_id, payload bytes)` exactly as the image declared
/// them. Archives with no seal are ignored: whether a seal is REQUIRED is a
/// policy question this module does not answer, and an unsealed archive is a
/// representable state the format deliberately allows.
///
/// # Errno, and why two of them
///
/// `EINVAL` means the payload is not a payload — malformed, truncated,
/// a version this reader does not know. `EPERM` means it parsed and did not
/// authenticate. Collapsing them would make "this image is corrupt" and "this
/// image has been tampered with" the same event, and only one of those is a
/// bug report.
pub fn verify_cohorts<Bytes: AsRef<[u8]>>(archives: &[(u32, Bytes)]) -> Result<(), Errno> {
    let mut cohorts = collect_cohorts(archives, true)?;
    for cohort in &mut cohorts {
        if Some(cohort.digest()?) != cohort.declared_digest { return Err(Errno::EPERM); }
    }
    Ok(())
}

#[cfg(test)]
fn verify_cohorts_owned<Bytes: AsRef<[u8]>>(archives: &[(u32, Bytes)]) -> Result<(), Errno> {
    // (id, expected_count, cohort_digest, members)
    let mut cohorts: Vec<(Vec<u8>, u32, [u8; 32], Vec<(Vec<u8>, [u8; 32])>)> = Vec::new();

    for (_archive_id, bytes) in archives {
        // Decoded ONCE. Decoding twice would let a payload that parsed
        // differently on the second read pass a check made against the first.
        let payload = decode(bytes.as_ref())?;
        let descriptor = payload.descriptor;
        let seal = match payload.seal {
            SealState::None => continue,
            // A seal that was WANTED and never written. Treating this as
            // unsealed would let a producer's failure reach a consumer wearing
            // the shape of an archive that was never in a cohort.
            SealState::Pending { .. } => return Err(Errno::EPERM),
            SealState::Sealed(seal) => seal,
        };

        // 1. The descriptor is the one that was sealed.
        if sha256(&descriptor) != seal.descriptor_digest {
            return Err(Errno::EPERM);
        }

        match cohorts.iter_mut().find(|(id, ..)| *id == seal.id) {
            None => cohorts.push((
                seal.id.clone(),
                seal.expected_count,
                seal.cohort_digest,
                alloc::vec![(seal.member.clone(), seal.descriptor_digest)],
            )),
            Some((_, expected, digest, members)) => {
                // Members of one cohort must agree about the cohort. A member
                // claiming a different count or a different cohort digest is
                // either a splice of two groups or a tampered one, and both are
                // refusals rather than a choice of which to believe.
                if *expected != seal.expected_count || *digest != seal.cohort_digest {
                    return Err(Errno::EPERM);
                }
                if members.iter().any(|(name, _)| *name == seal.member) {
                    return Err(Errno::EPERM); // one name, two archives
                }
                members.push((seal.member.clone(), seal.descriptor_digest));
            }
        }
    }

    for (id, expected, declared, members) in cohorts.iter_mut() {
        // 2. Every member is present. A cohort short of its count would
        //    activate partially, which is what atomic activation forbids.
        if u32::try_from(members.len()).map_err(|_| Errno::EINVAL)? != *expected {
            return Err(Errno::EPERM);
        }
        // 3. The cohort is the one that was sealed.
        if sha256(&cohort_identity(id, members)?) != *declared {
            return Err(Errno::EPERM);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn borrowed_payload_encoding_matches_owned_bytes_and_rejects_the_same_truncations() {
        for payload in [
            ArchivePayload { descriptor: b"descriptor".to_vec(), seal: SealState::None },
            ArchivePayload {
                descriptor: b"pending descriptor".to_vec(),
                seal: SealState::Pending { id: b"group".to_vec(), member: b"member".to_vec(), expected_count: 2 },
            },
            sealed(b"group", b"member", 1, b"sealed descriptor"),
        ] {
            let expected = encode(&payload).unwrap();
            let borrowed = decode_ref(&expected).unwrap();
            assert_eq!(encode_ref(&borrowed).unwrap(), expected);
            for end in 1..expected.len() {
                assert_eq!(decode_ref(&expected[..end]), Err(Errno::EINVAL));
            }
            let mut trailing = expected.clone();
            trailing.push(0);
            assert_eq!(decode_ref(&trailing), Err(Errno::EINVAL));
        }
    }

    #[test]
    fn cohort_verification_borrows_large_fields_under_a_small_scratch_budget() {
        let name = alloc::vec![b'n'; 128 * 1024];
        let descriptor = alloc::vec![b'd'; 256 * 1024];
        let archives = seal_cohort(&name, &[(&name, &descriptor)], 1);
        assert_eq!(verify_cohorts_owned(&archives), Ok(()));
        let before = crate::io_buffer::IO_MEMORY.usage().0;
        let _budget = crate::io_buffer::test_budget(before + 4096);
        assert_eq!(verify_cohorts(&archives), Ok(()));
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, before);
        assert_eq!(seal_cohorts(&archives), Err(Errno::ENOMEM));
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, before);
    }

    #[test]
    fn cohort_sealing_preserves_canonical_bytes_and_admission_through_iteration() {
        let first = seal_cohort(b"first", &[(b"z", b"desc-z"), (b"a", b"desc-a")], 2);
        let second = seal_cohort(b"second", &[(b"m", b"desc-m")], 1);
        let archives = alloc::vec![first[0].clone(), (3, second[0].1.clone()), first[1].clone()];
        let before = crate::io_buffer::IO_MEMORY.usage().0;
        let sealed = seal_cohorts(&archives).unwrap();
        assert_eq!(sealed[0].0, archives[0].0);
        assert_eq!(sealed[1].0, archives[2].0);
        assert_eq!(sealed[2].0, archives[1].0);
        assert_eq!(sealed[0].1, archives[0].1);
        assert_eq!(sealed[1].1, archives[2].1);
        assert_eq!(sealed[2].1, archives[1].1);
        let mut iterator = sealed.into_iter();
        let (_, payload) = iterator.next().unwrap();
        drop(iterator);
        assert!(crate::io_buffer::IO_MEMORY.usage().0 >= before + payload.len() * 2);
        drop(payload);
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, before);
        for limit in [0, 512, 1024, 1536, 2048, 4096, 8192] {
            let _budget = crate::io_buffer::test_budget(before + limit);
            let result = seal_cohorts(&archives);
            match result {
                Ok(payloads) => {
                    assert_eq!(payloads[0].1, archives[0].1);
                    assert_eq!(payloads[1].1, archives[2].1);
                    assert_eq!(payloads[2].1, archives[1].1);
                    drop(payloads);
                }
                Err(error) => assert_eq!(error, Errno::ENOMEM),
            }
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, before);
        }
        assert_eq!(verify_cohorts(&archives), Ok(()));
    }

    #[test]
    fn cohort_verification_refusal_releases_scratch_without_changing_inputs() {
        let mut archives = seal_cohort(b"group", &[(b"z", b"z"), (b"a", b"a")], 2);
        let expected = archives.clone();
        let before = crate::io_buffer::IO_MEMORY.usage().0;
        {
            let _budget = crate::io_buffer::test_budget(before);
            assert_eq!(verify_cohorts(&archives), Err(Errno::ENOMEM));
            assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, before);
        }
        assert_eq!(archives, expected);
        assert_eq!(verify_cohorts(&archives), Ok(()));
        let mut payload = decode(&archives[1].1).unwrap();
        sealed_mut(&mut payload).member = b"z".to_vec();
        archives[1].1 = encode(&payload).unwrap();
        assert_eq!(verify_cohorts(&archives), verify_cohorts_owned(&archives));
        assert_eq!(crate::io_buffer::IO_MEMORY.usage().0, before);
    }

    /// Reach the seal of a payload the test itself just sealed. Panicking on
    /// any other state is the point: a test that meant to perturb a seal and
    /// found none has already stopped testing what it says it tests.
    fn sealed_mut(payload: &mut ArchivePayload) -> &mut ArchiveSeal {
        match &mut payload.seal {
            SealState::Sealed(seal) => seal,
            other => panic!("expected a sealed payload, found {other:?}"),
        }
    }

    fn sealed(id: &[u8], member: &[u8], count: u32, descriptor: &[u8]) -> ArchivePayload {
        ArchivePayload {
            descriptor: descriptor.to_vec(),
            seal: SealState::Sealed(ArchiveSeal {
                id: id.to_vec(),
                member: member.to_vec(),
                expected_count: count,
                cohort_digest: [0u8; 32],
                descriptor_digest: sha256(descriptor),
            }),
        }
    }

    /// Seal a whole cohort the way a producer must: each descriptor digested,
    /// then the cohort identity digested over all of them.
    fn seal_cohort(id: &[u8], members: &[(&[u8], &[u8])], count: u32) -> Vec<(u32, Vec<u8>)> {
        let mut identity: Vec<(Vec<u8>, [u8; 32])> = members
            .iter()
            .map(|(name, descriptor)| (name.to_vec(), sha256(descriptor)))
            .collect();
        let digest = sha256(&cohort_identity(id, &mut identity).expect("identity"));
        members
            .iter()
            .enumerate()
            .map(|(i, (name, descriptor))| {
                let mut payload = sealed(id, name, count, descriptor);
                sealed_mut(&mut payload).cohort_digest = digest;
                (i as u32 + 1, encode(&payload).expect("encode"))
            })
            .collect()
    }

    #[test]
    fn a_payload_round_trips_with_and_without_a_seal() {
        for payload in [
            ArchivePayload { descriptor: b"{\"url\":\"https://x/y.zip\"}".to_vec(), seal: SealState::None },
            sealed(b"group-1", b"tools", 2, b"{\"url\":\"https://x/y.zip\"}"),
            // Empty everything is still a payload: an archive may carry no
            // description, which is what a KLZY-described image always yields.
            ArchivePayload { descriptor: Vec::new(), seal: SealState::None },
        ] {
            let bytes = encode(&payload).expect("encode");
            assert_eq!(decode(&bytes).expect("decode"), payload);
        }
    }

    #[test]
    fn an_absent_payload_is_not_an_error() {
        // `KLZY` carries no descriptor field, so every archive from such an
        // image arrives here empty. That is a state, not a fault.
        assert_eq!(
            decode(&[]).expect("decode"),
            ArchivePayload { descriptor: Vec::new(), seal: SealState::None },
        );
    }

    #[test]
    fn a_payload_that_is_not_one_is_refused_rather_than_guessed() {
        let good = encode(&sealed(b"g", b"m", 1, b"desc")).expect("encode");

        // Truncated at every length: a short read must never produce a seal.
        for cut in 1..good.len() {
            assert_eq!(decode(&good[..cut]), Err(Errno::EINVAL), "truncated to {cut}");
        }
        // Trailing bytes. Ignoring them would let one payload decode two ways
        // depending on who read it.
        let mut trailing = good.clone();
        trailing.push(0);
        assert_eq!(decode(&trailing), Err(Errno::EINVAL));
        // A version this reader does not know. Guessing is how a seal comes to
        // pass for the wrong bytes.
        let mut future = good.clone();
        future[0] = 99;
        assert_eq!(decode(&future), Err(Errno::EINVAL));
    }

    #[test]
    fn a_correctly_sealed_cohort_authenticates() {
        let archives = seal_cohort(b"shell", &[(b"tools", b"d1"), (b"docs", b"d2")], 2);
        assert_eq!(verify_cohorts(&archives), Ok(()));
    }

    #[test]
    fn the_cohort_identity_does_not_depend_on_declaration_order() {
        // Two producers listing the same archives in different orders must
        // arrive at the same cohort. Otherwise the digest would authenticate a
        // list rather than a set, and a reordered image would read as tampered.
        let forward = seal_cohort(b"shell", &[(b"tools", b"d1"), (b"docs", b"d2")], 2);
        let mut reversed = seal_cohort(b"shell", &[(b"docs", b"d2"), (b"tools", b"d1")], 2);
        reversed.reverse();
        let digest_of = |archives: &[(u32, Vec<u8>)]| {
            match decode(&archives[0].1).expect("decode").seal {
                SealState::Sealed(seal) => seal.cohort_digest,
                other => panic!("expected a sealed payload, found {other:?}"),
            }
        };
        assert_eq!(digest_of(&forward), digest_of(&reversed));
    }

    #[test]
    fn a_changed_descriptor_does_not_authenticate() {
        // "changed after sealing": the bytes that say where an archive comes
        // from are exactly what the seal covers.
        let mut archives = seal_cohort(b"shell", &[(b"tools", b"d1")], 1);
        let mut payload = decode(&archives[0].1).expect("decode");
        payload.descriptor = b"https://elsewhere.invalid/evil.zip".to_vec();
        archives[0].1 = encode(&payload).expect("encode");
        assert_eq!(verify_cohorts(&archives), Err(Errno::EPERM));
    }

    #[test]
    fn a_cohort_short_of_its_count_does_not_authenticate() {
        // The whole point of atomic activation: a group that would come up
        // partially must not come up at all.
        let archives = seal_cohort(b"shell", &[(b"tools", b"d1"), (b"docs", b"d2")], 2);
        assert_eq!(verify_cohorts(&archives[..1]), Err(Errno::EPERM));
    }

    #[test]
    fn members_that_disagree_about_their_cohort_do_not_authenticate() {
        // A splice of two groups, or a tampered one. Either way there is no
        // version of "which member is right" worth guessing at.
        let mut archives = seal_cohort(b"shell", &[(b"tools", b"d1"), (b"docs", b"d2")], 2);
        let mut payload = decode(&archives[1].1).expect("decode");
        sealed_mut(&mut payload).expected_count = 3;
        archives[1].1 = encode(&payload).expect("encode");
        assert_eq!(verify_cohorts(&archives), Err(Errno::EPERM));
    }

    #[test]
    fn one_member_name_cannot_stand_for_two_archives() {
        // Otherwise a cohort of two could be satisfied by the same archive
        // twice, and the absent one would never be missed.
        let mut archives = seal_cohort(b"shell", &[(b"tools", b"d1"), (b"docs", b"d2")], 2);
        let mut payload = decode(&archives[1].1).expect("decode");
        sealed_mut(&mut payload).member = b"tools".to_vec();
        archives[1].1 = encode(&payload).expect("encode");
        assert_eq!(verify_cohorts(&archives), Err(Errno::EPERM));
    }

    #[test]
    fn a_cohort_RE_sealed_over_fewer_members_does_not_authenticate() {
        // Why the count check is not redundant with the identity check.
        //
        // Dropping a member alone is caught by the identity, because the digest
        // covers the member list. But an attacker who drops a member and then
        // RE-SEALS the remainder produces a cohort whose identity is perfectly
        // consistent — every descriptor digest matches, every member agrees.
        // The only thing left saying a member is missing is the count the
        // original seal declared.
        let mut archives = seal_cohort(b"shell", &[(b"tools", b"d1")], 1);
        let mut payload = decode(&archives[0].1).expect("decode");
        // Re-sealed as a cohort of one, but still CLAIMING two.
        sealed_mut(&mut payload).expected_count = 2;
        archives[0].1 = encode(&payload).expect("encode");
        assert_eq!(verify_cohorts(&archives), Err(Errno::EPERM));
    }

    #[test]
    fn a_cohort_whose_members_are_each_intact_still_needs_its_own_digest() {
        // Why the identity check is not redundant with the per-descriptor one.
        // Every descriptor here digests correctly and every member agrees about
        // the cohort, so checks one and two pass. What is wrong is the cohort
        // itself: these two archives were never sealed together.
        let mut archives = seal_cohort(b"shell", &[(b"tools", b"d1"), (b"docs", b"d2")], 2);
        for (_, bytes) in archives.iter_mut() {
            let mut payload = decode(bytes).expect("decode");
            sealed_mut(&mut payload).cohort_digest = [7u8; 32];
            *bytes = encode(&payload).expect("encode");
        }
        assert_eq!(verify_cohorts(&archives), Err(Errno::EPERM));
    }

    #[test]
    fn one_archive_RE_sealed_twice_cannot_satisfy_a_cohort_of_two() {
        // Why the duplicate-name check is not redundant either. Listing one
        // archive twice under the same name and recomputing the identity over
        // that list gives a cohort that is internally consistent and satisfies
        // its own count — while the second archive simply does not exist.
        let descriptor: &[u8] = b"d1";
        let mut identity = alloc::vec![
            (b"tools".to_vec(), sha256(descriptor)),
            (b"tools".to_vec(), sha256(descriptor)),
        ];
        let digest = sha256(&cohort_identity(b"shell", &mut identity).expect("identity"));
        let archives: Vec<(u32, Vec<u8>)> = (0..2)
            .map(|i| {
                let mut payload = sealed(b"shell", b"tools", 2, descriptor);
                sealed_mut(&mut payload).cohort_digest = digest;
                (i + 1, encode(&payload).expect("encode"))
            })
            .collect();
        assert_eq!(verify_cohorts(&archives), Err(Errno::EPERM));
    }

    #[test]
    fn two_different_member_lists_cannot_share_an_identity() {
        // Why every field in the identity is length-prefixed. Without prefixes
        // the member names and digests run together, and these two DIFFERENT
        // cohorts serialise to the same bytes:
        //
        //   "a"  + X + "bc" + Y      (member "a" then member "bc")
        //   "ab" + P + "c"  + Y      (member "ab" then member "c")
        //
        // with X = b'b',1..31 and P = 1..31,b'b'. Both are two members with the
        // same id, so the count does not separate them either. A digest over
        // concatenated fields stops distinguishing exactly here.
        let mut x = [0u8; 32];
        x[0] = b'b';
        for (i, slot) in x.iter_mut().enumerate().skip(1) {
            *slot = i as u8;
        }
        let mut p = [0u8; 32];
        for (i, slot) in p.iter_mut().enumerate().take(31) {
            *slot = (i + 1) as u8;
        }
        p[31] = b'b';
        let y = [200u8; 32];

        let mut left = alloc::vec![(b"a".to_vec(), x), (b"bc".to_vec(), y)];
        let mut right = alloc::vec![(b"ab".to_vec(), p), (b"c".to_vec(), y)];
        assert_ne!(
            cohort_identity(b"g", &mut left).expect("left"),
            cohort_identity(b"g", &mut right).expect("right"),
            "length prefixes are what keep these two cohorts distinct",
        );
    }

    #[test]
    fn the_cohort_identity_is_domain_separated() {
        // A digest computed for one purpose must never be valid for another.
        // The tag is what makes these bytes unmistakably a cohort identity and
        // not, say, a descriptor that happened to start the same way.
        let mut members = alloc::vec![(b"tools".to_vec(), [1u8; 32])];
        let identity = cohort_identity(b"shell", &mut members).expect("identity");
        assert!(
            identity.starts_with(COHORT_TAG),
            "the identity names what it is before it says anything else",
        );
    }

    #[test]
    fn a_pending_declaration_survives_the_round_trip_as_pending() {
        // The producer writes PENDING and the module completes it at export,
        // so the state has to cross the encoding between those two moments. If
        // it decoded as anything else, the export that was supposed to finish
        // the seal would have nothing left to finish.
        let declared = ArchivePayload {
            descriptor: b"{\"url\":\"https://x/tools.zip\"}".to_vec(),
            seal: SealState::Pending {
                id: b"shell".to_vec(),
                member: b"tools".to_vec(),
                expected_count: 1,
            },
        };
        let bytes = encode(&declared).expect("encode");
        assert_eq!(decode(&bytes).expect("decode"), declared);
    }

    #[test]
    fn a_seal_that_was_wanted_and_never_written_is_refused() {
        // The whole reason PENDING is a state. An image reaching a consumer
        // with a pending payload is one the producer FAILED to seal, and it
        // must not be accepted -- least of all accepted the way an archive
        // that was never meant to be in a cohort is accepted.
        let pending = encode(&ArchivePayload {
            descriptor: b"{\"url\":\"https://x/tools.zip\"}".to_vec(),
            seal: SealState::Pending {
                id: b"shell".to_vec(),
                member: b"tools".to_vec(),
                expected_count: 1,
            },
        })
        .expect("encode");
        assert_eq!(verify_cohorts(&[(1, pending)]), Err(Errno::EPERM));
    }

    #[test]
    fn an_unsealed_archive_is_carried_rather_than_refused() {
        // Whether a seal is REQUIRED is policy, and not this module's to
        // decide. An image whose archives carry none is a real state — every
        // KLZY-described image is one — and refusing it here would make a
        // format capability into a requirement by accident.
        let unsealed = encode(&ArchivePayload {
            descriptor: b"{\"url\":\"https://x/y.zip\"}".to_vec(),
            seal: SealState::None,
        })
        .expect("encode");
        let mut archives = seal_cohort(b"shell", &[(b"tools", b"d1")], 1);
        archives.push((9, unsealed));
        assert_eq!(verify_cohorts(&archives), Ok(()));
    }
}

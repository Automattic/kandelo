//! The archive payload's two halves: a descriptor the kernel carries, and a
//! seal a consumer verifies.
//!
//! # Why this is here and not in `sffs_deferred`
//!
//! `sffs_deferred` is the FORMAT, and its contract is that the payload is
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
//! That is not a regression — the incumbent's `cohortSha256` has exactly the
//! same property — but it is the difference between "this image was not
//! tampered with in part" and "this image came from someone trusted", and only
//! the first is on offer here. Whoever decides an image may be loaded at all is
//! still deciding the second, and this does not relieve them of it.
//!
//! # Why a byte layout and not JSON
//!
//! The incumbent's cohort identity is `JSON.stringify({schema:1,id,members:[…]})`.
//! A Rust verifier of images sealed that way would have to reproduce
//! JavaScript's serialiser exactly — key order, escaping, non-ASCII — over
//! member names that are archive paths. Writing the canonical form as a LAYOUT
//! removes that at the root: the canonical form IS the format, which is the
//! only place a canonical form is safe to live.

use alloc::vec::Vec;
use wasm_posix_shared::Errno;
use sha2::{Digest, Sha256};

/// Layout version. A reader that does not know a version refuses rather than
/// guessing, because a misread seal is a seal that passes for the wrong bytes.
const PAYLOAD_VERSION: u32 = 1;

/// Cohort-identity domain tag. Prefixing the digest input means a digest
/// computed for one purpose can never be mistaken for one computed for another.
const COHORT_TAG: &[u8] = b"kandelo.sffs.cohort.v1\0";

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArchivePayload {
    /// Opaque to everything but the fetcher: URL, transport, content digest.
    pub descriptor: Vec<u8>,
    pub seal: Option<ArchiveSeal>,
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

pub fn encode(payload: &ArchivePayload) -> Result<Vec<u8>, Errno> {
    let mut out = Vec::new();
    put_u32(&mut out, PAYLOAD_VERSION);
    put_bytes(&mut out, &payload.descriptor)?;
    match &payload.seal {
        None => out.push(0),
        Some(seal) => {
            out.push(1);
            put_bytes(&mut out, &seal.id)?;
            put_bytes(&mut out, &seal.member)?;
            put_u32(&mut out, seal.expected_count);
            out.extend_from_slice(&seal.cohort_digest);
            out.extend_from_slice(&seal.descriptor_digest);
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

    fn bytes(&mut self) -> Result<Vec<u8>, Errno> {
        let len = self.u32()? as usize;
        let end = self.at.checked_add(len).ok_or(Errno::EINVAL)?;
        let slice = self.bytes.get(self.at..end).ok_or(Errno::EINVAL)?;
        self.at = end;
        Ok(slice.to_vec())
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

/// Decode an archive payload.
///
/// An EMPTY payload is not an error: an archive with no fetch description is a
/// representable state, and one described by `KLZY` always has exactly that,
/// because `KLZY` carries no descriptor field at all.
pub fn decode(bytes: &[u8]) -> Result<ArchivePayload, Errno> {
    if bytes.is_empty() {
        return Ok(ArchivePayload { descriptor: Vec::new(), seal: None });
    }
    let mut r = Reader { bytes, at: 0 };
    if r.u32()? != PAYLOAD_VERSION {
        return Err(Errno::EINVAL);
    }
    let descriptor = r.bytes()?;
    let seal = match r.byte()? {
        0 => None,
        1 => Some(ArchiveSeal {
            id: r.bytes()?,
            member: r.bytes()?,
            expected_count: r.u32()?,
            cohort_digest: r.digest()?,
            descriptor_digest: r.digest()?,
        }),
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
pub fn verify_cohorts(archives: &[(u32, Vec<u8>)]) -> Result<(), Errno> {
    // (id, expected_count, cohort_digest, members)
    let mut cohorts: Vec<(Vec<u8>, u32, [u8; 32], Vec<(Vec<u8>, [u8; 32])>)> = Vec::new();

    for (_archive_id, bytes) in archives {
        // Decoded ONCE. Decoding twice would let a payload that parsed
        // differently on the second read pass a check made against the first.
        let payload = decode(bytes)?;
        let Some(seal) = payload.seal else { continue };
        let descriptor = payload.descriptor;

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

    fn sealed(id: &[u8], member: &[u8], count: u32, descriptor: &[u8]) -> ArchivePayload {
        ArchivePayload {
            descriptor: descriptor.to_vec(),
            seal: Some(ArchiveSeal {
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
                payload.seal.as_mut().expect("seal").cohort_digest = digest;
                (i as u32 + 1, encode(&payload).expect("encode"))
            })
            .collect()
    }

    #[test]
    fn a_payload_round_trips_with_and_without_a_seal() {
        for payload in [
            ArchivePayload { descriptor: b"{\"url\":\"https://x/y.zip\"}".to_vec(), seal: None },
            sealed(b"group-1", b"tools", 2, b"{\"url\":\"https://x/y.zip\"}"),
            // Empty everything is still a payload: an archive may carry no
            // description, which is what a KLZY-described image always yields.
            ArchivePayload { descriptor: Vec::new(), seal: None },
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
            ArchivePayload { descriptor: Vec::new(), seal: None },
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
            decode(&archives[0].1).expect("decode").seal.expect("seal").cohort_digest
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
        payload.seal.as_mut().expect("seal").expected_count = 3;
        archives[1].1 = encode(&payload).expect("encode");
        assert_eq!(verify_cohorts(&archives), Err(Errno::EPERM));
    }

    #[test]
    fn one_member_name_cannot_stand_for_two_archives() {
        // Otherwise a cohort of two could be satisfied by the same archive
        // twice, and the absent one would never be missed.
        let mut archives = seal_cohort(b"shell", &[(b"tools", b"d1"), (b"docs", b"d2")], 2);
        let mut payload = decode(&archives[1].1).expect("decode");
        payload.seal.as_mut().expect("seal").member = b"tools".to_vec();
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
        payload.seal.as_mut().expect("seal").expected_count = 2;
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
            payload.seal.as_mut().expect("seal").cohort_digest = [7u8; 32];
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
                payload.seal.as_mut().expect("seal").cohort_digest = digest;
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
    fn an_unsealed_archive_is_carried_rather_than_refused() {
        // Whether a seal is REQUIRED is policy, and not this module's to
        // decide. An image whose archives carry none is a real state — every
        // KLZY-described image is one — and refusing it here would make a
        // format capability into a requirement by accident.
        let unsealed = encode(&ArchivePayload {
            descriptor: b"{\"url\":\"https://x/y.zip\"}".to_vec(),
            seal: None,
        })
        .expect("encode");
        let mut archives = seal_cohort(b"shell", &[(b"tools", b"d1")], 1);
        archives.push((9, unsealed));
        assert_eq!(verify_cohorts(&archives), Ok(()));
    }
}

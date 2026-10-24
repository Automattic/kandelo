use wasm_posix_shared::Errno;

use crate::overlay_activation::wire_integer;
use crate::persistent_overlay_index::CheckpointHeader;

const CONVERSION_BYTES: u64 = 32 * 1024 * 1024;
const EVIDENCE_BYTES: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SourceKind {
    None,
    SelfBound,
    Unsealed,
    Sealed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SourceVerdict {
    Eligible,
    Stale,
    Superseded,
    Unresolved,
    VerifyDigest,
}

struct SourceEvidence {
    kind: SourceKind,
    expected_length: u64,
    observed_length: u64,
    unverified_seal_length: u64,
    has_digest: bool,
    digest_matches: Option<bool>,
    verified_predecessor: bool,
    superseded_predecessor: bool,
    slot_reused: bool,
}

impl SourceEvidence {
    fn from_wire(bytes: &[u8]) -> Result<Self, Errno> {
        if bytes.len() != EVIDENCE_BYTES || bytes[4..8] != [0; 4] { return Err(Errno::EINVAL); }
        let flags = u32::from_le_bytes(bytes[..4].try_into().map_err(|_| Errno::EINVAL)?);
        if flags > 0xff { return Err(Errno::EINVAL); }
        let kind = match flags & 3 {
            0 => SourceKind::None,
            1 => SourceKind::SelfBound,
            2 => SourceKind::Unsealed,
            _ => SourceKind::Sealed,
        };
        let evidence = Self {
            kind,
            expected_length: wire_integer(bytes, 8)?,
            observed_length: wire_integer(bytes, 16)?,
            unverified_seal_length: wire_integer(bytes, 24)?,
            has_digest: flags & 4 != 0,
            digest_matches: if flags & 8 != 0 { Some(flags & 16 != 0) } else { None },
            verified_predecessor: flags & 32 != 0,
            superseded_predecessor: flags & 64 != 0,
            slot_reused: flags & 128 != 0,
        };
        if flags & 16 != 0 && flags & 8 == 0
            || evidence.digest_matches.is_some() && !evidence.has_digest
            || evidence.superseded_predecessor && !evidence.verified_predecessor
            || kind != SourceKind::Unsealed && (evidence.has_digest || evidence.digest_matches.is_some())
            || kind != SourceKind::Sealed && (evidence.verified_predecessor || evidence.superseded_predecessor
                || evidence.slot_reused || evidence.unverified_seal_length != 0)
            || matches!(kind, SourceKind::None | SourceKind::SelfBound)
                && (evidence.expected_length != 0 || evidence.observed_length != 0)
            || matches!(kind, SourceKind::Unsealed | SourceKind::Sealed) && evidence.expected_length == 0
        {
            return Err(Errno::EINVAL);
        }
        Ok(evidence)
    }

    fn classify(&self) -> SourceVerdict {
        match self.kind {
            SourceKind::None => SourceVerdict::Eligible,
            SourceKind::SelfBound => SourceVerdict::Superseded,
            SourceKind::Unsealed => {
                if self.observed_length == 0 {
                    return if self.has_digest { SourceVerdict::Eligible } else { SourceVerdict::Stale };
                }
                if self.observed_length != self.expected_length { return SourceVerdict::Superseded; }
                if !self.has_digest { return SourceVerdict::Eligible; }
                match self.digest_matches {
                    None => SourceVerdict::VerifyDigest,
                    Some(true) => SourceVerdict::Eligible,
                    Some(false) => SourceVerdict::Superseded,
                }
            },
            SourceKind::Sealed => {
                if self.verified_predecessor {
                    return if self.superseded_predecessor || self.observed_length != self.expected_length {
                        SourceVerdict::Superseded
                    } else { SourceVerdict::Eligible };
                }
                if !self.slot_reused && self.unverified_seal_length > 0
                    && self.observed_length > 0 && self.observed_length != self.expected_length
                { SourceVerdict::Unresolved } else { SourceVerdict::Eligible }
            },
        }
    }
}

pub(crate) fn codec(operation: u32, input: &[u8], output: &mut [u8]) -> Result<usize, Errno> {
    let value = match operation {
        13 if input == [0] => CheckpointHeader::BYTES as u32,
        14 => u32::from(CheckpointHeader::decode(input)?.requires_conversion()),
        15 if input.len() == 8 => u32::from(wire_integer(input, 0)? >= CONVERSION_BYTES),
        16 => match SourceEvidence::from_wire(input)?.classify() {
            SourceVerdict::Eligible => 0,
            SourceVerdict::Stale => 1,
            SourceVerdict::Superseded => 2,
            SourceVerdict::Unresolved => 3,
            SourceVerdict::VerifyDigest => 4,
        },
        _ => return Err(Errno::EINVAL),
    };
    if output.len() < 4 { return Err(Errno::EINVAL); }
    output[..4].copy_from_slice(&value.to_le_bytes());
    Ok(4)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn evidence(flags: u32, expected: f64, observed: f64, seal: f64) -> [u8; EVIDENCE_BYTES] {
        let mut bytes = [0; EVIDENCE_BYTES];
        bytes[..4].copy_from_slice(&flags.to_le_bytes());
        bytes[8..16].copy_from_slice(&expected.to_le_bytes());
        bytes[16..24].copy_from_slice(&observed.to_le_bytes());
        bytes[24..32].copy_from_slice(&seal.to_le_bytes());
        bytes
    }

    fn scalar(operation: u32, input: &[u8]) -> Result<u32, Errno> {
        let mut output = [0xa5; 4];
        assert_eq!(codec(operation, input, &mut output)?, 4);
        Ok(u32::from_le_bytes(output))
    }

    fn header(version: u32) -> [u8; 160] {
        let mut bytes = [0u8; 160];
        bytes[..4].copy_from_slice(b"KIDX");
        bytes[4..8].copy_from_slice(&version.to_le_bytes());
        bytes[72..80].copy_from_slice(&72u64.to_le_bytes());
        bytes[88..96].copy_from_slice(&1u64.to_le_bytes());
        let empty_digest = Sha256::digest([]);
        let content_digest = if version == 3 || version == 4 {
            Sha256::new().chain_update(empty_digest).chain_update(empty_digest).finalize()
        } else { empty_digest };
        bytes[96..128].copy_from_slice(&content_digest);
        let digest = Sha256::digest(&bytes[..128]);
        bytes[128..].copy_from_slice(&digest);
        bytes
    }

    #[test]
    fn unsealed_binding_and_retirement_use_digest_evidence_only_when_needed() {
        for (flags, expected, observed, verdict) in [
            (0, 0.0, 0.0, 0), (1, 0.0, 0.0, 2),
            (2, 3.0, 0.0, 1), (6, 3.0, 0.0, 0),
            (2, 3.0, 3.0, 0), (6, 3.0, 3.0, 4),
            (14, 3.0, 3.0, 2), (30, 3.0, 3.0, 0),
            (2, 3.0, 4.0, 2), (6, 3.0, 4.0, 2),
            (30, 3.0, 4.0, 2),
        ] {
            assert_eq!(scalar(16, &evidence(flags, expected, observed, 0.0)), Ok(verdict));
        }
    }

    #[test]
    fn sealed_source_ambiguity_and_supersession_preserve_fail_closed_selection() {
        for verified in [false, true] {
            for superseded in [false, true] {
                if superseded && !verified { continue; }
                for reused in [false, true] {
                    for observed in [0.0, 2.0, 3.0, 4.0] {
                        for seal in [0.0, 1.0] {
                            let flags = 3 | u32::from(verified) * 32 | u32::from(superseded) * 64 | u32::from(reused) * 128;
                            let expected = if verified {
                                if superseded || observed != 3.0 { 2 } else { 0 }
                            } else if !reused && seal > 0.0 && observed > 0.0 && observed != 3.0 { 3 } else { 0 };
                            assert_eq!(scalar(16, &evidence(flags, 3.0, observed, seal)), Ok(expected));
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn malformed_evidence_is_a_protocol_failure_without_output_publication() {
        let mut output = [0xa5; 4];
        for flags in [256, 4, 8, 16, 19, 67, 130] {
            assert_eq!(codec(16, &evidence(flags, 0.0, 0.0, 0.0), &mut output), Err(Errno::EINVAL));
            assert_eq!(output, [0xa5; 4]);
        }
        for value in [-1.0, 1.5, f64::NAN, f64::INFINITY, (1u64 << 53) as f64] {
            assert_eq!(codec(16, &evidence(2, value, 0.0, 0.0), &mut output), Err(Errno::EINVAL));
            assert_eq!(codec(15, &value.to_le_bytes(), &mut output), Err(Errno::EINVAL));
            assert_eq!(output, [0xa5; 4]);
        }
        let mut bytes = evidence(2, 3.0, 3.0, 0.0);
        bytes[4] = 1;
        assert_eq!(codec(16, &bytes, &mut output), Err(Errno::EINVAL));
        assert_eq!(codec(16, &bytes[..31], &mut output), Err(Errno::EINVAL));
        assert_eq!(output, [0xa5; 4]);
    }

    #[test]
    fn index_inspection_shares_checked_header_semantics_and_refuses_every_damaged_byte() {
        assert_eq!(scalar(13, &[0]), Ok(160));
        for version in 1..=5 {
            let bytes = header(version);
            assert_eq!(scalar(14, &bytes), Ok(u32::from(version <= 2)));
            for offset in 0..bytes.len() {
                let mut damaged = bytes;
                damaged[offset] ^= 1;
                assert_eq!(scalar(14, &damaged), Err(Errno::EIO));
            }
            for length in 0..bytes.len() {
                assert_eq!(scalar(14, &bytes[..length]), Err(Errno::EIO));
            }
        }
        for (offset, value) in [(4, 6u64), (72, 71), (80, u64::MAX), (88, 0)] {
            let mut bytes = header(1);
            bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
            let digest = Sha256::digest(&bytes[..128]);
            bytes[128..].copy_from_slice(&digest);
            assert_eq!(scalar(14, &bytes), Err(Errno::EIO));
        }
    }

    #[test]
    fn conversion_threshold_keeps_high_words_and_transport_refusals_do_not_touch_output() {
        for (length, convert) in [(0, 0), (CONVERSION_BYTES - 1, 0), (CONVERSION_BYTES, 1),
            (1u64 << 32, 1), ((1u64 << 53) - 1, 1)]
        {
            assert_eq!(scalar(15, &(length as f64).to_le_bytes()), Ok(convert));
        }
        let mut output = [0xa5; 3];
        for (operation, input) in [(13, &[0][..]), (14, header(1).as_slice()),
            (15, 0f64.to_le_bytes().as_slice()), (16, evidence(0, 0.0, 0.0, 0.0).as_slice())]
        {
            assert_eq!(codec(operation, input, &mut output), Err(Errno::EINVAL));
            assert_eq!(output, [0xa5; 3]);
        }
    }
}

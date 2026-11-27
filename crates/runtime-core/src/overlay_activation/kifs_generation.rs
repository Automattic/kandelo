//! A saved KIFS generation has a mutable volume and an immutable lineage seal.
//! KOGA authenticates the seal. Its SHA-256 is also the expected volume identity.
use super::{ActivationRecord, WIRE_BYTES, from_wire, next_activation, read_u64, to_wire};
use sha2::{Digest, Sha256};
use wasm_posix_shared::Errno;

const SEAL_BYTES: usize = 136;

// These two slots contain only KIFS volume files. Legacy journals and
// checkpoints in the same numbered slots use separate filenames.
fn target_slot(source: &ActivationRecord) -> u64 {
    u64::from(source.slot == Some(0))
}

fn lineage(seal: &[u8]) -> Result<(ActivationRecord, ActivationRecord), Errno> {
    if seal.len() != SEAL_BYTES || seal[..4] != *b"KIFG" || seal[4..8] != 1u32.to_le_bytes() {
        return Err(Errno::EIO);
    }
    let source = ActivationRecord {
        sequence: read_u64(seal, 16),
        generation: read_u64(seal, 24),
        slot: read_u64(seal, 32).checked_sub(1),
        base_digest: seal[40..72].try_into().unwrap(),
        seal_digest: seal[72..104].try_into().unwrap(),
    };
    let slot = target_slot(&source);
    if read_u64(seal, 8) != slot { return Err(Errno::EIO); }
    source.validate()?;
    let next = next_activation(Some(&source), ActivationRecord {
        sequence: 0,
        generation: source.generation + 1,
        slot: Some(slot),
        base_digest: source.base_digest,
        seal_digest: Sha256::digest(seal).into(),
    })?;
    Ok((source, next))
}

pub(super) fn codec(op: u32, input: &[u8], output: &mut [u8]) -> Result<usize, Errno> {
    // KIFR v1 carries fresh entropy and SHA-256 of the complete predecessor
    // journal and optional index. KIFG binds the receipt through its nonce
    // field. The predecessor KOGA already authenticates any KOVL seal.
    if op == 29 {
        if !matches!(input.len(), 64 | 96) || output.len() < 8 + input.len() {
            return Err(Errno::EINVAL);
        }
        output[..4].copy_from_slice(b"KIFR");
        output[4..8].copy_from_slice(&1u32.to_le_bytes());
        output[8..8 + input.len()].copy_from_slice(input);
        return Ok(8 + input.len());
    }
    if input.len() < WIRE_BYTES { return Err(Errno::EINVAL); }
    let authority = from_wire(&input[..WIRE_BYTES])?;
    authority.validate()?;
    let payload = &input[WIRE_BYTES..];
    match op {
        26 => {
            if payload.len() != 32 || output.len() < SEAL_BYTES { return Err(Errno::EINVAL); }
            let out = &mut output[..SEAL_BYTES];
            out[..4].copy_from_slice(b"KIFG");
            out[4..8].copy_from_slice(&1u32.to_le_bytes());
            out[8..16].copy_from_slice(&target_slot(&authority).to_le_bytes());
            out[16..24].copy_from_slice(&authority.sequence.to_le_bytes());
            out[24..32].copy_from_slice(&authority.generation.to_le_bytes());
            out[32..40].copy_from_slice(&authority.slot.map_or(0, |slot| slot + 1).to_le_bytes());
            out[40..72].copy_from_slice(&authority.base_digest);
            out[72..104].copy_from_slice(&authority.seal_digest);
            out[104..].copy_from_slice(payload);
            Ok(SEAL_BYTES)
        }
        27 | 28 => {
            if output.len() < WIRE_BYTES { return Err(Errno::EINVAL); }
            let (source, next) = lineage(payload)?;
            let record = match op {
                27 if next == authority => source,
                28 if source == authority => next,
                _ => return Err(Errno::EIO),
            };
            output[..WIRE_BYTES].copy_from_slice(&to_wire(&record));
            Ok(WIRE_BYTES)
        }
        30 => {
            if payload.len() < SEAL_BYTES { return Err(Errno::EINVAL); }
            let (seal, receipt) = payload.split_at(SEAL_BYTES);
            if !matches!(receipt.len(), 72 | 104) || receipt[..4] != *b"KIFR"
                || receipt[4..8] != 1u32.to_le_bytes()
                || lineage(seal)?.1 != authority || Sha256::digest(receipt)[..] != seal[104..]
            {
                return Err(Errno::EIO);
            }
            let digests = &receipt[40..];
            if output.len() < digests.len() { return Err(Errno::EINVAL); }
            output[..digests.len()].copy_from_slice(digests);
            Ok(digests.len())
        }
        _ => Err(Errno::EINVAL),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overlay_activation::MAX_SAFE_INTEGER;

    fn predecessor(slot: Option<u64>) -> ActivationRecord {
        ActivationRecord {
            sequence: 12,
            generation: if slot.is_some() { 8 } else { 0 },
            slot,
            base_digest: [7; 32],
            seal_digest: if slot.is_some() { [9; 32] } else { [0; 32] },
        }
    }

    fn stage(source: &ActivationRecord, nonce: u8) -> [u8; SEAL_BYTES] {
        let mut seal = [0; SEAL_BYTES];
        let input = [to_wire(source).as_slice(), &[nonce; 32]].concat();
        assert_eq!(codec(26, &input, &mut seal), Ok(SEAL_BYTES));
        seal
    }

    #[test]
    fn each_attempt_binds_one_volume_and_its_exact_predecessor() {
        for (slot, expected) in [(None, 0), (Some(0), 1), (Some(1), 0), (Some(8), 0)] {
            let source = predecessor(slot);
            let seal = stage(&source, 1);
            let mut result = [0; WIRE_BYTES];
            let input = [to_wire(&source).as_slice(), &seal].concat();
            assert_eq!(codec(28, &input, &mut result), Ok(WIRE_BYTES));
            let next = from_wire(&result).unwrap();
            assert_eq!(next.slot, Some(expected));
            assert_eq!(next.sequence, source.sequence + 1);
            assert_eq!(next.generation, source.generation + 1);
            assert_eq!(next.base_digest, source.base_digest);
            let verify = |seal: &[u8], out: &mut [u8]| {
                codec(27, &[to_wire(&next).as_slice(), seal].concat(), out)
            };
            assert_eq!(verify(&seal, &mut result), Ok(WIRE_BYTES));
            assert_eq!(from_wire(&result).unwrap(), source);
            assert_eq!(verify(&stage(&source, 2), &mut result), Err(Errno::EIO));
            for index in [0, 4, 8, 16, 24, 32, 40, 72, 104] {
                let mut changed = seal;
                changed[index] ^= 1;
                assert!(verify(&changed, &mut result).is_err());
            }
            assert!(verify(&seal[..135], &mut result).is_err());
            assert_eq!(result, to_wire(&source));
        }
    }

    #[test]
    fn retirement_evidence_binds_each_predecessor_file_to_the_activated_seal() {
        let source = predecessor(Some(0));
        for size in [64, 96] {
            let mut receipt = [0; 104];
            let input = (0..size as u8).collect::<Vec<_>>();
            let length = codec(29, &input, &mut receipt).unwrap();
            let receipt = &receipt[..length];
            let mut seal = [0; SEAL_BYTES];
            let nonce = Sha256::digest(receipt);
            codec(26, &[&to_wire(&source)[..], &nonce[..]].concat(), &mut seal).unwrap();
            let (_, active) = lineage(&seal).unwrap();
            let mut proof = [&to_wire(&active)[..], &seal, receipt].concat();
            let mut files = [0; 64];
            assert_eq!(codec(30, &proof, &mut files), Ok(size - 32));
            assert_eq!(&files[..size - 32], &input[32..]);
            *proof.last_mut().unwrap() ^= 1;
            assert_eq!(codec(30, &proof, &mut files), Err(Errno::EIO));
        }
    }

    #[test]
    fn refuses_to_wrap_exhausted_activation_counters() {
        for source in [
            ActivationRecord { sequence: MAX_SAFE_INTEGER, ..predecessor(Some(0)) },
            ActivationRecord { generation: MAX_SAFE_INTEGER, ..predecessor(Some(0)) },
        ] {
            let seal = stage(&source, 1);
            assert!(lineage(&seal).is_err());
        }
    }
}

use sha2::{Digest, Sha256};
use wasm_posix_shared::Errno;

use crate::overlay_activation::wire_integer;

pub const MAX_HEADER_BYTES: usize = 144;
const WIRE_BYTES: usize = 144;
const MAX_SAFE: u64 = (1u64 << 53) - 1;
const CHUNK_BYTES: u64 = 1024 * 1024;
const DIGEST_BYTES: u64 = 32;
const STORAGE_WIRE_BYTES: usize = 64;

struct Source {
    slot: Option<u64>,
    length: u64,
    digest: Option<[u8; 32]>,
}

struct Seal {
    generation: u64,
    journal_length: u64,
    base_digest: [u8; 32],
    index_length: Option<u64>,
    source: Option<Source>,
}

fn integer(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

fn header_length(prefix: &[u8]) -> Result<usize, Errno> {
    if prefix.len() != 8 || &prefix[..4] != b"KOGS" { return Err(Errno::EIO); }
    match u32::from_le_bytes(prefix[4..8].try_into().unwrap()) {
        1 => Ok(88), 2 => Ok(96), 3 => Ok(112), 4 => Ok(144), _ => Err(Errno::EIO),
    }
}

impl Seal {
    fn layout(&self, header_bytes: usize) -> Result<[u8; 16], Errno> {
        let chunks = self.journal_length.div_ceil(CHUNK_BYTES)
            .checked_add(self.index_length.unwrap_or(0).div_ceil(CHUNK_BYTES)).ok_or(Errno::EIO)?;
        let length = chunks.checked_mul(DIGEST_BYTES)
            .and_then(|bytes| bytes.checked_add(header_bytes as u64)).ok_or(Errno::EIO)?;
        if length > MAX_SAFE { return Err(Errno::EIO); }
        let mut bytes = [0; 16];
        bytes[..4].copy_from_slice(&(CHUNK_BYTES as u32).to_le_bytes());
        bytes[4..8].copy_from_slice(&(DIGEST_BYTES as u32).to_le_bytes());
        bytes[8..].copy_from_slice(&(length as f64).to_le_bytes());
        Ok(bytes)
    }

    fn validate(&self) -> Result<(), Errno> {
        let length = |value: u64| value > 0 && value <= MAX_SAFE;
        if !length(self.generation) || !length(self.journal_length)
            || self.index_length.is_some_and(|value| !length(value))
        { return Err(Errno::EINVAL); }
        if let Some(source) = &self.source {
            if self.index_length.is_none() || !length(source.length)
                || source.slot.is_some_and(|slot| slot >= MAX_SAFE)
                || source.slot.is_none() != (self.generation == 1)
                || (source.digest.is_some() && source.slot.is_some())
            { return Err(Errno::EINVAL); }
        }
        Ok(())
    }

    fn encode(&self, output: &mut [u8; MAX_HEADER_BYTES]) -> Result<usize, Errno> {
        self.validate()?;
        let version = match &self.source {
            Some(source) if source.digest.is_some() => 4u32,
            Some(_) => 3,
            None if self.index_length.is_some() => 2,
            None => 1,
        };
        output[..4].copy_from_slice(b"KOGS");
        output[4..8].copy_from_slice(&version.to_le_bytes());
        output[8..16].copy_from_slice(&self.generation.to_le_bytes());
        output[16..24].copy_from_slice(&self.journal_length.to_le_bytes());
        output[24..56].copy_from_slice(&self.base_digest);
        if let Some(length) = self.index_length { output[56..64].copy_from_slice(&length.to_le_bytes()); }
        if let Some(source) = &self.source {
            output[64..72].copy_from_slice(&source.length.to_le_bytes());
            output[72..80].copy_from_slice(&source.slot.map_or(0, |slot| slot + 1).to_le_bytes());
            if let Some(digest) = source.digest { output[80..112].copy_from_slice(&digest); }
        }
        let count = header_length(&output[..8])?;
        let digest = Sha256::digest(&output[..count - 32]);
        output[count - 32..count].copy_from_slice(&digest);
        Ok(count)
    }

    fn decode(bytes: &[u8]) -> Result<Self, Errno> {
        if bytes.len() < 8 { return Err(Errno::EIO); }
        let count = header_length(&bytes[..8])?;
        if bytes.len() != count || Sha256::digest(&bytes[..count - 32])[..] != bytes[count - 32..] {
            return Err(Errno::EIO);
        }
        let source = if count >= 112 {
            Some(Source { slot: integer(bytes, 72).checked_sub(1), length: integer(bytes, 64),
                digest: if count == 144 { Some(bytes[80..112].try_into().unwrap()) } else { None } })
        } else { None };
        let seal = Self { generation: integer(bytes, 8), journal_length: integer(bytes, 16),
            base_digest: bytes[24..56].try_into().unwrap(),
            index_length: if count >= 96 { Some(integer(bytes, 56)) } else { None }, source };
        seal.validate().map_err(|_| Errno::EIO)?;
        Ok(seal)
    }

    fn from_wire(bytes: &[u8]) -> Result<Self, Errno> {
        if bytes.len() != WIRE_BYTES { return Err(Errno::EINVAL); }
        let flags = u32::from_le_bytes(bytes[32..36].try_into().unwrap());
        let slot_length = u32::from_le_bytes(bytes[36..40].try_into().unwrap()) as usize;
        let base_length = u32::from_le_bytes(bytes[128..132].try_into().unwrap());
        let source_digest_length = u32::from_le_bytes(bytes[132..136].try_into().unwrap());
        if flags > 7 || flags & 2 == 0 && (flags & 4 != 0 || slot_length != 0)
            || slot_length > 24 || base_length != 32
            || source_digest_length != if flags & 4 == 0 { 0 } else { 32 }
            || bytes[136..144] != [0; 8]
        { return Err(Errno::EINVAL); }
        let generation = wire_integer(bytes, 0)?;
        let journal_length = wire_integer(bytes, 8)?;
        let index_length = wire_integer(bytes, 16)?;
        let source_length = wire_integer(bytes, 24)?;
        if flags & 1 == 0 && index_length != 0 || flags & 2 == 0 && source_length != 0
            || flags & 4 == 0 && bytes[72..104] != [0; 32]
        { return Err(Errno::EINVAL); }
        let source = if flags & 2 != 0 {
            let text = &bytes[104..104 + slot_length];
            let slot = if text == b"legacy" { None } else {
                if text.len() < 2 || text[0] != b'g' || text.len() > 2 && text[1] == b'0' {
                    return Err(Errno::EINVAL);
                }
                let mut slot = 0u64;
                for byte in &text[1..] {
                    if !byte.is_ascii_digit() { return Err(Errno::EINVAL); }
                    slot = slot.checked_mul(10).and_then(|value| value.checked_add((byte - b'0') as u64)).ok_or(Errno::EINVAL)?;
                }
                Some(slot)
            };
            Some(Source { slot, length: source_length,
                digest: if flags & 4 != 0 { Some(bytes[72..104].try_into().unwrap()) } else { None } })
        } else { None };
        let seal = Self { generation, journal_length, base_digest: bytes[40..72].try_into().unwrap(),
            index_length: if flags & 1 != 0 { Some(index_length) } else { None }, source };
        seal.validate()?;
        Ok(seal)
    }

    fn to_wire(&self) -> [u8; WIRE_BYTES] {
        let mut bytes = [0u8; WIRE_BYTES];
        bytes[..8].copy_from_slice(&(self.generation as f64).to_le_bytes());
        bytes[8..16].copy_from_slice(&(self.journal_length as f64).to_le_bytes());
        bytes[16..24].copy_from_slice(&(self.index_length.unwrap_or(0) as f64).to_le_bytes());
        bytes[40..72].copy_from_slice(&self.base_digest);
        bytes[128..132].copy_from_slice(&32u32.to_le_bytes());
        let mut flags = u32::from(self.index_length.is_some());
        if let Some(source) = &self.source {
            flags |= 2;
            bytes[24..32].copy_from_slice(&(source.length as f64).to_le_bytes());
            if let Some(digest) = source.digest {
                flags |= 4;
                bytes[72..104].copy_from_slice(&digest);
                bytes[132..136].copy_from_slice(&32u32.to_le_bytes());
            }
            let length = if let Some(mut slot) = source.slot {
                let mut digits = [0u8; 16];
                let mut start = digits.len();
                loop {
                    start -= 1;
                    digits[start] = b'0' + (slot % 10) as u8;
                    slot /= 10;
                    if slot == 0 { break; }
                }
                bytes[104] = b'g';
                bytes[105..105 + digits.len() - start].copy_from_slice(&digits[start..]);
                1 + digits.len() - start
            } else { bytes[104..110].copy_from_slice(b"legacy"); 6 };
            bytes[36..40].copy_from_slice(&(length as u32).to_le_bytes());
        }
        bytes[32..36].copy_from_slice(&flags.to_le_bytes());
        bytes
    }
}

fn verify_storage(input: &[u8]) -> Result<(), Errno> {
    if input.len() <= STORAGE_WIRE_BYTES { return Err(Errno::EINVAL); }
    let flags = u32::from_le_bytes(input[..4].try_into().map_err(|_| Errno::EINVAL)?);
    let expected_length = u32::from_le_bytes(input[4..8].try_into().map_err(|_| Errno::EINVAL)?);
    let journal_length = wire_integer(input, 8)?;
    let index_length = wire_integer(input, 16)?;
    let seal_length = wire_integer(input, 24)?;
    if flags > 7 || flags & 1 == 0 && index_length != 0
        || flags & 2 == 0 && (expected_length != 0 || input[32..64] != [0; 32])
    { return Err(Errno::EINVAL); }
    let header = &input[STORAGE_WIRE_BYTES..];
    let seal = Seal::decode(header)?;
    let expected_seal_length = wire_integer(&seal.layout(header.len())?, 8)?;
    let journal_matches = if flags & 4 != 0 { journal_length >= seal.journal_length } else { journal_length == seal.journal_length };
    if seal.index_length.is_some_and(|expected| flags & 1 == 0 || expected != index_length)
        || !journal_matches
        || flags & 2 != 0 && (expected_length != 32 || input[32..64] != seal.base_digest)
        || seal_length != expected_seal_length
    { return Err(Errno::EIO); }
    Ok(())
}

pub fn codec(operation: u32, input: &[u8], output: &mut [u8]) -> Result<usize, Errno> {
    let mut result = [0u8; MAX_HEADER_BYTES];
    let count = match operation {
        4 => Seal::from_wire(input)?.encode(&mut result)?,
        5 => { result[..WIRE_BYTES].copy_from_slice(&Seal::decode(input)?.to_wire()); WIRE_BYTES },
        9 => { result[..4].copy_from_slice(&(header_length(input)? as u32).to_le_bytes()); 4 },
        17 => { result[..16].copy_from_slice(&Seal::decode(input)?.layout(input.len())?); 16 },
        18 => { verify_storage(input)?; 4 },
        _ => return Err(Errno::EINVAL),
    };
    if output.len() < count { return Err(Errno::EINVAL); }
    output[..count].copy_from_slice(&result[..count]);
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geometry_header(journal_length: u64, index_length: Option<u64>) -> alloc::vec::Vec<u8> {
        let seal = Seal { generation: 2, journal_length, index_length, base_digest: [7; 32], source: None };
        let mut bytes = [0; MAX_HEADER_BYTES];
        let length = seal.encode(&mut bytes).unwrap();
        bytes[..length].to_vec()
    }

    fn inventory(header: &[u8], journal: u64, index: Option<u64>, length: u64, tail: bool) -> alloc::vec::Vec<u8> {
        let mut bytes = alloc::vec![0u8; STORAGE_WIRE_BYTES + header.len()];
        let flags = u32::from(index.is_some()) | if tail { 4 } else { 0 };
        bytes[..4].copy_from_slice(&flags.to_le_bytes());
        bytes[8..16].copy_from_slice(&(journal as f64).to_le_bytes());
        bytes[16..24].copy_from_slice(&(index.unwrap_or(0) as f64).to_le_bytes());
        bytes[24..32].copy_from_slice(&(length as f64).to_le_bytes());
        bytes[64..].copy_from_slice(header);
        bytes
    }

    #[test]
    fn seal_geometry_preserves_chunk_boundaries_and_high_words() {
        for journal in [1, CHUNK_BYTES, CHUNK_BYTES + 1, 1u64 << 32, MAX_SAFE] {
            for index in [None, Some(1), Some(CHUNK_BYTES + 1), Some(MAX_SAFE)] {
                let header = geometry_header(journal, index);
                let mut output = [0xa5; 16];
                assert_eq!(codec(17, &header, &mut output), Ok(16));
                assert_eq!(&output[..4], &(CHUNK_BYTES as u32).to_le_bytes());
                assert_eq!(&output[4..8], &32u32.to_le_bytes());
                let expected = header.len() as u64 + 32 * (journal.div_ceil(CHUNK_BYTES) + index.unwrap_or(0).div_ceil(CHUNK_BYTES));
                assert_eq!(wire_integer(&output, 8), Ok(expected));
                let mut result = [0xa5; 4];
                assert_eq!(codec(18, &inventory(&header, journal, index, expected, false), &mut result), Ok(4));
                assert_eq!(result, [0; 4]);
            }
        }
    }

    #[test]
    fn storage_inventory_checks_tail_index_identity_and_exact_seal_size() {
        let header = geometry_header(1024, Some(128));
        let length = header.len() as u64 + 64;
        for actual_journal in [1023, 1024, 1025] {
            for tail in [false, true] {
                for actual_index in [None, Some(127), Some(128), Some(129)] {
                    for actual_seal in [length - 1, length, length + 1] {
                        let valid = actual_index == Some(128) && actual_seal == length
                            && if tail { actual_journal >= 1024 } else { actual_journal == 1024 };
                        assert_eq!(verify_storage(&inventory(&header, actual_journal, actual_index, actual_seal, tail)),
                            if valid { Ok(()) } else { Err(Errno::EIO) });
                    }
                }
            }
        }
        let mut bytes = inventory(&header, 1024, Some(128), length, false);
        bytes[0] |= 2;
        bytes[4..8].copy_from_slice(&32u32.to_le_bytes());
        bytes[32..64].fill(7);
        assert_eq!(verify_storage(&bytes), Ok(()));
        bytes[32] ^= 1;
        assert_eq!(verify_storage(&bytes), Err(Errno::EIO));
        bytes[32] ^= 1;
        for size in [0u32, 31, 33] {
            bytes[4..8].copy_from_slice(&size.to_le_bytes());
            assert_eq!(verify_storage(&bytes), Err(Errno::EIO));
        }
        let header = geometry_header(1024, None);
        assert_eq!(verify_storage(&inventory(&header, 1024, Some(999), header.len() as u64 + 32, false)), Ok(()));
    }

    #[test]
    fn storage_protocol_and_output_errors_do_not_publish_partial_results() {
        let header = geometry_header(1024, None);
        let bytes = inventory(&header, 1024, None, header.len() as u64 + 32, false);
        let mut output = [0xa5; 16];
        for offset in [0, 8, 16, 24, 32] {
            let mut malformed = bytes.clone();
            if offset == 0 { malformed[0] |= 8; }
            else if offset == 32 { malformed[32] = 1; }
            else { malformed[offset..offset + 8].copy_from_slice(&f64::NAN.to_le_bytes()); }
            assert_eq!(codec(18, &malformed, &mut output), Err(Errno::EINVAL));
            assert_eq!(output, [0xa5; 16]);
        }
        assert_eq!(codec(18, &bytes, &mut output[..3]), Err(Errno::EINVAL));
        assert_eq!(codec(17, &header, &mut output[..15]), Err(Errno::EINVAL));
        assert_eq!(output, [0xa5; 16]);
        for offset in 0..header.len() {
            let mut damaged = header.clone();
            damaged[offset] ^= 1;
            assert_eq!(codec(17, &damaged, &mut output), Err(Errno::EIO));
            assert_eq!(output, [0xa5; 16]);
        }
    }

    #[test]
    fn all_seal_versions_round_trip_and_reject_single_byte_damage() {
        for version in 1..=4 {
            let seal = Seal { generation: if version == 4 { 1 } else { 2 }, journal_length: 3,
                base_digest: [7; 32], index_length: if version >= 2 { Some(1) } else { None },
                source: if version >= 3 { Some(Source { slot: if version == 4 { None } else { Some(0) },
                    length: 4, digest: if version == 4 { Some([9; 32]) } else { None } }) } else { None } };
            let mut bytes = [0u8; MAX_HEADER_BYTES];
            let count = seal.encode(&mut bytes).unwrap();
            assert_eq!(bytes[4], version);
            let wire = seal.to_wire();
            assert_eq!(Seal::decode(&bytes[..count]).unwrap().to_wire(), wire);
            assert_eq!(Seal::from_wire(&wire).unwrap().to_wire(), wire);
            for offset in 0..count {
                let mut damaged = bytes;
                damaged[offset] ^= 1;
                assert!(Seal::decode(&damaged[..count]).is_err());
            }
        }
    }

    #[test]
    fn malformed_seals_and_undersized_output_refuse_without_output() {
        let seal = Seal { generation: 1, journal_length: 3, base_digest: [0; 32], index_length: None, source: None };
        let valid = seal.to_wire();
        for value in [f64::NAN, f64::INFINITY, -1.0, 1.5, (MAX_SAFE + 1) as f64] {
            let mut bytes = valid;
            bytes[..8].copy_from_slice(&value.to_le_bytes());
            assert!(Seal::from_wire(&bytes).is_err());
        }
        let mut output = [0xa5; 87];
        assert_eq!(codec(4, &valid, &mut output), Err(Errno::EINVAL));
        assert_eq!(output, [0xa5; 87]);
        for size in [0, 7, 8, 87, 89, 145] { assert!(Seal::decode(&alloc::vec![0; size]).is_err()); }
    }
}

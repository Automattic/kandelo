use sha2::{Digest, Sha256};
use wasm_posix_shared::Errno;

pub const RECORD_BYTES: usize = 128;
pub const WIRE_BYTES: usize = 120;
pub const MAX_INPUT_BYTES: usize = 8 + 2 * WIRE_BYTES;
pub const MAX_OUTPUT_BYTES: usize = RECORD_BYTES;
const MAX_SAFE_INTEGER: u64 = (1u64 << 53) - 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActivationRecord {
    pub sequence: u64,
    pub generation: u64,
    pub slot: Option<u64>,
    pub base_digest: [u8; 32],
    pub seal_digest: [u8; 32],
}

impl ActivationRecord {
    pub(crate) fn validate(&self) -> Result<(), Errno> {
        if self.sequence == 0 || self.sequence > MAX_SAFE_INTEGER
            || self.generation > MAX_SAFE_INTEGER
            || self.slot.is_none() != (self.generation == 0)
            || self.slot.is_some_and(|slot| slot >= MAX_SAFE_INTEGER)
            || (self.slot.is_none() && self.seal_digest != [0; 32])
        {
            return Err(Errno::EINVAL);
        }
        Ok(())
    }

    pub(crate) fn same_identity(&self, other: &Self) -> bool {
        self.generation == other.generation && self.slot == other.slot
            && self.base_digest == other.base_digest && self.seal_digest == other.seal_digest
    }

    pub fn encode(&self) -> Result<[u8; RECORD_BYTES], Errno> {
        self.validate()?;
        let mut bytes = [0u8; RECORD_BYTES];
        bytes[..4].copy_from_slice(b"KOGA");
        bytes[4..8].copy_from_slice(&1u32.to_le_bytes());
        bytes[8..16].copy_from_slice(&self.sequence.to_le_bytes());
        bytes[16..24].copy_from_slice(&self.generation.to_le_bytes());
        bytes[24..32].copy_from_slice(&self.slot.map_or(0, |slot| slot + 1).to_le_bytes());
        bytes[32..64].copy_from_slice(&self.base_digest);
        bytes[64..96].copy_from_slice(&self.seal_digest);
        let digest = Sha256::digest(&bytes[..96]);
        bytes[96..].copy_from_slice(&digest);
        Ok(bytes)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, Errno> {
        if bytes.len() != RECORD_BYTES || &bytes[..4] != b"KOGA"
            || read_u32(bytes, 4) != 1 || Sha256::digest(&bytes[..96])[..] != bytes[96..]
        {
            return Err(Errno::EIO);
        }
        let slot = read_u64(bytes, 24);
        let record = Self {
            sequence: read_u64(bytes, 8), generation: read_u64(bytes, 16),
            slot: slot.checked_sub(1),
            base_digest: bytes[32..64].try_into().map_err(|_| Errno::EIO)?,
            seal_digest: bytes[64..96].try_into().map_err(|_| Errno::EIO)?,
        };
        record.validate().map_err(|_| Errno::EIO)?;
        Ok(record)
    }
}

pub fn next_activation(current: Option<&ActivationRecord>, mut identity: ActivationRecord) -> Result<ActivationRecord, Errno> {
    if let Some(current) = current {
        current.validate()?;
        let unchanged = current.same_identity(&identity);
        if !unchanged && (identity.generation != current.generation + 1 || identity.base_digest != current.base_digest) {
            return Err(Errno::EINVAL);
        }
        identity.sequence = if unchanged { current.sequence } else { current.sequence + 1 };
    } else {
        identity.sequence = 1;
    }
    identity.validate()?;
    Ok(identity)
}

pub fn select_activation(first: Option<ActivationRecord>, second: Option<ActivationRecord>, invalid: bool) -> Result<Option<ActivationRecord>, Errno> {
    for record in [&first, &second].into_iter().flatten() {
        record.validate()?;
    }
    match (first, second) {
        (None, None) if invalid => Err(Errno::EIO),
        (None, None) => Ok(None),
        (Some(record), None) | (None, Some(record)) => Ok(Some(record)),
        (Some(first), Some(second)) => {
            if first.sequence == second.sequence && !first.same_identity(&second) {
                return Err(Errno::EIO);
            }
            Ok(Some(if first.sequence >= second.sequence { first } else { second }))
        }
    }
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

pub(crate) fn wire_integer(bytes: &[u8], offset: usize) -> Result<u64, Errno> {
    let bits = read_u64(bytes, offset);
    if bits & 0x7fff_ffff_ffff_ffff == 0 { return Ok(0); }
    let exponent = ((bits >> 52) & 0x7ff) as i32 - 1023;
    if bits >> 63 != 0 || !(0..=52).contains(&exponent) { return Err(Errno::EINVAL); }
    let significand = (bits & 0x000f_ffff_ffff_ffff) | (1 << 52);
    let shift = (52 - exponent) as u32;
    if significand & ((1u64 << shift) - 1) != 0 { return Err(Errno::EINVAL); }
    Ok(significand >> shift)
}

pub(crate) fn parse_wire_slot(slot: &[u8]) -> Result<Option<u64>, Errno> {
    let slot = if slot == b"legacy" { None } else {
        if slot.len() < 2 || slot[0] != b'g' || (slot.len() > 2 && slot[1] == b'0') {
            return Err(Errno::EINVAL);
        }
        let mut number = 0u64;
        for &digit in &slot[1..] {
            if !digit.is_ascii_digit() { return Err(Errno::EINVAL); }
            number = number.checked_mul(10).and_then(|value| value.checked_add((digit - b'0') as u64)).ok_or(Errno::EINVAL)?;
        }
        if number >= MAX_SAFE_INTEGER { return Err(Errno::EINVAL); }
        Some(number)
    };
    Ok(slot)
}

pub(crate) fn from_wire(bytes: &[u8]) -> Result<ActivationRecord, Errno> {
    if bytes.len() != WIRE_BYTES || read_u32(bytes, 20) != 32 || read_u32(bytes, 24) != 32 || read_u32(bytes, 28) != 0 {
        return Err(Errno::EINVAL);
    }
    let length = read_u32(bytes, 16) as usize;
    if length > 24 { return Err(Errno::EINVAL); }
    let slot = parse_wire_slot(&bytes[96..96 + length])?;
    Ok(ActivationRecord {
        sequence: wire_integer(bytes, 0)?, generation: wire_integer(bytes, 8)?, slot,
        base_digest: bytes[32..64].try_into().map_err(|_| Errno::EINVAL)?,
        seal_digest: bytes[64..96].try_into().map_err(|_| Errno::EINVAL)?,
    })
}

fn to_wire(record: &ActivationRecord) -> [u8; WIRE_BYTES] {
    let mut bytes = [0u8; WIRE_BYTES];
    bytes[..8].copy_from_slice(&(record.sequence as f64).to_le_bytes());
    bytes[8..16].copy_from_slice(&(record.generation as f64).to_le_bytes());
    bytes[20..24].copy_from_slice(&32u32.to_le_bytes());
    bytes[24..28].copy_from_slice(&32u32.to_le_bytes());
    bytes[32..64].copy_from_slice(&record.base_digest);
    bytes[64..96].copy_from_slice(&record.seal_digest);
    let length = match record.slot {
        None => { bytes[96..102].copy_from_slice(b"legacy"); 6 },
        Some(mut number) => {
            let mut digits = [0u8; 20];
            let mut start = digits.len();
            loop {
                start -= 1;
                digits[start] = b'0' + (number % 10) as u8;
                number /= 10;
                if number == 0 { break; }
            }
            bytes[96] = b'g';
            bytes[97..97 + digits.len() - start].copy_from_slice(&digits[start..]);
            1 + digits.len() - start
        }
    };
    bytes[16..20].copy_from_slice(&(length as u32).to_le_bytes());
    bytes
}

pub fn codec(operation: u32, input: &[u8], output: &mut [u8]) -> Result<usize, Errno> {
    let mut result = [0u8; MAX_OUTPUT_BYTES];
    let length = match operation {
        0 => { result.copy_from_slice(&from_wire(input)?.encode()?); RECORD_BYTES },
        1 => { result[..WIRE_BYTES].copy_from_slice(&to_wire(&ActivationRecord::decode(input)?)); WIRE_BYTES },
        2 | 3 => {
            if input.len() != MAX_INPUT_BYTES || read_u32(input, 4) != 0 { return Err(Errno::EINVAL); }
            let flags = read_u32(input, 0);
            let first = if flags & 1 == 0 { None } else { Some(from_wire(&input[8..8 + WIRE_BYTES])?) };
            let second_bytes = &input[8 + WIRE_BYTES..];
            let record = if operation == 2 {
                if flags > 1 { return Err(Errno::EINVAL); }
                Some(next_activation(first.as_ref(), from_wire(second_bytes)?)?)
            } else {
                if flags > 7 { return Err(Errno::EINVAL); }
                let second = if flags & 2 == 0 { None } else { Some(from_wire(second_bytes)?) };
                select_activation(first, second, flags & 4 != 0)?
            };
            if let Some(record) = record { result[..WIRE_BYTES].copy_from_slice(&to_wire(&record)); WIRE_BYTES } else { 0 }
        },
        _ => return Err(Errno::EINVAL),
    };
    if output.len() < length { return Err(Errno::EINVAL); }
    output[..length].copy_from_slice(&result[..length]);
    Ok(length)
}

pub unsafe fn codec_ffi(operation: u32, input: *const u8, input_length: u32, output: *mut u8, output_capacity: u32) -> i32 {
    let input_start = input as usize;
    let output_start = output as usize;
    let Some(input_end) = input_start.checked_add(input_length as usize) else { return -(Errno::EINVAL as i32); };
    let Some(output_end) = output_start.checked_add(output_capacity as usize) else { return -(Errno::EINVAL as i32); };
    let input_limit = if operation <= 3 { MAX_INPUT_BYTES } else { crate::storage_digest::MAX_INPUT_BYTES };
    let output_limit = if operation <= 3 { MAX_OUTPUT_BYTES } else { crate::overlay_seal::MAX_HEADER_BYTES };
    if input.is_null() || output.is_null() || input_length as usize > input_limit
        || output_capacity as usize > output_limit
        || (input_start < output_end && output_start < input_end)
    {
        return -(Errno::EINVAL as i32);
    }
    let input = unsafe { core::slice::from_raw_parts(input, input_length as usize) };
    let output = unsafe { core::slice::from_raw_parts_mut(output, output_capacity as usize) };
    let result = match operation {
        0..=3 => codec(operation, input, output),
        4 | 5 | 9 | 17 | 18 => crate::overlay_seal::codec(operation, input, output),
        6..=8 => crate::storage_digest::codec(operation, input, output),
        11 | 12 => crate::persistent_overlay::journal_header_codec(operation, input, output),
        13..=16 => crate::overlay_recovery::codec(operation, input, output),
        19 | 20 => crate::image_binding::codec(operation, input, output),
        21..=25 => crate::overlay_generation_policy::codec(operation, input, output),
        10 if input == [0] && output.len() >= 8 => {
            output[..8].copy_from_slice(b"KOSC\x02\x00\x00\x00");
            Ok(8)
        },
        _ => Err(Errno::EINVAL),
    };
    match result {
        Ok(length) => length as i32,
        Err(error) => -(error as i32),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn initial() -> ActivationRecord {
        ActivationRecord { sequence: 1, generation: 0, slot: None, base_digest: [7; 32], seal_digest: [0; 32] }
    }

    fn sealed() -> ActivationRecord {
        ActivationRecord { sequence: 2, generation: 1, slot: Some(0), base_digest: [7; 32], seal_digest: [9; 32] }
    }

    #[test]
    fn records_round_trip_and_every_single_byte_damage_refuses() {
        for record in [initial(), sealed(), ActivationRecord { slot: Some(MAX_SAFE_INTEGER - 1), ..sealed() }] {
            let bytes = record.encode().unwrap();
            assert_eq!(ActivationRecord::decode(&bytes), Ok(record));
            for index in 0..bytes.len() {
                let mut damaged = bytes;
                damaged[index] ^= 1;
                assert_eq!(ActivationRecord::decode(&damaged), Err(Errno::EIO));
            }
        }
    }

    #[test]
    fn invalid_record_geometry_and_unsafe_numbers_refuse() {
        for record in [ActivationRecord { sequence: 0, ..initial() },
            ActivationRecord { sequence: MAX_SAFE_INTEGER + 1, ..initial() },
            ActivationRecord { generation: MAX_SAFE_INTEGER + 1, ..sealed() },
            ActivationRecord { generation: 1, ..initial() },
            ActivationRecord { seal_digest: [1; 32], ..initial() },
            ActivationRecord { slot: Some(MAX_SAFE_INTEGER), ..sealed() }] {
            assert_eq!(record.encode(), Err(Errno::EINVAL));
        }
        for value in [f64::NAN, f64::INFINITY, -1.0, 1.5, (MAX_SAFE_INTEGER + 1) as f64] {
            let mut wire = to_wire(&initial());
            wire[..8].copy_from_slice(&value.to_le_bytes());
            assert_eq!(from_wire(&wire), Err(Errno::EINVAL));
        }
    }

    #[test]
    fn activation_requires_same_base_and_next_generation_with_bounded_sequence() {
        assert_eq!(next_activation(None, sealed()).unwrap().sequence, 1);
        assert_eq!(next_activation(Some(&initial()), sealed()), Ok(sealed()));
        assert_eq!(next_activation(Some(&sealed()), sealed()), Ok(sealed()));
        assert_eq!(next_activation(Some(&initial()), ActivationRecord { base_digest: [4; 32], ..sealed() }), Err(Errno::EINVAL));
        assert_eq!(next_activation(Some(&initial()), ActivationRecord { generation: 2, ..sealed() }), Err(Errno::EINVAL));
        let current = ActivationRecord { sequence: MAX_SAFE_INTEGER, ..initial() };
        assert_eq!(next_activation(Some(&current), initial()), Ok(current.clone()));
        assert_eq!(next_activation(Some(&current), sealed()), Err(Errno::EINVAL));
    }

    #[test]
    fn selection_repairs_one_invalid_or_stale_control_but_refuses_ambiguity() {
        assert_eq!(select_activation(None, None, false), Ok(None));
        assert_eq!(select_activation(None, None, true), Err(Errno::EIO));
        assert_eq!(select_activation(Some(initial()), Some(sealed()), false), Ok(Some(sealed())));
        assert_eq!(select_activation(None, Some(sealed()), true), Ok(Some(sealed())));
        assert_eq!(select_activation(Some(sealed()), Some(ActivationRecord { seal_digest: [4; 32], ..sealed() }), false), Err(Errno::EIO));
    }

    #[test]
    fn wire_codec_is_bounded_and_failure_does_not_publish_output() {
        let mut output = [0xa5; MAX_OUTPUT_BYTES];
        assert_eq!(codec(0, &to_wire(&sealed()), &mut output), Ok(RECORD_BYTES));
        let stored = output;
        assert_eq!(codec(1, &stored, &mut output), Ok(WIRE_BYTES));
        assert_eq!(&output[..WIRE_BYTES], &to_wire(&sealed()));
        let mut input = [0u8; MAX_INPUT_BYTES];
        input[0] = 1;
        input[8..8 + WIRE_BYTES].copy_from_slice(&to_wire(&initial()));
        input[8 + WIRE_BYTES..].copy_from_slice(&to_wire(&sealed()));
        assert_eq!(codec(2, &input, &mut output), Ok(WIRE_BYTES));
        assert_eq!(&output[..WIRE_BYTES], &to_wire(&sealed()));
        input[0] = 3;
        assert_eq!(codec(3, &input, &mut output), Ok(WIRE_BYTES));
        let prior = output;
        assert_eq!(codec(9, &[], &mut output), Err(Errno::EINVAL));
        assert_eq!(codec(0, &[], &mut output), Err(Errno::EINVAL));
        assert_eq!(codec(0, &to_wire(&sealed()), &mut output[..127]), Err(Errno::EINVAL));
        assert_eq!(output, prior);
        let mut malformed = to_wire(&sealed());
        malformed[16..20].copy_from_slice(&25u32.to_le_bytes());
        assert_eq!(codec(0, &malformed, &mut output), Err(Errno::EINVAL));
        malformed = to_wire(&sealed());
        malformed[16..20].copy_from_slice(&3u32.to_le_bytes());
        malformed[96..99].copy_from_slice(b"g01");
        assert_eq!(codec(0, &malformed, &mut output), Err(Errno::EINVAL));
    }

    #[test]
    fn journal_header_policy_validates_identity_and_transport_without_mutation() {
        let mut header = [0u8; 72];
        header[..4].copy_from_slice(b"KOVL");
        header[4..8].copy_from_slice(&1u32.to_le_bytes());
        header[8..40].fill(19);
        let digest = Sha256::digest(&header[..40]);
        header[40..].copy_from_slice(&digest);
        let mut output = [0xa5; 144];
        unsafe {
            assert_eq!(codec_ffi(11, [0u8].as_ptr(), 1, output.as_mut_ptr(), 144), 4);
            assert_eq!(&output[..4], &72u32.to_le_bytes());
            assert_eq!(codec_ffi(12, header.as_ptr(), 72, output.as_mut_ptr(), 144), 32);
            assert_eq!(&output[..32], &[19; 32]);
        }
        let before = output;
        for offset in 0..header.len() {
            let mut damaged = header;
            damaged[offset] ^= 1;
            unsafe {
                assert_eq!(codec_ffi(12, damaged.as_ptr(), 72, output.as_mut_ptr(), 144), -(Errno::EIO as i32));
            }
            assert_eq!(output, before);
        }
        for length in 0..72 {
            unsafe {
                assert_eq!(codec_ffi(12, header.as_ptr(), length, output.as_mut_ptr(), 144), -(Errno::EIO as i32));
            }
            assert_eq!(output, before);
        }
        for (operation, input, capacity) in [(11, &[0u8][..], 3), (12, header.as_slice(), 31), (11, &[1u8][..], 144)] {
            unsafe {
                assert_eq!(codec_ffi(operation, input.as_ptr(), input.len() as u32, output.as_mut_ptr(), capacity), -(Errno::EINVAL as i32));
            }
            assert_eq!(output, before);
        }
        for offset in [0, 4] {
            let mut unsupported = header;
            unsupported[offset] ^= 1;
            let digest = Sha256::digest(&unsupported[..40]);
            unsupported[40..].copy_from_slice(&digest);
            assert_eq!(crate::persistent_overlay::journal_header_base_digest(&unsupported), Err(Errno::EIO));
        }
    }

    #[test]
    fn ffi_refuses_aliases_null_pointers_and_oversized_windows_before_access() {
        let mut bytes = [0xa5u8; 384];
        let before = bytes;
        unsafe {
            assert_eq!(codec_ffi(0, bytes.as_ptr(), 120, bytes.as_mut_ptr(), 128), -(Errno::EINVAL as i32));
            assert_eq!(codec_ffi(0, core::ptr::null(), 120, bytes.as_mut_ptr(), 128), -(Errno::EINVAL as i32));
            assert_eq!(codec_ffi(0, bytes.as_ptr(), 249, bytes.as_mut_ptr().add(256), 128), -(Errno::EINVAL as i32));
            assert_eq!(codec_ffi(0, bytes.as_ptr(), 120, bytes.as_mut_ptr().add(256), 129), -(Errno::EINVAL as i32));
        }
        assert_eq!(bytes, before);
    }
}

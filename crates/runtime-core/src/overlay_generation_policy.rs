use core::cmp::Ordering;
use wasm_posix_shared::Errno;
use crate::overlay_activation::{ActivationRecord, from_wire, parse_wire_slot, wire_integer, WIRE_BYTES};

const POINT_BYTES: usize = 40;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Generation {
    slot: Option<u64>,
    number: u64,
}

impl Generation {
    fn decode(bytes: &[u8]) -> Result<Self, Errno> {
        if bytes.len() != POINT_BYTES || bytes[12..16] != [0; 4] { return Err(Errno::EINVAL); }
        let length = u32::from_le_bytes(bytes[8..12].try_into().map_err(|_| Errno::EINVAL)?) as usize;
        if length > 24 || bytes[16 + length..] != [0; 24][..24 - length] { return Err(Errno::EINVAL); }
        let generation = Self { slot: parse_wire_slot(&bytes[16..16 + length])?, number: wire_integer(bytes, 0)? };
        if generation.slot.is_none() && generation.number != 0 { return Err(Errno::EINVAL); }
        Ok(generation)
    }

    fn sealed(self) -> Result<Self, Errno> {
        if self.slot.is_none() || self.number == 0 { return Err(Errno::EINVAL); }
        Ok(self)
    }

    fn predecessor_of(self, active: Self) -> bool {
        (self.number > 0 || self.slot.is_none())
            && self.number.checked_add(1) == Some(active.number) && self.slot != active.slot
    }

    fn reusable_after(self, active: Self) -> bool {
        self.slot.is_some() && self.number > active.number && self.slot != active.slot
    }
}

fn header(input: &[u8], length: usize, mask: u32) -> Result<u32, Errno> {
    if input.len() != length || input[4..8] != [0; 4] { return Err(Errno::EINVAL); }
    let flags = u32::from_le_bytes(input[..4].try_into().map_err(|_| Errno::EINVAL)?);
    if flags & !mask != 0 { return Err(Errno::EINVAL); }
    Ok(flags)
}

fn identity(bytes: &[u8]) -> Result<ActivationRecord, Errno> {
    let mut record = from_wire(bytes)?;
    record.sequence = 1;
    record.validate()?;
    Ok(record)
}

fn candidate_role(input: &[u8]) -> Result<u32, Errno> {
    let flags = header(input, 8 + 2 * WIRE_BYTES, 15)?;
    let active = if flags & 1 != 0 { Some(identity(&input[8..8 + WIRE_BYTES])?) } else {
        if input[8..8 + WIRE_BYTES].iter().any(|byte| *byte != 0) { return Err(Errno::EINVAL); }
        None
    };
    let candidate = if flags & 2 != 0 { Some(identity(&input[8 + WIRE_BYTES..])?) } else {
        if input[8 + WIRE_BYTES..].iter().any(|byte| *byte != 0) { return Err(Errno::EINVAL); }
        None
    };
    let finish = flags & 4 != 0;
    if flags & 8 != 0 && !finish { return Err(Errno::EINVAL); }
    let Some(active) = active else {
        if finish && flags & 8 != 0 { return Err(Errno::EIO); }
        if !finish && candidate.is_none() { return Err(Errno::EINVAL); }
        return Ok(0);
    };
    let Some(candidate) = candidate else {
        return if !finish { Err(Errno::EINVAL) } else if active.slot.is_none() { Ok(0) } else { Err(Errno::EIO) };
    };
    if active.slot == candidate.slot {
        return if active.same_identity(&candidate) { Ok(1) } else { Err(Errno::EIO) };
    }
    if finish { return Err(Errno::EIO); }
    Ok(if candidate.generation > active.generation { 2 } else { 3 })
}

fn retention(input: &[u8]) -> Result<u32, Errno> {
    let flags = header(input, 8 + 3 * POINT_BYTES, 15)?;
    let mode = flags & 3;
    let active = Generation::decode(&input[8..48])?;
    if active.number == 0 && active.slot.is_some() { return Err(Errno::EINVAL); }
    let protected = if flags & 4 != 0 { Some(Generation::decode(&input[48..88])?) } else {
        if input[48..88].iter().any(|byte| *byte != 0) { return Err(Errno::EINVAL); }
        None
    };
    let candidate = Generation::decode(&input[88..128])?;
    if mode != 2 && flags & 8 != 0 { return Err(Errno::EINVAL); }
    let eligible = match mode {
        0 => protected.is_none() && candidate.reusable_after(active),
        1 => protected.is_some_and(|source| source.slot.is_some() && source.number > 0
            && source.predecessor_of(active) && candidate.slot.is_some() && candidate.number > 0
            && candidate.number < source.number && candidate.slot != source.slot && candidate.slot != active.slot),
        2 => active.number == 2 && protected.is_some_and(|source| source.number == 1 && source.predecessor_of(active))
            && candidate.slot.is_none() && candidate.number == 0 && flags & 8 != 0,
        3 => candidate.slot.is_some() && candidate.slot != active.slot
            && protected.is_none_or(|source| candidate.slot != source.slot),
        _ => return Err(Errno::EINVAL),
    };
    Ok(u32::from(eligible))
}

fn reclaim_unpublished(input: &[u8]) -> Result<u32, Errno> {
    let flags = header(input, 8 + 2 * WIRE_BYTES + 2 * POINT_BYTES, 3)?;
    let selected = identity(&input[128..248])?;
    let protected = if flags & 2 != 0 { Some(Generation::decode(&input[248..288])?) } else {
        if input[248..288].iter().any(|byte| *byte != 0) { return Err(Errno::EINVAL); }
        None
    };
    let candidate = Generation::decode(&input[288..328])?;
    if flags & 1 == 0 {
        if input[8..128].iter().any(|byte| *byte != 0) { return Err(Errno::EINVAL); }
        return Ok(0);
    }
    let active = from_wire(&input[8..128])?;
    active.validate()?;
    if !active.same_identity(&selected) { return Err(Errno::EIO); }
    let active = Generation { slot: active.slot, number: active.generation };
    Ok(u32::from(active.slot.is_some() && candidate.slot.is_some() && candidate.number == 0
        && candidate.slot != active.slot && protected.is_some_and(|source| source.number > 0
            && source.predecessor_of(active) && candidate.slot != source.slot)))
}

pub(crate) fn codec(operation: u32, input: &[u8], output: &mut [u8]) -> Result<usize, Errno> {
    let result = match operation {
        21 => {
            let flags = header(input, 8 + 2 * POINT_BYTES, 1)?;
            let left = Generation::decode(&input[8..48])?.sealed()?;
            let right = Generation::decode(&input[48..88])?.sealed()?;
            let order = match left.number.cmp(&right.number) {
                Ordering::Equal if left.slot != right.slot => 3,
                Ordering::Equal => 0,
                Ordering::Less => if flags == 0 { 1 } else { 2 },
                Ordering::Greater => if flags == 0 { 2 } else { 1 },
            };
            order
        },
        22 => candidate_role(input)?,
        23 => {
            header(input, 8 + 3 * POINT_BYTES, 0)?;
            let active = Generation::decode(&input[8..48])?.sealed()?;
            let source = Generation::decode(&input[48..88])?;
            if source.number != 0 { return Err(Errno::EINVAL); }
            let other = Generation::decode(&input[88..128])?;
            if source.slot == active.slot { 3 }
            else if source.slot != other.slot { 0 }
            else if other.predecessor_of(active) { 2 }
            else { 1 }
        },
        24 => retention(input)?,
        25 => reclaim_unpublished(input)?,
        _ => return Err(Errno::EINVAL),
    };
    if output.len() < 4 { return Err(Errno::EINVAL); }
    output[..4].copy_from_slice(&result.to_le_bytes());
    Ok(4)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(slot: Option<u64>, number: u64) -> [u8; POINT_BYTES] {
        let mut bytes = [0; POINT_BYTES];
        bytes[..8].copy_from_slice(&(number as f64).to_le_bytes());
        let name = slot.map_or_else(|| "legacy".to_string(), |slot| format!("g{slot}"));
        bytes[8..12].copy_from_slice(&(name.len() as u32).to_le_bytes());
        bytes[16..16 + name.len()].copy_from_slice(name.as_bytes());
        bytes
    }

    fn request(flags: u32, points: &[[u8; POINT_BYTES]]) -> Vec<u8> {
        let mut bytes = vec![0; 8 + POINT_BYTES * points.len()];
        bytes[..4].copy_from_slice(&flags.to_le_bytes());
        for (index, point) in points.iter().enumerate() { bytes[8 + index * POINT_BYTES..8 + (index + 1) * POINT_BYTES].copy_from_slice(point); }
        bytes
    }

    fn scalar(operation: u32, input: &[u8]) -> Result<u32, Errno> {
        let mut output = [0xa5; 4];
        assert_eq!(codec(operation, input, &mut output)?, 4);
        Ok(u32::from_le_bytes(output))
    }

    fn identity_wire(slot: Option<u64>, generation: u64, digest: u8) -> [u8; WIRE_BYTES] {
        let reference = point(slot, generation);
        let mut bytes = [0; WIRE_BYTES];
        bytes[..8].copy_from_slice(&1f64.to_le_bytes());
        bytes[8..16].copy_from_slice(&reference[..8]);
        bytes[16..20].copy_from_slice(&reference[8..12]);
        bytes[20..24].copy_from_slice(&32u32.to_le_bytes());
        bytes[24..28].copy_from_slice(&32u32.to_le_bytes());
        bytes[32..64].fill(7);
        if slot.is_some() { bytes[64..96].fill(digest); }
        bytes[96..120].copy_from_slice(&reference[16..40]);
        bytes
    }

    fn candidates(flags: u32, active: Option<[u8; WIRE_BYTES]>, candidate: Option<[u8; WIRE_BYTES]>) -> Vec<u8> {
        let mut bytes = vec![0; 8 + 2 * WIRE_BYTES];
        bytes[..4].copy_from_slice(&flags.to_le_bytes());
        if let Some(active) = active { bytes[8..8 + WIRE_BYTES].copy_from_slice(&active); }
        if let Some(candidate) = candidate { bytes[8 + WIRE_BYTES..].copy_from_slice(&candidate); }
        bytes
    }

    #[test]
    fn authority_admission_refuses_missing_or_substituted_activated_content() {
        let active = identity_wire(Some(1), 3, 9);
        assert_eq!(scalar(22, &candidates(3, Some(active), Some(active))), Ok(1));
        assert_eq!(scalar(22, &candidates(7, Some(active), Some(active))), Ok(1));
        assert_eq!(scalar(22, &candidates(5, Some(active), None)), Err(Errno::EIO));
        assert_eq!(scalar(22, &candidates(3, Some(active), Some(identity_wire(Some(1), 3, 10)))), Err(Errno::EIO));
        assert_eq!(scalar(22, &candidates(3, Some(active), Some(identity_wire(Some(1), 4, 9)))), Err(Errno::EIO));
        assert_eq!(scalar(22, &candidates(3, Some(active), Some(identity_wire(Some(2), 4, 9)))), Ok(2));
        assert_eq!(scalar(22, &candidates(3, Some(active), Some(identity_wire(Some(2), 2, 9)))), Ok(3));
        assert_eq!(scalar(22, &candidates(7, Some(active), Some(identity_wire(Some(2), 4, 9)))), Err(Errno::EIO));
    }

    #[test]
    fn unanchored_partial_inventory_refuses_but_anchored_staging_is_tolerated() {
        let candidate = identity_wire(Some(1), 3, 9);
        assert_eq!(scalar(22, &candidates(2, None, Some(candidate))), Ok(0));
        assert_eq!(scalar(22, &candidates(4, None, None)), Ok(0));
        assert_eq!(scalar(22, &candidates(12, None, None)), Err(Errno::EIO));
        assert_eq!(scalar(22, &candidates(15, Some(candidate), Some(candidate))), Ok(1));
        let legacy = identity_wire(None, 0, 0);
        assert_eq!(scalar(22, &candidates(5, Some(legacy), None)), Ok(0));
        assert_eq!(scalar(22, &candidates(13, Some(legacy), None)), Ok(0));
        assert_eq!(scalar(22, &candidates(3, Some(legacy), Some(candidate))), Ok(2));
        assert_eq!(scalar(22, &candidates(11, Some(legacy), Some(candidate))), Err(Errno::EINVAL));
    }

    #[test]
    fn ordering_is_directional_and_duplicate_generations_are_ambiguous() {
        let first = point(Some(3), 7);
        let second = point(Some(1), 9);
        assert_eq!(scalar(21, &request(0, &[first, second])), Ok(1));
        assert_eq!(scalar(21, &request(1, &[first, second])), Ok(2));
        assert_eq!(scalar(21, &request(0, &[first, first])), Ok(0));
        assert_eq!(scalar(21, &request(0, &[first, point(Some(4), 7)])), Ok(3));
        assert_eq!(scalar(21, &request(0, &[point(None, 0), second])), Err(Errno::EINVAL));
    }

    #[test]
    fn source_relationship_uses_generation_and_slot_together() {
        let active = point(Some(2), 8);
        let source = point(Some(0), 0);
        assert_eq!(scalar(23, &request(0, &[active, source, point(Some(0), 7)])), Ok(2));
        assert_eq!(scalar(23, &request(0, &[active, source, point(Some(0), 9)])), Ok(1));
        assert_eq!(scalar(23, &request(0, &[active, source, point(Some(1), 7)])), Ok(0));
        assert_eq!(scalar(23, &request(0, &[active, point(Some(2), 0), active])), Ok(3));
        assert_eq!(scalar(23, &request(0, &[point(Some(2), 1), source, point(Some(0), 0)])), Ok(1));
    }

    #[test]
    fn retirement_preserves_active_predecessor_unknown_and_newer_slots() {
        let active = point(Some(2), 8);
        let predecessor = point(Some(1), 7);
        assert_eq!(scalar(24, &request(5, &[active, predecessor, point(Some(0), 6)])), Ok(1));
        for candidate in [active, predecessor, point(Some(0), 8), point(Some(0), 9), point(Some(0), 0), point(None, 0)] {
            assert_eq!(scalar(24, &request(5, &[active, predecessor, candidate])), Ok(0));
        }
        assert_eq!(scalar(24, &request(5, &[active, point(Some(1), 6), point(Some(0), 5)])), Ok(0));
    }

    #[test]
    fn staging_cannot_overwrite_active_or_protected_slots() {
        let active = point(Some(2), 8);
        let protected = point(Some(1), 7);
        for candidate in [active, protected, point(Some(1), 0), point(Some(2), 0), point(None, 0)] {
            assert_eq!(scalar(24, &request(7, &[active, protected, candidate])), Ok(0));
        }
        for candidate in [point(Some(0), 0), point(Some(0), 6), point(Some(0), 8), point(Some(0), 9)] {
            assert_eq!(scalar(24, &request(7, &[active, protected, candidate])), Ok(1));
        }
        assert_eq!(scalar(24, &request(3, &[point(None, 0), [0; POINT_BYTES], point(Some(0), 0)])), Ok(1));
    }

    #[test]
    fn legacy_retirement_requires_the_bound_second_successor() {
        let legacy = point(None, 0);
        let source = point(Some(3), 1);
        assert_eq!(scalar(24, &request(14, &[point(Some(0), 2), source, legacy])), Ok(1));
        assert_eq!(scalar(24, &request(6, &[point(Some(0), 2), source, legacy])), Ok(0));
        assert_eq!(scalar(24, &request(14, &[point(Some(0), 3), source, legacy])), Ok(0));
    }

    #[test]
    fn unpublished_cleanup_requires_matching_activation_and_protects_the_predecessor() {
        let active = identity_wire(Some(2), 8, 9);
        let mut input = vec![0; 328];
        input[..4].copy_from_slice(&3u32.to_le_bytes());
        input[8..128].copy_from_slice(&active);
        input[128..248].copy_from_slice(&active);
        input[248..288].copy_from_slice(&point(Some(1), 7));
        input[288..328].copy_from_slice(&point(Some(0), 0));
        assert_eq!(scalar(25, &input), Ok(1));
        for candidate in [point(Some(2), 0), point(Some(1), 0), point(Some(0), 9), point(None, 0)] {
            input[288..328].copy_from_slice(&candidate);
            assert_eq!(scalar(25, &input), Ok(0));
        }
        input[288..328].copy_from_slice(&point(Some(0), 0));
        input[128..248].copy_from_slice(&identity_wire(Some(2), 8, 10));
        assert_eq!(scalar(25, &input), Err(Errno::EIO));
        input[128..248].copy_from_slice(&active);
        input[..4].copy_from_slice(&2u32.to_le_bytes());
        input[8..128].fill(0);
        assert_eq!(scalar(25, &input), Ok(0));
    }

    #[test]
    fn reference_transport_rejects_fractional_unsafe_and_noncanonical_values() {
        let original = point(Some(2), 8);
        for number in [f64::NAN, f64::INFINITY, -1.0, 0.5, 9007199254740992.0] {
            let mut changed = original;
            changed[..8].copy_from_slice(&number.to_le_bytes());
            assert_eq!(scalar(21, &request(0, &[changed, original])), Err(Errno::EINVAL));
        }
        for index in [12, 15, 20, 39] {
            let mut changed = original;
            changed[index] = 1;
            assert_eq!(scalar(21, &request(0, &[changed, original])), Err(Errno::EINVAL));
        }
        let bytes = request(0, &[original, original]);
        for length in 0..bytes.len() { assert_eq!(scalar(21, &bytes[..length]), Err(Errno::EINVAL)); }
        let mut output = [0xa5; 3];
        assert_eq!(codec(21, &bytes, &mut output), Err(Errno::EINVAL));
        assert_eq!(output, [0xa5; 3]);
    }
}

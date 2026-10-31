use wasm_posix_shared::Errno;

use crate::overlay_activation::wire_integer;

const INPUT_BYTES: usize = 64;

#[derive(Clone, Copy)]
struct Identity {
    generation: u64,
    initialized: bool,
}

struct Evidence {
    primary: Option<Identity>,
    target: Option<Identity>,
    source: Option<Identity>,
    primary_target_digest: bool,
    primary_source_digest: bool,
    primary_target_content: bool,
    source_target_content: bool,
}

impl Evidence {
    fn decode(bytes: &[u8]) -> Result<Self, Errno> {
        if bytes.len() != INPUT_BYTES || bytes[56..] != [0; 8] { return Err(Errno::EINVAL); }
        let flags = u32::from_le_bytes(bytes[..4].try_into().map_err(|_| Errno::EINVAL)?);
        let matches = u32::from_le_bytes(bytes[4..8].try_into().map_err(|_| Errno::EINVAL)?);
        if flags & !0x77 != 0 || matches & !15 != 0 || flags & 4 != 0 && flags & 2 == 0 {
            return Err(Errno::EINVAL);
        }
        let mut identities = [None; 3];
        for (index, identity) in identities.iter_mut().enumerate() {
            let start = 8 + index * 16;
            let initialized = flags & (16 << index) != 0;
            if flags & (1 << index) == 0 {
                if initialized || bytes[start..start + 16] != [0; 16] { return Err(Errno::EINVAL); }
                continue;
            }
            if wire_integer(bytes, start).map_err(|_| Errno::EIO)? != 6 { return Err(Errno::EIO); }
            *identity = Some(Identity {
                generation: wire_integer(bytes, start + 8).map_err(|_| Errno::EIO)?, initialized,
            });
        }
        if matches & 5 != 0 && (identities[0].is_none() || identities[1].is_none())
            || matches & 2 != 0 && (identities[0].is_none() || identities[2].is_none())
            || matches & 8 != 0 && (identities[1].is_none() || identities[2].is_none())
        { return Err(Errno::EINVAL); }
        Ok(Self {
            primary: identities[0], target: identities[1], source: identities[2],
            primary_target_digest: matches & 1 != 0,
            primary_source_digest: matches & 2 != 0,
            primary_target_content: matches & 4 != 0,
            source_target_content: matches & 8 != 0,
        })
    }

    fn validate_binding(&self) -> Result<(), Errno> {
        let Some(target) = self.target else { return Ok(()); };
        let Some(source) = self.source else { return Ok(()); };
        let advances = source.initialized && target.initialized
            && target.generation == source.generation + 1;
        let initializes = target.generation == source.generation && self.source_target_content
            && !source.initialized && target.initialized;
        if advances || initializes { Ok(()) } else { Err(Errno::EIO) }
    }

    fn select(&self) -> Result<(u32, bool), Errno> {
        self.validate_binding()?;
        let Some(target) = self.target else {
            return Ok(if self.primary.is_some() { (1, true) } else { (0, false) });
        };
        if self.primary.is_some_and(|primary| primary.generation > target.generation) {
            return Ok((1, true));
        }
        if self.source.is_some() {
            if self.primary_target_digest { return Ok((2, true)); }
            return if self.primary.is_none() || self.primary_source_digest { Ok((3, true)) }
                else { Err(Errno::EIO) };
        }
        if let Some(primary) = self.primary {
            if primary.generation == target.generation {
                if !self.primary_target_content { return Err(Errno::EIO); }
                if primary.initialized && !target.initialized { return Ok((1, true)); }
            }
        }
        Ok((2, !self.primary_target_digest))
    }
}

pub(crate) fn codec(operation: u32, input: &[u8], output: &mut [u8]) -> Result<usize, Errno> {
    let evidence = Evidence::decode(input)?;
    match operation {
        19 => {
            if evidence.primary.is_some() || evidence.target.is_none() { return Err(Errno::EINVAL); }
            evidence.validate_binding()?;
            Ok(0)
        },
        20 => {
            let (choice, repair) = evidence.select()?;
            if output.len() < 8 { return Err(Errno::EINVAL); }
            output[..4].copy_from_slice(&choice.to_le_bytes());
            output[4..8].copy_from_slice(&u32::from(repair).to_le_bytes());
            Ok(8)
        },
        _ => Err(Errno::EINVAL),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(identities: [Option<(f64, f64, bool)>; 3], matches: u32) -> [u8; INPUT_BYTES] {
        let mut bytes = [0; INPUT_BYTES];
        let mut flags = 0u32;
        for (index, identity) in identities.into_iter().enumerate() {
            if let Some((version, generation, initialized)) = identity {
                flags |= 1 << index;
                if initialized { flags |= 16 << index; }
                let start = 8 + 16 * index;
                bytes[start..start + 8].copy_from_slice(&version.to_le_bytes());
                bytes[start + 8..start + 16].copy_from_slice(&generation.to_le_bytes());
            }
        }
        bytes[..4].copy_from_slice(&flags.to_le_bytes());
        bytes[4..8].copy_from_slice(&matches.to_le_bytes());
        bytes
    }

    #[test]
    fn prepared_and_active_selection_preserve_publication_and_initialization_boundaries() {
        let source = Some((6.0, 3.0, true));
        let target = Some((6.0, 4.0, true));
        let latest = Some((6.0, 5.0, true));
        let pending = Some((6.0, 0.0, false));
        let ready = Some((6.0, 0.0, true));
        for (identities, matches, expected) in [
            ([None, None, None], 0, Ok((0, false))),
            ([source, None, None], 0, Ok((1, true))),
            ([source, target, source], 2, Ok((3, true))),
            ([None, target, source], 0, Ok((3, true))),
            ([target, target, source], 5, Ok((2, true))),
            ([source, target, source], 0, Err(Errno::EIO)),
            ([source, target, None], 0, Ok((2, true))),
            ([None, target, None], 0, Ok((2, true))),
            ([target, target, None], 5, Ok((2, false))),
            ([target, target, None], 0, Err(Errno::EIO)),
            ([latest, target, None], 0, Ok((1, true))),
            ([latest, target, source], 0, Ok((1, true))),
            ([pending, ready, None], 4, Ok((2, true))),
            ([ready, pending, None], 4, Ok((1, true))),
            ([pending, ready, pending], 10, Ok((3, true))),
            ([ready, ready, pending], 13, Ok((2, true))),
        ] {
            let bytes = packet(identities, matches);
            let mut output = [0xa5; 9];
            let result = codec(20, &bytes, &mut output);
            match expected {
                Ok((choice, repair)) => {
                    assert_eq!(result, Ok(8));
                    assert_eq!(u32::from_le_bytes(output[..4].try_into().unwrap()), choice);
                    assert_eq!(u32::from_le_bytes(output[4..8].try_into().unwrap()), u32::from(repair));
                    assert_eq!(output[8], 0xa5);
                },
                Err(error) => { assert_eq!(result, Err(error)); assert_eq!(output, [0xa5; 9]); },
            }
        }
    }

    #[test]
    fn invalid_states_and_numeric_boundaries_cannot_authorize_an_older_image() {
        let source = Some((6.0, 3.0, true));
        for generation in [-1.0, 0.5, f64::NAN, f64::INFINITY, (1u64 << 53) as f64] {
            let bytes = packet([source, Some((6.0, generation, true)), None], 0);
            assert_eq!(codec(20, &bytes, &mut [0; 8]), Err(Errno::EIO));
        }
        for version in [1.0, 2.0, 3.0, 4.0, 5.0, 7.0, f64::NAN] {
            for index in 0..3 {
                let mut identities = [source, Some((6.0, 4.0, true)), source];
                identities[index] = Some((version, 3.0, true));
                assert_eq!(codec(20, &packet(identities, 0), &mut [0; 8]), Err(Errno::EIO));
            }
        }
        for (source, target, matches) in [
            ((6.0, 3.0, true), (6.0, 5.0, true), 0),
            ((6.0, 3.0, false), (6.0, 4.0, true), 0),
            ((6.0, 3.0, true), (6.0, 4.0, false), 0),
            ((6.0, 3.0, true), (6.0, 3.0, true), 8),
            ((6.0, 0.0, false), (6.0, 0.0, true), 0),
            ((6.0, ((1u64 << 53) - 1) as f64, true), (6.0, 0.0, true), 0),
        ] {
            assert_eq!(codec(19, &packet([None, Some(target), Some(source)], matches), &mut []), Err(Errno::EIO));
        }
        let maximum = Some((6.0, ((1u64 << 53) - 1) as f64, true));
        assert_eq!(codec(19, &packet([None, maximum, None], 0), &mut []), Ok(0));
    }

    #[test]
    fn malformed_transport_and_short_outputs_preserve_the_destination() {
        let valid = packet([None, Some((6.0, 4.0, true)), Some((6.0, 3.0, true))], 0);
        assert_eq!(codec(19, &valid, &mut []), Ok(0));
        for input in [&valid[..63], &[0; 65][..]] {
            assert_eq!(codec(20, input, &mut [0; 8]), Err(Errno::EINVAL));
        }
        for (offset, bit) in [(0, 8), (0, 128), (4, 1), (4, 2), (4, 4), (4, 16), (8, 1), (56, 1)] {
            let mut damaged = valid;
            damaged[offset] |= bit;
            let mut output = [0xa5; 8];
            assert_eq!(codec(20, &damaged, &mut output), Err(Errno::EINVAL));
            assert_eq!(output, [0xa5; 8]);
        }
        let mut output = [0xa5; 7];
        assert_eq!(codec(20, &valid, &mut output), Err(Errno::EINVAL));
        assert_eq!(output, [0xa5; 7]);
        assert_eq!(codec(19, &packet([None, None, None], 0), &mut []), Err(Errno::EINVAL));
        assert_eq!(codec(21, &valid, &mut [0; 8]), Err(Errno::EINVAL));
    }
}

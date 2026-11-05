use core::fmt;
use wasmparser::{Encoding, Parser, Payload};

pub const ORIGINAL_REFERENCE_SECTION: &str = "kandelo.original-program";
pub const ORIGINAL_REFERENCE_VERSION: u32 = 1;
pub const ORIGINAL_REFERENCE_BYTES: usize = 44;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OriginalProgramReference {
    pub length: u64,
    pub sha256: [u8; 32],
}

impl OriginalProgramReference {
    pub fn encode(self) -> [u8; ORIGINAL_REFERENCE_BYTES] {
        let mut bytes = [0; ORIGINAL_REFERENCE_BYTES];
        bytes[..4].copy_from_slice(&ORIGINAL_REFERENCE_VERSION.to_le_bytes());
        bytes[4..12].copy_from_slice(&self.length.to_le_bytes());
        bytes[12..].copy_from_slice(&self.sha256);
        bytes
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, OriginalReferenceError> {
        let bytes: &[u8; ORIGINAL_REFERENCE_BYTES] = bytes
            .try_into()
            .map_err(|_| OriginalReferenceError::InvalidLength)?;
        let version = u32::from_le_bytes(bytes[..4].try_into().unwrap());
        if version != ORIGINAL_REFERENCE_VERSION {
            return Err(OriginalReferenceError::UnsupportedVersion(version));
        }
        Ok(Self {
            length: u64::from_le_bytes(bytes[4..12].try_into().unwrap()),
            sha256: bytes[12..].try_into().unwrap(),
        })
    }
}

#[derive(Debug)]
pub enum OriginalReferenceError {
    InvalidContainer(wasmparser::BinaryReaderError),
    NotModule,
    DuplicateReference,
    InvalidLength,
    UnsupportedVersion(u32),
}

impl fmt::Display for OriginalReferenceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidContainer(error) => {
                write!(formatter, "invalid original-program container: {error}")
            }
            Self::NotModule => {
                formatter.write_str("original-program reference requires a WebAssembly module")
            }
            Self::DuplicateReference => formatter.write_str("duplicate original-program reference"),
            Self::InvalidLength => formatter.write_str("invalid original-program reference length"),
            Self::UnsupportedVersion(version) => write!(
                formatter,
                "unsupported original-program reference version {version}"
            ),
        }
    }
}

impl core::error::Error for OriginalReferenceError {}

pub fn original_reference(
    input: &[u8],
) -> Result<Option<OriginalProgramReference>, OriginalReferenceError> {
    let mut reference = None;
    for payload in Parser::new(0).parse_all(input) {
        match payload.map_err(OriginalReferenceError::InvalidContainer)? {
            Payload::Version { encoding, .. } if encoding != Encoding::Module => {
                return Err(OriginalReferenceError::NotModule);
            }
            Payload::CustomSection(section) if section.name() == ORIGINAL_REFERENCE_SECTION => {
                if reference.is_some() {
                    return Err(OriginalReferenceError::DuplicateReference);
                }
                reference = Some(OriginalProgramReference::decode(section.data())?);
            }
            _ => {}
        }
    }
    Ok(reference)
}

pub fn matches_original_reference(
    input: &[u8],
    length: u64,
    sha256: &[u8; 32],
) -> Result<bool, OriginalReferenceError> {
    Ok(original_reference(input)?.is_some_and(|reference| {
        reference.length == length && reference.sha256 == *sha256
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;

    fn module(payloads: &[&[u8]]) -> Vec<u8> {
        let mut bytes = b"\0asm\x01\0\0\0".to_vec();
        for payload in payloads {
            let length = 1 + ORIGINAL_REFERENCE_SECTION.len() + payload.len();
            assert!(length < 128);
            bytes.extend_from_slice(&[0, length as u8, ORIGINAL_REFERENCE_SECTION.len() as u8]);
            bytes.extend_from_slice(ORIGINAL_REFERENCE_SECTION.as_bytes());
            bytes.extend_from_slice(payload);
        }
        bytes
    }

    #[test]
    fn wire_bytes_preserve_version_one_and_large_original_lengths() {
        let reference = OriginalProgramReference {
            length: u64::MAX,
            sha256: [42; 32],
        };
        let mut expected = [42; ORIGINAL_REFERENCE_BYTES];
        expected[..4].copy_from_slice(&[1, 0, 0, 0]);
        expected[4..12].fill(255);
        assert_eq!(reference.encode(), expected);
        assert_eq!(
            OriginalProgramReference::decode(&expected).unwrap(),
            reference
        );
        assert_eq!(
            original_reference(&module(&[&expected])).unwrap(),
            Some(reference)
        );
    }

    #[test]
    fn reference_matching_binds_length_digest_and_the_entire_container() {
        let reference = OriginalProgramReference { length: 987_654_321, sha256: [41; 32] };
        let bytes = module(&[&reference.encode()]);
        assert!(matches_original_reference(&bytes, reference.length, &reference.sha256).unwrap());
        assert!(!matches_original_reference(&bytes, reference.length - 1, &reference.sha256).unwrap());
        assert!(!matches_original_reference(&bytes, reference.length, &[42; 32]).unwrap());
        assert!(!matches_original_reference(&module(&[]), reference.length, &reference.sha256).unwrap());
        assert!(matches_original_reference(&module(&[&reference.encode(), &reference.encode()]), reference.length, &reference.sha256).is_err());
        let mut damaged = bytes;
        damaged.extend_from_slice(&[0, 10, 0]);
        assert!(matches_original_reference(&damaged, reference.length, &reference.sha256).is_err());
    }

    #[test]
    fn absent_reference_does_not_invent_original_ownership() {
        assert_eq!(original_reference(&module(&[])).unwrap(), None);
        let mut bytes = module(&[]);
        bytes.extend_from_slice(&[0, 2, 1, b'x']);
        assert_eq!(original_reference(&bytes).unwrap(), None);
    }

    #[test]
    fn every_truncated_and_oversized_reference_is_refused() {
        let bytes = [0; ORIGINAL_REFERENCE_BYTES + 1];
        for length in (0..=bytes.len()).filter(|length| *length != ORIGINAL_REFERENCE_BYTES) {
            assert!(matches!(
                OriginalProgramReference::decode(&bytes[..length]),
                Err(OriginalReferenceError::InvalidLength)
            ));
            assert!(matches!(
                original_reference(&module(&[&bytes[..length]])),
                Err(OriginalReferenceError::InvalidLength)
            ));
        }
    }

    #[test]
    fn unknown_versions_and_duplicate_references_are_not_fallbacks() {
        let mut bytes = OriginalProgramReference {
            length: 8,
            sha256: [1; 32],
        }
        .encode();
        for version in [0, 2, u32::MAX] {
            bytes[..4].copy_from_slice(&version.to_le_bytes());
            assert!(
                matches!(original_reference(&module(&[&bytes])), Err(OriginalReferenceError::UnsupportedVersion(found)) if found == version)
            );
        }
        bytes[..4].copy_from_slice(&ORIGINAL_REFERENCE_VERSION.to_le_bytes());
        assert!(matches!(
            original_reference(&module(&[&bytes, &bytes])),
            Err(OriginalReferenceError::DuplicateReference)
        ));
    }

    #[test]
    fn container_damage_after_a_valid_reference_is_not_ignored() {
        let reference = OriginalProgramReference {
            length: 8,
            sha256: [2; 32],
        }
        .encode();
        let mut bytes = module(&[&reference]);
        bytes.extend_from_slice(&[0, 127, 1]);
        assert!(matches!(
            original_reference(&bytes),
            Err(OriginalReferenceError::InvalidContainer(_))
        ));
        assert!(matches!(
            original_reference(b"not wasm"),
            Err(OriginalReferenceError::InvalidContainer(_))
        ));
    }

    #[test]
    fn component_metadata_cannot_describe_a_process_program() {
        let mut bytes = module(&[&OriginalProgramReference {
            length: 8,
            sha256: [3; 32],
        }
        .encode()]);
        bytes[4..8].copy_from_slice(&[13, 0, 1, 0]);
        assert!(matches!(
            original_reference(&bytes),
            Err(OriginalReferenceError::NotModule)
        ));
    }
}

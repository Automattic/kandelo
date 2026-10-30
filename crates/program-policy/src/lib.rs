#![cfg_attr(any(target_arch = "wasm32", target_arch = "wasm64"), no_std)]

use sha2::{Digest, Sha256};
use wasm_artifact::original_program::{OriginalProgramReference, original_reference};
use wasm_artifact::policy_surface::{
    PolicyReadError, PolicyReadLimits, PolicySurface, read_policy_surface,
};

pub const INSPECTION_VERSION: u32 = 1;
pub const INSPECTION_BYTES: usize = 160;
const MAGIC: &[u8; 8] = b"KDPOL1\0\0";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Inspection {
    source: OriginalProgramReference,
    original: Option<OriginalProgramReference>,
    surface: PolicySurface,
    contract: Option<[u8; 32]>,
    limits: PolicyReadLimits,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InspectionError {
    Policy(PolicyReadError),
    InvalidModule,
    InvalidRecord,
    SourceChanged,
}

impl Inspection {
    pub fn read(source: &[u8], limits: PolicyReadLimits) -> Result<Self, InspectionError> {
        let surface = read_policy_surface(source, limits).map_err(InspectionError::Policy)?;
        let original = original_reference(source).map_err(|_| InspectionError::InvalidModule)?;
        if original.is_some_and(|reference| reference.length < 8) {
            return Err(InspectionError::InvalidModule);
        }
        let contract =
            wasm_artifact::read_custom_section(source, wasm_artifact::ABI_CONTRACT_SECTION)
                .map(|bytes| bytes.try_into().map_err(|_| InspectionError::InvalidModule))
                .transpose()?;
        Ok(Self {
            source: identity(source),
            original,
            surface,
            contract,
            limits,
        })
    }

    pub fn source(&self) -> OriginalProgramReference {
        self.source
    }
    pub fn original(&self) -> Option<OriginalProgramReference> {
        self.original
    }
    pub fn surface(&self) -> PolicySurface {
        self.surface
    }
    pub fn contract(&self) -> Option<[u8; 32]> {
        self.contract
    }
    pub fn limits(&self) -> PolicyReadLimits {
        self.limits
    }

    pub fn verify_source(
        &self,
        source: &[u8],
        limits: PolicyReadLimits,
    ) -> Result<(), InspectionError> {
        if limits != self.limits {
            return Err(InspectionError::InvalidRecord);
        }
        if identity(source) != self.source {
            return Err(InspectionError::SourceChanged);
        }
        Ok(())
    }

    pub fn encode(self) -> [u8; INSPECTION_BYTES] {
        let mut output = [0; INSPECTION_BYTES];
        output[..8].copy_from_slice(MAGIC);
        output[8..12].copy_from_slice(&INSPECTION_VERSION.to_le_bytes());
        let flags = u32::from(self.surface.mixed_memory_widths)
            | (u32::from(self.surface.has_fork_surface) << 1)
            | (u32::from(self.surface.contains_legacy_asyncify) << 2)
            | (u32::from(self.original.is_some()) << 3)
            | (u32::from(self.surface.abi_version.is_some()) << 4)
            | (u32::from(self.contract.is_some()) << 5)
            | (u32::from(self.surface.imports_kernel_fork) << 6);
        output[12..16].copy_from_slice(&flags.to_le_bytes());
        output[16..24].copy_from_slice(&self.source.length.to_le_bytes());
        output[24..56].copy_from_slice(&self.source.sha256);
        output[56..60].copy_from_slice(&u32::from(self.surface.pointer_width).to_le_bytes());
        output[60..64].copy_from_slice(&self.surface.abi_version.unwrap_or(0).to_le_bytes());
        if let Some(contract) = self.contract {
            output[64..96].copy_from_slice(&contract);
        }
        if let Some(original) = self.original {
            output[96..104].copy_from_slice(&original.length.to_le_bytes());
            output[104..136].copy_from_slice(&original.sha256);
        }
        output[136..144].copy_from_slice(&(self.limits.metadata_bytes as u64).to_le_bytes());
        output[144..152].copy_from_slice(&(self.limits.work_items as u64).to_le_bytes());
        output
    }

    pub fn decode(input: &[u8]) -> Result<Self, InspectionError> {
        if input.len() != INSPECTION_BYTES
            || &input[..8] != MAGIC
            || input[8..12] != INSPECTION_VERSION.to_le_bytes()
            || input[152..].iter().any(|byte| *byte != 0)
        {
            return Err(InspectionError::InvalidRecord);
        }
        let word = |offset| u32::from_le_bytes(input[offset..offset + 4].try_into().unwrap());
        let length = |offset| u64::from_le_bytes(input[offset..offset + 8].try_into().unwrap());
        let flags = word(12);
        if flags & !127 != 0
            || !matches!(word(56), 4 | 8)
            || length(16) < 8
            || flags & 16 == 0 && word(60) != 0
            || flags & 32 == 0 && input[64..96].iter().any(|byte| *byte != 0)
            || flags & 8 == 0 && input[96..136].iter().any(|byte| *byte != 0)
            || flags & 8 != 0 && length(96) < 8
        {
            return Err(InspectionError::InvalidRecord);
        }
        let metadata_bytes =
            usize::try_from(length(136)).map_err(|_| InspectionError::InvalidRecord)?;
        let work_items =
            usize::try_from(length(144)).map_err(|_| InspectionError::InvalidRecord)?;
        if metadata_bytes == 0 || work_items == 0 {
            return Err(InspectionError::InvalidRecord);
        }
        Ok(Self {
            source: OriginalProgramReference {
                length: length(16),
                sha256: input[24..56].try_into().unwrap(),
            },
            original: (flags & 8 != 0).then(|| OriginalProgramReference {
                length: length(96),
                sha256: input[104..136].try_into().unwrap(),
            }),
            surface: PolicySurface {
                pointer_width: word(56) as u8,
                abi_version: (flags & 16 != 0).then(|| word(60) as i32),
                mixed_memory_widths: flags & 1 != 0,
                has_fork_surface: flags & 2 != 0,
                imports_kernel_fork: flags & 64 != 0,
                contains_legacy_asyncify: flags & 4 != 0,
            },
            contract: (flags & 32 != 0).then(|| input[64..96].try_into().unwrap()),
            limits: PolicyReadLimits {
                metadata_bytes,
                work_items,
            },
        })
    }
}

fn identity(source: &[u8]) -> OriginalProgramReference {
    let mut digest = Sha256::new();
    for chunk in source.chunks(64 * 1024) {
        digest.update(chunk);
    }
    OriginalProgramReference {
        length: source.len() as u64,
        sha256: digest.finalize().into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SOURCE: &[u8] = include_bytes!("../../../abi/program-fixtures/v55/raw-fork.wasm");
    fn limits() -> PolicyReadLimits {
        PolicyReadLimits {
            metadata_bytes: 1024 * 1024,
            work_items: 1_000_000,
        }
    }

    #[test]
    fn inspection_round_trips_exact_source_policy_and_limits() {
        let inspection = Inspection::read(SOURCE, limits()).unwrap();
        assert_eq!(inspection.surface().abi_version, Some(55));
        assert_eq!(inspection.source(), identity(SOURCE));
        assert_eq!(inspection.original(), None);
        assert_eq!(Inspection::decode(&inspection.encode()), Ok(inspection));
        assert_eq!(inspection.verify_source(SOURCE, limits()), Ok(()));
    }

    #[test]
    fn refuses_changed_source_and_inspection_budgets() {
        let inspection = Inspection::read(SOURCE, limits()).unwrap();
        let mut source = SOURCE.to_vec();
        source[10] ^= 1;
        assert_eq!(
            inspection.verify_source(&source, limits()),
            Err(InspectionError::SourceChanged)
        );
        let mut changed = limits();
        changed.work_items -= 1;
        assert_eq!(
            inspection.verify_source(SOURCE, changed),
            Err(InspectionError::InvalidRecord)
        );
    }

    #[test]
    fn refuses_noncanonical_record_fields() {
        let encoded = Inspection::read(SOURCE, limits()).unwrap().encode();
        assert_eq!(
            Inspection::decode(&encoded[..159]),
            Err(InspectionError::InvalidRecord)
        );
        for (offset, value) in [(0, 0), (8, 2), (12, 128), (56, 7), (96, 1), (152, 1)] {
            let mut changed = encoded;
            changed[offset] = value;
            assert_eq!(
                Inspection::decode(&changed),
                Err(InspectionError::InvalidRecord)
            );
        }
    }

    #[test]
    fn refuses_malformed_modules_and_metadata_exhaustion() {
        assert!(Inspection::read(b"not wasm", limits()).is_err());
        assert!(Inspection::read(b"\0asm\x01\0\0\0\x01\x01\xff", limits()).is_err());
        assert_eq!(
            Inspection::read(
                SOURCE,
                PolicyReadLimits {
                    metadata_bytes: 1,
                    work_items: 1
                }
            ),
            Err(InspectionError::Policy(PolicyReadError::MetadataLimit))
        );
    }

    #[test]
    fn refuses_short_originals_before_reporting_an_encodable_inspection() {
        let name = wasm_artifact::original_program::ORIGINAL_REFERENCE_SECTION.as_bytes();
        for length in 0..=8 {
            let mut source = SOURCE.to_vec();
            let reference = OriginalProgramReference {
                length,
                sha256: [1; 32],
            }
            .encode();
            source.extend_from_slice(&[
                0,
                (1 + name.len() + reference.len()) as u8,
                name.len() as u8,
            ]);
            source.extend_from_slice(name);
            source.extend_from_slice(&reference);
            let inspected = Inspection::read(&source, limits());
            if length < 8 {
                assert_eq!(inspected, Err(InspectionError::InvalidModule));
            } else {
                let inspected = inspected.unwrap();
                assert_eq!(Inspection::decode(&inspected.encode()), Ok(inspected));
            }
        }
    }

    #[test]
    fn memory64_and_absent_optional_fields_round_trip() {
        let source = b"\0asm\x01\0\0\0\x05\x03\x01\x04\x00";
        let inspected = Inspection::read(source, limits()).unwrap();
        assert_eq!(inspected.surface().pointer_width, 8);
        assert_eq!(inspected.surface().abi_version, None);
        assert_eq!(inspected.contract(), None);
        assert_eq!(Inspection::decode(&inspected.encode()), Ok(inspected));
        let mut changed = inspected.encode();
        changed[60] = 55;
        assert_eq!(
            Inspection::decode(&changed),
            Err(InspectionError::InvalidRecord)
        );
        let mut changed = inspected.encode();
        changed[64] = 1;
        assert_eq!(
            Inspection::decode(&changed),
            Err(InspectionError::InvalidRecord)
        );
    }
}

use sha2::{Digest, Sha256};
use kandelo_program_policy::{Inspection, InspectionError};
use wasm_artifact::original_program::{OriginalProgramReference, original_reference};
use wasm_posix_shared::{Errno, platform_limits};

pub const PREPARATION_RECEIPT_VERSION: u32 = 1;
pub const PREPARATION_RECEIPT_BYTES: usize = 216;
const RECEIPT_MAGIC: &[u8; 8] = b"KDPRG1\0\0";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InitialPreparation { NotNeeded, Required }

pub fn initial_preparation(source: &[u8], inspection: &Inspection, profile: PreparationProfile, limits: PreparationLimits) -> Result<InitialPreparation, Errno> {
    limits.validate()?;
    profile.digest()?;
    if source.len() as u64 > limits.source_bytes { return Err(Errno::EFBIG); }
    let surface = checked_inspection(source, inspection, &profile, limits, false)?;
    Ok(if surface.imports_kernel_fork && !surface.has_fork_surface { InitialPreparation::Required } else { InitialPreparation::NotNeeded })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreparationProfile {
    pub preparer_sha256: [u8; 32],
    pub optimizer_sha256: Option<[u8; 32]>,
    pub options_sha256: [u8; 32],
    pub dependency_closure_sha256: [u8; 32],
    pub program_contract_sha256: [u8; 32],
    pub program_abi: u32,
}

impl PreparationProfile {
    fn digest(&self) -> Result<[u8; 32], Errno> {
        if self.program_abi == 0 || self.program_abi > i32::MAX as u32 || [self.preparer_sha256, self.options_sha256,
            self.dependency_closure_sha256, self.program_contract_sha256].contains(&[0; 32])
            || self.optimizer_sha256 == Some([0; 32]) {
            return Err(Errno::EINVAL);
        }
        let mut digest = Sha256::new();
        digest.update(b"kandelo-program-preparation-profile-v1\0");
        digest.update(self.program_abi.to_le_bytes());
        digest.update(self.program_contract_sha256);
        digest.update(self.preparer_sha256);
        digest.update([u8::from(self.optimizer_sha256.is_some())]);
        if let Some(optimizer) = self.optimizer_sha256 { digest.update(optimizer); }
        digest.update(self.options_sha256);
        digest.update(self.dependency_closure_sha256);
        Ok(digest.finalize().into())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreparationLimits {
    pub source_bytes: u64,
    pub original_bytes: u64,
    pub output_bytes: u64,
    pub metadata_bytes: usize,
    pub metadata_work_items: usize,
}

impl PreparationLimits {
    fn validate(self) -> Result<(), Errno> {
        if self.metadata_bytes == 0 || self.metadata_work_items == 0
            || self.metadata_bytes > platform_limits::MAX_REPORTABLE_TRANSFER_BYTES
            || self.metadata_work_items > platform_limits::MAX_REPORTABLE_TRANSFER_BYTES
            || [self.source_bytes, self.original_bytes, self.output_bytes].iter().any(|limit|
            *limit == 0 || *limit > platform_limits::MAX_REPORTABLE_TRANSFER_BYTES as u64) {
            return Err(Errno::EINVAL);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreparationPlan {
    source: OriginalProgramReference,
    original: OriginalProgramReference,
    profile: PreparationProfile,
    profile_sha256: [u8; 32],
    key: [u8; 32],
    limits: PreparationLimits,
    pointer_width: u8,
    original_is_source: bool,
}

fn content_identity(bytes: &[u8]) -> OriginalProgramReference {
    let mut digest = Sha256::new();
    for chunk in bytes.chunks(64 * 1024) { digest.update(chunk); }
    OriginalProgramReference { length: bytes.len() as u64, sha256: digest.finalize().into() }
}

fn check_program(bytes: &[u8], profile: &PreparationProfile, raw: bool, limits: PreparationLimits) -> Result<wasm_artifact::policy_surface::PolicySurface, Errno> {
    use wasm_artifact::policy_surface::{PolicyReadError, PolicyReadLimits, read_policy_surface};
    let surface = read_policy_surface(bytes, PolicyReadLimits {
        metadata_bytes: limits.metadata_bytes, work_items: limits.metadata_work_items,
    }).map_err(|error| match error {
        PolicyReadError::InvalidLimits => Errno::EINVAL,
        PolicyReadError::InvalidModule => Errno::ENOEXEC,
        PolicyReadError::MetadataLimit | PolicyReadError::Allocation => Errno::ENOMEM,
        PolicyReadError::WorkLimit => Errno::E2BIG,
    })?;
    check_surface(surface, wasm_artifact::facts::read_custom_section(bytes, wasm_artifact::ABI_CONTRACT_SECTION), profile, raw)
}

fn check_surface(surface: wasm_artifact::policy_surface::PolicySurface, contract: Option<&[u8]>, profile: &PreparationProfile, raw: bool) -> Result<wasm_artifact::policy_surface::PolicySurface, Errno> {
    if surface.mixed_memory_widths || surface.contains_legacy_asyncify || (raw && surface.has_fork_surface) {
        return Err(Errno::ENOEXEC);
    }
    if surface.abi_version != Some(profile.program_abi as i32)
        || contract != Some(profile.program_contract_sha256.as_slice()) {
            return Err(Errno::ENOEXEC);
        }
    Ok(surface)
}

fn checked_inspection(source: &[u8], inspection: &Inspection, profile: &PreparationProfile, limits: PreparationLimits, raw: bool) -> Result<wasm_artifact::policy_surface::PolicySurface, Errno> {
    inspection.verify_source(source, wasm_artifact::policy_surface::PolicyReadLimits {
        metadata_bytes: limits.metadata_bytes, work_items: limits.metadata_work_items,
    }).map_err(|error| match error {
        InspectionError::SourceChanged => Errno::ETXTBSY,
        _ => Errno::EINVAL,
    })?;
    let contract = inspection.contract();
    check_surface(inspection.surface(), contract.as_ref().map(|value| value.as_slice()), profile, raw)
}

impl PreparationPlan {
    pub fn from_source(source: &[u8], profile: PreparationProfile, limits: PreparationLimits) -> Result<Self, Errno> {
        limits.validate()?;
        let profile_sha256 = profile.digest()?;
        if source.len() as u64 > limits.source_bytes { return Err(Errno::EFBIG); }
        let surface = check_program(source, &profile, false, limits)?;
        let reference = original_reference(source).map_err(|_| Errno::ENOEXEC)?;
        Self::from_parts(content_identity(source), reference, surface, profile, profile_sha256, limits)
    }

    pub fn from_inspected_source(source: &[u8], inspection: &Inspection, profile: PreparationProfile, limits: PreparationLimits) -> Result<Self, Errno> {
        limits.validate()?;
        let profile_sha256 = profile.digest()?;
        if source.len() as u64 > limits.source_bytes { return Err(Errno::EFBIG); }
        let surface = checked_inspection(source, inspection, &profile, limits, false)?;
        Self::from_parts(inspection.source(), inspection.original(), surface, profile, profile_sha256, limits)
    }

    fn from_parts(source_identity: OriginalProgramReference, reference: Option<OriginalProgramReference>, surface: wasm_artifact::policy_surface::PolicySurface,
        profile: PreparationProfile, profile_sha256: [u8; 32], limits: PreparationLimits) -> Result<Self, Errno> {
        let original_is_source = reference.is_none();
        if original_is_source && surface.has_fork_surface { return Err(Errno::ENOEXEC); }
        let original = reference.unwrap_or(source_identity);
        if original.length < 8 { return Err(Errno::ENOEXEC); }
        let mut key = Sha256::new();
        key.update(b"kandelo-program-preparation-key-v1\0");
        key.update(profile_sha256);
        key.update(source_identity.length.to_le_bytes());
        key.update(source_identity.sha256);
        key.update(original.length.to_le_bytes());
        key.update(original.sha256);
        Ok(Self { source: source_identity, original, profile, profile_sha256, key: key.finalize().into(), limits,
            pointer_width: surface.pointer_width, original_is_source })
    }

    pub fn cache_key(&self) -> [u8; 32] { self.key }

    pub fn output_limit(&self) -> u64 { self.limits.output_bytes }

    pub fn original(&self) -> OriginalProgramReference { self.original }

    pub fn original_is_source(&self) -> bool { self.original_is_source }

    pub fn original_for_preparation(&self) -> Result<OriginalProgramReference, Errno> {
        if self.original.length > self.limits.original_bytes { return Err(Errno::EFBIG); }
        Ok(self.original)
    }

    pub fn verify_source(&self, source: &[u8]) -> Result<(), Errno> {
        if source.len() as u64 > self.limits.source_bytes { return Err(Errno::EFBIG); }
        if content_identity(source) != self.source { return Err(Errno::ETXTBSY); }
        Ok(())
    }

    pub fn verify_original(&self, original: &[u8]) -> Result<(), Errno> {
        self.original_for_preparation()?;
        if original.len() as u64 > self.limits.original_bytes { return Err(Errno::EFBIG); }
        if content_identity(original) != self.original { return Err(Errno::EIO); }
        if check_program(original, &self.profile, true, self.limits)?.pointer_width != self.pointer_width { return Err(Errno::ENOEXEC); }
        if original_reference(original).map_err(|_| Errno::ENOEXEC)?.is_some() { return Err(Errno::ENOEXEC); }
        Ok(())
    }

    pub fn verify_output(&self, output: &[u8]) -> Result<PreparationReceipt, Errno> {
        if output.len() as u64 > self.limits.output_bytes { return Err(Errno::EFBIG); }
        if check_program(output, &self.profile, false, self.limits)?.pointer_width != self.pointer_width { return Err(Errno::ENOEXEC); }
        if original_reference(output).map_err(|_| Errno::ENOEXEC)? != Some(self.original) { return Err(Errno::ENOEXEC); }
        Ok(PreparationReceipt { source: self.source, original: self.original, profile_sha256: self.profile_sha256,
            output: content_identity(output), key: self.key, pointer_width: self.pointer_width })
    }

    pub fn verify_original_inspected(&self, original: &[u8], inspection: &Inspection) -> Result<(), Errno> {
        self.original_for_preparation()?;
        if original.len() as u64 > self.limits.original_bytes { return Err(Errno::EFBIG); }
        if content_identity(original) != self.original { return Err(Errno::EIO); }
        if checked_inspection(original, inspection, &self.profile, self.limits, true)?.pointer_width != self.pointer_width
            || inspection.original().is_some() { return Err(Errno::ENOEXEC); }
        Ok(())
    }

    pub fn verify_output_inspected(&self, output: &[u8], inspection: &Inspection) -> Result<PreparationReceipt, Errno> {
        if output.len() as u64 > self.limits.output_bytes { return Err(Errno::EFBIG); }
        if checked_inspection(output, inspection, &self.profile, self.limits, false)?.pointer_width != self.pointer_width
            || inspection.original() != Some(self.original) { return Err(Errno::ENOEXEC); }
        Ok(PreparationReceipt { source: self.source, original: self.original, profile_sha256: self.profile_sha256,
            output: inspection.source(), key: self.key, pointer_width: self.pointer_width })
    }

    pub fn verify_cached_output_inspected(&self, output: &[u8], receipt: &[u8], inspection: &Inspection) -> Result<PreparationReceipt, Errno> {
        let recorded = self.checked_receipt(output, receipt)?;
        let actual = self.verify_output_inspected(output, inspection)?;
        if actual != recorded { return Err(Errno::EIO); }
        Ok(actual)
    }

    pub fn verify_cached_output(&self, output: &[u8], receipt: &[u8]) -> Result<PreparationReceipt, Errno> {
        let recorded = self.checked_receipt(output, receipt)?;
        let actual = self.verify_output(output)?;
        if actual != recorded { return Err(Errno::EIO); }
        Ok(actual)
    }

    fn checked_receipt(&self, output: &[u8], receipt: &[u8]) -> Result<PreparationReceipt, Errno> {
        let recorded = PreparationReceipt::decode(receipt)?;
        if recorded.source != self.source || recorded.original != self.original || recorded.profile_sha256 != self.profile_sha256
            || recorded.key != self.key || recorded.pointer_width != self.pointer_width {
            return Err(Errno::ENOEXEC);
        }
        if recorded.output.length > self.limits.output_bytes { return Err(Errno::EFBIG); }
        if output.len() as u64 != recorded.output.length { return Err(Errno::EIO); }
        Ok(recorded)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreparationReceipt {
    source: OriginalProgramReference,
    original: OriginalProgramReference,
    profile_sha256: [u8; 32],
    output: OriginalProgramReference,
    key: [u8; 32],
    pointer_width: u8,
}

impl PreparationReceipt {
    pub fn encode(self) -> [u8; PREPARATION_RECEIPT_BYTES] {
        let mut bytes = [0; PREPARATION_RECEIPT_BYTES];
        bytes[..8].copy_from_slice(RECEIPT_MAGIC);
        bytes[8..12].copy_from_slice(&PREPARATION_RECEIPT_VERSION.to_le_bytes());
        bytes[16..24].copy_from_slice(&self.source.length.to_le_bytes());
        bytes[24..56].copy_from_slice(&self.source.sha256);
        bytes[56..64].copy_from_slice(&self.original.length.to_le_bytes());
        bytes[64..96].copy_from_slice(&self.original.sha256);
        bytes[96..128].copy_from_slice(&self.profile_sha256);
        bytes[128..136].copy_from_slice(&self.output.length.to_le_bytes());
        bytes[136..168].copy_from_slice(&self.output.sha256);
        bytes[168..200].copy_from_slice(&self.key);
        bytes[200..204].copy_from_slice(&u32::from(self.pointer_width).to_le_bytes());
        bytes
    }

    fn decode(bytes: &[u8]) -> Result<Self, Errno> {
        if bytes.len() != PREPARATION_RECEIPT_BYTES || &bytes[..8] != RECEIPT_MAGIC
            || u32::from_le_bytes(bytes[8..12].try_into().unwrap()) != PREPARATION_RECEIPT_VERSION
            || bytes[12..16].iter().chain(&bytes[204..]).any(|byte| *byte != 0) {
            return Err(Errno::EINVAL);
        }
        let pointer_width = u32::from_le_bytes(bytes[200..204].try_into().unwrap());
        if pointer_width != 4 && pointer_width != 8 { return Err(Errno::EINVAL); }
        Ok(Self {
            source: OriginalProgramReference { length: u64::from_le_bytes(bytes[16..24].try_into().unwrap()), sha256: bytes[24..56].try_into().unwrap() },
            original: OriginalProgramReference { length: u64::from_le_bytes(bytes[56..64].try_into().unwrap()), sha256: bytes[64..96].try_into().unwrap() },
            profile_sha256: bytes[96..128].try_into().unwrap(),
            output: OriginalProgramReference { length: u64::from_le_bytes(bytes[128..136].try_into().unwrap()), sha256: bytes[136..168].try_into().unwrap() },
            key: bytes[168..200].try_into().unwrap(), pointer_width: pointer_width as u8,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ORIGINAL: &[u8] = include_bytes!("../../../abi/program-fixtures/v55/raw-fork.wasm");

    fn profile() -> PreparationProfile {
        PreparationProfile { preparer_sha256: [1; 32], optimizer_sha256: None, options_sha256: [2; 32],
            dependency_closure_sha256: [3; 32], program_contract_sha256: wasm_artifact::facts::read_custom_section(
                ORIGINAL, wasm_artifact::ABI_CONTRACT_SECTION).unwrap().try_into().unwrap(),
            program_abi: 55 }
    }

    fn limits() -> PreparationLimits {
        PreparationLimits { source_bytes: 4 * 1024 * 1024, original_bytes: 4 * 1024 * 1024,
            output_bytes: 4 * 1024 * 1024, metadata_bytes: 1024 * 1024, metadata_work_items: 1_000_000 }
    }

    fn length(bytes: &mut alloc::vec::Vec<u8>, mut value: usize) {
        loop {
            let next = (value & 127) as u8;
            value >>= 7;
            bytes.push(next | if value == 0 { 0 } else { 128 });
            if value == 0 { return; }
        }
    }

    fn append_section(module: &[u8], name: &str, data: &[u8]) -> alloc::vec::Vec<u8> {
        let mut payload = alloc::vec::Vec::new();
        length(&mut payload, name.len());
        payload.extend_from_slice(name.as_bytes());
        payload.extend_from_slice(data);
        let mut output = module.to_vec();
        output.push(0);
        length(&mut output, payload.len());
        output.extend_from_slice(&payload);
        output
    }

    fn bound_output() -> alloc::vec::Vec<u8> {
        append_section(ORIGINAL, wasm_artifact::original_program::ORIGINAL_REFERENCE_SECTION, &content_identity(ORIGINAL).encode())
    }

    fn program_with_memory(memory64: bool) -> alloc::vec::Vec<u8> {
        let mut module = b"\0asm\x01\0\0\0".to_vec();
        let mut exports = alloc::vec![1, 13];
        exports.extend_from_slice(b"__abi_version");
        exports.extend_from_slice(&[0, 0]);
        for (section_id, contents) in [
            (1, alloc::vec![1, 0x60, 0, 1, 0x7f]),
            (3, alloc::vec![1, 0]),
            (5, alloc::vec![1, if memory64 { 4 } else { 0 }, 1]),
            (7, exports),
            (10, alloc::vec![1, 4, 0, 0x41, 55, 0x0b]),
        ] {
            module.push(section_id);
            length(&mut module, contents.len());
            module.extend_from_slice(&contents);
        }
        append_section(&module, wasm_artifact::ABI_CONTRACT_SECTION, &profile().program_contract_sha256)
    }

    #[test]
    fn original_target_and_repreparation_bind_distinct_exact_sources() {
        let first = PreparationPlan::from_source(ORIGINAL, profile(), limits()).unwrap();
        assert!(first.original_is_source());
        first.verify_original(ORIGINAL).unwrap();
        first.verify_source(ORIGINAL).unwrap();
        let output = bound_output();
        let second = PreparationPlan::from_source(&output, profile(), limits()).unwrap();
        assert!(!second.original_is_source());
        assert_eq!(first.original(), second.original());
        assert_ne!(first.cache_key(), second.cache_key());
        second.verify_original(ORIGINAL).unwrap();
        assert_eq!(second.verify_source(ORIGINAL), Err(Errno::ETXTBSY));
    }

    #[test]
    fn every_toolchain_and_dependency_input_invalidates_the_key() {
        let baseline = PreparationPlan::from_source(ORIGINAL, profile(), limits()).unwrap().cache_key();
        for component in 0..4 {
            let mut changed = profile();
            match component {
                0 => changed.preparer_sha256[0] ^= 1,
                1 => changed.optimizer_sha256 = Some([7; 32]),
                2 => changed.options_sha256[0] ^= 1,
                _ => changed.dependency_closure_sha256[0] ^= 1,
            }
            assert_ne!(PreparationPlan::from_source(ORIGINAL, changed, limits()).unwrap().cache_key(), baseline);
        }
        let changed_source = append_section(ORIGINAL, "compiler-facts-probe", b"new facts");
        assert_ne!(PreparationPlan::from_source(&changed_source, profile(), limits()).unwrap().cache_key(), baseline);
    }

    #[test]
    fn missing_tool_identities_and_invalid_budgets_fail_before_source_inspection() {
        for component in 0..5 {
            let mut changed = profile();
            match component {
                0 => changed.preparer_sha256 = [0; 32],
                1 => changed.optimizer_sha256 = Some([0; 32]),
                2 => changed.options_sha256 = [0; 32],
                3 => changed.dependency_closure_sha256 = [0; 32],
                _ => changed.program_contract_sha256 = [0; 32],
            }
            assert_eq!(PreparationPlan::from_source(b"not wasm", changed, limits()), Err(Errno::EINVAL));
        }
        for value in [0, u64::MAX] {
            let mut changed = limits();
            changed.source_bytes = value;
            assert_eq!(PreparationPlan::from_source(ORIGINAL, profile(), changed), Err(Errno::EINVAL));
        }
    }

    #[test]
    fn mismatched_program_abi_or_contract_cannot_be_repaired_by_preparation() {
        let mut changed = profile();
        changed.program_abi += 1;
        assert_eq!(PreparationPlan::from_source(ORIGINAL, changed, limits()), Err(Errno::ENOEXEC));
        changed = profile();
        changed.program_contract_sha256[0] ^= 1;
        assert_eq!(PreparationPlan::from_source(ORIGINAL, changed, limits()), Err(Errno::ENOEXEC));
        assert_eq!(PreparationPlan::from_source(b"\0asm\x01\0\0\0", profile(), limits()), Err(Errno::ENOEXEC));
    }

    #[test]
    fn metadata_limits_are_validated_and_resource_refusals_keep_their_errno() {
        for value in [0, platform_limits::MAX_REPORTABLE_TRANSFER_BYTES + 1] {
            let mut changed = limits();
            changed.metadata_bytes = value;
            assert_eq!(PreparationPlan::from_source(b"not wasm", profile(), changed), Err(Errno::EINVAL));
            changed = limits();
            changed.metadata_work_items = value;
            assert_eq!(PreparationPlan::from_source(b"not wasm", profile(), changed), Err(Errno::EINVAL));
        }
        let mut changed = limits();
        changed.metadata_bytes = wasm_artifact::policy_surface::POLICY_TYPE_SCRATCH_BYTES;
        assert_eq!(PreparationPlan::from_source(ORIGINAL, profile(), changed), Err(Errno::ENOMEM));
        changed = limits();
        changed.metadata_work_items = 1;
        assert_eq!(PreparationPlan::from_source(ORIGINAL, profile(), changed), Err(Errno::E2BIG));
        assert!(PreparationPlan::from_source(ORIGINAL, profile(), limits()).is_ok());
    }

    #[test]
    fn large_borrowed_output_sections_do_not_consume_another_metadata_catalog() {
        let source = program_with_memory(false);
        let mut changed = limits();
        changed.metadata_bytes = wasm_artifact::policy_surface::POLICY_TYPE_SCRATCH_BYTES + 128;
        let plan = PreparationPlan::from_source(&source, profile(), changed).unwrap();
        let normal = PreparationPlan::from_source(&source, profile(), limits()).unwrap();
        assert_eq!(plan.cache_key(), normal.cache_key());
        plan.verify_original(&source).unwrap();
        let output = append_section(&source, wasm_artifact::original_program::ORIGINAL_REFERENCE_SECTION, &content_identity(&source).encode());
        let output = append_section(&output, "retained-debug-data", &alloc::vec![0; 2 * 1024 * 1024]);
        let receipt = plan.verify_output(&output).unwrap();
        assert_eq!(plan.verify_cached_output(&output, &receipt.encode()).unwrap(), receipt);
        assert_eq!(PreparationPlan::from_source(b"\0asm\x0d\0\x01\0", profile(), changed), Err(Errno::ENOEXEC));
    }

    #[test]
    fn raw_fork_surface_without_an_original_reference_is_not_reinstrumented() {
        let instrumented = append_section(ORIGINAL, wasm_posix_shared::abi::WPK_FORK_CAPABILITIES_SECTION, &[1, 2]);
        assert_eq!(PreparationPlan::from_source(&instrumented, profile(), limits()), Err(Errno::ENOEXEC));
    }

    #[test]
    fn preparation_cannot_change_the_source_memory_data_model() {
        let source = program_with_memory(true);
        let plan = PreparationPlan::from_source(&source, profile(), limits()).unwrap();
        plan.verify_original(&source).unwrap();
        let valid = append_section(&source, wasm_artifact::original_program::ORIGINAL_REFERENCE_SECTION, &plan.original().encode());
        plan.verify_output(&valid).unwrap();
        let wrong_width = append_section(&program_with_memory(false), wasm_artifact::original_program::ORIGINAL_REFERENCE_SECTION, &plan.original().encode());
        assert_eq!(plan.verify_output(&wrong_width), Err(Errno::ENOEXEC));
    }

    #[test]
    fn mixed_memory_widths_do_not_form_a_preparation_source() {
        let module = program_with_memory(false);
        let prefix = module.windows(5).position(|bytes| bytes == [5, 3, 1, 0, 1]).unwrap();
        let mut mixed = module[..prefix].to_vec();
        mixed.extend_from_slice(&[5, 5, 2, 0, 1, 4, 1]);
        mixed.extend_from_slice(&module[prefix + 5..]);
        assert_eq!(PreparationPlan::from_source(&mixed, profile(), limits()), Err(Errno::ENOEXEC));
    }

    #[test]
    fn source_original_and_output_budgets_are_independent() {
        let mut smaller = limits();
        smaller.source_bytes = ORIGINAL.len() as u64 - 1;
        assert_eq!(PreparationPlan::from_source(ORIGINAL, profile(), smaller), Err(Errno::EFBIG));
        smaller = limits();
        smaller.original_bytes = ORIGINAL.len() as u64 - 1;
        let plan = PreparationPlan::from_source(&bound_output(), profile(), smaller).unwrap();
        assert_eq!(plan.original_for_preparation(), Err(Errno::EFBIG));
        assert_eq!(plan.verify_original(ORIGINAL), Err(Errno::EFBIG));
        smaller = limits();
        smaller.output_bytes = 8;
        let plan = PreparationPlan::from_source(ORIGINAL, profile(), smaller).unwrap();
        assert_eq!(plan.verify_output(&bound_output()), Err(Errno::EFBIG));
    }

    #[test]
    fn refuses_missing_changed_duplicate_and_nonraw_original_bindings() {
        let plan = PreparationPlan::from_source(ORIGINAL, profile(), limits()).unwrap();
        assert_eq!(plan.verify_original(&[]), Err(Errno::EIO));
        let mut changed = ORIGINAL.to_vec();
        changed[0] ^= 1;
        assert_eq!(plan.verify_original(&changed), Err(Errno::EIO));
        assert_eq!(plan.verify_output(ORIGINAL), Err(Errno::ENOEXEC));
        let bound = bound_output();
        let duplicate = append_section(&bound, wasm_artifact::original_program::ORIGINAL_REFERENCE_SECTION, &plan.original().encode());
        assert_eq!(plan.verify_output(&duplicate), Err(Errno::ENOEXEC));
        let nested = append_section(ORIGINAL, wasm_artifact::original_program::ORIGINAL_REFERENCE_SECTION, &content_identity(&bound).encode());
        let nested_plan = PreparationPlan::from_source(&nested, profile(), limits()).unwrap();
        assert_eq!(nested_plan.verify_original(&bound), Err(Errno::ENOEXEC));
    }

    #[test]
    fn cached_receipt_is_versioned_fixed_size_and_bound_to_actual_output() {
        let plan = PreparationPlan::from_source(ORIGINAL, profile(), limits()).unwrap();
        let output = bound_output();
        let receipt = plan.verify_output(&output).unwrap();
        let encoded = receipt.encode();
        assert_eq!(encoded.len(), PREPARATION_RECEIPT_BYTES);
        assert_eq!(PreparationReceipt::decode(&encoded).unwrap(), receipt);
        assert_eq!(plan.verify_cached_output(&output, &encoded).unwrap(), receipt);
        for index in 0..encoded.len() {
            let mut changed = encoded;
            changed[index] ^= 1;
            assert!(plan.verify_cached_output(&output, &changed).is_err(), "accepted mutated receipt byte {index}");
        }
        for length in 0..encoded.len() { assert_eq!(PreparationReceipt::decode(&encoded[..length]), Err(Errno::EINVAL)); }
        assert_eq!(PreparationReceipt::decode(&[0; PREPARATION_RECEIPT_BYTES + 1]), Err(Errno::EINVAL));
    }

    #[test]
    fn cached_output_is_never_accepted_by_length_or_claimed_reference_alone() {
        let plan = PreparationPlan::from_source(ORIGINAL, profile(), limits()).unwrap();
        let output = append_section(&bound_output(), "test-payload", b"unchanged");
        let receipt = plan.verify_output(&output).unwrap().encode();
        let mut changed = output.clone();
        *changed.last_mut().unwrap() ^= 1;
        assert_eq!(plan.verify_cached_output(&changed, &receipt), Err(Errno::EIO));
        assert_eq!(plan.verify_cached_output(&output[..output.len() - 1], &receipt), Err(Errno::EIO));
        let mut changed_profile = profile();
        changed_profile.preparer_sha256[0] ^= 1;
        let different = PreparationPlan::from_source(ORIGINAL, changed_profile, limits()).unwrap();
        assert_eq!(different.verify_cached_output(&output, &receipt), Err(Errno::ENOEXEC));
        let mut tighter_limits = limits();
        tighter_limits.output_bytes = output.len() as u64 - 1;
        let tighter = PreparationPlan::from_source(ORIGINAL, profile(), tighter_limits).unwrap();
        assert_eq!(tighter.cache_key(), plan.cache_key());
        assert_eq!(tighter.verify_cached_output(&output, &receipt), Err(Errno::EFBIG));
        tighter_limits = limits();
        tighter_limits.original_bytes = 8;
        let cached_only = PreparationPlan::from_source(ORIGINAL, profile(), tighter_limits).unwrap();
        assert_eq!(cached_only.original_for_preparation(), Err(Errno::EFBIG));
        assert_eq!(cached_only.cache_key(), plan.cache_key());
        cached_only.verify_cached_output(&output, &receipt).unwrap();
    }
}

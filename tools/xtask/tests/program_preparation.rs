use fork_instrument::artifact_io::MappedArtifact;
use fork_instrument::original_artifact::{OriginalReference, attach_original_reference};
use runtime_core::program_preparation::{PreparationLimits, PreparationPlan, PreparationProfile};
use sha2::{Digest, Sha256};

const ORIGINAL: &[u8] = include_bytes!("../../../abi/program-fixtures/v55/raw-fork.wasm");

fn profile() -> PreparationProfile {
    PreparationProfile {
        preparer_sha256: Sha256::digest(std::fs::read(std::env::current_exe().unwrap()).unwrap()).into(),
        optimizer_sha256: None,
        options_sha256: Sha256::digest(b"fork-instrument::Options::default()").into(),
        dependency_closure_sha256: Sha256::digest(b"frozen-statically-linked-program").into(),
        program_contract_sha256: [
            0x13, 0x58, 0xec, 0xa0, 0x4a, 0x8d, 0x33, 0xfa, 0x5b, 0xcc, 0x27, 0xd1, 0xc6, 0x72, 0xaf, 0x2f,
            0x6e, 0x7a, 0xaf, 0x46, 0x6a, 0x39, 0x8a, 0xd5, 0x98, 0xd9, 0x91, 0x34, 0x7b, 0x1a, 0x44, 0x15,
        ],
        program_abi: 55,
    }
}

fn limits() -> PreparationLimits {
    PreparationLimits { source_bytes: 16 * 1024 * 1024, original_bytes: 16 * 1024 * 1024,
        output_bytes: 16 * 1024 * 1024, metadata_bytes: 1024 * 1024, metadata_work_items: 1_000_000 }
}

#[test]
fn native_transform_produces_a_cache_binding_the_portable_runtime_reader_accepts() {
    let profile = profile();
    let plan = PreparationPlan::from_source(ORIGINAL, profile, limits()).unwrap();
    plan.verify_original(ORIGINAL).unwrap();
    let artifact = fork_instrument::native::instrument(ORIGINAL, &fork_instrument::Options::default(),
        fork_instrument::native::Limits { output_bytes: limits().output_bytes, ..Default::default() }).unwrap();
    assert!(artifact.decision.participates);
    let reference = OriginalReference { length: ORIGINAL.len() as u64, sha256: Sha256::digest(ORIGINAL).into() };
    let prepared = attach_original_reference(&artifact.bytes, &reference, limits().output_bytes).unwrap();
    assert_ne!(prepared.bytes(), ORIGINAL);
    let receipt = plan.verify_output(prepared.bytes()).unwrap();
    assert_eq!(plan.verify_cached_output(prepared.bytes(), &receipt.encode()).unwrap(), receipt);
    let reprepare = PreparationPlan::from_source(prepared.bytes(), profile, limits()).unwrap();
    assert!(!reprepare.original_is_source());
    reprepare.verify_original(ORIGINAL).unwrap();
    assert_eq!(reprepare.original(), plan.original());
    assert_ne!(reprepare.cache_key(), plan.cache_key());
}

#[test]
fn bound_instrumented_output_is_never_accepted_as_an_original_to_instrument_again() {
    let instrumented = fork_instrument::native::instrument(ORIGINAL, &fork_instrument::Options::default(), Default::default()).unwrap();
    let reference = OriginalReference { length: instrumented.bytes.bytes().len() as u64, sha256: Sha256::digest(instrumented.bytes.bytes()).into() };
    let source = MappedArtifact::snapshot(ORIGINAL, limits().source_bytes).unwrap();
    let misleading = attach_original_reference(&source, &reference, limits().source_bytes).unwrap();
    let plan = PreparationPlan::from_source(misleading.bytes(), profile(), limits()).unwrap();
    assert_eq!(plan.verify_original(instrumented.bytes.bytes()), Err(wasm_posix_shared::Errno::ENOEXEC));
}

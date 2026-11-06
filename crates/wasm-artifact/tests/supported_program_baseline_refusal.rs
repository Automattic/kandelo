//! The ABI-55 program cohort must be REFUSED by the declared ABI-56 baseline.
//!
//! `abi/supported-program-baseline.json` declares one exact program contract,
//! and routing `klogctl` declared a new one (ABI 56). The compatibility
//! contract (`docs/persistent-program-compatibility.md`) is explicit that a
//! new baseline must not be worked around "by accepting arbitrary old digests
//! or giving new requirements the old identity", and that an extension needs
//! explicit admission and negative tests. This is that negative test: the
//! previously supported cohort is turned away, and turned away with a reason
//! that names both the ABI epoch and the program contract digest, so whoever
//! hits it knows to rebuild rather than to go looking for a corrupt artifact.
//!
//! The frozen bytes under `abi/program-fixtures/v55` are reproduced from their
//! pinned producer revision and are never rebuilt or restamped to make a
//! compatibility test pass.

use std::path::{Path, PathBuf};

use wasm_artifact::{describe_artifact_policy_failures, ArtifactPolicy};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// The declared supported program baseline: its ABI epoch and digest bytes.
fn declared_baseline() -> (u32, Vec<u8>) {
    let path = repo_root().join("abi/supported-program-baseline.json");
    let bytes = std::fs::read(&path).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let abi = u32::try_from(value["abi_version"].as_u64().unwrap()).unwrap();
    let hex = value["program_contract_digest"].as_str().unwrap();
    assert_eq!(hex.len(), 64, "a program contract digest is 32 bytes of hex");
    let digest = (0..hex.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap())
        .collect();
    (abi, digest)
}

#[test]
fn the_frozen_abi_55_cohort_is_refused_by_the_declared_baseline() {
    let (baseline_abi, digest) = declared_baseline();
    // The declared baseline and the compiled epoch must agree, or this test
    // would be judging the cohort against a contract nothing actually runs.
    assert_eq!(baseline_abi, wasm_posix_program_abi::ABI_VERSION);
    assert_ne!(baseline_abi, 55, "the declared baseline is past ABI 55");

    let policy = ArtifactPolicy {
        expected_abi: Some(baseline_abi),
        expected_abi_contract_digest: Some(&digest),
        ..ArtifactPolicy::default()
    };

    let directory = repo_root().join("abi/program-fixtures/v55");
    let mut checked = 0;
    for entry in std::fs::read_dir(&directory).unwrap() {
        let path = entry.unwrap().path();
        if !path.extension().is_some_and(|extension| extension == "wasm") {
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let report = describe_artifact_policy_failures(&std::fs::read(&path).unwrap(), &policy);
        assert!(
            !report.is_acceptable(),
            "{name} was admitted at ABI {baseline_abi}; an ABI-55 program cannot run here",
        );
        let failures = report.failures.join("; ");
        assert!(
            failures.contains(&format!("ABI 55, expected {baseline_abi}")),
            "{name} must be refused by epoch: {failures}",
        );
        // The digest, too: a later bump that happened to reuse an epoch number
        // would still be caught by the contract digest alone.
        assert!(
            failures.contains("ABI contract digest mismatch"),
            "{name} must be refused by contract digest: {failures}",
        );
        checked += 1;
    }
    // The manifest pins seven artifacts. A missing one means
    // `python3 scripts/build-program-baseline.py` has not reproduced the
    // cohort from its pinned producer yet.
    assert_eq!(checked, 7, "the frozen ABI-55 cohort is incomplete");
}

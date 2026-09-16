//! The artifact policy: whether a given WebAssembly artifact may run under a
//! given kernel.
//!
//! This is the question asked on **every `exec`**, on every process launch, and
//! at every point the resolver picks a binary. It is deliberately a *report*
//! rather than a boolean: a refusal that cannot say what was wrong turns a
//! rebuildable staleness into an unexplained failure, and the platform contract
//! asks for truthful failure over convenient illusion.

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use crate::facts::{read_artifact_facts, ArtifactFacts};
use crate::fork_contract::describe_fork_contract_failures;

/// What an artifact is being judged against.
///
/// Every field is optional in the sense that a `None`/empty value means "do not
/// ask this question". A caller that knows less — a resolver that has no live
/// kernel to name an epoch, say — asks fewer questions rather than a weaker
/// version of the same one.
#[derive(Debug, Default, Clone)]
pub struct ArtifactPolicy<'a> {
    /// The ABI epoch the artifact must declare, when the caller knows it.
    pub expected_abi: Option<u32>,
    /// The 32-byte digest of `hash(abi/snapshot.json + ABI_VERSION)`.
    ///
    /// WHY this exists beside `expected_abi`: the ABI *number* can be identical
    /// across a structural change that regenerated the snapshot, so the number
    /// alone cannot catch a guest built against a different contract.
    pub expected_abi_contract_digest: Option<&'a [u8]>,
    pub required_exports: &'a [&'a str],
    pub forbidden_exports: &'a [&'a str],
    /// Whether the full fork contract applies. `None` means "decide from the
    /// artifact": a relocatable (side) module is exempt, a linked program is
    /// not.
    pub require_fork_instrumentation: Option<bool>,
    /// Whether *any* fork-instrumentation surface is itself a failure, used for
    /// artifacts that must be free of the transform.
    pub forbid_fork_instrumentation: bool,
}

/// The verdict, separating hard failures from rollout warnings.
///
/// Warnings are returned rather than printed because whether a missing marker
/// is worth a console line is a host decision, and because a decision made
/// inside a `no_std` library cannot be un-made by its caller.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ArtifactPolicyReport {
    pub failures: Vec<String>,
    pub warnings: Vec<String>,
}

impl ArtifactPolicyReport {
    pub fn is_acceptable(&self) -> bool {
        self.failures.is_empty()
    }
}

/// Judge an artifact's bytes against a policy.
///
/// Walks the container once and answers every question from that one fact set.
pub fn describe_artifact_policy_failures(
    bytes: &[u8],
    policy: &ArtifactPolicy<'_>,
) -> ArtifactPolicyReport {
    let facts = match read_artifact_facts(bytes) {
        Ok(facts) => facts,
        Err(error) => {
            return ArtifactPolicyReport {
                failures: alloc::vec![error.0],
                warnings: Vec::new(),
            };
        }
    };
    describe_facts_policy_failures(bytes, &facts, policy)
}

/// Judge an artifact whose facts have already been read.
///
/// Separated so a caller that needs both the facts and the verdict — the
/// instrumenter, or a resolver reporting details — walks the container once.
pub fn describe_facts_policy_failures(
    bytes: &[u8],
    facts: &ArtifactFacts,
    policy: &ArtifactPolicy<'_>,
) -> ArtifactPolicyReport {
    let mut report = ArtifactPolicyReport::default();

    if facts.contains_legacy_asyncify {
        report.failures.push(String::from("contains asyncify_"));
    }

    let declared_abi = crate::read_abi_version(bytes);
    if let Some(expected) = policy.expected_abi {
        match declared_abi {
            None => report.warnings.push(String::from(
                "artifact lacks an __abi_version export — legacy binary predates the ABI \
                 marker rollout. Rebuild against the current glue (channel_syscall.c) to \
                 pick up the check. See docs/abi-versioning.md.",
            )),
            Some(declared) if declared as i64 != i64::from(expected) => report
                .failures
                .push(format!("ABI {declared}, expected {expected}")),
            Some(_) => {}
        }
    }

    if let Some(expected_digest) = policy.expected_abi_contract_digest {
        match crate::facts::read_custom_section(bytes, crate::ABI_CONTRACT_SECTION) {
            None => report.warnings.push(format!(
                "artifact lacks a {} stamp — legacy binary predates the \
                 ABI-contract-digest rollout. Rebuild it through the local-build engine to \
                 pick up the check. See docs/abi-versioning.md.",
                crate::ABI_CONTRACT_SECTION
            )),
            Some(actual) if !digests_equal(actual, expected_digest) => {
                report.failures.push(String::from(
                    "ABI contract digest mismatch — guest built against a different ABI \
                     snapshot than the running kernel; rebuild the guest",
                ))
            }
            Some(_) => {}
        }
    }

    let missing: Vec<&str> = policy
        .required_exports
        .iter()
        .copied()
        .filter(|name| !facts.exports.contains_key(*name))
        .collect();
    if !missing.is_empty() {
        report
            .failures
            .push(format!("missing required exports: {}", missing.join(", ")));
    }
    let forbidden: Vec<&str> = policy
        .forbidden_exports
        .iter()
        .copied()
        .filter(|name| facts.exports.contains_key(*name))
        .collect();
    if !forbidden.is_empty() {
        report.failures.push(format!(
            "forbidden exports present: {}",
            forbidden.join(", ")
        ));
    }

    let has_fork_surface = facts.has_fork_artifact_surface();

    // The fork capability bits name an ABI-epoch contract. Without the marker,
    // copied capability metadata could make a previous epoch's transform look
    // safe to this one.
    if let Some(expected) = policy.expected_abi {
        if has_fork_surface && declared_abi.is_none() {
            report.failures.push(format!(
                "ABI {expected} fork artifact is missing __abi_version; the \
                 activation-state capability epoch cannot be verified"
            ));
        }
    }

    if policy.forbid_fork_instrumentation && has_fork_surface {
        // The epoch is read from the policy rather than written as a literal so
        // this names the epoch whose fork contract the artifact was measured
        // against. A hardcoded number silently keeps naming the old one after a
        // bump, telling whoever reads the failure that a stale artifact belongs
        // to an epoch nobody is running.
        // ALWAYS this build's epoch, never the caller's `expected_abi`.
        //
        // The surface being recognized here is defined by the requirement
        // tables compiled into THIS binary (`WPK_FORK_REQUIRED_*`). A caller
        // asking "is this artifact ABI 12?" does not change which contract's
        // metadata was found, so naming 12 would assert something false: that
        // the reader recognized ABI 12 fork surface, which it has no tables to
        // recognize.
        let epoch = wasm_posix_shared::ABI_VERSION.to_string();
        report.failures.push(format!(
            "contains ABI {epoch} wasm-fork-instrument metadata, imports, or exports"
        ));
    }

    // An unlinked OBJECT is exempt; a linked side module is not. See
    // `ArtifactFacts::is_relocatable_object` for why those are different
    // questions -- using the side-module flag here would exempt exactly the
    // artifacts whose reconstruction recipe most needs checking.
    let require_fork = policy
        .require_fork_instrumentation
        .unwrap_or(!facts.is_relocatable_object);
    if require_fork && (has_fork_surface || facts.imports_kernel_fork) {
        // Same rule, and for the same reason: every requirement
        // `describe_fork_contract_failures` checks comes from this build's
        // tables, so every message about them names this build's epoch. The
        // caller's `expected_abi` answers a different question -- what the
        // artifact's own `__abi_version` must equal -- and is checked above.
        let epoch = wasm_posix_shared::ABI_VERSION;
        report
            .failures
            .extend(describe_fork_contract_failures(facts, epoch));
    }

    report
}

/// Fixed-shape comparison of two ABI-contract digests.
fn digests_equal(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut differing = 0u8;
    for (x, y) in a.iter().zip(b) {
        differing |= x ^ y;
    }
    differing == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_module() -> Vec<u8> {
        alloc::vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
    }

    #[test]
    fn non_wasm_bytes_are_a_failure_not_a_panic() {
        let report = describe_artifact_policy_failures(b"#!/bin/sh\n", &ArtifactPolicy::default());
        assert!(!report.is_acceptable());
        assert_eq!(report.failures, alloc::vec!["not a WebAssembly module"]);
    }

    #[test]
    fn an_uninstrumented_module_passes_an_empty_policy() {
        let report = describe_artifact_policy_failures(&empty_module(), &ArtifactPolicy::default());
        assert!(report.is_acceptable(), "{:?}", report.failures);
    }

    #[test]
    fn a_missing_abi_marker_warns_rather_than_failing() {
        let policy = ArtifactPolicy {
            expected_abi: Some(44),
            ..ArtifactPolicy::default()
        };
        let report = describe_artifact_policy_failures(&empty_module(), &policy);
        assert!(report.is_acceptable(), "{:?}", report.failures);
        assert_eq!(report.warnings.len(), 1);
        assert!(report.warnings[0].contains("__abi_version"));
    }

    #[test]
    fn required_exports_are_reported_by_name() {
        let policy = ArtifactPolicy {
            required_exports: &["_start", "memory"],
            ..ArtifactPolicy::default()
        };
        let report = describe_artifact_policy_failures(&empty_module(), &policy);
        assert_eq!(
            report.failures,
            alloc::vec!["missing required exports: _start, memory"]
        );
    }

    #[test]
    fn digest_comparison_rejects_a_different_length() {
        assert!(digests_equal(&[1, 2, 3], &[1, 2, 3]));
        assert!(!digests_equal(&[1, 2, 3], &[1, 2, 4]));
        assert!(!digests_equal(&[1, 2, 3], &[1, 2]));
        assert!(digests_equal(&[], &[]));
    }
}

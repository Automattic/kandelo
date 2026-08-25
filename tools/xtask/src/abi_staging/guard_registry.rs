// Later staging plans consume the policy and retirement APIs directly. Keep
// this independently reviewable foundation quiet until those callers land.
#![allow(dead_code)]

use crate::abi_staging::canonical_json::{canonical_json_bytes, validate_stable_id};
use crate::abi_staging::product_manifest::{
    atomic_write_regular, read_bounded_regular_file,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

const REGISTRY_SCHEMA: u64 = 1;
const REGISTRY_KIND: &str = "kandelo-abi-staging-guard-codes";
const RETIREMENT_KIND: &str = "kandelo-abi-staging-legacy-retirement";
const MAX_POLICY_BYTES: usize = 1024 * 1024;
const MAX_GUARDS: usize = 256;
const MAX_RETIREMENT_ENTRIES: usize = 512;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GuardCodeV1 {
    AbiStructureChangedWithoutBump,
    BuildFailed,
    BuildInputCaptureIncomplete,
    BuildTimeout,
    CandidateIntegrityMismatch,
    CandidatePublicReadbackFailed,
    DependencyUnavailable,
    NamespaceBootstrapFailed,
    PagesProductIncomplete,
    PolicyVersionUnknown,
    RequestInvalid,
    RequestUnauthorized,
    SourceCustodyMismatch,
    SourceIdentityMismatch,
    TapSourceDrift,
    TransientInfrastructureFailure,
    VerificationFailed,
    VerificationTimeout,
}

impl GuardCodeV1 {
    pub const ALL: [Self; 18] = [
        Self::AbiStructureChangedWithoutBump,
        Self::BuildFailed,
        Self::BuildInputCaptureIncomplete,
        Self::BuildTimeout,
        Self::CandidateIntegrityMismatch,
        Self::CandidatePublicReadbackFailed,
        Self::DependencyUnavailable,
        Self::NamespaceBootstrapFailed,
        Self::PagesProductIncomplete,
        Self::PolicyVersionUnknown,
        Self::RequestInvalid,
        Self::RequestUnauthorized,
        Self::SourceCustodyMismatch,
        Self::SourceIdentityMismatch,
        Self::TapSourceDrift,
        Self::TransientInfrastructureFailure,
        Self::VerificationFailed,
        Self::VerificationTimeout,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::RequestInvalid => "request_invalid",
            Self::RequestUnauthorized => "request_unauthorized",
            Self::AbiStructureChangedWithoutBump => "abi_structure_changed_without_bump",
            Self::SourceIdentityMismatch => "source_identity_mismatch",
            Self::SourceCustodyMismatch => "source_custody_mismatch",
            Self::BuildInputCaptureIncomplete => "build_input_capture_incomplete",
            Self::BuildFailed => "build_failed",
            Self::BuildTimeout => "build_timeout",
            Self::TransientInfrastructureFailure => "transient_infrastructure_failure",
            Self::CandidateIntegrityMismatch => "candidate_integrity_mismatch",
            Self::CandidatePublicReadbackFailed => "candidate_public_readback_failed",
            Self::VerificationFailed => "verification_failed",
            Self::VerificationTimeout => "verification_timeout",
            Self::DependencyUnavailable => "dependency_unavailable",
            Self::TapSourceDrift => "tap_source_drift",
            Self::NamespaceBootstrapFailed => "namespace_bootstrap_failed",
            Self::PolicyVersionUnknown => "policy_version_unknown",
            Self::PagesProductIncomplete => "pages_product_incomplete",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GuardDefaultDispositionV1 {
    RejectRequest,
    FailCheck,
    RejectBuildOrPublication,
    RejectCandidateOrAdmission,
    FailBeforeBuild,
    RecordNoCandidate,
    RecordTimeout,
    ScheduleRetry,
    RejectCandidate,
    MarkIneligible,
    BlockDependants,
    ReplanAffectedFormula,
    BlockPublication,
    RejectInterpretation,
    HoldLastCompleteSite,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GuardOverridePolicyV1 {
    Never,
    ExactSubjectBuildRisk,
    ExactArtifact,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GuardRecoveryPolicyV1 {
    None,
    Rebuild,
    RetryPolicy,
    ManualRetryAfterExhaustion,
    ResolveDependency,
    ReplanRebuild,
    RepairNamespace,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GuardCodeEntryV1 {
    pub code: GuardCodeV1,
    pub default_disposition: GuardDefaultDispositionV1,
    pub override_policy: GuardOverridePolicyV1,
    pub recovery_policy: GuardRecoveryPolicyV1,
    pub summary: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GuardCodeRegistryV1 {
    pub schema: u64,
    pub kind: String,
    pub version: u64,
    pub guards: Vec<GuardCodeEntryV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyRetirementLedgerV1 {
    pub schema: u64,
    pub kind: String,
    pub entries: Vec<LegacyRetirementEntryV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyRetirementEntryV1 {
    pub repository: String,
    pub path: String,
    pub current_consumers: Vec<String>,
    pub replacement_component: String,
    pub required_evidence_ids: Vec<String>,
    pub removal_conditions: Vec<String>,
    pub removable: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GuardRegistryWriteMode {
    Generate,
    Check,
}

pub fn parse_guard_registry(path: &Path, bytes: &[u8]) -> Result<GuardCodeRegistryV1, String> {
    if bytes.len() > MAX_POLICY_BYTES {
        return Err(format!("guard registry {} exceeds 1 MiB", path.display()));
    }
    let registry: GuardCodeRegistryV1 = toml::from_str(
        std::str::from_utf8(bytes)
            .map_err(|error| format!("guard registry {} is not UTF-8: {error}", path.display()))?,
    )
    .map_err(|error| format!("guard registry {} is invalid TOML: {error}", path.display()))?;
    validate_guard_registry(&registry)?;
    Ok(registry)
}

pub fn validate_guard_registry(registry: &GuardCodeRegistryV1) -> Result<(), String> {
    if registry.schema != REGISTRY_SCHEMA || registry.kind != REGISTRY_KIND {
        return Err("guard registry has unsupported identity".to_string());
    }
    if registry.version == 0 {
        return Err("guard registry version must be positive".to_string());
    }
    if registry.guards.is_empty() || registry.guards.len() > MAX_GUARDS {
        return Err(format!(
            "guard registry must contain 1 through {MAX_GUARDS} guards"
        ));
    }
    let mut previous: Option<GuardCodeV1> = None;
    let mut summaries = BTreeSet::new();
    for guard in &registry.guards {
        if previous.is_some_and(|value| value >= guard.code) {
            return Err("guard registry entries must be sorted by unique code".to_string());
        }
        previous = Some(guard.code);
        validate_bounded_text(&guard.summary, "guard summary", 512)?;
        if !summaries.insert(guard.summary.as_str()) {
            return Err("guard registry meanings must have unique summaries".to_string());
        }
    }
    Ok(())
}

pub fn validate_initial_guard_policy(registry: &GuardCodeRegistryV1) -> Result<(), String> {
    validate_guard_registry(registry)?;
    if registry.version != 1 {
        return Err("initial guard registry version must be 1".to_string());
    }
    let expected = initial_guard_entries();
    if registry.guards != expected {
        return Err("guard registry does not match the approved initial policy".to_string());
    }
    Ok(())
}

pub fn validate_append_only_guard_update(
    previous: &GuardCodeRegistryV1,
    current: &GuardCodeRegistryV1,
) -> Result<(), String> {
    validate_guard_registry(previous)?;
    validate_guard_registry(current)?;
    let current_by_code = current
        .guards
        .iter()
        .map(|entry| (entry.code, entry))
        .collect::<BTreeMap<_, _>>();
    for old in &previous.guards {
        if current_by_code.get(&old.code).copied() != Some(old) {
            return Err(format!(
                "guard code {:?} was deleted or its meaning changed",
                old.code.as_str()
            ));
        }
    }
    let appended = current.guards.len().saturating_sub(previous.guards.len());
    if appended == 0 {
        if current.version != previous.version {
            return Err("guard registry version changed without an appended code".to_string());
        }
    } else if current.version != previous.version + 1 {
        return Err("appending guard codes requires exactly one registry-version increment".to_string());
    }
    Ok(())
}

pub fn guard_override_policy(code: GuardCodeV1) -> GuardOverridePolicyV1 {
    initial_guard_entries()
        .into_iter()
        .find(|entry| entry.code == code)
        .expect("every closed guard code has an initial policy")
        .override_policy
}

pub fn write_or_check_guard_registry(
    mode: GuardRegistryWriteMode,
    source: &Path,
    generated: &Path,
) -> Result<(), String> {
    let registry = parse_guard_registry(source, &read_bounded_regular_file(source, MAX_POLICY_BYTES)?)?;
    validate_initial_guard_policy(&registry)?;
    let expected = canonical_json_bytes(&registry)?;
    match mode {
        GuardRegistryWriteMode::Generate => atomic_write_regular(generated, &expected),
        GuardRegistryWriteMode::Check => {
            let actual = read_bounded_regular_file(generated, MAX_POLICY_BYTES)?;
            if actual != expected {
                return Err(format!(
                    "generated guard registry {} is stale",
                    generated.display()
                ));
            }
            Ok(())
        }
    }
}

pub fn parse_legacy_retirement_ledger(
    path: &Path,
    bytes: &[u8],
) -> Result<LegacyRetirementLedgerV1, String> {
    if bytes.len() > MAX_POLICY_BYTES {
        return Err(format!("legacy retirement ledger {} exceeds 1 MiB", path.display()));
    }
    let ledger: LegacyRetirementLedgerV1 = toml::from_str(
        std::str::from_utf8(bytes).map_err(|error| {
            format!("legacy retirement ledger {} is not UTF-8: {error}", path.display())
        })?,
    )
    .map_err(|error| {
        format!("legacy retirement ledger {} is invalid TOML: {error}", path.display())
    })?;
    validate_legacy_retirement_ledger(&ledger)?;
    Ok(ledger)
}

pub fn validate_legacy_retirement_ledger(
    ledger: &LegacyRetirementLedgerV1,
) -> Result<(), String> {
    if ledger.schema != REGISTRY_SCHEMA || ledger.kind != RETIREMENT_KIND {
        return Err("legacy retirement ledger has unsupported identity".to_string());
    }
    if ledger.entries.is_empty() || ledger.entries.len() > MAX_RETIREMENT_ENTRIES {
        return Err(format!(
            "legacy retirement ledger must contain 1 through {MAX_RETIREMENT_ENTRIES} entries"
        ));
    }
    let mut previous: Option<(&str, &str)> = None;
    for entry in &ledger.entries {
        validate_repository(&entry.repository)?;
        validate_normalized_relative_path(&entry.path, "legacy path")?;
        if previous.is_some_and(|value| value >= (entry.repository.as_str(), entry.path.as_str())) {
            return Err(
                "legacy retirement entries must be sorted by unique repository and path"
                    .to_string(),
            );
        }
        previous = Some((&entry.repository, &entry.path));
        if entry.removable {
            return Err(format!(
                "legacy path {}/{} cannot be removable during foundation rollout",
                entry.repository, entry.path
            ));
        }
        validate_nonempty_sorted_texts(
            &entry.current_consumers,
            "legacy current consumers",
            256,
        )?;
        validate_bounded_text(&entry.replacement_component, "replacement component", 512)?;
        validate_nonempty_sorted_ids(
            &entry.required_evidence_ids,
            "legacy required evidence",
        )?;
        validate_nonempty_sorted_texts(
            &entry.removal_conditions,
            "legacy removal conditions",
            1024,
        )?;
    }
    Ok(())
}

pub fn run_cli(action: &str, args: &[String]) -> Result<(), String> {
    let mode = match action {
        "generate" => GuardRegistryWriteMode::Generate,
        "check" => GuardRegistryWriteMode::Check,
        _ => return Err(format!("unknown guard-codes subcommand {action:?}")),
    };
    let flags = parse_path_flags(args, &["--source", "--generated"])?;
    write_or_check_guard_registry(mode, &flags["--source"], &flags["--generated"])
}

fn initial_guard_entries() -> Vec<GuardCodeEntryV1> {
    use GuardCodeV1 as Code;
    use GuardDefaultDispositionV1 as Disposition;
    use GuardOverridePolicyV1 as Override;
    use GuardRecoveryPolicyV1 as Recovery;
    let entry = |code, default_disposition, override_policy, recovery_policy, summary: &str| {
        GuardCodeEntryV1 {
            code,
            default_disposition,
            override_policy,
            recovery_policy,
            summary: summary.to_string(),
        }
    };
    vec![
        entry(Code::AbiStructureChangedWithoutBump, Disposition::FailCheck, Override::Never, Recovery::None, "The structural ABI changed without the required version bump and snapshot update."),
        entry(Code::BuildFailed, Disposition::RecordNoCandidate, Override::Never, Recovery::Rebuild, "The deterministic package or product build ended in an application failure."),
        entry(Code::BuildInputCaptureIncomplete, Disposition::FailBeforeBuild, Override::ExactSubjectBuildRisk, Recovery::None, "The exact subject has build inputs that protected planning could not capture completely."),
        entry(Code::BuildTimeout, Disposition::RecordTimeout, Override::Never, Recovery::RetryPolicy, "The package or product build exceeded its protected timeout."),
        entry(Code::CandidateIntegrityMismatch, Disposition::RejectCandidate, Override::Never, Recovery::None, "Candidate bytes, sizes, descriptors, or immutable identities do not agree."),
        entry(Code::CandidatePublicReadbackFailed, Disposition::MarkIneligible, Override::Never, Recovery::None, "Anonymous readback did not reproduce the exact published candidate identity."),
        entry(Code::DependencyUnavailable, Disposition::BlockDependants, Override::Never, Recovery::ResolveDependency, "A selected subject cannot proceed until an exact required dependency becomes usable."),
        entry(Code::NamespaceBootstrapFailed, Disposition::BlockPublication, Override::Never, Recovery::RepairNamespace, "The ABI namespace could not be created or verified with its required protection and public identity."),
        entry(Code::PagesProductIncomplete, Disposition::HoldLastCompleteSite, Override::Never, Recovery::None, "The complete Pages product set is not ready for one atomic deployment."),
        entry(Code::PolicyVersionUnknown, Disposition::RejectInterpretation, Override::Never, Recovery::None, "The protected consumer does not implement the record's policy or guard-registry version."),
        entry(Code::RequestInvalid, Disposition::RejectRequest, Override::Never, Recovery::None, "The request bytes, filename, schema, or exact identities are invalid."),
        entry(Code::RequestUnauthorized, Disposition::RejectRequest, Override::Never, Recovery::None, "The exact request source lacks the required protected authorization."),
        entry(Code::SourceCustodyMismatch, Disposition::RejectCandidateOrAdmission, Override::Never, Recovery::None, "Captured source history or custody evidence does not match the candidate or admission."),
        entry(Code::SourceIdentityMismatch, Disposition::RejectBuildOrPublication, Override::Never, Recovery::None, "An exact source, manifest, input, output, or artifact identity does not match."),
        entry(Code::TapSourceDrift, Disposition::ReplanAffectedFormula, Override::Never, Recovery::ReplanRebuild, "The protected tap source changed after the exact build contract was planned."),
        entry(Code::TransientInfrastructureFailure, Disposition::ScheduleRetry, Override::Never, Recovery::ManualRetryAfterExhaustion, "A classified runner, artifact-service, registry, or transport failure interrupted execution."),
        entry(Code::VerificationFailed, Disposition::MarkIneligible, Override::ExactArtifact, Recovery::None, "The exact candidate failed a protected registered verification definition."),
        entry(Code::VerificationTimeout, Disposition::MarkIneligible, Override::ExactArtifact, Recovery::RetryPolicy, "Verification of the exact candidate exceeded its protected timeout."),
    ]
}

fn validate_repository(value: &str) -> Result<(), String> {
    validate_bounded_text(value, "repository", 256)?;
    if value.split('/').count() != 2
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'_' | b'-'))
    {
        return Err(format!("invalid repository identity {value:?}"));
    }
    Ok(())
}

fn validate_normalized_relative_path(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 4_096
        || value.starts_with('/')
        || value.contains(['\\', '\0'])
        || value
            .split('/')
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
        || Path::new(value)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("{field} is not a normalized repository path: {value:?}"));
    }
    Ok(())
}

fn validate_nonempty_sorted_ids(values: &[String], field: &str) -> Result<(), String> {
    if values.is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    let mut previous: Option<&str> = None;
    for value in values {
        validate_stable_id(value, field)?;
        if previous.is_some_and(|old| old >= value.as_str()) {
            return Err(format!("{field} must be sorted and duplicate-free"));
        }
        previous = Some(value);
    }
    Ok(())
}

fn validate_nonempty_sorted_texts(
    values: &[String],
    field: &str,
    maximum: usize,
) -> Result<(), String> {
    if values.is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    let mut previous: Option<&str> = None;
    for value in values {
        validate_bounded_text(value, field, maximum)?;
        if previous.is_some_and(|old| old >= value.as_str()) {
            return Err(format!("{field} must be sorted and duplicate-free"));
        }
        previous = Some(value);
    }
    Ok(())
}

fn validate_bounded_text(value: &str, field: &str, maximum: usize) -> Result<(), String> {
    if value.is_empty() || value.len() > maximum || value.contains('\0') {
        return Err(format!("{field} must contain 1 through {maximum} UTF-8 bytes"));
    }
    Ok(())
}

fn parse_path_flags(args: &[String], expected: &[&str]) -> Result<BTreeMap<String, PathBuf>, String> {
    if args.len() != expected.len() * 2 {
        return Err(format!("expected flags: {}", expected.join(" ")));
    }
    let mut flags = BTreeMap::new();
    for pair in args.chunks_exact(2) {
        if !expected.contains(&pair[0].as_str()) {
            return Err(format!("unknown or unexpected flag {:?}", pair[0]));
        }
        if flags
            .insert(pair[0].clone(), PathBuf::from(&pair[1]))
            .is_some()
        {
            return Err(format!("duplicate flag {:?}", pair[0]));
        }
    }
    for flag in expected {
        if !flags.contains_key(*flag) {
            return Err(format!("missing required flag {flag}"));
        }
    }
    Ok(flags)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn repository_guard_registry_has_the_exact_initial_policy_and_fresh_output() {
        let repository = crate::repo_root();
        let source = repository.join("abi/staging/guard-codes.toml");
        let generated = repository.join("abi/staging/guard-codes.generated.json");
        let registry = parse_guard_registry(
            &source,
            &read_bounded_regular_file(&source, MAX_POLICY_BYTES).unwrap(),
        )
        .unwrap();

        validate_initial_guard_policy(&registry).unwrap();
        assert_eq!(
            registry
                .guards
                .iter()
                .map(|entry| entry.code)
                .collect::<BTreeSet<_>>(),
            GuardCodeV1::ALL.into_iter().collect()
        );
        write_or_check_guard_registry(GuardRegistryWriteMode::Check, &source, &generated).unwrap();
    }

    #[test]
    fn registry_rejects_unknown_codes_duplicate_meanings_and_invalid_overrides() {
        let source = Path::new("guard.toml");
        let unknown = br#"schema = 1
kind = "kandelo-abi-staging-guard-codes"
version = 1
[[guards]]
code = "invented_guard"
default_disposition = "fail-check"
override_policy = "never"
recovery_policy = "none"
summary = "Unknown."
"#;
        assert!(parse_guard_registry(source, unknown)
            .unwrap_err()
            .contains("unknown variant"));

        let mut duplicate = GuardCodeRegistryV1 {
            schema: 1,
            kind: REGISTRY_KIND.to_string(),
            version: 1,
            guards: initial_guard_entries(),
        };
        duplicate.guards[1].summary = duplicate.guards[0].summary.clone();
        assert!(validate_guard_registry(&duplicate)
            .unwrap_err()
            .contains("unique summaries"));

        let mut invalid = GuardCodeRegistryV1 {
            schema: 1,
            kind: REGISTRY_KIND.to_string(),
            version: 1,
            guards: initial_guard_entries(),
        };
        invalid
            .guards
            .iter_mut()
            .find(|entry| entry.code == GuardCodeV1::RequestInvalid)
            .unwrap()
            .override_policy = GuardOverridePolicyV1::ExactArtifact;
        assert!(validate_initial_guard_policy(&invalid)
            .unwrap_err()
            .contains("approved initial policy"));
    }

    #[test]
    fn append_only_updates_reject_deletion_and_mutation_and_require_one_version_increment() {
        let previous = GuardCodeRegistryV1 {
            schema: 1,
            kind: REGISTRY_KIND.to_string(),
            version: 1,
            guards: initial_guard_entries()[..2].to_vec(),
        };
        let mut deleted = previous.clone();
        deleted.guards.pop();
        assert!(validate_append_only_guard_update(&previous, &deleted)
            .unwrap_err()
            .contains("deleted"));

        let mut changed = previous.clone();
        changed.guards[0].summary.push_str(" Changed.");
        assert!(validate_append_only_guard_update(&previous, &changed)
            .unwrap_err()
            .contains("meaning changed"));

        let mut appended = previous.clone();
        appended.version += 1;
        appended.guards.push(initial_guard_entries()[2].clone());
        assert!(validate_append_only_guard_update(&previous, &appended).is_ok());
        appended.version += 1;
        assert!(validate_append_only_guard_update(&previous, &appended)
            .unwrap_err()
            .contains("one registry-version increment"));
    }

    #[test]
    fn retirement_ledger_covers_observed_legacy_authorities_and_none_are_removable() {
        let repository = crate::repo_root();
        let path = repository.join("abi/staging/legacy-retirement.toml");
        let ledger = parse_legacy_retirement_ledger(
            &path,
            &read_bounded_regular_file(&path, MAX_POLICY_BYTES).unwrap(),
        )
        .unwrap();
        let actual = ledger
            .entries
            .iter()
            .map(|entry| (entry.repository.as_str(), entry.path.as_str()))
            .collect::<BTreeSet<_>>();
        let required_local = [
            ".github/scripts/clone-rejected-merge-candidate.sh",
            ".github/disabled-workflows/abi-staging-merge-gate.yml",
            ".github/disabled-workflows/abi-staging-request-feed.yml",
            ".github/disabled-workflows/browser-demos-pages.yml",
            ".github/disabled-workflows/homebrew-experimental-vfs-publish.yml",
            ".github/disabled-workflows/homebrew-main-shell-ci.yml",
            ".github/disabled-workflows/homebrew-native-publisher-compatibility.yml",
            ".github/disabled-workflows/reusable-homebrew-bottle-maintenance.yml",
            ".github/disabled-workflows/reusable-homebrew-bottle-publish.yml",
            ".github/disabled-workflows/reusable-homebrew-closed-selection-publish.yml",
            ".github/disabled-workflows/reusable-homebrew-main-shell-mirror-publish.yml",
            "homebrew/main-shell.Brewfile",
            "homebrew/main-shell-brew-package-tree.json",
            "homebrew/main-shell-homebrew-runtime-support.json",
            "homebrew/main-shell-lazy-artifact-lock.json",
            "homebrew/main-shell-materialization-policy.json",
            "homebrew/main-shell-migration-lock.json",
            "homebrew/main-shell-selection-lock.json",
            "homebrew/source-rootfs-shell-package",
            "images/vfs/scripts/build-shell-vfs-image.sh",
            "images/vfs/scripts/build-shell-vfs-image.ts",
            "images/vfs/scripts/build-source-rootfs-shell-image.ts",
            "run.sh",
            "scripts/deploy-gh-pages.sh",
        ];
        for required in required_local {
            assert!(
                actual.contains(&("Automattic/kandelo", required)),
                "missing local retirement entry {required}"
            );
            assert!(
                repository.join(required).exists(),
                "inventoried path does not exist: {required}"
            );
        }
        for package in [
            "erlang-vfs",
            "kandelo-sdk",
            "lamp",
            "mariadb-test",
            "mariadb-vfs",
            "nginx-php-vfs",
            "nginx-vfs",
            "node-vfs",
            "perl-vfs",
            "python-vfs",
            "redis-vfs",
            "rootfs",
            "shell",
            "wordpress",
        ] {
            let package_path = format!("packages/registry/{package}");
            assert!(
                actual.contains(&("Automattic/kandelo", package_path.as_str())),
                "missing VFS wrapper {package}"
            );
        }
        for tap_path in [
            ".github/workflows/dry-run-bottles.yml",
            ".github/workflows/maintain-bottles.yml",
            ".github/workflows/publish-bottles.yml",
            ".github/workflows/publish-main-shell-mirror.yml",
            ".github/workflows/selection-checks.yml",
        ] {
            assert!(
                actual.contains(&("kandelo-dev/homebrew-tap-core", tap_path)),
                "missing tap retirement entry {tap_path}"
            );
        }
        assert!(ledger.entries.iter().all(|entry| {
            !entry.removable
                && !entry.current_consumers.is_empty()
                && !entry.required_evidence_ids.is_empty()
                && !entry.removal_conditions.is_empty()
        }));
    }

    #[test]
    fn retirement_ledger_rejects_removable_or_incomplete_entries() {
        let mut ledger = LegacyRetirementLedgerV1 {
            schema: 1,
            kind: RETIREMENT_KIND.to_string(),
            entries: vec![LegacyRetirementEntryV1 {
                repository: "Automattic/kandelo".to_string(),
                path: "legacy/path".to_string(),
                current_consumers: vec!["consumer".to_string()],
                replacement_component: "replacement".to_string(),
                required_evidence_ids: vec!["evidence".to_string()],
                removal_conditions: vec!["condition".to_string()],
                removable: false,
            }],
        };
        validate_legacy_retirement_ledger(&ledger).unwrap();
        ledger.entries[0].removable = true;
        assert!(validate_legacy_retirement_ledger(&ledger)
            .unwrap_err()
            .contains("cannot be removable"));
        ledger.entries[0].removable = false;
        ledger.entries[0].current_consumers.clear();
        assert!(validate_legacy_retirement_ledger(&ledger)
            .unwrap_err()
            .contains("must not be empty"));
    }

    #[test]
    fn generated_guard_registry_detects_drift() {
        let repository = crate::repo_root();
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("guards.toml");
        let generated = root.path().join("guards.json");
        fs::copy(repository.join("abi/staging/guard-codes.toml"), &source).unwrap();
        write_or_check_guard_registry(GuardRegistryWriteMode::Generate, &source, &generated)
            .unwrap();
        fs::write(&generated, b"{}\n").unwrap();
        assert!(write_or_check_guard_registry(
            GuardRegistryWriteMode::Check,
            &source,
            &generated,
        )
        .unwrap_err()
        .contains("stale"));
    }
}

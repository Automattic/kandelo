use crate::abi_staging::builder_contract::TargetAbiV1;
use crate::abi_staging::canonical_json::{
    canonical_json_bytes, canonical_sha256, validate_git_sha, validate_sha256,
};
use crate::abi_staging::consumer_registry::{
    ChangeClass, parse_pages_registry, parse_test_registry,
};
use crate::abi_staging::guard_registry::GuardCodeV1;
use crate::abi_staging::product_manifest::{
    atomic_write_regular, load_product_catalog, read_bounded_regular_file,
};
use crate::abi_staging::records::{
    AbiStagingRequestV1, ExactGitSourceV1, PullRequestRequestIdentityV1, RequestAuthorizationV1,
    RequestEvidenceBindingV1, RequestInformationalContextV1, RequestIssuanceV1,
    RequestProductBindingV1, RequestRegistryBindingV1, RequestRegistryKindV1,
    RequestRequirementsV1, request_requirements_digest, validate_request,
};
use crate::abi_staging::request_policy::{RequestPolicyV1, parse_request_policy};
use crate::abi_staging::selection::{
    FormulaRequirementV1, derive_formula_requirements, select_vfs_products_for_change_classes,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const STRUCTURAL_REPORT_SCHEMA: u64 = 1;
const STRUCTURAL_REPORT_KIND: &str = "kandelo-structural-abi-report";
const STRUCTURAL_FEED_DISPOSITION_SCHEMA: u64 = 1;
const STRUCTURAL_FEED_DISPOSITION_KIND: &str = "kandelo-structural-abi-feed-disposition";
const PRODUCT_DIRECTORY: &str = "images/vfs/products";
const MAX_CHANGED_PATH_BYTES: usize = 16 * 1024 * 1024;
const MAX_CHANGED_PATH_LENGTH: usize = 4096;
const PAGES_REGISTRY: &str = "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml";
const TEST_REGISTRY: &str = "tests/vfs-products.toml";
const SNAPSHOT_PATH: &str = "abi/snapshot.json";
const SHARED_ABI_PATH: &str = "crates/shared/src/lib.rs";
const ABI_CHECK_COMMAND_PATH: &str = "scripts/check-abi-version.sh";
const MAX_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StructuralAbiOutcomeV1 {
    Compatible,
    BumpedWithSnapshot,
    ChangedWithoutBump,
    Invalid,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StructuralAbiReportV1 {
    pub schema: u64,
    pub kind: String,
    pub source: ExactGitSourceV1,
    pub observed_previous_abi: Option<u64>,
    pub target_abi: u64,
    pub snapshot_sha256: String,
    pub snapshot_file_sha256: String,
    pub check_command_sha256: String,
    pub outcome: StructuralAbiOutcomeV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum StructuralFeedDispositionStatusV1 {
    Eligible,
    CandidateInvalid,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct StructuralFeedDispositionV1 {
    schema: u64,
    kind: String,
    status: StructuralFeedDispositionStatusV1,
    guard: Option<GuardCodeV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PullRequestIdentityV1 {
    pub repository: String,
    pub number: u64,
    pub exact_head_repository: String,
    pub exact_head: String,
    pub exact_tree: String,
    pub base_commit: Option<String>,
    pub base_tree: Option<String>,
    pub ref_hint: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProtectedRequestContextV1 {
    pub protected_repository: String,
    pub protected_commit: String,
    pub protected_tree: String,
    pub issuer_workflow_ref: String,
    pub policy: RequestPolicyV1,
    pub policy_sha256: String,
    pub guard_registry_version: u64,
    pub guard_registry_sha256: String,
}

pub fn parse_structural_abi_report(
    path: &Path,
    bytes: &[u8],
) -> Result<StructuralAbiReportV1, String> {
    if bytes.is_empty() || bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(format!(
            "structural ABI report {} must contain 1 through {MAX_DOCUMENT_BYTES} bytes",
            path.display()
        ));
    }
    let report: StructuralAbiReportV1 = serde_json::from_slice(bytes).map_err(|error| {
        format!(
            "structural ABI report {} is invalid JSON: {error}",
            path.display()
        )
    })?;
    if canonical_json_bytes(&report)? != bytes {
        return Err(format!(
            "structural ABI report {} is not canonical JSON",
            path.display()
        ));
    }
    validate_structural_report_shape(&report)?;
    Ok(report)
}

pub fn validate_structural_abi_report_against_previous_abi(
    exact_head_root: &Path,
    pull_request: &PullRequestIdentityV1,
    protected_previous_abi: u64,
    report: &StructuralAbiReportV1,
) -> Result<(), String> {
    let outcome = authenticate_structural_abi_report_against_previous_abi(
        exact_head_root,
        pull_request,
        protected_previous_abi,
        report,
    )?;
    match outcome {
        StructuralAbiOutcomeV1::Compatible | StructuralAbiOutcomeV1::BumpedWithSnapshot => Ok(()),
        StructuralAbiOutcomeV1::ChangedWithoutBump => Err(
            GuardCodeV1::AbiStructureChangedWithoutBump
                .as_str()
                .to_string(),
        ),
        StructuralAbiOutcomeV1::Invalid => {
            Err(GuardCodeV1::RequestInvalid.as_str().to_string())
        }
    }
}

fn authenticate_structural_abi_report_against_previous_abi(
    exact_head_root: &Path,
    pull_request: &PullRequestIdentityV1,
    protected_previous_abi: u64,
    report: &StructuralAbiReportV1,
) -> Result<StructuralAbiOutcomeV1, String> {
    validate_pull_request_identity(pull_request)?;
    validate_structural_report_shape(report)?;
    if report.source.repository != pull_request.exact_head_repository
        || report.source.commit != pull_request.exact_head
        || report.source.tree != pull_request.exact_tree
    {
        return Err("structural ABI report source does not match the exact PR head".to_string());
    }
    validate_exact_checkout(exact_head_root, pull_request)?;

    if protected_previous_abi == 0 {
        return Err("protected previous ABI must be positive".to_string());
    }
    if report.observed_previous_abi != Some(protected_previous_abi) {
        return Err(format!(
            "structural ABI report does not match protected previous ABI {protected_previous_abi}"
        ));
    }

    let check_path = exact_head_root.join(ABI_CHECK_COMMAND_PATH);
    let check_command = read_bounded_regular_file(&check_path, MAX_DOCUMENT_BYTES)?;
    let check_command_sha256 = format!("{:x}", Sha256::digest(&check_command));
    if report.check_command_sha256 != check_command_sha256 {
        return Err(
            "structural ABI report checker identity does not match exact-head bytes".to_string(),
        );
    }

    let snapshot_path = exact_head_root.join(SNAPSHOT_PATH);
    let snapshot = read_bounded_regular_file(&snapshot_path, MAX_DOCUMENT_BYTES)?;
    let snapshot_sha256 = format!("{:x}", Sha256::digest(&snapshot));
    if report.snapshot_file_sha256 != snapshot_sha256 || report.snapshot_sha256 != snapshot_sha256 {
        return Err(
            "structural ABI report snapshot identity does not match exact-head bytes".to_string(),
        );
    }
    let target_abi = read_abi_version(&exact_head_root.join(SHARED_ABI_PATH))?;
    if report.target_abi != target_abi {
        return Err(format!(
            "structural ABI report target {} does not match exact-head ABI_VERSION {target_abi}",
            report.target_abi
        ));
    }

    match report.outcome {
        StructuralAbiOutcomeV1::Compatible => {
            if protected_previous_abi != report.target_abi {
                return Err(
                    "compatible structural report cannot change the observed ABI version"
                        .to_string(),
                );
            }
        }
        StructuralAbiOutcomeV1::BumpedWithSnapshot => {
            if protected_previous_abi.checked_add(1) != Some(report.target_abi) {
                return Err(
                    "successor structural report must model generic ABI N to N+1".to_string(),
                );
            }
        }
        StructuralAbiOutcomeV1::ChangedWithoutBump => {
            return Ok(StructuralAbiOutcomeV1::ChangedWithoutBump);
        }
        StructuralAbiOutcomeV1::Invalid => {
            return Ok(StructuralAbiOutcomeV1::Invalid);
        }
    }
    Ok(report.outcome)
}

fn structural_feed_disposition(
    outcome: StructuralAbiOutcomeV1,
) -> StructuralFeedDispositionV1 {
    let (status, guard) = match outcome {
        StructuralAbiOutcomeV1::Compatible | StructuralAbiOutcomeV1::BumpedWithSnapshot => {
            (StructuralFeedDispositionStatusV1::Eligible, None)
        }
        StructuralAbiOutcomeV1::ChangedWithoutBump => (
            StructuralFeedDispositionStatusV1::CandidateInvalid,
            Some(GuardCodeV1::AbiStructureChangedWithoutBump),
        ),
        StructuralAbiOutcomeV1::Invalid => (
            StructuralFeedDispositionStatusV1::CandidateInvalid,
            Some(GuardCodeV1::RequestInvalid),
        ),
    };
    StructuralFeedDispositionV1 {
        schema: STRUCTURAL_FEED_DISPOSITION_SCHEMA,
        kind: STRUCTURAL_FEED_DISPOSITION_KIND.to_string(),
        status,
        guard,
    }
}

pub fn derive_abi_staging_request(
    exact_head_root: &Path,
    pull_request: &PullRequestIdentityV1,
    protected: &ProtectedRequestContextV1,
    protected_previous_abi: u64,
    structural: &StructuralAbiReportV1,
    change_classes: &[ChangeClass],
) -> Result<AbiStagingRequestV1, String> {
    validate_pull_request_identity(pull_request)?;
    validate_protected_context(protected)?;
    if pull_request.repository != protected.policy.issuer_repository
        || pull_request.repository != protected.protected_repository
    {
        return Err("pull request and protected issuer repositories do not match".to_string());
    }
    if pull_request.exact_head_repository != pull_request.repository {
        return Err("automatic request derivation is disabled for fork heads".to_string());
    }
    validate_sorted_change_classes(change_classes)?;
    validate_structural_abi_report_against_previous_abi(
        exact_head_root,
        pull_request,
        protected_previous_abi,
        structural,
    )?;

    let (requirements, _) = derive_request_requirements(exact_head_root, change_classes)?;

    let request = AbiStagingRequestV1 {
        schema: 1,
        kind: "kandelo-abi-staging-request".to_string(),
        pull_request: PullRequestRequestIdentityV1 {
            repository: pull_request.repository.clone(),
            number: pull_request.number,
        },
        build_source: structural.source.clone(),
        target_abi: TargetAbiV1 {
            version: structural.target_abi,
            snapshot_sha256: structural.snapshot_sha256.clone(),
        },
        requirements,
        issuance: RequestIssuanceV1 {
            issuer_repository: protected.protected_repository.clone(),
            issuer_workflow_ref: protected.issuer_workflow_ref.clone(),
            policy_version: protected.policy.version,
            policy_sha256: protected.policy_sha256.clone(),
            guard_registry_version: protected.guard_registry_version,
            guard_registry_sha256: protected.guard_registry_sha256.clone(),
            authorization: RequestAuthorizationV1::SameRepository {
                head: pull_request.exact_head.clone(),
            },
        },
        informational_context: RequestInformationalContextV1 {
            base_commit: pull_request.base_commit.clone(),
            base_tree: pull_request.base_tree.clone(),
            previous_abi: structural.observed_previous_abi,
            ref_hint: pull_request.ref_hint.clone(),
        },
    };
    validate_request(&request)?;
    Ok(request)
}

pub fn derive_request_requirements(
    exact_head_root: &Path,
    change_classes: &[ChangeClass],
) -> Result<(RequestRequirementsV1, Vec<FormulaRequirementV1>), String> {
    validate_sorted_change_classes(change_classes)?;
    let catalog = load_product_catalog(exact_head_root, Path::new(PRODUCT_DIRECTORY))?;
    let pages_path = exact_head_root.join(PAGES_REGISTRY);
    let tests_path = exact_head_root.join(TEST_REGISTRY);
    let pages = parse_pages_registry(
        &pages_path,
        &read_bounded_regular_file(&pages_path, 1024 * 1024)?,
    )?;
    let tests = parse_test_registry(
        &tests_path,
        &read_bounded_regular_file(&tests_path, 1024 * 1024)?,
    )?;
    let selection =
        select_vfs_products_for_change_classes(&catalog, &pages, &tests, change_classes)?;
    // Formula roots are intentionally derived only from selected product
    // manifests. The request does not carry a parallel Formula allowlist.
    let formulae = derive_formula_requirements(&catalog, &selection)?;
    let products = selection
        .iter()
        .map(|product| RequestProductBindingV1 {
            id: product.product_id.clone(),
            path: product.manifest_path.clone(),
            manifest_sha256: product.manifest_sha256.clone(),
        })
        .collect::<Vec<_>>();
    let registries = vec![
        RequestRegistryBindingV1 {
            kind: RequestRegistryKindV1::Pages,
            path: PAGES_REGISTRY.to_string(),
            sha256: canonical_sha256(&pages)?,
        },
        RequestRegistryBindingV1 {
            kind: RequestRegistryKindV1::Tests,
            path: TEST_REGISTRY.to_string(),
            sha256: canonical_sha256(&tests)?,
        },
    ];
    let evidence = selection
        .iter()
        .filter(|product| !product.node_evidence.is_empty() || !product.browser_evidence.is_empty())
        .map(|product| RequestEvidenceBindingV1 {
            product_id: product.product_id.clone(),
            applicability: product.applicability,
            node: product.node_evidence.clone(),
            browser: product.browser_evidence.clone(),
        })
        .collect::<Vec<_>>();
    let mut requirements = RequestRequirementsV1 {
        digest: "0".repeat(64),
        change_classes: change_classes.to_vec(),
        products,
        registries,
        evidence,
    };
    requirements.digest = request_requirements_digest(&requirements)?;
    Ok((requirements, formulae))
}

pub fn classify_changed_paths(bytes: &[u8]) -> Result<Vec<ChangeClass>, String> {
    if bytes.len() > MAX_CHANGED_PATH_BYTES {
        return Err("changed-path inventory exceeds its byte bound".to_string());
    }
    if bytes.is_empty() {
        return Ok(vec![]);
    }
    if bytes.last() != Some(&0) {
        return Err("changed-path inventory is not NUL terminated".to_string());
    }
    let mut paths = BTreeSet::new();
    let mut classes = BTreeSet::new();
    for raw in bytes[..bytes.len() - 1].split(|byte| *byte == 0) {
        let path = std::str::from_utf8(raw)
            .map_err(|error| format!("changed path is not UTF-8: {error}"))?;
        if path.is_empty()
            || path.len() > MAX_CHANGED_PATH_LENGTH
            || path.starts_with('/')
            || path.contains('\\')
            || path
                .split('/')
                .any(|component| component.is_empty() || component == "." || component == "..")
            || path.chars().any(char::is_control)
        {
            return Err(format!(
                "changed path {path:?} is not a canonical repository path"
            ));
        }
        if !paths.insert(path) {
            return Err(format!("changed path inventory repeats {path:?}"));
        }
        if path.starts_with("abi/") || path.starts_with("crates/shared/") {
            classes.insert(ChangeClass::Abi);
        }
        if path.starts_with("crates/kernel/")
            || path.starts_with("crates/fork-instrument/")
            || path.starts_with("libc/")
        {
            classes.insert(ChangeClass::Kernel);
        }
        if path.starts_with("host/")
            || path.starts_with("web-libs/")
            || path.starts_with("apps/browser-demos/")
            || path.starts_with("images/vfs/products/")
            || path == TEST_REGISTRY
        {
            classes.insert(ChangeClass::Host);
        }
    }
    Ok(classes.into_iter().collect())
}

pub fn run_structural_report_cli(action: &str, args: &[String]) -> Result<(), String> {
    let expected_flags = match action {
        "validate" => vec![
            "--exact-head-root",
            "--previous-abi",
            "--pull-request",
            "--report",
        ],
        "feed-disposition" => vec![
            "--exact-head-root",
            "--previous-abi",
            "--pull-request",
            "--report",
            "--out",
        ],
        _ => return Err(format!("unknown structural-report subcommand {action:?}")),
    };
    let flags = parse_path_flags(args, &expected_flags)?;
    let pull_request: PullRequestIdentityV1 = read_canonical_json(&flags["--pull-request"])?;
    let report_bytes = read_bounded_regular_file(&flags["--report"], MAX_DOCUMENT_BYTES)?;
    let report = parse_structural_abi_report(&flags["--report"], &report_bytes)?;
    let previous_abi = parse_positive_u64_flag(&flags["--previous-abi"], "--previous-abi")?;
    match action {
        "validate" => validate_structural_abi_report_against_previous_abi(
            &flags["--exact-head-root"],
            &pull_request,
            previous_abi,
            &report,
        ),
        "feed-disposition" => {
            let outcome = authenticate_structural_abi_report_against_previous_abi(
                &flags["--exact-head-root"],
                &pull_request,
                previous_abi,
                &report,
            )?;
            atomic_write_regular(
                &flags["--out"],
                &canonical_json_bytes(&structural_feed_disposition(outcome))?,
            )
        }
        _ => unreachable!(),
    }
}

pub fn run_request_cli(action: &str, args: &[String]) -> Result<(), String> {
    match action {
        "classify" => {
            let flags = parse_path_flags(args, &["--changed-paths", "--out"])?;
            let changed_paths =
                read_bounded_regular_file(&flags["--changed-paths"], MAX_CHANGED_PATH_BYTES)?;
            let change_classes = classify_changed_paths(&changed_paths)?;
            atomic_write_regular(&flags["--out"], &canonical_json_bytes(&change_classes)?)
        }
        "derive" => {
            let flags = parse_path_flags(
                args,
                &[
                    "--exact-head-root",
                    "--previous-abi",
                    "--pull-request",
                    "--protected-context",
                    "--structural-report",
                    "--change-classes",
                    "--out",
                ],
            )?;
            let pull_request = read_canonical_json(&flags["--pull-request"])?;
            let protected = read_canonical_json(&flags["--protected-context"])?;
            let report_bytes =
                read_bounded_regular_file(&flags["--structural-report"], MAX_DOCUMENT_BYTES)?;
            let report = parse_structural_abi_report(&flags["--structural-report"], &report_bytes)?;
            let change_classes = parse_change_classes(&flags["--change-classes"])?;
            let previous_abi = parse_positive_u64_flag(&flags["--previous-abi"], "--previous-abi")?;
            let request = derive_abi_staging_request(
                &flags["--exact-head-root"],
                &pull_request,
                &protected,
                previous_abi,
                &report,
                &change_classes,
            )?;
            atomic_write_regular(&flags["--out"], &canonical_json_bytes(&request)?)
        }
        "requirements" => {
            let flags = parse_path_flags(
                args,
                &[
                    "--exact-head-root",
                    "--change-classes",
                    "--requirements-out",
                    "--formulae-out",
                ],
            )?;
            let change_classes = parse_change_classes(&flags["--change-classes"])?;
            let (requirements, formulae) =
                derive_request_requirements(&flags["--exact-head-root"], &change_classes)?;
            atomic_write_regular(
                &flags["--requirements-out"],
                &canonical_json_bytes(&requirements)?,
            )?;
            atomic_write_regular(&flags["--formulae-out"], &canonical_json_bytes(&formulae)?)
        }
        "fixture-check" => {
            let flags = parse_path_flags(args, &["--fixture"])?;
            check_fixture(&flags["--fixture"])
        }
        _ => crate::abi_staging::request_feed::run_cli(action, args),
    }
}

fn validate_structural_report_shape(report: &StructuralAbiReportV1) -> Result<(), String> {
    if report.schema != STRUCTURAL_REPORT_SCHEMA || report.kind != STRUCTURAL_REPORT_KIND {
        return Err("structural ABI report has unsupported identity".to_string());
    }
    validate_repository(&report.source.repository, "structural source repository")?;
    validate_git_sha(&report.source.commit)?;
    validate_git_sha(&report.source.tree)?;
    if report.target_abi == 0 {
        return Err("structural target ABI must be positive".to_string());
    }
    validate_sha256(&report.snapshot_sha256)?;
    validate_sha256(&report.snapshot_file_sha256)?;
    validate_sha256(&report.check_command_sha256)
}

fn validate_pull_request_identity(pull_request: &PullRequestIdentityV1) -> Result<(), String> {
    validate_repository(&pull_request.repository, "pull-request repository")?;
    validate_repository(&pull_request.exact_head_repository, "exact-head repository")?;
    if pull_request.number == 0 {
        return Err("pull-request number must be positive".to_string());
    }
    validate_git_sha(&pull_request.exact_head)?;
    validate_git_sha(&pull_request.exact_tree)?;
    match (&pull_request.base_commit, &pull_request.base_tree) {
        (Some(commit), Some(tree)) => {
            validate_git_sha(commit)?;
            validate_git_sha(tree)?;
        }
        (None, None) => {}
        _ => return Err("informational base commit and tree must appear together".to_string()),
    }
    if let Some(ref_hint) = &pull_request.ref_hint {
        if ref_hint.is_empty()
            || ref_hint.len() > 1_024
            || ref_hint.contains('\0')
            || ref_hint.chars().any(char::is_control)
        {
            return Err("informational ref hint is invalid".to_string());
        }
    }
    Ok(())
}

fn validate_protected_context(context: &ProtectedRequestContextV1) -> Result<(), String> {
    validate_repository(&context.protected_repository, "protected repository")?;
    validate_git_sha(&context.protected_commit)?;
    validate_git_sha(&context.protected_tree)?;
    validate_sha256(&context.policy_sha256)?;
    validate_sha256(&context.guard_registry_sha256)?;
    if context.guard_registry_version == 0 {
        return Err("guard registry version must be positive".to_string());
    }
    let policy_toml = toml::to_string(&context.policy)
        .map_err(|error| format!("cannot encode protected policy: {error}"))?;
    parse_request_policy(
        Path::new("protected-request-policy.toml"),
        policy_toml.as_bytes(),
    )?;
    if context.policy.issuer_repository != context.protected_repository {
        return Err(
            "protected request policy issuer does not match protected repository".to_string(),
        );
    }
    let expected_workflow_ref = format!(
        "{}/{}@{}",
        context.protected_repository, context.policy.issuer_workflow, context.protected_commit
    );
    if context.issuer_workflow_ref != expected_workflow_ref {
        return Err("issuer workflow ref does not bind the protected commit".to_string());
    }
    Ok(())
}

fn validate_repository(value: &str, field: &str) -> Result<(), String> {
    let parts = value.split('/').collect::<Vec<_>>();
    if value.is_empty()
        || value.len() > 256
        || parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || !part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        })
    {
        return Err(format!("{field} must be an exact owner/name identity"));
    }
    Ok(())
}

fn validate_exact_checkout(
    exact_head_root: &Path,
    pull_request: &PullRequestIdentityV1,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(exact_head_root).map_err(|error| {
        format!(
            "cannot inspect exact-head root {}: {error}",
            exact_head_root.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("exact-head root must be a nonsymlink directory".to_string());
    }
    let head = git_identity(exact_head_root, "HEAD")?;
    let tree = git_identity(exact_head_root, "HEAD^{tree}")?;
    if head != pull_request.exact_head || tree != pull_request.exact_tree {
        return Err("exact-head checkout does not match authorized PR head and tree".to_string());
    }
    Ok(())
}

fn git_identity(root: &Path, revision: &str) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--verify", revision])
        .output()
        .map_err(|error| format!("cannot inspect exact-head Git identity: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "cannot inspect exact-head Git identity {revision:?}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let identity = std::str::from_utf8(&output.stdout)
        .map_err(|error| format!("Git identity is not UTF-8: {error}"))?
        .trim()
        .to_string();
    validate_git_sha(&identity)?;
    Ok(identity)
}

fn read_abi_version(path: &Path) -> Result<u64, String> {
    let bytes = read_bounded_regular_file(path, MAX_DOCUMENT_BYTES)?;
    let source = std::str::from_utf8(&bytes)
        .map_err(|error| format!("{} is not UTF-8: {error}", path.display()))?;
    let pattern = Regex::new(r"(?m)^pub const ABI_VERSION: u32 = ([0-9]+);$")
        .map_err(|error| format!("cannot compile protected ABI parser: {error}"))?;
    let captures = pattern
        .captures(source)
        .ok_or_else(|| format!("{} does not declare ABI_VERSION", path.display()))?;
    captures[1]
        .parse::<u64>()
        .map_err(|error| format!("{} has invalid ABI_VERSION: {error}", path.display()))
}

fn validate_sorted_change_classes(change_classes: &[ChangeClass]) -> Result<(), String> {
    if change_classes.is_empty() {
        return Err("request change classes must not be empty".to_string());
    }
    if change_classes.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err("request change classes must be sorted and duplicate-free".to_string());
    }
    Ok(())
}

fn read_canonical_json<T>(path: &Path) -> Result<T, String>
where
    T: for<'de> Deserialize<'de> + Serialize,
{
    let bytes = read_bounded_regular_file(path, MAX_DOCUMENT_BYTES)?;
    let value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("{} is invalid JSON: {error}", path.display()))?;
    if canonical_json_bytes(&value)? != bytes {
        return Err(format!("{} is not canonical JSON", path.display()));
    }
    Ok(value)
}

fn parse_change_classes(path: &Path) -> Result<Vec<ChangeClass>, String> {
    let bytes = read_bounded_regular_file(path, 4_096)?;
    let values: Vec<String> = serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "{} is not a JSON change-class array: {error}",
            path.display()
        )
    })?;
    let mut classes = values
        .into_iter()
        .map(|value| match value.as_str() {
            "abi" => Ok(ChangeClass::Abi),
            "kernel" => Ok(ChangeClass::Kernel),
            "host" => Ok(ChangeClass::Host),
            _ => Err(format!("unsupported change class {value:?}")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    classes.sort();
    classes.dedup();
    validate_sorted_change_classes(&classes)?;
    Ok(classes)
}

fn check_fixture(directory: &Path) -> Result<(), String> {
    let report_path = directory.join("structural-report.json");
    let request_path = directory.join("current-request.json");
    let report_bytes = read_bounded_regular_file(&report_path, MAX_DOCUMENT_BYTES)?;
    let report = parse_structural_abi_report(&report_path, &report_bytes)?;
    let request: AbiStagingRequestV1 = read_canonical_json(&request_path)?;
    validate_request(&request)?;
    if request.build_source != report.source
        || request.target_abi.version != report.target_abi
        || request.target_abi.snapshot_sha256 != report.snapshot_sha256
        || request.informational_context.previous_abi != report.observed_previous_abi
    {
        return Err("request fixture does not bind its structural ABI report".to_string());
    }
    Ok(())
}

fn parse_path_flags(
    args: &[String],
    expected: &[&str],
) -> Result<BTreeMap<String, PathBuf>, String> {
    if args.len() != expected.len() * 2 {
        return Err(format!("expected flags: {}", expected.join(" ")));
    }
    let mut flags = BTreeMap::new();
    for pair in args.chunks_exact(2) {
        if !expected.contains(&pair[0].as_str()) {
            return Err(format!("unexpected flag {:?}", pair[0]));
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

fn parse_positive_u64_flag(path: &Path, flag: &str) -> Result<u64, String> {
    let value = path
        .to_str()
        .ok_or_else(|| format!("{flag} is not valid UTF-8"))?;
    let parsed = value
        .parse::<u64>()
        .map_err(|_| format!("{flag} must be a positive integer"))?;
    if parsed == 0 {
        return Err(format!("{flag} must be a positive integer"));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abi_staging::canonical_json::canonical_json_bytes;
    use crate::abi_staging::request_policy::ForkAuthorizationV1;
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::process::Command;

    struct Fixture {
        root: tempfile::TempDir,
        pull_request: PullRequestIdentityV1,
        protected: ProtectedRequestContextV1,
        structural: StructuralAbiReportV1,
    }

    fn git(root: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(["-C", root.to_str().unwrap()])
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    fn feed_disposition_args(
        fixture: &Fixture,
        report: &StructuralAbiReportV1,
    ) -> (Vec<String>, PathBuf) {
        let pull_request_path = fixture.root.path().join("pull-request.json");
        let report_path = fixture.root.path().join("structural-report.json");
        let disposition_path = fixture.root.path().join("feed-disposition.json");
        fs::write(
            &pull_request_path,
            canonical_json_bytes(&fixture.pull_request).unwrap(),
        )
        .unwrap();
        fs::write(&report_path, canonical_json_bytes(report).unwrap()).unwrap();
        (
            vec![
                "--exact-head-root".to_string(),
                fixture.root.path().display().to_string(),
                "--previous-abi".to_string(),
                "7".to_string(),
                "--pull-request".to_string(),
                pull_request_path.display().to_string(),
                "--report".to_string(),
                report_path.display().to_string(),
                "--out".to_string(),
                disposition_path.display().to_string(),
            ],
            disposition_path,
        )
    }

    fn fixture() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        for directory in [
            "abi",
            "crates/shared/src",
            "images/vfs/products",
            "images/vfs/scripts",
            "apps/browser-demos/pages/kandelo/kernel-host",
            "scripts",
            "tests",
        ] {
            fs::create_dir_all(root.path().join(directory)).unwrap();
        }
        fs::write(
            root.path().join("images/vfs/scripts/builder.sh"),
            b"#!/bin/sh\n",
        )
        .unwrap();
        fs::write(
            root.path().join("images/vfs/products/selected.toml"),
            br#"schema = 1
id = "selected"
architecture = "wasm32"
output = "selected.vfs"
builder = "images/vfs/scripts/builder.sh"

[[software.homebrew]]
tap = "kandelo-dev/homebrew-tap-core"
formulae = ["selected-root"]
materialization = "lazy"

[[mounts]]
path = "/"
source = "built-image"
readonly = false

[boot]
argv = ["/bin/selected"]
cwd = "/"
uid = 0
gid = 0

[boot.env]
PATH = "/bin"

[evidence.node]
test = "selected-node"
"#,
        )
        .unwrap();
        fs::write(
            root.path().join("images/vfs/products/background.toml"),
            br#"schema = 1
id = "background"
architecture = "wasm32"
output = "background.vfs"
builder = "images/vfs/scripts/builder.sh"

[[software.homebrew]]
tap = "kandelo-dev/homebrew-tap-core"
formulae = ["unrelated-root"]
materialization = "embedded"

[[mounts]]
path = "/"
source = "built-image"
readonly = false
"#,
        )
        .unwrap();
        fs::write(
            root.path()
                .join("apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml"),
            br#"schema = 1
kind = "kandelo-pages-vfs-products"

[[products]]
id = "selected"
load = "lazy"
"#,
        )
        .unwrap();
        fs::write(
            root.path().join("tests/vfs-products.toml"),
            br#"schema = 1
kind = "kandelo-test-vfs-products"

[[registrations]]
product = "selected"
node = ["selected-node"]

[registrations.applicability]
abi = "required"
kernel = "informational"
host = "not-applicable"
"#,
        )
        .unwrap();
        let snapshot = b"{\"schema\":1,\"fixture\":\"successor\"}\n";
        fs::write(root.path().join("abi/snapshot.json"), snapshot).unwrap();
        fs::write(
            root.path().join("crates/shared/src/lib.rs"),
            b"pub const ABI_VERSION: u32 = 8;\n",
        )
        .unwrap();
        let check_command = b"#!/usr/bin/env bash\nset -euo pipefail\n";
        fs::write(
            root.path().join("scripts/check-abi-version.sh"),
            check_command,
        )
        .unwrap();

        git(root.path(), &["init", "-q"]);
        git(root.path(), &["config", "user.name", "Fixture"]);
        git(
            root.path(),
            &["config", "user.email", "fixture@example.invalid"],
        );
        git(root.path(), &["add", "."]);
        git(root.path(), &["commit", "-qm", "fixture"]);
        let head = git(root.path(), &["rev-parse", "HEAD"]);
        let tree = git(root.path(), &["rev-parse", "HEAD^{tree}"]);
        let snapshot_sha256 = format!("{:x}", Sha256::digest(snapshot));
        let check_command_sha256 = format!("{:x}", Sha256::digest(check_command));

        let policy = RequestPolicyV1 {
            schema: 1,
            kind: "kandelo-abi-staging-request-policy".to_string(),
            version: 1,
            issuer_repository: "Automattic/kandelo".to_string(),
            issuer_workflow: ".github/workflows/abi-staging-request-feed.yml".to_string(),
            automatic_same_repository: true,
            fork_authorization: ForkAuthorizationV1::Disabled,
            request_release_tag_prefix: "abi-staging-pr-".to_string(),
            request_asset_max_bytes: 4_194_304,
            max_products: 256,
            max_evidence_bindings: 512,
            addressed_taps: vec!["kandelo-dev/homebrew-tap-core".to_string()],
            implementation_paths: vec!["protected/request.rs".to_string()],
        };
        let pull_request = PullRequestIdentityV1 {
            repository: "Automattic/kandelo".to_string(),
            number: 19,
            exact_head_repository: "Automattic/kandelo".to_string(),
            exact_head: head.clone(),
            exact_tree: tree.clone(),
            base_commit: Some("a".repeat(40)),
            base_tree: Some("b".repeat(40)),
            ref_hint: Some("refs/pull/19/head".to_string()),
        };
        let protected = ProtectedRequestContextV1 {
            protected_repository: "Automattic/kandelo".to_string(),
            protected_commit: "c".repeat(40),
            protected_tree: "d".repeat(40),
            issuer_workflow_ref: format!(
                "Automattic/kandelo/.github/workflows/abi-staging-request-feed.yml@{}",
                "c".repeat(40)
            ),
            policy,
            policy_sha256: "e".repeat(64),
            guard_registry_version: 1,
            guard_registry_sha256: "f".repeat(64),
        };
        let structural = StructuralAbiReportV1 {
            schema: 1,
            kind: "kandelo-structural-abi-report".to_string(),
            source: ExactGitSourceV1 {
                repository: "Automattic/kandelo".to_string(),
                commit: head,
                tree,
            },
            observed_previous_abi: Some(7),
            target_abi: 8,
            snapshot_sha256: snapshot_sha256.clone(),
            snapshot_file_sha256: snapshot_sha256,
            check_command_sha256,
            outcome: StructuralAbiOutcomeV1::BumpedWithSnapshot,
        };
        Fixture {
            root,
            pull_request,
            protected,
            structural,
        }
    }

    #[test]
    fn derives_only_the_supplied_exact_head_and_selected_products() {
        let fixture = fixture();
        let request = derive_abi_staging_request(
            fixture.root.path(),
            &fixture.pull_request,
            &fixture.protected,
            7,
            &fixture.structural,
            &[ChangeClass::Abi],
        )
        .unwrap();
        assert_eq!(request.build_source.commit, fixture.pull_request.exact_head);
        assert_eq!(request.build_source.tree, fixture.pull_request.exact_tree);
        assert_eq!(request.requirements.products.len(), 1);
        assert_eq!(request.requirements.products[0].id, "selected");
        assert_eq!(request.requirements.evidence[0].node, ["selected-node"]);
        assert!(
            !String::from_utf8(canonical_json_bytes(&request).unwrap())
                .unwrap()
                .contains("unrelated-root")
        );
    }

    #[test]
    fn informational_base_and_ref_cannot_change_requirements_or_source() {
        let fixture = fixture();
        let first = derive_abi_staging_request(
            fixture.root.path(),
            &fixture.pull_request,
            &fixture.protected,
            7,
            &fixture.structural,
            &[ChangeClass::Abi],
        )
        .unwrap();
        let mut changed = fixture.pull_request.clone();
        changed.base_commit = Some("2".repeat(40));
        changed.base_tree = Some("3".repeat(40));
        changed.ref_hint = Some("refs/heads/informational".to_string());
        let second = derive_abi_staging_request(
            fixture.root.path(),
            &changed,
            &fixture.protected,
            7,
            &fixture.structural,
            &[ChangeClass::Abi],
        )
        .unwrap();
        assert_eq!(first.build_source, second.build_source);
        assert_eq!(first.requirements, second.requirements);
    }

    #[test]
    fn rejects_checkout_report_source_target_and_snapshot_mismatches() {
        let fixture = fixture();
        let mut report = fixture.structural.clone();
        report.source.commit = "4".repeat(40);
        assert!(
            derive_abi_staging_request(
                fixture.root.path(),
                &fixture.pull_request,
                &fixture.protected,
                7,
                &report,
                &[ChangeClass::Abi],
            )
            .unwrap_err()
            .contains("source")
        );

        let mut report = fixture.structural.clone();
        report.target_abi += 1;
        assert!(
            validate_structural_abi_report_against_previous_abi(
                fixture.root.path(),
                &fixture.pull_request,
                7,
                &report,
            )
            .unwrap_err()
            .contains("ABI_VERSION")
        );

        let mut report = fixture.structural.clone();
        report.snapshot_file_sha256 = "5".repeat(64);
        assert!(
            validate_structural_abi_report_against_previous_abi(
                fixture.root.path(),
                &fixture.pull_request,
                7,
                &report,
            )
            .unwrap_err()
            .contains("snapshot")
        );
    }

    #[test]
    fn protected_previous_abi_and_exact_checker_bytes_are_authoritative() {
        let fixture = fixture();
        validate_structural_abi_report_against_previous_abi(
            fixture.root.path(),
            &fixture.pull_request,
            7,
            &fixture.structural,
        )
        .unwrap();

        let mut wrong_previous = fixture.structural.clone();
        wrong_previous.observed_previous_abi = Some(6);
        assert!(
            validate_structural_abi_report_against_previous_abi(
                fixture.root.path(),
                &fixture.pull_request,
                7,
                &wrong_previous,
            )
            .unwrap_err()
            .contains("protected previous ABI")
        );

        let mut wrong_checker = fixture.structural.clone();
        wrong_checker.check_command_sha256 = "9".repeat(64);
        assert!(
            validate_structural_abi_report_against_previous_abi(
                fixture.root.path(),
                &fixture.pull_request,
                7,
                &wrong_checker,
            )
            .unwrap_err()
            .contains("checker identity")
        );
    }

    #[test]
    fn rejects_unacceptable_structural_outcomes_with_registered_guard() {
        let fixture = fixture();
        let mut report = fixture.structural.clone();
        report.outcome = StructuralAbiOutcomeV1::ChangedWithoutBump;
        assert!(
            validate_structural_abi_report_against_previous_abi(
                fixture.root.path(),
                &fixture.pull_request,
                7,
                &report,
            )
            .unwrap_err()
            .contains("abi_structure_changed_without_bump")
        );

        report.outcome = StructuralAbiOutcomeV1::Invalid;
        assert!(
            validate_structural_abi_report_against_previous_abi(
                fixture.root.path(),
                &fixture.pull_request,
                7,
                &report,
            )
            .is_err()
        );
    }

    #[test]
    fn writes_authenticated_candidate_invalid_feed_disposition() {
        let fixture = fixture();
        let mut report = fixture.structural.clone();
        report.outcome = StructuralAbiOutcomeV1::Invalid;
        let (args, disposition_path) = feed_disposition_args(&fixture, &report);

        assert_eq!(
            validate_structural_abi_report_against_previous_abi(
                fixture.root.path(),
                &fixture.pull_request,
                7,
                &report,
            )
            .unwrap_err(),
            "request_invalid"
        );
        run_structural_report_cli("feed-disposition", &args).unwrap();
        assert_eq!(
            fs::read(disposition_path).unwrap(),
            b"{\"guard\":\"request_invalid\",\"kind\":\"kandelo-structural-abi-feed-disposition\",\"schema\":1,\"status\":\"candidate-invalid\"}\n"
        );
    }

    #[test]
    fn maps_changed_without_bump_to_its_registered_feed_guard() {
        let fixture = fixture();
        let mut report = fixture.structural.clone();
        report.outcome = StructuralAbiOutcomeV1::ChangedWithoutBump;
        let (args, disposition_path) = feed_disposition_args(&fixture, &report);

        run_structural_report_cli("feed-disposition", &args).unwrap();
        assert_eq!(
            fs::read(disposition_path).unwrap(),
            b"{\"guard\":\"abi_structure_changed_without_bump\",\"kind\":\"kandelo-structural-abi-feed-disposition\",\"schema\":1,\"status\":\"candidate-invalid\"}\n"
        );
    }

    #[test]
    fn does_not_write_feed_disposition_for_mismatched_report_identity() {
        let fixture = fixture();
        let mut report = fixture.structural.clone();
        report.outcome = StructuralAbiOutcomeV1::Invalid;
        report.check_command_sha256 = "9".repeat(64);
        let (args, disposition_path) = feed_disposition_args(&fixture, &report);

        let error = run_structural_report_cli("feed-disposition", &args).unwrap_err();
        assert!(error.contains("checker identity"));
        assert!(!disposition_path.exists());
    }

    #[test]
    fn strict_report_parser_rejects_unknown_source_and_uppercase_sha() {
        let fixture = fixture();
        let bytes = canonical_json_bytes(&fixture.structural).unwrap();
        assert_eq!(
            parse_structural_abi_report(Path::new("report.json"), &bytes).unwrap(),
            fixture.structural
        );
        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value["alternate_source"] = serde_json::json!({"commit": "untrusted"});
        assert!(
            parse_structural_abi_report(
                Path::new("report.json"),
                &serde_json::to_vec(&value).unwrap(),
            )
            .is_err()
        );
        let mut uppercase = fixture.structural.clone();
        uppercase.source.commit = uppercase.source.commit.to_uppercase();
        assert!(
            parse_structural_abi_report(
                Path::new("report.json"),
                &canonical_json_bytes(&uppercase).unwrap(),
            )
            .is_err()
        );
    }

    #[test]
    fn fork_and_unsorted_change_class_inputs_are_rejected() {
        let fixture = fixture();
        let mut fork = fixture.pull_request.clone();
        fork.exact_head_repository = "someone/kandelo".to_string();
        assert!(
            derive_abi_staging_request(
                fixture.root.path(),
                &fork,
                &fixture.protected,
                7,
                &fixture.structural,
                &[ChangeClass::Abi],
            )
            .is_err()
        );
        assert!(
            derive_abi_staging_request(
                fixture.root.path(),
                &fixture.pull_request,
                &fixture.protected,
                7,
                &fixture.structural,
                &[ChangeClass::Kernel, ChangeClass::Abi],
            )
            .is_err()
        );
    }

    #[test]
    fn derives_current_requirements_without_executing_exact_head_code() {
        let fixture = fixture();
        let request = derive_abi_staging_request(
            fixture.root.path(),
            &fixture.pull_request,
            &fixture.protected,
            7,
            &fixture.structural,
            &[ChangeClass::Abi],
        )
        .unwrap();

        let (requirements, formulae) =
            derive_request_requirements(fixture.root.path(), &[ChangeClass::Abi]).unwrap();

        assert_eq!(requirements, request.requirements);
        assert_eq!(formulae.len(), 1);
        assert_eq!(formulae[0].formula, "selected-root");
    }

    #[test]
    fn classifies_nul_terminated_paths_without_line_or_prefix_confusion() {
        assert_eq!(
            classify_changed_paths(
                b"abi/snapshot.json\0apps/browser-demos/main.ts\0crates/kernel/src/lib.rs\0docs/readme.md\0"
            )
            .unwrap(),
            vec![ChangeClass::Abi, ChangeClass::Kernel, ChangeClass::Host]
        );
        assert_eq!(classify_changed_paths(b"docs/readme.md\0").unwrap(), vec![]);
        for body in [
            b"host/good.ts\nabi/injected\0".as_slice(),
            b"host/good.ts".as_slice(),
            b"../host/escape.ts\0".as_slice(),
            b"host/good.ts\0host/good.ts\0".as_slice(),
            b"host/\xff.ts\0".as_slice(),
        ] {
            assert!(classify_changed_paths(body).is_err(), "{body:?}");
        }
    }
}

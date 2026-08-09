// Later staging plans publish and consume these durable records. Keep this
// independently reviewable schema foundation quiet until those callers land.
#![allow(dead_code)]

use crate::abi_staging::builder_contract::{TargetAbiV1, VfsProductIdentityV1};
use crate::abi_staging::canonical_json::{
    canonical_json_bytes, canonical_sha256, validate_git_sha, validate_sha256,
    validate_stable_id,
};
use crate::abi_staging::consumer_registry::{ApplicabilityV1, ChangeClass};
use crate::abi_staging::guard_registry::{
    guard_override_policy, GuardCodeV1, GuardOverridePolicyV1,
};
use crate::abi_staging::product_manifest::VfsArchitectureV1;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path};

const REQUEST_SCHEMA: u64 = 1;
const REQUEST_KIND: &str = "kandelo-abi-staging-request";
const RECORD_SCHEMA: u64 = 1;
const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const MAX_BINDINGS: usize = 4_096;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AbiStagingRequestV1 {
    pub schema: u64,
    pub kind: String,
    pub pull_request: PullRequestRequestIdentityV1,
    pub build_source: ExactGitSourceV1,
    pub target_abi: TargetAbiV1,
    pub requirements: RequestRequirementsV1,
    pub issuance: RequestIssuanceV1,
    pub informational_context: RequestInformationalContextV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PullRequestRequestIdentityV1 {
    pub repository: String,
    pub number: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExactGitSourceV1 {
    pub repository: String,
    pub commit: String,
    pub tree: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RequestRequirementsV1 {
    pub digest: String,
    pub change_classes: Vec<ChangeClass>,
    pub products: Vec<RequestProductBindingV1>,
    pub registries: Vec<RequestRegistryBindingV1>,
    pub evidence: Vec<RequestEvidenceBindingV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RequestProductBindingV1 {
    pub id: String,
    pub path: String,
    pub manifest_sha256: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RequestRegistryKindV1 {
    Pages,
    Tests,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RequestRegistryBindingV1 {
    pub kind: RequestRegistryKindV1,
    pub path: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RequestEvidenceBindingV1 {
    pub product_id: String,
    pub applicability: ApplicabilityV1,
    pub node: Vec<String>,
    pub browser: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RequestIssuanceV1 {
    pub issuer_repository: String,
    pub issuer_workflow_ref: String,
    pub policy_version: u64,
    pub policy_sha256: String,
    pub guard_registry_version: u64,
    pub guard_registry_sha256: String,
    pub authorization: RequestAuthorizationV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "kebab-case", deny_unknown_fields)]
pub enum RequestAuthorizationV1 {
    SameRepository { head: String },
    ForkExactSha {
        head: String,
        authorizing_comment_id: u64,
    },
}

impl RequestAuthorizationV1 {
    fn head(&self) -> &str {
        match self {
            Self::SameRepository { head } | Self::ForkExactSha { head, .. } => head,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RequestInformationalContextV1 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_tree: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_abi: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_hint: Option<String>,
}

#[derive(Serialize)]
struct RequestRequirementsIdentityV1<'a> {
    change_classes: &'a [ChangeClass],
    products: &'a [RequestProductBindingV1],
    registries: &'a [RequestRegistryBindingV1],
    evidence: &'a [RequestEvidenceBindingV1],
}

pub fn request_requirements_digest(
    requirements: &RequestRequirementsV1,
) -> Result<String, String> {
    canonical_sha256(&RequestRequirementsIdentityV1 {
        change_classes: &requirements.change_classes,
        products: &requirements.products,
        registries: &requirements.registries,
        evidence: &requirements.evidence,
    })
}

pub fn validate_request(request: &AbiStagingRequestV1) -> Result<(), String> {
    if request.schema != REQUEST_SCHEMA || request.kind != REQUEST_KIND {
        return Err("ABI staging request has unsupported identity".to_string());
    }
    validate_repository(&request.pull_request.repository, "pull-request repository")?;
    if request.pull_request.number == 0 {
        return Err("pull-request number must be positive".to_string());
    }
    validate_exact_git_source(&request.build_source)?;
    validate_target_abi(&request.target_abi)?;
    validate_request_requirements(&request.requirements)?;
    validate_issuance(&request.issuance)?;
    if request.issuance.authorization.head() != request.build_source.commit {
        return Err("request authorization head does not match build-source commit".to_string());
    }
    match request.issuance.authorization {
        RequestAuthorizationV1::SameRepository { .. } => {
            if request.build_source.repository != request.pull_request.repository {
                return Err(
                    "same-repository authorization requires the build-source repository to match"
                        .to_string(),
                );
            }
        }
        RequestAuthorizationV1::ForkExactSha {
            authorizing_comment_id,
            ..
        } => {
            if authorizing_comment_id == 0 {
                return Err("fork authorization comment id must be positive".to_string());
            }
        }
    }
    validate_informational_context(&request.informational_context)
}

pub fn request_is_current(
    request: &AbiStagingRequestV1,
    exact_head: &str,
    requirements_sha256: &str,
    policy_version: u64,
    policy_sha256: &str,
    guard_registry_version: u64,
    guard_registry_sha256: &str,
) -> bool {
    request.build_source.commit == exact_head
        && request.requirements.digest == requirements_sha256
        && request.issuance.policy_version == policy_version
        && request.issuance.policy_sha256 == policy_sha256
        && request.issuance.guard_registry_version == guard_registry_version
        && request.issuance.guard_registry_sha256 == guard_registry_sha256
}

pub fn candidate_request_asset_name(
    head: &str,
    request_digest: &str,
) -> Result<String, String> {
    validate_git_sha(head)?;
    validate_sha256(request_digest)?;
    Ok(format!(
        "candidate-request-{head}-sha256-{request_digest}.json"
    ))
}

pub fn parse_candidate_request_asset(
    filename: &str,
    canonical_request_bytes: &[u8],
) -> Result<AbiStagingRequestV1, String> {
    if canonical_request_bytes.len() > MAX_REQUEST_BYTES {
        return Err("candidate request exceeds the 4 MiB limit".to_string());
    }
    let request: AbiStagingRequestV1 = serde_json::from_slice(canonical_request_bytes)
        .map_err(|error| format!("candidate request is invalid JSON: {error}"))?;
    if canonical_json_bytes(&request)? != canonical_request_bytes {
        return Err("candidate request is not canonical JSON".to_string());
    }
    validate_request(&request)?;
    let digest = canonical_sha256(&request)?;
    let expected = candidate_request_asset_name(&request.build_source.commit, &digest)?;
    if filename != expected {
        return Err(format!(
            "candidate request filename does not match canonical head and digest: expected {expected:?}"
        ));
    }
    Ok(request)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkStateV1 {
    Pending,
    Blocked,
    Queued,
    Running,
    Complete,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalOutcomeV1 {
    Success,
    Failure,
    Timeout,
    Canceled,
    Skipped,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ArtifactClassV1 {
    None,
    Diagnostic,
    Candidate,
    Canonical,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PromotionStateV1 {
    Unknown,
    Eligible,
    Ineligible,
    AcceptedWithOverride,
    RebuildRequired,
    Promoted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RetryNextActionV1 {
    None,
    Wait,
    Retry,
    MaintainerAction,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RetryStateV1 {
    pub attempts: u64,
    pub eligible: bool,
    pub exhausted: bool,
    pub next_action: RetryNextActionV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_eligible_at: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SubjectKindV1 {
    Request,
    Formula,
    Product,
    Candidate,
    SourceCustody,
    Pages,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExactSubjectV1 {
    pub kind: SubjectKindV1,
    pub identity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub architecture: Option<VfsArchitectureV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RecordRunProvenanceV1 {
    pub repository: String,
    pub workflow_ref: String,
    pub run_id: u64,
    pub run_attempt: u64,
    pub job: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactIdentityV1 {
    pub sha256: String,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub immutable_reference: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NamedArtifactIdentityV1 {
    pub id: String,
    pub artifact: ArtifactIdentityV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RecordLinkV1 {
    pub record_sha256: String,
    pub immutable_reference: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RecordBlockerV1 {
    pub guard_code: GuardCodeV1,
    pub subject_kind: SubjectKindV1,
    pub subject: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record: Option<RecordLinkV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RecordCommonV1 {
    pub request_sha256: String,
    pub subject: ExactSubjectV1,
    pub source: ExactGitSourceV1,
    pub run: RecordRunProvenanceV1,
    pub guard_codes: Vec<GuardCodeV1>,
    pub work_state: WorkStateV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<TerminalOutcomeV1>,
    pub artifact_class: ArtifactClassV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<ArtifactIdentityV1>,
    pub promotion_state: PromotionStateV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admission_sha256: Option<String>,
    pub retry_state: RetryStateV1,
    pub blockers: Vec<RecordBlockerV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FormulaBuildSubjectV1 {
    pub tap: String,
    pub formula: String,
    pub architecture: VfsArchitectureV1,
    pub target_abi: u64,
    pub bottle_contract_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RunnerBuildFactsV1 {
    pub runner_image: String,
    pub command_sha256: String,
    pub result_sha256: String,
    pub diagnostics: Vec<RecordLinkV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AttemptPayloadV1 {
    pub formula: FormulaBuildSubjectV1,
    pub source_capsule: ArtifactIdentityV1,
    pub build: RunnerBuildFactsV1,
    pub retry_ordinal: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate: Option<ArtifactIdentityV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AttemptRecordV1 {
    pub schema: u64,
    pub common: RecordCommonV1,
    pub attempt: AttemptPayloadV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateFormulaV1 {
    pub tap: String,
    pub formula: String,
    pub version: String,
    pub revision: u64,
    pub bottle_rebuild: u64,
    pub architecture: VfsArchitectureV1,
    pub target_abi: u64,
    pub bottle_contract_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateProducerV1 {
    pub request_sha256: String,
    pub head: String,
    pub run_id: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidatePayloadV1 {
    pub formula: CandidateFormulaV1,
    pub bottle_layer: ArtifactIdentityV1,
    pub normalized_components: Vec<NamedArtifactIdentityV1>,
    pub direct_dependency_layers: Vec<NamedArtifactIdentityV1>,
    pub source_custody_sha256: String,
    pub producer: CandidateProducerV1,
    pub nonendorsed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateRecordV1 {
    pub schema: u64,
    pub common: RecordCommonV1,
    pub candidate: CandidatePayloadV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateReusePayloadV1 {
    pub formula: FormulaBuildSubjectV1,
    pub existing_candidate: RecordLinkV1,
    pub bottle_layer: ArtifactIdentityV1,
    pub source_custody: RecordLinkV1,
    pub qualifying_receipts: Vec<RecordLinkV1>,
    pub original_producer: CandidateProducerV1,
    pub nonendorsed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateReuseRecordV1 {
    pub schema: u64,
    pub common: RecordCommonV1,
    pub candidate_reuse: CandidateReusePayloadV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VerificationHostV1 {
    Node,
    Browser,
    Build,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VerificationPayloadV1 {
    pub candidate_record_sha256: String,
    pub candidate_layer: ArtifactIdentityV1,
    pub test_definition_sha256: String,
    pub host: VerificationHostV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kernel: Option<ArtifactIdentityV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_runtime: Option<ArtifactIdentityV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vfs: Option<ArtifactIdentityV1>,
    pub attempt_ordinal: u64,
    pub diagnostics: Vec<RecordLinkV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VerificationReceiptV1 {
    pub schema: u64,
    pub common: RecordCommonV1,
    pub verification: VerificationPayloadV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProductEvidencePayloadV1 {
    pub product: VfsProductIdentityV1,
    pub selecting_registries: Vec<RequestRegistryBindingV1>,
    pub resolved_formula_layers: Vec<NamedArtifactIdentityV1>,
    pub resolved_inputs_sha256: String,
    pub vfs_image: ArtifactIdentityV1,
    pub builder_report: ArtifactIdentityV1,
    pub kernel: ArtifactIdentityV1,
    pub host_runtime: ArtifactIdentityV1,
    pub evidence_definition_sha256s: Vec<String>,
    pub verification_receipt_sha256s: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProductEvidenceRecordV1 {
    pub schema: u64,
    pub common: RecordCommonV1,
    pub product_evidence: ProductEvidencePayloadV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MaintainerAuthorizationV1 {
    pub login: String,
    pub permission: String,
    pub authorization_reference: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyIdentityV1 {
    pub policy_version: u64,
    pub policy_sha256: String,
    pub guard_registry_version: u64,
    pub guard_registry_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CaptureOverrideAuthorizationPayloadV1 {
    pub formula: FormulaBuildSubjectV1,
    pub guard_code: GuardCodeV1,
    pub maintainer: MaintainerAuthorizationV1,
    pub justification: String,
    pub policy: PolicyIdentityV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CaptureOverrideAuthorizationV1 {
    pub schema: u64,
    pub common: RecordCommonV1,
    pub capture_authorization: CaptureOverrideAuthorizationPayloadV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OverridePayloadV1 {
    pub accepted_guard_codes: Vec<GuardCodeV1>,
    pub maintainer: MaintainerAuthorizationV1,
    pub justification: String,
    pub policy: PolicyIdentityV1,
    pub candidate_record_sha256: String,
    pub bottle_layer: ArtifactIdentityV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_authorization_sha256: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OverrideReceiptV1 {
    pub schema: u64,
    pub common: RecordCommonV1,
    pub override_receipt: OverridePayloadV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MergedPullRequestV1 {
    pub repository: String,
    pub number: u64,
    pub head: String,
    pub merge_commit: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AdmissionPayloadV1 {
    pub candidate_record_sha256: String,
    pub promoted_layer: ArtifactIdentityV1,
    pub qualifying_receipt_sha256s: Vec<String>,
    pub merged_pull_request: MergedPullRequestV1,
    pub tap_source: ExactGitSourceV1,
    pub canonical: ArtifactIdentityV1,
    pub canonical_public_readback_sha256: String,
    pub formula_metadata_source: ExactGitSourceV1,
    pub original_producer: CandidateProducerV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AdmissionRecordV1 {
    pub schema: u64,
    pub common: RecordCommonV1,
    pub admission: AdmissionPayloadV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeletionPayloadV1 {
    pub candidate_record_sha256: String,
    pub deleted_candidate: ArtifactIdentityV1,
    pub reason: String,
    pub deleted_at: String,
    pub prior_record_sha256s: Vec<String>,
    pub admission_pinned: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeletionRecordV1 {
    pub schema: u64,
    pub common: RecordCommonV1,
    pub deletion: DeletionPayloadV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind")]
pub enum AbiStagingRecordV1 {
    #[serde(rename = "kandelo-abi-staging-attempt")]
    Attempt(AttemptRecordV1),
    #[serde(rename = "kandelo-abi-staging-candidate")]
    Candidate(CandidateRecordV1),
    #[serde(rename = "kandelo-abi-staging-candidate-reuse")]
    CandidateReuse(CandidateReuseRecordV1),
    #[serde(rename = "kandelo-abi-staging-verification")]
    Verification(VerificationReceiptV1),
    #[serde(rename = "kandelo-abi-staging-product-evidence")]
    ProductEvidence(ProductEvidenceRecordV1),
    #[serde(rename = "kandelo-abi-staging-capture-override-authorization")]
    CaptureOverrideAuthorization(CaptureOverrideAuthorizationV1),
    #[serde(rename = "kandelo-abi-staging-override-receipt")]
    Override(OverrideReceiptV1),
    #[serde(rename = "kandelo-abi-staging-admission")]
    Admission(AdmissionRecordV1),
    #[serde(rename = "kandelo-abi-staging-deletion")]
    Deletion(DeletionRecordV1),
}

pub fn parse_record(canonical_bytes: &[u8]) -> Result<AbiStagingRecordV1, String> {
    if canonical_bytes.len() > MAX_REQUEST_BYTES {
        return Err("ABI staging record exceeds the 4 MiB limit".to_string());
    }
    let record: AbiStagingRecordV1 = serde_json::from_slice(canonical_bytes)
        .map_err(|error| format!("ABI staging record is invalid JSON: {error}"))?;
    if canonical_json_bytes(&record)? != canonical_bytes {
        return Err("ABI staging record is not canonical JSON".to_string());
    }
    validate_record(&record)?;
    Ok(record)
}

pub fn run_cli(action: &str, args: &[String]) -> Result<(), String> {
    if action != "validate" {
        return Err(format!(
            "unknown records action {action:?}; expected validate"
        ));
    }
    if args.len() != 2 || args[0] != "--record" {
        return Err("records validate requires exactly --record <path>".to_string());
    }
    let path = Path::new(&args[1]);
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("cannot inspect ABI staging record {path:?}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "ABI staging record must be a regular non-symlink file: {path:?}"
        ));
    }
    if metadata.len() > MAX_REQUEST_BYTES as u64 {
        return Err("ABI staging record exceeds the 4 MiB limit".to_string());
    }
    let bytes = std::fs::read(path)
        .map_err(|error| format!("cannot read ABI staging record {path:?}: {error}"))?;
    parse_record(&bytes)?;
    Ok(())
}

pub fn validate_record(record: &AbiStagingRecordV1) -> Result<(), String> {
    match record {
        AbiStagingRecordV1::Attempt(record) => validate_attempt(record),
        AbiStagingRecordV1::Candidate(record) => validate_candidate(record),
        AbiStagingRecordV1::CandidateReuse(record) => validate_candidate_reuse(record),
        AbiStagingRecordV1::Verification(record) => validate_verification(record),
        AbiStagingRecordV1::ProductEvidence(record) => validate_product_evidence(record),
        AbiStagingRecordV1::CaptureOverrideAuthorization(record) => {
            validate_capture_authorization(record)
        }
        AbiStagingRecordV1::Override(record) => validate_override(record),
        AbiStagingRecordV1::Admission(record) => validate_admission(record),
        AbiStagingRecordV1::Deletion(record) => validate_deletion(record),
    }
}

fn validate_attempt(record: &AttemptRecordV1) -> Result<(), String> {
    validate_record_header(record.schema, &record.common, false)?;
    validate_formula_subject(&record.attempt.formula)?;
    validate_artifact(&record.attempt.source_capsule, ArtifactClassV1::Candidate)?;
    validate_runner_facts(&record.attempt.build)?;
    if let Some(candidate) = &record.attempt.candidate {
        validate_artifact(candidate, ArtifactClassV1::Candidate)?;
        if record.common.artifact_class != ArtifactClassV1::Candidate
            || record.common.artifact.as_ref() != Some(candidate)
        {
            return Err("attempt candidate identity does not match common artifact state".to_string());
        }
    } else if record.common.artifact_class == ArtifactClassV1::Candidate {
        return Err("attempt claims candidate artifact class without candidate bytes".to_string());
    }
    if record.common.outcome == Some(TerminalOutcomeV1::Success)
        && record.attempt.candidate.is_none()
    {
        return Err("successful attempt must contain exact candidate bytes".to_string());
    }
    Ok(())
}

fn validate_candidate(record: &CandidateRecordV1) -> Result<(), String> {
    validate_record_header(record.schema, &record.common, false)?;
    let payload = &record.candidate;
    validate_candidate_formula(&payload.formula)?;
    validate_artifact(&payload.bottle_layer, ArtifactClassV1::Candidate)?;
    validate_named_artifacts(&payload.normalized_components)?;
    validate_named_artifacts(&payload.direct_dependency_layers)?;
    validate_sha256(&payload.source_custody_sha256)?;
    validate_candidate_producer(&payload.producer)?;
    if !payload.nonendorsed {
        return Err("public candidate records must state nonendorsed = true".to_string());
    }
    if record.common.artifact_class != ArtifactClassV1::Candidate
        || record.common.artifact.as_ref() != Some(&payload.bottle_layer)
    {
        return Err("candidate record common artifact must be its exact bottle layer".to_string());
    }
    Ok(())
}

fn validate_candidate_reuse(record: &CandidateReuseRecordV1) -> Result<(), String> {
    validate_record_header(record.schema, &record.common, false)?;
    let payload = &record.candidate_reuse;
    validate_formula_subject(&payload.formula)?;
    validate_record_link(&payload.existing_candidate)?;
    validate_artifact(&payload.bottle_layer, ArtifactClassV1::Candidate)?;
    validate_record_link(&payload.source_custody)?;
    validate_sorted_record_links(&payload.qualifying_receipts, "qualifying receipt records")?;
    validate_candidate_producer(&payload.original_producer)?;
    if !payload.nonendorsed {
        return Err("reused public candidate must retain nonendorsed = true".to_string());
    }
    if record.common.subject.kind != SubjectKindV1::Formula
        || record.common.subject.identity
            != format!("{}/{}", payload.formula.tap, payload.formula.formula)
        || record.common.subject.architecture != Some(payload.formula.architecture)
    {
        return Err("candidate reuse common subject differs from its exact Formula".to_string());
    }
    if record.common.request_sha256 == payload.original_producer.request_sha256 {
        return Err("candidate reuse must bind a new request identity".to_string());
    }
    if record.common.artifact_class != ArtifactClassV1::Candidate
        || record.common.artifact.as_ref() != Some(&payload.bottle_layer)
    {
        return Err(
            "candidate reuse common artifact must be the exact existing bottle layer".to_string(),
        );
    }
    if record.common.outcome != Some(TerminalOutcomeV1::Success)
        || record.common.work_state != WorkStateV1::Complete
        || record.common.promotion_state != PromotionStateV1::Eligible
    {
        return Err("candidate reuse must be a successful eligible record".to_string());
    }
    Ok(())
}

fn validate_verification(record: &VerificationReceiptV1) -> Result<(), String> {
    validate_record_header(record.schema, &record.common, false)?;
    let payload = &record.verification;
    validate_sha256(&payload.candidate_record_sha256)?;
    validate_artifact(&payload.candidate_layer, ArtifactClassV1::Candidate)?;
    validate_sha256(&payload.test_definition_sha256)?;
    for artifact in [&payload.kernel, &payload.host_runtime, &payload.vfs]
        .into_iter()
        .flatten()
    {
        validate_artifact(artifact, ArtifactClassV1::Candidate)?;
    }
    validate_record_links(&payload.diagnostics)?;
    Ok(())
}

fn validate_product_evidence(record: &ProductEvidenceRecordV1) -> Result<(), String> {
    validate_record_header(record.schema, &record.common, false)?;
    let payload = &record.product_evidence;
    validate_product_identity(&payload.product)?;
    validate_registry_bindings(&payload.selecting_registries)?;
    validate_named_artifacts(&payload.resolved_formula_layers)?;
    validate_sha256(&payload.resolved_inputs_sha256)?;
    for artifact in [
        &payload.vfs_image,
        &payload.builder_report,
        &payload.kernel,
        &payload.host_runtime,
    ] {
        validate_artifact(artifact, record.common.artifact_class)?;
    }
    validate_sorted_sha256s(
        &payload.evidence_definition_sha256s,
        "evidence definition digests",
        false,
    )?;
    validate_sorted_sha256s(
        &payload.verification_receipt_sha256s,
        "verification receipt digests",
        false,
    )?;
    if record.common.artifact.as_ref() != Some(&payload.vfs_image) {
        return Err("product evidence common artifact must be its exact VFS image".to_string());
    }
    Ok(())
}

fn validate_capture_authorization(
    record: &CaptureOverrideAuthorizationV1,
) -> Result<(), String> {
    validate_record_header(record.schema, &record.common, false)?;
    let payload = &record.capture_authorization;
    validate_formula_subject(&payload.formula)?;
    if payload.guard_code != GuardCodeV1::BuildInputCaptureIncomplete
        || record.common.guard_codes != [GuardCodeV1::BuildInputCaptureIncomplete]
    {
        return Err(
            "capture authorization may name only build_input_capture_incomplete".to_string(),
        );
    }
    validate_maintainer(&payload.maintainer)?;
    validate_bounded_text(&payload.justification, "override justification", 2_048)?;
    validate_policy_identity(&payload.policy)?;
    if record.common.artifact_class != ArtifactClassV1::None
        || record.common.artifact.is_some()
    {
        return Err("pre-build capture authorization cannot guess an artifact identity".to_string());
    }
    Ok(())
}

fn validate_override(record: &OverrideReceiptV1) -> Result<(), String> {
    validate_record_header(record.schema, &record.common, false)?;
    let payload = &record.override_receipt;
    validate_guard_codes(&payload.accepted_guard_codes)?;
    if payload.accepted_guard_codes.is_empty() {
        return Err("override receipt must accept at least one guard".to_string());
    }
    for code in &payload.accepted_guard_codes {
        if guard_override_policy(*code) == GuardOverridePolicyV1::Never {
            return Err(format!("guard {:?} can never be overridden", code.as_str()));
        }
    }
    if payload.accepted_guard_codes != record.common.guard_codes {
        return Err("override accepted guards do not match common guard codes".to_string());
    }
    validate_maintainer(&payload.maintainer)?;
    validate_bounded_text(&payload.justification, "override justification", 2_048)?;
    validate_policy_identity(&payload.policy)?;
    validate_sha256(&payload.candidate_record_sha256)?;
    validate_artifact(&payload.bottle_layer, ArtifactClassV1::Candidate)?;
    if payload
        .accepted_guard_codes
        .contains(&GuardCodeV1::BuildInputCaptureIncomplete)
    {
        let authorization = payload.capture_authorization_sha256.as_ref().ok_or_else(|| {
            "post-build capture override requires the exact authorization digest".to_string()
        })?;
        validate_sha256(authorization)?;
    } else if payload.capture_authorization_sha256.is_some() {
        return Err(
            "capture authorization digest is valid only for incomplete-capture override"
                .to_string(),
        );
    }
    if record.common.artifact_class != ArtifactClassV1::Candidate
        || record.common.artifact.as_ref() != Some(&payload.bottle_layer)
    {
        return Err("override receipt must bind the exact candidate bottle layer".to_string());
    }
    Ok(())
}

fn validate_admission(record: &AdmissionRecordV1) -> Result<(), String> {
    validate_record_header(record.schema, &record.common, true)?;
    let payload = &record.admission;
    validate_sha256(&payload.candidate_record_sha256)?;
    validate_artifact(&payload.promoted_layer, ArtifactClassV1::Candidate)?;
    validate_sorted_sha256s(
        &payload.qualifying_receipt_sha256s,
        "qualifying receipt digests",
        false,
    )?;
    validate_repository(&payload.merged_pull_request.repository, "merged PR repository")?;
    if payload.merged_pull_request.number == 0 {
        return Err("merged PR number must be positive".to_string());
    }
    validate_git_sha(&payload.merged_pull_request.head)?;
    validate_git_sha(&payload.merged_pull_request.merge_commit)?;
    validate_exact_git_source(&payload.tap_source)?;
    validate_artifact(&payload.canonical, ArtifactClassV1::Canonical)?;
    validate_sha256(&payload.canonical_public_readback_sha256)?;
    validate_exact_git_source(&payload.formula_metadata_source)?;
    validate_candidate_producer(&payload.original_producer)?;
    if record.common.outcome != Some(TerminalOutcomeV1::Success)
        || record.common.promotion_state != PromotionStateV1::Promoted
        || record.common.artifact_class != ArtifactClassV1::Canonical
        || record.common.artifact.as_ref() != Some(&payload.canonical)
    {
        return Err(
            "admission must be a successful promoted canonical artifact record".to_string(),
        );
    }
    Ok(())
}

fn validate_deletion(record: &DeletionRecordV1) -> Result<(), String> {
    validate_record_header(record.schema, &record.common, false)?;
    let payload = &record.deletion;
    validate_sha256(&payload.candidate_record_sha256)?;
    validate_artifact(&payload.deleted_candidate, ArtifactClassV1::Candidate)?;
    validate_bounded_text(&payload.reason, "deletion reason", 1_024)?;
    validate_timestamp(&payload.deleted_at, "deletion time")?;
    validate_sorted_sha256s(&payload.prior_record_sha256s, "prior record digests", false)?;
    if payload.admission_pinned {
        return Err("deletion record cannot name an admission-pinned candidate".to_string());
    }
    if record.common.artifact_class != ArtifactClassV1::None
        || record.common.artifact.is_some()
        || record.common.promotion_state == PromotionStateV1::Promoted
    {
        return Err("deletion record cannot delete or claim a canonical artifact".to_string());
    }
    Ok(())
}

fn validate_record_header(
    schema: u64,
    common: &RecordCommonV1,
    is_admission: bool,
) -> Result<(), String> {
    if schema != RECORD_SCHEMA {
        return Err("ABI staging record has unsupported schema".to_string());
    }
    validate_sha256(&common.request_sha256)?;
    validate_exact_subject(&common.subject)?;
    validate_exact_git_source(&common.source)?;
    validate_run(&common.run)?;
    validate_guard_codes(&common.guard_codes)?;
    if common.outcome.is_some() && common.work_state != WorkStateV1::Complete {
        return Err("terminal outcome is valid only when work_state is complete".to_string());
    }
    if common.work_state == WorkStateV1::Complete && common.outcome.is_none() {
        return Err("complete work_state requires a terminal outcome".to_string());
    }
    if common.outcome == Some(TerminalOutcomeV1::Success) && !common.blockers.is_empty() {
        return Err("successful records cannot contain blockers".to_string());
    }
    match (common.artifact_class, &common.artifact) {
        (ArtifactClassV1::None, None) => {}
        (ArtifactClassV1::None, Some(_)) => {
            return Err("artifact_class none cannot contain an artifact identity".to_string())
        }
        (_, None) => {
            return Err("non-none artifact_class requires an exact artifact identity".to_string())
        }
        (class, Some(artifact)) => validate_artifact(artifact, class)?,
    }
    if common.promotion_state == PromotionStateV1::Promoted
        && !is_admission
        && common.admission_sha256.is_none()
    {
        return Err("promoted state requires an exact admission record".to_string());
    }
    if let Some(admission) = &common.admission_sha256 {
        validate_sha256(admission)?;
    }
    validate_retry_state(&common.retry_state)?;
    validate_blockers(&common.blockers, &common.guard_codes)?;
    Ok(())
}

fn validate_request_requirements(requirements: &RequestRequirementsV1) -> Result<(), String> {
    validate_sha256(&requirements.digest)?;
    if requirements.digest != request_requirements_digest(requirements)? {
        return Err("request requirements digest does not match normalized requirements".to_string());
    }
    validate_sorted_unique(&requirements.change_classes, "request change classes", false)?;
    if requirements.products.is_empty() || requirements.products.len() > MAX_BINDINGS {
        return Err("request must bind a bounded nonempty product selection".to_string());
    }
    let mut previous_product: Option<&str> = None;
    for product in &requirements.products {
        validate_stable_id(&product.id, "request product id")?;
        validate_normalized_relative_path(&product.path, "request product path")?;
        validate_sha256(&product.manifest_sha256)?;
        if previous_product.is_some_and(|old| old >= product.id.as_str()) {
            return Err("request product bindings must be sorted and duplicate-free".to_string());
        }
        previous_product = Some(&product.id);
    }
    validate_registry_bindings(&requirements.registries)?;
    if requirements.evidence.len() > MAX_BINDINGS {
        return Err("request contains too many evidence bindings".to_string());
    }
    let mut previous_evidence: Option<&str> = None;
    for evidence in &requirements.evidence {
        validate_stable_id(&evidence.product_id, "request evidence product id")?;
        if previous_evidence.is_some_and(|old| old >= evidence.product_id.as_str()) {
            return Err("request evidence bindings must be sorted and duplicate-free".to_string());
        }
        previous_evidence = Some(&evidence.product_id);
        validate_sorted_stable_ids(&evidence.node, "Node evidence IDs", true)?;
        validate_sorted_stable_ids(&evidence.browser, "browser evidence IDs", true)?;
        if evidence.node.is_empty() && evidence.browser.is_empty() {
            return Err("request evidence binding must name Node or browser evidence".to_string());
        }
    }
    Ok(())
}

fn validate_registry_bindings(bindings: &[RequestRegistryBindingV1]) -> Result<(), String> {
    if bindings.is_empty() || bindings.len() > MAX_BINDINGS {
        return Err("registry bindings must be bounded and nonempty".to_string());
    }
    let mut previous: Option<(RequestRegistryKindV1, &str)> = None;
    for binding in bindings {
        validate_normalized_relative_path(&binding.path, "registry path")?;
        validate_sha256(&binding.sha256)?;
        let key = (binding.kind, binding.path.as_str());
        if previous.is_some_and(|old| old >= key) {
            return Err("registry bindings must be sorted and duplicate-free".to_string());
        }
        previous = Some(key);
    }
    Ok(())
}

fn validate_issuance(issuance: &RequestIssuanceV1) -> Result<(), String> {
    validate_repository(&issuance.issuer_repository, "issuer repository")?;
    validate_bounded_text(&issuance.issuer_workflow_ref, "issuer workflow ref", 1_024)?;
    if issuance.policy_version == 0 || issuance.guard_registry_version == 0 {
        return Err("policy and guard-registry versions must be positive".to_string());
    }
    validate_sha256(&issuance.policy_sha256)?;
    validate_sha256(&issuance.guard_registry_sha256)?;
    validate_git_sha(issuance.authorization.head())
}

fn validate_informational_context(context: &RequestInformationalContextV1) -> Result<(), String> {
    match (&context.base_commit, &context.base_tree) {
        (Some(commit), Some(tree)) => {
            validate_git_sha(commit)?;
            validate_git_sha(tree)?;
        }
        (None, None) => {}
        _ => return Err("informational base commit and tree must appear together".to_string()),
    }
    if let Some(ref_hint) = &context.ref_hint {
        validate_bounded_text(ref_hint, "informational ref hint", 1_024)?;
    }
    Ok(())
}

fn validate_exact_git_source(source: &ExactGitSourceV1) -> Result<(), String> {
    validate_repository(&source.repository, "source repository")?;
    validate_git_sha(&source.commit)?;
    validate_git_sha(&source.tree)
}

fn validate_target_abi(target: &TargetAbiV1) -> Result<(), String> {
    if target.version > u64::from(u32::MAX) {
        return Err("target ABI does not fit an unsigned 32-bit integer".to_string());
    }
    validate_sha256(&target.snapshot_sha256)
}

fn validate_product_identity(product: &VfsProductIdentityV1) -> Result<(), String> {
    validate_stable_id(&product.id, "product id")?;
    validate_normalized_relative_path(&product.manifest_path, "product manifest path")?;
    validate_sha256(&product.manifest_sha256)?;
    if product.output.is_empty()
        || product.output.contains(['/', '\\', '\0'])
        || !product.output.ends_with(".vfs") && !product.output.ends_with(".vfs.zst")
    {
        return Err("product output is not a VFS filename".to_string());
    }
    Ok(())
}

fn validate_exact_subject(subject: &ExactSubjectV1) -> Result<(), String> {
    validate_bounded_text(&subject.identity, "exact subject identity", 512)?;
    if subject.identity.chars().any(char::is_whitespace) {
        return Err("exact subject identity cannot contain whitespace".to_string());
    }
    match subject.kind {
        SubjectKindV1::Formula if subject.architecture.is_none() => {
            Err("Formula subject requires an exact architecture".to_string())
        }
        SubjectKindV1::Formula => Ok(()),
        _ if subject.architecture.is_some() => {
            Err("only Formula subjects may carry an architecture".to_string())
        }
        _ => Ok(()),
    }
}

fn validate_run(run: &RecordRunProvenanceV1) -> Result<(), String> {
    validate_repository(&run.repository, "run repository")?;
    validate_bounded_text(&run.workflow_ref, "run workflow ref", 1_024)?;
    validate_stable_id(&run.job, "run job")?;
    if run.run_id == 0 || run.run_attempt == 0 {
        return Err("run id and run attempt must be positive".to_string());
    }
    Ok(())
}

fn validate_retry_state(retry: &RetryStateV1) -> Result<(), String> {
    if retry.exhausted && retry.eligible {
        return Err("exhausted retry state cannot remain automatically eligible".to_string());
    }
    match retry.next_action {
        RetryNextActionV1::None if retry.eligible => {
            return Err("eligible retry state requires wait or retry action".to_string())
        }
        RetryNextActionV1::Wait | RetryNextActionV1::Retry if !retry.eligible => {
            return Err("wait or retry action requires eligible retry state".to_string())
        }
        RetryNextActionV1::MaintainerAction if !retry.exhausted => {
            return Err("maintainer retry action requires exhausted automatic retries".to_string())
        }
        _ => {}
    }
    if let Some(timestamp) = &retry.next_eligible_at {
        validate_timestamp(timestamp, "next retry eligibility")?;
    }
    Ok(())
}

fn validate_blockers(
    blockers: &[RecordBlockerV1],
    guard_codes: &[GuardCodeV1],
) -> Result<(), String> {
    if blockers.len() > MAX_BINDINGS {
        return Err("record contains too many blockers".to_string());
    }
    let mut previous: Option<(GuardCodeV1, SubjectKindV1, &str)> = None;
    for blocker in blockers {
        validate_bounded_text(&blocker.subject, "blocker subject", 512)?;
        if !guard_codes.contains(&blocker.guard_code) {
            return Err("blocker guard code is absent from record guard_codes".to_string());
        }
        if let Some(record) = &blocker.record {
            validate_record_link(record)?;
        }
        let key = (blocker.guard_code, blocker.subject_kind, blocker.subject.as_str());
        if previous.is_some_and(|old| old >= key) {
            return Err("record blockers must be sorted and duplicate-free".to_string());
        }
        previous = Some(key);
    }
    Ok(())
}

fn validate_guard_codes(codes: &[GuardCodeV1]) -> Result<(), String> {
    validate_sorted_unique(codes, "guard codes", true)
}

fn validate_artifact(
    artifact: &ArtifactIdentityV1,
    class: ArtifactClassV1,
) -> Result<(), String> {
    validate_sha256(&artifact.sha256)?;
    if artifact.bytes == 0 {
        return Err("artifact identity must contain a positive byte count".to_string());
    }
    if let Some(reference) = &artifact.immutable_reference {
        validate_bounded_text(reference, "artifact immutable reference", 4_096)?;
        if reference.chars().any(char::is_whitespace) {
            return Err("artifact immutable reference cannot contain whitespace".to_string());
        }
        if !reference.contains(&format!("sha256:{}", artifact.sha256))
            && !reference.contains(&format!("sha256={}", artifact.sha256))
        {
            return Err("artifact immutable reference does not bind its SHA-256".to_string());
        }
    } else if matches!(class, ArtifactClassV1::Candidate | ArtifactClassV1::Canonical) {
        return Err("candidate and canonical artifacts require immutable references".to_string());
    }
    Ok(())
}

fn validate_named_artifacts(artifacts: &[NamedArtifactIdentityV1]) -> Result<(), String> {
    if artifacts.len() > MAX_BINDINGS {
        return Err("record contains too many named artifacts".to_string());
    }
    let mut previous: Option<&str> = None;
    for artifact in artifacts {
        validate_stable_id(&artifact.id, "named artifact id")?;
        if previous.is_some_and(|old| old >= artifact.id.as_str()) {
            return Err("named artifacts must be sorted and duplicate-free".to_string());
        }
        previous = Some(&artifact.id);
        validate_artifact(&artifact.artifact, ArtifactClassV1::Candidate)?;
    }
    Ok(())
}

fn validate_formula_subject(formula: &FormulaBuildSubjectV1) -> Result<(), String> {
    validate_repository(&formula.tap, "Formula tap")?;
    validate_stable_id(&formula.formula, "Formula name")?;
    validate_sha256(&formula.bottle_contract_sha256)
}

fn validate_candidate_formula(formula: &CandidateFormulaV1) -> Result<(), String> {
    validate_repository(&formula.tap, "Formula tap")?;
    validate_stable_id(&formula.formula, "Formula name")?;
    validate_bounded_text(&formula.version, "Formula version", 256)?;
    validate_sha256(&formula.bottle_contract_sha256)
}

fn validate_candidate_producer(producer: &CandidateProducerV1) -> Result<(), String> {
    validate_sha256(&producer.request_sha256)?;
    validate_git_sha(&producer.head)?;
    if producer.run_id == 0 {
        return Err("candidate producer run id must be positive".to_string());
    }
    Ok(())
}

fn validate_runner_facts(facts: &RunnerBuildFactsV1) -> Result<(), String> {
    validate_bounded_text(&facts.runner_image, "runner image", 512)?;
    validate_sha256(&facts.command_sha256)?;
    validate_sha256(&facts.result_sha256)?;
    validate_record_links(&facts.diagnostics)
}

fn validate_record_links(links: &[RecordLinkV1]) -> Result<(), String> {
    if links.len() > MAX_BINDINGS {
        return Err("record contains too many record links".to_string());
    }
    for link in links {
        validate_record_link(link)?;
    }
    Ok(())
}

fn validate_sorted_record_links(links: &[RecordLinkV1], field: &str) -> Result<(), String> {
    if links.is_empty() || links.len() > MAX_BINDINGS {
        return Err(format!("{field} must contain a bounded qualifying receipt"));
    }
    let mut previous: Option<&str> = None;
    for link in links {
        validate_record_link(link)?;
        if previous.is_some_and(|old| old >= link.record_sha256.as_str()) {
            return Err(format!("{field} must be sorted and duplicate-free"));
        }
        previous = Some(&link.record_sha256);
    }
    Ok(())
}

fn validate_record_link(link: &RecordLinkV1) -> Result<(), String> {
    validate_sha256(&link.record_sha256)?;
    validate_bounded_text(&link.immutable_reference, "record immutable reference", 4_096)?;
    if !link
        .immutable_reference
        .contains(&format!("sha256:{}", link.record_sha256))
    {
        return Err("record immutable reference does not bind its digest".to_string());
    }
    Ok(())
}

fn validate_maintainer(maintainer: &MaintainerAuthorizationV1) -> Result<(), String> {
    validate_stable_id(&maintainer.login, "maintainer login")?;
    validate_bounded_text(&maintainer.permission, "maintainer permission", 128)?;
    validate_bounded_text(
        &maintainer.authorization_reference,
        "maintainer authorization reference",
        2_048,
    )
}

fn validate_policy_identity(policy: &PolicyIdentityV1) -> Result<(), String> {
    if policy.policy_version == 0 || policy.guard_registry_version == 0 {
        return Err("override policy versions must be positive".to_string());
    }
    validate_sha256(&policy.policy_sha256)?;
    validate_sha256(&policy.guard_registry_sha256)
}

fn validate_sorted_sha256s(
    values: &[String],
    field: &str,
    allow_empty: bool,
) -> Result<(), String> {
    if !allow_empty && values.is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    let mut previous: Option<&str> = None;
    for value in values {
        validate_sha256(value)?;
        if previous.is_some_and(|old| old >= value.as_str()) {
            return Err(format!("{field} must be sorted and duplicate-free"));
        }
        previous = Some(value);
    }
    Ok(())
}

fn validate_sorted_stable_ids(
    values: &[String],
    field: &str,
    allow_empty: bool,
) -> Result<(), String> {
    if !allow_empty && values.is_empty() {
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

fn validate_sorted_unique<T: Ord>(
    values: &[T],
    field: &str,
    allow_empty: bool,
) -> Result<(), String> {
    if !allow_empty && values.is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    if values.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(format!("{field} must be sorted and duplicate-free"));
    }
    Ok(())
}

fn validate_repository(value: &str, field: &str) -> Result<(), String> {
    validate_bounded_text(value, field, 256)?;
    if value.split('/').count() != 2
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'_' | b'-'))
    {
        return Err(format!("{field} must be an exact owner/name identity"));
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
        return Err(format!("{field} is not a normalized repository-relative path"));
    }
    Ok(())
}

fn validate_bounded_text(value: &str, field: &str, maximum: usize) -> Result<(), String> {
    if value.is_empty() || value.len() > maximum || value.contains('\0') {
        return Err(format!("{field} must contain 1 through {maximum} UTF-8 bytes"));
    }
    Ok(())
}

fn validate_timestamp(value: &str, field: &str) -> Result<(), String> {
    validate_bounded_text(value, field, 64)?;
    if !value.ends_with('Z') || !value.contains('T') {
        return Err(format!("{field} must be a UTC RFC 3339 timestamp"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SHA_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const SHA_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const COMMIT_A: &str = "1111111111111111111111111111111111111111";
    const TREE_A: &str = "2222222222222222222222222222222222222222";

    fn artifact(sha256: &str, class: ArtifactClassV1) -> ArtifactIdentityV1 {
        ArtifactIdentityV1 {
            sha256: sha256.to_string(),
            bytes: 12,
            immutable_reference: match class {
                ArtifactClassV1::Candidate => Some(format!(
                    "ghcr.io/kandelo-dev/homebrew-tap-core-abi-7-candidates/item@sha256:{sha256}"
                )),
                ArtifactClassV1::Canonical => Some(format!(
                    "ghcr.io/kandelo-dev/homebrew-tap-core-abi-7/item@sha256:{sha256}"
                )),
                ArtifactClassV1::None | ArtifactClassV1::Diagnostic => None,
            },
        }
    }

    fn common(
        subject_kind: SubjectKindV1,
        artifact_class: ArtifactClassV1,
        artifact: Option<ArtifactIdentityV1>,
    ) -> RecordCommonV1 {
        RecordCommonV1 {
            request_sha256: SHA_A.to_string(),
            subject: ExactSubjectV1 {
                kind: subject_kind,
                identity: match subject_kind {
                    SubjectKindV1::Formula => "kandelo-dev/homebrew-tap-core/bash".to_string(),
                    SubjectKindV1::Product => "mini-shell".to_string(),
                    SubjectKindV1::Candidate => SHA_B.to_string(),
                    SubjectKindV1::Request => SHA_A.to_string(),
                    SubjectKindV1::SourceCustody => SHA_C.to_string(),
                    SubjectKindV1::Pages => "pages".to_string(),
                },
                architecture: (subject_kind == SubjectKindV1::Formula)
                    .then_some(VfsArchitectureV1::Wasm32),
            },
            source: source(),
            run: RecordRunProvenanceV1 {
                repository: "kandelo-dev/homebrew-tap-core".to_string(),
                workflow_ref: ".github/workflows/staging.yml@refs/heads/main".to_string(),
                run_id: 9,
                run_attempt: 1,
                job: "publish".to_string(),
            },
            guard_codes: Vec::new(),
            work_state: WorkStateV1::Complete,
            outcome: Some(TerminalOutcomeV1::Success),
            artifact_class,
            artifact,
            promotion_state: PromotionStateV1::Eligible,
            admission_sha256: None,
            retry_state: RetryStateV1 {
                attempts: 1,
                eligible: false,
                exhausted: false,
                next_action: RetryNextActionV1::None,
                next_eligible_at: None,
            },
            blockers: Vec::new(),
        }
    }

    fn source() -> ExactGitSourceV1 {
        ExactGitSourceV1 {
            repository: "automattic/kandelo".to_string(),
            commit: COMMIT_A.to_string(),
            tree: TREE_A.to_string(),
        }
    }

    fn formula() -> FormulaBuildSubjectV1 {
        FormulaBuildSubjectV1 {
            tap: "kandelo-dev/homebrew-tap-core".to_string(),
            formula: "bash".to_string(),
            architecture: VfsArchitectureV1::Wasm32,
            target_abi: 7,
            bottle_contract_sha256: SHA_B.to_string(),
        }
    }

    fn attempt_record() -> AbiStagingRecordV1 {
        let candidate = artifact(SHA_B, ArtifactClassV1::Candidate);
        AbiStagingRecordV1::Attempt(AttemptRecordV1 {
            schema: 1,
            common: common(
                SubjectKindV1::Formula,
                ArtifactClassV1::Candidate,
                Some(candidate.clone()),
            ),
            attempt: AttemptPayloadV1 {
                formula: formula(),
                source_capsule: artifact(SHA_C, ArtifactClassV1::Candidate),
                build: RunnerBuildFactsV1 {
                    runner_image: "ubuntu-24.04".to_string(),
                    command_sha256: SHA_A.to_string(),
                    result_sha256: SHA_B.to_string(),
                    diagnostics: Vec::new(),
                },
                retry_ordinal: 0,
                candidate: Some(candidate),
            },
        })
    }

    fn candidate_reuse_vector() -> AbiStagingRecordV1 {
        let bottle_contract =
            "c749b0e5861571ad605600e2dcf26029243649a43b410245a1c7542f3cd07f7c";
        let bottle_layer = ArtifactIdentityV1 {
            sha256: SHA_C.to_string(),
            bytes: 4567,
            immutable_reference: Some(format!(
                "ghcr.io/kandelo-dev/homebrew-tap-core-abi-8-candidates/curl@sha256:{SHA_C}"
            )),
        };
        AbiStagingRecordV1::CandidateReuse(CandidateReuseRecordV1 {
            schema: 1,
            common: RecordCommonV1 {
                request_sha256:
                    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
                        .to_string(),
                subject: ExactSubjectV1 {
                    kind: SubjectKindV1::Formula,
                    identity: "kandelo-dev/homebrew-tap-core/curl".to_string(),
                    architecture: Some(VfsArchitectureV1::Wasm32),
                },
                source: ExactGitSourceV1 {
                    repository: "automattic/kandelo".to_string(),
                    commit: "4444444444444444444444444444444444444444".to_string(),
                    tree: "5555555555555555555555555555555555555555".to_string(),
                },
                run: RecordRunProvenanceV1 {
                    repository: "kandelo-dev/homebrew-tap-core".to_string(),
                    workflow_ref: ".github/workflows/staging.yml@refs/heads/main".to_string(),
                    run_id: 88,
                    run_attempt: 1,
                    job: "reuse".to_string(),
                },
                guard_codes: Vec::new(),
                work_state: WorkStateV1::Complete,
                outcome: Some(TerminalOutcomeV1::Success),
                artifact_class: ArtifactClassV1::Candidate,
                artifact: Some(bottle_layer.clone()),
                promotion_state: PromotionStateV1::Eligible,
                admission_sha256: None,
                retry_state: RetryStateV1 {
                    attempts: 0,
                    eligible: false,
                    exhausted: false,
                    next_action: RetryNextActionV1::None,
                    next_eligible_at: None,
                },
                blockers: Vec::new(),
            },
            candidate_reuse: CandidateReusePayloadV1 {
                formula: FormulaBuildSubjectV1 {
                    tap: "kandelo-dev/homebrew-tap-core".to_string(),
                    formula: "curl".to_string(),
                    architecture: VfsArchitectureV1::Wasm32,
                    target_abi: 8,
                    bottle_contract_sha256: bottle_contract.to_string(),
                },
                existing_candidate: RecordLinkV1 {
                    record_sha256: SHA_A.to_string(),
                    immutable_reference: format!(
                        "ghcr.io/kandelo-dev/homebrew-tap-core-abi-8-candidates/record@sha256:{SHA_A}"
                    ),
                },
                bottle_layer,
                source_custody: RecordLinkV1 {
                    record_sha256: SHA_B.to_string(),
                    immutable_reference: format!(
                        "ghcr.io/kandelo-dev/homebrew-tap-core-abi-8-source-custody/record@sha256:{SHA_B}"
                    ),
                },
                qualifying_receipts: vec![RecordLinkV1 {
                    record_sha256:
                        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                            .to_string(),
                    immutable_reference: concat!(
                        "ghcr.io/kandelo-dev/homebrew-tap-core-abi-8-candidates/",
                        "receipt@sha256:",
                        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                    )
                    .to_string(),
                }],
                original_producer: CandidateProducerV1 {
                    request_sha256:
                        "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
                            .to_string(),
                    head: "3333333333333333333333333333333333333333".to_string(),
                    run_id: 77,
                },
                nonendorsed: true,
            },
        })
    }

    fn request(head: &str, policy_sha256: &str) -> AbiStagingRequestV1 {
        let mut requirements = RequestRequirementsV1 {
            digest: SHA_A.to_string(),
            change_classes: vec![ChangeClass::Abi],
            products: vec![RequestProductBindingV1 {
                id: "mini-shell".to_string(),
                path: "images/vfs/products/mini-shell.toml".to_string(),
                manifest_sha256: SHA_B.to_string(),
            }],
            registries: vec![RequestRegistryBindingV1 {
                kind: RequestRegistryKindV1::Pages,
                path: "apps/browser/pages-vfs-products.toml".to_string(),
                sha256: SHA_C.to_string(),
            }],
            evidence: vec![RequestEvidenceBindingV1 {
                product_id: "mini-shell".to_string(),
                applicability: ApplicabilityV1::Required,
                node: vec!["mini-node".to_string()],
                browser: vec!["mini-browser".to_string()],
            }],
        };
        requirements.digest = request_requirements_digest(&requirements).unwrap();
        AbiStagingRequestV1 {
            schema: 1,
            kind: REQUEST_KIND.to_string(),
            pull_request: PullRequestRequestIdentityV1 {
                repository: "automattic/kandelo".to_string(),
                number: 19,
            },
            build_source: ExactGitSourceV1 {
                repository: "automattic/kandelo".to_string(),
                commit: head.to_string(),
                tree: TREE_A.to_string(),
            },
            target_abi: TargetAbiV1 {
                version: 7,
                snapshot_sha256: SHA_A.to_string(),
            },
            requirements,
            issuance: RequestIssuanceV1 {
                issuer_repository: "automattic/kandelo".to_string(),
                issuer_workflow_ref: ".github/workflows/request.yml@refs/heads/main".to_string(),
                policy_version: 1,
                policy_sha256: policy_sha256.to_string(),
                guard_registry_version: 1,
                guard_registry_sha256: SHA_C.to_string(),
                authorization: RequestAuthorizationV1::SameRepository {
                    head: head.to_string(),
                },
            },
            informational_context: RequestInformationalContextV1 {
                base_commit: None,
                base_tree: None,
                previous_abi: Some(6),
                ref_hint: Some("refs/heads/feature".to_string()),
            },
        }
    }

    #[test]
    fn exact_request_name_and_parser_bind_full_head_digest_and_canonical_bytes() {
        let request = request(COMMIT_A, SHA_B);
        validate_request(&request).unwrap();
        let bytes = canonical_json_bytes(&request).unwrap();
        let digest = canonical_sha256(&request).unwrap();
        let name = candidate_request_asset_name(COMMIT_A, &digest).unwrap();
        assert_eq!(
            name,
            format!("candidate-request-{COMMIT_A}-sha256-{digest}.json")
        );
        assert_eq!(parse_candidate_request_asset(&name, &bytes).unwrap(), request);

        for invalid in [
            format!("candidate-request-{}-sha256-{digest}.json", &COMMIT_A[..12]),
            format!("candidate-request-{}-sha256-{digest}.json", "3".repeat(40)),
            format!("candidate-request-{COMMIT_A}-sha256-{}.json", "4".repeat(64)),
            "candidate-request-latest.json".to_string(),
            name.to_ascii_uppercase(),
        ] {
            assert!(parse_candidate_request_asset(&invalid, &bytes).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn same_head_policy_reissuance_changes_digest_and_historical_heads_remain_valid() {
        let first = request(COMMIT_A, SHA_A);
        let second = request(COMMIT_A, SHA_B);
        assert_ne!(canonical_sha256(&first).unwrap(), canonical_sha256(&second).unwrap());

        for candidate in [&first, &second] {
            let bytes = canonical_json_bytes(candidate).unwrap();
            let digest = canonical_sha256(candidate).unwrap();
            let name = candidate_request_asset_name(COMMIT_A, &digest).unwrap();
            parse_candidate_request_asset(&name, &bytes).unwrap();
        }
        let advanced_head = "ffffffffffffffffffffffffffffffffffffffff";
        assert!(!request_is_current(
            &first,
            advanced_head,
            &first.requirements.digest,
            first.issuance.policy_version,
            &first.issuance.policy_sha256,
            first.issuance.guard_registry_version,
            &first.issuance.guard_registry_sha256,
        ));
        let bytes = canonical_json_bytes(&first).unwrap();
        let name = candidate_request_asset_name(COMMIT_A, &canonical_sha256(&first).unwrap()).unwrap();
        assert!(parse_candidate_request_asset(&name, &bytes).is_ok());
    }

    #[test]
    fn only_exact_head_and_policy_identities_decide_current_applicability() {
        let mut request = request(COMMIT_A, SHA_B);
        let current = |request: &AbiStagingRequestV1| {
            request_is_current(
                request,
                COMMIT_A,
                &request.requirements.digest,
                1,
                SHA_B,
                1,
                SHA_C,
            )
        };
        assert!(current(&request));
        request.informational_context.ref_hint = Some("refs/heads/zzz".to_string());
        request.informational_context.base_commit = Some("ffffffffffffffffffffffffffffffffffffffff".to_string());
        request.informational_context.base_tree = Some("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".to_string());
        assert!(current(&request));

        let mut value = serde_json::to_value(&request).unwrap();
        value["issued_at"] = json!("2099-01-01T00:00:00Z");
        let bytes = canonical_json_bytes(&value).unwrap();
        let digest = canonical_sha256(&request).unwrap();
        let name = candidate_request_asset_name(COMMIT_A, &digest).unwrap();
        assert!(parse_candidate_request_asset(&name, &bytes)
            .unwrap_err()
            .contains("unknown field"));
    }

    #[test]
    fn record_state_invariants_reject_every_contradictory_pair() {
        let mut record = attempt_record();
        let AbiStagingRecordV1::Attempt(attempt) = &mut record else {
            unreachable!()
        };
        attempt.common.work_state = WorkStateV1::Running;
        assert!(validate_record(&record)
            .unwrap_err()
            .contains("terminal outcome"));

        let mut record = attempt_record();
        let AbiStagingRecordV1::Attempt(attempt) = &mut record else {
            unreachable!()
        };
        attempt.common.blockers.push(RecordBlockerV1 {
            guard_code: GuardCodeV1::BuildFailed,
            subject_kind: SubjectKindV1::Formula,
            subject: "bash".to_string(),
            record: None,
        });
        attempt.common.guard_codes = vec![GuardCodeV1::BuildFailed];
        assert!(validate_record(&record)
            .unwrap_err()
            .contains("successful records"));

        let mut record = attempt_record();
        let AbiStagingRecordV1::Attempt(attempt) = &mut record else {
            unreachable!()
        };
        attempt.attempt.candidate = None;
        assert!(validate_record(&record)
            .unwrap_err()
            .contains("without candidate bytes"));

        let mut record = attempt_record();
        let AbiStagingRecordV1::Attempt(attempt) = &mut record else {
            unreachable!()
        };
        attempt.common.promotion_state = PromotionStateV1::Promoted;
        assert!(validate_record(&record)
            .unwrap_err()
            .contains("admission record"));

        let mut record = attempt_record();
        let AbiStagingRecordV1::Attempt(attempt) = &mut record else {
            unreachable!()
        };
        attempt.common.subject.identity = "malformed subject".to_string();
        assert!(validate_record(&record)
            .unwrap_err()
            .contains("whitespace"));
    }

    #[test]
    fn capture_authorization_is_exact_separate_and_immutable_by_digest() {
        let mut common = common(SubjectKindV1::Formula, ArtifactClassV1::None, None);
        common.guard_codes = vec![GuardCodeV1::BuildInputCaptureIncomplete];
        let record = AbiStagingRecordV1::CaptureOverrideAuthorization(
            CaptureOverrideAuthorizationV1 {
                schema: 1,
                common,
                capture_authorization: CaptureOverrideAuthorizationPayloadV1 {
                    formula: formula(),
                    guard_code: GuardCodeV1::BuildInputCaptureIncomplete,
                    maintainer: maintainer(),
                    justification: "Exact source capture cannot observe one declared host tool.".to_string(),
                    policy: policy(),
                },
            },
        );
        validate_record(&record).unwrap();
        let original = canonical_sha256(&record).unwrap();
        let mut mutated = record.clone();
        let AbiStagingRecordV1::CaptureOverrideAuthorization(record) = &mut mutated else {
            unreachable!()
        };
        record.capture_authorization.justification.push_str(" Mutated.");
        assert_ne!(original, canonical_sha256(&mutated).unwrap());

        let mut incomplete = mutated;
        let AbiStagingRecordV1::CaptureOverrideAuthorization(record) = &mut incomplete else {
            unreachable!()
        };
        record.capture_authorization.formula.bottle_contract_sha256.clear();
        assert!(validate_record(&incomplete).is_err());
    }

    #[test]
    fn overrides_reject_never_guards_and_require_exact_post_build_candidate_identity() {
        let candidate = artifact(SHA_B, ArtifactClassV1::Candidate);
        let mut common = common(
            SubjectKindV1::Candidate,
            ArtifactClassV1::Candidate,
            Some(candidate.clone()),
        );
        common.guard_codes = vec![GuardCodeV1::RequestInvalid];
        let mut record = AbiStagingRecordV1::Override(OverrideReceiptV1 {
            schema: 1,
            common,
            override_receipt: OverridePayloadV1 {
                accepted_guard_codes: vec![GuardCodeV1::RequestInvalid],
                maintainer: maintainer(),
                justification: "Reviewed exact artifact risk.".to_string(),
                policy: policy(),
                candidate_record_sha256: SHA_C.to_string(),
                bottle_layer: candidate,
                capture_authorization_sha256: None,
            },
        });
        assert!(validate_record(&record)
            .unwrap_err()
            .contains("never be overridden"));

        {
            let AbiStagingRecordV1::Override(override_record) = &mut record else {
                unreachable!()
            };
            override_record.common.guard_codes =
                vec![GuardCodeV1::BuildInputCaptureIncomplete];
            override_record.override_receipt.accepted_guard_codes =
                vec![GuardCodeV1::BuildInputCaptureIncomplete];
            override_record.override_receipt.candidate_record_sha256.clear();
        }
        assert!(validate_record(&record).is_err());
        let AbiStagingRecordV1::Override(override_record) = &mut record else {
            unreachable!()
        };
        override_record.override_receipt.candidate_record_sha256 = SHA_C.to_string();
        assert!(validate_record(&record)
            .unwrap_err()
            .contains("authorization digest"));
    }

    #[test]
    fn candidate_reuse_preserves_existing_artifacts_and_original_producer() {
        let record = candidate_reuse_vector();
        validate_record(&record).unwrap();
        let bytes = canonical_json_bytes(&record).unwrap();
        assert_eq!(parse_record(&bytes).unwrap(), record);
        assert_eq!(
            canonical_sha256(&record).unwrap(),
            "db70ec2851481d96c4fd88a4a659de77537afc3afd146bda2a44f93b9fb23b6e"
        );

        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("candidate-reuse.json");
        std::fs::write(&path, &bytes).unwrap();
        run_cli(
            "validate",
            &["--record".to_string(), path.display().to_string()],
        )
        .unwrap();

        let mut mismatched = record.clone();
        let AbiStagingRecordV1::CandidateReuse(reuse) = &mut mismatched else {
            unreachable!()
        };
        reuse.candidate_reuse.bottle_layer.sha256 = SHA_C.to_string();
        reuse.candidate_reuse.bottle_layer.immutable_reference = Some(format!(
            "ghcr.io/kandelo-dev/homebrew-tap-core-abi-7-candidates/item@sha256:{SHA_C}"
        ));
        assert!(validate_record(&mismatched)
            .unwrap_err()
            .contains("exact existing bottle layer"));

        let mut incomplete = record;
        let AbiStagingRecordV1::CandidateReuse(reuse) = &mut incomplete else {
            unreachable!()
        };
        reuse.candidate_reuse.qualifying_receipts.clear();
        assert!(validate_record(&incomplete)
            .unwrap_err()
            .contains("qualifying receipt"));
    }

    #[test]
    fn closed_record_enum_validates_all_nine_durable_record_kinds() {
        let candidate_layer = artifact(SHA_B, ArtifactClassV1::Candidate);
        let canonical = artifact(SHA_C, ArtifactClassV1::Canonical);
        let mut candidate_common = common(
            SubjectKindV1::Candidate,
            ArtifactClassV1::Candidate,
            Some(candidate_layer.clone()),
        );
        candidate_common.promotion_state = PromotionStateV1::Eligible;
        let candidate = AbiStagingRecordV1::Candidate(CandidateRecordV1 {
            schema: 1,
            common: candidate_common,
            candidate: CandidatePayloadV1 {
                formula: CandidateFormulaV1 {
                    tap: "kandelo-dev/homebrew-tap-core".to_string(),
                    formula: "bash".to_string(),
                    version: "1.0".to_string(),
                    revision: 0,
                    bottle_rebuild: 0,
                    architecture: VfsArchitectureV1::Wasm32,
                    target_abi: 7,
                    bottle_contract_sha256: SHA_A.to_string(),
                },
                bottle_layer: candidate_layer.clone(),
                normalized_components: Vec::new(),
                direct_dependency_layers: Vec::new(),
                source_custody_sha256: SHA_C.to_string(),
                producer: producer(),
                nonendorsed: true,
            },
        });

        let verification = AbiStagingRecordV1::Verification(VerificationReceiptV1 {
            schema: 1,
            common: common(SubjectKindV1::Candidate, ArtifactClassV1::None, None),
            verification: VerificationPayloadV1 {
                candidate_record_sha256: SHA_C.to_string(),
                candidate_layer: candidate_layer.clone(),
                test_definition_sha256: SHA_A.to_string(),
                host: VerificationHostV1::Node,
                kernel: None,
                host_runtime: None,
                vfs: None,
                attempt_ordinal: 0,
                diagnostics: Vec::new(),
            },
        });

        let vfs = artifact(SHA_A, ArtifactClassV1::Candidate);
        let product = AbiStagingRecordV1::ProductEvidence(ProductEvidenceRecordV1 {
            schema: 1,
            common: common(
                SubjectKindV1::Product,
                ArtifactClassV1::Candidate,
                Some(vfs.clone()),
            ),
            product_evidence: ProductEvidencePayloadV1 {
                product: VfsProductIdentityV1 {
                    id: "mini-shell".to_string(),
                    manifest_path: "images/vfs/products/mini-shell.toml".to_string(),
                    manifest_sha256: SHA_B.to_string(),
                    architecture: VfsArchitectureV1::Wasm32,
                    output: "mini-shell.vfs".to_string(),
                },
                selecting_registries: vec![RequestRegistryBindingV1 {
                    kind: RequestRegistryKindV1::Pages,
                    path: "apps/browser/pages.toml".to_string(),
                    sha256: SHA_A.to_string(),
                }],
                resolved_formula_layers: Vec::new(),
                resolved_inputs_sha256: SHA_A.to_string(),
                vfs_image: vfs,
                builder_report: artifact(SHA_B, ArtifactClassV1::Candidate),
                kernel: artifact(SHA_B, ArtifactClassV1::Candidate),
                host_runtime: artifact(SHA_C, ArtifactClassV1::Candidate),
                evidence_definition_sha256s: vec![SHA_A.to_string()],
                verification_receipt_sha256s: vec![SHA_B.to_string()],
            },
        });

        let mut capture_common = common(SubjectKindV1::Formula, ArtifactClassV1::None, None);
        capture_common.guard_codes = vec![GuardCodeV1::BuildInputCaptureIncomplete];
        let capture = AbiStagingRecordV1::CaptureOverrideAuthorization(
            CaptureOverrideAuthorizationV1 {
                schema: 1,
                common: capture_common,
                capture_authorization: CaptureOverrideAuthorizationPayloadV1 {
                    formula: formula(),
                    guard_code: GuardCodeV1::BuildInputCaptureIncomplete,
                    maintainer: maintainer(),
                    justification: "Accept exact captured build risk.".to_string(),
                    policy: policy(),
                },
            },
        );

        let mut override_common = common(
            SubjectKindV1::Candidate,
            ArtifactClassV1::Candidate,
            Some(candidate_layer.clone()),
        );
        override_common.guard_codes = vec![GuardCodeV1::VerificationFailed];
        override_common.promotion_state = PromotionStateV1::AcceptedWithOverride;
        let override_receipt = AbiStagingRecordV1::Override(OverrideReceiptV1 {
            schema: 1,
            common: override_common,
            override_receipt: OverridePayloadV1 {
                accepted_guard_codes: vec![GuardCodeV1::VerificationFailed],
                maintainer: maintainer(),
                justification: "Accept exact candidate behavior.".to_string(),
                policy: policy(),
                candidate_record_sha256: SHA_C.to_string(),
                bottle_layer: candidate_layer.clone(),
                capture_authorization_sha256: None,
            },
        });

        let mut admission_common = common(
            SubjectKindV1::Candidate,
            ArtifactClassV1::Canonical,
            Some(canonical.clone()),
        );
        admission_common.promotion_state = PromotionStateV1::Promoted;
        let admission = AbiStagingRecordV1::Admission(AdmissionRecordV1 {
            schema: 1,
            common: admission_common,
            admission: AdmissionPayloadV1 {
                candidate_record_sha256: SHA_A.to_string(),
                promoted_layer: candidate_layer.clone(),
                qualifying_receipt_sha256s: vec![SHA_B.to_string()],
                merged_pull_request: MergedPullRequestV1 {
                    repository: "automattic/kandelo".to_string(),
                    number: 19,
                    head: COMMIT_A.to_string(),
                    merge_commit: "3333333333333333333333333333333333333333".to_string(),
                },
                tap_source: source(),
                canonical: canonical,
                canonical_public_readback_sha256: SHA_C.to_string(),
                formula_metadata_source: source(),
                original_producer: producer(),
            },
        });

        let deletion = AbiStagingRecordV1::Deletion(DeletionRecordV1 {
            schema: 1,
            common: common(SubjectKindV1::Candidate, ArtifactClassV1::None, None),
            deletion: DeletionPayloadV1 {
                candidate_record_sha256: SHA_A.to_string(),
                deleted_candidate: candidate_layer,
                reason: "Closed unmerged request exceeded retention grace.".to_string(),
                deleted_at: "2026-08-09T00:00:00Z".to_string(),
                prior_record_sha256s: vec![SHA_B.to_string()],
                admission_pinned: false,
            },
        });

        for record in [
            attempt_record(),
            candidate,
            candidate_reuse_vector(),
            verification,
            product,
            capture,
            override_receipt,
            admission,
            deletion,
        ] {
            validate_record(&record).unwrap();
            let bytes = canonical_json_bytes(&record).unwrap();
            assert_eq!(parse_record(&bytes).unwrap(), record);
        }
    }

    fn maintainer() -> MaintainerAuthorizationV1 {
        MaintainerAuthorizationV1 {
            login: "maintainer".to_string(),
            permission: "maintain".to_string(),
            authorization_reference: "https://github.com/automattic/kandelo/issues/19#issuecomment-1"
                .to_string(),
        }
    }

    fn policy() -> PolicyIdentityV1 {
        PolicyIdentityV1 {
            policy_version: 1,
            policy_sha256: SHA_A.to_string(),
            guard_registry_version: 1,
            guard_registry_sha256: SHA_B.to_string(),
        }
    }

    fn producer() -> CandidateProducerV1 {
        CandidateProducerV1 {
            request_sha256: SHA_A.to_string(),
            head: COMMIT_A.to_string(),
            run_id: 9,
        }
    }
}

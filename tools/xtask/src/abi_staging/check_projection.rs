use crate::abi_staging::canonical_json::{
    canonical_json_bytes, canonical_sha256, validate_git_sha, validate_sha256, validate_stable_id,
};
use crate::abi_staging::consumer_registry::ApplicabilityV1;
use crate::abi_staging::guard_registry::GuardCodeV1;
use crate::abi_staging::product_manifest::VfsArchitectureV1;
use crate::abi_staging::product_manifest::{atomic_write_regular, read_bounded_regular_file};
use crate::abi_staging::request_feed::request_asset_url;
use crate::abi_staging::records::{
    AbiStagingRecordV1, AbiStagingRequestV1, PromotionStateV1, RecordCommonV1, RetryNextActionV1,
    SubjectKindV1, TerminalOutcomeV1, WorkStateV1, request_is_current, validate_record,
    validate_request,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::Path;

const INPUT_SCHEMA: u64 = 1;
const INPUT_KIND: &str = "kandelo-abi-staging-check-projection-input";
const CHECK_NAME: &str = "Kandelo PR Check";
const MAX_RECORDS: usize = 16_384;
const MAX_SUBJECTS: usize = 8_192;
const MAX_REFERENCE_BYTES: usize = 4_096;
const MAX_SUMMARY_BYTES: usize = 8 * 1024;
const MAX_DETAILS_BYTES: usize = 48 * 1024;
const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_ACTIVATION_BYTES: usize = 64 * 1024;
const ACTIVATION_KIND: &str = "kandelo-abi-staging-required-check-activation";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CurrentCheckContextV1 {
    pub repository: String,
    pub pull_request_number: u64,
    pub exact_head: String,
    pub current_requirements_sha256: String,
    pub current_policy_version: u64,
    pub current_policy_sha256: String,
    pub current_guard_registry_version: u64,
    pub current_guard_registry_sha256: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputedCheckConclusionV1 {
    NotApplicable,
    Pending,
    Failure,
    Success,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckSubjectStateV1 {
    Pending,
    Blocked,
    Queued,
    Running,
    Success,
    Failure,
    Timeout,
    Canceled,
    Skipped,
    AcceptedWithOverride,
}

impl CheckSubjectStateV1 {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Blocked => "blocked",
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Success => "success",
            Self::Failure => "failure",
            Self::Timeout => "timeout",
            Self::Canceled => "canceled",
            Self::Skipped => "skipped",
            Self::AcceptedWithOverride => "accepted_with_override",
        }
    }

    fn is_ready(self) -> bool {
        matches!(self, Self::Success | Self::AcceptedWithOverride)
    }

    fn is_terminal_failure(self) -> bool {
        matches!(
            self,
            Self::Failure | Self::Timeout | Self::Canceled | Self::Skipped
        )
    }

    fn is_blocking(self) -> bool {
        self == Self::Blocked || self.is_terminal_failure()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RecordLinkV1 {
    pub kind: String,
    pub digest: String,
    pub immutable_reference: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SubjectProjectionV1 {
    pub subject: String,
    pub state: CheckSubjectStateV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record: Option<RecordLinkV1>,
    pub guard_codes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProductProjectionV1 {
    pub product_id: String,
    pub manifest_sha256: String,
    pub state: CheckSubjectStateV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<RecordLinkV1>,
    pub guard_codes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BlockerV1 {
    pub guard_code: GuardCodeV1,
    pub subject_kind: String,
    pub subject: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record: Option<RecordLinkV1>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RequiredCheckActivationV1 {
    Observe,
    Enforce,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct RequiredCheckActivationDocumentV1 {
    schema: u64,
    kind: String,
    mode: RequiredCheckActivationV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CurrentCheckProjectionV1 {
    pub name: String,
    pub external_id: String,
    pub head_sha: String,
    pub computed_conclusion: ComputedCheckConclusionV1,
    pub published_conclusion: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<RecordLinkV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tap_plan: Option<RecordLinkV1>,
    pub required_formulae: Vec<SubjectProjectionV1>,
    pub required_products: Vec<ProductProjectionV1>,
    pub background: Vec<SubjectProjectionV1>,
    pub blockers: Vec<BlockerV1>,
    pub discovery_delayed: bool,
    pub summary_markdown: String,
    pub details_markdown: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CurrentRequestProjectionV1 {
    pub digest: String,
    pub immutable_reference: String,
    pub request: AbiStagingRequestV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CurrentTapPlanProjectionV1 {
    pub request_digest: String,
    pub required_subjects: Vec<String>,
    pub background_subjects: Vec<String>,
    pub blockers: Vec<BlockerV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record: Option<RecordLinkV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublicRecordEnvelopeV1 {
    pub kind: String,
    /// SHA-256 of the immutable OCI manifest used by cross-record references.
    pub digest: String,
    /// SHA-256 of the canonical JSON record bytes stored in the OCI config.
    pub record_sha256: String,
    pub immutable_reference: String,
    pub record: AbiStagingRecordV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CurrentCheckProjectionInputV1 {
    pub schema: u64,
    pub kind: String,
    pub context: CurrentCheckContextV1,
    pub applicable: bool,
    pub discovery_delayed: bool,
    pub expected_request_digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_request: Option<AbiStagingRequestV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<CurrentRequestProjectionV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tap_plan: Option<CurrentTapPlanProjectionV1>,
    pub public_records: Vec<PublicRecordEnvelopeV1>,
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct FormulaSubjectV1 {
    architecture: VfsArchitectureV1,
    identity: String,
    kind: String,
}

#[derive(Clone, Debug)]
struct ProjectedRecordV1<'a> {
    envelope: &'a PublicRecordEnvelopeV1,
    common: &'a RecordCommonV1,
}

pub fn parse_projection_input(bytes: &[u8]) -> Result<CurrentCheckProjectionInputV1, String> {
    if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES {
        return Err(format!(
            "Check projection input must contain 1 through {MAX_INPUT_BYTES} bytes"
        ));
    }
    let input: CurrentCheckProjectionInputV1 = serde_json::from_slice(bytes)
        .map_err(|error| format!("Check projection input is invalid JSON: {error}"))?;
    if canonical_json_bytes(&input)? != bytes {
        return Err("Check projection input is not canonical JSON".to_string());
    }
    validate_input(&input)?;
    Ok(input)
}

pub fn parse_required_check_activation(
    path: &Path,
    bytes: &[u8],
) -> Result<RequiredCheckActivationV1, String> {
    if bytes.is_empty() || bytes.len() > MAX_ACTIVATION_BYTES {
        return Err(format!(
            "required Check activation {} must contain 1 through {MAX_ACTIVATION_BYTES} bytes",
            path.display()
        ));
    }
    let text = std::str::from_utf8(bytes).map_err(|error| {
        format!(
            "required Check activation {} is not UTF-8: {error}",
            path.display()
        )
    })?;
    let activation: RequiredCheckActivationDocumentV1 = toml::from_str(text).map_err(|error| {
        format!(
            "required Check activation {} is invalid TOML: {error}",
            path.display()
        )
    })?;
    if activation.schema != INPUT_SCHEMA || activation.kind != ACTIVATION_KIND {
        return Err(format!(
            "required Check activation {} has unsupported identity",
            path.display()
        ));
    }
    Ok(activation.mode)
}

pub fn required_check_activation_mode(path: &Path) -> Result<&'static str, String> {
    let mode = parse_required_check_activation(
        path,
        &read_bounded_regular_file(path, MAX_ACTIVATION_BYTES)?,
    )?;
    Ok(match mode {
        RequiredCheckActivationV1::Observe => "observe",
        RequiredCheckActivationV1::Enforce => "enforce",
    })
}

pub fn run_cli(action: &str, args: &[String]) -> Result<(), String> {
    if action == "activation-mode" {
        if args.len() != 2 || args[0] != "--activation" {
            return Err(
                "check-projection activation-mode requires --activation <path>".to_string(),
            );
        }
        println!("{}", required_check_activation_mode(Path::new(&args[1]))?);
        return Ok(());
    }
    if action != "project" {
        return Err(format!(
            "unknown check-projection action {action:?}; expected project or activation-mode"
        ));
    }
    if args.len() != 6 || args[0] != "--input" || args[2] != "--activation" || args[4] != "--out" {
        return Err(
            "check-projection project requires --input <path> --activation <path> --out <path>"
                .to_string(),
        );
    }
    let input_path = Path::new(&args[1]);
    let activation_path = Path::new(&args[3]);
    let output_path = Path::new(&args[5]);
    let input = parse_projection_input(&read_bounded_regular_file(input_path, MAX_INPUT_BYTES)?)?;
    let activation = parse_required_check_activation(
        activation_path,
        &read_bounded_regular_file(activation_path, MAX_ACTIVATION_BYTES)?,
    )?;
    let projection = project_current_check(&input, activation)?;
    atomic_write_regular(output_path, &canonical_json_bytes(&projection)?)
}

pub fn project_current_check(
    input: &CurrentCheckProjectionInputV1,
    activation: RequiredCheckActivationV1,
) -> Result<CurrentCheckProjectionV1, String> {
    validate_input(input)?;
    let request_link = input.request.as_ref().map(|request| RecordLinkV1 {
        kind: "request".to_string(),
        digest: request.digest.clone(),
        immutable_reference: request.immutable_reference.clone(),
    });
    let tap_plan_link = input.tap_plan.as_ref().and_then(|plan| plan.record.clone());
    let external_id = format!(
        "abi-staging:{}:{}:{}",
        input.context.pull_request_number, input.context.exact_head, input.expected_request_digest
    );

    if !input.applicable {
        return finish_projection(
            input,
            activation,
            external_id,
            ComputedCheckConclusionV1::NotApplicable,
            request_link,
            tap_plan_link,
            vec![],
            vec![],
            vec![],
            vec![],
        );
    }
    let Some(request_source) = &input.request else {
        return finish_projection(
            input,
            activation,
            external_id,
            ComputedCheckConclusionV1::Pending,
            None,
            None,
            vec![],
            vec![],
            vec![],
            vec![],
        );
    };
    let Some(tap_plan) = &input.tap_plan else {
        return finish_projection(
            input,
            activation,
            external_id,
            ComputedCheckConclusionV1::Pending,
            request_link,
            None,
            vec![],
            required_products(&request_source.request, &input.public_records)?,
            informational_products(&request_source.request, &input.public_records)?,
            vec![],
        );
    };

    let required_formulae = tap_plan
        .required_subjects
        .iter()
        .map(|subject| project_formula(subject, &request_source.digest, &input.public_records))
        .collect::<Result<Vec<_>, _>>()?;
    let mut background = tap_plan
        .background_subjects
        .iter()
        .map(|subject| project_formula(subject, &request_source.digest, &input.public_records))
        .collect::<Result<Vec<_>, _>>()?;
    let required_products = required_products(&request_source.request, &input.public_records)?;
    background.extend(informational_products(
        &request_source.request,
        &input.public_records,
    )?);

    let mut blockers = tap_plan.blockers.clone();
    for formula in &required_formulae {
        if formula.state.is_blocking() {
            blockers.extend(project_record_blockers(
                formula.record.as_ref(),
                &input.public_records,
            ));
            blockers.push(BlockerV1 {
                guard_code: first_guard(&formula.guard_codes, GuardCodeV1::VerificationFailed),
                subject_kind: "formula".to_string(),
                subject: formula.subject.clone(),
                record: formula.record.clone(),
            });
        }
    }
    for product in &required_products {
        if product.state.is_blocking() {
            blockers.extend(project_record_blockers(
                product.evidence.as_ref(),
                &input.public_records,
            ));
            blockers.push(BlockerV1 {
                guard_code: first_guard(&product.guard_codes, GuardCodeV1::PagesProductIncomplete),
                subject_kind: "product".to_string(),
                subject: product.product_id.clone(),
                record: product.evidence.clone(),
            });
        }
    }
    blockers.sort_by(|left, right| {
        blocker_rank(&left.subject_kind)
            .cmp(&blocker_rank(&right.subject_kind))
            .then_with(|| left.subject.cmp(&right.subject))
            .then_with(|| left.guard_code.cmp(&right.guard_code))
    });
    blockers.dedup();

    let required_states = required_formulae
        .iter()
        .map(|item| item.state)
        .chain(required_products.iter().map(|item| item.state))
        .collect::<Vec<_>>();
    let computed =
        if !blockers.is_empty() || required_states.iter().any(|state| state.is_blocking()) {
            ComputedCheckConclusionV1::Failure
        } else if required_states.iter().all(|state| state.is_ready()) {
            ComputedCheckConclusionV1::Success
        } else {
            ComputedCheckConclusionV1::Pending
        };
    finish_projection(
        input,
        activation,
        external_id,
        computed,
        request_link,
        tap_plan_link,
        required_formulae,
        required_products,
        background,
        blockers,
    )
}

#[allow(clippy::too_many_arguments)]
fn finish_projection(
    input: &CurrentCheckProjectionInputV1,
    activation: RequiredCheckActivationV1,
    external_id: String,
    computed: ComputedCheckConclusionV1,
    request: Option<RecordLinkV1>,
    tap_plan: Option<RecordLinkV1>,
    required_formulae: Vec<SubjectProjectionV1>,
    required_products: Vec<ProductProjectionV1>,
    background: Vec<SubjectProjectionV1>,
    blockers: Vec<BlockerV1>,
) -> Result<CurrentCheckProjectionV1, String> {
    let published_conclusion = match activation {
        RequiredCheckActivationV1::Observe => "neutral",
        RequiredCheckActivationV1::Enforce => match computed {
            ComputedCheckConclusionV1::NotApplicable | ComputedCheckConclusionV1::Success => {
                "success"
            }
            ComputedCheckConclusionV1::Pending => "in_progress",
            ComputedCheckConclusionV1::Failure => "failure",
        },
    }
    .to_string();
    let summary_markdown = render_summary(
        input,
        activation,
        computed,
        &required_formulae,
        &required_products,
        &background,
        &blockers,
    );
    let details_markdown = render_details(
        input,
        &required_formulae,
        &required_products,
        &background,
        &blockers,
    );
    if summary_markdown.len() > MAX_SUMMARY_BYTES || details_markdown.len() > MAX_DETAILS_BYTES {
        return Err("Check Markdown exceeds its protected byte bound".to_string());
    }
    Ok(CurrentCheckProjectionV1 {
        name: CHECK_NAME.to_string(),
        external_id,
        head_sha: input.context.exact_head.clone(),
        computed_conclusion: computed,
        published_conclusion,
        request,
        tap_plan,
        required_formulae,
        required_products,
        background,
        blockers,
        discovery_delayed: input.discovery_delayed,
        summary_markdown,
        details_markdown,
    })
}

fn validate_input(input: &CurrentCheckProjectionInputV1) -> Result<(), String> {
    if input.schema != INPUT_SCHEMA || input.kind != INPUT_KIND {
        return Err("Check projection input has unsupported identity".to_string());
    }
    validate_context(&input.context)?;
    validate_sha256(&input.expected_request_digest)?;
    if !input.applicable {
        if input.expected_request_digest != "0".repeat(64)
            || input.expected_request.is_some()
            || input.request.is_some()
            || input.tap_plan.is_some()
            || !input.public_records.is_empty()
        {
            return Err("not-applicable Check input cannot carry staging facts".to_string());
        }
        return Ok(());
    }
    if input.public_records.len() > MAX_RECORDS {
        return Err("Check projection input contains too many public records".to_string());
    }
    if let Some(request_source) = &input.request {
        let expected_request = input.expected_request.as_ref().ok_or_else(|| {
            "selected Check request lacks its protected expected request".to_string()
        })?;
        validate_request(expected_request)?;
        let expected_digest = canonical_sha256(expected_request)?;
        if expected_digest != input.expected_request_digest {
            return Err("protected expected request digest differs from its bytes".to_string());
        }
        if expected_request.pull_request.repository != input.context.repository
            || expected_request.pull_request.number != input.context.pull_request_number
            || !request_is_current(
                expected_request,
                &input.context.exact_head,
                &input.context.current_requirements_sha256,
                input.context.current_policy_version,
                &input.context.current_policy_sha256,
                input.context.current_guard_registry_version,
                &input.context.current_guard_registry_sha256,
            )
        {
            return Err(
                "protected expected request is not current for the exact Check context".to_string(),
            );
        }
        validate_request(&request_source.request)?;
        let digest = canonical_sha256(&request_source.request)?;
        if digest != request_source.digest
            || digest != input.expected_request_digest
            || request_source.request != *expected_request
        {
            return Err("current request digest differs from protected expectation".to_string());
        }
        if request_source.request.pull_request.repository != input.context.repository
            || request_source.request.pull_request.number != input.context.pull_request_number
            || !request_is_current(
                &request_source.request,
                &input.context.exact_head,
                &input.context.current_requirements_sha256,
                input.context.current_policy_version,
                &input.context.current_policy_sha256,
                input.context.current_guard_registry_version,
                &input.context.current_guard_registry_sha256,
            )
        {
            return Err("selected request is not current for the exact Check context".to_string());
        }
        validate_request_reference(
            &request_source.immutable_reference,
            &input.context.repository,
            input.context.pull_request_number,
            &input.context.exact_head,
            &request_source.digest,
        )?;
    } else {
        if input.expected_request_digest != "0".repeat(64)
            || input.expected_request.is_some()
            || input.tap_plan.is_some()
            || !input.public_records.is_empty()
        {
            return Err("request-missing Check input cannot carry downstream facts".to_string());
        }
    }
    if let Some(plan) = &input.tap_plan {
        let request = input
            .request
            .as_ref()
            .ok_or_else(|| "tap plan requires a selected current request".to_string())?;
        if plan.request_digest != request.digest {
            return Err("tap plan names a different current request".to_string());
        }
        if plan.required_subjects.len() + plan.background_subjects.len() > MAX_SUBJECTS {
            return Err("tap plan subject projection exceeds its bound".to_string());
        }
        validate_subject_list(&plan.required_subjects, "required Formula subjects")?;
        validate_subject_list(&plan.background_subjects, "background Formula subjects")?;
        let required = plan.required_subjects.iter().collect::<BTreeSet<_>>();
        if plan
            .background_subjects
            .iter()
            .any(|subject| required.contains(subject))
        {
            return Err("required and background Formula subjects overlap".to_string());
        }
        validate_blockers(&plan.blockers)?;
        if let Some(link) = &plan.record {
            validate_record_link(link)?;
        }
    }
    let mut digests = BTreeSet::new();
    let mut references = BTreeSet::new();
    for envelope in &input.public_records {
        validate_record(&envelope.record)?;
        validate_stable_id(&envelope.kind, "public record kind")?;
        if envelope.kind != record_kind(&envelope.record) {
            return Err("public record envelope kind differs from record".to_string());
        }
        validate_sha256(&envelope.digest)?;
        let record_sha256 = canonical_sha256(&envelope.record)?;
        if record_sha256 != envelope.record_sha256 {
            return Err(
                "public record envelope body digest differs from canonical record".to_string(),
            );
        }
        validate_candidate_record_reference(
            &envelope.immutable_reference,
            &envelope.digest,
            input
                .request
                .as_ref()
                .ok_or_else(|| "public records require a selected request".to_string())?
                .request
                .target_abi
                .version,
        )?;
        if !digests.insert(envelope.digest.as_str())
            || !references.insert(envelope.immutable_reference.as_str())
        {
            return Err("public record envelopes must be duplicate-free".to_string());
        }
        let common = record_common(&envelope.record);
        if input.request.as_ref().is_some_and(|request| {
            common.request_sha256 == request.digest
                && (common.source.repository != request.request.build_source.repository
                    || common.source.commit != request.request.build_source.commit
                    || common.source.tree != request.request.build_source.tree)
        }) {
            return Err("current public record source differs from exact request".to_string());
        }
    }
    Ok(())
}

fn validate_context(context: &CurrentCheckContextV1) -> Result<(), String> {
    let mut parts = context.repository.split('/');
    if parts.next().is_none()
        || parts.next().is_none()
        || parts.next().is_some()
        || context.repository.chars().any(char::is_whitespace)
    {
        return Err("Check context repository must be exact owner/name".to_string());
    }
    if context.pull_request_number == 0 {
        return Err("Check context pull-request number must be positive".to_string());
    }
    validate_git_sha(&context.exact_head)?;
    validate_sha256(&context.current_requirements_sha256)?;
    validate_sha256(&context.current_policy_sha256)?;
    validate_sha256(&context.current_guard_registry_sha256)?;
    if context.current_policy_version == 0 || context.current_guard_registry_version == 0 {
        return Err("Check context policy versions must be positive".to_string());
    }
    Ok(())
}

fn validate_subject_list(values: &[String], field: &str) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    for value in values {
        parse_formula_subject(value)?;
        if !seen.insert(value.as_str()) {
            return Err(format!("{field} must be duplicate-free"));
        }
    }
    Ok(())
}

fn parse_formula_subject(value: &str) -> Result<FormulaSubjectV1, String> {
    if value.len() > 512 {
        return Err("Formula subject exceeds its byte bound".to_string());
    }
    let subject: FormulaSubjectV1 = serde_json::from_str(value)
        .map_err(|error| format!("Formula subject is invalid JSON: {error}"))?;
    if subject.kind != "formula" {
        return Err("Formula subject kind changed".to_string());
    }
    validate_stable_id(&subject.identity, "Formula subject identity")?;
    let canonical = canonical_json_bytes(&subject)?;
    let canonical = std::str::from_utf8(&canonical)
        .map_err(|error| format!("canonical Formula subject is not UTF-8: {error}"))?
        .strip_suffix('\n')
        .ok_or_else(|| "canonical Formula subject lacks line feed".to_string())?;
    if canonical != value {
        return Err("Formula subject is not canonical JSON".to_string());
    }
    Ok(subject)
}

fn project_formula(
    subject_value: &str,
    request_digest: &str,
    records: &[PublicRecordEnvelopeV1],
) -> Result<SubjectProjectionV1, String> {
    let subject = parse_formula_subject(subject_value)?;
    let current = records
        .iter()
        .filter(|envelope| record_common(&envelope.record).request_sha256 == request_digest)
        .collect::<Vec<_>>();
    let reuses = current
        .iter()
        .filter_map(|envelope| match &envelope.record {
            AbiStagingRecordV1::CandidateReuse(record)
                if record.candidate_reuse.formula.formula == subject.identity
                    && record.candidate_reuse.formula.architecture == subject.architecture =>
            {
                Some(ProjectedRecordV1 {
                    envelope,
                    common: &record.common,
                })
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    if !reuses.is_empty() {
        return select_equivalent_projection(subject_value, reuses);
    }
    let candidates = current
        .iter()
        .filter_map(|envelope| match &envelope.record {
            AbiStagingRecordV1::Candidate(record)
                if record.candidate.formula.formula == subject.identity
                    && record.candidate.formula.architecture == subject.architecture =>
            {
                Some((*envelope, record.candidate.bottle_layer.sha256.as_str()))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    let layers = candidates
        .iter()
        .map(|(_, layer)| *layer)
        .collect::<BTreeSet<_>>();
    if layers.len() > 1 {
        return Err(format!(
            "Formula subject {subject_value:?} has conflicting current candidates"
        ));
    }
    if let Some((candidate, _)) = candidates
        .iter()
        .min_by_key(|(envelope, _)| &envelope.digest)
    {
        let overrides = current
            .iter()
            .filter_map(|envelope| match &envelope.record {
                AbiStagingRecordV1::Override(record)
                    if record.override_receipt.candidate_record_sha256 == candidate.digest =>
                {
                    Some(ProjectedRecordV1 {
                        envelope,
                        common: &record.common,
                    })
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        if !overrides.is_empty() {
            return select_equivalent_projection(subject_value, overrides);
        }
        let mut verifications = current
            .iter()
            .filter_map(|envelope| match &envelope.record {
                AbiStagingRecordV1::Verification(record)
                    if record.verification.candidate_record_sha256 == candidate.digest =>
                {
                    Some((
                        record.verification.attempt_ordinal,
                        ProjectedRecordV1 {
                            envelope,
                            common: &record.common,
                        },
                    ))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        verifications.sort_by(|left, right| {
            right
                .0
                .cmp(&left.0)
                .then_with(|| left.1.envelope.digest.cmp(&right.1.envelope.digest))
        });
        if let Some((ordinal, selected)) = verifications.first() {
            if verifications.iter().any(|(other_ordinal, other)| {
                other_ordinal == ordinal
                    && state_from_common(other.common) != state_from_common(selected.common)
            }) {
                return Err("current verification attempts conflict at one ordinal".to_string());
            }
            return Ok(subject_projection(subject_value, selected));
        }
        return Ok(SubjectProjectionV1 {
            subject: subject_value.to_string(),
            state: CheckSubjectStateV1::Pending,
            record: Some(record_link(candidate)),
            guard_codes: vec![],
        });
    }
    let mut attempts = current
        .iter()
        .filter_map(|envelope| match &envelope.record {
            AbiStagingRecordV1::Attempt(record)
                if record.attempt.formula.formula == subject.identity
                    && record.attempt.formula.architecture == subject.architecture =>
            {
                Some((
                    record.attempt.retry_ordinal,
                    ProjectedRecordV1 {
                        envelope,
                        common: &record.common,
                    },
                ))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    attempts.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.envelope.digest.cmp(&right.1.envelope.digest))
    });
    if let Some((_, selected)) = attempts.first() {
        return Ok(subject_projection(subject_value, selected));
    }
    Ok(SubjectProjectionV1 {
        subject: subject_value.to_string(),
        state: CheckSubjectStateV1::Pending,
        record: None,
        guard_codes: vec![],
    })
}

fn select_equivalent_projection(
    subject: &str,
    mut records: Vec<ProjectedRecordV1<'_>>,
) -> Result<SubjectProjectionV1, String> {
    records.sort_by(|left, right| left.envelope.digest.cmp(&right.envelope.digest));
    let selected = records
        .first()
        .ok_or_else(|| "projection selection unexpectedly empty".to_string())?;
    if records.iter().any(|record| {
        state_from_common(record.common) != state_from_common(selected.common)
            || guard_strings(record.common) != guard_strings(selected.common)
    }) {
        return Err(format!(
            "subject {subject:?} has conflicting current records"
        ));
    }
    Ok(subject_projection(subject, selected))
}

fn subject_projection(subject: &str, record: &ProjectedRecordV1<'_>) -> SubjectProjectionV1 {
    SubjectProjectionV1 {
        subject: subject.to_string(),
        state: state_from_common(record.common),
        record: Some(record_link(record.envelope)),
        guard_codes: guard_strings(record.common),
    }
}

fn required_products(
    request: &AbiStagingRequestV1,
    records: &[PublicRecordEnvelopeV1],
) -> Result<Vec<ProductProjectionV1>, String> {
    request
        .requirements
        .evidence
        .iter()
        .filter(|evidence| evidence.applicability == ApplicabilityV1::Required)
        .map(|evidence| project_product(request, evidence.product_id.as_str(), records))
        .collect()
}

fn informational_products(
    request: &AbiStagingRequestV1,
    records: &[PublicRecordEnvelopeV1],
) -> Result<Vec<SubjectProjectionV1>, String> {
    request
        .requirements
        .evidence
        .iter()
        .filter(|evidence| evidence.applicability == ApplicabilityV1::Informational)
        .map(|evidence| {
            let product = project_product(request, evidence.product_id.as_str(), records)?;
            Ok(SubjectProjectionV1 {
                subject: format!("product:{}", product.product_id),
                state: product.state,
                record: product.evidence,
                guard_codes: product.guard_codes,
            })
        })
        .collect()
}

fn project_product(
    request: &AbiStagingRequestV1,
    product_id: &str,
    records: &[PublicRecordEnvelopeV1],
) -> Result<ProductProjectionV1, String> {
    let product = request
        .requirements
        .products
        .iter()
        .find(|product| product.id == product_id)
        .ok_or_else(|| format!("evidence names unselected product {product_id:?}"))?;
    let mut evidence = records
        .iter()
        .filter_map(|envelope| match &envelope.record {
            AbiStagingRecordV1::ProductEvidence(record)
                if record.common.request_sha256 == canonical_sha256(request).ok()?
                    && record.product_evidence.product.id == product_id =>
            {
                Some(ProjectedRecordV1 {
                    envelope,
                    common: &record.common,
                })
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    for record in &evidence {
        let AbiStagingRecordV1::ProductEvidence(value) = &record.envelope.record else {
            unreachable!()
        };
        if value.common.subject.kind != SubjectKindV1::Product
            || value.common.subject.identity != product_id
            || value.product_evidence.product.manifest_sha256 != product.manifest_sha256
            || value.product_evidence.product.manifest_path != product.path
        {
            return Err(format!(
                "product evidence for {product_id:?} differs from current selection"
            ));
        }
    }
    evidence.sort_by(|left, right| left.envelope.digest.cmp(&right.envelope.digest));
    if let Some(selected) = evidence.first() {
        if evidence.iter().any(|record| {
            state_from_common(record.common) != state_from_common(selected.common)
                || guard_strings(record.common) != guard_strings(selected.common)
        }) {
            return Err(format!(
                "product {product_id:?} has conflicting current evidence"
            ));
        }
        Ok(ProductProjectionV1 {
            product_id: product_id.to_string(),
            manifest_sha256: product.manifest_sha256.clone(),
            state: state_from_common(selected.common),
            evidence: Some(record_link(selected.envelope)),
            guard_codes: guard_strings(selected.common),
        })
    } else {
        Ok(ProductProjectionV1 {
            product_id: product_id.to_string(),
            manifest_sha256: product.manifest_sha256.clone(),
            state: CheckSubjectStateV1::Pending,
            evidence: None,
            guard_codes: vec![],
        })
    }
}

fn state_from_common(common: &RecordCommonV1) -> CheckSubjectStateV1 {
    if common.promotion_state == PromotionStateV1::AcceptedWithOverride {
        return CheckSubjectStateV1::AcceptedWithOverride;
    }
    if common.retry_state.eligible
        && !common.retry_state.exhausted
        && matches!(
            common.retry_state.next_action,
            RetryNextActionV1::Wait | RetryNextActionV1::Retry
        )
    {
        return CheckSubjectStateV1::Pending;
    }
    match common.work_state {
        WorkStateV1::Pending => CheckSubjectStateV1::Pending,
        WorkStateV1::Blocked => CheckSubjectStateV1::Blocked,
        WorkStateV1::Queued => CheckSubjectStateV1::Queued,
        WorkStateV1::Running => CheckSubjectStateV1::Running,
        WorkStateV1::Complete => match common.outcome {
            Some(TerminalOutcomeV1::Success) => CheckSubjectStateV1::Success,
            Some(TerminalOutcomeV1::Failure) => CheckSubjectStateV1::Failure,
            Some(TerminalOutcomeV1::Timeout) => CheckSubjectStateV1::Timeout,
            Some(TerminalOutcomeV1::Canceled) => CheckSubjectStateV1::Canceled,
            Some(TerminalOutcomeV1::Skipped) => CheckSubjectStateV1::Skipped,
            None => CheckSubjectStateV1::Pending,
        },
    }
}

fn record_common(record: &AbiStagingRecordV1) -> &RecordCommonV1 {
    match record {
        AbiStagingRecordV1::Attempt(record) => &record.common,
        AbiStagingRecordV1::Candidate(record) => &record.common,
        AbiStagingRecordV1::CandidateReuse(record) => &record.common,
        AbiStagingRecordV1::Verification(record) => &record.common,
        AbiStagingRecordV1::ProductEvidence(record) => &record.common,
        AbiStagingRecordV1::CaptureOverrideAuthorization(record) => &record.common,
        AbiStagingRecordV1::Override(record) => &record.common,
        AbiStagingRecordV1::Admission(record) => &record.common,
        AbiStagingRecordV1::Deletion(record) => &record.common,
    }
}

fn record_kind(record: &AbiStagingRecordV1) -> &'static str {
    match record {
        AbiStagingRecordV1::Attempt(_) => "attempt",
        AbiStagingRecordV1::Candidate(_) => "candidate",
        AbiStagingRecordV1::CandidateReuse(_) => "candidate-reuse",
        AbiStagingRecordV1::Verification(_) => "verification",
        AbiStagingRecordV1::ProductEvidence(_) => "product-evidence",
        AbiStagingRecordV1::CaptureOverrideAuthorization(_) => "capture-override-authorization",
        AbiStagingRecordV1::Override(_) => "override",
        AbiStagingRecordV1::Admission(_) => "admission",
        AbiStagingRecordV1::Deletion(_) => "deletion",
    }
}

fn record_link(envelope: &PublicRecordEnvelopeV1) -> RecordLinkV1 {
    RecordLinkV1 {
        kind: envelope.kind.clone(),
        digest: envelope.digest.clone(),
        immutable_reference: envelope.immutable_reference.clone(),
    }
}

fn guard_strings(common: &RecordCommonV1) -> Vec<String> {
    common
        .guard_codes
        .iter()
        .map(|guard| guard.as_str().to_string())
        .collect()
}

fn first_guard(values: &[String], fallback: GuardCodeV1) -> GuardCodeV1 {
    GuardCodeV1::ALL
        .into_iter()
        .find(|guard| values.iter().any(|value| value == guard.as_str()))
        .unwrap_or(fallback)
}

fn project_record_blockers(
    link: Option<&RecordLinkV1>,
    records: &[PublicRecordEnvelopeV1],
) -> Vec<BlockerV1> {
    let Some(link) = link else {
        return Vec::new();
    };
    let Some(envelope) = records.iter().find(|record| record.digest == link.digest) else {
        return Vec::new();
    };
    record_common(&envelope.record)
        .blockers
        .iter()
        .map(|blocker| BlockerV1 {
            guard_code: blocker.guard_code,
            subject_kind: subject_kind_name(blocker.subject_kind).to_string(),
            subject: blocker.subject.clone(),
            record: Some(record_link(envelope)),
        })
        .collect()
}

fn subject_kind_name(kind: SubjectKindV1) -> &'static str {
    match kind {
        SubjectKindV1::Request => "request",
        SubjectKindV1::Formula => "formula",
        SubjectKindV1::Product => "product",
        SubjectKindV1::Candidate => "candidate",
        SubjectKindV1::SourceCustody => "source-custody",
        SubjectKindV1::Pages => "pages",
    }
}

fn blocker_rank(kind: &str) -> u8 {
    match kind {
        "request" => 0,
        "formula" => 1,
        "product" => 2,
        _ => 3,
    }
}

fn validate_blockers(blockers: &[BlockerV1]) -> Result<(), String> {
    if blockers.len() > MAX_SUBJECTS {
        return Err("Check blocker list exceeds its bound".to_string());
    }
    for blocker in blockers {
        validate_stable_id(&blocker.subject_kind, "Check blocker subject kind")?;
        if blocker.subject.is_empty() || blocker.subject.len() > 512 {
            return Err("Check blocker subject is outside its byte bound".to_string());
        }
        if let Some(record) = &blocker.record {
            validate_record_link(record)?;
        }
    }
    Ok(())
}

fn validate_record_link(link: &RecordLinkV1) -> Result<(), String> {
    validate_stable_id(&link.kind, "Check record-link kind")?;
    validate_sha256(&link.digest)?;
    validate_immutable_reference(&link.immutable_reference, &link.digest)
}

fn validate_request_reference(
    reference: &str,
    repository: &str,
    pull_request: u64,
    head: &str,
    digest: &str,
) -> Result<(), String> {
    let expected = request_asset_url(repository, pull_request, head, digest);
    if reference.len() > MAX_REFERENCE_BYTES
        || reference != expected
        || reference.contains('?')
        || reference.contains('#')
        || reference
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(
            "current request reference is not an exact immutable Release asset".to_string(),
        );
    }
    Ok(())
}

fn validate_candidate_record_reference(
    reference: &str,
    digest: &str,
    target_abi: u64,
) -> Result<(), String> {
    let prefix = format!("ghcr.io/kandelo-dev/homebrew-tap-core-abi-{target_abi}-candidates/");
    if !reference.starts_with(&prefix) {
        return Err("public record reference is outside the exact candidate namespace".to_string());
    }
    validate_oci_reference(reference, digest)
}

fn validate_oci_reference(reference: &str, digest: &str) -> Result<(), String> {
    let suffix = format!("@sha256:{digest}");
    if reference.len() > MAX_REFERENCE_BYTES
        || !reference.starts_with("ghcr.io/")
        || !reference.ends_with(&suffix)
        || reference.matches('@').count() != 1
        || reference
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err("public record reference is not an exact immutable GHCR digest".to_string());
    }
    Ok(())
}

fn validate_immutable_reference(reference: &str, digest: &str) -> Result<(), String> {
    if reference.starts_with("ghcr.io/") {
        validate_oci_reference(reference, digest)
    } else if reference.starts_with("https://github.com/")
        && reference.contains("/releases/download/")
        && reference.contains(digest)
        && !reference.contains('?')
        && !reference.contains('#')
        && reference.len() <= MAX_REFERENCE_BYTES
        && !reference
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        Ok(())
    } else {
        Err("Check record link is not an allowed immutable reference".to_string())
    }
}

fn render_summary(
    input: &CurrentCheckProjectionInputV1,
    activation: RequiredCheckActivationV1,
    conclusion: ComputedCheckConclusionV1,
    formulae: &[SubjectProjectionV1],
    products: &[ProductProjectionV1],
    background: &[SubjectProjectionV1],
    blockers: &[BlockerV1],
) -> String {
    let mut lines = vec![
        "## Kandelo PR Check".to_string(),
        String::new(),
        format!("Computed conclusion: `{}`", conclusion_name(conclusion)),
        format!("Exact head: `{}`", input.context.exact_head),
        format!(
            "Activation: `{}`",
            match activation {
                RequiredCheckActivationV1::Observe => "observe",
                RequiredCheckActivationV1::Enforce => "enforce",
            }
        ),
        format!("Required Formulae: {}", formulae.len()),
        format!("Required products: {}", products.len()),
        format!("Background subjects: {}", background.len()),
    ];
    if input.discovery_delayed {
        lines.push(
            "Discovery diagnostic: request discovery has exceeded fifteen minutes.".to_string(),
        );
    }
    if let Some(blocker) = blockers.first() {
        lines.push(format!(
            "First causal blocker: `{}` for `{}`.",
            blocker.guard_code.as_str(),
            escape_markdown(&blocker.subject)
        ));
    }
    if activation == RequiredCheckActivationV1::Observe {
        lines.push(
            "Observe mode publishes a neutral Check; the computed conclusion above is not yet enforced."
                .to_string(),
        );
    }
    lines.join("\n") + "\n"
}

fn render_details(
    input: &CurrentCheckProjectionInputV1,
    formulae: &[SubjectProjectionV1],
    products: &[ProductProjectionV1],
    background: &[SubjectProjectionV1],
    blockers: &[BlockerV1],
) -> String {
    let mut output = String::from(
        "## Required Formulae\n\n| Subject | State | Guards | Record |\n|---|---|---|---|\n",
    );
    for item in formulae {
        output.push_str(&subject_row(item));
    }
    output.push_str(
        "\n## Required products\n\n| Product | State | Guards | Evidence |\n|---|---|---|---|\n",
    );
    for product in products {
        output.push_str(&format!(
            "| `{}` | `{}` | {} | {} |\n",
            escape_markdown(&product.product_id),
            product.state.as_str(),
            render_guards(&product.guard_codes),
            render_link(product.evidence.as_ref()),
        ));
    }
    output.push_str("\n## Background and informational\n\n| Subject | State | Guards | Record |\n|---|---|---|---|\n");
    for item in background {
        output.push_str(&subject_row(item));
    }
    output.push_str("\n## Blockers\n\n");
    if blockers.is_empty() {
        output.push_str("None.\n");
    } else {
        for blocker in blockers {
            output.push_str(&format!(
                "- `{}` `{}`: `{}` {}\n",
                escape_markdown(&blocker.subject_kind),
                escape_markdown(&blocker.subject),
                blocker.guard_code.as_str(),
                render_link(blocker.record.as_ref()),
            ));
        }
    }
    output.push_str(
        "\n## Immutable current records\n\n| Kind | Subject | State | Retry | Guards | Record |\n|---|---|---|---|---|---|\n",
    );
    let current_request = input
        .request
        .as_ref()
        .map(|request| request.digest.as_str());
    let mut records = input
        .public_records
        .iter()
        .filter(|envelope| {
            current_request
                .is_some_and(|digest| record_common(&envelope.record).request_sha256 == digest)
        })
        .collect::<Vec<_>>();
    records.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.digest.cmp(&right.digest))
    });
    for envelope in records {
        let common = record_common(&envelope.record);
        output.push_str(&format!(
            "| `{}` | `{}` | `{}` | `{}` | {} | {} |\n",
            escape_markdown(&envelope.kind),
            escape_markdown(&common.subject.identity),
            state_from_common(common).as_str(),
            escape_markdown(&format!(
                "{}:{}",
                common.retry_state.attempts,
                retry_action_name(common.retry_state.next_action)
            )),
            render_guards(&guard_strings(common)),
            render_link(Some(&record_link(envelope))),
        ));
    }
    output
}

fn retry_action_name(action: RetryNextActionV1) -> &'static str {
    match action {
        RetryNextActionV1::None => "none",
        RetryNextActionV1::Wait => "wait",
        RetryNextActionV1::Retry => "retry",
        RetryNextActionV1::MaintainerAction => "maintainer_action",
    }
}

fn subject_row(item: &SubjectProjectionV1) -> String {
    format!(
        "| `{}` | `{}` | {} | {} |\n",
        escape_markdown(&item.subject),
        item.state.as_str(),
        render_guards(&item.guard_codes),
        render_link(item.record.as_ref()),
    )
}

fn render_guards(guards: &[String]) -> String {
    if guards.is_empty() {
        "—".to_string()
    } else {
        guards
            .iter()
            .map(|guard| format!("`{}`", escape_markdown(guard)))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

fn render_link(link: Option<&RecordLinkV1>) -> String {
    link.map_or_else(
        || "—".to_string(),
        |link| {
            format!(
                "[{}]({})",
                escape_markdown(&format!("{}:{}", link.kind, &link.digest[..12])),
                link.immutable_reference
            )
        },
    )
}

fn escape_markdown(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('|', "&#124;")
        .replace('`', "&#96;")
        .replace(['\r', '\n'], " ")
}

fn conclusion_name(conclusion: ComputedCheckConclusionV1) -> &'static str {
    match conclusion {
        ComputedCheckConclusionV1::NotApplicable => "not_applicable",
        ComputedCheckConclusionV1::Pending => "pending",
        ComputedCheckConclusionV1::Failure => "failure",
        ComputedCheckConclusionV1::Success => "success",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abi_staging::builder_contract::TargetAbiV1;
    use crate::abi_staging::canonical_json::canonical_sha256;
    use crate::abi_staging::consumer_registry::{ApplicabilityV1, ChangeClass};
    use crate::abi_staging::records::{
        AbiStagingRecordV1, AbiStagingRequestV1, ExactGitSourceV1, PullRequestRequestIdentityV1,
        RequestAuthorizationV1, RequestEvidenceBindingV1, RequestInformationalContextV1,
        RequestIssuanceV1, RequestProductBindingV1, RequestRegistryBindingV1,
        RequestRegistryKindV1, RequestRequirementsV1, request_requirements_digest,
    };
    use serde_json::{Value, json};

    const REPOSITORY: &str = "Automattic/kandelo";
    const HEAD: &str = "1111111111111111111111111111111111111111";
    const TREE: &str = "2222222222222222222222222222222222222222";

    fn digest(character: char) -> String {
        std::iter::repeat_n(character, 64).collect()
    }

    fn request() -> AbiStagingRequestV1 {
        let mut requirements = RequestRequirementsV1 {
            digest: digest('0'),
            change_classes: vec![ChangeClass::Abi],
            products: vec![RequestProductBindingV1 {
                id: "platform-rootfs".to_string(),
                path: "images/vfs/products/platform-rootfs.toml".to_string(),
                manifest_sha256: digest('a'),
            }],
            registries: vec![RequestRegistryBindingV1 {
                kind: RequestRegistryKindV1::Pages,
                path: "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml"
                    .to_string(),
                sha256: digest('b'),
            }],
            evidence: vec![RequestEvidenceBindingV1 {
                product_id: "platform-rootfs".to_string(),
                applicability: ApplicabilityV1::Required,
                node: vec!["rootfs-node-startup".to_string()],
                browser: vec!["rootfs-browser-startup".to_string()],
            }],
        };
        requirements.digest = request_requirements_digest(&requirements).unwrap();
        AbiStagingRequestV1 {
            schema: 1,
            kind: "kandelo-abi-staging-request".to_string(),
            pull_request: PullRequestRequestIdentityV1 {
                repository: REPOSITORY.to_string(),
                number: 19,
            },
            build_source: ExactGitSourceV1 {
                repository: REPOSITORY.to_string(),
                commit: HEAD.to_string(),
                tree: TREE.to_string(),
            },
            target_abi: TargetAbiV1 {
                version: 8,
                snapshot_sha256: digest('c'),
            },
            requirements,
            issuance: RequestIssuanceV1 {
                issuer_repository: REPOSITORY.to_string(),
                issuer_workflow_ref:
                    "Automattic/kandelo/.github/workflows/abi-staging-request-feed.yml@refs/heads/main"
                        .to_string(),
                policy_version: 5,
                policy_sha256: digest('d'),
                guard_registry_version: 1,
                guard_registry_sha256: digest('e'),
                authorization: RequestAuthorizationV1::SameRepository {
                    head: HEAD.to_string(),
                },
            },
            informational_context: RequestInformationalContextV1 {
                base_commit: None,
                base_tree: None,
                previous_abi: Some(7),
                ref_hint: None,
            },
        }
    }

    fn artifact(character: char) -> Value {
        let sha = digest(character);
        json!({
            "sha256": sha,
            "bytes": 128,
            "immutable_reference": format!("ghcr.io/kandelo-dev/check-fixtures@sha256:{sha}"),
        })
    }

    fn common(
        request_sha256: &str,
        subject: Value,
        outcome: &str,
        promotion_state: &str,
        guard_codes: &[&str],
        artifact_value: Option<Value>,
    ) -> Value {
        let blockers = guard_codes
            .iter()
            .map(|guard| {
                json!({
                    "guard_code": guard,
                    "subject_kind": subject["kind"].clone(),
                    "subject": subject["identity"].clone(),
                })
            })
            .collect::<Vec<_>>();
        let mut value = json!({
            "request_sha256": request_sha256,
            "subject": subject,
            "source": {
                "repository": REPOSITORY,
                "commit": HEAD,
                "tree": TREE,
            },
            "run": {
                "repository": "kandelo-dev/homebrew-tap-core",
                "workflow_ref": "kandelo-dev/homebrew-tap-core/.github/workflows/abi-staging-reconcile.yml@refs/heads/main",
                "run_id": 101,
                "run_attempt": 1,
                "job": "fixture",
            },
            "guard_codes": guard_codes,
            "work_state": "complete",
            "outcome": outcome,
            "artifact_class": if artifact_value.is_some() { "candidate" } else { "none" },
            "promotion_state": promotion_state,
            "retry_state": {
                "attempts": 1,
                "eligible": false,
                "exhausted": false,
                "next_action": "none",
            },
            "blockers": blockers,
        });
        if let Some(artifact_value) = artifact_value {
            value["artifact"] = artifact_value;
        }
        value
    }

    fn record(value: Value) -> AbiStagingRecordV1 {
        serde_json::from_value(value).unwrap()
    }

    fn candidate_and_verification(
        request_sha256: &str,
        outcome: &str,
    ) -> Vec<PublicRecordEnvelopeV1> {
        let candidate_layer = artifact('4');
        let candidate = record(json!({
            "schema": 1,
            "kind": "kandelo-abi-staging-candidate",
            "common": common(
                request_sha256,
                json!({"kind": "candidate", "identity": format!("kandelo-dev/homebrew-tap-core/bash@sha256:{}", digest('4'))}),
                "success",
                "unknown",
                &[],
                Some(candidate_layer.clone()),
            ),
            "candidate": {
                "formula": {
                    "tap": "kandelo-dev/homebrew-tap-core",
                    "formula": "bash",
                    "version": "5.2",
                    "revision": 0,
                    "bottle_rebuild": 0,
                    "architecture": "wasm32",
                    "target_abi": 8,
                    "bottle_contract_sha256": digest('5'),
                },
                "bottle_layer": candidate_layer,
                "normalized_components": [
                    {
                        "id": "bottle-contract",
                        "artifact": artifact('5'),
                    },
                    {
                        "id": "bottle-metadata",
                        "artifact": artifact('8'),
                    },
                    {
                        "id": "source-custody",
                        "artifact": artifact('6'),
                    },
                ],
                "direct_dependency_layers": [],
                "source_custody_sha256": digest('6'),
                "producer": {
                    "request_sha256": request_sha256,
                    "head": HEAD,
                    "run_id": 101,
                },
                "nonendorsed": true,
            },
        }));
        let candidate = envelope(candidate, "candidate");
        let guard_codes = if outcome == "success" {
            vec![]
        } else if outcome == "timeout" {
            vec!["verification_timeout"]
        } else {
            vec!["verification_failed"]
        };
        let promotion = if outcome == "success" {
            "eligible"
        } else {
            "ineligible"
        };
        let verification = record(json!({
            "schema": 1,
            "kind": "kandelo-abi-staging-verification",
            "common": common(
                request_sha256,
                json!({"kind": "candidate", "identity": candidate.digest}),
                outcome,
                promotion,
                &guard_codes,
                None,
            ),
            "verification": {
                "candidate_record_sha256": candidate.digest,
                "candidate_layer": artifact('4'),
                "test_definition_sha256": digest('7'),
                "host": "build",
                "attempt_ordinal": 0,
                "diagnostics": [],
            },
        }));
        vec![candidate, envelope(verification, "verification")]
    }

    fn product_record(
        request_sha256: &str,
        outcome: &str,
        promotion_state: &str,
    ) -> PublicRecordEnvelopeV1 {
        let guard_codes = if outcome == "success" {
            vec![]
        } else if outcome == "timeout" {
            vec!["verification_timeout"]
        } else {
            vec!["pages_product_incomplete"]
        };
        let vfs = artifact('8');
        envelope(
            record(json!({
                "schema": 1,
                "kind": "kandelo-abi-staging-product-evidence",
                "common": common(
                    request_sha256,
                    json!({"kind": "product", "identity": "platform-rootfs"}),
                    outcome,
                    promotion_state,
                    &guard_codes,
                    Some(vfs.clone()),
                ),
                "product_evidence": {
                    "product": {
                        "id": "platform-rootfs",
                        "manifest_path": "images/vfs/products/platform-rootfs.toml",
                        "manifest_sha256": digest('a'),
                        "architecture": "wasm32",
                        "output": "platform-rootfs.vfs.zst",
                    },
                    "selecting_registries": [{
                        "kind": "pages",
                        "path": "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml",
                        "sha256": digest('b'),
                    }],
                    "resolved_formula_layers": [],
                    "resolved_inputs_sha256": digest('9'),
                    "runtime_evidence_sha256": digest('a'),
                    "vfs_image": vfs,
                    "builder_report": artifact('b'),
                    "kernel": artifact('c'),
                    "host_runtime": artifact('d'),
                    "evidence_definition_sha256s": [digest('e')],
                    "verification_receipt_sha256s": [digest('f')],
                },
            })),
            "product-evidence",
        )
    }

    fn envelope(record: AbiStagingRecordV1, kind: &str) -> PublicRecordEnvelopeV1 {
        let record_sha256 = canonical_sha256(&record).unwrap();
        let digest = canonical_sha256(&json!({
            "artifact_type": kind,
            "config_sha256": record_sha256,
        }))
        .unwrap();
        PublicRecordEnvelopeV1 {
            kind: kind.to_string(),
            digest: digest.clone(),
            record_sha256,
            immutable_reference: format!(
                "ghcr.io/kandelo-dev/homebrew-tap-core-abi-8-candidates/records@sha256:{digest}"
            ),
            record,
        }
    }

    fn formula_subject() -> String {
        "{\"architecture\":\"wasm32\",\"identity\":\"bash\",\"kind\":\"formula\"}".to_string()
    }

    fn input() -> CurrentCheckProjectionInputV1 {
        let request = request();
        let request_digest = canonical_sha256(&request).unwrap();
        CurrentCheckProjectionInputV1 {
            schema: 1,
            kind: "kandelo-abi-staging-check-projection-input".to_string(),
            context: CurrentCheckContextV1 {
                repository: REPOSITORY.to_string(),
                pull_request_number: 19,
                exact_head: HEAD.to_string(),
                current_requirements_sha256: request.requirements.digest.clone(),
                current_policy_version: 5,
                current_policy_sha256: digest('d'),
                current_guard_registry_version: 1,
                current_guard_registry_sha256: digest('e'),
            },
            applicable: true,
            discovery_delayed: false,
            expected_request_digest: request_digest.clone(),
            expected_request: Some(request.clone()),
            request: Some(CurrentRequestProjectionV1 {
                digest: request_digest.clone(),
                immutable_reference: format!(
                    "https://github.com/Automattic/kandelo/releases/download/abi-staging-pr-19-sha256-{request_digest}/candidate-request-{HEAD}-sha256-{request_digest}.json"
                ),
                request,
            }),
            tap_plan: Some(CurrentTapPlanProjectionV1 {
                request_digest,
                required_subjects: vec![formula_subject()],
                background_subjects: vec![],
                blockers: vec![],
                record: None,
            }),
            public_records: vec![],
        }
    }

    #[test]
    fn projects_not_applicable_missing_request_and_discovery_delay() {
        let mut fixture = input();
        fixture.applicable = false;
        fixture.expected_request_digest = digest('0');
        fixture.expected_request = None;
        fixture.request = None;
        fixture.tap_plan = None;
        let projection =
            project_current_check(&fixture, RequiredCheckActivationV1::Observe).unwrap();
        assert_eq!(
            projection.computed_conclusion,
            ComputedCheckConclusionV1::NotApplicable
        );
        assert_eq!(projection.published_conclusion, "neutral");

        let mut fixture = input();
        fixture.expected_request_digest = digest('0');
        fixture.expected_request = None;
        fixture.request = None;
        fixture.tap_plan = None;
        fixture.discovery_delayed = true;
        let projection =
            project_current_check(&fixture, RequiredCheckActivationV1::Enforce).unwrap();
        assert_eq!(
            projection.computed_conclusion,
            ComputedCheckConclusionV1::Pending
        );
        assert_eq!(projection.published_conclusion, "in_progress");
        assert!(projection.discovery_delayed);
    }

    #[test]
    fn requires_current_request_head_requirements_and_policy() {
        let fixture = input();
        let projection =
            project_current_check(&fixture, RequiredCheckActivationV1::Observe).unwrap();
        assert_eq!(projection.head_sha, HEAD);
        assert!(projection.external_id.starts_with("abi-staging:19:"));
        assert_eq!(projection.name, "Kandelo PR Check");

        let mut stale = fixture.clone();
        stale.context.exact_head = "3333333333333333333333333333333333333333".to_string();
        assert!(project_current_check(&stale, RequiredCheckActivationV1::Observe).is_err());
        let mut stale = fixture;
        stale.context.current_policy_sha256 = digest('1');
        assert!(project_current_check(&stale, RequiredCheckActivationV1::Observe).is_err());
    }

    #[test]
    fn public_record_envelopes_bind_distinct_manifest_and_record_body_digests() {
        let mut fixture = input();
        let request_digest = fixture.request.as_ref().unwrap().digest.clone();
        let records = candidate_and_verification(&request_digest, "success");
        assert!(
            records
                .iter()
                .all(|record| record.digest != record.record_sha256)
        );
        fixture.public_records.extend(records);
        fixture
            .public_records
            .push(product_record(&request_digest, "success", "eligible"));
        project_current_check(&fixture, RequiredCheckActivationV1::Enforce).unwrap();

        let mut mismatched_body = fixture;
        mismatched_body.public_records[0].record_sha256 = digest('f');
        assert!(
            project_current_check(&mismatched_body, RequiredCheckActivationV1::Enforce,)
                .unwrap_err()
                .contains("body digest")
        );
    }

    #[test]
    fn required_formula_and_product_outcomes_gate_but_background_does_not() {
        let mut fixture = input();
        let request_digest = fixture.request.as_ref().unwrap().digest.clone();
        fixture
            .public_records
            .extend(candidate_and_verification(&request_digest, "success"));
        fixture
            .public_records
            .push(product_record(&request_digest, "success", "eligible"));
        let projection =
            project_current_check(&fixture, RequiredCheckActivationV1::Enforce).unwrap();
        assert_eq!(
            projection.computed_conclusion,
            ComputedCheckConclusionV1::Success
        );
        assert_eq!(projection.published_conclusion, "success");

        let mut product_failure = fixture.clone();
        product_failure
            .public_records
            .retain(|record| record.kind != "product-evidence");
        product_failure.public_records.push(product_record(
            &request_digest,
            "failure",
            "ineligible",
        ));
        let projection =
            project_current_check(&product_failure, RequiredCheckActivationV1::Enforce).unwrap();
        assert_eq!(
            projection.computed_conclusion,
            ComputedCheckConclusionV1::Failure
        );
        assert_eq!(
            projection.required_products[0].state,
            CheckSubjectStateV1::Failure
        );

        let mut background_failure = fixture;
        background_failure
            .tap_plan
            .as_mut()
            .unwrap()
            .background_subjects = vec![formula_subject()];
        background_failure
            .tap_plan
            .as_mut()
            .unwrap()
            .required_subjects
            .clear();
        background_failure.public_records.clear();
        background_failure
            .public_records
            .extend(candidate_and_verification(&request_digest, "failure"));
        background_failure.public_records.push(product_record(
            &request_digest,
            "success",
            "eligible",
        ));
        let projection =
            project_current_check(&background_failure, RequiredCheckActivationV1::Enforce).unwrap();
        assert_eq!(
            projection.computed_conclusion,
            ComputedCheckConclusionV1::Success
        );
        assert_eq!(projection.background[0].state, CheckSubjectStateV1::Failure);
    }

    #[test]
    fn stale_records_do_not_satisfy_the_current_exact_head() {
        let mut fixture = input();
        fixture
            .public_records
            .extend(candidate_and_verification(&digest('1'), "success"));
        fixture
            .public_records
            .push(product_record(&digest('1'), "success", "eligible"));
        let projection =
            project_current_check(&fixture, RequiredCheckActivationV1::Enforce).unwrap();
        assert_eq!(
            projection.computed_conclusion,
            ComputedCheckConclusionV1::Pending
        );
        assert!(
            projection
                .required_formulae
                .iter()
                .all(|item| item.record.is_none())
        );
        assert!(
            projection
                .required_products
                .iter()
                .all(|item| item.evidence.is_none())
        );
    }

    #[test]
    fn observe_neutralizes_failure_and_projection_is_order_independent() {
        let mut fixture = input();
        let request_digest = fixture.request.as_ref().unwrap().digest.clone();
        fixture
            .public_records
            .extend(candidate_and_verification(&request_digest, "failure"));
        fixture
            .public_records
            .push(product_record(&request_digest, "success", "eligible"));
        let first = project_current_check(&fixture, RequiredCheckActivationV1::Observe).unwrap();
        fixture.public_records.reverse();
        let second = project_current_check(&fixture, RequiredCheckActivationV1::Observe).unwrap();
        assert_eq!(first, second);
        assert_eq!(
            first.computed_conclusion,
            ComputedCheckConclusionV1::Failure
        );
        assert_eq!(first.published_conclusion, "neutral");
        assert!(first.summary_markdown.len() <= 8 * 1024);
        assert!(first.details_markdown.len() <= 48 * 1024);
    }

    #[test]
    fn accepted_override_is_visible_and_validated_links_are_required() {
        let mut fixture = input();
        let request_digest = fixture.request.as_ref().unwrap().digest.clone();
        fixture
            .public_records
            .extend(candidate_and_verification(&request_digest, "success"));
        fixture.public_records.push(product_record(
            &request_digest,
            "success",
            "accepted-with-override",
        ));
        let projection =
            project_current_check(&fixture, RequiredCheckActivationV1::Enforce).unwrap();
        assert_eq!(
            projection.required_products[0].state,
            CheckSubjectStateV1::AcceptedWithOverride
        );
        assert!(
            projection
                .details_markdown
                .contains("accepted_with_override")
        );

        fixture.public_records[0].immutable_reference =
            "https://evil.invalid/mutable/latest".to_string();
        assert!(project_current_check(&fixture, RequiredCheckActivationV1::Observe).is_err());
    }

    #[test]
    fn tap_plan_blockers_fail_required_work_and_escape_markdown() {
        let mut fixture = input();
        fixture.tap_plan.as_mut().unwrap().blockers = vec![BlockerV1 {
            guard_code: GuardCodeV1::DependencyUnavailable,
            subject_kind: "formula".to_string(),
            subject: "bash | <blocked>\nsecond line".to_string(),
            record: None,
        }];
        let projection =
            project_current_check(&fixture, RequiredCheckActivationV1::Enforce).unwrap();
        assert_eq!(
            projection.computed_conclusion,
            ComputedCheckConclusionV1::Failure
        );
        assert_eq!(projection.published_conclusion, "failure");
        assert!(
            projection
                .summary_markdown
                .contains("dependency_unavailable")
        );
        assert!(
            projection
                .summary_markdown
                .contains("&#124; &lt;blocked&gt; second line")
        );
        assert!(!projection.summary_markdown.contains("\nsecond line"));
    }

    #[test]
    fn timeout_and_canceled_required_evidence_are_terminal_failures() {
        for outcome in ["timeout", "canceled"] {
            let mut fixture = input();
            let request_digest = fixture.request.as_ref().unwrap().digest.clone();
            let records = candidate_and_verification(&request_digest, outcome);
            fixture.public_records.extend(records);
            fixture
                .public_records
                .push(product_record(&request_digest, "success", "eligible"));
            let projection =
                project_current_check(&fixture, RequiredCheckActivationV1::Enforce).unwrap();
            assert_eq!(
                projection.computed_conclusion,
                ComputedCheckConclusionV1::Failure
            );
            assert_eq!(projection.published_conclusion, "failure");
        }
    }

    #[test]
    fn canonical_input_and_observe_activation_are_closed_interfaces() {
        let fixture = input();
        let canonical = canonical_json_bytes(&fixture).unwrap();
        assert_eq!(parse_projection_input(&canonical).unwrap(), fixture);

        let pretty = serde_json::to_vec_pretty(&fixture).unwrap();
        assert!(parse_projection_input(&pretty).is_err());
        assert_eq!(
            parse_required_check_activation(
                Path::new("required-check-activation.toml"),
                b"schema = 1\nkind = \"kandelo-abi-staging-required-check-activation\"\nmode = \"observe\"\n",
            )
            .unwrap(),
            RequiredCheckActivationV1::Observe,
        );
        assert!(parse_required_check_activation(
            Path::new("required-check-activation.toml"),
            b"schema = 1\nkind = \"kandelo-abi-staging-required-check-activation\"\nmode = \"active\"\n",
        )
        .is_err());
    }

    #[test]
    fn activation_mode_cli_is_closed_and_reports_the_exact_mode() {
        let root = tempfile::tempdir().unwrap();
        let activation_path = root.path().join("activation.toml");
        for (mode, expected) in [("observe", "observe"), ("enforce", "enforce")] {
            std::fs::write(
                &activation_path,
                format!(
                    "schema = 1\nkind = \"kandelo-abi-staging-required-check-activation\"\nmode = \"{mode}\"\n"
                ),
            )
            .unwrap();
            assert_eq!(
                required_check_activation_mode(&activation_path).unwrap(),
                expected,
            );
            run_cli(
                "activation-mode",
                &[
                    "--activation".to_string(),
                    activation_path.display().to_string(),
                ],
            )
            .unwrap();
        }

        std::fs::write(
            &activation_path,
            b"schema = 1\nkind = \"kandelo-abi-staging-required-check-activation\"\nmode = \"active\"\n",
        )
        .unwrap();
        assert!(required_check_activation_mode(&activation_path).is_err());
        std::fs::write(
            &activation_path,
            b"schema = 1\nkind = \"kandelo-abi-staging-required-check-activation\"\nmode = \"observe\"\nextra = true\n",
        )
        .unwrap();
        assert!(required_check_activation_mode(&activation_path).is_err());
        assert!(
            run_cli(
                "activation-mode",
                &[
                    "--source".to_string(),
                    activation_path.display().to_string(),
                ],
            )
            .is_err()
        );
        assert!(run_cli("unknown", &[]).is_err());
        assert!(
            run_cli(
                "activation-mode",
                &[
                    "--activation".to_string(),
                    activation_path.display().to_string(),
                    "extra".to_string(),
                ],
            )
            .is_err()
        );
    }

    #[test]
    fn checked_in_required_check_activation_enforces_exact_staging() {
        let activation_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("abi/staging/required-check-activation.toml");
        assert_eq!(
            required_check_activation_mode(&activation_path).unwrap(),
            "enforce",
        );
    }

    #[cfg(unix)]
    #[test]
    fn activation_mode_rejects_symlink_and_nonregular_inputs() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let activation_path = root.path().join("activation.toml");
        std::fs::write(
            &activation_path,
            b"schema = 1\nkind = \"kandelo-abi-staging-required-check-activation\"\nmode = \"observe\"\n",
        )
        .unwrap();
        let link_path = root.path().join("activation-link.toml");
        symlink(&activation_path, &link_path).unwrap();
        assert!(required_check_activation_mode(&link_path).is_err());
        assert!(required_check_activation_mode(root.path()).is_err());
    }

    #[test]
    fn public_records_must_use_the_exact_candidate_namespace() {
        let mut fixture = input();
        let request_digest = fixture.request.as_ref().unwrap().digest.clone();
        fixture
            .public_records
            .extend(candidate_and_verification(&request_digest, "success"));
        fixture.public_records[0].immutable_reference = format!(
            "ghcr.io/attacker/homebrew-tap-core-abi-8-candidates/records@sha256:{}",
            fixture.public_records[0].digest
        );
        assert!(project_current_check(&fixture, RequiredCheckActivationV1::Observe).is_err());
    }

    #[test]
    fn retry_eligible_terminal_records_remain_pending() {
        let mut fixture = input();
        let request_digest = fixture.request.as_ref().unwrap().digest.clone();
        let mut records = candidate_and_verification(&request_digest, "failure");
        let AbiStagingRecordV1::Verification(receipt) = &mut records[1].record else {
            panic!("fixture verification changed kind");
        };
        receipt.common.retry_state.eligible = true;
        receipt.common.retry_state.next_action =
            crate::abi_staging::records::RetryNextActionV1::Retry;
        records[1] = envelope(records[1].record.clone(), "verification");
        fixture.public_records.extend(records);
        fixture
            .public_records
            .push(product_record(&request_digest, "success", "eligible"));
        let projection =
            project_current_check(&fixture, RequiredCheckActivationV1::Enforce).unwrap();
        assert_eq!(
            projection.computed_conclusion,
            ComputedCheckConclusionV1::Pending
        );
        assert_eq!(
            projection.required_formulae[0].state,
            CheckSubjectStateV1::Pending
        );
        assert!(projection.blockers.is_empty());
    }

    #[test]
    fn details_retain_every_current_sibling_record_link() {
        let mut fixture = input();
        let request_digest = fixture.request.as_ref().unwrap().digest.clone();
        let records = candidate_and_verification(&request_digest, "success");
        let expected = records
            .iter()
            .map(|record| record.digest[..12].to_string())
            .collect::<Vec<_>>();
        fixture.public_records.extend(records);
        fixture
            .public_records
            .push(product_record(&request_digest, "success", "eligible"));
        let projection =
            project_current_check(&fixture, RequiredCheckActivationV1::Observe).unwrap();
        for digest in expected {
            assert!(projection.details_markdown.contains(&digest));
        }
        assert!(
            projection
                .details_markdown
                .contains("Immutable current records")
        );
    }

    #[test]
    fn cli_writes_one_canonical_projection_from_observe_activation() {
        let root = tempfile::tempdir().unwrap();
        let input_path = root.path().join("input.json");
        let activation_path = root.path().join("activation.toml");
        let output_path = root.path().join("projection.json");
        std::fs::write(&input_path, canonical_json_bytes(&input()).unwrap()).unwrap();
        std::fs::write(
            &activation_path,
            b"schema = 1\nkind = \"kandelo-abi-staging-required-check-activation\"\nmode = \"observe\"\n",
        )
        .unwrap();
        run_cli(
            "project",
            &[
                "--input".to_string(),
                input_path.display().to_string(),
                "--activation".to_string(),
                activation_path.display().to_string(),
                "--out".to_string(),
                output_path.display().to_string(),
            ],
        )
        .unwrap();
        let bytes = std::fs::read(output_path).unwrap();
        let projection: CurrentCheckProjectionV1 = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(canonical_json_bytes(&projection).unwrap(), bytes);
        assert_eq!(projection.published_conclusion, "neutral");
    }
}

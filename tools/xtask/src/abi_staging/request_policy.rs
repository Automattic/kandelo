use super::canonical_json::{canonical_json_bytes, validate_repo_path};
use super::product_manifest::{atomic_write_regular, read_bounded_regular_file};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

const POLICY_SCHEMA: u64 = 1;
const POLICY_KIND: &str = "kandelo-abi-staging-request-policy";
const ACTIVATION_KIND: &str = "kandelo-abi-staging-request-feed-activation";
const MAX_POLICY_BYTES: usize = 1024 * 1024;
const MAX_GENERATED_POLICY_BYTES: usize = 16 * 1024 * 1024;
const MAX_REQUEST_ASSET_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PRODUCTS: u64 = 256;
const MAX_EVIDENCE_BINDINGS: u64 = 512;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ForkAuthorizationV1 {
    Disabled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RequestPolicyV1 {
    pub schema: u64,
    pub kind: String,
    pub version: u64,
    pub issuer_repository: String,
    pub issuer_workflow: String,
    pub automatic_same_repository: bool,
    pub fork_authorization: ForkAuthorizationV1,
    pub request_release_tag_prefix: String,
    pub request_asset_max_bytes: u64,
    pub max_products: u64,
    pub max_evidence_bindings: u64,
    pub addressed_taps: Vec<String>,
    pub implementation_paths: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RequestPolicyImplementationV1 {
    pub path: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GeneratedRequestPolicyV1 {
    pub schema: u64,
    pub kind: String,
    pub version: u64,
    pub issuer_repository: String,
    pub issuer_workflow: String,
    pub automatic_same_repository: bool,
    pub fork_authorization: ForkAuthorizationV1,
    pub request_release_tag_prefix: String,
    pub request_asset_max_bytes: u64,
    pub max_products: u64,
    pub max_evidence_bindings: u64,
    pub addressed_taps: Vec<String>,
    pub implementation_paths: Vec<String>,
    pub implementation: Vec<RequestPolicyImplementationV1>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RequestFeedModeV1 {
    Observe,
    Active,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RequestFeedActivationV1 {
    pub schema: u64,
    pub kind: String,
    pub mode: RequestFeedModeV1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RequestPolicyWriteMode {
    Generate,
    Check,
}

pub fn parse_request_policy(path: &Path, bytes: &[u8]) -> Result<RequestPolicyV1, String> {
    if bytes.is_empty() || bytes.len() > MAX_POLICY_BYTES {
        return Err(format!(
            "request policy {} must contain 1 through {MAX_POLICY_BYTES} bytes",
            path.display()
        ));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|error| format!("request policy {} is not UTF-8: {error}", path.display()))?;
    let policy: RequestPolicyV1 = toml::from_str(text)
        .map_err(|error| format!("request policy {} is invalid: {error}", path.display()))?;
    validate_policy(&policy)?;
    Ok(policy)
}

pub fn parse_request_feed_activation(
    path: &Path,
    bytes: &[u8],
) -> Result<RequestFeedActivationV1, String> {
    if bytes.is_empty() || bytes.len() > MAX_POLICY_BYTES {
        return Err(format!(
            "request feed activation {} must contain 1 through {MAX_POLICY_BYTES} bytes",
            path.display()
        ));
    }
    let text = std::str::from_utf8(bytes).map_err(|error| {
        format!(
            "request feed activation {} is not UTF-8: {error}",
            path.display()
        )
    })?;
    let activation: RequestFeedActivationV1 = toml::from_str(text).map_err(|error| {
        format!(
            "request feed activation {} is invalid: {error}",
            path.display()
        )
    })?;
    if activation.schema != POLICY_SCHEMA || activation.kind != ACTIVATION_KIND {
        return Err(format!(
            "request feed activation {} has unsupported schema or kind",
            path.display()
        ));
    }
    Ok(activation)
}

pub fn resolve_request_policy(
    repository_root: &Path,
    policy: &RequestPolicyV1,
) -> Result<GeneratedRequestPolicyV1, String> {
    validate_policy(policy)?;
    validate_repository_root(repository_root)?;

    let mut implementation = Vec::with_capacity(policy.implementation_paths.len());
    for relative in &policy.implementation_paths {
        let path = validate_repo_path(repository_root, relative)?;
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("implementation path {relative:?} is unavailable: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!("implementation path {relative:?} is a symbolic link"));
        }
        if !metadata.is_file() {
            return Err(format!(
                "implementation path {relative:?} must be a regular nonsymlink file"
            ));
        }
        let bytes = fs::read(&path)
            .map_err(|error| format!("cannot read implementation path {relative:?}: {error}"))?;
        implementation.push(RequestPolicyImplementationV1 {
            path: relative.clone(),
            sha256: format!("{:x}", Sha256::digest(bytes)),
        });
    }

    Ok(GeneratedRequestPolicyV1 {
        schema: policy.schema,
        kind: policy.kind.clone(),
        version: policy.version,
        issuer_repository: policy.issuer_repository.clone(),
        issuer_workflow: policy.issuer_workflow.clone(),
        automatic_same_repository: policy.automatic_same_repository,
        fork_authorization: policy.fork_authorization,
        request_release_tag_prefix: policy.request_release_tag_prefix.clone(),
        request_asset_max_bytes: policy.request_asset_max_bytes,
        max_products: policy.max_products,
        max_evidence_bindings: policy.max_evidence_bindings,
        addressed_taps: policy.addressed_taps.clone(),
        implementation_paths: policy.implementation_paths.clone(),
        implementation,
    })
}

pub fn validate_request_policy_update(
    previous: &RequestPolicyV1,
    current: &RequestPolicyV1,
) -> Result<(), String> {
    validate_policy(previous)?;
    validate_policy(current)?;

    let mut previous_meaning = previous.clone();
    let mut current_meaning = current.clone();
    previous_meaning.version = 0;
    current_meaning.version = 0;
    if previous_meaning == current_meaning {
        if previous.version != current.version {
            return Err("request policy version changed without a meaning change".to_string());
        }
        return Ok(());
    }

    let required = previous
        .version
        .checked_add(1)
        .ok_or_else(|| "request policy version cannot be incremented".to_string())?;
    if current.version != required {
        return Err(format!(
            "request policy meaning changed, so version must advance exactly from {} to {required}",
            previous.version
        ));
    }
    Ok(())
}

pub fn write_or_check_request_policy(
    mode: RequestPolicyWriteMode,
    repository_root: &Path,
    source: &Path,
    generated: &Path,
) -> Result<(), String> {
    validate_repository_root(repository_root)?;
    let source = resolve_repository_argument(repository_root, source, false)?;
    let generated = resolve_repository_argument(repository_root, generated, true)?;
    let source_bytes = read_bounded_regular_file(&source, MAX_POLICY_BYTES)?;
    let policy = parse_request_policy(&source, &source_bytes)?;
    let resolved = resolve_request_policy(repository_root, &policy)?;
    let expected = canonical_json_bytes(&resolved)?;

    match mode {
        RequestPolicyWriteMode::Generate => atomic_write_regular(&generated, &expected),
        RequestPolicyWriteMode::Check => {
            let actual = read_bounded_regular_file(&generated, MAX_GENERATED_POLICY_BYTES)?;
            if actual != expected {
                return Err(format!(
                    "generated request policy {} is stale; run `xtask abi-staging request-policy generate`",
                    generated.display()
                ));
            }
            Ok(())
        }
    }
}

pub fn run_cli(action: &str, args: &[String]) -> Result<(), String> {
    let repository_root = crate::repo_root();
    match action {
        "generate" => {
            let flags = parse_path_flags(args, &["--source", "--out"])?;
            write_or_check_request_policy(
                RequestPolicyWriteMode::Generate,
                &repository_root,
                &flags["--source"],
                &flags["--out"],
            )
        }
        "check" => {
            let flags = parse_path_flags(args, &["--source", "--generated"])?;
            write_or_check_request_policy(
                RequestPolicyWriteMode::Check,
                &repository_root,
                &flags["--source"],
                &flags["--generated"],
            )
        }
        _ => Err(format!("unknown request-policy subcommand {action:?}")),
    }
}

fn validate_policy(policy: &RequestPolicyV1) -> Result<(), String> {
    if policy.schema != POLICY_SCHEMA || policy.kind != POLICY_KIND {
        return Err("request policy has unsupported schema or kind".to_string());
    }
    if policy.version == 0 {
        return Err("request policy version must be positive".to_string());
    }
    validate_repository_identity(&policy.issuer_repository, "issuer_repository")?;
    validate_workflow_path(&policy.issuer_workflow)?;
    if !policy.automatic_same_repository {
        return Err("request policy must require automatic same-repository issuance".to_string());
    }
    if policy.request_release_tag_prefix.is_empty()
        || policy.request_release_tag_prefix.len() > 128
        || !policy.request_release_tag_prefix.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'_' | b'-')
        })
    {
        return Err("request release tag prefix is not a bounded stable prefix".to_string());
    }
    if policy.request_asset_max_bytes == 0
        || policy.request_asset_max_bytes > MAX_REQUEST_ASSET_BYTES
    {
        return Err(format!(
            "request_asset_max_bytes must be between 1 and {MAX_REQUEST_ASSET_BYTES}"
        ));
    }
    if policy.max_products == 0 || policy.max_products > MAX_PRODUCTS {
        return Err(format!("max_products must be between 1 and {MAX_PRODUCTS}"));
    }
    if policy.max_evidence_bindings == 0
        || policy.max_evidence_bindings > MAX_EVIDENCE_BINDINGS
    {
        return Err(format!(
            "max_evidence_bindings must be between 1 and {MAX_EVIDENCE_BINDINGS}"
        ));
    }
    validate_sorted_unique_nonempty(&policy.addressed_taps, "addressed_taps")?;
    for tap in &policy.addressed_taps {
        validate_repository_identity(tap, "addressed tap")?;
    }
    validate_sorted_unique_nonempty(&policy.implementation_paths, "implementation_paths")?;
    for path in &policy.implementation_paths {
        validate_repository_path_syntax(path)?;
    }
    Ok(())
}

fn validate_repository_identity(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 256
        || value
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
        || value.contains(['\\', '@', ':'])
    {
        return Err(format!("invalid {field} repository identity {value:?}"));
    }
    let parts = value.split('/').collect::<Vec<_>>();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || !part.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
                })
        })
    {
        return Err(format!("{field} repository identity must be owner/name"));
    }
    Ok(())
}

fn validate_workflow_path(value: &str) -> Result<(), String> {
    validate_repository_path_syntax(value)?;
    let path = Path::new(value);
    if !value.starts_with(".github/workflows/")
        || !matches!(path.extension().and_then(|value| value.to_str()), Some("yml" | "yaml"))
        || value.contains('@')
    {
        return Err(
            "issuer workflow must be an immutable repository path under .github/workflows"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_sorted_unique_nonempty(values: &[String], field: &str) -> Result<(), String> {
    if values.is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    if values.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(format!("{field} must be sorted and duplicate-free"));
    }
    Ok(())
}

fn validate_repository_path_syntax(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 4_096 || value.starts_with('/') || value.contains(['\\', '\0']) {
        return Err(format!("repository path is not normalized: {value:?}"));
    }
    let path = Path::new(value);
    if path.components().any(|component| !matches!(component, Component::Normal(_)))
        || value
            .split('/')
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
    {
        return Err(format!("repository path is not normalized: {value:?}"));
    }
    Ok(())
}

fn validate_repository_root(repository_root: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(repository_root).map_err(|error| {
        format!(
            "cannot inspect repository root {}: {error}",
            repository_root.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "repository root {} must be a nonsymlink directory",
            repository_root.display()
        ));
    }
    Ok(())
}

fn resolve_repository_argument(
    repository_root: &Path,
    argument: &Path,
    allow_missing_leaf: bool,
) -> Result<PathBuf, String> {
    let path = if argument.is_absolute() {
        argument.to_path_buf()
    } else {
        repository_root.join(argument)
    };
    let relative = path.strip_prefix(repository_root).map_err(|_| {
        format!(
            "path {} is outside repository root {}",
            path.display(),
            repository_root.display()
        )
    })?;
    let relative = relative.to_str().ok_or_else(|| {
        format!("repository path {} is not valid UTF-8", relative.display())
    })?;
    validate_repository_path_syntax(relative)?;
    if allow_missing_leaf && fs::symlink_metadata(&path).is_err() {
        let parent = path
            .parent()
            .ok_or_else(|| format!("path {} has no parent", path.display()))?;
        let parent_relative = parent.strip_prefix(repository_root).map_err(|_| {
            format!("path {} is outside repository root", parent.display())
        })?;
        let parent_relative = parent_relative.to_str().ok_or_else(|| {
            format!("repository path {} is not valid UTF-8", parent.display())
        })?;
        if !parent_relative.is_empty() {
            validate_repo_path(repository_root, parent_relative)?;
        }
        return Ok(path);
    }
    validate_repo_path(repository_root, relative)
}

fn parse_path_flags(args: &[String], expected: &[&str]) -> Result<BTreeMap<String, PathBuf>, String> {
    if args.len() != expected.len() * 2 {
        return Err(format!("expected flags: {}", expected.join(" ")));
    }
    let mut flags = BTreeMap::new();
    for pair in args.chunks_exact(2) {
        if !expected.contains(&pair[0].as_str()) {
            return Err(format!("unexpected flag {:?}", pair[0]));
        }
        if flags.insert(pair[0].clone(), PathBuf::from(&pair[1])).is_some() {
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
    use crate::abi_staging::canonical_json::{canonical_json_bytes, canonical_sha256};
    use serde_json::Value;
    use sha2::{Digest, Sha256};
    use std::fs;

    fn repository() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("impl")).unwrap();
        fs::write(root.path().join("impl/a.rs"), b"first implementation\n").unwrap();
        fs::write(root.path().join("impl/b.yml"), b"second implementation\n").unwrap();
        root
    }

    fn policy() -> RequestPolicyV1 {
        RequestPolicyV1 {
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
            implementation_paths: vec!["impl/a.rs".to_string(), "impl/b.yml".to_string()],
        }
    }

    fn policy_toml(policy: &RequestPolicyV1) -> Vec<u8> {
        toml::to_string(policy).unwrap().into_bytes()
    }

    #[test]
    fn parses_exact_policy_and_resolves_every_implementation_digest() {
        let root = repository();
        let expected = policy();
        let parsed = parse_request_policy(
            &root.path().join("request-policy.toml"),
            &policy_toml(&expected),
        )
        .unwrap();
        assert_eq!(parsed, expected);

        let generated = resolve_request_policy(root.path(), &parsed).unwrap();
        assert_eq!(generated.implementation_paths, expected.implementation_paths);
        assert_eq!(generated.implementation.len(), 2);
        for identity in &generated.implementation {
            let bytes = fs::read(root.path().join(&identity.path)).unwrap();
            assert_eq!(identity.sha256, format!("{:x}", Sha256::digest(bytes)));
        }
        assert_eq!(
            canonical_sha256(&generated).unwrap().len(),
            64,
            "generated policy must have a canonical issuance digest",
        );
    }

    #[test]
    fn rejects_unknown_fields_mutable_workflow_refs_and_fork_fallbacks() {
        let root = repository();
        let mut value = toml::Value::try_from(policy()).unwrap();
        value
            .as_table_mut()
            .unwrap()
            .insert("target_abi".to_string(), toml::Value::Integer(8));
        assert!(parse_request_policy(
            &root.path().join("request-policy.toml"),
            toml::to_string(&value).unwrap().as_bytes(),
        )
        .unwrap_err()
        .contains("unknown field"));

        let mut mutable = policy();
        mutable.issuer_workflow.push_str("@main");
        assert!(parse_request_policy(
            &root.path().join("request-policy.toml"),
            &policy_toml(&mutable),
        )
        .unwrap_err()
        .contains("workflow"));

        let fork = String::from_utf8(policy_toml(&policy()))
            .unwrap()
            .replace("fork_authorization = \"disabled\"", "fork_authorization = \"label\"");
        assert!(parse_request_policy(
            &root.path().join("request-policy.toml"),
            fork.as_bytes(),
        )
        .is_err());
    }

    #[test]
    fn policy_contains_no_transition_or_execution_state() {
        let value: Value = serde_json::to_value(policy()).unwrap();
        let text = String::from_utf8(canonical_json_bytes(&value).unwrap()).unwrap();
        for forbidden in [
            "target_abi",
            "source_abi",
            "branch",
            "candidate_url",
            "retry",
            "runner",
            "timestamp",
        ] {
            assert!(!text.contains(forbidden), "policy contains {forbidden}");
        }
        assert!(!text.contains("previous_abi"));
        assert!(!text.contains("next_abi"));
    }

    #[test]
    fn rejects_duplicate_unsafe_missing_directory_and_symlink_paths() {
        let root = repository();

        let mut duplicate = policy();
        duplicate.implementation_paths.push("impl/b.yml".to_string());
        assert!(resolve_request_policy(root.path(), &duplicate)
            .unwrap_err()
            .contains("sorted and duplicate-free"));

        let mut unsafe_path = policy();
        unsafe_path.implementation_paths[0] = "../outside".to_string();
        assert!(resolve_request_policy(root.path(), &unsafe_path).is_err());

        let mut missing = policy();
        missing.implementation_paths[1] = "impl/missing.rs".to_string();
        assert!(resolve_request_policy(root.path(), &missing)
            .unwrap_err()
            .contains("unavailable"));

        let mut directory = policy();
        directory.implementation_paths[0] = "impl".to_string();
        assert!(resolve_request_policy(root.path(), &directory)
            .unwrap_err()
            .contains("regular nonsymlink file"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink("a.rs", root.path().join("impl/link.rs")).unwrap();
            let mut linked = policy();
            linked.implementation_paths[1] = "impl/link.rs".to_string();
            assert!(resolve_request_policy(root.path(), &linked)
                .unwrap_err()
                .contains("symbolic link"));
        }
    }

    #[test]
    fn freshness_detects_changed_implementation_bytes_and_stale_json() {
        let root = repository();
        let source = root.path().join("request-policy.toml");
        let generated = root.path().join("request-policy.generated.json");
        fs::write(&source, policy_toml(&policy())).unwrap();

        write_or_check_request_policy(
            RequestPolicyWriteMode::Generate,
            root.path(),
            &source,
            &generated,
        )
        .unwrap();
        write_or_check_request_policy(
            RequestPolicyWriteMode::Check,
            root.path(),
            &source,
            &generated,
        )
        .unwrap();

        fs::write(root.path().join("impl/a.rs"), b"changed implementation\n").unwrap();
        assert!(write_or_check_request_policy(
            RequestPolicyWriteMode::Check,
            root.path(),
            &source,
            &generated,
        )
        .unwrap_err()
        .contains("stale"));

        fs::write(&generated, b"{}\n").unwrap();
        assert!(write_or_check_request_policy(
            RequestPolicyWriteMode::Check,
            root.path(),
            &source,
            &generated,
        )
        .unwrap_err()
        .contains("stale"));
    }

    #[test]
    fn policy_meaning_changes_require_exactly_one_version_increment() {
        let previous = policy();
        let mut changed = previous.clone();
        changed.max_products -= 1;
        assert!(validate_request_policy_update(&previous, &changed)
            .unwrap_err()
            .contains("version"));
        changed.version += 1;
        validate_request_policy_update(&previous, &changed).unwrap();

        let mut unexplained = previous.clone();
        unexplained.version += 1;
        assert!(validate_request_policy_update(&previous, &unexplained)
            .unwrap_err()
            .contains("without a meaning change"));
    }

    #[test]
    fn activation_is_strict_and_begins_observe_only() {
        let path = Path::new("request-feed-activation.toml");
        let observe = b"schema = 1\nkind = \"kandelo-abi-staging-request-feed-activation\"\nmode = \"observe\"\n";
        assert_eq!(
            parse_request_feed_activation(path, observe).unwrap().mode,
            RequestFeedModeV1::Observe,
        );
        let extra = b"schema = 1\nkind = \"kandelo-abi-staging-request-feed-activation\"\nmode = \"observe\"\nlatest = true\n";
        assert!(parse_request_feed_activation(path, extra).is_err());
    }
}

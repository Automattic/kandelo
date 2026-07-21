use std::fs::{self, File, Metadata};
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};

use crate::pkg_manifest::{BuildToml, DepsManifest, TargetArch};

const MAX_BRIDGE_PLAN_BYTES: usize = 16_384;
const MAX_SCRIPT_ENV_KEYS: usize = 64;
const MAX_SCRIPT_ENV_KEY_BYTES: usize = 4_096;
const MAX_MANIFEST_BYTES: usize = 65_536;
const MAX_BUILD_SCRIPT_BYTES: usize = 1_048_576;
const ZERO_SHA256: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const KANDELO_REPOSITORY_URLS: [&str; 1] = ["https://github.com/Automattic/kandelo"];

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BridgePlan {
    schema: u32,
    tap: String,
    formula: String,
    full_name: String,
    formula_sha256: String,
    support_sha256: PresentNullable<String>,
    tier2_bridge: PresentNullable<BridgeDeclaration>,
}

#[derive(Debug)]
struct PresentNullable<T>(Option<T>);

impl<'de, T> Deserialize<'de> for PresentNullable<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer).map(Self)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BridgeDeclaration {
    package: String,
    script_env_keys: Vec<String>,
    source_sha256: String,
    source_url: String,
    version: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct BridgeAttestation {
    schema: u32,
    arch: String,
    tap: String,
    formula: String,
    full_name: String,
    formula_sha256: String,
    support_sha256: Option<String>,
    tier2_bridge: Option<AttestedBridge>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct AttestedBridge {
    build_toml_sha256: String,
    package: String,
    package_toml_sha256: String,
    script: String,
    script_sha256: String,
    script_env_keys: Vec<String>,
    version: String,
    source_url: String,
    source_sha256: String,
    source_mode: String,
}

pub fn run(args: Vec<String>) -> Result<(), String> {
    let parsed = Args::parse(args)?;
    let attestation = validate(&parsed.repo_root, parsed.arch, &parsed.bridge_plan)?;
    println!(
        "{}",
        serde_json::to_string(&attestation)
            .map_err(|e| format!("serialize Tier-2 bridge attestation: {e}"))?
    );
    Ok(())
}

#[derive(Debug)]
struct Args {
    repo_root: PathBuf,
    arch: TargetArch,
    bridge_plan: PathBuf,
}

impl Args {
    fn parse(args: Vec<String>) -> Result<Self, String> {
        let mut repo_root = None;
        let mut arch = None;
        let mut bridge_plan = None;
        let mut index = 0;
        while index < args.len() {
            let flag = &args[index];
            let value = args
                .get(index + 1)
                .ok_or_else(|| format!("{flag} requires a value"))?;
            match flag.as_str() {
                "--repo-root" => set_once(&mut repo_root, PathBuf::from(value), flag)?,
                "--arch" => {
                    let parsed = match value.as_str() {
                        "wasm32" => TargetArch::Wasm32,
                        "wasm64" => TargetArch::Wasm64,
                        _ => return Err(format!("unsupported architecture {value:?}")),
                    };
                    set_once(&mut arch, parsed, flag)?;
                }
                "--bridge-plan" => {
                    set_once(&mut bridge_plan, PathBuf::from(value), flag)?;
                }
                _ => return Err(format!("unknown argument {flag:?}")),
            }
            index += 2;
        }
        Ok(Self {
            repo_root: repo_root.ok_or_else(|| "--repo-root is required".to_string())?,
            arch: arch.ok_or_else(|| "--arch is required".to_string())?,
            bridge_plan: bridge_plan.ok_or_else(|| "--bridge-plan is required".to_string())?,
        })
    }
}

fn set_once<T>(slot: &mut Option<T>, value: T, flag: &str) -> Result<(), String> {
    if slot.is_some() {
        return Err(format!("{flag} may be provided only once"));
    }
    *slot = Some(value);
    Ok(())
}

fn validate(
    repo_root: &Path,
    arch: TargetArch,
    bridge_plan_path: &Path,
) -> Result<BridgeAttestation, String> {
    let plan_text = read_bounded_utf8(
        bridge_plan_path,
        MAX_BRIDGE_PLAN_BYTES,
        "Tier-2 bridge plan",
    )?;
    let plan: BridgePlan =
        serde_json::from_str(&plan_text).map_err(|e| format!("Tier-2 bridge plan JSON: {e}"))?;
    let plan_value: serde_json::Value =
        serde_json::from_str(&plan_text).map_err(|e| format!("Tier-2 bridge plan JSON: {e}"))?;
    let object = plan_value
        .as_object()
        .ok_or_else(|| "Tier-2 bridge plan must be one JSON object".to_string())?;
    for field in [
        "schema",
        "tap",
        "formula",
        "full_name",
        "formula_sha256",
        "support_sha256",
        "tier2_bridge",
    ] {
        if !object.contains_key(field) {
            return Err(format!("Tier-2 bridge plan is missing field {field:?}"));
        }
    }
    if object.len() != 7 {
        return Err("Tier-2 bridge plan has unexpected fields".to_string());
    }
    validate_plan_identity(&plan)?;
    let Some(bridge) = plan.tier2_bridge.0 else {
        return Ok(BridgeAttestation {
            schema: 1,
            arch: arch.as_str().to_string(),
            tap: plan.tap,
            formula: plan.formula,
            full_name: plan.full_name,
            formula_sha256: plan.formula_sha256,
            support_sha256: plan.support_sha256.0,
            tier2_bridge: None,
        });
    };
    validate_bridge_declaration(&bridge)?;
    let support_sha256 = plan
        .support_sha256
        .0
        .as_deref()
        .ok_or_else(|| "Tier-2 bridge plan is missing its support SHA-256".to_string())?;
    validate_sha256(support_sha256, "support SHA-256")?;

    let repo_root = exact_real_directory(repo_root, "repository root")?;
    let packages = exact_child_directory(&repo_root, "packages", "packages directory")?;
    let registry = exact_child_directory(&packages, "registry", "package registry")?;
    let package_dir = exact_child_directory(&registry, &bridge.package, "registry package")?;

    let package_toml_path = package_dir.join("package.toml");
    let build_toml_path = package_dir.join("build.toml");
    let package_text = read_bounded_utf8(
        &package_toml_path,
        MAX_MANIFEST_BYTES,
        "registry package.toml",
    )?;
    let build_text =
        read_bounded_utf8(&build_toml_path, MAX_MANIFEST_BYTES, "registry build.toml")?;
    let manifest = DepsManifest::parse(&package_text, package_dir.clone())
        .map_err(|e| format!("{}: {e}", package_toml_path.display()))?;
    let build =
        BuildToml::parse(&build_text).map_err(|e| format!("{}: {e}", build_toml_path.display()))?;
    let package_toml_sha256 = sha256_hex(package_text.as_bytes());
    let build_toml_sha256 = sha256_hex(build_text.as_bytes());

    if manifest.name != bridge.package {
        return Err(format!(
            "registry manifest name {:?} differs from bridge package {:?}",
            manifest.name, bridge.package
        ));
    }
    if manifest.version != bridge.version {
        return Err(format!(
            "registry package {:?} version {:?} differs from Formula version {:?}",
            bridge.package, manifest.version, bridge.version
        ));
    }
    if !manifest.target_arches.contains(&arch) {
        return Err(format!(
            "registry package {:?} does not support architecture {:?}",
            bridge.package,
            arch.as_str()
        ));
    }

    if plan.formula != bridge.package {
        return Err(format!(
            "Formula name {:?} differs from bridge package {:?}",
            plan.formula, bridge.package
        ));
    }

    let expected_script_prefix = format!("packages/registry/{}/", bridge.package);
    let script_path = manifest.build.script_path.as_deref().ok_or_else(|| {
        format!(
            "registry package {:?} package.toml must declare build.script_path",
            bridge.package
        )
    })?;
    if !script_path.starts_with(&expected_script_prefix) {
        return Err(format!(
            "registry package {:?} package.toml build.script_path must start with {:?}",
            bridge.package, expected_script_prefix
        ));
    }
    let script = &script_path[expected_script_prefix.len()..];
    validate_component(script, "registry build script", true)?;
    if build.script_path != script_path {
        return Err(format!(
            "registry package {:?} build.toml script_path {:?} differs from {:?}",
            bridge.package, build.script_path, script_path
        ));
    }
    exact_child_file(&package_dir, script, "registry build script")?;
    let script_text = read_bounded_utf8(
        &package_dir.join(script),
        MAX_BUILD_SCRIPT_BYTES,
        "registry build script",
    )?;
    let script_sha256 = sha256_hex(script_text.as_bytes());

    let source_mode = if manifest.source.sha256 == ZERO_SHA256 {
        if !KANDELO_REPOSITORY_URLS.contains(&manifest.source.url.as_str()) {
            return Err(format!(
                "registry package {:?} uses the all-zero in-repository source SHA-256 with unrecognized repository URL {:?}",
                bridge.package, manifest.source.url
            ));
        }
        validate_in_repository_formula_source(&manifest.source.url, &bridge.source_url)?;
        if bridge.source_sha256 == ZERO_SHA256 {
            return Err(
                "in-repository Formula source must have a nonzero SHA-256 checksum".to_string(),
            );
        }
        "in-repository-source"
    } else {
        if manifest.source.url != bridge.source_url
            || manifest.source.sha256 != bridge.source_sha256
        {
            return Err(format!(
                "registry package {:?} source URL/SHA-256 differs from the Formula source",
                bridge.package
            ));
        }
        "exact"
    };

    Ok(BridgeAttestation {
        schema: 1,
        arch: arch.as_str().to_string(),
        tap: plan.tap,
        formula: plan.formula,
        full_name: plan.full_name,
        formula_sha256: plan.formula_sha256,
        support_sha256: Some(support_sha256.to_string()),
        tier2_bridge: Some(AttestedBridge {
            build_toml_sha256,
            package: bridge.package,
            package_toml_sha256,
            script: script.to_string(),
            script_sha256,
            script_env_keys: bridge.script_env_keys,
            version: bridge.version,
            source_url: bridge.source_url,
            source_sha256: bridge.source_sha256,
            source_mode: source_mode.to_string(),
        }),
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn validate_plan_identity(plan: &BridgePlan) -> Result<(), String> {
    if plan.schema != 1 {
        return Err(format!(
            "unsupported Tier-2 bridge plan schema {}",
            plan.schema
        ));
    }
    validate_tap_name(&plan.tap)?;
    validate_component(&plan.formula, "Formula name", false)?;
    if plan.full_name != format!("{}/{}", plan.tap, plan.formula) {
        return Err("Tier-2 bridge plan full_name does not match tap/formula".to_string());
    }
    validate_sha256(&plan.formula_sha256, "Formula SHA-256")?;
    if let Some(support_sha256) = &plan.support_sha256.0 {
        validate_sha256(support_sha256, "support SHA-256")?;
    }
    Ok(())
}

fn validate_bridge_declaration(bridge: &BridgeDeclaration) -> Result<(), String> {
    validate_component(&bridge.package, "bridge package", false)?;
    validate_script_env_keys(&bridge.package, &bridge.script_env_keys)?;
    if bridge.version.is_empty()
        || bridge.version.len() > 255
        || !bridge.version.is_ascii()
        || !bridge
            .version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._+,-".contains(&byte))
        || !bridge.version.as_bytes()[0].is_ascii_alphanumeric()
    {
        return Err(format!("invalid bridge version {:?}", bridge.version));
    }
    validate_source_url(&bridge.source_url)?;
    validate_sha256(&bridge.source_sha256, "Formula source SHA-256")?;
    Ok(())
}

fn validate_script_env_keys(package: &str, keys: &[String]) -> Result<(), String> {
    if keys.len() > MAX_SCRIPT_ENV_KEYS
        || keys.iter().map(String::len).sum::<usize>() > MAX_SCRIPT_ENV_KEY_BYTES
    {
        return Err("bridge script_env_keys exceeds the static key limit".to_string());
    }
    if keys.windows(2).any(|window| window[0] >= window[1]) {
        return Err("bridge script_env_keys must be sorted and unique".to_string());
    }

    let package_prefix = format!(
        "{}_",
        package
            .bytes()
            .map(|byte| if byte.is_ascii_alphanumeric() {
                byte.to_ascii_uppercase() as char
            } else {
                '_'
            })
            .collect::<String>()
    );
    for key in keys {
        if key.is_empty()
            || key.len() > 255
            || !key.as_bytes()[0].is_ascii_uppercase()
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        {
            return Err(format!("invalid bridge script_env key {key:?}"));
        }
        if is_reserved_script_env_key(key) {
            return Err(format!(
                "bridge script_env_keys overrides reserved variable {key:?}"
            ));
        }
        if !(key.starts_with("WASM_POSIX_DEP_") || key.starts_with(&package_prefix)) {
            return Err(format!(
                "bridge script_env key {key:?} is outside the approved namespace"
            ));
        }
    }
    Ok(())
}

fn is_reserved_script_env_key(key: &str) -> bool {
    matches!(
        key,
        "WASM_POSIX_DEP_NAME"
            | "WASM_POSIX_DEP_OUT_DIR"
            | "WASM_POSIX_DEP_SOURCE_DIR"
            | "WASM_POSIX_DEP_SOURCE_SHA256"
            | "WASM_POSIX_DEP_SOURCE_URL"
            | "WASM_POSIX_DEP_TARGET_ARCH"
            | "WASM_POSIX_DEP_VERSION"
            | "WASM_POSIX_DEP_WORK_DIR"
            | "WASM_POSIX_INSTALL_LOCAL_MIRROR"
    )
}

fn validate_in_repository_formula_source(
    repository_url: &str,
    formula_source_url: &str,
) -> Result<(), String> {
    let prefix = format!("{repository_url}/archive/");
    let commit = formula_source_url
        .strip_prefix(&prefix)
        .and_then(|suffix| suffix.strip_suffix(".tar.gz"))
        .ok_or_else(|| {
            format!(
                "in-repository Formula source must be a canonical commit archive from {repository_url:?}"
            )
        })?;
    if commit.len() != 40
        || !commit
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!(
            "in-repository Formula source must pin one 40-character lowercase commit: {formula_source_url:?}"
        ));
    }
    Ok(())
}

fn validate_tap_name(value: &str) -> Result<(), String> {
    let mut parts = value.split('/');
    let owner = parts.next().unwrap_or_default();
    let tap = parts.next().unwrap_or_default();
    if parts.next().is_some() || owner.is_empty() || tap.is_empty() {
        return Err(format!("invalid tap name {value:?}"));
    }
    validate_component(owner, "tap owner", false)?;
    validate_component(tap, "tap name", false)
}

fn validate_component(value: &str, label: &str, allow_uppercase: bool) -> Result<(), String> {
    let valid_first = value
        .as_bytes()
        .first()
        .is_some_and(|byte| byte.is_ascii_alphanumeric());
    let valid_rest = value.bytes().all(|byte| {
        (allow_uppercase && byte.is_ascii_uppercase())
            || byte.is_ascii_lowercase()
            || byte.is_ascii_digit()
            || b"._-".contains(&byte)
    });
    if value.len() > 255 || !valid_first || !valid_rest || value == "." || value == ".." {
        return Err(format!(
            "{label} must be one canonical ASCII path component, got {value:?}"
        ));
    }
    Ok(())
}

fn validate_source_url(value: &str) -> Result<(), String> {
    let host_first = value
        .strip_prefix("https://")
        .and_then(|suffix| suffix.as_bytes().first());
    if value.len() > 2_048
        || !host_first.is_some_and(u8::is_ascii_alphanumeric)
        || !value.is_ascii()
        || value.bytes().any(|byte| {
            byte.is_ascii_control()
                || byte.is_ascii_whitespace()
                || matches!(byte, b'\\' | b'"' | b'`')
        })
    {
        return Err(format!(
            "invalid canonical HTTPS Formula source URL {value:?}"
        ));
    }
    Ok(())
}

fn validate_sha256(value: &str, label: &str) -> Result<(), String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!(
            "{label} must be 64 lowercase hexadecimal characters"
        ));
    }
    Ok(())
}

fn exact_real_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(format!(
            "{label} must be an absolute normalized path: {}",
            path.display()
        ));
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|e| format!("inspect {label} {}: {e}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "{label} must be a real non-symlink directory: {}",
            path.display()
        ));
    }
    let canonical =
        fs::canonicalize(path).map_err(|e| format!("resolve {label} {}: {e}", path.display()))?;
    if canonical != path {
        return Err(format!("{label} path is not canonical: {}", path.display()));
    }
    Ok(canonical)
}

fn exact_child_directory(parent: &Path, child: &str, label: &str) -> Result<PathBuf, String> {
    validate_component(child, label, false)?;
    let path = parent.join(child);
    let canonical = exact_real_directory(&path, label)?;
    if canonical.parent() != Some(parent) {
        return Err(format!(
            "{label} is not a direct child of {}",
            parent.display()
        ));
    }
    Ok(canonical)
}

fn exact_child_file(parent: &Path, child: &str, label: &str) -> Result<(), String> {
    validate_component(child, label, true)?;
    let path = parent.join(child);
    let metadata = secure_file_metadata(&path, label)?;
    if fs::canonicalize(&path)
        .map_err(|e| format!("resolve {label} {}: {e}", path.display()))?
        .parent()
        != Some(parent)
    {
        return Err(format!(
            "{label} is not a direct child of {}",
            parent.display()
        ));
    }
    reject_hard_link(&metadata, &path, label)
}

fn secure_file_metadata(path: &Path, label: &str) -> Result<Metadata, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|e| format!("inspect {label} {}: {e}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "{label} must be a regular non-symlink file: {}",
            path.display()
        ));
    }
    Ok(metadata)
}

fn reject_hard_link(metadata: &Metadata, path: &Path, label: &str) -> Result<(), String> {
    if metadata.nlink() != 1 {
        return Err(format!(
            "{label} must not have hard-link aliases: {}",
            path.display()
        ));
    }
    Ok(())
}

fn read_bounded_utf8(path: &Path, max_bytes: usize, label: &str) -> Result<String, String> {
    let before = secure_file_metadata(path, label)?;
    reject_hard_link(&before, path, label)?;
    let mut file = File::open(path).map_err(|e| format!("open {label} {}: {e}", path.display()))?;
    let opened_before = file
        .metadata()
        .map_err(|e| format!("inspect opened {label} {}: {e}", path.display()))?;
    if !opened_before.is_file() {
        return Err(format!(
            "opened {label} is not a regular file: {}",
            path.display()
        ));
    }
    reject_hard_link(&opened_before, path, label)?;
    require_same_file(&before, &opened_before, path, label)?;
    let mut bytes = Vec::with_capacity(max_bytes.saturating_add(1));
    file.by_ref()
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read {label} {}: {e}", path.display()))?;
    if bytes.is_empty() || bytes.len() > max_bytes {
        return Err(format!(
            "{label} must contain 1 to {max_bytes} bytes: {}",
            path.display()
        ));
    }
    let after = secure_file_metadata(path, label)?;
    reject_hard_link(&after, path, label)?;
    let opened_after = file
        .metadata()
        .map_err(|e| format!("reinspect opened {label} {}: {e}", path.display()))?;
    require_same_file(&before, &opened_after, path, label)?;
    require_same_file(&before, &after, path, label)?;
    if opened_after.len() != bytes.len() as u64 {
        return Err(format!(
            "{label} changed while it was read: {}",
            path.display()
        ));
    }
    String::from_utf8(bytes).map_err(|_| format!("{label} is not UTF-8: {}", path.display()))
}

fn require_same_file(
    expected: &Metadata,
    actual: &Metadata,
    path: &Path,
    label: &str,
) -> Result<(), String> {
    if expected.dev() != actual.dev()
        || expected.ino() != actual.ino()
        || expected.len() != actual.len()
    {
        return Err(format!(
            "{label} changed while it was read: {}",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::symlink;

    struct Fixture {
        _temp: tempfile::TempDir,
        root: PathBuf,
        plan: PathBuf,
        package: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = fs::canonicalize(temp.path()).unwrap();
            let package = root.join("packages/registry/bridge");
            fs::create_dir_all(&package).unwrap();
            fs::write(package.join("build-bridge.sh"), "#!/bin/sh\n").unwrap();
            fs::write(package.join("package.toml"), package_toml(false)).unwrap();
            fs::write(package.join("build.toml"), build_toml()).unwrap();
            let plan = root.join("bridge-plan.json");
            fs::write(&plan, bridge_plan()).unwrap();
            Self {
                _temp: temp,
                root,
                plan,
                package,
            }
        }

        fn root(&self) -> &Path {
            &self.root
        }

        fn validate(&self, arch: TargetArch) -> Result<BridgeAttestation, String> {
            validate(self.root(), arch, &self.plan)
        }
    }

    fn bridge_plan() -> String {
        serde_json::json!({
            "schema": 1,
            "tap": "kandelo-dev/tap-core",
            "formula": "bridge",
            "full_name": "kandelo-dev/tap-core/bridge",
            "formula_sha256": "a".repeat(64),
            "support_sha256": "b".repeat(64),
            "tier2_bridge": {
                "package": "bridge",
                "script_env_keys": ["WASM_POSIX_DEP_ZLIB_DIR"],
                "source_sha256": "c".repeat(64),
                "source_url": "https://example.test/bridge-1.2.3.tar.gz",
                "version": "1.2.3"
            }
        })
        .to_string()
    }

    fn package_toml(in_repository: bool) -> String {
        let (url, sha256) = if in_repository {
            (KANDELO_REPOSITORY_URLS[0], ZERO_SHA256)
        } else {
            (
                "https://example.test/bridge-1.2.3.tar.gz",
                "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            )
        };
        format!(
            r#"kind = "program"
name = "bridge"
version = "1.2.3"
kernel_abi = 7
arches = ["wasm32", "wasm64"]
depends_on = []

[source]
url = "{url}"
sha256 = "{sha256}"

[license]
spdx = "MIT"

[build]
script_path = "packages/registry/bridge/build-bridge.sh"

[[outputs]]
name = "bridge"
wasm = "bridge.wasm"
"#
        )
    }

    fn build_toml() -> &'static str {
        r#"script_path = "packages/registry/bridge/build-bridge.sh"
repo_url = "https://github.com/Automattic/kandelo"
commit = ""

[binary]
index_url = "https://example.test/index.toml"
"#
    }

    #[test]
    fn validates_exact_registry_identity_and_source() {
        let fixture = Fixture::new();
        let attestation = fixture.validate(TargetArch::Wasm32).unwrap();
        let document = serde_json::to_value(&attestation).unwrap();
        assert_eq!(
            document
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            [
                "arch",
                "formula",
                "formula_sha256",
                "full_name",
                "schema",
                "support_sha256",
                "tap",
                "tier2_bridge",
            ]
        );
        assert_eq!(
            document["tier2_bridge"]
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            [
                "build_toml_sha256",
                "package",
                "package_toml_sha256",
                "script",
                "script_env_keys",
                "script_sha256",
                "source_mode",
                "source_sha256",
                "source_url",
                "version",
            ]
        );
        let bridge = attestation.tier2_bridge.unwrap();
        assert_eq!(bridge.package, "bridge");
        assert_eq!(
            bridge.package_toml_sha256,
            sha256_hex(package_toml(false).as_bytes())
        );
        assert_eq!(
            bridge.build_toml_sha256,
            sha256_hex(build_toml().as_bytes())
        );
        assert_eq!(bridge.script, "build-bridge.sh");
        assert_eq!(bridge.script_sha256, sha256_hex(b"#!/bin/sh\n"));
        assert_eq!(bridge.script_env_keys, ["WASM_POSIX_DEP_ZLIB_DIR"]);
        assert_eq!(bridge.version, "1.2.3");
        assert_eq!(bridge.source_mode, "exact");
        assert_eq!(attestation.arch, "wasm32");
    }

    #[test]
    fn accepts_only_recognized_in_repository_source_sentinel() {
        let fixture = Fixture::new();
        fs::write(fixture.package.join("package.toml"), package_toml(true)).unwrap();
        let mut plan: serde_json::Value = serde_json::from_str(&bridge_plan()).unwrap();
        plan["tier2_bridge"]["source_url"] = serde_json::json!(format!(
            "{}/archive/{}.tar.gz",
            KANDELO_REPOSITORY_URLS[0],
            "d".repeat(40)
        ));
        fs::write(&fixture.plan, serde_json::to_vec(&plan).unwrap()).unwrap();
        let attestation = fixture.validate(TargetArch::Wasm64).unwrap();
        assert_eq!(
            attestation.tier2_bridge.unwrap().source_mode,
            "in-repository-source"
        );

        let bad = package_toml(true).replace(
            KANDELO_REPOSITORY_URLS[0],
            "https://github.com/unrelated/project",
        );
        fs::write(fixture.package.join("package.toml"), bad).unwrap();
        let error = fixture.validate(TargetArch::Wasm32).unwrap_err();
        assert!(error.contains("unrecognized repository URL"), "{error}");
    }

    #[test]
    fn in_repository_source_requires_one_immutable_same_repository_archive() {
        for (source_url, source_sha256, expected) in [
            (
                "https://example.test/unrelated.tar.gz".to_string(),
                "c".repeat(64),
                "canonical commit archive",
            ),
            (
                format!("{}/archive/main.tar.gz", KANDELO_REPOSITORY_URLS[0]),
                "c".repeat(64),
                "40-character lowercase commit",
            ),
            (
                format!(
                    "{}/archive/{}.tar.gz",
                    KANDELO_REPOSITORY_URLS[0],
                    "d".repeat(40)
                ),
                ZERO_SHA256.to_string(),
                "nonzero SHA-256",
            ),
        ] {
            let fixture = Fixture::new();
            fs::write(fixture.package.join("package.toml"), package_toml(true)).unwrap();
            let mut plan: serde_json::Value = serde_json::from_str(&bridge_plan()).unwrap();
            plan["tier2_bridge"]["source_url"] = serde_json::json!(source_url);
            plan["tier2_bridge"]["source_sha256"] = serde_json::json!(source_sha256);
            fs::write(&fixture.plan, serde_json::to_vec(&plan).unwrap()).unwrap();
            let error = fixture.validate(TargetArch::Wasm32).unwrap_err();
            assert!(error.contains(expected), "{error}");
        }
    }

    #[test]
    fn rejects_nonzero_source_mismatch_even_for_kandelo_url() {
        let fixture = Fixture::new();
        let bad = package_toml(false).replace(
            "https://example.test/bridge-1.2.3.tar.gz",
            KANDELO_REPOSITORY_URLS[0],
        );
        fs::write(fixture.package.join("package.toml"), bad).unwrap();
        let error = fixture.validate(TargetArch::Wasm32).unwrap_err();
        assert!(error.contains("differs from the Formula source"), "{error}");
    }

    #[test]
    fn rejects_manifest_identity_script_and_arch_mismatches() {
        let fixture = Fixture::new();
        let manifest_path = fixture.package.join("package.toml");
        fs::write(
            &manifest_path,
            package_toml(false).replace("version = \"1.2.3\"", "version = \"9.9.9\""),
        )
        .unwrap();
        assert!(
            fixture
                .validate(TargetArch::Wasm32)
                .unwrap_err()
                .contains("differs from Formula version")
        );

        fs::write(&manifest_path, package_toml(false)).unwrap();
        fs::write(
            fixture.package.join("build.toml"),
            build_toml().replace("build-bridge.sh", "other.sh"),
        )
        .unwrap();
        assert!(
            fixture
                .validate(TargetArch::Wasm32)
                .unwrap_err()
                .contains("build.toml script_path")
        );

        fs::write(fixture.package.join("build.toml"), build_toml()).unwrap();
        fs::write(
            &manifest_path,
            package_toml(false)
                .replace("arches = [\"wasm32\", \"wasm64\"]", "arches = [\"wasm32\"]"),
        )
        .unwrap();
        assert!(
            fixture
                .validate(TargetArch::Wasm64)
                .unwrap_err()
                .contains("does not support architecture")
        );

        fs::write(
            &manifest_path,
            package_toml(false).replace(
                "packages/registry/bridge/build-bridge.sh",
                "packages/registry/bridge/other.sh",
            ),
        )
        .unwrap();
        assert!(
            fixture
                .validate(TargetArch::Wasm32)
                .unwrap_err()
                .contains("differs from")
        );

        fs::write(
            &manifest_path,
            package_toml(false).replace("name = \"bridge\"", "name = \"other\""),
        )
        .unwrap();
        assert!(fixture.validate(TargetArch::Wasm32).is_err());
    }

    #[test]
    fn derives_one_direct_script_from_both_authoritative_manifests() {
        let fixture = Fixture::new();
        let nested = "packages/registry/bridge/nested/build-bridge.sh";
        fs::create_dir(fixture.package.join("nested")).unwrap();
        fs::write(
            fixture.package.join("nested/build-bridge.sh"),
            "#!/bin/sh\n",
        )
        .unwrap();
        fs::write(
            fixture.package.join("package.toml"),
            package_toml(false).replace("packages/registry/bridge/build-bridge.sh", nested),
        )
        .unwrap();
        fs::write(
            fixture.package.join("build.toml"),
            build_toml().replace("packages/registry/bridge/build-bridge.sh", nested),
        )
        .unwrap();
        let error = fixture.validate(TargetArch::Wasm32).unwrap_err();
        assert!(
            error.contains("one canonical ASCII path component"),
            "{error}"
        );
    }

    #[test]
    fn rejects_formula_package_and_script_env_contract_mismatches() {
        let fixture = Fixture::new();
        let mut plan: serde_json::Value = serde_json::from_str(&bridge_plan()).unwrap();
        plan["formula"] = serde_json::json!("other");
        plan["full_name"] = serde_json::json!("kandelo-dev/tap-core/other");
        fs::write(&fixture.plan, serde_json::to_vec(&plan).unwrap()).unwrap();
        assert!(
            fixture
                .validate(TargetArch::Wasm32)
                .unwrap_err()
                .contains("differs from bridge package")
        );

        for (keys, expected) in [
            (serde_json::json!(["Z_KEY", "A_KEY"]), "sorted and unique"),
            (
                serde_json::json!(["WASM_POSIX_DEP_SOURCE_DIR"]),
                "reserved variable",
            ),
            (
                serde_json::json!(["WASM_POSIX_INSTALL_LOCAL_MIRROR"]),
                "reserved variable",
            ),
            (serde_json::json!(["PATH"]), "approved namespace"),
        ] {
            let fixture = Fixture::new();
            let mut plan: serde_json::Value = serde_json::from_str(&bridge_plan()).unwrap();
            plan["tier2_bridge"]["script_env_keys"] = keys;
            fs::write(&fixture.plan, serde_json::to_vec(&plan).unwrap()).unwrap();
            let error = fixture.validate(TargetArch::Wasm32).unwrap_err();
            assert!(error.contains(expected), "{error}");
        }
    }

    #[test]
    fn enforces_script_env_key_count_and_aggregate_boundaries() {
        let exact_keys = (0..64)
            .map(|index| {
                let prefix = format!("BRIDGE_{index:02}_");
                format!("{prefix}{}", "A".repeat(64 - prefix.len()))
            })
            .collect::<Vec<_>>();
        assert_eq!(exact_keys.len(), MAX_SCRIPT_ENV_KEYS);
        assert_eq!(
            exact_keys.iter().map(String::len).sum::<usize>(),
            MAX_SCRIPT_ENV_KEY_BYTES
        );

        let fixture = Fixture::new();
        let mut plan: serde_json::Value = serde_json::from_str(&bridge_plan()).unwrap();
        plan["tier2_bridge"]["script_env_keys"] = serde_json::json!(exact_keys);
        fs::write(&fixture.plan, serde_json::to_vec(&plan).unwrap()).unwrap();
        assert!(fixture.validate(TargetArch::Wasm32).is_ok());

        let fixture = Fixture::new();
        let mut plan: serde_json::Value = serde_json::from_str(&bridge_plan()).unwrap();
        let count_over = (0..65)
            .map(|index| format!("BRIDGE_{index:02}"))
            .collect::<Vec<_>>();
        plan["tier2_bridge"]["script_env_keys"] = serde_json::json!(count_over);
        fs::write(&fixture.plan, serde_json::to_vec(&plan).unwrap()).unwrap();
        assert!(
            fixture
                .validate(TargetArch::Wasm32)
                .unwrap_err()
                .contains("static key limit")
        );

        let fixture = Fixture::new();
        let mut plan: serde_json::Value = serde_json::from_str(&bridge_plan()).unwrap();
        let mut bytes_over = exact_keys;
        bytes_over.last_mut().unwrap().push('A');
        plan["tier2_bridge"]["script_env_keys"] = serde_json::json!(bytes_over);
        fs::write(&fixture.plan, serde_json::to_vec(&plan).unwrap()).unwrap();
        assert!(
            fixture
                .validate(TargetArch::Wasm32)
                .unwrap_err()
                .contains("static key limit")
        );
    }

    #[test]
    fn independently_rejects_a_source_url_without_a_host() {
        let fixture = Fixture::new();
        let mut plan: serde_json::Value = serde_json::from_str(&bridge_plan()).unwrap();
        plan["tier2_bridge"]["source_url"] = serde_json::json!("https://");
        fs::write(&fixture.plan, serde_json::to_vec(&plan).unwrap()).unwrap();
        let error = fixture.validate(TargetArch::Wasm32).unwrap_err();
        assert!(error.contains("invalid canonical HTTPS"), "{error}");
    }

    #[test]
    fn active_in_repository_bridges_name_exact_authoritative_provenance() {
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        for package in ["lsof", "modeset", "posix-utils-lite"] {
            let package_dir = repo_root.join("packages/registry").join(package);
            let manifest = DepsManifest::parse(
                &fs::read_to_string(package_dir.join("package.toml")).unwrap(),
                package_dir.clone(),
            )
            .unwrap();
            let build =
                BuildToml::parse(&fs::read_to_string(package_dir.join("build.toml")).unwrap())
                    .unwrap();
            assert_eq!(manifest.source.url, KANDELO_REPOSITORY_URLS[0], "{package}");
            assert_eq!(manifest.source.sha256, ZERO_SHA256, "{package}");
            assert_eq!(
                build.repo_url,
                format!("{}.git", KANDELO_REPOSITORY_URLS[0]),
                "{package}"
            );
        }
    }

    #[test]
    fn rejects_symlinked_registry_nodes_and_hard_linked_inputs() {
        let fixture = Fixture::new();
        let package_toml_path = fixture.package.join("package.toml");
        let real_manifest = fixture.root().join("real-package.toml");
        fs::rename(&package_toml_path, &real_manifest).unwrap();
        symlink(&real_manifest, &package_toml_path).unwrap();
        assert!(
            fixture
                .validate(TargetArch::Wasm32)
                .unwrap_err()
                .contains("regular non-symlink")
        );

        fs::remove_file(&package_toml_path).unwrap();
        fs::rename(&real_manifest, &package_toml_path).unwrap();
        let alias = fixture.root().join("manifest-alias");
        fs::hard_link(&package_toml_path, &alias).unwrap();
        assert!(
            fixture
                .validate(TargetArch::Wasm32)
                .unwrap_err()
                .contains("hard-link aliases")
        );
    }

    #[test]
    fn rejects_symlinked_intermediate_directories_and_plan() {
        for node in ["packages", "registry", "package"] {
            let fixture = Fixture::new();
            let (path, replacement) = match node {
                "packages" => (
                    fixture.root().join("packages"),
                    fixture.root().join("real-packages"),
                ),
                "registry" => (
                    fixture.root().join("packages/registry"),
                    fixture.root().join("real-registry"),
                ),
                "package" => (fixture.package.clone(), fixture.root().join("real-package")),
                _ => unreachable!(),
            };
            fs::rename(&path, &replacement).unwrap();
            symlink(&replacement, &path).unwrap();
            let error = fixture.validate(TargetArch::Wasm32).unwrap_err();
            assert!(
                error.contains("real non-symlink directory"),
                "{node}: {error}"
            );
        }

        let fixture = Fixture::new();
        let real_plan = fixture.root().join("real-plan.json");
        fs::rename(&fixture.plan, &real_plan).unwrap();
        symlink(&real_plan, &fixture.plan).unwrap();
        assert!(
            fixture
                .validate(TargetArch::Wasm32)
                .unwrap_err()
                .contains("regular non-symlink")
        );
    }

    #[test]
    fn rejects_missing_or_non_file_manifest_and_script_nodes() {
        let fixture = Fixture::new();
        fs::remove_file(fixture.package.join("build.toml")).unwrap();
        fs::create_dir(fixture.package.join("build.toml")).unwrap();
        assert!(
            fixture
                .validate(TargetArch::Wasm32)
                .unwrap_err()
                .contains("regular non-symlink")
        );

        let fixture = Fixture::new();
        fs::remove_file(fixture.package.join("build-bridge.sh")).unwrap();
        assert!(
            fixture
                .validate(TargetArch::Wasm32)
                .unwrap_err()
                .contains("registry build script")
        );
    }

    #[test]
    fn bounded_read_rejects_empty_oversized_and_invalid_utf8_inputs() {
        let fixture = Fixture::new();
        let manifest = fixture.package.join("package.toml");
        fs::write(&manifest, []).unwrap();
        assert!(
            fixture
                .validate(TargetArch::Wasm32)
                .unwrap_err()
                .contains("1 to 65536 bytes")
        );

        let mut file = File::create(&manifest).unwrap();
        file.write_all(&vec![b'#'; MAX_MANIFEST_BYTES + 1]).unwrap();
        assert!(
            fixture
                .validate(TargetArch::Wasm32)
                .unwrap_err()
                .contains("1 to 65536 bytes")
        );

        fs::write(&manifest, [0xff]).unwrap();
        assert!(
            fixture
                .validate(TargetArch::Wasm32)
                .unwrap_err()
                .contains("not UTF-8")
        );
    }

    #[test]
    fn bounded_read_accepts_an_exactly_maximum_size_valid_manifest() {
        let fixture = Fixture::new();
        let mut text = package_toml(false);
        text.push('#');
        text.extend(std::iter::repeat_n('x', MAX_MANIFEST_BYTES - text.len()));
        assert_eq!(text.len(), MAX_MANIFEST_BYTES);
        fs::write(fixture.package.join("package.toml"), text).unwrap();
        assert!(fixture.validate(TargetArch::Wasm32).is_ok());
    }

    #[test]
    fn build_script_read_enforces_its_exact_size_boundary() {
        let fixture = Fixture::new();
        let script = fixture.package.join("build-bridge.sh");
        fs::write(&script, vec![b'#'; MAX_BUILD_SCRIPT_BYTES]).unwrap();
        assert!(fixture.validate(TargetArch::Wasm32).is_ok());

        fs::write(&script, vec![b'#'; MAX_BUILD_SCRIPT_BYTES + 1]).unwrap();
        let error = fixture.validate(TargetArch::Wasm32).unwrap_err();
        assert!(error.contains("1 to 1048576 bytes"), "{error}");
    }

    #[test]
    fn authoritative_toml_parsers_reject_malformed_tails_and_duplicates() {
        let fixture = Fixture::new();
        fs::write(
            fixture.package.join("package.toml"),
            format!("{}\nmalformed = [", package_toml(false)),
        )
        .unwrap();
        assert!(fixture.validate(TargetArch::Wasm32).is_err());

        let fixture = Fixture::new();
        fs::write(
            fixture.package.join("package.toml"),
            package_toml(false).replacen(
                "name = \"bridge\"",
                "name = \"bridge\"\nname = 'bridge'",
                1,
            ),
        )
        .unwrap();
        assert!(fixture.validate(TargetArch::Wasm32).is_err());

        let fixture = Fixture::new();
        fs::write(
            fixture.package.join("build.toml"),
            format!("{}\nmalformed = [", build_toml()),
        )
        .unwrap();
        assert!(fixture.validate(TargetArch::Wasm32).is_err());
    }

    #[test]
    fn bridge_plan_parser_rejects_extra_fields_and_size_overflow() {
        let fixture = Fixture::new();
        let extra = bridge_plan().replace("{\"formula\"", "{\"extra\":true,\"formula\"");
        fs::write(&fixture.plan, extra).unwrap();
        assert!(
            fixture
                .validate(TargetArch::Wasm32)
                .unwrap_err()
                .contains("unknown field")
        );

        let mut exact = bridge_plan().into_bytes();
        exact.resize(MAX_BRIDGE_PLAN_BYTES, b' ');
        fs::write(&fixture.plan, exact).unwrap();
        assert!(fixture.validate(TargetArch::Wasm32).is_ok());

        fs::write(&fixture.plan, vec![b' '; MAX_BRIDGE_PLAN_BYTES + 1]).unwrap();
        assert!(
            fixture
                .validate(TargetArch::Wasm32)
                .unwrap_err()
                .contains("1 to 16384 bytes")
        );

        fs::write(&fixture.plan, [0xff]).unwrap();
        assert!(
            fixture
                .validate(TargetArch::Wasm32)
                .unwrap_err()
                .contains("not UTF-8")
        );
    }

    #[test]
    fn bridge_plan_rejects_duplicate_fields_and_missing_support_digest() {
        let fixture = Fixture::new();
        let duplicate = bridge_plan().replacen("\"schema\":1", "\"schema\":1,\"schema\":1", 1);
        fs::write(&fixture.plan, duplicate).unwrap();
        assert!(fixture.validate(TargetArch::Wasm32).is_err());

        let mut plan: serde_json::Value = serde_json::from_str(&bridge_plan()).unwrap();
        plan["support_sha256"] = serde_json::Value::Null;
        fs::write(&fixture.plan, serde_json::to_vec(&plan).unwrap()).unwrap();
        assert!(
            fixture
                .validate(TargetArch::Wasm32)
                .unwrap_err()
                .contains("missing its support SHA-256")
        );

        for field in ["support_sha256", "tier2_bridge"] {
            let mut plan: serde_json::Value = serde_json::from_str(&bridge_plan()).unwrap();
            plan.as_object_mut().unwrap().remove(field);
            fs::write(&fixture.plan, serde_json::to_vec(&plan).unwrap()).unwrap();
            let error = fixture.validate(TargetArch::Wasm32).unwrap_err();
            assert!(error.contains("missing field"), "{field}: {error}");
        }
    }

    #[test]
    fn cli_rejects_duplicate_and_unknown_arguments() {
        let duplicate = Args::parse(vec![
            "--repo-root".into(),
            "/tmp/a".into(),
            "--repo-root".into(),
            "/tmp/b".into(),
            "--arch".into(),
            "wasm32".into(),
            "--bridge-plan".into(),
            "/tmp/plan".into(),
        ])
        .unwrap_err();
        assert!(duplicate.contains("only once"));
        assert!(Args::parse(vec!["--unknown".into(), "value".into()]).is_err());
        assert!(Args::parse(vec!["--arch".into(), "native".into()]).is_err());
    }

    #[test]
    fn null_bridge_is_a_valid_noop() {
        let fixture = Fixture::new();
        let mut plan: serde_json::Value = serde_json::from_str(&bridge_plan()).unwrap();
        plan["tier2_bridge"] = serde_json::Value::Null;
        plan["support_sha256"] = serde_json::Value::Null;
        fs::write(&fixture.plan, serde_json::to_vec(&plan).unwrap()).unwrap();
        let attestation = fixture.validate(TargetArch::Wasm32).unwrap();
        assert_eq!(attestation.arch, "wasm32");
        assert_eq!(attestation.support_sha256, None);
        assert_eq!(attestation.tier2_bridge, None);
        let document = serde_json::to_value(attestation).unwrap();
        assert_eq!(
            document
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            [
                "arch",
                "formula",
                "formula_sha256",
                "full_name",
                "schema",
                "support_sha256",
                "tap",
                "tier2_bridge",
            ]
        );
        assert!(document.get("support_sha256").unwrap().is_null());
        assert!(document.get("tier2_bridge").unwrap().is_null());
    }
}

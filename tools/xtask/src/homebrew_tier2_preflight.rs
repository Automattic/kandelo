use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, Metadata};
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};

use crate::pkg_manifest::TargetArch;

const MAX_BRIDGE_PLAN_BYTES: usize = 65_536;
const MAX_SCRIPT_ENV_KEYS: usize = 64;
const MAX_SCRIPT_ENV_KEY_BYTES: usize = 4_096;
const MAX_MANIFEST_BYTES: usize = 65_536;
const MAX_BUILD_SCRIPT_BYTES: usize = 1_048_576;
const MAX_TAP_RECIPE_FILES: usize = 512;
const MAX_TAP_RECIPE_FILE_BYTES: u64 = 16_777_216;
const MAX_TAP_RECIPE_BYTES: u64 = 67_108_864;
const MAX_TAP_RECIPE_RESOURCES: usize = 32;
const MAX_TAP_RECIPE_RESOURCE_NAME_BYTES: usize = 128;
const MAX_TAP_RECIPE_RESOURCE_URL_BYTES: usize = 1_024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BridgePlan {
    schema: u32,
    tap: String,
    formula: String,
    full_name: String,
    formula_sha256: String,
    support_sha256: PresentNullable<String>,
    support_runtime_sha256: PresentNullable<String>,
    tier2_bridge: PresentNullable<BridgeDeclaration>,
    #[serde(default)]
    tap_recipe: Option<TapRecipeDeclaration>,
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TapRecipeDeclaration {
    declared_dependencies: Vec<String>,
    manifest_sha256: String,
    pkg_version: String,
    resources: Vec<TapRecipeResource>,
    script_env_keys: Vec<String>,
    source_sha256: String,
    source_url: String,
    version: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
struct TapRecipeResource {
    name: String,
    source_sha256: String,
    source_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TapRecipeManifest {
    schema: u32,
    dependencies: Vec<String>,
    entrypoint: String,
    files: Vec<TapRecipeFile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TapRecipeFile {
    bytes: u64,
    mode: String,
    path: String,
    sha256: String,
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
    support_runtime_sha256: Option<String>,
    tier2_bridge: Option<AttestedBridge>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tap_recipe: Option<AttestedTapRecipe>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct AttestedBridge {
    package: String,
    script: String,
    script_sha256: String,
    script_env_keys: Vec<String>,
    version: String,
    source_url: String,
    source_sha256: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct AttestedTapRecipe {
    dependencies: Vec<String>,
    entrypoint: String,
    file_count: usize,
    manifest_sha256: String,
    pkg_version: String,
    resources: Vec<TapRecipeResource>,
    script_env_keys: Vec<String>,
    source_sha256: String,
    source_url: String,
    total_bytes: u64,
    version: String,
}

pub fn run(args: Vec<String>) -> Result<(), String> {
    let parsed = Args::parse(args)?;
    let attestation = validate(
        &parsed.repo_root,
        parsed.tap_root.as_deref(),
        parsed.arch,
        &parsed.bridge_plan,
    )?;
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
    tap_root: Option<PathBuf>,
    arch: TargetArch,
    bridge_plan: PathBuf,
}

impl Args {
    fn parse(args: Vec<String>) -> Result<Self, String> {
        let mut repo_root = None;
        let mut tap_root = None;
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
                "--tap-root" => set_once(&mut tap_root, PathBuf::from(value), flag)?,
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
            tap_root,
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
    tap_root: Option<&Path>,
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
    let common_fields = [
        "schema",
        "tap",
        "formula",
        "full_name",
        "formula_sha256",
        "support_sha256",
        "support_runtime_sha256",
        "tier2_bridge",
    ];
    for field in common_fields {
        if !object.contains_key(field) {
            return Err(format!("Tier-2 bridge plan is missing field {field:?}"));
        }
    }
    match plan.schema {
        4 if object.len() == 8 && !object.contains_key("tap_recipe") => {}
        3 if object.len() == 9 && object.contains_key("tap_recipe") => {}
        4 | 3 => return Err("Tier-2 bridge plan has unexpected fields".to_string()),
        _ => {}
    }
    validate_plan_identity(&plan)?;
    if let Some(recipe) = plan.tap_recipe.as_ref() {
        if plan.tier2_bridge.0.is_some() {
            return Err("tap recipe and registry bridge cannot both be active".to_string());
        }
        let support_sha256 = plan
            .support_sha256
            .0
            .as_deref()
            .ok_or_else(|| "tap recipe plan is missing its support SHA-256".to_string())?
            .to_string();
        validate_sha256(&support_sha256, "support SHA-256")?;
        let support_runtime_sha256 = plan
            .support_runtime_sha256
            .0
            .as_deref()
            .ok_or_else(|| "tap recipe plan is missing its support runtime SHA-256".to_string())?
            .to_string();
        validate_sha256(&support_runtime_sha256, "support runtime SHA-256")?;
        let tap_root = tap_root
            .ok_or_else(|| "--tap-root is required for an active tap recipe".to_string())?;
        let attested_recipe = validate_tap_recipe(tap_root, &plan, recipe)?;
        return Ok(BridgeAttestation {
            schema: 3,
            arch: arch.as_str().to_string(),
            tap: plan.tap,
            formula: plan.formula,
            full_name: plan.full_name,
            formula_sha256: plan.formula_sha256,
            support_sha256: Some(support_sha256),
            support_runtime_sha256: Some(support_runtime_sha256),
            tier2_bridge: None,
            tap_recipe: Some(attested_recipe),
        });
    }
    let Some(bridge) = plan.tier2_bridge.0 else {
        return Ok(BridgeAttestation {
            schema: 4,
            arch: arch.as_str().to_string(),
            tap: plan.tap,
            formula: plan.formula,
            full_name: plan.full_name,
            formula_sha256: plan.formula_sha256,
            support_sha256: plan.support_sha256.0,
            support_runtime_sha256: plan.support_runtime_sha256.0,
            tier2_bridge: None,
            tap_recipe: None,
        });
    };
    validate_bridge_declaration(&bridge)?;
    let support_sha256 = plan
        .support_sha256
        .0
        .as_deref()
        .ok_or_else(|| "Tier-2 bridge plan is missing its support SHA-256".to_string())?;
    validate_sha256(support_sha256, "support SHA-256")?;
    let support_runtime_sha256 =
        plan.support_runtime_sha256.0.as_deref().ok_or_else(|| {
            "Tier-2 bridge plan is missing its support runtime SHA-256".to_string()
        })?;
    validate_sha256(support_runtime_sha256, "support runtime SHA-256")?;

    let repo_root = exact_real_directory(repo_root, "repository root")?;
    let packages = exact_child_directory(&repo_root, "packages", "packages directory")?;
    let registry = exact_child_directory(&packages, "registry", "package registry")?;
    let package_dir = exact_child_directory(&registry, &bridge.package, "registry package")?;

    let script = format!("build-{}.sh", bridge.package);
    validate_component(&script, "registry build script", true)?;
    exact_child_file(&package_dir, &script, "registry build script")?;
    let script_text = read_bounded_utf8(
        &package_dir.join(&script),
        MAX_BUILD_SCRIPT_BYTES,
        "registry build script",
    )?;
    let script_sha256 = sha256_hex(script_text.as_bytes());

    Ok(BridgeAttestation {
        schema: 4,
        arch: arch.as_str().to_string(),
        tap: plan.tap,
        formula: plan.formula,
        full_name: plan.full_name,
        formula_sha256: plan.formula_sha256,
        support_sha256: Some(support_sha256.to_string()),
        support_runtime_sha256: Some(support_runtime_sha256.to_string()),
        tier2_bridge: Some(AttestedBridge {
            package: bridge.package,
            script,
            script_sha256,
            script_env_keys: bridge.script_env_keys,
            version: bridge.version,
            source_url: bridge.source_url,
            source_sha256: bridge.source_sha256,
        }),
        tap_recipe: None,
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn validate_tap_recipe(
    tap_root: &Path,
    plan: &BridgePlan,
    recipe: &TapRecipeDeclaration,
) -> Result<AttestedTapRecipe, String> {
    validate_tap_recipe_declaration(recipe, &plan.formula)?;
    let tap_root = exact_real_directory(tap_root, "tap root")?;
    let kandelo = exact_real_directory(&tap_root.join("Kandelo"), "tap Kandelo directory")?;
    if kandelo.parent() != Some(tap_root.as_path()) {
        return Err("tap Kandelo directory is not a direct tap-root child".to_string());
    }
    require_mode(
        &fs::symlink_metadata(&kandelo)
            .map_err(|e| format!("inspect tap Kandelo directory {}: {e}", kandelo.display()))?,
        0o755,
        &kandelo,
        "tap Kandelo directory",
    )?;
    let recipes = exact_child_directory(&kandelo, "recipes", "tap recipe directory")?;
    require_mode(
        &fs::symlink_metadata(&recipes)
            .map_err(|e| format!("inspect tap recipe directory {}: {e}", recipes.display()))?,
        0o755,
        &recipes,
        "tap recipe directory",
    )?;
    let recipe_root = exact_child_directory(&recipes, &plan.formula, "Formula recipe root")?;
    require_mode(
        &fs::symlink_metadata(&recipe_root)
            .map_err(|e| format!("inspect Formula recipe root {}: {e}", recipe_root.display()))?,
        0o755,
        &recipe_root,
        "Formula recipe root",
    )?;
    let manifest_path = recipe_root.join("recipe.json");
    exact_child_file(&recipe_root, "recipe.json", "Formula recipe manifest")?;
    require_mode(
        &secure_file_metadata(&manifest_path, "Formula recipe manifest")?,
        0o644,
        &manifest_path,
        "Formula recipe manifest",
    )?;
    let manifest_text = read_bounded_utf8(
        &manifest_path,
        MAX_MANIFEST_BYTES,
        "Formula recipe manifest",
    )?;
    let manifest_sha256 = sha256_hex(manifest_text.as_bytes());
    if manifest_sha256 != recipe.manifest_sha256 {
        return Err(format!(
            "Formula recipe manifest SHA-256 differs from the Formula declaration: {}",
            manifest_path.display()
        ));
    }
    let manifest: TapRecipeManifest = serde_json::from_str(&manifest_text)
        .map_err(|e| format!("Formula recipe manifest JSON: {e}"))?;
    if manifest.schema != 1 {
        return Err(format!(
            "unsupported Formula recipe manifest schema {}",
            manifest.schema
        ));
    }
    validate_relative_recipe_path(&manifest.entrypoint, "Formula recipe entrypoint")?;
    if !manifest.entrypoint.ends_with(".sh") {
        return Err("Formula recipe entrypoint must be a .sh file".to_string());
    }
    if manifest.files.is_empty() || manifest.files.len() > MAX_TAP_RECIPE_FILES {
        return Err(format!(
            "Formula recipe manifest must list 1 to {MAX_TAP_RECIPE_FILES} files"
        ));
    }
    if manifest
        .files
        .windows(2)
        .any(|window| window[0].path >= window[1].path)
    {
        return Err("Formula recipe files must be sorted by unique path".to_string());
    }
    if manifest
        .dependencies
        .windows(2)
        .any(|window| window[0] >= window[1])
    {
        return Err("Formula recipe dependencies must be sorted and unique".to_string());
    }
    for dependency in &manifest.dependencies {
        validate_formula_full_name(dependency, "Formula recipe dependency")?;
    }
    if manifest.dependencies != recipe.declared_dependencies {
        return Err(
            "Formula recipe dependencies differ from the Formula's declared target dependencies"
                .to_string(),
        );
    }
    let dependency_env_keys = manifest
        .dependencies
        .iter()
        .map(|dependency| dependency_env_key(dependency))
        .collect::<BTreeSet<_>>();
    if let Some(conflict) = recipe
        .script_env_keys
        .iter()
        .find(|key| dependency_env_keys.contains(key.as_str()))
    {
        return Err(format!(
            "Formula recipe script_env_keys overrides dependency prefix {conflict:?}"
        ));
    }

    let mut expected_files = BTreeMap::new();
    let mut expected_directories = BTreeSet::from([PathBuf::new()]);
    let mut total_bytes = 0_u64;
    for file in &manifest.files {
        validate_relative_recipe_path(&file.path, "Formula recipe file")?;
        validate_sha256(&file.sha256, "Formula recipe file SHA-256")?;
        let mode = validate_recipe_mode(&file.mode)?;
        if file.bytes > MAX_TAP_RECIPE_FILE_BYTES {
            return Err(format!(
                "Formula recipe file exceeds {MAX_TAP_RECIPE_FILE_BYTES} bytes: {:?}",
                file.path
            ));
        }
        total_bytes = total_bytes
            .checked_add(file.bytes)
            .ok_or_else(|| "Formula recipe byte count overflow".to_string())?;
        if total_bytes > MAX_TAP_RECIPE_BYTES {
            return Err(format!(
                "Formula recipe exceeds {MAX_TAP_RECIPE_BYTES} total bytes"
            ));
        }
        let relative = PathBuf::from(&file.path);
        let mut parent = relative.parent();
        while let Some(directory) = parent {
            expected_directories.insert(directory.to_path_buf());
            parent = directory.parent();
        }
        expected_files.insert(relative, (file.bytes, file.sha256.as_str(), mode));
    }
    if !expected_files.contains_key(Path::new(&manifest.entrypoint)) {
        return Err("Formula recipe entrypoint is not listed in files".to_string());
    }

    let mut actual_files = BTreeSet::new();
    let mut actual_directories = BTreeSet::from([PathBuf::new()]);
    inspect_recipe_tree(
        &recipe_root,
        &recipe_root,
        &mut actual_files,
        &mut actual_directories,
    )?;
    actual_files.remove(Path::new("recipe.json"));
    if actual_files != expected_files.keys().cloned().collect() {
        let missing = expected_files
            .keys()
            .filter(|path| !actual_files.contains(*path))
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>();
        let unexpected = actual_files
            .iter()
            .filter(|path| !expected_files.contains_key(*path))
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>();
        return Err(format!(
            "Formula recipe tree differs from its manifest (missing={missing:?}, unexpected={unexpected:?})"
        ));
    }
    if actual_directories != expected_directories {
        return Err("Formula recipe tree contains an undeclared or empty directory".to_string());
    }
    for (relative, (expected_bytes, expected_sha256, expected_mode)) in &expected_files {
        let path = recipe_root.join(relative);
        require_mode(
            &secure_file_metadata(&path, "Formula recipe file")?,
            *expected_mode,
            &path,
            "Formula recipe file",
        )?;
        let bytes = read_bounded_bytes(
            &path,
            MAX_TAP_RECIPE_FILE_BYTES as usize,
            "Formula recipe file",
            true,
        )?;
        if bytes.len() as u64 != *expected_bytes {
            return Err(format!(
                "Formula recipe file byte count differs from its manifest: {}",
                path.display()
            ));
        }
        if sha256_hex(&bytes) != *expected_sha256 {
            return Err(format!(
                "Formula recipe file SHA-256 differs from its manifest: {}",
                path.display()
            ));
        }
    }

    Ok(AttestedTapRecipe {
        dependencies: manifest.dependencies,
        entrypoint: manifest.entrypoint,
        file_count: manifest.files.len(),
        manifest_sha256,
        pkg_version: recipe.pkg_version.clone(),
        resources: recipe.resources.clone(),
        script_env_keys: recipe.script_env_keys.clone(),
        source_sha256: recipe.source_sha256.clone(),
        source_url: recipe.source_url.clone(),
        total_bytes,
        version: recipe.version.clone(),
    })
}

fn validate_recipe_mode(value: &str) -> Result<u32, String> {
    match value {
        "0644" => Ok(0o644),
        "0755" => Ok(0o755),
        _ => Err(format!(
            "Formula recipe file mode must be \"0644\" or \"0755\", got {value:?}"
        )),
    }
}

fn validate_tap_recipe_declaration(
    recipe: &TapRecipeDeclaration,
    formula: &str,
) -> Result<(), String> {
    validate_sha256(&recipe.manifest_sha256, "Formula recipe manifest SHA-256")?;
    validate_script_env_keys(formula, &recipe.script_env_keys)?;
    if recipe.resources.len() > MAX_TAP_RECIPE_RESOURCES {
        return Err(format!(
            "tap recipe selects more than {MAX_TAP_RECIPE_RESOURCES} resources"
        ));
    }
    if recipe
        .resources
        .windows(2)
        .any(|window| window[0].name >= window[1].name)
    {
        return Err("tap recipe resources must be sorted by unique name".to_string());
    }
    let mut resource_env_keys = BTreeSet::new();
    for resource in &recipe.resources {
        validate_tap_recipe_resource_name(&resource.name)?;
        validate_https_url(
            &resource.source_url,
            MAX_TAP_RECIPE_RESOURCE_URL_BYTES,
            "Formula resource URL",
        )?;
        validate_sha256(&resource.source_sha256, "Formula resource SHA-256")?;
        let key = resource_env_key(&resource.name);
        if !resource_env_keys.insert(key.clone()) {
            return Err(format!(
                "tap recipe resource names collide in environment key {key:?}"
            ));
        }
        if recipe.script_env_keys.binary_search(&key).is_ok() {
            return Err(format!(
                "Formula recipe script_env_keys overrides resource path {key:?}"
            ));
        }
    }
    validate_source_url(&recipe.source_url)?;
    validate_sha256(&recipe.source_sha256, "Formula source SHA-256")?;
    if recipe.version.is_empty()
        || recipe.version.len() > 255
        || !recipe.version.is_ascii()
        || !recipe
            .version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._+,-".contains(&byte))
        || !recipe.version.as_bytes()[0].is_ascii_alphanumeric()
    {
        return Err(format!("invalid tap recipe version {:?}", recipe.version));
    }
    validate_tap_recipe_pkg_version(&recipe.version, &recipe.pkg_version)?;
    if recipe
        .declared_dependencies
        .windows(2)
        .any(|window| window[0] >= window[1])
    {
        return Err("declared target dependencies must be sorted and unique".to_string());
    }
    for dependency in &recipe.declared_dependencies {
        validate_formula_full_name(dependency, "declared target dependency")?;
    }
    let dependency_env_keys = recipe
        .declared_dependencies
        .iter()
        .map(|dependency| dependency_env_key(dependency))
        .collect::<BTreeSet<_>>();
    if let Some(conflict) = resource_env_keys
        .iter()
        .find(|key| dependency_env_keys.contains(key.as_str()))
    {
        return Err(format!(
            "Formula recipe dependency and resource paths collide at {conflict:?}"
        ));
    }
    Ok(())
}

fn validate_tap_recipe_pkg_version(version: &str, pkg_version: &str) -> Result<(), String> {
    if pkg_version.is_empty()
        || pkg_version.len() > 255
        || !pkg_version.is_ascii()
        || !pkg_version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._+,-".contains(&byte))
        || !pkg_version.as_bytes()[0].is_ascii_alphanumeric()
    {
        return Err(format!("invalid tap recipe pkg_version {pkg_version:?}"));
    }
    if pkg_version == version {
        return Ok(());
    }
    let Some(revision) = pkg_version
        .strip_prefix(version)
        .and_then(|suffix| suffix.strip_prefix('_'))
    else {
        return Err("tap recipe pkg_version differs from its base version".to_string());
    };
    if revision.is_empty()
        || revision.as_bytes()[0] == b'0'
        || !revision.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("tap recipe pkg_version has an invalid revision suffix".to_string());
    }
    Ok(())
}

fn validate_formula_full_name(value: &str, label: &str) -> Result<(), String> {
    let (tap, formula) = value
        .rsplit_once('/')
        .ok_or_else(|| format!("{label} must be a fully qualified Formula name"))?;
    validate_tap_name(tap)?;
    validate_component(formula, label, false)
}

fn dependency_env_key(full_name: &str) -> String {
    let name = full_name
        .rsplit_once('/')
        .map_or(full_name, |(_, name)| name);
    let normalized = name
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() {
                byte.to_ascii_uppercase() as char
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!("WASM_POSIX_DEP_{normalized}_DIR")
}

fn resource_env_key(name: &str) -> String {
    let normalized = name
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() {
                byte.to_ascii_uppercase() as char
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!("WASM_POSIX_DEP_RESOURCE_{normalized}_DIR")
}

fn validate_tap_recipe_resource_name(value: &str) -> Result<(), String> {
    let valid_first = value
        .as_bytes()
        .first()
        .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit());
    let valid_rest = value.bytes().all(|byte| {
        byte.is_ascii_lowercase()
            || byte.is_ascii_digit()
            || matches!(byte, b'.' | b'_' | b'+' | b'-')
    });
    if value.len() > MAX_TAP_RECIPE_RESOURCE_NAME_BYTES || !valid_first || !valid_rest {
        return Err(format!(
            "Formula resource name must be one bounded lowercase ASCII name, got {value:?}"
        ));
    }
    Ok(())
}

fn validate_relative_recipe_path(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 1024
        || !value.is_ascii()
        || value.starts_with('/')
        || value.ends_with('/')
        || value.contains('\\')
    {
        return Err(format!(
            "{label} is not a canonical relative path: {value:?}"
        ));
    }
    let path = Path::new(value);
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(part) if !part.is_empty()))
    {
        return Err(format!(
            "{label} is not a canonical relative path: {value:?}"
        ));
    }
    for component in path.components() {
        let Component::Normal(component) = component else {
            unreachable!()
        };
        let component = component
            .to_str()
            .ok_or_else(|| format!("{label} is not UTF-8: {value:?}"))?;
        validate_component(component, label, true)?;
    }
    Ok(())
}

fn inspect_recipe_tree(
    recipe_root: &Path,
    directory: &Path,
    files: &mut BTreeSet<PathBuf>,
    directories: &mut BTreeSet<PathBuf>,
) -> Result<(), String> {
    let directory_metadata = fs::symlink_metadata(directory).map_err(|e| {
        format!(
            "inspect Formula recipe directory {}: {e}",
            directory.display()
        )
    })?;
    require_mode(
        &directory_metadata,
        0o755,
        directory,
        "Formula recipe directory",
    )?;
    let mut entries = fs::read_dir(directory)
        .map_err(|e| format!("read Formula recipe directory {}: {e}", directory.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read Formula recipe directory {}: {e}", directory.display()))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let relative = path
            .strip_prefix(recipe_root)
            .map_err(|_| "Formula recipe path escaped its root".to_string())?
            .to_path_buf();
        let relative_text = relative
            .to_str()
            .ok_or_else(|| format!("Formula recipe path is not UTF-8: {}", path.display()))?;
        validate_relative_recipe_path(relative_text, "Formula recipe tree entry")?;
        let metadata = fs::symlink_metadata(&path)
            .map_err(|e| format!("inspect Formula recipe entry {}: {e}", path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Formula recipe tree must not contain symlinks: {}",
                path.display()
            ));
        }
        if metadata.is_dir() {
            directories.insert(relative);
            inspect_recipe_tree(recipe_root, &path, files, directories)?;
        } else if metadata.is_file() {
            reject_hard_link(&metadata, &path, "Formula recipe file")?;
            files.insert(relative);
            if files.len() > MAX_TAP_RECIPE_FILES + 1 {
                return Err(format!(
                    "Formula recipe tree exceeds {} files",
                    MAX_TAP_RECIPE_FILES
                ));
            }
        } else {
            return Err(format!(
                "Formula recipe tree contains a non-file node: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

fn require_mode(
    metadata: &Metadata,
    expected: u32,
    path: &Path,
    label: &str,
) -> Result<(), String> {
    let actual = metadata.mode() & 0o777;
    if actual != expected {
        return Err(format!(
            "{label} must have mode {expected:04o}, got {actual:04o}: {}",
            path.display()
        ));
    }
    Ok(())
}

fn validate_plan_identity(plan: &BridgePlan) -> Result<(), String> {
    if ![4, 3].contains(&plan.schema) {
        return Err(format!(
            "unsupported Tier-2 bridge plan schema {}",
            plan.schema
        ));
    }
    if plan.schema == 4 && plan.tap_recipe.is_some() {
        return Err("Tier-2 bridge plan schema 4 cannot declare a tap recipe".to_string());
    }
    if plan.schema == 3 && plan.tap_recipe.is_none() {
        return Err("Tier-2 bridge plan schema 3 requires a tap recipe".to_string());
    }
    validate_tap_name(&plan.tap)?;
    validate_component(&plan.formula, "Formula name", false)?;
    if plan.full_name != format!("{}/{}", plan.tap, plan.formula) {
        return Err("Tier-2 bridge plan full_name does not match tap/formula".to_string());
    }
    validate_sha256(&plan.formula_sha256, "Formula SHA-256")?;
    match (&plan.support_sha256.0, &plan.support_runtime_sha256.0) {
        (Some(support_sha256), Some(support_runtime_sha256)) => {
            validate_sha256(support_sha256, "support SHA-256")?;
            validate_sha256(support_runtime_sha256, "support runtime SHA-256")?;
        }
        (None, None) => {}
        _ => {
            return Err(
                "Tier-2 bridge plan support module and runtime SHA-256 must both be present or null"
                    .to_string(),
            );
        }
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
            | "WASM_POSIX_DEP_PKG_VERSION"
            | "WASM_POSIX_DEP_RECIPE_DIR"
            | "WASM_POSIX_DEP_SOURCE_DIR"
            | "WASM_POSIX_DEP_SOURCE_SHA256"
            | "WASM_POSIX_DEP_SOURCE_URL"
            | "WASM_POSIX_DEP_TARGET_ARCH"
            | "WASM_POSIX_DEP_VERSION"
            | "WASM_POSIX_DEP_WORK_DIR"
            | "WASM_POSIX_INSTALL_LOCAL_MIRROR"
    )
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
    validate_https_url(value, 2_048, "Formula source URL")
}

fn validate_https_url(value: &str, max_bytes: usize, label: &str) -> Result<(), String> {
    let host_first = value
        .strip_prefix("https://")
        .and_then(|suffix| suffix.as_bytes().first());
    if value.len() > max_bytes
        || !host_first.is_some_and(u8::is_ascii_alphanumeric)
        || !value.is_ascii()
        || value.bytes().any(|byte| {
            byte.is_ascii_control()
                || byte.is_ascii_whitespace()
                || matches!(byte, b'\\' | b'"' | b'`')
        })
    {
        return Err(format!("invalid canonical HTTPS {label} {value:?}"));
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
    let bytes = read_bounded_bytes(path, max_bytes, label, false)?;
    String::from_utf8(bytes).map_err(|_| format!("{label} is not UTF-8: {}", path.display()))
}

fn read_bounded_bytes(
    path: &Path,
    max_bytes: usize,
    label: &str,
    allow_empty: bool,
) -> Result<Vec<u8>, String> {
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
    if (!allow_empty && bytes.is_empty()) || bytes.len() > max_bytes {
        let minimum = usize::from(!allow_empty);
        return Err(format!(
            "{label} must contain {minimum} to {max_bytes} bytes: {}",
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
    Ok(bytes)
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
        || expected.mtime() != actual.mtime()
        || expected.mtime_nsec() != actual.mtime_nsec()
        || expected.ctime() != actual.ctime()
        || expected.ctime_nsec() != actual.ctime_nsec()
        || expected.mode() != actual.mode()
        || expected.nlink() != actual.nlink()
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
    use std::os::unix::fs::{PermissionsExt, symlink};

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
            fs::write(package.join("package.toml"), package_toml()).unwrap();
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
            validate(self.root(), None, arch, &self.plan)
        }
    }

    fn bridge_plan() -> String {
        serde_json::json!({
            "schema": 4,
            "tap": "kandelo-dev/tap-core",
            "formula": "bridge",
            "full_name": "kandelo-dev/tap-core/bridge",
            "formula_sha256": "a".repeat(64),
            "support_sha256": "b".repeat(64),
            "support_runtime_sha256": "d".repeat(64),
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

    fn write_tap_recipe(fixture: &Fixture) -> PathBuf {
        let recipe_root = fixture.root.join("Kandelo/recipes/bridge");
        fs::create_dir_all(recipe_root.join("patches")).unwrap();
        fs::write(
            recipe_root.join("build.sh"),
            "#!/usr/bin/env bash\nset -euo pipefail\n",
        )
        .unwrap();
        fs::write(recipe_root.join("patches/fix.patch"), b"fixture patch\n").unwrap();
        let manifest = serde_json::json!({
            "schema": 1,
            "dependencies": ["kandelo-dev/tap-core/zlib"],
            "entrypoint": "build.sh",
            "files": [
                {
                    "bytes": 38,
                    "mode": "0644",
                    "path": "build.sh",
                    "sha256": sha256_hex(b"#!/usr/bin/env bash\nset -euo pipefail\n")
                },
                {
                    "bytes": 14,
                    "mode": "0644",
                    "path": "patches/fix.patch",
                    "sha256": sha256_hex(b"fixture patch\n")
                }
            ]
        });
        let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
        fs::write(recipe_root.join("recipe.json"), &manifest_bytes).unwrap();
        let plan = serde_json::json!({
            "schema": 3,
            "tap": "kandelo-dev/tap-core",
            "formula": "bridge",
            "full_name": "kandelo-dev/tap-core/bridge",
            "formula_sha256": "a".repeat(64),
            "support_sha256": "b".repeat(64),
            "support_runtime_sha256": "d".repeat(64),
            "tier2_bridge": null,
            "tap_recipe": {
                "declared_dependencies": ["kandelo-dev/tap-core/zlib"],
                "manifest_sha256": sha256_hex(&manifest_bytes),
                "pkg_version": "1.2.3_2",
                "resources": [{
                    "name": "fixture-data",
                    "source_sha256": "e".repeat(64),
                    "source_url": "https://example.test/fixture-data.tar.gz"
                }],
                "script_env_keys": ["BRIDGE_FEATURE"],
                "source_sha256": "c".repeat(64),
                "source_url": "https://example.test/bridge-1.2.3.tar.gz",
                "version": "1.2.3"
            }
        });
        fs::write(&fixture.plan, serde_json::to_vec(&plan).unwrap()).unwrap();
        recipe_root
    }

    fn package_toml() -> String {
        let url = "https://example.test/bridge-1.2.3.tar.gz";
        let sha256 = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
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
    fn validates_registry_build_helper_with_formula_owned_source() {
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
                "support_runtime_sha256",
                "support_sha256",
                "tap",
                "tier2_bridge",
            ]
        );
        assert_eq!(document["schema"], 4);
        assert_eq!(
            document["tier2_bridge"]
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            [
                "package",
                "script",
                "script_env_keys",
                "script_sha256",
                "source_sha256",
                "source_url",
                "version",
            ]
        );
        let bridge = attestation.tier2_bridge.unwrap();
        assert_eq!(bridge.package, "bridge");
        assert_eq!(bridge.script, "build-bridge.sh");
        assert_eq!(bridge.script_sha256, sha256_hex(b"#!/bin/sh\n"));
        assert_eq!(bridge.script_env_keys, ["WASM_POSIX_DEP_ZLIB_DIR"]);
        assert_eq!(bridge.version, "1.2.3");
        assert_eq!(attestation.arch, "wasm32");
    }

    #[test]
    fn formula_source_and_version_do_not_depend_on_legacy_registry_metadata() {
        let fixture = Fixture::new();
        let manifest_path = fixture.package.join("package.toml");
        let legacy = package_toml()
            .replace("version = \"1.2.3\"", "version = \"0.9.0\"")
            .replace(
                "https://example.test/bridge-1.2.3.tar.gz",
                "https://legacy.example.test/bridge-0.9.0.tar.gz",
            )
            .replace(
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            );
        fs::write(&manifest_path, legacy).unwrap();

        let bridge = fixture
            .validate(TargetArch::Wasm32)
            .unwrap()
            .tier2_bridge
            .unwrap();
        assert_eq!(bridge.version, "1.2.3");
        assert_eq!(
            bridge.source_url,
            "https://example.test/bridge-1.2.3.tar.gz"
        );
        assert_eq!(
            bridge.source_sha256,
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        );
    }

    #[test]
    fn formula_owned_bridge_does_not_require_legacy_registry_manifests() {
        let fixture = Fixture::new();
        fs::remove_file(fixture.package.join("package.toml")).unwrap();
        fs::remove_file(fixture.package.join("build.toml")).unwrap();

        let bridge = fixture
            .validate(TargetArch::Wasm32)
            .unwrap()
            .tier2_bridge
            .unwrap();
        assert_eq!(bridge.package, "bridge");
        assert_eq!(bridge.script, "build-bridge.sh");
    }

    #[test]
    fn validates_a_closed_formula_owned_tap_recipe() {
        let fixture = Fixture::new();
        write_tap_recipe(&fixture);
        let attestation = validate(
            fixture.root(),
            Some(fixture.root()),
            TargetArch::Wasm32,
            &fixture.plan,
        )
        .unwrap();
        let recipe = attestation.tap_recipe.unwrap();
        assert_eq!(attestation.schema, 3);
        assert_eq!(attestation.tier2_bridge, None);
        assert_eq!(recipe.entrypoint, "build.sh");
        assert_eq!(recipe.file_count, 2);
        assert_eq!(recipe.pkg_version, "1.2.3_2");
        assert_eq!(recipe.total_bytes, 52);
        assert_eq!(
            recipe.dependencies,
            ["kandelo-dev/tap-core/zlib".to_string()]
        );
        assert_eq!(
            recipe.resources,
            [TapRecipeResource {
                name: "fixture-data".to_string(),
                source_sha256: "e".repeat(64),
                source_url: "https://example.test/fixture-data.tar.gz".to_string(),
            }]
        );
        assert_eq!(recipe.script_env_keys, ["BRIDGE_FEATURE".to_string()]);
    }

    #[test]
    fn tap_recipe_pkg_version_binds_base_and_positive_revision() {
        for (label, pkg_version, expected_error) in [
            ("base", "1.2.3", None),
            ("revision", "1.2.3_7", None),
            (
                "unrelated base",
                "2.0_7",
                Some("differs from its base version"),
            ),
            ("zero revision", "1.2.3_0", Some("invalid revision suffix")),
            ("leading zero", "1.2.3_07", Some("invalid revision suffix")),
            (
                "nonnumeric revision",
                "1.2.3_x",
                Some("invalid revision suffix"),
            ),
        ] {
            let fixture = Fixture::new();
            write_tap_recipe(&fixture);
            let mut plan: serde_json::Value =
                serde_json::from_slice(&fs::read(&fixture.plan).unwrap()).unwrap();
            plan["tap_recipe"]["pkg_version"] = serde_json::json!(pkg_version);
            fs::write(&fixture.plan, serde_json::to_vec(&plan).unwrap()).unwrap();

            let result = validate(
                fixture.root(),
                Some(fixture.root()),
                TargetArch::Wasm32,
                &fixture.plan,
            );
            if let Some(expected_error) = expected_error {
                let error = result.expect_err(label);
                assert!(error.contains(expected_error), "{label}: {error}");
            } else {
                assert_eq!(
                    result.unwrap().tap_recipe.unwrap().pkg_version,
                    pkg_version,
                    "{label}",
                );
            }
        }

        let fixture = Fixture::new();
        write_tap_recipe(&fixture);
        let mut plan: serde_json::Value =
            serde_json::from_slice(&fs::read(&fixture.plan).unwrap()).unwrap();
        plan["tap_recipe"]
            .as_object_mut()
            .unwrap()
            .remove("pkg_version");
        fs::write(&fixture.plan, serde_json::to_vec(&plan).unwrap()).unwrap();
        assert!(
            validate(
                fixture.root(),
                Some(fixture.root()),
                TargetArch::Wasm32,
                &fixture.plan,
            )
            .unwrap_err()
            .contains("missing field `pkg_version`")
        );
    }

    #[test]
    fn tap_recipe_resources_are_bounded_canonical_and_collision_free() {
        for (mutation, expected) in [
            ("unsorted", "sorted by unique name"),
            ("environment-collision", "collide in environment key"),
            (
                "dependency-resource-collision",
                "dependency and resource paths collide",
            ),
            ("environment-override", "overrides resource path"),
            ("invalid-name", "bounded lowercase ASCII name"),
            ("invalid-sha256", "64 lowercase hexadecimal"),
            (
                "oversized-url",
                "invalid canonical HTTPS Formula resource URL",
            ),
            ("too-many", "more than 32 resources"),
            ("unknown-field", "unknown field"),
        ] {
            let fixture = Fixture::new();
            write_tap_recipe(&fixture);
            let mut plan: serde_json::Value =
                serde_json::from_slice(&fs::read(&fixture.plan).unwrap()).unwrap();
            match mutation {
                "unsorted" => {
                    plan["tap_recipe"]["resources"] = serde_json::json!([
                        {
                            "name": "z-data",
                            "source_sha256": "e".repeat(64),
                            "source_url": "https://example.test/z.tar.gz"
                        },
                        {
                            "name": "a-data",
                            "source_sha256": "e".repeat(64),
                            "source_url": "https://example.test/a.tar.gz"
                        }
                    ]);
                }
                "environment-collision" => {
                    plan["tap_recipe"]["resources"] = serde_json::json!([
                        {
                            "name": "fixture-data",
                            "source_sha256": "e".repeat(64),
                            "source_url": "https://example.test/a.tar.gz"
                        },
                        {
                            "name": "fixture_data",
                            "source_sha256": "e".repeat(64),
                            "source_url": "https://example.test/b.tar.gz"
                        }
                    ]);
                }
                "dependency-resource-collision" => {
                    plan["tap_recipe"]["declared_dependencies"] =
                        serde_json::json!(["kandelo-dev/tap-core/resource-fixture-data"]);
                }
                "environment-override" => {
                    plan["tap_recipe"]["script_env_keys"] =
                        serde_json::json!(["WASM_POSIX_DEP_RESOURCE_FIXTURE_DATA_DIR"]);
                }
                "invalid-name" => {
                    plan["tap_recipe"]["resources"][0]["name"] = serde_json::json!("Fixture");
                }
                "invalid-sha256" => {
                    plan["tap_recipe"]["resources"][0]["source_sha256"] = serde_json::json!("f");
                }
                "oversized-url" => {
                    plan["tap_recipe"]["resources"][0]["source_url"] =
                        serde_json::json!(format!("https://example.test/{}", "a".repeat(1_005)));
                }
                "too-many" => {
                    plan["tap_recipe"]["resources"] = serde_json::Value::Array(
                        (0..=MAX_TAP_RECIPE_RESOURCES)
                            .map(|index| {
                                serde_json::json!({
                                    "name": format!("resource-{index:02}"),
                                    "source_sha256": "e".repeat(64),
                                    "source_url": format!("https://example.test/{index}.tar.gz")
                                })
                            })
                            .collect(),
                    );
                }
                "unknown-field" => {
                    plan["tap_recipe"]["resources"][0]["path"] =
                        serde_json::json!("/caller/selected");
                }
                _ => unreachable!(),
            }
            fs::write(&fixture.plan, serde_json::to_vec(&plan).unwrap()).unwrap();
            let error = validate(
                fixture.root(),
                Some(fixture.root()),
                TargetArch::Wasm32,
                &fixture.plan,
            )
            .unwrap_err();
            assert!(error.contains(expected), "{mutation}: {error}");
        }
    }

    #[test]
    fn tap_recipe_accepts_a_bounded_resource_plan_above_the_legacy_size_limit() {
        let fixture = Fixture::new();
        write_tap_recipe(&fixture);
        let mut plan: serde_json::Value =
            serde_json::from_slice(&fs::read(&fixture.plan).unwrap()).unwrap();
        plan["tap_recipe"]["resources"] = serde_json::Value::Array(
            (0..MAX_TAP_RECIPE_RESOURCES)
                .map(|index| {
                    serde_json::json!({
                        "name": format!("resource-{index:02}"),
                        "source_sha256": "e".repeat(64),
                        "source_url": format!(
                            "https://example.test/{index}/{}",
                            "a".repeat(600)
                        )
                    })
                })
                .collect(),
        );
        let plan_bytes = serde_json::to_vec(&plan).unwrap();
        assert!(plan_bytes.len() > 16_384);
        assert!(plan_bytes.len() <= MAX_BRIDGE_PLAN_BYTES);
        fs::write(&fixture.plan, plan_bytes).unwrap();

        let attestation = validate(
            fixture.root(),
            Some(fixture.root()),
            TargetArch::Wasm32,
            &fixture.plan,
        )
        .unwrap();

        assert_eq!(
            attestation.tap_recipe.unwrap().resources.len(),
            MAX_TAP_RECIPE_RESOURCES
        );
    }

    #[test]
    fn tap_recipe_requires_the_exact_closed_manifest_tree() {
        for mutation in [
            "changed-file",
            "unlisted-file",
            "missing-file",
            "empty-directory",
            "mode",
            "symlink",
            "hard-link",
        ] {
            let fixture = Fixture::new();
            let recipe_root = write_tap_recipe(&fixture);
            match mutation {
                "changed-file" => {
                    fs::write(recipe_root.join("patches/fix.patch"), b"changed patch\n").unwrap()
                }
                "unlisted-file" => fs::write(recipe_root.join("extra"), b"extra").unwrap(),
                "missing-file" => fs::remove_file(recipe_root.join("patches/fix.patch")).unwrap(),
                "empty-directory" => fs::create_dir(recipe_root.join("empty")).unwrap(),
                "mode" => fs::set_permissions(
                    recipe_root.join("build.sh"),
                    fs::Permissions::from_mode(0o755),
                )
                .unwrap(),
                "symlink" => {
                    symlink("build.sh", recipe_root.join("alias")).unwrap();
                }
                "hard-link" => {
                    fs::hard_link(recipe_root.join("build.sh"), recipe_root.join("alias")).unwrap();
                }
                _ => unreachable!(),
            }
            let error = validate(
                fixture.root(),
                Some(fixture.root()),
                TargetArch::Wasm32,
                &fixture.plan,
            )
            .unwrap_err();
            assert!(
                error.contains("differs")
                    || error.contains("undeclared or empty")
                    || error.contains("mode")
                    || error.contains("symlink")
                    || error.contains("hard-link"),
                "{mutation}: {error}"
            );
        }
    }

    #[test]
    fn tap_recipe_rejects_manifest_traversal_and_undeclared_dependencies() {
        for (mutation, expected) in [
            ("traversal", "canonical relative path"),
            (
                "dependency",
                "differ from the Formula's declared target dependencies",
            ),
            ("dependency-env", "overrides dependency prefix"),
            ("manifest-digest", "manifest SHA-256 differs"),
            ("mode", "file mode must be"),
        ] {
            let fixture = Fixture::new();
            let recipe_root = write_tap_recipe(&fixture);
            let manifest_path = recipe_root.join("recipe.json");
            let mut manifest: serde_json::Value =
                serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
            let mut plan: serde_json::Value =
                serde_json::from_slice(&fs::read(&fixture.plan).unwrap()).unwrap();
            match mutation {
                "traversal" => {
                    manifest["files"][0]["path"] = serde_json::json!("../build.sh");
                    let bytes = serde_json::to_vec(&manifest).unwrap();
                    fs::write(&manifest_path, &bytes).unwrap();
                    plan["tap_recipe"]["manifest_sha256"] = serde_json::json!(sha256_hex(&bytes));
                }
                "dependency" => {
                    manifest["dependencies"] = serde_json::json!(["kandelo-dev/tap-core/ncurses"]);
                    let bytes = serde_json::to_vec(&manifest).unwrap();
                    fs::write(&manifest_path, &bytes).unwrap();
                    plan["tap_recipe"]["manifest_sha256"] = serde_json::json!(sha256_hex(&bytes));
                }
                "dependency-env" => {
                    plan["tap_recipe"]["script_env_keys"] =
                        serde_json::json!(["WASM_POSIX_DEP_ZLIB_DIR"]);
                }
                "manifest-digest" => {
                    plan["tap_recipe"]["manifest_sha256"] = serde_json::json!("e".repeat(64));
                }
                "mode" => {
                    manifest["files"][0]["mode"] = serde_json::json!("0777");
                    let bytes = serde_json::to_vec(&manifest).unwrap();
                    fs::write(&manifest_path, &bytes).unwrap();
                    plan["tap_recipe"]["manifest_sha256"] = serde_json::json!(sha256_hex(&bytes));
                }
                _ => unreachable!(),
            }
            fs::write(&fixture.plan, serde_json::to_vec(&plan).unwrap()).unwrap();
            let error = validate(
                fixture.root(),
                Some(fixture.root()),
                TargetArch::Wasm32,
                &fixture.plan,
            )
            .unwrap_err();
            assert!(error.contains(expected), "{mutation}: {error}");
        }
    }

    #[test]
    fn tap_recipe_requires_its_exact_tap_root_and_excludes_registry_authority() {
        let fixture = Fixture::new();
        write_tap_recipe(&fixture);
        let error = validate(fixture.root(), None, TargetArch::Wasm32, &fixture.plan).unwrap_err();
        assert!(error.contains("--tap-root is required"), "{error}");

        let mut plan: serde_json::Value =
            serde_json::from_slice(&fs::read(&fixture.plan).unwrap()).unwrap();
        let bridge_document: serde_json::Value = serde_json::from_str(&bridge_plan()).unwrap();
        plan["tier2_bridge"] = bridge_document["tier2_bridge"].clone();
        fs::write(&fixture.plan, serde_json::to_vec(&plan).unwrap()).unwrap();
        let error = validate(
            fixture.root(),
            Some(fixture.root()),
            TargetArch::Wasm32,
            &fixture.plan,
        )
        .unwrap_err();
        assert!(error.contains("cannot both be active"), "{error}");
    }

    #[test]
    fn bridge_plan_rejects_previous_and_unknown_schemas() {
        let fixture = Fixture::new();
        for schema in [1, 2] {
            let mut plan: serde_json::Value = serde_json::from_str(&bridge_plan()).unwrap();
            plan["schema"] = schema.into();
            fs::write(&fixture.plan, serde_json::to_vec(&plan).unwrap()).unwrap();
            let error = fixture.validate(TargetArch::Wasm32).unwrap_err();
            assert_eq!(
                error,
                format!("unsupported Tier-2 bridge plan schema {schema}")
            );
        }
    }

    #[test]
    fn accepts_explicit_formula_to_registry_package_mapping() {
        let fixture = Fixture::new();
        let mut plan: serde_json::Value = serde_json::from_str(&bridge_plan()).unwrap();
        plan["formula"] = serde_json::json!("python");
        plan["full_name"] = serde_json::json!("kandelo-dev/tap-core/python");
        plan["tier2_bridge"]["script_env_keys"] = serde_json::json!(["BRIDGE_CONFIGURE"]);
        fs::write(&fixture.plan, serde_json::to_vec(&plan).unwrap()).unwrap();
        let attestation = fixture.validate(TargetArch::Wasm32).unwrap();
        assert_eq!(attestation.formula, "python");
        assert_eq!(attestation.full_name, "kandelo-dev/tap-core/python");
        assert_eq!(attestation.tier2_bridge.unwrap().package, "bridge");
    }

    #[test]
    fn rejects_script_env_contract_mismatches() {
        for (keys, expected) in [
            (serde_json::json!(["Z_KEY", "A_KEY"]), "sorted and unique"),
            (
                serde_json::json!(["WASM_POSIX_DEP_SOURCE_DIR"]),
                "reserved variable",
            ),
            (
                serde_json::json!(["WASM_POSIX_DEP_PKG_VERSION"]),
                "reserved variable",
            ),
            (
                serde_json::json!(["WASM_POSIX_INSTALL_LOCAL_MIRROR"]),
                "reserved variable",
            ),
            (
                serde_json::json!(["PYTHON_CONFIGURE"]),
                "approved namespace",
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
    fn rejects_missing_or_non_file_script_nodes() {
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
                .contains("1 to 65536 bytes")
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
        let duplicate = bridge_plan().replacen("\"schema\":4", "\"schema\":4,\"schema\":4", 1);
        fs::write(&fixture.plan, duplicate).unwrap();
        assert!(fixture.validate(TargetArch::Wasm32).is_err());

        let mut plan: serde_json::Value = serde_json::from_str(&bridge_plan()).unwrap();
        plan["support_sha256"] = serde_json::Value::Null;
        plan["support_runtime_sha256"] = serde_json::Value::Null;
        fs::write(&fixture.plan, serde_json::to_vec(&plan).unwrap()).unwrap();
        assert!(
            fixture
                .validate(TargetArch::Wasm32)
                .unwrap_err()
                .contains("missing its support SHA-256")
        );

        for field in ["support_sha256", "support_runtime_sha256", "tier2_bridge"] {
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
        plan["support_runtime_sha256"] = serde_json::Value::Null;
        fs::write(&fixture.plan, serde_json::to_vec(&plan).unwrap()).unwrap();
        let attestation = fixture.validate(TargetArch::Wasm32).unwrap();
        assert_eq!(attestation.arch, "wasm32");
        assert_eq!(attestation.support_sha256, None);
        assert_eq!(attestation.support_runtime_sha256, None);
        assert_eq!(attestation.tier2_bridge, None);
        let document = serde_json::to_value(attestation).unwrap();
        assert_eq!(document["schema"], 4);
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
                "support_runtime_sha256",
                "support_sha256",
                "tap",
                "tier2_bridge",
            ]
        );
        assert!(document.get("support_sha256").unwrap().is_null());
        assert!(document.get("support_runtime_sha256").unwrap().is_null());
        assert!(document.get("tier2_bridge").unwrap().is_null());
    }

    #[test]
    fn bridge_plan_requires_support_module_and_runtime_digests_together() {
        let fixture = Fixture::new();
        for field in ["support_sha256", "support_runtime_sha256"] {
            let mut plan: serde_json::Value = serde_json::from_str(&bridge_plan()).unwrap();
            plan[field] = serde_json::Value::Null;
            plan["tier2_bridge"] = serde_json::Value::Null;
            fs::write(&fixture.plan, serde_json::to_vec(&plan).unwrap()).unwrap();
            assert!(
                fixture
                    .validate(TargetArch::Wasm32)
                    .unwrap_err()
                    .contains("must both be present or null"),
                "{field}"
            );
        }
    }
}

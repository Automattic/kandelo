use crate::abi_staging::canonical_json::{
    canonical_json_bytes, canonical_sha256, validate_absolute_posix_path, validate_repo_path,
    validate_sha256, validate_stable_id,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

const PRODUCT_SCHEMA: u64 = 1;
const PRODUCT_CATALOG_KIND: &str = "kandelo-vfs-product-catalog";
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;
const MAX_PRODUCTS: usize = 256;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VfsArchitectureV1 {
    Wasm32,
    Wasm64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MaterializationV1 {
    Embedded,
    Lazy,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SoftwareRoleV1 {
    Runtime,
    Build,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VfsProductManifestV1 {
    pub schema: u64,
    pub id: String,
    pub architecture: VfsArchitectureV1,
    pub output: String,
    pub builder: String,
    #[serde(default)]
    pub composition: ProductCompositionV1,
    #[serde(default)]
    pub software: ProductSoftwareV1,
    #[serde(default)]
    pub mounts: Vec<VfsMountIntentV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boot: Option<VfsBootContractV1>,
    #[serde(default)]
    pub evidence: VfsEvidenceV1,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProductCompositionV1 {
    #[serde(default)]
    pub product: Vec<ProductInputV1>,
    #[serde(default)]
    pub repository: Vec<RepositoryInputV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProductInputV1 {
    pub id: String,
    pub materialization: MaterializationV1,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProductSoftwareV1 {
    #[serde(default)]
    pub homebrew: Vec<HomebrewSoftwareV1>,
    #[serde(default)]
    pub package: Vec<PackageSoftwareV1>,
    #[serde(default)]
    pub archive: Vec<ArchiveSoftwareV1>,
    #[serde(default)]
    pub toolchain: Vec<ToolchainSoftwareV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HomebrewSoftwareV1 {
    pub tap: String,
    pub formulae: Vec<String>,
    pub materialization: MaterializationV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PackageSoftwareV1 {
    pub name: String,
    pub outputs: Vec<String>,
    pub source_roles: Vec<String>,
    pub role: SoftwareRoleV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub materialization: Option<MaterializationV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveSoftwareV1 {
    pub id: String,
    pub url: String,
    pub sha256: String,
    pub role: SoftwareRoleV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub materialization: Option<MaterializationV1>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolchainProviderV1 {
    RepositoryDevShell,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ToolchainSoftwareV1 {
    pub id: String,
    pub provider: ToolchainProviderV1,
    pub component: String,
    pub role: SoftwareRoleV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub materialization: Option<MaterializationV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RepositoryInputV1 {
    pub id: String,
    pub paths: Vec<String>,
    pub role: SoftwareRoleV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub materialization: Option<MaterializationV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "source", rename_all = "kebab-case", deny_unknown_fields)]
pub enum VfsMountIntentV1 {
    BuiltImage {
        path: String,
        readonly: bool,
    },
    Scratch {
        path: String,
        mode: String,
        uid: u64,
        gid: u64,
        ephemeral: bool,
    },
}

impl VfsMountIntentV1 {
    fn path(&self) -> &str {
        match self {
            Self::BuiltImage { path, .. } | Self::Scratch { path, .. } => path,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VfsBootContractV1 {
    pub argv: Vec<String>,
    pub cwd: String,
    pub uid: u64,
    pub gid: u64,
    pub env: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VfsEvidenceV1 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<VfsEvidenceReferenceV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<VfsEvidenceReferenceV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VfsEvidenceReferenceV1 {
    pub test: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VfsProductCatalogV1 {
    pub schema: u64,
    pub kind: String,
    pub products: Vec<VfsProductCatalogEntryV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VfsProductCatalogEntryV1 {
    pub path: String,
    pub sha256: String,
    pub manifest: VfsProductManifestV1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CatalogWriteMode {
    Generate,
    Check,
}

pub fn load_product_catalog(
    repository_root: &Path,
    product_dir: &Path,
) -> Result<VfsProductCatalogV1, String> {
    let product_dir = resolve_directory(repository_root, product_dir)?;
    let mut source_files = Vec::new();
    for entry in fs::read_dir(&product_dir)
        .map_err(|error| format!("cannot read product directory {}: {error}", product_dir.display()))?
    {
        let entry = entry.map_err(|error| {
            format!("cannot read entry in product directory {}: {error}", product_dir.display())
        })?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "product manifest filename is not valid UTF-8".to_string())?;
        if name.starts_with('.') || !name.ends_with(".toml") {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| {
            format!("cannot inspect product manifest {}: {error}", entry.path().display())
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(format!(
                "product manifest {} must be a regular nonsymlink file",
                entry.path().display()
            ));
        }
        source_files.push(entry.path());
    }
    source_files.sort();
    if source_files.is_empty() {
        return Err(format!("product directory {} is empty", product_dir.display()));
    }
    if source_files.len() > MAX_PRODUCTS {
        return Err(format!(
            "product directory contains {} manifests; maximum is {MAX_PRODUCTS}",
            source_files.len()
        ));
    }

    let mut products = Vec::with_capacity(source_files.len());
    for source_file in source_files {
        let bytes = read_bounded_regular_file(&source_file, MAX_MANIFEST_BYTES)?;
        let manifest = parse_product_manifest(repository_root, &source_file, &bytes)?;
        products.push(VfsProductCatalogEntryV1 {
            path: repository_relative_path(repository_root, &source_file)?,
            sha256: canonical_sha256(&manifest)?,
            manifest,
        });
    }
    validate_catalog(&products)?;
    products.sort_by(|left, right| left.manifest.id.cmp(&right.manifest.id));
    Ok(VfsProductCatalogV1 {
        schema: PRODUCT_SCHEMA,
        kind: PRODUCT_CATALOG_KIND.to_string(),
        products,
    })
}

pub fn write_or_check_product_catalog(
    mode: CatalogWriteMode,
    repository_root: &Path,
    product_dir: &Path,
    output: &Path,
) -> Result<(), String> {
    let catalog = load_product_catalog(repository_root, product_dir)?;
    let expected = canonical_json_bytes(&catalog)?;
    match mode {
        CatalogWriteMode::Generate => atomic_write_regular(output, &expected),
        CatalogWriteMode::Check => {
            let actual = read_bounded_regular_file(output, 16 * 1024 * 1024)?;
            if actual != expected {
                return Err(format!(
                    "generated product catalog {} is stale; run `xtask abi-staging products generate`",
                    output.display()
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
            write_or_check_product_catalog(
                CatalogWriteMode::Generate,
                &repository_root,
                flags["--source"].as_path(),
                flags["--out"].as_path(),
            )
        }
        "check" => {
            let flags = parse_path_flags(args, &["--source", "--generated"])?;
            write_or_check_product_catalog(
                CatalogWriteMode::Check,
                &repository_root,
                flags["--source"].as_path(),
                flags["--generated"].as_path(),
            )
        }
        _ => Err(format!("unknown products subcommand {action:?}")),
    }
}

fn parse_product_manifest(
    repository_root: &Path,
    source_path: &Path,
    bytes: &[u8],
) -> Result<VfsProductManifestV1, String> {
    if bytes.is_empty() || bytes.len() > MAX_MANIFEST_BYTES {
        return Err(format!(
            "product manifest {} must contain 1 through {MAX_MANIFEST_BYTES} bytes",
            source_path.display()
        ));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|error| format!("product manifest {} is not UTF-8: {error}", source_path.display()))?;
    let manifest: VfsProductManifestV1 = toml::from_str(text)
        .map_err(|error| format!("product manifest {} is invalid: {error}", source_path.display()))?;
    validate_manifest(repository_root, source_path, &manifest)?;
    Ok(manifest)
}

fn validate_manifest(
    repository_root: &Path,
    source_path: &Path,
    manifest: &VfsProductManifestV1,
) -> Result<(), String> {
    let context = || format!("product manifest {}", source_path.display());
    if manifest.schema != PRODUCT_SCHEMA {
        return Err(format!("{} has unsupported schema {}", context(), manifest.schema));
    }
    validate_stable_id(&manifest.id, "product id")?;
    validate_output(&manifest.output)?;
    let builder = validate_repo_path(repository_root, &manifest.builder)
        .map_err(|error| format!("{} builder: {error}", context()))?;
    if !fs::metadata(&builder)
        .map_err(|error| format!("{} builder is unavailable: {error}", context()))?
        .is_file()
    {
        return Err(format!("{} builder must be a regular file", context()));
    }

    enforce_limit("composed products", manifest.composition.product.len(), 64)?;
    enforce_limit("repository inputs", manifest.composition.repository.len(), 128)?;
    enforce_limit("mounts", manifest.mounts.len(), 64)?;
    enforce_limit("Homebrew groups", manifest.software.homebrew.len(), 32)?;
    enforce_limit("package inputs", manifest.software.package.len(), 256)?;
    enforce_limit("archive inputs", manifest.software.archive.len(), 128)?;
    enforce_limit("toolchain inputs", manifest.software.toolchain.len(), 64)?;

    let mut product_ids = BTreeSet::new();
    for product in &manifest.composition.product {
        validate_stable_id(&product.id, "composed product id")?;
        if !product_ids.insert(product.id.as_str()) {
            return Err(format!("{} has duplicate composed product {:?}", context(), product.id));
        }
    }

    let mut repository_ids = BTreeSet::new();
    for input in &manifest.composition.repository {
        validate_stable_id(&input.id, "repository input id")?;
        if !repository_ids.insert(input.id.as_str()) {
            return Err(format!("{} has duplicate repository input {:?}", context(), input.id));
        }
        if input.paths.is_empty() || input.paths.len() > 256 {
            return Err(format!(
                "{} repository input {:?} must name 1 through 256 paths",
                context(), input.id
            ));
        }
        let mut paths = BTreeSet::new();
        for path in &input.paths {
            if !paths.insert(path.as_str()) {
                return Err(format!(
                    "{} repository input {:?} repeats path {path:?}",
                    context(), input.id
                ));
            }
            validate_repo_path(repository_root, path).map_err(|error| {
                format!("{} repository input {:?}: {error}", context(), input.id)
            })?;
        }
        validate_role_materialization(input.role, input.materialization, "repository input")?;
    }

    let mut formulae = BTreeSet::new();
    let mut formula_count = 0usize;
    for group in &manifest.software.homebrew {
        validate_repository_identity(&group.tap, "Homebrew tap")?;
        if group.formulae.is_empty() {
            return Err(format!("{} has an empty Homebrew Formula group", context()));
        }
        formula_count = formula_count
            .checked_add(group.formulae.len())
            .ok_or_else(|| "Homebrew Formula count overflow".to_string())?;
        for formula in &group.formulae {
            validate_stable_id(formula, "Homebrew Formula")?;
            if !formulae.insert((group.tap.as_str(), formula.as_str())) {
                return Err(format!(
                    "{} has duplicate Homebrew Formula {}/{}",
                    context(), group.tap, formula
                ));
            }
        }
    }
    enforce_limit("Homebrew Formula roots", formula_count, 256)?;

    let mut package_names = BTreeSet::new();
    for package in &manifest.software.package {
        validate_stable_id(&package.name, "package name")?;
        if !package_names.insert(package.name.as_str()) {
            return Err(format!("{} has duplicate package input {:?}", context(), package.name));
        }
        if package.outputs.is_empty() && package.source_roles.is_empty() {
            return Err(format!(
                "{} package {:?} must name an output or source role",
                context(), package.name
            ));
        }
        validate_unique_ids(&package.outputs, "package output")?;
        validate_unique_ids(&package.source_roles, "package source role")?;
        let package_manifest = format!("packages/registry/{}/package.toml", package.name);
        validate_repo_path(repository_root, &package_manifest).map_err(|error| {
            format!("{} package {:?}: {error}", context(), package.name)
        })?;
        validate_role_materialization(package.role, package.materialization, "package input")?;
    }

    let mut archive_ids = BTreeSet::new();
    for archive in &manifest.software.archive {
        validate_stable_id(&archive.id, "archive id")?;
        if !archive_ids.insert(archive.id.as_str()) {
            return Err(format!("{} has duplicate archive {:?}", context(), archive.id));
        }
        validate_https_url(&archive.url)?;
        validate_sha256(&archive.sha256)?;
        validate_role_materialization(archive.role, archive.materialization, "archive input")?;
    }

    let mut toolchain_ids = BTreeSet::new();
    for toolchain in &manifest.software.toolchain {
        validate_stable_id(&toolchain.id, "toolchain input id")?;
        validate_stable_id(&toolchain.component, "toolchain component")?;
        if !toolchain_ids.insert(toolchain.id.as_str()) {
            return Err(format!("{} has duplicate toolchain input {:?}", context(), toolchain.id));
        }
        validate_role_materialization(
            toolchain.role,
            toolchain.materialization,
            "toolchain input",
        )?;
    }

    validate_mounts(&manifest.mounts)?;
    if let Some(boot) = &manifest.boot {
        validate_boot(boot)?;
    }
    for evidence in [manifest.evidence.node.as_ref(), manifest.evidence.browser.as_ref()]
        .into_iter()
        .flatten()
    {
        validate_stable_id(&evidence.test, "evidence id")?;
    }
    Ok(())
}

fn validate_catalog(products: &[VfsProductCatalogEntryV1]) -> Result<(), String> {
    let mut ids = BTreeMap::new();
    let mut outputs = BTreeSet::new();
    for product in products {
        if ids
            .insert(product.manifest.id.as_str(), &product.manifest)
            .is_some()
        {
            return Err(format!("duplicate product id {:?}", product.manifest.id));
        }
        if !outputs.insert((product.manifest.architecture, product.manifest.output.as_str())) {
            return Err(format!(
                "duplicate architecture/output pair {:?}/{}",
                product.manifest.architecture, product.manifest.output
            ));
        }
    }

    for product in products {
        for dependency in &product.manifest.composition.product {
            let dependency_manifest = ids.get(dependency.id.as_str()).ok_or_else(|| {
                format!(
                    "product {:?} references unknown product {:?}",
                    product.manifest.id, dependency.id
                )
            })?;
            if dependency_manifest.architecture != product.manifest.architecture {
                return Err(format!(
                    "product {:?} architecture does not match dependency {:?}",
                    product.manifest.id, dependency.id
                ));
            }
        }
    }

    let mut states = BTreeMap::new();
    for id in ids.keys() {
        visit_product(id, &ids, &mut states)?;
    }
    Ok(())
}

fn visit_product<'a>(
    id: &'a str,
    products: &BTreeMap<&'a str, &'a VfsProductManifestV1>,
    states: &mut BTreeMap<&'a str, u8>,
) -> Result<(), String> {
    match states.get(id).copied() {
        Some(1) => return Err(format!("product composition cycle includes {id:?}")),
        Some(2) => return Ok(()),
        _ => {}
    }
    states.insert(id, 1);
    let product = products[id];
    for dependency in &product.composition.product {
        visit_product(dependency.id.as_str(), products, states)?;
    }
    states.insert(id, 2);
    Ok(())
}

fn validate_output(output: &str) -> Result<(), String> {
    if output.is_empty()
        || output.len() > 255
        || output.contains(['/', '\\', '\0'])
        || matches!(output, "." | "..")
        || !(output.ends_with(".vfs") || output.ends_with(".vfs.zst"))
    {
        return Err(format!("product output is not an ABI-neutral VFS filename: {output:?}"));
    }
    Ok(())
}

fn validate_role_materialization(
    role: SoftwareRoleV1,
    materialization: Option<MaterializationV1>,
    field: &str,
) -> Result<(), String> {
    match (role, materialization) {
        (SoftwareRoleV1::Runtime, None) => {
            Err(format!("runtime {field} requires materialization"))
        }
        (SoftwareRoleV1::Build, Some(_)) => {
            Err(format!("build input forbids materialization for {field}"))
        }
        _ => Ok(()),
    }
}

fn validate_mounts(mounts: &[VfsMountIntentV1]) -> Result<(), String> {
    let built_images = mounts
        .iter()
        .filter(|mount| matches!(mount, VfsMountIntentV1::BuiltImage { .. }))
        .collect::<Vec<_>>();
    if built_images.len() != 1 || built_images[0].path() != "/" {
        return Err("product must contain exactly one '/' built-image mount".to_string());
    }

    let mut scratch_paths = Vec::new();
    let mut all_paths = BTreeSet::new();
    for mount in mounts {
        validate_absolute_posix_path(mount.path())?;
        if !all_paths.insert(mount.path()) {
            return Err(format!("duplicate mount path {:?}", mount.path()));
        }
        if let VfsMountIntentV1::Scratch { path, mode, .. } = mount {
            if !valid_octal_mode(mode) {
                return Err(format!("scratch mount {path:?} has invalid mode {mode:?}"));
            }
            scratch_paths.push(path.as_str());
        }
    }
    scratch_paths.sort();
    for (index, left) in scratch_paths.iter().enumerate() {
        for right in &scratch_paths[index + 1..] {
            if is_path_ancestor(left, right) || is_path_ancestor(right, left) {
                return Err(format!("scratch mount paths overlap: {left:?} and {right:?}"));
            }
        }
    }
    Ok(())
}

fn validate_boot(boot: &VfsBootContractV1) -> Result<(), String> {
    if boot.argv.is_empty() || boot.argv.len() > 64 {
        return Err("boot argv must contain 1 through 64 values".to_string());
    }
    for value in &boot.argv {
        validate_bounded_string(value, 4_096, "boot argv value")?;
    }
    validate_absolute_posix_path(&boot.cwd)?;
    if boot.env.len() > 128 {
        return Err("boot environment exceeds 128 entries".to_string());
    }
    for (key, value) in &boot.env {
        if !valid_environment_key(key) {
            return Err(format!("invalid boot environment key {key:?}"));
        }
        validate_bounded_string(value, 8_192, "boot environment value")?;
    }
    Ok(())
}

fn validate_unique_ids(values: &[String], field: &str) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    for value in values {
        validate_stable_id(value, field)?;
        if !seen.insert(value.as_str()) {
            return Err(format!("duplicate {field} {value:?}"));
        }
    }
    Ok(())
}

fn validate_repository_identity(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 256
        || value.chars().any(|character| character.is_whitespace() || character.is_control())
        || value.contains(['\\', '@', ':'])
    {
        return Err(format!("invalid {field} identity {value:?}"));
    }
    let parts = value.split('/').collect::<Vec<_>>();
    if parts.len() != 2 || parts.iter().any(|part| part.is_empty()) {
        return Err(format!("{field} identity must be owner/repository"));
    }
    Ok(())
}

fn validate_https_url(value: &str) -> Result<(), String> {
    if value.len() > 8_192
        || !value.starts_with("https://")
        || value.contains('#')
        || value.chars().any(char::is_whitespace)
    {
        return Err(format!("archive URL must be bounded credential-free HTTPS: {value:?}"));
    }
    let remainder = &value["https://".len()..];
    let authority = remainder.split('/').next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') {
        return Err(format!("archive URL must be bounded credential-free HTTPS: {value:?}"));
    }
    Ok(())
}

fn validate_bounded_string(value: &str, maximum: usize, field: &str) -> Result<(), String> {
    if value.len() > maximum || value.contains('\0') {
        return Err(format!("{field} exceeds its {maximum}-byte bound or contains NUL"));
    }
    Ok(())
}

fn valid_octal_mode(value: &str) -> bool {
    matches!(value.len(), 3 | 4) && value.bytes().all(|byte| (b'0'..=b'7').contains(&byte))
}

fn valid_environment_key(value: &str) -> bool {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn is_path_ancestor(parent: &str, child: &str) -> bool {
    child
        .strip_prefix(parent)
        .is_some_and(|suffix| suffix.starts_with('/'))
}

fn enforce_limit(field: &str, actual: usize, maximum: usize) -> Result<(), String> {
    if actual > maximum {
        return Err(format!("{field} has {actual} entries; maximum is {maximum}"));
    }
    Ok(())
}

fn resolve_directory(repository_root: &Path, directory: &Path) -> Result<PathBuf, String> {
    let directory = if directory.is_absolute() {
        directory.to_path_buf()
    } else {
        repository_root.join(directory)
    };
    let metadata = fs::symlink_metadata(&directory)
        .map_err(|error| format!("cannot inspect directory {}: {error}", directory.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{} must be a nonsymlink directory", directory.display()));
    }
    if !directory.starts_with(repository_root) {
        return Err(format!(
            "product directory {} is outside repository root {}",
            directory.display(),
            repository_root.display()
        ));
    }
    Ok(directory)
}

fn repository_relative_path(repository_root: &Path, path: &Path) -> Result<String, String> {
    let relative = path.strip_prefix(repository_root).map_err(|_| {
        format!("path {} is outside repository root {}", path.display(), repository_root.display())
    })?;
    let mut parts = Vec::new();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(format!("path {} is not normalized", path.display()));
        };
        parts.push(
            component
                .to_str()
                .ok_or_else(|| format!("path {} is not valid UTF-8", path.display()))?,
        );
    }
    Ok(parts.join("/"))
}

pub(crate) fn read_bounded_regular_file(path: &Path, maximum: usize) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("cannot inspect {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{} must be a regular nonsymlink file", path.display()));
    }
    let length = usize::try_from(metadata.len())
        .map_err(|_| format!("{} size does not fit this host", path.display()))?;
    if length > maximum {
        return Err(format!("{} exceeds the {maximum}-byte limit", path.display()));
    }
    fs::read(path).map_err(|error| format!("cannot read {}: {error}", path.display()))
}

pub(crate) fn atomic_write_regular(output: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = output
        .parent()
        .ok_or_else(|| format!("output {} has no parent directory", output.display()))?;
    let parent_metadata = fs::symlink_metadata(parent)
        .map_err(|error| format!("cannot inspect output parent {}: {error}", parent.display()))?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err(format!("output parent {} must be a nonsymlink directory", parent.display()));
    }
    if let Ok(metadata) = fs::symlink_metadata(output) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(format!("output {} must be a regular nonsymlink file", output.display()));
        }
    }

    let filename = output
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("output {} has an invalid filename", output.display()))?;
    let temporary = parent.join(format!(".{filename}.tmp-{}", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| format!("cannot create temporary {}: {error}", temporary.display()))?;
        file.write_all(bytes)
            .map_err(|error| format!("cannot write temporary {}: {error}", temporary.display()))?;
        file.sync_all()
            .map_err(|error| format!("cannot sync temporary {}: {error}", temporary.display()))?;
        fs::rename(&temporary, output).map_err(|error| {
            format!(
                "cannot atomically replace {} from {}: {error}",
                output.display(),
                temporary.display()
            )
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn parse_path_flags(args: &[String], expected: &[&str]) -> Result<BTreeMap<String, PathBuf>, String> {
    if args.len() != expected.len() * 2 {
        return Err(format!("expected flags: {}", expected.join(" ")));
    }
    let mut values = BTreeMap::new();
    for pair in args.chunks_exact(2) {
        if !expected.contains(&pair[0].as_str()) {
            return Err(format!("unknown or unexpected flag {:?}", pair[0]));
        }
        if values.insert(pair[0].clone(), PathBuf::from(&pair[1])).is_some() {
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
        load_product_catalog, parse_product_manifest, write_or_check_product_catalog,
        CatalogWriteMode,
    };
    use crate::abi_staging::canonical_json::canonical_json_bytes;
    use std::fs;
    use std::path::{Path, PathBuf};

    const PRODUCT_FIXTURE: &str =
        include_str!("../../tests/fixtures/abi-staging/canonical/product.toml");
    const PRODUCT_JSON_FIXTURE: &[u8] =
        include_bytes!("../../tests/fixtures/abi-staging/canonical/product.json");

    fn fixture_path(relative: &str) -> PathBuf {
        crate::repo_root().join(relative)
    }

    fn create_test_repository() -> tempfile::TempDir {
        let repository = tempfile::tempdir().unwrap();
        fs::create_dir_all(repository.path().join("products")).unwrap();
        fs::create_dir_all(repository.path().join("packages/registry/dash")).unwrap();
        fs::write(repository.path().join("builder.sh"), b"#!/bin/sh\n").unwrap();
        fs::write(
            repository.path().join("packages/registry/dash/package.toml"),
            b"kind = \"program\"\n",
        )
        .unwrap();
        repository
    }

    fn minimal_manifest(id: &str, architecture: &str, output: &str, additions: &str) -> String {
        format!(
            r#"schema = 1
id = "{id}"
architecture = "{architecture}"
output = "{output}"
builder = "builder.sh"

[[mounts]]
path = "/"
source = "built-image"
readonly = false

{additions}
"#
        )
    }

    fn write_product(repository: &Path, filename: &str, contents: &str) {
        fs::write(repository.join("products").join(filename), contents).unwrap();
    }

    #[test]
    fn canonical_product_fixture_round_trips_to_exact_json() {
        let manifest = parse_product_manifest(
            &crate::repo_root(),
            &fixture_path("tools/xtask/tests/fixtures/abi-staging/canonical/product.toml"),
            PRODUCT_FIXTURE.as_bytes(),
        )
        .unwrap();

        assert_eq!(canonical_json_bytes(&manifest).unwrap(), PRODUCT_JSON_FIXTURE);
    }

    #[test]
    fn prohibited_product_authority_fields_fail_closed() {
        for forbidden in [
            "abi = 9",
            "pages = true",
            "candidate_url = \"https://example.invalid/candidate\"",
            "command = \"build\"",
            "retry = 3",
            "timeout = 60",
            "unknown = true",
        ] {
            let repository = create_test_repository();
            let text = minimal_manifest("product", "wasm32", "product.vfs", forbidden);
            let error = parse_product_manifest(
                repository.path(),
                &repository.path().join("products/product.toml"),
                text.as_bytes(),
            )
            .unwrap_err();

            assert!(error.contains("unknown field"), "{forbidden}: {error}");
        }
    }

    #[test]
    fn manifest_rejects_duplicate_formulae_and_invalid_role_materialization() {
        let repository = create_test_repository();
        let duplicate_formula = minimal_manifest(
            "product",
            "wasm32",
            "product.vfs",
            r#"[[software.homebrew]]
tap = "kandelo-dev/homebrew-tap-core"
formulae = ["bash", "bash"]
materialization = "embedded"
"#,
        );
        let error = parse_product_manifest(
            repository.path(),
            &repository.path().join("products/product.toml"),
            duplicate_formula.as_bytes(),
        )
        .unwrap_err();
        assert!(error.contains("duplicate Homebrew Formula"), "{error}");

        let invalid_role = minimal_manifest(
            "product",
            "wasm32",
            "product.vfs",
            r#"[[software.package]]
name = "dash"
outputs = ["dash"]
source_roles = []
role = "build"
materialization = "embedded"
"#,
        );
        let error = parse_product_manifest(
            repository.path(),
            &repository.path().join("products/product.toml"),
            invalid_role.as_bytes(),
        )
        .unwrap_err();
        assert!(error.contains("build input forbids materialization"), "{error}");
    }

    #[test]
    fn manifest_rejects_unsafe_or_incomplete_filesystem_intent() {
        let repository = create_test_repository();
        let missing_builder = r#"schema = 1
id = "product"
architecture = "wasm32"
output = "product.vfs"

[[mounts]]
path = "/"
source = "built-image"
readonly = false
"#;
        let error = parse_product_manifest(
            repository.path(),
            &repository.path().join("products/product.toml"),
            missing_builder.as_bytes(),
        )
        .unwrap_err();
        assert!(error.contains("missing field `builder`"), "{error}");

        let missing_root = r#"schema = 1
id = "product"
architecture = "wasm32"
output = "product.vfs"
builder = "builder.sh"
"#;
        let error = parse_product_manifest(
            repository.path(),
            &repository.path().join("products/product.toml"),
            missing_root.as_bytes(),
        )
        .unwrap_err();
        assert!(error.contains("built-image mount"), "{error}");

        let unsafe_builder = minimal_manifest("product", "wasm32", "product.vfs", "")
            .replace("builder = \"builder.sh\"", "builder = \"../builder.sh\"");
        let error = parse_product_manifest(
            repository.path(),
            &repository.path().join("products/product.toml"),
            unsafe_builder.as_bytes(),
        )
        .unwrap_err();
        assert!(error.contains("builder"), "{error}");
    }

    #[test]
    fn toolchain_inputs_reject_commands_and_unknown_providers() {
        for invalid in [
            r#"[[software.toolchain]]
id = "clang-headers"
provider = "repository-dev-shell"
component = "clang-resource-headers"
role = "build"
command = "clang --version"
"#,
            r#"[[software.toolchain]]
id = "clang-headers"
provider = "ambient-path"
component = "clang-resource-headers"
role = "build"
"#,
        ] {
            let repository = create_test_repository();
            let text = minimal_manifest("product", "wasm32", "product.vfs", invalid);
            assert!(
                parse_product_manifest(
                    repository.path(),
                    &repository.path().join("products/product.toml"),
                    text.as_bytes(),
                )
                .is_err(),
                "accepted {invalid}"
            );
        }
    }

    #[test]
    fn catalog_rejects_duplicate_ids_outputs_cycles_and_cross_architecture_edges() {
        let duplicate_id = create_test_repository();
        write_product(
            duplicate_id.path(),
            "a.toml",
            &minimal_manifest("same", "wasm32", "a.vfs", ""),
        );
        write_product(
            duplicate_id.path(),
            "b.toml",
            &minimal_manifest("same", "wasm32", "b.vfs", ""),
        );
        assert!(load_product_catalog(duplicate_id.path(), &duplicate_id.path().join("products"))
            .unwrap_err()
            .contains("duplicate product id"));

        let duplicate_output = create_test_repository();
        write_product(
            duplicate_output.path(),
            "a.toml",
            &minimal_manifest("a", "wasm32", "same.vfs", ""),
        );
        write_product(
            duplicate_output.path(),
            "b.toml",
            &minimal_manifest("b", "wasm32", "same.vfs", ""),
        );
        assert!(load_product_catalog(
            duplicate_output.path(),
            &duplicate_output.path().join("products")
        )
        .unwrap_err()
        .contains("duplicate architecture/output"));

        let cycle = create_test_repository();
        write_product(
            cycle.path(),
            "a.toml",
            &minimal_manifest(
                "a",
                "wasm32",
                "a.vfs",
                r#"[[composition.product]]
id = "b"
materialization = "embedded"
"#,
            ),
        );
        write_product(
            cycle.path(),
            "b.toml",
            &minimal_manifest(
                "b",
                "wasm32",
                "b.vfs",
                r#"[[composition.product]]
id = "a"
materialization = "embedded"
"#,
            ),
        );
        assert!(load_product_catalog(cycle.path(), &cycle.path().join("products"))
            .unwrap_err()
            .contains("cycle"));

        let cross_arch = create_test_repository();
        write_product(
            cross_arch.path(),
            "base.toml",
            &minimal_manifest("base", "wasm64", "base.vfs", ""),
        );
        write_product(
            cross_arch.path(),
            "child.toml",
            &minimal_manifest(
                "child",
                "wasm32",
                "child.vfs",
                r#"[[composition.product]]
id = "base"
materialization = "embedded"
"#,
            ),
        );
        assert!(load_product_catalog(cross_arch.path(), &cross_arch.path().join("products"))
            .unwrap_err()
            .contains("architecture"));
    }

    #[test]
    fn catalog_generation_is_atomic_and_check_detects_drift() {
        let repository = create_test_repository();
        let manifest = minimal_manifest("product", "wasm32", "product.vfs", "");
        write_product(
            repository.path(),
            "product.toml",
            &manifest,
        );
        let output = repository.path().join("catalog.json");

        write_or_check_product_catalog(
            CatalogWriteMode::Generate,
            repository.path(),
            &repository.path().join("products"),
            &output,
        )
        .unwrap();
        assert!(write_or_check_product_catalog(
            CatalogWriteMode::Check,
            repository.path(),
            &repository.path().join("products"),
            &output,
        )
        .is_ok());

        let complete = fs::read(&output).unwrap();
        fs::write(repository.path().join("products/product.toml"), b"not toml").unwrap();
        assert!(write_or_check_product_catalog(
            CatalogWriteMode::Generate,
            repository.path(),
            &repository.path().join("products"),
            &output,
        )
        .is_err());
        assert_eq!(fs::read(&output).unwrap(), complete);

        write_product(repository.path(), "product.toml", &manifest);
        fs::write(&output, b"{}\n").unwrap();
        assert!(write_or_check_product_catalog(
            CatalogWriteMode::Check,
            repository.path(),
            &repository.path().join("products"),
            &output,
        )
        .unwrap_err()
        .contains("generate"));
    }

    #[cfg(unix)]
    #[test]
    fn generation_refuses_a_symlink_output() {
        use std::os::unix::fs::symlink;

        let repository = create_test_repository();
        write_product(
            repository.path(),
            "product.toml",
            &minimal_manifest("product", "wasm32", "product.vfs", ""),
        );
        fs::write(repository.path().join("target.json"), b"keep\n").unwrap();
        symlink("target.json", repository.path().join("catalog.json")).unwrap();

        assert!(write_or_check_product_catalog(
            CatalogWriteMode::Generate,
            repository.path(),
            &repository.path().join("products"),
            &repository.path().join("catalog.json"),
        )
        .is_err());
        assert_eq!(fs::read(repository.path().join("target.json")).unwrap(), b"keep\n");
    }
}

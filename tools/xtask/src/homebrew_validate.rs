use jsonschema::JSONSchema;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::repo_root;

const DEFAULT_METADATA_REL: &str = "Kandelo/metadata.json";
const SCHEMA_ROOT_REL: &str = "homebrew/homebrew-tap-core/Kandelo";

fn repository_bottle_root(repository: &str) -> String {
    format!("https://ghcr.io/v2/{}", repository.to_ascii_lowercase())
}

fn repository_bottle_url(repository: &str, package: &str, sha256: &str) -> String {
    format!(
        "{}/{package}/blobs/sha256:{sha256}",
        repository_bottle_root(repository)
    )
}

pub fn run(args: Vec<String>) -> Result<(), String> {
    let options = Options::parse(args)?;
    let report = validate(&options)?;
    if report.errors.is_empty() {
        println!(
            "homebrew-validate: ok (packages={}, bottles={}, link_manifests={}, provenance_reports={})",
            report.packages, report.bottles, report.link_manifests, report.provenance_reports
        );
        Ok(())
    } else {
        Err(format!(
            "homebrew metadata validation failed with {} error(s):\n{}",
            report.errors.len(),
            report.errors.join("\n")
        ))
    }
}

#[derive(Debug, Clone)]
struct Options {
    tap_root: PathBuf,
    metadata_path: PathBuf,
    prefix_campaign_layout_sha256: Option<String>,
}

impl Options {
    fn parse(args: Vec<String>) -> Result<Self, String> {
        let mut tap_root: Option<PathBuf> = None;
        let mut metadata: Option<PathBuf> = None;
        let mut prefix_campaign_layout_sha256: Option<String> = None;
        let mut it = args.into_iter();
        while let Some(arg) = it.next() {
            match arg.as_str() {
                "--tap-root" => {
                    let value = it.next().ok_or_else(|| {
                        "homebrew-validate: --tap-root requires a path".to_string()
                    })?;
                    tap_root = Some(PathBuf::from(value));
                }
                "--metadata" => {
                    let value = it.next().ok_or_else(|| {
                        "homebrew-validate: --metadata requires a path".to_string()
                    })?;
                    metadata = Some(PathBuf::from(value));
                }
                "--prefix-campaign-layout-sha256" => {
                    prefix_campaign_layout_sha256 = Some(it.next().ok_or_else(|| {
                        "homebrew-validate: --prefix-campaign-layout-sha256 requires a digest"
                            .to_string()
                    })?);
                }
                "-h" | "--help" => return Err(usage()),
                other => {
                    return Err(format!(
                        "homebrew-validate: unexpected argument {other:?}\n{}",
                        usage()
                    ));
                }
            }
        }

        let tap_root = tap_root.ok_or_else(usage)?;
        let metadata_path = match metadata {
            Some(path) if path.is_absolute() => path,
            Some(path) => tap_root.join(path),
            None => tap_root.join(DEFAULT_METADATA_REL),
        };

        Ok(Self {
            tap_root,
            metadata_path,
            prefix_campaign_layout_sha256,
        })
    }
}

fn usage() -> String {
    "usage: xtask homebrew-validate --tap-root <tap-root> [--metadata <path>] [--prefix-campaign-layout-sha256 <sha256>]".to_string()
}

#[derive(Default, Debug)]
struct ValidationReport {
    errors: Vec<String>,
    packages: usize,
    bottles: usize,
    link_manifests: usize,
    provenance_reports: usize,
}

struct Schemas {
    metadata: JSONSchema,
    formula: JSONSchema,
    link_manifest: JSONSchema,
    provenance: JSONSchema,
}

impl Schemas {
    fn load() -> Result<Self, String> {
        Ok(Self {
            metadata: compile_schema("metadata")?,
            formula: compile_schema("formula")?,
            link_manifest: compile_schema("link-manifest")?,
            provenance: compile_schema("provenance")?,
        })
    }
}

fn compile_schema(name: &str) -> Result<JSONSchema, String> {
    let path = repo_root()
        .join(SCHEMA_ROOT_REL)
        .join(format!("{name}.schema.json"));
    let schema = load_json(&path)?;
    JSONSchema::compile(&schema).map_err(|e| format!("compile {}: {e}", path.display()))
}

fn validate(options: &Options) -> Result<ValidationReport, String> {
    let schemas = Schemas::load()?;
    let guest_layout =
        crate::homebrew_guest_layout::get(options.prefix_campaign_layout_sha256.as_deref())?;
    let mut validator = Validator {
        options,
        schemas,
        guest_layout,
        report: ValidationReport::default(),
    };
    validator.validate_metadata()?;
    Ok(validator.report)
}

struct Validator<'a> {
    options: &'a Options,
    schemas: Schemas,
    guest_layout: crate::homebrew_guest_layout::GuestLayout,
    report: ValidationReport,
}

impl Validator<'_> {
    fn validate_metadata(&mut self) -> Result<(), String> {
        let metadata = load_json(&self.options.metadata_path)?;
        let schema_errors = collect_schema_errors(&self.schemas.metadata, &metadata);
        self.add_schema_errors("metadata", schema_errors);

        self.validate_tap_identity(&metadata);

        let release_abi = parse_release_abi(string_at(&metadata, "/release_tag"));
        let top_abi = u64_at(&metadata, "/kandelo_abi");
        match (release_abi, top_abi) {
            (Some(release), Some(top)) if release != top => self.err(format!(
                "metadata: release_tag ABI {release} does not match kandelo_abi {top}"
            )),
            (None, _) => self.err("metadata: release_tag must be bottles-abi-v<N>".to_string()),
            _ => {}
        }

        let packages = match metadata.get("packages").and_then(Value::as_array) {
            Some(packages) => packages,
            None => {
                self.err("metadata: packages must be an array".to_string());
                return Ok(());
            }
        };
        self.report.packages = packages.len();

        let package_index = self.package_index(packages);
        let metadata_tap_name = string_at(&metadata, "/tap_name").unwrap_or("");
        for package in packages {
            self.validate_dependency_closure(package, &package_index, metadata_tap_name);
            self.validate_package(package, &metadata);
        }
        self.validate_live_sidecar_closure(&metadata);

        Ok(())
    }

    fn validate_live_sidecar_closure(&mut self, metadata: &Value) {
        let mut formula_sidecars = BTreeMap::new();
        let mut link_manifests = BTreeMap::new();
        let mut provenance_reports = BTreeMap::new();
        let mut optional_provenance_reports = BTreeSet::new();

        if let Some(packages) = metadata.get("packages").and_then(Value::as_array) {
            for (package_index, package) in packages.iter().enumerate() {
                let package_name = string_at(package, "/name").unwrap_or("<unknown>");
                let package_owner = format!("metadata package #{package_index} {package_name:?}");
                if let Some(path) = string_at(package, "/formula_metadata") {
                    let expected = format!("Kandelo/formula/{package_name}.json");
                    self.record_live_sidecar(
                        "formula sidecar",
                        path,
                        &expected,
                        &package_owner,
                        &mut formula_sidecars,
                    );
                }

                let Some(bottles) = package.get("bottles").and_then(Value::as_array) else {
                    continue;
                };
                for (bottle_index, bottle) in bottles.iter().enumerate() {
                    let arch = string_at(bottle, "/arch").unwrap_or("<unknown>");
                    let bottle_owner = format!("{package_owner} bottle #{bottle_index} {arch:?}");
                    let link_path = if string_at(bottle, "/status") == Some("success") {
                        string_at(bottle, "/link_manifest")
                    } else {
                        string_at(bottle, "/fallback_link_manifest")
                    };
                    if let Some(path) = link_path {
                        let expected = if string_at(bottle, "/status") == Some("success") {
                            match (
                                string_at(package, "/version"),
                                u64_at(package, "/bottle_rebuild"),
                            ) {
                                (Some(version), Some(rebuild)) => format!(
                                    "Kandelo/link/{package_name}-{version}-rebuild{rebuild}-{arch}.json"
                                ),
                                _ => path.to_string(),
                            }
                        } else {
                            // A failed attempt can select the prior last-green
                            // link, whose version or rebuild need not equal the
                            // attempted Formula identity.
                            path.to_string()
                        };
                        self.record_live_sidecar(
                            "link manifest",
                            path,
                            &expected,
                            &bottle_owner,
                            &mut link_manifests,
                        );
                    }

                    if string_at(bottle, "/status") == Some("success") {
                        if let Some(path) = provenance_report_path(package, bottle) {
                            self.record_live_sidecar(
                                "provenance report",
                                &path,
                                &path,
                                &bottle_owner,
                                &mut provenance_reports,
                            );
                        }
                    } else if let Some(path) =
                        link_path.and_then(fallback_provenance_report_path)
                    {
                        self.record_live_sidecar(
                            "fallback provenance report",
                            &path,
                            &path,
                            &bottle_owner,
                            &mut provenance_reports,
                        );
                        optional_provenance_reports.insert(path);
                    }
                }
            }
        }

        // WHY: these three directories are the live ABI catalog. Files that
        // are not selected by metadata can otherwise retain stale bottle or
        // guest-layout claims after a package rebuild. Attempt and rollback
        // reports have explicit nested namespaces and remain append-only
        // historical evidence rather than live bottle claims.
        self.compare_live_sidecar_directory(
            "formula sidecar",
            "Kandelo/formula",
            ".json",
            &[],
            &BTreeSet::new(),
            &formula_sidecars,
        );
        self.compare_live_sidecar_directory(
            "link manifest",
            "Kandelo/link",
            ".json",
            &[],
            &BTreeSet::new(),
            &link_manifests,
        );
        self.compare_live_sidecar_directory(
            "provenance report",
            "Kandelo/reports",
            ".provenance.json",
            &["failures", "rollbacks"],
            &optional_provenance_reports,
            &provenance_reports,
        );
    }

    fn record_live_sidecar(
        &mut self,
        kind: &str,
        path: &str,
        expected_path: &str,
        owner: &str,
        selected: &mut BTreeMap<String, String>,
    ) {
        if path != expected_path {
            self.err(format!(
                "{owner}: {kind} path {path:?} is not its canonical identity {expected_path:?}"
            ));
        }
        if let Some(previous_owner) = selected.insert(path.to_string(), owner.to_string()) {
            self.err(format!(
                "{kind} {path:?} is selected more than once by {previous_owner} and {owner}"
            ));
        }
    }

    fn compare_live_sidecar_directory(
        &mut self,
        kind: &str,
        directory_rel: &str,
        suffix: &str,
        allowed_historical_directories: &[&str],
        optional_selected: &BTreeSet<String>,
        selected: &BTreeMap<String, String>,
    ) {
        let directory = self.options.tap_root.join(directory_rel);
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => {
                self.err(format!(
                    "live {kind} directory {} must be a real directory",
                    directory.display()
                ));
                return;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                for (path, owner) in selected {
                    if !optional_selected.contains(path) {
                        self.err(format!(
                            "{owner}: selected {kind} {path:?} is missing from the tap"
                        ));
                    }
                }
                return;
            }
            Err(error) => {
                self.err(format!(
                    "cannot inspect live {kind} directory {}: {error}",
                    directory.display()
                ));
                return;
            }
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                self.err(format!(
                    "cannot enumerate live {kind} directory {}: {error}",
                    directory.display()
                ));
                return;
            }
        };

        let mut present = BTreeSet::new();
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    self.err(format!(
                        "cannot enumerate an entry in live {kind} directory {}: {error}",
                        directory.display()
                    ));
                    continue;
                }
            };
            let Some(file_name) = entry.file_name().to_str().map(str::to_string) else {
                self.err(format!(
                    "live {kind} directory {} contains a non-UTF-8 name",
                    directory.display()
                ));
                continue;
            };
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) => {
                    self.err(format!(
                        "cannot inspect live {kind} entry {directory_rel}/{file_name}: {error}"
                    ));
                    continue;
                }
            };
            if allowed_historical_directories.contains(&file_name.as_str()) {
                if !file_type.is_dir() {
                    self.err(format!(
                        "historical {kind} namespace {directory_rel}/{file_name} must be a real directory"
                    ));
                }
                continue;
            }
            if !file_name.ends_with(suffix) {
                self.err(format!(
                    "live {kind} directory {directory_rel:?} contains unexpected entry {file_name:?}"
                ));
                continue;
            }
            let rel = format!("{directory_rel}/{file_name}");
            present.insert(rel.clone());

            match file_type {
                file_type if file_type.is_file() => {}
                _ => self.err(format!(
                    "live {kind} {rel:?} must be a regular non-symlink file"
                )),
            }
            if !selected.contains_key(&rel) {
                self.err(format!(
                    "live {kind} {rel:?} is not selected by {DEFAULT_METADATA_REL}"
                ));
            }
        }

        for (path, owner) in selected {
            if !present.contains(path) && !optional_selected.contains(path) {
                self.err(format!(
                    "{owner}: selected {kind} {path:?} is missing from the tap"
                ));
            }
        }
    }

    fn validate_tap_identity(&mut self, metadata: &Value) {
        let (Some(repository), Some(tap_name)) = (
            string_at(metadata, "/tap_repository"),
            string_at(metadata, "/tap_name"),
        ) else {
            return;
        };
        let normalized_repository = repository.to_ascii_lowercase();
        let Some((owner, repository_name)) = normalized_repository.split_once('/') else {
            return;
        };
        let Some(name) = repository_name.strip_prefix("homebrew-") else {
            self.err(format!(
                "metadata: tap repository {repository:?} must use the conventional owner/homebrew-name form"
            ));
            return;
        };
        if name.is_empty() || name.contains('/') {
            self.err(format!(
                "metadata: tap repository {repository:?} must use the conventional owner/homebrew-name form"
            ));
            return;
        }
        let expected_tap_name = format!("{owner}/{name}");
        if tap_name != expected_tap_name {
            self.err(format!(
                "metadata: tap name {tap_name:?} does not match repository {repository:?}; expected {expected_tap_name:?}"
            ));
        }
    }

    fn package_index<'a>(&mut self, packages: &'a [Value]) -> BTreeMap<String, &'a Value> {
        let mut index = BTreeMap::new();
        for package in packages {
            if let Some(name) = string_at(package, "/name") {
                if index.insert(name.to_string(), package).is_some() {
                    self.err(format!("metadata: duplicate package entry {name:?}"));
                }
            }
        }
        index
    }

    fn validate_dependency_closure(
        &mut self,
        package: &Value,
        package_index: &BTreeMap<String, &Value>,
        metadata_tap_name: &str,
    ) {
        let package_name = string_at(package, "/name").unwrap_or("<unknown>");
        let dependencies = match package.get("dependencies").and_then(Value::as_array) {
            Some(dependencies) => dependencies,
            None => return,
        };

        for dependency in dependencies {
            let Some(dep_name) = string_at(dependency, "/name") else {
                continue;
            };
            let declared_full_name = dependency
                .get("full_name")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("{metadata_tap_name}/{dep_name}"));
            let expected_suffix = format!("/{dep_name}");
            if !declared_full_name.ends_with(&expected_suffix) {
                self.err(format!(
                    "metadata package {package_name}: dependency full_name {declared_full_name:?} does not identify name {dep_name:?}"
                ));
                continue;
            }
            let dependency_tap = declared_full_name
                .strip_suffix(&expected_suffix)
                .unwrap_or_default();
            if dependency_tap != metadata_tap_name {
                // An external dependency is closed only when the consumer
                // supplies its separately validated immutable tap metadata.
                continue;
            }
            let Some(dep_package) = package_index.get(dep_name) else {
                self.err(format!(
                    "metadata package {package_name}: dependency {dep_name:?} is not present in metadata packages"
                ));
                continue;
            };

            if let Some(expected_version) = string_at(dependency, "/version") {
                let actual_version = string_at(dep_package, "/version").unwrap_or("");
                if expected_version != actual_version {
                    self.err(format!(
                        "metadata package {package_name}: dependency {dep_name:?} requires version {expected_version:?}, metadata has {actual_version:?}"
                    ));
                }
            }
        }
    }

    fn validate_package(&mut self, package: &Value, metadata: &Value) {
        let package_name = string_at(package, "/name").unwrap_or("<unknown>");
        let formula_metadata = match self.load_tap_json(
            &format!("metadata package {package_name}: formula_metadata"),
            string_at(package, "/formula_metadata"),
        ) {
            Some(value) => value,
            None => return,
        };
        let schema_errors = collect_schema_errors(&self.schemas.formula, &formula_metadata);
        self.add_schema_errors(&format!("formula sidecar {package_name}"), schema_errors);

        self.validate_formula_top_level(package_name, &formula_metadata, metadata);
        self.validate_formula_sidecar_matches_package(package_name, package, &formula_metadata);
        self.validate_formula_file(package_name, package, metadata);
        self.validate_bottles(package_name, package, &formula_metadata, metadata);
    }

    fn validate_formula_top_level(
        &mut self,
        package_name: &str,
        formula: &Value,
        metadata: &Value,
    ) {
        for (formula_ptr, metadata_ptr) in [
            ("/tap_repository", "/tap_repository"),
            ("/tap_name", "/tap_name"),
            ("/tap_commit", "/tap_commit"),
            ("/kandelo_abi", "/kandelo_abi"),
        ] {
            if formula.pointer(formula_ptr) != metadata.pointer(metadata_ptr) {
                self.err(format!(
                    "formula sidecar {package_name}: {formula_ptr} does not match metadata {metadata_ptr}"
                ));
            }
        }

        if string_at(formula, "/source_metadata") != Some(DEFAULT_METADATA_REL) {
            self.err(format!(
                "formula sidecar {package_name}: source_metadata must be {DEFAULT_METADATA_REL:?}"
            ));
        }
    }

    fn validate_formula_sidecar_matches_package(
        &mut self,
        package_name: &str,
        package: &Value,
        formula: &Value,
    ) {
        for ptr in [
            "/name",
            "/full_name",
            "/version",
            "/formula_revision",
            "/bottle_rebuild",
            "/formula_path",
            "/dependencies",
            "/bottles",
        ] {
            if package.pointer(ptr) != formula.pointer(ptr) {
                self.err(format!(
                    "formula sidecar {package_name}: {ptr} does not match metadata package entry"
                ));
            }
        }
    }

    fn validate_formula_file(
        &mut self,
        package_name: &str,
        package: &Value,
        metadata: &Value,
    ) {
        let Some(formula_path_rel) = string_at(package, "/formula_path") else {
            return;
        };
        let Some(formula_path) = self.resolve_tap_path(
            &format!("package {package_name}: formula_path"),
            formula_path_rel,
        ) else {
            return;
        };
        if !formula_path.is_file() {
            self.err(format!(
                "package {package_name}: formula_path {:?} does not exist",
                formula_path_rel
            ));
            return;
        }

        if let Err(error) = validate_formula_structure_with_ripper(&formula_path) {
            self.err(format!(
                "package {package_name}: Formula structure is not canonical static data: {error}"
            ));
            return;
        }

        let source = match fs::read_to_string(&formula_path) {
            Ok(source) => source,
            Err(error) => {
                self.err(format!(
                    "package {package_name}: cannot read formula_path {formula_path_rel:?}: {error}"
                ));
                return;
            }
        };
        let bottle_block = match parse_formula_bottle_block(&source, &self.guest_layout.cellar) {
            Ok(block) => block,
            Err(error) => {
                self.err(format!(
                    "package {package_name}: Formula bottle block is not canonical static data: {error}"
                ));
                return;
            }
        };
        let mut expected_tags = BTreeMap::new();
        if let Some(bottles) = package.get("bottles").and_then(Value::as_array) {
            for (index, bottle) in bottles.iter().enumerate() {
                let Some(tag) = string_at(bottle, "/bottle_tag") else {
                    continue;
                };
                let sha_pointer = if string_at(bottle, "/status") == Some("success") {
                    "/sha256"
                } else {
                    "/fallback_sha256"
                };
                let Some(sha256) = string_at(bottle, sha_pointer) else {
                    continue;
                };
                if expected_tags
                    .insert(tag.to_string(), sha256.to_string())
                    .is_some()
                {
                    self.err(format!(
                        "package {package_name}: metadata bottle #{index} duplicates Formula tag {tag:?}"
                    ));
                }
            }
        }

        match bottle_block {
            None if !expected_tags.is_empty() => self.err(format!(
                "package {package_name}: Formula bottle tags are absent but metadata advertises {expected_tags:?}"
            )),
            Some(block) => {
                let expected_root =
                    string_at(metadata, "/tap_repository").map(repository_bottle_root);
                if expected_root.as_deref() != Some(block.root_url.as_str()) {
                    self.err(format!(
                        "package {package_name}: Formula bottle root_url {:?} does not match the tap repository package root {expected_root:?}",
                        block.root_url
                    ));
                }
                if u64_at(package, "/bottle_rebuild") != Some(block.rebuild) {
                    self.err(format!(
                        "package {package_name}: Formula bottle rebuild {} does not match metadata bottle_rebuild",
                        block.rebuild
                    ));
                }
                if block.tags != expected_tags {
                    self.err(format!(
                        "package {package_name}: Formula bottle tags {:?} do not match metadata bottles {expected_tags:?}",
                        block.tags
                    ));
                }
            }
            None => {}
        }
    }

    fn validate_bottles(
        &mut self,
        package_name: &str,
        package: &Value,
        formula: &Value,
        metadata: &Value,
    ) {
        let Some(bottles) = package.get("bottles").and_then(Value::as_array) else {
            return;
        };
        let top_abi = u64_at(metadata, "/kandelo_abi");
        let tap_repository = string_at(metadata, "/tap_repository");
        let mut seen_arches = BTreeSet::new();
        for (index, bottle) in bottles.iter().enumerate() {
            self.report.bottles += 1;
            let bottle_label = format!("package {package_name} bottle #{index}");
            self.validate_bottle_identity(
                &bottle_label,
                package_name,
                bottle,
                top_abi,
                tap_repository,
            );

            if let Some(arch) = string_at(bottle, "/arch") {
                if !seen_arches.insert(arch.to_string()) {
                    self.err(format!("{bottle_label}: duplicate bottle arch {arch:?}"));
                }
            }

            if string_at(bottle, "/status") == Some("success") {
                self.validate_success_link_manifest(&bottle_label, package, bottle);
                self.validate_success_provenance_report(&bottle_label, package, bottle, metadata);
            } else {
                self.validate_fallback_link_manifest(&bottle_label, package, bottle);
            }
        }

        if package.pointer("/bottles") != formula.pointer("/bottles") {
            self.err(format!(
                "formula sidecar {package_name}: bottles array does not match metadata package"
            ));
        }
    }

    fn validate_bottle_identity(
        &mut self,
        label: &str,
        package_name: &str,
        bottle: &Value,
        top_abi: Option<u64>,
        tap_repository: Option<&str>,
    ) {
        if self.options.prefix_campaign_layout_sha256.is_some() {
            if string_at(bottle, "/prefix") != Some(self.guest_layout.prefix.as_str()) {
                self.err(format!(
                    "{label}: prefix does not match the selected prefix-campaign guest layout"
                ));
            }
            if string_at(bottle, "/cellar") != Some(self.guest_layout.cellar.as_str()) {
                self.err(format!(
                    "{label}: cellar does not match the selected prefix-campaign guest layout"
                ));
            }
        }
        if let (Some(bottle_abi), Some(top_abi)) = (u64_at(bottle, "/kandelo_abi"), top_abi) {
            if bottle_abi != top_abi {
                self.err(format!(
                    "{label}: kandelo_abi {bottle_abi} does not match metadata ABI {top_abi}"
                ));
            }
        }

        match (string_at(bottle, "/arch"), string_at(bottle, "/bottle_tag")) {
            (Some("wasm32"), Some("wasm32_kandelo")) => {}
            (Some("wasm64"), Some("wasm64_kandelo")) => {}
            (Some(arch), Some(tag)) => self.err(format!(
                "{label}: bottle_tag {tag:?} is not valid for arch {arch:?}"
            )),
            _ => {}
        }

        if string_at(bottle, "/browser_compatible") == Some("true") {
            self.err(format!(
                "{label}: browser_compatible should be a boolean, not a string"
            ));
        }
        if bottle.get("browser_compatible").and_then(Value::as_bool) == Some(true) {
            let supports_browser = bottle
                .get("runtime_support")
                .and_then(Value::as_array)
                .map(|values| values.iter().any(|v| v.as_str() == Some("browser")))
                .unwrap_or(false);
            if !supports_browser {
                self.err(format!(
                    "{label}: browser_compatible=true requires runtime_support to include browser"
                ));
            }
        }

        if string_at(bottle, "/status") == Some("success") {
            if let (Some(repository), Some(url), Some(sha256)) = (
                tap_repository,
                string_at(bottle, "/url"),
                string_at(bottle, "/sha256"),
            ) {
                let expected_url = repository_bottle_url(repository, package_name, sha256);
                if url != expected_url {
                    self.err(format!(
                        "{label}: success bottle URL {url:?} does not match tap repository package URL {expected_url:?}"
                    ));
                }
            }
        }

        if let (Some(repository), Some(url), Some(sha256)) = (
            tap_repository,
            string_at(bottle, "/fallback_url"),
            string_at(bottle, "/fallback_sha256"),
        ) {
            let expected_url = repository_bottle_url(repository, package_name, sha256);
            if url != expected_url {
                self.err(format!(
                    "{label}: fallback bottle URL {url:?} does not match tap repository package URL {expected_url:?}"
                ));
            }
        }
    }

    fn validate_success_link_manifest(&mut self, label: &str, package: &Value, bottle: &Value) {
        self.validate_selected_link_manifest(
            label,
            package,
            bottle,
            string_at(bottle, "/link_manifest"),
            true,
            [
                ("/bottle/url", "/url"),
                ("/bottle/sha256", "/sha256"),
                ("/bottle/bytes", "/bytes"),
                ("/bottle/cache_key_sha", "/cache_key_sha"),
            ],
        );
    }

    fn validate_selected_link_manifest(
        &mut self,
        label: &str,
        package: &Value,
        bottle: &Value,
        path: Option<&str>,
        require_current_formula_identity: bool,
        bottle_fields: [(&str, &str); 4],
    ) -> Option<Value> {
        let link = match self.load_tap_json(label, path) {
            Some(value) => value,
            None => return None,
        };
        self.report.link_manifests += 1;
        let schema_errors = collect_schema_errors(&self.schemas.link_manifest, &link);
        self.add_schema_errors(label, schema_errors);

        for (link_ptr, bottle_ptr) in [
            ("/package", "/name"),
            ("/arch", "/arch"),
            ("/kandelo_abi", "/kandelo_abi"),
            ("/prefix", "/prefix"),
            ("/cellar", "/cellar"),
        ] {
            let expected = if bottle_ptr == "/name" || bottle_ptr == "/version" {
                package.pointer(bottle_ptr)
            } else {
                bottle.pointer(bottle_ptr)
            };
            if link.pointer(link_ptr) != expected {
                self.err(format!(
                    "{label}: link manifest {link_ptr} does not match metadata {bottle_ptr}"
                ));
            }
        }
        if require_current_formula_identity
            && link.pointer("/version") != package.pointer("/version")
        {
            self.err(format!(
                "{label}: link manifest /version does not match metadata /version"
            ));
        }
        if let Some(path) = path {
            match parse_link_manifest_rebuild(path, &link) {
                Ok(rebuild)
                    if require_current_formula_identity
                        && Some(rebuild) != u64_at(package, "/bottle_rebuild") =>
                {
                    self.err(format!(
                        "{label}: link manifest path rebuild {rebuild} does not match metadata bottle_rebuild"
                    ));
                }
                Ok(_) => {}
                Err(error) => self.err(format!("{label}: {error}")),
            }
        }

        for (link_ptr, bottle_ptr) in bottle_fields {
            if link.pointer(link_ptr) != bottle.pointer(bottle_ptr) {
                self.err(format!(
                    "{label}: link manifest {link_ptr} does not match metadata {bottle_ptr}"
                ));
            }
        }

        self.validate_guest_paths(label, &link);
        self.validate_links(label, &link);
        self.validate_receipts(label, &link);
        Some(link)
    }

    fn validate_success_provenance_report(
        &mut self,
        label: &str,
        package: &Value,
        bottle: &Value,
        _metadata: &Value,
    ) {
        let Some(path) = provenance_report_path(package, bottle) else {
            return;
        };
        let provenance = match self.load_tap_json(label, Some(&path)) {
            Some(value) => value,
            None => return,
        };
        self.report.provenance_reports += 1;
        let schema_errors = collect_schema_errors(&self.schemas.provenance, &provenance);
        self.add_schema_errors(label, schema_errors);
        self.validate_runtime_evidence(label, bottle, &provenance);

        for (provenance_ptr, package_ptr) in [
            ("/subject/package", "/name"),
            ("/subject/version", "/version"),
            ("/subject/bottle_rebuild", "/bottle_rebuild"),
            ("/formula/path", "/formula_path"),
        ] {
            if provenance.pointer(provenance_ptr) != package.pointer(package_ptr) {
                self.err(format!(
                    "{label}: provenance {provenance_ptr} does not match package {package_ptr}"
                ));
            }
        }
        for (provenance_ptr, bottle_ptr) in [
            ("/subject/arch", "/arch"),
            ("/subject/kandelo_abi", "/kandelo_abi"),
            ("/bottle/url", "/url"),
            ("/bottle/sha256", "/sha256"),
            ("/bottle/bytes", "/bytes"),
            ("/bottle/cache_key_sha", "/cache_key_sha"),
            ("/bottle/bottle_tag", "/bottle_tag"),
            ("/bottle/cellar", "/cellar"),
            ("/bottle/prefix", "/prefix"),
        ] {
            if provenance.pointer(provenance_ptr) != bottle.pointer(bottle_ptr) {
                self.err(format!(
                    "{label}: provenance {provenance_ptr} does not match metadata {bottle_ptr}"
                ));
            }
        }
        for (provenance_ptr, bottle_ptr) in [
            (
                "/repositories/kandelo_repository",
                "/built_from/kandelo_repository",
            ),
            (
                "/repositories/kandelo_commit",
                "/built_from/kandelo_commit",
            ),
            (
                "/repositories/tap_repository",
                "/built_from/tap_repository",
            ),
            ("/repositories/tap_commit", "/built_from/tap_commit"),
            ("/formula/sha256", "/built_from/formula_sha256"),
        ] {
            if provenance.pointer(provenance_ptr) != bottle.pointer(bottle_ptr) {
                self.err(format!(
                    "{label}: provenance {provenance_ptr} does not match metadata bottle {bottle_ptr}"
                ));
            }
        }

        for (metadata_ptr, rel) in [
            ("/metadata/metadata_json", DEFAULT_METADATA_REL.to_string()),
            (
                "/metadata/formula_json",
                string_at(package, "/formula_metadata")
                    .unwrap_or("")
                    .to_string(),
            ),
            (
                "/metadata/link_manifest_json",
                string_at(bottle, "/link_manifest")
                    .unwrap_or("")
                    .to_string(),
            ),
            ("/metadata/provenance_json", path),
        ] {
            self.validate_metadata_hash(label, &provenance, metadata_ptr, &rel);
        }
    }

    fn validate_fallback_provenance_report(
        &mut self,
        label: &str,
        package: &Value,
        bottle: &Value,
        link: &Value,
        path: &str,
    ) {
        let Some(resolved) = self.resolve_tap_path(label, path) else {
            return;
        };
        match fs::symlink_metadata(&resolved) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => {
                self.err(format!(
                    "{label}: cannot inspect fallback provenance report {path:?}: {error}"
                ));
                return;
            }
            Ok(_) => {}
        }
        let Some(provenance) = self.load_tap_json(label, Some(path)) else {
            return;
        };
        self.report.provenance_reports += 1;
        let schema_errors = collect_schema_errors(&self.schemas.provenance, &provenance);
        self.add_schema_errors(label, schema_errors);
        self.validate_runtime_evidence(label, bottle, &provenance);

        let fallback_link_path = string_at(bottle, "/fallback_link_manifest").unwrap_or("");
        let rebuild = parse_link_manifest_rebuild(fallback_link_path, link).ok();
        for (provenance_ptr, link_ptr) in [
            ("/subject/package", "/package"),
            ("/subject/version", "/version"),
            ("/subject/arch", "/arch"),
            ("/subject/kandelo_abi", "/kandelo_abi"),
            ("/bottle/cellar", "/cellar"),
            ("/bottle/prefix", "/prefix"),
        ] {
            if provenance.pointer(provenance_ptr) != link.pointer(link_ptr) {
                self.err(format!(
                    "{label}: fallback provenance {provenance_ptr} does not match link manifest {link_ptr}"
                ));
            }
        }
        if provenance
            .pointer("/subject/bottle_rebuild")
            .and_then(Value::as_u64)
            != rebuild
        {
            self.err(format!(
                "{label}: fallback provenance /subject/bottle_rebuild does not match its link manifest path"
            ));
        }
        for (provenance_ptr, bottle_ptr) in [
            ("/bottle/url", "/fallback_url"),
            ("/bottle/sha256", "/fallback_sha256"),
            ("/bottle/bytes", "/fallback_bytes"),
            ("/bottle/cache_key_sha", "/fallback_cache_key_sha"),
            ("/bottle/bottle_tag", "/bottle_tag"),
        ] {
            if provenance.pointer(provenance_ptr) != bottle.pointer(bottle_ptr) {
                self.err(format!(
                    "{label}: fallback provenance {provenance_ptr} does not match metadata {bottle_ptr}"
                ));
            }
        }
        if provenance.pointer("/formula/path") != package.pointer("/formula_path") {
            self.err(format!(
                "{label}: fallback provenance /formula/path does not match package /formula_path"
            ));
        }
        for (provenance_ptr, bottle_ptr) in [
            (
                "/repositories/kandelo_repository",
                "/built_from/kandelo_repository",
            ),
            (
                "/repositories/tap_repository",
                "/built_from/tap_repository",
            ),
        ] {
            if provenance.pointer(provenance_ptr) != bottle.pointer(bottle_ptr) {
                self.err(format!(
                    "{label}: fallback provenance {provenance_ptr} does not match metadata {bottle_ptr}"
                ));
            }
        }
        // WHY: this report describes the prior live tap snapshot. Its
        // metadata/formula hashes must not equal files rewritten by the
        // failed attempt, and rewriting them would destroy historical
        // evidence. Bind the retained report to its own normalized hash, its
        // unchanged link bytes, and every fallback bottle identity that
        // current metadata still carries.
        self.validate_metadata_hash(
            label,
            &provenance,
            "/metadata/link_manifest_json",
            fallback_link_path,
        );
        self.validate_metadata_hash(
            label,
            &provenance,
            "/metadata/provenance_json",
            path,
        );
    }

    fn validate_runtime_evidence(&mut self, label: &str, bottle: &Value, provenance: &Value) {
        let Some(runtime_support) = bottle.get("runtime_support").and_then(Value::as_array) else {
            return;
        };
        let Some(outcomes) = provenance
            .pointer("/validation/outcome_lists")
            .and_then(Value::as_array)
        else {
            return;
        };

        let mut outcome_statuses: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for outcome in outcomes {
            let (Some(name), Some(status)) =
                (string_at(outcome, "/name"), string_at(outcome, "/status"))
            else {
                continue;
            };
            outcome_statuses.entry(name).or_default().push(status);
        }
        for (name, statuses) in &outcome_statuses {
            if statuses.len() > 1 {
                self.err(format!(
                    "{label}: provenance repeats validation outcome {name:?}"
                ));
            }
        }

        let successful = |name: &str| {
            outcome_statuses
                .get(name)
                .is_some_and(|statuses| statuses.as_slice() == ["success"])
        };
        let supports_node = runtime_support
            .iter()
            .any(|runtime| runtime.as_str() == Some("node"));
        let supports_browser = runtime_support
            .iter()
            .any(|runtime| runtime.as_str() == Some("browser"));
        let support_data = runtime_support.is_empty();
        let browser_compatible = bottle
            .get("browser_compatible")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        // WHY: runtime_support is a claim about executable guest behavior,
        // while support_data_test proves only installed bytes. Keep those
        // evidence classes mutually exclusive so one cannot impersonate the
        // other during sidecar composition.
        if support_data {
            if !successful("support_data_test") {
                self.err(format!(
                    "{label}: runtime_support=[] requires exactly one successful support_data_test provenance outcome"
                ));
            }
            if successful("node_smoke") || successful("browser_smoke") {
                self.err(format!(
                    "{label}: support-data bottles cannot claim successful executable runtime evidence"
                ));
            }
        } else if successful("support_data_test") {
            self.err(format!(
                "{label}: support_data_test cannot substantiate non-empty runtime_support"
            ));
        }

        if supports_node != successful("node_smoke") {
            self.err(format!(
                "{label}: runtime_support node claim must exactly match one successful node_smoke provenance outcome"
            ));
        }
        if supports_browser != browser_compatible {
            self.err(format!(
                "{label}: runtime_support browser claim must exactly match browser_compatible=true"
            ));
        }
        if supports_browser != successful("browser_smoke") {
            self.err(format!(
                "{label}: runtime_support browser claim must exactly match one successful browser_smoke provenance outcome"
            ));
        }
    }

    fn validate_metadata_hash(
        &mut self,
        label: &str,
        provenance: &Value,
        metadata_ptr: &str,
        expected_rel: &str,
    ) {
        let Some(entry) = provenance.pointer(metadata_ptr) else {
            return;
        };
        if string_at(entry, "/path") != Some(expected_rel) {
            self.err(format!(
                "{label}: provenance {metadata_ptr}/path does not match {expected_rel:?}"
            ));
            return;
        }
        let expected_hash = if metadata_ptr == "/metadata/provenance_json" {
            provenance_normalized_sha256(provenance)
        } else {
            self.resolve_tap_path(label, expected_rel)
                .and_then(|path| sha256_file(&path).ok())
        };
        match (string_at(entry, "/sha256"), expected_hash) {
            (Some(recorded), Some(actual)) if recorded != actual => self.err(format!(
                "{label}: provenance {metadata_ptr}/sha256 {recorded:?} does not match actual {actual}"
            )),
            (None, _) => {}
            (_, None) => self.err(format!(
                "{label}: cannot hash provenance metadata target {expected_rel:?}"
            )),
            _ => {}
        }
    }

    fn validate_fallback_link_manifest(&mut self, label: &str, package: &Value, bottle: &Value) {
        let path = string_at(bottle, "/fallback_link_manifest");
        let Some(link) = self.validate_selected_link_manifest(
            label,
            package,
            bottle,
            path,
            false,
            [
                ("/bottle/url", "/fallback_url"),
                ("/bottle/sha256", "/fallback_sha256"),
                ("/bottle/bytes", "/fallback_bytes"),
                ("/bottle/cache_key_sha", "/fallback_cache_key_sha"),
            ],
        ) else {
            return;
        };
        if let Some(provenance_path) = path.and_then(fallback_provenance_report_path) {
            self.validate_fallback_provenance_report(
                label,
                package,
                bottle,
                &link,
                &provenance_path,
            );
        }
    }

    fn validate_guest_paths(&mut self, label: &str, link: &Value) {
        for ptr in ["/prefix", "/cellar", "/keg"] {
            if let Some(path) = string_at(link, ptr) {
                if !is_safe_guest_absolute_path(path) {
                    self.err(format!(
                        "{label}: link manifest {ptr} is not a safe guest path"
                    ));
                }
            }
        }

        match (string_at(link, "/cellar"), string_at(link, "/prefix")) {
            (Some(cellar), Some(prefix)) if !guest_path_is_under(cellar, prefix) => self.err(
                format!("{label}: cellar {cellar:?} must be under prefix {prefix:?}"),
            ),
            _ => {}
        }
        match (string_at(link, "/keg"), string_at(link, "/cellar")) {
            (Some(keg), Some(cellar)) if !guest_path_is_under(keg, cellar) => self.err(format!(
                "{label}: keg {keg:?} must be under cellar {cellar:?}"
            )),
            _ => {}
        }
    }

    fn validate_links(&mut self, label: &str, link: &Value) {
        let Some(links) = link.get("links").and_then(Value::as_array) else {
            return;
        };
        let mut targets = BTreeSet::new();
        for (index, entry) in links.iter().enumerate() {
            let entry_label = format!("{label}: link #{index}");
            for ptr in ["/source", "/target"] {
                if let Some(path) = string_at(entry, ptr) {
                    if !is_safe_relative_path(path) {
                        self.err(format!("{entry_label}: {ptr} {path:?} is not path-safe"));
                    }
                }
            }
            if let Some(target) = string_at(entry, "/target") {
                if !targets.insert(target.to_string()) {
                    self.err(format!(
                        "{label}: duplicate link target {target:?} in link manifest"
                    ));
                }
            }
        }
    }

    fn validate_receipts(&mut self, label: &str, link: &Value) {
        let Some(receipts) = link.get("receipts").and_then(Value::as_array) else {
            return;
        };
        let mut seen = BTreeSet::new();
        for (index, receipt) in receipts.iter().enumerate() {
            let Some(path) = receipt.as_str() else {
                continue;
            };
            if !is_safe_relative_path(path) {
                self.err(format!(
                    "{label}: receipt #{index} {path:?} is not path-safe"
                ));
            }
            if !seen.insert(path.to_string()) {
                self.err(format!("{label}: duplicate receipt path {path:?}"));
            }
        }
    }

    fn load_tap_json(&mut self, label: &str, rel: Option<&str>) -> Option<Value> {
        let rel = rel?;
        let path = self.resolve_tap_path(label, rel)?;
        match load_json(&path) {
            Ok(value) => Some(value),
            Err(e) => {
                self.err(format!("{label}: {e}"));
                None
            }
        }
    }

    fn resolve_tap_path(&mut self, label: &str, rel: &str) -> Option<PathBuf> {
        if !is_safe_relative_path(rel) {
            self.err(format!(
                "{label}: path {rel:?} is not tap-relative and safe"
            ));
            return None;
        }
        let mut path = self.options.tap_root.clone();
        for segment in rel.split('/') {
            path.push(segment);
            match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    self.err(format!(
                        "{label}: path {rel:?} traverses symlink {}",
                        path.display()
                    ));
                    return None;
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(error) => {
                    self.err(format!(
                        "{label}: cannot inspect path component {}: {error}",
                        path.display()
                    ));
                    return None;
                }
            }
        }
        Some(path)
    }

    fn add_schema_errors(&mut self, label: &str, errors: Vec<String>) {
        for error in errors {
            self.err(format!("{label}: schema: {error}"));
        }
    }

    fn err(&mut self, message: String) {
        self.report.errors.push(format!("- {message}"));
    }
}

fn load_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))
}

fn collect_schema_errors(schema: &JSONSchema, value: &Value) -> Vec<String> {
    match schema.validate(value) {
        Ok(()) => Vec::new(),
        Err(errors) => errors.map(|error| error.to_string()).collect(),
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

#[derive(Debug, PartialEq, Eq)]
struct FormulaBottleBlock {
    root_url: String,
    rebuild: u64,
    tags: BTreeMap<String, String>,
}

fn validate_formula_structure_with_ripper(path: &Path) -> Result<(), String> {
    let script = repo_root().join("scripts/homebrew-formula-source-digest.rb");
    let output = Command::new("ruby")
        .arg(&script)
        .arg(path)
        .output()
        .map_err(|error| format!("run {}: {error}", script.display()))?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr.trim();
    if detail.is_empty() {
        Err(format!(
            "{} exited with status {}",
            script.display(),
            output.status
        ))
    } else {
        Err(detail.to_string())
    }
}

fn parse_formula_bottle_block(
    source: &str,
    exact_guest_cellar: &str,
) -> Result<Option<FormulaBottleBlock>, String> {
    if !source.ends_with('\n') || source.contains('\r') {
        return Err("Formula must use LF lines and end with a newline".to_string());
    }
    let lines: Vec<&str> = source.lines().collect();
    let starts: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| (*line == "  bottle do").then_some(index))
        .collect();
    if starts.len() > 1 {
        return Err("multiple bottle blocks".to_string());
    }
    let Some(start) = starts.first().copied() else {
        return Ok(None);
    };
    let end = ((start + 1)..lines.len())
        .find(|index| lines[*index] == "  end")
        .ok_or_else(|| "unterminated bottle block".to_string())?;

    let mut root_url = None;
    let mut rebuild = 0;
    let mut rebuild_seen = false;
    let mut tags = BTreeMap::new();
    for line in &lines[(start + 1)..end] {
        if let Some(value) = line
            .strip_prefix("    root_url \"")
            .and_then(|value| value.strip_suffix('"'))
        {
            if root_url.is_some() || !value.starts_with("https://ghcr.io/v2/") {
                return Err("invalid or duplicate root_url".to_string());
            }
            root_url = Some(value.to_string());
            continue;
        }
        if let Some(value) = line.strip_prefix("    rebuild ") {
            if rebuild_seen {
                return Err("duplicate rebuild".to_string());
            }
            rebuild = value
                .parse::<u64>()
                .map_err(|_| "invalid rebuild".to_string())?;
            if rebuild == 0 || rebuild.to_string() != value {
                return Err("rebuild must be a canonical positive integer".to_string());
            }
            rebuild_seen = true;
            continue;
        }
        if let Some(value) = line.strip_prefix("    sha256 cellar: ") {
            let (cellar, tagged_sha) = value
                .split_once(", ")
                .ok_or_else(|| "invalid sha256 line".to_string())?;
            let exact_cellar = format!("\"{exact_guest_cellar}\"");
            if !matches!(cellar, ":any" | ":any_skip_relocation") && cellar != exact_cellar {
                return Err("invalid bottle cellar".to_string());
            }
            let (tag, quoted_sha) = tagged_sha
                .split_once(": \"")
                .ok_or_else(|| "invalid sha256 tag".to_string())?;
            let sha256 = quoted_sha
                .strip_suffix('"')
                .ok_or_else(|| "invalid sha256 quoting".to_string())?;
            if !matches!(tag, "wasm32_kandelo" | "wasm64_kandelo") {
                return Err(format!("invalid bottle tag {tag:?}"));
            }
            if sha256.len() != 64
                || !sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(format!("invalid sha256 for {tag}"));
            }
            if tags.insert(tag.to_string(), sha256.to_string()).is_some() {
                return Err(format!("duplicate bottle tag {tag}"));
            }
            continue;
        }
        return Err(format!("unsupported bottle content {line:?}"));
    }
    let root_url = root_url.ok_or_else(|| "missing root_url".to_string())?;
    Ok(Some(FormulaBottleBlock {
        root_url,
        rebuild,
        tags,
    }))
}

fn provenance_normalized_sha256(provenance: &Value) -> Option<String> {
    let mut normalized = provenance.clone();
    *normalized.pointer_mut("/metadata/provenance_json/sha256")? = Value::String(
        "0000000000000000000000000000000000000000000000000000000000000000".to_string(),
    );
    let mut text = serde_json::to_string_pretty(&normalized).ok()?;
    text.push('\n');
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    Some(format!("{:x}", hasher.finalize()))
}

fn provenance_report_path(package: &Value, bottle: &Value) -> Option<String> {
    Some(format!(
        "Kandelo/reports/{}-{}-rebuild{}-{}.provenance.json",
        string_at(package, "/name")?,
        string_at(package, "/version")?,
        u64_at(package, "/bottle_rebuild")?,
        string_at(bottle, "/arch")?
    ))
}

fn fallback_provenance_report_path(link_manifest: &str) -> Option<String> {
    let stem = link_manifest
        .strip_prefix("Kandelo/link/")?
        .strip_suffix(".json")?;
    Some(format!("Kandelo/reports/{stem}.provenance.json"))
}

fn parse_link_manifest_rebuild(path: &str, link: &Value) -> Result<u64, String> {
    let package = string_at(link, "/package")
        .ok_or_else(|| "link manifest has no package identity".to_string())?;
    let version = string_at(link, "/version")
        .ok_or_else(|| "link manifest has no version identity".to_string())?;
    let arch = string_at(link, "/arch")
        .ok_or_else(|| "link manifest has no architecture identity".to_string())?;
    let prefix = format!("Kandelo/link/{package}-{version}-rebuild");
    let suffix = format!("-{arch}.json");
    let rebuild_text = path
        .strip_prefix(&prefix)
        .and_then(|value| value.strip_suffix(&suffix))
        .ok_or_else(|| {
            format!(
                "link manifest path {path:?} does not match its package, version, and architecture"
            )
        })?;
    let rebuild = rebuild_text
        .parse::<u64>()
        .map_err(|_| format!("link manifest path {path:?} has an invalid rebuild"))?;
    if rebuild.to_string() != rebuild_text {
        return Err(format!(
            "link manifest path {path:?} has a noncanonical rebuild"
        ));
    }
    Ok(rebuild)
}

fn parse_release_abi(tag: Option<&str>) -> Option<u64> {
    tag?.strip_prefix("bottles-abi-v")?.parse().ok()
}

fn string_at<'a>(value: &'a Value, pointer: &str) -> Option<&'a str> {
    value.pointer(pointer)?.as_str()
}

fn u64_at(value: &Value, pointer: &str) -> Option<u64> {
    value.pointer(pointer)?.as_u64()
}

fn is_safe_relative_path(path: &str) -> bool {
    if path.is_empty() || path.starts_with('/') || path.contains('\\') {
        return false;
    }
    safe_segments(path)
}

fn is_safe_guest_absolute_path(path: &str) -> bool {
    if !path.starts_with('/') || path.contains('\\') {
        return false;
    }
    safe_segments(path.trim_start_matches('/'))
}

fn safe_segments(path: &str) -> bool {
    !path
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
}

fn guest_path_is_under(child: &str, parent: &str) -> bool {
    let child_segments = guest_segments(child);
    let parent_segments = guest_segments(parent);
    !parent_segments.is_empty()
        && child_segments.len() >= parent_segments.len()
        && child_segments
            .iter()
            .zip(parent_segments.iter())
            .all(|(child, parent)| child == parent)
}

fn guest_segments(path: &str) -> Vec<&str> {
    path.trim_start_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn write_json(path: &Path, value: &Value) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
    }

    fn write_text(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, text).unwrap();
    }

    fn set(value: &mut Value, pointer: &str, replacement: Value) {
        *value
            .pointer_mut(pointer)
            .unwrap_or_else(|| panic!("missing {pointer}")) = replacement;
    }

    struct Fixture {
        _dir: TempDir,
        tap_root: PathBuf,
        metadata: Value,
        formula: Value,
        link: Value,
        provenance: Value,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let tap_root = dir.path().to_path_buf();
            let formula_text = concat!(
                "class What < Formula\n",
                "  desc \"Fixture\"\n",
                "\n",
                "  bottle do\n",
                "    root_url \"https://ghcr.io/v2/kandelo-dev/homebrew-tap-core\"\n",
                "    sha256 cellar: :any_skip_relocation, wasm32_kandelo: ",
                "\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"\n",
                "  end\n",
                "end\n",
            );
            let formula_sha = {
                let mut hasher = Sha256::new();
                hasher.update(formula_text.as_bytes());
                format!("{:x}", hasher.finalize())
            };

            write_text(&tap_root.join("Formula/what.rb"), formula_text);

            let mut metadata =
                load_repo_json("homebrew/homebrew-tap-core/Kandelo/examples/metadata.json");
            let mut formula =
                load_repo_json("homebrew/homebrew-tap-core/Kandelo/examples/formula/what.json");
            let mut link = load_repo_json(
                "homebrew/homebrew-tap-core/Kandelo/examples/link/what-15.0.0-rebuild0-wasm32.json",
            );
            let mut provenance = load_repo_json(
                "homebrew/homebrew-tap-core/Kandelo/examples/reports/what-15.0.0-rebuild0-wasm32.provenance.json",
            );

            let bottle_sha256 = string_at(&metadata, "/packages/0/bottles/0/sha256")
                .unwrap()
                .to_string();
            let bottle_url =
                repository_bottle_url("kandelo-dev/homebrew-tap-core", "what", &bottle_sha256);
            set(
                &mut metadata,
                "/packages/0/bottles/0/url",
                json!(bottle_url.clone()),
            );
            set(&mut formula, "/bottles/0/url", json!(bottle_url.clone()));
            set(&mut link, "/bottle/url", json!(bottle_url.clone()));
            set(&mut provenance, "/bottle/url", json!(bottle_url));

            set(
                &mut metadata,
                "/packages/0/bottles/0/built_from/formula_sha256",
                json!(formula_sha),
            );
            set(
                &mut formula,
                "/bottles/0/built_from/formula_sha256",
                json!(formula_sha),
            );

            let fixture = Self {
                _dir: dir,
                tap_root,
                metadata,
                formula,
                link,
                provenance,
            };
            fixture.write();
            fixture
        }

        fn write(&self) {
            write_json(&self.tap_root.join("Kandelo/metadata.json"), &self.metadata);
            write_json(
                &self.tap_root.join("Kandelo/formula/what.json"),
                &self.formula,
            );
            write_json(
                &self
                    .tap_root
                    .join("Kandelo/link/what-15.0.0-rebuild0-wasm32.json"),
                &self.link,
            );

            let mut provenance = self.provenance.clone();
            let formula_sha = sha256_file(&self.tap_root.join("Formula/what.rb")).unwrap();
            set(&mut provenance, "/formula/sha256", json!(formula_sha));
            set(
                &mut provenance,
                "/metadata/metadata_json/sha256",
                json!(sha256_file(&self.tap_root.join("Kandelo/metadata.json")).unwrap()),
            );
            set(
                &mut provenance,
                "/metadata/formula_json/sha256",
                json!(sha256_file(&self.tap_root.join("Kandelo/formula/what.json")).unwrap()),
            );
            set(
                &mut provenance,
                "/metadata/link_manifest_json/sha256",
                json!(
                    sha256_file(
                        &self
                            .tap_root
                            .join("Kandelo/link/what-15.0.0-rebuild0-wasm32.json")
                    )
                    .unwrap()
                ),
            );
            set(
                &mut provenance,
                "/metadata/provenance_json/sha256",
                json!("0000000000000000000000000000000000000000000000000000000000000000"),
            );
            let provenance_sha = provenance_normalized_sha256(&provenance).unwrap();
            set(
                &mut provenance,
                "/metadata/provenance_json/sha256",
                json!(provenance_sha),
            );
            write_json(
                &self
                    .tap_root
                    .join("Kandelo/reports/what-15.0.0-rebuild0-wasm32.provenance.json"),
                &provenance,
            );
        }

        fn validate(&self) -> ValidationReport {
            self.validate_with_campaign_layout(None)
        }

        fn validate_with_campaign_layout(
            &self,
            prefix_campaign_layout_sha256: Option<String>,
        ) -> ValidationReport {
            validate(&Options {
                tap_root: self.tap_root.clone(),
                metadata_path: self.tap_root.join(DEFAULT_METADATA_REL),
                prefix_campaign_layout_sha256,
            })
            .unwrap()
        }
    }

    fn load_repo_json(rel: &str) -> Value {
        load_json(&repo_root().join(rel)).unwrap()
    }

    fn set_runtime_contract(
        fixture: &mut Fixture,
        runtime_support: Value,
        browser_compatible: bool,
        fork_instrumentation: &str,
    ) {
        for bottle in [
            &mut fixture.metadata["packages"][0]["bottles"][0],
            &mut fixture.formula["bottles"][0],
        ] {
            bottle["runtime_support"] = runtime_support.clone();
            bottle["browser_compatible"] = json!(browser_compatible);
            bottle["fork_instrumentation"] = json!(fork_instrumentation);
        }
    }

    fn remove_outcome(fixture: &mut Fixture, name: &str) {
        fixture.provenance["validation"]["outcome_lists"]
            .as_array_mut()
            .unwrap()
            .retain(|outcome| string_at(outcome, "/name") != Some(name));
    }

    fn set_guest_layout(fixture: &mut Fixture, prefix: &str, cellar: &str) {
        for bottle in [
            &mut fixture.metadata["packages"][0]["bottles"][0],
            &mut fixture.formula["bottles"][0],
        ] {
            bottle["prefix"] = json!(prefix);
            bottle["cellar"] = json!(cellar);
        }
        fixture.link["prefix"] = json!(prefix);
        fixture.link["cellar"] = json!(cellar);
        fixture.link["keg"] = json!(format!("{cellar}/what/15.0.0"));
        fixture.provenance["bottle"]["prefix"] = json!(prefix);
        fixture.provenance["bottle"]["cellar"] = json!(cellar);
    }

    fn set_outcome(fixture: &mut Fixture, name: &str, status: &str) {
        remove_outcome(fixture, name);
        let (passed, failed, skipped, skip_reason) = match status {
            "success" => (
                json!([format!("{name} fixture passed")]),
                json!([]),
                json!([]),
                None,
            ),
            "failed" => (
                json!([]),
                json!([format!("{name} fixture failed")]),
                json!([]),
                None,
            ),
            "skipped" => (
                json!([]),
                json!([]),
                json!([format!("{name} fixture skipped")]),
                Some(format!("{name} is intentionally absent from this fixture.")),
            ),
            other => panic!("unsupported fixture outcome status {other}"),
        };
        let mut outcome = json!({
            "name": name,
            "status": status,
            "passed": passed,
            "failed": failed,
            "skipped": skipped,
        });
        if let Some(reason) = skip_reason {
            outcome["skip_reason"] = json!(reason);
        }
        fixture.provenance["validation"]["outcome_lists"]
            .as_array_mut()
            .unwrap()
            .push(outcome);
    }

    fn fixture_provenance_path(fixture: &Fixture) -> PathBuf {
        fixture
            .tap_root
            .join("Kandelo/reports/what-15.0.0-rebuild0-wasm32.provenance.json")
    }

    fn make_failed_with_fallback(fixture: &mut Fixture) {
        let success = fixture.metadata["packages"][0]["bottles"][0].clone();
        let fallback = json!({
            "arch": success["arch"].clone(),
            "bottle_tag": success["bottle_tag"].clone(),
            "kandelo_abi": success["kandelo_abi"].clone(),
            "cellar": success["cellar"].clone(),
            "prefix": success["prefix"].clone(),
            "runtime_support": success["runtime_support"].clone(),
            "browser_compatible": success["browser_compatible"].clone(),
            "fork_instrumentation": success["fork_instrumentation"].clone(),
            "status": "failed",
            "built_by": success["built_by"].clone(),
            "built_from": success["built_from"].clone(),
            "error": "build failed",
            "last_attempt": "2026-06-28T00:00:00Z",
            "last_attempt_by": "https://example.invalid/actions/runs/43",
            "fallback_url": success["url"].clone(),
            "fallback_sha256": success["sha256"].clone(),
            "fallback_bytes": success["bytes"].clone(),
            "fallback_cache_key_sha": success["cache_key_sha"].clone(),
            "fallback_link_manifest": success["link_manifest"].clone(),
            "fallback_built_at": "2026-06-27T00:00:00Z",
        });
        fixture.metadata["packages"][0]["bottles"][0] = fallback.clone();
        fixture.formula["bottles"][0] = fallback;
    }

    #[test]
    fn validates_live_tap_fixture() {
        let fixture = Fixture::new();
        let report = fixture.validate();
        assert_eq!(report.errors, Vec::<String>::new());
        assert_eq!(report.packages, 1);
        assert_eq!(report.bottles, 1);
        assert_eq!(report.link_manifests, 1);
        assert_eq!(report.provenance_reports, 1);
    }

    #[test]
    fn validates_the_digest_bound_prefix_campaign_layout() {
        let mut hasher = Sha256::new();
        hasher.update(include_str!("../../../homebrew/kandelo-guest-layout.json").as_bytes());
        let digest = format!("{:x}", hasher.finalize());
        let mut fixture = Fixture::new();
        let layout = crate::homebrew_guest_layout::get(Some(&digest)).unwrap();
        set_guest_layout(&mut fixture, &layout.prefix, &layout.cellar);
        fixture.write();
        let report = fixture.validate_with_campaign_layout(Some(digest));
        assert_eq!(report.errors, Vec::<String>::new());
    }

    #[test]
    fn rejects_every_unselected_live_sidecar_kind() {
        for (kind, rel) in [
            ("formula sidecar", "Kandelo/formula/orphan.json"),
            (
                "link manifest",
                "Kandelo/link/orphan-1.0-rebuild0-wasm32.json",
            ),
            (
                "provenance report",
                "Kandelo/reports/orphan-1.0-rebuild0-wasm32.provenance.json",
            ),
        ] {
            let fixture = Fixture::new();
            write_json(&fixture.tap_root.join(rel), &json!({ "orphan": true }));

            let report = fixture.validate();
            assert!(
                report
                    .errors
                    .join("\n")
                    .contains(&format!("live {kind} {rel:?} is not selected")),
                "{kind} produced unexpected validation errors: {:#?}",
                report.errors,
            );
        }
    }

    #[test]
    fn rejects_wrong_extension_files_and_unexpected_directories_in_live_catalogs() {
        for (kind, rel) in [
            ("formula sidecar", "Kandelo/formula/README.md"),
            ("link manifest", "Kandelo/link/stale.txt"),
            ("provenance report", "Kandelo/reports/stale.json"),
            ("formula sidecar", "Kandelo/formula/archive"),
            ("link manifest", "Kandelo/link/archive"),
            ("provenance report", "Kandelo/reports/archive"),
        ] {
            let fixture = Fixture::new();
            let path = fixture.tap_root.join(rel);
            if rel.ends_with("archive") {
                fs::create_dir(&path).unwrap();
            } else {
                write_text(&path, "not a live sidecar\n");
            }

            let report = fixture.validate();
            assert!(
                report
                    .errors
                    .join("\n")
                    .contains(&format!("live {kind} directory")),
                "{rel} produced unexpected validation errors: {:#?}",
                report.errors,
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_sidecar_symlink_even_when_its_target_is_regular() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new();
        let target = fixture.tap_root.join("orphan-target.json");
        write_json(&target, &json!({ "orphan": true }));
        symlink(
            &target,
            fixture.tap_root.join("Kandelo/formula/symlink.json"),
        )
        .unwrap();

        let report = fixture.validate();
        assert!(
            report
                .errors
                .join("\n")
                .contains("must be a regular non-symlink file"),
            "unexpected validation errors: {:#?}",
            report.errors,
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_live_and_historical_directory_roots() {
        use std::os::unix::fs::symlink;

        let formula_fixture = Fixture::new();
        let formula_directory = formula_fixture.tap_root.join("Kandelo/formula");
        let moved_formula_directory = formula_fixture.tap_root.join("moved-formula");
        fs::rename(&formula_directory, &moved_formula_directory).unwrap();
        symlink(&moved_formula_directory, &formula_directory).unwrap();
        let formula_errors = formula_fixture.validate().errors.join("\n");
        assert!(
            formula_errors.contains("live formula sidecar directory")
                && formula_errors.contains("must be a real directory"),
            "{formula_errors}"
        );

        let historical_fixture = Fixture::new();
        let historical_target = historical_fixture.tap_root.join("historical-target");
        fs::create_dir(&historical_target).unwrap();
        symlink(
            &historical_target,
            historical_fixture
                .tap_root
                .join("Kandelo/reports/failures"),
        )
        .unwrap();
        let historical_errors = historical_fixture.validate().errors.join("\n");
        assert!(
            historical_errors.contains(
                "historical provenance report namespace Kandelo/reports/failures must be a real directory"
            ),
            "{historical_errors}"
        );
    }

    #[test]
    fn rejects_every_missing_selected_live_sidecar_kind() {
        for (kind, rel) in [
            ("formula sidecar", "Kandelo/formula/what.json"),
            (
                "link manifest",
                "Kandelo/link/what-15.0.0-rebuild0-wasm32.json",
            ),
            (
                "provenance report",
                "Kandelo/reports/what-15.0.0-rebuild0-wasm32.provenance.json",
            ),
        ] {
            let fixture = Fixture::new();
            fs::remove_file(fixture.tap_root.join(rel)).unwrap();

            let report = fixture.validate();
            assert!(
                report
                    .errors
                    .join("\n")
                    .contains(&format!("selected {kind} {rel:?} is missing")),
                "{kind} produced unexpected validation errors: {:#?}",
                report.errors,
            );
        }
    }

    #[test]
    fn rejects_noncanonical_formula_and_link_sidecar_identities() {
        for (kind, pointer, replacement) in [
            (
                "formula sidecar",
                "/packages/0/formula_metadata",
                "Kandelo/formula/other.json",
            ),
            (
                "link manifest",
                "/packages/0/bottles/0/link_manifest",
                "Kandelo/link/other.json",
            ),
        ] {
            let mut fixture = Fixture::new();
            set(&mut fixture.metadata, pointer, json!(replacement));
            if kind == "formula sidecar" {
                write_json(&fixture.tap_root.join(replacement), &fixture.formula);
            } else {
                set(
                    &mut fixture.formula,
                    "/bottles/0/link_manifest",
                    json!(replacement),
                );
                write_json(&fixture.tap_root.join(replacement), &fixture.link);
            }
            fixture.write();

            let report = fixture.validate();
            assert!(
                report.errors.join("\n").contains(&format!(
                    "{kind} path {replacement:?} is not its canonical identity"
                )),
                "{kind} produced unexpected validation errors: {:#?}",
                report.errors,
            );
        }
    }

    #[test]
    fn rejects_duplicate_formula_link_and_provenance_ownership() {
        let mut formula_fixture = Fixture::new();
        let mut second_package = formula_fixture.metadata["packages"][0].clone();
        second_package["name"] = json!("other");
        second_package["full_name"] = json!("kandelo-dev/tap-core/other");
        formula_fixture.metadata["packages"]
            .as_array_mut()
            .unwrap()
            .push(second_package);
        formula_fixture.write();
        let formula_errors = formula_fixture.validate().errors.join("\n");
        assert!(
            formula_errors.contains(
                "formula sidecar \"Kandelo/formula/what.json\" is selected more than once"
            ),
            "{formula_errors}"
        );

        let mut link_fixture = Fixture::new();
        let mut second_bottle = link_fixture.metadata["packages"][0]["bottles"][0].clone();
        second_bottle["arch"] = json!("wasm64");
        second_bottle["bottle_tag"] = json!("wasm64_kandelo");
        link_fixture.metadata["packages"][0]["bottles"]
            .as_array_mut()
            .unwrap()
            .push(second_bottle.clone());
        link_fixture.formula["bottles"]
            .as_array_mut()
            .unwrap()
            .push(second_bottle);
        link_fixture.write();
        let link_errors = link_fixture.validate().errors.join("\n");
        assert!(
            link_errors.contains(
                "link manifest \"Kandelo/link/what-15.0.0-rebuild0-wasm32.json\" is selected more than once"
            ),
            "{link_errors}"
        );

        let mut provenance_fixture = Fixture::new();
        let duplicate = provenance_fixture.metadata["packages"][0]["bottles"][0].clone();
        provenance_fixture.metadata["packages"][0]["bottles"]
            .as_array_mut()
            .unwrap()
            .push(duplicate.clone());
        provenance_fixture.formula["bottles"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        provenance_fixture.write();
        let provenance_errors = provenance_fixture.validate().errors.join("\n");
        assert!(
            provenance_errors.contains(
                "provenance report \"Kandelo/reports/what-15.0.0-rebuild0-wasm32.provenance.json\" is selected more than once"
            ),
            "{provenance_errors}"
        );
    }

    #[test]
    fn permits_explicit_historical_reports_outside_the_live_catalog() {
        for namespace in ["failures", "rollbacks"] {
            let fixture = Fixture::new();
            write_json(
                &fixture
                    .tap_root
                    .join(format!("Kandelo/reports/{namespace}/old-prefix.json")),
                &json!({
                    "status": namespace,
                    "historical_prefix": "/opt/retired/homebrew",
                }),
            );

            let report = fixture.validate();
            assert_eq!(
                report.errors,
                Vec::<String>::new(),
                "historical namespace {namespace} was rejected"
            );
        }
    }

    #[test]
    fn rejects_stale_guest_paths_in_a_selected_fallback_manifest() {
        let mut fixture = Fixture::new();
        make_failed_with_fallback(&mut fixture);
        fixture.link["prefix"] = json!("/opt/other-system/homebrew");
        fixture.link["cellar"] = json!("/opt/other-system/homebrew/Cellar");
        fixture.link["keg"] = json!("/opt/other-system/homebrew/Cellar/what/15.0.0");
        fixture.write();

        let report = fixture.validate();
        let errors = report.errors.join("\n");
        assert!(
            errors.contains("link manifest /prefix does not match metadata /prefix"),
            "{errors}"
        );
        assert!(
            errors.contains("link manifest /cellar does not match metadata /cellar"),
            "{errors}"
        );
    }

    #[test]
    fn accepts_a_prior_rebuild_fallback_and_its_root_provenance() {
        let mut fixture = Fixture::new();
        let prior_provenance = fs::read(fixture_provenance_path(&fixture)).unwrap();
        make_failed_with_fallback(&mut fixture);
        fixture.metadata["packages"][0]["bottle_rebuild"] = json!(1);
        fixture.formula["bottle_rebuild"] = json!(1);

        let formula_path = fixture.tap_root.join("Formula/what.rb");
        let formula_source = fs::read_to_string(&formula_path).unwrap().replace(
            "    sha256 cellar:",
            "    rebuild 1\n    sha256 cellar:",
        );
        write_text(&formula_path, &formula_source);
        let formula_sha = sha256_file(&formula_path).unwrap();
        fixture.metadata["packages"][0]["bottles"][0]["built_from"]["formula_sha256"] =
            json!(formula_sha.clone());
        fixture.formula["bottles"][0]["built_from"]["formula_sha256"] = json!(formula_sha);
        fixture.write();
        fs::write(fixture_provenance_path(&fixture), prior_provenance).unwrap();

        let report = fixture.validate();
        assert_eq!(report.errors, Vec::<String>::new());
        assert_eq!(report.link_manifests, 1);
        assert_eq!(report.provenance_reports, 1);
    }

    #[test]
    fn prefix_campaign_rejects_a_noncanonical_guest_prefix_or_cellar() {
        let mut hasher = Sha256::new();
        hasher.update(include_str!("../../../homebrew/kandelo-guest-layout.json").as_bytes());
        let digest = format!("{:x}", hasher.finalize());
        let layout = crate::homebrew_guest_layout::get(Some(&digest)).unwrap();
        for field in ["prefix", "cellar"] {
            let mut fixture = Fixture::new();
            set_guest_layout(&mut fixture, &layout.prefix, &layout.cellar);
            fixture.metadata["packages"][0]["bottles"][0][field] =
                json!(format!("/opt/not-kandelo/{field}"));
            fixture.formula["bottles"][0][field] =
                fixture.metadata["packages"][0]["bottles"][0][field].clone();
            fixture.write();

            let report = fixture.validate_with_campaign_layout(Some(digest.clone()));
            assert!(
                report.errors.join("\n").contains(&format!(
                    "{field} does not match the selected prefix-campaign guest layout"
                )),
                "{:?}",
                report.errors
            );
        }
    }

    #[test]
    fn accepts_support_data_without_executable_runtime_claims() {
        let mut fixture = Fixture::new();
        set_runtime_contract(&mut fixture, json!([]), false, "not-required");
        remove_outcome(&mut fixture, "node_smoke");
        set_outcome(&mut fixture, "support_data_test", "success");
        fixture.write();

        let report = fixture.validate();
        assert_eq!(report.errors, Vec::<String>::new());
    }

    #[test]
    fn rejects_support_data_without_successful_support_data_evidence() {
        for status in [None, Some("failed"), Some("skipped")] {
            let mut fixture = Fixture::new();
            set_runtime_contract(&mut fixture, json!([]), false, "not-required");
            remove_outcome(&mut fixture, "node_smoke");
            remove_outcome(&mut fixture, "support_data_test");
            if let Some(status) = status {
                set_outcome(&mut fixture, "support_data_test", status);
            }
            fixture.write();

            let report = fixture.validate();
            assert!(
                report.errors.join("\n").contains(
                    "runtime_support=[] requires exactly one successful support_data_test"
                ),
                "status {status:?} produced unexpected validation errors: {:#?}",
                report.errors,
            );
        }
    }

    #[test]
    fn rejects_executable_runtime_claim_backed_by_support_data_evidence() {
        let mut fixture = Fixture::new();
        set_outcome(&mut fixture, "support_data_test", "success");
        fixture.write();

        let report = fixture.validate();
        assert!(
            report
                .errors
                .join("\n")
                .contains("support_data_test cannot substantiate non-empty runtime_support"),
            "unexpected validation errors: {:#?}",
            report.errors,
        );
    }

    #[test]
    fn rejects_support_data_with_successful_executable_runtime_evidence() {
        let mut fixture = Fixture::new();
        set_runtime_contract(&mut fixture, json!([]), false, "not-required");
        set_outcome(&mut fixture, "support_data_test", "success");
        fixture.write();

        let report = fixture.validate();
        assert!(
            report.errors.join("\n").contains(
                "support-data bottles cannot claim successful executable runtime evidence"
            ),
            "unexpected validation errors: {:#?}",
            report.errors,
        );
    }

    #[test]
    fn rejects_node_claim_without_successful_node_evidence() {
        for status in [None, Some("failed"), Some("skipped")] {
            let mut fixture = Fixture::new();
            remove_outcome(&mut fixture, "node_smoke");
            if let Some(status) = status {
                set_outcome(&mut fixture, "node_smoke", status);
            }
            fixture.write();

            let report = fixture.validate();
            assert!(
                report
                    .errors
                    .join("\n")
                    .contains("runtime_support node claim must exactly match"),
                "status {status:?} produced unexpected validation errors: {:#?}",
                report.errors,
            );
        }
    }

    #[test]
    fn accepts_browser_claim_with_matching_runtime_evidence() {
        let mut fixture = Fixture::new();
        set_runtime_contract(
            &mut fixture,
            json!(["node", "browser"]),
            true,
            "not-required",
        );
        set_outcome(&mut fixture, "browser_smoke", "success");
        fixture.write();

        let report = fixture.validate();
        assert_eq!(report.errors, Vec::<String>::new());
    }

    #[test]
    fn rejects_browser_claim_without_successful_browser_evidence() {
        for status in [None, Some("failed"), Some("skipped")] {
            let mut fixture = Fixture::new();
            set_runtime_contract(
                &mut fixture,
                json!(["node", "browser"]),
                true,
                "not-required",
            );
            remove_outcome(&mut fixture, "browser_smoke");
            if let Some(status) = status {
                set_outcome(&mut fixture, "browser_smoke", status);
            }
            fixture.write();

            let report = fixture.validate();
            assert!(
                report
                    .errors
                    .join("\n")
                    .contains("runtime_support browser claim must exactly match one successful"),
                "status {status:?} produced unexpected validation errors: {:#?}",
                report.errors,
            );
        }
    }

    #[test]
    fn rejects_browser_claim_and_compatibility_disagreement() {
        for (runtime_support, browser_compatible) in
            [(json!(["node"]), true), (json!(["node", "browser"]), false)]
        {
            let mut fixture = Fixture::new();
            set_runtime_contract(
                &mut fixture,
                runtime_support,
                browser_compatible,
                "not-required",
            );
            set_outcome(&mut fixture, "browser_smoke", "success");
            fixture.write();

            let report = fixture.validate();
            assert!(
                report.errors.join("\n").contains(
                    "runtime_support browser claim must exactly match browser_compatible"
                ),
                "runtime/compatibility disagreement produced unexpected errors: {:#?}",
                report.errors,
            );
        }
    }

    #[test]
    fn rejects_duplicate_runtime_evidence_names() {
        let mut fixture = Fixture::new();
        fixture.provenance["validation"]["outcome_lists"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "name": "node_smoke",
                "status": "success",
                "passed": ["a second, distinct Node outcome"],
                "failed": [],
                "skipped": [],
            }));
        fixture.write();

        let report = fixture.validate();
        assert!(
            report
                .errors
                .join("\n")
                .contains("provenance repeats validation outcome \"node_smoke\""),
            "unexpected validation errors: {:#?}",
            report.errors,
        );
    }

    #[test]
    fn rejects_support_data_with_executable_only_bottle_flags() {
        for (browser_compatible, fork_instrumentation) in
            [(true, "not-required"), (false, "required")]
        {
            let mut fixture = Fixture::new();
            set_runtime_contract(
                &mut fixture,
                json!([]),
                browser_compatible,
                fork_instrumentation,
            );
            remove_outcome(&mut fixture, "node_smoke");
            set_outcome(&mut fixture, "support_data_test", "success");
            fixture.write();

            let report = fixture.validate();
            assert!(
                report.errors.iter().any(|error| error.contains("schema:")),
                "flags {browser_compatible}/{fork_instrumentation} unexpectedly passed: {:#?}",
                report.errors,
            );
        }
    }

    #[test]
    fn command_entrypoint_validates_live_tap_fixture() {
        let fixture = Fixture::new();
        run(vec![
            "--tap-root".to_string(),
            fixture.tap_root.to_string_lossy().into_owned(),
        ])
        .unwrap();
    }

    #[test]
    fn rejects_release_abi_mismatch() {
        let mut fixture = Fixture::new();
        set(
            &mut fixture.metadata,
            "/release_tag",
            json!("bottles-abi-v16"),
        );
        fixture.write();
        let report = fixture.validate();
        assert!(report.errors.join("\n").contains("release_tag ABI 16"));
    }

    #[test]
    fn rejects_tap_name_that_does_not_match_repository() {
        let mut fixture = Fixture::new();
        set(&mut fixture.metadata, "/tap_name", json!("attacker/core"));
        set(&mut fixture.formula, "/tap_name", json!("attacker/core"));
        let formula_path = fixture.tap_root.join("Formula/what.rb");
        let source = fs::read_to_string(&formula_path).unwrap();
        write_text(
            &formula_path,
            &source.replace(
                "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core",
                "https://ghcr.io/v2/attacker/core",
            ),
        );
        fixture.write();

        let report = fixture.validate();
        assert!(
            report.errors.join("\n").contains(
                "tap name \"attacker/core\" does not match repository \"kandelo-dev/homebrew-tap-core\""
            ),
            "unexpected validation errors: {:#?}",
            report.errors,
        );
    }

    #[test]
    fn rejects_missing_dependency_closure() {
        let mut fixture = Fixture::new();
        set(
            &mut fixture.metadata,
            "/packages/0/dependencies",
            json!([{ "name": "zlib", "version": "1.3.1" }]),
        );
        set(
            &mut fixture.formula,
            "/dependencies",
            json!([{ "name": "zlib", "version": "1.3.1" }]),
        );
        fixture.write();
        let report = fixture.validate();
        assert!(report.errors.join("\n").contains("dependency \"zlib\""));
    }

    #[test]
    fn rejects_formula_sidecar_drift() {
        let mut fixture = Fixture::new();
        set(&mut fixture.formula, "/version", json!("2.12.2"));
        fixture.write();
        let report = fixture.validate();
        assert!(report.errors.join("\n").contains("/version does not match"));
    }

    #[test]
    fn rejects_duplicate_link_targets() {
        let mut fixture = Fixture::new();
        set(
            &mut fixture.link,
            "/links",
            json!([
                {
                    "type": "symlink",
                    "source": "Cellar/what/15.0.0/bin/what",
                    "target": "bin/what"
                },
                {
                    "type": "symlink",
                    "source": "Cellar/what/15.0.0/bin/what-alias",
                    "target": "bin/what"
                }
            ]),
        );
        fixture.write();
        let report = fixture.validate();
        assert!(report.errors.join("\n").contains("duplicate link target"));
    }

    #[test]
    fn accepts_posix_bracket_utility_paths() {
        let mut fixture = Fixture::new();
        set(
            &mut fixture.link,
            "/links/0/source",
            json!("Cellar/what/15.0.0/bin/["),
        );
        set(&mut fixture.link, "/links/0/target", json!("bin/["));
        fixture.write();

        let report = fixture.validate();
        assert_eq!(report.errors, Vec::<String>::new());
    }

    #[test]
    fn accepts_upstream_filenames_with_commas() {
        let mut fixture = Fixture::new();
        let tex_path = concat!(
            "share/texmf-dist/doc/latex/binarytree/examples/",
            "btree-5_up_0,0,0_3729359_7458719_655360_0.7_0.7_",
            "-lrr-x--_-llrr-x--_-rll-x--_-rrll-x--.pdf"
        );
        set(
            &mut fixture.link,
            "/links/0/source",
            json!(format!("Cellar/what/15.0.0/{tex_path}")),
        );
        set(&mut fixture.link, "/links/0/target", json!(tex_path));
        fixture.write();

        let report = fixture.validate();
        assert_eq!(report.errors, Vec::<String>::new());
    }

    #[test]
    fn rejects_dotdot_link_path() {
        let mut fixture = Fixture::new();
        set(&mut fixture.link, "/links/0/target", json!("../bin/what"));
        fixture.write();
        let report = fixture.validate();
        assert!(report.errors.join("\n").contains("not path-safe"));
    }

    #[test]
    fn rejects_link_manifest_bottle_sha_drift() {
        let mut fixture = Fixture::new();
        set(
            &mut fixture.link,
            "/bottle/sha256",
            json!("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
        );
        fixture.write();
        let report = fixture.validate();
        assert!(
            report
                .errors
                .join("\n")
                .contains("link manifest /bottle/sha256 does not match")
        );
    }

    #[test]
    fn rejects_formula_sha_mismatch() {
        let mut fixture = Fixture::new();
        set(
            &mut fixture.metadata,
            "/packages/0/bottles/0/built_from/formula_sha256",
            json!("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
        );
        set(
            &mut fixture.formula,
            "/bottles/0/built_from/formula_sha256",
            json!("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
        );
        fixture.write();
        let report = fixture.validate();
        assert!(report.errors.join("\n").contains("formula_sha256"));
    }

    #[test]
    fn rejects_formula_bottle_tag_missing_from_metadata() {
        let fixture = Fixture::new();
        let path = fixture.tap_root.join("Formula/what.rb");
        let source = fs::read_to_string(&path).unwrap();
        write_text(
            &path,
            &source.replace(
                "  end\nend\n",
                concat!(
                    "    sha256 cellar: :any_skip_relocation, wasm64_kandelo: ",
                    "\"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\"\n",
                    "  end\nend\n",
                ),
            ),
        );

        let report = fixture.validate();
        assert!(
            report
                .errors
                .join("\n")
                .contains("Formula bottle tags")
        );
    }

    #[test]
    fn rejects_formula_bottle_digest_drift() {
        let fixture = Fixture::new();
        let path = fixture.tap_root.join("Formula/what.rb");
        let source = fs::read_to_string(&path).unwrap();
        write_text(
            &path,
            &source.replace(
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            ),
        );

        let report = fixture.validate();
        assert!(
            report
                .errors
                .join("\n")
                .contains("do not match metadata bottles")
        );
    }

    #[test]
    fn rejects_success_bottle_url_outside_repository_package_root() {
        let mut fixture = Fixture::new();
        let sha256 = string_at(&fixture.metadata, "/packages/0/bottles/0/sha256")
            .unwrap()
            .to_string();
        let old_root_url = repository_bottle_url("kandelo-dev/tap-core", "what", &sha256);
        set(
            &mut fixture.metadata,
            "/packages/0/bottles/0/url",
            json!(old_root_url.clone()),
        );
        set(
            &mut fixture.formula,
            "/bottles/0/url",
            json!(old_root_url.clone()),
        );
        set(
            &mut fixture.link,
            "/bottle/url",
            json!(old_root_url.clone()),
        );
        set(&mut fixture.provenance, "/bottle/url", json!(old_root_url));
        fixture.write();

        let report = fixture.validate();
        assert!(
            report.errors.join("\n").contains(
                "success bottle URL \"https://ghcr.io/v2/kandelo-dev/tap-core/what/blobs/sha256:"
            ),
            "unexpected validation errors: {:#?}",
            report.errors,
        );
        assert!(
            report
                .errors
                .join("\n")
                .contains("does not match tap repository package URL"),
            "unexpected validation errors: {:#?}",
            report.errors,
        );
    }

    #[test]
    fn rejects_fallback_bottle_url_outside_repository_package_root() {
        let mut fixture = Fixture::new();
        let success = fixture.metadata["packages"][0]["bottles"][0].clone();
        let fallback_sha256 = success["sha256"].clone();
        let fallback = json!({
            "arch": success["arch"].clone(),
            "bottle_tag": success["bottle_tag"].clone(),
            "kandelo_abi": success["kandelo_abi"].clone(),
            "cellar": success["cellar"].clone(),
            "prefix": success["prefix"].clone(),
            "runtime_support": success["runtime_support"].clone(),
            "browser_compatible": success["browser_compatible"].clone(),
            "fork_instrumentation": success["fork_instrumentation"].clone(),
            "status": "failed",
            "built_by": success["built_by"].clone(),
            "built_from": success["built_from"].clone(),
            "error": "build failed",
            "last_attempt": "2026-06-28T00:00:00Z",
            "last_attempt_by": "https://example.invalid/kandelo-dev/homebrew-tap-core/actions/runs/43",
            "fallback_url": repository_bottle_url(
                "kandelo-dev/tap-core",
                "what",
                fallback_sha256.as_str().unwrap(),
            ),
            "fallback_sha256": fallback_sha256,
            "fallback_bytes": success["bytes"].clone(),
            "fallback_cache_key_sha": success["cache_key_sha"].clone(),
            "fallback_link_manifest": success["link_manifest"].clone(),
            "fallback_built_at": "2026-06-27T00:00:00Z",
        });
        set(
            &mut fixture.metadata,
            "/packages/0/bottles/0",
            fallback.clone(),
        );
        set(&mut fixture.formula, "/bottles/0", fallback);
        fixture.write();

        let report = fixture.validate();
        assert!(
            report.errors.join("\n").contains(
                "fallback bottle URL \"https://ghcr.io/v2/kandelo-dev/tap-core/what/blobs/sha256:"
            ),
            "unexpected validation errors: {:#?}",
            report.errors,
        );
        assert!(
            report
                .errors
                .join("\n")
                .contains("does not match tap repository package URL"),
            "unexpected validation errors: {:#?}",
            report.errors,
        );
    }

    #[test]
    fn rejects_formula_bottle_root_drift() {
        let fixture = Fixture::new();
        let path = fixture.tap_root.join("Formula/what.rb");
        let source = fs::read_to_string(&path).unwrap();
        write_text(
            &path,
            &source.replace(
                "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core",
                "https://ghcr.io/v2/attacker/wrong-tap",
            ),
        );

        let report = fixture.validate();
        assert!(
            report
                .errors
                .join("\n")
                .contains("does not match the tap repository package root")
        );
    }

    #[test]
    fn rejects_extra_noncanonical_formula_bottle_call() {
        let fixture = Fixture::new();
        let path = fixture.tap_root.join("Formula/what.rb");
        let source = fs::read_to_string(&path).unwrap();
        let source_without_class_end = source.strip_suffix("end\n").unwrap();
        write_text(
            &path,
            &format!(
                "{source_without_class_end}  bottle {{ system \"false\" }}\nend\n"
            ),
        );

        let report = fixture.validate();
        assert!(
            report
                .errors
                .join("\n")
                .contains("bottle block outside the direct Formula class body"),
            "unexpected validation errors: {:#?}",
            report.errors,
        );
    }
}

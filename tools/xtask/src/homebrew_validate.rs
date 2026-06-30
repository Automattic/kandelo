use jsonschema::JSONSchema;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use crate::repo_root;

const DEFAULT_METADATA_REL: &str = "Kandelo/metadata.json";
const SCHEMA_ROOT_REL: &str = "homebrew/kandelo-homebrew/Kandelo";

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
}

impl Options {
    fn parse(args: Vec<String>) -> Result<Self, String> {
        let mut tap_root: Option<PathBuf> = None;
        let mut metadata: Option<PathBuf> = None;
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
        })
    }
}

fn usage() -> String {
    "usage: xtask homebrew-validate --tap-root <tap-root> [--metadata <path>]".to_string()
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
    let mut validator = Validator {
        options,
        schemas,
        report: ValidationReport::default(),
    };
    validator.validate_metadata()?;
    Ok(validator.report)
}

struct Validator<'a> {
    options: &'a Options,
    schemas: Schemas,
    report: ValidationReport,
}

impl Validator<'_> {
    fn validate_metadata(&mut self) -> Result<(), String> {
        let metadata = load_json(&self.options.metadata_path)?;
        let schema_errors = collect_schema_errors(&self.schemas.metadata, &metadata);
        self.add_schema_errors("metadata", schema_errors);

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
        for package in packages {
            self.validate_dependency_closure(package, &package_index);
            self.validate_package(package, &metadata);
        }

        Ok(())
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
        self.validate_formula_file(package_name, package, &formula_metadata);
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

    fn validate_formula_file(&mut self, package_name: &str, package: &Value, formula: &Value) {
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
        let actual_sha = match sha256_file(&formula_path) {
            Ok(sha) => sha,
            Err(e) => {
                self.err(format!(
                    "package {package_name}: cannot hash formula_path {:?}: {e}",
                    formula_path_rel
                ));
                return;
            }
        };

        for (label, value) in [("metadata", package), ("formula", formula)] {
            let Some(bottles) = value.get("bottles").and_then(Value::as_array) else {
                continue;
            };
            for (i, bottle) in bottles.iter().enumerate() {
                if let Some(recorded_sha) = string_at(bottle, "/built_from/formula_sha256") {
                    if recorded_sha != actual_sha {
                        self.err(format!(
                            "{label} package {package_name} bottle #{i}: formula_sha256 {recorded_sha:?} does not match actual {actual_sha}"
                        ));
                    }
                }
            }
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
        let mut seen_arches = BTreeSet::new();
        for (index, bottle) in bottles.iter().enumerate() {
            self.report.bottles += 1;
            let bottle_label = format!("package {package_name} bottle #{index}");
            self.validate_bottle_identity(&bottle_label, bottle, top_abi);

            if let Some(arch) = string_at(bottle, "/arch") {
                if !seen_arches.insert(arch.to_string()) {
                    self.err(format!("{bottle_label}: duplicate bottle arch {arch:?}"));
                }
            }

            if string_at(bottle, "/status") == Some("success") {
                self.validate_success_link_manifest(&bottle_label, package, bottle);
                self.validate_success_provenance_report(&bottle_label, package, bottle, metadata);
            } else {
                self.validate_fallback_link_manifest(&bottle_label, bottle);
            }
        }

        if package.pointer("/bottles") != formula.pointer("/bottles") {
            self.err(format!(
                "formula sidecar {package_name}: bottles array does not match metadata package"
            ));
        }
    }

    fn validate_bottle_identity(&mut self, label: &str, bottle: &Value, top_abi: Option<u64>) {
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

        self.validate_runtime_status(label, bottle);
    }

    fn validate_runtime_status(&mut self, label: &str, bottle: &Value) {
        let runtime_support = bottle
            .get("runtime_support")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect::<BTreeSet<_>>()
            })
            .unwrap_or_default();

        let runtime_status = bottle.get("runtime_status").and_then(Value::as_object);
        if runtime_support.is_empty() && runtime_status.is_none() {
            self.err(format!(
                "{label}: empty runtime_support requires runtime_status for node and browser"
            ));
            return;
        }

        let mut has_artifact_policy_failures = false;
        if let Some(statuses) = runtime_status {
            for host in statuses.keys() {
                if host != "node" && host != "browser" {
                    self.err(format!(
                        "{label}: runtime_status host {host:?} is not supported"
                    ));
                }
            }
        }

        for host in ["node", "browser"] {
            let supports_host = runtime_support.contains(host);
            let Some(status_value) = runtime_status.and_then(|statuses| statuses.get(host)) else {
                if runtime_support.is_empty() {
                    self.err(format!(
                        "{label}: empty runtime_support requires runtime_status.{host}"
                    ));
                }
                continue;
            };
            let Some(status) = status_value.get("status").and_then(Value::as_str) else {
                continue;
            };
            match status {
                "supported" => {
                    if !supports_host {
                        self.err(format!(
                            "{label}: runtime_status.{host}=supported requires runtime_support to include {host}"
                        ));
                    }
                }
                "unsupported" | "failed" | "not-validated" => {
                    if supports_host {
                        self.err(format!(
                            "{label}: runtime_status.{host}={status} is incompatible with runtime_support containing {host}"
                        ));
                    }
                }
                other => self.err(format!(
                    "{label}: runtime_status.{host}.status {other:?} is invalid"
                )),
            }

            if status == "unsupported" {
                if string_at(status_value, "/reason_code")
                    .unwrap_or("")
                    .is_empty()
                {
                    self.err(format!(
                        "{label}: runtime_status.{host}=unsupported requires reason_code"
                    ));
                }
                if string_at(status_value, "/reason").unwrap_or("").is_empty() {
                    self.err(format!(
                        "{label}: runtime_status.{host}=unsupported requires reason"
                    ));
                }
            }

            if let Some(failures) = status_value
                .get("artifact_policy_failures")
                .and_then(Value::as_array)
            {
                if !failures.is_empty() {
                    has_artifact_policy_failures = true;
                }
                for (index, failure) in failures.iter().enumerate() {
                    let failure_label =
                        format!("{label}: runtime_status.{host}.artifact_policy_failures #{index}");
                    let path = string_at(failure, "/path").unwrap_or("");
                    if !is_safe_relative_path(path) {
                        self.err(format!("{failure_label}: path {path:?} is not path-safe"));
                    }
                    match failure.get("failures").and_then(Value::as_array) {
                        Some(items) if !items.is_empty() => {}
                        _ => self.err(format!("{failure_label}: failures must not be empty")),
                    }
                }
            }
        }

        if has_artifact_policy_failures && !runtime_support.is_empty() {
            self.err(format!(
                "{label}: artifact_policy_failures are incompatible with non-empty runtime_support"
            ));
        }
    }

    fn validate_success_link_manifest(&mut self, label: &str, package: &Value, bottle: &Value) {
        let link = match self.load_tap_json(label, string_at(bottle, "/link_manifest")) {
            Some(value) => value,
            None => return,
        };
        self.report.link_manifests += 1;
        let schema_errors = collect_schema_errors(&self.schemas.link_manifest, &link);
        self.add_schema_errors(label, schema_errors);

        for (link_ptr, bottle_ptr) in [
            ("/package", "/name"),
            ("/version", "/version"),
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

        for (link_ptr, bottle_ptr) in [
            ("/bottle/url", "/url"),
            ("/bottle/sha256", "/sha256"),
            ("/bottle/bytes", "/bytes"),
            ("/bottle/cache_key_sha", "/cache_key_sha"),
        ] {
            if link.pointer(link_ptr) != bottle.pointer(bottle_ptr) {
                self.err(format!(
                    "{label}: link manifest {link_ptr} does not match metadata {bottle_ptr}"
                ));
            }
        }

        self.validate_guest_paths(label, &link);
        self.validate_links(label, &link);
        self.validate_receipts(label, &link);
    }

    fn validate_success_provenance_report(
        &mut self,
        label: &str,
        package: &Value,
        bottle: &Value,
        metadata: &Value,
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
        for (provenance_ptr, metadata_ptr) in [
            ("/repositories/kandelo_repository", "/kandelo_repository"),
            ("/repositories/kandelo_commit", "/kandelo_commit"),
            ("/repositories/tap_repository", "/tap_repository"),
            ("/repositories/tap_commit", "/tap_commit"),
        ] {
            if provenance.pointer(provenance_ptr) != metadata.pointer(metadata_ptr) {
                self.err(format!(
                    "{label}: provenance {provenance_ptr} does not match metadata {metadata_ptr}"
                ));
            }
        }

        if let Some(formula_path) = string_at(package, "/formula_path") {
            let expected = self
                .resolve_tap_path(label, formula_path)
                .and_then(|path| sha256_file(&path).ok());
            if expected.as_deref() != string_at(&provenance, "/formula/sha256") {
                self.err(format!(
                    "{label}: provenance /formula/sha256 does not match formula_path hash"
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

    fn validate_fallback_link_manifest(&mut self, label: &str, bottle: &Value) {
        let Some(rel) = string_at(bottle, "/fallback_link_manifest") else {
            return;
        };
        let Some(path) = self.resolve_tap_path(label, rel) else {
            return;
        };
        if !path.is_file() {
            self.err(format!(
                "{label}: fallback_link_manifest {rel:?} does not exist"
            ));
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
        Some(self.options.tap_root.join(rel))
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
            let formula_text = "class Hello < Formula\n  desc \"Fixture\"\nend\n";
            let formula_sha = {
                let mut hasher = Sha256::new();
                hasher.update(formula_text.as_bytes());
                format!("{:x}", hasher.finalize())
            };

            write_text(&tap_root.join("Formula/hello.rb"), formula_text);

            let mut metadata =
                load_repo_json("homebrew/kandelo-homebrew/Kandelo/examples/metadata.json");
            let mut formula =
                load_repo_json("homebrew/kandelo-homebrew/Kandelo/examples/formula/hello.json");
            let link = load_repo_json(
                "homebrew/kandelo-homebrew/Kandelo/examples/link/hello-2.12.1-rebuild0-wasm32.json",
            );
            let provenance = load_repo_json(
                "homebrew/kandelo-homebrew/Kandelo/examples/reports/hello-2.12.1-rebuild0-wasm32.provenance.json",
            );

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
                &self.tap_root.join("Kandelo/formula/hello.json"),
                &self.formula,
            );
            write_json(
                &self
                    .tap_root
                    .join("Kandelo/link/hello-2.12.1-rebuild0-wasm32.json"),
                &self.link,
            );

            let mut provenance = self.provenance.clone();
            let formula_sha = sha256_file(&self.tap_root.join("Formula/hello.rb")).unwrap();
            set(&mut provenance, "/formula/sha256", json!(formula_sha));
            set(
                &mut provenance,
                "/metadata/metadata_json/sha256",
                json!(sha256_file(&self.tap_root.join("Kandelo/metadata.json")).unwrap()),
            );
            set(
                &mut provenance,
                "/metadata/formula_json/sha256",
                json!(sha256_file(&self.tap_root.join("Kandelo/formula/hello.json")).unwrap()),
            );
            set(
                &mut provenance,
                "/metadata/link_manifest_json/sha256",
                json!(sha256_file(
                    &self
                        .tap_root
                        .join("Kandelo/link/hello-2.12.1-rebuild0-wasm32.json")
                )
                .unwrap()),
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
                    .join("Kandelo/reports/hello-2.12.1-rebuild0-wasm32.provenance.json"),
                &provenance,
            );
        }

        fn validate(&self) -> ValidationReport {
            validate(&Options {
                tap_root: self.tap_root.clone(),
                metadata_path: self.tap_root.join(DEFAULT_METADATA_REL),
            })
            .unwrap()
        }
    }

    fn load_repo_json(rel: &str) -> Value {
        load_json(&repo_root().join(rel)).unwrap()
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
                    "source": "Cellar/hello/2.12.1/bin/hello",
                    "target": "bin/hello"
                },
                {
                    "type": "symlink",
                    "source": "Cellar/hello/2.12.1/bin/hello-alias",
                    "target": "bin/hello"
                }
            ]),
        );
        fixture.write();
        let report = fixture.validate();
        assert!(report.errors.join("\n").contains("duplicate link target"));
    }

    #[test]
    fn rejects_dotdot_link_path() {
        let mut fixture = Fixture::new();
        set(&mut fixture.link, "/links/0/target", json!("../bin/hello"));
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
        assert!(report
            .errors
            .join("\n")
            .contains("link manifest /bottle/sha256 does not match"));
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
}

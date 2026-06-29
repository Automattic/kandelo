use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::path::{Path, PathBuf};

const METADATA_REL: &str = "Kandelo/metadata.json";
const ZERO_SHA256: &str = "0000000000000000000000000000000000000000000000000000000000000000";

pub fn run(args: Vec<String>) -> Result<(), String> {
    let options = Options::parse(args)?;
    let input = read_manifest(&options.input_path)?;
    let previous = match &options.previous_metadata_path {
        Some(path) => Some(load_json(path)?),
        None => None,
    };
    let summary = Generator {
        options: &options,
        input,
        previous: previous.as_ref(),
        pending_provenance: Vec::new(),
    }
    .generate()?;

    println!(
        "homebrew-sidecars: wrote packages={}, bottles={}, link_manifests={}, provenance_reports={} to {}",
        summary.packages,
        summary.bottles,
        summary.link_manifests,
        summary.provenance_reports,
        options.tap_root.display()
    );
    Ok(())
}

#[derive(Debug, Clone)]
struct Options {
    tap_root: PathBuf,
    input_path: PathBuf,
    previous_metadata_path: Option<PathBuf>,
}

impl Options {
    fn parse(args: Vec<String>) -> Result<Self, String> {
        let mut tap_root: Option<PathBuf> = None;
        let mut input_path: Option<PathBuf> = None;
        let mut previous_metadata_path: Option<PathBuf> = None;
        let mut it = args.into_iter();
        while let Some(arg) = it.next() {
            match arg.as_str() {
                "--tap-root" => {
                    tap_root = Some(PathBuf::from(it.next().ok_or_else(|| {
                        "homebrew-sidecars: --tap-root requires a path".to_string()
                    })?));
                }
                "--input" => {
                    input_path = Some(PathBuf::from(it.next().ok_or_else(|| {
                        "homebrew-sidecars: --input requires a path".to_string()
                    })?));
                }
                "--previous-metadata" => {
                    previous_metadata_path = Some(PathBuf::from(it.next().ok_or_else(|| {
                        "homebrew-sidecars: --previous-metadata requires a path".to_string()
                    })?));
                }
                "-h" | "--help" => return Err(usage()),
                other => {
                    return Err(format!(
                        "homebrew-sidecars: unexpected argument {other:?}\n{}",
                        usage()
                    ));
                }
            }
        }

        Ok(Self {
            tap_root: tap_root.ok_or_else(usage)?,
            input_path: input_path.ok_or_else(usage)?,
            previous_metadata_path,
        })
    }
}

fn usage() -> String {
    "usage: xtask homebrew-sidecars --tap-root <tap-root> --input <sidecars-input.json> [--previous-metadata <metadata.json>]".to_string()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SidecarInput {
    schema: u64,
    tap_repository: String,
    tap_name: String,
    tap_commit: String,
    kandelo_repository: String,
    kandelo_commit: String,
    kandelo_abi: u64,
    release_tag: String,
    generated_at: String,
    generator: String,
    packages: Vec<PackageInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PackageInput {
    name: String,
    #[serde(default)]
    full_name: Option<String>,
    version: String,
    formula_revision: u64,
    bottle_rebuild: u64,
    formula_path: String,
    #[serde(default)]
    dependencies: Vec<DependencyInput>,
    bottles: Vec<BottleInput>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct DependencyInput {
    name: String,
    #[serde(default)]
    version: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct BottleInput {
    arch: String,
    #[serde(default)]
    bottle_tag: Option<String>,
    cellar: String,
    prefix: String,
    runtime_support: Vec<String>,
    browser_compatible: bool,
    fork_instrumentation: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    built_by: Option<String>,
    #[serde(default)]
    built_at: Option<String>,
    #[serde(default)]
    bottle_file: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    cache_key_sha: Option<String>,
    #[serde(default)]
    payload_root: Option<String>,
    #[serde(default)]
    keg: Option<String>,
    #[serde(default)]
    links: Vec<LinkInput>,
    #[serde(default)]
    receipts: Vec<String>,
    #[serde(default)]
    env: Option<Value>,
    #[serde(default)]
    build: Option<BuildInput>,
    #[serde(default)]
    validation: Option<Value>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    last_attempt: Option<String>,
    #[serde(default)]
    last_attempt_by: Option<String>,
    #[serde(default)]
    queued_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct LinkInput {
    #[serde(rename = "type")]
    kind: String,
    source: String,
    target: String,
    #[serde(default)]
    mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct BuildInput {
    github_run: String,
    job: String,
    runner_os: String,
    brew_version: String,
    dev_shell: String,
    sdk_fingerprint: String,
    sysroot_fingerprint: String,
}

#[derive(Default, Debug)]
struct Summary {
    packages: usize,
    bottles: usize,
    link_manifests: usize,
    provenance_reports: usize,
}

struct Generator<'a> {
    options: &'a Options,
    input: SidecarInput,
    previous: Option<&'a Value>,
    pending_provenance: Vec<PendingProvenance>,
}

#[derive(Debug)]
struct PendingProvenance {
    path: String,
    formula_sidecar_path: String,
    link_manifest_path: String,
    value: Value,
}

impl Generator<'_> {
    fn generate(mut self) -> Result<Summary, String> {
        if self.input.schema != 1 {
            return Err(format!(
                "sidecars input schema must be 1, got {}",
                self.input.schema
            ));
        }

        let mut packages = self.input.packages.clone();
        packages.sort_by(|a, b| a.name.cmp(&b.name));

        let mut formula_outputs = Vec::new();
        let mut link_outputs = Vec::new();
        let mut package_values = Vec::new();
        let mut summary = Summary::default();

        for package in &packages {
            let package_output =
                self.generate_package(package, &mut formula_outputs, &mut link_outputs)?;
            summary.packages += 1;
            summary.bottles += package_output.bottles;
            summary.link_manifests += package_output.link_manifests;
            summary.provenance_reports += package_output.provenance_reports;
            package_values.push(package_output.metadata_value);
        }

        let metadata = json!({
            "schema": 1,
            "tap_repository": self.input.tap_repository,
            "tap_name": self.input.tap_name,
            "tap_commit": self.input.tap_commit,
            "kandelo_repository": self.input.kandelo_repository,
            "kandelo_commit": self.input.kandelo_commit,
            "kandelo_abi": self.input.kandelo_abi,
            "release_tag": self.input.release_tag,
            "generated_at": self.input.generated_at,
            "generator": self.input.generator,
            "packages": package_values,
        });

        let metadata_sha = write_json_hashed(&self.options.tap_root.join(METADATA_REL), &metadata)?;

        let mut json_hashes = BTreeMap::new();
        json_hashes.insert(METADATA_REL.to_string(), metadata_sha);

        for (rel, value) in formula_outputs {
            let sha = write_json_hashed(&self.options.tap_root.join(&rel), &value)?;
            json_hashes.insert(rel, sha);
        }
        for (rel, value) in link_outputs {
            let sha = write_json_hashed(&self.options.tap_root.join(&rel), &value)?;
            json_hashes.insert(rel, sha);
        }

        for mut provenance in self.pending_provenance {
            let metadata_sha = required_hash(&json_hashes, METADATA_REL)?;
            let formula_sha = required_hash(&json_hashes, &provenance.formula_sidecar_path)?;
            let link_sha = required_hash(&json_hashes, &provenance.link_manifest_path)?;
            provenance.value["metadata"] = json!({
                "metadata_json": {
                    "path": METADATA_REL,
                    "sha256": metadata_sha,
                },
                "formula_json": {
                    "path": provenance.formula_sidecar_path,
                    "sha256": formula_sha,
                },
                "link_manifest_json": {
                    "path": provenance.link_manifest_path,
                    "sha256": link_sha,
                },
                "provenance_json": {
                    "path": provenance.path,
                    "sha256": ZERO_SHA256,
                },
            });
            let normalized_sha = json_sha256(&provenance.value)?;
            set_pointer(
                &mut provenance.value,
                "/metadata/provenance_json/sha256",
                json!(normalized_sha),
            )?;
            write_json(
                &self.options.tap_root.join(&provenance.path),
                &provenance.value,
            )?;
        }

        Ok(summary)
    }

    fn generate_package(
        &mut self,
        package: &PackageInput,
        formula_outputs: &mut Vec<(String, Value)>,
        link_outputs: &mut Vec<(String, Value)>,
    ) -> Result<PackageOutput, String> {
        require_relative_path(&package.formula_path, "formula_path")?;
        let formula_sha = sha256_file(&self.options.tap_root.join(&package.formula_path))?;
        let formula_sidecar_path = format!("Kandelo/formula/{}.json", package.name);
        require_relative_path(&formula_sidecar_path, "formula sidecar path")?;

        let mut bottles = package.bottles.clone();
        bottles.sort_by(|a, b| a.arch.cmp(&b.arch));
        let mut bottle_values = Vec::new();
        let mut link_manifests = 0;
        let mut provenance_reports = 0;

        for bottle in &bottles {
            let bottle_value = self.generate_bottle(
                package,
                bottle,
                &formula_sha,
                &formula_sidecar_path,
                link_outputs,
            )?;
            if bottle_status(bottle) == "success" {
                link_manifests += 1;
                provenance_reports += 1;
            }
            bottle_values.push(bottle_value);
        }

        let dependencies = dependencies_json(&package.dependencies);
        let full_name = package
            .full_name
            .clone()
            .unwrap_or_else(|| format!("{}/{}", self.input.tap_name, package.name));

        let metadata_value = json!({
            "name": package.name,
            "full_name": full_name,
            "version": package.version,
            "formula_revision": package.formula_revision,
            "bottle_rebuild": package.bottle_rebuild,
            "formula_path": package.formula_path,
            "formula_metadata": formula_sidecar_path,
            "dependencies": dependencies,
            "bottles": bottle_values,
        });

        let formula_value = json!({
            "schema": 1,
            "tap_repository": self.input.tap_repository,
            "tap_name": self.input.tap_name,
            "tap_commit": self.input.tap_commit,
            "kandelo_abi": self.input.kandelo_abi,
            "source_metadata": METADATA_REL,
            "name": package.name,
            "full_name": full_name,
            "version": package.version,
            "formula_revision": package.formula_revision,
            "bottle_rebuild": package.bottle_rebuild,
            "formula_path": package.formula_path,
            "dependencies": dependencies_json(&package.dependencies),
            "bottles": metadata_value["bottles"].clone(),
        });
        formula_outputs.push((formula_sidecar_path, formula_value));

        Ok(PackageOutput {
            metadata_value,
            bottles: bottles.len(),
            link_manifests,
            provenance_reports,
        })
    }

    fn generate_bottle(
        &mut self,
        package: &PackageInput,
        bottle: &BottleInput,
        formula_sha: &str,
        formula_sidecar_path: &str,
        link_outputs: &mut Vec<(String, Value)>,
    ) -> Result<Value, String> {
        let status = bottle_status(bottle);
        let bottle_tag = bottle
            .bottle_tag
            .clone()
            .unwrap_or_else(|| default_bottle_tag(&bottle.arch).to_string());
        let built_from = json!({
            "kandelo_repository": self.input.kandelo_repository,
            "kandelo_commit": self.input.kandelo_commit,
            "tap_repository": self.input.tap_repository,
            "tap_commit": self.input.tap_commit,
            "formula_sha256": formula_sha,
        });
        let mut output = json!({
            "arch": bottle.arch,
            "bottle_tag": bottle_tag,
            "kandelo_abi": self.input.kandelo_abi,
            "cellar": bottle.cellar,
            "prefix": bottle.prefix,
            "runtime_support": bottle.runtime_support,
            "browser_compatible": bottle.browser_compatible,
            "fork_instrumentation": bottle.fork_instrumentation,
            "status": status,
            "built_by": required_field(&bottle.built_by, package, bottle, "built_by")?,
            "built_from": built_from,
        });
        if let Some(built_at) = &bottle.built_at {
            output["built_at"] = json!(built_at);
        }
        if let Some(queued_at) = &bottle.queued_at {
            output["queued_at"] = json!(queued_at);
        }

        if status == "success" {
            self.add_success_bottle(
                package,
                bottle,
                formula_sha,
                formula_sidecar_path,
                &mut output,
                link_outputs,
            )?;
        } else {
            self.add_non_success_fields(package, bottle, &mut output)?;
        }

        Ok(output)
    }

    fn add_success_bottle(
        &mut self,
        package: &PackageInput,
        bottle: &BottleInput,
        formula_sha: &str,
        formula_sidecar_path: &str,
        output: &mut Value,
        link_outputs: &mut Vec<(String, Value)>,
    ) -> Result<(), String> {
        let url = required_field(&bottle.url, package, bottle, "url")?;
        let cache_key_sha =
            required_field(&bottle.cache_key_sha, package, bottle, "cache_key_sha")?;
        let bottle_file = required_field(&bottle.bottle_file, package, bottle, "bottle_file")?;
        let payload_root = required_field(&bottle.payload_root, package, bottle, "payload_root")?;
        let build = bottle.build.as_ref().ok_or_else(|| {
            bottle_error(package, bottle, "success bottle requires build evidence")
        })?;
        let validation = bottle.validation.clone().ok_or_else(|| {
            bottle_error(
                package,
                bottle,
                "success bottle requires validation evidence",
            )
        })?;
        if bottle.receipts.is_empty() {
            return Err(bottle_error(
                package,
                bottle,
                "success bottle requires at least one receipt path",
            ));
        }

        let bottle_path = self.resolve_input_relative(bottle_file);
        verify_bottle_payload(package, bottle, &bottle_path, payload_root)?;
        let (bottle_sha, bottle_bytes) = sha256_file_and_len(&bottle_path)?;
        let link_path = link_manifest_path(package, &bottle.arch);
        let provenance_path = provenance_path(package, &bottle.arch);
        require_relative_path(&link_path, "link manifest path")?;
        require_relative_path(&provenance_path, "provenance report path")?;

        output["url"] = json!(url);
        output["sha256"] = json!(bottle_sha);
        output["bytes"] = json!(bottle_bytes);
        output["cache_key_sha"] = json!(cache_key_sha);
        output["link_manifest"] = json!(link_path);

        let keg = bottle
            .keg
            .clone()
            .unwrap_or_else(|| format!("{}/{}/{}", bottle.cellar, package.name, package.version));
        let link_manifest = json!({
            "schema": 1,
            "package": package.name,
            "version": package.version,
            "arch": bottle.arch,
            "kandelo_abi": self.input.kandelo_abi,
            "prefix": bottle.prefix,
            "cellar": bottle.cellar,
            "keg": keg,
            "bottle": {
                "url": url,
                "sha256": bottle_sha,
                "bytes": bottle_bytes,
                "cache_key_sha": cache_key_sha,
                "payload_root": payload_root,
            },
            "links": links_json(&bottle.links),
            "receipts": bottle.receipts,
            "env": bottle.env.clone().unwrap_or_else(|| json!({})),
        });
        link_outputs.push((link_path.clone(), link_manifest));

        let provenance = json!({
            "schema": 1,
            "subject": {
                "package": package.name,
                "version": package.version,
                "arch": bottle.arch,
                "bottle_rebuild": package.bottle_rebuild,
                "kandelo_abi": self.input.kandelo_abi,
            },
            "repositories": {
                "kandelo_repository": self.input.kandelo_repository,
                "kandelo_commit": self.input.kandelo_commit,
                "tap_repository": self.input.tap_repository,
                "tap_commit": self.input.tap_commit,
            },
            "formula": {
                "path": package.formula_path,
                "sha256": formula_sha,
            },
            "bottle": {
                "url": url,
                "sha256": output["sha256"].clone(),
                "bytes": output["bytes"].clone(),
                "cache_key_sha": output["cache_key_sha"].clone(),
                "bottle_tag": output["bottle_tag"].clone(),
                "cellar": bottle.cellar,
                "prefix": bottle.prefix,
            },
            "build": {
                "github_run": build.github_run,
                "job": build.job,
                "runner_os": build.runner_os,
                "brew_version": build.brew_version,
                "dev_shell": build.dev_shell,
                "sdk_fingerprint": build.sdk_fingerprint,
                "sysroot_fingerprint": build.sysroot_fingerprint,
            },
            "validation": validation,
            "metadata": {
                "metadata_json": { "path": METADATA_REL, "sha256": ZERO_SHA256 },
                "formula_json": { "path": formula_sidecar_path, "sha256": ZERO_SHA256 },
                "link_manifest_json": { "path": link_path, "sha256": ZERO_SHA256 },
                "provenance_json": { "path": provenance_path, "sha256": ZERO_SHA256 },
            },
        });
        self.pending_provenance.push(PendingProvenance {
            path: provenance_path,
            formula_sidecar_path: formula_sidecar_path.to_string(),
            link_manifest_path: link_path,
            value: provenance,
        });

        Ok(())
    }

    fn add_non_success_fields(
        &self,
        package: &PackageInput,
        bottle: &BottleInput,
        output: &mut Value,
    ) -> Result<(), String> {
        if bottle_status(bottle) == "failed" {
            output["error"] = json!(required_field(&bottle.error, package, bottle, "error")?);
            output["last_attempt"] = json!(required_field(
                &bottle.last_attempt,
                package,
                bottle,
                "last_attempt"
            )?);
            output["last_attempt_by"] = json!(required_field(
                &bottle.last_attempt_by,
                package,
                bottle,
                "last_attempt_by"
            )?);
        }

        if let Some(fallback) = self.last_green_fallback(package, bottle) {
            let fallback_link_manifest = fallback
                .get("link_manifest")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    bottle_error(package, bottle, "previous success has no link_manifest")
                })?;
            self.copy_fallback_link_manifest(package, bottle, fallback_link_manifest)?;
            output["fallback_url"] = fallback["url"].clone();
            output["fallback_sha256"] = fallback["sha256"].clone();
            output["fallback_bytes"] = fallback["bytes"].clone();
            output["fallback_cache_key_sha"] = fallback["cache_key_sha"].clone();
            output["fallback_link_manifest"] = fallback["link_manifest"].clone();
            output["fallback_built_at"] =
                json!(fallback_built_at(self.previous, fallback).ok_or_else(|| {
                    bottle_error(
                        package,
                        bottle,
                        "previous success has no built_at or metadata generated_at for fallback_built_at",
                    )
                })?);
        }

        Ok(())
    }

    fn copy_fallback_link_manifest(
        &self,
        package: &PackageInput,
        bottle: &BottleInput,
        rel: &str,
    ) -> Result<(), String> {
        require_relative_path(rel, "fallback_link_manifest")?;
        let dest = self.options.tap_root.join(rel);
        if dest.is_file() {
            return Ok(());
        }
        let previous_tap_root = self.previous_tap_root().ok_or_else(|| {
            bottle_error(
                package,
                bottle,
                "cannot locate previous tap root from --previous-metadata for fallback copy",
            )
        })?;
        let src = previous_tap_root.join(rel);
        if !src.is_file() {
            return Err(bottle_error(
                package,
                bottle,
                &format!("fallback link manifest {} does not exist", src.display()),
            ));
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        fs::copy(&src, &dest)
            .map_err(|e| format!("copy {} to {}: {e}", src.display(), dest.display()))?;
        Ok(())
    }

    fn last_green_fallback(&self, package: &PackageInput, bottle: &BottleInput) -> Option<&Value> {
        let previous = self.previous?;
        if previous.pointer("/kandelo_abi")?.as_u64()? != self.input.kandelo_abi {
            return None;
        }
        let packages = previous.get("packages")?.as_array()?;
        let previous_package = packages.iter().find(|candidate| {
            candidate.get("name").and_then(Value::as_str) == Some(package.name.as_str())
                && candidate.get("version").and_then(Value::as_str)
                    == Some(package.version.as_str())
                && candidate.get("bottle_rebuild").and_then(Value::as_u64)
                    == Some(package.bottle_rebuild)
        })?;
        previous_package
            .get("bottles")?
            .as_array()?
            .iter()
            .find(|candidate| {
                candidate.get("arch").and_then(Value::as_str) == Some(bottle.arch.as_str())
                    && candidate.get("status").and_then(Value::as_str) == Some("success")
                    && candidate.get("url").is_some()
                    && candidate.get("sha256").is_some()
                    && candidate.get("bytes").is_some()
                    && candidate.get("cache_key_sha").is_some()
                    && candidate.get("link_manifest").is_some()
            })
    }

    fn resolve_input_relative(&self, path: &str) -> PathBuf {
        let path = PathBuf::from(path);
        if path.is_absolute() {
            path
        } else {
            self.options
                .input_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(path)
        }
    }

    fn previous_tap_root(&self) -> Option<PathBuf> {
        let metadata = self.options.previous_metadata_path.as_ref()?;
        let kandelo_dir = metadata.parent()?;
        if kandelo_dir.file_name().and_then(|name| name.to_str()) != Some("Kandelo") {
            return None;
        }
        Some(kandelo_dir.parent()?.to_path_buf())
    }
}

#[derive(Debug)]
struct PackageOutput {
    metadata_value: Value,
    bottles: usize,
    link_manifests: usize,
    provenance_reports: usize,
}

fn read_manifest(path: &Path) -> Result<SidecarInput, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))
}

fn load_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))
}

fn dependencies_json(dependencies: &[DependencyInput]) -> Value {
    let mut dependencies = dependencies.to_vec();
    dependencies.sort_by(|a, b| a.name.cmp(&b.name));
    Value::Array(
        dependencies
            .into_iter()
            .map(|dep| match dep.version {
                Some(version) => json!({ "name": dep.name, "version": version }),
                None => json!({ "name": dep.name }),
            })
            .collect(),
    )
}

fn links_json(links: &[LinkInput]) -> Value {
    Value::Array(
        links
            .iter()
            .map(|link| {
                let mut value = json!({
                    "type": link.kind,
                    "source": link.source,
                    "target": link.target,
                });
                if let Some(mode) = &link.mode {
                    value["mode"] = json!(mode);
                }
                value
            })
            .collect(),
    )
}

fn bottle_status(bottle: &BottleInput) -> &str {
    bottle.status.as_deref().unwrap_or("success")
}

fn default_bottle_tag(arch: &str) -> &str {
    match arch {
        "wasm64" => "wasm64_kandelo",
        _ => "wasm32_kandelo",
    }
}

fn link_manifest_path(package: &PackageInput, arch: &str) -> String {
    format!(
        "Kandelo/link/{}-{}-rebuild{}-{}.json",
        package.name, package.version, package.bottle_rebuild, arch
    )
}

fn provenance_path(package: &PackageInput, arch: &str) -> String {
    format!(
        "Kandelo/reports/{}-{}-rebuild{}-{}.provenance.json",
        package.name, package.version, package.bottle_rebuild, arch
    )
}

fn required_field<'a>(
    value: &'a Option<String>,
    package: &PackageInput,
    bottle: &BottleInput,
    field: &str,
) -> Result<&'a str, String> {
    value
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| bottle_error(package, bottle, &format!("{field} is required")))
}

fn bottle_error(package: &PackageInput, bottle: &BottleInput, message: &str) -> String {
    format!(
        "package {} {} bottle {}: {message}",
        package.name, package.version, bottle.arch
    )
}

fn fallback_built_at<'a>(previous: Option<&'a Value>, fallback: &'a Value) -> Option<&'a str> {
    fallback
        .get("built_at")
        .and_then(Value::as_str)
        .or_else(|| previous?.get("generated_at")?.as_str())
}

fn required_hash(hashes: &BTreeMap<String, String>, path: &str) -> Result<String, String> {
    hashes
        .get(path)
        .cloned()
        .ok_or_else(|| format!("internal error: missing generated JSON hash for {path}"))
}

fn require_relative_path(path: &str, label: &str) -> Result<(), String> {
    if path.is_empty() || path.starts_with('/') || path.contains('\\') {
        return Err(format!("{label} {path:?} is not tap-relative"));
    }
    if path
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(format!("{label} {path:?} contains an unsafe path segment"));
    }
    Ok(())
}

fn verify_bottle_payload(
    package: &PackageInput,
    bottle: &BottleInput,
    bottle_path: &Path,
    payload_root: &str,
) -> Result<(), String> {
    require_relative_path(payload_root, "payload_root")?;
    let entries = tar_gz_entries(bottle_path).map_err(|e| {
        bottle_error(
            package,
            bottle,
            &format!("cannot inspect bottle payload: {e}"),
        )
    })?;

    for link in &bottle.links {
        require_relative_path(&link.source, "link source")?;
        if !payload_contains(&entries, payload_root, &link.source) {
            return Err(bottle_error(
                package,
                bottle,
                &format!(
                    "link source {:?} is missing from bottle payload",
                    link.source
                ),
            ));
        }
    }
    for receipt in &bottle.receipts {
        require_relative_path(receipt, "receipt")?;
        if !payload_contains(&entries, payload_root, receipt) {
            return Err(bottle_error(
                package,
                bottle,
                &format!("receipt {:?} is missing from bottle payload", receipt),
            ));
        }
    }

    Ok(())
}

fn payload_contains(entries: &BTreeSet<String>, payload_root: &str, rel: &str) -> bool {
    entries.contains(rel) || entries.contains(&format!("{payload_root}/{rel}"))
}

fn tar_gz_entries(path: &Path) -> Result<BTreeSet<String>, String> {
    let file = File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let mut out = BTreeSet::new();
    let entries = archive
        .entries()
        .map_err(|e| format!("read {} entries: {e}", path.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read {} entry: {e}", path.display()))?;
        let entry_path = entry
            .path()
            .map_err(|e| format!("read {} entry path: {e}", path.display()))?;
        let normalized = entry_path
            .to_str()
            .ok_or_else(|| format!("{} contains a non-UTF-8 path", path.display()))?
            .trim_start_matches("./")
            .trim_end_matches('/')
            .to_string();
        if !normalized.is_empty() {
            out.insert(normalized);
        }
    }
    Ok(out)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    sha256_file_and_len(path).map(|(sha, _)| sha)
}

fn sha256_file_and_len(path: &Path) -> Result<(String, u64), String> {
    let bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let len = u64::try_from(bytes.len()).map_err(|_| format!("{} is too large", path.display()))?;
    Ok((sha256_bytes(&bytes), len))
}

fn write_json_hashed(path: &Path, value: &Value) -> Result<String, String> {
    let bytes = json_bytes(value)?;
    write_bytes(path, &bytes)?;
    Ok(sha256_bytes(&bytes))
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let bytes = json_bytes(value)?;
    write_bytes(path, &bytes)
}

fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    fs::write(path, bytes).map_err(|e| format!("write {}: {e}", path.display()))
}

fn json_sha256(value: &Value) -> Result<String, String> {
    Ok(sha256_bytes(&json_bytes(value)?))
}

fn json_bytes(value: &Value) -> Result<Vec<u8>, String> {
    let mut text =
        serde_json::to_string_pretty(value).map_err(|e| format!("serialize JSON: {e}"))?;
    text.push('\n');
    Ok(text.into_bytes())
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn set_pointer(value: &mut Value, pointer: &str, replacement: Value) -> Result<(), String> {
    *value
        .pointer_mut(pointer)
        .ok_or_else(|| format!("internal error: missing JSON pointer {pointer}"))? = replacement;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use tempfile::TempDir;

    fn write_text(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, text).unwrap();
    }

    fn write_json_value(path: &Path, value: &Value) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
    }

    fn write_bottle(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let file = File::create(path).unwrap();
        let encoder = GzEncoder::new(file, Compression::default());
        let mut archive = tar::Builder::new(encoder);
        append_tar_file(&mut archive, "hello/2.12.1/bin/hello", b"#!/bin/sh\n");
        append_tar_file(
            &mut archive,
            "hello/2.12.1/INSTALL_RECEIPT.json",
            b"{\"installed_as_dependency\":false}\n",
        );
        archive.finish().unwrap();
    }

    fn append_tar_file<W: std::io::Write>(archive: &mut tar::Builder<W>, path: &str, bytes: &[u8]) {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_mtime(0);
        header.set_cksum();
        archive.append_data(&mut header, path, bytes).unwrap();
    }

    fn fixture_input(bottle_file: &str, status: &str) -> Value {
        let mut bottle = json!({
            "arch": "wasm32",
            "cellar": "/home/linuxbrew/.linuxbrew/Cellar",
            "prefix": "/home/linuxbrew/.linuxbrew",
            "runtime_support": ["node"],
            "browser_compatible": false,
            "fork_instrumentation": "not-required",
            "status": status,
            "built_by": "https://example.invalid/Automattic/kandelo-homebrew/actions/runs/42",
            "built_at": "2026-06-27T00:00:00Z",
        });
        if status == "success" {
            bottle["bottle_file"] = json!(bottle_file);
            bottle["url"] = json!(
                "https://example.invalid/kandelo-homebrew/hello-2.12.1-rebuild0-wasm32_kandelo.bottle.tar.gz"
            );
            bottle["cache_key_sha"] =
                json!("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
            bottle["payload_root"] = json!("hello/2.12.1");
            bottle["links"] = json!([
                {
                    "type": "file",
                    "source": "bin/hello",
                    "target": "bin/hello",
                    "mode": "0755"
                }
            ]);
            bottle["receipts"] = json!(["INSTALL_RECEIPT.json"]);
            bottle["env"] = json!({ "PATH_prepend": ["bin"] });
            bottle["build"] = json!({
                "github_run": "https://example.invalid/Automattic/kandelo-homebrew/actions/runs/42",
                "job": "publish-bottles",
                "runner_os": "ubuntu-24.04",
                "brew_version": "Homebrew 4.6.0",
                "dev_shell": "scripts/dev-shell.sh",
                "sdk_fingerprint": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
                "sysroot_fingerprint": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
            });
            bottle["validation"] = json!({
                "outcome_lists": [
                    {
                        "name": "schema",
                        "status": "success",
                        "passed": ["metadata.json"],
                        "failed": [],
                        "skipped": []
                    }
                ]
            });
        } else {
            bottle["error"] = json!("build failed");
            bottle["last_attempt"] = json!("2026-06-28T00:00:00Z");
            bottle["last_attempt_by"] =
                json!("https://example.invalid/Automattic/kandelo-homebrew/actions/runs/43");
        }

        json!({
            "schema": 1,
            "tap_repository": "Automattic/kandelo-homebrew",
            "tap_name": "automattic/kandelo-homebrew",
            "tap_commit": "1111111111111111111111111111111111111111",
            "kandelo_repository": "Automattic/kandelo",
            "kandelo_commit": "2222222222222222222222222222222222222222",
            "kandelo_abi": 15,
            "release_tag": "bottles-abi-v15",
            "generated_at": "2026-06-27T00:00:00Z",
            "generator": "test",
            "packages": [
                {
                    "name": "hello",
                    "full_name": "automattic/kandelo-homebrew/hello",
                    "version": "2.12.1",
                    "formula_revision": 0,
                    "bottle_rebuild": 0,
                    "formula_path": "Formula/hello.rb",
                    "dependencies": [],
                    "bottles": [bottle]
                }
            ]
        })
    }

    struct Fixture {
        _dir: TempDir,
        tap_root: PathBuf,
        input_path: PathBuf,
    }

    impl Fixture {
        fn new(status: &str) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let tap_root = dir.path().join("tap");
            let input_dir = dir.path().join("inputs");
            fs::create_dir_all(&input_dir).unwrap();
            write_text(
                &tap_root.join("Formula/hello.rb"),
                "class Hello < Formula\n  desc \"Fixture\"\nend\n",
            );
            write_bottle(&input_dir.join("hello.bottle.tar.gz"));
            let input_path = input_dir.join("sidecars.json");
            write_json_value(&input_path, &fixture_input("hello.bottle.tar.gz", status));
            Self {
                _dir: dir,
                tap_root,
                input_path,
            }
        }

        fn run(&self, previous: Option<&Path>) {
            let mut args = vec![
                "--tap-root".to_string(),
                self.tap_root.to_string_lossy().into_owned(),
                "--input".to_string(),
                self.input_path.to_string_lossy().into_owned(),
            ];
            if let Some(previous) = previous {
                args.push("--previous-metadata".to_string());
                args.push(previous.to_string_lossy().into_owned());
            }
            run(args).unwrap();
        }
    }

    #[test]
    fn success_generation_hashes_bottle_bytes_and_sidecars() {
        let fixture = Fixture::new("success");
        fixture.run(None);

        let metadata: Value = load_json(&fixture.tap_root.join("Kandelo/metadata.json")).unwrap();
        let (expected_sha, expected_bytes) =
            sha256_file_and_len(&fixture.input_path.with_file_name("hello.bottle.tar.gz")).unwrap();
        let bottle = &metadata["packages"][0]["bottles"][0];
        assert_eq!(
            bottle["sha256"],
            json!(expected_sha),
            "bottle sha must come from the produced bottle file"
        );
        assert_eq!(bottle["bytes"], json!(expected_bytes));
        assert_eq!(
            bottle["link_manifest"],
            json!("Kandelo/link/hello-2.12.1-rebuild0-wasm32.json")
        );

        let provenance: Value = load_json(
            &fixture
                .tap_root
                .join("Kandelo/reports/hello-2.12.1-rebuild0-wasm32.provenance.json"),
        )
        .unwrap();
        let recorded = provenance
            .pointer("/metadata/provenance_json/sha256")
            .and_then(Value::as_str)
            .unwrap();
        let mut normalized = provenance.clone();
        set_pointer(
            &mut normalized,
            "/metadata/provenance_json/sha256",
            json!(ZERO_SHA256),
        )
        .unwrap();
        assert_eq!(recorded, json_sha256(&normalized).unwrap());

        crate::homebrew_validate::run(vec![
            "--tap-root".to_string(),
            fixture.tap_root.to_string_lossy().into_owned(),
        ])
        .unwrap();
    }

    #[test]
    fn failed_generation_carries_last_green_fallback() {
        let success = Fixture::new("success");
        success.run(None);

        let failed = Fixture::new("failed");
        failed.run(Some(&success.tap_root.join("Kandelo/metadata.json")));

        let metadata: Value = load_json(&failed.tap_root.join("Kandelo/metadata.json")).unwrap();
        let bottle = &metadata["packages"][0]["bottles"][0];
        assert_eq!(bottle["status"], json!("failed"));
        assert_eq!(
            bottle["fallback_url"],
            json!(
                "https://example.invalid/kandelo-homebrew/hello-2.12.1-rebuild0-wasm32_kandelo.bottle.tar.gz"
            )
        );
        assert_eq!(
            bottle["fallback_sha256"],
            json!(
                sha256_file_and_len(&success.input_path.with_file_name("hello.bottle.tar.gz"))
                    .unwrap()
                    .0
            )
        );
        assert_eq!(
            bottle["fallback_link_manifest"],
            json!("Kandelo/link/hello-2.12.1-rebuild0-wasm32.json")
        );
        assert_eq!(bottle["fallback_built_at"], json!("2026-06-27T00:00:00Z"));

        crate::homebrew_validate::run(vec![
            "--tap-root".to_string(),
            failed.tap_root.to_string_lossy().into_owned(),
        ])
        .unwrap();
    }
}

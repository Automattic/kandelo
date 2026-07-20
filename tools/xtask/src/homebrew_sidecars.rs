use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

const METADATA_REL: &str = "Kandelo/metadata.json";
const ZERO_SHA256: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn repository_bottle_root(repository: &str) -> String {
    format!("https://ghcr.io/v2/{}", repository.to_ascii_lowercase())
}

fn repository_bottle_url(repository: &str, package: &str, sha256: &str) -> String {
    format!(
        "{}/{package}/blobs/sha256:{sha256}",
        repository_bottle_root(repository)
    )
}

fn bottle_uses_repository_root(repository: &str, package: &str, bottle: &Value) -> bool {
    let success_url_matches = if bottle.get("status").and_then(Value::as_str) == Some("success") {
        match (
            bottle.get("url").and_then(Value::as_str),
            bottle.get("sha256").and_then(Value::as_str),
        ) {
            (Some(url), Some(sha256)) => url == repository_bottle_url(repository, package, sha256),
            _ => false,
        }
    } else {
        true
    };

    let fallback_url_matches = match (bottle.get("fallback_url"), bottle.get("fallback_sha256")) {
        (None, None) => true,
        (Some(url), Some(sha256)) => match (url.as_str(), sha256.as_str()) {
            (Some(url), Some(sha256)) => url == repository_bottle_url(repository, package, sha256),
            _ => false,
        },
        _ => false,
    };

    success_url_matches && fallback_url_matches
}

fn package_uses_repository_root(repository: &str, package: &Value) -> bool {
    let Some(name) = package.get("name").and_then(Value::as_str) else {
        return false;
    };
    let Some(bottles) = package.get("bottles").and_then(Value::as_array) else {
        return false;
    };
    !bottles.is_empty()
        && bottles
            .iter()
            .all(|bottle| bottle_uses_repository_root(repository, name, bottle))
}

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
    formula_source_sha256: String,
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
    archived_formula_sha256: Option<String>,
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
        self.merge_previous_packages(&mut package_values);
        package_values.sort_by(|a, b| {
            let a_name = a.get("name").and_then(Value::as_str).unwrap_or_default();
            let b_name = b.get("name").and_then(Value::as_str).unwrap_or_default();
            a_name.cmp(b_name)
        });
        summary.packages = package_values.len();

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
        self.refresh_formula_sidecars(&package_values, &mut json_hashes)?;

        let pending_provenance = std::mem::take(&mut self.pending_provenance);
        for mut provenance in pending_provenance {
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
        self.refresh_provenance_hashes(&package_values, &json_hashes)?;

        Ok(summary)
    }

    fn merge_previous_packages(&self, package_values: &mut Vec<Value>) {
        let Some(previous) = self.previous else {
            return;
        };
        if previous.get("kandelo_abi").and_then(Value::as_u64) != Some(self.input.kandelo_abi) {
            return;
        }

        let current_names: BTreeSet<String> = package_values
            .iter()
            .filter_map(|package| package.get("name").and_then(Value::as_str))
            .map(ToOwned::to_owned)
            .collect();
        let Some(previous_packages) = previous.get("packages").and_then(Value::as_array) else {
            return;
        };

        for package in previous_packages {
            let Some(name) = package.get("name").and_then(Value::as_str) else {
                continue;
            };
            if !current_names.contains(name)
                && package_uses_repository_root(&self.input.tap_repository, package)
            {
                package_values.push(package.clone());
            }
        }
    }

    fn refresh_formula_sidecars(
        &self,
        package_values: &[Value],
        json_hashes: &mut BTreeMap<String, String>,
    ) -> Result<(), String> {
        for package in package_values {
            let Some(formula_sidecar_path) =
                package.get("formula_metadata").and_then(Value::as_str)
            else {
                continue;
            };
            require_relative_path(formula_sidecar_path, "formula sidecar path")?;
            let full_path = self.options.tap_root.join(formula_sidecar_path);
            if !full_path.is_file() {
                return Err(format!(
                    "formula sidecar referenced by metadata does not exist: {}",
                    full_path.display()
                ));
            }
            let mut formula = load_json(&full_path)?;
            formula["tap_repository"] = json!(self.input.tap_repository);
            formula["tap_name"] = json!(self.input.tap_name);
            formula["tap_commit"] = json!(self.input.tap_commit);
            formula["kandelo_abi"] = json!(self.input.kandelo_abi);
            formula["source_metadata"] = json!(METADATA_REL);
            for field in [
                "name",
                "full_name",
                "version",
                "formula_revision",
                "bottle_rebuild",
                "formula_path",
                "dependencies",
                "bottles",
            ] {
                formula[field] = package[field].clone();
            }
            let sha = write_json_hashed(&full_path, &formula)?;
            json_hashes.insert(formula_sidecar_path.to_string(), sha);
        }
        Ok(())
    }

    fn refresh_provenance_hashes(
        &self,
        package_values: &[Value],
        json_hashes: &BTreeMap<String, String>,
    ) -> Result<(), String> {
        let metadata_sha =
            hash_for_rel(self.options.tap_root.as_path(), json_hashes, METADATA_REL)?;
        for package in package_values {
            let Some(name) = package.get("name").and_then(Value::as_str) else {
                continue;
            };
            let Some(version) = package.get("version").and_then(Value::as_str) else {
                continue;
            };
            let Some(rebuild) = package.get("bottle_rebuild").and_then(Value::as_u64) else {
                continue;
            };
            let Some(formula_sidecar_path) =
                package.get("formula_metadata").and_then(Value::as_str)
            else {
                continue;
            };
            let formula_sidecar_sha = hash_for_rel(
                self.options.tap_root.as_path(),
                json_hashes,
                formula_sidecar_path,
            )?;
            let Some(bottles) = package.get("bottles").and_then(Value::as_array) else {
                continue;
            };
            for bottle in bottles {
                if bottle.get("status").and_then(Value::as_str) != Some("success") {
                    continue;
                }
                let Some(arch) = bottle.get("arch").and_then(Value::as_str) else {
                    continue;
                };
                let Some(link_manifest_path) = bottle.get("link_manifest").and_then(Value::as_str)
                else {
                    continue;
                };
                let link_sha = hash_for_rel(
                    self.options.tap_root.as_path(),
                    json_hashes,
                    link_manifest_path,
                )?;
                let provenance_path = format!(
                    "Kandelo/reports/{name}-{version}-rebuild{rebuild}-{arch}.provenance.json"
                );
                let full_path = self.options.tap_root.join(&provenance_path);
                if !full_path.is_file() {
                    return Err(format!(
                        "provenance report referenced by metadata does not exist: {}",
                        full_path.display()
                    ));
                }
                let mut provenance = load_json(&full_path)?;
                provenance["metadata"] = json!({
                    "metadata_json": {
                        "path": METADATA_REL,
                        "sha256": metadata_sha,
                    },
                    "formula_json": {
                        "path": formula_sidecar_path,
                        "sha256": formula_sidecar_sha,
                    },
                    "link_manifest_json": {
                        "path": link_manifest_path,
                        "sha256": link_sha,
                    },
                    "provenance_json": {
                        "path": provenance_path,
                        "sha256": ZERO_SHA256,
                    },
                });
                let normalized_sha = json_sha256(&provenance)?;
                set_pointer(
                    &mut provenance,
                    "/metadata/provenance_json/sha256",
                    json!(normalized_sha),
                )?;
                write_json(&full_path, &provenance)?;
            }
        }
        Ok(())
    }

    fn generate_package(
        &mut self,
        package: &PackageInput,
        formula_outputs: &mut Vec<(String, Value)>,
        link_outputs: &mut Vec<(String, Value)>,
    ) -> Result<PackageOutput, String> {
        require_relative_path(&package.formula_path, "formula_path")?;
        require_sha256(
            &package.formula_source_sha256,
            "formula_source_sha256",
        )?;
        sha256_file(&self.options.tap_root.join(&package.formula_path))?;
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
                &formula_sidecar_path,
                link_outputs,
            )?;
            if bottle_status(bottle) == "success" {
                link_manifests += 1;
                provenance_reports += 1;
            }
            bottle_values.push(bottle_value);
        }
        self.merge_previous_bottles(package, &mut bottle_values);
        bottle_values.sort_by(|a, b| {
            let a_arch = a.get("arch").and_then(Value::as_str).unwrap_or_default();
            let b_arch = b.get("arch").and_then(Value::as_str).unwrap_or_default();
            a_arch.cmp(b_arch)
        });

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

    fn merge_previous_bottles(&self, package: &PackageInput, bottle_values: &mut Vec<Value>) {
        let Some(previous) = self.previous else {
            return;
        };
        if previous.get("kandelo_abi").and_then(Value::as_u64) != Some(self.input.kandelo_abi) {
            return;
        }
        let Some(previous_packages) = previous.get("packages").and_then(Value::as_array) else {
            return;
        };
        let Some(previous_package) = previous_packages.iter().find(|candidate| {
            candidate.get("name").and_then(Value::as_str) == Some(package.name.as_str())
                && candidate.get("version").and_then(Value::as_str)
                    == Some(package.version.as_str())
                && candidate.get("formula_revision").and_then(Value::as_u64)
                    == Some(package.formula_revision)
                && candidate.get("bottle_rebuild").and_then(Value::as_u64)
                    == Some(package.bottle_rebuild)
        }) else {
            return;
        };

        let current_arches: BTreeSet<String> = bottle_values
            .iter()
            .filter_map(|bottle| bottle.get("arch").and_then(Value::as_str))
            .map(ToOwned::to_owned)
            .collect();
        let Some(previous_bottles) = previous_package.get("bottles").and_then(Value::as_array)
        else {
            return;
        };
        for bottle in previous_bottles {
            let Some(arch) = bottle.get("arch").and_then(Value::as_str) else {
                continue;
            };
            if !current_arches.contains(arch)
                && bottle_uses_repository_root(&self.input.tap_repository, &package.name, bottle)
            {
                bottle_values.push(bottle.clone());
            }
        }
    }

    fn generate_bottle(
        &mut self,
        package: &PackageInput,
        bottle: &BottleInput,
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
            "formula_sha256": package.formula_source_sha256,
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
        formula_sidecar_path: &str,
        output: &mut Value,
        link_outputs: &mut Vec<(String, Value)>,
    ) -> Result<(), String> {
        let url = required_field(&bottle.url, package, bottle, "url")?;
        let cache_key_sha =
            required_field(&bottle.cache_key_sha, package, bottle, "cache_key_sha")?;
        let bottle_file = required_field(&bottle.bottle_file, package, bottle, "bottle_file")?;
        let expected_archived_formula_sha = required_field(
            &bottle.archived_formula_sha256,
            package,
            bottle,
            "archived_formula_sha256",
        )?;
        require_sha256(
            expected_archived_formula_sha,
            "archived_formula_sha256",
        )?;
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
        let archived_formula_sha =
            verify_bottle_payload(package, bottle, &bottle_path, payload_root)?;
        if archived_formula_sha != expected_archived_formula_sha {
            return Err(bottle_error(
                package,
                bottle,
                &format!(
                    "archived formula sha256 {archived_formula_sha} does not match inspected sha256 {expected_archived_formula_sha}",
                ),
            ));
        }
        output["built_from"]["formula_sha256"] = json!(archived_formula_sha);
        let (bottle_sha, bottle_bytes) = sha256_file_and_len(&bottle_path)?;
        let expected_url =
            repository_bottle_url(&self.input.tap_repository, &package.name, &bottle_sha);
        if url != expected_url {
            return Err(bottle_error(
                package,
                bottle,
                &format!(
                    "success bottle URL {url:?} does not match tap repository package URL {expected_url:?}"
                ),
            ));
        }
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
                "sha256": archived_formula_sha,
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
                    && bottle_uses_repository_root(
                        &self.input.tap_repository,
                        &package.name,
                        candidate,
                    )
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

fn hash_for_rel(
    tap_root: &Path,
    json_hashes: &BTreeMap<String, String>,
    rel: &str,
) -> Result<String, String> {
    if let Some(hash) = json_hashes.get(rel) {
        return Ok(hash.clone());
    }
    require_relative_path(rel, "sidecar hash path")?;
    sha256_file(&tap_root.join(rel))
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

fn require_sha256(value: &str, label: &str) -> Result<(), String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!(
            "{label} must be a 64-character lowercase hexadecimal sha256"
        ));
    }
    Ok(())
}

fn verify_bottle_payload(
    package: &PackageInput,
    bottle: &BottleInput,
    bottle_path: &Path,
    payload_root: &str,
) -> Result<String, String> {
    require_relative_path(payload_root, "payload_root")?;
    let formula_receipt = format!(".brew/{}.rb", package.name);
    if !bottle.receipts.iter().any(|receipt| receipt == &formula_receipt) {
        return Err(bottle_error(
            package,
            bottle,
            &format!("success bottle must declare formula receipt {formula_receipt:?}"),
        ));
    }
    let (entries, archived_formula_sha) =
        tar_gz_entries_and_formula_sha(bottle_path, payload_root, &formula_receipt).map_err(|e| {
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

    Ok(archived_formula_sha)
}

fn payload_contains(entries: &BTreeSet<String>, payload_root: &str, rel: &str) -> bool {
    entries.contains(rel) || entries.contains(&format!("{payload_root}/{rel}"))
}

fn tar_gz_entries_and_formula_sha(
    path: &Path,
    payload_root: &str,
    formula_receipt: &str,
) -> Result<(BTreeSet<String>, String), String> {
    let file = File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let mut out = BTreeSet::new();
    let nested_formula_receipt = format!("{payload_root}/{formula_receipt}");
    let mut formula_sha = None;
    let entries = archive
        .entries()
        .map_err(|e| format!("read {} entries: {e}", path.display()))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("read {} entry: {e}", path.display()))?;
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
            if normalized == formula_receipt || normalized == nested_formula_receipt {
                if formula_sha.is_some() {
                    return Err(format!(
                        "{} contains duplicate formula receipt {formula_receipt:?}",
                        path.display()
                    ));
                }
                let mut hasher = Sha256::new();
                let mut buffer = [0_u8; 64 * 1024];
                loop {
                    let read = entry.read(&mut buffer).map_err(|e| {
                        format!("read {} formula receipt: {e}", path.display())
                    })?;
                    if read == 0 {
                        break;
                    }
                    hasher.update(&buffer[..read]);
                }
                formula_sha = Some(format!("{:x}", hasher.finalize()));
            }
            out.insert(normalized);
        }
    }
    let formula_sha = formula_sha.ok_or_else(|| {
        format!(
            "{} does not contain formula receipt {formula_receipt:?}",
            path.display()
        )
    })?;
    Ok((out, formula_sha))
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

    const FORMULA_TEXT: &str = "class Hello < Formula\n  desc \"Fixture\"\nend\n";
    const CURRENT_ARCHIVED_FORMULA_TEXT: &str =
        "class Hello < Formula\n  desc \"Current fixture\"\nend\n";
    const CURRENT_TAP_FORMULA_TEXT: &str = "class Hello < Formula\n  desc \"Current fixture\"\n\n  bottle do\n    root_url \"https://ghcr.io/v2/kandelo-dev/homebrew-tap-core\"\n    sha256 cellar: :any_skip_relocation, wasm64_kandelo: \"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\"\n  end\nend\n";

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

    fn write_bottle(path: &Path, formula_text: &str) {
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
        append_tar_file(
            &mut archive,
            "hello/2.12.1/.brew/hello.rb",
            formula_text.as_bytes(),
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

    fn copy_tree(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let entry_path = entry.path();
            let target = to.join(entry.file_name());
            if entry_path.is_dir() {
                copy_tree(&entry_path, &target);
            } else {
                fs::copy(&entry_path, target).unwrap();
            }
        }
    }

    fn write_formula_from_metadata(tap_root: &Path, source: &str, metadata: &Value) {
        let package = &metadata["packages"][0];
        let mut tags = package["bottles"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|bottle| {
                let tag = bottle["bottle_tag"].as_str()?;
                let sha = if bottle["status"] == "success" {
                    bottle["sha256"].as_str()?
                } else {
                    bottle["fallback_sha256"].as_str()?
                };
                Some((tag, sha))
            })
            .collect::<Vec<_>>();
        tags.sort_by_key(|(tag, _)| *tag);

        let mut formula = source.strip_suffix("end\n").unwrap().to_string();
        formula.push_str("\n  bottle do\n");
        formula.push_str("    root_url \"https://ghcr.io/v2/kandelo-dev/homebrew-tap-core\"\n");
        let rebuild = package["bottle_rebuild"].as_u64().unwrap();
        if rebuild != 0 {
            formula.push_str(&format!("    rebuild {rebuild}\n"));
        }
        for (tag, sha) in tags {
            formula.push_str(&format!(
                "    sha256 cellar: :any_skip_relocation, {tag}: \"{sha}\"\n"
            ));
        }
        formula.push_str("  end\nend\n");
        write_text(&tap_root.join("Formula/hello.rb"), &formula);
    }

    fn fixture_input(bottle_file: &str, bottle_sha256: &str, status: &str) -> Value {
        let mut bottle = json!({
            "arch": "wasm32",
            "cellar": "/home/linuxbrew/.linuxbrew/Cellar",
            "prefix": "/home/linuxbrew/.linuxbrew",
            "runtime_support": ["node"],
            "browser_compatible": false,
            "fork_instrumentation": "not-required",
            "status": status,
            "built_by": "https://example.invalid/kandelo-dev/homebrew-tap-core/actions/runs/42",
            "built_at": "2026-06-27T00:00:00Z",
        });
        if status == "success" {
            bottle["bottle_file"] = json!(bottle_file);
            bottle["archived_formula_sha256"] =
                json!(sha256_bytes(FORMULA_TEXT.as_bytes()));
            bottle["url"] = json!(repository_bottle_url(
                "kandelo-dev/homebrew-tap-core",
                "hello",
                bottle_sha256,
            ));
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
            bottle["receipts"] = json!([".brew/hello.rb", "INSTALL_RECEIPT.json"]);
            bottle["env"] = json!({ "PATH_prepend": ["bin"] });
            bottle["build"] = json!({
                "github_run": "https://example.invalid/kandelo-dev/homebrew-tap-core/actions/runs/42",
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
                json!("https://example.invalid/kandelo-dev/homebrew-tap-core/actions/runs/43");
        }

        json!({
            "schema": 1,
            "tap_repository": "kandelo-dev/homebrew-tap-core",
            "tap_name": "kandelo-dev/tap-core",
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
                    "full_name": "kandelo-dev/tap-core/hello",
                    "version": "2.12.1",
                    "formula_revision": 0,
                    "bottle_rebuild": 0,
                    "formula_path": "Formula/hello.rb",
                    "formula_source_sha256": sha256_bytes(FORMULA_TEXT.as_bytes()),
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
                FORMULA_TEXT,
            );
            let bottle_path = input_dir.join("hello.bottle.tar.gz");
            write_bottle(&bottle_path, FORMULA_TEXT);
            let bottle_sha256 = sha256_file_and_len(&bottle_path).unwrap().0;
            let input_path = input_dir.join("sidecars.json");
            write_json_value(
                &input_path,
                &fixture_input("hello.bottle.tar.gz", &bottle_sha256, status),
            );
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
        write_formula_from_metadata(&fixture.tap_root, FORMULA_TEXT, &metadata);
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
        write_formula_from_metadata(&failed.tap_root, FORMULA_TEXT, &metadata);
        let bottle = &metadata["packages"][0]["bottles"][0];
        assert_eq!(bottle["status"], json!("failed"));
        assert_eq!(
            bottle["fallback_url"],
            json!(repository_bottle_url(
                "kandelo-dev/homebrew-tap-core",
                "hello",
                bottle["fallback_sha256"].as_str().unwrap(),
            ))
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

    #[test]
    fn success_generation_preserves_previous_arch_bottles() {
        let previous = Fixture::new("success");
        previous.run(None);
        let previous_metadata: Value =
            load_json(&previous.tap_root.join("Kandelo/metadata.json")).unwrap();
        let previous_built_from = previous_metadata["packages"][0]["bottles"][0]
            ["built_from"]
            .clone();
        let previous_formula_sha = previous_built_from["formula_sha256"]
            .as_str()
            .unwrap()
            .to_string();

        let current = Fixture::new("success");
        copy_tree(
            &previous.tap_root.join("Kandelo"),
            &current.tap_root.join("Kandelo"),
        );
        write_text(
            &current.tap_root.join("Formula/hello.rb"),
            CURRENT_TAP_FORMULA_TEXT,
        );
        write_bottle(
            &current.input_path.with_file_name("hello.bottle.tar.gz"),
            CURRENT_ARCHIVED_FORMULA_TEXT,
        );
        let current_formula_sha = sha256_bytes(CURRENT_ARCHIVED_FORMULA_TEXT.as_bytes());
        let current_tap_formula_sha =
            sha256_file(&current.tap_root.join("Formula/hello.rb")).unwrap();
        assert_ne!(current_formula_sha, previous_formula_sha);
        assert_ne!(current_formula_sha, current_tap_formula_sha);

        let mut input = load_json(&current.input_path).unwrap();
        input["packages"][0]["bottles"][0]["arch"] = json!("wasm64");
        let current_bottle_sha =
            sha256_file_and_len(&current.input_path.with_file_name("hello.bottle.tar.gz"))
                .unwrap()
                .0;
        input["packages"][0]["bottles"][0]["url"] = json!(repository_bottle_url(
            "kandelo-dev/homebrew-tap-core",
            "hello",
            &current_bottle_sha,
        ));
        input["kandelo_commit"] = json!("4444444444444444444444444444444444444444");
        input["packages"][0]["formula_source_sha256"] = json!(current_tap_formula_sha);
        input["packages"][0]["bottles"][0]["archived_formula_sha256"] =
            json!(current_formula_sha.clone());
        write_json_value(&current.input_path, &input);

        current.run(Some(&previous.tap_root.join("Kandelo/metadata.json")));

        let metadata: Value = load_json(&current.tap_root.join("Kandelo/metadata.json")).unwrap();
        write_formula_from_metadata(
            &current.tap_root,
            CURRENT_ARCHIVED_FORMULA_TEXT,
            &metadata,
        );
        let bottles = metadata["packages"][0]["bottles"].as_array().unwrap();
        let arches: Vec<_> = bottles
            .iter()
            .map(|bottle| bottle["arch"].as_str().unwrap())
            .collect();
        assert_eq!(arches, vec!["wasm32", "wasm64"]);
        assert_eq!(
            bottles[0]["link_manifest"],
            json!("Kandelo/link/hello-2.12.1-rebuild0-wasm32.json")
        );
        assert_eq!(
            bottles[1]["link_manifest"],
            json!("Kandelo/link/hello-2.12.1-rebuild0-wasm64.json")
        );
        assert_eq!(bottles[0]["built_from"], previous_built_from);
        assert_eq!(
            bottles[1]["built_from"]["tap_commit"],
            json!("1111111111111111111111111111111111111111")
        );
        assert_eq!(
            bottles[1]["built_from"]["kandelo_commit"],
            json!("4444444444444444444444444444444444444444")
        );
        assert_eq!(
            bottles[1]["built_from"]["formula_sha256"],
            json!(current_formula_sha)
        );

        let wasm32_provenance: Value = load_json(
            &current
                .tap_root
                .join("Kandelo/reports/hello-2.12.1-rebuild0-wasm32.provenance.json"),
        )
        .unwrap();
        assert_eq!(
            wasm32_provenance["repositories"]["tap_commit"],
            json!("1111111111111111111111111111111111111111")
        );
        assert_eq!(
            wasm32_provenance["repositories"]["kandelo_commit"],
            json!("2222222222222222222222222222222222222222")
        );
        assert_eq!(
            wasm32_provenance["formula"]["sha256"],
            json!(previous_formula_sha)
        );

        let wasm64_provenance: Value = load_json(
            &current
                .tap_root
                .join("Kandelo/reports/hello-2.12.1-rebuild0-wasm64.provenance.json"),
        )
        .unwrap();
        assert_eq!(
            wasm64_provenance["repositories"]["tap_commit"],
            json!("1111111111111111111111111111111111111111")
        );
        assert_eq!(
            wasm64_provenance["repositories"]["kandelo_commit"],
            json!("4444444444444444444444444444444444444444")
        );
        assert_eq!(
            wasm64_provenance["formula"]["sha256"],
            json!(current_formula_sha)
        );

        crate::homebrew_validate::run(vec![
            "--tap-root".to_string(),
            current.tap_root.to_string_lossy().into_owned(),
        ])
        .unwrap();
    }

    #[test]
    fn success_generation_rejects_url_outside_repository_package_root() {
        let fixture = Fixture::new("success");
        let mut input = load_json(&fixture.input_path).unwrap();
        let bottle_sha =
            sha256_file_and_len(&fixture.input_path.with_file_name("hello.bottle.tar.gz"))
                .unwrap()
                .0;
        input["packages"][0]["bottles"][0]["url"] = json!(repository_bottle_url(
            "kandelo-dev/tap-core",
            "hello",
            &bottle_sha,
        ));
        write_json_value(&fixture.input_path, &input);

        let error = run(vec![
            "--tap-root".to_string(),
            fixture.tap_root.to_string_lossy().into_owned(),
            "--input".to_string(),
            fixture.input_path.to_string_lossy().into_owned(),
        ])
        .unwrap_err();
        assert!(
            error.contains("success bottle URL")
                && error.contains("does not match tap repository package URL"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn failed_generation_does_not_retain_old_root_last_green_fallback() {
        let previous = Fixture::new("success");
        previous.run(None);
        let previous_metadata_path = previous.tap_root.join("Kandelo/metadata.json");
        let mut previous_metadata = load_json(&previous_metadata_path).unwrap();
        let sha256 = previous_metadata["packages"][0]["bottles"][0]["sha256"]
            .as_str()
            .unwrap()
            .to_string();
        previous_metadata["packages"][0]["bottles"][0]["url"] = json!(repository_bottle_url(
            "kandelo-dev/tap-core",
            "hello",
            &sha256,
        ));
        write_json_value(&previous_metadata_path, &previous_metadata);

        let failed = Fixture::new("failed");
        failed.run(Some(&previous_metadata_path));

        let metadata: Value = load_json(&failed.tap_root.join("Kandelo/metadata.json")).unwrap();
        let bottle = &metadata["packages"][0]["bottles"][0];
        assert_eq!(bottle["status"], json!("failed"));
        assert!(bottle.get("fallback_url").is_none());
        assert!(bottle.get("fallback_sha256").is_none());
    }

    #[test]
    fn success_generation_does_not_retain_old_root_sibling_bottle() {
        let previous = Fixture::new("success");
        previous.run(None);
        let previous_metadata_path = previous.tap_root.join("Kandelo/metadata.json");
        let mut previous_metadata = load_json(&previous_metadata_path).unwrap();
        let sha256 = previous_metadata["packages"][0]["bottles"][0]["sha256"]
            .as_str()
            .unwrap()
            .to_string();
        previous_metadata["packages"][0]["bottles"][0]["url"] = json!(repository_bottle_url(
            "kandelo-dev/tap-core",
            "hello",
            &sha256,
        ));
        write_json_value(&previous_metadata_path, &previous_metadata);

        let current = Fixture::new("success");
        copy_tree(
            &previous.tap_root.join("Kandelo"),
            &current.tap_root.join("Kandelo"),
        );
        let mut input = load_json(&current.input_path).unwrap();
        input["packages"][0]["bottles"][0]["arch"] = json!("wasm64");
        write_json_value(&current.input_path, &input);
        current.run(Some(&previous_metadata_path));

        let metadata: Value = load_json(&current.tap_root.join("Kandelo/metadata.json")).unwrap();
        let bottles = metadata["packages"][0]["bottles"].as_array().unwrap();
        assert_eq!(bottles.len(), 1);
        assert_eq!(bottles[0]["arch"], json!("wasm64"));
    }

    #[test]
    fn success_generation_does_not_retain_old_root_unselected_package() {
        let previous = Fixture::new("success");
        previous.run(None);
        let previous_metadata_path = previous.tap_root.join("Kandelo/metadata.json");
        let mut previous_metadata = load_json(&previous_metadata_path).unwrap();
        let previous_bottle = &previous_metadata["packages"][0]["bottles"][0];
        let fallback_sha256 = previous_bottle["sha256"].clone();
        let fallback_bottle = json!({
            "arch": previous_bottle["arch"].clone(),
            "bottle_tag": previous_bottle["bottle_tag"].clone(),
            "kandelo_abi": previous_bottle["kandelo_abi"].clone(),
            "cellar": previous_bottle["cellar"].clone(),
            "prefix": previous_bottle["prefix"].clone(),
            "runtime_support": previous_bottle["runtime_support"].clone(),
            "browser_compatible": previous_bottle["browser_compatible"].clone(),
            "fork_instrumentation": previous_bottle["fork_instrumentation"].clone(),
            "status": "failed",
            "built_by": previous_bottle["built_by"].clone(),
            "built_from": previous_bottle["built_from"].clone(),
            "error": "build failed",
            "last_attempt": "2026-06-28T00:00:00Z",
            "last_attempt_by": "https://example.invalid/kandelo-dev/homebrew-tap-core/actions/runs/43",
            "fallback_url": repository_bottle_url(
                "kandelo-dev/tap-core",
                "zlib",
                fallback_sha256.as_str().unwrap(),
            ),
            "fallback_sha256": fallback_sha256,
            "fallback_bytes": previous_bottle["bytes"].clone(),
            "fallback_cache_key_sha": previous_bottle["cache_key_sha"].clone(),
            "fallback_link_manifest": previous_bottle["link_manifest"].clone(),
            "fallback_built_at": "2026-06-27T00:00:00Z",
        });
        let mut unselected_package = previous_metadata["packages"][0].clone();
        unselected_package["name"] = json!("zlib");
        unselected_package["full_name"] = json!("kandelo-dev/tap-core/zlib");
        unselected_package["bottles"] = json!([fallback_bottle]);
        previous_metadata["packages"]
            .as_array_mut()
            .unwrap()
            .push(unselected_package);
        write_json_value(&previous_metadata_path, &previous_metadata);

        let current = Fixture::new("success");
        copy_tree(
            &previous.tap_root.join("Kandelo"),
            &current.tap_root.join("Kandelo"),
        );
        current.run(Some(&previous_metadata_path));

        let metadata: Value = load_json(&current.tap_root.join("Kandelo/metadata.json")).unwrap();
        let package_names = metadata["packages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|package| package["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(package_names, vec!["hello"]);
    }

    #[test]
    fn success_generation_rejects_formula_archive_from_a_different_source() {
        let fixture = Fixture::new("success");
        let mut input = load_json(&fixture.input_path).unwrap();
        input["packages"][0]["bottles"][0]["archived_formula_sha256"] =
            json!(sha256_bytes(CURRENT_ARCHIVED_FORMULA_TEXT.as_bytes()));
        write_json_value(&fixture.input_path, &input);

        let error = run(vec![
            "--tap-root".to_string(),
            fixture.tap_root.to_string_lossy().into_owned(),
            "--input".to_string(),
            fixture.input_path.to_string_lossy().into_owned(),
        ])
        .unwrap_err();
        assert!(
            error.contains("archived formula sha256")
                && error.contains("does not match inspected sha256"),
            "unexpected error: {error}"
        );
    }
}

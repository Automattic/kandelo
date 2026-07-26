use crate::build_deps::parse_target_arch;
use crate::pkg_manifest::{DepsManifest, ManifestKind, TargetArch};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct MatrixKey {
    package: String,
    arch: TargetArch,
}

impl MatrixKey {
    fn artifact_name(&self) -> String {
        format!("{}-{}", self.package, self.arch.as_str())
    }
}

#[derive(Debug, Clone)]
struct MatrixEntry {
    key: MatrixKey,
    order: usize,
    value: Value,
}

pub(crate) fn run_sort(args: Vec<String>) -> Result<(), String> {
    let parsed = parse_common_args(args)?;
    let matrix = load_matrix(parsed.matrix_path.as_deref())?;
    let sorted = sort_matrix(parsed.registry.as_deref(), matrix)?;
    serde_json::to_writer(std::io::stdout(), &sorted)
        .map_err(|e| format!("write sorted package matrix: {e}"))?;
    println!();
    Ok(())
}

pub(crate) fn run_dependency_artifacts(args: Vec<String>) -> Result<(), String> {
    let parsed = parse_dependency_args(args)?;
    let matrix = load_matrix(parsed.common.matrix_path.as_deref())?;
    let target_arch = parse_target_arch(&parsed.arch)?;
    let target = MatrixKey {
        package: parsed.package,
        arch: target_arch,
    };
    for dep in selected_dependency_keys(parsed.common.registry.as_deref(), &matrix, &target)? {
        println!("{}", dep.artifact_name());
    }
    Ok(())
}

pub(crate) fn run_partition(args: Vec<String>) -> Result<(), String> {
    let parsed = parse_partition_args(args)?;
    let matrix = load_matrix(parsed.common.matrix_path.as_deref())?;
    let roots = parse_roots(&parsed.roots)?;
    let root_arches = parse_arches(&parsed.root_arches)?;
    let levels = partition_matrix(
        parsed.common.registry.as_deref(),
        matrix,
        roots.as_ref(),
        &root_arches,
    )?;
    serde_json::to_writer(std::io::stdout(), &levels)
        .map_err(|e| format!("write partitioned package matrix: {e}"))?;
    println!();
    Ok(())
}

fn sort_matrix(registry: Option<&Path>, matrix: Vec<Value>) -> Result<Vec<Value>, String> {
    let entries = parse_matrix_entries(matrix)?;
    let nodes: BTreeMap<MatrixKey, MatrixEntry> = entries
        .iter()
        .cloned()
        .map(|entry| (entry.key.clone(), entry))
        .collect();
    let mut levels = BTreeMap::new();
    let mut stack = Vec::new();
    for key in nodes.keys() {
        dependency_level(registry, key, &nodes, &mut levels, &mut stack)?;
    }

    let mut entries = entries;
    entries.sort_by_key(|entry| {
        (
            *levels
                .get(&entry.key)
                .expect("dependency level should be computed"),
            entry.order,
        )
    });
    Ok(entries.into_iter().map(|entry| entry.value).collect())
}

fn partition_matrix(
    registry: Option<&Path>,
    matrix: Vec<Value>,
    roots: Option<&BTreeSet<String>>,
    root_arches: &BTreeSet<TargetArch>,
) -> Result<Vec<Vec<Value>>, String> {
    let entries = parse_matrix_entries(matrix)?;
    if entries.is_empty() {
        return Err("package matrix is empty".to_string());
    }
    let nodes: BTreeMap<MatrixKey, MatrixEntry> = entries
        .iter()
        .cloned()
        .map(|entry| (entry.key.clone(), entry))
        .collect();
    let available_names: BTreeSet<String> =
        nodes.keys().map(|key| key.package.clone()).collect();
    let root_names = roots.cloned().unwrap_or_else(|| available_names.clone());
    for root in &root_names {
        if !available_names.contains(root) {
            return Err(format!(
                "requested root package {root:?} has no buildable matrix entry"
            ));
        }
    }

    let mut selected = BTreeSet::new();
    let mut stack = Vec::new();
    for root in &root_names {
        let mut matched_arch = false;
        for arch in root_arches {
            let key = MatrixKey {
                package: root.clone(),
                arch: *arch,
            };
            if nodes.contains_key(&key) {
                select_closure_key(registry, &key, &nodes, &mut selected, &mut stack)?;
                matched_arch = true;
            }
        }
        if !matched_arch {
            let requested = root_arches
                .iter()
                .map(|arch| arch.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "requested root package {root:?} has no entry for requested arches [{requested}]"
            ));
        }
    }

    let selected_nodes: BTreeMap<MatrixKey, MatrixEntry> = nodes
        .into_iter()
        .filter(|(key, _)| selected.contains(key))
        .collect();
    let mut levels = BTreeMap::new();
    let mut level_stack = Vec::new();
    for key in selected_nodes.keys() {
        dependency_level(
            registry,
            key,
            &selected_nodes,
            &mut levels,
            &mut level_stack,
        )?;
    }
    let max_level = levels.values().copied().max().unwrap_or(0);
    let mut partitioned = vec![Vec::new(); max_level + 1];
    // Preserve the preflight matrix's deterministic package order within a
    // level; GitHub may schedule that level in any order because no member has
    // an edge to another member in the same level.
    for entry in entries {
        if let Some(level) = levels.get(&entry.key) {
            partitioned[*level].push(entry.value);
        }
    }
    Ok(partitioned)
}

fn select_closure_key(
    registry: Option<&Path>,
    key: &MatrixKey,
    nodes: &BTreeMap<MatrixKey, MatrixEntry>,
    selected: &mut BTreeSet<MatrixKey>,
    stack: &mut Vec<MatrixKey>,
) -> Result<(), String> {
    if selected.contains(key) {
        return Ok(());
    }
    if let Some(cycle_start) = stack.iter().position(|seen| seen == key) {
        let mut cycle: Vec<String> = stack[cycle_start..]
            .iter()
            .map(MatrixKey::artifact_name)
            .collect();
        cycle.push(key.artifact_name());
        return Err(format!(
            "package dependency cycle in selected closure: {}",
            cycle.join(" -> ")
        ));
    }
    if !nodes.contains_key(key) {
        return Err(format!(
            "selected closure requires missing matrix entry {}",
            key.artifact_name()
        ));
    }

    let target = load_manifest(registry, &key.package)?;
    require_buildable_kind(&target)?;
    stack.push(key.clone());
    for dep in &target.depends_on {
        let dep_manifest = load_manifest(registry, &dep.name)?;
        if dep_manifest.kind == ManifestKind::Source {
            continue;
        }
        require_buildable_kind(&dep_manifest)?;
        let dep_arch = dependency_arch(&dep_manifest, key.arch).map_err(|e| {
            format!(
                "{} depends on {}@{} (arch {}): {e}",
                target.name,
                dep.name,
                dep.version,
                key.arch.as_str()
            )
        })?;
        let dep_key = MatrixKey {
            package: dep.name.clone(),
            arch: dep_arch,
        };
        select_closure_key(registry, &dep_key, nodes, selected, stack)?;
    }
    stack.pop();
    selected.insert(key.clone());
    Ok(())
}

fn selected_dependency_keys(
    registry: Option<&Path>,
    matrix: &[Value],
    target: &MatrixKey,
) -> Result<Vec<MatrixKey>, String> {
    let entries = parse_matrix_entries(matrix.to_vec())?;
    let selected: BTreeSet<MatrixKey> = entries.into_iter().map(|entry| entry.key).collect();
    let target_manifest = load_manifest(registry, &target.package)?;
    require_buildable_kind(&target_manifest)?;

    let mut deps = Vec::new();
    for dep in &target_manifest.depends_on {
        let dep_manifest = load_manifest(registry, &dep.name)?;
        if dep_manifest.kind == ManifestKind::Source {
            continue;
        }
        require_buildable_kind(&dep_manifest)?;
        let dep_arch = dependency_arch(&dep_manifest, target.arch).map_err(|e| {
            format!(
                "{} depends on {}@{} (arch {}): {e}",
                target.package,
                dep.name,
                dep.version,
                target.arch.as_str()
            )
        })?;
        let dep_key = MatrixKey {
            package: dep.name.clone(),
            arch: dep_arch,
        };
        if selected.contains(&dep_key) {
            deps.push(dep_key);
        }
    }
    Ok(deps)
}

fn require_buildable_kind(manifest: &DepsManifest) -> Result<(), String> {
    if matches!(
        manifest.kind,
        ManifestKind::Library | ManifestKind::Program
    ) {
        Ok(())
    } else {
        Err(format!(
            "package {:?} is kind={:?}; package matrix operations require library or program packages",
            manifest.name, manifest.kind
        ))
    }
}

fn dependency_level(
    registry: Option<&Path>,
    key: &MatrixKey,
    nodes: &BTreeMap<MatrixKey, MatrixEntry>,
    levels: &mut BTreeMap<MatrixKey, usize>,
    stack: &mut Vec<MatrixKey>,
) -> Result<usize, String> {
    if let Some(level) = levels.get(key) {
        return Ok(*level);
    }
    if let Some(cycle_start) = stack.iter().position(|seen| seen == key) {
        let mut cycle: Vec<String> = stack[cycle_start..]
            .iter()
            .map(MatrixKey::artifact_name)
            .collect();
        cycle.push(key.artifact_name());
        return Err(format!(
            "package dependency cycle in matrix: {}",
            cycle.join(" -> ")
        ));
    }

    stack.push(key.clone());
    let matrix_values: Vec<Value> = nodes.values().map(|entry| entry.value.clone()).collect();
    let deps = selected_dependency_keys(registry, &matrix_values, key)?;
    let mut level = 0;
    for dep in deps {
        let dep_level = dependency_level(registry, &dep, nodes, levels, stack)?;
        level = level.max(dep_level + 1);
    }
    stack.pop();
    levels.insert(key.clone(), level);
    Ok(level)
}

fn parse_matrix_entries(matrix: Vec<Value>) -> Result<Vec<MatrixEntry>, String> {
    let mut seen = BTreeSet::new();
    matrix
        .into_iter()
        .enumerate()
        .map(|(order, value)| {
            let package = value
                .get("package")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("matrix entry {order} has no string .package"))?
                .to_string();
            let arch_raw = value
                .get("arch")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("matrix entry {order} has no string .arch"))?;
            let arch = parse_target_arch(arch_raw)?;
            let key = MatrixKey { package, arch };
            if !seen.insert(key.clone()) {
                return Err(format!(
                    "matrix contains duplicate package/arch entry {}",
                    key.artifact_name()
                ));
            }
            Ok(MatrixEntry { key, order, value })
        })
        .collect()
}

fn dependency_arch(manifest: &DepsManifest, requested: TargetArch) -> Result<TargetArch, String> {
    if manifest.target_arches.contains(&requested) {
        Ok(requested)
    } else if manifest.target_arches.contains(&TargetArch::Wasm32) {
        Ok(TargetArch::Wasm32)
    } else {
        let declared = manifest
            .target_arches
            .iter()
            .map(|arch| arch.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        Err(format!(
            "{} declares neither {} nor wasm32 in target_arches (declared: [{}])",
            manifest.name,
            requested.as_str(),
            declared
        ))
    }
}

fn load_manifest(registry: Option<&Path>, name: &str) -> Result<DepsManifest, String> {
    let package_dir = registry
        .map(Path::to_path_buf)
        .unwrap_or_else(|| crate::repo_root().join("packages/registry"))
        .join(name);
    DepsManifest::load_with_overlay(&package_dir)
}

fn load_matrix(path: Option<&Path>) -> Result<Vec<Value>, String> {
    let text = match path {
        Some(path) if path != Path::new("-") => std::fs::read_to_string(path)
            .map_err(|e| format!("read package matrix {}: {e}", path.display()))?,
        _ => {
            let mut text = String::new();
            std::io::stdin()
                .read_to_string(&mut text)
                .map_err(|e| format!("read package matrix from stdin: {e}"))?;
            text
        }
    };
    serde_json::from_str(&text).map_err(|e| format!("parse package matrix JSON: {e}"))
}

#[derive(Debug)]
struct CommonArgs {
    registry: Option<PathBuf>,
    matrix_path: Option<PathBuf>,
}

#[derive(Debug)]
struct DependencyArgs {
    common: CommonArgs,
    package: String,
    arch: String,
}

#[derive(Debug)]
struct PartitionArgs {
    common: CommonArgs,
    roots: String,
    root_arches: String,
}

fn parse_common_args(args: Vec<String>) -> Result<CommonArgs, String> {
    let mut registry = None;
    let mut matrix_path = None;
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        if arg == "--registry" {
            assign_once(
                &mut registry,
                PathBuf::from(take_value(&mut it, "--registry")?),
                "--registry",
            )?;
        } else if let Some(value) = arg.strip_prefix("--registry=") {
            assign_once(&mut registry, PathBuf::from(value), "--registry")?;
        } else if arg == "--matrix" {
            assign_once(
                &mut matrix_path,
                PathBuf::from(take_value(&mut it, "--matrix")?),
                "--matrix",
            )?;
        } else if let Some(value) = arg.strip_prefix("--matrix=") {
            assign_once(&mut matrix_path, PathBuf::from(value), "--matrix")?;
        } else {
            return Err(format!("unexpected argument {arg:?}"));
        }
    }
    Ok(CommonArgs {
        registry,
        matrix_path,
    })
}

fn parse_dependency_args(args: Vec<String>) -> Result<DependencyArgs, String> {
    let mut common_args = Vec::new();
    let mut package = None;
    let mut arch = None;
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        if arg == "--package" {
            assign_once(&mut package, take_value(&mut it, "--package")?, "--package")?;
        } else if let Some(value) = arg.strip_prefix("--package=") {
            assign_once(&mut package, value.to_string(), "--package")?;
        } else if arg == "--arch" {
            assign_once(&mut arch, take_value(&mut it, "--arch")?, "--arch")?;
        } else if let Some(value) = arg.strip_prefix("--arch=") {
            assign_once(&mut arch, value.to_string(), "--arch")?;
        } else {
            common_args.push(arg);
        }
    }
    let common = parse_common_args(common_args)?;
    Ok(DependencyArgs {
        common,
        package: package.ok_or_else(|| "--package <name> is required".to_string())?,
        arch: arch.ok_or_else(|| "--arch <wasm32|wasm64> is required".to_string())?,
    })
}

fn parse_partition_args(args: Vec<String>) -> Result<PartitionArgs, String> {
    let mut common_args = Vec::new();
    let mut roots = None;
    let mut root_arches = None;
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        if arg == "--roots" {
            assign_once(&mut roots, take_value(&mut it, "--roots")?, "--roots")?;
        } else if let Some(value) = arg.strip_prefix("--roots=") {
            assign_once(&mut roots, value.to_string(), "--roots")?;
        } else if arg == "--root-arches" {
            assign_once(
                &mut root_arches,
                take_value(&mut it, "--root-arches")?,
                "--root-arches",
            )?;
        } else if let Some(value) = arg.strip_prefix("--root-arches=") {
            assign_once(&mut root_arches, value.to_string(), "--root-arches")?;
        } else {
            common_args.push(arg);
        }
    }
    Ok(PartitionArgs {
        common: parse_common_args(common_args)?,
        roots: roots.ok_or_else(|| "--roots <all|csv> is required".to_string())?,
        root_arches: root_arches
            .ok_or_else(|| "--root-arches <wasm32,wasm64> is required".to_string())?,
    })
}

fn parse_roots(value: &str) -> Result<Option<BTreeSet<String>>, String> {
    if value == "all" {
        return Ok(None);
    }
    let mut roots = BTreeSet::new();
    for raw in value.split(',') {
        let root = raw.trim();
        if root.is_empty()
            || !root
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        {
            return Err(format!("invalid package root {root:?} in --roots"));
        }
        if !roots.insert(root.to_string()) {
            return Err(format!("duplicate package root {root:?} in --roots"));
        }
    }
    if roots.is_empty() {
        return Err("--roots must be `all` or a non-empty package list".to_string());
    }
    Ok(Some(roots))
}

fn parse_arches(value: &str) -> Result<BTreeSet<TargetArch>, String> {
    let mut arches = BTreeSet::new();
    for raw in value.split(',') {
        let arch = parse_target_arch(raw.trim())?;
        if !arches.insert(arch) {
            return Err(format!(
                "duplicate root arch {:?} in --root-arches",
                arch.as_str()
            ));
        }
    }
    if arches.is_empty() {
        return Err("--root-arches must not be empty".to_string());
    }
    Ok(arches)
}

fn assign_once<T>(slot: &mut Option<T>, value: T, flag: &str) -> Result<(), String> {
    if slot.replace(value).is_some() {
        Err(format!("{flag} given more than once"))
    } else {
        Ok(())
    }
}

fn take_value<I>(it: &mut I, flag: &str) -> Result<String, String>
where
    I: Iterator<Item = String>,
{
    it.next().ok_or_else(|| format!("{flag} requires a value"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_package(
        registry: &Path,
        name: &str,
        kind: &str,
        deps: &[&str],
        arches: &[&str],
    ) {
        let dir = registry.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let deps_toml = deps
            .iter()
            .map(|dep| format!("\"{dep}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let arches_toml = arches
            .iter()
            .map(|arch| format!("\"{arch}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let outputs = if kind == "library" {
            format!("[outputs]\nlibs = [\"lib/lib{name}.a\"]")
        } else {
            format!("[[outputs]]\nname = \"{name}\"\nwasm = \"{name}.wasm\"")
        };
        std::fs::write(
            dir.join("package.toml"),
            format!(
                r#"kind = "{kind}"
name = "{name}"
version = "1.0.0"
kernel_abi = 7
depends_on = [{deps_toml}]
arches = [{arches_toml}]

[source]
url = "https://example.test/{name}.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "MIT"
url = "https://example.test/LICENSE"

[build]
script_path = "packages/registry/{name}/build.sh"

{outputs}
"#
            ),
        )
        .unwrap();
    }

    fn write_program(registry: &Path, name: &str, deps: &[&str]) {
        write_package(registry, name, "program", deps, &["wasm32"]);
    }

    fn write_library(registry: &Path, name: &str, deps: &[&str]) {
        write_package(registry, name, "library", deps, &["wasm32"]);
    }

    fn entry(name: &str) -> Value {
        entry_for(name, "wasm32")
    }

    fn entry_for(name: &str, arch: &str) -> Value {
        serde_json::json!({
            "package": name,
            "arch": arch,
            "sha": format!("{name}-{arch}-sha"),
            "version": "1.0.0",
            "revision": 1,
        })
    }

    #[test]
    fn sort_matrix_orders_selected_program_dependencies_first() {
        let tmp = tempdir().unwrap();
        let registry = tmp.path();
        write_program(registry, "rootfs", &["sed@4.9"]);
        write_program(registry, "sed", &[]);
        write_program(registry, "shell", &["rootfs@0.1.0"]);
        write_program(registry, "node-vfs", &["shell@0.1.0"]);

        let sorted = sort_matrix(
            Some(registry),
            vec![
                entry("node-vfs"),
                entry("shell"),
                entry("rootfs"),
                entry("sed"),
            ],
        )
        .unwrap();

        let names = sorted
            .iter()
            .map(|entry| entry["package"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(names, ["sed", "rootfs", "shell", "node-vfs"]);
    }

    #[test]
    fn dependency_artifacts_reports_only_selected_direct_program_dependencies() {
        let tmp = tempdir().unwrap();
        let registry = tmp.path();
        write_program(registry, "rootfs", &["sed@4.9"]);
        write_program(registry, "sed", &[]);
        write_program(registry, "shell", &["rootfs@0.1.0", "curl@8.11.1"]);
        write_program(registry, "curl", &[]);

        let matrix = vec![entry("rootfs"), entry("shell")];
        let deps = selected_dependency_keys(
            Some(registry),
            &matrix,
            &MatrixKey {
                package: "shell".to_string(),
                arch: TargetArch::Wasm32,
            },
        )
        .unwrap();

        let artifacts = deps
            .iter()
            .map(MatrixKey::artifact_name)
            .collect::<Vec<_>>();
        assert_eq!(artifacts, ["rootfs-wasm32"]);
    }

    #[test]
    fn library_dependency_artifacts_cover_every_current_multilibrary_consumer() {
        let tmp = tempdir().unwrap();
        let registry = tmp.path();
        for dependency in ["zlib", "openssl", "libiconv", "libcxx"] {
            write_library(registry, dependency, &[]);
        }
        for (package, deps) in [
            ("libpng", vec!["zlib@1.0.0"]),
            ("libxml2", vec!["zlib@1.0.0", "libiconv@1.0.0"]),
            ("libzip", vec!["zlib@1.0.0"]),
            ("libcurl", vec!["zlib@1.0.0", "openssl@1.0.0"]),
            ("icu", vec!["libcxx@1.0.0"]),
        ] {
            write_library(registry, package, &deps);
        }
        let matrix = [
            "zlib",
            "openssl",
            "libiconv",
            "libcxx",
            "libpng",
            "libxml2",
            "libzip",
            "libcurl",
            "icu",
        ]
        .into_iter()
        .map(entry)
        .collect::<Vec<_>>();

        let expected = [
            ("libpng", vec!["zlib-wasm32"]),
            ("libxml2", vec!["zlib-wasm32", "libiconv-wasm32"]),
            ("libzip", vec!["zlib-wasm32"]),
            ("libcurl", vec!["zlib-wasm32", "openssl-wasm32"]),
            ("icu", vec!["libcxx-wasm32"]),
        ];
        for (package, expected_artifacts) in expected {
            let artifacts = selected_dependency_keys(
                Some(registry),
                &matrix,
                &MatrixKey {
                    package: package.to_string(),
                    arch: TargetArch::Wasm32,
                },
            )
            .unwrap()
            .into_iter()
            .map(|key| key.artifact_name())
            .collect::<Vec<_>>();
            assert_eq!(artifacts, expected_artifacts, "package {package}");
        }
    }

    #[test]
    fn current_registry_multilibrary_consumers_follow_same_run_exact_dependencies() {
        let registry = crate::repo_root().join("packages/registry");
        let base = ["zlib", "openssl", "libiconv", "libcxx"];
        let consumers = ["libpng", "libxml2", "libzip", "libcurl", "icu"];
        let matrix = base
            .into_iter()
            .chain(consumers)
            .map(entry)
            .collect::<Vec<_>>();
        let roots = consumers
            .into_iter()
            .map(str::to_string)
            .collect::<BTreeSet<_>>();
        let levels = partition_matrix(
            Some(&registry),
            matrix,
            Some(&roots),
            &BTreeSet::from([TargetArch::Wasm32]),
        )
        .unwrap();
        let names = levels
            .iter()
            .map(|level| {
                level
                    .iter()
                    .map(|entry| entry["package"].as_str().unwrap())
                    .collect::<BTreeSet<_>>()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            names[0],
            BTreeSet::from(["zlib", "openssl", "libiconv", "libcxx"])
        );
        assert_eq!(
            names[1],
            BTreeSet::from(["libpng", "libxml2", "libzip", "libcurl", "icu"])
        );
    }

    #[test]
    fn current_registry_program_dependencies_keep_the_same_graph_contract() {
        let registry = crate::repo_root().join("packages/registry");
        let matrix = ["node-vfs", "node", "shell"]
            .into_iter()
            .map(entry)
            .collect::<Vec<_>>();
        let artifacts = selected_dependency_keys(
            Some(&registry),
            &matrix,
            &MatrixKey {
                package: "node-vfs".to_string(),
                arch: TargetArch::Wasm32,
            },
        )
        .unwrap()
        .into_iter()
        .map(|key| key.artifact_name())
        .collect::<Vec<_>>();
        assert_eq!(artifacts, ["node-wasm32", "shell-wasm32"]);
    }

    #[test]
    fn partition_selects_exact_root_closure_and_preserves_parallel_levels() {
        let tmp = tempdir().unwrap();
        let registry = tmp.path();
        write_library(registry, "zlib", &[]);
        write_library(registry, "openssl", &[]);
        write_library(
            registry,
            "libcurl",
            &["zlib@1.0.0", "openssl@1.0.0"],
        );
        write_program(registry, "curl", &["libcurl@1.0.0"]);
        write_program(registry, "unrelated", &[]);
        let matrix = ["curl", "unrelated", "libcurl", "openssl", "zlib"]
            .into_iter()
            .map(entry)
            .collect();
        let roots = BTreeSet::from(["curl".to_string()]);
        let levels = partition_matrix(
            Some(registry),
            matrix,
            Some(&roots),
            &BTreeSet::from([TargetArch::Wasm32]),
        )
        .unwrap();
        let names = levels
            .iter()
            .map(|level| {
                level
                    .iter()
                    .map(|entry| entry["package"].as_str().unwrap())
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                vec!["openssl", "zlib"],
                vec!["libcurl"],
                vec!["curl"]
            ]
        );
    }

    #[test]
    fn partition_rejects_a_missing_buildable_dependency_entry() {
        let tmp = tempdir().unwrap();
        let registry = tmp.path();
        write_library(registry, "zlib", &[]);
        write_program(registry, "consumer", &["zlib@1.0.0"]);
        let roots = BTreeSet::from(["consumer".to_string()]);
        let error = partition_matrix(
            Some(registry),
            vec![entry("consumer")],
            Some(&roots),
            &BTreeSet::from([TargetArch::Wasm32]),
        )
        .unwrap_err();
        assert!(
            error.contains("selected closure requires missing matrix entry zlib-wasm32"),
            "got: {error}"
        );
    }

    #[test]
    fn partition_uses_wasm32_dependency_fallback_for_wasm64_roots() {
        let tmp = tempdir().unwrap();
        let registry = tmp.path();
        write_package(registry, "zlib", "library", &[], &["wasm32"]);
        write_package(
            registry,
            "consumer",
            "program",
            &["zlib@1.0.0"],
            &["wasm32", "wasm64"],
        );
        let roots = BTreeSet::from(["consumer".to_string()]);
        let levels = partition_matrix(
            Some(registry),
            vec![
                entry_for("consumer", "wasm32"),
                entry_for("consumer", "wasm64"),
                entry_for("zlib", "wasm32"),
            ],
            Some(&roots),
            &BTreeSet::from([TargetArch::Wasm64]),
        )
        .unwrap();
        assert_eq!(levels[0][0]["package"], "zlib");
        assert_eq!(levels[0][0]["arch"], "wasm32");
        assert_eq!(levels[1][0]["package"], "consumer");
        assert_eq!(levels[1][0]["arch"], "wasm64");
    }
}

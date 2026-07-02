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

fn selected_dependency_keys(
    registry: Option<&Path>,
    matrix: &[Value],
    target: &MatrixKey,
) -> Result<Vec<MatrixKey>, String> {
    let entries = parse_matrix_entries(matrix.to_vec())?;
    let selected: BTreeSet<MatrixKey> = entries.into_iter().map(|entry| entry.key).collect();
    let target_manifest = load_manifest(registry, &target.package)?;
    if target_manifest.kind != ManifestKind::Program {
        return Err(format!(
            "package {:?} is kind={:?}; package dependency artifact lookup is program-only",
            target.package, target_manifest.kind
        ));
    }

    let mut deps = Vec::new();
    for dep in &target_manifest.depends_on {
        let dep_manifest = load_manifest(registry, &dep.name)?;
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
            "program package dependency cycle in matrix: {}",
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

    fn write_program(registry: &Path, name: &str, deps: &[&str]) {
        let dir = registry.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let deps_toml = deps
            .iter()
            .map(|dep| format!("\"{dep}\""))
            .collect::<Vec<_>>()
            .join(", ");
        std::fs::write(
            dir.join("package.toml"),
            format!(
                r#"kind = "program"
name = "{name}"
version = "1.0.0"
kernel_abi = 7
depends_on = [{deps_toml}]

[source]
url = "https://example.test/{name}.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "MIT"
url = "https://example.test/LICENSE"

[build]
script_path = "packages/registry/{name}/build.sh"

[[outputs]]
name = "{name}"
wasm = "{name}.wasm"
"#
            ),
        )
        .unwrap();
    }

    fn entry(name: &str) -> Value {
        serde_json::json!({
            "package": name,
            "arch": "wasm32",
            "sha": format!("{name}-sha"),
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
    fn dependency_artifacts_reports_only_selected_direct_dependencies() {
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
}

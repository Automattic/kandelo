//! `xtask partial-image <image> [<package>...]` — compose one product image
//! from the rootfs base plus only the named packages, for fast iteration.
//!
//! A worktree normally builds the whole canonical shell (every package
//! `packages/registry/shell/package.toml` depends on) before anything can be
//! tried. A partial image carries the base every shell has — the `rootfs`
//! package's closure and the CA trust roots — and the packages a developer is
//! working on, each installed exactly as the canonical shell installs it.
//!
//! The members are built through the normal local-build engine and shared
//! cache. The image itself has no package identity: it is composed straight
//! into `local-binaries/partial/`, never enters a cache, and cannot shadow a
//! canonical artifact. `partial.json` beside it tells the browser and Node
//! what was built. See docs/superpowers/specs/2026-11-07-partial-image-builds-design.md.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::build_deps::{
    Registry, ResolvePolicy, source_only_package_dir, write_dependency_original_inputs,
};
use crate::pkg_manifest::TargetArch;

/// Where partial artifacts live, relative to the repository root.
pub(crate) const PARTIAL_DIR: &str = "local-binaries/partial";
pub(crate) const MANIFEST_NAME: &str = "partial.json";

const SHELL_CONTRACT: &str = "packages/registry/shell/source-rootfs-shell-dependencies.json";
const SHELL_MANIFEST: &str = "packages/registry/shell/package.toml";
const COMPOSER: &str = "images/vfs/scripts/build-source-rootfs-shell-image.ts";

/// What a partial build may target: the canonical image it stands in for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PartialImage {
    pub name: &'static str,
    pub product_id: &'static str,
}

pub(crate) const PARTIAL_IMAGES: &[PartialImage] = &[PartialImage {
    name: "shell",
    product_id: "browser-main-shell",
}];

/// Packages every partial shell carries besides the rootfs closure. The CA
/// trust roots are base infrastructure: every networked program reads them,
/// and the composer always installs them.
const EXTRA_BASE_PACKAGES: &[&str] = &["rootfs", "ca-certificates"];

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Request {
    pub image: PartialImage,
    pub packages: Vec<String>,
    pub with_tests: bool,
    pub jobs: Option<String>,
}

const USAGE: &str = "usage: xtask partial-image <image> [<package>...] [--with-tests] [--jobs <n>]\n\
     images: shell";

pub(crate) fn parse_args(args: &[String]) -> Result<Request, String> {
    let mut positional = Vec::new();
    let mut with_tests = false;
    let mut jobs = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--with-tests" => with_tests = true,
            "--jobs" => {
                jobs = Some(iter.next().ok_or_else(|| format!("--jobs needs a value\n{USAGE}"))?.clone())
            }
            "-h" | "--help" => return Err(USAGE.to_string()),
            flag if flag.starts_with('-') => return Err(format!("unknown flag {flag}\n{USAGE}")),
            name => positional.push(name.to_string()),
        }
    }
    let (image_name, packages) = positional
        .split_first()
        .ok_or_else(|| USAGE.to_string())?;
    let image = PARTIAL_IMAGES
        .iter()
        .find(|image| image.name == image_name || image.product_id == image_name)
        .copied()
        .ok_or_else(|| {
            format!(
                "no partial build for image {image_name:?}; partial images exist for: {}.\n\
                 Images that do not embed the shell already build without it: \
                 build them normally (./run.sh build <image>).",
                PARTIAL_IMAGES.iter().map(|image| image.name).collect::<Vec<_>>().join(", ")
            )
        })?;
    let mut seen = BTreeSet::new();
    let packages = packages
        .iter()
        .filter(|name| seen.insert((*name).clone()))
        .cloned()
        .collect();
    Ok(Request { image, packages, with_tests, jobs })
}

/// The shell contract's package names, and which of them the composer reads
/// from a resolver directory.
pub(crate) struct ShellContract {
    pub names: BTreeSet<String>,
    pub resolver_owned: BTreeSet<String>,
}

pub(crate) fn read_shell_contract(repo: &Path) -> Result<ShellContract, String> {
    let path = repo.join(SHELL_CONTRACT);
    let text = std::fs::read_to_string(&path)
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("parse {}: {error}", path.display()))?;
    let dependencies = value
        .get("dependencies")
        .and_then(|deps| deps.as_array())
        .ok_or_else(|| format!("{} has no dependencies list", path.display()))?;
    let mut names = BTreeSet::new();
    let mut resolver_owned = BTreeSet::new();
    for dependency in dependencies {
        let name = dependency
            .get("name")
            .and_then(|name| name.as_str())
            .ok_or_else(|| format!("{} has a dependency without a name", path.display()))?;
        let role = dependency.get("role").and_then(|role| role.as_str()).unwrap_or("");
        names.insert(name.to_string());
        if matches!(role, "lazy-file" | "lazy-archive" | "eager-file") {
            resolver_owned.insert(name.to_string());
        }
    }
    Ok(ShellContract { names, resolver_owned })
}

/// Every package a partial shell carries before anything is named.
pub(crate) fn base_packages(registry: &Registry) -> Result<BTreeSet<String>, String> {
    let rootfs = registry.load("rootfs")?;
    let mut base: BTreeSet<String> =
        rootfs.depends_on.iter().map(|dep| dep.name.clone()).collect();
    base.extend(EXTRA_BASE_PACKAGES.iter().map(|name| name.to_string()));
    Ok(base)
}

/// Refuse a name the canonical shell does not carry: a partial image installs
/// packages exactly as the shell does, so the shell must say how.
pub(crate) fn check_named_packages(
    named: &[String],
    contract: &ShellContract,
    base: &BTreeSet<String>,
) -> Result<(), String> {
    let unknown: Vec<&String> = named
        .iter()
        .filter(|name| !contract.names.contains(*name) && !base.contains(*name))
        .collect();
    if unknown.is_empty() {
        return Ok(());
    }
    Err(format!(
        "not in the canonical shell: {}.\n\
         A partial image installs a package the way the shell does, so add it to the shell first:\n\
         \x20 1. {SHELL_CONTRACT}: a dependency entry with its role\n\
         \x20    (lazy-file, lazy-archive or eager-file)\n\
         \x20 2. {SHELL_MANIFEST}: the same name@version in depends_on\n\
         \x20 3. the composer table that installs its files: SHELL_LAZY_BINARY_SPECS in\n\
         \x20    images/vfs/lib/init/shell-binaries.ts (programs) or SHELL_LAZY_ARCHIVE_SPECS\n\
         \x20    in images/vfs/scripts/shell-lazy-archives.ts (archives)",
        unknown.iter().map(|name| name.as_str()).collect::<Vec<_>>().join(", ")
    ))
}

#[derive(Debug, Serialize, serde::Deserialize, PartialEq)]
pub(crate) struct ExcludedActivity {
    pub profile: String,
    pub missing: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
struct ComposerReport {
    included: Vec<String>,
    excluded: Vec<ExcludedActivity>,
}

/// `partial.json`: what the browser and Node read to find and describe the
/// worktree's partial image.
#[derive(Debug, Serialize)]
pub(crate) struct PartialManifest {
    pub schema: u32,
    pub image: String,
    #[serde(rename = "productId")]
    pub product_id: String,
    pub file: String,
    pub sha256: String,
    pub bytes: u64,
    /// The packages the developer named, sorted.
    pub packages: Vec<String>,
    /// Every package the image carries, base included, sorted.
    pub selection: Vec<String>,
    pub activities: Vec<String>,
    #[serde(rename = "excludedActivities")]
    pub excluded_activities: Vec<ExcludedActivity>,
    #[serde(rename = "builtAt")]
    pub built_at: String,
}

pub(crate) fn image_file_name(image: &PartialImage) -> String {
    format!("{}-partial.vfs.zst", image.name)
}

fn env_key(name: &str) -> String {
    format!("WASM_POSIX_DEP_{}_DIR", name.replace('-', "_").to_uppercase())
}

fn now_rfc3339() -> String {
    let output = Command::new("date").args(["-u", "+%Y-%m-%dT%H:%M:%SZ"]).output();
    match output {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        _ => String::new(),
    }
}

/// Remove the previous partial build's files (only names this verb writes),
/// so one partial image exists per worktree.
fn clear_previous(dir: &Path) -> Result<(), String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(()) };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == MANIFEST_NAME || name.ends_with("-partial.vfs.zst") || name.ends_with(".partial-tmp") {
            let path = entry.path();
            if path.is_dir() {
                std::fs::remove_dir_all(&path)
                    .map_err(|error| format!("remove {}: {error}", path.display()))?;
                continue;
            }
            std::fs::remove_file(entry.path())
                .map_err(|error| format!("remove {}: {error}", entry.path().display()))?;
        }
    }
    Ok(())
}

pub(crate) fn run(args: Vec<String>) -> Result<(), String> {
    let request = parse_args(&args)?;
    let repo = crate::repo_root();
    let registry = Registry::from_env(&repo);
    let contract = read_shell_contract(&repo)?;
    let base = base_packages(&registry)?;
    check_named_packages(&request.packages, &contract, &base)?;

    let mut selection: BTreeSet<String> = base.clone();
    selection.extend(request.packages.iter().cloned());
    let named_beyond_base: Vec<&String> =
        request.packages.iter().filter(|name| !base.contains(*name)).collect();
    for name in request.packages.iter().filter(|name| base.contains(*name)) {
        eprintln!("partial-image: {name} is already in the base; nothing to add");
    }

    // Build the members: the kernel and SDK first (as every package build
    // does), then the selection through the engine, which reuses the shared
    // cache and publishes this worktree's program view for lazy files.
    let jobs = crate::local_build::select_job_count(
        request.jobs.as_deref(),
        std::env::var("WASM_POSIX_LOCAL_BUILD_JOBS").ok().as_deref(),
        std::thread::available_parallelism().ok(),
    )?;
    crate::local_build::run_bootstrap_step(&repo, "engine", jobs, false, false, vec!["kernel".into()])?;
    crate::local_build::run_bootstrap_step(&repo, "sdk", jobs, false, false, Vec::new())?;
    let products: Vec<String> = EXTRA_BASE_PACKAGES
        .iter()
        .map(|name| name.to_string())
        .chain(named_beyond_base.iter().map(|name| (*name).clone()))
        .collect();
    crate::local_build::run_bootstrap_step(&repo, "engine", jobs, false, false, products)?;

    // Point the composer at each member's resolver directory.
    let mut composer_env = Vec::new();
    for name in selection
        .iter()
        .filter(|name| contract.resolver_owned.contains(*name) || ["rootfs", "bash"].contains(&name.as_str()))
    {
        let dir = source_only_package_dir(&registry, name, TargetArch::Wasm32)?;
        if !dir.is_dir() {
            return Err(format!("{name} was not built: expected {}", dir.display()));
        }
        composer_env.push((env_key(name), dir));
    }
    let dir_of = |name: &str| -> Result<&PathBuf, String> {
        composer_env
            .iter()
            .find(|(key, _)| *key == env_key(name))
            .map(|(_, dir)| dir)
            .ok_or_else(|| format!("no resolver directory for {name}"))
    };

    let out_dir = repo.join(PARTIAL_DIR);
    std::fs::create_dir_all(&out_dir)
        .map_err(|error| format!("create {}: {error}", out_dir.display()))?;
    clear_previous(&out_dir)?;
    let selection_file = out_dir.join("selection.json.partial-tmp");
    let report_file = out_dir.join("report.json.partial-tmp");
    std::fs::write(
        &selection_file,
        serde_json::to_vec(&serde_json::json!({ "schema": 1, "packages": selection }))
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("write {}: {error}", selection_file.display()))?;
    // Programs carry a reference to their pre-instrumentation original, which
    // the image installs beside them. The resolver hands a package build the
    // list of its dependencies' originals; the partial shell stands in for the
    // shell package, so it gets the same list for the members it selected.
    let originals_dir = out_dir.join("originals.partial-tmp");
    let _ = std::fs::remove_dir_all(&originals_dir);
    std::fs::create_dir_all(&originals_dir)
        .map_err(|error| format!("create {}: {error}", originals_dir.display()))?;
    let shell_manifest = registry.load("shell")?;
    let dependency_dirs: std::collections::BTreeMap<String, PathBuf> = composer_env
        .iter()
        .filter_map(|(key, dir)| {
            selection
                .iter()
                .find(|name| env_key(name) == *key)
                .map(|name| (name.clone(), dir.clone()))
        })
        .collect();
    let original_inputs = write_dependency_original_inputs(
        &shell_manifest,
        &registry,
        &dependency_dirs,
        TargetArch::Wasm32,
        wasm_posix_shared::ABI_VERSION,
        ResolvePolicy::SourceOnlyV1,
        &originals_dir,
    )?;
    let file_name = image_file_name(&request.image);
    let image_path = out_dir.join(&file_name);

    let shell_dir = repo.join("packages/registry/shell");
    let mut composer = Command::new("node");
    composer
        .current_dir(&repo)
        .arg(repo.join("node_modules/tsx/dist/cli.mjs"))
        .arg(repo.join(COMPOSER))
        .arg("--rootfs").arg(dir_of("rootfs")?.join("rootfs.vfs.zst"))
        .arg("--ca-bundle").arg(dir_of("ca-certificates")?.join("ca-certificates.zip"))
        .arg("--bash").arg(dir_of("bash")?.join("bash.wasm"))
        .arg("--demo-config").arg(shell_dir.join("source-rootfs-shell-demo.json"))
        .arg("--demo-profile-overlay").arg(shell_dir.join("source-rootfs-shell-demo-profiles.json"))
        .arg("--dependency-contract").arg(repo.join(SHELL_CONTRACT))
        .arg("--selection").arg(&selection_file)
        .arg("--report").arg(&report_file)
        .arg("--out").arg(&image_path)
        .env("SOURCE_DATE_EPOCH", "0")
        .env("TZ", "UTC")
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .env("WASM_POSIX_DEP_NAME", "shell")
        .env_remove("WASM_POSIX_DEP_ORIGINAL_INPUTS")
        .envs(composer_env.iter().map(|(key, dir)| (key.clone(), dir.clone())));
    if selection.contains("wayland-demo") {
        let wayland = dir_of("wayland-demo")?;
        composer
            .arg("--wldesktop").arg(wayland.join("wldesktop"))
            .arg("--omarchydesktop").arg(wayland.join("omarchydesktop"))
            .arg("--desktop-data").arg(wayland.join("kandelo-desktop-data.zip"))
            .arg("--libinput-quirks").arg(wayland.join("libinput-quirks.zip"));
    }
    if let Some(path) = &original_inputs {
        composer.env("WASM_POSIX_DEP_ORIGINAL_INPUTS", path);
    }
    if selection.contains("espeak-ng") {
        composer
            .arg("--espeak-ng-data")
            .arg(dir_of("espeak-ng")?.join("espeak-ng-data.zip"));
    }
    eprintln!("partial-image: composing {}", image_path.display());
    let status = composer
        .status()
        .map_err(|error| format!("run the shell composer: {error}"))?;
    let _ = std::fs::remove_file(&selection_file);
    let _ = std::fs::remove_dir_all(&originals_dir);
    if !status.success() {
        let _ = std::fs::remove_file(&report_file);
        return Err(format!("the shell composer failed ({status})"));
    }
    let report: ComposerReport = serde_json::from_slice(
        &std::fs::read(&report_file)
            .map_err(|error| format!("read {}: {error}", report_file.display()))?,
    )
    .map_err(|error| format!("parse composer report: {error}"))?;
    let _ = std::fs::remove_file(&report_file);

    let bytes = std::fs::read(&image_path)
        .map_err(|error| format!("read {}: {error}", image_path.display()))?;
    let manifest = PartialManifest {
        schema: 1,
        image: request.image.name.to_string(),
        product_id: request.image.product_id.to_string(),
        file: file_name,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        bytes: bytes.len() as u64,
        packages: request.packages.iter().cloned().collect::<BTreeSet<_>>().into_iter().collect(),
        selection: selection.iter().cloned().collect(),
        activities: report.included,
        excluded_activities: report.excluded,
        built_at: now_rfc3339(),
    };
    let manifest_path = out_dir.join(MANIFEST_NAME);
    std::fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("write {}: {error}", manifest_path.display()))?;

    print_summary(&repo, &manifest, &image_path);
    if request.with_tests {
        run_package_tests(&repo, &request.packages)?;
    }
    Ok(())
}

fn print_summary(repo: &Path, manifest: &PartialManifest, image_path: &Path) {
    let relative = image_path.strip_prefix(repo).unwrap_or(image_path);
    println!("Partial {} image: {}", manifest.image, relative.display());
    println!(
        "  packages: {}",
        if manifest.packages.is_empty() { "(base only)".to_string() } else { manifest.packages.join(", ") }
    );
    println!("  {} bytes, sha256 {}", manifest.bytes, manifest.sha256);
    println!("  activities: {}", manifest.activities.join(", "));
    for excluded in &manifest.excluded_activities {
        println!(
            "  left out {}: needs {}",
            excluded.profile,
            excluded.missing.join(", ")
        );
    }
    println!("Boot it:");
    println!("  browser: ./run.sh browser   (the gallery lists it as its own machine)");
    println!(
        "  node:    scripts/dev-shell.sh npx tsx scripts/source-rootfs-shell-node-smoke.ts --image {}",
        relative.display()
    );
}

/// The package-owned Vitest files for `packages`, and the packages that have none.
pub(crate) fn package_test_dirs(repo: &Path, packages: &[String]) -> (Vec<PathBuf>, Vec<String>) {
    let mut dirs = Vec::new();
    let mut without = Vec::new();
    for name in packages {
        let dir = repo.join("packages/registry").join(name).join("test");
        if dir.is_dir() {
            dirs.push(dir);
        } else {
            without.push(name.clone());
        }
    }
    (dirs, without)
}

fn run_package_tests(repo: &Path, packages: &[String]) -> Result<(), String> {
    let (dirs, without) = package_test_dirs(repo, packages);
    if !without.is_empty() {
        println!("No package-owned tests for: {}", without.join(", "));
    }
    if dirs.is_empty() {
        return Ok(());
    }
    let mut vitest = Command::new("npx");
    vitest.current_dir(repo.join("host")).args(["vitest", "run"]);
    for dir in &dirs {
        vitest.arg(dir);
    }
    let status = vitest.status().map_err(|error| format!("run vitest: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("package tests failed ({status})"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    fn contract() -> ShellContract {
        ShellContract {
            names: ["fbdoom", "tmux", "ncurses"].iter().map(|name| name.to_string()).collect(),
            resolver_owned: ["fbdoom", "tmux", "ncurses"].iter().map(|name| name.to_string()).collect(),
        }
    }

    #[test]
    fn parses_image_packages_and_flags() {
        let request = parse_args(&args(&["shell", "tmux", "fbdoom", "tmux", "--with-tests"])).unwrap();
        assert_eq!(request.image.product_id, "browser-main-shell");
        assert_eq!(request.packages, vec!["tmux".to_string(), "fbdoom".to_string()]);
        assert!(request.with_tests);
        assert_eq!(parse_args(&args(&["browser-main-shell"])).unwrap().image.name, "shell");
    }

    #[test]
    fn refuses_an_image_without_a_partial_build() {
        let error = parse_args(&args(&["redis", "tmux"])).unwrap_err();
        assert!(error.contains("no partial build for image \"redis\""), "{error}");
        assert!(error.contains("build them normally"), "{error}");
    }

    #[test]
    fn requires_an_image() {
        assert!(parse_args(&args(&[])).unwrap_err().starts_with("usage:"));
        assert!(parse_args(&args(&["--bogus"])).unwrap_err().contains("unknown flag --bogus"));
    }

    #[test]
    fn refuses_a_package_the_shell_does_not_carry() {
        let base: BTreeSet<String> = ["coreutils".to_string()].into();
        let error = check_named_packages(&args(&["tmux", "brand-new"]), &contract(), &base).unwrap_err();
        assert!(error.contains("not in the canonical shell: brand-new"), "{error}");
        assert!(error.contains(SHELL_CONTRACT), "{error}");
        assert!(error.contains(SHELL_MANIFEST), "{error}");
        assert!(error.contains("SHELL_LAZY_BINARY_SPECS"), "{error}");
    }

    #[test]
    fn accepts_a_base_package_by_name() {
        let base: BTreeSet<String> = ["coreutils".to_string()].into();
        assert!(check_named_packages(&args(&["coreutils", "tmux"]), &contract(), &base).is_ok());
    }

    #[test]
    fn reads_the_real_shell_contract() {
        let repo = crate::repo_root();
        let contract = read_shell_contract(&repo).unwrap();
        assert!(contract.names.contains("rootfs"));
        assert!(!contract.resolver_owned.contains("rootfs"));
        assert!(contract.resolver_owned.contains("fbdoom"));
    }

    #[test]
    fn base_is_the_rootfs_closure_plus_ca_certificates() {
        let repo = crate::repo_root();
        let base = base_packages(&Registry::from_env(&repo)).unwrap();
        for name in ["rootfs", "ca-certificates", "bash", "coreutils", "ncurses"] {
            assert!(base.contains(name), "{name} missing from {base:?}");
        }
        assert!(!base.contains("fbdoom"));
    }

    #[test]
    fn manifest_uses_the_documented_field_names() {
        let manifest = PartialManifest {
            schema: 1,
            image: "shell".into(),
            product_id: "browser-main-shell".into(),
            file: "shell-partial.vfs.zst".into(),
            sha256: "00".into(),
            bytes: 1,
            packages: vec!["tmux".into()],
            selection: vec!["rootfs".into(), "tmux".into()],
            activities: vec!["shell".into()],
            excluded_activities: vec![ExcludedActivity { profile: "doom".into(), missing: vec!["fbdoom".into()] }],
            built_at: "2026-11-07T00:00:00Z".into(),
        };
        let value = serde_json::to_value(&manifest).unwrap();
        for key in ["schema", "image", "productId", "file", "sha256", "bytes", "packages", "selection", "activities", "excludedActivities", "builtAt"] {
            assert!(value.get(key).is_some(), "missing {key}");
        }
    }

    #[test]
    fn finds_package_owned_tests() {
        let repo = crate::repo_root();
        let (dirs, without) = package_test_dirs(&repo, &args(&["tmux", "less"]));
        assert_eq!(dirs, vec![repo.join("packages/registry/tmux/test")]);
        assert_eq!(without, vec!["less".to_string()]);
    }
}

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

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::build_deps::Registry;

/// Where partial artifacts live, relative to the repository root.
pub(crate) const PARTIAL_DIR: &str = "local-binaries/partial";
pub(crate) const MANIFEST_NAME: &str = "partial.json";

const SHELL_CONTRACT: &str = "packages/registry/shell/source-rootfs-shell-dependencies.json";
const SHELL_MANIFEST: &str = "packages/registry/shell/package.toml";
const SHELL_BUILD: &str = "packages/registry/shell/build.toml";
const DESCRIBER: &str = "images/vfs/scripts/describe-partial-image.ts";
/// The registry root that shadows `shell` with the partial selection.
const OVERLAY_ROOT: &str = "local-binaries/partial/registry";

/// What a partial build may target: an image that carries the shell, the
/// canonical product it stands in for, the package that builds it, and that
/// package's image output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PartialImage {
    pub name: &'static str,
    pub product_id: &'static str,
    pub package: &'static str,
    pub output: &'static str,
}

/// Every image that embeds the shell. An image without the shell does not pay
/// for it and has no partial build; `images_match_the_product_registry` keeps
/// this table equal to `packages/sets/local-supported.toml`.
pub(crate) const PARTIAL_IMAGES: &[PartialImage] = &[
    PartialImage { name: "shell", product_id: "browser-main-shell", package: "shell", output: "shell.vfs.zst" },
    PartialImage { name: "nginx", product_id: "browser-nginx", package: "nginx-vfs", output: "nginx-vfs.vfs.zst" },
    PartialImage { name: "nginx-php", product_id: "browser-nginx-php", package: "nginx-php-vfs", output: "nginx-php-vfs.vfs.zst" },
    PartialImage { name: "nginx-python", product_id: "browser-nginx-python", package: "nginx-python-vfs", output: "nginx-python-vfs.vfs.zst" },
    PartialImage { name: "wordpress", product_id: "browser-wordpress", package: "wordpress", output: "wordpress.vfs.zst" },
    PartialImage { name: "lamp", product_id: "browser-lamp", package: "lamp", output: "lamp.vfs.zst" },
    PartialImage { name: "web-stack", product_id: "browser-web-stack", package: "web-stack-vfs", output: "web-stack-vfs.vfs.zst" },
    PartialImage { name: "wordpress-family", product_id: "browser-wordpress-family", package: "wordpress-family-vfs", output: "wordpress-family-vfs.vfs.zst" },
];

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
     images: shell, nginx, nginx-php, nginx-python, wordpress, lamp, web-stack, wordpress-family";

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

/// What `describe-partial-image.ts` reads from the built image.
#[derive(Debug, serde::Deserialize)]
struct ImageReport {
    selection: Vec<String>,
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
        if name == MANIFEST_NAME || name == "demo.json" || name == "registry"
            || name.ends_with("-partial.vfs.zst") || name.ends_with(".partial-tmp")
        {
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

/// The `name@version` the canonical shell depends on, for each of `names`.
fn shell_dependency_specs(
    shell_manifest: &str,
    names: &BTreeSet<String>,
) -> Result<Vec<String>, String> {
    let manifest: toml::Value = shell_manifest
        .parse()
        .map_err(|error| format!("parse {SHELL_MANIFEST}: {error}"))?;
    let declared: BTreeMap<String, String> = manifest
        .get("depends_on")
        .and_then(|deps| deps.as_array())
        .ok_or_else(|| format!("{SHELL_MANIFEST} has no depends_on"))?
        .iter()
        .filter_map(|spec| spec.as_str())
        .filter_map(|spec| spec.split_once('@').map(|(name, _)| (name.to_string(), spec.to_string())))
        .collect();
    names
        .iter()
        .map(|name| {
            declared
                .get(name)
                .cloned()
                .ok_or_else(|| format!("{SHELL_MANIFEST} does not depend on {name}"))
        })
        .collect()
}

/// The overlay `shell` recipe: the canonical recipe with `depends_on`
/// narrowed to the selection and the build pointed at the selection.
pub(crate) fn overlay_shell_manifests(
    shell_manifest: &str,
    shell_build: &str,
    depends_on: &[String],
    script_path: &str,
) -> Result<(String, String), String> {
    let mut manifest: toml_edit::DocumentMut = shell_manifest
        .parse()
        .map_err(|error| format!("parse {SHELL_MANIFEST}: {error}"))?;
    let mut deps = toml_edit::Array::new();
    for spec in depends_on {
        deps.push(spec.as_str());
    }
    manifest["depends_on"] = toml_edit::value(deps);
    // The recipe names its build script in both files; both must point at the
    // partial wrapper.
    if manifest.get("build").is_some() {
        manifest["build"]["script_path"] = toml_edit::value(script_path);
    }
    let mut build: toml_edit::DocumentMut = shell_build
        .parse()
        .map_err(|error| format!("parse {SHELL_BUILD}: {error}"))?;
    build["script_path"] = toml_edit::value(script_path);
    Ok((manifest.to_string(), build.to_string()))
}

/// Write the registry root that shadows `shell` with the partial selection.
/// Every other package resolves from the main registry as usual, and every
/// image that depends on `shell` gets the partial one through the normal
/// resolver (and its own cache key).
fn write_overlay(
    repo: &Path,
    contract: &ShellContract,
    selection: &BTreeSet<String>,
) -> Result<PathBuf, String> {
    let root = repo.join(OVERLAY_ROOT);
    let _ = std::fs::remove_dir_all(&root);
    let dir = root.join("shell");
    std::fs::create_dir_all(&dir).map_err(|error| format!("create {}: {error}", dir.display()))?;
    let read = |rel: &str| {
        std::fs::read_to_string(repo.join(rel)).map_err(|error| format!("read {rel}: {error}"))
    };
    // The shell depends on its base image and the selected contract members;
    // the rootfs closure comes with `rootfs`.
    let direct: BTreeSet<String> = selection
        .iter()
        .filter(|name| contract.names.contains(*name))
        .cloned()
        .collect();
    let depends_on = shell_dependency_specs(&read(SHELL_MANIFEST)?, &direct)?;
    let script_rel = format!("{OVERLAY_ROOT}/shell/build-partial-shell.sh");
    let (manifest, build) =
        overlay_shell_manifests(&read(SHELL_MANIFEST)?, &read(SHELL_BUILD)?, &depends_on, &script_rel)?;
    let write = |name: &str, text: &str| {
        std::fs::write(dir.join(name), text).map_err(|error| format!("write {name}: {error}"))
    };
    write("package.toml", &manifest)?;
    write("build.toml", &build)?;
    // The shell's own build inputs (`packages/registry/shell/...`) resolve
    // against whichever registry root provides `shell`, so this root carries
    // them too: byte copies, hashed exactly as the canonical ones are. The
    // build still runs the canonical recipe in packages/registry/shell.
    let build_inputs: toml::Value = read(SHELL_BUILD)?
        .parse()
        .map_err(|error| format!("parse {SHELL_BUILD}: {error}"))?;
    for input in build_inputs
        .get("inputs")
        .and_then(|inputs| inputs.as_array())
        .into_iter()
        .flatten()
        .filter_map(|input| input.as_str())
    {
        let Some(relative) = input.strip_prefix("packages/registry/shell/") else { continue };
        let target = dir.join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("create {}: {error}", parent.display()))?;
        }
        std::fs::copy(repo.join(input), &target)
            .map_err(|error| format!("copy {input}: {error}"))?;
    }
    write(
        "selection.json",
        &serde_json::to_string(&serde_json::json!({ "schema": 1, "packages": selection }))
            .map_err(|error| error.to_string())?,
    )?;
    write(
        "build-partial-shell.sh",
        "#!/usr/bin/env bash\n\
         # Generated by `xtask partial-image`: the canonical shell recipe, composing\n\
         # only the packages in selection.json beside this script.\n\
         set -euo pipefail\n\
         here=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")\" && pwd -P)\"\n\
         repo=\"$(cd \"$here/../../../..\" && pwd -P)\"\n\
         # The resolver seals a recipe to the registry root that owns it. The\n\
         # shell composer reads its members' runtime-file metadata, and those\n\
         # members live in the main registry, so restore the search path this\n\
         # build was configured with: this root, then the main registry.\n\
         export WASM_POSIX_DEPS_REGISTRY=\"$(dirname \"$here\"):$repo/packages/registry\"\n\
         exec bash \"$repo/packages/registry/shell/build-shell.sh\" --selection \"$here/selection.json\"\n",
    )?;
    Ok(root)
}

/// The packages an image needs besides the shell and what embeds it: every
/// dependency, reached from the image package, whose own closure does not
/// include `shell`. The engine builds and publishes these (and their
/// closures) so the image's lazy files are served; the resolver then builds
/// the shell-embedding packages against the partial shell.
fn shell_free_dependencies(registry: &Registry, package: &str) -> Result<BTreeSet<String>, String> {
    fn reaches_shell(
        registry: &Registry,
        name: &str,
        memo: &mut BTreeMap<String, bool>,
    ) -> Result<bool, String> {
        if name == "shell" {
            return Ok(true);
        }
        if let Some(known) = memo.get(name) {
            return Ok(*known);
        }
        memo.insert(name.to_string(), false);
        let mut reaches = false;
        for dep in registry.load(name)?.depends_on {
            reaches |= reaches_shell(registry, &dep.name, memo)?;
        }
        memo.insert(name.to_string(), reaches);
        Ok(reaches)
    }
    let mut memo = BTreeMap::new();
    let mut free = BTreeSet::new();
    let mut pending = vec![package.to_string()];
    let mut seen = BTreeSet::new();
    while let Some(name) = pending.pop() {
        if !seen.insert(name.clone()) || name == "shell" {
            continue;
        }
        for dep in registry.load(&name)?.depends_on {
            if dep.name == "shell" {
                continue;
            }
            if reaches_shell(registry, &dep.name, &mut memo)? {
                pending.push(dep.name);
            } else {
                free.insert(dep.name);
            }
        }
    }
    Ok(free)
}

/// Run this xtask again as `xtask <args>` with the partial registry first.
fn xtask_with_overlay(repo: &Path, overlay: &Path, args: &[&str]) -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|error| format!("locate xtask: {error}"))?;
    let registry_path = format!("{}:{}", overlay.display(), repo.join("packages/registry").display());
    let output = Command::new(exe)
        .current_dir(repo)
        .args(args)
        .env("WASM_POSIX_DEPS_REGISTRY", registry_path)
        .env("WASM_POSIX_RESOLUTION_POLICY", "source-only-v1")
        .stderr(std::process::Stdio::inherit())
        .output()
        .map_err(|error| format!("run xtask {}: {error}", args.join(" ")))?;
    if !output.status.success() {
        return Err(format!("xtask {} failed ({})", args.join(" "), output.status));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
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
    for name in request.packages.iter().filter(|name| base.contains(*name)) {
        eprintln!("partial-image: {name} is already in the base; nothing to add");
    }

    // Build the members: the SDK first (as every package build needs), then
    // the kernel, the selection and the image's other packages in one engine
    // pass, which reuses the shared cache and publishes this worktree's
    // program view so the image's lazy files are served. One pass, not one
    // for the kernel and one for the packages: each pass regenerates the
    // program index and republishes the view, about a minute when cached.
    let jobs = crate::local_build::select_job_count(
        request.jobs.as_deref(),
        std::env::var("WASM_POSIX_LOCAL_BUILD_JOBS").ok().as_deref(),
        std::thread::available_parallelism().ok(),
    )?;
    crate::local_build::run_bootstrap_step(&repo, "sdk", jobs, false, false, Vec::new())?;
    let mut products: BTreeSet<String> = EXTRA_BASE_PACKAGES.iter().map(|name| name.to_string()).collect();
    products.insert("kernel".to_string());
    products.extend(request.packages.iter().filter(|name| !base.contains(*name)).cloned());
    if request.image.package != "shell" {
        products.extend(shell_free_dependencies(&registry, request.image.package)?);
    }
    crate::local_build::run_bootstrap_step(&repo, "engine", jobs, false, false, products.into_iter().collect())?;

    // Build the image through the normal resolver with `shell` shadowed by the
    // partial selection.
    let out_dir = repo.join(PARTIAL_DIR);
    std::fs::create_dir_all(&out_dir)
        .map_err(|error| format!("create {}: {error}", out_dir.display()))?;
    clear_previous(&out_dir)?;
    let overlay = write_overlay(&repo, &contract, &selection)?;
    xtask_with_overlay(&repo, &overlay, &[
        "build-deps", "program-index", "--source-repo-root", &repo.display().to_string(),
        &overlay.display().to_string(), &overlay.join("program-packages.json").display().to_string(),
    ])?;
    eprintln!("partial-image: building {} with the partial shell", request.image.package);
    xtask_with_overlay(&repo, &overlay, &["build-deps", "resolve", request.image.package])?;
    let built_dir = xtask_with_overlay(&repo, &overlay, &["build-deps", "path", request.image.package])?;
    let file_name = image_file_name(&request.image);
    let image_path = out_dir.join(&file_name);
    std::fs::copy(Path::new(&built_dir).join(request.image.output), &image_path)
        .map_err(|error| format!("copy {} from {built_dir}: {error}", request.image.output))?;

    // Describe the image from its own bytes.
    let demo_path = out_dir.join("demo.json");
    let report_path = out_dir.join("report.json.partial-tmp");
    let status = Command::new("node")
        .current_dir(&repo)
        .arg(repo.join("node_modules/tsx/dist/cli.mjs"))
        .arg(repo.join(DESCRIBER))
        .arg("--image").arg(&image_path)
        .arg("--demo-out").arg(&demo_path)
        .arg("--report-out").arg(&report_path)
        .status()
        .map_err(|error| format!("run {DESCRIBER}: {error}"))?;
    if !status.success() {
        return Err(format!("{DESCRIBER} failed ({status})"));
    }
    let report: ImageReport = serde_json::from_slice(
        &std::fs::read(&report_path).map_err(|error| format!("read {}: {error}", report_path.display()))?,
    )
    .map_err(|error| format!("parse image report: {error}"))?;
    let _ = std::fs::remove_file(&report_path);
    let selection_recorded: BTreeSet<String> = report.selection.iter().cloned().collect();
    if selection_recorded != selection {
        return Err(format!(
            "{} records the selection {:?}, not the one requested ({:?})",
            image_path.display(),
            report.selection,
            selection
        ));
    }

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
    println!("  browser: ./run.sh browser --partial   (without the full local-build)");
    println!(
        "  node:    scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/partial-image.test.ts'   ({})",
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
        assert!(parse_args(&args(&["lamp", "tmux"])).is_ok());
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
    fn images_match_the_product_registry() {
        let repo = crate::repo_root();
        let set: toml::Value = std::fs::read_to_string(repo.join("packages/sets/local-supported.toml"))
            .unwrap()
            .parse()
            .unwrap();
        let products = set["products"].as_array().unwrap();
        for image in PARTIAL_IMAGES {
            let product = products
                .iter()
                .find(|product| product["id"].as_str() == Some(image.product_id))
                .unwrap_or_else(|| panic!("{} is not a supported product", image.product_id));
            assert_eq!(product["package"].as_str(), Some(image.package), "{}", image.name);
            let manifest: toml::Value = std::fs::read_to_string(repo.join(product["manifest"].as_str().unwrap()))
                .unwrap()
                .parse()
                .unwrap();
            assert_eq!(manifest["output"].as_str(), Some(image.output), "{}", image.name);
        }
    }

    #[test]
    fn overlay_shell_narrows_only_its_dependencies_and_script() {
        let repo = crate::repo_root();
        let manifest = std::fs::read_to_string(repo.join(SHELL_MANIFEST)).unwrap();
        let build = std::fs::read_to_string(repo.join(SHELL_BUILD)).unwrap();
        let specs = shell_dependency_specs(&manifest, &["rootfs".to_string(), "tmux".to_string()].into()).unwrap();
        assert_eq!(specs, vec!["rootfs@0.1.0".to_string(), "tmux@3.8".to_string()]);
        let (overlay_manifest, overlay_build) =
            overlay_shell_manifests(&manifest, &build, &specs, "local-binaries/partial/registry/shell/build-partial-shell.sh").unwrap();
        let canonical: toml::Value = manifest.parse().unwrap();
        let mut narrowed: toml::Value = overlay_manifest.parse().unwrap();
        assert_eq!(narrowed["depends_on"], toml::Value::Array(specs.iter().cloned().map(toml::Value::String).collect()));
        assert_eq!(narrowed["build"]["script_path"].as_str(), Some("local-binaries/partial/registry/shell/build-partial-shell.sh"));
        narrowed.as_table_mut().unwrap().insert("depends_on".into(), canonical["depends_on"].clone());
        narrowed["build"].as_table_mut().unwrap().insert("script_path".into(), canonical["build"]["script_path"].clone());
        assert_eq!(narrowed, canonical);
        let canonical_build: toml::Value = build.parse().unwrap();
        let mut overlay_build: toml::Value = overlay_build.parse().unwrap();
        assert_eq!(overlay_build["script_path"].as_str(), Some("local-binaries/partial/registry/shell/build-partial-shell.sh"));
        overlay_build.as_table_mut().unwrap().insert("script_path".into(), canonical_build["script_path"].clone());
        assert_eq!(overlay_build, canonical_build);
        assert!(shell_dependency_specs(&manifest, &["not-a-dep".to_string()].into()).is_err());
    }

    #[test]
    fn a_derived_image_prebuilds_everything_but_the_shell() {
        let repo = crate::repo_root();
        let registry = Registry::from_env(&repo);
        let free = shell_free_dependencies(&registry, "lamp").unwrap();
        for name in ["mariadb", "nginx", "php", "dinit", "msmtpd"] {
            assert!(free.contains(name), "{name} missing from {free:?}");
        }
        assert!(!free.contains("shell") && !free.contains("lamp"));
        let family = shell_free_dependencies(&registry, "wordpress-family-vfs").unwrap();
        assert!(!family.contains("lamp") && !family.contains("wordpress"), "{family:?}");
        assert!(family.contains("mariadb"), "{family:?}");
    }

    #[test]
    fn finds_package_owned_tests() {
        let repo = crate::repo_root();
        let (dirs, without) = package_test_dirs(&repo, &args(&["tmux", "less"]));
        assert_eq!(dirs, vec![repo.join("packages/registry/tmux/test")]);
        assert_eq!(without, vec!["less".to_string()]);
    }
}

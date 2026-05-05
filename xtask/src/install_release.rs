//! Consumer side of the the binary release pipeline.
//!
//! Reads a release `manifest.json` and dispatches entries by kind:
//!
//! * `library` entries flow through
//!   [`crate::remote_fetch::fetch_and_install`] into
//!   `<cache>/libs/<canonical>/`. The 4-step compatibility chain
//!   (sha + target_arch + abi_versions + cache_key_sha) verifies on
//!   the way in.
//! * package-system `program` entries (identified by `kind == "program"` AND
//!   `archive_name` field present) flow through the same path into
//!   `<cache>/programs/<canonical>/`, plus declared `[[outputs]]` are
//!   mirrored into `local-binaries/programs/` with the layout the
//!   resolver-override expects (single-output: flat; multi-output:
//!   nested under the program name).
//! * legacy `program` entries (zip archive, NO `archive_name`
//!   field) and other kinds (`kernel`, `userspace`, `vfs-image`) are
//!   skipped — `scripts/fetch-binaries.sh`'s legacy
//!   symlink-into-`binaries/` codepath handles those (E.7 will wire
//!   it).
//!
//! Compat mismatches are HARD ERRORS here, unlike the resolver's
//! silent fall-through. The caller invoked `install-release`
//! explicitly; if a published archive disagrees with what the local
//! consumer expects, it should fail loudly so a stale manifest can be
//! diagnosed.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use wasm_posix_shared as shared;

use crate::build_deps::{
    self, canonical_path, default_cache_root, parse_target_arch, Registry,
};
use crate::pkg_manifest::{Binary, DepsManifest, ManifestKind, TargetArch};
use crate::remote_fetch;
use crate::repo_root;
use crate::util::hex;

/// One row written to `--stale-out` when `--allow-stale-manifest` is
/// set and a manifest entry's `compatibility.cache_key_sha` disagrees
/// with the locally-computed value. The downstream caller (Task 3's
/// `fetch-binaries.sh`) reads this list to decide which entries to
/// source-build instead of fetching.
///
/// Schema is load-bearing — the script consumes `program`, `arch`,
/// `local_sha` by exact name. Don't rename without updating Task 3.
#[derive(Serialize)]
struct StaleEntry {
    program: String,
    arch: String,
    local_sha: String,
}

/// Parsed CLI options for `install-release`.
///
/// Extracted from `run` so the parser is independently testable. The
/// fields are intentionally `Option<_>` where `run` later applies
/// defaults — keeping that distinction here lets tests assert "the
/// user did not pass this flag" vs "the user passed the default value".
struct InstallReleaseOpts {
    manifest_path: Option<PathBuf>,
    archive_base: Option<String>,
    cache_root: Option<PathBuf>,
    local_binaries_dir: Option<PathBuf>,
    binaries_dir: Option<PathBuf>,
    registry_root: Option<PathBuf>,
    abi: Option<u32>,
    force_mirror: bool,
    /// Set by `--allow-stale-manifest`. When true, a manifest entry
    /// whose `compatibility.cache_key_sha` disagrees with the
    /// locally-computed value is skipped (and recorded for the
    /// downstream source-build fallback) rather than aborting the run.
    allow_stale_manifest: bool,
    /// Set by `--stale-out <path>`. Path to write a JSON report of
    /// stale entries collected during the run. Only consulted when
    /// `allow_stale_manifest` is also set; the empty `[]` case is still
    /// written so callers can detect that the install ran in
    /// stale-tolerant mode.
    stale_out: Option<PathBuf>,
}

fn parse_args(args: Vec<String>) -> Result<InstallReleaseOpts, String> {
    let mut manifest_path: Option<PathBuf> = None;
    let mut archive_base: Option<String> = None;
    let mut cache_root: Option<PathBuf> = None;
    let mut local_binaries_dir: Option<PathBuf> = None;
    let mut binaries_dir: Option<PathBuf> = None;
    let mut registry_root: Option<PathBuf> = None;
    let mut abi: Option<u32> = None;
    let mut force_mirror = false;
    let mut allow_stale_manifest = false;
    let mut stale_out: Option<PathBuf> = None;

    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--manifest" => {
                manifest_path = Some(it.next().ok_or("--manifest requires path")?.into())
            }
            "--archive-base" => {
                archive_base =
                    Some(it.next().ok_or("--archive-base requires url or dir")?)
            }
            "--cache-root" => {
                cache_root = Some(it.next().ok_or("--cache-root requires path")?.into())
            }
            "--local-binaries-dir" => {
                local_binaries_dir =
                    Some(it.next().ok_or("--local-binaries-dir requires path")?.into())
            }
            "--binaries-dir" => {
                binaries_dir =
                    Some(it.next().ok_or("--binaries-dir requires path")?.into())
            }
            "--registry" => {
                registry_root = Some(it.next().ok_or("--registry requires path")?.into())
            }
            "--abi" => {
                abi = Some(
                    it.next()
                        .ok_or("--abi requires <u32>")?
                        .parse()
                        .map_err(|e| format!("--abi: {e}"))?,
                )
            }
            "--force-mirror" => force_mirror = true,
            "--allow-stale-manifest" => allow_stale_manifest = true,
            "--stale-out" => {
                stale_out = Some(it.next().ok_or("--stale-out requires path")?.into())
            }
            other => return Err(format!("unknown arg {other:?}")),
        }
    }

    Ok(InstallReleaseOpts {
        manifest_path,
        archive_base,
        cache_root,
        local_binaries_dir,
        binaries_dir,
        registry_root,
        abi,
        force_mirror,
        allow_stale_manifest,
        stale_out,
    })
}

pub fn run(args: Vec<String>) -> Result<(), String> {
    let InstallReleaseOpts {
        manifest_path,
        archive_base,
        cache_root,
        local_binaries_dir,
        binaries_dir,
        registry_root,
        abi,
        force_mirror,
        allow_stale_manifest,
        stale_out,
    } = parse_args(args)?;

    let manifest_path = manifest_path.ok_or("--manifest is required")?;
    let archive_base =
        archive_base.ok_or("--archive-base is required (file:///… or https://…)")?;
    let cache_root = cache_root.unwrap_or_else(default_cache_root);
    let local_binaries_dir =
        local_binaries_dir.unwrap_or_else(|| repo_root().join("local-binaries"));
    let registry = if let Some(r) = registry_root {
        Registry { roots: vec![r] }
    } else {
        Registry::from_env(&repo_root())
    };
    let abi = abi.unwrap_or(shared::ABI_VERSION);

    let manifest_text = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("read {}: {e}", manifest_path.display()))?;
    let manifest: Value = serde_json::from_str(&manifest_text)
        .map_err(|e| format!("parse {}: {e}", manifest_path.display()))?;
    let entries = manifest["entries"]
        .as_array()
        .ok_or("manifest.entries missing or not an array")?;

    // Stale-but-tolerated entries collected during the per-entry loop
    // when `--allow-stale-manifest` is set. The list is serialized to
    // `--stale-out` after the loop so a downstream caller (Task 3:
    // `fetch-binaries.sh`) can source-build the affected programs
    // instead of fetching them. The empty case is meaningful — see the
    // post-loop write block.
    let mut stale_entries: Vec<StaleEntry> = Vec::new();

    for entry in entries {
        let kind = entry.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        if !matches!(kind, "library" | "program") {
            // Skip kernel / userspace / vfs-image — fetch-binaries.sh
            // handles those via its existing symlink codepath.
            continue;
        }
        // Identify archive entries by the presence of `archive_name`. legacy
        // entries (zip-vintage program bundles) are skipped here and
        // remain the responsibility of fetch-binaries.sh.
        let Some(archive_name) =
            entry.get("archive_name").and_then(|v| v.as_str())
        else {
            continue;
        };
        // archive entries also carry a `compatibility` block. Defensive
        // check: if a future schema change drops this we don't want to
        // silently install the wrong shape.
        if entry.get("compatibility").is_none() {
            continue;
        }
        let archive_sha = entry
            .get("archive_sha256")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("entry missing archive_sha256: {entry}"))?
            .to_string();
        let program_name = entry
            .get("program")
            .and_then(|v| v.as_str())
            .ok_or("entry missing program")?;
        let arch_str = entry
            .get("arch")
            .and_then(|v| v.as_str())
            .ok_or("entry missing arch")?;
        let arch = parse_target_arch(arch_str)?;

        let m = registry
            .load(program_name)
            .map_err(|e| format!("registry.load({program_name}): {e}"))?;

        let kind_subdir = match m.kind {
            ManifestKind::Library => "libs",
            ManifestKind::Program => "programs",
            // Source-kind manifests don't appear in release manifests
            // (stage_release skips them), but be defensive: if the
            // manifest claims kind=library/program for a registry entry
            // that's actually source, skip rather than crash.
            ManifestKind::Source => continue,
        };
        let archive_url = build_archive_url(&archive_base, kind_subdir, archive_name)?;

        // Compute the local cache_key_sha; canonical_path uses it, and
        // it's the strict-equivalence anchor for the compat check.
        let mut chain: Vec<String> = Vec::new();
        let mut memo: BTreeMap<String, [u8; 32]> = BTreeMap::new();
        let local_sha_bytes =
            build_deps::compute_sha(&m, &registry, arch, abi, &mut memo, &mut chain)
                .map_err(|e| format!("compute_sha for {program_name}/{arch_str}: {e}"))?;
        let local_sha_hex = hex(&local_sha_bytes);
        let canonical = canonical_path(&cache_root, &m, arch, &local_sha_bytes);

        // Pre-flight: the manifest's compatibility block must match
        // what we'd compute locally. This catches a stale manifest.json
        // (wrong cache_key_sha formula, stale revision, etc.) BEFORE
        // we waste time fetching the archive — and surfaces it with a
        // clearer error than the deeper mismatch the resolver would
        // produce. Unlike the resolver's silent fall-through, the
        // caller here invoked install explicitly.
        let manifest_compat_sha = entry
            .get("compatibility")
            .and_then(|c| c.get("cache_key_sha"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if manifest_compat_sha != local_sha_hex {
            // `--allow-stale-manifest` downgrades the strict equality
            // failure to a recorded skip. The entry is NOT installed:
            // no archive fetch, no canonical-path file, no
            // local-binaries mirror, no `binaries/` symlink. Task 3's
            // `fetch-binaries.sh` will re-source-build these from the
            // recorded list.
            if allow_stale_manifest {
                eprintln!(
                    "skip {program_name} ({arch_str}) — manifest stale \
                     (manifest={manifest_compat_sha}, local={local_sha_hex}); \
                     will source-build later"
                );
                stale_entries.push(StaleEntry {
                    program: program_name.to_string(),
                    arch: arch_str.to_string(),
                    local_sha: local_sha_hex.clone(),
                });
                continue;
            }
            return Err(format!(
                "{program_name} ({arch_str}): manifest.json cache_key_sha {manifest_compat_sha:?} \
                 does not match locally-computed {local_sha_hex:?} — \
                 the manifest is stale relative to this consumer's package.toml",
            ));
        }

        let installed_fresh = if !canonical.exists() {
            // Fetch + install. Compat mismatches surface as Err here.
            let bin = Binary {
                archive_url,
                archive_sha256: archive_sha,
            };
            remote_fetch::fetch_and_install(
                &bin,
                &canonical,
                &m,
                arch,
                abi,
                &local_sha_hex,
            )
            .map_err(|e| format!("install {program_name} ({arch_str}): {e}"))?;
            eprintln!("installed {}", canonical.display());
            true
        } else {
            eprintln!("skip {} (already in cache)", canonical.display());
            false
        };

        // Mirror programs to local-binaries/ ONLY when we actually
        // performed an install (i.e. not on a cache hit). Mirroring on
        // every run wastes I/O and — more importantly for multi-output
        // programs like git — can interleave files from different
        // builds if a reader observes the dir mid-update. The
        // --force-mirror escape hatch covers the case where a developer
        // manually edited local-binaries/ and wants it re-populated
        // without busting the cache.
        if matches!(m.kind, ManifestKind::Program) && (installed_fresh || force_mirror) {
            mirror_program_outputs(&m, &canonical, &local_binaries_dir, arch)?;
        }

        // Symlink each declared output into
        // <binaries_dir>/programs/<arch>/ when --binaries-dir is
        // supplied. fetch-binaries.sh passes this so consumer Vite
        // imports of `@binaries/programs/<arch>/<x>` find the
        // fetched bytes via the cache canonical path. Symlinks are
        // always (re)placed — they're cheap, atomic, and make the
        // binaries/ tree mirror the cache's current state.
        //
        // The per-arch subdirectory is load-bearing: a multi-arch
        // program (e.g. mariadb-vfs ships both wasm32 and wasm64)
        // would otherwise last-write-wins on a flat
        // `binaries/programs/<x>` symlink and silently point
        // consumers at the wrong arch. The per-arch layout mirrors
        // the resolver cache's per-arch canonical paths.
        if let Some(bdir) = binaries_dir.as_deref() {
            if matches!(m.kind, ManifestKind::Program) {
                place_binaries_symlinks(&m, &canonical, bdir, arch)?;
            }
        }
    }

    // When `--stale-out` is supplied AND `--allow-stale-manifest` is
    // on, write the collected list as JSON. We always write in that
    // mode — even when the list is empty — so the file's existence
    // is a robust signal to the downstream caller (Task 3:
    // `fetch-binaries.sh`) that the install ran in stale-tolerant
    // mode. An empty `[]` means "no entries needed source-build
    // fallback." `--stale-out` without `--allow-stale-manifest` is a
    // no-op rather than an error: the strict path will already have
    // returned `Err` on any mismatch, so an empty file would be
    // misleading.
    if let Some(path) = stale_out.as_ref().filter(|_| allow_stale_manifest) {
        let json = serde_json::to_string_pretty(&stale_entries)
            .map_err(|e| format!("serialize stale_entries: {e}"))?;
        fs::write(path, json)
            .map_err(|e| format!("write {}: {e}", path.display()))?;
    }

    Ok(())
}

/// Construct the archive URL the consumer should fetch.
///
/// `base` may be one of:
///   * `http(s)://…` — used as a flat URL prefix; assets are flat in
///     GitHub releases (`gh release create` ignores the source path
///     and uses each asset's basename), so the result is
///     `{base}/{archive_name}` — no `kind_subdir` segment.
///   * `file://…` or absolute path — points at a `release-staging/`
///     directory laid out by `xtask stage-release`, which keeps
///     archives in `libs/` and `programs/` subdirectories. Result is
///     `{base}/{kind_subdir}/{archive_name}`. Relative paths are
///     rejected because the resulting URL would depend on the
///     resolver's cwd.
fn build_archive_url(
    base: &str,
    kind_subdir: &str,
    archive_name: &str,
) -> Result<String, String> {
    if base.starts_with("http://") || base.starts_with("https://") {
        let trimmed = base.trim_end_matches('/');
        Ok(format!("{trimmed}/{archive_name}"))
    } else if base.starts_with("file://") {
        let trimmed = base.trim_end_matches('/');
        Ok(format!("{trimmed}/{kind_subdir}/{archive_name}"))
    } else {
        let p = Path::new(base);
        if !p.is_absolute() {
            return Err(format!(
                "--archive-base {base:?} must be absolute when no scheme is provided"
            ));
        }
        Ok(format!(
            "file://{}/{kind_subdir}/{archive_name}",
            p.display()
        ))
    }
}

/// Copy each declared `[[outputs]]` wasm from the cache into
/// `local-binaries/programs/<arch>/`.
///
/// Layout (per arch — wasm32 and wasm64 mirror in parallel):
///
///   * 1 output: `<local_binaries>/programs/<arch>/<output.name>.wasm`.
///   * ≥2 outputs: `<local_binaries>/programs/<arch>/<program.name>/<output.name>.wasm`.
///
/// Atomic copy via tmp + rename so a crash mid-copy doesn't expose a
/// partial file at the destination.
fn mirror_program_outputs(
    m: &DepsManifest,
    canonical: &Path,
    local_binaries_dir: &Path,
    arch: TargetArch,
) -> Result<(), String> {
    let outputs = &m.program_outputs;
    if outputs.is_empty() {
        return Err(format!("program {:?} has no [[outputs]]", m.name));
    }
    let arch_root = local_binaries_dir.join("programs").join(arch.as_str());
    let dest_dir = if outputs.len() > 1 {
        arch_root.join(&m.name)
    } else {
        arch_root
    };
    fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("mkdir {}: {e}", dest_dir.display()))?;
    for out in outputs {
        let src = canonical.join(&out.wasm);
        if !src.is_file() {
            return Err(format!(
                "declared output {} not found in cache at {}",
                out.wasm,
                src.display()
            ));
        }
        // Preserve the source file's extension(s) so `.vfs.zst`,
        // `.wasm`, `.zip`, etc. all round-trip. Take everything from
        // the FIRST `.` onward as the extension chunk so double
        // extensions like `.vfs.zst` survive intact.
        //
        //   out.wasm = "python.wasm"     → ext = ".wasm"
        //                                  dest = "<out.name>.wasm"
        //   out.wasm = "shell.vfs.zst"   → ext = ".vfs.zst"
        //                                  dest = "<out.name>.vfs.zst"
        //   out.wasm = "git.wasm"        → ext = ".wasm"
        //                                  dest = "<out.name>.wasm"
        let basename = std::path::Path::new(&out.wasm)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(&out.wasm);
        let ext = match basename.find('.') {
            Some(i) => &basename[i..],
            None => "",
        };
        let dest_name = format!("{}{}", out.name, ext);
        let dest = dest_dir.join(&dest_name);
        // PID suffix matches the convention used in remote_fetch /
        // archive_stage: lets two install-release runs sharing a
        // --local-binaries-dir not race on the same .tmp filename.
        let tmp_name = format!("{}.tmp-{}", dest_name, std::process::id());
        let tmp = dest_dir.join(&tmp_name);
        fs::copy(&src, &tmp).map_err(|e| {
            format!("copy {} -> {}: {e}", src.display(), tmp.display())
        })?;
        fs::rename(&tmp, &dest).map_err(|e| {
            format!("rename {} -> {}: {e}", tmp.display(), dest.display())
        })?;
    }
    Ok(())
}

/// Place symlinks under `binaries_dir/programs/` pointing at each
/// declared `[[outputs]]` wasm in the cache canonical directory.
///
/// Layout mirrors `mirror_program_outputs`:
///
///   * 1 output: `<binaries_dir>/programs/<output.name>.<ext>`.
///   * ≥2 outputs: `<binaries_dir>/programs/<program.name>/<output.name>.<ext>`.
///
/// Targets are absolute paths into the resolver cache. The cache and
/// the symlink layer have the same lifetime in practice (both grow
/// from `fetch-binaries.sh` runs), so a dangling symlink would mean
/// the cache was wiped — the user wants to re-fetch anyway.
///
/// Replace-in-place is safe: we `remove + symlink` rather than try to
/// detect "already correct". Symlinks are tiny and atomic; correctness
/// trumps a microsecond saved on a no-op.
fn place_binaries_symlinks(
    m: &DepsManifest,
    canonical: &Path,
    binaries_dir: &Path,
    arch: TargetArch,
) -> Result<(), String> {
    let outputs = &m.program_outputs;
    if outputs.is_empty() {
        return Err(format!("program {:?} has no [[outputs]]", m.name));
    }
    let arch_root = binaries_dir.join("programs").join(arch.as_str());
    let dest_dir = if outputs.len() > 1 {
        arch_root.join(&m.name)
    } else {
        arch_root
    };
    fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("mkdir {}: {e}", dest_dir.display()))?;
    for out in outputs {
        let src = canonical.join(&out.wasm);
        if !src.is_file() {
            return Err(format!(
                "declared output {} not found in cache at {}",
                out.wasm,
                src.display()
            ));
        }
        // Match mirror_program_outputs's filename convention: keep
        // every dot-extension chunk (`.vfs.zst`, `.tar.gz`, etc.).
        let basename = std::path::Path::new(&out.wasm)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(&out.wasm);
        let ext = match basename.find('.') {
            Some(i) => &basename[i..],
            None => "",
        };
        let dest_name = format!("{}{}", out.name, ext);
        let dest = dest_dir.join(&dest_name);
        // Replace-in-place: remove any existing entry (file or
        // symlink), then create a fresh symlink. Skipping the remove
        // step would cause `symlink` to fail with EEXIST if the
        // destination already exists.
        if dest.exists() || dest.symlink_metadata().is_ok() {
            let _ = fs::remove_file(&dest);
        }
        std::os::unix::fs::symlink(&src, &dest).map_err(|e| {
            format!(
                "symlink {} -> {}: {e}",
                dest.display(),
                src.display()
            )
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pkg_manifest::TargetArch;

    fn tempdir(label: &str) -> PathBuf {
        let p = std::env::temp_dir()
            .join("wpk-xtask-install-release")
            .join(format!("{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// Drop a `<name>/package.toml` + executable build script under
    /// `registry`. The build script emits whatever `body` says using
    /// the standard env-var contract. `outputs_section` is the TOML
    /// block (caller writes the table or array-of-tables shape).
    fn write_fixture(
        registry: &Path,
        name: &str,
        version: &str,
        kind: &str,
        body: &str,
        outputs_section: &str,
    ) {
        let lib_dir = registry.join(name);
        fs::create_dir_all(&lib_dir).unwrap();
        let toml = format!(
            r#"
kind = "{kind}"
name = "{name}"
version = "{version}"
revision = 1
depends_on = []

[source]
url = "https://example.test/{name}-{version}.tar.gz"
sha256 = "{:0>64}"

[license]
spdx = "TestLicense"

{outputs_section}
"#,
            ""
        );
        fs::write(lib_dir.join("package.toml"), toml).unwrap();
        let script_path = lib_dir.join(format!("build-{name}.sh"));
        let script = format!("#!/bin/bash\nset -euo pipefail\n{body}\n");
        fs::write(&script_path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut p = fs::metadata(&script_path).unwrap().permissions();
            p.set_mode(0o755);
            fs::set_permissions(&script_path, p).unwrap();
        }
    }

    /// Run stage_release with isolated dirs; return (staging dir,
    /// registry dir, cache dir).
    fn stage(
        label: &str,
        manifest_setup: impl FnOnce(&Path),
    ) -> (PathBuf, PathBuf, PathBuf) {
        let dir = tempdir(label);
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        let staging = dir.join("staging");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();
        manifest_setup(&registry);

        crate::stage_release::run(vec![
            "--staging".into(),
            staging.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--cache-root".into(),
            cache_root.display().to_string(),
            "--abi".into(),
            "4".into(),
            "--arch".into(),
            "wasm32".into(),
            "--build-timestamp".into(),
            "2026-04-26T00:00:00Z".into(),
            "--build-host".into(),
            "test-host".into(),
        ])
        .expect("stage_release must succeed");

        (staging, registry, cache_root)
    }

    #[test]
    fn install_release_routes_library_entry_into_cache() {
        let (staging, registry, _stage_cache) = stage("lib-route", |registry| {
            write_fixture(
                registry,
                "z",
                "1.0.0",
                "library",
                "mkdir -p $WASM_POSIX_DEP_OUT_DIR/lib && \
                 echo zdata > $WASM_POSIX_DEP_OUT_DIR/lib/libZ.a",
                "[outputs]\nlibs = [\"lib/libZ.a\"]\n",
            );
        });

        // Isolated install cache — proves install_release populates from
        // the staging archives, not from the producer's cache.
        let install_cache = tempdir("lib-route-install-cache");
        let local_bin = tempdir("lib-route-local-bin");

        super::run(vec![
            "--manifest".into(),
            staging.join("manifest.json").display().to_string(),
            "--archive-base".into(),
            format!("file://{}", staging.display()),
            "--cache-root".into(),
            install_cache.display().to_string(),
            "--local-binaries-dir".into(),
            local_bin.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--abi".into(),
            "4".into(),
        ])
        .expect("install_release must succeed");

        // Compute the canonical path the consumer should have produced.
        let reg = Registry {
            roots: vec![registry.clone()],
        };
        let m = reg.load("z").unwrap();
        let mut chain = Vec::new();
        let mut memo = BTreeMap::new();
        let sha = build_deps::compute_sha(&m, &reg, TargetArch::Wasm32, 4, &mut memo, &mut chain)
            .unwrap();
        let canonical = canonical_path(&install_cache, &m, TargetArch::Wasm32, &sha);
        assert!(
            canonical.is_dir(),
            "expected canonical lib path {}",
            canonical.display()
        );
        let lib = canonical.join("lib/libZ.a");
        assert!(lib.is_file(), "expected {} to exist", lib.display());
        let bytes = fs::read(&lib).unwrap();
        assert_eq!(bytes, b"zdata\n");
    }

    #[test]
    fn install_release_mirrors_program_outputs_to_local_binaries_single_output() {
        let (staging, registry, _stage_cache) = stage("prog-single", |registry| {
            write_fixture(
                registry,
                "myprog",
                "0.1.0",
                "program",
                "mkdir -p $WASM_POSIX_DEP_OUT_DIR/bin && \
                 echo p1 > $WASM_POSIX_DEP_OUT_DIR/bin/myprog.wasm",
                "[[outputs]]\nname = \"myprog\"\nwasm = \"bin/myprog.wasm\"\n",
            );
        });

        let install_cache = tempdir("prog-single-install-cache");
        let local_bin = tempdir("prog-single-local-bin");

        super::run(vec![
            "--manifest".into(),
            staging.join("manifest.json").display().to_string(),
            "--archive-base".into(),
            format!("file://{}", staging.display()),
            "--cache-root".into(),
            install_cache.display().to_string(),
            "--local-binaries-dir".into(),
            local_bin.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--abi".into(),
            "4".into(),
        ])
        .expect("install_release must succeed");

        let mirror = local_bin.join("programs/wasm32/myprog.wasm");
        assert!(mirror.is_file(), "expected {} to exist", mirror.display());
        assert_eq!(fs::read(&mirror).unwrap(), b"p1\n");

        // Multi-output dir layout MUST NOT be present for a single-output
        // program. Catches regressions where every program ends up nested.
        assert!(
            !local_bin.join("programs/wasm32/myprog/myprog.wasm").exists(),
            "single-output program must use flat layout, not nested"
        );
        // The legacy arch-agnostic path must NOT exist — every consumer
        // must select an arch explicitly.
        assert!(
            !local_bin.join("programs/myprog.wasm").exists(),
            "flat (non-arch) path must not be populated"
        );
    }

    #[test]
    fn install_release_places_binaries_symlinks_when_binaries_dir_set() {
        let (staging, registry, _stage_cache) = stage("bdir-single", |registry| {
            write_fixture(
                registry,
                "fixprog",
                "0.1.0",
                "program",
                "mkdir -p $WASM_POSIX_DEP_OUT_DIR/bin && \
                 echo bdata > $WASM_POSIX_DEP_OUT_DIR/bin/fixprog.wasm",
                "[[outputs]]\nname = \"fixprog\"\nwasm = \"bin/fixprog.wasm\"\n",
            );
        });

        let install_cache = tempdir("bdir-single-cache");
        let local_bin = tempdir("bdir-single-local");
        let bdir = tempdir("bdir-single-binaries");

        super::run(vec![
            "--manifest".into(),
            staging.join("manifest.json").display().to_string(),
            "--archive-base".into(),
            format!("file://{}", staging.display()),
            "--cache-root".into(),
            install_cache.display().to_string(),
            "--local-binaries-dir".into(),
            local_bin.display().to_string(),
            "--binaries-dir".into(),
            bdir.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--abi".into(),
            "4".into(),
        ])
        .expect("install_release must succeed");

        let link = bdir.join("programs/wasm32/fixprog.wasm");
        let meta = fs::symlink_metadata(&link).expect("symlink metadata");
        assert!(
            meta.file_type().is_symlink(),
            "{} should be a symlink",
            link.display()
        );
        // Target should resolve into the cache canonical path and be
        // readable. The contents come from the build script we wrote.
        assert_eq!(fs::read(&link).unwrap(), b"bdata\n");
        // Arch-agnostic path must not be created.
        assert!(
            !bdir.join("programs/fixprog.wasm").exists(),
            "flat (non-arch) symlink path must not be populated"
        );
    }

    #[test]
    fn install_release_places_binaries_symlinks_multi_output_uses_nested_layout() {
        let (staging, registry, _stage_cache) = stage("bdir-multi", |registry| {
            write_fixture(
                registry,
                "fixmulti",
                "0.1.0",
                "program",
                "mkdir -p $WASM_POSIX_DEP_OUT_DIR/bin && \
                 echo a > $WASM_POSIX_DEP_OUT_DIR/bin/a.wasm && \
                 echo b > $WASM_POSIX_DEP_OUT_DIR/bin/b.wasm",
                "[[outputs]]\nname = \"a\"\nwasm = \"bin/a.wasm\"\n\
                 [[outputs]]\nname = \"b\"\nwasm = \"bin/b.wasm\"\n",
            );
        });

        let install_cache = tempdir("bdir-multi-cache");
        let local_bin = tempdir("bdir-multi-local");
        let bdir = tempdir("bdir-multi-binaries");

        super::run(vec![
            "--manifest".into(),
            staging.join("manifest.json").display().to_string(),
            "--archive-base".into(),
            format!("file://{}", staging.display()),
            "--cache-root".into(),
            install_cache.display().to_string(),
            "--local-binaries-dir".into(),
            local_bin.display().to_string(),
            "--binaries-dir".into(),
            bdir.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--abi".into(),
            "4".into(),
        ])
        .expect("install_release must succeed");

        // Multi-output programs nest under a per-program subdir, inside
        // the per-arch subtree.
        assert!(
            bdir.join("programs/wasm32/fixmulti/a.wasm").is_symlink_or_file(),
            "expected nested a.wasm symlink"
        );
        assert!(
            bdir.join("programs/wasm32/fixmulti/b.wasm").is_symlink_or_file(),
            "expected nested b.wasm symlink"
        );
        assert!(
            !bdir.join("programs/wasm32/a.wasm").exists(),
            "multi-output program must NOT use flat layout (per arch)"
        );
        assert!(
            !bdir.join("programs/fixmulti/a.wasm").exists(),
            "arch-agnostic path must not be populated"
        );
        // Symlinks are readable through to the cache contents.
        assert_eq!(fs::read(bdir.join("programs/wasm32/fixmulti/a.wasm")).unwrap(), b"a\n");
        assert_eq!(fs::read(bdir.join("programs/wasm32/fixmulti/b.wasm")).unwrap(), b"b\n");
    }

    /// Tiny shim to keep the test assertions readable. `fs::Path` doesn't
    /// have a single "is symlink OR is file" so we wrap.
    trait IsSymlinkOrFile {
        fn is_symlink_or_file(&self) -> bool;
    }
    impl IsSymlinkOrFile for std::path::PathBuf {
        fn is_symlink_or_file(&self) -> bool {
            match fs::symlink_metadata(self) {
                Ok(meta) => meta.file_type().is_symlink() || meta.is_file(),
                Err(_) => false,
            }
        }
    }

    #[test]
    fn install_release_mirrors_program_outputs_to_local_binaries_multi_output() {
        let (staging, registry, _stage_cache) = stage("prog-multi", |registry| {
            write_fixture(
                registry,
                "git",
                "1.0.0",
                "program",
                "mkdir -p $WASM_POSIX_DEP_OUT_DIR/bin && \
                 echo gitdata > $WASM_POSIX_DEP_OUT_DIR/bin/git.wasm && \
                 echo httpdata > $WASM_POSIX_DEP_OUT_DIR/bin/git-remote-http.wasm",
                "[[outputs]]\nname = \"git\"\nwasm = \"bin/git.wasm\"\n\
                 [[outputs]]\nname = \"git-remote-http\"\nwasm = \"bin/git-remote-http.wasm\"\n",
            );
        });

        let install_cache = tempdir("prog-multi-install-cache");
        let local_bin = tempdir("prog-multi-local-bin");

        super::run(vec![
            "--manifest".into(),
            staging.join("manifest.json").display().to_string(),
            "--archive-base".into(),
            format!("file://{}", staging.display()),
            "--cache-root".into(),
            install_cache.display().to_string(),
            "--local-binaries-dir".into(),
            local_bin.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--abi".into(),
            "4".into(),
        ])
        .expect("install_release must succeed");

        let m1 = local_bin.join("programs/wasm32/git/git.wasm");
        let m2 = local_bin.join("programs/wasm32/git/git-remote-http.wasm");
        assert!(m1.is_file(), "expected {} to exist", m1.display());
        assert!(m2.is_file(), "expected {} to exist", m2.display());
        assert_eq!(fs::read(&m1).unwrap(), b"gitdata\n");
        assert_eq!(fs::read(&m2).unwrap(), b"httpdata\n");

        // Flat layout MUST NOT be used for multi-output programs.
        assert!(!local_bin.join("programs/wasm32/git.wasm").exists());
        assert!(!local_bin.join("programs/git/git.wasm").exists());
    }

    #[test]
    fn install_release_rejects_compat_mismatch() {
        let (staging, registry, _stage_cache) = stage("compat-mismatch", |registry| {
            write_fixture(
                registry,
                "z",
                "1.0.0",
                "library",
                "mkdir -p $WASM_POSIX_DEP_OUT_DIR/lib && \
                 echo zdata > $WASM_POSIX_DEP_OUT_DIR/lib/libZ.a",
                "[outputs]\nlibs = [\"lib/libZ.a\"]\n",
            );
        });

        // Hand-edit the manifest.json to corrupt cache_key_sha.
        let manifest_path = staging.join("manifest.json");
        let text = fs::read_to_string(&manifest_path).unwrap();
        let mut json: Value = serde_json::from_str(&text).unwrap();
        let entries = json["entries"].as_array_mut().unwrap();
        for entry in entries.iter_mut() {
            if entry.get("archive_name").is_some() {
                entry["compatibility"]["cache_key_sha"] =
                    Value::String("0".repeat(64));
            }
        }
        fs::write(&manifest_path, serde_json::to_string_pretty(&json).unwrap())
            .unwrap();

        let install_cache = tempdir("compat-mismatch-install-cache");
        let local_bin = tempdir("compat-mismatch-local-bin");

        let err = super::run(vec![
            "--manifest".into(),
            manifest_path.display().to_string(),
            "--archive-base".into(),
            format!("file://{}", staging.display()),
            "--cache-root".into(),
            install_cache.display().to_string(),
            "--local-binaries-dir".into(),
            local_bin.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--abi".into(),
            "4".into(),
        ])
        .expect_err("install_release must reject corrupt cache_key_sha");

        // The pre-flight check compares the manifest's cache_key_sha to
        // the locally-computed value before doing any fetching, so the
        // error surfaces at that boundary.
        assert!(
            err.contains("cache_key_sha") || err.contains("mismatch") || err.contains("stale"),
            "error must name the corrupted axis, got: {err}"
        );
    }

    #[test]
    fn install_release_skips_v1_program_zip() {
        // Hand-craft a manifest with a single legacy entry: kind=program,
        // NO archive_name. install_release must Ok and leave both the
        // cache and local-binaries untouched.
        let dir = tempdir("v1-skip");
        let install_cache = dir.join("install-cache");
        let local_bin = dir.join("local-bin");
        let registry = dir.join("registry");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&install_cache).unwrap();
        fs::create_dir_all(&local_bin).unwrap();

        let manifest = serde_json::json!({
            "abi_version": 4,
            "release_tag": "binaries-abi-v4",
            "generated_at": "2026-04-26T00:00:00Z",
            "generator": "test",
            "entries": [
                {
                    "name": "vim-9.1.0900-rev1-deadbeef.zip",
                    "program": "vim",
                    "kind": "program",
                    "arch": "wasm32",
                    "upstream_version": "9.1.0900",
                    "revision": 1,
                    "size": 0,
                    "sha256": "0".repeat(64),
                    "abi_version": 4,
                    "source": {"url": "https://example.test/vim.tar.gz", "sha256": "0".repeat(64)},
                    "license": {"spdx": "Vim", "url": null},
                    "advisories": []
                }
            ]
        });
        let manifest_path = dir.join("manifest.json");
        fs::write(&manifest_path, serde_json::to_string_pretty(&manifest).unwrap())
            .unwrap();

        super::run(vec![
            "--manifest".into(),
            manifest_path.display().to_string(),
            "--archive-base".into(),
            format!("file://{}/staging-not-used", dir.display()),
            "--cache-root".into(),
            install_cache.display().to_string(),
            "--local-binaries-dir".into(),
            local_bin.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--abi".into(),
            "4".into(),
        ])
        .expect("install_release must Ok with legacy entry skipped");

        // Cache root may or may not have been created (we never touched
        // it). What matters: no canonical entries inside.
        let entries: Vec<_> = fs::read_dir(&install_cache)
            .map(|rd| rd.collect::<Result<Vec<_>, _>>().unwrap_or_default())
            .unwrap_or_default();
        assert!(
            entries.is_empty(),
            "install_release must not touch cache for legacy entries: {entries:?}"
        );
        let bin_entries: Vec<_> = fs::read_dir(&local_bin)
            .map(|rd| rd.collect::<Result<Vec<_>, _>>().unwrap_or_default())
            .unwrap_or_default();
        assert!(
            bin_entries.is_empty(),
            "install_release must not touch local-binaries for legacy entries: {bin_entries:?}"
        );
    }

    #[test]
    fn install_release_skips_mirror_on_cache_hit_without_force() {
        // Documents the intentional behavior: on a cache hit (canonical
        // already exists), mirror_program_outputs is NOT re-run. We
        // prove this by removing the mirrored wasm after the first
        // install, then running install again — without --force-mirror
        // the deleted file should NOT be re-created.
        let (staging, registry, _stage_cache) = stage("mirror-skip-on-hit", |registry| {
            write_fixture(
                registry,
                "myprog",
                "0.1.0",
                "program",
                "mkdir -p $WASM_POSIX_DEP_OUT_DIR/bin && \
                 echo p1 > $WASM_POSIX_DEP_OUT_DIR/bin/myprog.wasm",
                "[[outputs]]\nname = \"myprog\"\nwasm = \"bin/myprog.wasm\"\n",
            );
        });

        let install_cache = tempdir("mirror-skip-on-hit-cache");
        let local_bin = tempdir("mirror-skip-on-hit-bin");

        let args = vec![
            "--manifest".into(),
            staging.join("manifest.json").display().to_string(),
            "--archive-base".into(),
            format!("file://{}", staging.display()),
            "--cache-root".into(),
            install_cache.display().to_string(),
            "--local-binaries-dir".into(),
            local_bin.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--abi".into(),
            "4".into(),
        ];

        super::run(args.clone()).expect("first install_release must succeed");
        let mirror = local_bin.join("programs/wasm32/myprog.wasm");
        assert!(mirror.is_file(), "first install must create mirror");
        fs::remove_file(&mirror).unwrap();
        assert!(!mirror.exists(), "mirror removed for the test setup");

        super::run(args).expect("second install_release must succeed (cache hit)");

        assert!(
            !mirror.exists(),
            "without --force-mirror, mirror must NOT be re-created on cache hit \
             (got {})",
            mirror.display()
        );
    }

    #[test]
    fn install_release_re_runs_mirror_with_force_mirror() {
        // Documents the escape hatch: --force-mirror unconditionally
        // re-runs mirror_program_outputs, even on a cache hit. Same
        // setup as the skips test, plus --force-mirror on the second
        // run.
        let (staging, registry, _stage_cache) = stage("mirror-force", |registry| {
            write_fixture(
                registry,
                "myprog",
                "0.1.0",
                "program",
                "mkdir -p $WASM_POSIX_DEP_OUT_DIR/bin && \
                 echo p1 > $WASM_POSIX_DEP_OUT_DIR/bin/myprog.wasm",
                "[[outputs]]\nname = \"myprog\"\nwasm = \"bin/myprog.wasm\"\n",
            );
        });

        let install_cache = tempdir("mirror-force-cache");
        let local_bin = tempdir("mirror-force-bin");

        let mut args = vec![
            "--manifest".into(),
            staging.join("manifest.json").display().to_string(),
            "--archive-base".into(),
            format!("file://{}", staging.display()),
            "--cache-root".into(),
            install_cache.display().to_string(),
            "--local-binaries-dir".into(),
            local_bin.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--abi".into(),
            "4".into(),
        ];

        super::run(args.clone()).expect("first install_release must succeed");
        let mirror = local_bin.join("programs/wasm32/myprog.wasm");
        assert!(mirror.is_file(), "first install must create mirror");
        fs::remove_file(&mirror).unwrap();
        assert!(!mirror.exists(), "mirror removed for the test setup");

        args.push("--force-mirror".into());
        super::run(args).expect("second install_release with --force-mirror must succeed");

        assert!(
            mirror.is_file(),
            "with --force-mirror, mirror MUST be re-created on cache hit \
             (expected {})",
            mirror.display()
        );
        assert_eq!(fs::read(&mirror).unwrap(), b"p1\n");
    }

    #[test]
    fn parses_allow_stale_flags() {
        // Parse-only check: the new --allow-stale-manifest boolean flag
        // and --stale-out <path> flag must show up on the parsed-options
        // struct. They aren't *used* anywhere yet — Task 2 wires them
        // into the manifest-vs-local cache_key_sha pre-flight.
        let opts = parse_args(vec![
            "--manifest".into(),
            "/tmp/x".into(),
            "--archive-base".into(),
            "file:///tmp/staging".into(),
            "--allow-stale-manifest".into(),
            "--stale-out".into(),
            "/tmp/foo.json".into(),
        ])
        .expect("parse_args must succeed");
        assert!(
            opts.allow_stale_manifest,
            "--allow-stale-manifest must set the flag"
        );
        assert_eq!(
            opts.stale_out,
            Some(PathBuf::from("/tmp/foo.json")),
            "--stale-out must capture the path"
        );
        assert_eq!(opts.manifest_path, Some(PathBuf::from("/tmp/x")));
        assert_eq!(opts.archive_base, Some("file:///tmp/staging".to_string()));
    }

    #[test]
    fn parses_allow_stale_flags_default_off() {
        // Defaults: omitting both flags must yield false / None. Catches
        // a regression where the flag accidentally defaults to true.
        let opts = parse_args(vec![
            "--manifest".into(),
            "/tmp/x".into(),
            "--archive-base".into(),
            "file:///tmp/staging".into(),
        ])
        .expect("parse_args must succeed");
        assert!(!opts.allow_stale_manifest);
        assert_eq!(opts.stale_out, None);
    }

    #[test]
    fn allow_stale_skips_mismatched_entries() {
        // Two libraries staged together. We hand-edit the manifest to
        // corrupt only the FIRST entry's cache_key_sha; the second
        // entry should install normally. With --allow-stale-manifest
        // set, install_release must Ok, skip the mismatched entry, and
        // emit a JSON record naming it.
        let (staging, registry, _stage_cache) = stage("allow-stale-mixed", |registry| {
            write_fixture(
                registry,
                "z",
                "1.0.0",
                "library",
                "mkdir -p $WASM_POSIX_DEP_OUT_DIR/lib && \
                 echo zdata > $WASM_POSIX_DEP_OUT_DIR/lib/libZ.a",
                "[outputs]\nlibs = [\"lib/libZ.a\"]\n",
            );
            write_fixture(
                registry,
                "y",
                "1.0.0",
                "library",
                "mkdir -p $WASM_POSIX_DEP_OUT_DIR/lib && \
                 echo ydata > $WASM_POSIX_DEP_OUT_DIR/lib/libY.a",
                "[outputs]\nlibs = [\"lib/libY.a\"]\n",
            );
        });

        // Corrupt ONE entry's cache_key_sha (the "z" entry) so the
        // pre-flight comparison fails for it but passes for "y".
        let manifest_path = staging.join("manifest.json");
        let text = fs::read_to_string(&manifest_path).unwrap();
        let mut json: Value = serde_json::from_str(&text).unwrap();
        let entries = json["entries"].as_array_mut().unwrap();
        let mut corrupted = false;
        for entry in entries.iter_mut() {
            if entry.get("archive_name").is_some()
                && entry.get("program").and_then(|v| v.as_str()) == Some("z")
            {
                entry["compatibility"]["cache_key_sha"] =
                    Value::String("0".repeat(64));
                corrupted = true;
            }
        }
        assert!(corrupted, "test setup: must have corrupted z's compat sha");
        fs::write(&manifest_path, serde_json::to_string_pretty(&json).unwrap())
            .unwrap();

        let install_cache = tempdir("allow-stale-mixed-install-cache");
        let local_bin = tempdir("allow-stale-mixed-local-bin");
        let stale_out = tempdir("allow-stale-mixed-out").join("stale.json");

        super::run(vec![
            "--manifest".into(),
            manifest_path.display().to_string(),
            "--archive-base".into(),
            format!("file://{}", staging.display()),
            "--cache-root".into(),
            install_cache.display().to_string(),
            "--local-binaries-dir".into(),
            local_bin.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--abi".into(),
            "4".into(),
            "--allow-stale-manifest".into(),
            "--stale-out".into(),
            stale_out.display().to_string(),
        ])
        .expect("install_release must Ok with --allow-stale-manifest");

        // Compute canonical paths so we can assert "z is absent" and
        // "y is present" without hard-coding hash values.
        let reg = Registry {
            roots: vec![registry.clone()],
        };
        let mz = reg.load("z").unwrap();
        let my = reg.load("y").unwrap();
        let mut chain = Vec::new();
        let mut memo = BTreeMap::new();
        let z_sha = build_deps::compute_sha(
            &mz, &reg, TargetArch::Wasm32, 4, &mut memo, &mut chain,
        )
        .unwrap();
        let mut chain = Vec::new();
        let mut memo = BTreeMap::new();
        let y_sha = build_deps::compute_sha(
            &my, &reg, TargetArch::Wasm32, 4, &mut memo, &mut chain,
        )
        .unwrap();
        let z_canonical =
            canonical_path(&install_cache, &mz, TargetArch::Wasm32, &z_sha);
        let y_canonical =
            canonical_path(&install_cache, &my, TargetArch::Wasm32, &y_sha);

        assert!(
            !z_canonical.exists(),
            "stale entry z must NOT have been installed at {}",
            z_canonical.display()
        );
        assert!(
            y_canonical.is_dir(),
            "non-stale entry y must have been installed at {}",
            y_canonical.display()
        );
        assert!(
            y_canonical.join("lib/libY.a").is_file(),
            "y's declared output must be present in cache"
        );

        // The --stale-out file must list exactly the one stale entry,
        // with the documented field names (program/arch/local_sha).
        let stale_text = fs::read_to_string(&stale_out)
            .expect("--stale-out file must be written");
        let stale_json: Value = serde_json::from_str(&stale_text).unwrap();
        let arr = stale_json
            .as_array()
            .expect("--stale-out must be a JSON array");
        assert_eq!(arr.len(), 1, "exactly one stale entry expected");
        assert_eq!(arr[0]["program"], "z");
        assert_eq!(arr[0]["arch"], "wasm32");
        // local_sha must equal the computed sha for z (hex-encoded).
        let expected_local = hex(&z_sha);
        assert_eq!(arr[0]["local_sha"], Value::String(expected_local));
    }

    #[test]
    fn allow_stale_writes_empty_list_when_nothing_stale() {
        // --allow-stale-manifest is set, but the manifest is fully
        // consistent. Expect Ok(()), normal install, and an empty
        // JSON array written to --stale-out (so the downstream
        // caller knows install ran in stale-tolerant mode).
        let (staging, registry, _stage_cache) = stage("allow-stale-empty", |registry| {
            write_fixture(
                registry,
                "z",
                "1.0.0",
                "library",
                "mkdir -p $WASM_POSIX_DEP_OUT_DIR/lib && \
                 echo zdata > $WASM_POSIX_DEP_OUT_DIR/lib/libZ.a",
                "[outputs]\nlibs = [\"lib/libZ.a\"]\n",
            );
        });

        let install_cache = tempdir("allow-stale-empty-install-cache");
        let local_bin = tempdir("allow-stale-empty-local-bin");
        let stale_out = tempdir("allow-stale-empty-out").join("stale.json");

        super::run(vec![
            "--manifest".into(),
            staging.join("manifest.json").display().to_string(),
            "--archive-base".into(),
            format!("file://{}", staging.display()),
            "--cache-root".into(),
            install_cache.display().to_string(),
            "--local-binaries-dir".into(),
            local_bin.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--abi".into(),
            "4".into(),
            "--allow-stale-manifest".into(),
            "--stale-out".into(),
            stale_out.display().to_string(),
        ])
        .expect("install_release must Ok when nothing is stale");

        // z installs normally.
        let reg = Registry {
            roots: vec![registry.clone()],
        };
        let mz = reg.load("z").unwrap();
        let mut chain = Vec::new();
        let mut memo = BTreeMap::new();
        let z_sha = build_deps::compute_sha(
            &mz, &reg, TargetArch::Wasm32, 4, &mut memo, &mut chain,
        )
        .unwrap();
        let z_canonical =
            canonical_path(&install_cache, &mz, TargetArch::Wasm32, &z_sha);
        assert!(
            z_canonical.is_dir(),
            "consistent entry z must have been installed at {}",
            z_canonical.display()
        );

        // The stale-out file must exist and contain `[]`.
        let stale_text = fs::read_to_string(&stale_out)
            .expect("--stale-out file must be written even when empty");
        let stale_json: Value = serde_json::from_str(&stale_text).unwrap();
        let arr = stale_json
            .as_array()
            .expect("--stale-out must be a JSON array");
        assert!(
            arr.is_empty(),
            "with no stale entries, --stale-out must contain []; got {arr:?}"
        );
    }

    #[test]
    fn strict_default_unchanged_when_flag_off() {
        // Regression guard: without --allow-stale-manifest, a stale
        // manifest must still surface as Err with the existing error
        // wording. (Companion to install_release_rejects_compat_mismatch
        // — that one corrupts ALL entries; this one corrupts ONE in a
        // multi-entry manifest to make sure the strict path triggers
        // on the FIRST stale entry without scanning past it.)
        let (staging, registry, _stage_cache) = stage("strict-default-off", |registry| {
            write_fixture(
                registry,
                "z",
                "1.0.0",
                "library",
                "mkdir -p $WASM_POSIX_DEP_OUT_DIR/lib && \
                 echo zdata > $WASM_POSIX_DEP_OUT_DIR/lib/libZ.a",
                "[outputs]\nlibs = [\"lib/libZ.a\"]\n",
            );
            write_fixture(
                registry,
                "y",
                "1.0.0",
                "library",
                "mkdir -p $WASM_POSIX_DEP_OUT_DIR/lib && \
                 echo ydata > $WASM_POSIX_DEP_OUT_DIR/lib/libY.a",
                "[outputs]\nlibs = [\"lib/libY.a\"]\n",
            );
        });

        let manifest_path = staging.join("manifest.json");
        let text = fs::read_to_string(&manifest_path).unwrap();
        let mut json: Value = serde_json::from_str(&text).unwrap();
        let entries = json["entries"].as_array_mut().unwrap();
        for entry in entries.iter_mut() {
            if entry.get("archive_name").is_some()
                && entry.get("program").and_then(|v| v.as_str()) == Some("z")
            {
                entry["compatibility"]["cache_key_sha"] =
                    Value::String("0".repeat(64));
            }
        }
        fs::write(&manifest_path, serde_json::to_string_pretty(&json).unwrap())
            .unwrap();

        let install_cache = tempdir("strict-default-off-install-cache");
        let local_bin = tempdir("strict-default-off-local-bin");

        let err = super::run(vec![
            "--manifest".into(),
            manifest_path.display().to_string(),
            "--archive-base".into(),
            format!("file://{}", staging.display()),
            "--cache-root".into(),
            install_cache.display().to_string(),
            "--local-binaries-dir".into(),
            local_bin.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--abi".into(),
            "4".into(),
        ])
        .expect_err("install_release must Err without --allow-stale-manifest");

        assert!(
            err.contains("stale") || err.contains("cache_key_sha"),
            "error must surface the staleness, got: {err}"
        );
    }

    #[test]
    fn install_release_requires_archive_base() {
        let dir = tempdir("no-archive-base");
        let manifest = serde_json::json!({
            "abi_version": 4,
            "release_tag": "binaries-abi-v4",
            "generated_at": "2026-04-26T00:00:00Z",
            "generator": "test",
            "entries": []
        });
        let manifest_path = dir.join("manifest.json");
        fs::write(&manifest_path, manifest.to_string()).unwrap();

        let err = super::run(vec![
            "--manifest".into(),
            manifest_path.display().to_string(),
        ])
        .expect_err("install_release must require --archive-base");
        assert!(
            err.contains("archive-base"),
            "error must name --archive-base, got: {err}"
        );
    }
}

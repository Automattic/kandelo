//! Stage all package-system library + program archives for a release.
//!
//! Walks the registry, fans out across requested arches, calls
//! `build_deps::ensure_built` to populate the cache, then
//! `archive_stage::stage_archive_with_options` to produce the
//! `.tar.zst`. Finally delegates to `build_manifest::run` to emit
//! `manifest.json`. Atomic against re-runs: an archive whose
//! computed name already exists in `<staging>/{libs,programs}/` is
//! skipped.
//!
//! Failure semantics:
//!   * Per-arch errors are logged as `WARN` and tracked.
//!   * Without `--continue-on-error`: a manifest that fails for
//!     EVERY requested arch is fatal (returns `Err`); a manifest
//!     that fails for only SOME requested arches is downgraded to
//!     a warning. Rationale: a single missing-for-wasm64-only
//!     dependency shouldn't fail an otherwise-clean release.
//!   * With `--continue-on-error`: even total-failure manifests
//!     are warnings, never fatal.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use wasm_posix_shared as shared;

use crate::archive_stage::{self, StageOptions};
use crate::build_deps::{self, default_cache_root, parse_target_arch, Registry, ResolveOpts};
use crate::build_manifest;
use crate::pkg_manifest::{DepsManifest, ManifestKind, TargetArch};
use crate::repo_root;
use crate::util::hex;

pub fn run(args: Vec<String>) -> Result<(), String> {
    let mut staging: Option<PathBuf> = None;
    let mut registry_root: Option<PathBuf> = None;
    let mut cache_root: Option<PathBuf> = None;
    let mut abi: Option<u32> = None;
    let mut arches: Vec<TargetArch> = Vec::new();
    let mut tag: Option<String> = None;
    let mut build_timestamp: Option<String> = None;
    let mut build_host: Option<String> = None;
    let mut continue_on_error = false;
    let mut kinds: Vec<ManifestKind> = Vec::new();
    // Force-rebuild: bypass cache hits + remote-fetch and source-build
    // these manifests. `--force-rebuild-all` populates the set from the
    // walked registry once we have it.
    let mut force_rebuild_names: BTreeSet<String> = BTreeSet::new();
    let mut force_rebuild_all = false;
    // Per-package allow-failure list. When a manifest in this set fails
    // every attempted arch, it's downgraded to a warning rather than
    // failing the whole stage-release. Release-policy escape hatch for
    // packages with known-broken source builds we don't want to gate the
    // workflow on. Lives at the workflow layer (e.g., force-rebuild.yml
    // passes `--allow-failure texlive`) so the package's package.toml stays
    // agnostic — "OK to fail right now" is a release-policy decision,
    // not a property of the package itself.
    let mut allow_failure_names: BTreeSet<String> = BTreeSet::new();

    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--staging" => {
                staging = Some(it.next().ok_or("--staging requires path")?.into())
            }
            "--registry" => {
                registry_root = Some(it.next().ok_or("--registry requires path")?.into())
            }
            "--cache-root" => {
                cache_root = Some(it.next().ok_or("--cache-root requires path")?.into())
            }
            "--abi" => {
                abi = Some(
                    it.next()
                        .ok_or("--abi requires <u32>")?
                        .parse()
                        .map_err(|e| format!("--abi: {e}"))?,
                )
            }
            "--arch" => {
                arches.push(parse_target_arch(
                    &it.next().ok_or("--arch requires wasm32|wasm64")?,
                )?)
            }
            "--kind" => {
                let v = it.next().ok_or("--kind requires library|program")?;
                kinds.push(match v.as_str() {
                    "library" => ManifestKind::Library,
                    "program" => ManifestKind::Program,
                    other => {
                        return Err(format!(
                            "--kind {other:?}: must be library or program (source-kind has no archive)"
                        ))
                    }
                });
            }
            "--tag" => tag = Some(it.next().ok_or("--tag requires value")?),
            "--build-timestamp" => {
                build_timestamp = Some(it.next().ok_or("--build-timestamp requires value")?)
            }
            "--build-host" => {
                build_host = Some(it.next().ok_or("--build-host requires value")?)
            }
            "--continue-on-error" => continue_on_error = true,
            "--force-rebuild" => {
                force_rebuild_names
                    .insert(it.next().ok_or("--force-rebuild requires <name>")?);
            }
            "--force-rebuild-all" => force_rebuild_all = true,
            "--allow-failure" => {
                allow_failure_names
                    .insert(it.next().ok_or("--allow-failure requires <name>")?);
            }
            other => return Err(format!("unknown arg {other:?}")),
        }
    }

    let staging = staging.ok_or("--staging is required")?;
    let registry = if let Some(r) = registry_root {
        Registry { roots: vec![r] }
    } else {
        Registry::from_env(&repo_root())
    };
    let cache_root = cache_root.unwrap_or_else(default_cache_root);
    let abi = abi.unwrap_or(shared::ABI_VERSION);
    let arches = if arches.is_empty() {
        vec![TargetArch::Wasm32, TargetArch::Wasm64]
    } else {
        arches
    };
    let tag = tag.unwrap_or_else(|| format!("binaries-abi-v{abi}"));
    let build_timestamp =
        build_timestamp.unwrap_or_else(build_manifest::current_utc_iso);
    let build_host = build_host.unwrap_or_else(default_build_host);
    // Default kind set: both library and program. Pass --kind library
    // (or --kind program, repeatable) to narrow.
    let kinds = if kinds.is_empty() {
        vec![ManifestKind::Library, ManifestKind::Program]
    } else {
        kinds
    };

    fs::create_dir_all(staging.join("libs"))
        .map_err(|e| format!("mkdir staging/libs: {e}"))?;
    fs::create_dir_all(staging.join("programs"))
        .map_err(|e| format!("mkdir staging/programs: {e}"))?;

    // Track per-manifest failures so we can decide pass/fail based
    // on whether EVERY arch failed (fatal) vs SOME (warn-only).
    let mut errors: BTreeMap<String, Vec<(TargetArch, String)>> = BTreeMap::new();
    // Track how many arches were actually attempted per manifest. A manifest
    // with `target_arches = ["wasm32"]` invoked under `--arch wasm32 --arch
    // wasm64` only attempts 1 arch (wasm64 is silently skipped); without
    // tracking this, a wasm32-only package failing wasm32 would be misjudged
    // as a "partial" failure since errors[name].len() < arches.len() — even
    // though the package failed every arch it could possibly produce.
    let mut attempted: BTreeMap<String, usize> = BTreeMap::new();

    let walked = registry.walk_all()?;
    if force_rebuild_all {
        // Expand to every walked manifest of a stageable kind. Source
        // manifests aren't staged by stage_release, so leaving them out
        // of the set is consistent with what gets built.
        for (_, m) in &walked {
            if matches!(m.kind, ManifestKind::Library | ManifestKind::Program) {
                force_rebuild_names.insert(m.name.clone());
            }
        }
    }
    let force_source_build: Option<&BTreeSet<String>> =
        if force_rebuild_names.is_empty() {
            None
        } else {
            eprintln!(
                "force-rebuild: source-building {} manifest(s): {}",
                force_rebuild_names.len(),
                force_rebuild_names.iter().cloned().collect::<Vec<_>>().join(", "),
            );
            Some(&force_rebuild_names)
        };

    for (_, m) in walked {
        if !kinds.contains(&m.kind) {
            continue;
        }
        // Skip metadata-only manifests: kind=program entries that lack
        // a build script (the script file isn't on disk). These were
        // added in Chunk B as composite-VFS / bundle-program lookup
        // satisfiers (kernel, userspace, examples, shell, lamp, node,
        // wordpress, lsof, nginx, sqlite-cli, curl-the-program, etc.)
        // and aren't real the producer-ready packages — they don't
        // produce a buildable archive. Silently skip rather than
        // emitting a noisy WARN per arch.
        if matches!(m.kind, ManifestKind::Program) {
            // Phase A-bis Task 2: `script_path`, when set, resolves
            // against the repo root; the convention fallback resolves
            // against the package's own directory. Delegate to
            // `build_script_path()` so the rules stay in one place.
            let script_path = m.build_script_path(&repo_root());
            if !script_path.is_file() {
                eprintln!(
                    "skip {} (metadata-only manifest, no build script)",
                    m.name
                );
                continue;
            }
        }
        for &arch in &arches {
            // Honor the manifest's per-arch opt-in: a manifest that
            // doesn't list this arch in `target_arches` is silently
            // skipped. The field defaults to `["wasm32"]`, so most
            // manifests stage only wasm32 and only mariadb / mariadb-vfs /
            // php (which carry an explicit `arches = ["wasm32", "wasm64"]`)
            // produce a wasm64 archive.
            if !m.target_arches.contains(&arch) {
                eprintln!(
                    "skip {} {} (manifest target_arches = {:?})",
                    m.name,
                    arch.as_str(),
                    m.target_arches.iter().map(|a| a.as_str()).collect::<Vec<_>>()
                );
                continue;
            }
            *attempted.entry(m.name.clone()).or_insert(0) += 1;
            match stage_one(
                &m,
                &registry,
                arch,
                abi,
                &cache_root,
                &staging,
                &build_timestamp,
                &build_host,
                force_source_build,
            ) {
                Ok(archive_path) => {
                    eprintln!("staged {}", archive_path.display());
                }
                Err(e) => {
                    eprintln!("WARN {} {}: {e}", m.name, arch.as_str());
                    errors.entry(m.name.clone()).or_default().push((arch, e));
                }
            }
        }
    }

    // Generate manifest.json by delegating to build_manifest. This
    // catalogs whichever archives actually landed in staging — an
    // arch that warn-skipped won't appear in the manifest.
    let mut manifest_args = vec![
        "--in".into(),
        staging.display().to_string(),
        "--out".into(),
        staging.join("manifest.json").display().to_string(),
        "--tag".into(),
        tag.clone(),
        "--abi".into(),
        abi.to_string(),
    ];
    if let Some(r) = registry.roots.first() {
        manifest_args.push("--registry".into());
        manifest_args.push(r.display().to_string());
    }
    for &arch in &arches {
        manifest_args.push("--arch".into());
        manifest_args.push(arch.as_str().to_string());
    }
    build_manifest::run(manifest_args)?;

    // Decide pass/fail. Without --continue-on-error, treat a manifest
    // that failed every arch it ATTEMPTED as fatal; partial failures are
    // still just warnings (already logged above). "Attempted" excludes
    // arches silently skipped by target_arches filtering — otherwise a
    // wasm32-only manifest could never be a total failure under
    // `--arch wasm32 --arch wasm64`, hiding real build breakage.
    //
    // `--allow-failure <name>` carves out a per-package exception:
    // total-failure for that name logs a warning but doesn't gate the
    // workflow exit code. Used to keep force-rebuild green while a
    // known-broken package (e.g. texlive's pmpost-pulls-in-gmp.h trap)
    // is being fixed in a follow-up. The package's package.toml stays
    // unchanged; the policy lives at the call site.
    //
    // The flag also reports its own staleness: if a name listed in
    // --allow-failure built every attempted arch successfully (or
    // matched no manifest at all), the run logs a notice so the
    // operator can drop the now-no-op flag from the workflow. Without
    // this, the flag silently lingers — long after the underlying
    // build is fixed, no log line nudges anyone to remove it.
    let report = analyze_allow_failure(&errors, &attempted, &allow_failure_names);
    if !report.allowed_total_failures.is_empty() {
        eprintln!(
            "stage-release: {} manifest(s) failed every attempted arch \
             but are listed via --allow-failure — downgraded to warnings: {}",
            report.allowed_total_failures.len(),
            report.allowed_total_failures.join(", "),
        );
    }
    if !report.stale_allow_failure_succeeded.is_empty() {
        eprintln!(
            "stage-release: --allow-failure flag is no-op for {} manifest(s) \
             that built every attempted arch successfully — drop them from \
             the call site: {}",
            report.stale_allow_failure_succeeded.len(),
            report.stale_allow_failure_succeeded.join(", "),
        );
    }
    if !report.stale_allow_failure_unknown.is_empty() {
        eprintln!(
            "stage-release: --allow-failure listed {} name(s) that didn't \
             match any attempted manifest (typo? removed package?): {}",
            report.stale_allow_failure_unknown.len(),
            report.stale_allow_failure_unknown.join(", "),
        );
    }
    if !continue_on_error && !report.total_failures.is_empty() {
        return Err(format!(
            "stage-release: {} manifest(s) failed every attempted arch — \
             see WARN logs above. Failed: {}",
            report.total_failures.len(),
            report.total_failures.join(", "),
        ));
    }

    Ok(())
}

/// Categorization of `--allow-failure` outcomes after the staging
/// loop, by name. Each name listed in `allow_failure_names` lands in
/// exactly one of `allowed_total_failures` /
/// `stale_allow_failure_succeeded` / `stale_allow_failure_unknown`.
/// Names NOT in `allow_failure_names` that failed every attempted
/// arch land in `total_failures` instead.
struct AllowFailureReport<'a> {
    /// Failed every attempted arch, NOT in --allow-failure. Caller
    /// turns these into a hard error (gates the workflow).
    total_failures: Vec<&'a str>,
    /// Failed every attempted arch, IS in --allow-failure. Caller
    /// downgrades to a warning. The flag is doing the job it was
    /// added for.
    allowed_total_failures: Vec<&'a str>,
    /// Listed in --allow-failure but built every attempted arch
    /// successfully. The flag is no-op — surface it so the operator
    /// can drop it from the call site.
    stale_allow_failure_succeeded: Vec<&'a str>,
    /// Listed in --allow-failure but didn't match any attempted
    /// manifest (typo, deleted package, name mismatch). Surface so
    /// the dead flag doesn't linger.
    stale_allow_failure_unknown: Vec<&'a str>,
}

fn analyze_allow_failure<'a>(
    errors: &'a BTreeMap<String, Vec<(TargetArch, String)>>,
    attempted: &'a BTreeMap<String, usize>,
    allow_failure_names: &'a BTreeSet<String>,
) -> AllowFailureReport<'a> {
    let mut total_failures: Vec<&str> = Vec::new();
    let mut allowed_total_failures: Vec<&str> = Vec::new();

    // First: classify everything that has at least one error. A
    // manifest is a total failure when every attempted arch errored;
    // partial failures (some succeeded) are non-gating either way and
    // don't appear in any returned bucket — they're already a warning
    // logged inline.
    for (name, errs) in errors {
        let attempts = attempted.get(name).copied().unwrap_or(0);
        if attempts == 0 || errs.len() != attempts {
            continue;
        }
        if allow_failure_names.contains(name) {
            allowed_total_failures.push(name.as_str());
        } else {
            total_failures.push(name.as_str());
        }
    }

    // Second: partition --allow-failure entries that DIDN'T land in
    // `allowed_total_failures`. Two shapes: the manifest succeeded
    // (attempted but no errors / partial failure) vs. the name
    // matched nothing at all (typo, removed package). Both are stale
    // flag signals; surface them distinctly because the fix differs
    // (drop the flag vs. fix the name). Partial failure leaves the
    // flag in place — it still has a real job for the next run if
    // the failure regresses to total.
    let mut stale_allow_failure_succeeded: Vec<&str> = Vec::new();
    let mut stale_allow_failure_unknown: Vec<&str> = Vec::new();
    for name in allow_failure_names {
        if allowed_total_failures.iter().any(|n| *n == name.as_str()) {
            continue;
        }
        if attempted.contains_key(name) {
            let errored_count = errors.get(name).map(|v| v.len()).unwrap_or(0);
            if errored_count == 0 {
                stale_allow_failure_succeeded.push(name.as_str());
            }
        } else {
            stale_allow_failure_unknown.push(name.as_str());
        }
    }

    AllowFailureReport {
        total_failures,
        allowed_total_failures,
        stale_allow_failure_succeeded,
        stale_allow_failure_unknown,
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn stage_one(
    m: &DepsManifest,
    registry: &Registry,
    arch: TargetArch,
    abi: u32,
    cache_root: &Path,
    staging: &Path,
    build_timestamp: &str,
    build_host: &str,
    force_source_build: Option<&BTreeSet<String>>,
) -> Result<PathBuf, String> {
    // Compute the cache-key sha so we know what filename to stage
    // under and what to inject into the [compatibility] block.
    // Each call gets a fresh memo; the legacy memo bug surfaced in E.3
    // showed memos must not cross arch boundaries.
    let mut chain: Vec<String> = Vec::new();
    let mut memo: BTreeMap<String, [u8; 32]> = BTreeMap::new();
    let sha = build_deps::compute_sha(m, registry, arch, abi, &mut memo, &mut chain)
        .map_err(|e| format!("compute_sha: {e}"))?;
    let sha_hex = hex(&sha);
    let short = &sha_hex[..8];
    // Filename slots: <name>-<v>-rev<N>-abi<N>-<arch>-<short_sha>.tar.zst.
    // The cache_key_sha already mixes the ABI in as a hash input (so
    // <short_sha> changes when ABI changes), but encoding it in the
    // filename too is human-readable redundancy: a glance at the cache
    // dir or release page tells you which ABI generation each entry
    // belongs to.
    let archive_name = format!(
        "{}-{}-rev{}-abi{}-{}-{}.tar.zst",
        m.name,
        m.version,
        m.revision,
        abi,
        arch.as_str(),
        short,
    );

    let subdir = match m.kind {
        ManifestKind::Library => "libs",
        ManifestKind::Program => "programs",
        ManifestKind::Source => {
            return Err("stage_one called on non-library/program kind".into())
        }
    };
    let archive_path = staging.join(subdir).join(&archive_name);
    let force_this = force_source_build
        .map(|s| s.contains(&m.name))
        .unwrap_or(false);
    if archive_path.exists() && !force_this {
        // Already staged; idempotent re-run.
        return Ok(archive_path);
    }
    if archive_path.exists() && force_this {
        // Force-rebuild: drop the stale archive so the resolver +
        // archive_stage produces a fresh one. The cache_key_sha
        // (encoded in the filename's short_sha slot) won't change
        // unless inputs change, so the new archive overwrites the
        // same path — clearing first keeps the contract simple.
        std::fs::remove_file(&archive_path).map_err(|e| {
            format!("force-rebuild: remove stale {}: {e}", archive_path.display())
        })?;
    }

    // Resolve / build the cache entry. Local-libs override is
    // deliberately not exposed here — staging must reproduce from
    // sources, never from a developer's in-progress checkout.
    let resolve_opts = ResolveOpts {
        cache_root,
        local_libs: None,
        force_source_build,
        repo_root: None,
    };
    let cache_path = build_deps::ensure_built(m, registry, arch, abi, &resolve_opts)
        .map_err(|e| format!("ensure_built: {e}"))?;

    // Defense in depth: verify the cache canonical dir actually
    // contains every file declared in [[outputs]] before we pack it.
    // `validate_outputs` already runs after a fresh build (so newly-
    // built caches are checked), but a cache HIT skips the build
    // and that check. If a previous build under a different output
    // declaration left stale content in the canonical path AND the
    // current cache_key_sha computation collides (the bug fixed in
    // #385 — outputs weren't folded into the hash), stage_release
    // would silently pack a tarball whose contents disagree with
    // the deps.toml. Consumers then fail with the misleading
    // "declared output X not found in cache" error at install time.
    // Catch that mismatch HERE, at publish time, with a clear
    // diagnostic instead.
    validate_cache_outputs(m, &cache_path)?;

    let opts = StageOptions {
        cache_key_sha: sha_hex,
        build_timestamp: build_timestamp.into(),
        build_host: build_host.into(),
    };
    archive_stage::stage_archive_with_options(m, arch, abi, &cache_path, &archive_path, &opts)
        .map_err(|e| format!("archive_stage: {e}"))?;
    Ok(archive_path)
}

/// Lowercased `<os>-<arch>` derived from Rust's compile-time
/// constants — e.g. `macos-aarch64` on Apple Silicon, `linux-x86_64`
/// on Linux x86_64. Free-form provenance, not consumed by the
/// resolver. `to_lowercase()` is defensive: both `OS` and `ARCH` are
/// already lowercase today, but the format is documented as
/// "lowercased" so we make that explicit.
/// Pre-flight check before archive_stage: every file declared in
/// `[[outputs]]` (or `[outputs]` for libraries) must exist in the
/// cache canonical directory.
///
/// Without this, a stale cache (built under a different output
/// declaration before #385 folded outputs into cache_key_sha) gets
/// packed silently. The result is a tarball whose contents disagree
/// with deps.toml — a class of bug that surfaced in PR #384 when
/// `lamp.vfs` files got published into archives whose deps.toml said
/// `wasm = "lamp.vfs.zst"`.
fn validate_cache_outputs(m: &DepsManifest, cache_path: &Path) -> Result<(), String> {
    let check = |rel: &str, label: &str| -> Result<(), String> {
        let p = cache_path.join(rel);
        if !p.exists() {
            return Err(format!(
                "{}: declared {} output {:?} missing from cache at {}. \
                 The cache canonical directory does not contain the file \
                 declared by deps.toml. This typically means a stale cache \
                 from before the [[outputs]] field was changed; delete \
                 {} and re-run.",
                m.spec(),
                label,
                rel,
                p.display(),
                cache_path.display(),
            ));
        }
        Ok(())
    };
    match m.kind {
        ManifestKind::Library => {
            for rel in &m.outputs.libs {
                check(rel, "libs")?;
            }
            for rel in &m.outputs.headers {
                check(rel, "headers")?;
            }
            for rel in &m.outputs.pkgconfig {
                check(rel, "pkgconfig")?;
            }
        }
        ManifestKind::Program => {
            for out in &m.program_outputs {
                check(&out.wasm, "wasm")?;
            }
        }
        ManifestKind::Source => {} // Source-kind manifests carry no outputs.
    }
    Ok(())
}

pub(crate) fn default_build_host() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH).to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── analyze_allow_failure ─────────────────────────────────────
    //
    // Pure categorization step extracted from `run` so we can assert
    // exact behavior without spinning up a registry + build script
    // per case. Mirrors the four buckets a `--allow-failure` name
    // can fall into:
    //
    //   * total failure, NOT allow-listed → gates the run
    //   * total failure, allow-listed     → downgraded to warning
    //   * allow-listed, every arch passed → stale flag (surface)
    //   * allow-listed, never attempted   → unknown name (surface)
    //
    // The "stale flag" buckets are the load-bearing piece for this
    // change. Without them, `--allow-failure foo` lingers in CI
    // workflows long after foo's build is fixed: the flag has no
    // observable effect on the outcome, so an operator scanning
    // logs sees nothing prompting them to drop it.

    fn empty_errors() -> BTreeMap<String, Vec<(TargetArch, String)>> {
        BTreeMap::new()
    }
    fn fail(arch: TargetArch) -> (TargetArch, String) {
        (arch, "build failed".into())
    }

    #[test]
    fn allow_failure_report_total_failure_not_listed_gates() {
        // Baseline: a manifest that failed every attempted arch and
        // is NOT listed in --allow-failure. Lands in `total_failures`
        // (which the caller turns into a hard error).
        let mut errors = empty_errors();
        errors.insert("foo".into(), vec![fail(TargetArch::Wasm32)]);
        let mut attempted = BTreeMap::new();
        attempted.insert("foo".into(), 1);
        let allow_failure: BTreeSet<String> = BTreeSet::new();
        let r = analyze_allow_failure(&errors, &attempted, &allow_failure);
        assert_eq!(r.total_failures, vec!["foo"]);
        assert!(r.allowed_total_failures.is_empty());
        assert!(r.stale_allow_failure_succeeded.is_empty());
        assert!(r.stale_allow_failure_unknown.is_empty());
    }

    #[test]
    fn allow_failure_report_total_failure_allow_listed_is_downgraded() {
        // Same shape but listed in --allow-failure: downgraded to
        // warning, NOT counted as a stale flag. The flag is doing
        // the job it was added for.
        let mut errors = empty_errors();
        errors.insert("foo".into(), vec![fail(TargetArch::Wasm32)]);
        let mut attempted = BTreeMap::new();
        attempted.insert("foo".into(), 1);
        let mut allow_failure = BTreeSet::new();
        allow_failure.insert("foo".into());
        let r = analyze_allow_failure(&errors, &attempted, &allow_failure);
        assert!(r.total_failures.is_empty());
        assert_eq!(r.allowed_total_failures, vec!["foo"]);
        assert!(r.stale_allow_failure_succeeded.is_empty());
        assert!(r.stale_allow_failure_unknown.is_empty());
    }

    #[test]
    fn allow_failure_report_listed_but_succeeded_is_stale() {
        // The motivating case: `--allow-failure foo` AND foo built
        // every attempted arch successfully. The flag is now stale —
        // surface it so the operator can drop it from the workflow.
        // Doesn't gate the run (success is success), just becomes
        // visible in the log.
        let errors = empty_errors();
        let mut attempted = BTreeMap::new();
        attempted.insert("foo".into(), 2);
        let mut allow_failure = BTreeSet::new();
        allow_failure.insert("foo".into());
        let r = analyze_allow_failure(&errors, &attempted, &allow_failure);
        assert!(r.total_failures.is_empty());
        assert!(r.allowed_total_failures.is_empty());
        assert_eq!(r.stale_allow_failure_succeeded, vec!["foo"]);
        assert!(r.stale_allow_failure_unknown.is_empty());
    }

    #[test]
    fn allow_failure_report_listed_but_partial_failure_is_not_stale() {
        // Partial failure (some arches passed, some failed) is
        // already a non-gating warning. The flag remains in case
        // the next run regresses to total failure — don't flag it
        // as stale.
        let mut errors = empty_errors();
        // 2 attempted, only 1 failed → partial failure.
        errors.insert("foo".into(), vec![fail(TargetArch::Wasm32)]);
        let mut attempted = BTreeMap::new();
        attempted.insert("foo".into(), 2);
        let mut allow_failure = BTreeSet::new();
        allow_failure.insert("foo".into());
        let r = analyze_allow_failure(&errors, &attempted, &allow_failure);
        assert!(r.total_failures.is_empty());
        assert!(r.allowed_total_failures.is_empty());
        assert!(r.stale_allow_failure_succeeded.is_empty());
        assert!(r.stale_allow_failure_unknown.is_empty());
    }

    #[test]
    fn allow_failure_report_listed_unknown_name_surfaces() {
        // `--allow-failure typo` where `typo` matched no manifest at
        // all (typo, removed package, wrong arch filter, etc.). The
        // flag is doing nothing — surface it so it doesn't linger.
        let errors = empty_errors();
        let attempted = BTreeMap::new();
        let mut allow_failure = BTreeSet::new();
        allow_failure.insert("typo".into());
        let r = analyze_allow_failure(&errors, &attempted, &allow_failure);
        assert!(r.total_failures.is_empty());
        assert!(r.allowed_total_failures.is_empty());
        assert!(r.stale_allow_failure_succeeded.is_empty());
        assert_eq!(r.stale_allow_failure_unknown, vec!["typo"]);
    }

    #[test]
    fn allow_failure_report_mixed_categories_partition_correctly() {
        // Sanity check: a single run can mix all four buckets.
        // Verifies each name lands in exactly one bucket.
        let mut errors = empty_errors();
        errors.insert("ungated_fail".into(), vec![fail(TargetArch::Wasm32)]);
        errors.insert("allowed_fail".into(), vec![fail(TargetArch::Wasm32)]);
        let mut attempted = BTreeMap::new();
        attempted.insert("ungated_fail".into(), 1);
        attempted.insert("allowed_fail".into(), 1);
        attempted.insert("succeeded".into(), 1);
        let mut allow_failure = BTreeSet::new();
        allow_failure.insert("allowed_fail".into());
        allow_failure.insert("succeeded".into());
        allow_failure.insert("typo".into());
        let r = analyze_allow_failure(&errors, &attempted, &allow_failure);
        assert_eq!(r.total_failures, vec!["ungated_fail"]);
        assert_eq!(r.allowed_total_failures, vec!["allowed_fail"]);
        assert_eq!(r.stale_allow_failure_succeeded, vec!["succeeded"]);
        assert_eq!(r.stale_allow_failure_unknown, vec!["typo"]);
    }

    fn tempdir(label: &str) -> PathBuf {
        let p = std::env::temp_dir()
            .join("wpk-xtask-stage-release")
            .join(format!("{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// Drop a `<name>/package.toml` + executable build script under
    /// `registry`. The build script writes whatever `body` says
    /// using the standard env-var contract. `outputs_section` is
    /// the `[outputs]` TOML block (caller writes the table).
    fn write_fixture_lib(
        registry: &Path,
        name: &str,
        version: &str,
        body: &str,
        outputs_section: &str,
    ) {
        write_fixture(registry, name, version, "library", &[], body, outputs_section);
    }

    fn write_fixture(
        registry: &Path,
        name: &str,
        version: &str,
        kind: &str,
        depends_on: &[&str],
        body: &str,
        outputs_section: &str,
    ) {
        let lib_dir = registry.join(name);
        fs::create_dir_all(&lib_dir).unwrap();
        let depends = depends_on
            .iter()
            .map(|s| format!("{:?}", s))
            .collect::<Vec<_>>()
            .join(", ");
        let toml = format!(
            r#"
kind = "{kind}"
name = "{name}"
version = "{version}"
revision = 1
depends_on = [{depends}]

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

    /// Source-kind fixture with a `[build].script_path` (so we don't
    /// have to fetch a tarball from a URL). The script just needs
    /// to leave OUT_DIR non-empty.
    fn write_fixture_source(registry: &Path, name: &str, version: &str, body: &str) {
        let lib_dir = registry.join(name);
        fs::create_dir_all(&lib_dir).unwrap();
        let toml = format!(
            r#"
kind = "source"
name = "{name}"
version = "{version}"
revision = 1
kernel_abi = 7

[source]
url = "https://example.test/{name}-{version}.tar.gz"
sha256 = "{:0>64}"

[license]
spdx = "TestLicense"

[build]
script_path = "build-{name}.sh"
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

    #[test]
    fn stage_release_produces_archives_and_manifest() {
        let dir = tempdir("e4-produces");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        let staging = dir.join("staging");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();

        write_fixture_lib(
            &registry,
            "z",
            "1.0.0",
            "mkdir -p $WASM_POSIX_DEP_OUT_DIR/lib && echo data > $WASM_POSIX_DEP_OUT_DIR/lib/libZ.a",
            "[outputs]\nlibs = [\"lib/libZ.a\"]\n",
        );

        super::run(vec![
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
        .unwrap();

        let archives: Vec<_> = fs::read_dir(staging.join("libs"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(archives.len(), 1, "got: {archives:?}");
        assert!(
            archives[0].starts_with("z-1.0.0-rev1-abi4-wasm32-"),
            "got: {:?}",
            archives[0]
        );
        assert!(archives[0].ends_with(".tar.zst"));

        let manifest_path = staging.join("manifest.json");
        assert!(manifest_path.is_file(), "manifest.json must exist");
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        let z = json["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["program"] == "z")
            .expect("z entry must be present");
        assert_eq!(z["compatibility"]["target_arch"], "wasm32");
        assert_eq!(z["compatibility"]["abi_versions"], serde_json::json!([4]));
    }

    #[test]
    fn stage_release_skips_failed_arch() {
        let dir = tempdir("e4-partial-fail");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        let staging = dir.join("staging");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();

        // Build script succeeds for wasm32, fails (exit 1) for wasm64.
        // WASM_POSIX_DEP_TARGET_ARCH is set per ensure_built tests.
        write_fixture_lib(
            &registry,
            "y",
            "1.0.0",
            r#"
if [ "$WASM_POSIX_DEP_TARGET_ARCH" = "wasm64" ]; then
    echo "fail-on-wasm64" >&2
    exit 1
fi
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"
echo data > "$WASM_POSIX_DEP_OUT_DIR/lib/libY.a"
"#,
            "[outputs]\nlibs = [\"lib/libY.a\"]\n",
        );

        // With --continue-on-error and both arches: must Ok().
        super::run(vec![
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
            "--arch".into(),
            "wasm64".into(),
            "--continue-on-error".into(),
            "--build-timestamp".into(),
            "2026-04-26T00:00:00Z".into(),
            "--build-host".into(),
            "test-host".into(),
        ])
        .unwrap();

        let archives: Vec<String> = fs::read_dir(staging.join("libs"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(
            archives.len(),
            1,
            "exactly one (wasm32) archive expected, got: {archives:?}"
        );
        assert!(
            archives[0].contains("-wasm32-"),
            "archive must be wasm32, got: {:?}",
            archives[0]
        );
        assert!(
            !archives.iter().any(|n| n.contains("-wasm64-")),
            "wasm64 archive must not be present: {archives:?}"
        );

        let manifest_path = staging.join("manifest.json");
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        let y_entries: Vec<_> = json["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["program"] == "y")
            .collect();
        assert_eq!(y_entries.len(), 1, "exactly one y entry expected");
        assert_eq!(y_entries[0]["compatibility"]["target_arch"], "wasm32");
    }

    #[test]
    fn stage_release_rejects_cache_with_missing_declared_output() {
        // Repro of the PR #384 misship: deps.toml declares
        // `wasm = "lamp.vfs.zst"` but the cache canonical dir has
        // `lamp.vfs` (a stale build before the wasm field was renamed).
        // stage_release must refuse to pack the archive — the resulting
        // tarball would consume-side fail with the misleading
        // "declared output X not found in cache" error.
        let dir = tempdir("e4-stale-cache-mismatch");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        let staging = dir.join("staging");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();

        // Build script that produces `foo.vfs` (no .zst) into the cache,
        // but the manifest declares the output as `foo.vfs.zst`.
        // ensure_built will pass the stale-name file through; the new
        // pre-stage check should catch it.
        write_fixture(
            &registry,
            "foo",
            "0.1.0",
            "program",
            &[],
            "echo content > $WASM_POSIX_DEP_OUT_DIR/foo.vfs.zst",
            "[[outputs]]\nname = \"foo\"\nwasm = \"foo.vfs.zst\"\n",
        );
        // Manually pre-populate the cache with the WRONG filename
        // to simulate a stale entry from before the cache_key formula
        // included [[outputs]].
        let m = DepsManifest::load(&registry.join("foo/deps.toml")).unwrap();
        let mut chain: Vec<String> = Vec::new();
        let mut memo: BTreeMap<String, [u8; 32]> = BTreeMap::new();
        let arch = TargetArch::Wasm32;
        let abi = 4;
        let sha = build_deps::compute_sha(
            &m,
            &Registry { roots: vec![registry.clone()] },
            arch,
            abi,
            &mut memo,
            &mut chain,
        )
        .unwrap();
        let canonical = build_deps::canonical_path(&cache_root, &m, arch, &sha);
        fs::create_dir_all(&canonical).unwrap();
        // Write the stale-named file (foo.vfs, not foo.vfs.zst) directly.
        fs::write(canonical.join("foo.vfs"), b"stale-content").unwrap();

        // Stage now should fail with a clear cache-mismatch error.
        let err = super::run(vec![
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
        .expect_err("stage_release must reject cache with missing declared output");

        assert!(
            err.contains("foo"),
            "summary must name the failed manifest, got: {err}",
        );
        // The detailed cache-mismatch diagnostic is logged via WARN
        // before the summary fires; assert that no archive landed in
        // staging — the failed manifest must not produce a tarball.
        let archives_dir = staging.join("programs");
        if archives_dir.is_dir() {
            for entry in fs::read_dir(&archives_dir).unwrap() {
                let name = entry.unwrap().file_name().into_string().unwrap();
                assert!(
                    !name.starts_with("foo-"),
                    "foo archive must not be staged when validation fails: {name}",
                );
            }
        }
    }

    #[test]
    fn stage_release_omits_source_kind_manifests() {
        let dir = tempdir("e4-source-omit");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        let staging = dir.join("staging");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();

        write_fixture_source(
            &registry,
            "src-only",
            "1.0.0",
            "echo > $WASM_POSIX_DEP_OUT_DIR/marker",
        );

        super::run(vec![
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
        .unwrap();

        // No archive in libs/ or programs/ (source-kind has no archive).
        let libs: Vec<_> = fs::read_dir(staging.join("libs"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        let progs: Vec<_> = fs::read_dir(staging.join("programs"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert!(libs.is_empty(), "no library archives expected: {libs:?}");
        assert!(progs.is_empty(), "no program archives expected: {progs:?}");

        // No source entry in manifest.json.
        let manifest_path = staging.join("manifest.json");
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        let src_entries: Vec<_> = json["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["program"] == "src-only")
            .collect();
        assert!(
            src_entries.is_empty(),
            "source-kind manifest must not appear in manifest.json"
        );
    }

    #[test]
    fn stage_release_total_failure_returns_err_without_continue_on_error() {
        let dir = tempdir("e4-total-fail");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        let staging = dir.join("staging");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();

        write_fixture_lib(
            &registry,
            "broken",
            "1.0.0",
            "echo always-fails >&2; exit 1",
            "[outputs]\nlibs = [\"lib/libBroken.a\"]\n",
        );

        let err = super::run(vec![
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
        .expect_err("must return Err when every arch fails for a manifest");
        assert!(
            err.contains("broken"),
            "error must name failed manifest, got: {err}"
        );
        assert!(
            err.contains("every attempted arch"),
            "error must mention total-failure semantics, got: {err}"
        );
    }

    /// A manifest with `target_arches = ["wasm32"]` that fails wasm32
    /// must be reported as a TOTAL failure even when wasm64 was also
    /// requested — wasm64 was silently filtered out by target_arches,
    /// so wasm32 is the only arch that could have produced an archive.
    /// Pre-fix the run() check compared errors[name].len() against
    /// arches.len() (= 2), so a wasm32-only failure was misclassified
    /// as "partial" and silently downgraded to a warning, hiding the
    /// real breakage from the workflow exit code.
    #[test]
    fn stage_release_wasm32_only_failure_is_total_when_wasm64_also_requested() {
        let dir = tempdir("e4-wasm32-only-fail");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        let staging = dir.join("staging");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();

        // Default target_arches = ["wasm32"]; build script always fails.
        write_fixture_lib(
            &registry,
            "wasm32only",
            "1.0.0",
            "echo always-fails >&2; exit 1",
            "[outputs]\nlibs = [\"lib/libW.a\"]\n",
        );

        let err = super::run(vec![
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
            "--arch".into(),
            "wasm64".into(),
            "--build-timestamp".into(),
            "2026-04-26T00:00:00Z".into(),
            "--build-host".into(),
            "test-host".into(),
        ])
        .expect_err("wasm32-only manifest failing wasm32 must be total failure");
        assert!(
            err.contains("wasm32only"),
            "error must name failed manifest, got: {err}"
        );
        assert!(
            err.contains("every attempted arch"),
            "error must use 'attempted arch' semantics, got: {err}"
        );
    }

    /// `--allow-failure <name>` downgrades a total-failure for that
    /// specific manifest to a warning. Other manifests' total
    /// failures still hard-fail as usual.
    #[test]
    fn stage_release_allow_failure_downgrades_named_manifest_only() {
        let dir = tempdir("e4-allow-failure");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        let staging = dir.join("staging");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();

        write_fixture_lib(
            &registry,
            "tolerated",
            "1.0.0",
            "echo always-fails >&2; exit 1",
            "[outputs]\nlibs = [\"lib/libT.a\"]\n",
        );

        // First: tolerated alone with --allow-failure must Ok().
        super::run(vec![
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
            "--allow-failure".into(),
            "tolerated".into(),
            "--build-timestamp".into(),
            "2026-04-26T00:00:00Z".into(),
            "--build-host".into(),
            "test-host".into(),
        ])
        .expect("tolerated total-failure must be downgraded under --allow-failure");

        // Second: tolerated + a non-tolerated failure must still Err().
        let staging2 = dir.join("staging2");
        write_fixture_lib(
            &registry,
            "untolerated",
            "1.0.0",
            "echo always-fails >&2; exit 1",
            "[outputs]\nlibs = [\"lib/libU.a\"]\n",
        );
        let err = super::run(vec![
            "--staging".into(),
            staging2.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--cache-root".into(),
            cache_root.display().to_string(),
            "--abi".into(),
            "4".into(),
            "--arch".into(),
            "wasm32".into(),
            "--allow-failure".into(),
            "tolerated".into(),
            "--build-timestamp".into(),
            "2026-04-26T00:00:00Z".into(),
            "--build-host".into(),
            "test-host".into(),
        ])
        .expect_err("untolerated total-failure must still gate the run");
        assert!(
            err.contains("untolerated"),
            "error must name the un-allowed manifest, got: {err}"
        );
        assert!(
            !err.contains("tolerated") || err.contains("untolerated"),
            "error must not list `tolerated` outside of substring match, got: {err}"
        );
    }

}

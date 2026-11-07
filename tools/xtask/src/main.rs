//! xtask — repo-local utilities.
//!
//! Subcommands:
//!   dump-abi              Regenerate `abi/snapshot.json` from authoritative sources.
//!   bundle-program        Zip-bundle one program's binary + runtime + LICENSE.
//!   build-deps            Wasm library dep-graph resolver (see docs/dependency-management.md).
//!   compute-cache-key-sha Print a package's cache-key sha (64 hex chars) to stdout.
//!                         Args: --package <dir> --arch <wasm32|wasm64>. Used by the
//!                         pre-flight workflow to skip already-published
//!                         matrix entries.
//!   workspace-closure-sha Print a content digest (64 hex chars) over the union
//!                         of one or more workspace crates' cargo dependency
//!                         closures. Args: --crates <a,b,c>, and for a side
//!                         module also --recipe <repo-relative build script>,
//!                         which folds the recipe's own digest in. For a build
//!                         artifact with no resolver `build.toml` (so it has
//!                         no `cargo:<crate>` cache-key input), this gives the
//!                         same drift-proof, cargo-metadata-derived freshness
//!                         coverage. Every `crates/*/build-wasm.sh` stamps the
//!                         key this prints; nothing may compute part of that
//!                         key itself, or the stamp and the checks that read it
//!                         stop describing the same thing.
//!   sort-package-matrix   Order a package matrix so selected package dependencies
//!                         appear before their dependents.
//!   partition-package-matrix
//!                         Select an exact root closure and partition it into
//!                         dependency-safe parallel build levels.
//!   package-dependency-artifacts
//!                         Print workflow artifact names for selected direct
//!                         package dependencies of one package matrix entry.
//!   archive-extract-member
//!                         Stream one exact regular package-archive member to
//!                         a new output file without exposing partial bytes.
//!   local-build           Resolve and source-build a package closure locally.
//!                         `plan --set <file> --status [--json]` is a
//!                         read-only dry run listing each node as cached or
//!                         will-run, with an estimated duration from recorded
//!                         timings, so a caller knows before starting whether
//!                         the build takes seconds or tens of minutes. `run`
//!                         appends scheduler events as JSON lines to
//!                         `$KANDELO_LOCAL_BUILD_EVENTS` when set, so
//!                         `scripts/agent-job status` can report progress,
//!                         and records per-node and per-run durations under
//!                         `<source cache root>/timings/` to feed that
//!                         estimate.
//!   bootstrap             One-command hermetic build: fork-instrument host
//!                         tool, then the local-build engine over the whole
//!                         supported set, then the TypeScript host build.
//!                         Backs `./run.sh setup`.
//!   clean                 Remove one package's or product's compiled cache,
//!                         mirror, and product artifacts, and print the
//!                         graph-derived cascade of nodes it also
//!                         invalidates (e.g. cleaning a package a VFS
//!                         product embeds also invalidates that product).
//!                         Backs `./run.sh clean <target>`.
//!   verify-fresh          Pre-test freshness check: fails loud if the one
//!                         local kernel artifact (local-binaries/source-only-v1/
//!                         kernel.wasm) declares a stale ABI version
//!                         relative to the source tree. Backs `./run.sh test`.
//!   runtime-workarounds check|list|run
//!                         Registry of workarounds for outside runtime/toolchain defects:
//!                         `check` keeps source tags and tests/runtime-workarounds entries
//!                         consistent, `run` runs the self-judging reproductions, and
//!                         `list` prints the weekly report.
//!   test-failures         Import failures and anomalies from runner reports as JSON.
//!   set-build-commit      Stamp `[build].commit = <sha>` into one
//!                         `packages/registry/<name>/package.toml`. Used by the
//!                         publish flow to record source provenance.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::rc::Rc;

mod accepted_program_digests;
mod vfs_image_describe;
mod vfs_products;
mod archive_extract_member;
mod build_deps;
mod build_stamp;
mod bundle_program;
#[cfg(unix)]
mod cache_gc;
mod cargo_closure;
mod determinism_check;
mod dump_abi;
mod host_tool_probe;
mod local_abi_identity;
mod local_build;
mod local_build_executor;
mod local_build_timing;
mod package_archive_limits;
mod package_matrix;
mod partial_image;
mod pkg_manifest;
mod program_env_imports;
mod package_imports;
mod recipe_tree_guard;
mod remote_fetch;
mod root_js_deps;
mod runtime_workarounds;
mod source_archive_cache;
mod source_extract;
mod stamp_abi_contract;
mod supported_program_baseline;
mod test_failures;
mod update_pkg_manifest;
mod util;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let sub = match args.next() {
        Some(s) => s,
        None => {
            eprintln!("usage: xtask <subcommand> [args...]");
            eprintln!(
                "subcommands: vfs, dump-abi, check-program-env-imports, bundle-program, build-deps, compute-cache-key-sha, workspace-closure-sha, vfs-image, sort-package-matrix, partition-package-matrix, package-dependency-artifacts, archive-extract-member, set-build-commit, local-build, check-determinism, bootstrap, clean, cache-gc, verify-fresh, test-failures, runtime-workarounds check|list|run"
            );
            return ExitCode::from(2);
        }
    };
    let rest: Vec<String> = args.collect();
    if matches!(
        sub.as_str(),
        "bootstrap"
            | "local-build"
            | "partial-image"
            | "build-deps"
            | "bundle-program"
            | "stamp-abi-contract"
            | "vfs"
            | "vfs-image"
    ) {
        match supported_program_baseline::check(&repo_root()) {
            // WHY the gate says this out loud: admitting a prior program
            // contract beside the current one is the kind of thing a build
            // must never do silently, and until now only a direct
            // `check-program-baseline` reported it.
            //
            // WHY only the ACCEPTED ones: a superseded entry admits nothing —
            // it is the strict state, so saying so on every build would
            // announce a widening that is not happening.
            // `check-program-baseline` still reports every verdict.
            //
            // WHY not on a value query: see `announces_admission`.
            Ok(verdicts) if announces_admission(&sub, &rest) => {
                for verdict in &verdicts {
                    if verdict.widens_admission() {
                        eprintln!("{}", verdict.describe());
                    }
                }
            }
            Ok(_) => {}
            Err(error) => {
                eprintln!("xtask: {error}");
                return ExitCode::from(1);
            }
        }
    }
    if sub == "vfs" {
        return vfs_products::run(rest);
    }
    let result = match sub.as_str() {
        "vfs-image" => vfs_image_describe::run(&rest),
        "dump-abi" => dump_abi::run(rest),
        "check-program-env-imports" => program_env_imports::run(rest),
        "check-package-imports" => package_imports::run(rest),
        "bundle-program" => bundle_program::run(rest),
        "build-deps" => build_deps::run(rest),
        "compute-cache-key-sha" => build_deps::run_compute_cache_key_sha(rest),
        "workspace-closure-sha" => cargo_closure::run_workspace_closure_sha(rest),
        "sort-package-matrix" => package_matrix::run_sort(rest),
        "partition-package-matrix" => package_matrix::run_partition(rest),
        "package-dependency-artifacts" => package_matrix::run_dependency_artifacts(rest),
        "archive-extract-member" => archive_extract_member::run(rest),
        "set-build-commit" => update_pkg_manifest::run(rest),
        "local-build" => local_build::run(rest),
        "check-determinism" => determinism_check::run(rest),
        "bootstrap" => local_build::run_bootstrap(rest),
        "partial-image" => partial_image::run(rest),
        "clean" => local_build::run_clean(rest),
        #[cfg(unix)]
        "cache-gc" => cache_gc::run(rest),
        "stamp-abi-contract" => stamp_abi_contract::run(&rest),
        "abi-program-digest" => stamp_abi_contract::run_print(&rest),
        "check-program-baseline" => supported_program_baseline::run(&rest),
        "runtime-workarounds" => runtime_workarounds::run(rest),
        "verify-fresh" => local_build::run_verify_fresh(rest),
        "test-failures" => test_failures::run(rest),
        other => {
            eprintln!("xtask: unknown subcommand {other:?}");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("xtask {sub}: {e}");
            ExitCode::from(1)
        }
    }
}

/// Whether a gated invocation should announce an admitted prior program
/// contract on stderr.
///
/// Every gated subcommand *enforces* the supported program baseline; this
/// decides only which of them talk about it. A build that quietly starts
/// admitting a second program contract is the thing the announcement exists to
/// prevent, and all of `bootstrap`, `local-build`, `bundle-program`,
/// `stamp-abi-contract`, `vfs` and `vfs-image` either build or stamp.
///
/// `build-deps` is the one gated subcommand that is also a query surface.
/// `build-deps cache-root`, `path`, `sha` and their siblings exist to print
/// one machine-readable value a caller captures with `$(...)`; their contract
/// is that output and nothing else. A diagnostic line on stderr is noise there
/// at best, and for any consumer that merges the two streams it corrupts the
/// answer — `tools/xtask/tests/build_deps_cache_root.rs` pins `cache-root` to
/// write no stderr at all for exactly that reason. So the notice is suppressed
/// for those, and `build-deps resolve`, `install-local-artifact` and the index
/// writers — the arms that actually build or write — still carry it.
///
/// Which argument names the subcommand is answered by `build_deps` itself,
/// which owns the flag grammar; see [`build_deps::selects_value_query`].
fn announces_admission(sub: &str, rest: &[String]) -> bool {
    !(sub == "build-deps" && build_deps::selects_value_query(rest))
}

thread_local! {
    static REPO_ROOT_OVERRIDE: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

pub(crate) struct RepoRootOverrideGuard {
    // The guard resets thread-local state and therefore must be dropped on the
    // same thread that installed it.
    _not_send: PhantomData<Rc<()>>,
}

impl Drop for RepoRootOverrideGuard {
    fn drop(&mut self) {
        REPO_ROOT_OVERRIDE.with(|slot| {
            *slot.borrow_mut() = None;
        });
    }
}

pub(crate) fn install_repo_root_override(root: PathBuf) -> Result<RepoRootOverrideGuard, String> {
    REPO_ROOT_OVERRIDE.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_some() {
            return Err("xtask repository-root override is already installed".to_string());
        }
        *slot = Some(root);
        Ok(())
    })?;
    // WHY: the override belongs to one build-deps command, not ambient process
    // state. Restoring it on every return (including unwinding) keeps unit tests
    // and future in-process callers from inheriting another command's identity.
    Ok(RepoRootOverrideGuard {
        _not_send: PhantomData,
    })
}

pub fn repo_root() -> PathBuf {
    if let Some(root) = REPO_ROOT_OVERRIDE.with(|slot| slot.borrow().clone()) {
        return root;
    }
    // CARGO_MANIFEST_DIR points to tools/xtask/; go up two levels.
    let manifest = env!("CARGO_MANIFEST_DIR");
    Path::new(manifest)
        .parent()
        .and_then(Path::parent)
        .unwrap()
        .to_path_buf()
}

pub type JsonMap = BTreeMap<String, serde_json::Value>;

#[cfg(test)]
mod tests {
    use super::announces_admission;

    fn args(words: &str) -> Vec<String> {
        words.split_whitespace().map(ToOwned::to_owned).collect()
    }

    /// The gated subcommands that build or stamp all announce, and so do the
    /// `build-deps` arms that build or write.
    #[test]
    fn a_build_announces_what_it_admits() {
        for (sub, rest) in [
            ("bootstrap", ""),
            ("local-build", "run --set supported.json"),
            ("bundle-program", "coreutils"),
            ("stamp-abi-contract", "program.wasm"),
            ("vfs", "build shell"),
            ("vfs-image", "describe image.vfsi"),
            ("build-deps", "resolve zlib"),
            ("build-deps", "--arch=wasm64 resolve zlib"),
            ("build-deps", "install-local-artifact zlib libz.a"),
            ("build-deps", "program-index registry index.json"),
            ("build-deps", "program-index-context-ensure"),
            ("build-deps", "check"),
        ] {
            assert!(
                announces_admission(sub, &args(rest)),
                "xtask {sub} {rest} must announce an admitted prior contract"
            );
        }
    }

    /// A value query's whole contract is its stdout. Announcing on stderr is
    /// noise there, and corrupts the answer for a consumer that merges the
    /// streams.
    #[test]
    fn a_value_query_stays_quiet() {
        for rest in [
            "cache-root",
            "toolchain-inputs",
            "parse zlib",
            "path zlib",
            "sha zlib",
            "output-path zlib libz",
            "output-metadata zlib libz.a",
            "runtime-file-path ncurses terminfo",
            "runtime-file-metadata ncurses terminfo",
            "output-fork-instrumentation bash bash",
            "output-fork-instrumentation-for-rel programs/bash/bash.wasm",
        ] {
            assert!(
                !announces_admission("build-deps", &args(rest)),
                "xtask build-deps {rest} prints one captured value and must stay quiet"
            );
        }
    }

    /// `build-deps` takes its global flags in any position, so the quiet set
    /// must be recognised through them rather than at a fixed argv index.
    #[test]
    fn a_value_query_stays_quiet_behind_flags_in_any_position() {
        for rest in [
            "--arch=wasm64 path zlib",
            "--arch wasm64 path zlib",
            "path zlib --arch=wasm64",
            "path --arch wasm64 zlib",
            "--source-repo-root=/reviewed/kandelo sha zlib",
            "--source-repo-root /reviewed/kandelo sha zlib",
            "--source-only cache-root",
            "--force-source-build sha zlib",
            "--binaries-dir=/tmp/bin path zlib",
            "--binaries-dir /tmp/bin path zlib",
        ] {
            assert!(
                !announces_admission("build-deps", &args(rest)),
                "xtask build-deps {rest} names a value query and must stay quiet"
            );
        }
    }

    /// An unparseable or empty `build-deps` invocation is about to fail in its
    /// own argument parsing. It is not a value query, so the gate keeps
    /// speaking: suppressing there would hide an admission widening behind a
    /// typo.
    #[test]
    fn a_malformed_build_deps_invocation_still_announces() {
        for rest in ["", "--arch", "--arch=sparc path zlib", "not-a-subcommand"] {
            assert!(
                announces_admission("build-deps", &args(rest)),
                "xtask build-deps {rest:?} is not a value query"
            );
        }
    }
}

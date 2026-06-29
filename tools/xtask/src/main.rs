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
//!   sort-package-matrix   Order a package matrix so selected program dependencies
//!                         appear before their dependents.
//!   package-dependency-artifacts
//!                         Print workflow artifact names for selected direct
//!                         program dependencies of one package matrix entry.
//!   archive-stage         Produce one package's `.tar.zst` archive into --out.
//!                         Args: --package <dir> --arch <wasm32|wasm64>
//!                               --out <dir> --build-timestamp <ISO> --build-host <s>.
//!                         Used by matrix-build entries.
//!   build-index           Emit `index.toml` (the post-publish provenance
//!                         manifest) from a directory of staged
//!                         `.tar.zst` archives. Args: --abi <N>
//!                         --generator <s> --archives-dir <dir>
//!                         --out <path> [--generated-at <RFC3339>].
//!                         Used by the `generate-index` job after
//!                         per-file uploads land.
//!   set-build-commit      Stamp `[build].commit = <sha>` into one
//!                         `packages/registry/<name>/package.toml`. Used by the
//!                         publish flow when an archive is uploaded;
//!                         mirrors the lifecycle of
//!                         `[binary].archive_url` + `archive_sha256`.
//!   set-package-binary    Update `[binary.<arch>].archive_url` +
//!                         `archive_sha256` (multi-arch) or `[binary]`
//!                         (single-arch) in one
//!                         `packages/registry/<name>/package.toml`. Used by
//!                         Phase C's `amend-package-toml` job in
//!                         `.github/workflows/prepare-merge.yml` (and the
//!                         force-rebuild equivalent) to point the in-tree
//!                         manifest at a freshly-published archive.
//!   homebrew-sidecars     Generate Kandelo/Homebrew tap sidecars from
//!                         produced bottle bytes and workflow evidence.
//!   homebrew-validate     Validate Kandelo/Homebrew tap sidecar metadata.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

mod archive_stage;
mod archive_stage_cli;
mod build_deps;
mod build_index;
mod bundle_program;
mod dump_abi;
#[cfg(test)]
mod homebrew_schema;
mod homebrew_sidecars;
mod homebrew_validate;
mod host_tool_probe;
mod index_toml;
mod index_update;
mod package_matrix;
mod pkg_manifest;
mod remote_fetch;
mod source_extract;
mod update_pkg_manifest;
mod util;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let sub = match args.next() {
        Some(s) => s,
        None => {
            eprintln!("usage: xtask <subcommand> [args...]");
            eprintln!(
                "subcommands: dump-abi, bundle-program, build-deps, compute-cache-key-sha, sort-package-matrix, package-dependency-artifacts, archive-stage, build-index, set-build-commit, set-package-binary, index-update, homebrew-sidecars, homebrew-validate"
            );
            return ExitCode::from(2);
        }
    };
    let rest: Vec<String> = args.collect();
    let result = match sub.as_str() {
        "dump-abi" => dump_abi::run(rest),
        "bundle-program" => bundle_program::run(rest),
        "build-deps" => build_deps::run(rest),
        "compute-cache-key-sha" => build_deps::run_compute_cache_key_sha(rest),
        "sort-package-matrix" => package_matrix::run_sort(rest),
        "package-dependency-artifacts" => package_matrix::run_dependency_artifacts(rest),
        "archive-stage" => archive_stage_cli::run(rest),
        "build-index" => build_index::run(rest),
        "set-build-commit" => update_pkg_manifest::run(rest),
        "set-package-binary" => update_pkg_manifest::run_set_package_binary(rest),
        "index-update" => index_update::run_index_update(&rest),
        "homebrew-sidecars" => homebrew_sidecars::run(rest),
        "homebrew-validate" => homebrew_validate::run(rest),
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

pub fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR points to tools/xtask/; go up two levels.
    let manifest = env!("CARGO_MANIFEST_DIR");
    Path::new(manifest)
        .parent()
        .and_then(Path::parent)
        .unwrap()
        .to_path_buf()
}

pub type JsonMap = BTreeMap<String, serde_json::Value>;

//! xtask — repo-local utilities.
//!
//! Subcommands:
//!   dump-abi              Regenerate `abi/snapshot.json` from authoritative sources.
//!   build-manifest        Generate a binary-release `manifest.json` from a staging dir.
//!   bundle-program        Zip-bundle one program's binary + runtime + LICENSE.
//!   build-deps            Wasm library dep-graph resolver (see docs/dependency-management.md).
//!   compute-cache-key-sha Print a package's cache-key sha (64 hex chars) to stdout.
//!                         Args: --package <dir> --arch <wasm32|wasm64>. Used by the
//!                         Phase B-1 pre-flight workflow to skip already-published
//!                         matrix entries.
//!   archive-stage         Produce one package's `.tar.zst` archive into --out.
//!                         Args: --package <dir> --arch <wasm32|wasm64>
//!                               --out <dir> --build-timestamp <ISO> --build-host <s>.
//!                         Per-package wrapper around the same internals
//!                         `stage-release` uses; doesn't walk the registry or emit a
//!                         manifest.json. Used by Phase B-1 matrix-build entries.
//!   build-index           Emit `index.toml` (the source manifest of
//!                         §3.2 in the Phase B-1 design doc) from a
//!                         directory of staged `.tar.zst` archives.
//!                         Args: --abi <N> --generator <s>
//!                               --archives-dir <dir> --out <path>
//!                               [--generated-at <RFC3339>].
//!                         Used by Phase B-1's `generate-index` job
//!                         after per-file uploads land.
//!   stage-release         Orchestrate full V2 producer side: walk registry, build
//!                         archives, emit manifest.json into a staging directory.
//!   stage-pr-overlay      Stage only changed-vs-baseline archives + overlay file
//!                         for per-PR staging release uploads.
//!   install-release       Consumer side of V2: read manifest.json, fetch + verify
//!                         library/program archives, mirror program outputs into
//!                         local-binaries/.
//!   set-build-commit      Stamp `[build].commit = <sha>` into one
//!                         `examples/libs/<name>/package.toml`. Used by the
//!                         publish flow (Phase A-bis Task 5) when an archive
//!                         is uploaded; mirrors the lifecycle of
//!                         `[binary].archive_url` + `archive_sha256`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

mod archive_stage;
mod archive_stage_cli;
mod build_deps;
mod build_index;
mod build_manifest;
mod bundle_program;
mod pkg_manifest;
mod dump_abi;
mod host_tool_probe;
mod install_release;
mod remote_fetch;
mod source_extract;
mod stage_pr_overlay;
mod stage_release;
mod update_pkg_manifest;
mod util;
mod wasm_abi;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let sub = match args.next() {
        Some(s) => s,
        None => {
            eprintln!("usage: xtask <subcommand> [args...]");
            eprintln!(
                "subcommands: dump-abi, build-manifest, bundle-program, build-deps, compute-cache-key-sha, archive-stage, build-index, stage-release, stage-pr-overlay, install-release, set-build-commit"
            );
            return ExitCode::from(2);
        }
    };
    let rest: Vec<String> = args.collect();
    let result = match sub.as_str() {
        "dump-abi" => dump_abi::run(rest),
        "build-manifest" => build_manifest::run(rest),
        "bundle-program" => bundle_program::run(rest),
        "build-deps" => build_deps::run(rest),
        "compute-cache-key-sha" => build_deps::run_compute_cache_key_sha(rest),
        "archive-stage" => archive_stage_cli::run(rest),
        "build-index" => build_index::run(rest),
        "stage-release" => stage_release::run(rest),
        "stage-pr-overlay" => stage_pr_overlay::run(rest),
        "install-release" => install_release::run(rest),
        "set-build-commit" => update_pkg_manifest::run(rest),
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
    // CARGO_MANIFEST_DIR points to xtask/; go up one level.
    let manifest = env!("CARGO_MANIFEST_DIR");
    Path::new(manifest).parent().unwrap().to_path_buf()
}

pub type JsonMap = BTreeMap<String, serde_json::Value>;

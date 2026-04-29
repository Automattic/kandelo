//! xtask — repo-local utilities.
//!
//! Subcommands:
//!   dump-abi        Regenerate `abi/snapshot.json` from authoritative sources.
//!   build-manifest  Generate a binary-release `manifest.json` from a staging dir.
//!   bundle-program  Zip-bundle one program's binary + runtime + LICENSE.
//!   build-deps      Wasm library dep-graph resolver (see docs/dependency-management.md).
//!   stage-release   Orchestrate full V2 producer side: walk registry, build
//!                   archives, emit manifest.json into a staging directory.
//!   install-release Consumer side of V2: read manifest.json, fetch + verify
//!                   library/program archives, mirror program outputs into
//!                   local-binaries/.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

mod archive_stage;
mod build_deps;
mod build_manifest;
mod bundle_program;
mod deps_manifest;
mod dump_abi;
mod host_tool_probe;
mod install_release;
mod remote_fetch;
mod source_extract;
mod stage_release;
mod util;
mod wasm_abi;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let sub = match args.next() {
        Some(s) => s,
        None => {
            eprintln!("usage: xtask <subcommand> [args...]");
            eprintln!(
                "subcommands: dump-abi, build-manifest, bundle-program, build-deps, stage-release, install-release"
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
        "stage-release" => stage_release::run(rest),
        "install-release" => install_release::run(rest),
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

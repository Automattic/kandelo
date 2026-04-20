//! xtask — repo-local utilities.
//!
//! Subcommands:
//!   dump-abi        Regenerate `abi/snapshot.json` from authoritative sources.
//!   build-manifest  Generate a binary-release `manifest.json` from a staging dir.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

mod build_manifest;
mod dump_abi;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let sub = match args.next() {
        Some(s) => s,
        None => {
            eprintln!("usage: xtask <subcommand> [args...]");
            eprintln!("subcommands: dump-abi, build-manifest");
            return ExitCode::from(2);
        }
    };
    let rest: Vec<String> = args.collect();
    let result = match sub.as_str() {
        "dump-abi" => dump_abi::run(rest),
        "build-manifest" => build_manifest::run(rest),
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

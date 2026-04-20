//! xtask — repo-local utilities.
//!
//! Subcommands:
//!   dump-abi   Regenerate `abi/snapshot.json` from authoritative sources.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

mod dump_abi;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let sub = match args.next() {
        Some(s) => s,
        None => {
            eprintln!("usage: xtask <subcommand> [args...]");
            eprintln!("subcommands: dump-abi");
            return ExitCode::from(2);
        }
    };
    match sub.as_str() {
        "dump-abi" => match dump_abi::run(args.collect()) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("xtask dump-abi: {e}");
                ExitCode::from(1)
            }
        },
        other => {
            eprintln!("xtask: unknown subcommand {other:?}");
            ExitCode::from(2)
        }
    }
}

pub fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR points to xtask/; go up one level.
    let manifest = env!("CARGO_MANIFEST_DIR");
    Path::new(manifest).parent().unwrap().to_path_buf()
}

pub type JsonMap = BTreeMap<String, serde_json::Value>;

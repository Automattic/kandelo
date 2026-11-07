//! The pre-dispatch supported-program-baseline gate, through the real CLI.
//!
//! `tools/xtask/src/main.rs` runs `supported_program_baseline::check` before
//! dispatching the subcommands that build, stamp or write an artifact. Two
//! properties matter and neither is visible from a unit test of the gate:
//!
//! 1. The gate must not swallow dispatch. Every gated subcommand still has to
//!    reach its own argument parsing, so a gate that started failing would be
//!    distinguishable from a subcommand that rejected its arguments.
//! 2. When the committed `abi/accepted-program-digests.json` admits a prior
//!    program contract beside the current one, a build must say so out loud —
//!    and a value-returning query must not, because its contract is its
//!    stdout and a consumer may merge the two streams.
//!
//! These run the built binary rather than calling in-process: the gate's whole
//! job is to run before dispatch, and only a real invocation shows that.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// Gated subcommands, each with arguments chosen to fail in that
/// subcommand's own parsing, and a fragment of the message only that
/// subcommand produces.
///
/// WHY deliberately-invalid arguments: a valid invocation of `bootstrap` or
/// `local-build run` would start a multi-hour build. Reaching the
/// subcommand's own complaint is exactly the evidence wanted — the gate ran,
/// passed, and handed over.
const GATED: &[(&str, &[&str], &str)] = &[
    ("bootstrap", &["--xtask-no-such-flag"], "unknown local-build flag"),
    (
        "local-build",
        &["--xtask-no-such-flag"],
        "unknown local-build subcommand",
    ),
    ("build-deps", &[], "usage: xtask build-deps"),
    ("bundle-program", &[], "--program is required"),
    ("stamp-abi-contract", &[], "usage: xtask stamp-abi-contract"),
    ("vfs-image", &[], "usage: xtask vfs-image"),
];

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("xtask remains below the repository root")
        .to_path_buf()
}

fn xtask(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_xtask"))
        .args(args)
        .output()
        .expect("run the xtask CLI")
}

/// The prior contracts the committed record admits under the declared epoch,
/// read the way the hosts read them: from the generated module the gate's own
/// `dump-abi --check` keeps in sync with the record.
fn accepted_digests() -> Vec<String> {
    let generated = std::fs::read_to_string(repo_root().join("host/src/generated/abi.ts"))
        .expect("read the generated ABI module");
    let (_, after) = generated
        .split_once("ACCEPTED_PROGRAM_CONTRACT_DIGESTS: readonly string[] = [")
        .expect("the generated module declares the accepted set");
    let (body, _) = after.split_once(']').expect("the accepted set is a literal");
    body.split('"')
        .filter(|piece| piece.len() == 64 && piece.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(ToOwned::to_owned)
        .collect()
}

#[test]
fn every_gated_subcommand_still_reaches_its_own_argument_parsing() {
    for (sub, args, expected) in GATED {
        let mut argv = vec![*sub];
        argv.extend_from_slice(args);
        let output = xtask(&argv);
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        assert!(
            stderr.contains(expected),
            "xtask {argv:?} must reach its own argument parsing, not stop at the \
             baseline gate; stderr was: {stderr}"
        );
    }
}

/// `xtask vfs` answers its own usage on stdout and exits 0, so it is checked
/// separately from the subcommands that complain on stderr.
#[test]
fn the_vfs_gate_hands_over_to_its_own_usage() {
    let output = xtask(&["vfs"]);
    assert!(output.status.success(), "xtask vfs reports usage and succeeds");
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("usage: xtask vfs"),
        "xtask vfs must reach its own usage text"
    );
}

/// A build that is about to admit a prior program contract says which one.
///
/// Vacuous while the committed record admits none under the declared epoch,
/// and load-bearing as soon as one is affirmed — which is the state this
/// branch lands in.
#[test]
fn a_build_names_each_prior_contract_it_admits() {
    let accepted = accepted_digests();
    for (sub, args, _) in GATED {
        let mut argv = vec![*sub];
        argv.extend_from_slice(args);
        let stderr = String::from_utf8_lossy(&xtask(&argv).stderr).into_owned();
        for digest in &accepted {
            assert!(
                stderr.contains(digest),
                "xtask {argv:?} admits prior program contract {digest} and must \
                 say so; stderr was: {stderr}"
            );
        }
    }
}

/// And a value query says nothing at all, however many contracts are
/// admitted: its contract is the value on stdout, and a caller may read the
/// two streams as one. `build_deps_cache_root.rs` pins `cache-root` to an
/// empty stderr; this covers the rest of the query surface against the same
/// hazard.
///
/// Asserting the stream is *empty*, rather than merely free of the digests,
/// keeps this meaningful whatever the record holds: it is the queries' actual
/// contract, so it neither passes vacuously when the accepted set is empty nor
/// fails spuriously when a future epoch bump empties it.
#[test]
fn a_value_query_says_nothing_at_all() {
    for args in [
        vec!["build-deps", "cache-root"],
        vec!["build-deps", "toolchain-inputs"],
        vec!["build-deps", "parse", "zlib"],
        vec!["build-deps", "path", "zlib"],
        vec!["build-deps", "sha", "zlib"],
        vec!["build-deps", "--arch=wasm64", "path", "zlib"],
    ] {
        let output = xtask(&args);
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        assert!(
            output.status.success() && stderr.is_empty(),
            "xtask {args:?} prints one captured value and must write no stderr: \
             {stderr}"
        );
        assert!(
            !output.stdout.is_empty(),
            "xtask {args:?} must still answer on stdout"
        );
    }
}

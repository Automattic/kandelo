use std::path::Path;
use std::process::Command;

#[test]
fn cache_root_prints_one_repo_anchored_absolute_path() {
    let relative_cache = ".test-build-deps-cache-root";
    let output = Command::new(env!("CARGO_BIN_EXE_xtask"))
        .args(["build-deps", "cache-root"])
        .env("WASM_POSIX_BINARY_CACHE_ROOT", relative_cache)
        .output()
        .expect("run the xtask CLI");

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "unexpected stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("xtask remains below the repository root");
    let expected = format!("{}\n", repo_root.join(relative_cache).display());
    assert_eq!(String::from_utf8(output.stdout).unwrap(), expected);
    assert!(repo_root.join(relative_cache).is_absolute());
}

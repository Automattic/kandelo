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

#[test]
fn path_and_sha_follow_source_only_policy_without_creating_cache() {
    let temp = tempfile::tempdir().unwrap();
    let canonical_temp = std::fs::canonicalize(temp.path()).unwrap();
    let ordinary = canonical_temp.join("ordinary");
    let source = canonical_temp.join("source");
    let inspect = |subcommand: &str, policy: Option<&str>| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_xtask"));
        command
            .args(["build-deps", subcommand, "libdrm"])
            .env("WASM_POSIX_BINARY_CACHE_ROOT", &ordinary)
            .env_remove("WASM_POSIX_DEPS_REGISTRY")
            .env_remove("WASM_POSIX_SOURCE_ONLY_CACHE_ROOT")
            .env_remove("WASM_POSIX_RESOLUTION_POLICY")
            .env("XDG_CACHE_HOME", &source);
        if let Some(policy) = policy {
            command.env("WASM_POSIX_RESOLUTION_POLICY", policy);
        }
        command.output().expect("run inspection CLI")
    };
    let text = |output: std::process::Output| {
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    };
    let default_path = text(inspect("path", None));
    let default_sha = text(inspect("sha", None));
    assert!(Path::new(&default_path).starts_with(ordinary.join("libs")));
    assert!(default_path.ends_with(&default_sha));
    let source_path = text(inspect("path", Some("source-only-v1")));
    let source_sha = text(inspect("sha", Some("source-only-v1")));
    assert!(
        Path::new(&source_path)
            .starts_with(source.join("kandelo/source-only/source-only-v1/compiled/libs"))
    );
    assert!(source_path.ends_with(&source_sha));
    assert_ne!(source_sha, default_sha);
    assert!(!ordinary.exists());
    assert!(
        !source.exists(),
        "read-only inspection must not create the source-only cache"
    );
    let rejected = inspect("path", Some("unknown"));
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("must be absent or exactly"));
}

//! `configure` and `pkg-config` (ported from sdk/test/configure.test.ts and
//! sdk/test/pkg-config.test.ts).

use kandelo_cc::arch::WasmArch;
use kandelo_cc::tools::{configure_args, configure_env, pkg_config_env};

fn value<'a>(env: &'a [(String, String)], name: &str) -> Option<&'a str> {
    env.iter()
        .rev()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| v.to_string()).collect()
}

#[test]
fn configure_args_include_host_and_prefix() {
    let args = configure_args(&[], WasmArch::Wasm32);
    assert!(args.contains(&"--host=wasm32-unknown-linux-musl".to_string()));
    assert!(args.contains(&"--prefix=/usr".to_string()));
}

#[test]
fn configure_args_use_the_musl_userland_identity_for_wasm64() {
    assert!(
        configure_args(&[], WasmArch::Wasm64)
            .contains(&"--host=wasm64-unknown-linux-musl".to_string())
    );
}

#[test]
fn configure_args_forward_extra_user_args() {
    let args = configure_args(
        &strings(&["--disable-shared", "--without-pear"]),
        WasmArch::Wasm32,
    );
    assert_eq!(
        &args[2..],
        &strings(&["--disable-shared", "--without-pear"])[..]
    );
}

/// Point SDK discovery at this checkout's sdk/ (the test binary is not
/// installed inside an SDK).
fn use_repository_sdk() {
    // SAFETY: tests in this crate run single-threaded (.cargo/config.toml).
    unsafe {
        std::env::set_var(
            "WASM_POSIX_SDK_ROOT",
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../sdk"),
        )
    };
}

#[test]
fn configure_env_names_the_sdk_tools() {
    use_repository_sdk();
    let env = configure_env(WasmArch::Wasm32).unwrap();
    assert_eq!(value(&env, "CC"), Some("wasm32posix-cc"));
    assert_eq!(value(&env, "AR"), Some("wasm32posix-ar"));
    assert_eq!(value(&env, "STRIP"), Some("wasm32posix-strip"));
    assert_eq!(value(&env, "WASM_POSIX_TARGET_ARCH"), Some("wasm32"));
    // The SDK's config.site, unless the caller exported its own.
    assert!(value(&env, "CONFIG_SITE").is_some_and(|site| site.ends_with("/sdk/config.site")));
}

#[test]
fn configure_env_identifies_wasm64_so_config_site_selects_lp64_values() {
    use_repository_sdk();
    let env = configure_env(WasmArch::Wasm64).unwrap();
    assert_eq!(value(&env, "CC"), Some("wasm64posix-cc"));
    assert_eq!(value(&env, "WASM_POSIX_TARGET_ARCH"), Some("wasm64"));
}

const SYSROOT: &str = "/tmp/test-sysroot";

fn pc_path(caller: &str, resolver: &str) -> String {
    value(
        &pkg_config_env(caller, resolver, SYSROOT),
        "PKG_CONFIG_PATH",
    )
    .unwrap()
    .to_string()
}

#[test]
fn pkg_config_libdir_is_the_sysroot_lib_and_share_dirs() {
    let env = pkg_config_env("", "", SYSROOT);
    assert_eq!(
        value(&env, "PKG_CONFIG_LIBDIR"),
        Some("/tmp/test-sysroot/lib/pkgconfig:/tmp/test-sysroot/share/pkgconfig")
    );
}

#[test]
fn pkg_config_keeps_wasm_cache_paths() {
    let cache = "/Users/x/.cache/kandelo/libs/zlib-1.3.1-rev1-9acb9405/lib/pkgconfig";
    assert_eq!(pc_path(cache, ""), cache);
}

#[test]
fn pkg_config_keeps_exact_main_metadata_only_inside_the_target_cache_namespace() {
    assert_eq!(
        pc_path(
            "/home/runner/work/_temp/exact-main-package-cache.abc/libs/icu/lib/pkgconfig",
            ""
        ),
        ""
    );
    let target =
        "/home/runner/work/_temp/kandelo/exact-main-package-cache.abc/libs/icu/lib/pkgconfig";
    assert_eq!(pc_path(target, ""), target);
}

#[test]
fn pkg_config_keeps_a_path_the_resolver_provided_whatever_the_cache_root_is_called() {
    // A per-worktree cache root ("kandelo-lane-f") fails the name test; the
    // resolver's own list (WASM_POSIX_DEP_PKG_CONFIG_PATH) answers by provenance.
    let lane = "/Users/x/.cache/kandelo-lane-f/source-only/source-only-v1/compiled/libs/icu-74.2/lib/pkgconfig";
    assert_eq!(
        pc_path(lane, ""),
        "",
        "without the resolver variable the name test still rejects it"
    );
    assert_eq!(pc_path(lane, lane), lane);
}

#[test]
fn pkg_config_drops_a_host_path_even_when_the_resolver_variable_is_set() {
    let host = "/nix/store/abc-openssl-3.0/lib/pkgconfig";
    let lane = "/Users/x/.cache/kandelo-lane-f/libs/icu/lib/pkgconfig";
    assert_eq!(pc_path(&format!("{host}:{lane}"), lane), lane);
}

#[test]
fn pkg_config_path_defaults_to_empty() {
    assert_eq!(pc_path("", ""), "");
}

#[test]
fn pkg_config_drops_host_nix_store_paths() {
    let host = "/nix/store/x56h6pvq8gs6qc3ab1f3kjncn6vlspjp-openssl-3.6.1-dev/lib/pkgconfig:\
                /nix/store/24yccf3vq5wzwzvfsijz42f1iv3vqrvw-nghttp2-1.67.1-dev/lib/pkgconfig";
    assert_eq!(pc_path(host, ""), "");
}

#[test]
fn pkg_config_keeps_wasm_paths_interleaved_with_host_paths() {
    let wasm = "/Users/x/.cache/kandelo/libs/openssl-3.3.2-rev1-wasm32-abc/lib/pkgconfig";
    let host = "/nix/store/abc-openssl-3.6.1-dev/lib/pkgconfig";
    assert_eq!(pc_path(&format!("{host}:{wasm}:{host}"), ""), wasm);
}

#[test]
fn pkg_config_keeps_in_tree_sysroot_paths() {
    let sysroot_pc = "/Users/x/repo/sysroot/lib/pkgconfig";
    assert_eq!(pc_path(sysroot_pc, ""), sysroot_pc);
}

#[test]
fn pkg_config_sets_only_libdir_and_path() {
    // PKG_CONFIG_SYSROOT_DIR is not set (a sysroot prefix would corrupt the
    // absolute paths in the SDK's .pc files), and everything else the caller
    // exported, including an inherited PKG_CONFIG_SYSROOT_DIR, passes through
    // untouched because pkg-config inherits the caller's environment.
    let names: Vec<String> = pkg_config_env("", "", SYSROOT)
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    assert_eq!(names, strings(&["PKG_CONFIG_LIBDIR", "PKG_CONFIG_PATH"]));
}

//! The SDK's other tools: the binutils-style pass-throughs, `strip`,
//! `configure` and `pkg-config`.

use crate::arch::{tool_prefix, WasmArch};
use crate::flags::join;
use crate::toolchain::{find_sysroot, resolve_toolchain, sdk_config_site};
use crate::Result;
use std::process::Command;

/// GNU build-system identity for Kandelo's musl userland.
///
/// Deliberately separate from the LLVM target triple: config.sub requires a
/// Linux kernel component for a musl tuple, while LLVM does not support that
/// tuple for Wasm code generation. The value lets Autoconf and gnulib select
/// musl ABI and libc behavior; it does not claim that Kandelo has a Linux
/// kernel or define __linux__ for compiled programs.
pub fn autoconf_host_triple(arch: WasmArch) -> String {
    format!("{}-unknown-linux-musl", arch.as_str())
}

fn run_with_env(program: &str, args: &[String], env: &[(String, String)]) -> i32 {
    match Command::new(program).args(args).envs(env.iter().cloned()).status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(_) => 127,
    }
}

/// `llvm-ar`, `llvm-ranlib` or `llvm-nm` from the resolved LLVM tree.
pub fn llvm_passthrough(tool: &str, args: &[String]) -> Result<i32> {
    // The binutils-style tools are arch-independent; like the SDK always
    // has, they resolve the wasm32 toolchain.
    let toolchain = resolve_toolchain(WasmArch::Wasm32)?;
    Ok(crate::exec::run_passthrough(&join(&toolchain.llvm_dir, tool), args))
}

/// The environment `configure` runs under: the SDK's tools and the
/// cross-compilation cache (`config.site`), unless the caller exported its own.
pub fn configure_env(arch: WasmArch) -> Result<Vec<(String, String)>> {
    let prefix = tool_prefix(arch);
    let config_site = match std::env::var("CONFIG_SITE") {
        Ok(site) if !site.is_empty() => Some(site),
        _ => sdk_config_site()?,
    };
    let inherited = |name: &str| std::env::var(name).unwrap_or_default();
    let mut env = vec![
        ("CC".into(), format!("{prefix}-cc")),
        ("CXX".into(), format!("{prefix}-c++")),
        ("AR".into(), format!("{prefix}-ar")),
        ("RANLIB".into(), format!("{prefix}-ranlib")),
        ("NM".into(), format!("{prefix}-nm")),
        ("STRIP".into(), format!("{prefix}-strip")),
        ("PKG_CONFIG".into(), format!("{prefix}-pkg-config")),
        ("WASM_POSIX_TARGET_ARCH".into(), arch.as_str().to_string()),
        ("CFLAGS".into(), inherited("CFLAGS")),
        ("CXXFLAGS".into(), inherited("CXXFLAGS")),
        ("LDFLAGS".into(), inherited("LDFLAGS")),
    ];
    if let Some(site) = config_site {
        env.push(("CONFIG_SITE".into(), site));
    }
    Ok(env)
}

pub fn configure_args(user_args: &[String], arch: WasmArch) -> Vec<String> {
    let mut args = vec![format!("--host={}", autoconf_host_triple(arch)), "--prefix=/usr".to_string()];
    args.extend(user_args.iter().cloned());
    args
}

pub fn configure(arch: WasmArch, user_args: &[String]) -> Result<i32> {
    Ok(run_with_env("./configure", &configure_args(user_args, arch), &configure_env(arch)?))
}

/// Anything under `kandelo/...` (the dep cache root) or a sysroot is
/// wasm-targeted; everything else is host-targeted (Nix-store host .pc
/// files, /usr/lib/pkgconfig, …) and is dropped.
fn is_wasm_posix_path(p: &str) -> bool {
    p.contains("kandelo/")
        || p.contains("/sysroot/")
        || p.contains("/sysroot64/")
        || p.ends_with("/sysroot/lib/pkgconfig")
        || p.ends_with("/sysroot64/lib/pkgconfig")
}

/// The environment `pkg-config` runs under.
///
/// PKG_CONFIG_PATH is honoured from the caller but FILTERED to wasm-targeted
/// paths: Nix's pkg-config wrapper fills it with host buildInputs' .pc dirs,
/// which would otherwise win over the dependency flags a package build sets.
/// A path the resolver listed in WASM_POSIX_DEP_PKG_CONFIG_PATH (every
/// dependency it installed for this package) is wasm-targeted by provenance,
/// whatever its cache root is called.
///
/// PKG_CONFIG_SYSROOT_DIR is intentionally not set: every .pc file the SDK
/// produces has absolute paths in `prefix=`, so prepending a sysroot would
/// corrupt the emitted -I/-L flags.
pub fn pkg_config_env(caller_path: &str, resolver_paths: &str, sysroot: &str) -> Vec<(String, String)> {
    let resolver: std::collections::HashSet<&str> = resolver_paths.split(':').filter(|p| !p.is_empty()).collect();
    let filtered: Vec<&str> = caller_path
        .split(':')
        .filter(|p| !p.is_empty() && (is_wasm_posix_path(p) || resolver.contains(p)))
        .collect();
    vec![
        (
            "PKG_CONFIG_LIBDIR".into(),
            format!("{sysroot}/lib/pkgconfig:{sysroot}/share/pkgconfig"),
        ),
        ("PKG_CONFIG_PATH".into(), filtered.join(":")),
    ]
}

pub fn pkg_config(arch: WasmArch, args: &[String]) -> Result<i32> {
    let sysroot = find_sysroot(arch)?;
    let env = pkg_config_env(
        &std::env::var("PKG_CONFIG_PATH").unwrap_or_default(),
        &std::env::var("WASM_POSIX_DEP_PKG_CONFIG_PATH").unwrap_or_default(),
        &sysroot,
    );
    Ok(run_with_env("pkg-config", args, &env))
}

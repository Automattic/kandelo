//! The build machine's toolchain discovery. Ported from
//! sdk/test/toolchain.test.ts, made independent of the dev shell: the LLVM
//! search runs against fake tools in a temporary directory.

#![cfg(not(target_os = "kandelo"))]

use kandelo_cc::arch::WasmArch;
use kandelo_cc::driver::TempDir;
use kandelo_cc::node_path::basename;
use kandelo_cc::toolchain::{find_glue_dir, find_llvm_dir, find_sysroot};
use std::sync::{Mutex, MutexGuard};

/// Serializes the tests that change the process environment.
static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Clears or sets environment variables, restoring every original value on drop.
struct EnvGuard {
    saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
    _lock: MutexGuard<'static, ()>,
}

impl EnvGuard {
    fn new() -> EnvGuard {
        EnvGuard { saved: Vec::new(), _lock: ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner()) }
    }

    fn set(&mut self, name: &'static str, value: Option<&str>) {
        if !self.saved.iter().any(|(saved, _)| *saved == name) {
            self.saved.push((name, std::env::var_os(name)));
        }
        // SAFETY: ENV_LOCK serializes the tests in this binary that touch the
        // environment, and none of them spawns threads that read it.
        unsafe {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (name, value) in self.saved.drain(..).rev() {
            // SAFETY: as in `set`.
            unsafe {
                match value {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }
}

/// Write an executable shell script that exits 0.
fn fake_tool(dir: &std::path::Path, name: &str) {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(name);
    std::fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

// findLlvmDir

#[test]
fn finds_llvm_from_auto_detection() {
    // The TypeScript test found the dev shell's LLVM. Here a PATH entry holds
    // a complete set of fake tools whose clang accepts the wasm32 probe, and
    // the overrides that take precedence over PATH are unset.
    let bin = TempDir::new("kandelo-cc-llvm-").unwrap();
    for tool in ["clang", "clang++", "llvm-ar", "llvm-ranlib", "llvm-nm", "wasm-ld"] {
        fake_tool(bin.path(), tool);
    }
    let bin_dir = bin.path().to_str().unwrap();

    let mut env = EnvGuard::new();
    env.set("WASM_POSIX_LLVM_DIR", None);
    env.set("LLVM_BIN", None);
    env.set("LLVM_PREFIX", None);
    env.set("PATH", Some(bin_dir));
    assert_eq!(find_llvm_dir().unwrap(), bin_dir);
}

// findSysroot

#[test]
fn resolves_sysroot_relative_to_the_sdk_root() {
    let mut env = EnvGuard::new();
    env.set("WASM_POSIX_SYSROOT", None);
    assert!(find_sysroot(WasmArch::Wasm32).unwrap().contains("sysroot"));
}

#[test]
fn selects_the_sysroot_matching_the_compiler_architecture() {
    let mut env = EnvGuard::new();
    env.set("WASM_POSIX_SYSROOT", None);
    assert_eq!(basename(&find_sysroot(WasmArch::Wasm32).unwrap()), "sysroot");
    assert_eq!(basename(&find_sysroot(WasmArch::Wasm64).unwrap()), "sysroot64");
}

// findGlueDir

#[test]
fn resolves_glue_dir_relative_to_the_sdk_root() {
    let mut env = EnvGuard::new();
    env.set("WASM_POSIX_GLUE_DIR", None);
    assert!(find_glue_dir().unwrap().contains("libc/glue"));
}

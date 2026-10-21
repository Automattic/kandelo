//! Finding the LLVM tools, sysroot and glue a build uses.
//!
//! This is the one part of the driver that differs between its two builds:
//! the build machine's SDK discovers a host LLVM installation and the
//! repository it builds from, while Kandelo's SDK has a fixed layout under
//! `/usr` (see `images/vfs/scripts/build-kandelo-sdk-zip.sh`). Both honour
//! the same `WASM_POSIX_*` overrides. Everything after discovery — the
//! compiler and linker jobs — is shared.

use crate::Result;
use crate::arch::{WasmArch, sysroot_dir};
use crate::flags::{CallTypesPlugin, join};
use std::path::Path;

#[derive(Clone, Debug)]
pub struct Toolchain {
    pub llvm_dir: String,
    pub lld_major: Option<u32>,
    pub cc: String,
    pub cxx: String,
    pub sysroot: String,
    pub glue_dir: String,
    /// The KandeloCallTypes plugin to load into C/C++ compiles, or `None` to
    /// compile without it. The compiler driver sets it; argument builders
    /// only read it.
    pub calltypes_plugin: Option<CallTypesPlugin>,
}

const REQUIRED_LLVM_TOOLS: &[&str] = &[
    "clang",
    "clang++",
    "llvm-ar",
    "llvm-ranlib",
    "llvm-nm",
    "wasm-ld",
];

fn has_required_llvm_tools(bin_dir: &str) -> bool {
    REQUIRED_LLVM_TOOLS
        .iter()
        .all(|tool| Path::new(&join(bin_dir, tool)).exists())
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn exists(path: &str) -> bool {
    Path::new(path).exists()
}

#[cfg(not(target_os = "kandelo"))]
mod discovery {
    use super::*;
    use crate::exec::run;
    use crate::node_path::{cwd, resolve};

    /// The SDK directory (`sdk/` in the repository): the driver is installed
    /// at `<sdk>/.build/bin/kandelo-cc`. `WASM_POSIX_SDK_ROOT` overrides it.
    pub fn sdk_root() -> Result<String> {
        if let Some(root) = env_nonempty("WASM_POSIX_SDK_ROOT") {
            return Ok(root);
        }
        let exe = std::env::current_exe()
            .and_then(|exe| exe.canonicalize())
            .map_err(|error| format!("cannot locate the SDK driver executable: {error}"))?;
        let root = exe
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .ok_or("the SDK driver executable is not inside an SDK directory")?;
        Ok(root.to_string_lossy().into_owned())
    }

    // Walk up from cwd because npm-link makes the SDK's repository whichever
    // worktree was linked, not the user's cwd.
    fn find_project_root() -> Option<String> {
        let mut dir = resolve(&cwd(), "");
        loop {
            if exists(&crate::node_path::join(&[
                &dir,
                "libc",
                "glue",
                "abi_constants.h",
            ])) {
                return Some(dir);
            }
            let parent = crate::node_path::join(&[&dir, ".."]);
            if parent == dir {
                return None;
            }
            dir = parent;
        }
    }

    fn project_root_or_sdk() -> Result<String> {
        if let Some(root) = find_project_root() {
            return Ok(root);
        }
        let sdk = sdk_root()?;
        if exists(&crate::node_path::join(&[&sdk, "glue", "abi_constants.h"])) {
            return Ok(sdk);
        }
        Ok(resolve(&sdk, ".."))
    }

    pub fn find_llvm_dir() -> Result<String> {
        // 1. Project-specific override — highest priority.
        if let Some(dir) = env_nonempty("WASM_POSIX_LLVM_DIR") {
            if has_required_llvm_tools(&dir) {
                return Ok(dir);
            }
            return Err(format!(
                "WASM_POSIX_LLVM_DIR=\"{dir}\" does not contain the required LLVM tools: {}",
                REQUIRED_LLVM_TOOLS.join(", ")
            ));
        }

        // 2. The Nix flake's shellHook exports LLVM_BIN (=${llvmTree}/bin) so
        //    build scripts can call $LLVM_BIN/clang directly; honour it so the
        //    driver resolves the same toolchain. LLVM_PREFIX is its parent.
        if let Some(bin) = env_nonempty("LLVM_BIN") {
            if has_required_llvm_tools(&bin) {
                return Ok(bin);
            }
        }
        if let Some(prefix) = env_nonempty("LLVM_PREFIX") {
            let bin = join(&prefix, "bin");
            if has_required_llvm_tools(&bin) {
                return Ok(bin);
            }
        }

        // 3. A complete LLVM bin directory on PATH. Some Nix clang packages put
        //    a clang-only directory before the combined llvmTree.
        let path = std::env::var("PATH").unwrap_or_default();
        let mut seen = std::collections::HashSet::new();
        for dir in path.split(':').filter(|d| !d.is_empty()) {
            if !seen.insert(dir) {
                continue;
            }
            if has_required_llvm_tools(dir) {
                let test = run(
                    &join(dir, "clang"),
                    &[
                        "--target=wasm32-unknown-unknown",
                        "-x",
                        "c",
                        "-c",
                        "-o",
                        "/dev/null",
                        "/dev/null",
                    ]
                    .map(String::from),
                    None,
                );
                if test.exit_code == 0 {
                    return Ok(dir.to_string());
                }
            }
        }

        // Linux: scan /usr/lib/llvm-* for the highest version.
        if let Ok(entries) = std::fs::read_dir("/usr/lib") {
            let mut names: Vec<String> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|name| name.starts_with("llvm-"))
                .collect();
            names.sort();
            for name in names.iter().rev() {
                let bin = crate::node_path::join(&["/usr/lib", name, "bin"]);
                if has_required_llvm_tools(&bin) {
                    return Ok(bin);
                }
            }
        }

        Err("Could not find a wasm32-capable LLVM/clang installation.\n\
             Install LLVM via:\n  macOS:  brew install llvm\n  Ubuntu: apt install llvm clang lld\n\
             Or set WASM_POSIX_LLVM_DIR to your LLVM bin directory."
            .into())
    }

    pub fn find_sysroot(arch: WasmArch) -> Result<String> {
        if let Some(sysroot) = env_nonempty("WASM_POSIX_SYSROOT") {
            return Ok(sysroot);
        }
        Ok(resolve(&project_root_or_sdk()?, sysroot_dir(arch)))
    }

    /// The SDK's autoconf cross-compilation cache, if present.
    pub fn sdk_config_site() -> Result<Option<String>> {
        let site = resolve(&sdk_root()?, "config.site");
        Ok(exists(&site).then_some(site))
    }

    pub fn find_glue_dir() -> Result<String> {
        if let Some(glue) = env_nonempty("WASM_POSIX_GLUE_DIR") {
            return Ok(glue);
        }
        Ok(crate::node_path::join(&[
            &project_root_or_sdk()?,
            "libc",
            "glue",
        ]))
    }
}

#[cfg(target_os = "kandelo")]
mod discovery {
    use super::*;

    /// Kandelo's SDK layout: `kandelo-sdk.zip` mounted at `/usr`.
    const LLVM_DIR: &str = "/usr/lib/llvm/bin";
    const SDK_DIR: &str = "/usr/wasm32posix";

    pub fn find_llvm_dir() -> Result<String> {
        let dir = env_nonempty("WASM_POSIX_LLVM_DIR").unwrap_or_else(|| LLVM_DIR.into());
        if has_required_llvm_tools(&dir) {
            return Ok(dir);
        }
        Err(format!(
            "{dir} does not contain the required LLVM tools: {}",
            REQUIRED_LLVM_TOOLS.join(", ")
        ))
    }

    pub fn find_sysroot(arch: WasmArch) -> Result<String> {
        Ok(env_nonempty("WASM_POSIX_SYSROOT").unwrap_or_else(|| join(SDK_DIR, sysroot_dir(arch))))
    }

    /// The SDK's autoconf cross-compilation cache, if present.
    pub fn sdk_config_site() -> Result<Option<String>> {
        let site = join(SDK_DIR, "config.site");
        Ok(exists(&site).then_some(site))
    }

    pub fn find_glue_dir() -> Result<String> {
        Ok(env_nonempty("WASM_POSIX_GLUE_DIR").unwrap_or_else(|| join(SDK_DIR, "glue")))
    }
}

pub use discovery::*;

pub fn validate_sysroot(sysroot: &str) -> Result<()> {
    if !exists(&join(&join(sysroot, "lib"), "libc.a")) {
        return Err(format!(
            "Sysroot not found at {sysroot}\nRun scripts/build-musl.sh first."
        ));
    }
    Ok(())
}

/// The major version wasm-ld reports (`LLD <n>`).
pub fn resolve_lld_major(llvm_dir: &str) -> Result<u32> {
    let result = crate::exec::run(&join(llvm_dir, "wasm-ld"), &["--version".to_string()], None);
    let text = format!("{}\n{}", result.stdout, result.stderr);
    let major = lld_major_from_version(&text);
    match major {
        Some(major) if result.exit_code == 0 => Ok(major),
        _ => Err(format!("Could not determine wasm-ld version in {llvm_dir}")),
    }
}

/// The first `\bLLD\s+(\d+)` (case-insensitive) in `text`.
fn lld_major_from_version(text: &str) -> Option<u32> {
    let bytes = text.as_bytes();
    for at in 0..bytes.len().saturating_sub(2) {
        if !bytes[at..at + 3].eq_ignore_ascii_case(b"lld") {
            continue;
        }
        if at > 0 && (bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_') {
            continue;
        }
        let mut i = at + 3;
        let spaces = i;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i == spaces {
            continue;
        }
        let digits = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i > digits {
            return text[digits..i].parse().ok();
        }
    }
    None
}

pub fn resolve_toolchain(arch: WasmArch) -> Result<Toolchain> {
    let llvm_dir = find_llvm_dir()?;
    let sysroot = find_sysroot(arch)?;
    let glue_dir = find_glue_dir()?;
    validate_sysroot(&sysroot)?;
    Ok(Toolchain {
        cc: join(&llvm_dir, "clang"),
        cxx: join(&llvm_dir, "clang++"),
        llvm_dir,
        lld_major: None,
        sysroot,
        glue_dir,
        calltypes_plugin: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lld_version() {
        assert_eq!(
            lld_major_from_version("LLD 21.1.7 (compatible with GNU linkers)"),
            Some(21)
        );
        assert_eq!(lld_major_from_version("Homebrew LLD 22.0.0"), Some(22));
        assert_eq!(lld_major_from_version("wasm-ld version"), None);
    }
}

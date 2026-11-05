//! The KandeloCallTypes compiler plugin (sdk/src/plugin/): which one a
//! compile loads, and on the build machine, building and caching it.
//!
//! Every C/C++ compile through the SDK loads the plugin. It records per-
//! function facts about calls (CFI type ids of indirect calls, where function
//! addresses flow, function-pointer casts) into a `kandelo.calltypes` custom
//! section of each object, without changing the object's code. Fork
//! instrumentation reads them from the linked module. See docs/sdk-guide.md
//! "Compiler facts for fork instrumentation".
//!
//! On the build machine the plugin is a shared library compiled against the
//! headers of the exact LLVM/Clang that loads it. It is built on first use
//! and cached under sdk/.build/calltypes-plugin/<key>/, where the key covers
//! its sources, its build script, the LLVM inputs the dev shell exports and
//! the compiler that will load it, so a source or toolchain change can never
//! reuse a stale one. Kandelo's own clang has the plugin compiled in.

use crate::Result;
use crate::flags::CallTypesPlugin;

/// Use this prebuilt plugin instead of building one (must match the compiler).
pub const CALLTYPES_PLUGIN_ENV: &str = "WASM_POSIX_CALLTYPES_PLUGIN";

fn override_plugin() -> Result<Option<CallTypesPlugin>> {
    match std::env::var(CALLTYPES_PLUGIN_ENV) {
        Ok(path) if !path.is_empty() => {
            if !std::path::Path::new(&path).exists() {
                return Err(format!("{CALLTYPES_PLUGIN_ENV}={path} does not exist"));
            }
            Ok(Some(CallTypesPlugin::Library(path)))
        }
        _ => Ok(None),
    }
}

#[cfg(target_os = "kandelo")]
pub fn ensure_calltypes_plugin(_compiler: &str) -> Result<CallTypesPlugin> {
    Ok(override_plugin()?.unwrap_or(CallTypesPlugin::BuiltIn))
}

#[cfg(not(target_os = "kandelo"))]
pub use host::*;

#[cfg(not(target_os = "kandelo"))]
mod host {
    use super::*;
    use crate::flags::join;
    use crate::toolchain::sdk_root;
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::path::Path;
    use std::time::{Duration, SystemTime};

    const PLUGIN_SOURCES: &[&str] = &["KandeloCallTypes.cpp", "KandeloFnCasts.cpp", "build.sh"];
    const LLVM_INPUT_ENV: &[&str] = &[
        "KANDELO_LLVM_DEV",
        "KANDELO_LLVM_LIB",
        "KANDELO_CLANG_DEV",
        "KANDELO_CLANG_LIB",
    ];
    const BUILD_LOCK_STALE: Duration = Duration::from_secs(10 * 60);

    fn plugin_file_name() -> &'static str {
        if cfg!(target_os = "macos") {
            "KandeloCallTypes.dylib"
        } else {
            "KandeloCallTypes.so"
        }
    }

    /// Node's `${process.platform}-${process.arch}`, the platform part of the
    /// cache key (kept so caches written before this driver stay valid).
    fn platform() -> String {
        let os = match std::env::consts::OS {
            "macos" => "darwin",
            other => other,
        };
        let arch = match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86_64" => "x64",
            "x86" => "ia32",
            other => other,
        };
        format!("{os}-{arch}")
    }

    fn plugin_source_dir() -> Result<String> {
        Ok(join(&join(&sdk_root()?, "src"), "plugin"))
    }

    /// The cache key: everything the plugin's bytes and loadability depend on.
    pub fn calltypes_plugin_key(compiler: &str) -> Result<String> {
        let source_dir = plugin_source_dir()?;
        let mut h = Sha256::new();
        h.update(b"kandelo-calltypes-plugin-v1\0");
        h.update(format!("{}\0", platform()));
        for name in PLUGIN_SOURCES {
            let path = join(&source_dir, name);
            let bytes = fs::read(&path).map_err(|error| format!("cannot read {path}: {error}"))?;
            h.update(format!("{name}\0"));
            h.update(&bytes);
            h.update(b"\0");
        }
        for name in LLVM_INPUT_ENV {
            h.update(format!(
                "{name}={}\0",
                std::env::var(name).unwrap_or_default()
            ));
        }
        let identity = fs::canonicalize(compiler)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| compiler.to_string());
        h.update(format!("compiler={identity}\0"));
        let digest = h.finalize();
        Ok(digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()[..24]
            .to_string())
    }

    /// The plugin for this toolchain, building it first if needed.
    /// Concurrent first compiles (make -j) build it once: one holds a lock
    /// file, the rest wait for the published directory.
    pub fn ensure_calltypes_plugin(compiler: &str) -> Result<CallTypesPlugin> {
        if let Some(plugin) = override_plugin()? {
            return Ok(plugin);
        }
        let cache_root = join(&join(&sdk_root()?, ".build"), "calltypes-plugin");
        let dir = join(&cache_root, &calltypes_plugin_key(compiler)?);
        let plugin = join(&dir, plugin_file_name());
        if Path::new(&plugin).exists() {
            return Ok(CallTypesPlugin::Library(plugin));
        }

        let missing: Vec<&str> = LLVM_INPUT_ENV
            .iter()
            .copied()
            .filter(|name| std::env::var(name).map_or(true, |v| v.is_empty()))
            .collect();
        if !missing.is_empty() {
            return Err(format!(
                "the KandeloCallTypes compiler plugin is not built for this toolchain, and {} \
                 are unset, so it cannot be built here. Run the build inside scripts/dev-shell.sh \
                 (which exports them), or set {CALLTYPES_PLUGIN_ENV} to a plugin built for this compiler.",
                missing.join(", ")
            ));
        }

        fs::create_dir_all(&cache_root).map_err(|e| format!("cannot create {cache_root}: {e}"))?;
        let lock = format!("{dir}.lock");
        loop {
            if Path::new(&plugin).exists() {
                return Ok(CallTypesPlugin::Library(plugin));
            }
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&lock)
            {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    // Another compile is building it. A lock older than any real
                    // build belongs to a builder that died: take it over.
                    if let Ok(modified) = fs::metadata(&lock).and_then(|m| m.modified()) {
                        if SystemTime::now()
                            .duration_since(modified)
                            .unwrap_or_default()
                            > BUILD_LOCK_STALE
                        {
                            let _ = fs::remove_file(&lock);
                        }
                    }
                    std::thread::sleep(Duration::from_millis(250));
                    continue;
                }
                Err(error) => return Err(format!("cannot create {lock}: {error}")),
            }
            let built = build_plugin(&dir, &plugin);
            let _ = fs::remove_file(&lock);
            return built.map(|()| CallTypesPlugin::Library(plugin));
        }
    }

    fn build_plugin(dir: &str, plugin: &str) -> Result<()> {
        if Path::new(plugin).exists() {
            return Ok(());
        }
        let staging = format!("{dir}.tmp-{}", std::process::id());
        let _ = fs::remove_dir_all(&staging);
        fs::create_dir_all(&staging).map_err(|e| format!("cannot create {staging}: {e}"))?;
        let script = join(&plugin_source_dir()?, "build.sh");
        let result = crate::exec::run("bash", &[script, join(&staging, plugin_file_name())], None);
        if result.exit_code != 0 {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!(
                "building the KandeloCallTypes compiler plugin failed:\n{}",
                result.stderr.trim()
            ));
        }
        let _ = fs::remove_dir_all(dir);
        fs::rename(&staging, dir).map_err(|e| format!("cannot publish {dir}: {e}"))?;
        Ok(())
    }
}

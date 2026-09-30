//! Provision the repository's locked root JavaScript dependencies before the
//! local-build engine runs.
//!
//! Several resolver-owned package builds (rootfs, shell, coreutils-docs,
//! mariadb-test, node-browser-bundle) execute tools from the checkout's root
//! `node_modules/` — e.g. `node_modules/tsx/dist/cli.mjs` — and deliberately
//! refuse to install them: a package build is sealed (read-only with respect
//! to the source checkout, no undeclared network fetch). The caller owns
//! provisioning. CI does that with an explicit `npm ci`; this module is the
//! same step for the local front doors (`./run.sh setup`, `./run.sh
//! local-build`, `xtask bootstrap`), which all funnel through the engine's
//! aggregate run.
//!
//! Freshness is judged against npm's own record of what it installed
//! (`node_modules/.package-lock.json`, the "hidden lockfile"): every
//! non-optional package in `package-lock.json` must be present there at the
//! locked version. A tree that already satisfies the lock (a CI `npm ci`, a
//! previous run) is left untouched, so this is a no-op on the common path.

use std::path::Path;
use std::process::Command;

use serde_json::Value;

const LOCKFILE: &str = "package-lock.json";
const HIDDEN_LOCKFILE: &str = "node_modules/.package-lock.json";

/// Install the root lockfile's dependencies with `npm ci` when the installed
/// tree is missing or does not match `package-lock.json`.
pub(crate) fn ensure_root_js_dependencies(repo: &Path) -> Result<(), String> {
    let lock_path = repo.join(LOCKFILE);
    let lock_bytes = std::fs::read(&lock_path)
        .map_err(|error| format!("read {}: {error}", lock_path.display()))?;
    let hidden_bytes = match std::fs::read(repo.join(HIDDEN_LOCKFILE)) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("read {HIDDEN_LOCKFILE}: {error}")),
    };
    let reason = match hidden_bytes {
        None => Some("root node_modules is not installed".to_string()),
        Some(hidden) => installed_tree_mismatch(&lock_bytes, &hidden)?,
    };
    let Some(reason) = reason else {
        return Ok(());
    };

    eprintln!("==> Installing locked root npm dependencies ({reason})");
    let status = Command::new("npm")
        .args(["ci", "--no-audit", "--no-fund"])
        .current_dir(repo)
        // stdout is the engine's machine-readable result channel (see
        // scripts/run-local-build.sh); npm's progress output belongs on
        // stderr with the rest of the build log.
        .stdout(std::io::stderr())
        .status()
        .map_err(|error| format!("spawn npm ci in {}: {error}", repo.display()))?;
    if !status.success() {
        return Err(format!(
            "npm ci in {} failed ({status}); package builds need the locked root \
             dependencies in node_modules/",
            repo.display()
        ));
    }

    // Verify rather than trust: a tree that still disagrees with the lock
    // would only fail later, inside a sealed package build, with a less
    // actionable message.
    let hidden = std::fs::read(repo.join(HIDDEN_LOCKFILE))
        .map_err(|error| format!("read {HIDDEN_LOCKFILE} after npm ci: {error}"))?;
    match installed_tree_mismatch(&lock_bytes, &hidden)? {
        None => Ok(()),
        Some(reason) => Err(format!(
            "root node_modules still does not match {LOCKFILE} after npm ci: {reason}"
        )),
    }
}

/// `None` when the installed tree satisfies the lockfile, otherwise a short
/// description of the first discrepancy found.
fn installed_tree_mismatch(lock: &[u8], hidden: &[u8]) -> Result<Option<String>, String> {
    let lock: Value =
        serde_json::from_slice(lock).map_err(|error| format!("parse {LOCKFILE}: {error}"))?;
    let hidden: Value = serde_json::from_slice(hidden)
        .map_err(|error| format!("parse {HIDDEN_LOCKFILE}: {error}"))?;
    let locked = lock
        .get("packages")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            format!("{LOCKFILE} has no \"packages\" map (lockfileVersion >= 2 required)")
        })?;
    let installed = hidden
        .get("packages")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{HIDDEN_LOCKFILE} has no \"packages\" map"))?;

    for (path, entry) in locked {
        // "" is the root project itself; the hidden lockfile never lists it.
        if !path.starts_with("node_modules/") {
            continue;
        }
        // Optional packages (platform-specific binaries such as
        // @esbuild/<os>-<arch>) are legitimately absent on other hosts.
        let flag = |name: &str| entry.get(name).and_then(Value::as_bool) == Some(true);
        if flag("optional") || flag("devOptional") {
            continue;
        }
        let Some(have) = installed.get(path) else {
            return Ok(Some(format!("{path} is not installed")));
        };
        let want_version = entry.get("version").and_then(Value::as_str);
        let have_version = have.get("version").and_then(Value::as_str);
        if want_version != have_version {
            return Ok(Some(format!(
                "{path} is {} but {LOCKFILE} locks {}",
                have_version.unwrap_or("unversioned"),
                want_version.unwrap_or("unversioned"),
            )));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::installed_tree_mismatch;

    const LOCK: &str = r#"{
        "lockfileVersion": 3,
        "packages": {
            "": { "name": "kandelo" },
            "node_modules/tsx": { "version": "4.23.12", "dev": true },
            "node_modules/fflate": { "version": "0.8.3" },
            "node_modules/@esbuild/linux-x64": { "version": "0.28.2", "optional": true }
        }
    }"#;

    #[test]
    fn matching_tree_is_current_even_without_other_platform_optionals() {
        let hidden = r#"{ "packages": {
            "node_modules/tsx": { "version": "4.23.12" },
            "node_modules/fflate": { "version": "0.8.3" }
        } }"#;
        assert_eq!(
            installed_tree_mismatch(LOCK.as_bytes(), hidden.as_bytes()).unwrap(),
            None
        );
    }

    #[test]
    fn missing_package_requires_install() {
        let hidden = r#"{ "packages": { "node_modules/fflate": { "version": "0.8.3" } } }"#;
        let reason = installed_tree_mismatch(LOCK.as_bytes(), hidden.as_bytes()).unwrap();
        assert_eq!(reason.as_deref(), Some("node_modules/tsx is not installed"));
    }

    #[test]
    fn version_drift_requires_install() {
        let hidden = r#"{ "packages": {
            "node_modules/tsx": { "version": "4.19.0" },
            "node_modules/fflate": { "version": "0.8.3" }
        } }"#;
        let reason = installed_tree_mismatch(LOCK.as_bytes(), hidden.as_bytes()).unwrap();
        assert!(reason.unwrap().contains("node_modules/tsx is 4.19.0"));
    }
}

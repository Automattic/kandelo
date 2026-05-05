//! Host-tool presence + version probe runner (Task C.9).
//!
//! Invoked by the resolver before a consumer's build script runs.
//! Each `[[host_tools]]` entry parsed in C.7 (`HostTool`) names a
//! tool, an optional probe (defaulting to `--version` + a generic
//! `(\d+\.\d+(?:\.\d+)?)` regex), and a `version_constraint` parsed
//! by C.8 into a `VersionConstraint`. This module spawns the tool,
//! captures combined stdout+stderr, runs the regex, parses capture
//! group 1 into a `Version`, and compares against the constraint.
//!
//! Failure aborts the resolve: the caller (C.10 `ensure_built`
//! integration) is responsible for rendering platform-keyed
//! `install_hints` from the same `HostTool` — this module returns
//! a structured `ProbeFailure` so the renderer can switch on the
//! failure mode (missing-tool vs. too-old vs. unparseable output).

use std::process::Command;

use regex::Regex;

use crate::pkg_manifest::{HostTool, Version, VersionConstraint};

/// Probe failure modes. The variants mirror the four ways a probe can
/// go wrong: tool absent, tool ran but output didn't match the regex,
/// regex matched but the captured substring isn't a parseable version,
/// or the tool is just too old. Display formatting truncates noisy
/// `output` payloads at 4 KiB so we don't dump megabytes of stderr.
#[derive(Debug)]
pub enum ProbeFailure {
    /// Tool not found in PATH (Command::output failed).
    Missing { tool: String, reason: String },
    /// Tool ran but combined stdout+stderr did not match the version regex.
    BadOutput {
        tool: String,
        regex: String,
        output: String,
    },
    /// Regex matched but the captured version did not parse.
    BadVersion {
        tool: String,
        captured: String,
        reason: String,
    },
    /// Version parsed but is older than the constraint.
    TooOld {
        tool: String,
        actual: Version,
        required: VersionConstraint,
    },
}

impl std::fmt::Display for ProbeFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing { tool, reason } => {
                write!(f, "host-tool {:?} not found in PATH ({})", tool, reason)
            }
            Self::BadOutput {
                tool,
                regex,
                output,
            } => {
                let truncated = if output.len() > 4096 {
                    &output[..4096]
                } else {
                    output.as_str()
                };
                write!(
                    f,
                    "host-tool {:?}: probe output did not match regex {:?}\n--- stdout/stderr ---\n{}",
                    tool, regex, truncated
                )
            }
            Self::BadVersion {
                tool,
                captured,
                reason,
            } => {
                write!(
                    f,
                    "host-tool {:?}: extracted version {:?} did not parse: {}",
                    tool, captured, reason
                )
            }
            Self::TooOld {
                tool,
                actual,
                required,
            } => {
                write!(
                    f,
                    "host-tool {:?}: version {} too old; require >={}",
                    tool, actual, required.min
                )
            }
        }
    }
}

/// Probe a single host tool. On success the tool exists in PATH and
/// satisfies the constraint. On failure returns a structured
/// `ProbeFailure` for the caller to render with `install_hints`.
///
/// Tools are looked up by their declared `name` against the current
/// PATH; the runner does NOT consult `install_hints`, ask the user,
/// or auto-install. Combined stdout+stderr is matched against the
/// regex (some tools — autoconf, awk — print `--version` to stderr).
pub fn probe(tool: &HostTool) -> Result<(), ProbeFailure> {
    let output = Command::new(&tool.name)
        .args(&tool.probe.args)
        .output()
        .map_err(|e| ProbeFailure::Missing {
            tool: tool.name.clone(),
            reason: format!("{e}"),
        })?;

    // Combine stdout + stderr — many tools (autoconf, awk, mawk)
    // emit `--version` on stderr. A separator newline keeps the
    // regex from accidentally matching across the boundary.
    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(&output.stdout));
    combined.push('\n');
    combined.push_str(&String::from_utf8_lossy(&output.stderr));

    // SAFETY: `validate_common` in `pkg_manifest` compiles every
    // `[[host_tools]].probe.version_regex` at TOML parse time and
    // rejects malformed regexes there. By the time we reach the probe
    // runner the string is guaranteed to compile.
    let re = Regex::new(&tool.probe.version_regex).unwrap();
    let caps = re
        .captures(&combined)
        .ok_or_else(|| ProbeFailure::BadOutput {
            tool: tool.name.clone(),
            regex: tool.probe.version_regex.clone(),
            output: combined.clone(),
        })?;
    let captured = caps
        .get(1)
        .ok_or_else(|| ProbeFailure::BadOutput {
            tool: tool.name.clone(),
            regex: tool.probe.version_regex.clone(),
            output: combined.clone(),
        })?
        .as_str();

    let actual = Version::parse(captured).map_err(|e| ProbeFailure::BadVersion {
        tool: tool.name.clone(),
        captured: captured.to_string(),
        reason: e,
    })?;
    if !tool.version_constraint.satisfies(&actual) {
        return Err(ProbeFailure::TooOld {
            tool: tool.name.clone(),
            actual,
            required: tool.version_constraint.clone(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pkg_manifest::HostToolProbe;
    use std::os::unix::fs::PermissionsExt;

    // `std::env::set_var` is process-global. cargo runs unit tests in
    // parallel by default, so the four PATH-mutating tests below would
    // race each other and intermittently break. Serialize them with a
    // module-private mutex; the missing-tool test does not touch PATH
    // and is excluded.
    static PATH_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// RAII helper: prepend `dir` onto PATH, restore the prior value on
    /// drop. The previous tests saved/restored PATH manually around each
    /// `probe(...)` call — if any assertion or helper between save and
    /// restore panicked, PATH stayed polluted (the next test in the same
    /// process saw the synthetic-tool dir still on PATH). Using Drop
    /// guarantees restoration even on panic.
    ///
    /// Each test still takes `PATH_MUTEX` so PATH-mutating tests
    /// serialize: the guard makes restoration robust, but it does NOT
    /// remove the need to serialize parallel mutators.
    struct PathGuard {
        old: String,
    }
    impl PathGuard {
        fn install(prepend: &std::path::Path) -> Self {
            let old = std::env::var("PATH").unwrap_or_default();
            // SAFETY (edition 2024): `set_var` is unsafe because it
            // mutates process-global env. The surrounding test holds
            // PATH_MUTEX so we are the only mutator right now;
            // restoration on drop happens whether the test panics or
            // returns normally.
            unsafe {
                std::env::set_var("PATH", format!("{}:{}", prepend.display(), old));
            }
            Self { old }
        }
    }
    impl Drop for PathGuard {
        fn drop(&mut self) {
            // SAFETY: see `PathGuard::install`.
            unsafe {
                std::env::set_var("PATH", &self.old);
            }
        }
    }

    fn write_synthetic_tool(
        dir: &std::path::Path,
        name: &str,
        body: &str,
    ) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn decl(name: &str, version_regex: &str, constraint: &str) -> HostTool {
        HostTool {
            name: name.to_string(),
            version_constraint: VersionConstraint::parse(constraint, name).unwrap(),
            probe: HostToolProbe {
                args: vec!["--version".to_string()],
                version_regex: version_regex.to_string(),
            },
            install_hints: Default::default(),
        }
    }

    #[test]
    fn probe_passes_when_version_meets_constraint() {
        let _g = PATH_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        write_synthetic_tool(
            dir.path(),
            "fakecmake",
            "#!/bin/bash\necho 'cmake version 3.21.4'\n",
        );
        let _path = PathGuard::install(dir.path());
        let result = probe(&decl(
            "fakecmake",
            r"cmake version (\d+\.\d+(?:\.\d+)?)",
            ">=3.20",
        ));
        assert!(result.is_ok(), "got: {:?}", result.err());
    }

    #[test]
    fn probe_rejects_old_version() {
        let _g = PATH_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        write_synthetic_tool(
            dir.path(),
            "fakecmake2",
            "#!/bin/bash\necho 'cmake version 3.10.0'\n",
        );
        let _path = PathGuard::install(dir.path());
        let err = probe(&decl(
            "fakecmake2",
            r"cmake version (\d+\.\d+(?:\.\d+)?)",
            ">=3.20",
        ))
        .unwrap_err();
        assert!(matches!(err, ProbeFailure::TooOld { .. }), "got: {err}");
    }

    #[test]
    fn probe_reports_missing_when_not_in_path() {
        // No PATH mutation — a name this exotic just isn't going to
        // exist. We deliberately don't take the mutex so this test can
        // run in parallel with non-PATH-mutating work.
        let err = probe(&decl(
            "this-tool-definitely-does-not-exist-anywhere",
            r"(\d+\.\d+)",
            ">=1.0",
        ))
        .unwrap_err();
        assert!(matches!(err, ProbeFailure::Missing { .. }), "got: {err}");
    }

    #[test]
    fn probe_reports_bad_output_when_regex_does_not_match() {
        let _g = PATH_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        write_synthetic_tool(
            dir.path(),
            "fakebadout",
            "#!/bin/bash\necho 'no version here'\n",
        );
        let _path = PathGuard::install(dir.path());
        let err = probe(&decl(
            "fakebadout",
            r"cmake version (\d+\.\d+(?:\.\d+)?)",
            ">=3.20",
        ))
        .unwrap_err();
        assert!(matches!(err, ProbeFailure::BadOutput { .. }), "got: {err}");
    }

    #[test]
    fn probe_compares_numerically_3_20_satisfies_3_9() {
        let _g = PATH_MUTEX.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        write_synthetic_tool(
            dir.path(),
            "fakelexbeats",
            "#!/bin/bash\necho 'cmake version 3.20.0'\n",
        );
        let _path = PathGuard::install(dir.path());
        let result = probe(&decl(
            "fakelexbeats",
            r"cmake version (\d+\.\d+(?:\.\d+)?)",
            ">=3.9",
        ));
        assert!(
            result.is_ok(),
            "3.20 must satisfy >=3.9 (numeric, not lexicographic)"
        );
    }
}

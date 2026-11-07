//! The installed guest Rust compiler entry point. Cargo probes and build
//! scripts use the same compiler and matching prebuilt std as user crates.

pub type Result<T> = std::result::Result<T, String>;

#[cfg(any(target_os = "kandelo", test))]
fn compiler_arguments(args: &[String]) -> Vec<String> {
    let mut compiler_args = vec!["-Zunstable-options".to_owned()];
    if !args.iter().any(|arg| arg == "--sysroot" || arg.starts_with("--sysroot=")) {
        compiler_args.extend(["--sysroot".to_owned(), "/usr".to_owned()]);
    }
    if args.iter().any(|arg| arg == "--test") {
        // WHY: the target aborts on panic. libtest's subprocess harness can
        // report failures and expected panics without an unwinder.
        compiler_args.push("-Zpanic-abort-tests".to_owned());
    }
    // Explicit caller options retain their usual last-option precedence.
    compiler_args.extend_from_slice(args);
    compiler_args
}

#[cfg(not(target_os = "kandelo"))]
pub fn compiler_main(_args: &[String]) -> Result<i32> {
    Err("the Rust compiler entry point is available inside Kandelo; on the build machine use wasm32posix-cargo".into())
}

#[cfg(target_os = "kandelo")]
pub fn compiler_main(args: &[String]) -> Result<i32> {
    use std::path::Path;
    use std::process::Command;

    const COMPILER: &str = "/usr/libexec/rustc";
    let compiler_args = compiler_arguments(args);
    // Queries and metadata-only compiles need no post-link work. Replace
    // this wrapper so they do not keep an extra process and fork snapshot.
    if !emits_link(args) {
        use std::os::unix::process::CommandExt;
        let error = Command::new(COMPILER).args(&compiler_args).exec();
        return Err(format!("starting {COMPILER}: {error}"));
    }
    let reports_artifacts = option_value(args, "--error-format") == Some("json")
        && option_value(args, "--json")
            .is_some_and(|options| options.split(',').any(|option| option == "artifacts"));
    let mut outputs = Vec::new();
    let status = if reports_artifacts {
        use std::io::{BufRead, Write};
        use std::process::Stdio;
        let mut child = Command::new(COMPILER)
            .args(&compiler_args)
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("starting {COMPILER}: {error}"))?;
        let mut stderr = std::io::BufReader::new(child.stderr.take().expect("piped stderr"));
        let mut line = Vec::new();
        while stderr
            .read_until(b'\n', &mut line)
            .map_err(|error| error.to_string())?
            != 0
        {
            // Preserve Cargo's diagnostic/artifact stream byte for byte.
            std::io::stderr()
                .write_all(&line)
                .map_err(|error| error.to_string())?;
            if let Some(output) = linked_artifact(&line) {
                if !outputs.contains(&output) {
                    outputs.push(output);
                }
            }
            line.clear();
        }
        child.wait().map_err(|error| error.to_string())?
    } else {
        Command::new(COMPILER)
            .args(&compiler_args)
            .status()
            .map_err(|error| format!("starting {COMPILER}: {error}"))?
    };
    if !status.success() {
        use std::os::unix::process::ExitStatusExt;
        return Ok(status
            .code()
            .unwrap_or_else(|| 128 + status.signal().unwrap_or(1)));
    }
    if reports_artifacts {
        if outputs.is_empty() {
            return Err("compiler emitted no link artifact notification".into());
        }
    } else {
        // Direct rustc callers may request human diagnostics. Ask for output
        // names only when there was no artifact stream to supply real paths.
        let names = Command::new(COMPILER)
            .args(&compiler_args)
            .arg("--print=file-names")
            .output()
            .map_err(|error| format!("reading Rust output names: {error}"))?;
        if !names.status.success() {
            return Err(format!(
                "reading Rust output names: {}",
                String::from_utf8_lossy(&names.stderr)
            ));
        }
        let directory = option_value(args, "--out-dir").unwrap_or(".");
        for name in String::from_utf8(names.stdout)
            .map_err(|error| error.to_string())?
            .lines()
        {
            let link_output = option_value(args, "--emit")
                .and_then(|emit| emit.split(',').find_map(|kind| kind.strip_prefix("link=")));
            outputs.push(
                link_output
                    .or_else(|| option_value(args, "-o"))
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(|| Path::new(directory).join(name)),
            );
        }
    }
    for output in outputs {
        let bytes = std::fs::read(&output)
            .map_err(|error| format!("reading {}: {error}", output.display()))?;
        if !bytes.starts_with(b"\0asm\x01\0\0\0") {
            continue;
        }
        if imports_fork(&bytes)? {
            let status = Command::new("wasm-fork-instrument")
                .arg(&output)
                .arg("-o")
                .arg(&output)
                .status()
                .map_err(|error| format!("starting wasm-fork-instrument: {error}"))?;
            if !status.success() {
                return Err(format!(
                    "preparing Rust executable {} failed ({status})",
                    output.display()
                ));
            }
        }
    }
    Ok(0)
}

#[cfg(any(target_os = "kandelo", test))]
fn option_value<'a>(args: &'a [String], option: &str) -> Option<&'a str> {
    args.iter().enumerate().rev().find_map(|(index, arg)| {
        if arg == option {
            args.get(index + 1).map(String::as_str)
        } else {
            arg.strip_prefix(option).and_then(|suffix| {
                suffix
                    .strip_prefix('=')
                    .or_else(|| (option == "-o" && !suffix.is_empty()).then_some(suffix))
            })
        }
    })
}

#[cfg(any(target_os = "kandelo", test))]
fn emits_link(args: &[String]) -> bool {
    if args.iter().any(|arg| {
        arg == "--print"
            || arg.starts_with("--print=")
            || matches!(arg.as_str(), "-vV" | "-V" | "--version" | "-h" | "--help")
    }) {
        return false;
    }
    option_value(args, "--emit").is_none_or(|emit| {
        emit.split(',')
            .any(|kind| kind.split('=').next() == Some("link"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).into()).collect()
    }
    #[test]
    fn test_harness_uses_abort_subprocesses_and_preserves_caller_options() {
        assert!(!compiler_arguments(&args(&["main.rs"]))
            .iter().any(|arg| arg == "-Zpanic-abort-tests"));
        let options = compiler_arguments(&args(&["--test", "--sysroot=/custom", "test.rs"]));
        assert!(options.iter().any(|arg| arg == "-Zpanic-abort-tests"));
        assert!(!options.iter().any(|arg| arg == "/usr"));
        assert_eq!(options.last().unwrap(), "test.rs");
    }
    #[test]
    fn cargo_probes_and_checks_do_not_prepare_outputs() {
        for values in [
            vec!["-vV"],
            vec!["--print", "cfg"],
            vec!["--print=file-names"],
            vec!["--emit=dep-info,metadata"],
            vec!["--emit", "metadata=out.rmeta"],
        ] {
            assert!(!emits_link(&args(&values)), "{values:?}");
        }
        assert!(emits_link(&args(&["--emit=dep-info,metadata,link"])));
        assert!(emits_link(&args(&["main.rs"])));
        assert!(emits_link(&args(&["--emit=link=custom-output"])));
        assert_eq!(
            option_value(&args(&["-ocustom-output"]), "-o"),
            Some("custom-output")
        );
        assert_eq!(
            option_value(&args(&["--out-dir", "a b"]), "--out-dir"),
            Some("a b")
        );
        assert_eq!(
            option_value(&args(&["--out-dir=a b"]), "--out-dir"),
            Some("a b")
        );
    }
}

#[cfg(target_os = "kandelo")]
fn imports_fork(bytes: &[u8]) -> Result<bool> {
    use wasmparser::{Parser, Payload, TypeRef};
    for payload in Parser::new(0).parse_all(bytes) {
        if let Payload::ImportSection(section) = payload.map_err(|error| error.to_string())? {
            for import in section {
                let import = import.map_err(|error| error.to_string())?;
                if import.module == "kernel"
                    && import.name == "kernel_fork"
                    && matches!(import.ty, TypeRef::Func(_))
                {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

#[cfg(any(target_os = "kandelo", test))]
fn linked_artifact(line: &[u8]) -> Option<std::path::PathBuf> {
    let value: serde_json::Value = serde_json::from_slice(line).ok()?;
    if value.get("$message_type")?.as_str()? != "artifact" || value.get("emit")?.as_str()? != "link"
    {
        return None;
    }
    value
        .get("artifact")?
        .as_str()
        .map(std::path::PathBuf::from)
}

#[cfg(test)]
mod artifact_tests {
    use super::*;
    #[test]
    fn compiler_artifact_paths_preserve_spaces_and_escapes() {
        assert_eq!(linked_artifact(br#"{"$message_type":"artifact","artifact":"/work/a b/quoted\".wasm","emit":"link"}"#),
            Some(std::path::PathBuf::from("/work/a b/quoted\".wasm")));
        assert_eq!(
            linked_artifact(
                br#"{"$message_type":"artifact","artifact":"/work/check.rmeta","emit":"metadata"}"#
            ),
            None
        );
        assert_eq!(
            linked_artifact(br#"{"$message_type":"diagnostic","message":"error"}"#),
            None
        );
        assert_eq!(linked_artifact(b"ordinary stderr\n"), None);
    }
}

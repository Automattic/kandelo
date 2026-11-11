//! The installed guest Rust compiler entry point. Cargo probes and build
//! scripts use the same compiler and matching prebuilt std as user crates.

pub type Result<T> = std::result::Result<T, String>;

#[cfg(any(target_os = "kandelo", test))]
mod abi_contract;

#[cfg(any(target_os = "kandelo", test))]
mod sdk_identity;

#[cfg(any(target_os = "kandelo", test))]
mod sdk_cargo;

pub fn tool_main(tool: &str, args: &[String]) -> Result<i32> {
    match tool {
        "cargo" => cargo_main(args),
        "rustdoc" => rustdoc_main(args),
        "clippy-driver" => clippy_main(args),
        _ => compiler_main(args),
    }
}

#[cfg(not(target_os = "kandelo"))]
fn cargo_main(_args: &[String]) -> Result<i32> {
    Err("the installed Cargo entry point is available inside Kandelo".into())
}

#[cfg(target_os = "kandelo")]
fn cargo_main(args: &[String]) -> Result<i32> {
    sdk_cargo::run(args)
}

#[cfg(any(target_os = "kandelo", test))]
fn compiler_arguments(args: &[String]) -> Vec<String> {
    let mut compiler_args = vec!["-Zunstable-options".to_owned()];
    if !args
        .iter()
        .any(|arg| arg == "--sysroot" || arg.starts_with("--sysroot="))
    {
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

#[cfg(any(target_os = "kandelo", test))]
fn rustdoc_arguments(args: &[String]) -> Vec<String> {
    let mut options = compiler_arguments(args);
    if args.iter().any(|arg| arg == "--test")
        && !args
            .iter()
            .any(|arg| arg == "--test-builder" || arg.starts_with("--test-builder="))
    {
        // The installed compiler prepares linked doctest executables through
        // the same fork-instrumentation path as ordinary Cargo artifacts.
        let caller_start = options.len() - args.len();
        options.splice(
            caller_start..caller_start,
            ["--test-builder".to_owned(), "/usr/bin/rustc".to_owned()],
        );
    }
    options
}

#[cfg(any(target_os = "kandelo", test))]
fn clippy_arguments(args: &[String]) -> &[String] {
    // Cargo supplies its rustc path before compiler flags when invoking a
    // workspace wrapper. Remove it before injecting our sysroot flags: the
    // upstream driver's wrapper detection requires it to be the first arg.
    match args
        .first()
        .and_then(|arg| std::path::Path::new(arg).file_stem())
        .and_then(|name| name.to_str())
    {
        Some("rustc" | "kandelo-rustc" | "wasm32posix-rustc") => &args[1..],
        _ => args,
    }
}

#[cfg(not(target_os = "kandelo"))]
fn rustdoc_main(_args: &[String]) -> Result<i32> {
    Err("the Rust documentation entry point is available inside Kandelo".into())
}

#[cfg(target_os = "kandelo")]
fn rustdoc_main(args: &[String]) -> Result<i32> {
    use std::os::unix::process::CommandExt;
    let error = std::process::Command::new("/usr/libexec/rustdoc")
        .args(rustdoc_arguments(args))
        .exec();
    Err(format!("starting rustdoc: {error}"))
}

#[cfg(not(target_os = "kandelo"))]
fn clippy_main(_args: &[String]) -> Result<i32> {
    Err("the Clippy compiler entry point is available inside Kandelo".into())
}

#[cfg(target_os = "kandelo")]
fn clippy_main(args: &[String]) -> Result<i32> {
    run_compiler("/usr/libexec/clippy-driver", clippy_arguments(args))
}

#[cfg(not(target_os = "kandelo"))]
pub fn compiler_main(_args: &[String]) -> Result<i32> {
    Err("the Rust compiler entry point is available inside Kandelo; on the build machine use wasm32posix-cargo".into())
}

#[cfg(target_os = "kandelo")]
pub fn compiler_main(args: &[String]) -> Result<i32> {
    run_compiler("/usr/libexec/rustc", args)
}

#[cfg(target_os = "kandelo")]
fn run_compiler(compiler: &str, args: &[String]) -> Result<i32> {
    use std::path::Path;
    use std::process::Command;

    let compiler_args = compiler_arguments(args);
    if sdk_cargo::verbose_version_query(args) {
        return sdk_cargo::compiler_version(compiler, &compiler_args);
    }
    // Queries and metadata-only compiles need no post-link work. Replace
    // this wrapper so they do not keep an extra process and fork snapshot.
    if !emits_link(args) {
        use std::os::unix::process::CommandExt;
        let error = Command::new(compiler).args(&compiler_args).exec();
        return Err(format!("starting {compiler}: {error}"));
    }
    let reports_artifacts = option_value(args, "--error-format") == Some("json")
        && option_value(args, "--json")
            .is_some_and(|options| options.split(',').any(|option| option == "artifacts"));
    let mut outputs = Vec::new();
    let status = if reports_artifacts {
        use std::io::{BufRead, Write};
        use std::process::Stdio;
        let mut child = Command::new(compiler)
            .args(&compiler_args)
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("starting {compiler}: {error}"))?;
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
        Command::new(compiler)
            .args(&compiler_args)
            .status()
            .map_err(|error| format!("starting {compiler}: {error}"))?
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
        let names = Command::new(compiler)
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
        // Every linked Wasm output needs the same preparation, including
        // non-fork executables that capture backtraces. Missing DWARF is
        // normal for release builds; invalid debug metadata is an error.
        let status = Command::new("wasm-fork-instrument")
            .arg(&output)
            .arg("-o")
            .arg(&output)
            .args(["--keep-names", "--debug-map-if-present"])
            .status()
            .map_err(|error| format!("starting wasm-fork-instrument: {error}"))?;
        if !status.success() {
            return Err(format!(
                "preparing Rust executable {} failed ({status})",
                output.display()
            ));
        }
        let prepared = std::fs::read(&output)
            .map_err(|error| format!("reading {}: {error}", output.display()))?;
        if let Some(stamped) =
            abi_contract::stamp(&prepared, env!("KANDELO_GUEST_PROGRAM_ABI_DIGEST"))?
        {
            std::fs::write(&output, stamped)
                .map_err(|error| format!("stamping {}: {error}", output.display()))?;
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
    fn doctests_use_the_preparing_compiler_and_keep_explicit_builders() {
        let options = rustdoc_arguments(&args(&["--test", "lib.rs"]));
        assert_eq!(
            option_value(&options, "--test-builder"),
            Some("/usr/bin/rustc")
        );
        assert!(options.iter().any(|arg| arg == "-Zpanic-abort-tests"));
        let options =
            rustdoc_arguments(&args(&["--test", "--test-builder=/custom/rustc", "lib.rs"]));
        assert_eq!(
            option_value(&options, "--test-builder"),
            Some("/custom/rustc")
        );
        assert!(!options.iter().any(|arg| arg == "/usr/bin/rustc"));
        assert!(
            !rustdoc_arguments(&args(&["lib.rs"]))
                .iter()
                .any(|arg| arg == "--test-builder")
        );
    }
    #[test]
    fn clippy_workspace_wrappers_strip_only_the_compiler_path() {
        let wrapped = args(&["/usr/bin/rustc", "--crate-name", "demo", "--emit=metadata"]);
        assert_eq!(clippy_arguments(&wrapped), &wrapped[1..]);
        let direct = args(&["--crate-name", "demo", "src/main.rs"]);
        assert_eq!(clippy_arguments(&direct), direct);
    }
    #[test]
    fn test_harness_uses_abort_subprocesses_and_preserves_caller_options() {
        assert!(
            !compiler_arguments(&args(&["main.rs"]))
                .iter()
                .any(|arg| arg == "-Zpanic-abort-tests")
        );
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

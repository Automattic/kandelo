//! Keep Cargo's compiler-info cache and crate cache bound to the real SDK.
//! A versioned executable path alone does not invalidate crate fingerprints:
//! Cargo also hashes the complete, genuine verbose compiler version output.

use crate::sdk_identity;
use std::os::unix::{
    fs::{PermissionsExt, symlink},
    process::{CommandExt, ExitStatusExt},
};
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Command,
};

pub(super) fn run(args: &[String]) -> crate::Result<i32> {
    let mut command = Command::new("/usr/libexec/cargo");
    command.args(args);
    if !cargo_query(args) {
        let explicit = std::env::var_os("RUSTC");
        let requested = explicit.clone().unwrap_or_else(|| "rustc".into());
        if let Some(compiler) = resolve_executable(&requested) {
            let own = std::env::current_exe()
                .and_then(std::fs::canonicalize)
                .map_err(|error| format!("locating SDK compiler: {error}"))?;
            // Custom compilers and other tool modes keep their original
            // executable selection. A symlink to this SDK's rustc is safe.
            let rustc_name = matches!(
                compiler.file_name().and_then(OsStr::to_str),
                Some("rustc" | "kandelo-rustc" | "wasm32posix-rustc")
            );
            if rustc_name && std::fs::canonicalize(&compiler).ok().as_ref() == Some(&own) {
                let identity = sdk_identity::read(Path::new(sdk_identity::INSTALLED_MANIFEST))?;
                let home = match std::env::var_os("CARGO_HOME").filter(|value| !value.is_empty()) {
                    Some(home) => PathBuf::from(home),
                    None => PathBuf::from(
                        std::env::var_os("HOME")
                            .ok_or("Cargo SDK entry point requires HOME or CARGO_HOME")?,
                    )
                    .join(".cargo"),
                };
                select_sdk_compiler(
                    &mut command,
                    &compiler_link(&home, &identity, &own)?,
                    explicit.is_some(),
                )?;
            }
        }
    }
    let error = command.exec();
    Err(format!("starting installed Cargo: {error}"))
}

fn select_sdk_compiler(command: &mut Command, link: &Path, explicit: bool) -> crate::Result<()> {
    if explicit {
        command.env("RUSTC", link);
    } else {
        // Cargo must still choose build.rustc from its config files, --config,
        // or CARGO_BUILD_RUSTC. Only its default PATH lookup needs the versioned
        // SDK alias; setting RUSTC here would override the user's selection.
        let mut paths = vec![
            link.parent()
                .ok_or("SDK compiler link has no directory")?
                .to_owned(),
        ];
        if let Some(path) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&path));
        }
        command.env(
            "PATH",
            std::env::join_paths(paths).map_err(|error| error.to_string())?,
        );
    }
    Ok(())
}

fn resolve_executable(requested: &OsStr) -> Option<PathBuf> {
    let path = Path::new(requested);
    let executable = |path: &Path| {
        std::fs::metadata(path)
            .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
    };
    if path.components().count() > 1 {
        return executable(path).then(|| path.to_owned());
    }
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|directory| directory.join(path))
        .find(|candidate| executable(candidate))
}

fn cargo_query(args: &[String]) -> bool {
    if args.first().is_some_and(|arg| {
        matches!(
            arg.as_str(),
            "help"
                | "version"
                | "new"
                | "init"
                | "clean"
                | "metadata"
                | "tree"
                | "fetch"
                | "generate-lockfile"
                | "locate-project"
                | "search"
                | "login"
                | "logout"
                | "owner"
                | "update"
                | "uninstall"
        )
    }) {
        return true;
    }
    args.iter()
        .take_while(|arg| arg.as_str() != "--")
        .any(|arg| {
            matches!(
                arg.as_str(),
                "-V" | "--version" | "-vV" | "-h" | "--help" | "--list"
            )
        })
}

fn compiler_link(home: &Path, identity: &str, compiler: &Path) -> crate::Result<PathBuf> {
    if identity.len() != 64
        || !identity
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("invalid SDK compiler-cache identity".into());
    }
    if !compiler.is_absolute() {
        return Err("SDK compiler-cache target must be absolute".into());
    }
    let directory = home.join("kandelo/compilers").join(identity);
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("creating SDK compiler cache: {error}"))?;
    // Canonicalize only the directory: canonicalizing the executable symlink
    // would erase the identity from the path Cargo fingerprints.
    let directory = std::fs::canonicalize(directory).map_err(|error| error.to_string())?;
    let link = directory.join("rustc");
    match symlink(compiler, &link) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if std::fs::read_link(&link).ok().as_deref() != Some(compiler) {
                return Err(format!(
                    "refusing to replace unexpected SDK compiler cache entry {}",
                    link.display()
                ));
            }
        }
        Err(error) => return Err(format!("creating SDK compiler cache link: {error}")),
    }
    Ok(link)
}

pub(super) fn verbose_version_query(args: &[String]) -> bool {
    match args {
        [arg] => matches!(arg.as_str(), "-vV" | "-Vv"),
        [left, right] => {
            let version = |arg: &str| matches!(arg, "-V" | "--version");
            let verbose = |arg: &str| matches!(arg, "-v" | "--verbose");
            (version(left) && verbose(right)) || (verbose(left) && version(right))
        }
        _ => false,
    }
}

pub(super) fn compiler_version(compiler: &str, args: &[String]) -> crate::Result<i32> {
    use std::io::Write;
    let identity = sdk_identity::read(Path::new(sdk_identity::INSTALLED_MANIFEST))?;
    let output = Command::new(compiler)
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    let stdout = if output.status.success() {
        version_output(output.stdout, &identity)
    } else {
        output.stdout
    };
    std::io::stdout()
        .write_all(&stdout)
        .map_err(|error| error.to_string())?;
    std::io::stderr()
        .write_all(&output.stderr)
        .map_err(|error| error.to_string())?;
    Ok(output
        .status
        .code()
        .unwrap_or_else(|| 128 + output.status.signal().unwrap_or(1)))
}

fn version_output(mut upstream: Vec<u8>, identity: &str) -> Vec<u8> {
    if !upstream.ends_with(b"\n") {
        upstream.push(b'\n');
    }
    upstream.extend_from_slice(format!("kandelo-sdk: {identity}\n").as_bytes());
    upstream
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "kandelo-sdk-cache-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn cargo_configuration_keeps_its_compiler_ahead_of_the_default_sdk_alias() {
        let directory = Directory::new();
        let project = directory.0.join("project");
        std::fs::create_dir_all(project.join(".cargo")).unwrap();
        std::fs::create_dir(project.join("src")).unwrap();
        std::fs::write(
            project.join("Cargo.toml"),
            "[package]\nname='compiler-selection'\nversion='0.1.0'\nedition='2021'\n",
        )
        .unwrap();
        std::fs::write(
            project.join("src/lib.rs"),
            "pub fn actual_compiler() -> u32 { 42 }\n",
        )
        .unwrap();
        let rustc = resolve_executable(OsStr::new("rustc")).unwrap();
        let rustc = std::fs::canonicalize(rustc).unwrap();
        let compiler = serde_json::to_string(&rustc.to_string_lossy()).unwrap();
        std::fs::write(
            project.join(".cargo/config.toml"),
            format!("[build]\nrustc = {compiler}\n"),
        )
        .unwrap();
        // The test harness is deliberately not a Rust compiler. If our default
        // alias overrides Cargo config, Cargo's -vV probe will fail visibly.
        let alias_dir = directory.0.join("sdk-alias");
        std::fs::create_dir(&alias_dir).unwrap();
        let alias = alias_dir.join("rustc");
        symlink(std::env::current_exe().unwrap(), &alias).unwrap();
        let version = Command::new(&rustc).arg("-vV").output().unwrap();
        let version = String::from_utf8(version.stdout).unwrap();
        let host = version
            .lines()
            .find_map(|line| line.strip_prefix("host: "))
            .unwrap();
        let mut cargo = Command::new("cargo");
        cargo
            .current_dir(&project)
            .args(["check", "--offline", "--target", host]);
        cargo
            .env_remove("RUSTC")
            .env_remove("CARGO_BUILD_RUSTC")
            .env_remove("RUSTC_WRAPPER")
            .env_remove("RUSTC_WORKSPACE_WRAPPER")
            .env("CARGO_TARGET_DIR", project.join("target"));
        select_sdk_compiler(&mut cargo, &alias, false).unwrap();
        let result = cargo.output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let mut explicit = Command::new("cargo");
        select_sdk_compiler(&mut explicit, &alias, true).unwrap();
        assert!(
            explicit
                .get_envs()
                .any(|(name, value)| name == "RUSTC" && value == Some(alias.as_os_str()))
        );
    }

    #[test]
    fn versioned_links_stay_stable_and_distinguish_sdk_revisions() {
        let directory = Directory::new();
        let compiler = directory.0.join("sdk-rustc");
        std::fs::write(&compiler, b"compiler").unwrap();
        let compiler = std::fs::canonicalize(compiler).unwrap();
        let home = directory.0.join("cargo home");
        let first = compiler_link(&home, &"12".repeat(32), &compiler).unwrap();
        let modified = std::fs::symlink_metadata(&first)
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(
            compiler_link(&home, &"12".repeat(32), &compiler).unwrap(),
            first
        );
        assert_eq!(
            std::fs::symlink_metadata(&first)
                .unwrap()
                .modified()
                .unwrap(),
            modified
        );
        let second = compiler_link(&home, &"34".repeat(32), &compiler).unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::canonicalize(&first).unwrap(), compiler);
        assert_eq!(std::fs::canonicalize(&second).unwrap(), compiler);
    }

    #[test]
    fn never_overwrites_foreign_cache_entries_or_uses_invalid_identities() {
        let directory = Directory::new();
        let compiler = directory.0.join("sdk-rustc");
        let id = "12".repeat(32);
        let link = directory
            .0
            .join("kandelo/compilers")
            .join(&id)
            .join("rustc");
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::fs::write(&link, b"keep me").unwrap();
        assert!(compiler_link(&directory.0, &id, &compiler).is_err());
        assert_eq!(std::fs::read(link).unwrap(), b"keep me");
        assert!(compiler_link(&directory.0, "../other", &compiler).is_err());
    }

    #[test]
    fn preserves_upstream_version_fields_and_keeps_program_arguments_out_of_query_detection() {
        let upstream = b"rustc 1.97.0-nightly\nhost: wasm32-unknown-kandelo-std\nrelease: 1.97.0-nightly\ncommit-hash: ca9a134e0985765ded9cfdde4030a5df4db7e2bd\n";
        let output = version_output(upstream.to_vec(), &"12".repeat(32));
        assert!(output.starts_with(upstream));
        assert!(output.ends_with(format!("kandelo-sdk: {}\n", "12".repeat(32)).as_bytes()));
        assert!(verbose_version_query(&["-vV".into()]));
        assert!(!verbose_version_query(&[
            "source.rs".into(),
            "-o".into(),
            "-vV".into()
        ]));
        assert!(cargo_query(&["--version".into()]));
        assert!(cargo_query(&["new".into(), "hello".into()]));
        assert!(!cargo_query(&["run".into(), "--".into(), "--help".into()]));
    }
}

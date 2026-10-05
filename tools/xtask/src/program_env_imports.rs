//! `xtask check-program-env-imports <path>...`
//!
//! Survey built programs and fail if any imports from `env` something the
//! host does not provide. Paths may be `.wasm` files or directories (searched
//! recursively for `.wasm`).
//!
//! WHY: executables link with `--allow-undefined-file` against the generated
//! allowance, so a fresh SDK link cannot leave any other `env` import. This
//! survey checks the artifacts themselves, which also catches programs linked
//! outside the SDK's link paths and stale artifacts from before ABI 47. The
//! allowed set is read from the declarations, not from a copy of them:
//! `HOST_ENV_IMPORTS`, plus the fork runtime's imports that instrumentation
//! adds after linking (`WPK_FORK_REQUIRED_IMPORTS`,
//! `WPK_FORK_REQUIRED_TABLE_IMPORTS`, `WPK_FORK_GLOBAL_IMPORTS`, the
//! unwind tag, and the boundary call a fork sink makes).
//!
//! Side modules (a `dylink.0` custom section) are skipped: they link with
//! `--allow-undefined` and resolve their undefined symbols against the main
//! program when `dlopen` loads them.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use wasm_posix_shared::abi;
use wasmparser::{Encoding, Parser, Payload};

/// Names a program may import from `env`.
fn allowed_env_imports() -> BTreeSet<&'static str> {
    let mut allowed: BTreeSet<&'static str> =
        abi::HOST_ENV_IMPORTS.iter().map(|import| import.name).collect();
    for import in abi::WPK_FORK_REQUIRED_IMPORTS {
        if import.module == "env" {
            allowed.insert(import.name);
        }
    }
    for import in abi::WPK_FORK_REQUIRED_TABLE_IMPORTS {
        if import.module == "env" {
            allowed.insert(import.name);
        }
    }
    for import in abi::WPK_FORK_GLOBAL_IMPORTS {
        if import.module == "env" {
            allowed.insert(import.name);
        }
    }
    if abi::WPK_FORK_UNWIND_TAG_IMPORT_MODULE == "env" {
        allowed.insert(abi::WPK_FORK_UNWIND_TAG_IMPORT_NAME);
    }
    // `env.__wpk_fork_boundary`: imported only by a module with boundary
    // functions, so it is not among the required imports.
    allowed.insert(abi::WPK_FORK_BOUNDARY_IMPORT);
    allowed
}

#[derive(Debug, PartialEq, Eq)]
enum Survey {
    /// A main program, with the `env` imports the host does not provide.
    Program { undeclared: Vec<String> },
    SideModule,
    /// Not a core module (a component); outside this check.
    NotCoreModule,
}

fn survey(bytes: &[u8], allowed: &BTreeSet<&str>) -> Result<Survey, String> {
    let mut env_imports = Vec::new();
    for payload in Parser::new(0).parse_all(bytes) {
        match payload.map_err(|e| format!("parsing wasm: {e}"))? {
            Payload::Version { encoding, .. } if encoding != Encoding::Module => {
                return Ok(Survey::NotCoreModule);
            }
            Payload::CustomSection(section) if section.name() == "dylink.0" => {
                return Ok(Survey::SideModule);
            }
            Payload::ImportSection(imports) => {
                for import in imports.into_imports() {
                    let import = import.map_err(|e| format!("parsing imports: {e}"))?;
                    if import.module == "env" {
                        env_imports.push(import.name.to_string());
                    }
                }
            }
            // Imports and dylink.0 both precede code; stop before decoding
            // function bodies, which also keeps this independent of which
            // instruction proposals the body uses.
            Payload::CodeSectionStart { .. } => break,
            _ => {}
        }
    }
    let undeclared = env_imports
        .into_iter()
        .filter(|name| !allowed.contains(name.as_str()))
        .collect();
    Ok(Survey::Program { undeclared })
}

fn collect_wasm(path: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if meta.is_dir() {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(path)
            .map_err(|e| format!("{}: {e}", path.display()))?
            .map(|entry| entry.map(|e| e.path()))
            .collect::<Result<_, _>>()
            .map_err(|e| format!("{}: {e}", path.display()))?;
        entries.sort();
        for entry in entries {
            collect_wasm(&entry, out)?;
        }
    } else if path.extension().is_some_and(|ext| ext == "wasm") {
        out.push(path.to_path_buf());
    }
    Ok(())
}

pub fn run(args: Vec<String>) -> Result<(), String> {
    if args.is_empty() {
        return Err("usage: xtask check-program-env-imports <file-or-dir>...".into());
    }
    let mut files = Vec::new();
    for arg in &args {
        collect_wasm(Path::new(arg), &mut files)?;
    }
    let allowed = allowed_env_imports();
    let (mut programs, mut side_modules) = (0usize, 0usize);
    let mut failures = Vec::new();
    for file in &files {
        let bytes = std::fs::read(file).map_err(|e| format!("{}: {e}", file.display()))?;
        match survey(&bytes, &allowed).map_err(|e| format!("{}: {e}", file.display()))? {
            Survey::Program { undeclared } => {
                programs += 1;
                if !undeclared.is_empty() {
                    failures.push((file, undeclared));
                }
            }
            Survey::SideModule => side_modules += 1,
            Survey::NotCoreModule => {}
        }
    }
    println!(
        "check-program-env-imports: {programs} program(s) checked, {side_modules} side module(s) skipped"
    );
    if failures.is_empty() {
        return Ok(());
    }
    for (file, names) in &failures {
        eprintln!("{}: imports from env what the host does not provide:", file.display());
        for name in names {
            eprintln!("    env.{name}");
        }
    }
    Err(format!(
        "{} program(s) import undeclared env symbols; relink them with the SDK \
         (the missing function belongs in a library), or declare a real host \
         API in HOST_ENV_IMPORTS",
        failures.len()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leb(mut value: usize, out: &mut Vec<u8>) {
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                out.push(byte);
                return;
            }
            out.push(byte | 0x80);
        }
    }

    fn name(text: &str, out: &mut Vec<u8>) {
        leb(text.len(), out);
        out.extend_from_slice(text.as_bytes());
    }

    fn section(id: u8, body: Vec<u8>, out: &mut Vec<u8>) {
        out.push(id);
        leb(body.len(), out);
        out.extend(body);
    }

    /// A module importing `() -> ()` functions from the given (module, name)
    /// pairs, optionally with a `dylink.0` section first.
    fn module(imports: &[(&str, &str)], dylink: bool) -> Vec<u8> {
        let mut out = b"\0asm\x01\0\0\0".to_vec();
        if dylink {
            let mut body = Vec::new();
            name("dylink.0", &mut body);
            section(0, body, &mut out);
        }
        section(1, vec![1, 0x60, 0, 0], &mut out);
        let mut body = Vec::new();
        leb(imports.len(), &mut body);
        for (module, field) in imports {
            name(module, &mut body);
            name(field, &mut body);
            body.extend([0x00, 0x00]);
        }
        section(2, body, &mut out);
        out
    }

    #[test]
    fn declared_host_and_fork_imports_pass() {
        let allowed = allowed_env_imports();
        let bytes = module(
            &[
                ("env", "__wasm_dlopen"),
                ("env", abi::WPK_FORK_REQUIRED_IMPORTS[0].name),
                ("kernel", "kernel_fork"),
            ],
            false,
        );
        assert_eq!(survey(&bytes, &allowed), Ok(Survey::Program { undeclared: vec![] }));
    }

    #[test]
    fn a_library_function_left_as_an_import_is_reported() {
        let allowed = allowed_env_imports();
        let bytes = module(&[("env", "re_compile_pattern"), ("env", "__wasm_dlsym")], false);
        assert_eq!(
            survey(&bytes, &allowed),
            Ok(Survey::Program { undeclared: vec!["re_compile_pattern".into()] })
        );
    }

    #[test]
    fn side_modules_are_skipped() {
        let allowed = allowed_env_imports();
        let bytes = module(&[("env", "some_main_program_symbol")], true);
        assert_eq!(survey(&bytes, &allowed), Ok(Survey::SideModule));
    }

    #[test]
    fn allowed_set_covers_every_host_import() {
        let allowed = allowed_env_imports();
        for import in abi::HOST_ENV_IMPORTS {
            assert!(allowed.contains(import.name), "{}", import.name);
        }
        assert!(allowed.contains(abi::WPK_FORK_UNWIND_TAG_IMPORT_NAME));
        assert!(allowed.contains(abi::WPK_FORK_BOUNDARY_IMPORT));
        for import in abi::WPK_FORK_GLOBAL_IMPORTS {
            assert!(allowed.contains(import.name), "{}", import.name);
        }
    }
}

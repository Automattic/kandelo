//! Process import audit shared by package recipes and resolver admission.
//! Kernel imports come from the SDK's actual libc/startup objects, not all
//! kernel exports (most exports belong only to the kernel-worker adapter).
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use wasm_posix_shared::abi;
use wasmparser::{FuncType, Parser, Payload, TypeRef};

type KernelContract =
    BTreeMap<String, BTreeSet<(Vec<wasmparser::ValType>, Vec<wasmparser::ValType>)>>;
type CachedContracts = BTreeMap<(std::path::PathBuf, String), Result<KernelContract, String>>;
static CONTRACTS: OnceLock<Mutex<CachedContracts>> = OnceLock::new();

#[derive(Default)]
struct Imports {
    entries: Vec<(String, String, TypeRef)>,
    types: Vec<FuncType>,
    side_module: bool,
    relocatable: bool,
    memory64: bool,
}

fn imports(bytes: &[u8]) -> Result<Imports, String> {
    let mut facts = Imports::default();
    for payload in Parser::new(0).parse_all(bytes) {
        match payload.map_err(|error| error.to_string())? {
            Payload::Version { encoding, .. } if encoding != wasmparser::Encoding::Module => {
                return Err("expected a core WebAssembly module".into());
            }
            Payload::TypeSection(types) => {
                for ty in types.into_iter_err_on_gc_types() {
                    facts.types.push(ty.map_err(|error| error.to_string())?);
                }
            }
            Payload::ImportSection(section) => {
                for import in section.into_imports() {
                    let import = import.map_err(|error| error.to_string())?;
                    if let TypeRef::Memory(memory) = import.ty {
                        facts.memory64 |= memory.memory64;
                    }
                    facts
                        .entries
                        .push((import.module.into(), import.name.into(), import.ty));
                }
            }
            Payload::MemorySection(section) => {
                for memory in section {
                    facts.memory64 |= memory.map_err(|error| error.to_string())?.memory64;
                }
            }
            Payload::CustomSection(section) => {
                facts.side_module |= section.name() == "dylink.0";
                facts.relocatable |= section.name() == "linking";
            }
            // Keep walking section headers: relocatable objects put their
            // linking section after code. Function bodies remain unparsed.
            Payload::CodeSectionEntry(_) => {}
            _ => {}
        }
    }
    Ok(facts)
}

fn record_kernel_imports(bytes: &[u8], contract: &mut KernelContract) -> Result<(), String> {
    let facts = imports(bytes)?;
    for (module, name, kind) in facts.entries {
        if module != "kernel" {
            continue;
        }
        let index = match kind {
            TypeRef::Func(index) | TypeRef::FuncExact(index) => index,
            _ => return Err(format!("SDK has a non-function kernel import: {name}")),
        };
        let ty = facts
            .types
            .get(index as usize)
            .ok_or("invalid SDK import type index")?;
        contract
            .entry(name)
            .or_default()
            .insert((ty.params().to_vec(), ty.results().to_vec()));
    }
    Ok(())
}

// LLVM emits GNU or BSD ar names. Decode both, rejecting truncated members;
// symbol/name tables are metadata, not WebAssembly objects.
fn archive_members(bytes: &[u8]) -> Result<Vec<&[u8]>, String> {
    if !bytes.starts_with(b"!<arch>\n") {
        return Err("SDK libc is not an ar archive".into());
    }
    let mut position = 8;
    let mut members = Vec::new();
    while position < bytes.len() {
        let header = bytes
            .get(position..position + 60)
            .ok_or("truncated ar header")?;
        if &header[58..60] != b"`\n" {
            return Err("invalid ar header".into());
        }
        let length: usize = std::str::from_utf8(&header[48..58])
            .map_err(|e| e.to_string())?
            .trim()
            .parse()
            .map_err(|e| format!("invalid ar member length: {e}"))?;
        position += 60;
        let mut member = bytes
            .get(position..position.checked_add(length).ok_or("ar length overflow")?)
            .ok_or("truncated ar member")?;
        let name = std::str::from_utf8(&header[..16])
            .map_err(|e| e.to_string())?
            .trim();
        if let Some(length) = name.strip_prefix("#1/") {
            let length: usize = length
                .parse()
                .map_err(|e| format!("invalid BSD ar name: {e}"))?;
            member = member.get(length..).ok_or("truncated BSD ar name")?;
        }
        if member.starts_with(b"\0asm") {
            members.push(member);
        }
        position += length;
        position += length % 2;
    }
    if members.is_empty() {
        return Err("SDK libc has no WebAssembly members".into());
    }
    Ok(members)
}

fn sdk_kernel_contract(sysroot: &Path) -> Result<KernelContract, String> {
    let mut contract = KernelContract::new();
    let archive =
        std::fs::read(sysroot.join("lib/libc.a")).map_err(|e| format!("read SDK libc: {e}"))?;
    for member in archive_members(&archive)? {
        record_kernel_imports(member, &mut contract)?;
    }
    record_kernel_imports(
        &std::fs::read(sysroot.join("lib/crt1.o"))
            .map_err(|e| format!("read SDK startup object: {e}"))?,
        &mut contract,
    )?;
    // channel_syscall.c supplies this import outside libc.a. Its typed
    // declaration is already authoritative in the shared fork contract.
    let fork = abi::WPK_FORK_PROCESS_IMPORT;
    let value = |value: &abi::ProgramArtifactValueType| match value {
        abi::ProgramArtifactValueType::I32 => wasmparser::ValType::I32,
        abi::ProgramArtifactValueType::I64 => wasmparser::ValType::I64,
        _ => unreachable!("kernel_fork has scalar arguments"),
    };
    contract.entry(fork.name.into()).or_default().insert((
        fork.params.iter().map(value).collect(),
        fork.results.iter().map(value).collect(),
    ));
    Ok(contract)
}

fn audit(facts: &Imports, contract: &KernelContract) -> Vec<String> {
    if facts.relocatable {
        return vec![];
    }
    let env = crate::program_env_imports::allowed_env_imports();
    let mut failures = Vec::new();
    for (module, name, kind) in &facts.entries {
        if module == "env" {
            // Side modules may resolve ordinary library symbols against the
            // main program. They must not impersonate a reserved host import.
            if !env.contains(name.as_str()) && !facts.side_module {
                failures.push(format!("undeclared host import env.{name}"));
            }
            if let Some(declaration) = abi::HOST_ENV_IMPORTS.iter().find(|d| d.name == name) {
                let valid = matches!(
                    (declaration.kind, kind),
                    (
                        abi::HostEnvImportKind::Function,
                        TypeRef::Func(_) | TypeRef::FuncExact(_)
                    ) | (abi::HostEnvImportKind::Memory, TypeRef::Memory(_))
                        | (abi::HostEnvImportKind::Global, TypeRef::Global(_))
                        | (abi::HostEnvImportKind::Tag, TypeRef::Tag(_))
                );
                if !valid {
                    failures.push(format!("wrong import kind for env.{name}"));
                }
            }
        } else if facts.side_module && matches!(module.as_str(), "GOT.mem" | "GOT.func") {
            // The shared dynamic loader supplies mutable pointer-width GOT
            // cells for data addresses and function-table slots. This is a
            // side-module ABI, not an arbitrary additional host namespace.
            let pointer_type = if facts.memory64 {
                wasmparser::ValType::I64
            } else {
                wasmparser::ValType::I32
            };
            if !matches!(kind, TypeRef::Global(global)
                if global.mutable && !global.shared && global.content_type == pointer_type)
            {
                failures.push(format!("wrong GOT import type for {module}.{name}"));
            }
        } else if module == "kernel" {
            let index = match kind {
                TypeRef::Func(index) | TypeRef::FuncExact(index) => *index,
                _ => {
                    failures.push(format!("kernel.{name} must be a function"));
                    continue;
                }
            };
            match (contract.get(name), facts.types.get(index as usize)) {
                (Some(signatures), Some(ty))
                    if signatures.contains(&(ty.params().to_vec(), ty.results().to_vec())) => {}
                (Some(_), _) => failures.push(format!("wrong function type for kernel.{name}")),
                (None, _) => failures.push(format!("undeclared process import kernel.{name}")),
            }
        } else {
            failures.push(format!("unsupported process import {module}.{name}"));
        }
    }
    failures
}

pub(crate) fn failures(bytes: &[u8], repo: &Path) -> Result<Vec<String>, String> {
    let facts = imports(bytes)?;
    if facts.relocatable {
        return Ok(vec![]);
    }
    let sysroot = repo.join(if facts.memory64 {
        "sysroot64"
    } else {
        "sysroot"
    });
    if !facts
        .entries
        .iter()
        .any(|(module, _, _)| module == "kernel")
    {
        return Ok(audit(&facts, &KernelContract::new()));
    }
    let stamp = std::fs::read_to_string(sysroot.join(".kandelo-musl.input-hash"))
        .map_err(|e| format!("SDK is unstamped; run bootstrap sdk: {e}"))?;
    let mut cache = CONTRACTS
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .map_err(|e| format!("SDK import contract lock: {e}"))?;
    let contract = cache
        .entry((sysroot.clone(), stamp))
        .or_insert_with(|| sdk_kernel_contract(&sysroot))
        .clone()?;
    Ok(audit(&facts, &contract))
}

pub(crate) fn run(args: Vec<String>) -> Result<(), String> {
    let mut args = args;
    let require_startup = args.first().is_some_and(|arg| arg == "--require-startup");
    if require_startup {
        args.remove(0);
    }
    if args.is_empty() {
        return Err("usage: xtask check-package-imports [--require-startup] <wasm>...".into());
    }
    let repo = crate::repo_root();
    for path in args {
        let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
        let mut failures = failures(&bytes, &repo)?;
        if require_startup {
            failures.extend(startup_failures(&imports(&bytes)?));
        }
        if !failures.is_empty() {
            return Err(format!("{path}: {}", failures.join("; ")));
        }
        eprintln!("check-package-imports: {path}: valid process import contract");
    }
    Ok(())
}

fn startup_failures(facts: &Imports) -> Vec<String> {
    ["memory", "__channel_base"]
        .into_iter()
        .filter_map(|required| {
            (!facts
                .entries
                .iter()
                .any(|(module, name, _)| module == "env" && name == required))
            .then(|| format!("missing SDK startup import env.{required}"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_linking_metadata_after_code_is_not_missed() {
        let mut bytes = b"\0asm\x01\0\0\0".to_vec();
        bytes.extend_from_slice(&[10, 1, 0]); // empty code section
        bytes.extend_from_slice(b"\0\x08\x07linking");
        let facts = imports(&bytes).unwrap();
        assert!(facts.relocatable);
        assert!(audit(&facts, &KernelContract::new()).is_empty());
    }

    #[test]
    fn smoke_links_must_keep_sdk_startup_imports() {
        assert_eq!(startup_failures(&Imports::default()).len(), 2);
    }

    #[test]
    fn imports_are_typed_and_kernel_exports_are_not_process_imports() {
        let contract = BTreeMap::from([(
            "kernel_clone".into(),
            BTreeSet::from([(
                vec![wasmparser::ValType::I32],
                vec![wasmparser::ValType::I32],
            )]),
        )]);
        let valid = Imports {
            entries: vec![("kernel".into(), "kernel_clone".into(), TypeRef::Func(0))],
            types: vec![FuncType::new(
                [wasmparser::ValType::I32],
                [wasmparser::ValType::I32],
            )],
            ..Imports::default()
        };
        assert!(audit(&valid, &contract).is_empty());
        for (module, name, kind) in [
            ("kernel", "kernel_clone", TypeRef::Func(1)),
            ("kernel", "kernel_create_process", TypeRef::Func(0)),
            (
                "kernel",
                "kernel_clone",
                TypeRef::Global(wasmparser::GlobalType {
                    content_type: wasmparser::ValType::I32,
                    mutable: false,
                    shared: false,
                }),
            ),
            ("env", "memcpy_s", TypeRef::Func(0)),
            ("env", "__channel_base", TypeRef::Func(0)),
            ("wasi_snapshot_preview1", "fd_write", TypeRef::Func(0)),
        ] {
            let invalid = Imports {
                entries: vec![(module.into(), name.into(), kind)],
                types: valid.types.clone(),
                ..Imports::default()
            };
            assert!(!audit(&invalid, &contract).is_empty(), "{module}.{name}");
        }
    }

    #[test]
    fn side_modules_keep_library_symbols_but_not_unknown_kernel_imports() {
        let mut facts = Imports {
            entries: vec![("env".into(), "library_symbol".into(), TypeRef::Func(0))],
            side_module: true,
            ..Imports::default()
        };
        assert!(audit(&facts, &KernelContract::new()).is_empty());
        facts
            .entries
            .push(("kernel".into(), "made_up".into(), TypeRef::Func(0)));
        assert!(!audit(&facts, &KernelContract::new()).is_empty());
    }

    #[test]
    fn side_module_got_cells_match_the_shared_loader_contract() {
        for memory64 in [false, true] {
            let pointer_type = if memory64 {
                wasmparser::ValType::I64
            } else {
                wasmparser::ValType::I32
            };
            for module in ["GOT.mem", "GOT.func"] {
                let global = wasmparser::GlobalType {
                    content_type: pointer_type,
                    mutable: true,
                    shared: false,
                };
                let mut facts = Imports {
                    entries: vec![(
                        module.into(),
                        "library_symbol".into(),
                        TypeRef::Global(global),
                    )],
                    side_module: true,
                    memory64,
                    ..Imports::default()
                };
                assert!(audit(&facts, &KernelContract::new()).is_empty());
                facts.side_module = false;
                assert!(!audit(&facts, &KernelContract::new()).is_empty());
                facts.side_module = true;
                for invalid in [
                    TypeRef::Func(0),
                    TypeRef::Global(wasmparser::GlobalType {
                        mutable: false,
                        ..global
                    }),
                    TypeRef::Global(wasmparser::GlobalType {
                        shared: true,
                        ..global
                    }),
                    TypeRef::Global(wasmparser::GlobalType {
                        content_type: if memory64 {
                            wasmparser::ValType::I32
                        } else {
                            wasmparser::ValType::I64
                        },
                        ..global
                    }),
                ] {
                    facts.entries[0].2 = invalid;
                    assert!(!audit(&facts, &KernelContract::new()).is_empty());
                }
            }
        }
    }

    #[test]
    fn malformed_archives_fail_closed() {
        for bytes in [b"!<thin>\n".as_slice(), b"!<arch>\n", b"!<arch>\ntruncated"] {
            assert!(archive_members(bytes).is_err());
        }
    }

    #[test]
    fn sdk_imports_are_supplied_by_the_shared_process_worker() {
        let repo = crate::repo_root();
        let host = std::fs::read_to_string(repo.join("host/src/worker-main.ts")).unwrap();
        let sources = [
            "libc/musl-overlay/crt/crt1.c",
            "libc/musl-overlay/src/env/__libc_start_main.c",
            "libc/musl-overlay/src/thread/wasm32posix/clone.c",
            "libc/glue/channel_syscall.c",
        ];
        let names = regex::Regex::new(r#"import_name\("(kernel_[a-z0-9_]+)"\)"#).unwrap();
        for source in sources {
            let source = std::fs::read_to_string(repo.join(source)).unwrap();
            for name in names.captures_iter(&source) {
                assert!(
                    host.contains(&format!("{}:", &name[1])),
                    "host lacks {}",
                    &name[1]
                );
            }
        }
    }
}

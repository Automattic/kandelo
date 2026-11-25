use shared_memory_instrument::{ARTIFACT_SECTION, EXTENSION_MODULE, check_sdk_input, translate};
use std::{borrow::Cow, fs, path::Path, process::Command};
use wasm_encoder::{CustomSection, Encode};
const DIGEST: [u8; 32] = [0x42; 32];
fn stamp(mut bytes: Vec<u8>, digest: &[u8]) -> Vec<u8> {
    bytes.push(0);
    CustomSection {
        name: Cow::Borrowed("kandelo.abi.contract"),
        data: Cow::Borrowed(digest),
    }
    .encode(&mut bytes);
    bytes
}
fn input(body: &str) -> Vec<u8> {
    stamp(
        wat::parse_str(format!(
            r#"(module(import "env" "memory" (memory 2 32 shared))
      (func(export "__abi_version")(result i32)i32.const {}) {body})"#,
            wasm_posix_program_abi::ABI_VERSION
        ))
        .unwrap(),
        &DIGEST,
    )
}
fn digest() -> String {
    "42".repeat(32)
}
#[test]
fn refuses_stale_missing_and_ambiguous_abi_stamps() {
    assert!(check_sdk_input(&input(""), &digest()).is_ok());
    let missing =
        wat::parse_str("(module (import \"env\" \"memory\" (memory 2 32 shared)))").unwrap();
    assert!(check_sdk_input(&missing, &digest()).is_err());
    assert!(check_sdk_input(&input(""), &"43".repeat(32)).is_err());
    assert!(check_sdk_input(&stamp(input(""), &DIGEST), &digest()).is_err());
    assert!(check_sdk_input(&input(""), "not a digest").is_err());
}
#[test]
fn refuses_side_modules_and_reserved_vm_exports() {
    let mut object = input("");
    object.push(0);
    CustomSection {
        name: Cow::Borrowed("dylink.0"),
        data: Cow::Borrowed(&[]),
    }
    .encode(&mut object);
    assert!(check_sdk_input(&object, &digest()).is_err());
    assert!(
        check_sdk_input(
            &input("(global(export \"__vm_root\")(mut i32)(i32.const 0))"),
            &digest()
        )
        .is_err()
    );
    assert!(check_sdk_input(&input("(func(export \"__vm_checkpoint\"))"), &digest()).is_err());
    assert!(check_sdk_input(&input("(func(export \"__vm_worker_wait32\"))"), &digest()).is_err());
    let wide=stamp(wat::parse_str(format!("(module (import \"env\" \"memory\" (memory i64 2 32)) (func(export \"__abi_version\")(result i32)i32.const {}))",wasm_posix_program_abi::ABI_VERSION)).unwrap(),&DIGEST);
    assert!(check_sdk_input(&wide, &digest()).is_err());
}
fn command(command: &mut Command) {
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{:?}\nstdout:{}\nstderr:{}",
        command,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
fn helpers(directory: &Path) -> Vec<u8> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    command(
        Command::new("bash")
            .arg(root.join("scripts/build-shared-memory-helpers.sh"))
            .arg(directory),
    );
    fs::read(directory.join("helpers.wasm")).unwrap()
}

#[test]
fn outlined_offsets_share_code_without_changing_effective_addresses() {
    let directory = tempfile::tempdir().unwrap();
    let helper = helpers(directory.path());
    let source = input(r#"
        (func(export "load0")(param i32)(result i32) local.get 0 i32.load)
        (func(export "load4")(param i32)(result i32) local.get 0 i32.load offset=4)
        (func(export "loadMax")(param i32)(result i32) local.get 0 i32.load offset=4294967295)
        (func(export "store0")(param i32 i32) local.get 0 local.get 1 i32.store)
        (func(export "store4")(param i32 i32) local.get 0 local.get 1 i32.store offset=4)
        (func(export "loadSplit")(param i32)(result i32) local.get 0 i32.load offset=65534 align=1)
        (func(export "storeSplit")(param i32 i32) local.get 0 local.get 1 i32.store offset=65534 align=1)
        (func(export "atomicStore64")(param i32 i32) local.get 0 local.get 1 i32.atomic.store offset=64)
        (func(export "atomicStore128")(param i32 i32) local.get 0 local.get 1 i32.atomic.store offset=128)
        (func(export "atomicAdd64")(param i32 i32)(result i32) local.get 0 local.get 1 i32.atomic.rmw.add offset=64)
        (func(export "atomicAdd128")(param i32 i32)(result i32) local.get 0 local.get 1 i32.atomic.rmw.add offset=128)
        (func(export "storeWide8")(param i32 i64) local.get 0 local.get 1 i64.store offset=8)
        (func(export "storeWide16")(param i32 i64) local.get 0 local.get 1 i64.store offset=16)
        (func(export "loadWide8")(param i32)(result i64) local.get 0 i64.load offset=8)
        (func(export "loadWide16")(param i32)(result i64) local.get 0 i64.load offset=16)
    "#);
    let (bytes, report) = translate(&source, &helper, &digest()).unwrap();
    // Alignment and operation remain significant; only constant offsets share.
    assert_eq!(report["accessWrappers"], 8);
    let output = directory.path().join("offsets.wasm");
    fs::write(&output, &bytes).unwrap();
    let worker = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/offsets-node.mjs").canonicalize().unwrap();
    let result = Command::new("node").args(["--input-type=module", "-e", r#"
        import {Worker} from 'node:worker_threads';
        const worker=new Worker(process.argv[1],{workerData:process.argv[2],execArgv:['--import','tsx']});
        const timer=setTimeout(()=>{worker.terminate();process.exitCode=1;},20000);
        worker.on('message',result=>{clearTimeout(timer);console.log(JSON.stringify(result));});
        worker.on('error',error=>{clearTimeout(timer);console.error(error);process.exitCode=1;});
    "#]).arg(worker).arg(output).output().unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    let result: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(result["passed"], true);
    assert_eq!(result["checks"].as_array().unwrap().len(), 10);
}

#[test]
fn bounded_copy_matches_snapshot_oracle_for_all_small_alias_mappings() {
    let directory = tempfile::tempdir().unwrap();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/copy-graph-oracle.c");
    let executable = directory.path().join("copy-graph-oracle");
    command(Command::new("clang").args(["-O2", "-std=c11"]).arg(fixture).arg("-o").arg(&executable));
    let result = Command::new(executable).output().unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    assert_eq!(String::from_utf8_lossy(&result.stdout).trim(),
        "copy_graph_snapshot_oracle_cases=4048380\ncopy_graph_sparse_oracle_cases=144");
}
// Change an actual compiled marker without invalidating the module or its
// function type. All low-bit changes preserve the original signed LEB width.
fn stale_layout_marker(helper: &[u8], name: &str) -> Vec<u8> {
    use wasmparser::{Operator, Parser, Payload};
    let export_name = format!("vm_layout_{name}");
    let mut target = None;
    for payload in Parser::new(0).parse_all(helper) {
        if let Payload::ExportSection(exports) = payload.unwrap() {
            for export in exports {
                let export = export.unwrap();
                if export.name == export_name {
                    target = Some(export.index);
                }
            }
        }
    }
    let target = target.expect("compiled C marker export");
    let imported = Parser::new(0).parse_all(helper).filter_map(|payload| match payload.unwrap() {
        Payload::ImportSection(imports) => Some(imports.into_imports()
            .filter(|entry| matches!(entry.as_ref().unwrap().ty, wasmparser::TypeRef::Func(_))).count() as u32),
        _ => None,
    }).sum::<u32>();
    let target = target.checked_sub(imported).expect("marker must be a defined function");
    let mut function = 0;
    for payload in Parser::new(0).parse_all(helper) {
        if let Payload::CodeSectionEntry(body) = payload.unwrap() {
            if function == target {
                let mut reader = body.get_operators_reader().unwrap();
                let opcode = reader.original_position();
                assert!(matches!(reader.read().unwrap(), Operator::I32Const { .. }));
                let mut stale = helper.to_vec();
                stale[opcode + 1] ^= 1;
                wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all())
                    .validate_all(&stale)
                    .unwrap();
                return stale;
            }
            function += 1;
        }
    }
    panic!("compiled C marker body was not found");
}
#[test]
fn helper_signatures_are_checked_without_source_operations() {
    let directory = tempfile::tempdir().unwrap();
    let helper = helpers(directory.path());
    let mut wrong = wasm_encoder::Module::new();
    // Find the actual function index from the compiled module, then give its
    // valid but incompatible type to vm_span without changing layout markers.
    let mut size_index = None;
    for payload in wasmparser::Parser::new(0).parse_all(&helper) {
        if let wasmparser::Payload::ExportSection(exports) = payload.unwrap() {
            for export in exports {
                let export = export.unwrap();
                if export.name == "vm_size" { size_index = Some(export.index); }
            }
        }
    }
    for payload in wasmparser::Parser::new(0).parse_all(&helper) {
        let payload = payload.unwrap();
        if let wasmparser::Payload::ExportSection(exports) = payload {
            let mut section = wasm_encoder::ExportSection::new();
            for export in exports {
                let export = export.unwrap();
                let kind = match export.kind {
                    wasmparser::ExternalKind::Func => wasm_encoder::ExportKind::Func,
                    wasmparser::ExternalKind::Memory => wasm_encoder::ExportKind::Memory,
                    _ => panic!("unexpected helper export"),
                };
                section.export(export.name, kind,
                    if export.name == "vm_span" { size_index.unwrap() } else { export.index });
            }
            wrong.section(&section);
        } else if let Some((id, range)) = payload.as_section() {
            wrong.section(&wasm_encoder::RawSection {id, data: &helper[range]});
        }
    }
    let wrong = wrong.finish();
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all()).validate_all(&wrong).unwrap();
    let Err(error) = translate(&input(""), &wrong, &digest()) else {
        panic!("accepted an incompatible helper signature without source operations");
    };
    assert!(error.to_string().contains("helper signature"), "{error:#}");
}
#[test]
fn compiled_helpers_reject_every_stale_layout_constant() {
    let directory = tempfile::tempdir().unwrap();
    let helper = helpers(directory.path());
    let source = input("(func(export \"op\")(param i32)(result i32)local.get 0 i32.load)");
    assert!(translate(&source, &helper, &digest()).is_ok());
    for (name, _) in wasm_posix_program_abi::program_extensions::memory_group_v3::WIRE {
        let stale = stale_layout_marker(&helper, name);
        let error = translate(&source, &stale, &digest()).unwrap_err();
        assert!(
            error.to_string().contains("compiled helper layout"),
            "{name}: {error:#}"
        );
    }
}
#[test]
fn passive_initialization_preserves_large_ranges_and_segment_bounds() {
    let directory = tempfile::tempdir().unwrap();
    let helper = helpers(directory.path());
    let data: String = (0..2 * 65536 + 31).map(|i| format!("\\{:02x}", i % 251)).collect();
    let source = input(&format!(r#"(data $payload "{data}")
        (func(export "init")(param i32 i32 i32)
            local.get 0 local.get 1 local.get 2 memory.init $payload)
        (func(export "drop") data.drop $payload)"#));
    let (bytes, report) = translate(&source, &helper, &digest()).unwrap();
    assert_eq!(report["rewritten"]["MemoryInit"], 1);
    let active_source = input(r#"(data (i32.const 0) "abc")
        (func $start i32.const 10 i32.const 0 i32.const 1 memory.init 0)
        (start $start)"#);
    let (active_bytes, _) = translate(&active_source, &helper, &digest()).unwrap();
    let ordinary = directory.path().join("ordinary.wasm");
    let grouped = directory.path().join("grouped.wasm");
    let active_ordinary = directory.path().join("active-ordinary.wasm");
    let active_grouped = directory.path().join("active-grouped.wasm");
    fs::write(&ordinary, &source).unwrap();fs::write(&grouped, &bytes).unwrap();
    fs::write(&active_ordinary, &active_source).unwrap();fs::write(&active_grouped, &active_bytes).unwrap();
    if let Ok(path) = std::env::var("KANDELO_SHARED_SDK_EVIDENCE_DIR") {
        let path = Path::new(&path);fs::create_dir_all(path).unwrap();
        fs::write(path.join("passive-ordinary.wasm"), &source).unwrap();
        fs::write(path.join("passive-grouped.wasm"), &bytes).unwrap();
        fs::write(path.join("active-ordinary.wasm"), &active_source).unwrap();
        fs::write(path.join("active-grouped.wasm"), &active_bytes).unwrap();
    }
    let worker = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/data-init-node.mjs").canonicalize().unwrap();
    let output = Command::new("node").args(["--input-type=module", "-e", r#"
        import {Worker} from 'node:worker_threads';
        const worker=new Worker(process.argv[1],{workerData:{ordinary:process.argv[2],grouped:process.argv[3],activeOrdinary:process.argv[4],activeGrouped:process.argv[5]},execArgv:[]});
        const timer=setTimeout(()=>{worker.terminate();process.exitCode=1;},10000);
        worker.on('message',result=>{clearTimeout(timer);console.log(JSON.stringify(result));});
        worker.on('error',error=>{clearTimeout(timer);console.error(error);process.exitCode=1;});
    "#]).arg(worker).arg(ordinary).arg(grouped).arg(active_ordinary).arg(active_grouped).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["checks"].as_array().unwrap().len(), 12);
    println!("{}", String::from_utf8_lossy(&output.stdout));
}
#[test]
fn translated_c_preserves_real_memory_operations_in_a_worker() {
    let directory = tempfile::tempdir().unwrap();
    let helpers = helpers(directory.path());
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let llvm = std::env::var("LLVM_BIN").expect("run through scripts/dev-shell.sh");
    let raw = directory.path().join("ordinary.wasm");
    command(
        Command::new(Path::new(&llvm).join("clang"))
            .args([
                "--target=wasm32-unknown-unknown",
                "-ffreestanding",
                "-fno-builtin",
                "-O2",
                "-matomics",
                "-mbulk-memory",
                "-msimd128",
                "-nostdlib",
                "-Wl,--no-entry",
                "-Wl,--import-memory",
                "-Wl,--shared-memory",
                "-Wl,--initial-memory=131072",
                "-Wl,--max-memory=2097152",
                "-Wl,-z,stack-size=65536",
            ])
            .arg(format!("-fuse-ld={llvm}/wasm-ld"))
            .arg(format!(
                "-DABI_VERSION={}",
                wasm_posix_program_abi::ABI_VERSION
            ))
            .arg(crate_root.join("tests/fixtures/access.c"))
            .arg("-o")
            .arg(&raw),
    );
    let source = stamp(fs::read(raw).unwrap(), &DIGEST);
    let (bytes, report) = translate(&source, &helpers, &digest()).unwrap();
    assert!(report["rewritten"]["MemoryCopy"].as_u64().unwrap() > 0);
    assert!(report["rewritten"]["MemoryAtomicWait32"].as_u64().unwrap() > 0);
    assert_eq!(
        wasm_artifact::read_abi_version(&bytes),
        Some(wasm_posix_program_abi::ABI_VERSION as i32)
    );
    let facts = wasm_artifact::read_artifact_facts(&bytes).unwrap();
    assert!(
        facts
            .custom_section_names
            .iter()
            .any(|name| name == ARTIFACT_SECTION)
    );
    assert!(
        facts
            .import_descriptors
            .iter()
            .any(|import| import.module == EXTENSION_MODULE)
    );
    let refusal = wasm_artifact::describe_artifact_policy_failures(&bytes, &Default::default());
    assert!(
        refusal
            .failures
            .iter()
            .any(|f| f.contains("unsupported required program extension"))
    );
    assert!(check_sdk_input(&bytes, &digest()).is_err());
    if let Ok(path) = std::env::var("KANDELO_SHARED_SDK_EVIDENCE_DIR") {
        let path = Path::new(&path);
        fs::create_dir_all(path).unwrap();
        fs::write(path.join("ordinary.wasm"), &source).unwrap();
        fs::write(path.join("helpers.wasm"), &helpers).unwrap();
        fs::write(path.join("grouped.wasm"), &bytes).unwrap();
        fs::write(
            path.join("translation.json"),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .unwrap();
    }
    let output = directory.path().join("grouped.wasm");
    fs::write(&output, bytes).unwrap();
    let worker = crate_root
        .join("tests/fixtures/node-runner.mjs")
        .canonicalize()
        .unwrap();
    let output=Command::new("node").args(["--input-type=module","-e",r#"import {Worker} from 'node:worker_threads';const w=new Worker(process.argv[1],{workerData:process.argv[2],execArgv:["--import","tsx"]});const timer=setTimeout(()=>{w.terminate();process.exitCode=1;console.error('mechanism worker timed out');},20000);w.on('message',r=>{clearTimeout(timer);console.log(JSON.stringify(r));});w.on('error',e=>{clearTimeout(timer);console.error(e);process.exitCode=1;});"#]).arg(worker).arg(output).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(result["checks"].as_array().unwrap().len() >= 25);
    println!("{}", String::from_utf8_lossy(&output.stdout));
}
#[test]
fn helper_contract_and_fork_custom_sections_remain_exact() {
    let directory = tempfile::tempdir().unwrap();
    let helper = helpers(directory.path());
    let mut source = input("(func(export \"op\")(param i32)(result i32)local.get 0 i32.load)");
    let name = "kandelo.wpk_fork.module_state";
    let payload = [1, 2, 3, 4];
    source.push(0);
    CustomSection {
        name: Cow::Borrowed(name),
        data: Cow::Borrowed(&payload),
    }
    .encode(&mut source);
    let (bytes, report) = translate(&source, &helper, &digest()).unwrap();
    assert_eq!(wasm_artifact::read_abi_version(&bytes), Some(wasm_posix_program_abi::ABI_VERSION as i32));
    assert_eq!(
        wasm_artifact::read_custom_section(&bytes, name),
        Some(&payload[..])
    );
    assert_eq!(report["threadAttach"], 2);
    assert_eq!(report["cooperativeStop"], 3);
    assert_eq!(report["executionBarrier"], 1);
    let bad = wat::parse_str("(module(import \"env\" \"memory\"(memory 2 32 shared)))").unwrap();
    assert!(translate(&source, &bad, &digest()).is_err());
}

#[test]
fn cli_refusal_preserves_input_and_existing_output() {
    let directory = tempfile::tempdir().unwrap();
    let ordinary = directory.path().join("ordinary.wasm");
    let output = directory.path().join("grouped.wasm");
    let helper = directory.path().join("helpers.wasm");
    let source = input("");
    fs::write(&ordinary, &source).unwrap();
    fs::write(&output, b"existing output").unwrap();
    fs::write(&helper, b"not wasm").unwrap();
    let invoke = |path: &Path| {
        Command::new(env!("CARGO_BIN_EXE_wasm-shared-memory-instrument"))
            .arg(&ordinary)
            .arg("--helpers")
            .arg(&helper)
            .arg("--abi-digest")
            .arg(digest())
            .arg("-o")
            .arg(path)
            .output()
            .unwrap()
    };
    assert!(!invoke(&output).status.success());
    assert_eq!(fs::read(&output).unwrap(), b"existing output");
    assert_eq!(fs::read(&ordinary).unwrap(), source);
    let alias = directory.path().join("alias.wasm");
    fs::hard_link(&ordinary, &alias).unwrap();
    assert!(!invoke(&alias).status.success());
    assert_eq!(fs::read(&ordinary).unwrap(), source);
    let fresh_helpers = helpers(directory.path());
    fs::write(&helper, stale_layout_marker(&fresh_helpers, "CONTROL")).unwrap();
    assert!(!invoke(&output).status.success());
    assert_eq!(fs::read(&output).unwrap(), b"existing output");
    assert_eq!(fs::read(&ordinary).unwrap(), source);
    fs::write(&helper, fresh_helpers).unwrap();
    assert!(invoke(&output).status.success());
    assert_eq!(fs::read(&ordinary).unwrap(), source);
    assert!(
        wasm_artifact::read_custom_section(&fs::read(output).unwrap(), ARTIFACT_SECTION).is_some()
    );
}

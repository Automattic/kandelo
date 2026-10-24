use fork_instrument::streaming::*;
#[path = "support/streaming_loader.rs"]
mod native;

fn oracle(input: &[u8]) -> Vec<u8> {
    let mut module = walrus::Module::from_buffer(input).unwrap();
    fork_instrument::legacy_dlopen::lower(&mut module).unwrap();
    module.emit_wasm()
}

#[test]
fn staged_loader_preserves_argument_shapes_identity_and_nonreentrant_call_order() {
    for [pointer, length, name_length] in [
        ["i32", "i32", "i32"],
        ["i64", "i64", "i64"],
        ["i64", "i32", "i64"],
        ["i32", "i64", "i32"],
    ] {
        for count in [2, 4, 5] {
            let types: Vec<_> = [pointer, length, pointer, name_length, "i32"]
                .into_iter()
                .take(count)
                .collect();
            for wide_table in [false, true] {
                let input = wat::parse_str(
                    include_str!("fixtures/streaming_loader.wat")
                        .replace("@PARAMETERS@", &types.join(" "))
                        .replace(
                            "@ARGUMENTS@",
                            &(0..count)
                                .map(|index| format!("local.get {index}"))
                                .collect::<Vec<_>>()
                                .join(" "),
                        )
                        .replace("@TABLE_WIDTH@", if wide_table { "i64" } else { "" })
                        .replace("@TABLE_POINTER@", if wide_table { "i64" } else { "i32" }),
                )
                .unwrap();
                let output = native::emit(&input);
                assert_eq!(output, native::emit(&input));
                for (backend, bytes) in [("native", output), ("Walrus", oracle(&input))] {
                    let file = tempfile::NamedTempFile::new().unwrap();
                    std::fs::write(file.path(), bytes).unwrap();
                    let result = std::process::Command::new("node")
                        .arg("-e")
                        .arg(include_str!("fixtures/streaming_loader.cjs"))
                        .arg("loader-test")
                        .arg(file.path())
                        .arg(types.join(","))
                        .arg(if wide_table { "1" } else { "0" })
                        .output()
                        .unwrap();
                    assert!(
                        result.status.success(),
                        "{backend}, {types:?}, table64={wide_table}: {}",
                        String::from_utf8_lossy(&result.stderr)
                    );
                }
            }
        }
    }
}

#[test]
fn loader_rejects_bad_signatures_and_limits_before_reserving_bindings() {
    for signature in [
        "(param i32)",
        "(param i32 i32) (result i64)",
        "(param i32 i32 i64 i32) (result i32)",
        "(param i32 i32 i32 i32 i64) (result i32)",
    ] {
        let input = wat::parse_str(format!(
            "(module (import \"env\" \"__wasm_dlopen\" (func {signature})))"
        ))
        .unwrap();
        let scan = scan(&input).unwrap();
        let mut inputs = RuntimeInputs::default();
        assert!(LegacyLoaderPlan::reserve(&scan, &mut inputs, 0, Default::default()).is_err());
        assert!(
            inputs.types.is_empty()
                && inputs.imports.is_empty()
                && inputs.function_adapters.is_empty()
        );
    }
    let input = wat::parse_str(
        "(module (import \"env\" \"__wasm_dlopen\" (func (param i32 i32) (result i32))))",
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    for limits in [
        LoaderLimits {
            metadata_bytes: 0,
            ..Default::default()
        },
        LoaderLimits {
            work: 0,
            ..Default::default()
        },
    ] {
        assert!(
            LegacyLoaderPlan::reserve(&scan, &mut RuntimeInputs::default(), 0, limits).is_err()
        );
    }
    assert!(
        LegacyLoaderPlan::reserve(
            &scan,
            &mut RuntimeInputs::default(),
            u32::MAX,
            Default::default()
        )
        .is_err()
    );
    let mut inputs = RuntimeInputs::default();
    let plan = LegacyLoaderPlan::reserve(&scan, &mut inputs, 0, Default::default()).unwrap();
    let imports = FrozenImports::with_function_adapters(
        &scan,
        inputs.imports,
        inputs.function_adapters,
        1 << 20,
    )
    .unwrap();
    let mut module = ModuleDeclarationBuilder::new(&scan, Some(&imports), 1 << 20).unwrap();
    let loader = plan.freeze(&scan, &imports, &mut module).unwrap();
    assert!(loader.emit_helper(0, 0).is_err());
    assert!(loader.emit_helper(1, 0).is_err());
    assert!(loader.emit_helper(2, 1 << 20).is_err());
}

#[test]
fn staged_import_reuse_recognizes_canonical_types_and_preserves_each_legacy_identity() {
    let input = wat::parse_str(
        r#"(module
      (type $step (func (param i32) (result i32)))
      (type $same_step (func (param i32) (result i32)))
      (import "env" "__wasm_dlopen_next" (func (type $same_step)))
      (import "env" "__wasm_dlopen" (func $short (param i32 i32) (result i32)))
      (import "env" "__wasm_dlopen_main" (func (result i32)))
      (import "env" "__wasm_dlopen" (func $full (param i32 i32 i32 i32 i32) (result i32)))
      (import "env" "__wasm_dlopen_commit" (func (type $same_step)))
      (import "env" "__wasm_dlopen_prepare" (func (param i32 i32 i32 i32 i32) (result i32)))
      (table (export "__indirect_function_table") 2 funcref)
      (elem (i32.const 0) func $short $full)
      (export "short" (func $short)) (export "full" (func $full)))"#,
    )
    .unwrap();
    let output = native::emit(&input);
    let scan = scan(&output).unwrap();
    let imported: Vec<_> = scan
        .functions
        .iter()
        .filter_map(|function| function.import.as_ref())
        .collect();
    assert_eq!(imported.len(), 4, "reuse all four existing staged imports");
    assert!(!imported.iter().any(|(_, name)| name == "__wasm_dlopen"));
    let aliases: Vec<_> = scan
        .exports
        .iter()
        .filter(|(name, _, _)| name == "short" || name == "full")
        .map(|(_, _, index)| *index)
        .collect();
    assert_eq!(aliases.len(), 2);
    assert_ne!(aliases[0], aliases[1]);
    assert_eq!(
        scan.elements[0].items,
        aliases
            .iter()
            .map(|&function| ValueProof::Function(function))
            .collect::<Vec<_>>()
    );
    for &function in &aliases {
        let body = scan
            .body_provider(Default::default())
            .load(function)
            .unwrap();
        assert!(
            body.instructions
                .iter()
                .any(|source| matches!(source.operation, wasmparser::Operator::ReturnCall { .. }))
        );
    }
}

#[test]
fn missing_canonical_table_keeps_the_private_fallback_and_prepare_failure_boundary() {
    let input = wat::parse_str(
        r#"(module
      (import "env" "__wasm_dlopen" (func $open (param i32 i64) (result i32)))
      (export "open" (func $open)))"#,
    )
    .unwrap();
    for (backend, bytes) in [("native", native::emit(&input)), ("Walrus", oracle(&input))] {
        let scan = scan(&bytes).unwrap();
        assert_eq!(scan.types.as_ref().table_count(), 1);
        assert!(
            !scan
                .exports
                .iter()
                .any(|(_, kind, _)| *kind == wasmparser::ExternalKind::Table)
        );
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), bytes).unwrap();
        let result = std::process::Command::new("node").arg("-e").arg(r#"
          const assert = require('node:assert/strict'); const calls = [];
          const module = new WebAssembly.Module(require('fs').readFileSync(process.argv[1]));
          const {exports:x} = new WebAssembly.Instance(module, {env:{
            __wasm_dlopen_main:()=>{throw Error('unexpected main');},
            __wasm_dlopen_prepare:(...args)=>{assert.deepEqual(args,[64,32n,0,0n,256]);calls.push('prepare');return 0;},
            __wasm_dlopen_next:token=>{assert.equal(token,0);calls.push('next');return -1;},
            __wasm_dlopen_commit:()=>{throw Error('unexpected commit');}
          }});
          assert.equal(x.open(64,32n),0); assert.deepEqual(calls,['prepare','next']);
        "#).arg(file.path()).output().unwrap();
        assert!(
            result.status.success(),
            "{backend}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
}

#[test]
fn staged_import_reuse_accepts_a_distinct_scalar_function_subtype() {
    let input = wat::parse_str(
        r#"(module
      (type $base (sub (func (param i32) (result i32))))
      (type $child (sub $base (func (param i32) (result i32))))
      (import "env" "__wasm_dlopen_next" (func (type $child)))
      (import "env" "__wasm_dlopen" (func $open (param i32 i32) (result i32)))
      (export "open" (func $open)))"#,
    )
    .unwrap();
    for output in [native::emit(&input), oracle(&input)] {
        let scan = scan(&output).unwrap();
        assert_eq!(
            scan.functions
                .iter()
                .filter(|function| function
                    .import
                    .as_ref()
                    .is_some_and(|(_, name)| name == "__wasm_dlopen_next"))
                .count(),
            1
        );
    }
}

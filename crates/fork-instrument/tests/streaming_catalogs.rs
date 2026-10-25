use fork_instrument::{Options, instrument_walrus as instrument, streaming};
#[path = "support/streaming_gc.rs"]
mod native;
fn oracle(input: &[u8]) -> Vec<u8> {
    instrument(
        input,
        &Options {
            entry_import: "h.fork".into(),
            sinks: false,
            facts: false,
            effective_types: false,
            ..Default::default()
        },
    )
    .unwrap()
}
fn reference_globals(bytes: &[u8]) -> usize {
    wasmparser::Parser::new(0)
        .parse_all(bytes)
        .filter_map(|payload| {
            if let wasmparser::Payload::GlobalSection(section) = payload.unwrap() {
                Some(
                    section
                        .into_iter()
                        .filter(|global| {
                            matches!(
                                global.as_ref().unwrap().ty.content_type,
                                wasmparser::ValType::Ref(_)
                            )
                        })
                        .count(),
                )
            } else {
                None
            }
        })
        .sum()
}
fn section(bytes: &[u8], name: &str) -> Vec<u8> {
    wasmparser::Parser::new(0)
        .parse_all(bytes)
        .find_map(|payload| {
            if let wasmparser::Payload::CustomSection(section) = payload.unwrap() {
                (section.name() == name).then(|| section.data().to_vec())
            } else {
                None
            }
        })
        .unwrap()
}
fn run(input: &[u8], output: &[u8], wide: bool, context: &str, script: &str) {
    let directory = tempfile::tempdir().unwrap();
    for (name, bytes) in [("provider.wasm", output.to_vec()), ("original.wasm", input.to_vec()),
        ("transit.wasm", wat::parse_str("(module (table (export \"transit\") 128 anyref))").unwrap()),
        ("imported.wasm", wat::parse_str("(module (type $pair (struct (field i32))) (global (export \"root\") (ref $pair) (struct.new $pair (i32.const 41))))").unwrap())] {
        std::fs::write(directory.path().join(name), bytes).unwrap();
    }
    for (name, source) in [
        ("test.mjs", script),
        (
            "gc_recipe_host.mjs",
            include_str!("fixtures/gc_recipe_host.mjs"),
        ),
        (
            "exception_recipe_host.cjs",
            include_str!("fixtures/exception_recipe_host.cjs"),
        ),
        (
            "table_record_host.cjs",
            include_str!("fixtures/table_record_host.cjs"),
        ),
        (
            "activation_frame_host.cjs",
            include_str!("fixtures/activation_frame_host.cjs"),
        ),
    ] {
        std::fs::write(directory.path().join(name), source).unwrap();
    }
    let scan = streaming::scan(input).unwrap();
    let exports = scan
        .exports
        .iter()
        .filter(|(_, kind, _)| *kind == wasmparser::ExternalKind::Func)
        .map(|(name, _, index)| format!("{index}\t{name}\n"))
        .collect::<String>();
    std::fs::write(directory.path().join("exports.tsv"), exports).unwrap();
    let result = std::process::Command::new("node")
        .arg(directory.path().join("test.mjs"))
        .arg(if wide { "1" } else { "0" })
        .arg(scan.functions.len().to_string())
        .arg(context)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{context}, memory64={wide}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
}
#[test]
fn original_function_resume_and_static_roots_preserve_fresh_identity_through_real_replay() {
    for wide in [false, true] {
        let input = wat::parse_str(
            include_str!("fixtures/streaming_catalogs.wat")
                .replace("@WIDTH@", if wide { "i64" } else { "" })
                .replace("@POINTER@", if wide { "i64" } else { "i32" }),
        )
        .unwrap();
        let oracle = oracle(&input);
        for shared in [false, true] {
            let output = native::emit_activations(&input, shared);
            assert_eq!(native::emit_activations(&input, shared), output);
            assert_eq!(
                reference_globals(&output),
                reference_globals(&input),
                "harvest must not hoist allocations into private reference globals"
            );
            for name in [
                "kandelo.wpk_fork.static_root_catalog",
                "kandelo.wpk_fork.resume_catalog",
            ] {
                assert_eq!(section(&output, name), section(&oracle, name));
            }
            run(
                &input,
                &output,
                wide,
                "native",
                include_str!("fixtures/streaming_catalogs.mjs"),
            );
        }
        run(
            &input,
            &oracle,
            wide,
            "Walrus",
            include_str!("fixtures/streaming_catalogs.mjs"),
        );
    }
}
#[test]
fn declared_allocating_elements_have_no_post_instantiation_identity_to_harvest() {
    let input = wat::parse_str(
        r#"(module
      (type $pair (struct (field i32)))
      (import "h" "fork" (func $fork (param i32) (result i32)))
      (memory 4)
      (elem declare (ref $pair) (struct.new $pair (i32.const 88)))
      (func (export "checkpoint") (result i32) i32.const 3 call $fork))"#,
    )
    .unwrap();
    for (backend, output) in [
        ("native", native::emit_activations(&input, true)),
        ("Walrus", oracle(&input)),
    ] {
        run(
            &input,
            &output,
            false,
            backend,
            include_str!("fixtures/streaming_catalogs_declared.mjs"),
        );
    }
}

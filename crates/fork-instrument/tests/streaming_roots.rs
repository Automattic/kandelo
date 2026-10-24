use fork_instrument::{module_exception_codec, module_gc_codec, module_state, runtime};

#[path = "support/streaming_gc.rs"]
mod native;

fn input(wide: bool) -> Vec<u8> {
    let extras: String = (0..34)
        .map(|index| format!("(data $spare{index} \"x\")\n"))
        .collect();
    wat::parse_str(
        include_str!("fixtures/streaming_roots.wat")
            .replace("@WIDTH@", if wide { "i64" } else { "" })
            .replace("@POINTER@", if wide { "i64" } else { "i32" })
            .replace("@EXTRA_DATA@", &extras),
    )
    .unwrap()
}
fn oracle(input: &[u8]) -> Vec<u8> {
    let mut module = walrus::Module::from_buffer(input).unwrap();
    let state = module_state::plan(&mut module);
    let memory = module.memories.iter().next().unwrap().id();
    let gc = module_gc_codec::declare(&mut module, memory).unwrap();
    let exn = module_exception_codec::inject_with_reference_overrides(
        &mut module,
        memory,
        Some((gc.encode_externref, gc.decode_externref)),
        Some((gc.encode_anyref, gc.decode_anyref)),
    )
    .unwrap();
    let runtime = runtime::inject_linked_runtime_with_reference_overrides(
        &mut module,
        runtime::ReferenceCodecOverrides {
            anyref: Some((gc.encode_anyref, gc.decode_anyref)),
            externref: Some((gc.encode_externref, gc.decode_externref)),
            exnref: Some((exn.encode, exn.decode)),
            cleanup: Some(exn.clear),
            ..Default::default()
        },
    );
    module_gc_codec::finish_declaration(&mut module, gc, exn, &runtime).unwrap();
    module_state::inject(&mut module, &runtime, state).unwrap();
    for (alias, original) in [
        ("save_roots", "wpk_fork_module_state_save"),
        ("restore_roots", "wpk_fork_module_state_restore"),
        ("finish_roots", "wpk_fork_module_state_finish_restore"),
    ] {
        let function = module
            .exports
            .iter()
            .find(|export| export.name == original)
            .unwrap()
            .item;
        module.exports.add(alias, function);
    }
    module.emit_wasm()
}
#[test]
fn fresh_instances_restore_typed_roots_and_original_segment_lifetimes() {
    for wide in [false, true] {
        let input = input(wide);
        let output = native::emit_roots(&input);
        assert_eq!(native::emit_roots(&input), output);
        let oracle = oracle(&input);
        let section = wasm_posix_shared::abi::WPK_FORK_IMPORTED_GLOBALS_SECTION;
        let descriptor = |bytes: &[u8]| {
            wasmparser::Parser::new(0)
                .parse_all(bytes)
                .find_map(|payload| {
                    if let wasmparser::Payload::CustomSection(custom) = payload.unwrap() {
                        (custom.name() == section).then(|| custom.data().to_vec())
                    } else {
                        None
                    }
                })
                .unwrap()
        };
        assert_eq!(
            descriptor(&output),
            descriptor(&oracle),
            "original imported global declarations"
        );
        for (backend, output) in [("native", output), ("Walrus", oracle)] {
            let directory = tempfile::tempdir().unwrap();
            std::fs::write(directory.path().join("provider.wasm"), output).unwrap();
            std::fs::write(
                directory.path().join("transit.wasm"),
                wat::parse_str("(module (table (export \"transit\") 64 anyref))").unwrap(),
            )
            .unwrap();
            for (name, source) in [
                ("test.mjs", include_str!("fixtures/streaming_roots.mjs")),
                (
                    "gc_recipe_host.mjs",
                    include_str!("fixtures/gc_recipe_host.mjs"),
                ),
                (
                    "exception_recipe_host.cjs",
                    include_str!("fixtures/exception_recipe_host.cjs"),
                ),
                (
                    "root_record_host.cjs",
                    include_str!("fixtures/root_record_host.cjs"),
                ),
            ] {
                std::fs::write(directory.path().join(name), source).unwrap();
            }
            let result = std::process::Command::new("node")
                .arg(directory.path().join("test.mjs"))
                .arg(if wide { "wide" } else { "narrow" })
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{backend}, memory64={wide}: {}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
    }
}

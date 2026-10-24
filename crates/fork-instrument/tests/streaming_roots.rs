#[path = "support/module_state_oracle.rs"]
mod oracle;

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

#[test]
fn fresh_instances_restore_typed_roots_and_original_segment_lifetimes() {
    for wide in [false, true] {
        let input = input(wide);
        let output = native::emit_roots(&input);
        assert_eq!(native::emit_roots(&input), output);
        let oracle = oracle::emit(&input);
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

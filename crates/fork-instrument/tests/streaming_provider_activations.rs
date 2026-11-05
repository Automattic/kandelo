#[path = "support/streaming_gc.rs"]
mod native;
#[test]
fn real_providers_compose_with_activation_catches_globals_tables_and_fresh_replay() {
    run_fixture(include_str!("fixtures/streaming_provider_activation.wat"));
}
#[test]
fn legacy_handlers_rethrow_their_owned_exception_after_fresh_replay_and_live_abort() {
    run_fixture(include_str!(
        "fixtures/streaming_legacy_provider_activation.wat"
    ));
}
fn run_fixture(fixture: &str) {
    for wide in [false, true] {
        for scratch in [false, true] {
            let input = wat::parse_str(
                fixture
                    .replace("@WIDTH@", if wide { "i64" } else { "" })
                    .replace("@POINTER@", if wide { "i64" } else { "i32" })
                    .replace(
                        "@WIDE_PARAMETERS@",
                        &if scratch {
                            vec!["i64"; 40].join(" ")
                        } else {
                            String::new()
                        },
                    )
                    .replace(
                        "@WIDE_ARGUMENTS@",
                        &if scratch {
                            vec!["global.get $operand"; 40].join("\n")
                        } else {
                            String::new()
                        },
                    ),
            )
            .unwrap();
            for shared in [false, true] {
                let output = native::emit_activations(&input, shared);
                assert_eq!(native::emit_activations(&input, shared), output);
                replay(
                    &output,
                    wide,
                    scratch,
                    &format!("native, shared_codecs={shared}"),
                );
            }
        }
    }
}
fn replay(output: &[u8], wide: bool, scratch: bool, context: &str) {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("provider.wasm"), output).unwrap();
    std::fs::write(
        directory.path().join("transit.wasm"),
        wat::parse_str("(module (table (export \"transit\") 128 anyref))").unwrap(),
    )
    .unwrap();
    for (name, source) in [
        (
            "test.mjs",
            include_str!("fixtures/streaming_provider_activation.mjs"),
        ),
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
    let result = std::process::Command::new("node")
        .arg(directory.path().join("test.mjs"))
        .args([wide, scratch].map(|value| if value { "1" } else { "0" }))
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{context}, memory64={wide}, scratch={scratch}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
}

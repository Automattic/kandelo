#[path = "support/streaming_activation.rs"]
mod harness;

#[test]
fn nested_reentry_preserves_live_exception_aliases_and_replays_each_capture() {
    for wide in [false, true] {
        for (outer_tagged, inner_tagged) in
            [(false, false), (false, true), (true, false), (true, true)]
        {
            let mut source = include_str!("fixtures/streaming_catch_reentry_aliases.wat")
                .replace("@MEMORY_TYPE@", if wide { "i64" } else { "" })
                .replace("@POINTER@", if wide { "i64" } else { "i32" });
            for (region, tagged) in [("OUTER", outer_tagged), ("INNER", inner_tagged)] {
                source = source
                    .replace(
                        &format!("@{region}_RESULTS@"),
                        if tagged {
                            "(result v128 externref (ref exn))"
                        } else {
                            "(result (ref exn))"
                        },
                    )
                    .replace(
                        &format!("@{region}_CLAUSE@"),
                        &if tagged {
                            format!("catch_ref ${}", region.to_lowercase())
                        } else {
                            "catch_all_ref".into()
                        },
                    )
                    .replace(
                        &format!("@{region}_DROP_PAYLOAD@"),
                        if tagged { "drop drop" } else { "" },
                    );
            }
            let input = wat::parse_str(source).unwrap();
            for shared in [false, true] {
                let output = harness::emit_catch_fixture(&input, 3, shared, true).0;
                let directory = tempfile::tempdir().unwrap();
                let wasm = directory.path().join("fixture.wasm");
                let script = directory.path().join("test.cjs");
                std::fs::write(&wasm, output).unwrap();
                std::fs::write(
                    &script,
                    include_str!("fixtures/streaming_catch_reentry_aliases.cjs"),
                )
                .unwrap();
                std::fs::write(
                    directory.path().join("exception_recipe_host.cjs"),
                    include_str!("fixtures/exception_recipe_host.cjs"),
                )
                .unwrap();
                let result = std::process::Command::new("node")
                    .arg(&script)
                    .arg(&wasm)
                    .arg(if wide { "1" } else { "0" })
                    .output()
                    .unwrap();
                assert!(
                    result.status.success(),
                    "memory64={wide}, outer_tagged={outer_tagged}, inner_tagged={inner_tagged}, shared={shared}: {}",
                    String::from_utf8_lossy(&result.stderr)
                );
            }
        }
    }
}

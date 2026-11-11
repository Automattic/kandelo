#[path = "support/streaming_activation.rs"]
mod harness;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ForkPlacement {
    InsideTry,
    AfterHandler,
}

fn fixture(
    wide: bool,
    catch_ref: bool,
    typed: bool,
    placement: ForkPlacement,
    nested: bool,
) -> Vec<u8> {
    let inside = placement == ForkPlacement::InsideTry;
    let fork = "i32.const 3 call $fork local.set $fork_result";
    let source = include_str!("fixtures/streaming_catches.wat")
        .replace("@MEMORY_TYPE@", if wide { "i64" } else { "" })
        .replace("@POINTER@", if wide { "i64" } else { "i32" })
        .replace("@CATCH@", if catch_ref { "catch_ref" } else { "catch" })
        .replace(
            "@EXCEPTION_RESULT@",
            if catch_ref { "(ref exn)" } else { "" },
        )
        .replace("@DROP_EXCEPTION@", if catch_ref { "drop" } else { "" })
        .replace(
            "@TRY_ARGUMENTS@",
            if typed {
                "i64.const 77 local.get $mode"
            } else {
                ""
            },
        )
        .replace(
            "@TRY_PARAMETERS@",
            if typed { "(param i64 i32)" } else { "" },
        )
        .replace(
            "@DROP_TRY_PARAMETERS@",
            if typed { "drop drop" } else { "" },
        )
        .replace("@INSIDE_FORK@", if inside { fork } else { "" })
        .replace("@AFTER_FORK@", if inside { "" } else { fork })
        .replace(
            "@NESTED_TRY@",
            if nested {
                "block $nested_handler try_table (catch $nested $nested_handler) nop end end"
            } else {
                ""
            },
        );
    wat::parse_str(source).unwrap()
}

fn artifact(input: &[u8], shared: bool) -> (Vec<u8>, u32) {
    harness::emit_catch_fixture(input, 1, shared, false)
}

fn assert_replay(output: &[u8], offset: u32, wide: bool, placement: ForkPlacement, context: &str) {
    let file = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(file.path(), output).unwrap();
    let result = std::process::Command::new("node")
        .arg("-e")
        .arg(include_str!("fixtures/streaming_catch_replay.cjs"))
        .arg(file.path())
        .arg(if wide { "1" } else { "0" })
        .arg(offset.to_string())
        .arg(if placement == ForkPlacement::InsideTry {
            "1"
        } else {
            "0"
        })
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{context}, memory64={wide}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn native_scalar_catches_capture_and_replay_with_exact_arm_and_payload() {
    for wide in [false, true] {
        for catch_ref in [false, true] {
            for typed in [false, true] {
                for placement in [ForkPlacement::InsideTry, ForkPlacement::AfterHandler] {
                    for nested in [false, true] {
                        let input = fixture(wide, catch_ref, typed, placement, nested);
                        for shared in [false, true] {
                            let (output, offset) = artifact(&input, shared);
                            assert_eq!(artifact(&input, shared).0, output);
                            assert_replay(
                                &output,
                                offset,
                                wide,
                                placement,
                                &format!(
                                    "native, catch_ref={catch_ref}, typed={typed}, {placement:?}, nested={nested}, shared={shared}"
                                ),
                            );
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn reentering_a_try_retires_the_previous_iterations_catch() {
    for wide in [false, true] {
        for (kind, result, handle, recipes) in [
            ("catch $jump $handler", "(result i32)", "", false),
            (
                "catch_ref $jump $handler",
                "(result i32 (ref exn))",
                "drop",
                false,
            ),
            ("catch_all $handler", "", "i32.const 99", true),
            (
                "catch_all_ref $handler",
                "(result (ref exn))",
                "drop i32.const 99",
                true,
            ),
        ] {
            let source = include_str!("fixtures/streaming_catch_loop.wat")
                .replace("@MEMORY_TYPE@", if wide { "i64" } else { "" })
                .replace("@POINTER@", if wide { "i64" } else { "i32" })
                .replace("@CATCH_CLAUSE@", kind)
                .replace("@HANDLER_RESULT@", result)
                .replace("@HANDLE_EXCEPTION@", handle);
            let input = wat::parse_str(source).unwrap();
            for shared in [false, true] {
                let (output, _) = harness::emit_catch_fixture(&input, 1, shared, recipes);
                let file = tempfile::NamedTempFile::new().unwrap();
                std::fs::write(file.path(), output).unwrap();
                let result = std::process::Command::new("node")
                    .arg("-e")
                    .arg(include_str!("fixtures/streaming_catch_loop_replay.cjs"))
                    .arg(file.path())
                    .arg(if wide { "1" } else { "0" })
                    .output()
                    .unwrap();
                assert!(
                    result.status.success(),
                    "memory64={wide}, {kind}, shared={shared}: {}",
                    String::from_utf8_lossy(&result.stderr)
                );
            }
        }
    }
}

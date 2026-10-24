use fork_instrument::streaming::*;

#[path = "support/streaming_activation.rs"]
mod harness;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ForkPlacement {
    InsideTry,
    AfterHandler,
}

fn fixture(wide: bool, catch_ref: bool, typed: bool, placement: ForkPlacement) -> Vec<u8> {
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
        .replace("@AFTER_FORK@", if inside { "" } else { fork });
    wat::parse_str(source).unwrap()
}

fn artifact(input: &[u8], shared: bool) -> (Vec<u8>, u32) {
    harness::emit_catch_fixture(input, 1, shared, false)
}

fn oracle_artifact(input: &[u8]) -> Vec<u8> {
    use fork_instrument::{call_graph, instrument, runtime};
    let mut module = walrus::Module::from_buffer(input).unwrap();
    let seed = call_graph::find_import_func(&module, "h.fork").unwrap();
    let reaching = call_graph::analyze_reaching_closure(&module, seed);
    let targets: Vec<_> = reaching.activations.iter().copied().collect();
    let catches = instrument::plan_plain_catches(&module, &targets);
    let runtime = runtime::inject_linked_runtime(&mut module);
    instrument::instrument_functions_with_targets_and_tail_sites(
        &mut module,
        &runtime,
        &reaching.activations,
        &reaching.control_reachable,
        &reaching.tail_call_landings,
        &catches,
        None,
        &Default::default(),
    );
    module
        .exports
        .add("unwind_tag", runtime.unwind_tag.unwrap());
    let resume = module
        .funcs
        .iter()
        .find(|function| function.name.as_deref() == Some("__wpk_fork_resume_0"))
        .unwrap()
        .id();
    module.exports.add("resume_root", resume);
    module.emit_wasm()
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
                    let input = fixture(wide, catch_ref, typed, placement);
                    let offset = artifact(&input, true).1;
                    if !typed {
                        // The unchanged oracle loses try input parameters in
                        // its catch wrappers. Typed cases below are validated
                        // and executed directly instead of weakening them to
                        // match that existing invalid output.
                        assert_replay(
                            &oracle_artifact(&input),
                            offset,
                            wide,
                            placement,
                            &format!("Walrus, catch_ref={catch_ref}, {placement:?}"),
                        );
                    }
                    for shared in [false, true] {
                        let (output, offset) = artifact(&input, shared);
                        assert_eq!(artifact(&input, shared).0, output);
                        assert_replay(
                            &output,
                            offset,
                            wide,
                            placement,
                            &format!(
                                "native, catch_ref={catch_ref}, typed={typed}, {placement:?}, shared={shared}"
                            ),
                        );
                    }
                }
            }
        }
    }
}

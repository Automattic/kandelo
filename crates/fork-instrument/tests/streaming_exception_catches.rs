use fork_instrument::{call_graph, instrument, module_exception_codec, runtime};

#[path = "support/streaming_activation.rs"]
mod harness;

#[derive(Clone, Copy, Debug)]
enum CatchKind {
    Tagged,
    TaggedRef,
    All,
    AllRef,
}
impl CatchKind {
    fn name(self) -> &'static str {
        match self {
            Self::Tagged => "tagged",
            Self::TaggedRef => "tagged_ref",
            Self::All => "all",
            Self::AllRef => "all_ref",
        }
    }
}

fn fixture(wide: bool, kind: CatchKind, scratch: bool) -> Vec<u8> {
    let reference_read = r#"
      local.get $mode i32.const 3 i32.eq
      if local.get $exception ref.as_non_null throw_ref end
      block $unpack (result v128 externref)
        try_table (catch $payload $unpack)
          local.get $exception ref.as_non_null throw_ref
        end
        unreachable
      end
      local.set $object local.set $vector
      local.get $vector i32x4.extract_lane 0
      local.get $object call $check i32.add"#;
    let (clause, results, capture, read) = match kind {
        CatchKind::Tagged => (
            "catch $payload",
            "(result v128 externref)",
            "local.set $object local.set $vector",
            "local.get $vector i32x4.extract_lane 0 local.get $object call $check i32.add",
        ),
        CatchKind::TaggedRef => (
            "catch_ref $payload",
            "(result v128 externref (ref exn))",
            "local.set $exception drop drop",
            reference_read,
        ),
        CatchKind::All => ("catch_all", "", "", "i32.const 42"),
        CatchKind::AllRef => (
            "catch_all_ref",
            "(result (ref exn))",
            "local.set $exception",
            reference_read,
        ),
    };
    let prefix = if scratch {
        (1..=40)
            .map(|value| format!("i64.const {value}\n"))
            .collect::<String>()
    } else {
        String::new()
    };
    let suffix = if scratch {
        format!(
            "local.set $result {} i32.wrap_i64 local.get $result i32.add",
            "i64.add ".repeat(39)
        )
    } else {
        String::new()
    };
    let source = include_str!("fixtures/streaming_exception_catches.wat")
        .replace("@MEMORY_TYPE@", if wide { "i64" } else { "" })
        .replace("@POINTER@", if wide { "i64" } else { "i32" })
        .replace("@CLAUSE@", clause)
        .replace("@HANDLER_RESULTS@", results)
        .replace("@CAPTURE_PAYLOAD@", capture)
        .replace("@READ_PAYLOAD@", read)
        .replace("@CARRY_PREFIX@", &prefix)
        .replace("@CARRY_SUFFIX@", &suffix);
    wat::parse_str(source).unwrap()
}

fn oracle(input: &[u8]) -> Vec<u8> {
    let mut module = walrus::Module::from_buffer(input).unwrap();
    let fork = call_graph::find_import_func(&module, "h.fork").unwrap();
    let reaching = call_graph::analyze_reaching_closure(&module, fork);
    let targets = reaching.activations.iter().copied().collect::<Vec<_>>();
    let catches = instrument::plan_plain_catches(&module, &targets);
    let memory = module.memories.iter().next().unwrap().id();
    let codec = module_exception_codec::inject(&mut module, memory).unwrap();
    let runtime = runtime::inject_linked_runtime_with_reference_overrides(
        &mut module,
        runtime::ReferenceCodecOverrides {
            exnref: Some((codec.encode, codec.decode)),
            cleanup: Some(codec.clear),
            ..Default::default()
        },
    );
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

fn execute(output: &[u8], wide: bool, kind: CatchKind, scratch: bool, backend: &str) {
    let directory = tempfile::tempdir().unwrap();
    let wasm = directory.path().join("fixture.wasm");
    let script = directory.path().join("test.cjs");
    std::fs::write(&wasm, output).unwrap();
    std::fs::write(
        &script,
        include_str!("fixtures/streaming_exception_catch_replay.cjs"),
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
        .arg(kind.name())
        .arg(if scratch { "1" } else { "0" })
        .arg(backend)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{backend}, memory64={wide}, {kind:?}, scratch={scratch}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn complete_exception_recipes_replay_through_native_frames_and_shield_private_unwind() {
    for wide in [false, true] {
        for kind in [
            CatchKind::Tagged,
            CatchKind::TaggedRef,
            CatchKind::All,
            CatchKind::AllRef,
        ] {
            for scratch in [false, true] {
                let input = fixture(wide, kind, scratch);
                for shared in [false, true] {
                    let output = harness::emit_catch_fixture(&input, 4, shared, true).0;
                    assert_eq!(
                        harness::emit_catch_fixture(&input, 4, shared, true).0,
                        output
                    );
                    execute(
                        &output,
                        wide,
                        kind,
                        scratch,
                        if shared {
                            "native shared"
                        } else {
                            "native inline"
                        },
                    );
                }
                execute(&oracle(&input), wide, kind, scratch, "Walrus");
            }
        }
    }
}

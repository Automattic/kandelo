use fork_instrument::{
    Options, PlanSource,
    contract_inventory::{ArtifactAbiVersion, artifact_identity},
    native,
    streaming::*,
};

fn options() -> Options {
    Options {
        sinks: false,
        ..Default::default()
    }
}

#[test]
fn duplicate_entries_and_every_side_module_import_seed_the_closure() {
    let input = wat::parse_str(
        r#"(module
        (import "kernel" "kernel_fork" (func $first (result i32)))
        (import "kernel" "kernel_fork" (func $second (result i32)))
        (import "other" "callback" (func $callback))
        (func $a (result i32) call $first)
        (func $b (result i32) call $second)
        (func $c call $callback))"#,
    )
    .unwrap();
    let main = native::analyze(&input, &options(), Default::default()).unwrap();
    assert_eq!(main.decision.entry_imports, [0, 1]);
    assert!(main.reaching.activations.contains(&3));
    assert!(main.reaching.activations.contains(&4));
    assert!(!main.reaching.activations.contains(&5));
    let side = native::analyze(
        &input,
        &Options {
            entry_import: "env.fork".into(),
            ..options()
        },
        Default::default(),
    )
    .unwrap();
    assert!(side.decision.side_module);
    assert!(side.reaching.activations.contains(&5));
    assert_eq!(side.decision.source, PlanSource::Closure);
}

#[test]
fn loader_only_modules_freeze_the_generated_boundary_and_nonforking_inputs_stay_out() {
    let input = wat::parse_str(
        r#"(module
        (import "env" "__wasm_dlopen" (func $load (param i32 i32) (result i32)))
        (func $root (export "root") (result i32) i32.const 16 i32.const 8 call $load))"#,
    )
    .unwrap();
    let analysis = native::analyze(&input, &Options::default(), Default::default()).unwrap();
    assert!(analysis.decision.participates && analysis.decision.dynamic_linker);
    assert!(analysis.reaching.control_reachable.contains(&0));
    let (mut pipeline, _) = analysis.freeze(Default::default()).unwrap();
    let mut output = Vec::new();
    pipeline.emit(&mut output).unwrap();
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    let plain = wat::parse_str("(module (func))").unwrap();
    let analysis = native::analyze(&plain, &Options::default(), Default::default()).unwrap();
    assert!(!analysis.decision.participates);
    assert!(analysis.freeze(Default::default()).is_err());
}

#[test]
fn side_modules_get_exact_current_abi_identity_and_reject_stale_markers() {
    let current = wasm_posix_program_abi::ABI_VERSION;
    for version in [None, Some(current), Some(current - 1)] {
        let marker = version
            .map(|version| {
                format!("(func (export \"__abi_version\") (result i32) i32.const {version})")
            })
            .unwrap_or_default();
        let input = wat::parse_str(format!(
            "(module (import \"other\" \"callback\" (func)) {marker})"
        ))
        .unwrap();
        let analysis = native::analyze(
            &input,
            &Options {
                entry_import: "env.fork".into(),
                ..options()
            },
            Default::default(),
        )
        .unwrap();
        let result = analysis.freeze(Default::default());
        if version.is_some_and(|version| version != current) {
            assert!(
                result
                    .err()
                    .unwrap()
                    .to_string()
                    .contains("stale __abi_version")
            );
        } else {
            let (mut pipeline, _) = result.unwrap();
            let mut output = Vec::new();
            pipeline.emit(&mut output).unwrap();
            wasmparser::Validator::new_with_features(features())
                .validate_all(&output)
                .unwrap();
            assert_eq!(
                artifact_identity(&output).unwrap().abi_version,
                ArtifactAbiVersion::Present(current)
            );
        }
    }
}

#[test]
fn partial_runtime_inputs_and_already_rewritten_modules_cannot_be_restamped() {
    for source in [
        "(module (func (export \"wpk_fork_state\") (result i32) i32.const 0))",
        "(module (type (func)) (import \"env\" \"__wpk_fork_unwind\" (tag (type 0))))",
        "(module (import \"env\" \"__wpk_fork_frame_commit\" (func (param i32))))",
    ] {
        let input = wat::parse_str(source).unwrap();
        assert!(native::analyze(&input, &Options::default(), Default::default()).is_err());
    }
    let input = wat::parse_str("(module (import \"kernel\" \"kernel_fork\" (func)))").unwrap();
    let (mut pipeline, _) = native::analyze(&input, &options(), Default::default())
        .unwrap()
        .freeze(Default::default())
        .unwrap();
    let mut output = Vec::new();
    pipeline.emit(&mut output).unwrap();
    assert!(native::analyze(&output, &options(), Default::default()).is_err());
}

#[test]
fn entry_selection_and_sink_work_fail_at_explicit_limits() {
    let input = wat::parse_str("(module (func))").unwrap();
    let mut limits = native::AnalysisLimits::default();
    limits.program.metadata_bytes = 0;
    assert!(native::analyze(&input, &Options::default(), limits).is_err());
    let input = wat::parse_str("(module (import \"kernel\" \"kernel_fork\" (func $fork (result i32))) (func $root (result i32) call $fork))").unwrap();
    let mut limits = native::AnalysisLimits::default();
    limits.sinks.work = 0;
    assert!(native::analyze(&input, &Options::default(), limits).is_err());
}

#[test]
fn sink_refinement_preserves_tail_paths_after_pruning_ordinary_calls() {
    for tail in [
        "return_call $fork",
        "i32.const 0 return_call_indirect (type $result)",
        "ref.func $fork return_call_ref $result",
    ] {
        let input = wat::parse_str(format!(
            r#"(module
            (type $result (func (result i32)))
            (import "kernel" "kernel_fork" (func $seed (param i32) (result i32)))
            (memory 2 16)
            (global (export "__stack_pointer") (mut i32) (i32.const 65536))
            (table 1 funcref) (elem (i32.const 0) $fork)
            (func $dead (result i32)
                i32.const 0 if i32.const 0 call $seed drop end i32.const 0)
            (func $fork (type $result) i32.const 0 call $seed)
            (func $root (export "root") (result i32) call $dead drop {tail}))"#
        ))
        .unwrap();
        let output = fork_instrument::instrument(&input, &Options::default()).unwrap();
        wasmparser::Validator::new_with_features(features())
            .validate_all(&output)
            .unwrap();
        let analysis = native::analyze(&input, &Options::default(), Default::default()).unwrap();
        assert_eq!(analysis.decision.source, PlanSource::Builtin);
        assert!(!analysis.reaching.control_reachable.contains(&1));
        assert!(analysis.reaching.control_reachable.contains(&3));
        assert!(!analysis.reaching.activations.contains(&3));
        assert!(
            analysis
                .reaching
                .tail_sites
                .iter()
                .any(|point| point.function == 3)
        );
    }
}

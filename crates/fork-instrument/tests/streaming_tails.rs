use fork_instrument::streaming::*;
use std::collections::{BTreeMap, BTreeSet};
use wasm_encoder::{ExportKind, ValType, reencode::Reencode};

#[path = "support/streaming_activation.rs"]
mod harness;
use harness::ActivationModule;

fn fixture(wide: bool) -> Vec<u8> {
    let source = include_str!("fixtures/streaming_tails.wat")
        .replace("@MEMORY_TYPE@", if wide { "i64" } else { "" })
        .replace("@POINTER@", if wide { "i64" } else { "i32" })
        .replace("@WIDE_PARAMETERS@", &vec!["i64"; 40].join(" "))
        .replace(
            "@WIDE_ARGUMENTS@",
            &vec!["global.get $operand"; 40].join("\n"),
        );
    wat::parse_str(source).unwrap()
}

fn artifact(wide: bool) -> Vec<u8> {
    let input = fixture(wide);
    let scan = scan(&input).unwrap();
    let types = SourceTypes::new(&scan);
    let reaching = scan.reaching_from_seeds([0], false).unwrap();
    assert_eq!(reaching.activations, BTreeSet::from([0, 1, 5, 6, 7]));
    assert_eq!(reaching.tail_sites.len(), 5);
    let mut runtime = NativeRuntime::plan(&scan, Default::default(), 1 << 20).unwrap();
    let environment = FrameEnvironment::discover(&scan, &mut runtime, 1 << 20).unwrap();
    let first_type = scan.types.as_ref().core_type_count_in_module()
        + runtime.function_declarations().type_count();
    let first_function = runtime.imports_plan().helper_function_base() + 7;
    let mut support = ActivationSupportCatalog::new(
        environment,
        runtime.indices(),
        runtime.frames_start_offset(),
        first_type,
        first_function,
        1 << 20,
    )
    .unwrap();
    let frame_select = support.frame_select();
    let mut routes = Vec::new();
    // Ordinary calls into transparent tail chains must consult the next
    // journal activation, which can differ from their lexical target.
    for source in [0, 2, 3, 4] {
        let final_function = runtime.function_index(source).unwrap();
        let helper = support
            .transport(
                ActivationCallTarget::Direct(final_function),
                &[ValType::I32],
                &[ValType::I32],
            )
            .unwrap();
        routes.push((ReferenceCallKind::Direct(source), helper));
    }

    let mut plans = BTreeMap::new();
    let mut tails = BTreeMap::new();
    let mut emission = BTreeMap::new();
    let mut thunks = Vec::new();
    let mut bodies = scan.body_provider(Default::default());
    for function in 1..scan.functions.len() as u32 {
        let body = bodies.load(function).unwrap();
        let tail_plan = TailTransferPlan::plan(
            &scan,
            &body,
            &types,
            &mut runtime,
            &reaching.tail_sites,
            &mut support,
            Default::default(),
        )
        .unwrap();
        if reaching.activations.contains(&function) {
            let mut plan = NativeActivationPlan::plan(
                &scan,
                &body,
                &types,
                &mut runtime,
                environment,
                &reaching.control_reachable,
                Default::default(),
            )
            .unwrap();
            plan.bind_tail_transfers(tail_plan).unwrap();
            if function == 6 {
                assert!(plan.continuation.frame.scratch.is_some());
            }
            let parameter_count = scan
                .types
                .as_ref()
                .get(scan.types.as_ref().core_type_at_in_module(body.type_index))
                .unwrap()
                .composite_type
                .unwrap_func()
                .params()
                .len();
            let parameters = body.locals[..parameter_count]
                .iter()
                .map(|&ty| types.value_type(&mut runtime, ty))
                .collect::<anyhow::Result<Vec<_>>>()
                .unwrap();
            thunks.push(
                support
                    .resume_thunk(
                        runtime.function_index(function).unwrap(),
                        &parameters,
                        &plan.results,
                        &plan.continuation.frame,
                    )
                    .unwrap(),
            );
            emission.insert(
                function,
                ActivationEmission {
                    runtime: runtime.indices(),
                    frame_select,
                    function_ordinal: plans.len() as u32,
                    result_block: support.result_block(&plan.results).unwrap(),
                    scalar_codecs: None,
                    boundary: None,
                },
            );
            plans.insert(function, plan);
        } else {
            tails.insert(function, tail_plan);
        }
    }
    let support = support.freeze().unwrap();
    let codecs = FrameCodecCatalog::new(
        environment,
        runtime.indices(),
        first_type + support.declarations().type_count(),
        first_function + support.declarations().function_count(),
        1 << 20,
    )
    .unwrap()
    .freeze()
    .unwrap();
    let declarations = FrozenDeclarations::concatenate(
        &[
            runtime.function_declarations(),
            support.declarations(),
            codecs.declarations(),
        ],
        1 << 20,
    )
    .unwrap();
    let mut module = ModuleDeclarationBuilder::from_frozen(
        &scan,
        Some(runtime.imports_plan()),
        runtime.local_declarations().clone(),
        1 << 20,
    )
    .unwrap();
    module
        .export("unwind_tag", ExportKind::Tag, runtime.indices().unwind_tag)
        .unwrap();
    for (name, thunk) in [("resume_child", thunks[0]), ("resume_root", thunks[1])] {
        module.export(name, ExportKind::Func, thunk).unwrap();
    }
    let direct_tail = runtime.function_index(2).unwrap();
    let mut transform = ActivationModule {
        runtime,
        exceptions: None,
        support,
        codecs,
        declarations,
        module: module.freeze(),
        plans,
        emission,
        routes,
        tails,
    };
    let mut output = Vec::new();
    emit_remapped(&scan, &mut transform, &mut output, Default::default()).unwrap();
    let emitted = fork_instrument::streaming::scan(&output).unwrap();
    let direct = emitted
        .body_provider(Default::default())
        .load(direct_tail)
        .unwrap();
    assert!(
        direct
            .instructions
            .iter()
            .any(|source| matches!(source.operation,
        wasmparser::Operator::ReturnCall { function_index } if function_index == direct_tail))
    );
    output
}

fn oracle_artifact(wide: bool) -> Vec<u8> {
    use fork_instrument::{call_graph, instrument, runtime};
    let mut module = walrus::Module::from_buffer(&fixture(wide)).unwrap();
    let seed = call_graph::find_import_func(&module, "h.fork").unwrap();
    let reaching = call_graph::analyze_reaching_closure(&module, seed);
    let targets: Vec<_> = reaching.activations.iter().copied().collect();
    let catch_plan = instrument::plan_plain_catches(&module, &targets);
    let runtime = runtime::inject_linked_runtime(&mut module);
    instrument::instrument_functions_with_targets_and_tail_sites(
        &mut module,
        &runtime,
        &reaching.activations,
        &reaching.control_reachable,
        &reaching.tail_call_landings,
        &catch_plan,
        None,
        &Default::default(),
    );
    module
        .exports
        .add("unwind_tag", runtime.unwind_tag.unwrap());
    for (export, ordinal) in [("resume_child", 0), ("resume_root", 1)] {
        let name = format!("__wpk_fork_resume_{ordinal}");
        let thunk = module
            .funcs
            .iter()
            .find(|function| function.name.as_deref() == Some(&name))
            .unwrap()
            .id();
        module.exports.add(export, thunk);
    }
    module.emit_wasm()
}

#[test]
fn native_tail_chains_preserve_replay_routing_and_release_virtual_spills() {
    for wide in [false, true] {
        let output = artifact(wide);
        assert_eq!(artifact(wide), output);
        for (backend, output) in [("native", output), ("walrus", oracle_artifact(wide))] {
            let file = tempfile::NamedTempFile::new().unwrap();
            std::fs::write(file.path(), output).unwrap();
            let result = std::process::Command::new("node")
                .arg("-e")
                .arg(include_str!("fixtures/streaming_tail_replay.cjs"))
                .arg(file.path())
                .arg(if wide { "1" } else { "0" })
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

#[test]
fn tail_plans_reject_stale_points_mismatched_bodies_and_resource_exhaustion() {
    let input = fixture(false);
    let scan = scan(&input).unwrap();
    let types = SourceTypes::new(&scan);
    let body = scan.body_provider(Default::default()).load(3).unwrap();
    let reaching = scan.reaching_from_seeds([0], false).unwrap();
    let mut runtime = NativeRuntime::plan(&scan, Default::default(), 1 << 20).unwrap();
    let environment = FrameEnvironment::discover(&scan, &mut runtime, 1 << 20).unwrap();
    let mut support = ActivationSupportCatalog::new(
        environment,
        runtime.indices(),
        runtime.frames_start_offset(),
        scan.types.as_ref().core_type_count_in_module()
            + runtime.function_declarations().type_count(),
        runtime.imports_plan().helper_function_base() + 7,
        1 << 20,
    )
    .unwrap();
    assert!(
        TailTransferPlan::plan(
            &scan,
            &body,
            &types,
            &mut runtime,
            &reaching.tail_sites,
            &mut support,
            TailLimits {
                metadata_bytes: 0,
                ..Default::default()
            },
        )
        .is_err()
    );
    let wrong_points = [
        body.instructions[0].point,
        ProgramPoint {
            function: body.function,
            offset: usize::MAX,
        },
    ];
    for point in wrong_points {
        assert!(
            TailTransferPlan::plan(
                &scan,
                &body,
                &types,
                &mut runtime,
                &BTreeSet::from([point]),
                &mut support,
                Default::default(),
            )
            .is_err()
        );
    }
    assert!(
        TailTransferPlan::plan(
            &scan,
            &body,
            &types,
            &mut runtime,
            &reaching.tail_sites,
            &mut support,
            TailLimits {
                work: 0,
                ..Default::default()
            },
        )
        .is_err()
    );
    let plan = TailTransferPlan::plan(
        &scan,
        &body,
        &types,
        &mut runtime,
        &reaching.tail_sites,
        &mut support,
        Default::default(),
    )
    .unwrap();
    assert!(plan.emit_function(&body, &mut runtime, 1).is_err());
    let selected = *reaching
        .tail_sites
        .iter()
        .find(|point| point.function == body.function)
        .unwrap();
    assert!(
        plan.rewrite(selected, wasm_encoder::Instruction::Nop)
            .is_err()
    );
    let another = scan.body_provider(Default::default()).load(1).unwrap();
    assert!(plan.emit_function(&another, &mut runtime, 1 << 20).is_err());
    let frozen = support.freeze().unwrap();
    let rebuilt = TailTransferPlan::from_frozen(
        &scan,
        &body,
        &types,
        &mut runtime,
        &reaching.tail_sites,
        &frozen,
        Default::default(),
    )
    .unwrap();
    assert_eq!(
        rebuilt
            .emit_function(&body, &mut runtime, 1 << 20)
            .unwrap()
            .into_raw_body(),
        plan.emit_function(&body, &mut runtime, 1 << 20)
            .unwrap()
            .into_raw_body(),
        "emission-pass rebuilding must use the original frozen helper identities",
    );
    assert!(
        frozen
            .lookup_transport(ActivationCallTarget::Direct(u32::MAX), &[], &[])
            .is_err()
    );
    assert!(
        frozen
            .lookup_transport(
                ActivationCallTarget::Direct(0),
                &vec![ValType::I32; 8192],
                &[]
            )
            .is_err()
    );
    let undiscovered = scan.body_provider(Default::default()).load(4).unwrap();
    assert!(
        TailTransferPlan::from_frozen(
            &scan,
            &undiscovered,
            &types,
            &mut runtime,
            &reaching.tail_sites,
            &frozen,
            Default::default(),
        )
        .is_err(),
        "emission cannot invent the missing reference transport"
    );
}

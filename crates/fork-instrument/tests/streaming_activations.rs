use fork_instrument::streaming::*;
use std::collections::{BTreeMap, BTreeSet};
use wasm_encoder::{ExportKind, ValType, reencode::Reencode};

#[path = "support/streaming_activation.rs"]
mod harness;
use harness::ActivationModule;

fn artifact(wide: bool, shared: bool) -> (Vec<u8>, Vec<u32>) {
    let pointer = if wide { "i64" } else { "i32" };
    let memory = if wide { "i64" } else { "" };
    let input = wat::parse_str(format!(
        r#"(module
      (import "h" "fork" (func $fork (param i32) (result i32)))
      (memory (export "memory") {memory} 2)
      (global $__stack_pointer (export "sp") (mut {pointer}) ({pointer}.const 65536))
      (global $counter (export "counter") (mut i32) (i32.const 0))
      (func $child (export "child") (param i32) (result i32)
        local.get 0 if (result i32) i32.const 3 call $fork else i32.const 4 call $fork end local.get 0 i32.add)
      (func $root (export "root") (param i32) (result i32)
        global.get $counter i32.const 1 i32.add global.set $counter
        local.get 0 call $child
        global.get $counter i32.const 1 i32.add global.set $counter
        i32.const 2 call $fork i32.add))"#
    ))
    .unwrap();
    let scan = scan(&input).unwrap();
    let types = SourceTypes::new(&scan);
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
    let transport = support
        .transport(
            ActivationCallTarget::Direct(0),
            &[ValType::I32],
            &[ValType::I32],
        )
        .unwrap();
    assert_eq!(
        transport,
        support
            .transport(
                ActivationCallTarget::Direct(0),
                &[ValType::I32],
                &[ValType::I32]
            )
            .unwrap()
    );
    let mut plans = BTreeMap::new();
    let mut blocks = BTreeMap::new();
    let mut thunks = Vec::new();
    for function in [1, 2] {
        let body = scan
            .body_provider(Default::default())
            .load(function)
            .unwrap();
        let plan = NativeActivationPlan::plan(
            &scan,
            &body,
            &types,
            &mut runtime,
            environment,
            &BTreeSet::from([0, 1]),
            Default::default(),
        )
        .unwrap();
        blocks.insert(function, support.result_block(&plan.results).unwrap());
        thunks.push(
            support
                .resume_thunk(
                    runtime.function_index(function).unwrap(),
                    &[ValType::I32],
                    &plan.results,
                    &plan.continuation.frame,
                )
                .unwrap(),
        );
        plans.insert(function, plan);
    }
    let support = support.freeze().unwrap();
    let mut codecs = FrameCodecCatalog::new(
        environment,
        runtime.indices(),
        first_type + support.declarations().type_count(),
        first_function + support.declarations().function_count(),
        1 << 20,
    )
    .unwrap();
    let mut emission = BTreeMap::new();
    let mut sizes = Vec::new();
    for (&function, plan) in &plans {
        let shape = plan
            .continuation
            .frame
            .codec_shape(false, &plan.continuation.references)
            .unwrap();
        let pair = codecs.request(&shape).unwrap();
        emission.insert(
            function,
            ActivationEmission {
                runtime: runtime.indices(),
                frame_select,
                function_ordinal: function,
                result_block: blocks[&function],
                scalar_codecs: shared.then_some(pair),
                boundary: None,
            },
        );
        sizes.push(plan.continuation.frame.size);
    }
    let codecs = codecs.freeze().unwrap();
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
    module
        .export("resume_child", ExportKind::Func, thunks[0])
        .unwrap();
    module
        .export("resume_root", ExportKind::Func, thunks[1])
        .unwrap();
    module
        .export("transport", ExportKind::Func, transport)
        .unwrap();
    module
        .export("select", ExportKind::Func, frame_select)
        .unwrap();
    let mut transform = ActivationModule {
        runtime,
        support,
        codecs,
        declarations,
        module: module.freeze(),
        plans,
        emission,
        routes: vec![(ReferenceCallKind::Direct(0), transport)],
        tails: BTreeMap::new(),
    };
    let mut output = Vec::new();
    emit_remapped(&scan, &mut transform, &mut output, Default::default()).unwrap();
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    (output, sizes)
}

#[test]
fn linked_capture_commit_rewind_live_abort_and_nonlexical_resume_execute_on_both_widths() {
    for wide in [false, true] {
        for shared in [false, true] {
            let (bytes, sizes) = artifact(wide, shared);
            assert_eq!(artifact(wide, shared).0, bytes);
            let file = tempfile::NamedTempFile::new().unwrap();
            std::fs::write(file.path(), bytes).unwrap();
            let result = std::process::Command::new("node")
                .arg("-e")
                .arg(include_str!("fixtures/streaming_scalar_replay.cjs"))
                .arg(file.path())
                .arg(if wide { "1" } else { "0" })
                .arg(
                    sizes
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join(","),
                )
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
    }
}

fn reference_artifact(wide: bool, shared: bool) -> Vec<u8> {
    let p = if wide { "i64" } else { "i32" };
    let memory = if wide { "i64" } else { "" };
    let input = wat::parse_str(format!(
        r#"(module
      (type $f (func (param i32) (result i32)))
      (import "h" "fork" (func $fork (type $f)))
      (import "h" "same" (func $same (param externref externref) (result i32)))
      (memory (export "memory") {memory} 2)
      (global $__stack_pointer (export "sp") (mut {p}) ({p}.const 65536))
      (func $root (export "root") (param externref (ref $f)) (result i32) (local externref externref)
        local.get 0 local.set 2 ref.null extern local.set 3
        i32.const 1 call $fork drop
        local.get 2 local.get 0 call $same
        i32.const 5 local.get 1 call_ref $f i32.const 12 i32.eq i32.and
        local.get 3 ref.is_null i32.and
        ref.null extern local.set 2
        i32.const 2 call $fork drop
        local.get 2 ref.is_null i32.and)
      (elem declare func $callee)
      (func $callee (export "callee") (type $f) local.get 0 i32.const 7 i32.add))"#
    ))
    .unwrap();
    let scan = scan(&input).unwrap();
    let source_types = SourceTypes::new(&scan);
    let mut runtime = NativeRuntime::plan(&scan, Default::default(), 1 << 20).unwrap();
    let kinds = FrozenReferenceKinds::new(&scan, &mut runtime, 1 << 20).unwrap();
    let environment = FrameEnvironment::discover(&scan, &mut runtime, 1 << 20).unwrap();
    let body = scan.body_provider(Default::default()).load(2).unwrap();
    let mut plan = NativeActivationPlan::plan(
        &scan,
        &body,
        &source_types,
        &mut runtime,
        environment,
        &BTreeSet::from([0]),
        Default::default(),
    )
    .unwrap();
    plan.bind_reference_io(&kinds, 1 << 20).unwrap();
    assert_eq!(plan.continuation.calls.len(), 3);
    assert!(
        plan.continuation
            .references
            .null_locals_by_call
            .iter()
            .any(|v| !v.is_empty())
    );
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
    let transport = support
        .transport(
            ActivationCallTarget::Direct(0),
            &[ValType::I32],
            &[ValType::I32],
        )
        .unwrap();
    let reference_transport = support
        .transport(
            ActivationCallTarget::Reference { signature: 0 },
            &[ValType::I32],
            &[ValType::I32],
        )
        .unwrap();
    let parameters = body.locals[..2]
        .iter()
        .map(|&t| source_types.value_type(&mut runtime, t))
        .collect::<anyhow::Result<Vec<_>>>()
        .unwrap();
    let resume = support
        .resume_thunk_with_references(
            runtime.function_index(2).unwrap(),
            &parameters,
            &plan.results,
            &plan.continuation.frame,
            &plan.continuation.references,
            &kinds,
        )
        .unwrap();
    let result_block = support.result_block(&plan.results).unwrap();
    let support = support.freeze().unwrap();
    let shape = plan
        .continuation
        .frame
        .codec_shape(false, &plan.continuation.references)
        .unwrap();
    assert!(!shape.commits, "vector must finish before commit");
    let mut codecs = FrameCodecCatalog::new(
        environment,
        runtime.indices(),
        first_type + support.declarations().type_count(),
        first_function + support.declarations().function_count(),
        1 << 20,
    )
    .unwrap();
    let pair = codecs.request(&shape).unwrap();
    let codecs = codecs.freeze().unwrap();
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
    module
        .export("resume_root", ExportKind::Func, resume)
        .unwrap();
    let emission = ActivationEmission {
        runtime: runtime.indices(),
        frame_select,
        function_ordinal: 2,
        result_block,
        scalar_codecs: shared.then_some(pair),
        boundary: None,
    };
    let mut transform = ActivationModule {
        runtime,
        support,
        codecs,
        declarations,
        module: module.freeze(),
        plans: BTreeMap::from([(2, plan)]),
        emission: BTreeMap::from([(2, emission)]),
        routes: vec![
            (ReferenceCallKind::Direct(0), transport),
            (ReferenceCallKind::Ref { ty: 0 }, reference_transport),
        ],
        tails: BTreeMap::new(),
    };
    let mut output = Vec::new();
    emit_remapped(&scan, &mut transform, &mut output, Default::default()).unwrap();
    wasmparser::Validator::new_with_features(features())
        .validate_all(&output)
        .unwrap();
    output
}

#[test]
fn reference_vectors_restore_aliases_nulls_and_typed_function_parameters_in_a_fresh_instance() {
    for wide in [false, true] {
        for shared in [false, true] {
            let bytes = reference_artifact(wide, shared);
            assert_eq!(reference_artifact(wide, shared), bytes);
            let file = tempfile::NamedTempFile::new().unwrap();
            std::fs::write(file.path(), bytes).unwrap();
            let result = std::process::Command::new("node")
                .arg("-e")
                .arg(include_str!("fixtures/streaming_reference_replay.cjs"))
                .arg(file.path())
                .arg(if wide { "1" } else { "0" })
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
    }
}

#[test]
fn reference_helpers_enforce_budgets_and_reject_invalid_resume_parameters() {
    let input = wat::parse_str(
        r#"(module
          (import "h" "fork" (func $fork))
          (memory 1)
          (func (param externref) call $fork))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let source_types = SourceTypes::new(&scan);
    let mut runtime = NativeRuntime::plan(&scan, Default::default(), 1 << 20).unwrap();
    assert!(FrozenReferenceKinds::new(&scan, &mut runtime, 0).is_err());
    let kinds = FrozenReferenceKinds::new(&scan, &mut runtime, 1 << 20).unwrap();
    let environment = FrameEnvironment::discover(&scan, &mut runtime, 1 << 20).unwrap();
    let body = scan.body_provider(Default::default()).load(1).unwrap();
    let mut plan = NativeActivationPlan::plan(
        &scan,
        &body,
        &source_types,
        &mut runtime,
        environment,
        &BTreeSet::from([0]),
        Default::default(),
    )
    .unwrap();
    let references = &mut plan.continuation.references;
    assert!(NativeReferenceIo::plan(references, &kinds, 0).is_err());
    let io = NativeReferenceIo::plan(references, &kinds, 1 << 20).unwrap();
    let mut output = plan.continuation.frame.new_function();
    let error = io
        .emit_save(
            references,
            &plan.continuation.frame,
            environment,
            runtime.indices(),
            &mut output,
            1,
        )
        .unwrap_err();
    assert!(error.to_string().contains("budget"), "{error:#}");

    let first_type = scan.types.as_ref().core_type_count_in_module()
        + runtime.function_declarations().type_count();
    let first_function = runtime.imports_plan().helper_function_base() + 7;
    let mut catalog = ActivationSupportCatalog::new(
        environment,
        runtime.indices(),
        runtime.frames_start_offset(),
        first_type,
        first_function,
        8192,
    )
    .unwrap();
    // Failed requests must leave the declaration/index sequence usable.
    assert!(
        catalog
            .transport(ActivationCallTarget::Direct(0), &[ValType::I32; 32], &[])
            .is_err()
    );
    let parameters = [ValType::EXTERNREF];
    assert!(
        catalog
            .resume_thunk(first_function, &parameters, &[], &plan.continuation.frame)
            .is_err()
    );
    references.slots[0].universal_position = None;
    let error = catalog
        .resume_thunk_with_references(
            first_function,
            &parameters,
            &[],
            &plan.continuation.frame,
            references,
            &kinds,
        )
        .unwrap_err();
    assert!(
        error.to_string().contains("universal vector position"),
        "{error:#}"
    );
    let helper = catalog
        .transport(ActivationCallTarget::Direct(0), &[], &[])
        .unwrap();
    assert_eq!(helper, first_function + 1);
    let frozen = catalog.freeze().unwrap();
    assert_eq!(frozen.declarations().function_count(), 2);
    assert!(frozen.emit_helper(0, 1).is_err());
    assert!(frozen.emit_helper(1, 1).is_err());
}

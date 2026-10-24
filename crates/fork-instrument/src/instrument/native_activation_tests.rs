//! Check activation helpers against the unchanged Walrus emitter. The Node
//! replay fixtures separately exercise the linked journal's behavior.
use super::*;
use crate::streaming as native;
use std::collections::BTreeSet;

const METADATA_BUDGET: usize = 1 << 20;

fn support_catalog(
    scan: &native::Scan<'_>,
    runtime: &native::NativeRuntime,
    environment: native::FrameEnvironment,
) -> native::ActivationSupportCatalog {
    native::ActivationSupportCatalog::new(
        environment,
        runtime.indices(),
        runtime.frames_start_offset(),
        scan.types.as_ref().core_type_count_in_module()
            + runtime.function_declarations().type_count(),
        runtime.imports_plan().helper_function_base() + 7,
        METADATA_BUDGET,
    )
    .unwrap()
}

fn exported_body(bytes: &[u8], name: &str) -> Vec<u8> {
    let scan = native::scan(bytes).unwrap();
    let index = scan
        .exports
        .iter()
        .find(|(export, _, _)| export == name)
        .unwrap()
        .2;
    scan.body_provider(Default::default())
        .load(index)
        .unwrap()
        .source
        .as_bytes()
        .to_vec()
}

#[test]
fn native_frame_selection_matches_the_oracle_byte_for_byte() {
    for wide in [false, true] {
        let memory = if wide { "i64" } else { "" };
        let input = wat::parse_str(format!("(module (memory {memory} 1))")).unwrap();
        let scan = native::scan(&input).unwrap();
        let mut runtime =
            native::NativeRuntime::plan(&scan, Default::default(), METADATA_BUDGET).unwrap();
        let environment =
            native::FrameEnvironment::discover(&scan, &mut runtime, METADATA_BUDGET).unwrap();
        let support = support_catalog(&scan, &runtime, environment)
            .freeze()
            .unwrap();

        let mut oracle = Module::from_buffer(&input).unwrap();
        let oracle_runtime = runtime::inject_linked_runtime(&mut oracle);
        let select = emit_unwind_frame_select_helper(&mut oracle, &oracle_runtime);
        oracle.exports.add("select", select);
        assert_eq!(
            support
                .emit_helper(0, METADATA_BUDGET)
                .unwrap()
                .into_raw_body(),
            exported_body(&oracle.emit_wasm(), "select"),
            "memory64={wide}",
        );
    }
}

#[test]
fn native_scalar_and_reference_resume_thunks_match_the_oracle_byte_for_byte() {
    for wide in [false, true] {
        for parameters in [
            "",
            "i32 i64",
            "i32 f32 f64 v128",
            "f64 f64 f64 f64 f64", // float-heavy signatures use frame_peek
            "externref funcref",
            "i64 externref f64 (ref func)", // enter a non-nullable signature
        ] {
            check_resume_thunk(wide, parameters);
        }
    }
}

fn check_resume_thunk(wide: bool, parameters: &str) {
    let memory = if wide { "i64" } else { "" };
    let input = wat::parse_str(format!(
        r#"(module
          (import "h" "fork" (func $fork))
          (memory {memory} 1)
          (func $source (export "source") (param {parameters}) (result i32)
            call $fork i32.const 0))"#,
    ))
    .unwrap();
    let scan = native::scan(&input).unwrap();
    let source_types = native::SourceTypes::new(&scan);
    let body = scan.body_provider(Default::default()).load(1).unwrap();
    let mut runtime =
        native::NativeRuntime::plan(&scan, Default::default(), METADATA_BUDGET).unwrap();
    let kinds = native::FrozenReferenceKinds::new(&scan, &mut runtime, METADATA_BUDGET).unwrap();
    let environment =
        native::FrameEnvironment::discover(&scan, &mut runtime, METADATA_BUDGET).unwrap();
    let plan = native::plan_continuations(
        &scan,
        &body,
        &source_types,
        &mut runtime,
        environment,
        &BTreeSet::from([0]),
        Default::default(),
    )
    .unwrap();
    let signature = scan
        .types
        .as_ref()
        .get(scan.types.as_ref().core_type_at_in_module(body.type_index))
        .unwrap()
        .composite_type
        .unwrap_func();
    let parameters = signature
        .params()
        .iter()
        .map(|&ty| source_types.value_type(&mut runtime, ty))
        .collect::<anyhow::Result<Vec<_>>>()
        .unwrap();

    let mut oracle = Module::from_buffer(&input).unwrap();
    let source = oracle
        .funcs
        .iter()
        .find(|function| function.name.as_deref() == Some("source"))
        .unwrap()
        .id();
    let fork = crate::call_graph::find_import_func(&oracle, "h.fork").unwrap();
    let analysis = crate::reference_analysis::analyze_function_references(
        &oracle,
        source,
        &HashSet::from([fork]),
    )
    .unwrap();
    let mut synthetic_references = vec![vec![]];
    append_resume_parameter_references(&oracle, source, &mut synthetic_references);
    let references = plan_reference_frame(&oracle, &analysis, synthetic_references);
    let scalars: Vec<_> = collect_user_locals(&oracle, source)
        .into_iter()
        .filter(|(_, ty)| is_scalar(*ty))
        .collect();
    let pointer_type = if wide { ValType::I64 } else { ValType::I32 };
    let (offsets, _) = plan_frame_layout(&mut oracle, pointer_type, &scalars, scalars.len());
    let oracle_runtime = runtime::inject_linked_runtime(&mut oracle);
    let memory = first_memory(&oracle);
    let resume = emit_resume_thunk(
        &mut oracle,
        source,
        &oracle_runtime,
        memory,
        pointer_type,
        plan.frame.size,
        &offsets,
        &references,
        7,
    );
    oracle.exports.add("resume", resume);
    let expected = oracle.emit_wasm();

    // Walrus may reorder defined functions when emitting. Compare the helper
    // using that emitted target index; source-index remapping has separate tests.
    let emitted_scan = native::scan(&expected).unwrap();
    let emitted_source = emitted_scan
        .exports
        .iter()
        .find(|(name, _, _)| name == "source")
        .unwrap()
        .2;
    let mut catalog = support_catalog(&scan, &runtime, environment);
    catalog
        .resume_thunk_with_references(
            emitted_source,
            &parameters,
            &[wasm_encoder::ValType::I32],
            &plan.frame,
            &plan.references,
            &kinds,
        )
        .unwrap();
    let actual = catalog
        .freeze()
        .unwrap()
        .emit_helper(1, METADATA_BUDGET)
        .unwrap();
    assert_eq!(
        actual.into_raw_body(),
        exported_body(&expected, "resume"),
        "memory64={wide}, parameters={parameters:?}",
    );
}

use super::*;

fn pair(input: &[u8]) -> (NativeRuntime, NativeLegacyLoader) {
    let scan = scan(input).unwrap();
    let mut inputs = RuntimeInputs::default();
    let plan = LegacyLoaderPlan::reserve(&scan, &mut inputs, 7, Default::default()).unwrap();
    let runtime = NativeRuntime::plan(&scan, inputs, 1 << 20).unwrap();
    let mut module = ModuleDeclarationBuilder::from_frozen(
        &scan,
        Some(runtime.imports_plan()),
        runtime.local_declarations().clone(),
        1 << 20,
    )
    .unwrap();
    let loader = plan
        .freeze(&scan, runtime.imports_plan(), &mut module)
        .unwrap();
    (runtime, loader)
}
#[test]
fn generated_driver_is_small_scalar_only_and_bound_to_its_original_import_layout() {
    let input = wat::parse_str(
        r#"(module
      (import "env" "__wasm_dlopen" (func (param i32 i32) (result i32)))
      (memory 1) (table (export "__indirect_function_table") 2 funcref)
      (func (export "__wasm_posix_signal_checkpoint")))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let (mut runtime, loader) = pair(&input);
    let environment = runtime.frame_environment(&scan, 1 << 20).unwrap();
    let options = LoaderActivationOptions {
        function_ordinal: 11,
        first_type: scan.types.as_ref().core_type_count_in_module()
            + runtime.function_declarations().type_count(),
        first_function: runtime.imports_plan().helper_function_base() + 9,
        table_guard: None,
        shared_codecs: true,
    };
    let generated = source::input(&loader, 512).unwrap();
    let private = crate::streaming::scan(&generated).unwrap();
    let body = private
        .body_provider(Default::default())
        .load(source::DRIVER)
        .unwrap();
    assert_eq!(body.locals, [wasmparser::ValType::I32; 2]);
    assert_eq!(
        body.calls.len(),
        6,
        "three checkpoints, next, commit and initializer"
    );
    let activation = loader
        .plan_activation(&runtime, environment, options, Default::default())
        .unwrap()
        .unwrap();
    assert_eq!(activation.entry.ordinal, 11);
    assert!(activation.emit_driver(&loader, 0).is_err());
    assert!(activation.emit_helper(u32::MAX, 1 << 20).is_err());
    for limits in [
        ContinuationLimits {
            metadata_bytes: 0,
            ..Default::default()
        },
        ContinuationLimits {
            work: 0,
            ..Default::default()
        },
    ] {
        assert!(
            loader
                .plan_activation(&runtime, environment, options, limits)
                .is_err()
        );
    }
    for bad in [
        LoaderActivationOptions {
            first_type: u32::MAX,
            ..options
        },
        LoaderActivationOptions {
            first_function: u32::MAX,
            ..options
        },
    ] {
        assert!(
            loader
                .plan_activation(&runtime, environment, bad, Default::default())
                .is_err()
        );
    }
    let other = wat::parse_str("(module (import \"env\" \"__wasm_dlopen\" (func (param i32 i32) (result i32))) (memory 2))").unwrap();
    let (wrong_runtime, wrong_loader) = pair(&other);
    assert!(
        loader
            .plan_activation(&wrong_runtime, environment, options, Default::default())
            .is_err()
    );
    assert!(activation.emit_driver(&wrong_loader, 1 << 20).is_err());
    let mut mapping = source::Mapping(&loader);
    assert!(mapping.function_index(99).is_err());
    assert!(mapping.type_index(99).is_err());
    assert!(mapping.table_index(99).is_err());
}

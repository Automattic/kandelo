use fork_instrument::{module_gc_codec as abi, streaming::*};
use wasm_encoder::{
    EntityType, FuncType, GlobalType, RefType, TableType, ValType,
    reencode::{Error, Reencode, RoundtripReencoder},
};

fn plan(scan: &Scan<'_>) -> NativeGcPlan {
    NativeGcPlan::discover(
        scan,
        &SourceTypes::new(scan),
        &mut RoundtripReencoder,
        Default::default(),
    )
    .unwrap()
}

const SOURCE: &str = r#"(module
    (type $words (array i16))
    (func (result (ref $words))
      i32.const 7 i32.const 8 i32.const 9 array.new_fixed $words 3))"#;

#[test]
fn constructor_limits_reject_before_large_signatures_or_output() {
    let input = wat::parse_str(SOURCE).unwrap();
    let scan = scan(&input).unwrap();
    let plan = plan(&scan);
    for (limits, expected) in [
        (
            GcConstructorLimits {
                parameters: 2,
                ..Default::default()
            },
            "parameter limit",
        ),
        (
            GcConstructorLimits {
                metadata_bytes: 0,
                ..Default::default()
            },
            "metadata budget",
        ),
        (
            GcConstructorLimits {
                work: 0,
                ..Default::default()
            },
            "work budget",
        ),
    ] {
        let mut inputs = RuntimeInputs::default();
        let error = GcConstructorPlan::reserve(&scan, &plan, &mut inputs, 0, limits)
            .err()
            .unwrap();
        assert!(error.to_string().contains(expected), "{error}");
        assert!(inputs.types.is_empty());
        assert!(inputs.imports.is_empty());
    }
    let mut inputs = RuntimeInputs::default();
    let error = GcConstructorPlan::reserve(&scan, &plan, &mut inputs, u32::MAX, Default::default())
        .err()
        .unwrap();
    assert!(error.to_string().contains("ordinal overflow"));

    let mut inputs = RuntimeInputs::default();
    let reserved =
        GcConstructorPlan::reserve(&scan, &plan, &mut inputs, 7, Default::default()).unwrap();
    assert_eq!(reserved.helper_count(), 1);
    let imports = FrozenImports::new(&scan, inputs.imports, 1 << 20).unwrap();
    let first_helper = imports.helper_function_base() + 7;
    let frozen = reserved.freeze(&imports).unwrap();
    let body = scan.body_provider(Default::default()).load(0).unwrap();
    let source = body
        .instructions
        .iter()
        .find(|source| matches!(source.operation, wasmparser::Operator::ArrayNewFixed { .. }))
        .unwrap();
    assert_eq!(
        frozen.replacement(&plan, &source.operation).unwrap(),
        Some(first_helper)
    );
    assert!(
        frozen
            .emit_helper(0, &plan, 1)
            .err()
            .unwrap()
            .to_string()
            .contains("output budget")
    );
    assert!(
        frozen
            .emit_helper(1, &plan, 1 << 20)
            .err()
            .unwrap()
            .to_string()
            .contains("unknown")
    );
    assert!(
        frozen
            .emit_function(&plan, &body, &mut RoundtripReencoder, 1)
            .err()
            .unwrap()
            .to_string()
            .contains("output budget")
    );
}

#[test]
fn constructor_catalog_rejects_another_source_or_output_type_mapping() {
    let input = wat::parse_str(SOURCE).unwrap();
    let scan = scan(&input).unwrap();
    let plan = plan(&scan);
    let other_input = wat::parse_str(SOURCE.replace("i32.const 7", "i32.const 6")).unwrap();
    let other = self::scan(&other_input).unwrap();
    let mut inputs = RuntimeInputs::default();
    let error = GcConstructorPlan::reserve(&other, &plan, &mut inputs, 0, Default::default())
        .err()
        .unwrap();
    assert!(error.to_string().contains("another source module"));
    assert!(inputs.types.is_empty());
    assert!(inputs.imports.is_empty());

    let reserved =
        GcConstructorPlan::reserve(&scan, &plan, &mut inputs, 0, Default::default()).unwrap();
    let wrong_imports = FrozenImports::new(&other, inputs.imports.clone(), 1 << 20).unwrap();
    assert!(
        reserved
            .freeze(&wrong_imports)
            .err()
            .unwrap()
            .to_string()
            .contains("another source module")
    );

    struct ShiftTypes;
    impl Reencode for ShiftTypes {
        type Error = std::convert::Infallible;
        fn type_index(&mut self, source: u32) -> Result<u32, Error<Self::Error>> {
            Ok(source + 100)
        }
    }
    let shifted = NativeGcPlan::discover(
        &scan,
        &SourceTypes::new(&scan),
        &mut ShiftTypes,
        Default::default(),
    )
    .unwrap();
    // Wire descriptors intentionally exclude output indices. The constructor
    // catalog must still reject a plan whose generated typed operands differ.
    assert_eq!(plan.descriptor().unwrap(), shifted.descriptor().unwrap());
    let mut inputs = RuntimeInputs::default();
    let reserved =
        GcConstructorPlan::reserve(&scan, &plan, &mut inputs, 0, Default::default()).unwrap();
    let imports = FrozenImports::new(&scan, inputs.imports, 1 << 20).unwrap();
    let frozen = reserved.freeze(&imports).unwrap();
    assert!(
        frozen
            .emit_helper(0, &shifted, 1 << 20)
            .err()
            .unwrap()
            .to_string()
            .contains("another mapped plan")
    );
}

#[test]
fn scalar_only_modules_reserve_no_constructor_helpers_or_host_imports() {
    let input = wat::parse_str("(module (func (result i32) i32.const 42))").unwrap();
    let scan = scan(&input).unwrap();
    let plan = plan(&scan);
    let mut inputs = RuntimeInputs::default();
    let reserved =
        GcConstructorPlan::reserve(&scan, &plan, &mut inputs, 0, Default::default()).unwrap();
    assert_eq!(reserved.helper_count(), 0);
    assert!(inputs.types.is_empty());
    assert!(inputs.imports.is_empty());
    let imports = FrozenImports::new(&scan, inputs.imports, 1 << 20).unwrap();
    let frozen = reserved.freeze(&imports).unwrap();
    assert_eq!(
        frozen
            .replacement(&plan, &wasmparser::Operator::I32Const { value: 42 })
            .unwrap(),
        None
    );
}

#[test]
fn gc_and_exception_catalogs_share_activation_in_either_reservation_order() {
    let activation_name = wasm_posix_program_abi::abi::WPK_FORK_EXCEPTION_IMPORT_ACTIVATION;
    for source_import in [false, true] {
        let source = if source_import {
            SOURCE.replacen(
                "(module",
                &format!("(module (import \"env\" \"{activation_name}\" (global i32))"),
                1,
            )
        } else {
            SOURCE.into()
        };
        let input = wat::parse_str(source).unwrap();
        let scan = scan(&input).unwrap();
        let plan = plan(&scan);
        for exception_first in [false, true] {
            let mut inputs = RuntimeInputs::default();
            if exception_first {
                NativeExceptionImports::append(&scan, &mut inputs, 1 << 20).unwrap();
            }
            let reserved =
                GcConstructorPlan::reserve(&scan, &plan, &mut inputs, 0, Default::default())
                    .unwrap();
            if !exception_first {
                NativeExceptionImports::append(&scan, &mut inputs, 1 << 20).unwrap();
            }
            assert_eq!(
                inputs
                    .imports
                    .iter()
                    .filter(|entry| entry.name == activation_name)
                    .count(),
                usize::from(!source_import)
            );
            let imports = FrozenImports::new(&scan, inputs.imports, 1 << 20).unwrap();
            let frozen = reserved.freeze(&imports).unwrap();
            frozen.emit_helper(0, &plan, 1 << 20).unwrap();
        }
    }
}

#[test]
fn constructor_imports_reuse_valid_prefix_bindings_and_reject_wrong_types() {
    let input = wat::parse_str(SOURCE).unwrap();
    let scan = scan(&input).unwrap();
    let plan = plan(&scan);
    for incompatible in [false, true] {
        let mut inputs = RuntimeInputs::default();
        inputs.types.push(FuncType::new([], []));
        inputs.imports.push(PlannedImport {
            module: abi::HOST_IMPORT_MODULE.into(),
            name: abi::IMPORT_TRANSIT_TABLE.into(),
            ty: EntityType::Table(TableType {
                element_type: if incompatible {
                    RefType::EXTERNREF
                } else {
                    RefType::ANYREF
                },
                minimum: 1,
                maximum: None,
                table64: false,
                shared: false,
            }),
        });
        let reserved = GcConstructorPlan::reserve(&scan, &plan, &mut inputs, 0, Default::default());
        if incompatible {
            assert!(
                reserved
                    .err()
                    .unwrap()
                    .to_string()
                    .contains("incompatible type")
            );
        } else {
            assert_eq!(
                inputs
                    .imports
                    .iter()
                    .filter(|entry| entry.name == abi::IMPORT_TRANSIT_TABLE)
                    .count(),
                1
            );
            let imports = FrozenImports::new(&scan, inputs.imports, 1 << 20).unwrap();
            reserved.unwrap().freeze(&imports).unwrap();
        }
    }
    let mut inputs = RuntimeInputs::default();
    inputs.imports.push(PlannedImport {
        module: abi::HOST_IMPORT_MODULE.into(),
        name: wasm_posix_program_abi::abi::WPK_FORK_EXCEPTION_IMPORT_ACTIVATION.into(),
        ty: EntityType::Global(GlobalType {
            val_type: ValType::I32,
            mutable: true,
            shared: false,
        }),
    });
    let error = GcConstructorPlan::reserve(&scan, &plan, &mut inputs, 0, Default::default())
        .err()
        .unwrap();
    assert!(error.to_string().contains("immutable i32"));
}

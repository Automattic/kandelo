use super::*;
use crate::streaming::{ModuleBootstrapPlan, scan};

fn roots(source: &str, limits: RootStateLimits) -> Result<NativeRootState> {
    let input = wat::parse_str(source)?;
    let scan = scan(&input)?;
    let mut inputs = RuntimeInputs::default();
    let imports = RootStateImports::append(&scan, &mut inputs, 1 << 20)?;
    let mut runtime = NativeRuntime::plan(&scan, inputs, 1 << 20)?;
    let frozen = runtime.imports_plan().clone();
    let mut module = ModuleDeclarationBuilder::from_frozen(
        &scan,
        Some(&frozen),
        runtime.local_declarations().clone(),
        1 << 20,
    )?;
    let first_type = scan.types.as_ref().core_type_count_in_module()
        + runtime.function_declarations().type_count();
    let bootstrap = ModuleBootstrapPlan::discover(&scan, Default::default())?.freeze(
        &scan,
        Some(&frozen),
        &mut runtime,
        &mut module,
        first_type,
        frozen.helper_function_base() + 7,
    )?;
    NativeRootState::plan(
        &scan,
        &SourceTypes::new(&scan),
        &mut runtime,
        &imports,
        &bootstrap,
        &mut module,
        first_type + 1,
        frozen.helper_function_base() + 10,
        limits,
    )
}
#[test]
fn root_records_enforce_resource_limits_before_emission() {
    let source = "(module (global (mut i32) (i32.const 0)))";
    for (limits, expected) in [
        (
            RootStateLimits {
                metadata_bytes: 0,
                ..Default::default()
            },
            "metadata budget",
        ),
        (
            RootStateLimits {
                work: 0,
                ..Default::default()
            },
            "work budget",
        ),
    ] {
        let error = roots(source, limits).err().unwrap();
        assert!(error.to_string().contains(expected), "{error}");
    }
    let roots = roots(source, Default::default()).unwrap();
    assert!(
        roots
            .emit_helper(0, 1)
            .err()
            .unwrap()
            .to_string()
            .contains("output budget")
    );
    assert!(
        roots
            .emit_helper(3, 1 << 20)
            .err()
            .unwrap()
            .to_string()
            .contains("unknown root state helper")
    );
    let fields = "(global (mut i32) (i32.const 0))".repeat(100);
    let roots = self::roots(
        &format!("(module {fields})"),
        RootStateLimits {
            work: 100,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        roots
            .emit_helper(0, 1 << 20)
            .err()
            .unwrap()
            .to_string()
            .contains("work budget")
    );
}
#[test]
fn optional_drop_hook_maps_have_their_own_preflight() {
    let data = "(data \"x\")".repeat(37);
    let roots = roots(
        &format!("(module {data})"),
        RootStateLimits {
            metadata_bytes: 1536,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        roots
            .data_drop_bits()
            .err()
            .unwrap()
            .to_string()
            .contains("hook map exceeds metadata budget")
    );
    assert!(roots.element_drop_bits().unwrap().is_empty());
}
#[test]
fn repeated_scalar_roots_use_one_physical_payload_local() {
    for count in [1, 512] {
        let fields = "(global (mut i64) (i64.const 0))".repeat(count);
        let roots = roots(&format!("(module {fields})"), Default::default()).unwrap();
        for ordinal in 0..3 {
            let body = roots.emit_helper(ordinal, 1 << 20).unwrap().into_raw_body();
            let body = wasmparser::FunctionBody::new(wasmparser::BinaryReader::new(&body, 0));
            let locals: u32 = body
                .get_locals_reader()
                .unwrap()
                .into_iter()
                .map(|local| local.unwrap().0)
                .sum();
            assert_eq!(locals, 1);
        }
    }
}
#[test]
fn root_imports_reject_a_different_source_and_tiny_import_budget() {
    let input = wat::parse_str("(module)").unwrap();
    let scan = scan(&input).unwrap();
    let mut inputs = RuntimeInputs::default();
    assert!(RootStateImports::append(&scan, &mut inputs, 0).is_err());
    assert!(inputs.imports.is_empty() && inputs.types.is_empty());
    let imports = RootStateImports::append(&scan, &mut inputs, 1 << 20).unwrap();
    let other = wat::parse_str("(module (func))").unwrap();
    let other = self::scan(&other).unwrap();
    let frozen = FrozenImports::new(&other, inputs.imports, 1 << 20).unwrap();
    assert!(
        imports
            .freeze(&frozen)
            .err()
            .unwrap()
            .to_string()
            .contains("another source module")
    );
}

#[test]
fn existing_process_memory_is_reused_by_ordinal_without_counting_other_entities() {
    use crate::streaming::PlannedImport;
    use wasm_encoder::{EntityType, GlobalType, MemoryType};
    let input = wat::parse_str("(module)").unwrap();
    let scan = scan(&input).unwrap();
    let mut inputs = RuntimeInputs {
        imports: vec![
            PlannedImport {
                module: "private".into(),
                name: "global".into(),
                ty: EntityType::Global(GlobalType {
                    val_type: ValType::I32,
                    mutable: false,
                    shared: false,
                }),
            },
            PlannedImport {
                module: "env".into(),
                name: "memory".into(),
                ty: EntityType::Memory(MemoryType {
                    minimum: 0,
                    maximum: Some(65536),
                    memory64: true,
                    shared: true,
                    page_size_log2: None,
                }),
            },
        ],
        ..Default::default()
    };
    RootStateImports::append(&scan, &mut inputs, 1 << 20).unwrap();
    assert_eq!(inputs.staging_memory, Some(1));
    assert_eq!(
        inputs
            .imports
            .iter()
            .filter(|import| matches!(import.ty, EntityType::Memory(_)))
            .count(),
        1
    );
    let runtime = NativeRuntime::plan(&scan, inputs, 1 << 20).unwrap();
    assert_eq!(runtime.process_memory(), Some(0));
    assert_eq!(runtime.pointer_type(), ValType::I64);
}

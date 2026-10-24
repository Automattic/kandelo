use super::*;
use crate::streaming::{CodecPair, NativeRuntime};
use wasm_encoder::GlobalType;

fn codec(source: &str, limits: ExceptionCodecLimits) -> Result<NativeExceptionCodec> {
    let input = wat::parse_str(source)?;
    let scan = super::super::scan(&input)?;
    let types = SourceTypes::new(&scan);
    let mut inputs = RuntimeInputs::default();
    let imports = NativeExceptionImports::append(&scan, &mut inputs, 1 << 20)?;
    inputs.helper_codecs.exnref = Some(CodecPair {
        encode: 7,
        decode: 8,
    });
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
    let references = runtime.indices().codecs;
    NativeExceptionCodec::plan(
        &scan,
        &types,
        &mut runtime,
        &imports,
        &frozen,
        references,
        &mut module,
        first_type,
        frozen.helper_function_base() + 7,
        limits,
    )
}

#[test]
fn exception_catalog_reuses_activation_identity_and_checks_its_type() {
    let plan = codec(
        r#"(module
      (import "h" "other" (global i64))
      (import "env" "__wpk_fork_module_activation" (global i32))
      (memory 1) (tag (param i32)))"#,
        Default::default(),
    )
    .unwrap();
    assert_eq!(plan.host.activation, 1);
    assert!(
        codec(
            r#"(module
      (import "env" "__wpk_fork_module_activation" (global (mut i32)))
      (memory 1))"#,
            Default::default()
        )
        .err()
        .unwrap()
        .to_string()
        .contains("immutable i32")
    );
    let input = wat::parse_str("(module (memory 1))").unwrap();
    let scan = super::super::scan(&input).unwrap();
    let mut inputs = RuntimeInputs::default();
    inputs.imports.push(PlannedImport {
        module: abi::HOST_IMPORT_MODULE.into(),
        name: abi::IMPORT_ACTIVATION.into(),
        ty: EntityType::Global(GlobalType {
            val_type: ValType::I32,
            mutable: false,
            shared: false,
        }),
    });
    NativeExceptionImports::append(&scan, &mut inputs, 1 << 20).unwrap();
    assert_eq!(
        inputs
            .imports
            .iter()
            .filter(|import| import.name == abi::IMPORT_ACTIVATION)
            .count(),
        1
    );
}

#[test]
fn exception_planning_and_emission_reject_resource_exhaustion() {
    let source = "(module (memory 1) (tag (param i32)))";
    assert!(
        codec("(module)", Default::default())
            .err()
            .unwrap()
            .to_string()
            .contains("process memory")
    );
    assert!(
        codec(
            source,
            ExceptionCodecLimits {
                metadata_bytes: 1,
                ..Default::default()
            }
        )
        .err()
        .unwrap()
        .to_string()
        .contains("metadata budget")
    );
    assert!(
        codec(
            source,
            ExceptionCodecLimits {
                work: 0,
                ..Default::default()
            }
        )
        .err()
        .unwrap()
        .to_string()
        .contains("work budget")
    );
    let plan = codec(source, Default::default()).unwrap();
    assert!(
        plan.emit_helper(0, 1)
            .err()
            .unwrap()
            .to_string()
            .contains("output budget")
    );
    assert!(
        plan.emit_helper(8, 1024)
            .err()
            .unwrap()
            .to_string()
            .contains("unknown exception helper")
    );
    let plan = codec(
        source,
        ExceptionCodecLimits {
            work: 2,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        plan.emit_helper(0, 1 << 20)
            .err()
            .unwrap()
            .to_string()
            .contains("work budget")
    );
    let input = wat::parse_str(source).unwrap();
    let scan = super::super::scan(&input).unwrap();
    let mut inputs = RuntimeInputs::default();
    assert!(NativeExceptionImports::append(&scan, &mut inputs, 0).is_err());
    assert!(
        inputs.imports.is_empty(),
        "reject imports before copying metadata"
    );
}

#[test]
fn exception_tag_count_does_not_multiply_typed_helper_locals_or_signatures() {
    let mut previous = None;
    for repetitions in [1, 256] {
        let tags = "(tag (param i32 i32 i64 f64 externref (ref exn)))".repeat(repetitions);
        let plan = codec(&format!("(module (memory 1) {tags})"), Default::default()).unwrap();
        let mut counts = vec![plan.declarations.type_count()];
        for helper in [0, 1] {
            let body = plan.emit_helper(helper, 1 << 20).unwrap().into_raw_body();
            let body = wasmparser::FunctionBody::new(wasmparser::BinaryReader::new(&body, 0));
            let count: u32 = body
                .get_locals_reader()
                .unwrap()
                .into_iter()
                .map(|local| local.unwrap().0)
                .sum();
            counts.push(count);
        }
        assert_eq!(counts, *previous.get_or_insert_with(|| counts.clone()));
    }
}

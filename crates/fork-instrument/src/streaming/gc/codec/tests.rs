use super::*;
use crate::streaming::{NativeRuntime, scan};
use wasm_encoder::reencode::RoundtripReencoder;

fn codec(source: &str, limits: GcCodecLimits) -> Result<(NativeGcCodec, NativeGcPlan)> {
    let input = wat::parse_str(source)?;
    let scan = scan(&input)?;
    let plan = NativeGcPlan::discover(
        &scan,
        &SourceTypes::new(&scan),
        &mut RoundtripReencoder,
        Default::default(),
    )?;
    let mut inputs = RuntimeInputs::default();
    let reserved = GcCodecPlan::reserve(&scan, &plan, &mut inputs, 7, limits)?;
    inputs.helper_codecs.anyref = Some(reserved.anyref_codecs());
    inputs.helper_codecs.externref = Some(reserved.externref_codecs());
    let runtime = NativeRuntime::plan(&scan, inputs, 1 << 20)?;
    let imports = runtime.imports_plan();
    let mut module = ModuleDeclarationBuilder::from_frozen(
        &scan,
        Some(imports),
        runtime.local_declarations().clone(),
        1 << 20,
    )?;
    let codec = reserved.freeze(&scan, &plan, imports, runtime.indices(), &mut module)?;
    Ok((codec, plan))
}

#[test]
fn gc_codec_enforces_planning_and_emission_limits() {
    for (source, limits, expected) in [
        ("(module)", GcCodecLimits::default(), "process memory"),
        (
            "(module (memory 1))",
            GcCodecLimits {
                work: 0,
                ..Default::default()
            },
            "work budget",
        ),
        (
            "(module (memory 1))",
            GcCodecLimits {
                metadata_bytes: 0,
                ..Default::default()
            },
            "metadata budget",
        ),
    ] {
        let error = codec(source, limits).err().unwrap();
        assert!(error.to_string().contains(expected), "{error}");
    }
    let (codec, plan) = codec("(module (memory 1))", Default::default()).unwrap();
    for (ordinal, limit, expected) in [
        (0, 1, "output budget"),
        (u32::MAX, 1 << 20, "unknown GC helper"),
    ] {
        let error = codec.emit_helper(ordinal, &plan, limit).err().unwrap();
        assert!(error.to_string().contains(expected), "{error}");
    }
    let fields = "(field i32)".repeat(100);
    let (codec, plan) = self::codec(
        &format!("(module (memory 1) (type (struct {fields})))"),
        GcCodecLimits {
            work: 200,
            ..Default::default()
        },
    )
    .unwrap();
    let error = codec.emit_helper(0, &plan, 1 << 20).err().unwrap();
    assert!(error.to_string().contains("work budget"), "{error}");
}

#[test]
fn gc_layout_count_does_not_multiply_physical_helper_locals() {
    let mut previous = None;
    for count in [1, 256] {
        // Distinct arities keep all source struct types nominally distinct.
        let layouts: String = (1..=count)
            .map(|fields| format!("(type (struct {}))", "(field (mut i32))".repeat(fields)))
            .collect();
        let (codec, plan) = codec(
            &format!("(module (memory 1) {layouts})"),
            Default::default(),
        )
        .unwrap();
        assert_eq!(plan.layouts.len(), count);
        let mut counts = Vec::new();
        for helper in [0, 6, 7] {
            let body = codec
                .emit_helper(helper, &plan, 8 << 20)
                .unwrap()
                .into_raw_body();
            let body = wasmparser::FunctionBody::new(wasmparser::BinaryReader::new(&body, 0));
            counts.push(
                body.get_locals_reader()
                    .unwrap()
                    .into_iter()
                    .map(|local| local.unwrap().0)
                    .sum::<u32>(),
            );
        }
        assert_eq!(counts, *previous.get_or_insert_with(|| counts.clone()));
        assert_eq!(counts, vec![9, 9, 9]);
    }
}

#[test]
fn concrete_function_seeds_use_the_original_nominal_type() {
    let (codec, plan) = codec(
        r#"(module (memory 1)
        (type $f (sub (func (param i32) (result i64))))
        (type (struct (field (mut (ref $f))))))"#,
        Default::default(),
    )
    .unwrap();
    let seeds::Seed::Function(function) = codec
        .seeds
        .get(RefType {
            nullable: false,
            heap_type: wasm_encoder::HeapType::Concrete(0),
        })
        .unwrap()
    else {
        panic!("concrete function seed missing")
    };
    let ordinal = function - codec.indices.encode_anyref;
    assert_eq!(codec.declarations.function_type(ordinal), Some(0));
    codec.emit_helper(ordinal, &plan, 1 << 20).unwrap();
}

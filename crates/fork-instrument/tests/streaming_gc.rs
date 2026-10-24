use fork_instrument::{module_gc_codec, streaming::*};
use std::collections::BTreeSet;
use wasm_encoder::reencode::RoundtripReencoder;

fn compare(source: &str) -> NativeGcPlan {
    let input = wat::parse_str(source).unwrap();
    let scan = scan(&input).unwrap();
    let types = SourceTypes::new(&scan);
    let native =
        NativeGcPlan::discover(&scan, &types, &mut RoundtripReencoder, Default::default()).unwrap();
    let module = walrus::Module::from_buffer(&input).unwrap();
    let oracle = module_gc_codec::plan(&module).unwrap();
    assert_eq!(
        native.descriptor().unwrap(),
        oracle.descriptor(),
        "{source}"
    );
    assert_eq!(
        native.dispatch_layouts(),
        oracle.dispatch_layouts(),
        "{source}"
    );
    native
}

#[test]
fn original_gc_type_identity_follows_validated_recursive_groups() {
    for source in [
        "(module (type (struct (field i32))) (type (struct (field i32))))",
        "(module (rec (type (struct (field (ref null 0))))) (rec (type (struct (field (ref null 1))))))",
        "(module (rec (type (struct (field (ref null 1)))) (type (struct (field (ref null 0))))))",
    ] {
        let input = wat::parse_str(source).unwrap();
        let scan = scan(&input).unwrap();
        let types = scan.types.as_ref();
        let mut canonical = BTreeSet::new();
        for index in 0..types.core_type_count_in_module() {
            let id = types.core_type_at_in_module(index);
            if matches!(
                types.get(id).unwrap().composite_type.inner,
                wasmparser::CompositeInnerType::Array(_)
                    | wasmparser::CompositeInnerType::Struct(_)
            ) {
                canonical.insert(id);
            }
        }
        let native = NativeGcPlan::discover(
            &scan,
            &SourceTypes::new(&scan),
            &mut RoundtripReencoder,
            Default::default(),
        )
        .unwrap();
        assert_eq!(canonical.len(), native.layouts().len());
        let oracle = module_gc_codec::plan(&walrus::Module::from_buffer(&input).unwrap()).unwrap();
        if native.layouts().len() == oracle.layouts().len() {
            assert_eq!(native.descriptor().unwrap(), oracle.descriptor());
        } else {
            assert_eq!(native.layouts().len(), 1);
            assert_eq!(
                oracle.layouts().len(),
                2,
                "equivalent recursive source types share one native layout"
            );
        }
    }
}

#[test]
fn native_gc_layout_flags_offsets_and_subtype_dispatch_match_the_oracle() {
    for source in [
        "(module)",
        r#"(module
          (type $node (sub (struct (field (mut i8)) (field i64) (field (mut (ref null $node))))))
          (type $child (sub $node (struct (field (mut i8)) (field i64) (field (mut (ref null $node))) (field f32))))
          (type (array (mut (ref null $node))))
          (type (array i16)))"#,
        r#"(module
          (type $function (func (param i32)))
          (type $seed (struct (field (mut i32))))
          (type $node (struct
            (field (mut (ref $seed))) (field (ref null $node))
            (field (mut (ref extern))) (field (ref $function))
            (field (ref null exn)) (field (ref null none))))
          (type (array (mut (ref $node))))
          (type (array (mut (ref $function)))))"#,
        r#"(module (type (struct (field i8) (field i16) (field i32)
          (field i64) (field f32) (field f64) (field v128))))"#,
    ] {
        compare(source);
    }
}

#[test]
fn native_gc_discovers_every_required_array_constructor_without_fork_filtering() {
    let plan = compare(
        r#"(module
      (import "h" "fork" (func))
      (type $seed (struct (field (mut i32))))
      (type $nonnull (array (mut (ref $seed))))
      (type $immutable (array i16))
      (type $funcs (array funcref))
      (type $mutable (array (mut i32)))
      (data $unused "unused") (data $data "\01\00\02\00")
      (elem $unused_elem func) (elem $elem func $target)
      (func $target)
      (func
        struct.new_default $seed i32.const 2 array.new $nonnull drop
        struct.new_default $seed struct.new_default $seed array.new_fixed $nonnull 2 drop
        i32.const 7 i32.const 3 array.new $immutable drop
        i32.const 3 array.new_default $immutable drop
        i32.const 1 i32.const 2 array.new_fixed $immutable 2 drop
        i32.const 0 i32.const 2 array.new_data $immutable $data drop
        i32.const 0 i32.const 1 array.new_elem $funcs $elem drop
        i32.const 2 array.new_default $mutable drop))"#,
    );
    let fixed = plan
        .layouts()
        .iter()
        .find(|layout| {
            layout.constructor == NativeGcConstructor::ArrayFixed { len: 2 }
                && layout.provenance_reference_count == 2
        })
        .unwrap();
    assert_eq!(
        plan.constructor_layout(fixed.source_type, fixed.constructor)
            .unwrap()
            .id,
        fixed.id
    );
    assert_eq!(fixed.provenance_reference_count, 2);
    assert_eq!(fixed.provenance_scalar_len, 0);
    let data = plan
        .layouts()
        .iter()
        .find(|layout| layout.constructor == NativeGcConstructor::ArrayData { segment_ordinal: 1 })
        .unwrap();
    assert_eq!(data.provenance_scalar_len, 8);
    let mutable = plan
        .layouts()
        .iter()
        .find(|layout| layout.kind == NativeGcKind::Array && layout.defaultable_shell)
        .unwrap();
    assert!(
        plan.constructor_layout(mutable.source_type, NativeGcConstructor::ArrayDefault)
            .is_none(),
        "defaultable mutable arrays need no wrapper"
    );
}

#[test]
fn gc_catalog_keeps_runtime_types_distinct_across_recursive_groups() {
    let input = wat::parse_str(
        r#"(module
      (rec (type $a (struct (field i32))) (type $b (struct (field i32))))
      (type $c (struct (field i32)))
      (func (export "probe") (result i32)
        i32.const 7 struct.new $c ref.test (ref $b)))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let plan = NativeGcPlan::discover(
        &scan,
        &SourceTypes::new(&scan),
        &mut RoundtripReencoder,
        Default::default(),
    )
    .unwrap();
    assert_eq!(plan.layouts().len(), 3);
    assert_eq!(plan.base_layout(2).unwrap().source_type, 2);
    assert_ne!(
        plan.base_layout(1).unwrap().id,
        plan.base_layout(2).unwrap().id
    );
    let mut native = Vec::new();
    emit_remapped(
        &scan,
        &mut RoundtripReencoder,
        &mut native,
        Default::default(),
    )
    .unwrap();
    let mut module = walrus::Module::from_buffer(&input).unwrap();
    assert_eq!(module_gc_codec::plan(&module).unwrap().layouts().len(), 2);
    let oracle = module.emit_wasm();
    let directory = tempfile::tempdir().unwrap();
    let first = directory.path().join("source.wasm");
    let second = directory.path().join("oracle.wasm");
    let third = directory.path().join("native.wasm");
    std::fs::write(&first, input).unwrap();
    std::fs::write(&second, oracle).unwrap();
    std::fs::write(&third, native).unwrap();
    let output = std::process::Command::new("node")
        .arg("-e")
        .arg(
            r#"
          const fs = require('node:fs');
          for (const path of process.argv.slice(1)) {
            const module = new WebAssembly.Module(fs.readFileSync(path));
            console.log(new WebAssembly.Instance(module).exports.probe());
          }
        "#,
        )
        .arg(first)
        .arg(second)
        .arg(third)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        output.stdout, b"0\n1\n0\n",
        "original and native retain the type distinction; unchanged Walrus merges it"
    );
}

#[test]
fn native_gc_payload_types_use_frozen_output_indices() {
    use wasm_encoder::{
        HeapType, StorageType, ValType,
        reencode::{Error, Reencode},
    };
    struct Shift;
    impl Reencode for Shift {
        type Error = std::convert::Infallible;
        fn type_index(&mut self, source: u32) -> Result<u32, Error<Self::Error>> {
            Ok(source + 100)
        }
    }
    let input =
        wat::parse_str("(module (type $node (struct (field (mut (ref null $node))))))").unwrap();
    let scan = scan(&input).unwrap();
    let plan = NativeGcPlan::discover(
        &scan,
        &SourceTypes::new(&scan),
        &mut Shift,
        Default::default(),
    )
    .unwrap();
    assert_eq!(plan.layouts()[0].type_index, 100);
    let StorageType::Val(ValType::Ref(reference)) = plan.layouts()[0].fields[0].field.element_type
    else {
        panic!()
    };
    assert_eq!(reference.heap_type, HeapType::Concrete(100));
    assert_eq!(
        plan.layouts()[0].fields[0].class,
        Some(NativeReferenceClass::Any)
    );
}

#[test]
fn native_gc_struct_provenance_requires_only_mutable_nonnull_gc_seeds() {
    let plan = compare(
        r#"(module
      (type $function (func))
      (type $seed (struct (field i32)))
      (type $mixed (struct (field (mut (ref $seed)))
        (field (ref $seed)) (field (mut (ref extern)))
        (field (mut (ref $function))) (field (mut (ref exn))))))"#,
    );
    let layout = plan
        .layouts()
        .iter()
        .find(|layout| layout.requires_provenance)
        .unwrap();
    assert_eq!(layout.provenance_reference_count, 1);
    assert_eq!(
        plan.constructor_layout(layout.source_type, NativeGcConstructor::Struct)
            .unwrap()
            .id,
        layout.id
    );
    assert!(
        layout.fields[1].allocation_dependency,
        "immutable edges are allocation inputs"
    );
    assert!(
        !layout.fields[0].allocation_dependency,
        "mutable GC seeds have separate provenance"
    );
}

#[test]
fn native_gc_constructor_discovery_matches_retained_lexical_order() {
    for tail in ["return", "return_call $exit", "block br 0"] {
        let close = if tail == "block br 0" { "end" } else { "" };
        compare(&format!(
            r#"(module
          (import "h" "exit" (func $exit))
          (type $array (array i32))
          (func {tail} i32.const 9 array.new_fixed $array 1 drop {close}
            i32.const 2 array.new_default $array drop))"#
        ));
    }
}

#[test]
fn native_gc_keeps_constructor_catalog_bounded_across_repeated_sites() {
    let body = "i32.const 7 array.new_fixed $array 1 drop\n".repeat(10_000);
    let input =
        wat::parse_str(format!("(module (type $array (array i32)) (func {body}))")).unwrap();
    let scan = scan(&input).unwrap();
    let types = SourceTypes::new(&scan);
    let limits = GcPlanLimits {
        metadata_bytes: 8192,
        ..Default::default()
    };
    let plan = NativeGcPlan::discover(&scan, &types, &mut RoundtripReencoder, limits).unwrap();
    assert_eq!(plan.layouts().len(), 2);
    let oracle = walrus::Module::from_buffer(&input).unwrap();
    assert_eq!(
        plan.descriptor().unwrap(),
        module_gc_codec::plan(&oracle).unwrap().descriptor()
    );
    for limits in [
        GcPlanLimits {
            metadata_bytes: 1,
            ..Default::default()
        },
        GcPlanLimits {
            work: 0,
            ..Default::default()
        },
        GcPlanLimits {
            work: 1024,
            ..Default::default()
        },
        GcPlanLimits {
            ir: IrLimits {
                instructions: 8,
                ..Default::default()
            },
            ..Default::default()
        },
    ] {
        assert!(NativeGcPlan::discover(&scan, &types, &mut RoundtripReencoder, limits).is_err());
    }
}

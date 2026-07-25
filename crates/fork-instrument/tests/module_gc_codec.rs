use fork_instrument::module_gc_codec::{
    CONSTRUCTOR_ARRAY_FIXED, CONSTRUCTOR_ARRAY_GENERIC, CONSTRUCTOR_STRUCT, FIELD_FLAG_MUTABLE,
    FIELD_FLAG_NULLABLE, FIELD_FLAG_REFERENCE, FORMAT_FIELD_RECORD_SIZE, FORMAT_HEADER_SIZE,
    FORMAT_LAYOUT_RECORD_SIZE, FORMAT_MAGIC, FORMAT_VERSION, GcConstructorKind, GcLayoutKind,
    KIND_ARRAY, KIND_STRUCT, LAYOUT_FLAG_REQUIRES_PROVENANCE, plan,
};
use fork_instrument::{module_exception_codec, module_gc_codec, runtime};
use walrus::Module;

fn parse(wat: &str) -> Module {
    let bytes = wat::parse_str(wat).expect("valid test WAT");
    Module::from_buffer(&bytes).expect("walrus accepts test module")
}

fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap())
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn finish_codec(mut module: Module) -> Vec<u8> {
    let memory = module.memories.iter().next().expect("test memory").id();
    let declared = module_gc_codec::declare(&mut module, memory).expect("declare GC codec");
    let exception = module_exception_codec::inject_with_reference_overrides(
        &mut module,
        memory,
        Some((declared.encode_externref, declared.decode_externref)),
        Some((declared.encode_anyref, declared.decode_anyref)),
    )
    .expect("inject exception codec");
    let runtime = runtime::inject_linked_runtime_with_reference_overrides(
        &mut module,
        runtime::ReferenceCodecOverrides {
            funcref: Some((
                exception.references.encode_funcref,
                exception.references.decode_funcref,
            )),
            externref: Some((
                exception.references.encode_externref,
                exception.references.decode_externref,
            )),
            exnref: Some((exception.encode, exception.decode)),
            anyref: Some((declared.encode_anyref, declared.decode_anyref)),
            cleanup: Some(exception.clear),
        },
    );
    module_gc_codec::finish_declaration(&mut module, declared, exception, &runtime)
        .expect("emit GC codec");
    module.emit_wasm()
}

#[test]
fn plans_exact_scalar_and_reference_layouts() {
    let module = parse(
        r#"
        (module
          (type $node
            (sub (struct
              (field (mut i8))
              (field i64)
              (field (mut (ref null $node))))))
          (type $child
            (sub $node (struct
              (field (mut i8))
              (field i64)
              (field (mut (ref null $node)))
              (field f32))))
          (type $refs (array (mut (ref null $node))))
          (type $immutable (array i16))
          (func (export "make") (result (ref $child))
            i32.const 0
            i64.const 0
            ref.null $node
            f32.const 0
            struct.new $child))
        "#,
    );

    let plan = plan(&module).expect("GC layouts plan");
    assert_eq!(plan.layouts().len(), 4);

    let node = &plan.layouts()[0];
    assert_eq!(node.kind, GcLayoutKind::Struct);
    assert_eq!(node.constructor, GcConstructorKind::Struct);
    assert_eq!(node.scalar_len_or_stride, 16);
    assert!(!node.defaultable_shell);
    assert_eq!(node.fields[0].scalar_offset, Some(0));
    assert_eq!(node.fields[1].scalar_offset, Some(8));
    assert_eq!(node.fields[2].reference_ordinal, Some(0));

    let child = &plan.layouts()[1];
    assert_eq!(child.super_type_ordinal, Some(0));
    assert_eq!(child.subtype_depth, 1);
    assert_eq!(child.scalar_len_or_stride, 20);

    let refs = &plan.layouts()[2];
    assert_eq!(refs.kind, GcLayoutKind::Array);
    assert_eq!(refs.scalar_len_or_stride, 0);
    assert!(refs.defaultable_shell);
    assert_eq!(refs.fields[0].reference_ordinal, Some(0));

    let immutable = &plan.layouts()[3];
    assert_eq!(immutable.kind, GcLayoutKind::Array);
    assert_eq!(immutable.scalar_len_or_stride, 2);
    assert!(!immutable.defaultable_shell);

    // Exact dynamic type dispatch must test the subtype before its parent.
    assert_eq!(&plan.dispatch_layouts()[..2], &[child.id, node.id]);
}

#[test]
fn assigns_constructor_layouts_only_when_shell_replay_is_not_safe() {
    let module = parse(
        r#"
        (module
          (type $mutable (array (mut i32)))
          (type $immutable (array i32))
          (data $bytes "\01\00\00\00\02\00\00\00")
          (func (export "mutable-fixed") (result (ref $mutable))
            i32.const 7
            i32.const 8
            array.new_fixed $mutable 2)
          (func (export "immutable-fixed") (result (ref $immutable))
            i32.const 9
            i32.const 10
            array.new_fixed $immutable 2)
          (func (export "immutable-data") (result (ref $immutable))
            i32.const 0
            i32.const 2
            array.new_data $immutable $bytes))
        "#,
    );

    let plan = plan(&module).expect("GC layouts plan");
    assert_eq!(plan.layouts().len(), 4);
    assert_eq!(
        plan.layouts()[0].constructor,
        GcConstructorKind::ArrayGeneric
    );
    assert_eq!(
        plan.layouts()[1].constructor,
        GcConstructorKind::ArrayGeneric
    );
    assert_eq!(
        plan.layouts()[2].constructor,
        GcConstructorKind::ArrayFixed { len: 2 }
    );
    assert_eq!(
        plan.layouts()[3].constructor,
        GcConstructorKind::ArrayData { segment_ordinal: 0 }
    );
}

#[test]
fn descriptor_is_canonical_and_binds_constructor_safety() {
    let module = parse(
        r#"
        (module
          (type $pair
            (struct
              (field i32)
              (field (mut (ref null $pair)))))
          (type $immutable (array i16))
          (func (export "new-array") (result (ref $immutable))
            i32.const 1
            i32.const 2
            array.new_fixed $immutable 2))
        "#,
    );
    let plan = plan(&module).expect("GC layouts plan");
    let bytes = plan.descriptor();

    assert_eq!(&bytes[0..4], &FORMAT_MAGIC);
    assert_eq!(u16_at(&bytes, 4), FORMAT_VERSION);
    assert_eq!(u16_at(&bytes, 6), FORMAT_HEADER_SIZE);
    assert_eq!(u32_at(&bytes, 8), 3);
    assert_eq!(u32_at(&bytes, 12), 4);
    assert_eq!(
        bytes.len(),
        usize::from(FORMAT_HEADER_SIZE)
            + 3 * usize::from(FORMAT_LAYOUT_RECORD_SIZE)
            + 4 * usize::from(FORMAT_FIELD_RECORD_SIZE)
    );

    let first = usize::from(FORMAT_HEADER_SIZE);
    assert_eq!(bytes[first + 8], KIND_STRUCT);
    assert_eq!(bytes[first + 9], CONSTRUCTOR_STRUCT);
    assert_eq!(u16_at(&bytes, first + 10), 0);

    let second = first + usize::from(FORMAT_LAYOUT_RECORD_SIZE);
    assert_eq!(bytes[second + 8], KIND_ARRAY);
    assert_eq!(bytes[second + 9], CONSTRUCTOR_ARRAY_GENERIC);
    assert_eq!(u16_at(&bytes, second + 10), LAYOUT_FLAG_REQUIRES_PROVENANCE);

    let third = second + usize::from(FORMAT_LAYOUT_RECORD_SIZE);
    assert_eq!(bytes[third + 8], KIND_ARRAY);
    assert_eq!(bytes[third + 9], CONSTRUCTOR_ARRAY_FIXED);
    assert_eq!(u16_at(&bytes, third + 10), LAYOUT_FLAG_REQUIRES_PROVENANCE);
    assert_eq!(u32_at(&bytes, third + 28), plan.layouts()[1].id);
    assert_eq!(u32_at(&bytes, third + 32), 2);

    let fields = first + 3 * usize::from(FORMAT_LAYOUT_RECORD_SIZE);
    assert_eq!(bytes[fields + 1], 0);
    assert_eq!(
        bytes[fields + usize::from(FORMAT_FIELD_RECORD_SIZE) + 1],
        FIELD_FLAG_MUTABLE | FIELD_FLAG_NULLABLE | FIELD_FLAG_REFERENCE
    );
}

#[test]
fn generated_probe_and_local_anyref_codec_validate_without_typed_anyref_imports() {
    let mut module = parse(
        r#"
        (module
          (memory 1)
          (type $base (sub (struct (field (mut i32)))))
          (type $child
            (sub $base (struct (field (mut i32)) (field (mut i64)))))
          (func (export "child") (result (ref $child))
            i32.const 1
            i64.const 2
            struct.new $child))
        "#,
    );
    let memory = module.memories.iter().next().unwrap().id();
    let declared = module_gc_codec::declare(&mut module, memory).expect("declare GC codec");
    let exception = module_exception_codec::inject_with_reference_overrides(
        &mut module,
        memory,
        Some((declared.encode_externref, declared.decode_externref)),
        Some((declared.encode_anyref, declared.decode_anyref)),
    )
    .expect("inject exception codec");
    let runtime = runtime::inject_linked_runtime_with_reference_overrides(
        &mut module,
        runtime::ReferenceCodecOverrides {
            funcref: Some((
                exception.references.encode_funcref,
                exception.references.decode_funcref,
            )),
            externref: Some((
                exception.references.encode_externref,
                exception.references.decode_externref,
            )),
            exnref: Some((exception.encode, exception.decode)),
            anyref: Some((declared.encode_anyref, declared.decode_anyref)),
            cleanup: Some(exception.clear),
        },
    );
    module_gc_codec::finish_declaration(&mut module, declared, exception, &runtime)
        .expect("emit GC codec");
    let wasm = module.emit_wasm();

    let mut validator = wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all());
    validator
        .validate_all(&wasm)
        .expect("generated module validates");
    let printed = wasmprinter::print_bytes(&wasm).expect("print generated module");
    assert!(printed.contains("(export \"__wpk_fork_ref_gc_probe\""));
    assert!(printed.contains("(export \"__wpk_fork_ref_gc_encode_slot\""));
    assert!(printed.contains("(export \"__wpk_fork_ref_gc_publish_externref\""));
    assert!(printed.contains("(table (;"));
    assert!(printed.contains("anyref"), "{printed}");
    assert!(printed.contains("any.convert_extern"), "{printed}");
    assert!(printed.contains("extern.convert_any"), "{printed}");
    assert!(!printed.contains("(import \"env\" \"__wpk_fork_ref_encode_anyref\"",));
    assert!(!printed.contains("(import \"env\" \"__wpk_fork_ref_decode_anyref\"",));
    assert!(!printed.contains("(import \"env\" \"__wpk_fork_ref_encode_externref\"",));
    assert!(!printed.contains("(import \"env\" \"__wpk_fork_ref_decode_externref\"",));
}

#[test]
fn generated_allocate_and_fill_cover_non_shell_structs_and_array_constructors() {
    let mut module = parse(
        r#"
        (module
          (memory 1)
          (type $leaf (struct (field (mut i32))))
          (type $holder
            (struct
              (field i64)
              (field (mut (ref $leaf)))))
          (type $bytes (array i8))
          (type $refs (array (ref null $leaf)))
          (type $mutable-refs (array (mut (ref null $leaf))))
          (data $data "\01\02\03")
          (elem $elements (ref null $leaf)
            (item (ref.null $leaf))
            (item (ref.null $leaf)))

          (func (export "holder") (result (ref $holder))
            i64.const 9
            i32.const 1
            struct.new $leaf
            struct.new $holder)
          (func (export "fixed") (result (ref $bytes))
            i32.const 1
            i32.const 2
            array.new_fixed $bytes 2)
          (func (export "data") (result (ref $bytes))
            i32.const 0
            i32.const 3
            array.new_data $bytes $data)
          (func (export "elements") (result (ref $refs))
            i32.const 0
            i32.const 2
            array.new_elem $refs $elements)
          (func (export "mutable") (result (ref $mutable-refs))
            ref.null $leaf
            i32.const 2
            array.new $mutable-refs))
        "#,
    );
    let memory = module.memories.iter().next().unwrap().id();
    let declared = module_gc_codec::declare(&mut module, memory).expect("declare GC codec");
    let exception = module_exception_codec::inject_with_reference_overrides(
        &mut module,
        memory,
        Some((declared.encode_externref, declared.decode_externref)),
        Some((declared.encode_anyref, declared.decode_anyref)),
    )
    .expect("inject exception codec");
    let runtime = runtime::inject_linked_runtime_with_reference_overrides(
        &mut module,
        runtime::ReferenceCodecOverrides {
            funcref: Some((
                exception.references.encode_funcref,
                exception.references.decode_funcref,
            )),
            externref: Some((
                exception.references.encode_externref,
                exception.references.decode_externref,
            )),
            exnref: Some((exception.encode, exception.decode)),
            anyref: Some((declared.encode_anyref, declared.decode_anyref)),
            cleanup: Some(exception.clear),
        },
    );
    module_gc_codec::finish_declaration(&mut module, declared, exception, &runtime)
        .expect("emit GC codec");
    let wasm = module.emit_wasm();
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all())
        .validate_all(&wasm)
        .expect("all generated concrete helpers validate");
}

#[test]
fn generated_seeds_cover_mutable_nonnullable_function_external_and_exception_refs() {
    let wasm = finish_codec(parse(
        r#"
        (module
          (memory 1)
          (type $holder
            (struct
              (field (mut (ref func)))
              (field (mut (ref extern)))
              (field (mut (ref exn)))))
          (type $functions (array (mut (ref func))))
          (type $externals (array (mut (ref extern))))
          (type $exceptions (array (mut (ref exn)))))
        "#,
    ));

    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all())
        .validate_all(&wasm)
        .expect("generated non-null reference seeds validate");
    let printed = wasmprinter::print_bytes(&wasm).expect("print generated seeds");
    assert!(
        printed.contains("__wpk_fork_ref_seed_func"),
        "funcref allocation needs a locally typed temporary seed",
    );
    assert!(
        printed.contains("extern.convert_any"),
        "externref allocation needs a non-null locally constructed seed",
    );
    assert!(
        printed.contains("__wpk_fork_ref_seed_exn"),
        "exnref allocation needs a fresh instance-local exception seed",
    );
}

#[test]
fn mutable_nonnullable_array_fixed_records_every_constructor_reference() {
    let module = parse(
        r#"
        (module
          (type $leaf (struct (field (mut i32))))
          (type $refs (array (mut (ref $leaf))))
          (func (export "fixed") (result (ref $refs))
            i32.const 1
            struct.new $leaf
            i32.const 2
            struct.new $leaf
            array.new_fixed $refs 2))
        "#,
    );
    let plan = plan(&module).expect("GC layouts plan");
    let fixed = plan
        .layouts()
        .iter()
        .find(|layout| layout.constructor == (GcConstructorKind::ArrayFixed { len: 2 }))
        .expect("specialized array.fixed layout");
    assert!(fixed.requires_provenance);
    assert_eq!(
        fixed.provenance_reference_count, 2,
        "each element is an allocation dependency: using only one static seed \
         would lose distinct constructor identities",
    );
}

#[test]
fn parent_i31_capture_publishes_the_identity_to_the_transit_table() {
    let wasm = finish_codec(parse(
        r#"
        (module
          (memory 1)
          (type $box (struct (field (mut i32)))))
        "#,
    ));
    let module = Module::from_buffer(&wasm).expect("parse generated GC codec");
    let transit = module
        .imports
        .iter()
        .find_map(|import| {
            (import.name == module_gc_codec::IMPORT_TRANSIT_TABLE).then(|| match import.kind {
                walrus::ImportKind::Table(table) => Some(table),
                _ => None,
            })?
        })
        .expect("GC transit table import");
    let encode = module
        .funcs
        .iter()
        .find(|function| function.name.as_deref() == Some(module_gc_codec::LOCAL_ENCODE_ANYREF))
        .expect("local anyref encoder");
    let encode = match &encode.kind {
        walrus::FunctionKind::Local(local) => local,
        _ => panic!("anyref encoder must be local"),
    };

    fn has_i31_publication(
        function: &walrus::LocalFunction,
        sequence: walrus::ir::InstrSeqId,
        transit: walrus::TableId,
    ) -> bool {
        let instructions = &function.block(sequence).instrs;
        let reads_i31 = instructions
            .iter()
            .any(|(instruction, _)| matches!(instruction, walrus::ir::Instr::I31GetS(_)));
        let publishes = instructions.iter().any(
            |(instruction, _)| {
                matches!(instruction, walrus::ir::Instr::TableSet(set) if set.table == transit)
            },
        );
        if reads_i31 && publishes {
            return true;
        }
        instructions.iter().any(|(instruction, _)| {
            let children: &[walrus::ir::InstrSeqId] = match instruction {
                walrus::ir::Instr::Block(block) => std::slice::from_ref(&block.seq),
                walrus::ir::Instr::Loop(block) => std::slice::from_ref(&block.seq),
                walrus::ir::Instr::TryTable(table) => std::slice::from_ref(&table.seq),
                walrus::ir::Instr::IfElse(branches) => {
                    return has_i31_publication(function, branches.consequent, transit)
                        || has_i31_publication(function, branches.alternative, transit);
                }
                _ => &[],
            };
            children
                .iter()
                .any(|child| has_i31_publication(function, *child, transit))
        })
    }

    assert!(
        has_i31_publication(encode, encode.entry_block(), transit),
        "the parent encoder must publish recipe+1 -> i31ref because JavaScript \
         receives only the scalar i31 payload and cannot manufacture the value",
    );
}

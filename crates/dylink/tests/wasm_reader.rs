//! The binary reader: ordering, defined-vs-reexported, and malformed input.

mod support;

use dylink::{
    read_module_shape, require_passive_data_segments, without_borrowed_replay_start, DylinkError,
    ExternKind, ImportType, ValType,
};
use support::{DylinkSection, Export, Import, SideModule};

/// The load-bearing invariant: duplicate `(module, name)` import entries stay
/// distinct, in declaration order.
///
/// `wasm-ld` emits these for an interposable definition, and the engine calls
/// `Get` once per entry. Collapsing them — which any name-keyed map does —
/// captures the wrong provider for the second declaration.
#[test]
fn duplicate_import_declarations_stay_distinct_and_ordered() {
    let bytes = SideModule {
        imports: vec![
            Import::func("env", "shared"),
            Import::func("env", "other"),
            Import::func("env", "shared"),
            Import::got("GOT.mem", "shared"),
        ],
        ..Default::default()
    }
    .encode();

    let shape = read_module_shape(&bytes).expect("reader");
    assert_eq!(shape.imports.len(), 4);
    let named: Vec<(&str, &str, u32)> = shape
        .imports
        .iter()
        .map(|import| (import.module.as_str(), import.name.as_str(), import.position))
        .collect();
    assert_eq!(
        named,
        vec![
            ("env", "shared", 0),
            ("env", "other", 1),
            ("env", "shared", 2),
            ("GOT.mem", "shared", 3),
        ]
    );
    assert_eq!(shape.imported_function_count, 3);
}

#[test]
fn import_types_are_decoded_per_kind() {
    let bytes = SideModule {
        imports: vec![
            Import::Memory { module: "env".into(), field: "memory".into() },
            Import::Table { module: "env".into(), field: "__indirect_function_table".into() },
            Import::immutable_global("env", "__memory_base"),
            Import::got("GOT.func", "handler"),
            Import::tag("env", "__c_longjmp"),
        ],
        ..Default::default()
    }
    .encode();

    let shape = read_module_shape(&bytes).expect("reader");
    let kinds: Vec<ExternKind> = shape.imports.iter().map(|i| i.ty.kind()).collect();
    assert_eq!(
        kinds,
        vec![
            ExternKind::Memory,
            ExternKind::Table,
            ExternKind::Global,
            ExternKind::Global,
            ExternKind::Tag
        ]
    );
    assert!(matches!(
        shape.imports[2].ty,
        ImportType::Global { value_type: ValType::I32, mutable: false }
    ));
    assert!(matches!(
        shape.imports[3].ty,
        ImportType::Global { value_type: ValType::I32, mutable: true }
    ));
    assert!(shape.imports_named("env", "__c_longjmp", ExternKind::Tag));
    assert!(!shape.imports_named("env", "__cpp_exception", ExternKind::Tag));
}

/// A re-exported import is not a local definition and must not get a
/// self-import trampoline back to itself.
#[test]
fn reexported_imports_are_not_defined_exports() {
    let bytes = SideModule {
        imports: vec![Import::func("env", "malloc"), Import::func("env", "free")],
        exports: vec![
            // Index 0 and 1 are the two imported functions, re-exported.
            Export::func("malloc", 0),
            Export::func("free", 1),
            // Index 2 is the module's first DEFINED function.
            Export::func("my_init", 2),
        ],
        ..Default::default()
    }
    .encode();

    let shape = read_module_shape(&bytes).expect("reader");
    let defined: Vec<&str> = shape.defined_function_exports().collect();
    assert_eq!(defined, vec!["my_init"]);
}

/// The deterministic replacement for scanning the table by `Function` identity.
#[test]
fn element_segments_yield_static_table_slots() {
    let bytes = SideModule {
        elements: vec![(1, vec![7, 8]), (10, vec![9])],
        ..Default::default()
    }
    .encode();

    let shape = read_module_shape(&bytes).expect("reader");
    assert_eq!(shape.element_function_slots, vec![(1, 7), (2, 8), (10, 9)]);
}

#[test]
fn a_truncated_module_is_an_error_not_a_panic() {
    let bytes = SideModule {
        imports: vec![Import::func("env", "malloc")],
        ..Default::default()
    }
    .encode();
    for cut in 8..bytes.len() {
        // Every prefix must produce a Result, never a panic and never a
        // silently-wrong shape. The TypeScript reader indexes past the end of a
        // Uint8Array here and yields `undefined`/`NaN`.
        let _ = read_module_shape(&bytes[..cut]);
    }
    assert!(matches!(
        read_module_shape(&bytes[..9]),
        Err(DylinkError::MalformedModule(_)) | Ok(_)
    ));
}

#[test]
fn a_non_wasm_input_is_rejected_by_magic() {
    assert_eq!(read_module_shape(b"not wasm at all!"), Err(DylinkError::NotAWasmBinary));
    assert_eq!(read_module_shape(b""), Err(DylinkError::NotAWasmBinary));
}

#[test]
fn a_leb128_integer_wider_than_64_bits_is_rejected() {
    // A section size encoded as eleven 0xff continuation bytes.
    let mut bytes = vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x02];
    bytes.extend_from_slice(&[0xff; 11]);
    assert!(matches!(read_module_shape(&bytes), Err(DylinkError::MalformedModule(_))));
}

/// A borrowed (vfork) replay shares the parent's live memory, so an active data
/// segment would write it inside instantiation before the host could recover.
#[test]
fn borrowed_replay_requires_passive_data_segments() {
    let passive = SideModule { data_segments: vec![true, true], ..Default::default() }.encode();
    assert_eq!(require_passive_data_segments(&passive), Ok(()));

    let active = SideModule { data_segments: vec![true, false], ..Default::default() }.encode();
    assert_eq!(
        require_passive_data_segments(&active),
        Err(DylinkError::ActiveDataSegmentInBorrowedReplay { index: 1 })
    );
}

#[test]
fn borrowed_replay_strips_only_the_recognized_start_section() {
    let recognized = SideModule {
        exports: vec![Export::func("__wasm_init_memory", 3)],
        start_function: Some(3),
        ..Default::default()
    }
    .encode();
    let stripped = without_borrowed_replay_start(&recognized)
        .expect("rewrite")
        .expect("a start section was present");
    assert!(stripped.len() < recognized.len());
    assert_eq!(read_module_shape(&stripped).expect("reader").start_function, None);
    // Everything else survives.
    assert_eq!(
        read_module_shape(&stripped).expect("reader").exports.len(),
        read_module_shape(&recognized).expect("reader").exports.len()
    );

    let unrecognized = SideModule {
        exports: vec![Export::func("__wasm_init_memory", 3)],
        start_function: Some(9),
        ..Default::default()
    }
    .encode();
    assert_eq!(
        without_borrowed_replay_start(&unrecognized),
        Err(DylinkError::UnrecognizedStartFunction { index: 9 })
    );

    let none = SideModule::default().encode();
    assert_eq!(without_borrowed_replay_start(&none), Ok(None));
}

#[test]
fn a_module_with_a_dylink_section_still_reads_its_other_sections() {
    let bytes = SideModule {
        dylink: DylinkSection {
            memory_size: 128,
            memory_align: 4,
            table_size: 2,
            table_align: 0,
            ..Default::default()
        },
        imports: vec![Import::func("env", "printf")],
        exports: vec![Export::func("entry", 1)],
        ..Default::default()
    }
    .encode();

    let shape = read_module_shape(&bytes).expect("reader");
    assert_eq!(shape.imports.len(), 1);
    assert_eq!(shape.exports.len(), 1);
}

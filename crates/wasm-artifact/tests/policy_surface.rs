use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use wasm_artifact::policy_surface::{
    POLICY_TYPE_SCRATCH_BYTES, PolicyReadError, PolicyReadLimits, PolicySurface,
    read_policy_surface,
};

thread_local! {
    static WATCH: Cell<bool> = const { Cell::new(false) };
    static LIVE: Cell<usize> = const { Cell::new(0) };
    static PEAK: Cell<usize> = const { Cell::new(0) };
    static LARGEST: Cell<usize> = const { Cell::new(0) };
    static REQUESTS: Cell<usize> = const { Cell::new(0) };
    static FAIL_AT: Cell<usize> = const { Cell::new(usize::MAX) };
}

struct Recorder;

impl Recorder {
    fn refuse() -> bool {
        WATCH
            .try_with(|watch| {
                watch.get()
                    && REQUESTS
                        .try_with(|requests| {
                            let current = requests.get();
                            requests.set(current + 1);
                            FAIL_AT
                                .try_with(|fail| fail.get() == current)
                                .unwrap_or(false)
                        })
                        .unwrap_or(false)
            })
            .unwrap_or(false)
    }

    fn change(allocated: usize, freed: usize) {
        let _ = WATCH.try_with(|watch| {
            if watch.get() {
                let _ = LIVE.try_with(|live| {
                    let next = live.get().saturating_sub(freed).saturating_add(allocated);
                    live.set(next);
                    let _ = PEAK.try_with(|peak| peak.set(peak.get().max(next)));
                    let _ = LARGEST.try_with(|largest| largest.set(largest.get().max(allocated)));
                });
            }
        });
    }
}

unsafe impl GlobalAlloc for Recorder {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if Self::refuse() {
            return core::ptr::null_mut();
        }
        let result = unsafe { System.alloc(layout) };
        if !result.is_null() {
            Self::change(layout.size(), 0);
        }
        result
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        Self::change(0, layout.size());
        unsafe { System.dealloc(pointer, layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if Self::refuse() {
            return core::ptr::null_mut();
        }
        let _ = WATCH.try_with(|watch| {
            if watch.get() {
                let _ = LIVE.try_with(|live| {
                    let _ = PEAK
                        .try_with(|peak| peak.set(peak.get().max(live.get().saturating_add(size))));
                });
            }
        });
        let result = unsafe { System.realloc(pointer, layout, size) };
        if !result.is_null() {
            Self::change(size, layout.size());
        }
        result
    }
}

#[global_allocator]
static ALLOCATOR: Recorder = Recorder;

fn measured<Value>(operation: impl FnOnce() -> Value) -> (Value, usize, usize) {
    LIVE.with(|value| value.set(0));
    PEAK.with(|value| value.set(0));
    LARGEST.with(|value| value.set(0));
    REQUESTS.with(|value| value.set(0));
    WATCH.with(|value| value.set(true));
    let result = operation();
    WATCH.with(|value| value.set(false));
    assert_eq!(LIVE.with(Cell::get), 0, "reader retained an allocation");
    (result, PEAK.with(Cell::get), LARGEST.with(Cell::get))
}

fn limits() -> PolicyReadLimits {
    PolicyReadLimits {
        metadata_bytes: 1024 * 1024,
        work_items: 1_000_000,
    }
}

fn leb(bytes: &mut Vec<u8>, mut value: usize) {
    loop {
        let byte = (value & 127) as u8;
        value >>= 7;
        bytes.push(byte | if value == 0 { 0 } else { 128 });
        if value == 0 {
            return;
        }
    }
}

fn string(bytes: &mut Vec<u8>, value: &str) {
    leb(bytes, value.len());
    bytes.extend_from_slice(value.as_bytes());
}

fn section(bytes: &mut Vec<u8>, kind: u8, payload: &[u8]) {
    bytes.push(kind);
    leb(bytes, payload.len());
    bytes.extend_from_slice(payload);
}

fn summary(module: &[u8]) -> PolicySurface {
    read_policy_surface(module, limits()).unwrap()
}

fn check_against_catalog(module: &[u8]) {
    let actual = read_policy_surface(module, limits());
    match wasm_artifact::read_artifact_facts(module) {
        Err(_) => assert_eq!(actual, Err(PolicyReadError::InvalidModule)),
        Ok(facts) => assert_eq!(
            actual.unwrap(),
            PolicySurface {
                pointer_width: facts.pointer_width(),
                abi_version: wasm_artifact::read_abi_version(module),
                mixed_memory_widths: facts.has_mixed_memory_widths(),
                has_fork_surface: facts.has_fork_artifact_surface(),
                imports_kernel_fork: facts.imports_kernel_fork,
                contains_legacy_asyncify: facts.contains_legacy_asyncify,
            }
        ),
    }
}

#[test]
fn matches_the_existing_catalog_on_frozen_programs_and_modern_type_models() {
    let directory =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../abi/program-fixtures/v55");
    let mut checked = 0;
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path
            .extension()
            .is_some_and(|extension| extension == "wasm")
        {
            check_against_catalog(&std::fs::read(path).unwrap());
            checked += 1;
        }
    }
    assert_eq!(checked, 7);
    for source in [
        "(module)",
        "(module (memory 1))",
        "(module (memory i64 1))",
        "(module (import \"env\" \"memory\" (memory i64 1)) (memory 1))",
        "(module (type (func)) (import \"env\" \"x\" (func (type 0))) (func (export \"call\")))",
        "(module (import \"env\" \"wpk_fork_unwind\" (tag (param i32))))",
        "(module (func (export \"asyncify_legacy\")))",
        "(module (global (export \"asyncify_legacy\") i32 (i32.const 0)))",
        "(module (type $s (struct (field i32))) (type $a (array (mut i64))))",
        "(module (rec (type $s (struct (field (ref null $f)))) (type $f (func (param (ref null $s))))) (func (export \"call\") (type $f) (param (ref null $s))))",
        "(module (type $f (sub (func))) (type (sub $f (func))))",
        "(module (type $f (func)) (type (cont $f)))",
    ] {
        check_against_catalog(&wat::parse_str(source).unwrap());
    }
}

#[test]
fn malformed_type_import_export_and_section_references_remain_refused() {
    let mut cases = vec![b"not wasm".to_vec(), b"\0asm\x0d\0\x01\0".to_vec()];
    for payload in [vec![1, 0x60], vec![1, 0x4e, 2, 0x60, 0, 0], vec![0, 0]] {
        let mut module = b"\0asm\x01\0\0\0".to_vec();
        section(&mut module, 1, &payload);
        cases.push(module);
    }
    for kind in [0, 4] {
        let mut module = b"\0asm\x01\0\0\0".to_vec();
        let mut imports = vec![1];
        string(&mut imports, "env");
        string(&mut imports, "unknown");
        imports.push(kind);
        if kind == 4 {
            imports.push(0);
        }
        imports.push(1);
        section(&mut module, 2, &imports);
        cases.push(module);
    }
    let mut exported = wat::parse_str("(module (func (export \"call\")))").unwrap();
    let offset = exported
        .windows(7)
        .position(|bytes| bytes == b"\x04call\x00\x00")
        .unwrap();
    exported[offset + 6] = 99;
    cases.push(exported);
    for module in cases {
        check_against_catalog(&module);
    }
}

fn compact(module_name: &str, count: usize, kind: u8) -> Vec<u8> {
    let mut module = b"\0asm\x01\0\0\0".to_vec();
    section(&mut module, 1, &[1, 0x60, 0, 0]);
    let mut imports = vec![1];
    string(&mut imports, module_name);
    string(&mut imports, "");
    imports.push(kind);
    if kind == 0x7e {
        imports.extend_from_slice(&[0, 0]);
    }
    leb(&mut imports, count);
    for _ in 0..count {
        string(&mut imports, "function");
        if kind == 0x7f {
            imports.extend_from_slice(&[0, 0]);
        }
    }
    section(&mut module, 2, &imports);
    module
}

#[test]
fn compact_imports_do_not_copy_shared_names_and_are_charged_before_expansion() {
    for kind in [0x7f, 0x7e] {
        let module = compact(&"n".repeat(8192), 128, kind);
        let (actual, peak, largest) = measured(|| read_policy_surface(&module, limits()));
        assert!(actual.is_ok());
        assert!(
            peak < 8192 && largest < 8192,
            "peak={peak} largest={largest}"
        );
        check_against_catalog(&module);
        let (_, old_peak, _) =
            measured(|| drop(wasm_artifact::read_artifact_facts(&module).unwrap()));
        assert!(old_peak > 1024 * 1024, "control peak={old_peak}");
        println!(
            "compact-{kind:x}: catalog peak={old_peak}, bounded peak={peak}, largest={largest}"
        );
        let mut tight = limits();
        tight.work_items = 16;
        let (actual, peak, largest) = measured(|| read_policy_surface(&module, tight));
        assert_eq!(actual, Err(PolicyReadError::WorkLimit));
        assert!(peak < 4096 && largest < 4096);
    }
}

#[test]
fn repeated_function_imports_do_not_clone_the_shared_signature() {
    let mut module = b"\0asm\x01\0\0\0".to_vec();
    let mut types = vec![1, 0x60];
    leb(&mut types, 512);
    types.resize(types.len() + 512, 0x7f);
    types.push(0);
    section(&mut module, 1, &types);
    let mut imports = Vec::new();
    leb(&mut imports, 512);
    for _ in 0..512 {
        string(&mut imports, "env");
        string(&mut imports, "same");
        imports.extend_from_slice(&[0, 0]);
    }
    section(&mut module, 2, &imports);
    let (actual, peak, largest) = measured(|| read_policy_surface(&module, limits()));
    assert!(actual.is_ok());
    assert!(
        peak < 65536 && largest < 65536,
        "peak={peak} largest={largest}"
    );
    let (_, old_peak, _) = measured(|| drop(wasm_artifact::read_artifact_facts(&module).unwrap()));
    assert!(old_peak > 1024 * 1024, "control peak={old_peak}");
    println!("shared-signature: catalog peak={old_peak}, bounded peak={peak}, largest={largest}");
    check_against_catalog(&module);
}

#[test]
fn large_custom_data_is_borrowed_not_cloned() {
    let mut module = b"\0asm\x01\0\0\0".to_vec();
    let mut data = Vec::new();
    string(&mut data, "unrelated-data");
    data.resize(4 * 1024 * 1024, 1);
    section(&mut module, 0, &data);
    let (actual, peak, largest) = measured(|| read_policy_surface(&module, limits()));
    assert!(actual.is_ok());
    assert!(
        peak < 4096 && largest < 4096,
        "peak={peak} largest={largest}"
    );
    let (_, old_peak, _) = measured(|| drop(wasm_artifact::read_artifact_facts(&module).unwrap()));
    assert!(old_peak >= 4 * 1024 * 1024 - 100);
    println!("custom-data: catalog peak={old_peak}, bounded peak={peak}, largest={largest}");
}

#[test]
fn recursive_groups_decode_one_subtype_at_a_time_with_bounded_scratch() {
    let mut module = b"\0asm\x01\0\0\0".to_vec();
    let mut types = vec![1, 0x4e];
    leb(&mut types, 2048);
    for _ in 0..2048 {
        types.extend_from_slice(&[0x60, 0, 0]);
    }
    section(&mut module, 1, &types);
    let (actual, peak, largest) = measured(|| read_policy_surface(&module, limits()));
    assert!(actual.is_ok());
    assert!(
        peak < 8192 && largest < 8192,
        "peak={peak} largest={largest}"
    );
    check_against_catalog(&module);
    let mut invalid = b"\0asm\x01\0\0\0".to_vec();
    let mut types = vec![1, 0x4e];
    leb(&mut types, 1_000_000);
    section(&mut invalid, 1, &types);
    let mut tight = limits();
    tight.work_items = 16;
    let (actual, peak, largest) = measured(|| read_policy_surface(&invalid, tight));
    assert_eq!(actual, Err(PolicyReadError::WorkLimit));
    assert!(peak < 4096 && largest < 4096);
    let mut oversized = b"\0asm\x01\0\0\0".to_vec();
    let mut types = vec![1, 0x4e];
    leb(&mut types, 1_000_001);
    section(&mut oversized, 1, &types);
    assert_eq!(
        read_policy_surface(&oversized, limits()),
        Err(PolicyReadError::InvalidModule)
    );
}

#[test]
fn largest_individual_type_scratch_is_reserved_separately_from_catalog_growth() {
    for (kind, count, record) in [(0x5f, 10_000, &[0x7f, 0][..]), (0x60, 1000, &[0x7f][..])] {
        let mut module = b"\0asm\x01\0\0\0".to_vec();
        let mut types = vec![1, kind];
        leb(&mut types, count);
        for _ in 0..count {
            types.extend_from_slice(record);
        }
        if kind == 0x60 {
            leb(&mut types, 1000);
            types.resize(types.len() + 1000, 0x7e);
        }
        section(&mut module, 1, &types);
        let (actual, peak, largest) = measured(|| read_policy_surface(&module, limits()));
        assert!(actual.is_ok());
        assert!(
            peak < POLICY_TYPE_SCRATCH_BYTES && largest < POLICY_TYPE_SCRATCH_BYTES,
            "peak={peak} scratch={POLICY_TYPE_SCRATCH_BYTES}"
        );
        check_against_catalog(&module);
    }
}

#[test]
fn invalid_limits_and_metadata_growth_refuse_without_fallback() {
    let empty = b"\0asm\x01\0\0\0";
    for changed in [
        PolicyReadLimits {
            metadata_bytes: 0,
            ..limits()
        },
        PolicyReadLimits {
            work_items: 0,
            ..limits()
        },
    ] {
        assert_eq!(
            read_policy_surface(empty, changed),
            Err(PolicyReadError::InvalidLimits)
        );
    }
    assert_eq!(
        read_policy_surface(
            empty,
            PolicyReadLimits {
                metadata_bytes: POLICY_TYPE_SCRATCH_BYTES - 1,
                ..limits()
            }
        ),
        Err(PolicyReadError::MetadataLimit)
    );
    let mut only_scratch = limits();
    only_scratch.metadata_bytes = POLICY_TYPE_SCRATCH_BYTES;
    assert!(read_policy_surface(empty, only_scratch).is_ok());
    let module = wat::parse_str("(module (func (export \"call\")))").unwrap();
    assert_eq!(
        read_policy_surface(&module, only_scratch),
        Err(PolicyReadError::MetadataLimit)
    );
}

#[test]
fn pinned_parser_type_limits_do_not_silently_outgrow_the_scratch_allowance() {
    for (kind, count, record) in [(0x5f, 10_001, &[0x7f, 0][..]), (0x60, 1001, &[0x7f][..])] {
        let mut module = b"\0asm\x01\0\0\0".to_vec();
        let mut types = vec![1, kind];
        leb(&mut types, count);
        for _ in 0..count {
            types.extend_from_slice(record);
        }
        if kind == 0x60 {
            types.push(0);
        }
        section(&mut module, 1, &types);
        assert_eq!(
            read_policy_surface(&module, limits()),
            Err(PolicyReadError::InvalidModule)
        );
        assert!(wasm_artifact::read_artifact_facts(&module).is_err());
        let mut module = b"\0asm\x01\0\0\0".to_vec();
        let mut types = vec![1, 0x60, 0];
        leb(&mut types, 1001);
        types.resize(types.len() + 1001, 0x7f);
        section(&mut module, 1, &types);
        assert_eq!(
            read_policy_surface(&module, limits()),
            Err(PolicyReadError::InvalidModule)
        );
    }
}

#[test]
fn recognizes_only_the_same_typed_fork_surface_as_the_catalog() {
    for requirement in wasm_posix_program_abi::abi::WPK_FORK_REQUIRED_EXPORTS {
        let module =
            wat::parse_str(format!("(module (func (export {:?})))", requirement.name)).unwrap();
        assert!(summary(&module).has_fork_surface);
        check_against_catalog(&module);
        let module = wat::parse_str(format!(
            "(module (global (export {:?}) i32 (i32.const 0)))",
            requirement.name
        ))
        .unwrap();
        assert!(!summary(&module).has_fork_surface);
        check_against_catalog(&module);
    }
    for requirement in wasm_posix_program_abi::abi::WPK_FORK_REQUIRED_IMPORTS {
        let module = wat::parse_str(format!(
            "(module (import {:?} {:?} (func)))",
            requirement.module, requirement.name
        ))
        .unwrap();
        assert!(summary(&module).has_fork_surface);
        check_against_catalog(&module);
    }
    let module = wat::parse_str(format!(
        "(module (import {:?} {:?} (tag)))",
        wasm_posix_program_abi::abi::WPK_FORK_UNWIND_TAG_IMPORT_MODULE,
        wasm_posix_program_abi::abi::WPK_FORK_UNWIND_TAG_IMPORT_NAME
    ))
    .unwrap();
    assert!(summary(&module).has_fork_surface);
    check_against_catalog(&module);
}

#[test]
fn every_retained_catalog_allocation_can_refuse_without_aborting_or_leaking() {
    let module = compact("env", 512, 0x7e);
    let (result, _, _) = measured(|| read_policy_surface(&module, limits()));
    assert!(result.is_ok());
    let count = REQUESTS.with(Cell::get);
    assert!(count > 5);
    for index in 0..count {
        FAIL_AT.with(|value| value.set(index));
        let (result, _, _) = measured(|| read_policy_surface(&module, limits()));
        FAIL_AT.with(|value| value.set(usize::MAX));
        assert_eq!(
            result,
            Err(PolicyReadError::Allocation),
            "allocation {index}"
        );
    }
    assert!(summary(&module).abi_version.is_none());
}

#[test]
fn nested_type_work_is_charged_before_value_and_field_decoding() {
    for (kind, count, record) in [(0x5f, 10_000, &[0x7f, 0][..]), (0x60, 1000, &[0x7f][..])] {
        let mut module = b"\0asm\x01\0\0\0".to_vec();
        let mut types = vec![1, kind];
        leb(&mut types, count);
        for _ in 0..count {
            types.extend_from_slice(record);
        }
        if kind == 0x60 {
            types.push(0);
        }
        section(&mut module, 1, &types);
        let mut tight = limits();
        tight.work_items = 16;
        let (actual, peak, largest) = measured(|| read_policy_surface(&module, tight));
        assert_eq!(actual, Err(PolicyReadError::WorkLimit));
        assert_eq!((peak, largest), (0, 0));
    }
}

#[test]
fn table_initializers_cannot_allocate_an_unbounded_control_stack() {
    let mut module = b"\0asm\x01\0\0\0".to_vec();
    let mut tables = vec![1, 0x40, 0, 0x70, 0, 1];
    for _ in 0..32_768 {
        tables.extend_from_slice(&[0x02, 0x40]);
    }
    tables.extend_from_slice(&[0xd0, 0x70]);
    tables.resize(tables.len() + 32_769, 0x0b);
    section(&mut module, 4, &tables);
    let (actual, peak, largest) = measured(|| read_policy_surface(&module, limits()));
    assert_eq!(actual, Err(PolicyReadError::InvalidModule));
    assert!(peak < 4096 && largest < 4096);
    for source in [
        "(module (table 1 funcref (ref.null func)))",
        "(module (type $s (struct)) (table 1 (ref null $s) (struct.new $s)))",
    ] {
        check_against_catalog(&wat::parse_str(source).unwrap());
    }
    let source = "(module (type $s (struct (field v128))) (table 1 (ref null $s) (struct.new $s (v128.const i32x4 0 0 0 0))))";
    let module = wat::parse_str(source).unwrap();
    let (actual, peak, _) = measured(|| read_policy_surface(&module, limits()));
    assert!(actual.is_ok());
    assert!(peak < 4096);
}

#[test]
fn selected_marker_operators_are_bounded_and_do_not_interpret_nested_ends() {
    let mut module = b"\0asm\x01\0\0\0".to_vec();
    section(&mut module, 1, &[1, 0x60, 0, 1, 0x7f]);
    section(&mut module, 3, &[1, 0]);
    let mut exports = vec![1];
    string(&mut exports, "__abi_version");
    exports.extend_from_slice(&[0, 0]);
    section(&mut module, 7, &exports);
    let mut body = vec![0];
    for _ in 0..32_768 {
        body.extend_from_slice(&[0x02, 0x7f]);
    }
    body.extend_from_slice(&[0x41, 55]);
    body.resize(body.len() + 32_769, 0x0b);
    let mut code = vec![1];
    leb(&mut code, body.len());
    code.extend(body);
    section(&mut module, 10, &code);
    let (actual, peak, largest) = measured(|| read_policy_surface(&module, limits()));
    assert_eq!(actual.unwrap().abi_version, None);
    assert!(peak < 4096 && largest < 4096);
    let source = "(module (func (export \"__abi_version\") (result i32) nop nop nop nop nop nop nop nop i32.const 55))";
    let mut tight = limits();
    tight.work_items = 16;
    assert_eq!(
        read_policy_surface(&wat::parse_str(source).unwrap(), tight),
        Err(PolicyReadError::WorkLimit)
    );
    for source in [
        "(module (import \"env\" \"ctor\" (func $ctor)) (func $value (result i32) call $ctor i32.const 55) (func (export \"__abi_version\") (result i32) call $value))",
        "(module (func (export \"__abi_version\") (result i32) call $value) (func $value (result i32) i32.const 55 return))",
        "(module (func $a (export \"__abi_version\") (result i32) call $b) (func $b (result i32) call $a))",
    ] {
        check_against_catalog(&wat::parse_str(source).unwrap());
    }
}

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! {
    static WATCH: Cell<bool> = const { Cell::new(false) };
    static LARGEST: Cell<usize> = const { Cell::new(0) };
}

struct Recorder;

impl Recorder {
    fn observe(size: usize) {
        let _ = WATCH.try_with(|watch| {
            if watch.get() {
                let _ = LARGEST.try_with(|largest| largest.set(largest.get().max(size)));
            }
        });
    }
}

unsafe impl GlobalAlloc for Recorder {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        Self::observe(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        Self::observe(size);
        unsafe { System.realloc(pointer, layout, size) }
    }
}

#[global_allocator]
static ALLOCATOR: Recorder = Recorder;

fn leb(bytes: &mut Vec<u8>, mut value: usize) {
    loop {
        let byte = (value & 127) as u8;
        value >>= 7;
        bytes.push(byte | if value == 0 { 0 } else { 128 });
        if value == 0 { return; }
    }
}

fn section(module: &mut Vec<u8>, kind: u8, payload: &[u8]) {
    module.push(kind);
    leb(module, payload.len());
    module.extend_from_slice(payload);
}

fn fixture(functions: usize, padding: usize) -> Vec<u8> {
    let mut module = b"\0asm\x01\0\0\0".to_vec();
    section(&mut module, 1, &[2, 0x60, 0, 1, 0x7f, 0x60, 0, 0]);
    let mut declarations = Vec::new();
    leb(&mut declarations, functions);
    declarations.push(0);
    declarations.resize(declarations.len() + functions - 1, 1);
    section(&mut module, 3, &declarations);
    let mut exports = vec![1, 13];
    exports.extend_from_slice(b"__abi_version");
    exports.extend_from_slice(&[0, 0]);
    section(&mut module, 7, &exports);
    let mut code = Vec::new();
    leb(&mut code, functions);
    code.extend_from_slice(&[4, 0, 0x41, 55, 0x0b]);
    for _ in 1..functions {
        leb(&mut code, padding + 2);
        code.push(0);
        code.resize(code.len() + padding, 1);
        code.push(0x0b);
    }
    section(&mut module, 10, &code);
    module
}

fn measured(module: &[u8]) -> (Option<i32>, usize) {
    LARGEST.with(|largest| largest.set(0));
    WATCH.with(|watch| watch.set(true));
    let result = wasm_artifact::facts::read_i32_const_export(module, "__abi_version");
    WATCH.with(|watch| watch.set(false));
    (result, LARGEST.with(Cell::get))
}

#[test]
fn marker_read_does_not_copy_a_large_unrelated_body() {
    let module = fixture(2, 4 * 1024 * 1024);
    let (result, largest) = measured(&module);
    assert_eq!(result, Some(55));
    assert!(largest <= 4096, "marker read allocated {largest} bytes at once");
}

#[test]
fn marker_read_does_not_catalog_every_unrelated_body() {
    let module = fixture(20_000, 0);
    let (result, largest) = measured(&module);
    assert_eq!(result, Some(55));
    assert!(largest <= 4096, "marker read allocated {largest} bytes at once");
}

#[test]
fn follows_forward_and_backward_wrappers_past_constructor_calls() {
    for source in [
        "(module (import \"env\" \"ctor\" (func $ctor)) (func $value (result i32) call $ctor i32.const 55) (func (export \"__abi_version\") (result i32) call $value))",
        "(module (func (export \"__abi_version\") (result i32) call $value) (func $value (result i32) i32.const 55 return))",
    ] {
        assert_eq!(measured(&wat::parse_str(source).unwrap()).0, Some(55));
    }
}

#[test]
fn wrapper_cycles_and_depth_exhaustion_do_not_guess_a_marker() {
    let cyclic = wat::parse_str("(module (func $first (export \"__abi_version\") (result i32) call $second) (func $second (result i32) call $first))").unwrap();
    assert_eq!(measured(&cyclic).0, None);
    for links in [4, 5] {
        let mut source = String::from("(module ");
        for index in 0..links {
            let export = if index == 0 { "(export \"__abi_version\")" } else { "" };
            source.push_str(&format!("(func $marker{index} {export} (result i32) call $marker{}) ", index + 1));
        }
        source.push_str(&format!("(func $marker{links} (result i32) i32.const 55))"));
        assert_eq!(measured(&wat::parse_str(source).unwrap()).0, if links == 4 { Some(55) } else { None });
    }
}

#[test]
fn an_imported_or_absent_marker_has_no_constant_body() {
    let imported = wat::parse_str("(module (import \"env\" \"marker\" (func (result i32))) (export \"__abi_version\" (func 0)))").unwrap();
    assert_eq!(measured(&imported).0, None);
    assert_eq!(measured(b"\0asm\x01\0\0\0").0, None);
    assert_eq!(measured(b"not wasm").0, None);
}

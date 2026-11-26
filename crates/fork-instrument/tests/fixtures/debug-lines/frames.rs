// Compiler-only DWARF fixture; no sysroot, guest kernel or std emulation.
#![feature(no_core, lang_items)]
#![no_core]
#[lang = "pointee_sized"]
pub trait PointeeSized {}
#[lang = "meta_sized"]
pub trait MetaSized: PointeeSized {}
#[lang = "sized"]
pub trait Sized: MetaSized {}
#[link(wasm_import_module = "env")] unsafe extern "C" { fn capture(); }
#[inline(never)]
#[unsafe(no_mangle)]
pub extern "C" fn inner() {
    unsafe {
        capture();
    }
}
#[inline(never)]
#[unsafe(no_mangle)]
pub extern "C" fn outer() {
    inner();
}

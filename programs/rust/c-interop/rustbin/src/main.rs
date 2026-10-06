//! Rust program linked against a C static library (../clib). Prints one
//! line per check and exits nonzero if any check fails.

use std::ffi::{c_char, c_int, c_void, CStr, CString};

/// Mirrors `struct record` in clib/cside.c.
#[repr(C)]
#[derive(Default)]
struct Record {
    tag: u8,
    big: u64,
    small: u16,
    ratio: f64,
}

extern "C" {
    fn c_record_size() -> usize;
    fn c_record_fill(r: *mut Record);
    fn c_u128_muldiv(a: u64, b: u64, d: u64) -> u64;
    fn c_sort_ints(v: *mut c_int, n: usize, cmp: extern "C" fn(*const c_void, *const c_void) -> c_int);
    fn c_describe(n: c_int) -> *mut c_char;
    fn c_set_errno(e: c_int);
    fn c_getenv(key: *const c_char) -> *const c_char;
    fn free(p: *mut c_void);
}

extern "C" fn descending(a: *const c_void, b: *const c_void) -> c_int {
    let (a, b) = unsafe { (*(a as *const c_int), *(b as *const c_int)) };
    b.cmp(&a) as c_int
}

fn main() {
    let mut failures = 0;
    let mut check = |ok: bool, what: &str| {
        println!("{} {what}", if ok { "ok" } else { "FAIL" });
        if !ok {
            failures += 1;
        }
    };

    let mut r = Record::default();
    unsafe { c_record_fill(&mut r) };
    check(
        unsafe { c_record_size() } == std::mem::size_of::<Record>()
            && r.tag == 7
            && r.big == 0x0123_4567_89ab_cdef
            && r.small == 0xbeef
            && r.ratio == 0.25,
        "repr(C) struct layout",
    );

    // compiler-rt (C) and compiler_builtins (Rust) both define these.
    let from_rust = (u64::MAX as u128 * 3 / 5) as u64;
    check(unsafe { c_u128_muldiv(u64::MAX, 3, 5) } == from_rust, "u128 muldiv matches Rust");

    let mut v = [3, 9, 1, 7];
    unsafe { c_sort_ints(v.as_mut_ptr(), v.len(), descending) };
    check(v == [9, 7, 3, 1], "Rust callback called from C qsort");

    let s = unsafe { c_describe(42) };
    check(unsafe { CStr::from_ptr(s) }.to_str() == Ok("C says 42"), "C-owned string");
    unsafe { free(s.cast()) };

    unsafe { c_set_errno(2) };
    check(std::io::Error::last_os_error().raw_os_error() == Some(2), "shared errno");

    unsafe { std::env::set_var("INTEROP_FROM_RUST", "yes") };
    let key = CString::new("INTEROP_FROM_RUST").unwrap();
    let v = unsafe { c_getenv(key.as_ptr()) };
    check(!v.is_null() && unsafe { CStr::from_ptr(v) }.to_bytes() == b"yes", "shared environment");

    println!("{}", if failures == 0 { "RUST-CALLS-C OK" } else { "RUST-CALLS-C FAILED" });
    std::process::exit(if failures == 0 { 0 } else { 1 });
}

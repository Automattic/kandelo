//! Rust program linked against a C++ static library (../cpplib). Prints
//! one line per check and exits nonzero if any check fails.

use std::ffi::{c_char, c_int, CStr, CString};

extern "C" {
    fn cpp_global_value(key: *const c_char) -> c_int;
    fn cpp_total_area() -> i64;
    fn cpp_parse_positive(text: *const c_char, out: *mut c_int) -> c_int;
    fn cpp_map_sum(v: *const i32, n: usize, f: extern "C" fn(i32) -> i32) -> i64;
    fn cpp_concat(a: *const c_char, b: *const c_char, buf: *mut c_char, cap: usize) -> c_int;
}

extern "C" fn square(x: i32) -> i32 {
    x * x
}

fn parse(text: &str) -> (c_int, c_int) {
    let text = CString::new(text).unwrap();
    let mut out = 0;
    let rc = unsafe { cpp_parse_positive(text.as_ptr(), &mut out) };
    (rc, out)
}

fn main() {
    let mut failures = 0;
    let mut check = |ok: bool, what: &str| {
        println!("{} {what}", if ok { "ok" } else { "FAIL" });
        if !ok {
            failures += 1;
        }
    };

    let key = CString::new("constructed").unwrap();
    check(unsafe { cpp_global_value(key.as_ptr()) } == 42, "C++ global constructor ran");

    check(unsafe { cpp_total_area() } == 37, "C++ virtual dispatch");

    check(parse("17") == (0, 17), "C++ parse without exception");
    check(parse("x").0 == -1, "C++ exception caught (invalid_argument)");
    check(parse("-3").0 == -2, "C++ exception caught (range_error)");

    let v = [1, 2, 3, 4];
    check(unsafe { cpp_map_sum(v.as_ptr(), v.len(), square) } == 30, "Rust callback through std::function");

    let (a, b) = (CString::new("rust").unwrap(), CString::new("c++").unwrap());
    let mut buf = [0 as c_char; 32];
    let n = unsafe { cpp_concat(a.as_ptr(), b.as_ptr(), buf.as_mut_ptr(), buf.len()) };
    check(
        n == 8 && unsafe { CStr::from_ptr(buf.as_ptr()) }.to_bytes() == b"rust+c++",
        "std::string into a Rust buffer",
    );

    println!("{}", if failures == 0 { "RUST-CALLS-CPP OK" } else { "RUST-CALLS-CPP FAILED" });
    std::process::exit(if failures == 0 { 0 } else { 1 });
}

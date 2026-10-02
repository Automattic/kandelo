//! Kandelo interop fixture (M7.1): a Rust `staticlib` that uses `std`,
//! exposing a C ABI. A C `main` links it via the SDK and calls in. This
//! validates sharing a Rust-built library with C/C++ on Kandelo, including
//! that Rust's compiler_builtins intrinsics don't collide with the SDK's
//! compiler_rt glue at link time.
use std::ffi::{c_char, c_int, CStr};
use std::io::Write;

/// Pure arithmetic — no runtime needed.
#[no_mangle]
pub extern "C" fn rust_add(a: c_int, b: c_int) -> c_int {
    a + b
}

/// Exercises std from within a staticlib called by C: CStr, String/format,
/// heap allocation, and stdout — all without Rust's `lang_start` running.
#[no_mangle]
pub extern "C" fn rust_greet(name: *const c_char) -> c_int {
    let name = unsafe { CStr::from_ptr(name) }.to_string_lossy().into_owned();
    let msg = format!("Rust std staticlib says hi to {name}\n");
    let _ = std::io::stdout().write_all(msg.as_bytes());
    let _ = std::io::stdout().flush();
    msg.len() as c_int
}

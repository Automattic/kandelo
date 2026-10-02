//! A std-using Rust library with a C API, linked into C and C++ programs
//! by the c-interop test. Each function exercises something that must be
//! shared with, or agree with, the C side of the link.

use std::ffi::{c_char, c_int, CStr, CString};

/// 128-bit multiply and divide lower to compiler intrinsics (__multi3,
/// __udivti3). The C side links compiler-rt's copies of the same symbols.
#[no_mangle]
pub extern "C" fn interop_u128_muldiv(a: u64, b: u64, d: u64) -> u64 {
    let product = a as u128 * b as u128;
    (product / d as u128) as u64
}

/// Returns a heap string the caller releases with interop_free_string.
#[no_mangle]
pub unsafe extern "C" fn interop_greeting(name: *const c_char) -> *mut c_char {
    let name = unsafe { CStr::from_ptr(name) }.to_string_lossy();
    CString::new(format!("hello, {name}, from Rust"))
        .expect("no interior NUL")
        .into_raw()
}

#[no_mangle]
pub unsafe extern "C" fn interop_free_string(s: *mut c_char) {
    if !s.is_null() {
        drop(unsafe { CString::from_raw(s) });
    }
}

/// Calls back into the caller: a function pointer crossing the language
/// boundary must match the callee's type exactly (wasm call_indirect).
#[no_mangle]
pub extern "C" fn interop_apply(f: extern "C" fn(c_int) -> c_int, x: c_int) -> c_int {
    f(f(x))
}

/// errno is musl's thread-local: an error the C side caused is visible
/// to Rust's std only if both use the same libc.
#[no_mangle]
pub extern "C" fn interop_last_errno() -> c_int {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(-1)
}

/// The environment is musl's `environ`: C's getenv sees what Rust sets.
#[no_mangle]
pub unsafe extern "C" fn interop_setenv(key: *const c_char, value: *const c_char) {
    let key = unsafe { CStr::from_ptr(key) }.to_str().expect("utf-8 key");
    let value = unsafe { CStr::from_ptr(value) }.to_str().expect("utf-8 value");
    unsafe { std::env::set_var(key, value) };
}

/// std::fs writes through the same file descriptors C reads.
#[no_mangle]
pub unsafe extern "C" fn interop_write_file(path: *const c_char, text: *const c_char) -> c_int {
    let path = unsafe { CStr::from_ptr(path) }.to_str().expect("utf-8 path");
    let text = unsafe { CStr::from_ptr(text) }.to_bytes();
    match std::fs::write(path, text) {
        Ok(()) => 0,
        Err(e) => e.raw_os_error().unwrap_or(-1),
    }
}

/// std::thread inside a library called from a C main: pthreads, futexes
/// and the allocator all come from the shared musl.
#[no_mangle]
pub extern "C" fn interop_parallel_sum(threads: u32, per_thread: u32) -> u64 {
    let handles: Vec<_> = (0..threads)
        .map(|t| {
            std::thread::spawn(move || {
                (0..per_thread as u64).map(|i| i + t as u64).sum::<u64>()
            })
        })
        .collect();
    handles.into_iter().map(|h| h.join().expect("thread panicked")).sum()
}

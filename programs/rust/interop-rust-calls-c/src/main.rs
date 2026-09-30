//! Kandelo interop fixture (M7.1, reverse direction): a Rust program that
//! links a C static library (built by build.rs with the SDK) and calls it.
use std::ffi::c_int;

extern "C" {
    fn c_triple(x: c_int) -> c_int;
}

fn main() {
    let x = 14;
    let y = unsafe { c_triple(x) };
    println!("Rust called C: c_triple({x}) = {y}");
    assert_eq!(y, 42);
    println!("Rust <- C static link OK");
}

// Compile the C library with the Kandelo SDK (targeting wasm32-unknown-kandelo)
// and link it statically into the Rust program. wasm32posix-cc/-ar are on PATH
// inside scripts/dev-shell.sh; they compile the C with the same wasm features
// (atomics/bulk-memory) the Rust objects use, so wasm-ld links them together.
use std::process::Command;

fn main() {
    let out = std::env::var("OUT_DIR").unwrap();
    let obj = format!("{out}/ctriple.o");
    let lib = format!("{out}/libctriple.a");
    assert!(Command::new("wasm32posix-cc")
        .args(["-c", "c/ctriple.c", "-o", &obj]).status().unwrap().success());
    assert!(Command::new("wasm32posix-ar")
        .args(["rcs", &lib, &obj]).status().unwrap().success());
    println!("cargo:rustc-link-search=native={out}");
    println!("cargo:rustc-link-lib=static=ctriple");
    println!("cargo:rerun-if-changed=c/ctriple.c");
}

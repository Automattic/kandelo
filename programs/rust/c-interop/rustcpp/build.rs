//! Builds ../cpplib/cppside.cpp into a static library with the Kandelo
//! SDK (wasm32posix-c++, wasm32posix-ar) and links it with the C++
//! runtime. rustc links through wasm32posix-cc, a C driver, so libc++ and
//! libc++abi are named here.

use std::path::PathBuf;
use std::process::Command;

fn run(cmd: &mut Command) {
    let status = cmd.status().unwrap_or_else(|e| panic!("{cmd:?}: {e}"));
    assert!(status.success(), "{cmd:?} failed: {status}");
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let src = manifest.join("../cpplib/cppside.cpp");
    let obj = out.join("cppside.o");
    let lib = out.join("libcppside.a");

    // -fwasm-exceptions: the library throws and catches C++ exceptions.
    run(Command::new("wasm32posix-c++")
        .args(["-O2", "-fwasm-exceptions", "-c"])
        .arg(&src)
        .arg("-o")
        .arg(&obj));
    let _ = std::fs::remove_file(&lib);
    run(Command::new("wasm32posix-ar").arg("rcs").arg(&lib).arg(&obj));

    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=cppside");
    println!("cargo:rustc-link-lib=c++");
    println!("cargo:rustc-link-lib=c++abi");
    println!("cargo:rerun-if-changed={}", src.display());
}

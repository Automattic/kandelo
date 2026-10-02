//! Builds ../clib/cside.c into a static library with the Kandelo SDK
//! (wasm32posix-cc, wasm32posix-ar) and links it.

use std::path::PathBuf;
use std::process::Command;

fn run(cmd: &mut Command) {
    let status = cmd.status().unwrap_or_else(|e| panic!("{cmd:?}: {e}"));
    assert!(status.success(), "{cmd:?} failed: {status}");
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let src = manifest.join("../clib/cside.c");
    let obj = out.join("cside.o");
    let lib = out.join("libcside.a");

    run(Command::new("wasm32posix-cc").args(["-O2", "-c"]).arg(&src).arg("-o").arg(&obj));
    let _ = std::fs::remove_file(&lib);
    run(Command::new("wasm32posix-ar").arg("rcs").arg(&lib).arg(&obj));

    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=cside");
    println!("cargo:rerun-if-changed={}", src.display());
}

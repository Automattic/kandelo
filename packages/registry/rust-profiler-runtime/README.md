# Rust profiler runtime

This component builds LLVM's instrumentation runtime and Rust's upstream
`profiler_builtins` crate for `wasm32-unknown-kandelo-std`. It supplies the
runtime that `-C instrument-coverage` expects to find in the target sysroot.
`rust-profiler-runtime-bundle` installs it for the shell and standalone SDK.

The LLVM source is the exact submodule pinned by the SDK's Rust compiler.
The wrapper crate and its source list come from the same pinned compiler's
immutable `rust-src` component. The build checks that compiler commit,
uses the target by name, and verifies that every C/C++ archive member is a
wasm32 object. Upstream's Wasm platform guards select the implementation;
no Linux or WASI platform identity is injected.

Rust's wrapper crate uses `no_core`, so it can be built without depending
on the guest compiler package or a particular build of `core`. Its native
archive is bundled into the rlib through ordinary rustc static linking.
The separate C archive is also available for explicit SDK integration.

Bring-up exercised an actual Rust program compiled with
`-C instrument-coverage`, prepared by the normal fork instrumenter and
optimizer, and run on Node, Chromium, Firefox and WebKit. Normal process
exit wrote a profile that the declared native LLVM tools could merge and
report, including an unexecuted source region. That check used native
LLVM 21.1.7. Matching guest LLVM 22.1.2 tools also merged that real
profile and generated JSON, text and HTML reports in Node; corrupt profiles
were rejected. Ordinary Cargo/SDK bundle acceptance remains pending. Crash/abort flushing has not been validated.

# Rust native-dependency acceptance sources

This optional fixture-data package prepares an offline Cargo workspace using
unmodified, checksum-verified `cc`, `find-msvc-tools` and `shlex` crates.
`Cargo.lock` pins their exact versions and archive hashes. The recipe runs
`cargo vendor --locked`; it compiles nothing on the build machine and
writes only under the resolver's work and output roots. The declared
output is `share/kandelo/rust-native-fixtures.zip`; it contains sources and
licenses, with no host binaries.

Guest acceptance copies this source tree into its ordinary persistent VFS.
Cargo then compiles the dependency crates and build script inside Kandelo,
where the build script compiles C/C++, archives their objects and links an
executable that actually calls both languages. The C++ global vector also
requires startup initialization.

The current SDK needs explicit native-tool settings for this case:

```sh
export CC=wasm32posix-cc CXX=wasm32posix-c++ AR=wasm32posix-ar
export CXXSTDLIB=c++
cargo run --offline --locked -j1
```

Default `cc` discovery currently searches for `clang` on PATH, while the SDK
exposes its public drivers as `cc`, `c++` and `wasm32posix-*`. Acceptance
records that failure separately from the configured successful build.
The configured case currently passes on Node, Chromium and Firefox. On
WebKit, guest rustc exhausts its native Wasm call stack while compiling the
`cc` crate, before the native build script runs. Its acceptance case requires
both the real worker diagnostic and compiler exit 139, and records this as
an unsupported capability. It does not claim native dependency execution.
Changing build-dependency code-generation units to 16 also failed.

This does not validate the `parallel` feature, arbitrary configure tools or
unmodified registry versions of `libc`.

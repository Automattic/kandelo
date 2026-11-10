# Rust coverage reporting tools

`llvm-profdata` merges raw instrumentation profiles. `llvm-cov` exports
coverage and renders text or HTML reports from the prepared Wasm binary.
Both use the exact LLVM source revision pinned by Kandelo's Rust compiler.
They link the existing `rust-llvm` library rather than rebuilding LLVM.

Rust's raw profile names use zlib compression. The reporter therefore
rebuilds upstream LLVM's compression translation unit with its declared
zlib dependency and links that object before the static LLVM archive.
The other library objects remain unchanged. Zstd formats are not enabled.
These tools do not add instrumentation to a program: compile Rust with
`-C instrument-coverage` and the matching profiler runtime first.

Source display uses ordinary guest filesystem access. Make the source
available in that filesystem before requesting text or HTML source reports.

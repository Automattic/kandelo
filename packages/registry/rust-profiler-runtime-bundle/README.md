# Rust profiler runtime archive

This deterministic lazy archive installs the matching `profiler_builtins`
rlib under `/usr/lib/rustlib/wasm32-unknown-kandelo-std/lib`. The shell and
the standalone Rust SDK use the same archive. Its contents are fetched on
first use; enabling coverage does not retain the toolchain in kernel memory.

The native runtime is built by `rust-profiler-runtime`; this package only
assembles its guest installation tree and license notices.

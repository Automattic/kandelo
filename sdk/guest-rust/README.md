# Guest Rust compiler entry point

The experimental `kandelo-rust-sdk` bundle installs this program as
`/usr/bin/kandelo-rustc`, with `rustc` and `wasm32posix-rustc` symlinks.
The matching upstream compiler lives at `/usr/libexec/rustc`.

Cargo invokes rustc for version, target and filename probes as well as
compilation. This entry point supplies the installed custom target's sysroot
and unstable-target flag for all of them. It reads linked paths from Cargo's JSON artifact stream, forwarding the
compiler's diagnostics unchanged. Direct human-diagnostic invocations use
a filename query. It prepares WebAssembly modules importing
`kernel.kernel_fork` with the installed `wasm-fork-instrument`. The
instrumenter performs normal optimization, validation and atomic publication;
a failure propagates to Cargo. Compiler diagnostics and streams pass through.

This is a standalone Cargo workspace because it is an optional guest SDK
program, rather than a native repository tool. Its recipe uses the shared
Rust package environment and libc fork. On the build machine continue to use
`sdk/bin/wasm32posix-cargo`; this entry point requires a Kandelo guest.

See `docs/rust-target.md` for supported workflows and acceptance tests.

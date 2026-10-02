# Rust guest fixtures

Standalone Rust programs that build for `wasm32-unknown-kandelo` and run
on the kernel. They validate the Rust target end-to-end (codegen → SDK
link against musl → syscall channel → kernel).

- `hello/` — P0: `no_std`, exports `__main_argc_argv`, writes a greeting.
- `alloc-demo/` — P1: `no_std` + `alloc` via a malloc-backed global
  allocator (`Vec`/`String`/`format!`).
- `std-hello/` — P2: a full-`std` program with a normal `fn main`
  (bin crate, SDK-linked directly) exercising stdio, args, env, fs,
  time, and HashMap on the kernel.
- `thread-demo/` — P4: std::thread + std::sync::Mutex/Arc (pthread ->
  clone, futex-backed locking), deterministic shared-counter total.
- `net-demo/` — P5: std::net TCP loopback (bind/accept/connect/echo).
- `proc-demo/` — P3: std::process::Command (fork+exec self-spawn).
  REQUIRES fork instrumentation (see the fixture header).
- `std-boundaries/` — std's failure paths (errno through `io::Error`,
  refused connections, missing programs), `Backtrace` reporting
  `Unsupported`, and abort on panic.
- `c-interop/` — Rust and C/C++ in one program: a std-using Rust static
  library (installed with cargo-c) linked into a C and a C++ program, and
  a C and a C++ static library each linked into a Rust program.
  `build.sh` builds all four; `host/test/rust-c-interop.test.ts` builds
  and runs them.

`host/test/rust-std.test.ts` builds the std fixtures with
`wasm32posix-cargo` and runs them. Build/run: see `sdk/rust/README.md`. Run with
`npx tsx examples/run-wasm.ts <fixture>/<name>.wasm` (a self-contained
runner that skips builtin-program discovery).

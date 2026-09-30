# Running Rust on Kandelo (`wasm32-unknown-kandelo`)

Kandelo can build and run generic Rust programs with full `std` — files,
processes, threads, and networking — through the normal platform path
(SDK → libc → syscalls → kernel). Rust's POSIX `unix` platform layer is
routed to an honest new `target_os = "kandelo"` backed by Kandelo's musl.

## Quick start

From a Rust package directory, inside `scripts/dev-shell.sh`:

```
wasm32posix-cargo run --release -- [program args]   # build + run
wasm32posix-cargo build --release                   # build only
```

Write ordinary Rust with a normal `fn main`. The first invocation
assembles a private Rust sysroot (a few seconds); subsequent builds are
incremental. See the fixtures under `programs/rust/` for worked examples.

## What works

Verified on the kernel (see `programs/rust/*`):

| Area | Example | Notes |
|---|---|---|
| stdio, formatting | `println!`, `eprintln!` | |
| args, env | `std::env::args`, `std::env::var` | via `lang_start` |
| files | `std::fs`, `std::io` | open/read/write/stat/dirs |
| time | `std::time::Instant`, `SystemTime` | monotonic + realtime |
| collections/rand | `HashMap` | getrandom-seeded SipHash |
| threads | `std::thread`, `Mutex`, `Arc` | pthread→clone, futex, TLS |
| networking | `std::net` TCP | loopback + Node external TCP |
| processes | `std::process::Command` | fork+exec (see below) |

## Sharing libraries with C/C++

Rust and C/C++ link against one shared musl, so static interop works in
both directions (validated on the kernel — see
`programs/rust/interop-c-calls-rust/` and `interop-rust-calls-c/`).

**C/C++ calls Rust:** build the Rust crate as `crate-type =
["staticlib"]` exposing `#[no_mangle] extern "C"` functions, then link the
`.a` with the rest via the SDK:

```
# build the Rust staticlib (see the fixture's .cargo/config.toml)
cargo build --release -Z unstable-options -Z json-target-spec \
  -Z build-std=std,panic_abort --target sdk/rust/wasm32-unknown-kandelo-std.json
# link a C/C++ program against it (wasm32posix-c++ for C++)
wasm32posix-cc main.c target/wasm32-unknown-kandelo-std/release/lib<name>.a -o prog.wasm
```

A Rust `std` staticlib works even though the C `main`, not Rust's
`lang_start`, is the entry: the allocator is malloc-backed, `panic =
abort`, and stdio lazy-initializes. You only lose `std::env::args`, which
a library does not need. C++ is identical — declare the Rust functions
`extern "C"`.

**Rust calls C/C++:** compile the C/C++ to a static lib with the SDK and
link it from the Rust build. A `build.rs` can do it in one step:

```rust
Command::new("wasm32posix-cc").args(["-c", "c/foo.c", "-o", &obj]).status()?;
Command::new("wasm32posix-ar").args(["rcs", &lib, &obj]).status()?;
println!("cargo:rustc-link-search=native={out}");
println!("cargo:rustc-link-lib=static=foo");
```

Both sides must be built for `wasm32-unknown-kandelo` (the SDK compiles C
with the matching `+atomics,+bulk-memory` features, so `wasm-ld` links
them). No `compiler_builtins`/`compiler_rt` intrinsic collisions occur.
Dynamic loading (`dlopen` of a Rust `cdylib`) is a separate, unvalidated
path.

## Fork-using programs need instrumentation

`std::process` (and anything reaching `fork`) uses fork+exec on musl.
Kandelo runs `fork` via a compile-time Wasm transform
(`wasm-fork-instrument`), and the kernel refuses an uninstrumented
artifact at guest-initiated exec. `wasm32posix-cargo` detects fork-using
outputs (they import `kernel.kernel_fork`) and runs
`scripts/run-wasm-fork-instrument.sh` automatically. `wasm-fork-instrument`
is verified to work on Rust/LLVM codegen.

## Documented boundaries

These return the correct failure (POSIX-honest), not a fake success:

- **Stack-overflow guard pages don't fault** — Wasm can't revoke a
  mapping and `mprotect` is a no-op, so a stack overflow is a generic
  Wasm trap, not std's clean overflow message.
- **`panic = "abort"`** is the target default (unwinding is not wired).
- **`std::net`**: external UDP is `ENETUNREACH` on Node; the browser host
  has no raw/server sockets; DNS/`getaddrinfo` is a stub (use literal IPs
  or resolve out-of-band).
- **`MAP_SHARED` memfd**, `pthread_cancel`, dynamic TLS across `dlopen`:
  unsupported.

## How it is built (for maintainers)

The dev-shell Rust is a bare Nix toolchain (no rustup) and `std`'s `libc`
cannot be overridden by a user `[patch.crates-io]` under `-Zbuild-std`.
So the libc fork and `std` change are delivered as a `rust-src` overlay
in a private sysroot:

- `sdk/rust/wasm32-unknown-kandelo{,-std}.json` — target specs. The std
  spec uses `target-family = ["unix","wasm"]`, links via the SDK driver
  (`linker = wasm32posix-cc`, `entry-name = __main_argc_argv`), and bakes
  in `+atomics,+bulk-memory`.
- `sdk/rust/libc-upstream/` (submodule, `rust-lang/libc` pinned to the
  version `std` uses) + `sdk/rust/libc-kandelo.patch` (our delta:
  `kandelo` arms reusing linux-musl bindings + a reconciled wasm32 arch
  leaf). The crate is NOT vendored; the fork is assembled at build time
  (submodule + patch), mirroring how `build-musl.sh` overlays
  `libc/musl-overlay` onto the `libc/musl` submodule. A libc version bump
  makes the patch fail loudly — the signal to refresh the delta.
- `sdk/rust/std-overlay/` — the `library/std` `kandelo` pal arms
  (file-copy overlay onto the toolchain's `rust-src`, which is not a
  submodule).
- `scripts/build-rust-sysroot.sh` — assembles the fork (submodule +
  patch) and the private sysroot (mirror-by-symlink + patched `rust-src`)
  and a `rustc` wrapper that injects `--sysroot`;
  `scripts/export-rust-overlay.sh` captures std-overlay edits.

First checkout: `git submodule update --init sdk/rust/libc-upstream`.

Builds require `-Z unstable-options -Z json-target-spec
-Z build-std=std,panic_abort` and `RUST_LIBC_UNSTABLE_MUSL_V1_2_3=1`
(musl v1.2.3 time64); `wasm32posix-cargo` supplies all of these.

Design and history: `docs/plans/2026-09-06-rust-std-target-design.md`
and `docs/plans/2026-09-07-rust-std-target-implementation.md`.

## Status

Full-`std` parity is demonstrated. Remaining hardening: reconcile the
remaining WALI-derived constants/syscall numbers in the wasm32 libc leaf
to Kandelo's ABI (none has affected the demonstrated surface), and
upstream the target as tier-3.

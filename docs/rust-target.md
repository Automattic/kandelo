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

## Packaging a Rust library as a Kandelo package

A Rust library ships as a normal registry package whose build step drives
the Rust toolchain. The reference is `packages/registry/rustdemo/` (a Rust
crate with a C ABI), consumed end-to-end by
`packages/registry/rustdemo-check/`.

The shape, following the in-tree-source convention (like `libffi`):

- `package.toml`: `kind = "library"`, a placeholder `[source]`
  (`example.invalid`, zero sha → `provider = "repository"`) because the
  crate is in-tree, and `[outputs]` naming the installed
  `lib/lib<name>.a`, `include/<name>.h`, `lib/pkgconfig/<name>.pc`.
- `build.toml`: the `inputs` closure listing the crate, header, and build
  script so edits invalidate the cache.
- `build-<name>.sh`: run `scripts/build-rust-sysroot.sh` to assemble the
  private sysroot, then `cargo build --release -Z build-std=std,panic_abort
  --target sdk/rust/wasm32-unknown-kandelo-std.json` with
  `RUSTC=$KANDELO_RUST_DIR/rustc-kandelo` and
  `RUST_LIBC_UNSTABLE_MUSL_V1_2_3=1`, build the crate as `crate-type =
  ["staticlib"]`, and install the `.a` + header + `.pc` into
  `$WASM_POSIX_DEP_OUT_DIR`.

C/C++ packages then `depends_on = ["<name>@<version>"]` and link it with
the resolver-supplied `-I<prefix>/include` / `-L<prefix>/lib`, exactly
like any C library (see `rustdemo-check`).

Open follow-ups for real Rust packages: the sysroot is assembled under
`$HOME/.kandelo` (a toolchain cache outside the resolver work dir), and
crate dependencies must be vendored for an offline, reproducible build
(the reference crate has none). Whether to include such packages in
`packages/sets/local-supported.toml` is a build-time-cost tradeoff — the
whole Rust toolchain builds — left to maintainers.

## Status

Full-`std` parity is demonstrated. Remaining hardening: reconcile the
remaining WALI-derived constants/syscall numbers in the wasm32 libc leaf
to Kandelo's ABI (none has affected the demonstrated surface), and
upstream the target as tier-3.

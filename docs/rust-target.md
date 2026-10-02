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
- `sdk/rust/std-overlay/` — `kandelo` arms in `library/std` (the unix
  pal and errno) and `library/unwind` (file-copy overlay onto the
  toolchain's `rust-src`, which is not a submodule).
- `scripts/build-rust-sysroot.sh` — assembles the fork (submodule +
  patch) and the private sysroot (mirror-by-symlink + patched `rust-src`),
  installs the std target spec as
  `lib/rustlib/wasm32-unknown-kandelo-std/target.json`, compiles `std`
  for that target once into `lib/rustlib/wasm32-unknown-kandelo-std/lib/`,
  and writes a `rustc` wrapper that injects `--sysroot` and
  `-Zunstable-options` (rustc resolves a custom target by name from the
  sysroot only with that flag);
  `scripts/export-rust-overlay.sh` captures std-overlay edits.

First checkout: `git submodule update --init sdk/rust/libc-upstream`.

With the prebuilt `std` in the sysroot, the target behaves like an
installed Rust target: builds need only the `RUSTC` wrapper,
`RUST_LIBC_UNSTABLE_MUSL_V1_2_3=1` (musl v1.2.3 time64) and
`--target wasm32-unknown-kandelo-std` — no per-build `-Z build-std` or
`-Z json-target-spec`. `wasm32posix-cargo` supplies these. The target
must be selected by name, not by JSON path: rlibs record their target
identity, and the prebuilt `std` does not load into a build that names
the target by path (E0461). `scripts/build-rust-sysroot.sh` records a
digest of its inputs (the script, target spec, libc submodule commit and
patch, std overlay, and toolchain) and rebuilds only when it changes, so
`wasm32posix-cargo` runs it before every build. Cargo does not track the
sysroot's `std`, so after a rebuild `wasm32posix-cargo` also discards the
crate's `target/wasm32-unknown-kandelo-std/` output; a build that drives
cargo directly against a changed sysroot needs a clean target directory.

### Rust libraries with a C API (cargo-c)

The dev shell provides `cargo-c` (`cargo cbuild` / `cargo cinstall`),
which builds a Rust crate as a C library with a header and a `.pc` file;
Meson builds such as librsvg's drive it. Upstream cargo-c picks output
file names per target OS and rejects an OS it does not list, so
`flake.nix` applies `sdk/rust/cargo-c-kandelo.patch`, which adds
`kandelo` to its build and install tables (`lib<name>.a`/`.so`, as for
other ELF-style unix OSes). For example:

```
RUSTC=$HOME/.kandelo/rust/rustc-kandelo RUST_LIBC_UNSTABLE_MUSL_V1_2_3=1 \
  cargo cinstall --release --target wasm32-unknown-kandelo-std \
    --library-type staticlib --prefix "$PREFIX"
wasm32posix-cc main.c \
  $(PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig" pkg-config --static --cflags --libs <name>) \
  -o main.wasm
```

The generated `.pc` lists `-lc`, rustc's native static libraries for the
target. Upstream's `unwind` crate requests `-lgcc_s` on musl targets;
Kandelo has no unwinder library, so the std overlay drops that request
for `target_os = "kandelo"` rather than leaving a library that build
systems (e.g. Meson's `find_library`) look up and cannot find.

Design and history: `docs/plans/2026-09-06-rust-std-target-design.md`
and `docs/plans/2026-09-07-rust-std-target-implementation.md`.

## Status

Full-`std` parity is demonstrated. Remaining hardening: reconcile the
remaining WALI-derived constants/syscall numbers in the wasm32 libc leaf
to Kandelo's ABI (none has affected the demonstrated surface), and
upstream the target as tier-3.

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
| CPU count | `std::thread::available_parallelism` | `sysconf(_SC_NPROCESSORS_ONLN)`; the kernel reports 1 |
| fd duplication | `OwnedFd::try_clone`, `StdioExt::set_fd` | `F_DUPFD_CLOEXEC`, `dup2` |
| networking | `std::net` TCP | loopback + Node external TCP |
| processes | `std::process::Command` | fork+exec (see below) |

## Sharing libraries with C and C++

Rust and C/C++ code link into one program against one musl, so static
libraries work in both directions. `programs/rust/c-interop/` builds
all four combinations, and `host/test/rust-c-interop.test.ts` runs them
on the kernel.

**C or C++ calls Rust.** Build the crate as a static library
(`crate-type = ["staticlib"]`) that exports `#[no_mangle] extern "C"`
functions, and link the `.a` into the program with `wasm32posix-cc` or
`wasm32posix-c++`. `cargo cinstall` (see "Rust libraries with a C API"
below) also installs a `.pc` file, so build systems can find the library
through pkg-config. C++ declares the Rust functions `extern "C"`.

A std-using library works even though the C `main`, not Rust's
`lang_start`, starts the program: the allocator (musl's `malloc`),
stdio, files, threads, and the environment are shared with the C code.
`std::env::args()` is empty, because std collects arguments in its own
entry point, which a C program never runs; pass them in explicitly.

**Rust calls C or C++.** Compile the C/C++ code into a static library
with the SDK and link it from the crate. A `build.rs` can do it:

```rust
Command::new("wasm32posix-cc").args(["-O2", "-c", "c/foo.c", "-o", &obj]).status()?;
Command::new("wasm32posix-ar").args(["rcs", &lib, &obj]).status()?;
println!("cargo:rustc-link-search=native={out}");
println!("cargo:rustc-link-lib=static=foo");
```

For C++, compile with `wasm32posix-c++` (add `-fwasm-exceptions` if the
code uses exceptions) and also link `c++` and `c++abi`: rustc links
through `wasm32posix-cc`, a C driver, which does not add the C++
runtime. C++ exceptions work inside the C++ code but must not propagate
into Rust frames (Rust here is `panic = "abort"` and does not unwind),
so a C++ API called from Rust catches its exceptions and returns
errors.

**What both sides share.** The Rust and C compiler runtimes both define
the 128-bit arithmetic helpers (`__multi3`, `__udivti3`, ...); they link
together without conflict. A program is fork-instrumented if any part
of it uses `fork`, whichever language that part is in (glib does).
Loading a Rust `cdylib` with `dlopen` is not validated.

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
- **`panic = "abort"`** is the target default (unwinding is not wired):
  a panic prints its message and the process exits by `SIGABRT` (status
  134).
- **Backtraces are unsupported**: there is no unwinder to walk the Wasm
  stack, so `std::backtrace::Backtrace` reports `Unsupported` and
  `RUST_BACKTRACE` adds nothing to a panic message. The std overlay selects
  the backtrace crate's `noop` backend for Kandelo.
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
  pal, errno, fd duplication and the CPU count), `library/unwind` and `library/backtrace` (file-copy
  overlay onto the toolchain's `rust-src`, which is not a submodule).
- `scripts/build-rust-sysroot.sh` — assembles the fork (submodule +
  patch) and the private sysroot (mirror-by-symlink + patched `rust-src`),
  installs the std target spec as
  `lib/rustlib/wasm32-unknown-kandelo-std/target.json`, compiles `std`
  for that target once into `lib/rustlib/wasm32-unknown-kandelo-std/lib/`
  with `-Cembed-bitcode=yes` (as rustup's std does, so a crate whose
  profile sets `lto` links),
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

### Rust packages

A build that compiles a third-party crate graph (its own `Cargo.lock`)
for the target sources `sdk/rust/build-env.sh` and calls:

```
source "$KANDELO/sdk/rust/build-env.sh"
kandelo_rust_build_env <src-dir> <work-dir> <dep-pkg-config-path> <patches-dir>
cargo build --locked --release --target "$KANDELO_RUST_TARGET"
```

`kandelo_rust_build_env`:

- assembles a private sysroot in `<work-dir>/rust`
  (`KANDELO_RUST_DIR=<work>/rust scripts/build-rust-sysroot.sh`) rather
  than sharing `~/.kandelo/rust` with other checkouts, and exports
  `KANDELO_RUST_DIR`, so `wasm32posix-cargo` uses the same sysroot (each
  package lists the sysroot's sources, and this helper, in `build.toml`
  `inputs`: they are not in the global toolchain fingerprint);
- moves the lockfile's `libc` to the fork's exact version (`[patch]`
  replaces only that version) with `cargo update -p libc --precise`;
- vendors the remaining crates with `cargo vendor --locked` (Cargo checks
  each against the lockfile's checksums), applies each
  `<patches-dir>/<crate>-<version>.patch` as a path override of that
  crate, then builds offline;
- writes these overrides to `$CARGO_HOME/config.toml`, because build
  systems such as Meson run cargo from their build directory with
  `--manifest-path`, and cargo finds `.cargo/config.toml` from its working
  directory, not from the manifest;
- sets `KANDELO_RUSTC`, the sysroot's `rustc` wrapper, for build systems
  that query the target themselves (librsvg's Meson cross file).

`packages/registry/librsvg/` (a library, through Meson and cargo-c),
`packages/registry/rsvg-convert/` (a program, through cargo) and
`packages/registry/wgpu-window/` (a windowed program with its own crate
patches) are the references. The function sets `CARGO_HOME` and offline
mode for the crate graph; a build that later runs the repository's own
cargo calls it in a subshell, so that cargo does not inherit them.

Programs that link such a library are fork-instrumented like any program
whose libraries use `fork` (glib does).

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

See "Sharing libraries with C and C++" above for the linking rules in
both directions.

Design and history: `docs/plans/2026-09-06-rust-std-target-design.md`
and `docs/plans/2026-09-07-rust-std-target-implementation.md`.

## Status

Full-`std` parity is demonstrated. Remaining hardening: reconcile the
remaining WALI-derived constants/syscall numbers in the wasm32 libc leaf
to Kandelo's ABI (none has affected the demonstrated surface), and
upstream the target as tier-3.

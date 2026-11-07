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

## Experimental compiler inside Kandelo

The experimental `rustc` package builds the compiler itself for Kandelo,
separately from host-side `wasm32posix-cargo`. It pins the repository's
nightly compiler revision, statically links its matching LLVM 22 WebAssembly
backend through the `rust-llvm` library package, and supplies matching
prebuilt `std` in `rust-std.zip`. These packages are outside the default
supported software set. The compiler package alone does not include Cargo;
the optional Rust SDK below adds it. Rustup and procedural macros are not
included.

Build it through the package resolver (this is a substantial cold build):

```bash
bash .agents/skills/porting-software-to-kandelo/scripts/build-package.sh rustc wasm32
```

A guest image needs `/usr/bin/rustc`, `rust-std.zip` mounted at `/usr`,
and `kandelo-sdk.zip` mounted at `/usr` for the existing
`wasm32posix-cc` linker driver, Clang and wasm-ld. Compiler and standard
library must come from the same pinned revision. Select the installed
target by name:

```bash
RUST_LIBC_UNSTABLE_MUSL_V1_2_3=1 rustc -Zunstable-options --sysroot /usr \
  --target wasm32-unknown-kandelo-std hello.rs -o hello.wasm
./hello.wasm
```

`--emit=metadata --crate-type=lib` type-checks without invoking the linker;
`--emit=obj` exercises LLVM code generation without linking. Node and the
Chromium, Firefox and WebKit desktop test engines compile, link and execute a
program using `Vec`, iterators and `println!`, then reopen its persistent
disk and execute the saved program again. The existing process-memory
limits are unchanged.
Persistent disks retain sources, standard-library files and build outputs;
compiler and linker processes still need their own memory.

The compiler inherits the target's abort-only panic strategy. Fatal type
errors print Rust diagnostics (including error codes) and terminate by
`SIGABRT` (134), rather than rustc's usual status 1. Compiler panic recovery,
procedural macros, dynamic backends, arbitrary crates remain unvalidated. Programs reaching `fork` still require normal fork
instrumentation before guest execution.

The acceptance fixtures are `host/test/rustc-in-guest.test.ts` and
`apps/browser-demos/test/rustc-in-guest.spec.ts`. Set
`KANDELO_REQUIRE_GUEST_RUSTC=1` when running them to fail on missing
experimental artifacts rather than skip. They cover type-checking,
compilation, execution, diagnostics and reopening the compiled program from
its persistent root filesystem. The browser fixture uses an OPFS disk.

## Cargo inside Kandelo

The optional `kandelo-rust-sdk` package builds a ZIP mounted at `/usr`.
It combines the C/C++ SDK and its linker with the pinned guest rustc,
matching prebuilt standard library, Cargo and `wasm-fork-instrument`.
It is experimental and excluded from the default supported build set.
Build it through the normal resolver from `scripts/dev-shell.sh`:

```sh
cargo xtask build-deps resolve kandelo-rust-sdk --arch wasm32
cargo xtask build-deps output-path kandelo-rust-sdk kandelo-rust-sdk.zip
```

Register that ZIP as a verified lazy archive at `/usr` on a persistent
machine, preserving archive symlinks and executable modes. The archive
installs `/usr/bin/cargo` and `/usr/bin/rustc`; the compiler implementation
lives at `/usr/libexec/rustc`. The acceptance workspace uses this bounded
build profile in its root `Cargo.toml`:

```toml
[profile.dev]
debug = 0
codegen-units = 1
incremental = false
```

Incremental compilation is disabled for the WebKit acceptance workflow.
During bring-up, Cargo's default incremental mode repeatedly made WebKit
terminate its web process with `ExceededMemoryLimit` while compiling the build script.
The same workspace passed Node, Chromium and Firefox with incremental
compilation enabled. A larger compiled-module retention window reduced
recompilation but did not prevent WebKit's termination; runtime limits and
the default cache policy are unchanged. Cargo still reuses completed
outputs and build-script results across a persistent reboot without rustc's
incremental cache.

With `/usr/bin` on `PATH`, run the installed toolchain:

```sh
cd /home/maker/project
cargo check --offline -j1
cargo build --offline -j1
cargo run --offline -j1
```

The public rustc entry point supplies `-Zunstable-options` and the matching
`/usr` sysroot, including for Cargo's compiler probes and host build scripts.
It reads output paths from rustc's JSON artifact notifications and runs the
normal guest fork instrumenter on linked WebAssembly outputs importing fork.
Diagnostics pass through unchanged. Probes and metadata-only compiles replace
the wrapper with rustc; direct human-diagnostic links use a filename query. Instrumentation failures fail
the compile. Build scripts and executables using `std::process::Command`
therefore follow the same preparation contract as packaged programs.

Cargo is pinned to `eb9b60f1f6604b5e022c56be31692c215b8ba11d`, the
compiler source tree's Cargo revision. It retains curl and Git transports,
using Kandelo's declared libcurl, OpenSSL and zlib. The current libcurl
build supports HTTP/1.1; this Cargo build does not request HTTP/2. Registry
fetching, TLS trust configuration, Git credentials, procedural macros and
arbitrary third-party crates are not covered by the offline acceptance case.
Cargo install/uninstall are also unvalidated. The std port still lacks a
Kandelo-specific `std::env::consts` entry; platform identity and filename
constants use the generic fallback. Cargo build scripts use the actual
compiler-reported executable path, including its `.wasm` suffix.
Vendored sources and path dependencies avoid registry access. Crates whose
platform code does not recognize Kandelo still need portability work, just
as they do when cross-compiled on the build machine.

The acceptance fixtures are `host/test/cargo-in-guest.test.ts` and
`apps/browser-demos/test/cargo-in-guest.spec.ts`. Set
`KANDELO_REQUIRE_GUEST_CARGO=1` to make missing experimental artifacts fail
instead of skip. The workspace includes a path dependency, generated Rust
source from `build.rs`, a build script launching rustc and a program spawning
itself. The tests check a fresh build, reuse of existing outputs and running
again after reopening the persistent disk. The documented profile passes on desktop Node, Chromium, Firefox and
WebKit. Build parallelism is one job in these tests; runtime memory limits
are unchanged.

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
  in `+atomics,+bulk-memory`. Self-contained CRT/linker fallback is disabled:
  the SDK driver supplies those files. Rust's own bundled `gcc-ld` directory
  is not required, including when rustc itself runs inside Kandelo.
- `sdk/rust/libc-upstream/` (submodule, `rust-lang/libc` pinned to the
  version `std` uses) + `sdk/rust/libc-kandelo.patch` (our delta:
  `kandelo` arms reusing linux-musl bindings + a reconciled wasm32 arch
  leaf). The crate is NOT vendored; the fork is assembled at build time
  (submodule + patch), mirroring how `build-musl.sh` overlays
  `libc/musl-overlay` onto the `libc/musl` submodule. A libc version bump
  makes the patch fail loudly — the signal to refresh the delta.
- `sdk/rust/std-overlay/` — `kandelo` arms in `library/std` (the unix
  pal and errno), `library/unwind` and `library/backtrace` (file-copy
  overlay onto the toolchain's `rust-src`, which is not a submodule).
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

### Rust packages

`packages/registry/librsvg/` (a library, through Meson and cargo-c) and
`packages/registry/rsvg-convert/` (a program, through cargo) are the
references for packages whose build compiles Rust for the target. Both
source `packages/registry/librsvg/rust-build-env.sh`, which:

- assembles a private sysroot in its work root
  (`KANDELO_RUST_DIR=<work>/rust scripts/build-rust-sysroot.sh`) rather
  than sharing `~/.kandelo/rust` with other checkouts (each package lists
  the sysroot's sources, and this helper, in `build.toml` `inputs`: they
  are not in the global toolchain fingerprint);
- moves the lockfile's `libc` to the fork's exact version (`[patch]`
  replaces only that version) with `cargo update -p libc --precise`;
- vendors the remaining crates with `cargo vendor --locked` (Cargo checks
  each against the lockfile's checksums), applies the package's crate
  patches as path overrides, then builds offline;
- writes these overrides to `$CARGO_HOME/config.toml`, because build
  systems such as Meson run cargo from their build directory with
  `--manifest-path`, and cargo finds `.cargo/config.toml` from its working
  directory, not from the manifest.

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

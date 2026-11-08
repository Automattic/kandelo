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
prebuilt `std` in `rust-std.zip`. The shell carries these as lazy tools;
the standalone Rust SDK bundle below is optional. The compiler package
alone does not include Cargo. Rustup is not included; procedural macro
loading remains unvalidated.

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

To try the toolchain in the browser app, build a partial shell from
`scripts/dev-shell.sh` and serve it:

```sh
./run.sh partial shell cargo rustc kandelo-rustc kandelo-sdk-browser-bundle wasm-fork-instrument
./run.sh browser --partial
```

This installs the same tools as the standalone SDK below, using separate
lazy programs and archives. The shell supplies the musl environment flag;
the project still needs the bounded build profile below. Other shell
activities are left out when their packages are absent. This development
image does not establish canonical-shell integration readiness.

The optional `kandelo-rust-sdk` package builds a ZIP mounted at `/usr`.
It combines the C/C++ SDK and its linker with the pinned guest rustc,
matching prebuilt standard library and libtest, Cargo, rustdoc, rustfmt,
Clippy and `wasm-fork-instrument`.
It is experimental and excluded from the default supported build set.
Build it through the normal resolver from `scripts/dev-shell.sh`:

```sh
cargo xtask build-deps resolve kandelo-rust-sdk --arch wasm32
cargo xtask build-deps output-path kandelo-rust-sdk kandelo-rust-sdk.zip
```

Register that ZIP as a verified lazy archive at `/usr` on a persistent
machine, preserving archive symlinks and executable modes. The archive
installs the public commands in `/usr/bin`; the raw compiler, rustdoc and
Clippy driver live in `/usr/libexec` behind the SDK entry point. Cargo
subcommand aliases include the target's `.wasm` executable suffix, so
`cargo fmt` and `cargo clippy` use ordinary Cargo command discovery. The
acceptance workspace uses this bounded build profile in its root
`Cargo.toml`:

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
cargo fmt --all
cargo fmt --all -- --check
cargo clippy --offline -j1 --workspace -- -D warnings
cargo doc --offline --no-deps -j1
cargo test --offline -j1 --workspace -- --test-threads=1
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
Local-registry `.crate` archives are covered by acceptance: Cargo verifies
their checksum, unpacks them, preserves executable permissions and builds
their Rust code. CPU-count detection uses Kandelo's musl `sysconf`, allowing
Cargo to choose its default job count. For bounded browser builds, `-j1`
remains the tested recommendation. Cargo defaults to HTTP/1.1 when the
linked curl lacks HTTP/2; explicit HTTP configuration remains authoritative.
Kandelo's libcurl uses `/etc/ssl/certs/ca-certificates.crt` and
`/etc/ssl/certs` for trust, including the browser's session CA bundle.
This configuration does not establish end-to-end HTTPS registry support.

Cargo install/uninstall are also unvalidated. The std port still lacks a
Kandelo-specific `std::env::consts` entry; platform identity and filename
constants use the generic fallback. Cargo build scripts use the actual
compiler-reported executable path, including its `.wasm` suffix.
Vendored sources and path dependencies avoid registry access. Crates whose
platform code does not recognize Kandelo still need portability work, just
as they do when cross-compiled on the build machine.

The acceptance fixtures are `host/test/cargo-in-guest.test.ts` and
`apps/browser-demos/test/cargo-in-guest.spec.ts`. The partial shell's login
terminal and lazy tools are covered by
`apps/browser-demos/test/cargo-partial-image.spec.ts`. Set
`KANDELO_REQUIRE_GUEST_CARGO=1` to make missing experimental artifacts fail
instead of skip. `KANDELO_GUEST_RUST_SDK_BUNDLE` can name the normal resolver's
canonical ZIP output when the optional bundle is outside the published view.
The workspace includes a path dependency, generated Rust
source from `build.rs`, a build script launching rustc and a program spawning
itself. The tests check a fresh build, reuse of existing outputs and running
again after reopening the persistent disk. The documented profile passes on desktop Node, Chromium, Firefox and
WebKit. Builds and test execution use one job; `cargo check` also exercises
default CPU-count detection. Runtime memory limits are unchanged.

### Unit and integration tests

The matching sysroot ships `libtest` and its dependencies. The compiler
entry point selects Rust's upstream abort-mode test harness for `--test`:
each test runs in a subprocess, allowing the parent to report failures and
check `#[should_panic(expected = "...")]` without panic unwinding.
Ordinary programs still use `panic = "abort"`.
Tests run in separate processes, so they do not share mutable process globals.
This does not provide stack unwinding or destructor cleanup after a panic.

```sh
cargo test --offline -j1 --workspace -- --test-threads=1
```

Plain `cargo test` can now reach the documentation-test phase using the
matching rustdoc. The public rustdoc entry point supplies the same sysroot
and uses `/usr/bin/rustc` as its default test builder, so generated doctest
executables receive the normal fork preparation. Explicit test builders
remain authoritative. The named custom target keeps its compiler identity;
a [tracked rustdoc patch](../tests/runtime-workarounds/RUST-RUSTDOC-NAMED-CUSTOM-TARGET/entry.md)
resolves doctest executable suffixes through the normal target search.
This does not add panic unwinding.
Test filtering, ignored tests, expected panics, mismatched panic messages,
failure exit status, build-script generated source, subprocess tests and
running tests again after reopening a persistent disk are exercised by Cargo acceptance.
The negative acceptance cases explicitly run the ignored failing tests;
they must report failure, rather than turn an empty test run green.
Acceptance uses one test thread; parallel harness execution still needs
dedicated coverage.

### Native build scripts and compatibility coverage

The shared workload in `host/test/fixtures/rust-compatibility.ts` uses
Cargo inside the guest to compile and execute C/C++ dependencies. Its
`build.rs` invokes the installed C and C++ SDK drivers and archiver,
produces a static archive and generated Rust, and links an executable that
calls both languages. A C++ global vector checks startup initialization.
The workload changes a C source and checks the new runtime result, checks
reuse of unchanged output, rejects a deliberately missing native symbol at
final link, and rebuilds successfully after restoring the source.

Its unit and integration tests exercise Mutex, Condvar, Barrier, channels
and thread joins; child working directories, a cleared environment, piped
standard streams, and nonzero exit status; and a child panic observed as
SIGABRT. The panic child attempts `catch_unwind`, but neither recovers nor
runs its destructor. This confirms the documented abort boundary, not
unwinding support. Harness execution still uses `--test-threads=1`; guest
threads within a test are separate from parallel libtest scheduling.

Documentation cases cover an example that executes native code, a
`compile_fail` example with an expected diagnostic code, `no_run`, `ignore`
and `should_panic`. A deliberately failing assertion must make Cargo fail;
restoring the example must pass. A filesystem marker distinguishes the
executed example from the compiled-only example.

The embedding's owned-job deadline is tested separately from libtest:
a running parent and child exceed the deadline, the result reports
`timed_out` after family retirement, and a subsequent guest process checks
that both PIDs return ESRCH from `kill(pid, 0)`. Another command must then
execute successfully. This is a host-controlled command-family deadline,
not a new per-test timeout option in Cargo or libtest.

External procedural-macro crates currently fail before expansion: Cargo
reports that `wasm32-unknown-kandelo-std` does not support the `proc-macro`
crate type. A minimal local macro/consumer pair checks this known boundary.
Built-in derives and declarative macros do not use that loading path.
Supporting them needs further target/compiler work and loader validation;
installing rustdoc, rustfmt and Clippy does not provide that support.

Node, Chromium, Firefox and WebKit acceptance run this same workload.
The fixtures are `host/test/rust-compatibility-in-guest.test.ts` and
`apps/browser-demos/test/rust-compatibility-in-guest.spec.ts`. This does not
establish compatibility with arbitrary configure scripts, C++ exception unwinding across Rust, registry `libc`
versions, or arbitrary native-build helper crates.

Native linking currently warns about `UnwindRegistersSave.S.o` and
`UnwindRegistersRestore.S.o` in the libc++ archives. These unused members
are ARM64 Mach-O objects, which wasm-ld ignores. The libc++ recipe lacks an
explicit assembly target; correcting it and validating rebuilt archives
remains follow-up work.

### Native dependency helpers

The optional `rust-native-fixtures` package prepares unmodified, locked
`cc` 1.2.61, `find-msvc-tools` and `shlex` sources with Cargo's checksum
verification. The guest compiles those Rust crates and uses `cc` to build
C/C++ archives, then executes a program calling both languages. Source
preparation produces a verified ZIP; no build-machine executables enter
the fixture.

Node, Chromium and Firefox pass this configured case. The SDK exposes its
public tools as `cc`, `c++` and `wasm32posix-*`; default `cc` discovery looks
for `clang` on PATH and fails. Configure the real SDK drivers and its C++
runtime explicitly:

```sh
export CC=wasm32posix-cc CXX=wasm32posix-c++ AR=wasm32posix-ar
export CXXSTDLIB=c++
cargo run --offline --locked -j1
```

WebKit currently fails earlier: guest rustc exhausts its native Wasm call
stack compiling the `cc` crate and exits 139; Cargo returns 101. The browser
acceptance requires both that compiler failure and the actual worker's
`Maximum call stack size exceeded` diagnostic. It records an unsupported
capability, not successful native compilation. Explicitly using 16
code-generation units for build dependencies also failed. Cargo applies
[separate profile settings to build dependencies](https://doc.rust-lang.org/cargo/reference/profiles.html#build-dependencies).
Compiler symbols and the failing recursion path need further investigation.

From the declared dev shell, prepare both optional artifacts:

```sh
cargo xtask build-deps resolve kandelo-rust-sdk --arch wasm32
cargo xtask build-deps resolve rust-native-fixtures --arch wasm32
```

Set `KANDELO_GUEST_RUST_SDK_BUNDLE` to the first output root's
`kandelo-rust-sdk.zip` and `KANDELO_GUEST_RUST_NATIVE_FIXTURES` to the second
root's `share/kandelo/rust-native-fixtures.zip`. With
`KANDELO_REQUIRE_GUEST_CARGO=1`, the Node and browser
`rust-native-dependencies-in-guest` acceptance files fail when either input
is missing. The `cc` parallel feature, unmodified registry `libc` versions
and arbitrary configure scripts remain unvalidated.

### Formatting, linting and documentation

The tools come from the compiler's pinned Rust source revision. The guest
SDK includes `rustdoc`, `rustfmt`, `cargo-fmt`, `cargo-clippy` and
`clippy-driver`; Clippy uses the same compiler libraries as rustc.

The shared workflow in `host/test/fixtures/rust-devtools.ts` checks tool
versions, rejects unformatted source, formats it, rejects an intentional
Clippy lint, accepts the corrected source, verifies a generated function's
HTML, and requires a documentation example to execute. Node and browser
acceptance use the same guest commands on persistent disks. This is a small
compatibility case, not coverage of every rustdoc or Clippy option.
For a denied Clippy lint, Cargo returns status 101 with the real diagnostic
and reports the driver's abort-mode termination by `SIGABRT`, as with fatal
rustc errors. Correcting the source allows the same lint policy to pass.

Guest-linked executables currently lack the engine's newer
`kandelo.abi.contract` digest stamp and trigger the host's existing warning.
They use the matching SDK and numeric ABI marker; propagating the contract
digest through guest linking remains follow-up work.

### Remaining development-tool gaps

| Expected workflow | Guest SDK status |
|---|---|
| Editor analysis and standard-library source navigation | Guest `rust-analyzer` and `rust-src` are not shipped |
| External procedural macros, such as derive plugins | Target rejects the `proc-macro` crate type; expansion is unsupported |
| Cargo dependencies that compile C/C++ or run configure tools | Direct guest SDK builds pass on all four hosts; configured cc-rs builds pass on Node/Chromium/Firefox and hit a compiler stack limit on WebKit; other helpers/configure scripts remain unvalidated |
| `catch_unwind`, panic unwinding and backtraces | Unsupported; abort-mode libtest isolates tests instead |
| Online registries, Git authentication and proxies | Transport defaults configured; end-to-end workflow unvalidated |
| Incremental compilation on WebKit | Disabled in the tested profile because of native process memory limits |
| Parallel test harnesses, release/LTO builds, benchmarks and coverage | Need dedicated guest-toolchain validation; the tested command deadline belongs to the embedding owned-job API |

On the build machine, the cross-compilation wrapper can build test targets
with `--no-run`, but its `test` subcommand still needs a Cargo runner that
prepares and executes the hashed test artifacts. Guest Cargo executes its
test artifacts directly through the installed compiler entry point.

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

The documented `std` surface is demonstrated. Remaining hardening: reconcile the
remaining WALI-derived constants/syscall numbers in the wasm32 libc leaf
to Kandelo's ABI (none has affected the demonstrated surface), and
upstream the target as tier-3.

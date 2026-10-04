# Rust tooling inside Kandelo — feasibility

Status: feasibility assessment, not an implementation. Updated
2026-10-04 after the Rust target gained a prebuilt std, cargo-c support
and its first packages (#1466). Bottom line: the operating system is no
longer the blocker. The cost is the toolchain's own C++ components
(LLVM and lld), wasm32 memory scale, and a few compiler-specific
mechanisms (proc-macros). Crates do not need to live in a VFS image.

## What "Rust tooling inside Kandelo" means

`cargo` and `rustc` running as Kandelo guests (wasm programs on the
kernel) and producing Kandelo-runnable wasm. That is four pieces:

- **cargo** — the build driver and package manager. Rust, plus curl,
  OpenSSL and libgit2 as C dependencies.
- **rustc's front and middle end** — Rust, uses `std`.
- **the code generator** — LLVM (C++). Cranelift (Rust) emits native
  machine code only, not wasm, so it cannot produce Kandelo guests; there
  is no mature pure-Rust wasm backend.
- **the linker** — `rust-lld` or `wasm-ld` (LLVM's lld, C++).

## What the cross-compilation work proves (the OS side is ready)

Demonstrated on the kernel, with Vitest coverage in
`host/test/rust-std.test.ts`, `host/test/rust-c-interop.test.ts` and
`packages/registry/librsvg/test/`:

- Full `std`: files, environment and arguments, time, `HashMap`,
  threads with `Mutex`, TCP networking, and `std::process` (fork+exec,
  instrumented). Error paths return errors; backtraces report
  unsupported; panics abort.
- Rust and C/C++ static linking in both directions, including C++
  exceptions inside C++ code.
- A real dependency-bearing Rust package (librsvg, 366 crates) built
  through the package resolver: `libc` pinned to Kandelo's fork, crates
  vendored from the lockfile, gtk-rs `-sys` crates resolving C libraries
  through pkg-config.

A self-hosted `rustc` is a large multithreaded `std` program that reads
and writes files, spawns a linker, and uses a lot of memory: exactly
that surface. rustc's Rust half has no OS blocker on Kandelo.

## The four pieces, by difficulty

1. **cargo: reachable with today's patterns.** Cross-compiling cargo is
   a librsvg-sized job: a few hundred crates, the `libc` pin, and likely
   the same two crate patches (`system-deps`, `parking_lot_core`). Its C
   dependencies (curl, OpenSSL, git) are already Kandelo packages. On its
   own it can fetch crates, resolve versions, and run `cargo tree` or
   `cargo vendor`, but it cannot build without rustc.

2. **rustc and LLVM: the dominant cost.** Natively, `librustc_driver`
   (which includes LLVM) is about 204 MB and `rust-lld` about 131 MB
   (macOS arm64, nightly 2026-04-27). Porting LLVM and lld to run in the
   guest is the bulk of the work; Kandelo runs large C++ programs
   (libcxx, Qt, CPython), so it is possible, but it is upstream-toolchain
   scale. The same port would give Kandelo an in-guest `clang`.

3. **Build scripts and proc-macros.** In the guest, Kandelo is both the
   build machine and the target. Build scripts become guest programs that
   cargo runs, which fork+exec supports. Proc-macros (compiler plugins)
   are shared libraries rustc loads with `dlopen`. Kandelo has `dlopen`
   for wasm side modules, but rustc loading a proc-macro through it is
   untested. Proc-macros also report errors by panicking inside a
   `catch_unwind`; with `panic = "abort"` that panic would kill the
   compiler, so at least the compiler process likely needs unwinding.

4. **Linking and C code.** rustc needs an in-guest linker (`wasm-ld`
   from the LLVM port). Crates whose build scripts compile C (common,
   through the `cc` crate) need an in-guest C compiler, which the LLVM
   port also supplies.

**Memory.** Compiling real crates needs more than wasm32's 4 GB address
space, and Kandelo's default process ceiling is 1 GiB
(`host/src/runtime-memory-profile.ts`). A `wasm64` Rust target is the
prerequisite. On WebKit a declared memory ceiling is charged against a
shared reservation pool of about 6 GiB whether or not it is used, so a
large compiler ceiling is expensive in Safari specifically.

## Avoiding large VFS images

None of this requires crates or the toolchain in the eager image:

- **Crates on demand.** cargo's sparse registry protocol fetches one
  small index file per crate and one archive per crate version over
  HTTPS, only for what a project uses, and caches them in the guest's
  `CARGO_HOME`. In Node the guest has real sockets; in the browser the
  requests would go through the same CORS proxy git cloning uses (not
  yet checked whether crates.io sends CORS headers itself). For scale,
  librsvg's full crate set is 327 MB unpacked, which is why a
  crates-in-the-image approach is the wrong shape.
- **Toolchain as lazy files.** rustc, cargo and the linker would be
  lazy files (fetched on first exec, as PHP and nginx already are), and
  the prebuilt std (22 rlibs, 79 MB as built today, before stripping)
  a lazy archive group fetched on first use. The image carries stubs.
- **No Rust source in the image.** With the prebuilt std, a project
  does not need `rust-src` to build std itself.
- **Offline projects.** A project's vendored crates can ship as one lazy
  archive: one fetch, for that project only.

The real download cost is the toolchain binaries (hundreds of MB with
LLVM), paid once on first use, not crates.

## Suggested order

1. A `wasm64` Rust target (memory headroom; also useful for large Rust
   guests generally).
2. Port cargo, and prove on-demand crate fetching in Node and the
   browser.
3. Treat rustc plus LLVM as its own project, with a checkpoint that
   needs no code generator: rustc's front end runs in the guest and
   type-checks a crate (`rustc --emit=metadata`).
4. Proc-macro loading (`dlopen` plus unwinding), then an in-guest link,
   then a trivial program compiled inside Kandelo that runs on Kandelo.

The LLVM port is the decision point: it is large, and it also delivers
an in-guest C/C++ compiler, so it is worth deciding for both reasons
together.

## Cheaper partial

**miri** (rustc's interpreter, pure Rust, no LLVM) could run Rust code
in the guest without a code generator. It interprets rather than
producing wasm, is slow, and still requires most of rustc's front end.

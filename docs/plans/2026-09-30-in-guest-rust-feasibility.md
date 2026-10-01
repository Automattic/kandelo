# Compiling Rust inside Kandelo — feasibility (updated with evidence)

Status: feasibility assessment, not an implementation. This updates the
earlier verbal analysis with what the completed Rust **cross-compilation**
work now proves. Bottom line: the blocker is no longer the operating system —
Kandelo now demonstrably provides the POSIX surface a self-hosted compiler
needs — it is the toolchain's own C++ components (LLVM + lld) and wasm32
memory scale.

## What "in-guest Rust" means

A `rustc` that runs as a Kandelo guest (a wasm program on the kernel) and
produces Kandelo-runnable wasm. A real Rust compiler is three parts:

- **rustc frontend/middle-end** — Rust, uses `std`.
- **codegen backend** — LLVM (C++) by default. Alternatives: Cranelift (Rust)
  and GCC (C).
- **linker** — `rust-lld` (LLVM's lld, C++), or an external linker.

## What our cross-compilation work now proves (the OS side is ready)

Earlier this was hypothetical; it is now demonstrated on the kernel
(`programs/rust/*`, PRs #1378/#1443/#1444):

- Full `std`: `std::fs`, `std::env`/args, `std::time`, `HashMap`.
- `std::thread` + `Mutex` (pthread→clone, futex), `std::net`, and
  `std::process` (fork+exec, instrumented).
- C↔Rust static linking and a Rust library as a package dependency.

A self-hosted `rustc` is a large multithreaded `std` program that reads/writes
files, spawns a linker, and uses lots of memory and threads — exactly that
surface. So **rustc's frontend (the Rust half) has no OS blocker on Kandelo
anymore**; cross-compiling rustc-the-Rust-program to `wasm32-unknown-kandelo`
is now in-scope in principle.

## The real blockers

1. **LLVM + lld to wasm (dominant cost).** To emit *wasm* output you need a
   wasm codegen backend, which today means **LLVM's wasm backend running
   in-guest**. LLVM and lld are millions of lines of C++. Kandelo runs C++
   (libcxx, CPython, PHP, dinit…), so it is *possible*, but porting/compiling
   LLVM to `wasm32-unknown-kandelo` is the overwhelming majority of the work.
   This is upstream-toolchain scale, not a Kandelo gap.
   - *Cranelift does not help:* it emits native ISAs (x86/arm/riscv), not
     wasm, so it cannot produce Kandelo guests. There is no mature pure-Rust
     wasm codegen backend, so LLVM cannot be dodged for a wasm-output
     compiler.

2. **Memory scale.** wasm32 is 32-bit (4 GB ceiling; our max-memory cap is
   1 GB). rustc+LLVM compilations of nontrivial crates exceed that. Small
   inputs are fine; real ones need a higher cap or the `wasm64posix` path
   (which the SDK already contemplates and the Rust target could follow).

3. **Sysroot + linker in-guest.** Ship the target `std`/`core` rlibs (or
   `rust-src` for `build-std`) as files in the VFS; drive a wasm `lld` (or the
   SDK) via `fork+exec` — both validated-shaped by the std work, but another
   large artifact to assemble.

## Realistic path (large; roughly ordered)

1. Cross-compile the **rustc frontend + a minimal backend** to
   `wasm32-unknown-kandelo` (hardest sub-part is the backend).
2. Port/compile **LLVM + lld** to the target (the mega-task; likely
   `wasm64posix` for memory). Precedent exists at browser-demo scale
   (clang/LLVM-in-wasm), not production.
3. Assemble an in-VFS **sysroot** and wire the in-guest link step.
4. Prove a trivial program compiled *inside* Kandelo runs on Kandelo.

## Cheaper partials (if the goal is "run Rust in-guest", not "compile to wasm")

- **miri** (rustc's MIR interpreter, pure Rust, no LLVM) could *interpret*
  Rust in-guest with no C++ backend — but it interprets, it does not produce
  wasm, and it still means building most of the rustc frontend for the target.
- A `wasm64posix` Rust target would raise the memory ceiling that constrains
  any in-guest compilation.

## Honest conclusion

In-guest Rust is now **feasible in principle** precisely because the platform
provides the POSIX surface Rust needs — the std work removed the OS question.
What remains is a large research/porting effort dominated by **LLVM/lld → wasm
and memory scale**, not by Kandelo. It is not implementable in a single
session, and this document is the scoping, not a start. The highest-leverage
enabling step that is tractable today is the **`wasm64posix` Rust target**
(memory headroom), which also benefits ordinary large Rust guests.

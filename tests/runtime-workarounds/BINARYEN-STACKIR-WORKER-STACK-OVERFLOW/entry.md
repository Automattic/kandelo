# BINARYEN-STACKIR-WORKER-STACK-OVERFLOW

Status: suspected. Not reduced, not filed. This entry registers a claim
made in the clang package build script and the porting guide; it does not
confirm it.

## Defect

The clang package build says that Binaryen's recursive StackIR writer
overflows the small native stacks of macOS worker threads on the
instrumented LLVM functions, and `docs/porting-guide.md` names the trace
(recursion in `StackIRGenerator`). Binaryen's `wasm-opt` runs its passes in
a thread pool when `BINARYEN_CORES` is above one; the worker threads get
the platform's small default stack, while the main thread gets 8 MiB on
macOS. Unbounded recursion on input size is a robustness defect in
Binaryen, but whether it is one it would accept, or a known limit, is not
established.

## Why Kandelo is affected

The clang package (clang.wasm, wasm-ld.wasm and the LLVM tools) is linked
and then optimized with Binaryen on the developer's machine. Without the
setting, building it on macOS crashes `wasm-opt`.

## Workaround and its cost

`export BINARYEN_CORES=1` in `build-clang.sh` runs the full `-O2` post-pass
on the main thread, with optimization and validation unchanged. The cost is
a slower, single-threaded post-link pass on the largest modules Kandelo
builds.

## Evidence

Only the comment and the guide. The stack trace, the Binaryen version and
the module that triggered it were not kept.

## Why this is not a Kandelo defect

Not established. Still unknown: the Binaryen version; whether Linux hosts
(with larger default thread stacks) are unaffected; whether the depth is
caused by something specific to Kandelo's fork instrumentation output (very
deep nesting from its dispatch structure) rather than by ordinary LLVM
output, in which case reducing the nesting would be a Kandelo fix.
A reduction is a generated Wasm function with N nested blocks fed to the
pinned `wasm-opt -O2` with `BINARYEN_CORES=2`, finding the N where it
crashes, with `BINARYEN_CORES=1` as the control and a macOS host.

## Draft upstream report

Not ready. Component: WebAssembly/binaryen. It would need the generator
script, N, the OS and architecture, and the stack trace.

## Removal criteria

A pinned Binaryen that builds the clang package on macOS with the default
core count. Then remove the export and the porting-guide paragraph, and
retire the entry.

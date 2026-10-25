# BINARYEN-STACKIR-WORKER-STACK-OVERFLOW

Status: suspected. Not reduced, not filed. This entry registers a claim
made in the clang package build script and the porting guide; it does not
confirm it.

## Defect

The clang package build comment says that Binaryen's recursive StackIR
writer overflows macOS's small native worker stacks on the instrumented
LLVM functions. `docs/porting-guide.md` ("Large compiler builds and runtime
limits") gives diagnostic advice only: a trace in recursive
`StackIRGenerator` on a small macOS worker stack "indicates a host-tool
stack boundary", for which `BINARYEN_CORES=1` runs the optimization on the
main thread. The guide records no captured trace.

It is not known whether this is a Binaryen defect at all. The guide itself
calls it a host-tool stack boundary: a limit of the default stack size of
worker threads on macOS meeting a very deep function, which Binaryen might
consider a known limit. `kind = "bug"` is a provisional label until the
maintainers of Binaryen, or a reduction, say which.

## Why Kandelo is affected

The clang package (clang.wasm, wasm-ld.wasm and the LLVM tools) is
post-processed with Binaryen's `wasm-opt` when it is built. According to
the build comment, this step fails on macOS unless `BINARYEN_CORES=1` is
set. No trace, Binaryen version or module was kept to confirm that.

## Workaround and its cost

`export BINARYEN_CORES=1` in `build-clang.sh` runs the full `-O2` post-pass
on the main thread, with optimization and validation unchanged. The cost is
a slower, single-threaded post-link pass on the largest modules Kandelo
builds.

## Evidence

Only the build comment and the guide. The stack trace, the Binaryen
version and the module that triggered it were not kept.

## Why this is not a Kandelo defect

Not established. Still unknown: the Binaryen version; the OS thread-stack
size that matters (the worker-thread explanation is background knowledge
about thread pools, not something observed in this build); whether Linux
hosts are unaffected; whether the depth is
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

# fork-instrument

Compile-time instrumentation for POSIX `fork()` support in wasm
binaries.

Reads a wasm binary. Identifies every function on the transitive call
path to a named async import (by default `kernel.kernel_fork`). Rewrites
those functions with save/restore machinery so the kernel's host code
can unwind the wasm call stack to linear memory, create a child wasm
instance, copy memory, and rewind the child back to the `fork()` call
site.

Replaces our prior use of Binaryen's `--asyncify` pass. Designed to
handle new-EH (`try_table`) output, `call_indirect` on fork paths, and
`fork()` from inside C++ catch handlers — all cases where Asyncify
falls short in our setup.

See [`docs/plans/2026-04-20-fork-instrumentation-design.md`](../../docs/plans/2026-04-20-fork-instrumentation-design.md)
for the full design, ABI, save-buffer layout, and rollout plan.

## CLI

```sh
wasm-fork-instrument <input.wasm> -o <output.wasm> [--entry kernel.kernel_fork]
```

## Status

**Phase 1 (skeleton).** The tool currently round-trips its input
through walrus's validator and emits it unchanged. Subsequent phases
(2–7) add call-graph discovery, instrumentation, reference-type
spilling, catch-handler resume, and production rollout.

## Build

Standard workspace member:

```sh
cargo build -p fork-instrument --release
```

Binary: `target/release/wasm-fork-instrument`.

## Tests

```sh
cargo test -p fork-instrument
```

# Trusted memory-group translator

This crate extracts the checked, outlined baseline from the desktop experiment
into the Cargo workspace and normal SDK post-link path. It is an experimental
artifact producer, not a ready execution backend. See
[the SDK contract](../../docs/sdk-guide.md#experimental-memory-group-translation).

Build and test through `scripts/dev-shell.sh`; the integration tests compile C
with the declared LLVM/WABT tools and execute it in a dedicated Node Worker.
The `tests/fixtures/runner.mjs` module is also usable inside disposable browser
Workers; it returns copied result metadata only. No persistent browser realm
receives guest memory.

The generated C header emits a constant-returning Wasm marker for each layout
declaration. The normal translator validates marker names, signatures and exact
bodies against Rust before rewriting. Stale compiled helper layouts fail before
output publication. This is a layout guard, not an implementation-correctness or
security proof; the real C/Worker mechanism cases remain necessary.

The earlier optimization survey and its implementations remain research inputs;
this extraction selects no optional fast path. The v2 shared bitmap removes
the helper's monotonic-only allocation path,
but physical growth after peer termination still fails repeated WebKit
stress. Standalone reductions do not yet identify an external-runtime cause.
Version3 adds per-replica controls and reversible source-function/loop barriers.
Queued waits retain their original timeout/FIFO position and physical pin until
the returning helper recycles their node. Targeted stop preserves same-word
peers. These mechanisms do not establish normal syscall-import return handling,
exception-boundary coverage, fork/exec retirement or complete pthread support.
Lifecycle/backing retirement and normal grouped launch remain unimplemented.

Changing the layout,
thread attachment, stop or wait contract needs a new version and matching host
admission rather than accepting incompatible artifacts under the same name.

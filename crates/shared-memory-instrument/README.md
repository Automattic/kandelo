# Trusted memory-group translator

This crate extracts the checked, outlined baseline from the desktop experiment
into the Cargo workspace and normal SDK post-link path. Compatible artifacts
run through the explicit Node/browser memory-group backend; ordinary launch
still refuses the required extension. See
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

The earlier optimization survey remains a research input; no optional fast
path is silently selected. The physical bitmap permits reuse after exact
retirement. Version 3 adds per-replica controls and reversible source-function/
loop barriers. Queued waits retain their original timeout/FIFO position and
physical pin until the returning helper recycles their node. Targeted stop
preserves same-word peers.

Outlined access wrappers share code across constant offsets, passing the full
original offset as a private i64 argument to the existing checked helper.
Operation, alignment and lane still select distinct wrappers. Split-store
permission preflight, atomic alignment and effective-address overflow checks
remain unchanged; the public extension and layout stay at version 3.

The integrated host backend binds those mechanisms to syscall import return,
fork/exec, pthread and backing retirement. These are separate runtime contracts;
the translator's mechanism tests alone do not establish their correctness.
JavaScriptCore provisions the admitted physical extent before participants
launch, rather than relying on growth after a peer retires. The normal
SDK/package/image Sway/Foot developer preview remains experimental: full-app
shared launch, complete shared-object/graphics semantics and release acceptance
are unfinished. See [current evidence and limits](https://github.com/Automattic/kandelo/blob/fb798e1ea88a065b343fcb06a28b0def9c96bc66/docs/measurements/2026-11-20-shared-memory-desktop-current.md).

Changing the layout,
thread attachment, stop or wait contract needs a new version and matching host
admission rather than accepting incompatible artifacts under the same name.

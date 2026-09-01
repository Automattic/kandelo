# fork-module — co-resident process-worker fork module (Phase 6 D2 scaffold)

**Status: ADDITIVE scaffolding. NOT wired into the live host/worker.** Nothing
in this crate touches `host/`, `crates/kernel/`, `crates/shared/`,
`crates/runtime-core/`, `abi/`, or `libc/`. It builds a standalone wasm32 cdylib
and is validated in isolation.

See `.superpowers/sdd/2026-09-01-phase6-fork-exec/D2-CORESIDENT-MODULE-DESIGN.md`
for the full design.

## What it is

The `crates/fork-module` cdylib is the "live/stateful half" the D1
`crates/fork-codec` decoders deferred. In production it will be instantiated
once per process worker and provide the guest's `__wpk_fork_frame_*` /
`__wpk_fork_resume_peek` imports directly, as **wasm→wasm calls over the same
linear memory the guest uses**, eliminating the per-frame JS boundary the
TypeScript continuation controller has today.

It re-exports the guest-facing frame functions (signatures identical to
`WPK_FORK_REQUIRED_IMPORTS` in `host/src/generated/abi.ts`), backed by the
pure-logic `fork-codec` core:

| Guest import (this module's export) | Backed by |
|---|---|
| `__wpk_fork_frame_reserve(size) -> payload` | `LinkedFrameWriter::reserve_frame` |
| `__wpk_fork_frame_commit(payload)` | `LinkedFrameWriter::commit_frame` + `ReplayEventJournal::record_commit` |
| `__wpk_fork_frame_peek(size) -> payload` | `RewindDriver::drive_peek` |
| `__wpk_fork_frame_next(size) -> payload` | `RewindDriver::drive_next` |
| `__wpk_fork_resume_peek(diag) -> slot` | `RewindDriver::resume_peek` (`ResumeSlotTable`) |

Plus a minimal coordinator surface (`fm_begin_unwind`, `fm_finish_unwind`,
`fm_begin_replay`, `fm_finish_replay`, `fm_last_errno`) sufficient to drive a
full unwind-then-rewind cycle from a test.

## Memory topology (and why)

**Single shared imported memory** (the production "single-shared-memory" shape),
NOT the D2 §1d multi-memory fallback:

- The module imports `env.memory` as its ONLY memory, built like the kernel with
  `--import-memory --shared-memory` (inherited from the repo `.cargo/config.toml`).
  All frame reads/writes happen in that shared memory at absolute guest byte
  offsets, exactly as the D1 decoders assume.
- The module's own Rust heap (the `Vec`/`BTreeMap` state of the writer, driver,
  journal, and slot table) is a **bump allocator over a fixed 16 MiB static
  region, reset per fork**, living in the module's own BSS — disjoint from the
  frame data, and reclaimed each fork so the module is reusable.
- The per-fork **frame arena** is carved by GROWING the shared memory at
  `fm_begin_unwind` (`memory.grow` returns a fresh page-aligned region above all
  existing data), guaranteeing frames never collide with module heap/stack/
  static or the guest's own data. This is the scaffold stand-in for the
  production channel-`mmap` arena.

Why not the multi-memory fallback (module's own default memory + guest memory
imported as a second memory): Rust/LLVM lower every ordinary pointer dereference
against memory index 0, so the `fork-codec` `&mut [u8]` frame APIs cannot target
a second imported memory without hand-written multi-memory instructions; and the
repo-wide `--import-memory` forces memory 0 to be imported, so the module cannot
own a private default memory without editing global build config (non-additive,
out of scope). The single-shared-memory arena is both the only path that works
with Rust codegen and the production-shaped choice.

**The heap-bootstrap open question (design §7.1) is NOT settled by this
scaffold.** Production must still decide how the module obtains its heap/arena in
the real worker (the channel-`mmap` handshake); the scaffold grows memory
directly, which a live worker may not be free to do the same way.

## Build

Mirror the kernel's flags. **Release is required** (the whole-memory byte view
is based at wasm address 0, which is valid in wasm's flat memory but trips the
debug-only non-null slice precondition):

```
scripts/dev-shell.sh bash -c "cargo build --release -p fork-module \
  --target wasm32-unknown-unknown -Z build-std=core,alloc"
```

Artifact: `target/wasm32-unknown-unknown/release/fork_module.wasm`.

## Validate (end-to-end)

The key deliverable is `tests/harness.mjs`: a Node/V8 harness that instantiates
the built `.wasm` with a shared `WebAssembly.Memory` playing the guest memory and
drives the full reserve/commit → next/peek/resume loop, asserting the closed
loop matches the pure-logic expectation (frame order, resume slots).

```
scripts/dev-shell.sh bash -c "node crates/fork-module/tests/harness.mjs \
  target/wasm32-unknown-unknown/release/fork_module.wasm"
```

**Engine choice — Node/V8, not the `wasmtime` crate.** V8 is the actual
production engine for the Node and browser process workers, so exercising the
exact SharedArrayBuffer + imported-memory path in V8 is the most faithful proof.
The crate is also a wasm32-only cdylib, so a host-target `cargo test` cannot
build it, and `wasmtime` is not vendored in this workspace. The harness proves
what the design's "biggest unknown" needed: a second wasm module can import the
guest's `Memory`, export the frame functions, and drive the continuation loop
against that memory, end to end in a real engine.

## Deliberately DEFERRED (awaits user review / later slices)

- **LIVE HOST WIRING** — flipping the guest's `env.__wpk_fork_frame_*` imports to
  this module's exports in `host/src/worker-main.ts` is the risky
  live-integration step and is **left for user review**. It is NOT done here.
- **Production `mmap`-arena heap bootstrap** (channel `memory.atomic.wait32`
  chunk mapping). This scaffold grows the memory directly instead; the
  heap-bootstrap question is not settled.
- **Reference / exception / GC engine-floor imports** (the irreducible JS floor)
  and the funcref/anyref engine tables — inert for a no-reference program.
- **wasm64 variant** — only the wasm32 artifact is built here.
- **Per-worker instantiation plumbing** and the **ABI-44 snapshot record**.

# Frame-neutral fork instrumentation: scratch-frame spill design

Status: in progress (2026-09-22). Companion to
[fork-instrumentation.md](../fork-instrumentation.md); read that first.

## Problem

Switch-dispatch instrumentation allocates ~one Wasm local per call argument
and per operand-carryover at every fork-reaching call site. In CPython's
`_PyEval_EvalFrameDefault` (~583 sites) that adds ~2,676 locals. V8's Liftoff
tier reserves a stack slot per *declared* local, ballooning that function's
native frame to ~21.6 KB and the stdlib import chain's worker-stack
requirement to ~0.82 MB (no-fork CPython needs ~0.27 MB). Browser Web Worker
stacks cannot grow, so fork-instrumented CPython cannot import its stdlib in
a browser worker.

Measured (2026-09-22, Node host, `KANDELO_NODE_WORKER_STACK_SIZE_MB` sweep of
the chain `from wsgiref.simple_server import make_server; import json, re,
os; from socketserver import ThreadingMixIn`): 0.82 MB passes, 0.81 MB
overflows (SIGSEGV), reproduced on both the cached ABI-43 cpython artifact
and a fresh rebuild.

A measurement spike falsified the cheap fix: the spill locals are co-live for
structural reasons, not because the frame postamble reads them all at the
function tail. Excluding them from frame serialization and running
`wasm-opt -all --coalesce-locals` leaves the same 2,705 co-live locals (and
the same 0.82/0.81 boundary) as coalescing stock output. No liveness
optimization can shrink the frame; the values must physically leave Wasm
locals.

## Design

Store per-call argument and carryover spills in a per-activation scratch
region carved from the function's own shadow-stack frame, instead of in
declared Wasm locals.

- **Reserve:** instrumented functions that choose scratch mode open with
  `SP -= scratch_size; base = SP` (the `emit_reserve` shape proven in
  `crates/wasm-local-root-spill`), where `base` is one added i32/i64 local.
- **Spill sites** (chunk tails, `emit_spill_args`): pop the value through a
  per-width temporary local (`local.set tmp; local.get base; local.get tmp;
  T.store base+off`). At most one tmp per value width per function.
- **Reload sites** (`emit_materialized_call_args`, post-call carryover
  reloads, nested post-landing reloads): `local.get base; T.load base+off`.
- **Offsets:** scratch layout mirrors the frame-node payload's spill region
  byte-for-byte (`scratch_off = node_off - spill_region_start`), reusing
  `assign_local_offsets` results. The node payload layout is unchanged.
- **Unwind:** the postamble writes user locals per-local as today, then
  copies the whole spill region scratch→node with one `memory.copy`.
- **Rewind:** the preamble restores user locals per-local, then copies
  node→scratch with one `memory.copy`. Dispatch and reload sites then read
  scratch exactly as on the NORMAL path.
- **Exits:** `SP = base + scratch_size` before every `Return`, br-to-exit,
  and uncaught `Throw`/`ThrowRef`/`Rethrow` (active-catch tracking as in
  wasm-local-root-spill). At each `try_table` catch-target entry, reseed
  `SP = base` to reclaim frames leaked by exception propagation (idempotent
  otherwise).
- **Mode choice:** per function. Functions whose scalar spill region exceeds
  a threshold use scratch mode; smaller functions keep today's local-based
  shape (zero hot-path change). Reference-typed spills always remain locals
  (recipe-vector path, unchanged).

## Why this is capture/replay-safe

- `__stack_pointer` is a mutable scalar global, so `wpk_fork_unwind_begin` /
  `wpk_fork_rewind_begin` already snapshot and restore it; no new global and
  no new frame field.
- During UNWINDING the scratch region is still live (SP is restored on the
  postamble's return path, after the node is committed), so the scratch→node
  copy reads valid bytes.
- During REWINDING each replayed prologue re-reserves a fresh scratch region
  below the restored fork-time SP — the same behavior LLVM's own SP-bumping
  frames already have during replay — and the preamble fills it from the
  committed node. Reload sites are base-relative, so they read the fresh
  region, never a stale address.
- Callees run with SP == base and grow downward; the scratch region sits
  above SP and cannot be clobbered by calls or signal handlers.
- Borrowed (vfork) replay writes scratch below the parked parent's SP, the
  same region ordinary replayed LLVM frames already use.

## ABI

Intended as a no-bump change: exports, imports, custom sections, frame-node
payload layout, marshalling, and host-expected globals are all unchanged;
only generated function bodies differ. Evidence required before claiming
this: `bash scripts/check-abi-version.sh` plus the contract-inventory tools,
and the full fork conformance matrix on Node and browser. If any inventoried
surface moves, bump `ABI_VERSION` and regenerate `abi/snapshot.json` in the
same change.

## Validation

Per the task: fork-instrument crate tests; fork conformance suites on Node
and browser; `os.fork` in CPython; the import-chain MB-needed sweep before
vs. after (target: near the ~0.27 MB no-fork level, from 0.82); benchmark
suites on both hosts before/after; `python.wasm` and a PHP binary size
delta.

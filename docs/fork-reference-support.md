# Fork Reference Support

This document describes which kinds of live Wasm references `fork()`
can carry across the process boundary today, which kinds it cannot,
why that split is safe for real Kandelo workloads, and what closing
the remaining gap would take. It exists so the boundary is a visible,
documented platform gap rather than a silently swallowed failure —
see the Platform Values Contract in `CLAUDE.md` ("truthful failure
over convenient illusion").

## Overview

During `fork()`, the host and kernel reconstruct the child's live
program state, including every Wasm reference reachable from the
forking activation: table entries, globals, locals, and exception
payloads. Some reference kinds are reconstructed; the rest are an
explicit, loud, unsupported boundary rather than something silently
patched together by host JS.

## Supported across fork

- **`null` and `funcref`.** Ordinary programs get a static
  `__indirect_function_table` re-derived from the module's element
  segments. Programs that mutate their function table at runtime
  (`dlopen`/runtime-table-mutating programs such as `php`, `php-fpm`,
  and `redis-server`) are covered separately via the funcref ordinal
  catalog, which records the ordinal assigned to each table entry as
  it is installed.
- **`exnref` for wasm-tag / C++ exceptions.** Exceptions compiled with
  `-fwasm-exceptions` (see `docs/posix-status.md`'s "C++ exception
  support" section) are reconstructed via the exception codec
  (`exception_codec` / KFEC), which serializes scalar exception
  payloads and rebuilds the corresponding `exnref` in the child.
- **Simple (COW) and `vfork()` forks.** Both fork styles carry the
  supported reference kinds above; see `docs/fork-instrumentation.md`
  for how reconstruction fits into the broader replay design.

## Unsupported (gated) across fork

The remaining Wasm reference kinds — `externref`, `struct`, `array`,
`i31`, and static-root references — are an explicit unsupported fork
boundary as of this change:

- A fork that would carry a live value of one of these kinds across
  the boundary fails with `EOPNOTSUPP` (`ForkReferenceUnsupportedError`,
  errno 95; see `host/src/fork-reference-unsupported.ts`).
- The failure is detected on the **parent** side, during capture, not
  after a child has been spawned.
- In the default configuration (`WASM_POSIX_FORK_MODULE` unset), this
  surfaces as a clean fork-abort (`beginAbortReplay`): the fork
  syscall returns `-EOPNOTSUPP`, no child process is created, and the
  parent continues running. There is no crash and no partially
  constructed child.

### Why this is safe

A census of all 113 built package programs in the registry found
**zero** packages that produce these reference kinds across a fork:

- The fork instrumenter's own computed sections for these kinds
  (`gc_codec`, `static_root_catalog`) are empty for every program in
  the census.
- Host/syscall imports are scalar — no externref is ever passed into
  a guest through the syscall boundary.
- Guest C++ exception handling in the package set is tag-based, so no
  package exercises a first-class `exnref` carrying one of the gated
  kinds as payload.

Only synthetic test fixtures built specifically to exercise these
reconstruction paths hit this boundary today. Every real workload
that forks — WordPress/PHP via `dlopen`, LXDE, and the language
interpreters (Python, Ruby, Node, Perl) — falls entirely within the
supported set above.

## Known gaps and residuals

These are documented, intentional limitations of this slice, not
hidden defects:

- **Module-mode abort is deferred to M8.** With
  `WASM_POSIX_FORK_MODULE=1` set (an opt-in mode, not the default), a
  gated fork does **not** yet abort cleanly. `beginAbortReplay`
  (`host/src/fork-process-continuation.ts`) has no module-mode branch
  equivalent to the one `beginParentReplay` has, and the co-resident
  fork module was designed without an abort path. This also affects a
  **pre-existing, unrelated** case: a kernel-rejected fork
  (`childPid < 0`, e.g. `EAGAIN`/`ENOMEM`) already crashes the parent
  in module mode today, independent of this change. Implementing
  module-mode abort-replay — a `beginModuleAbortReplay` mirror, a
  matching backend, likely a Rust fork-module abort drive, and fork
  conformance validation — is deferred to milestone M8, when the
  module path becomes the default.
- **Host-exception externref payloads remain a narrow, synthetic-only
  path.** A raw host (JS `JSTag`) exception whose payload is an
  externref still reconstructs, ungated, through the retained
  exception machinery. Only synthetic fixtures exercise this; no real
  package hits it.
- **The GC/static-root codec files are retained.** The gated
  reconstruction *logic* built on top of them is deleted, but
  `host/src/fork-gc-codec.ts` and `host/src/fork-static-root-catalog.ts`
  stay in the tree. `fork-static-root-catalog.ts` is a structural
  dependency of `fork-reference-recipes.ts` — the `StaticRoot` recipe
  node kind appears in every fork's wire format, gated or not — and
  both files remain wired into the still-supported `exnref`
  reconstruction path. Keeping them is a host-surface-minimization
  residual, not a correctness gap.
- **The child-side reference provider retains parallel GC/externref
  reconstruction.** `host/src/fork-early-reference-provider.ts` still
  carries the restore-side JS reconstruction for the gated kinds
  (`decodeExternref`, `loadGc`, `replayGcVectors`, and the
  `forkReferenceVectorFrom` GC-vector rebuild). This slice gated the
  gated kinds on the **capture** side (the fork aborts before a child
  exists), so on a flag-off abort this code is unreachable for those
  kinds — no child ever calls it. It was not deleted because it is
  structurally shared with the still-supported reconstruction paths and
  will be the natural home for the future in-child reconstruction (see
  "Future work" below). This is an incomplete-deletion residual, not a
  correctness gap.

## Future work: re-enabling the gated kinds

The gated kinds become supported again by moving reconstruction out
of host JS and into module-owned Wasm (referred to as the "E1
floors" in planning docs). Each floor is only worth building once a
real workload needs it — today none do:

- **FLOOR-1 (funcref/externref provenance).** Record the ordinal or
  handle at each reference *production* site instead of recovering it
  later via a host reverse-lookup. This requires re-instrumenting
  every fork-capable program, which is an ABI epoch. Hard cases
  include dynamically created funcrefs and host-imported externrefs.
- **FLOOR-2 (GC provenance).** Carry provenance inline with the GC
  object itself: structs via an appended field (which forces
  module-wide field reindexing under subtyping), arrays via a wrapper
  struct (a Wasm array cannot hold an extra field directly).

Both floors are heavy, whole-program transforms that require an ABI
epoch and full both-host (Node and browser) conformance validation.
They are deferred until a real wasm-GC or externref-across-fork guest
program appears in the package set.

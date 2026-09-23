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
payloads. `null`, `funcref`, `exnref`, typed Wasm-GC
(`struct`/`array`/`i31`), and static-root references are
reconstructed. A **raw host `externref`** — an opaque JavaScript (or
native host) object handed to the guest by a host import — is **not**
supported across fork: that is a deliberate platform boundary, not a
gap to paper over. See "Host externrefs are not carried across fork"
below for the decision, the current behaviour, and the remaining
work.

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

## Supported across fork (GC, static-root)

Typed Wasm-GC (`struct`/`array`/`i31`) and static-root references are
also reconstructed across fork:

- **Static roots.** An immutable Wasm-GC global/local/table entry
  reachable from module-level `elem`/`global` initializers is recorded
  by a harvest-time reverse index (`ForkStaticRootCatalog`/
  `StaticRootProvenance`) and reconstructed via the same `gc_lookup`
  seam.
- **Typed Wasm-GC struct/array/i31.** A genuinely new (not dedup, not
  static-root, not externref-provenance) anyref-lineage value falls
  through to real construction: the guest's generated GC codec walks
  its fields, and the host's `claimGcSlot`/`defineGc`/`encodeI31`
  (Node/browser) or equivalent native methods build the real recipe
  node, restored in the child via the injected codec's
  allocate/fill drive.

See
`docs/plans/2026-09-05-n1-nodebrowser-reference-parity-grounding.md`
for the Node/browser parity work and its test coverage.

## Host externrefs are not carried across fork

**Decision.** Fork keeps Wasm-GC and static-root reference support but
does not carry raw host externrefs. A fork child runs in a fresh
Worker (or a fresh native instance), so a host object cannot be copied
into it with its identity intact; the only way to "carry" one is to
leave the real object with a host-side owner and route every use of it
back across workers. A host capability a guest needs belongs behind a
kernel object — a file descriptor or a device — which fork already
duplicates with POSIX semantics, not behind a JavaScript object
smuggled between workers. The package census below found no package
that carries an externref across fork, so the boundary costs no real
workload.

**Cross-worker host-object imports were removed (stage E1,
2026-09-23).** The Node/browser host used to wire a "host-import
mailbox" into every process and pthread Worker: a shared-memory
transport that forwarded an externref-bearing host-import call to an
owner in the kernel Worker, which kept the real object and handed the
guest a per-worker token. Production never registered a single import
on it — the only caller of its registration API was a test helper —
so it was deleted along with the tests that exercised it through that
helper. What survives from it is unrelated to externrefs: each guest
function import is still wrapped so that a nested Wasm trap crossing a
JavaScript import frame stays a trap (`host/src/import-trap-guard.ts`).

**Current behaviour, before stage E2.** On Node and browser, a fork
whose captured state includes a raw host externref fails at capture.
The co-resident fork module asks the host which handle names the value
(`__wpk_fork_host_externref_handle`); nothing registers host values
with the host's externref broker any more, so the answer is always
"none", and the module refuses to invent a recipe, recording
`EOPNOTSUPP` (pinned by
`host/test/fork-module-externref-capture-seam.test.ts`). Inventing a
recipe would decode in the child to something that was never the
parent's. What the forking program then observes is not yet pinned by
an end-to-end test on the JS hosts. A Wasm-GC-internalized host
externref (`any.convert_extern`) is still a host externref and takes
the same path.

**Stage E2 (planned).** Make a fork that carries a host externref fail
with `EOPNOTSUPP` from `fork()` on every host, with an end-to-end test,
and remove the remaining handle broker, worker-local token cache, and
captured-externref handover that no longer have anything to carry.

## Known gaps and residuals

- **No end-to-end JS-host test of a host-externref fork today.** The
  V8 end-to-end tests for this boundary
  (`externref-gated-fork-module-worker.test.ts`, and
  `externref-fork-module-worker.test.ts` for the carried case) minted
  their host externref through the removed cross-worker host-import
  transport, so they were deleted with it in stage E1. The native
  mate, `crates/host-native/src/lib.rs::smoke_fork_gated_externref_parent_
  survives`, was not changed by stage E1. Stage E2's end-to-end
  `EOPNOTSUPP` test is the replacement.
- **Exception-carried reference payloads reconstruct on the module path
  (Path B P5b, 2026-09-07).** An exception (guest `catch_ref` or a raw
  host `JSTag` exception) whose caught recipe carries a reference payload
  (a funcref or nullable externref) now reconstructs across a fork
  through the co-resident module DEFAULT, not just the JS twin. The
  module-capture branch of `ForkReferenceTransaction.defineException`
  previously validated the exception's payload recipe ids against the
  JS-only `this.nodes` array — empty in module-capture mode — so any
  reference-bearing exception threw "fork exception reference payloads
  entry N names missing recipe M". It now sources those ids against the
  MODULE builder (`readModuleRecipeIds` feeding the module's vector
  builder, whose Rust `ReferenceGraphBuilder::append_vector` validates
  each id against the builder's node count and returns `EINVAL` for a
  genuinely missing recipe), so the shared engine reconstructs the
  payload and the
  parent keeps its original live references. Proven on V8 by
  `host/test/catch-ref-fresh-worker.test.ts` ("reconstructs
  reference-bearing catches through the module (default)"), which asserts
  the exnref module proof-of-use is non-null. This path is still
  synthetic-only in terms of real packages (see the census below); no
  real package produces a reference-carrying exception across a fork.
  Native was unaffected: its capture path (`crates/host-native/src/guest.rs`)
  calls the shared builder directly and never carried the JS-nodes bound.

## Package-level validation

A census of all 113 built package programs in the registry found
**zero** packages that produce `externref`/GC/static-root references
across a fork: the fork instrumenter's own computed sections for these
kinds are empty for every program in the census, host/syscall imports
are scalar, and guest C++ exception handling in the package set is
tag-based. Real workloads that fork — WordPress/PHP via `dlopen`,
LXDE, and the language interpreters (Python, Ruby, Node, Perl) — fall
entirely within the funcref/exnref set that was already supported
before this reconstruction work, so this document's history is not a
correctness concern for any package validated to date; it does mean
the reconstruction paths above are proven only by synthetic test
fixtures, not a real package, as of this writing.

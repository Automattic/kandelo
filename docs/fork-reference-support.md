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
reconstructed, and so is an `externref` that is an `extern.convert_any`
view of the program's own GC object. A **raw host `externref`** — an
opaque JavaScript (or native host) object handed to the guest by a host
import — is **not** carried across fork: `fork()` fails with
`EOPNOTSUPP`, no child is created, and the parent continues, on Node,
browser and native alike. That is a deliberate platform boundary, not a
gap to paper over. See "Host externrefs are not carried across fork"
below for the decision, the behaviour, and how it is tested.

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
  static-root) anyref-lineage value falls through to real construction: the guest's generated GC codec walks
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
smuggled between workers. No production consumer exists: no production
host import hands a guest a raw host externref, and the package census
below found no package that carries one across fork, so the boundary
costs no real workload.

**Behaviour (stage E2, 2026-09-23).** A fork whose captured state
includes a live raw host externref — held directly in a local, global,
table or exception payload, or stored in a field or element of a
Wasm-GC object — returns `-EOPNOTSUPP` from `fork()`. No child is
created, and the parent carries on with every value it held, the host
object included. The same boundary holds on every host:

- **Node and browser.** The guest's `__wpk_fork_ref_encode_externref`
  converts the value with `any.convert_extern` and classifies it with
  the program's own GC layouts. A host object matches none, reaches the
  co-resident fork module's `__wpk_fork_ref_gc_broker_encode`, and is
  refused there: the module latches `EOPNOTSUPP` and hands back a gated
  placeholder recipe beside which the guest publishes the live value,
  so the parent's own replay gets it back unchanged. When the capture
  seals (`fm_parent_seal_capture`), the latched refusal fails the seal
  after the journal is sealed; the worker's seal-failure path replays
  the parent and returns `-EOPNOTSUPP` without issuing the fork syscall.
- **Native** (`crates/host-native`). The guest reaches the same
  `__wpk_fork_ref_gc_broker_encode` import, which native serves itself:
  it marks the capture unsupported and keeps the live value for the
  parent, and `drive_fork_capture_seal_and_launch_child` returns
  `-EOPNOTSUPP` without posting the fork syscall.

No host import is consulted and nothing names a host object: the fork
module no longer imports `resolve_externref` or
`__wpk_fork_host_externref_handle`, the recipe graph has no
host-externref node (wire kind 2 is rejected), and the instrumenter no
longer wraps externref-returning host imports with a provenance hook.

**The carve-out: GC views.** An `externref` produced by
`extern.convert_any` from the program's own GC object is not a host
object. The guest converts it back before classifying it, so it is
captured and rebuilt as the typed object it views, and a fork that
holds one succeeds. So does a null externref, and an `extern.convert_any`
view of an `i31`.

**Tests.**

- `host/test/fork-host-externref-refusal.test.ts` — through a real
  process Worker: a host object in a local, and one in a GC struct
  field, each make `fork()` return -95 with no child (the kernel counts
  no fork and `wait4(-1, WNOHANG)` fails `ECHILD`) and the parent still
  holding the same object; and an `extern.convert_any` GC view forks and
  is rebuilt in the child. The host object comes from a plain test-only
  import (`host/test/fixtures/host-object-import-worker-entry.ts`).
- `host/test/fork-module-capture-refusal.test.ts` — the refusal inside
  the module: the latch, the placeholder, the sealed-parent state the
  abort replay needs, and a clean next capture.
- `crates/host-native/src/lib.rs::smoke_fork_host_externref_refused` —
  the native mate, over
  `crates/host-native/fixtures/native_fork_host_externref_refused.wat`
  (a local) and `native_fork_host_externref_field_refused.wat` (a GC
  struct field).
- `crates/fork-instrument/tests/module_gc_codec_node.rs` — the
  instrumenter's codec: a GC view is encoded as the typed object, and a
  host object inside a GC object reaches the refusal.

**History.** Stage E1 (2026-09-23) deleted the cross-worker host-import
transport ("host-import mailbox") that production built for every
Worker but never used. Stage E2 removed what was left: the handle
broker and worker-local token caches, the captured-externref handover
between the parent Worker and the kernel Worker, the module's
externref reconstruction step (`DRIVE_OP_EXTERNREF_TRANSIT`), and the
production-site provenance pass in `fork-instrument`.

## Known gaps and residuals

- **The browser refusal is not exercised by a browser test.** The
  refusal lives in the fork module and in `worker-main.ts`, which Node
  and browser share, and the Node test above drives it through a real
  process Worker. No Playwright spec forks a guest holding a host
  externref, because no browser demo has a host import that yields one.
- **Exception-carried reference payloads reconstruct on the module path
  (Path B P5b, 2026-09-07).** An exception (guest `catch_ref` or a raw
  host `JSTag` exception) whose caught recipe carries a reference payload
  (a funcref, or a null externref) now reconstructs across a fork
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

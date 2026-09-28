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
  reachable from module-level `elem`/`global` initializers is harvested
  once per instance into the fork module's merged static-root catalog,
  which the host refills before every capture and child install; the
  module's `gc_lookup` recognises a root by its catalog slot, and the
  child re-identifies it by coordinate.
- **Typed Wasm-GC struct/array/i31.** A genuinely new (not dedup, not
  static-root) anyref-lineage value falls through to real construction: the guest's generated GC codec walks
  its fields, and the fork module's own capture exports
  (`__wpk_fork_ref_gc_claim`/`_gc_define`/`_gc_i31`, bound by every host
  -- Node, browser and native -- straight from the module) build the
  real recipe node, restored in the child via the injected codec's
  allocate/fill drive.
- **Constructor provenance.** An object whose type cannot rebuild it --
  an IMMUTABLE array, or a mutable array of a non-nullable reference type --
  is rebuilt by re-running one of the program's own allocation instructions.
  See "Constructor provenance" below.

See
`docs/plans/2026-09-05-n1-nodebrowser-reference-parity-grounding.md`
for the Node/browser parity work and its test coverage.

## Constructor provenance

This section explains how `fork()` rebuilds a Wasm-GC object that only its
constructor can build, and why it is done this way. It is written to be read
without any history of the work.

### Why the child re-runs a constructor at all

A fork child runs in a fresh WebAssembly instance, so every GC object the
parent holds is rebuilt in it. Most objects are rebuilt from their type: a
struct is `struct.new`'d from its field snapshot, and a mutable array of a
defaultable element type is allocated with `array.new_default` and then
filled. Two shapes cannot be:

- an IMMUTABLE array cannot be filled after allocation, and Wasm has no
  instruction that builds an immutable array of runtime length from
  arbitrary values;
- a MUTABLE array of a non-nullable reference type has no default value to
  allocate with.

The only faithful rebuild is to re-run one of the program's own allocation
instructions -- `array.new_fixed`, `array.new`, `array.new_default`,
`array.new_data` or `array.new_elem` -- with operands that reproduce the
object. `fork-instrument` gives every such instruction in the program its own
"constructor layout", with a generated allocator in the child that runs
exactly that instruction.

### Why re-running one is safe

`struct.new` and the `array.new*` instructions are pure allocation: they run
no user code, touch no memory and call nothing. A language-level constructor
(a Kotlin or Dart `init`, say) is an ordinary function that happens to contain
one of these instructions, and it is NOT re-run: only the instruction is.

### Which constructor, and what is recorded

An immutable array's observable state is its type, its length and its
elements. Its identity is carried separately, by the recipe graph: `ref.eq`
between the rebuilt array and every other rebuilt reference to it holds in
the child exactly as in the parent. So the fork module chooses the constructor
at capture, from what the capture already has
(`crates/fork-codec/src/gc_constructor.rs`):

- `array.new_fixed N` takes its N elements as operands, so it rebuilds any
  array of length N;
- `array.new` fills with one value, so it rebuilds a uniform immutable array
  (its first element is the value), and any mutable non-null array (seeded
  with a type-correct value, then filled);
- `array.new_default` rebuilds an all-default immutable array;
- `array.new_elem` copies a run of an element segment's items, and every item
  has a static capture coordinate: an allocating item is a static root
  harvested at instantiation, a `global.get` item is that global's root, and a
  null or `ref.i31` constant is itself. `fork-instrument` lists each segment's
  items in the GC codec descriptor, so the capture FINDS the offset by
  matching the array's captured elements against them. That works where the
  engine gives a segment's items one identity (V8, Wasmtime). JavaScriptCore
  does not: it evaluates an allocating item afresh at every use (measured in
  WebKit: an item copied by `table.init` is not `ref.eq` to the same item read
  by `array.new_elem`), so on WebKit the elements match no item. For that
  case each distinct run's OPERANDS are recorded (no contents), and an array
  whose elements cannot be compared is given the only recorded
  `array.new_elem` run of its type and length -- sound by elimination, since
  every other constructor has been tried first and every run is recorded --
  or, if there are two or more, the fork is refused.
- `array.new_data` copies bytes from a data segment at an offset. The bytes
  might occur at many offsets, nothing static lists the segment's bytes, and
  once the parent runs `data.drop` it cannot read the segment again. So its
  runs are RECORDED where they happen, with a hash of their contents.

The child's fresh instance has every segment intact, and replays the parent's
`data.drop`/`elem.drop` only after it has rebuilt the objects that read them,
so it can always re-run the instruction.

### Why records are per run, not per object

A record per object would have to die with its object, and nothing can
observe an object dying: Wasm has no weak reference, a JavaScript host's
identity `WeakMap` frees an object without telling anyone, and Wasmtime's
roots are strong. A per-object table would therefore either keep every array
it describes alive -- an unbounded leak in any program that allocates in a
loop and never forks -- or keep records for objects long gone.

A RUN is a distinct `(activation, layout, operands)`. A data segment is
immutable, so every run with the same operands makes an array with the same
contents, and one record describes all of them. A later `data.drop` cannot
change that: a dropped segment has length zero, so a later non-empty run traps
before it allocates (it makes no array), and an empty run makes an empty array
whatever the segment held.

### Why a content hash, not a kept array

The capture has to tell which run made a given array. The first design kept
the first array each run made (a "witness") and compared contents with it,
but a witness is pinned for the worker's life, which was rejected. Instead,
the first run of each operand set sends the array's elements, one call per
element (`__wpk_fork_ref_gc_provenance_contents`), and the record keeps a
128-bit hash of them: the first 16 bytes of SHA-256 over a domain tag, the
length and the element bytes, exactly as a capture encodes the array
(`run_contents_hash`). SHA-256 because the match must agree bit for bit
between the first allocation and a later capture on another engine or host,
and a fixed, specified, unseeded function does; `sha2` was already the fork
codec's `no_std` dependency. A capture hashes the array's captured contents
the same way and matches on `(activation, layout, length, hash)`. Later runs
with the same operands send nothing.

Elements are streamed rather than copied to a buffer because this runs on the
program's allocation path: a buffer would need a mapping, a mapping can fail,
and allocation must never fail because recording could not proceed.

### Why no fixed cap, and what happens instead

The table's size is the number of DISTINCT runs, not the number of
allocations. It is an open-addressing hash table in one mapping, doubled by
re-mapping at half load; an entry is 40 bytes, so a run costs 80 to 160 bytes
of mapping. Linear memory cannot shrink, so what the table grows to stays
reserved until the process execs or exits. A doubling maps the new table
before it returns the old one, and the old one's space is reusable only by a
later mapping that fits in it, so linear memory grows by up to about twice
the final table.

When a doubling's mapping fails, recording STOPS for that worker, for good:
restarting would leave records that describe only some runs. The allocation
itself carries on unaffected. A later fork that meets an array it can match
neither to a record nor to another constructor is refused: `fork()` returns
`-EOPNOTSUPP` in the parent and no child is created -- never a trap, and
never a rebuild from a partial record. Runs recorded before the failure still
match.

Measured through a real Node process Worker (`host/test` probe, one million
allocations each, median of three):

| Loop | Pages grown | Time, recording on | Time, recording off |
|---|---:|---:|---:|
| `array.new_fixed` (never hooked) | 0 | 320 ms | 327 ms |
| `array.new_data`, 16 distinct runs | 1 | 399 ms | 410 ms |
| `array.new_data`, 1,000,000 distinct runs | 2,561 | 1,081 ms | 405 ms |

One million distinct runs end in a 2,097,152-entry table (80 MiB); with the
generations the doublings left behind, linear memory grew by 160 MiB, about
168 bytes per distinct run. Repeated runs cost nothing after the first: the
16-run loop made a million arrays and grew memory by one page. The first run
of each operand set pays one call per element to send its contents.

### The residual risk, and why it was accepted

A false match needs two arrays of one type and one length in one program
whose contents collide in 128 bits of SHA-256. That is not a practical event,
even for a program trying to cause one, and the only process it could
mislead is that program's own child. Everything else fails truthfully: an
array no constructor can rebuild -- its run went unrecorded because recording
stopped, it was made in a borrowed `vfork` child, whose transient fork
module keeps nothing, or (on JavaScriptCore) it is an `array.new_elem` array
and two recorded runs of its type and length could have made it -- refuses
the fork with `EOPNOTSUPP`.

A second residual is specific to JavaScriptCore, and is a known gap rather
than an accepted one: because an `array.new_elem` run there makes fresh item
objects, and the capture cannot tell them from any other struct, an element
object the program ALSO holds through another reference is rebuilt in the
child twice -- once by the re-run `array.new_elem`, once as that other
reference's own copy -- so `ref.eq` between them, true in the parent, is
false in the child. The kept-witness design had the same split. V8 and
Wasmtime share item identity and are not affected.

### Alternatives considered and rejected

- **Per-object records keyed by the hosts' identity oracle.** Stale records on
  JavaScript hosts (the `WeakMap` frees the object, never the record), pinned
  objects on Wasmtime (strong roots). See "why per run".
- **Keeping the first array of each run as a witness.** Pins that array for
  the worker's life. Replaced by the content hash.
- **A fixed cap on runs.** A routine program that reads many distinct offsets
  would lose provenance at an arbitrary count; the table is bounded by the
  program's distinct reads instead, and degrades to a truthful refusal.
- **Searching the child's fresh segment for the captured bytes.** Rebuilds
  from contents rather than from the run that happened, costs segment size
  times array length per array at child start, and needs child-side matching
  that could only fail in the child.
- **Copying data segments into a custom section** so the capture could search
  them. Doubles the artifact's static data.
- **Recording every constructor.** The other constructors' operands are the
  array's own contents; recording them would add a call to every allocation
  for nothing.
- **Finding every `array.new_elem` run by its items alone.** Exact wherever
  the engine gives a segment's items one identity, and kept as the first
  choice; on JavaScriptCore it matches nothing, which is why those runs'
  operands are recorded too.

### Tests

- `crates/host-native/fixtures/native_fork_gc_provenance.wat` runs on all
  three hosts: `smoke_fork_gc_provenance_reconstructs` (`crates/host-native`),
  `host/test/fork-gc-provenance.test.ts` (Node, through a real process
  Worker) and "rebuilds constructor-only Wasm GC objects in fresh child
  workers" in `apps/browser-demos/test/fork-continuation.spec.ts` (Chromium
  and WebKit). It holds immutable `array.new_fixed`, `array.new`,
  `array.new_default`, `array.new_data` (two with the same operands, which
  must stay two objects) and `array.new_elem` arrays, an immutable struct and
  an immutable array referencing the other arrays, and a mutable non-null
  reference array; drops every segment; forks twice from the parent and once
  from the first child; and checks every object in every process.
- `host/test/fork-module-gc-runs.test.ts`: a run is asked for its contents
  once; an array matches the run that made it and no run whose contents
  differ; the module keeps no array; when the table cannot grow, recording
  stops, allocation continues, an unrecorded run is refused with
  `EOPNOTSUPP`, and a run recorded earlier still matches; and an
  `array.new_elem` array whose elements cannot be compared takes the only
  recorded run of its length, or is refused when there are two or none.
- `host/test/fork-gc-provenance.test.ts` also runs a guest that makes 4,096
  distinct 16 KiB `array.new_data` runs, keeps only the last, and measures
  its own linear memory: the loop grows it by the run table (at most 16
  pages), not by the 1,024 pages the arrays' contents would take, and the
  last array is still rebuilt in a child.
- `host/test/fork-module-capture-refusal.test.ts`: an array no constructor
  can rebuild refuses the capture; its control seals.
- `crates/fork-codec/src/gc_constructor.rs` and `gc_codec.rs`: the selection
  rules, the element-run search, the pinned hash function and the
  element-segment table's decoding.

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
  seals, the latched refusal fails the seal after the journal is sealed;
  the module's run loop (`fm_run`) abort-replays the parent and `fork()`
  returns `-EOPNOTSUPP` without the fork syscall ever being sent.
- **Native** (`crates/host-native`). The same: the guest's
  `__wpk_fork_ref_gc_broker_encode` import is the module's own export,
  the seal fails, and the module's run loop abort-replays the parent the
  same way: one implementation, on every host.

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
  Native captures through the same module exports (lane F stage 4b) and
  so shares that path.

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

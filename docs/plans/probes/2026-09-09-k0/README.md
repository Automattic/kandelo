# K0 probes — GC reference reconstruction (2026-09-09)

Read-only engine probes for the rust-first runtime campaign. They settle
whether GC reference reconstruction needs host-side provenance, which
decides how much of the fork reference surface can leave TypeScript.

## Question

The 2026-09-04 E1 probe concluded host-side GC reference logic was
unavoidable, on two grounds: (a) a wasm-GC **array** type is a fixed element
type and cannot carry an inline provenance field, and (b) a **GC-derived
externref** has no broker handle, so its identity is not recordable at
production.

Both assume provenance must be *recorded*. These probes test whether it can
instead be *recovered* — because, unlike funcref and externref, GC structs
and arrays are castable and `ref.eq`-comparable, and a module knows its own
finite set of defined GC types.

## Reproduce

```
wasm-tools parse p1.wat -o p1.wasm
wasm-tools parse p2.wat -o p2.wasm
node run-node.mjs        # Node
node run-browsers.mjs    # Chromium + WebKit via Playwright
```

Requires `wasm-tools` (>= 1.258) and the repo's Playwright browsers.
`wat2wasm` from wabt 1.0.41 predates the GC text format and cannot assemble
these.

## Result — 2026-09-09, all three engines agree

Node v24.15.0 · Chromium 151.0.7922.34 · WebKit 26.5. Raw output in
`results.json`.

- **P1 PASSES.** A module recovers a GC value's concrete defined type by a
  `ref.test` cascade over its own type section — structs, subtypes (tested
  most-derived first), and `i32`/`f64`/`anyref` arrays. Contents read back
  generically. Structurally identical declared types canonicalize to one
  type, so "which declaration" is not a question reconstruction must answer.
- **P2 PASSES.** A GC-derived externref keeps its identity across a full
  round trip through the host, including storage in a JS `Map`, and its
  concrete type is still recoverable afterwards.
- **P2c CONTROL returns 0 everywhere.** A genuine *host* externref is not
  `ref.eq`-comparable once internalized — matching the 2026-09-03 probe.

## Consequences

Both E1 blockers dissolve. `ForkGcProvenanceRegistry` (`fork-gc-codec.ts`)
is eliminable, along with the GC/struct/array/i31/static-root host reference
surface. **`resolve_externref` — handle to canonical host externref — is the
single genuine fork reference floor**, and it is irreducible because the
value is a host object.

## Scope honesty

These test **engine primitives**, not the walrus-injection toolchain,
instantiation ordering, or a guest importing the module's table. Those
integration risks are real and unchanged. What is settled is that no
*engine* limit blocks GC reference reconstruction in wasm.

## Correction — 2026-09-09, K12 (re-verified the probes, then read the code)

The probe *results* above are correct and reproduce independently: Node
v24.15.0, Chromium 149.0.7827.55, WebKit 26.5, all 15 rows identical,
`P2c` control 0 on all three.

The **"Consequences" inference is wrong**, and the follow-up work it unlocked
(`ForkGcProvenanceRegistry` is eliminable) must not be attempted as stated.

### Why: provenance was never doing type recovery

The `ref.test` cascade P1 validates is **already implemented**, and has been
since the GC codec landed:

- `crates/fork-instrument/src/module_gc_codec.rs:1278-1316` — `emit_encode_anyref`
  walks `dispatch_layouts()` emitting `RefTest` per concrete type, then
  `RefCast`s (`:1394-1402`) and reads fields generically.
- `:2132-2140` — `dispatch_layouts()` is sorted `subtype_depth` **descending**,
  i.e. most-derived-first, exactly as P1 requires.
- `:774-828` — `emit_probe` is a second copy of the same cascade for the broker.
- `emit_define` passes `type_ordinal` as a **compile-time constant** (`:1767`).

So P1 confirms behavior the tree already has. It unlocks nothing new.

What `__wpk_fork_ref_gc_provenance_begin/_ref/_end` actually record is stated in
the code's own rationale at `module_gc_codec.rs:198-208`: **constructor shape**
and **allocation seeds** — not type identity.

### The decisive counter-case: immutable arrays are not reconstructable by casting

`array.new_data` / `array.new_elem` provenance is a **proven floor**, not an
inherited belief. For an immutable GC array of runtime length with non-uniform
contents, the wasm instruction set offers no reconstruction path:

- `array.new_fixed` takes its length as an **immediate**, so it cannot build an
  array whose length is only known at replay time.
- `array.new` / `array.new_default` set every element to one value — fine for a
  uniform array, not a general one.
- `array.copy` / `array.init_data` / `array.set` all require a **mutable**
  destination, which an immutable array is not.

That leaves `array.new_data` / `array.new_elem` from a **static** segment, and
segments cannot be synthesized at runtime. Recording `(segment ordinal, offset,
length)` at the production site is therefore the only way to rebuild such a
value. This is the `GcConstructorKind::ArrayData` / `ArrayElement` path
(`constructor_provenance`, `:2170-2202`, `(8, 0)`), selected by
`needs_constructor_provenance = !array.field.mutable || !defaultable_field(...)`
(`:1978-1980`).

### P1's canonicalization finding argues *for* provenance, not against it

The README above reads "structurally identical declared types canonicalize to
one type" as removing a question. For **cross-activation ownership routing** it
is the question, and canonicalization makes it unanswerable by casting: two
activations' structurally identical types test `true` in both codecs. Provenance
is the tiebreaker — see `host/src/fork-activation-registry.ts:1245-1247`.

Likewise **P2c** (`host_externref_is_eq == 0`) is what *forces*
`__wpk_fork_ref_provenance_externref` to exist: a genuine host externref reached
through anyref transit cannot be identified by `ref.eq`, so its identity must be
recorded at mint time. P2c confirms that floor rather than dissolving it.

### What is, and is not, still available

- **Not eliminable:** `ArrayData` / `ArrayElement` constructor provenance
  (proven above); cross-activation ownership arbitration; externref mint-time
  provenance. `ForkGcProvenanceRegistry` therefore cannot be deleted.
- **Possibly eliminable, but a semantics change needing a decision:** the
  *struct* seed path (`provenance_reference_count != 0` for mutable non-nullable
  internal-GC fields, `:1928-1949`). Those fields are **mutable**, so the fill
  phase already rewrites them; the recorded operand is used only as an
  allocation seed. A fabricated typed placeholder could replace it — the
  instrumenter already fabricates seeds for funcref/externref/exnref
  (`ReferenceSeeds::inject`, `:882-920`) — and the non-nullable-field type graph
  is necessarily acyclic for inhabited types, so the recursion terminates.

  This is **not** a re-derivation of recorded data; it changes what replay
  constructs with. It spans four implementations (the instrumenter, `fork-codec`
  `gc_codec.rs`, the TS `ForkGcProvenanceRegistry`, and host-native's
  `GcProvenanceRegistry` at `crates/host-native/src/guest.rs:2939-3245`), plus
  golden-fixture regeneration, plus an **ABI-tracked descriptor change**:
  `abi/snapshot.json`'s `kandelo.wpk_fork.gc_codec.layout_record` carries
  `constructor`, `auxiliary`, `provenance_scalar_len` and `provenance_ref_count`
  in its 44-byte record.

  It needs a maintainer decision before it is attempted.

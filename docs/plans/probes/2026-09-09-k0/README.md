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

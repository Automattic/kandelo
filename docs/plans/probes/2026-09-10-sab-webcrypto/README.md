# Probe: does SubtleCrypto accept a SharedArrayBuffer-backed view?

**Question.** The host typecheck reports nine errors where TLS code passes
`Uint8Array<ArrayBufferLike>` to `crypto.subtle.*` and to `Response`, both of
which require `BufferSource` — a type that **excludes** `SharedArrayBuffer`. In
Kandelo a guest's memory *is* a `SharedArrayBuffer`. Does the engine actually
reject such a view, or is this a purely nominal type distinction?

**Answer: the engine rejects it, explicitly.**

## Result — Node 24.15.0 (`results.json`)

| case | outcome |
|---|---|
| `control_plain_digest` | accepted |
| `control_plain_importKey` | accepted |
| **`sab_digest`** | **threw** — `2nd argument is a view on a SharedArrayBuffer, which is not allowed` |
| **`sab_importKey`** | **threw** — same, on the 2nd argument |
| **`sab_sign`** | **threw** — same, on the 3rd argument |
| `sab_copied_then_importKey` | accepted |

The two controls matter: without them a probe where everything throws proves
only that the probe is broken. And `sab_copied_then_importKey` establishes that
a `.slice()` is a real remedy rather than an assumed one.

## What this does and does not establish

**Established:** passing a view over guest memory to `importKey`, `sign` or
`digest` is a runtime `TypeError`, not a lint. The three calls that would
receive TLS key and secret material are exactly the three that throw.

**Not established: reachability.** At the sites inspected in
`host/src/networking/tls-network-backend.ts` (lines 84, 180, 280, 291) the
module allocates its own non-shared `Uint8Array`s, so no SAB-backed view
reaches the TLS connection along those paths today. The hazard is therefore
**latent and guarded by convention rather than by types** — the signature
permits what the engine forbids, so a future caller handing in a guest-memory
view compiles cleanly and fails at runtime, in the browser, in TLS.

**Browsers not run.** Node's error text is Blink's, so Chromium will behave
identically; WebKit is unverified. That gap is smaller than it looks, because
the specification excludes shared buffers from `BufferSource` outright — but it
is a gap, and this campaign has disproved fourteen claims that were argued
rather than measured.

## Remedy, if it is ever made reachable

Copy at the boundary (`view.slice()`), proven accepted above, and tighten the
signatures from `ArrayBufferLike` to `ArrayBuffer` so the compiler enforces what
the engine already does.

# Follow-up: `fm_admit_activation` — the module reads the guest's own sections

Branch `brandonpayton/lane-f-admit-activation`, cut from
`brandonpayton/lane-f-fork-inversion`. Deferred out of lane F by the maintainer
so it gets its own review and its own validation surface.

## The goal, in the maintainer's words

> I don't want to dilute or mix abstractions. I just want to share as much of
> the code that calls these operations as possible, so any kind of host can
> take advantage of the flow. The result would be more wasm run by the host to
> coordinate forking with less host-specific implementation.

That is the test to apply to every step here: **does a new host end up knowing
less?** Not "is the entry count lower".

### What this is NOT

Collapsing the thirteen `fm_set_*` seeders into one `fm_seed(kind, a0..a4)`.
That was built and reverted in lane F (census 195): it takes the count 59 → 47
while a host still needs all thirteen facts, every argument slot's meaning per
selector, and the order — and loses the argument types the compiler was
checking. The count moves; the knowledge does not.

## The question that produces the right fold

For each of the thirteen seeds, ask **where does the host GET this fact?**

| fact | where the host reads it | can the module read it? |
|---|---|---|
| linked-frame format | `kandelo.wpk_fork.linked_frames` section | **yes** |
| resume catalog (global + per activation) | the resume-catalog section | **yes** |
| GC codec | `kandelo.wpk_fork.gc_codec` section | **yes** — host only forwards raw bytes today |
| exception codec | its section | **yes**, same |
| activation template id | a section, hashed | **yes** |
| exception tag ordinals | parsed out of the exception codec | **yes** — same bytes |
| funcref catalog base | where the host laid this slice in the MERGED table | no — host placement |
| static-root catalog base | same | no |
| table-state owner | an election over `WebAssembly.Table` identity | no — wasm cannot compare tables |
| identity group, import provenance | how the host wired this guest's imports | no |
| host exception owner | host policy | no |
| borrowed workspace | host memory placement | no |

Six are "parse a custom section of the guest module", and the module already
links `fork-codec`, which parses every one of those formats. **What the host
uniquely has is not the CONTENT — it is which bytes belong to which activation,
and where they are in memory.**

## The shape

```
fm_admit_activation(activation_id, module_bytes_ptr, byte_len)
```

The module extracts the format, the resume catalog, the GC codec, the exception
codec, the tag ordinals and the template id itself. Six entries become one, and
the host stops knowing those sections exist.

The other seven keep their names and their types. They are placement, election
and policy: genuinely the host's, and collapsing them is the rejected fold.

## What it deletes rather than renames

- `host/src/fork-guest-sections.ts` — 167 code lines
- `host/src/fork-resume-catalog.ts` — 117
- the reader half of `host/src/fork-continuation.ts` — ~152

These are host re-implementations of formats Rust already parses, which is the
"second implementation of a wire format, and both are executing" finding that
opened the lane-F census — still standing in the one place it is easiest to
close.

## Carry this in too

**`crates/host-native/src/guest.rs` places resume thunks with `let slot = i as
u64 + 1;`** — a third copy of the slot rule, correct today only because that
host has one activation and never unregisters a slot. Six lines: call
`fm_resume_slots` op 0 per ordinal and place where it says. It is deferred to
here precisely because this branch has to validate host-native properly and
lane F did not. Census 194's addendum has the reasoning.

## Validation this branch needs that the host suite does not give

`crates/host-native` is **not built by the host suite**. `cargo check -p
host-native` is a compile check, not a behaviour one. Budget for:

- `cargo check -p host-native` and its own tests;
- both JS hosts through `host/test/suite-baseline.mjs`;
- the browser fork specs (`apps/browser-demos`, chromium) — the guest's import
  set changes, and that is exactly what the browser binds;
- perturbation of each new guard, with the **build key recorded per mutation**
  so "artifact unchanged" cannot be read as "mutation survived".

## Expected effect on the budget

`forkModuleHostEntries` 58 → about 53 directly, and the reachable target is
roughly 8 rather than the recorded 5 (census 195). `forkPlatformTypeScript` and
`workerMainForkTypeScript` both fall by the deleted readers. Bank each with its
reason; **never raise a ceiling to make a check pass.**

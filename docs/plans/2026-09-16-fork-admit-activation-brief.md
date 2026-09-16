# Follow-up: what the module can take over from the host's guest-section reading

Branch `brandonpayton/lane-f-admit-activation`, cut from
`brandonpayton/lane-f-fork-inversion`. Deferred out of lane F by the maintainer
so it gets its own review and its own validation surface.

> **This brief was rewritten on 2026-09-16, hours after its first version, and
> the first version was wrong.** It proposed
> `fm_admit_activation(activation, module_bytes_ptr, byte_len)` — the module
> parsing the guest's custom sections itself — and claimed it would delete
> ~430 host code lines and take `forkModuleHostEntries` 58 → 53. Two checks
> that should have come before writing it kill that shape outright. They are
> §1 below. I wrote the first version by reasoning about the design instead of
> probing it, which is the exact failure this lane spent the day documenting in
> other people's work.

## 1. Why the module cannot read the guest's image

**The image cannot enter linear memory.** `node.wasm` is **53 MB** and
`php-fpm.wasm` **43 MB**. The fork-module's staging slab is
`STAGING_SLAB_BYTES = 256 * 1024` with a bump cursor that is **never reset**
("everything staged here is seeded once per worker and must outlive the call").
Nothing about that is a tuning problem: growing guest linear memory by tens of
megabytes to hand over an image would break the fork memory-clone invariant a
child depends on — it must observe the parent's EXACT size — and a COW child
would clone it.

**And there is nothing in Rust to parse it with.** `fork-codec` decodes section
*contents* — `gc_codec`, `exception_codec`, `imported_globals`,
`imported_tables`, `module_state` — and has no wasm-binary reader at all.

**Meanwhile locating a section costs the host two lines.** It is
`WebAssembly.Module.customSections(module, name)`: an engine call on a
`WebAssembly.Module` the host already holds. There is no hand-written section
walk to delete, because there never was one.

So the split is finer than "the host stops knowing those sections exist".
**Locating is irreducibly the host's** — it owns the image, and the image stays
out of linear memory. What can move is **decoding**, and only where the host
does not use the decoded value.

## 2. What is actually worth moving, checked rather than assumed

| what | host reads | host USES the value? | verdict |
|---|---|---|---|
| module-state ROOT | a pointer in **guest linear memory** | no — forwards it | **best candidate: needs no bytes forwarded at all.** The module is in that same memory and can read the pointer itself |
| resume catalog ordinals | the catalog section | no — seeds them; targets come separately from the instance | **candidate**: forward located bytes, decode in the module |
| module-state descriptor | a 24-byte section | pointer width only | marginal — 24 bytes, small decode |
| linked-frame format | the frames section | **yes** — `ptrWidth` for a consistency check, `fixedPrefixSize` passed back at capture through `sides()` | **probably not**: moving it buys read-backs |
| GC codec, exception codec | their sections | **no** — already forwarded as raw bytes | **already done** |
| template id | SHA-256 over the **whole image** | no — forwards 32 bytes | **stays host**, with its hand-written TypeScript SHA-256: the thing it hashes cannot enter linear memory |

## 3. Honest expected effect

Much smaller than the first version claimed, and **not** obviously an entry
reduction at all: forwarding located bytes instead of decoded values leaves the
same number of `fm_set_*` seeds. `forkModuleHostEntries` 58 → 53 was
unsupported; delete that expectation rather than carry it.

The deletable host lines are the DECODERS, not the locators, and the biggest
single item in `fork-guest-sections.ts` — the SHA-256 — is not one of them.
Someone should measure the real total before committing to this as a PR; it may
be closer to ~100 lines than ~430, in which case the module-state root alone
may be the whole worth-doing part.

## 4. Carry this in regardless

**`crates/host-native/src/guest.rs` places resume thunks with `let slot = i as
u64 + 1;`** — a third copy of the resume-slot rule, correct today only because
that host has one activation and never unregisters a slot. Six lines: call
`fm_resume_slots` op 0 per ordinal and place where it says. It is deferred here
because this branch has to validate host-native properly and lane F did not.
Census 194's addendum has the reasoning. **This is independent of everything
above and is worth doing on its own.**

## 5. Validation this branch needs that the host suite does not give

- `crates/host-native` is **not built by the host suite**; `cargo check -p
  host-native` is a compile check, not a behaviour one.
- `host/test/suite-baseline.mjs` does not cover `tests/posix`, `tests/libc` or
  `tests/sortix`. For process-lifecycle work, run sortix `process` (24 tests),
  `signal` + `io` (87), and the four `os-test-local` tests that call `fork()`.
  `tests/sortix/os-test` is not checked out here — point `KANDELO_OS_TEST_DIR`
  at a populated checkout of the same commit (`7e8f0082ab`), because asked for
  a suite it cannot discover the runner prints "Discovered 0 tests" and **exits
  0**.
- The browser fork specs, if the guest's import set changes.
- Perturb every new guard, recording the **build key per mutation** so
  "artifact unchanged" cannot be read as "mutation survived".

## 6. The test to apply to every step

The maintainer's framing, which is what rejected the first version's sibling
(`fm_seed`, census 195) and should be applied here too:

> I just want to share as much of the code that calls these operations as
> possible, so any kind of host can take advantage of the flow.

**Does a new host end up knowing less?** Not "is the entry count lower". A host
that must still locate five sections and forward five byte ranges knows exactly
what it knew before, whichever side decodes them.

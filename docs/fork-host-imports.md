# What a host must create to run fork

**Approved 2026-09-12.** This is the contract a new host implements. It is the
V4 number for fork: not an aspiration, a list.

Each entry says what the host must produce and **why it cannot come from the
fork-module**. Where the reason is a measurement it is quoted; where it is a
judgement it says so. Nothing here is claimed to be irreducible on the strength
of a comment.

---

## A. Supplied to the fork-module at instantiation — 10

| import | kind | why the host |
|---|---|---|
| `env.memory` | memory | the module shares the guest's linear memory; it cannot define one and still see the guest's frames |
| `env.__indirect_function_table` | table | shared with the guest so the module can reach guest functions |
| `env.__memory_base` | global | PIC placement. The module cannot place itself before it exists |
| `env.__table_base` | global | PIC placement |
| `env.__stack_pointer` | global (mut) | PIC placement |
| `env.__wpk_fork_function_catalog` | funcref table | funcrefs of ANOTHER instance's functions. `ref.func` only produces a module's own, so only the host can fill this |
| `env.__wpk_fork_drive_table` | funcref table | same: the guest exports the module `call_indirect`s |
| `env.__wpk_fork_static_root_catalog` | anyref table | filled from the guest's static-root harvest, which runs in the host |
| `env.resolve_externref(i32) -> externref` | **function** | handle to live externref. See "the four functions" below |
| `env.__wpk_fork_host_ref_identity(anyref) -> i32` | **function** | stable id per GC reference. See below |

## B. Supplied directly to the guest — 5

The fork-module serves most of the guest's fork ABI. These five it cannot.

| import | kind | why the host |
|---|---|---|
| `__wpk_fork_ref_encode_funcref(funcref) -> i32` | **function** | funcref identity — see below |
| `__wpk_fork_ref_provenance_externref(externref) -> externref` | **function** | externref identity — see below |
| `__wpk_fork_module_activation` | global i32 | **one fork-module instance serves N guest activations** (main program plus each `dlopen`'d side module), and each needs a different value. One exported global has one value. The host supplies it per instantiation, which is also why arbitrary N works |
| `__wpk_fork_module_state_table_generation_addr` | global i64 | the address of the process-wide table-generation word the reconcile guard loads. Per-process, host-allocated |
| `__wpk_fork_resume_table` | funcref table | the guest only ever `call_indirect`s through it — it never writes to it — so the host fills it from the guest's resume catalog |

## C. Not imports — 4

Child worker spawn and COW instantiate · the `fork()`/`vfork()` syscall over the
channel · the guest entry, unwind-catch and phase re-enter loop · the
worker-message bridge.

The fork spans TWO workers — the child reconstruct runs in a different instance
— so no single module call can span it. That is why these stay host-sequenced
regardless of how much else moves.

---

## The four functions, and why they exist

Three of them are the same concept — **reference identity** — in three type
flavours, and one is its inverse.

**Wasm cannot compare a funcref or an externref.** Measured against V8 with a
passing control:

```
ref.eq on eqref        VALIDATES            <- control
ref.eq on funcref      REJECTED
ref.eq on externref    REJECTED
ref.eq on anyref       REJECTED
```

and a host reference cannot be cast into the comparable hierarchy either —
`any.convert_extern` then `ref.test eq` returns 0 for a JS object, a function, a
string and null. So `__wpk_fork_ref_encode_funcref` and
`__wpk_fork_ref_provenance_externref` have nowhere else to live.

`__wpk_fork_host_ref_identity` is different in kind. GC values ARE comparable
(`ref.eq` validates on `eqref`), so the module CAN do this itself — and does, by
scanning the transit table. What wasm lacks is `ref.hash`: a reference cannot key
a map, so the in-module algorithm is linear, O(n) per lookup and O(n^2) over a
capture. This import buys O(1) by letting the host hand back a stable id.

**It is an optimisation, not a capability floor, and it should be described that
way.** It was accepted deliberately, for the whole possibility space of future
guests rather than for what runs today.

A measurement exists and is recorded as a FACT, not as a reason: 0 of 78 built
guest binaries contain a Wasm-GC struct or array type, and everything exercising
that path today is a test double. **That bounds nothing.** Kandelo is a generic
platform; the absence of a caller today is not an argument against building the
capability, and it was twice offered as one before the maintainer ruled
otherwise. The measurement is useful only for judging urgency and for knowing
what is exercised by tests versus by programs.

`env.resolve_externref` is the replay direction: handle back to the live value.
It is listed as a function because that is what a host writes today. It could
become a bulk table seed — the host filling an externref table once instead of
answering per lookup — which would move it out of this section. That has not been
done, and until it is, counting it as anything but a function understates the
floor.

## Naming

Everything is `__wpk_fork_*` except `env.resolve_externref`, which predates the
convention. The new identity import takes the prefix. Renaming the old one is a
contained but wide change (~20 files, most of them TypeScript that does not
currently build) and is deliberately not bundled here.

---

## Open: the table mutation transaction has no ABI-defined protocol

Found 2026-09-12 while moving the `module_state_*` family into the module.
**This is unresolved and may add to the list above.**

Four guest imports form a cross-worker transaction around every table
mutation:

```
mutation_begin() -> i64            ;; take the writer lock, return the generation
  ... table.set / copy / fill / init / grow ...
dirty_mark(owner, first_page, page_count)
mutation_commit(owner, start, count)   ;; publish the slot range, release the lock
mutation_abort()                       ;; release without publishing
reconcile() -> i64                     ;; apply siblings' mutations, return the generation APPLIED
```

and a guard the instrumenter injects around ordinary table reads:

```wat
(if (i64.ne (i64.atomic.load (global.get $generation_addr)) (global.get $last))
  (then (global.set $last (call $reconcile))))
```

The generator's comment is explicit about why `reconcile` returns a value
rather than the guard re-reading the fence: *"a writer may publish a newer
generation after reconcile returns, and caching that unapplied value would skip
the next guard."*

**What is missing.** `crates/shared` defines the four import NAMES and the
generation-address global. It defines **no wire format**: no published-mutation
record layout, no ring or log, no writer-lock representation. `fork-codec` has no
module for it. The entire mechanism lived in the host.

So the module cannot take this over by inverting a decoder — there is nothing to
invert. Moving it means **designing a cross-worker publication protocol**, and
its failure mode is a silently torn table capture when one pthread forks while
another is mid-mutation. No test in the fork-module harness could catch that: the
harness is single-threaded by construction.

**DECIDED 2026-09-12: design the shared-memory protocol and move all four into
the module.** Shared linear memory is a `SharedArrayBuffer`, so the exchange is
wasm atomics over a control block every worker of the process already agrees on
— the same thing the `Atomics` API does from JavaScript.

A third option was offered and was wrong: "measure whether pthread-shared
mutable tables occur in shipping guests, and narrow the boundary if they do
not." **Whether a guest uses a feature today does not bound what the platform
must provide.** That reasoning was offered twice — here and for Wasm-GC identity
— and rejected both times. It is recorded so it is not offered a third.

The rejected alternative worth keeping in view is leaving all four in the host:
that would put them on the list above, taking it from 4 host functions to 8, and
would make a complete native host implement a concurrency protocol rather than
plumbing. Moving them into the module is what keeps the host contract plumbing.

### The control block

`__wpk_fork_module_state_table_generation_addr` today points at a single `i64`
generation word. It becomes the base of a small block the host allocates in
shared linear memory — still ONE allocation for the host, now sized:

| offset | type | meaning |
|---|---|---|
| `+0` | i64 | generation, bumped on every publish |
| `+8` | i32 | writer lock (0 free) |
| `+12` | u32 | reserved |
| `+16` | u32 | ring head — a monotonically increasing record index |
| `+20` | u32 | ring capacity in records |
| `+24` | … | ring of 32-byte records: `(i64 generation, u32 owner, u32 pad, u64 start, u64 count)` |

Each worker keeps its OWN depth counter and last-applied index in module-local
state — the fork-module's BSS is per-worker — so only the 0→1 and 1→0 lock
transitions touch the shared word, and a nested mutation does not deadlock
against itself.

**Ring overflow is fail-SAFE, not fail-loud.** A reconciler that has fallen
further behind than the ring is deep cannot know which ranges it missed, so it
marks every page of every owner dirty. That over-approximates the sparse overlay
— a larger capture, never a wrong one — which is the only direction that is safe
to guess in.

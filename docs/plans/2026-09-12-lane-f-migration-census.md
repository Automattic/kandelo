# Lane F census, asked the right way: what fork logic is still in TypeScript, and why

The earlier census in this directory counted `fm_*` entry points. That was the
question the plan asked, and it was the wrong question. The maintainer's actual
goal:

> All possible fork logic that can be moved into the Rust fork-module should be
> migrated there **and the original implementation deleted**. Somehow it seems
> like we've written a lot of Rust for that but didn't reduce the TS
> implementation by an order of magnitude. That makes it appear like migration
> didn't actually happen, or like it is incomplete. The result I want is: forking
> is completely managed in Rust except for a very thin layer of TS that calls it
> or provides a few imports that cannot be done within Wasm.

This census answers that. Measured 2026-09-12 in `/Users/brandon/kandelo-lane-f`.
"Lines" everywhere below means CODE lines — neither blank nor purely a comment.

---

## The short answer

**The migration is real and the Rust runs. The TypeScript did not shrink because
every migration moved an ALGORITHM and left its DATA MODEL and its DRIVER
behind.**

- **13,527 lines of Rust are compiled into the co-resident fork module and
  reached from it** (`crates/fork-module` 2,652 + the 10,875 lines of
  `crates/fork-codec` its entry points reach). This is not shelfware.
- **19,791 lines of fork TypeScript are still live**, every file of it imported
  on the production path.
- **9,050 of those TypeScript lines are a SECOND implementation of a wire format
  that Rust already implements, and both are executing.** Not a shim over the
  Rust — an independent parser and builder, reading the same generated ABI
  constants, for the same bytes.

So the honest framing is not "migration didn't happen". It is: **migration
happened for the algorithms and stopped at the data model.** The module
reconstructs the reference graph, drives the guest, journals the frames, and
seals the capture. The host still independently parses and builds every arena,
segment, transaction, journal and codec record those operations travel in.

---

## The evidence, in the code's own words

`host/src/worker-main.ts:4540`, a comment written by whoever did the last
migration step:

> The `decodedChildReferences` decode the host keeps **no longer drives the
> host-side STRUCTURAL consumer** … but it is **still held for the
> reconstruction WIRING it feeds** (`ForkEarlyChildReferenceProvider` + the
> continuation `attachChild`), **not for the reconstruction algorithm itself**.

That sentence is the whole finding. The algorithm moved. The wiring stayed. The
wiring needs the decoded graph, so the 988-line TypeScript segment decoder, the
999-line transaction parser and the 3,424-line arena implementation underneath
it all stayed live to feed it.

And `host/src/fork-reference-wire.ts` describes itself, in its own header, as
the "**staying wire-parse core**". The duplication is not accidental; it was
decided, and it was never revisited.

**Both sides consume the identical ABI constants**, which is what makes them the
same format rather than two formats that resemble each other:

| constant | TypeScript parser | Rust parser |
|---|---|---|
| `WPK_FORK_REFERENCE_TRANSACTION_MAGIC` | `fork-reference-wire.ts` | `reference_segments.rs`, `reference_segments_writer.rs` |
| `WPK_FORK_REFERENCE_SEGMENT_MAGIC` | `fork-reference-wire.ts` | `reference_segments.rs`, `reference_segments_writer.rs` |
| `WPK_FORK_JOURNAL_IMAGE_HEADER_SIZE` | `fork-module-state.ts` | `module_state_records.rs` |

---

## Every fork TypeScript file, classified

19,791 lines across 38 files. `worker-main.ts` (5,958) and `process-lifecycle.ts`
(3,359) carry more fork logic on top and are counted separately by the budget.

### A — true floor: the engine cannot express it. **1,461 lines (7%)**

| file | lines | why it cannot move |
|---|---|---|
| `fork-reference-broker.ts` | 521 | externref identity and lifetime. A Wasm module cannot hold a live `externref` in Rust or mint one from a handle. |
| `fork-static-root-catalog.ts` | 195 | the anyref catalog table is built from live values. |
| `fork-module-instance.ts` | 199 | `WebAssembly.instantiate` + PIC placement globals; a module cannot place itself. |
| `fork-module-trampoline.ts` | 180 | per-activation `WebAssembly.Module` minting. **Challengeable** — §"Not floor" below. |
| `fork-anyref-transit.ts` | 98 | `Table.grow` on a host-owned imported table; Rust/LLVM will not emit it. A `wat` shim could. **Partly challengeable.** |
| `fork-function-catalog.ts` | 97 | funcref value → ordinal. Wasm has **no funcref equality instruction** (`ref.eq` is `eqref`). This is the hardest floor item and the plan does not name it. |
| `fork-worker-exception-capability.ts` | 95 | `WebAssembly.Tag` capability plumbing. |
| `fork-unwind-transport.ts` | 35 | the fork-unwind `Tag` itself. |
| `fork-module-host-capabilities.ts` | 26 | `resolve_externref` — the proven floor seam. |
| `fork-externref-provenance.ts` | 15 | the `WeakMap` from live value to handle. |

### B — the thin call layer the maintainer wants to keep. **1,219 lines (6%)**

`fork-module-backend.ts` (646), `fork-module-reconstruction.ts` (212),
`fork-continuation.ts` (160), `fork-reference-capture-module.ts` (159),
`fork-reference-contracts.ts` (33), `fork-mechanism-trace.ts` (9).

**A + B = 2,680 lines. That is the target shape, and it already exists.** The
thin layer is not missing; it is buried under the two categories below.

### C — a wire format implemented twice, both live. **9,050 lines (46%)**

| TypeScript | lines | Rust twin | lines | twin runs in the module? |
|---|---|---|---|---|
| `fork-module-state.ts` | 3,424 | `module_state.rs` + `module_state_records.rs` | 1,496 | **yes** |
| `fork-imported-globals.ts` | 1,101 | `imported_globals.rs` + `imported_tables.rs` | 857 | no — see D-2 |
| `fork-reference-wire.ts` | 999 | `reference_transaction.rs` | 1,011 | **yes** |
| `fork-reference-segments.ts` | 988 | `reference_segments.rs` + `_writer.rs` | 983 | **yes** |
| `fork-gc-codec.ts` | 830 | `gc_codec.rs` | 663 | **yes** |
| `fork-replay-events.ts` | 654 | `replay_events.rs` | 637 | **yes** |
| `fork-exception-provider.ts` | 448 | `exception_codec.rs` | 271 | no — see D-2 |
| `fork-table-snapshot.ts` | 222 | `drive_plan_hints.rs` | 520 | no — see D-2 |
| `fork-reference-scratch.ts` | 208 | (arena scratch, served by `module_state.rs`) | — | **yes** |
| `fork-resume-catalog.ts` | 114 | `catalogs.rs` + `replay_journal.rs` | 852 | partly |
| `fork-reference-recipes.ts` | 62 | `reference_recipes.rs` | 722 | **yes** |

**This is where the order of magnitude went.** Nine thousand lines of host code
whose job is to read and write bytes that Rust already reads and writes.

### D — orchestration and wiring the module does not own. **8,061 lines (41%)**

| file | lines | what it holds |
|---|---|---|
| `fork-activation-registry.ts` | 1,674 | per-activation tables, globals, replication, generation fence |
| `fork-early-reference-provider.ts` | 1,463 | the pre-instantiation reference provider the JS decode feeds |
| `fork-externref-import-mailbox.ts` | 1,165 | cross-Worker mailbox routing externref-bearing host imports to the owner |
| `fork-process-continuation.ts` | 961 | the process-level phase machine |
| `fork-capture-session.ts` | 802 | **the capture WALK** — decides what to intern, in what order |
| `fork-worker-import-exceptions.ts` | 796 | host-import exception routing across workers |
| `fork-host-import-runtime.ts` | 428 | live Worker object/generation authorization |
| `vfork-lifetime.ts` + `vfork-workspace.ts` | 441 | borrowed-child lifetime |
| `fork-replay-gate.ts` | 169 | replay gate. **Challengeable** — Wasm has `memory.atomic.wait` |
| `fork-externref-process-owner.ts` | 162 | owner planning |

---

## Why it stopped where it did — the mechanism, not the blame

The master plan already names this mechanism for `fm_*` entry points: *"porting
a function moves an algorithm and leaves its driver."* **It applies at the file
level too, and nobody measured it there.**

Each migration step took a self-contained algorithm — decode this graph, build
this plan, journal these frames — and gave it to Rust. None of them took the
*wiring*: who calls it, with what, at which moment, holding which live values.
The wiring stayed in the host because the host owns the reference identity floor
(category A) and must hand values in and out per node. And wiring that must
inspect a record needs to parse the record, so every wire format kept its
TypeScript parser.

The result is a genuinely inverted *engine* sitting inside a host that still
owns the *data model*. That is why the `fm_*` entry count fell from 74 to 62
while the TypeScript did not move: the entry count measures the seam, and the
seam is not where the lines are.

---

## The single highest-leverage question, and a fact that bears on it

Category C is deletable only if the host never needs to read a fork wire format
itself — which means the module must be callable at **every** moment the host
currently parses bytes. The stated obstacle is pre-instantiation: the child host
decodes the inherited arena before the guest instance exists, and
`fork-early-reference-provider.ts` exists to make "owner planning and graph
validation an actual pre-instantiation operation".

**In the child path in `worker-main.ts`, that obstacle appears not to hold:**

| line | what happens |
|---|---|
| **3643** | `instantiateForkModule(...)` — the co-resident module is instantiated |
| 4111–4147 | `childArena` is created; `readForkModuleStateRoot` in TypeScript |
| **4437** | `decodeSegmentedForkReferenceTransaction(...)` — the host decodes the whole graph in TypeScript |
| **4780** | `WebAssembly.instantiate(...)` — the GUEST instance is created |

The module is live at 3643, three hundred lines before the host decodes in
TypeScript at 4437. If that ordering holds on every branch — **I have checked
the line order, not every branch, and this needs confirming before anyone builds
on it** — then "the host must decode because the module does not exist yet" is
false, and `fm_decode_reference_graph` (which already exists, and which the host
already calls at 4575) can serve the wiring instead of the JS decode.

That one change is what makes category C collapse, because
`fork-reference-segments.ts`, `fork-reference-wire.ts` and most of
`fork-module-state.ts` exist to serve it.

---

## Three claimed floors that are not floors

Recorded because a false floor is permanent: nobody re-examines a line that says
Wasm cannot do this.

1. **`fork-replay-gate.ts` (169).** Wasm has `memory.atomic.wait`. The gate is a
   host choice.
2. **`fork-anyref-transit.ts` (98) sizing.** `table.grow` is a real instruction;
   Rust will not emit it for an imported table, but a hand-written `wat` shim
   will — and this module already ships hand-written shims for exactly this
   reason (`fm_drive_execute`, `__wpk_fork_ref_decode_*`).
3. **`fork-module-trampoline.ts` (180).** Per-activation `WebAssembly.Module`
   minting is a host capability, but whether a trampoline per activation is
   needed at all is a design question that has never been asked.

Conversely, one floor item is REAL and is not written down anywhere:
**Wasm has no funcref equality instruction**, so `ForkFunctionCatalog.encode`'s
live-funcref → ordinal direction genuinely cannot happen inside the module. It
belongs in `CLAUDE.md`'s floor list, because an unnamed floor is one a future
agent must re-derive.

---

## 2,498 lines of Rust in `fork-codec` the module never reaches

`dylink_archive` (1,076), `imported_globals` (432), `imported_tables` (425),
`catalogs` (294), `exception_codec` (271). Some serve `host-native` or the
encoder side; **`imported_globals` and `imported_tables` are the exact twins of
the 1,101-line `fork-imported-globals.ts`, written and not wired.** That is
hazard H-1 at scale: Rust that looks finished, with tests and doc comments, whose
TypeScript twin is what actually runs.

---

## What "order of magnitude" would actually require

Target: **A + B ≈ 2,700 lines**, from 19,791. That is a 7x reduction, and it is
reachable only by deleting C and D — not by collapsing more `fm_*` entries, which
is what lane F has been doing.

In leverage order:

1. **Make the module the sole decoder in the child** (the ordering fact above).
   Collapses most of C — call it 6,000–7,000 lines — because those files exist to
   serve the host's own decode.
2. **Move the capture WALK** (`fork-capture-session.ts`, 802) into the module.
   The intern LEAVES are already module-owned; the walk is not. This is the item
   the earlier census identified and it unblocks deleting the capture-side wire
   code.
3. **Wire the two orphan Rust twins** (`imported_globals`, `imported_tables`) and
   delete `fork-imported-globals.ts`: 1,101 TypeScript lines against 857 Rust
   lines that already exist.
4. **Decide the three false floors** above: ~450 lines, and more importantly they
   stop being excuses.
5. **The identity floor stays.** Categories A is real and should be defended, not
   shrunk — it is the "few imports that cannot be done within Wasm".

**This is a re-scope, not a continuation.** Lane F's increments (F2/F3/F4) are
about the `fm_*` seam. The lines are in the data model. Both are worth doing, but
only one of them answers the question that was actually asked.

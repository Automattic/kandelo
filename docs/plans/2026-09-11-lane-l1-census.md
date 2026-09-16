# Lane L1 — census of host↔kernel plumbing against `crates/host-native`

**Date: 2026-09-11. Status: complete. This is L1, lane L's first increment.**

Its job was to replace lane L's provisional target with a number derived
from evidence. **It did, and the provisional number was wrong by roughly
2.4x in the optimistic direction** — consistent with the campaign's
standing estimation bias.

## Method

Lane L covers `kernel-scratch.ts` (2,491), `kernel-entry-gate.ts`
(1,596), `process-memory.ts` (1,337) and `worker-protocol.ts` (429) —
**5,853 lines**.

`crates/host-native` is 17,757 lines of Rust running the same kernel with
no JavaScript at all. For each unit, the question was what that host does
for the same job, with three possible answers:

1. **Already in Rust** — the TypeScript is duplicate, and the knowledge
   should live once.
2. **Genuinely absent** — a JavaScript-engine fact a native host never
   encounters.
3. **Absent because the native host has the same gap** — a defect to
   file, not a migration.

**A fourth answer turned up that the lane had not anticipated**, and it
is the most useful result here. See "JS-only overhead" below.

## Findings

| Unit | Lines | What `host-native` does | Verdict |
|---|---|---|---|
| Intrinsic capture (`intrinsic*`, `typedArray*`) | ~428 | Nothing. Rust has no prototype mutation. | **JS-only overhead** |
| Guest-address bounds checking | ~200 | `checked_shared_range`, whose doc explicitly mirrors `checkedWasmImportMemoryRange` | **Duplicate** |
| Capacity-beside-pointer (`OwnedKernelScratchRegion`) | ~600 | **Nothing.** Raw `unsafe write_bytes` after a `ptr > 0` check | **Gap in the native host** |
| `KERNEL_SCRATCH_EXPORT_NAMES` + pointer-position tables | ~150 | Nothing — `get_typed_func` supplies typed signatures | **Generatable** |
| Re-entrancy gate | ~900 | `caller_export_typed`; the borrow checker forbids holding `&mut Store` twice | **Partly structural in Rust** |
| Process memory layout | ~500 | `ProcessLayout` — same fields, derived at the same moment | **Duplicate** |
| Worker protocol | 429 | No workers. Native threads. | **JS-host structural** |

## The fourth category: JS-only overhead

Lane L was written assuming every line is either floor or migratable.
**About 428 lines are neither.** `kernel-scratch.ts` captures 46
`intrinsic*` bindings — `DataView.prototype.getInt32`, typed-array
accessors, `Object.freeze` — and `kernel-entry-gate.ts` captures 27 more,
because in JavaScript any of those can be replaced at runtime. Rust has
no such hazard, so `host-native` captures nothing.

This matters for how goal V4 is scored. **These lines cost a new host
nothing**, because a new host never writes them. Counting them in a
"minimize the host API surface" budget overstates the surface a wasmtime
host actually faces. They are a tax the JavaScript host pays for being
JavaScript, and the honest thing is to name them as such rather than
carry them as either floor or debt.

The same is true of `worker-protocol.ts` (429): `host-native` uses native
threads and needs no worker wire at all.

## The finding that reframes lane L

**A new host's burden here is already near zero, and `host-native` is the
proof.** It runs the same kernel, and for this entire lane it wrote a
small layout struct, one bounds-check helper, and nothing else.

So lane L is **not** "5,853 lines a wasmtime host must reproduce". That
framing, which the lane text carried, was wrong.

What lane L actually is: **the same knowledge exists twice, and the second
copy was made by transcription.** `host-native` cites `host/src/*.ts` in
**47 comments** — it was written by reading the TypeScript. Its
`ProcessLayout` carries the same fields as `ProcessMemoryLayout` and its
own comment says the pointer width is derived "the same moment
`host/src/kernel-worker.ts` calls `detectPtrWidth`". Its
`checked_shared_range` doc names the TypeScript function it mirrors,
including the `allowAddressZero: false` detail.

**Two transcribed copies drift, and host #3 transcribes a third.** That is
the real cost, and it is a V1 cost (share code across hosts) more than a
V4 one.

## Two defects found, neither previously filed

**L-D1 — the native host does not enforce the capacity invariant.**
`kernel-scratch.ts` exists because a pointer inside `WebAssembly.Memory`
proves the host *can* address those bytes, not that the allocator *gave*
them to this caller. `host-native` does:

```rust
let manifest_ptr = alloc_scratch.call(&mut kernel_store, manifest_len)?;
if manifest_ptr <= 0 { anyhow::bail!(...) }
unsafe { write_bytes(&kernel_mem, manifest_ptr as u32 as usize, &base_image.manifest) };
```

`write_bytes` is a bare `copy_nonoverlapping` with no bounds or capacity
check. This particular call site is sound by construction — it asks for
`manifest_len` and writes `manifest_len` — but nothing *enforces* that,
and the JS host has an entire ownership type system for exactly this.
**This is census outcome 3: not floor, and not permission to keep the
gap.**

**L-D2 — REFUTED 2026-09-12. Keep reading, but do not act on it.**

This census filed L-D2 as a hand-maintained table with nothing checking
it. **`host/test/kernel-scratch-contract.test.ts` checks it**: it parses
`crates/kernel/src/wasm_api.rs`, extracts each export's pointer
positions, and fails if they disagree with the TypeScript table. It also
enforces the `_ptr` suffix on raw-pointer parameters and requires every
pointer to be followed by an explicit length or capacity.

The census did not look for a test. It observed that the table was
hand-written, compared its 55 names against the generated
`HOST_ADAPTER_*_KERNEL_EXPORTS` lists, found a 20-name overlap, and
concluded from the mismatch that nothing was checking it. **The two lists
serve different purposes and their disagreement was never evidence of an
unguarded table.**

What follows below is the original text, kept so the error is legible
rather than tidied away.

**L-D2 (as originally filed) — the scratch pointer table is 35 exports
wider than the generated ABI list.** `KERNEL_SCRATCH_EXPORT_NAMES` names **55** kernel exports and
records which argument positions of each are pointers, by hand.
`HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS` (78) and its optional companion (8)
are generated from Rust by `dump_abi.rs`. **The two lists overlap on only
20 names**: 35 exports the host validates pointers for — including
`kernel_ioctl`, `kernel_select`, `kernel_poll`, `kernel_recv`,
`kernel_send` and `kernel_rootfs_write_file` — appear in neither generated
list. Adding a kernel export or moving an argument requires a hand edit
here with nothing checking it. This is lane G's failure mode in a
different file.

## The derived target

Per unit, what survives if lane L does everything it should:

| Unit | Now | After | Why |
|---|---|---|---|
| `process-memory.ts` | 1,337 | ~400 | Layout computation becomes shared/generated; allocation and lease mechanics stay |
| `kernel-scratch.ts` | 2,491 | ~1,400 | Pointer table generated; bounds rules shared; capacity mechanics stay, because JS has no engine-enforced bounds |
| `kernel-entry-gate.ts` | 1,596 | ~1,400 | The gate stays: Rust gets this from the borrow checker, JavaScript cannot |
| `worker-protocol.ts` | 429 | 429 | JS-host structural; a native host has no workers |
| **Total** | **5,853** | **~3,629** | |

**The lane's target moves from 1,500 to 3,600.** The provisional number
assumed the bulk was ceremony around two invariants; the census says the
bulk is the invariants themselves, plus a worker protocol that is not
going anywhere and JS armor that a native host never needed.

**This is the census doing its job.** A 1,500 target with a ratchet behind
it would have been a made-up number enforced as a commitment, and the lane
would have been judged a failure for landing at 3,600 correctly.

## What L2 onward should now be

The increments change, because the finding changed:

- **L2 — generate the scratch pointer table** from the kernel's own export
  signatures, closing L-D2. This is the cheapest item and it removes a
  hand-maintained ABI table.
- **L3 — one process-memory layout**, in `crates/shared`, consumed by both
  hosts. `ProcessLayout` and `ProcessMemoryLayout` are the same struct
  written twice.
- **L4 — one bounds-check rule**, likewise. `checked_shared_range` already
  documents itself as a copy.
- **L5 — fix L-D1** by giving the native host the capacity invariant,
  rather than deleting the JS host's version of it.
- **The re-entrancy gate and the worker protocol are not lane L work.**
  They stay. Saying so is part of the deliverable.

## What this census did not establish

- **Whether `kernel-entry-gate.ts` needs 1,596 lines** to hold a gate the
  borrow checker gives Rust for free. The ~1,400 estimate assumes it is
  roughly right-sized; nobody has audited it against a smaller design.
- **Whether the ~200-line bounds-checking estimate is accurate.** It was
  derived by reading, not by attributing every line.
- **Anything about lane L's browser behavior.** This census read Node-side
  and Rust-side code only.


# Lane F census — the `fm_*` surface, reconciled and categorized

**This is increment F1.** The MASTER-PLAN's lane F section made F1 "reconcile 71
vs 95 and publish the categorized surface", and made F2 depend on it. This is
that publication. Measured 2026-09-12 in
`/Users/brandon/kandelo-lane-f` at merge-base `052e7e9e6`, read-only.

Every number below is reproduced by a command given inline, so the next reader
re-measures rather than re-derives — re-derivation is how this surface grew in
the first place.

---

## 1. The reconciliation: 71, 95, and what is actually there

Neither 71 nor 95 is the surface. They measured three different things, and the
plan's own later correction ("69 Rust-declared plus one injected") was closer
but still short of the shape that matters.

| count | what it actually measures | command |
|---|---|---|
| **69** | `fm_*` functions the Rust module declares | `grep -cE 'pub (unsafe )?extern "C" fn fm_' crates/fork-module/src/lib.rs` |
| **5** | frozen guest-ABI `__wpk_fork_*` re-exports beside them | `grep -cE 'pub (unsafe )?extern "C" fn __wpk_' crates/fork-module/src/lib.rs` |
| **3** | exports only the walrus injector can emit (`fm_drive_execute`, `__wpk_fork_ref_decode_funcref`, `__wpk_fork_ref_decode_externref`) | `crates/fork-module-inject/src/main.rs` |
| **1** | module-*defined* table export (`__wpk_fork_ref_gc_transit`) | same |
| **76** | names the host asserts at instantiation | `FORK_MODULE_REQUIRED_EXPORTS` in `host/src/fork-module-instance.ts` |
| **65** | of the 69 that have a caller in *either* host | §3 below |
| **107** | `fm_*` tokens anywhere in TypeScript — the origin of "95" | `grep -rhoE '\bfm_[a-z0-9_]+' host/src \| sort -u` |

**The 107 figure is not a surface and never was.** It counts tombstone comments
that document their own deletion (`// the former fine-grained `fm_begin_replay` /
`fm_begin_abort` DRIVE exports were deleted`), template-string prefixes
(`fm_capture_`, `fm_ref_`), and field names. Thirty-eight of the 107 tokens
resolve to no export at all. `forkModuleEntryPoints` in
`docs/surface-budget.json` already measures the right thing — the Rust
declaration count — and reads **69**.

**The direction of travel was reported backwards, twice.** The surface has been
shrinking, not growing: the 71 in the older document was a real floor at the
time, and the entries deleted since then are exactly the ones the tombstones
name.

---

## 2. The finding that changes lane F's shape: F3 is substantially landed

The MASTER-PLAN's end state — *"the host calls 3-5 coarse entries and does
nothing between them"* — is written as future work, with F3 listed as "the four
coarse entries, in the order §3 gives". **Thirteen coarse entries already exist
and are the production path on both hosts.**

| coarse entry | what it already sequences internally |
|---|---|
| `fm_parent_begin_capture` | activation 0 open + each side activation + per-activation arena-root publish + drives every guest `wpk_fork_unwind_begin` |
| `fm_parent_seal_capture` | drives every `wpk_fork_unwind_end`, seals writers + journal, serializes the child image |
| `fm_parent_abort_seal` | the mid-unwind sibling: seals without driving the guest (the `ABORT_UNWINDING` discipline, in the module) |
| `fm_parent_replay` / `fm_parent_abort` | begins rewind/abort, builds the per-activation begin plan, drives every guest `wpk_fork_rewind_begin` / `wpk_fork_abort_begin` |
| `fm_parent_finish` | drives every `wpk_fork_rewind_end` / `wpk_fork_abort_end`, then finishes |
| `fm_child_seed` / `fm_child_seed_borrowed` | decodes the inherited `JournalImage` and seeds activation 0 + every side activation |
| `fm_child_reconstruct` | builds and drives the per-activation rewind-begin plan |
| `fm_attach_child` / `fm_attach_borrowed_child` | builds the reconstruction drive plan and appends the two-phase restore/finish install order |
| `fm_restore_from_arena` | seeds the reference driver/feed **and** builds the whole topological drive plan |
| `fm_abort` | releases every channel-mapped chunk |

The fine-grained drivers they replaced — `fm_begin_unwind`,
`fm_add_activation_unwind`, `fm_finish_unwind`, `fm_serialize_journal_alloc`,
`fm_begin_replay`, `fm_begin_abort`, `fm_finish_replay`, `fm_finish_abort`,
`fm_begin_child_replay`, `fm_begin_borrowed_child_replay` — **are gone from the
module**, and their host-side driving loops are gone with them.

**So the remaining 69 is not 69 entries of host sequencing.** Grouped by what a
new host would actually have to drive:

| group | n | is it host *sequencing*? |
|---|---|---|
| coarse phase entries | 13 | **yes** — this is the inverted surface |
| capture leaf (`fm_capture_*`) | 17 | **yes**, and it is the largest un-inverted cluster |
| setup seeding (`fm_set_*`) | 8 | no — once-per-worker, host→module direction is correct |
| guest reference-import feed (`fm_ref_*`) | 7 | **no** — the *guest* calls these; the host only binds them |
| shared frame ABI (`fm_frame_*`, `fm_resume_peek`) | 5 | no — frozen ABI-44 contract, per-activation trampolines |
| drive plan | 6 | partly |
| decoded-graph readout | 3 | yes |
| catalog coordinate lookups | 3 | no — leaf lookups the injected shim and native use |
| diagnostics (`fm_stats`, `fm_last_errno`) | 2 | no |
| misc (`fm_activation_module_buffer`, `fm_journal_image_len`, `fm_begin_reference_replay`, the two `fm_add_activation_*_child_replay`) | 5 | mixed |

The seven `fm_ref_*` entries deserve a specific warning: **they are not host
surface and must not be collapsed.** The host binds them into the *guest's*
import object at the `WPK_FORK_REFERENCE_IMPORT_*` names in
`crates/shared/src/lib.rs`. Changing their shape is a guest-ABI change and a
re-instrument, which lane F is explicitly not.

---

## 3. The finding nobody has recorded: there are two hosts, and they diverge

`crates/host-native` is a second, real host — wasmtime, driving the same module
— and its `fm_*` surface is **not the same as TypeScript's**.

```
grep -oE '"fm_[a-z0-9_]+"' crates/host-native/src/guest.rs | sort -u    # 33
grep -rhoE '(exports|fn)\.(fm_[a-z0-9_]+)' host/src --include='*.ts' \
  | sed 's/.*\.//' | sort -u                                           # 60
```

- **TypeScript uses 60.** Native uses 33. The union is 65.
- **Native-only (5):** `fm_begin_reference_replay`, `fm_build_gc_plan`,
  `fm_externref_handle`, `fm_funcref_ordinal`, `fm_static_root_slot`.
- **TypeScript-only (32):** the entire 17-entry `fm_capture_*` family,
  `fm_attach_child` / `fm_attach_borrowed_child`, `fm_restore_from_arena`, the
  3 decoded-graph readouts, the 5 frame-ABI entries, `fm_abort`,
  `fm_activation_module_buffer`, `fm_set_activation_resume_catalog`,
  `fm_set_activation_exception_tags`.

**Two of those differences are the same inversion, landed on one host only.**
TypeScript calls the coarse `fm_restore_from_arena`, which folds
`fm_begin_reference_replay` + `fm_build_gc_plan` into one call. Native still
calls the two fine-grained entries. Neither can be deleted while native drives
them, so **the un-inverted host is what pins two entries of the inverted host's
surface in place.**

**This is a host-parity defect of the same species lane E exists for,** and it
is filed here as **F-D1** because nothing else measures it:

> **F-D1 — the module's host surface is measured on one host and lived on two.**
> `docs/surface-budget.json`'s `forkModuleEntryPoints` counts Rust declarations,
> so it cannot see that TypeScript and native drive different subsets. Lane F's
> end state says "the host calls 3-5 coarse entries" without saying which host,
> and native is nowhere near that. **Any F2/F3 collapse must land on both hosts
> in the same commit**, or the surface does not fall — it forks.

The capture asymmetry is *not* a defect and should not be read as one:
native's capture bodies call `fork_codec`'s `ReferenceGraphBuilder` directly
in-process (`guest.rs`), because native is one address space. The wasm hosts
cannot, which is why the 17 `fm_capture_*` exports exist at all. That is a real
capability boundary, and it is why collapsing the capture family reduces the
*wasm* host surface without touching native.

---

## 4. Exports with no host caller at all

Five of the 69 are called by neither host (H-1 territory: "a dead floor reads as
complete", and all five carry careful doc comments):

| export | reality |
|---|---|
| `fm_add_activation_child_replay` | **no caller anywhere.** Superseded by `fm_child_seed`, which takes the whole side-activation list. Its doc comment says it "remain[s] exported for the module unit tests + host-native" — **both halves are false**: no module test calls it and it is absent from `guest.rs`. |
| `fm_add_activation_borrowed_child_replay` | identical, superseded by `fm_child_seed_borrowed`, identical false doc comment. |
| `fm_drive_bump` | **live, but not host-called** — the walrus-injected drive shim `call`s it once per driven step (`fork-module-inject/src/main.rs`). Correctly exported; it is module-internal by construction, not dead. |
| `fm_build_trivial_plan` | called only by `host/test/fork-module-drive-shim.test.ts`. |
| `fm_trivial_plan_count` | same test, same call. |

The first two are deleted by this lane (increment F0-r below). The last two are a
**maintainer decision, not a worker one**, and are raised rather than acted on:
they are a test-fixture surface whose only purpose is to give the injected drive
shim a plan to execute without standing up a whole fork. Deleting them deletes
that test's ability to build one; keeping them keeps two exports in the
production module for a test. Both readings are defensible, so the question is
put rather than answered. See §6.

---

## 5. Where the remaining reduction actually is

The plan says transport is ~7,000 lines because ~69 fine-grained entries each
need marshalling "**multiplied by per-type variants**". That mechanism is
correct, and the per-type variants are now enumerable:

| family | entries | collapses to | delta |
|---|---|---|---|
| `fm_capture_intern_{funcref,externref,i31,static_root}` | 4 | one kind-discriminated `fm_capture_intern(kind, a, b)` | **−3** |
| `fm_attach_child` / `fm_attach_borrowed_child` | 2 | **their Rust bodies are identical** — both are `attach_from_arena_impl(root, pid)` | **−1** |
| `fm_parent_replay` / `fm_parent_abort` | 2 | `fm_parent_replay(abort)` — both are `parent_replay_impl(bool)`, and `fm_parent_finish(abort: u32)` is the precedent already in the file | **−1** |
| `fm_parent_seal_capture` / `fm_parent_abort_seal` | 2 | `fm_parent_seal_capture(channel_base, abort)` | **−1** |
| `fm_add_activation_{,borrowed_}child_replay` | 2 | deleted outright (§4) | **−2** |
| `fm_child_seed` / `fm_child_seed_borrowed` | 2 | discriminable, but the side-record stride differs (16 vs 24 bytes), so it is a wire change, not a signature change | deferred to F3, argued |

**69 → 61** on those alone, with the host-side transport for each deleted
variant going with it. The precedent that this is the right move is already in
the tree: `fm_decoded_node_field(index, field)` replaced three same-signature
`(usize) -> i32` exports expressing the one concept "read a field of a decoded
node".

**What this does not reach.** The budget's closure condition for lane F is
`forkModuleEntryPoints <= 5`, `forkTypeScript <= 2500`, `workerMainTypeScript
<= 3000`. Sixty-one is not five. The gap is the 17-entry capture family and the
8 `fm_set_*` seeds, and closing it means the module owning the *capture walk*
(not just the intern leaves) and a single seeding descriptor — both of which are
F3/F4 work at the scale the plan's 15-30 agent-day estimate describes. **This
census does not make lane F smaller; it makes it legible.**

---

## 6. The `ABORT_UNWINDING` discipline says do NOT collapse one of the pairs

The plan lists `fm_parent_seal_capture` / `fm_parent_abort_seal` as a per-type
pair, and §5 above could be read as proposing to collapse them. **It does not,
and the reason is the hazard the plan itself names.**

The two entries differ in exactly the way the landmine cares about:

- `fm_parent_seal_capture` drives every activation's guest `wpk_fork_unwind_end`
  (`UNWINDING` -> `NORMAL`), then seals, then serializes the child image.
- `fm_parent_abort_seal` wraps the **same** `finish_unwind_impl` seal **with no
  guest drive and no serialize**, because the guest is still mid-unwind and
  flipping it there corrupts its state machine. Two naive attempts trapped or
  hung on precisely this.

Two distinct export names make that discipline **structural**: a host physically
cannot drive the guest on the abort path, because the entry it calls contains no
drive. Collapsing them to `fm_parent_seal_capture(channel_base, abort)` converts
a structural guarantee into a **runtime bit**, computed at a host call site, that
silently corrupts the guest state machine when wrong. Silent corruption is the
failure mode the plan singles out as worse than a loud one.

**Minus one entry is not worth that trade, so this pair is left alone** — and
recorded here rather than skipped quietly, because an unargued omission is
indistinguishable from an oversight.

**The contrast that makes the other pairs safe** is worth stating, since it is
the rule for the rest of the lane:

| pair | why collapsing is safe |
|---|---|
| `fm_attach_child` / `fm_attach_borrowed_child` | **byte-identical bodies** — both are `attach_from_arena_impl(root, pid)`. There is no discipline to lose; one of the two is a pure duplicate. |
| `fm_parent_replay` / `fm_parent_abort` | the flag already exists *inside* (`parent_replay_impl(bool)`), both paths drive the guest (differing only in which drive-table slot), and `finish_transaction_impl` **asserts the `in_abort` pairing**, so a mismatched flag is a loud `EINVAL` rather than corruption. `fm_parent_finish(abort: u32)` is the shipped precedent for this exact flag at this exact layer. |
| `fm_capture_intern_*` | leaf marshalling over `ReferenceGraphBuilder::intern_*`. No guest interaction, no state machine. |

---

## 7. Scoping the `kernel_exit` trap change — the prerequisite nobody had scoped

The MASTER-PLAN calls the guest entry/catch loop *"self-inflicted, and the
linchpin"*: the floor exists because a guest run can end via a tagged
`WebAssembly.Exception` (catchable in Wasm) **or** a `kernel_exit` `unreachable`
**trap** (catchable only in JS), and the two must be discriminated. It then says
the prerequisite — making `kernel_exit` throw a tagged exception — is unscoped.
Here is the scope. **It is much smaller than the framing implies, and finding
that out also turned up a latent defect.**

### 7.1 `kernel_exit` does not execute a Wasm `unreachable` at all

The plan, the scope document and `worker-main.ts`'s own comment all describe a
Wasm trap. The production path is not one:

```ts
// host/src/worker-main.ts:543, inside the kernel_exit host import
throw new WebAssembly.RuntimeError("unreachable");
```

`kernel_exit` is a **JavaScript host import** (`import_module("kernel")`,
declared in `libc/glue/channel_syscall.c` and
`libc/musl-overlay/src/env/__libc_start_main.c`). The "trap" is a JS closure
constructing a `RuntimeError` whose message happens to be the string
`"unreachable"`. Nothing in the guest's code, the kernel Wasm, or the engine
produces it.

**So the change is not a kernel change and not a guest change. It is a change to
one JS closure and its mirror in the native host** — an order of magnitude
smaller than "a prerequisite nobody has scoped" suggests.

### 7.2 The defect this exposes — filed as F-D2

The discriminator is a **regex over an error message**:

```ts
// host/src/worker-main.ts:201
return error instanceof WebAssembly.RuntimeError
  && /\bunreachable\b/i.test(error.message);
```

Three different producers can satisfy it, and the host cannot tell them apart:

1. the synthetic `RuntimeError("unreachable")` above — an orderly process exit;
2. a **genuine** guest `unreachable` — a real bug, a `panic=abort`, a corrupted
   instrumented frame — which V8 also reports as `"unreachable"`;
3. (WebKit) the same genuine trap, reported as *"Unreachable code should not be
   executed"*, which the `/i` and `\b` in the regex exist to absorb.

The only thing separating an orderly exit from a crash is a **side channel**:
every site pairs the regex with `kernelExitStatus !== null`, a variable set by
an `onKernelExit` callback (`worker-main.ts:3395, 3404`, consumed at 5292, 5432,
5615, 5620, 7321, 7408).

> **F-D2 — process exit is discriminated from a guest crash by an error-message
> regex plus a side-channel variable.** A guest that genuinely traps *after*
> `kernel_exit` has recorded a status is reported as an orderly exit with that
> status. That is the platform-values contract's "convenient illusion" —
> a crash presented as a clean exit — and it is load-bearing at six sites.

**`host-native` does not even share the illusion, which is a parity divergence
of its own:** it returns `Err(wasmtime::Error::msg(format!("kernel_exit({s})")))`
(`crates/host-native/src/guest.rs:6839`) — a message that contains no
`"unreachable"` and would not match the TypeScript predicate. Each host invented
its own out-of-band exit signal.

### 7.3 What the change actually is

The mechanism already exists in this repo, one file away. `fork-unwind-transport.ts`
mints a process-owned `WebAssembly.Tag`, names its import module/name from
generated ABI constants, and offers `isForkUnwindException(value, tag)` built on
`WebAssembly.Exception.prototype.is`. A process-exit tag is the same shape:

1. **Mint a process-exit `Tag`** with parameters `[i32]` (the status), alongside
   the fork-unwind tag, per Worker.
2. **`kernel_exit` throws `new WebAssembly.Exception(tag, [status])`** instead of
   the `RuntimeError`. The status rides the payload, so `onKernelExit` /
   `kernelExitStatus` — the side channel — is **deleted**, not merely bypassed.
3. **The six discrimination sites** become `exception.is(exitTag)`, and
   `isWasmUnreachableTrap` reverts to meaning what its name says: a genuine
   guest trap, which now correctly fails loud instead of being read as an exit.
4. **`host-native` throws the wasmtime equivalent** so both hosts signal exit the
   same way (closing the F-D2 parity half).

### 7.4 What it buys the inversion, and what it does not

**Buys:** with both terminations tagged, a walrus-injected Wasm shim can `catch`
both and discriminate them *inside* the module. The entry/catch/phase-re-enter
loop stops being a capability floor and becomes a choice — which is exactly the
plan's claim that "the bound is ours, not Wasm's", now with a scoped path.

**Does not buy:** a genuine guest trap (case 2 above) is still catchable only at
the JS boundary. That is fine and arguably the point: the shim catches the two
*expected* terminations and lets a real crash propagate to JS, which is the
behaviour F-D2 says we should have had all along.

**Also does not buy — and this bounds the payoff honestly:** the fork spans two
workers, and no module call can span parent and child. Dissolving the entry/catch
floor therefore removes **one** of the two reasons full inversion stops where it
does; the two-worker span is a genuine capability limit and survives.

### 7.5 Cost, risk, and the ABI question

- **Size:** small. One closure in `worker-main.ts`, one in `guest.rs`, six call
  sites, tag plumbing that mirrors an existing file, and the deletion of the
  `onKernelExit` side channel.
- **Risk:** `WebAssembly.Tag`/`Exception` availability is already a hard
  requirement for fork instrumentation (`createForkUnwindTag` throws without
  them), so this adds no new engine requirement. The real risk is behavioural:
  six sites currently treat *any* `unreachable` with a recorded status as a clean
  exit, and tightening that **will surface guest crashes that are silently
  reported as exits today**. That is the fix working, and it must be expected —
  not diagnosed as a regression.
- **ABI:** none, *provided the tag stays host-internal*. If a walrus-injected
  shim in the fork-module catches it, the tag becomes a **fork-module import** —
  host<->module contract, rebuilt in lockstep, no `ABI_VERSION` bump and no guest
  re-instrument. **It becomes guest ABI only if the guest itself imports the
  tag**, which this design does not require. Flag and stop if that changes.
- **Validation:** the six sites need H-2 perturbation (make each guard fail and
  report what it said), plus a test that a genuine post-`kernel_exit` guest trap
  is reported as a crash rather than as status N — the F-D2 case, which has no
  coverage today.

**This is scoped, not built.** It is a prerequisite for the entry/catch half of
the inversion, and it is not on the critical path of the F0-r/F2 reductions this
lane is landing now.

---

## 8. Open questions for the maintainer

1. **`fm_build_trivial_plan` / `fm_trivial_plan_count`** (§4): production exports
   with only a test caller. Delete them and rewrite
   `fork-module-drive-shim.test.ts` to build its plan another way, or keep them
   and record the exemption? *Not self-decided.*
2. **F-D1 (§3):** should `forkModuleEntryPoints` be split into a per-host
   measurement so the two hosts' surfaces cannot drift apart silently? Today one
   number hides the divergence that pins two entries in place.
3. **F-D2 + the `kernel_exit` tag (§7):** this is a correctness fix (a crash
   currently reads as a clean exit) that happens to also unblock the inversion's
   entry/catch half. Should it be sequenced into lane F, or filed to lane P
   (platform honesty), whose subject it matches more closely?
4. **`fm_child_seed` / `fm_child_seed_borrowed`** (§5): collapsing these means
   unifying a 16-byte and a 24-byte side record. Worth doing inside lane F, or
   is the wire churn better spent on the capture family?
5. **The seal pair** (§6): I judged the structural guarantee worth more than the
   entry. If the maintainer disagrees, it is a one-commit collapse.

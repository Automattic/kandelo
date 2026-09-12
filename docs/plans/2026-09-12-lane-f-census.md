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

---

## 9. What landed on this branch, and what it did not

Added 2026-09-12, after the census above was written and acted on.

| commit | change | `forkModuleEntryPoints` |
|---|---|---|
| `4a7f02a3d` | this census (F1) | 69 |
| `2839b1810` | delete `fm_add_activation_{,borrowed_}child_replay` — no caller in either host (F0-r) | 69 -> 67 |
| `4e7e7e867` | fold `fm_attach_borrowed_child` into `fm_attach_child` — identical bodies (F2) | 67 -> 66 |
| `413c54a41` | budget measures CODE lines, not total lines; seven surfaces re-baselined | — |
| `cc903919e` | `fm_capture_intern(kind, a, b)` replaces four; `fm_parent_replay(abort)` replaces two (F2) | 66 -> 62 |

**Lane F is NOT closed and this is not close to closing it.** Its budget
condition is `forkModuleEntryPoints <= 5`, `forkTypeScript <= 2000` and
`workerMainTypeScript <= 2400`. The measured state is **62**, **19,791** and
**5,958**. Seven entries is about a tenth of the entry-point distance and the
TypeScript surfaces did not move at all, because collapsing marshalling
wrappers is not where those lines are.

**What remains, in the order the census argues for:**

1. **The 17-entry `fm_capture_*` family.** The intern *leaves* are folded; the
   capture WALK is still host-driven — `fork-capture-session.ts` decides what to
   intern, in what order, and when to claim and define a GC aggregate. Moving
   the walk is the single largest remaining item and is most of the lane's
   estimate.
2. **The 8 `fm_set_*` seeds into one descriptor push.** Scope §5 called this
   "S, low risk, pure setup". It is the cheapest item left.
3. **F5 — `kernel_exit` as a tagged exception** (§7), which closes F-D2 and
   dissolves the entry/catch half of the floor. Scoped, not built, and possibly
   lane P's rather than lane F's (open decision 2).
4. **F-D1 — bring `host-native` onto the coarse entries.** Until it does,
   `fm_begin_reference_replay` and `fm_build_gc_plan` cannot be deleted.

**One measurement caveat that must travel with all of the above.** The fork
Vitest suites resolve the module from `local-binaries/source-only-v1/`, which
`crates/fork-module/build-wasm.sh` does not write — it stages into
`local-binaries/`. `./run.sh local-build` re-projects the tier, and on this
machine it failed on one package node, which blocked the projection. So the
commits above are validated by the two V8 harnesses (which load the built bytes
directly), the wasm32/wasm64 builds, `cargo check -p host-native` and the
surface budget — **not** by the fork Vitest suites. Filed as master-plan hazard
H-9, because a suite that goes green against a module it never loaded is worse
than one that fails.

## §10 — What `forkModuleEntryPoints` counts, and the 23 with no production caller

Measured 2026-09-12 against `crates/fork-module/src/lib.rs`,
`crates/fork-module-inject/src/main.rs`, `crates/host-native/src/*.rs`,
`host/src/*.ts`, `host/test/*.ts` and `crates/fork-module/tests/*.mjs`. No host
code constructs an `fm_*` name dynamically (checked), so a name grep is sound
here.

**The measure is a regex for `pub extern "C" fn fm_*` in one file.** It counts
definitions. It does not look at callers, and it deliberately excludes the
`__wpk_fork_*` guest exports. Its `why` field says it counts *host-called*
entries; it cannot enforce that.

| who calls it | count |
|---|---|
| production host (`crates/host-native`, `host/src`) | **27** |
| the injector's own shims, nothing else | **4** |
| tests only (`host/test`, `crates/fork-module/tests/*.mjs`) | **20** |
| nothing at all | **3** |

The entry's purpose — "how many fine-grained calls force the host-side driver
loops that make the TypeScript grow" — is served by the 27 alone.

### The four injector-only entries are not host surface

`fm_drive_bump`, `fm_capture_claim_gc`, `fm_gc_identity_find`,
`fm_gc_identity_claim`. Each exists because the work is split across a boundary
neither side can cross alone: **the injected wasm shim is the only thing that
can hold a reference, and Rust is the only thing that can hold a map or a
counter.** They are spelled as wasm exports only because the injector resolves
its helpers by name (`exported_function`). A host never sees them. Adding more
of them grows the host contract by **zero** — the correction recorded in the
master plan's open decision 2.

### The uncalled entries are mostly the unwired half of multi-activation

This looked like H-1 at scale. It is mostly not. Sort the uncalled by signature
and a pattern appears immediately: **`fm_frame_reserve/commit/peek/next`,
`fm_resume_peek`, `fm_set_activation_resume_catalog` and
`fm_activation_module_buffer` all take an explicit `activation_id`**, where the
guest-facing `__wpk_fork_frame_*` counterparts call the IDENTICAL `*_impl`
functions with `primary_activation()`.

They are the multi-activation (dlopen fork) variants: a fork across N
dynamically loaded libraries needs each activation's own resume catalog and its
own frame cursor, because resume-slot numbering must match THAT activation's
table by construction. Nothing wires them yet because no host drives a
multi-activation fork yet.

**That is pending capability, not dead code, and it must not be deleted to bank
a reduction.** The platform is meant to serve the whole possibility space of
future guests, and arbitrary numbers of dynamically loaded libraries are
squarely inside it.

### `fm_abort` is the one that is neither — and it may be a live gap

`fm_abort()` takes no activation id. It calls `abort_impl()`, which is reachable
from nowhere else, and which releases every channel-mapped fork chunk **without
requiring the replay to have finished**. Its doc says it "mirrors the JS
backend's `abort()` releasing the frame arena" — and the JS backend was deleted
in Phase 4, so it mirrors something that no longer exists.

The normal paths do release: `fm_parent_finish` reaches `finish_replay_impl`,
and the abort flag reaches it through `finish_abort_impl`. `fm_abort` exists for
the case where neither runs — a host that errors out mid-fork.

**Open, NOT established:** whether `host-native` has such a path and therefore
leaks fork chunks today, or whether every error route already funnels through
`fm_parent_finish`. Settling it means tracing host-native's fork error handling,
which this census did not do. It is the one entry in the uncalled set that
should be resolved by answering a question rather than by wiring or deleting.

### Consequence for any future ceiling

A ceiling over all four populations cannot mean anything, because they move for
different reasons: the 27 should fall, the 4 rise with each shim-backed import,
the 20 fall only when tests are deleted, and the 3 are a question. **Set
ceilings per population or not at all** — and settle the `fm_abort` question
before counting it as anything.

## §11 — What the thin TypeScript layer has to do, measured

Stage 2 of the maintainer's ask is "one new, thin TypeScript layer that
integrates with guest fork for the JS-based hosts, preferably the same code for
both hosts". `docs/surface-budget.json` carries `forkTypeScript` with a
**target of 2000** code lines. That number predates the lane's reversal and
should not be inherited without argument. This section is the evidence for a
different one.

### The obligation, in a working host

The V8 harnesses are complete hosts for the fork module. The entire import
object is **28 code lines** (`harness-capture.mjs`): one shared memory, the
indirect function table, three PIC placement globals, three fork tables,
`resolve_externref`, and a WeakMap-shaped `__wpk_fork_host_ref_identity`.

That figure is a floor, not an estimate of the real thing: the harness stubs
`resolve_externref` as `(_handle) => ({})` and leaves all three tables at
`initial: 0`. A real host must back the handle registry and populate the
catalogs.

### The same obligation in a real host

`crates/host-native/src/guest.rs` is a non-attic implementation of exactly
these responsibilities. Measured in code lines (non-blank, non-comment):

| | code lines |
|---|---|
| `define_resolve_externref` | 14 |
| `ExternrefRegistry` | 3 |
| `instantiate_fork_module` — total | 158 |
| &nbsp;&nbsp;of which export binding (one `fm_func!` per entry) | 33 |
| &nbsp;&nbsp;remainder: import object, PIC placement, table sizing | **125** |

**The import side dominates, and the export side is one line per entry.** That
is the opposite of what the entry-point ceiling's framing suggests, and it
matters for where effort goes: coarsening the drive API from 27 host-called
entries to 5 saves about 22 lines. Reducing the import obligation is worth far
more per unit, which is why `forkModuleHostImports` now exists and why its five
entries are each argued as a Wasm capability floor rather than a preference.

### What a target should be derived from

`CLAUDE.md` names the irreducible host floor as seven items: worker spawn, the
`fork()` syscall plus syscall-channel transport, `resolve_externref` identity
materialization, anyref-transit `Table.grow` sizing, PIC placement globals, the
resume `WebAssembly.Table`, and the Node/browser platform bridges.

Only some of those are fork-module imports. The module-import half is grounded
above at roughly **160 code lines** in a real host. The rest — worker spawn,
syscall transport, the Node/browser bridges — is host platform work this
census did NOT measure, because the fork TypeScript that implemented it is in
`attic/fork-typescript-do-not-use/`, which is not a specification and is not
read.

**So: the module-import half is measured; the platform half is not.** A target
set today would be the measured 160 plus a guess. The honest sequence is to
write stage 2 against the floor list, measure it, and set the target from that
— and to retire 2000 now, because it describes a design the reversal replaced.
What can be said already is that 2000 is roughly an order of magnitude above
the half of the work that has been measured.

## §12 — The contract stage 2 must satisfy, derived from the consumers

The reversal moved 39 fork TypeScript files to `attic/fork-typescript-do-not-use/`
and broke the host build, as the maintainer expected. The attic is not a
specification and is not read. But the surviving host code still *imports* from
those modules, and those imports are a specification: they say exactly what the
remaining host needs, with none of the attic's internals.

Measured by parsing `host/src/*.ts` import clauses (brace-bounded — an earlier
unbounded parse in this session ran across adjacent import statements and
inflated the total roughly fivefold, attributing `./constants` symbols to
`vfork-lifetime`; that number was wrong and is not used here):

| module | symbols | consumers | imported names |
|---|---|---|---|
| `fork-activation-registry` | 6 | 1 | `ForkActivationReferenceReplayImports`, `ForkActivationRegistration`, `ForkActivationRegistry`, `ForkActivationTableReplication`, `buildForkActivationStateImports`, `forkActivationRegistrationFromInstance` |
| `fork-exception-provider` | 6 | 1 | `ForkExceptionBroker`, `ForkExceptionProvider`, `ForkExceptionReferenceReplayImports`, `buildForkExceptionImports`, `forkExceptionProviderFromInstance`, `readForkExceptionCodecDescriptor` |
| `fork-module-state` | 5 | 1 | `ForkModuleStateArena`, `computeForkModuleTemplateId`, `computeForkModuleTemplateIdSync`, `readForkModuleStateDescriptor`, `readForkModuleStateRoot` |
| `fork-unwind-transport` | 5 | 1 | `FORK_UNWIND_TAG_IMPORT_MODULE`, `FORK_UNWIND_TAG_IMPORT_NAME`, `createForkUnwindTag`, `isForkUnwindException`, `requireForkUnwindTag` |
| `vfork-lifetime` | 5 | 4 | `VforkAddressSpaceBusyError`, `VforkExactCompletionReason`, `VforkLifetime`, `VforkLifetimeCoordinator`, `VforkLifetimeDisposition` |
| `fork-continuation` | 4 | 2 | `ContinuationAllocationError`, `readForkContinuationAnchor`, `readLinkedFrameFormat`, `writeForkContinuationAnchor` |
| `fork-host-import-runtime` | 4 | 5 | `ForkHostImportOwnerRuntime`, `ForkHostImportOwnerWorker`, `ForkHostImportWorkerInit`, `ForkHostImportWorkerRuntime` |
| `fork-imported-globals` | 4 | 1 | `ForkImportedGlobalCapture`, `ForkImportedGlobalPlanner`, `ForkWasmImports`, `PreparedForkParentActivation` |
| `fork-gc-codec` | 3 | 1 | `ForkGcCodecProvider`, `forkGcCodecProviderFromInstance`, `readForkGcCodecDescriptor` |
| `fork-module-instance` | 3 | 1 | `ForkModuleExports`, `ForkModuleInstance`, `instantiateForkModule` |
| `fork-process-continuation` | 3 | 1 | `ForkActivationContinuation`, `ForkBorrowedReplayWorkspaceRequirements`, `ForkProcessContinuationCoordinator` |
| `fork-reference-broker` | 3 | 4 | `ForkExternrefGeneration`, `ForkExternrefTokenCache`, `ForkExternrefTokenRecipeProvider` |
| `fork-replay-gate` | 3 | 4 | `ForkReplayGateCoordinator`, `observeForkReplayWorker`, `waitForForkReplayCommit` |
| `fork-module-backend` | 2 | 1 | `FORK_MODULE_RESUME_CATALOG_CAP`, `ForkModuleContinuationBackend` |
| `fork-module-host-capabilities` | 2 | 1 | `ForkModuleHostCapabilities`, `createForkModuleHostCapabilities` |
| `fork-reference-segments` | 2 | 1 | `DecodedSegmentedForkReferenceTransaction`, `decodeSegmentedForkReferenceTransaction` |
| `fork-resume-catalog` | 2 | 1 | `forkResumeTargetsFromInstance`, `readForkResumeCatalog` |
| `fork-anyref-transit` | 1 | 1 | `ForkAnyrefTransitTable` |
| `fork-early-reference-provider` | 1 | 1 | `ForkEarlyChildReferenceProvider` |
| `fork-externref-import-mailbox` | 1 | 2 | `ForkExternrefImportWake` |
| `fork-externref-process-owner` | 1 | 3 | `ForkExternrefProcessOwner` |
| `fork-mechanism-trace` | 1 | 3 | `sampleProcessMemoryStats` |
| `fork-module-trampoline` | 1 | 1 | `ForkModuleTrampolines` |
| `fork-reference-capture-module` | 1 | 1 | `ForkReferenceCaptureModule` |
| `fork-reference-wire` | 1 | 1 | `FORK_REFERENCE_TRANSACTION_OWNER_ID` |
| `fork-table-snapshot` | 1 | 1 | `ForkTableSnapshot` |
| `vfork-workspace` | 1 | 1 | `BorrowedVforkWorkspace` |

Consumers, by how many attic'd modules each still imports:

* `host/src/worker-main.ts` — 23
* `host/src/process-lifecycle.ts` — 7
* `host/src/browser-kernel-worker-entry.ts` — 6
* `host/src/node-kernel-worker-entry.ts` — 6
* `host/src/kernel-worker.ts` — 2
* `host/src/worker-protocol.ts` — 2

**27 modules, 72 imported symbols, 6 consumer files.**

### What this means for scoping

`worker-main.ts` is the dominant consumer. Most of the 27 modules are imported
by it alone, which is consistent with it being the fork orchestration site.

**Not all 27 should be replaced.** The lane's whole premise is that capture and
replay logic belongs in the Rust module, so several of these — the reference
codec, the GC codec, the segment decoder, the capture module — describe work the
fork-module now does. For those the correct action is to delete the CALL SITE,
not to write a TypeScript shim behind the same name. Others are genuine host
floor and need a thin implementation: the module instance, the host
capabilities, the import runtime, the externref broker and process owner.

Deciding which is which per module is the next step, and it is the step that
decides how much TypeScript stage 2 actually is. What can be said now is that
the contract is **72 symbols**, not 39 files — the surface is far smaller than
the code that used to sit behind it.

## §13 — Triage of the 27, and a proposed `forkTypeScript` target

Each module sorted by whether the fork-module now does the work (delete the call
site) or whether it is genuine host floor (write it thin, once, shared by both
JS hosts).

### A — the module does this now; DELETE the call site (13 modules, 31 symbols)

| module | why |
|---|---|
| `fork-gc-codec` | GC capture/replay is `fm_capture_define_gc` + the `__wpk_fork_ref_gc_*` family |
| `fork-reference-segments` | decoding is `fm_decode_reference_graph` + `fm_decoded_node_*` |
| `fork-reference-capture-module` | the module IS the capture path since Phase 4 |
| `fork-anyref-transit` | the injector makes the module OWN and export `__wpk_fork_ref_gc_transit` (M1) |
| `fork-early-reference-provider` | already found unreachable by the F0 census — dead, not migrated |
| `fork-activation-registry` | activations live in Rust (`fm_set_activation_*`, `fm_activation_module_buffer`) |
| `fork-module-state` | KFMS chunk list + `__wpk_fork_module_state_record_*` |
| `fork-resume-catalog` | `fm_set_activation_resume_catalog` |
| `fork-imported-globals` | `crates/fork-codec/src/imported_globals.rs` |
| `fork-continuation` | the module owns the linked chunk list it used to read |
| `fork-exception-provider` | mostly served; the 6 remaining `exn_*` imports are the gap, not this shim |
| `fork-reference-wire` | one constant — belongs in the generated ABI, not a fork module |
| `fork-table-snapshot` | **BLOCKED** on the mutation-journal decision, not on effort |

### B — genuine host floor; write it thin (14 modules, 41 symbols)

| module | why it cannot move |
|---|---|
| `fork-module-instance` | builds the import object and instantiates — the 5 obligations plus PIC placement |
| `fork-module-host-capabilities` | the obligations themselves |
| `fork-module-backend` | expected to fold into `fork-module-instance` |
| `fork-reference-broker` | externref identity + handle→externref materialization: the named engine floor |
| `fork-externref-process-owner` | externref lifetime is per process, which only the host knows |
| `fork-externref-import-mailbox` | cross-worker wake |
| `fork-module-trampoline` | host-side call thunks |
| `fork-unwind-transport` | the module owns the tag; classifying a caught JS exception is still host-side |
| `fork-host-import-runtime` | host import wiring; 5 consumers, the widest-used of all |
| `fork-replay-gate` | cross-worker replay commit ordering |
| `fork-process-continuation` | per-process continuation coordination |
| `vfork-lifetime` | vfork address-space lifetime — process lifecycle, host-owned |
| `vfork-workspace` | the borrowed workspace vfork needs |
| `fork-mechanism-trace` | `sampleProcessMemoryStats` — diagnostics, arguably not fork at all |

### The proposed target

`forkTypeScript` carries **target 2000**, a pre-reversal number. Proposed
replacement: **700**, derived as two halves.

**Module-facing half — grounded, ~250.** `crates/host-native/src/guest.rs`
implements the same responsibilities in 125 code lines of import object, PIC
placement and table sizing, plus 17 for the externref registry and
`define_resolve_externref`: **142**. JavaScript's `WebAssembly` API is higher
level than wasmtime's, but this half also carries both-host ergonomics and real
error paths the native host states differently. 250 is that measurement with
headroom, not a guess.

**Platform half — estimated, ~450.** `vfork-lifetime`, `vfork-workspace`,
`fork-replay-gate`, `fork-host-import-runtime`, `fork-process-continuation`:
worker spawn, vfork address-space lifetime, cross-worker replay ordering. These
have **no native analogue to measure** — host-native does not spawn workers —
and the TypeScript that implemented them is in the attic, which is not read.
The estimate comes from their exported shape: four coordinator classes plus
error and disposition types.

**So: 250 measured, 450 estimated, target 700.** The estimate should be
replaced by measurement once stage 2 is written; if it lands materially under
700, bank it rather than keeping the slack.

Two things this target deliberately excludes. It does not budget for the 21
guest imports the module does not yet serve (18 functions + 3 objects): those
have their own surfaces with target 0, and writing TypeScript for them now would
be writing code whose purpose is to be deleted. And it does not budget for
Category A — that work is deletion, and it should show up as `worker-main.ts`
shrinking, not as new fork TypeScript.

**This is a proposal, not a change.** A target is a campaign goal; the number in
`docs/surface-budget.json` is unchanged pending the maintainer's call.

## §14 — `dylink.0` is not the first section, in three of four side modules

Found while writing stage 2's first module. `parseDylinkSection`
(`host/src/dylink-artifact.ts`) returns **null** for `fork_module32.wasm`,
because the WebAssembly dynamic-linking convention requires `dylink.0` to be
the module's first section and the parser enforces that.

Measured across the built PIC side modules:

| artifact | `dylink.0` position |
|---|---|
| `wasi_module32.wasm` | 0 of 10 — first, conformant |
| `fork_module32.wasm` | **13 of 14 — last** |
| `dylink_module32.wasm` | **absent** |
| `wasm_artifact_module32.wasm` | **absent** |

**It is not the injector.** The pre-injection
`target/wasm32-unknown-unknown/release/fork_module.wasm` already carries it at
position 13, so `fork-module-inject`'s walrus round trip preserves position
faithfully; the placement comes from the link step. Neither
`crates/fork-module/build-wasm.sh` nor the injector writes the section.

**What it costs today:** a host cannot read the fork-module's `memorySize` /
`tableSize` through the repo's own parser, so PIC placement sizing has to come
from somewhere else. It also made a new test pass for the WRONG reason — the
withheld-capability assertion threw on the missing section before reaching
instantiation, which is H-2 exactly (a guard that cannot fail is not a guard).
That test no longer depends on the section.

**Not diagnosed here:** whether the two modules with no `dylink.0` at all are
built `--pie` and should have one, and whether anything in the loader path
silently tolerates its absence. That is a dynamic-linking question rather than
a fork one, and it is recorded so it is not lost, not claimed as understood.

## §15 — Stage 2, first module: measured at 65 code lines

`host/src/fork-module-host-capabilities.ts` implements the host FUNCTION
obligations in one place shared by both JS hosts, with the reason each one
cannot move into Wasm written beside it.

**Measured: 65 code lines** (`forkTypeScript`'s own measure). Against §13's
estimate of ~250 for the whole module-facing half, that leaves ~185 for
`fork-module-instance` — PIC placement, region reservation and table wiring —
which is consistent with the native host spending 125 there. The estimate is
tracking.

### Three corrections the work forced

**It owns two imports, not five.** The first draft put the three
reference-typed tables here. That was wrong: `fork-module-instance` owns the
region reservation and already exposes them to `worker-main.ts` as
`functionCatalog` / `driveTable` / `staticRootCatalog`, so putting them here
would have split table ownership across two modules for no reason. The split
is: functions here, tables with the instance that reserves the region.

**The static-root catalog is an `anyref` table, not `externref`.** The GC
(`any`) and `extern` hierarchies are disjoint roots, so the wrong one is
rejected at instantiation with "imported table does not match the expected
type". The first draft asserted `externref` in a comment. The instantiation
test caught it.

**`resolve_externref` must THROW, not return null.** The first draft returned a
null sentinel for an unknown handle. That is wrong, and the repository already
knew it: the pre-existing M2 test
(`host/test/fork-module-host-capabilities.test.ts`) pins exactly this —
"propagates a truthful RangeError for an invalid handle instead of a soft
failure sentinel". A sentinel would let a replay continue with a reference it
never restored. The same test pins `resolvedCount` as proof-of-use, which the
draft also lacked. Both are now implemented and asserted.

**How the last one was found is worth recording.** The new test file was
created with a shell redirect over a path that was already a tracked, 67-line
test — without reading it first. It was recovered with `git checkout` and is
untouched; the new assertions live in
`host/test/fork-module-host-obligation.test.ts` instead. Had it not been
recovered, the RangeError and `resolvedCount` decisions would have been lost
silently along with the file that pinned them. Look at the target before
writing over it.

### What the completeness proof is

Instantiating the real artifact with these capabilities, the three tables and
PIC placement, and nothing else. A missing import is a `LinkError` naming it,
so the test cannot pass while under-serving the module. It loads
`local-binaries/fork_module32.wasm` by explicit path, not through the resolver,
for the H-9 reason.

**BLOCKED ON A CEILING.** `forkTypeScript` has ceiling 0, because this lane
moved all fork TypeScript to the attic. The measure now reads 65. The growth is
the work the maintainer asked for, but raising a ceiling is the one thing the
lane brief forbids outright, so the file is written, tested and NOT committed
pending that call.

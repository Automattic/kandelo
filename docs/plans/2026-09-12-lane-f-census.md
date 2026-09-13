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

## §10 — The fork-module's `fm_*` entries, classified by caller

Measured 2026-09-12 against `crates/fork-module/src/lib.rs`,
`crates/fork-module-inject/src/main.rs`, `crates/host-native/src/*.rs` and
`host/src/*.ts`. No host constructs an `fm_*` name dynamically (checked), so
matching by name is sound.

**Count callers, not mentions.** The first pass here matched raw text and was
wrong: a doc comment naming an entry read as a caller. One sentence of prose in
`host/src` moved `fm_gc_identity_find` out of the injector-only bucket and into
the host-called one. The measure now strips comments first — and deliberately
KEEPS string literals, because `crates/host-native` binds its entire drive
surface by name inside one (`fm_func!("fm_parent_begin_capture": ...)`), so
stripping strings would hide every real caller it has.

The corrected split of the 54:

| who calls it | count |
|---|---|
| a production host (`crates/host-native/src`, `host/src`) | **24** |
| the injector's own shims, nothing else | **3** |
| nothing in production — tests only, or nothing at all | **27** |

The earlier figures in this session (27 / 4 / 20 / 3) were mention-based and are
superseded. The difference is not cosmetic: it moved four entries out of
"host-called", including `fm_capture_claim_gc`, `fm_attach_child` and
`fm_set_activation_exception_tags`, none of which any production host calls.

### Why one ceiling over this could not work

The old `forkModuleEntryPoints` counted `pub extern "C" fn fm_` declarations in
one file. Its `why` said it counted host-called entries; a regex cannot enforce
that. Worse, the populations move in OPPOSITE directions — host-called should
fall as the drive API coarsens, injector-only rises as each shim-backed guest
import lands, and the no-production-caller bucket should fall to zero. A single
number blocked work it had no bearing on: adding an injector helper tripped a
gate whose stated purpose was the host contract.

Split on 2026-09-12 by maintainer decision into `forkModuleHostDriveEntries`,
`forkModuleInjectorHelpers` and `forkModuleEntriesWithoutProductionCaller`.
Lane F's closure condition moved to the first of those, since the "3-5 coarse
entries" goal was always about the host-called drive surface.

**Test-only and never-called are ONE number on purpose.** Ratcheting test-only
entries separately would reward DELETING TESTS to make a ceiling pass — a
perverse incentive a ratchet must not create. Merged, the only ways down are
the two that are actually wanted: wire an entry to a production caller, or
delete the entry. Deleting its test moves it between sub-groups and changes
nothing.

### The injector-only three are not host surface

`fm_drive_bump`, `fm_gc_identity_find`, `fm_gc_identity_claim`. Each exists
because the work is split across a boundary neither side can cross alone: **the
injected wasm shim is the only thing that can HOLD a reference, and Rust is the
only thing that can hold a MAP or a counter.** They are spelled as wasm exports
only because the injector resolves its helpers by name. A host never sees them.
Ten more are expected as the remaining shim-backed guest imports land, which is
why that surface carries a pre-authorized envelope of 15 rather than a
measurement.

### Most of the 27 are pending capability, not dead code

Sort them by signature and a pattern appears: **`fm_frame_reserve/commit/peek/next`,
`fm_resume_peek`, `fm_set_activation_resume_catalog` and
`fm_activation_module_buffer` all take an explicit `activation_id`**, where the
guest-facing `__wpk_fork_frame_*` counterparts call the IDENTICAL `*_impl`
functions with `primary_activation()`.

They are the multi-activation (dlopen fork) variants: a fork across N
dynamically loaded libraries needs each activation's own resume catalog and
frame cursor, because resume-slot numbering must match THAT activation's table
by construction. Nothing wires them because no host drives a multi-activation
fork yet. **That is pending capability and must not be deleted to bank a
reduction** — the platform is meant to serve the whole possibility space of
future guests, and arbitrary numbers of dynamically loaded libraries are inside
it.

The `fm_capture_*` family is the other large group, reached only by
`crates/fork-module/tests/*.mjs` and `host/test`. Its production caller is the
TypeScript this lane set aside; it returns when stage 2 rewires capture.

### `fm_abort` is neither, and may be a live gap

`fm_abort()` takes no activation id. It calls `abort_impl()`, reachable from
nowhere else, which releases every channel-mapped fork chunk **without
requiring the replay to have finished**. Its doc says it mirrors the JS
backend's `abort()` — and Phase 4 deleted that backend, so it mirrors something
that no longer exists.

The normal paths do release: `fm_parent_finish` reaches `finish_replay_impl`,
and the abort flag reaches it through `finish_abort_impl`. `fm_abort` exists
for the case where neither runs — a host that errors out mid-fork.

**Open, NOT established:** whether `host-native` has such a path and therefore
leaks fork chunks today, or whether every error route already funnels through
`fm_parent_finish`. Settling it means tracing host-native's fork error
handling, which this census did not do.

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

## §16 — The table-mutation group needs NO new wire format

This section corrects an earlier claim of mine, recorded as master-plan open
decision 3: that
`__wpk_fork_module_state_table_mutation_commit(owner, start, count)` "carries no
values, yet `reconcile()` must bring pthread table replicas coherent, and the
ABI defines no journal format." The first half is true. The conclusion was
wrong.

**Checked in Rust first.** `crates/shared/src/lib.rs` defines only the five
import names and `__wpk_fork_module_state_table_generation_addr`. No journal
record format exists anywhere in `crates/`. That much was right.

**Then, narrowly, how it works today.** The maintainer allowed reading the
attic only if needed, and it was: a format that already exists and gets
reinvented is the duplicate-wire-format defect this campaign has already found
once at 9,050 lines. Reading only the interface and the file header — not the
orchestration, which is the part that kept going wrong — settles it.

`ForkActivationTableReplication` documents `reconcile()` as "apply the latest
process **snapshot** and return its exact generation", and `commit(activationId,
ownerId, firstIndex, length)` as "publish a successful guest mutation and
release writer ownership".

So the mechanism is not a journal of values at all. **The table state crosses as
a reference graph, in the capture/replay wire formats that already exist.**
Capture goes through the guest's `saveTables` into a module reference graph;
restore goes through `decodeReferenceGraph`, `restoreFromArena` and the drive
plan — the same KFRE/KFRV/KFRS the fork path already uses.

**Why the values can cross at all** is stated in `fork-table-snapshot.ts`'s
header: a funcref is resolved from the module's resident decoded-graph oracle
against THIS worker's own per-activation function catalogs, so the
`(activation, ordinal)` coordinate maps to the worker's own `table.get` **by
construction** — funcref-ordinal stability across workers. Externref and GC
values are reconstructed by the module drive into the shared anyref transit and
read back from there.

That is exactly the encoding a module-side implementation would need, and it is
already the ABI. `mutation_commit` carries no values because it is a
NOTIFICATION plus a range: it says which owner's range changed so the next
`reconcile()` re-applies the snapshot. The generation fence — an atomic i64 at
`table_generation_addr`, already emitted by
`crates/fork-instrument/src/module_state.rs` — is the wake signal.

### What this changes

* **Open decision 3 is withdrawn.** There is no undefined format and no
  maintainer decision owed. The five `module_state_table_*` imports are not
  blocked on design.
* The module already owns every primitive the module-side implementation needs:
  `fm_decode_reference_graph`, `fm_decoded_node_count`, `fm_decoded_node_field`,
  `fm_restore_from_arena`, and the drive plan. Notably all of those currently
  sit in `forkModuleEntriesWithoutProductionCaller` — their production caller is
  precisely this path.
* It is NOT trivial work, and this census does not claim otherwise. What is
  established is the format question; the reconcile sequencing, the writer
  ownership protocol behind `mutation_begin`/`abort`, and what
  `state_owned(owner)` must answer are not, and reading the attic further for
  those would be reading the orchestration the maintainer set aside.

## §17 — Stage 2, the placement half: 166 code lines, and three guards that were not guards

`host/src/fork-module-instance.ts` reserves the module's region, derives the
position-independent-code globals from its own `dylink.0` sizing, creates the
three reference-typed tables, and instantiates. Placement cannot move into the
module: a side module does not choose where it is placed, and `__memory_base` /
`__table_base` are imports by construction.

**166 code lines**, bringing the module-facing half to **231** against the
estimate of 250 in §13 — within 8%. The half is now essentially complete, so
`forkTypeScript`'s ceiling of 250 should be banked to the real figure once the
consumers are rewired and it stops moving.

### It reads `dylink.0` through `customSections`, not `parseDylinkSection`

`parseDylinkSection` requires the section to be the module's FIRST, which the
convention does say — and this module's is the last of fourteen (§14), so that
reader returns null for it. `WebAssembly.Module.customSections` finds a section
by name wherever it sits. That is what lets placement work against the artifact
as actually built, and it is presumably why nothing noticed the section's
position until now.

### Three existing assertions passed for the wrong reason

`host/test/fork-module-instance.test.ts` is a tracked 203-line spec and the new
implementation passed all six of its tests on the first run. But perturbing the
implementation showed three of its guards were not guards:

| perturbation | expected to fail | actually |
|---|---|---|
| accept a module with no `dylink.0` | "not a PIC side module" | **passed** — the parser fell through and threw "dylink.0 carries no memory-info subsection", which still matches the test's `/dylink/i` |
| delete the region-fits-in-memory check | "region exceeds memory" | **passed** — `WebAssembly.Instance` threw on its own with a message containing "memory", which still matches `/region\|memory/i` |
| seed `__stack_pointer` at the region BASE instead of its top | nothing | **passed** — no assertion covered stack direction at all |

The first two are loose regexes satisfied by an unrelated throw. The third had
no coverage: the suite's existing sentinel sits at offset 4096, megabytes below
the reserved base, so a shadow stack growing DOWN from the base would write
into live guest memory and land nowhere near it.

`host/test/fork-module-placement.test.ts` pins all three by their own failure —
the specific message each guard produces, and a guard word placed immediately
BELOW the region base, where a downward-growing stack lands on its first spill.
All three perturbations now fail.

The original test is left as it is. Its assertions are weak, not wrong, and
rewriting a tracked spec is a larger decision than adding a sharper one beside
it.

## §18 — The consumer's own call sites closed three gaps

Type-checking `worker-main.ts` against the new modules named three things §17's
implementation had missed, none of which the tracked spec covers:

**`stagingBase` / `stagingBytes`.** A fixed staging slab INSIDE the reserved
region, for pre-fork catalog scratch and GC-codec staging. Its reason is a fork
invariant, recorded at the call site: a growing channel mmap would permanently
enlarge the shared process memory, and a fork-from-thread child clones that
memory, so the child would observe a different size than its parent. A request
larger than the slab falls back to the channel mmap, whose growth that path does
not assert against — so the size is a tuning choice, not a correctness boundary.

The region layout is now, low to high: static/BSS, shadow stack, staging slab.
`__stack_pointer` starts at the TOP of the shadow stack and grows DOWN into it,
bounded below by the static footprint, so it can reach neither the slab above
nor guest memory below.

**Both host functions, from one input.** Both `instantiateForkModule` call sites
in `worker-main.ts` passed only `resolveExternref`, which would have left
`__wpk_fork_host_ref_identity` a TRAPPING STUB — reached by any GC capture. The
options now take `tokens` (the registry) and derive both imports together, so
wiring one without the other is not expressible. Both call sites were rewired.

**`FORK_REFERENCE_TRANSACTION_OWNER_ID` retired.** A hand-maintained TypeScript
constant sitting beside `crates/shared`'s
`WPK_FORK_REFERENCE_TRANSACTION_OWNER`, which the ABI generator already emits
into `host/src/generated/abi.ts` (both are 1). `worker-main.ts` now imports the
generated one, and `fork-reference-wire` is the first of the 27 attic'd modules
fully retired. This is the knowledge-beside-a-generator defect three censuses in
this campaign have found.

The attic'd-module contract is now **24 modules / 66 symbols** (from 27 / 72):
one retired, and two provided by §15 and §17.

### The ceiling was hit and NOT raised

Adding the slab took `forkTypeScript` to 253 against its ceiling of 250. The
fix was to remove real duplication — three near-identical `WebAssembly.Table`
constructions became one `emptyTable` helper — bringing it to **249**. No
behaviour changed and no ceiling moved. 250 was approved as headroom for the
module-facing half; that half is now done at 249, so the ceiling should be
banked to 249 once the platform half's own ceiling exists to grow into.

## §19 — §13's triage is not reliable enough to delete from

§13 sorted the 27 attic'd modules into "the module does this now, delete the
call site" and "genuine host floor, write it thin". That sort was done from
module names, symbol names and what the fork-module now exports. Probing three
of them against their actual call sites found two were in the wrong bucket.

**`fork-early-reference-provider` — filed Category A on the grounds that the F0
census found it unreachable.** What F0 found unreachable was the module's
270-line internal data feed, made dead by the `fm_ref_*` import flip. The CLASS
is not unreachable: `earlyChildReferences` appears at 13 sites in
`worker-main.ts` across roughly a thousand lines, as a fallback
(`earlyChildReferences ?? activationRegistry.currentReferences()`), as a
lifecycle object (constructed, `abort()`ed, nulled on two paths) and as a gate
(`if (!importedStatePlanner || !earlyChildReferences)`). Deleting the call site
means knowing what drives those paths instead. That is orchestration knowledge.

**`fork-anyref-transit` — filed Category A because the injector now makes the
module OWN and export the transit table.** Owning the table is not the same as
SIZING it. The wrapper carries `ensureRecipeSlot(recipeId)`, which grows the
table so a recipe id has a slot rather than letting `table.grow` trap, plus
`clear` / `get` / `set` / `clearSlot`. `CLAUDE.md` names "anyref-transit
`Table.grow` sizing" as part of the irreducible host floor, which puts this in
Category B.

It may not stay there — the injector already emits an `fm_transit_grow` pass,
so the growth could plausibly move into the module. But `CLAUDE.md` says floor
and the module has the primitive, and which of those wins is a design decision,
not something to settle while deleting a call site.

**The correction that matters is not the two entries; it is the method.** A
triage by name and export is a hypothesis. Each entry needs its call sites read
before anything is deleted, and reading them is the same orchestration knowledge
the platform half needs. So Category A is NOT the mechanical, unblocked deletion
work §13 implied, and this section supersedes that characterisation. The
individual A/B guesses are left in §13 as hypotheses, not as a plan.

**What IS unblocked** is the other direction entirely: the ten guest imports
that need an injected shim backed by a new `fm_*` helper. That is Rust and
injector work with no TypeScript and no attic, the mutation group's format
question is settled (§16), and `forkModuleInjectorHelpers` now carries a
pre-authorized envelope of 15 against 3 used.

## §20 — Constructor provenance needs durable, lifetime-coupled storage. OPEN.

The `__wpk_fork_ref_gc_provenance_begin` / `_ref` / `_end` trio is the cleanest
of the ten shim-backed imports: self-contained, no cross-activation dispatch,
and the same shape as the `gc_claim` / `gc_lookup` pair that already works —
read the value from the transit slot, get its identity from the host, hand the
integer to Rust. It also serves the case the N1-F6 grounding calls "the one real
break": a non-defaultable constructor's seed value cannot be recovered by
inspecting the object later, only by having been recorded when `struct.new`
ran.

**It is emitted, not speculative.** `inject_provenance_wrappers` is ungated: any
module with GC layouts gets a wrapper for every struct with a mutable non-null
internal reference field, and for every array constructor except
`ArrayGeneric`.

**Where it stops.** Every other durable thing this module keeps is either a
fixed saturating region (the table dirty bitmap) or a per-capture map in the
bump heap (`GC_IDENTITY`). Provenance fits neither:

* It is recorded during ORDINARY execution, at every qualifying allocation, so
  it must survive `reset_bump_heap`. That rules out the bump heap.
* It must persist until the object is CAPTURED, which may be any time later, so
  its lifetime is the object's. That rules out consuming the record at `_end`.
* There is no bound on how many such objects a program allocates, so a fixed
  region saturates almost immediately for any real GC program.

And saturation cannot be made safe the way the dirty bitmap's is. There, losing
precision means over-approximating the overlay: a larger capture, still correct.
Here, a missing provenance record cannot be over-approximated — provenance
cannot be invented — so the only truthful response is to fail the capture of
that object. A fixed region would therefore turn a routine allocation pattern
into a routine capture failure.

**The shape that would work** is the one the module already uses for its journal
chunks: a `SYS_MMAP`-backed growable side table, keyed by host reference
identity. That is durable and unbounded. It also has two costs worth stating
before anyone commits to it — a host call on every qualifying allocation, which
is a hot path, and a side table with no reclamation, because the module has no
way to learn that a GC object died.

**This is a maintainer decision, not an implementation detail**, so it is
recorded rather than guessed at. The rest of the trio is ready to build the
moment the storage question is answered: the identity import exists, the
injector already emits shims of exactly this shape, and
`forkModuleInjectorHelpers` has an envelope of 15 against 3 used.

## §21 — Provenance probably needs a per-LAYOUT witness, not a per-object record

§20 framed provenance storage as unbounded and lifetime-coupled, and asked the
maintainer to choose between a growable side table and a fixed one that fails
loud. Re-reading the N1-F6 grounding says the premise was too strong.

**What the seed is actually for.** A non-defaultable shape cannot be
`struct.new_default`'d, so replay's allocate step must pass a type-correct
non-null value for each mutable internal-reference field, before the true edge
target may exist. The grounding is explicit that this value is then
**overwritten**: "Phase 5's fill later overwrites with the real (possibly
self-referential) edge." The original value is recorded not because replay needs
*that* value, but because "you cannot conjure an arbitrary instance of an
application-defined struct/array type out of nothing" — and a value the program
actually used is, by construction, one that existed and is therefore capturable.

**So the requirement is a type-correct, capturable instance of the field's
type — not the specific one the original constructor used.** If that holds, the
storage is bounded by the module's static layout count, not by how many objects
the program allocates.

### The shape that follows

A **rooted witness table**: one `(ref null any)` slot per provenance layout, in
a module-owned GC table. The injected constructor wrapper already stages the
value in a transit slot; it can `table.set` it into the witness slot indexed by
layout id. That removes, at once, all three costs §20 was worried about:

* **No growth.** One slot per layout, fixed at instrumentation time.
* **No reclamation problem.** Rooting the witness keeps it alive deliberately;
  a bounded, known set of retained objects rather than an unbounded leak.
* **No host call on the allocation hot path.** `table.set` is pure wasm and
  needs no reference identity at all, so the per-allocation cost that made §20's
  side table unattractive disappears.

This also answers "can Wasm GC features help" and "can instrumentation solve
it" together: the GC table IS the storage, and the instrumentation that already
wraps the constructor is the only writer.

### The one thing that decides it, NOT established

The grounding says the mechanism "is call-site-scoped, not type-scoped". A
witness pool is type-scoped. Those differ only if two call sites constructing
the same type need *different* seeds — and since the seed is overwritten by the
fill, call-site scoping may be conservatism rather than necessity. **That is the
crux and it is not established here.**

Two smaller checks go with it. The constructor's scalar operands ride in
`provenance_begin`'s `scalar_lo`/`scalar_hi`, and an array's LENGTH is a scalar
that is *not* overwritten — but a length is recoverable at capture by inspecting
the array, so it should not need provenance at all. And a witness must still be
capturable when the fork happens, which rooting guarantees.

If call-site scoping turns out to be necessary, §20's question returns exactly
as written. If it does not, provenance stops being a storage problem.

## §22 — A witness pool for provenance: the concrete proposal

§21 proposed replacing per-object provenance records with a per-layout witness
and marked the call-site-vs-type question as the crux. It is now settled, from
`crates/fork-instrument` — no attic reading involved.

### The three facts that settle it

**The wrapper is already per TYPE.** `inject_provenance_wrappers` creates one
wrapper per layout and stores it as `struct_wrappers.insert(layout.type_id,
wrapper)`. The grounding's phrase "call-site-scoped, not type-scoped" describes
where the REWRITE happens — `struct.new $T` is redirected at N instruction
addresses — not the wrapper's identity. There is one wrapper per type, and every
call site of that type shares it.

**The seed is always overwritten.** Every reference field gets a
`reference_ordinal`, so every reference field is in the snapshot vector,
including the mutable non-null internal ones that provenance covers. The edge
vector is `[ ...provenance refs, ...snapshot refs ]`: replay allocates using the
provenance refs, then phase two fills from the snapshot refs.

**The problem is narrower than "provenance".** The field-layout comment states
it: "Mutable internal non-null edges use the separately recorded constructor
seed; **other hierarchies have generated temporary seeds** and are filled in
phase two." So the system ALREADY generates seeds wherever it can. A value is
recorded only for concrete internal GC types, where an instance cannot be
conjured. That is the entire scope.

### The proposal

A **witness pool**: one `(ref null any)` slot per *(layout, provenance ordinal)*
pair — per ordinal, not per layout, because a layout may have several mutable
non-null internal fields of different types. The count is fixed at
instrumentation time.

* The constructor wrapper already stages each provenance argument in a transit
  slot. It additionally `table.set`s it into its witness slot. Pure wasm: **no
  host call, no reference identity, no map.**
* At capture, each occupied witness is interned once, and its recipe id is used
  as the provenance edge for every object of that layout.
* At replay nothing changes. The allocate step consumes a type-correct recipe
  exactly as before; phase two fills the real edges over it.

**The wire format does not change.** Provenance edges stay recipe ids in the
same position in the same vector. What changes is WHICH recipes they name —
a shared witness rather than each object's original seed. The child's algorithm
is untouched, so this is ABI-compatible.

### What it costs, stated plainly

A bounded set of deliberately rooted objects — one per provenance ordinal — that
the program can no longer collect. In exchange it removes the unbounded side
table, the per-allocation host call, and the reclamation problem that §20 could
not solve. It is also strictly less machinery than the per-object recording the
set-aside TypeScript did.

### What is still not established

Whether any consumer requires a provenance edge to name the object's ORIGINAL
seed rather than a type-correct substitute. `define_gc` only validates that
provenance ids name existing recipes, which a witness satisfies. Nothing else
was found that inspects them — but "nothing found" is weaker than "nothing
exists", and this is the assumption the design rests on.

**This is a design change to what capture records, so it is the maintainer's
call.** It is recorded here as a proposal, not started.

## §23 — The "platform half" is mostly not coordination, and mostly not floor

Read under the maintainer's narrow grant: the coordination protocols only.
Recorded here is what each module DEPENDS ON, not how it is written.

§13 grouped five modules as the platform half and §17 estimated them at ~450
code lines of irreducible host floor. Measuring what each actually touches says
that premise was wrong for three of the five.

| module | lines | Atomics | promises | worker refs | module calls | verdict |
|---|---|---|---|---|---|---|
| `fork-replay-gate` | 229 | yes | yes | yes | – | **split** |
| `vfork-lifetime` | 346 | – | yes | yes | – | **host** |
| `fork-process-continuation` | 1471 | – | – | – | **9** | **driver loop** |
| `fork-host-import-runtime` | 497 | – | – | – | – | host, thin |
| `vfork-workspace` | 175 | – | – | – | – | host-adjacent |

### `fork-replay-gate` — split it

The gate is **one shared i32** with three states, driven by
`Atomics.compareExchange`, `Atomics.wait` and `Atomics.notify`. Every one of
those has a Wasm threads equivalent (`i32.atomic.rmw.cmpxchg`,
`memory.atomic.wait32`, `memory.atomic.notify`), and the waiter is the child's
process worker blocked inside a synchronous Wasm import.

Its own comment gives the reason it is a shared-memory gate: "a JavaScript
promise cannot be awaited inside a synchronous Wasm import". That is a
HOST-LANGUAGE constraint. The module has no such problem — it is already
synchronous wasm — which makes the module the more natural owner, not the less.

**The only blocker is placement**: the gate is a standalone `SharedArrayBuffer`,
and the module can address only the guest's imported memory. Putting it at a
known offset in guest shared memory, exactly as the table generation fence
already is, makes it module-addressable. That is a placement change, not a
protocol change.

The `ForkReplayGateCoordinator` half stays host: it exists to observe Worker
construction failure, protocol errors and exit paths, and to wake a child
blocked in a synchronous import with a cancellation rather than leak it. Those
are host-lifecycle facts.

### `vfork-lifetime` — genuinely host

A phase machine (`starting` → `borrowing` → `settled`) keyed by
`WebAssembly.Memory` OBJECT IDENTITY (`hasActiveAddressSpace(memory)`,
`isActiveBorrower(generation)`), whose completion is a `Promise` resolved by
async worker events (exec / exit / signal / trap). No atomics, no shared
memory. The module can neither hold a `Memory` object nor observe those events.

The phase rules alone could move, but every transition TRIGGER would stay host,
so the host code would not shrink while the module's entry count grew. That is
the wrong trade.

### `fork-process-continuation` — not floor at all, and not coordination

1,471 lines with no atomics, no promises and no worker references, calling NINE
fine-grained module entries: `fm_begin_replay`, `fm_finish_replay`,
`fm_begin_abort`, `fm_finish_abort`, `fm_begin_reference_replay`,
`fm_build_gc_plan`, `fm_serialize_journal_alloc`, `fm_finish_unwind`,
`fm_add_activation_child_replay`.

That is a DRIVER LOOP — the exact thing the "3-5 coarse entries" target exists
to eliminate, and the largest single piece of evidence for it in the lane. It
belongs to F3/F4 (coarsen the entries, delete the driver), not to stage 2's
host floor.

One of those nine, `fm_add_activation_child_replay`, was DELETED in F0-r for
having no callers. So this file is partly stale as well as misfiled — more
evidence that the attic is a snapshot, not a specification.

### What this changes

The platform-half estimate of ~450 code lines rested on all five being floor.
Two are (`fork-host-import-runtime`, `vfork-workspace`, ~672 lines, and the
first overlaps what `fork-module-instance.ts` already does), one splits, one is
host, and the largest is driver logic that should collapse rather than be
rewritten. The `forkTypeScript` target of 700 should be revisited once the
replay gate's placement and the F3 coarsening are settled — it is more likely
too high than too low.

## §24 — The witness pool, built. Unserved guest imports 18 -> 15.

§22's proposal, approved and implemented. Three guest imports served, no new
host obligation, and the module's import count is unchanged at 10.

**Two of the three needed no shim at all.**
`__wpk_fork_ref_gc_provenance_begin` and `_end` are pure scalars, so they are
plain Rust exports. The object fork-instrument stages in the transit slot at
`begin` is the NEWLY CONSTRUCTED one, and a witness design has no use for it —
only the seeds matter, and those arrive at `_ref`.

**`_ref` is the only shim, and it needs no host import.** Unlike `gc_claim` and
`gc_lookup`, which must ask the host for a reference identity, the witness is
keyed by `(layout, ordinal)` — both plain integers the guest already passes. So
the shim reads the staged seed from the transit table and `table.set`s it into a
module-owned witness table, table to table, never through JavaScript. **That is
what keeps this off the allocation hot path**, and it is the concrete payoff of
the witness design over per-object recording.

**No guest re-instrumentation.** The wrapper fork-instrument already emits
stages each provenance argument in the transit slot before calling `_ref`. The
whole change is in `crates/fork-module` and `crates/fork-module-inject`.

Scalars are accepted and ignored, deliberately: an array's length is the one
constructor scalar the fill does not overwrite, and it is recoverable at capture
by inspecting the array. The parameters stay in the signature because the guest
ABI declares them.

### Bounded, and truthful where it is not

256 witness slots, keyed `(layout << 8) | ordinal`. A layout id that would
overflow the key is `E2BIG` at `begin`, not a silent truncation into another
layout's witness. Exhausting the slots is `E2BIG` at `_ref`. Both are truthful
failures: a witness stored under the wrong key would make a child allocate with
a seed of the WRONG TYPE, which is worse than refusing.

The declared-versus-stored count is checked at `_end`. The guest ABI returns
nothing there, so the mismatch is latched in `fm_last_errno` — but it matters,
because a dropped store leaves a later object of that layout with no
type-correct seed at all.

### A diagnostic export was written and then removed

`fm_gc_provenance_witness_count` was added for the harness, and
`forkModuleEntriesWithoutProductionCaller` immediately caught it: 27 -> 28, an
export no production host calls, which is exactly what that bucket exists to
discourage. It was deleted and the harness now counts occupied slots by reading
the exported witness table. That is strictly better — it observes the table the
shim actually writes rather than trusting a parallel tally in Rust.

The surface moved as expected otherwise: `forkModuleInjectorHelpers` 3 -> 4
against its envelope of 15, since `fm_gc_provenance_witness_slot` is called only
by the injected shim.

### Still not established

§22's open question stands: whether any consumer requires a provenance edge to
name the object's ORIGINAL seed rather than a type-correct substitute. Capture
does not yet emit witness recipes into `gc_define`'s provenance ids — that is
the next step, and it is where the assumption becomes load-bearing.

## §25 — The witness must be the FIRST seed, not the latest

§24 landed the witness pool with last-wins semantics, and the harness asserted
that as correct. Verifying §22's open assumption — whether a type-correct
substitute is as good as the object's original seed — found that it is, but only
under a condition the first implementation did not meet.

**Replay refuses cycles.** `crates/fork-codec/src/drive_plan.rs` orders
allocation by constructor dependency and returns `EINVAL` on "an unallocatable
constructor cycle".

**Per-object seeds are acyclic by construction.** A provenance-eligible field is
`mutable && !nullable && internal GC reference`, so seeding one always required
an instance that ALREADY EXISTED. Every provenance edge therefore points
backwards in construction order, and that graph cannot contain a cycle.

**Last-wins breaks that; first-wins preserves it.** With one witness per
`(layout, ordinal)`, the witness for layout A is some object X of layout B. At
capture X is captured as a normal node, and X's own provenance edge is layout
B's witness — which, under last-wins, may be an object constructed AFTER X,
including one that transitively depends on X. That closes a cycle the original
execution never had, and replay then refuses the whole graph.

Keeping the FIRST witness follows the original construction order exactly: the
first object of a layout was seeded by something built before any object of that
layout. So the chain terminates where the program's own bootstrap did.

**This is the single condition under which a witness pool is equivalent to
per-object recording**, and it is now the implementation: the slot is written
only when empty, and `fm_gc_provenance_witness_slot` returns `-2` for "already
witnessed, do not store" — not an error, since the guest did make the call it
declared.

The harness previously asserted `witnesses.get(slot) === 201` after a second
construction — it encoded last-wins as correct, exactly the shape of the
dirty-page harness defect recorded earlier in this campaign. It now asserts the
first seed survives, and reverting to last-wins fails it.

§22's assumption is therefore resolved rather than merely carried: a
type-correct substitute IS sufficient, provided it is the earliest one.

### §25a — the hazard, as a test

`a_provenance_cycle_is_refused_but_the_acyclic_twin_plans`
(`crates/fork-codec/src/drive_plan_hints.rs`) is the argument above turned into
a fixture: the same two struct recipes, once cyclic and once not.

* **Cyclic** — struct(0)'s seed is struct(1) and struct(1)'s seed is struct(0),
  the shape a last-wins witness pool can produce. `build_drive_plan` returns
  `EINVAL`.
* **Acyclic** — struct(1)'s seed is the externref leaf instead, which is what a
  FIRST-wins witness gives, because the earliest seed predates both objects.
  The plan builds, and the seed is allocated before its dependent.

Writing it also documented a decoder rule worth knowing: a layout carrying
provenance must set `LAYOUT_FLAG_REQUIRES_PROVENANCE`, and `decode_gc_codec`
rejects a non-zero provenance count without it. So the count and the flag cannot
drift apart in a real descriptor. The first version of this fixture set the
count alone and was refused — the decoder caught it immediately.

Perturbed both ways: dropping the descriptor's provenance count to zero makes
the seed edge stop being a dependency and the cyclic half no longer fails;
pointing the acyclic twin's seed back at struct(0) makes the acyclic half fail.
So the test is sensitive to the provenance dependency path specifically, not to
some incidental cycle.

## §26 — Provenance is served but not yet USED, and that is gated on F3

The three `gc_provenance_*` imports are served and the witness semantics are
proven (§24, §25, §25a). Closing the loop means capture emitting witness recipe
ids as `gc_define`'s provenance ids — and that is not a small next step. It is
gated on F3.

**The module cannot intern a witness by itself.** Interning requires capturing
the witness as a full object: its layout, scalars and fields. Only the guest's
generated encoder can walk an arbitrary GC object's fields; the module cannot
introspect one.

**And there is no capture-side drive.** `fm_drive_execute` and
`__wpk_fork_drive_table` are REPLAY-side: the plan is built from a decoded graph
and drives allocate/fill. Nothing lets the module call into the guest's encoder
during capture.

So the witnesses sit correctly recorded and unreadable until the module owns the
capture WALK — which the census already names as F3's remaining work and the
bulk of its estimate. Serving the trio was still right and is still complete as
far as it can go: the guest's imports are satisfied by the module rather than
the host, which is the lane's measure. What is deferred is the consumption, not
the capture.

## §27 — `exnref` is a FOURTH hierarchy, so exception identity needs its own host import. OPEN.

Looking ahead to the next shim-backed tranche, `__wpk_fork_ref_exn_claim` and
`__wpk_fork_ref_exn_lookup` are the same shape as the GC pair already built:
read the value from a scratch table slot, get an identity, map it. That shape
works because `__wpk_fork_host_ref_identity` takes an `anyref`.

**It does not extend to exceptions.** Wasm's reference types are disjoint
hierarchies — `any`, `func`, `extern`, and `exn` from the exception-handling
proposal. An `exnref` is not a subtype of `anyref`, so the approved identity
import cannot accept one, exactly as it cannot accept the `funcref` that
`encode_funcref` needs (recorded earlier).

So the remaining shim-backed imports are not one tranche but three, by what
they need:

* **No new host surface** — the provenance trio (done): keyed by integers the
  guest already passes.
* **A NEW host import each** — `exn_claim`, `exn_lookup`, `exn_broker_encode`
  (exnref identity) and `encode_funcref` (funcref identity). Two new imports
  would take the module's host obligation from 5 to 7, which is growth in the
  campaign's primary measure and therefore a maintainer decision.
* **Neither, but harder** — `gc_capture_layout` needs type introspection
  against candidate layouts, `gc_broker_encode` is cross-activation dispatch,
  and `exn_ingress_throw` / `exn_broker_throw_recipe` must THROW through the
  module's own tag, which `inject_unwind_tag` already creates.

**The open question is the middle group.** `resolve_externref` and
`__wpk_fork_host_ref_identity` are each argued in the budget as a Wasm
capability floor. Identity for `exnref` and `funcref` is the same argument in
two more hierarchies — Wasm can compare neither, and `ref.eq` validates only on
`eqref`. Whether that justifies two more imports, one generic import that
dispatches on hierarchy, or leaving those four unserved is not a call this lane
should make alone.

## §28 — The four "identity" imports do not want the same thing

§27 grouped `exn_claim`, `exn_lookup`, `exn_broker_encode` and `encode_funcref`
as "need identity in a hierarchy the current import cannot reach", and the
maintainer approved a single dispatching import for flexibility. Checking what
each would actually ask for says the group is not one need, so the single
import was not built.

### What the probe established, and what it did not

A JS import CAN declare a parameter in every hierarchy. Measured on V8 with a
hand-encoded module and a PASSING CONTROL — an earlier attempt reported all four
rejected, which was a bad section length, not a type verdict:

| parameter | result |
|---|---|
| `anyref` (control) | validates and instantiates with a JS function |
| `externref` | validates and instantiates |
| `funcref` | validates and instantiates |
| `exnref` | validates and instantiates |

**That was structural only, and it is now settled — negatively.** §28a.

### The semantic mismatch

`encode_funcref` does not want an identity. A funcref recipe is keyed by
`base(module_activation) + function_ordinal` — a MERGED CATALOG SLOT, which is
what `fm_funcref_ordinal` returns on the decode side. So the encode direction
must produce that same catalog ordinal, or encode and decode disagree about what
a funcref recipe means.

An arbitrary host-assigned identity integer is not a catalog ordinal. Getting
the ordinal from a funcref means finding it in the catalog table, which wasm
cannot do (it cannot compare funcrefs) but the host can, because the host owns
the catalog and can compare function identities.

So `encode_funcref` wants **"which catalog slot is this funcref"**, while
`exn_claim`/`exn_lookup` want **"give this exception a stable integer"**. Same
shape, different questions — and a single import answering both would be a union
in a trench coat, not an abstraction.

### Where that leaves it

The dispatching import is still the right idea for the IDENTITY question, and
widening the existing `__wpk_fork_host_ref_identity` rather than adding a new
import would keep the host obligation at 5 rather than growing it. But it covers
two of the four, not four, and its `exnref` arm rests on a value-crossing
property that is not established.

Not built, deliberately. Building an abstraction over a group that turned out
not to share a need is how a host contract grows without anyone deciding to grow
it — which is the defect this campaign's primary measure exists to catch.

## §28a — SETTLED: an `exnref` value cannot cross into a JS host

Built the probe §28 said it needed: a tag, a throw, a `try_table` catch, the
caught `exnref` handed to a JS import twice. Assembled with `wasm-tools 1.239.0`
rather than by hand.

```
compile:      OK
instantiate:  OK
call run():   FAILED -> TypeError: type incompatibility when transforming from/to JS
```

**A module may DECLARE an `exnref` import and instantiate it. Passing a real
`exnref` value across the JS boundary is where it stops.** That is why the
structural probe in §28 read as permissive: nothing rejects the declaration.

Two corroborating asymmetries from the same run:

* `new WebAssembly.Table({element: "exnref"})` is rejected by the JS API, while
  `anyfunc`, `externref` and `anyref` are all accepted.
* `(table $t 1 exnref)` assembles fine as a MODULE-OWNED table. So wasm can hold
  exception references in a table; JavaScript cannot create that table or
  receive what is in it.

### What this removes

**`exn_claim`, `exn_lookup` and `exn_broker_encode` cannot be served by a
host-identity import at all.** Not "at a cost" — the mechanism does not exist on
a JS host. Widening `__wpk_fork_host_ref_identity` to take an `exnref` would
compile, instantiate, and then throw a `TypeError` the first time a guest
actually caught an exception. That is the worst possible failure shape: it
passes every structural check and fails only under load.

So the §28 grouping narrows again. Of the four "identity" imports, `exn_claim` /
`exn_lookup` / `exn_broker_encode` are not a host-import question at all, and
only `encode_funcref` remains — and §28 already showed it wants a catalog
ordinal rather than an identity.

**There is no longer a case for a new or widened identity import.** The host
obligation stays at 5.

### What it points at instead

Exception identity has to be decided INSIDE wasm, where exnrefs live. The module
can own an `exnref` table, so the remaining mechanism is a module-owned
exception table plus a linear scan — wasm has no `ref.eq` for `exn`, but it does
have `ref.is_null`, and a table the module fills itself has a known slot per
entry. That makes `exn_claim`/`exn_lookup` an injector problem rather than a
host-contract problem, which is the direction this lane wants anyway.

Not started. Recorded because it changes which door the exception group goes
through.

### On the instrument

§28's hand-encoded probe was checked against `wasm-tools` output for the
`anyref` case and is **byte-identical**
(`0061736d0100000001060160016e017f020d0103656e760570726f62650000`). The earlier
correction to two section lengths was an arithmetic fix derived from the
encoding rules — 6 and 13 where 5 and 11 had been written — not an instrument
tuned until it gave a wanted answer. The control was chosen because its result
is independently known: the production fork-module imports an `anyref`-typed
function and instantiates. Worth stating plainly, because "fix it until the
control passes" is exactly what a tuned experiment also looks like.

## §28b — Exception identity: the boundary, measured on both sides

§28a settled that an `exnref` VALUE cannot reach a JS import. The other half is
whether wasm can identify one itself. Probed with `wasm-tools 1.239.0`, using
`validate --features all` rather than `parse` — parse alone ACCEPTS all of these
and therefore discriminates nothing, which is the trap a control exists to
catch. A positive AND a negative control were run beside them:

| module | validates |
|---|---|
| `ref.eq (eqref, eqref)` — POSITIVE control | **VALID** |
| `ref.eq (funcref, funcref)` — NEGATIVE control | invalid |
| `ref.eq (exnref, exnref)` | **invalid** |
| store an `exnref` into an `anyref` table | **invalid** |
| `ref.cast eqref` from an `exnref` | **invalid** |

So `exn` is a disjoint hierarchy in the same way `func` is: no comparison, no
coercion into the eq hierarchy, no cast that rescues it. **Wasm cannot tell two
exception references apart**, and per §28a neither can a JS host receive one to
tell them apart on its behalf.

### What still works, and it is enough for the important half

A module-minted exception can carry its own identity in the tag payload.
Probed end to end:

```
(tag $id (param i32))   throw $id -> try_table (catch_ref $id) -> payload
payload 1 -> 1   payload 42 -> 42   payload 65535 -> 65535
```

So the mechanism that remains is: **the module mints, the module identifies.**
An exception the module threw carries its recipe id in the payload and is
recognised on catch with `catch_ref` against its own tag — which
`inject_unwind_tag` already creates.

### The consequence for `exn_claim` / `exn_lookup`

Those two dedup an exception by identity so the same one caught twice gets one
recipe. That is expressible for module-minted exceptions and **NOT expressible
for foreign ones**, which the guest catches with `catch_all_ref` and which carry
no payload the module may read.

This is a genuine platform boundary, not an implementation gap, and it should be
recorded as one rather than worked around. The honest options for a foreign
exception are a fresh recipe per catch — correct unless the same foreign
exception is captured twice in one fork, where it would split into two recipes,
the exception-side analogue of the identity split §24's GC work exists to
prevent — or a truthful refusal to capture it.

Which of those is right is a maintainer decision, and it is the same SHAPE as
the one the GC path already answered with a host import: there, the host could
supply identity, so it did. Here it cannot, on either side. **Not started.**

## §29 — Exception capture has no gap: fresh recipe per catch is UNOBSERVABLE

§28b recorded "fresh recipe per catch, correct unless the same foreign
exception is captured twice" as one of two options, and called the residue a
platform boundary. The maintainer's instruction was that there should be no
gaps. Checking properly shows there is not one.

**The duplication cannot be observed by a guest.** Probed with `wasm-tools
validate --features all`:

| on two `exnref`s | validates |
|---|---|
| `ref.is_null` | **VALID** — separates null from non-null, not one exception from another |
| `ref.eq` | invalid |
| `ref.cast eqref` | invalid |
| store into an `anyref` table | invalid |
| `extern.convert_any` (escape to JS to compare there) | invalid |

and §28a already showed an `exnref` value cannot cross into a JS import.

So the exact limitation that stops the module deduping also stops the guest
detecting the duplication. A child that rebuilds two exception objects where the
parent had one is, from inside the guest, indistinguishable from one that
rebuilt a single object. **This is not a gap that was accepted; it is a
difference that cannot be detected.**

Two things make that argument hold rather than merely sound good, and both are
asserted in the capture harness:

* **Payloads still dedup.** They are captured as ordinary references through the
  normal identity path, so two exception recipes reference the SAME payload
  objects. The duplication is of the exception wrapper alone.
* **It cannot recurse.** A never-hit lookup would loop forever on a
  self-referential exception, and none can exist: a payload is fixed at `throw`,
  so a cycle would need each exception to exist before the other. Exception
  payload graphs are acyclic by construction — the same argument that makes
  constructor seeds acyclic (§25).

### What it cost

Nothing. `__wpk_fork_ref_exn_lookup` and `__wpk_fork_ref_exn_claim` are pure
Rust: no injected shim, no host import, no new module entry point.
`forkGuestImportsUnserved` 15 -> 13, banked; the host obligation stays at 5.

`exn_broker_encode` is the remaining member of that group and is a different
question — cross-activation dispatch, not identity.

## §30 — The unknown-tag path, served as a loud refusal

`__wpk_fork_ref_exn_broker_encode` is called when a caught exception matched
none of the module's declared tag layouts. It now returns `EOPNOTSUPP` and a
poisoned recipe.

**A foreign exception is opaque on every axis.** Its payload needs `catch_ref`
against the tag that threw it, which this module by definition does not have; it
cannot be identified (§28b); and it cannot be handed to a host to inspect
(§28a). Real handling means routing to the activation whose codec DOES own the
tag, which needs the module to drive the capture walk across activations — no
capture-side drive exists, and that is F3 (§26).

### Why not the designed mechanism

`fm_capture_gated_placeholder` exists exactly for "a value with no recoverable
provenance", and it was the obvious choice. Its contract, though, is that the
HOST notices and gates the fork — and **no signal for that is exported**:
`fm_stats` carries eleven counters and none of them is a gated count. So a
placeholder here would be silent. The child would rebuild the `i31(0)` sentinel
where an exception had been, and nothing anywhere would say so.

A poisoned recipe makes the failure structural instead. The value is not a valid
recipe id, so an edge naming it is rejected by `define_gc`'s bounds check and by
`fm_capture_validate`, and the capture cannot seal. The harness asserts that
whole chain, and perturbing it BACK to a gated placeholder fails the first
assertion — which is the point: the silent option is the one the test refuses.

### The restriction, stated

A fork cannot be taken while a foreign exception is live. That is real, and it
is named rather than hidden. It is also not a regression: leaving the import
unserved hands the same case to a host that cannot inspect the exception either,
so nothing was able to do better before.

Upgrading it is a well-defined piece of F3 work: once the module can drive the
capture walk, the unknown-tag path becomes a routing question rather than a
refusal.

`forkGuestImportsUnserved` 13 -> 12, banked. Host obligation unchanged at 5.

## §31 — The mutation group is dlopen's, not fork's

§16 withdrew the "undefined journal format" blocker by showing the table state
crosses as a reference graph in formats that already exist. That was right about
the format and wrong about the owner. Reading the live implementation — in
`host/src/worker-main.ts`, which SURVIVES, so no attic was needed — settles
where these five imports belong.

```
beginMutation: options.dlopen.acquireArchiveWriter()
abort:         options.dlopen.releaseArchiveWriter()
commit:        options.registry.captureFuncrefTablePatch(...)
               options.dlopen.loader().canPublishTablePatch(patch)
               options.dlopen.loader().publishTablePatch(patch)
reconcile:     options.dlopen.withArchiveWriter(reconcileLocked)
```

**Every operation runs on dynamic-linker machinery.** The writer ownership the
protocol acquires is the dlopen ARCHIVE WRITER lock. The publication path is the
dlopen loader's table-patch mechanism, with a full checkpoint as the fallback
when an entry is typed or opaque. The replica whose generation is returned is
`dylink-table-replica.ts`.

None of that is attic'd: `dylink-artifact.ts`, `dylink-loader.ts`,
`dylink-planner.ts`, `dylink-planner-wire.ts` and `dylink-table-replica.ts` are
all intact, outside this lane's reversal, and `crates/dylink` owns the Rust
half.

### What that means for lane F

The imports are spelled `__wpk_fork_module_state_table_*`, which is what made
them look like fork state. They are not. They are the dynamic linker's table
replication, reached through a fork-prefixed name because a forked child must
reconcile replicas.

Serving them in the fork-module would mean the fork-module acquiring dlopen's
writer lock and driving dlopen's patch publication — reaching across a component
boundary into a subsystem that is not mid-migration and has its own owner.

**So the mutation group is NOT unblocked work for this lane**, and §16's
"buildable, nothing owed" reads too optimistically. It is a boundary question:
whether table replication moves into the fork-module, stays with dlopen, or
moves into `crates/dylink` on the Rust side. The third is the most likely right
answer, since `crates/dylink` already exists and the goal is Rust-first — but it
is not lane F's call.

`forkGuestImportsUnserved` therefore has a floor of 5 for this lane alone,
unless that boundary question is answered differently.

## §32 — CORRECTION to §31: the dylink protocol is already Rust, and the fork-module can reach it

The maintainer's answer to §31 was to move table replication into
`crates/dylink` unless there is a good reason not to. Checking for that reason
found §31 overstated the boundary.

**Most of it is already there.** `crates/dylink/src/session.rs` models
generations, `table_checkpoint_generation` and the rule that patch generations
must be strictly ordered. `crates/dylink/src/archive.rs` models
`DylinkTablePatch` with its publication records. The wire types live in
`fork_codec::dylink_archive`, which `fork-codec` re-exports — and `fork-module`
already depends on `fork-codec`, so **the types are reachable from the
fork-module today, with no new dependency edge.**

**§31's boundary concern was about the wrong thing.** What the TypeScript
reaches into is the *host-side* dlopen loader. Linking `crates/dylink`'s Rust
library is not that: a library is not a component boundary.

### The one real constraint

`dylink_module32.wasm` declares **0 imports**. It is a pure computation module —
no memory, no tables — which is a deliberate shape, not an oversight. So the
half of the protocol that READS AND WRITES FUNCREF TABLE ENTRIES cannot live
there: it holds no table to read.

That is the good reason the move cannot be total, and it is specific: the
protocol logic belongs in `crates/dylink` (and largely already is), while the
table access needs whoever holds the table.

### Who holds the table

The fork-module does. Its built artifact imports
`env.__indirect_function_table` alongside its three fork tables, and
`fork-module-inject` already emits `table.get` / `table.set` shims.

So the shape that works, without a new host import or a new module:

* **`crates/dylink`** keeps the protocol — generations, ordering, patch model.
  Already true.
* **`crates/fork-module`** serves the five `module_state_table_*` guest imports,
  delegating decisions to that Rust and doing the table access itself through
  injected shims.
* The **host** keeps only what neither can: the writer lock, if it must stay a
  host object rather than an atomic in shared memory.

`forkGuestImportsUnserved`'s floor of 5 from §31 is therefore lifted. The
mutation group is buildable in this lane after all — §31's "not unblocked work"
was wrong and is superseded.

## §33 — What the 139 reversal errors actually point at

The maintainer asked whether the TypeScript errors blocking the merge point at
further things that should be ported. Measured: the lane branch reports 148
`tsc` errors, the parent 25, and **139 lines differ**.

### Three quarters of them are not work

| kind | count | what it is |
|---|---|---|
| `TS7006` implicit any | **55** | CASCADE. A parameter loses its type when its module is missing. Resolves for free. |
| `TS6059` / openssl rootDir | **15** | PRE-EXISTING — the parent reports the same 15. Not the reversal's. |
| `TS2307` cannot find module | **44** | The real signal: 25 distinct missing modules. |
| type errors (`TS2322`, `TS2339`, `TS18046`, `TS2551`, `TS2353`) | **25** | Downstream of the missing types. |

So the actionable population is **25 modules**, not 139 errors. And **99 of the
139 are in one file**, `worker-main.ts` — the fork orchestration site, which is
the lane's target anyway.

### Ranked by how much they block

`fork-host-import-runtime` (5 errors), `fork-replay-gate` (4),
`fork-reference-broker` (4), `vfork-lifetime` (4),
`fork-externref-process-owner` (3), `fork-mechanism-trace` (3), then 19 modules
at 1-2 errors each.

The ranking is a poor guide to effort: `fork-process-continuation` causes ONE
error and is 1,471 lines of driver loop (§23), while `fork-mechanism-trace`
causes three and exports a single function.

### The ones I doubt should be ported, and why

Four are worth a decision rather than a default:

* **`fork-mechanism-trace`** — exports `sampleProcessMemoryStats`. That is
  process diagnostics, not fork mechanism. It looks misfiled rather than
  unported: the likely right move is relocating it to a non-fork host file, and
  porting it would put memory sampling inside the fork module for no reason.
* **`browser-fork-module-artifact`** — a Vite `?url` artifact shim. Browser
  build plumbing; there is nothing to port.
* **`fork-reference-broker` / `fork-externref-process-owner` /
  `fork-externref-import-mailbox`** — externref identity and per-process
  lifetime. `CLAUDE.md` names externref identity as the irreducible floor, and
  §28a showed why the boundary is real. These stay, but the question worth
  asking is how THIN they can get now that the module owns identity for the
  `any` hierarchy.
* **`fork-module-trampoline`** — host-side call thunks. Whether these survive
  depends on the F3 coarsening: a coarse drive API needs fewer thunks, so this
  may shrink to nothing without being ported.

Everything else falls into the two groups already measured: work the module now
does, where the call site should be deleted (§13, as corrected by §19), and
genuine floor (§23).

## §34 — The reconcile planner, in Rust

First piece of the mutation group, following §32's shape: `crates/dylink` keeps
the protocol, the fork-module does the table access, and the decision about WHAT
to write is one pure function rather than one per host.

`crates/fork-codec/src/dylink_table_plan.rs` turns a published patch chain into
a flat, ordered list of funcref table writes. It lives beside `drive_plan.rs`
and uses the same split for the same reason: applying a patch means `table.set`
on a funcref table, which Rust cannot emit, so Rust decides and an injected wasm
shim writes.

A `DylinkTablePatch` is run-length encoded — `length` consecutive slots set to a
`(activation_id, ordinal)` catalog coordinate, or cleared to null. **That
coordinate is the one the fork-module already resolves**: it imports
`__wpk_fork_function_catalog` and `fm_funcref_ordinal` already maps a recipe to
a merged catalog slot. Nothing new is needed to name a function.

### What the planner refuses, and why each matters

* **`>` not `>=` on the applied generation.** Re-applying the generation the
  caller already holds would undo any newer LOCAL mutation made since.
* **A disordered or repeating chain is refused, never sorted.** The order
  records causality, and `crates/dylink`'s publication rule is that generations
  strictly increase. Inventing an order would let two workers disagree about
  what happened.
* **A run past the table it describes is refused.** Silently truncating would
  leave a replica partly updated and claiming a generation it had not reached.
* **A null run CLEARS.** Writing catalog slot 0 instead would populate every
  cleared slot with whichever function is first in the catalog — a plausible
  bug with no symptom until something calls through it.
* **Another owner's patches are skipped**, so a reconcile cannot cross owners.
* **A plan beyond `MAX_PLAN_STEPS` is `E2BIG`**, because an unbounded chain
  means the publisher is emitting history where a checkpoint was expected, and
  applying millions of writes would turn a coherence bug into a hang.

`planned_generation` is deliberately separate from the steps: the caller
publishes it only AFTER the writes land, since storing it first would let a peer
observe a generation whose entries are not there yet.

Eight tests, and every guard above was perturbed until its own test failed —
including the two silent ones, the `>=` skip and the null-run-as-slot-0, which
are the failures that would otherwise surface as a child calling the wrong
function.

### Planned against the real published archive

`crates/fork-codec/testdata/dylink-archive-wasm32.bin` is real output from the
TypeScript `DylinkForkArchive` writer, already used by the decoder's own tests.
The planner is now tested against it, not only against hand-built patches — that
is what would catch the publisher's run encoding and this reader's expansion
drifting apart. The test asserts the fixture actually CARRIES patches first,
because without that the loop over owners would be vacuous and the test would
pass by asserting nothing.

### A test of mine that could not fail

`the_reached_generation_is_the_highest_applied_not_the_last_seen` did not test
that. Its out-of-order patch belonged to a DIFFERENT owner, so the owner filter
removed it before order could matter, and `.last()` passed in place of `.max()`
against the entire suite. Found by perturbing, not by reading.

Fixed by putting the disordered patch under the SAME owner. Worth recording that
`plan_table_patches` refuses a disordered chain, so that input cannot reach a
reconcile — `planned_generation` is public and independently callable, so it is
made correct by construction rather than by trusting its caller to have checked.

This is the third test this session that could not fail — after the dirty-page
assertion and the last-wins witness. All three shared one cause: the assertion
was written from what the implementation does rather than from the property that
must hold.

**Not yet wired.** The five guest imports stay unserved until the shim and the
archive address land; this is the half that can be proven without them.

## §35 — The module side of reconcile: built, proven, then REVERTED by its own ratchet

`fm_table_plan_build` / `fm_table_plan_step` / `fm_table_plan_generation` were
written, built and proven end to end, then reverted. The reason is worth more
than the code, which is preserved at `/tmp/lane-f-wip/*.patch` and reconstructible
from this section.

### What it did, and that it worked

The module decoded the published archive IN PLACE out of guest memory —
`ArchiveBytes` implemented over the guest's own linear memory, which the module
shares — resolved each `(activation, ordinal)` to a merged catalog slot through
the `func_catalog_base` map it already keeps, and stored a bounded plan.

Proven from the capture harness by writing
`testdata/dylink-archive-wasm32.bin` into guest memory at offset 0. The
fixture's single patch is owner 3, activation 7, runs
`[(2, null), (3, (activation 8, ordinal 4))]`, and the harness asserted that
exact shape: five steps, clear flags `[1,1,0,0,0]`, consecutive destinations,
each written slot resolving to `base 0 + ordinal 4`.

### Why it was reverted

`forkModuleEntriesWithoutProductionCaller` went 27 -> 30 and its ceiling is 27.
The three exports have no production caller because the shim that would call
them does not exist yet.

**That is the ratchet working, not obstructing.** It says: do not land API ahead
of its consumer. Completing the increment properly needs the injected shim that
walks the plan AND a seeding export for the archive head and owner — which would
trip `forkModuleInjectorHelpers` and `forkModuleHostDriveEntries` in turn. Three
coordinated ceiling movements, with intricate walrus control flow, is not
something to rush; this session has already found five tests that could not fail,
and every one came from moving faster than the verification.

So the next increment is the whole reconcile — planner exports, shim, seeding —
landed together, or none of it.

### A host-facing finding worth keeping

While it was in the tree, the module's `dylink.0` tablesize went **0 -> 2**: the
archive decoder's trait object erases to a `call_indirect`, so the module needs
real `__indirect_function_table` slots. Both V8 harnesses hardcoded `initial: 0`
and failed instantiation with "table import is smaller than initial 2".

**`host/src/fork-module-instance.ts` and `crates/host-native` both passed
unchanged** — they already size that table from `dylink.0` rather than assuming
zero. The placement module written earlier this session absorbed a change that
broke two hardcoded callers, which is the best evidence so far that reading
`dylink.0` rather than guessing was right.

The harnesses should be fixed to read the size from `dylink.0` when the
increment returns; hardcoding zero is a latent break for any future module that
needs an indirect call.

### Two more tests that could not fail, found before the revert

**The harness planned owner 0.** The fixture's only patch is owner 3, so every
assertion ran against an empty plan, and "a refused build leaves no readable
plan" passed because there was no plan either way.

**The unregistered-activation refusal was unreachable.** `catalog_slot` treats a
missing base as 0 when NO base is seeded (the single-activation worker, where 0
is correct by definition) and as `EINVAL` when others are seeded (a graph naming
an activation nobody registered). The harness never seeded a base, so the second
arm could not run and deleting it changed nothing.

Both fixed before the revert, and both are in the preserved patch. They are the
fourth and fifth such tests this session, all from the same cause: the assertion
written from what the implementation does rather than from the property that
must hold.

### One perturbation that is honestly not a guard

Resolving a catalog slot for CLEAR steps too changes nothing observable: the
planner sets activation and ordinal to 0 for a clear, so the slot resolves to 0
either way and the shim ignores it. The short-circuit is a robustness property,
not a behaviour the fixture can exercise. Recorded rather than given a contrived
test.

## §36 — CORRECTION: `fork-mechanism-trace` is not misfiled

§33 flagged `fork-mechanism-trace` as one of four modules worth a decision
rather than a default, on the grounds that its single export
`sampleProcessMemoryStats` "is process diagnostics, not fork mechanism" and
"looks misfiled rather than unported". That was read from the function's NAME.
Reading its call sites says otherwise.

It is called either side of the fork memory clone in `process-lifecycle.ts` and
its result feeds `traceVforkMechanism("fork_prepared", ...)` with a
`liveMemories` DELTA across the clone. It is vfork mechanism tracing, filed
exactly where it belongs.

It is also genuinely host floor: it samples the host's
`ProcessMemoryAllocator` and is gated on `isVforkMechanismTraceEnabled()`,
neither of which the module can see. And it is small — `traceVforkMechanism`
itself is a local function in `process-lifecycle.ts`, so this module owes only
the one sampler.

So the §33 list of four is really a list of three: `browser-fork-module-artifact`
(a Vite `?url` shim with nothing to port), the externref broker/owner/mailbox
trio (the named irreducible floor, where the open question is how thin it gets),
and `fork-module-trampoline` (which may shrink to nothing under F3 coarsening).
`fork-mechanism-trace` is ordinary stage-2 floor to rewrite thin.

**Third time this session that a name was a worse guide than the call sites** —
after `fork-early-reference-provider` (filed as dead, actually 13 live sites)
and `fork-anyref-transit` (filed as replaced, actually carries the
`Table.grow` sizing `CLAUDE.md` names as floor). §19 already recorded that
`fork-mechanism-trace` was the doubtful case; it turned out doubtful in the
other direction.

## §37 — `forkTypeScript` is at 249 of 250, and the next piece needs a decision

The ceiling of 250 was approved as HEADROOM for stage 2's module-facing half.
That half is complete: `fork-module-host-capabilities.ts` (65) plus
`fork-module-instance.ts` (184) measure **249**.

Every remaining stage-2 file is a `host/src/fork-*.ts` and so counts against the
same surface. `fork-mechanism-trace` is the smallest of them and still exceeds
the one line of headroom left.

This is the same decision shape as the 0 -> 250 approval, and deliberately not
one this lane makes: the budget entry records that 250 is headroom rather than a
measurement and must be banked to the real figure once the half stops moving.
The honest sequence now is either

* **bank it to 249** and open a separate allowance for the platform half, which
  keeps the two halves independently ratcheted and matches how the module
  surfaces were split in §10; or
* **raise it once** to cover the platform half, with the same "headroom, bank it
  later" note the current entry carries.

The first is more in keeping with what splitting `forkModuleEntryPoints` by
purpose already established: a ceiling that mixes a finished population with an
unstarted one cannot be read.

**DECIDED 2026-09-12: the first.** `forkTypeScript` is banked to 249 with slack
0 and its measure narrowed to `host/src/fork-module-*.ts`, and a new
`forkPlatformTypeScript` covers the rest of `fork-*.ts` plus `vfork-*.ts` with a
pre-authorized envelope of 450 on the same terms the module half's 250 had: it
must be banked once the half stops moving.

Target 300 rather than 450, because §23 measured what the set-aside modules
actually depend on and found three of five are neither coordination nor floor —
`fork-process-continuation` alone is 1,471 lines of driver loop that should
collapse under the F3 coarsening rather than be rewritten.

The split is proven to route, not assumed: with the platform ceiling tightened
to 0, adding a `host/src/fork-probe-temp.ts` fails `forkPlatformTypeScript is 3,
above its ceiling of 0` while the banked surface stays at 249; adding a
`host/src/fork-module-probe-temp.ts` instead fails `forkTypeScript is 252, above
its ceiling of 249`. Each surface catches exactly the file kind it owns.

## §38 — F3 scoped: the capture-side drive already has a socket to plug into

§26 recorded that "there is no capture-side drive", and used that to defer
provenance consumption and the unknown-tag upgrade to F3. That is true of the
PLAN machinery and false of the MECHANISM, which changes how large F3 is.

### The three facts that decide it

**The guest already exports the capture entry point.**
`WPK_FORK_REFERENCE_EXPORT_GC_ENCODE_SLOT` — `__wpk_fork_ref_gc_encode_slot(slot)
-> recipe` — is a guest EXPORT, not an import. `fork-instrument`'s own Node
tests call it directly as `instance.exports.__wpk_fork_ref_gc_encode_slot(0)`:
stage a value in the transit slot, call, get its recipe id. The exception side
has the matching `__wpk_fork_ref_encode_exnref` and
`__wpk_fork_ref_exn_encode_ingress`.

**The module already drives guest exports through a table.**
`__wpk_fork_drive_table` plus the injected `fm_drive_execute` `call_indirect` is
exactly that mechanism, used today for `_gc_allocate` / `_gc_fill` /
`wpk_fork_rewind_begin` and eight more.

**And the table is explicitly designed to grow.**
`DRIVE_SLOTS_PER_ACTIVATION` is 11, slots 0-10 assigned, and `drive_plan.rs`
states the rule: "This is an EPHEMERAL runtime host<->module table-binding
contract (not a wire/ABI format, not serialized), so **growing it is
additive**." Binding `__wpk_fork_ref_gc_encode_slot` at offset 11 is therefore
an additive change, not an ABI change, as long as every side derives its slots
from `drive_table_base`.

### What F3 actually decomposes into

1. **Bind the capture exports at new drive slots.** Additive; the host already
   binds eleven this way.
2. **A capture-side walk.** The replay side has `build_drive_plan` +
   `fm_drive_execute`; capture needs the mirror — stage, `call_indirect` encode,
   record the recipe — with the same Rust-decides / wasm-calls split.
3. **Delete the driver it replaces.** `fork-process-continuation` is 1,471 lines
   with no atomics, no promises and no worker references, calling nine
   fine-grained module entries (§23). That is the visible prize, and it is also
   the largest single item in `workerMainTypeScript`'s orbit.

### What it then unblocks, with no further design

* Provenance WITNESS consumption (§24, §26): capture can intern each witness and
  emit its recipe as `gc_define`'s provenance id.
* `gc_capture_layout` and `gc_broker_encode`, two of the three remaining
  shim-backed imports.
* The unknown-tag path (§30) upgrading from a truthful refusal to real
  cross-activation routing, because "ask the activation whose codec owns this
  tag" becomes a drive-table call rather than an impossibility.

### The risk worth naming up front

The capture walk runs during the fork's critical section, and the
`ABORT_UNWINDING` discipline the master plan records as having trapped or hung
two prior attempts lives in exactly this region: `fm_parent_seal_capture` must
not drive the guest's `wpk_fork_unwind_end` when a reserve failed mid-unwind.
A capture-side drive adds another guest call into that window, so the sequencing
has to inherit that discipline rather than rediscover it.

Scoped, not started.

## §39 — F3 step 1: the capture drive slot, and two tests that hardcoded the stride

`DRIVE_SLOT_GC_ENCODE = 11` is added and `DRIVE_SLOTS_PER_ACTIVATION` bumped
11 -> 12. This is the socket §38 identified: the host binds the guest's
`__wpk_fork_ref_gc_encode_slot` there, and the module reaches it by
`call_indirect` exactly as it already reaches the eleven replay entries.

Everything in that slice was replay — the module driving the guest to REBUILD a
graph. This one is the first capture entry: stage a value in the anyref transit
slot, call through, and the guest's generated codec returns its recipe id.

### The contract's own rule caught two violations of it

`drive_plan.rs` says growing the slice is additive "as long as every side
derives its slots from `drive_table_base`". Bumping the count failed two tests
that did not:

* `trivial_struct_plan_uses_the_activation_base_slots` asserted literal slots 22
  and 23 for activation 2.
* the multi-activation test asserted `drive_table_base(5) == 55`.

Both now derive — `drive_table_base(2) + DRIVE_OP_ALLOC`, and
`5 * DRIVE_SLOTS_PER_ACTIVATION` plus an explicit non-overlap assertion. The
file that states the rule contained the two places breaking it, which is worth
recording: a rule written in a doc comment is not a guard.

### An exhaustive guard replaces remembered pairs

The distinctness checks here were `assert_ne!` PAIRS — they check the collisions
someone thought of. `every_drive_slot_is_distinct_and_inside_the_slice` now
checks all twelve: every offset inside the slice, every pair distinct, and the
list length equal to the count.

That last clause is the one that matters. Perturbed by adding the slot and
NOT bumping the count — the exact mistake this kind of change invites — it
fails with "GC_ENCODE at 11 is outside the 11-slot slice, so it would alias the
next activation". Colliding it with an existing slot fails with "REWIND_BEGIN
and GC_ENCODE share slot 5". Neither would have been caught by the pairwise
checks, because neither pair was on the list.

Nothing binds or calls the new slot yet: that is F3 step 2, the capture-side
walk.

## §40 — F3 step 2 designed: one straight-line shim, no loop, no dangling export

Reading `inject_drive_thunk` settles the shape, and it is smaller than expected.

### The shim is straight-line

The witness intern is three wasm operations, not a loop:

```
__wpk_fork_capture_witness(activation, witness_slot) -> recipe
    transit[0] = witness_table[witness_slot]     ;; table.get + table.set
    call_indirect drive_table[base(activation) + DRIVE_SLOT_GC_ENCODE] (0)
```

`fm_drive_execute` needed a loop because a drive plan has many steps. Interning
one witness is one encode, so this is a single `call_indirect` with the transit
slot as its argument and the guest's generated codec returning the recipe id.

### The PLACEHOLDER IMPORT is what keeps it callable

`inject_drive_thunk` is the pattern: Rust declares
`#[link(wasm_import_module = "env")] fn __wpk_fork_drive_plan(...)`, and the
injector rewrites that import into a LOCAL thunk forwarding to the shim, so the
emitted module carries no unresolved import and the host supplies nothing new.

That matters here for a specific reason. `forkModuleEntriesWithoutProductionCaller`
is at 27 of 27 with a target of 0, so any new `fm_*` export with no caller trips
it — which is what forced §35's revert. Under the placeholder pattern the shim is
reached from Rust, so nothing dangles and the bucket does not move. **A rise in a
target-0 surface is a design smell, not a budget need**, and this design avoids
needing one.

### Where the interning belongs

Lazily inside `__wpk_fork_ref_gc_define`, which is itself one of the twelve
unserved guest imports and is the natural site: §21 established that gc_define is
coupled to provenance and must not be served alone, because serving it in
isolation would bake in "provenance is always absent".

So the increment is one coherent unit:

1. Serve `__wpk_fork_ref_gc_define` — guest-facing, so it does not touch the
   `fm_*` counters at all.
2. For a layout with provenance, intern that layout's witnesses through the
   capture shim on first use, caching the recipe per witness slot.
3. Pass those recipe ids as `define_gc`'s provenance edges, which closes §24 and
   §26: the witnesses stop being recorded-but-unreadable.

`forkGuestImportsUnserved` 12 -> 11, `forkModuleInjectorHelpers` rises within
its existing envelope of 15, and no ceiling with a target of 0 moves.

### What the harness needs to test it

A drive table with a real function bound at `base + DRIVE_SLOT_GC_ENCODE`. The
JS API will not accept a plain JS function in an `anyfunc` table, so the harness
must compile a tiny stub module — `(func (export "encode") (param i32) (result
i32) ...)` — and bind its export. `wasm-tools` is available and was used for the
exnref probes, so this is the same technique that settled §28a.

### The risk, restated

This runs inside the fork's critical section, where the `ABORT_UNWINDING`
discipline lives. `gc_define` is called during the guest's own encode walk
rather than during unwind, which keeps it clear of `fm_parent_seal_capture`'s
window — but that separation is an assumption to verify, not to rely on.

Designed, not started.

## §41 — F3 step 2 LANDED: the module drives the guest to capture

`__wpk_fork_ref_gc_define` is served, and with it the first capture-side use of
the drive table. Every other slot drives replay; slot 11 drives the guest's own
codec to ENCODE.

The shim is three operations, straight-line:

```
transit[0] = witness_table[witness_slot]
call_indirect drive_table[activation * 12 + DRIVE_SLOT_GC_ENCODE] (0)
```

so the module obtains a recipe for a reference Rust can neither hold nor
describe. Witness recipes are cached per slot, because a witness is shared by
EVERY object of its layout: a thousand objects reference one recipe rather than
interning the same reference a thousand times.

This closes §24 and §26. The witnesses were recorded but unreadable; they are
now interned and become `define_gc`'s provenance edges, which is what §21 said
gc_define must not be served without.

### What did NOT move

`forkModuleHostImports` stays at 5 and the module still declares 10 imports.
The placeholder-import pattern is why: Rust declares
`env.__wpk_fork_capture_witness`, the injector rewrites that import into a local
thunk, and the emitted module carries no unresolved import. No `fm_*` counter
moved either, so no target-0 ceiling rose — the design constraint §40 set for
itself.

**The host-obligation gate proved it, by firing first.** With the Rust landed
and the injector pass not yet written, `fork_module_host_obligation_is_pinned`
failed naming the exact new import: `functions=["__wpk_fork_capture_witness",
"__wpk_fork_host_ref_identity", "resolve_externref"]`. That gate was written
earlier this session precisely for a change like this, and it caught the
intermediate state rather than letting an unresolved import reach a host.

### How the cache is proven rather than asserted

The harness binds a real wasm stub at the drive slot — the JS API refuses a
plain JS function in an `anyfunc` table — which counts its calls in an exported
global. Defining one object drives it exactly once. Then the drive slot is
CLEARED and a second object of the same layout is defined: it succeeds, and the
call count does not move. A cache miss there would `call_indirect` a null entry
and trap, so the test cannot pass by accident.

Perturbations, and two of them trap rather than assert:

* not caching the recipe -> `RuntimeError: null function or function signature
  mismatch`, because the second define re-encodes through a cleared slot
* passing no provenance edges -> "the module drove the guest codec exactly once"
  fails
* pointing the injector at drive slot 10 -> the same trap, since slot 10 is
  `UNWIND_BEGIN` and unbound here

### Duplicated constant, pinned not trusted

`fork-module-inject` cannot link `fork-codec`, so `DRIVE_SLOT_GC_ENCODE` and
`DRIVE_SLOTS_PER_ACTIVATION` are duplicated there. Both carry a comment saying
which constant they must equal, and the wrong-slot perturbation above is what
would catch drift. A better fix would be generating them; that is not done.

## §42 — `capture_layout`, answered by asking the guest instead of remembering

`__wpk_fork_ref_gc_capture_layout` is served by driving the guest's TYPE-TEST
probe at a second capture drive slot (12).

**The problem it avoided.** A layout is a per-OBJECT fact: two objects of one
base type can be made by different constructors, and the fixture confirms
derived layouts are real (`l6.base_layout_id == 3`, `l7.base_layout_id == 4`).
So the witness trick that made provenance bounded does not apply here, and
recording layout per object is exactly the unbounded storage problem of §20 in
a new place.

**What made it unnecessary.** The guest already exports
`__wpk_fork_ref_gc_probe(slot) -> i64`, which reads the value from the anyref
transit slot, `ref.test`s it against each dispatch layout, and returns
`(type_ordinal << 32) | layout_id`, or 0 when nothing matches. The value is
ALREADY staged when the guest asks which layout it is, so the module forwards
the slot and unpacks the answer. **It keeps no map at all.**

The caller's static `layout` argument is deliberately not trusted over the type
test — the perturbation that returns it instead fails.

0 is passed through rather than special-cased: it is the probe's own answer for
a value this codec does not handle, and it is not a valid layout id, so a
`gc_define` using it fails rather than defining against layout zero.

### Perturbations

* trust the caller's guess -> "the layout comes from the guest's type test"
  fails
* return the high half (type ordinal) instead of the layout -> same assertion
  fails
* aim the injector at drive slot 11 -> `RuntimeError: null function or function
  signature mismatch`

### A third hand-encoding caught by the assembler

The probe stub's bytes were written by hand first, with the code-section length
20 where the encoding requires 17. `wasm-tools` caught it, as it caught the
`anyref` import probe earlier. Every stub in the harness is now assembled and
the comment says so, because a wrong length does not fail loudly — it fails as
a confusing instantiation error some distance from its cause.

`forkGuestImportsUnserved` 11 -> 10, banked. Host obligation unchanged at 5.

## §43 — The cross-activation broker: ask every codec, route to the claimant

`__wpk_fork_ref_gc_broker_encode` is served. §28 had called this "cross-activation
dispatch, not identity" and left it aside; with two capture drive slots in place
it is now a short loop.

A structurally canonical GC value can enter through another dynamically loaded
module, and that module's codec is the one that can encode it. The module cannot
inspect a reference, so it asks: for each activation registered through
`fm_set_activation_gc_codec`, drive that activation's PROBE, and on a non-zero
answer drive its ENCODE. Both are the guest's own generated functions.

**A loop rather than a lookup, and bounded.** Which activation owns a value is a
property of the value's TYPE, which the module cannot read — asking is the only
way. The cost is the number of registered activations, a handful even for a
program that dlopens heavily, and it is per BROKERED VALUE rather than per
object: the common path never reaches the broker, because the calling
activation's own codec matched first.

An unclaimed value is `EOPNOTSUPP` with a poisoned recipe, the same structural
refusal §30 gave the unknown exception tag: `-1` is not a valid recipe id, so an
edge naming it is rejected at `define_gc` and the capture cannot seal.

### The test routes, rather than merely succeeding

Two activations are registered, 3 first, and 3's probe DENIES while 4's claims.
Routing to the first registered rather than the first claimant would pick 3, so
the assertions check that 3 was asked, 4 was asked, and only 4 encoded.

Perturbations: ignoring the probe and routing to the first registered traps on
activation 3's unbound encode slot; inventing a recipe when nobody claims fails
"an unclaimed value is refused".

### Stubs parameterised, not re-encoded

The probe and encode stubs now read their answer from a mutable global the
harness sets, so one assembled blob serves every case. Encoding a different
`i64` by hand means re-encoding a LEB128 length, which is exactly how the
earlier stub in this file acquired a wrong code-section size.

### One injector simplification

The probe and encode thunks differ only in drive slot and result type, so both
now go through one `inject_forwarding_drive_thunk`. The index arithmetic — the
part that silently calls the wrong guest function when wrong — exists once.

`forkGuestImportsUnserved` 10 -> 9, banked. Host obligation unchanged at 5.

## §44 — The two must-throw entries: designed, deliberately not started

`__wpk_fork_ref_exn_broker_throw_recipe` and `__wpk_fork_ref_exn_ingress_throw`
are the last two of the exception group. Both are called INSIDE a `try_table`
with `catch_all_ref` and are expected to THROW — the emitter puts `unreachable`
after the call, so returning normally is a bug.

### `exn_broker_throw_recipe` is the tractable one

It is the exception mirror of §43: the recipe belongs to another activation, and
that activation's codec is the one that can reconstruct and throw it. The guest
already exports `__wpk_fork_ref_exn_throw_recipe`
(`WPK_FORK_EXCEPTION_EXPORT_THROW_RECIPE`), so the shape is the one now used
three times — reserve a drive slot, add a placeholder import, rewrite it with
`inject_forwarding_drive_thunk`, and let the throw propagate back out through
the `call_indirect` to the guest's own `try_table`.

One piece is missing: the module must map a recipe to its owning activation.
`reference_replay.rs` exposes `funcref_node` and `static_root_node`, which return
targets carrying `module_activation`, but nothing equivalent for an exnref. That
accessor is a small, testable fork-codec addition.

### `exn_ingress_throw` is not

Ingress is a FOREIGN exception entering the guest, and §28a/§28b established
that a foreign exception cannot be identified by the module (no `ref.eq` on
`exnref`, no cast into the eq hierarchy) or by a JS host (an `exnref` value
cannot cross into a JS import). To throw one back the module would have to be
holding it, which means having caught it — putting the module in the catch path
rather than the callee.

That is a larger change than the other three, and it may not be expressible at
all on a JS host. It should be scoped on its own rather than folded in here.

### Why this is recorded rather than built

The capture-drive pattern is proven and this would follow it, but these two run
exception control flow inside the fork's critical section — the region the
master plan records as having TRAPPED OR HUNG two prior attempts under the
`ABORT_UNWINDING` discipline. Three hand-encoded wasm stubs in this session were
caught wrong by the assembler before they ran; a throwing stub plus a diverging
`call_indirect` is where a mistake stops being a failed assertion and becomes a
hang.

The honest sequence is to start these fresh rather than at the end of a long
run: the design above is complete enough to pick up directly, and the branch is
green, pushed and at a clean boundary.

## §45 — The reconcile group needs ONE input the module cannot reach

§34 landed the planner and §35 showed the module side works. Picking it up again
with the placeholder-import pattern removes §35's blocker entirely:

**The apply needs no loop in wasm and no new `fm_*` export.** Rust loops over
the planned steps and calls a per-step placeholder — `table_apply(dest,
catalog_slot, clear)` — which the injector rewrites into a local thunk doing one
`table.get` from the function catalog and one `table.set` into the guest's
indirect table, or a null store when clearing. Same shape as the three capture
thunks. The guest-facing `__wpk_fork_module_state_table_reconcile` is a
`__wpk_fork_*` export, so it touches no `fm_*` counter.

**What still has no answer is where the archive head comes from.** The guest ABI
is `reconcile() -> i64` with no arguments, and:

* It is NOT in the fork module-state arena. `module_state.rs` has no dylink
  reference at all; the loader archive and the fork arena are separate
  structures.
* `fm_restore_from_arena` / `fm_child_seed` carry a `module_state_root`, not an
  archive head.
* The guest's own `table_generation_addr` import is an ADDRESS OF A FENCE, not
  of the archive.

Three ways to supply it, each with a cost:

1. **A new host-called seeding entry** (`fm_set_table_archive(head, owner)`).
   Simplest, but it raises `forkModuleHostDriveEntries`, whose target is 5 — a
   rise in a target-5 surface, which this lane treats as a design smell rather
   than a budget need.
2. **A module-state RECORD**, found with the `record_find` this module already
   serves. No new entry and no ceiling movement — but no such record kind exists
   and nothing writes one, so it means adding to the record-kind space, which is
   ABI-adjacent.
3. **A new guest or host import.** Grows the host obligation, which is the
   campaign's primary measure.

(2) looks best and is how the module-state mechanism is meant to be used — but
choosing a record kind is a wire decision, and census §F1 already noted that
`record_find` is declared by the guest and never called, so nothing establishes
the pattern yet.

**Not started, and not worked around.** Everything else about the increment is
designed and the planner is already proven against the real published archive.

## §46 — Category A, third probe: `fork-reference-segments` is not a deletion either

§13 filed `fork-reference-segments` as work the module now does, on the grounds
that `fm_decode_reference_graph` exists. Reading its call sites says the decode
is still load-bearing, and the code says so itself.

`worker-main.ts:4548` states the split exactly: the
`decodedChildReferences` decode "no longer drives the host-side STRUCTURAL
consumer — the static-root catalog mirror seeding reads node kinds +
coordinates from the module's `fm_decoded_*` accessors now — but it is still
held for the reconstruction WIRING it feeds (`ForkEarlyChildReferenceProvider`
+ the continuation `attachChild`)".

So half of it HAS migrated, and the half that has not is passed as a value to
three sites: the early-reference provider's `transaction`, and both
`attachChild` / `attachBorrowedChild` calls.

**That is three of three.** `fork-early-reference-provider` (filed dead, 13 live
sites), `fork-anyref-transit` (filed replaced, carries the `Table.grow` sizing
`CLAUDE.md` names as floor), and now this. §19 already downgraded that triage
from a plan to a hypothesis list; this is the third piece of evidence and the
pattern is consistent — **a module whose ALGORITHM moved into Rust usually still
has WIRING on the host side, and the name does not distinguish them.**

The useful consequence is that Category A is not a list of deletions. Each entry
is a question of how much of its surface migrated, answerable only by reading
its call sites, and several will shrink rather than disappear.

## §47 — Correction to §46: I read a comment, not a call graph

§46 recorded that Category A's `fork-reference-segments` "is not a deletion"
because its decoded transaction still feeds `ForkEarlyChildReferenceProvider`
and both `attachChild` paths, quoting the comment at `worker-main.ts:4548`.

That finding is wrong, and the way it is wrong matters more than the entry.

**`host/src/fork-early-reference-provider.ts` does not exist.** Commit
`49d7f6574` ("the build is now broken") moved it to
`attic/fork-typescript-do-not-use/` along with `fork-reference-segments.ts`.
`worker-main.ts:137` still imports it, so that import is DANGLING — it is one
of the 148 tsc errors, not a live consumer. The comment I quoted describes the
arrangement before the attic move; it survived only because nothing edited the
lines around it. **A stale comment is evidence of what was once true, never of
what is.** This is the fourth time in this lane that reading a name or a comment
gave a worse answer than reading the call sites (§31, §33, §46, and the
`forkModuleEntryPoints` miscount).

**What the provider actually consumes.** Across its 1619 lines, `transaction`
is touched exactly three times:

| Line | Use |
|---|---|
| 403 | `transaction.graph.nodes` |
| 407 | `transaction.vectors`, kept as "the immutable base" for an append overlay |
| 1013 | `transaction` passed WHOLE into `adoptChildReplay` — handed on, never read |

Only line 407 has any substance, and it is a representation preference (a JS
page-tree that appends without copying), not a capability the host uniquely has.
Line 403 is already served by the module: the same `worker-main.ts` comment
says the static-root catalog mirror now reads node kinds and coordinates from
the module's `fm_decoded_*` accessors.

**And the decode is a second decode of the same bytes.** The module already
does the wire decode internally — `fork_codec::reference_segments`, seeded by
`fm_begin_reference_replay`. The host copy is a duplicate whose only remaining
consumer is the provider's overlay base.

So the corrected finding is: **the decode is host code because its consumer is
host code, and that consumer is already in the attic.** It is blocked behind
porting the provider, not behind a host-floor capability.

This still supports §19 — the triage is a hypothesis list, not a work list —
but for the opposite reason than §46 gave. The maintainer named the standing
rule directly: *whenever deletion isn't happening, ask whether it has to be
host code.* "Not deletable" and "must be host" are different findings, and only
the second is a floor. A triage note that stops at the first retires a
candidate without ever testing it against the campaign's goal, and makes the
list self-confirming.

## §48 — The reconcile: where the host floor actually is, and the swap not taken

`__wpk_fork_module_state_table_reconcile` is served (commit `cd1247f60`).
Unserved guest imports: 9 → 8.

The interesting part is the ONE thing the host kept, and the alternative that
would have kept nothing.

The archive head is host-supplied because the published KFLA archive belongs to
the dynamic loader: it is not in the fork module-state arena, so the module
cannot find it by walking its own records, and the host is what wrote the
header there in the first place (`HostRequest::WriteArchive`,
`crates/dylink/src/archive.rs`).

**But §45 was imprecise.** It said the guest's
`__wpk_fork_module_state_table_generation_addr` import is "the address of a
FENCE rather than of the archive." True, and misleading: `archive.rs:396`
publishes that fence at `header.address + ARCHIVE_GENERATION_OFFSET`, where
`ARCHIVE_GENERATION_OFFSET = 40`. The fence is INSIDE the header. So

    head = generation_addr - 40

and the module could recover the head with no host call at all, by importing
that one global.

That was not taken, deliberately. It trades one host EXPORT call for one host
IMPORT obligation, and `docs/surface-budget.json`'s own `forkModuleHostImports`
rationale says the import obligation is the more expensive of the two per unit:
every host must implement an import, while an export call costs one line at one
call site. So the ceiling raise (`forkModuleHostDriveEntries` 24 → 25) buys the
cheaper of two real options rather than paying for an absence of thought. The
swap is a drop-in if the economics are ever judged differently.

**One guard could not be made to fail.** The bounds check in the module's
guest-memory archive view is unreachable: `decode_dylink_archive` validates
every range against the same `len()` first, so no perturbation of the archive
bytes reaches it. It is kept — the raw-pointer slice it protects is UB on an
out-of-range address, not a trap — but it is now LABELLED as a backstop rather
than left looking like a tested guard. H-2 says a guard that cannot fail is not
a guard; the honest response is to say so in the code, not to delete a real
protection or to pretend the perturbation passed.

**A contract change fell out of it.** The module now carries its own table
elements — the archive decoder's trait vtable — so its `dylink.0` table size is
no longer zero and an empty `__indirect_function_table` import is a LinkError.
Both production hosts were already right (host-native derives the table type
from the import itself; the TypeScript layer reads `dylink.0`), so this only
moved the two V8 fixtures. Worth recording because it is the first time the
module's own table footprint became part of what a host must get right.

## §49 — The table-mutation group: four imports, and probably no new host obligation

The eight remaining unserved guest imports are:

| Import | Group |
|---|---|
| `__wpk_fork_module_state_table_mutation_begin` | table mutation |
| `__wpk_fork_module_state_table_mutation_commit` | table mutation |
| `__wpk_fork_module_state_table_mutation_abort` | table mutation |
| `__wpk_fork_module_state_table_state_owned` | table mutation |
| `__wpk_fork_ref_encode_funcref` | reference codec |
| `__wpk_fork_ref_provenance_externref` | reference codec |
| `__wpk_fork_ref_exn_ingress_throw` | must-throw (deferred by the maintainer to last) |
| `__wpk_fork_ref_exn_broker_throw_recipe` | must-throw (deferred by the maintainer to last) |

The mutation group is the largest remaining cluster, and it is the natural
continuation of §48: it writes the same archive the reconcile reads.

**What the four do**, from the contract the attic registry spells out:

- `begin() -> i64` — acquire the process writer, apply the latest snapshot, and
  return its exact generation. Ownership lives until commit or abort.
- `commit(activation, first_index, length)` — publish a successful guest
  mutation and release ownership.
- `abort()` — release ownership after a non-mutating failure or no-op.
- `table_state_owned(activation) -> i32` — a query.

**Applying the rule — does any of it have to be host code?**

*Applying the latest snapshot* is the reconcile, which is now in the module
(§48). Done.

*Acquiring the writer* is cross-worker mutual exclusion. The module imports the
guest's SHARED linear memory and already does atomics on its own BSS inside it,
so a lock word is module-reachable. Blocking (`memory.atomic.wait`) is not
emittable from Rust, but that is exactly what the placeholder-import pattern is
for — the same pattern that turned three other imports into local thunks.

*Publishing a mutation* looked like the blocker, because the archive format
carries no allocation cursor: `encode_dylink_archive` takes addresses from its
CALLER, and `plan_dylink_archive` only says how much storage is needed. So
something must allocate.

**But the allocator is not a host capability.** `crates/dylink/src/archive.rs`
documents `HostRequest::AllocateArchive` as "one `SYS_MMAP`-backed block". It is
a syscall, and a table mutation is ordinary runtime rather than mid-fork, so the
guest is free to make it. That puts allocation in reach of the drive table —
the same mechanism that unlocked `__wpk_fork_capture_probe` and
`__wpk_fork_capture_encode`, where the guest's own export is called by the
module through `call_indirect`. The drive table is an obligation hosts already
have; adding a slot to it is additive, because the doc is explicit that it is an
ephemeral runtime binding and not a wire format.

And the encoder is already in Rust: `fork_codec::dylink_archive_encode` has
`plan_dylink_archive` and `encode_dylink_archive`, with a test suite of its own.

So the projected shape is **four imports served, zero new host obligations** —
two new drive slots (a blocking lock acquire, and an archive allocation) rather
than two new host entries. That is better than the reconcile's outcome, which
cost one host entry.

**This is a projection, not a result.** The parts proven today are: the
reconcile (landed, §48), the encoder's existence, and the allocator being a
syscall rather than a host call. The parts NOT yet proven are the lock
protocol's exact shape, whether `table_state_owned` needs anything beyond
decoded archive state, and whether a mutation can be published without
re-encoding records that did not change. Each is a real question and none of
them is answered by reading a comment.

## §50 — Three of the eight are floor, and the reason is the same each time

Applying the must-this-be-host question to the rest of §49's list gives the
lane a visible end. Three entries are floor, and all three fail for one reason:
**they require looking INSIDE a reference, or comparing two of them, and the
module holds neither the objects nor a primitive that can.**

### `__wpk_fork_ref_provenance_externref(externref) -> externref`

The host body does three things, and every one of them reaches into the value:

1. `typeof value !== "object" && typeof value !== "function"` — reject
   primitives. Wasm cannot ask an `externref` what it is.
2. `externrefs.tryEncode(value)` — read the handle off a self-describing
   `ForkExternrefToken`. That is a property read on a JS object.
3. `externrefProvenance.register(value, handle)` — store it in a WeakMap keyed
   by the value's IDENTITY.

This is exactly the floor the campaign already names: externref identity plus
handle→externref materialization. It is where the floor was always going to be;
this entry is not a gap, it is the floor being visible.

### `__wpk_fork_ref_encode_funcref(funcref) -> i32`

Given a `funcref`, produce a recipe — which means finding the function's
ordinal in the merged catalog. The module IMPORTS that catalog, so it can read
every slot. What it cannot do is compare: `ref.eq` validates only on `eqref`,
and `funcref` is a disjoint hierarchy, so there is no instruction that answers
"is this the same function as that one." The host's existing
`__wpk_fork_host_ref_identity` cannot be widened to help, because it takes
`anyref` and a wasm import has exactly one signature.

So this needs a funcref-identity capability. It could be added as a new host
import — but that trades one guest import the host serves for one host import
the host must serve, both of them a one-line map lookup, and moves no logic.
**Not worth doing**, and recorded so the next reader does not re-derive it.

### `__wpk_fork_module_state_table_state_owned(owner) -> i32`

This one surprised me, because the query itself is trivial: read a per-owner
`stateOwner` flag. The module already serves its three sibling imports
(`table_dirty_mark` / `_count` / `_page`) and already owns the dirty-page state
they read.

The flag is the problem, not the query. `bindTableCoordinates` elects the owner
by grouping coordinates **by the identity of the `WebAssembly.Table` object** —
a WeakMap keyed on the Table itself. Which `(activation, owner)` pairs name one
PHYSICAL table is observable only by whoever holds those objects. Wasm has no
`table.eq`, and the module does not import the activations' tables at all, so
it cannot observe the aliasing even indirectly.

The module could serve the query if the host seeded the election — but that is
one new host seeding entry to remove one guest import, moving a boolean and no
logic. Worse than the reconcile trade in §48, where the host entry bought three
pieces of real logic. **Not worth doing.**

### Where that leaves the lane

| Remaining import | Verdict |
|---|---|
| `table_mutation_begin` | serveable (§49) |
| `table_mutation_commit` | serveable (§49) |
| `table_mutation_abort` | serveable (§49) |
| `table_state_owned` | FLOOR — table object identity |
| `ref_encode_funcref` | FLOOR — funcref identity |
| `ref_provenance_externref` | FLOOR — externref introspection + identity |
| `ref_exn_ingress_throw` | maintainer-deferred to last |
| `ref_exn_broker_throw_recipe` | maintainer-deferred to last |

So the reachable floor for `forkGuestImportsUnserved` is **5**, of which two are
deferred by decision rather than by capability, and the remaining implementable
work in this dimension is the three mutation entries.

A note on how this was reached, because §47 is recent: each verdict above is
from the host body's own statements or the wasm type system, not from a name or
a comment. The two "not worth doing" verdicts are cost arguments, not capability
ones — they are the maintainer's to overturn if the accounting is judged
differently, and nothing about them is irreversible.

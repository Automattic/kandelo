# Torque CC Backend Phase 10 — TFC Bridge Cluster + arguments[i] + Ship PromiseTry

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The plan is partially open-ended — Task 10.0 establishes the actual blocker list before tasks 10.1+ commit to specific shim shapes.

**Goal:** Ship `PromiseTry` (`promise-try.tq`) as the first real-world combined catch_block + varargs forcing target. Phase 9.5 deferred this because of an estimated 5+ Phase-10+ blockers (TFC bridges, `arguments[i]` shim, MessageTemplate-arg ThrowTypeError shim, NewRestArgumentsFromArguments macro, possibly NewPromiseCapability dispatch). Phase 9.7's bridge-refactor pattern (~5 LoC of `Object::*` / `Factory::*` API delegation per bridge) makes the cluster much smaller than originally feared.

**Architecture (target):**
- One `GetArgumentValue(Arguments, intptr_t): JSAny` shim wrapping `BuiltinArguments::at<JSAny>(i+1)`. Phase 9B's Arguments-struct prelude left `frame`/`base` as `Address{}` placeholders; Phase 10 rewires them to real `BuiltinArguments` accessors.
- Hand-written inline bridges for whatever TFC callees PromiseTry resolves to (`Builtin_Call`, `Builtin_NewPromiseCapability`, etc.) — each ~5-15 LoC of V8-API delegation following Phase 9.7's pattern.
- A MessageTemplate-arg `ThrowTypeError` shim if the `Cast<JSReceiver>(receiver) otherwise ThrowTypeError(MessageTemplate::kCalledOnNonObject, 'Promise.try')` site triggers it (Phase 9A's catch-block fixture sidestepped this surface; we now need it).
- Possibly a struct-field-write shim for `capability.reject` etc. (Phase 5 already handles struct-field READ via UnsafeCast; writes may or may not surface).
- Real cctest + d8-smoke + mjsunit coverage for `Promise.try(...)`.

**Tech Stack:** Same as Phase 9 — V8 Torque (C++), Torque-generated C++, d8, gtest (cctest), bash. No wasm-posix-kernel changes.

---

## Critical context for the new session

**Read these first:**

1. **MEMORY.md** — `/Users/brandon/.claude/projects/-Users-brandon-ai-src-wasm-posix-kernel/memory/MEMORY.md`. Current state, user preferences, kernel-suite gates.
2. **`examples/libs/nodejs/verification.md`** — full verification log Phase 4 → 9.7. Read **§"Phase 9.5 — DEFERRED"** specifically — it lists the suspected Phase-10 blockers based on PromiseTry triage.
3. **`docs/plans/2026-04-25-torque-cc-backend-phase9.md`** — Phase 9 plan, especially the methodology (synthetic fixture → emitter lift → cctest → push). Phase 10 follows the same shape but on a real-world target instead of synthetic.
4. **`examples/libs/nodejs/patches/v8-torque-cc-builtins.patch`** — 7693-line consolidated patch (note: `wc -l` includes commit metadata; real cumulative source diff is ~2706 lines / 60 deletions across 25 files vs upstream V8). Don't manually edit.

**State pointers:**
- Worktree: `/Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend`
- Branch: `torque-cc-backend` @ `3a8838ffd` (Phase 9.7 tip, pushed). PR #306.
- Checkpoint branch: `torque-cc-backend-phase9-checkpoint` @ `5b2e863db` on origin (fallback if Phase 10 surfaces unrecoverable issues — `git reset --hard origin/torque-cc-backend-phase9-checkpoint` rolls back Phase 9.7 to the catch_block + varargs synthetic state).
- Clone: `examples/libs/nodejs/build/node` @ `7622d817`. 93 commits on top of upstream `9fe7634c`.

**Critical gotchas from prior phases (don't re-discover the hard way):**

- **Two torque binaries.** The fixture harness uses `out/Release.baseline/torque`. The host build uses `out/Release/torque`. Edit `deps/v8/src/torque/implementation-visitor.cc` → rebuild **both** before refreshing fixture goldens, or you'll get stale output (Phase 9.7 lost ~30 minutes to this).

- **Preamble changes drift all 18 fixture goldens.** Any edit to the inline shims emitted into `cc_builtins_preamble` in implementation-visitor.cc affects every kCCBuiltins .cc file. Run `UPDATE_GOLDEN=1 bash examples/libs/nodejs/test/run-torque-fixtures.sh` once, then verify byte-exact second run.

- **Excluding-anchor.** Must remain `8169724e`. The find command excludes `number-tq-csa.cc`, `tail-call-tq-csa.cc`, `catch-block-tq-csa.cc`, `js-varargs-tq-csa.cc` — Phase 10 may need to add `promise-try-tq-csa.cc` to the exclusion list (BUILD.gn add for cctest linkage). Document in verification.md.

- **Two cctest TUs.** `test_torque_cc_builtin.cc` (main) and `test_torque_cc_builtin_helpers.cc` (helpers). The main TU CANNOT include `src/execution/isolate.h` because of the V8/Node tracing-header collision. The helpers TU CAN. Phase 9A's catch-block test routes through the helpers TU for this reason. Phase 10 cctest for PromiseTry should also route through helpers if it touches `i_isolate->...`.

- **Phase 9B left placeholder Arguments-struct base/frame.** `torque_arguments_frame{}` and `torque_arguments_base{}` are `Address{}` (default-zero). For PromiseTry's `arguments[0]` access, these need to be wired to real `BuiltinArguments` accessors. **This is THE main emitter change for Phase 10.**

- **Build cadence.** `ninja -C out/Release torque` is fast (~30s). Full host rebuild via `bash examples/libs/nodejs/build-v8-host-phase5.sh` is 5-15 min incremental, 30-50 min cold. Use `Bash run_in_background: true` + `Monitor` with `until ! pgrep -f "ninja -C out/Release "; do sleep 15; done` (3600000 ms timeout). Don't poll synchronously.

**Verification baseline (Phase 9.7 close):**
- Torque fixtures: 18/18 byte-exact.
- cctest TorqueCcBuiltinTest.*: 16 PASS.
- d8-smoke: 26 PASS.
- mjsunit: 2 PASS.
- Excluding-anchor: `8169724e`.
- Cumulative source diff vs upstream V8: 2706 ins / 60 del across 25 files.
- format-patch line count: 7693.
- Kernel suites (cargo / vitest / libc-test / POSIX / ABI): 0 delta vs Phase 8.1 baseline.

---

## Hard stops (escalate to user, do NOT silently work around)

- Excluding-anchor `8169724e` drifts (kCSA path leaked into; means an emitter change escaped the `is_cc_builtins_` gate).
- Any of the 16 existing cctests regress.
- A single new bridge requires more than 50 LoC of C++ (Phase 9.7's pattern targets 5-15; if a bridge balloons, the underlying API choice is wrong).
- More than 5 NEW TFC bridges surface during PromiseTry whitelisting. STOP, ship Phase 10 with whatever subset works, defer the rest.
- A Phase-11+ deferral fires (multi-result PairT return, struct-field WRITE on PromiseCapability, JS-linkage CallBuiltin tail-call, etc.). STOP, document in verification.md, downscope.
- `Builtin_Call` requires variadic forwarding through `Execution::Call` and the implementation isn't obvious from V8's existing call sites — STOP and ask for guidance.
- Any wasm-posix-kernel suite regresses.

## Phase 10 close criteria

ALL of the following must hold:

1. `PromiseTry` is in the build-script default WHITELIST.
2. cctest: ≥17 PASS (Phase 9.7's 16 + new `JsPromiseTryDispatch` or similar).
3. d8-smoke: ≥28 PASS (Phase 9.7's 26 + ≥2 Promise.try probes).
4. mjsunit: optional — only if a self-contained mjsunit file exists for Promise.try. Otherwise skip.
5. Torque fixtures: 18/18 byte-exact. (Phase 10 does NOT add a synthetic fixture — PromiseTry IS the forcing target.)
6. Excluding-anchor `8169724e` (now also excludes `promise-try-tq-csa.cc`).
7. Patch growth bounded: ≤2000 cumulative lines. (Phase 9 added ~2200 over Phase 6.1; Phase 10 should add less.)
8. `verification.md` Phase 10 Summary documenting the bridge cluster shipped.
9. wasm-posix-kernel suites pass per CLAUDE.md (expected 0 delta — clone-side scope only).

---

## Task 10.0: Triage — surface the actual blocker list

**This task does NOT write code.** It establishes Phase 10's actual scope by attempting the build and classifying every error.

**Step 1: Add `PromiseTry` to the WHITELIST.**

Edit `examples/libs/nodejs/build-v8-host-phase5.sh`:

```bash
WHITELIST="${V8_CC_BUILTINS_WHITELIST-...,TorqueCcTest_JsVarargs,PromiseTry}"
```

**Step 2: Add `promise-try.tq` to BUILD.gn?**

PromiseTry's source is already in `deps/v8/src/builtins/promise-try.tq`, which is already in `torque_files` (it's part of stock V8). No BUILD.gn change needed — unlike the synthetic test fixtures, this is a real V8 source.

**Step 3: Build, capture all compile errors.**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
bash examples/libs/nodejs/build-v8-host-phase5.sh > /tmp/phase10-triage.log 2>&1 &
# Monitor wait pattern as documented in critical context.
grep -E "FAILED:|error:" /tmp/phase10-triage.log | head -50
```

**Step 4: Classify every error into one of these buckets.**

| Bucket | Action | Example error |
|---|---|---|
| (a) Trivial macro shim | Add to `runtime-macro-shims.h` | `'NumberConstant' undeclared in TorqueRuntimeMacroShims::CodeStubAssembler` |
| (b) Hand-written TFC bridge | Add to implementation-visitor.cc preamble | `'Builtin_Call_4' undeclared` |
| (c) NamespaceConstant shim | Add to preamble (parallel to True_0 / Undefined_0) | `'PromiseAny_0' undeclared` |
| (d) Emitter gap (preamble field) | Rewire Arguments-struct (one-time emitter change) | `arguments[0]` reads garbage / unreferenced |
| (e) Phase-11+ deferral | Document in verification.md, downscope | catch_block + tail-call + JS-linkage combination |

**Step 5: Report classification to the user.**

Output a markdown table of every error → bucket → estimated fix LoC. The user gates whether to proceed based on this triage. If the total fix surface exceeds the ≤5-bridges / ≤50-LoC-per-bridge / ≤2000-cumulative-lines budget, downscope before writing any code.

If triage looks reasonable (per Phase 9.5's projection, expect ~3-5 (a)-bucket shims + 3-5 (b)-bucket bridges + 1 (d)-bucket emitter rewire), proceed to Tasks 10.1+. The exact shape of those tasks depends on what surfaced — re-plan if needed.

---

## Task 10.1+ (TENTATIVE — depends on Task 10.0 triage)

The default skeleton, to be refined after triage:

### Task 10.1: Arguments-struct base/frame rewire (Phase 9B follow-on)

**File:** `deps/v8/src/torque/implementation-visitor.cc` — the `is_varargs` prelude block from Phase 9B.

**Change:** Replace `Address torque_arguments_frame{};` and `Address torque_arguments_base{};` with real values.

For `base`: probably `args.address_of_first_argument()` or `reinterpret_cast<Address>(args_object)` (verify against V8's `BuiltinArguments` definition in `builtins-utils.h`).

For `frame`: PromiseTry doesn't access `arguments.frame`, so it CAN remain Address{} for Phase 10. If a future target hits it, that's another sub-phase.

**Plus:** add the `GetArgumentValue` macro shim to `runtime-macro-shims.h`:

```cpp
inline Tagged<JSAny> GetArgumentValue(/* Arguments struct */, intptr_t i) {
  // The 4-stack-slot Arguments struct exposes base as the args pointer
  // and length as the receiver-excluding count. Index i+1 in BuiltinArguments
  // (skipping receiver).
  // ...exact implementation depends on how torque represents the struct
  // at this point — verify via the generated -tq-ccbuiltins.cc.
}
```

The macro signature in torque is `extern operator '[]' macro GetArgumentValue(Arguments, intptr): JSAny;` (frame-arguments.tq:18). Our shim implementation reads from BuiltinArguments. Caveat: torque's Arguments struct passes 4 stack slots; the shim receives them in order. May need a struct-by-value parameter.

### Task 10.2: ThrowTypeError(MessageTemplate, JSAny) shim

`Cast<JSReceiver>(receiver) otherwise ThrowTypeError(MessageTemplate::kCalledOnNonObject, 'Promise.try')` lowers to a runtime call. The runtime is `Runtime_ThrowTypeError(int args_length, Address* args_object, Isolate*)`, which our Phase 9A catch-block fixture already linked against. So this might Just Work — but Phase 9A's fixture used `Runtime_ThrowCalledNonCallable` (1 arg), not the multi-arg form. Verify that the multi-arg-MessageTemplate path links from kCCBuiltins emission; if not, the shim is just a torque-side alternate signature declaration (~3 lines).

### Task 10.3: Builtin_GetReflectApply

Per `base.tq:1563-1565`, `GetReflectApply` is a torque MACRO (inlined), not a builtin. It expands to `*NativeContextSlot(ContextSlot::REFLECT_APPLY_INDEX)`. So this might NOT need a bridge at all — the macro's body lowers to a NativeContextSlot read, which becomes a C++ accessor. **Verify in triage.**

If it does turn into a bridge, the implementation is trivial:
```cpp
inline Tagged<JSAny> Builtin_GetReflectApply(Isolate* isolate, Tagged<Context> ctx) {
  USE(ctx);
  return isolate->native_context()->reflect_apply();
}
```

### Task 10.4: Builtin_NewPromiseCapability

V8's API: `Factory::NewPromiseCapability(Handle<JSReceiver>, bool debug_event)` returns `Handle<PromiseCapability>`. Bridge:

```cpp
inline Tagged<PromiseCapability> Builtin_NewPromiseCapability(
    Isolate* isolate, Tagged<Context> context,
    Tagged<JSReceiver> constructor, Tagged<Boolean> debug_event) {
  USE(context);
  bool dbg = IsTrue(debug_event, isolate);
  return *isolate->factory()->NewPromiseCapability(
      Handle<JSReceiver>(constructor, isolate), dbg);
}
```

~10 lines.

### Task 10.5: Builtin_Call cluster (variadic; arity overloads)

Torque emits arity-specific calls (`Builtin_Call_3`, `Builtin_Call_4`, ...). PromiseTry uses 2 sites: `Call(context, callbackfn, Undefined)` (3 args) and `Call(context, GetReflectApply(), Undefined, callbackfn, Undefined, rest)` (6 args). So we need at minimum 3-arg and 6-arg overloads.

Each overload:
```cpp
inline Tagged<JSAny> Builtin_Call_<N>(Isolate* isolate, Tagged<Context>,
                                       Tagged<JSAny> callable,
                                       Tagged<JSAny> receiver,
                                       /* arg0...argN-3 */) {
  HandleScope scope(isolate);
  Handle<Object> callable_h(callable, isolate);
  Handle<Object> receiver_h(receiver, isolate);
  std::vector<Handle<Object>> args = {/* arg0_h, ... */};
  DirectHandle<Object> result;
  if (!Execution::Call(isolate, callable_h, receiver_h, args).ToHandle(&result)) {
    // Exception path — propagated to caller's catch_block via the
    // existing has_exception() check our emitter inserts.
    return UncheckedCast<JSAny>(*isolate->factory()->undefined_value());
  }
  return Cast<JSAny>(*result);
}
```

~15 lines per arity. PromiseTry needs 3-arg + 6-arg → 2 overloads → ~30 lines total.

### Task 10.6: NewRestArgumentsFromArguments

Per the body at line 27: `const rest = NewRestArgumentsFromArguments(arguments, 1);` — this is a torque operation that creates a new array containing arguments[1..]. The implementation in V8 is likely a TFS or runtime function. Triage in Task 10.0 will reveal which.

If it's a runtime: link against existing `Runtime_*` symbol (no shim).
If it's a macro: torque inlines it (no shim).
If it's a TFS/TFC: hand-written bridge (~10-20 LoC) wrapping `Factory::NewJSArrayWithElements` or similar.

### Task 10.7: cctest + d8-smoke + mjsunit

**cctest**: `JsPromiseTryDispatch` mirroring Phase 9B's `JsVarargsAdaptorDispatch`. Bind `Promise.try` (already a real JS API, no BindXxxOnGlobal helper needed). Cases:

```cpp
"Promise.try(() => 42).then(v => v)"  // resolves to 42
"Promise.try(() => { throw new Error('x') }).catch(e => e.message)"  // resolves to 'x'
"Promise.try((a, b) => a + b, 1, 2).then(v => v)"  // resolves to 3
```

d8-smoke: 2-4 probes covering same paths.

mjsunit: skip unless a self-contained `promise-try.js` exists in upstream V8 (mjsunit). Per the plan triage, accept "no mjsunit added" if none exists.

### Task 10.8: Verification.md Summary + push

Mirror Phase 9 / 9.7's verification.md structure. Honest framing on what shipped and what didn't (e.g., if `arguments[i]` read works but `arguments.frame` access still placeholder, document explicitly).

---

## Out-of-scope items — explicitly deferred past Phase 10

- `arguments.frame` / `.base` access for any future target (only `length` and `[i]` are wired by Phase 10).
- Multi-result `PairT` return from CallBuiltin (`cc-generator.cc:567`).
- JS-linkage CallBuiltin tail-call.
- `CallBuiltinPointer` tail-call (matches CSA's own rejection).
- Generator-emitted per-const NamespaceConstant helpers (Phase 6.1 I-1 leaves the pattern).
- `%GetClassMapConstant` fast-path.
- Wasm32 cross-compile of the Torque-CC toolchain.
- Any second real-world target beyond PromiseTry. If Phase 10 ships clean, future phases can add ProxyHasProperty / ArrayOf / ArrayFrom / etc., each as a small follow-on.

---

## Operational tips (Phase 10 specific)

- **Triage commit cadence.** After Task 10.0 triage, write a short "Phase 10 triage" comment to verification.md before starting 10.1. Captures the scope decision.
- **Per-bridge commit pattern.** Each bridge is its own clone-side commit. Keeps the diff readable: "`torque: Builtin_Call_3 bridge for PromiseTry`", "`torque: Builtin_NewPromiseCapability bridge`", etc.
- **Build.gn add for cctest.** PromiseTry is already in `torque_files`, so no add. But the cctest TU may reference `Builtin_PromiseTry` symbol — if so, ensure `promise-try-tq-ccbuiltins.cc` gets compiled into v8_base_without_compiler.a (it should automatically once `PromiseTry` is whitelisted).
- **Patch line check.** `wc -l examples/libs/nodejs/patches/v8-torque-cc-builtins.patch` and `git diff 9fe7634c..HEAD --stat` after each commit. The latter is the honest "code change" metric.

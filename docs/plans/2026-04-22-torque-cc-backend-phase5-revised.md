# Phase 5 (REVISED): Torque CC Backend — Path 1 CPP-ABI Re-emission, `AdaptorWithBuiltinExitFrameN` Dispatch, and First d8 `Array.isArray` Smoke Test

> **STATUS: DRAFT (2026-04-22).** Supersedes Tasks 5.4–5.13 of
> `docs/plans/2026-04-20-torque-cc-backend-phase5.md` (marked
> SUPERSEDED at its top). Tasks 5.1–5.3 of the original plan landed as
> written (baseline capture, d8 build target, Script::Run cctest
> scaffold). Task 5.4 spike concluded that Shapes A and B (Code-object
> trampoline / interpreter bypass) both reduce to the same core
> problem: **V8's embedded interpreter invokes builtins via a
> register-based builtin ABI; our Torque-CC-emitted C++ functions use
> the C ABI.** No wiring change avoids an ABI-translation thunk. V8
> already owns one (`AdaptorWithBuiltinExitFrameN`, `TFC(Adaptor*,
> CppBuiltinAdaptor)` at `deps/v8/src/builtins/builtins-definitions.h:121-126`)
> but it dispatches to a function shaped like the `CPP(Name, …)` macro
> expansion — not the Phase-4 shape. **Path 1** (take V8 at its word:
> re-emit with the CPP ABI, register through `DECL_CPP`, let the
> existing `BuildAdaptor` machinery do the thunking) eliminates
> ABI-thunk work entirely and piggybacks V8's own dispatch. This plan
> implements Path 1.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task.

**Goal:** Make d8 execute `Array.isArray(…)` through V8's interpreter,
dispatched to a Torque-CC-translated C++ implementation via V8's
existing `AdaptorWithBuiltinExitFrame1` machinery. Concretely:
(1) extend Torque's `Visit(Builtin*)` kCCBuiltins emission so
whitelisted JS-linkage builtins emit CPP-ABI functions
(`Address Builtin_<Name>(int, Address*, Isolate*)`) that unpack args
via `BuiltinArguments`; (2) teach Torque's `BUILTIN_LIST_FROM_TORQUE`
emitter at `implementation-visitor.cc:3881-4000` to emit `CPP(Name,
JSParameterCount(N))` instead of `TFJ(Name, …)` for whitelisted
JS-linkage builtins, so V8's static-init pipeline
(`DECL_CPP` → `builtin_metadata[i].data.cpp_entry =
FUNCTION_ADDR(Builtin_<Name>)`; `BUILD_CPP_WITHOUT_JOB` → `BuildAdaptor`)
installs an `AdaptorWithBuiltinExitFrame1` Code object that calls our
function; (3) whitelist `ArrayIsArray` (first V8-tree JS-linkage
target); (4) add one synthetic JS-linkage fixture (`TorqueCcTest_JsReturn`)
to exercise the adaptor pipe before layering in typeswitch + runtime;
(5) prove end-to-end via cctest (`Script::Compile`+`script->Run`) AND
d8 (`./out/Release/d8 -e 'print(Array.isArray([1,2,3]))'`); (6) keep
the CSA replacement ledger scaffold (path-independent infrastructure);
(7) regression-gate on the updated non-ccbuiltins sha
`2224e4db4e95629954def24da8660e7b3b3dd2f1` (Phase-4-tip reality with
the `return.tq` fixture permanently staged in BUILD.gn — NOT the stale
`a5195c02` the superseded plan claimed). Phase 5 (revised) is the
first phase where V8's own machinery invokes our generated code
through its normal dispatch path.

**Architecture:** Unchanged Phase 1–4 layering. V8 edits continue as
commits on the Node.js clone at `examples/libs/nodejs/build/node/`,
re-exported into
`examples/libs/nodejs/patches/v8-torque-cc-builtins.patch`. The
worktree holds plan + fixtures + harness + build scripts +
verification log + CSA replacement ledger. New surface area in Phase 5
(revised):

- **CPP-ABI emission for whitelisted JS-linkage builtins** in
  `Visit(Builtin*)`'s kCCBuiltins branch. Today the branch emits
  `// (JS linkage deferred)` for JS-linkage builtins
  (`implementation-visitor.cc:625-633`). Phase 5 (revised) replaces
  that comment with real emission that matches the `BUILTIN(Name,
  …)`-macro expansion at `deps/v8/src/builtins/builtins-utils.h:99-153`:

  ```cpp
  Address Builtin_<Name>(int args_length, Address* args_object, Isolate* isolate) {
    DCHECK(isolate->context().is_null() || IsContext(isolate->context()));
    BuiltinArguments args(args_length, args_object);
    HandleScope scope(isolate);
    // Implicit-parameter bridging (context/receiver/newTarget/target):
    Tagged<NativeContext> context = Cast<NativeContext>(isolate->context());  USE(context);
    Tagged<JSAny> receiver = Cast<JSAny>(*args.receiver());                    USE(receiver);
    // Explicit parameters unpacked by index:
    Tagged<JSAny> arg = Cast<JSAny>(args[0]);                                  USE(arg);
    // <torque parameterN bridge lines — same pattern as Phase 4>
    // <Torque CFG lowered through CCGenerator::EmitGraph>
    return <result>.ptr();
  }
  ```

  Implicit parameter sourcing — unlike the CSA path
  (`implementation-visitor.cc:731-836`) that reads from
  `Descriptor::k{Context,Receiver,JSNewTarget,JSTarget,JSDispatchHandle}`
  registers, the CPP path sources them from:
  - `context` → `isolate->context()` (DCHECK-guaranteed non-null/Context
    by `BUILTIN_NO_RCS` preamble; see `builtins-utils.h:141`).
  - `receiver` → `args.receiver()` (Handle-unwrapped for Torque's
    `Tagged<JSAny>` shape).
  - `newTarget` → `args.new_target()` (Handle-unwrapped).
  - `target` → `args.target()` (Handle-unwrapped).
  - `dispatchHandle` → `InvalidDispatchHandleConstant()` (V8 13.6.233
    lite-mode without leaptiering — mirrors `implementation-visitor.cc:815-818`
    CSA fallthrough).

- **Torque-side `TFJ` → `CPP` swap** in
  `GenerateBuiltinDefinitionsAndInterfaceDescriptors` at
  `implementation-visitor.cc:3881-4000`. Torque already picks
  `TFC(...)` vs `TFJ(...)` based on `IsStub()` / `IsJavaScript()`
  (lines 3903–3974). Phase 5 adds a third arm: if the builtin is
  JS-linkage AND the external name is in the cc-builtins whitelist,
  emit `CPP(<Name>, JSParameterCount(<N>))` instead of `TFJ(<Name>,
  JSParameterCount(<N>), kReceiver, <arg names>)`. **This is the
  single point where V8's static-init pipeline learns that our
  function is CPP-shaped.** Everything downstream
  (`DECL_CPP` static-init of `builtin_metadata[i].data.cpp_entry`,
  `FUNCTION_ADDR(Builtin_ArrayIsArray)` resolution at link time,
  `BUILD_CPP_WITHOUT_JOB` at setup time, `BuildAdaptor(isolate,
  Builtin::kArrayIsArray, FUNCTION_ADDR(...), "ArrayIsArray")` emitting
  an `AdaptorWithBuiltinExitFrame1` Code object into the embedded
  snapshot, `SimpleInstallFunction(…, Builtin::kArrayIsArray, 1,
  kAdapt)` at bootstrap time installing that Code as the `isArray`
  property on `Array`) is already correct for CPP builtins — zero
  `builtins.cc` / `builtins.h` / `setup-builtins-internal.cc` edits
  needed.

- **Phase 4's `Builtins::TorqueCcEntryOf` + `builtins-cc-table.inc`
  dispatch remain in place, unchanged**, and continue to serve
  stub-linkage Torque-CC builtins (the Phase-4 target set:
  `TorqueCcTest_Return` and any future stub-linkage fixtures). Path 1
  is additive — JS-linkage uses the CPP pipeline; stub-linkage keeps
  using `TorqueCcEntryOf`. The two mechanisms coexist because a
  whitelisted builtin is always exactly one of JS-linkage or
  stub-linkage (`Builtin::IsJavaScript()` vs `Builtin::IsStub()`), and
  the kCCBuiltins emission path dispatches on that bit.

- **Updated CSA replacement ledger README.** The Task 5.5 scaffold
  from the superseded plan stays (it's path-independent
  infrastructure). The "how to register a shim" section is rewritten
  for Path 1: a hand-written shim for a JS-linkage CSA-only builtin
  follows the same `Address Builtin_<Name>(int, Address*, Isolate*)`
  shape our Torque emission produces, and the `TFJ → CPP` swap
  happens at the hand-edit level (since there's no Torque source to
  drive auto-generation).

- **Two new cctest cases + one d8 smoke test.** The Phase-5-revised
  success gate is three-pronged:
  1. `TorqueCcBuiltinTest.JsReturnAdaptorDispatch` — invokes our
     synthetic `TorqueCcTest_JsReturn` JS-linkage builtin via
     `v8::Function::New(ctx, callback-adapter)` or the equivalent
     internal `Execution::Call` path, proving the CPP adaptor
     correctly bridges from BuiltinExitFrame to our C++ function.
  2. `TorqueCcBuiltinTest.ScriptRunArrayIsArray` — compiles
     `Array.isArray([1,2,3])`, `Array.isArray(42)`, `Array.isArray({})`
     via `Script::Compile` + `script->Run(ctx)`, asserts true/false/false.
  3. d8 smoke test — shell invocation of
     `./out/Release/d8 -e 'print(Array.isArray([1,2,3])); print(Array.isArray(42)); print(Array.isArray({}))'`
     with exit 0 and exact stdout `true\nfalse\nfalse\n`.

**Tech Stack:** same as Phase 4 — V8 13.6.233.17 (vendored at
`deps/v8/`), host clang, GN+ninja for V8, gyp+ninja for Node.js,
gtest for cctest. New for Phase 5 (revised): V8's `BuiltinArguments`
+ `HandleScope` from `src/builtins/builtins-utils.h` +
`src/builtins/builtins-utils-inl.h`;
`Runtime::Call<Runtime::kArrayIsArray>(isolate, arg)` invocation
machinery (`src/runtime/runtime-array.cc:190`); `Execution::Call`
(`src/execution/execution.h`) for invoking a CPP-linkage builtin from
cctest code.

**Torque binary location (UNCHANGED):** `out/Release.baseline/torque`.
Rebuild after any torque source change:
`ninja -C out/Release.baseline torque`.

**Stock `.tq` file list (UNCHANGED):**
`grep -oE '"(src|test|third_party)/[^"]*\.tq"' deps/v8/BUILD.gn |
tr -d '"' | sort -u` — 245 files.

**Branch / worktree / PR policy (UNCHANGED from original Phase 5):**
- Worktree: `/Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend`.
- Branch: `torque-cc-backend` (PR #306, OPEN, stacked commits — do NOT
  open a new PR; do NOT rebase onto main).
- Worktree tip after Phase-5 Tasks 5.1–5.3 + spike-report commit:
  `7c1d9f13e` (3 commits ahead of `origin/torque-cc-backend`).
- V8 clone tip after Phase-5 Tasks 5.1–5.3: `305050d4`. (42-commit
  consolidated patch on clone base `9fe7634c`, 2898 lines; updated by
  Task 5.3's Script::Run scaffold commit so final reported count is
  **43 commits / 2898 lines**.) Re-verify before starting Task 5.1.
- Re-export the consolidated patch at every commit that touches the V8
  clone: `cd build/node && git format-patch 9fe7634c..HEAD --stdout >
  ../../patches/v8-torque-cc-builtins.patch`. Commit count grows by
  ~one per V8 edit.
- V8 clone commit identity is `build@wasm-posix-kernel.local`;
  worktree commits use default identity. Long-standing invariant.

**Regression floor (MUST be preserved):**
- **Non-whitelisted torque output sha (updated):**
  `2224e4db4e95629954def24da8660e7b3b3dd2f1`. This is the Phase-4-tip
  reality AFTER `return.tq` was permanently staged under
  `deps/v8/test/torque-cc-fixtures/` (clone commit `8c5e91c0`) and its
  file listing added to BUILD.gn. The superseded plan's claim of
  `a5195c02…` is stale — it pre-dates the stage commit. See
  `/tmp/phase5-baseline-metadata.txt` from the superseded Phase-5
  session for provenance.
- **13-fixture harness:** all 13 goldens (`call-builtin`,
  `call-builtin-pointer`, `call-csa-macro-and-branch`, `call-runtime`,
  `call-torque-macro`, `goto-external`, `make-lazy-node`,
  `namespace-constant`, `push-builtin-pointer`, `push-uninitialized`,
  `return`, `store-bit-field`, `store-reference`) MUST still pass
  byte-exact diffs. All 13 are stub-linkage — Path 1's emission change
  does NOT touch the stub-linkage branch, so they MUST stay
  byte-identical. Phase 5 (revised) ADDS new JS-linkage goldens for
  the synthetic fixture (Task 5.6) and for `array-isarray.tq` (Task
  5.9).
- **Phase 4 cctest results:** `TorqueCcBuiltinTest.DirectInvocation` +
  `TorqueCcBuiltinTest.DispatchTableLookup` MUST still PASS
  unchanged. Both are stub-linkage tests using
  `Builtins::TorqueCcEntryOf`; Phase 5 preserves that mechanism.
- **Task 5.3 cctest result:** `TorqueCcBuiltinTest.Phase5ScriptRunSmoke`
  (pure-interpreter `1+2` run, landed via clone commit at tip after
  Task 5.3) MUST still PASS.
- **Phase 5 commit count on V8 clone (baseline):** 43 commits on top
  of `9fe7634c`. Phase 5 (revised) grows the count by roughly one per
  V8 edit; final count recorded in Phase 5 Summary.

**Invariants (do not break):**
- Stock V8 builtins (anything not in the whitelist) continue to hit
  the Phase 1 comment-stub path in `Visit(Builtin*)`. Non-whitelisted
  stock-V8-tree torque output stays byte-identical to
  `2224e4db4e95629954def24da8660e7b3b3dd2f1`.
- Torque's `BUILTIN_LIST_FROM_TORQUE` emits `TFC(...)` for stub
  builtins and `TFJ(...)` for JS-linkage builtins NOT in the
  whitelist — existing behavior. Only whitelisted JS-linkage builtins
  get re-classed to `CPP(...)`.
- The kCSA / kCC / kCCDebug passes stay byte-identical
  (the non-ccbuiltins sha gate).
- `Builtins::TorqueCcEntryOf` + `builtins-cc-table.inc` +
  Phase-4 stub-linkage emission all stay unchanged.
- `catch_block` stays `ReportError` unless a Phase 5 task
  specifically finds a smoke test can't progress without it (same
  discipline Phase 4 used).
- `TailCallInstruction` from `CallBuiltin` / `CallBuiltinPointer`
  stays `ReportError`. First smoke-test targets don't tail-call.
- Struct-typed label values: stays `ReportError`. None of Phase 5's
  planned fixtures (`TorqueCcTest_JsReturn`, `ArrayIsArray`) use
  struct labels.
- Every new whitelisted builtin gets a fixture + golden file. Same
  rule as every prior phase.
- Every V8 edit lands as a commit on the Node.js clone; worktree
  holds fixtures, harness, verification.md, consolidated patch,
  Phase 5 build script, csa-builtins/ ledger, and this plan. Never
  hand-edit the patch file — re-export with `git format-patch`.

**Out of scope for Phase 5 (revised)** (explicit):
- Tail-calls from `CallBuiltin` / `CallBuiltinPointer`. Stays
  `ReportError`.
- Runtime exception handling via `catch_block`. Stays `ReportError`
  unless a target smoke test cannot progress without it (escalation
  path: revisit Phase 5 scope with the user; do not implement
  silently).
- Struct-typed label values. Stays `ReportError`.
- mksnapshot integration crossing a translated builtin's **C++ function
  address**. The adaptor itself IS baked into the embedded blob by
  mksnapshot (intended behavior — the adaptor is machine code
  produced via `Generate_Adaptor` which calls through
  `ExternalReference`-equivalent patching at isolate init). If
  mksnapshot actually attempts to serialize `FUNCTION_ADDR(Builtin_<Name>)`
  as a runtime absolute into the blob, escalate — that's a Path 1
  assumption failure and needs a design revisit.
- Wasm32 cross-compile. Phase 7+.
- Full mjsunit. Phase 6.
- More than 1 V8-tree JS-linkage builtin (`ArrayIsArray`) plus 1
  synthetic fixture (`TorqueCcTest_JsReturn`). Additional builtins
  land under Phase 6 mjsunit pressure.
- More than 1 hand-written CSA shim. Scaffold + README only.
- `dispatchHandle` handling beyond the lite-mode fallthrough shape
  (`InvalidDispatchHandleConstant()`). Leaptiering-on builds are
  explicitly a Phase 6+ concern.
- Varargs JS builtins (`builtin Foo(...): ...` with vararg
  `arguments`). `ArrayIsArray` is fixed-args (1 JSAny); the synthetic
  fixture also fixed-args. A future fixture that forces varargs
  triggers a sub-task.

**Phase-4 + Task-5.1-5.3 lessons Phase-5-revised inherits**:

1. **InlineDefinition flag stays.** Phase 4's 0x80 flag on
   `FUNCTION_FLAG_LIST` (distinct from `SetInline()`) marks kCCBuiltins
   macro bodies `inline` without leaking into stock kCC output. The
   Phase 5 (revised) emission for JS-linkage bodies follows the same
   rule — `inline` on the JS-linkage `Builtin_<Name>` function so
   multi-TU ODR stays legal. Check the emission shape includes
   `inline` or is only ever defined in one TU.

2. **Include preamble grows.** Phase 4 added
   `src/base/macros.h`, `src/execution/isolate.h`,
   `src/objects/contexts.h`, `src/objects/smi.h`,
   `src/objects/tagged.h` to `-tq-ccbuiltins.cc`'s top. Phase 5
   (revised) adds for JS-linkage:
   - `src/builtins/builtins-utils-inl.h` — `BuiltinArguments` +
     `receiver()/target()/new_target()` inline accessors.
   - `src/handles/handles.h` + `src/handles/handles-inl.h` —
     `Handle<T>` type usage.
   - `src/execution/arguments-inl.h` — `JavaScriptArguments` base.
   - `src/objects/js-array.h` + `src/objects/js-array-inl.h` — for
     `JSArray` Cast (ArrayIsArray typeswitch).
   - `src/objects/js-proxy.h` + `src/objects/js-proxy-inl.h` — for
     `JSProxy` Cast.
   - `src/runtime/runtime-utils.h` — `Runtime::Call` variants.
   Preamble emission lives at a single point
   (`ImplementationVisitor::GenerateImplementation`); extend, don't
   split.

3. **Default-constructed `Tagged<Context>` does NOT suffice for
   JS-linkage.** Phase 4's `TorqueCcBuiltinTest.DirectInvocation`
   uses `Tagged<Context>{}` because `TorqueCcTest_Return` ignores
   context. `ArrayIsArray` enters `isolate->context()` via the
   adaptor's `BuiltinExitFrame` push; inside our function
   `isolate->context()` is a real NativeContext. Phase 5 cctest
   cases MUST run inside a real `v8::Context::New(isolate_)` scope
   (Task 5.3's Phase5ScriptRunSmoke already proves this is working in
   NodeTestFixture under lite-mode).

4. **Ninja textual-include drift.** `builtins.cc` textually includes
   `torque-generated/builtins-cc-table.inc` (Phase 4 mechanism —
   retained for stub-linkage). The ninja auto-deps don't track it.
   Phase 5's torque emission changes do NOT touch
   `builtins-cc-table.inc` (that file stays scoped to stub-linkage).
   BUT: Phase 5's `BUILTIN_LIST_FROM_TORQUE` addition DOES change
   `torque-generated/builtin-definitions.h` — which IS captured by
   auto-deps (it's a proper `#include`, not a raw textual include).
   So no `touch` workaround needed here. Watch for it anyway if the
   rebuild appears to not pick up the TFJ → CPP swap.

5. **Feature-flag drift.** LITE_MODE / LEAPTIERING / SPARKPLUG /
   MAGLEV / TURBOFAN / INTL_SUPPORT defines must stay in sync across
   cctest / libv8 / mksnapshot / d8. Phase 4's Task 4.9 surfaced this
   as a `Builtin` enum offset mismatch. Phase 5 (revised) adds no new
   flags but DOES add d8 as a build target — Task 5.0 re-verifies the
   d8 binary sees the same `BUILTIN_LIST` count as mksnapshot and
   cctest.

6. **Phase 5 Task 5.3's Script::Compile+Run harness is the fixture
   template.** It already proves `v8::Context::New(isolate_)` works,
   the interpreter dispatches through
   `isolate_->builtin_table()`, and
   `Script::Compile(ctx, source)` + `script->Run(ctx)` round-trips
   cleanly under lite-mode + CSS. New cctest cases in this plan follow
   that exact setup — Task 5.10 wraps the ArrayIsArray invocations in
   the same shape.

---

## Design decisions (answered, not deferred)

**Q1 — Kind propagation.** Reuse `Builtins::Kind::CPP`. No new
`kTorqueCc` kind; no runtime kind override. Rationale: (a) zero
Kind-switch surgery — 12+ sites across
`builtins.cc`/`builtins.h`/`builtin-snapshot-utils.cc` each switch on
Kind; adding a new enum value costs 12 mechanical arms that all mean
"treat exactly like CPP." (b) `IsCpp(Builtin)` can't distinguish
hand-written CPP from Torque-translated CPP — this is FINE, since they
share the ABI and share every downstream code path (bootstrap install,
adaptor codegen, CallInterfaceDescriptorFor, serializer treatment).
(c) Phase 4's `TorqueCcEntryOf` mechanism stays scoped to stub-linkage
and keeps its distinct identity from `CppEntryOf`; the two don't fight.
Trade-off: observability — kind-introspection tools (`d8 --print-code`
etc.) will report our ArrayIsArray as "CPP" not "TorqueCC." Acceptable.

**Q2 — Bootstrap install.** The `DECL_CPP` macro at `builtins.cc:72` is
the canonical entry point: `{#Name, Builtins::CPP,
{FUNCTION_ADDR(Builtin_##Name)}}`. Gets populated at **static-init
time** because `builtin_metadata[]` is a constexpr array and
`FUNCTION_ADDR` is a link-time constant. At **setup time**
(`SetupBuiltinsInternal` — runs at mksnapshot time to bake the
embedded blob), `BUILD_CPP_WITHOUT_JOB` at
`setup-builtins-internal.cc:405` calls `BuildAdaptor(isolate,
Builtin::k<Name>, FUNCTION_ADDR(Builtin_<Name>), "<Name>")` which emits
an `AdaptorWithBuiltinExitFrameN` Code object (N = formal parameter
count; for ArrayIsArray, N=1). The adaptor sets up a
`BuiltinExitFrame`, marshals JS-calling-convention registers into the
`(int args_length, Address* args_object, Isolate* isolate)` triple,
and invokes `FUNCTION_ADDR(Builtin_ArrayIsArray)` via indirect call.
At **isolate init time** the baked adaptor's `instruction_start`
becomes the entry point for `Builtin::kArrayIsArray` in
`isolate_->builtin_table()`. The bootstrapper's
`SimpleInstallFunction(isolate_, array_function, "isArray",
Builtin::kArrayIsArray, 1, kAdapt)` at `bootstrapper.cc:2543-2544` is
unchanged — it reads `Builtin::code(Builtin::kArrayIsArray)` and
installs the adaptor Code as `Array.isArray`'s backing code. Zero
edits to `bootstrapper.cc`; zero edits to `builtins.cc`;
`FUNCTION_ADDR(Builtin_ArrayIsArray)` resolves to our torque-emitted
function via standard link-time symbol resolution (matching the
forward-declaration from `BUILTIN_LIST_C(FORWARD_DECLARE)` at
`builtins.cc:30-33`).

Mechanism for **how torque knows to flip TFJ → CPP:** Torque's
`GenerateBuiltinDefinitionsAndInterfaceDescriptors` at
`implementation-visitor.cc:3881-4000` emits the textual
`TFJ(ArrayIsArray, JSParameterCount(1), kReceiver, kArg) \` line into
`torque-generated/builtin-definitions.h`, which is then `#include`d
by `deps/v8/src/builtins/builtins-definitions.h:12`. The emission
decision is at line 3954 (`else` branch — JS-linkage). Phase 5
(revised) adds a whitelist check: if
`GlobalContext::cc_builtins_whitelist().contains(name) &&
builtin->IsJavaScript()`, emit `CPP(<Name>, JSParameterCount(<N>))
\` instead. N is `signature().ExplicitCount()` — same value the `TFJ`
branch already computes. No edits to hand-written V8 source; the
macro expansion and everything downstream follows automatically.

**Q3 — Emission-shape change's effect on 13 goldens.** The
whitelisted-JS-linkage branch is a new emission path. The 13
existing goldens are all stub-linkage
(`call-builtin`/`call-runtime`/`return`/etc. — confirmed by a
separate grep for `javascript` in `test/torque-fixtures/*.tq`:
zero matches). **Zero existing goldens change.** Task 5.1 confirms
this by regenerating all 13 and checksumming them against
post-spike-tip. Any diff from a golden refresh is a regression and
must be investigated before proceeding.

Stub-linkage vs JS-linkage emission in `Visit(Builtin*)`:
- `builtin->IsStub()` → existing Phase 4 emission
  (`implementation-visitor.cc:635-712`; `Tagged<Smi>
  Builtin_Name(Isolate*, Tagged<Context>, Tagged<Smi>)` signature,
  registers via `TorqueCcEntryOf` dispatch table).
- `builtin->IsJavaScript()` → Phase 5 revised emission
  (CPP-ABI, BuiltinArguments, `Address(int, Address*, Isolate*)`).

Whitelist check + IsJavaScript check are mutually exclusive with
IsStub check — one or the other fires per builtin.

**Q4 — Phase 4 DirectInvocation cctest fate.** Survives unchanged.
`TorqueCcTest_Return` is stub-linkage
(`Tagged<Smi>(Isolate*, Tagged<Context>, Tagged<Smi>)`). Phase 5
revised emission leaves the stub-linkage branch alone; the
DirectInvocation call site calls the function directly (not via
`Builtin::code`), so nothing about adaptor dispatch matters to it.
`DispatchTableLookup` uses `Builtins::TorqueCcEntryOf` which
continues to resolve `TorqueCcTest_Return`'s entry from
`builtins-cc-table.inc`. Both tests PASS after every Phase-5 commit
that touches torque code — Task 5.N re-verifies.

**Q5 — Golden regeneration.** Non-ccbuiltins sha =
`2224e4db4e95629954def24da8660e7b3b3dd2f1` (updated Phase-4-tip
reality). Stays stable across all of Phase 5 because:
- kCSA / kCC / kCCDebug passes are not touched.
- kCCBuiltins pass's stub-linkage branch is not touched.
- kCCBuiltins pass's JS-linkage-deferred branch IS replaced, but for
  non-whitelisted JS-linkage builtins the new branch still emits a
  comment stub (it only triggers real emission when whitelist
  matches).
- The `BUILTIN_LIST_FROM_TORQUE` emitter IS changed, but only to add a
  third arm for whitelisted-JS-linkage. For any builtin not in the
  whitelist, it emits identically to today (TFJ line).

Each Phase 5 task that touches torque code re-checks the sha via
`find /tmp/torque-baseline-X -type f ! -name '*-tq-ccbuiltins.cc'
-print0 | sort -z | xargs -0 cat | shasum`. If the sha diverges, the
task stops and investigates before committing.

The **ccbuiltins-only sha** is allowed to change at each phase step
(that's where new JS-linkage emissions land). Each Phase 5 task that
adds a whitelisted builtin documents the new ccbuiltins sha so
subsequent tasks have a fresh regression target.

**Q6 — CSA replacement ledger.** Keep the scaffold (Task 5.12 below —
renumbered from the superseded plan's Task 5.5). README's "how to
register a shim" paragraph is rewritten to reflect the two mechanisms:

- **Stub-linkage shim:** hand-write a file under
  `examples/libs/nodejs/csa-builtins/builtins-<group>.cc` matching the
  Phase-4 stub-linkage shape (`Tagged<RetType> Builtin_<Name>(Isolate*,
  Tagged<Context>, …)`). Register via an addition to
  `torque-generated/builtins-cc-table.inc`'s hand-written companion
  list (the mechanism Phase 4 uses for Torque-emitted stubs). No V8
  `builtins-definitions.h` edit needed — stub-linkage builtins are
  already accessed by pointer through `TorqueCcEntryOf`, not through
  the normal Kind dispatch.

- **JS-linkage shim:** hand-write `Address Builtin_<Name>(int,
  Address*, Isolate*)` under `csa-builtins/`. Because there's no
  Torque source to drive auto-generation, the `TFJ → CPP` swap has to
  happen manually: edit `builtins-definitions.h` (the hand-written
  one, NOT the torque-generated include) to list the builtin as
  `CPP(<Name>, JSParameterCount(<N>))`. If the builtin already has a
  `CPP(...)` listing (meaning V8 ships it as a hand-written CPP in the
  first place), no macro-list edit needed — just add the function
  definition in our shim file; `FUNCTION_ADDR(Builtin_<Name>)` will
  resolve to our definition if it's linked in preference to V8's
  (ensure it is via a conditional in `v8.gyp`). For builtins that are
  currently TFJ (hand-written CSA — the common case), replace the TFJ
  listing with our CPP listing.

Phase 5's target is scaffold + README + the mechanisms documented
above; a first shim lands under Phase 6 mjsunit pressure unless a
Task 5.11 d8 invocation forces it earlier.

**Q7 — Escalation triggers.** Non-negotiables:
- Phase 5 task hits `catch_block` / tail-call / struct-label
  requirement → **escalate to user**; do not silently defer or hack
  around. Same rule Phase 4 used.
- `ArrayIsArray`'s translated body pulls in >2 CSA-only dependencies
  (builtins V8 ships as hand-written CSA that get invoked from our
  translated code) → **escalate**. The only legal dependency in
  `ArrayIsArray`'s body is `runtime::ArrayIsArray` (a runtime, not a
  builtin), so this rule triggers if the typeswitch lowering
  unexpectedly emits a `CallBuiltin` for something like
  `IsJSArray(x)` or `IsJSProxy(x)` that resolves to a builtin.
- `BUILTIN_CONVERT_RESULT` macro expansion (`builtins-utils.h:129`)
  proves non-trivial under our emission — the macro casts the
  `Tagged<Object>` result to `Address` for return. Our emission must
  end with `return result.ptr()` not `return result`. If the CPP ABI
  returns anything other than `Address` (per target triple, and
  anti-ABI-drift check at
  `builtins-utils.h:85-93`), escalate.
- mksnapshot tries to serialize `FUNCTION_ADDR(Builtin_<Name>)` into
  the embedded blob as a runtime absolute that won't exist at runtime
  (i.e., produces a relocation error) → **escalate**. Path 1's core
  assumption is that the adaptor machine code holds the absolute
  address and gets installed at isolate init via the existing
  external-ref patching mechanism. If that assumption is false under
  lite-mode, the whole plan needs revisiting.
- Bootstrapper install for `Array.isArray` uses `kAdapt` with formal
  parameter count 1 (`bootstrapper.cc:2543-2544`). Our CPP listing
  must emit `JSParameterCount(1)` to match. If the formal count
  `DCHECK` fires at
  `Builtins::CheckFormalParameterCount(builtin, 1, 2)` (where 2 is
  "1 arg + receiver"), adjust; if it persists, **escalate**.

**Q8 — Out of scope (beyond top-level list above):**
- `dispatchHandle` leaptiering-on path. Under V8 13.6 lite-mode,
  `V8_ENABLE_LEAPTIERING` is false (Phase 0 CSS+jitless build uses
  `v8_jitless=true` which implies leaptiering off). Our emission
  uses the `InvalidDispatchHandleConstant()` fallthrough
  (matches CSA behavior at `implementation-visitor.cc:815-818`).
  Leaptiering-on builds are Phase 6+.
- Varargs JS builtins (`IsVarArgsJavaScript()`). Emission gate:
  `ReportError("Phase 5: varargs JS linkage not yet supported")`. First
  fixture that forces this opens a sub-task.
- Multi-arg fixed JS builtins beyond 1 explicit arg. `ArrayIsArray`
  takes 1 arg. Synthetic `TorqueCcTest_JsReturn` takes 1 arg
  (deliberate; keeps fixture small). A 2-arg JS fixture lands in Phase
  6 if needed for coverage.
- Return types other than `Tagged<Object>` / `Tagged<JSAny>` / `Tagged<Smi>`
  / `Tagged<Boolean>`. JS-linkage ABI always returns `Address`
  (erased from `Tagged<Object>::ptr()`). Torque's return-type to
  `.ptr()`-cast conversion is what our emission must produce. More
  exotic return types (Union / Multireturn) gate on `ReportError`.

---

## Task 5.0: Re-verify post-Task-5.3 tip state and baseline capture

**Context:** The superseded plan's Task 5.1 captured baseline at
Phase-4 tip (worktree `0c1c85890`, clone `2b408bfb`, 42-commit patch).
Since then, Tasks 5.1–5.3 landed on the worktree (tip `7c1d9f13e`,
3 commits ahead of origin) and a commit on the V8 clone (tip
`305050d4`, 43-commit patch). Phase 5 (revised) must not regress any
of: (a) the updated non-ccbuiltins sha, (b) the 13-fixture harness,
(c) the three Phase-4/5 cctest results. Snapshot these at the new tip
so later tasks have regression targets.

**Files:** writes scratch files to `/tmp/`. No commits from this task.

**Step 1: Confirm worktree + clone state at the tips**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git rev-parse HEAD                                  # expect 7c1d9f13e
git log --oneline origin/torque-cc-backend..HEAD    # expect 3 commits ahead
cd examples/libs/nodejs/build/node
git rev-parse HEAD                                  # expect 305050d4
git log --oneline 9fe7634c..HEAD | wc -l            # expect 43
```

If any value differs, stop — the state has drifted since this plan
was written and the regression floor must be re-derived first.

**Step 2: Rebuild the 13-fixture harness; verify all green**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
bash examples/libs/nodejs/test/run-torque-fixtures.sh
# Expected: "13 passed, 0 failed".
```

**Step 3: Rebuild stock tq file list and capture non-whitelisted sha**

```bash
cd examples/libs/nodejs/build/node
TQ_FILES=$(grep -oE '"(src|test|third_party)/[^"]*\.tq"' deps/v8/BUILD.gn \
             | tr -d '"' | sort -u)
echo "$TQ_FILES" | wc -l            # expect 245
rm -rf /tmp/torque-baseline-phase5r
mkdir -p /tmp/torque-baseline-phase5r
echo "$TQ_FILES" | sed 's|[^/]*$||' | sort -u | while read d; do
  mkdir -p "/tmp/torque-baseline-phase5r/$d"
done
./out/Release.baseline/torque \
  -o /tmp/torque-baseline-phase5r \
  -v8-root deps/v8 \
  $TQ_FILES > /tmp/phase5r-baseline.log 2>&1
echo "exit=$?"
find /tmp/torque-baseline-phase5r -type f ! -name '*-tq-ccbuiltins.cc' \
  -print0 | sort -z | xargs -0 cat | shasum
# Expected: 2224e4db4e95629954def24da8660e7b3b3dd2f1
```

If the sha differs, stop — baseline drifted. Investigate.

**Step 4: Capture ccbuiltins-only sha for surgical later diffs**

```bash
find /tmp/torque-baseline-phase5r -type f -name '*-tq-ccbuiltins.cc' \
  -print0 | sort -z | xargs -0 cat | shasum \
  > /tmp/torque-baseline-phase5r-ccb.sum
cat /tmp/torque-baseline-phase5r-ccb.sum
```

No commit — measurement only. Record the value in
`/tmp/phase5r-baseline-metadata.txt`.

**Step 5: Verify the three cctest cases (if cctest binary present)**

```bash
CCTEST="./out/Release/cctest"
if [ -x "$CCTEST" ]; then
  "$CCTEST" --gtest_filter='TorqueCcBuiltinTest.*'
  # Expected: 3 tests PASS (DirectInvocation, DispatchTableLookup,
  # Phase5ScriptRunSmoke).
else
  echo "cctest absent — will rebuild in Task 5.4."
fi
```

**Step 6: Verify d8 binary runs empty-whitelist correctly**

```bash
./out/Release/d8 -e 'print(1+2)'           # expect "3"
./out/Release/d8 -e 'print("hi")'           # expect "hi"
./out/Release/d8 -e 'print([1,2,3].length)' # expect "3"
```

Confirms that Task 5.2 (d8 build script) still produces a working
binary with the current patch + empty whitelist. If any fails,
escalate before proceeding.

**Step 7: Record baseline metadata**

No commit. Write `/tmp/phase5r-baseline-metadata.txt`:
- Worktree tip: `7c1d9f13e`
- Clone tip: `305050d4`
- Patch commit count: 43
- Non-ccbuiltins sha: `2224e4db4e95629954def24da8660e7b3b3dd2f1`
- ccbuiltins sha: `<value from Step 4>`
- Harness: 13/13 passing
- cctest: 3/3 passing
- d8 empty-whitelist smoke: passing

---

## Task 5.1: Spike — confirm Path 1 mechanism end-to-end before building emission

**Context:** Task 5.4 spike established Path 1 as the V8-intent-preserving
choice at the concept level (`verification.md` "Phase 5 Spike —
Interpreter Dispatch"). This spike confirms the concrete plumbing:
(1) torque's `BUILTIN_LIST_FROM_TORQUE` emitter can be taught to emit
`CPP(...)` instead of `TFJ(...)` for whitelisted names, and the
downstream `DECL_CPP` static-init path accepts it cleanly; (2) a
minimal hand-written `Address Builtin_X(int, Address*, Isolate*)`
function gets installed as a `CPP` builtin via the existing
`BuildAdaptor` pipeline at mksnapshot time; (3) `Builtin::code(X)`
returns the adaptor Code, the adaptor invokes our function at runtime,
and the result flows through `BUILTIN_CONVERT_RESULT`.

**Why a spike instead of jumping to emission:** Path 1's viability
hinges on assumptions about V8's static-init + mksnapshot pipeline
under lite-mode. Better to prove the skeleton works with a hand-crafted
5-line function before layering Torque IR lowering on top. Spike
outcome is a decision: proceed with Task 5.2 (real emission) OR
re-scope the plan.

**Files:** no commits. Writes findings to
`examples/libs/nodejs/verification.md` under a new `## Phase 5 Spike —
Path 1 Plumbing (Task 5.1-revised)` heading.

**Step 1: Hand-write a minimal CPP builtin in `deps/v8/src/builtins/builtins-torquecc-spike.cc`**

(Clone-side, not worktree; this is the spike — delete before committing
to the branch.)

```cpp
// deps/v8/src/builtins/builtins-torquecc-spike.cc
#include "src/builtins/builtins-utils-inl.h"
#include "src/builtins/builtins.h"
#include "src/execution/isolate.h"
#include "src/objects/objects.h"

namespace v8::internal {

// Matches BUILTIN_LIST_C's FORWARD_DECLARE signature exactly.
Address Builtin_TorqueCcSpike(int args_length, Address* args_object,
                              Isolate* isolate) {
  DCHECK(isolate->context().is_null() || IsContext(isolate->context()));
  BuiltinArguments args(args_length, args_object);
  HandleScope scope(isolate);
  // Return the receiver (simplest possible body).
  return args.receiver()->ptr();
}

}  // namespace v8::internal
```

**Step 2: Register it in `builtins-definitions.h`**

Add to the hand-written list (NOT torque-generated) under the `CPP(...)`
section:

```cpp
// Near line 465 (next to ArrayConcat):
CPP(TorqueCcSpike, JSParameterCount(0))                                      \
```

Also add its `.cc` to the `v8_base_without_compiler` sources (inspect
`BUILD.gn` for the right list).

**Step 3: Build with an empty whitelist and inspect what happens**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
V8_CC_BUILTINS_WHITELIST="" bash examples/libs/nodejs/build-v8-host-phase5.sh
```

Expected: mksnapshot completes, `out/Release/d8` and `out/Release/cctest`
link cleanly. If the build fails at mksnapshot with a serialization
error citing our function address, Path 1's assumption is wrong —
STOP and escalate. If it fails at link time with "undefined symbol
`Builtin_TorqueCcSpike`", the source file was not compiled in — add
it to the right `v8.gyp` / `BUILD.gn` target.

**Step 4: Install it as a JS property via a one-line cctest**

Append a temporary case to `test_torque_cc_builtin.cc` (to be deleted
at Step 7):

```cpp
TEST_F(NodeTestFixture, TorqueCcSpikeAdaptor) {
  v8::HandleScope scope(isolate_);
  v8::Local<v8::Context> ctx = v8::Context::New(isolate_);
  v8::Context::Scope cscope(ctx);
  // Install the builtin as a global property.
  auto fn = v8::Function::New(ctx, nullptr).ToLocalChecked();
  // Actually: bind Builtin::kTorqueCcSpike via BuildJSFunctionFromBuiltin.
  // (Shape TBD in Step 5 — the canonical path is
  //  Factory::NewFunctionForTesting, or SimpleInstallFunction-equivalent.)
  v8::Local<v8::String> src = v8::String::NewFromUtf8Literal(
      isolate_,
      "var __result = TorqueCcSpike.call({tag: 'hello'}); __result.tag;");
  v8::Local<v8::Script> script = v8::Script::Compile(ctx, src).ToLocalChecked();
  v8::Local<v8::Value> r = script->Run(ctx).ToLocalChecked();
  EXPECT_TRUE(r->IsString());
  v8::String::Utf8Value s(isolate_, r);
  EXPECT_STREQ(*s, "hello");
}
```

(Step 5 clarifies the correct binding mechanism.)

**Step 5: Figure out the cleanest install path for a CPP builtin at test time**

Three candidates:
- `v8::Function::New` with a `v8::FunctionCallback` wrapping
  `Execution::Call(isolate_, Builtin::kTorqueCcSpike, …)` — high-fidelity
  but requires the wrapper.
- Allocating a `JSFunction` bound to `Builtin::kTorqueCcSpike` directly
  via `Factory::NewFunctionForTesting` (or the real
  `Factory::NewFunction` with `Builtins::code(Builtin::kTorqueCcSpike)`)
  and adding it as a global property via
  `ctx->Global()->Set(...)`. Closest to what bootstrapper does.
- Extending the `bootstrapper.cc` to install the spike as a real
  global (too invasive for a spike).

Pick the second. Expected:

```cpp
Isolate* i_isolate = reinterpret_cast<Isolate*>(isolate_);
Handle<JSFunction> fn = i_isolate->factory()->NewFunctionForTesting(
    i_isolate->factory()->NewStringFromAsciiChecked("TorqueCcSpike"));
fn->UpdateCode(i_isolate->builtins()->code(Builtin::kTorqueCcSpike));
Handle<JSObject> global = Utils::OpenHandle(*ctx->Global());
JSObject::AddProperty(i_isolate, global,
    i_isolate->factory()->NewStringFromAsciiChecked("TorqueCcSpike"),
    fn, NONE);
```

If `NewFunctionForTesting` doesn't exist in V8 13.6, use
`Factory::NewFunction` with an explicit `SharedFunctionInfo` that has
`kind = FunctionKind::kNormalFunction` and
`builtin_id = Builtin::kTorqueCcSpike`. Find the real signature via
grep — the bootstrapper's `InstallFunctionWithBuiltinId` at
`bootstrapper.cc:605` is the reference.

**Step 6: Run the test; assert the result and trace the call path**

```bash
V8_CC_BUILTINS_WHITELIST="TorqueCcSpike" \
  bash examples/libs/nodejs/build-v8-host-phase5.sh
./out/Release/cctest --gtest_filter='*TorqueCcSpikeAdaptor*'
# Expected: PASS; result == "hello".
```

If it FAILS with a null-pointer at `args.receiver()`, the adaptor is
passing args_object incorrectly — escalate (that's a framework issue).
If it FAILS at compile-time because `Builtin::kTorqueCcSpike` is not
in the enum: verify the `builtins-definitions.h` edit is seen by the
build; re-run `ninja clean v8_snapshot cctest`.

If it PASSES: Path 1 is confirmed viable end-to-end with hand-written
code. Proceed with real Torque emission.

**Step 7: Revert spike + document findings**

Before committing anything:

```bash
cd examples/libs/nodejs/build/node
git checkout -- deps/v8/src/builtins/builtins-definitions.h
rm deps/v8/src/builtins/builtins-torquecc-spike.cc
# Revert the cctest temporary case (or keep if you want to refactor it
# into Task 5.8's real case).
```

Write findings to `verification.md` under `## Phase 5 Spike — Path 1
Plumbing (Task 5.1-revised)`:
- Path 1 viable: yes/no.
- Install mechanism picked for cctest: `NewFunctionForTesting` +
  `UpdateCode` / `JSObject::AddProperty`.
- Surprises / escalations: list any build-system gotchas (source-file
  registration quirks, ninja dep issues, etc.) so later tasks don't
  re-hit them.
- LoC estimate for real emission (Tasks 5.2–5.5): rough.

Commit the verification.md update on the worktree:

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/verification.md
git commit -m "nodejs: Phase 5 (revised) — Task 5.1 spike record

Confirms Path 1's static-init + adaptor pipeline works end-to-end
with a hand-written CPP builtin. Documents the install mechanism
picked for cctest (Factory::NewFunctionForTesting +
JSFunction::UpdateCode + JSObject::AddProperty) and any build-system
quirks Tasks 5.2-5.5 will need to repeat."
```

**Escalation gate.** If Step 6 fails and the fix is non-mechanical
(e.g., mksnapshot can't serialize our function pointer, BuiltinArguments
unpacking is wrong under lite-mode, adaptor codegen is leaptiering-
conditional in a way we can't work around), **stop here** and re-
scope the plan with the user. Path 1 is predicated on V8's public
machinery working under lite-mode without surgery; if that's false
the whole plan needs revisiting.

---

## Task 5.2: Implement Torque-side TFJ → CPP swap in BUILTIN_LIST_FROM_TORQUE emitter

**Context:** Task 5.1 proved that `CPP(Name, JSParameterCount(N))` in
`builtin-definitions.h` triggers the correct `DECL_CPP` + `BuildAdaptor`
pipeline for a hand-written function. Task 5.2 automates the emission:
when a JS-linkage builtin is on the cc-builtins whitelist, torque
emits `CPP(...)` instead of `TFJ(...)`. Single-point change at
`implementation-visitor.cc:3954-3974`.

**Files:**
- Modify (clone): `deps/v8/src/torque/implementation-visitor.cc` —
  add whitelist check in `GenerateBuiltinDefinitionsAndInterfaceDescriptors`.

**Step 1: Read the emission site end-to-end**

```bash
cd examples/libs/nodejs/build/node
sed -n '3881,4000p' deps/v8/src/torque/implementation-visitor.cc
```

Confirm the loop structure: iterates `GlobalContext::AllDeclarables()`,
skips externals, dispatches on `IsStub()` (TFC) vs else (TFJ).

**Step 2: Write a failing test — add a synthetic JS-linkage fixture**

Create `examples/libs/nodejs/test/torque-fixtures/js-return.tq`:

```torque
namespace test_cc {

// Simplest possible JS-linkage builtin: ignores context/receiver,
// returns its single arg unchanged. Exercises CPP emission without
// runtime calls, typeswitches, or non-trivial IR.
javascript builtin TorqueCcTest_JsReturn(
    js-implicit context: NativeContext)(arg: JSAny): JSAny {
  return arg;
}

}  // namespace test_cc
```

Create the expected golden (empty placeholder; will be regenerated):

```bash
touch examples/libs/nodejs/test/torque-fixtures/golden/js-return-tq-ccbuiltins.cc
```

Run the harness; expect FAIL because the golden is empty and real
emission doesn't match.

```bash
bash examples/libs/nodejs/test/run-torque-fixtures.sh
# Expected: "13 passed, 1 failed" or similar — js-return fixture fails
# the byte-exact diff.
```

Actually — at this point, without the Task 5.3 emission change, torque
emits the current "(JS linkage deferred)" comment. Let's use that as
the baseline; this test FAILS because the comment text doesn't match
what we want the real emission to produce. The failure is meaningful
and TDD-compatible: Task 5.3 flips the comment to real emission.

Intermediate update of golden (expected-to-change-in-5.3):

```bash
UPDATE_GOLDEN=1 bash examples/libs/nodejs/test/run-torque-fixtures.sh
# Regenerate — expect "14 passed, 0 failed" (golden = current "deferred"
# comment text).
```

**Step 3: Verify torque emits TFJ for this fixture today**

```bash
cd examples/libs/nodejs/build/node
# Stage the fixture the same way run-torque-fixtures.sh does.
ln -sfn "$(cd ../../test/torque-fixtures && pwd)/js-return.tq" \
  deps/v8/test/phase2-fixtures/js-return.tq

rm -rf /tmp/phase5r-test
mkdir -p /tmp/phase5r-test/test/phase2-fixtures
TQ_FILES=$(grep -oE '"(src|test|third_party)/[^"]*\.tq"' deps/v8/BUILD.gn \
             | tr -d '"' | sort -u)
echo "$TQ_FILES" | sed 's|[^/]*$||' | sort -u | while read d; do
  mkdir -p "/tmp/phase5r-test/$d"
done
./out/Release.baseline/torque \
  --cc-builtins-whitelist=TorqueCcTest_JsReturn \
  -o /tmp/phase5r-test \
  -v8-root deps/v8 \
  $TQ_FILES test/phase2-fixtures/js-return.tq
grep -n 'TorqueCcTest_JsReturn' /tmp/phase5r-test/torque-generated/builtin-definitions.h
# Expected: "TFJ(TorqueCcTest_JsReturn, JSParameterCount(1), kReceiver, kArg) \"
```

Confirm TFJ is what we're replacing.

**Step 4: Add the whitelist check in `GenerateBuiltinDefinitionsAndInterfaceDescriptors`**

Modify `implementation-visitor.cc` at the `else` branch
(around line 3954). Insert BEFORE the `TFJ(` emission:

```cpp
      } else {
        // Phase 5 (revised): JS-linkage builtins on the cc-builtins
        // whitelist are re-classed as CPP so V8's existing CPP
        // adaptor pipeline handles interpreter-to-C-ABI translation.
        const auto& whitelist = GlobalContext::cc_builtins_whitelist();
        if (whitelist.find(builtin->ExternalName()) != whitelist.end()) {
          int parameter_count =
              static_cast<int>(builtin->signature().ExplicitCount());
          builtin_definitions << "CPP(" << builtin->ExternalName()
                              << ", JSParameterCount(" << parameter_count
                              << ")";
        } else {
          builtin_definitions << "TFJ(" << builtin->ExternalName();
          if (builtin->IsVarArgsJavaScript()) {
            builtin_definitions << ", kDontAdaptArgumentsSentinel";
          } else {
            DCHECK(builtin->IsFixedArgsJavaScript());
            int parameter_count =
                static_cast<int>(builtin->signature().ExplicitCount());
            builtin_definitions << ", JSParameterCount(" << parameter_count
                                << ")";
            builtin_definitions << ", kReceiver";
            for (size_t i = builtin->signature().implicit_count;
                 i < builtin->parameter_names().size(); ++i) {
              Identifier* parameter = builtin->parameter_names()[i];
              builtin_definitions << ", k" << CamelifyString(parameter->value);
            }
          }
        }
      }
```

Note: the `CPP(...)` emission deliberately omits the `kReceiver, kArg,
…` arg-name list — CPP entries in `BUILTIN_LIST_C` don't carry
per-arg names (verify via grep of existing CPP entries at
`builtins-definitions.h:464-500`).

**Step 5: Rebuild torque and re-run the probe**

```bash
ninja -C out/Release.baseline torque
./out/Release.baseline/torque \
  --cc-builtins-whitelist=TorqueCcTest_JsReturn \
  -o /tmp/phase5r-test \
  -v8-root deps/v8 \
  $TQ_FILES test/phase2-fixtures/js-return.tq
grep -n 'TorqueCcTest_JsReturn' /tmp/phase5r-test/torque-generated/builtin-definitions.h
# Expected: "CPP(TorqueCcTest_JsReturn, JSParameterCount(1)) \"
```

**Step 6: Verify empty-whitelist regression**

With no whitelist, this must emit identically to pre-change:

```bash
./out/Release.baseline/torque \
  -o /tmp/phase5r-test-nowl \
  -v8-root deps/v8 \
  $TQ_FILES
find /tmp/phase5r-test-nowl -type f ! -name '*-tq-ccbuiltins.cc' \
  -print0 | sort -z | xargs -0 cat | shasum
# Expected: 2224e4db4e95629954def24da8660e7b3b3dd2f1 (unchanged)
```

If the sha changes, the whitelist check emitted something different
from TFJ under the empty-whitelist case — debug before committing.

**Step 7: Commit the torque edit on the clone**

```bash
cd examples/libs/nodejs/build/node
git add deps/v8/src/torque/implementation-visitor.cc
git commit -m "torque: emit CPP(...) for whitelisted JS-linkage builtins

BUILTIN_LIST_FROM_TORQUE's TFJ-emission branch gains a whitelist
check: if the JS-linkage builtin is on the cc-builtins whitelist,
emit CPP(<Name>, JSParameterCount(<N>)) instead of TFJ(<Name>, ...).
This is the single point where V8's static-init pipeline (DECL_CPP,
FUNCTION_ADDR, BUILD_CPP_WITHOUT_JOB, BuildAdaptor) learns that our
Torque-emitted function is CPP-ABI-shaped, letting the existing
AdaptorWithBuiltinExitFrameN machinery handle interpreter-to-C
dispatch without any hand-written bootstrap edits. Non-whitelisted
builtins continue to emit TFJ unchanged; non-ccbuiltins torque output
sha stays 2224e4db... under an empty whitelist."
```

Re-export the consolidated patch:

```bash
cd examples/libs/nodejs/build/node
git format-patch 9fe7634c..HEAD --stdout > ../../patches/v8-torque-cc-builtins.patch
```

**Step 8: Commit the fixture + placeholder golden on the worktree**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/test/torque-fixtures/js-return.tq
git add examples/libs/nodejs/test/torque-fixtures/golden/js-return-tq-ccbuiltins.cc
git add examples/libs/nodejs/patches/v8-torque-cc-builtins.patch
git commit -m "nodejs: Phase 5 (revised) — JS-linkage fixture + torque TFJ→CPP swap

Adds test/torque-fixtures/js-return.tq as the first JS-linkage
synthetic fixture (one JSAny arg, return unchanged). Current golden is
the legacy '(JS linkage deferred)' comment; Task 5.3 flips it to real
emission. Includes re-exported consolidated patch with the torque-side
TFJ→CPP swap change."
```

Note: the golden intentionally represents the PRE-5.3 emission state
at this step; it gets rewritten in Task 5.3 Step 4 once real emission
lands. Alternatively: stage BOTH commits (5.2 + 5.3) as a single atomic
change so the golden never holds the deferred-comment text. Pick based
on reviewability — splitting keeps each commit focused on one concern.

---

## Task 5.3: Real JS-linkage emission in Visit(Builtin*) kCCBuiltins branch

**Context:** Task 5.2 teaches `BUILTIN_LIST_FROM_TORQUE` to announce
our builtins as CPP-shaped to V8's static-init. Task 5.3 supplies the
actual CPP-shaped function bodies that the `FUNCTION_ADDR(...)` lookup
expects at link time. Today the kCCBuiltins branch emits `// (JS
linkage deferred to Phase 3)` and returns for JS-linkage builtins
(`implementation-visitor.cc:625-633`). This task replaces the comment
with real emission matching the `BUILTIN(Name)` macro expansion from
`builtins-utils.h:99-153`.

**Files:**
- Modify (clone): `deps/v8/src/torque/implementation-visitor.cc` —
  replace the JS-linkage-deferred branch (lines 625-633) with real
  emission.

**Step 1: Write the failing test — run the harness, expect diff**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
bash examples/libs/nodejs/test/run-torque-fixtures.sh
# Expected: "13 passed, 1 failed" — js-return golden mismatches.
```

The golden currently holds the `(JS linkage deferred)` comment text
(Task 5.2 Step 8). Task 5.3's goal is to replace it with the real
emission; the initial FAIL is the TDD signal.

**Step 2: Draft the target golden by hand**

Before writing the emission code, hand-draft what the emitted output
MUST look like for `TorqueCcTest_JsReturn`:

```cpp
// AUTO-GENERATED by torque CC-Builtins backend (Phase 1 scaffolding).
// Source: test/phase2-fixtures/js-return.tq
// DO NOT EDIT.

#include "src/base/macros.h"
#include "src/builtins/builtins-utils-inl.h"
#include "src/execution/arguments-inl.h"
#include "src/execution/isolate.h"
#include "src/handles/handles-inl.h"
#include "src/objects/contexts.h"
#include "src/objects/smi.h"
#include "src/objects/tagged.h"

namespace v8::internal {

// Builtin: TorqueCcTest_JsReturn

inline Address Builtin_TorqueCcTest_JsReturn(int args_length,
                                             Address* args_object,
                                             Isolate* isolate) {
  DCHECK(isolate->context().is_null() || IsContext(isolate->context()));
  BuiltinArguments args(args_length, args_object);
  HandleScope scope(isolate);
  USE(isolate);

  Tagged<NativeContext> context = Cast<NativeContext>(isolate->context());
  USE(context);
  Tagged<JSAny> receiver = Cast<JSAny>(*args.receiver());
  USE(receiver);
  Tagged<JSAny> arg = Cast<JSAny>(args[0]);
  USE(arg);

  // Bridge lines — CCGenerator expects parameterN stack names.
  Tagged<NativeContext> parameter0 = context;
  USE(parameter0);
  Tagged<JSAny> parameter1 = arg;
  USE(parameter1);

  // Torque CFG.
  goto block0;

  block0:
  return parameter1.ptr();
}

}  // namespace v8::internal
```

Rules being set here:
- Function is `inline` (same InlineDefinition-flag discipline as Phase
  4 — required for ODR across TUs that also compile in the include
  preamble).
- Return type is `Address` (matches `BUILTIN_LIST_C`'s
  `FORWARD_DECLARE`).
- `HandleScope` is installed unconditionally (safe; costs nothing for
  bodies that don't allocate).
- Context via `isolate->context()`, NOT `Descriptor::kContext`.
- Receiver / target / newTarget via `args.receiver()` /
  `args.target()` / `args.new_target()` (deref the Handle to Tagged).
- Explicit args via `args[i]` (zero-indexed past receiver).
- Bridge lines still emit `parameter0`, `parameter1`, … for CCGenerator
  compatibility — same pattern as Phase 4 `implementation-visitor.cc:683-685`.
- Return path: `return <tagged>.ptr();`.

**Step 3: Implement the emission in `Visit(Builtin*)`**

Replace `implementation-visitor.cc:625-633` (the
`(JS linkage deferred)` branch) with:

```cpp
    if (builtin->IsJavaScript()) {
      // Phase 5 (revised): real CPP-ABI emission for whitelisted
      // JS-linkage builtins. Matches the BUILTIN(Name) macro expansion
      // from src/builtins/builtins-utils.h:99-153 so V8's existing
      // AdaptorWithBuiltinExitFrameN machinery can dispatch through
      // the CPP adaptor pipeline.
      if (builtin->IsVarArgsJavaScript()) {
        ReportError(
            "Phase 5: varargs JS linkage not yet supported for "
            "kCCBuiltins emission");
      }
      DCHECK(builtin->IsFixedArgsJavaScript());

      CurrentScope::Scope current_scope(builtin);
      CurrentSourcePosition::Scope source_position(builtin->Position());
      CurrentCallable::Scope current_callable(builtin);
      CurrentReturnValue::Scope current_return_value;

      const std::string& name = builtin->ExternalName();
      const Signature& signature = builtin->signature();

      // CPP-ABI signature: Address(int, Address*, Isolate*).
      csa_ccfile() << "inline Address Builtin_" << name
                   << "(int args_length, Address* args_object,\n"
                   << "                         Isolate* isolate) {\n"
                   << "  DCHECK(isolate->context().is_null() || "
                   << "IsContext(isolate->context()));\n"
                   << "  BuiltinArguments args(args_length, args_object);\n"
                   << "  HandleScope scope(isolate);\n"
                   << "  USE(isolate);\n";

      Stack<const Type*> parameter_types;
      Stack<std::string> parameters;

      BindingsManagersScope bindings_managers_scope;
      BlockBindings<LocalValue> parameter_bindings(&ValueBindingsManager::Get());

      // Unpack implicit parameters (context / receiver / newTarget /
      // target / dispatchHandle) from BuiltinArguments + isolate.
      for (size_t i = 0; i < signature.implicit_count; ++i) {
        const std::string& param_name = signature.parameter_names[i]->value;
        SourcePosition param_pos = signature.parameter_names[i]->pos;
        const Type* type = signature.parameter_types.types[i];
        const bool mark_as_used = signature.implicit_count > i;
        std::string generated_name =
            AddParameter(i, builtin, &parameters, &parameter_types,
                         &parameter_bindings, mark_as_used);

        if (param_name == "context") {
          csa_ccfile() << "  Tagged<NativeContext> " << generated_name
                       << " = Cast<NativeContext>(isolate->context());\n";
        } else if (param_name == "receiver") {
          csa_ccfile() << "  Tagged<JSAny> " << generated_name
                       << " = Cast<JSAny>(*args.receiver());\n";
        } else if (param_name == "newTarget") {
          csa_ccfile() << "  Tagged<JSAny> " << generated_name
                       << " = Cast<JSAny>(*args.new_target());\n";
        } else if (param_name == "target") {
          csa_ccfile() << "  Tagged<JSFunction> " << generated_name
                       << " = *args.target();\n";
        } else if (param_name == "dispatchHandle") {
          csa_ccfile() << "  JSDispatchHandle " << generated_name
                       << " = InvalidDispatchHandleConstant();\n";
        } else {
          Error("Unexpected implicit parameter \"", param_name,
                "\" for JavaScript calling convention, "
                "expected \"context\", \"receiver\", \"target\", "
                "\"newTarget\", or \"dispatchHandle\"")
              .Position(param_pos);
        }
        csa_ccfile() << "  USE(" << generated_name << ");\n";

        // Bridge line for Torque names.
        csa_ccfile() << "  " << type->GetRuntimeType() << " "
                     << signature.parameter_names[i]->value << " = "
                     << generated_name << ";\n";
        csa_ccfile() << "  USE(" << signature.parameter_names[i]->value
                     << ");\n";
      }

      // Unpack explicit parameters from args[i]. Zero-based past receiver.
      for (size_t i = signature.implicit_count;
           i < signature.parameter_names.size(); ++i) {
        const std::string& param_name = signature.parameter_names[i]->value;
        const Type* type = signature.types()[i];
        const bool mark_as_used = signature.implicit_count > i;
        std::string generated_name =
            AddParameter(i, builtin, &parameters, &parameter_types,
                         &parameter_bindings, mark_as_used);
        size_t explicit_index = i - signature.implicit_count;
        csa_ccfile() << "  " << type->GetRuntimeType() << " "
                     << generated_name << " = Cast<"
                     << type->GetRuntimeType().substr(7,
                          type->GetRuntimeType().size() - 8)
                     << ">(args[" << explicit_index << "]);\n";
        csa_ccfile() << "  USE(" << generated_name << ");\n";

        // Bridge line.
        csa_ccfile() << "  " << type->GetRuntimeType() << " " << param_name
                     << " = " << generated_name << ";\n";
        csa_ccfile() << "  USE(" << param_name << ");\n";
      }

      // Drive Torque body through CCGenerator — same as stub-linkage.
      assembler_ = CfgAssembler(parameter_types);
      const Type* body_result = Visit(*builtin->body());
      if (body_result != TypeOracle::GetNeverType()) {
        ReportError("control reaches end of builtin, expected return of a value");
      }
      CCGenerator cc_generator{assembler().Result(), csa_ccfile()};
      cc_generator.SetReturnMode(CCGenerator::kPtrReturn);  // NEW — see Step 3a
      cc_generator.EmitGraph(parameters);
      assembler_ = std::nullopt;
      csa_ccfile() << "}\n\n";

      // Do NOT append to cc_builtin_entries_ — this builtin will be
      // dispatched through the CPP adaptor via the TFJ→CPP torque swap,
      // not through Builtins::TorqueCcEntryOf. Keep that table scoped to
      // stub-linkage.
      return;
    }
```

**Step 3a: Add CCGenerator::kPtrReturn return mode**

CCGenerator's `EmitReturn` currently emits `return <value>;` (stub
shape). For CPP-ABI we need `return <value>.ptr();`. Add a mode flag
to CCGenerator:

Modify `deps/v8/src/torque/cc-generator.h`:

```cpp
class CCGenerator : public TorqueCodeGenerator {
 public:
  enum class ReturnMode { kDirect, kPtrReturn };

  CCGenerator(const ControlFlowGraph& cfg, std::ostream& out)
      : TorqueCodeGenerator(cfg, out) {}

  void SetReturnMode(ReturnMode mode) { return_mode_ = mode; }

 private:
  ReturnMode return_mode_ = ReturnMode::kDirect;
  // …existing…
};
```

Modify `deps/v8/src/torque/cc-generator.cc`'s `Emit(ReturnInstruction)`:

```cpp
void CCGenerator::EmitInstruction(const ReturnInstruction& instruction,
                                  Stack<std::string>* stack) {
  const Stack<std::string> values =
      stack->PopMany(instruction.count);
  if (instruction.count == 1) {
    out() << "  return " << values.Peek(BottomOffset{0});
    if (return_mode_ == ReturnMode::kPtrReturn) {
      out() << ".ptr()";
    }
    out() << ";\n";
  } else {
    ReportError("multi-result ReturnInstruction not supported");
  }
}
```

Separate commit; keeps the cc-generator change small and focused.

**Step 4: Run the harness with the new emission; regenerate golden**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
# Rebuild torque with the new emission.
(cd examples/libs/nodejs/build/node && ninja -C out/Release.baseline torque)
# Update the golden.
UPDATE_GOLDEN=1 bash examples/libs/nodejs/test/run-torque-fixtures.sh
git diff examples/libs/nodejs/test/torque-fixtures/golden/js-return-tq-ccbuiltins.cc
```

Inspect the golden. It should match (or closely match) Step 2's draft.
Red flags:
- Missing `#include "src/builtins/builtins-utils-inl.h"` — extend the
  include preamble in `GenerateImplementation` (Phase 4 deviation note
  #3).
- Wrong return shape (missing `.ptr()`) — Step 3a's mode flag isn't
  wired correctly.
- Unexpected `parameter2` etc. — AddParameter name-gen drift.

**Step 5: Re-run harness; verify 14 green**

```bash
bash examples/libs/nodejs/test/run-torque-fixtures.sh
# Expected: "14 passed, 0 failed".
```

**Step 6: Re-verify non-ccbuiltins regression**

```bash
cd examples/libs/nodejs/build/node
rm -rf /tmp/phase5r-test-wl
mkdir -p /tmp/phase5r-test-wl
TQ_FILES=$(grep -oE '"(src|test|third_party)/[^"]*\.tq"' deps/v8/BUILD.gn \
             | tr -d '"' | sort -u)
echo "$TQ_FILES" | sed 's|[^/]*$||' | sort -u | while read d; do
  mkdir -p "/tmp/phase5r-test-wl/$d"
done
./out/Release.baseline/torque \
  --cc-builtins-whitelist=TorqueCcTest_JsReturn \
  -o /tmp/phase5r-test-wl \
  -v8-root deps/v8 \
  $TQ_FILES test/phase2-fixtures/js-return.tq
find /tmp/phase5r-test-wl -type f ! -name '*-tq-ccbuiltins.cc' \
  -print0 | sort -z | xargs -0 cat | shasum
# Expected: 2224e4db... (unchanged)
# BUT: note that builtin-definitions.h is NOT in the
# "! -name '*-tq-ccbuiltins.cc'" exclusion — it IS in the "sha".
# The whitelist=TorqueCcTest_JsReturn CHANGES builtin-definitions.h
# (CPP entry added for TorqueCcTest_JsReturn). So the sha DIFFERS by
# design under a nonempty whitelist; the regression gate is the
# EMPTY-whitelist sha.
```

Correct version of the regression check:

```bash
./out/Release.baseline/torque \
  -o /tmp/phase5r-test-empty \
  -v8-root deps/v8 \
  $TQ_FILES
find /tmp/phase5r-test-empty -type f ! -name '*-tq-ccbuiltins.cc' \
  -print0 | sort -z | xargs -0 cat | shasum
# Expected: 2224e4db4e95629954def24da8660e7b3b3dd2f1 (unchanged)
```

If the empty-whitelist sha drifts, Step 4's emission touched the
non-whitelisted path — investigate.

**Step 7: Commit the two clone-side changes as separate concerns**

Separate commits for CCGenerator change + Visit(Builtin*) change:

```bash
cd examples/libs/nodejs/build/node
git add deps/v8/src/torque/cc-generator.h deps/v8/src/torque/cc-generator.cc
git commit -m "torque: CCGenerator gets kPtrReturn mode for CPP-ABI return path

Adds ReturnMode::{kDirect,kPtrReturn} to CCGenerator. kPtrReturn
emits 'return <value>.ptr();' so CPP-ABI Torque-translated JS-linkage
builtins can return Address-typed results into the AdaptorWithBuiltin-
ExitFrameN convention. kDirect is the default and preserves the
stub-linkage return shape that Phase 2-4 established."

git add deps/v8/src/torque/implementation-visitor.cc
git commit -m "torque: implement JS-linkage CPP-ABI emission under kCCBuiltins

Replaces the Phase-2 '(JS linkage deferred)' placeholder in
Visit(Builtin*)'s kCCBuiltins branch with real emission matching
BUILTIN(Name, ...) macro expansion: Address(int, Address*, Isolate*)
signature; BuiltinArguments + HandleScope setup; context/receiver/
newTarget/target/dispatchHandle unpacking via args.*() + isolate->
context(); explicit args via args[i]; Torque CFG lowering via
CCGenerator::kPtrReturn. Stub-linkage emission path is unchanged.
Paired with the torque-side TFJ→CPP swap (prior commit) so V8's
DECL_CPP + BuildAdaptor pipeline picks up our emitted functions and
installs AdaptorWithBuiltinExitFrameN trampolines for them."
```

**Step 8: Re-export the patch, commit golden + patch on worktree**

```bash
cd examples/libs/nodejs/build/node
git format-patch 9fe7634c..HEAD --stdout > ../../patches/v8-torque-cc-builtins.patch
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/test/torque-fixtures/golden/js-return-tq-ccbuiltins.cc
git add examples/libs/nodejs/patches/v8-torque-cc-builtins.patch
git commit -m "nodejs: Phase 5 (revised) — golden for js-return JS-linkage fixture

Regenerates the js-return-tq-ccbuiltins.cc golden with the Task 5.3
real-emission output: CPP-ABI Address(int, Address*, Isolate*)
signature, BuiltinArguments + HandleScope, argument unpacking.
Includes re-exported consolidated patch with the emission + the
CCGenerator::kPtrReturn mode."
```

---

## Task 5.4: Extend include preamble for JS-linkage emission

**Context:** Task 5.3's emission references `BuiltinArguments`,
`HandleScope`, `Cast<NativeContext>`, `Cast<JSAny>`,
`InvalidDispatchHandleConstant`, `JSDispatchHandle` — none of which
are declared in Phase 4's existing preamble (`src/base/macros.h`,
`src/execution/isolate.h`, `src/objects/contexts.h`,
`src/objects/smi.h`, `src/objects/tagged.h`). Without additions, the
emitted `-tq-ccbuiltins.cc` fails to compile as soon as a JS-linkage
fixture is whitelisted and linked.

**Files:**
- Modify (clone): `deps/v8/src/torque/implementation-visitor.cc` —
  locate the include-preamble emission in `GenerateImplementation`
  and extend with JS-linkage-required headers (conditional on any
  JS-linkage whitelist entry being emitted, OR unconditional — simpler;
  extra includes cost nothing).

**Step 1: Locate the preamble emission site**

```bash
cd examples/libs/nodejs/build/node
grep -n 'include preamble\|#include.*src/base/macros.h\|kCCBuiltins.*preamble' \
  deps/v8/src/torque/implementation-visitor.cc
```

Phase 4 added the preamble in `ImplementationVisitor::GenerateImplementation`
at the top of `-tq-ccbuiltins.cc` generation. Find the exact line.

**Step 2: Extend the preamble**

Add to the existing include list:

```cpp
csa_ccfile() << "#include \"src/base/macros.h\"\n"
             << "#include \"src/builtins/builtins-utils-inl.h\"\n"
             << "#include \"src/execution/arguments-inl.h\"\n"
             << "#include \"src/execution/isolate.h\"\n"
             << "#include \"src/handles/handles-inl.h\"\n"
             << "#include \"src/objects/contexts.h\"\n"
             << "#include \"src/objects/smi.h\"\n"
             << "#include \"src/objects/tagged.h\"\n"
             << "\n";
```

Adding `builtins-utils-inl.h`, `arguments-inl.h`, `handles-inl.h`.
Unconditional — the preamble emits even for files with only stub-
linkage builtins, which is fine; unused includes don't affect
correctness.

**Step 3: Re-run harness — expect 13 goldens unchanged + js-return golden changes (preamble addition)**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
(cd examples/libs/nodejs/build/node && ninja -C out/Release.baseline torque)
UPDATE_GOLDEN=1 bash examples/libs/nodejs/test/run-torque-fixtures.sh
git diff examples/libs/nodejs/test/torque-fixtures/golden/
# Expected: all 14 goldens gain the 3 new #include lines at the top.
```

All 14 goldens now include the expanded preamble. Confirm the diff is
purely additive header lines — no semantic changes.

**Step 4: Regenerate non-ccbuiltins sha baseline**

The non-ccbuiltins sha gate checks files NOT matching
`*-tq-ccbuiltins.cc`, so preamble additions don't touch the gate.
BUT: sanity-check by running:

```bash
cd examples/libs/nodejs/build/node
rm -rf /tmp/phase5r-test-preamble
mkdir -p /tmp/phase5r-test-preamble
TQ_FILES=$(grep -oE '"(src|test|third_party)/[^"]*\.tq"' deps/v8/BUILD.gn \
             | tr -d '"' | sort -u)
echo "$TQ_FILES" | sed 's|[^/]*$||' | sort -u | while read d; do
  mkdir -p "/tmp/phase5r-test-preamble/$d"
done
./out/Release.baseline/torque \
  -o /tmp/phase5r-test-preamble -v8-root deps/v8 $TQ_FILES
find /tmp/phase5r-test-preamble -type f ! -name '*-tq-ccbuiltins.cc' \
  -print0 | sort -z | xargs -0 cat | shasum
# Expected: 2224e4db4e95629954def24da8660e7b3b3dd2f1 (unchanged)
```

**Step 5: Commit**

```bash
cd examples/libs/nodejs/build/node
git add deps/v8/src/torque/implementation-visitor.cc
git commit -m "torque: extend kCCBuiltins include preamble for JS-linkage

Adds src/builtins/builtins-utils-inl.h, src/execution/arguments-inl.h,
and src/handles/handles-inl.h to the -tq-ccbuiltins.cc include
preamble. These are required for BuiltinArguments + HandleScope +
Handle unwraps in JS-linkage emission (Task 5.3). Unconditional —
unused inclusion in stub-linkage-only files has zero correctness
impact and keeps the preamble emission a single point."

git format-patch 9fe7634c..HEAD --stdout > ../../patches/v8-torque-cc-builtins.patch
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/test/torque-fixtures/golden/
git add examples/libs/nodejs/patches/v8-torque-cc-builtins.patch
git commit -m "nodejs: Phase 5 (revised) — golden refresh for extended preamble

All 14 fixture goldens gain 3 new #include lines at the top:
builtins-utils-inl.h, arguments-inl.h, handles-inl.h. Additions are
needed by Task 5.3's JS-linkage emission (BuiltinArguments,
HandleScope, Handle unwraps) and cost nothing for stub-linkage-only
files. Pure header-addition diff."
```

---

## Task 5.5: Rebuild V8 host with js-return whitelisted; verify mksnapshot + d8 link + cctest link

**Context:** Tasks 5.2–5.4 are source-level changes. This task is the
first build-level gate: proves mksnapshot serializes the adaptor for
`TorqueCcTest_JsReturn` without trying to absolute-address our
function pointer into the blob, and that link-time symbol resolution
finds `Builtin_TorqueCcTest_JsReturn` in the emitted
`-tq-ccbuiltins.cc`.

**Files:** no commits from this task unless a build-system fix is
needed. Writes `/tmp/phase5r-task5.5.log`.

**Step 1: Build with js-return whitelisted**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
V8_CC_BUILTINS_WHITELIST="TorqueCcTest_Return,TorqueCcTest_JsReturn" \
  bash examples/libs/nodejs/build-v8-host-phase5.sh 2>&1 \
  | tee /tmp/phase5r-task5.5.log
```

Expected outcomes:
- mksnapshot completes. The log contains
  `Building builtin "TorqueCcTest_JsReturn" via BuildAdaptor` (if the
  build logs adaptor generation; otherwise verify silence is success).
- Link succeeds for `libv8_base_without_compiler.a`, `libv8_snapshot.a`,
  `d8`, `cctest`.
- No undefined symbol errors for `Builtin_TorqueCcTest_JsReturn`.

Failure modes:
- **"undefined reference to `Builtin_TorqueCcTest_JsReturn`":** the
  torque-generated `-tq-ccbuiltins.cc` for `test/phase2-fixtures/js-return.tq`
  didn't make it into the compile step. Inspect
  `tools/v8_gypfiles/v8.gyp` at the `torque_outputs_ccbuiltins_cc`
  variable (Phase 4 addition). If it's scoped to `src/**/*.tq`, the
  `test/phase2-fixtures/` path won't match — extend the variable.
- **mksnapshot serialization error:** if mksnapshot complains about an
  un-serializable absolute ("external reference to …"), Path 1's
  assumption fails for this case. Escalate.
- **"undefined reference to `InvalidDispatchHandleConstant`":** under
  lite-mode without leaptiering, this constant is defined in
  `src/execution/isolate.h` or `src/objects/tagged.h` — verify with
  grep and add the right include to the preamble.

**Step 2: Verify d8 still runs the empty-whitelist probes**

```bash
cd examples/libs/nodejs/build/node
./out/Release/d8 -e 'print(1+2)'
./out/Release/d8 -e 'print("hi")'
./out/Release/d8 -e 'print([1,2,3].length)'
# Expected: 3 / hi / 3.
```

If d8 crashes at startup with a DCHECK fire, the embedded blob's
adaptor for `TorqueCcTest_JsReturn` is broken (argc mismatch, formal
parameter count drift). Investigate.

**Step 3: Verify cctest binary still runs Phase 4 + 5.3 cases**

```bash
./out/Release/cctest --gtest_filter='TorqueCcBuiltinTest.*'
# Expected: 3 tests PASS (DirectInvocation, DispatchTableLookup,
# Phase5ScriptRunSmoke). No new test yet — Task 5.6 adds one.
```

**Step 4: Inspect the adaptor bake in the embedded blob**

```bash
nm out/Release/libv8_snapshot.a 2>/dev/null \
  | grep -i 'TorqueCcTest_JsReturn\|Adaptor' | head -10
```

Expected: `Builtin_TorqueCcTest_JsReturn` is visible as a defined
symbol in libv8_base_without_compiler.a; `AdaptorWithBuiltinExitFrame1`
exists in the snapshot's embedded builtin list. Not strictly required
for correctness but useful for diagnosing Step 1 issues.

**Step 5: No commit unless a build-system fix was needed**

If Step 1 required a gyp edit (e.g., extending
`torque_outputs_ccbuiltins_cc`), commit that:

```bash
cd examples/libs/nodejs/build/node
git add tools/v8_gypfiles/v8.gyp
git commit -m "v8 gyp: include test/phase2-fixtures -tq-ccbuiltins.cc in libv8 link

Phase 5 (revised) Task 5.5 surfaced that torque_outputs_ccbuiltins_cc
(Phase 4) didn't match the test/phase2-fixtures/ path where our
JS-linkage fixture lives. Extends the glob or path list so
js-return-tq-ccbuiltins.cc is compiled into v8_base_without_compiler,
enabling FUNCTION_ADDR(Builtin_TorqueCcTest_JsReturn) to resolve at
link time for the DECL_CPP static-init."

git format-patch 9fe7634c..HEAD --stdout > ../../patches/v8-torque-cc-builtins.patch
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/patches/v8-torque-cc-builtins.patch
git commit -m "nodejs: Phase 5 (revised) — patch refresh for gyp fixture inclusion"
```

---

## Task 5.6: cctest — TorqueCcBuiltinTest.JsReturnAdaptorDispatch

**Context:** Task 5.5 proved the plumbing links. This task proves it
**dispatches correctly** — the adaptor grabs the JS calling convention
args, marshals them into `BuiltinArguments`, calls our C function, and
returns the result through `BUILTIN_CONVERT_RESULT`. Target:
`Array.isArray(x)`-shaped invocation, but with our synthetic
`TorqueCcTest_JsReturn` (simpler body → sharper diagnosis if something
breaks).

**Files:**
- Modify (clone): `build/node/test/cctest/test_torque_cc_builtin.cc` —
  add `TorqueCcBuiltinTest.JsReturnAdaptorDispatch` test case.

**Step 1: Write the test**

Append to the file:

```cpp
TEST_F(NodeTestFixture, TorqueCcBuiltinTest_JsReturnAdaptorDispatch) {
  v8::HandleScope scope(isolate_);
  v8::Local<v8::Context> ctx = v8::Context::New(isolate_);
  v8::Context::Scope cscope(ctx);

  // Bind Builtin::kTorqueCcTest_JsReturn into a JSFunction and install
  // it as a global property. Mirrors SimpleInstallFunction's shape but
  // without bootstrapper coupling.
  v8::internal::Isolate* i_isolate =
      reinterpret_cast<v8::internal::Isolate*>(isolate_);
  v8::internal::HandleScope i_scope(i_isolate);

  v8::internal::Handle<v8::internal::JSFunction> fn =
      v8::internal::Factory::JSFunctionBuilder{
          i_isolate,
          i_isolate->factory()->NewSharedFunctionInfoForBuiltin(
              i_isolate->factory()->NewStringFromAsciiChecked(
                  "TorqueCcTest_JsReturn"),
              v8::internal::Builtin::kTorqueCcTest_JsReturn,
              /*len=*/1,
              v8::internal::kAdapt),
          i_isolate->native_context()}
          .Build();

  v8::internal::Handle<v8::internal::JSObject> global =
      v8::internal::Utils::OpenHandle(*ctx->Global());
  v8::internal::JSObject::AddProperty(
      i_isolate, global,
      i_isolate->factory()->NewStringFromAsciiChecked("TorqueCcTest_JsReturn"),
      fn, v8::internal::NONE);

  // Invoke it via Script::Run to exercise the full interpreter →
  // adaptor → C++ dispatch path.
  v8::Local<v8::String> src = v8::String::NewFromUtf8Literal(
      isolate_, "TorqueCcTest_JsReturn.call(undefined, 'test-marker')");
  v8::Local<v8::Script> script =
      v8::Script::Compile(ctx, src).ToLocalChecked();
  v8::Local<v8::Value> result = script->Run(ctx).ToLocalChecked();

  EXPECT_TRUE(result->IsString());
  v8::String::Utf8Value s(isolate_, result);
  EXPECT_STREQ(*s, "test-marker");
}
```

Notes on the binding shape:
- `Factory::JSFunctionBuilder` + `NewSharedFunctionInfoForBuiltin` is
  the pattern Factory uses internally. Task 5.1 spike findings
  identify the exact signature for V8 13.6.
- `kAdapt` + `len=1` must match the CPP listing's
  `JSParameterCount(1)`. If they diverge, `CheckFormalParameterCount`
  (`builtins.cc:166`) fires DCHECK.

**Step 2: Rebuild cctest**

```bash
cd examples/libs/nodejs/build/node
ninja -C out/Release cctest
# touch builtins.cc if the builtins-cc-table.inc drift hits:
# touch deps/v8/src/builtins/builtins.cc && ninja -C out/Release cctest
```

**Step 3: Run**

```bash
./out/Release/cctest \
  --gtest_filter='TorqueCcBuiltinTest.JsReturnAdaptorDispatch'
# Expected: PASS.
./out/Release/cctest --gtest_filter='TorqueCcBuiltinTest.*'
# Expected: 4 tests PASS (+ Phase4 DirectInvocation, DispatchTableLookup,
# Task5.3 Phase5ScriptRunSmoke).
```

Failure modes:
- **DCHECK fails at `isolate->context().is_null() || IsContext(...)`:**
  context not entered — verify `v8::Context::Scope cscope(ctx);` is
  live at invocation time.
- **SIGSEGV in `args.receiver()`:** adaptor's BuiltinExitFrame setup
  didn't put anything at args[0]; likely `JSParameterCount(0)` vs
  `JSParameterCount(1)` mismatch.
- **Result not a string:** the `.ptr()` cast lost the object identity
  — trace whether the Tagged<JSAny> coming back is truly the input
  or something else.
- **Fails to build with "no member JSFunctionBuilder":** V8 13.6's
  Factory API may use a different idiom — inspect
  `src/heap/factory.h` / `src/heap/factory-base.h` for
  `NewFunctionForTesting` or equivalent. Task 5.1 spike should have
  settled this already.

**Step 4: Commit**

```bash
cd examples/libs/nodejs/build/node
git add test/cctest/test_torque_cc_builtin.cc
git commit -m "v8 torque+node: Phase 5 (revised) — JsReturnAdaptorDispatch cctest

Binds Builtin::kTorqueCcTest_JsReturn as a global JSFunction via
Factory::JSFunctionBuilder + NewSharedFunctionInfoForBuiltin, invokes
it through Script::Compile + script->Run, asserts the returned string
matches the input. Proves V8's AdaptorWithBuiltinExitFrame1 machinery
correctly translates JS-calling-convention register args into
BuiltinArguments and dispatches to our torque-emitted
Address(int, Address*, Isolate*) function without any V8 bootstrap
edits. First end-to-end validation of the Path 1 pipeline."

git format-patch 9fe7634c..HEAD --stdout > ../../patches/v8-torque-cc-builtins.patch
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/patches/v8-torque-cc-builtins.patch
git commit -m "nodejs: Phase 5 (revised) — patch refresh after JsReturn cctest"
```

---

## Task 5.7: Whitelist `ArrayIsArray`; stage the fixture; regenerate golden

**Context:** First V8-tree JS-linkage builtin. Fixture is the existing
`deps/v8/src/builtins/array-isarray.tq`; no synthetic fixture needed.
Harness staging is a symlink (same pattern as Phase 2/3/4's
`test/phase2-fixtures/` convention).

**Files:**
- Create: `examples/libs/nodejs/test/torque-fixtures/array-isarray.tq`
  (symlink OR copy pointing at `deps/v8/src/builtins/array-isarray.tq`).
- Create: `examples/libs/nodejs/test/torque-fixtures/golden/array-isarray-tq-ccbuiltins.cc`
  (generated via UPDATE_GOLDEN).
- Modify: `examples/libs/nodejs/build-v8-host-phase5.sh` default
  whitelist (add `ArrayIsArray`).

**Step 1: Stage the fixture**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
ln -sfn "../../build/node/deps/v8/src/builtins/array-isarray.tq" \
  examples/libs/nodejs/test/torque-fixtures/array-isarray.tq
```

Or copy if symlinks don't survive the harness (check
`run-torque-fixtures.sh`'s handling).

**Step 2: Generate the golden; inspect for red flags**

```bash
UPDATE_GOLDEN=1 bash examples/libs/nodejs/test/run-torque-fixtures.sh
cat examples/libs/nodejs/test/torque-fixtures/golden/array-isarray-tq-ccbuiltins.cc
```

Expected content (rough shape — confirm exact after generation):

```cpp
#include "src/base/macros.h"
#include "src/builtins/builtins-utils-inl.h"
#include "src/execution/arguments-inl.h"
#include "src/execution/isolate.h"
#include "src/handles/handles-inl.h"
#include "src/objects/contexts.h"
#include "src/objects/smi.h"
#include "src/objects/tagged.h"

namespace v8::internal {

// Builtin: ArrayIsArray

inline Address Builtin_ArrayIsArray(int args_length,
                                    Address* args_object,
                                    Isolate* isolate) {
  DCHECK(isolate->context().is_null() || IsContext(isolate->context()));
  BuiltinArguments args(args_length, args_object);
  HandleScope scope(isolate);
  USE(isolate);

  Tagged<NativeContext> parameter0 =
      Cast<NativeContext>(isolate->context()); USE(parameter0);
  Tagged<NativeContext> context = parameter0; USE(context);
  Tagged<JSAny> parameter1 = Cast<JSAny>(args[0]); USE(parameter1);
  Tagged<JSAny> arg = parameter1; USE(arg);

  // typeswitch (arg) lowering:
  // - case JSArray → return True
  // - case JSProxy → return runtime::ArrayIsArray(arg)
  // - case JSAny   → return False
  goto block0;

  block0:
  // IR: Branch on IsJSArray(parameter1) → block_jsarray else block_proxy_check
  // …emitted by CCGenerator…
  return …ptr();
}

}  // namespace v8::internal
```

Red flags to investigate:
- Missing `#include "src/objects/js-array.h"` etc. — extend preamble
  again.
- `TqRuntimeArrayIsArray_0` or similar unresolved symbol — Phase 4's
  macro-body trigger missed the `runtime::ArrayIsArray` call lowering;
  add a trigger for runtime-call lowering under kCCBuiltins (see
  Phase 4 deviation note #3).
- `ReportError("...not yet supported...")` — a Torque construct not
  in our supported set; escalate (per Q7 escalation trigger).
- `typeswitch` lowers to chained `Branch` + `Cast` — confirm the
  emitted C++ uses `IsJSArray(parameter1)` style checks (standard V8
  idiom).

**Step 3: Inspect whether runtime::ArrayIsArray needs special handling**

```bash
grep -n 'ArrayIsArray' /tmp/phase5r-test/src/builtins/array-isarray-tq-ccbuiltins.cc
grep -n 'Runtime::kArrayIsArray' /tmp/phase5r-test/src/builtins/array-isarray-tq-ccbuiltins.cc
```

The Torque `runtime::ArrayIsArray` invocation lowers to
`Runtime::Call<Runtime::kArrayIsArray>(isolate, parameter1)` or similar
via CCGenerator's `CallRuntimeInstruction` emission (Phase 2). Confirm
the call site looks right.

**Step 4: Extend include preamble if needed**

If Step 2 surfaced missing includes for `JSArray`, `JSProxy`,
`HeapObject`, or `Runtime::Call` machinery:

```cpp
// implementation-visitor.cc preamble:
csa_ccfile() << "#include \"src/objects/js-array.h\"\n"
             << "#include \"src/objects/js-array-inl.h\"\n"
             << "#include \"src/objects/js-proxy.h\"\n"
             << "#include \"src/objects/js-proxy-inl.h\"\n"
             << "#include \"src/runtime/runtime.h\"\n"
             << "#include \"src/runtime/runtime-utils.h\"\n";
```

Re-run harness; goldens update (all 14 get these lines too — unused
in stub-linkage files, harmless).

**Step 5: Update default whitelist in build-v8-host-phase5.sh**

```bash
# In build-v8-host-phase5.sh, change:
#   V8_CC_BUILTINS_WHITELIST="${V8_CC_BUILTINS_WHITELIST:-}"
# to:
#   V8_CC_BUILTINS_WHITELIST="${V8_CC_BUILTINS_WHITELIST:-TorqueCcTest_Return,TorqueCcTest_JsReturn,ArrayIsArray}"
```

**Step 6: Re-run harness; verify 15 green**

```bash
bash examples/libs/nodejs/test/run-torque-fixtures.sh
# Expected: "15 passed, 0 failed" (14 prior + array-isarray).
```

**Step 7: Verify non-ccbuiltins regression**

```bash
./out/Release.baseline/torque -o /tmp/phase5r-task7 -v8-root deps/v8 \
  $TQ_FILES
find /tmp/phase5r-task7 -type f ! -name '*-tq-ccbuiltins.cc' -print0 \
  | sort -z | xargs -0 cat | shasum
# Expected: 2224e4db... unchanged.
```

**Step 8: Commit (clone-side + worktree-side)**

Clone-side (if preamble extension was needed):

```bash
cd examples/libs/nodejs/build/node
git add deps/v8/src/torque/implementation-visitor.cc
git commit -m "torque: extend kCCBuiltins preamble for js-array/js-proxy/runtime

Task 5.7 surfaced that ArrayIsArray's typeswitch lowering references
JSArray/JSProxy Cast + Runtime::Call machinery. Adds
src/objects/js-array{,-inl}.h, src/objects/js-proxy{,-inl}.h,
src/runtime/runtime{,-utils}.h to the include preamble. Unconditional;
unused in stub-linkage-only translation units."
```

Worktree-side:

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/test/torque-fixtures/array-isarray.tq
git add examples/libs/nodejs/test/torque-fixtures/golden/
git add examples/libs/nodejs/build-v8-host-phase5.sh
git add examples/libs/nodejs/patches/v8-torque-cc-builtins.patch
git commit -m "nodejs: Phase 5 (revised) — whitelist ArrayIsArray (Task 5.7)

Symlinks deps/v8/src/builtins/array-isarray.tq into the fixture
harness; regenerates golden; extends default whitelist to include
ArrayIsArray. Does NOT yet rebuild V8 — Task 5.8 handles that. All
14 pre-existing goldens are updated to include the extended preamble
(js-array/js-proxy/runtime headers) with pure-additive diffs."
```

---

## Task 5.8: Rebuild V8 with ArrayIsArray whitelisted; verify mksnapshot succeeds + d8 links

**Context:** First time the whitelist contains a real V8-tree JS-linkage
builtin. mksnapshot re-runs with the `TFJ(ArrayIsArray, …)` → `CPP(ArrayIsArray,
JSParameterCount(1))` swap live; the embedded blob bakes
`AdaptorWithBuiltinExitFrame1` for ArrayIsArray pointed at our
`Builtin_ArrayIsArray`.

**Files:** no worktree commits. Writes
`/tmp/phase5r-task5.8.log`.

**Step 1: Full rebuild**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
V8_CC_BUILTINS_WHITELIST="TorqueCcTest_Return,TorqueCcTest_JsReturn,ArrayIsArray" \
  bash examples/libs/nodejs/build-v8-host-phase5.sh 2>&1 \
  | tee /tmp/phase5r-task5.8.log
```

Expected: mksnapshot + d8 + cctest all complete. No new symbols from
V8 are missing; our `Builtin_ArrayIsArray` resolves at link time to
the torque-generated body.

Failure modes + diagnosis:
- **"multiple definition of `Builtin_ArrayIsArray`":** V8 already
  ships a hand-written CSA version as a `TF_BUILTIN(ArrayIsArray, …)`
  — that's emitted by the torque CSA pass as
  `array-isarray-tq-csa.cc`. The CSA-pass emitted function has a
  DIFFERENT signature (`void TF_BUILTIN(ArrayIsArray, CodeStubAssembler)`
  — static, not a plain function) and a DIFFERENT symbol name
  (`Builtins::Generate_ArrayIsArray`). So linker conflict is unlikely —
  but check. If it fires, investigate: the CSA emission may need to
  be gated off for whitelisted names (add a similar whitelist check in
  the CSA path of `Visit(Builtin*)` at
  `implementation-visitor.cc:731+`).
- **"undefined reference to `Builtin_ArrayIsArray` (from builtins.cc's
  DECL_CPP)":** our torque-emitted `-tq-ccbuiltins.cc` was not
  compiled into v8_base. Repeat Task 5.5 Step 1's gyp inspection for
  `src/builtins/` paths.
- **mksnapshot asserts or crashes:** inspect the crash — if it's
  during `BuildAdaptor` for ArrayIsArray, something about the formal
  parameter count or calling convention is off. Double-check the CPP
  entry says `JSParameterCount(1)` matching
  `bootstrapper.cc:2544`'s `SimpleInstallFunction(…, 1, kAdapt)`.

**Step 2: Sanity-check `d8 -e 'print(1+2)'` still runs**

```bash
./out/Release/d8 -e 'print(1+2)'        # expect "3"
./out/Release/d8 -e 'print("hello")'    # expect "hello"
```

If these fail, the entire embedded blob is broken — something about
the ArrayIsArray re-classing corrupted an unrelated builtin. Revert
and investigate.

**Step 3: Probe ArrayIsArray via d8 (smoke test preview — full smoke is Task 5.11)**

```bash
./out/Release/d8 -e 'print(Array.isArray([1,2,3]))'
# Expected: "true"
./out/Release/d8 -e 'print(Array.isArray(42))'
# Expected: "false"
./out/Release/d8 -e 'print(Array.isArray({}))'
# Expected: "false"
```

If these fail, read the error message:
- "ReferenceError: Array is not defined" — bootstrapper never
  installed Array. Critical regression; investigate.
- Segfault inside `Builtin_ArrayIsArray` — likely null receiver or
  wrong args layout; gdb-backtrace through the adaptor.
- Wrong result (e.g., `false` for `[1,2,3]`) — typeswitch lowering is
  wrong; compare generated code against the Torque source.

**Step 4: Confirm Phase 4 + 5.3 + 5.6 cctest cases still pass**

```bash
./out/Release/cctest --gtest_filter='TorqueCcBuiltinTest.*'
# Expected: 4 tests PASS.
```

**Step 5: No commit unless a build-system fix was needed**

Record in verification.md (draft for Summary) that ArrayIsArray
compiles + links + passes smoke probes. If anything went wrong, add
to the Phase 5 (revised) deviations section.

---

## Task 5.9: cctest — TorqueCcBuiltinTest.ScriptRunArrayIsArray

**Context:** d8 smoke probes passed (Task 5.8 Step 3) but those are
out-of-process; cctest proves in-process under the same
NodeTestFixture harness that hosts the other Phase-4/5 cases.

**Files:**
- Modify (clone): `build/node/test/cctest/test_torque_cc_builtin.cc`
  — add `TorqueCcBuiltinTest.ScriptRunArrayIsArray` test case.

**Step 1: Write the test**

```cpp
TEST_F(NodeTestFixture, TorqueCcBuiltinTest_ScriptRunArrayIsArray) {
  v8::HandleScope scope(isolate_);
  v8::Local<v8::Context> ctx = v8::Context::New(isolate_);
  v8::Context::Scope cscope(ctx);

  struct Case {
    const char* source;
    bool expected;
  };
  const Case cases[] = {
      {"Array.isArray([])", true},
      {"Array.isArray([1,2,3])", true},
      {"Array.isArray(42)", false},
      {"Array.isArray('str')", false},
      {"Array.isArray({})", false},
      {"Array.isArray(null)", false},
      {"Array.isArray(undefined)", false},
  };

  for (const auto& c : cases) {
    v8::Local<v8::String> src =
        v8::String::NewFromUtf8(isolate_, c.source).ToLocalChecked();
    v8::Local<v8::Script> script =
        v8::Script::Compile(ctx, src).ToLocalChecked();
    v8::Local<v8::Value> result = script->Run(ctx).ToLocalChecked();
    EXPECT_TRUE(result->IsBoolean()) << "source: " << c.source;
    EXPECT_EQ(result->BooleanValue(isolate_), c.expected)
        << "source: " << c.source;
  }
}
```

**Step 2: Rebuild cctest; run**

```bash
cd examples/libs/nodejs/build/node
ninja -C out/Release cctest
./out/Release/cctest \
  --gtest_filter='TorqueCcBuiltinTest.ScriptRunArrayIsArray'
# Expected: PASS (7 subcases).
```

**Step 3: Run full TorqueCcBuiltinTest suite**

```bash
./out/Release/cctest --gtest_filter='TorqueCcBuiltinTest.*'
# Expected: 5 tests PASS.
```

**Step 4: Commit**

```bash
cd examples/libs/nodejs/build/node
git add test/cctest/test_torque_cc_builtin.cc
git commit -m "v8 torque+node: Phase 5 (revised) — ScriptRunArrayIsArray cctest

Compiles and runs seven Array.isArray(x) invocations via
Script::Compile + script->Run, asserting true for arrays and false
for Smi/string/object/null/undefined. Exercises the full interpreter
→ AdaptorWithBuiltinExitFrame1 → Torque-CC-emitted Builtin_ArrayIsArray
dispatch chain inside V8's NodeTestFixture lite-mode host. The
JSProxy branch (which calls runtime::ArrayIsArray) is NOT exercised
here — cases added in Phase 6+ when the interpreter surfaces a Proxy
receiver through real JS code."

git format-patch 9fe7634c..HEAD --stdout > ../../patches/v8-torque-cc-builtins.patch
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/patches/v8-torque-cc-builtins.patch
git commit -m "nodejs: Phase 5 (revised) — patch refresh after ScriptRunArrayIsArray"
```

---

## Task 5.10: d8 smoke test — the Phase 5 success gate

**Context:** Phase 5's top-line success gate per the user brief:

```
d8 -e 'print(Array.isArray([1,2,3]))'   prints "true"
d8 -e 'print(Array.isArray(42))'        prints "false"
d8 -e 'print(Array.isArray({}))'        prints "false"
```

Task 5.8 Step 3 already ran these as a smoke preview; this task
formalizes them into a scripted check under
`examples/libs/nodejs/test/d8-smoke.sh` that future sessions can
re-run with one command.

**Files:**
- Create: `examples/libs/nodejs/test/d8-smoke.sh`.

**Step 1: Write the script**

```bash
#!/usr/bin/env bash
# examples/libs/nodejs/test/d8-smoke.sh — Phase 5 (revised) d8 smoke.
set -euo pipefail
D8="${D8:-$(pwd)/examples/libs/nodejs/build/node/out/Release/d8}"
if [ ! -x "$D8" ]; then
  echo "error: d8 not found or not executable at $D8"
  echo "Run 'bash examples/libs/nodejs/build-v8-host-phase5.sh' first."
  exit 1
fi

pass=0; fail=0
check() {
  local source="$1" expected="$2"
  local actual
  actual="$("$D8" -e "$source" 2>&1 | tr -d '\r')"
  if [ "$actual" = "$expected" ]; then
    echo "[pass] $source -> $actual"
    pass=$((pass+1))
  else
    echo "[FAIL] $source"
    echo "       expected: $expected"
    echo "       actual:   $actual"
    fail=$((fail+1))
  fi
}

# Basic interpreter (sanity).
check 'print(1+2)'                       '3'
check 'print("hi")'                      'hi'
check 'print([1,2,3].length)'            '3'

# ArrayIsArray — the Phase 5 success gate.
check 'print(Array.isArray([1,2,3]))'    'true'
check 'print(Array.isArray([]))'         'true'
check 'print(Array.isArray(42))'         'false'
check 'print(Array.isArray("str"))'      'false'
check 'print(Array.isArray({}))'         'false'
check 'print(Array.isArray(null))'       'false'
check 'print(Array.isArray(undefined))'  'false'

echo
echo "d8 smoke: $pass passed, $fail failed"
[ "$fail" = 0 ]
```

Chmod +x.

**Step 2: Run it**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
bash examples/libs/nodejs/test/d8-smoke.sh
# Expected: 10 passed, 0 failed.
```

If the Array.isArray checks FAIL:
- Check stdout for the actual output — V8's `print()` writes to
  stdout with a trailing newline, so compare carefully.
- If `Array.isArray([1,2,3])` returns `false`, the typeswitch's
  JSArray case didn't lower correctly — trace the emitted code for
  `IsJSArray(parameter1)` vs the actual branch structure.
- If it crashes, run under lldb and get a backtrace through the
  adaptor to diagnose whether the adaptor itself is broken or our
  C++ body is.

**Step 3: Commit**

```bash
git add examples/libs/nodejs/test/d8-smoke.sh
git commit -m "nodejs: Phase 5 (revised) — d8 Array.isArray smoke script

Adds test/d8-smoke.sh as a reproducible check of Phase 5's top-line
success gate: d8 prints 'true' for Array.isArray(arrays) and 'false'
for non-arrays. Wraps the three canonical user-visible probes plus
four additional edge cases (null/undefined/string/empty-array) into
one runnable script that future sessions can replay after any V8
rebuild to verify the Path 1 dispatch still works end-to-end."
```

---

## Task 5.11: CSA replacement ledger — scaffold + Path-1-aware README

**Context:** Phase 5's scaffold for hand-written shims replacing V8
builtins that don't live in Torque. Path-independent infrastructure;
first actual shim lands under Phase 6 mjsunit pressure unless Task
5.10 surfaced a missing builtin (none expected — ArrayIsArray has
no CSA-only dependencies).

**Files:**
- Create: `examples/libs/nodejs/csa-builtins/README.md`.
- Create: `examples/libs/nodejs/csa-builtins/shims.gypi` (empty
  sources list).

**Step 1: Write the README (Path-1-aware)**

```markdown
# Hand-written CSA-replacement shims (Torque CC backend)

This directory holds C++ implementations that stand in for V8 builtins
whose source is NOT available in Torque — builtins at
`deps/v8/src/builtins/builtins-<group>.cc` written directly against
`CodeStubAssembler`. The Torque CC backend translates Torque sources
only; CSA-only builtins need hand-written equivalents when they end up
on our interpreter dispatch path.

## When to write a shim

Write one when:
1. A Phase 5+ d8 / cctest / mjsunit run fails with "undefined reference
   to `Builtin_<Name>`" or crashes inside a builtin that has no
   translated `.tq` body.
2. Inspection of `deps/v8/src/builtins/` confirms `<Name>` lives only
   in CSA C++, not in any `.tq` file.

## Shape of a shim — two mechanisms depending on linkage

Phase 5 (revised) uses V8's existing **CPP-ABI adaptor pipeline**
(`AdaptorWithBuiltinExitFrameN` via `BuildAdaptor`) for Torque-translated
JS-linkage builtins. Hand-written shims follow the same shape.

### Stub-linkage shim (Phase-4-style)

For a stub-linkage builtin (no `javascript` keyword in its
declaration), write a shim with the Phase-4 signature:

```cpp
// File: builtins-<group>.cc
#include "src/builtins/builtins.h"
#include "src/execution/isolate.h"
#include "src/objects/tagged.h"
// … whatever <Name> needs

namespace v8::internal {

Tagged<RetType> Builtin_<Name>(Isolate* isolate,
                               Tagged<Context> context,
                               // … args
                               ) {
  // port CSA logic to plain C++
}

}  // namespace v8::internal
```

Register via an addition to the hand-written companion to
`torque-generated/builtins-cc-table.inc`. `Builtins::TorqueCcEntryOf`
will resolve `<Name>` to `&Builtin_<Name>`. No edit to V8's
hand-written `builtins-definitions.h` is needed — stub-linkage builtins
aren't accessed by V8's Kind dispatch, only by function pointer.

### JS-linkage shim (Phase-5-style)

For a JS-linkage builtin, write a shim with the CPP-ABI signature
(matching `BUILTIN(Name, ...)` expansion from
`deps/v8/src/builtins/builtins-utils.h`):

```cpp
// File: builtins-<group>.cc
#include "src/builtins/builtins-utils-inl.h"
#include "src/execution/isolate.h"
#include "src/objects/tagged.h"
// … whatever <Name> needs

namespace v8::internal {

Address Builtin_<Name>(int args_length, Address* args_object,
                       Isolate* isolate) {
  DCHECK(isolate->context().is_null() || IsContext(isolate->context()));
  BuiltinArguments args(args_length, args_object);
  HandleScope scope(isolate);
  // port CSA logic to plain C++ using args.receiver()/target()/etc.
  return result.ptr();
}

}  // namespace v8::internal
```

Register by patching `deps/v8/src/builtins/builtins-definitions.h`
(the hand-written file, NOT the torque-generated include) to replace
the builtin's existing `TFJ(<Name>, ...)` entry with
`CPP(<Name>, JSParameterCount(<N>))`. V8's existing `DECL_CPP` static-
init + `BUILD_CPP_WITHOUT_JOB` bootstrap pipeline handles the rest.

## Ledger

| Builtin | Linkage | Shim file | Phase | Notes |
|---------|---------|-----------|-------|-------|
| _(none yet)_ | | | | |
```

**Step 2: Empty `shims.gypi`**

```gypi
{
  'variables': {
    'csa_builtin_shims_sources': [
      # Entries appended in Phase 5+ when the first shim lands.
    ],
  },
}
```

**Step 3: Commit**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/csa-builtins/
git commit -m "nodejs: Phase 5 (revised) — CSA-replacement ledger scaffold

Creates examples/libs/nodejs/csa-builtins/ with a README documenting
the two mechanisms for hand-written shims: stub-linkage (Phase-4
Builtins::TorqueCcEntryOf dispatch) and JS-linkage (Phase-5-revised
CPP-ABI adaptor via TFJ→CPP swap in builtins-definitions.h). shims.gypi
is empty; populating it is deferred to Phase 6+ mjsunit work when the
first CSA-only dependency actually surfaces."
```

No clone-side commit; no patch re-export.

---

## Task 5.12: Regression gate — all tests + patch re-export

**Context:** Final pre-summary verification. Confirm nothing Phase 5
(revised) touched has regressed any Phase-0-through-4 invariant.

**Files:** no commits from this task unless a regression is found;
writes `/tmp/phase5r-regression.log`.

**Step 1: 15-fixture harness all green**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
bash examples/libs/nodejs/test/run-torque-fixtures.sh
# Expected: "15 passed, 0 failed" (13 stub-linkage + 2 JS-linkage).
```

**Step 2: Non-ccbuiltins sha stable**

```bash
cd examples/libs/nodejs/build/node
TQ_FILES=$(grep -oE '"(src|test|third_party)/[^"]*\.tq"' deps/v8/BUILD.gn \
             | tr -d '"' | sort -u)
rm -rf /tmp/phase5r-final
mkdir -p /tmp/phase5r-final
echo "$TQ_FILES" | sed 's|[^/]*$||' | sort -u | while read d; do
  mkdir -p "/tmp/phase5r-final/$d"
done
./out/Release.baseline/torque -o /tmp/phase5r-final -v8-root deps/v8 \
  $TQ_FILES 2>&1 | tee /tmp/phase5r-final.log
find /tmp/phase5r-final -type f ! -name '*-tq-ccbuiltins.cc' -print0 \
  | sort -z | xargs -0 cat | shasum
# Expected: 2224e4db4e95629954def24da8660e7b3b3dd2f1
```

If the sha drifts, STOP. Find the Phase-5-revised commit that changed
the kCSA/kCC/kCCDebug emission and investigate.

**Step 3: 5 cctest cases all green**

```bash
./out/Release/cctest --gtest_filter='TorqueCcBuiltinTest.*'
# Expected: 5 tests PASS:
#   TorqueCcBuiltinTest.DirectInvocation          (Phase 4)
#   TorqueCcBuiltinTest.DispatchTableLookup       (Phase 4)
#   TorqueCcBuiltinTest.Phase5ScriptRunSmoke      (Task 5.3)
#   TorqueCcBuiltinTest.JsReturnAdaptorDispatch   (Task 5.6)
#   TorqueCcBuiltinTest.ScriptRunArrayIsArray     (Task 5.9)
```

**Step 4: d8 smoke passes**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
bash examples/libs/nodejs/test/d8-smoke.sh
# Expected: "10 passed, 0 failed".
```

**Step 5: Consolidated patch re-applies cleanly on upstream 9fe7634c**

```bash
# Scratch test — does NOT alter the worktree clone.
cd /tmp
rm -rf phase5r-patch-test
git clone --depth=1 --branch=v24.x https://github.com/nodejs/node.git \
  phase5r-patch-test
cd phase5r-patch-test
# Match the clone base commit.
git fetch --depth=200 origin v24.x
git checkout 9fe7634c
git apply --check \
  /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend/examples/libs/nodejs/patches/v8-torque-cc-builtins.patch
echo "apply-check exit=$?"
# Expected: exit 0.
```

If it fails, the patch has drifted from the cumulative commit chain —
re-export fresh:

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend/examples/libs/nodejs/build/node
git format-patch 9fe7634c..HEAD --stdout \
  > ../../patches/v8-torque-cc-builtins.patch
```

**Step 6: Record final metrics**

Write to `/tmp/phase5r-regression.log`:
- 15-fixture harness: PASS
- Non-ccbuiltins sha: `2224e4db…` (stable)
- ccbuiltins sha: `<final value>` (records new Phase-5-revised state)
- 5 cctest cases: PASS
- d8 smoke (10 checks): PASS
- Patch re-apply: clean
- Final clone commit count: `<N>` on top of `9fe7634c`
  (expected ~50: 43 baseline + ~7 new: 5.2 torque swap, 5.3 CCGenerator
  mode, 5.3 emission, 5.4 preamble, 5.6 cctest JsReturn, 5.7 preamble
  extension, 5.9 cctest ScriptRunArrayIsArray; adjust for any merged
  commits).
- Final patch size: `<X>` lines.

**Step 7: No commit unless a regression was found and fixed**

If a regression was found, add a commit on the branch that fixes it;
document the root cause + fix in the Phase 5 Summary deviations
section.

---

## Task 5.13: verification.md Phase 5 (revised) Summary + final patch re-export

**Context:** Close Phase 5 (revised) with a Summary block that records
what landed, what deviated, and what's staged for Phase 6+. Mirrors
the Phase-1-through-4 Summary structure in `verification.md`.

**Files:**
- Modify: `examples/libs/nodejs/verification.md` — append Phase 5
  (revised) Summary.
- Modify (re-export): `examples/libs/nodejs/patches/v8-torque-cc-builtins.patch`
  if Task 5.12 required a fresh export.

**Step 1: Write the Summary**

Append to `verification.md`:

```markdown
## Phase 5 (Revised) Summary

| Item | Result |
|---|---|
| Task 5.1 spike: Path 1 hand-written proof-of-life | ✅ |
| Torque-side TFJ → CPP swap in BUILTIN_LIST_FROM_TORQUE (Task 5.2) | ✅ |
| CCGenerator::kPtrReturn mode for CPP-ABI return (Task 5.3) | ✅ |
| JS-linkage CPP-ABI emission in Visit(Builtin*) kCCBuiltins (Task 5.3) | ✅ |
| Include preamble extended (builtins-utils-inl, arguments-inl, handles-inl) (Task 5.4) | ✅ |
| Host build with ArrayIsArray whitelisted (Task 5.8) — mksnapshot + d8 + cctest all green | ✅ |
| TorqueCcBuiltinTest.JsReturnAdaptorDispatch cctest (Task 5.6) | ✅ |
| TorqueCcBuiltinTest.ScriptRunArrayIsArray cctest (Task 5.9) | ✅ |
| d8 smoke — `Array.isArray([1,2,3])` prints "true" (Task 5.10) | ✅ |
| d8 smoke — `Array.isArray(42)` + `Array.isArray({})` print "false" (Task 5.10) | ✅ |
| CSA-replacement ledger scaffold + Path-1-aware README (Task 5.11) | ✅ |
| 15-fixture harness: 13 stub-linkage + 2 JS-linkage, all byte-exact | ✅ |
| Non-whitelisted torque output sha unchanged: 2224e4db… | ✅ |
| Consolidated patch exports + re-applies cleanly on upstream 9fe7634c | ✅ |
| 5 cctest cases green (DirectInvocation + DispatchTableLookup + Phase5ScriptRunSmoke + JsReturnAdaptorDispatch + ScriptRunArrayIsArray) | ✅ |
| d8 smoke: 10/10 checks green | ✅ |

**End-to-end proof.** `./out/Release/d8 -e 'print(Array.isArray([1,2,3]))'`
prints "true"; `print(Array.isArray(42))` prints "false";
`print(Array.isArray({}))` prints "false". V8's interpreter, running
from the embedded lite-mode snapshot, dispatches through the baked
`AdaptorWithBuiltinExitFrame1` for `Builtin::kArrayIsArray`; the
adaptor marshals the JS calling convention into
`BuiltinArguments(1+4, argp, isolate)`; the adaptor calls our
torque-emitted `Builtin_ArrayIsArray(int, Address*, Isolate*)`; our
function unpacks context + receiver + arg via BuiltinArguments +
`isolate->context()`, runs the Torque typeswitch lowered by CCGenerator,
and returns `True.ptr()` / `False.ptr()` / `runtime::ArrayIsArray().ptr()`.
**This is the first phase where V8's own machinery dispatches to our
generated code through its normal interpreter → builtin_table → Code →
adaptor → C++ path, with zero hand-written V8 bootstrap edits.**

**Phase 5 (revised) commit chain on the Node.js clone** (≈7 commits on
top of Phase 4 + Task 5.1-5.3 tip `305050d4`):
1. `torque: emit CPP(...) for whitelisted JS-linkage builtins`
2. `torque: CCGenerator gets kPtrReturn mode for CPP-ABI return path`
3. `torque: implement JS-linkage CPP-ABI emission under kCCBuiltins`
4. `torque: extend kCCBuiltins include preamble for JS-linkage`
5. `v8 torque+node: Phase 5 (revised) — JsReturnAdaptorDispatch cctest`
6. `torque: extend kCCBuiltins preamble for js-array/js-proxy/runtime`
7. `v8 torque+node: Phase 5 (revised) — ScriptRunArrayIsArray cctest`

Total commits on top of `9fe7634c` after Phase 5 (revised): ≈50
(43 baseline + 7 new). Consolidated patch: ≈3200 lines (exact value
TBD after final export).

### Plan deviations surfaced during Phase 5 (revised) implementation

_(Populated during task execution.)_

### Phase 5 (revised) follow-ups for later phases

- **Runtime exception handling** (`catch_block`). Still `ReportError`.
  Phase 6+ when a target forces it.
- **Tail-calls from CallBuiltin / CallBuiltinPointer.** Still
  `ReportError`. Phase 6+.
- **Struct-typed label values.** Still `ReportError`. Phase 6+.
- **mjsunit.** Phase 6.
- **CSA replacement ledger — first real shim.** When d8 / mjsunit
  forces one. Phase 6.
- **Varargs JS builtins** (`IsVarArgsJavaScript`). Still `ReportError`
  under kCCBuiltins. Phase 6 when a forcing fixture lands.
- **Leaptiering-on dispatchHandle.** Currently emits
  `InvalidDispatchHandleConstant()`. Phase 6+ for
  `V8_ENABLE_LEAPTIERING=true` builds.
- **JSProxy branch of ArrayIsArray exercised via real JS.** Not covered
  by Task 5.9's fixed-receiver cases; needs a `new Proxy(…)` case in
  Phase 6 mjsunit.
- **Wasm32 cross-compile.** Phase 7+.
```

**Step 2: Re-export the patch one last time**

```bash
cd examples/libs/nodejs/build/node
git format-patch 9fe7634c..HEAD --stdout > ../../patches/v8-torque-cc-builtins.patch
wc -l ../../patches/v8-torque-cc-builtins.patch
# Record the exact line count for the Summary table.
```

**Step 3: Commit the Summary + patch refresh**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/verification.md
git add examples/libs/nodejs/patches/v8-torque-cc-builtins.patch
git commit -m "nodejs: Phase 5 (revised) — verification.md Summary + final patch export

Captures Phase 5 (revised) end-state: Path 1 (re-emit with CPP ABI +
piggyback AdaptorWithBuiltinExitFrameN) lands ArrayIsArray end-to-end
through V8's interpreter dispatch; d8 smoke + 5 cctest cases + 15-
fixture harness all green; non-ccbuiltins sha 2224e4db... unchanged;
consolidated patch re-applies on upstream 9fe7634c. Closes the gap
left by the superseded 2026-04-20 plan at Task 5.4's escalation."
```

**Step 4: Push to origin**

```bash
git push origin torque-cc-backend
# PR #306 updates with the new commits.
```

---

## Phase 5 (revised) final commit list (predicted)

Worktree-side (branch `torque-cc-backend`):
1. Task 5.1 — spike record in verification.md
2. Task 5.2 — js-return fixture + placeholder golden + patch refresh
3. Task 5.3 — regenerated js-return golden + patch refresh
4. Task 5.4 — 14 golden refreshes for extended preamble + patch refresh
5. Task 5.5 — (conditional) patch refresh after gyp fix
6. Task 5.6 — patch refresh after JsReturn cctest
7. Task 5.7 — array-isarray fixture + golden + whitelist update + patch refresh
8. Task 5.9 — patch refresh after ScriptRunArrayIsArray cctest
9. Task 5.10 — d8-smoke.sh script
10. Task 5.11 — csa-builtins/ scaffold + README
11. Task 5.13 — verification.md Summary + final patch refresh

Clone-side (ephemeral; consolidated into patch on worktree):
1. 5.2: `torque: emit CPP(...) for whitelisted JS-linkage builtins`
2. 5.3: `torque: CCGenerator gets kPtrReturn mode for CPP-ABI return path`
3. 5.3: `torque: implement JS-linkage CPP-ABI emission under kCCBuiltins`
4. 5.4: `torque: extend kCCBuiltins include preamble for JS-linkage`
5. 5.5: (conditional) `v8 gyp: include test/phase2-fixtures -tq-ccbuiltins.cc`
6. 5.6: `v8 torque+node: Phase 5 (revised) — JsReturnAdaptorDispatch cctest`
7. 5.7: `torque: extend kCCBuiltins preamble for js-array/js-proxy/runtime`
8. 5.9: `v8 torque+node: Phase 5 (revised) — ScriptRunArrayIsArray cctest`

≈6 worktree commits, ≈7-8 clone commits, ≈50 total on top of `9fe7634c`.

## Remember
- Exact file paths always.
- Complete code in plan (not "add validation").
- Exact commands with expected output.
- Reference relevant skills with @ syntax.
- DRY, YAGNI, TDD, frequent commits.
- **Escalate** at the first `catch_block` / tail-call / struct-label /
  serialization sign — don't hack around silently.
- **Preserve** the non-ccbuiltins sha `2224e4db…` through every commit.
- **Never** branch off main; **never** rebase — stacked commits on
  `torque-cc-backend` only.

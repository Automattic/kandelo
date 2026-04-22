# Phase 5: Torque CC Backend — d8 Link, Interpreter Dispatch, JS-Linkage, First Real Smoke Test Plan

> **STATUS: SUPERSEDED (2026-04-22).** Tasks 5.1–5.3 landed as
> written (baseline capture, d8 build target, Script::Run cctest
> scaffold). Task 5.4 spike concluded that both Shape A and Shape B
> as described below require either architecture-specific assembly
> generation or heavy V8 bootstrap surgery (~800+ LoC) to bridge
> V8's register-based builtin ABI to our C-ABI emitted functions.
> Plan's own escalation trigger for Task 5.4 fired. The
> V8-intent-preserving path — translate to V8's existing CPP-builtin
> ABI and piggyback `AdaptorWithBuiltinExitFrameN` — supersedes
> this plan. See
> `examples/libs/nodejs/verification.md` section "Phase 5 Spike —
> Interpreter Dispatch (Task 5.4, 2026-04-22)" for the full
> analysis, and the revised plan at
> `docs/plans/2026-04-22-torque-cc-backend-phase5-revised.md` (to
> be drafted in a fresh session via `superpowers:writing-plans`).
> Tasks 5.5–5.13 of this document were never executed; they assumed
> the Phase-4 emission shape and are no longer valid as written.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the gap between Phase 4's direct-call proof-of-life and a
running V8 shell that dispatches a translated Torque builtin through V8's
own interpreter entry path. Concretely: (1) build `d8` in `out/Release`
with the kCCBuiltins patch applied; (2) wire translated builtins through
`Builtins::code(Builtin)` so the interpreter can find them; (3) implement
JavaScript-linkage emission (receiver/newTarget/target/dispatchHandle
unpacking) so the canonical `Array.isArray` can be translated; (4) stand
up the hand-written CSA-replacement ledger at
`examples/libs/nodejs/csa-builtins/` for builtins we discover aren't in
Torque; (5) land the first C++-driven d8 smoke test that executes a
Torque-CC-translated builtin through V8's interpreter rather than via a
direct function-pointer call. Phase 5 is the first phase where V8's own
machinery invokes our generated code — everything prior went through
hand-written forward declarations.

**Architecture:** Same layering as Phase 1–4. V8 edits continue as
commits on the Node.js clone at `examples/libs/nodejs/build/node/`,
re-exported into the single consolidated patch at
`examples/libs/nodejs/patches/v8-torque-cc-builtins.patch`. The worktree
holds plan + fixtures + harness + build scripts + verification log + CSA
replacement ledger. New surface area in Phase 5:

- **d8 build target.** Phase 4 built `mksnapshot` + `v8_snapshot` +
  `cctest`; `d8` was never linked. Phase 5 extends the build script (or
  forks it into `build-v8-host-phase5.sh`) to add `ninja -C out/Release
  d8` and verifies the executable runs an empty-whitelist script
  (`print("hi")`, `print(1+2)`) — proving the patch remains neutral for
  d8's entrypoint under an empty whitelist.

- **Interpreter dispatch integration.** Phase 4's cctest invokes
  `Builtin_TorqueCcTest_Return(...)` as a plain C++ call — never touches
  `Builtins::code(Builtin)`, the interpreter, or V8's entry table. Phase
  5 investigates how jitless V8 dispatches to builtins (the
  `builtin_table[]` + `Code` object indirection in
  `src/builtins/builtins.cc:149` + interpreter handlers in
  `src/interpreter/interpreter-generator.cc`) and picks one of two
  concrete integration shapes:
  - **Shape A — Code-object trampoline.** Install a minimal `Code`
    object per Torque-CC builtin whose `instruction_start` jumps to the
    C++ function. Keeps `Builtins::code` signature-compatible. Requires
    understanding how V8's existing CPP-builtin `Code` objects are
    allocated during bootstrap.
  - **Shape B — Interpreter-side bypass.** Patch the interpreter's
    builtin-dispatch path to consult `Builtins::TorqueCcEntryOf` first
    for Torque-CC builtins and fall through to the normal builtin_table
    otherwise. Keeps the Code-object layer untouched but requires
    modifying every builtin-dispatch site.

  Task 5.4 is the spike that picks the shape; Task 5.8 implements it.

- **JavaScript-linkage ABI emission.** Phase 4's `Visit(Builtin*)` path
  has a 3-way switch (non-whitelisted → stub comment; whitelisted +
  JS-linkage → `(JS linkage deferred)` comment; whitelisted + stub-kind
  → real emission at `implementation-visitor.cc:635-713`). Phase 5
  replaces the middle branch with real emission that mirrors the
  existing CSA path at `implementation-visitor.cc:731-856`:
  - Unpack `context` / `receiver` / `newTarget` / `target` /
    `dispatchHandle` from the JS calling convention's argument slots.
  - For varargs-JS builtins: build a `CodeStubArguments`-equivalent
    struct (C++ uses `JavaScriptArguments` at
    `src/execution/arguments.h`; investigate in Task 5.9).
  - Match the `Descriptor::kContext` / `Descriptor::kReceiver` /
    `Descriptor::kJSTarget` / `Descriptor::kJSNewTarget` /
    `Descriptor::kJSDispatchHandle` slot indices that the CSA path
    uses — these come from the `CallInterfaceDescriptor` machinery at
    `src/codegen/interface-descriptors.h`. CC path needs an equivalent
    source for runtime-computed argument addresses.

  Task 5.9 is the spike (read the CSA code, write a design note); Task
  5.10 is the implementation; Task 5.11 whitelists the first JS-linkage
  builtin (`ArrayIsArray`) and adds its fixture + golden.

- **CSA replacement ledger.** Some builtins V8 ships are NOT written in
  Torque — they live in `src/builtins/builtins-*.cc` as hand-written CSA
  (CodeStubAssembler) C++. When a d8 smoke test forces a non-Torque
  builtin, Phase 5 creates a hand-written shim at
  `examples/libs/nodejs/csa-builtins/builtins-<group>.cc` and registers
  it via a dispatch-table override. The ledger at
  `examples/libs/nodejs/csa-builtins/README.md` records every shim
  written. Phase 5's target is infrastructure + the first 1–2 shims; the
  bulk lands in Phase 6 under mjsunit pressure.

- **First interpreter-driven smoke test.** Phase 5's success gate: a
  cctest gtest in `test/cctest/test_torque_cc_builtin.cc` (same file as
  Phase 4's, new test case) that compiles and runs a short JS string
  via V8's full pipeline — `isolate->GetCurrentContext()`,
  `Script::Compile`, `script->Run()` — where the script invokes a
  Torque-CC-translated builtin. First target: `Array.isArray([])`.

**Tech Stack:** same as Phase 4 — V8 13.6.233.17 (vendored at
`deps/v8/`), host clang, GN+ninja for V8, gyp+ninja for Node.js, gtest
for cctest. New for Phase 5: V8's `Script::Compile` + `script->Run()`
API (already exposed by `v8::internal::Isolate`); V8's
`NewContext()` for a real `NativeContext` (the default-constructed
`Tagged<Context>` used in Phase 4's DirectInvocation does NOT suffice
for JS-linkage or interpreter dispatch — deferred fix from Phase 4
follow-ups item "Default-constructed Tagged<Context>"). The d8 binary
itself is built as a V8 target, not a Node.js target — but we build it
via Node.js's gyp-generated ninja tree so the LITE_MODE defines match.

**Torque binary location (UNCHANGED — same gotcha as Phase 2/3/4):** use
`out/Release.baseline/torque` for the 13-fixture harness. `out/Release`
stays lite-mode and lacks `src/wasm/wasm-objects.tq`. Rebuild
Release.baseline after any patch change.

**Stock `.tq` file list (UNCHANGED):** the harness's grep pattern
`"(src|test|third_party)/[^"]*\.tq"` in `deps/v8/BUILD.gn` — 245 files.

**Branch / worktree policy (CONTINUATION — do NOT branch off main):**
- Worktree: `/Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend`
- Branch: `torque-cc-backend` (PR #306, OPEN, accumulating)
- Phase 5 stacks commits on top of worktree tip `0c1c85890` (Phase 4
  doc) and Node.js clone tip `2b408bfb` (Phase 4 smoke test).
- Do NOT `git reset --hard`, do NOT rebase onto main, do NOT open a new
  PR — Phase 5 pushes to the same remote branch backing #306.
- Re-export the consolidated patch at every Phase-5 commit that touches
  the V8 clone: `cd build/node && git format-patch
  9fe7634c..HEAD --stdout > ../../patches/v8-torque-cc-builtins.patch`.
  Each new clone commit grows the commit count (currently 42).
- V8 clone commit identity is `build@wasm-posix-kernel.local`; worktree
  commits use default identity. This is a long-standing invariant.

**Regression floor (MUST be preserved):**
- **Non-whitelisted torque output sha:**
  `a5195c0258fd9af9415e9d41f0c2e38237989c1b`. Phase 5 adds macro-body
  emissions for newly whitelisted JS-linkage builtins AND modifies
  `Visit(Builtin*)` to emit real JS-linkage bodies — but the
  non-whitelisted path (the Phase-1 comment stub) MUST NOT change.
  Task 5.1 re-snapshots and Task 5.N re-verifies.
- **Phase 4 13-fixture harness:** all 13 goldens
  (`call-builtin`, `call-builtin-pointer`, `call-csa-macro-and-branch`,
  `call-runtime`, `call-torque-macro`, `goto-external`,
  `make-lazy-node`, `namespace-constant`, `push-builtin-pointer`,
  `push-uninitialized`, `return`, `store-bit-field`, `store-reference`)
  MUST still pass byte-exact diffs. Phase 5 fixtures ADD to this set.
- **Phase 4 cctest results:** `TorqueCcBuiltinTest.DirectInvocation` +
  `TorqueCcBuiltinTest.DispatchTableLookup` MUST still PASS. Phase 5's
  new test cases extend this test file; existing cases stay green.
- **Phase 4 consolidated patch count:** 42 commits on the clone. Phase 5
  grows the count by roughly one per V8 edit; final count recorded in
  Phase 5 Summary.

**Invariants (do not break):**
- Stock V8 builtins (anything not in the whitelist) continue to hit the
  Phase 1 comment-stub path in `Visit(Builtin*)`.
- The `kCSA` / `kCC` / `kCCDebug` passes stay byte-identical to Phase 4
  (the sha gate above).
- `catch_block` stays `ReportError` unless Task 5.12 or later
  specifically finds that a d8 smoke test can't progress without it.
  Same discipline Phase 4 used for struct-typed label values.
- `TailCallInstruction` from `CallBuiltin` / `CallBuiltinPointer` stays
  `ReportError` unconditionally for Phase 5. First d8 smoke test targets
  (`print`, `Array.isArray([])`) do not tail-call.
- Every new whitelisted builtin gets a fixture + golden file. Same rule
  as every prior phase.
- Every V8 edit lands as a commit on the Node.js clone; worktree holds
  fixtures, harness, verification.md, consolidated patch, Phase 5 build
  script, csa-builtins/ ledger, and this plan. Never hand-edit the patch
  file — re-export with `git format-patch`.

**Out of scope for Phase 5** (explicit):
- Tail-calls from `CallBuiltin` / `CallBuiltinPointer`. Stays `ReportError`.
- Runtime exception handling via `catch_block`. Stays `ReportError`
  unless a target d8 smoke test cannot progress without it (escalation
  path: revisit Phase 5 scope with the user, do not implement
  silently).
- mksnapshot integration crossing a translated builtin. If a d8 smoke
  test is blocked on snapshot serialization of a Torque-CC pointer,
  stop and escalate — this is a documented Phase 5+ follow-up but the
  approach needs design work.
- Struct-typed label values. Stays `ReportError`. First fixture that
  forces it triggers a sub-task; none of Phase 5's planned fixtures
  (`ArrayIsArray`, 1–2 stub-linkage builtins TBD in Task 5.6) use
  struct labels.
- Wasm32 cross-compile. Phase 7+.
- Full mjsunit. Phase 6.
- More than 1–2 CSA shims. The full backlog lands under Phase 6 mjsunit
  pressure; Phase 5 proves the ledger infrastructure works by writing
  the first shim(s) that Phase 5's d8 smoke tests force.

**Phase-4 lessons Phase-5 inherits** (from `verification.md` "Plan
deviations surfaced during Phase 4 implementation"):

1. **Duplicate-emission prevention via the `InlineDefinition` flag.**
   Phase 4 introduced a separate 0x80 flag on `FUNCTION_FLAG_LIST`
   distinct from `SetInline()` so kCCBuiltins macro bodies are marked
   `inline` in the .cc (ODR-legal across translation units) without
   leaking into stock kCC output. New macros referenced by Phase 5's
   whitelisted builtins follow the same discipline — the
   `GenerateFunction` arm already sets `InlineDefinition` under
   kCCBuiltins, no additional work needed per-fixture. But: if Task 5.1
   reveals the non-ccbuiltins sha has drifted, check first for a
   regression in the `PrintBeginDefinition` path (the likely culprit is
   another accidental `inline` emission widening).

2. **Feature-flag propagation.** Phase 4 had to propagate `V8_LITE_MODE`,
   `V8_ENABLE_LEAPTIERING`, `V8_ENABLE_SPARKPLUG`, `V8_ENABLE_MAGLEV`,
   `V8_ENABLE_TURBOFAN`, `V8_INTL_SUPPORT` to cctest's gyp target. Phase
   5 adds **d8** as a build target — verify the same defines apply. The
   `Builtin` enum ordering also matters across `d8 <-> libv8_snapshot
   <-> cctest` now (not just cctest <-> libv8); misalignment causes
   silent `TorqueCcEntryOf` mis-dispatch. Task 5.2 verifies the d8
   target's defines match.

3. **Include-preamble in `-tq-ccbuiltins.cc`.** Phase 4 found that once
   a real body links (Task 4.9), the file needs `#include` lines for
   `src/base/macros.h` + `src/execution/isolate.h` +
   `src/objects/contexts.h` + `src/objects/smi.h` +
   `src/objects/tagged.h`. Phase 5's new whitelisted builtins may need
   additional includes — `src/objects/js-array.h` for `JSArray`,
   `src/objects/js-proxy.h` for `JSProxy`, `src/objects/fixed-array.h`
   for typeswitch dispatches, etc. The include preamble emission at
   `ImplementationVisitor::GenerateImplementation` is a single point —
   extend it, don't split it per-fixture.

4. **Default-constructed `Tagged<Context>` is insufficient for JS
   linkage.** Phase 4's DirectInvocation test uses
   `Tagged<Context>{}` because `TorqueCcTest_Return` ignores context.
   `Array.isArray` touches context (via `runtime::ArrayIsArray` for
   JSProxy). Phase 5's cctests must obtain a real `native_context()`:
   `isolate_->raw_native_context()` after `isolate_->Init()`. The
   `-inl.h` conflict Phase 4 dodged by avoiding `isolate-inl.h` does
   NOT apply to `raw_native_context()` — that method is declared in
   `src/execution/isolate.h`. Task 5.3 verifies this path works.

5. **Ninja textual-include drift.** `builtins.cc`'s textual include of
   `torque-generated/builtins-cc-table.inc` is not tracked by ninja
   auto-deps. Phase 4 worked around this with `touch builtins.cc`.
   Phase 5 adds/edits the dispatch-table generation path (Task 5.8
   changes what goes into the .inc); `touch builtins.cc` remains the
   work-around. Declaring the dep in gyp is infrastructure work
   deferred to post-Phase-5.

---

## Task 5.1: Capture Phase 4 tip baseline

**Context:** Phase 5 must not regress (a) the non-whitelisted torque
output sha, (b) the 13-fixture harness goldens, (c) Phase 4's cctest
results. Snapshot these at Phase 4 tip (worktree `0c1c85890`, Node.js
clone `2b408bfb`) so later tasks have regression targets.

**Files:** writes scratch files to `/tmp/`. No commits from this task.

**Step 1: Confirm Phase 4 state at the tips**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git rev-parse HEAD                         # expect 0c1c85890
cd examples/libs/nodejs/build/node
git rev-parse HEAD                         # expect 2b408bfb
git log --oneline 9fe7634c..HEAD | wc -l   # expect 42
```

If any value differs, stop — Phase 4's state has drifted since the
handoff was written and the regression floor must be re-derived first.

**Step 2: Rebuild the 13-fixture harness; verify all green**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
bash examples/libs/nodejs/test/run-torque-fixtures.sh
# Expected: "13 passed, 0 failed"
```

**Step 3: Rebuild stock tq file list and capture non-whitelisted sha**

```bash
cd examples/libs/nodejs/build/node
TQ_FILES=$(grep -oE '"(src|test|third_party)/[^"]*\.tq"' deps/v8/BUILD.gn \
             | tr -d '"' | sort -u)
echo "$TQ_FILES" | wc -l            # expect 245
rm -rf /tmp/torque-baseline-phase5
mkdir -p /tmp/torque-baseline-phase5
echo "$TQ_FILES" | sed 's|[^/]*$||' | sort -u | while read d; do
  mkdir -p "/tmp/torque-baseline-phase5/$d"
done
./out/Release.baseline/torque \
  -o /tmp/torque-baseline-phase5 \
  -v8-root deps/v8 \
  $TQ_FILES > /tmp/phase5-baseline.log 2>&1
echo "exit=$?"
find /tmp/torque-baseline-phase5 -type f ! -name '*-tq-ccbuiltins.cc' \
  -print0 | sort -z | xargs -0 cat | shasum
# Expected: a5195c0258fd9af9415e9d41f0c2e38237989c1b
```

If the sha differs, stop — the baseline has drifted and Task 5.N's
regression gate would pass false. Investigate before proceeding.

**Step 4: Verify Phase 4 cctest results (if binaries present)**

```bash
CCTEST="./out/Release/cctest"
if [ -x "$CCTEST" ]; then
  "$CCTEST" --gtest_filter='TorqueCcBuiltinTest.*'
  # Expected: "2 tests from 1 test suite ran... [ PASSED ] 2 tests."
fi
```

If binaries are absent (cctest directory was cleaned since Phase 4 end),
record that fact and run Task 5.2 to rebuild before proceeding.

**Step 5: Record baseline metadata**

No commit. Write `/tmp/phase5-baseline-metadata.txt` with:
- Phase 4 worktree tip: `0c1c85890`
- Phase 4 clone tip: `2b408bfb`
- Patch commit count: 42
- Non-whitelisted sha: `a5195c02...`
- Harness: 13/13 passing
- cctest: `TorqueCcBuiltinTest.DirectInvocation`, `DispatchTableLookup` both PASS

---

## Task 5.2: Extend host build script to build d8 in out/Release

**Context:** Phase 4's `build-v8-host-phase4.sh` builds `mksnapshot +
v8_snapshot + cctest`. Phase 5 needs `d8` too. The d8 gyp target already
exists at `tools/v8_gypfiles/d8.gyp`; the question is whether Node's
`./configure --ninja --v8-lite-mode` includes it in the ninja graph, or
whether we need to pass it explicitly.

**Files:**
- Create: `examples/libs/nodejs/build-v8-host-phase5.sh` (copies Phase 4
  script, adds `ninja -C out/Release d8`).
- No clone-side V8 commits in this task.

**Step 1: Check whether d8 is already in the ninja graph**

```bash
cd examples/libs/nodejs/build/node
ls out/Release/d8 2>/dev/null && echo "already built" || echo "missing"
grep -E "build out/Release/d8\b" out/Release/build.ninja | head -3
```

If present, the existing Phase 4 `./configure --ninja --v8-lite-mode`
already includes d8.gyp — Step 2 just adds the ninja invocation. If
absent, Step 2 also needs to thread d8.gyp into the gyp entrypoint
(Node's `node.gyp` may not include it by default — inspect and decide).

**Step 2: Create `build-v8-host-phase5.sh`**

Copy `build-v8-host-phase4.sh` to `build-v8-host-phase5.sh`. Changes:
- Add `ninja -C out/Release d8` after the `ninja -C out/Release
  v8_snapshot` line.
- Phase 5 default whitelist starts at `V8_CC_BUILTINS_WHITELIST=""` (empty) so
  a from-scratch run verifies the patch is d8-neutral under an empty
  whitelist before layering on fixtures in later tasks.
- Echo d8 size at the end alongside Phase 4's listings.

If Step 1 showed d8 is NOT in the ninja graph, add a pre-configure
edit that injects `'tools/v8_gypfiles/d8.gyp:d8'` into the appropriate
Node.js gyp target's `dependencies` (likely `node.gyp`'s `node` target
or a new `dependencies` alias) — this is a Node.js-side edit, not V8.
Escalate to the user if the injection site is ambiguous.

**Step 3: Run the Phase 5 build script with empty whitelist**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
V8_CC_BUILTINS_WHITELIST="" bash examples/libs/nodejs/build-v8-host-phase5.sh
# Expected: builds succeed; d8 exists; cctest SKIPPED (per Phase 4
# conditional that only builds cctest when whitelist is non-empty).
```

**Step 4: Verify d8 runs a no-whitelist script**

```bash
cd examples/libs/nodejs/build/node
./out/Release/d8 -e 'print(1+2)'
# Expected stdout: "3"
./out/Release/d8 -e 'print("hello")'
# Expected stdout: "hello"
./out/Release/d8 -e 'print([1,2,3].length)'
# Expected stdout: "3"
```

These invocations exercise the interpreter without touching any
Torque-CC-whitelisted builtin. Success here proves: (1) the patch's
empty-whitelist path is d8-neutral; (2) `Builtins::TorqueCcEntryOf`
falls through to the `Address{}` sentinel cleanly (per Phase 4
`fae77eb7` "clarify TorqueCcEntryOf comment re empty whitelist"); (3)
gyp/ninja integration for d8 is intact.

**Step 5: Commit the new build script**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/build-v8-host-phase5.sh
git commit -m "nodejs: Phase 5 — host build script adds d8 to out/Release

Extends Phase 4's build-v8-host-phase4.sh with a ninja d8 target and
flips the default whitelist to empty so a from-scratch run proves the
kCCBuiltins patch is d8-entrypoint-neutral before Phase 5 begins
whitelisting real builtins."
```

If Step 2 required a Node.js-side gyp edit to include d8, that edit
lands as a separate commit on the Node.js clone (not the worktree)
and gets re-exported into the consolidated patch at Task 5.N.

---

## Task 5.3: Phase 5 d8-smoke-test scaffolding in cctest

**Context:** Phase 4's `test_torque_cc_builtin.cc` has two test cases
that invoke a builtin directly as a C++ function. Phase 5's ultimate
smoke test needs to compile + run a short JS string through V8 and
verify the result. Before implementing interpreter/JS-linkage
integration, stand up the harness pattern that future tasks extend.

**Files:**
- Modify (clone): `build/node/test/cctest/test_torque_cc_builtin.cc`.

**Step 1: Write a failing test first (TDD)**

Append to the existing file a new test case `Phase5ScriptRunSmoke` that:
- Creates a `v8::HandleScope`.
- Uses `v8::Isolate::GetCurrent()` + `NodeTestFixture`'s isolate to get
  a running isolate.
- Calls `v8::Local<v8::Context> ctx = v8::Context::New(isolate_);`.
- Enters the context.
- Compiles and runs the string `"1+2"`; expects result `== 3` via
  `->Int32Value(ctx).FromJust() == 3`.

This is a pure-interpreter test: no Torque-CC builtin involved. It
proves that a real context + Script::Compile + script->Run work in
Phase 4's NodeTestFixture harness with CSS+jitless + empty whitelist.

**Step 2: Run it — expect PASS (not fail) with empty whitelist**

```bash
cd examples/libs/nodejs/build/node
V8_CC_BUILTINS_WHITELIST="" bash ../../build-v8-host-phase5.sh
# Note: cctest is only built when whitelist is non-empty; override
# temporarily by setting whitelist to any trivially-present name:
V8_CC_BUILTINS_WHITELIST="TorqueCcTest_Return" \
  bash ../../build-v8-host-phase5.sh
./out/Release/cctest --gtest_filter='TorqueCcBuiltinTest.Phase5ScriptRunSmoke'
# Expected: PASS.
```

If it FAILS: either (a) `v8::Isolate::GetCurrent()` returns null in
NodeTestFixture (investigate fixture init path), (b) context creation
triggers a missing builtin (the error message identifies it; this
becomes Task 5.7's first CSA shim candidate), or (c) the configure
defines for cctest don't match libv8_snapshot's (Phase 4 follow-up
"feature-flag drift" — re-check the cctest target gyp).

If it PASSES, Phase 5's scaffolding works before any translation
surgery — the next tasks can layer on Torque-CC integration with
confidence the harness itself is sound.

**Step 3: Commit**

```bash
cd build/node
git add test/cctest/test_torque_cc_builtin.cc
git commit -m "v8 torque+node: Phase 5 scaffold — Script::Compile smoke in cctest

Appends a minimal '1+2' script-run test to test_torque_cc_builtin.cc so
Phase 5's later d8-smoke-test tasks have a validated harness shape to
extend. No Torque-CC builtin is invoked here — this test would pass
with the Phase 4 patch alone. Proves the NodeTestFixture isolate can
create a real Context and compile+run a trivial script under lite-mode
+ CSS, which Phase 4 DirectInvocation did not exercise."
```

Re-export the patch:

```bash
cd build/node
git format-patch 9fe7634c..HEAD --stdout > ../../patches/v8-torque-cc-builtins.patch
cd ../../..
git add patches/v8-torque-cc-builtins.patch
git commit -m "nodejs: Phase 5 — consolidated patch refresh (Phase 5 Task 5.3)"
```

---

## Task 5.4: Spike — investigate V8's jitless interpreter dispatch path

**Context:** Phase 4's cctest calls `Builtin_TorqueCcTest_Return(...)`
directly as a free function. V8's interpreter dispatches through
`Builtins::code(Builtin)` (`src/builtins/builtins.cc:149`), which
returns a `Tagged<Code>` from `isolate_->builtin_table()[]`. That
pointer is consumed by bytecode handlers via trampolines. To make the
interpreter actually invoke our translated builtin, we must either
(a) install a `Code` object per Torque-CC builtin whose
`instruction_start` is our C++ function pointer, or (b) patch the
dispatch path to consult `Builtins::TorqueCcEntryOf` for Torque-CC
builtins before falling back to builtin_table.

**Files:** no commits. Writes findings to `verification.md`.

**Step 1: Read the dispatch path top-to-bottom**

Files to read (all inside `build/node/deps/v8/`):
- `src/builtins/builtins.cc` — `Builtins::code`, `Builtins::set_code`,
  `Builtins::builtin_handle`, `GenerateOffHeapTrampolineFor*`.
- `src/builtins/builtins.h` — `Builtins::Kind` enum (TFJ / TFC / TFS /
  CPP / ASM / BCH etc.), `Builtins::KindOf`, `IsCpp`, `IsTorqueCc` (if
  Phase 4 added one; if not, adding is part of Task 5.8).
- `src/interpreter/interpreter.cc` — how bytecode handlers dispatch
  builtin calls (search for `Builtins::code`, `BUILTIN_CODE`,
  `kCallRuntime`, `kCallWithReceiver`).
- `src/execution/isolate.h` — `builtin_table()` layout + size
  (`Builtins::ToInt`). How the table is allocated and initialized
  during isolate bootstrap.
- `src/snapshot/embedded/embedded-data.{h,cc}` — embedded builtin
  trampolines + how mksnapshot populates them. Critical for
  understanding why jitless mode still has `Code` objects (they wrap
  static addresses into the embedded blob) and what a Torque-CC
  `Code`-object equivalent would look like.

Under lite-mode (jitless + no TurboFan/Sparkplug/Maglev), the
trampolines point to embedded data rather than generated machine code.
But the `Code` object shape is the same. This is the key insight Shape
A relies on.

**Step 2: Determine whether `Builtins::Kind` already has a slot for
our case**

Grep `deps/v8/src/builtins/` for `Kind::kTorqueCc`, `kTorqueCcBuiltins`.
If the patch's Phase 4 commits added one, note its existing usage.
Otherwise, adding a new kind is a Task 5.8 prereq.

**Step 3: Map out the concrete requirements for each shape**

Write to `verification.md` under a new `## Phase 5 Spike — Interpreter
Dispatch` heading:

**Shape A (Code-object trampoline):**
- Need: a new `Builtins::Kind::kTorqueCc` enum value.
- Need: modification to `SetupInterpreter` /
  `Builtins::InitializeIsolateData` / equivalent to allocate a `Code`
  object per Torque-CC builtin during bootstrap (before the builtin
  table is frozen). Inspect `src/init/bootstrapper.cc`
  `Genesis::CreateStrongRootsTable` and
  `src/builtins/builtins.cc::EmitInstructionStreamTable` — the
  allocation site likely lives there.
- Need: `instruction_start` of the `Code` object must be the C++
  function pointer. V8 normally stores a `Tagged<InstructionStream>`;
  for CPP builtins there's existing plumbing at
  `Code::set_instruction_stream`. If the existing CPP-builtin pathway
  already handles "native C function with ABI conversion", we can
  piggyback. If it requires generated assembly for the CPP ABI, Shape A
  is much larger than Shape B.
- Pro: interpreter side stays unchanged — any future path that reads
  `Builtins::code(Builtin::kArrayIsArray)` gets our Torque-CC function
  without knowing it.
- Con: bootstrap surgery + potential ABI mismatches with how V8's
  bytecode handlers call into the `Code` object's `instruction_start`
  (stack frame layout, register assignments on real V8; less relevant
  in jitless + interpreter-only mode since it's all C++ calls).

**Shape B (interpreter-side bypass):**
- Need: `Builtins::CodeOrTorqueCcEntry(Builtin)` that returns either a
  `Tagged<Code>` (current) or an `Address` (function pointer). Callers
  check a kind flag and dispatch accordingly.
- Need: modification of every interpreter bytecode handler that invokes
  a builtin. The handler list lives in `src/interpreter/interpreter-
  generator.cc` under `interpreter::Interpreter::Generate`. Estimate
  the number of touch points (grep for `Builtins::code(` or
  `Builtins::builtin_handle(` under `src/interpreter/`).
- Pro: avoids Code-object bootstrap surgery entirely.
- Con: pattern has to be replicated everywhere the interpreter
  dispatches to a builtin; easy to miss a site; maintenance burden on
  V8 uplifts.

**Step 4: Decision and design note**

Pick Shape A or Shape B. Document the decision in `verification.md`
with:
- Chosen shape + rationale.
- Touch-point list (file paths, line numbers where possible).
- Rough LOC estimate.
- Risk items + escalation triggers (e.g., "if the Code-object
  `instruction_start` call ABI requires generated assembly, escalate
  to user before implementing").

**Step 5: No commit; this is a measurement and decision recorded
in-file at Task 5.8's commit.**

---

## Task 5.5: CSA replacement ledger — scaffolding

**Context:** Phase 5 is the first phase that runs real JS through V8.
Any builtin invocation that hits a builtin NOT in Torque (i.e., written
in hand-rolled CSA C++ at `src/builtins/builtins-*.cc`) will need a
hand-written Torque-CC-compatible shim. The ledger + directory
infrastructure is Phase 5's responsibility; the first 1–2 shims land
when Task 5.12's d8 smoke test forces them.

**Files:**
- Create: `examples/libs/nodejs/csa-builtins/README.md`.
- Create: `examples/libs/nodejs/csa-builtins/shims.gypi` (empty
  sources list; Phase 5 populates when first shim lands).
- Modify: `build/node/tools/v8_gypfiles/v8.gyp` — add a new target
  `torque_cc_csa_shims` that pulls sources from
  `examples/libs/nodejs/csa-builtins/shims.gypi` and is included in
  the libv8 link path. Deferred to Task 5.12 first-shim moment if
  easier to land atomically with a real source.

**Step 1: Write the ledger README**

```markdown
# Hand-written CSA-replacement shims (Torque CC backend)

This directory holds C++ implementations that stand in for V8 builtins
whose source is NOT available in Torque — typically builtins at
`deps/v8/src/builtins/builtins-<group>.cc` written directly against
`CodeStubAssembler`. Our Torque-CC backend can only translate Torque
sources; CSA-only builtins need hand-written equivalents.

## When to write a shim

Write one when:
1. A Phase 5+ d8 smoke test / mjsunit run fails with "missing builtin
   body for `<Name>`" or crashes inside a `Builtin_<Name>` that has no
   translated `.tq` body.
2. Inspection of `deps/v8/src/builtins/` confirms `<Name>` lives only
   in CSA C++, not in any `.tq` file.

## Shape of a shim

Each shim file is a single `.cc` under this directory:

    // File: builtins-<group>.cc
    #include "src/builtins/builtins.h"
    #include "src/execution/isolate.h"
    #include "src/objects/tagged.h"
    // + whatever `<Name>` needs

    namespace v8::internal {

    // Must match the signature `Builtins::TorqueCcEntryOf` expects —
    // i.e., the JS-linkage or stub-linkage shape that the CSA source
    // generates. Verify by comparing against
    // `deps/v8/src/builtins/builtins-<group>.cc`.
    Tagged<Object> Builtin_<Name>(Isolate* isolate,
                                  Tagged<Context> context,
                                  /* args */) {
      // port the CSA logic to plain C++
    }

    }  // namespace v8::internal

Register the shim's `Builtin::k<Name>` -> `&Builtin_<Name>` pair into
the dispatch table via a supplementary include that feeds
`builtins-cc-table.inc`. (Mechanism: Task 5.12 first-shim moment
decides whether this is an extra torque X-macro list or a
shims-specific include. Record the chosen mechanism here.)

## Ledger

| Builtin | Group | Shim file | Phase | Notes |
|---------|-------|-----------|-------|-------|
| _(none yet)_ | | | | |
```

**Step 2: Write the (empty) shims.gypi stub**

```
{
  'variables': {
    'csa_builtin_shims_sources': [
      # Entries appended in Phase 5 Task 5.12+ and Phase 6 mjsunit work.
    ],
  },
}
```

**Step 3: Commit**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/csa-builtins/
git commit -m "nodejs: Phase 5 — CSA-replacement ledger scaffold

Creates examples/libs/nodejs/csa-builtins/ with a README that
documents when and how to write a hand-written shim for a V8 builtin
whose source is CSA-only (not Torque). shims.gypi is empty;
populating it is Task 5.12's responsibility at the first-shim
moment. No V8 changes in this commit."
```

No clone-side commit; no patch re-export.

---

## Task 5.6: Spike — pick the first non-JS-linkage builtin to whitelist

**Context:** The handoff doc suggests `ArrayIsArray` as the canonical
Phase 5 target, but `ArrayIsArray` is `javascript builtin` (JS linkage)
— blocked by Task 5.9/5.10. Phase 5 needs a SMALLER first step: a
stub-linkage builtin that exercises more instructions than Phase 2's
`TorqueCcTest_Return` but stays inside the existing Phase 4 emission
path.

**Files:** no commits. Writes findings to `verification.md`.

**Step 1: Find stub-linkage candidates in V8**

Stub-linkage means `builtin` (no `javascript` prefix). Scan
`deps/v8/src/builtins/*.tq` for `^\s*(transitioning\s+)?builtin\s+\w+(?!\s*\()` — basically lines
that declare a stub-linkage builtin. Favor small bodies (5–20 lines),
no `otherwise`/`deferred`/`typeswitch`/`try`, single return.

**Step 2: Classify candidates by instruction coverage**

For each candidate, inspect its body for the instruction mix. Prefer
one that exercises:
- `Return` (already covered, baseline)
- `LoadReference` (`.field` access on a struct/object)
- `CallRuntime` (a `runtime::Foo(...)` call)
- `Branch` + `Goto` (from `if (...)`)
- `PushBuiltinPointer` (reference to another builtin — indicates a
  non-trivial flow)

Avoid candidates that require `catch_block`, tail calls, struct-typed
label values, or hand-written CSA dependencies (Phase 5 defers those).

**Step 3: Pick one and record rationale**

Write to `verification.md` under `## Phase 5 Spike — First Whitelist
Expansion`:
- Chosen builtin name + file:line.
- Body source.
- Instruction coverage explicit list.
- Expected emission shape (rough draft of generated C++; confirm by
  running Task 5.7 and diffing).

**Escalation:** if no suitable candidate exists (every stub-linkage
builtin pulls in a CSA-only dependency or deferred instruction), flag
it to the user — we may need to synthesize a new `test_cc::` fixture
that's larger than Phase 4's `TorqueCcTest_Return` but still trivial,
similar to how Phase 2 did it.

---

## Task 5.7: Whitelist the Task-5.6 candidate; verify fixture + golden

**Context:** Lands the first Phase 5 whitelisted builtin — a
stub-linkage one — end-to-end: fixture + golden + harness pass + host
build + cctest DirectInvocation-shape test that calls it as a plain
C++ function (no interpreter dispatch yet — that's Task 5.8). Mirrors
Phase 4 Task 4.9's shape.

**Files:**
- Create: `examples/libs/nodejs/test/torque-fixtures/<candidate>.tq`
  (if the chosen builtin needs a fixture; if whitelisting a
  real-V8-tree builtin like `ArrayIsArray_Inline`, no fixture needed —
  the whitelist entry alone drives emission).
- Create: `examples/libs/nodejs/test/torque-fixtures/golden/<candidate>-tq-ccbuiltins.cc`.
- Modify (clone): `build/node/test/cctest/test_torque_cc_builtin.cc`
  to add a `TorqueCcBuiltinTest.<Candidate>DirectInvocation` test.
- Modify: `examples/libs/nodejs/build-v8-host-phase5.sh` default
  whitelist to include the candidate name (comma-separated CSV).

**Step 1: Write/select the fixture**

If Task 5.6 picked a V8-tree builtin: no fixture needed. Skip to Step 2.

If Task 5.6 decided we need a new synthetic fixture (e.g.,
`TorqueCcTest_LoadRefReturn`), write it under
`test/torque-fixtures/<name>.tq` mirroring Phase 2/3/4 fixture style.

**Step 2: Run the harness; generate the golden**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
UPDATE_GOLDEN=1 bash examples/libs/nodejs/test/run-torque-fixtures.sh
git diff examples/libs/nodejs/test/torque-fixtures/golden/
# Inspect new golden file for correctness — does the emitted C++ look
# like what we'd hand-write? Red flags: unresolved TqRuntime_<foo>
# symbols (macro body emission missed a trigger), unexpected
# `ReportError`, wrong include set at top-of-file.
```

If the golden looks correct, re-run without `UPDATE_GOLDEN` to confirm
it is stable:

```bash
bash examples/libs/nodejs/test/run-torque-fixtures.sh
# Expected: "14 passed, 0 failed" (or N+1 where N was Phase 4 total).
```

**Step 3: Re-run the host build with updated whitelist**

```bash
V8_CC_BUILTINS_WHITELIST="TorqueCcTest_Return,<candidate>" \
  bash examples/libs/nodejs/build-v8-host-phase5.sh
```

Expected: compile succeeds. If it fails with "undefined reference to
`TqRuntime_<macro>_N`", Phase 4's macro-body emission path missed a
trigger for this new builtin's macro dependency — investigate
`implementation-visitor.cc` `EnsureInCCBuiltinsOutputList` (Phase 4
deviation note "MakeLazyNode needs its own trigger"). Adding a new
trigger is a sub-commit.

If it fails with missing `#include`, extend Phase 4's include preamble
at `ImplementationVisitor::GenerateImplementation`; regenerate
goldens; re-run harness.

**Step 4: Write the DirectInvocation test**

Append a `TorqueCcBuiltinTest.<Candidate>DirectInvocation` test case
to `test_torque_cc_builtin.cc`. Signature-match pattern is the Phase 4
`DirectInvocation` case:
- Forward-declare the emitted free function.
- Construct inputs.
- Call directly. Verify output.

**Step 5: Build and run the cctest**

```bash
ninja -C build/node/out/Release cctest
./build/node/out/Release/cctest \
  --gtest_filter='TorqueCcBuiltinTest.*'
# Expected: Phase 4 cases + the new case all PASS. Count = N+1.
```

**Step 6: Commit per emission change, per harness refresh, per cctest
edit**

Typical commit chain on the clone:
1. `torque: trigger macro-body for <candidate>` (only if Step 3
   surfaced a missing trigger)
2. `torque: extend kCCBuiltins include preamble for <candidate>`
   (only if needed)
3. `v8 torque+node: whitelist <candidate> + direct-call cctest`

Worktree-side commit: fixture, golden, updated build script default.
Re-export the patch after clone commits:

```bash
cd build/node
git format-patch 9fe7634c..HEAD --stdout > ../../patches/v8-torque-cc-builtins.patch
cd ../../..
git add examples/libs/nodejs/test/torque-fixtures/ \
        examples/libs/nodejs/build-v8-host-phase5.sh \
        examples/libs/nodejs/patches/v8-torque-cc-builtins.patch
git commit -m "nodejs: Phase 5 — whitelist <candidate> (Phase 5 Task 5.7)"
```

---

## Task 5.8: Implement interpreter dispatch integration (chosen shape)

**Context:** Phase 4 dispatch ends at `Builtins::TorqueCcEntryOf`.
V8's interpreter never calls that — it calls `Builtins::code(Builtin)`
and runs the returned `Tagged<Code>`'s `instruction_start`. Task 5.4
chose Shape A (Code-object trampoline) or Shape B (interpreter
bypass). This task implements the chosen shape.

**Files (clone-side V8 edits):** depend on shape. Rough shape:

**Shape A (Code-object trampoline):**
- `src/builtins/builtins.h` — add `Kind::kTorqueCc` to the enum.
- `src/builtins/builtins.cc` — modify `Builtins::InitializeIsolateData`
  or the equivalent bootstrap path to allocate a `Code` with `kind =
  kTorqueCc` and `instruction_start = TorqueCcEntryOf(builtin)` for
  each whitelisted Torque-CC builtin.
- `src/builtins/builtins-definitions.h` — per-builtin kind entry may
  need an override mechanism (Torque-CC builtins are generated-as-TFC
  from Torque's perspective but we want them marked kTorqueCc at
  runtime — research mechanism in Task 5.4 spike).
- `torque-generated/builtins-cc-table.inc` may need a companion
  `kind-table.inc` that lists which builtins got the kTorqueCc kind.

**Shape B (interpreter bypass):**
- `src/builtins/builtins.h` — add
  `bool Builtins::IsTorqueCc(Builtin)`.
- `src/builtins/builtins.cc` — `IsTorqueCc` returns true iff
  `TorqueCcEntryOf(builtin) != Address{}`.
- `src/interpreter/interpreter-generator.cc` — at every site that
  dispatches a builtin by its code pointer, branch on `IsTorqueCc`
  and call `TorqueCcEntryOf` directly instead of reading
  `builtin_table[]`. Number of sites TBD by Task 5.4.

**Step 1: Write a failing test (TDD)**

Add `TorqueCcBuiltinTest.<Candidate>ThroughBuiltinsCode` to
`test_torque_cc_builtin.cc` that:
- Obtains `Tagged<Code> code = Builtins::code(Builtin::k<Candidate>);`.
- Extracts `code->instruction_start()`.
- Casts to the function signature; invokes; asserts.

Under current state (pre-5.8 patch), this test FAILS — the code
object's instruction_start either returns a stub trampoline or the
default builtin_table[] entry (which is `IllegalBuiltin`).

Run: `./cctest --gtest_filter='TorqueCcBuiltinTest.<Candidate>ThroughBuiltinsCode'`
Expected (pre-patch): FAIL.

**Step 2: Implement the chosen shape**

Apply edits per the shape's file list. Each distinct concern goes into
its own clone commit:
- `v8 torque+builtins: add Builtin::Kind::kTorqueCc`
- `v8 builtins: allocate kTorqueCc Code objects during bootstrap`
- `v8 interpreter: dispatch kTorqueCc builtins via TorqueCcEntryOf`
  (Shape B only)
- `torque: emit kind-table.inc alongside builtins-cc-table.inc` (if
  needed)

**Step 3: Re-run the test — expect PASS**

```bash
ninja -C build/node/out/Release cctest
./build/node/out/Release/cctest \
  --gtest_filter='TorqueCcBuiltinTest.<Candidate>ThroughBuiltinsCode'
# Expected: PASS.
```

Also re-run the existing `TorqueCcBuiltinTest.DirectInvocation`,
`DispatchTableLookup`, and Phase 5 Task 5.7's case — verify still
PASSING.

**Step 4: Re-run the 14-fixture harness — verify goldens stable**

Shape A MAY require the `Visit(Builtin*)` emission to include a
`kind: kTorqueCc` marker in the C++ output. Shape B MAY leave the
goldens untouched. Confirm by running:

```bash
bash examples/libs/nodejs/test/run-torque-fixtures.sh
# Expected: 14/14 pass, no goldens changed.
```

If goldens changed, inspect — is the change legitimate (e.g., a new
include), or did we accidentally shift the non-whitelisted path? If the
latter, sha gate will fail at Task 5.N.

**Step 5: Commit chain**

Per concern, per clone commit. Re-export patch after each. Worktree
commit adds the cctest change and verification.md Phase 5 Spike update.

---

## Task 5.9: Spike — JavaScript-linkage ABI design

**Context:** `ArrayIsArray` and every user-callable V8 builtin uses
JS linkage: receiver + newTarget + target + dispatchHandle implicit
params, plus explicit params as varargs or fixed. CSA path at
`implementation-visitor.cc:731-856` unpacks these via
`UncheckedParameter<T>(Descriptor::kJSContext)`. C++ path needs an
equivalent source.

**Files:** no commits. Writes findings to `verification.md`.

**Step 1: Read the CSA emission top-to-bottom**

In `build/node/deps/v8/src/torque/implementation-visitor.cc:731-856`:
- What does `TorqueStructArguments` hold? (frame, base, length,
  actual_count).
- What does `CodeStubArguments` wrap? (pointer arithmetic into the
  interpreter-provided stack frame).
- For fixed-args builtins, what does
  `UncheckedParameter<T>(Descriptor::kFoo)` resolve to at runtime?
  (Read
  `src/codegen/interface-descriptors.h:~ArgumentRegisters` + the JS
  linkage descriptor class.)

**Step 2: Find the C++-callable analog**

V8's C++ code already calls JS-linkage functions — for example, the
builtin dispatch path under `Runtime::Call<Runtime::kArrayIsArray>` or
`Isolate::FunctionInvoke`. Look at `src/execution/arguments.h`
`BuiltinArguments` — this is the analog. It wraps a pointer + length
and exposes `receiver()`, `target()`, `new_target()`, `at<T>(int)`.

**Step 3: Decide the CC-emission shape**

Options:
- **Option X — `BuiltinArguments` directly.** Emit `Tagged<Object>
  Builtin_<Name>(Isolate* isolate, int argc, Tagged<Object>* args)`.
  Inside the body: `BuiltinArguments ba(argc, args);` then
  `Tagged<Object> receiver = ba.receiver(); Tagged<Object> target =
  ba.target(); ...` and bind these to the Torque `implicit` params.
  This matches V8's hand-written CPP builtin shape at
  `src/builtins/builtins-array.cc` etc.
- **Option Y — Unpacked explicit signature.** Emit a function taking
  each of context/receiver/newTarget/target/dispatchHandle as separate
  args. The dispatch-table site (or Shape A's Code-object trampoline)
  has to unpack BuiltinArguments first, then call with each slot as a
  param. Cleaner inside the translated body, uglier at the trampoline.

Likely: Option X. Hand-written CPP builtins use this shape; V8's
snapshot/interpreter infrastructure already knows how to call it.

**Step 4: Decision note in verification.md**

Heading `## Phase 5 Spike — JavaScript-Linkage ABI`. Record:
- Chosen option + rationale.
- Signature template.
- How `Descriptor::kFoo` maps to Option-X accessors.
- Implementation touch-point list (likely just
  `Visit(Builtin*)` and Phase 4's include-preamble).
- Risk items + escalation triggers.

**Step 5: No commit.**

---

## Task 5.10: Implement JavaScript-linkage emission in Visit(Builtin*)

**Context:** Task 5.9 picked an emission shape (likely Option X:
`BuiltinArguments`). This task replaces the Phase 4 `(JS linkage
deferred)` comment path with real emission.

**Files (clone-side V8 edits):**
- `src/torque/implementation-visitor.cc:625-633` — replace the
  `(JS linkage deferred to Phase 3)` branch with full emission.
  Structure mirrors the CSA path immediately below (lines 731+):
  iterate implicit parameters (`context`/`receiver`/`newTarget`/
  `target`/`dispatchHandle`), emit initialization from the
  `BuiltinArguments` wrapper per Option X, continue to the same
  parameter-binding + `Visit(body)` + `EmitGraph` pipeline used for
  stub-linkage.

**Step 1: Pick the smallest JS-linkage Torque builtin for the first
fixture**

Candidates: `ArrayIsArray` (array-isarray.tq, `javascript builtin`,
~15 lines, typeswitch over JSArray/JSProxy/JSAny). Another option: a
smaller `javascript builtin` from `src/builtins/*.tq` if one exists.

Default: `ArrayIsArray` — matches the user's handoff reference to
"the design's canonical example".

**Step 2: Write a failing fixture + golden (TDD)**

Create `examples/libs/nodejs/test/torque-fixtures/array-is-array-jslinkage.tq`
that re-declares a copy of ArrayIsArray under the `test_cc::` namespace
— or whitelist the real `ArrayIsArray` and add it via
`V8_CC_BUILTINS_WHITELIST=ArrayIsArray`. The latter is cleaner (no
duplicate declaration risk).

Generate the golden with current (pre-5.10) patch:

```bash
UPDATE_GOLDEN=1 V8_CC_BUILTINS_WHITELIST="ArrayIsArray" \
  bash examples/libs/nodejs/test/run-torque-fixtures.sh
```

Under Phase 4 patch, the golden will contain the
`// Builtin: ArrayIsArray (JS linkage deferred to Phase 3)` comment.
Commit this as the pre-5.10 baseline, then extend in Step 4.

Actually, simpler: skip the golden pre-step. Jump to Step 3.

**Step 3: Implement the JS-linkage emission**

Edit `implementation-visitor.cc:625-633` per Task 5.9's design note.
Apply include-preamble extensions as needed (`BuiltinArguments` is
declared in `src/execution/arguments.h`, may need
`src/builtins/builtins-utils.h`).

**Step 4: Regenerate the golden**

```bash
UPDATE_GOLDEN=1 V8_CC_BUILTINS_WHITELIST="ArrayIsArray" \
  bash examples/libs/nodejs/test/run-torque-fixtures.sh
# Inspect the new golden. Does it look like a readable version of
# what a hand-written CPP ArrayIsArray builtin would do?
```

**Step 5: Re-run the host build with ArrayIsArray whitelisted**

```bash
V8_CC_BUILTINS_WHITELIST="TorqueCcTest_Return,<task-5.7-candidate>,ArrayIsArray" \
  bash examples/libs/nodejs/build-v8-host-phase5.sh
```

Compile failures here typically mean: missing #include, wrong
signature shape (mismatch with `BuiltinArguments`), typeswitch
codegen issues. Each is a sub-commit to fix.

**Step 6: Add a DirectInvocation cctest for ArrayIsArray**

```cpp
TEST_F(TorqueCcBuiltinTest, ArrayIsArrayDirectInvocation) {
  v8::internal::Isolate* i_isolate =
      reinterpret_cast<v8::internal::Isolate*>(isolate_);
  v8::internal::Tagged<v8::internal::Context> native_context =
      i_isolate->raw_native_context();

  // Construct BuiltinArguments with a JSArray receiver.
  //   args[0] = receiver (the JSArray)
  //   call Builtin_ArrayIsArray(isolate, /* argc */, args);
  //   expect returned Tagged<Boolean> == True.
  // Details: TBD during implementation — look at
  // deps/v8/test/cctest/test-api.cc for existing BuiltinArguments
  // construction patterns.
}
```

Expected: PASS once Step 5 links cleanly.

**Step 7: Also add a BuiltinsCode dispatch test for ArrayIsArray**

Extends Task 5.8's interpreter-integration path to confirm it works
for JS-linkage too. Same shape as the `<Candidate>ThroughBuiltinsCode`
test, but for `Builtin::kArrayIsArray`.

**Step 8: Commit per concern**

Clone-side:
- `v8 torque: emit JS-linkage ABI for kCCBuiltins builtins`
- `torque: extend include preamble for BuiltinArguments` (if needed)
- `v8 torque+node: cctest ArrayIsArrayDirectInvocation +
  ArrayIsArrayThroughBuiltinsCode`

Worktree-side:
- Updated golden + updated default whitelist + patch re-export.

---

## Task 5.11: First real d8 smoke test — `Array.isArray([])` via cctest

**Context:** Task 5.10 made `ArrayIsArray` translatable and
direct-callable. Task 5.8 made `Builtins::code(Builtin::kArrayIsArray)`
return a `Tagged<Code>` that dispatches our function. This task ties
them together: run a short JS script through V8's Compile + Run +
interpreter pipeline, hitting `Array.isArray`, and verify the result.
This is Phase 5's success gate.

**Files:**
- Modify (clone): `build/node/test/cctest/test_torque_cc_builtin.cc` —
  add `TorqueCcBuiltinTest.ArrayIsArrayScriptRun`.

**Step 1: Write the failing test**

Similar to Task 5.3's `Phase5ScriptRunSmoke` but runs
`"Array.isArray([1,2,3])"` and expects `true`:

```cpp
TEST_F(TorqueCcBuiltinTest, ArrayIsArrayScriptRun) {
  v8::HandleScope scope(isolate_);
  v8::Local<v8::Context> ctx = v8::Context::New(isolate_);
  v8::Context::Scope ctx_scope(ctx);

  v8::Local<v8::String> src =
      v8::String::NewFromUtf8Literal(isolate_, "Array.isArray([1,2,3])");
  v8::Local<v8::Script> script =
      v8::Script::Compile(ctx, src).ToLocalChecked();
  v8::Local<v8::Value> result = script->Run(ctx).ToLocalChecked();

  EXPECT_TRUE(result->IsBoolean());
  EXPECT_TRUE(result.As<v8::Boolean>()->Value());
}
```

**Step 2: Run with current patch state — expect either PASS or
informative FAIL**

```bash
ninja -C build/node/out/Release cctest
./build/node/out/Release/cctest \
  --gtest_filter='TorqueCcBuiltinTest.ArrayIsArrayScriptRun'
```

Possible outcomes:
- **PASS**: Phase 5 scope goal achieved. Move to Step 5.
- **FAIL with wrong value**: interpreter dispatched through our builtin
  but the translated body mis-computed. Debug the generated C++ — add
  logging in the Torque-CC emitted file, re-whitelist, rebuild, re-run.
- **FAIL with crash / missing builtin `<Name>`**: a CSA-only builtin in
  `Array.isArray`'s indirect dependency graph is uncovered. Identify
  `<Name>` from the error; Task 5.12 writes its shim. Escalate to user
  if more than 2 missing builtins surface (Phase 5's scope allows 1–2
  shims; more blocks Phase 5).
- **FAIL with snapshot issue**: mksnapshot couldn't serialize a
  TorqueCc builtin pointer. This is Phase 4 follow-up "mksnapshot
  integration". Phase 5 escalates rather than implementing.
- **FAIL with catch_block ReportError surfacing mid-run**: a builtin in
  the Array.isArray path uses runtime exceptions. Phase 5 out-of-scope
  item. Escalate.

**Step 3: If FAIL-with-missing-CSA-builtin, land Task 5.12 shim and
return here**

**Step 4: When PASS, ALSO confirm the d8 binary runs the same script**

```bash
./build/node/out/Release/d8 -e 'print(Array.isArray([1,2,3]))'
# Expected stdout: "true"
./build/node/out/Release/d8 -e 'print(Array.isArray(42))'
# Expected stdout: "false"
./build/node/out/Release/d8 -e 'print(Array.isArray({}))'
# Expected stdout: "false"
```

The d8 path exercises the full V8 binary, not just cctest. If d8 FAILs
where cctest PASSes, the discrepancy is likely an initialization or
snapshot path — investigate before claiming Phase 5 done.

**Step 5: Commit**

```bash
cd build/node
git add test/cctest/test_torque_cc_builtin.cc
git commit -m "v8 torque+node: Phase 5 smoke — Array.isArray via Script::Run

First real d8-style smoke test for the Torque CC backend. Compiles
and runs 'Array.isArray([1,2,3])' through V8's Script::Compile +
script->Run pipeline under CSS+jitless+lite-mode. Dispatches into
the translated Torque-CC Builtin_ArrayIsArray via Builtins::code
indirection (Task 5.8's interpreter integration). Proof that a
real JS call hits generated-from-Torque C++ code end-to-end."
cd ../../..
cd build/node
git format-patch 9fe7634c..HEAD --stdout > ../../patches/v8-torque-cc-builtins.patch
cd ../../..
git add examples/libs/nodejs/patches/v8-torque-cc-builtins.patch
git commit -m "nodejs: Phase 5 — consolidated patch refresh (Task 5.11)"
```

---

## Task 5.12: First CSA shim (if forced by Task 5.11)

**Context:** Contingent task. If Task 5.11 Step 2 surfaced a missing
CSA-only builtin, write the first hand-written shim under
`examples/libs/nodejs/csa-builtins/` and register it into the dispatch
table.

**Files:** depend on the specific builtin. Typical shape:
- Create: `examples/libs/nodejs/csa-builtins/builtins-<group>.cc`.
- Modify: `examples/libs/nodejs/csa-builtins/shims.gypi` — add source.
- Modify: `examples/libs/nodejs/csa-builtins/README.md` — append
  ledger row.
- Modify (clone): `build/node/tools/v8_gypfiles/v8.gyp` — add a new
  source group that pulls `shims.gypi`, compiles into libv8 (or a
  side lib linked into cctest + libv8_snapshot).
- Modify (clone): mechanism to register the shim's address into
  `Builtins::TorqueCcEntryOf` (via a supplementary include feeding
  `builtins-cc-table.inc`; mechanism decided in Task 5.9 spike or
  Task 5.8 implementation).

**Step 1: Identify the CSA builtin and locate its source**

```bash
cd build/node/deps/v8
grep -rn "BUILTIN(<Name>)" src/builtins/
# or grep -rn "TF_BUILTIN(<Name>," src/builtins/
```

Identify the file (e.g., `src/builtins/builtins-array.cc`), read the
source, determine the logic.

**Step 2: Write the shim**

Port the CSA logic to plain C++. Avoid reaching for CSA types — use
`Tagged<T>` + `T::field` accessors directly.

**Step 3: Register the shim in the dispatch table**

Mechanism per Task 5.8 decision. Likely: append to
`torque-generated/builtins-cc-table.inc` via a supplementary
torque-generated file seeded from `shims.gypi`.

**Step 4: Re-run Task 5.11 — expect PASS**

**Step 5: Update the ledger README with the first row**

**Step 6: Commit worktree + clone edits separately, re-export patch**

---

## Task 5.13: Phase 5 Summary — verification.md + patch refresh + PR update

**Context:** Wrap up Phase 5. Update documentation, verify the
regression floor holds, finalize the consolidated patch, and push
to PR #306.

**Files:**
- Modify: `examples/libs/nodejs/verification.md` — add `## Phase 5
  Summary` section following Phase 4's template (result table + deviation
  notes + follow-ups for Phase 6).
- Modify: `examples/libs/nodejs/patches/v8-torque-cc-builtins.patch` —
  final re-export.
- Modify: PR #306 description (via `gh pr edit`) if the story shifted.
- Modify: memory file
  `/Users/brandon/.claude/projects/-Users-brandon-ai-src-wasm-posix-kernel/memory/project_torque_cc_backend.md`
  to reflect Phase 5 end state.

**Step 1: Regression gate — re-verify the Phase 4 regression floor**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
# 1. Non-whitelisted torque output sha
cd examples/libs/nodejs/build/node
TQ_FILES=$(grep -oE '"(src|test|third_party)/[^"]*\.tq"' deps/v8/BUILD.gn \
             | tr -d '"' | sort -u)
rm -rf /tmp/torque-phase5-final
mkdir -p /tmp/torque-phase5-final
echo "$TQ_FILES" | sed 's|[^/]*$||' | sort -u | while read d; do
  mkdir -p "/tmp/torque-phase5-final/$d"
done
./out/Release.baseline/torque \
  -o /tmp/torque-phase5-final \
  -v8-root deps/v8 \
  $TQ_FILES > /tmp/phase5-final.log 2>&1
find /tmp/torque-phase5-final -type f ! -name '*-tq-ccbuiltins.cc' \
  -print0 | sort -z | xargs -0 cat | shasum
# Expected: a5195c0258fd9af9415e9d41f0c2e38237989c1b (Phase 1/2/3/4/5 invariant)
```

```bash
# 2. 14+-fixture harness
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
bash examples/libs/nodejs/test/run-torque-fixtures.sh
# Expected: N/N pass where N = 13 (Phase 4) + Phase 5 new fixtures
```

```bash
# 3. cctest — all Phase 4 + Phase 5 cases
./examples/libs/nodejs/build/node/out/Release/cctest \
  --gtest_filter='TorqueCcBuiltinTest.*'
# Expected: all PASS. Pre-Phase-5 count = 2;
# expected Phase 5 count = at least 5 (DirectInvocation,
# DispatchTableLookup, Phase5ScriptRunSmoke, <Task-5.7>DirectInvocation,
# ArrayIsArrayDirectInvocation, ArrayIsArrayThroughBuiltinsCode,
# ArrayIsArrayScriptRun).
```

```bash
# 4. d8 end-to-end smokes
./examples/libs/nodejs/build/node/out/Release/d8 -e 'print(1+2)'
./examples/libs/nodejs/build/node/out/Release/d8 -e 'print("hi")'
./examples/libs/nodejs/build/node/out/Release/d8 -e 'print(Array.isArray([1,2,3]))'
./examples/libs/nodejs/build/node/out/Release/d8 -e 'print(Array.isArray(42))'
# Expected: 3, hi, true, false.
```

Any failure here blocks Phase 5 close — investigate before claiming
done.

**Step 2: Write the Phase 5 Summary in verification.md**

Follow Phase 4's shape. Result table + "Plan deviations surfaced during
Phase 5 implementation" + "Phase 5 follow-ups for Phase 6+" +
final patch-count + final clone tip.

**Step 3: Final consolidated patch re-export**

```bash
cd build/node
git format-patch 9fe7634c..HEAD --stdout > ../../patches/v8-torque-cc-builtins.patch
```

Inspect:

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
wc -l examples/libs/nodejs/patches/v8-torque-cc-builtins.patch
# Phase 4 was 2843. Phase 5 grows by roughly the Task 5.8 +
# 5.10 + 5.11 + 5.12 edits. No hard target.
cd build/node && git log --oneline 9fe7634c..HEAD | wc -l
# Phase 4 was 42. Phase 5 grows per clone-commit.
```

**Step 4: Commit worktree state**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/verification.md \
        examples/libs/nodejs/patches/v8-torque-cc-builtins.patch \
        docs/plans/2026-04-20-torque-cc-backend-phase5.md
git commit -m "nodejs: Phase 5 — verification.md Phase 5 Summary + consolidated patch"
```

**Step 5: Push to PR #306**

```bash
git push origin torque-cc-backend
```

**Step 6: Update PR #306 description**

Use `gh pr edit 306 --body-file <tmpfile>` to refresh the description.
Include: Phase 4 facts + Phase 5 additions (d8 link, interpreter
integration shape chosen, JS-linkage emission, ArrayIsArray E2E,
first CSA shim count). Keep the PR OPEN per user directive; do NOT
merge.

**Step 7: Update the memory file**

Rewrite
`/Users/brandon/.claude/projects/-Users-brandon-ai-src-wasm-posix-kernel/memory/project_torque_cc_backend.md`
to reflect: Phase 5 done (date); worktree tip; V8 clone tip;
consolidated patch commit count; Phase 6 starting point (full
mjsunit). Keep MEMORY.md index line ~150 chars.

---

## Regression floor (Phase 5 final — MUST pass at Task 5.13)

1. Non-whitelisted torque output sha = `a5195c0258fd9af9415e9d41f0c2e38237989c1b`.
2. Harness: all fixtures (Phase 4's 13 + Phase 5 additions) byte-exact.
3. Phase 4 cctest cases (`TorqueCcBuiltinTest.DirectInvocation`,
   `DispatchTableLookup`) still PASS.
4. Phase 5 new cctest cases all PASS (minimum:
   `Phase5ScriptRunSmoke`, `<Task-5.7>DirectInvocation`,
   `<Task-5.7>ThroughBuiltinsCode`, `ArrayIsArrayDirectInvocation`,
   `ArrayIsArrayThroughBuiltinsCode`, `ArrayIsArrayScriptRun`).
5. d8 smokes: `print(1+2)`, `print("hi")`,
   `print(Array.isArray([1,2,3]))`, `print(Array.isArray(42))` all
   produce expected output.
6. Consolidated patch re-applies cleanly on upstream `9fe7634c`.
7. PR #306 pushed, still OPEN, description refreshed.

---

## Escalation protocols (Phase 5)

Stop and ask the user before implementing if:

- **Task 5.4 spike** concludes Shape A requires >500 LoC of V8
  bootstrap surgery, or requires generating native assembly for the
  Code-object instruction_start. Ask user to choose between investing
  in Shape A vs. falling back to Shape B.
- **Task 5.9 spike** finds `BuiltinArguments` alone doesn't cover the
  varargs case (`ArrayIsArray` is fixed-args so this is unlikely to
  block; but a later varargs target may).
- **Task 5.11 Step 2** surfaces more than 2 missing CSA builtins. This
  indicates the Array.isArray path has a wider CSA footprint than
  expected — revisit scope.
- **Task 5.11 Step 2** surfaces a snapshot issue (`mksnapshot` can't
  serialize a Torque-CC pointer). This is the Phase 4 follow-up
  "mksnapshot integration" — Phase 5 escalates.
- **Task 5.11 Step 2** surfaces a `catch_block` ReportError. Phase 5
  scope explicitly defers exception handling.
- **Task 5.8 regression** — if the chosen shape breaks the
  non-whitelisted torque sha or the 13 Phase-4 goldens, investigate
  (likely a stray `output_type_` check) before commit.

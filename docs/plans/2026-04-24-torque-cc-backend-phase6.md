# Torque CC Backend Phase 6 — mjsunit Pressure on the kCCBuiltins Whitelist

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stand up an mjsunit pass-list against the Phase-5 host d8, then
expand the kCCBuiltins whitelist from `{ArrayIsArray}` outward by adding
one builtin (or a small family) at a time. Each addition surfaces a
real emitter / runtime-macro-shim gap; repair the gap atomically, then
move to the next builtin.

**Architecture:**
- **Infrastructure.** One new shell runner,
  `examples/libs/nodejs/test/run-mjsunit.sh`, invokes `d8 mjsunit.js
  <test>.js` against a curated pass-list and fails on any unexpected
  stderr / non-zero exit. No V8-test-runner integration — shell is
  sufficient for a growing list of individual tests.
- **Whitelist expansion.** The default whitelist in
  `build-v8-host-phase5.sh` (exported as `V8_CC_BUILTINS_WHITELIST`)
  grows by one builtin per green closure. Each builtin's addition is
  its own clone commit; each emitter/shim fix that turns a red build
  green is its own clone commit, following the Task-5.8 atomic pattern.
- **Verification gates.** The four existing gates stand unchanged
  (torque fixtures 15 goldens byte-exact; cctest ≥5 PASS; d8-smoke 10
  PASS; non-ccbuiltins anchor `d5c6d835…` stable). One new gate:
  `run-mjsunit.sh` passes its curated pass-list, starting with
  `array-isarray.js` and growing as each whitelisted builtin's mjsunit
  file is added. Phase 6 adds ScriptRun cctest cases per builtin
  (`TorqueCcBuiltinTest.ScriptRun<Builtin>`) and `d8-smoke.sh` probes
  per builtin so regressions surface before mjsunit.
- **Scope boundary.** Phase 6 targets the four non-transitioning
  `javascript builtin` entries in `number.tq`: `NumberIsFinite`,
  `NumberIsNaN`, `NumberIsInteger`, `NumberIsSafeInteger`. These share
  `ArrayIsArray`'s shape (simple JS-linkage, 1-arg, typeswitch or
  `SelectBooleanConstant`, no `transitioning` keyword, no `try`
  blocks, no varargs). Stretch target set: any of `ArrayOf` /
  `ArrayFrom` / `ArrayConcat` (`transitioning javascript builtin` —
  would exercise the deferred `catch_block` item if mjsunit forces
  it; formal go/no-go decision happens mid-phase, not up front).

**Tech Stack:** V8 Torque (C++), Torque-generated C++, d8, gtest
(cctest), bash. No wasm-posix-kernel / Rust / TypeScript changes in
Phase 6.

---

## Ground rules (from the Phase-6 kickoff prompt)

- Worktree: `/Users/brandon/.superset/worktrees/wasm-posix-kernel/torque-cc-backend`
- Branch: `torque-cc-backend` @ `06b1c99e9` — do NOT rebase, do NOT push
  to main. PR #306 updates when pushed.
- Clone: `examples/libs/nodejs/build/node/` tip `b046aa14`. 60 commits
  on top of upstream `9fe7634c`.
- Patch export: `examples/libs/nodejs/patches/v8-torque-cc-builtins.patch`
  (4577 lines, re-applies cleanly on `9fe7634c`).
- **Commit pattern.** Every atomic change in the clone → one commit in
  the clone (`b046aa14`-origin branch). Every "refresh the consolidated
  patch" → one worktree commit. Follow the Task-5.8 cadence: one defect
  per commit, clear Subject line, brief Body.
- **Use Opus 4.6+** for any subagents.
- **Triage every gap** into one of (a)–(d) from the kickoff prompt:
  (a) Real emitter bug → fix torque. (b) Missing runtime-macro shim
  → add to `runtime-macro-shims.h` or kCCBuiltins preamble.
  (c) CSA-only builtin → hand-written shim under
  `examples/libs/nodejs/csa-builtins/` + register via builtins-cc-table
  companion.  (d) Phase-7-class feature → record and defer.

## Hard stops (escalate to user, do not silently work around)

- Non-ccbuiltins anchor `d5c6d835…` drifts without a matching
  torque-source change.
- Any of the 5 existing cctest cases regresses.
- Any wasm-posix-kernel suite regresses (cargo / vitest / libc-test /
  POSIX / sortix / ABI).
- A deferred Phase-5 item (catch_block, tail-calls, struct labels,
  varargs, NamespaceConstant, %GetClassMapConstant) blocks progress for
  more than a day of focused work — each of these is a candidate
  sub-phase of its own and deserves its own plan.
- A Phase-6 attempt silently regresses libc-test / POSIX relative to
  main. (Phase 5's SDK-symlink environmental failures are expected and
  not a Phase-6 regression.)

## Phase-6 close criteria

Before marking Phase 6 complete, ALL of the following must hold:

1. ≥4 new kCCBuiltins-whitelisted JS-linkage builtins
   (`NumberIsFinite`, `NumberIsNaN`, `NumberIsInteger`,
   `NumberIsSafeInteger`) shipping green through cctest + d8-smoke +
   mjsunit.
2. `run-mjsunit.sh` covers ≥2 mjsunit files end-to-end
   (`array-isarray.js` + `es6/number-is.js`).
3. Total cctest count: ≥9 green (5 Phase-5 + 4 new ScriptRun per
   builtin — or a single parametrized case covering all four).
4. `d8-smoke.sh`: ≥18 probes green (10 Phase-5 + 2 per new builtin).
5. `run-torque-fixtures.sh`: still 15/15 byte-exact. Non-ccbuiltins
   anchor documented (either unchanged from `d5c6d835…`, or
   intentionally bumped in a dedicated commit with a clear reason and
   new sha pinned in verification.md).
6. Consolidated patch re-applies cleanly on `9fe7634c`. Line delta
   bounded: ≤6000 lines target; absolute cap ~8000 before a scope
   review.
7. `verification.md` gains a "Phase 6 Summary" section naming each new
   green builtin, each new emitter/shim fix landed, the new mjsunit
   pass-list, the new cctest counts, and an explicit table for the
   7 deferred items showing "landed in Phase 6" vs "still deferred".
8. wasm-posix-kernel suites pass per CLAUDE.md (expected 0 delta).

## Out-of-scope items explicitly deferred past Phase 6

- `catch_block` runtime exception handling — unless a Phase-6 target
  forces it, still `ReportError`. If forced: the first builtin that
  forces it is promoted to its own sub-phase (6A).
- Tail-calls from `CallBuiltin` / `CallBuiltinPointer` — still
  `ReportError`.
- Struct-typed label values — still `ReportError`.
- Varargs JS builtins (`IsVarArgsJavaScript`) — still `ReportError`.
  `ArrayOf` / `ArrayFrom` / `ArrayConcat` / `BooleanConstructor` will
  fail here, confirmed by inspection. Stretch-target inclusion
  requires lifting this deferral; decision is mid-phase, not now.
- Generator-emitted per-const `NamespaceConstant` helpers (to replace
  Task-5.8's hand-written `True_0` / `False_0`) — only when a new
  whitelist entry surfaces a missing `<Const>_0` that can't be handled
  by a one-line preamble addition.
- `%GetClassMapConstant` fast-path via free-function
  `TorqueClassHasMapConstant<T>()` — only when a whitelisted builtin
  surfaces a UNIQUE_INSTANCE_TYPE class using the fast path.
- Wasm32 cross-compile of the new Torque-CC Node.js toolchain —
  Phase 7+.

---

## Task 6.1: Stand up `run-mjsunit.sh`

**Files:**
- Create: `examples/libs/nodejs/test/run-mjsunit.sh`

**Step 1: Write the script**

```bash
#!/usr/bin/env bash
# examples/libs/nodejs/test/run-mjsunit.sh — Phase 6 mjsunit pass-list.
#
# Runs every file in PASS_LIST through the Phase-5 host d8 using V8's
# mjsunit.js harness (provides assertTrue / assertFalse / assertThrows
# / assertEquals). Each test is expected to run to completion with
# exit 0 and empty stderr. The "experimental features" banner is dropped.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_SRC="${HERE}/../build/node"
D8="${D8:-${NODE_SRC}/out/Release/d8}"
MJSUNIT_DIR="${NODE_SRC}/deps/v8/test/mjsunit"
if [ ! -x "$D8" ]; then
  echo "error: d8 not found or not executable at $D8" >&2
  echo "Run 'bash examples/libs/nodejs/build-v8-host-phase5.sh' first." >&2
  exit 1
fi
if [ ! -f "${MJSUNIT_DIR}/mjsunit.js" ]; then
  echo "error: mjsunit.js not found at ${MJSUNIT_DIR}" >&2
  exit 1
fi

# Pass-list grows as Phase 6 progresses. Each entry is a path relative
# to MJSUNIT_DIR. Adding a new entry requires its Torque builtins to be
# whitelisted and green through cctest + d8-smoke first.
PASS_LIST=(
  "array-isarray.js"
)

cd "${MJSUNIT_DIR}"
pass=0; fail=0
for test in "${PASS_LIST[@]}"; do
  if [ ! -f "${test}" ]; then
    echo "[FAIL] ${test} — missing"; fail=$((fail+1)); continue
  fi
  # mjsunit.js must be loaded before the test file. Drop d8's
  # experimental-features banner (stderr) the same way d8-smoke.sh does.
  if output="$("${D8}" mjsunit.js "${test}" 2>/dev/null)"; then
    if [ -n "${output}" ]; then
      echo "[FAIL] ${test} — unexpected output"
      echo "       ${output}"
      fail=$((fail+1))
    else
      echo "[pass] ${test}"
      pass=$((pass+1))
    fi
  else
    rc=$?
    echo "[FAIL] ${test} — d8 exit ${rc}"
    "${D8}" mjsunit.js "${test}" 2>&1 | head -20 | sed 's/^/       /'
    fail=$((fail+1))
  fi
done
echo
echo "mjsunit: ${pass} passed, ${fail} failed"
[ "${fail}" = 0 ]
```

Make it executable: `chmod +x examples/libs/nodejs/test/run-mjsunit.sh`.

**Step 2: Run it**

```bash
bash examples/libs/nodejs/test/run-mjsunit.sh
```

Expected: `mjsunit: 1 passed, 0 failed`. Confirms the runner works
against the already-whitelisted `ArrayIsArray`.

**Step 3: Commit in worktree**

```bash
git add examples/libs/nodejs/test/run-mjsunit.sh
git commit -m "nodejs: Phase 6 — mjsunit runner with array-isarray pass-list"
```

---

## Task 6.2: First expansion — whitelist `NumberIsFinite`

**Files:**
- Modify in clone: `examples/libs/nodejs/build/node/` — no source edit.
  Whitelist grows via `V8_CC_BUILTINS_WHITELIST` env override during
  build.
- Modify in worktree: `examples/libs/nodejs/build-v8-host-phase5.sh`
  (bump the default WHITELIST once green).

**Step 1: Rebuild with `NumberIsFinite` in the whitelist**

```bash
V8_CC_BUILTINS_WHITELIST="TorqueCcTest_Return,TorqueCcTest_JsReturn,ArrayIsArray,NumberIsFinite" \
  bash examples/libs/nodejs/build-v8-host-phase5.sh 2>&1 | tail -40
```

**Step 2: Triage the first failure**

Likely failures, in order of probability:

| Failure signal | Triage class | Likely fix |
|----------------|--------------|------------|
| `undefined reference to 'SelectBooleanConstant'` | (b) shim | Add `inline Tagged<Boolean> SelectBooleanConstant(bool, Isolate*)` to `runtime-macro-shims.h`. |
| `undefined reference to 'Convert<float64>(HeapNumber)'` | (b) shim | Already exists via `Object::NumberValue` — check and add if missing. |
| `undefined reference to 'Float64IsNaN'` | (b) shim | Wrap `std::isnan`. |
| `undefined reference to 'BranchIfFloat64IsNaN'` | (a) emitter | `Float64IsNaN` is a torque macro that expands to `BranchIfFloat64IsNaN`; whether this is shimmed or emitter-lowered depends on how torque decides. If `BranchIfFloat64IsNaN` appears as an external call, shim it. |
| Any `ReportError(...)` at torque time | (a) emitter | Inspect which deferred item (catch_block, varargs, struct label, NamespaceConstant) fires, and fix only if it's Phase-6-scope. |

Expected first failure for `NumberIsFinite` specifically (based on the
Torque source):

```tq
case (h: HeapNumber): {
  const number: float64 = Convert<float64>(h);
  const infiniteOrNaN: bool = Float64IsNaN(number - number);
  return Convert<Boolean>(!infiniteOrNaN);
}
```

`Float64IsNaN` is a torque macro (not extern) in `base.tq`, so it gets
lowered. It calls `BranchIfFloat64IsNaN` which IS extern. So the first
undefined ref likely is `BranchIfFloat64IsNaN`. `Convert<Boolean>` maps
to `SelectBooleanConstant`-shape. Read the actual build error before
writing the fix.

**Step 3: Fix the gap (one commit in clone)**

Apply the minimal fix. Example (for a `BranchIfFloat64IsNaN` shim —
actual fix depends on the actual error):

```cpp
// Addition to deps/v8/src/torque/runtime-macro-shims.h under
// namespace TorqueRuntimeMacroShims::CodeStubAssembler:
inline bool BranchIfFloat64IsNaN(double v, bool* label_Taken,
                                 bool* label_NotTaken) {
  if (std::isnan(v)) { *label_Taken = true; return false; }
  *label_NotTaken = true;
  return false;
}
```

Commit in clone:

```bash
cd examples/libs/nodejs/build/node
git add deps/v8/src/torque/runtime-macro-shims.h
git commit -m "runtime-macro-shims: <describe fix>

Surfaced by whitelisting NumberIsFinite in kCCBuiltins."
cd -
```

**Step 4: Rebuild and re-triage until green**

Repeat steps 1–3 until `ninja` returns exit 0 and
`./out/Release/d8 -e 'print(Number.isFinite(0))'` prints `true`.

**Step 5: Add ScriptRun cctest case**

In the clone, edit
`examples/libs/nodejs/build/node/test/cctest/test_torque_cc_builtin.cc`
to add:

```cpp
TEST_F(TorqueCcBuiltinTest, ScriptRunNumberIsFinite) {
  v8::HandleScope scope(isolate_);
  v8::Local<v8::Context> ctx = v8::Context::New(isolate_);
  v8::Context::Scope cscope(ctx);

  struct Case { const char* source; bool expected; };
  const Case cases[] = {
      {"Number.isFinite(0)",            true},
      {"Number.isFinite(1.5)",          true},
      {"Number.isFinite(-1.5)",         true},
      {"Number.isFinite(Infinity)",     false},
      {"Number.isFinite(-Infinity)",    false},
      {"Number.isFinite(NaN)",          false},
      {"Number.isFinite('0')",          false},
      {"Number.isFinite(null)",         false},
      {"Number.isFinite(undefined)",    false},
      {"Number.isFinite({})",           false},
      {"Number.isFinite(new Number(0))",false},  // per spec
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

Build + run:

```bash
cd examples/libs/nodejs/build/node
ninja -C out/Release cctest
./out/Release/cctest --gtest_filter='TorqueCcBuiltinTest.*'
cd -
```

Expected: 6/6 PASS (5 Phase-5 + ScriptRunNumberIsFinite).

Commit in clone:

```bash
cd examples/libs/nodejs/build/node
git add test/cctest/test_torque_cc_builtin.cc
git commit -m "cctest: add ScriptRunNumberIsFinite"
cd -
```

**Step 6: Add d8-smoke probes**

In worktree, extend `examples/libs/nodejs/test/d8-smoke.sh` with:

```bash
check 'print(Number.isFinite(0))'         'true'
check 'print(Number.isFinite(Infinity))'  'false'
```

Run:

```bash
bash examples/libs/nodejs/test/d8-smoke.sh
```

Expected: 12/12 PASS.

**Step 7: Bump build script default whitelist**

Edit `examples/libs/nodejs/build-v8-host-phase5.sh` — append
`,NumberIsFinite` to the `WHITELIST` default. Re-run without the env
override to prove the default is self-sufficient.

**Step 8: Refresh consolidated patch**

From the clone:

```bash
cd examples/libs/nodejs/build/node
git format-patch --stdout 9fe7634c..HEAD > ../../patches/v8-torque-cc-builtins.patch
cd -
wc -l examples/libs/nodejs/patches/v8-torque-cc-builtins.patch
```

**Step 9: Commit the worktree**

```bash
git add examples/libs/nodejs/build-v8-host-phase5.sh \
        examples/libs/nodejs/test/d8-smoke.sh \
        examples/libs/nodejs/patches/v8-torque-cc-builtins.patch
git commit -m "nodejs: Phase 6 — whitelist NumberIsFinite

Adds <N> clone commits: <list of clone commit subjects>.

cctest: 5 → 6 PASS (ScriptRunNumberIsFinite added).
d8-smoke: 10 → 12 PASS (Number.isFinite(0), Number.isFinite(Infinity)).
Patch: 4577 → <new> lines."
```

---

## Task 6.3: Extend mjsunit pass-list after NumberIsFinite is green

**Files:**
- Modify: `examples/libs/nodejs/test/run-mjsunit.sh`

**Step 1: Understand the test shape**

`deps/v8/test/mjsunit/es6/number-is.js` tests all four `Number.is*`.
Partial whitelisting (`NumberIsFinite` alone) likely won't make the
file pass — the other three builtins are still stub-linkage.

Document the decision: don't add `number-is.js` to the pass-list yet;
defer to Task 6.7 once all four are green.

**Step 2: No code change this task**

(No commit.)

---

## Task 6.4: Whitelist `NumberIsNaN`

Same shape as Task 6.2. `NumberIsNaN` has the same typeswitch
structure as `NumberIsFinite` (Smi → False, HeapNumber → check,
JSAnyNotNumber → False). If Task 6.2 surfaced all the relevant shims,
Task 6.4 may build green on first pass — verify; if it does, skip
fix-commits and go straight to cctest + d8-smoke + whitelist bump.

Expected commits:
- 0–1 clone commits for shim fixes (likely 0).
- 1 clone commit adding `ScriptRunNumberIsNaN` to test_torque_cc_builtin.cc.
- 1 worktree commit updating d8-smoke + whitelist default + patch.

Expected gates after task:
- cctest: 6 → 7 PASS.
- d8-smoke: 12 → 14 PASS.

---

## Task 6.5: Whitelist `NumberIsInteger`

`NumberIsInteger` is a one-liner:
```tq
return SelectBooleanConstant(IsInteger(value));
```

`IsInteger(JSAny)` is `extern macro`, so it's a pure function call.
Most likely surfaces a missing `IsInteger` shim.

Triage path:

- If `IsInteger` is defined in `deps/v8/src/numbers/conversions-inl.h`
  as a plain C++ function with the right signature, lift it via a
  runtime-macro-shim wrapper (class (b)).
- If it's CSA-only (lives in `code-stub-assembler-inl.h` /
  `code-stub-assembler.cc` as a CSA-generator-produced method), a
  plain-C++ port is needed (class (b), but bigger — likely 20–40
  lines). Still shim-territory, not CSA-replacement-ledger.

Expected commits:
- 1–3 clone commits (IsInteger shim + any helpers it calls).
- 1 clone commit adding cctest case.
- 1 worktree commit.

Expected gates after task:
- cctest: 7 → 8 PASS.
- d8-smoke: 14 → 16 PASS.

---

## Task 6.6: Whitelist `NumberIsSafeInteger`

`NumberIsSafeInteger`:
```tq
return SelectBooleanConstant(IsSafeInteger(value));
```

`IsSafeInteger(Object)` is `extern macro`. If it's implemented as
`IsInteger(x) && std::abs(x) <= 2^53 - 1`, the shim is one wrapper
plus Task-6.5's `IsInteger` shim.

Expected commits:
- 1–2 clone commits (shim + helpers).
- 1 clone commit adding cctest case.
- 1 worktree commit.

Expected gates after task:
- cctest: 8 → 9 PASS.
- d8-smoke: 16 → 18 PASS.

---

## Task 6.7: Enable `es6/number-is.js` in mjsunit pass-list

**Files:**
- Modify: `examples/libs/nodejs/test/run-mjsunit.sh`

**Step 1: Add to PASS_LIST**

Change:
```bash
PASS_LIST=(
  "array-isarray.js"
  "es6/number-is.js"
)
```

**Step 2: Run**

```bash
bash examples/libs/nodejs/test/run-mjsunit.sh
```

Expected: `mjsunit: 2 passed, 0 failed`. If any assert fails inside
`number-is.js`, triage against the value d8 actually returned —
typical causes are ABI / Tagged-pointer handling bugs that cctest's
fixed-value cases didn't cover (e.g. subnormal float64, extreme
large integers, boxed `new Number(0)`).

**Step 3: Commit**

```bash
git add examples/libs/nodejs/test/run-mjsunit.sh
git commit -m "nodejs: Phase 6 — mjsunit adds es6/number-is.js (all 4 Number.is* green)"
```

---

## Task 6.8: Exhaustive gate re-run

**Files:** none modified. Verification only.

**Step 1: Run every gate and capture results**

```bash
# Gate 1: torque fixtures.
bash examples/libs/nodejs/test/run-torque-fixtures.sh
# Expected: 15 OK / 0 DIFF.

# Gate 2: cctest.
cd examples/libs/nodejs/build/node
./out/Release/cctest --gtest_filter='TorqueCcBuiltinTest.*'
# Expected: 9/9 PASS.
cd -

# Gate 3: d8-smoke.
bash examples/libs/nodejs/test/d8-smoke.sh
# Expected: 18/18 PASS.

# Gate 4: mjsunit.
bash examples/libs/nodejs/test/run-mjsunit.sh
# Expected: 2/2 PASS.

# Gate 5: non-ccbuiltins anchor stable. Regenerate and sha.
# (Reuse the Phase-5 anchor-check command from verification.md.)
```

**Step 2: If any gate drifts from expected, stop and triage before proceeding**

Use the Hard-stop criteria at the top of the plan. Anchor drift with
no matching torque-source change is an escalation.

**Step 3: No commit this task**

---

## Task 6.9: wasm-posix-kernel suite re-run

**Files:** none modified. Verification only.

**Step 1: Run the five kernel gates per CLAUDE.md**

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
(cd host && npx vitest run)
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
bash scripts/check-abi-version.sh
```

**Step 2: Document the result**

Expected: 0 delta vs main. The only known pre-existing vitest
failures are the SDK-symlink environmental failures documented in
`torque-cc-backend-phase5-revised-complete.md`; those are NOT Phase-6
regressions. Any cargo / libc-test / POSIX / ABI delta is.

**Step 3: No commit this task**

---

## Task 6.10: Update `verification.md` with Phase 6 Summary

**Files:**
- Modify: `examples/libs/nodejs/verification.md`

**Step 1: Append the Phase 6 Summary**

Follow the Phase 5 Summary structure. Sections:

1. Table of items (each new builtin, each new gate, each commit).
2. End-to-end proof statement (a d8 command line that now works).
3. Clone commit list (with commit SHAs once the clone is finalized).
4. Plan deviations surfaced during implementation (patch size delta,
   any surprise fixes, any deferral lifts or additions).
5. Phase 6 follow-ups for later phases. Explicitly mark each of the 7
   deferred items with one of: **closed in Phase 6**, **still deferred
   (reason)**, or **partially closed (detail)**.

**Step 2: Commit**

```bash
git add examples/libs/nodejs/verification.md
git commit -m "nodejs: Phase 6 — verification.md Summary"
```

---

## Task 6.11: (OPTIONAL STRETCH) Second builtin family

Only if Tasks 6.1–6.10 finish with time remaining and all gates green.

Candidate families, in increasing deferred-item-exposure order:

- **`FastConsoleAssert`** (`console.tq`, non-transitioning, 1 fixed
  typeswitch, no runtime call). Risk: low.
- **`FunctionPrototypeHasInstance`** (`function.tq`, non-transitioning,
  likely uses `OrdinaryHasInstance` which is a runtime). Risk: medium
  (may pull in `runtime::OrdinaryHasInstance` on a path that needs
  exception propagation).
- **`DataViewPrototypeGetByteLength`** (`data-view.tq`, non-
  transitioning but has an internal `try` / `label` — forces
  `catch_block`). Risk: high; likely blocks on the deferred
  `catch_block` emitter work.

If stretch starts: pick `FastConsoleAssert` first, repeat the Task
6.2-shape cycle. Abort early if any deferred item fires; record the
attempt in `verification.md` under "followed-up / reverted" with the
exact first failure line.

## Task 6.12: Final commit — phase close

**Files:** none (should already be committed via earlier tasks).

**Step 1: Verify clean worktree**

```bash
git status
```

Expected: worktree clean except for the known `libc-test` /
`os-test` / `package-lock.json` / `.superset/` entries from main's
working-tree state (not Phase-6 changes).

**Step 2: Verify commit count**

```bash
git log --oneline 06b1c99e9..HEAD
```

Expected: ≥6 worktree commits (6.1, 6.2 bundled, 6.3/4/5/6 bundled,
6.7, 6.8, 6.9, 6.10). Exact count depends on batching during execution.

**Step 3: Do not push**

Per kickoff prompt: do NOT push to main. PR #306 remains the tracking
PR; push happens when the user decides Phase 6 is shippable.

---

## Appendix A: Debug playbook for "undefined reference" build errors

1. Read the first missing symbol from `ninja` error output.
2. `grep -n "^<Symbol>\|macro <Symbol>" examples/libs/nodejs/build/node/deps/v8/src/builtins/*.tq` — is it declared as extern or defined inline?
3. If defined inline → it's an emitter regression (torque didn't lower
   it correctly). Class (a).
4. If extern → check `deps/v8/src/torque/runtime-macro-shims.h` — if
   not present, class (b). If present, check signature match.
5. If the symbol has no torque declaration → it's a direct CSA call
   from some macro. Needs a preamble addition (class (b)) or a
   CSA-replacement shim (class (c)).

## Appendix B: How to read the non-ccbuiltins anchor

After a successful host build with a non-empty whitelist, the
"anchor" is the SHA-256 of all `*-tq-csa.cc` + `*-tq-ccdebug.cc` +
any `*-tq-ccbuiltins.cc` for builtins NOT in the whitelist. It must
be stable across pure whitelist additions, because whitelisting only
turns one builtin's `kCCBuiltins`-pass emission from a comment stub
into a real body — it must not change any other pass's output.

Phase 5's anchor post-5.8/5.9: `d5c6d835…`. Phase 6 tasks must not
change this unless the task explicitly edits `cc-generator.{h,cc}` or
`csa-generator.{h,cc}` or any shared torque source that affects all
three passes. If an anchor drift is observed without such a change,
that is an emitter regression — stop and escalate.

## Appendix C: Known-safe shim signatures (reference)

From Phase 5's `runtime-macro-shims.h` additions (Task 5.8) — these
are the templates to follow when writing a Phase-6 shim:

```cpp
// Labeled extern macros: first N args are inputs, followed by one
// `bool* label_<Name>` output per Torque `label` clause.
inline Tagged<HeapObject> TaggedToHeapObject(Tagged<Object> o,
                                             bool* label_CastError);

// Branchless predicates: plain-C++ return.
template <typename A, typename B>
inline bool TaggedNotEqual(Tagged<A> a, Tagged<B> b);

// Constants-with-isolate-context: take `Isolate*` as final arg.
//   (Provided via preamble injection, not shims.h — see True_0 / False_0
//    in Task 5.8.)
```

## Appendix D: Execution handoff

After the plan is accepted, execute with
**subagent-driven-development** (this session). Dispatch one fresh
Opus 4.6 subagent per task (Task 6.1 → 6.10); each subagent sees only
the plan + the task-specific prompt. Task 6.2 splits into sub-tasks
(one per triage-and-fix cycle) dispatched serially.

Rationale for subagent-driven: each task has a narrow, well-defined
success gate; subagents stay focused; context stays manageable; the
parent session retains the broader view for between-task review. The
alternative (parallel session) is less suitable here because Phase 6
is inherently sequential — each whitelist addition depends on the
previous being green.

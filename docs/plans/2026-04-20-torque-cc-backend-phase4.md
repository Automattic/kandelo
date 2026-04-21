# Phase 4: Torque CC Backend — Macro-Body Emission + Dispatch Table + First d8 Link Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make a Torque-translated builtin emit **linkable** C++ — close the
dangling `TqRuntime_<macro>` references that the Phase 3 goldens
(`make-lazy-node`, `call-csa-macro-and-branch`) carry, generate a real
`builtins-cc-table.inc` dispatch table (replacing Phase 2's
`Builtins::CppEntryOf` placeholder), wire the new outputs into Node.js's
gyp build, compile the host-native CSS+jitless V8 with the patch applied,
and prove it works end-to-end by linking a translated builtin into `d8`
and invoking it from a C++ unit test. Phase 4 is the first phase where
we produce ELF/Mach-O code — everything prior was source-generation only.

**Architecture:** Same shape as Phase 1/2/3 for the torque patch: all V8
edits land as commits on the clone at
`examples/libs/nodejs/build/node/` and re-export into
`examples/libs/nodejs/patches/v8-torque-cc-builtins.patch` (same
filename; supersedes Phase 3's). New surface area in Phase 4:

- **Macro-body emission under kCCBuiltins.** Phase 3 deferred the decision;
  Phase 4 picks option (b) from the Phase 3 deviation notes — extend the
  `EnsureInCCOutputList` trigger at `implementation-visitor.cc:3044-3052`
  so that when a kCCBuiltins-emitting builtin's call-lowering path goes
  through the non-inline branch for a TorqueMacro, we append to a new
  `macros_for_ccbuiltins_output_` list, and the fourth pass iterates both
  `all_declarables` (for builtins) AND that list (for referenced
  TorqueMacros). Rationale: matches the existing kCC/kCCDebug discipline
  exactly; curated iteration is the established pattern; a new pass
  variant is unnecessary. Pairs with relaxing the label-exit gate at
  `implementation-visitor.cc:2056-2060` for `OutputType::kCCBuiltins` so
  `GenerateFunction` emits the `bool*` + `T*` out-param signature that
  Phase 3's `CallCsaMacroAndBranchInstruction` emission already expects.

- **`builtins-cc-table.inc` dispatch table.** A new generated file that
  maps each `Builtin::k<Name>` enum entry (for the Torque-TFJ-lowered
  builtins this pass emits) to the address of the corresponding
  `Builtin_<Name>` C++ function, via an X-macro pattern
  (`TORQUE_CC_BUILTIN_LIST(V) V(Name, ReturnType, (ParamTypes...))`).
  Phase 2's `CallBuiltinPointer` emission referenced
  `Builtins::CppEntryOf(Builtin)` as a placeholder — that symbol is
  already present in V8 (builtins.cc:350) for CPP-class builtins but
  guarded by `DCHECK(Builtins::IsCpp(builtin))`. Phase 4 DOES NOT
  repurpose `CppEntryOf`; instead it adds a sibling
  `Builtins::TorqueCcEntryOf(Builtin)` that reads from the generated
  table. Keeps the CPP-vs-Torque-CC separation clean and surfaces the
  wrong-kind mismatch as a DCHECK rather than a stale pointer.

- **Gyp integration.** Node.js's build uses gyp, not GN. Phase 1 wired
  the output list into `BUILD.gn` for upstream-V8 consistency, but that
  edit had no effect on Node.js's link. Phase 4 adds
  `torque_outputs_ccbuiltins_cc` to `tools/v8_gypfiles/v8.gyp` alongside
  the existing `torque_outputs_csa_cc` / `torque_outputs_cc` variables
  (line 15-23 in v8.gyp), wires it into the `run_torque` action's
  `outputs` list, and appends it to the `torque_generated_definitions`
  target's sources so `-tq-ccbuiltins.cc` files are compiled into V8.
  Also adds the dispatch table's shared outputs (`builtins-cc-table.inc`
  + any helper headers) to the shared outputs list.

- **CSS+jitless build with the patch applied.** Phase 0 already proved
  CSS + jitless is viable on unpatched V8; Phase 4 is the first to do it
  **with** the kCCBuiltins patch + the whitelist set to a nonempty
  value. GN flags follow the handoff doc:
  `v8_enable_conservative_stack_scanning=true`, `v8_jitless=true`,
  `v8_enable_turbofan=false`, `v8_enable_sparkplug=false`,
  `v8_enable_maglev=false`, `v8_enable_webassembly=false`,
  `v8_enable_i18n_support=false`. The patch must hook the whitelist
  into gyp the same way — via a gyp variable passed to `run_torque`'s
  action. Non-whitelist builds are the regression floor.

- **First d8 link + C++ unit test.** We whitelist ONE trivial Torque
  builtin — the Phase 2 `return` fixture's `TorqueCcTest_Return` — and
  link the generated `Builtin_TorqueCcTest_Return(Isolate*, ...)` into
  the host V8 library. A new `test/unittests/torque/torque-cc-builtin-unittest.cc`
  gtest instantiates a minimal Isolate, invokes the function directly
  (not through the `Builtins::code(Builtin::k...)` dispatch — that goes
  through the entry table which we haven't wired up), and asserts the
  returned `Tagged<Smi>` matches the argument. Success gate: the test
  runs green on host macOS/Linux with CSS+jitless. This proves: (1) the
  generated C++ actually compiles against real V8 headers (goes beyond
  Phase 2's `-fsyntax-only` check that used a stubbed shim); (2) the
  macro-body emission path (Phase 4 Task 4.3) links the
  `TqRuntime_<macro>` references Phase 3 left dangling; (3) the gyp /
  GN integration is correct.

**Tech Stack:**
- V8 13.6.233.17 (vendored in Node.js v24.x at `deps/v8/`) — same as Phase 1/2/3.
- GN + ninja + host clang — same as Phase 1/2/3.
- Gyp + ninja — new surface for Phase 4 (`tools/v8_gypfiles/v8.gyp`,
  Node.js's `./configure --ninja`, `make -C out/Release`).
- gtest for the unit test — V8's own `test/unittests/` harness.

**Torque binary location (UNCHANGED — same gotcha as Phase 2/3):** use
`out/Release.baseline/torque`, NOT `out/Release/torque`. `out/Release/`
is lite-mode and rejects `src/wasm/wasm-objects.tq` at parse time.
Rebuild with `ninja -C out/Release.baseline torque` after any patch
change.

**Stock `.tq` file list (UNCHANGED — same gotcha as Phase 2/3):** use
`grep -oE '"(src|test|third_party)/[^"]*\.tq"' deps/v8/BUILD.gn | tr -d '"' | sort -u` —
245 files. The narrower pattern misses `test/torque/test-torque.tq` and
`third_party/v8/builtins/array-sort.tq` which crashes torque mid-run
with "cannot find SortState".

**Regression floor (MUST be preserved):**
- **Non-whitelisted torque output sha:**
  `a5195c0258fd9af9415e9d41f0c2e38237989c1b`. This is the Phase 1/2/3
  baseline for all torque output files EXCEPT `-tq-ccbuiltins.cc` files.
  Any change to this sha is a regression in the kCSA / kCC / kCCDebug
  passes and must be investigated before proceeding.
- **Phase 3 full-tree sha (with Phase 3 patch applied):**
  `ca08d489f0f69d56bbc88937d26481dd0c253893`. Phase 4's ccbuiltins
  output WILL change (we add macro-body emissions + the dispatch-table
  .inc file) so this sha does NOT have to be preserved — but Task 4.2
  snapshots it so Task 4.11 can surgically inspect exactly what changed.
- **Phase 3 11-fixture harness:** all 11 goldens
  (`call-builtin`, `call-builtin-pointer`, `call-csa-macro-and-branch`,
  `call-runtime`, `make-lazy-node`, `namespace-constant`,
  `push-builtin-pointer`, `push-uninitialized`, `return`,
  `store-bit-field`, `store-reference`) MUST still pass byte-exact
  diffs. Phase 4's macro-body emission changes
  `make-lazy-node-tq-ccbuiltins.cc` (the referenced
  `TqRuntime_TorqueCcTest_LazyBody_0` is no longer dangling — a body
  gets emitted elsewhere; the reference itself stays) and
  `call-csa-macro-and-branch-tq-ccbuiltins.cc` may or may not change
  depending on whether `GotoIfForceSlowPath` is an extern shim (no
  body needed). Task 4.3 Step 6 regenerates affected goldens and
  inspects the diff.

**Invariants (do not break):**
- Stock V8 builtins (anything not in the whitelist) continue to hit the
  Phase 1 comment-stub path in `Visit(Builtin*)`. Non-whitelisted
  stock-V8-tree torque output stays byte-identical to
  `a5195c0258fd9af9415e9d41f0c2e38237989c1b`.
- The existing `kCSA` / `kCC` / `kCCDebug` passes keep existing
  behavior — the label-exit `ReportError` at
  `implementation-visitor.cc:2056-2060` stays active for kCC and
  kCCDebug; only kCCBuiltins gets the out-param emission arm.
- `Builtins::CppEntryOf(Builtin)` at `builtins.cc:350` is NOT modified.
  Phase 4 introduces a sibling `TorqueCcEntryOf(Builtin)` for Torque-CC
  builtins — the CPP-class builtin path stays untouched.
- Each new instruction/emission path gets a golden-file-backed fixture.
  Same rule as Phase 2/3.
- Every V8 edit lands as a commit on the Node.js clone; the worktree
  holds fixtures, harness, verification.md, the consolidated patch, and
  (new in Phase 4) a host-build shell script + unit test source. Never
  hand-edit the patch file — always re-export via `git format-patch`.

**Out of scope for Phase 4** (explicit, per handoff + Phase 3 decision
note):
- Runtime exception handling (`catch_block` on
  CallCsaMacroAndBranch / CallRuntime / CallBuiltin). Stays `ReportError`.
- Tail-calls from `CallBuiltin` / `CallBuiltinPointer`. Stay `ReportError`.
- JS-linkage builtins (receiver/newTarget/dispatchHandle unpacking +
  Descriptor machinery). Stay the "JS linkage deferred" comment path in
  `Visit(Builtin*)`.
- Wasm32 cross-compile. Phase 7+.
- Full mjsunit. Phase 5-6.
- Hand-written CSA replacement ledger. Phase 5.
- Any work that depends on the dispatch table going through
  `Builtins::code(Builtin)` and V8's interpreter entry tables — Phase
  4's smoke test invokes the C++ function directly. Interpreter
  integration is Phase 5.

**Phase-3 lessons Phase-4 inherits** (from `examples/libs/nodejs/verification.md`
"Plan deviations surfaced during Phase 3 implementation"):

1. **`ShouldBeInlined` coverage holes are pre-existing landmines.**
   Phase 2 had latent crashes in `ExternMacro` / `Intrinsic` /
   `Visit(Builtin*)`'s `CurrentSourcePosition::Scope` that Phase 3
   surfaced by probing new paths. Phase 4 exercises a new path — the
   curated macro-iteration under kCCBuiltins — and may surface
   similar holes. If Task 4.3 crashes mid-pass, check for `kCCBuiltins`
   arms missing in any visitor (`Visit(TorqueMacro*)`,
   `Visit(NamespaceConstant*)`, `Visit(Method*)`, `Visit(TypeAlias*)`),
   any switch on `output_type_` in `types.cc`, `declarable.cc`, or
   `cpp-builder.cc`. Pattern: inherit silently from kCSA, emit stray
   content, or crash.
2. **`Macro::ShouldBeInlined` is already false for labeled macros under
   kCCBuiltins** (Phase 3 Task 3.5 commit `e0464526`). Phase 4's
   curated iteration only needs to add non-inlined macros to the list.
   **Do not widen the override** — unlabeled macros should stay
   inline-only (matches V8's existing expectation; widening would
   regenerate way too much output).
3. **`Visit(TorqueMacro*)` already exists and is driven by kCC /
   kCCDebug.** When running it under kCCBuiltins (Task 4.3 Step 3), the
   emitted name MUST be the Torque-CC-namespaced form
   (`TqRuntime_<ExternalName>` — matches what `CCName()` returns for
   TorqueMacro) NOT the kCC variant which may go into a different
   output file. Verify by inspecting the emission under kCC first
   (read `types.cc:1042-1046`, check what stream it writes to), then
   mirror with a kCCBuiltins stream.
4. **Fixture paths stay under `test/phase2-fixtures`** (not
   `phase4-fixtures` — the harness symlink dir name is historical and
   shared across phases; changing it breaks Phase 2/3 goldens' `//
   Source:` comments).
5. **`GotoExternal` is exercisable in Phase 4, not before** (Phase 3
   deviation note 2). Macro-body emission is the prerequisite. Phase 4
   adds the missing `goto-external` fixture + golden (brings harness
   total to 12).
6. **Phase 3 deferred relaxing the label-exit gate at
   implementation-visitor.cc:2056-2060.** Phase 4 MUST relax it for
   kCCBuiltins, paired with Task 4.3's macro-body emission. Without
   both, either the gate fires ReportError mid-pass or the callsite
   references a symbol whose signature the translation unit doesn't
   know. **Tasks 4.3 and 4.4 are a pair — land them in the same commit
   sequence, test together.**

---

## Task 4.1: Capture post-Phase-3 torque baseline

**Context:** Phase 4 must not regress non-whitelisted torque output nor
the 11 existing fixture goldens. Snapshot the current torque output at
Phase 3 tip (Node.js clone commit `33051608`) so later tasks have
regression targets.

**Files:** none committed. Writes scratch files to `/tmp/`.

**Step 1: Confirm Phase 3 patch is applied at the Node.js clone tip**

```bash
cd examples/libs/nodejs/build/node
git log --oneline 9fe7634c..HEAD | wc -l    # expect 27
git log --oneline -1                          # expect tip = 33051608 GotoExternal
```

If commit count is wrong, reset + reapply:

```bash
git fetch origin v24.x
git reset --hard 9fe7634c
git apply --3way ../../patches/v8-torque-cc-builtins.patch
# Then commit the patch contents (format-patch restores the commit chain).
ninja -C out/Release.baseline torque
```

**Step 2: Rebuild stock .tq list (correct pattern — MATCHES verification.md)**

```bash
cd examples/libs/nodejs/build/node
TQ_FILES=$(grep -oE '"(src|test|third_party)/[^"]*\.tq"' deps/v8/BUILD.gn \
             | tr -d '"' | sort -u)
echo "$TQ_FILES" | wc -l   # expect 245
echo "$TQ_FILES" > /tmp/phase4-tq-files.txt
```

**Step 3: Run torque over stock fileset, capture output tree**

```bash
rm -rf /tmp/torque-baseline-phase4
mkdir -p /tmp/torque-baseline-phase4
echo "$TQ_FILES" | sed 's|[^/]*$||' | sort -u | while read d; do
  mkdir -p "/tmp/torque-baseline-phase4/$d"
done
./out/Release.baseline/torque \
  -o /tmp/torque-baseline-phase4 \
  -v8-root deps/v8 \
  $TQ_FILES 2>&1 | tee /tmp/phase4-baseline.log
echo "exit=$?"
```

Expected: exit 0, 1490 files generated (1245 baseline + 245
`-tq-ccbuiltins.cc`).

**Step 4: Verify the non-ccbuiltins sha matches the Phase 1/2/3 documented value**

```bash
find /tmp/torque-baseline-phase4 -type f ! -name '*-tq-ccbuiltins.cc' \
  -print0 | sort -z | xargs -0 cat | shasum \
  > /tmp/torque-baseline-phase4-noccb.sum
cat /tmp/torque-baseline-phase4-noccb.sum
```

Expected: `a5195c0258fd9af9415e9d41f0c2e38237989c1b`. If differs, stop —
the tree has drifted and Task 4.11's regression gate will be meaningless.

**Step 5: Verify the full-tree sha matches the Phase 3 documented value**

```bash
find /tmp/torque-baseline-phase4 -type f -print0 | sort -z | \
  xargs -0 cat | shasum > /tmp/torque-baseline-phase4.sum
cat /tmp/torque-baseline-phase4.sum
```

Expected: `ca08d489f0f69d56bbc88937d26481dd0c253893`. If differs, Phase
3's ccbuiltins output has drifted since the Phase 3 Summary was
written — investigate before proceeding.

**Step 6: Record the ccbuiltins-only sha for surgical Task 4.11 diffs**

```bash
find /tmp/torque-baseline-phase4 -type f -name '*-tq-ccbuiltins.cc' \
  -print0 | sort -z | xargs -0 cat | shasum > /tmp/torque-baseline-phase4-ccb.sum
cat /tmp/torque-baseline-phase4-ccb.sum
```

No commit — this is a measurement.

---

## Task 4.2: Spike — find the cleanest macro-body emission strategy

**Context:** Phase 3's deviation note 1 pinned Phase 4 to implement
macro-body emission. Two plausible strategies from the handoff doc +
Phase 3 notes:

- **(a) New fifth pass.** Add `all_torque_macros_for_ccbuiltins_output_`
  to GlobalContext and a fifth iteration in `VisitAllDeclarables` after
  the kCCBuiltins builtins pass. Matches kCC / kCCDebug exactly.
- **(b) Extend `EnsureInCCOutputList` under kCCBuiltins.** Reuse the
  existing `macros_for_cc_output_` list (add kCCBuiltins to the same
  trigger at line 3044-3052), iterate it in a NEW kCCBuiltins-equivalent
  pass, OR iterate it twice (once under kCC, once under kCCBuiltins).
  Risk: double-emission under kCC may emit an incorrect second time.

**Spike goal:** confirm (a) vs. (b). Default preference: **(a)**, because
it's the cleanest — separate list, separate pass, matches Phase 1/2/3's
pattern of adding new machinery rather than widening existing.

**Files:** scratch only. No commits.

**Step 1: Re-read the existing kCC pass driver end-to-end**

Files to read:
- `implementation-visitor.cc:3044-3052` — EnsureInCCOutputList trigger
- `implementation-visitor.cc:3670-3693` — kCC + kCCDebug pass drivers
- `global-context.h:118-140` — EnsureInCCOutputList, AllMacrosForCCOutput
- `types.cc:1042` — the second EnsureInCCOutputList call site

Write a short summary (5-10 lines) of how kCC macro emission works
today. Commit as a scratch note or just keep in memory.

**Step 2: Probe — run torque with the Phase 3 `make-lazy-node` fixture
and inspect the ir dump for `TqRuntimeTorqueCcTest_LazyBody_0`**

```bash
cd examples/libs/nodejs/build/node
rm -rf /tmp/phase4-spike
mkdir -p /tmp/phase4-spike/test/phase2-fixtures
TQ_FILES=$(cat /tmp/phase4-tq-files.txt)
echo "$TQ_FILES" | sed 's|[^/]*$||' | sort -u | while read d; do
  mkdir -p "/tmp/phase4-spike/$d"
done
# Stage the fixture the same way run-torque-fixtures.sh does.
mkdir -p deps/v8/test/phase2-fixtures
ln -sfn "$(cd ../../test/torque-fixtures && pwd)/make-lazy-node.tq" \
  deps/v8/test/phase2-fixtures/make-lazy-node.tq

./out/Release.baseline/torque \
  --cc-builtins-whitelist=TorqueCcTest_MakeLazyNode,TorqueCcTest_LazyBody \
  -annotate-ir \
  -o /tmp/phase4-spike \
  -v8-root deps/v8 \
  $TQ_FILES test/phase2-fixtures/make-lazy-node.tq 2>&1 \
  | tee /tmp/phase4-spike.log

grep -l 'TqRuntimeTorqueCcTest_LazyBody' /tmp/phase4-spike -r
grep -l 'TorqueCcTest_LazyBody' /tmp/phase4-spike -r | grep -v 'phase2-fixtures'
```

Expected: the lazy-body reference `TqRuntimeTorqueCcTest_LazyBody_0`
appears in the ccbuiltins output, but no file actually defines it
(macro body is nowhere). **This is the dangling reference Phase 4
needs to close.**

**Step 3: Decide — strategy (a) or (b)**

Default: **(a) new fifth pass** (matches kCC/kCCDebug convention). Pick
(b) only if Step 1 revealed a structural reason not to add a new list.

Write a short `/tmp/phase4-spike-findings.md`:
- Strategy chosen: (a) or (b)
- Rationale: 2-3 bullet points
- Changes required: 1-2 files, 10-30 lines of C++
- Risks surfaced: which ShouldBeInlined / output_type_ switch might be
  missing a kCCBuiltins arm

**Step 4: Clean up staged fixture (unless Phase 4 tasks will reuse
it immediately — they will, so leave the symlink; it's idempotent)**

No commit — spike only.

---

## Task 4.3: Implement macro-body emission under kCCBuiltins

**Context:** Phase 3 deferred this; Phase 4's goal #1. The curated
iteration list + new pass driver make `Visit(TorqueMacro*)` fire under
`OutputType::kCCBuiltins`, which emits the macro body into the correct
per-source `-tq-ccbuiltins.cc` file.

**Files:**
- Modify: `deps/v8/src/torque/global-context.h` — add
  `macros_for_ccbuiltins_output_` and the `EnsureInCCBuiltinsOutputList`
  + `AllMacrosForCCBuiltinsOutput` accessors (mirror the kCC pair at
  lines 118-140).
- Modify: `deps/v8/src/torque/implementation-visitor.cc` — at line 3044,
  extend the EnsureInCCOutputList trigger to ALSO record into the new
  list when `output_type_ == kCCBuiltins`. Then in `VisitAllDeclarables`
  (line 3694-3713 currently, the builtins-only fourth-pass), BEFORE
  resetting to kCSA, iterate the new list as a FIFTH pass. Note that
  the list is populated DURING the fourth pass (macros are reached via
  builtin call-lowering), so the fifth-pass iteration sees a stable
  list.
- Modify: `deps/v8/src/torque/implementation-visitor.cc` — ensure
  `Visit(TorqueMacro*)` under kCCBuiltins writes to `csa_ccfile()` (which
  routes to `cc_builtins_ccfile` per Phase 1 commit `29d20ab2`). Likely
  NO edit needed here — the routing already exists — but confirm by
  inspection.

**Step 1: Write the TDD fixture BEFORE implementing — a macro-only fixture**

New fixture `examples/libs/nodejs/test/torque-fixtures/call-torque-macro.tq`:

```
// Phase 4 test fixture: calling a non-inline Torque macro from a builtin.
// Without Phase 4's macro-body emission, the generated callsite
// references `TqRuntime_TorqueCcTest_CallMeFromBuiltin_0` — a symbol
// no translation unit defines. Phase 4 adds the body via a curated
// fifth-pass iteration, closing the link.
namespace test_cc {
  // Torque macro with labels forces non-inline dispatch under
  // kCCBuiltins (Phase 3 Task 3.5 override). Labels are the simplest
  // path to forcing macro-body emission — no attribute-based noinline
  // exists in Torque.
  macro TorqueCcTest_CallMeFromBuiltin(x: Smi): Smi labels Fail {
    if (x == 0) goto Fail;
    return x;
  }

  builtin TorqueCcTest_CallTorqueMacro(
      implicit context: Context)(arg: Smi): Smi {
    try {
      const r: Smi = TorqueCcTest_CallMeFromBuiltin(arg) otherwise Bailout;
      return r;
    } label Bailout {
      return -1;
    }
  }
}
```

Stage the golden (will fail the first run — harness prints `MISSING:`):

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
# Pre-install the expected shape (rough guess; refine after Step 4).
touch examples/libs/nodejs/test/torque-fixtures/golden/call-torque-macro-tq-ccbuiltins.cc
bash examples/libs/nodejs/test/run-torque-fixtures.sh call-torque-macro \
  || true   # expected to fail — we'll regenerate after implementation
```

**Step 2: Add `EnsureInCCBuiltinsOutputList` + accessor to global-context.h**

In `deps/v8/src/torque/global-context.h`, after the existing
`AllMacrosForCCDebugOutput` (line 137-140), add:

```cpp
  static void EnsureInCCBuiltinsOutputList(TorqueMacro* macro,
                                           SourceId source) {
    GlobalContext& c = Get();
    auto item = std::make_pair(macro, source);
    if (c.macros_for_ccbuiltins_output_set_.insert(item).second) {
      c.macros_for_ccbuiltins_output_.push_back(item);
    }
  }
  static const std::vector<std::pair<TorqueMacro*, SourceId>>&
  AllMacrosForCCBuiltinsOutput() {
    return Get().macros_for_ccbuiltins_output_;
  }
```

And add the backing storage (line 156-157 area, mirror
`macros_for_cc_output_`):

```cpp
  std::vector<std::pair<TorqueMacro*, SourceId>> macros_for_ccbuiltins_output_;
  std::set<std::pair<TorqueMacro*, SourceId>> macros_for_ccbuiltins_output_set_;
```

Commit on the clone:

```bash
cd examples/libs/nodejs/build/node
git add deps/v8/src/torque/global-context.h
git -c user.email=build@wasm-posix-kernel.local \
    -c user.name="wasm-posix-kernel build" \
    commit -m "torque: add AllMacrosForCCBuiltinsOutput list + accessor"
```

**Step 3: Wire the trigger at implementation-visitor.cc:3044-3052**

Change the existing trigger from:

```cpp
    if ((output_type_ == OutputType::kCC ||
         output_type_ == OutputType::kCCDebug) &&
        !inline_macro) {
      if (auto* torque_macro = TorqueMacro::DynamicCast(macro)) {
        auto* streams = CurrentFileStreams::Get();
        SourceId file = streams ? streams->file : SourceId::Invalid();
        GlobalContext::EnsureInCCOutputList(torque_macro, file);
      }
    }
```

To:

```cpp
    if ((output_type_ == OutputType::kCC ||
         output_type_ == OutputType::kCCDebug) &&
        !inline_macro) {
      if (auto* torque_macro = TorqueMacro::DynamicCast(macro)) {
        auto* streams = CurrentFileStreams::Get();
        SourceId file = streams ? streams->file : SourceId::Invalid();
        GlobalContext::EnsureInCCOutputList(torque_macro, file);
      }
    }
    if (output_type_ == OutputType::kCCBuiltins && !inline_macro) {
      if (auto* torque_macro = TorqueMacro::DynamicCast(macro)) {
        auto* streams = CurrentFileStreams::Get();
        SourceId file = streams ? streams->file : SourceId::Invalid();
        GlobalContext::EnsureInCCBuiltinsOutputList(torque_macro, file);
      }
    }
```

Commit:

```bash
git add deps/v8/src/torque/implementation-visitor.cc
git -c user.email=build@wasm-posix-kernel.local \
    -c user.name="wasm-posix-kernel build" \
    commit -m "torque: record TorqueMacros referenced from kCCBuiltins builtins"
```

**Step 4: Add the fifth pass in `VisitAllDeclarables`**

In `implementation-visitor.cc:~3705-3715`, after the builtins fourth
pass, insert BEFORE the `output_type_ = OutputType::kCSA;` reset:

```cpp
  // Fifth pass: emit bodies for TorqueMacros referenced from kCCBuiltins
  // builtins (populated during the fourth pass by GenerateCall's trigger
  // at line 3044-3064). Iterates a curated list exactly like the kCC and
  // kCCDebug passes — matches existing V8 discipline.
  const std::vector<std::pair<TorqueMacro*, SourceId>>& ccb_macros =
      GlobalContext::AllMacrosForCCBuiltinsOutput();
  for (size_t i = 0; i < ccb_macros.size(); ++i) {
    try {
      Visit(static_cast<Declarable*>(ccb_macros[i].first),
            ccb_macros[i].second);
    } catch (TorqueAbortCompilation&) {
      // Recover from compile errors here. The error is recorded already.
    }
  }

  output_type_ = OutputType::kCSA;
```

Commit:

```bash
git add deps/v8/src/torque/implementation-visitor.cc
git -c user.email=build@wasm-posix-kernel.local \
    -c user.name="wasm-posix-kernel build" \
    commit -m "torque: add fifth pass emitting kCCBuiltins-referenced macro bodies"
```

**Step 5: Rebuild torque, run spike to verify macro body appears**

```bash
cd examples/libs/nodejs/build/node
ninja -C out/Release.baseline torque 2>&1 | tail -10
# Re-run the Task 4.2 spike command:
rm -rf /tmp/phase4-spike
mkdir -p /tmp/phase4-spike/test/phase2-fixtures
TQ_FILES=$(cat /tmp/phase4-tq-files.txt)
echo "$TQ_FILES" | sed 's|[^/]*$||' | sort -u | while read d; do
  mkdir -p "/tmp/phase4-spike/$d"
done
./out/Release.baseline/torque \
  --cc-builtins-whitelist=TorqueCcTest_MakeLazyNode,TorqueCcTest_LazyBody \
  -o /tmp/phase4-spike \
  -v8-root deps/v8 \
  $TQ_FILES test/phase2-fixtures/make-lazy-node.tq 2>&1 | tail -5

grep -l 'TqRuntimeTorqueCcTest_LazyBody' /tmp/phase4-spike -r
# Expect at least 2 hits now — one for the call-site reference, one
# for the emitted body.
```

Expected: `TqRuntimeTorqueCcTest_LazyBody_0` now has both a call-site
(in `make-lazy-node-tq-ccbuiltins.cc`) AND a body definition (in the
same file — `EnsureInCCBuiltinsOutputList` used the caller's SourceId).
If the body lands in a different file, the trigger SourceId is wrong;
trace through `CurrentFileStreams::Get()` and confirm it's the caller's
source (not the macro's own source — which would land in a different
file where no builtin references it).

**Step 6: Regenerate Phase 3 goldens that now include macro bodies**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend

# make-lazy-node's golden will now include a body for LazyBody_0.
UPDATE_GOLDEN=1 bash examples/libs/nodejs/test/run-torque-fixtures.sh \
  make-lazy-node

# call-csa-macro-and-branch's golden MAY change if Phase 4's macro-body
# pass generates a body for any of the referenced shim macros. In
# practice the referenced `GotoIfForceSlowPath` is an extern macro (no
# body), so no change is expected — but re-run to confirm.
UPDATE_GOLDEN=1 bash examples/libs/nodejs/test/run-torque-fixtures.sh \
  call-csa-macro-and-branch

# Any other fixture that touches a TorqueMacro goes through the same
# iteration — regenerate all and `git diff` the goldens to inspect:
UPDATE_GOLDEN=1 bash examples/libs/nodejs/test/run-torque-fixtures.sh
cd examples/libs/nodejs/test/torque-fixtures/golden
git status --short
git diff
```

Expected diffs:
- `make-lazy-node-tq-ccbuiltins.cc`: now includes
  `Tagged<Smi> TqRuntimeTorqueCcTest_LazyBody_0(Tagged<Smi> parameter0) { ... }`
  or similar macro-body function. Exact name per `CCName()`.
- Other 10 goldens: no change expected. If a golden changed
  unexpectedly, diagnose — the fifth pass may be over-emitting.

**Step 7: Complete the new `call-torque-macro` golden**

```bash
UPDATE_GOLDEN=1 bash examples/libs/nodejs/test/run-torque-fixtures.sh \
  call-torque-macro
cat examples/libs/nodejs/test/torque-fixtures/golden/call-torque-macro-tq-ccbuiltins.cc
```

Expected: shows both the builtin `Builtin_TorqueCcTest_CallTorqueMacro(...)`
AND the macro body `TqRuntimeTorqueCcTest_CallMeFromBuiltin_0(...)`. The
latter has the label out-param signature from Task 4.4 Step 2 (so Task
4.4 must land before or with Task 4.3's final commit — see the
execution notes).

**Step 8: Commit fixtures + goldens (worktree)**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/test/torque-fixtures/call-torque-macro.tq \
        examples/libs/nodejs/test/torque-fixtures/golden/call-torque-macro-tq-ccbuiltins.cc \
        examples/libs/nodejs/test/torque-fixtures/golden/make-lazy-node-tq-ccbuiltins.cc
# call-csa-macro-and-branch-tq-ccbuiltins.cc — only add if it changed.
git status --short examples/libs/nodejs/test/torque-fixtures/golden/
git commit -m "nodejs: Phase 4 — macro-body emission fixture + regenerated Phase 3 goldens"
```

---

## Task 4.4: Relax label-exit gate at `implementation-visitor.cc:2056-2060`

**Context:** Phase 3 documented that it did NOT relax the gate (verification.md
"Plan deviations surfaced during Phase 3 implementation" item 3). Phase 4
must, so that the fifth pass's `Visit(TorqueMacro*)` under kCCBuiltins for
a labeled macro emits the correct `bool* out_branch_<label>` +
`T* out_<label>_<i>` out-param signature — matching what Phase 3's
`CallCsaMacroAndBranchInstruction` emission already expects at the
callsite.

**Files:**
- Modify: `deps/v8/src/torque/implementation-visitor.cc:2056-2077` — add
  a kCCBuiltins arm to the label-iteration loop.

**Step 1: Confirm the current gate**

```bash
cd examples/libs/nodejs/build/node
sed -n '2050,2080p' deps/v8/src/torque/implementation-visitor.cc
```

Expected: `ReportError("Macros that generate runtime code can't have label exits");`
fires for kCC and kCCDebug only; the loop then proceeds to emit the
kCSA-specific `compiler::CodeAssemblerLabel*` / `compiler::TypedCodeAssemblerVariable*`
parameters for ALL output types including kCCBuiltins. That's wrong —
kCCBuiltins should emit plain C++ pointers.

**Step 2: Edit the loop**

Replace lines 2056-2077 (the `for (const LabelDeclaration& label_info ...)`
block) with:

```cpp
  for (const LabelDeclaration& label_info : signature.labels) {
    if (output_type_ == OutputType::kCC ||
        output_type_ == OutputType::kCCDebug) {
      ReportError("Macros that generate runtime code can't have label exits");
    }
    if (output_type_ == OutputType::kCCBuiltins) {
      // kCCBuiltins out-param convention (paired with
      // CCGenerator::EmitInstruction(CallCsaMacroAndBranchInstruction)
      // and CCGenerator::EmitInstruction(GotoExternalInstruction)):
      // each label becomes a `bool*` indicator + per-label-value `T*`
      // pointer. Caller declares the locals; callee writes them and
      // returns.
      f.AddParameter("bool*", ExternalLabelName(label_info.name->value));
      size_t i = 0;
      for (const Type* type : label_info.types) {
        if (type->StructSupertype()) {
          ReportError("Phase 4: label values of struct types are not yet "
                      "supported under kCCBuiltins");
        }
        f.AddParameter(type->GetRuntimeType() + "*",
                       ExternalLabelParameterName(label_info.name->value, i));
        ++i;
      }
      continue;
    }
    f.AddParameter("compiler::CodeAssemblerLabel*",
                   ExternalLabelName(label_info.name->value));
    size_t i = 0;
    for (const Type* type : label_info.types) {
      std::string generated_type_name;
      if (type->StructSupertype()) {
        generated_type_name = "\n#error no structs allowed in labels\n";
      } else {
        generated_type_name = "compiler::TypedCodeAssemblerVariable<";
        generated_type_name += type->GetGeneratedTNodeTypeName();
        generated_type_name += ">*";
      }
      f.AddParameter(generated_type_name,
                     ExternalLabelParameterName(label_info.name->value, i));
      ++i;
    }
  }
```

**Step 3: Rebuild torque + re-run harness**

```bash
ninja -C out/Release.baseline torque 2>&1 | tail -10
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
bash examples/libs/nodejs/test/run-torque-fixtures.sh
```

Expected: harness runs green after Task 4.3 Step 7's golden was
regenerated — the `call-torque-macro` golden now contains a
correctly-signatured macro body.

If `call-torque-macro`'s golden diff fails because the signature was
wrong in Step 7 (prior to Step 2 landing here), re-run UPDATE_GOLDEN=1
and re-inspect. **Tasks 4.3 and 4.4 are interdependent — verify both
together before moving on.**

**Step 4: Commit**

```bash
cd examples/libs/nodejs/build/node
git add deps/v8/src/torque/implementation-visitor.cc
git -c user.email=build@wasm-posix-kernel.local \
    -c user.name="wasm-posix-kernel build" \
    commit -m "torque: emit out-param signature for labeled macros under kCCBuiltins"
```

---

## Task 4.5: Add the `goto-external` fixture (now exercisable)

**Context:** Phase 3 deviation note 2 flagged that `GotoExternal`
emission shipped defensively in Phase 3's commit `33051608` but was
NOT exercised by any Phase 3 fixture — because macro-body emission
didn't exist. With Task 4.3/4.4 landed, a labeled macro's body IS
emitted as a standalone C++ function, and `GotoExternal` fires inside
that body for `goto FailLabel;` statements. Phase 4 adds the fixture
that makes this exercised.

**Files:**
- Create: `examples/libs/nodejs/test/torque-fixtures/goto-external.tq`
- Create: `examples/libs/nodejs/test/torque-fixtures/golden/goto-external-tq-ccbuiltins.cc`

**Step 1: Write the fixture**

`examples/libs/nodejs/test/torque-fixtures/goto-external.tq`:

```
// Phase 4 test fixture: GotoExternalInstruction inside a labeled macro
// body (callable under kCCBuiltins via the Phase 4 fifth pass). The
// macro `if (arg == 0) goto Fail` desugars to a GotoExternalInstruction
// whose destination is the `bool* out_Fail` param (emitted by the
// Phase 4 GenerateFunction out-param rewrite). The builtin invokes the
// macro with `otherwise`, which routes through
// CallCsaMacroAndBranchInstruction at the call site.
namespace test_cc {
  macro TorqueCcTest_GotoExternalBody(x: Smi): Smi labels Fail {
    if (x == 0) goto Fail;
    return x;
  }

  builtin TorqueCcTest_GotoExternal(
      implicit context: Context)(arg: Smi): Smi {
    try {
      const r: Smi = TorqueCcTest_GotoExternalBody(arg) otherwise Bailout;
      return r;
    } label Bailout {
      return -1;
    }
  }
}
```

(Compare to Task 4.3's `call-torque-macro.tq`: the only difference is
that the builtin here is named to target the GotoExternal test
specifically. Consider collapsing into one fixture if the goldens
would be substantially duplicated — but keep them separate if they
test distinct shapes; the harness is fast.)

**Step 2: Generate the golden**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
touch examples/libs/nodejs/test/torque-fixtures/golden/goto-external-tq-ccbuiltins.cc
UPDATE_GOLDEN=1 bash examples/libs/nodejs/test/run-torque-fixtures.sh \
  goto-external
cat examples/libs/nodejs/test/torque-fixtures/golden/goto-external-tq-ccbuiltins.cc
```

Expected: the macro body `TqRuntimeTorqueCcTest_GotoExternalBody_0`
contains the emission pattern:

```cpp
  *<out_fail_name> = true;
  return;
```

for the goto-Fail path. The builtin body uses the
`CallCsaMacroAndBranch` dispatch to route to the `Bailout` block.

**Step 3: Re-run harness (no UPDATE_GOLDEN); confirm byte-exact match**

```bash
bash examples/libs/nodejs/test/run-torque-fixtures.sh goto-external
bash examples/libs/nodejs/test/run-torque-fixtures.sh   # all 12
```

Expected: `OK: goto-external` plus 11 other OKs.

**Step 4: Commit**

```bash
git add examples/libs/nodejs/test/torque-fixtures/goto-external.tq \
        examples/libs/nodejs/test/torque-fixtures/golden/goto-external-tq-ccbuiltins.cc
git commit -m "nodejs: Phase 4 — goto-external fixture (now exercisable)"
```

---

## Task 4.6: Implement `builtins-cc-table.inc` generation

**Context:** Phase 4 goal #3 (per handoff). Generate a dispatch table
mapping `Builtin::k<Name>` to `&Builtin_<Name>` for each
Torque-TFJ-translated builtin in the kCCBuiltins pass. A new
`TorqueCcEntryOf(Builtin)` method on `Builtins` reads from it.

**File layout decision:** the table goes into
`<SHARED_INTERMEDIATE_DIR>/torque-generated/builtins-cc-table.inc`
(shared across all `.tq` inputs — NOT per-source; the ccbuiltins .cc
files are per-source but the table must be a single index across all
of them). Torque already writes several shared outputs there (line
120-139 of v8.gyp lists them). Add this as a new shared output.

**Files:**
- Modify: `deps/v8/src/torque/implementation-visitor.cc` — add a
  `GenerateCCBuiltinsTable` method called at the tail of
  `GenerateImplementation` (around line 3800+), or similar
  implementation-visitor-owned hook.
- Modify: `deps/v8/src/torque/implementation-visitor.h` — declare it.
- Modify: `deps/v8/src/builtins/builtins.cc` — add
  `Builtins::TorqueCcEntryOf(Builtin)` + the table's `extern` declaration.
- Modify: `deps/v8/src/builtins/builtins.h` — declare
  `static Address TorqueCcEntryOf(Builtin);` alongside `CppEntryOf`.
- Modify: `deps/v8/src/torque/cc-generator.cc:524-547` — in the
  `CallBuiltinPointer` emission, replace the
  `Builtins::CppEntryOf(...)` reference with
  `Builtins::TorqueCcEntryOf(...)`.

**Step 1: Design the table file format**

Pick one of these two shapes:

- **X-macro** — each entry is `TORQUE_CC_BUILTIN(Name, RetType, ParamTypes)`.
  Callers can expand to different forms (declaration, table entry,
  invocation). More flexible.
- **Flat array** — directly emit `static const struct TorqueCcEntry {
  Builtin id; Address entry; } kTable[] = { ... };`. Simpler but less
  reusable.

Pick X-macro for future Phase 5/6 uses (e.g., emitting the forward
declarations of `Builtin_<Name>`). Example emission:

```cpp
// torque-generated/builtins-cc-table.inc
// AUTO-GENERATED by torque CC-Builtins backend. DO NOT EDIT.
#ifndef TORQUE_CC_BUILTIN_LIST
#error "Define TORQUE_CC_BUILTIN_LIST(V) before including"
#endif

#define TORQUE_CC_BUILTINS(V)                                             \
  V(TorqueCcTest_Return,       Tagged<Smi>, (Tagged<Context>, Tagged<Smi>))\
  V(TorqueCcTest_MakeLazyNode, Tagged<Smi>, (Tagged<Context>, Tagged<Smi>))\
  /* ... one line per whitelisted non-JS-linkage kStub builtin ... */
```

**Step 2: Implement emission in implementation-visitor.cc**

In `Visit(Builtin*)` at line 587 (the kCCBuiltins arm), ALSO append to
a new `cc_builtins_table_entries_` vector (a member of
`ImplementationVisitor` or a `GlobalContext::AllCCBuiltinEntries`
list). At the tail of `GenerateImplementation` (or whenever the
`.inc` output gets written — mirror how `bit-fields.h` or
`builtin-definitions.h` get emitted, check
`implementation-visitor.cc:~GenerateImplementation` for the
shared-output dump site), write the header + macro + entries.

Pseudocode:

```cpp
void ImplementationVisitor::GenerateCCBuiltinsTable(const std::string& output_directory) {
  std::string file_name = "builtins-cc-table.inc";
  std::stringstream out;
  out << "// Copyright 2024 ...\n"
      << "// AUTO-GENERATED ...\n\n"
      << "#ifndef TORQUE_CC_BUILTIN_LIST\n"
      << "#error ...\n"
      << "#endif\n\n"
      << "#define TORQUE_CC_BUILTINS(V) \\\n";
  for (const auto& e : cc_builtins_table_entries_) {
    // e = {name, return_type, param_types}
    out << "  V(" << e.name << ", " << e.return_type << ", (";
    for (size_t i = 0; i < e.param_types.size(); ++i) {
      if (i > 0) out << ", ";
      out << e.param_types[i];
    }
    out << "))  \\\n";
  }
  out << "\n";
  std::string file_path = output_directory + "/" + file_name;
  WriteFile(file_path, out.str());
}
```

Hook `GenerateCCBuiltinsTable` into the existing shared-outputs-writer
path (grep for `"bit-fields.h"` to find the dump site; add a sibling
call).

Populate `cc_builtins_table_entries_` in `Visit(Builtin*)` line 587
(the kCCBuiltins case), right before `return;` at the end of the
whitelisted-nonjs-stub emission block. Capture return_type +
param_types as strings via `GetRuntimeType()`.

**Step 3: Declare `TorqueCcEntryOf` in builtins.h + implement in builtins.cc**

In `builtins.h`, near line 100-110 (next to `CppEntryOf` if it
exists — check), add:

```cpp
  // Returns the entry address for a Torque-translated TFJ builtin
  // (kind: kStub, non-JS-linkage, whitelisted via
  // --cc-builtins-whitelist). Returns Address{} for any other builtin.
  static Address TorqueCcEntryOf(Builtin builtin);
```

In `builtins.cc`, near line 350 (next to `CppEntryOf`), add:

```cpp
// Forward declarations for every Torque-translated TFJ builtin.
#define DECLARE(Name, RetType, ParamTypes) \
  extern "C" RetType Builtin_##Name ParamTypes;
#include "torque-generated/builtins-cc-table.inc"
TORQUE_CC_BUILTINS(DECLARE)
#undef DECLARE

// static
Address Builtins::TorqueCcEntryOf(Builtin builtin) {
  switch (builtin) {
#define CASE(Name, RetType, ParamTypes) \
    case Builtin::k##Name: return reinterpret_cast<Address>(&Builtin_##Name);
    TORQUE_CC_BUILTINS(CASE)
#undef CASE
    default: return Address{};
  }
}
```

(Note the `extern "C"` — generated Torque-CC builtins must be callable
as C linkage to match the function-pointer type in `TorqueCcEntryOf`.
Verify: check whether the generated
`Tagged<Smi> Builtin_TorqueCcTest_Return(Isolate*, ...)` has `extern "C"`
or is default C++ linkage. If the latter, either wrap in `extern "C"`
OR drop the C-linkage requirement and just use plain `&Builtin_Name`.
Torque's generated kCCBuiltins emission in `Visit(Builtin*)` would
need to wrap with `extern "C"` — add that to Task 4.3 Step 4's emission
if needed.)

**Step 4: Update `CallBuiltinPointer` emission to use `TorqueCcEntryOf`**

In `cc-generator.cc:541-542`, change:

```cpp
        << "    FnPtr fn = reinterpret_cast<FnPtr>(\n"
        << "        Builtins::CppEntryOf(static_cast<Builtin>(\n"
        << "            Smi::ToInt(" << function << "))));\n"
```

To:

```cpp
        << "    FnPtr fn = reinterpret_cast<FnPtr>(\n"
        << "        Builtins::TorqueCcEntryOf(static_cast<Builtin>(\n"
        << "            Smi::ToInt(" << function << "))));\n"
```

**Step 5: Rebuild torque, regenerate `call-builtin-pointer` golden**

```bash
cd examples/libs/nodejs/build/node
ninja -C out/Release.baseline torque 2>&1 | tail -10
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
UPDATE_GOLDEN=1 bash examples/libs/nodejs/test/run-torque-fixtures.sh \
  call-builtin-pointer
git diff examples/libs/nodejs/test/torque-fixtures/golden/call-builtin-pointer-tq-ccbuiltins.cc
```

Expected diff: `CppEntryOf` → `TorqueCcEntryOf` (one-liner).

**Step 6: Verify the generated .inc file appears in the output tree**

```bash
cd examples/libs/nodejs/build/node
# Re-run torque over the fixture harness and check for the shared output.
bash ../../test/run-torque-fixtures.sh return  # pick any fixture
ls -la /tmp/torque-fixtures-*/builtins-cc-table.inc 2>/dev/null \
  || echo "Note: Task 4.6's shared-outputs hook needs verification"
```

If the shared outputs land in the harness's `$OUT_DIR`, inspect the
content of `builtins-cc-table.inc` — should list every whitelisted
non-JS-linkage stub builtin (for a single-fixture run, exactly one
entry).

**Step 7: Commit**

```bash
cd examples/libs/nodejs/build/node
git add deps/v8/src/torque/implementation-visitor.cc \
        deps/v8/src/torque/implementation-visitor.h \
        deps/v8/src/torque/cc-generator.cc \
        deps/v8/src/builtins/builtins.h \
        deps/v8/src/builtins/builtins.cc
git -c user.email=build@wasm-posix-kernel.local \
    -c user.name="wasm-posix-kernel build" \
    commit -m "torque: emit builtins-cc-table.inc + add TorqueCcEntryOf dispatch"
```

And in the worktree (golden):

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/test/torque-fixtures/golden/call-builtin-pointer-tq-ccbuiltins.cc
git commit -m "nodejs: Phase 4 — regenerate call-builtin-pointer golden (TorqueCcEntryOf)"
```

---

## Task 4.7: Gyp integration — `torque_outputs_ccbuiltins_cc`

**Context:** Phase 1 deviation #1 flagged this as Phase 4's
responsibility. Node.js's build pipeline is gyp, and
`tools/v8_gypfiles/v8.gyp` derives per-torque-file output lists at
lines 15-23. Without the `torque_outputs_ccbuiltins_cc` variable + its
inclusion in `run_torque`'s `outputs` + `torque_generated_definitions`'s
sources, the `-tq-ccbuiltins.cc` files are produced but never
compiled — the dispatch table references become link errors.

**Files:**
- Modify: `tools/v8_gypfiles/v8.gyp` — add the variable definition
  (line ~23), add to `run_torque` outputs (line ~144), add to
  `torque_generated_definitions.direct_dependent_settings.sources`
  (line ~227).

**Step 1: Add the variable**

In `tools/v8_gypfiles/v8.gyp` at line 23 (after
`'torque_outputs_inc': [...]`), add:

```
    'torque_outputs_ccbuiltins_cc': ['<!@pymod_do_main(ForEachFormat "<(SHARED_INTERMEDIATE_DIR)/torque-generated/%s-ccbuiltins.cc" <@(torque_files_replaced))'],
```

(The `-ccbuiltins.cc` suffix comes from Phase 1's
`WriteCCBuiltinsFile` hook in torque — verify by reading the
implementation-visitor.cc commit `7cf1abb5` "torque: write
-tq-ccbuiltins.cc per source file". If the actual suffix is
`-tq-ccbuiltins.cc`, use that.)

**Step 2: Add to `run_torque`'s outputs**

In `tools/v8_gypfiles/v8.gyp` line 144 (the outputs list in
`run_torque_action`), after `'<@(torque_outputs_inc)',` add:

```
            '<@(torque_outputs_ccbuiltins_cc)',
            "<(SHARED_INTERMEDIATE_DIR)/torque-generated/builtins-cc-table.inc",
```

**Step 3: Add to `torque_generated_definitions`'s sources**

In `tools/v8_gypfiles/v8.gyp` line 227 (inside the
`torque_generated_definitions` target's
`direct_dependent_settings.sources` list), after
`'<@(torque_outputs_inc)',` add:

```
          '<@(torque_outputs_ccbuiltins_cc)',
```

(`builtins-cc-table.inc` is `#include`'d by `builtins.cc` and should
NOT be in a sources list — just an input to the include path, which
is already at `<(SHARED_INTERMEDIATE_DIR)` via `include_dirs`. Verify.)

**Step 4: Hook the `--cc-builtins-whitelist` CLI arg into `run_torque_action`**

Currently `run_torque`'s action at line 146-151 does NOT pass a
whitelist. Phase 4's smoke test needs to pass
`--cc-builtins-whitelist=TorqueCcTest_Return` so the `return` fixture
is translated. Introduce a gyp variable:

At the top of the `variables` block (line 5-23), add:

```
    'v8_torque_cc_builtins_whitelist%': '',
```

Then in the action (line 146-151), insert before `<@(torque_files_without_v8_root)`:

```
            '--cc-builtins-whitelist=<(v8_torque_cc_builtins_whitelist)',
```

(Empty string means no whitelist = all builtins hit the Phase 1 stub
path; same behavior as un-patched torque for non-kCCBuiltins users.
Smoke-test builds pass the flag via `GYP_DEFINES`.)

**Step 5: Commit**

```bash
cd examples/libs/nodejs/build/node
git add tools/v8_gypfiles/v8.gyp
git -c user.email=build@wasm-posix-kernel.local \
    -c user.name="wasm-posix-kernel build" \
    commit -m "v8 gyp: compile -tq-ccbuiltins.cc + wire --cc-builtins-whitelist"
```

---

## Task 4.8: Host-native CSS+jitless V8 build with the patch applied

**Context:** Phase 4 goal #5. Phase 0 Task 0.8 proved CSS+jitless
builds on unpatched V8; Phase 4 repeats with the patch applied and the
smoke-test whitelist set. Uses `out/Release` (NOT `Release.baseline`)
so `Release.baseline` stays as the stock torque-rebuilder location.

**Files:**
- Create: `examples/libs/nodejs/build-v8-host-phase4.sh` — a
  dedicated host-build script. Idempotent: skips configure if already
  done; always re-runs the link target.

**Step 1: Write the build script**

`examples/libs/nodejs/build-v8-host-phase4.sh`:

```bash
#!/usr/bin/env bash
# Phase 4 — build host-native V8 with CSS + jitless + the kCCBuiltins
# patch applied, and with TorqueCcTest_Return whitelisted. Output goes
# to ${NODE_SRC}/out/Release (stock torque rebuilder lives at
# Release.baseline; do not disturb it).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_SRC="${HERE}/build/node"
WHITELIST="${V8_CC_BUILTINS_WHITELIST:-TorqueCcTest_Return}"

[ -d "${NODE_SRC}/deps/v8" ] || {
  echo "Missing ${NODE_SRC}/deps/v8 — run build-nodejs.sh first" >&2
  exit 1
}

cd "${NODE_SRC}"

# Apply the consolidated patch if not already.
bash "${HERE}/build-nodejs.sh"  # idempotent (marker-based)

# Configure (only if out/Release doesn't already have a build.ninja).
if [ ! -f "out/Release/build.ninja" ]; then
  echo ">>> ./configure --ninja --v8-lite-mode"
  GYP_DEFINES="v8_enable_conservative_stack_scanning=1 v8_torque_cc_builtins_whitelist=${WHITELIST}" \
    ./configure --ninja --v8-lite-mode
fi

# Build. The unit-test target ('v8_unittests') pulls in v8_base_without_compiler
# and the gtest harness. Phase 4's smoke test gets added to unittests in Task 4.9.
echo ">>> ninja -C out/Release v8_snapshot"
ninja -C out/Release v8_snapshot
echo ">>> ninja -C out/Release mksnapshot"
ninja -C out/Release mksnapshot

echo ">>> Phase 4 host build OK. Torque-CC whitelist: ${WHITELIST}"
```

**Step 2: Run the script — baseline**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
chmod +x examples/libs/nodejs/build-v8-host-phase4.sh
bash examples/libs/nodejs/build-v8-host-phase4.sh 2>&1 | tee /tmp/phase4-build.log
echo "exit=$?"
```

Expected: exit 0 from both `ninja -C out/Release v8_snapshot` and
`ninja -C out/Release mksnapshot`. Build output lands at
`${NODE_SRC}/out/Release/libv8_snapshot.a` and
`${NODE_SRC}/out/Release/mksnapshot`.

**Failure modes to expect**:

- **Generated `Builtin_TorqueCcTest_Return` not found at link time.**
  Cause: gyp didn't pick up `-ccbuiltins.cc` in the sources list
  (Task 4.7 Step 3 missing/incorrect). Fix: check
  `out/Release/obj/v8_base_without_compiler/torque-generated/` for
  `*-tq-ccbuiltins.o` files. If missing, re-inspect gyp wiring.
- **`TORQUE_CC_BUILTINS` macro not defined.** Cause:
  `builtins-cc-table.inc` not in the include path. Fix: shared outputs
  list in gyp must list it (Task 4.7 Step 2).
- **CSS + whitelist interaction.** Should be none — CSS is a GC
  discipline, whitelist is a codegen flag. If a crash surfaces,
  document in verification.md under "Plan deviations surfaced during
  Phase 4 implementation" and drop the whitelist if needed for a
  baseline-first link.

**Step 3: Commit the build script**

```bash
git add examples/libs/nodejs/build-v8-host-phase4.sh
git commit -m "nodejs: Phase 4 — host CSS+jitless V8 build script"
```

No patch file changes this task — the .gyp + shell script live in
tracked places.

---

## Task 4.9: First d8 smoke test — C++ unit test linking `TorqueCcTest_Return`

**Context:** Phase 4 goal #6. The cleanest way to invoke a
Torque-CC-emitted function from V8's test harness is a `gtest` unit
test under `deps/v8/test/unittests/`. Direct invocation (NOT through
`Builtins::code(Builtin::k...)`) is sufficient for Phase 4 — the
interpreter integration path is Phase 5.

**Files:**
- Create (in the Node.js clone, NOT worktree):
  `deps/v8/test/unittests/torque/torque-cc-builtin-unittest.cc`
- Modify:
  `deps/v8/test/unittests/BUILD.gn` and/or the unittests gyp target —
  register the new file.

**Step 1: Inspect existing test infrastructure**

```bash
cd examples/libs/nodejs/build/node
ls deps/v8/test/unittests/ | head -20
ls deps/v8/test/unittests/heap/ | head -10  # pick one as a template
cat deps/v8/test/unittests/BUILD.gn | head -50
```

Find a minimal test file that spins up `TEST_F(FooTest, Bar)` with a
real `Isolate*`. Candidates:
`test/unittests/heap/gc-unittest.cc`,
`test/unittests/execution/microtask-queue-unittest.cc`. Pick
something already in the file list.

**Step 2: Create `torque/torque-cc-builtin-unittest.cc`**

```cpp
// Copyright 2024 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can
// be found in the LICENSE file.

#include "src/builtins/builtins.h"
#include "src/execution/isolate.h"
#include "src/objects/smi.h"
#include "src/objects/tagged.h"
#include "src/runtime/runtime.h"
#include "test/unittests/test-utils.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace v8 {
namespace internal {

// Phase 4 smoke test: direct invocation of a Torque-CC-translated
// builtin. The Torque fixture at
// examples/libs/nodejs/test/torque-fixtures/return.tq defines a
// trivial `builtin TorqueCcTest_Return(ctx, arg: Smi): Smi { return
// arg; }`. The kCCBuiltins pass (whitelisted via the build script)
// emits Tagged<Smi> Builtin_TorqueCcTest_Return(Isolate*,
// Tagged<Context>, Tagged<Smi>). This test links that symbol and
// calls it.

extern "C" Tagged<Smi> Builtin_TorqueCcTest_Return(
    Isolate* isolate, Tagged<Context> context, Tagged<Smi> arg);

using TorqueCcBuiltinTest = TestWithIsolate;

TEST_F(TorqueCcBuiltinTest, DirectInvocation) {
  Tagged<Smi> input = Smi::FromInt(42);
  Tagged<Smi> result = Builtin_TorqueCcTest_Return(
      isolate(), Tagged<Context>(isolate()->native_context()), input);
  EXPECT_EQ(Smi::ToInt(result), 42);
}

TEST_F(TorqueCcBuiltinTest, DispatchTableLookup) {
  // Builtin::kTorqueCcTest_Return should resolve via TorqueCcEntryOf
  // to the same address as &Builtin_TorqueCcTest_Return.
  Address direct = reinterpret_cast<Address>(&Builtin_TorqueCcTest_Return);
  Address via_table =
      Builtins::TorqueCcEntryOf(Builtin::kTorqueCcTest_Return);
  EXPECT_EQ(direct, via_table);
}

}  // namespace internal
}  // namespace v8
```

**Caveat:** `Builtin::kTorqueCcTest_Return` only exists in the builtin
enum if the Torque fixture is registered in
`deps/v8/src/builtins/builtins-definitions.h` or reaches the enum via
Torque's `builtin` keyword. If the fixture is staged only via the
harness symlink, the enum entry might NOT be produced. Check by
inspecting `out/Release/gen/torque-generated/builtin-definitions.h`
after Task 4.8's build.

If the enum entry is missing: either (a) stage the fixture
permanently under `deps/v8/test/` with a v8-root-visible path so the
stock torque run picks it up, or (b) use the fixture ONLY as a
syntactic/codegen smoke test (Task 4.9 Step 2 TEST_F only, skip
DispatchTableLookup). Document the chosen option.

**Step 3: Register the test file**

In `deps/v8/test/unittests/BUILD.gn`, find the `v8_source_set("unittests_sources")`
block (or wherever the existing test .cc files are listed). Add:

```
"torque/torque-cc-builtin-unittest.cc",
```

Since Node.js builds via gyp, ALSO find
`tools/v8_gypfiles/*.gyp` entries for unittests (may be in
`v8.gyp` or a separate `v8_unittests.gyp`). Register the new .cc
file there too.

**Step 4: Build + run the test**

```bash
cd examples/libs/nodejs/build/node
ninja -C out/Release v8_unittests
./out/Release/v8_unittests --gtest_filter='TorqueCcBuiltinTest.*' \
  2>&1 | tee /tmp/phase4-test.log
```

Expected: `2 tests from TorqueCcBuiltinTest`, both PASS.

**Failure modes:**

- **Link error: undefined reference to `Builtin_TorqueCcTest_Return`.**
  Cause: whitelist didn't include the fixture. Re-check the gyp
  variable (Task 4.7 Step 4) and the build script (Task 4.8 Step 1).
- **Crash in `TestWithIsolate` setup.** Cause: CSS + jitless
  incompatibility at runtime. Document in verification.md; may need to
  drop CSS for the initial smoke test and revisit.
- **Assertion failure in DispatchTableLookup.** Likely
  `Builtin::kTorqueCcTest_Return` resolves to a DIFFERENT address
  (perhaps a CPP-class dummy). Inspect `Builtins::Kind(Builtin::k...)` —
  if it's not `kStub`, the torque fixture was mis-registered.

**Step 5: Commit both the test + harness registrations**

```bash
cd examples/libs/nodejs/build/node
git add deps/v8/test/unittests/torque/torque-cc-builtin-unittest.cc \
        deps/v8/test/unittests/BUILD.gn
# (add any gyp file modified in Step 3)
git -c user.email=build@wasm-posix-kernel.local \
    -c user.name="wasm-posix-kernel build" \
    commit -m "v8: Phase 4 smoke test — invoke Torque-CC-translated builtin directly"
```

---

## Task 4.10: Run full 12-fixture harness pass + regression check

**Context:** Same as Phase 3 Tasks 3.7 + 3.9. With Phase 4 complete,
the harness holds 12 fixtures (11 Phase 2/3 + `goto-external` added in
Phase 4 Task 4.5 + `call-torque-macro` added in Phase 4 Task 4.3 = 13;
or 12 if you collapsed those two in Task 4.5 Step 1).

**Files:** none modified.

**Step 1: Run harness**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
bash examples/libs/nodejs/test/run-torque-fixtures.sh
```

Expected: all fixtures OK. Exit 0.

**Step 2: Non-whitelisted regression check**

```bash
cd examples/libs/nodejs/build/node
TQ_FILES=$(cat /tmp/phase4-tq-files.txt)
rm -rf /tmp/torque-phase4-regression
mkdir -p /tmp/torque-phase4-regression
echo "$TQ_FILES" | sed 's|[^/]*$||' | sort -u | while read d; do
  mkdir -p "/tmp/torque-phase4-regression/$d"
done
./out/Release.baseline/torque \
  -o /tmp/torque-phase4-regression \
  -v8-root deps/v8 \
  $TQ_FILES 2>&1 | tail -5
echo "exit=$?"
```

Expected: exit 0.

**Step 3: Non-ccbuiltins sha match**

```bash
find /tmp/torque-phase4-regression -type f ! -name '*-tq-ccbuiltins.cc' \
  -print0 | sort -z | xargs -0 cat | shasum
```

Expected: `a5195c0258fd9af9415e9d41f0c2e38237989c1b` (unchanged since
Phase 1). If differs, stop — Phase 4's patches leaked into the stock
passes.

**Step 4: ccbuiltins-only sha inspection**

Phase 4 IS expected to change the ccbuiltins sha (macro-body emission
adds bodies to files that reference them). Compute the new sha for
the Phase 4 record:

```bash
find /tmp/torque-phase4-regression -type f -name '*-tq-ccbuiltins.cc' \
  -print0 | sort -z | xargs -0 cat | shasum > /tmp/phase4-ccb.sum
diff /tmp/torque-baseline-phase4-ccb.sum /tmp/phase4-ccb.sum \
  > /tmp/phase4-ccb-diff.txt
cat /tmp/phase4-ccb-diff.txt
```

Document the new ccbuiltins sha in verification.md. Only whitelisted
builtins should have macro-body emissions — the regression check runs
WITHOUT a whitelist, so **if the ccbuiltins sha has changed at all,
investigate**. Non-whitelisted builtins still hit the Phase 1 stub
path; there should be zero effective emission difference for
non-whitelisted runs.

Expected: **no diff.** Any diff = a Phase 4 edit leaked into the
no-whitelist path and must be traced.

No commit — verification gate.

---

## Task 4.11: Export consolidated patch file

**Context:** Phase 4 adds ~8-10 commits on top of Phase 3's tip
(3 for macro-body emission at global-context.h + trigger + fifth
pass; 1 for label-exit gate; 1 for dispatch table; 1 for gyp;
1 for the unittest; 1 for whitelist plumbing). Re-export as a
single patch — same filename as Phase 1/2/3.

**Files:**
- Modify: `examples/libs/nodejs/patches/v8-torque-cc-builtins.patch`

**Step 1: Count commits**

```bash
cd examples/libs/nodejs/build/node
git log --oneline 9fe7634c..HEAD | tee /tmp/phase4-commits.txt
wc -l /tmp/phase4-commits.txt
```

Expected: ~34-36 (10 Phase 1 + 11 Phase 2 + 6 Phase 3 + 7-9 Phase 4).

**Step 2: Export**

```bash
N=$(wc -l < /tmp/phase4-commits.txt)
git format-patch -${N} --stdout > ../../patches/v8-torque-cc-builtins.patch
wc -l ../../patches/v8-torque-cc-builtins.patch
```

Expected: ~2000-2500 lines (Phase 3 was 1736 lines; Phase 4 adds
~500-800).

**Step 3: Verify re-application on upstream**

```bash
git tag phase4-commits HEAD
git reset --hard 9fe7634c
git apply --3way ../../patches/v8-torque-cc-builtins.patch
git status --short | head -20
```

Expected: ~12-15 files modified; no rejected hunks.

**Step 4: Restore and rebuild**

```bash
git reset --hard phase4-commits
git tag -d phase4-commits
ninja -C out/Release.baseline torque
```

**Step 5: Re-run full harness**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
bash examples/libs/nodejs/test/run-torque-fixtures.sh
```

Expected: all fixtures OK.

**Step 6: Re-run host V8 smoke test**

```bash
cd examples/libs/nodejs/build/node
ninja -C out/Release v8_unittests
./out/Release/v8_unittests --gtest_filter='TorqueCcBuiltinTest.*'
```

Expected: 2/2 tests PASS.

**Step 7: Commit the patch file update**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/patches/v8-torque-cc-builtins.patch
git commit -m "nodejs: Phase 4 — consolidated patch (macro-body + dispatch + gyp + smoke test)"
```

---

## Task 4.12: Update verification.md with Phase 4 summary

**Files:**
- Modify: `examples/libs/nodejs/verification.md`

**Step 1: Append a Phase 4 Summary section**

Add to the end of `verification.md`:

````markdown
## Phase 4 Summary

| Item | Result |
|---|---|
| Phase 4 spike decision committed (strategy: new fifth-pass + curated list) | ✅ |
| Macro-body emission under kCCBuiltins (fifth pass) | ✅ |
| `GenerateFunction` emits out-param signature for labels under kCCBuiltins | ✅ |
| `goto-external` fixture + golden (now exercisable) | ✅ |
| `call-torque-macro` fixture + golden | ✅ |
| `builtins-cc-table.inc` generation + `Builtins::TorqueCcEntryOf` dispatch | ✅ |
| `CallBuiltinPointer` emission uses `TorqueCcEntryOf` (placeholder retired) | ✅ |
| gyp integration: `torque_outputs_ccbuiltins_cc` + `--cc-builtins-whitelist` plumbing | ✅ |
| Host CSS+jitless V8 build with patch + whitelist (`build-v8-host-phase4.sh`) | ✅ |
| C++ unit test invokes `Builtin_TorqueCcTest_Return` directly (`TorqueCcBuiltinTest.DirectInvocation`) | ✅ |
| C++ unit test verifies dispatch table (`TorqueCcBuiltinTest.DispatchTableLookup`) | ✅ |
| Full 12+ fixture harness passes | ✅ |
| Non-whitelisted torque output sha unchanged vs Phase 3 (`a5195c0258fd9af9415e9d41f0c2e38237989c1b`) | ✅ |
| ccbuiltins-only output sha for non-whitelist run unchanged vs Phase 3 | ✅ |
| Consolidated patch exports + re-applies cleanly on upstream `9fe7634c` | ✅ |

**CCGenerator stubs after Phase 4: 0.** Every backend-dependent
instruction is real. Remaining `ReportError` gates are intentional
scope gates (catch-block, tailcall, JS-linkage, multi-result PairT)
that Phase 5+ addresses as fixtures force them.

**Phase 4 commit chain on the Node.js clone** (commits on top of Phase 3
tip `33051608`):
1. `torque: add AllMacrosForCCBuiltinsOutput list + accessor`
2. `torque: record TorqueMacros referenced from kCCBuiltins builtins`
3. `torque: add fifth pass emitting kCCBuiltins-referenced macro bodies`
4. `torque: emit out-param signature for labeled macros under kCCBuiltins`
5. `torque: emit builtins-cc-table.inc + add TorqueCcEntryOf dispatch`
6. `v8 gyp: compile -tq-ccbuiltins.cc + wire --cc-builtins-whitelist`
7. `v8: Phase 4 smoke test — invoke Torque-CC-translated builtin directly`
8. (+ any follow-up fixes surfaced during verification)

Total commits on top of upstream `9fe7634c` after Phase 4: ~34-36.

### Plan deviations surfaced during Phase 4 implementation

*(To be filled in as Phase 4 executes — follow the Phase 1/2/3 format:
bulleted list of deviations + "Phase 4 follow-ups for later phases."
Remove the TBD placeholder before landing.)*

- TBD

### Phase 4 follow-ups for later phases

- **Runtime exception handling** (`catch_block`) — still `ReportError`.
  Phase 5 or dedicated plan.
- **Tail-calls** (`CallBuiltin`, `CallBuiltinPointer`) — still
  `ReportError`. Phase 5 or dedicated plan.
- **JS-linkage builtin emission** (receiver / newTarget /
  dispatchHandle ABI + Descriptor machinery) — still the
  `(JS linkage deferred)` comment path in `Visit(Builtin*)`. Phase 5.
- **`Builtins::code(Builtin)` integration** — the smoke test calls the
  function directly; wiring it through V8's entry table /
  interpreter requires additional builtin-kind metadata + embedded
  builtin bootstrapping. Phase 5 or 6.
- **mksnapshot integration** — the generated builtins need to be
  visible to mksnapshot so `libv8_snapshot.a` can serialize valid
  pointers. Current smoke test links in a context where no snapshot
  serialization crosses a translated builtin; integration is Phase 5+.
- **Label-value struct types.** Phase 4 Task 4.4 Step 2 reports error
  on struct label values; the single-value shape is sufficient for
  current fixtures but real V8 builtins use struct label values
  (e.g., `Cast<HeapObject>(x) otherwise Slow(Object)` in some paths).
  Phase 5 when first fixture forces it.
- **`extern "C"` linkage for translated builtins.** Phase 4's
  implementation either wraps the generated `Builtin_<Name>` with
  `extern "C"` or relies on C++ linkage. Document which was chosen
  and flag if Phase 5's interpreter path requires the other.

**Next:** Phase 5. Write
`docs/plans/2026-04-20-torque-cc-backend-phase5.md` covering the
first d8 `-e "print(1+2)"` smoke test, building out the hand-written
CSA replacement ledger, and wiring translated builtins through
`Builtins::code(Builtin)` for interpreter dispatch.
````

**Step 2: Commit**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/verification.md
git commit -m "nodejs: Phase 4 — verification.md Phase 4 summary"
```

---

## Task 4.13: Update PR #306 with Phase 4 changes

**Context:** PR #306 is the umbrella PR for the Torque CC backend work.
Phase 4 adds substantial surface area — push the branch and re-check
the PR description to reflect Phase 4 scope.

**Files:** none modified in the worktree tree; this is a PR update.

**Step 1: Push the branch**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git push origin torque-cc-backend
```

Expected: clean push; CI may run. **Do NOT push to main.**

**Step 2: Verify PR #306 reflects Phase 4 progress**

```bash
gh pr view 306
```

If the PR description is stale (still mentions Phase 3 as the latest
phase), update it via `gh pr edit 306 --body "..."` with a brief
paragraph summarizing Phase 4 changes + a link to
`docs/plans/2026-04-20-torque-cc-backend-phase4.md` and
`examples/libs/nodejs/verification.md`'s Phase 4 Summary.

No worktree commit — PR surgery only.

---

## Phase 4 Execution Notes

- **Task ordering.** Tasks 4.2 → 4.3 → 4.4 → 4.5 is a single
  dependency chain. 4.6 (dispatch table) is independent of 4.3/4.4 but
  must complete before 4.7 (gyp) and 4.8 (build). 4.9 depends on 4.8.
  4.10/4.11/4.12/4.13 are after-the-fact verification + PR hygiene.
- **Tasks 4.3 and 4.4 land together.** The macro-body emission and the
  out-param signature are mutually dependent — emitting a body without
  the signature compiles to wrong C++, and vice versa. Merge them in a
  single cc-generator.cc / implementation-visitor.cc change if that's
  cleaner.
- **Regenerate Phase 3 goldens carefully.** Phase 4 Task 4.3 Step 6
  regenerates `make-lazy-node` and possibly
  `call-csa-macro-and-branch`. Inspect diffs BEFORE accepting —
  unexpected changes in Phase 2 goldens (e.g., `return`,
  `call-runtime`) suggest the fifth pass is over-emitting.
- **Do NOT push to `main`.** Work stays on the `torque-cc-backend`
  branch; PR #306 tracks it.
- **Fixture-first TDD.** Task 4.3 Step 1 writes the fixture BEFORE the
  implementation. First harness run after implementation uses
  `UPDATE_GOLDEN=1` to capture; subsequent runs verify byte-exact.
- **Single-source-of-truth for the patch file.** Every V8 edit lands as
  a commit in the Node.js clone; the worktree only holds fixtures, the
  harness, verification.md, the build script, and the consolidated
  patch. Never edit the patch file by hand — always re-export from the
  clone via `git format-patch`.
- **Host V8 build artifacts live at `out/Release/`.** Stock torque
  rebuilder stays at `out/Release.baseline/`. Do not cross them.
- **Smoke test failure modes are debuggable locally.** If the unit
  test fails, `lldb ./out/Release/v8_unittests --args --gtest_filter=...`
  should be usable — host V8 is native C++.

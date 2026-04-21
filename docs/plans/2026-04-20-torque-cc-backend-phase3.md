# Phase 3: Torque CC Backend — Hard Instructions (Design-Risk Phase) Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Retire the last 3 `ReportError` stubs in `cc-generator.cc` —
`CallCsaMacroAndBranchInstruction`, `MakeLazyNodeInstruction`, and
`GotoExternalInstruction` — so that every backend-dependent instruction has a
real emission under `OutputType::kCCBuiltins`. `CallCsaMacroAndBranch` is the
design-risk item: its CSA form relies on `CodeAssemblerLabel*` out-params +
`TypedCodeAssemblerVariable<T>*` per-label-value out-params (see
`csa-generator.cc:368-488`); the C++ analogue needs a new convention because
the existing kCC pass outright **`ReportError`s** when a macro has labels
(`implementation-visitor.cc:2056-2058`: "Macros that generate runtime code
can't have label exits"). The spike (Task 3.2) decides whether a 'label-enum
+ per-label out-param' rewrite is the right C++ convention, or whether we can
sidestep it by keeping labeled macros always-inlined under kCCBuiltins.
Phase 3 is complete when: every instruction has real emission, 3 new fixtures
pass under `run-torque-fixtures.sh` (brings total to 12), non-whitelisted
output is still byte-identical to the Phase 2 baseline, and the consolidated
patch re-applies cleanly on upstream `9fe7634c`.

**Architecture:** Same shape as Phase 2. All V8 edits land as commits on the
`examples/libs/nodejs/build/node/` clone and are re-exported into
`examples/libs/nodejs/patches/v8-torque-cc-builtins.patch` (same filename;
supersedes Phase 2). Phase 3 touches:

- `deps/v8/src/torque/cc-generator.cc` — replace the last 3 `ReportError`
  stubs (lines 315-319, 321-324, 496-499 after Phase 2).
- `deps/v8/src/torque/cc-generator.h` — possibly add a small helper for
  label-branch enum name mangling.
- `deps/v8/src/torque/declarable.h` — override `Macro::ShouldBeInlined` for
  kCCBuiltins when the macro has labels and is external (can't be inlined).
  Mirrors Phase 2's `RuntimeFunction::ShouldBeInlined` override.
- `deps/v8/src/torque/implementation-visitor.cc` — relax the kCCBuiltins
  label-exit restriction at line 2056-2058 so that the signature generator
  can emit out-param form when the spike confirms that's the chosen
  convention. (Scope is still limited — existing kCC path remains
  restrictive; only kCCBuiltins gets the rewrite.)

Plus new files in our worktree:

- `examples/libs/nodejs/test/torque-fixtures/call-csa-macro-and-branch.tq`
  (+ golden)
- `examples/libs/nodejs/test/torque-fixtures/make-lazy-node.tq` (+ golden)
- `examples/libs/nodejs/test/torque-fixtures/goto-external.tq` (+ golden)

**Tech Stack:**
- V8 13.6.233.17 (vendored in Node.js v24.x at `deps/v8/`) — same as Phase 1/2.
- GN + ninja + host clang — same as Phase 1/2.
- `clang++ -fsyntax-only` for parse-check of at least one of the three new
  fixture goldens.

**Torque binary location (UNCHANGED — same gotcha as Phase 2):** use
`out/Release.baseline/torque`, NOT `out/Release/torque`. `out/Release/` is
lite-mode and rejects `src/wasm/wasm-objects.tq` at parse time. Rebuild with
`ninja -C out/Release.baseline torque` after any patch change.

**Stock `.tq` file list (UNCHANGED — same gotcha as Phase 2):** use
`grep -oE '"(src|test|third_party)/[^"]*\.tq"' deps/v8/BUILD.gn | tr -d '"'
| sort -u` — produces 245 files. The narrower `"src/..."` pattern misses
`test/torque/test-torque.tq` and `third_party/v8/builtins/array-sort.tq`,
which trips torque with "cannot find SortState" partway through the run.

**Invariants (do not break):**
- Stock V8 builtins (anything not in the whitelist) continue to hit the
  Phase 1 comment-stub path in `Visit(Builtin*)`. **No regression in
  non-ccbuiltins torque output** (Task 3.11 asserts empty full-tree diff
  vs the Phase 2 post-tip baseline and matching sha
  `a5195c0258fd9af9415e9d41f0c2e38237989c1b`).
- The existing `kCSA` / `kCC` / `kCCDebug` passes keep their existing
  behavior — we do NOT widen kCC's "labels forbidden" gate for any output
  type other than kCCBuiltins. Hand-written V8 C++ that calls kCC-emitted
  macros keeps working.
- Every Phase 3 instruction emission matches its CSAGenerator sibling in
  structure (same `ProcessArgumentsCommon` usage, same `LowerType` /
  `DefinitionToVariable` discipline) — only the emitted C++ API calls
  differ. Same rule as Phase 2.
- Every new instruction has a golden-file-backed fixture in
  `examples/libs/nodejs/test/torque-fixtures/`.
- The 12 backend-dependent instructions now have zero `ReportError` stubs
  (except for the intentional within-instruction gates, e.g. "catch_block
  deferred", "tailcall deferred", "multi-result PairT deferred", which
  Phase 2 established and Phase 3 leaves in place).

**Out of scope for Phase 3:**
- Runtime exception handling (`catch_block` on CallCsaMacroAndBranch /
  CallRuntime / CallBuiltin) — still `ReportError`. This is a deeper
  redesign that needs its own plan (Phase 4 or later).
- Tail-calls from CallBuiltin / CallBuiltinPointer — still `ReportError`.
- JS-linkage builtins — still the "JS linkage deferred" comment path in
  `Visit(Builtin*)`.
- `builtins-cc-table.inc` dispatch table — still Phase 4.
- Actually linking and running a translated builtin in V8 — Phase 4/5.
- wasm32 cross-compile — Phase 7+.

**Phase-2 lessons Phase-3 inherits** (from `examples/libs/nodejs/verification.md`
"Plan deviations surfaced during Phase 2 implementation"):

1. **`RuntimeFunction::ShouldBeInlined` must return false for kCCBuiltins**
   or the call-emission path inlines the runtime function and silently drops
   its arguments. Phase 2 already fixed this. Phase 3 adds the analogous
   `Macro::ShouldBeInlined` override (conditional — labeled extern macros
   can't be inlined, so they must escape via the CallCsaMacroAndBranch
   path). **Watch: Intrinsics may need the same treatment** (Phase 2
   verification flagged this as open). If a Phase 3 fixture hits an
   Intrinsic inlining-drop, add the override.
2. **`PushUninitializedInstruction.type` is `TopType`** — must
   `TopType::DynamicCast(...)->source_type()` before calling
   `GetRuntimeType()`. Already handled in Phase 2; flagged here in case a
   Phase 3 fixture surfaces a similar TopType unwrap need (e.g., around
   MakeLazyNode's `result_type`).
3. **Fixture path portability** — fixtures MUST be symlinked into
   `$NODE_SRC/deps/v8/test/phase3-fixtures/<name>.tq` and passed as
   v8-root-relative paths to torque, so the generated `// Source:`
   comment is `test/phase3-fixtures/<name>.tq` and not a user-specific
   `file:///Users/...` URI. The Phase 2 harness at
   `examples/libs/nodejs/test/run-torque-fixtures.sh` already does this
   via its staging step — Phase 3 fixtures go through the same harness,
   no harness surgery needed beyond registering the 3 new fixtures.
4. **`CallIntrinsic` constexpr_arguments can segfault on empty vectors**
   when `%FromConstexpr` is driven by an integer literal (`cc-generator.cc`
   `ProcessArgumentsCommon`, pre-existing Phase 0 bug). Phase 3 fixtures
   avoid integer-literal initialization in favor of parameter-driven
   values, same workaround as Phase 2.
5. **`--cc-builtins-whitelist` CSV auto-built from `builtin TorqueCcTest_*`
   declarations in fixtures.** Already wired in Task 2.14 of Phase 2. Phase
   3 fixtures keep the `TorqueCcTest_` prefix convention. If a fixture
   defines a helper MACRO (e.g., `macro TorqueCcTest_CheckSmi(...) labels
   ...`), the whitelist only covers builtins — that's fine because macros
   are handled via `ShouldBeInlined` / call-emission, not the
   `Visit(Builtin*)` whitelist.

---

## Task 3.1: Capture post-Phase-2 torque baseline

**Context:** Phase 3 must not regress non-whitelisted builtins or the
kCSA / kCC / kCCDebug passes. Snapshot the current torque output (Phase 2
tip) so Task 3.11 has a regression target.

**Files:** none committed. Writes scratch files to `/tmp/`.

**Step 1: Confirm Phase 2 patch is applied at the Node.js clone tip**

```bash
cd examples/libs/nodejs/build/node
git log --oneline 9fe7634c..HEAD | wc -l    # expect ~21 (10 Phase 1 + 11 Phase 2)
git log --oneline -12 | head
```

Expected: 21 commits on top of upstream `9fe7634c`, tip is
`torque: implement CCGenerator::Emit(CallBuiltinPointerInstruction)` (or
similar Phase 2 commit per `verification.md` Phase 2 summary).

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
echo "$TQ_FILES" > /tmp/phase3-tq-files.txt
```

**Step 3: Run torque over stock fileset, capture output tree**

```bash
rm -rf /tmp/torque-baseline-phase3
mkdir -p /tmp/torque-baseline-phase3
echo "$TQ_FILES" | sed 's|[^/]*$||' | sort -u | while read d; do
  mkdir -p "/tmp/torque-baseline-phase3/$d"
done
./out/Release.baseline/torque \
  -o /tmp/torque-baseline-phase3 \
  -v8-root deps/v8 \
  $TQ_FILES 2>&1 | tee /tmp/phase3-baseline.log
echo "exit=$?"
```

Expected: exit 0, 1490 files generated (1245 baseline + 245 new
`-tq-ccbuiltins.cc`).

**Step 4: Verify the non-ccbuiltins sha matches the Phase 1/2 documented value**

```bash
find /tmp/torque-baseline-phase3 -type f ! -name '*-tq-ccbuiltins.cc' \
  -print0 | sort -z | xargs -0 cat | shasum \
  > /tmp/torque-baseline-phase3-noccb.sum
cat /tmp/torque-baseline-phase3-noccb.sum
```

Expected: `a5195c0258fd9af9415e9d41f0c2e38237989c1b` (byte-identical to the
Phase 1 and Phase 2 baselines per `verification.md`). If this differs, the
tree has drifted — stop and investigate before proceeding (the regression
gate in Task 3.11 will be meaningless otherwise).

**Step 5: Record full-tree sha + count for Task 3.11 diff**

```bash
find /tmp/torque-baseline-phase3 -type f | sort | wc -l \
  > /tmp/torque-baseline-phase3.count
find /tmp/torque-baseline-phase3 -type f -print0 | sort -z | \
  xargs -0 cat | shasum > /tmp/torque-baseline-phase3.sum
cat /tmp/torque-baseline-phase3.count /tmp/torque-baseline-phase3.sum
```

Expected: `1490` + a SHA. Both recorded in scratch.

No commit — this is a measurement.

---

## Task 3.2: Spike — write a minimal fixture that forces `CallCsaMacroAndBranch`, observe CFG

**Context (DESIGN RISK — READ CAREFULLY):** The handoff doc
(`docs/plans/2026-04-20-torque-cc-backend-handoff.md` §"Phase 3 — Non-Trivial
Instructions") calls out a signature-rewrite pattern for
`CallCsaMacroAndBranch`: callee gets `LabelBranch* out_branch` +
per-label-value out-params; caller emits a `switch (branch)`. Before
committing to that pattern across the emission, verify empirically WHICH
code shapes even produce `CallCsaMacroAndBranchInstruction` under
`kCCBuiltins`.

**What we already know (from reading the V8 source during planning — do NOT
re-derive, cite this section in PR descriptions):**

1. `declarable.h:319-326`: `Callable::ShouldBeInlined(OutputType)` default
   returns `true` for kCCBuiltins unconditionally (comment says "only
   Builtin declarables produce output; all other callables are suppressed
   by being 'inlined'"). Phase 2 had to override this on
   `RuntimeFunction` → false, because otherwise runtime-function calls got
   inlined with dropped arguments. `Builtin::ShouldBeInlined` already
   returns false for kCCBuiltins (Phase 1).
2. `implementation-visitor.cc:2892-3170`: the call-lowering path
   (`GenerateCall`). Line 3115 emits `CallCsaMacroInstruction` when the
   macro has NO labels; line 3128 emits `CallCsaMacroAndBranchInstruction`
   when the macro has labels AND is not inlined AND the caller provides
   `otherwise` exits.
3. `implementation-visitor.cc:3100-3107`: `inline_macro` path calls
   `InlineMacro(...)` which flattens the callee body AND binds the
   callee's labels to the caller's `label_blocks` — so `GotoExternal`
   inside an inlined macro's body becomes a regular `GotoInstruction` to
   the caller's blocks. **Under kCCBuiltins with the default
   `ShouldBeInlined=true`, Torque-source macros with labels are ALWAYS
   inlined** — so `CallCsaMacroAndBranchInstruction` AND
   `GotoExternalInstruction` should fire ONLY for extern macros (which
   have no body and cannot be inlined).
4. `implementation-visitor.cc:2056-2058`: in the existing kCC pass, the
   function-signature generator `ReportError`s if any label exists on a
   macro: `"Macros that generate runtime code can't have label exits"`. So
   the kCC pass currently has NO way to emit a labeled-macro signature. We
   need to either relax this gate for kCCBuiltins or emit the labeled
   macro signature from a new code path.

**Spike goal:** confirm that `CallCsaMacroAndBranchInstruction` only fires
in kCCBuiltins when calling an ExternMacro with labels. Narrow cases = lean
implementation.

**Files:**
- Create (temporary, will graduate into a real fixture later):
  `examples/libs/nodejs/test/torque-fixtures/_spike-ccmab.tq`

**Step 1: Find an extern macro with labels that's easy to call from a stub
builtin**

Grep the V8 Torque stdlib for extern macros that have `labels`:

```bash
cd examples/libs/nodejs/build/node
grep -RnE '^\s*extern\s+macro\s+\w+\([^)]*\)\s*(:\s*\w+)?\s*labels\s+\w+' \
  deps/v8/src/builtins/*.tq deps/v8/src/objects/*.tq | head -20
```

Expected: list of extern macros with labels. Canonical candidates:
`Cast<HeapObject>` (from `base.tq`: `extern macro TaggedToHeapObject(...):
HeapObject labels CastError;`), `TryInt32Constant(...)`, similar.

Pick one that takes ONLY a `Tagged<Object>`-style parameter and has a
single label with no label-value parameters (simplest possible shape).
Document the choice as a comment in the fixture.

**Step 2: Write a minimal builtin that invokes the extern macro with `otherwise`**

`examples/libs/nodejs/test/torque-fixtures/_spike-ccmab.tq`:

```
// Phase 3 SPIKE — NOT a permanent fixture. Deleted/replaced in Task 3.8.
// Goal: produce a CallCsaMacroAndBranchInstruction in the IR under kCCBuiltins.
namespace test_cc {
  // Replace CANDIDATE_MACRO with the extern macro picked in Step 1.
  // E.g., `TaggedToHeapObject` (from `base.tq`).
  builtin TorqueCcTest_SpikeCcMab(implicit context: Context)(arg: Object): Smi {
    const _h: HeapObject = Cast<HeapObject>(arg) otherwise Bailout;
    return 0;
    label Bailout {
      return -1;
    }
  }
}
```

(If `Cast<HeapObject>` desugars to a CallCsaMacro without labels because
the cast helper is defined in .tq and inlined, try a more primitive
extern-macro path: `TryFromIntptr<Smi>(...) labels ...`, or directly
`TaggedToHeapObject`. Adjust until IR shows the desired instruction.)

**Step 3: Stage the spike fixture and run torque with `-annotate-ir`**

```bash
cd examples/libs/nodejs/build/node
mkdir -p deps/v8/test/phase3-fixtures
ln -sfn \
  "$(cd ../../test/torque-fixtures && pwd)/_spike-ccmab.tq" \
  deps/v8/test/phase3-fixtures/_spike-ccmab.tq

rm -rf /tmp/phase3-spike
mkdir -p /tmp/phase3-spike
TQ_FILES=$(cat /tmp/phase3-tq-files.txt)
echo "$TQ_FILES" test/phase3-fixtures/_spike-ccmab.tq | tr ' ' '\n' \
  | sed 's|[^/]*$||' | sort -u | while read d; do
  mkdir -p "/tmp/phase3-spike/$d"
done

./out/Release.baseline/torque \
  --cc-builtins-whitelist=TorqueCcTest_SpikeCcMab \
  -annotate-ir \
  -o /tmp/phase3-spike \
  -v8-root deps/v8 \
  $TQ_FILES test/phase3-fixtures/_spike-ccmab.tq 2>&1 \
  | tee /tmp/phase3-spike.log
echo "exit=$?"
```

Expected outcomes (two possibilities):

- **Outcome A (happy path):** torque exits with a `Not supported in C++ output:
  CallCsaMacroAndBranch` error pointing at the spike fixture. This confirms
  the instruction DOES fire for this shape. Proceed to Task 3.3.
- **Outcome B (instruction doesn't fire):** torque emits a real function
  body (Cast was inlined, or resolved through a different path). Inspect
  the IR dump (`/tmp/phase3-spike/...**-tq.inc.ir`) to see which
  instructions were generated. If only `CallCsaMacro` (no label variant),
  pick a different extern macro (one that's truly labeled in its `.tq`
  declaration) and repeat.

**Step 4: Also try a fixture that forces `GotoExternal`**

Outcome A above proves CallCsaMacroAndBranch fires; we still need to see
whether `GotoExternal` can appear inside a kCCBuiltins-emitted builtin.
Given the analysis above (labeled Torque macros are always inlined under
kCCBuiltins), `GotoExternal` SHOULD be impossible to produce in a builtin
body — but this must be verified, not assumed. Write a second spike
fixture:

```
namespace test_cc {
  // Inline-forbidden pattern: the builtin itself takes a label.
  // NOTE: Torque does not allow builtins to have label exits in their
  // signature — this will likely be rejected at parse time. If so, the
  // experiment documents the impossibility.
  builtin TorqueCcTest_SpikeGotoExt(implicit context: Context)(arg: Smi): Smi
    labels Overflow /* …won't parse — intentional */ {
    goto Overflow;
  }
}
```

Expected: torque rejects with `Builtin signatures cannot have labels`, or
similar. If that rejection fires, document it — `GotoExternal` inside
`kCCBuiltins::Visit(Builtin*)`-generated code is **unreachable by
construction**. Phase 3's GotoExternal emission can therefore be a
defensive `UNREACHABLE` / `ReportError` with a clear message rather than
the full out-param mechanism.

If torque accepts the builtin-with-label fixture (unlikely but possible),
inspect the IR — `GotoExternal` would appear in the builtin's CFG, and
Phase 3 must emit it properly. Update Task 3.3 with the finding.

**Step 5: Record findings in a scratch note**

Write `/tmp/phase3-spike-findings.md` with bullet points:
- Extern macro picked: `<name>`
- CallCsaMacroAndBranch fires: yes / no
- GotoExternal reachable in a builtin body: yes / no
- Chosen emission strategy for CallCsaMacroAndBranch (see Task 3.3)

(Scratch only — findings get summarized into the task 3.3 commit message.)

**Step 6: Remove the spike fixture — we'll write permanent ones in Tasks
3.8 / 3.9**

```bash
rm examples/libs/nodejs/test/torque-fixtures/_spike-ccmab.tq
rm -f deps/v8/test/phase3-fixtures/_spike-ccmab.tq
```

No commit — this is discovery work.

---

## Task 3.3: Spike — lock in the emission strategy

**Context:** Based on Task 3.2's findings, decide the emission convention
for `CallCsaMacroAndBranch` and `GotoExternal`. This task produces a design
note appended to `verification.md` (Phase 3 section) as a *committed*
record — if later implementation tasks diverge from the decision, the
divergence gets flagged in the Phase 3 summary.

**Files:**
- Modify: `examples/libs/nodejs/verification.md` — append a "Phase 3
  Spike Decisions" section at the end of the file (before any Phase 3
  Summary placeholder).

**Step 1: Evaluate the three candidate approaches for `CallCsaMacroAndBranch`**

Given Task 3.2's empirical finding that the instruction fires ONLY (or
primarily) for extern-macro-with-labels calls, evaluate:

- **A. Out-param rewrite (the handoff's proposal).** Callee-side signature
  rewrite: replace each `CodeAssemblerLabel*` parameter with a
  `TorqueLabel_<Macro>_<Label>_t* out_branch_taken` + per-label-value
  `T* out_<label>_<idx>`. Callee writes into pointers + returns. Caller
  declares `bool branch_taken_<label>{false}; T out_<label>_0{}; ...;
  Macro(args, &branch_taken, &out_0, ...); if (branch_taken) goto X;`.
  Requires (i) widening `GenerateFunction`'s signature path for
  kCCBuiltins to emit the out-params instead of `ReportError`'ing, (ii)
  widening or duplicating the kCC / kCCDebug emission for labeled macros,
  (iii) `GotoExternal` emission writes the enum + values.
- **B. `std::variant` return.** Callee returns a `std::variant<...>`
  holding either a "normal return" value or a per-label tagged struct.
  Caller `std::visit`-es. Cleaner at the call site; uglier at the
  declaration site because the variant types explode combinatorially.
- **C. Restrict-to-inlined.** For Phase 3, emit
  `CallCsaMacroAndBranch` as an aborting `ReportError("kCCBuiltins: an
  extern-labeled-macro call is not yet supported in C++ output; macro X
  must be inlined or hand-written")` and teach the whitelist gate in
  `Visit(Builtin*)` to fall back to the Phase-1 stub when the builtin's
  CFG contains this instruction. Phase 3 ships with `MakeLazyNode` done,
  the 2 instructions covered as abort-at-generate-time, and documentation
  of which builtins we've deferred. Later phases handle the real cases as
  they come up.

Rubric:
- Complexity (lines of torque-patch edits)
- Applicability (how many real V8 builtins does it unblock)
- Risk of regressing kCSA/kCC/kCCDebug output
- Maintenance cost when V8 bumps

**Step 2: Pick the approach**

**Recommended default (pending Task 3.2 findings): approach C ("restrict
to inlined") — with a narrow A-style out-param path for
the single simplest shape (single label with zero label-value params,
non-tailcall, no catch block).** This matches Phase 2's discipline of
"implement only what the fixture forces; everything else is a
`ReportError` gate." It keeps Phase 3 scope bounded and defers the
combinatorial-out-param question to Phase 4/5 when real builtins surface
the need.

If Task 3.2's spike uncovered many candidate extern-macro-labeled calls
in the builtins we expect to whitelist in Phase 4 (e.g., `Cast<>`, range
checks), upgrade to full approach A. Document the chosen tier.

**Step 3: Write the decision note into `verification.md`**

Append to `examples/libs/nodejs/verification.md` (new section,
immediately before any "Phase 3 Summary"):

```markdown
## Phase 3 Spike Decisions (Task 3.3)

**CallCsaMacroAndBranch emission strategy:** <A | A-narrow | B | C>.

Rationale: <paragraph summarizing Task 3.2 findings + why this tier
suffices for Phase 3 scope>.

**GotoExternal emission strategy:** <UNREACHABLE-abort | out-param write>.

Rationale: <paragraph; cite implementation-visitor.cc:2056-2058 +
the "labeled Torque macros are always inlined under kCCBuiltins" property
derived from declarable.h:319-326>.

**MakeLazyNode emission strategy:** `[=] (Isolate* isolate) { return
<callee>(isolate, <captured args>); }`. Direct lambda, no C++-specific
complications. Matches CSA's `[=] () { return <CSAMethod>(state_, ...); }`
pattern at `csa-generator.cc:508-522`.

**Signature rewrite scope:** <only kCCBuiltins | kCC+kCCBuiltins>.
Deliberately narrow — kCC's existing consumers in hand-written V8 code
depend on the label-less contract.

**Follow-ups:** <list deferred work, e.g. "multi-label out-params under
kCCBuiltins, Phase 4">.
```

**Step 4: Commit the decision note in the worktree**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/verification.md
git commit -m "nodejs: Phase 3 — spike decisions for CallCsaMacroAndBranch / GotoExternal"
```

---

## Task 3.4: Implement `MakeLazyNodeInstruction` + fixture

**Context:** Lazy node is the easiest of the three. CSA form
(`csa-generator.cc:490-523`):

```cpp
decls() << "  " << result_type->GetGeneratedTypeName() << " "
        << result_name << ";\n";
out() << "    " << result_name << " = [=] () { return "
      << extern_macro->external_assembler_name() << "(state_)."
      << extern_macro->ExternalName() << "("
      // + args
      << "); };\n";
```

The CC form differs in three ways: (1) no `state_` argument — pass
`isolate` instead; (2) lambda takes `Isolate*` as a parameter OR
captures it from the enclosing scope (the builtin's `isolate` parameter
is in scope, so capture-by-reference is fine); (3) the result type is
`std::function<ReturnType(Isolate*)>` or similar — check `lazy.tq` for
the generated type name (e.g., `Lazy<Smi>` → `std::function<Tagged<Smi>()>`).

**Files:**
- Modify: `deps/v8/src/torque/cc-generator.cc:321-324` (replace
  `ReportError`)
- Create: `examples/libs/nodejs/test/torque-fixtures/make-lazy-node.tq`
- Create:
  `examples/libs/nodejs/test/torque-fixtures/golden/make-lazy-node-tq-ccbuiltins.cc`

**Step 1: Investigate the Lazy<T> type's runtime representation**

```bash
cd examples/libs/nodejs/build/node
grep -n 'Lazy' deps/v8/src/builtins/base.tq deps/v8/src/objects/*.tq \
  | head -20
grep -rn 'GetGeneratedTypeName\|GetRuntimeType' \
  deps/v8/src/torque/types.cc \
  | grep -i lazy
```

Expected: `Lazy<T>` type's generated C++ runtime type. If it's
`std::function<Tagged<T>()>`, use that. If it's a custom type (e.g., a
class template `Lazy<T>`), use it. Document the finding in a code
comment in cc-generator.cc.

**Step 2: Write the fixture**

`examples/libs/nodejs/test/torque-fixtures/make-lazy-node.tq`:

```
// Phase 3 test fixture: MakeLazyNodeInstruction.
// Exercises Lazy<T> creation via `%MakeLazy` / `Lazy{...}` syntax.
namespace test_cc {
  // A trivial macro to wrap lazily. Under kCCBuiltins, this would be
  // inlined if called directly; we wrap it in Lazy<> to force
  // MakeLazyNodeInstruction emission.
  macro TorqueCcTest_LazyBody(x: Smi): Smi {
    return x;
  }

  builtin TorqueCcTest_MakeLazyNode(implicit context: Context)(
      arg: Smi): Smi {
    const lazy: Lazy<Smi> = %MakeLazy<Smi>('TorqueCcTest_LazyBody', arg);
    // Force the lazy to evaluate so IR doesn't DCE it.
    return RunLazy(lazy);
  }
}
```

(If `%MakeLazy` / `RunLazy` aren't the right Torque-source surface, run
`-annotate-ir` on a `.tq` that uses `Lazy<>` — e.g., the BigInt or Array
builtins — to find the syntactic form. Adjust until
`MakeLazyNodeInstruction` appears in the IR.)

**Step 3: Replace the `ReportError` stub**

In `deps/v8/src/torque/cc-generator.cc:321-324`, replace:

```cpp
void CCGenerator::EmitInstruction(const MakeLazyNodeInstruction& instruction,
                                  Stack<std::string>* stack) {
  ReportError("Not supported in C++ output: MakeLazyNode");
}
```

With:

```cpp
void CCGenerator::EmitInstruction(const MakeLazyNodeInstruction& instruction,
                                  Stack<std::string>* stack) {
  TypeVector parameter_types =
      instruction.macro->signature().parameter_types.types;
  std::vector<std::string> args = ProcessArgumentsCommon(
      parameter_types, instruction.constexpr_arguments, stack);

  std::string result_name =
      DefinitionToVariable(instruction.GetValueDefinition());
  stack->Push(result_name);

  // `Lazy<T>`'s runtime representation is `std::function<T()>`
  // (confirm in Step 1; adjust the decl if it's something else).
  decls() << "  " << instruction.result_type->GetRuntimeType() << " "
          << result_name << "{};  USE(" << result_name << ");\n";

  out() << "  " << result_name << " = [=] () { return ";
  if (ExternMacro* extern_macro =
          ExternMacro::DynamicCast(instruction.macro)) {
    // Extern macros can't be inlined; they reference an existing C++
    // function. Under kCCBuiltins we assume it's declared with the
    // isolate-taking signature (extern macros are always hand-written).
    out() << extern_macro->CCName() << "(isolate";
    if (!args.empty()) out() << ", ";
  } else {
    // Torque macro: the kCCBuiltins pass normally inlines these, but
    // MakeLazyNode defers the call to evaluation time, which prevents
    // inlining. The macro must therefore be emittable as a free C++
    // function — forcing it through the CCBuiltins-callable-macros path
    // (see Task 3.5's ShouldBeInlined override logic).
    out() << instruction.macro->CCName() << "(isolate";
    if (!args.empty()) out() << ", ";
  }
  PrintCommaSeparatedList(out(), args);
  out() << "); };\n";
}
```

(The precise lambda shape depends on Step 1's finding. If `Lazy<T>`'s
runtime representation takes `Isolate*` as a parameter, the lambda
becomes `[=](Isolate* isolate) { return ...; }`. If it's a zero-arg
`std::function<T()>`, capture isolate by value from the enclosing scope
and don't list it as a lambda parameter. Inspect `GetRuntimeType()` for
`Lazy<Smi>` during Step 1 to decide.)

**Step 4: Rebuild torque**

```bash
cd examples/libs/nodejs/build/node
ninja -C out/Release.baseline torque 2>&1 | tail -10
```

Expected: clean build.

**Step 5: Run the fixture harness (Task 2.14 already autogenerates the
whitelist from `builtin TorqueCcTest_*` grep)**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
# First run: capture actual output, install as initial golden.
UPDATE_GOLDEN=1 bash examples/libs/nodejs/test/run-torque-fixtures.sh \
  make-lazy-node
# Verify the golden file is what we expect.
cat examples/libs/nodejs/test/torque-fixtures/golden/make-lazy-node-tq-ccbuiltins.cc
# Verify the harness diff passes.
bash examples/libs/nodejs/test/run-torque-fixtures.sh make-lazy-node
```

Expected: `OK: make-lazy-node` on the second run. The golden file should
show a lambda-captured body and a well-formed C++ function signature.

**Step 6: Commit (Node.js clone + worktree)**

```bash
# V8 change:
cd examples/libs/nodejs/build/node
git add deps/v8/src/torque/cc-generator.cc
git -c user.email=build@wasm-posix-kernel.local \
    -c user.name="wasm-posix-kernel build" \
    commit -m "torque: implement CCGenerator::Emit(MakeLazyNodeInstruction)"

# Fixture + golden (worktree):
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/test/torque-fixtures/make-lazy-node.tq \
        examples/libs/nodejs/test/torque-fixtures/golden/make-lazy-node-tq-ccbuiltins.cc
git commit -m "nodejs: Phase 3 — MakeLazyNodeInstruction fixture + golden"
```

---

## Task 3.5: Implement `CallCsaMacroAndBranchInstruction` + fixture

**Context:** The design-risk instruction. Implementation strategy is
pinned by Task 3.3's decision. This task implements whichever tier was
chosen.

**Minimum viable scope for Phase 3** (assume Task 3.3 chose tier A-narrow
or C): single-label, single-return-continuation, no catch block, no
tailcall, label has zero value-parameters. If the fixture (Step 1 below)
hits a richer shape and the spike's decision was restrictive, either
widen the shape or `ReportError` on the shape. Match Phase 2's discipline.

**Files:**
- Modify: `deps/v8/src/torque/cc-generator.cc:315-319` (replace
  `ReportError`)
- Modify: `deps/v8/src/torque/declarable.h:319-326` — add `Macro::ShouldBeInlined`
  override for labeled extern macros (see Step 2).
- Modify: `deps/v8/src/torque/implementation-visitor.cc:2056-2058` — relax
  the "macros can't have label exits" check for kCCBuiltins (ONLY for
  kCCBuiltins; kCC stays restrictive).
- Create: `examples/libs/nodejs/test/torque-fixtures/call-csa-macro-and-branch.tq`
- Create:
  `examples/libs/nodejs/test/torque-fixtures/golden/call-csa-macro-and-branch-tq-ccbuiltins.cc`

**Step 1: Write the fixture**

Based on Task 3.2's spike, pick the simplest extern macro with labels
that we can call. If nothing clean exists in the stdlib, define a
*Torque-internal* labeled macro in the fixture itself — this won't fire
`CallCsaMacroAndBranch` because it'll be inlined, but we can decorate it
with a `@noinline`-style attribute if one exists, or define an
`extern macro` pointing at a stub C++ function we also provide in the
fixture's generated file.

**Recommended fixture** (defines both a Torque macro that forces
non-inlining AND a builtin caller):

```
// Phase 3 test fixture: CallCsaMacroAndBranchInstruction.
// Uses a pattern that Torque CANNOT inline (implementation decides):
// an extern macro declared in the fixture, then referenced from a builtin.
namespace test_cc {
  // Extern macros cannot be inlined — GenerateCall routes to
  // CallCsaMacroAndBranch when labels are present.
  extern macro TorqueCcTest_ExternTry(Smi): Smi labels Fail;

  builtin TorqueCcTest_CallCsaMacroAndBranch(
      implicit context: Context)(arg: Smi): Smi {
    const r: Smi = TorqueCcTest_ExternTry(arg) otherwise FailBlock;
    return r;
    label FailBlock {
      return -1;
    }
  }
}
```

(If declaring an `extern macro` in-fixture triggers torque's "unknown
external symbol" gate, import one from `base.tq` instead. The Task 3.2
spike already picked a usable candidate — reuse it.)

**Step 2: Add `Macro::ShouldBeInlined` override for labeled extern macros**

In `deps/v8/src/torque/declarable.h`, add to the `ExternMacro` or
`Macro` class (mirror Phase 2's `RuntimeFunction::ShouldBeInlined`
override):

```cpp
  bool ShouldBeInlined(OutputType output_type) const override {
    if (output_type == OutputType::kCCBuiltins &&
        !signature().labels.empty() && IsExternal()) {
      // Labeled extern macros can't be inlined (no body) and need real
      // CallCsaMacroAndBranch emission. Phase 3.
      return false;
    }
    return Callable::ShouldBeInlined(output_type);
  }
```

(The precise class to patch depends on what `DynamicCast` in
`GenerateCall` tests. `Macro::DynamicCast` is what fires at line 3033 —
but the override should be on the class that returns `true` by default
unless more-specific. Place it on `Macro` directly, and gate on
`IsExternal()` + label-presence.)

**Step 3: Relax kCCBuiltins label-exit gate in signature emission**

In `deps/v8/src/torque/implementation-visitor.cc`, change line 2056-2059
from:

```cpp
  for (const LabelDeclaration& label_info : signature.labels) {
    if (output_type_ == OutputType::kCC ||
        output_type_ == OutputType::kCCDebug) {
      ReportError("Macros that generate runtime code can't have label exits");
    }
```

To:

```cpp
  for (const LabelDeclaration& label_info : signature.labels) {
    if (output_type_ == OutputType::kCC ||
        output_type_ == OutputType::kCCDebug) {
      ReportError("Macros that generate runtime code can't have label exits");
    }
    if (output_type_ == OutputType::kCCBuiltins) {
      // Phase 3 out-param convention: labels become `bool*
      // out_branch_<label>` + per-label-value `T* out_<label>_<i>`
      // pointers. Caller (CallCsaMacroAndBranch emission) declares the
      // locals; callee (GotoExternal emission) writes into the pointers
      // and returns.
      f.AddParameter("bool*",
                     ExternalLabelName(label_info.name->value));
      size_t i = 0;
      for (const Type* type : label_info.types) {
        f.AddParameter(
            type->GetRuntimeType() + "*",
            ExternalLabelParameterName(label_info.name->value, i));
        ++i;
      }
      continue;  // Skip the kCSA CodeAssemblerLabel* / TypedCAV* path.
    }
    f.AddParameter("compiler::CodeAssemblerLabel*",
                   ExternalLabelName(label_info.name->value));
    // ...existing CSA label-emission path unchanged.
```

(Adjust the `continue` placement to skip exactly the kCSA-specific
parameter-add block. The existing CSA path emits
`compiler::TypedCodeAssemblerVariable<...>*` for each label-value
parameter; the new kCCBuiltins path emits `T*`. Both paths sit in the
same loop — choose ONE path per iteration with an if/else or continue.)

**Step 4: Replace the `CallCsaMacroAndBranch` `ReportError` stub**

In `deps/v8/src/torque/cc-generator.cc`, replace lines 315-319 with:

```cpp
void CCGenerator::EmitInstruction(
    const CallCsaMacroAndBranchInstruction& instruction,
    Stack<std::string>* stack) {
  if (instruction.catch_block) {
    ReportError(
        "Phase 3: CallCsaMacroAndBranch with catch block (exception "
        "handling) is deferred.");
  }
  TypeVector parameter_types =
      instruction.macro->signature().parameter_types.types;
  std::vector<std::string> args = ProcessArgumentsCommon(
      parameter_types, instruction.constexpr_arguments, stack);

  const Type* return_type = instruction.macro->signature().return_type;
  std::vector<std::string> results;
  if (return_type != TypeOracle::GetNeverType()) {
    const auto lowered = LowerType(return_type);
    for (std::size_t i = 0; i < lowered.size(); ++i) {
      results.push_back(
          DefinitionToVariable(instruction.GetValueDefinition(i)));
      decls() << "  " << lowered[i]->GetRuntimeType() << " "
              << results.back() << "{};  USE(" << results.back() << ");\n";
    }
  }

  // Declare the out-param branch bools + per-label-value locals.
  std::vector<std::string> label_branch_names;
  std::vector<std::vector<std::string>> label_value_names;
  const LabelDeclarationVector& labels = instruction.macro->signature().labels;
  DCHECK_EQ(labels.size(), instruction.label_blocks.size());
  for (size_t i = 0; i < labels.size(); ++i) {
    std::string branch = FreshLabelName();
    label_branch_names.push_back(branch);
    decls() << "  bool " << branch << " = false;\n";
    label_value_names.push_back({});
    for (size_t j = 0; j < labels[i].types.size(); ++j) {
      std::string val = FreshNodeName();
      label_value_names[i].push_back(val);
      const auto def = instruction.GetLabelValueDefinition(i, j);
      SetDefinitionVariable(def, val);
      decls() << "  " << labels[i].types[j]->GetRuntimeType() << " "
              << val << "{};  USE(" << val << ");\n";
    }
  }

  // Emit the call.
  out() << "  ";
  if (results.size() == 1) {
    out() << results[0] << " = ";
  } else if (results.size() > 1) {
    out() << "std::tie(";
    PrintCommaSeparatedList(out(), results);
    out() << ") = ";
  }
  // ExternMacro: call via its CCName() (the handwritten C++ entry).
  // TorqueMacro: call via its CCName() as emitted by the kCCBuiltins-aware
  // signature path (Step 3). The lookup is the same — both resolve via
  // the same `CCName()` symbol.
  if (ExternMacro* ext = ExternMacro::DynamicCast(instruction.macro)) {
    out() << ext->CCName() << "(isolate";
  } else {
    out() << instruction.macro->CCName() << "(isolate";
  }
  for (const auto& a : args) out() << ", " << a;
  for (size_t i = 0; i < labels.size(); ++i) {
    out() << ", &" << label_branch_names[i];
    for (const auto& v : label_value_names[i]) out() << ", &" << v;
  }
  out() << ");\n";

  // Dispatch: if any branch fired, goto the matching label block;
  // otherwise fall through to the return continuation.
  for (size_t i = 0; i < labels.size(); ++i) {
    out() << "  if (" << label_branch_names[i] << ") ";
    // The label value names were already bound via SetDefinitionVariable,
    // so EmitGoto / the label block's phi mechanism sees them.
    EmitGoto(instruction.label_blocks[i], stack, "");
  }
  if (instruction.return_continuation) {
    EmitGoto(*instruction.return_continuation, stack, "  ");
  }
}
```

(The `FreshLabelName` and `FreshNodeName` helpers are protected methods
on `TorqueCodeGenerator` — match whatever CSA uses at
`csa-generator.cc:390-408`. If `FreshNodeName` doesn't exist in CC land,
use `FreshCatchName`/`FreshNodeName` from the base class or inline a
counter.)

**Step 5: Rebuild torque**

```bash
cd examples/libs/nodejs/build/node
ninja -C out/Release.baseline torque 2>&1 | tail -20
```

Expected: clean build. Compile errors typically mean a namespace / type
name issue in the emitted C++; match CSA's form exactly.

**Step 6: Generate the fixture, capture as golden, verify diff**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
UPDATE_GOLDEN=1 bash examples/libs/nodejs/test/run-torque-fixtures.sh \
  call-csa-macro-and-branch
cat examples/libs/nodejs/test/torque-fixtures/golden/call-csa-macro-and-branch-tq-ccbuiltins.cc
bash examples/libs/nodejs/test/run-torque-fixtures.sh call-csa-macro-and-branch
```

Expected: golden file shows a well-formed function using `bool`
out-params + `if (branch_x) goto ...;` dispatch. Second run prints
`OK: call-csa-macro-and-branch`.

**Step 7: Commit**

```bash
# V8 changes (3 files):
cd examples/libs/nodejs/build/node
git add deps/v8/src/torque/cc-generator.cc \
        deps/v8/src/torque/declarable.h \
        deps/v8/src/torque/implementation-visitor.cc
git -c user.email=build@wasm-posix-kernel.local \
    -c user.name="wasm-posix-kernel build" \
    commit -m "torque: implement CCGenerator::Emit(CallCsaMacroAndBranchInstruction)"

# Fixture + golden (worktree):
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/test/torque-fixtures/call-csa-macro-and-branch.tq \
        examples/libs/nodejs/test/torque-fixtures/golden/call-csa-macro-and-branch-tq-ccbuiltins.cc
git commit -m "nodejs: Phase 3 — CallCsaMacroAndBranchInstruction fixture + golden"
```

---

## Task 3.6: Implement `GotoExternalInstruction` + fixture

**Context:** The callee-side dual to CallCsaMacroAndBranch. Inside a
labeled macro's body, `goto ExternalLabel(...)` emits a
`GotoExternalInstruction` whose `destination` is the external label
parameter name and whose `variable_names` are the names of the output
values to write through.

Under kCCBuiltins, the labels became `bool*` + `T*` pointers (Task 3.5
Step 3). `GotoExternal` emits writes into those pointers + a `return;`.

**Under kCCBuiltins-emitting-builtins (not macros):** per Task 3.2's
spike analysis, this instruction CANNOT appear because builtins don't
have labels in their signatures. But our Task 3.5 `ShouldBeInlined`
override lets labeled extern macros escape the inline path, which means
Torque-implemented labeled macros going through the
`AllMacrosForCCOutput` or a kCCBuiltins-equivalent side-pass may fire
`GotoExternal`.

For Phase 3 scope, we:
1. Emit `GotoExternal` correctly when it DOES fire (future-proofing).
2. Add a fixture that forces it, even if only via a macro side-pass.

**Files:**
- Modify: `deps/v8/src/torque/cc-generator.cc:496-499` (replace
  `ReportError`)
- Create: `examples/libs/nodejs/test/torque-fixtures/goto-external.tq`
- Create:
  `examples/libs/nodejs/test/torque-fixtures/golden/goto-external-tq-ccbuiltins.cc`

**Step 1: Write the fixture — a labeled TorqueMacro + a builtin caller that
forces non-inlining**

Pure Torque macros are always inlined under kCCBuiltins by default
(`Callable::ShouldBeInlined` base = true). To force `GotoExternal`
emission inside the macro body, we need the macro to be emitted as a
standalone function. Options:
- (a) `@noinline` annotation (if Torque supports it) — check `base.tq`.
- (b) Extend `ShouldBeInlined` override from Task 3.5 to also force
  non-inlining for macros-with-labels even when they have bodies (not
  just `IsExternal()`).

**Recommended:** tighten Task 3.5's override to `!IsExternal()` → emit
standalone for ANY labeled macro, not only extern ones. Then write a
fixture:

```
// Phase 3 test fixture: GotoExternalInstruction.
// The labeled macro is emitted as a standalone C++ function (via the
// Task 3.5 ShouldBeInlined override), so its body contains a real
// GotoExternal.
namespace test_cc {
  macro TorqueCcTest_LabeledBody(x: Smi): Smi labels Fail {
    if (x == 0) goto Fail;
    return x;
  }

  builtin TorqueCcTest_GotoExternal(
      implicit context: Context)(arg: Smi): Smi {
    const r: Smi = TorqueCcTest_LabeledBody(arg) otherwise Bailout;
    return r;
    label Bailout {
      return -1;
    }
  }
}
```

If Torque rejects `if (x == 0) goto Fail;` because of mismatched
implicit context or unknown label-value types, adjust the macro body
until the IR shows `GotoExternal`.

**Step 2: Replace the `GotoExternal` stub**

In `cc-generator.cc:496-499`, replace:

```cpp
void CCGenerator::EmitInstruction(const GotoExternalInstruction& instruction,
                                  Stack<std::string>* stack) {
  ReportError("Not supported in C++ output: GotoExternal");
}
```

With:

```cpp
void CCGenerator::EmitInstruction(const GotoExternalInstruction& instruction,
                                  Stack<std::string>* stack) {
  // Under kCCBuiltins, the destination label was emitted as a `bool*`
  // out-param + per-value `T*` out-params (Task 3.5). Write the values
  // into the T* pointers, set the bool, and return.
  for (auto it = instruction.variable_names.rbegin();
       it != instruction.variable_names.rend(); ++it) {
    out() << "  *" << *it << " = " << stack->Pop() << ";\n";
  }
  out() << "  *" << instruction.destination << " = true;\n";
  out() << "  return;\n";
}
```

(The `destination` string is the external label parameter name — it'll
match whatever `ExternalLabelName(label_info.name->value)` produced in
`GenerateFunction` at Task 3.5 Step 3. Verify the names line up by
inspecting the generated macro signature in the fixture output.)

**Step 3: Widen the `Macro::ShouldBeInlined` override (if needed)**

If Step 1 needs any labeled Torque macro (not just extern) to be
emitted standalone, update Task 3.5's override:

```cpp
  bool ShouldBeInlined(OutputType output_type) const override {
    if (output_type == OutputType::kCCBuiltins &&
        !signature().labels.empty()) {
      // Any labeled macro under kCCBuiltins goes through the
      // out-param-rewrite path (Task 3.5/3.6). Inlining would lose
      // the label-dispatch structure.
      return false;
    }
    return Callable::ShouldBeInlined(output_type);
  }
```

This affects non-whitelisted stock V8 output too, since it changes
`ShouldBeInlined` globally for kCCBuiltins. **Important:** non-builtin
declarables (Macros) hit the fourth pass's
`kind() != Declarable::kBuiltin` filter and are skipped there. So
ShouldBeInlined=false on a Macro has no output-emission effect unless
the macro is referenced from a whitelisted builtin. Non-whitelisted
builtins still fall back to the Phase-1 stub via the whitelist gate in
`Visit(Builtin*)`. Task 3.11's regression check verifies this.

**Step 4: Rebuild, generate golden, verify**

```bash
cd examples/libs/nodejs/build/node
ninja -C out/Release.baseline torque 2>&1 | tail -10

cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
UPDATE_GOLDEN=1 bash examples/libs/nodejs/test/run-torque-fixtures.sh \
  goto-external
cat examples/libs/nodejs/test/torque-fixtures/golden/goto-external-tq-ccbuiltins.cc
bash examples/libs/nodejs/test/run-torque-fixtures.sh goto-external
```

Expected: `OK: goto-external`.

**Step 5: Commit**

```bash
# V8 changes (2 files):
cd examples/libs/nodejs/build/node
git add deps/v8/src/torque/cc-generator.cc \
        deps/v8/src/torque/declarable.h
git -c user.email=build@wasm-posix-kernel.local \
    -c user.name="wasm-posix-kernel build" \
    commit -m "torque: implement CCGenerator::Emit(GotoExternalInstruction)"

# Fixture + golden:
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/test/torque-fixtures/goto-external.tq \
        examples/libs/nodejs/test/torque-fixtures/golden/goto-external-tq-ccbuiltins.cc
git commit -m "nodejs: Phase 3 — GotoExternalInstruction fixture + golden"
```

---

## Task 3.7: Run full 12-fixture harness pass

**Context:** Phase 2 has 9 fixtures; Phase 3 adds 3 more (total 12). Run
the full suite to confirm no cross-fixture regressions.

**Files:** none modified.

**Step 1: Run the full harness (no filter — all fixtures)**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
bash examples/libs/nodejs/test/run-torque-fixtures.sh
```

Expected output (12 lines):

```
OK:      call-builtin
OK:      call-builtin-pointer
OK:      call-csa-macro-and-branch
OK:      call-runtime
OK:      goto-external
OK:      make-lazy-node
OK:      namespace-constant
OK:      push-builtin-pointer
OK:      push-uninitialized
OK:      return
OK:      store-bit-field
OK:      store-reference
```

Exit 0. Any `DIFF` / `MISSING` = regression; stop and fix.

**Step 2: No commit** — verification gate.

---

## Task 3.8: `clang++ -fsyntax-only` parse-check on one Phase 3 fixture

**Context:** Same rationale as Phase 2's Task 2.15 — confirm at least one
of the Phase 3 goldens parses as valid C++ under a minimal V8 include
set. Pick `make-lazy-node` (simplest of the 3). If time and includes
permit, also check `call-csa-macro-and-branch`.

**Files:** none modified.

**Step 1: Stage the generated file with a minimal V8 prologue**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend

GEN_DIR=$(mktemp -d)
GEN="${GEN_DIR}/make-lazy-node-tq-ccbuiltins.cc"
cp examples/libs/nodejs/test/torque-fixtures/golden/make-lazy-node-tq-ccbuiltins.cc \
   "${GEN}"

cat > "${GEN_DIR}/wrap.cc" <<'EOF'
#include <functional>
#include "src/api/api.h"
#include "src/builtins/builtins.h"
#include "src/execution/isolate.h"
#include "src/objects/objects.h"
#include "src/objects/smi.h"
#include "src/objects/tagged.h"
#include "src/runtime/runtime.h"
// Forward the generated file.
#include "make-lazy-node-tq-ccbuiltins.cc"
EOF
```

**Step 2: Run the syntax check**

```bash
cd examples/libs/nodejs/build/node
clang++ -std=c++20 -fsyntax-only \
  -I deps/v8 -I deps/v8/include \
  -I out/Release.baseline/gen \
  -DV8_TARGET_ARCH_X64 -DV8_HOST_ARCH_X64 \
  -DV8_ENABLE_WEBASSEMBLY=0 -DV8_ENABLE_LEAPTIERING=1 \
  "${GEN_DIR}/wrap.cc" 2>&1 | tee /tmp/phase3-clang.log
echo "exit=$?"
```

Expected: exit 0 OR errors limited to missing symbol definitions from
the minimal include set (LINK-level, not syntax). **Any** syntax error
in our emitted code = blocker; fix in cc-generator.cc and re-run Task
3.4.

**Step 3: No commit** — verification gate.

---

## Task 3.9: Regression check — non-whitelisted output unchanged

**Context:** Prove Phase 3 didn't regress the stock (non-whitelisted)
torque output. Same pattern as Phase 2's Task 2.16.

**Files:** none modified.

**Step 1: Run torque with empty whitelist over stock fileset**

```bash
cd examples/libs/nodejs/build/node
TQ_FILES=$(cat /tmp/phase3-tq-files.txt)
rm -rf /tmp/torque-phase3.9
mkdir -p /tmp/torque-phase3.9
echo "$TQ_FILES" | sed 's|[^/]*$||' | sort -u | while read d; do
  mkdir -p "/tmp/torque-phase3.9/$d"
done
./out/Release.baseline/torque \
  -o /tmp/torque-phase3.9 \
  -v8-root deps/v8 \
  $TQ_FILES 2>&1 | tail -5
echo "exit=$?"
```

Expected: exit 0.

**Step 2: Full-tree diff against Task 3.1 baseline**

```bash
diff -r /tmp/torque-baseline-phase3 /tmp/torque-phase3.9 \
  | tee /tmp/phase3-regression.diff
```

Expected: empty diff. Any line = regression — stop and investigate.

**Step 3: Non-ccbuiltins sha match**

```bash
diff /tmp/torque-baseline-phase3-noccb.sum \
  <(find /tmp/torque-phase3.9 -type f ! -name '*-tq-ccbuiltins.cc' \
      -print0 | sort -z | xargs -0 cat | shasum)
```

Expected: no diff (same `a5195c0258fd9af9415e9d41f0c2e38237989c1b` sha).

**Step 4: ccbuiltins-only sha match**

The ccbuiltins subset should also be unchanged — Phase 3's new
`ShouldBeInlined` override affects labeled macros, but the stock
builtins' emission still goes through the Phase-1 stub path because
no stock builtin is whitelisted. Verify:

```bash
find /tmp/torque-baseline-phase3 -type f -name '*-tq-ccbuiltins.cc' \
  -print0 | sort -z | xargs -0 cat | shasum > /tmp/phase3-baseline-ccb.sum
find /tmp/torque-phase3.9 -type f -name '*-tq-ccbuiltins.cc' \
  -print0 | sort -z | xargs -0 cat | shasum > /tmp/phase3-current-ccb.sum
diff /tmp/phase3-baseline-ccb.sum /tmp/phase3-current-ccb.sum
```

Expected: no diff.

No commit.

---

## Task 3.10: Export consolidated patch file

**Context:** Phase 3 adds ~5-7 new commits on top of Phase 2's tip
(3 cc-generator edits + 1 declarable.h + 1 implementation-visitor.cc +
follow-up fixes). Re-export the full `9fe7634c..HEAD` range as a single
patch — same filename as Phase 1/2.

**Files:**
- Modify: `examples/libs/nodejs/patches/v8-torque-cc-builtins.patch`

**Step 1: Count commits**

```bash
cd examples/libs/nodejs/build/node
git log --oneline 9fe7634c..HEAD | tee /tmp/phase3-commits.txt
wc -l /tmp/phase3-commits.txt
```

Expected: ~27-28 (10 Phase 1 + 11 Phase 2 + 5-7 Phase 3).

**Step 2: Export as a single patch**

```bash
N=$(wc -l < /tmp/phase3-commits.txt)
git format-patch -${N} --stdout > ../../patches/v8-torque-cc-builtins.patch
wc -l ../../patches/v8-torque-cc-builtins.patch
```

Expected: patch file, likely 1400-1800 lines.

**Step 3: Verify re-application on upstream**

```bash
git tag phase3-commits HEAD
git reset --hard 9fe7634c
git apply --3way ../../patches/v8-torque-cc-builtins.patch
git status --short | head -20
```

Expected: ~8-10 files modified; no rejected hunks.

**Step 4: Restore and rebuild**

```bash
git reset --hard phase3-commits
git tag -d phase3-commits
ninja -C out/Release.baseline torque
```

**Step 5: Re-run full harness after restore**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
bash examples/libs/nodejs/test/run-torque-fixtures.sh
```

Expected: all 12 fixtures OK.

**Step 6: Commit the patch file update**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/patches/v8-torque-cc-builtins.patch
git commit -m "nodejs: Phase 3 — v8 torque kCCBuiltins full 12-instruction implementation patch"
```

---

## Task 3.11: Update verification.md with Phase 3 summary

**Files:**
- Modify: `examples/libs/nodejs/verification.md`

**Step 1: Append a Phase 3 Summary section**

Add to `verification.md`, at the very end (after Phase 2 Summary):

````markdown
## Phase 3 Summary

| Item | Result |
|---|---|
| Spike findings captured (Task 3.3 decision note) | ✅ |
| `MakeLazyNodeInstruction` emission | ✅ |
| `CallCsaMacroAndBranchInstruction` emission (chosen strategy: `<A-narrow / A-full / C>`) | ✅ |
| `GotoExternalInstruction` emission | ✅ |
| `Macro::ShouldBeInlined` override for labeled macros under kCCBuiltins | ✅ |
| `GenerateFunction` emits out-param form for labels under kCCBuiltins | ✅ |
| 3 new fixtures + goldens (make-lazy-node, call-csa-macro-and-branch, goto-external) | ✅ |
| Full 12-fixture harness passes | ✅ |
| `clang++ -fsyntax-only` check on `make-lazy-node` fixture: clean | ✅ |
| Non-whitelisted output unchanged vs. post-Phase-2 (Task 3.9 diff empty; sha `a5195c0258fd9af9415e9d41f0c2e38237989c1b` matches) | ✅ |
| Consolidated patch exports + re-applies cleanly on upstream `9fe7634c` | ✅ |

**CCGenerator stubs remaining after Phase 3: 0.** Every backend-dependent
instruction now has a real emission. Remaining `ReportError` calls in
`cc-generator.cc` are *intentional scope gates* within instruction
implementations (catch-block, tailcall, JS-linkage, multi-result PairT)
that Phase 4+ will address as fixtures force them.

**Phase 3 commit chain on the Node.js clone** (~5-7 commits on top of
Phase 2 tip):
1. `torque: implement CCGenerator::Emit(MakeLazyNodeInstruction)`
2. `torque: implement CCGenerator::Emit(CallCsaMacroAndBranchInstruction)`
3. `torque: implement CCGenerator::Emit(GotoExternalInstruction)`
4. (+ any follow-up fixes surfaced by the `clang++ -fsyntax-only` gate or
   the regression check)

### Plan deviations surfaced during Phase 3 implementation

*(To be filled in as Phase 3 executes — follow the Phase 1/2 format:
bulleted list under "Plan deviations" + "Phase 3 follow-ups for later
phases." Remove this placeholder line before landing.)*

- TBD

### Phase 3 follow-ups for later phases

- **Runtime exception handling** (`catch_block` on CallCsaMacroAndBranch /
  CallRuntime / CallBuiltin) — still `ReportError`. Needs a dedicated
  plan: either map to C++ exceptions, to `expected<T,E>`-style returns,
  or to a Torque-specific error channel. This is a Phase 4 / later
  decision.
- **Multi-label-value out-params.** Phase 3's fixture targets the
  single-label / zero-value or single-value case. When a real V8 builtin
  calls a macro with multi-value labels, the out-param convention
  generalizes cleanly (more `T*` pointers) but hasn't been exercised.
  Surface when it first fires.
- **Intrinsic `ShouldBeInlined` override.** Phase 2's verification doc
  flagged this as open; Phase 3 did not force it with a fixture. If a
  Phase 4 fixture drops Intrinsic arguments, add the override (mirrors
  `RuntimeFunction` fix).
- **Phase 4:** `builtins-cc-table.inc` dispatch table generation, JS-linkage
  builtin emission, and the first host-native end-to-end smoke test
  (linking a translated builtin into `d8`).

**Next:** Phase 4. Write `docs/plans/2026-04-20-torque-cc-backend-phase4.md`
covering dispatch-table generation + host CSS build per the handoff doc's
Phase 4 outline.
````

**Step 2: Commit**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/verification.md
git commit -m "nodejs: Phase 3 — verification.md Phase 3 summary"
```

---

## Phase 3 Execution Notes

- **Start with Task 3.2 (the spike).** If the spike's findings change the
  approach described in Task 3.3's default recommendation, amend Tasks
  3.4/3.5/3.6 to match the chosen strategy *before* implementing.
- **Tasks 3.4-3.6 ARE ORDERED.** MakeLazyNode is the warm-up
  (independent). CallCsaMacroAndBranch lands the signature-rewrite
  machinery. GotoExternal reuses that machinery — don't skip ahead.
- **Do NOT push to `main`.** Work on the `torque-cc-backend` branch,
  re-push PR #306 updates on completion, let the PR pipeline run CI.
- **Fixture-first TDD.** Match Phase 2's discipline: fixture → golden
  capture → implement → rebuild → diff. If a fixture can't be written
  because Torque doesn't generate the target instruction, widen the
  fixture's Torque source until the IR (`-annotate-ir`) confirms the
  instruction appears. A passing golden without the targeted instruction
  in the CFG is a false positive — check the IR dump at least once per
  instruction.
- **Single-source-of-truth for the patch file.** Every V8 edit lands as
  a commit in the Node.js clone; the worktree only holds fixtures, the
  harness, verification.md, and the consolidated patch. Never edit the
  patch file by hand — always re-export from the clone via
  `git format-patch`.

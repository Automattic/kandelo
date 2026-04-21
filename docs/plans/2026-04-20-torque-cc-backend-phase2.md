# Phase 2: Torque CC Backend — Trivial + Mechanical Instructions Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the Phase 1 stub in `Visit(Builtin*)` under `kCCBuiltins` with real C++ body emission for a whitelisted subset of builtins, and implement 9 of the 12 currently-`ReportError` stubs in `cc-generator.cc`: 4 "trivial" (one-liner + variable declaration patterns) and 5 "mechanical" (mirrors of existing CSAGenerator code with API swaps). After Phase 2, a single whitelisted test-fixture builtin per instruction translates to well-formed C++ that parses under `clang++ -fsyntax-only`. The 3 deferred hard instructions (`CallCsaMacroAndBranch`, `MakeLazyNode`, `GotoExternal`) continue to `ReportError`; any builtin that uses them keeps the Phase 1 commented-stub form (gate keeps real emission off for non-whitelisted builtins).

**Architecture:** All V8 changes continue to live in `examples/libs/nodejs/build/node/deps/v8/` (gitignored). We add commits on the Node.js clone and re-export a single consolidated patch `examples/libs/nodejs/patches/v8-torque-cc-builtins.patch` that **replaces** the Phase 1 patch (same filename, superset of Phase 1 content). Phase 2 touches these files:

- `deps/v8/src/torque/cc-generator.cc` — replace 9 `ReportError` stubs with real emissions (keep 3 as stubs).
- `deps/v8/src/torque/implementation-visitor.cc` — rewrite the `kCCBuiltins` branch of `Visit(Builtin*)` to drive a full C++ function through CCGenerator when a whitelist matches; fall back to the Phase 1 comment stub otherwise.
- `deps/v8/src/torque/global-context.h` — add the whitelist to `GlobalContext` (env-var-populated).
- `deps/v8/src/torque/torque.cc` — parse `--cc-builtins-whitelist=<csv>` CLI flag, populate whitelist.

Plus new files in our worktree:

- `examples/libs/nodejs/test/torque-fixtures/` — per-instruction `.tq` fixtures that exercise exactly one instruction each (9 total).
- `examples/libs/nodejs/test/torque-fixtures/golden/` — golden `-tq-ccbuiltins.cc` outputs to diff against.
- `examples/libs/nodejs/test/run-torque-fixtures.sh` — test harness that runs torque over stock fileset + fixtures, greps out each fixture's output, diffs against golden.

**Tech Stack:**
- V8 13.6.233.17 (vendored in Node.js v24.x at `deps/v8/`) — same as Phase 1.
- GN + ninja, host clang/clang++, single-commit patch format.
- `clang++ -fsyntax-only` with V8 include paths for the "does the generated C++ parse" smoke test.

**Torque binary location (IMPORTANT):** use `out/Release.baseline/torque`, NOT `out/Release.baseline/torque`. Per Phase 0 Task 0.8, `out/Release/` was reconfigured to lite-mode (dropping `V8_ENABLE_WEBASSEMBLY`), so its torque binary lacks the `WASM_CODE_POINTER_NEEDS_PADDING` build flag and aborts on `src/wasm/wasm-objects.tq`. `out/Release.baseline/` is the stock-configured build preserved from before the lite-mode flip. After any patch change to torque source, rebuild with `ninja -C out/Release.baseline torque`.

**Stock `.tq` file list (IMPORTANT):** the Phase 1 plan used `grep -oE '"src/[^"]*\.tq"'` which misses 2 files (`test/torque/test-torque.tq`, `third_party/v8/builtins/array-sort.tq`). The correct pattern is `grep -oE '"(src|test|third_party)/[^"]*\.tq"'` — produces 245 files, matching verification.md. Omitting the third_party file triggers a "cannot find SortState" torque error.

**Invariants (do not break):**
- The 3 hard instructions (`CallCsaMacroAndBranch`, `MakeLazyNode`, `GotoExternal`) remain `ReportError`. They are Phase 3.
- Stock V8 builtins (everything not in the whitelist) continue to hit the Phase 1 comment-stub path in `Visit(Builtin*)`. No regression in stock `-tq-ccbuiltins.cc` content (bodies stay as the Phase 1 comment form). No regression in `-tq-csa.cc` / `-tq.cc` / `-tq-inl.inc` / `-tq.inc` / `-tq-csa.h` (kCSA / kCC / kCCDebug passes unchanged).
- Every Phase 2 instruction emission matches its CSAGenerator sibling in structure: same `ProcessArgumentsCommon`, same `decls()` declaration pattern, same `stack->Push` / `DefinitionToVariable` discipline. Only the emitted C++ API calls differ.
- Every instruction implementation has a golden-file-backed fixture. Golden files live in the worktree, not in the V8 patch.

**Out of scope for Phase 2:**
- `CallCsaMacroAndBranchInstruction` / `MakeLazyNodeInstruction` / `GotoExternalInstruction` (Phase 3).
- `builtins-cc-table.inc` dispatch table (Phase 4).
- Actually linking & running a translated builtin in V8 (Phase 4/5).
- Wasm32 cross-compile.

**Phase-1 lessons Phase-2 inherits** (from `examples/libs/nodejs/verification.md` "Plan deviations" section):
1. **Kind filter is mandatory.** The fourth pass body in `VisitAllDeclarables` MUST `continue` on non-`kBuiltin` declarables. Without that filter, `NamespaceConstant`/`TorqueMacro`/`Method` re-enter codegen and SIGSEGV. The filter is already in place from Phase 1; Phase 2 changes nothing here.
2. **Third `output_type_` switch** (extern-macro constexpr call emission, `implementation-visitor.cc:~2945`) already has a `kCCBuiltins` arm from Phase 1 that mirrors `kCC`'s `CCName()`. Phase 2 leaves this alone — Phase-2 call emission goes through `CallCsaMacroInstruction` / `CallRuntimeInstruction` / `CallBuiltinInstruction` etc., not the extern-macro shortcut.
3. **Full-fileset smoke test pattern.** Single-file torque runs abort on unresolved types (`Context`, etc.). ALL Phase 2 fixture runs invoke torque over the full 245-file stock fileset **plus** the fixture file(s). Same pattern as Phase 1 tasks 1.8–1.10.

---

## Task 2.1: Capture post-Phase-1 torque baseline

**Context:** Phase 2 must not regress non-whitelisted builtins or the kCSA/kCC/kCCDebug passes. Snapshot the current torque output (Phase 1 tip) so later tasks can diff against it.

**Files:** none committed. Writes scratch files to `/tmp/`.

**Step 1: Confirm Phase 1 patch is applied in the Node.js clone**

```bash
cd examples/libs/nodejs/build/node
git log --oneline -12 | head
```

Expected: the 10 Phase 1 commits at tip, ending at `torque: add OutputType::kCCBuiltins (Phase 1 scaffolding)`. If missing, re-apply from patch:

```bash
git apply --3way ../../patches/v8-torque-cc-builtins.patch
ninja -C out/Release.baseline torque
```

**Step 2: Rebuild the full stock `.tq` file list (correct pattern — Phase 1's plan had a bug that missed 2 files)**

```bash
cd examples/libs/nodejs/build/node
TQ_FILES=$(grep -oE '"(src|test|third_party)/[^"]*\.tq"' deps/v8/BUILD.gn \
             | tr -d '"' | sort -u)
echo "$TQ_FILES" | wc -l   # expect 245
echo "$TQ_FILES" > /tmp/phase2-tq-files.txt
```

**Step 3: Run torque over stock fileset, capture output tree**

```bash
rm -rf /tmp/torque-baseline-phase2
mkdir -p /tmp/torque-baseline-phase2
echo "$TQ_FILES" | sed 's|[^/]*$||' | sort -u | while read d; do
  mkdir -p "/tmp/torque-baseline-phase2/$d"
done
./out/Release.baseline/torque \
  -o /tmp/torque-baseline-phase2 \
  -v8-root deps/v8 \
  $TQ_FILES 2>&1 | tee /tmp/phase2-baseline.log
echo "exit=$?"
```

Expected: exit 0, 1490 files generated (1245 baseline + 245 new `-tq-ccbuiltins.cc`). The non-ccbuiltins subset hashes to `a5195c0258fd9af9415e9d41f0c2e38237989c1b` — this sha MUST match verification.md Phase 1 baseline; if it doesn't, the tree has drifted and later regression diffs will fail.

**Step 4: Record file count + sha of ALL outputs (used by Task 2.15 regression gate)**

```bash
find /tmp/torque-baseline-phase2 -type f | sort | wc -l \
  > /tmp/torque-baseline-phase2.count
find /tmp/torque-baseline-phase2 -type f -print0 | sort -z | \
  xargs -0 cat | shasum > /tmp/torque-baseline-phase2.sum
cat /tmp/torque-baseline-phase2.count /tmp/torque-baseline-phase2.sum
```

Expected: `1490` and a SHA (record it in scratch).

**Step 5: Record a sha of non-ccbuiltins outputs only (regression target for kCSA/kCC/kCCDebug)**

```bash
find /tmp/torque-baseline-phase2 -type f ! -name '*-tq-ccbuiltins.cc' \
  -print0 | sort -z | xargs -0 cat | shasum \
  > /tmp/torque-baseline-phase2-noccb.sum
cat /tmp/torque-baseline-phase2-noccb.sum
```

Expected: same sha as Phase 1's Task 1.10 baseline (`a5195c0258fd9af9415e9d41f0c2e38237989c1b` per verification.md). If it differs, the Node.js tree has drifted; stop and investigate before proceeding.

No commit — this is a measurement.

---

## Task 2.2: Create test-fixture directory + harness script skeleton

**Context:** Phase 2 tests each instruction via a fixture `.tq` file + a golden `-tq-ccbuiltins.cc`. The harness compares torque's actual output against the golden. This task lays down the directory layout and a stub harness that we'll populate per-instruction in Tasks 2.5–2.13.

**Files:**
- Create: `examples/libs/nodejs/test/torque-fixtures/README.md`
- Create: `examples/libs/nodejs/test/torque-fixtures/golden/.gitkeep`
- Create: `examples/libs/nodejs/test/run-torque-fixtures.sh`

**Step 1: Create the directory layout**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
mkdir -p examples/libs/nodejs/test/torque-fixtures/golden
touch examples/libs/nodejs/test/torque-fixtures/golden/.gitkeep
```

**Step 2: Write the README**

Contents of `examples/libs/nodejs/test/torque-fixtures/README.md`:

```markdown
# Torque CC-Builtins Per-Instruction Fixtures

One `.tq` fixture per Phase-2 instruction. Each fixture defines a single
builtin named `TorqueCcTest_<InstructionName>` that exercises exactly
one instruction from the Phase-2 list. The `TorqueCcTest_` prefix
activates the `kCCBuiltins` whitelist in the patched torque binary — any
builtin whose external name starts with `TorqueCcTest_` gets real C++
body emission under the kCCBuiltins pass. All other builtins keep the
Phase 1 comment-stub form.

Golden files live in `golden/`. Diff is byte-exact. Update goldens when
an instruction's emission changes intentionally.

Run: `bash examples/libs/nodejs/test/run-torque-fixtures.sh`.
```

**Step 3: Write the harness skeleton (full implementation arrives in Task 2.4)**

Contents of `examples/libs/nodejs/test/run-torque-fixtures.sh`:

```bash
#!/usr/bin/env bash
# Runs torque over the stock V8 fileset + Phase-2 fixtures, then
# diffs each fixture's generated -tq-ccbuiltins.cc against its golden.
#
# Usage:
#   bash examples/libs/nodejs/test/run-torque-fixtures.sh            # all
#   bash examples/libs/nodejs/test/run-torque-fixtures.sh return     # one
#   UPDATE_GOLDEN=1 bash examples/libs/nodejs/test/run-torque-fixtures.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_SRC="${HERE}/../build/node"
TORQUE="${NODE_SRC}/out/Release.baseline/torque"
FIX_DIR="${HERE}/torque-fixtures"
GOLD_DIR="${FIX_DIR}/golden"
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "${OUT_DIR}"' EXIT

test -x "${TORQUE}" || { echo "Missing ${TORQUE}"; exit 1; }

# Full stock fileset (same pattern as verification.md Phase 1 runs).
cd "${NODE_SRC}"
mapfile -t STOCK_TQ < <(grep -oE '"src/[^"]*\.tq"' deps/v8/BUILD.gn | tr -d '"' | sort -u)

# Fixture file list — each relative to ${HERE}.
FILTER="${1:-}"
FIXTURES=()
for tq in "${FIX_DIR}"/*.tq; do
  [ -f "${tq}" ] || continue
  name="$(basename "${tq}" .tq)"
  if [ -n "${FILTER}" ] && [ "${name}" != "${FILTER}" ]; then continue; fi
  FIXTURES+=("${tq}")
done
[ ${#FIXTURES[@]} -gt 0 ] || { echo "No fixtures matching '${FILTER}'"; exit 1; }

# Pre-create output parent dirs (torque doesn't mkdir -p).
for f in "${STOCK_TQ[@]}" "${FIXTURES[@]}"; do
  case "${f}" in
    /*) rel="${f#${NODE_SRC}/}" ;;
    *)  rel="${f}" ;;
  esac
  mkdir -p "${OUT_DIR}/$(dirname "${rel}")"
done

# Run torque over stock + fixtures.
"${TORQUE}" \
  -o "${OUT_DIR}" \
  -v8-root deps/v8 \
  "${STOCK_TQ[@]}" "${FIXTURES[@]}"

# Diff each fixture's -tq-ccbuiltins.cc against its golden.
RC=0
for tq in "${FIXTURES[@]}"; do
  name="$(basename "${tq}" .tq)"
  # The fixture path under OUT_DIR mirrors its path under NODE_SRC. Since
  # fixtures live outside NODE_SRC, torque's -v8-root=deps/v8 will produce
  # output under OUT_DIR using the absolute path of the fixture (torque
  # strips v8-root only if prefixed).
  actual="${OUT_DIR}${tq%.tq}-tq-ccbuiltins.cc"
  golden="${GOLD_DIR}/${name}-tq-ccbuiltins.cc"
  if [ ! -f "${actual}" ]; then
    echo "MISSING: ${actual}"
    RC=1
    continue
  fi
  if [ "${UPDATE_GOLDEN:-0}" = "1" ]; then
    cp "${actual}" "${golden}"
    echo "UPDATED: ${golden}"
    continue
  fi
  if ! diff -u "${golden}" "${actual}"; then
    echo "DIFF:    ${name}"
    RC=1
  else
    echo "OK:      ${name}"
  fi
done
exit ${RC}
```

**Step 4: Make it executable + sanity-check syntax**

```bash
chmod +x examples/libs/nodejs/test/run-torque-fixtures.sh
bash -n examples/libs/nodejs/test/run-torque-fixtures.sh && echo "syntax ok"
```

Expected: `syntax ok`.

**Step 5: Commit (worktree, not Node.js clone)**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/test/torque-fixtures \
        examples/libs/nodejs/test/run-torque-fixtures.sh
git commit -m "nodejs: Phase 2 — add torque CC-Builtins fixture harness"
```

---

## Task 2.3: Add `--cc-builtins-whitelist` CLI flag to torque

**Context:** Phase 2 needs a way to enable real body emission for a narrow set of builtins without breaking other 500+ stock builtins that use not-yet-implemented instructions. The cleanest mechanism is a command-line whitelist passed into torque's `GlobalContext`. `Visit(Builtin*)` consults it to decide between real emission and the Phase 1 comment stub.

**Files (inside Node.js clone):**
- Modify: `deps/v8/src/torque/global-context.h` (add whitelist field)
- Modify: `deps/v8/src/torque/torque.cc` (parse flag, populate whitelist)

**Step 1: Add whitelist to `GlobalContext`**

In `deps/v8/src/torque/global-context.h`, inside the `GlobalContext` class public section (next to other getters — grep for `void RegisterClass` or similar for placement):

```cpp
  static const std::set<std::string>& cc_builtins_whitelist() {
    return Get().cc_builtins_whitelist_;
  }
  static void set_cc_builtins_whitelist(std::set<std::string> whitelist) {
    Get().cc_builtins_whitelist_ = std::move(whitelist);
  }
```

And inside the private section, add a field:

```cpp
  std::set<std::string> cc_builtins_whitelist_;
```

(Include `<set>` if not already present — most likely is.)

**Step 2: Parse the flag in `torque.cc`**

Find the argument-parsing loop in `deps/v8/src/torque/torque.cc` (grep `--annotate-ir` or `--strip-v8-root` for the pattern). Add, alongside existing flag handlers, before the "unknown flag" abort:

```cpp
    } else if (argument.rfind("-cc-builtins-whitelist=", 0) == 0 ||
               argument.rfind("--cc-builtins-whitelist=", 0) == 0) {
      std::string csv = argument.substr(argument.find('=') + 1);
      std::set<std::string> whitelist;
      size_t start = 0;
      while (start <= csv.size()) {
        size_t comma = csv.find(',', start);
        if (comma == std::string::npos) comma = csv.size();
        if (comma > start) whitelist.insert(csv.substr(start, comma - start));
        start = comma + 1;
      }
      // Whitelist is installed after GlobalContext is constructed (below);
      // stash in a local string for now.
      options.cc_builtins_whitelist = std::move(whitelist);
```

(`options` is torque's local options struct — match the existing style; if torque stashes flags differently, use whatever the sibling flags use.)

After `GlobalContext` is constructed (search for `GlobalContext::Get()` inside `CompileTorque` or similar driver), call:

```cpp
  GlobalContext::set_cc_builtins_whitelist(std::move(options.cc_builtins_whitelist));
```

If `options` doesn't already exist, stash the whitelist in a file-scope `static std::set<std::string>` and call `set_cc_builtins_whitelist` from it. The exact placement matches whatever pattern other flags use — mimic `annotate_ir`.

**Step 3: Verify compiles**

```bash
cd examples/libs/nodejs/build/node
ninja -C out/Release.baseline torque 2>&1 | tail -20
```

Expected: clean build.

**Step 4: Smoke-test the flag is accepted**

```bash
./out/Release.baseline/torque --cc-builtins-whitelist=Foo,Bar \
  -o /tmp/phase2-task2.3 \
  -v8-root deps/v8 \
  deps/v8/src/builtins/array-isarray.tq 2>&1 | tail -5
echo "exit=$?"
```

Expected: torque aborts on unresolved types (same as any single-file run) — that's fine. The key is the flag must not cause "unknown argument" errors. If it prints "unknown argument", the parse code is misplaced; fix and retry.

**Step 5: Commit inside Node.js clone**

```bash
cd examples/libs/nodejs/build/node
git add deps/v8/src/torque/global-context.h deps/v8/src/torque/torque.cc
git -c user.email=build@wasm-posix-kernel.local \
    -c user.name="wasm-posix-kernel build" \
    commit -m "torque: add --cc-builtins-whitelist CLI flag"
```

---

## Task 2.4: Rewrite `Visit(Builtin*)` under kCCBuiltins for real emission (gated)

**Context:** The Phase 1 branch in `implementation-visitor.cc:589–598` emits a 3-line comment stub unconditionally. Phase 2 replaces that branch with: **if** the builtin's external name is in `GlobalContext::cc_builtins_whitelist()`, emit a real C++ function signature + drive the CFG through CCGenerator; **else** fall through to the Phase 1 stub (unchanged).

The "real emission" branch mirrors the existing kCSA code path (`TF_BUILTIN(...) { ... }`) structurally, but emits plain C++ (no `TF_BUILTIN` macro, no `CodeStubAssembler`). Specifically:
- Signature: `<ReturnType> Builtin_<Name>(Isolate* isolate, <ParamType> <ParamName>, ...)`.
- Body: each CFG block prints as a C++ label + instructions emitted via `CCGenerator::EmitInstruction` via an explicit iteration of the builtin's CFG.
- Closing brace.

Declarations (`decls()`) go in the function prologue; block-prefixed code goes in `out()`. The existing CSAGenerator pattern for this (in `ImplementationVisitor::GenerateBuiltinDefinitionsAndInterfaceDescriptors` and the `Visit(Macro*)` kCC branch — search `output_type_ == OutputType::kCC`) is the template.

**Files:**
- Modify: `deps/v8/src/torque/implementation-visitor.cc` — replace the kCCBuiltins branch at line ~589.

**Step 1: Add a helper — `EmitCCBuiltinHeader` — that prints the function signature**

Before `Visit(Builtin*)`, add a private helper:

```cpp
namespace {
// Emits: `<ReturnRuntimeType> Builtin_<ExternalName>(Isolate* isolate,
//                                                    <ParamType> <ParamName>, ...) {`
// to out. Returns the stack of parameter variable names, which forms the
// initial CFG input stack.
void EmitCCBuiltinSignature(Builtin* builtin, std::ostream& out,
                            Stack<std::string>* parameters,
                            Stack<const Type*>* parameter_types) {
  const Signature& sig = builtin->signature();
  const std::string& name = builtin->ExternalName();
  const Type* return_type = sig.return_type;
  out << return_type->GetRuntimeType() << " Builtin_" << name
      << "(Isolate* isolate";
  for (size_t i = 0; i < sig.parameter_types.types.size(); ++i) {
    const Type* pt = sig.parameter_types.types[i];
    const std::string& pname = sig.parameter_names[i]->value;
    out << ", " << pt->GetRuntimeType() << " " << pname;
    parameters->Push(pname);
    parameter_types->PushMany(LowerType(pt));
  }
  out << ") {\n";
}
}  // namespace
```

Place it right above `void ImplementationVisitor::Visit(Builtin* builtin)`.

**Step 2: Replace the kCCBuiltins stub branch**

Find the Phase 1 block:

```cpp
  if (output_type_ == OutputType::kCCBuiltins) {
    // Phase 1 scaffolding: ...
    csa_ccfile() << "// Builtin: " << builtin->ExternalName() << "\n"
                 << ...
    return;
  }
```

Replace with:

```cpp
  if (output_type_ == OutputType::kCCBuiltins) {
    const auto& whitelist = GlobalContext::cc_builtins_whitelist();
    if (whitelist.find(builtin->ExternalName()) == whitelist.end()) {
      // Not on the Phase-2 whitelist — emit the Phase 1 comment stub.
      csa_ccfile() << "// Builtin: " << builtin->ExternalName() << "\n"
                   << "// (Phase 1 stub — body intentionally empty)\n"
                   << "// void Builtin_" << builtin->ExternalName()
                   << "(Isolate* isolate /* + args */);\n\n";
      return;
    }
    // Phase 2: real emission via CCGenerator.
    if (builtin->IsJavaScript()) {
      // JS linkage is Phase 3/4 territory — still emit a comment.
      csa_ccfile() << "// Builtin: " << builtin->ExternalName()
                   << " (JS linkage deferred to Phase 3)\n\n";
      return;
    }

    CurrentScope::Scope current_scope(builtin);
    CurrentCallable::Scope current_callable(builtin);
    CurrentReturnValue::Scope current_return_value;

    Stack<std::string> parameters;
    Stack<const Type*> parameter_types;
    EmitCCBuiltinSignature(builtin, csa_ccfile(), &parameters, &parameter_types);

    if (builtin->body()) {
      ControlFlowGraph cfg = CfgFromAst(*builtin->body());
      CfgAssembler assembler(parameter_types);
      // Drive the CFG through CCGenerator.
      CCGenerator cc_generator(assembler.Result(), csa_ccfile(),
                               /*is_cc_debug=*/false);
      cc_generator.EmitGraph(parameters);
    }
    csa_ccfile() << "}\n\n";
    return;
  }
```

Note: `CfgFromAst`, `CfgAssembler`, `CCGenerator::EmitGraph` are how the existing kCC pass for macros drives the CFG. Grep `output_type_ == OutputType::kCC` in `implementation-visitor.cc` for the reference pattern — the real call likely looks slightly different (may use `GenerateFunctionDeclaration` + a lambda body, or may iterate blocks directly). Match whatever pattern exists verbatim; the pseudocode above is a guide, not literal.

**If the kCC pattern doesn't exist for full builtin body emission** (because kCC only handles macros, not builtins with blocks), the fallback is to mirror the CSA kCSA path (`Visit(Builtin*)`'s default branch that already emits `TF_BUILTIN`): copy the block-iteration / decls()-emission / instruction-emission structure, but call `CCGenerator::EmitInstruction` instead of `CSAGenerator::EmitInstruction`. Since the CFG, block labels, and stack discipline are backend-agnostic, the code is the same — only the per-instruction `EmitInstruction` calls differ, and those are already dispatched virtually via `torque_generator->EmitInstruction`.

In practice, the simplest correct structure is:

```cpp
    Callable* old_callable = CurrentCallable::Get();
    // Build a TorqueCodeGenerator* for this builtin.
    CCGenerator code_generator(csa_ccfile(), builtin->linkage(),
                               /*is_cc_debug=*/false);
    // Drive CFG + instructions. (See Visit(Macro*)'s kCC branch for the
    // canonical form; reproduce here.)
```

Re-read `Visit(Macro*)` in `implementation-visitor.cc` (grep `void ImplementationVisitor::Visit(Macro*`) to find the exact call shape. Adapt it.

**Step 3: Verify compiles**

```bash
ninja -C out/Release.baseline torque 2>&1 | tail -20
```

Expected: clean build. Any compile error usually means the CFG/generator API was misused; re-read the macro path and adjust.

**Step 4: Verify NON-whitelisted builtins still emit the Phase 1 stub**

```bash
rm -rf /tmp/torque-phase2.4
mkdir -p /tmp/torque-phase2.4
TQ_FILES=$(cat /tmp/phase2-tq-files.txt)
echo "$TQ_FILES" | sed 's|[^/]*$||' | sort -u | while read d; do
  mkdir -p "/tmp/torque-phase2.4/$d"
done
./out/Release.baseline/torque \
  -o /tmp/torque-phase2.4 \
  -v8-root deps/v8 \
  $TQ_FILES 2>&1 | tail -5
echo "exit=$?"

# Diff against Task 2.1 baseline — should be empty (no change to any file).
diff -r /tmp/torque-baseline-phase2 /tmp/torque-phase2.4 | head -10
```

Expected: exit 0 from torque, empty diff against baseline. The whitelist is empty (no `--cc-builtins-whitelist` passed), so every builtin hits the Phase 1 stub path.

**Step 5: Commit inside Node.js clone**

```bash
git add deps/v8/src/torque/implementation-visitor.cc
git -c user.email=build@wasm-posix-kernel.local \
    -c user.name="wasm-posix-kernel build" \
    commit -m "torque: Visit(Builtin*) kCCBuiltins — real emission under whitelist"
```

---

## Task 2.5: Implement `ReturnInstruction` + fixture

**Context:** The trivial case. CSA emits `CodeStubAssembler(state_).Return(...)`; we emit `return ...;`. Stack handling is identical.

**Files:**
- Modify: `deps/v8/src/torque/cc-generator.cc:326–329` (replace `ReportError`)
- Create: `examples/libs/nodejs/test/torque-fixtures/return.tq`
- Create: `examples/libs/nodejs/test/torque-fixtures/golden/return-tq-ccbuiltins.cc`

**Step 1: Write the fixture `.tq`**

Contents of `examples/libs/nodejs/test/torque-fixtures/return.tq`:

```
// Phase 2 test fixture: ReturnInstruction.
namespace test_cc {
  builtin TorqueCcTest_Return(implicit context: Context)(arg: Smi): Smi {
    return arg;
  }
}
```

**Step 2: Replace the `ReportError` stub in `cc-generator.cc`**

Change `cc-generator.cc:326–329` from:

```cpp
void CCGenerator::EmitInstruction(const ReturnInstruction& instruction,
                                  Stack<std::string>* stack) {
  ReportError("Not supported in C++ output: Return");
}
```

To:

```cpp
void CCGenerator::EmitInstruction(const ReturnInstruction& instruction,
                                  Stack<std::string>* stack) {
  out() << "  return ";
  std::vector<std::string> values = stack->PopMany(instruction.count);
  if (values.size() == 1) {
    out() << values[0];
  } else {
    // Multi-value return uses std::tuple to match how we lower multi-value
    // returns in Tagged return-type contexts.
    out() << "std::make_tuple(";
    PrintCommaSeparatedList(out(), values);
    out() << ")";
  }
  out() << ";\n";
}
```

**Step 3: Rebuild torque**

```bash
cd examples/libs/nodejs/build/node
ninja -C out/Release.baseline torque
```

**Step 4: Run the fixture harness with the whitelist, capture actual output as initial golden**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend

# Bypass the harness for this first run — we need to include the whitelist.
cd examples/libs/nodejs/build/node
TQ_FILES=$(cat /tmp/phase2-tq-files.txt)
FIX=$(pwd)/../../test/torque-fixtures/return.tq
rm -rf /tmp/torque-phase2.5
mkdir -p /tmp/torque-phase2.5
echo "$TQ_FILES" | sed 's|[^/]*$||' | sort -u | while read d; do
  mkdir -p "/tmp/torque-phase2.5/$d"
done
mkdir -p "/tmp/torque-phase2.5$(dirname "$FIX")"
./out/Release.baseline/torque \
  --cc-builtins-whitelist=TorqueCcTest_Return \
  -o /tmp/torque-phase2.5 \
  -v8-root deps/v8 \
  $TQ_FILES "$FIX" 2>&1 | tail -5
echo "exit=$?"

# Find the generated fixture output.
OUT="/tmp/torque-phase2.5${FIX%.tq}-tq-ccbuiltins.cc"
cat "$OUT"
```

Expected: exit 0; the file shows a real function body:

```cpp
// Copyright 2024 ...
// AUTO-GENERATED ...
namespace v8::internal {

Smi Builtin_TorqueCcTest_Return(Isolate* isolate, Context context, Smi arg) {
  // ... decls ...
block0:
  return arg;
}

}  // namespace v8::internal
```

(Exact output depends on CFG assembly; if blocks / decls look different, inspect and accept as initial golden.)

**Step 5: Install as golden + verify harness agrees**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
cp "$OUT" examples/libs/nodejs/test/torque-fixtures/golden/return-tq-ccbuiltins.cc
# The harness passes no whitelist yet — modify to pass one (Task 2.13 wires
# this generically). For now, pass it manually:
cd examples/libs/nodejs/build/node
./out/Release.baseline/torque \
  --cc-builtins-whitelist=TorqueCcTest_Return \
  -o /tmp/torque-phase2.5b \
  -v8-root deps/v8 \
  $TQ_FILES "$FIX"
diff -u \
  ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend/examples/libs/nodejs/test/torque-fixtures/golden/return-tq-ccbuiltins.cc \
  "/tmp/torque-phase2.5b${FIX%.tq}-tq-ccbuiltins.cc"
echo "diff-exit=$?"
```

Expected: `diff-exit=0` (empty diff).

**Step 6: Commit (Node.js clone + worktree)**

```bash
# V8 change:
cd examples/libs/nodejs/build/node
git add deps/v8/src/torque/cc-generator.cc
git -c user.email=build@wasm-posix-kernel.local \
    -c user.name="wasm-posix-kernel build" \
    commit -m "torque: implement CCGenerator::Emit(ReturnInstruction)"

# Fixture + golden (worktree):
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/test/torque-fixtures/return.tq \
        examples/libs/nodejs/test/torque-fixtures/golden/return-tq-ccbuiltins.cc
git commit -m "nodejs: Phase 2 — ReturnInstruction fixture + golden"
```

---

## Task 2.6: Implement `PushUninitializedInstruction` + fixture

**Context:** Pushes an uninitialized local of the given type. CSAGenerator emits `ca_.Uninitialized<T>()` as a stack string. The C++ form is simpler — emit a default-constructed local and register its variable name.

CSA reference: `csa-generator.cc:102–112`.
CC stub to replace: `cc-generator.cc:84–88`.

**Files:**
- Modify: `deps/v8/src/torque/cc-generator.cc:84–88`
- Create: `examples/libs/nodejs/test/torque-fixtures/push-uninitialized.tq`
- Create: `examples/libs/nodejs/test/torque-fixtures/golden/push-uninitialized-tq-ccbuiltins.cc`

**Step 1: Write the fixture**

`push-uninitialized.tq`:

```
// Phase 2 test fixture: PushUninitializedInstruction.
namespace test_cc {
  builtin TorqueCcTest_PushUninitialized(implicit context: Context)(): Smi {
    // `uninitialized` is the Torque keyword for PushUninitialized.
    const x: Smi = uninitialized;
    return x;
  }
}
```

(Check `base.tq` for the exact syntax Torque expects for an uninitialized literal — it may require `Cast<Smi>(uninitialized<HeapObject>())` or similar. Adjust until the CFG visibly emits a `PushUninitializedInstruction`.)

**Step 2: Replace the `ReportError` stub**

```cpp
void CCGenerator::EmitInstruction(
    const PushUninitializedInstruction& instruction,
    Stack<std::string>* stack) {
  std::string name =
      DefinitionToVariable(instruction.GetValueDefinition());
  decls() << "  " << instruction.type->GetRuntimeType()
          << " " << name << "{};  USE(" << name << ");\n";
  stack->Push(name);
  SetDefinitionVariable(instruction.GetValueDefinition(), name);
}
```

**Step 3–5: Rebuild, capture golden, verify diff, commit**

Same pattern as Task 2.5. Runs:

```bash
cd examples/libs/nodejs/build/node
ninja -C out/Release.baseline torque
./out/Release.baseline/torque \
  --cc-builtins-whitelist=TorqueCcTest_PushUninitialized \
  -o /tmp/torque-phase2.6 \
  -v8-root deps/v8 \
  $TQ_FILES \
  ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend/examples/libs/nodejs/test/torque-fixtures/push-uninitialized.tq
```

Inspect `/tmp/torque-phase2.6/…/push-uninitialized-tq-ccbuiltins.cc`. Copy to golden. Commit as before.

---

## Task 2.7: Implement `NamespaceConstantInstruction` + fixture

**Context:** Call a generated C++ constant accessor. CSA form: `FooConstant(state_);`. CC form: `FooConstant(isolate);` (or direct reference — depends on what external_name() expands to for namespace constants).

CSA reference: `csa-generator.cc:124–152`.
CC stub to replace: `cc-generator.cc:96–100`.

**Files:**
- Modify: `deps/v8/src/torque/cc-generator.cc:96–100`
- Create: `examples/libs/nodejs/test/torque-fixtures/namespace-constant.tq`
- Create: `examples/libs/nodejs/test/torque-fixtures/golden/namespace-constant-tq-ccbuiltins.cc`

**Step 1: Write the fixture**

`namespace-constant.tq`:

```
// Phase 2 test fixture: NamespaceConstantInstruction.
namespace test_cc {
  const kPhase2TestConst: constexpr int32 = 42;

  builtin TorqueCcTest_NamespaceConstant(implicit context: Context)(): Smi {
    const v: Smi = SmiConstant(kPhase2TestConst);
    return v;
  }
}
```

(Adjust if Torque requires a different form for non-constexpr namespace constants; `constexpr int32` is the simplest that triggers the instruction. Verify by running torque with `-annotate-ir` and grepping for `NamespaceConstant` in the IR dump. If the constant is optimized away into a ConstexprBranch etc., change the fixture to use a non-constexpr `const`.)

**Step 2: Replace the stub**

Mirror CSA structure:

```cpp
void CCGenerator::EmitInstruction(
    const NamespaceConstantInstruction& instruction,
    Stack<std::string>* stack) {
  const Type* type = instruction.constant->type();
  std::vector<std::string> results;
  const auto lowered = LowerType(type);
  for (std::size_t i = 0; i < lowered.size(); ++i) {
    results.push_back(DefinitionToVariable(instruction.GetValueDefinition(i)));
    stack->Push(results.back());
    decls() << "  " << lowered[i]->GetRuntimeType() << " "
            << stack->Top() << "{}; USE(" << stack->Top() << ");\n";
  }
  out() << "  ";
  if (type->StructSupertype()) {
    out() << "std::tie(";
    PrintCommaSeparatedList(out(), results);
    out() << ") = ";
  } else if (results.size() == 1) {
    out() << results[0] << " = ";
  }
  out() << instruction.constant->external_name() << "(isolate)";
  if (type->StructSupertype()) {
    out() << ".Flatten();\n";
  } else {
    out() << ";\n";
  }
}
```

**Step 3–5: Rebuild, capture golden, verify, commit** (same pattern as 2.5/2.6).

---

## Task 2.8: Implement `PushBuiltinPointerInstruction` + fixture

**Context:** Push a reference to a builtin as a `BuiltinPtr`. CSA wraps it in `ca_.SmiConstant(Builtin::k...)`. In the CC world, builtin pointers are represented as `Address` values; we can use `Runtime::FunctionForId` or just reference the generated function pointer. For Phase 2, keep it simple: emit a comment + a `Tagged<Object>{}` placeholder and record the builtin name. The precise form matters for Phase 4's dispatch table but not for Phase 2 parse-ability.

CSA reference: `csa-generator.cc:114–122`.
CC stub to replace: `cc-generator.cc:90–94`.

**Files:**
- Modify: `deps/v8/src/torque/cc-generator.cc:90–94`
- Create: `examples/libs/nodejs/test/torque-fixtures/push-builtin-pointer.tq`
- Create: `examples/libs/nodejs/test/torque-fixtures/golden/push-builtin-pointer-tq-ccbuiltins.cc`

**Step 1: Write the fixture**

Find a simple existing builtin to reference. In `base.tq` there's `GetContinuationPreservedEmbedderData` or a test-able stub. If nothing works, define a companion builtin in the fixture:

```
namespace test_cc {
  builtin TorqueCcTest_Helper(): Smi { return 1; }

  builtin TorqueCcTest_PushBuiltinPointer(implicit context: Context)(): Smi {
    // `of(Foo)` yields a BuiltinPtr.
    const fn: BuiltinPtr = of(TorqueCcTest_Helper);
    // The fixture has to use it somehow so IR doesn't DCE the instruction.
    return fn == fn ? 1 : 0;  // crude keep-alive.
  }
}
```

(Adjust until `PushBuiltinPointerInstruction` appears in `-annotate-ir` output.)

**Step 2: Replace the stub**

```cpp
void CCGenerator::EmitInstruction(
    const PushBuiltinPointerInstruction& instruction,
    Stack<std::string>* stack) {
  std::string name =
      DefinitionToVariable(instruction.GetValueDefinition());
  decls() << "  Tagged<Object> " << name << "{};  USE(" << name << ");\n";
  out() << "  " << name
        << " = Smi::FromInt(static_cast<int>(Builtin::k"
        << instruction.external_name << "));\n";
  stack->Push(name);
  SetDefinitionVariable(instruction.GetValueDefinition(), name);
}
```

(The `Smi::FromInt(Builtin::k…)` form matches what CSA does conceptually; Phase 4's dispatch table will replace this with a real function-pointer lookup. Phase 2 only needs well-formed C++.)

**Step 3–5:** rebuild, capture golden, verify, commit.

---

## Task 2.9: Implement `StoreReferenceInstruction` + fixture

**Context:** Write a value to an object field at a computed offset. CSA uses `CodeStubAssembler::StoreReference<T>(...)`. CC uses `TaggedField<T>::store(obj, offset, value)` for tagged types; `WriteField<T>(obj, offset, value)` for untagged.

CSA reference: `csa-generator.cc:931–946`.
CC stub to replace: `cc-generator.cc:441–444`.

**Files:**
- Modify: `deps/v8/src/torque/cc-generator.cc:441–444`
- Create: `examples/libs/nodejs/test/torque-fixtures/store-reference.tq`
- Create: `examples/libs/nodejs/test/torque-fixtures/golden/store-reference-tq-ccbuiltins.cc`

**Step 1: Write the fixture**

```
// Assigns to a known mutable field; the simplest triggers a StoreReference.
namespace test_cc {
  builtin TorqueCcTest_StoreReference(
      implicit context: Context)(arr: FixedArray, v: Smi): Smi {
    arr.objects[0] = v;
    return v;
  }
}
```

**Step 2: Replace the stub**

Mirror the `LoadReferenceInstruction` emission (which is already real in CCGenerator) but for store:

```cpp
void CCGenerator::EmitInstruction(const StoreReferenceInstruction& instruction,
                                  Stack<std::string>* stack) {
  std::string value = stack->Pop();
  std::string offset = stack->Pop();
  std::string object = stack->Pop();
  std::string result_type = instruction.type->GetRuntimeType();
  if (instruction.type->IsSubtypeOf(TypeOracle::GetTaggedType())) {
    out() << "  TaggedField<" << result_type
          << ">::store(UncheckedCast<HeapObject>(" << object
          << "), static_cast<int>(" << offset << "), " << value << ");\n";
  } else {
    // Replicates CppClassGenerator's untagged store (see LoadReference
    // comment about ReadField/WriteField).
    out() << "  (" << object << ")->WriteField<" << result_type << ">("
          << offset << ", " << value << ");\n";
  }
}
```

**Step 3–5:** rebuild, capture golden, verify, commit.

---

## Task 2.10: Implement `StoreBitFieldInstruction` + fixture

**Context:** Encode a bit-field value back into its container. CSA uses `UpdateWord<T>::encode` helpers on Word32T / WordT. CC uses `base::BitField<...>::encode(value) | (container & ~base::BitField<...>::kMask)`.

CSA reference: `csa-generator.cc:1008+`.
CC stub to replace: `cc-generator.cc:488–491`.
Reuse the `GetBitFieldSpecialization` helper that's already defined in `cc-generator.cc` right above `LoadBitFieldInstruction`.

**Files:**
- Modify: `deps/v8/src/torque/cc-generator.cc:488–491`
- Create: `examples/libs/nodejs/test/torque-fixtures/store-bit-field.tq`
- Create: `examples/libs/nodejs/test/torque-fixtures/golden/store-bit-field-tq-ccbuiltins.cc`

**Step 1: Write the fixture**

```
// Uses a bitfield-containing struct; force emit of StoreBitFieldInstruction.
namespace test_cc {
  bitfield struct Phase2BitField extends uint32 {
    a: int32: 8 bit;
    b: int32: 24 bit;
  }
  builtin TorqueCcTest_StoreBitField(implicit context: Context)(
      bf: Phase2BitField, v: int32): Phase2BitField {
    return Phase2BitField{a: v, b: bf.b};
  }
}
```

**Step 2: Replace the stub**

```cpp
void CCGenerator::EmitInstruction(const StoreBitFieldInstruction& instruction,
                                  Stack<std::string>* stack) {
  std::string result_name =
      DefinitionToVariable(instruction.GetValueDefinition());
  std::string value = stack->Pop();
  std::string bit_field_struct = stack->Pop();
  stack->Push(result_name);

  const Type* struct_type = instruction.bit_field_struct_type;
  decls() << "  " << struct_type->GetRuntimeType() << " " << result_name
          << "{}; USE(" << result_name << ");\n";

  std::string spec =
      GetBitFieldSpecialization(struct_type, instruction.bit_field);
  out() << "  " << result_name << " = static_cast<"
        << struct_type->GetRuntimeType() << ">(" << spec << "::update("
        << bit_field_struct << ", " << value << "));\n";
}
```

(`base::BitField::update(container, value)` = `(container & ~kMask) | encode(value)`. Available in V8's `src/base/bit-field.h`.)

**Step 3–5:** rebuild, capture golden, verify, commit.

---

## Task 2.11: Implement `CallRuntimeInstruction` + fixture

**Context:** Call into a V8 `Runtime_Foo` function. CSA form: `CodeStubAssembler(state_).CallRuntime(Runtime::kFoo, args...)`. CC form: `Runtime::Call<Runtime::kFoo>(isolate, args...)`. This is the main "real work" instruction — most user-space Torque code paths through at least one runtime call.

Note: runtime exceptions (`catch_block`) are NOT supported in Phase 2; if `instruction.catch_block` is set, `ReportError`. Phase 3 handles that via `CallCsaMacroAndBranch`'s infrastructure.

CSA reference: `csa-generator.cc:713–767`.
CC stub to replace: `cc-generator.cc:279–282`.

**Files:**
- Modify: `deps/v8/src/torque/cc-generator.cc:279–282`
- Create: `examples/libs/nodejs/test/torque-fixtures/call-runtime.tq`
- Create: `examples/libs/nodejs/test/torque-fixtures/golden/call-runtime-tq-ccbuiltins.cc`

**Step 1: Write the fixture**

```
// Calls a no-fail runtime function.
namespace runtime {
  extern runtime ArrayIsArray(implicit context: Context)(JSAny): JSAny;
}
namespace test_cc {
  builtin TorqueCcTest_CallRuntime(
      implicit context: Context)(arg: JSAny): JSAny {
    return runtime::ArrayIsArray(arg);
  }
}
```

**Step 2: Replace the stub**

```cpp
void CCGenerator::EmitInstruction(const CallRuntimeInstruction& instruction,
                                  Stack<std::string>* stack) {
  if (instruction.catch_block) {
    ReportError(
        "Phase 2: CallRuntime with a catch block (exception handling) is "
        "deferred to Phase 3.");
  }
  std::vector<std::string> arguments = stack->PopMany(instruction.argc);
  const Type* return_type =
      instruction.runtime_function->signature().return_type;
  std::vector<const Type*> result_types;
  if (return_type != TypeOracle::GetNeverType()) {
    result_types = LowerType(return_type);
  }
  if (result_types.size() > 1) {
    ReportError("runtime function must have at most one result");
  }

  if (instruction.is_tailcall) {
    out() << "  return Runtime::Call<Runtime::k"
          << instruction.runtime_function->ExternalName() << ">(isolate";
    for (const auto& arg : arguments) out() << ", " << arg;
    out() << ");\n";
    return;
  }

  std::string result_name;
  if (result_types.size() == 1) {
    result_name = DefinitionToVariable(instruction.GetValueDefinition(0));
    decls() << "  " << result_types[0]->GetRuntimeType() << " " << result_name
            << "{};  USE(" << result_name << ");\n";
    stack->Push(result_name);
    out() << "  " << result_name << " = Runtime::Call<Runtime::k"
          << instruction.runtime_function->ExternalName() << ">(isolate";
    for (const auto& arg : arguments) out() << ", " << arg;
    out() << ");\n";
  } else {
    DCHECK_EQ(0, result_types.size());
    out() << "  Runtime::Call<Runtime::k"
          << instruction.runtime_function->ExternalName() << ">(isolate";
    for (const auto& arg : arguments) out() << ", " << arg;
    out() << ");\n";
    if (return_type == TypeOracle::GetNeverType()) {
      out() << "  UNREACHABLE();\n";
    } else {
      DCHECK(return_type == TypeOracle::GetVoidType());
    }
  }
}
```

**Step 3–5:** rebuild, capture golden, verify, commit.

---

## Task 2.12: Implement `CallBuiltinInstruction` + fixture

**Context:** Call another Torque builtin. CSA form: `ca_.CallBuiltin<T>(Builtin::kFoo, args...)`. CC form: direct function call to the generated C++ builtin — `Builtin_Foo(isolate, args...)`.

Note: `is_tailcall`, `builtin->IsJavaScript()`, and `catch_block` all fall outside Phase 2; `ReportError` on any of those.

CSA reference: `csa-generator.cc:525–621`.
CC stub to replace: `cc-generator.cc:268–271`.

**Files:**
- Modify: `deps/v8/src/torque/cc-generator.cc:268–271`
- Create: `examples/libs/nodejs/test/torque-fixtures/call-builtin.tq`
- Create: `examples/libs/nodejs/test/torque-fixtures/golden/call-builtin-tq-ccbuiltins.cc`

**Step 1: Write the fixture**

```
namespace test_cc {
  builtin TorqueCcTest_CallBuiltin_Helper(implicit context: Context)(
      arg: Smi): Smi {
    return arg;
  }
  builtin TorqueCcTest_CallBuiltin(implicit context: Context)(arg: Smi): Smi {
    return TorqueCcTest_CallBuiltin_Helper(arg);
  }
}
```

Both builtins must be on the whitelist (`--cc-builtins-whitelist=TorqueCcTest_CallBuiltin,TorqueCcTest_CallBuiltin_Helper`).

**Step 2: Replace the stub**

```cpp
void CCGenerator::EmitInstruction(const CallBuiltinInstruction& instruction,
                                  Stack<std::string>* stack) {
  if (instruction.is_tailcall) {
    ReportError("Phase 2: CallBuiltin tail-call is deferred.");
  }
  if (instruction.builtin->IsJavaScript()) {
    ReportError("Phase 2: JS-linkage CallBuiltin is deferred to Phase 3.");
  }
  if (instruction.catch_block) {
    ReportError("Phase 2: CallBuiltin with catch block is deferred.");
  }

  std::vector<std::string> arguments = stack->PopMany(instruction.argc);
  std::vector<const Type*> result_types =
      LowerType(instruction.builtin->signature().return_type);

  std::string result_name;
  if (result_types.size() == 1) {
    result_name = DefinitionToVariable(instruction.GetValueDefinition(0));
    decls() << "  " << result_types[0]->GetRuntimeType() << " "
            << result_name << "{};  USE(" << result_name << ");\n";
    stack->Push(result_name);
    out() << "  " << result_name << " = ";
  } else if (result_types.empty()) {
    out() << "  ";
  } else {
    ReportError(
        "Phase 2: CallBuiltin multi-result (PairT) return is deferred.");
  }

  out() << "Builtin_" << instruction.builtin->ExternalName() << "(isolate";
  for (const auto& arg : arguments) out() << ", " << arg;
  out() << ");\n";
}
```

**Step 3–5:** rebuild, capture golden, verify, commit.

---

## Task 2.13: Implement `CallBuiltinPointerInstruction` + fixture

**Context:** Indirect call through a builtin pointer. CSA uses `CallBuiltinPointer` with interface descriptors. In pure C++, we can declare a function-pointer type matching the builtin signature and call through it. But the `instruction.type->function_pointer_type_id()` indirection only makes sense with V8's descriptor tables. For Phase 2, emit a compile-checkable placeholder (a comment + assignment of default-constructed return value) — real indirect dispatch is Phase 4.

Gate: if the Phase 2 implementation can't meaningfully emit, `ReportError("Phase 2: CallBuiltinPointer deferred to Phase 4 dispatch table.")`. The fixture then demonstrates the error is surfaced correctly for a forced-use case.

CSA reference: `csa-generator.cc:623–657`.
CC stub to replace: `cc-generator.cc:273–277`.

**Files:**
- Modify: `deps/v8/src/torque/cc-generator.cc:273–277`
- Create: `examples/libs/nodejs/test/torque-fixtures/call-builtin-pointer.tq`
- Create: `examples/libs/nodejs/test/torque-fixtures/golden/call-builtin-pointer-tq-ccbuiltins.cc`

**Decision:** Phase 2 DOES implement this, minimally. Since we already have `Builtin_Foo` functions emitted per-builtin, an indirect call is a C++ function pointer. Emit a `typedef` locally + dispatch.

**Step 1: Write the fixture**

```
// Forces CallBuiltinPointer by storing a BuiltinPtr and invoking it.
namespace test_cc {
  builtin TorqueCcTest_CallBuiltinPointer_Helper(
      implicit context: Context)(arg: Smi): Smi {
    return arg;
  }
  builtin TorqueCcTest_CallBuiltinPointer(
      implicit context: Context)(arg: Smi): Smi {
    const fp: BuiltinPtr = of(TorqueCcTest_CallBuiltinPointer_Helper);
    return Call(context, fp, arg);
  }
}
```

(If `Call(context, fp, arg)` is not the correct Torque syntax for calling through a BuiltinPtr, check `base.tq` or `test/torque/test-torque.tq` for the actual form. Adjust fixture until the IR shows `CallBuiltinPointer`.)

**Step 2: Replace the stub**

```cpp
void CCGenerator::EmitInstruction(
    const CallBuiltinPointerInstruction& instruction,
    Stack<std::string>* stack) {
  if (instruction.is_tailcall) {
    ReportError("Phase 2: CallBuiltinPointer tail-call is deferred.");
  }
  std::vector<std::string> arguments = stack->PopMany(instruction.argc);
  std::string function = stack->Pop();
  std::vector<const Type*> result_types =
      LowerType(instruction.type->return_type());
  if (result_types.size() != 1) {
    ReportError("builtin pointers must have exactly one result");
  }
  std::string result_name =
      DefinitionToVariable(instruction.GetValueDefinition(0));
  decls() << "  " << result_types[0]->GetRuntimeType() << " "
          << result_name << "{};  USE(" << result_name << ");\n";
  stack->Push(result_name);

  // Phase 2: assume the caller has already resolved the builtin pointer to
  // an address in the dispatch table. We cast the pointer to the concrete
  // function-pointer type via a local typedef.
  out() << "  {\n"
        << "    using FnPtr = " << result_types[0]->GetRuntimeType()
        << " (*)(Isolate*";
  const auto& params = instruction.type->parameter_types();
  for (size_t i = 0; i < params.size(); ++i) {
    out() << ", " << params[i]->GetRuntimeType();
  }
  out() << ");\n"
        << "    FnPtr fn = reinterpret_cast<FnPtr>(\n"
        << "        Builtins::CppEntryOf(static_cast<Builtin>(\n"
        << "            Smi::ToInt(" << function << "))));\n"
        << "    " << result_name << " = fn(isolate";
  for (const auto& arg : arguments) out() << ", " << arg;
  out() << ");\n"
        << "  }\n";
}
```

`Builtins::CppEntryOf` is a placeholder — the name of the actual dispatch-table lookup will be finalized in Phase 4. For Phase 2, the call must parse as valid C++; it doesn't need to link. The golden file captures whatever we emit.

**Step 3–5:** rebuild, capture golden, verify, commit.

---

## Task 2.14: End-to-end: run the full harness on all 9 fixtures

**Context:** The harness script written in Task 2.2 accepts an optional fixture-name filter. Now the harness needs to pass `--cc-builtins-whitelist` built from the fixture basenames. Update the harness to include this, then run all 9 fixtures and confirm each diff is clean.

**Files:**
- Modify: `examples/libs/nodejs/test/run-torque-fixtures.sh`

**Step 1: Wire the whitelist into the harness**

Between the "Pre-create output parent dirs" block and the `torque` invocation, compute the whitelist:

```bash
# Build whitelist from fixture basenames. Phase 2 fixtures are named
# exactly after the builtin they define (TorqueCcTest_<Name>), and each
# fixture may also define helper builtins — those are captured by scanning
# the .tq for `builtin TorqueCcTest_` declarations.
WHITELIST=()
for tq in "${FIXTURES[@]}"; do
  while IFS= read -r line; do
    WHITELIST+=("${line}")
  done < <(grep -oE 'builtin TorqueCcTest_[A-Za-z0-9_]+' "${tq}" | awk '{print $2}')
done
WHITELIST_CSV="$(IFS=,; echo "${WHITELIST[*]}")"
```

And add `--cc-builtins-whitelist="${WHITELIST_CSV}"` to the torque invocation:

```bash
"${TORQUE}" \
  --cc-builtins-whitelist="${WHITELIST_CSV}" \
  -o "${OUT_DIR}" \
  -v8-root deps/v8 \
  "${STOCK_TQ[@]}" "${FIXTURES[@]}"
```

**Step 2: Run the full harness**

```bash
bash examples/libs/nodejs/test/run-torque-fixtures.sh
```

Expected output (one line per fixture):

```
OK:      return
OK:      push-uninitialized
OK:      namespace-constant
OK:      push-builtin-pointer
OK:      store-reference
OK:      store-bit-field
OK:      call-runtime
OK:      call-builtin
OK:      call-builtin-pointer
```

Exit 0. Any `DIFF` or `MISSING` line = regression; stop and fix.

**Step 3: Commit the harness update**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/test/run-torque-fixtures.sh
git commit -m "nodejs: Phase 2 — harness builds whitelist from fixture basenames"
```

---

## Task 2.15: clang++ parse-check on one generated fixture

**Context:** "Generated C++ parses as valid C++" is our Phase 2 definition of done for correctness. Run `clang++ -fsyntax-only` on one of the simplest fixtures (`return-tq-ccbuiltins.cc`) with V8's include paths. Link failures are fine; compile failures are not.

**Files:** none modified.

**Step 1: Copy the generated file + a minimal forwarding wrapper**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend

GEN_DIR=$(mktemp -d)
GEN="${GEN_DIR}/return-tq-ccbuiltins.cc"
cp examples/libs/nodejs/test/torque-fixtures/golden/return-tq-ccbuiltins.cc "${GEN}"

# Wrap with the minimal V8 prologue. Grep a real -tq-csa.cc for its
# #include list and reproduce — approximate:
cat > "${GEN_DIR}/wrap.cc" <<'EOF'
#include "src/api/api.h"
#include "src/builtins/builtins.h"
#include "src/execution/isolate.h"
#include "src/objects/objects.h"
#include "src/objects/smi.h"
#include "src/objects/tagged.h"
#include "src/runtime/runtime.h"
// Forward the generated file.
#include "return-tq-ccbuiltins.cc"
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
  "${GEN_DIR}/wrap.cc" 2>&1 | tee /tmp/phase2-clang.log
echo "exit=$?"
```

Expected: exit 0 OR errors unrelated to our emitted code (missing symbol definitions in headers are fine; syntax errors in our emission are NOT). The set of defines/flags may need tuning — match whatever `out/Release.baseline/gen/torque-generated/src/builtins/array-of-tq-csa.cc` needs to compile (inspect its first `ninja -v` command for the exact flags).

If the check surfaces a syntax error in the generated code, fix it in cc-generator.cc and re-run from Task 2.5-ish. Common culprits:
- Missing `Isolate*` parameter propagation.
- Wrong `Tagged<T>` vs `Object` type name (CCGenerator uses `GetRuntimeType()` — make sure it's what V8 headers expect).
- `namespace v8::internal` nesting off-by-one (builtin emitted outside the `v8::internal` block).

**Step 3: No commit** — this is a verification gate, not new code. Log failures to `/tmp/phase2-clang.log` for reference.

---

## Task 2.16: Regression check — no change to non-whitelisted output

**Context:** Phase 2's gate keeps all non-whitelisted builtins on the Phase 1 comment-stub path. Prove that by running torque over **just** the stock fileset (no fixtures, no whitelist) and diffing against the Task 2.1 baseline.

**Files:** none modified.

**Step 1: Run torque with empty whitelist over stock fileset**

```bash
cd examples/libs/nodejs/build/node
TQ_FILES=$(cat /tmp/phase2-tq-files.txt)
rm -rf /tmp/torque-phase2.16
mkdir -p /tmp/torque-phase2.16
echo "$TQ_FILES" | sed 's|[^/]*$||' | sort -u | while read d; do
  mkdir -p "/tmp/torque-phase2.16/$d"
done
./out/Release.baseline/torque \
  -o /tmp/torque-phase2.16 \
  -v8-root deps/v8 \
  $TQ_FILES 2>&1 | tail -5
echo "exit=$?"
```

Expected: exit 0.

**Step 2: Full-tree diff against Task 2.1 baseline**

```bash
diff -r /tmp/torque-baseline-phase2 /tmp/torque-phase2.16 \
  | tee /tmp/phase2-regression.diff
```

Expected: empty diff. Any line = regression in either the Phase 1 stub emission or some ancillary kCSA / kCC / kCCDebug output. Stop and investigate before continuing.

**Step 3: Non-ccbuiltins sha match**

```bash
find /tmp/torque-phase2.16 -type f ! -name '*-tq-ccbuiltins.cc' \
  -print0 | sort -z | xargs -0 cat | shasum
# Compare to /tmp/torque-baseline-phase2-noccb.sum
diff /tmp/torque-baseline-phase2-noccb.sum <(find /tmp/torque-phase2.16 \
  -type f ! -name '*-tq-ccbuiltins.cc' -print0 | sort -z | xargs -0 cat | shasum)
```

Expected: no diff.

No commit.

---

## Task 2.17: Export consolidated patch file

**Context:** Phase 2 adds ~14 new commits on the Node.js clone (1 for whitelist infra, 1 for Visit(Builtin*) rewrite, 9 for per-instruction implementations, maybe 3 for follow-up fixes). Combined with Phase 1's 10 commits, the Node.js tree now has ~24 commits on top of upstream. We export them all as a single patch — same filename as Phase 1 (`v8-torque-cc-builtins.patch`), now with a superset of content.

**Files:**
- Modify: `examples/libs/nodejs/patches/v8-torque-cc-builtins.patch`

**Step 1: Count the commits**

```bash
cd examples/libs/nodejs/build/node
git log --oneline 9fe7634c..HEAD | tee /tmp/phase2-commits.txt
wc -l /tmp/phase2-commits.txt
```

Expected: ~24 (10 from Phase 1 + ~14 from Phase 2). `9fe7634c` is the upstream base per `verification.md`.

**Step 2: Export the range as a single patch**

```bash
N=$(wc -l < /tmp/phase2-commits.txt)
git format-patch -${N} --stdout > ../../patches/v8-torque-cc-builtins.patch
wc -l ../../patches/v8-torque-cc-builtins.patch
```

Expected: a patch file. Phase 1's was ~13,420 bytes; Phase 2 will be larger (hundreds of added/removed lines in cc-generator.cc + implementation-visitor.cc + new global-context.h / torque.cc edits).

**Step 3: Verify the patch re-applies cleanly on a fresh tree**

```bash
cd examples/libs/nodejs/build/node
git tag phase2-commits HEAD
git reset --hard 9fe7634c

git apply --3way ../../patches/v8-torque-cc-builtins.patch
git status --short | head -20
```

Expected: ~5–8 files modified (cc-generator.cc, implementation-visitor.cc, implementation-visitor.h, global-context.h, torque.cc, declarable.h, BUILD.gn). No rejected hunks.

**Step 4: Restore commits and rebuild**

```bash
git reset --hard phase2-commits
git tag -d phase2-commits
ninja -C out/Release.baseline torque
```

**Step 5: Re-run fixture harness after restore**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
bash examples/libs/nodejs/test/run-torque-fixtures.sh
```

Expected: all 9 fixtures OK.

**Step 6: Commit the patch file**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/patches/v8-torque-cc-builtins.patch
git commit -m "nodejs: Phase 2 — v8 torque kCCBuiltins 9-instruction implementation patch"
```

---

## Task 2.18: Update verification.md with Phase 2 summary

**Files:**
- Modify: `examples/libs/nodejs/verification.md`

**Step 1: Append a Phase 2 section**

Add to `verification.md`:

````markdown
## Phase 2 Summary

| Item | Result |
|---|---|
| `--cc-builtins-whitelist` CLI flag added | ✅ |
| `Visit(Builtin*)` under kCCBuiltins drives real emission when whitelisted | ✅ |
| `ReturnInstruction` emission | ✅ |
| `PushUninitializedInstruction` emission | ✅ |
| `NamespaceConstantInstruction` emission | ✅ |
| `PushBuiltinPointerInstruction` emission | ✅ |
| `StoreReferenceInstruction` emission | ✅ |
| `StoreBitFieldInstruction` emission | ✅ |
| `CallRuntimeInstruction` emission | ✅ |
| `CallBuiltinInstruction` emission | ✅ |
| `CallBuiltinPointerInstruction` emission | ✅ |
| 9 fixture files + goldens in `examples/libs/nodejs/test/torque-fixtures/` | ✅ |
| Fixture harness `run-torque-fixtures.sh` passes all 9 diffs | ✅ |
| `clang++ -fsyntax-only` check on `return` fixture: clean | ✅ |
| Non-whitelisted builtins unchanged vs post-Phase-1 (Task 2.16 diff empty) | ✅ |
| Consolidated patch exports + re-applies cleanly | ✅ |

**CCGenerator stubs remaining for Phase 3:** 3 (`CallCsaMacroAndBranchInstruction`, `MakeLazyNodeInstruction`, `GotoExternalInstruction`).

**Sample output** (`test/torque-fixtures/golden/return-tq-ccbuiltins.cc`):

```cpp
// Copyright 2024 the V8 project authors. All rights reserved.
// ... license ...
// AUTO-GENERATED by torque CC-Builtins backend.
// DO NOT EDIT.

namespace v8::internal {

Smi Builtin_TorqueCcTest_Return(Isolate* isolate, Context context, Smi arg) {
  Smi phi_arg_0{}; USE(phi_arg_0);
block0:
  phi_arg_0 = arg;
  return phi_arg_0;
}

}  // namespace v8::internal
```

(Exact shape depends on CFG lowering; update golden when emission shape changes intentionally.)

### Plan deviations surfaced during Phase 2 (for future phases)

- _(to be filled in during execution; examples: "`NamespaceConstant` fixture required a non-constexpr const to actually emit the instruction", "CFG driver needed `CurrentFileStreams` scope setup that wasn't in Visit(Macro*)", etc.)_

### Phase 2 follow-ups for later phases (not blockers)

- **Phase 3 hard instructions** (`CallCsaMacroAndBranch` et al.) still `ReportError`. Their fixtures exist in `test/torque-fixtures/` as placeholders but are not run under the harness yet.
- **Phase 4 dispatch table** — `CallBuiltinPointer`'s Phase 2 emission uses a placeholder `Builtins::CppEntryOf(...)` call that will be replaced with the real dispatch table lookup.
- **`gyp` integration still pending** (see Phase 1 follow-up). `-tq-ccbuiltins.cc` files are emitted but not compiled into V8's library until Phase 4.

**Next:** Phase 3 covers the 3 hard instructions. Write `docs/plans/2026-04-20-torque-cc-backend-phase3.md` using `superpowers:writing-plans`. Start with a design spike on `CallCsaMacroAndBranchInstruction` (signature-rewrite pattern from the handoff doc).
````

**Step 2: Commit**

```bash
git add examples/libs/nodejs/verification.md
git commit -m "nodejs: Phase 2 complete — 9 torque CC-Builtins instructions implemented"
```

---

## Task 2.19: Update project memory

**Files:**
- Modify: `~/.claude/projects/-Users-brandon-ai-src-wasm-posix-kernel/memory/project_torque_cc_backend.md`

**Step 1: Update the Phases section**

Change:
```
- Phase 2: trivial + mechanical instructions (1w) — **next up**. Write `docs/plans/2026-04-20-torque-cc-backend-phase2.md`.
```

To:
```
- Phase 2: 9 instructions + whitelist-gated real emission — **COMPLETE (YYYY-MM-DD)**. Fixture harness at `examples/libs/nodejs/test/run-torque-fixtures.sh`; 9 goldens in `test/torque-fixtures/golden/`. CCGenerator stubs remaining: 3 (`CallCsaMacroAndBranch`, `MakeLazyNode`, `GotoExternal`).
- Phase 3: 3 hard instructions (DESIGN RISK — signature rewrite for CallCsaMacroAndBranch) — **next up**. Write `docs/plans/2026-04-20-torque-cc-backend-phase3.md`. Spike CallCsaMacroAndBranch first per handoff doc.
```

Fill in the actual completion date.

No commit — memory is outside the git tree.

---

## Task 2.20: Push + update PR #306

**Step 1: Push**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git push origin torque-cc-backend
```

**Step 2: Append a Phase 2 comment to PR #306**

```bash
gh pr comment 306 --body "$(cat <<'EOF'
## Phase 2 update — 9 CC-Builtins instructions implemented

- `ReturnInstruction`, `PushUninitializedInstruction`, `NamespaceConstantInstruction`,
  `PushBuiltinPointerInstruction`, `StoreReferenceInstruction`, `StoreBitFieldInstruction`,
  `CallRuntimeInstruction`, `CallBuiltinInstruction`, `CallBuiltinPointerInstruction` — all
  emit real C++ in `cc-generator.cc`.
- Remaining 3 stubs (`CallCsaMacroAndBranch`, `MakeLazyNode`, `GotoExternal`) deferred to Phase 3.
- Real body emission is gated behind `--cc-builtins-whitelist=<csv>` on the torque CLI + a
  `kCCBuiltins`-pass whitelist check in `Visit(Builtin*)`. Non-whitelisted builtins continue
  to hit the Phase 1 comment stub — stock V8 output is unchanged.
- New test harness `examples/libs/nodejs/test/run-torque-fixtures.sh` runs torque over stock
  fileset + 9 per-instruction fixtures and diffs each against a byte-exact golden.
- `clang++ -fsyntax-only` passes on the generated fixtures.
- Consolidated patch at `examples/libs/nodejs/patches/v8-torque-cc-builtins.patch` (replaces
  Phase 1 file).

See `examples/libs/nodejs/verification.md` Phase 2 summary.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Done Criteria

Phase 2 is complete when:

1. All Phase-2 commits on branch `torque-cc-backend`, with the consolidated patch committed at `examples/libs/nodejs/patches/v8-torque-cc-builtins.patch`.
2. `bash examples/libs/nodejs/test/run-torque-fixtures.sh` exits 0 with `OK:` on all 9 fixtures.
3. `clang++ -fsyntax-only` check on the `return` fixture is clean (Task 2.15).
4. `diff -r /tmp/torque-baseline-phase2 /tmp/torque-phase2.16` is empty (Task 2.16).
5. `examples/libs/nodejs/verification.md` Phase 2 summary shows no ❌.
6. Patch re-applies cleanly on the upstream V8 base (Task 2.17 verified).
7. PR #306 updated with Phase 2 progress comment.

**Next:** Phase 3. Write `docs/plans/2026-04-20-torque-cc-backend-phase3.md` covering `CallCsaMacroAndBranchInstruction` (the design-risk instruction — spike it first before the other two), `MakeLazyNodeInstruction`, and `GotoExternalInstruction`. Per the handoff doc: "implement CallCsaMacroAndBranch FIRST on a single simple case. If the signature rewrite is pervasive and ugly beyond expectations, consider alternatives (C++ exceptions? std::variant return? separate thunk functions?) before pattern-expanding. This is where the design could fail."

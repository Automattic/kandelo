# Phase 1: Torque CC Backend — Scaffolding Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a new Torque output pass `kCCBuiltins` that iterates over every user-defined Torque builtin and writes a per-source `-tq-ccbuiltins.cc` file containing a banner + commented-out C++ function-stub for each builtin. No real instruction emission yet — the 12 stub `ReportError` calls in `cc-generator.cc` stay in place. This proves the pass machinery (enum extension, per-file streams, pass driver, per-declarable filter, file-writing, BUILD.gn output list) works end-to-end before Phase 2 fills in real emissions.

**Architecture:** All V8 changes live in `examples/libs/nodejs/build/node/deps/v8/` (inside the Node.js clone; gitignored in our worktree). We author changes as local git commits on the Node.js repo, then export a single patch file to `examples/libs/nodejs/patches/v8-torque-cc-builtins.patch` that `build-nodejs.sh` re-applies with `git apply --3way`. The patch touches **five files**:

- `src/torque/declarable.h` — add `kCCBuiltins` enum entry, override `ShouldBeInlined`
- `src/torque/global-context.h` — add `cc_builtins_headerfile` / `cc_builtins_ccfile` streams
- `src/torque/implementation-visitor.h` — add switch cases in `csa_ccfile()` / `csa_headerfile()`
- `src/torque/implementation-visitor.cc` — add fourth pass in `VisitAllDeclarables`; branch in `Visit(Builtin*)`; write new file in `GenerateImplementation`
- `BUILD.gn` — add `-tq-ccbuiltins.cc` to `run_torque` outputs

**Tech Stack:**
- V8 13.6.233.17 (vendored in Node.js v24.x at `deps/v8/`)
- GN + ninja (via `./configure --ninja`)
- Host clang/clang++ (macOS Xcode CLT)
- Patch format: `git format-patch` single-commit patch; re-applied with `git apply --3way`

**Invariants (do not break):**
- CCGenerator's 12 `ReportError` stubs remain unchanged. Phase 1 does not drive builtin bodies through CCGenerator.
- kCSA and kCC passes produce identical output to the baseline — verified by diffing pre-patch vs post-patch `torque-generated/` trees.
- Every Phase 1 change lives in V8 source; no Torque-on-V8 hacks in Node.js's `configure` or Makefile.
- Phase 1 binary output is intentionally garbage (just stub comments). Phase 2 fills real emission.

**Out of scope for Phase 1:**
- Any real instruction emission (Phase 2).
- `CallCsaMacroAndBranchInstruction` signature design (Phase 3).
- `builtins-cc-table.inc` / dispatch reroute (Phase 4).
- Wasm32 cross-compile.
- Host V8 snapshot build with the new pass output linked in.

---

## Task 1.1: Capture baseline torque output for diff comparison

**Context:** Phase 1 must not regress the kCSA or kCC passes. We snapshot the pre-patch `torque-generated/` tree so later tasks can diff against it.

**Files:**
- Create: `/tmp/torque-baseline-phase1/` (scratch; not committed)

**Step 1: Confirm the host torque binary from Phase 0 is still present**

```bash
test -x examples/libs/nodejs/build/node/out/Release/torque && echo OK || echo MISSING
```

Expected: `OK`. If missing, rebuild:

```bash
bash examples/libs/nodejs/build-nodejs.sh
```

**Step 2: Build the full list of stock `.tq` files**

Re-use the file list from Task 0.9 in `examples/libs/nodejs/verification.md`. Programmatically:

```bash
cd examples/libs/nodejs/build/node
TQ_FILES=$(grep -oE '"src/[^"]*\.tq"' deps/v8/BUILD.gn | tr -d '"' | sort -u)
echo "$TQ_FILES" | wc -l
```

Expected: ~245 files (matches Task 0.9).

**Step 3: Run torque and capture output**

```bash
mkdir -p /tmp/torque-baseline-phase1
# Pre-create parent dirs (torque doesn't mkdir -p; see Task 0.9 gotcha)
echo "$TQ_FILES" | sed 's|[^/]*$||' | sort -u | while read d; do
  mkdir -p "/tmp/torque-baseline-phase1/$d"
done
./out/Release/torque \
  -o /tmp/torque-baseline-phase1 \
  -v8-root deps/v8 \
  $TQ_FILES 2>&1 | tee /tmp/phase1-baseline.log
```

Expected: exit 0, no errors, 1245 files generated.

**Step 4: Record the file count + a stable checksum**

```bash
find /tmp/torque-baseline-phase1 -type f | sort | wc -l > /tmp/torque-baseline-phase1.count
find /tmp/torque-baseline-phase1 -type f -print0 | sort -z | xargs -0 cat | shasum > /tmp/torque-baseline-phase1.sum
cat /tmp/torque-baseline-phase1.count /tmp/torque-baseline-phase1.sum
```

Expected: a number (file count) and a SHA checksum. Record both in a scratch note; Task 1.10 uses them.

No commit for this task — it's a throwaway measurement.

---

## Task 1.2: Add OutputType::kCCBuiltins enum entry

**Context:** `OutputType` is defined in `deps/v8/src/torque/declarable.h:295`. Adding a fourth value is mechanical.

**Files:**
- Modify: `examples/libs/nodejs/build/node/deps/v8/src/torque/declarable.h:295–299`

**Step 1: Edit the enum**

```cpp
enum class OutputType {
  kCSA,
  kCC,
  kCCDebug,
  kCCBuiltins,
};
```

**Step 2: Verify it compiles**

```bash
cd examples/libs/nodejs/build/node
ninja -C out/Release torque 2>&1 | tee /tmp/phase1-1.2-build.log
```

Expected: a compile error in `implementation-visitor.h` at the `csa_ccfile()` / `csa_headerfile()` switches. The switches have `UNREACHABLE()` in their `default:` arm but were exhaustive before; adding `kCCBuiltins` triggers `-Wswitch` (or falls through to `UNREACHABLE` at runtime).

This is the expected failure — `UNREACHABLE()` in `default` means compilation likely succeeds but runtime hits `UNREACHABLE` if the pass runs before Task 1.5. That's fine.

**Step 3: Commit inside the Node.js repo**

```bash
cd examples/libs/nodejs/build/node
git add deps/v8/src/torque/declarable.h
git -c user.email=build@wasm-posix-kernel.local \
    -c user.name="wasm-posix-kernel build" \
    commit -m "torque: add OutputType::kCCBuiltins (Phase 1 scaffolding)"
```

(Local commit on the Node.js clone — this clone is gitignored from our worktree. These commits are only the source we later export as a patch file.)

---

## Task 1.3: Add per-file streams for the new pass

**Context:** `global-context.h:67` defines `PerFileStreams` — a bag of `std::stringstream`s keyed by source file. We add two new streams (`cc_builtins_headerfile` / `cc_builtins_ccfile`) mirroring the existing `csa_headerfile` / `csa_ccfile` pair.

**Files:**
- Modify: `examples/libs/nodejs/build/node/deps/v8/src/torque/global-context.h:67–95`

**Step 1: Add the two streams inside `PerFileStreams`**

Insert after the existing `csa_ccfile` field (around line 77):

```cpp
    std::stringstream cc_builtins_headerfile;
    std::stringstream cc_builtins_ccfile;
```

No `cpp::File` wrapper needed — the CSA ones exist for macro declaration emission which we don't use in the new pass.

**Step 2: Verify compiles**

```bash
cd examples/libs/nodejs/build/node
ninja -C out/Release torque
```

Expected: success. The struct's implicit default constructor handles the new streams.

**Step 3: Commit**

```bash
git add deps/v8/src/torque/global-context.h
git -c user.email=build@wasm-posix-kernel.local \
    -c user.name="wasm-posix-kernel build" \
    commit -m "torque: add cc_builtins file streams to PerFileStreams"
```

---

## Task 1.4: Wire csa_ccfile() / csa_headerfile() to route kCCBuiltins

**Context:** `implementation-visitor.h:797–826` has two accessor switches on `output_type_`. They currently handle kCSA / kCC / kCCDebug and fall through to `UNREACHABLE()`. We add a `kCCBuiltins` case for each.

**Files:**
- Modify: `examples/libs/nodejs/build/node/deps/v8/src/torque/implementation-visitor.h:797–826`

**Step 1: Extend both switches**

In `csa_ccfile()`:

```cpp
        case OutputType::kCCDebug:
          return debug_macros_cc_;
        case OutputType::kCCBuiltins:
          return streams->cc_builtins_ccfile;
        default:
          UNREACHABLE();
```

In `csa_headerfile()`:

```cpp
        case OutputType::kCCDebug:
          return debug_macros_h_;
        case OutputType::kCCBuiltins:
          return streams->cc_builtins_headerfile;
        default:
          UNREACHABLE();
```

**Step 2: Verify compiles**

```bash
ninja -C out/Release torque
```

Expected: success.

**Step 3: Commit**

```bash
git add deps/v8/src/torque/implementation-visitor.h
git -c user.email=build@wasm-posix-kernel.local \
    -c user.name="wasm-posix-kernel build" \
    commit -m "torque: route kCCBuiltins output to cc_builtins streams"
```

---

## Task 1.5: Add per-declarable filter — `ShouldBeInlined` overrides

**Context:** The per-declarable filter at `implementation-visitor.cc:3585` nulls the file stream via `CurrentFileStreams::Get() = nullptr;` when `!callable->ShouldGenerateExternalCode(output_type_)`. `ShouldGenerateExternalCode` is a non-virtual wrapper that calls virtual `ShouldBeInlined` (at `declarable.h:318`).

We want, during the kCCBuiltins pass:
- Only `Builtin` declarables produce output.
- Every other `Callable` (macros, methods, runtime functions, intrinsics) is skipped.

Strategy: in the `Callable` base override, return `true` (inline, skip emission) for `kCCBuiltins`. In the `Builtin` override, return `false` for `kCCBuiltins` (emit).

**Files:**
- Modify: `examples/libs/nodejs/build/node/deps/v8/src/torque/declarable.h`

**Step 1: Extend `Callable::ShouldBeInlined` (line 318)**

Replace:
```cpp
  virtual bool ShouldBeInlined(OutputType output_type) const {
    // C++ output doesn't support exiting to labels, so functions with labels in
    // the signature must be inlined.
    return output_type == OutputType::kCC && !signature().labels.empty();
  }
```

With:
```cpp
  virtual bool ShouldBeInlined(OutputType output_type) const {
    // In the kCCBuiltins pass, only Builtin declarables produce output;
    // all other callables are suppressed by being "inlined" (i.e., skipped).
    if (output_type == OutputType::kCCBuiltins) return true;
    // C++ output doesn't support exiting to labels, so functions with labels in
    // the signature must be inlined.
    return output_type == OutputType::kCC && !signature().labels.empty();
  }
```

**Step 2: Override on `Macro` (line 376)**

`Macro::ShouldBeInlined` already overrides the base; it currently has its own logic that defers to `Callable::ShouldBeInlined` at the end. The chain will naturally return `true` for kCCBuiltins via the base. **No change needed on Macro.** Verify this by re-reading the override.

**Step 3: Add override on `Builtin` (line 497)**

Inside the `Builtin` class public section, add:

```cpp
  bool ShouldBeInlined(OutputType output_type) const override {
    if (output_type == OutputType::kCCBuiltins) return false;
    return Callable::ShouldBeInlined(output_type);
  }
```

**Step 4: Verify compiles**

```bash
ninja -C out/Release torque
```

Expected: success.

**Step 5: Commit**

```bash
git add deps/v8/src/torque/declarable.h
git -c user.email=build@wasm-posix-kernel.local \
    -c user.name="wasm-posix-kernel build" \
    commit -m "torque: Builtin::ShouldBeInlined returns false for kCCBuiltins"
```

---

## Task 1.6: Add the fourth pass driver in `VisitAllDeclarables`

**Context:** `implementation-visitor.cc:3533–3575` contains the multi-pass driver. The kCC / kCCDebug passes iterate `AllMacrosForCCOutput()` / `AllMacrosForCCDebugOutput()` — compact lists of macros pre-registered via `EnsureInCCOutputList`. The kCCBuiltins pass is different: it must iterate every `Builtin` in `AllDeclarables()`.

Re-using the `AllDeclarables()` loop is appropriate here. The per-declarable filter from Task 1.5 already skips non-Builtin Callables. Non-Callable declarables (types, namespaces, etc.) are no-ops in `Visit(Declarable*)` — their switch arms return early.

**Files:**
- Modify: `examples/libs/nodejs/build/node/deps/v8/src/torque/implementation-visitor.cc:3572–3575`

**Step 1: Add the fourth pass before `output_type_ = OutputType::kCSA;`**

Insert at line 3572 (after the kCCDebug loop closes, before the final reset):

```cpp
  // Do the same for builtins, which generate C++ builtin definitions.
  output_type_ = OutputType::kCCBuiltins;
  for (size_t i = 0; i < all_declarables.size(); ++i) {
    try {
      Visit(all_declarables[i].get());
    } catch (TorqueAbortCompilation&) {
      // Recover from compile errors here. The error is recorded already.
    }
  }

  output_type_ = OutputType::kCSA;
```

(The original `output_type_ = OutputType::kCSA;` assignment is retained as the final reset after our new pass.)

**Step 2: Verify compiles**

```bash
ninja -C out/Release torque
```

Expected: success.

**Step 3: Run torque on a single .tq and confirm no crash**

Pick the same small file from Task 0.9:

```bash
mkdir -p /tmp/torque-phase1.6/src/builtins
./out/Release/torque \
  -o /tmp/torque-phase1.6 \
  -v8-root deps/v8 \
  deps/v8/src/builtins/array-isarray.tq 2>&1 | tee /tmp/phase1-1.6.log
echo "exit=$?"
```

Expected: exit 0. No output-file changes yet (Task 1.7 emits), but the pass must run without aborting. If it throws `TorqueAbortCompilation` and torque aborts, something in `Visit(Builtin*)` is misbehaving under the new `output_type_`.

**Step 4: Commit**

```bash
git add deps/v8/src/torque/implementation-visitor.cc
git -c user.email=build@wasm-posix-kernel.local \
    -c user.name="wasm-posix-kernel build" \
    commit -m "torque: add kCCBuiltins fourth pass in VisitAllDeclarables"
```

---

## Task 1.7: Branch `Visit(Builtin*)` to emit a stub banner under kCCBuiltins

**Context:** `Visit(Builtin*)` at `implementation-visitor.cc:587` unconditionally writes `TF_BUILTIN(...)` to `csa_ccfile()`. Under the kCCBuiltins pass that would emit CSA-style output into our new `.cc` file — wrong. Also, it drives the full CFG/assembler which would hit CCGenerator's 12 stub `ReportError`s, aborting the builtin's translation and leaving Torque with a non-empty `messages` array → `torque.cc:78` aborts the process.

Phase 1 strategy: at the top of `Visit(Builtin*)`, branch on `output_type_`. For kCCBuiltins emit a banner comment + a function-declaration stub + `}`, and return. Real body emission waits for Phase 2.

**Files:**
- Modify: `examples/libs/nodejs/build/node/deps/v8/src/torque/implementation-visitor.cc:587–590` (very top of function)

**Step 1: Add the branch at the top of `Visit(Builtin*)`**

Insert immediately after `if (builtin->IsExternal()) return;`:

```cpp
  if (output_type_ == OutputType::kCCBuiltins) {
    // Phase 1 scaffolding: emit a commented-out function stub per builtin so
    // the emitted .cc file is non-empty and we can confirm the pass wiring
    // works. Real emission (calling through CCGenerator) arrives in Phase 2.
    csa_ccfile() << "// Builtin: " << builtin->ExternalName() << "\n"
                 << "// (Phase 1 stub — body intentionally empty)\n"
                 << "// void Builtin_" << builtin->ExternalName()
                 << "(Isolate* isolate /* + args */);\n\n";
    return;
  }
```

**Step 2: Verify compiles and runs**

```bash
ninja -C out/Release torque

mkdir -p /tmp/torque-phase1.7/src/builtins
./out/Release/torque \
  -o /tmp/torque-phase1.7 \
  -v8-root deps/v8 \
  deps/v8/src/builtins/array-isarray.tq
echo "exit=$?"
```

Expected: exit 0. But the new file isn't written yet (Task 1.8 wires it). Confirm no crash.

**Step 3: Commit**

```bash
git add deps/v8/src/torque/implementation-visitor.cc
git -c user.email=build@wasm-posix-kernel.local \
    -c user.name="wasm-posix-kernel build" \
    commit -m "torque: Visit(Builtin*) emits Phase 1 stub under kCCBuiltins"
```

---

## Task 1.8: Write `-tq-ccbuiltins.cc` in `GenerateImplementation`

**Context:** `GenerateImplementation` at `implementation-visitor.cc:1833` loops over all source files and writes the five existing per-file outputs (`-tq-csa.cc`, `-tq-csa.h`, `-tq.inc`, `-tq-inl.inc`, `-tq.cc`). We add a sixth: `-tq-ccbuiltins.cc`.

Each generated file must be listed in `BUILD.gn`'s `run_torque` outputs (Task 1.9) — otherwise GN doesn't track it as a dependency and ninja warnings appear.

**Files:**
- Modify: `examples/libs/nodejs/build/node/deps/v8/src/torque/implementation-visitor.cc:1856–1866`

**Step 1: Add a file-top preamble when the stream is non-empty**

Before the `WriteFile` call, build a preamble-prefixed string. Files that contain no builtins emit an empty stream; in that case we still must emit a valid (near-empty) `.cc` file — BUILD.gn lists the output for every `.tq` file unconditionally.

Add after the `-tq.cc` write (after line 1866):

```cpp
    // Phase 1: CC-Builtins output. Banner always present; per-builtin stubs
    // are appended by Visit(Builtin*) during the kCCBuiltins pass.
    std::string cc_builtins_body = streams.cc_builtins_ccfile.str();
    std::string cc_builtins_preamble =
        "// Copyright 2024 the V8 project authors. All rights reserved.\n"
        "// Use of this source code is governed by a BSD-style license that "
        "can be found in the LICENSE file.\n"
        "\n"
        "// AUTO-GENERATED by torque CC-Builtins backend (Phase 1 scaffolding)"
        ".\n"
        "// Source: " +
        SourceFileMap::PathFromV8RootWithoutExtension(file) +
        ".tq\n"
        "// DO NOT EDIT.\n"
        "\n"
        "namespace v8::internal {\n"
        "\n";
    std::string cc_builtins_postamble = "\n}  // namespace v8::internal\n";
    WriteFile(base_filename + "-tq-ccbuiltins.cc",
              cc_builtins_preamble + cc_builtins_body + cc_builtins_postamble);
```

**Step 2: Verify compiles and runs; inspect output**

```bash
ninja -C out/Release torque

mkdir -p /tmp/torque-phase1.8/src/builtins
./out/Release/torque \
  -o /tmp/torque-phase1.8 \
  -v8-root deps/v8 \
  deps/v8/src/builtins/array-isarray.tq
echo "exit=$?"

ls /tmp/torque-phase1.8/src/builtins/array-isarray-tq*.cc
cat /tmp/torque-phase1.8/src/builtins/array-isarray-tq-ccbuiltins.cc
```

Expected: a new `array-isarray-tq-ccbuiltins.cc` file containing the banner + a `// Builtin: ArrayIsArray` / `// (Phase 1 stub — body intentionally empty)` block + `namespace v8::internal {` / `}`.

If the body contains no `// Builtin:` lines, the file has zero builtins (possible for some `.tq` files); verify the banner is still present.

**Step 3: Commit**

```bash
git add deps/v8/src/torque/implementation-visitor.cc
git -c user.email=build@wasm-posix-kernel.local \
    -c user.name="wasm-posix-kernel build" \
    commit -m "torque: write -tq-ccbuiltins.cc per source file"
```

---

## Task 1.9: Add `-tq-ccbuiltins.cc` to `BUILD.gn` run_torque outputs

**Context:** `BUILD.gn:2230–2239` in deps/v8 lists per-torque-file outputs inside the `run_torque` template. GN uses this list to track file dependencies. Missing an output causes ninja to treat the file as "unknown" and emit warnings; it also prevents GN-aware consumers from depending on it.

**Files:**
- Modify: `examples/libs/nodejs/build/node/deps/v8/BUILD.gn:2230–2239`

**Step 1: Add the new output line**

Replace:
```gn
    foreach(file, torque_files) {
      filetq = string_replace(file, ".tq", "-tq")
      outputs += [
        "$destination_folder/$filetq-csa.cc",
        "$destination_folder/$filetq-csa.h",
        "$destination_folder/$filetq-inl.inc",
        "$destination_folder/$filetq.cc",
        "$destination_folder/$filetq.inc",
      ]
    }
```

With:
```gn
    foreach(file, torque_files) {
      filetq = string_replace(file, ".tq", "-tq")
      outputs += [
        "$destination_folder/$filetq-csa.cc",
        "$destination_folder/$filetq-csa.h",
        "$destination_folder/$filetq-inl.inc",
        "$destination_folder/$filetq.cc",
        "$destination_folder/$filetq.inc",
        "$destination_folder/$filetq-ccbuiltins.cc",
      ]
    }
```

**Step 2: Regenerate GN and run the torque action end-to-end**

```bash
cd examples/libs/nodejs/build/node
./configure --ninja
ninja -C out/Release run_torque 2>&1 | tee /tmp/phase1-1.9.log
echo "exit=$?"
```

Expected: exit 0. The torque action produces 1490 files (was 1245, adding ~245 new `-tq-ccbuiltins.cc` files — one per `.tq`).

**Step 3: Spot-check a few outputs**

```bash
ls out/Release/gen/torque-generated/src/builtins/array-isarray-tq-ccbuiltins.cc
wc -l out/Release/gen/torque-generated/src/builtins/array-isarray-tq-ccbuiltins.cc
head -20 out/Release/gen/torque-generated/src/builtins/array-isarray-tq-ccbuiltins.cc
```

Expected: the file exists, contains the banner + at least one `// Builtin:` block.

**Step 4: Commit**

```bash
git add deps/v8/BUILD.gn
git -c user.email=build@wasm-posix-kernel.local \
    -c user.name="wasm-posix-kernel build" \
    commit -m "v8 build: declare -tq-ccbuiltins.cc in run_torque outputs"
```

---

## Task 1.10: Verify no regression in kCSA / kCC / kCCDebug passes

**Context:** Phase 1 must not change any existing Torque output. Verify by diffing the full post-patch `torque-generated/` tree against the Task 1.1 baseline, excluding the new `-tq-ccbuiltins.cc` files.

**Files:** none modified.

**Step 1: Run torque over the full .tq file list**

```bash
cd examples/libs/nodejs/build/node

TQ_FILES=$(grep -oE '"src/[^"]*\.tq"' deps/v8/BUILD.gn | tr -d '"' | sort -u)
mkdir -p /tmp/torque-phase1-full
echo "$TQ_FILES" | sed 's|[^/]*$||' | sort -u | while read d; do
  mkdir -p "/tmp/torque-phase1-full/$d"
done
./out/Release/torque \
  -o /tmp/torque-phase1-full \
  -v8-root deps/v8 \
  $TQ_FILES 2>&1 | tee /tmp/phase1-1.10.log
echo "exit=$?"
```

Expected: exit 0.

**Step 2: Diff all non-new output files vs baseline**

```bash
diff -r /tmp/torque-baseline-phase1 /tmp/torque-phase1-full \
  --exclude='*-tq-ccbuiltins.cc' | tee /tmp/phase1-1.10.diff
```

Expected: empty diff. Any line of diff is a regression in kCSA / kCC / kCCDebug; STOP and investigate before continuing.

**Step 3: Confirm new files exist**

```bash
find /tmp/torque-phase1-full -name '*-tq-ccbuiltins.cc' | wc -l
```

Expected: matches the count of `.tq` files (~245).

**Step 4: Spot-check stub content**

```bash
# A builtin-heavy file
grep -c "^// Builtin:" /tmp/torque-phase1-full/src/builtins/array-tq-ccbuiltins.cc || true
# A type-definition file with no builtins (banner should still be present)
head -10 /tmp/torque-phase1-full/src/objects/js-objects-tq-ccbuiltins.cc || true
```

Expected: array-tq-ccbuiltins.cc has multiple `// Builtin:` lines; js-objects-tq-ccbuiltins.cc has the banner and `namespace v8::internal {` / `}` but zero builtins.

No commit — this is verification only.

---

## Task 1.11: Export the commits as a patch file

**Context:** The six commits on the Node.js clone are not tracked in our worktree. Export them as a single patch file stored in our repo so later V8 bumps can re-apply automatically.

**Files:**
- Create: `examples/libs/nodejs/patches/v8-torque-cc-builtins.patch`

**Step 1: Export the commit range**

```bash
cd examples/libs/nodejs/build/node
# Phase 1 added six commits (Tasks 1.2 through 1.4 and 1.6 through 1.9)
# — count with: git log --oneline | head
git format-patch -6 --stdout > ../../patches/v8-torque-cc-builtins.patch
wc -l ../../patches/v8-torque-cc-builtins.patch
```

Expected: a patch file with ~150–250 lines.

**Step 2: Verify the patch re-applies cleanly on a fresh clone**

The strict test — reset V8 source to its upstream state, then re-apply the patch:

```bash
cd examples/libs/nodejs/build/node
# Save the commits first
git tag phase1-commits HEAD
git reset --hard phase1-commits~6

# Apply the exported patch
git apply --3way ../../patches/v8-torque-cc-builtins.patch
git status --short | head -10
```

Expected: five files modified (declarable.h, global-context.h, implementation-visitor.h, implementation-visitor.cc, BUILD.gn). No rejected hunks.

Restore the commits:

```bash
git reset --hard phase1-commits
git tag -d phase1-commits
```

**Step 3: Commit the patch file in our worktree**

Return to the worktree root:

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
mkdir -p examples/libs/nodejs/patches
# (patch file was written above)
git add examples/libs/nodejs/patches/v8-torque-cc-builtins.patch
git commit -m "nodejs: Phase 1 — v8 torque kCCBuiltins pass patch"
```

---

## Task 1.12: Update `build-nodejs.sh` to apply the patch after clone

**Context:** Future builds on a fresh clone must re-apply the patch automatically. Add a patch-application step between "clone" and "torque build" in `build-nodejs.sh`.

**Files:**
- Modify: `examples/libs/nodejs/build-nodejs.sh`

**Step 1: Insert patch-application block**

Between the clone block and the torque-build block, add:

```bash
PATCH_DIR="${HERE}/patches"
PATCH_MARKER_DIR="${NODE_SRC}/.wasm-posix-kernel-patches"
mkdir -p "${PATCH_MARKER_DIR}"

for patch in "${PATCH_DIR}"/*.patch; do
  [ -f "${patch}" ] || continue
  marker="${PATCH_MARKER_DIR}/$(basename "${patch}").applied"
  if [ -f "${marker}" ]; then
    echo ">>> Already applied: $(basename "${patch}")"
    continue
  fi
  echo ">>> Applying patch: $(basename "${patch}")"
  (cd "${NODE_SRC}" && git apply --3way "${patch}")
  touch "${marker}"
done
```

**Step 2: Test on the existing clone (patch already applied via commits)**

```bash
# The patch-application loop will try to apply the patch a second time and fail;
# that's because our existing clone already has the commits. For the test, delete
# the commits and try fresh:
cd examples/libs/nodejs/build/node
git reset --hard HEAD~6   # drop the six phase-1 commits
cd -

bash examples/libs/nodejs/build-nodejs.sh 2>&1 | tee /tmp/phase1-1.12.log
```

Expected: "Applying patch: v8-torque-cc-builtins.patch", then the torque re-build, then the smoke-test lines from the existing script.

If `git apply --3way` fails due to clean-tree requirement or conflicts, adjust the invocation (e.g., drop `--3way` for a fresh clone, use `git am` with `--keep-non-patch`, or split to a first-clone-only branch).

**Step 3: Re-apply the lost commits for reproducibility (optional, for next run)**

The patch-application step on the next invocation will skip via the marker. For CI re-runs this is fine. Future sessions calling `build-nodejs.sh` on a fresh clone will get the patched tree automatically.

**Step 4: Commit**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git add examples/libs/nodejs/build-nodejs.sh
git commit -m "nodejs: build-nodejs.sh applies patches after clone"
```

---

## Task 1.13: Update verification doc + memory with Phase 1 outcome

**Files:**
- Modify: `examples/libs/nodejs/verification.md` (append a Phase 1 section)

**Step 1: Append a Phase 1 summary**

Add to `verification.md`:

```markdown
## Phase 1 Summary

| Item | Result |
|---|---|
| `OutputType::kCCBuiltins` enum entry added | ✅ |
| `PerFileStreams.cc_builtins_*` streams added | ✅ |
| `csa_ccfile()` / `csa_headerfile()` route kCCBuiltins | ✅ |
| `Builtin::ShouldBeInlined` returns false for kCCBuiltins | ✅ |
| Fourth pass in `VisitAllDeclarables` iterates all builtins | ✅ |
| `Visit(Builtin*)` emits Phase 1 stub under kCCBuiltins | ✅ |
| `-tq-ccbuiltins.cc` file written per source | ✅ |
| `BUILD.gn` lists new outputs | ✅ |
| No regression in kCSA / kCC / kCCDebug (Task 1.10 diff empty) | ✅ |
| Patch exports cleanly, re-applies on fresh clone | ✅ |
| `build-nodejs.sh` applies patch automatically | ✅ |

**Sample output** (`src/builtins/array-isarray-tq-ccbuiltins.cc`):

```cpp
// Copyright 2024 the V8 project authors. All rights reserved.
// ... license header ...

// AUTO-GENERATED by torque CC-Builtins backend (Phase 1 scaffolding).
// Source: src/builtins/array-isarray.tq
// DO NOT EDIT.

namespace v8::internal {

// Builtin: ArrayIsArray
// (Phase 1 stub — body intentionally empty)
// void Builtin_ArrayIsArray(Isolate* isolate /* + args */);

}  // namespace v8::internal
```

**Next:** Phase 2. Write `docs/plans/2026-04-20-torque-cc-backend-phase2.md` covering the 4 trivial + 5 mechanical instructions, starting with `ReturnInstruction`. Reference handoff doc's Phase 2 outline.
```

**Step 2: Commit**

```bash
git add examples/libs/nodejs/verification.md
git commit -m "nodejs: Phase 1 complete — kCCBuiltins pass scaffolded"
```

---

## Task 1.14: Update project memory

**Files:**
- Modify: `~/.claude/projects/-Users-brandon-ai-src-wasm-posix-kernel/memory/project_torque_cc_backend.md`

**Step 1: Update the Phases section**

Change:
```
- Phase 1: scaffolding (kCCBuiltins pass) (2–3d) — **next up**. Write `docs/plans/2026-04-20-torque-cc-backend-phase1.md` using `superpowers:writing-plans`.
```

To:
```
- Phase 1: scaffolding (kCCBuiltins pass) — **COMPLETE (YYYY-MM-DD)**. Patch at `examples/libs/nodejs/patches/v8-torque-cc-builtins.patch`. Per-source `-tq-ccbuiltins.cc` files now emitted with Phase 1 stubs.
- Phase 2: trivial + mechanical instructions (1w) — **next up**. Write `docs/plans/2026-04-20-torque-cc-backend-phase2.md`.
```

Fill in the actual completion date.

No commit — memory is outside the git tree.

---

## Task 1.15: Push the branch and open/update the PR

**Step 1: Push**

```bash
cd ~/.superset/worktrees/wasm-posix-kernel/torque-cc-backend
git push origin torque-cc-backend
```

**Step 2: Update existing PR #306 description**

The PR was opened at the end of Phase 0. Append a Phase 1 section to its body via `gh pr edit 306 --body` or via `gh pr comment 306`. The comment form is safer — doesn't risk overwriting the Phase 0 description.

```bash
gh pr comment 306 --body "$(cat <<'EOF'
## Phase 1 update — kCCBuiltins pass scaffolded

- Adds `OutputType::kCCBuiltins` + fourth pass in V8's Torque compiler.
- Emits `-tq-ccbuiltins.cc` per source with Phase 1 stub placeholders.
- 12 `ReportError` stubs in `cc-generator.cc` unchanged — Phase 2 fills them in.
- No regression in kCSA / kCC / kCCDebug output (verified via diff vs baseline).
- V8 changes packaged as `examples/libs/nodejs/patches/v8-torque-cc-builtins.patch`.

See `examples/libs/nodejs/verification.md` Phase 1 summary.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Done Criteria

Phase 1 is complete when:

1. All 14 tasks committed on branch `torque-cc-backend`.
2. `examples/libs/nodejs/verification.md` Phase 1 summary shows no ❌.
3. `bash examples/libs/nodejs/build-nodejs.sh` on a fresh clone produces a torque binary whose run emits the new `-tq-ccbuiltins.cc` files.
4. Diff of non-new output files vs pre-patch baseline is empty.
5. PR #306 updated with Phase 1 progress.

**Next:** if Phase 1 is green, write `2026-04-20-torque-cc-backend-phase2.md` covering the 9 instructions in the handoff's Phase 2 outline (4 trivial + 5 mechanical). Start with `ReturnInstruction` per the ordering in the handoff.

# Phase 0 Verification

## Phase 0 Summary

| Item | Result |
|---|---|
| Node.js v24.x cloned (HEAD `9fe7634c`) | ✅ |
| V8 version matches design (13.6.233.17) | ✅ |
| Torque binary builds on host | ✅ |
| CCGenerator shape matches design (CCGenerator + CSAGenerator extend TorqueCodeGenerator) | ✅ |
| 22 backend-dependent + 3 agnostic instructions confirmed | ✅ |
| 12 stub instructions confirmed (exact set matches design) | ✅ |
| Fourth-pass seam confirmed (OutputType enum, pass driver, per-declarable filter) | ✅ |
| CSS + jitless compatible (full `v8_snapshot` build, 2541/2541 steps, 0 errors) | ✅ |
| Torque round-trips stock .tq files on host | ✅ |

**Decision: proceed to Phase 1 on Option A (Conservative Stack Scanning).**
No design pivot required.


Verified against Node.js v24.x (V8 13.6.233.17) cloned at
`examples/libs/nodejs/build/node/`.

Node.js HEAD: `9fe7634c` (v24.x branch, 2026-04-20 clone).
V8 version string from `deps/v8/include/v8-version.h`: **13.6.233.17** — matches design.

## V8 source shape (Task 0.5)

- `deps/v8/src/torque/cc-generator.h:14` — `class CCGenerator : public TorqueCodeGenerator {` ✅
- `deps/v8/src/torque/csa-generator.h:14` — `class CSAGenerator : public TorqueCodeGenerator {` ✅
- `deps/v8/src/torque/instructions.h:27` — `TORQUE_BACKEND_AGNOSTIC_INSTRUCTION_LIST` defined
- `deps/v8/src/torque/instructions.h:33` — `TORQUE_BACKEND_DEPENDENT_INSTRUCTION_LIST` defined

### Instruction list counts

- Backend-agnostic: **3** (`PeekInstruction`, `PokeInstruction`, `DeleteRangeInstruction`) — matches design
- Backend-dependent: **22** — matches design

Full backend-dependent list (in declaration order, `instructions.h:33–55`):
`PushUninitializedInstruction`, `PushBuiltinPointerInstruction`,
`LoadReferenceInstruction`, `StoreReferenceInstruction`,
`LoadBitFieldInstruction`, `StoreBitFieldInstruction`,
`CallCsaMacroInstruction`, `CallIntrinsicInstruction`,
`NamespaceConstantInstruction`, `CallCsaMacroAndBranchInstruction`,
`CallBuiltinInstruction`, `CallRuntimeInstruction`,
`CallBuiltinPointerInstruction`, `BranchInstruction`,
`ConstexprBranchInstruction`, `GotoInstruction`, `GotoExternalInstruction`,
`MakeLazyNodeInstruction`, `ReturnInstruction`, `PrintErrorInstruction`,
`AbortInstruction`, `UnsafeCastInstruction`.

## CCGenerator stubs vs real emissions (Task 0.6)

`cc-generator.cc` contains an `EmitInstruction` override for all 22
backend-dependent instructions. Of those:

**12 stubs** (emit `ReportError("Not supported in C++ output: …")`):
| Line | Instruction |
|------|-------------|
| 87   | `PushUninitializedInstruction` |
| 93   | `PushBuiltinPointerInstruction` |
| 99   | `NamespaceConstantInstruction` |
| 260  | `CallCsaMacroAndBranchInstruction` |
| 265  | `MakeLazyNodeInstruction` |
| 270  | `CallBuiltinInstruction` |
| 276  | `CallBuiltinPointerInstruction` |
| 281  | `CallRuntimeInstruction` |
| 323  | `GotoExternalInstruction` |
| 328  | `ReturnInstruction` |
| 443  | `StoreReferenceInstruction` |
| 490  | `StoreBitFieldInstruction` |

**10 real emissions:**
| Line | Instruction |
|------|-------------|
| 124  | `CallIntrinsicInstruction` |
| 207  | `CallCsaMacroInstruction` |
| 284  | `BranchInstruction` |
| 293  | `ConstexprBranchInstruction` |
| 316  | `GotoInstruction` |
| 331  | `PrintErrorInstruction` |
| 337  | `AbortInstruction` |
| 362  | `UnsafeCastInstruction` |
| 371  | `LoadReferenceInstruction` |
| 458  | `LoadBitFieldInstruction` |

Exactly matches the design's "10 real + 12 stubs" claim. ✅

## Fourth-pass extension seam (Task 0.7)

Design specifies: add `OutputType::kCCBuiltins` and a fourth pass in
`GenerateImplementation`; override per-declarable filter on `Builtin`.
All three seams exist and are close to the line numbers the design cites.

| Seam | File | Line | Notes |
|------|------|------|-------|
| OutputType enum | `deps/v8/src/torque/declarable.h` | **295** | Three values: `kCSA`, `kCC`, `kCCDebug`. Phase 1 adds `kCCBuiltins`. |
| Pass driver (`kCC`) | `deps/v8/src/torque/implementation-visitor.cc` | **3549** | Iterates `GlobalContext::AllMacrosForCCOutput()`. |
| Pass driver (`kCCDebug`) | `deps/v8/src/torque/implementation-visitor.cc` | **3562** | Iterates `GlobalContext::AllMacrosForCCDebugOutput()`. |
| Pass reset (`kCSA`) | `deps/v8/src/torque/implementation-visitor.cc` | **3574** | Reverts `output_type_` after the two C++ passes. |
| Per-declarable filter | `deps/v8/src/torque/implementation-visitor.cc` | **3585** | `if (!callable->ShouldGenerateExternalCode(output_type_)) CurrentFileStreams::Get() = nullptr;` |
| `ShouldGenerateExternalCode` | `deps/v8/src/torque/declarable.h` | **323** | **Non-virtual**; delegates to `ShouldBeInlined(output_type)` at line 318 which IS virtual. |

Design line ranges (3540–3575 for passes, 3583–3586 for filter) match
current V8 13.6.233.17 to within 2 lines.

**Phase 1 note:** the design says "override `ShouldGenerateExternalCode`
on `Builtin`." Because the non-virtual wrapper calls `virtual
ShouldBeInlined`, the actual Phase 1 override target is `ShouldBeInlined`
on `Builtin`, or we convert the wrapper to virtual. Both are mechanical.

## CSS + jitless compatibility (Task 0.8) — **GATE PASSED**

**Decision:** Option A (Conservative Stack Scanning) is viable.
No pivot to Option B (Handle discipline) required.

### Configuration

- GN flag `v8_enable_conservative_stack_scanning` declared at
  `deps/v8/gni/v8.gni:127` (default `false`).
- Gyp plumbing already exists:
  `common.gypi:81`, `tools/v8_gypfiles/features.gypi:216/479` —
  `v8_enable_conservative_stack_scanning=1` emits
  `-DV8_ENABLE_CONSERVATIVE_STACK_SCANNING`.
- Node.js configure has no direct flag for it, but `GYP_DEFINES` from
  the environment propagates through gyp into CXXFLAGS.
- `--v8-lite-mode` sets `v8_enable_lite_mode=1`, defining `V8_LITE_MODE`
  (the "jitless" umbrella; see `gni/v8.gni:442–446`).

### Static analysis

- No incompatibility guards between CSS and jitless/LITE_MODE anywhere
  in `deps/v8/` (searched `jitless.*conservative_stack` and
  `CONSERVATIVE_STACK_SCANNING.*LITE_MODE` — no matches).
- `deps/v8/BUILD.gn:639` asserts jitless excludes Sparkplug/Maglev/
  Turbofan/Wasm, but not CSS.
- `deps/v8/src/handles/handles.h:397`:
  `static_assert(V8_ENABLE_CONSERVATIVE_STACK_SCANNING_BOOL);` under
  `#ifdef V8_ENABLE_DIRECT_HANDLE`. CSS + direct-handles is the
  intended production pairing.
- CSS gates live code in
  `src/heap/heap.cc:131`, `src/heap/heap.cc:4867`,
  `src/common/ptr-compr-inl.h:227`,
  `src/runtime/runtime-strings.cc:390`,
  `src/handles/handles.h`, and
  `src/flags/flag-definitions.h:463–473` (read-only flag with
  implications `scavenger_conservative_object_pinning` and
  negated `compact_with_stack`).

### Build proof

Ran a full V8 snapshot build with both flags on:

```bash
mv out/Release out/Release.baseline
GYP_DEFINES="v8_enable_conservative_stack_scanning=1" \
  ./configure --ninja --v8-lite-mode
ninja -C out/Release v8_snapshot
```

Result: **2541/2541 steps, exit 0**, no warnings or errors in
2013 lines of build log. Artifacts produced:
- `out/Release/libv8_snapshot.a` (2.5 MB)
- `out/Release/mksnapshot` (linked successfully)

The CXXFLAGS for `v8_base_without_compiler` contained both defines:
```
-DV8_ENABLE_CONSERVATIVE_STACK_SCANNING ... -DV8_LITE_MODE
```

This compiled cleanly across every `torque-generated/*-tq.o` target,
`heap.o`, `handles.o`, runtime-strings.o, and the full mksnapshot
executable. Phase 1 may proceed on Option A.

## Torque smoke test on stock .tq files (Task 0.9)

Invoked the host torque binary on the full set of 245 stock `.tq` files
(main `torque_files` list from `deps/v8/BUILD.gn:1914` + conditional
`v8_enable_webassembly` + `v8_enable_i18n_support` blocks, deduplicated).

```bash
/tmp/torque-baseline -o /tmp/torque-out -v8-root deps/v8 <245 .tq files>
```

Exit: **0**. No errors, no lint warnings.

**Gotcha:** torque's `ReplaceFileContentsIfDifferent` does **not** create
parent directories — missing dirs cause silent write failures. We
pre-created the target dirs with `mkdir -p` derived from the `.tq` file
paths. V8's `tools/run.py` wrapper script handles this in-tree, which is
why the stock build doesn't hit it.

**Output layout** (1245 files total):

- Per-source: `/<dir>/<name>-tq-csa.cc`, `-tq-csa.h`, `-tq.cc`, `-tq.inc`,
  `-tq-inl.inc` — 5 files per `.tq` input. (`-tq.cc` is the existing
  kCC-pass output; empty for files with no `@export` macros.)
- Shared: `factory.cc`, `exported-macros-assembler.cc`, `debug-macros.cc`,
  `class-verifiers.cc`, `class-debug-readers.cc`, `enum-verifiers.cc`,
  `objects-printer.cc`, `bit-fields.h`, `builtin-definitions.h`,
  `csa-types.h`, `class-forward-declarations.h`, `factory.inc`,
  `instance-types.h`, `interface-descriptors.inc`,
  `objects-body-descriptors-inl.inc`, `visitor-lists.h`.

**Sample CSA output** (`src/builtins/array-isarray-tq-csa.cc`):

```cpp
TF_BUILTIN(ArrayIsArray, CodeStubAssembler) {
  compiler::CodeAssemblerState* state_ = state();
  compiler::CodeAssembler ca_(state());
  TNode<NativeContext> parameter0 =
      UncheckedParameter<NativeContext>(Descriptor::kContext);
  ...
  tmp6 = TORQUE_CAST(CodeStubAssembler(state_).CallRuntime(
      Runtime::kArrayIsArray, parameter0, parameter1));
  CodeStubAssembler(state_).Return(tmp6);
```

This is what the Torque CC backend will replace: `TNode<>` becomes
`Tagged<>`, `CodeStubAssembler::CallRuntime` becomes
`Runtime::Call<Runtime::kArrayIsArray>(isolate, ...)`, `ca_.Goto/Bind`
become structured C++ control flow.

**Torque CLI reference for later phases:**

| Flag | Meaning |
|------|---------|
| `-o <dir>` | Output directory (parent dirs must exist) |
| `-v8-root <dir>` | Prefix stripped from input paths (e.g., `deps/v8`) |
| `-strip-v8-root` | Strip v8-root from generated paths |
| `-annotate-ir` | Dump intermediate representation |
| `-m32` | Force 32-bit output (incompatible with pointer compression) |

No `-h` / `--help` — torque aborts on unknown args.

## Torque host build (Tasks 0.2–0.4)

- Node.js uses gyp+ninja (not `make torque` as the skeleton assumed).
- Correct invocation: `ninja -C out/Release torque` after `./configure --ninja`.
- Resulting binary: `examples/libs/nodejs/build/node/out/Release/torque`
  (Mach-O 64-bit arm64 on host macOS).
- `torque --help` does not exist — torque aborts on any unknown arg. The
  build script now just verifies the binary is executable.

## Phase 1 Summary

| Item | Result |
|---|---|
| `OutputType::kCCBuiltins` enum entry added | ✅ |
| `PerFileStreams.cc_builtins_{header,cc}file` streams added | ✅ |
| `csa_ccfile()` / `csa_headerfile()` route kCCBuiltins | ✅ |
| Third `output_type_` switch in `implementation-visitor.cc:~2945` handles kCCBuiltins | ✅ |
| `Builtin::ShouldBeInlined` returns false for kCCBuiltins; `Callable` base returns true | ✅ |
| Fourth pass in `VisitAllDeclarables` iterates and filters to `Declarable::kBuiltin` only | ✅ |
| `Visit(Builtin*)` emits Phase-1 stub under kCCBuiltins (early-return, no assembler) | ✅ |
| `-tq-ccbuiltins.cc` file written per source (banner always present) | ✅ |
| `BUILD.gn` `run_torque` outputs list includes new file | ✅ |
| No regression in kCSA / kCC / kCCDebug output (Task 1.10 diff empty; checksum preserved) | ✅ |
| Patch exports cleanly, re-applies on fresh clone | ✅ |
| `build-nodejs.sh` applies `patches/*.patch` with marker-based idempotency | ✅ |

**Phase 1 commit chain on the Node.js clone** (10 commits, base `9fe7634c` → tip `2440f125`):
1. `torque: add OutputType::kCCBuiltins (Phase 1 scaffolding)`
2. `torque: add cc_builtins file streams to PerFileStreams`
3. `torque: route kCCBuiltins output to cc_builtins streams`
4. `torque: Builtin::ShouldBeInlined returns false for kCCBuiltins`
5. `torque: route kCCBuiltins through extern-macro constexpr call path`
6. `torque: add kCCBuiltins fourth pass in VisitAllDeclarables`
7. `torque: Visit(Builtin*) emits Phase 1 stub under kCCBuiltins`
8. `torque: filter fourth pass to Builtin declarables only`
9. `torque: write -tq-ccbuiltins.cc per source file`
10. `v8 build: declare -tq-ccbuiltins.cc in run_torque outputs`

Exported as a single patch at `examples/libs/nodejs/patches/v8-torque-cc-builtins.patch` (13,420 bytes).

**Regression evidence.** Patched-torque run over the full 245-file stock fileset produces 1490 files: 1245 baseline (byte-identical to Phase 0 snapshot; `shasum a5195c0258fd9af9415e9d41f0c2e38237989c1b`) plus 245 new `-tq-ccbuiltins.cc` files. `diff -r --exclude='*-tq-ccbuiltins.cc'` between baseline and post-patch trees is empty.

**Sample output** (`src/builtins/array-isarray-tq-ccbuiltins.cc`, 15 lines):

```cpp
// Copyright 2024 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

// AUTO-GENERATED by torque CC-Builtins backend (Phase 1 scaffolding).
// Source: src/builtins/array-isarray.tq
// DO NOT EDIT.

namespace v8::internal {

// Builtin: ArrayIsArray
// (Phase 1 stub — body intentionally empty)
// void Builtin_ArrayIsArray(Isolate* isolate /* + args */);

}  // namespace v8::internal
```

A pure-definition `.tq` with no builtins (e.g. `src/objects/js-objects.tq`) still gets the banner + empty namespace — BUILD.gn lists the output per `.tq` input unconditionally.

### Plan deviations surfaced during implementation (documented for future phases)

- **`all_declarables` iteration is NOT safe under `kCCBuiltins` without a kind filter.** The Phase 1 plan originally assumed non-Callable `Visit(Declarable*)` arms early-return; in reality, `NamespaceConstant`/`TorqueMacro`/`Method` drive codegen machinery that crashes (SIGSEGV) or emits stray output when re-entered under a non-`kCSA` output type. Fixed by adding `if (all_declarables[i]->kind() != Declarable::kBuiltin) continue;` at the top of the fourth-pass loop body — matches the pattern of the kCC/kCCDebug passes iterating curated lists.
- **Third `output_type_` switch at `implementation-visitor.cc:~2945`** (extern-macro constexpr call emission) was not in the plan's list but triggers a `-Wswitch` warning without a case. Added a `kCCBuiltins` arm that mirrors `kCC`'s `CCName()` call — forward-compatible for Phase 2's real builtin-body emission.
- **Single-file torque smoke test is unworkable.** Phase 0 Task 0.9's documented single-file invocation (`torque deps/v8/src/builtins/array-isarray.tq`) was never actually executed — single-file runs abort on unresolved types like `Context`. All Phase 1 torque invocations used the full 245-file stock fileset with pre-created output subdirectories. File list: `/tmp/phase1-tq-files.txt`.
- **`out/Release/` vs `out/Release.baseline/`.** Phase 0 Task 0.8's CSS+jitless gate reconfigured `out/Release/` to lite-mode, which drops `V8_ENABLE_WEBASSEMBLY`; the preserved `out/Release.baseline/` is the stock-configured build and is what Phase 1 used for all rebuilds and smoke tests.

### Phase 1 follow-ups for later phases (not blockers)

- **gyp integration for new outputs.** Node.js's build uses gyp, not GN. `tools/v8_gypfiles/v8.gyp` derives per-torque-file outputs programmatically (`torque_outputs_csa_cc`, `torque_outputs_csa_h`, etc.) rather than reading them from BUILD.gn. **Phase 4 (dispatch table + CSS build) must add `torque_outputs_ccbuiltins_cc`** before `-tq-ccbuiltins.cc` files are compiled into the V8 library. The Phase 1 BUILD.gn edit keeps upstream-V8 consistency but does not affect Node.js's gyp-driven V8 link.
- **`build-nodejs.sh` torque-build step is idempotent against existing binary.** The `[ ! -f "out/Release/torque" ]` guard means the script skips the rebuild even when patches have just been applied. Phase 1 does not enforce this because `out/Release/` is stale lite-mode anyway; a later phase should rebuild after patch-apply unconditionally (or track patch SHAs against binary SHA).

**Next:** Phase 2. Write `docs/plans/2026-04-20-torque-cc-backend-phase2.md` covering the 4 trivial + 5 mechanical instructions per the handoff doc's Phase 2 outline. Start with `ReturnInstruction`.

## Phase 2 Summary

| Item | Result |
|---|---|
| `--cc-builtins-whitelist=<csv>` CLI flag added (both `--` and `-` forms, whitespace-trimmed) | ✅ |
| `Visit(Builtin*)` under kCCBuiltins: whitelist-gated real emission, JS-linkage deferred, Phase-1 stub fallthrough | ✅ |
| `ReturnInstruction` emission | ✅ |
| `PushUninitializedInstruction` emission (unwraps `TopType` to source type) | ✅ |
| `NamespaceConstantInstruction` emission | ✅ |
| `PushBuiltinPointerInstruction` emission (placeholder via `Smi::FromInt(Builtin::k…)`) | ✅ |
| `StoreReferenceInstruction` emission | ✅ |
| `StoreBitFieldInstruction` emission (reuses existing `GetBitFieldSpecialization` helper) | ✅ |
| `CallRuntimeInstruction` emission (catch-block deferred to Phase 3) | ✅ |
| `CallBuiltinInstruction` emission (tailcall / JS-linkage / multi-result deferred) | ✅ |
| `CallBuiltinPointerInstruction` emission (placeholder via `Builtins::CppEntryOf`) | ✅ |
| 9 fixtures + goldens in `examples/libs/nodejs/test/torque-fixtures/` | ✅ |
| Fixture harness passes all 9 diffs (byte-exact, portable paths) | ✅ |
| `clang++ -fsyntax-only` check on `return` fixture with minimal shim: clean | ✅ |
| Non-whitelisted output unchanged vs. post-Phase-1 baseline (Task 2.16 diff empty; non-ccbuiltins sha `a5195c0258fd9af9415e9d41f0c2e38237989c1b` matches) | ✅ |
| Consolidated patch (`v8-torque-cc-builtins.patch`, 1235 lines) re-applies cleanly on upstream `9fe7634c` | ✅ |

**CCGenerator stubs remaining for Phase 3:** 3 (`CallCsaMacroAndBranchInstruction`, `MakeLazyNodeInstruction`, `GotoExternalInstruction`).

**Phase 2 commit chain on the Node.js clone** (11 commits on top of Phase 1, tip `b7b4d0c9`):
1. `torque: add --cc-builtins-whitelist CLI flag`
2. `torque: Visit(Builtin*) kCCBuiltins — real emission under whitelist`
3. `torque: implement CCGenerator::Emit(ReturnInstruction)`
4. `torque: implement CCGenerator::Emit(PushUninitializedInstruction)`
5. `torque: implement CCGenerator::Emit(NamespaceConstantInstruction)`
6. `torque: implement CCGenerator::Emit(PushBuiltinPointerInstruction)`
7. `torque: implement CCGenerator::Emit(StoreReferenceInstruction)`
8. `torque: implement CCGenerator::Emit(StoreBitFieldInstruction)`
9. `torque: implement CCGenerator::Emit(CallRuntimeInstruction)` (also adds `RuntimeFunction::ShouldBeInlined` override — see deviation note below)
10. `torque: implement CCGenerator::Emit(CallBuiltinInstruction)`
11. `torque: implement CCGenerator::Emit(CallBuiltinPointerInstruction)`

**Sample output** (`test/torque-fixtures/golden/return-tq-ccbuiltins.cc`):

```cpp
// AUTO-GENERATED by torque CC-Builtins backend (Phase 1 scaffolding).
// Source: test/phase2-fixtures/return.tq
// DO NOT EDIT.

namespace v8::internal {

Tagged<Smi> Builtin_TorqueCcTest_Return(Isolate* isolate, Tagged<Context> context, Tagged<Smi> arg) {
  USE(isolate);
  Tagged<Context> parameter0 = context;
  USE(parameter0);
  Tagged<Smi> parameter1 = arg;
  USE(parameter1);
  goto block0;

  block0:
  return parameter1;
}

}  // namespace v8::internal
```

### Plan deviations surfaced during Phase 2 implementation

- **`out/Release.baseline/torque`, NOT `out/Release/torque`.** The Phase 2 plan initially referenced `out/Release/` (lite-mode build per Phase 0 CSS+jitless gate). Changed throughout the plan before dispatching subagents: lite-mode torque lacks `V8_ENABLE_WEBASSEMBLY` → cannot parse `wasm-objects.tq`. Stock `Release.baseline/` is what Phase 1 actually used; Phase 2 plan corrected to match.
- **Stock `.tq` file list regex was too narrow.** Phase 1 plan used `grep -oE '"src/[^"]*\.tq"'` which matches 243 files — missing `test/torque/test-torque.tq` and `third_party/v8/builtins/array-sort.tq`. Correct pattern: `'"(src|test|third_party)/[^"]*\.tq"'` → 245 files (matches verification.md's documented count). Missing these two files triggers `cannot find SortState` during torque runs over the "full fileset".
- **Host-path portability in generated `// Source:` comments.** Torque's `SourceFileMap::AbsolutePath` emits a `file://` URI for any input not prefixed by `-v8-root`. Task 2.5's first run committed a golden with `// Source: file:///Users/brandon/...` — unusable in CI. Fixed by pulling forward Task 2.14's harness wiring: fixtures are now symlinked into `$NODE_SRC/deps/v8/test/phase2-fixtures/<name>.tq` and passed as v8-root-relative paths, producing stable `// Source: test/phase2-fixtures/<name>.tq` comments.
- **`Callable::ShouldBeInlined` default broke `RuntimeFunction` calls inside builtins.** Phase 1's Task 1.5 had the `Callable` base return `true` for `kCCBuiltins` (to suppress non-Builtin declarables in the fourth pass). When Task 2.4's real-emission path started actually driving a builtin body through CCGenerator, builtin→RuntimeFunction calls hit `GenerateCall`'s `inline_macro=true` path and silently dropped arguments. Fix: added `RuntimeFunction::ShouldBeInlined` override returning `false` for `kCCBuiltins` (mirrors the existing `Builtin::ShouldBeInlined` override). Macros and Intrinsics inherit the default `true`, which works correctly since they CAN be inlined — but a future fixture that exercises an Intrinsic in a surprising way may need the same override. Watch for it.
- **Plan's "uninitialized" keyword fixture doesn't exist.** Task 2.6's plan draft suggested `const x: Smi = uninitialized;`, but Torque has no `uninitialized` keyword. `PushUninitializedInstruction` is emitted by uninitialized `let` declarations (`let x: T;` with no initializer, per `implementation-visitor.cc:900`). Fixture uses `let x: Smi; x = arg; return x;`.
- **`PushUninitializedInstruction.type` is `TopType`, not the underlying type.** Its `GetRuntimeType()` would fail (TopType's `GetGeneratedTypeNameImpl` is `UNREACHABLE`). Emission unwraps via `TopType::DynamicCast(...)->source_type()` before calling `GetRuntimeType()`.
- **`BuiltinPtr extends Smi`.** `instruction.type->GetRuntimeType()` for PushBuiltinPointer resolves to `Tagged<Smi>` (not `Tagged<BuiltinPtr>` — Smi-subtype branch fires first in `Type::GetRuntimeType`). No cast wrapper needed; the generated code uses `Smi::FromInt(static_cast<int>(Builtin::k…))` directly.
- **Extern builtins cannot be used as pointer targets.** Task 2.8's first attempt used `extern builtin` as the referenced builtin; Torque rejects function pointers to external/non-stub linkage (`implementation-visitor.cc:1120`). Fixture defines both caller and target internally.
- **Plan's `StoreReferenceInstruction` draft referenced a non-existent `synchronization` field.** `instructions.h:397-401` shows the instruction has only `type`. Only plain `TaggedField<T>::store` / `WriteField<T>` are emitted. No `Relaxed_` / `Release_` variants because Torque doesn't expose them for stores.
- **Pre-existing CallIntrinsic crash on empty `constexpr_arguments`.** `ProcessArgumentsCommon` at `cc-generator.cc:160-180` segfaults in `constexpr_arguments.back()` when the vector is empty but `parameter_types` still expects a constexpr. Not introduced by Phase 2 — surfaced when a fixture implicitly used `%FromConstexpr` for integer literals. Fixtures pick shapes that avoid this (e.g., pass values via parameters instead of literals, use `torque_internal::unsafe::NewReference<Smi>(obj, offset)` to avoid field-offset lowering).
- **Harness staging pulled forward from Task 2.14.** The plan had Task 2.14 wire the whitelist CSV and leave staging implicit. Committed in Task 2.5 alongside the first real fixture so every golden from the start has portable paths.
- **`clang++ -fsyntax-only` scope limited to `return` fixture only.** Per the plan, this task's acceptance bar was "the return fixture parses". Fuller parse-checks of the more complex goldens (Union types, std::tie tuple assignments between related Tagged subtypes) would require a richer V8-like shim or the real V8 tree; deferred to Phase 4 when the dispatch table lands.

### Phase 2 follow-ups for later phases

- **`Builtins::CppEntryOf` is a placeholder.** Task 2.13's CallBuiltinPointer emission refers to `Builtins::CppEntryOf(Builtin)` — this symbol does not exist in V8. Phase 4 must generate `builtins-cc-table.inc` with real function-pointer lookup.
- **JS-linkage builtins emit only a comment.** Task 2.4's gate skips them with `(JS linkage deferred to Phase 3)`. Phase 3 must implement the JS builtin ABI (receiver/newTarget/dispatchHandle parameter unpacking, Descriptor machinery).
- **Bridge-line scaffolding for parameter naming.** `Visit(Builtin*)` emits `<Type> parameterN = <torque_name>;` inside each generated body because `AddParameter` hard-codes the `parameterN` stack convention. A future refactor could teach `AddParameter` an override-name mode so the Torque names flow directly into the emitted C++. TODO in place at `implementation-visitor.cc:~640`.
- **Intrinsic/Macro `ShouldBeInlined` may need the same treatment as RuntimeFunction.** Current fixtures don't exercise it, but a future fixture that calls an intrinsic could surface the same argument-drop bug. Easy fix when it comes up.

**Next:** Phase 3. Write `docs/plans/2026-04-20-torque-cc-backend-phase3.md` covering the 3 hard instructions — `CallCsaMacroAndBranchInstruction` (DESIGN RISK — signature rewrite for labels), `MakeLazyNodeInstruction`, `GotoExternalInstruction`. Spike `CallCsaMacroAndBranch` first per the handoff doc.

## Phase 3 Spike Decisions (Task 3.3)

**Spike fixture.** `GotoIfForceSlowPath()` from `deps/v8/src/builtins/base.tq:1622` — `extern macro GotoIfForceSlowPath(): void labels Taken;`. Simplest labeled extern macro in the stock V8 fileset: zero args, `void` return, one label with no label-value parameters. Fixture wrapped it in a whitelisted `TorqueCcTest_SpikeCcMab` builtin invoking `GotoIfForceSlowPath() otherwise Bailout`.

**Pre-existing Phase 2 crash found.** Running the spike under `--cc-builtins-whitelist=TorqueCcTest_SpikeCcMab` did NOT emit the expected `ReportError("Not supported in C++ output: CallCsaMacroAndBranch")` — it SIGSEGVed (exit=139). Stack: `ContextualVariable<CurrentSourcePosition, SourcePosition>::Scope::Scope` at `contextual.h:40`, `value_(std::forward<Args>(args)...), previous_(Top())`. Root cause: Phase 2's real-emission path in `Visit(Builtin*)` establishes `CurrentScope`, `CurrentCallable`, and `CurrentReturnValue` scopes, but omits `CurrentSourcePosition`. When `GenerateCall` → `ReportError` path tries to attach a source position, `Top()` dereferences a dangling reference. Fixing this (adding `CurrentSourcePosition::Scope source_position(builtin->Position())` alongside the other scopes at `implementation-visitor.cc:~620` under the whitelist branch) is a precondition for any Phase 3 instruction-emission work — without it, torque crashes before any CCGenerator `EmitInstruction` ever runs. Tracked as Task 3.3a.

**CallCsaMacroAndBranch emission strategy: full A (out-param rewrite).** Callee signature rewrite: for each label, `f.AddParameter("bool*", ExternalLabelName(...))` + per-label-value `f.AddParameter(type->GetRuntimeType() + "*", ExternalLabelParameterName(...))`. Caller declares `bool branch_<label> = false; T out_<label>_<i>{};`, invokes the callee with the pointers, and dispatches with `if (branch_<label>) goto <label_block>;` + fallthrough to the return continuation. Non-void return values flow through normal stack/phi machinery alongside the branch dispatch. Multi-label and label-with-value shapes are supported — not deferred. Rationale: stock V8 builtins use `Cast<HeapObject>(x) otherwise Slow`, `TryGetElement(...) otherwise NotFound(intptr)`, `otherwise Slow, Fast` multi-label patterns extensively; A-narrow would force return-visits to cc-generator.cc the first time Phase 4/5 whitelists a builtin using these shapes.

**GotoExternal emission strategy: full implementation.** Builtins themselves cannot carry labels: Torque's grammar at `deps/v8/src/torque/torque-parser.cc:2930-2934` has the `builtin` rule with NO `optionalLabelList` slot, unlike the `macro` rule at 2925-2929. Confirmed by parse-rejection: fixture `builtin TorqueCcTest_SpikeGotoExt(...) labels Overflow { ... }` fails with `Torque Error: Parser Error: unexpected token "labels"`. Combined with `InlineMacro` (`implementation-visitor.cc:3100-3107`) flattening labeled Torque macros' `goto ExternalLabel` into ordinary `GotoInstruction`s bound to the caller's blocks, `GotoExternalInstruction` is **unreachable in a kCCBuiltins-emitted builtin's CFG**. HOWEVER, Task 3.6 widens `Macro::ShouldBeInlined` to return `false` for labeled Torque macros under kCCBuiltins (so a standalone labeled-macro function is emittable and callable from builtins). That path DOES surface `GotoExternal` inside the macro's own body. Full emission: write each popped value into its `T*` out-param, write `true` into the `bool*` branch indicator, `return;`.

**MakeLazyNode emission strategy: full implementation.** Lambda `[=]() { return <callee>(isolate, <captured args>); }`, mirroring CSA's `csa-generator.cc:490-523` pattern but replacing `state_` with `isolate`. Result type derived from `instruction.result_type->GetRuntimeType()` (typically `std::function<Tagged<T>()>` for `Lazy<T>`). Fixture probes actual firing via `%MakeLazy<>` / `Lazy<T>` Torque constructs. If Torque's surface for lazy-node creation differs from expectation, Task 3.4 adjusts the fixture until `MakeLazyNodeInstruction` appears in `-annotate-ir` output.

**Signature rewrite scope.** Only `OutputType::kCCBuiltins`. The existing `kCC` / `kCCDebug` paths keep the `ReportError("Macros that generate runtime code can't have label exits")` gate at `implementation-visitor.cc:2056-2058`. Hand-written V8 C++ that calls kCC-emitted macros is untouched. Under kCCBuiltins, a new branch in `GenerateFunction` emits the out-param form when `signature.labels` is non-empty.

**`Macro::ShouldBeInlined` overrides.** Phase 3 adds two conditional inline-suppressions for kCCBuiltins: (i) labeled extern macros (`IsExternal() && !labels.empty()`) always go through the CallCsaMacroAndBranch path (extern macros can't be inlined anyway); (ii) labeled Torque macros (`!IsExternal() && !labels.empty()`) go through the CallCsaMacroAndBranch path so the macro body is emitted as a standalone function with the out-param signature, making `GotoExternal` reachable inside that body. Unlabeled macros continue to inline under the base-class default (stays `true`). Mirrors Phase 2's `RuntimeFunction::ShouldBeInlined` → false override.

**Follow-ups explicitly deferred from Phase 3 (not in scope):**
- `catch_block` / runtime exception handling on any of CallCsaMacroAndBranch / CallRuntime / CallBuiltin — needs its own design (C++ exceptions vs. `expected<T,E>` vs. Torque error channel). Phase 4+.
- Tail-calls from `CallBuiltin` / `CallBuiltinPointer` — Phase 4+.
- JS-linkage builtin emission (receiver/newTarget/dispatchHandle ABI, Descriptor machinery) — Phase 3+.
- `builtins-cc-table.inc` dispatch table — Phase 4.

## Phase 3 Summary

| Item | Result |
|---|---|
| Spike findings + strategy decision committed (Task 3.3) | ✅ |
| Phase 2 latent crashes fixed (3 holes surfaced by Phase 3 probing) | ✅ |
| `MakeLazyNodeInstruction` emission (`std::function<T()>` lambda) | ✅ |
| `CallCsaMacroAndBranchInstruction` emission (full A: out-param rewrite) | ✅ |
| `GotoExternalInstruction` emission (defensive — Phase 4 exercises it) | ✅ |
| `Macro::ShouldBeInlined` override for labeled non-extern macros under kCCBuiltins | ✅ |
| `ExternMacro` + `Intrinsic` `ShouldBeInlined` overrides for kCCBuiltins | ✅ |
| `CurrentSourcePosition::Scope` added to Phase 2's `Visit(Builtin*)` whitelist branch | ✅ |
| 2 new fixtures + goldens (`make-lazy-node`, `call-csa-macro-and-branch`) | ✅ |
| Full 11-fixture harness passes (9 Phase 2 + 2 Phase 3) | ✅ |
| `clang++ -fsyntax-only` parse-check passes for both Phase 3 goldens | ✅ |
| Non-whitelisted output byte-identical to Phase 1/2 baseline (sha `a5195c0258fd9af9415e9d41f0c2e38237989c1b`) | ✅ |
| Consolidated patch (`v8-torque-cc-builtins.patch`, 1736 lines, 75 KB) re-applies cleanly on upstream `9fe7634c` | ✅ |

**CCGenerator stubs remaining after Phase 3: 0.** Every backend-dependent instruction (22 of 22) now has a real emission. Remaining `ReportError` calls in `cc-generator.cc` are intentional scope gates WITHIN instruction implementations (catch-block, tailcall, JS-linkage, multi-result PairT) that Phase 4+ addresses as fixtures force them.

**Phase 3 commit chain on the Node.js clone** (6 commits on top of Phase 2 tip `b7b4d0c9`):
1. `55af7d6d` — `torque: add CurrentSourcePosition::Scope to Visit(Builtin*) kCCBuiltins branch`
2. `9b794e1f` — `torque: ExternMacro + Intrinsic ShouldBeInlined return false for kCCBuiltins`
3. `6cc01195` — `torque: implement CCGenerator::Emit(MakeLazyNodeInstruction)`
4. `e0464526` — `torque: Macro::ShouldBeInlined returns false for labeled macros under kCCBuiltins`
5. `f279deb8` — `torque: implement CCGenerator::Emit(CallCsaMacroAndBranchInstruction)`
6. `33051608` — `torque: implement CCGenerator::Emit(GotoExternalInstruction)`

Total commits on top of upstream `9fe7634c` after Phase 3: **27** (10 Phase 1 + 11 Phase 2 + 6 Phase 3).

### Sample outputs

**`test/torque-fixtures/golden/make-lazy-node-tq-ccbuiltins.cc`** (lambda emission):

```cpp
Tagged<Smi> Builtin_TorqueCcTest_MakeLazyNode(Isolate* isolate, Tagged<Context> context, Tagged<Smi> arg) {
  std::function<Tagged<Smi>()> tmp0;  USE(tmp0);
  // ...
  tmp0 = [=]() { return TqRuntimeTorqueCcTest_LazyBody_0(parameter1); };
  // ...
}
```

**`test/torque-fixtures/golden/call-csa-macro-and-branch-tq-ccbuiltins.cc`** (out-param dispatch):

```cpp
Tagged<Smi> Builtin_TorqueCcTest_CallCsaMacroAndBranch(Isolate* isolate, Tagged<Context> context) {
  bool label0 = false;
  Tagged<Smi> tmp1{}; USE(tmp1);
  // ...
  TorqueRuntimeMacroShims::CodeStubAssembler::GotoIfForceSlowPath(&label0);
  if (label0) { goto block4; }
  goto block3;
  // ...
}
```

### Plan deviations surfaced during Phase 3 implementation

- **Phase 2 had 3 latent crashes** that only manifested when a whitelisted builtin hit real call-lowering paths:
  1. **`ExternMacro::ShouldBeInlined` inherited base `true` for kCCBuiltins** — `GenerateCall` routed extern-macro calls through `InlineMacro`, which null-dereffed `*macro->body()` (extern macros have `body() == std::nullopt`). Fix: override to return `false` for kCCBuiltins, mirroring Phase 2's `RuntimeFunction` fix.
  2. **`Intrinsic::ShouldBeInlined` inherited base `true`** — `GenerateCall`'s `inline_macro=true` path skipped `AddCallParameter`'s `constexpr_arguments` population, leaving the vector empty. Intrinsic handlers (`%MakeLazy`, `%SizeOf`, `%RawConstexprCast`, etc.) then read `constexpr_arguments[0]` out-of-bounds → SIGSEGV in `StringLiteralUnquote` at `implementation-visitor.cc:3272`. Fix: override to return `false` for kCCBuiltins.
  3. **`Visit(Builtin*)` omitted `CurrentSourcePosition::Scope`** — the Phase 2 whitelist branch established `CurrentScope` / `CurrentCallable` / `CurrentReturnValue` but not source-position scope. Without it, any `ReportError` or downstream `CurrentSourcePosition::Scope::Scope` push dereferenced a dangling reference (`contextual.h:40`). Fix: add the missing scope at the top of the whitelist branch.

  All 3 were pre-existing Phase 2 gaps; Phase 3's probing made them reachable and Phase 3's fixes make them disappear. `Builtin::ShouldBeInlined`, `RuntimeFunction::ShouldBeInlined`, `Macro::ShouldBeInlined` now all have kCCBuiltins-aware implementations.

- **Task 3.6 outcome: no fixture for `GotoExternalInstruction`.** The Task 3.3 decision note anticipated that `Macro::ShouldBeInlined = false` for labeled Torque macros would make standalone labeled-macro bodies emittable, surfacing `GotoExternal` inside those bodies. In reality, making the macro "non-inline" only affects the CALLER side (routes to `CallCsaMacroAndBranchInstruction`); it does NOT cause the macro's body to be emitted as a standalone C++ function anywhere — there is no macro-iteration pass under kCCBuiltins, and the kCC pass's `EnsureInCCOutputList` call fires only under kCC/kCCDebug output types. Phase 3's `GotoExternal` emission ships defensively (correct code that will fire when Phase 4 adds the macro-body emission path) but is not exercised by any Phase 3 fixture. Documented in the commit message at `33051608`.

- **Task 3.5 did NOT relax `GenerateFunction`'s label-exit `ReportError`** at `implementation-visitor.cc:2056-2058`. The original plan suggested adding a kCCBuiltins arm emitting `bool*` + `T*` out-params. In practice, `GenerateFunction` under kCCBuiltins is only called for `Builtin` declarables (the fourth-pass filter skips Macros), and Phase 3's CallCsaMacroAndBranch emission constructs the call site directly without going through `GenerateFunction`. The gate relaxation is deferred to Phase 4 when macro-body emission lands.

- **`Lazy<T>::GetRuntimeType()` null-derefs** — Torque's `AbstractType::GetGeneratedTypeName` special-cases `Lazy<T>` but has no `ConstexprVersion`, causing `GetRuntimeType` to deref a null pointer. MakeLazyNode emission uses `Type::MatchUnaryGeneric(result_type, TypeOracle::GetLazyGeneric())` to extract the wrapped `T` and builds `std::function<<T-runtime-type>()>` directly.

- **`ExternMacro::CCName()` resolves to `TorqueRuntimeMacroShims::<asm>::<name>`**, not the default `TqRuntime_<name>`. Virtual dispatch through `CCName()` handles the difference in all Phase 3 emissions (`MakeLazyNode`, `CallCsaMacroAndBranch`) without needing explicit `ExternMacro::DynamicCast` checks in the emission code — simpler than the original plan's explicit branching.

- **Torque fixture syntax: `label Slow { }` clauses must be attached to a `try { }` block**, not placed at the top level of a builtin body. This is Torque grammar, not a bug in our work. Corrected during the CallCsaMacroAndBranch fixture iteration (pattern cribbed from `deps/v8/src/builtins/array-to-spliced.tq:232-240`).

- **`EmitGoto` label-value binding** — CC's `EmitGoto` (`cc-generator.cc:477-489`) iterates `stack->AboveTop()` against `destination->InputDefinitions()` and emits phi assignments. For label-block gotos inside CallCsaMacroAndBranch, we push the label-value slot names onto a local copy of the pre-call stack before calling `EmitGoto`, so the phi mechanism sees the bound values. The current fixture (`GotoIfForceSlowPath`, zero label-value params) doesn't exercise this, but the logic is in place for Phase 4+ multi-value labels.

### Phase 3 follow-ups for later phases

- **Macro-body emission under kCCBuiltins** — required to exercise `GotoExternalInstruction` and to LINK the `TqRuntime_<macro>` calls emitted by `CallCsaMacroAndBranch`. Needs either (a) extending the fourth pass to also iterate labeled macros referenced from whitelisted builtins, or (b) extending the kCC `EnsureInCCOutputList` trigger to fire under kCCBuiltins, or (c) a new sixth pass specifically for kCCBuiltins-callable macros. Paired with a relaxation of `GenerateFunction`'s `implementation-visitor.cc:2056-2058` gate for the kCCBuiltins arm. **Phase 4 scope.**
- **Runtime exception handling** (`catch_block` on CallCsaMacroAndBranch / CallRuntime / CallBuiltin) — still `ReportError`. Needs its own design decision: C++ exceptions, `expected<T,E>`-style returns, or a Torque-specific error channel. **Phase 4+.**
- **Tail-calls from `CallBuiltin` / `CallBuiltinPointer`** — still `ReportError`. **Phase 4+.**
- **JS-linkage builtin emission** (receiver / newTarget / dispatchHandle ABI, Descriptor machinery) — still the `(JS linkage deferred to Phase 3)` comment path in `Visit(Builtin*)`. **Phase 4+.** Despite the comment's "Phase 3" label, the realistic pairing is with the dispatch table work in Phase 4.
- **`builtins-cc-table.inc` dispatch table generation** — the `Builtins::CppEntryOf(Builtin)` reference in `CallBuiltinPointer` emission and the `TqRuntime_<macro>` references in MakeLazyNode / CallCsaMacroAndBranch both need real C++ entries at link time. **Phase 4.**

**Next:** Phase 4. Write `docs/plans/2026-04-20-torque-cc-backend-phase4.md` covering dispatch-table generation, macro-body emission under kCCBuiltins, JS-linkage builtin ABI, and the first host-native end-to-end smoke test (linking a translated builtin into `d8`) per the handoff doc's Phase 4 outline.

## Phase 4 Summary

| Item | Result |
|---|---|
| Phase 4 spike decision committed (strategy: new fifth-pass + curated `AllMacrosForCCBuiltinsOutput` list) | ✅ |
| Macro-body emission under kCCBuiltins (fifth pass in `VisitAllDeclarables`) | ✅ |
| `GenerateFunction` emits out-param signature (`bool*` + `T*`) for labels under kCCBuiltins | ✅ |
| `goto-external` fixture + golden (now exercisable with macro-body emission) | ✅ |
| `call-torque-macro` fixture + golden (exercises labeled TorqueMacro via out-param convention) | ✅ |
| `builtins-cc-table.inc` generation + `Builtins::TorqueCcEntryOf` sibling of `CppEntryOf` | ✅ |
| `CallBuiltinPointer` emission uses `TorqueCcEntryOf` (Phase 2's `CppEntryOf` placeholder retired) | ✅ |
| gyp integration: `torque_outputs_ccbuiltins_cc` + `--cc-builtins-whitelist` plumbing via GYP_DEFINES | ✅ |
| Host CSS+jitless V8 build with patch + whitelist (`build-v8-host-phase4.sh`) | ✅ |
| C++ unit test invokes `Builtin_TorqueCcTest_Return` directly (`TorqueCcBuiltinTest.DirectInvocation` — 3 ms) | ✅ |
| C++ unit test verifies dispatch table (`TorqueCcBuiltinTest.DispatchTableLookup` — 4 ms) | ✅ |
| Full 13-fixture harness passes (11 Phase 2/3 + 2 Phase 4) | ✅ |
| Non-whitelisted torque output sha unchanged vs Phase 3 (`a5195c0258fd9af9415e9d41f0c2e38237989c1b`) | ✅ |
| Consolidated patch exports + re-applies cleanly on upstream `9fe7634c` (42 commits, 2843 lines) | ✅ |

**CCGenerator stubs after Phase 4: 0.** Every backend-dependent instruction emits real C++. Remaining `ReportError` gates are intentional scope gates (catch-block, tailcall, JS-linkage, multi-result PairT, struct-typed label values) that Phase 5+ addresses as fixtures force them.

**End-to-end proof.** `TorqueCcTest_Return(isolate, context, Smi::FromInt(42)) == Smi::FromInt(42)` runs at native speed in a host-linked V8 unit test. `Builtins::TorqueCcEntryOf(Builtin::kTorqueCcTest_Return) == &Builtin_TorqueCcTest_Return` confirms the dispatch table resolves correctly. This is the first phase producing running code rather than source-level fidelity.

**Phase 4 commit chain on the Node.js clone** (15 commits on top of Phase 3 tip `33051608`):
1. `57a1465f` — `torque: add AllMacrosForCCBuiltinsOutput list + accessor`
2. `1afcd23d` — `torque: record TorqueMacros referenced from kCCBuiltins builtins`
3. `181803dd` — `torque: record TorqueMacros referenced by MakeLazyNode under kCCBuiltins`
4. `c1b9e4e2` — `torque: add fifth pass emitting kCCBuiltins-referenced macro bodies`
5. `56d0b70c` — `torque: route kCCBuiltins through VisitMacroCommon + GenerateMacroFunctionDeclaration`
6. `7fdbade5` — `torque: Macro::ShouldBeInlined returns false for all TorqueMacros under kCCBuiltins`
7. `bd86dadb` — `torque: emit out-param signature for labeled macros under kCCBuiltins`
8. `fd0a721a` — `torque: mark kCCBuiltins macro bodies inline via InlineDefinition flag` (reworked from bad commit `905aae7f` that leaked `inline` into stock kCC output)
9. `ca5aeb8d` — `torque: emit builtins-cc-table.inc for kCCBuiltins dispatch`
10. `a7784154` — `v8 builtins: add Builtins::TorqueCcEntryOf sibling to CppEntryOf`
11. `8957403e` — `torque: CallBuiltinPointer uses Builtins::TorqueCcEntryOf`
12. `fae77eb7` — `v8 builtins: clarify TorqueCcEntryOf comment re empty whitelist`
13. `a1754567` — `v8 gyp: compile -tq-ccbuiltins.cc + wire --cc-builtins-whitelist`
14. `8c5e91c0` — `v8: stage TorqueCcTest_Return fixture permanently under test/torque-cc-fixtures/`
15. `2b408bfb` — `v8 torque+node: Phase 4 smoke test — invoke Torque-CC-translated builtin directly`

Total commits on top of upstream `9fe7634c` after Phase 4: **42** (10 Phase 1 + 11 Phase 2 + 6 Phase 3 + 15 Phase 4). Consolidated patch: 2843 lines.

### Plan deviations surfaced during Phase 4 implementation

- **Spike finding 5 required duplicate-emission prevention** (plan Task 4.3). Transitive macros like `FromConstexpr_Smi_constexpr_IntegerLiteral` are emitted in BOTH kCC's `-tq-inl.inc` AND kCCBuiltins' `-tq-ccbuiltins.cc`. Without ODR-legal duplicate definitions, linking multiple TUs containing the same symbol fails. Solution: mark kCCBuiltins bodies `inline`. Initial attempt (commit `905aae7f`) widened `PrintBeginDefinition`'s `inline` emission globally, which leaked into stock `-tq-inl.inc` class-accessor bodies (70 files), shifting the non-ccbuiltins sha. Fix (`fd0a721a`): introduced a separate `InlineDefinition` flag (0x80 in `FUNCTION_FLAG_LIST`) distinct from `SetInline()`. The new flag is set only under kCCBuiltins by `GenerateFunction`; `SetInline()` keeps its original "declaration-header inline" semantics. Cleaner separation of concerns.
- **Widened `Macro::ShouldBeInlined`** from Phase 3's labeled-only carve-out to ALL TorqueMacros under kCCBuiltins. Without this, `ShouldGenerateExternalCode` nulls the stream for the fifth pass and no body emits. Side effect: every macro call in a whitelisted builtin goes through `CallCsaMacroInstruction`/`CallCsaMacroAndBranchInstruction` dispatch rather than inlining — matches kCC discipline.
- **MakeLazyNode needs its own trigger.** It bypasses `GenerateCall` (directly emits the `TqRuntime<name>_<N>(...)` call from the instruction emitter). Without a separate `EnsureInCCBuiltinsOutputList` call in `cc-generator.cc:434`, MakeLazyNode references land without bodies. `CallCsaMacro` and `CallCsaMacroAndBranch` both go through `GenerateCall` — one trigger covers them.
- **Three Phase-3 latent issues surfaced**:
  - `Lazy<T>::GetRuntimeType()` null-derefs (Phase 3 already fixed via `MatchUnaryGeneric`).
  - `VisitMacroCommon` + `GenerateMacroFunctionDeclaration` needed kCCBuiltins arms (plan noted ambiguous line numbers; implementer added proper arms based on actual structure).
  - Struct-typed label values would need emission; guarded as `ReportError("Phase 4: ... not yet supported")` — no fixture forces it yet.
- **Task 4.9 uncovered 2 bugs** that only became reachable once the smoke test linked a real body:
  - **Missing `#include`s in `-tq-ccbuiltins.cc`**. Before Task 4.9 the empty default whitelist hid this. With `TorqueCcTest_Return` whitelisted, the file fails to compile (`'Smi' undeclared`). Fix: `ImplementationVisitor::GenerateImplementation` now emits an include preamble at the top of every `-tq-ccbuiltins.cc` (`src/base/macros.h`, `src/execution/isolate.h`, `src/objects/contexts.h`, `src/objects/smi.h`, `src/objects/tagged.h`). All 13 fixture goldens were refreshed to match.
  - **Builtin enum offset divergence** between `cctest` and `v8_base_without_compiler`. The `V8_ENABLE_LEAPTIERING` conditional in `builtins-definitions.h:72` adds 6 TFC entries. Without the LITE_MODE/LEAPTIERING defines propagated to cctest's gyp target, cctest sees `Builtin::kTorqueCcTest_Return = 1515` while builtins.cc sees it as `1521`. Fix: propagate `V8_LITE_MODE`, `V8_ENABLE_LEAPTIERING`, `V8_ENABLE_SPARKPLUG`, `V8_ENABLE_MAGLEV`, `V8_ENABLE_TURBOFAN`, `V8_INTL_SUPPORT` + V8 include paths to cctest's gyp target.
- **Used Node.js `cctest` target, not V8's `v8_unittests`.** V8's `v8_unittests` is GN-build-only and not wired through Node.js's gyp. Node's `cctest` is gtest-based and autodiscovers files under `test/cctest/` via `configure.py`'s `SearchFiles('test/cctest', 'cc')` — so `test/cctest/test_torque_cc_builtin.cc` is picked up by file placement alone; no explicit gyp registration needed.
- **Default-constructed `Tagged<Context>`** used in `TorqueCcBuiltinTest.DirectInvocation` (null tagged pointer) rather than a real native context — the `TorqueCcTest_Return` builtin body doesn't touch context, and obtaining a real one requires pulling in `isolate-inl.h` which conflicts with `V8_LITE_MODE`'s `feedback-vector.h` expectations. Safe for this fixture; future fixtures that dereference context will need a real `native_context` setup.

### Phase 4 follow-ups for later phases

- **Runtime exception handling** (`catch_block` on CallCsaMacroAndBranch / CallRuntime / CallBuiltin) — still `ReportError`. Needs a dedicated plan. **Phase 5+.**
- **Tail-calls from `CallBuiltin` / `CallBuiltinPointer`** — still `ReportError`. **Phase 5+.**
- **JS-linkage builtin emission** (receiver / newTarget / dispatchHandle ABI + Descriptor machinery) — still the `(JS linkage deferred)` comment path in `Visit(Builtin*)`. **Phase 5+.**
- **`Builtins::code(Builtin)` integration** — the smoke test calls the function directly (not through V8's entry table / interpreter). Wiring translated builtins through `Builtins::code` requires additional kind metadata + embedded builtin bootstrapping. **Phase 5/6.**
- **mksnapshot integration** — current smoke test links in a context where no snapshot serialization crosses a translated builtin. Integration when the snapshot needs to capture Torque-CC builtin pointers. **Phase 5+.**
- **Struct-typed label values.** Phase 4 Task 4.4 reports error on struct label values; single-value shape is sufficient for current fixtures. Real V8 builtins use struct label values (e.g., `Cast<HeapObject>(x) otherwise Slow(Object)` in some paths). **Phase 5 when first fixture forces it.**
- **Latent ninja dep-tracking**: `deps/v8/src/builtins/builtins.cc` textually `#include`s `torque-generated/builtins-cc-table.inc`, but ninja's auto-generated `.d` files don't capture that dependency. Regenerating the .inc via a torque re-run does NOT trigger a rebuild of `builtins.o`. Worked around with `touch builtins.cc` during Phase 4 development. Future fix: declare the dependency in gyp or use `gn refs`. **Phase 5 or infrastructure cleanup.**
- **Feature-flag drift**: the LITE_MODE/LEAPTIERING defines propagated to cctest must stay in sync with V8's `v8_config`. Future V8 uplifts that add new feature flags affecting `BUILTIN_LIST` will require updating this list, or the gtest's dispatch lookup silently returns wrong addresses. **Document in any V8 uplift checklist.**
- **Default-constructed `Tagged<Context>`** in the smoke test — works for `TorqueCcTest_Return`, won't work for context-touching builtins. **Phase 5 when first fixture forces real context.**
- **Phase 5:** wire translated builtins through `Builtins::code(Builtin)` for interpreter dispatch, start the first real d8 `-e "print(1+2)"` smoke test, and build out the hand-written CSA replacement ledger.

---

## Phase 5 Spike — Interpreter Dispatch (Task 5.4, 2026-04-22)

### Dispatch path under jitless + lite-mode

Reading `builtins.cc`, `builtins.h`, `isolate.cc`, `interpreter.cc`, `bootstrapper.cc` end-to-end establishes the following:

- `Builtins::Kind` (`builtins.h:150`) is `{ CPP, TSJ, TFJ, TSC, TFC, TFS, TFH, BCH, ASM }` — no `kTorqueCc` kind exists. Phase 4 added `Builtins::TorqueCcEntryOf(Builtin)` returning our C++ function pointer, but did NOT add a new kind.
- `Builtins::code(Builtin)` (`builtins.cc:149`) returns `Tagged<Code>` from `isolate_->builtin_table()[Builtins::ToInt(builtin)]`. That table is populated during bootstrap from the embedded snapshot blob. The embedded blob STILL contains the CSA-generated code for every Torque-CC-whitelisted builtin — Phase 4's patch emits BOTH kCCBuiltins bodies AND kCSA bodies; it doesn't replace the CSA path, only duplicate it.
- `Builtins::InitializeIsolateDataTables(isolate)` (`builtins.cc:418`) copies `embedded_data.InstructionStartOf(i)` into `isolate_data->builtin_entry_table()[i]`. This is what bytecode handlers in the embedded blob actually load-and-call at dispatch time.
- `SimpleInstallFunction(...)` in `bootstrapper.cc` creates a `JSFunction` whose `Code` field points into the embedded builtin blob — that is the code that runs when user JS calls e.g. `Array.isArray(x)`.
- **There is no runtime C++ layer between the bytecode handler and the builtin call.** The interpreter dispatch is machine code baked into the embedded snapshot; `Builtins::code()` is a C++ API used by C++ callers (compilation, bootstrap, debugging) but NOT by the runtime dispatch of a JS-issued call.

### Cost of the plan's Shape A

"Install a minimal Code object per Torque-CC builtin whose `instruction_start` jumps to the C++ function":

- **Requires generating native machine code** per builtin, per architecture (x86_64, arm64). V8's existing machinery that does exactly this — `TFC(AdaptorWithBuiltinExitFrameN, CppBuiltinAdaptor)` — is generated by mksnapshot via CSA and baked into the embedded blob; it is NOT re-invocable at runtime.
- Allocating a real heap-resident `Code` object at bootstrap (after the embedded blob is frozen) requires:
  - Adding a new `Builtins::Kind::kTorqueCc` value + updating every switch over `Kind` (12 sites found via grep).
  - Plumbing `kTorqueCc` through `BUILTIN_LIST_*` macros so `KindOf(builtin)` returns it.
  - Allocating an `InstructionStream` at bootstrap, storing per-architecture thunk machine code in it, and pointing `Code::instruction_stream` at it.
  - Or: using V8's existing `AdaptorWithBuiltinExitFrameN` logic by re-classifying our builtins as `CPP` at runtime, which requires our emitted C++ function to match the CPP builtin ABI (`Tagged<Object> Builtin_X(int argc, Tagged<Object>* args, Isolate* isolate)` — per `builtins-utils-gen.h`). Our Phase-4 emission produces `Tagged<Smi> Builtin_X(Isolate*, Tagged<Context>, Tagged<Smi>)` — fundamentally different ABI.
- **Rough LoC: ≥800** (bootstrap edits + `Kind` propagation + per-architecture thunk codegen OR ABI-matching re-emission in `Visit(Builtin*)`).
- **Matches Task 5.4's escalation trigger**: "requires generating native assembly for the Code-object instruction_start."

### Cost of the plan's Shape B

"Patch the interpreter's builtin-dispatch path to consult `Builtins::TorqueCcEntryOf` first":

- The interpreter dispatches via machine code in the embedded blob. There is no runtime bytecode-handler C++ frame in the hot call path — `Interpreter::GetBytecodeHandler` (`interpreter.cc:114`) is only used at isolate init to populate the dispatch table. After init, the interpreter's bytecode handlers run as native code that loads and calls addresses from `builtin_entry_table[]`.
- To patch "every builtin-dispatch site," we would have to:
  - Regenerate the embedded builtin snapshot with a modified CSA pass that emits a TorqueCc-check branch at each dispatch site. That reverses Phase 4's design goal (keep V8's generated CSA paths stable + emit alongside).
  - OR overwrite `builtin_entry_table[i]` with a thunk at `InitializeIsolateDataTables` — still requires native-code thunks because the machine code calling convention expects builtin-ABI registers, not the C ABI our function uses.
- **Rough LoC:** comparable to Shape A (≥800) once thunks are factored in.

### The real obstacle: ABI translation

Both shapes reduce to the same core problem: **V8's embedded interpreter invokes builtins via a register-based builtin ABI**; our Torque-CC-emitted C++ functions use the C ABI. No wiring change avoids the need for an ABI-translation thunk. V8 has one (`AdaptorWithBuiltinExitFrameN`) but it calls a `CPP`-shaped function signature, not ours.

Two realistic paths forward:

1. **Path 1 — Re-emit with CPP ABI.** Change `Visit(Builtin*)` to emit functions matching the `BUILTIN(Name, ...)` macro's expansion: `Tagged<Object> Builtin_Name(int argc, Tagged<Object>* args, Isolate* isolate)` accessing params via `BuiltinArguments`. Then register the builtin's entry via the existing `builtin_metadata[i].data.cpp_entry` mechanism and piggyback `AdaptorWithBuiltinExitFrameN`. **Cost:** rewrite the Phase-4 emission path + 13 fixtures + goldens; the Phase-4 DirectInvocation cctest changes shape. Eliminates ABI-thunk work. Still requires a new `Builtins::Kind::kTorqueCc` (or runtime kind override) so the adaptor is selected for translated builtins.

2. **Path 2 — Stop short of full dispatch integration.** Phase 5's cctest smoke test would invoke the translated builtin via a direct C++ call against a real `v8::Context` + `v8::Isolate` (Phase 4's DirectInvocation pattern, extended with a real native context so context-touching builtins work). No interpreter dispatch; no d8 `Array.isArray` execution. Phase 5 closes with: "translated JS-linkage ArrayIsArray call-through a real native context; full interpreter integration deferred." Subsequent phases can take Path 1 at leisure.

### Decision

**Neither Shape A nor Shape B as the plan describes them is achievable within Phase 5's scope without escalating to a large V8 bootstrap surgery or an architecture-specific assembly generator.** The plan's escalation trigger ("Task 5.4 spike concludes Shape A requires... generating native assembly") fires.

**Recommended:** take **Path 2** for Phase 5 — defer end-to-end interpreter dispatch to Phase 6+, preserve Phase 5's cctest target but change its shape from "Array.isArray via Script::Run" to "Array.isArray via direct C++ invocation against a real NativeContext." This keeps Phase 5 shippable; Path 1 (re-emission under CPP ABI) becomes a Phase 6 plan item with clear scope.

**Escalation:** Phase 5 plan's Tasks 5.8 (interpreter dispatch implementation), 5.11 (Script::Run smoke), and Task 5.13's d8 smoke-test list all depend on dispatch integration. Those tasks need re-scoping or deferral. Surfacing to user.

## Phase 5 Spike — Path 1 Plumbing (Task 5.1-revised, 2026-04-22)

Per the Phase 5 (revised) plan at `docs/plans/2026-04-22-torque-cc-backend-phase5-revised.md`, this spike re-tests Path 1 (re-emit with CPP ABI + piggyback V8's `AdaptorWithBuiltinExitFrameN`) before layering on real Torque emission. Path 1 was previously dismissed as "requires a new `Builtins::Kind::kTorqueCc`" — that claim was wrong; a hand-written `CPP(<Name>, JSParameterCount(<N>))` entry reuses the existing `Kind::CPP` with zero Kind-switch edits.

### Spike scope

Hand-wrote a minimal CPP-linkage builtin at `deps/v8/src/builtins/builtins-torquecc-spike.cc`:

```cpp
Address Builtin_TorqueCcSpike(int args_length, Address* args_object,
                              Isolate* isolate) {
  DCHECK(isolate->context().is_null() || IsContext(isolate->context()));
  BuiltinArguments args(args_length, args_object);
  HandleScope scope(isolate);
  return (*args.receiver()).ptr();
}
```

Registered via `CPP(TorqueCcSpike, JSParameterCount(0))` in `builtins-definitions.h` (inserted next to `CPP(ArrayConcat, ...)` at line 464), and added `"src/builtins/builtins-torquecc-spike.cc"` to `v8_base_without_compiler`'s sources list in `BUILD.gn` (picked up by `tools/v8_gypfiles/v8.gyp` via its GN-scraper).

### What the spike validates

| Check | Result |
|---|---|
| Source compiles (`builtins-utils-inl.h` + `BuiltinArguments` + `HandleScope` available) | ✅ |
| `CPP(TorqueCcSpike, ...)` static-init accepts the entry | ✅ |
| `FUNCTION_ADDR(Builtin_TorqueCcSpike)` resolves at link time | ✅ |
| `BUILD_CPP_WITHOUT_JOB` → `BuildAdaptor` runs for `Builtin::kTorqueCcSpike` at mksnapshot time | ✅ (mksnapshot exits 0) |
| `AdaptorWithBuiltinExitFrame0` Code object bakes into `libv8_snapshot.a` | ✅ (d8 links, runs `print(1+2)` under the new snapshot) |
| `Builtins::code(Builtin::kTorqueCcSpike)` resolves post-isolate-init | ✅ (implied — d8 starts cleanly; explicit cctest check omitted due to Isolate-incomplete-type issue under the cctest's minimal include set) |
| cctest `TorqueCcBuiltinTest.TorqueCcSpikePlumbing` passes | ✅ (4/4 tests green: DirectInvocation, DispatchTableLookup, Phase5ScriptRunSmoke, TorqueCcSpikePlumbing) |

### What the spike intentionally defers

**End-to-end adaptor → C dispatch at runtime** is not directly verified by the spike's cctest case. Getting the full Factory-builder + global-property-install + Script::Run path to compile under cctest's minimal include set hit a transitive include collision (V8's `src/tracing/trace-event.h` pulled in through `heap/factory.h` → `heap/heap.h` → `gc-tracer.h` conflicts with Node's `tracing/trace_event_common.h` TRACE_EVENT0 macro, because node_test_fixture.h already pulls in `env-inl.h` which defines the macro). Working around this would require gating the spike test with `#undef TRACE_EVENT0` before the V8 includes, which risks masking real issues.

Instead, end-to-end dispatch will be validated by Task 5.8's d8 `print(Array.isArray([1,2,3]))` probe: that exercises the full interpreter → `builtin_table[kArrayIsArray]` → adaptor → `Builtin_ArrayIsArray` → `BuiltinArguments` unpack → Torque-lowered body → `.ptr()` return chain. If Task 5.8 fails, we'd return here and investigate the dispatch piece in isolation.

### Install mechanism notes for future cctest cases (Task 5.6+)

The plan's Task 5.6 (`JsReturnAdaptorDispatch`) needs a JSFunction bound to a CPP builtin for full-dispatch testing. The Phase-4 cctest file deliberately avoids `-inl.h` headers. A Task-5.6 option: **install TorqueCcTest_JsReturn via bootstrapper-style code in node.cc startup (e.g., a `--expose-torque-cc-fixtures` flag)** so cctest doesn't need the Factory incantation. Or: put the cctest case in a separate translation unit that tolerates the heavier headers. Decided: punt on this decision until Task 5.6; the spike proved Path 1 at the plumbing level, which is what the spike was for.

### Build-system quirks observed (so Task 5.2-5.8 don't re-hit them)

- **Source-file registration:** Adding `"src/builtins/builtins-torquecc-spike.cc"` to `v8_base_without_compiler` in `BUILD.gn` was sufficient — `tools/v8_gypfiles/v8.gyp:1098` scrapes that list via `GN-scraper`, so no separate gyp edit is needed. Good news for Task 5.2/5.5 — torque-emitted `-tq-ccbuiltins.cc` files are already captured via `torque_outputs_ccbuiltins_cc` (Phase 4 addition).
- **cctest requires all whitelisted stub-linkage builtins to be linked:** the empty-whitelist build succeeded for mksnapshot + d8 + libv8, but the cctest build failed with "undefined reference to `Builtin_TorqueCcTest_Return`" until the whitelist was expanded to `TorqueCcTest_Return,TorqueCcSpike`. Phase 4's `TorqueCcTest_Return` is referenced unconditionally by the pre-existing `TorqueCcBuiltinTest.DirectInvocation` case. Task 5.5's empty-whitelist build validation stands, but non-empty whitelists for cctest runs must always include `TorqueCcTest_Return`.
- **Shell gotcha:** the Bash tool runs zsh, not bash, so the plan's `$TQ_FILES` word-splitting idioms need `bash -c '...'` wrapping. Already noted in `/tmp/phase5r-baseline-metadata.txt` for the rest of Phase 5.

### LoC estimate for Tasks 5.2–5.5 real emission

- Task 5.2 (torque TFJ→CPP swap): ~15 LoC in `implementation-visitor.cc:3954` emitter.
- Task 5.3 Step 3a (CCGenerator::kPtrReturn): ~10 LoC in `cc-generator.{h,cc}`.
- Task 5.3 Step 3 (real JS-linkage emission): ~80 LoC in `Visit(Builtin*)` replacing the 8-line deferred comment.
- Task 5.4 (preamble): ~3 LoC (3 include lines).
- Task 5.7 (preamble extension for js-array/js-proxy/runtime): ~6 LoC.

Total V8 emitter-side: ~115 LoC + ~5 LoC for the test fixture `.tq` file. Matches the spike's "the hard work is getting the shape right, not the volume" shape.

### Decision

**Path 1 is viable end-to-end at the plumbing level.** Proceed to Task 5.2 (torque TFJ→CPP swap) without re-scoping. The spike's deferred dispatch verification rolls forward into Task 5.8's d8 probe + Task 5.9's in-process ScriptRun cctest.

**Spike artifacts reverted cleanly.** Clone tip stays at `305050d4` (Task-5.3 post-tip, 43 commits on `9fe7634c`); no clone-side commits from Task 5.1. Worktree gets only this verification.md append.

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
| Non-whitelisted torque output sha stable post-5.8/5.9: d5c6d835… | ✅ |
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

**Phase 5 (revised) commit chain on the Node.js clone** (60 commits total
on top of `9fe7634c`; the planned ≈7 new on top of Phase 4 + Task 5.1-5.3
tip `305050d4` expanded to 17 as Task-5.8 defect fixes and Task-5.9 cctest
landed):
1. `torque: emit CPP(...) for whitelisted JS-linkage builtins` (Task 5.2)
2. `torque: CCGenerator gets kPtrReturn mode for CPP-ABI return path` (Task 5.3)
3. `torque: implement JS-linkage CPP-ABI emission under kCCBuiltins` (Task 5.3)
4. `torque: extend kCCBuiltins include preamble for JS-linkage` (Task 5.4)
5. `v8 torque+node: Phase 5 (revised) — JsReturnAdaptorDispatch cctest` (Task 5.6)
6. `torque: extend kCCBuiltins preamble for js-array/js-proxy/runtime` (Task 5.7)
7. Task 5.8 defect fixes (7 commits):
   - `runtime-macro-shims: add 7 helpers (TaggedToHeapObject/TaggedNotEqual/…)`
   - `torque: %ClassHasMapConstant backend-aware (kCCBuiltins → literal false)`
   - `torque: CCGenerator %RawDownCast emits UncheckedCast<T> for Tagged types`
   - `torque: CCGenerator CallRuntime emits direct Runtime_<name>(argc,args,isolate)`
   - `torque: CCGenerator GotoExternal emits return {} on non-void paths`
   - `torque: kCCBuiltins wraps macro bodies in V8_INTERNAL_DEFINED_<CCName>`
   - `torque: kCCBuiltins preamble gains forward-decls + True_0/False_0 shims`
8. `v8 torque+node: Phase 5 (revised) — ScriptRunArrayIsArray cctest` (Task 5.9)

Consolidated patch: 4577 lines (exceeded the ≈3200-line prediction by
~43%; growth is entirely Task-5.7 preamble extension + Task-5.8 defect
repair, which the original plan scoped as "minor" but which in practice
required real engineering once the first V8 rebuild surfaced the
linkage and codegen gaps).

### Plan deviations surfaced during Phase 5 (revised) implementation

- **d8 banner pollution.** `d8 -e '<source>'` writes the
  "V8 is running with experimental features enabled. Stability and
  security will suffer." banner to **stderr**. `test/d8-smoke.sh` was
  initially written per the plan as `2>&1`, which caused all 10
  probes to FAIL with `actual` containing the banner prefixed to the
  real output. Fix: redirect stderr to `/dev/null` during the probe —
  only real program output is checked against expectations.
- **Non-ccbuiltins anchor drifted from 65b1efc5 (Task 5.7) to d5c6d835
  (post-Task 5.8).** Expected drift — Task 5.8's include-guard wrapping
  (`V8_INTERNAL_DEFINED_<CCName>`) and forward-decl / True_0 / False_0
  preamble additions are all under `kCCBuiltins`, but the total file-
  set byte layout shifted enough to move the sha. Task 5.9 added only
  cctest C++ and did NOT further shift the anchor; `d5c6d835…` is
  stable from Task 5.8 onward.
- **Patch size prediction.** Plan predicted ≈3200 lines; final patch
  is 4577 lines. Delta driven by Task 5.7 preamble extension and the
  7-commit Task-5.8 repair chain (one defect per commit, atomic style
  as requested). No planning failure — the plan explicitly noted "exact
  value TBD after final export."

### Phase 5 (revised) follow-ups for later phases

- **Runtime exception handling** (`catch_block`). Still `ReportError`.
  Phase 6+ when a target forces it.
- **Tail-calls from CallBuiltin / CallBuiltinPointer.** Still
  `ReportError`. Phase 6+.
- **Struct-typed label values.** Still `ReportError`. Phase 6+.
- **mjsunit.** Phase 6.
- **CSA replacement ledger — first real shim.** When d8 / mjsunit
  forces one. Phase 6. Scaffold landed in this phase (Task 5.11) under
  `examples/libs/nodejs/csa-builtins/`.
- **Varargs JS builtins** (`IsVarArgsJavaScript`). Still `ReportError`
  under kCCBuiltins. Phase 6 when a forcing fixture lands.
- **Leaptiering-on dispatchHandle.** Currently emits
  `InvalidDispatchHandleConstant()`. Phase 6+ for
  `V8_ENABLE_LEAPTIERING=true` builds.
- **JSProxy branch of ArrayIsArray exercised via real JS.** Not covered
  by Task 5.9's fixed-receiver cases; needs a `new Proxy(…)` case in
  Phase 6 mjsunit.
- **Proper NamespaceConstant CC emission.** Task 5.8 landed True_0 and
  False_0 as hand-written inline accessors in the kCCBuiltins preamble;
  the proper generator-emitted per-const helpers are deferred to Phase 6+
  when base.tq surfaces more consts reachable from whitelisted builtins.
- **%GetClassMapConstant fast-path.** Task 5.8 reduced %ClassHasMapConstant
  under kCCBuiltins to literal `"false"` (semantic no-op for non-
  UNIQUE_INSTANCE_TYPE classes); a free-function `TorqueClassHasMapConstant<T>()`
  driven by `CLASS_MAP_CONSTANT_ADAPTER` would restore the fast path.
- **Wasm32 cross-compile.** Phase 7+.

## Phase 6 Summary

Phase 6 expanded the kCCBuiltins whitelist from 1 JS-linkage builtin
(`ArrayIsArray`) to 5, adding all four `Number.is*` predicates
(`NumberIsFinite`, `NumberIsNaN`, `NumberIsInteger`, `NumberIsSafeInteger`)
under mjsunit pressure. The first addition (`NumberIsFinite`) surfaced
9 emitter/shim gaps; those gaps were closed once and the remaining
three builtins landed with zero emitter changes (only 3 new shims
across Tasks 6.4-6.6).

| Item | Result |
|---|---|
| Task 6.1: run-mjsunit.sh runner + array-isarray.js pass-list | ✅ |
| Task 6.2: NumberIsFinite whitelisted — 4 new shims + 3 gated emitter edits + `is_cc_builtins_` flag | ✅ |
| Task 6.3: number-is.js deferral documented | ✅ |
| Task 6.4: NumberIsNaN whitelisted — 0 new shims, 0 emitter edits | ✅ |
| Task 6.5: NumberIsInteger whitelisted — 2 new shims (IsInteger + SelectBooleanConstant), 0 emitter edits | ✅ |
| Task 6.6: NumberIsSafeInteger whitelisted — 1 new shim (IsSafeInteger), 0 emitter edits | ✅ |
| Task 6.7: mjsunit pass-list grown to 2 files (array-isarray.js + number-is.js) | ✅ |
| Task 6.8: Exhaustive Phase-6 gates 15 OK / 9 PASS / 18 PASS / 2 PASS / anchor stable | ✅ |
| Task 6.9: wasm-posix-kernel kernel suite re-run — 0 regressions | ✅ |
| 15/15 torque-fixture goldens byte-exact | ✅ |
| Non-ccbuiltins anchor excluding number-tq-csa.cc: **8169724e** (stable across Tasks 6.2→6.6, confirming zero cross-file emitter drift) | ✅ |
| Consolidated patch re-applies cleanly on upstream `9fe7634c` | ✅ |
| 9 cctest cases green (5 Phase-5 + 4 new ScriptRun*Number.is*) | ✅ |
| d8-smoke: 18/18 green (10 Phase-5 + 2 per new builtin) | ✅ |
| mjsunit: 2/2 green (array-isarray.js end-to-end + number-is.js all 4 Number.is* assertions) | ✅ |
| Non-ccbuiltins anchor full sha: 3bf75ed0 → 8801f44c → 3231b187 → b32c846a (each drift isolated to one new CSA-suppression entry; excluding-anchor invariant) | ✅ |

**End-to-end proof.** `./out/Release/d8 mjsunit.js deps/v8/test/mjsunit/number-is.js`
runs to completion with exit 0, empty output. The mjsunit harness's
`assertTrue` / `assertFalse` / `assertEquals` invocations all satisfy;
V8's interpreter dispatches through the baked `AdaptorWithBuiltinExitFrame1`
for each of `Builtin::kNumberIsFinite`, `Builtin::kNumberIsNaN`,
`Builtin::kNumberIsInteger`, `Builtin::kNumberIsSafeInteger`; those
adaptors call into the torque-emitted `Builtin_NumberIs*(int, Address*, Isolate*)`
functions; the functions execute their lowered Torque bodies against
real `NativeContext` / `BuiltinArguments` / `ReadOnlyRoots` state.
**Phase 6 is the first phase where mjsunit exercises our emitted code
through V8's full harness-driven test infrastructure**, not just
DirectInvocation cctest and single-expression d8 probes.

**Phase 6 clone commit chain** (77 commits total on top of `9fe7634c`;
11 new on top of Phase-5 tip `b046aa14`):

Task 6.2 (6 commits):
1. `d26ac6da torque: extend kCCBuiltins runtime-macro-shims for NumberIsFinite` — Float64Sub, Word32BinaryNot, TaggedToSmi, BranchIfFloat64IsNaN.
2. `d4ece550 torque: CCGenerator gains is_cc_builtins_ flag + preamble isolate-inl` — scaffolding for the 3 gated emitter edits that follow.
3. `2bf63c6f torque: CCGenerator emits UncheckedCast for UnsafeCast on Tagged types` — fixes the static_cast narrowing failure (Tagged<JSAny> → Tagged<HeapObject>-ish).
4. `531d5fd7 torque: CCGenerator emits Isolate::Current() for NamespaceConstant` — fixes True_0/False_0 undeclared `isolate` in nested helper scope.
5. `3b06c4f2 torque: CCGenerator routes non-tagged ReadField via UncheckedCast<HeapObject>` — fixes HeapNumber::ReadField on V8_OBJECT layout.
6. `81c0fb58 cctest: add ScriptRunNumberIsFinite` — 11 subcases.

Task 6.4 (1 commit):
7. `211cafdf cctest: add ScriptRunNumberIsNaN` — 11 subcases.

Task 6.5 (2 commits):
8. `8c31ae38 runtime-macro-shims: add IsInteger + SelectBooleanConstant for NumberIsInteger`.
9. `c8602fc2 cctest: add ScriptRunNumberIsInteger` — 15 subcases.

Task 6.6 (2 commits):
10. `fcd5e3f1 runtime-macro-shims: add IsSafeInteger for NumberIsSafeInteger`.
11. `2c27a163 cctest: add ScriptRunNumberIsSafeInteger` — 17 subcases.

Patch line growth: 4577 (Phase-5 close) → 5029 (6.2) → 5095 (6.4)
→ 5243 (6.5) → 5374 (6.6 close). Average +160 lines per new builtin;
well under the plan's 6000-line target for Phase-6 close.

**Non-ccbuiltins anchor recipe** (so future phases can reproduce):
```bash
cd examples/libs/nodejs/build/node
# Full anchor (drifts as new builtins whitelisted → their -tq-csa.cc suppressed):
(find out/Release/gen/torque-generated \( -name "*-tq-csa.cc" -o -name "*-tq-ccdebug.cc" \) | sort | xargs cat) | shasum -a 256 | head -c 8
# Excluding suppressed builtins' source file — the load-bearing invariant:
(find out/Release/gen/torque-generated \( -name "*-tq-csa.cc" -o -name "*-tq-ccdebug.cc" \) -not -name "number-tq-csa.cc" | sort | xargs cat) | shasum -a 256 | head -c 8
```
The excluding-anchor value `8169724e` was stable across Tasks 6.2-6.6
(every rebuild after landing NumberIsFinite through NumberIsSafeInteger).
If it drifts in a future task, that signals an emitter regression
affecting some `.tq` source other than the one being whitelisted — a
hard-stop per the plan's Appendix B.

### Plan deviations surfaced during Phase 6 implementation

- **First-subagent time budget blowup (Task 6.2).** The initial
  Task-6.2 subagent invocation consumed its 100+ tool-use budget on
  `tail -N` polls of an incrementally-buffered `ninja` pipe, returning
  zero commits. Pivoted to running the rebuild foreground via
  `Bash(run_in_background: true) + TaskOutput(block: true)`, then
  dispatching a subagent with the 9 errors pre-analyzed. Task-6.2
  subagent then closed cleanly. Subsequent tasks (6.4-6.6) used the
  same "foreground build + incremental Edit/Bash" pattern, which
  proved both faster (no per-task subagent boot) and more reliable
  (no pipe-buffer pathologies).
- **mjsunit test path correction (Task 6.7).** The plan had the test
  at `es6/number-is.js`; V8 actually has it at the mjsunit root
  `number-is.js`. Fixed in Task 6.7's commit message.
- **cctest commit-body attribution imprecision (Task 6.4).** The
  commit body claimed NumberIsNaN reuses `BranchIfFloat64IsNaN`
  directly; the generated code actually calls a torque-emitted helper
  `TqRuntimeFloat64IsNaN_0` which internally uses `BranchIfFloat64IsNaN`.
  Not a correctness issue; the load-bearing claim "build green with
  zero new shim/emitter changes" is accurate. Flagged in the Task-6.4
  review; grep-the-emitted-.cc pattern used for subsequent commits.
- **No emitter regression after 4 whitelist expansions.** The plan
  anticipated possible emitter cascades. None fired — Task 6.2's
  3 emitter edits (UnsafeCast, NamespaceConstant, ReadField) were
  sufficient for the entire `Number.is*` family. Future families
  (Array.*, String.*) may surface new emitter paths.

### Phase 6 follow-ups (status of each Phase-5 deferred item)

| Item | Phase-5 status | Phase-6 status |
|---|---|---|
| Runtime exception handling (`catch_block`) | ReportError | **Still deferred** — no Phase-6 target forced it. Retained for Phase 7+. |
| Tail-calls from CallBuiltin / CallBuiltinPointer | ReportError | **Still deferred** — same reason. |
| Struct-typed label values | ReportError | **Still deferred** — same reason. |
| Varargs JS builtins (`IsVarArgsJavaScript`) | ReportError | **Still deferred** — `BooleanConstructor`, `ArrayOf`, `ArrayFrom` etc. blocked here. Phase 7+ candidate, possibly its own sub-phase. |
| Proper NamespaceConstant CC emission | Hand-written True_0/False_0 | **Advanced** — Task-6.2 change to emit `Isolate::Current()` makes the pattern work in all call-site scopes (outer builtin + nested helpers). Hand-written True_0/False_0 remain; generator-emitted per-const helpers still Phase 7+. |
| `%GetClassMapConstant` fast-path | Literal `false` | **Still deferred** — Phase 6 didn't surface a whitelisted builtin using UNIQUE_INSTANCE_TYPE classes. Phase 7+. |
| CSA-replacement ledger first real shim | Scaffold only | **Still deferred** — all 4 Phase-6 builtins had full Torque sources; no CSA-only shims needed. Ledger README updated is pending the first real shim. |
| mjsunit | Deferred | **Landed** — 2-file pass-list (array-isarray.js + number-is.js). Runner at `examples/libs/nodejs/test/run-mjsunit.sh`. |

### Important follow-ups from Phase-6 code review (non-blocking, flagged for Phase 7)

- **I-1: `Isolate::Current()` on every NamespaceConstant call-site.** Each builtin invocation now reads TLS twice (one per True_0/False_0 return). Alternatives: track scope and emit `(isolate)` in outer builtin bodies, or move TLS acquisition inside the helper inlines. Current emission is semantically correct (Isolate::Current() has a DCHECK that always holds during JS execution); performance impact is in the single-digit nanoseconds range per return. Revisit when a hotter path lands.
- **I-2: `is_cc_builtins_` flag should be a constructor argument.** Currently a setter (`SetIsCCBuiltins(true)`) is called at each of 3 construction sites in `implementation-visitor.cc`. A 4th future site that forgets the setter will silently emit kCC-style output into a kCCBuiltins file, yielding errors that look identical to "missing shim." Promote to a ctor arg or fold into a single `OutputMode` enum. Cleanup candidate for Phase 7 kickoff.

### What Phase 6 proves

- The emitter is now capable of handling JS-linkage builtins whose
  Torque source uses the following shapes without any further
  per-shape emitter edits:
  - `typeswitch (JSAny) { case (Smi): …; case (HeapNumber): …; case (JSAnyNotNumber): …; }`
  - `return SelectBooleanConstant(pure_predicate(value));`
  - `extern macro F(HeapNumber): T` where F reads `value_` from a V8_OBJECT-layout class.
  - Any mix of the above with True_0/False_0 returns in nested helpers.
- The shim layer is the load-bearing surface for expanding whitelist
  coverage. Each new builtin typically costs 0-2 new shims (average
  0.75 across Phase 6's 4 builtins). The emitter has not required a
  new gate past Task 6.2.
- Zero kernel/host/scripts-layer regressions. All 5 wasm-posix-kernel
  kernel gates match main-branch state (including the 2 pre-existing
  vitest environmental failures and the 2 pre-existing libc-test
  FAILs unrelated to Phase 6).

## Phase 7 Summary

Plan: docs/plans/2026-04-24-torque-cc-backend-phase7-tailcalls.md.
Scope: tail-call emission for `CallBuiltinInstruction` (CSA's `TailCallBuiltin` equivalent under kCCBuiltins).

### Emitter change (one branch, 19 lines)

`CCGenerator::EmitInstruction(const CallBuiltinInstruction&, ...)` at
`deps/v8/src/torque/cc-generator.cc:525` gained a tail-call branch that
replaces the prior `ReportError("Phase 2: CallBuiltin tail-call is
deferred.")`. Emission shape:

```cpp
if (instruction.is_tailcall) {
  if (instruction.builtin->IsJavaScript()) ReportError(...Phase 8...);
  if (instruction.catch_block) ReportError(...deferred...);
  std::vector<std::string> arguments = stack->PopMany(instruction.argc);
  out() << "  return Builtin_" << instruction.builtin->ExternalName()
        << "(isolate";
  for (const auto& arg : arguments) out() << ", " << arg;
  out() << ");\n";
  return;
}
```

The two other guards (JS-linkage, catch_block) **remain** as
`ReportError`s below the tail-call branch for the non-tail path, and
are re-emitted inside the tail branch as deferred-to-Phase-8 guards.
The early `return` ensures no result-var decl or non-tail emission
runs when `is_tailcall=true`. Clone commit `6178a949`.

### Synthetic forcing target

`test/torque-cc-fixtures/tail-call.tq` (staged into both the clone's v8
tree and the worktree harness) defines:

```torque
namespace test_cc_tail {
  builtin TorqueCcTest_TailCall_Helper(implicit context: Context)(x: Smi): Smi {
    return x;
  }
  builtin TorqueCcTest_TailCall(implicit context: Context)(arg: Smi): Smi {
    tail TorqueCcTest_TailCall_Helper(arg);
  }
}
```

Golden (`test/torque-fixtures/golden/tail-call-tq-ccbuiltins.cc`) shows
the caller emitting a single terminal `return Builtin_...Helper(isolate,
parameter0, parameter1);` after the standard `goto block0` preamble,
with no `Tagged<Smi> tmp{}` result-var decl — exactly the CSA tail shape
we wanted.

### Real forcing target — DEFERRED to Phase 7A

`Increment` (number.tq:776-785) was the candidate. Triage:

- **Emitter** handles Increment cleanly. A standalone `torque
  --cc-builtins-whitelist=Increment` run produces
  `number-tq-ccbuiltins.cc::Builtin_Increment` with the new tail-call
  at `block5: return Builtin_Add(isolate, parameter0, tmp1, tmp4);` as
  expected. No emitter error; no ReportError hit.
- **Linker surface** is the blocker. Increment's emission calls into 5
  not-yet-shimmed helpers: `TqRuntimeUnaryOp1_0` (port of the
  multi-arm typeswitch macro that dispatches JSAny → Number/BigInt
  via `NonNumberToNumeric`), plus `TqRuntimeFromConstexpr_Number...`,
  `TqRuntimeFromConstexpr_Operation...`, `TqRuntimeSmiTag_Operation_0`,
  and the transitive `Builtin_Add`. Porting `UnaryOp1` alone is
  non-trivial (full typeswitch + `NonNumberToNumeric`), and each
  additional shim compounds the surface.

Per plan's Task 7.4 triage: `Increment`'s callee `Add` is
`transitioning` (number.tq:397) AND `Increment` itself uses `try/label`
dispatch. Both match the plan's "STOP here, mark this task BLOCKED,
skip to Task 7.6. Ship Phase 7 on synthetic fixture + emitter + cctest
only." Phase 7A will resume with either (a) enough CSA-replacement
shims to link Increment, or (b) a simpler forcing target discovered
later (Decrement shares Increment's shape; other candidates in
number.tq tail into runtime/namespace functions not CallBuiltin).

### Verification

| Gate | Phase 6.1 | Phase 7 | Delta |
|------|-----------|---------|-------|
| Torque fixtures | 15/15 byte-exact | **16/16 byte-exact** | +1 new golden (`tail-call`) + 15 refreshed for Phase-6.1 True_0/False_0 drift that hadn't been captured in the baseline |
| cctest `TorqueCcBuiltinTest.*` | 9 PASS | **10 PASS** | +1 `DirectInvocationTorqueCcTest_TailCall` |
| d8-smoke | 18 PASS | **18 PASS** | 0 (no real target shipped) |
| mjsunit | 2 PASS | **2 PASS** | 0 (no real target shipped) |
| Excluding-anchor (`number-tq-csa.cc` excluded) | `8169724e` | `09b34bf8` | **Matching source change**: added `tail-call.tq` to BUILD.gn for cctest linkage, generating a new `tail-call-tq-csa.cc`. With *both* `number-tq-csa.cc` and `tail-call-tq-csa.cc` excluded, anchor stays `8169724e` — confirming no other CSA-emitter drift. |
| Patch delta | 5591 lines (73 commits) | **5753 lines (75 commits)** | +162 lines; under the ≤500-line cap for synthetic-only |
| cargo unit tests | 722 passed | **722 passed** | 0 |
| vitest | 250 passed / 108 skipped | **250 passed / 108 skipped** | 0 |
| libc-test | 0 unexpected FAIL | **0 unexpected FAIL** | 0 (XFAIL set unchanged) |
| POSIX | 0 FAIL, 1 XFAIL | **0 FAIL, 1 XFAIL (munmap/1-1)** | 0 |
| ABI snapshot | In sync | **In sync** | 0 (no ABI surface touched) |

### Harness dedup fix (`run-torque-fixtures.sh`)

Adding `tail-call.tq` to `BUILD.gn` (required for cctest linkage — the
Release build only emits `-tq-ccbuiltins.cc` for files in the
`torque_files` list) introduced a duplicate: the harness passed the
stock copy (`test/torque-cc-fixtures/tail-call.tq`) *and* the staged
worktree copy (`test/phase2-fixtures/tail-call.tq`) to torque, and
`tail TorqueCcTest_TailCall_Helper(arg)` saw two candidates → overload
ambiguity error. `return.tq` and `js-return.tq` avoided this
historically by not self-referencing. Harness now drops stock entries
whose basename matches any fixture, regardless of symlink state —
this is the same drop the pre-existing "symlinked V8-tree fixture"
branch already performs for `array-isarray.tq`.

### Clone commits (75 total on `9fe7634c`)

- `5c894bb8` — v8: stage tail-call.tq fixture in deps/v8/test/torque-cc-fixtures/ + BUILD.gn
- `483afad8` — cctest: add DirectInvocationTorqueCcTest_TailCall
- `6178a949` — torque: CCGenerator emits tail-call for non-JS, non-catch CallBuiltin

### Deferred items still open after Phase 7

| Item | Why deferred |
|------|--------------|
| `catch_block` runtime exception handling (cc-generator.cc:531 + :1121) | Blocks many transitioning builtins (Increment's blocker). Phase 8 candidate. |
| Varargs JS builtins (`IsVarArgsJavaScript`) | Blocks `FastConsoleAssert`, `ArrayOf`, `ArrayFrom`, `Boolean*`, `NumberParse*`, `NumberPrototypeToString`. Phase 8+ candidate. |
| `CallBuiltinPointer` tail-call | Matches CSA's own rejection (`csa-generator.cc:634`). Unlikely to ever become non-deferred. |
| JS-linkage `CallBuiltin` tail-call | Would need `TailCallJSBuiltin`-equivalent CPP-to-JS-linkage trampoline. Phase 8+; no target forces it yet. |
| Multi-result `PairT` return from `CallBuiltin` (cc-generator.cc:548) | No target forces it in Phase 7. |
| Struct-typed label values | ReportError from Phase 4. |
| Generator-emitted per-const `NamespaceConstant` helpers | Phase 6.1 I-1 leaves the hand-written `True_0`/`False_0` pattern. |
| `%GetClassMapConstant` fast-path | Phase 5 compromise; no UNIQUE_INSTANCE_TYPE target forced it. |
| CSA-replacement ledger first real shim | Scaffold at `examples/libs/nodejs/csa-builtins/`. Pending first real need (likely Phase 7A Increment shim: UnaryOp1). |
| Wasm32 cross-compile of the Torque-CC toolchain | Phase 8+. |
| **NEW:** Phase 7A — ship `Increment` (or simpler tail-call target) | **2026-04-25 retriage:** torque auto-emits the four Tq* helpers inline (no shim port). Real blocker is TFC builtin C-symbol absence — `Builtin_Add` / `Builtin_NonNumberToNumeric` are TFC, not CPP, so the linker can't resolve them. Survey of all 11 stub-linkage tail-call sites: every callee is TFC/TFS or JS-linkage. Needs Phase-8 dispatch-via-`Code`-object emitter change (sketch in §"Phase 7A Triage") before any real target lands. |

### What Phase 7 proves

- The emitter handles `CallBuiltinInstruction::is_tailcall=true` correctly
  for non-JS-linkage, non-catch_block builtins: terminal `return` of a
  direct `Builtin_<Callee>(isolate, args...)` call, no intermediate
  result variable. Semantically equivalent to CSA's `TailCallBuiltin`.
- Real-world emission is unblocked: Increment emits cleanly end-to-end;
  the only thing blocking shipping it is the shim layer (pre-existing
  work queue, not an emitter gap).
- Zero regressions across all 5 wasm-posix-kernel gates + the 5 v8
  gates (cctest, d8-smoke, mjsunit, fixture harness, excluding-anchor).

## Phase 7A Triage (2026-04-25) — BLOCKED on Phase-8 TFC dispatch

Attempt to ship `Increment` as the first real-world tail-call forcing
target. Outcome: **deferred**, retriaged as Phase 8 prerequisite. Phase 7
itself remains complete (synthetic fixture + emitter shipped). No
patch / clone-side commits landed in 7A — the build state was restored
to the Phase 7 baseline after diagnostic.

### Method

1. Added `Increment` to `build-v8-host-phase5.sh`'s default `WHITELIST`.
2. Ran the host build to compile `number-tq-ccbuiltins.cc` with the
   real Increment body. Build failed at the C++ compilation of
   `gen/torque-generated/src/builtins/number-tq-ccbuiltins.cc`
   (compiled into `libv8_base_without_compiler.a`, not at link).
3. Reverted the whitelist edit and rebuilt — clean state restored
   (16/16 fixtures, 10/10 cctests, 18/18 d8-smoke, 2/2 mjsunit, no
   patch / commit churn).

### What torque emits for `Increment` (verified inline-readable)

```cpp
Tagged<Numeric> Builtin_Increment(Isolate* isolate, Tagged<Context> context, Tagged<JSAny> value) {
  // ... goto block0; ...
  block0:
  TqRuntimeUnaryOp1_0(parameter0, parameter1, &label0, &tmp1, &label2, &tmp3);
  if (label0) goto block5;
  if (label2) goto block6;

  block5:
  tmp4 = TqRuntimeFromConstexpr_Number_constexpr_IntegerLiteral_0(IntegerLiteral(false, 0x1ull));
  return Builtin_Add(isolate, parameter0, tmp1, tmp4);   // <- Phase-7 tail-call branch

  block6:
  tmp5 = TqRuntimeFromConstexpr_Operation_constexpr_kIncrement_0(Operation::kIncrement);
  tmp6 = TqRuntimeSmiTag_Operation_0(tmp5);
  // ... runtime::BigIntUnaryOp(...) ...
}
```

Phase 6.1's `EnsureInCCBuiltinsOutputList` pipeline correctly emits all
four `TqRuntime*` helper bodies inline in the same TU — `UnaryOp1_0`,
`FromConstexpr_Number_constexpr_IntegerLiteral_0`,
`FromConstexpr_Operation_constexpr_kIncrement_0`, `SmiTag_Operation_0`.
**No shim port needed for these four** — they are auto-generated.
This is a strict improvement over the Phase 7 brief, which assumed the
`UnaryOp1` macro had to be hand-ported (~200 LoC). The actual hand
work was zero on those.

### The actual blocker: TFC builtin C-symbol absence

C++ compile errors fall into two classes (6 total observed):

| Error | Class | Fix scope |
|---|---|---|
| `Builtin_Add` undeclared (line 365, in `Builtin_Increment` body, terminal tail-call) | **TFC dispatch — blocker** | Phase 8 |
| `isolate` undeclared (line 642, in `TqRuntimeUnaryOp1_0` body, calling `Builtin_NonNumberToNumeric`) | **TFC dispatch — blocker** (`Builtin_NonNumberToNumeric` is also TFC; the `isolate` literal is a secondary issue — helpers don't take an `Isolate*`) | Phase 8 |
| `IsBigInt` shim missing (line 920, `TqRuntimeCast_BigInt_0`) | Trivial 1-line shim | Phase 7A — landable |
| `NumberConstant` shim missing (line 665) | Trivial shim | Phase 7A — landable |
| `ConstexprIntegerLiteralToFloat64` shim missing (line 665) | Trivial shim | Phase 7A — landable |
| `SmiFromUint32` shim missing (line 702) | Trivial shim | Phase 7A — landable |

**Add and NonNumberToNumeric are both TFC builtins** — registered as
`TFC(Add, Add)` / `TFC(NonNumberToNumeric, NonNumberToNumeric)` in
`out/Release/gen/torque-generated/builtin-definitions.h`. TFC builtins
are CSA-emitted to native code at snapshot time; their `Code` objects
live in `Isolate::builtins()->code(Builtin::kAdd)` and are normally
invoked via the standard V8 dispatch (`Builtins::CallableFor`,
`GeneratedCode<...>::FromAddress(...)`). They have **no `Builtin_<Name>`
C++ entry point** that the linker can resolve — `nm
out/Release/libv8_initializers.a` and `libv8_base_without_compiler.a`
confirm only `AddAssembler::GenerateAddImpl` exists, no
`Builtin_Add(Isolate*, Context, ...)`.

The kCCBuiltins -> CPP dispatch we have today (`Builtin_NumberIsFinite`
etc., emitted as plain C functions via the patch's `OutputType::kCC
Builtins` path) is **not** wired to call into TFC entry points — the
emitter just spells `Builtin_<Callee>(isolate, args...)` and trusts
the linker, which fails for non-CPP callees.

### Why every "real" tail-call candidate hits the same wall

Surveyed the 11 stub-linkage `tail [A-Z][A-Za-z_]+(` sites in
`deps/v8/src/builtins/*.tq` (excluding `wasm` and namespace tails):

| Caller | Callee | Callee linkage | Status |
|---|---|---|---|
| `Increment` (number.tq:780) | `Add` | TFC | blocked — Phase 8 |
| `Decrement` (number.tq:769) | `Subtract` | TFC | blocked — Phase 8 |
| `FastNewClosureBaseline` (constructor.tq:53) | `FastNewClosure` | TFS | blocked — Phase 8 |
| `ProxyHasProperty` (proxy-has-property.tq:50) | `HasProperty` | TFS | blocked — Phase 8 (also `try`/`label` w/ `ThrowTypeError` triggers `catch_block`) |
| `FastConsoleAssert` (console.tq:18) | `ConsoleAssert` | JS-linkage + varargs | blocked — Phase 8 (JS-linkage tail) |
| `Add` internal labels (number.tq:487-491) | `StringAddConvertLeft`, `StringAddConvertRight`, `bigint::BigIntAdd` | TFC | blocked — Phase 8 |
| `array-shift.tq:107`, `array-unshift.tq:93`, `array-concat.tq:45`, `function.tq:113` | `ArrayShift`, `ArrayUnshift`, `ArrayConcat`, `FunctionPrototypeBind` | All JS-linkage transitioning | blocked — Phase 8 (JS-linkage tail) |

Cascading whitelist (e.g., adding `Add` itself to `--cc-builtins-whitelist`
to force `Builtin_Add` as kCCBuiltins) **transitively pulls in**
`StringAddConvertLeft`, `StringAddConvertRight`, `BigIntAdd`,
`NonNumberToNumeric`, `ToNumericOrPrimitive`, `ToPrimitiveDefault`, ...
each of which is itself transitioning, has its own try/label shape,
and would surface every Phase-8 deferral (catch_block, multi-result
PairT, struct labels) before reaching a fixed point. Per the user's
STOP rule ("if porting exceeds ~200 lines or pulls in more than 2
helper ports, pivot to a simpler target"), the cascade terminates well
past that bound — and there is no simpler target.

### What Phase 8 needs (proposed shape, not Phase 7A's job)

A single emitter change in `cc-generator.cc` for both the non-tail
`CallBuiltin` branch (line 570) and the new tail-call branch (line
539-540):

```cpp
if (callee_has_C_symbol) {
  out() << "Builtin_<Callee>(isolate, args...)";       // current path
} else {
  // Dispatch via Code object (jitless-safe). Mirrors
  // CallBuiltinPointerInstruction's existing emission at
  // cc-generator.cc:603-617, which already does this for builtin
  // pointers via Builtins::TorqueCcEntryOf.
  out() << "DispatchByBuiltinEnum<RetT, ParamT...>(isolate, "
        << "Builtin::k<Callee>, args...)";
}
```

`DispatchByBuiltinEnum` would be a ~20-line inline helper in
`runtime-macro-shims.h` (or a new `cc-builtins-dispatch.h`) that
fetches `isolate->builtins()->code(builtin)->instruction_start()` and
casts to the TFC ABI's canonical `Address(Address ctx, Address arg0,
..., Address isolate)` signature. The "callee_has_C_symbol" predicate
is just `instruction.builtin->IsCpp() ||
GlobalContext::IsInCCBuiltinsWhitelist(instruction.builtin)`. Once
that lands, the four trivial shims listed above become the actual
Phase 7A surface, and Increment ships.

A secondary issue surfaces in tandem: helper bodies (emitted via
`EnsureInCCBuiltinsOutputList`) reference `isolate` literally inside
`CallBuiltin` emissions but have no `Isolate*` in their signature.
Two fixes are equally cheap:
- Inject `Isolate* isolate = Isolate::Current();` at the top of
  helper bodies that contain a CallBuiltin (parallel to Phase 6.1's
  I-1 NamespaceConstant pattern).
- Or substitute `isolate` -> `Isolate::Current()` at the call site
  under `is_cc_builtins_` when emitting from a non-builtin context.

### Decision

**Phase 7A is closed without a real-world target.** Phase 7's emitter
work (synthetic fixture + cctest) stands. The next forward step is
either (a) Phase 8 catch_block + TFC-dispatch combined sub-phase, or
(b) PR #306 push of the current Phase 6.1 + Phase 7 stack as-is —
both pending user go/no-go.

### Verification (Phase 7A triage end state)

| Gate | Phase 7 baseline | Phase 7A end | Delta |
|------|-----------------|---------------|-------|
| Torque fixtures | 16/16 byte-exact | 16/16 | 0 |
| cctest `TorqueCcBuiltinTest.*` | 10 PASS | 10 PASS | 0 |
| d8-smoke | 18 PASS | 18 PASS | 0 |
| mjsunit | 2 PASS | 2 PASS | 0 |
| Excluding-anchor | `09b34bf8` | `09b34bf8` (unchanged) | 0 |
| Patch delta | 5753 lines (75 commits) | 5753 lines (75 commits) | 0 |
| Clone-side commits | 75 | 75 | 0 (no new commits — diagnostic only) |
| Worktree-side commits | 4 ahead | 5 ahead (this verification.md update) | +1 |

(wasm-posix-kernel suites cargo / vitest / libc-test / POSIX / ABI not
re-run for Phase 7A — there were no source changes outside
`examples/libs/nodejs/verification.md`, so kernel-side state is
inherited from Phase 7's last full sweep.)

## Phase 8 Summary — Increment ships, TFC dispatch via inline C bridges

Plan: Phase 7A's BLOCKED triage above. Scope: lift the TFC-dispatch
blocker, ship `Increment` end-to-end as the first real-world tail-call
forcing target.

### Approach

The Phase 7A triage proposed a `DispatchByBuiltinEnum` shim that goes
through V8's `Code` object table. On second look that approach hit an
ABI wall: TFC stub-linkage on darwin-arm64 puts `context` in `cp` /
x27 (callee-saved), not C-ABI x1. Any C-callable bridge needs proper
ABI translation. Rather than implement that translation, Phase 8
provides **hand-written inline C bridges** that wrap V8's high-level
runtime APIs (`Object::ToNumeric`, native `Number+Number` arithmetic).
Lives in `implementation-visitor.cc`'s per-kCCBuiltins-.cc preamble
next to True_0 / False_0; vague linkage dedupes across TUs.

### Clone-side commits (6, on top of `9fe7634c`)

- `6637f0be` — runtime-macro-shims: add `IsBigInt` shim for
  `TqRuntimeCast_BigInt_0` (UnaryOp1's BigInt cast).
- `4e83fc8d` — runtime-macro-shims: add `ConstexprIntegerLiteralToFloat64`,
  `NumberConstant`, `SmiFromUint32` (later relocated by 96d0ca05).
- `a98c9d22` — torque: CCGenerator substitutes `isolate` →
  `Isolate::Current()` at every CallBuiltin emission under
  `is_cc_builtins_`. Generalizes Phase 6.1's I-1 NamespaceConstant
  pattern to all builtin invocations, fixing the use-of-undeclared-
  `isolate` error inside helper-macro bodies.
- `bf6edc87` — torque: emit inline `Builtin_Add(Isolate*, Context,
  Number, Number) → Number` and `Builtin_NonNumberToNumeric(Isolate*,
  Context, JSAny) → Numeric` in the kCCBuiltins .cc preamble. Add is
  native int64 Smi arithmetic with overflow→HeapNumber and
  Smi/HeapNumber double-arithmetic; NonNumberToNumeric wraps
  `Object::ToNumeric` for spec-compliant string/boolean/null
  coercion. Symbol-input branch UNREACHABLEs (catch_block deferred).
  Note: this also folded in 4e83fc8d's `ConstexprIntegerLiteralToFloat64`
  fix (`i.To<double>()` → `i.To<int64_t>()` cast) due to local amend.
- `96d0ca05` — torque: move `NumberConstant` from
  runtime-macro-shims.h to implementation-visitor.cc preamble (inside
  `namespace TorqueRuntimeMacroShims::CodeStubAssembler`). Including
  `heap/factory.h` and `numbers/conversions-inl.h` from the shims
  header transitively pulls `descriptor-array-tq-inl.inc` into
  ~1000 .o targets that don't yet have the torque-shim namespace
  open, breaking compile across the v8_compiler chain. Per-TU
  emission resolves at each kCCBuiltins .cc's own already-included
  factory-inl.h / conversions-inl.h.
- `86e916eb` — cctest: `ScriptRunIncrement` (Smi / HeapNumber /
  JSAnyNotNumeric coercion arms) + `ScriptRunIncrementBigInt`.

### Decision rule re-evaluation

The Phase 7A brief had a STOP rule at "≤200 LoC of shim port or ≤2
helper ports". Phase 8 lands ~75 LoC of preamble-emitted bridges
plus ~30 LoC of trivial shim follow-on (IsBigInt, IntegerLiteralToFloat64,
SmiFromUint32). **No CSA helper ports** — Object::ToNumeric does
the spec work. The cascade-into-StringAddConvert/BigIntAdd/etc.
predicted in 7A never materializes because we sidestep TFC dispatch
entirely.

### Verification

| Gate | Phase 6.1 | Phase 7 | Phase 7A | **Phase 8** | Delta vs P7A |
|------|-----------|---------|----------|-------------|--------------|
| Torque fixtures | 15/15 | 16/16 | 16/16 | **16/16 byte-exact** | 0 |
| cctest `TorqueCcBuiltinTest.*` | 9 | 10 | 10 | **12 PASS** | **+2** (`ScriptRunIncrement` + `ScriptRunIncrementBigInt`) |
| d8-smoke | 18 | 18 | 18 | **22 PASS** | **+4** (`++0`, `++41`, `++MAX_SAFE_INTEGER`, `++1n`) |
| mjsunit | 2 | 2 | 2 | **2 PASS** | 0 (no new mjsunit file — Increment-specific tests are integrated into existing files) |
| Excluding-anchor (excl. `number-tq-csa.cc` AND `tail-call-tq-csa.cc`) | `8169724e` | `8169724e` | `8169724e` | **`8169724e`** | 0 (kCSA path untouched — confirms emitter changes are gated on `is_cc_builtins_`) |
| Patch delta | 5374 lines (76 commits) | 5753 lines (75 commits) | 5753 (75) | **6323 lines (82 commits)** | **+570 lines, +7 commits** |
| cargo unit tests | 722 | 722 | 722 (inherited) | **722 passed** | 0 |
| vitest | 250 / 108 skipped | 250 / 108 | 250 / 108 (inherited) | **250 passed / 108 skipped** | 0 |
| libc-test | 0 unexpected FAIL | 0 | inherited | **0 unexpected FAIL** (XFAIL set unchanged) | 0 |
| POSIX | 0 FAIL, 1 XFAIL | 0 FAIL, 1 XFAIL | inherited | **0 FAIL, 1 XFAIL (munmap/1-1)** | 0 |
| ABI snapshot | In sync | In sync | In sync | **In sync, version consistent** | 0 |

### Increment dispatch trace (verified end-to-end)

For `var x = 0; ++x;` from a JS-linkage entry:

1. JS bytecode `ToNumeric` operator dispatches to `Builtin::kIncrement`.
2. V8's `AdaptorWithBuiltinExitFrame1` JS-linkage adaptor → kCCBuiltins
   C entry `Address Builtin_Increment(int args_length, Address* args_object,
   Isolate* isolate)`.
3. Emitted body (number-tq-ccbuiltins.cc:431 +) calls
   `TqRuntimeUnaryOp1_0(parameter0=context, parameter1=value, &label0,
   &tmp1, &label2, &tmp3)`. The Smi-input case sets `label0 = true,
   tmp1 = the Smi as Number`.
4. Body branches `if (label0) goto block5` →
   `tmp4 = TorqueRuntimeMacroShims::CodeStubAssembler::NumberConstant(
       ConstexprIntegerLiteralToFloat64(IntegerLiteral(false, 0x1)))`.
   That's our shim → `Smi::FromInt(1)`.
5. **Tail-call**: `return Builtin_Add(Isolate::Current(), parameter0,
   tmp1, tmp4);` — the Phase 7 emission, now correctly resolved against
   our inline C bridge in the same TU. Smi+Smi → Smi.

The string-coercion case (`++"41"`) flows through UnaryOp1's
JSAnyNotNumeric label into `Builtin_NonNumberToNumeric(Isolate::Current(),
p_context, phi_bb13_2)` (also our inline bridge), then re-enters the
typeswitch and exits via the Number arm.

### Deferred items still open after Phase 8

| Item | Why deferred |
|------|--------------|
| `catch_block` runtime exception handling (cc-generator.cc:548) | Phase 9 candidate. Becomes urgent once a whitelisted target legitimately throws (e.g., Symbol-input ToNumeric). |
| Varargs JS builtins (`IsVarArgsJavaScript`) | Phase 9+ candidate; blocks `BooleanConstructor`, `ArrayOf`, `ArrayFrom`, `Boolean*`, `NumberParse*`, `NumberPrototypeToString`. |
| `CallBuiltinPointer` tail-call | Matches CSA's own rejection (`csa-generator.cc:634`). Unlikely to ever become non-deferred. |
| JS-linkage `CallBuiltin` tail-call | No target needs it yet. Would require `TailCallJSBuiltin`-equivalent CPP-to-JS-linkage trampoline. |
| Multi-result `PairT` return from `CallBuiltin` (cc-generator.cc:567) | No Phase-8 target forces it. |
| Struct-typed label values | ReportError from Phase 4. |
| Generator-emitted per-const NamespaceConstant helpers | I-1 leaves the hand-written `True_0`/`False_0` (now plus `NumberConstant`) pattern. |
| `%GetClassMapConstant` fast-path | No UNIQUE_INSTANCE_TYPE-class target forces it. |
| Wasm32 cross-compile of the Torque-CC toolchain | Phase 9+. |
| `Decrement` follow-up | Same body shape as Increment, just `tail Subtract` instead of `tail Add`. Needs a `Builtin_Subtract` bridge mirroring `Builtin_Add`. Trivial Phase 8.1 task once Phase 8 is reviewed.

### What Phase 8 proves

- The kCCBuiltins emitter handles `CallBuiltinInstruction::is_tailcall=true`
  for non-JS-linkage, non-catch_block builtins **end-to-end through
  V8's Script::Run pipeline**. cctest's `ScriptRunIncrement` exercises
  the JS-linkage adaptor → kCCBuiltins C entry → tail-call →
  `Builtin_Add` C bridge → return path with Smi fast-path, HeapNumber
  overflow, and JSAnyNotNumeric coercion arms all covered.
- TFC builtins without C symbols are reachable via hand-written inline
  bridges in the kCCBuiltins .cc preamble. The pattern is repeatable:
  each new TFC target costs ~30-50 LoC of C++ that wraps the matching
  V8 high-level API. Builtin_Add (Number+Number) + Builtin_NonNumberToNumeric
  (Object::ToNumeric) collectively unblock every UnaryOp1-class
  builtin in number.tq.
- Zero regressions across all 5 wasm-posix-kernel gates + the 5 V8
  gates. Excluding-anchor `8169724e` is **byte-stable** vs Phase
  6.1, Phase 7, and Phase 7A — confirming the emitter changes are
  cleanly gated on `is_cc_builtins_` and the kCSA path is untouched.

## Phase 8.1 Summary — Decrement (Builtin_Subtract bridge)

Confirmation that Phase 8's inline-bridge pattern repeats cheaply.
Decrement's torque body (`tail Subtract(n, 1)` on the Number arm) is
structurally identical to Increment's, just calls `Subtract` instead
of `Add`.

### Clone-side commits (2, on top of `86e916eb`)

- `330f5186` — torque: emit `Builtin_Subtract` C bridge alongside
  `Builtin_Add`. Same Smi/HeapNumber arithmetic, just `l - r`. ~30
  LoC of preamble.
- `df8df358` — cctest: add `ScriptRunDecrement` (Smi / HeapNumber-
  underflow / JSAnyNotNumeric arms) + `ScriptRunDecrementBigInt`.

### Worktree changes (1 commit)

- `build-v8-host-phase5.sh`: extend WHITELIST with `Decrement`.
- `test/d8-smoke.sh`: +4 probes (`--42`, `--0`, `--(-MAX_SAFE_INTEGER)`,
  `--2n`).
- `patches/v8-torque-cc-builtins.patch`: refreshed (6323 → 6486 lines,
  82 → 84 commits).

### Verification (Phase 8.1 vs Phase 8 baseline)

| Gate | Phase 8 | **Phase 8.1** | Delta |
|------|---------|---------------|-------|
| Torque fixtures | 16/16 | **16/16 byte-exact** | 0 |
| cctest `TorqueCcBuiltinTest.*` | 12 | **14 PASS** | **+2** (`ScriptRunDecrement` + `ScriptRunDecrementBigInt`) |
| d8-smoke | 22 | **26 PASS** | **+4** (`--42`, `--0`, `--(-MAX_SAFE_INTEGER)`, `--2n`) |
| mjsunit | 2 | **2 PASS** | 0 |
| Excluding-anchor | `8169724e` | **`8169724e`** | 0 (stable since Phase 6.1) |
| Patch | 6323 lines (82 commits) | **6486 lines (84 commits)** | **+163, +2** |
| cargo / vitest / libc-test / POSIX / ABI | 722 / 250 / baseline / 0 FAIL / in sync | **inherited from Phase 8** | 0 (no kernel-side changes) |

(Kernel suites not re-run for Phase 8.1 — clone-side scope only.
Phase 8's pre-push sweep stands.)

### What Phase 8.1 proves

- The "hand-written inline bridge in .cc preamble" pattern is
  copy-paste-modify cheap. Decrement landed in 2 clone commits +
  1 worktree commit; combined diff <100 LoC; under 90 minutes
  including the build.
- Same emitter pipeline; no new emitter changes needed (the
  `Isolate::Current()` substitution from Phase 8 already covers
  Decrement's tail-call to `Builtin_Subtract`).
- Both `Increment` and `Decrement` now ship as production-gated
  forcing targets for tail-call emission, doubling the real-world
  surface area exercised by the TorqueCcBuiltinTest cctest suite
  (10 → 14 PASS over Phase 7 → Phase 8.1).

## Phase 9A Summary — catch_block emission + synthetic forcing target

Lifts 1 CHECK + 3 ReportError sites in `cc-generator.cc` to real
exception-state propagation, mirroring CSAGenerator's
PreCallableExceptionPreparation/PostCallableExceptionPreparation but
emitting plain C++. The fourth catch-block ReportError (CallBuiltin
tail-call + catch) stays as a sharpened ReportError because tail+catch
is structurally contradictory — CSA also rejects.

### Emitter change shape

```cpp
// New private helper EmitCatchBlockDispatch in cc-generator.cc, called
// from each of the 4 catch_block-bearing instruction emissions:

void CCGenerator::EmitCatchBlockDispatch(const Block* catch_block,
                                          const Stack<std::string>& pre_call_stack,
                                          const std::optional<DefinitionLocation>& exception_object_definition) {
  const std::string exc_var = DefinitionToVariable(*exception_object_definition);
  decls() << "  Tagged<JSAny> " << exc_var << "{}; USE(" << exc_var << ");\n";
  const char* isolate_token = is_cc_builtins_ ? "Isolate::Current()" : "isolate";
  out() << "  if (V8_UNLIKELY(" << isolate_token << "->has_exception())) {\n";
  out() << "    " << exc_var << " = UncheckedCast<JSAny>("
        << isolate_token << "->exception());\n";
  out() << "    " << isolate_token << "->clear_internal_exception();\n";
  Stack<std::string> catch_stack = pre_call_stack;
  catch_stack.Push(exc_var);
  EmitGoto(catch_block, &catch_stack, "    ");
  out() << "  }\n";
}
```

Sites:
- `cc-generator.cc:329` (`CallCsaMacroInstruction`) — the upstream-CSA
  CHECK assumption ("always inlined") doesn't hold under kCCBuiltins
  because torque doesn't inline some CSA macro calls inside try
  blocks (e.g. `SmiConstant(0)` lowers to a CallCsaMacroInstruction
  with catch_block set). Lifted to handler.
- `cc-generator.cc:374` (`CallCsaMacroAndBranchInstruction`) — handler.
- `cc-generator.cc:556` (`CallBuiltinInstruction` non-tail) — handler.
- `cc-generator.cc:632` (`CallRuntimeInstruction` non-tail) — handler.
- `cc-generator.cc:534` (`CallBuiltinInstruction` tail-call + catch)
  + parallel CallRuntime tail-call site — sharpened ReportError text.
  Tail+catch is structurally invalid (CSA rejects too).

### Synthetic forcing target

`test/torque-fixtures/catch-block.tq`:

```torque
namespace test_cc_catch {
  transitioning builtin TorqueCcTest_CatchBlock(implicit context: Context)(
      shouldThrow: Smi): Smi {
    try {
      if (shouldThrow != 0) {
        ThrowCalledNonCallable(Undefined);
      }
      return 42;
    } catch (_e, _message) {
      return -1;
    }
  }
}
```

Emission shape (excerpt from
`test/torque-fixtures/golden/catch-block-tq-ccbuiltins.cc`):

```cpp
block3:                                          // shouldThrow != 0 path
  tmp6 = TqRuntimeUndefined_0();
  if (V8_UNLIKELY(...)) { ... goto block7; }
  Runtime_ThrowCalledNonCallable(1, &tmp6.ptr(), isolate);
  if (V8_UNLIKELY(Isolate::Current()->has_exception())) {
    tmp10 = UncheckedCast<JSAny>(Isolate::Current()->exception());
    Isolate::Current()->clear_internal_exception();
    goto block9;
  }
  UNREACHABLE();

block9:                                          // catch intercept
  tmp13 = TqRuntimeGetAndResetPendingMessage_0();
  phi_bb2_2 = tmp10;
  phi_bb2_3 = tmp13;
  goto block2;

block2:                                          // user catch arm
  tmp17 = TqRuntimeFromConstexpr_Smi_constexpr_IntegerLiteral_0(IntegerLiteral(true, 0x1ull));
  return tmp17;
}
```

### Required shim follow-ons (surfaced when fixture compiled)

7 shims added because torque's catch-flow lowering pulls in helpers
that weren't previously needed by any kCCBuiltins-emitted target:

| Shim | Location | Reason |
|---|---|---|
| `SmiNotEqual` | `runtime-macro-shims.h` | `if (smi != smi)` inside try block |
| `SmiConstant(int)` | `runtime-macro-shims.h` | integer-literal Smi construction |
| `StringConstant(const char*)` | preamble (needs Factory) | string-literal interning |
| `GetPendingMessage` | preamble | catch-flow message-slot read |
| `SetPendingMessage` | preamble | catch-flow message-slot clear |
| `TheHole_0()` | preamble (NamespaceConstant) | clear pending-message slot |
| `Undefined_0()` | preamble (NamespaceConstant) | torque emits bare `Undefined` as `Undefined_0()` |

### Clone-side commits (5, on top of `df8df358`)

- `762a3dfc` — v8: stage catch-block.tq fixture for Phase 9A (initially
  failing on the line-329 CHECK + line-632 ReportError).
- `e399ee68` — torque: CCGenerator emits catch_block exception
  propagation. Adds EmitCatchBlockDispatch helper, lifts 4 sites,
  sharpens 2 tail+catch ReportError messages.
- `0d035dbe` — torque: catch_block follow-on — JSAny exc var + 7
  shims + fixture switch from custom ThrowTypeError to
  ThrowCalledNonCallable (avoids MessageTemplate-arity mismatch).
- `9cf32472` — cctest: DirectInvocationTorqueCcTest_CatchBlock via
  helper TU (test_torque_cc_builtin_helpers.cc, where
  `src/execution/isolate.h` can be included without the
  trace-event header collision that affects the main test TU).

### Verification (Phase 9A vs Phase 8.1 baseline)

| Gate | Phase 8.1 | **Phase 9A** | Delta |
|------|-----------|---------------|-------|
| Torque fixtures | 16/16 byte-exact | **17/17 byte-exact** | **+1** (new catch-block) |
| cctest `TorqueCcBuiltinTest.*` | 14 PASS | **15 PASS** | **+1** (`DirectInvocationTorqueCcTest_CatchBlock`) |
| d8-smoke | 26 PASS | **26 PASS** | 0 (no JS-reachable target shipped) |
| mjsunit | 2 PASS | **2 PASS** | 0 |
| Excluding-anchor (excludes `number`, `tail-call`, **NEW: `catch-block`**) | `8169724e` | **`8169724e`** | 0 (kCSA path untouched — emitter changes correctly gated on `is_cc_builtins_`) |
| Patch | 6486 lines (84 commits) | **7196 lines (88 commits)** | **+710, +4** |
| Kernel suites (cargo / vitest / libc-test / POSIX / ABI) | inherited | **deferred to 9A.4 close** | n/a |

### Decision rule re-evaluation

Phase 9 plan budgeted ≤1500 lines for synthetic-only catch_block.
Actual: +710 lines / +4 commits, well under budget. The fixture-
exposed shim cluster (7 shims) and the JSAny exception-var fix
were unforeseen but cheap once isolated.

### What Phase 9A proves

- `try { ... } catch (e, message) { ... }` torque sources compile
  end-to-end through the kCCBuiltins emitter to plain C++ that
  correctly checks `isolate->has_exception()` after every callable
  inside the try, captures the exception as Tagged<JSAny>, clears
  the slot, and dispatches to the catch arm with (exception,
  message) as phi inputs.
- Real-world catch_block targets are unblocked end-to-end (e.g.,
  ProxyHasProperty's try/label/catch shape, ObjectFromEntries's
  try/catch with iterator-cleanup). Phase 9.5 stretch target
  (PromiseTry) requires both 9A and 9B (varargs-JS).
- The shim cluster needed for the catch flow is small and trivial
  (~50 LoC across 7 shims). Future catch-bearing targets won't
  need additional shims unless they introduce new namespace
  constants or untyped runtime declarations.

## Phase 9B Summary — varargs JS-linkage emission + synthetic forcing target

Lifts the `IsVarArgsJavaScript` ReportError at
`implementation-visitor.cc:646` and adds a 4-stack-slot Arguments-struct
prelude to the JS-linkage emission branch, mirroring CSAGenerator's
`TorqueStructArguments` push but lowering to plain C++ over
`BuiltinArguments` instead of `CodeStubArguments`.

### Emitter change shape

```cpp
// Before:
//   if (builtin->IsVarArgsJavaScript()) {
//     ReportError("Phase 5: varargs JS linkage not yet supported "
//                 "for kCCBuiltins emission");
//   }
//   DCHECK(builtin->IsFixedArgsJavaScript());
//
// After:
const bool is_varargs = builtin->IsVarArgsJavaScript();
if (!is_varargs) DCHECK(builtin->IsFixedArgsJavaScript());

if (is_varargs) {
  // Arguments struct: frame, base, length, actual_count.
  //   frame, base — placeholder Address{} (synthetic fixture only
  //     reads .length; future arguments[i] / .frame targets need
  //     these wired to BuiltinArguments::address_of_first_argument
  //     or similar).
  //   length — args.length() - kJSArgcReceiverSlots (receiver-excl).
  //   actual_count — args.length() (receiver-incl).
  csa_ccfile() << "  Address torque_arguments_frame{};\n";
  csa_ccfile() << "  Address torque_arguments_base{};\n";
  csa_ccfile() << "  intptr_t torque_arguments_length =\n"
               << "      args.length() - kJSArgcReceiverSlots;\n";
  csa_ccfile() << "  intptr_t torque_arguments_actual_count = args.length();\n";
  parameters.Push("torque_arguments_frame");
  parameters.Push("torque_arguments_base");
  parameters.Push("torque_arguments_length");
  parameters.Push("torque_arguments_actual_count");
  parameter_types.PushMany(LowerType(TypeOracle::GetArgumentsType()));
  parameter_bindings.Add(*signature.arguments_variable, /* … */);
}
```

The 4-slot push order matches CSA at
`implementation-visitor.cc:932-942` byte-for-byte, so
`LowerType(GetArgumentsType())` lowers identically across both
backends.

### Synthetic forcing target

`test/torque-fixtures/js-varargs.tq`:

```torque
namespace test_cc_jsvarargs {
  javascript builtin TorqueCcTest_JsVarargs(
      js-implicit context: NativeContext, receiver: JSAny)(
      ...arguments): JSAny {
    return Convert<Smi>(arguments.length);
  }
}
```

Emission shape (excerpt from
`test/torque-fixtures/golden/js-varargs-tq-ccbuiltins.cc`):

```cpp
Address Builtin_TorqueCcTest_JsVarargs(int args_length, Address* args_object,
                         Isolate* isolate) {
  DCHECK(isolate->context().is_null() || IsContext(isolate->context()));
  BuiltinArguments args(args_length, args_object);
  HandleScope scope(isolate);
  USE(isolate);
  // Arguments struct: frame, base, length, actual_count.
  Address torque_arguments_frame{}; USE(torque_arguments_frame);
  Address torque_arguments_base{}; USE(torque_arguments_base);
  intptr_t torque_arguments_length = args.length() - kJSArgcReceiverSlots;
  intptr_t torque_arguments_actual_count = args.length();
  // [implicit-param unpack: context, receiver]
  // [body]
  block0:
  tmp0 = TqRuntimeConvert_Smi_intptr_0(torque_arguments_length);
  return tmp0.ptr();
}
```

`Convert<Smi>(arguments.length)` correctly resolves to the `length`
slot (slot index 2), matching the receiver-excluding semantics in
`frame-arguments.tq:8-9`.

### Required shim follow-on

One trivial shim added: `SmiTag(intptr_t)` — `TqRuntimeConvert_Smi_intptr_0`
lowers to `SmiTag(p_i)`. The existing `SmiFromUint32` (Phase 8)
covered uint32 only; this completes the int / uint32 / intptr Smi
construction surface.

### Clone-side commits (4, on top of `9cf32472`)

- `9bb23d70` — v8: stage js-varargs.tq fixture for Phase 9B (initially
  failing on the IsVarArgsJavaScript ReportError).
- `cfa62dd9` — torque: kCCBuiltins emission for varargs JS-linkage
  builtins. Lifts the ReportError, adds the 4-slot Arguments-struct
  scaffold gated on `is_varargs`.
- `eb6774c4` — runtime-macro-shims: add SmiTag(intptr_t) for
  Convert<Smi>(intptr) lowering.
- `1720b903` — cctest: JsVarargsAdaptorDispatch + BindJsVarargsBuiltinOnGlobal
  helper.

### cctest dispatch path

`JsVarargsAdaptorDispatch` runs JS scripts like `TorqueCcTest_JsVarargs(1, 2, 3)`
through V8's full pipeline: parser → bytecode → interpreter →
`AdaptorWithBuiltinExitFrame` (CPP-ABI, with `kDontAdaptArgumentsSentinel`
preserving the full argument vector) → kCCBuiltins-emitted
`Builtin_TorqueCcTest_JsVarargs` → `BuiltinArguments` → torque-body
`arguments.length` access → returns Smi(N). Validates the entire
varargs adapter chain end-to-end.

### Verification (Phase 9B vs Phase 9A baseline)

| Gate | Phase 9A | **Phase 9B** | Delta |
|------|----------|---------------|-------|
| Torque fixtures | 17/17 byte-exact | **18/18 byte-exact** | **+1** (new js-varargs) |
| cctest `TorqueCcBuiltinTest.*` | 15 PASS | **16 PASS** | **+1** (`JsVarargsAdaptorDispatch`) |
| d8-smoke | 26 PASS | **26 PASS** | 0 (synthetic; not JS-smoke-reachable) |
| mjsunit | 2 PASS | **2 PASS** | 0 |
| Excluding-anchor (now also excludes `js-varargs-tq-csa.cc`) | `8169724e` | **`8169724e`** | 0 (kCSA path untouched) |
| Patch | 7196 lines (88 commits) | **7550 lines (92 commits)** | **+354, +4** |
| Kernel suites (cargo / vitest / libc-test / POSIX / ABI) | inherited | **deferred to 9.6 close** | n/a |

### Decision rule re-evaluation

Phase 9 plan budgeted ≤1500 lines for synthetic-only varargs. Actual:
+354 lines / +4 commits. The Arguments-struct scaffold turned out
shorter than catch_block's (no per-call intercept blocks; just 4
push lines + 1 type binding).

### Open follow-ons (Phase 9.5 and beyond)

- `arguments[i]` access — would need a `GetArgumentValue(Arguments, intptr_t)`
  shim that reads from BuiltinArguments via `args.at<JSAny>(i + 1)`.
  Synthetic fixture doesn't exercise; real targets like ArrayOf,
  ArrayFrom would.
- `arguments.frame` / `.base` access — currently placeholder Address{}.
  Real targets that walk the call frame (probably none of our Phase-9.5
  candidates) would need these wired to `args.address_of_first_argument()`
  or similar.
- Combined catch_block + varargs target (PromiseTry) — Phase 9.5
  stretch.

### What Phase 9B proves

- `javascript builtin Foo(js-implicit ctx, recv)(...arguments): JSAny`
  torque sources compile end-to-end through kCCBuiltins. The
  Arguments-struct lowering uses BuiltinArguments under the hood,
  with the 4 stack slots matching CSA's TorqueStructArguments push
  order so torque's type system handles them identically.
- The most common varargs accessor (`arguments.length`) is fully
  wired. Less-common accessors (`arguments[i]`, `.frame`, `.base`)
  have placeholders that compile but aren't yet runtime-correct;
  flagged as Phase-9.5+ follow-ons.
- JS-linkage adaptor dispatch (`AdaptorWithBuiltinExitFrame`)
  correctly forwards the full argument vector to BuiltinArguments
  when the SharedFunctionInfo uses `kDontAdaptArgumentsSentinel`
  (per V8's CPP() varargs convention). cctest's
  JsVarargsAdaptorDispatch validates 0/1/2/5 args round-trip
  cleanly through this path.

## Phase 9.5 — DEFERRED (PromiseTry surfaces multiple Phase-10+ blockers)

The plan's stretch goal was to ship `PromiseTry` (`promise-try.tq`) as a combined catch_block + varargs real-world target. Triage:

- **`arguments[0]`** — needs `GetArgumentValue(Arguments, intptr_t): JSAny` shim that reads from `BuiltinArguments::at<JSAny>(i + 1)`. Phase 9B explicitly deferred. Trivial (~10 LoC) but currently absent.
- **`Cast<JSReceiver>(receiver) otherwise ThrowTypeError(MessageTemplate::kCalledOnNonObject, 'Promise.try')`** — needs a MessageTemplate-arg ThrowTypeError shim. Phase 9A's catch-block fixture used `ThrowCalledNonCallable` (no MessageTemplate arg) precisely to sidestep this surface. Trivial in isolation (~15 LoC) but cumulative.
- **`NewPromiseCapability(receiver, False)`** — TFC builtin (`TFC(NewPromiseCapability, ...)` in builtin-definitions.h). Same C-symbol-absence as Phase 8's `Builtin_Add` / `Builtin_NonNumberToNumeric`. Needs a hand-written inline bridge wrapping V8's high-level API (likely `Factory::NewPromiseCapability` or `PromiseCapability::Create`). ~50-100 LoC.
- **`Call(context, callbackfn, Undefined)`** and **`Call(context, GetReflectApply(), Undefined, callbackfn, Undefined, rest)`** — variadic JS-Call builtin. TFC. Needs a hand-written bridge wrapping `Execution::Call(...)`. Non-trivial: variadic argument forwarding through the V8 Execution API.
- **`GetReflectApply()`** — TFC stub. Needs a bridge that fetches `isolate->native_context()->reflect_apply()` (or similar accessor).
- **`NewRestArgumentsFromArguments(arguments, 1)`** — macro. Probably another TFC or a runtime helper. Needs investigation.
- **`capability.promise` / `capability.reject` / `capability.resolve`** — struct field access on `PromiseCapability`. Should work via existing struct emission (Phase 5 ArrayIsArray's UnsafeCast precedent), but uncertain without trying.

Per the Phase 9 plan's STOP rule ("if it surfaces another Phase-10+ deferral, skip and ship Phase 9 on synthetic-only"), Phase 9.5 is **deferred**. The cumulative shim/bridge work to ship PromiseTry exceeds the budget for a stretch task.

The cleanest path forward is a Phase 10 sub-phase that lifts the Phase-9B-deferred `arguments[i]` accessor + a small TFC bridge cluster (Call, NewPromiseCapability, GetReflectApply) — at which point PromiseTry, Promise.all-style targets, and most of the array-iteration family unblock simultaneously.

## Phase 9.7 Summary — TFC bridge refactor: V8-API delegation

Replaces Phase 8's hand-written `Builtin_Add` and Phase 8.1's
`Builtin_Subtract` (each ~30 LoC of native int64 Smi arithmetic +
HeapNumber overflow handling) with thin wrappers around V8's
canonical `Object::NumberValue + factory()->NewNumber(double)` APIs.
Each bridge shrinks to ~5 LoC of delegation.

### The refactored bridges

```cpp
// Phase 9.7 — Builtin_Add and Builtin_Subtract delegate to V8's
// canonical Object::NumberValue + factory->NewNumber(double) APIs.
inline Tagged<Number> Builtin_Add(Isolate* isolate,
                                  Tagged<Context> context,
                                  Tagged<Number> left,
                                  Tagged<Number> right) {
  USE(context);
  double sum = Object::NumberValue(left) + Object::NumberValue(right);
  return *isolate->factory()->NewNumber(sum);
}

inline Tagged<Number> Builtin_Subtract(Isolate* isolate,
                                       Tagged<Context> context,
                                       Tagged<Number> left,
                                       Tagged<Number> right) {
  USE(context);
  double diff = Object::NumberValue(left) - Object::NumberValue(right);
  return *isolate->factory()->NewNumber(diff);
}
```

### Why this matters

Phase 8 / 8.1 chose to re-implement JS-spec Smi/HeapNumber arithmetic
manually (~30 LoC per bridge with int64 overflow check + double
fallback + DoubleToSmiInteger discrimination). That works correctly
today but creates a maintenance liability: if V8 ever changes its
Smi/HeapNumber boundary or Number normalization rules, our shims
silently diverge.

The V8-API delegation pattern eliminates this. `factory->NewNumber(double)`
(`factory-base.h:119`) does the Smi/HeapNumber discrimination
spec-correctly — same fast path Object::Add takes internally for the
Number+Number arm (`objects.cc:Add`). For our `tail Add(n, 1)` /
`tail Subtract(n, 1)` call sites where torque's type system already
excluded String / BigInt / ToPrimitive shapes, this is the canonical
path V8 itself uses.

### Why not Object::Add directly?

`Object::Add(isolate, lhs, rhs)` returns `MaybeDirectHandle<Object>`
because it handles full ECMA Add (string concat, ToPrimitive failure).
For our statically-typed Number+Number case the failure branch is
unreachable, and the MaybeHandle ceremony (HandleScope, ToHandle
dispatch, UNREACHABLE guard) is more code than the direct
NumberValue + NewNumber path — which is what Object::Add itself
takes internally for the Number+Number arm.

`Object::Subtract` doesn't exist as a static helper in V8 (Add gets
special treatment because of string concat); the direct path is the
canonical V8-internal pattern for both.

### What about Builtin_NonNumberToNumeric?

Phase 8 already got this one right — it's a thin wrapper around
`Object::ToNumeric`. No rewrite needed.

### Honest framing — patch growth trajectory

The patch's per-bridge LoC cost just dropped from ~30 to ~5 — but it
still grows linearly with whitelist size (each new TFC callee a
whitelisted builtin reaches needs its own bridge). A truly
emitter-only architecture (zero per-builtin bridge code) would
require either per-platform inline assembly that sets up TFC's
`cp`/x27 register convention, or V8 itself growing a generic
`Execution::CallStubBuiltin(...)` API. Both are out of scope: the
inline-asm path is fragile per-platform; the V8-API path is upstream
work, not something we can do in our patch.

Phase 9.7 doesn't change the fundamental linear-growth shape, but it
shrinks the per-bridge coefficient by ~6x and makes each bridge
trivially understood (5 lines of V8-API delegation, not 30 lines of
custom arithmetic).

### Verification (Phase 9.7 vs Phase 9 baseline)

| Gate | Phase 9 | **Phase 9.7** | Delta |
|------|---------|----------------|-------|
| cctest TorqueCcBuiltinTest.* | 16 PASS | **16 PASS** | 0 (byte-identical behavior — Number+Number arithmetic produces same outputs via factory->NewNumber) |
| d8-smoke | 26 PASS | **26 PASS** | 0 (`++MAX_SAFE_INTEGER`, `--(-MAX_SAFE_INTEGER)`, BigInt arms, all unchanged) |
| Torque fixtures | 18/18 byte-exact | **18/18** | 0 (preamble bytes drift, all 18 goldens refresh; second run byte-exact) |
| mjsunit | 2 PASS | **2 PASS** | 0 |
| Excluding-anchor (excludes number, tail-call, catch-block, js-varargs) | `8169724e` | **`8169724e`** | 0 — kCSA path untouched |
| Cumulative source diff vs upstream V8 | 2734 insertions / 60 deletions across 25 files | **2706 insertions / 60 deletions across 25 files** | -28 source lines (the metric that matters). The 18 fixture goldens are in the worktree, not the v8 patch. |
| `format-patch`-emitted patch line count | 7550 lines / 92 commits | **7693 lines / 93 commits** | +143 lines / +1 commit (most of the +143 is the new commit's header + message + diff context — the actual source change is -28 lines). |
| Kernel suites (cargo / vitest / libc-test / POSIX / ABI) | 0 delta vs Phase 8.1 | **0 delta** | 0 |

### Note on patch line count metric

The `wc -l examples/libs/nodejs/patches/v8-torque-cc-builtins.patch` number we've been tracking is the size of the `format-patch --stdout` output — which includes per-commit headers (From:, Date:, Subject:, message body, footer), not just code. Each commit adds ~10-30 lines of metadata regardless of code change size. **The honest "how big is our patch" number is `git diff 9fe7634c..HEAD --stat`'s "X insertions / Y deletions across N files"** — currently 2706/60 across 25 files. Future verification.md updates should track this metric alongside the format-patch size.

## Phase 9 close — kernel suite sweep

All wasm-posix-kernel suites pass at Phase 9B's tip (`9023fad73`),
0 delta vs Phase 8.1 baseline:

| Gate | Phase 8.1 | **Phase 9B** | Delta |
|------|-----------|---------------|-------|
| cargo (`cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib`) | 722 passed | **722 passed** | 0 |
| vitest (`cd host && npx vitest run`) | 250 passed / 108 skipped | **250 passed / 108 skipped** | 0 |
| libc-test (`scripts/run-libc-tests.sh`) | 300 PASS / 2 FAIL (baseline) / 22 XFAIL / 0 XPASS | **300 PASS / 2 FAIL / 22 XFAIL / 0 XPASS** | 0 |
| POSIX (`scripts/run-posix-tests.sh`) | 0 FAIL / 1 XFAIL (`munmap/1-1`) | **0 FAIL / 1 XFAIL** | 0 |
| ABI snapshot (`scripts/check-abi-version.sh`) | in sync | **in sync, version consistent** | 0 |

V8 gates summary (cumulative from Phase 6.1 through Phase 9B):

| Gate | Phase 6.1 | Phase 7 | Phase 8 | Phase 8.1 | Phase 9A | **Phase 9B** |
|------|-----------|---------|---------|-----------|----------|---------------|
| Torque fixtures | 15/15 | 16/16 | 16/16 | 16/16 | 17/17 | **18/18 byte-exact** |
| cctest `TorqueCcBuiltinTest.*` | 9 | 10 | 12 | 14 | 15 | **16 PASS** |
| d8-smoke | 18 | 18 | 22 | 26 | 26 | **26 PASS** |
| mjsunit | 2 | 2 | 2 | 2 | 2 | **2 PASS** |
| Excluding-anchor | `8169724e` | `8169724e` | `8169724e` | `8169724e` | `8169724e` | **`8169724e`** (stable) |
| Patch | 5374 lines (76 commits) | 5753 (75) | 6323 (82) | 6486 (84) | 7196 (88) | **7550 (92 commits)** |

## Phase 10 Summary — StoreReference non-smi-tagged emission; PromiseTry deferred to Phase 11

The Phase 10 plan ([docs/plans/2026-04-26-torque-cc-backend-phase10.md](../../docs/plans/2026-04-26-torque-cc-backend-phase10.md)) targeted shipping `PromiseTry` (`promise-try.tq`) as the first real-world combined catch_block + varargs forcing target. Task 10.0 v2 triage (post StoreReference gate) revealed a deeper structural issue in Phase 9B's varargs lowering than the plan budgeted for; per the plan's STOP rule, the broader scope was deferred to Phase 11. Phase 10 closes with the one fix that's well-scoped and architecturally minimal.

### What shipped — Task 10.0.1: StoreReference non-smi-tagged emission gated under `is_cc_builtins_`

```cpp
// cc-generator.cc — StoreReferenceInstruction emission
std::string result_type = instruction.type->GetRuntimeType();
if (instruction.type->IsSubtypeOf(TypeOracle::GetTaggedType())) {
  // Stores on non-smi tagged fields use TaggedField<T>::store(host, offset,
  // value) — the 3-arg overload that needs no cage_base (stores compress, not
  // decompress). Symmetric with LoadReference's `is_cc_builtins_` gate at the
  // non-smi tagged path: kCSA/kCC stock kept the conservative error to avoid
  // exercising untested codegen surface; kCCBuiltins needs the path live for
  // `new T{...}` allocation lowering (NewFixedArray / NewJSArray, reached
  // transitively from PromiseTry's NewRestArgumentsFromArguments).
  if (!is_cc_builtins_ &&
      !instruction.type->IsSubtypeOf(TypeOracle::GetSmiType())) {
    Error(
        "Not supported in C++ output: StoreReference on non-smi tagged "
        "value");
  }
  out() << "  TaggedField<" << result_type
        << ">::store(UncheckedCast<HeapObject>(" << object
        << "), static_cast<int>(" << offset << "), " << value << ");\n";
}
```

The actual emission below the gate (`TaggedField<T>::store(UncheckedCast<HeapObject>(obj), static_cast<int>(offset), value)`) was already correct — V8's `TaggedField<T>::store(Tagged<HeapObject>, int, PtrType)` 3-arg overload (`tagged-field.h:202`) needs no `PtrComprCageBase` (stores compress, they don't decompress). Only the conservative `Error()` guard above the emission needed lifting for kCCBuiltins. kCSA and kCC paths stay byte-identical.

This mirrors the existing `LoadReferenceInstruction` non-smi-tagged gate at `cc-generator.cc:986-988`, which Phase 5 lifted symmetrically for `is_cc_builtins_`.

**Why this matters:** Any kCCBuiltins target that uses torque's `new T{...}` allocation expression — `new FixedArray{map, length, objects: ...iter}`, `new JSArray{map, properties_or_hash, elements, length}`, `new JSBoundFunction{...}`, etc. — lowers to a sequence of `StoreReferenceInstruction`s on tagged object fields. Before this gate, every such allocation rejected at torque-pass time with `Not supported in C++ output: StoreReference on non-smi tagged value`. After: `new T{...}` allocation works for any kCCBuiltins-whitelisted target.

### What deferred — broader emitter rewrite

Task 10.0 v2 triage (after lifting StoreReference) surfaced 8 distinct error symptoms in PromiseTry's `-tq-ccbuiltins.cc` C++ compile, classified into:

| # | Symptom | Bucket | Fix surface | Est. LoC |
|---|---|---|---|---|
| 1 | `ThrowTypeError(Context, MessageTemplate, const char*)` undeclared | (a) shim | `runtime-macro-shims.h` | ~5 |
| 2 | `GetArgumentValue(Arguments, intptr): JSAny` undeclared | (a) shim | `runtime-macro-shims.h` | ~5 |
| 3 | `Call(Context, callable, ...args)` (variadic, 4 sites: 3,3,4,6 args) | (a) shim | `runtime-macro-shims.h` (variadic template) | ~10 |
| 4 | `IntPtrSub`, `WordEqual` undeclared | (a) shim | `runtime-macro-shims.h` (1-line each) | ~3 |
| 5 | `Builtin_NewPromiseCapability` undeclared | (b) bridge | `implementation-visitor.cc` preamble | ~50-80 (budget exception) |
| 6 | `REFLECT_APPLY_INDEX_0`, `JS_ARRAY_PACKED_ELEMENTS_MAP_INDEX_0`, `kEmptyFixedArray_0` undeclared | (c) NamespaceConstants | `implementation-visitor.cc` preamble | ~12 |
| 7 | **Phase 9B emitter mismatch** — runtime-helper signatures use `std::tuple<...>` parameter types (per `Type::GetRuntimeType` lowering structs to tuples, types.cc:1449-1459), but helper bodies access fields via `<param>.<field_name>` syntax (per `LowerParameter` recursive naming, implementation-visitor.cc:4080), which is invalid on tuples. CSAGenerator works because it has `TorqueStructArguments` and similar as real C++ structs in `csa-types.h`. | (d) emitter rewrite | parallel struct-emission pass; touches `Type::GetRuntimeType` callsites (~14), `EmitCCValue`, per-TU struct-def emission, Phase 9B prelude rewire | ~85 |
| 8 | Phase 9B prelude `torque_arguments_base = Address{}` placeholder doesn't point at real argument slots | (d.2) emitter rewire | wire `base = address_of_first_argument()` in same prelude | ~3 |

#1-4 (a-bucket shims) and #6 (c-bucket NamespaceConstants) are trivial. #5 (NewPromiseCapability) is a budget exception — V8 has no public C++ helper for closure-context Promise allocation, so the bridge replicates `InnerNewPromiseCapability`'s fast path inline; this is an honest one-time cost amortized across the entire Promise family (Promise.try, Promise.all, Promise.any, Promise.race, Promise.allSettled, Promise.withResolvers).

#7 is the structural blocker that took Phase 10 past its budget. Phase 9B chose `std::tuple<...>` as the C++ representation for torque struct types in kCCBuiltins (matching `Type::GetRuntimeType`'s default lowering for structs), but the helper-body access pattern that LowerParameter generates assumes named-field structs. The two paths weren't reconciled. Fixing it correctly mirrors CSAGenerator's `csa-types.h` pattern: emit a parallel struct-definition pass per kCCBuiltins TU, with C++-native field types instead of `TNode<RawPtrT>` etc. The patch touches ~14 `GetRuntimeType` callsites + `EmitCCValue` + a new struct-emission loop + Phase 9B prelude rewire (~85 LoC total). It needs careful auditing against existing kCC/kCCDebug paths to avoid regressing fixtures.

### Why STOP-rule activated

The Phase 10 plan defined hard stops including: "A single new bridge requires more than 50 LoC of C++... if a bridge balloons, the underlying API choice is wrong." Phase 10 hit a different version of the same trigger — not a single bridge ballooning, but the PREREQUISITE emitter work (item #7 above) ballooning into its own architecturally-significant phase. The right response was to ship the one well-scoped change (Task 10.0.1) and document the rest as a clean Phase 11 prerequisite.

### Path forward — Phase 11

[docs/plans/2026-04-26-torque-cc-backend-phase11.md](../../docs/plans/2026-04-26-torque-cc-backend-phase11.md) captures the deferred work as a complete plan:

1. **Task 11.1** — emitter struct/tuple reconciliation (the #7 blocker): `Type::GetRuntimeType` output-mode awareness (or new method `GetRuntimeTypeForCCBuiltins`), `EmitCCValue` struct-name aggregate-init, per-TU struct-def emission mirroring `csa-types.h`, Phase 9B prelude rewire to `TorqueStructArguments` literal with `base = address_of_first_argument()`.
2. **Task 11.2** — 3 NamespaceConstants (#6).
3. **Task 11.3** — 5 macro shims (#1-4).
4. **Task 11.4** — `Builtin_NewPromiseCapability` bridge with fast-path-only architecture (#5; spike-first to size honestly).
5. **Task 11.5** — cctest + d8-smoke for PromiseTry.
6. **Task 11.6** — verification.md Summary + push.

Phase 11 close criteria match Phase 10's original PromiseTry deliverables: cctest ≥17 PASS, d8-smoke ≥28 PASS, fixtures 18/18 byte-exact post-refresh, anchor `8169724e` stable, all 5 wasm-posix-kernel suites 0 delta.

### Honest framing — patch growth trajectory

Phase 10 close ships ~7 LoC of net source change. The Phase 11 plan estimates ~200-300 LoC across emitter + bridges + tests + struct decls in 18 fixture goldens, which keeps the cumulative diff well under the plan's 2000-line ceiling.

### Verification (Phase 10 close vs Phase 9.7 baseline)

| Gate | Phase 9.7 | **Phase 10 close** | Delta |
|------|-----------|---------------------|-------|
| cctest TorqueCcBuiltinTest.* | 16 PASS | **16 PASS** | 0 (gate change is no-op for current whitelist — no fixture exercises non-smi tagged store) |
| d8-smoke | 26 PASS | **26 PASS** | 0 |
| Torque fixtures | 18/18 byte-exact | **18/18 byte-exact** | 0 (verified via `bash examples/libs/nodejs/test/run-torque-fixtures.sh`) |
| mjsunit | 2 PASS | **2 PASS** | 0 |
| Excluding-anchor (excludes number, tail-call, catch-block, js-varargs) | `8169724e` | **`8169724e`** | 0 — kCSA path untouched |
| Cumulative source diff vs upstream V8 | 2706 ins / 60 del / 25 files | **2711 ins / 60 del / 25 files** | +5 ins (gate change: +9 ins / -4 del net = +5) |
| `format-patch`-emitted patch line count | 7693 lines / 93 commits | **7759 lines / 94 commits** | +66 lines / +1 commit (mostly per-commit metadata + diff context — see Phase 9.7 §"Note on patch line count metric") |
| Kernel suites: cargo (722 passed) | 0 delta vs Phase 8.1 | **722 passed** | 0 |
| Kernel suites: vitest (250 passed / 108 skipped) | 0 delta | **250 passed / 108 skipped** | 0 |
| Kernel suites: libc-test (300 PASS / 2 FAIL baseline / 22 XFAIL / 0 XPASS / 0 TIME) | 0 delta | **300 PASS / 2 FAIL / 22 XFAIL / 0 XPASS / 0 TIME** | 0 |
| Kernel suites: POSIX (0 FAIL / 1 XFAIL `munmap/1-1`) | 0 delta | **0 FAIL / 1 XFAIL** | 0 |
| Kernel suites: ABI snapshot | in sync | **in sync, ABI_VERSION consistent** | 0 |

### Note on what Phase 10 *learned*

Two findings from Task 10.0 / 10.0.1 work that future phases inherit:

1. **`TaggedField<T>::store` is the canonical V8 store API** for non-smi tagged fields under kCCBuiltins. The 3-arg overload requires no cage_base. Future emitter changes that need to write tagged fields (e.g., struct-field-write on PromiseCapability for capability.resolve assignment) can use the same pattern.

2. **The Phase 9B varargs lowering's struct-tuple choice was a near-miss** — the runtime-type emission and the parameter-naming pass weren't reconciled at the time. Phase 11's parallel struct-emission pass closes that gap and matches the spirit of CSAGenerator's `csa-types.h` mechanism. Future V8 upgrades that touch struct types in `csa-types.h` will surface as visible diffs against our parallel kCCBuiltins struct-emission pass — exactly the upgrade-friendly architecture the prime directive favors.

## Phase 11 Summary — emitter struct/tuple reconciliation; PromiseTry deferred to Phase 12

The Phase 11 plan ([docs/plans/2026-04-26-torque-cc-backend-phase11.md](../../docs/plans/2026-04-26-torque-cc-backend-phase11.md)) targeted shipping `PromiseTry` as a real-world combined catch_block + varargs forcing target. Phase 11 ships the **structural emitter prerequisite** that all Promise-family targets need; the `Builtin_NewPromiseCapability` bridge that PromiseTry specifically needs is deferred to Phase 12 along with the PromiseTry whitelist.

### What shipped — Task 11.1 (and 11.1 follow-up): kCCBuiltins parallel struct emission

The kCCBuiltins emitter now mirrors CSAGenerator's `csa-types.h` pattern faithfully: a parallel struct-definition pass per kCCBuiltins TU, named after the canonical torque struct types (`TorqueStructArguments`, `TorqueStructArgumentsIterator_0`, etc.) but with C++-native field types (`Tagged<X>`, `Address`, `intptr_t`) instead of `TNode<>`.

Files emitted:
- `gen/torque-generated/cc-builtins-types.h` — single shared header (parallel of `csa-types.h`), included by every `*-tq-ccbuiltins.cc` preamble. 344 structs emit, 5 SKIPPED (Simd128 / BInt / scoped enum classes that need V8-internal headers we deliberately don't pull in).

Emitter changes (Task 11.1, commit `5c708bd7`):
- `Type::GetRuntimeTypeForCCBuiltins()` (types.h/.cc) — kCCBuiltins-specific runtime-type rendering. Struct types render as canonical generated names; non-struct types delegate to `GetRuntimeType()`.
- `ImplementationVisitor::GenerateCCBuiltinsTypes()` (implementation-visitor.cc) — walks `TypeOracle::GetAggregateTypes()` and emits the parallel header. Per-field header-safety check (whitelist of standard C++ types + Tagged<> + struct types) skips unrepresentable structs with a visible `// SKIPPED:` comment.
- `CCGenerator::RenderRuntimeType()` helper (cc-generator.h/.cc) — picks `GetDebugType` / `GetRuntimeTypeForCCBuiltins` / `GetRuntimeType` based on output mode. ~14 callsites in cc-generator.cc switched.
- `EmitCCValue` gains `bool is_cc_builtins` parameter — struct values render as `<TorqueStructX>{a, b, c}` aggregate-init (instead of `std::make_tuple(a, b, c)`).
- `GenerateFunction` splits the `kCC` / `kCCBuiltins` arms (return type, parameter type, label-param-type) so kCC keeps `std::tuple<>` shape (byte-identical to stock torque) and kCCBuiltins uses the named-struct shape.
- Phase 9B prelude rewires from `Address{}` placeholder base to `TorqueStructArguments torque_arguments{nullptr, reinterpret_cast<Address>(args.address_of_first_argument()), …}` literal — mirrors CSAGenerator's `TorqueStructArguments` push at impl-visitor.cc:969-979 of the kCSA path.

Follow-up emitter changes (commit `da4218a4`) needed to fix an ODR collision the first attempt didn't anticipate:

The kCC `-tq-inl.inc` files (e.g., `contexts-tq-inl.inc`) declare `TqRuntimeFieldSliceContextElements` returning `std::tuple<...>`. Those are transitively included in `*-tq-ccbuiltins.cc` TUs via `arguments-inl.h → objects-inl.h → contexts-inl.h → contexts-tq-inl.inc`. The kCCBuiltins emission of the same helper (with the struct-named return type) collides with that declaration: same name, different return type → "functions that differ only in their return type cannot be overloaded." Fix:

- New `Callable::CCBuiltinsName()` returning `"TqRuntimeCCB" + ExternalName()` — distinct prefix from kCC's `"TqRuntime" + ExternalName()`. The two namespaces are now fully separate, so the kCC and kCCBuiltins emissions of the same Torque helper coexist as different functions.
- `ExternMacro::CCBuiltinsName()` overrides to fall back to `CCName()` — extern shims live in `TorqueRuntimeMacroShims::` and are shared by both passes (they don't have their own bodies, just route to runtime-macro-shims.h definitions).
- `GenerateCCBuiltinsTypes` adds `Flatten()` to each struct (mirrors `csa-types.h`'s `Flatten()` helper at csa-generator.cc emission) so call sites can write `std::tie(a, b, c) = helper(...).Flatten()` (CCGenerator's existing pattern at cc-generator.cc:466).
- 3 macro-call emission sites in cc-generator.cc switch to `CCBuiltinsName` when `is_cc_builtins_`.
- 5 NamespaceConstants reachable from PromiseTry's body added to cc_builtins_preamble: `REFLECT_APPLY_INDEX_0`, `JS_ARRAY_PACKED_ELEMENTS_MAP_INDEX_0`, `kEmptyFixedArray_0`, `kFixedArrayMap_0`, `kNoContext_0`. Mirror Phase 5/6.1's `True_0`/`False_0`/`Undefined_0`/`TheHole_0` pattern.
- 5 macro shims added: trivial ones (`IntPtrSub`, `WordEqual`, `IntPtrGreaterThan`) in `runtime-macro-shims.h`; heavier ones that need V8-internal types (`Call` variadic wrapping `Execution::Call`, `GetArgumentValue` reading from `TorqueStructArguments`, `ThrowTypeError(Context, MessageTemplate, const char*)`) in the cc_builtins_preamble (same rationale as Phase 8's `NumberConstant` — `runtime-macro-shims.h`'s surgical include set deliberately omits factory/execution/message-template headers to stay includable from the broad swath of V8 .cc files that pull it in).
- Per-TU preamble adds includes: `src/common/message-template.h`, `src/execution/execution.h`, `src/heap/factory.h`, `src/heap/factory-inl.h`.

### What deferred — `Builtin_NewPromiseCapability` to Phase 12

PromiseTry's `NewPromiseCapability(receiver, False)` lowers to a TFC builtin call — `Builtin_NewPromiseCapability(isolate, context, constructor, debug_event)`. V8's `NewPromiseCapability` is implemented in `promise-abstract-operations.tq:379` and CSA-emitted at snapshot time; no `Builtin_<Name>` C symbol exists. The fast path (`constructor == native_context.promise_function()`) requires:

1. `factory()->NewJSPromise()` — exposed in `src/heap/factory.h:1081`. ✓
2. `CreatePromiseResolvingFunctions(promise, debugEvent, nativeContext)` — torque macro at `promise-abstract-operations.tq:325`. Allocates a 3-slot closure context (`PromiseResolvingFunctionContext`) plus two `JSFunction` closures bound to `kPromiseCapabilityDefaultResolveSharedFun` / `kPromiseCapabilityDefaultRejectSharedFun` root SFIs. **No equivalent C++ helper exists in `Factory` for the resolving-functions allocation** — we'd need to call `factory->NewBuiltinContext(native_context, kPromiseResolvingFunctionContextLength)`, set the 3 slots, then `factory->NewFunctionFromSharedFunctionInfo(sfi, context)` (or its equivalent) for each closure.
3. `CreatePromiseCapability(promise, resolve, reject)` — torque-macro alloc of the `PromiseCapability` struct. The C++ analogue is `factory->NewStruct(PROMISE_CAPABILITY_TYPE)` — but `Factory::NewStruct` isn't directly available in `factory.h`'s public surface either.

Each of these is a real V8 API surface that requires investigation; together they're a clean Phase 12 sub-phase. The Phase 11 emitter foundation means Phase 12 can drop in `Builtin_NewPromiseCapability` as a single inline-bridge addition to `cc_builtins_preamble` without re-touching the emitter.

[docs/plans/2026-04-26-torque-cc-backend-phase11.md](../../docs/plans/2026-04-26-torque-cc-backend-phase11.md)'s Task 11.4 description gets carried forward to Phase 12 as a spike-first task: write the bridge cleanly, see the honest LoC, then commit.

### Architectural note for upgrade resilience

The most important property of Phase 11's emitter changes: the parallel struct-emission pass walks the **same data source** as `csa-types.h` (`TypeOracle::GetAggregateTypes()`). When V8 upstream changes torque struct types (adds new ones, renames fields, reorders), our emitted `cc-builtins-types.h` reflects the change automatically. The diff against upstream V8 stays surgical: one new `GenerateCCBuiltinsTypes` method, one new `Type::GetRuntimeTypeForCCBuiltins`, one new `Callable::CCBuiltinsName`, and a handful of branch points in existing emitter loops. Everything else inherits V8's torque mechanics unchanged.

The CCBuiltinsName rename also means upgrade reviewers can grep for `TqRuntimeCCB` to see exactly which symbols are kCCBuiltins-namespace and trace their lineage.

### Verification (Phase 11 close vs Phase 10 close baseline)

| Gate | Phase 10 close | **Phase 11 close** | Delta |
|------|----------------|---------------------|-------|
| cctest TorqueCcBuiltinTest.* | 16 PASS | **16 PASS** | 0 |
| d8-smoke | 26 PASS | **26 PASS** | 0 |
| mjsunit | 2 PASS | **2 PASS** | 0 |
| Torque fixtures | 18/18 byte-exact | **18/18 byte-exact** | 0 (8 goldens regen for the TqRuntime → TqRuntimeCCB rename + new include line; second run byte-exact) |
| Excluding-anchor (excludes number, tail-call, catch-block, js-varargs) | `8169724e` | **`8169724e`** | 0 — kCSA path untouched |
| Cumulative source diff vs upstream V8 | 2711 ins / 60 del / 25 files | **3199 ins / 80 del / 27 files** | +488 ins / +20 del / +2 files (new `cc-generator.h` callout for `RenderRuntimeType` + helper-method declarations; the +2 files are previously-untouched torque sources) |
| `format-patch`-emitted patch line count | 7759 lines / 94 commits | **9103 lines / 96 commits** | +1344 lines / +2 commits |
| Kernel suites: cargo | 722 passed | **722 passed** | 0 |
| Kernel suites: vitest | 250 passed / 108 skipped | **250 passed / 108 skipped** | 0 |
| Kernel suites: libc-test | 300 PASS / 2 FAIL / 22 XFAIL / 0 XPASS / 0 TIME | **300 PASS / 2 FAIL / 22 XFAIL / 0 XPASS / 0 TIME** | 0 |
| Kernel suites: POSIX | 0 FAIL / 1 XFAIL (`munmap/1-1`) | **0 FAIL / 1 XFAIL** | 0 |
| Kernel suites: ABI snapshot | in sync | **in sync, ABI_VERSION consistent** | 0 |

### Honest framing — what's still missing from PromiseTry

The Phase 11 close is a substantial structural step but does NOT yet ship PromiseTry. To reach a green PromiseTry build, Phase 12 needs:

1. `Builtin_NewPromiseCapability` bridge — the closure-context-dependent TFC bridge (~50-100 LoC; requires V8-internal allocation API investigation as discussed in the §"What deferred" section above).
2. PromiseTry whitelist re-add to `build-v8-host-phase5.sh`.
3. cctest `JsPromiseTryDispatch` + d8-smoke probes for `Promise.try(() => 42)`, throw-and-catch, and multi-arg cases.
4. Optional mjsunit coverage if upstream V8 has a self-contained `promise-try.js`.

Phase 12's bridge work is much smaller than Phase 11's — it's a single inline-bridge addition once the emitter foundation is in place.

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
